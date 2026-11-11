import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEVEL,
  type Metric,
  type RunResult,
  type SimulationSnapshot,
} from '../domain';
import { readBestLocal, recordBestLocal } from './local-best';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const metric: Metric = {
  offered: 10,
  succeeded: 10,
  failed: 0,
  pending: 0,
  p50Ms: 10,
  p95Ms: 20,
  p99Ms: 30,
  errors: {},
};

const snapshot: SimulationSnapshot = {
  timeMs: 60_800,
  phase: 'completed',
  reads: metric,
  writes: metric,
  nodes: [],
  series: [],
  events: [],
};

function result(
  seed: number,
  passed: boolean,
  costMicroUsdPerHour: number,
): RunResult {
  return {
    seed,
    passed,
    costMicroUsdPerHour,
    checks: [],
    snapshot,
    diagnostics: [],
  };
}

describe('local best result', () => {
  it('хранит только прошедший результат и только улучшение цены', () => {
    const storage = new MemoryStorage();
    const first = recordBestLocal(storage, DEFAULT_LEVEL, result(101, true, 2_600_000));
    expect(first.isNewBest).toBe(true);
    expect(first.best?.costMicroUsdPerHour).toBe(2_600_000);

    const worse = recordBestLocal(storage, DEFAULT_LEVEL, result(101, true, 3_000_000));
    expect(worse.isNewBest).toBe(false);
    expect(worse.best?.costMicroUsdPerHour).toBe(2_600_000);

    const failed = recordBestLocal(storage, DEFAULT_LEVEL, result(101, false, 1_000_000));
    expect(failed.isNewBest).toBe(false);
    expect(readBestLocal(storage, DEFAULT_LEVEL, 101).best?.costMicroUsdPerHour).toBe(
      2_600_000,
    );
  });

  it('разделяет лучший результат по seed', () => {
    const storage = new MemoryStorage();
    recordBestLocal(storage, DEFAULT_LEVEL, result(101, true, 2_600_000));
    recordBestLocal(storage, DEFAULT_LEVEL, result(211, true, 2_800_000));
    expect(readBestLocal(storage, DEFAULT_LEVEL, 101).best?.costMicroUsdPerHour).toBe(
      2_600_000,
    );
    expect(readBestLocal(storage, DEFAULT_LEVEL, 211).best?.costMicroUsdPerHour).toBe(
      2_800_000,
    );
  });
});
