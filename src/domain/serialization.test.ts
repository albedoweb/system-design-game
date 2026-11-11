import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEVEL,
  INITIAL_GRAPH,
  createInitialGraph,
  type Metric,
  type NodeMetric,
  type RunResult,
  type SeriesPoint,
  type SimulationSnapshot,
  type WorkerCommand,
  type WorkerMessage,
} from './index';

const metric: Metric = {
  offered: 100,
  succeeded: 98,
  failed: 2,
  pending: 0,
  p50Ms: 12.5,
  p95Ms: 140,
  p99Ms: null,
  errors: { timeout: 1, queue_overflow: 1 },
};

const nodeMetric: NodeMetric = {
  nodeId: 'app-1',
  busy: 4,
  queued: 2,
  poolBusy: 3,
  poolQueued: 0,
  hits: 10,
  misses: 20,
  coalesced: 1,
  errors: 2,
  maxQueued: 30,
  completed: 99,
};

const point: SeriesPoint = {
  timeMs: -1000,
  readRps: 285,
  writeRps: 15,
  successRps: 290,
  errorRps: 10,
  p95Ms: null,
  dbQueue: 3,
  hitRatio: null,
};

const snapshot: SimulationSnapshot = {
  timeMs: 60_800,
  phase: 'completed',
  reads: metric,
  writes: metric,
  nodes: [nodeMetric],
  series: [point],
  events: [{ timeMs: 30_000, message: 'Cache flush', nodeId: 'cache-1' }],
};

const result: RunResult = {
  seed: 101,
  passed: false,
  costMicroUsdPerHour: 2_600_000,
  checks: [
    {
      id: 'read-availability',
      label: 'Read availability',
      actual: 98,
      target: 99.5,
      unit: '%',
      passed: false,
    },
    {
      id: 'cost',
      label: 'Cost',
      actual: 2.6,
      target: 5.5,
      unit: '$/h',
      passed: true,
    },
  ],
  snapshot,
  diagnostics: [
    { severity: 'error', message: 'Database queue overflow', nodeId: 'db-1' },
  ],
};

describe('serializable wire types', () => {
  it('round-trips graph documents through JSON', () => {
    expect(JSON.parse(JSON.stringify(INITIAL_GRAPH))).toEqual(createInitialGraph());
  });

  it('round-trips snapshots and run results without losing null semantics', () => {
    const roundTripped = JSON.parse(JSON.stringify(result)) as RunResult;
    expect(roundTripped).toEqual(result);
    expect(roundTripped.snapshot.reads.p95Ms).toBe(140);
    expect(roundTripped.snapshot.reads.p99Ms).toBeNull();
    expect(roundTripped.snapshot.series[0]?.hitRatio).toBeNull();
    expect(roundTripped.checks[0]?.actual).toBe(98);
  });

  it('round-trips worker commands and messages', () => {
    const command: WorkerCommand = {
      type: 'start',
      runId: 'run-1',
      graph: createInitialGraph(),
      level: DEFAULT_LEVEL,
      seed: 101,
      speed: 4,
    };
    expect(JSON.parse(JSON.stringify(command))).toEqual(command);

    const message: WorkerMessage = {
      type: 'snapshot',
      runId: 'run-1',
      snapshot,
    };
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  });
});
