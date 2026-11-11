/**
 * Frozen wire types between the engine (Web Worker) and the UI.
 * Everything here is plain, JSON-serializable data: no classes, functions,
 * Map/Set, React or React Flow types.
 */

/** One 1-second telemetry bin; at most 180 points per snapshot. */
export const SERIES_BIN_MS = 1_000;
export const MAX_SERIES_POINTS = 180;

export interface Metric {
  /** Logical requests offered in the evaluation window (warmup excluded). */
  offered: number;
  succeeded: number;
  /** Failed includes timeouts, queue overflow and dependency failures. */
  failed: number;
  /** Not yet completed at snapshot time; pending is never counted as success. */
  pending: number;
  /** Percentiles over successful requests only; null means "no data" (—). */
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  /** Error breakdown by stable code, e.g. { timeout: 3, queue_overflow: 1 }. */
  errors: Record<string, number>;
}

/**
 * Per-node view. `busy`, `queued`, `poolBusy`, `poolQueued` are instantaneous;
 * `hits`, `misses`, `coalesced`, `errors`, `maxQueued`, `completed` are
 * cumulative since the evaluation start (warmup metrics are reset, resource
 * state such as cached entries is retained).
 */
export interface NodeMetric {
  nodeId: string;
  busy: number;
  queued: number;
  poolBusy: number;
  poolQueued: number;
  hits: number;
  misses: number;
  coalesced: number;
  errors: number;
  maxQueued: number;
  completed: number;
  /** Evaluation-only resource evidence; absent in older snapshots/test fixtures. */
  pressure?: {
    /** Observed evaluation time, excluding warmup and drain. */
    observedMs: number;
    busyPeak: number;
    poolBusyPeak: number;
    poolQueuedPeak: number;
    /** Time-weighted occupied slots/connections, not percentages. */
    busyAvg: number;
    poolBusyAvg: number;
    /** Failure location at the instant of rejection/deadline, not inferred root cause. */
    failures: Array<{ code: string; stage: string; count: number }>;
  };
}

/**
 * One bin of the time series. `timeMs` is the evaluation-relative bin start
 * (negative during warmup). Rates are per-second values for that bin; totals
 * are cumulative since evaluation start. `p95Ms` covers successful requests in
 * the bin only, and `hitRatio` is null when the bin had no cache lookups.
 * `dbQueue` is the peak database queue depth observed in the bin.
 */
export interface SeriesPoint {
  timeMs: number;
  readRps: number;
  writeRps: number;
  successRps: number;
  errorRps: number;
  p95Ms: number | null;
  dbQueue: number;
  hitRatio: number | null;
}

export type SimulationPhase = 'warmup' | 'running' | 'draining' | 'completed';

export interface SimulationEvent {
  /** Evaluation-relative time; flush events precede arrivals/completions at the same time. */
  timeMs: number;
  message: string;
  nodeId?: string;
}

/**
 * Immutable-by-convention snapshot sent to the UI (and returned by
 * `advance`). `timeMs` is evaluation-relative and starts at `-warmupMs`; the
 * final snapshot is at `durationMs + drainMs`. `reads`/`writes` are cumulative
 * evaluation metrics (warmup excluded). `series` has at most one point per
 * second and at most `MAX_SERIES_POINTS` points.
 */
export interface SimulationSnapshot {
  timeMs: number;
  phase: SimulationPhase;
  reads: Metric;
  writes: Metric;
  nodes: NodeMetric[];
  series: SeriesPoint[];
  events: SimulationEvent[];
}

export interface SloCheck {
  id: string;
  /** Player-facing label. */
  label: string;
  /** Actual value in `unit`; null when there is no data (unknown/fail). */
  actual: number | null;
  target: number;
  /** Percentages are 0..100; cost actual is USD (converted from micro-USD). */
  unit: '%' | 'ms' | '$/h';
  passed: boolean;
}

export interface Diagnostic {
  severity: 'info' | 'warning' | 'error';
  message: string;
  nodeId?: string;
}

export interface RunResult {
  seed: number;
  passed: boolean;
  /** Canonical integer micro-USD/h; convert with `microUsdToUsd` for display. */
  costMicroUsdPerHour: number;
  checks: SloCheck[];
  snapshot: SimulationSnapshot;
  diagnostics: Diagnostic[];
}
