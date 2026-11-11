/**
 * Worker-backed implementation of the frozen P205 `Engine`.
 *
 * Metadata is computed directly from the authoritative pure core. Every
 * `evaluate` call runs in its own Node Worker Thread, so the HTTP event loop
 * never executes the simulation. The job queue bounds concurrency, which in
 * turn bounds the number of workers.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker, type ResourceLimits } from 'node:worker_threads';

import {
  EngineError,
  type Engine,
  type EvaluationSubmission,
  type LevelSummary,
} from '../contracts.js';
import type { EngineRegistry } from '../../../src/simulation/registry.js';
import {
  createBackendRegistry,
  levelComponents,
  levelDescription,
  levelSchema,
  levelSummaries,
  requireLevel,
  requireSeed,
} from './levels.js';
import {
  isRecord,
  parseWorkerMessage,
  type WorkerProgress,
  type WorkerRunStats,
} from './protocol.js';
import type { EngineResultBinding } from './result-validation.js';

export interface WorkerEngineOptions {
  /**
   * Trusted worker entry. `src/main.ts` provides the `.ts` development entry
   * or the bundled `.js` production entry explicitly. When omitted, the
   * source-tree worker next to this module is used.
   */
  readonly workerEntry?: URL;
  /**
   * V8 worker limits. Legacy levels default to a 512 MiB old generation,
   * 64 MiB young generation and 4 MiB stack. Live Audience is capped at a
   * stricter 192 MiB old generation, 16 MiB young generation and 4 MiB stack;
   * a larger provided limit cannot raise that cap, while stricter provided
   * values are preserved. These are Node Worker Thread limits and do not
   * bound the browser runtime. Measured heap limits are reported through
   * `WorkerRunStats.heapSizeLimitBytes`.
   */
  readonly resourceLimits?: ResourceLimits;
  /** Node CLI flags for the worker. Defaults to `--import tsx` for `.ts`. */
  readonly execArgv?: readonly string[];
  /** Optional in-process observer for worker progress. */
  readonly onProgress?: (progress: WorkerProgress) => void;
  /** Optional observer for per-run elapsed time and memory. */
  readonly onRunStats?: (stats: WorkerRunStats) => void;
  /**
   * Authoritative level registry. Defaults to the shared five-level registry;
   * tests may inject one with an Image evaluator once I101 is available.
   */
  readonly registry?: EngineRegistry;
  /**
   * Test hook for the termination promise. Production uses
   * `worker.terminate()`; the override must terminate the worker and resolve
   * when the thread has exited.
   */
  readonly terminateWorker?: (worker: Worker) => Promise<unknown>;
}

export interface WorkerEngineStats {
  readonly activeWorkers: number;
  readonly terminatingWorkers: number;
  /** Active plus terminating workers; the actual resource count. */
  readonly liveWorkers: number;
  readonly completedRuns: number;
  readonly failedRuns: number;
  readonly peakWorkers: number;
  readonly lastRun: WorkerRunStats | null;
}

const AUDIENCE_LEVEL_ID = 'live-audience';

interface ConcreteResourceLimits {
  readonly maxOldGenerationSizeMb: number;
  readonly maxYoungGenerationSizeMb: number;
  readonly stackSizeMb: number;
}

const DEFAULT_RESOURCE_LIMITS: ConcreteResourceLimits = {
  maxOldGenerationSizeMb: 512,
  maxYoungGenerationSizeMb: 64,
  stackSizeMb: 4,
};

/**
 * Live Audience's measured working set fits comfortably below these limits.
 * Values are a hard ceiling, not a default the caller or environment can
 * raise; see `resourceLimitsForLevel`.
 */
const AUDIENCE_RESOURCE_LIMITS: ConcreteResourceLimits = {
  maxOldGenerationSizeMb: 192,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
};

/**
 * Select the V8 resource limits for one evaluation.
 *
 * Legacy levels use the provided limits unchanged, or the 512/64/4 default.
 * Live Audience is clamped to 192/16/4 even when the provided/global default
 * is larger. A stricter provided value is never raised. Any other provided
 * `ResourceLimits` fields (for example `codeRangeSizeMb`) are preserved.
 */
export function resourceLimitsForLevel(
  levelId: string,
  provided?: ResourceLimits,
): ResourceLimits {
  if (levelId !== AUDIENCE_LEVEL_ID) {
    return provided === undefined ? DEFAULT_RESOURCE_LIMITS : { ...provided };
  }
  return {
    ...(provided ?? {}),
    maxOldGenerationSizeMb: Math.min(
      provided?.maxOldGenerationSizeMb ??
        AUDIENCE_RESOURCE_LIMITS.maxOldGenerationSizeMb,
      AUDIENCE_RESOURCE_LIMITS.maxOldGenerationSizeMb,
    ),
    maxYoungGenerationSizeMb: Math.min(
      provided?.maxYoungGenerationSizeMb ??
        AUDIENCE_RESOURCE_LIMITS.maxYoungGenerationSizeMb,
      AUDIENCE_RESOURCE_LIMITS.maxYoungGenerationSizeMb,
    ),
    stackSizeMb: Math.min(
      provided?.stackSizeMb ?? AUDIENCE_RESOURCE_LIMITS.stackSizeMb,
      AUDIENCE_RESOURCE_LIMITS.stackSizeMb,
    ),
  };
}

const DEFAULT_CLOSE_DRAIN_MS = 5_000;
const CANCELLED = 'evaluation_cancelled';
const UNAVAILABLE = 'service_unavailable';

function safeFailure(message: string): EngineError {
  return new EngineError('engine_failure', message, 503);
}

/**
 * Preserve the historical error message for a worker that returns a
 * well-shaped result for another seed/level/graph. The strict validator still
 * rejects every mismatch; this only improves the safe diagnostic.
 */
function resultBindingMismatch(
  value: unknown,
  binding: EngineResultBinding,
): boolean {
  if (!isRecord(value) || value.type !== 'result' || !isRecord(value.result)) {
    return false;
  }
  const meta = value.result.meta;
  if (!isRecord(meta)) {
    return false;
  }
  return (
    meta.seed !== binding.seed ||
    meta.levelId !== binding.levelId ||
    meta.graphDigest !== binding.graphDigest
  );
}

export class WorkerEngine implements Engine {
  private readonly registry: EngineRegistry;
  private readonly workerEntry: URL;
  private readonly providedResourceLimits: ResourceLimits | undefined;
  private readonly execArgv: string[];
  private readonly onProgress: ((progress: WorkerProgress) => void) | undefined;
  private readonly onRunStats: ((stats: WorkerRunStats) => void) | undefined;
  private readonly terminateWorker: (worker: Worker) => Promise<unknown>;

  private readonly active = new Set<Worker>();
  private readonly pending = new Map<Worker, (reason: EngineError) => void>();
  private readonly terminations = new Set<Promise<unknown>>();
  private closing: Promise<void> | null = null;
  private closed = false;
  private completedRuns = 0;
  private failedRuns = 0;
  private peakWorkers = 0;
  private lastRun: WorkerRunStats | null = null;

  constructor(options: WorkerEngineOptions = {}) {
    this.registry = options.registry ?? createBackendRegistry();
    this.workerEntry =
      options.workerEntry ?? new URL('./worker.ts', import.meta.url);
    this.providedResourceLimits = options.resourceLimits;
    const isTypeScript = this.workerEntry.pathname.endsWith('.ts');
    this.execArgv =
      options.execArgv !== undefined
        ? [...options.execArgv]
        : isTypeScript
          ? ['--import', 'tsx']
          : [];
    this.onProgress = options.onProgress;
    this.onRunStats = options.onRunStats;
    this.terminateWorker =
      options.terminateWorker ?? ((worker) => worker.terminate());
    this.assertEntry();
  }

  get stats(): WorkerEngineStats {
    return {
      activeWorkers: this.active.size,
      terminatingWorkers: this.terminations.size,
      liveWorkers: this.active.size + this.terminations.size,
      completedRuns: this.completedRuns,
      failedRuns: this.failedRuns,
      peakWorkers: this.peakWorkers,
      lastRun: this.lastRun,
    };
  }

  /** Synchronous readiness for `createApp({isReady})`. */
  ready(): boolean {
    return !this.closed && existsSync(fileURLToPath(this.workerEntry));
  }

  /** Fail startup loudly when the trusted worker entry is missing. */
  assertReady(): void {
    this.assertEntry();
  }

  levels(): Promise<readonly LevelSummary[]> {
    return Promise.resolve(levelSummaries(this.registry));
  }

  describe(levelId: string): Promise<unknown> {
    return Promise.resolve(levelDescription(this.registry, levelId));
  }

  components(levelId: string): Promise<unknown> {
    return Promise.resolve(levelComponents(this.registry, levelId));
  }

  schema(levelId: string): Promise<unknown> {
    return Promise.resolve(levelSchema(this.registry, levelId));
  }

  evaluate(
    submission: EvaluationSubmission,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new EngineError(UNAVAILABLE, 'The simulation engine is shutting down.', 503),
      );
    }
    let binding: EngineResultBinding;
    try {
      requireLevel(this.registry, submission.levelId);
      requireSeed(this.registry, submission.levelId, submission.seed);
      const entry = this.registry.resolve(submission.levelId);
      if (entry === null) {
        throw new EngineError('level_not_found', 'Level not found.', 404);
      }
      const expectation =
        entry.expectation?.(submission.graph) ?? undefined;
      const requirements =
        entry.requirements?.(submission.graph) ?? undefined;
      binding = {
        levelId: entry.descriptor.id,
        modelVersion: entry.descriptor.modelVersion,
        schemaVersion: entry.descriptor.schemaVersion,
        contentVersion: entry.descriptor.contentVersion,
        pricingVersion: entry.descriptor.pricingVersion,
        ...(entry.descriptor.profileVersion === undefined
          ? {}
          : { profileVersion: entry.descriptor.profileVersion }),
        seed: submission.seed,
        graphDigest: this.registry.semanticDigest(
          submission.levelId,
          submission.graph,
        ),
        ...(expectation === undefined ? {} : { expectation }),
        ...(requirements === undefined
          ? {}
          : { requiredCaseIds: [...requirements.requiredCases] }),
      };
    } catch (error) {
      return Promise.reject(error);
    }
    if (signal.aborted) {
      return Promise.reject(
        new EngineError(CANCELLED, 'The evaluation was cancelled.', 409),
      );
    }

    let worker: Worker;
    try {
      worker = new Worker(this.workerEntry, {
        workerData: {
          levelId: submission.levelId,
          graph: submission.graph,
          seed: submission.seed,
        },
        resourceLimits: resourceLimitsForLevel(
          submission.levelId,
          this.providedResourceLimits,
        ),
        execArgv: this.execArgv,
      });
    } catch {
      this.failedRuns += 1;
      return Promise.reject(
        safeFailure('The simulation worker could not be started.'),
      );
    }

    this.active.add(worker);
    this.notePeakWorkers();

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;

      const finish = (action: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        worker.off('message', onMessage);
        worker.off('messageerror', onMessageError);
        worker.off('error', onError);
        worker.off('exit', onExit);
        this.active.delete(worker);
        this.pending.delete(worker);

        // Keep the worker counted and the evaluation promise pending until
        // the termination promise settles. The job queue releases its
        // concurrency slot on promise settlement, so a replacement must not
        // start while the old thread is still exiting.
        const termination = this.terminate(worker);
        this.terminations.add(termination);
        void termination.then(() => {
          this.terminations.delete(termination);
          action();
        });
      };

      const cancel = (reason: EngineError): void => {
        finish(() => {
          this.failedRuns += 1;
          reject(reason);
        });
      };

      const onAbort = (): void => {
        cancel(
          new EngineError(CANCELLED, 'The evaluation was cancelled.', 409),
        );
      };

      const onMessage = (value: unknown): void => {
        const parsed = parseWorkerMessage(value, binding);
        if (!parsed.ok) {
          cancel(
            safeFailure(
              resultBindingMismatch(value, binding)
                ? 'The simulation worker returned a result for a different request.'
                : 'The simulation worker returned an invalid message.',
            ),
          );
          return;
        }
        if (parsed.message.type === 'progress') {
          try {
            this.onProgress?.(parsed.message.progress);
          } catch {
            // Observer failures must not fail an otherwise valid evaluation.
          }
          return;
        }
        if (parsed.message.type === 'error') {
          cancel(
            new EngineError(
              parsed.message.error.code,
              parsed.message.error.message,
              503,
            ),
          );
          return;
        }
        this.lastRun = parsed.message.stats;
        const result = parsed.message.result;
        this.completedRuns += 1;
        try {
          this.onRunStats?.(parsed.message.stats);
        } catch {
          // Ignore observer failures.
        }
        finish(() => resolve(result));
      };

      const onMessageError = (): void => {
        cancel(safeFailure('The simulation worker message could not be read.'));
      };

      const onError = (): void => {
        cancel(safeFailure('The simulation worker crashed.'));
      };

      const onExit = (code: number): void => {
        if (settled) {
          return;
        }
        cancel(
          code === 0
            ? safeFailure('The simulation worker stopped without a result.')
            : safeFailure('The simulation worker crashed.'),
        );
      };

      signal.addEventListener('abort', onAbort, { once: true });
      worker.on('message', onMessage);
      worker.on('messageerror', onMessageError);
      worker.on('error', onError);
      worker.on('exit', onExit);
      this.pending.set(worker, cancel);
    });
  }

  /**
   * Reject outstanding evaluations, terminate every worker and wait (bounded)
   * for the worker threads to exit. HTTP shutdown calls this after
   * `app.close()`.
   */
  close(): Promise<void> {
    if (this.closing !== null) {
      return this.closing;
    }
    this.closed = true;
    this.closing = this.performClose();
    return this.closing;
  }

  private notePeakWorkers(): void {
    const live = this.active.size + this.terminations.size;
    if (live > this.peakWorkers) {
      this.peakWorkers = live;
    }
  }

  /**
   * Resolve only when the worker thread is gone. An already-exited worker
   * resolves immediately; a hook/terminate failure is treated as the end of
   * the termination attempt so the evaluation can settle once.
   */
  private terminate(worker: Worker): Promise<void> {
    if (worker.threadId === -1) {
      return Promise.resolve();
    }
    let pending: Promise<unknown>;
    try {
      pending = this.terminateWorker(worker);
    } catch {
      return Promise.resolve();
    }
    return Promise.resolve(pending).then(
      () => undefined,
      () => undefined,
    );
  }

  private async performClose(): Promise<void> {
    const reason = new EngineError(
      UNAVAILABLE,
      'The simulation engine is shutting down.',
      503,
    );
    for (const cancel of [...this.pending.values()]) {
      cancel(reason);
    }

    let timer: NodeJS.Timeout | null = null;
    const drain = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), DEFAULT_CLOSE_DRAIN_MS);
    });
    const settled = (async (): Promise<boolean> => {
      while (this.terminations.size > 0) {
        await Promise.allSettled([...this.terminations]);
      }
      return true;
    })();
    try {
      await Promise.race([settled, drain]);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  private assertEntry(): void {
    let path: string;
    try {
      path = fileURLToPath(this.workerEntry);
    } catch {
      throw new EngineError(
        'engine_unavailable',
        'The simulation worker entry is invalid.',
        503,
      );
    }
    if (!existsSync(path)) {
      throw new EngineError(
        'engine_unavailable',
        'The simulation worker entry is missing. Build the backend with `npm run build` before `npm start`.',
        503,
      );
    }
  }
}

export function createWorkerEngine(
  options: WorkerEngineOptions = {},
): WorkerEngine {
  return new WorkerEngine(options);
}
