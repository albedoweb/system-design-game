import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import type {
  CreateAppOptions,
  Engine,
  EvaluationSubmission,
  LevelSummary,
} from '../src/contracts.js';

const LEVEL: LevelSummary = {
  id: 'parcel-pulse',
  title: 'Parcel Pulse',
  description: 'Track parcels across storage families.',
  defaultSeed: 101,
  horizons: [1, 5],
};

interface FakeOptions {
  readonly levels?: () => Promise<readonly LevelSummary[]>;
  readonly describe?: (levelId: string) => Promise<unknown>;
  readonly components?: (levelId: string) => Promise<unknown>;
  readonly schema?: (levelId: string) => Promise<unknown>;
  readonly evaluate?: (
    submission: EvaluationSubmission,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

class FakeEngine implements Engine {
  levelsCalls = 0;
  describeCalls = 0;
  componentsCalls = 0;
  schemaCalls = 0;
  readonly described: string[] = [];

  private readonly options: FakeOptions;

  constructor(options: FakeOptions = {}) {
    this.options = options;
  }

  levels(): Promise<readonly LevelSummary[]> {
    this.levelsCalls += 1;
    return this.options.levels?.() ?? Promise.resolve([LEVEL]);
  }

  describe(levelId: string): Promise<unknown> {
    this.describeCalls += 1;
    this.described.push(levelId);
    return (
      this.options.describe?.(levelId) ??
      Promise.resolve({ id: levelId, title: LEVEL.title, slo: { status: 150 } })
    );
  }

  components(levelId: string): Promise<unknown> {
    this.componentsCalls += 1;
    return (
      this.options.components?.(levelId) ??
      Promise.resolve({ levelId, components: ['client', 'app', 'sql'] })
    );
  }

  schema(levelId: string): Promise<unknown> {
    this.schemaCalls += 1;
    return (
      this.options.schema?.(levelId) ??
      Promise.resolve({ levelId, type: 'object' })
    );
  }

  evaluate(
    submission: EvaluationSubmission,
    signal: AbortSignal,
  ): Promise<unknown> {
    return (
      this.options.evaluate?.(submission, signal) ??
      Promise.resolve({ status: 'ok', passed: false })
    );
  }
}

type AppOverrides = Omit<Partial<CreateAppOptions>, 'engine'>;

async function makeApp(
  engine: FakeEngine,
  overrides: AppOverrides = {},
): Promise<FastifyInstance> {
  return createApp({ engine, ...overrides });
}

interface LevelsBody {
  levels: LevelSummary[];
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: { path: string; message: string }[];
  };
}

test('healthz reports readiness from the explicit probe', async (t) => {
  const readyApp = await makeApp(new FakeEngine());
  t.after(async () => {
    await readyApp.close();
  });
  const ready = await readyApp.inject({ method: 'GET', url: '/healthz' });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { status: 'ok', ready: true });

  const notReadyApp = await makeApp(new FakeEngine(), { isReady: () => false });
  t.after(async () => {
    await notReadyApp.close();
  });
  const notReady = await notReadyApp.inject({ method: 'GET', url: '/healthz' });
  assert.equal(notReady.statusCode, 503);
  assert.deepEqual(notReady.json(), { status: 'unavailable', ready: false });

  const throwingApp = await makeApp(new FakeEngine(), {
    isReady: () => {
      throw new Error('probe exploded');
    },
  });
  t.after(async () => {
    await throwingApp.close();
  });
  const throwing = await throwingApp.inject({
    method: 'GET',
    url: '/healthz',
  });
  assert.equal(throwing.statusCode, 503);
  assert.equal((throwing.json() as { ready: boolean }).ready, false);
});

test('levels discovery comes from the engine and is cached per app', async (t) => {
  const engine = new FakeEngine();
  const app = await makeApp(engine);
  t.after(async () => {
    await app.close();
  });

  const first = await app.inject({ method: 'GET', url: '/v1/levels' });
  const second = await app.inject({ method: 'GET', url: '/v1/levels' });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual((first.json() as LevelsBody).levels, [LEVEL]);
  assert.equal(engine.levelsCalls, 1);
});

test('describe, components and schema are cached and unknown levels are consistent', async (t) => {
  const engine = new FakeEngine();
  const app = await makeApp(engine);
  t.after(async () => {
    await app.close();
  });

  const describe1 = await app.inject({
    method: 'GET',
    url: '/v1/levels/parcel-pulse',
  });
  const describe2 = await app.inject({
    method: 'GET',
    url: '/v1/levels/parcel-pulse',
  });
  assert.equal(describe1.statusCode, 200);
  assert.equal(describe2.statusCode, 200);
  assert.equal((describe1.json() as { id: string }).id, 'parcel-pulse');
  assert.equal(engine.describeCalls, 1);

  const components = await app.inject({
    method: 'GET',
    url: '/v1/levels/parcel-pulse/components',
  });
  const componentsAgain = await app.inject({
    method: 'GET',
    url: '/v1/levels/parcel-pulse/components',
  });
  assert.equal(components.statusCode, 200);
  assert.equal(componentsAgain.statusCode, 200);
  assert.equal(engine.componentsCalls, 1);

  const schema = await app.inject({
    method: 'GET',
    url: '/v1/levels/parcel-pulse/schema',
  });
  assert.equal(schema.statusCode, 200);
  assert.equal(
    (schema.json() as { levelId: string }).levelId,
    'parcel-pulse',
  );

  for (const path of [
    '/v1/levels/missing-level',
    '/v1/levels/missing-level/components',
    '/v1/levels/missing-level/schema',
  ]) {
    const response = await app.inject({ method: 'GET', url: path });
    assert.equal(response.statusCode, 404);
    assert.equal((response.json() as ErrorBody).error.code, 'level_not_found');
  }
  assert.equal(engine.describeCalls, 1);

  const invalid = await app.inject({
    method: 'GET',
    url: '/v1/levels/Bad_ID!',
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal((invalid.json() as ErrorBody).error.code, 'invalid_request');
});

test('unknown routes and discovery engine failures use safe envelopes', async (t) => {
  const app = await makeApp(new FakeEngine());
  t.after(async () => {
    await app.close();
  });

  const unknown = await app.inject({ method: 'GET', url: '/does-not-exist' });
  assert.equal(unknown.statusCode, 404);
  assert.equal((unknown.json() as ErrorBody).error.code, 'route_not_found');

  const broken = await makeApp(
    new FakeEngine({
      levels: () => Promise.reject(new Error('worker stack secret')),
    }),
  );
  t.after(async () => {
    await broken.close();
  });
  const unavailable = await broken.inject({ method: 'GET', url: '/v1/levels' });
  assert.equal(unavailable.statusCode, 503);
  const body = unavailable.json() as ErrorBody;
  assert.equal(body.error.code, 'engine_unavailable');
  assert.equal(JSON.stringify(body).includes('secret'), false);

  const syncBroken = await makeApp(
    new FakeEngine({
      levels: () => {
        throw new Error('sync worker secret');
      },
    }),
  );
  t.after(async () => {
    await syncBroken.close();
  });
  const syncUnavailable = await syncBroken.inject({
    method: 'GET',
    url: '/v1/levels',
  });
  assert.equal(syncUnavailable.statusCode, 503);
  assert.equal(
    (syncUnavailable.json() as ErrorBody).error.code,
    'engine_unavailable',
  );
  assert.equal(JSON.stringify(syncUnavailable.json()).includes('secret'), false);

  const invalidMetadata = await makeApp(
    new FakeEngine({
      levels: () =>
        Promise.resolve([
          { ...LEVEL, id: 'Not Valid!' },
        ] as unknown as readonly LevelSummary[]),
    }),
  );
  t.after(async () => {
    await invalidMetadata.close();
  });
  const contract = await invalidMetadata.inject({
    method: 'GET',
    url: '/v1/levels',
  });
  assert.equal(contract.statusCode, 503);
  assert.equal((contract.json() as ErrorBody).error.code, 'engine_contract');
});

test('CORS is disabled by default and exact-origin only when configured', async (t) => {
  const plain = await makeApp(new FakeEngine());
  t.after(async () => {
    await plain.close();
  });
  const plainGet = await plain.inject({
    method: 'GET',
    url: '/v1/levels',
    headers: { origin: 'http://127.0.0.1:5178' },
  });
  assert.equal(plainGet.headers['access-control-allow-origin'], undefined);
  const plainOptions = await plain.inject({
    method: 'OPTIONS',
    url: '/v1/levels',
    headers: { origin: 'http://127.0.0.1:5178' },
  });
  assert.equal(plainOptions.statusCode, 404);

  const cors = await makeApp(new FakeEngine(), {
    corsOrigin: 'http://127.0.0.1:5178',
  });
  t.after(async () => {
    await cors.close();
  });

  const allowed = await cors.inject({
    method: 'GET',
    url: '/v1/levels',
    headers: { origin: 'http://127.0.0.1:5178' },
  });
  assert.equal(
    allowed.headers['access-control-allow-origin'],
    'http://127.0.0.1:5178',
  );
  assert.equal(allowed.headers.vary, 'Origin');

  const preflight = await cors.inject({
    method: 'OPTIONS',
    url: '/v1/levels',
    headers: { origin: 'http://127.0.0.1:5178' },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(
    preflight.headers['access-control-allow-methods'],
    'GET,POST,DELETE,OPTIONS',
  );

  const rejected = await cors.inject({
    method: 'GET',
    url: '/v1/levels',
    headers: { origin: 'http://evil.example' },
  });
  assert.equal(rejected.headers['access-control-allow-origin'], undefined);
  const rejectedPreflight = await cors.inject({
    method: 'OPTIONS',
    url: '/v1/levels',
    headers: { origin: 'http://evil.example' },
  });
  assert.equal(rejectedPreflight.statusCode, 404);
});

test('createApp validates bounded options and the engine shape', async () => {
  const engine = new FakeEngine();
  await assert.rejects(
    () => createApp({ engine, maxConcurrent: 3 }),
    /maxConcurrent must be an integer between 1 and 2/,
  );
  await assert.rejects(
    () => createApp({ engine, maxConcurrent: 2, maxQueue: 16, maxRegistry: 17 }),
    /maxRegistry must be at least maxConcurrent \+ maxQueue/,
  );
  await assert.rejects(
    () => createApp({ engine, bodyLimit: 1_048_577 }),
    /bodyLimit must be an integer between 1024 and 1048576/,
  );
  await assert.rejects(
    () => createApp({ engine, corsOrigin: 'http://127.0.0.1:5178/path' }),
    /corsOrigin must be an exact origin/,
  );
  await assert.rejects(
    () => createApp({ engine: {} as Engine }),
    /engine\.levels must be a function/,
  );
  await assert.rejects(
    () => createApp({ engine, now: 1 as unknown as () => number }),
    /now must be a function/,
  );
});
