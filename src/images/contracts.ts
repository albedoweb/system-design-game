/**
 * Image Atlas public contract (I100).
 *
 * This module is the frozen API surface shared by the browser Worker (I104),
 * the Image Atlas evaluator (I101), the agent CLI/API (I103) and tests (I105).
 * It contains only plain data types, versioned constants and strict Zod
 * schemas. It never imports React, DOM or the evaluator.
 *
 * The model is a deterministic teaching model. Every price and coefficient is
 * a conditional in-game value, not a vendor benchmark.
 */

import { z } from 'zod';

import type { TrafficObserver } from '../simulation/traffic-telemetry';

// ---------------------------------------------------------------------------
// Versions and frozen identifiers
// ---------------------------------------------------------------------------

export const IMAGE_SCHEMA_VERSION = 1 as const;
export const IMAGE_MODEL_VERSION = '1.0.0' as const;
export const IMAGE_CONTENT_VERSION = '1.0.0' as const;
export const IMAGE_PRICING_VERSION = 'image-atlas-catalog-v1' as const;
export const IMAGE_LEVEL_ID = 'image-atlas' as const;
/** Seeds are unsigned 31-bit integers so JSON and xorshift stay portable. */
export const IMAGE_MAX_SEED = 2_147_483_647;
export const IMAGE_MONTHLY_BUDGET_USD = 205_000;

export const IMAGE_REGIONS = ['na', 'eu', 'ap'] as const;
export const IMAGE_NODE_KINDS = ['client', 'app', 'metadata', 'cache', 'blob'] as const;
export const IMAGE_OPERATIONS = ['traffic', 'metadata', 'blob', 'replicate'] as const;
export const IMAGE_BUSINESS_OPERATIONS = ['upload', 'search', 'detail'] as const;
export const IMAGE_SCENARIOS = [
  'normal',
  'peak',
  'node-failure',
  'link-failure',
  'region-na-failure',
  'region-eu-failure',
  'region-ap-failure',
] as const;
export const IMAGE_METADATA_BACKENDS = ['sql', 'kv'] as const;
export const IMAGE_METADATA_INDEX_MODES = ['none', 'user', 'user-tag'] as const;
export const IMAGE_DELIVERY_MODES = ['direct', 'proxy'] as const;
export const IMAGE_BUFFERING_MODES = ['streaming', 'buffered'] as const;
export const IMAGE_CACHE_MEDIA = ['ram', 'ssd'] as const;
export const IMAGE_CACHE_FILL_POLICIES = ['coalesce', 'independent'] as const;
export const IMAGE_DISK_TB_OPTIONS = [2, 8, 16] as const;

export type ImageRegion = (typeof IMAGE_REGIONS)[number];
export type ImageNodeKind = (typeof IMAGE_NODE_KINDS)[number];
export type ImageOperation = (typeof IMAGE_OPERATIONS)[number];
export type ImageBusinessOperation = (typeof IMAGE_BUSINESS_OPERATIONS)[number];
export type ImageScenarioName = (typeof IMAGE_SCENARIOS)[number];
export type ImageMetadataBackend = (typeof IMAGE_METADATA_BACKENDS)[number];
export type ImageMetadataIndexMode = (typeof IMAGE_METADATA_INDEX_MODES)[number];
export type ImageDeliveryMode = (typeof IMAGE_DELIVERY_MODES)[number];
export type ImageBufferingMode = (typeof IMAGE_BUFFERING_MODES)[number];
export type ImageCacheMedium = (typeof IMAGE_CACHE_MEDIA)[number];
export type ImageCacheFillPolicy = (typeof IMAGE_CACHE_FILL_POLICIES)[number];
export type ImageDiskTb = (typeof IMAGE_DISK_TB_OPTIONS)[number];

/** The only required qualification set in v1. Order is stable for agents. */
export const IMAGE_REQUIRED_SCENARIOS = IMAGE_SCENARIOS;
export const IMAGE_DATASET_DAY = 30 as const;

/**
 * Shared limits. The Zod schemas below import these values where practical;
 * `IMAGE_COMPONENT_LIMITS` is also returned by discovery so a UI/CLI does not
 * need to inspect the schemas.
 */
export const IMAGE_COMPONENT_LIMITS = {
  maxNodes: 60,
  maxEdges: 160,
  maxDocumentBytes: 1_048_576,
  idPattern: '^[A-Za-z0-9._:-]{1,64}$',
  labelMaxLength: 80,
  position: { min: -10_000, max: 10_000 },
  instances: { min: 1, max: 32 },
  replicas: { min: 1, max: 32 },
  diskTbOptions: [...IMAGE_DISK_TB_OPTIONS],
  cacheCapacityGb: { min: 1, max: 512_000 },
  residentCacheGb: { min: 0, max: 22 },
  retryBackoffMs: { min: 0, max: 2_000 },
  retries: { min: 0, max: 2 },
  seed: { min: 0, max: IMAGE_MAX_SEED },
  datasetDay: IMAGE_DATASET_DAY,
  scenarios: [...IMAGE_REQUIRED_SCENARIOS],
  operations: [...IMAGE_OPERATIONS],
  businessOperations: [...IMAGE_BUSINESS_OPERATIONS],
  nodeKinds: [...IMAGE_NODE_KINDS],
  regions: [...IMAGE_REGIONS],
} as const;

export const IMAGE_SEED_SCHEMA = z
  .number()
  .int()
  .min(IMAGE_COMPONENT_LIMITS.seed.min)
  .max(IMAGE_COMPONENT_LIMITS.seed.max)
  .finite();

// ---------------------------------------------------------------------------
// Issues, diagnostics and checks (normalised across all consumers)
// ---------------------------------------------------------------------------

export type ImageIssueSeverity = 'error' | 'warning' | 'info';
export type ImageCheckSeverity = 'required' | 'advisory';

export const imageIssueSchema = z.strictObject({
  severity: z.enum(['error', 'warning', 'info']),
  /** Stable machine-readable identifier, for example `duplicate_node_id`. */
  code: z.string().min(1).max(96),
  /** English product message. */
  message: z.string().min(1).max(2_000),
  /** JSON path inside the submitted document, when relevant. */
  path: z.string().min(1).max(200).optional(),
  nodeId: z.string().min(1).max(64).optional(),
  edgeId: z.string().min(1).max(64).optional(),
  scenario: z.enum(IMAGE_SCENARIOS).optional(),
  metric: z.string().min(1).max(96).optional(),
  value: z.number().finite().optional(),
  limit: z.number().finite().optional(),
});

export type ImageIssue = z.infer<typeof imageIssueSchema>;

export const imageCheckSchema = z.strictObject({
  /** Stable gate identifier used by agents and the results panel. */
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(200),
  passed: z.boolean(),
  severity: z.enum(['required', 'advisory']),
  scenario: z.enum(IMAGE_SCENARIOS).optional(),
  operation: z.enum(IMAGE_BUSINESS_OPERATIONS).optional(),
  nodeId: z.string().min(1).max(64).optional(),
  metric: z.string().min(1).max(96).optional(),
  actual: z.number().finite().optional(),
  limit: z.number().finite().optional(),
  unit: z.string().min(1).max(32).optional(),
  sampleCount: z.number().int().min(0).optional(),
  message: z.string().min(1).max(2_000),
});

export type ImageCheck = z.infer<typeof imageCheckSchema>;

export const imageDiagnosticSchema = z.strictObject({
  id: z.string().min(1).max(128),
  severity: z.enum(['error', 'warning', 'info']),
  code: z.string().min(1).max(96),
  message: z.string().min(1).max(2_000),
  path: z.string().min(1).max(200).optional(),
  scenario: z.enum(IMAGE_SCENARIOS).optional(),
  operation: z.enum(IMAGE_BUSINESS_OPERATIONS).optional(),
  nodeId: z.string().min(1).max(64).optional(),
  edgeId: z.string().min(1).max(64).optional(),
  metric: z.string().min(1).max(96).optional(),
  value: z.number().finite().optional(),
  limit: z.number().finite().optional(),
});

export type ImageDiagnostic = z.infer<typeof imageDiagnosticSchema>;

export type ImageParseResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly issues: readonly ImageIssue[];
    }
  | {
      readonly ok: false;
      readonly value: null;
      readonly issues: readonly ImageIssue[];
    };

/**
 * Convert a Zod error into bounded, English product issues. All schemas share
 * this function so the browser, CLI and API report the same stable codes.
 */
export function imageIssuesFromZod(
  error: z.ZodError,
  pathPrefix = '',
): ImageIssue[] {
  const issues: ImageIssue[] = [];
  for (const issue of error.issues) {
    const zodCode = String(issue.code);
    const path = [...issue.path.map(String), ...(pathPrefix === '' ? [] : [pathPrefix])]
      .filter((part) => part.length > 0)
      .join('.');
    const base = {
      severity: 'error' as const,
      message: issue.message,
      ...(path === '' ? {} : { path }),
    };
    if (zodCode === 'unrecognized_keys') {
      const keys =
        'keys' in issue && Array.isArray(issue.keys) ? issue.keys : [];
      for (const key of keys) {
        issues.push({
          ...base,
          code: 'unknown_field',
          message: `Unknown field "${String(key)}" is not allowed.`,
        });
      }
      continue;
    }
    const code =
      zodCode === 'invalid_type'
        ? 'invalid_type'
        : zodCode === 'too_small' || zodCode === 'too_big'
          ? 'number_out_of_range'
          : zodCode === 'invalid_literal'
            ? 'invalid_value'
            : zodCode === 'invalid_enum_value'
              ? 'invalid_value'
              : zodCode === 'invalid_union'
                ? 'invalid_union'
                : zodCode === 'invalid_format'
                  ? 'invalid_string'
                  : 'invalid_value';
    issues.push({ ...base, code });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Graph documents
// ---------------------------------------------------------------------------

export interface ImagePosition {
  readonly x: number;
  readonly y: number;
}

export const imagePositionSchema = z.strictObject({
  x: z
    .number()
    .finite()
    .min(IMAGE_COMPONENT_LIMITS.position.min)
    .max(IMAGE_COMPONENT_LIMITS.position.max),
  y: z
    .number()
    .finite()
    .min(IMAGE_COMPONENT_LIMITS.position.min)
    .max(IMAGE_COMPONENT_LIMITS.position.max),
});

export const imageRegionSchema = z.enum(IMAGE_REGIONS);
export const imageNodeKindSchema = z.enum(IMAGE_NODE_KINDS);
export const imageOperationSchema = z.enum(IMAGE_OPERATIONS);
export const imageBusinessOperationSchema = z.enum(IMAGE_BUSINESS_OPERATIONS);
export const imageScenarioNameSchema = z.enum(IMAGE_SCENARIOS);

export const imageIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const imageLabelSchema = z
  .string()
  .min(1)
  .max(IMAGE_COMPONENT_LIMITS.labelMaxLength);

/** Client and provider configuration is fixed; labels and positions are not. */
export const imageClientConfigSchema = z.strictObject({
  clientRttMs: z.literal(20),
  fullDuplex: z.literal(true),
  /** Population aggregate link on the fixed regional Client node. */
  aggregateBandwidthGbitPerSec: z.literal(100),
  /** Per business request/end-user access link, shared by all child transfers. */
  requestAccessBandwidthGbitPerSec: z.literal(1),
});

export type ImageClientConfig = z.infer<typeof imageClientConfigSchema>;

export const imageAppConfigSchema = z.strictObject({
  instances: z
    .number()
    .int()
    .min(IMAGE_COMPONENT_LIMITS.instances.min)
    .max(IMAGE_COMPONENT_LIMITS.instances.max),
  delivery: z.enum(IMAGE_DELIVERY_MODES),
  buffering: z.enum(IMAGE_BUFFERING_MODES),
  retries: z
    .number()
    .int()
    .min(IMAGE_COMPONENT_LIMITS.retries.min)
    .max(IMAGE_COMPONENT_LIMITS.retries.max),
  retryBackoffMs: z
    .number()
    .int()
    .min(IMAGE_COMPONENT_LIMITS.retryBackoffMs.min)
    .max(IMAGE_COMPONENT_LIMITS.retryBackoffMs.max),
});

export type ImageAppConfig = z.infer<typeof imageAppConfigSchema>;

export const imageMetadataConfigSchema = z.strictObject({
  backend: z.enum(IMAGE_METADATA_BACKENDS),
  index: z.enum(IMAGE_METADATA_INDEX_MODES),
  diskTb: z.union([z.literal(2), z.literal(8), z.literal(16)]),
  instances: z
    .number()
    .int()
    .min(IMAGE_COMPONENT_LIMITS.instances.min)
    .max(IMAGE_COMPONENT_LIMITS.instances.max),
  /** Local durable copies per shard. Must divide `instances`. */
  replicas: z
    .number()
    .int()
    .min(IMAGE_COMPONENT_LIMITS.replicas.min)
    .max(IMAGE_COMPONENT_LIMITS.replicas.max),
  /** Resident metadata pages per instance; the rest is read from disk. */
  residentCacheGb: z
    .number()
    .int()
    .min(IMAGE_COMPONENT_LIMITS.residentCacheGb.min)
    .max(IMAGE_COMPONENT_LIMITS.residentCacheGb.max),
});

export type ImageMetadataConfig = z.infer<typeof imageMetadataConfigSchema>;

const imageCacheRamConfigSchema = z.strictObject({
  medium: z.literal('ram'),
  instances: z
    .number()
    .int()
    .min(IMAGE_COMPONENT_LIMITS.instances.min)
    .max(IMAGE_COMPONENT_LIMITS.instances.max),
  /** Total usable cache bytes across the pool, in decimal GB. */
  capacityGb: z
    .number()
    .finite()
    .min(IMAGE_COMPONENT_LIMITS.cacheCapacityGb.min)
    .max(IMAGE_COMPONENT_LIMITS.cacheCapacityGb.max),
  fill: z.enum(IMAGE_CACHE_FILL_POLICIES),
});

const imageCacheSsdConfigSchema = z.strictObject({
  medium: z.literal('ssd'),
  instances: z
    .number()
    .int()
    .min(IMAGE_COMPONENT_LIMITS.instances.min)
    .max(IMAGE_COMPONENT_LIMITS.instances.max),
  capacityGb: z
    .number()
    .finite()
    .min(IMAGE_COMPONENT_LIMITS.cacheCapacityGb.min)
    .max(IMAGE_COMPONENT_LIMITS.cacheCapacityGb.max),
  fill: z.enum(IMAGE_CACHE_FILL_POLICIES),
  /** Per-instance SSD allocation, charged through the incremental disk tier. */
  diskTb: z.union([z.literal(2), z.literal(8), z.literal(16)]),
});

export const imageCacheConfigSchema = z.discriminatedUnion('medium', [
  imageCacheRamConfigSchema,
  imageCacheSsdConfigSchema,
]);

export type ImageCacheConfig = z.infer<typeof imageCacheConfigSchema>;

export const imageBlobConfigSchema = z.strictObject({
  providerId: z.literal('global-blob'),
  endpointBandwidthGbitPerSec: z.literal(100),
  readRpcPerSec: z.literal(10_000),
  writeRpcPerSec: z.literal(2_000),
  remoteReadVisibilityMs: z.literal(60_000),
  originReadYourWrites: z.literal(true),
  durableAck: z.literal('global'),
  thumbnailVariantReads: z.literal(true),
  materializedThumbnails: z.literal(false),
});

export type ImageBlobConfig = z.infer<typeof imageBlobConfigSchema>;

interface ImageNodeBase {
  readonly id: string;
  readonly label: string;
  readonly position: ImagePosition;
  readonly region: ImageRegion;
}

export interface ImageClientNode extends ImageNodeBase {
  readonly kind: 'client';
  readonly config: ImageClientConfig;
}

export interface ImageAppNode extends ImageNodeBase {
  readonly kind: 'app';
  readonly config: ImageAppConfig;
}

export interface ImageMetadataNode extends ImageNodeBase {
  readonly kind: 'metadata';
  readonly config: ImageMetadataConfig;
}

export interface ImageCacheNode extends ImageNodeBase {
  readonly kind: 'cache';
  readonly config: ImageCacheConfig;
}

export interface ImageBlobNode extends ImageNodeBase {
  readonly kind: 'blob';
  readonly config: ImageBlobConfig;
}

export type ImageNode =
  | ImageClientNode
  | ImageAppNode
  | ImageMetadataNode
  | ImageCacheNode
  | ImageBlobNode;

export type ImagePlayerNode = ImageAppNode | ImageMetadataNode | ImageCacheNode;
export type ImageNodeConfig = ImageNode['config'];

export const imageClientNodeSchema = z.strictObject({
  id: imageIdSchema,
  kind: z.literal('client'),
  label: imageLabelSchema,
  position: imagePositionSchema,
  region: imageRegionSchema,
  config: imageClientConfigSchema,
});

export const imageAppNodeSchema = z.strictObject({
  id: imageIdSchema,
  kind: z.literal('app'),
  label: imageLabelSchema,
  position: imagePositionSchema,
  region: imageRegionSchema,
  config: imageAppConfigSchema,
});

export const imageMetadataNodeSchema = z.strictObject({
  id: imageIdSchema,
  kind: z.literal('metadata'),
  label: imageLabelSchema,
  position: imagePositionSchema,
  region: imageRegionSchema,
  config: imageMetadataConfigSchema,
});

export const imageCacheNodeSchema = z.strictObject({
  id: imageIdSchema,
  kind: z.literal('cache'),
  label: imageLabelSchema,
  position: imagePositionSchema,
  region: imageRegionSchema,
  config: imageCacheConfigSchema,
});

export const imageBlobNodeSchema = z.strictObject({
  id: imageIdSchema,
  kind: z.literal('blob'),
  label: imageLabelSchema,
  position: imagePositionSchema,
  region: imageRegionSchema,
  config: imageBlobConfigSchema,
});

export const imageNodeSchema = z.discriminatedUnion('kind', [
  imageClientNodeSchema,
  imageAppNodeSchema,
  imageMetadataNodeSchema,
  imageCacheNodeSchema,
  imageBlobNodeSchema,
]);

export const imageEdgeSchema = z.strictObject({
  id: imageIdSchema,
  source: imageIdSchema,
  target: imageIdSchema,
  operation: imageOperationSchema,
});

export type ImageEdge = z.infer<typeof imageEdgeSchema>;

export const imageGraphSchema = z.strictObject({
  schemaVersion: z.literal(IMAGE_SCHEMA_VERSION),
  levelId: z.literal(IMAGE_LEVEL_ID),
  modelVersion: z.literal(IMAGE_MODEL_VERSION),
  /** Display name only. Seeds belong to the explicit save envelope. */
  name: z.string().min(1).max(80).optional(),
  nodes: z
    .array(imageNodeSchema)
    .min(1)
    .max(IMAGE_COMPONENT_LIMITS.maxNodes),
  edges: z.array(imageEdgeSchema).max(IMAGE_COMPONENT_LIMITS.maxEdges),
});

export type ImageGraph = z.infer<typeof imageGraphSchema>;

/** Graph parser result, aligned with the other playable levels. */
export type ImageGraphParseResult =
  | {
      readonly ok: true;
      readonly graph: ImageGraph;
      readonly issues: readonly ImageIssue[];
    }
  | {
      readonly ok: false;
      readonly graph: null;
      readonly issues: readonly ImageIssue[];
    };

export interface ImageValidationOptions {
  /** Kept for symmetry with other levels; semantic errors are the same. */
  readonly mode?: 'edit' | 'run';
}

// ---------------------------------------------------------------------------
// Route compilation types (shared by validation, capacity and I101)
// ---------------------------------------------------------------------------

export interface ImageBlobPath {
  readonly mode: 'direct' | 'proxy';
  readonly providerId: string;
  readonly cacheId: string | null;
}

/**
 * One explicit failover choice for a fixed client population. The client may
 * list several apps; the engine selects the lowest-latency healthy connected
 * app after the fixed failure-detection delay. It never follows an implicit
 * edge that is absent from the graph.
 */
export interface ImageClientAppOption {
  readonly appId: string;
  readonly appRegion: ImageRegion;
  readonly delivery: ImageDeliveryMode;
  /** Store selected by this app for reads and new immutable uploads. */
  readonly metadataStoreNodeId: string;
  /** Proxy path; null for a direct app. */
  readonly blobPath: ImageBlobPath | null;
}

export interface ImageClientRoute {
  readonly clientId: string;
  readonly region: ImageRegion;
  readonly apps: readonly ImageClientAppOption[];
  /** Explicit direct-delivery provider choices, nearest healthy is selected. */
  readonly directProviderIds: readonly string[];
}

export interface ImageAppRoute {
  readonly appId: string;
  readonly region: ImageRegion;
  readonly delivery: ImageDeliveryMode;
  /** The store this app uses for reads and for new upload origins. */
  readonly metadataStoreNodeId: string | null;
  readonly blobPath: ImageBlobPath | null;
  readonly clientIds: readonly string[];
}

/** A metadata store that accepts new immutable upload records as an origin. */
export interface ImageMetadataOriginRoute {
  readonly nodeId: string;
  readonly region: ImageRegion;
  readonly appIds: readonly string[];
}

/** One direct per-origin replication edge. No transitive rebroadcast. */
export interface ImageMetadataReplicationRoute {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly sourceRegion: ImageRegion;
  readonly targetRegion: ImageRegion;
}

export interface ImageCacheRoute {
  readonly cacheId: string;
  readonly region: ImageRegion;
  readonly providerId: string;
  readonly appIds: readonly string[];
}

export interface ImageRoutePlan {
  readonly valid: boolean;
  readonly issues: readonly ImageIssue[];
  readonly fixedClientIds: readonly string[];
  readonly fixedProviderIds: readonly string[];
  /** Every metadata node attached to an app and therefore an origin writer. */
  readonly metadataOrigins: readonly ImageMetadataOriginRoute[];
  /** Explicit origin -> recipient edges; cycles are allowed and not rebroadcast. */
  readonly metadataReplication: readonly ImageMetadataReplicationRoute[];
  readonly apps: readonly ImageAppRoute[];
  readonly clients: readonly ImageClientRoute[];
  readonly caches: readonly ImageCacheRoute[];
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const imageLatencyBandSchema = z.strictObject({
  ms: z.number().finite().min(0).max(10_000),
  probability: z.number().finite().min(0).max(1),
});

export type ImageLatencyBand = z.infer<typeof imageLatencyBandSchema>;

export const imageInstanceProfileSchema = z.strictObject({
  cpuCores: z.literal(8),
  memoryGb: z.literal(24),
  usableMemoryGb: z.literal(22),
  baseRssGb: z.literal(2),
  networkGbitPerSec: z.literal(10),
  diskTbOptions: z.tuple([z.literal(2), z.literal(8), z.literal(16)]),
  diskMbps: z.literal(500),
  diskIops: z.literal(20_000),
  hourlyUsd: z.literal(0.2),
});

export type ImageInstanceProfile = z.infer<typeof imageInstanceProfileSchema>;

export const imagePriceCatalogSchema = z.strictObject({
  currency: z.literal('USD'),
  computeUsdPerInstanceHour: z.literal(0.2),
  billingHoursPerMonth: z.literal(730),
  includedDiskTb: z.literal(2),
  extraDiskUsdPerTbMonth: z.literal(6),
  providerOriginalsUsdPerTbMonth: z.literal(6),
  providerRetrievalUsdPerGb: z.literal(0.002),
  clientEgressUsdPerGb: z.literal(0.006),
  crossRegionUsdPerGb: z.literal(0.01),
  apiReadUsd: z.literal(0.000_000_4),
  apiWriteUsd: z.literal(0.000_005),
});

export type ImagePriceCatalog = z.infer<typeof imagePriceCatalogSchema>;

export const imageProviderCatalogSchema = z.strictObject({
  id: z.literal('global-blob'),
  endpointBandwidthGbitPerSec: z.literal(100),
  readRpcPerSec: z.literal(10_000),
  writeRpcPerSec: z.literal(2_000),
  readStartLatencyBands: z.array(imageLatencyBandSchema).min(1).max(8),
  writeStartLatencyBands: z.array(imageLatencyBandSchema).min(1).max(8),
  remoteReadVisibilityMs: z.literal(60_000),
  originReadYourWrites: z.literal(true),
  durableAck: z.literal('global'),
  thumbnailVariantReads: z.literal(true),
  materializedThumbnails: z.literal(false),
  internalReplicationIncluded: z.literal(true),
  storageUsdPerTbMonth: z.literal(6),
  retrievalUsdPerGb: z.literal(0.002),
});

export type ImageProviderCatalog = z.infer<typeof imageProviderCatalogSchema>;

export const imageMetadataCatalogSchema = z.strictObject({
  objectBytes: z.literal(8_000),
  rowOverheadBytes: z.literal(0),
  userIndexBytesPerObject: z.literal(64),
  tagPostingBytes: z.literal(96),
  tagsPerImage: z.literal(3),
  userTagIndexBytesPerObject: z.literal(352),
  indexBytesPerObject: z.strictObject({
    none: z.literal(0),
    user: z.literal(64),
    'user-tag': z.literal(352),
  }),
  residentCacheDefaultGbPerInstance: z.literal(8),
  residentCacheMaxGbPerInstance: z.literal(22),
  backends: z.strictObject({
    sql: z.strictObject({
      durable: z.literal(true),
      userIndex: z.literal(true),
      tagIndex: z.literal(true),
      notes: z.string().min(1).max(500),
    }),
    kv: z.strictObject({
      durable: z.literal(true),
      userIndex: z.literal(true),
      tagIndex: z.literal(true),
      notes: z.string().min(1).max(500),
    }),
  }),
});

export type ImageMetadataCatalog = z.infer<typeof imageMetadataCatalogSchema>;

export const imageCacheCatalogSchema = z.strictObject({
  minCapacityGb: z.literal(1),
  maxCapacityGb: z.literal(512_000),
  defaultCapacityGb: z.literal(20),
  defaultInstances: z.literal(1),
  defaultMedium: z.literal('ram'),
  defaultFill: z.literal('coalesce'),
  ramCapacityLimitGbPerInstance: z.literal(22),
  ssdCapacityGbPerTb: z.literal(1_000),
  eviction: z.literal('lru'),
  key: z.literal('object-key+variant'),
  fillPolicies: z.tuple([z.literal('coalesce'), z.literal('independent')]),
  streamingBufferPerHopBytes: z.literal(65_536),
  cacheResponseStillUsesClientLink: z.literal(true),
});

export type ImageCacheCatalog = z.infer<typeof imageCacheCatalogSchema>;

export const imageClientCatalogSchema = z.strictObject({
  fullDuplex: z.literal(true),
  /** Population aggregate link on the fixed regional Client node. */
  aggregateBandwidthGbitPerSec: z.literal(100),
  /** Per business request/end-user access link, shared by child transfers. */
  requestAccessBandwidthGbitPerSec: z.literal(1),
  clientRttMs: z.literal(20),
  routingFailureDetectionMs: z.literal(250),
  note: z.string().min(1).max(500),
});

export type ImageClientCatalog = z.infer<typeof imageClientCatalogSchema>;

export const imageNodeComponentSchema = z.strictObject({
  kind: imageNodeKindSchema,
  label: z.string().min(1).max(80),
  fixed: z.boolean(),
  configurableFields: z.array(z.string().min(1).max(64)).max(32),
  notes: z.string().min(1).max(1_000),
});

export type ImageNodeComponent = z.infer<typeof imageNodeComponentSchema>;

export const imageCatalogSchema = z.strictObject({
  schemaVersion: z.literal(IMAGE_SCHEMA_VERSION),
  pricingVersion: z.literal(IMAGE_PRICING_VERSION),
  currency: z.literal('USD'),
  priceNote: z.string().min(1).max(1_000),
  instance: imageInstanceProfileSchema,
  prices: imagePriceCatalogSchema,
  provider: imageProviderCatalogSchema,
  metadata: imageMetadataCatalogSchema,
  cache: imageCacheCatalogSchema,
  client: imageClientCatalogSchema,
  nodes: z.strictObject({
    client: imageNodeComponentSchema,
    app: imageNodeComponentSchema,
    metadata: imageNodeComponentSchema,
    cache: imageNodeComponentSchema,
    blob: imageNodeComponentSchema,
  }),
});

export type ImageCatalog = z.infer<typeof imageCatalogSchema>;

// ---------------------------------------------------------------------------
// Level
// ---------------------------------------------------------------------------

export const imageRegionSpecSchema = z.strictObject({
  id: imageRegionSchema,
  label: z.string().min(1).max(80),
  demandShare: z.number().finite().min(0).max(1),
  clientRttMs: z.literal(20),
  aggregateBandwidthGbitPerSec: z.literal(100),
  requestAccessBandwidthGbitPerSec: z.literal(1),
});

export type ImageRegionSpec = z.infer<typeof imageRegionSpecSchema>;

export const imageRegionLinkSchema = z.strictObject({
  a: imageRegionSchema,
  b: imageRegionSchema,
  bandwidthGbitPerSec: z.literal(100),
  oneWayLatencyMs: z.number().finite().min(0).max(1_000),
  fullDuplex: z.literal(true),
  sharedByAllTransfers: z.literal(true),
});

export type ImageRegionLink = z.infer<typeof imageRegionLinkSchema>;

export const imageDatasetSpecSchema = z.strictObject({
  retentionDays: z.literal(30),
  users: z.number().int().min(1),
  uploadsPerUserPerDay: z.number().int().min(1),
  searchesPerUserPerDay: z.number().int().min(1),
  detailClicksPerSearch: z.number().int().min(1),
  searchResultsPerSearch: z.number().int().min(1).max(100),
  originalBytes: z.number().int().min(1),
  thumbnailBytes: z.number().int().min(1),
  metadataBytes: z.number().int().min(1),
  matureImages: z.number().int().min(1),
  matureOriginalTb: z.number().finite().min(0),
  matureMetadataTb: z.number().finite().min(0),
  matureMaterializedThumbnailTb: z.number().finite().min(0),
});

export type ImageDatasetSpec = z.infer<typeof imageDatasetSpecSchema>;

export const imageWorkloadSpecSchema = z.strictObject({
  operationRatesPerDay: z.strictObject({
    upload: z.number().finite().min(0),
    search: z.number().finite().min(0),
    detail: z.number().finite().min(0),
  }),
  averageRatesPerSecond: z.strictObject({
    upload: z.number().finite().min(0),
    search: z.number().finite().min(0),
    detail: z.number().finite().min(0),
  }),
  sampleFactor: z.number().finite().min(1),
  /** Arrival/fault RNG streams depend only on seed and versions, never graph ids. */
  traceSeedPolicy: z.literal('graph-independent'),
  hotKeyShare: z.number().finite().min(0).max(1),
  hotKeys: z.number().int().min(1),
  longTailRepresentativeKeys: z.number().int().min(1),
  longTailMapsToMatureDataset: z.literal(true),
  recentReadProbeShare: z.number().finite().min(0).max(1),
  recentReadProbeAgeBoundMs: z.number().finite().min(0),
  searchBy: z.tuple([z.literal('user'), z.literal('one-tag')]),
  recentFirst: z.literal(true),
  generalTextSearch: z.literal(false),
  cacheInitialState: z.literal('empty'),
  warmupFillsCache: z.literal(true),
  syntheticOldKeysFullyVisible: z.literal(true),
  /** Disclosed pre-existing replication state for every scenario. */
  replicaInitialState: z.literal('caught-up'),
});

export type ImageWorkloadSpec = z.infer<typeof imageWorkloadSpecSchema>;

/**
 * Versioned metadata semantics. Every healthy regional store attached to an
 * app can append new immutable uploads as an origin. Replicas track direct
 * per-origin logs; a record is applied once per recipient and never
 * recursively rebroadcast.
 */
export const imageMetadataProtocolSpecSchema = z.strictObject({
  recordModel: z.literal('immutable-append-only'),
  originModel: z.literal('healthy-accepting-region'),
  progressModel: z.literal('per-origin'),
  ackRequiresLocalDurableCopies: z.literal(true),
  ackVsPublication: z.literal('separate'),
  sameIdSameContent: z.literal('single-effect'),
  sameIdDifferentContent: z.literal('rejected'),
  unavailableOwner: z.literal('pending-no-new-origin'),
  replicationBroadcast: z.literal('direct-only'),
  replicationCycles: z.literal('allowed-deduped'),
});

export type ImageMetadataProtocolSpec = z.infer<
  typeof imageMetadataProtocolSpecSchema
>;

export const imageSloProfileSchema = z.strictObject({
  availability: z.number().finite().min(0).max(1),
  detailP999Ms: z.number().finite().min(0),
  searchP999Ms: z.number().finite().min(0),
  uploadP999Ms: z.number().finite().min(0),
});

export type ImageSloProfile = z.infer<typeof imageSloProfileSchema>;

export const imageSloSpecSchema = z.strictObject({
  normal: imageSloProfileSchema,
  incident: imageSloProfileSchema,
  incidentWindowAvailability: z.number().finite().min(0).max(1),
  recoveryAvailability: z.number().finite().min(0).max(1),
  recoveryFinalWindowMs: z.number().int().min(1),
  deadlinesMs: z.strictObject({
    upload: z.number().finite().min(1),
    search: z.number().finite().min(1),
    detail: z.number().finite().min(1),
  }),
  freshnessMs: z.number().finite().min(0),
  globalIndexBoundMs: z.number().finite().min(0),
});

export type ImageSloSpec = z.infer<typeof imageSloSpecSchema>;

const imageNoFaultSchema = z.strictObject({
  kind: z.literal('none'),
});

const imageNodeFaultSchema = z.strictObject({
  kind: z.literal('node'),
  target: z.literal('one-instance-per-pool'),
  atMeasuredMs: z.number().int().min(0).max(60_000),
  durationMs: z.number().int().min(1).max(60_000),
});

const imageLinkFaultSchema = z.strictObject({
  kind: z.literal('link'),
  a: z.literal('na'),
  b: z.literal('eu'),
  directions: z.literal('both'),
  atMeasuredMs: z.number().int().min(0).max(60_000),
  durationMs: z.number().int().min(1).max(60_000),
});

const imageRegionFaultSchema = z.strictObject({
  kind: z.literal('region'),
  region: imageRegionSchema,
  atMeasuredMs: z.number().int().min(0).max(60_000),
  durationMs: z.number().int().min(1).max(60_000),
});

export const imageScenarioFaultSchema = z.discriminatedUnion('kind', [
  imageNoFaultSchema,
  imageNodeFaultSchema,
  imageLinkFaultSchema,
  imageRegionFaultSchema,
]);

export type ImageScenarioFault = z.infer<typeof imageScenarioFaultSchema>;

export const imageScenarioSpecSchema = z.strictObject({
  name: imageScenarioNameSchema,
  label: z.string().min(1).max(80),
  demandMultiplier: z.number().finite().min(1).max(4),
  fault: imageScenarioFaultSchema,
});

export type ImageScenarioSpec = z.infer<typeof imageScenarioSpecSchema>;

export const imagePostludeSpecSchema = z.strictObject({
  /** No new offers after the measured window; outstanding work drains. */
  noNewOffers: z.literal(true),
  /** Consistency/post-publication window measured from the last ACK. */
  maxAfterLastAckMs: z.literal(120_000),
  backgroundWorkCounted: z.literal(true),
  includedInMeasuredLoad: z.literal(false),
  coversLostAckCommits: z.literal(true),
});

export type ImagePostludeSpec = z.infer<typeof imagePostludeSpecSchema>;

export const imageQualificationSpecSchema = z.strictObject({
  warmupMs: z.literal(20_000),
  measuredMs: z.literal(60_000),
  /** Request drain only; the consistency postlude is separate. */
  drainMs: z.literal(10_000),
  postlude: imagePostludeSpecSchema,
  requiredScenarios: z.array(imageScenarioNameSchema).length(IMAGE_REQUIRED_SCENARIOS.length),
  minimumP999Samples: z.literal(10_000),
  calibrationSeeds: z.tuple([
    z.number().int().min(0).max(IMAGE_MAX_SEED),
    z.number().int().min(0).max(IMAGE_MAX_SEED),
    z.number().int().min(0).max(IMAGE_MAX_SEED),
  ]),
  holdoutSeeds: z.array(z.number().int().min(0).max(IMAGE_MAX_SEED)).max(16),
  linkOutage: z.strictObject({
    a: z.literal('na'),
    b: z.literal('eu'),
    directions: z.literal('both'),
  }),
  nodeFault: z.literal('one-instance-per-pool'),
  maxEventsPerScenario: z.number().int().min(1),
  maxMemoryBytes: z.number().int().min(1),
  samplePolicy: z.literal('extend-deterministically'),
  scenarios: z.array(imageScenarioSpecSchema).length(IMAGE_REQUIRED_SCENARIOS.length),
});

export type ImageQualificationSpec = z.infer<typeof imageQualificationSpecSchema>;

export const imageLevelSchema = z.strictObject({
  schemaVersion: z.literal(IMAGE_SCHEMA_VERSION),
  contentVersion: z.literal(IMAGE_CONTENT_VERSION),
  modelVersion: z.literal(IMAGE_MODEL_VERSION),
  pricingVersion: z.literal(IMAGE_PRICING_VERSION),
  id: z.literal(IMAGE_LEVEL_ID),
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(2_000),
  dataset: imageDatasetSpecSchema,
  regions: z.array(imageRegionSpecSchema).length(3),
  network: z.strictObject({
    localPropagationMs: z.literal(1),
    fullMesh: z.literal(true),
    interRegionLinks: z.array(imageRegionLinkSchema).length(3),
    oneExplicitPathPerTransfer: z.literal(true),
    clientRttMs: z.literal(20),
    clientLinksFullDuplex: z.literal(true),
    /** Fixed population aggregate link on each Client node. */
    aggregateClientBandwidthGbitPerSec: z.literal(100),
    /** Per business request/end-user access link, shared by all child transfers. */
    requestAccessBandwidthGbitPerSec: z.literal(1),
    clientTrafficChargedOnAggregate: z.literal(true),
    routingFailureDetectionMs: z.literal(250),
    selectsNearestHealthyConnectedApp: z.literal(true),
    missingEdgeRouting: z.literal('forbidden'),
  }),
  workload: imageWorkloadSpecSchema,
  metadataProtocol: imageMetadataProtocolSpecSchema,
  slo: imageSloSpecSchema,
  qualification: imageQualificationSpecSchema,
  budget: z.strictObject({
    monthlyUsd: z.literal(IMAGE_MONTHLY_BUDGET_USD),
    currency: z.literal('USD'),
    note: z.string().min(1).max(1_000),
  }),
  defaultSeed: z.number().int().min(0).max(IMAGE_MAX_SEED),
  refs: z.strictObject({
    trainingSeeds: z.array(z.number().int().min(0).max(IMAGE_MAX_SEED)).min(1).max(16),
    holdoutSeeds: z.array(z.number().int().min(0).max(IMAGE_MAX_SEED)).max(16),
  }),
  assumptions: z.array(z.string().min(1).max(2_000)).max(64),
});

export type ImageLevel = z.infer<typeof imageLevelSchema>;

// ---------------------------------------------------------------------------
// Capacity and cost
// ---------------------------------------------------------------------------

export const imageDatasetUsageSchema = z.strictObject({
  retentionDays: z.literal(30),
  day: z.literal(30),
  users: z.number().int().min(1),
  uploadsPerUserPerDay: z.number().int().min(1),
  searchesPerUserPerDay: z.number().int().min(1),
  detailClicksPerSearch: z.number().int().min(1),
  searchResultsPerSearch: z.number().int().min(1),
  originalBytesPerObject: z.number().int().min(1),
  thumbnailBytesPerObject: z.number().int().min(1),
  metadataBytesPerObject: z.number().int().min(1),
  images: z.number().int().min(1),
  originalBytes: z.number().finite().min(0),
  originalTb: z.number().finite().min(0),
  metadataBaseBytes: z.number().finite().min(0),
  metadataBaseTb: z.number().finite().min(0),
  thumbnailIfMaterializedBytes: z.number().finite().min(0),
  thumbnailIfMaterializedTb: z.number().finite().min(0),
  materializedThumbnails: z.literal(false),
});

export type ImageDatasetUsage = z.infer<typeof imageDatasetUsageSchema>;

export const imageMetadataNodeUsageSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  region: imageRegionSchema,
  /** A store may be an origin, a replica, both, or unused. */
  roles: z.array(z.enum(['origin', 'replica'])).max(2),
  appIds: z.array(z.string().min(1).max(64)),
  replicationSources: z.array(z.string().min(1).max(64)),
  backend: z.enum(IMAGE_METADATA_BACKENDS),
  index: z.enum(IMAGE_METADATA_INDEX_MODES),
  instances: z.number().int().min(1),
  replicas: z.number().int().min(1),
  shardCount: z.number().int().min(0),
  divisible: z.boolean(),
  diskTbPerInstance: z.number().finite().min(1),
  residentCacheGbPerInstance: z.number().finite().min(0),
  residentCacheFits: z.boolean(),
  serviceBaseTb: z.number().finite().min(0),
  serviceIndexTb: z.number().finite().min(0),
  serviceDataTb: z.number().finite().min(0),
  physicalDataTb: z.number().finite().min(0),
  provisionedDiskTb: z.number().finite().min(0),
  logicalCapacityTb: z.number().finite().min(0),
  utilizationLogical: z.number().finite().min(0),
  utilizationProvisioned: z.number().finite().min(0),
  capacityOk: z.boolean(),
});

export type ImageMetadataNodeUsage = z.infer<typeof imageMetadataNodeUsageSchema>;

export const imageCacheUsageSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  region: imageRegionSchema,
  medium: z.enum(IMAGE_CACHE_MEDIA),
  fill: z.enum(IMAGE_CACHE_FILL_POLICIES),
  instances: z.number().int().min(1),
  capacityGb: z.number().finite().min(0),
  perInstanceCapacityGb: z.number().finite().min(0),
  limitGbPerInstance: z.number().finite().min(0),
  diskTbPerInstance: z.number().finite().min(0).nullable(),
  provisionedDiskTb: z.number().finite().min(0),
  fits: z.boolean(),
});

export type ImageCacheUsage = z.infer<typeof imageCacheUsageSchema>;

export const imageAppUsageSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  region: imageRegionSchema,
  delivery: z.enum(IMAGE_DELIVERY_MODES),
  buffering: z.enum(IMAGE_BUFFERING_MODES),
  retries: z.number().int().min(0),
  instances: z.number().int().min(1),
  diskTbPerInstance: z.literal(2),
  memoryGb: z.number().finite().min(0),
  networkGbitPerSec: z.number().finite().min(0),
});

export type ImageAppUsage = z.infer<typeof imageAppUsageSchema>;

export const imageProviderUsageSchema = z.strictObject({
  id: z.literal('global-blob'),
  storedOriginalTb: z.number().finite().min(0),
  storedOriginalBytes: z.number().finite().min(0),
  materializedThumbnailTb: z.literal(0),
  internalReplicationIncluded: z.literal(true),
  fixedMonthlyUsd: z.number().finite().min(0),
});

export type ImageProviderUsage = z.infer<typeof imageProviderUsageSchema>;

export const imageCapacityBreakdownSchema = z.strictObject({
  dataset: imageDatasetUsageSchema,
  metadataNodes: z.array(imageMetadataNodeUsageSchema),
  caches: z.array(imageCacheUsageSchema),
  apps: z.array(imageAppUsageSchema),
  provider: imageProviderUsageSchema,
  metadataServiceTb: z.number().finite().min(0),
  metadataPhysicalTb: z.number().finite().min(0),
  metadataProvisionedTb: z.number().finite().min(0),
  metadataLocalCopies: z.number().int().min(0),
  metadataInstances: z.number().int().min(0),
  cacheCapacityGb: z.number().finite().min(0),
  cacheInstances: z.number().int().min(0),
  appInstances: z.number().int().min(0),
  metadataCapacityOk: z.boolean(),
  cacheCapacityOk: z.boolean(),
  capacityOk: z.boolean(),
  retentionOk: z.boolean(),
  topologyComplete: z.boolean(),
  notes: z.array(z.string().min(1).max(2_000)).max(32),
});

export type ImageCapacityBreakdown = z.infer<typeof imageCapacityBreakdownSchema>;

export const imageNodeCostSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  kind: z.enum(['app', 'metadata', 'cache']),
  region: imageRegionSchema,
  instances: z.number().int().min(1),
  computeMonthlyUsd: z.number().finite().min(0),
  extraDiskTbPerInstance: z.number().finite().min(0),
  extraDiskMonthlyUsd: z.number().finite().min(0),
  /**
   * Instance RAM is included in the compute price. This field is always zero;
   * cache and metadata RAM must never be billed a second time.
   */
  memoryMonthlyUsd: z.literal(0),
  memoryIncludedInCompute: z.literal(true),
  totalMonthlyUsd: z.number().finite().min(0),
});

export type ImageNodeCost = z.infer<typeof imageNodeCostSchema>;

export const imageCostLineSchema = z.strictObject({
  id: z.string().min(1).max(128),
  category: z.enum(['fixed', 'compute', 'storage', 'traffic', 'api']),
  label: z.string().min(1).max(200),
  monthlyUsd: z.number().finite().min(0),
  nodeId: z.string().min(1).max(64).optional(),
  provenance: z.enum(['catalog', 'analytical-baseline', 'measured-run']),
});

export type ImageCostLine = z.infer<typeof imageCostLineSchema>;

export const imageCostSummarySchema = z.strictObject({
  currency: z.literal('USD'),
  pricingVersion: z.literal(IMAGE_PRICING_VERSION),
  monthlyUsd: z.number().finite().min(0),
  fixedMonthlyUsd: z.number().finite().min(0),
  controllableMonthlyUsd: z.number().finite().min(0),
  trafficMonthlyUsd: z.number().finite().min(0),
  apiMonthlyUsd: z.number().finite().min(0),
  fixed: z.strictObject({
    providerOriginalsUsd: z.number().finite().min(0),
    totalUsd: z.number().finite().min(0),
  }),
  controllable: z.strictObject({
    computeUsd: z.number().finite().min(0),
    extraDiskUsd: z.number().finite().min(0),
    totalUsd: z.number().finite().min(0),
  }),
  traffic: z.strictObject({
    clientEgressUsd: z.number().finite().min(0),
    providerRetrievalUsd: z.number().finite().min(0),
    crossRegionUsd: z.number().finite().min(0),
    totalUsd: z.number().finite().min(0),
  }),
  api: z.strictObject({
    readFeesUsd: z.number().finite().min(0),
    writeFeesUsd: z.number().finite().min(0),
    totalUsd: z.number().finite().min(0),
  }),
  daily: z.strictObject({
    clientEgressGb: z.number().finite().min(0),
    providerRetrievalGb: z.number().finite().min(0),
    crossRegionGb: z.number().finite().min(0),
    readRequests: z.number().finite().min(0),
    writeRequests: z.number().finite().min(0),
  }),
  byNode: z.array(imageNodeCostSchema),
  breakdown: z.array(imageCostLineSchema),
  budgetMonthlyUsd: z.literal(IMAGE_MONTHLY_BUDGET_USD),
  withinBudget: z.boolean(),
  provenance: z.strictObject({
    pricingVersion: z.literal(IMAGE_PRICING_VERSION),
    workloadBasis: z.literal('normal-daily-average'),
    days: z.literal(30),
    measured: z.boolean(),
    cacheHitRatioAssumed: z.number().finite().min(0).max(1),
    retryRatioAssumed: z.number().finite().min(0).max(1),
    trafficBaselineComplete: z.boolean(),
    note: z.string().min(1).max(1_000),
  }),
  notes: z.array(z.string().min(1).max(2_000)).max(32),
});

export type ImageCostSummary = z.infer<typeof imageCostSummarySchema>;

// ---------------------------------------------------------------------------
// Evaluation result
// ---------------------------------------------------------------------------

export const imageOperationCountsSchema = z.strictObject({
  offered: z.number().int().min(0),
  completed: z.number().int().min(0),
  onTime: z.number().int().min(0),
  correct: z.number().int().min(0),
  success: z.number().int().min(0),
  failed: z.number().int().min(0),
  rejected: z.number().int().min(0),
  timedOut: z.number().int().min(0),
  incorrect: z.number().int().min(0),
  stale: z.number().int().min(0),
  missingData: z.number().int().min(0),
  duplicateEffects: z.number().int().min(0),
  unfinished: z.number().int().min(0),
});

export type ImageOperationCounts = z.infer<typeof imageOperationCountsSchema>;

export const imageOperationMetricsSchema = z.strictObject({
  operation: imageBusinessOperationSchema,
  counts: imageOperationCountsSchema,
  /** Success / offered. Rejected, timed out, stale and incorrect all fail. */
  availability: z.number().finite().min(0).max(1),
  /** On time / offered, regardless of correctness. */
  timelyRatio: z.number().finite().min(0).max(1),
  /** Correct / offered, regardless of deadline. */
  correctnessRatio: z.number().finite().min(0).max(1),
  /** Successful-response percentiles only. */
  latencyP50Ms: z.number().finite().min(0),
  latencyP95Ms: z.number().finite().min(0),
  latencyP99Ms: z.number().finite().min(0),
  latencyP999Ms: z.number().finite().min(0),
  sampleCount: z.number().int().min(0),
  p999SampleCount: z.number().int().min(0),
  minimumP999Samples: z.number().int().min(0),
  p999Reliable: z.boolean(),
  queueWaitP95Ms: z.number().finite().min(0),
  bytesRead: z.number().finite().min(0),
  bytesWritten: z.number().finite().min(0),
  requestsPerSecondAvg: z.number().finite().min(0),
  errorsByCode: z.record(
    z.string().min(1).max(64),
    z.number().int().min(0),
  ),
});

export type ImageOperationMetrics = z.infer<typeof imageOperationMetricsSchema>;

export const imageFreshnessMetricsSchema = z.strictObject({
  probes: z.number().int().min(0),
  success: z.number().int().min(0),
  maxLagMs: z.number().finite().min(0).nullable(),
  p99LagMs: z.number().finite().min(0).nullable(),
  limitMs: z.number().finite().min(0),
  passed: z.boolean(),
});

export type ImageFreshnessMetrics = z.infer<typeof imageFreshnessMetricsSchema>;

export const imagePostludeMetricsSchema = z.strictObject({
  noNewOffers: z.literal(true),
  startedAtMs: z.number().finite().min(0),
  lastAckAtMs: z.number().finite().min(0).nullable(),
  endedAtMs: z.number().finite().min(0),
  maxAfterLastAckMs: z.number().int().min(0),
  committedUploads: z.number().int().min(0),
  acknowledgedUploads: z.number().int().min(0),
  lostAckCommitted: z.number().int().min(0),
  publishedUploads: z.number().int().min(0),
  unpublishedCommitted: z.number().int().min(0),
  maxPublicationLagMs: z.number().finite().min(0).nullable(),
  publicationDeadlineMs: z.number().finite().min(0),
  backgroundWorkCounted: z.literal(true),
  includedInMeasuredLoad: z.literal(false),
  passed: z.boolean(),
});

export type ImagePostludeMetrics = z.infer<typeof imagePostludeMetricsSchema>;

export const imageDataIntegrityMetricsSchema = z.strictObject({
  acknowledgedUploads: z.number().int().min(0),
  committedUploads: z.number().int().min(0),
  /** Commits whose ACK was lost; they still need publication evidence. */
  lostAckCommitted: z.number().int().min(0),
  duplicateUploads: z.number().int().min(0),
  duplicateEffects: z.number().int().min(0),
  missingSearchResults: z.number().int().min(0),
  visibilityViolations: z.number().int().min(0),
  unpublishedCommitted: z.number().int().min(0),
  publicationPassed: z.boolean(),
  passed: z.boolean(),
});

export type ImageDataIntegrityMetrics = z.infer<
  typeof imageDataIntegrityMetricsSchema
>;

export const imageScenarioWorkloadSchema = z.strictObject({
  warmupMs: z.number().int().min(0),
  measuredMs: z.number().int().min(0),
  drainMs: z.number().int().min(0),
  demandMultiplier: z.number().finite().min(1).max(4),
  offered: z.strictObject({
    upload: z.number().int().min(0),
    search: z.number().int().min(0),
    detail: z.number().int().min(0),
  }),
  sampleFactor: z.number().finite().min(1),
  eventBudget: z.number().int().min(1),
  processedEvents: z.number().int().min(0),
  exhausted: z.boolean(),
  hotKeyShare: z.number().finite().min(0).max(1),
  hotKeys: z.number().int().min(1),
  longTailKeys: z.number().int().min(1),
  recentReadProbeShare: z.number().finite().min(0).max(1),
  cacheInitialState: z.enum(['empty', 'warm']),
  matureDatasetDay: z.literal(30),
});

export type ImageScenarioWorkload = z.infer<typeof imageScenarioWorkloadSchema>;

export const imageScenarioFaultResultSchema = z.strictObject({
  kind: z.enum(['none', 'node', 'link', 'region']),
  atMeasuredMs: z.number().finite().min(0).nullable(),
  durationMs: z.number().finite().min(0).nullable(),
  target: z.string().min(1).max(96).nullable(),
  region: imageRegionSchema.nullable(),
  linkA: imageRegionSchema.nullable(),
  linkB: imageRegionSchema.nullable(),
});

export type ImageScenarioFaultResult = z.infer<
  typeof imageScenarioFaultResultSchema
>;

export const imageScenarioWindowOperationSchema = z.strictObject({
  offered: z.number().int().min(0),
  success: z.number().int().min(0),
  availability: z.number().finite().min(0).max(1),
  latencyP999Ms: z.number().finite().min(0),
  sampleCount: z.number().int().min(0),
  availabilityOk: z.boolean(),
  latencyOk: z.boolean(),
  passed: z.boolean(),
});

export type ImageScenarioWindowOperation = z.infer<
  typeof imageScenarioWindowOperationSchema
>;

export const imageScenarioWindowSchema = z.strictObject({
  fromMs: z.number().finite().min(0),
  toMs: z.number().finite().min(0),
  operations: z.strictObject({
    upload: imageScenarioWindowOperationSchema,
    search: imageScenarioWindowOperationSchema,
    detail: imageScenarioWindowOperationSchema,
  }),
  passed: z.boolean(),
});

export type ImageScenarioWindow = z.infer<typeof imageScenarioWindowSchema>;

export const imageNodeMetricsSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  kind: imageNodeKindSchema,
  label: z.string().min(1).max(80),
  region: imageRegionSchema,
  instances: z.number().int().min(1),
  healthyInstances: z.number().int().min(0),
  /**
   * Attempt-scoped traffic count with its pre-existing, unchanged scope: app
   * and metadata nodes count first-attempt routed requests including warm-up;
   * client nodes count measured (scored) offers; blob/provider nodes count
   * provider attempts including warm-up and retries. The `completed`/`errors`
   * fields below are a separate scored final-request outcome scope.
   */
  requests: z.number().int().min(0),
  /** Scored final successful requests at this node. */
  completed: z.number().int().min(0),
  /** Terminal failed outcomes attributed to this node: always rejected + timedOut. */
  errors: z.number().int().min(0),
  /**
   * Non-timeout terminal failure observed at this node. It is an attributed
   * outcome, not proof of a local admission rejection or root cause; the
   * operation-level taxonomy stays authoritative for the business reason.
   */
  rejected: z.number().int().min(0),
  /** Deadline terminal failure attributed to this node. */
  timedOut: z.number().int().min(0),
  cpuUtilizationAvg: z.number().finite().min(0),
  cpuUtilizationPeak: z.number().finite().min(0),
  memoryBytesAvg: z.number().finite().min(0),
  memoryBytesPeak: z.number().finite().min(0),
  memoryLimitBytes: z.number().finite().min(0),
  ioUtilizationAvg: z.number().finite().min(0),
  ioUtilizationPeak: z.number().finite().min(0),
  networkIngressGbitAvg: z.number().finite().min(0),
  networkIngressGbitPeak: z.number().finite().min(0),
  networkEgressGbitAvg: z.number().finite().min(0),
  networkEgressGbitPeak: z.number().finite().min(0),
  /**
   * Mean number of distinct foreground stage tasks waiting in this node's
   * attributed queue inside the measured window. Background work such as
   * metadata replication, tail-copy appends and provider-internal jobs is not
   * attributed here and is never counted twice across resources.
   */
  queueDepthAvg: z.number().finite().min(0),
  /** Highest count of the same distinct foreground waiting tasks. */
  queueDepthPeak: z.number().finite().min(0),
  /**
   * Queue wait p95 of attempts enqueued inside the measured window, including
   * attempts that were cancelled or timed out before starting.
   */
  queueWaitP95Ms: z.number().finite().min(0),
  bytesRead: z.number().finite().min(0),
  bytesWritten: z.number().finite().min(0),
  cache: z
    .strictObject({
      hits: z.number().int().min(0),
      misses: z.number().int().min(0),
      coalesced: z.number().int().min(0),
      evictions: z.number().int().min(0),
      hitRatio: z.number().finite().min(0).max(1).nullable(),
    })
    .nullable(),
  replication: z
    .strictObject({
      replicatedWrites: z.number().int().min(0),
      queuedBytes: z.number().finite().min(0),
      lagMaxMs: z.number().finite().min(0).nullable(),
    })
    .nullable(),
});

export type ImageNodeMetrics = z.infer<typeof imageNodeMetricsSchema>;

export const imagePhysicalLinkMetricsSchema = z.strictObject({
  id: z.string().min(1).max(128),
  kind: z.enum([
    'instance-nic',
    'region-pair',
    'provider-endpoint',
    'client-population-link',
    'request-access-link',
  ]),
  label: z.string().min(1).max(200),
  regionA: imageRegionSchema,
  regionB: imageRegionSchema.nullable(),
  direction: z.enum(['full-duplex', 'one-way']),
  capacityGbitPerSec: z.number().finite().min(0),
  averageUtilization: z.number().finite().min(0),
  peakUtilization: z.number().finite().min(0),
  bytesSent: z.number().finite().min(0),
  bytesReceived: z.number().finite().min(0),
  transfers: z.number().int().min(0),
  queueWaitP95Ms: z.number().finite().min(0),
});

export type ImagePhysicalLinkMetrics = z.infer<
  typeof imagePhysicalLinkMetricsSchema
>;

export const imageScenarioResultSchema = z.strictObject({
  name: imageScenarioNameSchema,
  label: z.string().min(1).max(80),
  passed: z.boolean(),
  fault: imageScenarioFaultResultSchema,
  workload: imageScenarioWorkloadSchema,
  operations: z.strictObject({
    upload: imageOperationMetricsSchema,
    search: imageOperationMetricsSchema,
    detail: imageOperationMetricsSchema,
  }),
  freshness: imageFreshnessMetricsSchema,
  dataIntegrity: imageDataIntegrityMetricsSchema,
  /** No-new-offers consistency/publication window after request drain. */
  postlude: imagePostludeMetricsSchema,
  /** Present only for incident cases: measured fault window 20..40 s. */
  incidentWindow: imageScenarioWindowSchema.nullable(),
  /** Present only for incident cases: final 10 s recovery window. */
  recoveryWindow: imageScenarioWindowSchema.nullable(),
  nodes: z.array(imageNodeMetricsSchema),
  links: z.array(imagePhysicalLinkMetricsSchema),
  checks: z.array(imageCheckSchema).min(1),
  diagnostics: z.array(imageDiagnosticSchema),
});

export type ImageScenarioResult = z.infer<typeof imageScenarioResultSchema>;

export const imageEvaluationMetaSchema = z.strictObject({
  schemaVersion: z.literal(IMAGE_SCHEMA_VERSION),
  modelVersion: z.literal(IMAGE_MODEL_VERSION),
  contentVersion: z.literal(IMAGE_CONTENT_VERSION),
  pricingVersion: z.literal(IMAGE_PRICING_VERSION),
  levelId: z.literal(IMAGE_LEVEL_ID),
  seed: IMAGE_SEED_SCHEMA,
  graphDigest: z.string().min(1).max(64).nullable(),
  requestedScenarios: z.array(imageScenarioNameSchema).min(1).max(IMAGE_REQUIRED_SCENARIOS.length),
  requiredScenarios: z.array(imageScenarioNameSchema).length(IMAGE_REQUIRED_SCENARIOS.length),
  qualification: z.boolean(),
  evaluationKind: z.enum(['exploratory', 'qualification']),
  datasetDay: z.literal(30),
});

export type ImageEvaluationMeta = z.infer<typeof imageEvaluationMetaSchema>;

export const imageIncompleteReasonSchema = z.strictObject({
  code: z.string().min(1).max(96),
  message: z.string().min(1).max(2_000),
});

export type ImageIncompleteReason = z.infer<
  typeof imageIncompleteReasonSchema
>;

const imageEvaluationBaseShape = {
  meta: imageEvaluationMetaSchema,
  issues: z.array(imageIssueSchema),
  diagnostics: z.array(imageDiagnosticSchema),
  checks: z.array(imageCheckSchema),
  capacity: imageCapacityBreakdownSchema.nullable(),
  cost: imageCostSummarySchema.nullable(),
  assumptions: z.array(z.string().min(1).max(2_000)).max(64),
} as const;

export const imageEvaluationInvalidSchema = z.strictObject({
  status: z.literal('invalid'),
  passed: z.literal(false),
  ...imageEvaluationBaseShape,
  scenarios: z.array(imageScenarioResultSchema).max(0),
});

export const imageEvaluationIncompleteSchema = z.strictObject({
  status: z.literal('incomplete'),
  passed: z.literal(false),
  ...imageEvaluationBaseShape,
  scenarios: z.array(imageScenarioResultSchema).max(IMAGE_REQUIRED_SCENARIOS.length),
  incompleteReason: imageIncompleteReasonSchema,
});

export const imageEvaluationCompleteSchema = z.strictObject({
  status: z.literal('complete'),
  passed: z.boolean(),
  ...imageEvaluationBaseShape,
  scenarios: z.array(imageScenarioResultSchema).min(1).max(IMAGE_REQUIRED_SCENARIOS.length),
});

export const imageEvaluationCoreSchema = z.discriminatedUnion('status', [
  imageEvaluationInvalidSchema,
  imageEvaluationIncompleteSchema,
  imageEvaluationCompleteSchema,
]);

/**
 * Runtime result contract. In addition to the shape, `passed: true` is only
 * allowed for a complete qualification run covering every required scenario.
 * A scenario subset is exploratory and cannot pass. Calibration seeds are separate replay runs.
 */
export const imageEvaluationSchema = imageEvaluationCoreSchema.superRefine(
  (result, context) => {
    if (result.meta.qualification !== (result.meta.evaluationKind === 'qualification')) {
      context.addIssue({
        code: 'custom',
        path: ['meta', 'qualification'],
        message:
          'meta.qualification must be true exactly when meta.evaluationKind is "qualification".',
      });
    }
    if (
      !IMAGE_REQUIRED_SCENARIOS.every(
        (name, index) => result.meta.requiredScenarios[index] === name,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['meta', 'requiredScenarios'],
        message:
          'meta.requiredScenarios must contain the frozen required scenarios in order.',
      });
    }
    if (
      result.meta.qualification &&
      !IMAGE_REQUIRED_SCENARIOS.every((name) =>
        result.meta.requestedScenarios.includes(name),
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['meta', 'requestedScenarios'],
        message:
          'A qualification evaluation must request every required scenario.',
      });
    }
    if (result.passed) {
      if (result.meta.graphDigest === null) {
        context.addIssue({ code: 'custom', path: ['meta', 'graphDigest'], message: 'A passing result must identify its input graph.' });
      }
      const capacity = result.capacity;
      if (!capacity || !capacity.capacityOk || !capacity.metadataCapacityOk ||
          !capacity.cacheCapacityOk || !capacity.retentionOk || !capacity.topologyComplete ||
          capacity.metadataNodes.length === 0 ||
          capacity.metadataNodes.some((node) => !node.capacityOk || !node.divisible || !node.residentCacheFits) ||
          capacity.caches.some((cache) => !cache.fits)) {
        context.addIssue({ code: 'custom', path: ['capacity'], message: 'A passing result requires successful storage, memory, retention and topology checks.' });
      }
      if (!result.cost || !result.cost.withinBudget ||
          result.cost.monthlyUsd > IMAGE_MONTHLY_BUDGET_USD || !result.cost.provenance.measured) {
        context.addIssue({ code: 'custom', path: ['cost'], message: 'A passing result requires measured cost within the frozen budget.' });
      }
      if (result.status !== 'complete') {
        context.addIssue({
          code: 'custom',
          path: ['passed'],
          message: 'Only a complete evaluation can pass.',
        });
        return;
      }
      if (!result.meta.qualification) {
        context.addIssue({
          code: 'custom',
          path: ['passed'],
          message:
            'An exploratory evaluation with a subset of scenarios can never report an overall pass.',
        });
      }
      for (const name of IMAGE_REQUIRED_SCENARIOS) {
        const scenario = result.scenarios.find((item) => item.name === name);
        if (!scenario) {
          context.addIssue({
            code: 'custom',
            path: ['scenarios'],
            message: `Required scenario "${name}" is missing.`,
          });
          continue;
        }
        if (name.startsWith('region-') &&
            (scenario.fault.kind !== 'region' || scenario.fault.region !== name.split('-')[1])) {
          context.addIssue({ code: 'custom', path: ['scenarios'], message: `Case ${name} must exercise its declared region.` });
        }
        if (!scenario.passed) {
          context.addIssue({
            code: 'custom',
            path: ['scenarios'],
            message: `Required scenario "${name}" did not pass.`,
          });
        }
        const incident =
          name === 'node-failure' ||
          name === 'link-failure' ||
          name.startsWith('region-');
        if (incident && (!scenario.incidentWindow || !scenario.recoveryWindow)) {
          context.addIssue({
            code: 'custom',
            path: ['scenarios'],
            message: `Incident scenario "${name}" needs both incident and recovery window evidence.`,
          });
        }
        if (!scenario.freshness.passed) {
          context.addIssue({
            code: 'custom',
            path: ['scenarios'],
            message: `Scenario "${name}" has no passing freshness evidence.`,
          });
        }
        if (!scenario.dataIntegrity.passed) {
          context.addIssue({
            code: 'custom',
            path: ['scenarios'],
            message: `Scenario "${name}" has no passing data-integrity evidence.`,
          });
        }
        if (!scenario.postlude.passed || scenario.postlude.unpublishedCommitted > 0) {
          context.addIssue({
            code: 'custom',
            path: ['scenarios'],
            message: `Scenario "${name}" has an unpublished committed record or a failing consistency postlude.`,
          });
        }
        if (
          scenario.checks.some(
            (check) => check.severity === 'required' && !check.passed,
          )
        ) {
          context.addIssue({
            code: 'custom',
            path: ['scenarios'],
            message: `Scenario "${name}" has a failed required check.`,
          });
        }
        if (
          !scenario.checks.some(
            (check) => check.severity === 'required' && check.passed,
          )
        ) {
          context.addIssue({
            code: 'custom',
            path: ['scenarios'],
            message: `Scenario "${name}" has no passing required gate.`,
          });
        }
      }
      if (
        !result.checks.some(
          (check) =>
            check.id === 'qualification_scenarios' &&
            check.passed &&
            check.severity === 'required',
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['checks'],
          message:
            'A passing result needs the required qualification_scenarios check.',
        });
      }
      const requiredChecks = result.checks.filter(
        (check) => check.severity === 'required',
      );
      if (requiredChecks.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['checks'],
          message: 'A passing result needs at least one required gate.',
        });
      }
      if (requiredChecks.some((check) => !check.passed)) {
        context.addIssue({
          code: 'custom',
          path: ['checks'],
          message: 'A passing result cannot contain a failed required gate.',
        });
      }
    }
    if (result.status === 'incomplete' && result.passed) {
      context.addIssue({
        code: 'custom',
        path: ['passed'],
        message: 'An incomplete evaluation can never pass.',
      });
    }
    if (result.status === 'complete') {
      for (const name of result.meta.requestedScenarios) {
        if (!result.scenarios.some((scenario) => scenario.name === name)) {
          context.addIssue({
            code: 'custom',
            path: ['scenarios'],
            message: `A complete evaluation is missing the requested scenario "${name}".`,
          });
        }
      }
    }
    const names = result.meta.requestedScenarios;
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: 'custom',
        path: ['meta', 'requestedScenarios'],
        message: 'requestedScenarios must not contain duplicates.',
      });
    }
    const scenarioNames = result.scenarios.map((scenario) => scenario.name);
    if (new Set(scenarioNames).size !== scenarioNames.length) {
      context.addIssue({
        code: 'custom',
        path: ['scenarios'],
        message: 'Each scenario may appear at most once.',
      });
    }
    for (const scenario of result.scenarios) {
      if (!result.meta.requestedScenarios.includes(scenario.name)) {
        context.addIssue({
          code: 'custom',
          path: ['scenarios'],
          message: `Scenario "${scenario.name}" was not requested.`,
        });
      }
      const postlude = scenario.postlude;
      const integrity = scenario.dataIntegrity;
      if (
        postlude.committedUploads !== integrity.committedUploads ||
        postlude.acknowledgedUploads !== integrity.acknowledgedUploads ||
        postlude.lostAckCommitted !== integrity.lostAckCommitted ||
        postlude.unpublishedCommitted !== integrity.unpublishedCommitted
      ) {
        context.addIssue({
          code: 'custom',
          path: ['scenarios'],
          message: `Scenario "${scenario.name}" postlude and data-integrity upload counts disagree.`,
        });
      }
      if (integrity.publicationPassed !== postlude.passed) {
        context.addIssue({
          code: 'custom',
          path: ['scenarios'],
          message: `Scenario "${scenario.name}" publication flag disagrees with the postlude.`,
        });
      }
      if (
        postlude.publishedUploads + postlude.unpublishedCommitted !==
        postlude.committedUploads
      ) {
        context.addIssue({
          code: 'custom',
          path: ['scenarios'],
          message: `Scenario "${scenario.name}" publication counts do not balance.`,
        });
      }
      if (postlude.lostAckCommitted > postlude.committedUploads) {
        context.addIssue({
          code: 'custom',
          path: ['scenarios'],
          message: `Scenario "${scenario.name}" has more lost-ACK commits than commits.`,
        });
      }
      for (const operation of IMAGE_BUSINESS_OPERATIONS) {
        const metrics = scenario.operations[operation];
        const counts = metrics.counts;
        const push = (message: string): void => {
          context.addIssue({
            code: 'custom',
            path: ['scenarios'],
            message: `Scenario "${scenario.name}" ${operation}: ${message}`,
          });
        };
        const expectedAvailability =
          counts.offered === 0 ? 0 : counts.success / counts.offered;
        const expectedTimely =
          counts.offered === 0 ? 0 : counts.onTime / counts.offered;
        const expectedCorrect =
          counts.offered === 0 ? 0 : counts.correct / counts.offered;
        if (counts.success > counts.offered) {
          push('success cannot exceed offered.');
        }
        if (counts.onTime > counts.offered || counts.correct > counts.offered) {
          push('on-time and correct counts cannot exceed offered.');
        }
        if (counts.success > counts.onTime || counts.success > counts.correct) {
          push('success must be both on time and correct.');
        }
        if (counts.failed !== counts.offered - counts.success) {
          push('failed must equal offered minus success.');
        }
        if (metrics.sampleCount !== counts.success) {
          push('sampleCount must equal the successful response count.');
        }
        if (metrics.p999SampleCount > metrics.sampleCount) {
          push('p999SampleCount cannot exceed sampleCount.');
        }
        if (
          metrics.p999Reliable !==
          (metrics.p999SampleCount >= metrics.minimumP999Samples)
        ) {
          push('p999Reliable must match the sample-count threshold.');
        }
        if (Math.abs(metrics.availability - expectedAvailability) > 1e-9) {
          push('availability must equal success / offered.');
        }
        if (Math.abs(metrics.timelyRatio - expectedTimely) > 1e-9) {
          push('timelyRatio must equal onTime / offered.');
        }
        if (Math.abs(metrics.correctnessRatio - expectedCorrect) > 1e-9) {
          push('correctnessRatio must equal correct / offered.');
        }
        if (counts.success > 0 && metrics.sampleCount === 0) {
          push('a successful operation cannot have no latency samples.');
        }
      }
    }
  },
);

export type ImageEvaluation = z.infer<typeof imageEvaluationSchema>;

export type ImageEvaluationStatus = ImageEvaluation['status'];

export interface ImageRunOptions {
  /** Deterministic workload seed. Defaults to `IMAGE_LEVEL.defaultSeed`. */
  readonly seed: number;
  /**
   * Investigation only. Omit for the full qualification set. A run with fewer
   * than all required scenarios can never report an overall pass.
   */
  readonly scenarios?: readonly ImageScenarioName[];
  /** Optional synchronous progress callback; never used for control flow. */
  readonly onProgress?: (progress: ImageProgress) => void;
  /**
   * Optional observational traffic frame callback. Frames are never part of
   * the evaluation, a saved graph or the JSON API output.
   */
  readonly onTraffic?: TrafficObserver;
}

export type ImageEvaluationPhase =
  | 'validate'
  | 'capacity'
  | 'workload'
  | 'simulate'
  | 'done';

export interface ImageProgress {
  readonly phase: ImageEvaluationPhase;
  readonly scenario: ImageScenarioName | null;
  readonly completed: number;
  readonly total: number;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// JSON Schema helpers
// ---------------------------------------------------------------------------

/**
 * Critical pass rule for JSON Schema consumers (Ajv). Zod refinements are not
 * representable in `z.toJSONSchema`, so this conditional is appended
 * explicitly. It mirrors the runtime rule: a pass requires a complete,
 * qualification run with every required scenario passing.
 */
function passingQualificationConditional(): Record<string, unknown> {
  const operationEvidence = {
    allOf: [
      {
        if: {
          required: ['counts'],
          properties: {
            counts: {
              required: ['success'],
              properties: { success: { minimum: 1 } },
            },
          },
        },
        then: {
          required: ['sampleCount'],
          properties: {
            sampleCount: { minimum: 1 },
            availability: { exclusiveMinimum: 0 },
            timelyRatio: { exclusiveMinimum: 0 },
            correctnessRatio: { exclusiveMinimum: 0 },
          },
        },
      },
      {
        if: {
          required: ['p999SampleCount'],
          properties: { p999SampleCount: { minimum: 1 } },
        },
        then: {
          required: ['sampleCount'],
          properties: { sampleCount: { minimum: 1 } },
        },
      },
    ],
  } as const;
  return {
    if: {
      properties: { passed: { const: true } },
      required: ['passed'],
    },
    then: {
      required: ['status', 'meta', 'scenarios', 'checks', 'capacity', 'cost'],
      properties: {
        status: { const: 'complete' },
        capacity: {
          type: 'object',
          required: ['capacityOk', 'metadataCapacityOk', 'cacheCapacityOk', 'retentionOk', 'topologyComplete', 'metadataNodes', 'caches'],
          properties: {
            capacityOk: { const: true }, metadataCapacityOk: { const: true },
            cacheCapacityOk: { const: true }, retentionOk: { const: true }, topologyComplete: { const: true },
            metadataNodes: { type: 'array', minItems: 1, items: {
              type: 'object', required: ['capacityOk', 'divisible', 'residentCacheFits'],
              properties: { capacityOk: { const: true }, divisible: { const: true }, residentCacheFits: { const: true } },
            } },
            caches: { type: 'array', items: { type: 'object', required: ['fits'], properties: { fits: { const: true } } } },
          },
        },
        cost: {
          type: 'object', required: ['withinBudget', 'monthlyUsd', 'budgetMonthlyUsd', 'provenance'],
          properties: {
            withinBudget: { const: true }, monthlyUsd: { maximum: IMAGE_MONTHLY_BUDGET_USD },
            budgetMonthlyUsd: { const: IMAGE_MONTHLY_BUDGET_USD },
            provenance: { type: 'object', required: ['measured'], properties: { measured: { const: true } } },
          },
        },
        meta: {
          required: [
            'qualification',
            'requestedScenarios',
            'requiredScenarios',
            'graphDigest',
          ],
          properties: {
            graphDigest: { type: 'string', minLength: 1 },
            qualification: { const: true },
            requestedScenarios: {
              allOf: IMAGE_REQUIRED_SCENARIOS.map((name) => ({
                contains: { const: name },
              })),
            },
            requiredScenarios: {
              minItems: IMAGE_REQUIRED_SCENARIOS.length,
              maxItems: IMAGE_REQUIRED_SCENARIOS.length,
              prefixItems: IMAGE_REQUIRED_SCENARIOS.map((name) => ({
                const: name,
              })),
            },
          },
        },
        scenarios: {
          minItems: IMAGE_REQUIRED_SCENARIOS.length,
          items: {
            type: 'object',
            required: ['operations'],
            properties: {
              operations: {
                type: 'object',
                required: ['upload', 'search', 'detail'],
                properties: {
                  upload: operationEvidence,
                  search: operationEvidence,
                  detail: operationEvidence,
                },
              },
            },
          },
          allOf: [
            ...IMAGE_REQUIRED_SCENARIOS.map((name) => ({
              contains: {
                type: 'object',
                required: [
                  'name',
                  'passed',
                  'freshness',
                  'dataIntegrity',
                  'postlude',
                  'checks',
                ],
                properties: {
                  name: { const: name },
                  passed: { const: true },
                  ...(name.startsWith('region-') ? { fault: {
                    type: 'object', required: ['kind', 'region'],
                    properties: { kind: { const: 'region' }, region: { const: name.split('-')[1] } },
                  } } : {}),
                  freshness: {
                    type: 'object',
                    required: ['passed'],
                    properties: { passed: { const: true } },
                  },
                  dataIntegrity: {
                    type: 'object',
                    required: ['passed'],
                    properties: { passed: { const: true } },
                  },
                  postlude: {
                    type: 'object',
                    required: ['passed', 'unpublishedCommitted'],
                    properties: {
                      passed: { const: true },
                      unpublishedCommitted: { const: 0 },
                    },
                  },
                  checks: {
                    type: 'array',
                    minItems: 1,
                    contains: {
                      type: 'object',
                      required: ['severity', 'passed'],
                      properties: {
                        severity: { const: 'required' },
                        passed: { const: true },
                      },
                    },
                    not: {
                      contains: {
                        type: 'object',
                        required: ['severity', 'passed'],
                        properties: {
                          severity: { const: 'required' },
                          passed: { const: false },
                        },
                      },
                    },
                  },
                },
              },
            })),
            ...IMAGE_REQUIRED_SCENARIOS.filter((name) => name !== 'normal' && name !== 'peak').map(
              (name) => ({
                contains: {
                  type: 'object',
                  required: [
                    'name',
                    'incidentWindow',
                    'recoveryWindow',
                  ],
                  properties: {
                    name: { const: name },
                    incidentWindow: { type: 'object' },
                    recoveryWindow: { type: 'object' },
                  },
                },
              }),
            ),
          ],
        },
        checks: {
          minItems: 1,
          contains: {
            type: 'object',
            required: ['id', 'passed', 'severity'],
            properties: {
              id: { const: 'qualification_scenarios' },
              passed: { const: true },
              severity: { const: 'required' },
            },
          },
          not: {
            contains: {
              type: 'object',
              required: ['severity', 'passed'],
              properties: {
                severity: { const: 'required' },
                passed: { const: false },
              },
            },
          },
        },
      },
    },
  };
}

export function imageEvaluationJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(imageEvaluationCoreSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id: 'https://system-design-game.local/schemas/image-atlas-result.json',
    title: 'Image Atlas evaluation result',
    allOf: [passingQualificationConditional()],
  };
}

export function parseImageEvaluation(
  input: unknown,
): ImageParseResult<ImageEvaluation> {
  const parsed = imageEvaluationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      value: null,
      issues: imageIssuesFromZod(parsed.error),
    };
  }
  return { ok: true, value: parsed.data, issues: [] };
}

/** Stable result status list for discovery payloads. */
export const IMAGE_EVALUATION_STATUSES = [
  'complete',
  'invalid',
  'incomplete',
] as const;
