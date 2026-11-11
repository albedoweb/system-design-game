import { describe, expect, it } from 'vitest';

import type { Metric, RunResult, SimulationSnapshot } from '../../domain';
import { deriveRunEvidence, isRunResultStale } from './run-evidence';

const metric: Metric = {
  offered: 10,
  succeeded: 8,
  failed: 2,
  pending: 0,
  p50Ms: 10,
  p95Ms: 20,
  p99Ms: 30,
  errors: { queue_overflow: 2 },
};

const snapshot: SimulationSnapshot = {
  timeMs: 60_800,
  phase: 'completed',
  reads: metric,
  writes: metric,
  nodes: [],
  series: [],
  events: [],
};

function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    seed: 101,
    passed: false,
    costMicroUsdPerHour: 2_600_000,
    checks: [],
    snapshot,
    diagnostics: [
      {
        severity: 'error',
        message: '5 writes failed at the database queue (queue_overflow)',
        nodeId: 'db-1',
      },
      {
        severity: 'warning',
        message: 'App pool waiters peaked at 8',
        nodeId: 'app-1',
      },
      {
        severity: 'info',
        message: 'Database queue peak: 7',
        nodeId: 'db-1',
      },
    ],
    ...overrides,
  };
}

describe('run evidence freshness', () => {
  it('keeps peak evidence and node diagnostics for a fresh failed result', () => {
    const evidence = deriveRunEvidence({
      phase: 'completed',
      result: result(),
      resultRevision: 2,
      seed: 101,
      configRevision: 2,
      snapshot,
    });
    expect(evidence.stale).toBe(false);
    expect(evidence.mode).toBe('peak');
    expect(evidence.snapshot).toBe(snapshot);
    expect(evidence.freshResult).toBeTruthy();
    expect(evidence.diagnosticsByNode.get('db-1')).toEqual([
      expect.objectContaining({ severity: 'error' }),
    ]);
    expect(evidence.diagnosticsByNode.get('app-1')).toEqual([
      expect.objectContaining({ severity: 'warning' }),
    ]);
  });

  it('removes old blame and metrics when the seed changes', () => {
    const evidence = deriveRunEvidence({
      phase: 'completed',
      result: result(),
      resultRevision: 2,
      seed: 999,
      configRevision: 2,
      snapshot,
    });
    expect(evidence.stale).toBe(true);
    expect(evidence.mode).toBe('none');
    expect(evidence.snapshot).toBeNull();
    expect(evidence.freshResult).toBeNull();
    expect(evidence.diagnosticsByNode.size).toBe(0);
  });

  it('labels a fresh stopped snapshot separately from live running and paused', () => {
    const base = {
      result: null,
      resultRevision: null,
      seed: 101,
      configRevision: 2,
      snapshot,
      snapshotRevision: 2,
      snapshotSeed: 101,
    } as const;
    const stopped = deriveRunEvidence({ ...base, phase: 'stopped' });
    expect(stopped.stale).toBe(false);
    expect(stopped.mode).toBe('stopped');
    expect(stopped.snapshot).toBe(snapshot);

    expect(deriveRunEvidence({ ...base, phase: 'running' }).mode).toBe('live');
    expect(deriveRunEvidence({ ...base, phase: 'paused' }).mode).toBe('live');
  });

  it('hides a stopped run snapshot after settings or seed change', () => {
    const stale = deriveRunEvidence({
      phase: 'stopped',
      result: null,
      resultRevision: null,
      seed: 101,
      configRevision: 3,
      snapshot,
      snapshotRevision: 2,
      snapshotSeed: 101,
    });
    expect(stale.stale).toBe(true);
    expect(stale.mode).toBe('none');
    expect(stale.snapshot).toBeNull();

    const seedStale = deriveRunEvidence({
      phase: 'stopped',
      result: null,
      resultRevision: null,
      seed: 999,
      configRevision: 2,
      snapshot,
      snapshotRevision: 2,
      snapshotSeed: 101,
    });
    expect(seedStale.stale).toBe(true);
    expect(seedStale.snapshot).toBeNull();
  });

  it('removes old blame and metrics when settings change', () => {
    const evidence = deriveRunEvidence({
      phase: 'completed',
      result: result(),
      resultRevision: 1,
      seed: 101,
      configRevision: 2,
      snapshot,
    });
    expect(evidence.stale).toBe(true);
    expect(evidence.snapshot).toBeNull();
    expect(evidence.diagnosticsByNode.size).toBe(0);
  });

  it('does not stale a result when only layout moved', () => {
    // Layout moves do not increment configRevision.
    expect(
      isRunResultStale({
        result: result(),
        resultRevision: 2,
        seed: 101,
        configRevision: 2,
      }),
    ).toBe(false);
  });

  it('never paints every node for a passed or cost-only failure', () => {
    const passed = deriveRunEvidence({
      phase: 'completed',
      result: result({ passed: true }),
      resultRevision: 2,
      seed: 101,
      configRevision: 2,
      snapshot,
    });
    expect(passed.mode).toBe('peak');
    expect(passed.diagnosticsByNode.size).toBe(0);

    const costOnly = deriveRunEvidence({
      phase: 'completed',
      result: result({
        diagnostics: [
          {
            severity: 'error',
            message: 'Cost 8.00 $/h is above the budget of 5.50 $/h',
          },
        ],
      }),
      resultRevision: 2,
      seed: 101,
      configRevision: 2,
      snapshot,
    });
    expect(costOnly.stale).toBe(false);
    expect(costOnly.mode).toBe('peak');
    expect(costOnly.diagnosticsByNode.size).toBe(0);
  });

  it('accepts older results without a stored revision', () => {
    const evidence = deriveRunEvidence({
      phase: 'completed',
      result: result(),
      resultRevision: null,
      seed: 101,
      configRevision: 12,
      snapshot,
    });
    expect(evidence.stale).toBe(false);
    expect(evidence.mode).toBe('peak');
  });
});
