import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import type { JobSnapshot } from '../src/contracts.js';
import { WorkerEngine } from '../src/engine/index.js';
import { createEngineRegistry } from '../../src/simulation/registry.js';

const coldPass = JSON.parse(
  readFileSync(
    new URL('../../tests/calibration/cheap-pass.json', import.meta.url),
    'utf8',
  ),
) as { graph: unknown };

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

async function makeApp(engine: WorkerEngine): Promise<FastifyInstance> {
  return createApp({ engine, runTimeoutMs: 30_000 });
}

async function request(
  app: FastifyInstance,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<JsonResponse> {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined
      ? {}
      : { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.json() };
}

async function waitForJob(
  app: FastifyInstance,
  id: string,
): Promise<JobSnapshot> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await request(app, 'GET', `/v1/evaluations/${id}`);
    const job = response.body as JobSnapshot;
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('job did not finish in time');
}

test('Cold Cache and Image Atlas are discoverable with their own schemas', async (t) => {
  const engine = new WorkerEngine();
  const app = await makeApp(engine);
  t.after(async () => {
    await app.close();
    await engine.close();
  });

  const coldDescribe = await request(app, 'GET', '/v1/levels/cold-cache');
  assert.equal(coldDescribe.status, 200);
  assert.equal(
    (coldDescribe.body as { level: { id: string } }).level.id,
    'cold-cache',
  );

  const coldSchema = await request(app, 'GET', '/v1/levels/cold-cache/schema');
  assert.equal(coldSchema.status, 200);
  const coldGraph = coldSchema.body as {
    properties: { levelId: { const: string } };
  };
  assert.equal(coldGraph.properties.levelId.const, 'cold-cache');

  const imageDescribe = await request(app, 'GET', '/v1/levels/image-atlas');
  assert.equal(imageDescribe.status, 200);
  assert.equal(
    (imageDescribe.body as { level: { id: string } }).level.id,
    'image-atlas',
  );

  const imageSchema = await request(app, 'GET', '/v1/levels/image-atlas/schema');
  assert.equal(imageSchema.status, 200);
  const imageGraph = imageSchema.body as {
    properties: { levelId: { const: string } };
  };
  assert.equal(imageGraph.properties.levelId.const, 'image-atlas');
});

test('a real Cold Cache API job returns the untouched engine result in an envelope', async (t) => {
  const engine = new WorkerEngine();
  const app = await makeApp(engine);
  t.after(async () => {
    await app.close();
    await engine.close();
  });

  const created = await request(app, 'POST', '/v1/evaluations', {
    levelId: 'cold-cache',
    graph: coldPass.graph,
    seed: 101,
  });
  assert.equal(created.status, 202);
  const id = (created.body as { id: string }).id;
  const job = await waitForJob(app, id);
  assert.equal(job.status, 'completed');
  const result = job.result as {
    status: string;
    passed: boolean;
    meta: { levelId: string; seed: number; graphDigest: string | null };
    result: { seed: number; passed: boolean; checks: { passed: boolean }[] };
  };
  assert.equal(result.status, 'ok');
  assert.equal(result.passed, true);
  assert.equal(result.meta.levelId, 'cold-cache');
  assert.equal(result.meta.seed, 101);
  assert.match(result.meta.graphDigest ?? '', /^[0-9a-f]{16}$/);
  assert.equal(result.result.seed, 101);
  assert.equal(result.result.passed, true);
  assert.ok(result.result.checks.every((check) => check.passed));

  const direct = createEngineRegistry().evaluate({
    levelId: 'cold-cache',
    graph: coldPass.graph,
    seed: 101,
  });
  assert.deepEqual(job.result, direct.result);
  assert.equal(engine.stats.completedRuns, 1);
});

test('an invalid Cold Cache graph is a completed structured invalid result', async (t) => {
  const engine = new WorkerEngine();
  const app = await makeApp(engine);
  t.after(async () => {
    await app.close();
    await engine.close();
  });

  const created = await request(app, 'POST', '/v1/evaluations', {
    levelId: 'cold-cache',
    graph: { schemaVersion: 1, levelId: 'cold-cache', nodes: [], edges: [] },
    seed: 101,
  });
  assert.equal(created.status, 202);
  const job = await waitForJob(app, (created.body as { id: string }).id);
  assert.equal(job.status, 'completed');
  const result = job.result as {
    status: string;
    passed: boolean;
    result: unknown;
    issues: { severity: string }[];
  };
  assert.equal(result.status, 'invalid');
  assert.equal(result.passed, false);
  assert.equal(result.result, null);
  assert.ok(result.issues.some((issue) => issue.severity === 'error'));
});
