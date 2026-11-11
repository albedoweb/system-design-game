import {
  CACHE_ENTRY_KIB,
  expectedArrivals,
  getSizeSpec,
  type LevelDefinition,
  type NodeKind,
  type NodeSize,
  type SchedulePoint,
} from '../../domain';
import { formatBytes, formatDecimal, formatMoney } from '../../ui/format';

export interface ScheduleWindow {
  fromMs: number;
  toMs: number;
  readRps: number;
  writeRps: number;
  totalRps: number;
}

function rateAt(schedule: readonly SchedulePoint[], timeMs: number): number {
  let value = 0;
  for (const point of schedule) {
    if (point.atMs <= timeMs) {
      value = point.rps;
    }
  }
  return value;
}

export function scheduleWindows(level: LevelDefinition): ScheduleWindow[] {
  const boundaries = new Set<number>([0]);
  for (const point of level.workloads.read.schedule) {
    boundaries.add(point.atMs);
  }
  for (const point of level.workloads.write.schedule) {
    boundaries.add(point.atMs);
  }
  const times = [...boundaries]
    .filter((time) => time < level.durationMs)
    .sort((a, b) => a - b);
  return times.map((fromMs, index) => {
    const toMs = times[index + 1] ?? level.durationMs;
    const readRps = rateAt(level.workloads.read.schedule, fromMs);
    const writeRps = rateAt(level.workloads.write.schedule, fromMs);
    return { fromMs, toMs, readRps, writeRps, totalRps: readRps + writeRps };
  });
}

export function peakRates(level: LevelDefinition): {
  readRps: number;
  writeRps: number;
} {
  return level.workloads.read.schedule.reduce(
    (peak, point) => ({
      readRps: Math.max(peak.readRps, point.rps),
      writeRps: peak.writeRps,
    }),
    {
      readRps: 0,
      writeRps: level.workloads.write.schedule.reduce(
        (max, point) => Math.max(max, point.rps),
        0,
      ),
    },
  );
}

export function expectedArrivalTotals(level: LevelDefinition): {
  reads: number;
  writes: number;
  warmup: number;
} {
  return {
    reads: expectedArrivals(
      level.workloads.read.schedule,
      0,
      level.durationMs,
    ),
    writes: expectedArrivals(
      level.workloads.write.schedule,
      0,
      level.durationMs,
    ),
    warmup:
      expectedArrivals(level.workloads.read.schedule, 0, level.warmupMs) +
      expectedArrivals(level.workloads.write.schedule, 0, level.warmupMs),
  };
}

/**
 * Required DB occupancy for a fixed cache hit ratio. This is an illustrative
 * bounds calculation, not a hit-ratio or queue forecast.
 */
export function dbSlotsNeeded(
  level: LevelDefinition,
  hitRatio: number,
): number {
  const peak = peakRates(level);
  const readMissRps = peak.readRps * (1 - hitRatio);
  return (
    (readMissRps * level.timing.dbReadMs) / 1000 +
    (peak.writeRps * level.timing.dbWriteMs) / 1000
  );
}

export const DB_SIZE_ROWS: readonly NodeKind[] = [
  'appServer',
  'database',
  'cache',
];

const SIZES: readonly NodeSize[] = ['small', 'medium', 'large'];

export function sizeCell(kind: NodeKind, size: NodeSize): string {
  const spec = getSizeSpec(kind, size);
  if (spec.capacity === null) {
    return '—';
  }
  if (kind === 'cache') {
    return `${spec.capacity} entries · ${formatBytes(spec.capacity * CACHE_ENTRY_KIB)} · ${formatMoney(spec.priceMicroUsdPerHour / 1_000_000)}/h`;
  }
  return `${spec.capacity} slots · ${formatMoney(spec.priceMicroUsdPerHour / 1_000_000)}/h`;
}

export function sizeRows(kind: NodeKind): string[] {
  return SIZES.map((size) => sizeCell(kind, size));
}

export function dbSlotBounds(level: LevelDefinition): {
  cold: number;
  illustrative: number;
} {
  return {
    cold: dbSlotsNeeded(level, 0),
    illustrative: dbSlotsNeeded(level, 0.9),
  };
}

export function peakLabel(level: LevelDefinition): string {
  const peak = peakRates(level);
  return `${formatDecimal(peak.readRps, 0)} reads/s · ${formatDecimal(peak.writeRps, 0)} writes/s`;
}
