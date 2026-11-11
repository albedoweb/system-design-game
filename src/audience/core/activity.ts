import type { AudienceSnapshot } from '../contracts';
import type { AudienceBaseHistory } from './workload';

/**
 * Exact rolling distinct-viewer state.
 *
 * Three genuinely different implementations live here:
 *
 * 1. `ActivityOverlay` (served answers) — the exact prehistory snapshot (per
 *    stream counts, sorted pair-expiry instants, retained pair membership) plus
 *    incremental durable commits and expiry at `asOf - window` with an open
 *    left edge. A renewed pair is never removed by the stale expiry of its
 *    earlier activity, and a pair that already left the window is counted
 *    again when it renews. Every expiry boundary it consumes is audited
 *    individually (removed or correctly skipped after a renewal).
 * 2. `LastSeenIndex` (independent audit) — a completely different structure: a
 *    per-pair last-activity map plus a FIFO of last-activity instants with lazy
 *    invalidation. It shares no state with the overlay and is fed only by the
 *    durable commit stream (or, for a projection, only by published jobs), so
 *    an expiry/renewal bug in one is caught by the other.
 * 3. `recomputeWindowRanking` (independent raw oracle) — rebuilds the answer by
 *    scanning retained prehistory rows and durable logged rows, both filtered
 *    by the exact snapshot tuple, through a scratch open-addressed pair table.
 *    It reads no ranking response, cached payload, overlay or projection state.
 *
 * Invariant required by the overlay algebra: measured traffic plus drain plus
 * the audit slack is shorter than the activity window, so a pair renewed inside
 * the case is still active at every later snapshot of that case.
 */

export interface AudienceTopEntry {
  readonly stream: number;
  readonly viewers: number;
}

export interface AudienceRanking {
  readonly snapshot: AudienceSnapshot;
  /** Served top entries; never mutated after the response is built. */
  readonly top: readonly AudienceTopEntry[];
  readonly activePairs: number;
}

/** The overlay algebra only holds while the case is shorter than the window. */
export function assertWindowInvariant(
  windowMs: number,
  caseMs: number,
  label: string,
): void {
  if (windowMs <= caseMs) {
    throw new RangeError(
      `${label}: measured+drain (${caseMs} ms) must be shorter than the activity window (${windowMs} ms) for exact renewal expiry`,
    );
  }
}

function tableSizeFor(entries: number, loadFactor: number): number {
  const needed = Math.max(2, Math.ceil(entries / loadFactor));
  let size = 2;
  while (size < needed) {
    size *= 2;
  }
  return size;
}

function storedHash(stored: number): number {
  return Math.imul(stored, 0x9e3779b1) >>> 0;
}

/**
 * Exact compact membership set for non-negative int32 pair keys.
 *
 * The served overlay used a boxed `Set<number>` for every pair it had expired
 * during a case (hundreds of thousands at this dataset size). An open-addressed
 * `Int32Array` holds the same exact membership using one int per slot. Tombstones
 * keep deletion correct because a renewed pair is re-inserted, not revived in
 * place.
 */
class Int32OpenSet {
  private keys: Int32Array;
  private mask: number;
  private live = 0;
  private occupied = 0;

  constructor(expected = 16) {
    this.keys = new Int32Array(tableSizeFor(expected, 0.7));
    this.mask = this.keys.length - 1;
  }

  get size(): number {
    return this.live;
  }

  has(key: number): boolean {
    const stored = key + 1;
    let index = storedHash(stored) & this.mask;
    for (;;) {
      const current = this.keys[index];
      if (current === 0) {
        return false;
      }
      if (current === stored) {
        return true;
      }
      index = (index + 1) & this.mask;
    }
  }

  /** True when the key was already present. */
  add(key: number): boolean {
    if (this.occupied + 1 > this.keys.length * 0.7) {
      this.rehash(this.keys.length * 2);
    }
    return this.insert(key + 1) !== null;
  }

  /** Inserts a stored key; returns null for a new key, its slot otherwise. */
  private insert(stored: number): number | null {
    let index = storedHash(stored) & this.mask;
    let tombstone = -1;
    for (;;) {
      const current = this.keys[index];
      if (current === 0) {
        const slot = tombstone >= 0 ? tombstone : index;
        this.keys[slot] = stored;
        if (tombstone < 0) {
          this.occupied += 1;
        }
        this.live += 1;
        return null;
      }
      if (current === -1) {
        if (tombstone < 0) {
          tombstone = index;
        }
      } else if (current === stored) {
        return index;
      }
      index = (index + 1) & this.mask;
    }
  }

  private rehash(size: number): void {
    const previous = this.keys;
    this.keys = new Int32Array(size);
    this.mask = size - 1;
    this.live = 0;
    this.occupied = 0;
    for (let index = 0; index < previous.length; index += 1) {
      const stored = previous[index] ?? 0;
      if (stored > 0) {
        this.insert(stored);
      }
    }
  }
}

/**
 * Exact compact `pair key -> last activity` table used by the independent
 * last-seen audit.
 *
 * The audit previously allocated a boxed `Map<number, number>` with one entry
 * per retained pair, rebuilt for every case. The same exact key/time mapping
 * lives here in parallel `Int32Array`/`Float64Array` backing stores. Deletion
 * writes a tombstone; lookups and updates behave exactly like `Map.get/set/delete`
 * for finite timestamps.
 */
class PairLastTable {
  private keys: Int32Array;
  private values: Float64Array;
  private mask: number;
  private live = 0;
  private occupied = 0;

  constructor(expected = 16) {
    const size = tableSizeFor(expected, 0.7);
    this.keys = new Int32Array(size);
    this.values = new Float64Array(size);
    this.mask = size - 1;
  }

  get size(): number {
    return this.live;
  }

  get(key: number): number | undefined {
    const slot = this.find(key + 1);
    return slot < 0 ? undefined : this.values[slot];
  }

  /** True when the key was already present. */
  set(key: number, value: number): boolean {
    if (this.occupied + 1 > this.keys.length * 0.7) {
      const enough = this.live + 1 <= this.keys.length * 0.7;
      this.rehash(enough ? this.keys.length : this.keys.length * 2);
    }
    return this.assign(key + 1, value);
  }

  delete(key: number): boolean {
    const slot = this.find(key + 1);
    if (slot < 0) {
      return false;
    }
    this.keys[slot] = -1;
    this.live -= 1;
    return true;
  }

  private find(stored: number): number {
    let index = storedHash(stored) & this.mask;
    for (;;) {
      const current = this.keys[index];
      if (current === 0) {
        return -1;
      }
      if (current === stored) {
        return index;
      }
      index = (index + 1) & this.mask;
    }
  }

  /** Assigns a stored key; true when it already existed. */
  private assign(stored: number, value: number): boolean {
    let index = storedHash(stored) & this.mask;
    let tombstone = -1;
    for (;;) {
      const current = this.keys[index];
      if (current === 0) {
        const slot = tombstone >= 0 ? tombstone : index;
        this.keys[slot] = stored;
        this.values[slot] = value;
        if (tombstone < 0) {
          this.occupied += 1;
        }
        this.live += 1;
        return false;
      }
      if (current === -1) {
        if (tombstone < 0) {
          tombstone = index;
        }
      } else if (current === stored) {
        this.values[index] = value;
        return true;
      }
      index = (index + 1) & this.mask;
    }
  }

  private rehash(size: number): void {
    const previousKeys = this.keys;
    const previousValues = this.values;
    this.keys = new Int32Array(size);
    this.values = new Float64Array(size);
    this.mask = size - 1;
    this.live = 0;
    this.occupied = 0;
    for (let index = 0; index < previousKeys.length; index += 1) {
      const stored = previousKeys[index] ?? 0;
      if (stored > 0) {
        // Every live key is unique, so this cannot collide with a duplicate.
        this.assign(stored, previousValues[index] ?? 0);
      }
    }
  }
}

export class ActivityOverlay {
  private readonly counts: Int32Array;
  private readonly renewedAt: PairLastTable;
  private readonly expired: Int32OpenSet;
  private pointer = 0;
  private total: number;
  private boundariesChecked = 0;
  private boundaryMismatches = 0;
  private removals = 0;
  private renewalSkips = 0;
  private additions = 0;

  private readonly windowMs: number;

  constructor(
    private readonly base: AudienceBaseHistory,
    windowMs: number,
    streamCount: number,
  ) {
    this.windowMs = windowMs;
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('activity window must be positive');
    }
    if (!Number.isInteger(streamCount) || streamCount <= 0) {
      throw new RangeError('stream count must be a positive integer');
    }
    this.counts = new Int32Array(base.counts);
    this.total = base.totalPairs;
    // Renewals are bounded by the case's durable commits; expiries are bounded
    // by the retained expiry boundaries (not the whole prehistory). Sizing the
    // expiry set from those boundaries avoids a run of doubling rehashes while
    // keeping exact membership.
    this.renewedAt = new PairLastTable(1_024);
    this.expired = new Int32OpenSet(Math.max(16, base.expiryKeys.length));
  }

  static fromPrehistory(
    base: AudienceBaseHistory,
    windowMs: number,
    streamCount: number,
  ): ActivityOverlay {
    return new ActivityOverlay(base, windowMs, streamCount);
  }

  get activePairs(): number {
    return this.total;
  }

  /** Expiry boundaries consumed so far, each individually audited. */
  get checkedExpiry(): number {
    return this.boundariesChecked;
  }

  get expiryMismatches(): number {
    return this.boundaryMismatches;
  }

  /** Pairs actually removed by expiry (renewal skips are not removals). */
  get expiryRemovals(): number {
    return this.removals;
  }

  /** Distinct pairs newly added by durable commits. */
  get newPairAdds(): number {
    return this.additions;
  }

  get expiryRenewalSkips(): number {
    return this.renewalSkips;
  }

  countsCopy(): Int32Array {
    return new Int32Array(this.counts);
  }

  /** Durable commits arrive in monotonic sequence order. */
  applyCommit(pairKey: number, stream: number, atMs: number): void {
    if (this.renewedAt.get(pairKey) !== undefined) {
      return;
    }
    if (this.expired.has(pairKey) || !this.base.pairs.has(pairKey)) {
      this.counts[stream] = (this.counts[stream] ?? 0) + 1;
      this.total += 1;
      this.additions += 1;
    }
    this.renewedAt.set(pairKey, atMs);
  }

  /** Expires every pair whose last activity left the window at `asOfMs`. */
  expireTo(asOfMs: number): void {
    const ends = this.base.expiryEndsMs;
    const keys = this.base.expiryKeys;
    const streams = this.base.expiryStreams;
    while (this.pointer < ends.length) {
      const end = ends[this.pointer] ?? 0;
      if (end > asOfMs) {
        break;
      }
      const key = keys[this.pointer] ?? 0;
      const stream = streams[this.pointer] ?? 0;
      const renewedAt = this.renewedAt.get(key);
      if (renewedAt !== undefined) {
        // Audited renewal skip: at `end` the pair must still be inside the
        // window because of the later activity, i.e. renewedAt > end - window.
        if (!(renewedAt > end - this.windowMs)) {
          this.boundaryMismatches += 1;
        }
        this.renewalSkips += 1;
      } else {
        if (!this.base.pairs.has(key) || (this.counts[stream] ?? 0) <= 0) {
          this.boundaryMismatches += 1;
        }
        this.counts[stream] = (this.counts[stream] ?? 0) - 1;
        this.total -= 1;
        this.expired.add(key);
        this.removals += 1;
      }
      this.boundariesChecked += 1;
      this.pointer += 1;
    }
  }

  /** How many retained boundaries fall at or before `asOfMs`. */
  expectedExpiriesThrough(asOfMs: number): number {
    return countAtOrBelow(this.base.expiryEndsMs, asOfMs);
  }

  ranking(
    asOfMs: number,
    throughCommitSequence: number,
    topN: number,
  ): AudienceRanking {
    if (!Number.isFinite(asOfMs) || asOfMs < 0) {
      throw new RangeError('snapshot time must be finite and non-negative');
    }
    this.expireTo(asOfMs);
    return {
      snapshot: { asOfMs, throughCommitSequence },
      top: topStreams(this.counts, topN),
      activePairs: this.total,
    };
  }
}

/**
 * Independent last-seen index used only for auditing.
 *
 * The retained prehistory stays in its frozen sorted arrays; the audit advances
 * a pointer over them instead of copying every pair into a boxed map. Only
 * durable commit renewals are stored, plus the prehistory pairs that actually
 * crossed their expiry boundary. A commit FIFO with lazy invalidation handles
 * the general case; under the documented case-shorter-than-window invariant a
 * measured commit never leaves the window during its own case.
 *
 * The structure remains independent: it is fed only by the durable commit
 * stream, never by served rankings, cache payloads or overlay state, and it
 * shares no mutable object with `ActivityOverlay`.
 */
export class LastSeenIndex {
  private readonly counts: Int32Array;
  private readonly renewedAt: PairLastTable;
  private readonly expired: Int32OpenSet;
  private fifoKeys: Int32Array;
  private fifoLast: Float64Array;
  private fifoLength = 0;
  private commitPointer = 0;
  private prehistoryPointer = 0;
  private total: number;

  constructor(
    private readonly base: AudienceBaseHistory,
    private readonly windowMs: number,
    private readonly streamCount: number,
  ) {
    if (base.pairKeys.length !== base.totalPairs) {
      throw new Error(
        `last-seen audit bootstrap mismatch: ${base.pairKeys.length} != ${base.totalPairs}`,
      );
    }
    this.counts = new Int32Array(base.counts);
    this.total = base.totalPairs;
    // Commit renewals are the only per-pair state rebuilt for each case.
    this.renewedAt = new PairLastTable(1_024);
    this.expired = new Int32OpenSet(Math.max(16, base.expiryKeys.length));
    this.fifoKeys = new Int32Array(1_024);
    this.fifoLast = new Float64Array(1_024);
  }

  get activePairs(): number {
    return this.total;
  }

  applyCommit(pairKey: number, lastMs: number): void {
    const previous = this.renewedAt.get(pairKey);
    if (previous === undefined) {
      // A retained pair that has not expired is already counted. A new pair or
      // an expired retained pair becomes active again.
      if (!this.base.pairs.has(pairKey) || this.expired.has(pairKey)) {
        this.total += 1;
        this.counts[pairKey % this.streamCount] =
          (this.counts[pairKey % this.streamCount] ?? 0) + 1;
      }
    }
    this.renewedAt.set(pairKey, lastMs);
    this.push(pairKey, lastMs);
  }

  expireTo(asOfMs: number): void {
    const left = asOfMs - this.windowMs;
    const keys = this.base.pairKeys;
    const lasts = this.base.pairLastMs;
    while (this.prehistoryPointer < lasts.length) {
      const lastMs = lasts[this.prehistoryPointer] ?? 0;
      if (lastMs > left) {
        break;
      }
      const key = keys[this.prehistoryPointer] ?? 0;
      // A renewal keeps the pair active; its own FIFO entry decides removal.
      if (this.renewedAt.get(key) === undefined) {
        this.expired.add(key);
        this.counts[key % this.streamCount] =
          (this.counts[key % this.streamCount] ?? 0) - 1;
        this.total -= 1;
      }
      this.prehistoryPointer += 1;
    }
    while (this.commitPointer < this.fifoLength) {
      const lastMs = this.fifoLast[this.commitPointer] ?? 0;
      if (lastMs > left) {
        break;
      }
      const key = this.fifoKeys[this.commitPointer] ?? 0;
      if (this.renewedAt.get(key) === lastMs) {
        this.renewedAt.delete(key);
        // The retained activity is older than this commit, so the pair is now
        // fully out of the window if it came from prehistory.
        this.expired.add(key);
        this.counts[key % this.streamCount] =
          (this.counts[key % this.streamCount] ?? 0) - 1;
        this.total -= 1;
      }
      this.commitPointer += 1;
    }
  }

  ranking(
    asOfMs: number,
    throughCommitSequence: number,
    topN: number,
  ): AudienceRanking {
    this.expireTo(asOfMs);
    return {
      snapshot: { asOfMs, throughCommitSequence },
      top: topStreams(this.counts, topN),
      activePairs: this.total,
    };
  }

  private push(key: number, lastMs: number): void {
    if (this.fifoLength >= this.fifoKeys.length) {
      const grownKeys = new Int32Array(this.fifoKeys.length * 2);
      grownKeys.set(this.fifoKeys);
      this.fifoKeys = grownKeys;
      const grownLast = new Float64Array(this.fifoLast.length * 2);
      grownLast.set(this.fifoLast);
      this.fifoLast = grownLast;
    }
    this.fifoKeys[this.fifoLength] = key;
    this.fifoLast[this.fifoLength] = lastMs;
    this.fifoLength += 1;
  }
}

/** Top streams by distinct active viewers; ties resolve by stream id ascending. */
export function topStreams(
  counts: Int32Array,
  topN: number,
): AudienceTopEntry[] {
  const limit = Math.min(Math.max(0, topN), counts.length);
  const result: AudienceTopEntry[] = [];
  if (limit === 0) {
    return result;
  }
  // Rank by repeated selection instead of sorting an index array per answer:
  // the same tie rule (higher count, then lower stream id) with no per-call
  // 100-element scratch array on the hot read path.
  const selected = new Uint8Array(counts.length);
  for (let rank = 0; rank < limit; rank += 1) {
    let best = -1;
    let bestCount = -1;
    for (let stream = 0; stream < counts.length; stream += 1) {
      if ((selected[stream] ?? 0) === 1) {
        continue;
      }
      const viewers = counts[stream] ?? 0;
      if (viewers > bestCount) {
        best = stream;
        bestCount = viewers;
      }
    }
    if (best < 0) {
      break;
    }
    selected[best] = 1;
    result.push({ stream: best, viewers: bestCount });
  }
  return result;
}

export interface AudienceCommitLog {
  /** Committed rows, in monotonic durable sequence order. */
  readonly count: number;
  readonly timesMs: Float64Array;
  readonly pairs: Int32Array;
  readonly streams: Uint8Array;
}

/**
 * Reusable raw-audit scratch, keyed by the immutable base history.
 *
 * The exact oracle used to allocate two power-of-two Int32 tables for every
 * audit and then throw them away (up to nine times per query case at this
 * dataset size). The base history is built once per run and shared by every
 * case, so one cleared table per base is enough: audit calls are synchronous,
 * never nested and never interleaved, so a lease cannot be observed by another
 * call. The `busy` guard is a defensive correctness fallback, not the normal
 * path: if the same base were ever re-entered, that call gets a private table
 * instead of corrupting the pooled one.
 *
 * A WeakMap entry dies with its base history, so nothing survives the session
 * that owns it. The table is reset in `finally`, including on a thrown audit.
 */
const rawAuditScratch = new WeakMap<AudienceBaseHistory, Int32SetScratch>();

interface ScratchLease {
  readonly scratch: Int32SetScratch;
}

function leaseRawAuditScratch(
  base: AudienceBaseHistory,
  capacity: number,
): ScratchLease {
  const cached = rawAuditScratch.get(base);
  if (cached === undefined) {
    const scratch = new Int32SetScratch(capacity);
    scratch.busy = true;
    rawAuditScratch.set(base, scratch);
    return { scratch };
  }
  if (cached.busy) {
    const scratch = new Int32SetScratch(capacity);
    scratch.busy = true;
    return { scratch };
  }
  cached.reset();
  cached.ensureCapacity(capacity);
  cached.busy = true;
  return { scratch: cached };
}

function releaseRawAuditScratch(lease: ScratchLease): void {
  lease.scratch.reset();
  lease.scratch.busy = false;
}

/**
 * Independent reference answer from raw rows only.
 *
 * Rows are the retained prehistory pairs (windowed by last activity) plus the
 * durable commit prefix; the scan has its own open-addressed pair table and its
 * own per-stream counters. Committed rows above the cursor or after `asOf` are
 * excluded, and a pair is counted once no matter how often it repeats.
 *
 * The pair table is leased per base history and cleared before/after the scan.
 * That changes only allocation lifetime: the scanned rows, the open-left window
 * and the duplicate suppression are exactly the same as a fresh table.
 */
export function recomputeWindowRanking(
  base: AudienceBaseHistory,
  log: AudienceCommitLog,
  snapshot: AudienceSnapshot,
  windowMs: number,
  streamCount: number,
  topN: number,
): AudienceRanking {
  const asOf = snapshot.asOfMs;
  const left = asOf - windowMs;
  const firstRetained = firstIndexAfter(base.pairLastMs, base.pairLastMs.length, left);
  const limit = Math.min(log.count, snapshot.throughCommitSequence);
  const firstCommit = firstIndexAfter(log.timesMs, log.count, left);
  const lease = leaseRawAuditScratch(
    base,
    Math.max(
      16,
      Math.ceil((base.pairLastMs.length - firstRetained + limit) * 1.3),
    ),
  );
  const scratch = lease.scratch;
  try {
    const counts = new Int32Array(streamCount);
    let total = 0;
    for (let index = firstRetained; index < base.pairLastMs.length; index += 1) {
      const pair = base.pairKeys[index] ?? 0;
      if (scratch.add(pair)) {
        continue;
      }
      const stream = pair % streamCount;
      counts[stream] = (counts[stream] ?? 0) + 1;
      total += 1;
    }
    for (let index = firstCommit; index < limit; index += 1) {
      const time = log.timesMs[index] ?? 0;
      if (time > asOf) {
        break;
      }
      const pair = log.pairs[index] ?? 0;
      if (scratch.add(pair)) {
        continue;
      }
      const stream = log.streams[index] ?? 0;
      counts[stream] = (counts[stream] ?? 0) + 1;
      total += 1;
    }
    return { snapshot, top: topStreams(counts, topN), activePairs: total };
  } finally {
    releaseRawAuditScratch(lease);
  }
}

/** Binary search: first index whose value is strictly greater than `value`. */
export function firstIndexAfter(
  values: Float64Array,
  count: number,
  value: number,
): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((values[mid] ?? 0) <= value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/** Number of sorted values at or below `value`. */
export function countAtOrBelow(values: Float64Array, value: number): number {
  return firstIndexAfter(values, values.length, value);
}

class Int32SetScratch {
  private slots: Int32Array;
  private mask: number;
  private used = 0;
  /** True while a raw audit owns this table; a nested lease must not share it. */
  busy = false;

  constructor(capacity: number) {
    this.slots = new Int32Array(0);
    this.mask = 0;
    this.ensureCapacity(capacity);
  }

  /**
   * Resizes only a cleared table. Retaining the larger allocation avoids
   * repeated power-of-two growth inside one case while never reusing dirty
   * slots; the caller resets before leasing.
   */
  ensureCapacity(capacity: number): void {
    if (capacity <= this.slots.length) {
      return;
    }
    if (this.used !== 0) {
      throw new Error('cannot resize a live raw-audit scratch table');
    }
    let size = 2;
    while (size < capacity) {
      size *= 2;
    }
    this.slots = new Int32Array(size);
    this.mask = size - 1;
  }

  add(key: number): boolean {
    const stored = key + 1;
    let index = Math.imul(stored, 0x9e3779b1) >>> 0;
    index &= this.mask;
    for (;;) {
      const current = this.slots[index];
      if (current === 0) {
        this.slots[index] = stored;
        this.used += 1;
        return false;
      }
      if (current === stored) {
        return true;
      }
      index = (index + 1) & this.mask;
    }
  }

  reset(): void {
    // A sequential fill is cheaper and smaller than retaining a second
    // per-slot "touched" index array at this table size.
    this.slots.fill(0);
    this.used = 0;
  }
}

/** Exact comparison of two rankings: same entries in the same order. */
export function rankingsEqual(
  left: AudienceRanking,
  right: AudienceRanking,
): boolean {
  return (
    left.activePairs === right.activePairs &&
    left.top.length === right.top.length &&
    left.top.every(
      (entry, index) =>
        entry.stream === right.top[index]?.stream &&
        entry.viewers === right.top[index]?.viewers,
    )
  );
}
