/**
 * Common, versioned engine-adapter boundary for every registered level.
 *
 * This file contains types and a tiny registry helper only. It deliberately
 * does not import the Image Atlas evaluator (owned by I101) or the Live
 * Audience evaluator (owned by A101), and does not replace the existing typed
 * Cold Cache / Parcel Pulse / Live Scoreboard engines. Each level keeps its own
 * versioned domain model; an adapter exposes that model through one
 * discovery/validate/evaluate shape for the browser worker, CLI and API.
 */

import type { GraphDocument } from '../domain/graph';
import type { LevelDefinition } from '../domain/level';
import type {
  ParcelEvaluation,
  ParcelGraph,
  ParcelRunOptions,
} from '../parcel/contracts';
import type {
  ImageEvaluation,
  ImageGraph,
  ImageRunOptions,
} from '../images/contracts';
import type {
  ScoreboardEvaluation,
  ScoreboardGraph,
  ScoreboardRunOptions,
} from '../scoreboard/index';
import type {
  AudienceEvaluation,
  AudienceGraph,
  AudienceRunOptions,
} from '../audience/index';
import type { ColdCacheEvaluation } from './legacy-schema';
import type {
  CartEvaluation,
  CartGraph,
} from '../cart/index';

export const ENGINE_LEVEL_IDS = [
  'cold-cache',
  'parcel-pulse',
  'image-atlas',
  'live-scoreboard',
  'live-audience',
  'global-cart',
] as const;

export type EngineLevelId = (typeof ENGINE_LEVEL_IDS)[number];

/** A level may be playable in this release or contract-only before its evaluator lands. */
export type EngineLevelAvailability = 'playable' | 'contract-only';

export interface EngineLevelDescriptor {
  readonly id: EngineLevelId;
  readonly title: string;
  readonly description: string;
  readonly defaultSeed: number;
  /** Accepted seed range for this level. */
  readonly seed: { readonly min: number; readonly max: number };
  /** The level/model version this descriptor belongs to. */
  readonly modelVersion: string;
  readonly schemaVersion: number;
  readonly contentVersion: string;
  readonly pricingVersion: string;
  /**
   * Challenge-profile version for levels whose qualification profile is part of
   * the result identity. The Live Audience result binds it; legacy levels omit
   * it.
   */
  readonly profileVersion?: string;
  readonly availability: EngineLevelAvailability;
  /** Mandatory horizons for levels that use them (Parcel Pulse). */
  readonly horizons?: readonly number[];
  /** Required qualification cases for levels that use scenarios. */
  readonly requiredScenarios?: readonly string[];
  /**
   * Frozen mandatory qualification cases for levels whose result must cover a
   * fixed case set (Global Cart). Discovery only; never caller-supplied.
   */
  readonly requiredCases?: readonly string[];
}

/** Common progress event emitted by every level adapter. */
export interface EngineProgress {
  readonly phase:
    | 'validate'
    | 'prepare'
    | 'capacity'
    | 'workload'
    | 'run'
    | 'simulate'
    | 'drain'
    | 'done';
  /** Parcel horizon, or null for levels without horizons. */
  readonly horizonYears: 1 | 5 | null;
  /** Image scenario, or null. */
  readonly scenario: string | null;
  readonly completed: number;
  readonly total: number;
  readonly message: string;
}

/**
 * Minimal common issue shape. Each typed level issue is structurally
 * compatible; consumers that need full fidelity keep using the concrete type.
 */
export interface EngineIssueLike {
  readonly code: string;
  readonly message: string;
  readonly severity?: 'error' | 'warning' | 'info';
  readonly nodeId?: string;
  readonly edgeId?: string;
  /** Optional machine-readable location/metric detail from richer cores. */
  readonly path?: string;
  readonly operation?: string;
  readonly metric?: string;
  readonly value?: number;
  readonly limit?: number;
  readonly count?: number;
}

export type EngineParseResult<TGraph> =
  | {
      readonly ok: true;
      readonly graph: TGraph;
      readonly issues: readonly EngineIssueLike[];
    }
  | {
      readonly ok: false;
      readonly graph: null;
      readonly issues: readonly EngineIssueLike[];
    };

/**
 * One immutable adapter per level/model version.
 *
 * Contract rules:
 * - `levelId`, `modelVersion` and `schemaVersion` are literal metadata, not
 *   caller overrides.
 * - `parseGraph` is safe and atomic for untrusted documents. Legacy adapters
 *   may map a throwing parser into the discriminated result.
 * - `validateGraph` performs semantic checks only; it never starts a run.
 * - `evaluate` re-parses the untrusted input and never trusts a client result.
 * - `graphDigest` ignores visual fields and never includes the seed.
 */
export interface VersionedEngineAdapter<TGraph, TOptions, TResult> {
  readonly levelId: EngineLevelId;
  readonly modelVersion: string;
  readonly schemaVersion: number;
  readonly resultKind: 'level-result' | 'simulation-handle';
  describe(): EngineLevelDescriptor;
  parseGraph(input: unknown): EngineParseResult<TGraph>;
  validateGraph(graph: TGraph): readonly EngineIssueLike[];
  evaluate(input: unknown, options: TOptions): TResult;
  graphDigest(graph: TGraph): string | null;
}

/**
 * Cold Cache options. The original `createSimulation` accepts any
 * `LevelDefinition`, but the adapter always binds `DEFAULT_LEVEL`; the optional
 * `level` field remains only as a shape-compatibility placeholder and has no
 * effect. External callers cannot override the workload, prices or SLOs.
 */
export interface ColdCacheRunOptions {
  readonly seed: number;
  readonly level?: LevelDefinition;
  readonly onProgress?: (progress: EngineProgress) => void;
}

/**
 * Cold Cache finalises a real engine run into the common evaluation envelope.
 * The envelope's `result` field is the untouched `RunResult` from the frozen
 * engine, so existing result bodies remain byte-for-byte equivalent.
 */
export type ColdCacheEngineAdapter = VersionedEngineAdapter<
  GraphDocument,
  ColdCacheRunOptions,
  ColdCacheEvaluation
> & {
  readonly levelId: 'cold-cache';
  readonly resultKind: 'level-result';
};

/** Parcel Pulse keeps its existing frozen evaluator and result contract. */
export type ParcelPulseEngineAdapter = VersionedEngineAdapter<
  ParcelGraph,
  ParcelRunOptions,
  ParcelEvaluation
> & {
  readonly levelId: 'parcel-pulse';
  readonly resultKind: 'level-result';
};

/**
 * Image Atlas adapter. `evaluate` is implemented by I101; this type only
 * declares the boundary so UI/CLI/backend work can start without importing an
 * absent evaluator.
 */
export type ImageAtlasEngineAdapter = VersionedEngineAdapter<
  ImageGraph,
  ImageRunOptions,
  ImageEvaluation
> & {
  readonly levelId: 'image-atlas';
  readonly resultKind: 'level-result';
};

/**
 * Live Scoreboard adapter. The core is a real deterministic evaluator; the
 * adapter binds its versioned graph, catalog and result contract and offers no
 * workload, price, SLO or gate override.
 */
export type ScoreboardEngineAdapter = VersionedEngineAdapter<
  ScoreboardGraph,
  ScoreboardRunOptions,
  ScoreboardEvaluation
> & {
  readonly levelId: 'live-scoreboard';
  readonly resultKind: 'level-result';
};

/**
 * Live Audience adapter. The core is a real deterministic qualification
 * evaluator; the adapter binds its versioned graph, catalog, challenge profile
 * and result contract and offers no workload, price, SLO or case override.
 */
export type AudienceEngineAdapter = VersionedEngineAdapter<
  AudienceGraph,
  AudienceRunOptions,
  AudienceEvaluation
> & {
  readonly levelId: 'live-audience';
  readonly resultKind: 'level-result';
};

/**
 * Global Cart options. The adapter binds the frozen evaluator's seed and
 * progress only; workload, cases, prices and gates stay inside the core.
 */
export interface CartRunOptions {
  readonly seed: number;
  readonly onProgress?: (progress: EngineProgress) => void;
}

/**
 * Global Cart adapter. The real deterministic evaluator from
 * `src/cart/index.ts` is always bound; there is no contract-only path and no
 * override of the six mandatory cases.
 */
export type CartEngineAdapter = VersionedEngineAdapter<
  CartGraph,
  CartRunOptions,
  CartEvaluation
> & {
  readonly levelId: 'global-cart';
  readonly resultKind: 'level-result';
};

/**
 * Frozen requirements derived from the level (not from the submitted result).
 * The backend worker binding uses them to reject omitted mandatory cases.
 */
export interface EngineRunRequirements {
  readonly requiredCases: readonly string[];
}

/**
 * Provisioning facts derived from the submitted graph, not from the result
 * envelope. The backend binds every required case and physical slot to this
 * expectation so a worker cannot omit a mandatory case or retarget a failure.
 */
export interface EngineExpectedProvisioning {
  readonly appInstances: number;
  readonly sqlSize: string;
  readonly readPlan: string;
  readonly cacheTtlSeconds: number | null;
  readonly workerInstances: number;
  readonly loadBalancer: boolean;
  readonly nodeKinds: readonly string[];
}

export interface EngineExpectedCase {
  readonly id: string;
  readonly kind: 'normal' | 'peak' | 'app-instance-failure';
  readonly targetInstance: number | null;
}

/**
 * Exact submitted component identity. The semantic digest intentionally ignores
 * node ids and labels, but per-case metrics reference the actual canvas ids, so
 * the backend binds the full id/kind/instance multiset from the graph.
 */
export interface EngineExpectedNode {
  readonly id: string;
  readonly kind: string;
  readonly instances: number;
}

/** Exact submitted link identity with the authoritative inferred role. */
export interface EngineExpectedEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly role: string;
}

export interface EngineRunExpectation {
  readonly provisioning: EngineExpectedProvisioning;
  readonly cases: readonly EngineExpectedCase[];
  /** Optional for compatibility; Live Audience always supplies both sets. */
  readonly nodes?: readonly EngineExpectedNode[];
  readonly edges?: readonly EngineExpectedEdge[];
}

export type AnyEngineAdapter = VersionedEngineAdapter<
  unknown,
  unknown,
  unknown
>;

export interface EngineAdapterRegistry {
  list(): readonly EngineLevelDescriptor[];
  /**
   * Dispatch by level and (when provided) exact model version. An omitted
   * model version returns the first adapter for that level; callers order
   * preferred/newest adapters first.
   */
  resolve(levelId: string, modelVersion?: string): AnyEngineAdapter | null;
}

export type EngineLevelErrorCode =
  | 'unknown_level'
  | 'unsupported_model_version'
  | 'invalid_seed'
  | 'unsupported_option'
  | 'evaluator_unavailable';

/** Safe, typed failure for registry callers (CLI and backend map the code). */
export class EngineLevelError extends Error {
  readonly code: EngineLevelErrorCode;

  constructor(code: EngineLevelErrorCode, message: string) {
    super(message);
    this.name = 'EngineLevelError';
    this.code = code;
  }
}

/** Create a deterministic, priority-ordered registry (preferred/newest first). */
export function createEngineAdapterRegistry(
  adapters: readonly AnyEngineAdapter[],
): EngineAdapterRegistry {
  const ordered = [...adapters];
  return {
    list() {
      return ordered.map((adapter) => adapter.describe());
    },
    resolve(levelId, modelVersion) {
      if (modelVersion !== undefined) {
        return (
          ordered.find(
            (adapter) =>
              adapter.levelId === levelId &&
              adapter.modelVersion === modelVersion,
          ) ?? null
        );
      }
      return (
        ordered.find((adapter) => adapter.levelId === levelId) ?? null
      );
    },
  };
}
