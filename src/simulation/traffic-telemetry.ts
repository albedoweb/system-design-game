/** Optional browser telemetry. Never part of scoring, persisted graphs or API results. */
export interface TrafficResource {
  readonly key: string;
  readonly label: string;
  /** CPU/IO/network normally use interval averages; RAM and out-of-window samples may be instant. */
  readonly aggregation?: 'window-average' | 'instant';
  readonly used: number | null;
  /** null means the model defines no capacity; do not invent a utilization percentage. */
  readonly capacity: number | null;
  readonly unit: 'slots' | 'connections' | 'cores' | 'lanes' | 'bytes' | 'gbit/s';
}

export interface TrafficNode {
  readonly nodeId: string;
  readonly resources: readonly TrafficResource[];
  readonly requestsPerSecond: number | null;
  readonly queue: number | null;
  readonly down: boolean;
}

export interface TrafficEdge {
  readonly edgeId: string;
  /** One count per actual logical traversal attempt, including retries; not successes. */
  readonly requestsPerSecond: number;
  /** Only set when actual transferred bytes are attributed to this logical route. */
  readonly bytesPerSecond: number | null;
}

export interface TrafficFrame {
  readonly levelId:
    | 'cold-cache'
    | 'parcel-pulse'
    | 'image-atlas'
    | 'live-scoreboard'
    | 'live-audience';
  /** cold-cache, year-1/year-5, or an Image Atlas scenario name. */
  readonly scopeId: string;
  readonly scopeLabel: string;
  /** End of the sampled interval, after events at this time. Zero is the start of measurement. */
  readonly timeMs: number;
  /** Actual elapsed interval, including a shorter final interval; rates use this denominator. */
  readonly windowMs: number;
  readonly phase: 'warmup' | 'measured' | 'drain' | 'postlude';
  readonly nodes: readonly TrafficNode[];
  readonly edges: readonly TrafficEdge[];
}

export type TrafficObserver = (frame: TrafficFrame) => void;

export interface TrafficMessage {
  readonly type: 'traffic';
  readonly runId: string;
  readonly frame: TrafficFrame;
}

/** Bound observer cost and memory independently of traffic volume. */
export const TRAFFIC_INTERVAL_MS = 1_000;
export const TRAFFIC_MAX_FRAMES_PER_SCOPE = 240;
