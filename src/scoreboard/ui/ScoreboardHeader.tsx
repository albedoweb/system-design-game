import { Play, Square } from 'lucide-react';
import { useRef, useState } from 'react';

import {
  SCOREBOARD_CATALOG,
  SCOREBOARD_LEVEL,
  SCOREBOARD_MAX_SEED,
  scoreboardGraphDigest,
  validateScoreboardGraph,
} from '../index';
import { Button } from '../../ui/Button';
import { StatusPill, type Tone } from '../../ui/StatusPill';
import { formatInteger } from '../../ui/format';
import { formatHourlyUsd, formatUsdPrecise } from './scoreboard-format';
import { isUntouchedScoreboardStarter } from './scoreboard-meta';
import { useScoreboardStore } from './scoreboard-store';

function configuredHourlyUsd(
  graph: ReturnType<typeof useScoreboardStore.getState>['graph'],
): number {
  return graph.nodes.reduce((sum, node) => {
    if (node.kind === 'app') {
      return (
        sum +
        node.config.instances *
          SCOREBOARD_CATALOG.components.app.hourlyUsdPerInstance
      );
    }
    if (node.kind === 'sql') {
      return sum + SCOREBOARD_CATALOG.components.sql.sizes[node.config.size].hourlyUsd;
    }
    if (node.kind === 'cache') {
      return sum + SCOREBOARD_CATALOG.components.cache.hourlyUsd;
    }
    return sum;
  }, 0);
}

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
  const seed = useScoreboardStore((state) => state.seed);
  const setSeed = useScoreboardStore((state) => state.setSeed);
  const [draft, setDraft] = useState(String(seed));
  const skipCommit = useRef(false);
  const [lastSeed, setLastSeed] = useState(seed);
  if (lastSeed !== seed) {
    setLastSeed(seed);
    setDraft(String(seed));
  }

  const sync = () => setDraft(String(seed));

  return (
    <label className="scoreboard-header-seed">
      <span>Seed</span>
      <input
        className="ui-input"
        type="number"
        min={0}
        max={SCOREBOARD_MAX_SEED}
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
            parsed > SCOREBOARD_MAX_SEED
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

export function ScoreboardHeader({
  onRun,
  onStop,
}: {
  onRun: () => void;
  onStop: () => void;
}) {
  const graph = useScoreboardStore((state) => state.graph);
  const runPhase = useScoreboardStore((state) => state.runPhase);
  const seed = useScoreboardStore((state) => state.seed);
  const result = useScoreboardStore((state) => state.result);
  const resultDigest = useScoreboardStore((state) => state.resultDigest);
  const resultSeed = useScoreboardStore((state) => state.resultSeed);

  const stale =
    result !== null &&
    resultDigest !== null &&
    resultSeed !== null &&
    (resultSeed !== seed || resultDigest !== scoreboardGraphDigest(graph));
  const busy = runPhase === 'running' || runPhase === 'stopping';
  const starter = isUntouchedScoreboardStarter(graph);
  const hasGraphErrors = validateScoreboardGraph(graph).some(
    (issue) => issue.severity === 'error',
  );
  const pill = busy
    ? statusPill(runPhase)
    : stale
      ? { tone: 'warning' as const, label: 'Previous result' }
      : runPhase === 'completed' && result
        ? result.status === 'complete' && result.passed
          ? { tone: 'success' as const, label: 'Level passed' }
          : result.status === 'complete'
            ? { tone: 'warning' as const, label: 'Level not passed' }
            : { tone: 'warning' as const, label: 'Run incomplete' }
        : runPhase === 'blocked'
          ? statusPill('blocked')
          : starter
            ? { tone: 'neutral' as const, label: 'Build your system' }
            : hasGraphErrors
              ? { tone: 'warning' as const, label: 'Graph incomplete' }
              : statusPill(runPhase);

  const hourly = configuredHourlyUsd(graph);

  return (
    <header className="scoreboard-header">
      <div className="scoreboard-header__brand">
        <span className="scoreboard-header__mark" aria-hidden="true">
          LS
        </span>
        <div>
          <h1>{SCOREBOARD_LEVEL.title}</h1>
          <p>One live ranking under 100 vote changes per second</p>
        </div>
      </div>

      <div className="scoreboard-header__meta">
        <div className="scoreboard-header__rent">
          <span>Configured rent</span>
          <strong>{formatHourlyUsd(hourly)}</strong>
          <span>Hourly rental is separate from the actual run cost</span>
        </div>
        {result?.cost && !stale ? (
          <div className="scoreboard-header__rent">
            <span>Actual run cost</span>
            <strong>
              {result.status === 'complete' && result.passed
                ? formatUsdPrecise(result.cost.actualUsd)
                : 'Not ranked'}
            </strong>
            <span>
              {result.status === 'complete' && result.passed
                ? 'Complete passing run'
                : 'Only a complete passing run is ranked'}
            </span>
          </div>
        ) : null}
        <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
      </div>

      <div className="scoreboard-header__controls">
        <SeedInput disabled={busy} />
        <span className="scoreboard-header__window">
          {formatInteger(SCOREBOARD_LEVEL.workload.measuredMs / 1000)} s run · up
          to {formatInteger(SCOREBOARD_LEVEL.workload.drainMs / 1000)} s drain ·
          peak{' '}
          {formatInteger(SCOREBOARD_LEVEL.workload.peakWindow.fromMs / 1000)}–
          {formatInteger(SCOREBOARD_LEVEL.workload.peakWindow.toMs / 1000)} s
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
                : 'Evaluate the current graph and seed with the real worker'
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
