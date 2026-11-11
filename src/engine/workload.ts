import type { LevelDefinition, SchedulePoint } from '../domain/level';
import { MAX_ARRIVALS, MAX_SEED } from '../domain/level';
import { SimulationInputError, SimulationLimitError } from './errors';
import { createStreamRng, exponentialHazard, type Xorshift32 } from './rng';

/**
 * Materialized offered traffic. It depends only on the level definition and
 * the seed, so every architecture and every advance chunk sees the same
 * arrivals, keys and logical ids.
 */

export type TrafficClass = 'read' | 'write';

export interface OfferedRequest {
  /** Stable logical id: `<class>-<arrivalIndex>`. */
  logicalId: string;
  trafficClass: TrafficClass;
  /** Per-class arrival index, starting at 0 for the warmup phase. */
  index: number;
  /** Key rank inside the level key space. */
  key: number;
  /** Evaluation-relative arrival time; negative during warmup. */
  arrivalMs: number;
  /** False for warmup traffic: generated, but never scored. */
  scored: boolean;
}

export interface OfferedTrace {
  seed: number;
  requests: OfferedRequest[];
}

interface RateSegment {
  startMs: number;
  endMs: number;
  rps: number;
}

/**
 * Build rate segments over `[fromMs, toMs)`. Warmup (negative time) uses the
 * first schedule rate; evaluation time switches exactly at schedule points.
 */
function rateSegments(
  schedule: readonly SchedulePoint[],
  fromMs: number,
  toMs: number,
): RateSegment[] {
  const segments: RateSegment[] = [];
  let start = fromMs;
  let rps = schedule[0]?.rps ?? 0;

  for (const point of schedule) {
    if (point.atMs <= fromMs) {
      rps = point.rps;
      continue;
    }
    if (point.atMs >= toMs) {
      break;
    }
    if (point.atMs > start) {
      segments.push({ startMs: start, endMs: point.atMs, rps });
    }
    start = point.atMs;
    rps = point.rps;
  }
  if (start < toMs) {
    segments.push({ startMs: start, endMs: toMs, rps });
  }
  return segments;
}

/**
 * Poisson arrival times from a piecewise-constant rate. Hazard `E` is an
 * exponential sample carried across rate boundaries and zero-rate gaps; a new
 * `E` is drawn after every arrival. See CONTRACTS.md for the worked example.
 */
export function arrivalTimesFromHazards(
  schedule: readonly SchedulePoint[],
  fromMs: number,
  toMs: number,
  nextHazard: () => number,
  onArrival: () => void = () => undefined,
): number[] {
  const arrivals: number[] = [];
  if (toMs <= fromMs) {
    return arrivals;
  }
  let hazard = nextHazard();
  let cursor = fromMs;

  for (const segment of rateSegments(schedule, fromMs, toMs)) {
    cursor = Math.max(cursor, segment.startMs);
    while (cursor < segment.endMs && cursor < toMs) {
      if (segment.rps <= 0) {
        cursor = segment.endMs;
        continue;
      }
      const neededMs = (hazard * 1000) / segment.rps;
      const candidate = cursor + neededMs;
      if (candidate < segment.endMs && candidate < toMs) {
        arrivals.push(candidate);
        onArrival();
        cursor = candidate;
        hazard = nextHazard();
      } else {
        const consumedMs = Math.min(segment.endMs, toMs) - cursor;
        hazard = Math.max(0, hazard - (segment.rps * consumedMs) / 1000);
        cursor = Math.min(segment.endMs, toMs);
      }
    }
  }
  return arrivals;
}

function generateArrivalTimes(
  schedule: readonly SchedulePoint[],
  fromMs: number,
  toMs: number,
  rng: Xorshift32,
  onArrival: () => void,
): number[] {
  return arrivalTimesFromHazards(
    schedule,
    fromMs,
    toMs,
    () => exponentialHazard(rng),
    onArrival,
  );
}

function readKey(level: LevelDefinition, rng: Xorshift32): number {
  const { keySpace, hotCount, hotProbability } = level.workloads.read;
  const unit = rng.nextUnit();
  if (hotCount >= keySpace || hotProbability <= 0) {
    return Math.min(keySpace - 1, Math.floor(unit * keySpace));
  }
  if (hotProbability >= 1 || unit < hotProbability) {
    return Math.min(hotCount - 1, Math.floor((unit / hotProbability) * hotCount));
  }
  const coldShare = keySpace - hotCount;
  const coldUnit = (unit - hotProbability) / (1 - hotProbability);
  return hotCount + Math.min(coldShare - 1, Math.floor(coldUnit * coldShare));
}

function writeKey(level: LevelDefinition, rng: Xorshift32): number {
  const { keySpace } = level.workloads.write;
  return Math.min(keySpace - 1, Math.floor(rng.nextUnit() * keySpace));
}

/** Generate the complete offered trace (warmup plus evaluation). */
export function generateOfferedTrace(
  level: LevelDefinition,
  seed: number,
): OfferedTrace {
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new SimulationInputError(
      `Seed must be an integer in 0..${MAX_SEED}, received ${seed}`,
    );
  }

  const fromMs = -level.warmupMs;
  const toMs = level.durationMs;
  let total = 0;
  const countArrival = () => {
    total += 1;
    if (total > MAX_ARRIVALS) {
      throw new SimulationLimitError('arrivals', total, MAX_ARRIVALS);
    }
  };

  const readArrivals = generateArrivalTimes(
    level.workloads.read.schedule,
    fromMs,
    toMs,
    createStreamRng(seed, 'read', 'arrivals'),
    countArrival,
  );
  const writeArrivals = generateArrivalTimes(
    level.workloads.write.schedule,
    fromMs,
    toMs,
    createStreamRng(seed, 'write', 'arrivals'),
    countArrival,
  );

  const readKeyRng = createStreamRng(seed, 'read', 'keys');
  const writeKeyRng = createStreamRng(seed, 'write', 'keys');

  const requests: OfferedRequest[] = [];
  for (let index = 0; index < readArrivals.length; index += 1) {
    const arrivalMs = readArrivals[index];
    if (arrivalMs === undefined) {
      continue;
    }
    requests.push({
      logicalId: `read-${index}`,
      trafficClass: 'read',
      index,
      key: readKey(level, readKeyRng),
      arrivalMs,
      scored: arrivalMs >= 0,
    });
  }
  for (let index = 0; index < writeArrivals.length; index += 1) {
    const arrivalMs = writeArrivals[index];
    if (arrivalMs === undefined) {
      continue;
    }
    requests.push({
      logicalId: `write-${index}`,
      trafficClass: 'write',
      index,
      key: writeKey(level, writeKeyRng),
      arrivalMs,
      scored: arrivalMs >= 0,
    });
  }

  // Stable logical order: time, then read before write, then arrival index.
  requests.sort((a, b) => {
    if (a.arrivalMs !== b.arrivalMs) {
      return a.arrivalMs - b.arrivalMs;
    }
    if (a.trafficClass !== b.trafficClass) {
      return a.trafficClass === 'read' ? -1 : 1;
    }
    return a.index - b.index;
  });

  return { seed, requests };
}

/**
 * Validate a caller-supplied trace (test hooks and future fixtures) with the
 * same bounds as the generator.
 */
export function validateOfferedTrace(
  trace: OfferedTrace,
  level: LevelDefinition,
): void {
  if (!Number.isInteger(trace.seed) || trace.seed < 0 || trace.seed > MAX_SEED) {
    throw new SimulationInputError(`Invalid trace seed: ${trace.seed}`);
  }
  if (trace.requests.length > MAX_ARRIVALS) {
    throw new SimulationLimitError(
      'arrivals',
      trace.requests.length,
      MAX_ARRIVALS,
    );
  }

  const ids = new Set<string>();
  const indexes = { read: new Set<number>(), write: new Set<number>() };
  for (const request of trace.requests) {
    if (!Number.isFinite(request.arrivalMs)) {
      throw new SimulationInputError(
        `Non-finite arrival time for ${request.logicalId}`,
      );
    }
    if (request.arrivalMs < -level.warmupMs || request.arrivalMs >= level.durationMs) {
      throw new SimulationInputError(
        `Arrival ${request.logicalId} is outside the generation window: ${request.arrivalMs} ms`,
      );
    }
    if (!Number.isInteger(request.key) || request.key < 0) {
      throw new SimulationInputError(`Invalid key for ${request.logicalId}`);
    }
    const keySpace =
      request.trafficClass === 'read'
        ? level.workloads.read.keySpace
        : level.workloads.write.keySpace;
    if (request.key >= keySpace) {
      throw new SimulationInputError(
        `Key ${request.key} is outside key space ${keySpace} for ${request.logicalId}`,
      );
    }
    if (!Number.isInteger(request.index) || request.index < 0) {
      throw new SimulationInputError(
        `Invalid index for ${request.logicalId}`,
      );
    }
    if (ids.has(request.logicalId)) {
      throw new SimulationInputError(
        `Duplicate logical id: ${request.logicalId}`,
      );
    }
    if (indexes[request.trafficClass].has(request.index)) {
      throw new SimulationInputError(
        `Duplicate index ${request.index} in class ${request.trafficClass}`,
      );
    }
    ids.add(request.logicalId);
    indexes[request.trafficClass].add(request.index);
  }
}
