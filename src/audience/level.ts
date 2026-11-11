import {
  AUDIENCE_ACTIVITY_WINDOW_MS,
  AUDIENCE_AVAILABILITY_SLO,
  AUDIENCE_CASE_KINDS,
  AUDIENCE_CONTENT_VERSION,
  AUDIENCE_DATASET,
  AUDIENCE_DRAIN_MS,
  AUDIENCE_FAULT_CRITICAL_WINDOW,
  AUDIENCE_FRESHNESS_MS,
  AUDIENCE_INGEST_EVENTS_PER_SECOND,
  AUDIENCE_LEVEL_ID,
  AUDIENCE_MAX_CASES,
  AUDIENCE_MAX_FRAMES,
  AUDIENCE_MAX_INCIDENT_EVENTS,
  AUDIENCE_MAX_ISSUES,
  AUDIENCE_MAX_SERIES_POINTS,
  AUDIENCE_MAX_SEED,
  AUDIENCE_MEASURED_MS,
  AUDIENCE_MIN_LATENCY_SAMPLES,
  AUDIENCE_MODEL_VERSION,
  AUDIENCE_PEAK_READ_PHASES,
  AUDIENCE_PEAK_WINDOW,
  AUDIENCE_PRICING_VERSION,
  AUDIENCE_PROFILE_VERSION,
  AUDIENCE_QUEUE_LIMITS,
  AUDIENCE_REQUEST_DEADLINE_MS,
  AUDIENCE_SCHEMA_VERSION,
  AUDIENCE_SUCCESSFUL_P95_MS,
  AUDIENCE_TOP_N,
  audienceIssuesFromZod,
  audienceLevelSchema,
  type AudienceLevel,
  type AudienceParseResult,
} from './contracts';

/**
 * Authoritative Live Audience level. Values are frozen for A100 and may be
 * recalibrated only with recorded before/after evidence in A101.
 */
const level: AudienceLevel = {
  schemaVersion: AUDIENCE_SCHEMA_VERSION,
  contentVersion: AUDIENCE_CONTENT_VERSION,
  modelVersion: AUDIENCE_MODEL_VERSION,
  pricingVersion: AUDIENCE_PRICING_VERSION,
  profileVersion: AUDIENCE_PROFILE_VERSION,
  id: AUDIENCE_LEVEL_ID,
  title: 'Live Audience',
  summary:
    'One million users create repeated activity on 100 streams. A ranking answer is the exact top-20 by unique viewers active in the previous 15 minutes, and traffic jumps during a live event peak.',
  task:
    'Build a system that keeps Record activity and View audience ranking available and fast, including peak traffic and the loss of any one Application instance. Acknowledged events must be durable exactly once, and every ranking answer must name the exact 15-minute snapshot it represents. Among designs that pass every required case, the lower actual peak-case cost wins.',
  dataset: {
    users: AUDIENCE_DATASET.users,
    streams: AUDIENCE_DATASET.streams,
    prehistoryEvents: AUDIENCE_DATASET.prehistoryEvents,
    eventBytes: AUDIENCE_DATASET.eventBytes,
    prehistoryRawBytes: AUDIENCE_DATASET.prehistoryRawBytes,
    rankingBytes: AUDIENCE_DATASET.rankingBytes,
    ingestAckBytes: AUDIENCE_DATASET.ingestAckBytes,
    activityWindowMs: AUDIENCE_ACTIVITY_WINDOW_MS,
    initialHistory: 'deterministic',
    historyPolicy: 'seeded-equal-per-case',
    fixedPopulation: true,
  },
  workload: {
    measuredMs: AUDIENCE_MEASURED_MS,
    drainMs: AUDIENCE_DRAIN_MS,
    ingestEventsPerSecond: AUDIENCE_INGEST_EVENTS_PER_SECOND,
    readPhases: AUDIENCE_PEAK_READ_PHASES.map((phase) => ({ ...phase })),
    peakWindow: { ...AUDIENCE_PEAK_WINDOW },
    faultWindow: { ...AUDIENCE_FAULT_CRITICAL_WINDOW },
    requestDeadlineMs: AUDIENCE_REQUEST_DEADLINE_MS,
    traceSeedPolicy: 'graph-independent',
    arrivalModel: 'poisson',
    oneTracePerSeed: true,
    cacheInitialState: 'cold',
    tieBreak: 'stream-id-ascending',
    topN: AUDIENCE_TOP_N,
  },
  challenges: {
    profileVersion: AUDIENCE_PROFILE_VERSION,
    requiredKinds: [...AUDIENCE_CASE_KINDS],
    maxAppInstances: 4,
    maxFaultCases: 4,
    maxCases: AUDIENCE_MAX_CASES,
    qualification: 'all-required-cases',
    targetPolicy: 'every-physical-app-instance',
    scoreCaseId: 'peak',
  },
  limits: {
    maxSqlWaitingTasks: AUDIENCE_QUEUE_LIMITS.sqlWaiting,
    maxAppWaitingTasks: AUDIENCE_QUEUE_LIMITS.appWaitingPerInstance,
    maxCacheWaitingTasks: AUDIENCE_QUEUE_LIMITS.cacheWaiting,
    maxEvents: 4_000_000,
    maxFrames: AUDIENCE_MAX_FRAMES,
    maxIssues: AUDIENCE_MAX_ISSUES,
    maxCases: AUDIENCE_MAX_CASES,
    maxSeriesPoints: AUDIENCE_MAX_SERIES_POINTS,
    maxIncidentEvents: AUDIENCE_MAX_INCIDENT_EVENTS,
    maxPreparationMs: 120_000,
  },
  slo: {
    availability: AUDIENCE_AVAILABILITY_SLO,
    successfulP95Ms: AUDIENCE_SUCCESSFUL_P95_MS,
    freshnessMs: AUDIENCE_FRESHNESS_MS,
    minimumLatencySamples: AUDIENCE_MIN_LATENCY_SAMPLES,
  },
  defaultSeed: 101,
  calibrationSeeds: [101, 211, 307, 401, 503],
  holdoutSeeds: [607, 701],
  assumptions: [
    'Teaching model, not a production benchmark. Prices, work coefficients and storage factors are conditional in-game values and must be calibrated with real evaluator runs.',
    'The graph provides Users, one Application pool, one primary SQL Database, at most one Managed Load Balancer, one Cache and one Worker pool. Instances are homogeneous physical slots 0..instances-1. A direct Users -> App path always targets slot 0; spare slots are not magically used without the Load Balancer.',
    'Users emit Record activity events and View audience ranking reads. A ranking is exactly top 20 of 100 streams by unique viewers active in (asOfMs - 900000, asOfMs]. Repeated activity by the same user and stream does not add a viewer; one user may watch several streams. Ties resolve by ascending stream id.',
    'Every case resets to the same seeded 15-minute prehistory and the same seeded measured input. The trace is independent of the graph, strategy, scheduler, callbacks and resource contention. User/stream choices, arrivals and incident schedules use separate random streams.',
    'A case has its own preparation clock and measured origin. A setup barrier completes required query-index or projection build before measured traffic; the input trace is frozen while setup runs. Preparation CPU, IO, storage and provisioned rental are billed, and exceeding the preparation budget makes the run incomplete rather than silently ready. A projection is never preseeded for free.',
    'A durable commit gets a monotonic sequence in deterministic scheduler order. Every published ranking snapshot is the tuple {asOfMs, throughCommitSequence}: it contains commits with time <= asOfMs and sequence <= throughCommitSequence and expires activity at asOfMs - 900000 with an open left edge. The cursor is carried in the result evidence, so same-time interleavings are reproducible.',
    'A query captures its snapshot when actual SQL CPU service starts after queueing, not at arrival or completion. Freshness is audited at client delivery: delivery time minus asOfMs must be at most 5000 ms, and correctness is checked against the matching snapshot tuple. A correct but stale cached answer fails freshness, and successful transport of a stale payload never qualifies.',
    'A projection advances its cursor only after every outbox event through that sequence and all required expiry work are durably applied. With no events, a fixed 100 ms heartbeat schedules real expiry/index CPU and IO work before advancing asOfMs. Batches are at most 128 events; a full batch is processed continuously and 100 ms is only the maximum wait for a partial batch. Multiple workers publish one ordered prefix or an equivalent exact global cut; partitioned states at different times are never combined.',
    'eventId binds the immutable (userId, streamId, payload). Repeating the same id and payload returns the original committed result with its original timestamp and creates no second event or outbox job. A mismatched payload is a conflict with no effect. An Application crash cancels Application-owned work and its response, but never undoes a durable SQL commit or necessarily cancels accepted SQL work. Retry after a lost ACK uses the same id.',
    'Each required app-instance failure case crashes exactly one physical slot for 15 seconds at 30 s, then boots for 1 s and becomes routable only after two successful probes. Durable SQL commits and outbox rows survive; volatile Application RAM, queued work and active work do not. The fault target is the slot index plus case id and is stable under node order or renaming.',
    'Probes start at measured 0 and repeat every 250 ms per instance. A failure counts only when its 100 ms probe times out, never at launch; a success counts at completed response. Two consecutive failures exclude the backend, and two successes after boot mark it ready. Actual process health and Load-Balancer-known health are separate, and health publication precedes arrivals at the same clock.',
    'One transport retry is allowed inside the original 1000 ms logical deadline with a fixed 25 ms backoff, excluding the last backend when another known-healthy backend exists. Queue overflow, validation and business failures are not retried. A new attempt to an already-dead process uses a fixed 100 ms connection timeout. A process crash closes connections: the client observes the drop after 11 ms through the Load Balancer or 10 ms on a direct path. There is no free hedging.',
    'Scheduler ties use documented priorities: injected crash, boot completion, normal resource/network completion, request/task/probe timeout, health-result publication, arrival/probe launch, background poll/heartbeat. Insertion order is stable inside a priority. The shared kernel tie rules are unchanged; the monotonic commit sequence remains authoritative for visible commits.',
    'The Application queue holds 256 waiting tasks per instance, SQL holds 128 and the Cache 512. Overflow is a distinct rejection, separate from the 1000 ms deadline. CPU instant peak of 100% by itself is not an error; action is recommended by measured service gates. Queue averages are time-weighted over the same window and never exceed their observed peak.',
    'The Cache stores one shared 4096-byte ranking answer. Cold misses coalesce, waiting clients keep individual deadlines and are released cleanly. The selected TTL is the actual retention policy and is not clamped to the 5 s freshness SLO. A cached response keeps its original snapshot tuple and is audited at delivery; a long TTL can produce a transport-successful but stale answer that fails freshness.',
    'Correctness covers offered, committed, acknowledged and pending events separately, exact distinct/expiry reference snapshots, idempotent replays, conflicts, duplicate effects, lost acknowledged events, commits that survive a crash and the published projection prefix. Query and projection must answer from actual committed data and must not count failed ingest.',
    'Availability counts every offered logical request, including rejections, timeouts and unknown final outcomes. Attempts, retries and resource bytes are reported separately. Successful p95 uses successful responses only and needs at least 100 samples; no calls cannot pass latency. Whole-case and critical offer cohorts are gated separately: normal uses the whole case, peak uses [20,60) s and fault uses [30,50) s.',
    'Every successful ranking must be fresh and exactly correct for its named snapshot. Stale answers and wrong-window answers are reported as separate failures. All acknowledged events must be preserved exactly once and a complete bounded drain is required.',
    'Normal, peak and every fault case start from the same prehistory. The overall score is only the fixed peak case actual cost and exists only when every required case passes. Fault-case costs are visible but never summed into the score, so extra qualification cases do not tax a design. No candidate is claimed to be the cost optimum.',
    'Out of scope for this profile: SQL, Cache, Worker, Load Balancer, zone, broker or region failures; replication and multi-region claims; RTO gates; approximate distinct algorithms; country filters; multiple windows; authorization and audit history. A pass means the declared qualification cases passed, not full production resilience.',
  ],
};

export const AUDIENCE_LEVEL: AudienceLevel = audienceLevelSchema.parse(level);

export function cloneAudienceLevel(): AudienceLevel {
  return JSON.parse(JSON.stringify(AUDIENCE_LEVEL)) as AudienceLevel;
}

export function parseAudienceLevel(
  input: unknown,
): AudienceParseResult<AudienceLevel> {
  const parsed = audienceLevelSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      value: null,
      issues: audienceIssuesFromZod(parsed.error),
    };
  }
  return { ok: true, value: parsed.data, issues: [] };
}

export function isAudienceSeed(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= AUDIENCE_MAX_SEED
  );
}

/** One payload for CLI/API discovery and public help. */
export function describeAudienceLevel(): {
  level: AudienceLevel;
  operations: readonly string[];
  windows: readonly string[];
  nodeKinds: readonly string[];
  cases: {
    profileVersion: string;
    scoreCaseId: 'peak';
    requiredKinds: readonly string[];
    appInstances: { min: 1; max: 4 };
    maxCases: number;
  };
  seeds: {
    default: number;
    calibration: readonly number[];
    holdout: readonly number[];
  };
  rules: readonly string[];
} {
  return {
    level: cloneAudienceLevel(),
    operations: ['Record activity', 'View audience ranking'],
    windows: ['whole 90 s', 'peak 20-60 s', 'fault 30-50 s'],
    nodeKinds: [
      'Users',
      'Managed Load Balancer',
      'Application',
      'SQL Database',
      'Cache',
      'Worker pool',
    ],
    cases: {
      profileVersion: AUDIENCE_LEVEL.challenges.profileVersion,
      scoreCaseId: 'peak',
      requiredKinds: [...AUDIENCE_LEVEL.challenges.requiredKinds],
      appInstances: { min: 1, max: 4 },
      maxCases: AUDIENCE_LEVEL.challenges.maxCases,
    },
    seeds: {
      default: AUDIENCE_LEVEL.defaultSeed,
      calibration: [...AUDIENCE_LEVEL.calibrationSeeds],
      holdout: [...AUDIENCE_LEVEL.holdoutSeeds],
    },
    rules: [...AUDIENCE_LEVEL.assumptions],
  };
}
