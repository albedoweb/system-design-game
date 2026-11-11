import { describe, expect, it } from 'vitest';

import { MAX_ARRIVALS } from '../../domain/level';
import { SimulationLimitError } from '../errors';
import {
  arrivalTimesFromHazards,
  generateOfferedTrace,
  validateOfferedTrace,
  type OfferedRequest,
} from '../index';
import { testLevel } from './helpers';

describe('piecewise Poisson workload', () => {
  it('carries hazard through rate changes and zero-rate gaps', () => {
    const hazards = [0.5, 1, 0.5];
    let index = 0;
    const arrivals = arrivalTimesFromHazards(
      [
        { atMs: 0, rps: 100 },
        { atMs: 10, rps: 0 },
        { atMs: 20, rps: 200 },
      ],
      0,
      60_000,
      () => hazards[index++] ?? 1,
    );
    expect(arrivals.slice(0, 3)).toEqual([5, 22.5, 25]);
    expect(arrivals.every((time) => time < 10 || time >= 20)).toBe(true);
  });

  it('is deterministic per seed and stable across separately generated traces', () => {
    const level = testLevel({
      durationMs: 2000,
      readSchedule: [{ atMs: 0, rps: 100 }],
      writeSchedule: [{ atMs: 0, rps: 10 }],
    });
    const first = generateOfferedTrace(level, 101);
    const second = generateOfferedTrace(level, 101);
    const other = generateOfferedTrace(level, 211);
    expect(second).toEqual(first);
    expect(other).not.toEqual(first);
    expect(first.requests.length).toBeGreaterThan(100);
    expect(
      first.requests.every(
        (request) => request.key >= 0 && request.key < level.workloads.read.keySpace,
      ),
    ).toBe(true);
  });

  it('rejects an offered trace above the 500k arrival limit', () => {
    const level = testLevel();
    const oversized = {
      seed: 101,
      requests: { length: MAX_ARRIVALS + 1 } as unknown as OfferedRequest[],
    };
    expect(() => validateOfferedTrace(oversized, level)).toThrow(
      SimulationLimitError,
    );
  });

  it('marks warmup arrivals but keeps them in the offered trace', () => {
    const level = testLevel({
      warmupMs: 1000,
      durationMs: 2000,
      readSchedule: [{ atMs: 0, rps: 50 }],
    });
    const trace = generateOfferedTrace(level, 307);
    const warmup = trace.requests.filter((request) => request.arrivalMs < 0);
    expect(warmup.length).toBeGreaterThan(0);
    expect(warmup.every((request) => !request.scored)).toBe(true);
    expect(
      trace.requests.filter((request) => request.arrivalMs >= 0).every((request) => request.scored),
    ).toBe(true);
  });
});
