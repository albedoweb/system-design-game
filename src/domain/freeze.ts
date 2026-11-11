/**
 * Recursively freeze a plain JSON value in place and return it.
 * Used for shipped defaults only; parsed inputs stay mutable for engine/UI.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
