/**
 * Byte-bounded ownership ledger.
 *
 * A ledger represents one concrete pool of bytes (for example the queued plus
 * active buffers of one physical cache instance). The evaluator should use a
 * separate ledger per physical instance; sharing one ledger across instances
 * would invent a memory pool that does not exist.
 *
 * Rules are deliberately small and explicit:
 * - `reserve` with an id that is already held returns false and changes
 *   nothing (no duplicate ownership, no silent top-up).
 * - `reserve` that would exceed the limit returns false and changes nothing.
 * - `release` returns true only for an id that was reserved, and removes it
 *   exactly once. Releasing a missing id returns false and is never negative.
 */

const BYTE_EPSILON = 1e-9;

export class MemoryLedger {
  private readonly held = new Map<string, number>();
  private used = 0;
  private peak = 0;

  constructor(readonly limitBytes: number) {
    if (!Number.isFinite(limitBytes) || limitBytes < 0) {
      throw new RangeError('memory limit must be finite and non-negative');
    }
  }

  get usedBytes(): number {
    return this.used;
  }

  get peakBytes(): number {
    return this.peak;
  }

  get availableBytes(): number {
    return Math.max(0, this.limitBytes - this.used);
  }

  get entryCount(): number {
    return this.held.size;
  }

  /** Reserves `bytes` under `id`. Returns false for duplicates or overflow. */
  reserve(id: string, bytes: number): boolean {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('memory reservation id must be a non-empty string');
    }
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError('memory reservation bytes must be finite and non-negative');
    }
    if (this.held.has(id)) {
      return false;
    }
    if (this.used + bytes > this.limitBytes + BYTE_EPSILON) {
      return false;
    }
    this.held.set(id, bytes);
    this.used += bytes;
    if (this.used > this.peak) {
      this.peak = this.used;
    }
    return true;
  }

  /** Releases `id` exactly once. Returns false when the id is not held. */
  release(id: string): boolean {
    const bytes = this.held.get(id);
    if (bytes === undefined) {
      return false;
    }
    this.held.delete(id);
    this.used -= bytes;
    if (this.used < 0) {
      // Defensive: state is a map of non-negative values, so this only guards
      // against future regressions.
      this.used = 0;
    }
    return true;
  }

  has(id: string): boolean {
    return this.held.has(id);
  }

  bytesHeldBy(id: string): number | undefined {
    return this.held.get(id);
  }
}
