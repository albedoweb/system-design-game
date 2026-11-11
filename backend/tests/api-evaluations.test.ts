import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import {
  EngineError,
  type CreateAppOptions,
  type Engine,
  type EvaluationSubmission,
  type JobSnapshot,
  type LevelSummary,
} from '../src/contracts.js';

const LEVEL: LevelSummary = {
  id: 'parcel-pulse',
  title: 'Parcel Pulse',
  description: 'Track parcels across storage families.',
  defaultSeed: 101,
  horizons: [1, 5],
};

interface FakeOptions {
  readonly evaluate?: (
    submission: EvaluationSubmission,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

class FakeEngine implements Engine {
  evaluations = 0;
  readonly submissions: EvaluationSubmission[] = [];
  readonly signals: AbortSignal[] = [];
  private readonly options: FakeOptions;

  constructor(options: FakeOptions = {}) {
    this.options = options;
  }

  levels(): Promise<readonly LevelSummary[]> {
    return Promise.resolve([LEVEL]);
  }

  describe(levelId: string): Promise<unknown> {
    return Promise.resolve({ id: levelId, title: LEVEL.title });
  }

  components(levelId: string): Promise<unknown> {
    return Promise.resolve({ levelId, components: [] });
  }

  schema(levelId: string): Promise<unknown> {
    return Promise.resolve({ levelId, type: 'object' });
  }

  evaluate(
    submission: EvaluationSubmission,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.evaluations += 1;
    this.submissions.push(submission);
    this.signals.push(signal);
    return (
      this.options.evaluate?.(submission, signal) ??
      Promise.resolve({ status: 'ok', passed: false })
    );
  }
}

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

type AppOverrides = Omit<Partial<CreateAppOptions>, 'engine'>;

async function makeApp(
  engine: FakeEngine,
  overrides: AppOverrides = {},
): Promise<FastifyInstance> {
  return createApp({ engine, ...overrides });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function getJob(app: FastifyInstance, id: string): Promise<JobSnapshot> {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/evaluations/${id}`,
  });
  assert.equal(response.statusCode, 200);
  return response.json() as JobSnapshot;
}

async function waitForStatus(
  app: FastifyInstance,
  id: string,
  status: JobSnapshot['status'],
): Promise<JobSnapshot> {
  await waitFor(async () => (await getJob(app, id)).status === status, status);
  return getJob(app, id);
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: { path: string; message: string }[];
  };
}

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    levelId: 'parcel-pulse',
    graph: { nodes: [], edges: [] },
    ...overrides,
  };
}

test('POST returns 202 with Location and passed:false completes the job', async (t) => {
  const engine = new FakeEngine();
  const app = await makeApp(engine);
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  assert.equal(response.statusCode, 202);
  const created = response.json() as JobSnapshot;
  assert.equal(response.headers.location, created.links.self);
  assert.equal(created.links.self, `/v1/evaluations/${created.id}`);
  assert.equal(created.levelId, 'parcel-pulse');
  assert.equal(created.seed, 101);
  assert.equal(created.result, null);
  assert.equal(created.error, null);
  assert.ok(['queued', 'running'].includes(created.status));

  const completed = await waitForStatus(app, created.id, 'completed');
  assert.deepEqual(completed.result, { status: 'ok', passed: false });
  assert.equal(completed.error, null);
  assert.notEqual(completed.startedAt, null);
  assert.notEqual(completed.finishedAt, null);
  assert.equal(engine.submissions.length, 1);
  assert.deepEqual(engine.submissions[0]?.graph, {
    nodes: [],
    edges: [],
  });
  assert.equal(engine.submissions[0]?.seed, 101);
});

test('explicit maximum seed is accepted and structured invalid results complete', async (t) => {
  const invalidResult = {
    status: 'invalid',
    passed: false,
    issues: [{ code: 'missing_route', message: 'A route is missing.' }],
  };
  const app = await makeApp(
    new FakeEngine({ evaluate: () => Promise.resolve(invalidResult) }),
  );
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload({ seed: 2_147_483_647 }),
  });
  assert.equal(response.statusCode, 202);
  const created = response.json() as JobSnapshot;
  assert.equal(created.seed, 2_147_483_647);

  const completed = await waitForStatus(app, created.id, 'completed');
  assert.deepEqual(completed.result, invalidResult);
});

test('EngineError becomes a safe failed job', async (t) => {
  const app = await makeApp(
    new FakeEngine({
      evaluate: () =>
        Promise.reject(
          new EngineError('run_limit', 'The configured run limit was exceeded.'),
        ),
    }),
  );
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  const created = response.json() as JobSnapshot;
  const failed = await waitForStatus(app, created.id, 'failed');
  assert.deepEqual(failed.error, {
    code: 'run_limit',
    message: 'The configured run limit was exceeded.',
  });
  assert.equal(failed.result, null);
});

test('unexpected engine exceptions become a generic failure without leaking details', async (t) => {
  const app = await makeApp(
    new FakeEngine({
      evaluate: () => Promise.reject(new Error('secret stack marker')),
    }),
  );
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  const created = response.json() as JobSnapshot;
  const failed = await waitForStatus(app, created.id, 'failed');
  assert.equal(failed.error?.code, 'engine_failure');
  assert.equal(failed.error?.message, 'The evaluation failed unexpectedly.');
  assert.equal(JSON.stringify(failed).includes('secret'), false);
});

test('submission validation rejects unknown fields, bad seeds and graph limits', async (t) => {
  const engine = new FakeEngine();
  const app = await makeApp(engine);
  t.after(async () => {
    await app.close();
  });

  const cases: {
    payload: Record<string, unknown>;
    status: number;
    code: string;
  }[] = [
    {
      payload: basePayload({ extra: true }),
      status: 400,
      code: 'invalid_request',
    },
    {
      payload: basePayload({ seed: '101' }),
      status: 400,
      code: 'invalid_request',
    },
    {
      payload: basePayload({ seed: -1 }),
      status: 400,
      code: 'invalid_request',
    },
    {
      payload: basePayload({ seed: 2_147_483_648 }),
      status: 400,
      code: 'invalid_request',
    },
    {
      payload: { levelId: 'parcel-pulse' },
      status: 400,
      code: 'invalid_request',
    },
    {
      payload: basePayload({ graph: null }),
      status: 400,
      code: 'invalid_request',
    },
    {
      payload: basePayload({ levelId: 42 }),
      status: 400,
      code: 'invalid_request',
    },
    {
      payload: basePayload({ levelId: 'missing-level' }),
      status: 404,
      code: 'level_not_found',
    },
  ];

  for (const item of cases) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/evaluations',
      payload: item.payload,
    });
    assert.equal(
      response.statusCode,
      item.status,
      `payload ${JSON.stringify(item.payload)}`,
    );
    assert.equal((response.json() as ErrorBody).error.code, item.code);
  }

  const unknownField = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload({ extra: true }),
  });
  assert.equal(
    (unknownField.json() as ErrorBody).error.details?.[0]?.path,
    '/extra',
  );

  let deep: Record<string, unknown> = {};
  for (let index = 0; index < 40; index += 1) {
    deep = { next: deep };
  }
  const tooDeep = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload({ graph: deep }),
  });
  assert.equal(tooDeep.statusCode, 422);
  assert.equal((tooDeep.json() as ErrorBody).error.code, 'graph_invalid');

  const unsafeKey = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    headers: { 'content-type': 'application/json' },
    payload:
      '{"levelId":"parcel-pulse","graph":{"__proto__":{"polluted":true}}}',
  });
  assert.equal(unsafeKey.statusCode, 422);
  assert.equal((unsafeKey.json() as ErrorBody).error.code, 'graph_invalid');

  const tooLarge = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload({
      graph: { items: Array.from({ length: 50_001 }, () => 0) },
    }),
  });
  assert.equal(tooLarge.statusCode, 422);
  assert.equal((tooLarge.json() as ErrorBody).error.code, 'graph_invalid');

  assert.equal(engine.evaluations, 0);
});

test('malformed, oversized and unsupported request bodies fail safely', async (t) => {
  const app = await makeApp(new FakeEngine());
  t.after(async () => {
    await app.close();
  });

  const trailing = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    headers: { 'content-type': 'application/json' },
    payload: '{"levelId":"parcel-pulse","graph":{}} trailing',
  });
  assert.equal(trailing.statusCode, 400);
  assert.equal((trailing.json() as ErrorBody).error.code, 'invalid_json');

  const unsupported = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    headers: { 'content-type': 'text/plain' },
    payload: '{}',
  });
  assert.equal(unsupported.statusCode, 415);
  assert.equal(
    (unsupported.json() as ErrorBody).error.code,
    'unsupported_media_type',
  );

  const oversized = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(
      basePayload({ graph: { blob: 'x'.repeat(1_048_576 + 1_024) } }),
    ),
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal((oversized.json() as ErrorBody).error.code, 'payload_too_large');
});

test('queue and registry limits return 429 without evicting active jobs', async (t) => {
  const first = deferred<unknown>();
  let call = 0;
  const queueLimited = await makeApp(
    new FakeEngine({
      evaluate: () => {
        call += 1;
        return call === 1 ? first.promise : Promise.resolve({ passed: true });
      },
    }),
    { maxConcurrent: 1, maxQueue: 0, maxRegistry: 2, closeDrainMs: 20 },
  );
  t.after(async () => {
    await queueLimited.close();
  });

  const running = await queueLimited.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  assert.equal(running.statusCode, 202);
  const runningJob = running.json() as JobSnapshot;
  assert.equal(runningJob.status, 'running');

  const queueFull = await queueLimited.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  assert.equal(queueFull.statusCode, 429);
  assert.equal((queueFull.json() as ErrorBody).error.code, 'job_queue_full');
  assert.equal(queueFull.headers['retry-after'], '1');

  first.resolve({ passed: true });
  await waitForStatus(queueLimited, runningJob.id, 'completed');

  const registryFirst = deferred<unknown>();
  const registryLimited = await makeApp(
    new FakeEngine({
      evaluate: () => registryFirst.promise,
    }),
    { maxConcurrent: 1, maxQueue: 1, maxRegistry: 2, closeDrainMs: 20 },
  );
  t.after(async () => {
    await registryLimited.close();
  });

  const active = await registryLimited.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  assert.equal(active.statusCode, 202);
  const queued = await registryLimited.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  assert.equal(queued.statusCode, 202);
  const registryFull = await registryLimited.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  assert.equal(registryFull.statusCode, 429);
  assert.equal(
    (registryFull.json() as ErrorBody).error.code,
    'job_registry_full',
  );

  registryFirst.resolve({ passed: true });
});

test('cancelling a queued job prevents it from ever starting', async (t) => {
  const first = deferred<unknown>();
  const engine = new FakeEngine({
    evaluate: () => first.promise,
  });
  const app = await makeApp(engine, {
    maxConcurrent: 1,
    maxQueue: 2,
    maxRegistry: 4,
    closeDrainMs: 20,
  });
  t.after(async () => {
    await app.close();
  });

  const firstResponse = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  const firstJob = firstResponse.json() as JobSnapshot;
  const secondResponse = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  const secondJob = secondResponse.json() as JobSnapshot;
  assert.equal(secondJob.status, 'queued');

  const cancelled = await app.inject({
    method: 'DELETE',
    url: `/v1/evaluations/${secondJob.id}`,
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal((cancelled.json() as JobSnapshot).status, 'cancelled');
  assert.equal((await getJob(app, secondJob.id)).result, null);
  assert.equal(engine.evaluations, 1);

  first.resolve({ passed: true });
  await waitForStatus(app, firstJob.id, 'completed');
  assert.equal((await getJob(app, secondJob.id)).status, 'cancelled');
  assert.equal(engine.evaluations, 1);
});

test('cancelling a running job aborts its signal and stays cancelled', async (t) => {
  const engine = new FakeEngine({
    evaluate: (_submission, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('aborted by cancellation')),
          { once: true },
        );
      }),
  });
  const app = await makeApp(engine, { closeDrainMs: 20 });
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  const created = response.json() as JobSnapshot;
  await waitForStatus(app, created.id, 'running');

  const cancelled = await app.inject({
    method: 'DELETE',
    url: `/v1/evaluations/${created.id}`,
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal((cancelled.json() as JobSnapshot).status, 'cancelled');
  assert.equal(engine.signals[0]?.aborted, true);

  await new Promise((resolve) => setTimeout(resolve, 30));
  const after = await getJob(app, created.id);
  assert.equal(after.status, 'cancelled');
  assert.equal(after.result, null);
  assert.equal(after.error, null);
});

test('late completion cannot overwrite cancellation', async (t) => {
  const late = deferred<unknown>();
  const engine = new FakeEngine({
    evaluate: () => late.promise,
  });
  const app = await makeApp(engine, { closeDrainMs: 20 });
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  const created = response.json() as JobSnapshot;
  await waitForStatus(app, created.id, 'running');

  await app.inject({
    method: 'DELETE',
    url: `/v1/evaluations/${created.id}`,
  });
  late.resolve({ status: 'ok', passed: true });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const after = await getJob(app, created.id);
  assert.equal(after.status, 'cancelled');
  assert.equal(after.result, null);
});

test('run timeout fails the job with a safe timeout error and aborts', async (t) => {
  const engine = new FakeEngine({
    evaluate: (_submission, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  });
  const app = await makeApp(engine, {
    runTimeoutMs: 30,
    closeDrainMs: 20,
  });
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  const created = response.json() as JobSnapshot;
  const failed = await waitForStatus(app, created.id, 'failed');
  assert.equal(failed.error?.code, 'evaluation_timeout');
  assert.equal(engine.signals[0]?.aborted, true);
});

test('terminal jobs expire after the TTL and active jobs do not', async (t) => {
  const app = await makeApp(new FakeEngine(), {
    jobTtlMs: 30,
    sweepIntervalMs: 10,
  });
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  const created = response.json() as JobSnapshot;
  await waitForStatus(app, created.id, 'completed');
  await waitFor(async () => {
    const lookup = await app.inject({
      method: 'GET',
      url: `/v1/evaluations/${created.id}`,
    });
    return lookup.statusCode === 404;
  }, 'terminal job expiry');
});

test('DELETE is idempotent for terminal jobs and keeps the result', async (t) => {
  const app = await makeApp(new FakeEngine());
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  const created = response.json() as JobSnapshot;
  await waitForStatus(app, created.id, 'completed');

  const first = await app.inject({
    method: 'DELETE',
    url: `/v1/evaluations/${created.id}`,
  });
  const second = await app.inject({
    method: 'DELETE',
    url: `/v1/evaluations/${created.id}`,
  });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal((first.json() as JobSnapshot).status, 'completed');
  assert.deepEqual((second.json() as JobSnapshot).result, {
    status: 'ok',
    passed: false,
  });
});

test('job params are validated and unknown jobs return 404', async (t) => {
  const app = await makeApp(new FakeEngine());
  t.after(async () => {
    await app.close();
  });

  const invalid = await app.inject({
    method: 'GET',
    url: '/v1/evaluations/bad',
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal((invalid.json() as ErrorBody).error.code, 'invalid_request');

  const missing = await app.inject({
    method: 'GET',
    url: '/v1/evaluations/unknown-job-000',
  });
  assert.equal(missing.statusCode, 404);
  assert.equal((missing.json() as ErrorBody).error.code, 'job_not_found');

  const missingDelete = await app.inject({
    method: 'DELETE',
    url: '/v1/evaluations/unknown-job-000',
  });
  assert.equal(missingDelete.statusCode, 404);
  assert.equal(
    (missingDelete.json() as ErrorBody).error.code,
    'job_not_found',
  );
});

test('close cancels active and queued jobs and resolves within the drain bound', async () => {
  const stuck = new FakeEngine({
    evaluate: () => new Promise(() => undefined),
  });
  const app = await makeApp(stuck, {
    maxConcurrent: 1,
    maxQueue: 2,
    maxRegistry: 4,
    closeDrainMs: 30,
  });

  const active = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  assert.equal(active.statusCode, 202);
  const queued = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  assert.equal(queued.statusCode, 202);

  const started = Date.now();
  await app.close();
  assert.ok(Date.now() - started < 1_000);
});

test('closing one app does not close another app', async (t) => {
  const first = await makeApp(new FakeEngine());
  const second = await makeApp(new FakeEngine());
  t.after(async () => {
    await second.close();
  });

  await first.close();
  const health = await second.inject({ method: 'GET', url: '/healthz' });
  assert.equal(health.statusCode, 200);
});

test('concurrent cancellation and completion do not overwrite each other', async (t) => {
  const pending = deferred<unknown>();
  let call = 0;
  const app = await makeApp(
    new FakeEngine({
      evaluate: () => {
        call += 1;
        return call === 1 ? pending.promise : Promise.resolve({ passed: true });
      },
    }),
    { maxConcurrent: 2, maxQueue: 2, maxRegistry: 4, closeDrainMs: 20 },
  );
  t.after(async () => {
    await app.close();
  });

  const firstResponse = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  const secondResponse = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: basePayload(),
  });
  const firstJob = firstResponse.json() as JobSnapshot;
  const secondJob = secondResponse.json() as JobSnapshot;

  const completed = await waitForStatus(app, secondJob.id, 'completed');
  const cancelled = await app.inject({
    method: 'DELETE',
    url: `/v1/evaluations/${firstJob.id}`,
  });
  assert.equal((cancelled.json() as JobSnapshot).status, 'cancelled');

  pending.resolve({ passed: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await getJob(app, firstJob.id)).status, 'cancelled');
  assert.equal((await getJob(app, firstJob.id)).result, null);
  assert.equal((await getJob(app, firstJob.id)).error, null);
  assert.deepEqual(completed.result, { passed: true });
});
