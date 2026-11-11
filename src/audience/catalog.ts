import {
  AUDIENCE_CACHE_POLICY,
  AUDIENCE_EVENT_PRIORITIES,
  AUDIENCE_FAULT_CONNECTION_POLICY,
  AUDIENCE_FAULT_SCHEDULE,
  AUDIENCE_HEALTH_POLICY,
  AUDIENCE_IDEMPOTENCY_POLICY,
  AUDIENCE_NETWORK_POLICY,
  AUDIENCE_PRICING_VERSION,
  AUDIENCE_PROFILE_VERSION,
  AUDIENCE_PROJECTION_POLICY,
  AUDIENCE_QUEUE_LIMITS,
  AUDIENCE_RETRY_POLICY,
  AUDIENCE_ROUTING_POLICY,
  AUDIENCE_SCHEMA_VERSION,
  audienceCatalogSchema,
  audienceIssuesFromZod,
  type AudienceCatalog,
  type AudienceParseResult,
} from './contracts';

/**
 * Live Audience conditional component catalog.
 *
 * Prices, work coefficients and storage factors are teaching-model values for
 * calibration, not vendor benchmarks. A submitted graph can never override
 * them. Fixed health, retry, queue, projection, routing and idempotency
 * policies are published here so the UI and agent API expose the same limits.
 */
const catalog: AudienceCatalog = {
  schemaVersion: AUDIENCE_SCHEMA_VERSION,
  pricingVersion: AUDIENCE_PRICING_VERSION,
  profileVersion: AUDIENCE_PROFILE_VERSION,
  currency: 'USD',
  priceNote:
    'Conditional in-game prices and work coefficients. RAM, disk and one lane of NIC bandwidth are included in each instance price. Costs are actual preparation, measured and drain rental plus billed delivered response bytes; no monthly extrapolation is used for scoring.',
  componentPalette: ['users', 'lb', 'app', 'sql', 'cache', 'worker'],
  components: {
    users: {
      kind: 'users',
      label: 'Users',
      fixed: true,
      configurableFields: [],
      notes:
        'Fixed population of 1,000,000 users and 100 streams emitting Record activity and View audience ranking traffic. Only its label and position are editable.',
    },
    lb: {
      kind: 'lb',
      label: 'Managed Load Balancer',
      fixed: false,
      configurableFields: [],
      capacityRequestsPerSec: 10_000,
      capacityGbitPerSec: 10,
      cpuCores: 4,
      hourlyUsd: 0.04,
      managedService: true,
      healthCheck: {
        probeStartAtMs: AUDIENCE_HEALTH_POLICY.probeStartAtMs,
        intervalMs: AUDIENCE_HEALTH_POLICY.intervalMs,
        timeoutMs: AUDIENCE_HEALTH_POLICY.timeoutMs,
        failuresToUnhealthy: AUDIENCE_HEALTH_POLICY.failuresToUnhealthy,
        successesToReady: AUDIENCE_HEALTH_POLICY.successesToReady,
        failureCountedAt: AUDIENCE_HEALTH_POLICY.failureCountedAt,
        successCountedAt: AUDIENCE_HEALTH_POLICY.successCountedAt,
      },
      notes:
        'One managed service with internal redundancy guaranteed within this profile. It routes only to backends whose LB-known health is ready, starts its round-robin pointer at slot 0 and keeps probing: the first failed probe is counted only when its 100 ms timeout expires, and the second consecutive failure excludes the backend. Probes consume LB, backend and network work.',
    },
    app: {
      kind: 'app',
      label: 'Application',
      fixed: false,
      configurableFields: ['instances'],
      instances: { min: 1, max: 4, default: 2 },
      cpuCoresPerInstance: 1,
      memoryGbPerInstance: 8,
      nicGbitPerSecPerInstance: 1,
      hourlyUsdPerInstance: 0.06,
      waitingTasksPerInstance: AUDIENCE_QUEUE_LIMITS.appWaitingPerInstance,
      notes:
        'Homogeneous physical slot pool 0..instances-1, charged per instance even when a direct Users -> App path cannot reach spare slots. Application holds no durable audience state; a crash discards volatile RAM, queued work and active work, while acknowledged SQL commits survive.',
    },
    sql: {
      kind: 'sql',
      label: 'SQL Database',
      fixed: false,
      configurableFields: ['size', 'readPlan'],
      sizes: {
        small: {
          cores: 2,
          memoryGb: 4,
          diskGb: 64,
          nicGbitPerSec: 10,
          hourlyUsd: 0.12,
        },
        medium: {
          cores: 8,
          memoryGb: 16,
          diskGb: 256,
          nicGbitPerSec: 25,
          hourlyUsd: 0.4,
        },
        large: {
          cores: 32,
          memoryGb: 64,
          diskGb: 1_024,
          nicGbitPerSec: 50,
          hourlyUsd: 1.28,
        },
      },
      readPlans: {
        query: {
          label: 'Indexed query from raw events',
          description:
            'Each ranking scans committed events in the exact 15-minute range, builds distinct user/stream pairs and sorts 100 streams. Scan work is charged per event, distinct work per active pair and grouping/sorting separately. More SQL cores run more queries in parallel; one query scan is never split across cores.',
        },
        projection: {
          label: 'Maintain a durable projection',
          description:
            'Each ingest and its outbox job commit atomically. Workers claim at most 128 jobs, maintain exact user/stream last-seen and expiry state, and publish an ordered prefix only after every job through that cursor and all due expiry work are durable. Ranking reads are cheap but lag behind the published cursor.',
        },
      },
      waitingTasks: AUDIENCE_QUEUE_LIMITS.sqlWaiting,
      notes:
        'Exactly one primary database. Raw prehistory is charged as storage. Query indexes and projections are built by real preparation work behind a setup barrier; a projection is never preseeded for free and a failed preparation budget makes the run incomplete.',
    },
    cache: {
      kind: 'cache',
      label: 'Cache',
      fixed: false,
      configurableFields: ['ttlSeconds'],
      ttlOptionsSeconds: [0.5, 2, 5, 15],
      capacityBytes: AUDIENCE_CACHE_POLICY.capacityBytes,
      entryBytes: AUDIENCE_CACHE_POLICY.entryBytes,
      coalescing: 'fixed-on',
      cpuCores: 1,
      memoryGb: 1,
      nicGbitPerSec: 10,
      hourlyUsd: 0.06,
      waitingTasks: AUDIENCE_QUEUE_LIMITS.cacheWaiting,
      notes:
        'One shared ranking answer fits exactly. Concurrent cold misses coalesce into one fill. The selected TTL is the actual retention policy and is never secretly clamped to the 5 s freshness SLO. A cached response keeps its original snapshot tuple; successful delivery audits age and exactness, so a 15 s TTL can return a transport-successful but stale answer that fails freshness. Waiting clients keep their own deadlines and are released cleanly.',
    },
    worker: {
      kind: 'worker',
      label: 'Worker pool',
      fixed: false,
      configurableFields: ['instances'],
      instances: { min: 1, max: 4, default: 1 },
      cpuCoresPerInstance: 1,
      memoryGbPerInstance: 2,
      nicGbitPerSecPerInstance: 1,
      hourlyUsdPerInstance: 0.04,
      waitingTasks: AUDIENCE_QUEUE_LIMITS.sqlWaiting,
      notes:
        'Workers poll and claim durable SQL outbox jobs. They perform maintenance, expiry, reorder and publication work; every 100 ms without events schedules real expiry/index work before advancing the cursor. Multiple workers publish one ordered prefix. A worker is unused with the query read plan.',
    },
  },
  work: {
    queryScanCoreMsPerEvent: 0.00002,
    queryDistinctCoreMsPerPair: 0.00006,
    queryResultGroupSortCoreMs: 1,
    projectionDistinctCoreMsPerEvent: 0.0001,
    projectionMaintenanceCoreMsPerEvent: 0.05,
    projectionApplySqlCoreMsPerEvent: 0.05,
    projectionApplySqlDiskMsPerEvent: 0.02,
    projectionIndexCoreMsPerEvent: 0.00002,
    projectionHeartbeatCoreMs: 1,
    projectionReorderCoreMsPerEvent: 0.00001,
    projectionPublishCoreMsPerBatch: 0.5,
    workerClaimCoreMsPerBatch: 0.2,
    workerFlushCoreMs: 0.2,
    queryIndexBuildCoreMsPerEvent: 0.00002,
    projectionBuildCoreMsPerEvent: 0.00004,
    sqlAppendCoreMsPerEvent: 0.2,
    sqlAppendDiskMsPerEvent: 0.1,
    sqlAppendBytesPerEvent: 128,
    appIngestCoreMs: 0.25,
    appReadCoreMs: 0.2,
    cacheLookupCoreMs: 0.1,
    cacheStoreCoreMs: 0.2,
    clientRequestProcessingMs: 0.2,
    clientResponseProcessingMs: 0.2,
    // Managed Load Balancer request CPU, derived from its published capacity
    // (four cores at 10,000 requests/s) so it is a disclosed physical limit.
    lbRequestCoreMs: 0.4,
    lbProbeCoreMs: 0.01,
  },
  storage: {
    rawEventBytes: 128,
    queryIndexBytesPerEvent: 64,
    queryWorkingPairBytes: 96,
    projectionPairBytes: 48,
    outboxJobBytes: 192,
    cacheEntryBytes: AUDIENCE_CACHE_POLICY.entryBytes,
    // Bulk build/provision rate (256 MB/s aggregate) for the one-time index and
    // projection setup; the per-event append rate models online transactions.
    bulkBuildBytesPerMs: 262_144,
  },
  network: {
    clientRttMs: AUDIENCE_NETWORK_POLICY.clientRttMs,
    internalOneWayMs: AUDIENCE_NETWORK_POLICY.internalOneWayMs,
    laneGbitPerSec: AUDIENCE_NETWORK_POLICY.laneGbitPerSec,
    rankingRequestBytes: AUDIENCE_NETWORK_POLICY.rankingRequestBytes,
    rankingResponseBytes: AUDIENCE_NETWORK_POLICY.rankingResponseBytes,
    ingestRequestBytes: AUDIENCE_NETWORK_POLICY.ingestRequestBytes,
    ingestAckBytes: AUDIENCE_NETWORK_POLICY.ingestAckBytes,
  },
  billing: {
    responseBytesUsdPerGb: AUDIENCE_NETWORK_POLICY.responseBytesUsdPerGb,
    bytesPerGb: AUDIENCE_NETWORK_POLICY.bytesPerGb,
  },
  policies: {
    health: {
      probeStartAtMs: AUDIENCE_HEALTH_POLICY.probeStartAtMs,
      intervalMs: AUDIENCE_HEALTH_POLICY.intervalMs,
      timeoutMs: AUDIENCE_HEALTH_POLICY.timeoutMs,
      failuresToUnhealthy: AUDIENCE_HEALTH_POLICY.failuresToUnhealthy,
      successesToReady: AUDIENCE_HEALTH_POLICY.successesToReady,
      failureCountedAt: AUDIENCE_HEALTH_POLICY.failureCountedAt,
      successCountedAt: AUDIENCE_HEALTH_POLICY.successCountedAt,
    },
    fault: { ...AUDIENCE_FAULT_SCHEDULE },
    retry: {
      maxRetries: AUDIENCE_RETRY_POLICY.maxRetries,
      backoffMs: AUDIENCE_RETRY_POLICY.backoffMs,
      sameIdempotencyKey: AUDIENCE_RETRY_POLICY.sameIdempotencyKey,
      useDifferentEligibleBackend:
        AUDIENCE_RETRY_POLICY.useDifferentEligibleBackend,
      excludeLastAttemptBackend:
        AUDIENCE_RETRY_POLICY.excludeLastAttemptBackend,
      useRemainingDeadline: AUDIENCE_RETRY_POLICY.useRemainingDeadline,
      noRetryOn: [...AUDIENCE_RETRY_POLICY.noRetryOn],
    },
    queues: {
      appWaitingPerInstance: AUDIENCE_QUEUE_LIMITS.appWaitingPerInstance,
      sqlWaiting: AUDIENCE_QUEUE_LIMITS.sqlWaiting,
      cacheWaiting: AUDIENCE_QUEUE_LIMITS.cacheWaiting,
      overflow: 'reject',
    },
    projection: {
      maxBatchEvents: AUDIENCE_PROJECTION_POLICY.maxBatchEvents,
      flushMs: AUDIENCE_PROJECTION_POLICY.flushMs,
      heartbeatMs: AUDIENCE_PROJECTION_POLICY.heartbeatMs,
      maxWorkerInstances: AUDIENCE_PROJECTION_POLICY.maxWorkerInstances,
      jobRowsAreTheQueue: AUDIENCE_PROJECTION_POLICY.jobRowsAreTheQueue,
      orderedPrefixPublication:
        AUDIENCE_PROJECTION_POLICY.orderedPrefixPublication,
      reorderBufferEvents: AUDIENCE_PROJECTION_POLICY.reorderBufferEvents,
    },
    cache: {
      coalescing: AUDIENCE_CACHE_POLICY.coalescing,
      entryBytes: AUDIENCE_CACHE_POLICY.entryBytes,
      capacityBytes: AUDIENCE_CACHE_POLICY.capacityBytes,
      retention: AUDIENCE_CACHE_POLICY.retention,
      responseSnapshot: AUDIENCE_CACHE_POLICY.responseSnapshot,
      eviction: AUDIENCE_CACHE_POLICY.eviction,
      deliveryAudit: AUDIENCE_CACHE_POLICY.deliveryAudit,
    },
    routing: {
      physicalSlots: AUDIENCE_ROUTING_POLICY.physicalSlots,
      directPathTarget: AUDIENCE_ROUTING_POLICY.directPathTarget,
      loadBalancerInitialBackend:
        AUDIENCE_ROUTING_POLICY.loadBalancerInitialBackend,
      sparesAreNotRoutedWithoutLb:
        AUDIENCE_ROUTING_POLICY.sparesAreNotRoutedWithoutLb,
    },
    idempotency: {
      eventIdBindsPayload: AUDIENCE_IDEMPOTENCY_POLICY.eventIdBindsPayload,
      duplicateSamePayload: AUDIENCE_IDEMPOTENCY_POLICY.duplicateSamePayload,
      mismatch: AUDIENCE_IDEMPOTENCY_POLICY.mismatch,
      retryAfterUnknownCommit:
        AUDIENCE_IDEMPOTENCY_POLICY.retryAfterUnknownCommit,
    },
    schedulerTiePriority: AUDIENCE_EVENT_PRIORITIES.map((item) => ({
      ...item,
    })),
    faultConnection: { ...AUDIENCE_FAULT_CONNECTION_POLICY },
  },
};

export const AUDIENCE_CATALOG: AudienceCatalog =
  audienceCatalogSchema.parse(catalog);

export function cloneAudienceCatalog(): AudienceCatalog {
  return JSON.parse(JSON.stringify(AUDIENCE_CATALOG)) as AudienceCatalog;
}

export function parseAudienceCatalog(
  input: unknown,
): AudienceParseResult<AudienceCatalog> {
  const parsed = audienceCatalogSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      value: null,
      issues: audienceIssuesFromZod(parsed.error),
    };
  }
  return { ok: true, value: parsed.data, issues: [] };
}
