import { useCallback, useState } from 'react';

/**
 * Chart colors reused from the first level's telemetry palette. Levels wire
 * their own series; this module never invents or derives a metric series.
 */
export const CHART_METRIC_COLORS = {
  offered: '#0e7490',
  successful: '#15803d',
  errors: '#b42318',
  latency: '#1d4ed8',
  queue: '#b45309',
  resource: '#7c3aed',
} as const;

export interface ChartCursor {
  cursorMs: number | null;
  setCursorMs: (timeMs: number | null) => void;
  clearCursor: () => void;
}

/** Small controlled cursor helper so several charts can share one time. */
export function useChartCursor(initial: number | null = null): ChartCursor {
  const [cursorMs, setCursorMs] = useState<number | null>(initial);
  const clearCursor = useCallback(() => setCursorMs(null), []);
  return { cursorMs, setCursorMs, clearCursor };
}
