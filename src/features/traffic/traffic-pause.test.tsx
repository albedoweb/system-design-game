import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LEVEL,
  createInitialGraph,
  type RunResult,
  type SimulationSnapshot,
} from '../../domain';
import { useEditorStore } from '../../state/editor-store';
import { useSessionStore } from '../../state/session-store';
import { createSimulationController } from '../simulation/simulation-controller';
import type { TrafficFrame } from '../../simulation/traffic-telemetry';
import { useTrafficCanvasView } from './use-traffic-view';
import { useTrafficStore } from './traffic-store';

class FakeWorker {
  terminated = false;
  private readonly listeners = new Map<string, Set<EventListener>>();

  postMessage(): void {}

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

function frame(timeMs: number): TrafficFrame {
  return {
    levelId: 'cold-cache',
    scopeId: 'cold-cache',
    scopeLabel: 'Cold Cache',
    timeMs,
    windowMs: 1_000,
    phase: 'measured',
    nodes: [],
    edges: [],
  };
}

function CanvasHarness({ runId }: { runId: string }) {
  const view = useTrafficCanvasView('cold-cache', runId);
  return (
    <div>
      <span data-testid="animate">{String(view.animate)}</span>
      <span data-testid="paused">{String(view.paused)}</span>
      <span data-testid="label">{view.modeLabel}</span>
      <span data-testid="time">{view.frame?.timeMs ?? 'none'}</span>
    </div>
  );
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

const result: RunResult = {
  seed: 101,
  passed: true,
  costMicroUsdPerHour: 2_600_000,
  checks: [],
  snapshot: { ...snapshot, phase: 'completed', timeMs: 60_800 },
  diagnostics: [],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  useSessionStore.getState().reset();
  useEditorStore.getState().loadGraph(createInitialGraph());
  useTrafficStore.getState().reset();
});

afterEach(() => {
  useTrafficStore.getState().reset();
  vi.useRealTimers();
});

describe('Cold Cache paused traffic animation', () => {
  it('stops motion immediately, keeps the last sample static and resumes motion', () => {
    const worker = new FakeWorker();
    const controller = createSimulationController({
      createWorker: () => worker as unknown as Worker,
      storage: null,
      startTimeoutMs: 1_000,
    });
    act(() => {
      controller.start({
        graph: useEditorStore.getState().graph,
        level: DEFAULT_LEVEL,
        seed: 101,
      });
    });
    const runId = useSessionStore.getState().runId;
    expect(runId).toBeTruthy();
    if (!runId) {
      throw new Error('runId not created');
    }

    render(<CanvasHarness runId={runId} />);
    act(() => {
      worker.emit({ type: 'snapshot', runId, snapshot });
      worker.emit({ type: 'traffic', runId, frame: frame(1_000) });
    });
    expect(screen.getByTestId('animate')).toHaveTextContent('true');
    expect(screen.getByTestId('label')).toHaveTextContent('Live snapshot');

    // A second frame lands inside the coalescing window and is still pending.
    act(() => {
      worker.emit({ type: 'traffic', runId, frame: frame(2_000) });
      controller.pause();
    });
    expect(screen.getByTestId('animate')).toHaveTextContent('false');
    expect(screen.getByTestId('paused')).toHaveTextContent('true');
    expect(screen.getByTestId('label')).toHaveTextContent(
      'Paused · Cold Cache · t=1 s',
    );
    expect(screen.getByTestId('time')).toHaveTextContent('1000');

    // Neither the queued pre-pause update nor later frames may move the canvas.
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByTestId('animate')).toHaveTextContent('false');
    expect(screen.getByTestId('time')).toHaveTextContent('1000');

    act(() => {
      worker.emit({ type: 'traffic', runId, frame: frame(3_000) });
    });
    expect(screen.getByTestId('time')).toHaveTextContent('1000');
    expect(screen.getByTestId('animate')).toHaveTextContent('false');

    act(() => {
      controller.resume();
    });
    expect(screen.getByTestId('animate')).toHaveTextContent('true');
    expect(screen.getByTestId('paused')).toHaveTextContent('false');
    expect(screen.getByTestId('label')).toHaveTextContent('Live snapshot');

    act(() => {
      worker.emit({ type: 'traffic', runId, frame: frame(4_000) });
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByTestId('time')).toHaveTextContent('4000');
    expect(screen.getByTestId('animate')).toHaveTextContent('true');

    act(() => {
      worker.emit({ type: 'result', runId, result });
    });
    expect(screen.getByTestId('animate')).toHaveTextContent('false');
    expect(screen.getByTestId('label')).toHaveTextContent('Run average');
    controller.dispose();
  });
});
