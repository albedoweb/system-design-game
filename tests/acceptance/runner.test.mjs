import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  findGraphSchema,
  graphSchemaProblem,
  isCrossLevelHttpRejection,
  isCrossLevelResultRejection,
} from '../../scripts/acceptance-checks.mjs';
import { resolveArtifactDir } from '../../scripts/acceptance-config.mjs';
import {
  runManagedCommand,
  terminateManagedChildren,
} from '../../scripts/acceptance-process.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

function validGraphSchema(levelId = 'parcel-pulse') {
  return {
    type: 'object',
    required: ['schemaVersion', 'levelId', 'nodes', 'edges'],
    properties: {
      schemaVersion: { type: 'integer' },
      levelId: { const: levelId },
      nodes: { type: 'array', items: { type: 'object' } },
      edges: { type: 'array', items: { type: 'object' } },
    },
  };
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

async function waitForFileValue(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = 'missing';
  while (Date.now() < deadline) {
    try {
      const value = readFileSync(path, 'utf8').trim();
      if (value !== '') {
        return value;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${path}: ${last}`);
}

async function waitForDead(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`process ${pid} is still alive`);
}

test('graph schema check rejects placeholders and unrelated schemas', () => {
  const valid = validGraphSchema();
  assert.equal(graphSchemaProblem(valid, 'parcel-pulse'), null);
  assert.equal(findGraphSchema(valid, 'parcel-pulse'), valid);

  for (const placeholder of [
    { type: 'object' },
    { type: 'object', properties: {} },
    { type: 'object', properties: { nodes: { type: 'array' }, edges: { type: 'array' } } },
    { type: 'object', properties: { someLevel: { type: 'object' } } },
    { title: 'Parcel Pulse level', properties: { budget: { type: 'number' } } },
  ]) {
    assert.equal(findGraphSchema(placeholder, 'parcel-pulse'), null);
    assert.notEqual(graphSchemaProblem(placeholder, 'parcel-pulse'), null);
  }

  const wrongLevel = {
    ...valid,
    properties: {
      ...valid.properties,
      levelId: { const: 'cold-cache' },
    },
  };
  assert.equal(findGraphSchema(wrongLevel, 'parcel-pulse'), null);
  assert.equal(findGraphSchema({ command: 'schema', graph: valid }, 'parcel-pulse'), valid);
  const unbound = structuredClone(valid);
  delete unbound.properties.levelId;
  assert.equal(findGraphSchema(unbound, 'parcel-pulse'), null);
  for (const items of [
    { oneOf: [{ type: 'string' }] },
    { anyOf: [{ type: 'object' }, { type: 'number' }] },
    { $ref: '#/$defs/missing' },
    { $ref: 'https://example.invalid/node' },
  ]) {
    const malformed = structuredClone(valid);
    malformed.properties.nodes.items = items;
    assert.equal(findGraphSchema(malformed, 'parcel-pulse'), null);
  }
  const references = structuredClone(valid);
  references.$defs = { node: { oneOf: [{ type: 'object' }, { type: 'object' }] } };
  references.properties.nodes.items = { $ref: '#/$defs/node' };
  assert.equal(findGraphSchema(references, 'parcel-pulse'), references);
});

test('object item schemas accept conditional refinements without losing their object bound', () => {
  const schema = validGraphSchema();
  const conditional = {
    if: { properties: { kind: { const: 'sql' } } },
    then: { properties: { config: { type: 'object', required: ['size'] } } },
  };
  schema.properties.nodes.items = { type: 'object', allOf: [conditional] };
  assert.equal(findGraphSchema({ graph: schema }, 'parcel-pulse'), schema);

  // A conditional alone does not guarantee that each graph item is an object.
  schema.properties.nodes.items = { allOf: [conditional] };
  assert.equal(findGraphSchema(schema, 'parcel-pulse'), null);
  schema.properties.nodes.items = { type: 'object', allOf: [{ type: 'string' }] };
  assert.equal(findGraphSchema(schema, 'parcel-pulse'), null);
});

test('generic passed:false evaluation is not a cross-level rejection', () => {
  const genericFailure = {
    status: 'ok',
    passed: false,
    checks: [{ id: 'storage_capacity', passed: false }],
  };
  const invalidGraph = {
    status: 'invalid',
    passed: false,
    issues: [{ severity: 'error', code: 'invalid_nodes' }],
  };
  const levelMismatch = {
    status: 'invalid',
    passed: false,
    issues: [{ severity: 'error', code: 'level_override_rejected' }],
  };

  assert.equal(isCrossLevelResultRejection(genericFailure), false);
  assert.equal(isCrossLevelResultRejection(invalidGraph), false);
  assert.equal(isCrossLevelResultRejection(levelMismatch), true);
  assert.equal(
    isCrossLevelResultRejection({
      status: 'invalid',
      passed: false,
      error: { code: 'level_mismatch', message: 'Graph belongs to another level.' },
    }),
    true,
  );
  assert.equal(isCrossLevelResultRejection({ status: 'ok', passed: true }), false);

  assert.equal(isCrossLevelHttpRejection(422, null), true);
  assert.equal(isCrossLevelHttpRejection(202, null), false);
  assert.equal(
    isCrossLevelHttpRejection(400, { error: { code: 'level_mismatch' } }),
    true,
  );
  assert.equal(isCrossLevelHttpRejection(400, { error: { code: 'bad_request' } }), false);
});

test('artifact directory override cannot escape the repository acceptance root', () => {
  const expectedRoot = join(ROOT, 'test-results/acceptance');
  assert.equal(resolveArtifactDir(ROOT), expectedRoot);
  assert.equal(resolveArtifactDir(ROOT, expectedRoot), expectedRoot);
  assert.equal(
    resolveArtifactDir(ROOT, 'test-results/acceptance/run-2'),
    join(expectedRoot, 'run-2'),
  );

  for (const unsafe of [
    '/tmp/i106-outside',
    '../outside-acceptance',
    'test-results/acceptance-evil',
    'test-results/acceptance/../../outside',
  ]) {
    assert.throws(
      () => resolveArtifactDir(ROOT, unsafe),
      /must stay inside/,
      `expected containment failure for ${unsafe}`,
    );
  }
});

test('artifact directories reject symlinked ancestors and leave outside data intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'acceptance-path-'));
  const root = join(directory, 'repo');
  const outside = join(directory, 'outside');
  mkdirSync(join(root, 'test-results'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel'), 'keep');
  try {
    symlinkSync(outside, join(root, 'test-results/acceptance'), 'dir');
    assert.throws(() => resolveArtifactDir(root), /symbolic link/);
    rmSync(join(root, 'test-results/acceptance'));
    rmSync(join(root, 'test-results'), { recursive: true });
    symlinkSync(outside, join(root, 'test-results'), 'dir');
    assert.throws(() => resolveArtifactDir(root), /symbolic link/);
    assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'keep');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  'interrupted managed command terminates its whole process group',
  { timeout: 15_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'i106-runner-'));
    const marker = join(directory, 'grandchild.pid');
    const script = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      writeFileSync(process.argv[1], String(grandchild.pid));
      setInterval(() => {}, 1000);
    `;
    let grandchildPid = null;
    const running = runManagedCommand(process.execPath, ['-e', script, marker], {
      cwd: directory,
      timeout: 60_000,
    });

    try {
      grandchildPid = Number(await waitForFileValue(marker, 5_000));
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
      assert.equal(isAlive(grandchildPid), true);

      await terminateManagedChildren('SIGTERM', 2_000);
      const result = await running;
      assert.equal(result.timedOut, false);
      await waitForDead(grandchildPid, 3_000);
      assert.equal(isAlive(grandchildPid), false);
    } finally {
      if (grandchildPid !== null) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('managed command timeout is bounded and reported', { timeout: 10_000 }, async () => {
  const started = Date.now();
  const result = await runManagedCommand(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { timeout: 250, graceMs: 1_000 },
  );
  assert.equal(result.timedOut, true);
  assert.match(String(result.error), /timed out after 250ms/);
  assert.ok(Date.now() - started < 5_000);
  assert.notEqual(result.status, 0);
});

test('cleanup retains ownership after leader exit with a SIGTERM-ignoring descendant', { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'acceptance-orphan-'));
  const marker = join(directory, 'ready.pid');
  const grandchildScript = `
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  `;
  const leaderScript = `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}, process.argv[1]], { stdio: 'ignore' });
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
  let descendantPid;
  const running = runManagedCommand(process.execPath, ['-e', leaderScript, marker], {
    timeout: 30_000,
    graceMs: 200,
  });
  try {
    descendantPid = Number(await waitForFileValue(marker, 5_000));
    assert.equal(isAlive(descendantPid), true);
    await terminateManagedChildren('SIGTERM', 100);
    const result = await running;
    assert.equal(result.status, 0);
    await waitForDead(descendantPid, 2_000);
  } finally {
    await terminateManagedChildren('SIGKILL', 100);
    if (descendantPid) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Already gone. */ }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
