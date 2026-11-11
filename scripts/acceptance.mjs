#!/usr/bin/env node
/**
 * Minimal executable acceptance for the three-level game.
 *
 * `npm run acceptance` builds the frontend and backend, starts bounded local
 * servers, runs deterministic public-CLI checks, a real API job, and the
 * production browser suite. It cleans up every child on all paths and exits
 * non-zero on any failure. Missing levels/fixtures are failures, never skips.
 */
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractPassed,
  failureSignals,
  findGraphSchema,
  isCrossLevelHttpRejection,
  isCrossLevelResultRejection,
  isRecord,
  reasonMatches,
} from './acceptance-checks.mjs';
import { resolveArtifactDir } from './acceptance-config.mjs';
import { runManagedCommand, terminateManagedChildren } from './acceptance-process.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let ARTIFACT_DIR;
try {
  ARTIFACT_DIR = resolveArtifactDir(ROOT, process.env.ACCEPTANCE_ARTIFACT_DIR);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
const LOG_DIR = join(ARTIFACT_DIR, 'logs');
const FE_PORT = Number(process.env.ACCEPTANCE_FE_PORT ?? 5190);
const API_PORT = Number(process.env.ACCEPTANCE_API_PORT ?? 8091);
const FE_URL = `http://127.0.0.1:${FE_PORT}`;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const EXPECTED_LEVELS = [
  'cold-cache',
  'parcel-pulse',
  'image-atlas',
  'live-scoreboard',
  'live-audience',
];
/** Real CLI/API result captured for the cross-interface equality check. */
let scoreboardCliResult = null;
let audienceCliResult = null;
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const CLI_TIMEOUT_MS = 300_000;

mkdirSync(LOG_DIR, { recursive: true });

const report = {
  task: 'I106 minimal executable acceptance',
  command: 'npm run acceptance',
  repo: ROOT,
  sha: gitSha(),
  startedAt: new Date().toISOString(),
  finishedAt: null,
  durationMs: null,
  node: process.version,
  ports: { frontend: FE_PORT, api: API_PORT },
  selfTests: null,
  builds: {},
  cli: null,
  api: null,
  browser: null,
  passed: false,
};
const started = Date.now();
const servers = [];
let cleaned = false;

function gitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function short(text, limit = 600) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function record(checks, id, passed, detail, extra = {}) {
  const entry = { id, passed, detail, ...extra };
  checks.push(entry);
  log(`${passed ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
  return entry;
}

function summarize(checks) {
  return {
    passed: checks.every((item) => item.passed),
    passedCount: checks.filter((item) => item.passed).length,
    failedCount: checks.filter((item) => !item.passed).length,
    checks,
  };
}

async function portFree(port) {
  return new Promise((resolvePromise) => {
    const server = net.createServer();
    server.once('error', () => resolvePromise(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolvePromise(true));
    });
  });
}

async function run(command, args, options = {}) {
  return runManagedCommand(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env,
    timeout: options.timeout ?? CLI_TIMEOUT_MS,
  });
}

function parseJsonOutput(result) {
  const text = result.stdout.trim();
  if (text.length === 0) {
    throw new Error(`no JSON output (exit ${String(result.status)})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Fall through to the stable error below.
      }
    }
    throw new Error(`invalid JSON output: ${short(text, 200)}`);
  }
}

function outputHead(result) {
  return short(`${result.stderr}\n${result.stdout}`, 800);
}

async function waitForHttp(url, options = {}) {
  const timeout = options.timeout ?? 30_000;
  const deadline = Date.now() + timeout;
  let last = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(3_000),
        headers: options.headers ?? { accept: 'application/json' },
      });
      const ok = options.accept ? await options.accept(response) : response.ok;
      if (ok) {
        return response;
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`${url} not ready after ${timeout}ms: ${last}`);
}

function startServer(name, command, args, env) {
  const logPath = join(LOG_DIR, `${name}.log`);
  const stream = createWriteStream(logPath, { flags: 'a' });
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stream.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stream.write(chunk);
  });
  child.once('exit', () => {
    stream.end();
  });
  const server = { name, child, logPath, exited: false };
  child.once('exit', () => {
    server.exited = true;
  });
  servers.push(server);
  return server;
}

async function stopServer(server) {
  if (!server || server.exited || server.child.exitCode !== null) {
    return;
  }
  const child = server.child;
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // The process may already be gone.
  }
  const exited = once(child, 'exit').then(() => true).catch(() => true);
  const timeout = sleep(10_000).then(() => false);
  if (!(await Promise.race([exited, timeout]))) {
    try {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        process.kill(-child.pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // Best effort.
    }
    await Promise.race([once(child, 'exit'), sleep(2_000)]).catch(() => undefined);
  }
}

async function cleanup() {
  if (cleaned) {
    return;
  }
  cleaned = true;
  for (const server of servers.reverse()) {
    await stopServer(server);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void (async () => {
      log(`Acceptance interrupted by ${signal}; terminating owned processes.`);
      await terminateManagedChildren('SIGTERM', 5_000);
      await cleanup();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    })();
  });
}

async function buildFrontend() {
  rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
  const result = await run(NPM, ['run', 'build'], { timeout: 600_000 });
  return {
    status: result.status === 0 ? 'PASS' : 'FAIL',
    durationMs: result.durationMs,
    detail: result.status === 0 ? 'vite production build' : outputHead(result),
    output: short(result.stdout, 2_000),
  };
}

async function buildBackend() {
  const result = await run(NPM, ['--prefix', 'backend', 'run', 'build'], {
    timeout: 600_000,
  });
  return {
    status: result.status === 0 ? 'PASS' : 'FAIL',
    durationMs: result.durationMs,
    detail: result.status === 0 ? 'backend esbuild production build' : outputHead(result),
    output: short(result.stdout, 2_000),
  };
}

function runCli(args) {
  return run(NPM, ['run', '--silent', 'agent', '--', ...args], {
    timeout: CLI_TIMEOUT_MS,
  });
}

async function runRunnerSelfTests() {
  const result = await run(process.execPath, ['--test', 'tests/acceptance/runner.test.mjs'], {
    timeout: 120_000,
  });
  return {
    status: result.status === 0 ? 'PASS' : 'FAIL',
    durationMs: result.durationMs,
    detail:
      result.status === 0
        ? 'focused runner self-tests'
        : `exit ${String(result.status)}: ${outputHead(result)}`,
    output: short(`${result.stdout}\n${result.stderr}`, 8_000),
  };
}

function fixturePath(relative) {
  return join(ROOT, relative);
}

function requireFixture(checks, id, relative) {
  if (existsSync(fixturePath(relative))) {
    return true;
  }
  record(
    checks,
    id,
    false,
    `fixture missing: ${relative} (expected from the integration/calibration dependency; not skipped)`,
  );
  return false;
}

async function runCliChecks() {
  const checks = [];

  {
    const result = await runCli(['levels']);
    try {
      const parsed = parseJsonOutput(result);
      const levels = Array.isArray(parsed.levels) ? parsed.levels : [];
      const ids = levels
        .map((item) => (isRecord(item) && typeof item.id === 'string' ? item.id : null))
        .filter((id) => id !== null);
      const missing = EXPECTED_LEVELS.filter((id) => !ids.includes(id));
      record(
        checks,
        'cli.levels',
        result.status === 0 && missing.length === 0,
        result.status !== 0
          ? `exit ${String(result.status)}: ${outputHead(result)}`
          : missing.length === 0
            ? `levels ${ids.join(', ')}`
            : `missing levels: ${missing.join(', ')} (present: ${ids.join(', ') || 'none'})`,
        { output: short(result.stdout, 4_000) },
      );
      const audience = levels.find(
        (item) => isRecord(item) && item.id === 'live-audience',
      );
      record(
        checks,
        'cli.levels.live-audience.playable',
        result.status === 0 &&
          isRecord(audience) &&
          audience.playable === true,
        result.status !== 0
          ? `exit ${String(result.status)}: ${outputHead(result)}`
          : isRecord(audience)
            ? `playable=${String(audience.playable)}`
            : 'live-audience missing from discovery',
      );
    } catch (error) {
      record(checks, 'cli.levels', false, `${error.message}; ${outputHead(result)}`);
    }
  }

  for (const levelId of EXPECTED_LEVELS) {
    const result = await runCli(['schema', '--level', levelId]);
    try {
      const parsed = parseJsonOutput(result);
      const schema = findGraphSchema(parsed, levelId);
      record(
        checks,
        `cli.schema.${levelId}`,
        result.status === 0 && schema !== null,
        result.status !== 0
          ? `exit ${String(result.status)}: ${outputHead(result)}`
          : schema === null
            ? 'JSON output has no graph schema with required nodes/edges arrays and item schemas'
            : 'graph schema present (nodes+edges)',
      );
    } catch (error) {
      record(
        checks,
        `cli.schema.${levelId}`,
        false,
        `${error.message}; ${outputHead(result)}`,
      );
    }
  }

  {
    const result = await runCli([
      'schema',
      '--level',
      'live-scoreboard',
      '--kind',
      'catalog',
    ]);
    try {
      const parsed = parseJsonOutput(result);
      const catalog = isRecord(parsed) && isRecord(parsed.catalog) ? parsed.catalog : null;
      const inner = catalog !== null && isRecord(catalog.catalog) ? catalog.catalog : null;
      const sql = inner !== null && isRecord(inner.components) && isRecord(inner.components.sql)
        ? inner.components.sql
        : null;
      const large = sql !== null && isRecord(sql.sizes) && isRecord(sql.sizes.large)
        ? sql.sizes.large
        : null;
      record(
        checks,
        'cli.catalog.live-scoreboard',
        result.status === 0 &&
          catalog !== null &&
          catalog.pricingVersion === 'scoreboard-catalog-v1' &&
          inner !== null &&
          isRecord(inner.work) &&
          isRecord(inner.billing) &&
          large !== null &&
          large.hourlyUsd === 1.28,
        result.status !== 0
          ? `exit ${String(result.status)}: ${outputHead(result)}`
          : catalog === null
            ? 'catalog payload missing'
            : `pricingVersion=${String(catalog.pricingVersion)}, large=${String(large?.hourlyUsd)}`,
      );
    } catch (error) {
      record(
        checks,
        'cli.catalog.live-scoreboard',
        false,
        `${error.message}; ${outputHead(result)}`,
      );
    }
  }

  {
    const result = await runCli([
      'schema',
      '--level',
      'live-audience',
      '--kind',
      'catalog',
    ]);
    try {
      const parsed = parseJsonOutput(result);
      const catalog = isRecord(parsed) && isRecord(parsed.catalog) ? parsed.catalog : null;
      const inner = catalog !== null && isRecord(catalog.catalog) ? catalog.catalog : null;
      const sql = inner !== null && isRecord(inner.components) && isRecord(inner.components.sql)
        ? inner.components.sql
        : null;
      const large = sql !== null && isRecord(sql.sizes) && isRecord(sql.sizes.large)
        ? sql.sizes.large
        : null;
      const policies = inner !== null && isRecord(inner.policies) ? inner.policies : null;
      const cache = policies !== null && isRecord(policies.cache) ? policies.cache : null;
      record(
        checks,
        'cli.catalog.live-audience',
        result.status === 0 &&
          catalog !== null &&
          catalog.pricingVersion === 'audience-catalog-v1' &&
          catalog.profileVersion === 'app-resilience-v1' &&
          inner !== null &&
          isRecord(inner.work) &&
          isRecord(inner.policies) &&
          isRecord(inner.network) &&
          large !== null &&
          large.hourlyUsd === 1.28 &&
          cache !== null &&
          cache.retention === 'selected-ttl',
        result.status !== 0
          ? `exit ${String(result.status)}: ${outputHead(result)}`
          : catalog === null
            ? 'catalog payload missing'
            : `pricingVersion=${String(catalog.pricingVersion)}, large=${String(large?.hourlyUsd)}, retention=${String(cache?.retention)}`,
      );
    } catch (error) {
      record(
        checks,
        'cli.catalog.live-audience',
        false,
        `${error.message}; ${outputHead(result)}`,
      );
    }
  }

  const runCases = [
    {
      id: 'cli.run.cold-cache.pass',
      level: 'cold-cache',
      graph: 'tests/acceptance/fixtures/cold-cache-cheap-pass.json',
      expectedExit: 0,
      expectedPassed: true,
    },
    {
      id: 'cli.run.cold-cache.fail',
      level: 'cold-cache',
      graph: 'tests/acceptance/fixtures/cold-cache-overbudget.json',
      expectedExit: 2,
      expectedPassed: false,
      reason: /cost|budget/i,
    },
    {
      id: 'cli.run.parcel-pulse.pass',
      level: 'parcel-pulse',
      graph: 'fixtures/parcel/family-sql-indexed.json',
      expectedExit: 0,
      expectedPassed: true,
    },
    {
      id: 'cli.run.parcel-pulse.fail',
      level: 'parcel-pulse',
      graph: 'fixtures/parcel/fail-capacity.json',
      expectedExit: 2,
      expectedPassed: false,
      reason: /storage|capacity/i,
    },
    {
      id: 'cli.run.image-atlas.fail',
      level: 'image-atlas',
      graph: 'fixtures/images/fail-storage.json',
      expectedExit: 2,
      expectedPassed: false,
      reason: /storage|capacity/i,
    },
    {
      id: 'cli.run.live-scoreboard.pass',
      level: 'live-scoreboard',
      graph: 'fixtures/scoreboard/family-aggregate.json',
      expectedExit: 0,
      expectedPassed: true,
    },
    {
      id: 'cli.run.live-scoreboard.fail',
      level: 'live-scoreboard',
      graph: 'fixtures/scoreboard/fail-small-scan.json',
      expectedExit: 2,
      expectedPassed: false,
      reason: /availability|p95|latency|timeout|reject/i,
    },
    {
      id: 'cli.run.live-audience.pass',
      level: 'live-audience',
      graph: 'fixtures/audience/family-query-large.json',
      expectedExit: 0,
      expectedPassed: true,
    },
    {
      id: 'cli.run.live-audience.fail',
      level: 'live-audience',
      graph: 'fixtures/audience/fail-single-app.json',
      expectedExit: 2,
      expectedPassed: false,
      reason: /availability|p95|latency|timeout|reject|fault|failure|app/i,
    },
  ];

  for (const item of runCases) {
    if (!requireFixture(checks, item.id, item.graph)) {
      continue;
    }
    const result = await runCli([
      'run',
      '--level',
      item.level,
      '--graph',
      item.graph,
      '--seed',
      '101',
    ]);
    try {
      const parsed = parseJsonOutput(result);
      const passed = extractPassed(parsed);
      if (
        item.level === 'live-scoreboard' &&
        passed === true &&
        isRecord(parsed)
      ) {
        const resultBody = { ...parsed };
        delete resultBody.command;
        delete resultBody.level;
        scoreboardCliResult = resultBody;
      }
      if (
        item.level === 'live-audience' &&
        passed === true &&
        isRecord(parsed)
      ) {
        const resultBody = { ...parsed };
        delete resultBody.command;
        delete resultBody.level;
        audienceCliResult = resultBody;
      }
      const reasonOk =
        item.expectedPassed || item.reason === undefined
          ? true
          : reasonMatches(parsed, item.reason);
      const detailParts = [
        `exit ${String(result.status)}`,
        `passed=${String(passed)}`,
      ];
      if (!item.expectedPassed) {
        detailParts.push(
          reasonOk
            ? 'expected failure reason present'
            : `expected failure reason ${item.reason} not found`,
        );
      }
      record(
        checks,
        item.id,
        result.status === item.expectedExit &&
          passed === item.expectedPassed &&
          reasonOk,
        detailParts.join(', '),
        { output: short(result.stdout, 6_000) },
      );
    } catch (error) {
      record(
        checks,
        item.id,
        false,
        `${error.message}; exit ${String(result.status)}; ${outputHead(result)}`,
      );
    }
  }

  {
    const result = await runCli([
      'run',
      '--level',
      'definitely-not-a-level',
      '--graph',
      'tests/acceptance/fixtures/cold-cache-cheap-pass.json',
      '--seed',
      '101',
    ]);
    let errorCode = null;
    try {
      const parsed = parseJsonOutput(result);
      errorCode = isRecord(parsed.error) ? parsed.error.code ?? null : null;
    } catch {
      // A non-JSON nonzero rejection still satisfies the public contract.
    }
    record(
      checks,
      'cli.reject.invalid-level',
      result.status !== 0 && result.status !== null,
      `exit ${String(result.status)}${errorCode === null ? '' : `, error=${String(errorCode)}`}`,
      { output: short(result.stdout, 2_000) },
    );
  }

  {
    const result = await runCli([
      'run',
      '--level',
      'parcel-pulse',
      '--graph',
      'tests/acceptance/fixtures/invalid-graph.json',
      '--seed',
      '101',
    ]);
    let passed;
    try {
      passed = extractPassed(parseJsonOutput(result));
    } catch {
      passed = undefined;
    }
    record(
      checks,
      'cli.reject.invalid-graph',
      result.status === 1 && passed !== true,
      `exit ${String(result.status)}, passed=${String(passed)}`,
      { output: short(result.stdout, 4_000) },
    );
  }

  return summarize(checks);
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

async function runApiChecks() {
  const checks = [];

  {
    try {
      const health = await waitForHttp(`${API_URL}/healthz`, { timeout: 30_000 });
      const body = await health.json();
      record(
        checks,
        'api.health',
        health.status === 200 && isRecord(body) && body.ready === true,
        `HTTP ${health.status}, ready=${String(isRecord(body) ? body.ready : undefined)}`,
      );
    } catch (error) {
      record(checks, 'api.health', false, error.message);
    }
  }

  let listed = [];
  {
    try {
      const response = await requestJson(`${API_URL}/v1/levels`);
      const levels =
        response.status === 200 && isRecord(response.body) && Array.isArray(response.body.levels)
          ? response.body.levels
          : [];
      listed = levels
        .map((item) => (isRecord(item) && typeof item.id === 'string' ? item.id : null))
        .filter((id) => id !== null);
      const missing = EXPECTED_LEVELS.filter((id) => !listed.includes(id));
      record(
        checks,
        'api.levels',
        response.status === 200 && missing.length === 0,
        response.status !== 200
          ? `HTTP ${response.status}`
          : missing.length === 0
            ? `levels ${listed.join(', ')}`
            : `missing levels: ${missing.join(', ')} (present: ${listed.join(', ') || 'none'})`,
      );
    } catch (error) {
      record(checks, 'api.levels', false, error.message);
    }
  }

  for (const levelId of EXPECTED_LEVELS) {
    try {
      const response = await requestJson(`${API_URL}/v1/levels/${levelId}/schema`);
      const schema = response.status === 200 ? findGraphSchema(response.body, levelId) : null;
      record(
        checks,
        `api.schema.${levelId}`,
        response.status === 200 && schema !== null,
        response.status !== 200
          ? `HTTP ${response.status}`
          : schema === null
            ? '200 without a graph schema with required nodes/edges arrays and item schemas'
            : 'graph schema present (nodes+edges)',
      );
    } catch (error) {
      record(checks, `api.schema.${levelId}`, false, error.message);
    }
  }

  {
    try {
      const response = await requestJson(
        `${API_URL}/v1/levels/live-scoreboard/components`,
      );
      const payload = response.status === 200 && isRecord(response.body) ? response.body : null;
      const catalog = payload !== null && isRecord(payload.catalog) ? payload.catalog : null;
      const sql = catalog !== null && isRecord(catalog.components) && isRecord(catalog.components.sql)
        ? catalog.components.sql
        : null;
      const large = sql !== null && isRecord(sql.sizes) && isRecord(sql.sizes.large)
        ? sql.sizes.large
        : null;
      record(
        checks,
        'api.catalog.live-scoreboard',
        response.status === 200 &&
          payload !== null &&
          payload.pricingVersion === 'scoreboard-catalog-v1' &&
          catalog !== null &&
          isRecord(catalog.work) &&
          large !== null &&
          large.hourlyUsd === 1.28,
        response.status !== 200
          ? `HTTP ${response.status}`
          : `pricingVersion=${String(payload?.pricingVersion)}, large=${String(large?.hourlyUsd)}`,
      );
    } catch (error) {
      record(checks, 'api.catalog.live-scoreboard', false, error.message);
    }
  }

  {
    try {
      const response = await requestJson(
        `${API_URL}/v1/levels/live-audience/components`,
      );
      const payload = response.status === 200 && isRecord(response.body) ? response.body : null;
      const catalog = payload !== null && isRecord(payload.catalog) ? payload.catalog : null;
      const policies = catalog !== null && isRecord(catalog.policies) ? catalog.policies : null;
      const cache = policies !== null && isRecord(policies.cache) ? policies.cache : null;
      const sql = catalog !== null && isRecord(catalog.components) && isRecord(catalog.components.sql)
        ? catalog.components.sql
        : null;
      const large = sql !== null && isRecord(sql.sizes) && isRecord(sql.sizes.large)
        ? sql.sizes.large
        : null;
      record(
        checks,
        'api.catalog.live-audience',
        response.status === 200 &&
          payload !== null &&
          payload.pricingVersion === 'audience-catalog-v1' &&
          payload.profileVersion === 'app-resilience-v1' &&
          catalog !== null &&
          isRecord(catalog.work) &&
          isRecord(catalog.storage) &&
          large !== null &&
          large.hourlyUsd === 1.28 &&
          cache !== null &&
          cache.retention === 'selected-ttl',
        response.status !== 200
          ? `HTTP ${response.status}`
          : `pricingVersion=${String(payload?.pricingVersion)}, large=${String(large?.hourlyUsd)}, retention=${String(cache?.retention)}`,
      );
    } catch (error) {
      record(checks, 'api.catalog.live-audience', false, error.message);
    }
  }

  let scoreboardApiResult = null;
  let audienceApiResult = null;
  for (const item of [
    {
      id: 'api.job.live-scoreboard.pass',
      graphPath: 'fixtures/scoreboard/family-aggregate.json',
      expectedPassed: true,
    },
    {
      id: 'api.job.live-scoreboard.fail',
      graphPath: 'fixtures/scoreboard/fail-small-scan.json',
      expectedPassed: false,
    },
  ]) {
    if (!requireFixture(checks, item.id, item.graphPath)) {
      continue;
    }
    try {
      const graph = JSON.parse(readFileSync(fixturePath(item.graphPath), 'utf8'));
      const created = await requestJson(`${API_URL}/v1/evaluations`, {
        method: 'POST',
        body: JSON.stringify({
          levelId: 'live-scoreboard',
          graph,
          seed: 101,
        }),
      });
      const jobId =
        created.status === 202 && isRecord(created.body) && typeof created.body.id === 'string'
          ? created.body.id
          : null;
      if (jobId === null) {
        record(
          checks,
          item.id,
          false,
          `submit HTTP ${created.status}: ${short(JSON.stringify(created.body), 400)}`,
        );
        continue;
      }
      const deadline = Date.now() + 60_000;
      let snapshot = null;
      let status = 'unknown';
      while (Date.now() < deadline) {
        const response = await requestJson(`${API_URL}/v1/evaluations/${jobId}`);
        snapshot = response.body;
        status = isRecord(snapshot) && typeof snapshot.status === 'string' ? snapshot.status : 'unknown';
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          break;
        }
        await sleep(200);
      }
      if (status !== 'completed') {
        if (status !== 'failed' && status !== 'cancelled') {
          await requestJson(`${API_URL}/v1/evaluations/${jobId}`, {
            method: 'DELETE',
          }).catch(() => undefined);
        }
        record(checks, item.id, false, `job ended ${status}`);
        continue;
      }
      const result = isRecord(snapshot) && isRecord(snapshot.result) ? snapshot.result : null;
      const passed = result !== null ? result.passed : undefined;
      const identity = result !== null && isRecord(result.identity) ? result.identity : {};
      const bindingOk =
        identity.levelId === 'live-scoreboard' &&
        identity.seed === 101 &&
        identity.modelVersion === '1.0.0' &&
        identity.pricingVersion === 'scoreboard-catalog-v1';
      record(
        checks,
        item.id,
        passed === item.expectedPassed && bindingOk,
        `completed, passed=${String(passed)}, level=${String(identity.levelId)}, seed=${String(identity.seed)}`,
      );
      if (item.expectedPassed && result !== null) {
        scoreboardApiResult = result;
      }
    } catch (error) {
      record(checks, item.id, false, error.message);
    }
  }

  for (const item of [
    {
      id: 'api.job.live-audience.pass',
      graphPath: 'fixtures/audience/family-query-large.json',
      expectedPassed: true,
    },
    {
      id: 'api.job.live-audience.fail',
      graphPath: 'fixtures/audience/fail-single-app.json',
      expectedPassed: false,
    },
  ]) {
    if (!requireFixture(checks, item.id, item.graphPath)) {
      continue;
    }
    try {
      const graph = JSON.parse(readFileSync(fixturePath(item.graphPath), 'utf8'));
      const created = await requestJson(`${API_URL}/v1/evaluations`, {
        method: 'POST',
        body: JSON.stringify({
          levelId: 'live-audience',
          graph,
          seed: 101,
        }),
      });
      const jobId =
        created.status === 202 && isRecord(created.body) && typeof created.body.id === 'string'
          ? created.body.id
          : null;
      if (jobId === null) {
        record(
          checks,
          item.id,
          false,
          `submit HTTP ${created.status}: ${short(JSON.stringify(created.body), 400)}`,
        );
        continue;
      }
      const deadline = Date.now() + 60_000;
      let snapshot = null;
      let status = 'unknown';
      while (Date.now() < deadline) {
        const response = await requestJson(`${API_URL}/v1/evaluations/${jobId}`);
        snapshot = response.body;
        status = isRecord(snapshot) && typeof snapshot.status === 'string' ? snapshot.status : 'unknown';
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          break;
        }
        await sleep(200);
      }
      if (status !== 'completed') {
        if (status !== 'failed' && status !== 'cancelled') {
          await requestJson(`${API_URL}/v1/evaluations/${jobId}`, {
            method: 'DELETE',
          }).catch(() => undefined);
        }
        record(checks, item.id, false, `job ended ${status}`);
        continue;
      }
      const result = isRecord(snapshot) && isRecord(snapshot.result) ? snapshot.result : null;
      const passed = result !== null ? result.passed : undefined;
      const identity = result !== null && isRecord(result.identity) ? result.identity : {};
      const cases = result !== null && Array.isArray(result.cases) ? result.cases : [];
      const bindingOk =
        identity.levelId === 'live-audience' &&
        identity.seed === 101 &&
        identity.modelVersion === '1.0.0' &&
        identity.pricingVersion === 'audience-catalog-v1' &&
        identity.profileVersion === 'app-resilience-v1' &&
        result !== null &&
        result.status === 'complete' &&
        cases.length >= 3;
      record(
        checks,
        item.id,
        passed === item.expectedPassed && bindingOk,
        `completed, status=${String(result?.status)}, passed=${String(passed)}, cases=${String(cases.length)}, level=${String(identity.levelId)}, seed=${String(identity.seed)}`,
      );
      if (item.expectedPassed && result !== null) {
        audienceApiResult = result;
      }
    } catch (error) {
      record(checks, item.id, false, error.message);
    }
  }

  {
    let same = false;
    let detail = 'CLI or API Live Audience result unavailable';
    if (audienceCliResult !== null && audienceApiResult !== null) {
      same =
        JSON.stringify(audienceCliResult) === JSON.stringify(audienceApiResult);
      detail = same
        ? 'CLI and API returned the same real Live Audience result for seed 101'
        : 'CLI and API Live Audience results differ for the same graph and seed';
    }
    record(checks, 'cli.api.equality.live-audience', same, detail);
  }

  {
    let same = false;
    let detail = 'CLI or API Scoreboard result unavailable';
    if (scoreboardCliResult !== null && scoreboardApiResult !== null) {
      same =
        JSON.stringify(scoreboardCliResult) === JSON.stringify(scoreboardApiResult);
      detail = same
        ? 'CLI and API returned the same real engine result for seed 101'
        : 'CLI and API results differ for the same graph and seed';
    }
    record(checks, 'cli.api.equality.live-scoreboard', same, detail);
  }

  {
    const graphPath = 'fixtures/parcel/family-sql-indexed.json';
    if (!requireFixture(checks, 'api.job.parcel-pulse', graphPath)) {
      // Explicit failure above; the remaining API checks still run.
    } else {
      try {
        const graph = JSON.parse(readFileSync(fixturePath(graphPath), 'utf8'));
        const created = await requestJson(`${API_URL}/v1/evaluations`, {
          method: 'POST',
          body: JSON.stringify({ levelId: 'parcel-pulse', graph, seed: 101 }),
        });
        const jobId =
          created.status === 202 && isRecord(created.body) && typeof created.body.id === 'string'
            ? created.body.id
            : null;
        if (jobId === null) {
          record(
            checks,
            'api.job.parcel-pulse',
            false,
            `submit HTTP ${created.status}: ${short(JSON.stringify(created.body), 400)}`,
          );
        } else {
          const deadline = Date.now() + 60_000;
          let snapshot = null;
          let status = 'unknown';
          while (Date.now() < deadline) {
            const response = await requestJson(`${API_URL}/v1/evaluations/${jobId}`);
            snapshot = response.body;
            status = isRecord(snapshot) && typeof snapshot.status === 'string' ? snapshot.status : 'unknown';
            if (status === 'completed' || status === 'failed' || status === 'cancelled') {
              break;
            }
            await sleep(200);
          }
          if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
            await requestJson(`${API_URL}/v1/evaluations/${jobId}`, { method: 'DELETE' }).catch(
              () => undefined,
            );
            record(checks, 'api.job.parcel-pulse', false, 'job did not finish within 60s; cancelled');
          } else if (status !== 'completed') {
            record(checks, 'api.job.parcel-pulse', false, `job ended ${status}`);
          } else if (!isRecord(snapshot) || !isRecord(snapshot.result)) {
            record(checks, 'api.job.parcel-pulse', false, 'completed job has no result');
          } else {
            const result = snapshot.result;
            const meta = isRecord(result.meta) ? result.meta : {};
            const passed = result.passed;
            const metaOk = meta.levelId === 'parcel-pulse' && meta.seed === 101;
            record(
              checks,
              'api.job.parcel-pulse',
              passed === true && metaOk,
              `completed, passed=${String(passed)}, level=${String(meta.levelId)}, seed=${String(meta.seed)}`,
            );
          }
        }
      } catch (error) {
        record(checks, 'api.job.parcel-pulse', false, error.message);
      }
    }
  }

  {
    const graphPath = 'tests/acceptance/fixtures/cold-cache-cheap-pass.json';
    if (!requireFixture(checks, 'api.reject.cross-level-result', graphPath)) {
      // Explicit failure above.
    } else {
      try {
        const graph = JSON.parse(readFileSync(fixturePath(graphPath), 'utf8'));
        const created = await requestJson(`${API_URL}/v1/evaluations`, {
          method: 'POST',
          body: JSON.stringify({ levelId: 'parcel-pulse', graph, seed: 101 }),
        });
        if (isCrossLevelHttpRejection(created.status, created.body)) {
          record(
            checks,
            'api.reject.cross-level-result',
            true,
            `cross-level graph rejected before enqueue (HTTP ${created.status})`,
          );
        } else if (
          created.status === 202 &&
          isRecord(created.body) &&
          typeof created.body.id === 'string'
        ) {
          const deadline = Date.now() + 30_000;
          let snapshot = null;
          let status = 'unknown';
          while (Date.now() < deadline) {
            const response = await requestJson(
              `${API_URL}/v1/evaluations/${created.body.id}`,
            );
            snapshot = response.body;
            status =
              isRecord(snapshot) && typeof snapshot.status === 'string'
                ? snapshot.status
                : 'unknown';
            if (status === 'completed' || status === 'failed' || status === 'cancelled') {
              break;
            }
            await sleep(200);
          }
          if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
            await requestJson(`${API_URL}/v1/evaluations/${created.body.id}`, {
              method: 'DELETE',
            }).catch(() => undefined);
          }
          const result = isRecord(snapshot) && isRecord(snapshot.result) ? snapshot.result : null;
          const rejected = status === 'completed' && isCrossLevelResultRejection(result);
          const signals =
            result === null ? 'none' : failureSignals(result).slice(0, 4).join(', ') || 'none';
          record(
            checks,
            'api.reject.cross-level-result',
            rejected,
            status === 'completed'
              ? `completed with passed=${String(result?.passed)}, status=${String(result?.status)}, signals=${signals}`
              : `job ended ${status}`,
          );
        } else {
          record(
            checks,
            'api.reject.cross-level-result',
            false,
            `submit HTTP ${created.status}, expected 422 or a completed invalid result`,
          );
        }
      } catch (error) {
        record(checks, 'api.reject.cross-level-result', false, error.message);
      }
    }
  }

  {
    try {
      const response = await requestJson(`${API_URL}/v1/levels/not-a-level/schema`);
      record(
        checks,
        'api.reject.unknown-level',
        response.status === 404,
        `HTTP ${response.status}`,
      );
    } catch (error) {
      record(checks, 'api.reject.unknown-level', false, error.message);
    }
  }

  {
    try {
      const response = await requestJson(`${API_URL}/v1/not-a-route`);
      record(
        checks,
        'api.reject.unknown-route',
        response.status === 404,
        `HTTP ${response.status}`,
      );
    } catch (error) {
      record(checks, 'api.reject.unknown-route', false, error.message);
    }
  }

  return summarize(checks);
}

function playwrightFailures(jsonPath) {
  if (!existsSync(jsonPath)) {
    return [];
  }
  let data;
  try {
    data = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch {
    return [];
  }
  const failures = [];
  const visit = (suite) => {
    if (!isRecord(suite)) return;
    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        if (!isRecord(spec) || !Array.isArray(spec.tests)) continue;
        for (const item of spec.tests) {
          if (!isRecord(item) || !Array.isArray(item.results)) continue;
          if (
            item.status === 'unexpected' ||
            item.results.some((result) => isRecord(result) && result.status === 'failed')
          ) {
            failures.push(typeof spec.title === 'string' ? spec.title : 'unnamed spec');
          }
        }
      }
    }
    if (Array.isArray(suite.suites)) {
      for (const nested of suite.suites) visit(nested);
    }
  };
  for (const suite of Array.isArray(data.suites) ? data.suites : []) {
    visit(suite);
  }
  return [...new Set(failures)];
}

async function runBrowserChecks() {
  const jsonPath = join(ARTIFACT_DIR, 'playwright-report.json');
  rmSync(jsonPath, { force: true });
  rmSync(join(ARTIFACT_DIR, 'playwright'), { recursive: true, force: true });

  const result = await run(
    join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright'),
    ['test', '--config', join(ROOT, 'tests/acceptance/playwright.config.ts')],
    {
      timeout: 1_200_000,
      env: {
        ACCEPTANCE_BASE_URL: FE_URL,
        ACCEPTANCE_API_URL: API_URL,
        ACCEPTANCE_ARTIFACT_DIR: ARTIFACT_DIR,
        CI: '',
      },
    },
  );

  let summary = { expected: 0, unexpected: null, skipped: null, flaky: null };
  if (existsSync(jsonPath)) {
    try {
      const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
      if (isRecord(data.stats)) {
        summary = {
          expected: Number(data.stats.expected ?? 0),
          unexpected: Number(data.stats.unexpected ?? 0),
          skipped: Number(data.stats.skipped ?? 0),
          flaky: Number(data.stats.flaky ?? 0),
        };
      }
    } catch {
      // Reported as a failure below.
    }
  }
  const failures = playwrightFailures(jsonPath);
  const passed =
    result.status === 0 &&
    summary.expected > 0 &&
    summary.unexpected === 0 &&
    summary.skipped === 0 &&
    summary.flaky === 0 &&
    result.error === null;
  const detail =
    result.error !== null
      ? result.error
      : summary.unexpected === null
        ? `Playwright exited ${String(result.status)} without a JSON report`
        : `${summary.expected} expected, ${String(summary.unexpected)} unexpected, ${String(summary.skipped)} skipped, ${String(summary.flaky)} flaky`;

  return {
    passed,
    exitCode: result.status,
    durationMs: result.durationMs,
    stats: summary,
    failures,
    detail,
    reportPath: existsSync(jsonPath) ? jsonPath : null,
    output: short(`${result.stdout}\n${result.stderr}`, 8_000),
  };
}

async function main() {
  log(`I106 acceptance — ${report.sha}`);
  log(`artifacts: ${ARTIFACT_DIR}`);

  report.selfTests = await runRunnerSelfTests();
  log(`Runner self-tests ${report.selfTests.status} — ${report.selfTests.detail}`);
  if (report.selfTests.status !== 'PASS') {
    throw new Error('acceptance runner self-tests failed');
  }

  report.builds.frontend = await buildFrontend();
  report.builds.backend = await buildBackend();
  log(
    `build frontend=${report.builds.frontend.status} backend=${report.builds.backend.status}`,
  );

  const feFree = await portFree(FE_PORT);
  const apiFree = await portFree(API_PORT);
  if (!feFree) {
    report.builds.frontend.detail += `; port ${FE_PORT} is already in use`;
  }
  if (!apiFree) {
    report.builds.backend.detail += `; port ${API_PORT} is already in use`;
  }

  let apiServer = null;
  if (report.builds.backend.status === 'PASS' && apiFree) {
    apiServer = startServer('api', process.execPath, ['backend/dist/main.js'], {
      HOST: '127.0.0.1',
      PORT: String(API_PORT),
      LOG_LEVEL: 'silent',
    });
    try {
      await waitForHttp(`${API_URL}/healthz`, { timeout: 30_000 });
    } catch (error) {
      log(`API startup failed: ${error.message}`);
    }
  }

  if (report.builds.frontend.status === 'PASS' && feFree) {
    startServer(
      'frontend',
      join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite'),
      ['preview', '--host', '127.0.0.1', '--port', String(FE_PORT), '--strictPort'],
      {},
    );
    try {
      await waitForHttp(FE_URL, {
        timeout: 30_000,
        headers: { accept: 'text/html' },
      });
    } catch (error) {
      log(`Frontend startup failed: ${error.message}`);
    }
  }

  report.cli = await runCliChecks();
  log(`CLI ${report.cli.passedCount}/${report.cli.checks.length} checks passed`);

  if (apiServer !== null && apiFree) {
    report.api = await runApiChecks();
    log(`API ${report.api.passedCount}/${report.api.checks.length} checks passed`);
  } else {
    report.api = {
      passed: false,
      passedCount: 0,
      failedCount: 1,
      checks: [
        {
          id: 'api.server',
          passed: false,
          detail: 'API server was not started (build failure or port conflict)',
        },
      ],
    };
    log('API NOT RUN — server unavailable');
  }

  if (report.builds.frontend.status === 'PASS' && feFree) {
    report.browser = await runBrowserChecks();
    log(
      `Browser ${report.browser.passed ? 'PASS' : 'FAIL'} — ${report.browser.detail}`,
    );
    for (const failure of report.browser.failures) {
      log(`  browser failure: ${failure}`);
    }
  } else {
    report.browser = {
      passed: false,
      exitCode: null,
      durationMs: 0,
      stats: { expected: 0, unexpected: null, skipped: null, flaky: null },
      failures: [],
      detail: 'production browser suite not run (build failure or port conflict)',
      reportPath: null,
      output: '',
    };
    log('Browser NOT RUN — build/port unavailable');
  }
}

try {
  await main();
} catch (error) {
  log(`Acceptance runner crashed: ${error instanceof Error ? error.stack : String(error)}`);
  report.runnerError = error instanceof Error ? error.message : String(error);
} finally {
  await cleanup();
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - started;
  report.passed =
    report.selfTests?.status === 'PASS' &&
    report.builds.frontend?.status === 'PASS' &&
    report.builds.backend?.status === 'PASS' &&
    report.cli?.passed === true &&
    report.api?.passed === true &&
    report.browser?.passed === true &&
    report.runnerError === undefined;
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const reportPath = join(ARTIFACT_DIR, 'report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  log('');
  log(`Self-tests: ${report.selfTests?.status ?? 'NOT RUN'}`);
  log(`Build:   frontend ${report.builds.frontend?.status ?? 'NOT RUN'}, backend ${report.builds.backend?.status ?? 'NOT RUN'}`);
  log(`CLI:     ${report.cli ? `${report.cli.passedCount}/${report.cli.checks.length} passed` : 'NOT RUN'}`);
  log(`API:     ${report.api ? `${report.api.passedCount}/${report.api.checks.length} passed` : 'NOT RUN'}`);
  log(
    `Browser: ${report.browser ? (report.browser.passed ? 'PASS' : 'FAIL') : 'NOT RUN'}${
      report.browser?.stats ? ` (${report.browser.stats.expected} expected, ${report.browser.stats.unexpected} unexpected, ${report.browser.stats.skipped} skipped)` : ''
    }`,
  );
  log(`Report:  ${reportPath}`);
  log(`Acceptance: ${report.passed ? 'PASS' : 'FAIL'} in ${(report.durationMs / 1000).toFixed(1)}s`);
  process.exitCode = report.passed ? 0 : 1;
}
