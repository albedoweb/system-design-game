import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { FastifyInstance } from 'fastify';

import {
  PARCEL_LEVEL_ID,
  describeParcelLevel,
  evaluateParcel,
  parcelCatalogPayload,
  parcelGraphJsonSchema,
} from '../../src/parcel/index.js';
import { createApp } from '../src/app.js';
import {
  type CreateAppOptions,
  type JobSnapshot,
} from '../src/contracts.js';
import { WorkerEngine } from '../src/engine/index.js';

const starterGraph: unknown = JSON.parse(
  readFileSync(new URL('../../fixtures/parcel/starter.json', import.meta.url), 'utf8'),
);
const validStarterResult = evaluateParcel(starterGraph, { seed: 101 });
const sqlFamilyGraph: unknown = JSON.parse(
  readFileSync(
    new URL('../../fixtures/parcel/family-sql-indexed.json', import.meta.url),
    'utf8',
  ),
);

type AppOverrides = Omit<Partial<CreateAppOptions>, 'engine'>;

async function makeApp(
  engine: WorkerEngine,
  overrides: AppOverrides = {},
): Promise<FastifyInstance> {
  return createApp({ engine, maxConcurrent: 1, ...overrides });
}

interface ErrorBody {
  error: { code: string; message: string };
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  description: string,
  timeoutMs = 30_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
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

async function submit(
  app: FastifyInstance,
  graph: unknown,
  seed: number,
): Promise<JobSnapshot> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: { levelId: PARCEL_LEVEL_ID, graph, seed },
  });
  assert.equal(response.statusCode, 202);
  return response.json() as JobSnapshot;
}

function fixtureWorkerSource(): string {
  return [
    "import { readFileSync } from 'node:fs';",
    "import { parentPort, workerData } from 'node:worker_threads';",
    "const valid = JSON.parse(readFileSync(new URL('./valid-result.json', import.meta.url), 'utf8'));",
    'const seed = workerData.seed;',
    'const stats = { elapsedMs: 1, rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, heapSizeLimitBytes: 1, externalBytes: 1 };',
    'function send(result) {',
    "  parentPort.postMessage({ type: 'result', result, stats });",
    '}',
    'if (seed === 7) {',
    '  setTimeout(() => process.exit(7), 10);',
    '} else if (seed === 8) {',
    "  parentPort.postMessage({ type: 'error', error: { code: 'engine_failure', message: 'The simulation worker rejected the evaluation.' } });",
    '} else if (seed === 9) {',
    "  parentPort.postMessage({ type: 'not-a-real-message' });",
    '} else if (seed === 10) {',
    '  setInterval(() => {}, 1000);',
    '} else if (seed === 11) {',
    "  send({ status: 'ok', passed: true });",
    '} else if (seed === 12) {',
    '  const result = structuredClone(valid);',
    '  result.meta.seed = seed;',
    '  result.horizons = [result.horizons[0]];',
    '  send(result);',
    '} else if (seed === 13) {',
    '  const result = structuredClone(valid);',
    '  result.meta.seed = seed;',
    '  result.passed = true;',
    '  send(result);',
    '} else if (seed === 14) {',
    '  const result = structuredClone(valid);',
    '  result.meta.seed = seed;',
    '  delete result.cost;',
    '  send(result);',
    '} else if (seed === 15) {',
    '  send(structuredClone(valid));',
    '} else if (seed === 16) {',
    "  send(JSON.parse(readFileSync(new URL('./wrong-result.json', import.meta.url), 'utf8')));",
    '} else if (seed === 17) {',
    "  send(JSON.parse(readFileSync(new URL('./moved-result.json', import.meta.url), 'utf8')));",
    '} else {',
    '  const result = structuredClone(valid);',
    '  result.meta.seed = seed;',
    '  send(result);',
    '}',
    '',
  ].join('\n');
}

interface FixtureResults {
  readonly wrong?: unknown;
  readonly moved?: unknown;
}

function makeFixtureWorker(results: FixtureResults = {}): {
  dir: string;
  entry: URL;
} {
  const dir = mkdtempSync(join(tmpdir(), 'parcel-worker-'));
  const file = join(dir, 'fixture-worker.mjs');
  writeFileSync(file, fixtureWorkerSource(), 'utf8');
  writeFileSync(
    join(dir, 'valid-result.json'),
    JSON.stringify(validStarterResult),
    'utf8',
  );
  if (results.wrong !== undefined) {
    writeFileSync(
      join(dir, 'wrong-result.json'),
      JSON.stringify(results.wrong),
      'utf8',
    );
  }
  if (results.moved !== undefined) {
    writeFileSync(
      join(dir, 'moved-result.json'),
      JSON.stringify(results.moved),
      'utf8',
    );
  }
  return { dir, entry: pathToFileURL(file) };
}

test('real engine discovery returns authoritative level, catalog and schema', async (t) => {
  const engine = new WorkerEngine();
  const app = await makeApp(engine);
  t.after(async () => {
    await app.close();
    await engine.close();
  });

  const levels = await app.inject({ method: 'GET', url: '/v1/levels' });
  assert.equal(levels.statusCode, 200);
  const body = levels.json() as {
    levels: {
      id: string;
      title: string;
      description: string;
      defaultSeed: number;
      horizons: number[];
    }[];
  };
  assert.deepEqual(
    body.levels.map((level) => level.id),
    ['cold-cache', 'parcel-pulse', 'image-atlas', 'live-scoreboard', 'live-audience', 'global-cart'],
  );
  assert.deepEqual(
    body.levels.find((level) => level.id === 'parcel-pulse'),
    {
      id: 'parcel-pulse',
      title: 'Parcel Pulse',
      description:
        'Track 2 million parcels a day while status, history, ingest and warehouse reports share the same hardware. Build a durable design that survives year one and year five within budget.',
      defaultSeed: 101,
      horizons: [1, 5],
    },
  );
  assert.deepEqual(
    body.levels.find((level) => level.id === 'image-atlas')?.horizons,
    [],
  );

  const describe = await app.inject({ method: 'GET', url: '/v1/levels/parcel-pulse' });
  assert.equal(describe.statusCode, 200);
  assert.deepEqual(describe.json(), describeParcelLevel());

  const components = await app.inject({
    method: 'GET',
    url: '/v1/levels/parcel-pulse/components',
  });
  assert.equal(components.statusCode, 200);
  assert.deepEqual(components.json(), parcelCatalogPayload());

  const schema = await app.inject({
    method: 'GET',
    url: '/v1/levels/parcel-pulse/schema',
  });
  assert.equal(schema.statusCode, 200);
  assert.deepEqual(schema.json(), parcelGraphJsonSchema());

  const missing = await app.inject({
    method: 'GET',
    url: '/v1/levels/missing-level',
  });
  assert.equal(missing.statusCode, 404);
  assert.equal((missing.json() as ErrorBody).error.code, 'level_not_found');
  assert.equal(engine.stats.completedRuns, 0);
});

test('a failed starter evaluation completes the job with both mandatory horizons', async (t) => {
  const engine = new WorkerEngine();
  const app = await makeApp(engine);
  t.after(async () => {
    await app.close();
    await engine.close();
  });

  const created = await submit(app, starterGraph, 101);
  const finished = await waitForStatus(app, created.id, 'completed');
  assert.equal(finished.error, null);
  const result = finished.result as {
    status: string;
    passed: boolean;
    meta: { seed: number; levelId: string; requestedHorizons: number[]; requiredHorizons: number[] };
    horizons: { horizonYears: number; passed: boolean }[];
    checks: { id: string; passed: boolean }[];
  };
  assert.equal(result.status, 'ok');
  assert.equal(result.passed, false);
  assert.equal(result.meta.seed, 101);
  assert.equal(result.meta.levelId, PARCEL_LEVEL_ID);
  assert.deepEqual(result.meta.requestedHorizons, [1, 5]);
  assert.deepEqual(result.meta.requiredHorizons, [1, 5]);
  assert.deepEqual(
    result.horizons.map((horizon) => horizon.horizonYears),
    [1, 5],
  );
  assert.equal(
    result.checks.find((check) => check.id === 'horizons_complete')?.passed,
    true,
  );
  assert.equal(
    result.checks.find((check) => check.id === 'horizon_pass:1')?.passed,
    false,
  );
  assert.equal(
    result.checks.find((check) => check.id === 'horizon_pass:5')?.passed,
    false,
  );

  const startedAt = finished.startedAt === null ? 0 : Date.parse(finished.startedAt);
  const finishedAt = finished.finishedAt === null ? 0 : Date.parse(finished.finishedAt);
  t.diagnostic(`HTTP starter run: ${finishedAt - startedAt} ms`);
});

test('invalid graphs return completed invalid results and bad submissions are rejected before the queue', async (t) => {
  const engine = new WorkerEngine();
  const app = await makeApp(engine);
  t.after(async () => {
    await app.close();
    await engine.close();
  });

  const invalidGraph = await submit(
    app,
    { schemaVersion: 1, levelId: PARCEL_LEVEL_ID, nodes: [], edges: [] },
    101,
  );
  const invalidResult = await waitForStatus(app, invalidGraph.id, 'completed');
  assert.equal(invalidResult.error, null);
  const payload = invalidResult.result as {
    status: string;
    passed: boolean;
    horizons: unknown[];
    issues: { code: string; severity: string }[];
  };
  assert.equal(payload.status, 'invalid');
  assert.equal(payload.passed, false);
  assert.deepEqual(payload.horizons, []);
  assert.ok(payload.issues.some((issue) => issue.severity === 'error'));

  const patchedLevel = await submit(
    app,
    { ...(starterGraph as Record<string, unknown>), levelId: 'cold-cache' },
    101,
  );
  const patchedResult = await waitForStatus(app, patchedLevel.id, 'completed');
  assert.equal((patchedResult.result as { status: string }).status, 'invalid');

  const unparseable = await submit(app, { notAGraph: true }, 101);
  const unparseableResult = await waitForStatus(app, unparseable.id, 'completed');
  const parsePayload = unparseableResult.result as {
    status: string;
    meta: { graphDigest: string | null };
  };
  assert.equal(parsePayload.status, 'invalid');
  assert.equal(parsePayload.meta.graphDigest, null);

  const horizonSelection = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: {
      levelId: PARCEL_LEVEL_ID,
      graph: starterGraph,
      seed: 101,
      horizons: [1],
    },
  });
  assert.equal(horizonSelection.statusCode, 400);
  assert.equal((horizonSelection.json() as ErrorBody).error.code, 'invalid_request');

  const badSeed = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: { levelId: PARCEL_LEVEL_ID, graph: starterGraph, seed: 2_147_483_648 },
  });
  assert.equal(badSeed.statusCode, 400);
  assert.equal((badSeed.json() as ErrorBody).error.code, 'invalid_request');

  const unknownLevel = await app.inject({
    method: 'POST',
    url: '/v1/evaluations',
    payload: { levelId: 'missing-level', graph: starterGraph, seed: 101 },
  });
  assert.equal(unknownLevel.statusCode, 404);
  assert.equal((unknownLevel.json() as ErrorBody).error.code, 'level_not_found');

  assert.equal(engine.stats.completedRuns, 3);
});

test('health and discovery stay responsive while a real evaluation runs', async (t) => {
  const engine = new WorkerEngine();
  const app = await makeApp(engine);
  t.after(async () => {
    await app.close();
    await engine.close();
  });

  const created = await submit(app, starterGraph, 101);
  const running = await waitForStatus(app, created.id, 'running');
  assert.equal(running.status, 'running');

  const latencies: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const started = performance.now();
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    const levels = await app.inject({ method: 'GET', url: '/v1/levels' });
    latencies.push(performance.now() - started);
    assert.equal(health.statusCode, 200);
    assert.equal(levels.statusCode, 200);
    assert.equal(engine.stats.activeWorkers, 1);
  }
  const max = Math.max(...latencies);
  t.diagnostic(
    `health+levels during worker run: max ${max.toFixed(1)} ms, samples ${latencies
      .map((value) => value.toFixed(1))
      .join(', ')}`,
  );
  assert.ok(
    max < 500,
    `main thread must not be blocked by simulation (max ${max.toFixed(1)} ms)`,
  );

  await waitForStatus(app, created.id, 'completed');
});

test('queued and running jobs can be cancelled, then the slot is reused', async (t) => {
  const engine = new WorkerEngine();
  const app = await makeApp(engine, { maxConcurrent: 1 });
  t.after(async () => {
    await app.close();
    await engine.close();
  });

  const first = await submit(app, starterGraph, 101);
  await waitForStatus(app, first.id, 'running');
  const second = await submit(app, starterGraph, 202);
  const queued = await getJob(app, second.id);
  assert.equal(queued.status, 'queued');

  const cancelQueued = await app.inject({
    method: 'DELETE',
    url: `/v1/evaluations/${second.id}`,
  });
  assert.equal(cancelQueued.statusCode, 200);
  assert.equal((cancelQueued.json() as JobSnapshot).status, 'cancelled');

  const cancelRunning = await app.inject({
    method: 'DELETE',
    url: `/v1/evaluations/${first.id}`,
  });
  assert.equal(cancelRunning.statusCode, 200);
  const cancelled = cancelRunning.json() as JobSnapshot;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.result, null);
  assert.equal(cancelled.error, null);

  await waitFor(() => engine.stats.activeWorkers === 0, 'worker termination');
  assert.equal(engine.stats.activeWorkers, 0);

  const third = await submit(app, starterGraph, 303);
  const finished = await waitForStatus(app, third.id, 'completed');
  assert.equal(finished.status, 'completed');
  assert.equal((finished.result as { meta: { seed: number } }).meta.seed, 303);
  t.diagnostic(`reused concurrency slot after cancellation; active workers ${engine.stats.activeWorkers}`);
});

test('two independent jobs run in parallel workers', async (t) => {
  const runs: { elapsedMs: number; rssBytes: number; heapSizeLimitBytes: number }[] = [];
  const engine = new WorkerEngine({
    onRunStats: (stats) => {
      runs.push({
        elapsedMs: stats.elapsedMs,
        rssBytes: stats.rssBytes,
        heapSizeLimitBytes: stats.heapSizeLimitBytes,
      });
    },
  });
  const app = await makeApp(engine, { maxConcurrent: 2 });
  t.after(async () => {
    await app.close();
    await engine.close();
  });

  const first = await submit(app, starterGraph, 101);
  const second = await submit(app, starterGraph, 202);
  const [a, b] = await Promise.all([
    waitForStatus(app, first.id, 'completed'),
    waitForStatus(app, second.id, 'completed'),
  ]);
  assert.equal((a.result as { meta: { seed: number } }).meta.seed, 101);
  assert.equal((b.result as { meta: { seed: number } }).meta.seed, 202);
  assert.equal(engine.stats.peakWorkers, 2);
  assert.equal(runs.length, 2);
  for (const run of runs) {
    assert.ok(run.elapsedMs > 0);
    assert.ok(run.rssBytes > 0);
    assert.ok(run.heapSizeLimitBytes >= 512 * 1024 * 1024);
  }
  t.diagnostic(
    `two workers: peak ${engine.stats.peakWorkers}, rss ${runs
      .map((run) => `${(run.rssBytes / 1048576).toFixed(0)} MiB`)
      .join(' / ')}, heap limit ${((runs[0]?.heapSizeLimitBytes ?? 0) / 1048576).toFixed(0)} MiB`,
  );
});

test('worker crash, rejection, invalid message and timeout fail safely while HTTP survives', async (t) => {
  const fixture = makeFixtureWorker();
  const engine = new WorkerEngine({ workerEntry: fixture.entry });
  const app = await makeApp(engine, { runTimeoutMs: 300 });
  t.after(async () => {
    await app.close();
    await engine.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  async function failFor(seed: number): Promise<JobSnapshot> {
    const created = await submit(app, starterGraph, seed);
    return waitForStatus(app, created.id, 'failed');
  }

  const crash = await failFor(7);
  assert.equal(crash.error?.code, 'engine_failure');

  const healthAfterCrash = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(healthAfterCrash.statusCode, 200);

  const rejection = await failFor(8);
  assert.equal(rejection.error?.code, 'engine_failure');
  assert.equal(
    rejection.error?.message,
    'The simulation worker rejected the evaluation.',
  );

  const healthAfterRejection = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(healthAfterRejection.statusCode, 200);

  const invalidMessage = await failFor(9);
  assert.equal(invalidMessage.error?.code, 'engine_failure');

  const healthAfterInvalid = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(healthAfterInvalid.statusCode, 200);

  const timeout = await failFor(10);
  assert.equal(timeout.error?.code, 'evaluation_timeout');
  await waitFor(() => engine.stats.activeWorkers === 0, 'timed-out worker exit');

  const healthAfterTimeout = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(healthAfterTimeout.statusCode, 200);

  const recovered = await submit(app, starterGraph, 101);
  const completed = await waitForStatus(app, recovered.id, 'completed');
  assert.equal(completed.status, 'completed');
  assert.equal((completed.result as { status: string }).status, 'ok');
});

test('malformed or false-passing worker results are rejected as safe failures', async (t) => {
  const fixture = makeFixtureWorker();
  const engine = new WorkerEngine({ workerEntry: fixture.entry });
  const app = await makeApp(engine, { runTimeoutMs: 5_000 });
  t.after(async () => {
    await app.close();
    await engine.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  const cases: { seed: number; label: string }[] = [
    { seed: 11, label: 'minimal passing object' },
    { seed: 12, label: 'single horizon' },
    { seed: 13, label: 'false top-level pass' },
    { seed: 14, label: 'missing cost' },
    { seed: 15, label: 'result for a different seed' },
  ];

  for (const item of cases) {
    const created = await submit(app, starterGraph, item.seed);
    const failed = await waitForStatus(app, created.id, 'failed');
    assert.equal(failed.error?.code, 'engine_failure', item.label);
    assert.match(
      failed.error?.message ?? '',
      /invalid message|different request/,
      item.label,
    );
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.statusCode, 200, item.label);
    await waitFor(
      () => engine.stats.liveWorkers === 0,
      `${item.label} worker exit`,
    );
  }

  const valid = await submit(app, starterGraph, 101);
  const completed = await waitForStatus(app, valid.id, 'completed');
  assert.equal(completed.status, 'completed');
  assert.equal((completed.result as { status: string }).status, 'ok');
});

test('rapid cancellation and replacement never exceeds the worker bound', { timeout: 60_000 }, async (t) => {
  const started: (() => void)[] = [];
  const nextTermination = (): Promise<void> =>
    new Promise((resolve) => {
      started.push(resolve);
    });
  const engine = new WorkerEngine({
    terminateWorker: async (worker) => {
      const code = await worker.terminate();
      started.shift()?.();
      // Keep the termination promise pending while the replacement attempts
      // to enter the queue. The adapter must hold its slot until this resolves.
      await new Promise((resolve) => setTimeout(resolve, 120));
      return code;
    },
  });
  const app = await makeApp(engine, { maxConcurrent: 1 });
  t.after(async () => {
    await app.close();
    await engine.close();
  });

  let peakObserved = 0;
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const running = await submit(app, starterGraph, 100 + cycle);
    await waitForStatus(app, running.id, 'running');

    const termination = nextTermination();
    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/v1/evaluations/${running.id}`,
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal((cancelled.json() as JobSnapshot).status, 'cancelled');
    await termination;

    const replacement = await submit(app, starterGraph, 200 + cycle);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const queued = await getJob(app, replacement.id);
    peakObserved = Math.max(peakObserved, engine.stats.liveWorkers);
    assert.equal(
      queued.status,
      'queued',
      `cycle ${cycle}: replacement started before termination settled`,
    );
    assert.ok(
      engine.stats.liveWorkers <= 1,
      `cycle ${cycle}: live workers ${engine.stats.liveWorkers} exceeded 1`,
    );

    const completed = await waitForStatus(app, replacement.id, 'completed');
    assert.equal(completed.status, 'completed');
    peakObserved = Math.max(peakObserved, engine.stats.peakWorkers);
  }

  assert.ok(
    peakObserved <= 1,
    `peak live workers ${peakObserved} exceeded the concurrency bound`,
  );
  assert.ok(engine.stats.peakWorkers <= 1);
  assert.equal(engine.stats.liveWorkers, 0);
  t.diagnostic(`rapid cancellation: peak live workers ${engine.stats.peakWorkers}`);
});

test('replacement after a timeout also waits for worker termination', { timeout: 30_000 }, async (t) => {
  const fixture = makeFixtureWorker();
  let signalStart: (() => void) | null = null;
  const terminationStarted = new Promise<void>((resolve) => {
    signalStart = resolve;
  });
  const engine = new WorkerEngine({
    workerEntry: fixture.entry,
    terminateWorker: async (worker) => {
      const code = await worker.terminate();
      signalStart?.();
      await new Promise((resolve) => setTimeout(resolve, 120));
      return code;
    },
  });
  const app = await makeApp(engine, { maxConcurrent: 1, runTimeoutMs: 1_500 });
  t.after(async () => {
    await app.close();
    await engine.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  const timedOut = await submit(app, starterGraph, 10);
  const failed = await waitForStatus(app, timedOut.id, 'failed');
  assert.equal(failed.error?.code, 'evaluation_timeout');
  await terminationStarted;

  const replacement = await submit(app, starterGraph, 101);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal((await getJob(app, replacement.id)).status, 'queued');
  assert.ok(engine.stats.liveWorkers <= 1);

  const completed = await waitForStatus(app, replacement.id, 'completed');
  assert.equal(completed.status, 'completed');
  assert.ok(engine.stats.peakWorkers <= 1);
  assert.equal(engine.stats.liveWorkers, 0);
});

test('worker result must match the submitted semantic graph digest', async (t) => {
  const moved = JSON.parse(JSON.stringify(starterGraph)) as {
    name?: string;
    nodes: { label: string; position: { x: number; y: number } }[];
  };
  moved.name = 'Moved starter';
  for (const node of moved.nodes) {
    node.position.x += 500;
    node.position.y += 40;
    node.label = `${node.label} moved`;
  }
  const movedResult = evaluateParcel(moved, { seed: 17 });
  assert.equal(
    movedResult.meta.graphDigest,
    validStarterResult.meta.graphDigest,
    'positions and labels must not change the semantic digest',
  );
  const wrongResult = evaluateParcel(sqlFamilyGraph, { seed: 16 });
  assert.equal(wrongResult.passed, true);
  assert.notEqual(
    wrongResult.meta.graphDigest,
    validStarterResult.meta.graphDigest,
  );

  const fixture = makeFixtureWorker({ wrong: wrongResult, moved: movedResult });
  const engine = new WorkerEngine({ workerEntry: fixture.entry });
  const app = await makeApp(engine, { runTimeoutMs: 5_000 });
  t.after(async () => {
    await app.close();
    await engine.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  const wrong = await submit(app, starterGraph, 16);
  const rejected = await waitForStatus(app, wrong.id, 'failed');
  assert.equal(rejected.error?.code, 'engine_failure');
  assert.match(rejected.error?.message ?? '', /different request/);
  assert.equal(
    (await app.inject({ method: 'GET', url: '/healthz' })).statusCode,
    200,
  );

  const layoutOnly = await submit(app, starterGraph, 17);
  const accepted = await waitForStatus(app, layoutOnly.id, 'completed');
  assert.equal(accepted.status, 'completed');
  const result = accepted.result as {
    status: string;
    passed: boolean;
    meta: { graphDigest: string };
  };
  assert.equal(result.status, 'ok');
  assert.equal(result.passed, false);
  assert.equal(result.meta.graphDigest, validStarterResult.meta.graphDigest);
});

test('app shutdown aborts a running evaluation and leaves no workers', async (t) => {
  const engine = new WorkerEngine();
  const app = await makeApp(engine, { closeDrainMs: 2_000 });
  t.after(async () => {
    await engine.close();
  });

  const created = await submit(app, starterGraph, 101);
  await waitForStatus(app, created.id, 'running');
  assert.equal(engine.stats.activeWorkers, 1);
  await app.close();
  await engine.close();
  assert.equal(engine.stats.activeWorkers, 0);
  assert.equal(engine.stats.terminatingWorkers, 0);
});
