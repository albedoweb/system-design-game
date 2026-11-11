const integerFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});

const decimalFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
});

const moneyFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const DASH = '—';

export function formatInteger(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? DASH
    : integerFormatter.format(value);
}

export function formatDecimal(
  value: number | null | undefined,
  digits = 1,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return DASH;
  }
  return digits === 1
    ? decimalFormatter.format(value)
    : new Intl.NumberFormat('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(value);
}

export function formatMoney(valueUsd: number | null | undefined): string {
  return valueUsd === null || valueUsd === undefined || !Number.isFinite(valueUsd)
    ? DASH
    : `$${moneyFormatter.format(valueUsd)}`;
}

export function formatMicroUsd(microUsd: number | null | undefined): string {
  return formatMoney(
    microUsd === null || microUsd === undefined ? null : microUsd / 1_000_000,
  );
}

export function formatPercent(
  fraction: number | null | undefined,
  digits = 2,
): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) {
    return DASH;
  }
  return `${formatDecimal(fraction * 100, digits)}%`;
}

export function formatSeconds(ms: number | null | undefined): string {
  return ms === null || ms === undefined || !Number.isFinite(ms)
    ? DASH
    : `${formatDecimal(ms / 1000, 0)} s`;
}

/**
 * Exact player-facing duration: milliseconds below one second (so 800 ms is
 * never rounded to "1 s" and 10 ms is never "0 s"), whole seconds otherwise.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return DASH;
  }
  if (Math.abs(ms) < 1000) {
    return `${formatDecimal(ms, Number.isInteger(ms) ? 0 : 1)} ms`;
  }
  const seconds = ms / 1000;
  return `${formatDecimal(seconds, Number.isInteger(seconds) ? 0 : 1)} s`;
}

export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return DASH;
  }
  const sign = ms < 0 ? '−' : '';
  const totalSeconds = Math.abs(ms) / 1000;
  return `${sign}${formatDecimal(totalSeconds, totalSeconds < 10 ? 1 : 0)} s`;
}

export function formatBytes(kib: number | null | undefined): string {
  if (kib === null || kib === undefined || !Number.isFinite(kib)) {
    return DASH;
  }
  if (kib >= 1024) {
    return `${formatDecimal(kib / 1024, 1)} MiB`;
  }
  return `${formatInteger(kib)} KiB`;
}
