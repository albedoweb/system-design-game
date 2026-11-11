import {
  SCOREBOARD_CONTENT_VERSION,
  SCOREBOARD_LEVEL_ID,
  SCOREBOARD_MAX_SEED,
  SCOREBOARD_MODEL_VERSION,
  SCOREBOARD_PRICING_VERSION,
  SCOREBOARD_SCHEMA_VERSION,
  scoreboardIssuesFromZod,
  scoreboardLevelSchema,
  type ScoreboardLevel,
  type ScoreboardParseResult,
} from './contracts';

/**
 * Authoritative Live Scoreboard level. Everything a player needs to know is
 * visible here; the same values drive validation, simulation and the result.
 */
const level: ScoreboardLevel = {
  schemaVersion: SCOREBOARD_SCHEMA_VERSION,
  contentVersion: SCOREBOARD_CONTENT_VERSION,
  modelVersion: SCOREBOARD_MODEL_VERSION,
  pricingVersion: SCOREBOARD_PRICING_VERSION,
  id: SCOREBOARD_LEVEL_ID,
  title: 'Live Scoreboard',
  summary:
    '500,000 participants can change one current vote for 100 candidates. Viewers share the same top-20 leaderboard, and traffic jumps during the result announcement.',
  task:
    'Build a system that keeps both View leaderboard and Change vote available and fast. Leaderboard snapshots may be up to 5 seconds behind, but acknowledged votes must not be lost or counted twice. Among passing designs, lower actual operating cost wins.',
  dataset: {
    participants: 500_000,
    candidates: 100,
    currentVoteBytes: 128,
    workingSetBytes: 64_000_000,
    initialVotes: 'deterministic',
    fixedPopulation: true,
    historyRetained: false,
  },
  workload: {
    measuredMs: 90_000,
    readPhases: [
      { fromMs: 0, toMs: 20_000, readsPerSecond: 10 },
      { fromMs: 20_000, toMs: 60_000, readsPerSecond: 200 },
      { fromMs: 60_000, toMs: 90_000, readsPerSecond: 10 },
    ],
    voteChangesPerSecond: 100,
    requestDeadlineMs: 1_000,
    drainMs: 10_000,
    peakWindow: { fromMs: 20_000, toMs: 60_000 },
    traceSeedPolicy: 'graph-independent',
    arrivalModel: 'poisson',
    oneTracePerSeed: true,
    cacheInitialState: 'cold',
    tieBreak: 'candidate-id-ascending',
    topN: 20,
  },
  limits: {
    maxSqlWaitingTasks: 128,
    maxAppWaitingTasks: 256,
    maxCacheWaitingTasks: 512,
    maxEvents: 2_000_000,
    maxFrames: 240,
    maxIssues: 32,
  },
  slo: {
    availability: 0.995,
    successfulP95Ms: 250,
    freshnessMs: 5_000,
    minimumLatencySamples: 100,
  },
  defaultSeed: 101,
  calibrationSeeds: [101, 211, 307, 401, 503],
  holdoutSeeds: [607, 701],
  assumptions: [
    'Teaching model, not a production benchmark. Prices and work coefficients are conditional in-game values and must be calibrated by real evaluator runs.',
    'Exactly 500,000 participants each have one current vote for one of 100 candidates. A change replaces that row; it never appends a second vote. No registration, audit history or multi-year growth is modelled.',
    'The level offers a fixed exogenous trace. Arrival intervals and participant/candidate identities come from independent seeded streams and do not depend on the graph, strategy, scheduler, callback order or resource contention.',
    'Initial votes are deterministic from the seed. The chosen primary SQL database is seeded before traffic. The cache is empty at the start of the measured run.',
    'One App service pool, exactly one primary SQL database and at most one Cache. Users -> App, App -> SQL, optional App -> Cache and Cache -> SQL. Connection roles are inferred from the component pair; there are no business ports to choose.',
    'A missing, duplicate, extra, disconnected, cyclic or ambiguous connection is a validation error. A cache cannot serve a write, and no alternate free data source exists.',
    'Raw leaderboard reads inspect 500,000 rows at 0.2 microseconds per row on one core: 100 core-milliseconds per query. More cores increase query concurrency only; one scan is never divided across cores.',
    'A maintained aggregate reads 100 rows (1 core-millisecond) and charges 0.6 core-milliseconds per vote-change transaction instead of 0.2. The aggregate is built from raw votes before the 90-second clock; its real preparation work and rental are reported and charged, and the cache stays cold.',
    'The SQL queue holds at most 128 waiting tasks and the application pool 256. Overflow is a distinct rejection, not a deadline timeout. Every request also has a 1000 ms deadline; an accepted request may expire separately. The drain after the last offer is bounded and any remaining work makes the run incomplete, never silently successful.',
    'Top-20 ties resolve by ascending candidate id. The response is 4 KiB. A read snapshot is captured when its SQL query actually starts after queueing, and must represent one consistent committed version.',
    'A write transaction atomically updates the participant row, decrements the old candidate counter and increments the new one (when it changed), then persists before ACK. A timeout before commit has no effect. A timeout after commit but before ACK leaves one durable effect and is reported as committed-unacknowledged; repeating the same logical write has no second effect.',
    'Freshness is not cache age. At response time the state must include every vote committed at or before now - 5 seconds. A snapshot is stale only when a required committed version is missing; a quiet system is not given invented staleness.',
    'Caches are cold-start scored. Concurrent misses for the single leaderboard key coalesce into one SQL fill; waiting clients are counted, obey the same deadline and are removed cleanly. TTL 15 seconds is expected to fail freshness under continual writes.',
    'The network is one region with a 20 ms client RTT and 1 ms one-way internal propagation. Every hop uses the sending node NIC and one 1 Gbit/s lane per flow. Only delivered client response bytes are billed; internal bytes are measured.',
    'Availability counts every offered request, including rejections and timeouts. Percentiles use successful responses only and are reported with their sample counts. Empty or insufficient samples never become zero latency or a pass.',
    'Both the whole 90-second cohort and the peak 20-60 second offer cohort must satisfy per-operation availability and successful p95. Outcomes of peak-cohort requests are counted even when they finish during drain.',
    'Cost is actual rental for preparation, the 90 seconds and drain, plus billed response bytes. Hourly rent is reported separately. There is no monthly extrapolation and no hard budget that blocks an expensive but passing design.',
    'No regions, node faults, network partitions, replication lag, DDoS, authorization, audit history, asynchronous workers or separate queue scheduler are modelled. A pass does not claim production resilience.',
  ],
};

export const SCOREBOARD_LEVEL: ScoreboardLevel =
  scoreboardLevelSchema.parse(level);

export function cloneScoreboardLevel(): ScoreboardLevel {
  return JSON.parse(JSON.stringify(SCOREBOARD_LEVEL)) as ScoreboardLevel;
}

export function parseScoreboardLevel(
  input: unknown,
): ScoreboardParseResult<ScoreboardLevel> {
  const parsed = scoreboardLevelSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      value: null,
      issues: scoreboardIssuesFromZod(parsed.error),
    };
  }
  return { ok: true, value: parsed.data, issues: [] };
}

export function isScoreboardSeed(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= SCOREBOARD_MAX_SEED
  );
}

/** One payload for CLI/API discovery and public help. */
export function describeScoreboardLevel(): {
  level: ScoreboardLevel;
  operations: readonly string[];
  windows: readonly string[];
  nodeKinds: readonly string[];
  seeds: {
    default: number;
    calibration: readonly number[];
    holdout: readonly number[];
  };
  rules: readonly string[];
} {
  return {
    level: cloneScoreboardLevel(),
    operations: ['View leaderboard', 'Change vote'],
    windows: ['whole 90 s', 'peak 20-60 s'],
    nodeKinds: ['Users', 'Application', 'SQL Database', 'Cache'],
    seeds: {
      default: SCOREBOARD_LEVEL.defaultSeed,
      calibration: [...SCOREBOARD_LEVEL.calibrationSeeds],
      holdout: [...SCOREBOARD_LEVEL.holdoutSeeds],
    },
    rules: [...SCOREBOARD_LEVEL.assumptions],
  };
}
