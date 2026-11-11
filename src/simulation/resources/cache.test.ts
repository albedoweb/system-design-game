import { describe, expect, it } from 'vitest';
import { ByteLruCache } from './index';

describe('ByteLruCache', () => {
  it('evicts least-recently-used bytes and counts hits, misses and evictions', () => {
    const cache = new ByteLruCache<string>(10);
    expect(cache.put('a', 4, 'A')).toBe(true);
    expect(cache.put('b', 6, 'B')).toBe(true);
    expect(cache.usedBytes).toBe(10);

    expect(cache.get('a')).toBe('A');
    expect(cache.put('c', 4, 'C')).toBe(true);
    expect(cache.usedBytes).toBe(8);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.evictions).toBe(1);

    expect(cache.get('miss')).toBeUndefined();
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
  });

  it('adjusts bytes on replacement without counting an eviction', () => {
    const cache = new ByteLruCache<number>(10);
    cache.put('a', 8, 1);
    cache.put('b', 1, 2);
    expect(cache.usedBytes).toBe(9);

    expect(cache.put('a', 3, 3)).toBe(true);
    expect(cache.usedBytes).toBe(4);
    expect(cache.get('a')).toBe(3);
    expect(cache.evictions).toBe(0);
    expect(cache.entryCount).toBe(2);
  });

  it('never fits an oversized entry and leaves an existing entry unchanged', () => {
    const cache = new ByteLruCache<string>(10);
    cache.put('a', 4, 'A');

    expect(cache.put('b', 11, 'B')).toBe(false);
    expect(cache.has('b')).toBe(false);
    expect(cache.usedBytes).toBe(4);

    expect(cache.put('a', 11, 'A2')).toBe(false);
    expect(cache.get('a')).toBe('A');
    expect(cache.usedBytes).toBe(4);
    expect(cache.evictions).toBe(0);
  });

  it('deletes and clears without counting evictions', () => {
    const cache = new ByteLruCache<string>(10);
    cache.put('a', 4, 'A');
    cache.put('b', 4, 'B');

    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    expect(cache.usedBytes).toBe(4);
    cache.clear();
    expect(cache.usedBytes).toBe(0);
    expect(cache.entryCount).toBe(0);
    expect(cache.evictions).toBe(0);
  });

  it('allows zero-byte entries and zero capacity', () => {
    const cache = new ByteLruCache<string>(0);
    expect(cache.put('empty', 0, 'value')).toBe(true);
    expect(cache.get('empty')).toBe('value');
    expect(cache.put('one', 1, 'value')).toBe(false);
    expect(cache.usedBytes).toBe(0);
  });

  it('validates keys, sizes and capacity', () => {
    expect(() => new ByteLruCache(-1)).toThrow(RangeError);
    const cache = new ByteLruCache(10);
    expect(() => cache.put('', 1, 'x')).toThrow(TypeError);
    expect(() => cache.put('a', -1, 'x')).toThrow(RangeError);
    expect(() => cache.put('a', Number.NaN, 'x')).toThrow(RangeError);
  });
});
