import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import {
  SCOREBOARD_CONTENT_VERSION,
  SCOREBOARD_LEVEL_ID,
  SCOREBOARD_MODEL_VERSION,
  SCOREBOARD_PRICING_VERSION,
  SCOREBOARD_SCHEMA_VERSION,
  evaluateScoreboard,
  type ScoreboardEvaluation,
} from '../../src/scoreboard/index.js';
import { createApp } from '../src/app.js';
import type { JobSnapshot } from '../src/contracts.js';
import { WorkerEngine } from '../src/engine/index.js';
import {
  isScoreboardEvaluationResult,
  type EngineResultBinding,
} from '../src/engine/result-validation.js';

function fixture(relative: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8'),
  ) as unknown;
}

const aggregate = fixture('fixtures/scoreboard/family-aggregate.json');
const smallScanFail = fixture('fixtures/scoreboard/fail-small-scan.json');

function bindingFor(result: ScoreboardEvaluation): EngineResultBinding {
  return {
    levelId: SCOREBOARD_LEVEL_ID,
    modelVersion: SCOREBOARD_MODEL_VERSION,
    schemaVersion: SCOREBOARD_SCHEMA_VERSION,
    contentVersion: SCOREBOARD_CONTENT_VERSION,
    pricingVersion: SCOREBOARD_PRICING_VERSION,
    seed: result.seed,
    graphDigest: result.graphDigest,
  };
}

test('Scoreboard result validation accepts real pass, fail and invalid results', () => {
  const pass = evaluateScoreboard(aggregate, { seed: 101 });
  assert.equal(pass.status, 'complete');
  assert.equal(pass.passed, true);
  assert.equal(isScoreboardEvaluationResult(pass, bindingFor(pass)), true);

  const fail = evaluateScoreboard(smallScanFail, { seed: 101 });
  assert.equal(fail.status, 'complete');
  assert.equal(fail.passed, false);
  assert.equal(isScoreboardEvaluationResult(fail, bindingFor(fail)), true);

  const invalid = evaluateScoreboard(
    fixture('fixtures/scoreboard/invalid-ambiguous.json'),
    { seed: 101 },
  );
  assert.equal(invalid.status, 'invalid');
  assert.equal(isScoreboardEvaluationResult(invalid, bindingFor(invalid)), true);
});

test('Scoreboard result validation rejects forged identity, gate and numeric evidence', () => {
  const pass = evaluateScoreboard(aggregate, { seed: 101 });
  const binding = bindingFor(pass);
  assert.equal(isScoreboardEvaluationResult(pass, binding), true);
  assert.ok(pass.operations !== null);
  assert.ok(pass.cost !== null);

  const cases: [string, unknown, EngineResultBinding][] = [
    [
      'wrong seed everywhere',
      {
        ...pass,
        seed: 102,
        identity: { ...pass.identity, seed: 102 },
      },
      binding,
    ],
    [
      'wrong graph digest',
      {
        ...pass,
        graphDigest: 'forged',
        identity: { ...pass.identity, graphDigest: 'forged' },
      },
      binding,
    ],
    ['wrong model version binding', pass, { ...binding, modelVersion: '9.9.9' }],
    ['wrong content version binding', pass, { ...binding, contentVersion: '9.9.9' }],
    ['wrong pricing version binding', pass, { ...binding, pricingVersion: 'v9' }],
    [
      'wrong schema version binding',
      pass,
      { ...binding, schemaVersion: (binding.schemaVersion ?? 1) + 1 },
    ],
    ['missing digest binding', pass, { ...binding, graphDigest: null }],
    ['failed pass flag', { ...pass, passed: false }, binding],
    [
      'failed gate hidden behind a pass',
      {
        ...pass,
        gates: pass.gates.map((gate, index) =>
          index === 0 ? { ...gate, passed: false } : gate,
        ),
      },
      binding,
    ],
    [
      'request conservation mismatch',
      {
        ...pass,
        operations: {
          ...pass.operations,
          read: {
            ...pass.operations.read,
            offered: pass.operations.read.offered + 1,
          },
        },
      },
      binding,
    ],
    [
      'negative request count',
      {
        ...pass,
        operations: {
          ...pass.operations,
          write: { ...pass.operations.write, failed: -1 },
        },
      },
      binding,
    ],
    [
      'NaN latency',
      {
        ...pass,
        operations: {
          ...pass.operations,
          read: {
            ...pass.operations.read,
            latency: { ...pass.operations.read.latency, p95Ms: Number.NaN },
          },
        },
      },
      binding,
    ],
    [
      'average above peak',
      {
        ...pass,
        nodes: pass.nodes.map((node, index) =>
          index === 0
            ? {
                ...node,
                cpu: {
                  ...node.cpu,
                  busyCoresAverage: node.cpu.busyCoresPeak + 1,
                },
              }
            : node,
        ),
      },
      binding,
    ],
    [
      'cost arithmetic mismatch',
      {
        ...pass,
        cost: { ...pass.cost, actualUsd: pass.cost.actualUsd + 1 },
      },
      binding,
    ],
    [
      'availability inconsistent with counts',
      {
        ...pass,
        operations: {
          ...pass.operations,
          read: { ...pass.operations.read, availability: 0.5 },
        },
      },
      binding,
    ],
    [
      'freshness valid flag contradicts stale reads',
      {
        ...pass,
        freshness: { ...pass.freshness, staleReads: 1 },
      },
      binding,
    ],
    [
      'incomplete status with no reason',
      {
        ...pass,
        status: 'incomplete',
        passed: false,
        incompleteReasons: [],
      },
      binding,
    ],
  ];

  for (const [label, value, candidate] of cases) {
    assert.equal(
      isScoreboardEvaluationResult(value, candidate),
      false,
      `expected rejection: ${label}`,
    );
  }
});

async function makeApp(engine: WorkerEngine): Promise<FastifyInstance> {
  return createApp({ engine, runTimeoutMs: 30_000 });
}

async function request(
  app: FastifyInstance,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: unknown }> {
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
    if (
      job.status === 'completed' ||
      job.status === 'failed' ||
      job.status === 'cancelled'
    ) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('job did not finish in time');
}

test('scoreboard discovery, catalog and real worker jobs', async (t) => {
  const engine = new WorkerEngine();
  const app = await makeApp(engine);
  t.after(async () => {
    await app.close();
    await engine.close();
  });

  const levels = await request(app, 'GET', '/v1/levels');
  assert.equal(levels.status, 200);
  const listed = (levels.body as { levels: { id: string }[] }).levels;
  assert.ok(listed.some((level) => level.id === SCOREBOARD_LEVEL_ID));

  const components = await request(
    app,
    'GET',
    `/v1/levels/${SCOREBOARD_LEVEL_ID}/components`,
  );
  assert.equal(components.status, 200);
  const catalog = components.body as {
    pricingVersion: string;
    catalog: { components: { sql: { sizes: { small: { hourlyUsd: number } } } } };
  };
  assert.equal(catalog.pricingVersion, 'scoreboard-catalog-v1');
  assert.equal(catalog.catalog.components.sql.sizes.small.hourlyUsd, 0.12);

  const schema = await request(
    app,
    'GET',
    `/v1/levels/${SCOREBOARD_LEVEL_ID}/schema`,
  );
  assert.equal(schema.status, 200);
  assert.equal(
    (schema.body as { properties: { levelId: { const: string } } }).properties
      .levelId.const,
    SCOREBOARD_LEVEL_ID,
  );

  const passCreated = await request(app, 'POST', '/v1/evaluations', {
    levelId: SCOREBOARD_LEVEL_ID,
    graph: aggregate,
    seed: 101,
  });
  assert.equal(passCreated.status, 202);
  const passJob = await waitForJob(
    app,
    (passCreated.body as { id: string }).id,
  );
  assert.equal(passJob.status, 'completed');
  const passResult = passJob.result as ScoreboardEvaluation;
  assert.equal(passResult.status, 'complete');
  assert.equal(passResult.passed, true);
  assert.equal(passResult.identity.seed, 101);
  assert.equal(passResult.identity.levelId, SCOREBOARD_LEVEL_ID);
  // The worker/API body must be byte-identical to the direct core result used
  // by the CLI for the same graph and seed.
  assert.equal(
    JSON.stringify(passResult),
    JSON.stringify(evaluateScoreboard(aggregate, { seed: 101 })),
  );

  const failCreated = await request(app, 'POST', '/v1/evaluations', {
    levelId: SCOREBOARD_LEVEL_ID,
    graph: smallScanFail,
    seed: 101,
  });
  assert.equal(failCreated.status, 202);
  const failJob = await waitForJob(
    app,
    (failCreated.body as { id: string }).id,
  );
  assert.equal(failJob.status, 'completed');
  const failResult = failJob.result as ScoreboardEvaluation;
  assert.equal(failResult.status, 'complete');
  assert.equal(failResult.passed, false);

  const invalidCreated = await request(app, 'POST', '/v1/evaluations', {
    levelId: SCOREBOARD_LEVEL_ID,
    graph: fixture('fixtures/scoreboard/invalid-missing-sql.json'),
    seed: 101,
  });
  assert.equal(invalidCreated.status, 202);
  const invalidJob = await waitForJob(
    app,
    (invalidCreated.body as { id: string }).id,
  );
  assert.equal(invalidJob.status, 'completed');
  const invalidResult = invalidJob.result as ScoreboardEvaluation;
  assert.equal(invalidResult.status, 'invalid');
  assert.equal(invalidResult.passed, false);
});
