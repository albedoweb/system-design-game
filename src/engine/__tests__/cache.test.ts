import { describe, expect, it } from 'vitest';

import { KeyedTtlLru } from '../cache';

describe('keyed LRU + TTL cache', () => {
  it('expires exactly at the TTL deadline', () => {
    const cache = new KeyedTtlLru(10, 1000);
    cache.store(7, 0);
    expect(cache.lookup(7, 999)).toBe(true);
    expect(cache.lookup(7, 1000)).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used key, not the oldest insertion', () => {
    const cache = new KeyedTtlLru(2, 10_000);
    cache.store(1, 0);
    cache.store(2, 0);
    expect(cache.lookup(1, 1)).toBe(true);
    cache.store(3, 2);

    expect(cache.lookup(2, 3)).toBe(false);
    expect(cache.lookup(1, 4)).toBe(true);
    expect(cache.lookup(3, 5)).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('refreshes recency and TTL when a key is stored again', () => {
    const cache = new KeyedTtlLru(2, 1000);
    cache.store(1, 0);
    cache.store(2, 0);
    cache.store(1, 500);
    expect(cache.lookup(1, 1400)).toBe(true);
    expect(cache.lookup(2, 1400)).toBe(false);
  });

  it('clears entries without changing capacity', () => {
    const cache = new KeyedTtlLru(1, 1000);
    cache.store(1, 0);
    cache.clear();
    expect(cache.size).toBe(0);
    cache.store(2, 0);
    cache.store(3, 0);
    expect(cache.size).toBe(1);
    expect(cache.lookup(2, 1)).toBe(false);
    expect(cache.lookup(3, 1)).toBe(true);
  });
});
