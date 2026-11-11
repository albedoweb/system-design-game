/**
 * Image Atlas executable work model (v1).
 *
 * Every coefficient below is a disclosed teaching assumption with explicit
 * units, not a vendor benchmark. The frozen contracts in `contracts.ts` define
 * *what* must happen (dataset, routes, prices, scenarios, guarantees); this
 * module defines *how much real work* each operation costs inside the shared
 * resource kernel. Nothing here reads the graph, wall-clock time or DOM.
 *
 * Units:
 * - CPU work is core-milliseconds. A task holds `cpuUnits` cores for its
 *   service duration; one request operation never claims more than one core.
 * - IO work is a byte volume plus an IO-operation count. The model converts
 *   both into a service time using the instance's per-lane share of the
 *   declared disk bandwidth (500 MB/s / 4 lanes = 125 MB/s per lane) and IOPS
 *   (20 000 / 4 lanes = 5 000 ops/s per lane).
 * - Network work is a byte volume. Every flow owns one 1 Gbit/s lane on each
 *   physical resource on its explicit path; lanes are registered in the
 *   resource kernel and shared by all flows using the same NIC/link/population
 *   aggregate. Serialization is `bytes * 8 / 1e9` seconds.
 * - Memory is bytes held by buffers, queues and resident pages.
 *
 * Deliberate approximations (also exposed in `public/help/image-atlas.md`):
 * - Transport is a conservative fixed-quantum reservation, not TCP or ideal
 *   fair sharing. One flow gets one 1 Gbit/s lane per hop; 100 flows sharing a
 *   100 Gbit/s link can each reach 1 Gbit/s.
 * - Streaming proxy hops overlap: one transfer reserves every physical hop at
 *   once and pays one serialization of the payload. Buffered proxy hops are
 *   store-and-forward and pay one serialization per hop plus a full payload
 *   buffer.
 * - A search fan-out fetches ten thumbnails concurrently on the server side
 *   but shares one end-user access stage: the ten children are serialized only
 *   on the 1 Gbit/s end-user link, exactly as the frozen contract requires.
 * - Metadata search is a bounded index-page work model, not a database
 *   implementation: a lookup reads a bounded index page plus the returned
 *   records. Index bytes still cost storage, and index amplification still
 *   costs write CPU/IO/network.
 */

/** Write quorum for local durable copies: a strict majority, never all copies. */
export function metadataWriteQuorum(replicas: number): number {
  return Math.floor(replicas / 2) + 1;
}

/**
 * Read quorum that intersects every write quorum: R = N - W + 1. For N=3 this
 * is 2, so losing one physical instance still allows reads and writes; N=2
 * needs both copies for a write and therefore cannot survive one instance loss.
 */
export function metadataReadQuorum(replicas: number): number {
  return replicas - metadataWriteQuorum(replicas) + 1;
}

export interface ImageWorkModel {
  readonly version: string;
  readonly controlRequestBytes: number;
  readonly metadataRecordBytes: number;
  readonly io: {
    /** Independent IO lanes per physical instance (kernel units). */
    readonly lanesPerInstance: number;
    /** Declared disk throughput and IOPS from the frozen catalog. */
    readonly diskMbpsPerInstance: number;
    readonly diskIopsPerInstance: number;
    readonly pageBytes: number;
  };
  readonly app: {
    readonly parseCpuMs: number;
    readonly parseIoOps: number;
    readonly uploadCpuMs: number;
    readonly searchCpuMs: number;
    readonly detailCpuMs: number;
    readonly responseIoOps: number;
    readonly bufferedCopyCpuMsPerMb: number;
  };
  readonly metadata: {
    /** Bounded recent-entry user index page plus ten 8 KB result records. */
    readonly userIndexCpuMs: number;
    readonly userIndexPageOps: number;
    readonly userIndexResultRecords: number;
    /** Bounded posting page plus ten 8 KB result records. */
    readonly tagIndexCpuMs: number;
    readonly tagIndexPageOps: number;
    readonly tagIndexPostingsScanned: number;
    readonly tagIndexResultRecords: number;
    /** Point lookup used for detail and origin fallback. */
    readonly pointLookupCpuMs: number;
    readonly pointLookupPageOps: number;
    readonly pointLookupResultRecords: number;
    /** Durable local copy write: record bytes + declared index amplification. */
    readonly durableWriteCpuMsPerCopy: number;
    readonly durableWriteIoOpsPerCopy: number;
    /** Read repair: a copy that missed a record re-reads it once. */
    readonly readRepairIoOps: number;
    readonly residentLookupCpuMs: number;
    readonly residentLookupIoOps: number;
  };
  readonly cache: {
    readonly lookupCpuMs: number;
    readonly lookupIoOps: number;
    readonly fillCpuMsPerMb: number;
    readonly fillIoOps: number;
  };
  readonly provider: {
    /** Durable service after the incoming payload; admission is rate-only. */
    readonly durableServiceMs: number;
    /** Provider endpoints are fixed and their RPC quotas are admission gates. */
    readonly readRpcPerSec: number;
    readonly writeRpcPerSec: number;
  };
  readonly transport: {
    /** One flow lane carries 1 Gbit/s; shared links expose lanes = Gbit/s. */
    readonly laneGbitPerSec: number;
    /**
     * A relayed stream does not pin a whole CPU core or IO lane for the bytes
     * it forwards: the CPU cost is a small fraction of a core and the cache
     * lookup/fill IO is a fraction of one lane, so concurrent flows share the
     * instance instead of serialising on it.
     */
    readonly relayCpuUnitsPerFlow: number;
    readonly relayIoUnitsPerFlow: number;
    readonly streamingBufferBytesPerHop: number;
    readonly localPropagationMs: number;
    /** Routing failure detection lag from the frozen level contract. */
    readonly failureDetectionMs: number;
  };
  readonly memory: {
    readonly usableGbPerInstance: number;
    readonly baseRssGbPerInstance: number;
  };
  readonly notes: readonly string[];
}

export const IMAGE_WORK_MODEL: ImageWorkModel = Object.freeze({
  version: 'image-atlas-work-v1',
  controlRequestBytes: 1_024,
  metadataRecordBytes: 8_000,
  io: {
    lanesPerInstance: 4,
    diskMbpsPerInstance: 500,
    diskIopsPerInstance: 20_000,
    pageBytes: 4_096,
  },
  app: {
    parseCpuMs: 0.25,
    parseIoOps: 1,
    uploadCpuMs: 0.9,
    searchCpuMs: 0.5,
    detailCpuMs: 0.35,
    responseIoOps: 1,
    bufferedCopyCpuMsPerMb: 0.15,
  },
  metadata: {
    userIndexCpuMs: 0.35,
    userIndexPageOps: 2,
    userIndexResultRecords: 10,
    tagIndexCpuMs: 0.45,
    tagIndexPageOps: 4,
    tagIndexPostingsScanned: 200,
    tagIndexResultRecords: 10,
    pointLookupCpuMs: 0.2,
    pointLookupPageOps: 1,
    pointLookupResultRecords: 1,
    durableWriteCpuMsPerCopy: 0.08,
    durableWriteIoOpsPerCopy: 4,
    readRepairIoOps: 2,
    residentLookupCpuMs: 0.02,
    residentLookupIoOps: 0,
  },
  cache: {
    lookupCpuMs: 0.05,
    lookupIoOps: 1,
    fillCpuMsPerMb: 0.05,
    fillIoOps: 2,
  },
  provider: {
    durableServiceMs: 4,
    readRpcPerSec: 10_000,
    writeRpcPerSec: 2_000,
  },
  transport: {
    laneGbitPerSec: 1,
    relayCpuUnitsPerFlow: 0.05,
    relayIoUnitsPerFlow: 0.25,
    streamingBufferBytesPerHop: 65_536,
    localPropagationMs: 1,
    failureDetectionMs: 250,
  },
  memory: {
    usableGbPerInstance: 22,
    baseRssGbPerInstance: 2,
  },
  notes: [
    'CPU values are core-milliseconds of modelled work, not measured microbenchmarks.',
    'Metadata lookup work is a bounded index-page model; it does not implement a database.',
    'Write quorum is floor(replicas/2)+1 and read quorum is replicas-write+1 over actual copies.',
    'Streaming cargo holds one 64 KB buffer per active hop; buffered cargo holds the payload.',
    'One network lane carries 1 Gbit/s; a 10 Gbit/s instance NIC has 10 lanes and a 100 Gbit/s shared link has 100.',
    'Propagation holds no bandwidth and is added after serialization, never multiplied per hop in streaming mode.',
    'Provider RPC limits are admission rates, not long-held slots: the service-start band and the transfer are separate stages.',
    'Fault detection lag, deadlines and retry backoff are enforced with real events; no arbitrary success probability exists.',
  ],
});

/**
 * Synthetic key bounds. They mirror the frozen workload spec and are kept here
 * so the upload key namespace can be verified without importing the level.
 */
export const IMAGE_LEVEL_HOT_KEYS = 10_000;
export const IMAGE_LEVEL_TAIL_KEYS = 1_000_000;

/** Bytes per GB/TB in the decimal units used by the frozen contract. */
export const IMAGE_BYTES_PER_GB = 1_000_000_000;
export const IMAGE_BYTES_PER_TB = 1_000_000_000_000;

/** Converts IO bytes plus IO operations into lane-held service milliseconds. */
export function ioServiceMs(bytes: number, ops: number): number {
  const lanes = IMAGE_WORK_MODEL.io.lanesPerInstance;
  const mbPerLane = IMAGE_WORK_MODEL.io.diskMbpsPerInstance / lanes;
  const iopsPerLane = IMAGE_WORK_MODEL.io.diskIopsPerInstance / lanes;
  const bytesMs = bytes <= 0 ? 0 : (bytes / 1_000_000 / mbPerLane) * 1_000;
  const opsMs = ops <= 0 ? 0 : (ops / iopsPerLane) * 1_000;
  return Math.max(bytesMs, opsMs);
}

/** Converts a payload size into one-lane serialization milliseconds. */
export function serializationMs(bytes: number): number {
  const bitsPerMs = IMAGE_WORK_MODEL.transport.laneGbitPerSec * 1_000_000;
  return bytes <= 0 ? 0 : Number((bytes * 8) / bitsPerMs);
}

/**
 * A task holds CPU, IO and network lanes for the same stage; the stage lasts
 * as long as its slowest dependency. Dependencies never release early.
 */
export function stageDurationMs(parts: {
  readonly cpuMs: number;
  readonly ioBytes?: number;
  readonly ioOps?: number;
  readonly netBytes?: number;
}): number {
  const cpu = Math.max(0, parts.cpuMs);
  const io = ioServiceMs(parts.ioBytes ?? 0, parts.ioOps ?? 0);
  const net = serializationMs(parts.netBytes ?? 0);
  return Math.max(cpu, io, net);
}

/**
 * Key namespace for immutable uploads created during a replay. It starts after
 * every synthetic hot and long-tail key, so a new object can never alias an old
 * cached image or a synthetic search result.
 */
export function uploadKeyForOrdinal(ordinal: number): number {
  return (
    IMAGE_LEVEL_HOT_KEYS + IMAGE_LEVEL_TAIL_KEYS + 1 + Math.max(0, Math.trunc(ordinal))
  );
}

/**
 * Publication bound for the gate. The provider's remote-visibility window is a
 * floor; a *previously observed* durable apply lag is never erased by the later
 * catch-up (a record published after the deadline stays a violation).
 */
export function publicationLagBound(
  observedApplyLagMs: number,
  currentBacklogLagMs: number,
  providerVisibilityMs: number,
): number {
  return Math.max(providerVisibilityMs, observedApplyLagMs, currentBacklogLagMs);
}

/** Nearest-rank percentile over an already ascending array. */
export function nearestRank(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.ceil(fraction * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index] ?? 0;
}

/** Ascending copy used for percentile reporting; callers keep sample arrays. */
export function ascending(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right);
}

/** Fixed-bucket latency histogram for bounded per-node queue statistics. */
export class MillisecondHistogram {
  private readonly counts: number[];
  private total = 0;
  private sum = 0;
  private max = 0;

  constructor(
    private readonly bucketMs = 1,
    private readonly bucketCount = 10_000,
  ) {
    this.counts = new Array<number>(bucketCount).fill(0);
  }

  record(valueMs: number): void {
    const safe = Number.isFinite(valueMs) && valueMs > 0 ? valueMs : 0;
    this.total += 1;
    this.sum += safe;
    if (safe > this.max) {
      this.max = safe;
    }
    const bucket = Math.min(
      this.bucketCount - 1,
      Math.floor(safe / this.bucketMs),
    );
    this.counts[bucket] = (this.counts[bucket] ?? 0) + 1;
  }

  get count(): number {
    return this.total;
  }

  percentile(fraction: number): number {
    if (this.total === 0) {
      return 0;
    }
    const target = Math.max(1, Math.ceil(fraction * this.total));
    let seen = 0;
    for (let index = 0; index < this.counts.length; index += 1) {
      seen += this.counts[index] ?? 0;
      if (seen >= target) {
        return Math.min(this.max, (index + 1) * this.bucketMs);
      }
    }
    return this.max;
  }

  get maximum(): number {
    return this.max;
  }
}
