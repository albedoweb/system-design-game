import { useEffect, useState } from 'react';

import { Button } from '../../ui/Button';
import type { CartTrafficFrame } from '../index';

export type CartReplayMode = 'summary' | 'playing' | 'paused';
export type CartReplaySpeed = 0.5 | 1 | 2 | 4;

export interface CartReplayControlProps {
  /** Frames already measured for the selected case; replay never reruns them. */
  readonly frames: readonly CartTrafficFrame[];
  readonly caseLabel?: string;
  readonly initialSpeed?: CartReplaySpeed;
  /**
   * Reports the frame currently on screen. Consumers use it only to redraw the
   * view; it is detached data and can never change the result or trace hash.
   */
  readonly onViewFrame?: (frame: CartTrafficFrame | null, index: number) => void;
}

const SPEEDS: readonly CartReplaySpeed[] = [0.5, 1, 2, 4];
/** Base dwell time per sample at 1×; speed only changes presentation. */
const BASE_TICK_MS = 350;

function formatTrafficTime(windowStartUs: number): string {
  return `${(windowStartUs / 1_000_000).toFixed(2)} s`;
}

/**
 * Recorded, per-case replay for the Global Cart traffic frames.
 *
 * Replay is a view over already measured, bounded frames: it never calls the
 * core, reruns a case, changes a metric or alters the trace hash. Playback speed
 * and manual seeking therefore cannot influence the final evaluation.
 */
export function CartReplayControl({
  frames,
  caseLabel,
  initialSpeed = 1,
  onViewFrame,
}: CartReplayControlProps) {
  const [mode, setMode] = useState<CartReplayMode>('summary');
  const [index, setIndex] = useState(0);
  const [speed, setSpeed] = useState<CartReplaySpeed>(initialSpeed);

  const displayIndex =
    frames.length === 0
      ? 0
      : mode === 'summary'
        ? frames.length - 1
        : Math.min(index, frames.length - 1);
  const current = frames[displayIndex] ?? null;
  const atEnd = frames.length > 0 && displayIndex >= frames.length - 1;

  useEffect(() => {
    onViewFrame?.(current, displayIndex);
  }, [current, displayIndex, onViewFrame]);

  useEffect(() => {
    if (mode !== 'playing' || frames.length === 0) return undefined;
    const delay = Math.max(40, Math.round(BASE_TICK_MS / speed));
    const timer = window.setInterval(() => {
      if (index >= frames.length - 1) {
        setMode('paused');
        return;
      }
      setIndex(index + 1);
    }, delay);
    return () => window.clearInterval(timer);
  }, [mode, speed, frames.length, index]);

  if (frames.length === 0) {
    return null;
  }

  const startReplay = (): void => {
    setIndex(0);
    setMode('playing');
  };

  const play = (): void => {
    if (frames.length === 0) return;
    if (atEnd) setIndex(0);
    setMode('playing');
  };

  const replaying = mode !== 'summary';

  return (
    <div
      className={[
        'cart-replay',
        replaying ? 'is-replaying' : 'is-summary',
      ].join(' ')}
      data-testid="cart-case-replay"
      data-cart-replay-mode={mode}
      data-cart-replay-speed={speed}
      aria-label="Recorded scenario replay"
    >
      <div className="cart-replay__row cart-replay__row--main">
        <strong className="cart-replay__title">
          {replaying ? 'Recorded replay' : 'Scenario summary'}
        </strong>
        <span className="cart-replay__scope">{caseLabel ?? 'Selected scenario'}</span>
        {!replaying ? (
          <Button
            type="button"
            className="cart-replay__button"
            onClick={startReplay}
            title="Play the measured frames recorded for this scenario. This does not run the simulation again or change the result."
          >
            Replay
          </Button>
        ) : (
          <>
            <Button
              type="button"
              className="cart-replay__button"
              onClick={mode === 'playing' ? () => setMode('paused') : play}
              aria-label={mode === 'playing' ? 'Pause replay' : 'Play replay'}
            >
              {mode === 'playing' ? 'Pause' : 'Play'}
            </Button>
            <Button
              type="button"
              className="cart-replay__button cart-replay__button--quiet"
              onClick={() => setMode('summary')}
            >
              Summary
            </Button>
          </>
        )}
        <label className="cart-replay__speed">
          <span>Speed</span>
          <select className="ui-input"
            aria-label="Replay speed"
            value={speed}
            onChange={(event) => {
              const next = Number(event.target.value);
              setSpeed(
                SPEEDS.includes(next as CartReplaySpeed)
                  ? (next as CartReplaySpeed)
                  : 1,
              );
            }}
          >
            {SPEEDS.map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
      </div>
      {replaying ? (
        <div className="cart-replay__row cart-replay__seek">
          <input
            type="range"
            min={0}
            max={Math.max(0, frames.length - 1)}
            step={1}
            value={displayIndex}
            onChange={(event) => {
              const next = Number(event.target.value);
              setIndex(Number.isInteger(next) ? next : 0);
              setMode('paused');
            }}
            aria-label="Replay sample"
            aria-valuetext={`${formatTrafficTime(current?.windowStartUs ?? 0)} of the selected scenario`}
          />
          <span className="cart-replay__time">
            {formatTrafficTime(current?.windowStartUs ?? 0)} · sample{' '}
            {displayIndex + 1}/{frames.length}
          </span>
        </div>
      ) : (
        <p className="cart-replay__note">
          {frames.length} measured sample{frames.length === 1 ? '' : 's'} for this
          scenario. Replay changes only the view; results stay unchanged.
        </p>
      )}
    </div>
  );
}
