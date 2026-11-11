import {
  ResourceKernel,
  type ResourceKernelStats,
  type ResourceRequirement,
  type SubmitTaskRequest,
  type TaskHandle,
  type TaskResult,
} from '../simulation/resources/kernel';
import { MemoryLedger } from '../simulation/resources/memory';
import { NodeQueueDepthMeter } from '../simulation/resources/queue-metrics';
import { accountTransferBytes } from '../simulation/resources/network';
import { EventScheduler, type ScheduledHandle } from '../simulation/resources/scheduler';
import { cloneScoreboardCatalog } from './catalog';
import {
  SCOREBOARD_LEVEL,
  isScoreboardSeed,
} from './level';
import {
  SCOREBOARD_LEVEL_ID,
  SCOREBOARD_MAX_SEED,
  SCOREBOARD_SCHEMA_VERSION,
  type ScoreboardAdvance,
  type ScoreboardCatalog,
  type ScoreboardCost,
  type ScoreboardCostLine,
  type ScoreboardCorrectness,
  type ScoreboardEvaluation,
  type ScoreboardFreshness,
  type ScoreboardGate,
  type ScoreboardGraph,
  type ScoreboardIdentity,
  type ScoreboardIssue,
  type ScoreboardLatency,
  type ScoreboardLevel,
  type ScoreboardLinkMetrics,
  type ScoreboardNodeMetrics,
  type ScoreboardOperationMetrics,
  type ScoreboardPreparation,
  type ScoreboardProgress,
  type ScoreboardRunOptions,
  type ScoreboardSeriesPoint,
  type ScoreboardSession,
  type ScoreboardSqlReadPlan,
  type ScoreboardTrafficFrame,
} from './contracts';
import {
  parseAndValidateScoreboardGraph,
  scoreboardGraphDigest,
  validateScoreboardGraph,
} from './graph';
import { generateScoreboardTrace, type ScoreboardTrace } from './workload';
import {
  applyVoteChange,
  countsEqual,
  createVoteState,
  freshnessForSnapshot,
  leaderboard,
  recomputeHistogram,
  reconstructCountsAtVersion,
  snapshotCounts,
  totalVotes,
  type LeaderboardEntry,
  type VoteState,
} from './votes';

/**
 * Live Scoreboard evaluator.
 *
 * All scheduling, queueing, deadlines and CPU/network accounting run through
 * the shared resource kernel. The data layer is exact: a read captures one
 * committed version; the aggregate projection and raw vote rows are updated
 * in one synchronous commit. Reference reconstruction is used only for checks
 * and never reduces simulated work.
 */

export const SCOREBOARD_SQL_DISK_LANES = 4;
const BYTES_PER_GB = 1_000_000_000;
const NETWORK_LANE_BITS_PER_MS = 1_000_000;
const EPSILON = 1e-9;
const UTILIZATION_TOLERANCE = 1e-9;

type RequestOutcome = 'success' | 'timeout' | 'rejected' | 'error';

interface WaitAccumulator {
  totalMs: number;
  maxMs: number;
  samples: number;
}

interface NodeRuntime {
  readonly id: string;
  readonly kind: 'users' | 'app' | 'sql' | 'cache';
  readonly label: string;
  readonly instances: number;
  readonly kernel: ResourceKernel | null;
  readonly cpuResourceId: string | null;
  readonly diskResourceId: string | null;
  readonly nicResourceId: string | null;
  readonly cpuCapacityCores: number;
  readonly nicCapacityLanes: number;
  readonly memoryCapacityBytes: number;
  readonly memory: MemoryLedger | null;
  readonly queue: NodeQueueDepthMeter;
  readonly wait: WaitAccumulator;
  readonly workingSetBytes: number;
  readonly queueLimit: number;
  active: number;
  activePeak: number;
  stageStarts: number;
  netBytesOffered: number;
  netBytesDelivered: number;
  tasksSubmitted: number;
  tasksCompleted: number;
  tasksRejected: number;
  tasksTimedOut: number;
  tasksInterrupted: number;
  memorySampleMs: number;
  memorySampleBytesMs: number;
  peakGbps: number;
  measuredCpuBusyUnits: number;
  measuredCpuPeak: number;
  measuredMemoryPeak: number;
  measuredNetBytesOffered: number;
  measuredNetBytesDelivered: number;
  lastCpuBusyCoreMs: number;
  lastNetOfferedBytes: number;
  lastStageStarts: number;
  lastWaitingMs: number;
}

interface EdgeRuntime {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly role: 'traffic' | 'primary' | 'reads' | 'fill';
  requests: { read: number; write: number; fill: number };
  requestsTotal: number;
  bytesOffered: number;
  bytesDelivered: number;
  lastRequests: number;
  lastBytes: number;
  peakRequestsPerSecond: number;
  peakBytesPerSecond: number;
}

interface CacheEntryRuntime {
  readonly snapshotVersion: number;
  readonly snapshotCommitMs: number;
  readonly counts: Uint32Array;
  readonly leaderboard: LeaderboardEntry[];
  readonly storedAtMs: number;
  readonly expiresAtMs: number;
}

interface FillRuntime {
  readonly lead: RequestRuntime;
  readonly waiters: RequestRuntime[];
  readonly startedAtMs: number;
}

interface RequestRuntime {
  readonly id: number;
  readonly operation: 'read' | 'write';
  /** Offered time relative to measured start. */
  readonly offeredAtMs: number;
  readonly admittedAtMs: number;
  readonly participant: number;
  readonly candidate: number;
  settled: boolean;
  outcome: RequestOutcome | null;
  failureReason: string | null;
  settledAtMs: number | null;
  snapshotVersion: number;
  snapshotCommitMs: number;
  snapshotCounts: Uint32Array | null;
  snapshotLeaderboard: LeaderboardEntry[] | null;
  committed: boolean;
  acknowledged: boolean;
  commitVersion: number | null;
  countedCommittedUnacked: boolean;
  usedCache: boolean;
  waitingFill: boolean;
  fill: FillRuntime | null;
  deadlineHandle: ScheduledHandle | null;
  stage: TaskHandle | null;
  timer: ScheduledHandle | null;
  meterNode: NodeRuntime | null;
  meterOpen: boolean;
  meterBeganAtMs: number;
  ledgerNode: NodeRuntime | null;
  ledgerId: string | null;
  activeNode: NodeRuntime | null;
  clientBytesOffered: number;
  clientBytesDelivered: number;
  lastNodeId: string | null;
  edgesUsed: Set<string>;
}

interface BucketTraffic {
  offered: number;
  succeeded: number;
  failed: number;
}

interface StageOptions {
  readonly node: NodeRuntime;
  readonly key: string;
  readonly durationMs: number;
  readonly resources: readonly ResourceRequirement[];
  readonly ledgerBytes?: number;
  readonly onStart?: (startedAtMs: number) => void;
  readonly onComplete: () => void;
  readonly onFailed?: (result: TaskResult) => void;
}

interface RunConfig {
  readonly appInstances: number;
  readonly sqlSize: 'small' | 'medium' | 'large';
  readonly readPlan: ScoreboardSqlReadPlan;
  readonly cacheTtlSeconds: number | null;
  readonly appCpuCores: number;
  readonly appNicLanes: number;
  readonly appMemoryBytes: number;
  readonly sqlCores: number;
  readonly sqlNicLanes: number;
  readonly sqlMemoryBytes: number;
  readonly sqlHourlyUsd: number;
  readonly cacheCpuCores: number;
  readonly cacheNicLanes: number;
  readonly cacheMemoryBytes: number;
  readonly cacheHourlyUsd: number;
  readonly appHourlyUsd: number;
  readonly prepMs: number;
  readonly prepWorkCoreMs: number;
}

function emptyLatency(): ScoreboardLatency {
  return {
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
    maxMs: null,
    samples: 0,
    insufficientSamples: true,
  };
}

/**
 * Project a computed utilization onto [0, 1] only when floating-point accrual
 * lands within a tiny tolerance of a bound. A material overrun (or a material
 * negative value) is returned unchanged, so the public schema still rejects a
 * real accounting defect instead of hiding it behind a cosmetic clamp.
 */
function boundedUtilization(value: number): number {
  if (value < 0 && value >= -UTILIZATION_TOLERANCE) {
    return 0;
  }
  if (value > 1 && value <= 1 + UTILIZATION_TOLERANCE) {
    return 1;
  }
  return value;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? null;
}

function latencyMetrics(
  values: readonly number[],
  minimumSamples: number,
): ScoreboardLatency {
  if (values.length === 0) {
    return emptyLatency();
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1] ?? null,
    samples: sorted.length,
    insufficientSamples: sorted.length < minimumSamples,
  };
}

function safeCall<T>(callback: ((value: T) => void) | undefined, value: T): void {
  if (callback === undefined) {
    return;
  }
  try {
    callback(value);
  } catch {
    // Observation only; never change the simulation.
  }
}

function seedOrDefault(seed: number | undefined): number {
  if (seed === undefined) {
    return SCOREBOARD_LEVEL.defaultSeed;
  }
  if (!isScoreboardSeed(seed)) {
    throw new RangeError(
      `seed must be an integer between 0 and ${SCOREBOARD_MAX_SEED}`,
    );
  }
  return seed;
}

function resolveConfig(graph: ScoreboardGraph, catalog: ScoreboardCatalog): RunConfig {
  const app = graph.nodes.find((node) => node.kind === 'app');
  const sql = graph.nodes.find((node) => node.kind === 'sql');
  const cache = graph.nodes.find((node) => node.kind === 'cache');
  if (app === undefined || sql === undefined) {
    throw new Error('validated graph is missing a required service');
  }
  const appSpec = catalog.components.app;
  const sqlSpec = catalog.components.sql.sizes[sql.config.size];
  const cacheSpec = catalog.components.cache;
  const prepWorkCoreMs =
    sql.config.readPlan === 'aggregate'
      ? SCOREBOARD_LEVEL.dataset.participants *
          catalog.work.rawScanCoreMsPerRow +
        catalog.work.aggregateBuildExtraCoreMs
      : 0;
  return {
    appInstances: app.config.instances,
    sqlSize: sql.config.size,
    readPlan: sql.config.readPlan,
    cacheTtlSeconds: cache?.config.ttlSeconds ?? null,
    appCpuCores: app.config.instances * appSpec.cpuCoresPerInstance,
    appNicLanes:
      app.config.instances * appSpec.nicGbitPerSecPerInstance,
    appMemoryBytes: app.config.instances * appSpec.memoryGbPerInstance * BYTES_PER_GB,
    sqlCores: sqlSpec.cores,
    sqlNicLanes: sqlSpec.nicGbitPerSec,
    sqlMemoryBytes: sqlSpec.memoryGb * BYTES_PER_GB,
    sqlHourlyUsd: sqlSpec.hourlyUsd,
    cacheCpuCores: cacheSpec.cpuCores,
    cacheNicLanes: cacheSpec.nicGbitPerSec,
    cacheMemoryBytes: cacheSpec.memoryGb * BYTES_PER_GB,
    cacheHourlyUsd: cache ? cacheSpec.hourlyUsd : 0,
    appHourlyUsd: app.config.instances * appSpec.hourlyUsdPerInstance,
    prepMs: prepWorkCoreMs,
    prepWorkCoreMs,
  };
}

export class ScoreboardSimulation implements ScoreboardSession {
  readonly identity: ScoreboardIdentity;
  readonly totalRequests: number;
  private finished = false;

  get done(): boolean {
    return this.finished;
  }

  private readonly graph: ScoreboardGraph | null;
  private readonly level: ScoreboardLevel;
  private readonly catalog: ScoreboardCatalog;
  private readonly seed: number;
  private readonly config: RunConfig | null;
  private readonly scheduler = new EventScheduler();
  private readonly trace: ScoreboardTrace | null;
  private readonly state: VoteState | null;
  private readonly nodes: NodeRuntime[] = [];
  private readonly edges: EdgeRuntime[] = [];
  private readonly edgeById = new Map<string, EdgeRuntime>();
  private usersNode: NodeRuntime | null = null;
  private appNode: NodeRuntime | null = null;
  private sqlNode: NodeRuntime | null = null;
  private cacheNode: NodeRuntime | null = null;
  private usersAppEdge: EdgeRuntime | null = null;
  private appSqlEdge: EdgeRuntime | null = null;
  private appCacheEdge: EdgeRuntime | null = null;
  private cacheSqlEdge: EdgeRuntime | null = null;

  private readonly measuredStartMs: number;
  private readonly measuredEndMs: number;
  private readonly peakStartMs: number;
  private readonly peakEndMs: number;
  private readonly drainEndMs: number;
  private readonly preparation: ScoreboardPreparation;

  private readonly allRequests: RequestRuntime[] = [];
  private readonly liveRequests = new Set<RequestRuntime>();
  private readonly tickHandles: ScheduledHandle[] = [];
  private prepHandle: TaskHandle | null = null;

  private cacheEntry: CacheEntryRuntime | null = null;
  private cacheEntryLedgerId: string | null = null;
  private cacheEntryExpiry: ScheduledHandle | null = null;
  private fill: FillRuntime | null = null;
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheCoalesced = 0;

  private status: ScoreboardEvaluation['status'] = 'complete';
  private phase: ScoreboardProgress['phase'];
  private processedEvents = 0;
  private limitReached = false;
  private cancelled = false;
  private incompletes: string[] = [];
  private resultValue: ScoreboardEvaluation | null = null;
  private lastSettledAtMs = 0;

  private series: ScoreboardSeriesPoint[] = [];
  private trafficFrames: ScoreboardTrafficFrame[] = [];
  private lastSeriesMs: number;
  private bucketOffers = new Map<number, { read: number; write: number }>();
  private bucketOutcomes = new Map<
    number,
    { read: BucketTraffic; write: BucketTraffic }
  >();
  private bucketLatency = new Map<number, { read: number[]; write: number[] }>();

  private billedBytes = 0;
  private writesCommitted = 0;
  private writesAcknowledged = 0;
  private committedUnacknowledged = 0;
  private noOpWrites = 0;
  private doubleEffects = 0;
  private appliedRequestIds = new Set<number>();
  private ackedCommitVersions = new Set<number>();
  private aggregateMismatches = 0;
  private snapshotMismatches = 0;
  private checkedSnapshots = 0;
  private invalidVotes = 0;
  private staleReads = 0;
  private maxLagMs = 0;
  private lagSamples: number[] = [];
  private successfulReads = 0;
  private successfulWrites = 0;
  private freshnessLimitMs: number;
  private minimumLatencySamples: number;
  private maxFrames: number;
  private maxIssues: number;

  constructor(
    input: unknown,
    options: ScoreboardRunOptions = {},
    libraryLevel: ScoreboardLevel = SCOREBOARD_LEVEL,
  ) {
    this.options = options;
    this.level = libraryLevel;
    this.catalog = cloneScoreboardCatalog();
    this.seed = seedOrDefault(options.seed);
    this.freshnessLimitMs = libraryLevel.slo.freshnessMs;
    this.minimumLatencySamples = libraryLevel.slo.minimumLatencySamples;
    this.maxFrames = libraryLevel.limits.maxFrames;
    this.maxIssues = libraryLevel.limits.maxIssues;
    this.lastSeriesMs = 0;

    const parsed = parseAndValidateScoreboardGraph(input);
    if (!parsed.ok) {
      this.graph = null;
      this.config = null;
      this.trace = null;
      this.state = null;
      this.measuredStartMs = 0;
      this.measuredEndMs = 0;
      this.peakStartMs = 0;
      this.peakEndMs = 0;
      this.drainEndMs = 0;
      this.totalRequests = 0;
      this.phase = 'done';
      this.preparation = {
        plan: 'scan',
        workCoreMs: 0,
        durationMs: 0,
        startMs: 0,
        endMs: 0,
        cacheColdAtTrafficStart: true,
        notes: 'Validation failed before any preparation.',
      };
      const digest = 'invalid';
      this.identity = {
        levelId: SCOREBOARD_LEVEL_ID,
        modelVersion: this.level.modelVersion,
        schemaVersion: SCOREBOARD_SCHEMA_VERSION,
        contentVersion: this.level.contentVersion,
        pricingVersion: this.level.pricingVersion,
        seed: this.seed,
        graphDigest: digest,
        runId: `sb1-${this.seed}-${digest}`,
      };
      this.finished = true;
      this.resultValue = this.buildInvalidResult(parsed.issues);
      return;
    }

    this.graph = parsed.value;
    this.config = resolveConfig(parsed.value, this.catalog);
    this.trace = generateScoreboardTrace(this.seed, this.level);
    this.totalRequests = this.trace.requests.length;
    this.state = createVoteState(this.seed, this.level, this.config.readPlan);

    this.measuredStartMs = this.config.prepMs;
    this.measuredEndMs = this.measuredStartMs + this.level.workload.measuredMs;
    this.peakStartMs = this.measuredStartMs + this.level.workload.peakWindow.fromMs;
    this.peakEndMs = this.measuredStartMs + this.level.workload.peakWindow.toMs;
    this.drainEndMs = this.measuredEndMs + this.level.workload.drainMs;
    this.lastSeriesMs = this.measuredStartMs;
    this.phase = this.config.prepMs > 0 ? 'prepare' : 'run';

    this.preparation = {
      plan: this.config.readPlan,
      workCoreMs: this.config.prepWorkCoreMs,
      durationMs: this.config.prepMs,
      startMs: 0,
      endMs: this.config.prepMs,
      cacheColdAtTrafficStart: true,
      notes:
        this.config.readPlan === 'aggregate'
          ? 'The aggregate is built from current votes before the measured clock; the cache is still cold at traffic start.'
          : 'The scan plan has no preparation work; the cache is cold at traffic start.',
    };

    this.createNodes(parsed.value);
    this.createEdges(parsed.value);
    this.scheduleRun();
    this.identity = {
      levelId: SCOREBOARD_LEVEL_ID,
      modelVersion: this.level.modelVersion,
      schemaVersion: SCOREBOARD_SCHEMA_VERSION,
      contentVersion: this.level.contentVersion,
      pricingVersion: this.level.pricingVersion,
      seed: this.seed,
      graphDigest: scoreboardGraphDigest(parsed.value),
      runId: `sb1-${this.seed}-${scoreboardGraphDigest(parsed.value)}`,
    };
    safeCall(options.onProgress, this.progress());
  }

  progress(): ScoreboardProgress {
    const measuredElapsedMs = Math.max(
      0,
      Math.min(
        this.level.workload.measuredMs,
        this.scheduler.nowMs - this.measuredStartMs,
      ),
    );
    return {
      phase: this.phase,
      nowMs: this.scheduler.nowMs,
      measuredElapsedMs,
      completedRequests:
        this.allRequests.length - this.liveRequests.size,
      totalRequests: this.totalRequests,
      message: this.progressMessage(),
    };
  }

  advance(maxEvents = Number.POSITIVE_INFINITY): ScoreboardAdvance {
    if (this.done) {
      return {
        done: true,
        progress: this.progress(),
        processedEvents: 0,
        exhausted: false,
      };
    }
    if (
      !Number.isInteger(maxEvents) &&
      maxEvents !== Number.POSITIVE_INFINITY
    ) {
      throw new RangeError('maxEvents must be a non-negative integer or Infinity');
    }
    if (maxEvents < 0) {
      throw new RangeError('maxEvents must be non-negative');
    }
    if (this.cancelled) {
      this.finalize('incomplete');
      return {
        done: true,
        progress: this.progress(),
        processedEvents: 0,
        exhausted: false,
      };
    }

    let budget = maxEvents;
    let processed = 0;
    let exhausted = false;

    const runPhase = (untilMs: number): boolean => {
      const result = this.scheduler.runUntil(untilMs, budget);
      processed += result.processedEvents;
      budget = Math.max(0, budget - result.processedEvents);
      exhausted = result.exhausted;
      this.processedEvents = this.scheduler.processedEvents;
      if (this.processedEvents > this.level.limits.maxEvents) {
        this.limitReached = true;
        this.incompletes.push(
          `Event limit ${this.level.limits.maxEvents} was exhausted.`,
        );
        this.cancelLive('event-limit');
        return false;
      }
      return !result.exhausted;
    };

    const stopForLimit = (): ScoreboardAdvance => {
      this.cancelLive('event-limit');
      this.finalize('incomplete');
      return this.advanceResult(processed, exhausted);
    };
    if (this.phase === 'prepare') {
      if (!runPhase(this.measuredStartMs)) {
        return this.limitReached
          ? stopForLimit()
          : this.advanceResult(processed, exhausted);
      }
      this.phase = 'run';
    }
    if (this.phase === 'run') {
      if (!runPhase(this.measuredEndMs)) {
        return this.limitReached
          ? stopForLimit()
          : this.advanceResult(processed, exhausted);
      }
      this.phase = 'drain';
    }
    if (this.phase === 'drain') {
      if (this.liveRequests.size > 0) {
        if (!runPhase(this.drainEndMs)) {
          return this.limitReached
            ? stopForLimit()
            : this.advanceResult(processed, exhausted);
        }
      }
      if (this.liveRequests.size > 0) {
        this.incompletes.push(
          'Requests were still pending after the bounded drain.',
        );
        this.cancelLive('drain-incomplete');
      }
      this.finalize(
        this.incompletes.length > 0 ? 'incomplete' : 'complete',
      );
    }

    return this.advanceResult(processed, exhausted);
  }

  runToCompletion(maxEventsPerAdvance?: number): ScoreboardEvaluation {
    const budget =
      maxEventsPerAdvance === undefined
        ? Number.POSITIVE_INFINITY
        : maxEventsPerAdvance;
    let guard = 0;
    while (!this.done) {
      this.advance(budget);
      guard += 1;
      if (guard > 100_000) {
        this.incompletes.push('Evaluation did not converge.');
        this.cancelLive('non-convergent');
        this.finalize('incomplete');
      }
    }
    return this.resultValue ?? this.buildInvalidResult([]);
  }

  cancel(): void {
    if (this.done) {
      return;
    }
    this.cancelled = true;
    this.incompletes.push('Evaluation cancelled by the caller.');
    this.cancelLive('cancelled');
    for (const handle of this.tickHandles) {
      handle.cancel();
    }
    this.finalize('incomplete');
  }

  result(): ScoreboardEvaluation | null {
    return this.resultValue;
  }

  private advanceResult(
    processedEvents: number,
    exhausted: boolean,
  ): ScoreboardAdvance {
    return {
      done: this.done,
      progress: this.progress(),
      processedEvents,
      exhausted,
    };
  }

  private progressMessage(): string {
    switch (this.phase) {
      case 'validate':
        return 'Validating graph';
      case 'prepare':
        return 'Building the aggregate before traffic';
      case 'run':
        return 'Measured 90-second traffic';
      case 'drain':
        return 'Draining accepted requests';
      case 'done':
        return this.status === 'complete'
          ? this.resultValue?.passed === true
            ? 'All required gates passed'
            : 'Run complete with failed gates'
          : 'Evaluation incomplete';
      default:
        return 'Evaluating';
    }
  }

  private buildInvalidResult(
    graphIssues: readonly ScoreboardIssue[],
  ): ScoreboardEvaluation {
    const digest = 'invalid';
    const identity = {
      levelId: SCOREBOARD_LEVEL_ID,
      modelVersion: this.level.modelVersion,
      schemaVersion: SCOREBOARD_SCHEMA_VERSION,
      contentVersion: this.level.contentVersion,
      pricingVersion: this.level.pricingVersion,
      seed: this.seed,
      graphDigest: digest,
      runId: `sb1-${this.seed}-${digest}`,
    };
    return {
      status: 'invalid',
      passed: false,
      levelId: SCOREBOARD_LEVEL_ID,
      modelVersion: this.level.modelVersion,
      schemaVersion: SCOREBOARD_SCHEMA_VERSION,
      contentVersion: this.level.contentVersion,
      pricingVersion: this.level.pricingVersion,
      seed: this.seed,
      graphDigest: digest,
      runId: identity.runId,
      identity,
      issues: graphIssues.slice(0, this.maxIssues),
      incompleteReasons: [],
      preparation: null,
      window: null,
      gates: [],
      operations: null,
      nodes: [],
      links: [],
      correctness: null,
      freshness: null,
      cost: null,
      series: [],
      trafficFrames: [],
    };
  }

  private createNodes(graph: ScoreboardGraph): void {
    const config = this.config;
    if (config === null) {
      return;
    }
    for (const node of graph.nodes) {
      if (node.kind === 'users') {
        this.usersNode = this.createUsersNode(node.id, node.label);
        this.nodes.push(this.usersNode);
        continue;
      }
      if (node.kind === 'app') {
        this.appNode = this.createKernelNode(
          node.id,
          'app',
          node.label,
          config.appInstances,
          config.appCpuCores,
          config.appNicLanes,
          config.appMemoryBytes,
          0,
          this.level.limits.maxAppWaitingTasks,
          false,
        );
        this.nodes.push(this.appNode);
        continue;
      }
      if (node.kind === 'sql') {
        this.sqlNode = this.createKernelNode(
          node.id,
          'sql',
          node.label,
          1,
          config.sqlCores,
          config.sqlNicLanes,
          config.sqlMemoryBytes,
          this.level.dataset.workingSetBytes,
          this.level.limits.maxSqlWaitingTasks,
          true,
        );
        this.nodes.push(this.sqlNode);
        continue;
      }
      this.cacheNode = this.createKernelNode(
        node.id,
        'cache',
        node.label,
        1,
        config.cacheCpuCores,
        config.cacheNicLanes,
        config.cacheMemoryBytes,
        0,
        this.level.limits.maxCacheWaitingTasks,
        false,
      );
      this.nodes.push(this.cacheNode);
    }
  }

  private createUsersNode(id: string, label: string): NodeRuntime {
    return {
      id,
      kind: 'users',
      label,
      instances: 1,
      kernel: null,
      cpuResourceId: null,
      diskResourceId: null,
      nicResourceId: null,
      cpuCapacityCores: 0,
      nicCapacityLanes: 0,
      memoryCapacityBytes: 0,
      memory: null,
      queue: new NodeQueueDepthMeter(this.measuredStartMs, this.measuredEndMs),
      wait: { totalMs: 0, maxMs: 0, samples: 0 },
      workingSetBytes: 0,
      queueLimit: 0,
      active: 0,
      activePeak: 0,
      stageStarts: 0,
      netBytesOffered: 0,
      netBytesDelivered: 0,
      tasksSubmitted: 0,
      tasksCompleted: 0,
      tasksRejected: 0,
      tasksTimedOut: 0,
      tasksInterrupted: 0,
      memorySampleMs: 0,
      memorySampleBytesMs: 0,
      peakGbps: 0,
      measuredCpuBusyUnits: 0,
      measuredCpuPeak: 0,
      measuredMemoryPeak: 0,
      measuredNetBytesOffered: 0,
      measuredNetBytesDelivered: 0,
      lastCpuBusyCoreMs: 0,
      lastNetOfferedBytes: 0,
      lastStageStarts: 0,
      lastWaitingMs: 0,
    };
  }

  private createKernelNode(
    id: string,
    kind: 'app' | 'sql' | 'cache',
    label: string,
    instances: number,
    cpuCores: number,
    nicLanes: number,
    memoryBytes: number,
    workingSetBytes: number,
    queueLimit: number,
    withDisk: boolean,
  ): NodeRuntime {
    const kernel = new ResourceKernel(this.scheduler, {
      windowStartMs: this.measuredStartMs,
      windowEndMs: this.measuredEndMs,
      maxQueuedTasks: queueLimit,
    });
    const cpuResourceId = `${id}:cpu`;
    const nicResourceId = `${id}:nic`;
    kernel.registerResource({
      id: cpuResourceId,
      capacity: cpuCores,
      kind: 'cpu',
    });
    kernel.registerResource({
      id: nicResourceId,
      capacity: nicLanes,
      kind: 'network',
    });
    let diskResourceId: string | null = null;
    if (withDisk) {
      diskResourceId = `${id}:disk`;
      kernel.registerResource({
        id: diskResourceId,
        capacity: SCOREBOARD_SQL_DISK_LANES,
        kind: 'disk',
      });
    }
    const memory = new MemoryLedger(memoryBytes);
    if (workingSetBytes > 0) {
      if (!memory.reserve('working-set', workingSetBytes)) {
        throw new Error('declared working set does not fit database memory');
      }
    }
    return {
      id,
      kind,
      label,
      instances,
      kernel,
      cpuResourceId,
      diskResourceId,
      nicResourceId,
      cpuCapacityCores: cpuCores,
      nicCapacityLanes: nicLanes,
      memoryCapacityBytes: memoryBytes,
      memory,
      queue: new NodeQueueDepthMeter(this.measuredStartMs, this.measuredEndMs),
      wait: { totalMs: 0, maxMs: 0, samples: 0 },
      workingSetBytes,
      queueLimit,
      active: 0,
      activePeak: 0,
      stageStarts: 0,
      netBytesOffered: 0,
      netBytesDelivered: 0,
      tasksSubmitted: 0,
      tasksCompleted: 0,
      tasksRejected: 0,
      tasksTimedOut: 0,
      tasksInterrupted: 0,
      memorySampleMs: 0,
      memorySampleBytesMs: 0,
      peakGbps: 0,
      measuredCpuBusyUnits: 0,
      measuredCpuPeak: 0,
      measuredMemoryPeak: workingSetBytes,
      measuredNetBytesOffered: 0,
      measuredNetBytesDelivered: 0,
      lastCpuBusyCoreMs: 0,
      lastNetOfferedBytes: 0,
      lastStageStarts: 0,
      lastWaitingMs: 0,
    };
  }

  private createEdges(graph: ScoreboardGraph): void {
    for (const edge of graph.edges) {
      const from = graph.nodes.find((node) => node.id === edge.from);
      const to = graph.nodes.find((node) => node.id === edge.to);
      if (from === undefined || to === undefined) {
        continue;
      }
      const role =
        from.kind === 'users' && to.kind === 'app'
          ? 'traffic'
          : from.kind === 'app' && to.kind === 'sql'
            ? 'primary'
            : from.kind === 'app' && to.kind === 'cache'
              ? 'reads'
              : 'fill';
      const runtime: EdgeRuntime = {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        role,
        requests: { read: 0, write: 0, fill: 0 },
        requestsTotal: 0,
        bytesOffered: 0,
        bytesDelivered: 0,
        lastRequests: 0,
        lastBytes: 0,
        peakRequestsPerSecond: 0,
        peakBytesPerSecond: 0,
      };
      this.edges.push(runtime);
      this.edgeById.set(edge.id, runtime);
    }
    const byRole = (role: EdgeRuntime['role']) =>
      this.edges.find((edge) => edge.role === role) ?? null;
    this.usersAppEdge = byRole('traffic');
    this.appSqlEdge = byRole('primary');
    this.appCacheEdge = byRole('reads');
    this.cacheSqlEdge = byRole('fill');
  }

  private scheduleRun(): void {
    if (this.trace === null || this.config === null) {
      return;
    }
    if (this.config.readPlan === 'aggregate' && this.sqlNode !== null) {
      const node = this.sqlNode;
      const prep: SubmitTaskRequest = {
        id: 'aggregate-preparation',
        resources: [{ id: node.cpuResourceId ?? '', units: 1 }],
        durationMs: this.config.prepMs,
        onFinish: () => {
          // Preparation is deliberately outside the measured window.
        },
      };
      this.prepHandle = node.kernel?.submit(prep) ?? null;
    }

    const offset = this.measuredStartMs;
    const requests = this.trace.requests;
    for (const request of requests) {
      this.scheduler.schedule(offset + request.atMs, () =>
        this.admit(request),
      );
    }

    const seconds = Math.floor(this.level.workload.measuredMs / 1_000);
    for (let index = 1; index <= seconds; index += 1) {
      const atMs = this.measuredStartMs + index * 1_000;
      const handle = this.scheduler.schedule(
        atMs,
        () => this.closeBucket(Math.min(atMs, this.measuredEndMs)),
        2,
      );
      this.tickHandles.push(handle);
    }
  }

  private admit(request: ScoreboardTrace['requests'][number]): void {
    if (this.cancelled || this.done || this.settledPhase()) {
      return;
    }
    if (this.state === null || this.config === null) {
      return;
    }
    const now = this.scheduler.nowMs;
    const runtime: RequestRuntime = {
      id: request.id,
      operation: request.operation,
      offeredAtMs: Math.max(0, now - this.measuredStartMs),
      admittedAtMs: now,
      participant:
        request.operation === 'write' ? request.participant : -1,
      candidate: request.operation === 'write' ? request.candidate : -1,
      settled: false,
      outcome: null,
      failureReason: null,
      settledAtMs: null,
      snapshotVersion: 0,
      snapshotCommitMs: 0,
      snapshotCounts: null,
      snapshotLeaderboard: null,
      committed: false,
      acknowledged: false,
      commitVersion: null,
      countedCommittedUnacked: false,
      usedCache: false,
      waitingFill: false,
      fill: null,
      deadlineHandle: null,
      stage: null,
      timer: null,
      meterNode: null,
      meterOpen: false,
      meterBeganAtMs: 0,
      ledgerNode: null,
      ledgerId: null,
      activeNode: null,
      clientBytesOffered: 0,
      clientBytesDelivered: 0,
      lastNodeId: null,
      edgesUsed: new Set<string>(),
    };
    this.allRequests.push(runtime);
    this.liveRequests.add(runtime);
    this.addOffer(runtime);
    runtime.deadlineHandle = this.scheduler.schedule(
      now + this.level.workload.requestDeadlineMs,
      () => this.onDeadline(runtime),
      1,
    );

    if (runtime.operation === 'read') {
      this.startRead(runtime);
    } else {
      this.startWrite(runtime);
    }
  }

  private settledPhase(): boolean {
    return this.scheduler.nowMs >= this.measuredEndMs;
  }

  private addOffer(request: RequestRuntime): void {
    const bucket = Math.floor(request.offeredAtMs / 1_000);
    const current = this.bucketOffers.get(bucket) ?? { read: 0, write: 0 };
    current[request.operation] += 1;
    this.bucketOffers.set(bucket, current);
  }

  private bucketTraffic(
    bucket: number,
  ): { read: BucketTraffic; write: BucketTraffic } {
    const current = this.bucketOutcomes.get(bucket);
    if (current !== undefined) {
      return current;
    }
    const fresh = {
      read: { offered: 0, succeeded: 0, failed: 0 },
      write: { offered: 0, succeeded: 0, failed: 0 },
    };
    this.bucketOutcomes.set(bucket, fresh);
    return fresh;
  }

  private recordOutcome(request: RequestRuntime): void {
    if (request.settledAtMs === null) {
      return;
    }
    const bucket = Math.floor(
      (request.settledAtMs - this.measuredStartMs) / 1_000,
    );
    if (bucket < 0 || request.settledAtMs >= this.measuredEndMs) {
      return;
    }
    if (bucket >= Math.ceil(this.level.workload.measuredMs / 1_000)) {
      return;
    }
    const traffic = this.bucketTraffic(bucket)[request.operation];
    if (request.outcome === 'success') {
      traffic.succeeded += 1;
      const latencies =
        this.bucketLatency.get(bucket) ??
        { read: [], write: [] };
      latencies[request.operation].push(
        Math.max(0, request.settledAtMs - request.admittedAtMs),
      );
      this.bucketLatency.set(bucket, latencies);
    } else {
      traffic.failed += 1;
    }
  }

  private startRead(request: RequestRuntime): void {
    this.afterDelay(request, this.catalog.work.clientRequestProcessingMs, () => {
      if (request.settled) {
        return;
      }
      this.hop(
        request,
        this.appNode,
        this.usersAppEdge,
        this.catalog.network.clientRequestBytes,
        this.catalog.network.clientRttMs / 2,
        false,
        () => this.appReadCpu(request),
      );
    });
  }

  private appReadCpu(request: RequestRuntime): void {
    this.beginStage(request, {
      node: this.requireNode(this.appNode, 'app'),
      key: 'app-read',
      durationMs: this.catalog.work.appReadCoreMs,
      resources: [
        { id: this.requireNode(this.appNode, 'app').cpuResourceId ?? '', units: 1 },
      ],
      ledgerBytes: 64 * 1_024,
      onComplete: () => this.routeRead(request),
    });
  }

  private routeRead(request: RequestRuntime): void {
    if (this.cacheNode !== null && this.appCacheEdge !== null) {
      this.hop(
        request,
        this.appNode,
        this.appCacheEdge,
        this.catalog.network.clientRequestBytes,
        this.catalog.network.internalOneWayMs,
        false,
        () => this.cacheLookup(request),
      );
      return;
    }
    this.hop(
      request,
      this.appNode,
      this.appSqlEdge,
      this.catalog.network.clientRequestBytes,
      this.catalog.network.internalOneWayMs,
      false,
      () => this.sqlRead(request, 'direct'),
    );
  }

  private cacheLookup(request: RequestRuntime): void {
    const cache = this.requireNode(this.cacheNode, 'cache');
    this.beginStage(request, {
      node: cache,
      key: 'cache-lookup',
      durationMs: this.catalog.work.cacheLookupCoreMs,
      resources: [{ id: cache.cpuResourceId ?? '', units: 1 }],
      ledgerBytes: this.catalog.network.clientResponseBytes,
      onComplete: () => this.decideCache(request),
    });
  }

  private decideCache(request: RequestRuntime): void {
    const now = this.scheduler.nowMs;
    if (this.cacheEntry !== null && now >= this.cacheEntry.expiresAtMs) {
      // Lazy TTL eviction: the expired answer stops holding cache memory before
      // a new fill can replace it.
      this.releaseCacheEntryMemory();
      this.cacheEntry = null;
    }
    const entry = this.cacheEntry;
    if (entry !== null && now < entry.expiresAtMs) {
      this.cacheHits += 1;
      request.usedCache = true;
      this.serveCached(request, entry);
      return;
    }
    if (this.fill !== null) {
      this.cacheCoalesced += 1;
      this.cacheMisses += 1;
      request.waitingFill = true;
      request.fill = this.fill;
      this.fill.waiters.push(request);
      return;
    }
    this.cacheMisses += 1;
    const fill: FillRuntime = {
      lead: request,
      waiters: [request],
      startedAtMs: now,
    };
    this.fill = fill;
    request.waitingFill = true;
    request.fill = fill;
    this.hop(
      request,
      this.cacheNode,
      this.cacheSqlEdge,
      this.catalog.network.clientRequestBytes,
      this.catalog.network.internalOneWayMs,
      false,
      () => this.sqlRead(request, 'fill'),
    );
  }

  private sqlRead(request: RequestRuntime, mode: 'direct' | 'fill'): void {
    const sql = this.requireNode(this.sqlNode, 'sql');
    const duration =
      this.config?.readPlan === 'aggregate'
        ? this.catalog.work.aggregateReadCoreMs
        : this.level.dataset.participants *
          this.catalog.work.rawScanCoreMsPerRow;
    this.beginStage(request, {
      node: sql,
      key: `sql-read-${mode}`,
      durationMs: duration,
      resources: [{ id: sql.cpuResourceId ?? '', units: 1 }],
      ledgerBytes: 64 * 1_024,
      onStart: () => this.captureSnapshot(request),
      onComplete: () => {
        if (mode === 'direct') {
          this.hop(
            request,
            sql,
            this.appSqlEdge,
            this.catalog.network.clientResponseBytes,
            this.catalog.network.internalOneWayMs,
            false,
            () => this.deliverRead(request),
          );
        } else {
          this.hop(
            request,
            sql,
            this.cacheSqlEdge,
            this.catalog.network.clientResponseBytes,
            this.catalog.network.internalOneWayMs,
            false,
            () => this.storeCacheFill(request),
          );
        }
      },
    });
  }

  private captureSnapshot(request: RequestRuntime): void {
    if (this.state === null) {
      return;
    }
    const source =
      this.config?.readPlan === 'aggregate'
        ? this.state.aggregateCounts
        : this.state.counts;
    if (source === null) {
      return;
    }
    const last = this.state.writes[this.state.version - 1];
    request.snapshotVersion = this.state.version;
    request.snapshotCommitMs = last?.commitMs ?? 0;
    request.snapshotCounts = snapshotCounts(this.state);
    // Use the plan-specific projection for the returned answer.
    const projection =
      this.config?.readPlan === 'aggregate' ? source.slice() : request.snapshotCounts;
    request.snapshotCounts = projection;
    request.snapshotLeaderboard = leaderboard(
      projection,
      this.level.workload.topN,
    );
  }

  private storeCacheFill(request: RequestRuntime): void {
    const cache = this.requireNode(this.cacheNode, 'cache');
    this.beginStage(request, {
      node: cache,
      key: 'cache-store',
      durationMs: this.catalog.work.cacheStoreCoreMs,
      resources: [{ id: cache.cpuResourceId ?? '', units: 1 }],
      ledgerBytes: this.catalog.components.cache.entryBytes,
      onComplete: () => this.completeFill(request),
    });
  }

  /** Persistent resident allocation for the one cached leaderboard entry. */
  private reserveCacheEntryMemory(nowMs: number): boolean {
    const cache = this.cacheNode;
    if (cache?.memory === null || cache === null) {
      return true;
    }
    if (this.cacheEntryLedgerId !== null && cache.memory.has(this.cacheEntryLedgerId)) {
      return true;
    }
    const id = 'cache-entry';
    if (cache.memory.has(id)) {
      this.cacheEntryLedgerId = id;
      return true;
    }
    if (!cache.memory.reserve(id, this.catalog.components.cache.entryBytes)) {
      return false;
    }
    this.cacheEntryLedgerId = id;
    if (nowMs >= this.measuredStartMs && nowMs < this.measuredEndMs) {
      cache.measuredMemoryPeak = Math.max(
        cache.measuredMemoryPeak,
        cache.memory.usedBytes,
      );
    }
    return true;
  }

  private releaseCacheEntryMemory(): void {
    this.cacheEntryExpiry?.cancel();
    this.cacheEntryExpiry = null;
    const cache = this.cacheNode;
    if (cache?.memory !== null && cache !== null && this.cacheEntryLedgerId !== null) {
      cache.memory.release(this.cacheEntryLedgerId);
    }
    this.cacheEntryLedgerId = null;
  }

  private completeFill(lead: RequestRuntime): void {
    const fill = this.fill;
    if (fill === null || fill.lead !== lead) {
      return;
    }
    if (lead.snapshotCounts === null || lead.snapshotLeaderboard === null) {
      this.failFill('missing-cache-snapshot', 'error');
      return;
    }
    const now = this.scheduler.nowMs;
    this.releaseCacheEntryMemory();
    if (!this.reserveCacheEntryMemory(now)) {
      this.failFill('cache-memory-capacity', 'error');
      return;
    }
    const ttlMs = (this.config?.cacheTtlSeconds ?? 2) * 1_000;
    const entry: CacheEntryRuntime = {
      snapshotVersion: lead.snapshotVersion,
      snapshotCommitMs: lead.snapshotCommitMs,
      counts: lead.snapshotCounts,
      leaderboard: lead.snapshotLeaderboard,
      storedAtMs: now,
      expiresAtMs: now + ttlMs,
    };
    this.cacheEntry = entry;
    this.cacheEntryExpiry = this.scheduler.schedule(entry.expiresAtMs, () => {
      if (this.cacheEntry === entry) {
        this.releaseCacheEntryMemory();
        this.cacheEntry = null;
      }
    });
    const waiters = [...fill.waiters];
    fill.waiters.length = 0;
    this.fill = null;
    for (const waiter of waiters) {
      if (waiter.settled) {
        continue;
      }
      waiter.waitingFill = false;
      waiter.fill = null;
      waiter.usedCache = true;
      this.serveCached(waiter, entry);
    }
  }

  private serveCached(request: RequestRuntime, entry: CacheEntryRuntime): void {
    request.snapshotVersion = entry.snapshotVersion;
    request.snapshotCommitMs = entry.snapshotCommitMs;
    request.snapshotCounts = entry.counts;
    request.snapshotLeaderboard = entry.leaderboard;
    this.hop(
      request,
      this.cacheNode,
      this.appCacheEdge,
      this.catalog.network.clientResponseBytes,
      this.catalog.network.internalOneWayMs,
      false,
      () => {
        this.hop(
          request,
          this.appNode,
          this.usersAppEdge,
          this.catalog.network.clientResponseBytes,
          this.catalog.network.clientRttMs / 2,
          true,
          () =>
            this.afterDelay(
              request,
              this.catalog.work.clientResponseProcessingMs,
              () => this.succeedRead(request),
            ),
        );
      },
    );
  }

  private deliverRead(request: RequestRuntime): void {
    this.hop(
      request,
      this.appNode,
      this.usersAppEdge,
      this.catalog.network.clientResponseBytes,
      this.catalog.network.clientRttMs / 2,
      true,
      () =>
        this.afterDelay(
          request,
          this.catalog.work.clientResponseProcessingMs,
          () => this.succeedRead(request),
        ),
    );
  }

  private startWrite(request: RequestRuntime): void {
    this.afterDelay(request, this.catalog.work.clientRequestProcessingMs, () => {
      if (request.settled) {
        return;
      }
      this.hop(
        request,
        this.appNode,
        this.usersAppEdge,
        this.catalog.network.clientRequestBytes,
        this.catalog.network.clientRttMs / 2,
        false,
        () => this.appWriteCpu(request),
      );
    });
  }

  private appWriteCpu(request: RequestRuntime): void {
    const app = this.requireNode(this.appNode, 'app');
    this.beginStage(request, {
      node: app,
      key: 'app-write',
      durationMs: this.catalog.work.appWriteCoreMs,
      resources: [{ id: app.cpuResourceId ?? '', units: 1 }],
      ledgerBytes: 64 * 1_024,
      onComplete: () => {
        this.hop(
          request,
          this.appNode,
          this.appSqlEdge,
          this.catalog.network.clientRequestBytes,
          this.catalog.network.internalOneWayMs,
          false,
          () => this.sqlCommitCpu(request),
        );
      },
    });
  }

  private sqlCommitCpu(request: RequestRuntime): void {
    const sql = this.requireNode(this.sqlNode, 'sql');
    const duration =
      this.config?.readPlan === 'aggregate'
        ? this.catalog.work.aggregateWriteCoreMs
        : this.catalog.work.rawWriteCoreMs;
    this.beginStage(request, {
      node: sql,
      key: 'sql-write-cpu',
      durationMs: duration,
      resources: [{ id: sql.cpuResourceId ?? '', units: 1 }],
      ledgerBytes: 64 * 1_024,
      onComplete: () => this.sqlCommitDisk(request),
    });
  }

  private sqlCommitDisk(request: RequestRuntime): void {
    const sql = this.requireNode(this.sqlNode, 'sql');
    this.beginStage(request, {
      node: sql,
      key: 'sql-write-disk',
      durationMs: this.catalog.work.sqlDiskWriteCoreMs,
      resources: [{ id: sql.diskResourceId ?? '', units: 1 }],
      ledgerBytes: this.catalog.work.diskWriteBytesPerVote,
      onComplete: () => this.commitWrite(request),
    });
  }

  private commitWrite(request: RequestRuntime): void {
    if (request.settled || this.state === null) {
      return;
    }
    if (this.appliedRequestIds.has(request.id)) {
      this.doubleEffects += 1;
      this.failRequest(request, 'error', 'duplicate-commit');
      return;
    }
    this.appliedRequestIds.add(request.id);
    const now = this.scheduler.nowMs;
    const outcome = applyVoteChange(
      this.state,
      request.participant,
      request.candidate,
      now,
    );
    request.committed = true;
    request.commitVersion = outcome.version;
    this.writesCommitted += 1;
    if (outcome.changed) {
      if (outcome.version % 100 === 0) {
        this.checkAggregate();
      }
    } else {
      this.noOpWrites += 1;
    }
    this.hop(
      request,
      this.sqlNode,
      this.appSqlEdge,
      this.catalog.network.writeAckBytes,
      this.catalog.network.internalOneWayMs,
      false,
      () => {
        this.hop(
          request,
          this.appNode,
          this.usersAppEdge,
          this.catalog.network.writeAckBytes,
          this.catalog.network.clientRttMs / 2,
          true,
          () =>
            this.afterDelay(
              request,
              this.catalog.work.clientResponseProcessingMs,
              () => this.succeedWrite(request),
            ),
        );
      },
    );
  }

  private checkAggregate(): void {
    if (
      this.state === null ||
      this.state.aggregateCounts === null
    ) {
      return;
    }
    if (!countsEqual(this.state.counts, this.state.aggregateCounts)) {
      this.aggregateMismatches += 1;
    }
  }

  private succeedRead(request: RequestRuntime): void {
    if (request.settled || this.state === null) {
      return;
    }
    if (request.snapshotCounts === null) {
      this.failRequest(request, 'error', 'missing-snapshot');
      return;
    }
    this.successfulReads += 1;
    const now = this.scheduler.nowMs;
    const freshness = freshnessForSnapshot(
      this.state,
      request.snapshotVersion,
      now,
      this.freshnessLimitMs,
    );
    if (freshness.stale) {
      this.staleReads += 1;
    }
    if (freshness.lagMs > this.maxLagMs) {
      this.maxLagMs = freshness.lagMs;
    }
    this.lagSamples.push(freshness.lagMs);
    if (request.id % 500 === 0) {
      this.verifySnapshot(request);
    }
    this.settle(request, 'success', null);
  }

  private verifySnapshot(request: RequestRuntime): void {
    if (
      this.state === null ||
      request.snapshotCounts === null ||
      request.snapshotLeaderboard === null
    ) {
      return;
    }
    this.checkedSnapshots += 1;
    const reconstructed = reconstructCountsAtVersion(
      this.state,
      request.snapshotVersion,
    );
    const expectedLeaderboard = leaderboard(
      reconstructed,
      this.level.workload.topN,
    );
    if (
      !countsEqual(reconstructed, request.snapshotCounts) ||
      !leaderboardsEqual(expectedLeaderboard, request.snapshotLeaderboard)
    ) {
      this.snapshotMismatches += 1;
    }
  }

  private succeedWrite(request: RequestRuntime): void {
    if (request.settled) {
      return;
    }
    if (!request.committed || request.commitVersion === null) {
      this.failRequest(request, 'error', 'ack-without-commit');
      return;
    }
    request.acknowledged = true;
    this.writesAcknowledged += 1;
    this.successfulWrites += 1;
    this.ackedCommitVersions.add(request.commitVersion);
    this.settle(request, 'success', null);
  }

  private settle(
    request: RequestRuntime,
    outcome: RequestOutcome,
    reason: string | null,
  ): void {
    if (request.settled) {
      return;
    }
    request.settled = true;
    request.outcome = outcome;
    request.failureReason = reason;
    request.settledAtMs = this.scheduler.nowMs;
    this.lastSettledAtMs = Math.max(this.lastSettledAtMs, request.settledAtMs);
    request.deadlineHandle?.cancel();
    request.deadlineHandle = null;
    request.stage?.cancel();
    request.stage = null;
    request.timer?.cancel();
    request.timer = null;
    this.closeMeters(request);
    this.liveRequests.delete(request);
    this.recordOutcome(request);
  }

  private failRequest(
    request: RequestRuntime,
    outcome: RequestOutcome,
    reason: string,
  ): void {
    if (request.settled) {
      return;
    }
    if (request.committed && !request.acknowledged) {
      this.countCommittedUnacked(request);
    }
    this.settle(request, outcome, reason);
  }

  private countCommittedUnacked(request: RequestRuntime): void {
    if (request.countedCommittedUnacked) {
      return;
    }
    request.countedCommittedUnacked = true;
    this.committedUnacknowledged += 1;
  }

  private onDeadline(request: RequestRuntime): void {
    if (request.settled) {
      return;
    }
    const fill = this.fill;
    if (request.waitingFill && fill !== null) {
      if (fill.lead === request) {
        this.failFill('lead-deadline', 'timeout');
        return;
      }
      const index = fill.waiters.indexOf(request);
      if (index >= 0) {
        fill.waiters.splice(index, 1);
      }
      request.waitingFill = false;
      request.fill = null;
      this.failRequest(request, 'timeout', 'deadline');
      return;
    }
    this.failRequest(request, 'timeout', 'deadline');
  }

  private failFill(reason: string, leadOutcome: RequestOutcome): void {
    const fill = this.fill;
    if (fill === null) {
      return;
    }
    this.fill = null;
    const waiters = [...fill.waiters];
    fill.waiters.length = 0;
    for (const waiter of waiters) {
      if (waiter.settled) {
        continue;
      }
      waiter.waitingFill = false;
      waiter.fill = null;
      if (waiter === fill.lead) {
        this.failRequest(waiter, leadOutcome, reason);
      } else {
        this.failRequest(waiter, 'error', 'cache-fill-failed');
      }
    }
  }

  private beginStage(request: RequestRuntime, options: StageOptions): void {
    if (request.settled) {
      return;
    }
    const node = options.node;
    if (node.kernel === null) {
      this.failRequest(request, 'error', 'missing-resource-kernel');
      return;
    }
    const now = this.scheduler.nowMs;
    const taskMeasured = now >= this.measuredStartMs && now < this.measuredEndMs;
    const cpuUnits =
      options.resources.find((resource) => resource.id === node.cpuResourceId)
        ?.units ?? 0;
    request.lastNodeId = node.id;
    const ledgerId = `${request.id}:${options.key}`;
    const ledgerBytes = options.ledgerBytes ?? 0;
    if (
      node.memory !== null &&
      ledgerBytes > 0 &&
      !node.memory.reserve(ledgerId, ledgerBytes)
    ) {
      this.endMeter(request, now);
      this.failRequest(request, 'error', 'memory-capacity');
      return;
    }
    if (node.memory !== null && ledgerBytes > 0) {
      request.ledgerNode = node;
      request.ledgerId = ledgerId;
      if (taskMeasured) {
        node.measuredMemoryPeak = Math.max(
          node.measuredMemoryPeak,
          node.memory.usedBytes,
        );
      }
    }
    if (taskMeasured) {
      node.tasksSubmitted += 1;
    }
    let finishedSynchronously = false;
    let startedDuringSubmit = false;
    let duringSubmit = true;
    const handle = node.kernel.submit({
      id: ledgerId,
      resources: options.resources,
      durationMs: options.durationMs,
      onStart: (startedAtMs) => {
        if (duringSubmit) {
          startedDuringSubmit = true;
        }
        this.endMeter(request, startedAtMs);
        node.active += 1;
        const measuredStart =
          startedAtMs >= this.measuredStartMs &&
          startedAtMs < this.measuredEndMs;
        if (measuredStart) {
          if (node.active > node.activePeak) {
            node.activePeak = node.active;
          }
          node.stageStarts += 1;
        }
        if (cpuUnits > 0) {
          node.measuredCpuBusyUnits += cpuUnits;
          if (measuredStart) {
            node.measuredCpuPeak = Math.max(
              node.measuredCpuPeak,
              node.measuredCpuBusyUnits,
            );
          }
        }
        request.activeNode = node;
        options.onStart?.(startedAtMs);
      },
      onFinish: (result) => {
        finishedSynchronously = true;
        const endedAt = this.scheduler.nowMs;
        this.endMeter(request, endedAt);
        this.releaseLedger(request);
        if (request.activeNode === node) {
          node.active = Math.max(0, node.active - 1);
          request.activeNode = null;
        }
        if (cpuUnits > 0) {
          node.measuredCpuBusyUnits = Math.max(
            0,
            node.measuredCpuBusyUnits - cpuUnits,
          );
        }
        request.stage = null;
        if (taskMeasured) {
          if (result.status === 'completed') {
            node.tasksCompleted += 1;
          } else if (result.status === 'rejected') {
            node.tasksRejected += 1;
          } else if (result.status === 'timeout') {
            node.tasksTimedOut += 1;
          } else {
            node.tasksInterrupted += 1;
          }
        }
        if (request.settled) {
          return;
        }
        if (result.status === 'completed') {
          options.onComplete();
          return;
        }
        options.onFailed?.(result);
        if (result.status === 'rejected') {
          this.failRequest(request, 'rejected', result.reason);
        } else if (result.status === 'timeout') {
          this.failRequest(request, 'timeout', 'deadline');
        } else {
          this.failRequest(request, 'error', result.reason);
        }
      },
    });
    duringSubmit = false;
    // Only a task that actually joined the kernel queue is counted as waiting.
    // A synchronous queue-full rejection never enters the queue, and a task
    // that starts immediately has zero queue wait by definition.
    if (handle.accepted && !startedDuringSubmit) {
      node.queue.begin(now);
      request.meterNode = node;
      request.meterOpen = true;
      request.meterBeganAtMs = now;
    }
    if (!finishedSynchronously) {
      request.stage = handle;
    }
  }

  private endMeter(request: RequestRuntime, atMs: number): void {
    if (!request.meterOpen || request.meterNode === null) {
      return;
    }
    const node = request.meterNode;
    node.queue.end(atMs);
    const elapsed = Math.max(0, atMs - request.meterBeganAtMs);
    const from = Math.max(request.meterBeganAtMs, this.measuredStartMs);
    const to = Math.min(atMs, this.measuredEndMs);
    const clipped = Math.max(0, to - from);
    if (clipped > 0) {
      node.wait.totalMs += clipped;
      node.wait.maxMs = Math.max(node.wait.maxMs, clipped);
      node.wait.samples += 1;
    }
    void elapsed;
    request.meterOpen = false;
    request.meterNode = null;
  }

  private releaseLedger(request: RequestRuntime): void {
    if (
      request.ledgerNode !== null &&
      request.ledgerId !== null &&
      request.ledgerNode.memory !== null
    ) {
      request.ledgerNode.memory.release(request.ledgerId);
    }
    request.ledgerNode = null;
    request.ledgerId = null;
  }

  private closeMeters(request: RequestRuntime): void {
    if (request.meterOpen) {
      this.endMeter(request, this.scheduler.nowMs);
    }
    this.releaseLedger(request);
    if (request.activeNode !== null) {
      request.activeNode.active = Math.max(
        0,
        request.activeNode.active - 1,
      );
      request.activeNode = null;
    }
  }

  private hop(
    request: RequestRuntime,
    source: NodeRuntime | null,
    edge: EdgeRuntime | null,
    bytes: number,
    propagationMs: number,
    billableClientResponse: boolean,
    onDone: () => void,
  ): void {
    if (request.settled) {
      return;
    }
    const node = source;
    if (node === null || edge === null) {
      this.failRequest(request, 'error', 'missing-route');
      return;
    }
    if (node.nicResourceId === null || node.kernel === null) {
      this.failRequest(request, 'error', 'missing-network-resource');
      return;
    }
    if (!request.edgesUsed.has(edge.id)) {
      request.edgesUsed.add(edge.id);
      edge.requestsTotal += 1;
      if (edge.role === 'fill') {
        edge.requests.fill += 1;
      } else if (request.operation === 'write') {
        edge.requests.write += 1;
      } else {
        edge.requests.read += 1;
      }
    }
    edge.bytesOffered += bytes;
    node.netBytesOffered += bytes;
    const hopMeasured =
      this.scheduler.nowMs >= this.measuredStartMs &&
      this.scheduler.nowMs < this.measuredEndMs;
    if (hopMeasured) {
      node.measuredNetBytesOffered += bytes;
    }
    if (billableClientResponse) {
      request.clientBytesOffered += bytes;
    }
    const durationMs = (bytes * 8) / NETWORK_LANE_BITS_PER_MS;
    const account = (delivered: number) => {
      edge.bytesDelivered += delivered;
      node.netBytesDelivered += delivered;
      const deliveryMeasured =
        this.scheduler.nowMs >= this.measuredStartMs &&
        this.scheduler.nowMs < this.measuredEndMs;
      if (deliveryMeasured) {
        node.measuredNetBytesDelivered += delivered;
      }
      if (billableClientResponse) {
        request.clientBytesDelivered += delivered;
        this.billedBytes += delivered;
      }
    };
    this.beginStage(request, {
      node,
      key: `hop-${edge.id}`,
      durationMs,
      resources: [{ id: node.nicResourceId, units: 1 }],
      ledgerBytes: Math.min(bytes, 64 * 1_024),
      onComplete: () => {
        account(bytes);
        if (propagationMs > 0) {
          this.afterDelay(request, propagationMs, onDone);
        } else {
          onDone();
        }
      },
      onFailed: (result) => {
        const delivered = accountTransferBytes(bytes, result.workFraction);
        account(delivered.deliveredBytes);
      },
    });
  }

  private afterDelay(
    request: RequestRuntime,
    delayMs: number,
    callback: () => void,
  ): void {
    if (request.settled) {
      return;
    }
    if (delayMs <= 0) {
      callback();
      return;
    }
    const handle = this.scheduler.schedule(this.scheduler.nowMs + delayMs, () => {
      request.timer = null;
      if (!request.settled) {
        callback();
      }
    });
    request.timer = handle;
  }

  private cancelLive(reason: string): void {
    this.fill = null;
    const live = [...this.liveRequests];
    for (const request of live) {
      if (!request.settled) {
        this.failRequest(
          request,
          'error',
          reason === 'cancelled' ? 'cancelled' : reason,
        );
      }
    }
    this.prepHandle?.cancel();
  }

  private closeBucket(atMs: number): void {
    if (atMs <= this.lastSeriesMs + EPSILON) {
      return;
    }
    const start = this.lastSeriesMs;
    const end = Math.min(atMs, this.measuredEndMs);
    const windowMs = Math.max(0, end - start);
    if (windowMs <= 0) {
      return;
    }
    const bucketIndex = Math.floor((end - this.measuredStartMs - 1) / 1_000);
    const offered = this.bucketOffers.get(bucketIndex) ?? {
      read: 0,
      write: 0,
    };
    const outcomes = this.bucketOutcomes.get(bucketIndex) ?? {
      read: { offered: 0, succeeded: 0, failed: 0 },
      write: { offered: 0, succeeded: 0, failed: 0 },
    };
    const latencies = this.bucketLatency.get(bucketIndex) ?? {
      read: [],
      write: [],
    };
    const traffic = {
      read: {
        offered: offered.read,
        succeeded: outcomes.read.succeeded,
        failed: outcomes.read.failed,
      },
      write: {
        offered: offered.write,
        succeeded: outcomes.write.succeeded,
        failed: outcomes.write.failed,
      },
    };
    const latency = {
      read:
        latencies.read.length === 0
          ? null
          : {
              p50Ms: percentile(
                [...latencies.read].sort((a, b) => a - b),
                50,
              ),
              p95Ms: percentile(
                [...latencies.read].sort((a, b) => a - b),
                95,
              ),
              p99Ms: percentile(
                [...latencies.read].sort((a, b) => a - b),
                99,
              ),
              samples: latencies.read.length,
            },
      write:
        latencies.write.length === 0
          ? null
          : {
              p50Ms: percentile(
                [...latencies.write].sort((a, b) => a - b),
                50,
              ),
              p95Ms: percentile(
                [...latencies.write].sort((a, b) => a - b),
                95,
              ),
              p99Ms: percentile(
                [...latencies.write].sort((a, b) => a - b),
                99,
              ),
              samples: latencies.write.length,
            },
    };
    const nodeSeries = this.nodes.map((node) => {
      const stats = node.kernel?.stats();
      const cpu = stats?.resources.find(
        (resource) => resource.id === node.cpuResourceId,
      );
      const cpuBusy = cpu?.busyUnitMs ?? 0;
      const cpuDelta = Math.max(0, cpuBusy - node.lastCpuBusyCoreMs);
      node.lastCpuBusyCoreMs = cpuBusy;
      const netDelta = Math.max(
        0,
        node.measuredNetBytesOffered - node.lastNetOfferedBytes,
      );
      node.lastNetOfferedBytes = node.measuredNetBytesOffered;
      const stageDelta = Math.max(0, node.stageStarts - node.lastStageStarts);
      node.lastStageStarts = node.stageStarts;
      const waitingDelta = Math.max(0, node.queue.waitingMs - node.lastWaitingMs);
      node.lastWaitingMs = node.queue.waitingMs;
      const gbps = (netDelta * 8) / (windowMs * 1_000_000);
      if (gbps > node.peakGbps) {
        node.peakGbps = gbps;
      }
      return {
        nodeId: node.id,
        cpuUtilization:
          node.cpuCapacityCores > 0
            ? boundedUtilization(cpuDelta / windowMs / node.cpuCapacityCores)
            : null,
        ramUsedBytes: node.memory?.usedBytes ?? null,
        queueWaiting: node.kernel === null ? null : node.queue.waitingCount,
        queueWaitingAverage:
          node.kernel === null ? null : waitingDelta / windowMs,
        networkGbitPerSec: node.kernel === null ? null : gbps,
        requestsPerSecond: (stageDelta / windowMs) * 1_000,
        queueCapacity: node.kernel === null ? null : node.queueLimit,
      };
    });
    const seriesPoint: ScoreboardSeriesPoint = {
      timeMs: Math.max(0, end - this.measuredStartMs),
      windowMs,
      traffic,
      latency,
      nodes: nodeSeries.map((node) => ({
        nodeId: node.nodeId,
        cpuUtilization: node.cpuUtilization,
        ramUsedBytes: node.ramUsedBytes,
        queueWaiting: node.queueWaiting,
        queueWaitingAverage: node.queueWaitingAverage,
        networkGbitPerSec: node.networkGbitPerSec,
      })),
    };
    this.series.push(seriesPoint);

    const edgeDeltas = new Map<string, { requests: number; bytes: number }>();
    for (const edge of this.edges) {
      const requests = edge.requestsTotal - edge.lastRequests;
      const bytes = edge.bytesOffered - edge.lastBytes;
      edgeDeltas.set(edge.id, { requests, bytes });
      edge.lastRequests = edge.requestsTotal;
      edge.lastBytes = edge.bytesOffered;
      edge.peakRequestsPerSecond = Math.max(
        edge.peakRequestsPerSecond,
        (requests / windowMs) * 1_000,
      );
      edge.peakBytesPerSecond = Math.max(
        edge.peakBytesPerSecond,
        (bytes / windowMs) * 1_000,
      );
    }
    if (this.trafficFrames.length < this.maxFrames) {
      const frame = this.buildTrafficFrame(
        end,
        windowMs,
        nodeSeries,
        edgeDeltas,
      );
      this.trafficFrames.push(frame);
      safeCall(this.options?.onTraffic, frame);
    }

    for (const node of this.nodes) {
      const used = node.memory?.usedBytes ?? 0;
      node.memorySampleMs += windowMs;
      node.memorySampleBytesMs += used * windowMs;
    }
    this.lastSeriesMs = end;
    if (end >= this.measuredEndMs) {
      this.phase = 'drain';
    }
  }

  private buildTrafficFrame(
    endMs: number,
    windowMs: number,
    nodeSeries: {
      nodeId: string;
      cpuUtilization: number | null;
      ramUsedBytes: number | null;
      queueWaiting: number | null;
      queueWaitingAverage: number | null;
      networkGbitPerSec: number | null;
      requestsPerSecond: number;
      queueCapacity: number | null;
    }[],
    edgeDeltas: Map<string, { requests: number; bytes: number }>,
  ): ScoreboardTrafficFrame {
    const usersEdge = this.usersAppEdge;
    const usersDelta =
      usersEdge === null ? undefined : edgeDeltas.get(usersEdge.id);
    const usersRequestsPerSecond =
      usersDelta === undefined ? 0 : (usersDelta.requests / windowMs) * 1_000;
    const nodes = this.nodes.map((node) => {
      const series = nodeSeries.find((item) => item.nodeId === node.id);
      const resources: ScoreboardTrafficFrame['nodes'][number]['resources'] = [];
      if (node.kernel !== null && series !== undefined) {
        resources.push({
          key: 'cpu',
          label: 'CPU',
          aggregation: 'window-average',
          used: (series.cpuUtilization ?? 0) * node.cpuCapacityCores,
          capacity: node.cpuCapacityCores,
          unit: 'cores',
        });
        resources.push({
          key: 'ram',
          label: 'RAM',
          aggregation: 'instant',
          used: node.memory?.usedBytes ?? 0,
          capacity: node.memoryCapacityBytes,
          unit: 'bytes',
        });
        resources.push({
          key: 'queue',
          label: 'Waiting tasks',
          aggregation: 'instant',
          used: node.queue.waitingCount,
          capacity: node.queueLimit,
          unit: 'slots',
        });
        resources.push({
          key: 'network',
          label: 'Network',
          aggregation: 'window-average',
          used: series.networkGbitPerSec ?? 0,
          capacity: node.nicCapacityLanes,
          unit: 'gbit/s',
        });
      }
      return {
        nodeId: node.id,
        resources,
        requestsPerSecond:
          node.kind === 'users'
            ? usersRequestsPerSecond
            : series?.requestsPerSecond ?? null,
        queue: node.kernel === null ? null : node.queue.waitingCount,
        down: false,
      };
    });
    const edges = this.edges.map((edge) => {
      const delta = edgeDeltas.get(edge.id) ?? { requests: 0, bytes: 0 };
      return {
        edgeId: edge.id,
        requestsPerSecond: (delta.requests / windowMs) * 1_000,
        bytesPerSecond: (delta.bytes / windowMs) * 1_000,
      };
    });
    return {
      levelId: SCOREBOARD_LEVEL_ID,
      scopeId: 'live-measured',
      scopeLabel: 'Measured 90-second traffic',
      timeMs: Math.max(0, endMs - this.measuredStartMs),
      windowMs,
      phase: 'measured',
      nodes,
      edges,
    };
  }

  private finalize(
    status: ScoreboardEvaluation['status'],
  ): void {
    if (this.done) {
      return;
    }
    this.closePartialBucket();
    for (const handle of this.tickHandles) {
      handle.cancel();
    }
    this.status = status;
    this.phase = 'done';
    this.doneResult();
    this.releaseCacheEntryMemory();
    this.finished = true;
  }

  private closePartialBucket(): void {
    const now = Math.min(this.scheduler.nowMs, this.measuredEndMs);
    if (now > this.lastSeriesMs + EPSILON) {
      this.closeBucket(now);
    }
  }

  private doneResult(): void {
    const complete = this.status === 'complete';
    const finalEndMs =
      this.status === 'complete'
        ? Math.max(this.measuredEndMs, this.lastSettledAtMs)
        : Math.max(this.scheduler.nowMs, this.lastSettledAtMs);
    if (this.liveRequests.size > 0) {
      this.incompletes.push('Pending requests were not drained.');
      this.cancelLive('undrained');
    }
    const operations = this.buildOperations();
    const correctness = this.buildCorrectness();
    const freshness = this.buildFreshness();
    const cost = this.buildCost(finalEndMs);
    const gates = this.buildGates(operations, correctness, freshness);
    const passed =
      complete &&
      gates.every((gate) => gate.severity !== 'required' || gate.passed);
    const issues = this.buildIssues();
    const window = {
      measuredStartMs: this.measuredStartMs,
      measuredEndMs: this.measuredEndMs,
      peakStartMs: this.peakStartMs,
      peakEndMs: this.peakEndMs,
      drainMs: Math.max(0, finalEndMs - this.measuredEndMs),
      totalRunMs: finalEndMs,
      runEndedIncomplete: !complete,
    };
    const result: ScoreboardEvaluation = {
      status: this.status,
      passed,
      levelId: SCOREBOARD_LEVEL_ID,
      modelVersion: this.level.modelVersion,
      schemaVersion: SCOREBOARD_SCHEMA_VERSION,
      contentVersion: this.level.contentVersion,
      pricingVersion: this.level.pricingVersion,
      seed: this.seed,
      graphDigest: this.identity.graphDigest,
      runId: this.identity.runId,
      identity: this.identity,
      issues: issues.slice(0, this.maxIssues),
      incompleteReasons: [...this.incompletes],
      preparation: this.preparation,
      window,
      gates,
      operations,
      nodes: this.buildNodeMetrics(),
      links: this.buildLinkMetrics(),
      correctness,
      freshness,
      cost,
      series: this.series.slice(0, this.maxFrames),
      trafficFrames: this.trafficFrames.slice(0, this.maxFrames),
    };
    this.resultValue = result;
    safeCall(this.options?.onProgress, this.progress());
  }

  private readonly options: ScoreboardRunOptions;

  private buildOperations(): NonNullable<ScoreboardEvaluation['operations']> {
    const whole = {
      read: this.operationMetrics('read', 0, this.level.workload.measuredMs),
      write: this.operationMetrics('write', 0, this.level.workload.measuredMs),
    };
    const peak = {
      read: this.operationMetrics(
        'read',
        this.level.workload.peakWindow.fromMs,
        this.level.workload.peakWindow.toMs,
      ),
      write: this.operationMetrics(
        'write',
        this.level.workload.peakWindow.fromMs,
        this.level.workload.peakWindow.toMs,
      ),
    };
    return { ...whole, peak };
  }

  private operationMetrics(
    operation: 'read' | 'write',
    fromMs: number,
    toMs: number,
  ): ScoreboardOperationMetrics {
    const requests = this.allRequests.filter(
      (request) =>
        request.operation === operation &&
        request.offeredAtMs >= fromMs &&
        request.offeredAtMs < toMs,
    );
    let succeeded = 0;
    let failed = 0;
    let rejected = 0;
    let timedOut = 0;
    let errored = 0;
    let pending = 0;
    let bytesOffered = 0;
    let bytesDelivered = 0;
    const latencies: number[] = [];
    for (const request of requests) {
      bytesOffered += request.clientBytesOffered;
      bytesDelivered += request.clientBytesDelivered;
      switch (request.outcome) {
        case 'success':
          succeeded += 1;
          if (request.settledAtMs !== null) {
            latencies.push(
              Math.max(
                0,
                request.settledAtMs -
                  (this.measuredStartMs + request.offeredAtMs),
              ),
            );
          }
          break;
        case 'rejected':
          rejected += 1;
          failed += 1;
          break;
        case 'timeout':
          timedOut += 1;
          failed += 1;
          break;
        case 'error':
          errored += 1;
          failed += 1;
          break;
        default:
          pending += 1;
          break;
      }
    }
    const offered = requests.length;
    return {
      offered,
      succeeded,
      failed,
      rejected,
      timedOut,
      errored,
      pending,
      availability: offered === 0 ? null : succeeded / offered,
      latency: latencyMetrics(latencies, this.minimumLatencySamples),
      bytesOffered,
      bytesDelivered,
    };
  }

  private buildGates(
    operations: NonNullable<ScoreboardEvaluation['operations']>,
    correctness: ScoreboardCorrectness,
    freshness: ScoreboardFreshness,
  ): ScoreboardGate[] {
    const gates: ScoreboardGate[] = [];
    const windows: {
      window: 'whole' | 'peak';
      suffix: string;
      metrics: ScoreboardOperationMetrics;
      label: string;
    }[] = [
      {
        window: 'whole',
        suffix: 'whole',
        metrics: operations.read,
        label: 'whole 90 s',
      },
      {
        window: 'peak',
        suffix: 'peak',
        metrics: operations.peak.read,
        label: 'peak 20-60 s',
      },
    ];
    const windowsForWrite: typeof windows = [
      {
        window: 'whole',
        suffix: 'whole',
        metrics: operations.write,
        label: 'whole 90 s',
      },
      {
        window: 'peak',
        suffix: 'peak',
        metrics: operations.peak.write,
        label: 'peak 20-60 s',
      },
    ];
    const addAvailability = (
      operation: 'read' | 'write',
      window: 'whole' | 'peak',
      suffix: string,
      label: string,
      metrics: ScoreboardOperationMetrics,
    ) => {
      const actual = metrics.availability;
      const passed =
        actual !== null &&
        metrics.offered > 0 &&
        actual + EPSILON >= this.level.slo.availability;
      gates.push({
        id: `${operation}-availability-${suffix}`,
        label: `${operation === 'read' ? 'View leaderboard' : 'Change vote'} availability (${label})`,
        severity: 'required',
        operation,
        window,
        metric: 'availability',
        actual,
        limit: this.level.slo.availability,
        unit: 'ratio',
        sampleCount: metrics.offered,
        passed,
        message: passed
          ? `Availability ${formatRatio(actual)} meets ${formatRatio(this.level.slo.availability)}.`
          : `Availability ${formatRatio(actual)} is below ${formatRatio(this.level.slo.availability)} or has no offered requests.`,
      });
      const latency = metrics.latency;
      const p95Passed =
        latency.p95Ms !== null &&
        latency.samples >= this.minimumLatencySamples &&
        latency.p95Ms <= this.level.slo.successfulP95Ms + EPSILON;
      gates.push({
        id: `${operation}-p95-${suffix}`,
        label: `${operation === 'read' ? 'View leaderboard' : 'Change vote'} successful p95 (${label})`,
        severity: 'required',
        operation,
        window,
        metric: 'successful-p95',
        actual: latency.p95Ms,
        limit: this.level.slo.successfulP95Ms,
        unit: 'ms',
        sampleCount: latency.samples,
        passed: p95Passed,
        message: p95Passed
          ? `Successful p95 ${formatMs(latency.p95Ms)} with ${latency.samples} samples is within ${this.level.slo.successfulP95Ms} ms.`
          : `Successful p95 ${formatMs(latency.p95Ms)} with ${latency.samples} samples is missing, insufficient or above ${this.level.slo.successfulP95Ms} ms.`,
      });
    };
    for (const item of windows) {
      addAvailability('read', item.window, item.suffix, item.label, item.metrics);
    }
    for (const item of windowsForWrite) {
      addAvailability('write', item.window, item.suffix, item.label, item.metrics);
    }
    gates.push({
      id: 'correctness',
      label: 'Vote correctness',
      severity: 'required',
      metric: 'correctness',
      actual: null,
      limit: null,
      unit: 'boolean',
      sampleCount: correctness.writesCommitted + correctness.checkedSnapshots,
      passed: correctness.valid,
      message: correctness.valid
        ? 'No invalid, duplicate or lost acknowledged votes; sampled snapshots match the committed state.'
        : 'Vote correctness failed; inspect invalid, duplicate, lost-ACK or snapshot diagnostics.',
    });
    const freshnessPassed =
      freshness.valid &&
      freshness.successfulReads > 0 &&
      freshness.staleReads === 0;
    gates.push({
      id: 'freshness',
      label: 'Leaderboard freshness',
      severity: 'required',
      metric: 'freshness-lag',
      actual: freshness.maxLagMs,
      limit: this.level.slo.freshnessMs,
      unit: 'ms',
      sampleCount: freshness.successfulReads,
      passed: freshnessPassed,
      message: freshnessPassed
        ? `Every successful read included all commits older than ${this.level.slo.freshnessMs} ms.`
        : `Freshness failed: ${freshness.staleReads} stale reads out of ${freshness.successfulReads}.`,
    });
    const pending =
      operations.read.pending + operations.write.pending;
    gates.push({
      id: 'completion',
      label: 'Bounded drain and conservation',
      severity: 'required',
      metric: 'pending-requests',
      actual: pending,
      limit: 0,
      unit: 'requests',
      sampleCount: operations.read.offered + operations.write.offered,
      passed: pending === 0 && this.status === 'complete',
      message:
        pending === 0 && this.status === 'complete'
          ? 'Every offered request is accounted for and no work was left pending.'
          : `Run status is ${this.status}; ${pending} requests remain pending.`,
    });
    return gates;
  }

  private buildCorrectness(): ScoreboardCorrectness {
    const state = this.state;
    if (state === null) {
      return {
        valid: false,
        writesOffered: 0,
        writesCommitted: 0,
        writesAcknowledged: 0,
        committedUnacknowledged: 0,
        noOpWrites: 0,
        invalidVotes: 0,
        doubleEffects: 0,
        lostAcknowledgedVotes: 0,
        aggregateMismatches: 0,
        snapshotMismatches: 0,
        checkedSnapshots: 0,
        finalStateMatchesReference: false,
        finalRawMatchesAggregate: null,
        finalVoteCount: 0,
        finalCandidateVotes: 0,
      };
    }
    const recomputed = recomputeHistogram(state);
    const rawMatches = countsEqual(recomputed, state.counts);
    const total = totalVotes(state.counts);
    const finalState =
      rawMatches &&
      total === this.level.dataset.participants &&
      state.votes.length === this.level.dataset.participants;
    const aggregateMatches =
      state.aggregateCounts === null
        ? null
        : countsEqual(state.counts, state.aggregateCounts);
    if (!rawMatches) {
      this.invalidVotes += 1;
    }
    if (aggregateMatches === false) {
      this.aggregateMismatches += 1;
    }
    let lostAcknowledged = 0;
    const commitVersions = new Set(
      state.writes.map((commit) => commit.version),
    );
    for (const version of this.ackedCommitVersions) {
      if (!commitVersions.has(version)) {
        lostAcknowledged += 1;
      }
    }
    const valid =
      this.invalidVotes === 0 &&
      this.doubleEffects === 0 &&
      lostAcknowledged === 0 &&
      this.aggregateMismatches === 0 &&
      this.snapshotMismatches === 0 &&
      finalState &&
      (aggregateMatches === null || aggregateMatches) &&
      this.writesAcknowledged === this.successfulWrites;
    return {
      valid,
      writesOffered: this.trace?.writeCount ?? 0,
      writesCommitted: this.writesCommitted,
      writesAcknowledged: this.writesAcknowledged,
      committedUnacknowledged: this.committedUnacknowledged,
      noOpWrites: this.noOpWrites,
      invalidVotes: this.invalidVotes,
      doubleEffects: this.doubleEffects,
      lostAcknowledgedVotes: lostAcknowledged,
      aggregateMismatches: this.aggregateMismatches,
      snapshotMismatches: this.snapshotMismatches,
      checkedSnapshots: this.checkedSnapshots,
      finalStateMatchesReference: finalState,
      finalRawMatchesAggregate: aggregateMatches,
      finalVoteCount: total,
      finalCandidateVotes: state.counts.length,
    };
  }

  private buildFreshness(): ScoreboardFreshness {
    const values = [...this.lagSamples].sort((a, b) => a - b);
    return {
      valid:
        this.successfulReads > 0 &&
        this.staleReads === 0 &&
        this.snapshotMismatches === 0,
      freshnessLimitMs: this.freshnessLimitMs,
      successfulReads: this.successfulReads,
      checkedReads: this.successfulReads,
      staleReads: this.staleReads,
      maxLagMs: this.maxLagMs,
      p95LagMs: percentile(values, 95) ?? 0,
      samples: values.length,
    };
  }

  private buildCost(finalEndMs: number): ScoreboardCost | null {
    if (this.config === null || this.graph === null) {
      return null;
    }
    const hours = finalEndMs / 3_600_000;
    const lines: ScoreboardCostLine[] = [];
    for (const node of this.nodes) {
      if (node.kind === 'users') {
        continue;
      }
      const hourly =
        node.kind === 'app'
          ? this.config.appHourlyUsd
          : node.kind === 'sql'
            ? this.config.sqlHourlyUsd
            : this.config.cacheHourlyUsd;
      lines.push({
        nodeId: node.id,
        kind: node.kind,
        hourlyUsd: hourly,
        hours,
        usd: hourly * hours,
      });
    }
    const hourlyUsd = lines.reduce((sum, line) => sum + line.hourlyUsd, 0);
    const rentalUsd = hourlyUsd * hours;
    const bytesUsd =
      (this.billedBytes / BYTES_PER_GB) *
      this.catalog.billing.responseBytesUsdPerGb;
    const actualUsd = rentalUsd + bytesUsd;
    return {
      currency: 'USD',
      hourlyUsd,
      preparationMs: this.config.prepMs,
      measuredMs: this.level.workload.measuredMs,
      drainMs: Math.max(0, finalEndMs - this.measuredEndMs),
      billedMs: finalEndMs,
      rentalUsd,
      billedBytes: this.billedBytes,
      bytesUsd,
      actualUsd,
      scoreUsd: actualUsd,
      lines,
    };
  }

  private buildNodeMetrics(): ScoreboardNodeMetrics[] {
    const windowMs = this.level.workload.measuredMs;
    return this.nodes.map((node) => {
      const stats: ResourceKernelStats | undefined = node.kernel?.stats();
      const cpu = stats?.resources.find(
        (resource) => resource.id === node.cpuResourceId,
      );
      const busyCoreMs = cpu?.busyUnitMs ?? 0;
      const busyCoresAverage = busyCoreMs / windowMs;
      const residentAverage =
        node.memorySampleMs > 0
          ? node.memorySampleBytesMs / node.memorySampleMs
          : node.memory?.usedBytes ?? 0;
      return {
        nodeId: node.id,
        kind: node.kind,
        label: node.label,
        instances: node.instances,
        cpu: {
          capacityCores: node.cpuCapacityCores,
          busyCoresAverage,
          busyCoresPeak: node.measuredCpuPeak,
          busyCoreMs,
          utilizationAverage:
            node.cpuCapacityCores > 0
              ? boundedUtilization(busyCoresAverage / node.cpuCapacityCores)
              : 0,
          utilizationPeak:
            node.cpuCapacityCores > 0
              ? boundedUtilization(node.measuredCpuPeak / node.cpuCapacityCores)
              : 0,
        },
        memory: {
          capacityBytes: node.memoryCapacityBytes,
          workingSetBytes: node.workingSetBytes,
          residentBytesAverage: residentAverage,
          peakUsedBytes: node.measuredMemoryPeak,
        },
        queue: {
          waitingAverage: node.queue.averageDepth,
          waitingPeak: node.queue.peakDepth,
          waitMsAverage:
            node.wait.samples > 0 ? node.wait.totalMs / node.wait.samples : 0,
          waitMsMax: node.wait.maxMs,
          waitSamples: node.wait.samples,
          activePeak: node.activePeak,
        },
        network: {
          capacityGbitPerSec: node.nicCapacityLanes,
          bytesOffered: node.measuredNetBytesOffered,
          bytesDelivered: node.measuredNetBytesDelivered,
          averageGbitPerSec:
            (node.measuredNetBytesOffered * 8) / (windowMs * 1_000_000),
          peakGbitPerSec: node.peakGbps,
        },
        tasks: {
          submitted: node.tasksSubmitted,
          completed: node.tasksCompleted,
          rejected: node.tasksRejected,
          timedOut: node.tasksTimedOut,
          interrupted: node.tasksInterrupted,
        },
      };
    });
  }

  private buildLinkMetrics(): ScoreboardLinkMetrics[] {
    return this.edges.map((edge) => ({
      edgeId: edge.id,
      from: edge.from,
      to: edge.to,
      role: edge.role,
      requests: { ...edge.requests },
      requestsTotal: edge.requestsTotal,
      bytesOffered: edge.bytesOffered,
      bytesDelivered: edge.bytesDelivered,
      peakRequestsPerSecond: edge.peakRequestsPerSecond,
      peakBytesPerSecond: edge.peakBytesPerSecond,
    }));
  }

  private buildIssues(): ScoreboardIssue[] {
    if (this.graph === null) {
      return [];
    }
    const issues: ScoreboardIssue[] = [];
    const validationIssues = validateScoreboardGraph(this.graph);
    issues.push(...validationIssues);
    const rejected = this.allRequests.filter(
      (request) => request.outcome === 'rejected',
    );
    if (rejected.length > 0) {
      const byNode = new Map<string, number>();
      for (const request of rejected) {
        const key = request.lastNodeId ?? 'unknown';
        byNode.set(key, (byNode.get(key) ?? 0) + 1);
      }
      for (const [nodeId, count] of byNode) {
        issues.push({
          severity: 'warning',
          code: 'queue_overflow',
          message: `${count} requests were rejected because a node queue was full.`,
          nodeId,
          count,
        });
      }
    }
    const timedOut = this.allRequests.filter(
      (request) => request.outcome === 'timeout',
    );
    if (timedOut.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'request_timeout',
        message: `${timedOut.length} requests exceeded the 1000 ms deadline.`,
        count: timedOut.length,
      });
    }
    if (this.aggregateMismatches > 0) {
      issues.push({
        severity: 'error',
        code: 'aggregate_mismatch',
        message: 'The maintained aggregate diverged from the raw vote histogram.',
        count: this.aggregateMismatches,
      });
    }
    if (this.snapshotMismatches > 0) {
      issues.push({
        severity: 'error',
        code: 'snapshot_mismatch',
        message: 'A sampled leaderboard response did not match its committed version.',
        count: this.snapshotMismatches,
      });
    }
    for (const reason of this.incompletes) {
      issues.push({
        severity: 'error',
        code: 'incomplete_run',
        message: reason,
      });
    }
    return issues;
  }

  private requireNode(
    node: NodeRuntime | null,
    kind: string,
  ): NodeRuntime {
    if (node === null) {
      throw new Error(`missing ${kind} node`);
    }
    return node;
  }
}

function leaderboardsEqual(
  left: readonly LeaderboardEntry[],
  right: readonly LeaderboardEntry[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a?.candidate !== b?.candidate || a?.votes !== b?.votes) {
      return false;
    }
  }
  return true;
}

function formatRatio(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function formatMs(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)} ms`;
}

/** Synchronous public evaluation. */
export function evaluateScoreboard(
  input: unknown,
  options: ScoreboardRunOptions = {},
): ScoreboardEvaluation {
  const session = new ScoreboardSimulation(input, options);
  return session.runToCompletion(options.maxEventsPerAdvance);
}

/** Incremental public session used by the browser worker and CLI. */
export function createScoreboardSession(
  input: unknown,
  options: ScoreboardRunOptions = {},
): ScoreboardSession {
  return new ScoreboardSimulation(input, options);
}
