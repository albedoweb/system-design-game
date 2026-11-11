/**
 * Parcel Pulse public contract (P200).
 *
 * This module is the single frozen API surface for the Parcel Pulse level.
 * The browser worker (P201), React UI (P201) and the agent CLI all consume
 * these types and the functions exported from `src/parcel/index.ts`.
 *
 * The model is a deterministic teaching model, not a vendor benchmark. All
 * prices are conditional in-game prices. No React, DOM or Node imports belong
 * in this module or in the pure evaluator.
 */

import type { TrafficObserver } from '../simulation/traffic-telemetry';

export const PARCEL_SCHEMA_VERSION = 1 as const;
export const PARCEL_MODEL_VERSION = '1.0.0' as const;
export const PARCEL_CONTENT_VERSION = '1.0.0' as const;
export const PARCEL_PRICING_VERSION = 'parcel-catalog-v1' as const;
export const PARCEL_LEVEL_ID = 'parcel-pulse' as const;
/** Seeds are unsigned 31-bit integers so JSON and xorshift stay portable. */
export const PARCEL_MAX_SEED = 2_147_483_647;

/** Mandatory evaluation horizons. Both are required for an overall pass. */
export const PARCEL_REQUIRED_HORIZONS = [1, 5] as const;

export type ParcelHorizonYears = (typeof PARCEL_REQUIRED_HORIZONS)[number];
export type ParcelNodeKind = 'client' | 'app' | 'sql' | 'kv' | 'columnar';
export type ParcelNodeSize = 'small' | 'medium' | 'large';
export type ParcelOperation =
  | 'traffic'
  | 'ingest'
  | 'status'
  | 'history'
  | 'report'
  | 'replicate';
export type ParcelBusinessOperation = 'ingest' | 'status' | 'history' | 'report';
export type ParcelStoreKind = 'sql' | 'kv' | 'columnar';
export type ParcelReadOperation = 'status' | 'history' | 'report';
export type ParcelSqlIndex = 'none' | 'parcel' | 'parcel-warehouse';
export type ParcelPartition = 'none' | 'month';
export type ParcelCompression = 'none' | 'lz4' | 'zstd';
export type ParcelIssueSeverity = 'error' | 'warning' | 'info';
export type ParcelCheckSeverity = 'required' | 'advisory';

export const PARCEL_BUSINESS_OPERATIONS: readonly ParcelBusinessOperation[] = [
  'status',
  'history',
  'ingest',
  'report',
];
export const PARCEL_OPERATIONS: readonly ParcelOperation[] = [
  'traffic',
  'ingest',
  'status',
  'history',
  'report',
  'replicate',
];
export const PARCEL_NODE_KINDS: readonly ParcelNodeKind[] = [
  'client',
  'app',
  'sql',
  'kv',
  'columnar',
];
export const PARCEL_STORE_KINDS: readonly ParcelStoreKind[] = [
  'sql',
  'kv',
  'columnar',
];
export const PARCEL_NODE_SIZES: readonly ParcelNodeSize[] = [
  'small',
  'medium',
  'large',
];
export const PARCEL_SQL_INDEXES: readonly ParcelSqlIndex[] = [
  'none',
  'parcel',
  'parcel-warehouse',
];
export const PARCEL_PARTITIONS: readonly ParcelPartition[] = ['none', 'month'];
export const PARCEL_COMPRESSIONS: readonly ParcelCompression[] = [
  'none',
  'lz4',
  'zstd',
];

// ---------------------------------------------------------------------------
// Graph documents
// ---------------------------------------------------------------------------

export interface ParcelPosition {
  readonly x: number;
  readonly y: number;
}

/**
 * Kind-specific fields are optional in imported documents and are always
 * normalised by the strict parser. A field that is not listed here is not
 * accepted (prototype keys included).
 */
export interface ParcelNodeConfig {
  readonly size: ParcelNodeSize;
  /** Stores only; provisioned capacity in decimal TB. */
  readonly storageTb?: number;
  /** SQL only. Controls scanned rows for history/report. */
  readonly index?: ParcelSqlIndex;
  /** Stores only. Monthly partition pruning for report reads. */
  readonly partition?: ParcelPartition;
  /** SQL/KV only. Maintains a current-status row per parcel. */
  readonly latestStatus?: boolean;
  /** Stores only. Maintains hourly per-warehouse aggregates. */
  readonly rollups?: boolean;
  /** Stores only. Number of years of raw history retained. */
  readonly retentionYears?: number;
  /** Columnar only. Projection batch interval; 0 means immediately. */
  readonly batchIntervalMs?: number;
  /** Stores only. Physical compression for event rows. */
  readonly compression?: ParcelCompression;
  /** Columnar only. Store/read the narrow analytics projection only. */
  readonly columnProjection?: boolean;
}

export interface ParcelNode {
  readonly id: string;
  readonly kind: ParcelNodeKind;
  readonly label: string;
  readonly position: ParcelPosition;
  readonly config: ParcelNodeConfig;
}

export interface ParcelEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly operation: ParcelOperation;
}

/**
 * Serialisable graph document. `levelId` is authoritative: imported documents
 * cannot select another level or patch level limits, prices or SLOs.
 */
export interface ParcelGraph {
  readonly schemaVersion: typeof PARCEL_SCHEMA_VERSION;
  readonly levelId: typeof PARCEL_LEVEL_ID;
  readonly name?: string;
  readonly nodes: readonly ParcelNode[];
  readonly edges: readonly ParcelEdge[];
}

export interface ParcelValidationResult {
  readonly ok: boolean;
  readonly graph: ParcelGraph | null;
  readonly issues: readonly ParcelIssue[];
}

// ---------------------------------------------------------------------------
// Issues, diagnostics, checks
// ---------------------------------------------------------------------------

export interface ParcelIssue {
  readonly severity: ParcelIssueSeverity;
  /** Stable machine-readable identifier, e.g. `duplicate_node_id`. */
  readonly code: string;
  /** English product message. */
  readonly message: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly horizonYears?: ParcelHorizonYears;
}

export interface ParcelDiagnostic {
  /** Stable machine-readable identifier, e.g. `queue_bottleneck`. */
  readonly id: string;
  readonly severity: ParcelIssueSeverity;
  readonly code: string;
  readonly message: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly operation?: ParcelOperation;
  readonly horizonYears?: ParcelHorizonYears;
  readonly value?: number;
  readonly limit?: number;
}

export interface ParcelCheck {
  /** Stable gate identifier used by agents and the results panel. */
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  readonly severity: ParcelCheckSeverity;
  readonly horizonYears?: ParcelHorizonYears;
  readonly operation?: ParcelBusinessOperation;
  readonly nodeId?: string;
  readonly actual?: number;
  readonly limit?: number;
  readonly unit?: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface ParcelHardwareProfile {
  readonly size: ParcelNodeSize;
  readonly cpuCores: number;
  readonly memoryGb: number;
  /** Sequential disk throughput available to the whole node, MB/s. */
  readonly diskMbps: number;
  readonly diskIops: number;
  /** Network throughput available to the whole node, Mbit/s. */
  readonly networkMbps: number;
  /** Concurrent IO lanes; shared by all requests on the node. */
  readonly ioLanes: number;
  readonly networkLanes: number;
  /** Conditional in-game price. */
  readonly hourlyUsd: number;
}

export interface ParcelNodeKindSpec {
  readonly kind: ParcelNodeKind;
  readonly label: string;
  readonly durable: boolean;
  readonly storage: boolean;
  readonly allowedSizes: readonly ParcelNodeSize[];
  readonly defaultSize: ParcelNodeSize;
  /** Defaults applied by the strict parser for omitted optional fields. */
  readonly defaults: ParcelNodeConfig;
  /** Human/agent readable capability summary. */
  readonly notes: string;
}

export interface ParcelServiceCoefficients {
  /** Fixed client round trip added to every sampled request. */
  readonly clientLatencyMs: number;
  readonly appCpuMsPerRequest: number;
  readonly appCpuMsPerReport: number;
  readonly ingest: {
    readonly baseCpuMsPerEvent: number;
    readonly durabilityCpuMsPerEvent: number;
    readonly latestCpuMsPerEvent: number;
    readonly rollupCpuMsPerEvent: number;
    readonly parcelIndexCpuMsPerEvent: number;
    readonly warehouseIndexCpuMsPerEvent: number;
    readonly ioOpsPerEvent: number;
  };
  readonly status: {
    readonly latestCpuMs: number;
    readonly scanCpuMsPerEvent: number;
    readonly probeIoOps: number;
  };
  readonly history: {
    readonly eventCpuMs: number;
    readonly bucketIoOps: number;
  };
  readonly report: {
    readonly rollupCpuMsPerRow: number;
    readonly indexedCpuMsPerRow: number;
    readonly columnarCpuMsPerRow: number;
    readonly scanCpuMsPerRow: number;
    readonly rollupIoOps: number;
    readonly scanIoOpsPerKRow: number;
    readonly rollupRowsPerReport: number;
  };
  readonly replication: {
    readonly sourceCpuMsPerEvent: number;
  };
  /**
   * Compression is not free: it saves IO bytes but costs CPU on every
   * compressed write and read. Values are milliseconds per uncompressed KB.
   */
  readonly compressionCpuMsPerKb: Record<ParcelCompression, number>;
  /** Explicit bounded node queue, measured in tasks per CPU core. */
  readonly queueLimitPerCore: number;
  /** Columnar warehouse-clustering maintenance cost per event. */
  readonly columnarClusterCpuMsPerEvent: number;
}

export interface ParcelStorageCoefficients {
  readonly eventRowOverheadBytes: number;
  readonly latestRowBytes: number;
  readonly rollupRowBytes: number;
  readonly parcelIndexBytesPerParcel: number;
  readonly warehouseIndexBytesPerEvent: number;
  readonly kvBucketOverheadBytesPerParcel: number;
  readonly columnarRowOverheadBytes: number;
  /** Narrow analytics projection width, bytes per event. */
  readonly columnarProjectionBytes: number;
  /**
   * Columnar layouts are explicitly clustered by warehouse. This metadata is
   * charged on write and on capacity; it is not a free implicit index.
   */
  readonly columnarWarehouseClusterBytesPerEvent: number;
  readonly compressionFactor: Record<ParcelCompression, number>;
  /** Extra write bytes per indexed event. */
  readonly indexWriteAmplification: number;
}

export interface ParcelCatalog {
  readonly schemaVersion: typeof PARCEL_SCHEMA_VERSION;
  readonly pricingVersion: typeof PARCEL_PRICING_VERSION;
  readonly currency: 'USD';
  /** Conditional in-game prices, not real vendor claims. */
  readonly priceNote: string;
  readonly hardware: Record<ParcelNodeSize, ParcelHardwareProfile>;
  readonly storage: {
    readonly priceUsdPerTbMonth: number;
    readonly billingHoursPerMonth: number;
    readonly tcoMonths: number;
    readonly note: string;
  };
  readonly nodes: Record<ParcelNodeKind, ParcelNodeKindSpec>;
  readonly service: ParcelServiceCoefficients;
  readonly storageModel: ParcelStorageCoefficients;
}

// ---------------------------------------------------------------------------
// Level
// ---------------------------------------------------------------------------

export interface ParcelWorkloadPhase {
  readonly id: 'normal' | 'evening' | 'recovery';
  readonly fromMs: number;
  readonly toMs: number;
  /** Multiplier applied to the peak rate. */
  readonly multiplier: number;
  readonly label: string;
}

export interface ParcelLevel {
  readonly schemaVersion: typeof PARCEL_SCHEMA_VERSION;
  readonly contentVersion: typeof PARCEL_CONTENT_VERSION;
  readonly modelVersion: typeof PARCEL_MODEL_VERSION;
  readonly pricingVersion: typeof PARCEL_PRICING_VERSION;
  readonly id: typeof PARCEL_LEVEL_ID;
  readonly title: string;
  readonly description: string;
  readonly durationMs: number;
  /** Additional simulated time after the last arrival, for report drain. */
  readonly drainMs: number;
  readonly horizons: typeof PARCEL_REQUIRED_HORIZONS;
  readonly workload: {
    readonly dailyParcels: number;
    readonly eventsPerParcel: number;
    readonly eventBytes: number;
    readonly daysPerYear: number;
    readonly phaseMultiplier: readonly ParcelWorkloadPhase[];
    readonly peakRatesPerSecond: Record<ParcelBusinessOperation, number>;
    /** Reports are scheduled, never Poisson arrivals. */
    readonly reportScheduleMs: readonly number[];
    readonly reportWarehouseIds: readonly number[];
    readonly warehouseCount: number;
    readonly reportWindowDays: number;
    /** One sampled arrival represents this many offered requests. */
    readonly sampleFactor: number;
    /** Bounded keyspace for status/history parcel ids. */
    readonly sampledParcelKeys: number;
    /** Year-5 old-history cohort share (every fifth request). */
    readonly oldHistoryEveryNth: number;
    readonly oldHistoryAgeDaysAtYear5: number;
    readonly recentHistoryAgeDays: readonly [number, number];
    readonly oldHistoryAgeDaysAtYear1: number;
  };
  readonly slo: {
    readonly availability: number;
    /** Target successful p95, not the hard request deadline. */
    readonly p95Ms: Record<ParcelBusinessOperation, number>;
    /**
     * Hard per-request deadline used for timeout accounting. Keeping this
     * wider than p95 prevents a p95 target from becoming a 100% deadline.
     */
    readonly deadlineMs: Record<ParcelBusinessOperation, number>;
    readonly freshnessMs: {
      readonly status: number;
      readonly report: number;
    };
  };
  readonly budget: {
    readonly monthlyUsd: number;
    readonly currency: 'USD';
    readonly note: string;
  };
  readonly defaultSeed: number;
  readonly refs: {
    readonly trainingSeeds: readonly number[];
    readonly holdoutSeeds: readonly number[];
  };
  /** Product-facing modelling boundaries. */
  readonly assumptions: readonly string[];
}

// ---------------------------------------------------------------------------
// Capacity and cost
// ---------------------------------------------------------------------------

export interface ParcelStoreUsage {
  readonly nodeId: string;
  readonly kind: ParcelStoreKind;
  readonly roles: readonly string[];
  readonly retentionYears: number;
  readonly horizonYears: ParcelHorizonYears;
  readonly rawEventBytes: number;
  readonly physicalEventBytes: number;
  readonly indexBytes: number;
  readonly latestStatusBytes: number;
  readonly rollupBytes: number;
  readonly bucketOverheadBytes: number;
  readonly totalUsedBytes: number;
  readonly totalUsedTb: number;
  readonly provisionedTb: number;
  readonly utilization: number;
  readonly capacityOk: boolean;
  readonly replicatedFrom?: string;
  readonly compression: ParcelCompression;
  readonly index: ParcelSqlIndex;
  readonly partition: ParcelPartition;
}

export interface ParcelCapacityBreakdown {
  readonly horizonYears: ParcelHorizonYears;
  readonly stores: readonly ParcelStoreUsage[];
  readonly rawEventBytes: number;
  readonly physicalBytes: number;
  readonly indexBytes: number;
  readonly latestStatusBytes: number;
  readonly rollupBytes: number;
  readonly totalUsedTb: number;
  readonly totalProvisionedTb: number;
  readonly replicationCopies: number;
  readonly replicationFactor: number;
  readonly retentionYearsRequired: number;
  readonly retentionOk: boolean;
  readonly capacityOk: boolean;
  readonly notes: readonly string[];
}

export interface ParcelNodeCost {
  readonly nodeId: string;
  readonly kind: ParcelNodeKind;
  readonly size: ParcelNodeSize;
  readonly computeMonthlyUsd: number;
  readonly provisionedStorageTb: number;
  readonly storageMonthlyUsd: number;
  readonly totalMonthlyUsd: number;
}

export interface ParcelCostSummary {
  readonly currency: 'USD';
  readonly pricingVersion: typeof PARCEL_PRICING_VERSION;
  readonly monthlyUsd: number;
  readonly computeMonthlyUsd: number;
  readonly storageMonthlyUsd: number;
  readonly fiveYearTcoUsd: number;
  readonly computeHours: number;
  readonly tcoMonths: number;
  readonly provisionedStorageTb: number;
  readonly usedStorageTbByHorizon: Partial<Record<ParcelHorizonYears, number>>;
  readonly replicationFactor: number;
  readonly byNode: readonly ParcelNodeCost[];
  readonly budgetMonthlyUsd: number;
  readonly withinBudget: boolean;
  readonly note: string;
}

export interface ParcelCapacityEstimate {
  readonly horizonYears: ParcelHorizonYears;
  readonly capacity: ParcelCapacityBreakdown;
  readonly cost: ParcelCostSummary;
  readonly issues: readonly ParcelIssue[];
}

// ---------------------------------------------------------------------------
// Evaluation results
// ---------------------------------------------------------------------------

export interface ParcelCountMetrics {
  /** Sampled arrivals represented by this metric. */
  readonly sampled: number;
  /** Offered requests after applying the level sample factor. */
  readonly offered: number;
  /** Successful responses (on time, data present, freshness OK). */
  readonly success: number;
  readonly failed: number;
  readonly rejected: number;
  readonly timedOut: number;
  readonly missedData: number;
  readonly stale: number;
  readonly unfinished: number;
}

export interface ParcelOperationMetrics {
  readonly operation: ParcelBusinessOperation;
  readonly sampleFactor: number;
  readonly counts: ParcelCountMetrics;
  /** All offered requests; rejected and missing-data requests fail. */
  readonly availability: number;
  /** Successful-response latency percentiles only. */
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly latencyP99Ms: number;
  readonly timeoutCount: number;
  readonly rejectCount: number;
  readonly successP95Ms: number;
  readonly queueWaitP95Ms: number;
  /** Successful-response freshness percentile, when the operation has an SLO. */
  readonly freshnessP95Ms: number | null;
  readonly freshnessMaxMs: number | null;
  readonly rowsScanned: number;
  readonly bytesRead: number;
  readonly bytesWritten: number;
  readonly estimatedThroughputPerSec: number;
  readonly errorsByCode: Readonly<Record<string, number>>;
}

export type ParcelOperationMetricsMap = Readonly<
  Record<ParcelBusinessOperation, ParcelOperationMetrics>
>;

export interface ParcelNodeOperationMetrics {
  readonly requests: number;
  readonly completed: number;
  readonly errors: number;
  readonly timedOut: number;
  readonly p95Ms: number;
}

export interface ParcelNodeMetrics {
  readonly nodeId: string;
  readonly kind: ParcelNodeKind;
  readonly label: string;
  readonly requests: number;
  readonly completed: number;
  readonly errors: number;
  readonly timedOut: number;
  readonly rejected: number;
  readonly averageCpuUtilization: number;
  readonly peakCpuUtilization: number;
  readonly averageIoUtilization: number;
  readonly peakIoUtilization: number;
  readonly averageNetworkUtilization: number;
  readonly peakNetworkUtilization: number;
  readonly averageQueueDepth: number;
  readonly peakQueueDepth: number;
  readonly queueWaitP95Ms: number;
  readonly bytesRead: number;
  readonly bytesWritten: number;
  readonly operations: Readonly<
    Partial<Record<ParcelOperation, ParcelNodeOperationMetrics>>
  >;
}

export interface ParcelWorkloadSummary {
  readonly durationMs: number;
  readonly drainMs: number;
  readonly simulationEndMs: number;
  readonly sampleFactor: number;
  readonly sampledRequests: number;
  readonly estimatedOfferedRequests: number;
  readonly scheduledReports: number;
  readonly oldHistoryRequests: number;
  readonly eventBudget: number;
  readonly processedEvents: number;
  readonly exhausted: boolean;
  readonly keyspace: number;
  readonly causalTimestamps: string;
}

export interface ParcelHorizonResult {
  readonly horizonYears: ParcelHorizonYears;
  readonly passed: boolean;
  readonly workload: ParcelWorkloadSummary;
  readonly operations: ParcelOperationMetricsMap;
  readonly nodes: readonly ParcelNodeMetrics[];
  readonly capacity: ParcelCapacityBreakdown;
  readonly cost: ParcelCostSummary;
  readonly checks: readonly ParcelCheck[];
  readonly diagnostics: readonly ParcelDiagnostic[];
}

export interface ParcelEvaluationMeta {
  readonly schemaVersion: typeof PARCEL_SCHEMA_VERSION;
  readonly modelVersion: typeof PARCEL_MODEL_VERSION;
  readonly pricingVersion: typeof PARCEL_PRICING_VERSION;
  readonly contentVersion: typeof PARCEL_CONTENT_VERSION;
  readonly levelId: typeof PARCEL_LEVEL_ID;
  readonly seed: number;
  /** Semantic digest; node positions and labels are ignored. */
  readonly graphDigest: string | null;
  readonly requestedHorizons: readonly ParcelHorizonYears[];
  readonly requiredHorizons: typeof PARCEL_REQUIRED_HORIZONS;
  readonly sampleFactor: number;
}

export interface ParcelEvaluationBase {
  readonly status: 'ok' | 'invalid' | 'error';
  readonly passed: boolean;
  readonly meta: ParcelEvaluationMeta;
  readonly issues: readonly ParcelIssue[];
  readonly diagnostics: readonly ParcelDiagnostic[];
  readonly assumptions: readonly string[];
}

export interface ParcelEvaluationInvalid extends ParcelEvaluationBase {
  readonly status: 'invalid';
  readonly passed: false;
  readonly horizons: readonly [];
  readonly capacity: null;
  readonly cost: null;
  readonly checks: readonly ParcelCheck[];
}

export interface ParcelEvaluationError extends ParcelEvaluationBase {
  readonly status: 'error';
  readonly passed: false;
  readonly horizons: readonly [];
  readonly capacity: null;
  readonly cost: null;
  readonly checks: readonly ParcelCheck[];
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export interface ParcelEvaluationOk extends ParcelEvaluationBase {
  readonly status: 'ok';
  readonly passed: boolean;
  readonly horizons: readonly ParcelHorizonResult[];
  /** Capacity/cost at the highest requested horizon. */
  readonly capacity: ParcelCapacityBreakdown;
  readonly cost: ParcelCostSummary;
  readonly checks: readonly ParcelCheck[];
}

export type ParcelEvaluation =
  | ParcelEvaluationInvalid
  | ParcelEvaluationError
  | ParcelEvaluationOk;

// ---------------------------------------------------------------------------
// Options and progress
// ---------------------------------------------------------------------------

export interface ParcelRunOptions {
  /** Deterministic workload seed. Defaults to `PARCEL_LEVEL.defaultSeed`. */
  readonly seed?: number;
  /**
   * Investigation only. The default is both mandatory horizons. A run with
   * fewer than both horizons can never report an overall pass.
   */
  readonly horizons?: readonly ParcelHorizonYears[];
  /** Optional synchronous progress callback; never used for control flow. */
  readonly onProgress?: (progress: ParcelProgress) => void;
  /**
   * Optional observational traffic frame callback. Frames are never part of
   * the evaluation result, a saved graph or the JSON API output.
   */
  readonly onTraffic?: TrafficObserver;
}

export interface ParcelProgress {
  readonly phase: 'validate' | 'capacity' | 'workload' | 'simulate' | 'done';
  readonly horizonYears: ParcelHorizonYears | null;
  readonly completed: number;
  readonly total: number;
  readonly message: string;
}

/** Parser entry point. Shape errors are discriminated; semantics are separate. */
export type ParcelParseResult =
  | {
      readonly ok: true;
      readonly graph: ParcelGraph;
      readonly issues: readonly ParcelIssue[];
    }
  | {
      readonly ok: false;
      readonly graph: null;
      readonly issues: readonly ParcelIssue[];
    };

export interface ParcelValidationOptions {
  /** Extra context chosen by the caller; run validation uses `run`. */
  readonly mode?: 'edit' | 'run';
}

export type ParcelGraphDigest = string;

export const PARCEL_EVALUATION_SCHEMA = {
  status: ['ok', 'invalid', 'error'],
  requiredHorizons: PARCEL_REQUIRED_HORIZONS,
  version: PARCEL_SCHEMA_VERSION,
} as const;
