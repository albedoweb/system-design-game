import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerCommand } from '../../domain';
import { SimulationWorkerClient } from './worker-client';

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

  emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  emitMessage(data: unknown): void {
    this.emit('message', { data } as MessageEvent);
  }

  emitError(message: string): void {
    this.emit('error', { message } as ErrorEvent);
  }
}

function makeClient(fake: FakeWorker, runId: string) {
  const handlers = {
    onSnapshot: vi.fn(),
    onResult: vi.fn(),
    onPaused: vi.fn(),
    onResumed: vi.fn(),
    onStopped: vi.fn(),
    onError: vi.fn(),
  };
  const client = new SimulationWorkerClient(
    () => fake as unknown as Worker,
    runId,
    handlers,
    1_000,
  );
  return { client, handlers };
}

describe('SimulationWorkerClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('игнорирует сообщения чужого runId', () => {
    const fake = new FakeWorker();
    const { handlers } = makeClient(fake, 'run-current');

    fake.emitMessage({ type: 'snapshot', runId: 'run-stale', snapshot: {} });
    fake.emitMessage({ type: 'paused', runId: 'run-stale' });
    expect(handlers.onSnapshot).not.toHaveBeenCalled();
    expect(handlers.onPaused).not.toHaveBeenCalled();

    fake.emitMessage({ type: 'paused', runId: 'run-current' });
    expect(handlers.onPaused).toHaveBeenCalledTimes(1);
  });

  it('завершает worker и отписывается после result', () => {
    const fake = new FakeWorker();
    const { handlers } = makeClient(fake, 'run-1');

    fake.emitMessage({
      type: 'result',
      runId: 'run-1',
      result: { passed: true },
    });
    expect(handlers.onResult).toHaveBeenCalledTimes(1);
    expect(fake.terminated).toBe(true);
    expect(fake.sent).toHaveLength(0);
  });

  it('сообщает об ошибке загрузки worker и завершает его', () => {
    const fake = new FakeWorker();
    const { handlers } = makeClient(fake, 'run-1');

    fake.emitError('Could not load module');
    expect(handlers.onError).toHaveBeenCalledWith(
      expect.stringContaining('Could not load module'),
    );
    expect(fake.terminated).toBe(true);
  });

  it('завершает worker по таймауту старта', () => {
    const fake = new FakeWorker();
    const { handlers, client } = makeClient(fake, 'run-1');

    vi.advanceTimersByTime(1_000);
    expect(handlers.onError).toHaveBeenCalledWith(
      expect.stringContaining('did not respond in time'),
    );
    expect(fake.terminated).toBe(true);
    client.dispose();
  });
});
