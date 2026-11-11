import {
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Square,
  Snowflake,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import {
  MAX_SEED,
  calculateCost,
  validateGraph,
  type LevelDefinition,
  type SimulationSpeed,
} from '../../domain';
import { useEditorStore } from '../../state/editor-store';
import {
  isSessionBusy,
  isSessionLocked,
  useSessionStore,
} from '../../state/session-store';
import { useSimulation } from '../simulation/simulation-context';
import { Button } from '../../ui/Button';
import { StatusPill } from '../../ui/StatusPill';
import { formatMicroUsd } from '../../ui/format';
import './header.css';

const SPEEDS: readonly SimulationSpeed[] = [1, 4, 16];

function phasePill(phase: string): {
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  label: string;
} {
  switch (phase) {
    case 'starting':
      return { tone: 'accent', label: 'Starting' };
    case 'running':
      return { tone: 'accent', label: 'Run in progress' };
    case 'paused':
      return { tone: 'warning', label: 'Paused' };
    case 'stopping':
      return { tone: 'warning', label: 'Stopping' };
    case 'stopped':
      return { tone: 'neutral', label: 'Stopped' };
    case 'completed':
      return { tone: 'success', label: 'Completed' };
    case 'error':
      return { tone: 'danger', label: 'Error' };
    default:
      return { tone: 'neutral', label: 'Ready to run' };
  }
}

function SeedInput({ disabled }: { disabled: boolean }) {
  const seed = useSessionStore((state) => state.seed);
  const setSeed = useSessionStore((state) => state.setSeed);
  const [draft, setDraft] = useState(String(seed));
  const skipCommit = useRef(false);
  const [lastSeed, setLastSeed] = useState(seed);
  if (lastSeed !== seed) {
    // Keep the field honest when a file Open changes the store seed.
    setLastSeed(seed);
    setDraft(String(seed));
  }

  return (
    <label className="header-seed">
      <span>Seed</span>
      <input
        type="number"
        className="ui-input"
        min={0}
        max={MAX_SEED}
        step={1}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
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
            parsed > MAX_SEED
          ) {
            setDraft(String(seed));
            return;
          }
          setDraft(String(parsed));
          if (parsed !== seed) {
            setSeed(parsed);
          }
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

export function SimulationHeader({ level }: { level: LevelDefinition }) {
  const controller = useSimulation();
  const graph = useEditorStore((state) => state.graph);
  const phase = useSessionStore((state) => state.phase);
  const result = useSessionStore((state) => state.result);
  const resultRevision = useSessionStore((state) => state.resultRevision);
  const configRevision = useEditorStore((state) => state.configRevision);
  const seed = useSessionStore((state) => state.seed);
  const speed = useSessionStore((state) => state.speed);
  const frozenCost = useSessionStore((state) => state.frozenCostMicroUsdPerHour);
  const issues = useMemo(() => validateGraph(graph, { mode: 'run' }), [graph]);

  const busy = isSessionBusy(phase);
  const locked = isSessionLocked(phase);
  const cost = busy && frozenCost !== null ? frozenCost : calculateCost(graph);
  const budget = level.budgetMicroUsdPerHour;
  const overBudget = cost > budget;
  const pill = phase === 'completed' && result
    ? resultRevision !== configRevision || result.seed !== seed
      ? { tone: 'neutral' as const, label: 'Previous run' }
      : result.passed
        ? { tone: 'success' as const, label: 'Level passed' }
        : { tone: 'warning' as const, label: 'Level not passed' }
    : phasePill(phase);
  const canRun = issues.length === 0 && !busy;

  const start = () => {
    if (!canRun) {
      return;
    }
    controller.start({ graph, level, seed });
  };

  return (
    <header className="app-header">
      <div className="app-header__brand">
        <span className="app-header__mark" aria-hidden="true">
          <Snowflake size={20} strokeWidth={2.1} />
        </span>
        <div>
          <h1>{level.title}</h1>
          <p>L01 · shared catalog · {level.contentVersion}</p>
        </div>
      </div>

      <div className="app-header__meta">
        <div className={`cost-meter${overBudget ? ' is-over' : ''}`}>
          <span className="cost-meter__label">Cost / budget</span>
          <strong>{formatMicroUsd(cost)}/h</strong>
          <span>/ {formatMicroUsd(budget)}</span>
          <div className="cost-meter__bar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, (cost / budget) * 100)}%` }} />
          </div>
        </div>
        <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
      </div>

      <div className="app-header__controls">
        <SeedInput disabled={locked} />
        <div className="speed" role="group" aria-label="Simulation speed">
          {SPEEDS.map((value) => (
            <button
              type="button"
              key={value}
              className={speed === value ? 'is-active' : ''}
              aria-pressed={speed === value}
              onClick={() => controller.setSpeed(value)}
            >
              {value}×
            </button>
          ))}
        </div>
        <div className="run-controls">
          {phase === 'running' ? (
            <Button variant="secondary" icon={<Pause size={16} />} onClick={() => controller.pause()}>
              Pause
            </Button>
          ) : null}
          {phase === 'paused' ? (
            <Button variant="secondary" icon={<SkipForward size={16} />} onClick={() => controller.resume()}>
              Resume
            </Button>
          ) : null}
          {busy ? (
            <Button
              variant="secondary"
              icon={<Square size={15} />}
              onClick={() => controller.stop()}
            >
              Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<Play size={16} />}
              disabled={!canRun}
              title={
                issues.length > 0
                  ? `Fix the graph first: ${issues[0] ? issues[0].message : ''}`
                  : undefined
              }
              onClick={start}
            >
              {phase === 'completed' || phase === 'stopped' || phase === 'error'
                ? 'Run again'
                : 'Run'}
            </Button>
          )}
          {issues.length > 0 ? (
            <StatusPill tone="danger" icon={<RotateCcw size={13} />}>
              Checks: {issues.length}
            </StatusPill>
          ) : null}
        </div>
      </div>
    </header>
  );
}
