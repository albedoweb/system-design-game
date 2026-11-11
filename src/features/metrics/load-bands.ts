import { formatDecimal } from '../../ui/format';

/**
 * Presentation-only occupancy bands shared by component cards, the Inspector
 * and telemetry. These thresholds describe observed load, not a pass/fail
 * verdict: a red block is a warning sign, never proof of a failure.
 */

export const LOAD_BLOCK_COUNT = 10;

export type LoadBand = 'green' | 'yellow' | 'orange' | 'red' | 'dark-red';

export interface LoadBandSpec {
  band: LoadBand;
  /** Player-facing upper bound; the last band is inclusive at 100%. */
  range: string;
  title: string;
}

export const LOAD_BANDS: readonly LoadBandSpec[] = [
  { band: 'green', range: '< 50%', title: 'Green: under 50% occupied' },
  {
    band: 'yellow',
    range: '50–<70%',
    title: 'Yellow: 50% up to but not including 70%',
  },
  {
    band: 'orange',
    range: '70–<85%',
    title: 'Orange: 70% up to but not including 85%',
  },
  { band: 'red', range: '85–<100%', title: 'Red: 85% up to but not including 100%' },
  { band: 'dark-red', range: '100%', title: 'Dark red: at or above capacity' },
];

export function bandTitle(band: LoadBand): string {
  return LOAD_BANDS.find((item) => item.band === band)?.title ?? band;
}

/**
 * Five bands: green below 50%, yellow below 70%, orange below 85%, red below
 * 100%, dark red at 100% or above. Returns null when either side is unknown or
 * the capacity cannot describe occupancy.
 */
export function loadBand(used: number, capacity: number): LoadBand | null {
  if (
    !Number.isFinite(used) ||
    !Number.isFinite(capacity) ||
    capacity <= 0 ||
    used < 0
  ) {
    return null;
  }
  const fraction = used / capacity;
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

/** Number of filled blocks for a fixed ten-block meter. */
export function filledBlocks(used: number, capacity: number): number {
  const band = loadBand(used, capacity);
  if (band === null) {
    return 0;
  }
  if (used <= 0) {
    return 0;
  }
  const ratio = Math.min(1, used / capacity);
  const rounded = Math.round(ratio * LOAD_BLOCK_COUNT);
  // Keep one empty block visible below 100% so a 99% meter does not look full.
  const capped = band === 'dark-red' ? LOAD_BLOCK_COUNT : LOAD_BLOCK_COUNT - 1;
  return Math.min(capped, Math.max(1, rounded));
}

export function loadPercent(used: number, capacity: number): number | null {
  if (loadBand(used, capacity) === null) {
    return null;
  }
  return (used / capacity) * 100;
}

export type OccupancyUnit = 'slots' | 'connections';

export interface Occupancy {
  key: 'slots' | 'pool';
  label: string;
  unit: OccupancyUnit;
  /**
   * Occupancy the meter colors and values. For a completed run this is the
   * time-weighted average, never the peak; live and stopped snapshots keep the
   * current sample.
   */
  used: number | null;
  capacity: number | null;
  /** Time-weighted occupied count for a completed run, when available. */
  average: number | null;
  /** Maximum observed during a completed run, shown separately from the average. */
  peak?: number | null;
  /** Extra player-facing note for unavailable evidence. */
  note?: string;
}

export function occupancyBand(occupancy: Occupancy): LoadBand | null {
  if (occupancy.used === null || occupancy.capacity === null) {
    return null;
  }
  return loadBand(occupancy.used, occupancy.capacity);
}

/** Occupancy counts are fractions for completed runs, so keep one decimal. */
export function occupancyValue(occupancy: Occupancy): string {
  if (occupancy.used === null || occupancy.capacity === null) {
    return '—';
  }
  return `${formatDecimal(occupancy.used, 1)} / ${occupancy.capacity}`;
}

export function occupancyPeakValue(occupancy: Occupancy): string | null {
  if (occupancy.peak === undefined || occupancy.peak === null) {
    return null;
  }
  return formatDecimal(occupancy.peak, 1);
}

export function occupancyAccessibleText(occupancy: Occupancy): string {
  const unit = occupancy.unit === 'slots' ? 'slots' : 'connections';
  if (occupancy.used === null || occupancy.capacity === null) {
    return `${occupancy.label} occupancy unknown`;
  }
  const percent = loadPercent(occupancy.used, occupancy.capacity);
  const band = loadBand(occupancy.used, occupancy.capacity);
  const basis =
    occupancy.average === null
      ? `${formatDecimal(occupancy.used, 1)} of ${occupancy.capacity} ${unit} occupied`
      : `Run average ${formatDecimal(occupancy.average, 1)} of ${occupancy.capacity} ${unit} over the evaluation period`;
  const peak = occupancyPeakValue(occupancy);
  const peakText =
    peak === null
      ? ''
      : ` Peak ${peak} of ${occupancy.capacity}; peak alone does not show how long load was high.`;
  return `${occupancy.label}: ${basis} (${formatDecimal(
    percent,
    0,
  )}%, ${band ? bandTitle(band) : 'unknown band'}).${peakText}`;
}
