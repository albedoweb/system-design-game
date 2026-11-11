import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LEVEL,
  createInitialGraph,
  type Metric,
  type RunResult,
  type SimulationSnapshot,
  type WorkerCommand,
} from '../../domain';
import { isSessionLocked, useSessionStore } from '../../state/session-store';
import { useEditorStore } from '../../state/editor-store';
import { createSimulationController } from './simulation-controller';

class FakeWorker {
  sent: WorkerCommand[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  postMessage(message: WorkerCommand): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    const fn =
      typeof listener === 'function'
        ? listener
        : (event: Event) => listener.handleEvent(event);
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    const fn =
      typeof listener === 'function'
        ? listener
        : (event: Event) => listener.handleEvent(event);
    this.listeners.get(type)?.delete(fn);
  }

  emitMessage(data: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data } as MessageEvent);
    }
  }
}

const metric: Metric = {
  offered: 10,
  succeeded: 10,
  failed: 0,
  pending: 0,
  p50Ms: 10,
  p95Ms: 20,
  p99Ms: 30,
  errors: {},
};

const snapshot: SimulationSnapshot = {
  timeMs: 1_000,
  phase: 'running',
  reads: metric,
  writes: metric,
  nodes: [],
  series: [],
  events: [],
};

const result: RunResult = {
  seed: 101,
  passed: true,
  costMicroUsdPerHour: 2_600_000,
  checks: [],
  snapshot: { ...snapshot, phase: 'completed', timeMs: 60_800 },
  diagnostics: [],
};

function setup(timeoutMs = 1_000) {
  const fake = new FakeWorker();
  const controller = createSimulationController({
    createWorker: () => fake as unknown as Worker,
    storage: null,
    startTimeoutMs: timeoutMs,
    stopTimeoutMs: 500,
  });
  return { fake, controller };
}

function start(controller: ReturnType<typeof createSimulationController>) {
  controller.start({
    graph: useEditorStore.getState().graph,
    level: DEFAULT_LEVEL,
    seed: 101,
  });
  const started = useSessionStore.getState();
  const runId = started.runId;
  if (!runId) {
    throw new Error('runId не создан');
  }
  return runId;
}

describe('simulation controller', () => {
  beforeEach(() => {
    useSessionStore.getState().reset();
    useEditorStore.getState().loadGraph(createInitialGraph());
    vi.useFakeTimers();
  });

  it('запускает worker, принимает snapshot и управляет паузой', () => {
    const { fake, controller } = setup();
    const runId = start(controller);
    expect(useSessionStore.getState().phase).toBe('starting');
    expect(useSessionStore.getState().snapshotRevision).toBe(0);
    expect(useSessionStore.getState().snapshotSeed).toBe(101);
    expect(fake.sent[0]).toMatchObject({
      type: 'start',
      runId,
      seed: 101,
      speed: 1,
    });

    fake.emitMessage({ type: 'snapshot', runId, snapshot });
    expect(useSessionStore.getState().phase).toBe('running');
    expect(useSessionStore.getState().snapshot).toEqual(snapshot);

    controller.pause();
    expect(fake.sent.at(-1)).toMatchObject({ type: 'pause', runId });
    expect(useSessionStore.getState().phase).toBe('paused');

    controller.resume();
    expect(fake.sent.at(-1)).toMatchObject({ type: 'resume', runId });
    expect(useSessionStore.getState().phase).toBe('running');
  });

  it('игнорирует result от чужого runId', () => {
    const { fake, controller } = setup();
    start(controller);

    fake.emitMessage({ type: 'result', runId: 'run-stale', result });
    expect(useSessionStore.getState().result).toBeNull();
    expect(fake.terminated).toBe(false);
  });

  it('завершает run, сохраняет итог и освобождает worker', () => {
    const { fake, controller } = setup();
    const runId = start(controller);

    fake.emitMessage({ type: 'result', runId, result });
    const state = useSessionStore.getState();
    expect(state.phase).toBe('completed');
    expect(state.result).toEqual(result);
    expect(state.resultRevision).toBe(0);
    expect(fake.terminated).toBe(true);
  });

  it('очищает worker при stop', () => {
    const { fake, controller } = setup();
    const runId = start(controller);
    fake.emitMessage({ type: 'snapshot', runId, snapshot });

    controller.stop();
    expect(fake.sent.at(-1)).toMatchObject({ type: 'stop', runId });
    expect(useSessionStore.getState().phase).toBe('stopping');

    fake.emitMessage({ type: 'stopped', runId });
    expect(useSessionStore.getState().phase).toBe('stopped');
    expect(fake.terminated).toBe(true);
    expect(useSessionStore.getState().notice).toMatch(/stopped/i);
  });

  it('не перетирает завершённый результат таймером stop', () => {
    const { fake, controller } = setup();
    const runId = start(controller);
    fake.emitMessage({ type: 'snapshot', runId, snapshot });

    controller.stop();
    fake.emitMessage({ type: 'result', runId, result });
    expect(useSessionStore.getState().phase).toBe('completed');
    vi.advanceTimersByTime(600);
    expect(useSessionStore.getState().phase).toBe('completed');
  });

  it('держит граф заблокированным до подтверждения stop', () => {
    const { fake, controller } = setup();
    const runId = start(controller);
    fake.emitMessage({ type: 'snapshot', runId, snapshot });

    controller.stop();
    expect(useSessionStore.getState().phase).toBe('stopping');
    expect(isSessionLocked(useSessionStore.getState().phase)).toBe(true);

    vi.advanceTimersByTime(500);
    expect(useSessionStore.getState().phase).toBe('stopped');
    expect(isSessionLocked(useSessionStore.getState().phase)).toBe(false);
    expect(fake.terminated).toBe(true);
  });

  it('помечает результат revision входа прогона, а не правкой в окне stop', () => {
    const { fake, controller } = setup();
    const runId = start(controller);
    fake.emitMessage({ type: 'snapshot', runId, snapshot });
    expect(useEditorStore.getState().configRevision).toBe(0);

    controller.stop();
    // A model edit landing between the stop request and its acknowledgement.
    useEditorStore.getState().updateNodeConfig('db-1', { poolSize: 16 });
    expect(useEditorStore.getState().configRevision).toBe(1);

    fake.emitMessage({ type: 'result', runId, result });
    const state = useSessionStore.getState();
    expect(state.phase).toBe('completed');
    expect(state.resultRevision).toBe(0);
    expect(useEditorStore.getState().configRevision).toBe(1);
  });

  it('сохраняет revision, снятый при старте прогона', () => {
    useEditorStore.getState().updateNodeConfig('db-1', { poolSize: 16 });
    const { fake, controller } = setup();
    const runId = start(controller);

    useEditorStore.getState().updateNodeConfig('db-1', { poolSize: 32 });
    fake.emitMessage({ type: 'result', runId, result });

    expect(useSessionStore.getState().resultRevision).toBe(1);
    expect(useEditorStore.getState().configRevision).toBe(2);
  });

  it('оставляет восстановимые контролы при таймауте старта', () => {
    const { fake, controller } = setup(100);
    start(controller);
    vi.advanceTimersByTime(100);

    const state = useSessionStore.getState();
    expect(state.phase).toBe('error');
    expect(state.error).toMatch(/did not respond in time/i);
    expect(fake.terminated).toBe(true);

    controller.dispose();
  });

  it('отправляет скорость только активному worker', () => {
    const { fake, controller } = setup();
    controller.setSpeed(4);
    expect(useSessionStore.getState().speed).toBe(4);
    expect(fake.sent).toHaveLength(0);

    const runId = start(controller);
    controller.setSpeed(16);
    expect(fake.sent.at(-1)).toMatchObject({ type: 'speed', runId, speed: 16 });
  });
});
