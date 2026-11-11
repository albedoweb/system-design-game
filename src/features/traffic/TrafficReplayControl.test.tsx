import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createParcelGraph } from '../../parcel/graph';
import { useParcelStore } from '../../parcel/ui/parcel-store';
import type { TrafficFrame } from '../../simulation/traffic-telemetry';
import { TrafficReplayControl } from './TrafficReplayControl';
import { useTrafficStore } from './traffic-store';

function frame(timeMs: number): TrafficFrame {
  return {
    levelId: 'parcel-pulse',
    scopeId: 'year-1',
    scopeLabel: 'Year 1',
    timeMs,
    windowMs: 1_000,
    phase: 'measured',
    nodes: [],
    edges: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  useTrafficStore.getState().reset();
  useParcelStore.getState().resetGraph();
  useTrafficStore.getState().beginRun({
    levelId: 'parcel-pulse',
    runId: 'run-1',
    binding: 'parcel-pulse|digestabc|seed101',
  });
  useTrafficStore.getState().acceptFrame({
    levelId: 'parcel-pulse',
    runId: 'run-1',
    frame: frame(1_000),
  });
  useTrafficStore.getState().acceptFrame({
    levelId: 'parcel-pulse',
    runId: 'run-1',
    frame: frame(2_000),
  });
  useTrafficStore.getState().completeRun('run-1');
});

afterEach(() => {
  useTrafficStore.getState().reset();
  vi.useRealTimers();
});

describe('TrafficReplayControl', () => {
  it('starts in summary and changes only the visual replay state', () => {
    const graph = createParcelGraph();
    useParcelStore.setState({
      graph,
      revision: 4,
      result: null,
      resultDigest: null,
    });
    const before = useParcelStore.getState();

    render(
      <TrafficReplayControl
        levelId="parcel-pulse"
        runId="run-1"
        enabled
      />,
    );
    expect(screen.getByText('Run summary')).toBeVisible();
    expect(screen.getByText(/Replay changes only the view/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    expect(screen.getByText('Recorded replay')).toBeVisible();
    expect(screen.getByLabelText('Replay sample')).toBeVisible();
    expect(useTrafficStore.getState().mode).toBe('replay-playing');

    fireEvent.click(screen.getByRole('button', { name: 'Pause replay' }));
    expect(useTrafficStore.getState().mode).toBe('replay-paused');
    fireEvent.click(screen.getByRole('button', { name: 'Summary' }));
    expect(useTrafficStore.getState().mode).toBe('completed');

    const after = useParcelStore.getState();
    expect(after.graph).toBe(before.graph);
    expect(after.revision).toBe(before.revision);
    expect(after.result).toBe(before.result);
  });

  it('offers no replay when the run has no recorded samples', () => {
    useTrafficStore.getState().abortRun('run-1');
    const { container } = render(
      <TrafficReplayControl
        levelId="parcel-pulse"
        runId="run-1"
        enabled
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
