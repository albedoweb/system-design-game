import { z } from 'zod';
import type { TrafficFrame } from '../simulation/traffic-telemetry';

/**
 * Live Scoreboard public contracts.
 *
 * This level studies one repeated answer: the top-20 leaderboard over 500,000
 * changing votes. The graph, catalog, level and result shapes are versioned and
 * validated before any evaluator work. Nothing in this module imports React,
 * the browser, a worker, the backend or an older level evaluator.
 */

export const SCOREBOARD_SCHEMA_VERSION = 1 as const;
export const SCOREBOARD_MODEL_VERSION = '1.0.0' as const;
export const SCOREBOARD_CONTENT_VERSION = '1.0.0' as const;
export const SCOREBOARD_PRICING_VERSION = 'scoreboard-catalog-v1' as const;
export const SCOREBOARD_LEVEL_ID = 'live-scoreboard' as const;
export const SCOREBOARD_MAX_SEED = 2_147_483_647;

/** Public payload bounds shared by the converter, schema and evaluator. */
export const SCOREBOARD_MAX_ISSUES = 32;
export const SCOREBOARD_MAX_FRAMES = 240;
export const SCOREBOARD_MAX_NODES = 4;
export const SCOREBOARD_MAX_LINKS = 8;
export const SCOREBOARD_MAX_GATES = 16;
export const SCOREBOARD_MAX_SERIES_POINTS = 240;
export const SCOREBOARD_MAX_INCOMPLETE_REASONS = 32;

export const SCOREBOARD_NODE_KINDS = ['users', 'app', 'sql', 'cache'] as const;
export const SCOREBOARD_SQL_SIZES = ['small', 'medium', 'large'] as const;
export const SCOREBOARD_SQL_READ_PLANS = ['scan', 'aggregate'] as const;
export const SCOREBOARD_CACHE_TTLS_SECONDS = [0.5, 2, 5, 15] as const;
export const SCOREBOARD_OPERATIONS = ['read', 'write'] as const;
export const SCOREBOARD_WINDOWS = ['whole', 'peak'] as const;
export const SCOREBOARD_STATUSES = ['invalid', 'incomplete', 'complete'] as const;

export type ScoreboardNodeKind = (typeof SCOREBOARD_NODE_KINDS)[number];
export type ScoreboardSqlSize = (typeof SCOREBOARD_SQL_SIZES)[number];
export type ScoreboardSqlReadPlan =
  (typeof SCOREBOARD_SQL_READ_PLANS)[number];
export type ScoreboardCacheTtlSeconds =
  (typeof SCOREBOARD_CACHE_TTLS_SECONDS)[number];
export type ScoreboardOperation = (typeof SCOREBOARD_OPERATIONS)[number];
export type ScoreboardWindow = (typeof SCOREBOARD_WINDOWS)[number];
export type ScoreboardStatus = (typeof SCOREBOARD_STATUSES)[number];

export const SCOREBOARD_OPERATION_LABELS = {
  read: 'View leaderboard',
  write: 'Change vote',
} as const;

export const SCOREBOARD_ISSUE_SEVERITIES = ['error', 'warning', 'info'] as const;
export type ScoreboardIssueSeverity =
  (typeof SCOREBOARD_ISSUE_SEVERITIES)[number];

export const scoreboardIssueSchema = z.strictObject({
  severity: z.enum(SCOREBOARD_ISSUE_SEVERITIES),
  code: z.string().min(1).max(96),
  message: z.string().min(1).max(2_000),
  path: z.string().min(1).max(200).optional(),
  nodeId: z.string().min(1).max(64).optional(),
  edgeId: z.string().min(1).max(64).optional(),
  operation: z.enum(SCOREBOARD_OPERATIONS).optional(),
  metric: z.string().min(1).max(96).optional(),
  value: z.number().finite().optional(),
  limit: z.number().finite().optional(),
  /** Aggregated runtime occurrences; one issue is never emitted per request. */
  count: z.number().int().min(1).optional(),
});

export type ScoreboardIssue = z.infer<typeof scoreboardIssueSchema>;

export type ScoreboardParseResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly issues: readonly ScoreboardIssue[];
    }
  | {
      readonly ok: false;
      readonly value: null;
      readonly issues: readonly ScoreboardIssue[];
    };

/** Convert a Zod error into bounded English product issues. */
export function scoreboardIssuesFromZod(
  error: z.ZodError,
  pathPrefix = '',
  maxIssues = SCOREBOARD_MAX_ISSUES,
): ScoreboardIssue[] {
  const limit = Math.max(1, Math.floor(maxIssues));
  const issues: ScoreboardIssue[] = [];
  let omitted = 0;
  const push = (value: ScoreboardIssue): void => {
    if (issues.length < limit - 1) {
      issues.push(value);
    } else {
      omitted += 1;
    }
  };
  for (const issue of error.issues) {
    const path = [
      ...issue.path.map(String),
      ...(pathPrefix === '' ? [] : [pathPrefix]),
    ]
      .filter((part) => part.length > 0)
      .join('.')
      .slice(0, 200);
    const base = {
      severity: 'error' as const,
      message: String(issue.message).slice(0, 2_000),
      ...(path === '' ? {} : { path }),
    };
    if (String(issue.code) === 'unrecognized_keys') {
      const keys =
        'keys' in issue && Array.isArray(issue.keys) ? issue.keys.map(String) : [];
      const shown = keys.slice(0, 8);
      const suffix =
        keys.length > shown.length ? ` (+${keys.length - shown.length} more)` : '';
      push({
        ...base,
        code: 'unknown_field',
        message: `Unknown fields are not allowed: ${shown.join(', ')}${suffix}.`.slice(
          0,
          2_000,
        ),
      });
      continue;
    }
    const code =
      String(issue.code) === 'invalid_type'
        ? 'invalid_type'
        : String(issue.code) === 'too_small' ||
            String(issue.code) === 'too_big'
          ? 'number_out_of_range'
          : 'invalid_value';
    push({ ...base, code });
  }
  if (omitted > 0) {
    issues.push({
      severity: 'warning',
      code: 'issues_truncated',
      message: `Additional validation issues were omitted (${omitted}).`,
      count: omitted,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Graph document
// ---------------------------------------------------------------------------

export const scoreboardPositionSchema = z.strictObject({
  x: z.number().finite().min(-1_000_000).max(1_000_000),
  y: z.number().finite().min(-1_000_000).max(1_000_000),
});

export const scoreboardIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, digits, "-" or "_".');

export const scoreboardLabelSchema = z.string().min(1).max(120);

const nodeBase = {
  id: scoreboardIdSchema,
  label: scoreboardLabelSchema,
  position: scoreboardPositionSchema,
};

export const scoreboardUsersNodeSchema = z.strictObject({
  ...nodeBase,
  kind: z.literal('users'),
  config: z.strictObject({}),
});

export const scoreboardAppConfigSchema = z.strictObject({
  /** One visible service pool. Instances are charged and add CPU capacity. */
  instances: z.number().int().min(1).max(4),
});

export const scoreboardSqlConfigSchema = z.strictObject({
  size: z.enum(SCOREBOARD_SQL_SIZES),
  readPlan: z.enum(SCOREBOARD_SQL_READ_PLANS),
});

export const scoreboardCacheConfigSchema = z.strictObject({
  ttlSeconds: z.union([
    z.literal(0.5),
    z.literal(2),
    z.literal(5),
    z.literal(15),
  ]),
});

export const scoreboardAppNodeSchema = z.strictObject({
  ...nodeBase,
  kind: z.literal('app'),
  config: scoreboardAppConfigSchema,
});

export const scoreboardSqlNodeSchema = z.strictObject({
  ...nodeBase,
  kind: z.literal('sql'),
  config: scoreboardSqlConfigSchema,
});

export const scoreboardCacheNodeSchema = z.strictObject({
  ...nodeBase,
  kind: z.literal('cache'),
  config: scoreboardCacheConfigSchema,
});

export const scoreboardNodeSchema = z.discriminatedUnion('kind', [
  scoreboardUsersNodeSchema,
  scoreboardAppNodeSchema,
  scoreboardSqlNodeSchema,
  scoreboardCacheNodeSchema,
]);

export type ScoreboardUsersNode = z.infer<typeof scoreboardUsersNodeSchema>;
export type ScoreboardAppNode = z.infer<typeof scoreboardAppNodeSchema>;
export type ScoreboardSqlNode = z.infer<typeof scoreboardSqlNodeSchema>;
export type ScoreboardCacheNode = z.infer<typeof scoreboardCacheNodeSchema>;
export type ScoreboardNode = z.infer<typeof scoreboardNodeSchema>;
export type ScoreboardNodeConfig = ScoreboardNode['config'];

export const scoreboardEdgeSchema = z.strictObject({
  id: scoreboardIdSchema,
  from: scoreboardIdSchema,
  to: scoreboardIdSchema,
});

export type ScoreboardEdge = z.infer<typeof scoreboardEdgeSchema>;

export const scoreboardGraphSchema = z.strictObject({
  schemaVersion: z.literal(SCOREBOARD_SCHEMA_VERSION),
  levelId: z.literal(SCOREBOARD_LEVEL_ID),
  nodes: z.array(scoreboardNodeSchema).min(1).max(4),
  edges: z.array(scoreboardEdgeSchema).max(8),
});

export type ScoreboardGraph = z.infer<typeof scoreboardGraphSchema>;

/**
 * Semantic role is inferred from the component pair, never from a business
 * port chosen by the player. `traffic` is Users -> App, `primary` is the one
 * shared App -> SQL path used by writes and direct reads, `reads` is
 * App -> Cache and `fill` is Cache -> SQL. Role is topology only; use the
 * per-link read/write counters when labelling business traffic.
 */
export const SCOREBOARD_LINK_ROLES = [
  'traffic',
  'primary',
  'reads',
  'fill',
] as const;
export type ScoreboardLinkRole = (typeof SCOREBOARD_LINK_ROLES)[number];

export function scoreboardLinkRole(
  from: ScoreboardNodeKind,
  to: ScoreboardNodeKind,
): ScoreboardLinkRole | null {
  if (from === 'users' && to === 'app') {
    return 'traffic';
  }
  if (from === 'app' && to === 'sql') {
    return 'primary';
  }
  if (from === 'app' && to === 'cache') {
    return 'reads';
  }
  if (from === 'cache' && to === 'sql') {
    return 'fill';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Catalog: general components and their declared capabilities
// ---------------------------------------------------------------------------

const positive = z.number().finite().positive();
const nonNegative = z.number().finite().nonnegative();
const hourly = z.number().finite().nonnegative();

export const scoreboardCatalogSchema = z.strictObject({
  schemaVersion: z.literal(SCOREBOARD_SCHEMA_VERSION),
  pricingVersion: z.literal(SCOREBOARD_PRICING_VERSION),
  currency: z.literal('USD'),
  priceNote: z.string().min(1).max(2_000),
  componentPalette: z.array(z.enum(SCOREBOARD_NODE_KINDS)).length(4),
  components: z.strictObject({
    users: z.strictObject({
      kind: z.literal('users'),
      label: z.string().min(1).max(120),
      fixed: z.literal(true),
      configurableFields: z.array(z.string()).max(0),
      notes: z.string().min(1).max(2_000),
    }),
    app: z.strictObject({
      kind: z.literal('app'),
      label: z.string().min(1).max(120),
      fixed: z.literal(false),
      configurableFields: z.array(z.literal('instances')).length(1),
      instances: z.strictObject({
        min: z.literal(1),
        max: z.literal(4),
        default: z.number().int().min(1).max(4),
      }),
      cpuCoresPerInstance: positive,
      memoryGbPerInstance: positive,
      nicGbitPerSecPerInstance: positive,
      hourlyUsdPerInstance: hourly,
      notes: z.string().min(1).max(2_000),
    }),
    sql: z.strictObject({
      kind: z.literal('sql'),
      label: z.string().min(1).max(120),
      fixed: z.literal(false),
      configurableFields: z
        .array(z.enum(['size', 'readPlan']))
        .length(2),
      sizes: z.strictObject({
        small: z.strictObject({
          cores: positive,
          memoryGb: positive,
          diskGb: positive,
          nicGbitPerSec: positive,
          hourlyUsd: hourly,
        }),
        medium: z.strictObject({
          cores: positive,
          memoryGb: positive,
          diskGb: positive,
          nicGbitPerSec: positive,
          hourlyUsd: hourly,
        }),
        large: z.strictObject({
          cores: positive,
          memoryGb: positive,
          diskGb: positive,
          nicGbitPerSec: positive,
          hourlyUsd: hourly,
        }),
      }),
      readPlans: z.strictObject({
        scan: z.strictObject({
          label: z.string().min(1).max(120),
          description: z.string().min(1).max(2_000),
        }),
        aggregate: z.strictObject({
          label: z.string().min(1).max(120),
          description: z.string().min(1).max(2_000),
        }),
      }),
      notes: z.string().min(1).max(2_000),
    }),
    cache: z.strictObject({
      kind: z.literal('cache'),
      label: z.string().min(1).max(120),
      fixed: z.literal(false),
      configurableFields: z.array(z.literal('ttlSeconds')).length(1),
      ttlOptionsSeconds: z.array(z.union([
        z.literal(0.5),
        z.literal(2),
        z.literal(5),
        z.literal(15),
      ])).length(4),
      capacityBytes: positive,
      entryBytes: positive,
      coalescing: z.literal('fixed-on'),
      cpuCores: positive,
      memoryGb: positive,
      nicGbitPerSec: positive,
      hourlyUsd: hourly,
      notes: z.string().min(1).max(2_000),
    }),
  }),
  work: z.strictObject({
    /** Raw scan is charged per inspected row, on one core per query. */
    rawScanCoreMsPerRow: positive,
    aggregateReadCoreMs: positive,
    /** Extra transaction work that keeps an aggregate correct on every write. */
    rawWriteCoreMs: positive,
    aggregateWriteCoreMs: positive,
    aggregateBuildExtraCoreMs: nonNegative,
    appReadCoreMs: positive,
    appWriteCoreMs: positive,
    cacheLookupCoreMs: positive,
    cacheStoreCoreMs: positive,
    sqlDiskWriteCoreMs: positive,
    diskWriteBytesPerVote: positive,
    clientRequestProcessingMs: positive,
    clientResponseProcessingMs: positive,
  }),
  network: z.strictObject({
    clientRttMs: positive,
    /** One-way internal propagation after serialization. */
    internalOneWayMs: positive,
    clientRequestBytes: positive,
    clientResponseBytes: positive,
    writeAckBytes: positive,
    /** Each hop reserves one 1 Gbit/s lane on its owning service NIC. */
    laneGbitPerSec: z.literal(1),
  }),
  billing: z.strictObject({
    /** Client-visible delivered response bytes; internal traffic is measured. */
    responseBytesUsdPerGb: hourly,
    bytesPerGb: z.literal(1_000_000_000),
  }),
});

export type ScoreboardCatalog = z.infer<typeof scoreboardCatalogSchema>;
export type ScoreboardSqlSizeSpec =
  ScoreboardCatalog['components']['sql']['sizes'][ScoreboardSqlSize];

// ---------------------------------------------------------------------------
// Level definition
// ---------------------------------------------------------------------------

export const scoreboardReadPhaseSchema = z.strictObject({
  fromMs: nonNegative,
  toMs: positive,
  readsPerSecond: nonNegative,
});

export const scoreboardLevelSchema = z.strictObject({
  schemaVersion: z.literal(SCOREBOARD_SCHEMA_VERSION),
  contentVersion: z.literal(SCOREBOARD_CONTENT_VERSION),
  modelVersion: z.literal(SCOREBOARD_MODEL_VERSION),
  pricingVersion: z.literal(SCOREBOARD_PRICING_VERSION),
  id: z.literal(SCOREBOARD_LEVEL_ID),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(2_000),
  task: z.string().min(1).max(4_000),
  dataset: z.strictObject({
    participants: z.number().int().positive(),
    candidates: z.number().int().positive(),
    currentVoteBytes: z.number().int().positive(),
    workingSetBytes: z.number().int().positive(),
    initialVotes: z.literal('deterministic'),
    fixedPopulation: z.literal(true),
    historyRetained: z.literal(false),
  }),
  workload: z.strictObject({
    measuredMs: positive,
    readPhases: z.array(scoreboardReadPhaseSchema).min(1),
    voteChangesPerSecond: nonNegative,
    requestDeadlineMs: positive,
    drainMs: positive,
    peakWindow: z.strictObject({ fromMs: nonNegative, toMs: positive }),
    traceSeedPolicy: z.literal('graph-independent'),
    arrivalModel: z.literal('poisson'),
    oneTracePerSeed: z.literal(true),
    cacheInitialState: z.literal('cold'),
    tieBreak: z.literal('candidate-id-ascending'),
    topN: z.number().int().positive(),
  }),
  limits: z.strictObject({
    maxSqlWaitingTasks: z.number().int().positive(),
    maxAppWaitingTasks: z.number().int().positive(),
    maxCacheWaitingTasks: z.number().int().positive(),
    maxEvents: z.number().int().positive(),
    maxFrames: z.number().int().positive(),
    maxIssues: z.number().int().positive(),
  }),
  slo: z.strictObject({
    availability: z.number().gt(0).max(1),
    successfulP95Ms: positive,
    freshnessMs: positive,
    minimumLatencySamples: z.number().int().positive(),
  }),
  defaultSeed: z.number().int().min(0).max(SCOREBOARD_MAX_SEED),
  calibrationSeeds: z.array(
    z.number().int().min(0).max(SCOREBOARD_MAX_SEED),
  ).min(1),
  holdoutSeeds: z.array(
    z.number().int().min(0).max(SCOREBOARD_MAX_SEED),
  ).min(1),
  assumptions: z.array(z.string().min(1).max(4_000)).min(1),
});

export type ScoreboardLevel = z.infer<typeof scoreboardLevelSchema>;
export type ScoreboardReadPhase = z.infer<typeof scoreboardReadPhaseSchema>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const scoreboardLatencySchema = z.strictObject({
  p50Ms: nonNegative.nullable(),
  p95Ms: nonNegative.nullable(),
  p99Ms: nonNegative.nullable(),
  maxMs: nonNegative.nullable(),
  samples: z.number().int().nonnegative(),
  /** True when the sample count cannot support the reported percentile gate. */
  insufficientSamples: z.boolean(),
});

export type ScoreboardLatency = z.infer<typeof scoreboardLatencySchema>;

export const scoreboardOperationMetricsSchema = z.strictObject({
  offered: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  timedOut: z.number().int().nonnegative(),
  /** Failed for a data/cache/transport reason that is not a queue rejection. */
  errored: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  /** succeeded / offered; null when nothing was offered. */
  availability: z.number().min(0).max(1).nullable(),
  latency: scoreboardLatencySchema,
  bytesOffered: nonNegative,
  bytesDelivered: nonNegative,
});

export type ScoreboardOperationMetrics = z.infer<
  typeof scoreboardOperationMetricsSchema
>;

export const scoreboardGateSchema = z.strictObject({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(200),
  severity: z.enum(['required', 'advisory']),
  operation: z.enum(SCOREBOARD_OPERATIONS).optional(),
  window: z.enum(SCOREBOARD_WINDOWS).optional(),
  metric: z.string().min(1).max(96),
  actual: z.number().finite().nullable(),
  limit: z.number().finite().nullable(),
  unit: z.string().min(1).max(32),
  sampleCount: z.number().int().nonnegative(),
  passed: z.boolean(),
  message: z.string().min(1).max(2_000),
});

export type ScoreboardGate = z.infer<typeof scoreboardGateSchema>;

export const scoreboardCpuMetricsSchema = z.strictObject({
  capacityCores: nonNegative,
  busyCoresAverage: nonNegative,
  busyCoresPeak: nonNegative,
  busyCoreMs: nonNegative,
  utilizationAverage: z.number().min(0).max(1),
  utilizationPeak: z.number().min(0).max(1),
});

export const scoreboardMemoryMetricsSchema = z.strictObject({
  capacityBytes: nonNegative,
  workingSetBytes: nonNegative,
  residentBytesAverage: nonNegative.describe(
    'Bounded estimate sampled at each one-second series tick, weighted by the interval. Not an exact continuous time integral.',
  ),
  peakUsedBytes: nonNegative.describe(
    'Highest measured-window ledger usage observed at task reservation or cache-entry fill events.',
  ),
});

export const scoreboardQueueMetricsSchema = z.strictObject({
  waitingAverage: nonNegative,
  waitingPeak: z.number().int().nonnegative(),
  waitMsAverage: nonNegative,
  waitMsMax: nonNegative,
  waitSamples: z.number().int().nonnegative(),
  activePeak: z.number().int().nonnegative(),
});

export const scoreboardNetworkMetricsSchema = z.strictObject({
  capacityGbitPerSec: nonNegative,
  bytesOffered: nonNegative,
  bytesDelivered: nonNegative,
  averageGbitPerSec: nonNegative,
  peakGbitPerSec: nonNegative,
});

export const scoreboardTaskMetricsSchema = z.strictObject({
  submitted: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  timedOut: z.number().int().nonnegative(),
  interrupted: z.number().int().nonnegative(),
});

export const scoreboardNodeMetricsSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  kind: z.enum(SCOREBOARD_NODE_KINDS),
  label: z.string().min(1).max(120),
  instances: z.number().int().positive(),
  cpu: scoreboardCpuMetricsSchema,
  memory: scoreboardMemoryMetricsSchema,
  queue: scoreboardQueueMetricsSchema,
  network: scoreboardNetworkMetricsSchema,
  tasks: scoreboardTaskMetricsSchema,
});

export type ScoreboardNodeMetrics = z.infer<typeof scoreboardNodeMetricsSchema>;

export const scoreboardLinkMetricsSchema = z.strictObject({
  edgeId: z.string().min(1).max(64),
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  role: z.enum(SCOREBOARD_LINK_ROLES),
  requests: z.strictObject({
    read: z.number().int().nonnegative(),
    write: z.number().int().nonnegative(),
    fill: z.number().int().nonnegative(),
  }),
  requestsTotal: z.number().int().nonnegative(),
  bytesOffered: nonNegative,
  bytesDelivered: nonNegative,
  peakRequestsPerSecond: nonNegative,
  peakBytesPerSecond: nonNegative,
});

export type ScoreboardLinkMetrics = z.infer<typeof scoreboardLinkMetricsSchema>;

export const scoreboardCorrectnessSchema = z.strictObject({
  valid: z.boolean(),
  writesOffered: z.number().int().nonnegative(),
  writesCommitted: z.number().int().nonnegative(),
  writesAcknowledged: z.number().int().nonnegative(),
  committedUnacknowledged: z.number().int().nonnegative(),
  noOpWrites: z.number().int().nonnegative(),
  invalidVotes: z.number().int().nonnegative(),
  doubleEffects: z.number().int().nonnegative(),
  lostAcknowledgedVotes: z.number().int().nonnegative(),
  aggregateMismatches: z.number().int().nonnegative(),
  snapshotMismatches: z.number().int().nonnegative(),
  checkedSnapshots: z.number().int().nonnegative(),
  finalStateMatchesReference: z.boolean().nullable(),
  finalRawMatchesAggregate: z.boolean().nullable(),
  finalVoteCount: z.number().int().nonnegative(),
  finalCandidateVotes: z.number().int().nonnegative(),
});

export type ScoreboardCorrectness = z.infer<
  typeof scoreboardCorrectnessSchema
>;

export const scoreboardFreshnessSchema = z.strictObject({
  valid: z.boolean(),
  freshnessLimitMs: nonNegative,
  successfulReads: z.number().int().nonnegative(),
  checkedReads: z.number().int().nonnegative(),
  staleReads: z.number().int().nonnegative(),
  maxLagMs: nonNegative,
  p95LagMs: nonNegative,
  samples: z.number().int().nonnegative(),
});

export type ScoreboardFreshness = z.infer<typeof scoreboardFreshnessSchema>;

export const scoreboardCostLineSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  kind: z.enum(SCOREBOARD_NODE_KINDS),
  hourlyUsd: nonNegative,
  hours: nonNegative,
  usd: nonNegative,
});

export type ScoreboardCostLine = z.infer<typeof scoreboardCostLineSchema>;

export const scoreboardCostSchema = z.strictObject({
  currency: z.literal('USD'),
  hourlyUsd: nonNegative,
  preparationMs: nonNegative,
  measuredMs: nonNegative,
  drainMs: nonNegative,
  billedMs: nonNegative,
  rentalUsd: nonNegative,
  billedBytes: nonNegative,
  bytesUsd: nonNegative,
  actualUsd: nonNegative,
  /** Single comparable score: actual run cost. Cheapest passing design wins. */
  scoreUsd: nonNegative,
  lines: z.array(scoreboardCostLineSchema).max(SCOREBOARD_MAX_NODES),
});

export type ScoreboardCost = z.infer<typeof scoreboardCostSchema>;

export const scoreboardPreparationSchema = z.strictObject({
  plan: z.enum(SCOREBOARD_SQL_READ_PLANS),
  workCoreMs: nonNegative,
  durationMs: nonNegative,
  startMs: nonNegative,
  endMs: nonNegative,
  cacheColdAtTrafficStart: z.literal(true),
  notes: z.string().min(1).max(2_000),
});

export type ScoreboardPreparation = z.infer<
  typeof scoreboardPreparationSchema
>;

export const scoreboardWindowSchema = z.strictObject({
  measuredStartMs: nonNegative,
  measuredEndMs: nonNegative,
  peakStartMs: nonNegative,
  peakEndMs: nonNegative,
  drainMs: nonNegative,
  totalRunMs: nonNegative,
  runEndedIncomplete: z.boolean(),
});

export type ScoreboardRunWindow = z.infer<typeof scoreboardWindowSchema>;

export const scoreboardSeriesTrafficSchema = z.strictObject({
  offered: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const scoreboardSeriesLatencySchema = z.strictObject({
  p50Ms: nonNegative.nullable(),
  p95Ms: nonNegative.nullable(),
  p99Ms: nonNegative.nullable(),
  samples: z.number().int().nonnegative(),
});

export const scoreboardSeriesNodeSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  cpuUtilization: z.number().min(0).max(1).nullable(),
  ramUsedBytes: nonNegative
    .nullable()
    .describe('End-of-interval instantaneous ledger usage; not an interval average.'),
  queueWaiting: nonNegative.nullable(),
  queueWaitingAverage: nonNegative.nullable(),
  networkGbitPerSec: nonNegative.nullable(),
});

export const scoreboardSeriesPointSchema = z.strictObject({
  /** End of the one-second interval, relative to the measured start. */
  timeMs: nonNegative,
  windowMs: nonNegative,
  traffic: z.strictObject({
    read: scoreboardSeriesTrafficSchema,
    write: scoreboardSeriesTrafficSchema,
  }),
  latency: z.strictObject({
    read: scoreboardSeriesLatencySchema.nullable(),
    write: scoreboardSeriesLatencySchema.nullable(),
  }),
  nodes: z.array(scoreboardSeriesNodeSchema),
});

export type ScoreboardSeriesPoint = z.infer<
  typeof scoreboardSeriesPointSchema
>;

export const scoreboardTrafficNodeResourceSchema = z.strictObject({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  aggregation: z.enum(['window-average', 'instant']).optional(),
  used: z.number().finite().nullable(),
  capacity: z.number().finite().nullable(),
  unit: z.enum(['slots', 'connections', 'cores', 'lanes', 'bytes', 'gbit/s']),
});

export const scoreboardTrafficNodeSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  resources: z.array(scoreboardTrafficNodeResourceSchema),
  requestsPerSecond: z.number().finite().nullable(),
  queue: z.number().finite().nullable(),
  down: z.boolean(),
});

export const scoreboardTrafficEdgeSchema = z.strictObject({
  edgeId: z.string().min(1).max(64),
  requestsPerSecond: z.number().finite(),
  bytesPerSecond: z.number().finite().nullable(),
});

export const scoreboardTrafficFrameSchema = z.strictObject({
  levelId: z.literal(SCOREBOARD_LEVEL_ID),
  scopeId: z.literal('live-measured'),
  scopeLabel: z.string().min(1).max(120),
  timeMs: nonNegative,
  windowMs: nonNegative,
  phase: z.enum(['warmup', 'measured', 'drain', 'postlude']),
  nodes: z.array(scoreboardTrafficNodeSchema),
  edges: z.array(scoreboardTrafficEdgeSchema),
});

export type ScoreboardTrafficFrame = z.infer<
  typeof scoreboardTrafficFrameSchema
>;

export const scoreboardIdentitySchema = z.strictObject({
  levelId: z.literal(SCOREBOARD_LEVEL_ID),
  modelVersion: z.literal(SCOREBOARD_MODEL_VERSION),
  schemaVersion: z.literal(SCOREBOARD_SCHEMA_VERSION),
  contentVersion: z.literal(SCOREBOARD_CONTENT_VERSION),
  pricingVersion: z.literal(SCOREBOARD_PRICING_VERSION),
  seed: z.number().int().min(0).max(SCOREBOARD_MAX_SEED),
  graphDigest: z.string().min(1).max(64),
  /** Includes versions, seed and graph digest; stable across repeated runs. */
  runId: z.string().min(1).max(96),
});

export type ScoreboardIdentity = z.infer<typeof scoreboardIdentitySchema>;

export const scoreboardEvaluationCoreSchema = z.strictObject({
  status: z.enum(SCOREBOARD_STATUSES),
  passed: z.boolean(),
  levelId: z.literal(SCOREBOARD_LEVEL_ID),
  modelVersion: z.literal(SCOREBOARD_MODEL_VERSION),
  schemaVersion: z.literal(SCOREBOARD_SCHEMA_VERSION),
  contentVersion: z.literal(SCOREBOARD_CONTENT_VERSION),
  pricingVersion: z.literal(SCOREBOARD_PRICING_VERSION),
  seed: z.number().int().min(0).max(SCOREBOARD_MAX_SEED),
  graphDigest: z.string().min(1).max(64),
  runId: z.string().min(1).max(96),
  identity: scoreboardIdentitySchema,
  issues: z.array(scoreboardIssueSchema).max(SCOREBOARD_MAX_ISSUES),
  incompleteReasons: z
    .array(z.string().min(1).max(200))
    .max(SCOREBOARD_MAX_INCOMPLETE_REASONS),
  preparation: scoreboardPreparationSchema.nullable(),
  window: scoreboardWindowSchema.nullable(),
  gates: z.array(scoreboardGateSchema).max(SCOREBOARD_MAX_GATES),
  operations: z
    .strictObject({
      read: scoreboardOperationMetricsSchema,
      write: scoreboardOperationMetricsSchema,
      peak: z.strictObject({
        read: scoreboardOperationMetricsSchema,
        write: scoreboardOperationMetricsSchema,
      }),
    })
    .nullable(),
  nodes: z.array(scoreboardNodeMetricsSchema).max(SCOREBOARD_MAX_NODES),
  links: z.array(scoreboardLinkMetricsSchema).max(SCOREBOARD_MAX_LINKS),
  correctness: scoreboardCorrectnessSchema.nullable(),
  freshness: scoreboardFreshnessSchema.nullable(),
  cost: scoreboardCostSchema.nullable(),
  series: z
    .array(scoreboardSeriesPointSchema)
    .max(SCOREBOARD_MAX_SERIES_POINTS),
  trafficFrames: z
    .array(scoreboardTrafficFrameSchema)
    .max(SCOREBOARD_MAX_FRAMES),
});

/**
 * Cross-field invariants that ordinary shape parsing cannot express:
 * top-level identity must equal the nested canonical identity, and only a
 * completed run may report `passed: true`.
 */
export const scoreboardEvaluationSchema = scoreboardEvaluationCoreSchema.superRefine(
  (value, ctx) => {
    const pairs: {
      path: (string | number)[];
      actual: string | number;
      expected: string | number;
    }[] = [
      {
        path: ['identity', 'levelId'],
        actual: value.identity.levelId,
        expected: value.levelId,
      },
      {
        path: ['identity', 'modelVersion'],
        actual: value.identity.modelVersion,
        expected: value.modelVersion,
      },
      {
        path: ['identity', 'schemaVersion'],
        actual: value.identity.schemaVersion,
        expected: value.schemaVersion,
      },
      {
        path: ['identity', 'contentVersion'],
        actual: value.identity.contentVersion,
        expected: value.contentVersion,
      },
      {
        path: ['identity', 'pricingVersion'],
        actual: value.identity.pricingVersion,
        expected: value.pricingVersion,
      },
      {
        path: ['identity', 'seed'],
        actual: value.identity.seed,
        expected: value.seed,
      },
      {
        path: ['identity', 'graphDigest'],
        actual: value.identity.graphDigest,
        expected: value.graphDigest,
      },
      {
        path: ['identity', 'runId'],
        actual: value.identity.runId,
        expected: value.runId,
      },
    ];
    for (const pair of pairs) {
      if (pair.actual !== pair.expected) {
        ctx.addIssue({
          code: 'custom',
          path: pair.path,
          message: `Nested identity ${String(pair.path[1])} must equal the top-level value.`,
        });
      }
    }
    if (value.status !== 'complete' && value.passed) {
      ctx.addIssue({
        code: 'custom',
        path: ['passed'],
        message: 'Only a complete evaluation may pass.',
      });
    }
  },
);

export type ScoreboardEvaluation = z.infer<
  typeof scoreboardEvaluationCoreSchema
>;

export function scoreboardEvaluationJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(scoreboardEvaluationCoreSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id: 'https://system-design-game.local/schemas/live-scoreboard-result.json',
    title: 'Live Scoreboard evaluation result',
    allOf: [
      {
        if: {
          properties: { status: { enum: ['invalid', 'incomplete'] } },
          required: ['status'],
        },
        then: {
          properties: { passed: { const: false } },
          required: ['passed'],
        },
      },
    ],
  };
}

export function scoreboardGraphJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(scoreboardGraphSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id: 'https://system-design-game.local/schemas/live-scoreboard-graph.json',
    title: 'Live Scoreboard graph',
  };
}

export function scoreboardCatalogJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(scoreboardCatalogSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id: 'https://system-design-game.local/schemas/live-scoreboard-catalog.json',
    title: 'Live Scoreboard catalog',
  };
}

export function scoreboardLevelJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(scoreboardLevelSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id: 'https://system-design-game.local/schemas/live-scoreboard-level.json',
    title: 'Live Scoreboard level',
  };
}

export function parseScoreboardEvaluation(
  input: unknown,
): ScoreboardParseResult<ScoreboardEvaluation> {
  const parsed = scoreboardEvaluationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      value: null,
      issues: scoreboardIssuesFromZod(parsed.error),
    };
  }
  return { ok: true, value: parsed.data, issues: [] };
}

// ---------------------------------------------------------------------------
// Public runtime: synchronous evaluation plus an incremental session
// ---------------------------------------------------------------------------

export const SCOREBOARD_PHASES = [
  'validate',
  'prepare',
  'run',
  'drain',
  'done',
] as const;
export type ScoreboardPhase = (typeof SCOREBOARD_PHASES)[number];

export interface ScoreboardProgress {
  readonly phase: ScoreboardPhase;
  /** Absolute virtual milliseconds; 0 is the start of preparation. */
  readonly nowMs: number;
  readonly measuredElapsedMs: number;
  readonly completedRequests: number;
  readonly totalRequests: number;
  readonly message: string;
}

export interface ScoreboardAdvance {
  readonly done: boolean;
  readonly progress: ScoreboardProgress;
  /** Events processed during this call, bounded by the caller's budget. */
  readonly processedEvents: number;
  /** True when the event budget stopped this call with work still due. */
  readonly exhausted: boolean;
}

export interface ScoreboardRunOptions {
  readonly seed?: number;
  readonly onProgress?: (progress: ScoreboardProgress) => void;
  /** Bounded 1-second frames; never part of scoring. */
  readonly onTraffic?: (frame: TrafficFrame) => void;
  /** Per-advance event budget for cooperative browser scheduling. */
  readonly maxEventsPerAdvance?: number;
}

/**
 * One deterministic, resumable evaluation. `advance` only limits how many
 * scheduled events run per call; it never changes virtual time, event order or
 * random draws. The same implementation powers the synchronous evaluator.
 */
export interface ScoreboardSession {
  readonly identity: ScoreboardIdentity;
  readonly totalRequests: number;
  readonly done: boolean;
  progress(): ScoreboardProgress;
  advance(maxEvents?: number): ScoreboardAdvance;
  runToCompletion(maxEventsPerAdvance?: number): ScoreboardEvaluation;
  cancel(): void;
  result(): ScoreboardEvaluation | null;
}
