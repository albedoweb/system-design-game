import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AudienceEvaluation, AudienceTrafficFrame } from '../index';
import { AudienceReplayControl } from './AudienceReplayControl';
import { useAudienceStore } from './audience-store';

function frameAt(timeMs: number): AudienceTrafficFrame {
  return {
    levelId: 'live-audience',
    scopeId: 'normal',
    scopeLabel: 'normal',
    timeMs,
    windowMs: 1_000,
    phase: 'measured',
    nodes: [],
    edges: [],
  };
}

const FRAMES = [0, 1_000, 2_000, 3_000].map(frameAt);

/**
 * Mirrors the canvas wiring: the control only receives state and actions, so
 * the harness must use the real store to prove the timer does not pause it.
 */
function Harness() {
  const viewTimeMs = useAudienceStore((state) => state.viewTimeMs);
  const mode = useAudienceStore((state) => state.replayMode);
  const startReplay = useAudienceStore((state) => state.startReplay);
  const playReplay = useAudienceStore((state) => state.playReplay);
  const pauseReplay = useAudienceStore((state) => state.pauseReplay);
  const seekReplay = useAudienceStore((state) => state.seekReplay);
  const advanceReplay = useAudienceStore((state) => state.advanceReplay);
  const exitReplay = useAudienceStore((state) => state.exitReplay);

  return (
    <AudienceReplayControl
      frames={FRAMES}
      caseLabel="Normal traffic"
      viewTimeMs={viewTimeMs}
      mode={mode}
      onStart={startReplay}
      onPlay={playReplay}
      onPause={pauseReplay}
      onSeek={seekReplay}
      onAdvance={advanceReplay}
      onSummary={exitReplay}
    />
  );
}

function view() {
  const state = useAudienceStore.getState();
  return { timeMs: state.viewTimeMs, mode: state.replayMode };
}

function tick(ms = 350) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  useAudienceStore.setState({ viewTimeMs: null, replayMode: 'summary' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Live Audience recorded replay', () => {
  it('keeps playing through successive timer ticks and pauses at the final frame', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    expect(view()).toEqual({ timeMs: 0, mode: 'playing' });

    tick();
    expect(view()).toEqual({ timeMs: 1_000, mode: 'playing' });

    // Regression: the automatic tick used to call the manual seek path, which
    // set the mode to paused so only the first 350 ms sample ever played.
    tick();
    expect(view()).toEqual({ timeMs: 2_000, mode: 'playing' });

    tick();
    expect(view()).toEqual({ timeMs: 3_000, mode: 'playing' });
    expect(screen.getByTestId('audience-case-replay')).toHaveAttribute(
      'data-audience-replay-mode',
      'playing',
    );

    tick();
    expect(view()).toEqual({ timeMs: 3_000, mode: 'paused' });
    expect(
      screen.getByRole('button', { name: 'Play replay' }),
    ).toBeVisible();
    expect(screen.getByText(/sample 4\/4/)).toBeVisible();
  });

  it('pauses on manual seek or explicit pause and stops advancing', () => {
    const store = useAudienceStore.getState();
    store.startReplay(0);
    render(<Harness />);

    fireEvent.change(screen.getByRole('slider', { name: 'Replay sample' }), {
      target: { value: '2' },
    });
    expect(view()).toEqual({ timeMs: 2_000, mode: 'paused' });

    tick(2_000);
    expect(view()).toEqual({ timeMs: 2_000, mode: 'paused' });

    act(() => {
      useAudienceStore.getState().playReplay();
    });
    expect(view().mode).toBe('playing');
    fireEvent.click(screen.getByRole('button', { name: 'Pause replay' }));
    expect(view()).toEqual({ timeMs: 2_000, mode: 'paused' });

    tick();
    expect(view()).toEqual({ timeMs: 2_000, mode: 'paused' });
  });

  it('restarts from the first frame when Play is pressed at the end', () => {
    useAudienceStore.getState().startReplay(3_000);
    useAudienceStore.getState().pauseReplay();
    render(<Harness />);

    expect(screen.getByText(/sample 4\/4/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }));
    expect(view()).toEqual({ timeMs: 0, mode: 'playing' });

    tick();
    expect(view()).toEqual({ timeMs: 1_000, mode: 'playing' });
  });

  it('cleans up on summary, case switch and unmount', () => {
    const store = useAudienceStore.getState();
    store.startReplay(0);
    const { unmount } = render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Summary' }));
    expect(view()).toEqual({ timeMs: null, mode: 'summary' });
    tick();
    expect(view()).toEqual({ timeMs: null, mode: 'summary' });

    act(() => {
      useAudienceStore.getState().startReplay(0);
      useAudienceStore.setState({
        result: {
          cases: [{ id: 'normal' }, { id: 'peak' }],
        } as unknown as AudienceEvaluation,
      });
      useAudienceStore.getState().selectCase('peak');
    });
    expect(view()).toEqual({ timeMs: null, mode: 'summary' });
    expect(useAudienceStore.getState().selectedCaseId).toBe('peak');
    tick();
    expect(view()).toEqual({ timeMs: null, mode: 'summary' });

    act(() => {
      useAudienceStore.getState().startReplay(0);
    });
    expect(view().mode).toBe('playing');
    unmount();
    tick();
    // The effect cleanup removed the interval; nothing advanced after unmount.
    expect(view()).toEqual({ timeMs: 0, mode: 'playing' });
  });
});
