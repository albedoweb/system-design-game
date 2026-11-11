import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createInitialGraph,
  type Diagnostic,
  type Metric,
  type NodeMetric,
  type RunResult,
  type SimulationSnapshot,
} from '../../domain';
import LegacyLevels from '../../app/LegacyLevels';
import { useEditorStore } from '../../state/editor-store';
import { useSessionStore } from '../../state/session-store';

const metric: Metric = {
  offered: 20,
  succeeded: 15,
  failed: 5,
  pending: 0,
  p50Ms: 12,
  p95Ms: 40,
  p99Ms: 80,
  errors: { queue_overflow: 5 },
};

function nodeMetric(overrides: Partial<NodeMetric> = {}): NodeMetric {
  return {
    nodeId: 'db-1',
    busy: 0,
    queued: 0,
    poolBusy: 0,
    poolQueued: 0,
    hits: 0,
    misses: 0,
    coalesced: 0,
    errors: 5,
    maxQueued: 7,
    completed: 15,
    pressure: {
      observedMs: 60_000,
      busyPeak: 4,
      poolBusyPeak: 0,
      poolQueuedPeak: 0,
      busyAvg: 3.2,
      poolBusyAvg: 0,
      failures: [{ code: 'queue_overflow', stage: 'dbQueue', count: 5 }],
    },
    ...overrides,
  };
}

function snapshot(nodes: NodeMetric[] = [nodeMetric()]): SimulationSnapshot {
  return {
    timeMs: 60_800,
    phase: 'completed',
    reads: metric,
    writes: metric,
    nodes,
    series: [],
    events: [],
  };
}

function result(
  diagnostics: Diagnostic[],
  overrides: Partial<RunResult> = {},
): RunResult {
  return {
    seed: 101,
    passed: false,
    costMicroUsdPerHour: 2_600_000,
    checks: [],
    snapshot: snapshot(),
    diagnostics,
    ...overrides,
  };
}

function renderCompleted(run: RunResult) {
  render(<LegacyLevels route="cold-cache" />);
  act(() => {
    useSessionStore.setState({
      phase: 'completed',
      result: run,
      snapshot: run.snapshot,
      resultRevision: useEditorStore.getState().configRevision,
      seed: run.seed,
    });
  });
}

function renderStopped() {
  const stoppedSnapshot = snapshot();
  render(<LegacyLevels route="cold-cache" />);
  act(() => {
    useSessionStore.setState({
      phase: 'stopped',
      result: null,
      resultRevision: null,
      snapshot: stoppedSnapshot,
      snapshotRevision: useEditorStore.getState().configRevision,
      snapshotSeed: 101,
      seed: 101,
    });
  });
}

afterEach(() => {
  act(() => {
    useSessionStore.getState().reset();
    useEditorStore.getState().loadGraph(createInitialGraph());
  });
});

describe('component cards after a completed run', () => {
  it('shows retained peak evidence and a node-linked failure badge', async () => {
    renderCompleted(
      result([
        {
          severity: 'error',
          message: '5 writes failed at the database queue (queue_overflow)',
          nodeId: 'db-1',
        },
      ]),
    );

    const card = await screen.findByTestId('rf__node-db-1');
    expect(within(card).getByText('Run average')).toBeInTheDocument();
    expect(within(card).getByText('3.2 / 4')).toBeInTheDocument();
    expect(within(card).getByText('peak 4 / 4')).toBeInTheDocument();
    expect(within(card).getByText('Error')).toBeInTheDocument();
    const meter = card.querySelector(
      '[role="meter"][aria-label="Slots occupancy"]',
    );
    expect(meter).not.toBeNull();
    expect(meter?.getAttribute('aria-valuenow')).toBe('3.2');
    expect(meter?.getAttribute('aria-valuemax')).toBe('4');
    const valueText = meter?.getAttribute('aria-valuetext') ?? '';
    expect(valueText).toContain('Orange');
    expect(valueText).toContain('Run average 3.2 of 4 slots');
    expect(valueText).toContain('Peak 4 of 4');
    expect(valueText).toContain(
      'peak alone does not show how long load was high',
    );
    expect(
      within(card).getByText(
        /5 writes failed at the database queue \(queue_overflow\)/,
      ),
    ).toBeInTheDocument();
    expect(card.querySelector('.domain-node--diagnostic-error')).not.toBeNull();
  });

  it('hides previous-run blame after the seed changes', async () => {
    renderCompleted(
      result([
        {
          severity: 'error',
          message: '5 writes failed at the database queue (queue_overflow)',
          nodeId: 'db-1',
        },
      ]),
    );
    const card = await screen.findByTestId('rf__node-db-1');
    expect(card.querySelector('.domain-node--diagnostic-error')).not.toBeNull();

    act(() => {
      useSessionStore.getState().setSeed(999);
    });

    await waitFor(() => {
      expect(card.querySelector('.domain-node--diagnostic-error')).toBeNull();
      expect(within(card).queryByText('Error')).toBeNull();
    });
    expect(document.querySelector('.canvas-stale')).not.toBeNull();
  });

  it('keeps fresh evidence after a layout-only move', async () => {
    renderCompleted(
      result([
        {
          severity: 'error',
          message: '5 writes failed at the database queue (queue_overflow)',
          nodeId: 'db-1',
        },
      ]),
    );
    const card = await screen.findByTestId('rf__node-db-1');
    expect(card.querySelector('.domain-node--diagnostic-error')).not.toBeNull();

    act(() => {
      useEditorStore.getState().moveNode('app-1', { x: 250, y: 160 });
    });

    expect(card.querySelector('.domain-node--diagnostic-error')).not.toBeNull();
    expect(document.querySelector('.canvas-stale')).toBeNull();
  });

  it('labels a stopped snapshot as stopped rather than current or completed', async () => {
    renderStopped();

    const card = await screen.findByTestId('rf__node-db-1');
    expect(within(card).getByText('Stopped snapshot')).toBeInTheDocument();
    expect(within(card).getByText('queue at stop')).toBeInTheDocument();
    expect(
      document.querySelector('.metrics__summary')?.textContent,
    ).toContain('stopped');
    expect(
      screen.getByText(/Stopped — this is the last snapshot/),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Components in the stopped snapshot'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Run result')).toBeNull();
    expect(screen.queryByText('Peak during run')).toBeNull();
  });

  it('does not paint every component for a cost-only global failure', async () => {
    renderCompleted(
      result([
        {
          severity: 'error',
          message: 'Cost 8.00 $/h is above the budget of 5.50 $/h',
        },
      ]),
    );

    await screen.findByTestId('rf__node-db-1');
    expect(document.querySelectorAll('.domain-node--diagnostic-error')).toHaveLength(0);
    expect(document.querySelectorAll('.domain-node--diagnostic-warning')).toHaveLength(0);
    expect(document.querySelectorAll('.domain-node__peak').length).toBeGreaterThan(0);
  });
});
