/**
 * Frozen backend contract (P205).
 *
 * The HTTP layer and the bounded job queue depend only on the `Engine`
 * interface below. P206 supplies the real Worker-backed adapter in
 * `src/engine/**` and boots it from `src/main.ts`; no engine or UI module is
 * imported here. Discovery payloads are trusted engine data, but they are
 * cached per app rather than recomputed for every GET.
 */

import type { FastifyServerOptions } from 'fastify';

export const API_VERSION = 'v1' as const;
export const DEFAULT_SEED = 101 as const;
export const MIN_SEED = 0 as const;
export const MAX_SEED = 2_147_483_647 as const;

/** A level descriptor returned by `Engine.levels()`. */
export interface LevelSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly defaultSeed: number;
  readonly horizons: readonly number[];
}

/**
 * Submission handed to `Engine.evaluate`. `graph` is untrusted request data
 * that already passed the HTTP shape, size and depth checks.
 */
export interface EvaluationSubmission {
  readonly levelId: string;
  readonly graph: unknown;
  readonly seed: number;
}

/**
 * Injected simulation engine.
 *
 * Contract rules for implementations:
 * - `levels()` returns the authoritative level list; discovery routes never
 *   hardcode a catalog.
 * - `describe`, `components` and `schema` return JSON-serialisable metadata
 *   for a level previously returned by `levels()`.
 * - `evaluate` resolves with the evaluation payload for any completed run,
 *   including `{ passed: false }` and structured `{ status: 'invalid' }`
 *   results. It throws `EngineError` for infrastructure or limit failures.
 * - `evaluate` must observe `signal` and reject once the signal is aborted.
 *   The queue never starts more than `maxConcurrent` evaluate calls and keeps
 *   a cancelled-but-unsettled call in its concurrency slot.
 * - Implementations must not mutate the submission or its graph.
 */
export interface Engine {
  levels(): Promise<readonly LevelSummary[]>;
  describe(levelId: string): Promise<unknown>;
  components(levelId: string): Promise<unknown>;
  schema(levelId: string): Promise<unknown>;
  evaluate(submission: EvaluationSubmission, signal: AbortSignal): Promise<unknown>;
}

/** Safe, already-English engine failure. Stack traces are never exposed. */
export class EngineError extends Error {
  readonly code: string;
  readonly httpStatus: number | undefined;

  constructor(code: string, message: string, httpStatus?: number) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type JobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface JobFailure {
  readonly code: string;
  readonly message: string;
}

/** Stable public representation of a job. */
export interface JobSnapshot {
  readonly id: string;
  readonly levelId: string;
  readonly seed: number;
  readonly status: JobStatus;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** Present only for `failed` jobs. */
  readonly error: JobFailure | null;
  /** Present only for `completed` jobs; null for every other status. */
  readonly result: unknown | null;
  readonly links: {
    readonly self: string;
  };
}

export interface AppLimits {
  readonly maxConcurrent: number;
  readonly maxQueue: number;
  readonly maxRegistry: number;
  readonly jobTtlMs: number;
  readonly runTimeoutMs: number;
  readonly sweepIntervalMs: number;
  readonly closeDrainMs: number;
  readonly bodyLimit: number;
}

/**
 * Options accepted by `createApp`. Numeric values are validated and bounded;
 * an out-of-range value throws `RangeError` instead of being silently
 * clamped. The app never calls `app.listen()`, never changes bind/logging
 * defaults owned by P206, and never closes the injected engine.
 */
export interface CreateAppOptions {
  readonly engine: Engine;
  /** Fastify logger setting. Defaults to `false` (P206 owns process logging). */
  readonly logger?: FastifyServerOptions['logger'];
  /** Maximum concurrent `Engine.evaluate` calls. Default 1, range 1..2. */
  readonly maxConcurrent?: number;
  /** Maximum jobs waiting for a worker. Default 16, range 0..4096. */
  readonly maxQueue?: number;
  /** Maximum retained jobs (queued + running + terminal). Default 256. */
  readonly maxRegistry?: number;
  /** Terminal-result retention. Default 1 hour, range 10ms..24h. */
  readonly jobTtlMs?: number;
  /** Per-evaluation wall clock limit. Default 60s, range 10ms..10min. */
  readonly runTimeoutMs?: number;
  /** Expired-terminal sweep interval. Default 30s, range 10ms..60s. */
  readonly sweepIntervalMs?: number;
  /** Bound on graceful close draining. Default 5s, range 10ms..60s. */
  readonly closeDrainMs?: number;
  /** Request body limit. Default and maximum 1 MiB. */
  readonly bodyLimit?: number;
  /**
   * Exact allowed CORS origin, for example `http://127.0.0.1:5178`.
   * No CORS headers or OPTIONS handling are enabled when omitted.
   */
  readonly corsOrigin?: string;
  /** Readiness probe; defaults to ready. Returns false for healthz 503. */
  readonly isReady?: () => boolean;
  /** Clock injection for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Job id injection for deterministic tests. Defaults to `randomUUID`. */
  readonly generateId?: () => string;
}

export const LIMITS = {
  bodyLimit: 1_048_576,
  graphDepth: 32,
  graphValues: 50_000,
  levelIdPattern: '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$',
  jobIdPattern: '^[A-Za-z0-9_-]{8,64}$',
  maxConcurrent: { default: 1, min: 1, max: 2 },
  maxQueue: { default: 16, min: 0, max: 4_096 },
  maxRegistry: { default: 256, min: 2, max: 10_000 },
  jobTtlMs: { default: 3_600_000, min: 10, max: 86_400_000 },
  runTimeoutMs: { default: 60_000, min: 10, max: 600_000 },
  sweepIntervalMs: { default: 30_000, min: 10, max: 60_000 },
  closeDrainMs: { default: 5_000, min: 10, max: 60_000 },
} as const;

export const ERROR_CODES = {
  invalidRequest: 'invalid_request',
  invalidJson: 'invalid_json',
  levelNotFound: 'level_not_found',
  jobNotFound: 'job_not_found',
  routeNotFound: 'route_not_found',
  payloadTooLarge: 'payload_too_large',
  unsupportedMediaType: 'unsupported_media_type',
  graphInvalid: 'graph_invalid',
  jobQueueFull: 'job_queue_full',
  jobRegistryFull: 'job_registry_full',
  serviceUnavailable: 'service_unavailable',
  engineUnavailable: 'engine_unavailable',
  evaluationTimeout: 'evaluation_timeout',
  engineFailure: 'engine_failure',
  internalError: 'internal_error',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ErrorDetail {
  readonly path: string;
  readonly message: string;
}

export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly ErrorDetail[];
  };
}

export type { FastifyServerOptions };
