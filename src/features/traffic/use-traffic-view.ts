import { useTrafficStore, type TrafficLevelId, type TrafficMode } from './traffic-store';
import type { TrafficFrame } from '../../simulation/traffic-telemetry';
import { trafficModeLabel } from './traffic-ui';
import { useMediaQuery } from '../../ui/use-media-query';

export interface TrafficCanvasView {
  mode: TrafficMode;
  frame: TrafficFrame | null;
  animate: boolean;
  reducedMotion: boolean;
  modeLabel: string;
  showStatus: boolean;
  awaitingSample: boolean;
  paused: boolean;
}

/**
 * The canvas is the only place where live/replay frames may override result
 * horizons or scenarios. The view is empty unless run and level still match.
 */
export function useTrafficCanvasView(
  levelId: TrafficLevelId,
  expectedRunId: string | null,
): TrafficCanvasView {
  const run = useTrafficStore((state) => state.run);
  const mode = useTrafficStore((state) => state.mode);
  const liveFrame = useTrafficStore((state) => state.liveFrame);
  const livePaused = useTrafficStore((state) => state.livePaused);
  const replayFrame = useTrafficStore((state) => state.replayFrame);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  const matches =
    run !== null &&
    run.levelId === levelId &&
    expectedRunId !== null &&
    run.runId === expectedRunId;
  const activeMode = matches ? mode : 'idle';
  const frame =
    !matches
      ? null
      : activeMode === 'live'
        ? liveFrame
        : activeMode === 'replay-playing' ||
            activeMode === 'replay-paused'
          ? replayFrame
          : null;

  const paused =
    matches && activeMode === 'live' && livePaused;
  return {
    mode: activeMode,
    frame,
    animate:
      matches &&
      !paused &&
      (activeMode === 'live' || activeMode === 'replay-playing'),
    reducedMotion,
    modeLabel: trafficModeLabel(activeMode, frame, paused),
    showStatus:
      matches &&
      (activeMode === 'live' ||
        activeMode === 'completed' ||
        activeMode === 'replay-playing' ||
        activeMode === 'replay-paused'),
    awaitingSample:
      matches && activeMode === 'live' && frame === null && !paused,
    paused,
  };
}
