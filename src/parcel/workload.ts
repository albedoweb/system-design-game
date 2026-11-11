import type { ParcelBusinessOperation, ParcelHorizonYears } from './contracts';
import { PARCEL_LEVEL } from './level';
import { createParcelStream, parcelHazard } from './rng';

/**
 * Frozen, graph-independent request trace. The arrays hold every offered
 * request for one seed. The same trace is used for every horizon; only the
 * requested historical age changes.
 */
export interface ParcelTrace {
  readonly seed: number;
  readonly statusTimes: Float64Array;
  readonly statusKeys: Uint32Array;
  readonly historyTimes: Float64Array;
  readonly historyKeys: Uint32Array;
  /** 1 = four-year-old cohort (year 5); every fifth history request. */
  readonly historyOld: Uint8Array;
  readonly ingestTimes: Float64Array;
  readonly ingestKeys: Uint32Array;
  readonly reports: readonly {
    readonly timeMs: number;
    readonly warehouseId: number;
  }[];
  readonly counts: {
    readonly status: number;
    readonly history: number;
    readonly ingest: number;
    readonly report: number;
    readonly oldHistory: number;
  };
}

function arrivalsForOperation(
  operation: ParcelBusinessOperation,
  seed: number,
): { times: Float64Array; keys: Uint32Array; old: Uint8Array } {
  const rng = createParcelStream(seed, `${operation}-arrivals`);
  const keyRng = createParcelStream(seed, `${operation}-keys`);
  const times: number[] = [];
  const keys: number[] = [];
  const old: number[] = [];
  const peak = PARCEL_LEVEL.workload.peakRatesPerSecond[operation];
  let requestIndex = 0;

  for (const phase of PARCEL_LEVEL.workload.phaseMultiplier) {
    const ratePerMs = (peak * phase.multiplier) / 1000;
    if (ratePerMs <= 0) {
      continue;
    }
    let timeMs = phase.fromMs;
    for (;;) {
      const hazard = parcelHazard(rng);
      timeMs += hazard / ratePerMs;
      if (timeMs >= phase.toMs) {
        break;
      }
      times.push(timeMs);
      keys.push(keyRng.nextUint32() % PARCEL_LEVEL.workload.sampledParcelKeys);
      old.push(
        operation === 'history' &&
          requestIndex % PARCEL_LEVEL.workload.oldHistoryEveryNth === 0
          ? 1
          : 0,
      );
      requestIndex += 1;
    }
  }

  return {
    times: Float64Array.from(times),
    keys: Uint32Array.from(keys),
    old: Uint8Array.from(old),
  };
}

/** Generate the frozen trace for a seed. Demand never depends on the graph. */
export function generateParcelTrace(seed: number): ParcelTrace {
  const status = arrivalsForOperation('status', seed);
  const history = arrivalsForOperation('history', seed);
  const ingest = arrivalsForOperation('ingest', seed);
  const reports = PARCEL_LEVEL.workload.reportScheduleMs.map((timeMs, index) => ({
    timeMs,
    warehouseId:
      PARCEL_LEVEL.workload.reportWarehouseIds[index] ?? index,
  }));
  return {
    seed,
    statusTimes: status.times,
    statusKeys: status.keys,
    historyTimes: history.times,
    historyKeys: history.keys,
    historyOld: history.old,
    ingestTimes: ingest.times,
    ingestKeys: ingest.keys,
    reports,
    counts: {
      status: status.times.length,
      history: history.times.length,
      ingest: ingest.times.length,
      report: reports.length,
      oldHistory: history.old.reduce((sum, value) => sum + value, 0),
    },
  };
}

/**
 * Requested historical age in days. Year 5 uses the explicit four-year-old
 * cohort; year 1 uses the oldest age that a one-year-old service can retain.
 */
export function historyAgeDays(
  old: boolean,
  horizonYears: ParcelHorizonYears,
  key: number,
): number {
  if (!old) {
    const [min, max] = PARCEL_LEVEL.workload.recentHistoryAgeDays;
    return min + (key % (max - min + 1));
  }
  return horizonYears === 5
    ? PARCEL_LEVEL.workload.oldHistoryAgeDaysAtYear5
    : PARCEL_LEVEL.workload.oldHistoryAgeDaysAtYear1;
}

/** Reports use warehouses 0..5 exactly; no hidden skew. */
export function reportWarehouseIds(): readonly number[] {
  return PARCEL_LEVEL.workload.reportWarehouseIds;
}
