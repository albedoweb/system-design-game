export const IMAGE_TELEMETRY_KEY = 'sdg.image-atlas.telemetry.height.v1';
export const IMAGE_DEFAULT_TELEMETRY_HEIGHT = 300;

// The divider height is a tab-local preference: sessionStorage is cloned by the
// browser when a tab is duplicated and then evolves per tab, so one tab cannot
// overwrite another tab's dimensions. It never touches shared localStorage and
// is unrelated to graph state; Image Atlas has no automatic draft saving.
function browserStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readImageTelemetryHeight(
  storage: Storage | null = browserStorage(),
): number | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(IMAGE_TELEMETRY_KEY);
    if (!raw) {
      return null;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? Math.round(value) : null;
  } catch {
    return null;
  }
}

export function writeImageTelemetryHeight(
  value: number,
  storage: Storage | null = browserStorage(),
): void {
  if (!storage || !Number.isFinite(value)) {
    return;
  }
  try {
    storage.setItem(IMAGE_TELEMETRY_KEY, String(Math.round(value)));
  } catch {
    // A blocked or full storage must never break resizing.
  }
}
