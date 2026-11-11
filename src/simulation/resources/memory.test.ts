import { describe, expect, it } from 'vitest';
import { MemoryLedger } from './index';

describe('MemoryLedger', () => {
  it('reserves within the limit and releases exactly once', () => {
    const ledger = new MemoryLedger(100);

    expect(ledger.reserve('a', 60)).toBe(true);
    expect(ledger.usedBytes).toBe(60);
    expect(ledger.availableBytes).toBe(40);
    expect(ledger.reserve('b', 50)).toBe(false);
    expect(ledger.usedBytes).toBe(60);
    expect(ledger.reserve('a', 10)).toBe(false);
    expect(ledger.usedBytes).toBe(60);

    expect(ledger.release('a')).toBe(true);
    expect(ledger.usedBytes).toBe(0);
    expect(ledger.release('a')).toBe(false);
    expect(ledger.usedBytes).toBe(0);
    expect(ledger.peakBytes).toBe(60);
  });

  it('never exceeds the limit or goes negative across many operations', () => {
    const ledger = new MemoryLedger(100);
    expect(ledger.reserve('a', 70)).toBe(true);
    expect(ledger.reserve('b', 30)).toBe(true);
    expect(ledger.usedBytes).toBe(100);
    expect(ledger.reserve('c', 1)).toBe(false);
    expect(ledger.release('b')).toBe(true);
    expect(ledger.release('missing')).toBe(false);
    expect(ledger.usedBytes).toBe(70);
    expect(ledger.reserve('c', 30)).toBe(true);
    expect(ledger.peakBytes).toBe(100);
  });

  it('validates ids and byte counts', () => {
    const ledger = new MemoryLedger(10);
    expect(() => ledger.reserve('', 1)).toThrow(TypeError);
    expect(() => ledger.reserve('a', -1)).toThrow(RangeError);
    expect(() => ledger.reserve('a', Number.NaN)).toThrow(RangeError);
    expect(() => new MemoryLedger(-1)).toThrow(RangeError);
    expect(() => new MemoryLedger(Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
  });

  it('supports fractional byte ownership without drift', () => {
    const ledger = new MemoryLedger(1);
    expect(ledger.reserve('a', 0.1)).toBe(true);
    expect(ledger.reserve('b', 0.2)).toBe(true);
    expect(ledger.reserve('c', 0.7)).toBe(true);
    expect(ledger.usedBytes).toBeCloseTo(1, 12);
    expect(ledger.reserve('d', 0.1)).toBe(false);
    expect(ledger.release('b')).toBe(true);
    expect(ledger.usedBytes).toBeCloseTo(0.8, 12);
  });
});
