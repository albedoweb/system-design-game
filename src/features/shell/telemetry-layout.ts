/**
 * Geometry and persistence for the horizontal canvas/telemetry separator.
 * Bounds are recomputed from the live split container so viewport and notice
 * changes cannot leave a stored height outside the visible layout.
 *
 * The height is a tab-local preference in sessionStorage: a duplicated tab
 * inherits it once, then each tab keeps its own. Shared localStorage is never
 * written, so two tabs cannot overwrite each other's layout on reload.
 */

export const MIN_CANVAS_HEIGHT = 180;
export const MIN_TELEMETRY_HEIGHT = 96;
export const TELEMETRY_RESIZER_HEIGHT = 12;
export const TELEMETRY_STORAGE_KEY = 'sdg.telemetry.height.v1';

export interface TelemetryBounds {
  min: number;
  max: number;
}

export function telemetryBounds(
  containerHeight: number,
  gap = 8,
): TelemetryBounds {
  const available = Math.max(
    0,
    containerHeight - TELEMETRY_RESIZER_HEIGHT - gap * 2,
  );
  return {
    min: MIN_TELEMETRY_HEIGHT,
    max: Math.max(MIN_TELEMETRY_HEIGHT, available - MIN_CANVAS_HEIGHT),
  };
}

export function clampTelemetryHeight(
  value: number,
  bounds: TelemetryBounds,
): number {
  if (!Number.isFinite(value)) {
    return bounds.min;
  }
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, value)));
}

function browserStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readTelemetryHeight(
  storage: Storage | null = browserStorage(),
): number | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(TELEMETRY_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? Math.round(value) : null;
  } catch {
    return null;
  }
}

export function writeTelemetryHeight(
  value: number,
  storage: Storage | null = browserStorage(),
): void {
  if (!storage || !Number.isFinite(value)) {
    return;
  }
  try {
    storage.setItem(TELEMETRY_STORAGE_KEY, String(Math.round(value)));
  } catch {
    // A full or blocked storage must never break resizing.
  }
}
