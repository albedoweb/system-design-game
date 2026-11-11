import type { AudienceLatency } from '../contracts';

/** Shape of one `AudienceSeriesPoint.latency.ingest|read` entry. */
export interface SeriesLatency {
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly samples: number;
}

/** Growable exact sample buffer for percentiles. */
export class LatencySamples {
  private data = new Float64Array(1_024);
  private size = 0;

  get count(): number {
    return this.size;
  }

  add(value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    if (this.size >= this.data.length) {
      const grown = new Float64Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.size] = value;
    this.size += 1;
  }

  /** Sorted copy; callers own it. */
  sorted(): Float64Array {
    const copy = this.data.slice(0, this.size);
    copy.sort();
    return copy;
  }

  summary(minimumSamples: number): AudienceLatency {
    const sorted = this.sorted();
    return {
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      maxMs: sorted.length === 0 ? null : (sorted[sorted.length - 1] ?? 0),
      samples: sorted.length,
      insufficientSamples: sorted.length < minimumSamples,
    };
  }

  series(): SeriesLatency | null {
    if (this.size === 0) {
      return null;
    }
    const sorted = this.sorted();
    return {
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      samples: sorted.length,
    };
  }
}

/** Nearest-rank percentile on an ascending array; null for no samples. */
export function percentile(
  sorted: Float64Array,
  percentileValue: number,
): number | null {
  const count = sorted.length;
  if (count === 0) {
    return null;
  }
  const rank = Math.min(
    count - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * count) - 1),
  );
  return sorted[rank] ?? null;
}

/** Counts one event per second bucket without retaining per-event history. */
export class SecondBuckets {
  private readonly offered: Int32Array;
  private readonly succeeded: Int32Array;
  private readonly failed: Int32Array;

  constructor(readonly count: number) {
    this.offered = new Int32Array(count);
    this.succeeded = new Int32Array(count);
    this.failed = new Int32Array(count);
  }

  offer(bucket: number): void {
    if (bucket < 0 || bucket >= this.count) {
      return;
    }
    this.offered[bucket] = (this.offered[bucket] ?? 0) + 1;
  }

  settle(bucket: number, succeeded: boolean): void {
    if (bucket < 0 || bucket >= this.count) {
      return;
    }
    if (succeeded) {
      this.succeeded[bucket] = (this.succeeded[bucket] ?? 0) + 1;
    } else {
      this.failed[bucket] = (this.failed[bucket] ?? 0) + 1;
    }
  }

  read(bucket: number): {
    offered: number;
    succeeded: number;
    failed: number;
  } {
    if (bucket < 0 || bucket >= this.count) {
      return { offered: 0, succeeded: 0, failed: 0 };
    }
    return {
      offered: this.offered[bucket] ?? 0,
      succeeded: this.succeeded[bucket] ?? 0,
      failed: this.failed[bucket] ?? 0,
    };
  }
}

/** Per-second bucket of latency samples, bounded by the measured duration. */
export class LatencyBuckets {
  private readonly buckets: LatencySamples[];

  constructor(count: number) {
    this.buckets = Array.from({ length: count }, () => new LatencySamples());
  }

  add(bucket: number, value: number): void {
    const target = this.buckets[bucket];
    if (target !== undefined) {
      target.add(value);
    }
  }

  series(bucket: number): SeriesLatency | null {
    return this.buckets[bucket]?.series() ?? null;
  }
}

/** Clamp a ratio into [0, 1] without inventing precision. */
export function boundedRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  const value = numerator / denominator;
  if (value <= 0) {
    return 0;
  }
  return value >= 1 ? 1 : value;
}

/** Time-weighted mean that can never exceed the observed peak. */
export function boundedAverage(
  integral: number,
  windowMs: number,
  peak: number,
): number {
  if (!Number.isFinite(integral) || !Number.isFinite(windowMs) || windowMs <= 0) {
    return 0;
  }
  const average = integral / windowMs;
  if (average <= 0) {
    return 0;
  }
  return average > peak ? peak : average;
}
