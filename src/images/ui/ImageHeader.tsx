import { Play, Square } from 'lucide-react';
import { useRef, useState } from 'react';

import { IMAGE_LEVEL } from '../level';
import { IMAGE_MAX_SEED } from '../contracts';
import { imageGraphDigest } from '../graph';
import { Button } from '../../ui/Button';
import { StatusPill, type Tone } from '../../ui/StatusPill';
import { formatInteger } from '../../ui/format';
import { imageLiveEstimate } from './image-estimate';
import { formatUsd } from './image-format';
import { useImageStore } from './image-store';

function statusPill(
  phase: string,
  stale: boolean,
  passed: boolean | null,
): { tone: Tone; label: string } {
  if (stale) {
    return { tone: 'warning', label: 'Previous result' };
  }
  switch (phase) {
    case 'running':
      return { tone: 'accent', label: 'Evaluating' };
    case 'stopping':
      return { tone: 'accent', label: 'Stopping' };
    case 'completed':
      return passed
        ? { tone: 'success', label: 'Level passed' }
        : { tone: 'warning', label: 'Not passed' };
    case 'blocked':
      return { tone: 'danger', label: 'Run blocked' };
    case 'error':
      return { tone: 'danger', label: 'Run failed' };
    case 'stopped':
      return { tone: 'neutral', label: 'Stopped' };
    default:
      return { tone: 'neutral', label: 'Ready to run' };
  }
}

function SeedInput({ disabled }: { disabled: boolean }) {
  const seed = useImageStore((state) => state.seed);
  const setSeed = useImageStore((state) => state.setSeed);
  const [draft, setDraft] = useState(String(seed));
  const skipCommit = useRef(false);
  const [lastSeed, setLastSeed] = useState(seed);
  if (lastSeed !== seed) {
    // Keep the field honest when Import or Reset changes the store seed.
    setLastSeed(seed);
    setDraft(String(seed));
  }

  return (
    <label className="image-header-seed">
      <span>Seed</span>
      <input
        className="ui-input"
        type="number"
        min={0}
        max={IMAGE_MAX_SEED}
        step={1}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setDraft(String(seed))}
        onBlur={() => {
          if (skipCommit.current) {
            skipCommit.current = false;
            setDraft(String(seed));
            return;
          }
          const parsed = Number(draft);
          if (
            draft.trim() === '' ||
            !Number.isInteger(parsed) ||
            parsed < 0 ||
            parsed > IMAGE_MAX_SEED
          ) {
            setDraft(String(seed));
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
            setDraft(String(seed));
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

export function ImageHeader({
  onRun,
  onStop,
}: {
  onRun: () => void;
  onStop: () => void;
}) {
  const graph = useImageStore((state) => state.graph);
  const runPhase = useImageStore((state) => state.runPhase);
  const seed = useImageStore((state) => state.seed);
  const result = useImageStore((state) => state.result);
  const resultDigest = useImageStore((state) => state.resultDigest);
  const resultSeed = useImageStore((state) => state.resultSeed);
  const stale =
    result !== null &&
    resultDigest !== null &&
    resultSeed !== null &&
    (resultSeed !== seed || resultDigest !== imageGraphDigest(graph));
  const busy = runPhase === 'running' || runPhase === 'stopping';
  const pill = statusPill(
    runPhase,
    stale,
    result ? result.passed : null,
  );
  const estimate = imageLiveEstimate(graph);
  const measuredCost =
    runPhase === 'completed' &&
    resultDigest === imageGraphDigest(graph) &&
    resultSeed === seed &&
    result?.cost?.provenance.measured
      ? result.cost
      : null;
  const cost = measuredCost ?? estimate.cost;
  const costLabel = measuredCost ? 'Measured monthly cost' : 'Estimated monthly cost';
  const overBudget = !cost.withinBudget;

  return (
    <header className="image-header">
      <div className="image-header__brand">
        <span className="image-header__mark" aria-hidden="true">
          IA
        </span>
        <div>
          <h1>{IMAGE_LEVEL.title}</h1>
          <p>Three regions, one fixed global image store</p>
        </div>
      </div>

      <div className="image-header__meta">
        <div
          className={`image-header__budget${overBudget ? ' is-over' : ''}`}
          aria-label={costLabel}
        >
          <span>{costLabel}</span>
          <strong>{formatUsd(cost.monthlyUsd, 0)}/mo</strong>
          <span>
            / {formatUsd(IMAGE_LEVEL.budget.monthlyUsd, 0)} budget · fixed{' '}
            {formatUsd(cost.fixed.totalUsd, 0)} · controllable{' '}
            {formatUsd(cost.controllable.totalUsd, 0)}
          </span>
        </div>
        <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
      </div>

      <div className="image-header__controls">
        <SeedInput disabled={busy} />
        <span className="image-header__window">
          {formatInteger(IMAGE_LEVEL.qualification.warmupMs / 1000)} s warm-up +{' '}
          {formatInteger(IMAGE_LEVEL.qualification.measuredMs / 1000)} s measured ·{' '}
          {IMAGE_LEVEL.qualification.requiredScenarios.length} cases
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
                : 'Run the real Image Atlas qualification in a dedicated worker'
            }
          >
            Run
          </Button>
        )}
      </div>
    </header>
  );
}
