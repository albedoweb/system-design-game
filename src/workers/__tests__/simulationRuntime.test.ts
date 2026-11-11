import { describe, expect, it } from 'vitest';

import type {
  StartCommand,
  WorkerCommand,
  WorkerMessage,
} from '../../domain/worker';
import {
  PACKAGE_MS,
  createSimulationWorkerRuntime,
  type WorkerTimerApi,
} from '../simulationRuntime';
import { testGraph, testLevel } from '../../engine/__tests__/helpers';

class ManualTimers implements WorkerTimerApi {
  private nextHandle = 1;
  private readonly pending = new Map<number, { run: () => void; delayMs: number }>();

  set = (callback: () => void, delayMs: number): number => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.pending.set(handle, { run: callback, delayMs });
    return handle;
  };

  clear = (handle: unknown): void => {
    if (typeof handle === 'number') {
      this.pending.delete(handle);
    }
  };

  get size(): number {
    return this.pending.size;
  }

  get delay(): number | null {
    const first = this.pending.values().next();
    return first.done === true ? null : first.value.delayMs;
  }

  fireNext(): void {
    const entry = this.pending.entries().next();
    if (entry.done === true) {
      throw new Error('no timer pending');
    }
    const [handle, timer] = entry.value;
    this.pending.delete(handle);
    timer.run();
  }
}

function startCommand(
  runId: string,
  overrides: Partial<StartCommand> = {},
): StartCommand {
  return {
    type: 'start',
    runId,
    graph: testGraph(),
    level: testLevel({
      durationMs: 200,
      warmupMs: 0,
      drainMs: 800,
      readSchedule: [{ atMs: 0, rps: 20 }],
    }),
    seed: 101,
    speed: 1,
    ...overrides,
  };
}

function runToEnd(runtime: ReturnType<typeof createSimulationWorkerRuntime>, timers: ManualTimers): void {
  while (timers.size > 0) {
    timers.fireNext();
  }
  expect(runtime).toBeDefined();
}

describe('simulation worker runtime', () => {
  it('advances in virtual 100 ms packages and emits one result', () => {
    const messages: WorkerMessage[] = [];
    const timers = new ManualTimers();
    const runtime = createSimulationWorkerRuntime((message) => messages.push(message), timers);

    runtime.handleCommand(startCommand('run-1'));
    expect(messages).toHaveLength(0);
    expect(timers.delay).toBe(PACKAGE_MS);

    runToEnd(runtime, timers);

    const snapshots = messages.filter((message) => message.type === 'snapshot');
    const results = messages.filter((message) => message.type === 'result');
    expect(snapshots.length).toBe(10);
    expect(results.length).toBe(1);
    const final = snapshots.at(-1);
    expect(final?.type === 'snapshot' && final.snapshot.timeMs).toBe(1000);
    expect(final?.type === 'snapshot' && final.snapshot.phase).toBe('completed');
  });

  it('freezes virtual time on pause and continues on resume without catch-up', () => {
    const messages: WorkerMessage[] = [];
    const timers = new ManualTimers();
    const runtime = createSimulationWorkerRuntime((message) => messages.push(message), timers);

    runtime.handleCommand(startCommand('run-2'));
    timers.fireNext();
    const before = messages.filter((message) => message.type === 'snapshot').length;
    runtime.handleCommand({ type: 'pause', runId: 'run-2' });
    expect(timers.size).toBe(0);
    expect(messages).toContainEqual({ type: 'paused', runId: 'run-2' });
    expect(messages.filter((message) => message.type === 'snapshot').length).toBe(before);

    runtime.handleCommand({ type: 'resume', runId: 'run-2' });
    expect(messages).toContainEqual({ type: 'resumed', runId: 'run-2' });
    expect(timers.delay).toBe(PACKAGE_MS);
    timers.fireNext();
    const snapshots = messages.filter((message) => message.type === 'snapshot');
    const after = snapshots.at(-1);
    expect(after?.type === 'snapshot' && after.snapshot.timeMs).toBe(200);
  });

  it('ignores old run ids and acks stop after cancelling', () => {
    const messages: WorkerMessage[] = [];
    const timers = new ManualTimers();
    const runtime = createSimulationWorkerRuntime((message) => messages.push(message), timers);

    runtime.handleCommand(startCommand('run-a'));
    runtime.handleCommand(startCommand('run-b'));
    expect(timers.delay).toBe(PACKAGE_MS);
    const countBefore = messages.length;

    runtime.handleCommand({ type: 'pause', runId: 'run-a' });
    expect(messages.length).toBe(countBefore);

    runtime.handleCommand({ type: 'speed', runId: 'run-b', speed: 4 });
    expect(timers.delay).toBe(PACKAGE_MS / 4);

    runtime.handleCommand({ type: 'stop', runId: 'run-b' });
    expect(timers.size).toBe(0);
    expect(messages.at(-1)).toEqual({ type: 'stopped', runId: 'run-b' });
  });

  it('applies speed changes and caps snapshots at 10 Hz wall time', () => {
    const messages: WorkerMessage[] = [];
    const timers = new ManualTimers();
    const runtime = createSimulationWorkerRuntime((message) => messages.push(message), timers);

    runtime.handleCommand(startCommand('run-3', { speed: 4 }));
    expect(timers.delay).toBe(PACKAGE_MS / 4);

    const snapshotsBefore = messages.filter((message) => message.type === 'snapshot').length;
    for (let index = 0; index < 4; index += 1) {
      timers.fireNext();
    }
    const snapshotsAfter = messages.filter((message) => message.type === 'snapshot').length;
    expect(snapshotsAfter - snapshotsBefore).toBe(1);

    runtime.handleCommand({ type: 'speed', runId: 'run-3', speed: 16 });
    expect(timers.delay).toBe(PACKAGE_MS / 16);
  });

  it('posts bounded traffic frames for the same run and keeps the result payload', () => {
    const messages: WorkerMessage[] = [];
    const timers = new ManualTimers();
    const runtime = createSimulationWorkerRuntime((message) => messages.push(message), timers);

    runtime.handleCommand(startCommand('run-traffic'));
    runToEnd(runtime, timers);

    const traffic = messages.filter((message) => message.type === 'traffic');
    expect(traffic.length).toBeGreaterThan(0);
    expect(traffic.length).toBeLessThanOrEqual(240);
    for (const message of traffic) {
      expect(message.runId).toBe('run-traffic');
      if (message.type !== 'traffic') {
        continue;
      }
      expect(message.frame.levelId).toBe('cold-cache');
      expect(message.frame.scopeId).toBe('cold-cache');
      expect(message.frame.windowMs).toBeGreaterThan(0);
      expect(message.frame.edges.some((edge) => edge.requestsPerSecond > 0)).toBe(
        true,
      );
    }

    const result = messages.find((message) => message.type === 'result');
    // No traffic frame or telemetry field leaks into the run result payload.
    if (result?.type === 'result') {
      expect(Object.keys(result.result).sort()).toEqual([
        'checks',
        'costMicroUsdPerHour',
        'diagnostics',
        'passed',
        'seed',
        'snapshot',
      ]);
    }
  });

  it('reports invalid input as an error message instead of throwing', () => {
    const messages: WorkerMessage[] = [];
    const timers = new ManualTimers();
    const runtime = createSimulationWorkerRuntime((message) => messages.push(message), timers);
    const broken = startCommand('run-bad');
    broken.graph.edges = [];

    expect(() => runtime.handleCommand(broken as WorkerCommand)).not.toThrow();
    const error = messages.find((message) => message.type === 'error');
    expect(error).toMatchObject({ type: 'error', runId: 'run-bad' });
    expect(timers.size).toBe(0);
  });
});
