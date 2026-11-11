import {
  MAX_SERIES_POINTS,
  SERIES_BIN_MS,
  type Metric,
  type SeriesPoint,
} from '../domain/simulation';

/** Exact nearest-rank percentile; `null` when there are no samples. */
export function nearestRank(
  values: readonly number[],
  percentile: number,
): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? null;
}

/** Scored (non-warmup) counters for one traffic class. */
export class ClassMetrics {
  offered = 0;
  succeeded = 0;
  failed = 0;
  readonly errors: Record<string, number> = {};
  readonly latencies: number[] = [];

  criticalOffered = 0;
  criticalSucceeded = 0;
  criticalFailed = 0;
  readonly criticalLatencies: number[] = [];

  recordOffered(critical: boolean): void {
    this.offered += 1;
    if (critical) {
      this.criticalOffered += 1;
    }
  }

  recordSuccess(latencyMs: number, critical: boolean): void {
    this.succeeded += 1;
    this.latencies.push(latencyMs);
    if (critical) {
      this.criticalSucceeded += 1;
      this.criticalLatencies.push(latencyMs);
    }
  }

  recordFailure(code: string, critical: boolean): void {
    this.failed += 1;
    this.errors[code] = (this.errors[code] ?? 0) + 1;
    if (critical) {
      this.criticalFailed += 1;
    }
  }

  toMetric(): Metric {
    return {
      offered: this.offered,
      succeeded: this.succeeded,
      failed: this.failed,
      pending: Math.max(0, this.offered - this.succeeded - this.failed),
      p50Ms: nearestRank(this.latencies, 50),
      p95Ms: nearestRank(this.latencies, 95),
      p99Ms: nearestRank(this.latencies, 99),
      errors: { ...this.errors },
    };
  }
}

interface SeriesBin {
  arrivalsRead: number;
  arrivalsWrite: number;
  successes: number;
  errors: number;
  latencies: number[];
  lookups: number;
  hits: number;
  dbQueuePeak: number;
}

/**
 * Per-second telemetry bins. Arrival rates use logical arrival time, success
 * and error rates use completion time, latencies cover successes completed in
 * the bin, hit ratio uses cache lookups started in the bin, and `dbQueue` is
 * the peak database queue depth observed in the bin.
 */
export class Telemetry {
  private readonly bins: SeriesBin[] = [];
  /** Start of the interval whose depth is `lastQueueDepth`. */
  private lastQueueTime = 0;
  private lastQueueDepth = 0;

  constructor(durationMs: number, drainMs: number) {
    const count = Math.min(
      MAX_SERIES_POINTS,
      Math.floor((durationMs + drainMs) / SERIES_BIN_MS) + 1,
    );
    for (let index = 0; index < count; index += 1) {
      this.bins.push({
        arrivalsRead: 0,
        arrivalsWrite: 0,
        successes: 0,
        errors: 0,
        latencies: [],
        lookups: 0,
        hits: 0,
        dbQueuePeak: 0,
      });
    }
  }

  private binAt(timeMs: number): SeriesBin | undefined {
    if (timeMs < 0) {
      return undefined;
    }
    return this.bins[Math.floor(timeMs / SERIES_BIN_MS)];
  }

  recordArrival(trafficClass: 'read' | 'write', timeMs: number): void {
    const bin = this.binAt(timeMs);
    if (!bin) {
      return;
    }
    if (trafficClass === 'read') {
      bin.arrivalsRead += 1;
    } else {
      bin.arrivalsWrite += 1;
    }
  }

  recordCompletion(timeMs: number, latencyMs: number | null): void {
    const bin = this.binAt(timeMs);
    if (!bin) {
      return;
    }
    if (latencyMs === null) {
      bin.errors += 1;
    } else {
      bin.successes += 1;
      bin.latencies.push(latencyMs);
    }
  }

  recordLookup(timeMs: number, hit: boolean): void {
    const bin = this.binAt(timeMs);
    if (!bin) {
      return;
    }
    bin.lookups += 1;
    if (hit) {
      bin.hits += 1;
    }
  }

  /** Raise every bin overlapping the half-open interval `[fromMs, toMs)`. */
  private raiseQueuePeak(fromMs: number, toMs: number, depth: number): void {
    if (depth <= 0 || toMs <= fromMs) {
      return;
    }
    // `toMs` is exclusive: a change exactly at a bin boundary belongs to the
    // next bin only, so the previous depth must not be counted there.
    const firstBin = Math.floor(fromMs / SERIES_BIN_MS);
    const lastBin = Math.ceil(toMs / SERIES_BIN_MS) - 1;
    for (let index = firstBin; index <= lastBin; index += 1) {
      const bin = this.bins[index];
      if (bin && depth > bin.dbQueuePeak) {
        bin.dbQueuePeak = depth;
      }
    }
  }

  /**
   * Record the current database queue depth at `timeMs`. The depth observed
   * previously is a step function that lasts until this observation, so every
   * bin it overlaps — including the part of the current bin before `timeMs` —
   * inherits it. Extra `sync` calls with an unchanged depth are therefore
   * idempotent and cannot change peaks.
   */
  recordDbQueue(timeMs: number, depth: number): void {
    if (timeMs < 0) {
      return;
    }
    const at = Math.max(timeMs, this.lastQueueTime);
    this.raiseQueuePeak(this.lastQueueTime, at, this.lastQueueDepth);
    const current = this.binAt(at);
    if (current && depth > current.dbQueuePeak) {
      current.dbQueuePeak = depth;
    }
    this.lastQueueTime = at;
    this.lastQueueDepth = depth;
  }

  /** Keep the peak meaningful for a bin entered without a queue change. */
  sync(timeMs: number, dbQueueDepth: number): void {
    this.recordDbQueue(timeMs, dbQueueDepth);
  }

  series(nowMs: number): SeriesPoint[] {
    const points: SeriesPoint[] = [];
    for (let index = 0; index < this.bins.length; index += 1) {
      const start = index * SERIES_BIN_MS;
      if (start > nowMs) {
        break;
      }
      const elapsed = Math.min(nowMs, start + SERIES_BIN_MS) - start;
      if (elapsed <= 0) {
        continue;
      }
      const bin = this.bins[index];
      if (!bin) {
        continue;
      }
      const seconds = elapsed / 1000;
      points.push({
        timeMs: start,
        readRps: bin.arrivalsRead / seconds,
        writeRps: bin.arrivalsWrite / seconds,
        successRps: bin.successes / seconds,
        errorRps: bin.errors / seconds,
        p95Ms: nearestRank(bin.latencies, 95),
        dbQueue: bin.dbQueuePeak,
        hitRatio: bin.lookups > 0 ? bin.hits / bin.lookups : null,
      });
    }
    return points;
  }
}
