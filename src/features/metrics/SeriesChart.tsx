import {
  useCallback,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { useMediaQuery } from '../../ui/use-media-query';
import { DASH, formatDecimal, formatSeconds, formatTime } from '../../ui/format';
import { nearestSampleIndex } from './chart-geometry';

export interface ChartSeries {
  label: string;
  color: string;
  values: (number | null)[];
  dashed?: boolean;
}

export interface SeriesChartProps {
  title: string;
  series: ChartSeries[];
  timesMs: number[];
  durationMs: number;
  criticalFromMs?: number;
  criticalToMs?: number;
  flushAtMs?: number | null;
  unit: string;
  valueDigits?: number;
  /** Label of the shaded window in the legend. Defaults to "critical window". */
  criticalLabel?: string;
  /** Horizontal reference line, e.g. the latency SLO. */
  sloValue?: number | null;
  sloLabel?: string;
  /** Controlled time cursor shared by several charts. */
  cursorMs?: number | null;
  onCursorChange?: (timeMs: number | null) => void;
  clearOnPointerLeave?: boolean;
  emptyLabel?: string;
  showLegend?: boolean;
  /** Formats cursor readout values; defaults to `valueDigits` decimals. */
  valueFormatter?: (value: number) => string;
}

function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function safeDuration(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
}

export function SeriesChart({
  title,
  series,
  timesMs,
  durationMs,
  criticalFromMs = 0,
  criticalToMs = 0,
  flushAtMs = null,
  unit,
  valueDigits = 0,
  criticalLabel = 'critical window',
  sloValue = null,
  sloLabel = 'SLO',
  cursorMs = null,
  onCursorChange,
  clearOnPointerLeave = true,
  emptyLabel = 'no data',
  showLegend = true,
  valueFormatter,
}: SeriesChartProps) {
  const width = 340;
  const height = 132;
  const padLeft = 38;
  const padRight = 10;
  const padTop = 10;
  const padBottom = 20;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = height - padTop - padBottom;
  const duration = safeDuration(durationMs);
  const interactive = onCursorChange !== undefined;
  const svgRef = useRef<SVGSVGElement>(null);
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  const maxValue = series.reduce((max, item) => {
    for (const value of item.values) {
      if (value !== null && Number.isFinite(value) && value > max) {
        max = value;
      }
    }
    return max;
  }, sloValue !== null && Number.isFinite(sloValue) ? Math.max(0, sloValue) : 0);
  const yMax = niceMax(maxValue);
  const hasData = series.some((item) => item.values.some((value) => value !== null));
  const formatValue = valueFormatter ?? ((value: number) => formatDecimal(value, valueDigits));

  const x = (timeMs: number) =>
    duration === 0
      ? padLeft
      : padLeft +
        (Math.min(duration, Math.max(0, timeMs)) / duration) * innerWidth;
  const y = (value: number) =>
    padTop + (1 - Math.min(yMax, Math.max(0, value)) / yMax) * innerHeight;

  const criticalX = x(criticalFromMs);
  const criticalWidth = Math.max(0, x(criticalToMs) - criticalX);
  const flushX = flushAtMs === null ? null : x(flushAtMs);
  const sloY =
    sloValue !== null && Number.isFinite(sloValue) ? y(sloValue) : null;
  const cursorIndex =
    cursorMs === null ? -1 : nearestSampleIndex(timesMs, cursorMs);
  // The cursor is always tied to a measured sample of *this* chart's timeline.
  // A shared cursor from another chart may sit between or outside local samples.
  const snappedCursorMs =
    cursorIndex >= 0 ? (timesMs[cursorIndex] ?? null) : null;
  const cursorX = snappedCursorMs === null ? null : x(snappedCursorMs);

  const timeAtPointer = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>): number | null => {
      const svg = svgRef.current;
      if (!svg) {
        return null;
      }
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || duration === 0) {
        return null;
      }
      const viewX = ((event.clientX - rect.left) / rect.width) * width;
      const ratio = Math.min(1, Math.max(0, (viewX - padLeft) / innerWidth));
      return ratio * duration;
    },
    [duration, innerWidth],
  );

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!interactive) {
      return;
    }
    if (timesMs.length === 0) {
      // No measured sample exists, so there is no valid cursor position.
      onCursorChange?.(null);
      return;
    }
    const time = timeAtPointer(event);
    if (time === null) {
      return;
    }
    const index = nearestSampleIndex(timesMs, time);
    onCursorChange?.(timesMs[index] ?? null);
  };

  const handlePointerLeave = () => {
    if (interactive && clearOnPointerLeave) {
      onCursorChange?.(null);
    }
  };

  const stepCursor = (delta: number) => {
    if (!interactive) {
      return;
    }
    const index = nearestSampleIndex(timesMs, cursorMs ?? timesMs[0] ?? 0);
    if (index < 0) {
      return;
    }
    const next = Math.min(timesMs.length - 1, Math.max(0, index + delta));
    onCursorChange?.(timesMs[next] ?? null);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (!interactive) {
      return;
    }
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        stepCursor(-1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        stepCursor(1);
        break;
      case 'Home':
        event.preventDefault();
        onCursorChange?.(timesMs[0] ?? null);
        break;
      case 'End':
        event.preventDefault();
        onCursorChange?.(timesMs[timesMs.length - 1] ?? null);
        break;
      case 'Escape':
        event.preventDefault();
        onCursorChange?.(null);
        break;
      default:
        break;
    }
  };

  const ariaLabel = [
    `${title}: ${series.map((item) => item.label).join(', ')}`,
    interactive
      ? 'Use the Left and Right arrow keys to inspect the timeline.'
      : '',
  ]
    .filter(Boolean)
    .join('. ');

  return (
    <figure
      className={[
        'chart',
        interactive ? 'chart--interactive' : '',
        reduceMotion ? 'chart--reduced-motion' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <figcaption>
        <span>{title}</span>
        <span className="chart__unit">{unit}</span>
      </figcaption>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        tabIndex={interactive ? 0 : undefined}
        onPointerMove={interactive ? handlePointerMove : undefined}
        onPointerLeave={interactive ? handlePointerLeave : undefined}
        onKeyDown={interactive ? handleKeyDown : undefined}
      >
        <rect
          x={criticalX}
          y={padTop}
          width={criticalWidth}
          height={innerHeight}
          className="chart__critical"
        />
        <line
          x1={padLeft}
          y1={padTop + innerHeight}
          x2={width - padRight}
          y2={padTop + innerHeight}
          className="chart__axis"
        />
        <line
          x1={padLeft}
          y1={padTop}
          x2={padLeft}
          y2={padTop + innerHeight}
          className="chart__axis"
        />
        <text x={padLeft - 5} y={padTop + 4} textAnchor="end" className="chart__tick">
          {formatDecimal(yMax, valueDigits)}
        </text>
        <text x={padLeft - 5} y={padTop + innerHeight} textAnchor="end" className="chart__tick">
          0
        </text>
        <text x={padLeft} y={height - 4} className="chart__tick">
          0 s
        </text>
        <text
          x={width - padRight}
          y={height - 4}
          textAnchor="end"
          className="chart__tick"
        >
          {formatSeconds(durationMs)}
        </text>
        {flushX !== null ? (
          <>
            <line
              x1={flushX}
              y1={padTop}
              x2={flushX}
              y2={padTop + innerHeight}
              className="chart__flush"
            />
            <text x={flushX + 3} y={padTop + 8} className="chart__flush-label">
              flush
            </text>
          </>
        ) : null}
        {sloY !== null ? (
          <>
            <line
              x1={padLeft}
              y1={sloY}
              x2={width - padRight}
              y2={sloY}
              className="chart__slo-line"
            />
            <text
              x={width - padRight}
              y={Math.max(padTop + 7, sloY - 3)}
              textAnchor="end"
              className="chart__slo-label"
            >
              {sloLabel} {formatValue(sloValue ?? 0)}
            </text>
          </>
        ) : null}
        {series.map((item) => {
          let path = '';
          let penDown = false;
          item.values.forEach((value, index) => {
            const time = timesMs[index];
            if (time === undefined || value === null || value === undefined) {
              penDown = false;
              return;
            }
            path += `${penDown ? 'L' : 'M'}${x(time).toFixed(1)} ${y(value).toFixed(1)} `;
            penDown = true;
          });
          return (
            <path
              key={item.label}
              d={path}
              fill="none"
              stroke={item.color}
              strokeWidth={1.8}
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={item.dashed ? '4 3' : undefined}
            />
          );
        })}
        {cursorX !== null ? (
          <line
            x1={cursorX}
            y1={padTop}
            x2={cursorX}
            y2={padTop + innerHeight}
            className="chart__cursor"
          />
        ) : null}
        {!hasData ? (
          <text
            x={padLeft + innerWidth / 2}
            y={padTop + innerHeight / 2}
            textAnchor="middle"
            className="chart__empty"
          >
            {emptyLabel}
          </text>
        ) : null}
      </svg>
      {snappedCursorMs !== null && cursorIndex >= 0 ? (
        <p className="chart__readout" data-testid="chart-readout">
          <span className="chart__readout-time">{formatTime(snappedCursorMs)}</span>
          {series.map((item) => {
            const value = item.values[cursorIndex];
            return (
              <span className="chart__readout-value" key={item.label}>
                {item.label}: {value === null || value === undefined ? DASH : formatValue(value)}
              </span>
            );
          })}
        </p>
      ) : null}
      {showLegend ? (
        <ul className="chart__legend">
          {series.map((item) => (
            <li key={item.label}>
              <span style={{ background: item.color }} aria-hidden="true" />
              {item.label}
            </li>
          ))}
          {sloValue !== null ? (
            <li className="chart__legend-slo">
              <span aria-hidden="true" /> {sloLabel}
            </li>
          ) : null}
          <li className="chart__legend-critical">
            <span aria-hidden="true" /> {criticalLabel}
          </li>
        </ul>
      ) : null}
    </figure>
  );
}
