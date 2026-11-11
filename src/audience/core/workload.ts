import type { AudienceReadPhase } from '../contracts';
import type { AudienceModel } from './model';
import { audienceHazard, createAudienceStream, type AudienceRng } from './rng';

/**
 * Frozen, graph-independent input for Live Audience.
 *
 * The generator is disclosed because it decides what "distinct viewers" means:
 *
 * - The 1,000,000 ids are the registered population; the first half is the
 *   active viewing population for one 15-minute window. Every id remains a
 *   valid viewer, so population size is a dataset fact, not a per-run draw.
 * - Each active viewer has one favourite stream (id modulo stream count) and
 *   spills to a uniformly random stream for roughly one event in five. That
 *   produces repeated viewers, per-user stream changes and genuine distinct
 *   counting instead of an all-unique workload where distinct equals count.
 * - Prehistory arrivals are a Poisson process conditioned on exactly the
 *   dataset event count inside the 15-minute window, so the promised 1.8M rows
 *   and 230.4 MB of raw data are really present.
 * - Measured ingest arrivals are a Poisson process at the level rate. Read
 *   arrivals use one Poisson process per declared phase.
 *
 * Identity draws, favourite-stream spills, ingest arrivals and read arrivals
 * use separate random streams, so no design can change the offered trace.
 */

const FAVOURITE_SHARE = 0.8;
/** Fraction of the registered population active inside one 15-minute window. */
const ACTIVE_VIEWER_SHARE = 0.5;

export interface AudienceIngestTrace {
  /** Event id equals the array index; retries reuse it. */
  readonly count: number;
  readonly timesMs: Float64Array;
  readonly users: Int32Array;
  readonly streams: Uint8Array;
  /** `user * streams + stream`, fits in a positive int32. */
  readonly pairs: Int32Array;
}

export interface AudienceReadTrace {
  readonly count: number;
  readonly timesMs: Float64Array;
}

export function activeViewers(model: AudienceModel): number {
  const users = model.level.dataset.users;
  return Math.max(1, Math.round(users * ACTIVE_VIEWER_SHARE));
}

export function pairKeyFor(user: number, stream: number, streams: number): number {
  return user * streams + stream;
}

function drawStream(
  user: number,
  streams: number,
  streamRng: AudienceRng,
  spillRng: AudienceRng,
): number {
  if (streamRng.nextUnit() < FAVOURITE_SHARE) {
    return user % streams;
  }
  return spillRng.nextBelow(streams);
}

/**
 * Open-addressed int32 table. `0` marks an empty slot, so keys are stored
 * pre-incremented. Used for the one-off prehistory aggregation where a `Map`
 * would cost hundreds of megabytes at this scale.
 */
export class Int32KeyTable {
  private readonly slots: Int32Array;
  private readonly mask: number;
  private filled = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 2) {
      throw new RangeError('table capacity must be an integer >= 2');
    }
    let size = 2;
    while (size < capacity) {
      size *= 2;
    }
    this.slots = new Int32Array(size);
    this.mask = size - 1;
  }

  get count(): number {
    return this.filled;
  }

  /** Slot count of the current backing store (a memory-shape witness). */
  get capacity(): number {
    return this.slots.length;
  }

  /** A new empty table sized for `entries` keys at `loadFactor`. */
  static sizedFor(entries: number, loadFactor = 0.7): Int32KeyTable {
    if (!(loadFactor > 0 && loadFactor < 1)) {
      throw new RangeError('compact load factor must be between 0 and 1');
    }
    if (!Number.isInteger(entries) || entries < 0) {
      throw new RangeError('table entry count must be a non-negative integer');
    }
    return new Int32KeyTable(Math.max(2, Math.ceil(entries / loadFactor)));
  }

  /**
   * Stored key at a backing slot (`key + 1`), or `0` for an empty slot.
   * Exposed so a builder can walk an old table under its own step budget.
   */
  storedAt(index: number): number {
    return this.slots[index] ?? 0;
  }

  /**
   * Re-packs the same keys into a table sized for the now-known key count.
   *
   * The builder must over-provision before it knows how many distinct pairs
   * the trace contains. Once counting is done, the load-factor table keeps
   * exact `has()` semantics while releasing the pre-count allocation. This is
   * a pure representation change: no key is added, removed or reordered.
   *
   * The production builder does not call this in one slice; it uses the same
   * `sizedFor` / `storedAt` primitives from a cooperative `compact` stage.
   */
  compact(loadFactor = 0.7): Int32KeyTable {
    const compacted = Int32KeyTable.sizedFor(this.filled, loadFactor);
    for (let index = 0; index < this.slots.length; index += 1) {
      const stored = this.storedAt(index);
      if (stored !== 0) {
        compacted.add(stored - 1);
      }
    }
    if (compacted.filled !== this.filled) {
      throw new Error(
        `compacted table lost keys: ${compacted.filled} != ${this.filled}`,
      );
    }
    return compacted;
  }

  /** True when the key was already present. */
  add(key: number): boolean {
    if (!Number.isInteger(key) || key < 0 || key >= 2_147_483_646) {
      throw new RangeError('table key must be a non-negative int32');
    }
    const stored = key + 1;
    let index = Math.imul(stored, 0x9e3779b1) >>> 0;
    index &= this.mask;
    for (;;) {
      const current = this.slots[index];
      if (current === 0) {
        this.slots[index] = stored;
        this.filled += 1;
        return false;
      }
      if (current === stored) {
        return true;
      }
      index = (index + 1) & this.mask;
    }
  }

  has(key: number): boolean {
    const stored = key + 1;
    let index = Math.imul(stored, 0x9e3779b1) >>> 0;
    index &= this.mask;
    for (;;) {
      const current = this.slots[index];
      if (current === 0) {
        return false;
      }
      if (current === stored) {
        return true;
      }
      index = (index + 1) & this.mask;
    }
  }
}

/**
 * Exact distinct-pair state at the measured origin plus every pair expiry that
 * can happen while the case is still answering queries.
 *
 * - `counts[stream]`: distinct `(user, stream)` pairs active in the open-left
 *   window `(origin - window, origin]`.
 * - `pairs`: membership of the prehistory pair set.
 * - `pairKeys` / `pairLastMs`: every prehistory pair with its last activity,
 *   sorted by ascending last activity. This is the retained raw prehistory the
 *   independent auditor scans; it is not derived from any ranking response.
 * - `expiryEndsMs` / `expiryKeys` / `expiryStreams`: sorted case-clock instants
 *   at which one pair leaves the window if it never renews.
 */
export interface AudienceBaseHistory {
  readonly counts: Int32Array;
  readonly totalPairs: number;
  readonly pairs: Int32KeyTable;
  readonly pairKeys: Int32Array;
  readonly pairLastMs: Float64Array;
  /** All raw prehistory event instants, ascending: the real scanned rows. */
  readonly eventTimesMs: Float64Array;
  readonly expiryEndsMs: Float64Array;
  readonly expiryKeys: Int32Array;
  readonly expiryStreams: Uint8Array;
  readonly prehistoryEvents: number;
  readonly prehistoryDistinctPairs: number;
  readonly provisionDiskMs: number;
  readonly provisionBytes: number;
}

type BuildStage = 'events' | 'scan' | 'compact' | 'assemble' | 'done';

/**
 * Cooperative prehistory builder. One `step(budget)` performs at most `budget`
 * unit operations, so a browser worker can paint between slices instead of
 * blocking for seconds on 1.8M generated rows.
 */
export class AudiencePrehistoryBuilder {
  private stage: BuildStage = 'events';
  private cursor = 0;
  private readonly total: number;
  private readonly timesMs: Float64Array;
  /**
   * Event-level pair keys for generation/scan/assembly. Released once the
   * retained `pairKeys` are written: the measured run never reads this 1.8M
   * buffer again, so keeping it for the whole session is pure residency.
   */
  private pairs: Int32Array | null;
  private readonly arrivals: AudienceRng;
  private readonly usersRng: AudienceRng;
  private readonly streamRng: AudienceRng;
  private readonly spillRng: AudienceRng;
  private readonly active: number;
  private readonly windowMs: number;
  private readonly streams: number;

  private seen: Int32KeyTable;
  /** Old/target tables live together only until the compact stage finishes. */
  private compactSource: Int32KeyTable | null = null;
  private compactTarget: Int32KeyTable | null = null;
  private compactSlotCount = 0;
  private readonly counts: Int32Array;
  /** 1 when the event at this index is the last prehistory activity of a pair. */
  private isLastOccurrence: Uint8Array | null = null;

  private expiryKeysBuild: Int32Array;
  private expiryEndsBuild: Float64Array;
  private expiryStreamsBuild: Uint8Array;
  private expiryCount = 0;

  private pairKeysBuild: Int32Array | null = null;
  private pairLastBuild: Float64Array | null = null;
  private pairCount = 0;
  private pairWritten = 0;

  private cumulative: Float64Array | null = null;
  private cumulativeSum = 0;
  private base: AudienceBaseHistory | null = null;

  constructor(
    private readonly model: AudienceModel,
    seed: number,
  ) {
    this.windowMs = model.level.dataset.activityWindowMs;
    this.streams = model.level.dataset.streams;
    this.active = activeViewers(model);
    this.total = model.level.dataset.prehistoryEvents;
    this.timesMs = new Float64Array(this.total);
    this.pairs = new Int32Array(this.total);
    this.isLastOccurrence = new Uint8Array(this.total);
    this.arrivals = createAudienceStream(seed, 'prehistory-arrivals');
    this.usersRng = createAudienceStream(seed, 'prehistory-users');
    this.streamRng = createAudienceStream(seed, 'prehistory-stream-choices');
    this.spillRng = createAudienceStream(seed, 'prehistory-stream-spills');
    this.seen = new Int32KeyTable(Math.max(16, Math.ceil(this.total * 2.4)));
    this.counts = new Int32Array(this.streams);
    this.expiryKeysBuild = new Int32Array(1_024);
    this.expiryEndsBuild = new Float64Array(1_024);
    this.expiryStreamsBuild = new Uint8Array(1_024);
  }

  get done(): boolean {
    return this.stage === 'done';
  }

  get progress(): number {
    switch (this.stage) {
      case 'events':
        return this.total === 0 ? 0 : (this.cursor / this.total) * 0.5;
      case 'scan':
        return this.total === 0
          ? 0.5
          : 0.5 + (this.cursor / this.total) * 0.3;
      case 'compact':
        return this.compactSlotCount === 0
          ? 0.8
          : 0.8 + (this.cursor / this.compactSlotCount) * 0.1;
      case 'assemble':
        return this.total === 0
          ? 0.9
          : 0.9 + (this.cursor / this.total) * 0.1;
      default:
        return 1;
    }
  }

  get baseHistory(): AudienceBaseHistory {
    if (this.base === null) {
      throw new Error('prehistory is not built yet');
    }
    return this.base;
  }

  /** Performs at most `budget` unit operations. Returns true when finished. */
  step(budget = 20_000): boolean {
    let remaining = Math.max(1, budget);
    let guard = 0;
    while (remaining > 0 && this.stage !== 'done') {
      guard += 1;
      if (guard > 10_000) {
        break;
      }
      switch (this.stage) {
        case 'events':
          remaining = this.buildEvents(remaining);
          break;
        case 'scan':
          remaining = this.scanBackwards(remaining);
          break;
        case 'compact':
          remaining = this.compactMembership(remaining);
          break;
        case 'assemble':
          remaining = this.assemble(remaining);
          break;
        default:
          remaining = 0;
      }
    }
    return this.done;
  }

  private buildEvents(budget: number): number {
    if (this.cumulative === null) {
      this.cumulative = new Float64Array(this.total);
      this.cumulativeSum = 0;
    }
    const pairs = this.pairs;
    if (pairs === null) {
      throw new Error('prehistory event pairs were already released');
    }
    const hazards = new Float64Array(budget);
    let used = 0;
    while (used < budget && this.cursor + used < this.total) {
      hazards[used] = audienceHazard(this.arrivals);
      used += 1;
    }
    for (let index = 0; index < used; index += 1) {
      const hazard = hazards[index] ?? 0;
      this.cumulativeSum += hazard;
      this.cumulative[this.cursor + index] = this.cumulativeSum;
      const user = this.usersRng.nextBelow(this.active);
      const stream = drawStream(
        user,
        this.streams,
        this.streamRng,
        this.spillRng,
      );
      pairs[this.cursor + index] = pairKeyFor(user, stream, this.streams);
    }
    this.cursor += used;
    if (this.cursor >= this.total) {
      this.normaliseTimes();
      this.stage = 'scan';
      this.cursor = 0;
    }
    return budget - used;
  }

  /**
   * Conditioned Poisson times inside the open window `(-window, 0)`: the last
   * seeded row sits just before the origin, so every row is inside the origin
   * snapshot with an open left edge.
   */
  private normaliseTimes(): void {
    const cumulative = this.cumulative;
    if (cumulative === null) {
      return;
    }
    const span = this.windowMs - 1;
    const totalSum = this.cumulativeSum;
    for (let index = 0; index < this.total; index += 1) {
      const fraction = (cumulative[index] ?? 0) / totalSum;
      this.timesMs[index] = -this.windowMs + fraction * span;
    }
    this.cumulative = null;
  }

  private scanBackwards(budget: number): number {
    const horizonMs =
      this.model.level.workload.measuredMs +
      this.model.level.workload.drainMs +
      1_000;
    const isLast = this.isLastOccurrence;
    const pairs = this.pairs;
    if (pairs === null) {
      throw new Error('prehistory scan without an event-pair buffer');
    }
    let used = 0;
    while (used < budget && this.cursor < this.total) {
      const index = this.total - 1 - this.cursor;
      const pair = pairs[index] ?? 0;
      if (!this.seen.add(pair)) {
        const stream = pair % this.streams;
        this.counts[stream] = (this.counts[stream] ?? 0) + 1;
        if (isLast !== null) {
          isLast[index] = 1;
        }
        const endsAt = (this.timesMs[index] ?? 0) + this.windowMs;
        if (endsAt <= horizonMs) {
          this.pushExpiry(pair, stream, endsAt);
        }
      }
      this.cursor += 1;
      used += 1;
    }
    if (this.cursor >= this.total) {
      this.pairCount = this.seen.count;
      // The distinct count is now known. Keep exact membership, but release
      // the pre-count 2^23-slot over-allocation through a budgeted stage: each
      // old slot visit is one unit of `step()`, so a 20k slice never walks the
      // full old backing array.
      this.compactSource = this.seen;
      this.compactTarget = Int32KeyTable.sizedFor(this.pairCount, 0.85);
      this.compactSlotCount = this.compactSource.capacity;
      this.stage = 'compact';
      this.cursor = 0;
    }
    return budget - used;
  }

  /**
   * Cooperative compaction stage. The old table stays live and `baseHistory`
   * stays unavailable until every old slot has been visited and the target
   * count is verified, so cancellation cannot expose a partial membership set.
   */
  private compactMembership(budget: number): number {
    const source = this.compactSource;
    const target = this.compactTarget;
    if (source === null || target === null) {
      throw new Error('prehistory compaction without source or target');
    }
    let used = 0;
    while (used < budget && this.cursor < this.compactSlotCount) {
      const stored = source.storedAt(this.cursor);
      if (stored !== 0) {
        target.add(stored - 1);
      }
      this.cursor += 1;
      used += 1;
    }
    if (this.cursor >= this.compactSlotCount) {
      if (target.count !== this.pairCount) {
        throw new Error(
          `prehistory compaction lost keys: ${target.count} != ${this.pairCount}`,
        );
      }
      this.seen = target;
      this.compactSource = null;
      this.compactTarget = null;
      this.compactSlotCount = 0;
      this.pairKeysBuild = new Int32Array(this.pairCount);
      this.pairLastBuild = new Float64Array(this.pairCount);
      this.stage = 'assemble';
      this.cursor = 0;
    }
    return budget - used;
  }

  /**
   * Forward pass: every pair's last prehistory activity in ascending order.
   * The retained order is exactly the order a last-seen expiry queue needs, so
   * the independent auditor can bootstrap without sorting or replaying.
   */
  private assemble(budget: number): number {
    const isLast = this.isLastOccurrence;
    const pairs = this.pairs;
    const keys = this.pairKeysBuild;
    const lasts = this.pairLastBuild;
    if (isLast === null || pairs === null || keys === null || lasts === null) {
      throw new Error('prehistory assemble without scan output');
    }
    let used = 0;
    while (used < budget && this.cursor < this.total) {
      const index = this.cursor;
      if ((isLast[index] ?? 0) === 1) {
        keys[this.pairWritten] = pairs[index] ?? 0;
        lasts[this.pairWritten] = this.timesMs[index] ?? 0;
        this.pairWritten += 1;
      }
      this.cursor += 1;
      used += 1;
    }
    if (this.cursor >= this.total) {
      // The written count must equal the distinct pair count; anything else is
      // a bug in the last-occurrence marking, never a silently smaller
      // reference.
      if (this.pairWritten !== this.pairCount) {
        throw new Error(
          `prehistory pair retention is incomplete: ${this.pairWritten} != ${this.pairCount}`,
        );
      }
      this.isLastOccurrence = null;
      // The committed base keeps `pairKeys`/`pairLastMs`, not event-level keys.
      this.pairs = null;
      this.sortExpiries();
      this.stage = 'done';
    }
    return budget - used;
  }

  private pushExpiry(pair: number, stream: number, endsAt: number): void {
    if (this.expiryCount >= this.expiryKeysBuild.length) {
      const grownKeys = new Int32Array(this.expiryKeysBuild.length * 2);
      grownKeys.set(this.expiryKeysBuild);
      this.expiryKeysBuild = grownKeys;
      const grownEnds = new Float64Array(this.expiryEndsBuild.length * 2);
      grownEnds.set(this.expiryEndsBuild);
      this.expiryEndsBuild = grownEnds;
      const grownStreams = new Uint8Array(this.expiryStreamsBuild.length * 2);
      grownStreams.set(this.expiryStreamsBuild);
      this.expiryStreamsBuild = grownStreams;
    }
    this.expiryKeysBuild[this.expiryCount] = pair;
    this.expiryEndsBuild[this.expiryCount] = endsAt;
    this.expiryStreamsBuild[this.expiryCount] = stream;
    this.expiryCount += 1;
  }

  /** Counting sort by integer millisecond, then exact sort inside a bucket. */
  private sortExpiries(): void {
    const count = this.expiryCount;
    const ends = this.expiryEndsBuild.subarray(0, count);
    const keys = this.expiryKeysBuild.subarray(0, count);
    const streams = this.expiryStreamsBuild.subarray(0, count);
    let maxEnd = 0;
    for (let index = 0; index < count; index += 1) {
      const value = ends[index] ?? 0;
      if (value > maxEnd) {
        maxEnd = value;
      }
    }
    const buckets = new Int32Array(Math.ceil(maxEnd) + 2);
    for (let index = 0; index < count; index += 1) {
      const bucket = Math.ceil(ends[index] ?? 0);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    let running = 0;
    for (let bucket = 0; bucket < buckets.length; bucket += 1) {
      const size = buckets[bucket] ?? 0;
      buckets[bucket] = running;
      running += size;
    }
    const sortedEnds = new Float64Array(count);
    const sortedKeys = new Int32Array(count);
    const sortedStreams = new Uint8Array(count);
    for (let index = 0; index < count; index += 1) {
      const bucket = Math.ceil(ends[index] ?? 0);
      const slot = buckets[bucket] ?? 0;
      buckets[bucket] = slot + 1;
      sortedEnds[slot] = ends[index] ?? 0;
      sortedKeys[slot] = keys[index] ?? 0;
      sortedStreams[slot] = streams[index] ?? 0;
    }
    // Exact ascending order inside each millisecond bucket.
    let start = 0;
    while (start < count) {
      let end = start + 1;
      const bucket = Math.ceil(sortedEnds[start] ?? 0);
      while (end < count && Math.ceil(sortedEnds[end] ?? 0) === bucket) {
        end += 1;
      }
      if (end - start > 1) {
        const group: number[] = [];
        for (let index = start; index < end; index += 1) {
          group.push(index);
        }
        group.sort(
          (left, right) => (sortedEnds[left] ?? 0) - (sortedEnds[right] ?? 0),
        );
        const endsCopy = new Float64Array(end - start);
        const keysCopy = new Int32Array(end - start);
        const streamsCopy = new Uint8Array(end - start);
        for (let offset = 0; offset < group.length; offset += 1) {
          const source = group[offset] ?? start;
          endsCopy[offset] = sortedEnds[source] ?? 0;
          keysCopy[offset] = sortedKeys[source] ?? 0;
          streamsCopy[offset] = sortedStreams[source] ?? 0;
        }
        sortedEnds.set(endsCopy, start);
        sortedKeys.set(keysCopy, start);
        sortedStreams.set(streamsCopy, start);
      }
      start = end;
    }

    const catalog = this.model.catalog;
    this.base = {
      counts: this.counts,
      totalPairs: this.seen.count,
      pairs: this.seen,
      pairKeys: this.pairKeysBuild ?? new Int32Array(0),
      pairLastMs: this.pairLastBuild ?? new Float64Array(0),
      eventTimesMs: this.timesMs,
      expiryEndsMs: sortedEnds,
      expiryKeys: sortedKeys,
      expiryStreams: sortedStreams,
      prehistoryEvents: this.total,
      prehistoryDistinctPairs: this.seen.count,
      provisionDiskMs: this.total * catalog.work.sqlAppendDiskMsPerEvent,
      provisionBytes: this.total * catalog.storage.rawEventBytes,
    };
    this.expiryKeysBuild = sortedKeys;
    this.expiryEndsBuild = sortedEnds;
    this.expiryStreamsBuild = sortedStreams;
  }
}

/** One frozen measured ingest trace, identical for every design at one seed. */
export function buildAudienceIngestTrace(
  model: AudienceModel,
  seed: number,
): AudienceIngestTrace {
  const streams = model.level.dataset.streams;
  const ratePerMs = model.level.workload.ingestEventsPerSecond / 1_000;
  const measuredMs = model.level.workload.measuredMs;
  const arrivals = createAudienceStream(seed, 'ingest-arrivals');
  const usersRng = createAudienceStream(seed, 'ingest-users');
  const streamRng = createAudienceStream(seed, 'ingest-stream-choices');
  const spillRng = createAudienceStream(seed, 'ingest-stream-spills');

  const times: number[] = [];
  if (ratePerMs > 0) {
    let timeMs = 0;
    for (;;) {
      timeMs += audienceHazard(arrivals) / ratePerMs;
      if (timeMs >= measuredMs) {
        break;
      }
      times.push(timeMs);
    }
  }
  const count = times.length;
  const timesMs = new Float64Array(count);
  const users = new Int32Array(count);
  const streamsOut = new Uint8Array(count);
  const pairs = new Int32Array(count);
  const active = activeViewers(model);
  for (let index = 0; index < count; index += 1) {
    timesMs[index] = times[index] ?? 0;
    const user = usersRng.nextBelow(active);
    const stream = drawStream(user, streams, streamRng, spillRng);
    users[index] = user;
    streamsOut[index] = stream;
    pairs[index] = pairKeyFor(user, stream, streams);
  }
  return { count, timesMs, users, streams: streamsOut, pairs };
}

/** One frozen read trace for the traffic profile of a case. */
export function buildAudienceReadTrace(
  seed: number,
  phases: readonly AudienceReadPhase[],
  label: string,
): AudienceReadTrace {
  const times: number[] = [];
  phases.forEach((phase, index) => {
    if (phase.readsPerSecond <= 0 || phase.toMs <= phase.fromMs) {
      return;
    }
    const rng = createAudienceStream(seed, `read-arrivals-${label}-${index}`);
    const ratePerMs = phase.readsPerSecond / 1_000;
    let timeMs = phase.fromMs;
    for (;;) {
      timeMs += audienceHazard(rng) / ratePerMs;
      if (timeMs >= phase.toMs) {
        break;
      }
      times.push(timeMs);
    }
  });
  times.sort((left, right) => left - right);
  const timesMs = new Float64Array(times.length);
  for (let index = 0; index < times.length; index += 1) {
    timesMs[index] = times[index] ?? 0;
  }
  return { count: times.length, timesMs };
}
