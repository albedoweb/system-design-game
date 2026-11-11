import { PARCEL_CATALOG, cloneParcelCatalog } from './catalog';
import { PARCEL_LEVEL } from './level';
import {
  PARCEL_MAX_SEED,
  PARCEL_LEVEL_ID,
  PARCEL_SCHEMA_VERSION,
  PARCEL_BUSINESS_OPERATIONS,
  PARCEL_NODE_KINDS,
  PARCEL_OPERATIONS,
  PARCEL_REQUIRED_HORIZONS,
  PARCEL_STORE_KINDS,
  type ParcelCatalog,
  type ParcelLevel,
  type ParcelNodeKind,
} from './contracts';

/**
 * Machine-readable limits shared by the parser, the CLI schema command and
 * the backend adapter. There is no second copy of these rules: the parser
 * imports the same numbers where possible.
 */
export const PARCEL_COMPONENT_LIMITS = {
  maxNodes: 32,
  maxEdges: 64,
  maxDocumentBytes: 1_000_000,
  idPattern: '^[A-Za-z0-9._:-]{1,64}$',
  labelMaxLength: 80,
  position: { min: -10_000, max: 10_000 },
  storageTb: { min: 1, max: 256 },
  retentionYears: { min: 1, max: 5 },
  batchIntervalMs: { min: 0, max: 5_000 },
  seed: { min: 0, max: PARCEL_MAX_SEED },
  sampleFactor: PARCEL_LEVEL.workload.sampleFactor,
  queueLimitPerCore: PARCEL_CATALOG.service.queueLimitPerCore,
  eventBudgetPerHorizon: 2_500_000,
  reports: PARCEL_LEVEL.workload.reportScheduleMs.length,
  warehouses: PARCEL_LEVEL.workload.warehouseCount,
  sampleKeyspace: PARCEL_LEVEL.workload.sampledParcelKeys,
} as const;

const CONFIG_SCHEMA: Record<ParcelNodeKind, Record<string, unknown>> = {
  client: {
    type: 'object',
    additionalProperties: false,
    required: ['size'],
    properties: { size: { const: 'small' } },
  },
  app: {
    type: 'object',
    additionalProperties: false,
    required: ['size'],
    properties: { size: { enum: ['small', 'medium', 'large'] } },
  },
  sql: {
    type: 'object',
    additionalProperties: false,
    required: ['size'],
    properties: {
      size: { enum: ['small', 'medium', 'large'] },
      storageTb: {
        type: 'number',
        minimum: PARCEL_COMPONENT_LIMITS.storageTb.min,
        maximum: PARCEL_COMPONENT_LIMITS.storageTb.max,
      },
      index: { enum: ['none', 'parcel', 'parcel-warehouse'] },
      partition: { enum: ['none', 'month'] },
      latestStatus: { type: 'boolean' },
      rollups: { type: 'boolean' },
      retentionYears: {
        type: 'integer',
        minimum: PARCEL_COMPONENT_LIMITS.retentionYears.min,
        maximum: PARCEL_COMPONENT_LIMITS.retentionYears.max,
      },
      compression: { enum: ['none', 'lz4', 'zstd'] },
    },
  },
  kv: {
    type: 'object',
    additionalProperties: false,
    required: ['size'],
    properties: {
      size: { enum: ['small', 'medium', 'large'] },
      storageTb: {
        type: 'number',
        minimum: PARCEL_COMPONENT_LIMITS.storageTb.min,
        maximum: PARCEL_COMPONENT_LIMITS.storageTb.max,
      },
      partition: { enum: ['none', 'month'] },
      latestStatus: { type: 'boolean' },
      rollups: { type: 'boolean' },
      retentionYears: {
        type: 'integer',
        minimum: PARCEL_COMPONENT_LIMITS.retentionYears.min,
        maximum: PARCEL_COMPONENT_LIMITS.retentionYears.max,
      },
      compression: { enum: ['none', 'lz4', 'zstd'] },
    },
  },
  columnar: {
    type: 'object',
    additionalProperties: false,
    required: ['size'],
    properties: {
      size: { enum: ['small', 'medium', 'large'] },
      storageTb: {
        type: 'number',
        minimum: PARCEL_COMPONENT_LIMITS.storageTb.min,
        maximum: PARCEL_COMPONENT_LIMITS.storageTb.max,
      },
      partition: { enum: ['none', 'month'] },
      rollups: { type: 'boolean' },
      retentionYears: {
        type: 'integer',
        minimum: PARCEL_COMPONENT_LIMITS.retentionYears.min,
        maximum: PARCEL_COMPONENT_LIMITS.retentionYears.max,
      },
      batchIntervalMs: {
        type: 'integer',
        minimum: PARCEL_COMPONENT_LIMITS.batchIntervalMs.min,
        maximum: PARCEL_COMPONENT_LIMITS.batchIntervalMs.max,
      },
      compression: { enum: ['none', 'lz4', 'zstd'] },
      columnProjection: { type: 'boolean' },
    },
  },
};

const NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'label', 'position', 'config'],
  properties: {
    id: { type: 'string', pattern: PARCEL_COMPONENT_LIMITS.idPattern },
    kind: { enum: [...PARCEL_NODE_KINDS] },
    label: { type: 'string', minLength: 1, maxLength: 80 },
    position: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: {
        x: {
          type: 'number',
          minimum: -10_000,
          maximum: 10_000,
        },
        y: {
          type: 'number',
          minimum: -10_000,
          maximum: 10_000,
        },
      },
    },
    config: { type: 'object' },
  },
  allOf: PARCEL_NODE_KINDS.map((kind) => ({
    if: { properties: { kind: { const: kind } } },
    then: {
      properties: { config: CONFIG_SCHEMA[kind] },
    },
  })),
};

/** JSON Schema for an imported Parcel Pulse graph document. */
export function parcelGraphJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://system-design-game.local/schemas/parcel-pulse-graph.json',
    title: 'Parcel Pulse graph',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'levelId', 'nodes', 'edges'],
    properties: {
      schemaVersion: { const: PARCEL_SCHEMA_VERSION },
      levelId: { const: PARCEL_LEVEL_ID },
      name: { type: 'string', maxLength: 80 },
      nodes: {
        type: 'array',
        maxItems: PARCEL_COMPONENT_LIMITS.maxNodes,
        items: NODE_SCHEMA,
      },
      edges: {
        type: 'array',
        maxItems: PARCEL_COMPONENT_LIMITS.maxEdges,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'source', 'target', 'operation'],
          properties: {
            id: {
              type: 'string',
              pattern: PARCEL_COMPONENT_LIMITS.idPattern,
            },
            source: {
              type: 'string',
              pattern: PARCEL_COMPONENT_LIMITS.idPattern,
            },
            target: {
              type: 'string',
              pattern: PARCEL_COMPONENT_LIMITS.idPattern,
            },
            operation: { enum: [...PARCEL_OPERATIONS] },
          },
        },
      },
    },
    'x-semantic-rules': [
      'Exactly one client and one app node.',
      'Client sends exactly one traffic edge to app.',
      'App has exactly one ingest, status, history and report route.',
      'Ingest must target a durable SQL or KV primary.',
      'Replication starts at the ingest primary, one hop, no cycles.',
      'Status/history/report targets must be fed by ingest or replication.',
      'Status targets must be SQL or KV; columnar cannot serve per-parcel status.',
      'Year 5 requires 5 years of raw history on the primary and history store.',
      'Unused nodes are allowed but still charged.',
    ],
  };
}

/** Catalog plus machine-readable constraints for adapters and UIs. */
export function parcelCatalogPayload(): {
  catalog: ParcelCatalog;
  componentLimits: typeof PARCEL_COMPONENT_LIMITS;
  businessOperations: readonly string[];
  operations: readonly string[];
  horizons: readonly number[];
} {
  return {
    catalog: cloneParcelCatalog(),
    componentLimits: PARCEL_COMPONENT_LIMITS,
    businessOperations: [...PARCEL_BUSINESS_OPERATIONS],
    operations: [...PARCEL_OPERATIONS],
    horizons: [...PARCEL_REQUIRED_HORIZONS],
  };
}

export function parcelLevelPayload(): ParcelLevel {
  return JSON.parse(JSON.stringify(PARCEL_LEVEL)) as ParcelLevel;
}

const nonNegative = { type: 'number', minimum: 0 } as const;
const nonNegativeInteger = { type: 'integer', minimum: 0 } as const;

const ISSUE_SCHEMA = {
  type: 'object',
  required: ['severity', 'code', 'message'],
  properties: {
    severity: { enum: ['error', 'warning', 'info'] },
    code: { type: 'string', minLength: 1 },
    message: { type: 'string' },
    nodeId: { type: 'string' },
    edgeId: { type: 'string' },
    horizonYears: { enum: [1, 5] },
  },
} as const;

const DIAGNOSTIC_SCHEMA = {
  type: 'object',
  required: ['id', 'severity', 'code', 'message'],
  properties: {
    id: { type: 'string', minLength: 1 },
    severity: { enum: ['error', 'warning', 'info'] },
    code: { type: 'string', minLength: 1 },
    message: { type: 'string' },
    nodeId: { type: 'string' },
    edgeId: { type: 'string' },
    operation: { enum: [...PARCEL_OPERATIONS] },
    horizonYears: { enum: [1, 5] },
    value: { type: 'number' },
    limit: { type: 'number' },
  },
} as const;

const CHECK_SCHEMA = {
  type: 'object',
  required: ['id', 'label', 'passed', 'severity', 'message'],
  properties: {
    id: { type: 'string', minLength: 1 },
    label: { type: 'string' },
    passed: { type: 'boolean' },
    severity: { enum: ['required', 'advisory'] },
    horizonYears: { enum: [1, 5] },
    operation: { enum: [...PARCEL_BUSINESS_OPERATIONS] },
    nodeId: { type: 'string' },
    actual: { type: 'number' },
    limit: { type: 'number' },
    unit: { type: 'string' },
    message: { type: 'string' },
  },
} as const;

const COUNT_SCHEMA = {
  type: 'object',
  required: [
    'sampled',
    'offered',
    'success',
    'failed',
    'rejected',
    'timedOut',
    'missedData',
    'stale',
    'unfinished',
  ],
  properties: {
    sampled: nonNegativeInteger,
    offered: nonNegativeInteger,
    success: nonNegativeInteger,
    failed: nonNegativeInteger,
    rejected: nonNegativeInteger,
    timedOut: nonNegativeInteger,
    missedData: nonNegativeInteger,
    stale: nonNegativeInteger,
    unfinished: nonNegativeInteger,
  },
} as const;

const OPERATION_METRICS_SCHEMA = {
  type: 'object',
  required: [
    'operation',
    'sampleFactor',
    'counts',
    'availability',
    'latencyP50Ms',
    'latencyP95Ms',
    'latencyP99Ms',
    'timeoutCount',
    'rejectCount',
    'successP95Ms',
    'queueWaitP95Ms',
    'freshnessP95Ms',
    'freshnessMaxMs',
    'rowsScanned',
    'bytesRead',
    'bytesWritten',
    'estimatedThroughputPerSec',
    'errorsByCode',
  ],
  properties: {
    operation: { enum: [...PARCEL_BUSINESS_OPERATIONS] },
    sampleFactor: { type: 'number', minimum: 1 },
    counts: COUNT_SCHEMA,
    availability: { type: 'number', minimum: 0, maximum: 1 },
    latencyP50Ms: nonNegative,
    latencyP95Ms: nonNegative,
    latencyP99Ms: nonNegative,
    timeoutCount: nonNegativeInteger,
    rejectCount: nonNegativeInteger,
    successP95Ms: nonNegative,
    queueWaitP95Ms: nonNegative,
    freshnessP95Ms: { anyOf: [nonNegative, { type: 'null' }] },
    freshnessMaxMs: { anyOf: [nonNegative, { type: 'null' }] },
    rowsScanned: nonNegative,
    bytesRead: nonNegative,
    bytesWritten: nonNegative,
    estimatedThroughputPerSec: nonNegative,
    errorsByCode: {
      type: 'object',
      additionalProperties: nonNegativeInteger,
    },
  },
} as const;

const NODE_OPERATION_SCHEMA = {
  type: 'object',
  required: ['requests', 'completed', 'errors', 'timedOut', 'p95Ms'],
  properties: {
    requests: nonNegativeInteger,
    completed: nonNegativeInteger,
    errors: nonNegativeInteger,
    timedOut: nonNegativeInteger,
    p95Ms: nonNegative,
  },
} as const;

const NODE_METRICS_SCHEMA = {
  type: 'object',
  required: [
    'nodeId',
    'kind',
    'label',
    'requests',
    'completed',
    'errors',
    'timedOut',
    'rejected',
    'averageCpuUtilization',
    'peakCpuUtilization',
    'averageIoUtilization',
    'peakIoUtilization',
    'averageNetworkUtilization',
    'peakNetworkUtilization',
    'averageQueueDepth',
    'peakQueueDepth',
    'queueWaitP95Ms',
    'bytesRead',
    'bytesWritten',
    'operations',
  ],
  properties: {
    nodeId: { type: 'string' },
    kind: { enum: [...PARCEL_NODE_KINDS] },
    label: { type: 'string' },
    requests: nonNegativeInteger,
    completed: nonNegativeInteger,
    errors: nonNegativeInteger,
    timedOut: nonNegativeInteger,
    rejected: nonNegativeInteger,
    averageCpuUtilization: { type: 'number', minimum: 0 },
    peakCpuUtilization: { type: 'number', minimum: 0 },
    averageIoUtilization: { type: 'number', minimum: 0 },
    peakIoUtilization: { type: 'number', minimum: 0 },
    averageNetworkUtilization: { type: 'number', minimum: 0 },
    peakNetworkUtilization: { type: 'number', minimum: 0 },
    averageQueueDepth: { type: 'number', minimum: 0 },
    peakQueueDepth: { type: 'number', minimum: 0 },
    queueWaitP95Ms: nonNegative,
    bytesRead: nonNegative,
    bytesWritten: nonNegative,
    operations: {
      type: 'object',
      additionalProperties: NODE_OPERATION_SCHEMA,
    },
  },
} as const;

const WORKLOAD_SCHEMA = {
  type: 'object',
  required: [
    'durationMs',
    'drainMs',
    'simulationEndMs',
    'sampleFactor',
    'sampledRequests',
    'estimatedOfferedRequests',
    'scheduledReports',
    'oldHistoryRequests',
    'eventBudget',
    'processedEvents',
    'exhausted',
    'keyspace',
    'causalTimestamps',
  ],
  properties: {
    durationMs: nonNegative,
    drainMs: nonNegative,
    simulationEndMs: nonNegative,
    sampleFactor: { type: 'number', minimum: 1 },
    sampledRequests: nonNegativeInteger,
    estimatedOfferedRequests: nonNegativeInteger,
    scheduledReports: nonNegativeInteger,
    oldHistoryRequests: nonNegativeInteger,
    eventBudget: nonNegativeInteger,
    processedEvents: nonNegativeInteger,
    exhausted: { type: 'boolean' },
    keyspace: nonNegativeInteger,
    causalTimestamps: { type: 'string' },
  },
} as const;

const STORE_USAGE_SCHEMA = {
  type: 'object',
  required: [
    'nodeId',
    'kind',
    'roles',
    'retentionYears',
    'horizonYears',
    'rawEventBytes',
    'physicalEventBytes',
    'indexBytes',
    'latestStatusBytes',
    'rollupBytes',
    'bucketOverheadBytes',
    'totalUsedBytes',
    'totalUsedTb',
    'provisionedTb',
    'utilization',
    'capacityOk',
    'compression',
    'index',
    'partition',
  ],
  properties: {
    nodeId: { type: 'string' },
    kind: { enum: [...PARCEL_STORE_KINDS] },
    roles: { type: 'array', items: { type: 'string' } },
    retentionYears: nonNegativeInteger,
    horizonYears: { enum: [1, 5] },
    rawEventBytes: nonNegative,
    physicalEventBytes: nonNegative,
    indexBytes: nonNegative,
    latestStatusBytes: nonNegative,
    rollupBytes: nonNegative,
    bucketOverheadBytes: nonNegative,
    totalUsedBytes: nonNegative,
    totalUsedTb: nonNegative,
    provisionedTb: nonNegative,
    utilization: nonNegative,
    capacityOk: { type: 'boolean' },
    replicatedFrom: { type: 'string' },
    compression: { enum: ['none', 'lz4', 'zstd'] },
    index: { enum: ['none', 'parcel', 'parcel-warehouse'] },
    partition: { enum: ['none', 'month'] },
  },
} as const;

const CAPACITY_SCHEMA = {
  type: 'object',
  required: [
    'horizonYears',
    'stores',
    'rawEventBytes',
    'physicalBytes',
    'indexBytes',
    'latestStatusBytes',
    'rollupBytes',
    'totalUsedTb',
    'totalProvisionedTb',
    'replicationCopies',
    'replicationFactor',
    'retentionYearsRequired',
    'retentionOk',
    'capacityOk',
    'notes',
  ],
  properties: {
    horizonYears: { enum: [1, 5] },
    stores: { type: 'array', items: STORE_USAGE_SCHEMA },
    rawEventBytes: nonNegative,
    physicalBytes: nonNegative,
    indexBytes: nonNegative,
    latestStatusBytes: nonNegative,
    rollupBytes: nonNegative,
    totalUsedTb: nonNegative,
    totalProvisionedTb: nonNegative,
    replicationCopies: nonNegativeInteger,
    replicationFactor: nonNegativeInteger,
    retentionYearsRequired: nonNegativeInteger,
    retentionOk: { type: 'boolean' },
    capacityOk: { type: 'boolean' },
    notes: { type: 'array', items: { type: 'string' } },
  },
} as const;

const NODE_COST_SCHEMA = {
  type: 'object',
  required: [
    'nodeId',
    'kind',
    'size',
    'computeMonthlyUsd',
    'provisionedStorageTb',
    'storageMonthlyUsd',
    'totalMonthlyUsd',
  ],
  properties: {
    nodeId: { type: 'string' },
    kind: { enum: [...PARCEL_NODE_KINDS] },
    size: { enum: ['small', 'medium', 'large'] },
    computeMonthlyUsd: nonNegative,
    provisionedStorageTb: nonNegative,
    storageMonthlyUsd: nonNegative,
    totalMonthlyUsd: nonNegative,
  },
} as const;

const COST_SCHEMA = {
  type: 'object',
  required: [
    'currency',
    'pricingVersion',
    'monthlyUsd',
    'computeMonthlyUsd',
    'storageMonthlyUsd',
    'fiveYearTcoUsd',
    'computeHours',
    'tcoMonths',
    'provisionedStorageTb',
    'usedStorageTbByHorizon',
    'replicationFactor',
    'byNode',
    'budgetMonthlyUsd',
    'withinBudget',
    'note',
  ],
  properties: {
    currency: { const: 'USD' },
    pricingVersion: { type: 'string' },
    monthlyUsd: nonNegative,
    computeMonthlyUsd: nonNegative,
    storageMonthlyUsd: nonNegative,
    fiveYearTcoUsd: nonNegative,
    computeHours: nonNegative,
    tcoMonths: nonNegative,
    provisionedStorageTb: nonNegative,
    usedStorageTbByHorizon: {
      type: 'object',
      properties: {
        '1': nonNegative,
        '5': nonNegative,
      },
      additionalProperties: false,
    },
    replicationFactor: nonNegativeInteger,
    byNode: { type: 'array', items: NODE_COST_SCHEMA },
    budgetMonthlyUsd: nonNegative,
    withinBudget: { type: 'boolean' },
    note: { type: 'string' },
  },
} as const;

const REQUIRED_HORIZON_GATE_IDS = [
  'availability:status',
  'availability:history',
  'availability:ingest',
  'availability:report',
  'p95:status',
  'p95:history',
  'p95:ingest',
  'p95:report',
  'non_zero:status',
  'non_zero:history',
  'non_zero:ingest',
  'non_zero:report',
  'freshness:status',
  'freshness:report',
  'retention',
  'capacity',
  'workload_complete',
  'data_integrity',
  'durable_ack',
  'budget',
] as const;

function passingGateSchema(id: string): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      id: { const: id },
      passed: { const: true },
      severity: { const: 'required' },
    },
    required: ['id', 'passed', 'severity'],
  };
}

const PASSING_STORAGE_GATE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^storage_capacity:.+$' },
    passed: { const: true },
    severity: { const: 'required' },
  },
  required: ['id', 'passed', 'severity'],
} as const;

const HORIZON_SCHEMA = {
  type: 'object',
  required: [
    'horizonYears',
    'passed',
    'workload',
    'operations',
    'nodes',
    'capacity',
    'cost',
    'checks',
    'diagnostics',
  ],
  properties: {
    horizonYears: { enum: [1, 5] },
    passed: { type: 'boolean' },
    workload: WORKLOAD_SCHEMA,
    operations: {
      type: 'object',
      required: ['status', 'history', 'ingest', 'report'],
      properties: {
        status: OPERATION_METRICS_SCHEMA,
        history: OPERATION_METRICS_SCHEMA,
        ingest: OPERATION_METRICS_SCHEMA,
        report: OPERATION_METRICS_SCHEMA,
      },
    },
    nodes: { type: 'array', items: NODE_METRICS_SCHEMA },
    capacity: CAPACITY_SCHEMA,
    cost: COST_SCHEMA,
    checks: { type: 'array', minItems: 1, items: CHECK_SCHEMA },
    diagnostics: { type: 'array', items: DIAGNOSTIC_SCHEMA },
  },
  allOf: [
    {
      if: {
        properties: { passed: { const: true } },
        required: ['passed'],
      },
      then: {
        properties: {
          checks: {
            allOf: [
              ...REQUIRED_HORIZON_GATE_IDS.map((id) => ({
                contains: passingGateSchema(id),
              })),
              { contains: PASSING_STORAGE_GATE_SCHEMA },
            ],
          },
        },
      },
    },
    {
      if: {
        properties: {
          horizonYears: { const: 5 },
          passed: { const: true },
        },
        required: ['horizonYears', 'passed'],
      },
      then: {
        properties: {
          checks: {
            contains: passingGateSchema('historical_cohort'),
          },
        },
      },
    },
  ],
} as const;

const META_SCHEMA = {
  type: 'object',
  required: [
    'schemaVersion',
    'modelVersion',
    'pricingVersion',
    'contentVersion',
    'levelId',
    'seed',
    'graphDigest',
    'requestedHorizons',
    'requiredHorizons',
    'sampleFactor',
  ],
  properties: {
    schemaVersion: { const: 1 },
    modelVersion: { type: 'string' },
    pricingVersion: { type: 'string' },
    contentVersion: { type: 'string' },
    levelId: { const: 'parcel-pulse' },
    seed: { type: 'integer' },
    graphDigest: { type: ['string', 'null'] },
    requestedHorizons: {
      type: 'array',
      items: { enum: [1, 5] },
    },
    requiredHorizons: {
      type: 'array',
      prefixItems: [{ const: 1 }, { const: 5 }],
      minItems: 2,
      maxItems: 2,
    },
    sampleFactor: { type: 'number', minimum: 1 },
  },
} as const;

const BASE_PROPERTIES = {
  meta: META_SCHEMA,
  issues: { type: 'array', items: ISSUE_SCHEMA },
  diagnostics: { type: 'array', items: DIAGNOSTIC_SCHEMA },
  assumptions: { type: 'array', items: { type: 'string' } },
  checks: { type: 'array', items: CHECK_SCHEMA },
} as const;

/**
 * Status-specific JSON Schema for the complete Parcel evaluation result.
 * `passed: true` requires both mandatory horizons and passing evidence checks.
 */
export function parcelEvaluationJsonSchema(): Record<string, unknown> {
  const common = {
    type: 'object',
    required: [
      'status',
      'passed',
      'meta',
      'issues',
      'diagnostics',
      'assumptions',
      'horizons',
      'capacity',
      'cost',
      'checks',
    ],
    properties: {
      ...BASE_PROPERTIES,
      status: { enum: ['ok', 'invalid', 'error'] },
      passed: { type: 'boolean' },
      horizons: { type: 'array' },
      capacity: { type: ['object', 'null'] },
      cost: { type: ['object', 'null'] },
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', minLength: 1 },
          message: { type: 'string' },
        },
      },
    },
    oneOf: [
      {
        properties: {
          status: { const: 'ok' },
          meta: {
            ...META_SCHEMA,
            properties: {
              ...META_SCHEMA.properties,
              seed: {
                type: 'integer',
                minimum: PARCEL_COMPONENT_LIMITS.seed.min,
                maximum: PARCEL_COMPONENT_LIMITS.seed.max,
              },
              graphDigest: { type: 'string' },
              requestedHorizons: {
                type: 'array',
                minItems: 1,
                items: { enum: [1, 5] },
              },
            },
          },
          horizons: { type: 'array', minItems: 1, maxItems: 2, items: HORIZON_SCHEMA },
          capacity: CAPACITY_SCHEMA,
          cost: COST_SCHEMA,
          checks: { type: 'array', items: CHECK_SCHEMA },
        },
        required: ['status', 'passed', 'horizons', 'capacity', 'cost'],
        allOf: [
          {
            if: {
              properties: { passed: { const: true } },
              required: ['passed'],
            },
            then: {
              allOf: [
                {
                  properties: {
                    horizons: {
                      minItems: 2,
                      maxItems: 2,
                      items: {
                        type: 'object',
                        properties: { passed: { const: true } },
                        required: ['passed'],
                      },
                      contains: {
                        type: 'object',
                        properties: { horizonYears: { const: 1 } },
                        required: ['horizonYears'],
                      },
                    },
                  },
                },
                {
                  properties: {
                    horizons: {
                      minItems: 2,
                      maxItems: 2,
                      contains: {
                        type: 'object',
                        properties: { horizonYears: { const: 5 } },
                        required: ['horizonYears'],
                      },
                    },
                  },
                },
                {
                  properties: {
                    checks: {
                      contains: {
                        type: 'object',
                        properties: {
                          id: { const: 'horizons_complete' },
                          passed: { const: true },
                        },
                        required: ['id', 'passed'],
                      },
                    },
                  },
                },
                {
                  properties: {
                    checks: {
                      contains: {
                        type: 'object',
                        properties: {
                          id: { const: 'horizon_pass:1' },
                          passed: { const: true },
                        },
                        required: ['id', 'passed'],
                      },
                    },
                  },
                },
                {
                  properties: {
                    checks: {
                      contains: {
                        type: 'object',
                        properties: {
                          id: { const: 'horizon_pass:5' },
                          passed: { const: true },
                        },
                        required: ['id', 'passed'],
                      },
                    },
                  },
                },
                {
                  properties: {
                    horizons: {
                      items: {
                        type: 'object',
                        required: ['workload', 'operations', 'checks'],
                        properties: {
                          workload: {
                            properties: {
                              scheduledReports: { type: 'integer', minimum: 1 },
                              sampledRequests: { type: 'integer', minimum: 1 },
                            },
                            required: ['scheduledReports', 'sampledRequests'],
                          },
                          operations: {
                            required: ['status', 'history', 'ingest', 'report'],
                            properties: {
                              status: {
                                properties: {
                                  counts: {
                                    properties: {
                                      success: { type: 'integer', minimum: 1 },
                                    },
                                  },
                                },
                              },
                              history: {
                                properties: {
                                  counts: {
                                    properties: {
                                      success: { type: 'integer', minimum: 1 },
                                    },
                                  },
                                },
                              },
                              ingest: {
                                properties: {
                                  counts: {
                                    properties: {
                                      success: { type: 'integer', minimum: 1 },
                                    },
                                  },
                                },
                              },
                              report: {
                                properties: {
                                  counts: {
                                    properties: {
                                      success: { type: 'integer', minimum: 1 },
                                    },
                                  },
                                },
                              },
                            },
                          },
                          checks: {
                            contains: {
                              type: 'object',
                              properties: {
                                id: { const: 'data_integrity' },
                                passed: { const: true },
                              },
                              required: ['id', 'passed'],
                            },
                          },
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
      {
        properties: {
          status: { const: 'invalid' },
          passed: { const: false },
          horizons: { type: 'array', maxItems: 0 },
          capacity: { const: null },
          cost: { const: null },
        },
        required: ['status', 'passed', 'horizons', 'capacity', 'cost'],
      },
      {
        properties: {
          status: { const: 'error' },
          passed: { const: false },
          horizons: { type: 'array', maxItems: 0 },
          capacity: { const: null },
          cost: { const: null },
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', minLength: 1 },
              message: { type: 'string' },
            },
          },
        },
        required: ['status', 'passed', 'horizons', 'capacity', 'cost', 'error'],
      },
    ],
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://system-design-game.local/schemas/parcel-pulse-result.json',
    title: 'Parcel Pulse evaluation result',
    ...common,
  };
}

/** One payload for CLI `describe` and the future backend adapter. */
export function describeParcelLevel(): {
  level: ParcelLevel;
  catalog: ParcelCatalog;
  graphSchema: Record<string, unknown>;
  resultSchema: Record<string, unknown>;
  componentLimits: typeof PARCEL_COMPONENT_LIMITS;
  rules: readonly string[];
} {
  return {
    level: parcelLevelPayload(),
    catalog: cloneParcelCatalog(),
    graphSchema: parcelGraphJsonSchema(),
    resultSchema: parcelEvaluationJsonSchema(),
    componentLimits: PARCEL_COMPONENT_LIMITS,
    rules: [
      'Demand is independent of the graph: seeded status/history/ingest Poisson streams plus reports at 10/20/25/30/35/50 seconds for warehouses 0..5.',
      'Every offered request is simulated (sample factor 1); availability uses all offered requests and percentiles use successful responses only.',
      'Year 5 keeps a 20% four-year-old history cohort; year 1 uses the oldest retained age.',
      'Status/report freshness is measured against the contiguous replicated sequence at read snapshot time.',
      'Deadlines do not cancel work; timed-out ingest still commits durably and replicates.',
      'Storage, compute, indexes, rollups, replication and compression are charged from the visible catalog.',
      'Both mandatory horizons must pass; passed graphs rank by five-year TCO.',
    ],
  };
}
