import { create } from 'zustand';

import {
  DEFAULT_LEVEL,
  type RunResult,
  type SimulationSnapshot,
  type SimulationSpeed,
} from '../domain';
import type { BestLocalResult } from './local-best';

export type SessionPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'error';

export interface SessionState {
  phase: SessionPhase;
  runId: string | null;
  seed: number;
  speed: SimulationSpeed;
  snapshot: SimulationSnapshot | null;
  result: RunResult | null;
  resultRevision: number | null;
  /** Settings revision and seed that produced `snapshot`, even after a stop. */
  snapshotRevision: number | null;
  snapshotSeed: number | null;
  error: string | null;
  notice: string | null;
  frozenCostMicroUsdPerHour: number | null;
  best: BestLocalResult | null;
  bestError: string | null;
  isNewBest: boolean;
  setSeed: (seed: number) => void;
  setPhase: (phase: SessionPhase) => void;
  reset: () => void;
}

export function initialSessionState(): Pick<
  SessionState,
  | 'phase'
  | 'runId'
  | 'seed'
  | 'speed'
  | 'snapshot'
  | 'result'
  | 'resultRevision'
  | 'snapshotRevision'
  | 'snapshotSeed'
  | 'error'
  | 'notice'
  | 'frozenCostMicroUsdPerHour'
  | 'best'
  | 'bestError'
  | 'isNewBest'
> {
  return {
    phase: 'idle',
    runId: null,
    seed: DEFAULT_LEVEL.defaultSeed,
    speed: 1,
    snapshot: null,
    result: null,
    resultRevision: null,
    snapshotRevision: null,
    snapshotSeed: null,
    error: null,
    notice: null,
    frozenCostMicroUsdPerHour: null,
    best: null,
    bestError: null,
    isNewBest: false,
  };
}

export const useSessionStore = create<SessionState>((set) => ({
  ...initialSessionState(),
  setSeed: (seed) => set({ seed }),
  setPhase: (phase) => set({ phase }),
  reset: () => set(initialSessionState()),
}));

export function isSessionBusy(phase: SessionPhase): boolean {
  return (
    phase === 'starting' ||
    phase === 'running' ||
    phase === 'paused' ||
    phase === 'stopping'
  );
}

/**
 * True while the graph must stay frozen. `stopping` is included: the worker may
 * still be running until its stop acknowledgement (or the stop timeout) arrives,
 * and edits made in that window would not belong to the running simulation.
 */
export function isSessionLocked(phase: SessionPhase): boolean {
  return isSessionBusy(phase);
}
