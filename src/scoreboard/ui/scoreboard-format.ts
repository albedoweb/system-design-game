import { DASH, formatDecimal, formatInteger } from '../../ui/format';

/** Exact player-facing formatting for Live Scoreboard results. */

export function formatAvailability(
  fraction: number | null | undefined,
): string {
  return fraction === null || fraction === undefined || !Number.isFinite(fraction)
    ? DASH
    : `${formatDecimal(fraction * 100, 2)}%`;
}

export function formatPercentExact(
  fraction: number | null | undefined,
  digits = 2,
): string {
  return fraction === null || fraction === undefined || !Number.isFinite(fraction)
    ? DASH
    : `${formatDecimal(fraction * 100, digits)}%`;
}

/** Keep enough digits for very small measured run costs to stay meaningful. */
export function formatUsdPrecise(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return DASH;
  }
  const digits = value === 0 ? 2 : value < 0.001 ? 6 : value < 0.01 ? 5 : value < 1 ? 4 : 2;
  return `$${formatDecimal(value, digits)}`;
}

/** Hourly rent is always shown separately from the actual run charge. */
export function formatHourlyUsd(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? DASH
    : `$${formatDecimal(value, 3)}/h`;
}

export function formatMillisecondsPrecise(
  value: number | null | undefined,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return DASH;
  }
  if (Math.abs(value) >= 1_000) {
    return `${formatDecimal(value / 1_000, value % 1_000 === 0 ? 0 : 2)} s`;
  }
  return `${formatDecimal(value, Number.isInteger(value) ? 0 : 2)} ms`;
}

/** Percentiles cover successful responses only; no samples must stay unknown. */
export function formatSuccessfulMilliseconds(
  value: number | null | undefined,
  successful: number,
): string {
  return successful > 0 ? formatMillisecondsPrecise(value) : DASH;
}

export function formatDataSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
    return DASH;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = value < 10 && unit > 0 ? 2 : value < 100 && unit > 0 ? 1 : 0;
  return `${bytes < 0 ? '−' : ''}${formatDecimal(value, digits)} ${units[unit]}`;
}

export function formatBytesPerSecond(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined || !Number.isFinite(bytes)
    ? DASH
    : `${formatDataSize(bytes)}/s`;
}

export function formatGbit(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? DASH
    : `${formatDecimal(value, value < 10 ? 2 : 1)} Gbit/s`;
}

/** One-second engine totals become rates by the real interval denominator. */
export function formatSeriesRate(
  count: number | null | undefined,
  windowMs: number,
): number | null {
  if (
    count === null ||
    count === undefined ||
    !Number.isFinite(count) ||
    !Number.isFinite(windowMs) ||
    windowMs <= 0
  ) {
    return null;
  }
  return (count / windowMs) * 1_000;
}

export function formatRate(
  count: number | null | undefined,
  windowMs: number,
  digits = 1,
): string {
  const rate = formatSeriesRate(count, windowMs);
  return rate === null ? DASH : `${formatDecimal(rate, digits)}/s`;
}

export function formatBoolean(
  value: boolean | null | undefined,
): string {
  return value === null || value === undefined ? DASH : value ? 'Yes' : 'No';
}

export function formatUnitValue(
  value: number | null | undefined,
  unit: string | undefined,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return DASH;
  }
  switch (unit) {
    case '%':
    case 'ratio':
    case 'fraction':
      return `${formatDecimal(value <= 1 ? value * 100 : value, 2)}%`;
    case 'ms':
      return formatMillisecondsPrecise(value);
    case '$':
    case 'USD':
    case '$/h':
      return formatUsdPrecise(value);
    case 'bytes':
    case 'B':
      return formatDataSize(value);
    case 'Gbit/s':
      return formatGbit(value);
    case 'requests':
    case 'events':
    case 'samples':
    case 'tasks':
    case 'rows':
      return formatInteger(value);
    default:
      return formatDecimal(value, 2);
  }
}

export function formatCount(value: number | null | undefined): string {
  return formatInteger(value);
}
