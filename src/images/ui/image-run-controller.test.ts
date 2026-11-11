import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createImageGraph } from '../graph';
import type { ImageEvaluation } from '../contracts';
import type { ImageWorkerRequest } from '../worker/image-worker-protocol';
import {
  createImageRunController,
  type ImageWorkerLike,
} from './image-run-controller';
import { useImageStore } from './image-store';

class FakeWorker implements ImageWorkerLike {
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
  useImageStore.setState({
    graph: createImageGraph(),
    selection: null,
    past: [],
    future: [],
    revision: 0,
    pendingMove: null,
    seed: 101,
    selectedScenario: 'normal',
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

const invalidEvaluation = {
  status: 'invalid',
  passed: false,
  meta: {
    schemaVersion: 1,
    modelVersion: '1.0.0',
    contentVersion: '1.0.0',
    pricingVersion: 'image-atlas-catalog-v1',
    levelId: 'image-atlas',
    seed: 101,
    graphDigest: null,
    requestedScenarios: ['normal'],
    requiredScenarios: [
      'normal',
      'peak',
      'node-failure',
      'link-failure',
      'region-na-failure',
      'region-eu-failure',
      'region-ap-failure',
    ],
    qualification: false,
    evaluationKind: 'exploratory',
    datasetDay: 30,
  },
  issues: [],
  diagnostics: [],
  checks: [],
  capacity: null,
  cost: null,
  assumptions: [],
  scenarios: [],
} as unknown as ImageEvaluation;

function requestOf(worker: FakeWorker): ImageWorkerRequest {
  return worker.posted[0] as ImageWorkerRequest;
}

describe('Image Atlas run controller', () => {
  beforeEach(() => {
    resetStore();
    vi.useRealTimers();
  });

  it('uses one worker per run, freezes the graph and ignores foreign run ids', () => {
    const worker = new FakeWorker();
    const controller = createImageRunController({ createWorker: () => worker });
    const current = useImageStore.getState().graph;

    controller.start({ graph: current, seed: 101 });
    const request = requestOf(worker);
    expect(request.graph).not.toBe(current);
    expect(request.graph.nodes).toEqual(current.nodes);
    expect(request.seed).toBe(101);
    expect(useImageStore.getState().runPhase).toBe('running');

    worker.emit({
      type: 'progress',
      runId: 'another-run',
      progress: {
        phase: 'simulate',
        scenario: 'peak',
        completed: 3,
        total: 7,
        message: 'foreign',
      },
    });
    expect(useImageStore.getState().progress?.message).not.toBe('foreign');

    worker.emit({
      type: 'progress',
      runId: request.runId,
      progress: {
        phase: 'simulate',
        scenario: 'normal',
        completed: 1,
        total: 7,
        message: 'Simulating normal daily average',
      },
    });
    expect(useImageStore.getState().progress?.message).toBe(
      'Simulating normal daily average',
    );
    expect(useImageStore.getState().progress?.scenario).toBe('normal');

    worker.emit({
      type: 'result',
      runId: request.runId,
      evaluation: invalidEvaluation,
    });
    expect(useImageStore.getState().runPhase).toBe('completed');
    expect(worker.terminated).toBe(true);
    controller.dispose();
  });

  it('stop terminates the worker and invalidates the run id', () => {
    const worker = new FakeWorker();
    const controller = createImageRunController({ createWorker: () => worker });
    controller.start({ graph: useImageStore.getState().graph, seed: 101 });
    const request = requestOf(worker);
    controller.cancel();
    expect(worker.terminated).toBe(true);
    expect(useImageStore.getState().runPhase).toBe('stopped');
    expect(useImageStore.getState().runId).toBeNull();
    expect(useImageStore.getState().result).toBeNull();

    // A late message from the stopped run must not be accepted.
    worker.emit({
      type: 'result',
      runId: request.runId,
      evaluation: invalidEvaluation,
    });
    expect(useImageStore.getState().runPhase).toBe('stopped');
    expect(useImageStore.getState().result).toBeNull();
  });

  it('cannot be overwritten by an older run after a newer run starts', () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    let current = firstWorker;
    const controller = createImageRunController({ createWorker: () => current });
    const workerQueue = [firstWorker, secondWorker];
    current = workerQueue.shift()!;
    controller.start({ graph: useImageStore.getState().graph, seed: 101 });
    const first = requestOf(firstWorker);
    const firstRunId = useImageStore.getState().runId;

    current = secondWorker;
    controller.start({ graph: useImageStore.getState().graph, seed: 211 });
    const secondRunId = useImageStore.getState().runId;
    expect(secondRunId).not.toBe(firstRunId);
    expect(firstWorker.terminated).toBe(true);

    // The first worker was disposed, but even a leaked callback for the old run
    // id must be rejected by the store guard.
    useImageStore.getState().completeRun(first.runId, {
      evaluation: invalidEvaluation,
      seed: 101,
      digest: 'old',
    });
    expect(useImageStore.getState().runPhase).toBe('running');
    expect(useImageStore.getState().result).toBeNull();

    const second = requestOf(secondWorker);
    secondWorker.emit({
      type: 'result',
      runId: second.runId,
      evaluation: invalidEvaluation,
    });
    expect(useImageStore.getState().runPhase).toBe('completed');
    expect(useImageStore.getState().resultSeed).toBe(211);
    controller.dispose();
  });

  it('dispose cancels only the run owned by that controller', () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    const firstController = createImageRunController({
      createWorker: () => first,
    });
    firstController.start({ graph: useImageStore.getState().graph, seed: 101 });
    const firstRunId = useImageStore.getState().runId;
    expect(firstRunId).not.toBeNull();

    firstController.dispose();
    expect(first.terminated).toBe(true);
    expect(useImageStore.getState().runPhase).toBe('stopped');

    const secondController = createImageRunController({
      createWorker: () => second,
    });
    secondController.start({ graph: useImageStore.getState().graph, seed: 211 });
    const secondRunId = useImageStore.getState().runId;
    expect(secondRunId).not.toBe(firstRunId);

    firstController.dispose();
    expect(useImageStore.getState().runPhase).toBe('running');
    expect(useImageStore.getState().runId).toBe(secondRunId);

    secondController.dispose();
    expect(second.terminated).toBe(true);
    expect(useImageStore.getState().runPhase).toBe('stopped');
  });

  it('blocks on validation errors before creating a worker', () => {
    const createWorker = vi.fn(() => new FakeWorker());
    const controller = createImageRunController({ createWorker });
    const base = createImageGraph();
    const broken = {
      ...base,
      nodes: base.nodes.filter((node) => node.kind !== 'metadata'),
      edges: base.edges.filter((edge) => edge.operation !== 'metadata'),
    };
    useImageStore.getState().replaceGraph(broken);
    controller.start({ graph: useImageStore.getState().graph, seed: 101 });
    expect(createWorker).not.toHaveBeenCalled();
    expect(useImageStore.getState().runPhase).toBe('blocked');
    expect(useImageStore.getState().runIssues.length).toBeGreaterThan(0);
  });

  it('surfaces a worker error and terminates it', () => {
    const worker = new FakeWorker();
    const controller = createImageRunController({ createWorker: () => worker });
    controller.start({ graph: useImageStore.getState().graph, seed: 101 });
    const request = requestOf(worker);
    worker.emit({
      type: 'error',
      runId: request.runId,
      message: 'Engine exploded',
    });
    expect(useImageStore.getState().runPhase).toBe('error');
    expect(useImageStore.getState().runError).toBe('Engine exploded');
    expect(worker.terminated).toBe(true);
  });

  it('reports a missing engine clearly instead of pretending to simulate', () => {
    const worker = new FakeWorker();
    const controller = createImageRunController({ createWorker: () => worker });
    controller.start({ graph: useImageStore.getState().graph, seed: 101 });
    const request = requestOf(worker);
    worker.emit({
      type: 'error',
      runId: request.runId,
      message: 'Failed to resolve module ../evaluate',
    });
    expect(useImageStore.getState().runPhase).toBe('error');
    expect(useImageStore.getState().runError).toMatch(/evaluator is not available/i);
  });
});
