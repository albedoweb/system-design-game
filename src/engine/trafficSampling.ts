import {
  TRAFFIC_INTERVAL_MS,
  TRAFFIC_MAX_FRAMES_PER_SCOPE,
  type TrafficEdge,
  type TrafficFrame,
  type TrafficNode,
  type TrafficObserver,
} from '../simulation/traffic-telemetry';

/**
 * Shared, observational sampling for the three playable level engines.
 *
 * Nothing in this module is part of scoring, persistence or an API result. It
 * only counts dispatches that already happened and reads gauges that the engine
 * already maintains. Sampling never schedules scheduler events, never advances
 * a clock, never consumes RNG state and never mutates an engine accumulator.
 */
export interface TrafficScope {
  readonly levelId: TrafficFrame['levelId'];
  readonly scopeId: string;
  readonly scopeLabel: string;
  /** Absolute engine time where sampling starts (may be negative warmup). */
  readonly startMs: number;
  /** Engine time that measurement starts at; frame `timeMs` is relative to it. */
  readonly measuredFromMs: number;
  readonly measuredEndMs: number;
  readonly drainEndMs: number;
  readonly postludeEndMs: number;
}

/**
 * One frame per virtual second for every shipped run. A pathological run longer
 * than the frame cap stretches the interval instead of exceeding the bound.
 */
export function trafficSampleStepMs(scope: TrafficScope): number {
  const span = Math.max(1, scope.postludeEndMs - scope.startMs);
  const buckets = Math.ceil(
    span / (TRAFFIC_INTERVAL_MS * TRAFFIC_MAX_FRAMES_PER_SCOPE),
  );
  return TRAFFIC_INTERVAL_MS * Math.max(1, buckets);
}

export function trafficPhaseAt(
  boundaryMs: number,
  scope: TrafficScope,
): TrafficFrame['phase'] {
  // The interval that ends exactly at the measurement start covers only
  // warm-up; it must not be labelled as the first measured interval.
  if (boundaryMs <= scope.measuredFromMs) {
    return 'warmup';
  }
  if (boundaryMs <= scope.measuredEndMs) {
    return 'measured';
  }
  if (boundaryMs <= scope.drainEndMs) {
    return 'drain';
  }
  return 'postlude';
}

/** Non-negative finite per-second rate for an observed interval. */
export function trafficRate(observed: number, windowMs: number): number {
  if (!(windowMs > 0) || !Number.isFinite(observed) || observed <= 0) {
    return 0;
  }
  const rate = (observed * 1000) / windowMs;
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

export interface TrafficFrameContext {
  readonly timeMs: number;
  readonly windowMs: number;
  readonly phase: TrafficFrame['phase'];
  /** Per-second logical dispatches observed in this interval. */
  edgeRps(edgeId: string): number;
  nodeRps(nodeId: string): number;
}

export interface TrafficFrameParts {
  readonly nodes: readonly TrafficNode[];
  readonly edges: readonly TrafficEdge[];
}

export type TrafficFrameBuilder = (
  context: TrafficFrameContext,
) => TrafficFrameParts;

/**
 * Bounded cumulative counters plus the previous sample used to derive rates.
 * Maps are initialized once with every edge/node id, so an unused edge is
 * reported as an honest zero and no per-request trace is retained.
 */
export class TrafficSampler {
  private lastMs: number;
  private emitted = 0;
  private readonly edgeCounts = new Map<string, number>();
  private readonly nodeCounts = new Map<string, number>();
  private readonly previousEdges = new Map<string, number>();
  private readonly previousNodes = new Map<string, number>();

  constructor(
    edgeIds: readonly string[],
    nodeIds: readonly string[],
    private readonly scope: TrafficScope,
  ) {
    this.lastMs = scope.startMs;
    for (const id of edgeIds) {
      this.edgeCounts.set(id, 0);
      this.previousEdges.set(id, 0);
    }
    for (const id of nodeIds) {
      this.nodeCounts.set(id, 0);
      this.previousNodes.set(id, 0);
    }
  }

  get lastSampleMs(): number {
    return this.lastMs;
  }

  get frameCount(): number {
    return this.emitted;
  }

  countEdge(edgeId: string): void {
    const current = this.edgeCounts.get(edgeId);
    if (current !== undefined) {
      this.edgeCounts.set(edgeId, current + 1);
    }
  }

  countNode(nodeId: string): void {
    const current = this.nodeCounts.get(nodeId);
    if (current !== undefined) {
      this.nodeCounts.set(nodeId, current + 1);
    }
  }

  /**
   * Interval ending at `nowMs`, after every event at that timestamp. Returns
   * null for a non-advancing read or once the frame cap is reached, so a caller
   * can never flood the consumer.
   */
  sample(nowMs: number, build: TrafficFrameBuilder): TrafficFrame | null {
    if (this.emitted >= TRAFFIC_MAX_FRAMES_PER_SCOPE) {
      return null;
    }
    if (!(nowMs > this.lastMs) || !Number.isFinite(nowMs)) {
      return null;
    }
    const windowMs = nowMs - this.lastMs;
    const edgeRps = (edgeId: string): number => {
      const current = this.edgeCounts.get(edgeId) ?? 0;
      return trafficRate(
        current - (this.previousEdges.get(edgeId) ?? 0),
        windowMs,
      );
    };
    const nodeRps = (nodeId: string): number => {
      const current = this.nodeCounts.get(nodeId) ?? 0;
      return trafficRate(
        current - (this.previousNodes.get(nodeId) ?? 0),
        windowMs,
      );
    };
    const parts = build({
      timeMs: nowMs - this.scope.measuredFromMs,
      windowMs,
      phase: trafficPhaseAt(nowMs, this.scope),
      edgeRps,
      nodeRps,
    });
    for (const [id, value] of this.edgeCounts) {
      this.previousEdges.set(id, value);
    }
    for (const [id, value] of this.nodeCounts) {
      this.previousNodes.set(id, value);
    }
    this.lastMs = nowMs;
    this.emitted += 1;
    return {
      levelId: this.scope.levelId,
      scopeId: this.scope.scopeId,
      scopeLabel: this.scope.scopeLabel,
      timeMs: nowMs - this.scope.measuredFromMs,
      windowMs,
      phase: trafficPhaseAt(nowMs, this.scope),
      nodes: parts.nodes,
      edges: parts.edges,
    };
  }
}

/**
 * Observer failures are diagnostics, never simulation control flow: a broken
 * consumer must not change scheduling, results or the remaining frame stream.
 */
export function notifyTraffic(
  observer: TrafficObserver | undefined,
  frame: TrafficFrame,
): void {
  if (!observer) {
    return;
  }
  try {
    observer(frame);
  } catch {
    // Deliberately ignored; the engine keeps its own deterministic timeline.
  }
}
