import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_GRACE_MS = 5_000;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const activeChildren = new Set();

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function killProcessGroup(child, signal) {
  if (!child || child.pid === undefined) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // The process may already be gone.
    }
  }
}

function groupIsAlive(child) {
  if (child.pid === undefined) return false;
  if (process.platform === 'win32') return child.exitCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function finishProcessGroup(child, graceMs) {
  if (!groupIsAlive(child)) return;
  killProcessGroup(child, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (groupIsAlive(child) && Date.now() < deadline) {
    await sleep(20);
  }
  if (groupIsAlive(child)) killProcessGroup(child, 'SIGKILL');
}

function appendBounded(state, stream, chunk) {
  const text = String(chunk);
  const remaining = MAX_CAPTURE_BYTES - state[stream].length;
  if (remaining > 0) {
    state[stream] += text.slice(0, remaining);
  }
}

/**
 * Run one bounded command as the leader of its own process group.
 *
 * The returned promise settles on child exit. On timeout the whole group gets
 * SIGTERM, then SIGKILL after the grace period, so descendants cannot outlive
 * an interrupted or hung acceptance step.
 */
export function runManagedCommand(command, args, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const state = {
    child,
    stdout: '',
    stderr: '',
    timedOut: false,
    spawnError: null,
  };
  activeChildren.add(state);

  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      appendBounded(state, 'stdout', chunk);
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      appendBounded(state, 'stderr', chunk);
    });
  }

  let finishClosed;
  const closed = new Promise((resolvePromise) => {
    let settled = false;
    finishClosed = (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      resolvePromise({ code, signal });
    };
    child.once('close', (code, signal) => {
      finishClosed(code, signal);
    });
    child.once('error', (error) => {
      state.spawnError = error;
      finishClosed(null, null);
    });
  });

  const timer = setTimeout(() => {
    state.timedOut = true;
    killProcessGroup(child, 'SIGTERM');
    state.forceTimer = setTimeout(() => {
      killProcessGroup(child, 'SIGKILL');
    }, graceMs);
    state.forceTimer.unref?.();
  }, timeoutMs);
  timer.unref?.();

  const resultPromise = closed.then(async ({ code, signal }) => {
    clearTimeout(timer);
    // A leader's close does not mean its process group has exited. Keep the
    // group registered until surviving descendants have been terminated,
    // including descendants that ignore SIGTERM and have no inherited pipes.
    await finishProcessGroup(child, graceMs);
    if (state.forceTimer) {
      clearTimeout(state.forceTimer);
    }
    activeChildren.delete(state);
    const error =
      state.spawnError !== null
        ? state.spawnError.message
        : state.timedOut
          ? `timed out after ${timeoutMs}ms`
          : null;
    return {
      command: [command, ...args].join(' '),
      status: code,
      signal,
      error,
      stdout: state.stdout,
      stderr: state.stderr,
      durationMs: Date.now() - startedAt,
      timedOut: state.timedOut,
    };
  });
  state.resultPromise = resultPromise;
  return resultPromise;
}

/**
 * Terminate every command currently owned by the runner, wait for exit, then
 * force-kill anything that ignored the first signal. Used by SIGINT/SIGTERM
 * handlers and by the focused cleanup test.
 */
export async function terminateManagedChildren(signal = 'SIGTERM', graceMs = DEFAULT_GRACE_MS) {
  const states = [...activeChildren];
  if (states.length === 0) {
    return;
  }
  for (const state of states) {
    killProcessGroup(state.child, signal);
  }
  const allSettled = Promise.allSettled(states.map((state) => state.resultPromise));
  const gotSettled = await Promise.race([
    allSettled.then(() => true),
    sleep(graceMs).then(() => false),
  ]);
  if (gotSettled) {
    return;
  }
  for (const state of [...activeChildren]) {
    killProcessGroup(state.child, 'SIGKILL');
  }
  await Promise.race([Promise.allSettled([...activeChildren].map((state) => state.resultPromise)), sleep(2_000)]);
}
