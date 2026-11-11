import { useEffect } from 'react';

import {
  observedTrafficFrames,
  observedTrafficScopes,
  useTrafficStore,
  type TrafficLevelId,
} from './traffic-store';
import { formatTrafficTime } from './traffic-ui';
import './traffic.css';

export interface TrafficReplayControlProps {
  levelId: TrafficLevelId;
  runId: string | null;
  enabled: boolean;
}

/**
 * Optional visual replay of measured frames. It never reruns the engine, never
 * writes the graph or the result, and starts in the completed summary state.
 */
export function TrafficReplayControl({
  levelId,
  runId,
  enabled,
}: TrafficReplayControlProps) {
  const run = useTrafficStore((state) => state.run);
  const mode = useTrafficStore((state) => state.mode);
  const replayScopeId = useTrafficStore((state) => state.replayScopeId);
  const replayIndex = useTrafficStore((state) => state.replayIndex);
  const replayFrame = useTrafficStore((state) => state.replayFrame);
  const startReplay = useTrafficStore((state) => state.startReplay);
  const setReplayScope = useTrafficStore((state) => state.setReplayScope);
  const playReplay = useTrafficStore((state) => state.playReplay);
  const pauseReplay = useTrafficStore((state) => state.pauseReplay);
  const seekReplay = useTrafficStore((state) => state.seekReplay);
  const exitReplay = useTrafficStore((state) => state.exitReplay);

  const matches =
    enabled &&
    run !== null &&
    run.levelId === levelId &&
    runId !== null &&
    run.runId === runId;
  const scopes = matches && runId ? observedTrafficScopes(levelId, runId) : [];
  const selectedScopeId = replayScopeId ?? scopes[0]?.scopeId ?? null;
  const frames =
    matches && runId
      ? observedTrafficFrames(levelId, runId, selectedScopeId)
      : [];

  useEffect(() => {
    if (mode !== 'replay-playing') {
      return undefined;
    }
    const timer = window.setInterval(() => {
      useTrafficStore.getState().advanceReplay();
    }, 350);
    return () => window.clearInterval(timer);
  }, [mode]);

  if (!matches || scopes.length === 0) {
    return null;
  }
  if (mode !== 'completed' && mode !== 'replay-paused' && mode !== 'replay-playing') {
    return null;
  }

  const replaying = mode === 'replay-paused' || mode === 'replay-playing';
  const scopeSelect =
    scopes.length > 1 ? (
      <label className="traffic-replay__scope">
        <span>Scope</span>
        <select
          value={selectedScopeId ?? ''}
          onChange={(event) => setReplayScope(event.target.value)}
          aria-label="Replay scope"
        >
          {scopes.map((scope) => (
            <option value={scope.scopeId} key={scope.scopeId}>
              {scope.scopeLabel} ({scope.frameCount} samples)
            </option>
          ))}
        </select>
      </label>
    ) : (
      <span className="traffic-replay__scope-name">
        {scopes[0]?.scopeLabel}
      </span>
    );

  return (
    <div
      className={[
        'traffic-replay',
        replaying ? 'is-replaying' : 'is-summary',
      ].join(' ')}
      data-testid="traffic-replay"
      data-traffic-replay-mode={mode}
      aria-label="Recorded traffic replay"
    >
      <div className="traffic-replay__row">
        <strong className="traffic-replay__title">
          {replaying ? 'Recorded replay' : 'Run summary'}
        </strong>
        {scopeSelect}
        {!replaying ? (
          <button
            type="button"
            className="traffic-replay__button"
            onClick={() => startReplay(selectedScopeId ?? undefined)}
            title="Play the measured frames recorded during this run. This does not rerun the engine or change the result."
          >
            Replay
          </button>
        ) : (
          <>
            <button
              type="button"
              className="traffic-replay__button"
              onClick={() =>
                mode === 'replay-playing' ? pauseReplay() : playReplay()
              }
              aria-label={mode === 'replay-playing' ? 'Pause replay' : 'Play replay'}
            >
              {mode === 'replay-playing' ? 'Pause' : 'Play'}
            </button>
            <button
              type="button"
              className="traffic-replay__button traffic-replay__button--quiet"
              onClick={exitReplay}
            >
              Summary
            </button>
          </>
        )}
      </div>
      {replaying ? (
        <div className="traffic-replay__row traffic-replay__seek">
          <input
            type="range"
            min={0}
            max={Math.max(0, frames.length - 1)}
            step={1}
            value={Math.min(replayIndex, Math.max(0, frames.length - 1))}
            onChange={(event) => seekReplay(Number(event.target.value))}
            aria-label="Replay sample"
            aria-valuetext={
              replayFrame
                ? `${formatTrafficTime(replayFrame)} of the recorded window`
                : 'No recorded sample'
            }
          />
          <span className="traffic-replay__time">
            {replayFrame
              ? `${formatTrafficTime(replayFrame)} · sample ${replayIndex + 1}/${frames.length}`
              : 'No recorded sample'}
          </span>
        </div>
      ) : (
        <p className="traffic-replay__note">
          {frames.length} measured sample{frames.length === 1 ? '' : 's'} kept
          for visual replay. Replay changes only the view; results stay unchanged.
        </p>
      )}
    </div>
  );
}
