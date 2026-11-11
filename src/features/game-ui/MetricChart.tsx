import { useId } from 'react';

import { SeriesChart, type ChartSeries } from '../metrics/SeriesChart';
import './game-ui.css';

export type MetricChartKind = 'traffic' | 'latency' | 'queue' | 'resources';

export interface ChartOperation {
  id: string;
  label: string;
  series: ChartSeries[];
}

export interface MetricChartProps {
  kind: MetricChartKind;
  title?: string;
  /** Selected node's series, supplied by the level. */
  series?: ChartSeries[];
  /** Operation selector: one entry per operation the level measures. */
  operations?: ChartOperation[];
  selectedOperationId?: string;
  onOperationChange?: (id: string) => void;
  timesMs: number[];
  durationMs: number;
  criticalFromMs?: number;
  criticalToMs?: number;
  criticalLabel?: string;
  slo?: { value: number; label?: string } | null;
  unit: string;
  valueDigits?: number;
  cursorMs?: number | null;
  onCursorChange?: (timeMs: number | null) => void;
  valueFormatter?: (value: number) => string;
  emptyLabel?: string;
  className?: string;
  ariaLabel?: string;
}

const DEFAULT_TITLES: Record<MetricChartKind, string> = {
  traffic: 'Traffic',
  latency: 'Latency',
  queue: 'Queue',
  resources: 'Resources',
};

/**
 * One of the four reusable telemetry graphs. The data always comes from the
 * engine result arrays passed by the level; a controlled cursor can be shared
 * across charts so hover, keyboard inspection and replay use one time.
 */
export function MetricChart({
  kind,
  title,
  series,
  operations,
  selectedOperationId,
  onOperationChange,
  timesMs,
  durationMs,
  criticalFromMs,
  criticalToMs,
  criticalLabel,
  slo = null,
  unit,
  valueDigits = 0,
  cursorMs = null,
  onCursorChange,
  valueFormatter,
  emptyLabel,
  className,
  ariaLabel,
}: MetricChartProps) {
  const operationSelectId = useId();
  const activeOperation = operations?.find((item) => item.id === selectedOperationId) ?? operations?.[0];
  const activeSeries = activeOperation?.series ?? series ?? [];

  return (
    <div className={['game-chart', `game-chart--${kind}`, className].filter(Boolean).join(' ')}>
      {operations && operations.length > 0 ? (
        <div className="game-chart__operations">
          <label htmlFor={operationSelectId}>Operation</label>
          <select
            id={operationSelectId}
            value={activeOperation?.id ?? ''}
            onChange={(event) => onOperationChange?.(event.target.value)}
          >
            {operations.map((operation) => (
              <option key={operation.id} value={operation.id}>
                {operation.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <SeriesChart
        title={title ?? DEFAULT_TITLES[kind]}
        series={activeSeries}
        timesMs={timesMs}
        durationMs={durationMs}
        criticalFromMs={criticalFromMs}
        criticalToMs={criticalToMs}
        criticalLabel={criticalLabel}
        sloValue={slo?.value ?? null}
        sloLabel={slo?.label}
        unit={unit}
        valueDigits={valueDigits}
        cursorMs={cursorMs}
        onCursorChange={onCursorChange}
        valueFormatter={valueFormatter}
        emptyLabel={emptyLabel}
      />
      {ariaLabel ? (
        <p className="visually-hidden" aria-live="polite">
          {ariaLabel}
        </p>
      ) : null}
    </div>
  );
}
