import type { NodeMetric } from '../domain/simulation';

type NodePressure = NonNullable<NodeMetric['pressure']>;

interface PressureFailure {
  code: string;
  stage: string;
  count: number;
}

interface PressureState {
  /** Last evaluation time already integrated into the accumulators. */
  lastAt: number;
  busyTimeMs: number;
  poolBusyTimeMs: number;
  busy: number;
  poolBusy: number;
  poolQueued: number;
  busyPeak: number;
  poolBusyPeak: number;
  poolQueuedPeak: number;
  readonly failures: Map<string, PressureFailure>;
}

function emptyState(): PressureState {
  return {
    lastAt: 0,
    busyTimeMs: 0,
    poolBusyTimeMs: 0,
    busy: 0,
    poolBusy: 0,
    poolQueued: 0,
    busyPeak: 0,
    poolBusyPeak: 0,
    poolQueuedPeak: 0,
    failures: new Map(),
  };
}

/** Keep averages deterministic and readable across JSON boundaries. */
function roundAverage(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Exact evaluation-window resource pressure.
 *
 * Gauges are observed only when the engine changes them, at the event time.
 * Intervals are integrated lazily from those changes, so snapshot frequency
 * (worker quanta, advance chunk size, one-shot runs) cannot change the result.
 * Warmup is not integrated; the interval closes at `durationMs` and drain is
 * ignored. Each node carries at most a handful of numeric counters and a tiny
 * map of failure tuples.
 */
export class PressureTracker {
  private readonly states = new Map<string, PressureState>();
  private readonly endMs: number;
  private active = false;

  constructor(nodeIds: Iterable<string>, endMs: number) {
    this.endMs = endMs;
    for (const nodeId of nodeIds) {
      this.states.set(nodeId, emptyState());
    }
  }

  /** Start evaluation observation at `atMs` (normally 0), resetting history. */
  begin(atMs: number): void {
    this.active = true;
    for (const state of this.states.values()) {
      state.lastAt = atMs;
      state.busyTimeMs = 0;
      state.poolBusyTimeMs = 0;
      state.busy = 0;
      state.poolBusy = 0;
      state.poolQueued = 0;
      state.busyPeak = 0;
      state.poolBusyPeak = 0;
      state.poolQueuedPeak = 0;
      state.failures.clear();
    }
  }

  /**
   * Record the gauges after a change at `atMs`. Callers pass absolute runtime
   * values, so out-of-order or duplicate observations at one timestamp are
   * harmless: zero-length intervals contribute nothing.
   */
  update(
    nodeId: string,
    atMs: number,
    busy: number,
    poolBusy: number,
    poolQueued: number,
  ): void {
    if (!this.active) {
      return;
    }
    const state = this.states.get(nodeId);
    if (!state) {
      return;
    }

    const until = Math.min(atMs, this.endMs);
    if (until > state.lastAt) {
      const span = until - state.lastAt;
      state.busyTimeMs += span * state.busy;
      state.poolBusyTimeMs += span * state.poolBusy;
      state.lastAt = until;
    }

    state.busy = Math.max(0, busy);
    state.poolBusy = Math.max(0, poolBusy);
    state.poolQueued = Math.max(0, poolQueued);

    // A change exactly at the end starts no evaluation interval.
    if (atMs < this.endMs) {
      if (state.busy > state.busyPeak) {
        state.busyPeak = state.busy;
      }
      if (state.poolBusy > state.poolBusyPeak) {
        state.poolBusyPeak = state.poolBusy;
      }
      if (state.poolQueued > state.poolQueuedPeak) {
        state.poolQueuedPeak = state.poolQueued;
      }
    }
  }

  /** One scored request contributes exactly one observed failure location. */
  recordFailure(nodeId: string, code: string, stage: string): void {
    if (!this.active) {
      return;
    }
    const state = this.states.get(nodeId);
    if (!state) {
      return;
    }
    const key = `${stage}\u0000${code}`;
    const existing = state.failures.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      state.failures.set(key, { code, stage, count: 1 });
    }
  }

  /**
   * Immutable view for a snapshot. Reading never advances the observation
   * history, so repeated snapshots and coarse/fine advances stay identical.
   * Non-capacity nodes only expose pressure when they hold failure evidence.
   */
  report(
    nodeId: string,
    nowMs: number,
    relevant: boolean,
  ): NodePressure | undefined {
    const state = this.states.get(nodeId);
    if (!state) {
      return undefined;
    }
    if (!this.active) {
      return relevant
        ? {
            observedMs: 0,
            busyPeak: 0,
            poolBusyPeak: 0,
            poolQueuedPeak: 0,
            busyAvg: 0,
            poolBusyAvg: 0,
            failures: [],
          }
        : undefined;
    }
    if (!relevant && state.failures.size === 0) {
      return undefined;
    }

    const observedMs = Math.max(0, Math.min(nowMs, this.endMs));
    const openMs = Math.max(0, observedMs - state.lastAt);
    const busyTimeMs = state.busyTimeMs + openMs * state.busy;
    const poolBusyTimeMs = state.poolBusyTimeMs + openMs * state.poolBusy;
    const failures = [...state.failures.values()]
      .sort((left, right) =>
        left.stage === right.stage
          ? compareText(left.code, right.code)
          : compareText(left.stage, right.stage),
      )
      .map((failure) => ({ ...failure }));

    return {
      observedMs,
      busyPeak: state.busyPeak,
      poolBusyPeak: state.poolBusyPeak,
      poolQueuedPeak: state.poolQueuedPeak,
      busyAvg: observedMs > 0 ? roundAverage(busyTimeMs / observedMs) : 0,
      poolBusyAvg: observedMs > 0 ? roundAverage(poolBusyTimeMs / observedMs) : 0,
      failures,
    };
  }
}
