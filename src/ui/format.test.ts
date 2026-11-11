import { describe, expect, it } from 'vitest';

import { DEFAULT_LEVEL } from '../domain';
import { DASH, formatDuration } from './format';

describe('formatDuration', () => {
  it('renders subsecond values as exact milliseconds', () => {
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(1)).toBe('1 ms');
    expect(formatDuration(2)).toBe('2 ms');
    expect(formatDuration(10)).toBe('10 ms');
    expect(formatDuration(16)).toBe('16 ms');
    expect(formatDuration(32)).toBe('32 ms');
    expect(formatDuration(800)).toBe('800 ms');
    expect(formatDuration(999)).toBe('999 ms');
  });

  it('keeps whole-second scenario time in seconds', () => {
    expect(formatDuration(5_000)).toBe('5 s');
    expect(formatDuration(30_000)).toBe('30 s');
    expect(formatDuration(60_000)).toBe('60 s');
    expect(formatDuration(1_500)).toBe('1.5 s');
  });

  it('handles missing data without inventing a duration', () => {
    expect(formatDuration(null)).toBe(DASH);
    expect(formatDuration(undefined)).toBe(DASH);
    expect(formatDuration(Number.NaN)).toBe(DASH);
  });

  it('matches the shipped level timing exactly', () => {
    const timing = DEFAULT_LEVEL.timing;
    expect(formatDuration(timing.clientRttMs)).toBe('10 ms');
    expect(formatDuration(timing.edgeRttMs)).toBe('2 ms');
    expect(formatDuration(timing.edgeRttMs / 2)).toBe('1 ms');
    expect(formatDuration(timing.appCpuMs)).toBe('2 ms');
    expect(formatDuration(timing.cacheLookupMs)).toBe('1 ms');
    expect(formatDuration(timing.dbReadMs)).toBe('16 ms');
    expect(formatDuration(timing.dbWriteMs)).toBe('32 ms');
    expect(formatDuration(timing.lbMs)).toBe('1 ms');
    expect(formatDuration(timing.invalidationMs)).toBe('2 ms');
    expect(formatDuration(DEFAULT_LEVEL.drainMs)).toBe('800 ms');
    expect(formatDuration(DEFAULT_LEVEL.deadlineMs)).toBe('800 ms');
    expect(formatDuration(DEFAULT_LEVEL.durationMs)).toBe('60 s');
    expect(formatDuration(DEFAULT_LEVEL.warmupMs)).toBe('5 s');
    expect(formatDuration(DEFAULT_LEVEL.flushAtMs)).toBe('30 s');
  });
});
