import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const backendDir = fileURLToPath(new URL('..', import.meta.url));
const starterGraph: unknown = JSON.parse(
  readFileSync(new URL('../../fixtures/parcel/starter.json', import.meta.url), 'utf8'),
);

function build(): void {
  const npmCli = process.env.npm_execpath;
  if (npmCli !== undefined) {
    execFileSync(process.execPath, [npmCli, 'run', 'build'], {
      cwd: backendDir,
      stdio: 'pipe',
    });
    return;
  }
  execFileSync('npm', ['run', 'build'], {
    cwd: backendDir,
    stdio: 'pipe',
  });
}

interface RunningServer {
  readonly child: ReturnType<typeof spawn>;
  readonly url: string;
  readonly output: () => string;
}

/** Start `node` with the given entry arguments and wait for the listen line. */
function startServer(args: readonly string[]): Promise<RunningServer> {
  const child = spawn(process.execPath, [...args], {
    cwd: backendDir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      LOG_LEVEL: 'silent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  return new Promise<RunningServer>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`API did not start in time.\n${stdout}\n${stderr}`));
    }, 20_000);

    const inspect = (): void => {
      const match = /PARCEL_API_LISTENING (http:\/\/\S+)/.exec(stdout);
      if (match !== null && match[1] !== undefined) {
        clearTimeout(timer);
        resolve({
          child,
          url: match[1],
          output: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
        });
      }
    };
    child.stdout?.on('data', inspect);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `API exited before listening (code ${String(code)}).\n${stdout}\n${stderr}`,
        ),
      );
    });
    inspect();
  });
}

async function stopServer(server: RunningServer): Promise<number | null> {
  const exit = new Promise<number | null>((resolve) => {
    server.child.once('exit', (code) => resolve(code));
  });
  let stopTimer: NodeJS.Timeout | null = null;
  const exitGuard = new Promise<number | null>((_, reject) => {
    stopTimer = setTimeout(
      () => reject(new Error('API did not stop gracefully')),
      15_000,
    );
  });
  server.child.kill('SIGTERM');
  const code = await Promise.race([exit, exitGuard]);
  if (stopTimer !== null) {
    clearTimeout(stopTimer);
  }
  return code;
}

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

async function request(
  url: string,
  init?: RequestInit,
): Promise<JsonResponse> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

async function submitStarter(server: RunningServer): Promise<string> {
  const created = await request(`${server.url}/v1/evaluations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      levelId: 'parcel-pulse',
      graph: starterGraph,
      seed: 101,
    }),
  });
  assert.equal(created.status, 202);
  const job = created.body as { id: string; links: { self: string } };
  assert.equal(job.links.self, `/v1/evaluations/${job.id}`);
  return job.id;
}

async function waitForCompleted(
  url: string,
  id: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await request(`${url}/v1/evaluations/${id}`);
    const body = job.body as Record<string, unknown>;
    if (body.status === 'completed') {
      return body;
    }
    if (body.status === 'failed' || body.status === 'cancelled') {
      throw new Error(`job ended as ${String(body.status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('evaluation did not complete in time');
}

function assertStarterResult(completed: Record<string, unknown>): void {
  const result = completed.result as {
    status: string;
    passed: boolean;
    meta: { requestedHorizons: readonly number[]; levelId: string };
  };
  assert.equal(completed.status, 'completed');
  assert.equal(completed.error, null);
  assert.equal(result.status, 'ok');
  assert.equal(result.passed, false);
  assert.equal(result.meta.levelId, 'parcel-pulse');
  assert.deepEqual(result.meta.requestedHorizons, [1, 5]);
}

test(
  'production build starts the compiled API and compiled worker',
  { timeout: 120_000 },
  async (t) => {
    const started = performance.now();
    build();
    const buildMs = performance.now() - started;
    assert.ok(existsSync(`${backendDir}/dist/main.js`));
    assert.ok(existsSync(`${backendDir}/dist/engine/worker.js`));

    const server = await startServer(['dist/main.js']);
    let stopped = false;
    t.after(() => {
      if (!stopped) {
        server.child.kill('SIGKILL');
      }
    });

    const health = await request(`${server.url}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: 'ok', ready: true });

    const levels = await request(`${server.url}/v1/levels`);
    assert.equal(levels.status, 200);

    const evaluationStarted = performance.now();
    const id = await submitStarter(server);
    const completed = await waitForCompleted(server.url, id);
    const evaluationMs = performance.now() - evaluationStarted;
    assertStarterResult(completed);

    const code = await stopServer(server);
    stopped = true;
    assert.equal(code, 0);
    assert.match(server.output(), /PARCEL_API_STOPPING SIGTERM/);
    assert.doesNotMatch(server.output(), /PARCEL_API_STARTUP_FAILED/);

    t.diagnostic(
      `build ${buildMs.toFixed(0)} ms; compiled worker evaluation ${evaluationMs.toFixed(0)} ms`,
    );
  },
);

test(
  'development runner starts the TypeScript API and TypeScript worker',
  { timeout: 120_000 },
  async (t) => {
    const server = await startServer(['--import', 'tsx', 'src/main.ts']);
    let stopped = false;
    t.after(() => {
      if (!stopped) {
        server.child.kill('SIGKILL');
      }
    });

    const health = await request(`${server.url}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: 'ok', ready: true });

    const id = await submitStarter(server);
    const completed = await waitForCompleted(server.url, id);
    assertStarterResult(completed);

    const code = await stopServer(server);
    stopped = true;
    assert.equal(code, 0);
    assert.match(server.output(), /PARCEL_API_STOPPING SIGTERM/);
    assert.doesNotMatch(server.output(), /PARCEL_API_STARTUP_FAILED/);
  },
);
