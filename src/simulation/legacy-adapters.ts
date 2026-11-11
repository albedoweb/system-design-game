/**
 * Typed adapters for the three frozen level cores.
 *
 * The adapters do not fork or rewrite any engine:
 * - Cold Cache keeps `createSimulation`, `DEFAULT_LEVEL` and `RunResult`; the
 *   adapter finalises the interactive engine into an explicit envelope.
 * - Parcel Pulse keeps `evaluateParcel` and its frozen result bodies.
 * - Image Atlas imports the I101 evaluator through an explicit injection seam;
 *   when it is absent the level is contract-only and `evaluate` fails safely.
 */

import { DomainValidationError } from '../domain/errors';
import {
  parseGraph,
  validateGraph,
  type GraphDocument,
} from '../domain/graph';
import {
  DEFAULT_LEVEL,
  MAX_SEED as COLD_MAX_SEED,
  SUPPORTED_MODEL_VERSION as COLD_MODEL_VERSION,
} from '../domain/level';
import { createSimulation, SimulationLimitError } from '../engine';
import {
  IMAGE_CONTENT_VERSION,
  IMAGE_LEVEL,
  IMAGE_LEVEL_ID,
  IMAGE_MAX_SEED,
  IMAGE_MODEL_VERSION,
  IMAGE_PRICING_VERSION,
  IMAGE_REQUIRED_SCENARIOS,
  IMAGE_SCHEMA_VERSION,
  imageGraphDigest,
  parseImageGraph,
  validateImageGraph,
  type ImageEvaluation,
  type ImageGraph,
  type ImageIssue,
  type ImageRunOptions,
  type ImageScenarioName,
} from '../images/index';
import {
  PARCEL_CONTENT_VERSION,
  PARCEL_LEVEL,
  PARCEL_LEVEL_ID,
  PARCEL_MAX_SEED,
  PARCEL_MODEL_VERSION,
  PARCEL_PRICING_VERSION,
  PARCEL_REQUIRED_HORIZONS,
  PARCEL_SCHEMA_VERSION,
  evaluateParcel,
  parcelGraphDigest,
  parseParcelGraph,
  validateParcelGraph,
  type ParcelGraph,
  type ParcelIssue,
  type ParcelRunOptions,
} from '../parcel/index';
import {
  COLD_CACHE_LEVEL_ID,
  COLD_CACHE_SCHEMA_VERSION,
  coldCacheGraphDigest,
  type ColdCacheEvaluation,
  type ColdCacheIssue,
} from './legacy-schema';
import {
  EngineLevelError,
  type ColdCacheEngineAdapter,
  type ColdCacheRunOptions,
  type EngineIssueLike,
  type EngineLevelDescriptor,
  type EngineParseResult,
  type ImageAtlasEngineAdapter,
  type ParcelPulseEngineAdapter,
} from './contracts';

/** Signature I101 supplies from `src/images/evaluate.ts`. */
export type ImageEvaluator = (
  input: unknown,
  options: ImageRunOptions,
) => ImageEvaluation;

function coldDescriptor(): EngineLevelDescriptor {
  return {
    id: COLD_CACHE_LEVEL_ID,
    title: DEFAULT_LEVEL.title,
    description: DEFAULT_LEVEL.description,
    defaultSeed: DEFAULT_LEVEL.defaultSeed,
    seed: { min: 0, max: COLD_MAX_SEED },
    modelVersion: COLD_MODEL_VERSION,
    schemaVersion: COLD_CACHE_SCHEMA_VERSION,
    contentVersion: DEFAULT_LEVEL.contentVersion,
    pricingVersion: DEFAULT_LEVEL.pricingVersion,
    availability: 'playable',
  };
}

function coldIssue(issue: {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}): ColdCacheIssue {
  return {
    code: issue.code,
    message: issue.message,
    severity: 'error',
    ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
    ...(issue.edgeId === undefined ? {} : { edgeId: issue.edgeId }),
  };
}

function asColdIssues(issues: readonly EngineIssueLike[]): ColdCacheIssue[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    severity: issue.severity ?? 'error',
    ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
    ...(issue.edgeId === undefined ? {} : { edgeId: issue.edgeId }),
  }));
}

/** Atomic, safe parse: the frozen `parseGraph` throws on untrusted input. */
export function parseColdCacheGraph(
  input: unknown,
): EngineParseResult<GraphDocument> {
  try {
    const graph = parseGraph(input);
    return { ok: true, graph, issues: [] };
  } catch (error) {
    if (error instanceof DomainValidationError) {
      return {
        ok: false,
        graph: null,
        issues: error.issues.map(coldIssue),
      };
    }
    return {
      ok: false,
      graph: null,
      issues: [
        {
          code: 'invalid_graph',
          message: 'The graph could not be parsed.',
          severity: 'error',
        },
      ],
    };
  }
}

export function validateColdCacheGraph(
  graph: GraphDocument,
): readonly ColdCacheIssue[] {
  return validateGraph(graph, { mode: 'run' }).map(coldIssue);
}

function coldMeta(seed: number, graphDigest: string | null) {
  return {
    schemaVersion: COLD_CACHE_SCHEMA_VERSION,
    levelId: COLD_CACHE_LEVEL_ID,
    modelVersion: COLD_MODEL_VERSION,
    contentVersion: DEFAULT_LEVEL.contentVersion,
    pricingVersion: DEFAULT_LEVEL.pricingVersion,
    seed,
    graphDigest,
  } as const;
}

function safeSeed(value: number): number {
  return Number.isInteger(value) && value >= 0 && value <= COLD_MAX_SEED
    ? value
    : 0;
}

function boundedMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : 'The Cold Cache run failed.';
  return message.replace(/\s+/g, ' ').trim().slice(0, 500);
}

/**
 * Finalise one real Cold Cache run. The engine is advanced exactly once to
 * `durationMs + drainMs`, which is chunk-independent in the frozen core, and
 * the untouched `RunResult` is placed in the envelope.
 */
export function evaluateColdCache(
  input: unknown,
  options: ColdCacheRunOptions,
): ColdCacheEvaluation {
  const seed = safeSeed(options.seed);
  const progress = options.onProgress;
  progress?.({
    phase: 'validate',
    horizonYears: null,
    scenario: null,
    completed: 0,
    total: 1,
    message: 'Parsing and validating the graph',
  });

  if (seed !== options.seed) {
    return {
      status: 'incomplete',
      passed: false,
      meta: coldMeta(seed, null),
      issues: [],
      result: null,
      error: {
        code: 'invalid_seed',
        message: `Seed must be an integer in 0..${COLD_MAX_SEED}.`,
      },
    };
  }

  const parsed = parseColdCacheGraph(input);
  if (!parsed.ok) {
    progress?.({
      phase: 'done',
      horizonYears: null,
      scenario: null,
      completed: 1,
      total: 1,
      message: 'Graph validation failed',
    });
    return {
      status: 'invalid',
      passed: false,
      meta: coldMeta(seed, null),
      issues: asColdIssues(parsed.issues),
      result: null,
    };
  }

  const validation = validateColdCacheGraph(parsed.graph);
  const digest = coldCacheGraphDigest(parsed.graph);
  const errors = validation.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    progress?.({
      phase: 'done',
      horizonYears: null,
      scenario: null,
      completed: 1,
      total: 1,
      message: 'Graph validation failed',
    });
    return {
      status: 'invalid',
      passed: false,
      meta: coldMeta(seed, digest),
      issues: [...asColdIssues(parsed.issues), ...validation],
      result: null,
    };
  }

  progress?.({
    phase: 'simulate',
    horizonYears: null,
    scenario: null,
    completed: 0,
    total: 1,
    message: 'Running the deterministic simulation',
  });

  const endMs = DEFAULT_LEVEL.durationMs + DEFAULT_LEVEL.drainMs;
  try {
    const engine = createSimulation(parsed.graph, DEFAULT_LEVEL, seed);
    engine.advance(endMs);
    const result = engine.result();
    progress?.({
      phase: 'done',
      horizonYears: null,
      scenario: null,
      completed: 1,
      total: 1,
      message: 'Evaluation complete',
    });
    return {
      status: 'ok',
      passed: result.passed,
      meta: coldMeta(seed, digest),
      issues: [...asColdIssues(parsed.issues), ...validation],
      result,
    };
  } catch (error) {
    if (error instanceof DomainValidationError) {
      return {
        status: 'invalid',
        passed: false,
        meta: coldMeta(seed, digest),
        issues: error.issues.map(coldIssue),
        result: null,
      };
    }
    const code =
      error instanceof SimulationLimitError ? 'workload_limit' : 'engine_failure';
    return {
      status: 'incomplete',
      passed: false,
      meta: coldMeta(seed, digest),
      issues: [],
      result: null,
      error: { code, message: boundedMessage(error) },
    };
  }
}

export function createColdCacheAdapter(): ColdCacheEngineAdapter {
  return {
    levelId: COLD_CACHE_LEVEL_ID,
    modelVersion: COLD_MODEL_VERSION,
    schemaVersion: COLD_CACHE_SCHEMA_VERSION,
    resultKind: 'level-result',
    describe: coldDescriptor,
    parseGraph: parseColdCacheGraph,
    validateGraph: validateColdCacheGraph,
    evaluate: evaluateColdCache,
    graphDigest: (graph) => coldCacheGraphDigest(graph),
  };
}

function parcelDescriptor(): EngineLevelDescriptor {
  return {
    id: PARCEL_LEVEL_ID,
    title: PARCEL_LEVEL.title,
    description: PARCEL_LEVEL.description,
    defaultSeed: PARCEL_LEVEL.defaultSeed,
    seed: { min: 0, max: PARCEL_MAX_SEED },
    modelVersion: PARCEL_MODEL_VERSION,
    schemaVersion: PARCEL_SCHEMA_VERSION,
    contentVersion: PARCEL_CONTENT_VERSION,
    pricingVersion: PARCEL_PRICING_VERSION,
    availability: 'playable',
    horizons: [...PARCEL_REQUIRED_HORIZONS],
  };
}

function parcelParse(input: unknown): EngineParseResult<ParcelGraph> {
  const parsed = parseParcelGraph(input);
  return parsed.ok
    ? { ok: true, graph: parsed.graph, issues: parsed.issues }
    : { ok: false, graph: null, issues: parsed.issues };
}

function parcelValidate(graph: ParcelGraph): readonly ParcelIssue[] {
  return validateParcelGraph(graph, { mode: 'run' });
}

export function createParcelPulseAdapter(): ParcelPulseEngineAdapter {
  return {
    levelId: PARCEL_LEVEL_ID,
    modelVersion: PARCEL_MODEL_VERSION,
    schemaVersion: PARCEL_SCHEMA_VERSION,
    resultKind: 'level-result',
    describe: parcelDescriptor,
    parseGraph: parcelParse,
    validateGraph: parcelValidate,
    evaluate: (input, options: ParcelRunOptions) =>
      evaluateParcel(input, options),
    graphDigest: (graph) => parcelGraphDigest(graph),
  };
}

function imageDescriptor(available: boolean): EngineLevelDescriptor {
  return {
    id: IMAGE_LEVEL_ID,
    title: IMAGE_LEVEL.title,
    description: IMAGE_LEVEL.description,
    defaultSeed: IMAGE_LEVEL.defaultSeed,
    seed: { min: 0, max: IMAGE_MAX_SEED },
    modelVersion: IMAGE_MODEL_VERSION,
    schemaVersion: IMAGE_SCHEMA_VERSION,
    contentVersion: IMAGE_CONTENT_VERSION,
    pricingVersion: IMAGE_PRICING_VERSION,
    availability: available ? 'playable' : 'contract-only',
    requiredScenarios: [...IMAGE_REQUIRED_SCENARIOS],
  };
}

function imageParse(input: unknown): EngineParseResult<ImageGraph> {
  const parsed = parseImageGraph(input);
  return parsed.ok
    ? { ok: true, graph: parsed.graph, issues: parsed.issues }
    : { ok: false, graph: null, issues: parsed.issues };
}

function imageValidate(graph: ImageGraph): readonly ImageIssue[] {
  return validateImageGraph(graph, { mode: 'run' });
}

/**
 * I101's evaluator is injected. A missing evaluator yields a contract-only
 * level; `evaluate` throws a safe typed error instead of fabricating a result.
 */
export function createImageAtlasAdapter(
  evaluator: ImageEvaluator | null,
): ImageAtlasEngineAdapter {
  return {
    levelId: IMAGE_LEVEL_ID,
    modelVersion: IMAGE_MODEL_VERSION,
    schemaVersion: IMAGE_SCHEMA_VERSION,
    resultKind: 'level-result',
    describe: () => imageDescriptor(evaluator !== null),
    parseGraph: imageParse,
    validateGraph: imageValidate,
    evaluate: (input, options: ImageRunOptions) => {
      if (evaluator === null) {
        throw new EngineLevelError(
          'evaluator_unavailable',
          'The Image Atlas evaluator is not available in this build.',
        );
      }
      return evaluator(input, options);
    },
    graphDigest: (graph) => imageGraphDigest(graph),
  };
}

/** Scenario names accepted by the exploratory Image CLI option. */
export const IMAGE_SCENARIO_NAMES: readonly ImageScenarioName[] =
  IMAGE_REQUIRED_SCENARIOS;
