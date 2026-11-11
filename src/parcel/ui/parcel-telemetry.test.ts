import { describe, expect, it, vi } from 'vitest';

import {
  PARCEL_DEFAULT_TELEMETRY_HEIGHT,
  PARCEL_TELEMETRY_KEY,
  readParcelTelemetryHeight,
  writeParcelTelemetryHeight,
} from './parcel-telemetry';

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

describe('Parcel telemetry divider preference', () => {
  it('reads and writes a rounded value in an injected storage', () => {
    const storage = memoryStorage();
    writeParcelTelemetryHeight(287.6, storage);
    expect(storage.getItem(PARCEL_TELEMETRY_KEY)).toBe('288');
    expect(readParcelTelemetryHeight(storage)).toBe(288);
  });

  it('ignores malformed values and blocked storage', () => {
    expect(
      readParcelTelemetryHeight(
        memoryStorage({ [PARCEL_TELEMETRY_KEY]: 'not-a-number' }),
      ),
    ).toBeNull();
    const blocked = memoryStorage();
    blocked.getItem = vi.fn(() => {
      throw new Error('blocked');
    });
    blocked.setItem = vi.fn(() => {
      throw new Error('blocked');
    });
    expect(readParcelTelemetryHeight(blocked)).toBeNull();
    expect(() => writeParcelTelemetryHeight(240, blocked)).not.toThrow();
  });

  it('keeps the preference tab-local and never writes shared localStorage', () => {
    expect(PARCEL_DEFAULT_TELEMETRY_HEIGHT).toBe(300);
    window.localStorage.setItem(PARCEL_TELEMETRY_KEY, '111');
    window.sessionStorage.setItem(PARCEL_TELEMETRY_KEY, '222');

    expect(readParcelTelemetryHeight()).toBe(222);
    writeParcelTelemetryHeight(333);

    expect(window.sessionStorage.getItem(PARCEL_TELEMETRY_KEY)).toBe('333');
    expect(window.localStorage.getItem(PARCEL_TELEMETRY_KEY)).toBe('111');
  });
});
