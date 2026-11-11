import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  PARCEL_LEVEL,
  PARCEL_LEVEL_ID,
  describeParcelLevel,
  evaluateParcel,
  parcelCatalogPayload,
  parcelGraphJsonSchema,
} from '../../src/parcel/index.js';
import { EngineError } from '../src/contracts.js';
import { WorkerEngine, type WorkerProgress } from '../src/engine/index.js';
import { resourceLimitsForLevel } from '../src/engine/worker-engine.js';
import { isParcelEvaluationResult } from '../src/engine/result-validation.js';

const starterGraph: unknown = JSON.parse(
  readFileSync(new URL('../../fixtures/parcel/starter.json', import.meta.url), 'utf8'),
);
const passingGraph: unknown = JSON.parse(
  readFileSync(
    new URL('../../fixtures/parcel/family-sql-indexed.json', import.meta.url),
    'utf8',
  ),
);

function graphForFamily(
  family: 'kv' | 'columnar',
): Record<string, unknown> {
  const client = {
    id: 'client-1',
    kind: 'client',
    label: 'Client',
    position: { x: 0, y: 160 },
    config: { size: 'small' },
  };
  const app = {
    id: 'app-1',
    kind: 'app',
    label: 'Application',
    position: { x: 240, y: 160 },
    config: { size: 'medium' },
  };
  const edges = [
    { id: 'edge-traffic', source: 'client-1', target: 'app-1', operation: 'traffic' },
  ];
  if (family === 'kv') {
    return {
      schemaVersion: 1,
      levelId: PARCEL_LEVEL_ID,
      name: 'KV family',
      nodes: [
        client,
        app,
        {
          id: 'kv-1',
          kind: 'kv',
          label: 'KV store',
          position: { x: 520, y: 160 },
          config: {
            size: 'large',
            storageTb: 64,
            partition: 'month',
            latestStatus: true,
            rollups: true,
            retentionYears: 5,
            compression: 'lz4',
          },
        },
      ],
      edges: [
        ...edges,
        { id: 'edge-ingest', source: 'app-1', target: 'kv-1', operation: 'ingest' },
        { id: 'edge-status', source: 'app-1', target: 'kv-1', operation: 'status' },
        { id: 'edge-history', source: 'app-1', target: 'kv-1', operation: 'history' },
        { id: 'edge-report', source: 'app-1', target: 'kv-1', operation: 'report' },
      ],
    };
  }
  return {
    schemaVersion: 1,
    levelId: PARCEL_LEVEL_ID,
    name: 'Columnar family',
    nodes: [
      client,
      app,
      {
        id: 'sql-1',
        kind: 'sql',
        label: 'Durable primary',
        position: { x: 480, y: 60 },
        config: {
          size: 'large',
          storageTb: 32,
          index: 'parcel',
          partition: 'none',
          latestStatus: true,
          rollups: false,
          retentionYears: 5,
          compression: 'lz4',
        },
      },
      {
        id: 'columnar-1',
        kind: 'columnar',
        label: 'Warehouse projection',
        position: { x: 760, y: 260 },
        config: {
          size: 'large',
          storageTb: 64,
          partition: 'month',
          rollups: true,
          retentionYears: 5,
          batchIntervalMs: 0,
          compression: 'zstd',
          columnProjection: true,
        },
      },
    ],
    edges: [
      ...edges,
      { id: 'edge-ingest', source: 'app-1', target: 'sql-1', operation: 'ingest' },
      { id: 'edge-status', source: 'app-1', target: 'sql-1', operation: 'status' },
      { id: 'edge-history', source: 'app-1', target: 'columnar-1', operation: 'history' },
      { id: 'edge-report', source: 'app-1', target: 'columnar-1', operation: 'report' },
      { id: 'edge-replicate', source: 'sql-1', target: 'columnar-1', operation: 'replicate' },
    ],
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function assertEngineError(
  expectedCode: string,
): (error: unknown) => true {
  return (error: unknown) => {
    assert.ok(error instanceof EngineError, 'expected an EngineError');
    assert.equal(error.code, expectedCode);
    return true;
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('worker resource limits keep legacy defaults and cap Live Audience', () => {
  const legacy = {
    maxOldGenerationSizeMb: 512,
    maxYoungGenerationSizeMb: 64,
    stackSizeMb: 4,
  };
  for (const levelId of [
    'cold-cache',
    'parcel-pulse',
    'image-atlas',
    'live-scoreboard',
  ]) {
    assert.deepEqual(
      resourceLimitsForLevel(levelId),
      legacy,
      `${levelId} must keep the existing budget`,
    );
  }
  assert.deepEqual(resourceLimitsForLevel('live-audience'), {
    maxOldGenerationSizeMb: 192,
    maxYoungGenerationSizeMb: 16,
    stackSizeMb: 4,
  });
});

test('Live Audience cannot raise the strict cap from a larger default', () => {
  assert.deepEqual(
    resourceLimitsForLevel('live-audience', {
      maxOldGenerationSizeMb: 512,
      maxYoungGenerationSizeMb: 64,
      stackSizeMb: 8,
    }),
    {
      maxOldGenerationSizeMb: 192,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
    },
  );
  assert.deepEqual(
    resourceLimitsForLevel('live-audience', { maxOldGenerationSizeMb: 256 }),
    {
      maxOldGenerationSizeMb: 192,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
    },
  );
});

test('Live Audience preserves provided ResourceLimits fields outside the cap', () => {
  assert.deepEqual(
    resourceLimitsForLevel('live-audience', {
      maxOldGenerationSizeMb: 512,
      maxYoungGenerationSizeMb: 64,
      stackSizeMb: 8,
      codeRangeSizeMb: 32,
    }),
    {
      maxOldGenerationSizeMb: 192,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
      codeRangeSizeMb: 32,
    },
  );
  assert.deepEqual(
    resourceLimitsForLevel('parcel-pulse', {
      maxOldGenerationSizeMb: 128,
      codeRangeSizeMb: 32,
    }),
    { maxOldGenerationSizeMb: 128, codeRangeSizeMb: 32 },
  );
});

test('stricter operator limits are preserved without raising', () => {
  const strict = {
    maxOldGenerationSizeMb: 128,
    maxYoungGenerationSizeMb: 8,
    stackSizeMb: 2,
  };
  assert.deepEqual(resourceLimitsForLevel('live-audience', strict), strict);
  assert.deepEqual(resourceLimitsForLevel('parcel-pulse', strict), strict);
  assert.deepEqual(
    resourceLimitsForLevel('live-audience', { maxOldGenerationSizeMb: 96 }),
    {
      maxOldGenerationSizeMb: 96,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
    },
  );

  const provided = {
    maxOldGenerationSizeMb: 128,
    maxYoungGenerationSizeMb: 8,
    stackSizeMb: 2,
  };
  resourceLimitsForLevel('live-audience', provided);
  assert.deepEqual(provided, strict, 'helper must not mutate caller input');
});

test('Live Audience worker and calibration CLI observe the same heap ceiling', async (t) => {
  const workerLimit = await new Promise<number>((resolve, reject) => {
    const worker = new Worker(
      `const { getHeapStatistics } = require('node:v8');
       const { parentPort } = require('node:worker_threads');
       parentPort.postMessage(getHeapStatistics().heap_size_limit);`,
      { eval: true, resourceLimits: resourceLimitsForLevel('live-audience') },
    );
    worker.once('message', (value) => {
      worker.terminate().then(
        () => resolve(Number(value)),
        reject,
      );
    });
    worker.once('error', reject);
  });

  // Must match scripts/audience-calibrate.ts: 192 MiB old, 8 MiB semi-space.
  const cli = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=192',
      '--max-semi-space-size=8',
      '-e',
      `process.stdout.write(String(require('node:v8').getHeapStatistics().heap_size_limit))`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const cliLimit = Number(cli.stdout.trim());
  assert.ok(Number.isInteger(cliLimit) && cliLimit > 0);
  assert.ok(cliLimit >= 192 * 1024 * 1024);
  assert.equal(
    cliLimit,
    workerLimit,
    'calibration CLI and Live Audience Worker limits must expose the same effective heap ceiling',
  );
  t.diagnostic(
    `Node ${process.version}: CLI 192/8 heap limit ${cliLimit} bytes; Worker 192/16/4 heap limit ${workerLimit} bytes`,
  );
});

test('metadata comes from the authoritative core without a worker', async (t) => {
  const engine = new WorkerEngine();
  t.after(async () => {
    await engine.close();
  });

  const levels = await engine.levels();
  assert.deepEqual(
    levels.map((level) => level.id),
    ['cold-cache', 'parcel-pulse', 'image-atlas', 'live-scoreboard', 'live-audience', 'global-cart'],
  );
  assert.deepEqual(
    levels.find((level) => level.id === PARCEL_LEVEL.id),
    {
      id: PARCEL_LEVEL.id,
      title: PARCEL_LEVEL.title,
      description: PARCEL_LEVEL.description,
      defaultSeed: PARCEL_LEVEL.defaultSeed,
      horizons: [...PARCEL_LEVEL.horizons],
    },
  );
  assert.deepEqual(
    levels.find((level) => level.id === 'image-atlas')?.horizons,
    [],
  );
  assert.deepEqual(
    await engine.describe(PARCEL_LEVEL_ID),
    describeParcelLevel(),
  );
  assert.deepEqual(
    await engine.components(PARCEL_LEVEL_ID),
    parcelCatalogPayload(),
  );
  assert.deepEqual(
    await engine.schema(PARCEL_LEVEL_ID),
    parcelGraphJsonSchema(),
  );
  assert.equal(engine.stats.activeWorkers, 0);
  assert.equal(engine.stats.completedRuns, 0);
});

test('a missing trusted worker entry fails startup clearly', () => {
  assert.throws(
    () =>
      new WorkerEngine({
        workerEntry: pathToFileURL(
          '/nonexistent/parcel-worker-does-not-exist.js',
        ),
      }),
    (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.code, 'engine_unavailable');
      assert.match(error.message, /worker entry is missing/);
      return true;
    },
  );
});

test('strict result guard accepts all real core status shapes and rejects partial passes', () => {
  const ok = evaluateParcel(starterGraph, { seed: 101 });
  const invalid = evaluateParcel(
    { schemaVersion: 1, levelId: PARCEL_LEVEL_ID, nodes: [], edges: [] },
    { seed: 101 },
  );
  const parseInvalid = evaluateParcel('not-a-graph', { seed: 101 });
  const error = evaluateParcel(starterGraph, { seed: -1 });

  assert.equal(ok.status, 'ok');
  assert.equal(invalid.status, 'invalid');
  assert.equal(parseInvalid.status, 'invalid');
  assert.equal(error.status, 'error');
  assert.equal(isParcelEvaluationResult(ok), true);
  assert.equal(isParcelEvaluationResult(invalid), true);
  assert.equal(isParcelEvaluationResult(parseInvalid), true);
  assert.equal(isParcelEvaluationResult(error), true);

  const partial = JSON.parse(JSON.stringify(ok)) as {
    horizons: unknown[];
    passed: boolean;
    cost: unknown;
  };
  partial.horizons = [partial.horizons[0]];
  assert.equal(isParcelEvaluationResult(partial), false);

  const falsePass = JSON.parse(JSON.stringify(ok)) as { passed: boolean };
  falsePass.passed = true;
  assert.equal(isParcelEvaluationResult(falsePass), false);

  const noCost = JSON.parse(JSON.stringify(ok)) as { cost?: unknown };
  delete noCost.cost;
  assert.equal(isParcelEvaluationResult(noCost), false);

  const invalidWithHorizons = JSON.parse(JSON.stringify(invalid)) as {
    horizons: unknown[];
  };
  const horizon = JSON.parse(JSON.stringify(ok.horizons[0]));
  invalidWithHorizons.horizons = [horizon];
  assert.equal(isParcelEvaluationResult(invalidWithHorizons), false);
});

test('strict guard requires the complete mandatory check set', () => {
  const result = evaluateParcel(passingGraph, { seed: 101 });
  assert.equal(result.status, 'ok');
  assert.equal(result.passed, true);
  assert.ok(result.horizons.every((horizon) => horizon.passed));
  assert.equal(isParcelEvaluationResult(result), true);

  interface MutableCheck {
    id: string;
    severity: string;
    passed: boolean;
    operation?: string;
    nodeId?: string;
    horizonYears?: number;
  }
  interface MutableHorizon {
    horizonYears: number;
    checks: MutableCheck[];
  }
  interface MutableEvaluation {
    horizons: MutableHorizon[];
    checks: MutableCheck[];
  }

  const clone = (): MutableEvaluation =>
    JSON.parse(JSON.stringify(result)) as MutableEvaluation;

  for (let index = 0; index < result.horizons.length; index += 1) {
    const horizon = result.horizons[index] as
      | { horizonYears: number; checks: readonly { id: string }[] }
      | undefined;
    assert.ok(horizon !== undefined);
    for (const check of horizon.checks) {
      const candidate = clone();
      candidate.horizons[index]!.checks = candidate.horizons[index]!.checks.filter(
        (item) => item.id !== check.id,
      );
      assert.equal(
        isParcelEvaluationResult(candidate),
        false,
        `removing ${check.id} from year ${horizon.horizonYears} must reject`,
      );
    }
  }

  const duplicate = clone();
  const firstHorizon = duplicate.horizons[0];
  assert.ok(firstHorizon !== undefined);
  firstHorizon.checks.push({ ...firstHorizon.checks[0]! });
  assert.equal(isParcelEvaluationResult(duplicate), false);

  const advisory = clone();
  advisory.horizons[0]!.checks[0]!.severity = 'advisory';
  assert.equal(isParcelEvaluationResult(advisory), false);

  const wrongOperation = clone();
  const availability = wrongOperation.horizons[0]!.checks.find(
    (check) => check.id === 'availability:status',
  );
  assert.ok(availability !== undefined);
  availability.operation = 'history';
  assert.equal(isParcelEvaluationResult(wrongOperation), false);

  const wrongNode = clone();
  const storage = wrongNode.horizons[0]!.checks.find((check) =>
    check.id.startsWith('storage_capacity:'),
  );
  assert.ok(storage !== undefined);
  storage.nodeId = 'not-a-store';
  assert.equal(isParcelEvaluationResult(wrongNode), false);

  const wrongHorizon = clone();
  wrongHorizon.horizons[0]!.checks[0]!.horizonYears = 5;
  assert.equal(isParcelEvaluationResult(wrongHorizon), false);

  const historicalInYearOne = clone();
  const historical = clone().horizons[1]!.checks.find(
    (check) => check.id === 'historical_cohort',
  );
  assert.ok(historical !== undefined);
  historicalInYearOne.horizons[0]!.checks.push(historical);
  assert.equal(isParcelEvaluationResult(historicalInYearOne), false);
});

test('unknown levels, invalid seeds and pre-aborted signals spawn no worker', async (t) => {
  const engine = new WorkerEngine();
  t.after(async () => {
    await engine.close();
  });

  await assert.rejects(
    engine.evaluate(
      { levelId: 'missing-level', graph: starterGraph, seed: 101 },
      signal(),
    ),
    assertEngineError('level_not_found'),
  );
  await assert.rejects(
    engine.evaluate(
      { levelId: PARCEL_LEVEL_ID, graph: starterGraph, seed: -1 },
      signal(),
    ),
    assertEngineError('invalid_seed'),
  );
  await assert.rejects(
    engine.evaluate(
      { levelId: PARCEL_LEVEL_ID, graph: starterGraph, seed: 2_147_483_648 },
      signal(),
    ),
    assertEngineError('invalid_seed'),
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    engine.evaluate(
      { levelId: PARCEL_LEVEL_ID, graph: starterGraph, seed: 101 },
      controller.signal,
    ),
    assertEngineError('evaluation_cancelled'),
  );
  assert.equal(engine.stats.peakWorkers, 0);
});

test('worker output is byte-equivalent to direct evaluateParcel for all three families', async (t) => {
  const stats: { elapsedMs: number; heapSizeLimitBytes: number; rssBytes: number }[] = [];
  const engine = new WorkerEngine({
    onRunStats: (run) => {
      stats.push({
        elapsedMs: run.elapsedMs,
        heapSizeLimitBytes: run.heapSizeLimitBytes,
        rssBytes: run.rssBytes,
      });
    },
  });
  t.after(async () => {
    await engine.close();
  });

  const families: { name: string; graph: unknown }[] = [
    { name: 'sql', graph: starterGraph },
    { name: 'kv', graph: graphForFamily('kv') },
    { name: 'columnar', graph: graphForFamily('columnar') },
  ];

  for (const family of families) {
    const seed = 101;
    const started = Date.now();
    const direct = evaluateParcel(family.graph, { seed });
    const directMs = Date.now() - started;
    const worker = await engine.evaluate(
      { levelId: PARCEL_LEVEL_ID, graph: family.graph, seed },
      signal(),
    );
    const elapsedMs = Date.now() - started;
    assert.deepEqual(worker, direct, `${family.name} deep equality`);
    assert.equal(
      JSON.stringify(worker),
      JSON.stringify(direct),
      `${family.name} stable JSON equality`,
    );
    assert.equal(
      (worker as { meta: { requestedHorizons: readonly number[] } }).meta.requestedHorizons.join(','),
      '1,5',
      `${family.name} must evaluate both mandatory horizons`,
    );
    t.diagnostic(
      `${family.name}: direct ${directMs} ms, worker ${elapsedMs} ms, status ${(worker as { status: string }).status}`,
    );
  }

  assert.equal(stats.length, 3);
  for (const run of stats) {
    assert.ok(run.elapsedMs > 0);
    assert.ok(run.rssBytes > 0);
    assert.ok(
      run.heapSizeLimitBytes >= 512 * 1024 * 1024,
      'worker heap limit must include the configured ~512 MiB old generation',
    );
  }
  const last = engine.stats.lastRun;
  assert.ok(last !== null);
  t.diagnostic(
    `worker last run: elapsed ${last.elapsedMs.toFixed(0)} ms, rss ${(last.rssBytes / 1048576).toFixed(0)} MiB, heap limit ${(last.heapSizeLimitBytes / 1048576).toFixed(0)} MiB`,
  );
});

test('worker emits progress and a failed starter evaluation is a completed result', async (t) => {
  const phases = new Set<string>();
  const horizons = new Set<number | null>();
  const progress: WorkerProgress[] = [];
  const engine = new WorkerEngine({
    onProgress: (event) => {
      progress.push(event);
      phases.add(event.phase);
      horizons.add(event.horizonYears);
    },
  });
  t.after(async () => {
    await engine.close();
  });

  const result = (await engine.evaluate(
    { levelId: PARCEL_LEVEL_ID, graph: starterGraph, seed: 101 },
    signal(),
  )) as {
    status: string;
    passed: boolean;
    meta: { seed: number; requestedHorizons: number[]; levelId: string };
    checks: { id: string; passed: boolean }[];
  };

  assert.equal(result.status, 'ok');
  assert.equal(result.passed, false);
  assert.equal(result.meta.seed, 101);
  assert.equal(result.meta.levelId, PARCEL_LEVEL_ID);
  assert.deepEqual(result.meta.requestedHorizons, [1, 5]);
  assert.equal(
    result.checks.find((check) => check.id === 'horizons_complete')?.passed,
    true,
  );
  assert.equal(
    result.checks.find((check) => check.id === 'horizon_pass:1')?.passed,
    false,
  );
  assert.ok(phases.has('validate'));
  assert.ok(phases.has('capacity'));
  assert.ok(phases.has('simulate'));
  assert.ok(phases.has('done'));
  assert.ok(horizons.has(1));
  assert.ok(horizons.has(5));
  assert.ok(progress.length >= 5);
});

test('successful evaluation also settles after worker termination', async (t) => {
  let terminationFinished = false;
  let doneAt = 0;
  const engine = new WorkerEngine({
    onProgress: (progress) => {
      if (progress.phase === 'done') {
        doneAt = performance.now();
      }
    },
    terminateWorker: async (worker) => {
      const code = await worker.terminate();
      await delay(60);
      terminationFinished = true;
      return code;
    },
  });
  t.after(async () => {
    await engine.close();
  });

  const result = (await engine.evaluate(
    { levelId: PARCEL_LEVEL_ID, graph: starterGraph, seed: 101 },
    signal(),
  )) as { status: string };
  const resolvedAt = performance.now();
  assert.equal(result.status, 'ok');
  assert.equal(terminationFinished, true);
  assert.ok(doneAt > 0);
  assert.ok(
    resolvedAt - doneAt >= 50,
    `result resolved before termination settled (${(resolvedAt - doneAt).toFixed(0)} ms)`,
  );
});

test('aborting a running evaluation terminates its worker and rejects once', async (t) => {
  const started = deferred();
  const engine = new WorkerEngine({
    onProgress: () => {
      started.resolve();
    },
  });
  t.after(async () => {
    await engine.close();
  });

  const controller = new AbortController();
  const evaluation = engine.evaluate(
    { levelId: PARCEL_LEVEL_ID, graph: starterGraph, seed: 101 },
    controller.signal,
  );
  await started.promise;
  assert.equal(engine.stats.activeWorkers, 1);
  controller.abort();
  await assert.rejects(evaluation, assertEngineError('evaluation_cancelled'));
  assert.equal(engine.stats.activeWorkers, 0);
  await engine.close();
  assert.equal(engine.stats.activeWorkers, 0);
  assert.equal(engine.stats.terminatingWorkers, 0);
  await assert.rejects(
    engine.evaluate(
      { levelId: PARCEL_LEVEL_ID, graph: starterGraph, seed: 101 },
      signal(),
    ),
    assertEngineError('service_unavailable'),
  );
});

test('evaluation settles only after the worker termination promise settles', async (t) => {
  const started = deferred();
  let terminationFinished = false;
  const engine = new WorkerEngine({
    onProgress: () => {
      started.resolve();
    },
    terminateWorker: async (worker) => {
      const code = await worker.terminate();
      await delay(80);
      terminationFinished = true;
      return code;
    },
  });
  t.after(async () => {
    await engine.close();
  });

  const controller = new AbortController();
  const evaluation = engine.evaluate(
    { levelId: PARCEL_LEVEL_ID, graph: starterGraph, seed: 101 },
    controller.signal,
  );
  await started.promise;
  const abortedAt = Date.now();
  controller.abort();
  await assert.rejects(evaluation, assertEngineError('evaluation_cancelled'));
  const elapsed = Date.now() - abortedAt;
  assert.equal(terminationFinished, true);
  assert.ok(
    elapsed >= 70,
    `evaluation rejected before terminate settled (${elapsed} ms)`,
  );
  assert.equal(engine.stats.liveWorkers, 0);
  t.diagnostic(`abort rejection waited ${elapsed} ms for termination`);
});

test('close rejects an in-flight evaluation and leaves no pending workers', async (t) => {
  const started = deferred();
  const engine = new WorkerEngine({
    onProgress: () => {
      started.resolve();
    },
  });
  t.after(async () => {
    await engine.close();
  });

  const evaluation = engine.evaluate(
    { levelId: PARCEL_LEVEL_ID, graph: starterGraph, seed: 202 },
    signal(),
  );
  const rejected = assert.rejects(
    evaluation,
    assertEngineError('service_unavailable'),
  );
  await started.promise;
  assert.equal(engine.stats.activeWorkers, 1);
  await engine.close();
  await rejected;
  assert.equal(engine.stats.activeWorkers, 0);
  assert.equal(engine.stats.terminatingWorkers, 0);
});
