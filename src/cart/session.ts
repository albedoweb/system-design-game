/**
 * Cart evaluation session (cart-protocol-v1 B1, GC-011).
 *
 * The session is the only public driver of the deterministic model. It runs
 * every required case in frozen order; no option can skip a case, and `cancel`
 * produces an incomplete evaluation with no score. `advance` slices work into
 * at most 5000 events per call.
 */
import {
  CART_LEVEL_ID,
  CART_MAX_ADVANCE_EVENTS,
  CART_VERSIONS,
  cartContentVersionForProfile,
  canonicalJson,
  sha256Hex,
  type CartAdvanceResult,
  type CartCaseId,
  type CartCaseResult,
  type CartEvaluation,
  type CartGraph,
  type CartIssue,
  type CartProgress,
  type CartSession,
} from './contracts';
import { observeCartRun, CART_PROBLEM_OUTCOMES } from './core/observations';
import { cartGraphDigest, parseCartGraph, validateCartGraph } from './graph';
import { CART_PROBE_EXPECTED_COUNTS, buildCartProbes } from './core/challenges';
import { createCartCaseRun } from './core/case';
import { analyzeCartTopology, type CartTopologyFacts } from './core/model';
import {
  CART_CASE_OFFERED_COUNTS,
  CART_DEFAULT_WORKLOAD_PROFILE,
  type CartWorkloadProfile,
} from './core/workload';
import {
  createCartTelemetryObservation,
  type CartTelemetryObservation,
  type CartTelemetryObserver,
} from './core/telemetry';

export interface CartEvaluatorOptions {
  readonly seed?: number;
  /**
   * Explicit immutable workload profile. Omitted = the adopted default
   * (`global-cart-v1-desync100`, 101 s window). The effective profile id is
   * reported in `evaluation.versions.profile`.
   */
  readonly workloadProfile?: CartWorkloadProfile;
  readonly onProgress?: (progress: CartProgress) => void;
  /** Testing hook: shortens the measured window (never skips a case). */
  readonly measuredUs?: number;
  readonly drainUs?: number;
  readonly runtimeBudgetMs?: number;
  readonly now?: () => number;
  /**
   * Optional live traffic telemetry. Observation is additive and detached: it
   * never steps the model, changes the event budget, or alters results,
   * counters, costs or qualification. `onFrame` receives bounded windows as the
   * session's own slices execute; `onCaseTelemetry` receives one bounded
   * per-case payload (frames, totals, trace) at completion or cancellation.
   */
  readonly telemetry?: CartTelemetryObserver;
}

interface PendingCase {
  readonly caseId: CartCaseId;
  readonly scheduled: number;
  readonly workloadScheduled: number;
  readonly probes: number;
  entry: ReturnType<typeof createCartCaseRun> | null;
  observation: CartTelemetryObservation | null;
  telemetryFlushed: boolean;
}

function emptyCaseResult(caseId: CartCaseId, scheduled: number, issued: number): CartCaseResult {
  return {
    id: caseId,
    scheduled,
    issued,
    dependencyFailed: 0,
    outcomes: { 'not-executed': scheduled },
    gates: [],
    resources: { events: 0, requests: 0, chargedBusyMs: 0, wanBillableBytes: 0 },
    cost: {
      rentalPerHour: 0,
      wanCredits: 0,
      preparationSeconds: 0,
      drainSeconds: 0,
      windowSeconds: 0,
      peakScoreCreditsPerHour: -1,
    },
    complete: false,
  };
}

class CartEvaluationSession implements CartSession {
  private readonly seed: number;
  private readonly profile: CartWorkloadProfile;
  private readonly options: CartEvaluatorOptions;
  private readonly graph: CartGraph;
  private readonly facts: CartTopologyFacts;
  private readonly issues: CartIssue[];
  private readonly pending: PendingCase[];
  private readonly results: CartCaseResult[] = [];
  private index = 0;
  private events = 0;
  private elapsedUs = 0;
  private cancelled = false;
  private finished = false;
  private advancing = false;
  private evaluation: CartEvaluation | null = null;

  constructor(graph: CartGraph, issues: CartIssue[], options: CartEvaluatorOptions) {
    this.graph = graph;
    this.issues = issues;
    this.options = options;
    this.seed = options.seed ?? 1729;
    this.profile = options.workloadProfile ?? CART_DEFAULT_WORKLOAD_PROFILE;
    this.facts = analyzeCartTopology(graph);
    const probes = this.profile.faultFree ? [] : buildCartProbes().probes;
    this.pending = this.profile.cases.map((caseId) => {
      const workloadScheduled = CART_CASE_OFFERED_COUNTS[caseId];
      const probesForCase = probes.filter((probe) => probe.caseId === caseId).length;
      return {
        caseId,
        scheduled:
          workloadScheduled +
          (this.profile.faultFree ? 0 : Math.max(probesForCase, CART_PROBE_EXPECTED_COUNTS[caseId])),
        workloadScheduled,
        probes: probesForCase,
        entry: null,
        observation: null,
        telemetryFlushed: false,
      };
    });
    // Frozen denominators come from the workload profile itself; a mismatch is
    // detected inside createCartCaseRun (which validates the built case).
  }

  private progress(message?: string): CartProgress {
    const current = this.pending[this.index];
    const problemOutcomes = CART_PROBLEM_OUTCOMES;
    const requestProblems = this.results.reduce((sum, result) => sum + problemOutcomes.reduce((n, outcome) => n + (result.outcomes[outcome] ?? 0), 0), 0)
      + (current?.entry?.model.requestRecords.filter((record) => record.operation !== 'audit' && problemOutcomes.includes(record.outcome)).length ?? 0);
    return {
      requestProblems,
      caseId: this.finished || this.cancelled ? null : (current?.caseId ?? null),
      ...(current && this.profile.faultFree && !this.finished && !this.cancelled ? {
        caseEvents: current.entry?.model.events ?? 0,
        caseEventsTotal: current.workloadScheduled,
      } : {}),
      casesCompleted: this.results.length,
      events: this.events,
      elapsedUs: this.elapsedUs,
      ...(message === undefined ? {} : { message }),
    };
  }

  advance(maxEvents: number): CartAdvanceResult {
    if (!Number.isFinite(maxEvents) || maxEvents < 1) {
      throw new RangeError('advance requires a positive event budget');
    }
    const budget = Math.min(Math.floor(maxEvents), CART_MAX_ADVANCE_EVENTS);
    if (this.finished || this.cancelled) {
      return { done: true, progress: this.progress() };
    }
    if (this.advancing) {
      throw new RangeError('advance is not reentrant');
    }
    this.advancing = true;
    try {
      let remaining = budget;
      while (remaining > 0 && this.index < this.pending.length) {
        const current = this.pending[this.index];
        if (current === undefined) break;
        if (current.entry === null) {
          current.entry = createCartCaseRun({
            graph: this.graph,
            caseId: current.caseId,
            seed: this.seed,
            facts: this.facts,
            workloadProfile: this.profile,
            measuredUs: this.options.measuredUs,
            drainUs: this.options.drainUs,
            runtimeBudgetMs: this.options.runtimeBudgetMs,
            now: this.options.now,
          });
          current.observation =
            this.options.telemetry === undefined
              ? null
              : createCartTelemetryObservation({
                  caseId: current.caseId,
                  model: current.entry.model,
                  ...this.options.telemetry,
                });
          // Project any traffic produced before the first slice (none today,
          // but the observation must never assume a specific start order).
          current.observation?.collect();
        }
        const before = current.entry.model.events;
        const done = current.entry.model.step(remaining);
        // Observation only projects facts of the slice that already ran; it
        // never steps the model itself, so the event budget is unchanged.
        current.observation?.collect();
        const consumed = Math.max(0, current.entry.model.events - before);
        remaining -= Math.max(consumed, 1);
        this.events += Math.max(consumed, 1);
        if (!done) {
          const progress = this.progress(`Running ${current.caseId}`);
          this.options.onProgress?.(progress);
          return { done: false, progress };
        }
        const run = current.entry.complete();
        this.flushCaseTelemetry(current, run.result);
        this.results.push(run.result);
        this.elapsedUs += Math.floor(run.model.measuredEndUs);
        this.index += 1;
        this.options.onProgress?.(this.progress(`Completed ${current.caseId}`));
      }
      if (this.index >= this.pending.length) {
        this.finished = true;
        this.evaluation = this.buildEvaluation();
      }
      return { done: this.finished, progress: this.progress() };
    } finally {
      this.advancing = false;
    }
  }

  /**
   * Emits one detached bounded payload per case, exactly once. Live frames for
   * the remaining windows are flushed by the observation before the payload.
   */
  private flushCaseTelemetry(pending: PendingCase, result?: CartCaseResult): void {
    if (pending.telemetryFlushed) return;
    pending.telemetryFlushed = true;
    const observation = pending.observation;
    if (observation === null) return;
    const snapshot = observation.finish(result);
    this.options.telemetry?.onCaseTelemetry?.(snapshot);
  }

  cancel(): void {
    if (this.finished || this.cancelled) return;
    this.cancelled = true;
    // Final flush for the case that was mid-execution: bounded frames plus one
    // payload with `complete: false`. Completed cases already flushed. Later
    // `advance` calls return immediately and emit nothing further.
    const current = this.pending[this.index];
    if (current !== undefined && current.entry !== null) this.flushCaseTelemetry(current);
    this.evaluation = this.buildEvaluation();
  }

  result(): CartEvaluation | null {
    return this.evaluation;
  }

  private buildEvaluation(): CartEvaluation {
    const cases: CartCaseResult[] = [];
    for (let position = 0; position < this.pending.length; position += 1) {
      const entry = this.pending[position];
      if (entry === undefined) continue;
      const produced = this.results[position];
      if (produced !== undefined) {
        cases.push(produced);
      } else {
        const model = entry.entry?.model;
        const partial = emptyCaseResult(entry.caseId, entry.scheduled, model?.issuedCount ?? 0);
        if (model) {
          partial.observation = observeCartRun(model, this.graph);
          const outcomes: Record<string, number> = { 'not-executed': Math.max(0, entry.scheduled - model.events), pending: Math.max(0, model.events - model.issuedCount) };
          for (const record of model.requestRecords) {
            if (record.operation !== 'audit') outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1;
          }
          partial.outcomes = outcomes;
          partial.dependencyFailed = outcomes['dependency-failed'] ?? 0;
          partial.resources = { events: model.events, requests: model.issuedCount, chargedBusyMs: model.chargedBusyUs / 1_000, wanBillableBytes: model.wanBillableBytes };
        }
        cases.push(partial);
      }
    }
    const allComplete = cases.every((caseResult) => caseResult.complete) && cases.length === this.profile.cases.length;
    const complete = allComplete && !this.cancelled;
    const gateFailures = cases.flatMap((caseResult) =>
      caseResult.gates.filter((gate) => !gate.pass).map((gate) => `${caseResult.id}:${gate.code}`),
    );
    // Every validation issue the graph validator emits is blocking (structural or
    // missing-qualification; there are no advisories), so any issue disqualifies.
    const qualified =
      complete && this.facts.qualified && this.issues.length === 0 && gateFailures.length === 0;
    const peak = cases.find((caseResult) => caseResult.id === 'peak');
    const peakScore = peak?.cost.peakScoreCreditsPerHour;
    const scoreCreditsPerHour =
      qualified && typeof peakScore === 'number' && peakScore >= 0 ? peakScore : null;
    const traceHash = sha256Hex(
      canonicalJson({
        levelId: CART_LEVEL_ID,
        profile: this.profile.id,
        graphDigest: cartGraphDigest(this.graph),
        seed: this.seed,
        cases: cases.map((caseResult) => ({
          id: caseResult.id,
          scheduled: caseResult.scheduled,
          issued: caseResult.issued,
          outcomes: caseResult.outcomes,
          complete: caseResult.complete,
        })),
      }),
    );
    return {
      levelId: CART_LEVEL_ID,
      versions: { ...CART_VERSIONS, content: cartContentVersionForProfile(this.profile.id), profile: this.profile.id },
      graphDigest: cartGraphDigest(this.graph),
      seed: this.seed,
      requiredCases: [...this.profile.cases],
      cases,
      complete,
      qualified,
      scoreCreditsPerHour,
      issues: [...this.issues],
      traceHash,
    };
  }
}

/** Parses and validates the submitted graph before any case runs. */
function prepare(input: unknown, options: CartEvaluatorOptions): { graph: CartGraph; issues: CartIssue[] } | { error: CartIssue[] } {
  const profile = options.workloadProfile ?? CART_DEFAULT_WORKLOAD_PROFILE;
  const parsed = parseCartGraph(input, cartContentVersionForProfile(profile.id));
  if (!parsed.ok) return { error: parsed.issues };
  const issues = validateCartGraph(parsed.graph);
  return { graph: parsed.graph, issues };
}

export function createCartSession(input: unknown, options: CartEvaluatorOptions = {}): CartSession {
  const prepared = prepare(input, options);
  if ('error' in prepared) {
    // A structurally invalid graph cannot execute; every case reports its
    // offered denominator as not-executed and the evaluation is incomplete.
    return new InvalidGraphSession(prepared.error, options);
  }
  return new CartEvaluationSession(prepared.graph, prepared.issues, options);
}

class InvalidGraphSession implements CartSession {
  private readonly issues: CartIssue[];
  private readonly options: CartEvaluatorOptions;
  private evaluation: CartEvaluation | null = null;

  constructor(issues: CartIssue[], options: CartEvaluatorOptions) {
    this.issues = issues;
    this.options = options;
  }

  advance(): CartAdvanceResult {
    const profile = this.options.workloadProfile ?? CART_DEFAULT_WORKLOAD_PROFILE;
    this.evaluation ??= {
      levelId: CART_LEVEL_ID,
      versions: { ...CART_VERSIONS, content: cartContentVersionForProfile(profile.id), profile: profile.id },
      graphDigest: '0'.repeat(64),
      seed: this.options.seed ?? 1729,
      requiredCases: [...profile.cases],
      cases: profile.cases.map((caseId) =>
        emptyCaseResult(caseId, CART_CASE_OFFERED_COUNTS[caseId], 0),
      ),
      complete: false,
      qualified: false,
      scoreCreditsPerHour: null,
      issues: [...this.issues],
      traceHash: '0'.repeat(64),
    };
    return {
      done: true,
      progress: { caseId: null, casesCompleted: 0, events: 0, elapsedUs: 0 },
    };
  }

  cancel(): void {
    this.advance();
  }

  result(): CartEvaluation | null {
    return this.evaluation;
  }
}

/** Runs the full evaluation synchronously; the UI/CLI uses this entry point. */
export function evaluateCart(input: unknown, options: CartEvaluatorOptions = {}): CartEvaluation {
  const session = createCartSession(input, options);
  let guard = 0;
  for (;;) {
    const step = session.advance(CART_MAX_ADVANCE_EVENTS);
    guard += 1;
    if (step.done) break;
    if (guard > 100_000) {
      session.cancel();
      break;
    }
  }
  const result = session.result();
  if (result === null) throw new Error('evaluation session produced no result');
  return result;
}
