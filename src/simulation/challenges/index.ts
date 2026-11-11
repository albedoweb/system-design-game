/**
 * Reusable challenge-profile runner.
 *
 * A level that needs "run the same frozen input under several fault cases and
 * qualify only when every required case passes" can use this module instead of
 * copying its own case loop. The helper stays deliberately small: it knows
 * about ordered cases, per-case step engines, cooperative slices, cancellation
 * and bounded progress reporting. It contains no level constants, no traffic
 * generator, no fault semantics and no scoring formula, so a level can adopt
 * it without changing an existing legacy engine.
 *
 * The engines themselves are level-owned. One "step" is either shared
 * preparation (seeded history, index build) or one concrete case. A step engine
 * exposes progress through `advance`, which must only bound how many scheduled
 * events run per call: virtual time, ordering and random draws may never
 * depend on the slice size.
 */

export type ChallengeStepKind = 'preparation' | 'case';

export interface ChallengeCasePlan<Id extends string = string> {
  readonly id: Id;
  readonly label: string;
  /** Physical instance index for a fault case, or null for a plain case. */
  readonly targetInstance: number | null;
  /** Critical offer window in milliseconds relative to the measured start. */
  readonly criticalWindow: { readonly fromMs: number; readonly toMs: number } | null;
}

export interface ChallengeProfilePlan<Id extends string = string> {
  readonly profileVersion: string;
  /** Case whose actual cost becomes the score when every case passes. */
  readonly scoreCaseId: Id;
  readonly qualification: 'all-required-cases';
  /** Ordered steps: shared preparation first, then every required case. */
  readonly cases: readonly ChallengeCasePlan<Id>[];
  readonly requiredCaseIds: readonly Id[];
}

export interface ChallengeStepDefinition<Id extends string = string> {
  readonly kind: ChallengeStepKind;
  readonly caseId: Id | null;
  readonly label: string;
}

export type ChallengeStepPhase = 'prepare' | 'run' | 'drain' | 'done';

/**
 * One engine that can be advanced in bounded slices. `advance` returns whether
 * the budget stopped the call, never whether the work is cased differently.
 */
export interface ChallengeStepEngine {
  readonly done: boolean;
  readonly phase: ChallengeStepPhase;
  /** Absolute virtual milliseconds since this step started at 0. */
  readonly nowMs: number;
  advance(maxEvents?: number): {
    readonly processedEvents: number;
    readonly exhausted: boolean;
  };
}

export interface ChallengeStepHandlers<Id extends string, Result> {
  /** Opens the engine for one step. Called exactly once per step. */
  open(step: ChallengeStepDefinition<Id>): ChallengeStepEngine;
  /**
   * Called exactly once when a step reports `done`. The runner stores nothing
   * itself; the level decides what a finished preparation or case means.
   */
  close(step: ChallengeStepDefinition<Id>, engine: ChallengeStepEngine): Result;
  /** Optional hook after every `advance` for bounded progress reporting. */
  onProgress?(
    step: ChallengeStepDefinition<Id>,
    engine: ChallengeStepEngine,
    stepIndex: number,
  ): void;
}

export interface ChallengeRunSummary<Id extends string, Result> {
  readonly steps: readonly {
    readonly step: ChallengeStepDefinition<Id>;
    readonly result: Result;
    readonly processedEvents: number;
    readonly durationMs: number;
  }[];
  readonly processedEvents: number;
  readonly cancelled: boolean;
}

const MAX_STEP_GUARD = 1_000_000;

/**
 * Sequential, cooperative driver over the ordered steps of a profile.
 *
 * - Steps always run in profile order, one at a time, so per-case state can be
 *   released before the next case starts.
 * - `advance(maxEvents)` bounds scheduler callbacks only. A caller that slices
 *   differently gets bit-identical step results.
 * - Cancellation is observed between slices and inside the engine's own
 *   `cancelled` state; a cancelled run never reports every case as passed.
 */
export class ChallengeRunner<Id extends string, Result> {
  private readonly steps: readonly ChallengeStepDefinition<Id>[];
  private stepIndex = 0;
  private engine: ChallengeStepEngine | null = null;
  private readonly summary: {
    step: ChallengeStepDefinition<Id>;
    result: Result;
    processedEvents: number;
    durationMs: number;
  }[] = [];
  private processedEvents = 0;
  private cancelledFlag = false;

  constructor(
    plan: ChallengeProfilePlan<Id>,
    private readonly handlers: ChallengeStepHandlers<Id, Result>,
  ) {
    const required = new Set(plan.requiredCaseIds);
    for (const id of plan.requiredCaseIds) {
      if (!plan.cases.some((item) => item.id === id)) {
        throw new Error(`challenge profile is missing required case "${id}"`);
      }
    }
    for (const item of plan.cases) {
      if (!required.has(item.id)) {
        throw new Error(`challenge profile contains an unrequested case "${item.id}"`);
      }
    }
    if (plan.cases.length === 0) {
      throw new Error('challenge profile needs at least one case');
    }
    this.steps = [
      { kind: 'preparation', caseId: null, label: 'Preparation' },
      ...plan.cases.map((item) => ({
        kind: 'case' as const,
        caseId: item.id,
        label: item.label,
      })),
    ];
  }

  get totalSteps(): number {
    return this.steps.length;
  }

  get currentStep(): ChallengeStepDefinition<Id> | null {
    return this.steps[this.stepIndex] ?? null;
  }

  get done(): boolean {
    return this.stepIndex >= this.steps.length;
  }

  get cancelled(): boolean {
    return this.cancelledFlag;
  }

  get processedEventCount(): number {
    return this.processedEvents;
  }

  /** Abandons the remaining steps. The open engine keeps its own state. */
  cancel(): void {
    this.cancelledFlag = true;
  }

  results(): ChallengeRunSummary<Id, Result> {
    return {
      steps: this.summary.slice(),
      processedEvents: this.processedEvents,
      cancelled: this.cancelledFlag,
    };
  }

  /**
   * Runs at most `maxEvents` engine callbacks across as many steps as fit in
   * the budget. Returns the number of callbacks performed in this call.
   */
  advance(maxEvents = Number.POSITIVE_INFINITY): {
    readonly processedEvents: number;
    readonly exhausted: boolean;
    readonly done: boolean;
    readonly cancelled: boolean;
  } {
    if (
      !Number.isInteger(maxEvents) &&
      maxEvents !== Number.POSITIVE_INFINITY
    ) {
      throw new RangeError('maxEvents must be a non-negative integer or Infinity');
    }
    if (maxEvents < 0) {
      throw new RangeError('maxEvents must be non-negative');
    }

    let budget = maxEvents;
    let processed = 0;
    let guard = 0;
    let exhausted = false;

    while (!this.done && !this.cancelledFlag) {
      guard += 1;
      if (guard > MAX_STEP_GUARD) {
        this.cancelledFlag = true;
        break;
      }
      const step = this.steps[this.stepIndex];
      if (step === undefined) {
        break;
      }
      if (this.engine === null) {
        this.engine = this.handlers.open(step);
      }
      const engine = this.engine;
      const slice = engine.advance(budget);
      processed += slice.processedEvents;
      this.processedEvents += slice.processedEvents;
      budget = Math.max(0, budget - slice.processedEvents);
      this.handlers.onProgress?.(step, engine, this.stepIndex);

      if (engine.done) {
        const result = this.handlers.close(step, engine);
        this.summary.push({
          step,
          result,
          processedEvents: slice.processedEvents,
          durationMs: engine.nowMs,
        });
        this.engine = null;
        this.stepIndex += 1;
        continue;
      }
      if (slice.exhausted || budget === 0) {
        exhausted = true;
        break;
      }
    }

    return {
      processedEvents: processed,
      exhausted,
      done: this.done,
      cancelled: this.cancelledFlag,
    };
  }

  /**
   * Runs every remaining step. `maxEventsPerAdvance` only affects how often the
   * caller can observe progress; results are identical for every slice size.
   */
  runToCompletion(maxEventsPerAdvance?: number): ChallengeRunSummary<Id, Result> {
    const budget =
      maxEventsPerAdvance === undefined
        ? Number.POSITIVE_INFINITY
        : maxEventsPerAdvance;
    let guard = 0;
    while (!this.done && !this.cancelledFlag) {
      this.advance(budget);
      guard += 1;
      if (guard > MAX_STEP_GUARD) {
        this.cancelledFlag = true;
      }
    }
    return this.results();
  }
}

/** Ordered step list for a profile; shared preparation always comes first. */
export function challengeSteps<Id extends string>(
  plan: ChallengeProfilePlan<Id>,
): readonly ChallengeStepDefinition<Id>[] {
  return [
    { kind: 'preparation', caseId: null, label: 'Preparation' },
    ...plan.cases.map((item) => ({
      kind: 'case' as const,
      caseId: item.id,
      label: item.label,
    })),
  ];
}

/**
 * True when every required case is present exactly once and passed. Extra
 * cases are ignored; a missing required case is a failure, never a skip.
 */
export function challengeQualifies<Id extends string>(
  plan: ChallengeProfilePlan<Id>,
  results: ReadonlyMap<Id, { readonly passed: boolean }>,
): boolean {
  return plan.requiredCaseIds.every((id) => results.get(id)?.passed === true);
}
