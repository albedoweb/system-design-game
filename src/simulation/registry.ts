/**
 * Common authoritative level registry.
 *
 * Discovery, schemas, catalogs and evaluation all come from the same frozen
 * cores (Cold Cache, Parcel Pulse, Image Atlas and Live Scoreboard). The
 * registry is the only entry point used by the CLI and backend: callers cannot
 * supply a level definition, catalog, price, SLO or arbitrary workload
 * override.
 */

import { createInitialGraph, type GraphDocument } from '../domain/graph';
import type { LevelDefinition } from '../domain/level';
import * as imageCoreModule from '../images/index';
import {
  AUDIENCE_LEVEL_ID,
  AUDIENCE_MAX_SEED,
  cloneAudienceLevel,
  createAudienceStarterGraph,
  describeAudienceLevel,
  audienceEvaluationJsonSchema,
  audienceGraphJsonSchema,
  type AudienceEvaluation,
  type AudienceRunOptions,
} from '../audience/index';
import {
  IMAGE_CATALOG,
  IMAGE_COMPONENT_LIMITS,
  IMAGE_LEVEL,
  IMAGE_LEVEL_ID,
  IMAGE_MAX_SEED,
  IMAGE_REQUIRED_SCENARIOS,
  cloneImageCatalog,
  createImageGraph,
  imageEvaluationJsonSchema,
  imageGraphJsonSchema,
  describeImageLevel,
  type ImageEvaluation,
  type ImageGraph,
  type ImageRunOptions,
  type ImageScenarioName,
} from '../images/index';
import {
  PARCEL_LEVEL_ID,
  PARCEL_MAX_SEED,
  createParcelGraph,
  describeParcelLevel,
  parcelCatalogPayload,
  parcelEvaluationJsonSchema,
  parcelGraphJsonSchema,
  parcelLevelPayload,
  type ParcelEvaluation,
  type ParcelGraph,
  type ParcelRunOptions,
} from '../parcel/index';
import {
  SCOREBOARD_LEVEL_ID,
  SCOREBOARD_MAX_SEED,
  cloneScoreboardLevel,
  createScoreboardStarterGraph,
  describeScoreboardLevel,
  scoreboardEvaluationJsonSchema,
  scoreboardGraphJsonSchema,
  type ScoreboardEvaluation,
  type ScoreboardRunOptions,
} from '../scoreboard/index';
import {
  CART_LEVEL_ID,
  CART_MAX_SEED,
  type CartEvaluation,
} from '../cart/index';
import {
  cartComponents,
  cartGraphSchema,
  cartLevelDefinition,
  cartResultSchema,
  cartRunRequirements,
  createCartAdapter,
  createCartStarter,
} from './cart-adapter';
import {
  EngineLevelError,
  type AnyEngineAdapter,
  type AudienceEngineAdapter,
  type CartEngineAdapter,
  type ColdCacheEngineAdapter,
  type ColdCacheRunOptions,
  type EngineLevelDescriptor,
  type EngineLevelId,
  type EngineIssueLike,
  type EngineProgress,
  type EngineRunExpectation,
  type EngineRunRequirements,
  type ImageAtlasEngineAdapter,
  type ParcelPulseEngineAdapter,
  type ScoreboardEngineAdapter,
} from './contracts';
import {
  audienceComponents,
  audienceRunExpectation,
  createAudienceAdapter,
  type AudienceEvaluator,
} from './audience-adapter';
import {
  createColdCacheAdapter,
  createImageAtlasAdapter,
  createParcelPulseAdapter,
  type ImageEvaluator,
} from './legacy-adapters';
import {
  createScoreboardAdapter,
  scoreboardComponents,
} from './scoreboard-adapter';
import {
  COLD_CACHE_LEVEL_ID,
  coldCacheCatalogPayload,
  coldCacheGraphJsonSchema,
  coldCacheLevelPayload,
  coldCacheResultJsonSchema,
  describeColdCacheLevel,
  type ColdCacheEvaluation,
} from './legacy-schema';

export type EngineEvaluationResult =
  | { readonly levelId: 'cold-cache'; readonly result: ColdCacheEvaluation }
  | { readonly levelId: 'parcel-pulse'; readonly result: ParcelEvaluation }
  | { readonly levelId: 'image-atlas'; readonly result: ImageEvaluation }
  | {
      readonly levelId: 'live-scoreboard';
      readonly result: ScoreboardEvaluation;
    }
  | {
      readonly levelId: 'live-audience';
      readonly result: AudienceEvaluation;
    }
  | {
      readonly levelId: 'global-cart';
      readonly result: CartEvaluation;
    };

export interface EngineEvaluationRequest {
  readonly levelId: string;
  /** Exact registered model version, when a caller wants to pin one. */
  readonly modelVersion?: string;
  readonly graph: unknown;
  readonly seed: number;
  /** Parcel only: an investigation horizon. Qualification stays the default. */
  readonly horizonYears?: 1 | 5;
  /** Image only: exploratory scenario subset. Never a global pass. */
  readonly scenarios?: readonly ImageScenarioName[];
  readonly onProgress?: (progress: EngineProgress) => void;
}

export interface EngineValidationResult {
  readonly levelId: string;
  readonly ok: boolean;
  readonly graphDigest: string | null;
  readonly issues: readonly EngineIssueLike[];
}

export interface EngineLevelEntry {
  readonly descriptor: EngineLevelDescriptor;
  readonly adapter: AnyEngineAdapter;
  readonly describe: () => unknown;
  readonly components: () => unknown;
  readonly levelDefinition: () => unknown;
  readonly graphSchema: () => Record<string, unknown>;
  readonly resultSchema: () => Record<string, unknown>;
  readonly defaultGraph: () => unknown;
  /**
   * Optional exact qualification expectation derived from the submitted graph.
   * The backend worker binding uses it to prove the result covers the required
   * cases and physical slots of this input; it never reads them from a result.
   */
  readonly expectation?: (graph: unknown) => EngineRunExpectation | null;
  /**
   * Optional frozen requirements (mandatory cases) that the backend binds to
   * the submitted graph. Never read from a result.
   */
  readonly requirements?: (graph: unknown) => EngineRunRequirements | null;
}

export interface EngineRegistry {
  levels(): readonly EngineLevelDescriptor[];
  resolve(
    levelId: string,
    modelVersion?: string,
  ): EngineLevelEntry | null;
  describe(levelId: string, modelVersion?: string): unknown;
  components(levelId: string, modelVersion?: string): unknown;
  levelDefinition(levelId: string, modelVersion?: string): unknown;
  graphSchema(levelId: string, modelVersion?: string): Record<string, unknown>;
  resultSchema(levelId: string, modelVersion?: string): Record<string, unknown>;
  example(levelId: string, modelVersion?: string): unknown;
  validate(levelId: string, graph: unknown, modelVersion?: string): EngineValidationResult;
  semanticDigest(
    levelId: string,
    graph: unknown,
    modelVersion?: string,
  ): string | null;
  evaluate(request: EngineEvaluationRequest): EngineEvaluationResult;
}

export interface EngineRegistryOptions {
  /**
   * I101 evaluator, normally `evaluateImages` from `src/images/evaluate.ts`.
   * When omitted, the registry picks up `evaluateImages` from the frozen
   * `src/images/index.ts` surface if it is present. When absent, Image Atlas
   * remains discoverable/validatable but `evaluate` reports
   * `evaluator_unavailable`; no result is fabricated.
   */
  readonly imageEvaluator?: ImageEvaluator | null;
  /**
   * Optional test/future-version override. Defaults to the real
   * `evaluateAudience` core imported by the adapter; there is no contract-only
   * fallback for the released level.
   */
  readonly audienceEvaluator?: AudienceEvaluator;
}

/**
 * Resolve the I101 evaluator from the public Image module without a static
 * import of a file that does not exist yet on this stacked branch. This is a
 * presence check, not a fallback implementation: if `evaluateImages` is not
 * exported, the level stays contract-only.
 */
export function resolveDefaultImageEvaluator(): ImageEvaluator | null {
  const candidate = Reflect.get(
    imageCoreModule as unknown as object,
    'evaluateImages',
  ) as unknown;
  return typeof candidate === 'function'
    ? (candidate as ImageEvaluator)
    : null;
}

/**
 * Public per-operation work model exported by I101 (`IMAGE_WORK_MODEL`), when
 * present. The registry never invents coefficients; it only forwards the
 * frozen core's public object to API/CLI discovery.
 */
export function resolveImageWorkModel(): unknown {
  return Reflect.get(imageCoreModule as unknown as object, 'IMAGE_WORK_MODEL');
}

function requireEntry(
  entries: readonly EngineLevelEntry[],
  levelId: string,
  modelVersion?: string,
): EngineLevelEntry {
  const entry = entries.find(
    (candidate) =>
      candidate.descriptor.id === levelId &&
      (modelVersion === undefined ||
        candidate.descriptor.modelVersion === modelVersion),
  );
  if (entry === undefined) {
    if (modelVersion !== undefined) {
      const sameLevel = entries.some(
        (candidate) => candidate.descriptor.id === levelId,
      );
      if (sameLevel) {
        throw new EngineLevelError(
          'unsupported_model_version',
          `Level "${levelId}" does not support model version "${modelVersion}".`,
        );
      }
    }
    throw new EngineLevelError(
      'unknown_level',
      `Unknown level "${levelId}".`,
    );
  }
  return entry;
}

function requireSeed(entry: EngineLevelEntry, seed: number): void {
  const { min, max } = entry.descriptor.seed;
  if (!Number.isInteger(seed) || seed < min || seed > max) {
    throw new EngineLevelError(
      'invalid_seed',
      `Seed must be an integer in ${min}..${max}.`,
    );
  }
}

function coldEntry(): EngineLevelEntry {
  const adapter = createColdCacheAdapter();
  const descriptor = adapter.describe();
  return {
    descriptor,
    adapter,
    describe: describeColdCacheLevel,
    components: coldCacheCatalogPayload,
    levelDefinition: coldCacheLevelPayload,
    graphSchema: coldCacheGraphJsonSchema,
    resultSchema: coldCacheResultJsonSchema,
    defaultGraph: createInitialGraph,
  };
}

function parcelEntry(): EngineLevelEntry {
  const adapter = createParcelPulseAdapter();
  return {
    descriptor: adapter.describe(),
    adapter,
    describe: describeParcelLevel,
    components: parcelCatalogPayload,
    levelDefinition: parcelLevelPayload,
    graphSchema: parcelGraphJsonSchema,
    resultSchema: parcelEvaluationJsonSchema,
    defaultGraph: createParcelGraph,
  };
}

function imageEntry(evaluator: ImageEvaluator | null): EngineLevelEntry {
  const adapter = createImageAtlasAdapter(evaluator);
  return {
    descriptor: adapter.describe(),
    adapter,
    describe: describeImageLevel,
    components: () => {
      const workModel = resolveImageWorkModel();
      return {
        catalog: cloneImageCatalog(),
        componentLimits: IMAGE_COMPONENT_LIMITS,
        catalogVersion: IMAGE_CATALOG.schemaVersion,
        operations: [...IMAGE_COMPONENT_LIMITS.operations],
        businessOperations: [...IMAGE_COMPONENT_LIMITS.businessOperations],
        scenarios: [...IMAGE_REQUIRED_SCENARIOS],
        nodeKinds: [...IMAGE_COMPONENT_LIMITS.nodeKinds],
        regions: [...IMAGE_COMPONENT_LIMITS.regions],
        ...(workModel === undefined ? {} : { workModel }),
      };
    },
    levelDefinition: () => JSON.parse(JSON.stringify(IMAGE_LEVEL)) as unknown,
    graphSchema: imageGraphJsonSchema,
    resultSchema: imageEvaluationJsonSchema,
    defaultGraph: createImageGraph,
  };
}

function scoreboardEntry(): EngineLevelEntry {
  const adapter = createScoreboardAdapter();
  return {
    descriptor: adapter.describe(),
    adapter,
    describe: describeScoreboardLevel,
    components: scoreboardComponents,
    levelDefinition: cloneScoreboardLevel,
    graphSchema: scoreboardGraphJsonSchema,
    resultSchema: scoreboardEvaluationJsonSchema,
    defaultGraph: createScoreboardStarterGraph,
  };
}

function audienceEntry(evaluator?: AudienceEvaluator): EngineLevelEntry {
  const adapter = createAudienceAdapter(evaluator);
  return {
    descriptor: adapter.describe(),
    adapter,
    describe: describeAudienceLevel,
    components: audienceComponents,
    levelDefinition: cloneAudienceLevel,
    graphSchema: audienceGraphJsonSchema,
    resultSchema: audienceEvaluationJsonSchema,
    defaultGraph: createAudienceStarterGraph,
    expectation: audienceRunExpectation,
  };
}

function cartEntry(): EngineLevelEntry {
  const adapter = createCartAdapter();
  return {
    descriptor: adapter.describe(),
    adapter,
    describe: cartLevelDefinition,
    components: cartComponents,
    levelDefinition: cartLevelDefinition,
    graphSchema: cartGraphSchema,
    resultSchema: cartResultSchema,
    defaultGraph: createCartStarter,
    requirements: cartRunRequirements,
  };
}

function validateEntry(
  entry: EngineLevelEntry,
  graph: unknown,
): EngineValidationResult {
  const parsed = entry.adapter.parseGraph(graph);
  if (!parsed.ok) {
    return {
      levelId: entry.descriptor.id,
      ok: false,
      graphDigest: null,
      issues: [...parsed.issues],
    };
  }
  const semantic = entry.adapter.validateGraph(parsed.graph);
  const issues = [...parsed.issues, ...semantic];
  const digest = entry.adapter.graphDigest(parsed.graph);
  return {
    levelId: entry.descriptor.id,
    ok: !issues.some((issue) => issue.severity === 'error'),
    graphDigest: digest,
    issues,
  };
}

function digestEntry(
  entry: EngineLevelEntry,
  graph: unknown,
): string | null {
  try {
    const parsed = entry.adapter.parseGraph(graph);
    return parsed.ok ? entry.adapter.graphDigest(parsed.graph) : null;
  } catch {
    return null;
  }
}

/**
 * Create the authoritative registry. Adapters are ordered deterministically
 * (Cold Cache, Parcel Pulse, Image Atlas, Live Scoreboard, Live Audience) and
 * each exposes
 * its concrete result kind.
 */
export function createEngineRegistry(
  options: EngineRegistryOptions = {},
): EngineRegistry {
  const imageEvaluator =
    options.imageEvaluator === undefined
      ? resolveDefaultImageEvaluator()
      : options.imageEvaluator;
  const entries: readonly EngineLevelEntry[] = [
    coldEntry(),
    parcelEntry(),
    imageEntry(imageEvaluator),
    scoreboardEntry(),
    audienceEntry(options.audienceEvaluator),
    cartEntry(),
  ];

  const find = (levelId: string, modelVersion?: string): EngineLevelEntry =>
    requireEntry(entries, levelId, modelVersion);

  return {
    levels() {
      return entries.map((entry) => entry.descriptor);
    },
    resolve(levelId, modelVersion) {
      return (
        entries.find(
          (entry) =>
            entry.descriptor.id === levelId &&
            (modelVersion === undefined ||
              entry.descriptor.modelVersion === modelVersion),
        ) ?? null
      );
    },
    describe(levelId, modelVersion) {
      return find(levelId, modelVersion).describe();
    },
    components(levelId, modelVersion) {
      return find(levelId, modelVersion).components();
    },
    levelDefinition(levelId, modelVersion) {
      return find(levelId, modelVersion).levelDefinition();
    },
    graphSchema(levelId, modelVersion) {
      return find(levelId, modelVersion).graphSchema();
    },
    resultSchema(levelId, modelVersion) {
      return find(levelId, modelVersion).resultSchema();
    },
    example(levelId, modelVersion) {
      return find(levelId, modelVersion).defaultGraph();
    },
    validate(levelId, graph, modelVersion) {
      return validateEntry(find(levelId, modelVersion), graph);
    },
    semanticDigest(levelId, graph, modelVersion) {
      return digestEntry(find(levelId, modelVersion), graph);
    },
    evaluate(request) {
      const entry = find(request.levelId, request.modelVersion);
      requireSeed(entry, request.seed);

      if (request.horizonYears !== undefined && entry.descriptor.id !== PARCEL_LEVEL_ID) {
        throw new EngineLevelError(
          'unsupported_option',
          '--horizon is supported only for parcel-pulse.',
        );
      }
      if (request.scenarios !== undefined && entry.descriptor.id !== IMAGE_LEVEL_ID) {
        throw new EngineLevelError(
          'unsupported_option',
          '--scenario is supported only for image-atlas.',
        );
      }

      switch (entry.descriptor.id) {
        case COLD_CACHE_LEVEL_ID: {
          const adapter = entry.adapter as ColdCacheEngineAdapter;
          const options: ColdCacheRunOptions = {
            seed: request.seed,
            ...(request.onProgress === undefined
              ? {}
              : { onProgress: request.onProgress }),
          };
          return { levelId: 'cold-cache', result: adapter.evaluate(request.graph, options) };
        }
        case PARCEL_LEVEL_ID: {
          const adapter = entry.adapter as ParcelPulseEngineAdapter;
          const options: ParcelRunOptions = {
            seed: request.seed,
            ...(request.horizonYears === undefined
              ? {}
              : { horizons: [request.horizonYears] }),
            ...(request.onProgress === undefined
              ? {}
              : {
                  onProgress: (progress) =>
                    request.onProgress?.({
                      phase: progress.phase,
                      horizonYears: progress.horizonYears,
                      scenario: null,
                      completed: progress.completed,
                      total: progress.total,
                      message: progress.message,
                    }),
                }),
          };
          return { levelId: 'parcel-pulse', result: adapter.evaluate(request.graph, options) };
        }
        case IMAGE_LEVEL_ID: {
          const adapter = entry.adapter as ImageAtlasEngineAdapter;
          const options: ImageRunOptions = {
            seed: request.seed,
            ...(request.scenarios === undefined
              ? {}
              : { scenarios: request.scenarios }),
            ...(request.onProgress === undefined
              ? {}
              : {
                  onProgress: (progress) =>
                    request.onProgress?.({
                      phase: progress.phase,
                      horizonYears: null,
                      scenario: progress.scenario,
                      completed: progress.completed,
                      total: progress.total,
                      message: progress.message,
                    }),
                }),
          };
          return { levelId: 'image-atlas', result: adapter.evaluate(request.graph, options) };
        }
        case SCOREBOARD_LEVEL_ID: {
          const adapter = entry.adapter as ScoreboardEngineAdapter;
          const options: ScoreboardRunOptions = {
            seed: request.seed,
            ...(request.onProgress === undefined
              ? {}
              : {
                  onProgress: (progress) =>
                    request.onProgress?.({
                      phase: progress.phase,
                      horizonYears: null,
                      scenario: null,
                      completed: progress.completedRequests,
                      total: progress.totalRequests,
                      message: progress.message,
                    }),
                }),
          };
          return {
            levelId: 'live-scoreboard',
            result: adapter.evaluate(request.graph, options),
          };
        }
        case AUDIENCE_LEVEL_ID: {
          const adapter = entry.adapter as AudienceEngineAdapter;
          const options: AudienceRunOptions = {
            seed: request.seed,
            ...(request.onProgress === undefined
              ? {}
              : {
                  onProgress: (progress) =>
                    request.onProgress?.({
                      phase: progress.phase,
                      horizonYears: null,
                      scenario: null,
                      completed: progress.completedRequests,
                      total: progress.totalRequests,
                      message: progress.message,
                    }),
                }),
          };
          return {
            levelId: 'live-audience',
            result: adapter.evaluate(request.graph, options),
          };
        }
        case CART_LEVEL_ID: {
          const adapter = entry.adapter as CartEngineAdapter;
          const options = {
            seed: request.seed,
            ...(request.onProgress === undefined
              ? {}
              : { onProgress: request.onProgress }),
          };
          return {
            levelId: 'global-cart',
            result: adapter.evaluate(request.graph, options),
          };
        }
        default: {
          throw new EngineLevelError(
            'unknown_level',
            `Unknown level "${entry.descriptor.id}".`,
          );
        }
      }
    },
  };
}

/** Default level ID for CLI/API compatibility. */
export const DEFAULT_ENGINE_LEVEL_ID: EngineLevelId = PARCEL_LEVEL_ID;

/** Seed range exported for CLI parsing before a level is resolved. */
export const ENGINE_SEED_MAX = Math.max(
  PARCEL_MAX_SEED,
  IMAGE_MAX_SEED,
  SCOREBOARD_MAX_SEED,
  AUDIENCE_MAX_SEED,
  CART_MAX_SEED,
  0xffff_ffff,
);

export type { ImageGraph, ParcelGraph, GraphDocument, LevelDefinition };
