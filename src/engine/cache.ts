/**
 * Keyed LRU with lazy TTL expiry. Expiry never schedules an event: an entry is
 * checked at lookup and removed on first use at or after `expiresAt`.
 * `store` refreshes recency and TTL for the key.
 */
export class KeyedTtlLru {
  private readonly entries = new Map<number, number>();
  private readonly capacity: number;
  private readonly ttlMs: number;

  constructor(capacity: number, ttlMs: number) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new Error(`Invalid cache capacity: ${capacity}`);
    }
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error(`Invalid cache TTL: ${ttlMs}`);
    }
    this.capacity = capacity;
    this.ttlMs = ttlMs;
  }

  get size(): number {
    return this.entries.size;
  }

  /** `true` only while `now < expiresAt`; expired entries are dropped. */
  lookup(key: number, nowMs: number): boolean {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) {
      return false;
    }
    if (nowMs >= expiresAt) {
      this.entries.delete(key);
      return false;
    }
    // Refresh LRU position: delete + re-insert moves the key to the tail.
    this.entries.delete(key);
    this.entries.set(key, expiresAt);
    return true;
  }

  store(key: number, nowMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, nowMs + this.ttlMs);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }

  remove(key: number): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
