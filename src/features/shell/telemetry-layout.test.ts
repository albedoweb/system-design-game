import { describe, expect, it, vi } from 'vitest';

import {
  MIN_CANVAS_HEIGHT,
  MIN_TELEMETRY_HEIGHT,
  TELEMETRY_STORAGE_KEY,
  clampTelemetryHeight,
  readTelemetryHeight,
  telemetryBounds,
  writeTelemetryHeight,
} from './telemetry-layout';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('telemetry separator geometry', () => {
  it('reserves the canvas minimum and clamps both ends', () => {
    const bounds = telemetryBounds(600, 8);
    expect(bounds.min).toBe(MIN_TELEMETRY_HEIGHT);
    expect(bounds.max).toBe(600 - 12 - 16 - MIN_CANVAS_HEIGHT);
    expect(clampTelemetryHeight(0, bounds)).toBe(bounds.min);
    expect(clampTelemetryHeight(9999, bounds)).toBe(bounds.max);
    expect(clampTelemetryHeight(240, bounds)).toBe(240);
    expect(clampTelemetryHeight(Number.NaN, bounds)).toBe(bounds.min);
  });

  it('never returns a maximum below the telemetry header', () => {
    const bounds = telemetryBounds(100, 8);
    expect(bounds.max).toBe(MIN_TELEMETRY_HEIGHT);
    expect(clampTelemetryHeight(200, bounds)).toBe(MIN_TELEMETRY_HEIGHT);
  });

  it('reads and writes only a separate guarded key', () => {
    const storage = memoryStorage();
    writeTelemetryHeight(287.6, storage);
    expect(storage.getItem(TELEMETRY_STORAGE_KEY)).toBe('288');
    expect(readTelemetryHeight(storage)).toBe(288);
    expect(storage.getItem(TELEMETRY_STORAGE_KEY)).not.toContain('graph');
  });

  it('ignores malformed or blocked storage', () => {
    expect(readTelemetryHeight(memoryStorage({ [TELEMETRY_STORAGE_KEY]: 'x' }))).toBeNull();
    const blocked = memoryStorage();
    blocked.getItem = vi.fn(() => {
      throw new Error('blocked');
    });
    blocked.setItem = vi.fn(() => {
      throw new Error('blocked');
    });
    expect(readTelemetryHeight(blocked)).toBeNull();
    expect(() => writeTelemetryHeight(200, blocked)).not.toThrow();
  });

  it('uses tab-local session storage and never overwrites shared localStorage', () => {
    window.localStorage.setItem(TELEMETRY_STORAGE_KEY, '111');
    window.sessionStorage.setItem(TELEMETRY_STORAGE_KEY, '222');

    expect(readTelemetryHeight()).toBe(222);
    writeTelemetryHeight(333);

    expect(window.sessionStorage.getItem(TELEMETRY_STORAGE_KEY)).toBe('333');
    expect(window.localStorage.getItem(TELEMETRY_STORAGE_KEY)).toBe('111');
  });
});
