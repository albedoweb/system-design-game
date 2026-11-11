import {
  AUDIENCE_CASE_IDS,
  AUDIENCE_CONTENT_VERSION,
  AUDIENCE_LEVEL_ID,
  AUDIENCE_MAX_SEED,
  AUDIENCE_MODEL_VERSION,
  AUDIENCE_PRICING_VERSION,
  AUDIENCE_PROFILE_VERSION,
  AUDIENCE_SCHEMA_VERSION,
  createAudienceChallengeProfile,
  type AudienceAdvance,
  type AudienceCaseResult,
  type AudienceEvaluation,
  type AudienceIdentity,
  type AudienceIssue,
  type AudienceProgress,
  type AudienceRunOptions,
  type AudienceSession,
  type AudienceTrafficFrame,
  type AudienceProvisioned,
} from './contracts';
import { ActivityOverlay, assertWindowInvariant } from './core/activity';
import { AudienceCaseSimulation, AUDIENCE_FRAME_LIMIT } from './core/case';
import { AUDIENCE_DEFAULT_MODEL, type AudienceModel } from './core/model';
import { resolveAudienceTopology, type AudienceTopology } from './core/topology';
import {
  AudiencePrehistoryBuilder,
  buildAudienceIngestTrace,
  buildAudienceReadTrace,
  type AudienceBaseHistory,
  type AudienceIngestTrace,
  type AudienceReadTrace,
} from './core/workload';
import {
  ChallengeRunner,
  type ChallengeStepDefinition,
  type ChallengeStepEngine,
} from '../simulation/challenges';

/**
 * Deterministic, resumable Live Audience qualification session.
 *
 * All cases share one seeded preparation step (the 1.8M-row prehistory) and are
 * then run sequentially, so per-case state is released before the next case
 * starts. `advance(maxEvents)` only bounds how many callbacks or preparation
 * steps run per call; slicing differently never changes the result.
 */

interface PreparationEngineState {
  readonly builder: AudiencePrehistoryBuilder;
}

class PreparationStep implements ChallengeStepEngine {
  private readonly builder: AudiencePrehistoryBuilder;

  constructor(state: PreparationEngineState) {
    this.builder = state.builder;
  }

  get done(): boolean {
    return this.builder.done;
  }

  get phase(): 'prepare' | 'run' | 'drain' | 'done' {
    return this.builder.done ? 'done' : 'prepare';
  }

  get nowMs(): number {
    return 0;
  }

  get progress(): number {
    return this.builder.progress;
  }

  advance(maxEvents = 20_000): {
    processedEvents: number;
    exhausted: boolean;
  } {
    const budget =
      maxEvents === Number.POSITIVE_INFINITY ? 1_000_000 : Math.max(1, maxEvents);
    const done = this.builder.step(budget);
    return { processedEvents: 0, exhausted: !done };
  }
}

export class AudienceSimulation implements AudienceSession {
  readonly identity: AudienceIdentity;
  readonly totalRequests: number;

  private readonly model: AudienceModel;
  private readonly options: AudienceRunOptions;
  private readonly seed: number;
  private readonly topology: AudienceTopology | null;
  private readonly profile: ReturnType<typeof createAudienceChallengeProfile> | null;
  private readonly builder: AudiencePrehistoryBuilder | null;
  private readonly ingestTrace: AudienceIngestTrace | null;
  private readonly readTraces = new Map<string, AudienceReadTrace>();
  private base: AudienceBaseHistory | null = null;

  private readonly runner: ChallengeRunner<string, AudienceCaseResult | null> | null;
  private readonly cases: AudienceCaseResult[] = [];
  private caseIndex = 0;
  private active: AudienceCaseSimulation | null = null;
  private stepOffsetMs = 0;
  private finished = false;
  private resultValue: AudienceEvaluation | null = null;
  private readonly invalidIssues: readonly AudienceIssue[];
  private currentFrames: readonly AudienceTrafficFrame[] = [];
  private readonly maxFrames: number;
  private readonly maxIssues: number;
  private lastProgress: AudienceProgress;

  /**
   * `internalProfile` exists only for the internal engine tests: a tiny private
   * workload needs its own case traffic and fault schedule. The public entry
   * points never pass it, so `AudienceRunOptions` cannot override the dataset,
   * workload, prices or gates.
   */
  constructor(
    input: unknown,
    options: AudienceRunOptions = {},
    model: AudienceModel = AUDIENCE_DEFAULT_MODEL,
    internalProfile: ReturnType<typeof createAudienceChallengeProfile> | null = null,
  ) {
    this.model = model;
    this.options = options;
    this.seed = options.seed ?? model.level.defaultSeed;
    if (
      !Number.isInteger(this.seed) ||
      this.seed < 0 ||
      this.seed > AUDIENCE_MAX_SEED
    ) {
      throw new RangeError(`seed must be an integer 0..${AUDIENCE_MAX_SEED}`);
    }
    this.maxFrames = model.level.limits.maxFrames;
    this.maxIssues = model.level.limits.maxIssues;
    const drainMs = model.level.workload.drainMs;
    const measuredMs = model.level.workload.measuredMs;
    assertWindowInvariant(
      model.level.dataset.activityWindowMs,
      measuredMs + drainMs,
      'Live Audience workload',
    );

    const resolved = resolveAudienceTopology(input, model);
    const digest = resolved.ok ? resolved.value.digest : 'invalid';
    this.identity = {
      levelId: AUDIENCE_LEVEL_ID,
      modelVersion: AUDIENCE_MODEL_VERSION,
      schemaVersion: AUDIENCE_SCHEMA_VERSION,
      contentVersion: AUDIENCE_CONTENT_VERSION,
      pricingVersion: AUDIENCE_PRICING_VERSION,
      profileVersion: AUDIENCE_PROFILE_VERSION,
      seed: this.seed,
      graphDigest: digest,
      runId: `la1-${this.seed}-${digest}`,
    };
    this.lastProgress = {
      phase: 'validate',
      caseId: null,
      nowMs: 0,
      measuredElapsedMs: 0,
      completedRequests: 0,
      totalRequests: 0,
      message: 'Validating the Live Audience graph',
    };

    if (!resolved.ok) {
      this.invalidIssues = resolved.issues;
      this.topology = null;
      this.profile = null;
      this.builder = null;
      this.ingestTrace = null;
      this.runner = null;
      this.totalRequests = 0;
      this.finished = true;
      this.resultValue = this.buildInvalidResult();
      this.lastProgress = {
        ...this.lastProgress,
        phase: 'done',
        message: 'The graph is not a valid Live Audience design',
      };
      return;
    }

    this.topology = resolved.value;
    this.profile =
      internalProfile ?? createAudienceChallengeProfile(resolved.value.appInstances);
    this.builder = new AudiencePrehistoryBuilder(model, this.seed);
    this.ingestTrace = buildAudienceIngestTrace(model, this.seed);
    let reads = 0;
    for (const item of this.profile.cases) {
      const trace = this.readTraceFor(item.id, item.traffic.readPhases);
      reads += trace.count;
    }
    this.totalRequests = this.ingestTrace.count * this.profile.cases.length + reads;
    this.invalidIssues = [];
    this.runner = new ChallengeRunner<string, AudienceCaseResult | null>(
      {
        profileVersion: this.profile.profileVersion,
        scoreCaseId: this.profile.scoreCaseId,
        qualification: this.profile.qualification,
        requiredCaseIds: [...this.profile.requiredCaseIds],
        cases: this.profile.cases.map((item) => ({
          id: item.id,
          label: item.label,
          targetInstance: item.targetInstance,
          criticalWindow: item.criticalWindow,
        })),
      },
      {
        open: (step) => this.openStep(step),
        close: (step, engine) => this.closeStep(step, engine),
        onProgress: (step) => this.reportProgress(step),
      },
    );
    this.reportInitialProgress();
    safeCall(options.onProgress, this.lastProgress);
  }

  get done(): boolean {
    return this.finished;
  }

  private readTraceFor(
    caseId: string,
    phases: readonly { fromMs: number; toMs: number; readsPerSecond: number }[],
  ): AudienceReadTrace {
    const cached = this.readTraces.get(caseId);
    if (cached !== undefined) {
      return cached;
    }
    const trace = buildAudienceReadTrace(this.seed, phases, caseId);
    this.readTraces.set(caseId, trace);
    return trace;
  }

  private openStep(step: ChallengeStepDefinition<string>): ChallengeStepEngine {
    if (step.kind === 'preparation') {
      return new PreparationStep({ builder: this.builder! });
    }
    const caseSpec = this.profile!.cases.find((item) => item.id === step.caseId);
    if (caseSpec === undefined || this.topology === null || this.base === null) {
      throw new Error(`cannot open challenge case ${String(step.caseId)}`);
    }
    this.base ??= this.builder!.baseHistory;
    const simulation = new AudienceCaseSimulation({
      model: this.model,
      topology: this.topology,
      caseSpec,
      seed: this.seed,
      base: this.builder!.baseHistory,
      ingest: this.ingestTrace!,
      reads: this.readTraceFor(caseSpec.id, caseSpec.traffic.readPhases),
    });
    // A new case starts with no live frames. Do not bleed the previously
    // completed case's scope into the new case's first progress samples.
    this.currentFrames = [];
    this.active = simulation;
    return {
      get done() {
        return simulation.done;
      },
      get phase() {
        return simulation.phase === 'prepare' ? 'prepare' : simulation.phase;
      },
      get nowMs() {
        return simulation.nowMs;
      },
      advance: (maxEvents?: number) => simulation.advance(maxEvents),
    };
  }

  private closeStep(
    step: ChallengeStepDefinition<string>,
    engine: ChallengeStepEngine,
  ): AudienceCaseResult | null {
    this.stepOffsetMs += engine.nowMs;
    if (step.kind === 'preparation') {
      this.base = this.builder!.baseHistory;
      return null;
    }
    const simulation = this.active;
    this.active = null;
    const result = simulation?.caseResult ?? null;
    if (result !== null) {
      this.cases.push(result);
      // Only the current (or most recently completed) case's frames are kept
      // here. Every completed case keeps its own bounded set in its result.
      this.currentFrames = result.trafficFrames.slice(
        0,
        Math.min(AUDIENCE_FRAME_LIMIT, this.maxFrames),
      );
    }
    this.caseIndex += 1;
    return result;
  }

  private reportInitialProgress(): void {
    this.lastProgress = {
      phase: 'prepare',
      caseId: null,
      nowMs: 0,
      measuredElapsedMs: 0,
      completedRequests: 0,
      totalRequests: this.totalRequests,
      message: 'Seeding the frozen 15-minute prehistory',
    };
  }

  private reportProgress(step: ChallengeStepDefinition<string>): void {
    const simulation = this.active;
    // The measured clock exists from the moment the case simulation exists;
    // `caseResult` is null until the case finishes, so it must not be used as
    // the origin. The getter clips preparation to 0 and drain to the window.
    const measuredElapsedMs =
      simulation === null ? 0 : simulation.measuredElapsedMs;
    const phase: AudienceProgress['phase'] =
      step.kind === 'preparation'
        ? 'prepare'
        : simulation === null
          ? 'run'
          : simulation.phase === 'prepare'
            ? 'prepare'
            : simulation.phase === 'drain'
              ? 'drain'
              : simulation.phase === 'done'
                ? 'done'
                : 'run';
    this.lastProgress = {
      phase: this.finished ? 'done' : phase,
      caseId: step.caseId === null ? null : (step.caseId as AudienceCaseResult['id']),
      nowMs: this.stepOffsetMs + (simulation?.nowMs ?? 0),
      measuredElapsedMs,
      completedRequests:
        (simulation?.completedRequests ?? 0) +
        this.ingestTrace!.count * Math.max(0, this.caseIndex),
      totalRequests: this.totalRequests,
      message:
        step.kind === 'preparation'
          ? 'Seeding the frozen 15-minute prehistory'
          : `Running case ${step.caseId ?? ''}: ${step.label}`,
    };
    safeCall(this.options.onProgress, this.lastProgress);
  }

  progress(): AudienceProgress {
    return this.lastProgress;
  }

  advance(maxEvents = Number.POSITIVE_INFINITY): AudienceAdvance {
    if (this.finished) {
      return {
        done: true,
        progress: this.lastProgress,
        processedEvents: 0,
        exhausted: false,
      };
    }
    const abort = this.options.abort;
    if (abort?.aborted === true) {
      this.cancel();
      return {
        done: true,
        progress: this.lastProgress,
        processedEvents: 0,
        exhausted: false,
      };
    }
    const summary = this.runner!.advance(maxEvents);
    if (summary.cancelled) {
      this.finish('cancelled');
    } else if (summary.done) {
      this.finish('complete');
    }
    return {
      done: this.finished,
      progress: this.lastProgress,
      processedEvents: summary.processedEvents,
      exhausted: summary.exhausted,
    };
  }

  runToCompletion(maxEventsPerAdvance?: number): AudienceEvaluation {
    let guard = 0;
    while (!this.finished) {
      this.advance(
        maxEventsPerAdvance === undefined
          ? Number.POSITIVE_INFINITY
          : maxEventsPerAdvance,
      );
      guard += 1;
      if (guard > 1_000_000) {
        this.finish('incomplete', ['The evaluation did not converge.']);
      }
    }
    return this.result() ?? this.buildInvalidResult();
  }

  cancel(): void {
    if (this.finished) {
      return;
    }
    this.active?.cancel();
    this.runner?.cancel();
    this.finish('cancelled');
  }

  result(): AudienceEvaluation | null {
    return this.resultValue;
  }

  frames(): readonly AudienceTrafficFrame[] {
    // While a case is running, expose its bounded live frames directly. After
    // it closes, the completed case's bounded frames remain available until a
    // new case opens. Both paths are the existing bounded arrays, not clones.
    return this.active?.liveFrames ?? this.currentFrames;
  }

  private finish(
    status: 'complete' | 'cancelled' | 'incomplete',
    extraReasons: readonly string[] = [],
  ): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    const reasons = [...extraReasons];
    const required = this.profile?.requiredCaseIds ?? [];
    const byId = new Map(this.cases.map((item) => [item.id, item]));
    const missing = required.filter((id) => !byId.has(id as AudienceCaseResult['id']));
    if (status === 'complete' && missing.length > 0) {
      status = 'incomplete';
      reasons.push(
        `Required cases did not finish: ${missing.join(', ')}.`,
      );
    }
    const ordered: AudienceCaseResult[] = [];
    for (const id of required) {
      const found = byId.get(id as AudienceCaseResult['id']);
      if (found !== undefined) {
        ordered.push(found);
      }
    }
    for (const item of this.cases) {
      if (!ordered.includes(item)) {
        ordered.push(item);
      }
    }
    const cases = ordered.slice(0, this.model.level.limits.maxCases);
    const allPassed = cases.length > 0 && cases.every((item) => item.passed);
    const passed = status === 'complete' && allPassed;
    const peak = cases.find((item) => item.id === 'peak');
    const score = {
      eligible: status === 'complete' && passed,
      costUsd:
        status === 'complete' && passed
          ? (peak?.cost?.actualUsd ?? null)
          : null,
      caseId: 'peak' as const,
    };
    if (score.eligible && score.costUsd === null) {
      reasons.push('The peak case did not report a cost.');
    }
    const issues = this.buildIssues(cases);
    const finalStatus =
      status === 'complete' && reasons.length > 0 ? 'incomplete' : status;
    const eligible = finalStatus === 'complete' && passed;
    this.resultValue = {
      status: finalStatus,
      passed: eligible,
      levelId: this.identity.levelId,
      modelVersion: this.identity.modelVersion,
      schemaVersion: this.identity.schemaVersion,
      contentVersion: this.identity.contentVersion,
      pricingVersion: this.identity.pricingVersion,
      profileVersion: this.identity.profileVersion,
      seed: this.identity.seed,
      graphDigest: this.identity.graphDigest,
      runId: this.identity.runId,
      identity: this.identity,
      provisioned: this.provisioned(),
      cases,
      score: {
        eligible,
        costUsd: eligible ? (peak?.cost?.actualUsd ?? null) : null,
        caseId: 'peak',
      },
      issues: issues.slice(0, this.maxIssues),
      incompleteReasons:
        finalStatus === 'incomplete'
          ? (reasons.length > 0
              ? reasons
              : ['The run did not complete.']
            ).slice(0, 16)
          : [],
    };
    this.lastProgress = {
      ...this.lastProgress,
      phase: 'done',
      message:
        this.resultValue.status === 'complete'
          ? this.resultValue.passed
            ? 'Every required case passed'
            : 'The run completed with failed gates'
          : `The run ended as ${this.resultValue.status}`,
      completedRequests: this.totalRequests,
    };
  }

  private buildIssues(cases: readonly AudienceCaseResult[]): AudienceIssue[] {
    const issues: AudienceIssue[] = [];
    for (const item of cases) {
      if (item.status !== 'complete') {
        issues.push({
          severity: 'error',
          code: 'case-incomplete',
          message: `Case "${item.id}" finished as ${item.status}; only a complete run can pass.`,
          nodeId: undefined,
        });
        continue;
      }
      for (const gate of item.gates) {
        if (!gate.passed) {
          issues.push({
            severity: 'warning',
            code: `gate-${gate.id}`,
            message: `${item.label}: ${gate.message}`,
          });
        }
      }
    }
    return issues;
  }

  private provisioned(): AudienceProvisioned | null {
    if (this.topology === null) {
      return null;
    }
    return {
      appInstances: this.topology.appInstances,
      sqlSize: this.topology.sqlSize,
      readPlan: this.topology.readPlan,
      cacheTtlSeconds:
        this.topology.cacheTtlMs === null
          ? null
          : ((this.topology.cacheTtlMs / 1_000) as 0.5 | 2 | 5 | 15),
      workerInstances: this.topology.workerInstances,
      loadBalancer: this.topology.lbId !== null,
    };
  }

  private buildInvalidResult(): AudienceEvaluation {
    return {
      status: 'invalid',
      passed: false,
      levelId: this.identity.levelId,
      modelVersion: this.identity.modelVersion,
      schemaVersion: this.identity.schemaVersion,
      contentVersion: this.identity.contentVersion,
      pricingVersion: this.identity.pricingVersion,
      profileVersion: this.identity.profileVersion,
      seed: this.identity.seed,
      graphDigest: this.identity.graphDigest,
      runId: this.identity.runId,
      identity: this.identity,
      provisioned: null,
      cases: [],
      score: { eligible: false, costUsd: null, caseId: 'peak' },
      issues: this.invalidIssues.slice(0, this.maxIssues),
      incompleteReasons: [],
    };
  }
}

function safeCall<T>(callback: ((value: T) => void) | undefined, value: T): void {
  if (callback === undefined) {
    return;
  }
  try {
    callback(value);
  } catch {
    // Progress reporting can never change a simulation result.
  }
}

/** Synchronous public evaluation. */
export function evaluateAudience(
  input: unknown,
  options: AudienceRunOptions = {},
): AudienceEvaluation {
  const session = new AudienceSimulation(input, options);
  return session.runToCompletion();
}

/** Incremental public session used by browser workers and the CLI. */
export function createAudienceSession(
  input: unknown,
  options: AudienceRunOptions = {},
): AudienceSession {
  return new AudienceSimulation(input, options);
}

export { AUDIENCE_CASE_IDS, ActivityOverlay };
