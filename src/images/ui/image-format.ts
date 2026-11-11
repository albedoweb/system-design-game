import { DASH, formatDecimal, formatInteger } from '../../ui/format';

export type ImageLoadBand = 'green' | 'yellow' | 'orange' | 'red' | 'dark-red';

export const IMAGE_LOAD_BAND_TITLES: Readonly<Record<ImageLoadBand, string>> = {
  green: 'green: under 50% of capacity',
  yellow: 'yellow: 50% up to but not including 70%',
  orange: 'orange: 70% up to but not including 85%',
  red: 'red: 85% up to but not including 100%',
  'dark-red': 'dark red: at or above capacity',
};

/** Same disclosed bands as the shared workspace visuals. */
export function imageLoadBand(
  fraction: number | null | undefined,
): ImageLoadBand | null {
  if (
    fraction === null ||
    fraction === undefined ||
    !Number.isFinite(fraction) ||
    fraction < 0
  ) {
    return null;
  }
  if (fraction >= 1) {
    return 'dark-red';
  }
  if (fraction >= 0.85) {
    return 'red';
  }
  if (fraction >= 0.7) {
    return 'orange';
  }
  if (fraction >= 0.5) {
    return 'yellow';
  }
  return 'green';
}

export function imageFilledBlocks(
  fraction: number | null | undefined,
): number {
  const band = imageLoadBand(fraction);
  if (
    band === null ||
    fraction === null ||
    fraction === undefined ||
    fraction <= 0
  ) {
    return 0;
  }
  if (band === 'dark-red') {
    return 10;
  }
  return Math.min(9, Math.max(1, Math.round(Math.min(1, fraction) * 10)));
}

export function formatFractionPercent(
  fraction: number | null | undefined,
  digits = 0,
): string {
  if (
    fraction === null ||
    fraction === undefined ||
    !Number.isFinite(fraction)
  ) {
    return DASH;
  }
  return `${formatDecimal(fraction * 100, digits)}%`;
}

/** Decimal byte units, matching the frozen level's decimal megabytes. */
export function formatDataSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
    return DASH;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const sign = bytes < 0 ? '−' : '';
  const digits = value < 10 && unit > 0 ? 2 : value < 100 && unit > 0 ? 1 : 0;
  return `${sign}${formatDecimal(value, digits)} ${units[unit]}`;
}

export function formatTerabytes(tb: number | null | undefined): string {
  return tb === null || tb === undefined || !Number.isFinite(tb)
    ? DASH
    : `${formatDecimal(tb, tb < 10 ? 2 : 1)} TB`;
}

export function formatGbitPerSec(gbit: number | null | undefined): string {
  return gbit === null || gbit === undefined || !Number.isFinite(gbit)
    ? DASH
    : `${formatDecimal(gbit, gbit < 10 ? 2 : 1)} Gbit/s`;
}

export function formatMegabytesPerSec(mbps: number | null | undefined): string {
  return mbps === null || mbps === undefined || !Number.isFinite(mbps)
    ? DASH
    : `${formatDecimal(mbps, 1)} MB/s`;
}

export function formatMilliseconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return DASH;
  }
  if (Math.abs(ms) >= 1000) {
    return `${formatDecimal(ms / 1000, ms % 1000 === 0 ? 0 : 1)} s`;
  }
  return `${formatDecimal(ms, Number.isInteger(ms) ? 0 : 1)} ms`;
}

/**
 * Percentiles describe successful responses only. An empty success set must
 * never be rendered as a green 0 ms measurement.
 */
export function formatSuccessfulMilliseconds(
  ms: number | null | undefined,
  successCount: number,
): string {
  return successCount > 0 ? formatMilliseconds(ms) : DASH;
}

export function formatUsd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return DASH;
  }
  return `$${formatDecimal(value, digits)}`;
}

export function formatCount(value: number | null | undefined): string {
  return formatInteger(value);
}

export function formatRatio(
  fraction: number | null | undefined,
  digits = 2,
): string {
  return fraction === null || fraction === undefined || !Number.isFinite(fraction)
    ? DASH
    : formatDecimal(fraction, digits);
}

export function formatCheckNumber(
  value: number | undefined,
  unit: string | undefined,
): string {
  if (value === undefined || !Number.isFinite(value)) {
    return DASH;
  }
  switch (unit) {
    case '%':
      return `${formatDecimal(value <= 1 ? value * 100 : value, 2)}%`;
    case 'ms':
      return formatMilliseconds(value);
    case '$':
    case 'USD':
    case '$/h':
    case '$/mo':
      return formatUsd(value);
    case 'TB':
      return formatTerabytes(value);
    case 'bytes':
    case 'B':
      return formatDataSize(value);
    case 'Gbit/s':
      return formatGbitPerSec(value);
    case 'ratio':
      // Availability gates store a fraction. Player-facing text is always a
      // percentage with two decimals (99.33%), never a bare 0.99 ratio.
      return formatFractionPercent(value, 2);
    case 'requests':
    case 'events':
    case 'samples':
    case 'records':
      return formatInteger(value);
    default:
      return formatDecimal(value, 2);
  }
}
