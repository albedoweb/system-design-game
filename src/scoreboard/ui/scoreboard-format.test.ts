import { describe, expect, it } from 'vitest';

import {
  formatAvailability,
  formatSeriesRate,
  formatSuccessfulMilliseconds,
  formatUnitValue,
  formatUsdPrecise,
} from './scoreboard-format';

describe('Live Scoreboard formatting', () => {
  it('renders availability as an exact percentage, never a bare ratio', () => {
    expect(formatAvailability(0.9933)).toBe('99.33%');
    expect(formatAvailability(0.995)).toBe('99.50%');
    expect(formatAvailability(null)).toBe('—');
  });

  it('keeps enough digits for a small actual run cost', () => {
    expect(formatUsdPrecise(0.000123)).toBe('$0.000123');
    expect(formatUsdPrecise(0.0042)).toBe('$0.00420');
    expect(formatUsdPrecise(0.24)).toBe('$0.2400');
    expect(formatUsdPrecise(null)).toBe('—');
  });

  it('turns engine interval totals into rates by the real window', () => {
    expect(formatSeriesRate(200, 1_000)).toBe(200);
    expect(formatSeriesRate(10, 500)).toBe(20);
    expect(formatSeriesRate(0, 1_000)).toBe(0);
    expect(formatSeriesRate(200, 0)).toBeNull();
    expect(formatSeriesRate(null, 1_000)).toBeNull();
  });

  it('does not turn an empty success set into zero latency', () => {
    expect(formatSuccessfulMilliseconds(null, 0)).toBe('—');
    expect(formatSuccessfulMilliseconds(180, 12)).toBe('180 ms');
  });

  it('formats gate units without switching ratio units to dollars', () => {
    expect(formatUnitValue(0.9933, 'ratio')).toBe('99.33%');
    expect(formatUnitValue(250, 'ms')).toBe('250 ms');
    expect(formatUnitValue(500_000, 'requests')).toBe('500,000');
    expect(formatUnitValue(null, 'ratio')).toBe('—');
  });
});
