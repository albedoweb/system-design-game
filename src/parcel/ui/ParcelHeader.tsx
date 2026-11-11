import { Play, Square } from 'lucide-react';
import { useRef, useState } from 'react';

import { PARCEL_CATALOG } from '../catalog';
import { PARCEL_LEVEL } from '../level';
import { PARCEL_MAX_SEED } from '../contracts';
import { parcelSemanticDigest } from '../graph';
import { Button } from '../../ui/Button';
import { StatusPill, type Tone } from '../../ui/StatusPill';
import { formatDecimal, formatInteger } from '../../ui/format';
import { formatTerabytes } from './parcel-format';
import { useParcelStore } from './parcel-store';

function configuredMonthlyUsd(graph: ReturnType<typeof useParcelStore.getState>['graph']): number {
  return graph.nodes.reduce((sum, node) => {
    const hardware = PARCEL_CATALOG.hardware[node.config.size];
    const storage =
      (node.config.storageTb ?? 0) * PARCEL_CATALOG.storage.priceUsdPerTbMonth;
    return (
      sum +
      hardware.hourlyUsd * PARCEL_CATALOG.storage.billingHoursPerMonth +
      storage
    );
  }, 0);
}

function statusPill(phase: string): { tone: Tone; label: string } {
  switch (phase) {
    case 'running':
      return { tone: 'accent', label: 'Evaluating' };
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
  const seed = useParcelStore((state) => state.seed);
  const setSeed = useParcelStore((state) => state.setSeed);
  const [draft, setDraft] = useState(String(seed));
  const skipCommit = useRef(false);
  const [lastSeed, setLastSeed] = useState(seed);
  if (lastSeed !== seed) {
    // Keep the field honest when a file Open changes the store seed.
    setLastSeed(seed);
    setDraft(String(seed));
  }
  const shown = draft;
  const sync = () => {
    setDraft(String(seed));
  };

  return (
    <label className="parcel-header-seed">
      <span>Seed</span>
      <input
        className="ui-input"
        type="number"
        min={0}
        max={PARCEL_MAX_SEED}
        step={1}
        value={shown}
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
            parsed > PARCEL_MAX_SEED
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

export function ParcelHeader({
  onRun,
  onStop,
}: {
  onRun: () => void;
  onStop: () => void;
}) {
  const graph = useParcelStore((state) => state.graph);
  const runPhase = useParcelStore((state) => state.runPhase);
  const seed = useParcelStore((state) => state.seed);
  const result = useParcelStore((state) => state.result);
  const resultDigest = useParcelStore((state) => state.resultDigest);
  const resultSeed = useParcelStore((state) => state.resultSeed);
  const stale =
    result !== null &&
    resultDigest !== null &&
    resultSeed !== null &&
    (resultSeed !== seed || resultDigest !== parcelSemanticDigest(graph));
  const busy = runPhase === 'running' || runPhase === 'stopping';
  const pill = busy
    ? statusPill(runPhase)
    : stale
      ? { tone: 'warning' as const, label: 'Previous result' }
      : runPhase === 'completed' && result
        ? result.passed
          ? { tone: 'success' as const, label: 'Level passed' }
          : { tone: 'warning' as const, label: 'Level not passed' }
        : statusPill(runPhase);
  const stores = graph.nodes.filter((node) => node.kind !== 'client' && node.kind !== 'app');
  const provisioned = stores.reduce((sum, node) => sum + (node.config.storageTb ?? 0), 0);
  const configured = configuredMonthlyUsd(graph);
  const overConfiguredBudget = configured > PARCEL_LEVEL.budget.monthlyUsd;

  return (
    <header className="parcel-header">
      <div className="parcel-header__brand">
        <span className="parcel-header__mark" aria-hidden="true">
          PP
        </span>
        <div>
          <h1>{PARCEL_LEVEL.title}</h1>
          <p>Tracking five years of parcel events</p>
        </div>
      </div>

      <div className="parcel-header__meta">
        <div className={`parcel-header__budget${overConfiguredBudget ? ' is-over' : ''}`}>
          <span>Monthly cost</span>
          <strong>${formatDecimal(configured, 2)}/mo</strong>
          <span>
            / ${formatInteger(PARCEL_LEVEL.budget.monthlyUsd)} budget ·{' '}
            {formatTerabytes(provisioned)} provisioned
          </span>
        </div>
        <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
      </div>

      <div className="parcel-header__controls">
        <SeedInput disabled={busy} />
        <span className="parcel-header__window">
          {formatInteger(PARCEL_LEVEL.durationMs / 1000)} s window +{' '}
          {formatInteger(PARCEL_LEVEL.drainMs / 1000)} s drain
        </span>
        {busy ? (
          <Button
            variant="danger"
            icon={<Square size={15} />}
            onClick={onStop}
          >
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
                : 'Evaluate years 1 and 5 from the current graph and seed'
            }
          >
            {runPhase === 'completed' || runPhase === 'stopped' || runPhase === 'error'
              ? 'Run again'
              : 'Run evaluation'}
          </Button>
        )}
      </div>
    </header>
  );
}
