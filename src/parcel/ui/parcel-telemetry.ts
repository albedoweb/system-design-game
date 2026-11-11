export const PARCEL_TELEMETRY_KEY = 'sdg.parcel.telemetry.height.v1';
export const PARCEL_DEFAULT_TELEMETRY_HEIGHT = 300;

// The divider height is a tab-local preference: sessionStorage is cloned by
// the browser when a tab is duplicated and then evolves per tab, so one tab
// cannot overwrite another tab's dimensions. It never touches shared
// localStorage and is unrelated to graph drafts.
function browserStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readParcelTelemetryHeight(
  storage: Storage | null = browserStorage(),
): number | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(PARCEL_TELEMETRY_KEY);
    if (!raw) {
      return null;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? Math.round(value) : null;
  } catch {
    return null;
  }
}

export function writeParcelTelemetryHeight(
  value: number,
  storage: Storage | null = browserStorage(),
): void {
  if (!storage || !Number.isFinite(value)) {
    return;
  }
  try {
    storage.setItem(PARCEL_TELEMETRY_KEY, String(Math.round(value)));
  } catch {
    // A blocked or full storage must never break resizing.
  }
}
