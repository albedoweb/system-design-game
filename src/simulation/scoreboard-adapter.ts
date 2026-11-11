/**
 * Typed adapter for the frozen Live Scoreboard core.
 *
 * The adapter is a thin, versioned boundary: parsing, semantic validation,
 * digesting and evaluation all come from the public `src/scoreboard/index.ts`
 * module. It does not reimplement any part of the simulation and it exposes no
 * caller-supplied catalog, price, workload, SLO or gate override. Graph
 * documents are re-parsed on every evaluation, so a client can never inject a
 * pre-validated internal graph.
 */

import {
  SCOREBOARD_CATALOG,
  SCOREBOARD_CONTENT_VERSION,
  SCOREBOARD_LEVEL,
  SCOREBOARD_LEVEL_ID,
  SCOREBOARD_MAX_SEED,
  SCOREBOARD_MODEL_VERSION,
  SCOREBOARD_OPERATIONS,
  SCOREBOARD_PRICING_VERSION,
  SCOREBOARD_SCHEMA_VERSION,
  cloneScoreboardCatalog,
  cloneScoreboardLevel,
  createScoreboardStarterGraph,
  describeScoreboardLevel,
  evaluateScoreboard,
  parseScoreboardGraph,
  scoreboardEvaluationJsonSchema,
  scoreboardGraphDigest,
  scoreboardGraphJsonSchema,
  validateScoreboardGraph,
  type ScoreboardEvaluation,
  type ScoreboardGraph,
  type ScoreboardIssue,
} from '../scoreboard/index';
import type {
  EngineIssueLike,
  EngineLevelDescriptor,
  EngineParseResult,
  ScoreboardEngineAdapter,
} from './contracts';

function scoreboardDescriptor(): EngineLevelDescriptor {
  return {
    id: SCOREBOARD_LEVEL_ID,
    title: SCOREBOARD_LEVEL.title,
    description: SCOREBOARD_LEVEL.summary,
    defaultSeed: SCOREBOARD_LEVEL.defaultSeed,
    seed: { min: 0, max: SCOREBOARD_MAX_SEED },
    modelVersion: SCOREBOARD_MODEL_VERSION,
    schemaVersion: SCOREBOARD_SCHEMA_VERSION,
    contentVersion: SCOREBOARD_CONTENT_VERSION,
    pricingVersion: SCOREBOARD_PRICING_VERSION,
    availability: 'playable',
  };
}

function asEngineIssues(
  issues: readonly ScoreboardIssue[],
): readonly EngineIssueLike[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    severity: issue.severity,
    ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
    ...(issue.edgeId === undefined ? {} : { edgeId: issue.edgeId }),
    ...(issue.path === undefined ? {} : { path: issue.path }),
    ...(issue.operation === undefined ? {} : { operation: issue.operation }),
    ...(issue.metric === undefined ? {} : { metric: issue.metric }),
    ...(issue.value === undefined ? {} : { value: issue.value }),
    ...(issue.limit === undefined ? {} : { limit: issue.limit }),
    ...(issue.count === undefined ? {} : { count: issue.count }),
  }));
}

function parseScoreboard(input: unknown): EngineParseResult<ScoreboardGraph> {
  const parsed = parseScoreboardGraph(input);
  return parsed.ok
    ? {
        ok: true,
        graph: parsed.value,
        issues: asEngineIssues(parsed.issues),
      }
    : {
        ok: false,
        graph: null,
        issues: asEngineIssues(parsed.issues),
      };
}

function validateScoreboard(
  graph: ScoreboardGraph,
): readonly EngineIssueLike[] {
  return asEngineIssues(validateScoreboardGraph(graph));
}

/**
 * Authoritative catalog payload for discovery. Every value is compiled from
 * the frozen core; the registry never merges it with request data.
 */
function scoreboardComponents(): unknown {
  const described = describeScoreboardLevel();
  return {
    levelId: SCOREBOARD_LEVEL_ID,
    schemaVersion: SCOREBOARD_CATALOG.schemaVersion,
    pricingVersion: SCOREBOARD_CATALOG.pricingVersion,
    currency: SCOREBOARD_CATALOG.currency,
    catalog: cloneScoreboardCatalog(),
    operations: [...SCOREBOARD_OPERATIONS],
    operationLabels: described.operations,
    windows: [...described.windows],
    nodeKinds: [...described.nodeKinds],
    seeds: {
      default: described.seeds.default,
      calibration: [...described.seeds.calibration],
      holdout: [...described.seeds.holdout],
    },
    rules: [...described.rules],
  };
}

export function createScoreboardAdapter(): ScoreboardEngineAdapter {
  return {
    levelId: SCOREBOARD_LEVEL_ID,
    modelVersion: SCOREBOARD_MODEL_VERSION,
    schemaVersion: SCOREBOARD_SCHEMA_VERSION,
    resultKind: 'level-result',
    describe: scoreboardDescriptor,
    parseGraph: parseScoreboard,
    validateGraph: validateScoreboard,
    evaluate: (input, options) => evaluateScoreboard(input, options),
    graphDigest: (graph) => scoreboardGraphDigest(graph),
  };
}

/** Stable starter example (Users only) and the authoritative schemas. */
export const SCOREBOARD_EXAMPLE = createScoreboardStarterGraph;
export const scoreboardResultSchema = scoreboardEvaluationJsonSchema;
export const scoreboardGraphSchema = scoreboardGraphJsonSchema;
export const scoreboardLevelDefinition = cloneScoreboardLevel;
export { scoreboardComponents };

export type { ScoreboardEvaluation };
