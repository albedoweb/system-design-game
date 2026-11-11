/**
 * Nearest sample index for a time cursor. Samples come from the engine's own
 * timeline array; this only snaps pointer/keyboard input to measured points.
 */
export function nearestSampleIndex(timesMs: readonly number[], timeMs: number): number {
  if (timesMs.length === 0) {
    return -1;
  }
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  timesMs.forEach((value, index) => {
    const distance = Math.abs(value - timeMs);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}
