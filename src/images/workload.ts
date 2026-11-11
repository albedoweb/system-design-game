/**
 * Graph-independent Image Atlas request trace.
 *
 * The trace is built from the seed, the scenario name and the frozen level
 * workload only. It never reads the graph, node ids, labels, positions,
 * insertion order or route choices, so two graphs compared on the same seed
 * receive exactly the same offered business requests. Warm-up offers arrive
 * before `0`; measured offers arrive in `[0, measuredMs)`; nothing is offered
 * during request drain or the consistency postlude.
 *
 * Keys are bounded representative identifiers: 10 000 hot keys and
 * 1 000 000 long-tail keys. The long tail maps onto the full mature dataset
 * for documented work accounting; it is not a smaller provisioned dataset.
 */

import { IMAGE_LEVEL } from './level';
import {
  IMAGE_REGIONS,
  IMAGE_REQUIRED_SCENARIOS,
  type ImageRegion,
  type ImageScenarioName,
  type ImageScenarioSpec,
} from './contracts';
import { createImageStream, imageHazard, pickBandIndex, type ImageRng } from './rng';
import { IMAGE_CATALOG } from './catalog';

export const IMAGE_HOT_KEYS = IMAGE_LEVEL.workload.hotKeys;
export const IMAGE_LONG_TAIL_KEYS = IMAGE_LEVEL.workload.longTailRepresentativeKeys;
/** One in a hundred detail requests is a recent-read probe candidate. */
export const IMAGE_PROBE_EVERY = 100;
/** Probe candidates target an upload offered this many uploads earlier. */
export const IMAGE_PROBE_MIN_UPLOADS_BACK = 20;
export const IMAGE_PROBE_MAX_UPLOADS_BACK = 2_000;

export interface ImageTraceStreams {
  readonly times: Float64Array;
  readonly region: Uint8Array;
}

export interface ImageUploadTrace extends ImageTraceStreams {
  /** Provider write service-start band index per upload. */
  readonly bands: Uint8Array;
}

export interface ImageSearchTrace extends ImageTraceStreams {
  /** Ten result keys per search, flattened. */
  readonly keys: Uint32Array;
  /** 0 = search by user, 1 = search by one tag. */
  readonly kind: Uint8Array;
  /** Ten provider read service-start band indices per search. */
  readonly bands: Uint8Array;
}

export interface ImageDetailTrace extends ImageTraceStreams {
  readonly key: Uint32Array;
  /**
   * Recent-read probe target upload ordinal, or -1. Frozen workload: one in a
   * hundred *business* detail requests is a recent read of an upload offered
   * 20..2000 uploads earlier. It stays in the availability and latency
   * denominators.
   */
  readonly probeTarget: Int32Array;
  readonly bands: Uint8Array;
}

export interface ImageTrace {
  readonly seed: number;
  readonly scenario: ImageScenarioName;
  readonly demandMultiplier: number;
  readonly warmupMs: number;
  readonly measuredMs: number;
  readonly drainMs: number;
  /** Simulation time of measured second 0 (equal to warmupMs). */
  readonly measuredFromMs: number;
  readonly traceStartMs: number;
  readonly uploads: ImageUploadTrace;
  readonly searches: ImageSearchTrace;
  readonly details: ImageDetailTrace;
  readonly counts: {
    readonly upload: number;
    readonly search: number;
    readonly detail: number;
    readonly measuredUpload: number;
    readonly measuredSearch: number;
    readonly measuredDetail: number;
    readonly probes: number;
  };
}

export interface BuildTraceOptions {
  /**
   * Test-only override used to bound focused unit tests. It is not reachable
   * from `evaluateImages`, whose workload comes from the frozen level.
   */
  readonly measuredMs?: number;
  readonly warmupMs?: number;
}

export function imageScenarioSpec(name: ImageScenarioName): ImageScenarioSpec {
  const spec = IMAGE_LEVEL.qualification.scenarios.find(
    (scenario) => scenario.name === name,
  );
  if (!spec) {
    throw new RangeError(`Unknown Image Atlas scenario: ${name}`);
  }
  return spec;
}

export function imageScenarioNames(): readonly ImageScenarioName[] {
  return [...IMAGE_REQUIRED_SCENARIOS];
}

function regionIndex(region: ImageRegion): number {
  const index = IMAGE_REGIONS.indexOf(region);
  return index < 0 ? 0 : index;
}

interface RegionArrival {
  readonly timeMs: number;
  readonly region: number;
}

/** Merges three region-sorted arrival lists into one sorted listing. */
function mergeRegions(parts: readonly RegionArrival[][], mark?: (index: number) => void): {
  times: Float64Array;
  region: Uint8Array;
} {
  const cursors = parts.map(() => 0);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const times = new Float64Array(total);
  const region = new Uint8Array(total);
  let out = 0;
  for (;;) {
    let bestPart = -1;
    let bestTime = Number.POSITIVE_INFINITY;
    for (let part = 0; part < parts.length; part += 1) {
      const cursor = cursors[part] ?? 0;
      const item = parts[part]?.[cursor];
      if (item !== undefined && item.timeMs < bestTime) {
        bestTime = item.timeMs;
        bestPart = part;
      }
    }
    if (bestPart < 0) {
      break;
    }
    const cursor = cursors[bestPart] ?? 0;
    const item = parts[bestPart]?.[cursor];
    if (item === undefined) {
      break;
    }
    times[out] = item.timeMs;
    region[out] = item.region;
    if (mark) {
      mark(out);
    }
    out += 1;
    cursors[bestPart] = cursor + 1;
  }
  return { times, region };
}

function arrivals(
  seed: number,
  stream: string,
  ratePerMs: number,
  fromMs: number,
  toMs: number,
  region: number,
): RegionArrival[] {
  const rng = createImageStream(seed, stream);
  const list: RegionArrival[] = [];
  if (!(ratePerMs > 0)) {
    return list;
  }
  let timeMs = fromMs;
  for (;;) {
    timeMs += imageHazard(rng) / ratePerMs;
    if (timeMs >= toMs) {
      break;
    }
    list.push({ timeMs, region });
  }
  return list;
}

/** Draws one representative read key: 80% hot set, 20% long tail. */
function readKey(rng: ImageRng): number {
  if (rng.nextUnit() < IMAGE_LEVEL.workload.hotKeyShare) {
    return rng.nextBelow(IMAGE_HOT_KEYS);
  }
  return IMAGE_HOT_KEYS + rng.nextBelow(IMAGE_LONG_TAIL_KEYS);
}

function countMeasured(
  times: Float64Array,
  fromMs: number,
  measuredMs: number,
): number {
  let count = 0;
  for (let index = 0; index < times.length; index += 1) {
    const time = times[index] ?? 0;
    if (time >= fromMs && time < fromMs + measuredMs) {
      count += 1;
    }
  }
  return count;
}

/** Deterministic provider latency bands from the frozen catalog. */
const READ_BAND_MS = IMAGE_CATALOG.provider.readStartLatencyBands.map((band) => band.ms);
const READ_BAND_P = IMAGE_CATALOG.provider.readStartLatencyBands.map(
  (band) => band.probability,
);
const WRITE_BAND_MS = IMAGE_CATALOG.provider.writeStartLatencyBands.map((band) => band.ms);
const WRITE_BAND_P = IMAGE_CATALOG.provider.writeStartLatencyBands.map(
  (band) => band.probability,
);

export function providerReadBandMs(index: number): number {
  return READ_BAND_MS[index] ?? (READ_BAND_MS[0] ?? 0);
}

export function providerWriteBandMs(index: number): number {
  return WRITE_BAND_MS[index] ?? (WRITE_BAND_MS[0] ?? 0);
}

/**
 * Builds the frozen trace for one seed and scenario. The same arguments always
 * produce the same offered requests, keys, bands and probe candidates.
 */
export function buildImageTrace(
  seed: number,
  scenario: ImageScenarioName,
  options: BuildTraceOptions = {},
): ImageTrace {
  const spec = imageScenarioSpec(scenario);
  const multiplier = spec.demandMultiplier;
  const warmupMs = options.warmupMs ?? IMAGE_LEVEL.qualification.warmupMs;
  const measuredMs = options.measuredMs ?? IMAGE_LEVEL.qualification.measuredMs;
  const drainMs = IMAGE_LEVEL.qualification.drainMs;
  const measuredFromMs = warmupMs;
  const from = 0;
  const to = warmupMs + measuredMs;
  const rates = IMAGE_LEVEL.workload.averageRatesPerSecond;
  const shares = IMAGE_LEVEL.regions.map((region) => region.demandShare);

  const uploadParts: RegionArrival[][] = [];
  const searchParts: RegionArrival[][] = [];
  const detailParts: RegionArrival[][] = [];
  for (const region of IMAGE_REGIONS) {
    const index = regionIndex(region);
    const share = shares[index] ?? 0;
    uploadParts.push(
      arrivals(
        seed,
        `upload-arrivals-${scenario}-${region}`,
        (rates.upload * multiplier * share) / 1000,
        from,
        to,
        index,
      ),
    );
    searchParts.push(
      arrivals(
        seed,
        `search-arrivals-${scenario}-${region}`,
        (rates.search * multiplier * share) / 1000,
        from,
        to,
        index,
      ),
    );
    detailParts.push(
      arrivals(
        seed,
        `detail-arrivals-${scenario}-${region}`,
        (rates.detail * multiplier * share) / 1000,
        from,
        to,
        index,
      ),
    );
  }

  const uploadStream = mergeRegions(uploadParts);
  const uploadBands = new Uint8Array(uploadStream.times.length);
  const writeRng = createImageStream(seed, `upload-bands-${scenario}`);
  for (let index = 0; index < uploadBands.length; index += 1) {
    uploadBands[index] = pickBandIndex(writeRng, WRITE_BAND_P);
  }

  const searchStream = mergeRegions(searchParts);
  const searchCount = searchStream.times.length;
  const searchKeys = new Uint32Array(searchCount * IMAGE_LEVEL.dataset.searchResultsPerSearch);
  const searchKind = new Uint8Array(searchCount);
  const searchBands = new Uint8Array(searchKeys.length);
  const searchRng = createImageStream(seed, `search-content-${scenario}`);
  const searchBandRng = createImageStream(seed, `search-bands-${scenario}`);
  for (let index = 0; index < searchCount; index += 1) {
    searchKind[index] = searchRng.nextBelow(2);
    for (let child = 0; child < IMAGE_LEVEL.dataset.searchResultsPerSearch; child += 1) {
      searchKeys[index * IMAGE_LEVEL.dataset.searchResultsPerSearch + child] = readKey(searchRng);
      searchBands[index * IMAGE_LEVEL.dataset.searchResultsPerSearch + child] =
        pickBandIndex(searchBandRng, READ_BAND_P);
    }
  }

  const detailStream = mergeRegions(detailParts);
  const detailCount = detailStream.times.length;
  const detailKeys = new Uint32Array(detailCount);
  const detailBands = new Uint8Array(detailCount);
  const detailRng = createImageStream(seed, `detail-content-${scenario}`);
  const detailBandRng = createImageStream(seed, `detail-bands-${scenario}`);
  for (let index = 0; index < detailCount; index += 1) {
    detailKeys[index] = readKey(detailRng);
    detailBands[index] = pickBandIndex(detailBandRng, READ_BAND_P);
  }

  // Frozen recent-read workload: every hundredth business detail request is a
  // probe of an upload offered a bounded number of uploads earlier. It remains
  // a scored business request; the trace only chooses its target.
  const detailProbe = new Int32Array(detailCount).fill(-1);
  const probeRng = createImageStream(seed, `probe-targets-${scenario}`);
  let probes = 0;
  let uploadCursor = 0;
  for (let index = 0; index < detailCount; index += 1) {
    if (index % IMAGE_PROBE_EVERY !== 0) {
      continue;
    }
    const timeMs = detailStream.times[index] ?? 0;
    while ((uploadStream.times[uploadCursor] ?? Number.POSITIVE_INFINITY) < timeMs) {
      uploadCursor += 1;
    }
    const lag =
      IMAGE_PROBE_MIN_UPLOADS_BACK +
      probeRng.nextBelow(
        IMAGE_PROBE_MAX_UPLOADS_BACK - IMAGE_PROBE_MIN_UPLOADS_BACK + 1,
      );
    const target = uploadCursor - lag;
    if (target >= 0) {
      detailProbe[index] = target;
      probes += 1;
    }
  }

  return {
    seed,
    scenario,
    demandMultiplier: multiplier,
    warmupMs,
    measuredMs,
    drainMs,
    measuredFromMs,
    traceStartMs: from,
    uploads: { ...uploadStream, bands: uploadBands },
    searches: {
      ...searchStream,
      keys: searchKeys,
      kind: searchKind,
      bands: searchBands,
    },
    details: {
      ...detailStream,
      key: detailKeys,
      probeTarget: detailProbe,
      bands: detailBands,
    },
    counts: {
      upload: uploadStream.times.length,
      search: searchCount,
      detail: detailCount,
      measuredUpload: countMeasured(uploadStream.times, measuredFromMs, measuredMs),
      measuredSearch: countMeasured(searchStream.times, measuredFromMs, measuredMs),
      measuredDetail: countMeasured(detailStream.times, measuredFromMs, measuredMs),
      probes,
    },
  };
}
