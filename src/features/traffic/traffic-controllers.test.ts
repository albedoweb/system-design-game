import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_LEVEL,
  createInitialGraph,
  type RunResult,
  type SimulationSnapshot,
  type WorkerCommand,
} from '../../domain';
import { createParcelRunController } from '../../parcel/ui/parcel-run-controller';
import { useParcelStore } from '../../parcel/ui/parcel-store';
import { createParcelGraph } from '../../parcel/graph';
import { createImageRunController } from '../../images/ui/image-run-controller';
import { useImageStore } from '../../images/ui/image-store';
import type { ParcelEvaluation } from '../../parcel/contracts';
import type { ImageEvaluation } from '../../images/contracts';
import { useEditorStore } from '../../state/editor-store';
import { useSessionStore } from '../../state/session-store';
import { createSimulationController } from '../simulation/simulation-controller';
import { observedTrafficFrames, useTrafficStore } from './traffic-store';
import type { TrafficFrame } from '../../simulation/traffic-telemetry';

class FakeWorker {
  readonly posted: unknown[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<EventListener>>();

  postMessage(message: WorkerCommand | unknown): void {
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

function frameFor(
  levelId: TrafficFrame['levelId'],
  scopeId: string,
  timeMs = 1_000,
): TrafficFrame {
  return {
    levelId,
    scopeId,
    scopeLabel: scopeId,
    timeMs,
    windowMs: 1_000,
    phase: 'measured',
    nodes: [
      {
        nodeId: 'app-1',
        resources: [
          {
            key: 'cpu',
            label: 'CPU',
            used: 1,
            capacity: 4,
            unit: 'cores',
            aggregation: 'window-average',
          },
        ],
        requestsPerSecond: 10,
        queue: 0,
        down: false,
      },
    ],
    edges: [
      {
        edgeId: 'route-1',
        requestsPerSecond: 10,
        bytesPerSecond: null,
      },
    ],
  };
}

const snapshot: SimulationSnapshot = {
  timeMs: 1_000,
  phase: 'running',
  reads: {
    offered: 10,
    succeeded: 10,
    failed: 0,
    pending: 0,
    p50Ms: 10,
    p95Ms: 20,
    p99Ms: 30,
    errors: {},
  },
  writes: {
    offered: 10,
    succeeded: 10,
    failed: 0,
    pending: 0,
    p50Ms: 10,
    p95Ms: 20,
    p99Ms: 30,
    errors: {},
  },
  nodes: [],
  series: [],
  events: [],
};

const coldResult: RunResult = {
  seed: 101,
  passed: true,
  costMicroUsdPerHour: 2_600_000,
  checks: [],
  snapshot: { ...snapshot, phase: 'completed', timeMs: 60_800 },
  diagnostics: [],
};

const parcelEvaluation = {
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
} as ParcelEvaluation;

const imageEvaluation = {
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
    requiredScenarios: ['normal'],
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

beforeEach(() => {
  useTrafficStore.getState().reset();
  useSessionStore.getState().reset();
  useEditorStore.getState().loadGraph(createInitialGraph());
  useParcelStore.getState().resetGraph();
  useImageStore.getState().resetGraph();
});

describe('traffic message integration at the UI boundary', () => {
  it('Cold Cache accepts measured frames only while its run is live', () => {
    const worker = new FakeWorker();
    const controller = createSimulationController({
      createWorker: () => worker as unknown as Worker,
      storage: null,
      startTimeoutMs: 1_000,
    });
    controller.start({
      graph: useEditorStore.getState().graph,
      level: DEFAULT_LEVEL,
      seed: 101,
    });
    const runId = useSessionStore.getState().runId;
    expect(runId).toBeTruthy();

    worker.emit({
      type: 'traffic',
      runId,
      frame: frameFor('cold-cache', 'cold-cache'),
    });
    expect(useTrafficStore.getState().liveFrame?.levelId).toBe('cold-cache');

    worker.emit({
      type: 'traffic',
      runId: 'foreign-run',
      frame: frameFor('cold-cache', 'cold-cache', 2_000),
    });
    expect(observedTrafficFrames('cold-cache', runId, 'cold-cache')).toHaveLength(
      1,
    );

    worker.emit({
      type: 'result',
      runId,
      result: coldResult,
    });
    expect(useTrafficStore.getState().mode).toBe('completed');
    expect(useTrafficStore.getState().liveFrame).toBeNull();

    worker.emit({
      type: 'traffic',
      runId,
      frame: frameFor('cold-cache', 'cold-cache', 3_000),
    });
    expect(observedTrafficFrames('cold-cache', runId, 'cold-cache')).toHaveLength(
      1,
    );
    controller.dispose();
  });

  it('Parcel consumes real worker frames and stops them at result or cancel', () => {
    const worker = new FakeWorker();
    const controller = createParcelRunController({
      createWorker: () => worker,
    });
    controller.start({ graph: useParcelStore.getState().graph, seed: 101 });
    const runId = useParcelStore.getState().runId;
    expect(runId).toBeTruthy();

    worker.emit({
      type: 'traffic',
      runId,
      frame: frameFor('parcel-pulse', 'year-1'),
    });
    expect(useTrafficStore.getState().liveFrame?.scopeId).toBe('year-1');

    worker.emit({
      type: 'result',
      runId,
      evaluation: parcelEvaluation,
    });
    expect(useTrafficStore.getState().mode).toBe('completed');
    worker.emit({
      type: 'traffic',
      runId,
      frame: frameFor('parcel-pulse', 'year-5', 2_000),
    });
    expect(useTrafficStore.getState().liveFrame).toBeNull();

    controller.start({
      graph: useParcelStore.getState().graph,
      seed: useParcelStore.getState().seed,
    });
    const secondRunId = useParcelStore.getState().runId;
    worker.emit({
      type: 'traffic',
      runId: secondRunId,
      frame: frameFor('parcel-pulse', 'year-1'),
    });
    expect(useTrafficStore.getState().liveFrame?.scopeId).toBe('year-1');
    controller.cancel();
    expect(useTrafficStore.getState().run).toBeNull();
    controller.dispose();
  });

  it('Image Atlas consumes node and edge frames from its own run', () => {
    const worker = new FakeWorker();
    const controller = createImageRunController({
      createWorker: () => worker,
    });
    controller.start({ graph: useImageStore.getState().graph, seed: 101 });
    const runId = useImageStore.getState().runId;
    expect(runId).toBeTruthy();

    worker.emit({
      type: 'traffic',
      runId,
      frame: frameFor('image-atlas', 'normal'),
    });
    const live = useTrafficStore.getState().liveFrame;
    expect(live?.levelId).toBe('image-atlas');
    expect(live?.nodes[0]?.nodeId).toBe('app-1');
    expect(live?.edges[0]?.edgeId).toBe('route-1');

    worker.emit({
      type: 'result',
      runId,
      evaluation: imageEvaluation,
    });
    expect(useTrafficStore.getState().mode).toBe('completed');
    controller.dispose();
    expect(useTrafficStore.getState().run).toBeNull();
  });

  it('an old completed controller cannot abort a newer run during dispose', () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    let created = 0;
    const createWorker = () => {
      created += 1;
      return created === 1 ? firstWorker : secondWorker;
    };
    const first = createParcelRunController({ createWorker });
    first.start({ graph: createParcelGraph(), seed: 101 });
    const firstRunId = useParcelStore.getState().runId;
    firstWorker.emit({
      type: 'traffic',
      runId: firstRunId,
      frame: frameFor('parcel-pulse', 'year-1'),
    });
    firstWorker.emit({
      type: 'result',
      runId: firstRunId,
      evaluation: parcelEvaluation,
    });

    // Keep the first controller alive after its completed run.
    const second = createParcelRunController({ createWorker });
    second.start({ graph: useParcelStore.getState().graph, seed: 202 });
    const secondRunId = useParcelStore.getState().runId;
    expect(useTrafficStore.getState().run?.runId).toBe(secondRunId);

    first.dispose();
    expect(useTrafficStore.getState().run?.runId).toBe(secondRunId);
    expect(useTrafficStore.getState().mode).toBe('live');

    second.dispose();
    expect(useTrafficStore.getState().run).toBeNull();
  });
});
