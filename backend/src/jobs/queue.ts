import { randomUUID } from 'node:crypto';

import {
  ERROR_CODES,
  type Engine,
  type EvaluationSubmission,
  type JobFailure,
  type JobSnapshot,
  type JobStatus,
} from '../contracts.js';
import { safeEngineFailure } from '../http/errors.js';

export interface JobQueueOptions {
  readonly engine: Engine;
  readonly maxConcurrent: number;
  readonly maxQueue: number;
  readonly maxRegistry: number;
  readonly jobTtlMs: number;
  readonly runTimeoutMs: number;
  readonly sweepIntervalMs: number;
  readonly closeDrainMs: number;
  readonly now?: () => number;
  readonly generateId?: () => string;
}

export interface JobQueueStats {
  readonly queued: number;
  readonly running: number;
  readonly retained: number;
  readonly closing: boolean;
}

export class JobQueueFullError extends Error {
  readonly code: 'job_queue_full' | 'job_registry_full';

  constructor(code: 'job_queue_full' | 'job_registry_full') {
    super(
      code === 'job_queue_full'
        ? 'The evaluation queue is full.'
        : 'The evaluation registry is full.',
    );
    this.name = 'JobQueueFullError';
    this.code = code;
  }
}

export class JobQueueClosedError extends Error {
  constructor() {
    super('The evaluation service is shutting down.');
    this.name = 'JobQueueClosedError';
  }
}

interface JobRecord {
  readonly id: string;
  readonly levelId: string;
  readonly graph: unknown;
  readonly seed: number;
  status: JobStatus;
  readonly createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  result: unknown;
  error: JobFailure | null;
  controller: AbortController | null;
  timeout: NodeJS.Timeout | null;
  settled: Promise<void> | null;
}

const TERMINAL: ReadonlySet<JobStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Bounded in-memory job registry and queue.
 *
 * Invariants:
 * - `active.size` never exceeds `maxConcurrent`, even for cancelled calls
 *   whose engine promise ignores the abort signal.
 * - Terminal results are removed only after `jobTtlMs`; queued/running jobs
 *   are never removed by the sweep.
 * - A late engine settlement cannot overwrite `cancelled`, `failed` or
 *   `completed`.
 */
export class JobQueue {
  private readonly engine: Engine;
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly maxRegistry: number;
  private readonly jobTtlMs: number;
  private readonly runTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private readonly closeDrainMs: number;
  private readonly now: () => number;
  private readonly generateId: () => string;

  private readonly records = new Map<string, JobRecord>();
  private readonly queue: string[] = [];
  private readonly active = new Map<string, JobRecord>();
  private timer: NodeJS.Timeout | null = null;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: JobQueueOptions) {
    this.engine = options.engine;
    this.maxConcurrent = options.maxConcurrent;
    this.maxQueue = options.maxQueue;
    this.maxRegistry = options.maxRegistry;
    this.jobTtlMs = options.jobTtlMs;
    this.runTimeoutMs = options.runTimeoutMs;
    this.sweepIntervalMs = options.sweepIntervalMs;
    this.closeDrainMs = options.closeDrainMs;
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? randomUUID;
  }

  get stats(): JobQueueStats {
    return {
      queued: this.queue.length,
      running: this.active.size,
      retained: this.records.size,
      closing: this.closing,
    };
  }

  submit(input: EvaluationSubmission): JobSnapshot {
    if (this.closing) {
      throw new JobQueueClosedError();
    }
    this.sweep();
    if (this.records.size >= this.maxRegistry) {
      throw new JobQueueFullError('job_registry_full');
    }
    if (
      this.active.size >= this.maxConcurrent &&
      this.queue.length >= this.maxQueue
    ) {
      throw new JobQueueFullError('job_queue_full');
    }

    let id = this.generateId();
    for (let attempt = 0; this.records.has(id) && attempt < 16; attempt += 1) {
      id = this.generateId();
    }
    if (this.records.has(id)) {
      throw new Error('Could not generate a unique job id.');
    }

    const job: JobRecord = {
      id,
      levelId: input.levelId,
      graph: input.graph,
      seed: input.seed,
      status: 'queued',
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      controller: null,
      timeout: null,
      settled: null,
    };
    this.records.set(job.id, job);
    this.queue.push(job.id);
    this.ensureTimer();
    this.pump();
    return this.snapshot(job);
  }

  get(id: string): JobSnapshot | null {
    const job = this.records.get(id);
    return job === undefined ? null : this.snapshot(job);
  }

  cancel(id: string): JobSnapshot | null {
    const job = this.records.get(id);
    if (job === undefined) {
      return null;
    }

    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = this.now();
      const index = this.queue.indexOf(job.id);
      if (index >= 0) {
        this.queue.splice(index, 1);
      }
    } else if (job.status === 'running') {
      job.status = 'cancelled';
      job.finishedAt = this.now();
      this.clearTimeout(job);
      this.abort(job);
      // Keep the concurrency slot until the engine promise settles. An engine
      // that ignores AbortSignal must not cause unbounded concurrent calls.
    }
    // Terminal jobs are retained unchanged and DELETE is idempotent.
    return this.snapshot(job);
  }

  /** Remove terminal jobs whose retention window elapsed. Never evicts active jobs. */
  sweep(): void {
    const current = this.now();
    for (const [id, job] of this.records) {
      if (
        isTerminal(job.status) &&
        job.finishedAt !== null &&
        job.finishedAt + this.jobTtlMs <= current
      ) {
        this.records.delete(id);
      }
    }
    if (this.records.size === 0) {
      this.stopTimer();
    }
  }

  /**
   * Cancel queued/running jobs and drain for at most `closeDrainMs`. The app
   * close hook awaits this, so a stuck engine cannot hang shutdown forever.
   */
  close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    this.closing = true;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    this.stopTimer();
    const pending: Promise<void>[] = [];
    const finishedAt = this.now();

    for (const job of this.records.values()) {
      if (job.status === 'queued') {
        job.status = 'cancelled';
        job.finishedAt = finishedAt;
      }
    }
    this.queue.length = 0;

    // An active engine call can already be publicly cancelled or failed
    // (timeout) while its promise is still unresolved. Drain every active
    // call regardless of public status; only running jobs need a new
    // cancellation/abort here.
    for (const job of this.active.values()) {
      if (job.status === 'running') {
        job.status = 'cancelled';
        job.finishedAt = finishedAt;
        this.clearTimeout(job);
        this.abort(job);
      }
      if (job.settled !== null) {
        pending.push(job.settled);
      }
    }

    if (pending.length === 0) {
      return;
    }

    let timer: NodeJS.Timeout | null = null;
    const drainTimeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.closeDrainMs);
    });
    try {
      await Promise.race([Promise.allSettled(pending), drainTimeout]);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  private pump(): void {
    if (this.closing) {
      return;
    }
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift();
      if (id === undefined) {
        break;
      }
      const job = this.records.get(id);
      if (job !== undefined && job.status === 'queued') {
        this.start(job);
      }
    }
  }

  private start(job: JobRecord): void {
    job.status = 'running';
    job.startedAt = this.now();
    const controller = new AbortController();
    job.controller = controller;
    job.timeout = setTimeout(() => this.failTimeout(job), this.runTimeoutMs);
    job.timeout.unref();
    this.active.set(job.id, job);

    const evaluation = Promise.resolve().then(() =>
      this.engine.evaluate(
        { levelId: job.levelId, graph: job.graph, seed: job.seed },
        controller.signal,
      ),
    );
    job.settled = evaluation
      .then(
        (value) => {
          this.complete(job, value);
        },
        (error: unknown) => {
          this.fail(job, error);
        },
      )
      .catch(() => undefined)
      .finally(() => {
        this.release(job);
      })
      .catch(() => undefined);
  }

  private complete(job: JobRecord, value: unknown): void {
    if (job.status !== 'running') {
      return;
    }
    this.clearTimeout(job);
    job.status = 'completed';
    job.result = value;
    job.finishedAt = this.now();
  }

  private fail(job: JobRecord, error: unknown): void {
    if (job.status !== 'running') {
      return;
    }
    this.clearTimeout(job);
    job.status = 'failed';
    job.error = safeEngineFailure(error);
    job.finishedAt = this.now();
  }

  private failTimeout(job: JobRecord): void {
    if (job.status !== 'running') {
      return;
    }
    this.clearTimeout(job);
    job.status = 'failed';
    job.error = {
      code: ERROR_CODES.evaluationTimeout,
      message: 'The evaluation exceeded the server time limit.',
    };
    job.finishedAt = this.now();
    this.abort(job);
    // The active slot is released when the engine promise settles. If it
    // never settles, close is still bounded by closeDrainMs.
  }

  private release(job: JobRecord): void {
    this.clearTimeout(job);
    job.controller = null;
    this.active.delete(job.id);
    if (!this.closing) {
      this.pump();
      this.maybeStopTimer();
    }
  }

  private clearTimeout(job: JobRecord): void {
    if (job.timeout !== null) {
      clearTimeout(job.timeout);
      job.timeout = null;
    }
  }

  private abort(job: JobRecord): void {
    const controller = job.controller;
    if (controller === null || controller.signal.aborted) {
      return;
    }
    try {
      controller.abort();
    } catch {
      // A throwing abort listener is an engine bug, not a reason to break the
      // HTTP cancellation path. The job state is already terminal and the
      // concurrency slot is released only when the engine promise settles.
    }
  }

  private ensureTimer(): void {
    if (this.timer !== null || this.closing) {
      return;
    }
    this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.timer.unref();
  }

  private maybeStopTimer(): void {
    if (this.records.size === 0) {
      this.stopTimer();
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private snapshot(job: JobRecord): JobSnapshot {
    return {
      id: job.id,
      levelId: job.levelId,
      seed: job.seed,
      status: job.status,
      createdAt: new Date(job.createdAt).toISOString(),
      startedAt:
        job.startedAt === null ? null : new Date(job.startedAt).toISOString(),
      finishedAt:
        job.finishedAt === null
          ? null
          : new Date(job.finishedAt).toISOString(),
      error:
        job.status === 'failed'
          ? (job.error ?? {
              code: ERROR_CODES.engineFailure,
              message: 'The evaluation failed unexpectedly.',
            })
          : null,
      result:
        job.status === 'completed'
          ? job.result === undefined
            ? null
            : job.result
          : null,
      links: { self: `/v1/evaluations/${job.id}` },
    };
  }
}
