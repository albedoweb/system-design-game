import {
  PARCEL_PRICING_VERSION,
  PARCEL_SCHEMA_VERSION,
  type ParcelCatalog,
  type ParcelNodeConfig,
  type ParcelNodeKind,
  type ParcelNodeKindSpec,
  type ParcelNodeSize,
} from './contracts';

const sizes: readonly ParcelNodeSize[] = ['small', 'medium', 'large'];

function defaults(config: Partial<ParcelNodeConfig>): ParcelNodeConfig {
  return {
    size: config.size ?? 'medium',
    ...(config.storageTb === undefined ? {} : { storageTb: config.storageTb }),
    ...(config.index === undefined ? {} : { index: config.index }),
    ...(config.partition === undefined ? {} : { partition: config.partition }),
    ...(config.latestStatus === undefined
      ? {}
      : { latestStatus: config.latestStatus }),
    ...(config.rollups === undefined ? {} : { rollups: config.rollups }),
    ...(config.retentionYears === undefined
      ? {}
      : { retentionYears: config.retentionYears }),
    ...(config.batchIntervalMs === undefined
      ? {}
      : { batchIntervalMs: config.batchIntervalMs }),
    ...(config.compression === undefined
      ? {}
      : { compression: config.compression }),
    ...(config.columnProjection === undefined
      ? {}
      : { columnProjection: config.columnProjection }),
  };
}

function nodeSpec(
  kind: ParcelNodeKind,
  label: string,
  allowedSizes: readonly ParcelNodeSize[],
  config: Partial<ParcelNodeConfig>,
  notes: string,
): ParcelNodeKindSpec {
  return {
    kind,
    label,
    durable: kind === 'sql' || kind === 'kv',
    storage: kind === 'sql' || kind === 'kv' || kind === 'columnar',
    allowedSizes,
    defaultSize: config.size ?? 'medium',
    defaults: defaults(config),
    notes,
  };
}

const nodeSpecs: Record<ParcelNodeKind, ParcelNodeKindSpec> = {
  client: nodeSpec(
    'client',
    'Client',
    ['small'],
    { size: 'small' },
    'Traffic source. Exactly one client is required.',
  ),
  app: nodeSpec(
    'app',
    'Application',
    sizes,
    { size: 'medium' },
    'Owns the four operation routes. Scale with the size selector.',
  ),
  sql: nodeSpec(
    'sql',
    'SQL store',
    sizes,
    {
      size: 'medium',
      storageTb: 1,
      index: 'parcel',
      partition: 'none',
      latestStatus: true,
      rollups: false,
      retentionYears: 1,
      compression: 'none',
    },
    'Durable row store. Parcel index supports history; parcel-warehouse index supports reports.',
  ),
  kv: nodeSpec(
    'kv',
    'KV store',
    sizes,
    {
      size: 'medium',
      storageTb: 1,
      partition: 'none',
      latestStatus: true,
      rollups: false,
      retentionYears: 1,
      compression: 'none',
    },
    'Durable parcel-bucket store. Buckets make history reads key lookups; rollups make reports cheap.',
  ),
  columnar: nodeSpec(
    'columnar',
    'Columnar analytics',
    sizes,
    {
      size: 'medium',
      storageTb: 1,
      partition: 'month',
      rollups: false,
      retentionYears: 1,
      batchIntervalMs: 1000,
      compression: 'zstd',
      columnProjection: true,
    },
    'Analytics projection fed by asynchronous replication. Monthly partitions and column projection matter.',
  ),
};

/**
 * Conditional in-game prices and coefficients. These are not vendor claims.
 * Calibration fixtures and the summary in `fixtures/parcel/` are generated
 * from this catalog with the real evaluator.
 */
export const PARCEL_CATALOG: ParcelCatalog = {
  schemaVersion: PARCEL_SCHEMA_VERSION,
  pricingVersion: PARCEL_PRICING_VERSION,
  currency: 'USD',
  priceNote:
    'Conditional in-game prices. They are calibrated for the teaching model and are not real vendor quotes.',
  hardware: {
    small: {
      size: 'small',
      cpuCores: 2,
      memoryGb: 8,
      diskMbps: 120,
      diskIops: 3_000,
      networkMbps: 1_000,
      ioLanes: 1,
      networkLanes: 2,
      hourlyUsd: 0.045,
    },
    medium: {
      size: 'medium',
      cpuCores: 8,
      memoryGb: 32,
      diskMbps: 500,
      diskIops: 15_000,
      networkMbps: 5_000,
      ioLanes: 2,
      networkLanes: 4,
      hourlyUsd: 0.22,
    },
    large: {
      size: 'large',
      cpuCores: 32,
      memoryGb: 128,
      diskMbps: 2_000,
      diskIops: 60_000,
      networkMbps: 20_000,
      ioLanes: 4,
      networkLanes: 8,
      hourlyUsd: 0.85,
    },
  },
  storage: {
    priceUsdPerTbMonth: 9.5,
    billingHoursPerMonth: 730,
    tcoMonths: 60,
    note:
      'Provisioned storage is priced once per physical copy. Capacity is fixed for the whole five-year TCO window.',
  },
  nodes: nodeSpecs,
  service: {
    clientLatencyMs: 8,
    appCpuMsPerRequest: 0.06,
    appCpuMsPerReport: 0.4,
    ingest: {
      baseCpuMsPerEvent: 0.025,
      durabilityCpuMsPerEvent: 0.02,
      latestCpuMsPerEvent: 0.004,
      rollupCpuMsPerEvent: 0.004,
      parcelIndexCpuMsPerEvent: 0.003,
      warehouseIndexCpuMsPerEvent: 0.005,
      ioOpsPerEvent: 1.2,
    },
    status: {
      latestCpuMs: 0.03,
      scanCpuMsPerEvent: 0.0035,
      probeIoOps: 1,
    },
    history: {
      eventCpuMs: 0.0045,
      bucketIoOps: 1,
    },
    report: {
      rollupCpuMsPerRow: 0.0035,
      indexedCpuMsPerRow: 0.0012,
      columnarCpuMsPerRow: 0.0007,
      scanCpuMsPerRow: 0.0015,
      rollupIoOps: 8,
      scanIoOpsPerKRow: 0.5,
      rollupRowsPerReport: 720,
    },
    replication: {
      sourceCpuMsPerEvent: 0.003,
    },
    compressionCpuMsPerKb: {
      none: 0,
      lz4: 0.0015,
      zstd: 0.0035,
    },
    queueLimitPerCore: 500,
    columnarClusterCpuMsPerEvent: 0.002,
  },
  storageModel: {
    eventRowOverheadBytes: 32,
    latestRowBytes: 320,
    rollupRowBytes: 96,
    parcelIndexBytesPerParcel: 40,
    warehouseIndexBytesPerEvent: 32,
    kvBucketOverheadBytesPerParcel: 48,
    columnarRowOverheadBytes: 4,
    columnarProjectionBytes: 64,
    columnarWarehouseClusterBytesPerEvent: 8,
    compressionFactor: {
      none: 1,
      lz4: 0.62,
      zstd: 0.42,
    },
    indexWriteAmplification: 1,
  },
};

/** Deep-cloned catalog for callers that need to inspect or render it safely. */
export function cloneParcelCatalog(): ParcelCatalog {
  return JSON.parse(JSON.stringify(PARCEL_CATALOG)) as ParcelCatalog;
}
