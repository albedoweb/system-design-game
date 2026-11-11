import { useEffect } from 'react';

import type { AudienceTrafficFrame } from '../index';
import { formatTrafficTime } from '../../features/traffic/traffic-ui';
import type { AudienceReplayMode } from './audience-store';

export interface AudienceReplayControlProps {
  frames: readonly AudienceTrafficFrame[];
  caseLabel: string | null;
  viewTimeMs: number | null;
  mode: AudienceReplayMode;
  onStart: (timeMs: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (timeMs: number) => void;
  onAdvance: (timeMs: number) => void;
  onSummary: () => void;
}

/**
 * Recorded, per-case replay. It only shows frames already measured for the
 * selected case: no engine rerun, no live animation and no fabricated sample.
 */
export function AudienceReplayControl({
  frames,
  caseLabel,
  viewTimeMs,
  mode,
  onStart,
  onPlay,
  onPause,
  onSeek,
  onAdvance,
  onSummary,
}: AudienceReplayControlProps) {
  const replaying = mode !== 'summary';

  useEffect(() => {
    if (mode !== 'playing' || frames.length === 0) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      const current = viewTimeMs ?? frames[0]?.timeMs ?? 0;
      const next = frames.find((frame) => frame.timeMs > current);
      if (next) {
        // The automatic tick keeps the replay playing; only a manual seek or
        // pause may downgrade the mode.
        onAdvance(next.timeMs);
        return;
      }
      onPause();
    }, 350);
    return () => window.clearInterval(timer);
  }, [frames, mode, onAdvance, onPause, viewTimeMs]);

  if (frames.length === 0) {
    return null;
  }

  let index = 0;
  let distance = Number.POSITIVE_INFINITY;
  frames.forEach((frame, frameIndex) => {
    const nextDistance = Math.abs(frame.timeMs - (viewTimeMs ?? frames[0]!.timeMs));
    if (nextDistance < distance) {
      index = frameIndex;
      distance = nextDistance;
    }
  });
  const current = frames[index] ?? frames[0]!;
  const atEnd = index === frames.length - 1;

  return (
    <div
      className={[
        'audience-replay',
        replaying ? 'is-replaying' : 'is-summary',
      ].join(' ')}
      data-testid="audience-case-replay"
      data-audience-replay-mode={mode}
      aria-label="Recorded case replay"
    >
      <div className="audience-replay__row">
        <strong className="audience-replay__title">
          {replaying ? 'Recorded replay' : 'Case summary'}
        </strong>
        <span className="audience-replay__scope">{caseLabel ?? 'Selected case'}</span>
        {!replaying ? (
          <button
            type="button"
            className="audience-replay__button"
            onClick={() => onStart(current.timeMs)}
            title="Play the measured frames recorded for this case. This does not rerun the engine or change the result."
          >
            Replay
          </button>
        ) : (
          <>
            <button
              type="button"
              className="audience-replay__button"
              onClick={
                mode === 'playing'
                  ? onPause
                  : atEnd
                    ? () => onStart(frames[0]!.timeMs)
                    : onPlay
              }
              aria-label={mode === 'playing' ? 'Pause replay' : 'Play replay'}
            >
              {mode === 'playing' ? 'Pause' : 'Play'}
            </button>
            <button
              type="button"
              className="audience-replay__button audience-replay__button--quiet"
              onClick={onSummary}
            >
              Summary
            </button>
          </>
        )}
      </div>
      {replaying ? (
        <div className="audience-replay__row audience-replay__seek">
          <input
            type="range"
            min={0}
            max={Math.max(0, frames.length - 1)}
            step={1}
            value={index}
            onChange={(event) =>
              onSeek(frames[Number(event.target.value)]?.timeMs ?? current.timeMs)
            }
            aria-label="Replay sample"
            aria-valuetext={`${formatTrafficTime(current)} of the selected case`}
          />
          <span className="audience-replay__time">
            {formatTrafficTime(current)} · sample {index + 1}/{frames.length}
          </span>
        </div>
      ) : (
        <p className="audience-replay__note">
          {frames.length} measured sample{frames.length === 1 ? '' : 's'} for
          this case. Replay changes only the view; results stay unchanged.
        </p>
      )}
    </div>
  );
}
