import { useMemo } from 'react';

import type {
  Diagnostic,
  RunResult,
  SimulationSnapshot,
} from '../../domain';
import { useEditorStore } from '../../state/editor-store';
import { useSessionStore, type SessionPhase } from '../../state/session-store';

export type RunEvidenceMode = 'none' | 'live' | 'stopped' | 'peak';

export interface RunEvidence {
  phase: SessionPhase;
  result: RunResult | null;
  /** Null while a previous result is stale or before any snapshot exists. */
  snapshot: SimulationSnapshot | null;
  stale: boolean;
  /** Only a fresh, completed result is allowed to drive peak/blame evidence. */
  freshResult: RunResult | null;
  mode: RunEvidenceMode;
  /** Warning/error diagnostics attached to a node by a fresh failed result. */
  diagnosticsByNode: ReadonlyMap<string, Diagnostic[]>;
}

export interface RunEvidenceInput {
  phase: SessionPhase;
  result: RunResult | null;
  resultRevision: number | null;
  seed: number;
  configRevision: number;
  snapshot: SimulationSnapshot | null;
  /** Optional for older persisted state and unit fixtures. */
  snapshotRevision?: number | null;
  snapshotSeed?: number | null;
}

/**
 * Layout-only moves do not increment `configRevision`, so moving a node never
 * makes a completed result stale. Settings, topology and seed changes do.
 */
export function isRunResultStale(input: {
  result: RunResult | null;
  resultRevision: number | null;
  seed: number;
  configRevision: number;
}): boolean {
  if (!input.result) {
    return false;
  }
  return (
    input.result.seed !== input.seed ||
    (input.resultRevision !== null &&
      input.resultRevision !== input.configRevision)
  );
}

function collectNodeDiagnostics(
  result: RunResult | null,
): Map<string, Diagnostic[]> {
  const byNode = new Map<string, Diagnostic[]>();
  if (!result || result.passed) {
    return byNode;
  }
  for (const diagnostic of result.diagnostics) {
    if (
      !diagnostic.nodeId ||
      (diagnostic.severity !== 'warning' && diagnostic.severity !== 'error')
    ) {
      continue;
    }
    const list = byNode.get(diagnostic.nodeId) ?? [];
    list.push(diagnostic);
    byNode.set(diagnostic.nodeId, list);
  }
  return byNode;
}

export function isSnapshotStale(input: {
  snapshot: SimulationSnapshot | null;
  snapshotRevision?: number | null;
  snapshotSeed?: number | null;
  seed: number;
  configRevision: number;
}): boolean {
  if (!input.snapshot) {
    return false;
  }
  return (
    (input.snapshotSeed !== null &&
      input.snapshotSeed !== undefined &&
      input.snapshotSeed !== input.seed) ||
    (input.snapshotRevision !== null &&
      input.snapshotRevision !== undefined &&
      input.snapshotRevision !== input.configRevision)
  );
}

export function deriveRunEvidence(input: RunEvidenceInput): RunEvidence {
  // A completed result carries its own revision/seed; a stopped run only has
  // the snapshot, so it needs the values captured when the run started.
  const stale = isRunResultStale(input) || isSnapshotStale(input);
  const freshResult = input.result && !stale ? input.result : null;
  const snapshot = stale ? null : input.snapshot;
  const mode: RunEvidenceMode = freshResult?.snapshot
    ? 'peak'
    : snapshot
      ? input.phase === 'stopped'
        ? 'stopped'
        : 'live'
      : 'none';
  return {
    phase: input.phase,
    result: input.result,
    snapshot,
    stale,
    freshResult,
    mode,
    diagnosticsByNode: collectNodeDiagnostics(freshResult),
  };
}

export function useRunEvidence(): RunEvidence {
  const phase = useSessionStore((state) => state.phase);
  const result = useSessionStore((state) => state.result);
  const resultRevision = useSessionStore((state) => state.resultRevision);
  const seed = useSessionStore((state) => state.seed);
  const snapshot = useSessionStore((state) => state.snapshot);
  const snapshotRevision = useSessionStore((state) => state.snapshotRevision);
  const snapshotSeed = useSessionStore((state) => state.snapshotSeed);
  const configRevision = useEditorStore((state) => state.configRevision);

  return useMemo(
    () =>
      deriveRunEvidence({
        phase,
        result,
        resultRevision,
        seed,
        configRevision,
        snapshot,
        snapshotRevision,
        snapshotSeed,
      }),
    [
      configRevision,
      phase,
      result,
      resultRevision,
      seed,
      snapshot,
      snapshotRevision,
      snapshotSeed,
    ],
  );
}
