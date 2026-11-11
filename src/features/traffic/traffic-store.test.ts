import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TrafficFrame } from '../../simulation/traffic-telemetry';
import {
  observedTrafficFrames,
  observedTrafficScopes,
  TRAFFIC_MAX_FRAMES_TOTAL,
  useTrafficStore,
} from './traffic-store';

function frame(
  overrides: Partial<TrafficFrame> = {},
): TrafficFrame {
  return {
    levelId: 'parcel-pulse',
    scopeId: 'year-1',
    scopeLabel: 'Year 1',
    timeMs: 1_000,
    windowMs: 1_000,
    phase: 'measured',
    nodes: [
      {
        nodeId: 'app-1',
        resources: [
          {
            key: 'cpu',
            label: 'CPU',
            used: 2,
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
    ...overrides,
  };
}

function begin(runId = 'run-1'): void {
  useTrafficStore.getState().beginRun({
    levelId: 'parcel-pulse',
    runId,
    binding: 'parcel-pulse|digestabc|seed101',
  });
}

beforeEach(() => {
  useTrafficStore.getState().reset();
});

afterEach(() => {
  useTrafficStore.getState().reset();
  vi.useRealTimers();
});

describe('shared traffic store', () => {
  it('accepts frames only for the active level and run, and never after finish', () => {
    begin();
    const state = useTrafficStore.getState();
    expect(
      state.acceptFrame({
        levelId: 'image-atlas',
        runId: 'run-1',
        frame: frame({ levelId: 'image-atlas' }),
      }),
    ).toBe(false);
    expect(
      state.acceptFrame({
        levelId: 'parcel-pulse',
        runId: 'other',
        frame: frame(),
      }),
    ).toBe(false);
    expect(
      state.acceptFrame({
        levelId: 'parcel-pulse',
        runId: 'run-1',
        frame: frame(),
      }),
    ).toBe(true);
    expect(useTrafficStore.getState().liveFrame?.scopeId).toBe('year-1');

    useTrafficStore.getState().completeRun('run-1');
    expect(useTrafficStore.getState().mode).toBe('completed');
    expect(useTrafficStore.getState().liveFrame).toBeNull();
    expect(
      useTrafficStore.getState().acceptFrame({
        levelId: 'parcel-pulse',
        runId: 'run-1',
        frame: frame({ timeMs: 2_000 }),
      }),
    ).toBe(false);
  });

  it('shows the first frame immediately and coalesces a wall-clock flood', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    begin();
    useTrafficStore.getState().acceptFrame({
      levelId: 'parcel-pulse',
      runId: 'run-1',
      frame: frame({ timeMs: 1_000 }),
    });
    expect(useTrafficStore.getState().liveFrame?.timeMs).toBe(1_000);

    useTrafficStore.getState().acceptFrame({
      levelId: 'parcel-pulse',
      runId: 'run-1',
      frame: frame({ timeMs: 2_000 }),
    });
    // The latest frame is buffered but the UI update is coalesced.
    expect(useTrafficStore.getState().liveFrame?.timeMs).toBe(1_000);
    vi.advanceTimersByTime(100);
    expect(useTrafficStore.getState().liveFrame?.timeMs).toBe(2_000);

    expect(observedTrafficFrames('parcel-pulse', 'run-1', 'year-1')).toHaveLength(
      2,
    );
  });

  it('bounds per-scope and total recorded frames for replay', () => {
    begin();
    for (let index = 0; index < 250; index += 1) {
      useTrafficStore.getState().acceptFrame({
        levelId: 'parcel-pulse',
        runId: 'run-1',
        frame: frame({ timeMs: index * 1_000 }),
      });
    }
    const yearOne = observedTrafficFrames('parcel-pulse', 'run-1', 'year-1');
    expect(yearOne).toHaveLength(240);
    expect(yearOne[0]?.timeMs).toBe(10_000);

    useTrafficStore.getState().reset();
    begin('run-2');
    for (let scope = 0; scope < 12; scope += 1) {
      for (let index = 0; index < 200; index += 1) {
        useTrafficStore.getState().acceptFrame({
          levelId: 'parcel-pulse',
          runId: 'run-2',
          frame: frame({
            scopeId: `scope-${scope}`,
            scopeLabel: `Scope ${scope}`,
            timeMs: index * 1_000,
          }),
        });
      }
    }
    const total = observedTrafficScopes('parcel-pulse', 'run-2').reduce(
      (sum, scope) => sum + scope.frameCount,
      0,
    );
    expect(total).toBe(TRAFFIC_MAX_FRAMES_TOTAL);
  });

  it('replays recorded samples as a view-only timeline', () => {
    begin();
    useTrafficStore.getState().acceptFrame({
      levelId: 'parcel-pulse',
      runId: 'run-1',
      frame: frame({ timeMs: 1_000 }),
    });
    useTrafficStore.getState().completeRun('run-1');
    expect(useTrafficStore.getState().mode).toBe('completed');

    useTrafficStore.getState().startReplay('year-1');
    expect(useTrafficStore.getState().mode).toBe('replay-playing');
    expect(useTrafficStore.getState().replayFrame?.timeMs).toBe(1_000);

    useTrafficStore.getState().pauseReplay();
    expect(useTrafficStore.getState().mode).toBe('replay-paused');
    useTrafficStore.getState().playReplay();
    expect(useTrafficStore.getState().mode).toBe('replay-playing');
    useTrafficStore.getState().seekReplay(0);
    expect(useTrafficStore.getState().mode).toBe('replay-paused');
    useTrafficStore.getState().exitReplay();
    expect(useTrafficStore.getState().mode).toBe('completed');
    expect(useTrafficStore.getState().replayFrame).toBeNull();
  });

  it('drops the buffer when the graph or seed binding changes', () => {
    begin();
    useTrafficStore.getState().acceptFrame({
      levelId: 'parcel-pulse',
      runId: 'run-1',
      frame: frame(),
    });
    expect(observedTrafficScopes('parcel-pulse', 'run-1')).toHaveLength(1);

    useTrafficStore.getState().syncRunBinding({
      levelId: 'parcel-pulse',
      runId: 'run-1',
      binding: 'parcel-pulse|digestCHANGED|seed101',
    });
    expect(useTrafficStore.getState().run).toBeNull();
    expect(observedTrafficScopes('parcel-pulse', 'run-1')).toHaveLength(0);

    useTrafficStore.getState().syncRunBinding({
      levelId: 'parcel-pulse',
      runId: null,
      binding: 'anything',
    });
    expect(useTrafficStore.getState().mode).toBe('idle');
  });

  it('aborts only the matching run', () => {
    begin('run-1');
    useTrafficStore.getState().abortRun('run-2');
    expect(useTrafficStore.getState().run?.runId).toBe('run-1');
    useTrafficStore.getState().abortRun('run-1');
    expect(useTrafficStore.getState().run).toBeNull();
  });
});
