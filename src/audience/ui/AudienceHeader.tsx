import { Play, Square } from 'lucide-react';
import { useRef, useState } from 'react';

import {
  AUDIENCE_LEVEL,
  AUDIENCE_MAX_SEED,
  audienceGraphDigest,
  validateAudienceGraph,
} from '../index';
import { Button } from '../../ui/Button';
import { StatusPill, type Tone } from '../../ui/StatusPill';
import { formatInteger } from '../../ui/format';
import { formatHourlyUsd, formatUsdPrecise } from '../../features/game-ui';
import {
  audienceGraphHourlyUsd,
  isUntouchedAudienceStarter,
} from './audience-meta';
import { useAudienceStore } from './audience-store';

function statusPill(phase: string): { tone: Tone; label: string } {
  switch (phase) {
    case 'running':
      return { tone: 'accent', label: 'Evaluating' };
    case 'stopping':
      return { tone: 'warning', label: 'Stopping' };
    case 'completed':
      return { tone: 'success', label: 'Completed' };
    case 'blocked':
      return { tone: 'danger', label: 'Run blocked' };
    case 'error':
      return { tone: 'danger', label: 'Run failed' };
    case 'stopped':
      return { tone: 'warning', label: 'Cancelled' };
    default:
      return { tone: 'neutral', label: 'Ready to run' };
  }
}

function SeedInput({ disabled }: { disabled: boolean }) {
  const seed = useAudienceStore((state) => state.seed);
  const setSeed = useAudienceStore((state) => state.setSeed);
  const [draft, setDraft] = useState(String(seed));
  const skipCommit = useRef(false);
  const [lastSeed, setLastSeed] = useState(seed);
  if (lastSeed !== seed) {
    setLastSeed(seed);
    setDraft(String(seed));
  }

  const sync = () => setDraft(String(seed));

  return (
    <label className="audience-header-seed">
      <span>Seed</span>
      <input
        className="ui-input"
        type="number"
        min={0}
        max={AUDIENCE_MAX_SEED}
        step={1}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setDraft(String(seed))}
        onBlur={() => {
          if (skipCommit.current) {
            skipCommit.current = false;
            sync();
            return;
          }
          const parsed = Number(draft);
          if (
            draft.trim() === '' ||
            !Number.isInteger(parsed) ||
            parsed < 0 ||
            parsed > AUDIENCE_MAX_SEED
          ) {
            sync();
            return;
          }
          setSeed(parsed);
          setDraft(String(parsed));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            skipCommit.current = true;
            sync();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

export function AudienceHeader({
  onRun,
  onStop,
}: {
  onRun: () => void;
  onStop: () => void;
}) {
  const graph = useAudienceStore((state) => state.graph);
  const runPhase = useAudienceStore((state) => state.runPhase);
  const seed = useAudienceStore((state) => state.seed);
  const result = useAudienceStore((state) => state.result);
  const resultDigest = useAudienceStore((state) => state.resultDigest);
  const resultSeed = useAudienceStore((state) => state.resultSeed);

  const stale =
    result !== null &&
    resultDigest !== null &&
    resultSeed !== null &&
    (resultSeed !== seed || resultDigest !== audienceGraphDigest(graph));
  const busy = runPhase === 'running' || runPhase === 'stopping';
  const starter = isUntouchedAudienceStarter(graph);
  const hasGraphErrors = validateAudienceGraph(graph).some(
    (issue) => issue.severity === 'error',
  );
  const pill = busy
    ? statusPill(runPhase)
    : stale
      ? { tone: 'warning' as const, label: 'Previous result' }
      : runPhase === 'completed' && result
        ? result.status === 'complete' && result.passed
          ? { tone: 'success' as const, label: 'All cases passed' }
          : result.status === 'complete'
            ? { tone: 'warning' as const, label: 'Not qualified' }
            : result.status === 'cancelled'
              ? { tone: 'warning' as const, label: 'Run cancelled' }
              : { tone: 'warning' as const, label: 'Run incomplete' }
        : runPhase === 'blocked'
          ? statusPill('blocked')
          : starter
            ? { tone: 'neutral' as const, label: 'Build your system' }
            : hasGraphErrors
              ? { tone: 'warning' as const, label: 'Graph incomplete' }
              : statusPill(runPhase);

  const hourly = audienceGraphHourlyUsd(graph);
  const scoreUsd =
    result && !stale && result.score.eligible ? result.score.costUsd : null;

  return (
    <header className="audience-header">
      <div className="audience-header__brand">
        <span className="audience-header__mark" aria-hidden="true">
          LA
        </span>
        <div>
          <h1>{AUDIENCE_LEVEL.title}</h1>
          <p>Exact audience rankings under live activity and one failure</p>
        </div>
      </div>

      <div className="audience-header__meta">
        <div className="audience-header__rent">
          <span>Configured rent</span>
          <strong>{formatHourlyUsd(hourly)}</strong>
          <span>Hourly rental is separate from the actual run cost</span>
        </div>
        <div className="audience-header__rent">
          <span>Peak-case score</span>
          <strong>{scoreUsd === null ? 'Not ranked' : formatUsdPrecise(scoreUsd)}</strong>
          <span>
            {scoreUsd === null
              ? 'Only a complete run where every case passes is ranked'
              : 'Actual peak-case cost · fault cases not summed'}
          </span>
        </div>
        <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
      </div>

      <div className="audience-header__controls">
        <SeedInput disabled={busy} />
        <span className="audience-header__window">
          {formatInteger(AUDIENCE_LEVEL.workload.measuredMs / 1000)} s per case ·
          up to {formatInteger(AUDIENCE_LEVEL.workload.drainMs / 1000)} s drain ·
          peak{' '}
          {formatInteger(AUDIENCE_LEVEL.workload.peakWindow.fromMs / 1000)}–
          {formatInteger(AUDIENCE_LEVEL.workload.peakWindow.toMs / 1000)} s
        </span>
        {busy ? (
          <Button variant="danger" icon={<Square size={15} />} onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<Play size={16} />}
            onClick={onRun}
            title={
              runPhase === 'blocked'
                ? 'Fix the blocking graph issues, then run again'
                : 'Evaluate every required case with the real worker'
            }
          >
            {runPhase === 'completed' ||
            runPhase === 'stopped' ||
            runPhase === 'error'
              ? 'Run again'
              : 'Run evaluation'}
          </Button>
        )}
      </div>
    </header>
  );
}
