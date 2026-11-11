/**
 * Typed adapter for the Live Audience core.
 *
 * Parsing, semantic validation, digesting, catalog/level metadata and
 * evaluation all come from the public `src/audience/index.ts` module. This file
 * owns no tuning values and exposes no caller-supplied catalog, price,
 * workload, SLO, case or profile override.
 *
 * The evaluator is imported directly. `createAudienceAdapter` still accepts an
 * injected evaluator for focused tests, but there is no contract-only fallback
 * in the released level.
 */

import {
  AUDIENCE_CATALOG,
  AUDIENCE_CONTENT_VERSION,
  AUDIENCE_LEVEL,
  AUDIENCE_LEVEL_ID,
  AUDIENCE_MAX_INSTANCES_PER_NODE,
  AUDIENCE_MAX_SEED,
  AUDIENCE_MODEL_VERSION,
  AUDIENCE_NODE_KINDS,
  AUDIENCE_OPERATION_LABELS,
  AUDIENCE_OPERATIONS,
  AUDIENCE_PRICING_VERSION,
  AUDIENCE_PROFILE_VERSION,
  AUDIENCE_SCHEMA_VERSION,
  audienceEvaluationJsonSchema,
  audienceGraphDigest,
  audienceGraphJsonSchema,
  audienceRequiredCaseIds,
  cloneAudienceCatalog,
  cloneAudienceLevel,
  createAudienceChallengeProfile,
  createAudienceStarterGraph,
  describeAudienceLevel,
  evaluateAudience,
  linkRoleOfAudienceEdge,
  parseAudienceGraph,
  validateAudienceGraph,
  type AudienceAppNode,
  type AudienceCacheNode,
  type AudienceEvaluation,
  type AudienceGraph,
  type AudienceIssue,
  type AudienceNodeKind,
  type AudienceRunOptions,
  type AudienceSqlNode,
  type AudienceWorkerNode,
} from '../audience/index';
import {
  type AudienceEngineAdapter,
  type EngineIssueLike,
  type EngineLevelDescriptor,
  type EngineParseResult,
  type EngineRunExpectation,
} from './contracts';

export type AudienceEvaluator = (
  input: unknown,
  options: AudienceRunOptions,
) => AudienceEvaluation;

function audienceDescriptor(): EngineLevelDescriptor {
  return {
    id: AUDIENCE_LEVEL_ID,
    title: AUDIENCE_LEVEL.title,
    description: AUDIENCE_LEVEL.summary,
    defaultSeed: AUDIENCE_LEVEL.defaultSeed,
    seed: { min: 0, max: AUDIENCE_MAX_SEED },
    modelVersion: AUDIENCE_MODEL_VERSION,
    schemaVersion: AUDIENCE_SCHEMA_VERSION,
    contentVersion: AUDIENCE_CONTENT_VERSION,
    pricingVersion: AUDIENCE_PRICING_VERSION,
    profileVersion: AUDIENCE_PROFILE_VERSION,
    availability: 'playable',
  };
}

function asEngineIssues(
  issues: readonly AudienceIssue[],
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

function parseAudience(input: unknown): EngineParseResult<AudienceGraph> {
  const parsed = parseAudienceGraph(input);
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

function validateAudience(
  graph: AudienceGraph,
): readonly EngineIssueLike[] {
  return asEngineIssues(validateAudienceGraph(graph));
}

function nodeKindList(graph: AudienceGraph): readonly AudienceNodeKind[] {
  return graph.nodes.map((node) => node.kind);
}

/**
 * Exact qualification expectation derived from the submitted graph. The
 * backend binds every returned case id and physical slot to this object, so a
 * worker cannot omit a mandatory case or retarget a failure by changing the
 * result body. Labels, positions and node ids are irrelevant here.
 */
export function audienceRunExpectation(
  input: unknown,
): EngineRunExpectation | null {
  const parsed = parseAudienceGraph(input);
  if (!parsed.ok) {
    return null;
  }
  const graph = parsed.value;
  if (
    validateAudienceGraph(graph).some((issue) => issue.severity === 'error')
  ) {
    return null;
  }
  const app = graph.nodes.find(
    (node): node is AudienceAppNode => node.kind === 'app',
  );
  const sql = graph.nodes.find(
    (node): node is AudienceSqlNode => node.kind === 'sql',
  );
  if (app === undefined || sql === undefined) {
    return null;
  }
  const cache = graph.nodes.find(
    (node): node is AudienceCacheNode => node.kind === 'cache',
  );
  const worker = graph.nodes.find(
    (node): node is AudienceWorkerNode => node.kind === 'worker',
  );
  const appInstances = app.config.instances;
  const nodes = graph.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    instances:
      node.kind === 'app' || node.kind === 'worker'
        ? node.config.instances
        : 1,
  }));
  const edges: {
    id: string;
    from: string;
    to: string;
    role: string;
  }[] = [];
  for (const edge of graph.edges) {
    const role = linkRoleOfAudienceEdge(graph, edge);
    if (role === null) {
      return null;
    }
    edges.push({ id: edge.id, from: edge.from, to: edge.to, role });
  }
  return {
    provisioning: {
      appInstances,
      sqlSize: sql.config.size,
      readPlan: sql.config.readPlan,
      cacheTtlSeconds: cache?.config.ttlSeconds ?? null,
      workerInstances: worker?.config.instances ?? 0,
      loadBalancer: graph.nodes.some((node) => node.kind === 'lb'),
      nodeKinds: nodeKindList(graph),
    },
    cases: audienceRequiredCaseIds(appInstances).map((id) => ({
      id,
      kind:
        id === 'normal'
          ? 'normal'
          : id === 'peak'
            ? 'peak'
            : 'app-instance-failure',
      targetInstance: id.startsWith('app-failure-')
        ? Number(id.slice('app-failure-'.length))
        : null,
    })),
    nodes,
    edges,
  };
}

/**
 * Authoritative discovery payload. Every value is compiled from the frozen
 * Audience core; the registry never merges it with request data.
 */
function audienceComponents(): unknown {
  const described = describeAudienceLevel();
  return {
    levelId: AUDIENCE_LEVEL_ID,
    schemaVersion: AUDIENCE_CATALOG.schemaVersion,
    pricingVersion: AUDIENCE_CATALOG.pricingVersion,
    profileVersion: AUDIENCE_CATALOG.profileVersion,
    currency: AUDIENCE_CATALOG.currency,
    catalog: cloneAudienceCatalog(),
    operations: [...AUDIENCE_OPERATIONS],
    operationLabels: { ...AUDIENCE_OPERATION_LABELS },
    windows: [...described.windows],
    nodeKinds: [...described.nodeKinds],
    palette: [...AUDIENCE_NODE_KINDS],
    seeds: {
      default: described.seeds.default,
      calibration: [...described.seeds.calibration],
      holdout: [...described.seeds.holdout],
    },
    challenges: { ...described.cases },
    /** Authoritative shape for the largest possible pool (4 app slots). */
    maxInstancesChallengeProfile: createAudienceChallengeProfile(
      AUDIENCE_MAX_INSTANCES_PER_NODE,
    ),
    rules: [...described.rules],
  };
}

export function createAudienceAdapter(
  evaluator: AudienceEvaluator = evaluateAudience,
): AudienceEngineAdapter {
  return {
    levelId: AUDIENCE_LEVEL_ID,
    modelVersion: AUDIENCE_MODEL_VERSION,
    schemaVersion: AUDIENCE_SCHEMA_VERSION,
    resultKind: 'level-result',
    describe: audienceDescriptor,
    parseGraph: parseAudience,
    validateGraph: validateAudience,
    evaluate: (input, options) => evaluator(input, options),
    graphDigest: (graph) => audienceGraphDigest(graph),
  };
}

/** Stable starter example (Users only) and the authoritative schemas. */
export const AUDIENCE_EXAMPLE = createAudienceStarterGraph;
export const audienceResultSchema = audienceEvaluationJsonSchema;
export const audienceGraphSchema = audienceGraphJsonSchema;
export const audienceLevelDefinition = cloneAudienceLevel;
export { audienceComponents };

export type { AudienceEvaluation };
