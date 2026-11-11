import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  Engine,
  EvaluationSubmission,
  LevelSummary,
} from '../src/contracts.js';
import {
  JobQueue,
  JobQueueClosedError,
  JobQueueFullError,
  type JobQueueOptions,
} from '../src/jobs/queue.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeEngine implements Engine {
  evaluations = 0;
  readonly signals: AbortSignal[] = [];
  private readonly implementation: (
    submission: EvaluationSubmission,
    signal: AbortSignal,
  ) => Promise<unknown>;

  constructor(
    implementation: (
      submission: EvaluationSubmission,
      signal: AbortSignal,
    ) => Promise<unknown> = () => Promise.resolve({ passed: true }),
  ) {
    this.implementation = implementation;
  }

  levels(): Promise<readonly LevelSummary[]> {
    return Promise.resolve([
      {
        id: 'parcel-pulse',
        title: 'Parcel Pulse',
        description: 'Test level.',
        defaultSeed: 101,
        horizons: [1, 5],
      },
    ]);
  }

  describe(): Promise<unknown> {
    return Promise.resolve({ id: 'parcel-pulse' });
  }

  components(): Promise<unknown> {
    return Promise.resolve({});
  }

  schema(): Promise<unknown> {
    return Promise.resolve({});
  }

  evaluate(
    submission: EvaluationSubmission,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.evaluations += 1;
    this.signals.push(signal);
    return this.implementation(submission, signal);
  }
}

type QueueOverrides = Omit<Partial<JobQueueOptions>, 'engine'>;

function makeQueue(
  engine: FakeEngine,
  overrides: QueueOverrides = {},
): JobQueue {
  return new JobQueue({
    engine,
    maxConcurrent: 1,
    maxQueue: 2,
    maxRegistry: 4,
    jobTtlMs: 1_000,
    runTimeoutMs: 1_000,
    sweepIntervalMs: 1_000,
    closeDrainMs: 20,
    ...overrides,
  });
}

const SUBMISSION: EvaluationSubmission = {
  levelId: 'parcel-pulse',
  graph: { nodes: [], edges: [] },
  seed: 101,
};

async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

test('queue runs jobs FIFO one at a time and respects concurrency', async (t) => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  let calls = 0;
  const engine = new FakeEngine(() => {
    calls += 1;
    return calls === 1 ? first.promise : second.promise;
  });
  const queue = makeQueue(engine);
  t.after(async () => {
    await queue.close();
  });

  const firstJob = queue.submit(SUBMISSION);
  const secondJob = queue.submit(SUBMISSION);
  assert.equal(firstJob.status, 'running');
  assert.equal(secondJob.status, 'queued');
  await waitUntil(() => calls === 1, 'first engine call');

  first.resolve({ passed: true });
  await waitUntil(
    () => queue.get(firstJob.id)?.status === 'completed',
    'first completion',
  );
  await waitUntil(
    () => queue.get(secondJob.id)?.status === 'running',
    'second start',
  );
  assert.equal(calls, 2);

  second.resolve({ passed: true });
  await waitUntil(
    () => queue.get(secondJob.id)?.status === 'completed',
    'second completion',
  );
});

test('queue and registry limits throw stable errors', async (t) => {
  const blocked = deferred<unknown>();
  const queue = makeQueue(new FakeEngine(() => blocked.promise), {
    maxQueue: 0,
    maxRegistry: 2,
  });
  t.after(async () => {
    await queue.close();
  });

  queue.submit(SUBMISSION);
  assert.throws(
    () => queue.submit(SUBMISSION),
    (error: unknown) =>
      error instanceof JobQueueFullError && error.code === 'job_queue_full',
  );

  const registryQueue = makeQueue(new FakeEngine(() => blocked.promise), {
    maxQueue: 1,
    maxRegistry: 2,
  });
  t.after(async () => {
    await registryQueue.close();
  });
  registryQueue.submit(SUBMISSION);
  registryQueue.submit(SUBMISSION);
  assert.throws(
    () => registryQueue.submit(SUBMISSION),
    (error: unknown) =>
      error instanceof JobQueueFullError && error.code === 'job_registry_full',
  );
});

test('TTL sweep removes only terminal jobs', async (t) => {
  let now = 0;
  const queue = makeQueue(new FakeEngine(), {
    jobTtlMs: 10,
    sweepIntervalMs: 60_000,
    now: () => now,
  });
  t.after(async () => {
    await queue.close();
  });

  const completed = queue.submit(SUBMISSION);
  await waitUntil(
    () => queue.get(completed.id)?.status === 'completed',
    'completed job',
  );
  now = 100;
  queue.sweep();
  assert.equal(queue.get(completed.id), null);

  const stuck = deferred<unknown>();
  const activeQueue = makeQueue(new FakeEngine(() => stuck.promise), {
    jobTtlMs: 10,
    sweepIntervalMs: 60_000,
    now: () => now,
  });
  t.after(async () => {
    await activeQueue.close();
  });
  const active = activeQueue.submit(SUBMISSION);
  now = 1_000;
  activeQueue.sweep();
  assert.equal(activeQueue.get(active.id)?.status, 'running');
});

test('cancellation covers queued and running jobs and blocks late completion', async (t) => {
  const first = deferred<unknown>();
  const engine = new FakeEngine(() => first.promise);
  const queue = makeQueue(engine);
  t.after(async () => {
    await queue.close();
  });

  const running = queue.submit(SUBMISSION);
  const queued = queue.submit(SUBMISSION);
  assert.equal(queued.status, 'queued');
  await waitUntil(() => engine.signals.length === 1, 'engine call');

  assert.equal(queue.cancel(queued.id)?.status, 'cancelled');
  assert.equal(queue.cancel(running.id)?.status, 'cancelled');
  assert.equal(engine.signals[0]?.aborted, true);

  first.resolve({ passed: true });
  await waitUntil(() => queue.stats.running === 0, 'active slot release');
  const after = queue.get(running.id);
  assert.equal(after?.status, 'cancelled');
  assert.equal(after?.result, null);
  assert.equal(queue.get(queued.id)?.status, 'cancelled');
});

test('unexpected rejection and timeout produce safe failed jobs', async (t) => {
  const rejectedQueue = makeQueue(
    new FakeEngine(() => Promise.reject(new Error('stack secret'))),
  );
  t.after(async () => {
    await rejectedQueue.close();
  });
  const rejected = rejectedQueue.submit(SUBMISSION);
  await waitUntil(
    () => rejectedQueue.get(rejected.id)?.status === 'failed',
    'rejected completion',
  );
  const failed = rejectedQueue.get(rejected.id);
  assert.equal(failed?.error?.code, 'engine_failure');
  assert.equal(JSON.stringify(failed).includes('secret'), false);

  const timeoutEngine = new FakeEngine((_submission, abortSignal) => {
    return new Promise((_resolve, reject) => {
      abortSignal.addEventListener('abort', () => reject(new Error('abort')), {
        once: true,
      });
    });
  });
  const timeoutQueue = makeQueue(timeoutEngine, { runTimeoutMs: 20 });
  t.after(async () => {
    await timeoutQueue.close();
  });
  const timed = timeoutQueue.submit(SUBMISSION);
  await waitUntil(
    () => timeoutQueue.get(timed.id)?.status === 'failed',
    'timeout completion',
  );
  assert.equal(timeoutQueue.get(timed.id)?.error?.code, 'evaluation_timeout');
  assert.equal(timeoutEngine.signals[0]?.aborted, true);
});

test('close after cancellation drains an abort-ignoring engine call', async () => {
  const pending = deferred<unknown>();
  let aborts = 0;
  const engine = new FakeEngine((_submission, signal) => {
    signal.addEventListener(
      'abort',
      () => {
        aborts += 1;
      },
      { once: true },
    );
    return pending.promise;
  });
  const queue = makeQueue(engine, { closeDrainMs: 200 });

  const job = queue.submit(SUBMISSION);
  await waitUntil(() => engine.signals.length === 1, 'engine call');
  assert.equal(queue.cancel(job.id)?.status, 'cancelled');
  assert.equal(engine.signals[0]?.aborted, true);
  assert.equal(aborts, 1);

  let closed = false;
  const closePromise = queue.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false);

  pending.resolve({ passed: true });
  await closePromise;
  assert.equal(closed, true);
  assert.equal(aborts, 1);
  assert.equal(queue.get(job.id)?.status, 'cancelled');
  assert.equal(queue.get(job.id)?.result, null);
});

test('close after timeout drains an abort-ignoring engine call', async () => {
  const pending = deferred<unknown>();
  let aborts = 0;
  const engine = new FakeEngine((_submission, signal) => {
    signal.addEventListener(
      'abort',
      () => {
        aborts += 1;
      },
      { once: true },
    );
    return pending.promise;
  });
  const queue = makeQueue(engine, { runTimeoutMs: 20, closeDrainMs: 200 });

  const job = queue.submit(SUBMISSION);
  await waitUntil(
    () => queue.get(job.id)?.status === 'failed',
    'timeout completion',
  );
  assert.equal(queue.get(job.id)?.error?.code, 'evaluation_timeout');
  assert.equal(engine.signals[0]?.aborted, true);
  assert.equal(aborts, 1);

  let closed = false;
  const closePromise = queue.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false);

  pending.resolve({ passed: true });
  await closePromise;
  assert.equal(closed, true);
  assert.equal(aborts, 1);
  assert.equal(queue.get(job.id)?.status, 'failed');
});

test('close after cancellation is bounded when an aborted call never settles', async () => {
  const queue = makeQueue(new FakeEngine(() => new Promise(() => undefined)), {
    closeDrainMs: 40,
  });

  const job = queue.submit(SUBMISSION);
  assert.equal(queue.cancel(job.id)?.status, 'cancelled');

  const started = Date.now();
  await queue.close();
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 25, `close returned too early: ${elapsed}ms`);
  assert.ok(elapsed < 1_000, `close exceeded the bound: ${elapsed}ms`);
});

test('close cancels all jobs, drains within the bound and rejects new work', async (t) => {
  const queue = makeQueue(
    new FakeEngine(() => new Promise(() => undefined)),
    { maxConcurrent: 1, maxQueue: 2, maxRegistry: 4, closeDrainMs: 30 },
  );
  t.after(async () => {
    await queue.close();
  });

  const running = queue.submit(SUBMISSION);
  const queued = queue.submit(SUBMISSION);
  assert.equal(running.status, 'running');
  assert.equal(queued.status, 'queued');

  const started = Date.now();
  const closing = queue.close();
  const closingAgain = queue.close();
  assert.equal(closing, closingAgain);
  await closing;
  assert.ok(Date.now() - started < 1_000);
  assert.equal(queue.get(running.id)?.status, 'cancelled');
  assert.equal(queue.get(queued.id)?.status, 'cancelled');
  assert.throws(() => queue.submit(SUBMISSION), JobQueueClosedError);
});
