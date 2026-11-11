import type {
  ParcelBusinessOperation,
  ParcelCheck,
  ParcelHorizonYears,
  ParcelOperation,
} from '../contracts';
import { DASH, formatDecimal, formatInteger, formatMoney } from '../../ui/format';

export type ParcelLoadBand = 'green' | 'yellow' | 'orange' | 'red' | 'dark-red';

export const PARCEL_LOAD_BAND_TITLES: Readonly<
  Record<ParcelLoadBand, string>
> = {
  green: 'green: under 50% of capacity',
  yellow: 'yellow: 50% up to but not including 70%',
  orange: 'orange: 70% up to but not including 85%',
  red: 'red: 85% up to but not including 100%',
  'dark-red': 'dark red: at or above capacity',
};

export function parcelLoadBand(fraction: number | null | undefined): ParcelLoadBand | null {
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

export function parcelFilledBlocks(fraction: number | null | undefined): number {
  const band = parcelLoadBand(fraction);
  if (band === null || fraction === null || fraction === undefined || fraction <= 0) {
    return 0;
  }
  const rounded = Math.round(Math.min(1, fraction) * 10);
  if (band === 'dark-red') {
    return 10;
  }
  return Math.min(9, Math.max(1, rounded));
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

export function formatHorizon(years: ParcelHorizonYears): string {
  return years === 1 ? 'Year 1' : 'Year 5';
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
 * never be rendered as a green 0 ms result.
 */
export function formatSuccessfulMilliseconds(
  ms: number | null | undefined,
  successCount: number,
): string {
  return successCount > 0 ? formatMilliseconds(ms) : DASH;
}

export function formatOperationName(operation: ParcelBusinessOperation): string {
  return operation === 'status'
    ? 'Status'
    : operation === 'history'
      ? 'History'
      : operation === 'ingest'
        ? 'Ingest'
        : 'Reports';
}

export function formatCheckValue(check: Pick<ParcelCheck, 'actual' | 'unit'>): string {
  return formatCheckNumber(check.actual, check.unit);
}

export function formatCheckLimit(check: Pick<ParcelCheck, 'limit' | 'unit'>): string {
  return formatCheckNumber(check.limit, check.unit);
}

function formatCheckNumber(
  value: number | undefined,
  unit: string | undefined,
): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
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
      return formatMoney(value);
    case 'TB':
      return formatTerabytes(value);
    case 'bytes':
    case 'B':
      return formatDataSize(value);
    case 'requests':
    case 'events':
      return formatInteger(value);
    case 'ratio':
      return formatDecimal(value, 2);
    default:
      return formatDecimal(value, 2);
  }
}

export function operationPassLabel(
  operation: ParcelBusinessOperation,
  availability: number,
  p95Ms: number,
  freshnessP95Ms: number | null,
  level: {
    slo: {
      availability: number;
      p95Ms: Record<ParcelBusinessOperation, number>;
      freshnessMs: Record<'status' | 'report', number>;
    };
  },
  successCount = 1,
): { passed: boolean; reason: string } {
  const reasons: string[] = [];
  if (availability < level.slo.availability) {
    reasons.push(
      `availability ${formatFractionPercent(availability, 2)} is below ${formatFractionPercent(level.slo.availability, 1)}`,
    );
  }
  if (successCount <= 0) {
    reasons.push('no successful responses, so latency percentiles are not applicable');
  } else if (p95Ms > level.slo.p95Ms[operation]) {
    reasons.push(
      `successful p95 ${formatMilliseconds(p95Ms)} exceeds ${formatMilliseconds(level.slo.p95Ms[operation])}`,
    );
  }
  if (operation === 'status' || operation === 'report') {
    const limit = level.slo.freshnessMs[operation];
    if (successCount <= 0) {
      reasons.push('no successful samples to measure freshness');
    } else if (freshnessP95Ms !== null && freshnessP95Ms > limit) {
      reasons.push(
        `freshness ${formatMilliseconds(freshnessP95Ms)} exceeds ${formatMilliseconds(limit)}`,
      );
    }
  }
  return {
    passed: reasons.length === 0,
    reason: reasons.length === 0 ? 'Meets the target.' : reasons.join('; '),
  };
}

export function operationMetricKey(
  operation: ParcelOperation,
): ParcelBusinessOperation | null {
  return operation === 'status' ||
    operation === 'history' ||
    operation === 'ingest' ||
    operation === 'report'
    ? operation
    : null;
}
