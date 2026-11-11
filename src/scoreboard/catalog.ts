import {
  SCOREBOARD_PRICING_VERSION,
  SCOREBOARD_SCHEMA_VERSION,
  scoreboardCatalogSchema,
  scoreboardIssuesFromZod,
  type ScoreboardCatalog,
  type ScoreboardParseResult,
} from './contracts';

/**
 * Shared conditional component catalog for Live Scoreboard.
 *
 * These are general Users / Application / SQL Database / Cache capabilities,
 * not vendor products. Prices and work coefficients are teaching values. The
 * authoritative copy lives in code; a graph can never override it.
 */
const catalog: ScoreboardCatalog = {
  schemaVersion: SCOREBOARD_SCHEMA_VERSION,
  pricingVersion: SCOREBOARD_PRICING_VERSION,
  currency: 'USD',
  priceNote:
    'Conditional in-game prices and work coefficients. RAM, disk and one lane of NIC bandwidth are included in each instance price; no monthly extrapolation is used for scoring.',
  componentPalette: ['users', 'app', 'sql', 'cache'],
  components: {
    users: {
      kind: 'users',
      label: 'Users',
      fixed: true,
      configurableFields: [],
      notes:
        'Fixed population of 500,000 participants. It emits two streams: leaderboard views and vote changes. Only its label and position are editable.',
    },
    app: {
      kind: 'app',
      label: 'Application',
      fixed: false,
      configurableFields: ['instances'],
      instances: { min: 1, max: 4, default: 1 },
      cpuCoresPerInstance: 1,
      memoryGbPerInstance: 8,
      nicGbitPerSecPerInstance: 1,
      hourlyUsdPerInstance: 0.06,
      notes:
        'Service pool with request distribution inside the pool. Extra instances add CPU, RAM and NIC capacity and are charged per instance; there is no separate free load balancer.',
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
        scan: {
          label: 'Compute from raw votes',
          description:
            'Every leaderboard read scans all 500,000 current-vote rows. Extra cores run more queries in parallel; they never split one query scan.',
        },
        aggregate: {
          label: 'Maintain a vote aggregate',
          description:
            'Keep a 100-row per-candidate projection in the same transaction as each vote change. Reads visit 100 rows instead of 500,000, but every write does extra atomic work.',
        },
      },
      notes:
        'Exactly one primary database in this level. The whole 64 MB working set fits in RAM at every size. Queue limit is disclosed by the level and is not player-tunable.',
    },
    cache: {
      kind: 'cache',
      label: 'Cache',
      fixed: false,
      configurableFields: ['ttlSeconds'],
      ttlOptionsSeconds: [0.5, 2, 5, 15],
      capacityBytes: 4_096,
      entryBytes: 4_096,
      coalescing: 'fixed-on',
      cpuCores: 1,
      memoryGb: 1,
      nicGbitPerSec: 10,
      hourlyUsd: 0.06,
      notes:
        'One shared leaderboard answer fits exactly. Concurrent misses for a cold key coalesce into one fill; waiting clients are counted and cancelled by their own deadline. Writes never invalidate the entry; TTL is the disclosed bounded-staleness policy.',
    },
  },
  work: {
    rawScanCoreMsPerRow: 0.0002,
    aggregateReadCoreMs: 1,
    rawWriteCoreMs: 0.2,
    aggregateWriteCoreMs: 0.6,
    aggregateBuildExtraCoreMs: 2,
    appReadCoreMs: 0.2,
    appWriteCoreMs: 0.3,
    cacheLookupCoreMs: 0.1,
    cacheStoreCoreMs: 0.2,
    sqlDiskWriteCoreMs: 0.1,
    diskWriteBytesPerVote: 128,
    clientRequestProcessingMs: 0.2,
    clientResponseProcessingMs: 0.2,
  },
  network: {
    clientRttMs: 20,
    internalOneWayMs: 1,
    clientRequestBytes: 400,
    clientResponseBytes: 4_096,
    writeAckBytes: 200,
    laneGbitPerSec: 1,
  },
  billing: {
    responseBytesUsdPerGb: 0.02,
    bytesPerGb: 1_000_000_000,
  },
};

export const SCOREBOARD_CATALOG: ScoreboardCatalog =
  scoreboardCatalogSchema.parse(catalog);

export function cloneScoreboardCatalog(): ScoreboardCatalog {
  return JSON.parse(JSON.stringify(SCOREBOARD_CATALOG)) as ScoreboardCatalog;
}

export function parseScoreboardCatalog(
  input: unknown,
): ScoreboardParseResult<ScoreboardCatalog> {
  const parsed = scoreboardCatalogSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      value: null,
      issues: scoreboardIssuesFromZod(parsed.error),
    };
  }
  return { ok: true, value: parsed.data, issues: [] };
}
