import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseAudienceGraph,
  type AudienceGraph,
  type AudienceProgress,
} from '../index';
import type { AudienceWorkerRequest } from '../worker/audience-worker-protocol';
import projectionFixture from '../../../fixtures/audience/family-projection.json';
import {
  observedTrafficFrames,
  useTrafficStore,
} from '../../features/traffic/traffic-store';
import {
  AUDIENCE_TRAFFIC_LEVEL,
  createAudienceRunController,
} from './audience-run-controller';
import { useAudienceStore } from './audience-store';

function graph(): AudienceGraph {
  const parsed = parseAudienceGraph(projectionFixture);
  if (!parsed.ok) {
    throw new Error(parsed.issues[0]?.message ?? 'fixture did not parse');
  }
  return parsed.value;
}

class FakeWorker {
  readonly sent: AudienceWorkerRequest[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<EventListener>>();

  postMessage(message: unknown): void {
    this.sent.push(message as AudienceWorkerRequest);
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
      listener(new MessageEvent('message', { data }));
    }
  }
}

function traffic(timeMs: number, caseId: 'normal' | 'peak' = 'normal') {
  return {
    type: 'traffic' as const,
    runId: 'run',
    frame: {
      levelId: AUDIENCE_TRAFFIC_LEVEL,
      scopeId: caseId,
      scopeLabel: caseId,
      timeMs,
      windowMs: 1_000,
      phase: 'measured' as const,
      nodes: [],
      edges: [],
    },
  };
}

beforeEach(() => {
  useAudienceStore.getState().resetGraph();
  useTrafficStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('audience browser run controller', () => {
  it('keeps the per-scope frame cap but resets it for the next case', () => {
    const worker = new FakeWorker();
    const controller = createAudienceRunController({
      createWorker: () => worker,
      maxTrafficFrames: 2,
      cancelGraceMs: 5,
    });
    controller.start({ graph: graph(), seed: 101 });
    const run = worker.sent[0];
    expect(run?.type).toBe('run');
    const runId = run?.runId ?? '';
    expect(useAudienceStore.getState().runPhase).toBe('running');

    worker.emit({ ...traffic(1_000), runId });
    worker.emit({ ...traffic(2_000), runId });
    worker.emit({ ...traffic(3_000), runId });
    expect(useTrafficStore.getState().run?.runId).toBe(runId);
    const accepted = (caseId: 'normal' | 'peak') =>
      observedTrafficFrames(AUDIENCE_TRAFFIC_LEVEL, runId, caseId).map(
        (frame) => frame.timeMs,
      );
    expect(accepted('normal')).toEqual([1_000, 2_000]);

    // A new case has its own scope and starts its 240-frame budget again.
    worker.emit({ ...traffic(0, 'peak'), runId });
    expect(accepted('normal')).toEqual([1_000, 2_000]);
    expect(accepted('peak')).toEqual([0]);
    controller.dispose();
  });

  it('cancels without ever turning the stopped run into a pass', () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const controller = createAudienceRunController({
      createWorker: () => worker,
      maxTrafficFrames: 2,
      cancelGraceMs: 5,
    });
    controller.start({ graph: graph(), seed: 101 });
    const runId = worker.sent[0]?.runId ?? '';
    worker.emit({
      type: 'progress',
      runId,
      progress: {
        phase: 'run',
        caseId: 'peak',
        nowMs: 20_000,
        measuredElapsedMs: 20_000,
        completedRequests: 10,
        totalRequests: 100,
        message: 'running',
      } satisfies AudienceProgress,
    });
    expect(useAudienceStore.getState().runPhase).toBe('running');
    expect(useAudienceStore.getState().progress?.caseId).toBe('peak');

    controller.cancel();
    expect(useAudienceStore.getState().runPhase).toBe('stopping');
    expect(worker.sent.some((message) => message.type === 'cancel')).toBe(true);

    vi.advanceTimersByTime(10);
    const stopped = useAudienceStore.getState();
    expect(stopped.runPhase).toBe('stopped');
    expect(stopped.result).toBeNull();

    // A late result from the cancelled worker is ignored by run id/phase.
    worker.emit({ type: 'result', runId, evaluation: { passed: true } });
    expect(useAudienceStore.getState().result).toBeNull();
    controller.dispose();
  });
});
