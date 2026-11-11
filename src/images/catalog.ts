import { z } from 'zod';
import {
  IMAGE_PRICING_VERSION,
  IMAGE_SCHEMA_VERSION,
  imageCatalogSchema,
  imageIssuesFromZod,
  type ImageCatalog,
  type ImageParseResult,
} from './contracts';

/**
 * Conditional in-game catalog for Image Atlas. These are teaching values, not
 * vendor quotes. The fixed provider price is billed as a separate base; every
 * player-provisioned copy is charged once through its physical instance.
 */
const catalog: ImageCatalog = {
  schemaVersion: IMAGE_SCHEMA_VERSION,
  pricingVersion: IMAGE_PRICING_VERSION,
  currency: 'USD',
  priceNote:
    'Conditional in-game prices. They are calibrated for the teaching model, not real vendor quotes. Compute includes 8 cores, 24 GB RAM and 2 TB disk per instance; RAM is never billed a second time.',
  instance: {
    cpuCores: 8,
    memoryGb: 24,
    usableMemoryGb: 22,
    baseRssGb: 2,
    networkGbitPerSec: 10,
    diskTbOptions: [2, 8, 16],
    diskMbps: 500,
    diskIops: 20_000,
    hourlyUsd: 0.2,
  },
  prices: {
    currency: 'USD',
    computeUsdPerInstanceHour: 0.2,
    billingHoursPerMonth: 730,
    includedDiskTb: 2,
    extraDiskUsdPerTbMonth: 6,
    providerOriginalsUsdPerTbMonth: 6,
    providerRetrievalUsdPerGb: 0.002,
    clientEgressUsdPerGb: 0.006,
    crossRegionUsdPerGb: 0.01,
    apiReadUsd: 0.000_000_4,
    apiWriteUsd: 0.000_005,
  },
  provider: {
    id: 'global-blob',
    endpointBandwidthGbitPerSec: 100,
    readRpcPerSec: 10_000,
    writeRpcPerSec: 2_000,
    readStartLatencyBands: [
      { ms: 35, probability: 0.9 },
      { ms: 70, probability: 0.09 },
      { ms: 100, probability: 0.009 },
      { ms: 120, probability: 0.001 },
    ],
    writeStartLatencyBands: [
      { ms: 80, probability: 0.9 },
      { ms: 140, probability: 0.09 },
      { ms: 200, probability: 0.01 },
    ],
    remoteReadVisibilityMs: 60_000,
    originReadYourWrites: true,
    durableAck: 'global',
    thumbnailVariantReads: true,
    materializedThumbnails: false,
    internalReplicationIncluded: true,
    storageUsdPerTbMonth: 6,
    retrievalUsdPerGb: 0.002,
  },
  metadata: {
    objectBytes: 8_000,
    rowOverheadBytes: 0,
    userIndexBytesPerObject: 64,
    tagPostingBytes: 96,
    tagsPerImage: 3,
    /**
     * A user index stores one compact user+recency entry per image (64 B).
     * A tag index stores three disclosed postings per image (3 x 96 B).
     * The user-tag mode stores both: 64 + 288 = 352 B per image. These are
     * teaching assumptions, not measured database overheads.
     */
    userTagIndexBytesPerObject: 352,
    indexBytesPerObject: {
      none: 0,
      user: 64,
      'user-tag': 352,
    },
    residentCacheDefaultGbPerInstance: 8,
    residentCacheMaxGbPerInstance: 22,
    backends: {
      sql: {
        durable: true,
        userIndex: true,
        tagIndex: true,
        notes:
          'Durable indexed SQL: user and tag inverted indexes are explicit; the index mode pays its own disk and write amplification.',
      },
      kv: {
        durable: true,
        userIndex: true,
        tagIndex: true,
        notes:
          'Durable key-addressed KV with composed user/tag keys. It has no free general search; the declared index mode still pays bytes and writes.',
      },
    },
  },
  client: {
    fullDuplex: true,
    aggregateBandwidthGbitPerSec: 100,
    requestAccessBandwidthGbitPerSec: 1,
    clientRttMs: 20,
    routingFailureDetectionMs: 250,
    note:
      'The fixed Client node is a regional population aggregate with a 100 Gbit/s full-duplex link. Each business request has its own 1 Gbit/s end-user access link shared by all child transfers, especially ten thumbnails. The per-request cap is not the regional client capacity.',
  },
  cache: {
    minCapacityGb: 1,
    maxCapacityGb: 512_000,
    defaultCapacityGb: 20,
    defaultInstances: 1,
    defaultMedium: 'ram',
    defaultFill: 'coalesce',
    ramCapacityLimitGbPerInstance: 22,
    ssdCapacityGbPerTb: 1_000,
    eviction: 'lru',
    key: 'object-key+variant',
    fillPolicies: ['coalesce', 'independent'],
    streamingBufferPerHopBytes: 65_536,
    cacheResponseStillUsesClientLink: true,
  },
  nodes: {
    client: {
      kind: 'client',
      label: 'Regional clients',
      fixed: true,
      configurableFields: [],
      notes:
        'Fixed regional population aggregate: 100 Gbit/s aggregate client link and 20 ms regional RTT. Each business request separately has a 1 Gbit/s access link shared by all its child transfers. Only label and position are editable.',
    },
    app: {
      kind: 'app',
      label: 'Application pool',
      fixed: false,
      configurableFields: [
        'instances',
        'delivery',
        'buffering',
        'retries',
        'retryBackoffMs',
      ],
      notes:
        'Player compute pool. Direct delivery lets clients fetch bytes from the provider; proxy delivery routes bytes through the app, optionally through one cache.',
    },
    metadata: {
      kind: 'metadata',
      label: 'Metadata store',
      fixed: false,
      configurableFields: [
        'backend',
        'index',
        'diskTb',
        'instances',
        'replicas',
        'residentCacheGb',
      ],
      notes:
        'Any healthy regional store attached to an app can append immutable local-origin records; it may also receive direct per-origin replication. Shard count is floor(instances / replicas) and instances must be divisible by replicas. Capacity provisions the complete regional dataset.',
    },
    cache: {
      kind: 'cache',
      label: 'Byte-bounded cache',
      fixed: false,
      configurableFields: [
        'medium',
        'instances',
        'capacityGb',
        'fill',
        'diskTb',
      ],
      notes:
        'Real byte-bounded LRU per object key and variant. RAM capacity is limited by each instance’s usable 22 GB; SSD capacity is bounded by the declared disk tier. A cache is not durable storage.',
    },
    blob: {
      kind: 'blob',
      label: 'Global blob provider',
      fixed: true,
      configurableFields: [],
      notes:
        'Fixed mandatory original store. Its internal replication is included in the provider price; thumbnails are generated by the provider variant-read contract and are not preallocated. Only label and position are editable.',
    },
  },
};

/** Authoritative catalog, validated at module load. */
export const IMAGE_CATALOG: ImageCatalog = imageCatalogSchema.parse(catalog);

export function cloneImageCatalog(): ImageCatalog {
  return JSON.parse(JSON.stringify(IMAGE_CATALOG)) as ImageCatalog;
}

export function parseImageCatalog(
  input: unknown,
): ImageParseResult<ImageCatalog> {
  const parsed = imageCatalogSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      value: null,
      issues: imageIssuesFromZod(parsed.error),
    };
  }
  return { ok: true, value: parsed.data, issues: [] };
}

export function imageCatalogJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(imageCatalogSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id: 'https://system-design-game.local/schemas/image-atlas-catalog.json',
    title: 'Image Atlas catalog',
  };
}
