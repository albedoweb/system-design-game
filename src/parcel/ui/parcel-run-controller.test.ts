import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createParcelGraph } from '../graph';
import type { ParcelEvaluation } from '../contracts';
import type { ParcelWorkerRequest } from '../worker/parcel-worker-protocol';
import {
  createParcelRunController,
  type ParcelWorkerLike,
} from './parcel-run-controller';
import { useParcelStore } from './parcel-store';

class FakeWorker implements ParcelWorkerLike {
  readonly posted: unknown[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<EventListener>>();

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data } as MessageEvent);
    }
  }
}

function resetStore(): void {
  useParcelStore.setState({
    graph: createParcelGraph(),
    selection: null,
    past: [],
    future: [],
    revision: 0,
    pendingMove: null,
    seed: 101,
    selectedHorizon: 5,
    runPhase: 'idle',
    runId: null,
    progress: null,
    result: null,
    resultDigest: null,
    resultSeed: null,
    runIssues: [],
    runError: null,
    runStartedAt: null,
    runFinishedAt: null,
    hydrated: true,
  });
}

const invalidEvaluation: ParcelEvaluation = {
  status: 'invalid',
  passed: false,
  meta: {
    schemaVersion: 1,
    modelVersion: '1.0.0',
    pricingVersion: 'parcel-catalog-v1',
    contentVersion: '1.0.0',
    levelId: 'parcel-pulse',
    seed: 101,
    graphDigest: null,
    requestedHorizons: [1, 5],
    requiredHorizons: [1, 5],
    sampleFactor: 1,
  },
  horizons: [],
  capacity: null,
  cost: null,
  checks: [],
  issues: [],
  diagnostics: [],
  assumptions: [],
};

function requestOf(worker: FakeWorker): ParcelWorkerRequest {
  return worker.posted[0] as ParcelWorkerRequest;
}

describe('Parcel run controller', () => {
  beforeEach(() => {
    resetStore();
    vi.useRealTimers();
  });

  it('uses one worker per run, clones the graph and ignores foreign run ids', () => {
    const worker = new FakeWorker();
    const controller = createParcelRunController({
      createWorker: () => worker,
    });
    const current = useParcelStore.getState().graph;

    controller.start({ graph: current, seed: 101 });
    const request = requestOf(worker);
    expect(request.graph).not.toBe(current);
    expect(request.graph.nodes).toEqual(current.nodes);
    expect(useParcelStore.getState().runPhase).toBe('running');

    worker.emit({
      type: 'progress',
      runId: 'another-run',
      progress: {
        phase: 'simulate',
        horizonYears: 5,
        completed: 1,
        total: 2,
        message: 'foreign',
      },
    });
    expect(useParcelStore.getState().progress?.message).not.toBe('foreign');
    expect(useParcelStore.getState().progress?.message).toBe(
      'Preparing the frozen graph and seed…',
    );

    worker.emit({
      type: 'progress',
      runId: request.runId,
      progress: {
        phase: 'simulate',
        horizonYears: 1,
        completed: 1,
        total: 2,
        message: 'Simulating year 1',
      },
    });
    expect(useParcelStore.getState().progress?.message).toBe('Simulating year 1');

    worker.emit({
      type: 'result',
      runId: request.runId,
      evaluation: invalidEvaluation,
    });
    expect(useParcelStore.getState().runPhase).toBe('completed');
    expect(worker.terminated).toBe(true);
    controller.dispose();
  });

  it('cancel terminates the worker and produces no partial result', () => {
    const worker = new FakeWorker();
    const controller = createParcelRunController({
      createWorker: () => worker,
    });
    controller.start({ graph: useParcelStore.getState().graph, seed: 101 });
    controller.cancel();
    expect(worker.terminated).toBe(true);
    expect(useParcelStore.getState().runPhase).toBe('stopped');
    expect(useParcelStore.getState().result).toBeNull();
  });

  it('dispose cancels only the run owned by that controller', () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    const firstController = createParcelRunController({
      createWorker: () => first,
    });
    firstController.start({ graph: useParcelStore.getState().graph, seed: 101 });
    const firstRunId = useParcelStore.getState().runId;
    expect(firstRunId).not.toBeNull();

    firstController.dispose();
    expect(first.terminated).toBe(true);
    expect(useParcelStore.getState().runPhase).toBe('stopped');
    expect(useParcelStore.getState().runId).toBeNull();

    const secondController = createParcelRunController({
      createWorker: () => second,
    });
    secondController.start({ graph: useParcelStore.getState().graph, seed: 211 });
    const secondRunId = useParcelStore.getState().runId;
    expect(secondRunId).not.toBe(firstRunId);

    // An old controller must not cancel a newer run it does not own.
    firstController.dispose();
    expect(useParcelStore.getState().runPhase).toBe('running');
    expect(useParcelStore.getState().runId).toBe(secondRunId);

    secondController.dispose();
    expect(second.terminated).toBe(true);
    expect(useParcelStore.getState().runPhase).toBe('stopped');
  });

  it('blocks a run before creating a worker when validation finds errors', () => {
    const createWorker = vi.fn(() => new FakeWorker());
    const controller = createParcelRunController({ createWorker });
    const broken = {
      ...createParcelGraph(),
      nodes: createParcelGraph().nodes.filter((node) => node.kind !== 'app'),
      edges: [],
    };
    useParcelStore.getState().replaceGraph(broken);
    controller.start({ graph: useParcelStore.getState().graph, seed: 101 });
    expect(createWorker).not.toHaveBeenCalled();
    expect(useParcelStore.getState().runPhase).toBe('blocked');
    expect(useParcelStore.getState().runIssues.length).toBeGreaterThan(0);
  });

  it('surfaces worker errors and terminates', () => {
    const worker = new FakeWorker();
    const controller = createParcelRunController({
      createWorker: () => worker,
    });
    controller.start({ graph: useParcelStore.getState().graph, seed: 101 });
    const request = requestOf(worker);
    worker.emit({
      type: 'error',
      runId: request.runId,
      message: 'Engine exploded',
    });
    expect(useParcelStore.getState().runPhase).toBe('error');
    expect(useParcelStore.getState().runError).toBe('Engine exploded');
    expect(worker.terminated).toBe(true);
  });
});
