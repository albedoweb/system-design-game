import { describe, expect, it } from 'vitest';

import {
  LOAD_BLOCK_COUNT,
  filledBlocks,
  loadBand,
  loadPercent,
  occupancyAccessibleText,
  occupancyPeakValue,
  occupancyValue,
  type Occupancy,
} from './load-bands';

function occupancy(overrides: Partial<Occupancy> = {}): Occupancy {
  return {
    key: 'slots',
    label: 'Slots',
    unit: 'slots',
    used: 0,
    capacity: 16,
    average: null,
    ...overrides,
  };
}

describe('load bands', () => {
  it('maps exact band boundaries to five colors', () => {
    expect(loadBand(0, 16)).toBe('green');
    expect(loadBand(7, 16)).toBe('green');
    expect(loadBand(8, 16)).toBe('yellow'); // exactly 50%
    expect(loadBand(11, 16)).toBe('yellow'); // 68.75%
    expect(loadBand(12, 16)).toBe('orange'); // exactly 75%
    expect(loadBand(13, 16)).toBe('orange'); // 81.25%
    expect(loadBand(14, 16)).toBe('red'); // exactly 87.5%
    expect(loadBand(15, 16)).toBe('red'); // 93.75%
    expect(loadBand(16, 16)).toBe('dark-red'); // exactly 100%
    expect(loadBand(20, 16)).toBe('dark-red');
  });

  it('returns unknown for absent, zero or invalid capacity', () => {
    expect(loadBand(0, 0)).toBeNull();
    expect(loadBand(1, 0)).toBeNull();
    expect(loadBand(1, -1)).toBeNull();
    expect(loadBand(Number.NaN, 16)).toBeNull();
    expect(loadBand(1, Number.NaN)).toBeNull();
  });

  it('distinguishes idle, nearly full and full meters', () => {
    expect(filledBlocks(0, 16)).toBe(0);
    expect(filledBlocks(1, 16)).toBe(1);
    expect(filledBlocks(8, 16)).toBe(5);
    expect(filledBlocks(15, 16)).toBe(9);
    expect(filledBlocks(16, 16)).toBe(LOAD_BLOCK_COUNT);
    expect(filledBlocks(0, 0)).toBe(0);
  });

  it('returns exact percentages and unknown labels', () => {
    expect(loadPercent(8, 16)).toBe(50);
    expect(loadPercent(0, 0)).toBeNull();
    expect(occupancyAccessibleText(occupancy())).toContain('0 of 16 slots');
    expect(
      occupancyAccessibleText(occupancy({ used: null, capacity: null })),
    ).toBe('Slots occupancy unknown');
  });

  it('keeps one decimal for fractional meter values and peaks', () => {
    expect(occupancyValue(occupancy({ used: 3.25, capacity: 4 }))).toBe(
      '3.3 / 4',
    );
    expect(
      occupancyValue(occupancy({ used: 0.8, capacity: 4, peak: 4 })),
    ).toBe('0.8 / 4');
    expect(occupancyPeakValue(occupancy({ peak: 4 }))).toBe('4');
    expect(occupancyPeakValue(occupancy())).toBeNull();
  });

  it('describes the run average and the separate observed peak', () => {
    const text = occupancyAccessibleText(
      occupancy({ used: 12.5, average: 12.5, peak: 16 }),
    );
    expect(text).toContain('Run average 12.5 of 16 slots');
    expect(text).toContain('over the evaluation period');
    expect(text).toContain('Peak 16 of 16');
    expect(text).toContain(
      'peak alone does not show how long load was high',
    );
  });
});
