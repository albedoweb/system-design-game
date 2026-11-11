/**
 * Byte-bounded LRU cache.
 *
 * This is storage accounting only: it does not invent hit rates. Callers
 * provide keys (the Image Atlas evaluator will use object key plus variant)
 * and explicit byte sizes. `get` touches the entry and counts a hit or miss.
 * `delete` and `clear` are administrative and are not evictions.
 *
 * Rules:
 * - An entry larger than the cache capacity never fits and `put` returns false.
 *   An existing entry with the same key is left unchanged in that case.
 * - Replacing an entry adjusts `usedBytes` by the size difference; the
 *   replacement is never counted as an eviction.
 * - Inserting may evict least-recently-used entries until the capacity holds.
 * - Zero-byte entries are allowed.
 */

const BYTE_EPSILON = 1e-9;

export interface ByteCacheEntry<V> {
  readonly key: string;
  readonly sizeBytes: number;
  readonly value: V;
}

function tooLarge(used: number, capacity: number): boolean {
  return used > capacity + BYTE_EPSILON;
}

export class ByteLruCache<V = unknown> {
  private readonly entries = new Map<string, ByteCacheEntry<V>>();
  private used = 0;
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  constructor(readonly capacityBytes: number) {
    if (!Number.isFinite(capacityBytes) || capacityBytes < 0) {
      throw new RangeError('cache capacity must be finite and non-negative');
    }
  }

  get usedBytes(): number {
    return this.used;
  }

  get entryCount(): number {
    return this.entries.size;
  }

  get hits(): number {
    return this.hitCount;
  }

  get misses(): number {
    return this.missCount;
  }

  get evictions(): number {
    return this.evictionCount;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Returns the cached value, touches the entry and records hit or miss. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.missCount += 1;
      return undefined;
    }
    this.hitCount += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Reads without touching LRU order or hit/miss counters. */
  peek(key: string): ByteCacheEntry<V> | undefined {
    return this.entries.get(key);
  }

  /**
   * Inserts or replaces one entry. Returns false when the entry is larger than
   * the cache, in which case nothing changes.
   */
  put(key: string, sizeBytes: number, value: V): boolean {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('cache key must be a non-empty string');
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
      throw new RangeError('cache entry size must be finite and non-negative');
    }
    if (tooLarge(sizeBytes, this.capacityBytes)) {
      return false;
    }

    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.used -= previous.sizeBytes;
      this.entries.delete(key);
    }

    while (
      this.entries.size > 0 &&
      tooLarge(this.used + sizeBytes, this.capacityBytes)
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.removeEntry(oldest.value);
      this.evictionCount += 1;
    }

    const entry: ByteCacheEntry<V> = { key, sizeBytes, value };
    this.entries.set(key, entry);
    this.used += sizeBytes;
    return true;
  }

  /** Removes one entry. Returns false when the key is absent. */
  delete(key: string): boolean {
    return this.removeEntry(key);
  }

  /** Removes every entry. Not counted as eviction. */
  clear(): void {
    this.entries.clear();
    this.used = 0;
  }

  private removeEntry(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return false;
    }
    this.entries.delete(key);
    this.used -= entry.sizeBytes;
    if (this.used < 0) {
      this.used = 0;
    }
    return true;
  }
}
