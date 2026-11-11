/**
 * Live Audience frozen public contract (A100).
 *
 * This module is the shared boundary for the evaluator (A101), the browser
 * worker/UI (A102), the agent CLI/API (A103) and tests. It contains plain data
 * types, versioned constants, strict Zod schemas and small pure helpers only.
 * It never imports React, the DOM, the evaluator or browser telemetry state.
 *
 * Product task: keep `Record activity` and `View audience ranking` working for
 * an exact top-20 ranking of unique viewers in the previous 15 minutes. A
 * repeated event never inflates a unique viewer, one viewer may watch several
 * streams, and a ranking answer must name the exact as-of snapshot it uses.
 */

import { z } from 'zod';

import type { TrafficFrame } from '../simulation/traffic-telemetry';

// ---------------------------------------------------------------------------
// Versions, identifiers and bounded public limits
// ---------------------------------------------------------------------------

export const AUDIENCE_SCHEMA_VERSION = 1 as const;
export const AUDIENCE_MODEL_VERSION = '1.0.0' as const;
export const AUDIENCE_CONTENT_VERSION = '1.0.0' as const;
export const AUDIENCE_PRICING_VERSION = 'audience-catalog-v1' as const;
export const AUDIENCE_PROFILE_VERSION = 'app-resilience-v1' as const;
export const AUDIENCE_LEVEL_ID = 'live-audience' as const;
/** Unsigned 31-bit seeds stay portable across JSON, xorshift and SQL. */
export const AUDIENCE_MAX_SEED = 2_147_483_647;

export const AUDIENCE_MAX_ISSUES = 32;
export const AUDIENCE_MAX_INCOMPLETE_REASONS = 16;
export const AUDIENCE_MAX_CASES = 6;
export const AUDIENCE_MAX_GATES = 16;
export const AUDIENCE_MAX_NODES = 6;
export const AUDIENCE_MAX_EDGES = 8;
export const AUDIENCE_MAX_LINKS = 8;
export const AUDIENCE_MAX_FRAMES = 240;
export const AUDIENCE_MAX_SERIES_POINTS = 240;
export const AUDIENCE_MAX_INCIDENT_EVENTS = 64;
export const AUDIENCE_MAX_INSTANCES_PER_NODE = 4;
export const AUDIENCE_MAX_TRAFFIC_NODES = 24;
export const AUDIENCE_MAX_TRAFFIC_EDGES = 16;
export const AUDIENCE_MAX_TRAFFIC_RESOURCES_PER_NODE = 24;

export const AUDIENCE_NODE_KINDS = [
  'users',
  'lb',
  'app',
  'sql',
  'cache',
  'worker',
] as const;
export const AUDIENCE_SQL_SIZES = ['small', 'medium', 'large'] as const;
export const AUDIENCE_SQL_READ_PLANS = ['query', 'projection'] as const;
export const AUDIENCE_CACHE_TTLS_SECONDS = [0.5, 2, 5, 15] as const;
export const AUDIENCE_OPERATIONS = ['ingest', 'read'] as const;
export const AUDIENCE_WINDOWS = ['whole', 'critical'] as const;
export const AUDIENCE_STATUSES = [
  'invalid',
  'incomplete',
  'complete',
  'cancelled',
] as const;
export const AUDIENCE_CASE_STATUSES = [
  'incomplete',
  'complete',
  'cancelled',
] as const;
export const AUDIENCE_CASE_KINDS = [
  'normal',
  'peak',
  'app-instance-failure',
] as const;
export const AUDIENCE_CASE_IDS = [
  'normal',
  'peak',
  'app-failure-0',
  'app-failure-1',
  'app-failure-2',
  'app-failure-3',
] as const;
export const AUDIENCE_LINK_ROLES = [
  'traffic',
  'ingress',
  'balance',
  'primary',
  'reads',
  'fill',
  'projection',
] as const;

/**
 * Frozen required gate ids. A complete case must carry exactly the set derived
 * from its case kind; a caller cannot choose a cheaper subset. The whole-case
 * availability/p95 pair is mandatory for both operations. Peak and fault cases
 * add the same pair for their critical offer cohort.
 */
export const AUDIENCE_GATE_IDS = [
  'ingest-whole-availability',
  'ingest-whole-p95',
  'read-whole-availability',
  'read-whole-p95',
  'ingest-critical-availability',
  'ingest-critical-p95',
  'read-critical-availability',
  'read-critical-p95',
  'data-preservation',
  'ranking-correctness',
  'freshness',
  'drain-complete',
] as const;

export type AudienceGateId = (typeof AUDIENCE_GATE_IDS)[number];

export type AudienceNodeKind = (typeof AUDIENCE_NODE_KINDS)[number];
export type AudienceSqlSize = (typeof AUDIENCE_SQL_SIZES)[number];
export type AudienceSqlReadPlan = (typeof AUDIENCE_SQL_READ_PLANS)[number];
export type AudienceCacheTtlSeconds =
  (typeof AUDIENCE_CACHE_TTLS_SECONDS)[number];
export type AudienceOperation = (typeof AUDIENCE_OPERATIONS)[number];
export type AudienceWindow = (typeof AUDIENCE_WINDOWS)[number];
export type AudienceStatus = (typeof AUDIENCE_STATUSES)[number];
export type AudienceCaseStatus = (typeof AUDIENCE_CASE_STATUSES)[number];
export type AudienceCaseKind = (typeof AUDIENCE_CASE_KINDS)[number];
export type AudienceCaseId = (typeof AUDIENCE_CASE_IDS)[number];
export type AudienceLinkRole = (typeof AUDIENCE_LINK_ROLES)[number];

export const AUDIENCE_OPERATION_LABELS = {
  ingest: 'Record activity',
  read: 'View audience ranking',
} as const;

export interface AudienceGateSpec {
  readonly id: AudienceGateId;
  readonly label: string;
  readonly severity: 'required';
  readonly operation?: AudienceOperation;
  readonly window?: AudienceWindow;
  readonly metric: string;
  readonly unit: string;
  readonly comparison: 'max' | 'min' | 'none';
}

const OPERATION_GATE_LABELS = {
  ingest: 'Record activity',
  read: 'View audience ranking',
} as const;

/** Gate set for one case kind. Order is stable for UI, CLI and API. */
export function audienceRequiredGateSpecs(
  kind: AudienceCaseKind,
): readonly AudienceGateSpec[] {
  const specs: AudienceGateSpec[] = [];
  for (const operation of AUDIENCE_OPERATIONS) {
    specs.push({
      id: `${operation}-whole-availability`,
      label: `${OPERATION_GATE_LABELS[operation]} availability (whole case)`,
      severity: 'required',
      operation,
      window: 'whole',
      metric: 'availability',
      unit: 'ratio',
      comparison: 'min',
    });
    specs.push({
      id: `${operation}-whole-p95`,
      label: `${OPERATION_GATE_LABELS[operation]} successful p95 (whole case)`,
      severity: 'required',
      operation,
      window: 'whole',
      metric: 'successfulP95Ms',
      unit: 'ms',
      comparison: 'max',
    });
  }
  if (kind !== 'normal') {
    for (const operation of AUDIENCE_OPERATIONS) {
      specs.push({
        id: `${operation}-critical-availability`,
        label: `${OPERATION_GATE_LABELS[operation]} availability (critical cohort)`,
        severity: 'required',
        operation,
        window: 'critical',
        metric: 'availability',
        unit: 'ratio',
        comparison: 'min',
      });
      specs.push({
        id: `${operation}-critical-p95`,
        label: `${OPERATION_GATE_LABELS[operation]} successful p95 (critical cohort)`,
        severity: 'required',
        operation,
        window: 'critical',
        metric: 'successfulP95Ms',
        unit: 'ms',
        comparison: 'max',
      });
    }
  }
  specs.push(
    {
      id: 'data-preservation',
      label: 'Acknowledged events preserved exactly once',
      severity: 'required',
      metric: 'preservation',
      unit: 'boolean',
      comparison: 'none',
    },
    {
      id: 'ranking-correctness',
      label: 'Exact ranking snapshots match the reference',
      severity: 'required',
      metric: 'exactSnapshotCorrectness',
      unit: 'boolean',
      comparison: 'none',
    },
    {
      id: 'freshness',
      label: 'Every successful ranking is fresh at delivery',
      severity: 'required',
      metric: 'freshnessLagMs',
      unit: 'ms',
      comparison: 'none',
    },
    {
      id: 'drain-complete',
      label: 'Bounded drain completed with no pending request',
      severity: 'required',
      metric: 'pendingRequests',
      unit: 'count',
      comparison: 'max',
    },
  );
  return specs;
}

export function audienceRequiredGateIds(
  kind: AudienceCaseKind,
): readonly AudienceGateId[] {
  return audienceRequiredGateSpecs(kind).map((spec) => spec.id);
}

// ---------------------------------------------------------------------------
// Frozen workload and fault-policy values shared by catalog, level and helpers
// ---------------------------------------------------------------------------

export const AUDIENCE_MEASURED_MS = 90_000;
export const AUDIENCE_DRAIN_MS = 10_000;
export const AUDIENCE_ACTIVITY_WINDOW_MS = 900_000;
export const AUDIENCE_TOP_N = 20;
export const AUDIENCE_REQUEST_DEADLINE_MS = 1_000;
export const AUDIENCE_MIN_LATENCY_SAMPLES = 100;
export const AUDIENCE_AVAILABILITY_SLO = 0.995;
export const AUDIENCE_SUCCESSFUL_P95_MS = 250;
export const AUDIENCE_FRESHNESS_MS = 5_000;
export const AUDIENCE_INGEST_EVENTS_PER_SECOND = 2_000;

export const AUDIENCE_PEAK_WINDOW = { fromMs: 20_000, toMs: 60_000 } as const;
export const AUDIENCE_FAULT_CRITICAL_WINDOW = {
  fromMs: 30_000,
  toMs: 50_000,
} as const;

export const AUDIENCE_NORMAL_READ_PHASES = [
  { fromMs: 0, toMs: AUDIENCE_MEASURED_MS, readsPerSecond: 10 },
] as const;
export const AUDIENCE_PEAK_READ_PHASES = [
  { fromMs: 0, toMs: 20_000, readsPerSecond: 10 },
  { fromMs: 20_000, toMs: 60_000, readsPerSecond: 200 },
  { fromMs: 60_000, toMs: 90_000, readsPerSecond: 10 },
] as const;

/** Dataset size is frozen by the level, not by a submitted graph. */
export const AUDIENCE_DATASET = {
  users: 1_000_000,
  streams: 100,
  prehistoryEvents: 1_800_000,
  eventBytes: 128,
  prehistoryRawBytes: 230_400_000,
  rankingBytes: 4_096,
  ingestAckBytes: 200,
} as const;

/**
 * Fixed lifecycle for one physical Application instance inside a fault case.
 * Crash time is relative to measured traffic start. Readiness is announced only
 * after two successful health checks; the restarted process starts with empty
 * volatile state while durable SQL data survives.
 */
export const AUDIENCE_FAULT_SCHEDULE = {
  kind: 'app-instance-crash',
  crashAtMs: 30_000,
  downMs: 15_000,
  bootMs: 1_000,
  restartCount: 1,
} as const;

/**
 * Probes start at measured 0 and repeat every 250 ms per physical instance.
 * A failure is counted only when its 100 ms probe times out; a success is
 * counted when the probe response completes. Two consecutive outcomes flip
 * LB-known health. Actual process health and LB-known health are separate.
 */
export const AUDIENCE_HEALTH_POLICY = {
  probeStartAtMs: 0,
  intervalMs: 250,
  timeoutMs: 100,
  failuresToUnhealthy: 2,
  successesToReady: 2,
  failureCountedAt: 'timeout',
  successCountedAt: 'completion',
} as const;

export const AUDIENCE_RETRY_POLICY = {
  maxRetries: 1,
  backoffMs: 25,
  sameIdempotencyKey: true,
  useDifferentEligibleBackend: true,
  excludeLastAttemptBackend: true,
  useRemainingDeadline: true,
  noRetryOn: ['queue-overflow', 'validation', 'business-failure'],
} as const;

export const AUDIENCE_QUEUE_LIMITS = {
  appWaitingPerInstance: 256,
  sqlWaiting: 128,
  cacheWaiting: 512,
} as const;

/**
 * A projection publishes an ordered prefix only after every outbox event up to
 * that cursor and all required expiry work are durable. A 100 ms heartbeat is
 * real expiry/index work when no events arrive, never a timestamp stamp.
 */
export const AUDIENCE_PROJECTION_POLICY = {
  maxBatchEvents: 128,
  flushMs: 100,
  heartbeatMs: 100,
  maxWorkerInstances: 4,
  jobRowsAreTheQueue: true,
  orderedPrefixPublication: true,
  reorderBufferEvents: 128,
} as const;

/** Physical Application slots are homogeneous and zero-based. */
export const AUDIENCE_ROUTING_POLICY = {
  physicalSlots: '0..instances-1',
  directPathTarget: 0,
  loadBalancerInitialBackend: 0,
  sparesAreNotRoutedWithoutLb: true,
} as const;

export const AUDIENCE_IDEMPOTENCY_POLICY = {
  eventIdBindsPayload: true,
  duplicateSamePayload: 'replay-original',
  mismatch: 'conflict-no-effect',
  retryAfterUnknownCommit: 'same-id',
} as const;

/**
 * Deterministic scheduler tie order for this level, lower first. Insertion
 * order is stable inside a priority. The shared kernel is unchanged; this level
 * only documents the ordering it relies on for reproducible crash cases.
 */
export const AUDIENCE_EVENT_PRIORITIES = [
  { event: 'injected-crash', priority: -10 },
  { event: 'boot-completion', priority: -5 },
  { event: 'resource-or-network-completion', priority: 0 },
  { event: 'request-task-or-probe-timeout', priority: 1 },
  { event: 'health-result-publication', priority: 2 },
  { event: 'arrival-or-probe-launch', priority: 3 },
  { event: 'background-poll-or-heartbeat', priority: 4 },
] as const;

/**
 * A process crash closes existing connections instead of pretending the host
 * vanished. Through the LB the client observes the drop after 1 ms internal
 * propagation + 10 ms client one-way hop; a direct client sees 10 ms. A new
 * attempt to a process known dead uses a fixed 100 ms connect timeout.
 */
export const AUDIENCE_FAULT_CONNECTION_POLICY = {
  viaLbLostConnectionMs: 11,
  directLostConnectionMs: 10,
  newAttemptToDeadProcessTimeoutMs: 100,
  retryBackoffMs: 25,
} as const;

export const AUDIENCE_CACHE_POLICY = {
  coalescing: 'fixed-on',
  entryBytes: 4_096,
  capacityBytes: 4_096,
  /** TTL is the actual selected retention, never clamped to the SLO. */
  retention: 'selected-ttl',
  /** A hit returns the payload's original snapshot tuple, never a relabel. */
  responseSnapshot: 'original',
  eviction: 'ttl-only',
  deliveryAudit: 'freshness-gate',
} as const;

export const AUDIENCE_NETWORK_POLICY = {
  clientRttMs: 20,
  internalOneWayMs: 1,
  laneGbitPerSec: 1,
  rankingRequestBytes: 256,
  rankingResponseBytes: 4_096,
  ingestRequestBytes: 128,
  ingestAckBytes: 200,
  responseBytesUsdPerGb: 0.02,
  bytesPerGb: 1_000_000_000,
} as const;

// ---------------------------------------------------------------------------
// Issues and parse result
// ---------------------------------------------------------------------------

export const AUDIENCE_ISSUE_SEVERITIES = ['error', 'warning', 'info'] as const;
export type AudienceIssueSeverity =
  (typeof AUDIENCE_ISSUE_SEVERITIES)[number];

export const audienceIssueSchema = z.strictObject({
  severity: z.enum(AUDIENCE_ISSUE_SEVERITIES),
  code: z.string().min(1).max(96),
  message: z.string().min(1).max(2_000),
  path: z.string().min(1).max(200).optional(),
  nodeId: z.string().min(1).max(64).optional(),
  edgeId: z.string().min(1).max(64).optional(),
  caseId: z.enum(AUDIENCE_CASE_IDS).optional(),
  operation: z.enum(AUDIENCE_OPERATIONS).optional(),
  metric: z.string().min(1).max(96).optional(),
  value: z.number().finite().optional(),
  limit: z.number().finite().optional(),
  /** Aggregated occurrences; one issue is never emitted per request. */
  count: z.number().int().min(1).optional(),
});

export type AudienceIssue = z.infer<typeof audienceIssueSchema>;

export type AudienceParseResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly issues: readonly AudienceIssue[];
    }
  | {
      readonly ok: false;
      readonly value: null;
      readonly issues: readonly AudienceIssue[];
    };

/** Convert a Zod error into bounded English product issues. */
export function audienceIssuesFromZod(
  error: z.ZodError,
  pathPrefix = '',
  maxIssues = AUDIENCE_MAX_ISSUES,
): AudienceIssue[] {
  const limit = Math.max(1, Math.floor(maxIssues));
  const issues: AudienceIssue[] = [];
  let omitted = 0;
  const push = (value: AudienceIssue): void => {
    if (issues.length < limit - 1) {
      issues.push(value);
    } else {
      omitted += 1;
    }
  };
  for (const item of error.issues) {
    const path = [
      ...item.path.map(String),
      ...(pathPrefix === '' ? [] : [pathPrefix]),
    ]
      .filter((part) => part.length > 0)
      .join('.')
      .slice(0, 200);
    const base = {
      severity: 'error' as const,
      message: String(item.message).slice(0, 2_000),
      ...(path === '' ? {} : { path }),
    };
    if (String(item.code) === 'unrecognized_keys') {
      const keys =
        'keys' in item && Array.isArray(item.keys)
          ? item.keys.map(String)
          : [];
      const shown = keys.slice(0, 8);
      const suffix =
        keys.length > shown.length
          ? ` (+${keys.length - shown.length} more)`
          : '';
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
      String(item.code) === 'invalid_type'
        ? 'invalid_type'
        : String(item.code) === 'too_small' || String(item.code) === 'too_big'
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

export const audiencePositionSchema = z.strictObject({
  x: z.number().finite().min(-1_000_000).max(1_000_000),
  y: z.number().finite().min(-1_000_000).max(1_000_000),
});

export const audienceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, digits, "-" or "_".');

export const audienceLabelSchema = z.string().min(1).max(120);

const nodeBase = {
  id: audienceIdSchema,
  label: audienceLabelSchema,
  position: audiencePositionSchema,
};

export const audienceUsersNodeSchema = z.strictObject({
  ...nodeBase,
  kind: z.literal('users'),
  config: z.strictObject({}),
});

export const audienceLbNodeSchema = z.strictObject({
  ...nodeBase,
  kind: z.literal('lb'),
  config: z.strictObject({}),
});

export const audienceAppConfigSchema = z.strictObject({
  /** One visible service pool; instances are charged and add real capacity. */
  instances: z.number().int().min(1).max(4),
});

export const audienceSqlConfigSchema = z.strictObject({
  size: z.enum(AUDIENCE_SQL_SIZES),
  readPlan: z.enum(AUDIENCE_SQL_READ_PLANS),
});

export const audienceCacheConfigSchema = z.strictObject({
  ttlSeconds: z.union([
    z.literal(0.5),
    z.literal(2),
    z.literal(5),
    z.literal(15),
  ]),
});

export const audienceWorkerConfigSchema = z.strictObject({
  instances: z.number().int().min(1).max(4),
});

export const audienceAppNodeSchema = z.strictObject({
  ...nodeBase,
  kind: z.literal('app'),
  config: audienceAppConfigSchema,
});

export const audienceSqlNodeSchema = z.strictObject({
  ...nodeBase,
  kind: z.literal('sql'),
  config: audienceSqlConfigSchema,
});

export const audienceCacheNodeSchema = z.strictObject({
  ...nodeBase,
  kind: z.literal('cache'),
  config: audienceCacheConfigSchema,
});

export const audienceWorkerNodeSchema = z.strictObject({
  ...nodeBase,
  kind: z.literal('worker'),
  config: audienceWorkerConfigSchema,
});

export const audienceNodeSchema = z.discriminatedUnion('kind', [
  audienceUsersNodeSchema,
  audienceLbNodeSchema,
  audienceAppNodeSchema,
  audienceSqlNodeSchema,
  audienceCacheNodeSchema,
  audienceWorkerNodeSchema,
]);

export type AudienceUsersNode = z.infer<typeof audienceUsersNodeSchema>;
export type AudienceLbNode = z.infer<typeof audienceLbNodeSchema>;
export type AudienceAppNode = z.infer<typeof audienceAppNodeSchema>;
export type AudienceSqlNode = z.infer<typeof audienceSqlNodeSchema>;
export type AudienceCacheNode = z.infer<typeof audienceCacheNodeSchema>;
export type AudienceWorkerNode = z.infer<typeof audienceWorkerNodeSchema>;
export type AudienceNode = z.infer<typeof audienceNodeSchema>;
export type AudienceNodeConfig = AudienceNode['config'];

export const audienceEdgeSchema = z.strictObject({
  id: audienceIdSchema,
  from: audienceIdSchema,
  to: audienceIdSchema,
});

export type AudienceEdge = z.infer<typeof audienceEdgeSchema>;

export const audienceGraphSchema = z.strictObject({
  schemaVersion: z.literal(AUDIENCE_SCHEMA_VERSION),
  levelId: z.literal(AUDIENCE_LEVEL_ID),
  nodes: z.array(audienceNodeSchema).min(1).max(AUDIENCE_MAX_NODES),
  edges: z.array(audienceEdgeSchema).max(AUDIENCE_MAX_EDGES),
});

export type AudienceGraph = z.infer<typeof audienceGraphSchema>;

/**
 * Link role is inferred from the component pair. `traffic` is a direct
 * Users -> Application edge; `ingress` + `balance` is the managed-LB path.
 * `primary` carries ingest and direct reads, `reads`/`fill` form the cache
 * path, and `projection` is the Worker -> SQL RPC dependency (one edge, no
 * separate broker graph).
 */
export function audienceLinkRole(
  from: AudienceNodeKind,
  to: AudienceNodeKind,
): AudienceLinkRole | null {
  if (from === 'users' && to === 'app') {
    return 'traffic';
  }
  if (from === 'users' && to === 'lb') {
    return 'ingress';
  }
  if (from === 'lb' && to === 'app') {
    return 'balance';
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
  if (from === 'worker' && to === 'sql') {
    return 'projection';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Challenge profile and case ids
// ---------------------------------------------------------------------------

export const audienceWindowRangeSchema = z.strictObject({
  fromMs: z.number().finite().nonnegative(),
  toMs: z.number().finite().positive(),
});

export const audienceCaseTrafficSchema = z.strictObject({
  readPhases: z
    .array(
      z.strictObject({
        fromMs: z.number().finite().nonnegative(),
        toMs: z.number().finite().positive(),
        readsPerSecond: z.number().finite().nonnegative(),
      }),
    )
    .min(1)
    .max(4),
  ingestEventsPerSecond: z.number().finite().nonnegative(),
  /** All designs and cases in one seed replay the same frozen input trace. */
  trace: z.literal('same-seed-input'),
});

export const audienceFaultScheduleSchema = z.strictObject({
  kind: z.literal(AUDIENCE_FAULT_SCHEDULE.kind),
  crashAtMs: z.number().finite().nonnegative(),
  downMs: z.number().finite().positive(),
  bootMs: z.number().finite().nonnegative(),
  restartCount: z.number().int().min(1).max(1),
});

export const audienceCaseSpecSchema = z
  .strictObject({
    id: z.enum(AUDIENCE_CASE_IDS),
    kind: z.enum(AUDIENCE_CASE_KINDS),
    label: z.string().min(1).max(200),
    /** Physical Application instance index; null for non-fault cases. */
    targetInstance: z
      .number()
      .int()
      .min(0)
      .max(AUDIENCE_MAX_INSTANCES_PER_NODE - 1)
      .nullable(),
    traffic: audienceCaseTrafficSchema,
    fault: audienceFaultScheduleSchema.nullable(),
    criticalWindow: audienceWindowRangeSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const expectedKind: AudienceCaseKind =
      value.id === 'normal'
        ? 'normal'
        : value.id === 'peak'
          ? 'peak'
          : 'app-instance-failure';
    if (value.kind !== expectedKind) {
      ctx.addIssue({
        code: 'custom',
        path: ['kind'],
        message: `Case "${value.id}" must use kind "${expectedKind}".`,
      });
    }
    if (expectedKind === 'app-instance-failure') {
      const expectedIndex = Number(value.id.slice('app-failure-'.length));
      if (value.targetInstance !== expectedIndex) {
        ctx.addIssue({
          code: 'custom',
          path: ['targetInstance'],
          message: `Case "${value.id}" must target Application instance ${expectedIndex}.`,
        });
      }
      if (value.fault === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['fault'],
          message: 'An Application-instance failure case needs a fault schedule.',
        });
      }
      if (value.criticalWindow === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['criticalWindow'],
          message: 'An Application-instance failure case needs a critical window.',
        });
      }
    } else {
      if (value.targetInstance !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['targetInstance'],
          message: 'A non-fault case cannot target a physical instance.',
        });
      }
      if (value.fault !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['fault'],
          message: 'A non-fault case cannot contain a fault schedule.',
        });
      }
      if (value.kind === 'normal' && value.criticalWindow !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['criticalWindow'],
          message: 'Normal traffic has no separate critical failure window.',
        });
      }
    }
  });

export type AudienceCaseSpec = z.infer<typeof audienceCaseSpecSchema>;
export type AudienceCaseTraffic = z.infer<typeof audienceCaseTrafficSchema>;
export type AudienceFaultSchedule = z.infer<
  typeof audienceFaultScheduleSchema
>;
export type AudienceWindowRange = z.infer<typeof audienceWindowRangeSchema>;

export const audienceChallengeProfileSchema = z
  .strictObject({
    profileVersion: z.literal(AUDIENCE_PROFILE_VERSION),
    appInstances: z.number().int().min(1).max(AUDIENCE_MAX_INSTANCES_PER_NODE),
    cases: z.array(audienceCaseSpecSchema).min(1).max(AUDIENCE_MAX_CASES),
    requiredCaseIds: z.array(z.enum(AUDIENCE_CASE_IDS)).min(1).max(
      AUDIENCE_MAX_CASES,
    ),
    scoreCaseId: z.literal('peak'),
    qualification: z.literal('all-required-cases'),
    prehistoryReset: z.literal('identical-per-case'),
    costPolicy: z.literal('peak-actual-only'),
  })
  .superRefine((value, ctx) => {
    const expected = [
      'normal',
      'peak',
      ...Array.from(
        { length: value.appInstances },
        (_, index) => `app-failure-${index}`,
      ),
    ];
    if (
      value.requiredCaseIds.length !== expected.length ||
      value.requiredCaseIds.some((id, index) => id !== expected[index])
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['requiredCaseIds'],
        message:
          'Required cases must be normal, peak and one failure case per Application instance in order.',
      });
    }
    const caseIds = value.cases.map((item) => item.id);
    if (new Set(caseIds).size !== caseIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['cases'],
        message: 'Challenge case ids must be unique.',
      });
    }
    if (
      caseIds.length !== expected.length ||
      expected.some((id) => !caseIds.includes(id as AudienceCaseId))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['cases'],
        message: 'The challenge profile must describe every required case.',
      });
    }
    for (const item of value.cases) {
      if (item.kind === 'app-instance-failure') {
        const index = Number(item.id.slice('app-failure-'.length));
        if (index >= value.appInstances) {
          ctx.addIssue({
            code: 'custom',
            path: ['cases'],
            message: `Case "${item.id}" targets an instance that is not provisioned.`,
          });
        }
      }
    }
  });

export type AudienceChallengeProfile = z.infer<
  typeof audienceChallengeProfileSchema
>;

/** Stable case id for one physical Application instance. */
export function audienceAppFailureCaseId(
  instanceIndex: number,
): AudienceCaseId {
  if (
    !Number.isInteger(instanceIndex) ||
    instanceIndex < 0 ||
    instanceIndex >= AUDIENCE_MAX_INSTANCES_PER_NODE
  ) {
    throw new RangeError('Application instance index must be 0..3.');
  }
  return `app-failure-${instanceIndex}` as AudienceCaseId;
}

/** Required qualification cases for the graph's provisioned app instances. */
export function audienceRequiredCaseIds(
  appInstances: number,
): readonly AudienceCaseId[] {
  if (
    !Number.isInteger(appInstances) ||
    appInstances < 1 ||
    appInstances > AUDIENCE_MAX_INSTANCES_PER_NODE
  ) {
    throw new RangeError('Application instances must be an integer 1..4.');
  }
  return [
    'normal',
    'peak',
    ...Array.from({ length: appInstances }, (_, index) =>
      audienceAppFailureCaseId(index),
    ),
  ];
}

/**
 * Derive the frozen profile for one graph. Every provisioned Application
 * instance is crashed once under the same peak traffic. Fault cases reuse the
 * exact peak input trace; only the forced lifecycle differs.
 */
export function createAudienceChallengeProfile(
  appInstances: number,
): AudienceChallengeProfile {
  const requiredCaseIds = audienceRequiredCaseIds(appInstances);
  const peakTraffic: AudienceCaseTraffic = {
    readPhases: AUDIENCE_PEAK_READ_PHASES.map((phase) => ({ ...phase })),
    ingestEventsPerSecond: AUDIENCE_INGEST_EVENTS_PER_SECOND,
    trace: 'same-seed-input',
  };
  const cases: AudienceCaseSpec[] = [
    {
      id: 'normal',
      kind: 'normal',
      label: 'Normal traffic',
      targetInstance: null,
      traffic: {
        readPhases: AUDIENCE_NORMAL_READ_PHASES.map((phase) => ({ ...phase })),
        ingestEventsPerSecond: AUDIENCE_INGEST_EVENTS_PER_SECOND,
        trace: 'same-seed-input',
      },
      fault: null,
      criticalWindow: null,
    },
    {
      id: 'peak',
      kind: 'peak',
      label: 'Peak traffic',
      targetInstance: null,
      traffic: peakTraffic,
      fault: null,
      criticalWindow: { ...AUDIENCE_PEAK_WINDOW },
    },
  ];
  for (const id of requiredCaseIds) {
    if (!id.startsWith('app-failure-')) {
      continue;
    }
    const instanceIndex = Number(id.slice('app-failure-'.length));
    cases.push({
      id,
      kind: 'app-instance-failure',
      label: `Peak + Application instance ${instanceIndex} failure`,
      targetInstance: instanceIndex,
      traffic: {
        readPhases: peakTraffic.readPhases.map((phase) => ({ ...phase })),
        ingestEventsPerSecond: peakTraffic.ingestEventsPerSecond,
        trace: 'same-seed-input',
      },
      fault: { ...AUDIENCE_FAULT_SCHEDULE },
      criticalWindow: { ...AUDIENCE_FAULT_CRITICAL_WINDOW },
    });
  }
  return audienceChallengeProfileSchema.parse({
    profileVersion: AUDIENCE_PROFILE_VERSION,
    appInstances,
    cases,
    requiredCaseIds,
    scoreCaseId: 'peak',
    qualification: 'all-required-cases',
    prehistoryReset: 'identical-per-case',
    costPolicy: 'peak-actual-only',
  });
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const positive = z.number().finite().positive();
const nonNegative = z.number().finite().nonnegative();

const audienceComponentBase = {
  label: z.string().min(1).max(120),
  notes: z.string().min(1).max(2_000),
};

const sqlSizeSpec = z.strictObject({
  cores: positive,
  memoryGb: positive,
  diskGb: positive,
  nicGbitPerSec: positive,
  hourlyUsd: nonNegative,
});

export const audienceCatalogSchema = z.strictObject({
  schemaVersion: z.literal(AUDIENCE_SCHEMA_VERSION),
  pricingVersion: z.literal(AUDIENCE_PRICING_VERSION),
  profileVersion: z.literal(AUDIENCE_PROFILE_VERSION),
  currency: z.literal('USD'),
  priceNote: z.string().min(1).max(2_000),
  componentPalette: z.array(z.enum(AUDIENCE_NODE_KINDS)).length(6),
  components: z.strictObject({
    users: z.strictObject({
      kind: z.literal('users'),
      ...audienceComponentBase,
      fixed: z.literal(true),
      configurableFields: z.array(z.string()).max(0),
    }),
    lb: z.strictObject({
      kind: z.literal('lb'),
      ...audienceComponentBase,
      fixed: z.literal(false),
      configurableFields: z.array(z.string()).max(0),
      capacityRequestsPerSec: positive,
      capacityGbitPerSec: positive,
      /** Physical CPU cores the managed service exposes for request handling. */
      cpuCores: positive,
      hourlyUsd: nonNegative,
      managedService: z.literal(true),
      healthCheck: z.strictObject({
        probeStartAtMs: nonNegative,
        intervalMs: positive,
        timeoutMs: positive,
        failuresToUnhealthy: z.number().int().min(1),
        successesToReady: z.number().int().min(1),
        failureCountedAt: z.literal('timeout'),
        successCountedAt: z.literal('completion'),
      }),
    }),
    app: z.strictObject({
      kind: z.literal('app'),
      ...audienceComponentBase,
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
      hourlyUsdPerInstance: nonNegative,
      waitingTasksPerInstance: z.number().int().positive(),
    }),
    sql: z.strictObject({
      kind: z.literal('sql'),
      ...audienceComponentBase,
      fixed: z.literal(false),
      configurableFields: z.array(z.enum(['size', 'readPlan'])).length(2),
      sizes: z.strictObject({
        small: sqlSizeSpec,
        medium: sqlSizeSpec,
        large: sqlSizeSpec,
      }),
      readPlans: z.strictObject({
        query: z.strictObject({
          label: z.string().min(1).max(120),
          description: z.string().min(1).max(2_000),
        }),
        projection: z.strictObject({
          label: z.string().min(1).max(120),
          description: z.string().min(1).max(2_000),
        }),
      }),
      waitingTasks: z.number().int().positive(),
    }),
    cache: z.strictObject({
      kind: z.literal('cache'),
      ...audienceComponentBase,
      fixed: z.literal(false),
      configurableFields: z.array(z.literal('ttlSeconds')).length(1),
      ttlOptionsSeconds: z
        .array(
          z.union([
            z.literal(0.5),
            z.literal(2),
            z.literal(5),
            z.literal(15),
          ]),
        )
        .length(4),
      capacityBytes: positive,
      entryBytes: positive,
      coalescing: z.literal('fixed-on'),
      cpuCores: positive,
      memoryGb: positive,
      nicGbitPerSec: positive,
      hourlyUsd: nonNegative,
      waitingTasks: z.number().int().positive(),
    }),
    worker: z.strictObject({
      kind: z.literal('worker'),
      ...audienceComponentBase,
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
      hourlyUsdPerInstance: nonNegative,
      waitingTasks: z.number().int().positive(),
    }),
  }),
  work: z.strictObject({
    queryScanCoreMsPerEvent: positive,
    queryDistinctCoreMsPerPair: positive,
    queryResultGroupSortCoreMs: positive,
    projectionDistinctCoreMsPerEvent: positive,
    projectionMaintenanceCoreMsPerEvent: positive,
    projectionApplySqlCoreMsPerEvent: positive,
    projectionApplySqlDiskMsPerEvent: positive,
    projectionIndexCoreMsPerEvent: positive,
    projectionHeartbeatCoreMs: positive,
    projectionReorderCoreMsPerEvent: positive,
    projectionPublishCoreMsPerBatch: positive,
    workerClaimCoreMsPerBatch: positive,
    workerFlushCoreMs: positive,
    queryIndexBuildCoreMsPerEvent: positive,
    projectionBuildCoreMsPerEvent: positive,
    sqlAppendCoreMsPerEvent: positive,
    sqlAppendDiskMsPerEvent: positive,
    sqlAppendBytesPerEvent: positive,
    appIngestCoreMs: positive,
    appReadCoreMs: positive,
    cacheLookupCoreMs: positive,
    cacheStoreCoreMs: positive,
    clientRequestProcessingMs: positive,
    clientResponseProcessingMs: positive,
    lbRequestCoreMs: positive,
    lbProbeCoreMs: positive,
  }),
  storage: z.strictObject({
    rawEventBytes: positive,
    queryIndexBytesPerEvent: positive,
    queryWorkingPairBytes: positive,
    projectionPairBytes: positive,
    outboxJobBytes: positive,
    cacheEntryBytes: positive,
    /** Aggregate bulk build/provision rate for the SQL instance, in bytes/ms. */
    bulkBuildBytesPerMs: positive,
  }),
  network: z.strictObject({
    clientRttMs: positive,
    internalOneWayMs: positive,
    laneGbitPerSec: z.literal(1),
    rankingRequestBytes: positive,
    rankingResponseBytes: positive,
    ingestRequestBytes: positive,
    ingestAckBytes: positive,
  }),
  billing: z.strictObject({
    responseBytesUsdPerGb: nonNegative,
    bytesPerGb: z.literal(1_000_000_000),
  }),
  policies: z.strictObject({
    health: z.strictObject({
      probeStartAtMs: nonNegative,
      intervalMs: positive,
      timeoutMs: positive,
      failuresToUnhealthy: z.number().int().min(1),
      successesToReady: z.number().int().min(1),
      failureCountedAt: z.literal('timeout'),
      successCountedAt: z.literal('completion'),
    }),
    fault: audienceFaultScheduleSchema,
    retry: z.strictObject({
      maxRetries: z.literal(1),
      backoffMs: nonNegative,
      sameIdempotencyKey: z.literal(true),
      useDifferentEligibleBackend: z.literal(true),
      excludeLastAttemptBackend: z.literal(true),
      useRemainingDeadline: z.literal(true),
      noRetryOn: z
        .array(
          z.enum(['queue-overflow', 'validation', 'business-failure']),
        )
        .length(3),
    }),
    queues: z.strictObject({
      appWaitingPerInstance: z.number().int().positive(),
      sqlWaiting: z.number().int().positive(),
      cacheWaiting: z.number().int().positive(),
      overflow: z.literal('reject'),
    }),
    projection: z.strictObject({
      maxBatchEvents: z.number().int().positive(),
      flushMs: positive,
      heartbeatMs: positive,
      maxWorkerInstances: z.number().int().min(1).max(4),
      jobRowsAreTheQueue: z.literal(true),
      orderedPrefixPublication: z.literal(true),
      reorderBufferEvents: z.number().int().positive(),
    }),
    cache: z.strictObject({
      coalescing: z.literal('fixed-on'),
      entryBytes: positive,
      capacityBytes: positive,
      retention: z.literal('selected-ttl'),
      responseSnapshot: z.literal('original'),
      eviction: z.literal('ttl-only'),
      deliveryAudit: z.literal('freshness-gate'),
    }),
    routing: z.strictObject({
      physicalSlots: z.literal('0..instances-1'),
      directPathTarget: z.literal(0),
      loadBalancerInitialBackend: z.literal(0),
      sparesAreNotRoutedWithoutLb: z.literal(true),
    }),
    idempotency: z.strictObject({
      eventIdBindsPayload: z.literal(true),
      duplicateSamePayload: z.literal('replay-original'),
      mismatch: z.literal('conflict-no-effect'),
      retryAfterUnknownCommit: z.literal('same-id'),
    }),
    schedulerTiePriority: z
      .array(
        z.strictObject({
          event: z.enum([
            'injected-crash',
            'boot-completion',
            'resource-or-network-completion',
            'request-task-or-probe-timeout',
            'health-result-publication',
            'arrival-or-probe-launch',
            'background-poll-or-heartbeat',
          ]),
          priority: z.number().int(),
        }),
      )
      .length(7),
    faultConnection: z.strictObject({
      viaLbLostConnectionMs: nonNegative,
      directLostConnectionMs: nonNegative,
      newAttemptToDeadProcessTimeoutMs: positive,
      retryBackoffMs: nonNegative,
    }),
  }),
});

export type AudienceCatalog = z.infer<typeof audienceCatalogSchema>;
export type AudienceSqlSizeSpec =
  AudienceCatalog['components']['sql']['sizes'][AudienceSqlSize];

// ---------------------------------------------------------------------------
// Level definition
// ---------------------------------------------------------------------------

export const audienceReadPhaseSchema = z.strictObject({
  fromMs: z.number().finite().nonnegative(),
  toMs: z.number().finite().positive(),
  readsPerSecond: z.number().finite().nonnegative(),
});

export const audienceLevelSchema = z.strictObject({
  schemaVersion: z.literal(AUDIENCE_SCHEMA_VERSION),
  contentVersion: z.literal(AUDIENCE_CONTENT_VERSION),
  modelVersion: z.literal(AUDIENCE_MODEL_VERSION),
  pricingVersion: z.literal(AUDIENCE_PRICING_VERSION),
  profileVersion: z.literal(AUDIENCE_PROFILE_VERSION),
  id: z.literal(AUDIENCE_LEVEL_ID),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(2_000),
  task: z.string().min(1).max(4_000),
  dataset: z.strictObject({
    users: z.number().int().positive(),
    streams: z.number().int().positive(),
    prehistoryEvents: z.number().int().positive(),
    eventBytes: z.number().int().positive(),
    prehistoryRawBytes: z.number().int().positive(),
    rankingBytes: z.number().int().positive(),
    ingestAckBytes: z.number().int().positive(),
    activityWindowMs: z.number().int().positive(),
    initialHistory: z.literal('deterministic'),
    historyPolicy: z.literal('seeded-equal-per-case'),
    fixedPopulation: z.literal(true),
  }),
  workload: z.strictObject({
    measuredMs: positive,
    drainMs: positive,
    ingestEventsPerSecond: z.number().finite().nonnegative(),
    readPhases: z.array(audienceReadPhaseSchema).min(1).max(4),
    peakWindow: audienceWindowRangeSchema,
    faultWindow: audienceWindowRangeSchema,
    requestDeadlineMs: positive,
    traceSeedPolicy: z.literal('graph-independent'),
    arrivalModel: z.literal('poisson'),
    oneTracePerSeed: z.literal(true),
    cacheInitialState: z.literal('cold'),
    tieBreak: z.literal('stream-id-ascending'),
    topN: z.number().int().positive(),
  }),
  challenges: z.strictObject({
    profileVersion: z.literal(AUDIENCE_PROFILE_VERSION),
    requiredKinds: z.array(z.enum(AUDIENCE_CASE_KINDS)).length(3),
    maxAppInstances: z.number().int().min(1).max(4),
    maxFaultCases: z.number().int().min(1).max(4),
    maxCases: z.number().int().min(1).max(6),
    qualification: z.literal('all-required-cases'),
    targetPolicy: z.literal('every-physical-app-instance'),
    scoreCaseId: z.literal('peak'),
  }),
  limits: z.strictObject({
    maxSqlWaitingTasks: z.number().int().positive(),
    maxAppWaitingTasks: z.number().int().positive(),
    maxCacheWaitingTasks: z.number().int().positive(),
    maxEvents: z.number().int().positive(),
    maxFrames: z.number().int().positive(),
    maxIssues: z.number().int().positive(),
    maxCases: z.number().int().positive(),
    maxSeriesPoints: z.number().int().positive(),
    maxIncidentEvents: z.number().int().positive(),
    /** Setup barrier budget; exceeding it is incomplete, never silently ready. */
    maxPreparationMs: z.number().int().positive(),
  }),
  slo: z.strictObject({
    availability: z.number().gt(0).max(1),
    successfulP95Ms: positive,
    freshnessMs: positive,
    minimumLatencySamples: z.number().int().positive(),
  }),
  defaultSeed: z.number().int().min(0).max(AUDIENCE_MAX_SEED),
  calibrationSeeds: z
    .array(z.number().int().min(0).max(AUDIENCE_MAX_SEED))
    .min(1),
  holdoutSeeds: z
    .array(z.number().int().min(0).max(AUDIENCE_MAX_SEED))
    .min(1),
  assumptions: z.array(z.string().min(1).max(4_000)).min(1),
});

export type AudienceLevel = z.infer<typeof audienceLevelSchema>;
export type AudienceReadPhase = z.infer<typeof audienceReadPhaseSchema>;

// ---------------------------------------------------------------------------
// Shared result leaf shapes
// ---------------------------------------------------------------------------

const EPSILON = 1e-9;

function nearlyEqual(left: number, right: number): boolean {
  return (
    Math.abs(left - right) <=
    EPSILON * Math.max(1, Math.abs(left), Math.abs(right))
  );
}

function nullableNumberEquals(
  left: number | null,
  right: number | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return nearlyEqual(left, right);
}

export const audienceLatencySchema = z.strictObject({
  p50Ms: nonNegative.nullable(),
  p95Ms: nonNegative.nullable(),
  p99Ms: nonNegative.nullable(),
  maxMs: nonNegative.nullable(),
  samples: z.number().int().nonnegative(),
  /** True when the sample count cannot support the declared percentile gate. */
  insufficientSamples: z.boolean(),
});

export type AudienceLatency = z.infer<typeof audienceLatencySchema>;

export const audienceOperationMetricsSchema = z.strictObject({
  /** Logical offered requests; the availability denominator. */
  offered: z.number().int().nonnegative(),
  /** Physical attempts, including one bounded retry. */
  attempts: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  timedOut: z.number().int().nonnegative(),
  errored: z.number().int().nonnegative(),
  /** Transport failure after commit; the outcome is unknown to the client. */
  unknownOutcome: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  /** succeeded / offered; null when nothing was offered. */
  availability: z.number().min(0).max(1).nullable(),
  latency: audienceLatencySchema,
  bytesOffered: nonNegative,
  bytesDelivered: nonNegative,
});

export type AudienceOperationMetrics = z.infer<
  typeof audienceOperationMetricsSchema
>;

export const audienceGateSchema = z.strictObject({
  id: z.enum(AUDIENCE_GATE_IDS),
  label: z.string().min(1).max(200),
  severity: z.enum(['required', 'advisory']),
  operation: z.enum(AUDIENCE_OPERATIONS).optional(),
  window: z.enum(AUDIENCE_WINDOWS).optional(),
  metric: z.string().min(1).max(96),
  actual: z.number().finite().nullable(),
  limit: z.number().finite().nullable(),
  unit: z.string().min(1).max(32),
  comparison: z.enum(['max', 'min', 'none']),
  sampleCount: z.number().int().nonnegative(),
  passed: z.boolean(),
  message: z.string().min(1).max(2_000),
});

export type AudienceGate = z.infer<typeof audienceGateSchema>;

export const audienceCpuMetricsSchema = z.strictObject({
  capacityCores: nonNegative,
  busyCoresAverage: nonNegative,
  busyCoresPeak: nonNegative,
  busyCoreMs: nonNegative,
  utilizationAverage: z.number().min(0).max(1),
  utilizationPeak: z.number().min(0).max(1),
});

export const audienceMemoryMetricsSchema = z.strictObject({
  capacityBytes: nonNegative,
  workingSetBytes: nonNegative,
  residentBytesAverage: nonNegative,
  peakUsedBytes: nonNegative,
});

export const audienceIoMetricsSchema = z.strictObject({
  readOperations: z.number().int().nonnegative(),
  writeOperations: z.number().int().nonnegative(),
  bytesRead: nonNegative,
  bytesWritten: nonNegative,
  busyMs: nonNegative,
  utilizationAverage: z.number().min(0).max(1),
});

export const audienceStorageMetricsSchema = z.strictObject({
  capacityBytes: nonNegative,
  usedBytes: nonNegative,
  peakUsedBytes: nonNegative,
  bytesWritten: nonNegative,
  bytesRead: nonNegative,
});

export const audienceQueueMetricsSchema = z.strictObject({
  waitingAverage: nonNegative,
  waitingPeak: z.number().int().nonnegative(),
  waitMsAverage: nonNegative,
  waitMsMax: nonNegative,
  waitSamples: z.number().int().nonnegative(),
  activePeak: z.number().int().nonnegative(),
  rejectedOverflow: z.number().int().nonnegative(),
  deadlineTimeouts: z.number().int().nonnegative(),
});

export const audienceNetworkMetricsSchema = z.strictObject({
  capacityGbitPerSec: nonNegative,
  bytesOffered: nonNegative,
  bytesDelivered: nonNegative,
  averageGbitPerSec: nonNegative,
  peakGbitPerSec: nonNegative,
});

export const audienceTaskMetricsSchema = z.strictObject({
  submitted: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  timedOut: z.number().int().nonnegative(),
  interrupted: z.number().int().nonnegative(),
});

export const audienceInstanceHealthSchema = z.enum([
  'healthy',
  'unhealthy',
  'crashed',
  'booting',
]);

export const audienceInstanceMetricsSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  kind: z.enum(AUDIENCE_NODE_KINDS),
  /** Canonical physical index, independent of node ids and array order. */
  instanceIndex: z.number().int().min(0).max(3),
  label: z.string().min(1).max(120),
  health: audienceInstanceHealthSchema,
  cpu: audienceCpuMetricsSchema,
  memory: audienceMemoryMetricsSchema,
  io: audienceIoMetricsSchema,
  storage: audienceStorageMetricsSchema,
  queue: audienceQueueMetricsSchema,
  network: audienceNetworkMetricsSchema,
  tasks: audienceTaskMetricsSchema,
});

export type AudienceInstanceMetrics = z.infer<
  typeof audienceInstanceMetricsSchema
>;

export const audienceNodeHealthSchema = z.strictObject({
  state: z.enum(['healthy', 'degraded']),
  totalInstances: z.number().int().positive(),
  healthyInstances: z.number().int().nonnegative(),
  crashEvents: z.number().int().nonnegative(),
  recoveryMs: nonNegative.nullable(),
});

export const audienceNodeMetricsSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  kind: z.enum(AUDIENCE_NODE_KINDS),
  label: z.string().min(1).max(120),
  provisionedInstances: z.number().int().positive(),
  health: audienceNodeHealthSchema,
  cpu: audienceCpuMetricsSchema,
  memory: audienceMemoryMetricsSchema,
  io: audienceIoMetricsSchema,
  storage: audienceStorageMetricsSchema,
  queue: audienceQueueMetricsSchema,
  network: audienceNetworkMetricsSchema,
  tasks: audienceTaskMetricsSchema,
  instances: z
    .array(audienceInstanceMetricsSchema)
    .max(AUDIENCE_MAX_INSTANCES_PER_NODE),
});

export type AudienceNodeMetrics = z.infer<typeof audienceNodeMetricsSchema>;

export const audienceLinkMetricsSchema = z.strictObject({
  edgeId: z.string().min(1).max(64),
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  role: z.enum(AUDIENCE_LINK_ROLES),
  requests: z.strictObject({
    ingest: z.number().int().nonnegative(),
    read: z.number().int().nonnegative(),
    projection: z.number().int().nonnegative(),
  }),
  requestsTotal: z.number().int().nonnegative(),
  bytesOffered: nonNegative,
  bytesDelivered: nonNegative,
  peakRequestsPerSecond: nonNegative,
  peakBytesPerSecond: nonNegative,
});

export type AudienceLinkMetrics = z.infer<typeof audienceLinkMetricsSchema>;

/**
 * Exact identity of one published ranking state. `asOfMs` and the durable
 * `throughCommitSequence` are both required: same-time commit interleavings
 * cannot be reconstructed from a wall-clock label alone. A snapshot includes
 * commits with time <= asOfMs and sequence <= throughCommitSequence, and
 * expires activity at `asOfMs - 15 min` with an open left edge.
 */
export const audienceSnapshotSchema = z.strictObject({
  /** Exact scheduler clock, including fractional simulated milliseconds. */
  asOfMs: z.number().finite().nonnegative(),
  throughCommitSequence: z.number().int().nonnegative(),
});

export type AudienceSnapshot = z.infer<typeof audienceSnapshotSchema>;

export const audienceProjectionLagSchema = z.strictObject({
  /** Committed outbox events at or below the cursor not yet published. */
  lagEvents: z.number().int().nonnegative(),
  lagMs: nonNegative,
  /** Ordered prefix actually published by the projection. */
  publishedThroughSequence: z.number().int().nonnegative(),
  unpublishedJobs: z.number().int().nonnegative(),
  /** Real empty-heartbeat expiry/index passes, not timestamp-only updates. */
  heartbeatExpiries: z.number().int().nonnegative(),
});

export type AudienceProjectionLag = z.infer<
  typeof audienceProjectionLagSchema
>;

export const audienceCorrectnessSchema = z.strictObject({
  valid: z.boolean(),
  ingestOffered: z.number().int().nonnegative(),
  ingestCommitted: z.number().int().nonnegative(),
  ingestAcknowledged: z.number().int().nonnegative(),
  ingestPending: z.number().int().nonnegative(),
  committedUnacknowledged: z.number().int().nonnegative(),
  duplicateLogicalEvents: z.number().int().nonnegative(),
  lostAcknowledgedEvents: z.number().int().nonnegative(),
  retriedLogicalEvents: z.number().int().nonnegative(),
  /** Same event id + payload returned the original committed result. */
  idempotentReplays: z.number().int().nonnegative(),
  /** Same id with a different payload; must be a conflict with no effect. */
  payloadConflicts: z.number().int().nonnegative(),
  /**
   * Logical ingest requests that encountered an uncertain durable commit at
   * least once. Counted once even when the retry is also ambiguous; physical
   * attempts live only in `operations.ingest.attempts/retries`.
   */
  unknownCommitOutcomes: z.number().int().nonnegative(),
  /**
   * Subset of `unknownCommitOutcomes` later proven to be the original durable
   * commit. The remaining logical uncertainty is
   * `operations.ingest.unknownOutcome`.
   */
  resolvedUnknownCommitOutcomes: z.number().int().nonnegative(),
  /** Durable commits that survived an Application crash or restart. */
  commitsSurvivedAppCrash: z.number().int().nonnegative(),
  /** Highest durable commit sequence observed in the case. */
  commitSequenceHighWater: z.number().int().nonnegative(),
  checkedSnapshots: z.number().int().nonnegative(),
  snapshotMismatches: z.number().int().nonnegative(),
  /**
   * Distinct reference expiry boundaries in this case, derived from the actual
   * prehistory/trace frontier. Zero is legitimate only for a tiny trace with
   * no boundary. Never the number of expiration scan calls.
   */
  expectedExpiries: z.number().int().nonnegative(),
  /**
   * Distinct expected boundaries audited once each, including renewed-entry
   * suppression. Not a count of `expireTo` calls or scanned entries.
   */
  checkedExpiry: z.number().int().nonnegative(),
  expiryMismatches: z.number().int().nonnegative(),
  finalRankingMatchesReference: z.boolean().nullable(),
  finalActivePairs: z.number().int().nonnegative(),
  expectedActivePairs: z.number().int().nonnegative(),
  /** Present only when the primary SQL read plan is a projection. */
  projectionLag: audienceProjectionLagSchema.nullable(),
});

export type AudienceCorrectness = z.infer<
  typeof audienceCorrectnessSchema
>;

export const audienceFreshnessSchema = z.strictObject({
  valid: z.boolean(),
  freshnessLimitMs: nonNegative,
  successfulReads: z.number().int().nonnegative(),
  checkedReads: z.number().int().nonnegative(),
  staleReads: z.number().int().nonnegative(),
  /** Exact `(asOf - 15 min, asOf]` window mismatches, separate from age. */
  wrongWindowReads: z.number().int().nonnegative(),
  maxLagMs: nonNegative,
  p95LagMs: nonNegative,
  samples: z.number().int().nonnegative(),
  /** Latest successful response snapshot; null when none succeeded. */
  latestSnapshot: audienceSnapshotSchema.nullable(),
});

export type AudienceFreshness = z.infer<typeof audienceFreshnessSchema>;

export const audienceCostLineSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  kind: z.enum(AUDIENCE_NODE_KINDS),
  hourlyUsd: nonNegative,
  hours: nonNegative,
  usd: nonNegative,
});

export const audienceCostSchema = z.strictObject({
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
  lines: z.array(audienceCostLineSchema).max(AUDIENCE_MAX_NODES),
});

export type AudienceCost = z.infer<typeof audienceCostSchema>;

export const audienceRunWindowSchema = z.strictObject({
  measuredStartMs: nonNegative,
  measuredEndMs: nonNegative,
  peakStartMs: nonNegative,
  peakEndMs: nonNegative,
  criticalStartMs: nonNegative.nullable(),
  criticalEndMs: nonNegative.nullable(),
  drainMs: nonNegative,
  totalRunMs: nonNegative,
});

export type AudienceRunWindow = z.infer<typeof audienceRunWindowSchema>;

export const audienceSeriesTrafficSchema = z.strictObject({
  offered: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const audienceSeriesLatencySchema = z.strictObject({
  p50Ms: nonNegative.nullable(),
  p95Ms: nonNegative.nullable(),
  p99Ms: nonNegative.nullable(),
  samples: z.number().int().nonnegative(),
});

export const audienceSeriesNodeSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  instanceIndex: z.number().int().min(0).max(3).nullable(),
  healthy: z.boolean(),
  cpuUtilization: z.number().min(0).max(1).nullable(),
  ramUsedBytes: nonNegative.nullable(),
  queueWaiting: nonNegative.nullable(),
  networkGbitPerSec: nonNegative.nullable(),
});

export const audienceSeriesPointSchema = z.strictObject({
  /** End of the one-second interval, relative to the measured start. */
  timeMs: nonNegative,
  windowMs: nonNegative,
  traffic: z.strictObject({
    ingest: audienceSeriesTrafficSchema,
    read: audienceSeriesTrafficSchema,
  }),
  latency: z.strictObject({
    ingest: audienceSeriesLatencySchema.nullable(),
    read: audienceSeriesLatencySchema.nullable(),
  }),
  nodes: z.array(audienceSeriesNodeSchema).max(AUDIENCE_MAX_TRAFFIC_NODES),
});

export type AudienceSeriesPoint = z.infer<typeof audienceSeriesPointSchema>;

export const audienceIncidentEventSchema = z.strictObject({
  atMs: nonNegative,
  kind: z.enum([
    'crash',
    'health-check-failed',
    'marked-unhealthy',
    'restart',
    'booting',
    'ready',
    'route-change',
    'retry',
    'deadline',
    'commit',
  ]),
  nodeId: z.string().min(1).max(64),
  instanceIndex: z.number().int().min(0).max(3).nullable(),
  message: z.string().min(1).max(500),
});

export type AudienceIncidentEvent = z.infer<
  typeof audienceIncidentEventSchema
>;

/**
 * Observed lifecycle for the physical Application slot in one case. Identity
 * (node, slot) is always known; every observation is nullable because a
 * cancelled or incomplete case may end before a crash, restart, detection or
 * routing restoration was observed. Planned policy lives in the challenge
 * profile, never in these result fields.
 */
export const audienceTargetSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  kind: z.literal('app'),
  instanceIndex: z.number().int().min(0).max(3),
  crashAtMs: nonNegative.nullable(),
  /** Actual process restart moment, after crash + down time. */
  downUntilMs: nonNegative.nullable(),
  /** Detected by two timed-out probes, never at launch. */
  detectedUnhealthyAtMs: nonNegative.nullable(),
  /** Boot completed and two successful probes were observed. */
  readyAtMs: nonNegative.nullable(),
  /** LB routing to this slot was actually restored; null for a direct route. */
  routeRestoredAtMs: nonNegative.nullable(),
  recoveredAtMs: nonNegative.nullable(),
  healthyAtEnd: z.boolean().nullable(),
  restartCount: z.number().int().min(0).max(1),
});

export type AudienceTarget = z.infer<typeof audienceTargetSchema>;

// ---------------------------------------------------------------------------
// Traffic frame compatible with the shared game-ui telemetry boundary
// ---------------------------------------------------------------------------

export const audienceTrafficResourceSchema = z.strictObject({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  aggregation: z.enum(['window-average', 'instant']).optional(),
  used: z.number().finite().nullable(),
  capacity: z.number().finite().nullable(),
  unit: z.enum(['slots', 'connections', 'cores', 'lanes', 'bytes', 'gbit/s']),
});

export const audienceTrafficNodeSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  resources: z
    .array(audienceTrafficResourceSchema)
    .max(AUDIENCE_MAX_TRAFFIC_RESOURCES_PER_NODE),
  requestsPerSecond: z.number().finite().nullable(),
  queue: z.number().finite().nullable(),
  down: z.boolean(),
});

export const audienceTrafficEdgeSchema = z.strictObject({
  edgeId: z.string().min(1).max(64),
  /** One count per actual logical traversal attempt, including retries. */
  requestsPerSecond: z.number().finite().nonnegative(),
  bytesPerSecond: z.number().finite().nonnegative().nullable(),
});

export const audienceTrafficFrameSchema = z.strictObject({
  levelId: z.literal(AUDIENCE_LEVEL_ID),
  /** Required case identity; frames from different cases never share a scope. */
  scopeId: z.enum(AUDIENCE_CASE_IDS),
  /** Human case label; must match the enclosing CaseResult label. */
  scopeLabel: z.string().min(1).max(120),
  timeMs: z.number().finite().min(-1_000_000_000).max(1_000_000_000),
  windowMs: z.number().finite().nonnegative(),
  phase: z.enum(['warmup', 'measured', 'drain', 'postlude']),
  nodes: z.array(audienceTrafficNodeSchema).max(AUDIENCE_MAX_TRAFFIC_NODES),
  edges: z.array(audienceTrafficEdgeSchema).max(AUDIENCE_MAX_TRAFFIC_EDGES),
});

export type AudienceTrafficFrame = z.infer<
  typeof audienceTrafficFrameSchema
>;

/**
 * Compile-time bridge to the shared chart telemetry. The UI worker may post an
 * audience frame without translating it; this helper makes the compatibility a
 * checked contract rather than an assumption.
 */
export function audienceTrafficFrameToTelemetry(
  frame: AudienceTrafficFrame,
): TrafficFrame {
  return frame;
}

// ---------------------------------------------------------------------------
// Case result
// ---------------------------------------------------------------------------

export const audienceCaseResultSchema = z.strictObject({
  id: z.enum(AUDIENCE_CASE_IDS),
  label: z.string().min(1).max(200),
  kind: z.enum(AUDIENCE_CASE_KINDS),
  status: z.enum(AUDIENCE_CASE_STATUSES),
  passed: z.boolean(),
  targetInstance: z.number().int().min(0).max(3).nullable(),
  target: audienceTargetSchema.nullable(),
  window: audienceRunWindowSchema,
  operations: z
    .strictObject({
      ingest: audienceOperationMetricsSchema,
      read: audienceOperationMetricsSchema,
      critical: z
        .strictObject({
          ingest: audienceOperationMetricsSchema,
          read: audienceOperationMetricsSchema,
        })
        .nullable(),
    })
    .nullable(),
  gates: z.array(audienceGateSchema).max(AUDIENCE_MAX_GATES),
  correctness: audienceCorrectnessSchema.nullable(),
  freshness: audienceFreshnessSchema.nullable(),
  /** Last successful ranking snapshot published in this case. */
  finalSnapshot: audienceSnapshotSchema.nullable(),
  nodes: z.array(audienceNodeMetricsSchema).max(AUDIENCE_MAX_NODES),
  links: z.array(audienceLinkMetricsSchema).max(AUDIENCE_MAX_LINKS),
  cost: audienceCostSchema.nullable(),
  series: z.array(audienceSeriesPointSchema).max(AUDIENCE_MAX_SERIES_POINTS),
  trafficFrames: z
    .array(audienceTrafficFrameSchema)
    .max(AUDIENCE_MAX_FRAMES),
  incidentTimeline: z
    .array(audienceIncidentEventSchema)
    .max(AUDIENCE_MAX_INCIDENT_EVENTS),
});

export type AudienceCaseResult = z.infer<typeof audienceCaseResultSchema>;

// ---------------------------------------------------------------------------
// Evaluation envelope
// ---------------------------------------------------------------------------

export const audienceIdentitySchema = z.strictObject({
  levelId: z.literal(AUDIENCE_LEVEL_ID),
  modelVersion: z.literal(AUDIENCE_MODEL_VERSION),
  schemaVersion: z.literal(AUDIENCE_SCHEMA_VERSION),
  contentVersion: z.literal(AUDIENCE_CONTENT_VERSION),
  pricingVersion: z.literal(AUDIENCE_PRICING_VERSION),
  profileVersion: z.literal(AUDIENCE_PROFILE_VERSION),
  seed: z.number().int().min(0).max(AUDIENCE_MAX_SEED),
  graphDigest: z.string().min(1).max(64),
  /** Includes versions, seed and graph digest; stable across repeated runs. */
  runId: z.string().min(1).max(96),
});

export type AudienceIdentity = z.infer<typeof audienceIdentitySchema>;

export const audienceProvisionedSchema = z.strictObject({
  appInstances: z.number().int().min(1).max(4),
  sqlSize: z.enum(AUDIENCE_SQL_SIZES),
  readPlan: z.enum(AUDIENCE_SQL_READ_PLANS),
  cacheTtlSeconds: z
    .union([z.literal(0.5), z.literal(2), z.literal(5), z.literal(15)])
    .nullable(),
  workerInstances: z.number().int().min(0).max(4),
  loadBalancer: z.boolean(),
});

export type AudienceProvisioned = z.infer<
  typeof audienceProvisionedSchema
>;

export const audienceScoreSchema = z.strictObject({
  /** True only when the whole qualification run is complete and passing. */
  eligible: z.boolean(),
  /** Actual peak-case cost; null unless eligible. Never a sum of fault runs. */
  costUsd: nonNegative.nullable(),
  caseId: z.literal('peak'),
});

export type AudienceScore = z.infer<typeof audienceScoreSchema>;

export const audienceEvaluationCoreSchema = z.strictObject({
  status: z.enum(AUDIENCE_STATUSES),
  passed: z.boolean(),
  levelId: z.literal(AUDIENCE_LEVEL_ID),
  modelVersion: z.literal(AUDIENCE_MODEL_VERSION),
  schemaVersion: z.literal(AUDIENCE_SCHEMA_VERSION),
  contentVersion: z.literal(AUDIENCE_CONTENT_VERSION),
  pricingVersion: z.literal(AUDIENCE_PRICING_VERSION),
  profileVersion: z.literal(AUDIENCE_PROFILE_VERSION),
  seed: z.number().int().min(0).max(AUDIENCE_MAX_SEED),
  graphDigest: z.string().min(1).max(64),
  runId: z.string().min(1).max(96),
  identity: audienceIdentitySchema,
  provisioned: audienceProvisionedSchema.nullable(),
  cases: z.array(audienceCaseResultSchema).max(AUDIENCE_MAX_CASES),
  score: audienceScoreSchema,
  issues: z.array(audienceIssueSchema).max(AUDIENCE_MAX_ISSUES),
  incompleteReasons: z
    .array(z.string().min(1).max(200))
    .max(AUDIENCE_MAX_INCOMPLETE_REASONS),
});

/**
 * Cross-field invariants that shape parsing cannot express. These guards make
 * a forged client result fail locally and give the server a cheap first line
 * before its catalog-bound deep verification.
 */
export const audienceEvaluationSchema =
  audienceEvaluationCoreSchema.superRefine((value, ctx) => {
    const identityPairs: {
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
        path: ['identity', 'profileVersion'],
        actual: value.identity.profileVersion,
        expected: value.profileVersion,
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
    for (const pair of identityPairs) {
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
    if (value.status === 'incomplete' && value.incompleteReasons.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['incompleteReasons'],
        message: 'An incomplete evaluation must explain what is missing.',
      });
    }
    if (
      value.status === 'invalid' &&
      !value.issues.some((item) => item.severity === 'error')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['issues'],
        message: 'An invalid evaluation must include at least one error issue.',
      });
    }

    const caseIds = value.cases.map((item) => item.id);
    if (new Set(caseIds).size !== caseIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['cases'],
        message: 'Case ids must be unique across every status.',
      });
    }

    if (value.status === 'complete') {
      if (value.provisioned === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['provisioned'],
          message: 'A complete evaluation must report its provisioned graph.',
        });
      } else {
        const required = audienceRequiredCaseIds(
          value.provisioned.appInstances,
        );
        if (value.cases.length !== required.length) {
          ctx.addIssue({
            code: 'custom',
            path: ['cases'],
            message: `A complete evaluation needs exactly ${required.length} required cases.`,
          });
        }
        for (const id of required) {
          const matches = value.cases.filter((item) => item.id === id);
          if (matches.length !== 1) {
            ctx.addIssue({
              code: 'custom',
              path: ['cases'],
              message: `Required case "${id}" must appear exactly once.`,
            });
          }
        }
        if (value.cases.some((item) => item.status !== 'complete')) {
          ctx.addIssue({
            code: 'custom',
            path: ['cases'],
            message:
              'A complete qualification run cannot contain an incomplete or cancelled case.',
          });
        }
        for (const item of value.cases) {
          if (
            item.kind === 'app-instance-failure' &&
            (value.provisioned.appInstances <= item.targetInstance! ||
              item.targetInstance === null)
          ) {
            ctx.addIssue({
              code: 'custom',
              path: ['cases'],
              message: `Case "${item.id}" targets an Application instance that is not provisioned.`,
            });
          }
        }
      }
    }

    let allCasesPass = value.cases.length > 0;
    for (const item of value.cases) {
      const casePath = ['cases'] as const;
      if (item.passed && item.status !== 'complete') {
        ctx.addIssue({
          code: 'custom',
          path: [...casePath],
          message: `Case "${item.id}" can pass only when its status is complete.`,
        });
      }
      if (item.status === 'complete') {
        if (
          item.operations === null ||
          item.correctness === null ||
          item.freshness === null ||
          item.cost === null ||
          item.nodes.length === 0 ||
          item.series.length === 0 ||
          item.trafficFrames.length === 0
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath],
            message: `Complete case "${item.id}" needs operations, correctness, freshness, cost, nodes, series and traffic frames.`,
          });
        } else if (item.freshness.successfulReads === 0) {
          if (item.finalSnapshot !== null) {
            ctx.addIssue({
              code: 'custom',
              path: [...casePath, 'finalSnapshot'],
              message: `Case "${item.id}" cannot publish a final snapshot when no ranking succeeded.`,
            });
          }
        } else if (item.finalSnapshot === null) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath, 'finalSnapshot'],
            message: `Case "${item.id}" needs the final snapshot of its successful reads.`,
          });
        }
        if (item.freshness !== null) {
          if (
            item.freshness.checkedReads !== item.freshness.successfulReads ||
            item.freshness.samples !== item.freshness.checkedReads ||
            (item.operations !== null &&
              item.freshness.successfulReads !==
                item.operations.read.succeeded)
          ) {
            ctx.addIssue({
              code: 'custom',
              path: [...casePath, 'freshness'],
              message: `Complete case "${item.id}" must audit freshness for every successful ranking, matching read traffic.`,
            });
          }
        }
        if (item.correctness !== null) {
          if (
            item.correctness.checkedSnapshots !==
              (item.freshness?.successfulReads ?? 0)
          ) {
            ctx.addIssue({
              code: 'custom',
              path: [...casePath, 'correctness'],
              message: `Complete case "${item.id}" must check exact snapshot correctness for every successful ranking.`,
            });
          }
          if (
            item.correctness.checkedExpiry !==
            item.correctness.expectedExpiries
          ) {
            ctx.addIssue({
              code: 'custom',
              path: [...casePath, 'correctness'],
              message: `Complete case "${item.id}" must audit exactly the distinct expected expiry boundaries (${item.correctness.expectedExpiries}).`,
            });
          }
        }
        const requiredSpecs = audienceRequiredGateSpecs(item.kind);
        const requiredGates = item.gates.filter(
          (gate) => gate.severity === 'required',
        );
        const requiredIds = requiredSpecs.map((spec) => spec.id).sort();
        const actualRequiredIds = requiredGates.map((gate) => gate.id).sort();
        if (
          requiredIds.length !== actualRequiredIds.length ||
          requiredIds.some((id, index) => id !== actualRequiredIds[index])
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath, 'gates'],
            message: `Complete case "${item.id}" must carry exactly the frozen required gate set for kind "${item.kind}".`,
          });
        }
        if (
          item.operations !== null &&
          item.correctness !== null &&
          item.freshness !== null
        ) {
          const operations = item.operations;
          const correctness = item.correctness;
          const freshness = item.freshness;
          let everyRequiredPassed = true;
          const pendingTotal =
            operations.ingest.pending + operations.read.pending;
          for (const spec of requiredSpecs) {
            const gate = requiredGates.find((candidate) => candidate.id === spec.id);
            if (gate === undefined) {
              everyRequiredPassed = false;
              continue;
            }
            if (
              gate.label !== spec.label ||
              gate.operation !== spec.operation ||
              gate.window !== spec.window ||
              gate.metric !== spec.metric ||
              gate.unit !== spec.unit ||
              gate.comparison !== spec.comparison
            ) {
              ctx.addIssue({
                code: 'custom',
                path: [...casePath, 'gates'],
                message: `Gate "${spec.id}" metadata must match the frozen audience gate specification.`,
              });
            }
            const cohort =
              spec.window === 'critical'
                ? operations.critical?.[spec.operation ?? 'read'] ?? null
                : operations[spec.operation ?? 'read'];
            let expectedActual: number | null = null;
            let expectedLimit: number | null = null;
            let expectedSamples = 0;
            let expectedPass: boolean;
            if (spec.metric === 'availability') {
              expectedActual = cohort?.availability ?? null;
              expectedLimit = AUDIENCE_AVAILABILITY_SLO;
              expectedSamples = cohort?.offered ?? 0;
              expectedPass =
                cohort !== null &&
                cohort.offered > 0 &&
                cohort.availability !== null &&
                cohort.availability >= AUDIENCE_AVAILABILITY_SLO;
            } else if (spec.metric === 'successfulP95Ms') {
              expectedActual = cohort?.latency.p95Ms ?? null;
              expectedLimit = AUDIENCE_SUCCESSFUL_P95_MS;
              expectedSamples = cohort?.latency.samples ?? 0;
              expectedPass =
                cohort !== null &&
                expectedSamples >= AUDIENCE_MIN_LATENCY_SAMPLES &&
                expectedActual !== null &&
                expectedActual <= AUDIENCE_SUCCESSFUL_P95_MS;
            } else if (spec.metric === 'preservation') {
              expectedSamples = correctness.ingestAcknowledged;
              expectedPass =
                correctness.lostAcknowledgedEvents === 0 &&
                correctness.duplicateLogicalEvents === 0 &&
                correctness.payloadConflicts === 0;
            } else if (spec.metric === 'exactSnapshotCorrectness') {
              expectedSamples = correctness.checkedSnapshots;
              expectedPass = correctness.valid;
            } else if (spec.metric === 'freshnessLagMs') {
              expectedActual = freshness.maxLagMs;
              expectedLimit = AUDIENCE_FRESHNESS_MS;
              expectedSamples = freshness.checkedReads;
              expectedPass = freshness.valid;
            } else {
              expectedActual = pendingTotal;
              expectedLimit = 0;
              expectedPass = pendingTotal === 0;
            }
            if (
              !nullableNumberEquals(gate.actual, expectedActual) ||
              !nullableNumberEquals(gate.limit, expectedLimit) ||
              gate.sampleCount !== expectedSamples ||
              gate.passed !== expectedPass
            ) {
              ctx.addIssue({
                code: 'custom',
                path: [...casePath, 'gates'],
                message: `Gate "${spec.id}" evidence must be derived from the case metrics, not supplied independently.`,
              });
            }
            everyRequiredPassed = everyRequiredPassed && expectedPass;
          }
          const evidencePassed =
            everyRequiredPassed &&
            correctness.valid &&
            freshness.valid;
          if (item.passed !== evidencePassed) {
            ctx.addIssue({
              code: 'custom',
              path: [...casePath],
              message: `Case "${item.id}" passes exactly when every frozen required gate, correctness and freshness pass together.`,
            });
          }
        }
      } else if (item.passed) {
        ctx.addIssue({
          code: 'custom',
          path: [...casePath],
          message: `Incomplete case "${item.id}" cannot pass.`,
        });
      }
      allCasesPass = allCasesPass && item.passed && item.status === 'complete';

      if (
        item.trafficFrames.some(
          (frame) =>
            frame.scopeId !== item.id || frame.scopeLabel !== item.label,
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [...casePath, 'trafficFrames'],
          message: `Case "${item.id}" traffic frames must use its case id and label as the scope.`,
        });
      }

      const gateIds = item.gates.map((gate) => gate.id);
      if (new Set(gateIds).size !== gateIds.length) {
        ctx.addIssue({
          code: 'custom',
          path: [...casePath, 'gates'],
          message: `Case "${item.id}" has duplicate gate ids.`,
        });
      }
      for (const gate of item.gates) {
        if (gate.severity === 'required' || gate.comparison === 'none') {
          // Required gates are bound to case metrics above. Advisory gates keep
          // the ordinary comparison check so extra diagnostics cannot lie.
          continue;
        }
        if (gate.limit === null) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath, 'gates'],
            message: `Advisory gate "${gate.id}" needs a limit value.`,
          });
          continue;
        }
        if (gate.actual === null) {
          if (gate.passed) {
            ctx.addIssue({
              code: 'custom',
              path: [...casePath, 'gates'],
              message: `Advisory gate "${gate.id}" cannot pass without an actual value.`,
            });
          }
          continue;
        }
        const expected =
          gate.comparison === 'max'
            ? gate.actual <= gate.limit + EPSILON
            : gate.actual >= gate.limit - EPSILON;
        if (gate.passed !== expected) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath, 'gates'],
            message: `Advisory gate "${gate.id}" pass state does not match its actual and limit.`,
          });
        }
      }

      const expectedKind: AudienceCaseKind =
        item.id === 'normal'
          ? 'normal'
          : item.id === 'peak'
            ? 'peak'
            : 'app-instance-failure';
      if (item.kind !== expectedKind) {
        ctx.addIssue({
          code: 'custom',
          path: [...casePath],
          message: `Case "${item.id}" must use kind "${expectedKind}".`,
        });
      }
      if (expectedKind === 'app-instance-failure') {
        const expectedIndex = Number(item.id.slice('app-failure-'.length));
        if (item.targetInstance !== expectedIndex) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath],
            message: `Case "${item.id}" must target Application instance ${expectedIndex}.`,
          });
        }
        if (item.target === null) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath],
            message: `Fault case "${item.id}" must report its target lifecycle.`,
          });
        } else if (item.target.instanceIndex !== item.targetInstance) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath, 'target', 'instanceIndex'],
            message: `Fault case "${item.id}" must report the physical slot it targets.`,
          });
        }
        if (item.window.criticalStartMs === null) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath, 'window'],
            message: `Fault case "${item.id}" needs a critical window.`,
          });
        }
        const target = item.target;
        if (target !== null) {
          const chainValid =
            (target.crashAtMs !== null ||
              (target.downUntilMs === null &&
                target.detectedUnhealthyAtMs === null &&
                target.readyAtMs === null &&
                target.routeRestoredAtMs === null &&
                target.recoveredAtMs === null)) &&
            (target.readyAtMs !== null ||
              (target.routeRestoredAtMs === null &&
                target.recoveredAtMs === null)) &&
            (target.crashAtMs === null ||
              target.detectedUnhealthyAtMs === null ||
              target.detectedUnhealthyAtMs >= target.crashAtMs) &&
            (target.crashAtMs === null ||
              target.downUntilMs === null ||
              target.downUntilMs >= target.crashAtMs) &&
            (target.downUntilMs === null ||
              target.readyAtMs === null ||
              target.readyAtMs >=
                target.downUntilMs + AUDIENCE_FAULT_SCHEDULE.bootMs) &&
            (target.readyAtMs === null ||
              target.routeRestoredAtMs === null ||
              target.routeRestoredAtMs >= target.readyAtMs) &&
            (target.readyAtMs === null ||
              target.recoveredAtMs === null ||
              target.recoveredAtMs >=
                (target.routeRestoredAtMs ?? target.readyAtMs));
          if (!chainValid) {
            ctx.addIssue({
              code: 'custom',
              path: [...casePath, 'target'],
              message: `Case "${item.id}" target observations must follow crash, detection, restart, boot, readiness and recovery order.`,
            });
          }
        }
        if (item.status === 'complete' && target !== null) {
          const appNode = item.nodes.find(
            (node) => node.kind === 'app' && node.nodeId === target.nodeId,
          );
          const appInstance = appNode?.instances.find(
            (instance) => instance.instanceIndex === target.instanceIndex,
          );
          if (appNode === undefined || appInstance === undefined) {
            ctx.addIssue({
              code: 'custom',
              path: [...casePath, 'nodes'],
              message: `Fault case "${item.id}" must report the crashed Application instance metrics.`,
            });
          }
          const hasLoadBalancer =
            value.provisioned?.loadBalancer === true;
          if (
            target.instanceIndex !== item.targetInstance ||
            target.restartCount !== 1 ||
            target.crashAtMs !== AUDIENCE_FAULT_SCHEDULE.crashAtMs ||
            target.downUntilMs === null ||
            target.downUntilMs !==
              AUDIENCE_FAULT_SCHEDULE.crashAtMs +
                AUDIENCE_FAULT_SCHEDULE.downMs ||
            target.healthyAtEnd === null ||
            (hasLoadBalancer
              ? target.detectedUnhealthyAtMs === null
              : target.routeRestoredAtMs !== null) ||
            (target.healthyAtEnd === true && target.recoveredAtMs === null)
          ) {
            ctx.addIssue({
              code: 'custom',
              path: [...casePath, 'target'],
              message: `A complete fault case "${item.id}" must bind the target slot, actual restart and only the health observations that exist on its route.`,
            });
          }
          if (
            !item.incidentTimeline.some(
              (event) =>
                event.kind === 'crash' &&
                event.atMs === target.crashAtMs &&
                event.nodeId === target.nodeId &&
                event.instanceIndex === target.instanceIndex,
            )
          ) {
            ctx.addIssue({
              code: 'custom',
              path: [...casePath, 'incidentTimeline'],
              message: `Fault case "${item.id}" needs an actual crash event for its target.`,
            });
          }
          if (
            target.readyAtMs !== null &&
            !item.incidentTimeline.some(
              (event) =>
                event.kind === 'ready' &&
                event.atMs === target.readyAtMs &&
                event.nodeId === target.nodeId &&
                event.instanceIndex === target.instanceIndex,
            )
          ) {
            ctx.addIssue({
              code: 'custom',
              path: [...casePath, 'incidentTimeline'],
              message: `Fault case "${item.id}" needs a real readiness event when readiness was observed.`,
            });
          }
        }
      } else {
        if (item.targetInstance !== null || item.target !== null) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath],
            message: `Case "${item.id}" must not report a physical target.`,
          });
        }
        if (item.kind === 'normal' && item.window.criticalStartMs !== null) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath, 'window'],
            message: 'Normal traffic has no separate critical failure window.',
          });
        }
      }

      if (
        (item.window.criticalStartMs === null) !==
        (item.window.criticalEndMs === null)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [...casePath, 'window'],
          message: `Case "${item.id}" must report both critical window bounds or neither.`,
        });
      }
      if (
        item.window.measuredEndMs < item.window.measuredStartMs ||
        item.window.peakEndMs < item.window.peakStartMs ||
        (item.window.criticalStartMs !== null &&
          item.window.criticalEndMs !== null &&
          item.window.criticalEndMs < item.window.criticalStartMs)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [...casePath, 'window'],
          message: `Case "${item.id}" has an inverted window.`,
        });
      }

      if (item.operations !== null) {
        for (const operation of [
          item.operations.ingest,
          item.operations.read,
          ...(item.operations.critical === null
            ? []
            : [
                item.operations.critical.ingest,
                item.operations.critical.read,
              ]),
        ]) {
          validateOperation(operation, casePath, item.id, ctx);
        }
        if (item.operations.critical !== null) {
          const pairs = [
            [item.operations.critical.ingest, item.operations.ingest],
            [item.operations.critical.read, item.operations.read],
          ] as const;
          for (const [critical, whole] of pairs) {
            if (
              critical.offered > whole.offered ||
              critical.succeeded > whole.succeeded ||
              critical.bytesDelivered > whole.bytesDelivered
            ) {
              ctx.addIssue({
                code: 'custom',
                path: [...casePath, 'operations', 'critical'],
                message: `Case "${item.id}" critical cohort cannot exceed its whole-case cohort.`,
              });
            }
          }
        }
      }

      if (item.correctness !== null) {
        const correctness = item.correctness;
        if (
          correctness.ingestAcknowledged > correctness.ingestCommitted ||
          correctness.ingestCommitted > correctness.ingestOffered ||
          correctness.ingestPending > correctness.ingestOffered ||
          correctness.committedUnacknowledged !==
            correctness.ingestCommitted - correctness.ingestAcknowledged ||
          correctness.snapshotMismatches > correctness.checkedSnapshots ||
          correctness.expiryMismatches > correctness.checkedExpiry
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath, 'correctness'],
            message: `Case "${item.id}" has inconsistent ingest, snapshot or expiry counts.`,
          });
        }
        if (
          correctness.valid &&
          (correctness.duplicateLogicalEvents !== 0 ||
            correctness.lostAcknowledgedEvents !== 0 ||
            correctness.payloadConflicts !== 0 ||
            correctness.snapshotMismatches !== 0 ||
            correctness.checkedExpiry !== correctness.expectedExpiries ||
            correctness.expiryMismatches !== 0 ||
            correctness.finalRankingMatchesReference !== true)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath, 'correctness'],
            message: `Case "${item.id}" cannot be correct while it reports lost, duplicate, mismatched or unverified data.`,
          });
        }
        if (item.operations !== null) {
          const ingest = item.operations.ingest;
          if (
            correctness.ingestOffered !== ingest.offered ||
            correctness.ingestAcknowledged !== ingest.succeeded ||
            correctness.ingestPending !== ingest.pending ||
            correctness.retriedLogicalEvents !== ingest.retries ||
            correctness.resolvedUnknownCommitOutcomes > ingest.retries ||
            correctness.unknownCommitOutcomes !==
              ingest.unknownOutcome +
                correctness.resolvedUnknownCommitOutcomes ||
            correctness.commitsSurvivedAppCrash > correctness.ingestCommitted ||
            correctness.idempotentReplays > correctness.ingestOffered ||
            (item.freshness !== null &&
              correctness.checkedSnapshots > item.freshness.successfulReads)
          ) {
            ctx.addIssue({
              code: 'custom',
              path: [...casePath, 'correctness'],
              message: `Case "${item.id}" correctness counters must conserve logical ingest outcomes and successful ranking audits.`,
            });
          }
        }
      }

      if (item.freshness !== null) {
        const freshness = item.freshness;
        const expectedFresh =
          freshness.staleReads === 0 &&
          freshness.wrongWindowReads === 0 &&
          freshness.maxLagMs <= freshness.freshnessLimitMs + EPSILON;
        if (
          freshness.valid !== expectedFresh ||
          freshness.checkedReads > freshness.successfulReads ||
          freshness.staleReads + freshness.wrongWindowReads >
            freshness.checkedReads ||
          freshness.samples > freshness.checkedReads ||
          (freshness.successfulReads === 0
            ? freshness.latestSnapshot !== null
            : freshness.latestSnapshot === null)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath, 'freshness'],
            message: `Case "${item.id}" has inconsistent freshness evidence.`,
          });
        }
      }

      if (
        item.finalSnapshot !== null &&
        item.freshness !== null &&
        item.freshness.latestSnapshot !== null &&
        (item.finalSnapshot.asOfMs !== item.freshness.latestSnapshot.asOfMs ||
          item.finalSnapshot.throughCommitSequence !==
            item.freshness.latestSnapshot.throughCommitSequence)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [...casePath, 'finalSnapshot'],
          message: `Case "${item.id}" final snapshot must equal the latest audited response snapshot.`,
        });
      }
      if (
        item.finalSnapshot !== null &&
        item.correctness !== null &&
        (item.finalSnapshot.throughCommitSequence >
          item.correctness.commitSequenceHighWater ||
          (item.correctness.projectionLag !== null &&
            item.correctness.projectionLag.publishedThroughSequence >
              item.correctness.commitSequenceHighWater))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [...casePath, 'finalSnapshot'],
          message: `Case "${item.id}" snapshot cursor cannot exceed the durable commit high-water mark.`,
        });
      }
      if (value.provisioned !== null && item.status === 'complete') {
        const projectionExpected =
          value.provisioned.readPlan === 'projection';
        if (
          projectionExpected !==
          (item.correctness?.projectionLag !== null &&
            item.correctness?.projectionLag !== undefined)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath, 'correctness'],
            message: `Case "${item.id}" projection lag evidence must match the SQL read plan.`,
          });
        }
        if (
          projectionExpected &&
          item.finalSnapshot !== null &&
          item.correctness !== null &&
          item.correctness.projectionLag !== null &&
          item.finalSnapshot.throughCommitSequence >
            item.correctness.projectionLag.publishedThroughSequence
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath, 'finalSnapshot'],
            message: `Case "${item.id}" response cursor cannot exceed the end-of-case published prefix.`,
          });
        }
      }

      if (item.cost !== null) {
        const cost = item.cost;
        if (
          !nearlyEqual(
            cost.billedMs,
            cost.preparationMs + cost.measuredMs + cost.drainMs,
          ) ||
          !nearlyEqual(cost.actualUsd, cost.rentalUsd + cost.bytesUsd)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath, 'cost'],
            message: `Case "${item.id}" cost totals do not add up.`,
          });
        }
      }

      const nodeIds = item.nodes.map((node) => node.nodeId);
      if (new Set(nodeIds).size !== nodeIds.length) {
        ctx.addIssue({
          code: 'custom',
          path: [...casePath, 'nodes'],
          message: `Case "${item.id}" has duplicate node metric identities.`,
        });
      }
      for (const node of item.nodes) {
        const instanceKeys = node.instances.map(
          (instance) => `${instance.nodeId}:${instance.instanceIndex}`,
        );
        if (
          node.instances.length !== node.provisionedInstances ||
          new Set(instanceKeys).size !== instanceKeys.length ||
          node.health.totalInstances !== node.provisionedInstances ||
          node.health.healthyInstances !==
            node.instances.filter(
              (instance) => instance.health === 'healthy',
            ).length
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath, 'nodes'],
            message: `Case "${item.id}" node "${node.nodeId}" must report one consistent identity per provisioned instance.`,
          });
        }
        if (
          node.cpu.utilizationAverage > node.cpu.utilizationPeak + EPSILON ||
          node.cpu.busyCoresAverage > node.cpu.busyCoresPeak + EPSILON ||
          node.queue.waitingAverage > node.queue.waitingPeak + EPSILON ||
          node.network.averageGbitPerSec > node.network.peakGbitPerSec + EPSILON ||
          node.memory.peakUsedBytes + EPSILON < node.memory.residentBytesAverage
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [...casePath, 'nodes'],
            message: `Case "${item.id}" node "${node.nodeId}" has inconsistent resource averages and peaks.`,
          });
        }
        for (const instance of node.instances) {
          if (
            instance.cpu.utilizationAverage >
              instance.cpu.utilizationPeak + EPSILON ||
            instance.queue.waitingAverage >
              instance.queue.waitingPeak + EPSILON ||
            instance.network.averageGbitPerSec >
              instance.network.peakGbitPerSec + EPSILON
          ) {
            ctx.addIssue({
              code: 'custom',
              path: [...casePath, 'nodes'],
              message: `Case "${item.id}" instance metrics average exceeds peak.`,
            });
          }
        }
      }
    }

    if (value.status === 'complete' && value.passed !== allCasesPass) {
      ctx.addIssue({
        code: 'custom',
        path: ['passed'],
        message:
          'A complete evaluation passes exactly when every required case passes.',
      });
    }

    const expectedEligible = value.status === 'complete' && value.passed;
    if (value.score.eligible !== expectedEligible) {
      ctx.addIssue({
        code: 'custom',
        path: ['score', 'eligible'],
        message: 'Score eligibility must match a complete passing evaluation.',
      });
    }
    if (value.score.eligible) {
      if (value.score.costUsd === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['score', 'costUsd'],
          message: 'An eligible score must quote the actual peak-case cost.',
        });
      } else {
        const peak = value.cases.find((item) => item.id === 'peak');
        if (
          peak?.cost === null ||
          peak?.cost === undefined ||
          !nearlyEqual(peak.cost.actualUsd, value.score.costUsd)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['score', 'costUsd'],
            message: 'The score must equal the actual peak-case cost.',
          });
        }
      }
    } else if (value.score.costUsd !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['score', 'costUsd'],
        message: 'Ineligible runs must not publish a comparable score.',
      });
    }
  });

function validateOperation(
  operation: AudienceOperationMetrics,
  path: readonly (string | number)[],
  caseId: AudienceCaseId,
  ctx: z.RefinementCtx,
): void {
  const failedSum =
    operation.rejected +
    operation.timedOut +
    operation.errored +
    operation.unknownOutcome;
  const conservativeFailure =
    failedSum === operation.failed &&
    operation.offered ===
      operation.succeeded + operation.failed + operation.pending;
  if (
    !conservativeFailure ||
    operation.retries > operation.offered ||
    operation.retries > operation.attempts ||
    operation.attempts !== operation.offered + operation.retries ||
    operation.succeeded > operation.offered ||
    operation.latency.samples !== operation.succeeded ||
    operation.bytesDelivered > operation.bytesOffered + EPSILON ||
    (operation.offered === 0
      ? operation.availability !== null
      : operation.availability === null ||
        !nearlyEqual(
          operation.availability,
          operation.succeeded / operation.offered,
        ))
  ) {
    ctx.addIssue({
      code: 'custom',
      path: [...path],
      message: `Case "${caseId}" operation count conservation or availability is inconsistent.`,
    });
  }
}

export type AudienceEvaluation = z.infer<
  typeof audienceEvaluationCoreSchema
>;

/**
 * Structural JSON Schema only. Cross-field gate, audit, counter and identity
 * refinements live in `audienceEvaluationSchema`; API consumers must use
 * `parseAudienceEvaluation` or equivalent server-side deep verification and
 * must not treat this schema alone as a semantic validator.
 */
export function audienceEvaluationJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(audienceEvaluationCoreSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id: 'https://system-design-game.local/schemas/live-audience-result.json',
    title: 'Live Audience evaluation result',
    allOf: [
      {
        if: {
          properties: {
            status: { enum: ['invalid', 'incomplete', 'cancelled'] },
          },
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

export function audienceGraphJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(audienceGraphSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id: 'https://system-design-game.local/schemas/live-audience-graph.json',
    title: 'Live Audience graph',
  };
}

export function audienceCatalogJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(audienceCatalogSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id: 'https://system-design-game.local/schemas/live-audience-catalog.json',
    title: 'Live Audience catalog',
  };
}

export function audienceLevelJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(audienceLevelSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id: 'https://system-design-game.local/schemas/live-audience-level.json',
    title: 'Live Audience level',
  };
}

export function audienceChallengeProfileJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(audienceChallengeProfileSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id:
      'https://system-design-game.local/schemas/live-audience-challenge-profile.json',
    title: 'Live Audience challenge profile',
  };
}

export function parseAudienceEvaluation(
  input: unknown,
): AudienceParseResult<AudienceEvaluation> {
  const parsed = audienceEvaluationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      value: null,
      issues: audienceIssuesFromZod(parsed.error),
    };
  }
  return { ok: true, value: parsed.data, issues: [] };
}

// ---------------------------------------------------------------------------
// Public runtime boundary (implementations land in A101, not this task)
// ---------------------------------------------------------------------------

export const AUDIENCE_PHASES = [
  'validate',
  'prepare',
  'run',
  'drain',
  'done',
] as const;
export type AudiencePhase = (typeof AUDIENCE_PHASES)[number];

export interface AudienceProgress {
  readonly phase: AudiencePhase;
  readonly caseId: AudienceCaseId | null;
  /** Absolute virtual milliseconds; 0 is the start of preparation. */
  readonly nowMs: number;
  readonly measuredElapsedMs: number;
  readonly completedRequests: number;
  readonly totalRequests: number;
  readonly message: string;
}

export interface AudienceAdvance {
  readonly done: boolean;
  readonly progress: AudienceProgress;
  /** Events processed during this call, bounded by the caller's budget. */
  readonly processedEvents: number;
  /** True when the event budget stopped this call with work still due. */
  readonly exhausted: boolean;
}

export interface AudienceRunOptions {
  readonly seed?: number;
  readonly onProgress?: (progress: AudienceProgress) => void;
  /** Cancellation is cooperative and never turns a partial run into a pass. */
  readonly abort?: AbortSignal;
}

/**
 * One deterministic, resumable qualification run. `advance` only limits how
 * many scheduled events run per call; it never changes virtual time, event
 * order, random draws or per-case input traces. The browser worker calls
 * `advance(maxEvents)`, forwards bounded `frames()` and finally `result()`.
 */
export interface AudienceSession {
  readonly identity: AudienceIdentity;
  readonly totalRequests: number;
  readonly done: boolean;
  progress(): AudienceProgress;
  advance(maxEvents?: number): AudienceAdvance;
  runToCompletion(maxEventsPerAdvance?: number): AudienceEvaluation;
  cancel(): void;
  result(): AudienceEvaluation | null;
  /** Bounded actual progress frames collected so far; never part of scoring. */
  frames(): readonly AudienceTrafficFrame[];
}
