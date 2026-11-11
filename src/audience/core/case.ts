import {
  AUDIENCE_AVAILABILITY_SLO,
  AUDIENCE_CACHE_POLICY,
  AUDIENCE_FAULT_CONNECTION_POLICY,
  AUDIENCE_FRESHNESS_MS,
  AUDIENCE_HEALTH_POLICY,
  AUDIENCE_MAX_INCIDENT_EVENTS,
  AUDIENCE_MAX_SERIES_POINTS,
  AUDIENCE_MAX_TRAFFIC_NODES,
  AUDIENCE_MIN_LATENCY_SAMPLES,
  AUDIENCE_PROJECTION_POLICY,
  AUDIENCE_QUEUE_LIMITS,
  AUDIENCE_REQUEST_DEADLINE_MS,
  AUDIENCE_RETRY_POLICY,
  AUDIENCE_SUCCESSFUL_P95_MS,
  audienceRequiredGateSpecs,
  type AudienceCaseResult,
  type AudienceCaseSpec,
  type AudienceCost,
  type AudienceCorrectness,
  type AudienceFreshness,
  type AudienceGate,
  type AudienceIncidentEvent,
  type AudienceLinkRole,
  type AudienceNodeMetrics,
  type AudienceOperationMetrics,
  type AudienceProjectionLag,
  type AudienceRunWindow,
  type AudienceSeriesPoint,
  type AudienceSnapshot,
  type AudienceTarget,
  type AudienceTrafficFrame,
} from '../contracts';
import {
  ActivityOverlay,
  LastSeenIndex,
  countAtOrBelow,
  rankingsEqual,
  recomputeWindowRanking,
  type AudienceCommitLog,
  type AudienceRanking,
} from './activity';
import type { ChallengeStepEngine } from '../../simulation/challenges';
import {
  LatencyBuckets,
  LatencySamples,
  SecondBuckets,
  boundedRatio,
} from './metrics';
import {
  closeEdgeBucket,
  createEdge,
  createInstance,
  edgeMetrics,
  nodeMetrics,
  observeEdge,
  observeMemory,
  openEdgeBucketRates,
  type EdgeRuntime,
  type InstanceRuntime,
  type NodeRuntime,
} from './nodes';
import type { AudienceModel } from './model';
import type { AudienceTopology } from './topology';
import type {
  AudienceBaseHistory,
  AudienceIngestTrace,
  AudienceReadTrace,
} from './workload';
import type { EventScheduler, ScheduledHandle } from '../../simulation/resources/scheduler';
import { EventScheduler as Scheduler } from '../../simulation/resources/scheduler';
import type { SubmitTaskRequest, TaskHandle, TaskResult } from '../../simulation/resources/kernel';

/**
 * One Live Audience qualification case.
 *
 * Real work, real queues:
 * - every Application slot is a separate physical instance with its own kernel,
 *   CPU/NIC capacity, 256-task queue and crash lifecycle;
 * - SQL, Cache, Worker and the managed Load Balancer have their own kernels and
 *   finite capacities;
 * - ingest runs Application CPU -> SQL CPU -> durable log + outbox -> SQL disk;
 * - a ranking either scans the exact committed window (query plan) or reads a
 *   published durable projection (projection plan);
 * - the Load Balancer routes only to backends whose *known* health is ready,
 *   with 250 ms probes, 100 ms timeouts, two failures to exclude and two
 *   successes to restore; probes consume real work.
 *
 * The served ranking always names the exact snapshot it was computed from: the
 * real SQL CPU-start instant plus the durable commit cursor at that instant.
 */

/**
 * Managed Load Balancer request work, derived from its published capacity:
 * four cores at 10,000 requests/s is 0.4 core-ms per request. Probes consume
 * their own real kernel tasks. This coefficient is catalog-pending (A101
 * handoff), and at the frozen 2,000 requests/s offered load the LB stays far
 * from saturation.
 */
const LB_CORES = 4;
/**
 * Managed Load Balancer request work, derived from its own published capacity
 * (four cores handle 10,000 requests/s), so it is a disclosed physical limit
 * rather than a tuning knob. Probes consume their own kernel tasks.
 */
export const LB_REQUEST_CORE_MS = (LB_CORES * 1_000) / 10_000;

type Operation = 'ingest' | 'read';
type Outcome =
  | 'succeeded'
  | 'timeout'
  | 'rejected'
  | 'errored'
  | 'unknown';

interface OperationAccumulator {
  offered: number;
  attempts: number;
  retries: number;
  succeeded: number;
  failed: number;
  rejected: number;
  timedOut: number;
  errored: number;
  unknownOutcome: number;
  pending: number;
  bytesOffered: number;
  bytesDelivered: number;
  latency: LatencySamples;
  buckets: SecondBuckets;
  latencyBuckets: LatencyBuckets;
}

function createAccumulator(bucketCount: number): OperationAccumulator {
  return {
    offered: 0,
    attempts: 0,
    retries: 0,
    succeeded: 0,
    failed: 0,
    rejected: 0,
    timedOut: 0,
    errored: 0,
    unknownOutcome: 0,
    pending: 0,
    bytesOffered: 0,
    bytesDelivered: 0,
    latency: new LatencySamples(),
    buckets: new SecondBuckets(bucketCount),
    latencyBuckets: new LatencyBuckets(bucketCount),
  };
}

interface RequestRecord {
  readonly id: number;
  readonly operation: Operation;
  readonly offeredAtMs: number;
  readonly deadlineAtMs: number;
  readonly critical: boolean;
  readonly eventIndex: number;
  readonly pairKey: number;
  readonly stream: number;
  readonly user: number;
  attempts: number;
  /** Monotonic per-attempt token: callbacks from an older attempt are stale. */
  attemptToken: number;
  retries: number;
  /** A retry was scheduled for this logical request; guards the one-retry rule. */
  retryActive: boolean;
  backend: number;
  task: TaskHandle | null;
  deadlineHandle: ScheduledHandle | null;
  fillWaiter: boolean;
  committed: boolean;
  commitSequence: number | null;
  acknowledged: boolean;
  answered: boolean;
  uncertain: boolean;
  resolvedUncertain: boolean;
  audited: boolean;
  servedFromCache: CacheEntryRuntime | null;
  /** SQL accepted the event; its durable commit may still happen after a crash. */
  sqlAccepted: boolean;
  countedUnacked: boolean;
  /** Slot this request currently has an open connection to, or -1. */
  connectedSlot: number;
  /** Application work was already in flight for this slot when it crashed. */
  crashedInFlight: boolean;
  settled: boolean;
  settledAtMs: number;
  outcome: Outcome | null;
  capacityId: string | null;
  served: AudienceRanking | null;
  capturedAsOfMs: number;
  capturedCursor: number;
  capturedRows: number;
  lastFailureAtMs: number;
}

interface OutboxJob {
  readonly sequence: number;
  readonly timeMs: number;
  readonly pairKey: number;
  readonly stream: number;
}

/**
 * Immutable SQL transaction identity. One attempt captures its own token,
 * backend and payload when SQL accepts it; a later retry owns a different
 * transaction object, so an in-flight commit can never be rebound to the wrong
 * attempt or payload.
 */
interface SqlTransaction {
  readonly token: number;
  readonly backend: number;
  readonly pairKey: number;
  readonly stream: number;
}

interface ClaimedBatch {
  readonly start: number;
  readonly end: number;
  readonly jobs: OutboxJob[];
  readonly maxTimeMs: number;
}

interface CacheEntryRuntime {
  readonly ranking: AudienceRanking;
  readonly filledAtMs: number;
  readonly expiresAtMs: number;
  readonly bytes: number;
  /** True once the stored payload was verified against raw rows. */
  readonly audited: boolean;
}

interface CacheFillState {
  readonly lead: RequestRecord;
  ranking: AudienceRanking | null;
  storing: boolean;
  readonly waiters: RequestRecord[];
}

export interface AudienceCaseInputs {
  readonly model: AudienceModel;
  readonly topology: AudienceTopology;
  readonly caseSpec: AudienceCaseSpec;
  readonly seed: number;
  readonly base: AudienceBaseHistory;
  readonly ingest: AudienceIngestTrace;
  readonly reads: AudienceReadTrace;
}

const EPSILON = 1e-9;

interface EdgeFrameRate {
  readonly edgeId: string;
  readonly requestsPerSecond: number;
  readonly bytesPerSecond: number;
}

/** Contract-safe non-negative finite rate; unknown or invalid becomes idle. */
function rate(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export class AudienceCaseSimulation implements ChallengeStepEngine {
  private readonly scheduler: EventScheduler = new Scheduler();
  private readonly model: AudienceModel;
  private readonly topology: AudienceTopology;
  private readonly spec: AudienceCaseSpec;
  private readonly base: AudienceBaseHistory;
  private readonly ingestTrace: AudienceIngestTrace;
  private readonly readTrace: AudienceReadTrace;
  private readonly windowMs: number;
  private readonly topN: number;
  private readonly streams: number;

  private readonly measuredStartMs: number;
  private readonly measuredEndMs: number;
  private readonly drainEndMs: number;
  private readonly peakStartMs: number;
  private readonly peakEndMs: number;
  private readonly criticalStartMs: number | null;
  private readonly criticalEndMs: number | null;

  private readonly appInstances: InstanceRuntime[] = [];
  private readonly allInstances: InstanceRuntime[] = [];
  private readonly nodes: NodeRuntime[] = [];
  private readonly edges: EdgeRuntime[] = [];
  private sql: InstanceRuntime;
  private cache: InstanceRuntime | null = null;
  private workers: InstanceRuntime[] = [];
  private lb: InstanceRuntime | null = null;
  private usersNode: NodeRuntime;

  /** Served answer state: exact overlay fed by durable commits. */
  private readonly servedState: ActivityOverlay;
  /** Independent audit structure fed by the same durable commits. */
  private readonly auditIndex: LastSeenIndex;
  /** Published projection state and its independent audit twin. */
  private projectionState: ActivityOverlay | null = null;
  private projectionAudit: LastSeenIndex | null = null;

  private readonly log: AudienceCommitLog = {
    count: 0,
    timesMs: new Float64Array(1_024),
    pairs: new Int32Array(1_024),
    streams: new Uint8Array(1_024),
  };
  private readonly committedPayload = new Map<number, { sequence: number; timeMs: number; pairKey: number }>();
  private acknowledgedEventIds = new Set<number>();
  private readonly live = new Set<RequestRecord>();
  /** Established client connections per physical Application slot. */
  private readonly connections = new Map<number, Set<RequestRecord>>();
  private nextRequestId = 0;
  private liveCount = 0;

  private ingest = createAccumulator(0);
  private read = createAccumulator(0);
  private criticalIngest: OperationAccumulator | null = null;
  private criticalRead: OperationAccumulator | null = null;

  private readonly durationBuckets: number;
  /** End of the interval already flushed into the open edge buckets. */
  private edgeBucketClosedAtMs: number;
  private readonly series: AudienceSeriesPoint[] = [];
  private readonly frames: AudienceTrafficFrame[] = [];
  private deadlineCount = 0;
  private rejectedCount = 0;
  private unknownCount = 0;
  private errorCount = 0;
  private readonly lifecycleIncidents: AudienceIncidentEvent[] = [];
  private readonly activityIncidents: AudienceIncidentEvent[] = [];
  private readonly sampledIncidentCounts = new Map<string, number>();
  private tickHandles: ScheduledHandle[] = [];
  private probeHandles: ScheduledHandle[] = [];

  private prepHandles: TaskHandle[] = [];
  private prepDone = false;
  private prepFailed = false;

  private phaseState: 'prepare' | 'run' | 'drain' | 'done' = 'prepare';
  private cancelled = false;
  private incompleteReasons: string[] = [];
  private resultValue: AudienceCaseResult | null = null;

  private publishedThrough = 0;
  private publishedAsOfMs = 0;
  private heartbeatCount = 0;
  private outbox: OutboxJob[] = [];
  private outboxClaimed = 0;
  private readonly publishQueue = new Map<number, { batch: ClaimedBatch }>();
  private workerPollHandles: ScheduledHandle[] = [];

  /** Distinct pair entries materialized in the durable projection. */
  private projectionPairCount = 0;

  private cacheEntry: CacheEntryRuntime | null = null;
  private cacheFill: CacheFillState | null = null;

  private target: AudienceTarget | null = null;
  private readonly targetSlot: number | null;
  private lbPointer = 0;

  // Correctness/audit counters.
  private ingestCommitted = 0;
  private committedUnacknowledged = 0;
  private duplicateLogicalEvents = 0;
  private lostAcknowledged = 0;
  private retriedLogical = 0;
  private idempotentReplays = 0;
  private payloadConflicts = 0;
  private unknownCommitOutcomes = 0;
  private resolvedUnknownCommitOutcomes = 0;
  private commitsSurvivedCrash = 0;
  private commitHighWater = 0;
  private checkedSnapshots = 0;
  private snapshotMismatches = 0;
  private wrongWindowReads = 0;
  private rawAudits = 0;
  private finalRankingMatches: boolean | null = null;
  private finalActivePairs = 0;
  private expectedActivePairs = 0;
  private expectedExpiries = 0;

  // Freshness counters.
  private successfulReads = 0;
  private checkedReads = 0;
  private staleReads = 0;
  private maxLagMs = 0;
  private lagSamples: number[] = [];
  private latestSnapshot: AudienceSnapshot | null = null;
  private finalSnapshot: AudienceSnapshot | null = null;

  private billedBytes = 0;
  private lastSettledAtMs = 0;
  private processedEvents = 0;
  private readonly maxEvents: number;

  constructor(inputs: AudienceCaseInputs) {
    this.model = inputs.model;
    this.topology = inputs.topology;
    this.spec = inputs.caseSpec;
    this.base = inputs.base;
    this.ingestTrace = inputs.ingest;
    this.readTrace = inputs.reads;
    this.windowMs = this.model.level.dataset.activityWindowMs;
    this.topN = this.model.level.workload.topN;
    this.streams = this.model.level.dataset.streams;
    this.maxEvents = this.model.level.limits.maxEvents;
    this.targetSlot =
      this.spec.kind === 'app-instance-failure'
        ? this.spec.targetInstance
        : null;

    const measuredMs = this.model.level.workload.measuredMs;
    const drainMs = this.model.level.workload.drainMs;
    this.measuredStartMs = this.prepDurationMs();
    this.measuredEndMs = this.measuredStartMs + measuredMs;
    this.drainEndMs = this.measuredEndMs + drainMs;
    this.edgeBucketClosedAtMs = this.measuredStartMs;
    this.peakStartMs = this.measuredStartMs + this.model.level.workload.peakWindow.fromMs;
    this.peakEndMs = this.measuredStartMs + this.model.level.workload.peakWindow.toMs;
    this.criticalStartMs =
      this.spec.criticalWindow === null
        ? null
        : this.measuredStartMs + this.spec.criticalWindow.fromMs;
    this.criticalEndMs =
      this.spec.criticalWindow === null
        ? null
        : this.measuredStartMs + this.spec.criticalWindow.toMs;
    this.durationBuckets = Math.max(
      1,
      Math.ceil(measuredMs / 1_000),
    );
    this.ingest = createAccumulator(this.durationBuckets);
    this.read = createAccumulator(this.durationBuckets);
    if (this.criticalStartMs !== null && this.criticalEndMs !== null) {
      this.criticalIngest = createAccumulator(this.durationBuckets);
      this.criticalRead = createAccumulator(this.durationBuckets);
    }

    this.usersNode = {
      nodeId: this.topology.usersId,
      kind: 'users',
      label:
        this.topology.nodes.find((node) => node.id === this.topology.usersId)
          ?.label ?? 'Users',
      instances: [],
      crashEvents: 0,
      recoveryMs: null,
    };
    this.buildTopologyRuntime();

    this.servedState = ActivityOverlay.fromPrehistory(
      this.base,
      this.windowMs,
      this.streams,
    );
    this.auditIndex = new LastSeenIndex(this.base, this.windowMs, this.streams);
    if (this.topology.readPlan === 'projection') {
      this.projectionState = ActivityOverlay.fromPrehistory(
        this.base,
        this.windowMs,
        this.streams,
      );
      this.projectionAudit = new LastSeenIndex(
        this.base,
        this.windowMs,
        this.streams,
      );
      this.projectionPairCount = this.base.prehistoryDistinctPairs;
    }

    if (this.topology.appInstances === 0) {
      throw new Error('audience case needs at least one Application instance');
    }
    this.sql = this.requireSql();
    this.scheduleCase();
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /**
   * Preparation is a real setup barrier: the query index or the durable
   * projection is built from the seeded history before the measured clock.
   * The duration is a disclosed bulk formula (see the report): CPU work from
   * the catalog build coefficients plus bulk sequential storage writes. It is
   * never zero for a projection.
   */
  private prepDurationMs(): number {
    // The measured origin starts after both real setup stages would finish if
    // they ran concurrently; the barrier itself is enforced by task completion.
    const { workerCpuMs, sqlCpuMs, sqlDiskMs } = this.preparationWork();
    const criticalPath = Math.max(workerCpuMs, sqlCpuMs + sqlDiskMs);
    return Math.max(1, Math.ceil(criticalPath + 1));
  }

  private buildTopologyRuntime(): void {
    const sqlSize = this.topology;
    const rawBytes = this.base.provisionBytes;
    const indexBytes =
      this.topology.readPlan === 'projection'
        ? this.base.prehistoryDistinctPairs *
          this.model.catalog.storage.projectionPairBytes
        : this.model.level.dataset.prehistoryEvents *
          this.model.catalog.storage.queryIndexBytesPerEvent;
    // RAM residency (the resident query/projection structure plus the raw rows
    // that fit in memory) is separate from persistent disk occupancy, but both
    // start at the same seeded dataset and are never added twice.
    const residentBytes = rawBytes + indexBytes;
    this.sql = createInstance(
      this.scheduler,
      this.measuredStartMs,
      this.measuredEndMs,
      {
        nodeId: sqlSize.sqlId,
        kind: 'sql',
        instanceIndex: 0,
        label: this.labelOf(sqlSize.sqlId),
        cpuCores: sqlSize.sqlCores,
        nicLanes: sqlSize.sqlNicLanes,
        diskLanes: SQL_DISK_LANES,
        memoryBytes: sqlSize.sqlMemoryBytes,
        workingSetBytes: residentBytes,
        queueLimit: AUDIENCE_QUEUE_LIMITS.sqlWaiting,
        storageCapacityBytes: sqlSize.sqlDiskBytes,
      },
    );
    this.sql.storageUsedBytes = residentBytes;
    this.sql.storagePeakBytes = residentBytes;
    this.allInstances.push(this.sql);
    this.nodes.push({
      nodeId: this.sql.nodeId,
      kind: 'sql',
      label: this.sql.label,
      instances: [this.sql],
      crashEvents: 0,
      recoveryMs: null,
    });

    for (let slot = 0; slot < this.topology.appInstances; slot += 1) {
      const instance = createInstance(
        this.scheduler,
        this.measuredStartMs,
        this.measuredEndMs,
        {
          nodeId: this.topology.appId,
          kind: 'app',
          instanceIndex: slot,
          label: `${this.labelOf(this.topology.appId)} ${slot}`,
          cpuCores: this.model.catalog.components.app.cpuCoresPerInstance,
          nicLanes: this.model.catalog.components.app.nicGbitPerSecPerInstance,
          diskLanes: 0,
          memoryBytes:
            this.model.catalog.components.app.memoryGbPerInstance * 1_000_000_000,
          workingSetBytes: 64 * 1_024 * 1_024,
          queueLimit: AUDIENCE_QUEUE_LIMITS.appWaitingPerInstance,
          storageCapacityBytes: 0,
        },
      );
      this.appInstances.push(instance);
      this.allInstances.push(instance);
    }
    this.nodes.push({
      nodeId: this.topology.appId,
      kind: 'app',
      label: this.labelOf(this.topology.appId),
      instances: this.appInstances,
      crashEvents: 0,
      recoveryMs: null,
    });

    if (this.topology.lbId !== null) {
      this.lb = createInstance(
        this.scheduler,
        this.measuredStartMs,
        this.measuredEndMs,
        {
          nodeId: this.topology.lbId,
          kind: 'lb',
          instanceIndex: 0,
          label: this.labelOf(this.topology.lbId),
          cpuCores: LB_CORES,
          nicLanes: this.model.catalog.components.lb.capacityGbitPerSec,
          diskLanes: 0,
          memoryBytes: 1_000_000_000,
          workingSetBytes: 0,
          queueLimit: 4_096,
          storageCapacityBytes: 0,
        },
      );
      this.allInstances.push(this.lb);
      this.nodes.push({
        nodeId: this.lb.nodeId,
        kind: 'lb',
        label: this.lb.label,
        instances: [this.lb],
        crashEvents: 0,
        recoveryMs: null,
      });
    }

    if (this.topology.cacheId !== null) {
      this.cache = createInstance(
        this.scheduler,
        this.measuredStartMs,
        this.measuredEndMs,
        {
          nodeId: this.topology.cacheId,
          kind: 'cache',
          instanceIndex: 0,
          label: this.labelOf(this.topology.cacheId),
          cpuCores: this.model.catalog.components.cache.cpuCores,
          nicLanes: this.model.catalog.components.cache.nicGbitPerSec,
          diskLanes: 0,
          memoryBytes:
            this.model.catalog.components.cache.memoryGb * 1_000_000_000,
          workingSetBytes: AUDIENCE_CACHE_POLICY.entryBytes,
          queueLimit: AUDIENCE_QUEUE_LIMITS.cacheWaiting,
          storageCapacityBytes: 0,
        },
      );
      this.cache.memory.reserve('cache-entry-slot', AUDIENCE_CACHE_POLICY.entryBytes);
      this.allInstances.push(this.cache);
      this.nodes.push({
        nodeId: this.cache.nodeId,
        kind: 'cache',
        label: this.cache.label,
        instances: [this.cache],
        crashEvents: 0,
        recoveryMs: null,
      });
    }

    if (this.topology.workerId !== null) {
      for (let index = 0; index < this.topology.workerInstances; index += 1) {
        const instance = createInstance(
          this.scheduler,
          this.measuredStartMs,
          this.measuredEndMs,
          {
            nodeId: this.topology.workerId,
            kind: 'worker',
            instanceIndex: index,
            label: `${this.labelOf(this.topology.workerId)} ${index}`,
            cpuCores: this.model.catalog.components.worker.cpuCoresPerInstance,
            nicLanes: this.model.catalog.components.worker.nicGbitPerSecPerInstance,
            diskLanes: 0,
            memoryBytes:
              this.model.catalog.components.worker.memoryGbPerInstance *
              1_000_000_000,
            workingSetBytes:
              AUDIENCE_PROJECTION_POLICY.reorderBufferEvents *
              this.model.catalog.storage.projectionPairBytes,
            queueLimit: AUDIENCE_QUEUE_LIMITS.sqlWaiting,
            storageCapacityBytes: 0,
          },
        );
        this.workers.push(instance);
        this.allInstances.push(instance);
      }
      this.nodes.push({
        nodeId: this.topology.workerId,
        kind: 'worker',
        label: this.labelOf(this.topology.workerId),
        instances: this.workers,
        crashEvents: 0,
        recoveryMs: null,
      });
    }

    for (const edge of this.topology.edges) {
      this.edges.push(createEdge(edge.id, edge.from, edge.to, edge.role));
    }
  }

  private labelOf(nodeId: string): string {
    return this.topology.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
  }

  private requireSql(): InstanceRuntime {
    const sql = this.nodes.find((node) => node.kind === 'sql')?.instances[0];
    if (sql === undefined) {
      throw new Error('audience case has no SQL instance');
    }
    return sql;
  }

  // -------------------------------------------------------------------------
  // Challenge step engine
  // -------------------------------------------------------------------------

  get done(): boolean {
    return this.phaseState === 'done';
  }

  get nowMs(): number {
    return this.scheduler.nowMs;
  }

  /** Public phase required by the reusable challenge step engine. */
  get phase(): 'prepare' | 'run' | 'drain' | 'done' {
    return this.phaseState;
  }

  get completedRequests(): number {
    return this.ingest.succeeded + this.read.succeeded + this.ingest.failed + this.read.failed;
  }

  get plannedRequests(): number {
    return this.ingestTrace.count + this.readTrace.count;
  }

  get caseResult(): AudienceCaseResult | null {
    return this.resultValue;
  }

  /** Durable projection pair entries (exposed for invariant tests). */
  get durableProjectionPairs(): number {
    return this.projectionPairCount;
  }

  /** Bounded frames of this case; replaces the previous case's array. */
  frameSnapshot(): readonly AudienceTrafficFrame[] {
    return this.frames;
  }

  /**
   * Bounded frames recorded so far in this active case. Returns the internal
   * bounded array as readonly; no copy is made per simulation event, so a
   * caller polling this between `advance` slices stays cheap.
   */
  get liveFrames(): readonly AudienceTrafficFrame[] {
    return this.frames;
  }

  /**
   * Business time since this case's measured origin, clamped to the measured
   * window. Preparation is before the origin and therefore reports 0; drain
   * does not extend the measured clock.
   */
  get measuredElapsedMs(): number {
    const elapsed = this.scheduler.nowMs - this.measuredStartMs;
    return Math.min(
      this.measuredEndMs - this.measuredStartMs,
      Math.max(0, elapsed),
    );
  }

  advance(maxEvents = Number.POSITIVE_INFINITY): {
    processedEvents: number;
    exhausted: boolean;
  } {
    if (this.phaseState === 'done') {
      return { processedEvents: 0, exhausted: false };
    }
    if (this.cancelled) {
      this.finalize('cancelled');
      return { processedEvents: 0, exhausted: false };
    }
    let budget = maxEvents;
    let processed = 0;
    let exhausted = false;

    const runPhase = (untilMs: number): boolean => {
      const result = this.scheduler.runUntil(untilMs, budget);
      processed += result.processedEvents;
      this.processedEvents = this.scheduler.processedEvents;
      budget -= result.processedEvents;
      exhausted = result.exhausted;
      if (this.processedEvents > this.maxEvents) {
        this.incompleteReasons.push(
          `Event limit ${this.maxEvents} was exhausted.`,
        );
        this.finalize('incomplete');
        return false;
      }
      return !result.exhausted;
    };

    if (this.phaseState === 'prepare') {
      if (!runPhase(this.measuredStartMs)) {
        return { processedEvents: processed, exhausted };
      }
      if (!this.prepDone || this.prepFailed) {
        // The setup barrier did not complete inside its budget.
        this.incompleteReasons.push(
          'Preparation did not finish before the measured origin.',
        );
        this.finalize('incomplete');
        return { processedEvents: processed, exhausted };
      }
      this.phaseState = 'run';
    }
    if (this.phaseState === 'run') {
      if (!runPhase(this.measuredEndMs)) {
        return { processedEvents: processed, exhausted };
      }
      this.phaseState = 'drain';
    }
    if (this.phaseState === 'drain') {
      // Always advance the same logical clock to the drain end, even when no
      // request is left: the drain phase, the last traffic frame and the
      // reported run window must not depend on how the caller slices work.
      if (!runPhase(this.drainEndMs)) {
        return { processedEvents: processed, exhausted };
      }
      if (this.live.size > 0) {
        this.incompleteReasons.push(
          `${this.live.size} requests were still pending after the bounded drain.`,
        );
      }
      this.finalize(
        this.incompleteReasons.length > 0 ? 'incomplete' : 'complete',
      );
    }
    return { processedEvents: processed, exhausted };
  }

  cancel(): void {
    if (this.phaseState === 'done') {
      return;
    }
    this.cancelled = true;
    this.incompleteReasons.push('Case cancelled by the caller.');
    for (const handle of [...this.tickHandles, ...this.probeHandles, ...this.workerPollHandles]) {
      handle.cancel();
    }
    for (const request of this.live) {
      request.task?.cancel();
      request.deadlineHandle?.cancel();
    }
    this.live.clear();
    this.finalize('cancelled');
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private scheduleCase(): void {
    this.schedulePreparation();
    const offset = this.measuredStartMs;
    for (let index = 0; index < this.ingestTrace.count; index += 1) {
      const atMs = offset + (this.ingestTrace.timesMs[index] ?? 0);
      this.scheduler.schedule(atMs, () => this.admitIngest(index), 3);
    }
    for (let index = 0; index < this.readTrace.count; index += 1) {
      const atMs = offset + (this.readTrace.timesMs[index] ?? 0);
      this.scheduler.schedule(atMs, () => this.admitRead(index), 3);
    }
    for (let second = 1; second <= this.durationBuckets; second += 1) {
      const atMs = offset + second * 1_000;
      this.tickHandles.push(
        this.scheduler.schedule(atMs, () => this.closeSecond(second), 2),
      );
    }
    // Drain-phase frames are bounded and explicit.
    this.tickHandles.push(
      this.scheduler.schedule(this.drainEndMs, () => this.closeDrain(), 2),
    );
    if (this.topology.lbId !== null) {
      for (let slot = 0; slot < this.appInstances.length; slot += 1) {
        for (
          let atMs = offset + AUDIENCE_HEALTH_POLICY.probeStartAtMs;
          atMs < this.drainEndMs;
          atMs += AUDIENCE_HEALTH_POLICY.intervalMs
        ) {
          const instance = slot;
          this.probeHandles.push(
            this.scheduler.schedule(
              atMs,
              () => this.launchProbe(instance),
              3,
            ),
          );
        }
      }
    }
    if (this.topology.workerId !== null) {
      for (let index = 0; index < this.workers.length; index += 1) {
        this.schedulePoll(index, offset);
      }
    }
    if (
      this.spec.kind === 'app-instance-failure' &&
      this.targetSlot !== null &&
      this.spec.fault !== null
    ) {
      const crashAt = offset + this.spec.fault.crashAtMs;
      const restartAt = crashAt + this.spec.fault.downMs;
      const readyAt = restartAt + this.spec.fault.bootMs;
      this.scheduler.schedule(crashAt, () => this.applyCrash(crashAt), -10);
      this.scheduler.schedule(
        restartAt,
        () => this.applyRestart(restartAt),
        -5,
      );
      this.scheduler.schedule(readyAt, () => this.markBootComplete(), -5);
    }
  }

  /**
   * The setup barrier charges CPU and IO separately and, for a projection,
   * runs the build scan on a Worker while SQL persists the state. Disk work is
   * never turned into core time. Storage occupancy already includes the index
   * or projection state (set when the instance is built); setup only performs
   * and bills the one-time write.
   */
  private schedulePreparation(): void {
    const sql = this.sql;
    const { workerCpuMs, sqlCpuMs, sqlDiskMs, writtenBytes } =
      this.preparationWork();
    sql.storageWrittenBytes += writtenBytes;
    sql.ioWriteOperations += 1;
    const stages: { completed: number; total: number } = {
      completed: 0,
      total: 1 + (sqlDiskMs > 0 ? 1 : 0) + (workerCpuMs > 0 ? 1 : 0),
    };
    const complete = (): void => {
      stages.completed += 1;
      if (stages.completed >= stages.total) {
        this.prepDone = true;
      }
    };
    this.prepHandles.push(
      this.submitTask(sql, {
        id: 'audience-preparation-sql-cpu',
        resources: [{ id: sql.cpuId, units: 1 }],
        durationMs: sqlCpuMs,
        onFinish: (result) => {
          if (result.status === 'completed') {
            complete();
          } else {
            this.prepFailed = true;
            this.incompleteReasons.push('Preparation SQL CPU work did not complete.');
          }
        },
      }),
    );
    if (sqlDiskMs > 0) {
      this.prepHandles.push(
        this.submitTask(sql, {
          id: 'audience-preparation-sql-io',
          resources: [{ id: sql.diskId ?? sql.cpuId, units: 1 }],
          durationMs: sqlDiskMs,
          onFinish: (result) => {
            if (result.status === 'completed') {
              complete();
            } else {
              this.prepFailed = true;
              this.incompleteReasons.push('Preparation SQL IO work did not complete.');
            }
          },
        }),
      );
    }
    if (workerCpuMs > 0) {
      const worker = this.workers[0];
      if (worker !== undefined) {
        this.prepHandles.push(
          this.submitTask(worker, {
            id: 'audience-preparation-worker-build',
            resources: [{ id: worker.cpuId, units: 1 }],
            durationMs: workerCpuMs,
            onFinish: (result) => {
              if (result.status === 'completed') {
                complete();
              } else {
                this.prepFailed = true;
                this.incompleteReasons.push(
                  'Preparation Worker build did not complete.',
                );
              }
            },
          }),
        );
      } else {
        complete();
      }
    }
  }

  private preparationWork(): {
    workerCpuMs: number;
    sqlCpuMs: number;
    sqlDiskMs: number;
    writtenBytes: number;
  } {
    const work = this.model.catalog.work;
    const storage = this.model.catalog.storage;
    const events = this.model.level.dataset.prehistoryEvents;
    const bulk = this.model.catalog.storage.bulkBuildBytesPerMs;
    if (this.topology.readPlan === 'projection') {
      // Bulk build policy: the projection state is the durable distinct-pair
      // last-seen structure, built by a Worker and persisted by SQL, with no
      // materialized per-event outbox rows for the seeded prehistory.
      const stateBytes =
        this.base.prehistoryDistinctPairs * storage.projectionPairBytes;
      return {
        workerCpuMs: events * work.projectionBuildCoreMsPerEvent,
        sqlCpuMs:
          this.base.prehistoryDistinctPairs *
          work.projectionApplySqlCoreMsPerEvent,
        sqlDiskMs: stateBytes / bulk,
        writtenBytes: stateBytes,
      };
    }
    const indexBytes = events * storage.queryIndexBytesPerEvent;
    return {
      workerCpuMs: 0,
      sqlCpuMs: events * work.queryIndexBuildCoreMsPerEvent,
      sqlDiskMs: indexBytes / bulk,
      writtenBytes: indexBytes,
    };
  }

  private submitTask(
    instance: InstanceRuntime,
    request: SubmitTaskRequest,
  ): TaskHandle {
    instance.submitted += 1;
    let started = false;
    let queued = false;
    const onStart = request.onStart;
    const onFinish = request.onFinish;
    const handle = instance.kernel.submit({
      ...request,
      onStart: (atMs) => {
        started = true;
        // The task left the waiting queue only if it actually entered one; a
        // task that starts immediately never waited.
        if (queued) {
          instance.queue.end(atMs);
        }
        instance.active += 1;
        if (instance.active > instance.activePeak) {
          instance.activePeak = instance.active;
        }
        onStart?.(atMs);
      },
      onFinish: (result: TaskResult) => {
        if (started) {
          instance.active = Math.max(0, instance.active - 1);
        } else if (queued) {
          // Rejected / timed out / cancelled while still queued: it really did
          // occupy a waiting slot until this instant.
          instance.queue.end(result.endedAtMs);
        }
        if (
          result.startedAtMs !== null &&
          result.enqueuedAtMs >= this.measuredStartMs &&
          result.enqueuedAtMs < this.measuredEndMs
        ) {
          // Wait samples are scoped to tasks admitted during the measured
          // window, matching the adjacent CPU/disk/RAM/queue metrics.
          const wait = Math.max(0, result.startedAtMs - result.enqueuedAtMs);
          instance.waitTotalMs += wait;
          if (wait > instance.waitMaxMs) {
            instance.waitMaxMs = wait;
          }
          instance.waitSamples += 1;
        }
        if (result.status === 'completed') {
          instance.completed += 1;
        } else if (result.status === 'rejected') {
          instance.rejected += 1;
        } else if (result.status === 'timeout') {
          instance.timedOut += 1;
        } else {
          instance.interrupted += 1;
        }
        onFinish(result);
      },
    });
    if (handle.accepted && !started) {
      // The task is really waiting now; rejected submissions never queued, so
      // the depth and peak never exceed the configured queue limit.
      queued = true;
      instance.queue.begin(this.scheduler.nowMs);
    }
    return handle;
  }

  private scheduleAfter(delayMs: number, action: () => void, priority = 0): void {
    this.scheduler.schedule(this.scheduler.nowMs + Math.max(0, delayMs), action, priority);
  }

  // -------------------------------------------------------------------------
  // Requests: admission, retries, settlement
  // -------------------------------------------------------------------------

  /**
   * Critical offer cohort: exactly `[criticalStart, criticalEnd)` in case
   * clock milliseconds. A request is grouped by its offer instant, never by
   * when it later settled.
   */
  private isCritical(atMs: number): boolean {
    if (this.criticalStartMs === null || this.criticalEndMs === null) {
      return false;
    }
    return atMs >= this.criticalStartMs && atMs < this.criticalEndMs;
  }

  /** Business time: milliseconds since this case's measured origin. */
  private relNow(): number {
    return this.scheduler.nowMs - this.measuredStartMs;
  }

  private bucketOf(atMs: number): number {
    return Math.floor((atMs - this.measuredStartMs) / 1_000);
  }

  private admitIngest(eventIndex: number): void {
    if (this.phaseState === 'done' || this.cancelled) {
      return;
    }
    const now = this.scheduler.nowMs;
    const request: RequestRecord = {
      id: this.nextRequestId,
      operation: 'ingest',
      offeredAtMs: now,
      deadlineAtMs: now + AUDIENCE_REQUEST_DEADLINE_MS,
      critical: this.isCritical(now),
      eventIndex,
      pairKey: this.ingestTrace.pairs[eventIndex] ?? 0,
      stream: this.ingestTrace.streams[eventIndex] ?? 0,
      user: this.ingestTrace.users[eventIndex] ?? 0,
      attempts: 0,
      attemptToken: 0,
      retries: 0,
      retryActive: false,
      backend: -1,
      task: null,
      deadlineHandle: null,
      fillWaiter: false,
      committed: false,
      commitSequence: null,
      acknowledged: false,
      answered: false,
      uncertain: false,
      resolvedUncertain: false,
      audited: false,
      servedFromCache: null,
      sqlAccepted: false,
      countedUnacked: false,
      connectedSlot: -1,
      crashedInFlight: false,
      settled: false,
      settledAtMs: 0,
      outcome: null,
      capacityId: null,
      served: null,
      capturedAsOfMs: 0,
      capturedCursor: 0,
      capturedRows: 0,
      lastFailureAtMs: 0,
    };
    this.nextRequestId += 1;
    this.live.add(request);
    this.liveCount += 1;
    this.offer(request);
    // The ingest acknowledgement has the same logical deadline as a read.
    request.deadlineHandle = this.scheduler.schedule(
      request.deadlineAtMs,
      () => this.onDeadline(request),
      1,
    );
    this.startIngestAttempt(request);
  }

  private admitRead(index: number): void {
    if (this.phaseState === 'done' || this.cancelled) {
      return;
    }
    const now = this.scheduler.nowMs;
    const request: RequestRecord = {
      id: this.nextRequestId,
      operation: 'read',
      offeredAtMs: now,
      deadlineAtMs: now + AUDIENCE_REQUEST_DEADLINE_MS,
      critical: this.isCritical(now),
      eventIndex: index,
      pairKey: 0,
      stream: 0,
      user: 0,
      attempts: 0,
      attemptToken: 0,
      retries: 0,
      retryActive: false,
      backend: -1,
      task: null,
      deadlineHandle: null,
      fillWaiter: false,
      committed: false,
      commitSequence: null,
      acknowledged: false,
      answered: false,
      uncertain: false,
      resolvedUncertain: false,
      audited: false,
      servedFromCache: null,
      sqlAccepted: false,
      countedUnacked: false,
      connectedSlot: -1,
      crashedInFlight: false,
      settled: false,
      settledAtMs: 0,
      outcome: null,
      capacityId: null,
      served: null,
      capturedAsOfMs: 0,
      capturedCursor: 0,
      capturedRows: 0,
      lastFailureAtMs: 0,
    };
    this.nextRequestId += 1;
    this.live.add(request);
    this.liveCount += 1;
    this.offer(request);
    request.deadlineHandle = this.scheduler.schedule(
      request.deadlineAtMs,
      () => this.onDeadline(request),
      1,
    );
    this.startReadAttempt(request);
  }

  /**
   * Every request belongs to the whole-case cohort. A request offered inside
   * the critical window additionally belongs to the critical cohort; the whole
   * cohort is never reduced to "non-critical".
   */
  private cohortsFor(request: RequestRecord): OperationAccumulator[] {
    const whole = request.operation === 'ingest' ? this.ingest : this.read;
    if (!request.critical) {
      return [whole];
    }
    const critical =
      request.operation === 'ingest' ? this.criticalIngest : this.criticalRead;
    return critical === null ? [whole] : [whole, critical];
  }

  private offer(request: RequestRecord): void {
    for (const accumulator of this.cohortsFor(request)) {
      accumulator.offered += 1;
      accumulator.bytesOffered += this.responseBytes(request.operation);
      accumulator.buckets.offer(this.bucketOf(request.offeredAtMs));
      accumulator.pending += 1;
    }
  }



  /** Records the open connection for a dispatched attempt. */
  private connect(request: RequestRecord, slot: number): void {
    if (request.connectedSlot === slot) {
      return;
    }
    this.disconnect(request);
    request.connectedSlot = slot;
    const set = this.connections.get(slot) ?? new Set<RequestRecord>();
    set.add(request);
    this.connections.set(slot, set);
  }

  /** Closes the connection when the attempt settles or is superseded. */
  private disconnect(request: RequestRecord): void {
    if (request.connectedSlot < 0) {
      return;
    }
    this.connections.get(request.connectedSlot)?.delete(request);
    request.connectedSlot = -1;
  }

  private responseBytes(operation: Operation): number {
    return operation === 'ingest'
      ? this.model.catalog.network.ingestAckBytes
      : this.model.catalog.network.rankingResponseBytes;
  }

  private serializationMs(bytes: number): number {
    return (bytes * 8) / 1_000_000;
  }

  private transferSeq = 0;

  /**
   * Internal NIC transfer not owned by a client request (a cache fill, a worker
   * claim/apply). It reserves a NIC lane for the byte serialization time and
   * fires the callback after propagation, without touching request state.
   */
  private submitInternalTransfer(
    instance: InstanceRuntime,
    bytes: number,
    propagationMs: number,
    operation: 'ingest' | 'read' | 'projection',
    role: AudienceLinkRole,
    onDelivered: () => void,
    onFailure: (status: string) => void,
  ): void {
    instance.netOfferedBytes += bytes;
    this.observeEdge(operation, bytes, false, role);
    this.submitTask(instance, {
      id: `net-int-${this.transferSeq}`,
      resources: [{ id: instance.nicId, units: 1 }],
      durationMs: this.serializationMs(bytes),
      onFinish: (result) => {
        if (result.status === 'completed') {
          instance.netDeliveredBytes += bytes;
          this.deliverEdge(role, bytes);
          this.scheduleAfter(propagationMs, onDelivered, 0);
          return;
        }
        onFailure(result.status);
      },
    });
    this.transferSeq += 1;
  }

  /** Records successful delivery on the graph link for the given role. */
  private deliverEdge(role: AudienceLinkRole, bytes: number): void {
    const edge = this.edges.find((item) => item.role === role);
    if (edge !== undefined) {
      edge.bytesDelivered += bytes;
    }
  }

  /**
   * One real transfer stage: the payload occupies one lane of the instance's
   * kernel NIC resource for exactly its byte serialization time, queued behind
   * other transfers on the same NIC (a level-owned adapter over the unchanged
   * shared kernel, so concurrency and the measured-window integrals come from
   * the kernel, not custom counters). The receiver observes the bytes only
   * after the transfer completes plus propagation; a crash or deadline in
   * between still matters.
   *
   * Node/link `bytesDelivered` increments when the sender finishes serializing
   * the payload off its NIC, not when the client receives it: the receiver-side
   * callback (and the logical request's success) still fire only after the
   * propagation delay. This keeps delivery counters a "sent by this hop"
   * measure while a deadline or crash during propagation still fails the
   * operation.
   */
  private submitTransfer(
    request: RequestRecord,
    token: number,
    instance: InstanceRuntime,
    bytes: number,
    propagationMs: number,
    role: AudienceLinkRole,
    operation: Operation,
    onDelivered: () => void,
  ): void {
    instance.netOfferedBytes += bytes;
    // Each hop offers bytes exactly once and delivers them exactly once on its
    // graph link, so delivered never exceeds offered.
    this.observeEdge(operation, bytes, false, role);
    if (instance.kind === 'app') {
      instance.owned.add(request);
    }
    request.task = this.submitTask(instance, {
      id: `net-${request.id}-${this.transferSeq}`,
      resources: [{ id: instance.nicId, units: 1 }],
      durationMs: this.serializationMs(bytes),
      onFinish: (result) => {
        if (instance.kind === 'app') {
          instance.owned.delete(request);
        }
        if (request.settled || request.attemptToken !== token) {
          return;
        }
        if (result.status === 'completed') {
          instance.netDeliveredBytes += bytes;
          this.deliverEdge(role, bytes);
          this.scheduleAfter(propagationMs, onDelivered, 0);
          return;
        }
        this.onTransportFailure(request, this.scheduler.nowMs, 'nic-transfer-failed');
      },
    });
    this.transferSeq += 1;
  }

  /** Chooses a physical Application slot with the routing policy in force. */
  private routeTo(lbKnownOnly: boolean, exclude: number): number {
    if (this.topology.directPath) {
      // A direct Users -> Application path always targets physical slot 0;
      // spare instances are not magically routed.
      return 0;
    }
    const ready: number[] = [];
    for (let slot = 0; slot < this.appInstances.length; slot += 1) {
      const instance = this.appInstances[slot];
      if (instance === undefined) {
        continue;
      }
      if (lbKnownOnly && !instance.lbReady) {
        continue;
      }
      if (!lbKnownOnly && !instance.processUp) {
        continue;
      }
      ready.push(slot);
    }
    if (ready.length === 0) {
      return -1;
    }
    const candidates =
      exclude >= 0 && ready.length > 1
        ? ready.filter((slot) => slot !== exclude)
        : ready;
    const pool = candidates.length > 0 ? candidates : ready;
    const index = this.lbPointer % pool.length;
    this.lbPointer = (this.lbPointer + 1) % Math.max(1, pool.length);
    return pool[index] ?? pool[0] ?? -1;
  }

  /**
   * One logical attempt starts at the client. The request reaches the entry
   * point only after the fixed client hop, which is scheduled as a real causal
   * event, so resource service can never start earlier than the network allows.
   */
  private startIngestAttempt(request: RequestRecord): void {
    if (request.settled) {
      return;
    }
    const now = this.scheduler.nowMs;
    if (now >= request.deadlineAtMs) {
      this.settle(request, 'timeout', now, 'deadline-exceeded');
      return;
    }
    request.attempts += 1;
    request.attemptToken += 1;
    const token = request.attemptToken;
    // The client offers the request on the ingress/traffic link; the entry
    // point receives it after the fixed hop (no Users NIC is modelled).
    this.observeEdge(
      'ingest',
      this.model.catalog.network.ingestRequestBytes,
      false,
      this.topology.directPath ? 'traffic' : 'ingress',
    );
    this.scheduleAfter(
      this.model.catalog.network.clientRttMs / 2,
      () => {
        if (request.settled || request.attemptToken !== token) {
          return;
        }
        this.deliverEdge(
          this.topology.directPath ? 'traffic' : 'ingress',
          this.model.catalog.network.ingestRequestBytes,
        );
        this.dispatchIngestAttempt(request, token);
      },
      0,
    );
  }

  private dispatchIngestAttempt(request: RequestRecord, token: number): void {
    const now = this.scheduler.nowMs;
    if (now >= request.deadlineAtMs) {
      this.settle(request, 'timeout', now, 'deadline-exceeded');
      return;
    }
    const slot = this.routeTo(true, request.backend);
    if (slot < 0) {
      this.settle(request, 'errored', now, 'no-ready-backend');
      return;
    }
    request.backend = slot;
    this.connect(request, slot);
    const app = this.appInstances[slot];
    if (app === undefined) {
      this.settle(request, 'errored', now, 'missing-backend');
      return;
    }
    if (!app.processUp) {
      // A new attempt to an already dead process waits for the fixed connect
      // timeout; the connection was never established.
      const timeoutMs = AUDIENCE_FAULT_CONNECTION_POLICY.newAttemptToDeadProcessTimeoutMs;
      this.scheduleAfter(
        timeoutMs,
        () => {
          if (request.settled || request.attemptToken !== token) {
            return;
          }
          this.onTransportFailure(request, this.scheduler.nowMs, 'connect-timeout');
        },
        1,
      );
      return;
    }
    if (this.lb !== null) {
      this.submitLbIngest(request, token, app);
      return;
    }
    this.appIngestStage(request, token, app);
  }

  /** Managed Load Balancer request work: real CPU, then a sender NIC hop. */
  private submitLbIngest(
    request: RequestRecord,
    token: number,
    app: InstanceRuntime,
  ): void {
    const lb = this.lb;
    if (lb === null) {
      this.appIngestStage(request, token, app);
      return;
    }
    const bytes = this.model.catalog.network.ingestRequestBytes;
    request.task = this.submitTask(lb, {
      id: `ingest-lb-${request.id}-${request.attempts}`,
      resources: [{ id: lb.cpuId, units: 1 }],
      durationMs: this.model.catalog.work.lbRequestCoreMs,
      onFinish: (result) => {
        if (request.settled || request.attemptToken !== token) {
          return;
        }
        if (result.status === 'completed') {
          const backend = this.appInstances[request.backend];
          if (backend === undefined || !backend.processUp) {
            this.onTransportFailure(request, this.scheduler.nowMs, 'backend-lost');
            return;
          }
          // The Load Balancer forwards the request over its NIC to the backend.
          this.submitTransfer(
            request,
            token,
            lb,
            bytes,
            this.model.catalog.network.internalOneWayMs,
            'balance',
            'ingest',
            () => {
              if (request.settled || request.attemptToken !== token) {
                return;
              }
              this.appIngestStage(request, token, backend);
            },
          );
          return;
        }
        if (result.status === 'rejected') {
          this.settle(request, 'rejected', this.scheduler.nowMs, 'lb-queue-full');
          return;
        }
        this.onTransportFailure(request, this.scheduler.nowMs, 'lb-failure');
      },
    });
  }

  private appIngestStage(
    request: RequestRecord,
    token: number,
    app: InstanceRuntime,
  ): void {
    const work = this.model.catalog.work;
    const bytes = this.model.catalog.network.ingestRequestBytes;
    app.owned.add(request);
    request.task = this.submitTask(app, {
      id: `ingest-a-${request.id}-${request.attempts}`,
      resources: [{ id: app.cpuId, units: 1 }],
      durationMs: work.appIngestCoreMs,
      onFinish: (result) => {
        app.owned.delete(request);
        if (request.settled || request.attemptToken !== token) {
          return;
        }
        if (result.status === 'completed') {
          // The Application forwards the event to SQL over its NIC.
          this.submitTransfer(
            request,
            token,
            app,
            bytes,
            this.model.catalog.network.internalOneWayMs,
            'primary',
            'ingest',
            () => {
              if (request.settled || request.attemptToken !== token) {
                return;
              }
              this.submitIngestSql(request, token);
            },
          );
          return;
        }
        if (result.status === 'rejected') {
          this.settle(request, 'rejected', this.scheduler.nowMs, 'app-queue-full');
          return;
        }
        this.onTransportFailure(
          request,
          this.scheduler.nowMs,
          result.status === 'timeout' ? 'stage-timeout' : 'app-work-lost',
        );
      },
    });
  }

  private submitIngestSql(request: RequestRecord, token: number): void {
    if (request.settled || request.attemptToken !== token) {
      return;
    }
    if (this.scheduler.nowMs >= request.deadlineAtMs) {
      this.settle(request, 'timeout', this.scheduler.nowMs, 'deadline-exceeded');
      return;
    }
    const sql = this.sql;
    const work = this.model.catalog.work;
    const projection = this.topology.readPlan === 'projection';
    const payload = this.payloadFor(request);
    // Immutable identity: the accepted transaction is bound to this attempt's
    // token, backend and payload and never changes when a retry overwrites the
    // request's mutable fields.
    const txn: SqlTransaction = {
      token,
      backend: request.backend,
      pairKey: payload.pairKey,
      stream: payload.stream,
    };
    request.sqlAccepted = true;
    const cpuMs =
      work.sqlAppendCoreMsPerEvent +
      (projection ? work.sqlAppendCoreMsPerEvent * 0.5 : 0);
    this.submitTask(sql, {
      id: `ingest-s-${request.id}-${request.attempts}`,
      resources: [{ id: sql.cpuId, units: 1 }],
      durationMs: cpuMs,
      onFinish: (result) => {
        if (result.status === 'completed') {
          // Accepted SQL work always finishes its durable stages, even after a
          // crash or a client deadline; only the reply delivery is conditional.
          this.submitIngestDisk(request, txn);
          return;
        }
        if (request.settled || request.attemptToken !== txn.token) {
          return;
        }
        if (result.status === 'rejected') {
          this.settle(request, 'rejected', this.scheduler.nowMs, 'sql-queue-full');
          return;
        }
        if (result.status === 'timeout') {
          this.settle(request, 'timeout', this.scheduler.nowMs, 'stage-timeout');
          return;
        }
        this.settle(request, 'errored', this.scheduler.nowMs, 'sql-work-lost');
      },
    });
  }

  private submitIngestDisk(request: RequestRecord, txn: SqlTransaction): void {
    const sql = this.sql;
    const work = this.model.catalog.work;
    const durationMs = work.sqlAppendDiskMsPerEvent;
    this.submitTask(sql, {
      id: `ingest-d-${request.id}-${request.attempts}`,
      resources: [{ id: sql.diskId ?? sql.cpuId, units: 1 }],
      durationMs,
      onFinish: (result) => {
        if (result.status !== 'completed') {
          if (request.settled || request.attemptToken !== txn.token) {
            return;
          }
          if (result.status === 'rejected') {
            this.settle(request, 'rejected', this.scheduler.nowMs, 'sql-queue-full');
          } else {
            this.settle(request, 'timeout', this.scheduler.nowMs, 'stage-timeout');
          }
          return;
        }
        sql.ioWriteOperations += 1;
        this.commitTransaction(request, txn);
      },
    });
  }

  /** Durable SQL transaction: event row + (projection) outbox job, idempotent. */
  private commitTransaction(request: RequestRecord, txn: SqlTransaction): void {
    const now = this.relNow();
    const existing = this.committedPayload.get(request.eventIndex);
    if (existing !== undefined) {
      if (existing.pairKey !== txn.pairKey) {
        this.payloadConflicts += 1;
        if (!request.settled && txn.token === request.attemptToken) {
          this.settle(request, 'errored', now, 'payload-conflict');
        }
        return;
      }
      this.idempotentReplays += 1;
      this.acknowledgeIngest(request, existing.sequence, existing.timeMs, txn);
      return;
    }
    this.commitHighWater += 1;
    const sequence = this.commitHighWater;
    this.appendLog(now, txn.pairKey, txn.stream);
    this.committedPayload.set(request.eventIndex, {
      sequence,
      timeMs: now,
      pairKey: txn.pairKey,
    });
    this.ingestCommitted += 1;
    request.committed = true;
    request.commitSequence = sequence;
    this.servedState.applyCommit(txn.pairKey, txn.stream, now);
    // The audit index is a separate structure fed by the same durable commits;
    // it is never derived from a served response.
    this.auditIndex.applyCommit(txn.pairKey, now);
    const sql = this.sql;
    const writeBytes =
      this.model.catalog.storage.rawEventBytes +
      (this.topology.readPlan === 'projection'
        ? this.model.catalog.storage.outboxJobBytes
        : this.model.catalog.storage.queryIndexBytesPerEvent);
    sql.storageWrittenBytes += writeBytes;
    sql.storageUsedBytes += writeBytes;
    sql.storagePeakBytes = Math.max(sql.storagePeakBytes, sql.storageUsedBytes);
    if (this.topology.readPlan === 'projection') {
      this.outbox.push({
        sequence,
        timeMs: now,
        pairKey: txn.pairKey,
        stream: txn.stream,
      });
    }
    if (request.crashedInFlight) {
      // The Application work was lost with the process while the durable SQL
      // transaction still committed: exactly the lost-ACK case.
      this.commitsSurvivedCrash += 1;
    }
    this.highWaterExceededGuard(sequence);
    if (request.settled) {
      // The client gave up after SQL accepted the work: the durable commit is
      // real, the acknowledgement is not.
      this.countCommittedUnacked(request);
      return;
    }
    this.acknowledgeIngest(request, sequence, now, txn);
  }

  /**
   * Test-only payload mutation hook: the internal model can make a retry carry
   * a different payload for the same immutable event id, which must produce a
   * conflict with no effect.
   */
  private payloadFor(request: RequestRecord): {
    pairKey: number;
    stream: number;
  } {
    if (
      this.testPayloadConflictOnRetry &&
      request.retries > 0 &&
      (this.testPayloadConflictEvent < 0 ||
        this.testPayloadConflictEvent === request.eventIndex)
    ) {
      const stream = (request.stream + 1) % this.streams;
      const user = request.user;
      return { pairKey: user * this.streams + stream, stream };
    }
    return { pairKey: request.pairKey, stream: request.stream };
  }

  private testPayloadConflictOnRetry = false;
  private testPayloadConflictEvent = -1;

  /**
   * Internal-test hook; never reachable from the public options. With no
   * argument every retry carries a mutated payload, which must be a conflict
   * with no second effect.
   */
  setTestPayloadConflict(eventIndex = -1): void {
    this.testPayloadConflictOnRetry = true;
    this.testPayloadConflictEvent = eventIndex;
  }

  private highWaterExceededGuard(sequence: number): void {
    if (sequence > this.base.prehistoryEvents + this.ingestTrace.count + 16) {
      throw new Error('commit sequence exceeded the offered trace');
    }
  }

  private appendLog(atMs: number, pairKey: number, stream: number): void {
    if (this.log.count >= this.log.timesMs.length) {
      const grownTimes = new Float64Array(this.log.timesMs.length * 2);
      grownTimes.set(this.log.timesMs);
      (this.log as { timesMs: Float64Array }).timesMs = grownTimes;
      const grownPairs = new Int32Array(this.log.pairs.length * 2);
      grownPairs.set(this.log.pairs);
      (this.log as { pairs: Int32Array }).pairs = grownPairs;
      const grownStreams = new Uint8Array(this.log.streams.length * 2);
      grownStreams.set(this.log.streams);
      (this.log as { streams: Uint8Array }).streams = grownStreams;
    }
    this.log.timesMs[this.log.count] = atMs;
    this.log.pairs[this.log.count] = pairKey;
    this.log.streams[this.log.count] = stream;
    (this.log as { count: number }).count = this.log.count + 1;
  }

  private acknowledgeIngest(
    request: RequestRecord,
    sequence: number,
    _commitTimeMs: number,
    txn: SqlTransaction,
  ): void {
    if (request.settled) {
      this.countCommittedUnacked(request);
      return;
    }
    if (txn.token !== request.attemptToken) {
      // The durable commit is already recorded; this reply belongs to an older
      // attempt superseded by a retry, so its delivery is simply discarded.
      return;
    }
    const token = txn.token;
    const app = this.appInstances[txn.backend];
    const throughLb = !this.topology.directPath;
    const ackBytes = this.model.catalog.network.ingestAckBytes;
    const internal = this.model.catalog.network.internalOneWayMs;
    const client = this.model.catalog.network.clientRttMs / 2;
    if (app === undefined) {
      this.settle(request, 'errored', this.scheduler.nowMs, 'missing-backend');
      return;
    }
    if (!app.processUp) {
      // The durable commit survived, but the Application that owned the
      // connection is already gone: the acknowledgement is lost and the client
      // must retry with the same id.
      this.registerUncertain(request);
      this.scheduleAfter(
        AUDIENCE_RETRY_POLICY.backoffMs,
        () => this.retryAfterLostAck(request, txn.token),
        0,
      );
      return;
    }
    const finalize = (): void => {
      if (request.settled || request.attemptToken !== token) {
        return;
      }
      const backend = this.appInstances[txn.backend];
      if (backend !== app || !app.processUp) {
        // The durable commit survived, but the Application that owned the
        // connection is gone: the client cannot know the outcome.
        this.registerUncertain(request);
        this.scheduleAfter(
          AUDIENCE_RETRY_POLICY.backoffMs,
          () => this.retryAfterLostAck(request, txn.token),
          0,
        );
        return;
      }
      request.acknowledged = true;
      request.commitSequence = sequence;
      this.acknowledgedEventIds.add(request.eventIndex);
      this.billedBytes += ackBytes;
      this.settle(request, 'succeeded', this.scheduler.nowMs, null);
    };
    // SQL -> Application, then Application -> (Load Balancer) -> client; each
    // hop is a real serialization stage followed by propagation.
    this.submitTransfer(request, token, this.sql, ackBytes, internal, 'primary', 'ingest', () => {
      if (request.settled || request.attemptToken !== token) {
        return;
      }
      if (throughLb && this.lb !== null) {
        const lb = this.lb;
        this.submitTransfer(request, token, app, ackBytes, internal, 'balance', 'ingest', () => {
          if (request.settled || request.attemptToken !== token) {
            return;
          }
          this.submitTransfer(request, token, lb, ackBytes, client, 'ingress', 'ingest', () => {
            finalize();
          });
        });
        return;
      }
      this.submitTransfer(request, token, app, ackBytes, client, 'traffic', 'ingest', () => {
        finalize();
      });
    });
  }

  private countCommittedUnacked(request: RequestRecord): void {
    if (request.countedUnacked) {
      return;
    }
    request.countedUnacked = true;
    this.committedUnacknowledged += 1;
  }

  private retryAfterLostAck(request: RequestRecord, token: number): void {
    if (request.settled || request.attemptToken !== token) {
      return;
    }
    this.registerUncertain(request);
    this.scheduleRetry(request, 'lost-ack');
  }

  private registerUncertain(request: RequestRecord): void {
    if (request.uncertain) {
      return;
    }
    request.uncertain = true;
    this.unknownCommitOutcomes += 1;
  }

  private onTransportFailure(
    request: RequestRecord,
    atMs: number,
    reason: string,
  ): void {
    if (request.settled) {
      return;
    }
    request.task = null;
    request.lastFailureAtMs = atMs;
    // Only a connection drop while SQL work may already be committed makes the
    // durable outcome unknown. A connect timeout or an App-stage loss before
    // SQL acceptance is a known failure with a bounded retry, not an unknown
    // commit.
    if (request.operation === 'ingest' && request.sqlAccepted) {
      this.registerUncertain(request);
    }
    this.scheduleRetry(request, reason);
  }

  /**
   * The single guarded retry transition. Every failure path (connection drop,
   * lost acknowledgement) converges here so a logical request can never start
   * more than one retry: the pending flag plus the budget/deadline check are
   * applied at the moment the retry is scheduled, not when its callback runs.
   */
  private scheduleRetry(request: RequestRecord, reason: string): void {
    if (request.settled) {
      return;
    }
    if (request.retryActive) {
      // The single retry was already scheduled. Once it has actually been
      // dispatched, a later failure is terminal; while it is still pending the
      // request is left to that retry. A transport failure is only "unknown"
      // when a commit may already exist.
      if (request.attempts >= request.retries + 1) {
        this.settle(
          request,
          request.uncertain ? 'unknown' : 'errored',
          this.scheduler.nowMs,
          reason,
        );
      }
      return;
    }
    // Claim the single retry slot before checking the budget so a lost-ACK path
    // can never schedule a second retry or settle the request while an earlier
    // retry is already in flight.
    request.retryActive = true;
    if (request.retries >= AUDIENCE_RETRY_POLICY.maxRetries) {
      this.settle(
        request,
        request.uncertain ? 'unknown' : 'errored',
        this.scheduler.nowMs,
        reason,
      );
      return;
    }
    const atMs = this.scheduler.nowMs + AUDIENCE_RETRY_POLICY.backoffMs;
    if (atMs >= request.deadlineAtMs) {
      this.settle(
        request,
        request.uncertain ? 'unknown' : 'errored',
        this.scheduler.nowMs,
        reason,
      );
      return;
    }
    request.retries += 1;
    if (request.operation === 'ingest') {
      this.retriedLogical += 1;
    }
    for (const accumulator of this.cohortsFor(request)) {
      accumulator.retries += 1;
    }
    this.scheduleAfter(
      AUDIENCE_RETRY_POLICY.backoffMs,
      () => {
        if (request.settled) {
          return;
        }
        this.recordIncident(
          'retry',
          request.backend >= 0 ? this.topology.appId : this.topology.usersId,
          request.backend >= 0 ? request.backend : null,
          `Retrying ${request.operation} after ${reason}.`,
        );
        if (request.operation === 'ingest') {
          this.startIngestAttempt(request);
        } else {
          this.startReadAttempt(request);
        }
      },
      0,
    );
  }

  /**
   * The client deadline is terminal for the logical request *before* any task
   * is cancelled, so a synchronous task callback can never reclassify or retry
   * it. Work already accepted by SQL is left alone: its durable commit may
   * still happen, which is reported as a committed-but-unacknowledged event.
   */
  private onDeadline(request: RequestRecord): void {
    if (request.settled) {
      return;
    }
    // An ingest accepted by SQL but not yet acknowledged to the client is
    // unknown at the deadline, whether or not the durable commit already
    // landed: the client has not received the ACK, so its outcome is not known.
    if (request.sqlAccepted && !request.acknowledged) {
      this.registerUncertain(request);
    }
    // Settle first: the terminal classification is established before any task
    // is cancelled, so a synchronous failure callback cannot reclassify the
    // logical request or cancel a fill that already has an active retry.
    this.settle(
      request,
      request.uncertain ? 'unknown' : 'timeout',
      request.deadlineAtMs,
      'deadline',
    );
  }

  private settle(
    request: RequestRecord,
    outcome: Outcome,
    atMs: number,
    reason: string | null,
  ): void {
    if (request.settled) {
      return;
    }
    // A logical request whose durable state became unknown at least once keeps
    // that classification as its *final* outcome unless a bounded retry
    // resolved it: the client never learned whether the first attempt
    // committed, so reporting a plain timeout or rejection would understate the
    // ambiguity.
    if (request.uncertain && outcome !== 'succeeded') {
      outcome = 'unknown';
    }
    request.settled = true;
    request.outcome = outcome;
    request.settledAtMs = atMs;
    request.deadlineHandle?.cancel();
    request.deadlineHandle = null;
    if (request.task !== null) {
      request.task.cancel();
      request.task = null;
    }
    if (request.capacityId !== null) {
      this.sql.memory.release(request.capacityId);
      request.capacityId = null;
    }
    if (request.fillWaiter && this.cacheFill !== null) {
      const index = this.cacheFill.waiters.indexOf(request);
      if (index >= 0) {
        this.cacheFill.waiters.splice(index, 1);
      }
      request.fillWaiter = false;
    }
    if (outcome !== 'succeeded') {
      this.cancelCacheFillIfLead(request);
    }
    this.live.delete(request);
    this.liveCount = Math.max(0, this.liveCount - 1);
    this.disconnect(request);
    this.lastSettledAtMs = Math.max(this.lastSettledAtMs, atMs);

    const bucket = this.bucketOf(request.offeredAtMs);
    const latency = Math.max(0, atMs - request.offeredAtMs);
    for (const accumulator of this.cohortsFor(request)) {
      accumulator.pending = Math.max(0, accumulator.pending - 1);
      if (outcome === 'succeeded') {
        accumulator.succeeded += 1;
        accumulator.bytesDelivered += this.responseBytes(request.operation);
        accumulator.latency.add(latency);
        accumulator.latencyBuckets.add(bucket, latency);
        accumulator.buckets.settle(bucket, true);
      } else {
        accumulator.failed += 1;
        accumulator.buckets.settle(bucket, false);
        if (outcome === 'rejected') {
          accumulator.rejected += 1;
        } else if (outcome === 'timeout') {
          accumulator.timedOut += 1;
        } else if (outcome === 'unknown') {
          accumulator.unknownOutcome += 1;
        } else {
          accumulator.errored += 1;
        }
      }
    }
    if (outcome === 'succeeded') {
      if (request.uncertain) {
        request.resolvedUncertain = true;
        this.resolvedUnknownCommitOutcomes += 1;
      }
    } else {
      if (outcome === 'unknown' && request.operation === 'ingest') {
        this.registerUncertain(request);
      }
      if (request.committed && !request.acknowledged) {
        this.countCommittedUnacked(request);
      }
    }
    if (reason !== null && outcome !== 'succeeded') {
      // Bounded, aggregated evidence: the timeline is not a per-request log.
      if (outcome === 'timeout') {
        this.deadlineCount += 1;
      } else if (outcome === 'rejected') {
        this.rejectedCount += 1;
      } else if (outcome === 'unknown') {
        this.unknownCount += 1;
      } else {
        this.errorCount += 1;
      }
    }
    if (outcome === 'succeeded' && request.answered) {
      // Freshness and exactness are audited only for responses the client
      // actually received.
      this.auditServedRead(request, this.scheduler.nowMs);
    }
  }

  // -------------------------------------------------------------------------
  // Read path
  // -------------------------------------------------------------------------

  private startReadAttempt(request: RequestRecord): void {
    if (request.settled) {
      return;
    }
    const now = this.scheduler.nowMs;
    if (now >= request.deadlineAtMs) {
      this.settle(request, 'timeout', now, 'deadline-exceeded');
      return;
    }
    request.attempts += 1;
    request.attemptToken += 1;
    const token = request.attemptToken;
    this.observeEdge(
      'read',
      this.model.catalog.network.rankingRequestBytes,
      false,
      this.topology.directPath ? 'traffic' : 'ingress',
    );
    this.scheduleAfter(
      this.model.catalog.network.clientRttMs / 2,
      () => {
        if (request.settled || request.attemptToken !== token) {
          return;
        }
        this.deliverEdge(
          this.topology.directPath ? 'traffic' : 'ingress',
          this.model.catalog.network.rankingRequestBytes,
        );
        this.dispatchReadAttempt(request, token);
      },
      0,
    );
  }

  private dispatchReadAttempt(request: RequestRecord, token: number): void {
    const now = this.scheduler.nowMs;
    if (now >= request.deadlineAtMs) {
      this.settle(request, 'timeout', now, 'deadline-exceeded');
      return;
    }
    const slot = this.routeTo(true, request.backend);
    if (slot < 0) {
      this.settle(request, 'errored', now, 'no-ready-backend');
      return;
    }
    request.backend = slot;
    this.connect(request, slot);
    const app = this.appInstances[slot];
    if (app === undefined) {
      this.settle(request, 'errored', now, 'missing-backend');
      return;
    }
    if (!app.processUp) {
      const timeoutMs = AUDIENCE_FAULT_CONNECTION_POLICY.newAttemptToDeadProcessTimeoutMs;
      this.scheduleAfter(
        timeoutMs,
        () => {
          if (request.settled || request.attemptToken !== token) {
            return;
          }
          this.onTransportFailure(
            request,
            this.scheduler.nowMs,
            'connect-timeout',
          );
        },
        1,
      );
      return;
    }
    if (this.lb !== null) {
      this.submitLbRead(request, token, app);
      return;
    }
    this.appReadStage(request, token, app);
  }

  private submitLbRead(
    request: RequestRecord,
    token: number,
    app: InstanceRuntime,
  ): void {
    const lb = this.lb;
    if (lb === null) {
      this.appReadStage(request, token, app);
      return;
    }
    const bytes = this.model.catalog.network.rankingRequestBytes;
    request.task = this.submitTask(lb, {
      id: `read-lb-${request.id}-${request.attempts}`,
      resources: [{ id: lb.cpuId, units: 1 }],
      durationMs: this.model.catalog.work.lbRequestCoreMs,
      onFinish: (result) => {
        if (request.settled || request.attemptToken !== token) {
          return;
        }
        if (result.status === 'completed') {
          const backend = this.appInstances[request.backend];
          if (backend === undefined || !backend.processUp) {
            this.onTransportFailure(request, this.scheduler.nowMs, 'backend-lost');
            return;
          }
          this.submitTransfer(
            request,
            token,
            lb,
            bytes,
            this.model.catalog.network.internalOneWayMs,
            'balance',
            'read',
            () => {
              if (request.settled || request.attemptToken !== token) {
                return;
              }
              this.appReadStage(request, token, backend);
            },
          );
          return;
        }
        if (result.status === 'rejected') {
          this.settle(request, 'rejected', this.scheduler.nowMs, 'lb-queue-full');
          return;
        }
        this.onTransportFailure(request, this.scheduler.nowMs, 'lb-failure');
      },
    });
  }

  private appReadStage(
    request: RequestRecord,
    token: number,
    app: InstanceRuntime,
  ): void {
    const work = this.model.catalog.work;
    const bytes = this.model.catalog.network.rankingRequestBytes;
    app.owned.add(request);
    request.task = this.submitTask(app, {
      id: `read-a-${request.id}-${request.attempts}`,
      resources: [{ id: app.cpuId, units: 1 }],
      durationMs: work.appReadCoreMs,
      onFinish: (result) => {
        app.owned.delete(request);
        if (request.settled || request.attemptToken !== token) {
          return;
        }
        if (result.status === 'completed') {
          // The Application forwards the read to the Cache (or directly to SQL)
          // over its NIC; the next stage observes the bytes only after the hop.
          this.submitTransfer(
            request,
            token,
            app,
            bytes,
            this.model.catalog.network.internalOneWayMs,
            this.cache !== null ? 'reads' : 'primary',
            'read',
            () => {
              if (request.settled || request.attemptToken !== token) {
                return;
              }
              if (this.cache !== null) {
                this.submitCacheLookup(request, token);
              } else {
                this.submitSqlRanking(request, token);
              }
            },
          );
          return;
        }
        if (result.status === 'rejected') {
          this.settle(request, 'rejected', this.scheduler.nowMs, 'app-queue-full');
          return;
        }
        this.onTransportFailure(request, this.scheduler.nowMs, 'read-work-lost');
      },
    });
  }

  private submitCacheLookup(request: RequestRecord, token: number): void {
    const cache = this.cache;
    if (cache === null || request.settled || request.attemptToken !== token) {
      return;
    }
    const work = this.model.catalog.work;
    request.task = this.submitTask(cache, {
      id: `read-c-${request.id}-${request.attempts}`,
      resources: [{ id: cache.cpuId, units: 1 }],
      durationMs: work.cacheLookupCoreMs,
      onFinish: (result) => {
        if (request.settled || request.attemptToken !== token) {
          return;
        }
        if (result.status !== 'completed') {
          if (result.status === 'rejected') {
            this.settle(request, 'rejected', this.scheduler.nowMs, 'cache-queue-full');
          } else {
            this.onTransportFailure(request, this.scheduler.nowMs, 'cache-failure');
          }
          return;
        }
        const now = this.scheduler.nowMs;
        const entry = this.cacheEntry;
        if (entry !== null && now < entry.expiresAtMs) {
          this.serveCacheEntry(request, entry);
          return;
        }
        if (this.cacheFill !== null) {
          // Fixed coalescing: one fill serves every waiting client, and each
          // waiter keeps its own deadline and is released cleanly.
          request.fillWaiter = true;
          this.cacheFill.waiters.push(request);
          return;
        }
        this.cacheFill = {
          lead: request,
          ranking: null,
          storing: false,
          waiters: [],
        };
        // Cache forwards the miss to SQL over its NIC.
        this.submitTransfer(
          request,
          token,
          cache,
          this.model.catalog.network.rankingRequestBytes,
          this.model.catalog.network.internalOneWayMs,
          'fill',
          'read',
          () => {
            if (request.settled || request.attemptToken !== token) {
              return;
            }
            this.submitSqlRanking(request, token);
          },
        );
      },
    });
  }

  private serveCacheEntry(request: RequestRecord, entry: CacheEntryRuntime): void {
    request.served = entry.ranking;
    request.answered = true;
    request.audited = true;
    request.servedFromCache = entry;
    this.deliverRead(request);
  }

  private submitSqlRanking(request: RequestRecord, token: number): void {
    if (request.settled || request.attemptToken !== token) {
      return;
    }
    const sql = this.sql;
    const work = this.model.catalog.work;
    if (this.topology.readPlan === 'projection') {
      // A projection read is a cheap read of the published aggregate.
      request.task = this.submitTask(sql, {
        id: `read-p-${request.id}-${request.attempts}`,
        resources: [{ id: sql.cpuId, units: 1 }],
        durationMs:
          work.queryResultGroupSortCoreMs +
          this.streams * work.queryScanCoreMsPerEvent,
        onStart: () => {
          if (request.settled || request.attemptToken !== token) {
            return;
          }
          this.captureProjectionAnswer(request, token);
        },
        onFinish: (result) => {
          if (result.status === 'completed') {
            this.armCacheFill(request);
            if (!request.settled && request.attemptToken === token) {
              this.deliverRead(request);
            }
            return;
          }
          this.cancelCacheFillIfLead(request);
          if (request.settled || request.attemptToken !== token) {
            return;
          }
          if (result.status === 'rejected') {
            this.settle(request, 'rejected', this.scheduler.nowMs, 'sql-queue-full');
            return;
          }
          this.onTransportFailure(request, this.scheduler.nowMs, 'sql-read-failure');
        },
      });
      return;
    }

    // Query plan. A zero-duration admission stage observes the exact window at
    // the instant the SQL engine admits the query; the real scan is submitted
    // from the admission completion, one logical instant later at most, with
    // work derived from those exact counts. Both stages share the same
    // per-instance FIFO, so a later arrival queues behind either of them.
    request.task = this.submitTask(sql, {
      id: `read-adm-${request.id}-${request.attempts}`,
      resources: [{ id: sql.cpuId, units: 1 }],
      durationMs: 0,
      onStart: (startedAtMs) => {
        // Read-only observation: the kernel forbids kernel mutation here, and
        // the captured snapshot must be the state at this exact instant.
        if (request.settled || request.attemptToken !== token) {
          return;
        }
        this.captureQuerySnapshot(request, token, startedAtMs);
      },
      onFinish: (admission) => {
        if (request.settled || request.attemptToken !== token) {
          return;
        }
        if (admission.status !== 'completed') {
          if (admission.status === 'rejected') {
            this.settle(request, 'rejected', this.scheduler.nowMs, 'sql-queue-full');
          } else {
            this.settle(request, 'timeout', this.scheduler.nowMs, 'admission-timeout');
          }
          return;
        }
        this.executeQueryScan(request, token);
      },
    });
  }

  private captureQuerySnapshot(
    request: RequestRecord,
    token: number,
    startedAtMs: number,
  ): void {
    if (request.settled || request.attemptToken !== token) {
      return;
    }
    // Business time is measured-relative, so the setup duration can never age
    // the seeded prehistory or change the initial dataset.
    const asOf = startedAtMs - this.measuredStartMs;
    const cursor = this.commitHighWater;
    const rows = this.rowsInWindow(asOf);
    const ranking = this.servedState.ranking(asOf, cursor, this.topN);
    request.served = ranking;
    request.capturedAsOfMs = asOf;
    request.capturedCursor = cursor;
    request.capturedRows = rows;
    request.answered = true;
    this.auditAnswer(request, ranking);
  }

  private executeQueryScan(request: RequestRecord, token: number): void {
    const sql = this.sql;
    const work = this.model.catalog.work;
    const ranking = request.served;
    if (ranking === null) {
      if (request.attemptToken === token) {
        this.settle(request, 'errored', this.scheduler.nowMs, 'missing-query-snapshot');
      }
      return;
    }
    const pairs = ranking.activePairs;
    const durationMs =
      request.capturedRows * work.queryScanCoreMsPerEvent +
      pairs * work.queryDistinctCoreMsPerPair +
      work.queryResultGroupSortCoreMs;
    const ledgerId = `query-set-${request.id}-${token}`;
    const bytes = pairs * this.model.catalog.storage.queryWorkingPairBytes;
    if (!sql.memory.reserve(ledgerId, bytes)) {
      if (request.attemptToken === token) {
        this.settle(request, 'errored', this.scheduler.nowMs, 'sql-working-set-capacity');
      }
      return;
    }
    request.capacityId = ledgerId;
    request.task = this.submitTask(sql, {
      id: `read-q-${request.id}-${request.attempts}`,
      resources: [{ id: sql.cpuId, units: 1 }],
      durationMs,
      onFinish: (result) => {
        // Release this scan's own ledger unconditionally; only clear the shared
        // request slot if it still points at this attempt's ledger.
        if (sql.memory.has(ledgerId)) {
          sql.memory.release(ledgerId);
        }
        if (request.capacityId === ledgerId) {
          request.capacityId = null;
        }
        if (result.status === 'completed') {
          // The coalesced fill is armed from the scan result even when the lead
          // delivery is doomed by a crash; the cache side completes
          // independently of the lead's connection.
          this.armCacheFill(request);
          if (!request.settled && request.attemptToken === token) {
            this.deliverRead(request);
          }
          return;
        }
        this.cancelCacheFillIfLead(request);
        if (request.settled || request.attemptToken !== token) {
          return;
        }
        if (result.status === 'rejected') {
          this.settle(request, 'rejected', this.scheduler.nowMs, 'sql-queue-full');
          return;
        }
        this.onTransportFailure(request, this.scheduler.nowMs, 'sql-query-failure');
      },
    });
  }

  private captureProjectionAnswer(request: RequestRecord, token: number): void {
    if (request.settled || request.attemptToken !== token) {
      return;
    }
    const projection = this.projectionState;
    if (projection === null) {
      return;
    }
    const snapshot: AudienceSnapshot = {
      asOfMs: this.publishedAsOfMs,
      throughCommitSequence: this.publishedThrough,
    };
    const ranking = projection.ranking(
      snapshot.asOfMs,
      snapshot.throughCommitSequence,
      this.topN,
    );
    request.served = ranking;
    request.answered = true;
    request.capturedAsOfMs = snapshot.asOfMs;
    request.capturedCursor = snapshot.throughCommitSequence;
    this.auditAnswer(request, ranking);
  }

  /**
   * Response propagation is a real causal event, not a future timestamp written
   * into a settled request: the client observes the response when the network
   * delay actually elapses, so a crash or deadline in between still matters.
   */
  private deliverRead(request: RequestRecord): void {
    if (request.settled) {
      return;
    }
    const token = request.attemptToken;
    const bytes = this.model.catalog.network.rankingResponseBytes;
    const internal = this.model.catalog.network.internalOneWayMs;
    const client = this.model.catalog.network.clientRttMs / 2;
    const app = this.appInstances[request.backend];
    const origin =
      request.servedFromCache !== null && this.cache !== null
        ? this.cache
        : this.sql;
    if (app === undefined) {
      this.settle(request, 'errored', this.scheduler.nowMs, 'missing-backend');
      return;
    }
    const finish = (): void => {
      if (request.settled) {
        return;
      }
      this.billedBytes += bytes;
      this.settle(request, 'succeeded', this.scheduler.nowMs, null);
    };
    // origin -> Application
    this.submitTransfer(
      request,
      token,
      origin,
      bytes,
      internal,
      request.servedFromCache !== null ? 'reads' : 'primary',
      'read',
      () => {
      if (request.settled || request.attemptToken !== token) {
        return;
      }
      if (this.topology.directPath) {
        this.submitTransfer(request, token, app, bytes, client, 'traffic', 'read', finish);
        return;
      }
      const lb = this.lb;
      if (lb === null) {
        this.submitTransfer(request, token, app, bytes, client, 'traffic', 'read', finish);
        return;
      }
      // Application -> Load Balancer -> client
      this.submitTransfer(request, token, app, bytes, internal, 'balance', 'read', () => {
        if (request.settled || request.attemptToken !== token) {
          return;
        }
        this.submitTransfer(request, token, lb, bytes, client, 'ingress', 'read', finish);
      });
    });
  }

  /**
   * Per-response audit. Every successful ranking is compared to the independent
   * last-seen structure at the same tuple, and a bounded number of responses
   * are additionally rebuilt from raw logged rows.
   */
  private auditAnswer(request: RequestRecord, ranking: AudienceRanking): void {
    request.audited = true;
    // Independent structure: fed by the same durable commits for the query
    // plan, or by the same published ordered prefix for a projection.
    const independent =
      this.topology.readPlan === 'projection'
        ? this.projectionAudit
        : this.auditIndex;
    if (independent === null) {
      return;
    }
    const audit = independent.ranking(
      ranking.snapshot.asOfMs,
      ranking.snapshot.throughCommitSequence,
      this.topN,
    );
    if (!rankingsEqual(ranking, audit)) {
      this.snapshotMismatches += 1;
      this.wrongWindowReads += 1;
    }
    const sampleEvery = Math.max(
      1,
      Math.floor(Math.max(1, this.readTrace.count) / 3),
    );
    if (
      this.readTrace.count > 0 &&
      (request.eventIndex % sampleEvery === 0 || this.rawAudits < 2) &&
      this.rawAudits < 8
    ) {
      this.rawAudits += 1;
      const raw = recomputeWindowRanking(
        this.base,
        this.log,
        ranking.snapshot,
        this.windowMs,
        this.streams,
        this.topN,
      );
      if (!rankingsEqual(ranking, raw)) {
        this.snapshotMismatches += 1;
        this.wrongWindowReads += 1;
      }
    }
  }

  /** Audits the delivered response at client delivery time (freshness). */
  private auditServedRead(request: RequestRecord, deliveredAtMs: number): void {
    const ranking = request.served;
    if (ranking === null) {
      return;
    }
    this.successfulReads += 1;
    this.checkedReads += 1;
    if (request.audited) {
      this.checkedSnapshots += 1;
    }
    void deliveredAtMs;
    const lag = Math.max(0, this.relNow() - ranking.snapshot.asOfMs);
    if (lag > this.maxLagMs) {
      this.maxLagMs = lag;
    }
    this.lagSamples.push(lag);
    if (lag > AUDIENCE_FRESHNESS_MS) {
      this.staleReads += 1;
    }
    this.latestSnapshot = ranking.snapshot;
    this.finalSnapshot = ranking.snapshot;
    if (request.fillWaiter) {
      request.fillWaiter = false;
    }
    if (request.servedFromCache !== null) {
      const entry = request.servedFromCache;
      if (!entry.audited) {
        this.snapshotMismatches += 1;
        this.wrongWindowReads += 1;
      } else if (this.rawAudits < 3) {
        // Independent re-check of the stored snapshot against raw rows: a
        // historical as-of needs no mutable current state.
        this.rawAudits += 1;
        const raw = recomputeWindowRanking(
          this.base,
          this.log,
          entry.ranking.snapshot,
          this.windowMs,
          this.streams,
          this.topN,
        );
        if (!rankingsEqual(entry.ranking, raw)) {
          this.snapshotMismatches += 1;
          this.wrongWindowReads += 1;
        }
      }
    }
  }

  /** Arms the coalesced fill once the scan produced a ranking. */
  private armCacheFill(request: RequestRecord): void {
    const fill = this.cacheFill;
    if (fill !== null && fill.lead === request && !fill.storing) {
      this.finishCacheFill(request);
    }
  }

  /** Abandons a fill whose lead failed before producing a ranking. */
  private cancelCacheFillIfLead(request: RequestRecord): void {
    if (this.cacheFill !== null && this.cacheFill.lead === request) {
      this.cancelCacheFill('cache-fill-lead-failed');
    }
  }

  /** Releases every coalesced waiter and clears the fill. */
  private cancelCacheFill(reason: string): void {
    const fill = this.cacheFill;
    if (fill === null) {
      return;
    }
    this.cacheFill = null;
    const waiters = fill.waiters.splice(0);
    for (const waiter of waiters) {
      if (!waiter.settled) {
        this.settle(waiter, 'errored', this.scheduler.nowMs, reason);
      }
    }
  }

  /**
   * Fill completion: store the payload, verify the stored snapshot against raw
   * rows, and only then release the coalesced waiters. No waiter can observe a
   * payload that has not finished storing.
   */
  private finishCacheFill(request: RequestRecord): void {
    const cache = this.cache;
    const fill = this.cacheFill;
    if (fill === null || fill.storing || fill.lead !== request) {
      return;
    }
    const ranking = request.served;
    if (ranking === null) {
      this.cancelCacheFill('missing-fill-ranking');
      return;
    }
    fill.ranking = ranking;
    fill.storing = true;
    if (cache === null) {
      this.cacheFill = null;
      return;
    }
    const work = this.model.catalog.work;
    const ttlMs = this.topology.cacheTtlMs ?? 0;
    const bytes = this.model.catalog.components.cache.entryBytes;
    // The fill ranking returns from SQL to the Cache over its NIC before the
    // cache stores it; the store is not a free synchronous mutation.
    this.submitInternalTransfer(
      this.sql,
      bytes,
      this.model.catalog.network.internalOneWayMs,
      'read',
      'fill',
      () => {
        request.task = this.submitTask(cache, {
          id: `cache-store-${request.id}`,
          resources: [{ id: cache.cpuId, units: 1 }],
          durationMs: work.cacheStoreCoreMs,
          onFinish: (storeResult) => {
            const current = this.cacheFill;
            if (storeResult.status !== 'completed' || current !== fill) {
              if (current === fill) {
                this.cacheFill = null;
              }
              const waiters = fill.waiters.splice(0);
              for (const waiter of waiters) {
                if (!waiter.settled) {
                  this.settle(waiter, 'errored', this.scheduler.nowMs, 'cache-store-failed');
                }
              }
              return;
            }
            const storedAtMs = this.relNow();
            const raw = recomputeWindowRanking(
              this.base,
              this.log,
              ranking.snapshot,
              this.windowMs,
              this.streams,
              this.topN,
            );
            this.rawAudits += 1;
            const audited = rankingsEqual(ranking, raw);
            if (!audited) {
              this.snapshotMismatches += 1;
              this.wrongWindowReads += 1;
            }
            const entry: CacheEntryRuntime = {
              ranking,
              filledAtMs: storedAtMs,
              // The selected TTL is the real retention and is never clamped to the
              // freshness limit: a long TTL serves a transport-successful stale
              // answer that fails the delivery audit.
              expiresAtMs: storedAtMs + ttlMs,
              bytes,
              audited,
            };
            this.cacheEntry = entry;
            const waiters = fill.waiters.splice(0);
            this.cacheFill = null;
            for (const waiter of waiters) {
              if (waiter.settled) {
                continue;
              }
              waiter.served = entry.ranking;
              waiter.answered = true;
              waiter.audited = true;
              waiter.servedFromCache = entry;
              this.deliverRead(waiter);
            }
          },
        });
      },
      () => {
        this.cancelCacheFill('cache-fill-transfer-failed');
      },
    );
  }

  /**
   * Rows a time-range scan really examines: the retained prehistory rows inside
   * the open-left window plus the committed rows inside it. The seeded history
   * is not free simply because it was seeded before the measured clock.
   */
  private rowsInWindow(asOfMs: number): number {
    const left = asOfMs - this.windowMs;
    const prehistoryRows =
      this.base.prehistoryEvents -
      countAtOrBelow(this.base.eventTimesMs, left);
    let low = 0;
    let high = this.log.count;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((this.log.timesMs[mid] ?? 0) <= left) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    const committedRows = Math.max(0, this.log.count - low);
    return Math.max(0, prehistoryRows) + committedRows;
  }

  // -------------------------------------------------------------------------
  // Fault injection, probing and routing health
  // -------------------------------------------------------------------------

  private applyCrash(atMs: number): void {
    const slot = this.targetSlot;
    if (slot === null) {
      return;
    }
    const instance = this.appInstances[slot];
    if (instance === undefined) {
      return;
    }
    instance.crashCount += 1;
    instance.health = 'crashed';
    instance.processUp = false;
    // LB-known health is deliberately NOT changed here: routing may only stop
    // after two consecutive probes actually time out (250 ms cadence, 100 ms
    // timeout). Until then, traffic still reaches the dead process, fails, and
    // uses the one bounded retry.
    instance.probeFailures = 0;
    instance.probeSuccesses = 0;
    const appNode = this.nodes.find((node) => node.kind === 'app');
    if (appNode !== undefined) {
      appNode.crashEvents += 1;
    }
    this.recordIncident(
      'crash',
      this.topology.appId,
      slot,
      `Application instance ${slot} crashed at ${Math.round(atMs)} ms.`,
    );
    this.target = {
      nodeId: this.topology.appId,
      kind: 'app',
      instanceIndex: slot,
      crashAtMs: atMs - this.measuredStartMs,
      downUntilMs: null,
      detectedUnhealthyAtMs: null,
      readyAtMs: null,
      routeRestoredAtMs: null,
      recoveredAtMs: null,
      healthyAtEnd: null,
      restartCount: 0,
    };
    // A crash closes every established connection on the slot, including
    // requests already waiting on accepted SQL work. Only Application-owned
    // CPU/NIC tasks are cancelled; accepted SQL transactions keep running to
    // commit idempotently. Each connection observes the drop exactly once.
    const observeAt =
      atMs +
      (this.topology.directPath
        ? AUDIENCE_FAULT_CONNECTION_POLICY.directLostConnectionMs
        : AUDIENCE_FAULT_CONNECTION_POLICY.viaLbLostConnectionMs);
    const connected = [...(this.connections.get(slot) ?? [])];
    for (const request of connected) {
      request.crashedInFlight = true;
      request.attemptToken += 1;
      const token = request.attemptToken;
      // Cancel only Application-owned work; never accepted SQL work.
      if (instance.owned.has(request)) {
        request.task?.cancel();
        request.task = null;
        instance.owned.delete(request);
      }
      this.scheduleAfter(
        Math.max(0, observeAt - this.scheduler.nowMs),
        () => {
          if (request.settled || request.attemptToken !== token) {
            return;
          }
          this.onTransportFailure(
            request,
            this.scheduler.nowMs,
            'connection-dropped',
          );
        },
        1,
      );
    }
    instance.kernel.setAvailable(instance.cpuId, false);
    instance.kernel.setAvailable(instance.nicId, false);
  }

  private applyRestart(atMs: number): void {
    const slot = this.targetSlot;
    if (slot === null) {
      return;
    }
    const instance = this.appInstances[slot];
    if (instance === undefined) {
      return;
    }
    instance.health = 'booting';
    instance.booting = true;
    instance.processUp = false;
    instance.incarnation += 1;
    if (this.target !== null) {
      this.target = {
        ...this.target,
        downUntilMs: atMs - this.measuredStartMs,
        restartCount: 1,
      };
    }
    this.recordIncident(
      'restart',
      this.topology.appId,
      slot,
      `Application instance ${slot} restarted; booting.`,
    );
  }

  private markBootComplete(): void {
    const slot = this.targetSlot;
    if (slot === null) {
      return;
    }
    const instance = this.appInstances[slot];
    if (instance === undefined) {
      return;
    }
    instance.booting = false;
    instance.processUp = true;
    instance.health = 'healthy';
    instance.probeSuccesses = 0;
    instance.probeFailures = 0;
    instance.kernel.setAvailable(instance.cpuId, true);
    instance.kernel.setAvailable(instance.nicId, true);
    if (this.topology.lbId === null) {
      // On a direct path there is no Load-Balancer health state: the process
      // itself serves again as soon as boot completes.
      instance.lbReady = true;
      const relative = Math.max(0, this.relNow());
      if (this.target !== null) {
        this.target = {
          ...this.target,
          readyAtMs: relative,
          routeRestoredAtMs: null,
          recoveredAtMs: relative,
          healthyAtEnd: true,
        };
      }
      this.recordIncident(
        'ready',
        this.topology.appId,
        slot,
        `Application instance ${slot} finished booting and serves traffic again.`,
      );
      return;
    }
    this.recordIncident(
      'booting',
      this.topology.appId,
      slot,
      `Application instance ${slot} finished booting and waits for two successful probes.`,
    );
  }

  private probeTokens: number[] = [];

  /**
   * One health probe per launch. A reachable process answers with real Load
   * Balancer and backend work; anything else (dead, booting, interrupted) fails
   * only when the fixed 100 ms probe timeout expires, and a late success cannot
   * count after that timeout.
   */
  private launchProbe(slot: number): void {
    if (this.lb === null) {
      return;
    }
    const lb = this.lb;
    const instance = this.appInstances[slot];
    if (instance === undefined) {
      return;
    }
    this.probeTokens[slot] = (this.probeTokens[slot] ?? 0) + 1;
    const token = this.probeTokens[slot] ?? 1;
    let settled = false;
    const finish = (healthy: boolean): void => {
      if (settled || this.probeTokens[slot] !== token) {
        return;
      }
      settled = true;
      this.recordProbeResult(slot, healthy);
    };
    this.scheduleAfter(
      AUDIENCE_HEALTH_POLICY.timeoutMs,
      () => finish(false),
      1,
    );
    // A health probe is initiated by the Load Balancer, so its real physical
    // path starts at LB -> Application. It must not be attributed to the
    // Users -> LB ingress link, which only client traffic traverses.
    this.submitTask(lb, {
      id: `probe-lb-${slot}-${Math.round(this.scheduler.nowMs)}`,
      resources: [{ id: lb.cpuId, units: 1 }],
      durationMs: 0.01,
      onFinish: (result) => {
        if (result.status !== 'completed') {
          return;
        }
        this.observeEdge('ingest', 0, false, 'balance');
        if (!instance.processUp || instance.booting) {
          return;
        }
        this.submitTask(instance, {
          id: `probe-app-${slot}-${Math.round(this.scheduler.nowMs)}`,
          resources: [{ id: instance.cpuId, units: 1 }],
          durationMs: 0.01,
          onFinish: (appResult) => {
            if (appResult.status === 'completed') {
              finish(true);
            }
          },
        });
      },
    });
  }

  private recordProbeResult(slot: number, healthy: boolean): void {
    const instance = this.appInstances[slot];
    if (instance === undefined) {
      return;
    }
    const atMs = this.scheduler.nowMs;
    if (healthy) {
      instance.probeSuccesses += 1;
      instance.probeFailures = 0;
      if (
        !instance.lbReady &&
        instance.processUp &&
        instance.probeSuccesses >= AUDIENCE_HEALTH_POLICY.successesToReady
      ) {
        instance.lbReady = true;
        if (this.target !== null && this.target.instanceIndex === slot) {
          const relative = Math.max(0, atMs - this.measuredStartMs);
          this.target = {
            ...this.target,
            readyAtMs: relative,
            routeRestoredAtMs: this.topology.lbId === null ? null : relative,
            recoveredAtMs: relative,
            healthyAtEnd: true,
          };
          const appNode = this.nodes.find((node) => node.kind === 'app');
          if (appNode !== undefined && this.target.crashAtMs !== null) {
            appNode.recoveryMs = relative - this.target.crashAtMs;
          }
        }
        this.recordIncident(
          'ready',
          this.topology.appId,
          slot,
          `Application instance ${slot} is routable again after two successful probes.`,
        );
        this.recordIncident(
          'route-change',
          this.topology.lbId ?? this.topology.appId,
          slot,
          `Load Balancer routing to instance ${slot} restored.`,
        );
      }
    } else {
      instance.probeSuccesses = 0;
      instance.probeFailures += 1;
      this.recordIncident(
        'health-check-failed',
        this.topology.lbId ?? this.topology.appId,
        slot,
        `Health probe for instance ${slot} timed out.`,
      );
      if (
        instance.lbReady &&
        instance.probeFailures >= AUDIENCE_HEALTH_POLICY.failuresToUnhealthy
      ) {
        instance.lbReady = false;
        if (this.target !== null && this.target.instanceIndex === slot) {
          this.target = {
            ...this.target,
            detectedUnhealthyAtMs: Math.max(0, atMs - this.measuredStartMs),
          };
        }
        this.recordIncident(
          'marked-unhealthy',
          this.topology.lbId ?? this.topology.appId,
          slot,
          `Instance ${slot} excluded after two consecutive failed probes.`,
        );
        this.recordIncident(
          'route-change',
          this.topology.lbId ?? this.topology.appId,
          slot,
          `Load Balancer stopped routing to instance ${slot}.`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Projection workers
  // -------------------------------------------------------------------------

  private schedulePoll(workerIndex: number, atMs: number): void {
    // One pending poll per worker: replace the previous handle so the handle
    // array stays bounded by the worker count and a heartbeat never doubles.
    const previous = this.workerPollHandles[workerIndex];
    if (previous !== undefined && previous !== null) {
      previous.cancel();
    }
    this.workerPollHandles[workerIndex] = this.scheduler.schedule(
      atMs,
      () => this.pollWorker(workerIndex),
      4,
    );
  }

  private pollWorker(workerIndex: number): void {
    const worker = this.workers[workerIndex];
    if (worker === undefined) {
      return;
    }
    const now = this.scheduler.nowMs;
    if (now >= this.drainEndMs) {
      return;
    }
    const batch = this.claimBatch();
    const work = this.model.catalog.work;
    if (batch === null) {
      this.heartbeatStage(worker, workerIndex);
      return;
    }
    this.submitTask(worker, {
      id: `claim-${batch.start}`,
      resources: [{ id: worker.cpuId, units: 1 }],
      durationMs: work.workerClaimCoreMsPerBatch,
      onFinish: (claim) => {
        if (claim.status !== 'completed') {
          this.releaseBatch(batch);
          this.schedulePoll(workerIndex, this.scheduler.nowMs + 25);
          return;
        }
        // The Worker reads the claimed outbox batch from SQL over the NIC.
        const batchBytes =
          batch.jobs.length * this.model.catalog.storage.outboxJobBytes;
        this.submitInternalTransfer(
          this.sql,
          batchBytes,
          this.model.catalog.network.internalOneWayMs,
          'projection',
          'projection',
          () => this.workerMaintenance(workerIndex, worker, batch),
          () => {
            this.releaseBatch(batch);
            this.schedulePoll(workerIndex, this.scheduler.nowMs + 25);
          },
        );
      },
    });
  }

  private workerMaintenance(
    workerIndex: number,
    worker: InstanceRuntime,
    batch: ClaimedBatch,
  ): void {
    const work = this.model.catalog.work;
    // Expiry boundaries this publication will cross, charged proportionally
    // to real index/expiry work in the Worker and SQL stages below.
    const asOf = Math.max(this.publishedAsOfMs, batch.maxTimeMs);
    const boundaries = this.pendingExpiriesThrough(asOf);
    this.submitTask(worker, {
      id: `maint-${batch.start}`,
      resources: [{ id: worker.cpuId, units: 1 }],
      durationMs:
        batch.jobs.length * work.projectionMaintenanceCoreMsPerEvent +
        batch.jobs.length * work.projectionReorderCoreMsPerEvent +
        work.projectionPublishCoreMsPerBatch +
        boundaries * work.projectionIndexCoreMsPerEvent,
      onFinish: (maint) => {
        if (maint.status !== 'completed') {
          this.releaseBatch(batch);
          this.schedulePoll(workerIndex, this.scheduler.nowMs + 25);
          return;
        }
        // The Worker writes the projection delta back to SQL over the NIC.
        const batchBytes =
          batch.jobs.length * this.model.catalog.storage.outboxJobBytes;
        this.submitInternalTransfer(
          worker,
          batchBytes,
          this.model.catalog.network.internalOneWayMs,
          'projection',
          'projection',
          () => this.sqlProjectionApply(workerIndex, batch, boundaries),
          () => {
            this.releaseBatch(batch);
            this.schedulePoll(workerIndex, this.scheduler.nowMs + 25);
          },
        );
      },
    });
  }

  private sqlProjectionApply(
    workerIndex: number,
    batch: ClaimedBatch,
    boundaries: number,
  ): void {
    const sql = this.sql;
    const work = this.model.catalog.work;
    this.submitTask(sql, {
      id: `apply-${batch.start}`,
      resources: [{ id: sql.cpuId, units: 1 }],
      durationMs:
        batch.jobs.length * work.projectionApplySqlCoreMsPerEvent +
        boundaries * work.projectionApplySqlCoreMsPerEvent,
      onFinish: (applyCpu) => {
        if (applyCpu.status !== 'completed') {
          this.releaseBatch(batch);
          this.schedulePoll(workerIndex, this.scheduler.nowMs + 25);
          return;
        }
        this.submitTask(sql, {
          id: `applyd-${batch.start}`,
          resources: [{ id: sql.diskId ?? sql.cpuId, units: 1 }],
          durationMs:
            batch.jobs.length * work.projectionApplySqlDiskMsPerEvent +
            boundaries * work.projectionApplySqlDiskMsPerEvent,
          onFinish: (applyDisk) => {
            sql.ioWriteOperations += 1;
            if (applyDisk.status !== 'completed') {
              this.releaseBatch(batch);
              this.schedulePoll(workerIndex, this.scheduler.nowMs + 25);
              return;
            }
            this.publishQueue.set(batch.start, { batch });
            this.tryPublish();
            this.schedulePoll(workerIndex, this.scheduler.nowMs + 1);
          },
        });
      },
    });
  }

  /**
   * The empty-stream heartbeat is real work: the Worker performs index
   * maintenance proportional to the expiring boundaries and SQL persists the
   * new watermark, so the published as-of advances only after durable work.
   */
  private heartbeatStage(worker: InstanceRuntime, workerIndex: number): void {
    const work = this.model.catalog.work;
    const sql = this.sql;
    // The published watermark must never advance over an unprocessed outbox
    // job: with pending jobs, the heartbeat can only expire up to just before
    // the earliest unpublished event.
    const frontier = this.outbox[this.publishedThrough]?.timeMs ?? Number.POSITIVE_INFINITY;
    const asOf = Math.min(
      this.relNow(),
      this.drainEndMs - this.measuredStartMs,
      frontier - 1,
    );
    const boundaries = this.pendingExpiriesThrough(asOf);
    this.submitTask(worker, {
      id: `hb-${workerIndex}-${Math.round(this.scheduler.nowMs)}`,
      resources: [{ id: worker.cpuId, units: 1 }],
      durationMs:
        work.projectionHeartbeatCoreMs +
        boundaries * work.projectionIndexCoreMsPerEvent,
      onFinish: (hb) => {
        if (hb.status !== 'completed') {
          this.schedulePoll(
            workerIndex,
            this.scheduler.nowMs + AUDIENCE_PROJECTION_POLICY.heartbeatMs,
          );
          return;
        }
        this.submitTask(sql, {
          id: `hb-apply-${workerIndex}-${Math.round(this.scheduler.nowMs)}`,
          resources: [{ id: sql.cpuId, units: 1 }],
          durationMs: Math.max(boundaries, 1) * work.projectionApplySqlCoreMsPerEvent,
          onFinish: (hbCpu) => {
            if (hbCpu.status !== 'completed') {
              this.schedulePoll(
                workerIndex,
                this.scheduler.nowMs + AUDIENCE_PROJECTION_POLICY.heartbeatMs,
              );
              return;
            }
            this.submitTask(sql, {
              id: `hb-applyd-${workerIndex}-${Math.round(this.scheduler.nowMs)}`,
              resources: [{ id: sql.diskId ?? sql.cpuId, units: 1 }],
              durationMs: Math.max(boundaries, 1) * work.projectionApplySqlDiskMsPerEvent,
              onFinish: (hbDisk) => {
                sql.ioWriteOperations += 1;
                if (hbDisk.status === 'completed') {
                  this.applyHeartbeat(asOf);
                }
                this.schedulePoll(
                  workerIndex,
                  this.scheduler.nowMs + AUDIENCE_PROJECTION_POLICY.heartbeatMs,
                );
              },
            });
          },
        });
      },
    });
    this.schedulePoll(
      workerIndex,
      this.scheduler.nowMs + AUDIENCE_PROJECTION_POLICY.heartbeatMs,
    );
  }

  /** Expires at the heartbeat watermark, charges the durable state change. */
  private applyHeartbeat(asOf: number): void {
    const projection = this.projectionState;
    const audit = this.projectionAudit;
    if (projection === null || audit === null) {
      return;
    }
    const before = projection.expiryRemovals;
    projection.expireTo(asOf);
    audit.expireTo(asOf);
    const removed = projection.expiryRemovals - before;
    this.adjustProjectionStorage(0, removed);
    this.publishedAsOfMs = Math.max(this.publishedAsOfMs, asOf);
    this.heartbeatCount += 1;
  }

  /** Number of retained expiry boundaries not yet processed up to `asOf`. */
  private pendingExpiriesThrough(asOf: number): number {
    const projection = this.projectionState;
    if (projection === null) {
      return 0;
    }
    return (
      projection.expectedExpiriesThrough(asOf) - projection.checkedExpiry
    );
  }

  private claimBatch(): ClaimedBatch | null {
    if (this.outboxClaimed >= this.outbox.length) {
      return null;
    }
    const max = AUDIENCE_PROJECTION_POLICY.maxBatchEvents;
    const end = Math.min(this.outbox.length, this.outboxClaimed + max);
    const jobs = this.outbox.slice(this.outboxClaimed, end);
    const batch: ClaimedBatch = {
      start: (jobs[0]?.sequence ?? 1) - 1,
      end: jobs[jobs.length - 1]?.sequence ?? 0,
      jobs,
      maxTimeMs: jobs[jobs.length - 1]?.timeMs ?? 0,
    };
    this.outboxClaimed = end;
    return batch;
  }

  private releaseBatch(batch: ClaimedBatch): void {
    // Failed work releases the claim so another poll can retry the same jobs;
    // the ordered-prefix publisher never advances over an unapplied batch.
    if (this.outboxClaimed > batch.start) {
      this.outboxClaimed = batch.start;
    }
    this.publishQueue.delete(batch.start);
  }

  /**
   * Ordered-prefix publication. Batches apply in sequence order; an out-of-order
   * batch waits in the queue until every earlier job has been published, so
   * multiple workers still produce one exact global cut. Storage reflects the
   * durable projection state (distinct pairs) and the consumed outbox rows.
   */
  private tryPublish(): void {
    const projection = this.projectionState;
    const audit = this.projectionAudit;
    if (projection === null || audit === null) {
      return;
    }
    for (;;) {
      const next = this.publishQueue.get(this.publishedThrough);
      if (next === undefined) {
        break;
      }
      this.publishQueue.delete(this.publishedThrough);
      const batch = next.batch;
      const asOf = Math.max(this.publishedAsOfMs, batch.maxTimeMs);
      const beforeAdds = projection.newPairAdds;
      const beforeRemovals = projection.expiryRemovals;
      projection.expireTo(asOf);
      audit.expireTo(asOf);
      for (const job of batch.jobs) {
        projection.applyCommit(job.pairKey, job.stream, job.timeMs);
        audit.applyCommit(job.pairKey, job.timeMs);
      }
      const added = projection.newPairAdds - beforeAdds;
      const removed = projection.expiryRemovals - beforeRemovals;
      this.adjustProjectionStorage(added, removed);
      // Consume the durable outbox rows this batch published.
      this.sql.storageUsedBytes = Math.max(
        0,
        this.sql.storageUsedBytes -
          batch.jobs.length * this.model.catalog.storage.outboxJobBytes,
      );
      this.publishedThrough = batch.end;
      this.publishedAsOfMs = asOf;
    }
  }

  /** Durable projection state grows by new pairs and shrinks by expiries. */
  private adjustProjectionStorage(added: number, removed: number): void {
    const bytes = this.model.catalog.storage.projectionPairBytes;
    const delta = added - removed;
    // Integrate the resident RAM up to this instant before the size changes.
    observeMemory(this.sql, this.scheduler.nowMs);
    this.projectionPairCount += delta;
    this.sql.storageUsedBytes = Math.max(
      0,
      this.sql.storageUsedBytes + delta * bytes,
    );
    // Persisting a new pair or deleting an expired pair both write real bytes.
    this.sql.storageWrittenBytes += (Math.abs(added) + Math.abs(removed)) * bytes;
    this.sql.storagePeakBytes = Math.max(
      this.sql.storagePeakBytes,
      this.sql.storageUsedBytes,
    );
    // The projection is an in-memory last-seen structure: its RAM residency and
    // the memory ledger track the same pair delta as persistent storage.
    const residentBytes =
      this.base.provisionBytes + this.projectionPairCount * bytes;
    this.sql.workingSetBytes = residentBytes;
    if (this.sql.memory.has('resident-working-set')) {
      this.sql.memory.release('resident-working-set');
    }
    if (!this.sql.memory.reserve('resident-working-set', residentBytes)) {
      this.incompleteReasons.push(
        'SQL memory cannot hold the growing projection state.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Series, frames and incidents
  // -------------------------------------------------------------------------

  private closeSecond(second: number): void {
    if (this.series.length >= AUDIENCE_MAX_SERIES_POINTS) {
      return;
    }
    const tickAtMs = this.measuredStartMs + second * 1_000;
    const bucket = second - 1;
    // Observe the open window before the existing peak/bucket close consumes
    // it. The close itself keeps its exact prior behaviour and peaks.
    const windowMs = tickAtMs - this.edgeBucketClosedAtMs;
    const edgeRates = this.openFrameEdgeRates(windowMs);
    for (const edge of this.edges) {
      closeEdgeBucket(edge, 1_000);
    }
    this.edgeBucketClosedAtMs = tickAtMs;
    for (const instance of this.allInstances) {
      observeMemory(instance, tickAtMs);
    }
    this.series.push(this.buildSeriesPoint(bucket, second * 1_000));
    if (this.frames.length < AUDIENCE_FRAME_LIMIT) {
      this.frames.push(
        this.buildFrame(second * 1_000, 'measured', windowMs, edgeRates),
      );
    }
  }

  private closeDrain(): void {
    // The drain frame covers the real interval since the last measured close,
    // not an invented second, so its rates and its time stamp stay truthful.
    const windowMs = Math.max(0, this.drainEndMs - this.edgeBucketClosedAtMs);
    const edgeRates = this.openFrameEdgeRates(windowMs);
    for (const edge of this.edges) {
      // The peak is the maximum observed window rate, so normalize the drain
      // bucket by the interval it actually covers (10 s at the shipped
      // contract), not by an assumed one second.
      closeEdgeBucket(edge, windowMs);
    }
    this.edgeBucketClosedAtMs = this.drainEndMs;
    for (const instance of this.allInstances) {
      observeMemory(instance, this.drainEndMs);
    }
    if (this.frames.length < AUDIENCE_FRAME_LIMIT) {
      this.frames.push(
        this.buildFrame(
          this.drainEndMs - this.measuredStartMs,
          'drain',
          windowMs,
          edgeRates,
        ),
      );
    }
  }

  /**
   * Snapshot the open offered-work counters for every physical link. This is
   * an observation only: it does not reset the bucket or the business totals.
   */
  private openFrameEdgeRates(windowMs: number): EdgeFrameRate[] {
    return this.edges.map((edge) => ({
      edgeId: edge.edgeId,
      ...openEdgeBucketRates(edge, windowMs),
    }));
  }

  private buildSeriesPoint(bucket: number, timeMs: number): AudienceSeriesPoint {
    const nodes = this.nodes.map((node) => {
      const instance = node.instances[0];
      const healthy = node.instances.every(
        (item) => this.publicHealth(item) === 'healthy',
      );
      const cpu = node.instances.reduce(
        (sum, item) => sum + this.instantCpu(item),
        0,
      );
      const capacity = node.instances.reduce(
        (sum, item) => sum + item.cpuCapacityCores,
        0,
      );
      return {
        nodeId: node.nodeId,
        instanceIndex: instance?.instanceIndex ?? null,
        healthy,
        cpuUtilization: capacity > 0 ? boundedRatio(cpu, capacity) : null,
        ramUsedBytes: node.instances.reduce(
          (sum, item) => sum + item.memory.usedBytes,
          0,
        ),
        queueWaiting: node.instances.reduce(
          (sum, item) => sum + item.queue.waitingCount,
          0,
        ),
        networkGbitPerSec: node.instances.reduce(
          (sum, item) => sum + this.instantNic(item),
          0,
        ),
      };
    });
    return {
      timeMs,
      windowMs: 1_000,
      traffic: {
        ingest: this.ingest.buckets.read(bucket),
        read: this.read.buckets.read(bucket),
      },
      latency: {
        ingest: this.ingest.latencyBuckets.series(bucket),
        read: this.read.latencyBuckets.series(bucket),
      },
      nodes: nodes.slice(0, AUDIENCE_MAX_TRAFFIC_NODES),
    };
  }

  private buildFrame(
    timeMs: number,
    phase: 'measured' | 'drain',
    windowMs: number,
    edgeRates: readonly EdgeFrameRate[],
  ): AudienceTrafficFrame {
    const nodes = this.nodes.map((node) => {
      const cpuUsed = node.instances.reduce(
        (sum, item) => sum + this.instantCpu(item),
        0,
      );
      const cpuCapacity = node.instances.reduce(
        (sum, item) => sum + item.cpuCapacityCores,
        0,
      );
      const nicUsed = node.instances.reduce(
        (sum, item) => sum + this.instantNic(item),
        0,
      );
      const nicCapacity = node.instances.reduce(
        (sum, item) => sum + item.nicLanes,
        0,
      );
      const waiting = node.instances.reduce(
        (sum, item) => sum + item.queue.waitingCount,
        0,
      );
      const down = node.instances.some(
        (item) => this.publicHealth(item) !== 'healthy',
      );
      return {
        nodeId: node.nodeId,
        resources: [
          {
            key: 'cpu',
            label: 'CPU',
            aggregation: 'instant' as const,
            used: cpuUsed,
            capacity: cpuCapacity,
            unit: 'cores' as const,
          },
          {
            key: 'network',
            label: 'Network',
            aggregation: 'instant' as const,
            used: nicUsed,
            capacity: nicCapacity,
            unit: 'gbit/s' as const,
          },
          {
            key: 'queue',
            label: 'Queue',
            aggregation: 'instant' as const,
            used: waiting,
            capacity: node.instances.reduce(
              (sum, item) => sum + item.queueLimit,
              0,
            ),
            unit: 'slots' as const,
          },
        ],
        requestsPerSecond: null,
        queue: waiting,
        down,
      };
    });
    const edges = edgeRates.map((edge) => ({
      edgeId: edge.edgeId,
      // Offered logical attempts (including retries) and offered payload bytes
      // observed on this physical link during the window. Delivered bytes are
      // a sender-completion counter and are intentionally not relabelled here.
      requestsPerSecond: rate(edge.requestsPerSecond),
      bytesPerSecond: rate(edge.bytesPerSecond),
    }));
    return {
      levelId: 'live-audience',
      scopeId: this.spec.id as AudienceTrafficFrame['scopeId'],
      scopeLabel: this.spec.label,
      timeMs,
      windowMs,
      phase,
      nodes: nodes.slice(0, AUDIENCE_MAX_TRAFFIC_NODES),
      edges: edges.slice(0, 16),
    };
  }

  private instantCpu(instance: InstanceRuntime): number {
    const stats = instance.kernel.stats();
    const cpu = stats.resources.find((item) => item.id === instance.cpuId);
    return cpu?.busyUnits ?? 0;
  }

  private instantNic(instance: InstanceRuntime): number {
    const stats = instance.kernel.stats();
    const nic = stats.resources.find((item) => item.id === instance.nicId);
    return nic?.busyUnits ?? 0;
  }

  private publicHealth(instance: InstanceRuntime): 'healthy' | 'unhealthy' | 'crashed' | 'booting' {
    if (instance.kind !== 'app') {
      return instance.health;
    }
    if (instance.booting) {
      return 'booting';
    }
    if (!instance.processUp) {
      return 'crashed';
    }
    return instance.lbReady ? 'healthy' : 'unhealthy';
  }

  /**
   * Lifecycle evidence (crash, restart, health transitions, readiness, routing)
   * is always kept so a later retry storm cannot push it out of the bounded
   * timeline. Request-level retry/deadline notes are best-effort.
   */
  private recordIncident(
    kind: AudienceIncidentEvent['kind'],
    nodeId: string,
    instanceIndex: number | null,
    message: string,
  ): void {
    const event: AudienceIncidentEvent = {
      atMs: Math.max(0, this.relNow()),
      kind,
      nodeId,
      instanceIndex,
      message,
    };
    const mandatory =
      kind === 'crash' ||
      kind === 'restart' ||
      kind === 'booting' ||
      kind === 'ready' ||
      kind === 'marked-unhealthy' ||
      kind === 'route-change';
    if (!mandatory) {
      // High-volume evidence (probe failures, retries) is sampled per kind and
      // summarised separately, so it can never displace a lifecycle marker.
      const key = kind;
      const count = (this.sampledIncidentCounts.get(key) ?? 0) + 1;
      this.sampledIncidentCounts.set(key, count);
      if (count <= 3) {
        this.activityIncidents.push(event);
      }
      return;
    }
    if (this.lifecycleIncidents.length < AUDIENCE_MAX_INCIDENT_EVENTS) {
      this.lifecycleIncidents.push(event);
    }
  }

  private incidentTimeline(): AudienceIncidentEvent[] {
    const summary: AudienceIncidentEvent[] = [];
    const atMs = Math.max(0, this.relNow());
    const probeFailures = this.sampledIncidentCounts.get('health-check-failed') ?? 0;
    if (probeFailures > 0) {
      summary.push({
        atMs,
        kind: 'health-check-failed',
        nodeId: this.topology.lbId ?? this.topology.appId,
        instanceIndex: null,
        message: `${probeFailures} health probes timed out during the case (sampled in the timeline above).`,
      });
    }
    const retries = this.sampledIncidentCounts.get('retry') ?? 0;
    if (retries > 0) {
      summary.push({
        atMs,
        kind: 'retry',
        nodeId: this.topology.usersId,
        instanceIndex: null,
        message: `${retries} transport retries observed during the case (sampled above).`,
      });
    }
    if (this.deadlineCount > 0) {
      summary.push({
        atMs,
        kind: 'deadline',
        nodeId: this.topology.usersId,
        instanceIndex: null,
        message: `${this.deadlineCount} requests reached the 1000 ms logical deadline.`,
      });
    }
    if (
      this.rejectedCount > 0 ||
      this.unknownCount > 0 ||
      this.errorCount > 0
    ) {
      summary.push({
        atMs,
        kind: 'deadline',
        nodeId: this.topology.usersId,
        instanceIndex: null,
        message: `${this.rejectedCount} queue overflow, ${this.unknownCount} unknown-outcome and ${this.errorCount} errored requests.`,
      });
    }
    const merged = [...this.lifecycleIncidents, ...summary];
    merged.sort((left, right) => left.atMs - right.atMs);
    return merged.slice(0, AUDIENCE_MAX_INCIDENT_EVENTS);
  }

  private observeEdge(
    operation: 'ingest' | 'read' | 'projection',
    bytes: number,
    delivered: boolean,
    role: 'traffic' | 'primary' | 'reads' | 'balance' | 'ingress' | 'fill' | 'projection',
  ): void {
    const edge = this.edges.find((item) => item.role === role);
    if (edge === undefined) {
      return;
    }
    observeEdge(edge, operation, bytes, delivered);
  }

  // -------------------------------------------------------------------------
  // Finalisation
  // -------------------------------------------------------------------------

  private finalize(status: 'complete' | 'incomplete' | 'cancelled'): void {
    if (this.phaseState === 'done') {
      return;
    }
    this.phaseState = 'done';
    for (const handle of [...this.tickHandles, ...this.probeHandles, ...this.workerPollHandles]) {
      handle.cancel();
    }
    this.tickHandles = [];
    this.probeHandles = [];
    this.workerPollHandles = [];

    // Drive the served state through every expected expiry boundary at the
    // case horizon and audit the final ranking against raw rows.
    const finalAsOf = this.topology.readPlan === 'projection'
      ? this.publishedAsOfMs
      : this.drainEndMs;
    const finalCursor = this.topology.readPlan === 'projection'
      ? this.publishedThrough
      : this.commitHighWater;
    const served = this.topology.readPlan === 'projection'
      ? this.projectionState
      : this.servedState;
    // Distinct expiry boundaries the case's reference actually crosses at its
    // final watermark. The state is driven to exactly that instant below, so
    // the audited boundary count equals this expected count.
    this.expectedExpiries = countAtOrBelow(this.base.expiryEndsMs, finalAsOf);
    let finalRanking: AudienceRanking | null = null;
    if (served !== null) {
      finalRanking = served.ranking(finalAsOf, finalCursor, this.topN);
      this.finalActivePairs = finalRanking.activePairs;
    }
    const rawFinal = recomputeWindowRanking(
      this.base,
      this.log,
      { asOfMs: finalAsOf, throughCommitSequence: finalCursor },
      this.windowMs,
      this.streams,
      this.topN,
    );
    this.expectedActivePairs = rawFinal.activePairs;
    if (this.target !== null) {
      const slot = this.target.instanceIndex;
      const instance = this.appInstances[slot];
      if (instance !== undefined) {
        const healthyAtEnd =
          instance.processUp &&
          (this.topology.lbId === null || instance.lbReady);
        this.target = {
          ...this.target,
          healthyAtEnd,
          recoveredAtMs:
            healthyAtEnd && this.target.recoveredAtMs === null
              ? Math.max(0, finalAsOf)
              : this.target.recoveredAtMs,
        };
      }
    }
    if (finalRanking !== null) {
      this.finalRankingMatches = rankingsEqual(finalRanking, rawFinal);
      if (!this.finalRankingMatches) {
        this.snapshotMismatches += 1;
        this.wrongWindowReads += 1;
      }
    } else {
      this.finalRankingMatches = false;
    }

    // Any acknowledged event must still be in the durable log.
    for (const eventIndex of this.acknowledgedEventIds) {
      if (!this.committedPayload.has(eventIndex)) {
        this.lostAcknowledged += 1;
      }
    }

    this.resultValue = this.buildResult(status);
  }

  private buildResult(status: 'complete' | 'incomplete' | 'cancelled'): AudienceCaseResult {
    const complete = status === 'complete';
    const operations = complete
      ? {
          ingest: this.operationMetrics(this.ingest),
          read: this.operationMetrics(this.read),
          critical:
            this.criticalIngest !== null && this.criticalRead !== null
              ? {
                  ingest: this.operationMetrics(this.criticalIngest),
                  read: this.operationMetrics(this.criticalRead),
                }
              : null,
        }
      : null;
    const correctness = complete ? this.buildCorrectness() : null;
    const freshness = complete ? this.buildFreshness() : null;
    const cost = this.buildCost();
    const windowMs = this.measuredEndMs - this.measuredStartMs;
    const nodes = this.nodes.map((node) =>
      nodeMetrics(node, windowMs, (instance) => this.publicHealth(instance)),
    );
    nodes.unshift(this.usersMetrics(windowMs));
    const links = this.edges.map((edge) => edgeMetrics(edge));
    const gates = complete
      ? this.buildGates(operations!, correctness!, freshness!)
      : [];
    const passed = complete && gates.every((gate) => gate.passed);
    return {
      id: this.spec.id,
      label: this.spec.label,
      kind: this.spec.kind,
      status,
      passed,
      targetInstance: this.spec.targetInstance,
      target: this.target,
      window: this.runWindow(),
      operations,
      gates,
      correctness,
      freshness,
      finalSnapshot: this.finalSnapshot,
      nodes: nodes.slice(0, 6),
      links: links.slice(0, 8),
      cost,
      series: this.series.slice(0, AUDIENCE_MAX_SERIES_POINTS),
      trafficFrames: this.frames.slice(0, AUDIENCE_FRAME_LIMIT),
      incidentTimeline: this.incidentTimeline(),
    };
  }

  /** The fixed Users source: one logical instance with no metered resources. */
  private usersMetrics(windowMs: number): AudienceNodeMetrics {
    const zeroCpu = {
      capacityCores: 0,
      busyCoresAverage: 0,
      busyCoresPeak: 0,
      busyCoreMs: 0,
      utilizationAverage: 0,
      utilizationPeak: 0,
    };
    const zeroMemory = {
      capacityBytes: 0,
      workingSetBytes: 0,
      residentBytesAverage: 0,
      peakUsedBytes: 0,
    };
    const zeroIo = {
      readOperations: 0,
      writeOperations: 0,
      bytesRead: 0,
      bytesWritten: 0,
      busyMs: 0,
      utilizationAverage: 0,
    };
    const zeroStorage = {
      capacityBytes: 0,
      usedBytes: 0,
      peakUsedBytes: 0,
      bytesWritten: 0,
      bytesRead: 0,
    };
    const zeroQueue = {
      waitingAverage: 0,
      waitingPeak: 0,
      waitMsAverage: 0,
      waitMsMax: 0,
      waitSamples: 0,
      activePeak: 0,
      rejectedOverflow: 0,
      deadlineTimeouts: 0,
    };
    const zeroNetwork = {
      capacityGbitPerSec: 0,
      bytesOffered: 0,
      bytesDelivered: 0,
      averageGbitPerSec: 0,
      peakGbitPerSec: 0,
    };
    const zeroTasks = {
      submitted: 0,
      completed: 0,
      rejected: 0,
      timedOut: 0,
      interrupted: 0,
    };
    void windowMs;
    return {
      nodeId: this.usersNode.nodeId,
      kind: 'users',
      label: this.usersNode.label,
      provisionedInstances: 1,
      health: {
        state: 'healthy',
        totalInstances: 1,
        healthyInstances: 1,
        crashEvents: 0,
        recoveryMs: null,
      },
      cpu: zeroCpu,
      memory: zeroMemory,
      io: zeroIo,
      storage: zeroStorage,
      queue: zeroQueue,
      network: zeroNetwork,
      tasks: zeroTasks,
      instances: [
        {
          nodeId: this.usersNode.nodeId,
          kind: 'users',
          instanceIndex: 0,
          label: this.usersNode.label,
          health: 'healthy',
          cpu: zeroCpu,
          memory: zeroMemory,
          io: zeroIo,
          storage: zeroStorage,
          queue: zeroQueue,
          network: zeroNetwork,
          tasks: zeroTasks,
        },
      ],
    };
  }

  private runWindow(): AudienceRunWindow {
    // The scheduler always advances the case clock to the bounded drain end, so
    // the reported drain, run window and billed time agree with the work that
    // was actually executed (background probes/heartbeats included).
    const drainMs = this.drainEndMs - this.measuredEndMs;
    return {
      measuredStartMs: this.measuredStartMs,
      measuredEndMs: this.measuredEndMs,
      peakStartMs: this.peakStartMs,
      peakEndMs: this.peakEndMs,
      criticalStartMs: this.criticalStartMs,
      criticalEndMs: this.criticalEndMs,
      drainMs,
      totalRunMs: this.scheduler.nowMs,
    };
  }

  private operationMetrics(accumulator: OperationAccumulator): AudienceOperationMetrics {
    const latency = accumulator.latency.summary(AUDIENCE_MIN_LATENCY_SAMPLES);
    return {
      offered: accumulator.offered,
      attempts: accumulator.offered + accumulator.retries,
      retries: accumulator.retries,
      succeeded: accumulator.succeeded,
      failed: accumulator.failed,
      rejected: accumulator.rejected,
      timedOut: accumulator.timedOut,
      errored: accumulator.errored,
      unknownOutcome: accumulator.unknownOutcome,
      pending: accumulator.pending,
      availability:
        accumulator.offered === 0
          ? null
          : accumulator.succeeded / accumulator.offered,
      latency,
      bytesOffered: accumulator.bytesOffered,
      bytesDelivered: accumulator.bytesDelivered,
    };
  }

  private buildCorrectness(): AudienceCorrectness {
    const valid =
      this.duplicateLogicalEvents === 0 &&
      this.lostAcknowledged === 0 &&
      this.payloadConflicts === 0 &&
      this.snapshotMismatches === 0 &&
      this.expiryMismatches === 0 &&
      this.finalRankingMatches === true;
    return {
      valid,
      ingestOffered: this.ingest.offered,
      ingestCommitted: this.ingestCommitted,
      ingestAcknowledged: this.ingest.succeeded,
      ingestPending: this.ingest.pending,
      committedUnacknowledged: this.ingestCommitted - this.ingest.succeeded,
      duplicateLogicalEvents: this.duplicateLogicalEvents,
      lostAcknowledgedEvents: this.lostAcknowledged,
      retriedLogicalEvents: this.ingest.retries,
      idempotentReplays: this.idempotentReplays,
      payloadConflicts: this.payloadConflicts,
      unknownCommitOutcomes: this.unknownCommitOutcomes,
      resolvedUnknownCommitOutcomes: this.resolvedUnknownCommitOutcomes,
      commitsSurvivedAppCrash: this.commitsSurvivedCrash,
      commitSequenceHighWater: this.commitHighWater,
      checkedSnapshots: this.checkedSnapshots,
      snapshotMismatches: this.snapshotMismatches,
      expectedExpiries: this.expectedExpiries,
      checkedExpiry: this.servedExpiryChecks() ,
      expiryMismatches: this.expiryMismatches,
      finalRankingMatchesReference: this.finalRankingMatches,
      finalActivePairs: this.finalActivePairs,
      expectedActivePairs: this.expectedActivePairs,
      projectionLag:
        this.topology.readPlan === 'projection' ? this.projectionLag() : null,
    };
  }

  private servedExpiryChecks(): number {
    const state = this.topology.readPlan === 'projection'
      ? this.projectionState
      : this.servedState;
    return state?.checkedExpiry ?? 0;
  }

  private get expiryMismatches(): number {
    const state = this.topology.readPlan === 'projection'
      ? this.projectionState
      : this.servedState;
    return state?.expiryMismatches ?? 0;
  }

  private projectionLag(): AudienceProjectionLag {
    const unpublished = Math.max(0, this.outbox.length - this.publishedThrough);
    return {
      lagEvents: unpublished,
      lagMs: Math.max(0, this.relNow() - this.publishedAsOfMs),
      publishedThroughSequence: this.publishedThrough,
      unpublishedJobs: unpublished,
      heartbeatExpiries: this.heartbeatCount,
    };
  }

  private buildFreshness(): AudienceFreshness {
    const sorted = [...this.lagSamples].sort((left, right) => left - right);
    const p95Index = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
    return {
      valid:
        this.staleReads === 0 &&
        this.wrongWindowReads === 0 &&
        this.maxLagMs <= AUDIENCE_FRESHNESS_MS + EPSILON,
      freshnessLimitMs: AUDIENCE_FRESHNESS_MS,
      successfulReads: this.successfulReads,
      checkedReads: this.checkedReads,
      staleReads: this.staleReads,
      wrongWindowReads: this.wrongWindowReads,
      maxLagMs: this.maxLagMs,
      p95LagMs: sorted.length === 0 ? 0 : (sorted[p95Index] ?? 0),
      samples: this.checkedReads,
      latestSnapshot: this.latestSnapshot,
    };
  }

  private buildCost(): AudienceCost {
    // The case clock is advanced to the bounded drain end on every run, so the
    // billed time is exactly the preparation plus measured plus declared drain.
    const drainMs = this.drainEndMs - this.measuredEndMs;
    const billedMs = this.measuredStartMs + this.model.level.workload.measuredMs + drainMs;
    const hours = billedMs / 3_600_000;
    const lines: AudienceCost['lines'] = [];
    const push = (nodeId: string, kind: AudienceCost['lines'][number]['kind'], hourly: number) => {
      if (hourly <= 0) {
        return;
      }
      lines.push({ nodeId, kind, hourlyUsd: hourly, hours, usd: hourly * hours });
    };
    push(
      this.topology.appId,
      'app',
      this.model.catalog.components.app.hourlyUsdPerInstance *
        this.topology.appInstances,
    );
    push(
      this.topology.sqlId,
      'sql',
      this.model.catalog.components.sql.sizes[this.topology.sqlSize].hourlyUsd,
    );
    if (this.lb !== null) {
      push(this.lb.nodeId, 'lb', this.model.catalog.components.lb.hourlyUsd);
    }
    if (this.cache !== null) {
      push(this.cache.nodeId, 'cache', this.model.catalog.components.cache.hourlyUsd);
    }
    if (this.workers.length > 0 && this.topology.workerId !== null) {
      push(
        this.topology.workerId,
        'worker',
        this.model.catalog.components.worker.hourlyUsdPerInstance *
          this.workers.length,
      );
    }
    const hourlyUsd = lines.reduce((sum, line) => sum + line.hourlyUsd, 0);
    const rentalUsd = hourlyUsd * hours;
    const bytesUsd =
      (this.billedBytes / this.model.catalog.billing.bytesPerGb) *
      this.model.catalog.billing.responseBytesUsdPerGb;
    return {
      currency: 'USD',
      hourlyUsd,
      preparationMs: this.measuredStartMs,
      measuredMs: this.model.level.workload.measuredMs,
      drainMs,
      billedMs,
      rentalUsd,
      billedBytes: this.billedBytes,
      bytesUsd,
      actualUsd: rentalUsd + bytesUsd,
      lines,
    };
  }

  private buildGates(
    operations: NonNullable<AudienceCaseResult['operations']>,
    correctness: AudienceCorrectness,
    freshness: AudienceFreshness,
  ): AudienceGate[] {
    const gates: AudienceGate[] = [];
    const pendingTotal = operations.ingest.pending + operations.read.pending;
    for (const spec of audienceRequiredGateSpecs(this.spec.kind)) {
      const cohort =
        spec.window === 'critical'
          ? operations.critical?.[spec.operation ?? 'read'] ?? null
          : operations[spec.operation ?? 'read'];
      if (spec.metric === 'availability') {
        const actual = cohort?.availability ?? null;
        gates.push({
          id: spec.id,
          label: spec.label,
          severity: 'required',
          operation: spec.operation,
          window: spec.window,
          metric: spec.metric,
          actual,
          limit: AUDIENCE_AVAILABILITY_SLO,
          unit: spec.unit,
          comparison: spec.comparison,
          sampleCount: cohort?.offered ?? 0,
          passed:
            cohort !== null &&
            cohort.offered > 0 &&
            actual !== null &&
            actual >= AUDIENCE_AVAILABILITY_SLO,
          message:
            actual === null
              ? 'No requests were offered in this cohort.'
              : `${(actual * 100).toFixed(2)}% of ${cohort?.offered ?? 0} offered requests succeeded; required ${(AUDIENCE_AVAILABILITY_SLO * 100).toFixed(2)}%.`,
        });
        continue;
      }
      if (spec.metric === 'successfulP95Ms') {
        const actual = cohort?.latency.p95Ms ?? null;
        const samples = cohort?.latency.samples ?? 0;
        gates.push({
          id: spec.id,
          label: spec.label,
          severity: 'required',
          operation: spec.operation,
          window: spec.window,
          metric: spec.metric,
          actual,
          limit: AUDIENCE_SUCCESSFUL_P95_MS,
          unit: spec.unit,
          comparison: spec.comparison,
          sampleCount: samples,
          passed:
            actual !== null &&
            samples >= AUDIENCE_MIN_LATENCY_SAMPLES &&
            actual <= AUDIENCE_SUCCESSFUL_P95_MS,
          message:
            actual === null
              ? 'No successful responses in this cohort, so latency cannot pass.'
              : `${samples} successful samples, p95 ${actual.toFixed(1)} ms; required at most ${AUDIENCE_SUCCESSFUL_P95_MS} ms with at least ${AUDIENCE_MIN_LATENCY_SAMPLES} samples.`,
        });
        continue;
      }
      if (spec.metric === 'preservation') {
        const passed =
          correctness.lostAcknowledgedEvents === 0 &&
          correctness.duplicateLogicalEvents === 0 &&
          correctness.payloadConflicts === 0;
        gates.push({
          id: spec.id,
          label: spec.label,
          severity: 'required',
          metric: spec.metric,
          actual: null,
          limit: null,
          unit: spec.unit,
          comparison: spec.comparison,
          sampleCount: correctness.ingestAcknowledged,
          passed,
          message: passed
            ? `${correctness.ingestAcknowledged} acknowledged events are preserved exactly once.`
            : `Preservation failed: ${correctness.lostAcknowledgedEvents} lost, ${correctness.duplicateLogicalEvents} duplicated, ${correctness.payloadConflicts} conflicting.`,
        });
        continue;
      }
      if (spec.metric === 'exactSnapshotCorrectness') {
        gates.push({
          id: spec.id,
          label: spec.label,
          severity: 'required',
          metric: spec.metric,
          actual: null,
          limit: null,
          unit: spec.unit,
          comparison: spec.comparison,
          sampleCount: correctness.checkedSnapshots,
          passed: correctness.valid,
          message: correctness.valid
            ? `${correctness.checkedSnapshots} ranking responses matched the reference at their own snapshot.`
            : `Correctness failed: ${correctness.snapshotMismatches} snapshot mismatches, ${correctness.expiryMismatches} expiry mismatches.`,
        });
        continue;
      }
      if (spec.metric === 'freshnessLagMs') {
        gates.push({
          id: spec.id,
          label: spec.label,
          severity: 'required',
          metric: spec.metric,
          actual: freshness.maxLagMs,
          limit: AUDIENCE_FRESHNESS_MS,
          unit: spec.unit,
          comparison: spec.comparison,
          sampleCount: freshness.checkedReads,
          passed: freshness.valid,
          message: freshness.valid
            ? `Every one of ${freshness.checkedReads} successful rankings was delivered within ${AUDIENCE_FRESHNESS_MS} ms of its named snapshot.`
            : `Freshness failed: ${freshness.staleReads} stale and ${freshness.wrongWindowReads} wrong-window responses, max lag ${freshness.maxLagMs.toFixed(1)} ms.`,
        });
        continue;
      }
      gates.push({
        id: spec.id,
        label: spec.label,
        severity: 'required',
        metric: spec.metric,
        actual: pendingTotal,
        limit: 0,
        unit: spec.unit,
        comparison: spec.comparison,
        sampleCount: 0,
        passed: pendingTotal === 0,
        message:
          pendingTotal === 0
            ? 'Every offered request reached a final outcome inside the bounded drain.'
            : `${pendingTotal} requests were still pending after the bounded drain.`,
      });
    }
    return gates;
  }
}

/** SQL disk lanes (a disclosed physical resource, as in the shared kernel). */
const SQL_DISK_LANES = 4;
/** Bounded per-case frames retained for the report and replay. */
export const AUDIENCE_FRAME_LIMIT = 240;
