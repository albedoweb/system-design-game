import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeNode, type Diagnostic, type NodeMetric } from '../../domain';
import { NodeInspector } from './NodeInspector';

const node = makeNode('database', 'db-1', { x: 0, y: 0 });

const metrics: NodeMetric = {
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
};

const diagnostic: Diagnostic = {
  severity: 'error',
  message: '5 writes failed at the database queue (queue_overflow)',
  nodeId: 'db-1',
};

function renderInspector(
  overrides: Partial<Parameters<typeof NodeInspector>[0]> = {},
) {
  return render(
    <NodeInspector
      node={node}
      metrics={metrics}
      mode="peak"
      stale={false}
      snapshotTimeMs={42_300}
      diagnostics={[diagnostic]}
      locked={false}
      totalCostUsd={2.6}
      {...overrides}
    />,
  );
}

describe('NodeInspector pressure evidence', () => {
  it('shows peak, time-weighted averages and failure locations', () => {
    renderInspector();

    expect(screen.getByText('Peak during run')).toBeVisible();
    expect(screen.getByText(/Observed 60 s/)).toBeVisible();
    expect(screen.getByText(/slots 3.2 \/ 4/)).toBeVisible();
    expect(screen.getByText('Failure locations')).toBeVisible();
    expect(screen.getByText('dbQueue')).toBeVisible();
    expect(screen.getByText('queue_overflow')).toBeVisible();
    expect(
      screen.getByText(/not proof of root cause/),
    ).toBeVisible();
    expect(screen.getByText('Node diagnostics')).toBeVisible();
    expect(
      screen.getByText('5 writes failed at the database queue (queue_overflow)'),
    ).toBeVisible();
  });

  it('labels a stopped snapshot and partial pressure as observed so far', () => {
    renderInspector({ mode: 'stopped' });

    expect(screen.getByText('Stopped snapshot')).toBeVisible();
    expect(
      screen.getByText(/Last snapshot captured at/),
    ).toBeVisible();
    expect(screen.getByText(/before Stop/)).toBeVisible();
    expect(screen.getByText('Pressure observed so far')).toBeVisible();
    expect(
      screen.getByText('Failure locations observed so far'),
    ).toBeVisible();
    expect(screen.queryByText('Current metrics')).toBeNull();
    expect(screen.queryByText('Peak during run')).toBeNull();
  });

  it('hides previous-run evidence after settings change', () => {
    renderInspector({ stale: true });

    expect(
      screen.getByText(/Previous run — the graph, settings, or seed changed/),
    ).toBeVisible();
    expect(screen.queryByText('Node diagnostics')).toBeNull();
    expect(screen.queryByText('Failure locations')).toBeNull();
  });

  it('stays usable when the engine has no pressure fields', () => {
    const withoutPressure: NodeMetric = { ...metrics, pressure: undefined };
    renderInspector({ metrics: withoutPressure });

    expect(screen.getByText('Peak during run')).toBeVisible();
    expect(screen.getByText(/does not report peak occupancy/)).toBeVisible();
    expect(screen.getAllByText(/Queue peak/).length).toBeGreaterThan(0);
    expect(screen.getByText('Node diagnostics')).toBeVisible();
  });
});
