/**
 * Global Cart adapter for the common engine boundary.
 *
 * The adapter binds the frozen `cart-protocol-v1` public surface (GC-003
 * schemas/digest, GC-011 evaluator, GC-012 telemetry) to the shared
 * discovery/validate/evaluate shape used by the browser worker, agent CLI and
 * backend. It adds no second copy of a rule, price, limit or case: everything
 * is forwarded from `src/cart/index.ts`.
 */

import {
  CART_CATALOG,
  CART_DEFAULT_SEED,
  CART_EDGE_KINDS,
  CART_LEVEL_ID,
  CART_MAX_SEED,
  CART_NODE_KINDS,
  CART_READ_POLICIES,
  CART_REGIONS,
  CART_REQUIRED_CASES,
  CART_VERSIONS,
  cartEvaluationJsonSchema,
  cartGraphDigest,
  cartGraphJsonSchema,
  cartOperationClassSchema,
  cloneCartCatalog,
  createCartStarterGraph,
  describeCartLevel,
  evaluateCart,
  parseCartGraph,
  validateCartGraph,
  type CartEvaluation,
  type CartGraph,
  type CartIssue,
} from '../cart/index';
import {
  type CartEngineAdapter,
  type CartRunOptions,
  type EngineIssueLike,
  type EngineParseResult,
  type EngineProgress,
  type EngineRunRequirements,
} from './contracts';

/** Map the cart session's progress record onto the common progress event. */
function toEngineProgress(progress: {
  readonly caseId: string | null;
  readonly casesCompleted: number;
  readonly events: number;
  readonly elapsedUs: number;
  readonly message?: string;
}): EngineProgress {
  return {
    phase: 'simulate',
    horizonYears: null,
    scenario: progress.caseId,
    completed: progress.casesCompleted,
    total: CART_REQUIRED_CASES.length,
    message:
      progress.message ??
      `Case ${progress.caseId ?? 'pending'}; ${progress.events} events observed.`,
  };
}

/** Structural/semantic cart issues become error-severity engine issues. */
function toEngineIssue(issue: CartIssue): EngineIssueLike {
  return {
    code: issue.code,
    message: issue.message,
    severity: 'error',
    ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
    ...(issue.edgeId === undefined ? {} : { edgeId: issue.edgeId }),
  };
}

export function createCartAdapter(): CartEngineAdapter {
  const discovery = describeCartLevel();
  return {
    levelId: CART_LEVEL_ID,
    modelVersion: CART_VERSIONS.model,
    schemaVersion: 1,
    resultKind: 'level-result',
    describe() {
      return {
        id: CART_LEVEL_ID,
        title: discovery.title,
        description: discovery.description,
        defaultSeed: CART_DEFAULT_SEED,
        seed: { min: 0, max: CART_MAX_SEED },
        modelVersion: CART_VERSIONS.model,
        schemaVersion: 1,
        contentVersion: CART_VERSIONS.content,
        pricingVersion: CART_VERSIONS.pricing,
        profileVersion: CART_VERSIONS.profile,
        availability: 'playable',
        requiredCases: [...CART_REQUIRED_CASES],
      };
    },
    parseGraph(input: unknown): EngineParseResult<CartGraph> {
      const parsed = parseCartGraph(input, CART_VERSIONS.content);
      return parsed.ok
        ? { ok: true, graph: parsed.graph, issues: [] }
        : { ok: false, graph: null, issues: parsed.issues.map(toEngineIssue) };
    },
    validateGraph(graph: CartGraph): readonly EngineIssueLike[] {
      return validateCartGraph(graph).map(toEngineIssue);
    },
    evaluate(input: unknown, options: CartRunOptions): CartEvaluation {
      return evaluateCart(input, {
        seed: options.seed,
        ...(options.onProgress === undefined
          ? {}
          : {
              onProgress: (progress) =>
                options.onProgress?.(toEngineProgress(progress)),
            }),
      });
    },
    graphDigest(graph: CartGraph): string | null {
      try {
        return cartGraphDigest(graph);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Public discovery payload for API/CLI components: exact regions, node kinds,
 * operation classes, required cases and the proposed work/pricing tables.
 */
export function cartComponents(): unknown {
  return {
    levelId: CART_LEVEL_ID,
    versions: { ...CART_VERSIONS },
    pricingVersion: CART_CATALOG.pricingVersion,
    profileVersion: CART_CATALOG.profileVersion,
    currency: CART_CATALOG.currency,
    regions: [...CART_REGIONS],
    nodeKinds: [...CART_NODE_KINDS],
    edgeKinds: [...CART_EDGE_KINDS],
    readPolicies: [...CART_READ_POLICIES],
    operations: [...cartOperationClassSchema.options],
    requiredCases: [...CART_REQUIRED_CASES],
    catalog: cloneCartCatalog(),
    work: CART_CATALOG.work,
    pricing: {
      nodes: CART_CATALOG.nodes,
      network: CART_CATALOG.network,
      budget: CART_CATALOG.budget,
    },
    scoring: CART_CATALOG.scoring,
    calibration: CART_CATALOG.calibration,
  };
}

export function cartLevelDefinition(): unknown {
  return describeCartLevel();
}

export function cartGraphSchema(): Record<string, unknown> {
  return cartGraphJsonSchema();
}

export function cartResultSchema(): Record<string, unknown> {
  return cartEvaluationJsonSchema();
}

export function createCartStarter(): CartGraph {
  return createCartStarterGraph();
}

/**
 * Mandatory qualification cases are a frozen property of the level, not of the
 * submitted result. The backend binds them to the submitted graph so omitted
 * or retargeted cases are rejected during worker validation.
 */
export function cartRunRequirements(): EngineRunRequirements {
  return { requiredCases: [...CART_REQUIRED_CASES] };
}
