import { describe, expect, it } from 'vitest';

import { createInitialGraph, type GraphDocument } from '../../domain/graph';
import { DEFAULT_LEVEL } from '../../domain/level';
import type { RunResult, SimulationSnapshot } from '../../domain/simulation';
import { createSimulation, createSimulationFromTrace } from '../index';
import { ClassMetrics } from '../metrics';
import {
  buildDiagnostics,
  type DiagnosticsInput,
  type PressureNodeSummary,
} from '../result';
import {
  makeTrace,
  offered,
  runTrace,
  testGraph,
  testLevel,
} from './helpers';

type Pressure = NonNullable<
  SimulationSnapshot['nodes'][number]['pressure']
>;

function node(snapshot: SimulationSnapshot, nodeId: string) {
  const metric = snapshot.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!metric) {
    throw new Error(`node ${nodeId} missing`);
  }
  return metric;
}

function pressure(snapshot: SimulationSnapshot, nodeId: string): Pressure {
  const metric = node(snapshot, nodeId).pressure;
  if (!metric) {
    throw new Error(`pressure for ${nodeId} missing`);
  }
  return metric;
}

function check(result: RunResult, id: string) {
  const found = result.checks.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`check ${id} missing`);
  }
  return found;
}

function stageCount(metric: Pressure, stage: string): number {
  return metric.failures
    .filter((failure) => failure.stage === stage)
    .reduce((total, failure) => total + failure.count, 0);
}

function totalFailureEvidence(result: RunResult): number {
  return result.snapshot.nodes.reduce(
    (total, metric) =>
      total +
      (metric.pressure?.failures.reduce(
        (nodeTotal, failure) => nodeTotal + failure.count,
        0,
      ) ?? 0),
    0,
  );
}

/** Full-level runs are expensive; each architecture is evaluated once. */
const defaultResults = new Map<string, RunResult>();

function runDefault(id: string, graph: GraphDocument): RunResult {
  const cached = defaultResults.get(id);
  if (cached) {
    return cached;
  }
  const engine = createSimulation(graph, DEFAULT_LEVEL, DEFAULT_LEVEL.defaultSeed);
  engine.advance(DEFAULT_LEVEL.durationMs + DEFAULT_LEVEL.drainMs);
  const result = engine.result();
  defaultResults.set(id, result);
  return result;
}

function noCacheLargeDatabase(poolSize: number): GraphDocument {
  return testGraph({
    cache: null,
    app: { poolSize },
    database: { size: 'large' },
  });
}

function noCacheSaturatedSmallDatabase(): GraphDocument {
  return testGraph({
    cache: null,
    app: { size: 'large', poolSize: 8 },
    database: { size: 'small' },
  });
}

function cachePassingButOverBudget(): GraphDocument {
  return testGraph({
    apps: 2,
    clientToLoadBalancer: true,
    app: { size: 'large' },
    cache: { size: 'large', coalescing: true },
    database: { size: 'large' },
  });
}

describe('measured resource pressure', () => {
  it('keeps the starter run outcome and shows pressure only as evidence', () => {
    const result = runDefault('starter', createInitialGraph());

    expect(result.passed).toBe(false);
    expect(result.snapshot.reads.offered).toBe(31439);
    expect(result.snapshot.reads.succeeded).toBe(31277);
    expect(result.snapshot.reads.failed).toBe(162);
    expect(result.snapshot.reads.errors).toEqual({ queue_overflow: 162 });
    expect(result.snapshot.writes.offered).toBe(1624);
    expect(result.snapshot.writes.succeeded).toBe(1620);
    expect(result.snapshot.writes.failed).toBe(4);

    expect(check(result, 'read-availability').actual).toBeCloseTo(
      99.4847164350011,
      9,
    );
    expect(check(result, 'critical-read-availability').actual).toBeCloseTo(
      96.21406870764197,
      9,
    );
    expect(check(result, 'cost').passed).toBe(true);
    expect(check(result, 'cost').actual).toBeCloseTo(2.6, 9);

    const app = pressure(result.snapshot, 'app-1');
    expect(app.observedMs).toBe(DEFAULT_LEVEL.durationMs);
    expect(app.failures).toEqual([
      { code: 'queue_overflow', stage: 'appQueue', count: 166 },
    ]);
    expect(app.busyPeak).toBe(16);
    expect(app.busyAvg).toBeCloseTo(4.391013, 6);
    expect(app.poolBusyPeak).toBe(8);
    expect(app.poolQueuedPeak).toBe(8);
    expect(totalFailureEvidence(result)).toBe(
      result.snapshot.reads.failed + result.snapshot.writes.failed,
    );

    // A passing cache/DB must not be blamed for the app admission failures.
    for (const nodeId of ['cache-1', 'db-1']) {
      expect(pressure(result.snapshot, nodeId).failures).toEqual([]);
      const linked = result.diagnostics.filter(
        (diagnostic) => diagnostic.nodeId === nodeId,
      );
      expect(linked.every((diagnostic) => diagnostic.severity === 'info')).toBe(
        true,
      );
    }
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('admission queue was full'),
      ),
    ).toBe(true);
  });

  it('explains the mandated pool-8 baseline with pool and DB measurements', () => {
    const result = runDefault(
      'pool-8-baseline',
      testGraph({
        cache: null,
        app: { poolSize: 8 },
        database: { size: 'large' },
      }),
    );

    expect(result.passed).toBe(false);
    expect(check(result, 'cost').actual).toBeCloseTo(8.2, 9);
    expect(result.snapshot.reads.offered).toBe(31439);
    expect(result.snapshot.reads.succeeded).toBe(20339);
    expect(result.snapshot.reads.failed).toBe(11100);
    expect(result.snapshot.writes.offered).toBe(1624);
    expect(result.snapshot.writes.succeeded).toBe(1029);
    expect(result.snapshot.writes.failed).toBe(595);

    const app = pressure(result.snapshot, 'app-1');
    const database = pressure(result.snapshot, 'db-1');
    expect(app.poolBusyPeak).toBe(8);
    expect(app.poolBusyAvg).toBeCloseTo(6.685615, 6);
    expect(app.poolQueuedPeak).toBe(8);
    expect(app.busyPeak).toBe(16);
    expect(app.busyAvg).toBeCloseTo(10.691204, 6);
    expect(app.failures).toEqual([
      { code: 'queue_overflow', stage: 'appQueue', count: 11695 },
    ]);
    expect(database.busyPeak).toBe(8);
    expect(database.busyAvg).toBeCloseTo(5.973253, 6);
    expect(database.failures).toEqual([]);
    expect(totalFailureEvidence(result)).toBe(
      result.snapshot.reads.failed + result.snapshot.writes.failed,
    );

    const admission = result.diagnostics.find(
      (diagnostic) =>
        diagnostic.nodeId === 'app-1' &&
        diagnostic.message.includes('admission queue was full'),
    );
    expect(admission?.severity).toBe('error');
    expect(admission?.message).toContain('connection pool peak 8 of 8');
    expect(admission?.message).toContain('average 6.69 of 8');
    expect(admission?.message).toContain('waiter peak 8');
    expect(admission?.message).toContain(
      'database was below its slot limit at peak (8 of 16, average 5.97)',
    );
    expect(admission?.message).toContain(
      'app pool was at its measured limit',
    );
    expect(admission?.message).toContain(
      'would not by itself remove the pool wait',
    );
    expect(admission?.message).toContain('not proof of a single root cause');
  });

  it('does not infer a pool wait when a full pool peak had no waiters', () => {
    const reads = new ClassMetrics();
    reads.recordOffered(false);
    reads.recordFailure('queue_overflow', false);
    const writes = new ClassMetrics();
    writes.recordOffered(false);
    writes.recordSuccess(48, false);

    const app: PressureNodeSummary = {
      nodeId: 'app-1',
      label: 'App Server',
      kind: 'appServer',
      capacity: 16,
      poolSize: 8,
      queueLimit: 128,
      maxQueued: 128,
      busyPeak: 16,
      busyAvg: 10.5,
      poolBusyPeak: 8,
      poolBusyAvg: 6.5,
      poolQueuedPeak: 0,
      failures: [{ code: 'queue_overflow', stage: 'appQueue', count: 1 }],
      errors: 1,
    };
    const database: PressureNodeSummary = {
      nodeId: 'db-1',
      label: 'Database',
      kind: 'database',
      capacity: 16,
      poolSize: null,
      queueLimit: 128,
      maxQueued: 0,
      busyPeak: 8,
      busyAvg: 5.97,
      poolBusyPeak: 0,
      poolBusyAvg: 0,
      poolQueuedPeak: 0,
      failures: [],
      errors: 0,
    };
    const input: DiagnosticsInput = {
      costMicroUsdPerHour: 1_000_000,
      budgetMicroUsdPerHour: 5_500_000,
      deadlineMs: 800,
      reads,
      writes,
      nodes: [app, database],
    };

    const admission = buildDiagnostics(input).find(
      (diagnostic) =>
        diagnostic.nodeId === 'app-1' &&
        diagnostic.message.includes('admission queue was full'),
    );
    expect(admission?.message).toContain('connection pool peak 8 of 8');
    expect(admission?.message).toContain('waiter peak 0');
    expect(admission?.message).toContain(
      'database was below its slot limit at peak (8 of 16, average 5.97)',
    );
    expect(admission?.message).toContain(
      'app pool was at its measured limit',
    );
    // The full-peak fact is retained, but no wait-specific advice is invented.
    expect(admission?.message).not.toContain('pool wait');
    expect(admission?.message).not.toContain('measured waiters');

    const fullDatabase: PressureNodeSummary = {
      ...database,
      busyPeak: 16,
      busyAvg: 16,
    };
    const dbAtLimit = buildDiagnostics({
      ...input,
      nodes: [app, fullDatabase],
    }).find(
      (diagnostic) =>
        diagnostic.nodeId === 'app-1' &&
        diagnostic.message.includes('admission queue was full'),
    );
    expect(dbAtLimit?.message).toContain(
      'database also reached its slot limit at peak (16 of 16',
    );
    expect(dbAtLimit?.message).toContain(
      'app pool was at its measured limit',
    );
    expect(dbAtLimit?.message).not.toContain('move the wait');
  });

  it('explains a restrictive app pool while the large database has headroom', () => {
    const result = runDefault('pool-2', noCacheLargeDatabase(2));

    expect(result.passed).toBe(false);
    const app = pressure(result.snapshot, 'app-1');
    const database = pressure(result.snapshot, 'db-1');
    expect(stageCount(app, 'appQueue')).toBeGreaterThan(0);
    expect(stageCount(app, 'poolQueue')).toBeGreaterThan(0);
    expect(database.busyPeak).toBe(2);
    expect(stageCount(database, 'dbExecuting')).toBeGreaterThan(0);
    expect(totalFailureEvidence(result)).toBe(
      result.snapshot.reads.failed + result.snapshot.writes.failed,
    );

    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.nodeId === 'app-1' &&
          diagnostic.message.includes('app connection pool slot') &&
          diagnostic.message.includes('below its slot limit at peak (2 of 16)'),
      ),
    ).toBe(true);
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.nodeId === 'db-1' &&
          diagnostic.message.includes('below its slot limit at peak (2 of 16)'),
      ),
    ).toBe(true);
    const dbExecution = result.diagnostics.find(
      (diagnostic) =>
        diagnostic.nodeId === 'db-1' &&
        diagnostic.message.includes('still executing'),
    );
    expect(dbExecution?.message).toContain(
      'not a reconstruction of earlier wait history',
    );
    expect(dbExecution?.message).not.toContain('expired after earlier waiting');
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes(
          'At the busiest scheduled second the model implies 15.12 slots',
        ),
      ),
    ).toBe(true);
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('94.5% of capacity'),
      ),
    ).toBe(true);
  });

  it('contrasts a widened app pool that pushes the observed pressure to the DB', () => {
    const restricted = runDefault('pool-2', noCacheLargeDatabase(2));
    const wide = runDefault('pool-16', noCacheLargeDatabase(16));

    const restrictedApp = pressure(restricted.snapshot, 'app-1');
    const restrictedDb = pressure(restricted.snapshot, 'db-1');
    const wideApp = pressure(wide.snapshot, 'app-1');
    const wideDb = pressure(wide.snapshot, 'db-1');

    expect(stageCount(restrictedApp, 'poolQueue')).toBeGreaterThan(0);
    expect(stageCount(wideApp, 'poolQueue')).toBe(0);
    expect(restrictedDb.busyPeak).toBe(2);
    expect(wideDb.busyPeak).toBe(16);
    expect(wideDb.busyAvg).toBeGreaterThan(restrictedDb.busyAvg);
    expect(restrictedApp.poolBusyPeak).toBe(2);
    expect(wideApp.poolBusyPeak).toBe(16);
    expect(totalFailureEvidence(wide)).toBe(
      wide.snapshot.reads.failed + wide.snapshot.writes.failed,
    );
  });

  it('shows a saturated small database at both queue and execution', () => {
    const result = runDefault('db-small', noCacheSaturatedSmallDatabase());
    const database = pressure(result.snapshot, 'db-1');

    expect(result.passed).toBe(false);
    expect(database.busyPeak).toBe(4);
    expect(database.busyAvg).toBeCloseTo(4, 6);
    expect(stageCount(database, 'dbQueue')).toBeGreaterThan(0);
    expect(stageCount(database, 'dbExecuting')).toBeGreaterThan(0);
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.nodeId === 'db-1' &&
          diagnostic.message.includes('waiting for a database slot'),
      ),
    ).toBe(true);
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('378.0% of capacity'),
      ),
    ).toBe(true);
  });

  it('keeps a cost-only failure separate from passing traffic nodes', () => {
    const result = runDefault('cost-only', cachePassingButOverBudget());

    expect(result.passed).toBe(false);
    expect(check(result, 'cost').passed).toBe(false);
    expect(check(result, 'cost').actual).toBeCloseTo(10.5, 9);
    for (const item of result.checks) {
      if (item.id !== 'cost') {
        expect(item.passed).toBe(true);
      }
    }
    expect(result.snapshot.reads.failed).toBe(0);
    expect(result.snapshot.writes.failed).toBe(0);
    expect(totalFailureEvidence(result)).toBe(0);
    for (const metric of result.snapshot.nodes) {
      expect(metric.pressure?.failures ?? []).toEqual([]);
    }

    const costDiagnostic = result.diagnostics.find((diagnostic) =>
      diagnostic.message.startsWith('Cost '),
    );
    expect(costDiagnostic?.severity).toBe('error');
    expect(costDiagnostic?.nodeId).toBeUndefined();
    expect(costDiagnostic?.message).toContain('separate gate');
    for (const diagnostic of result.diagnostics) {
      if (diagnostic.nodeId) {
        expect(diagnostic.severity).toBe('info');
      }
    }
  });

  it('reports zero pressure before the evaluation window starts', () => {
    const level = testLevel({ durationMs: 1000, warmupMs: 500 });
    const engine = createSimulationFromTrace(
      testGraph(),
      level,
      makeTrace([offered('read', 0, -100, 0, false)]),
    );
    const before = engine.advance(-200);
    expect(pressure(before, 'app-1')).toEqual({
      observedMs: 0,
      busyPeak: 0,
      poolBusyPeak: 0,
      poolQueuedPeak: 0,
      busyAvg: 0,
      poolBusyAvg: 0,
      failures: [],
    });
    engine.advance(level.durationMs + level.drainMs);
    expect(
      pressure(engine.result().snapshot, 'app-1').observedMs,
    ).toBe(level.durationMs);
  });

  it('excludes warmup state from time before zero and ignores drain time', () => {
    const run = (drainMs: number) => {
      const level = testLevel({
        durationMs: 2000,
        warmupMs: 1000,
        drainMs,
        deadlineMs: 800,
        timing: { appCpuMs: 500 },
      });
      return runTrace(
        testGraph({ cache: null }),
        level,
        [offered('read', 0, -100, 0, false), offered('read', 1, 1990, 1)],
      ).result();
    };

    const shortDrain = run(800);
    const longDrain = run(1600);
    const app = pressure(shortDrain.snapshot, 'app-1');
    const database = pressure(shortDrain.snapshot, 'db-1');

    expect(app.observedMs).toBe(2000);
    expect(database.observedMs).toBe(2000);
    // The warmup read holds an app slot for [0, 424) and a DB slot for 16 ms.
    // The scored read holds the app slot only for the last 4 ms before 2000.
    expect(app.busyAvg).toBe(0.214);
    expect(database.busyAvg).toBe(0.008);
    expect(app.busyPeak).toBe(1);
    expect(database.busyPeak).toBe(1);

    const shortPressure = shortDrain.snapshot.nodes.map(
      (metric) => metric.pressure,
    );
    const longPressure = longDrain.snapshot.nodes.map(
      (metric) => metric.pressure,
    );
    expect(longPressure).toEqual(shortPressure);
  });

  it('is exactly pressure-invariant at 100 ms, 1000 ms and one-shot advances', () => {
    const level = testLevel({
      durationMs: 1000,
      warmupMs: 200,
      drainMs: 500,
      deadlineMs: 300,
      readSchedule: [{ atMs: 0, rps: 120 }],
      writeSchedule: [{ atMs: 0, rps: 20 }],
      timing: { dbReadMs: 40, dbWriteMs: 60, appCpuMs: 5 },
    });
    const graph = testGraph({
      app: { poolSize: 1 },
      cache: { coalescing: true, poolSize: 1, queueLimit: 2 },
      database: { queueLimit: 2 },
    });
    const end = level.durationMs + level.drainMs;
    const run = (chunkMs: number) => {
      const engine = createSimulation(graph, level, 211);
      if (chunkMs === 0) {
        engine.advance(end);
      } else {
        let time = -level.warmupMs;
        while (time < end) {
          time = Math.min(end, time + chunkMs);
          engine.advance(time);
        }
      }
      return engine.result();
    };

    const fine = run(100);
    expect(run(1000)).toEqual(fine);
    expect(run(0)).toEqual(fine);

    expect(fine.snapshot.reads.failed).toBeGreaterThan(0);
    expect(totalFailureEvidence(fine)).toBe(
      fine.snapshot.reads.failed + fine.snapshot.writes.failed,
    );
    expect(stageCount(pressure(fine.snapshot, 'app-1'), 'poolQueue')).toBeGreaterThan(
      0,
    );
    expect(
      stageCount(pressure(fine.snapshot, 'cache-1'), 'backendQueue'),
    ).toBeGreaterThan(0);
    expect(
      stageCount(pressure(fine.snapshot, 'db-1'), 'dbExecuting'),
    ).toBeGreaterThan(0);
    for (const metric of fine.snapshot.nodes) {
      if (metric.pressure) {
        expect(metric.pressure.observedMs).toBe(level.durationMs);
      }
    }
  });
});
