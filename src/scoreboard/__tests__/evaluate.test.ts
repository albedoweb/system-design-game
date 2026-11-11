import { describe, expect, it } from 'vitest';
import {
  SCOREBOARD_LEVEL,
  ScoreboardSimulation,
  createScoreboardSession,
  evaluateScoreboard,
  parseScoreboardEvaluation,
  type ScoreboardGraph,
  type ScoreboardLevel,
} from '../index';

function users(): ScoreboardGraph['nodes'][number] {
  return {
    id: 'users',
    kind: 'users',
    label: 'Users',
    position: { x: 0, y: 0 },
    config: {},
  };
}

function app(instances = 1): ScoreboardGraph['nodes'][number] {
  return {
    id: 'app',
    kind: 'app',
    label: 'Application',
    position: { x: 1, y: 0 },
    config: { instances },
  };
}

function sql(
  size: 'small' | 'medium' | 'large',
  readPlan: 'scan' | 'aggregate',
): ScoreboardGraph['nodes'][number] {
  return {
    id: 'sql',
    kind: 'sql',
    label: 'SQL Database',
    position: { x: 2, y: 0 },
    config: { size, readPlan },
  };
}

function graph(
  sqlSize: 'small' | 'medium' | 'large',
  readPlan: 'scan' | 'aggregate',
  options: { cacheTtl?: 0.5 | 2 | 5 | 15; appInstances?: number } = {},
): ScoreboardGraph {
  const nodes: ScoreboardGraph['nodes'] = [
    users(),
    app(options.appInstances ?? 1),
    sql(sqlSize, readPlan),
  ];
  const edges: ScoreboardGraph['edges'] = [
    { id: 'e-users-app', from: 'users', to: 'app' },
    { id: 'e-app-sql', from: 'app', to: 'sql' },
  ];
  if (options.cacheTtl !== undefined) {
    nodes.push({
      id: 'cache',
      kind: 'cache',
      label: 'Cache',
      position: { x: 1, y: 1 },
      config: { ttlSeconds: options.cacheTtl },
    });
    edges.push(
      { id: 'e-app-cache', from: 'app', to: 'cache' },
      { id: 'e-cache-sql', from: 'cache', to: 'sql' },
    );
  }
  return {
    schemaVersion: 1,
    levelId: 'live-scoreboard',
    nodes,
    edges,
  };
}

describe('Live Scoreboard evaluator', () => {
  it('runs the three intended families at seed 101 and ranks cost', () => {
    const fullScan = evaluateScoreboard(graph('large', 'scan'), { seed: 101 });
    const cache = evaluateScoreboard(
      graph('small', 'scan', { cacheTtl: 2 }),
      { seed: 101 },
    );
    const aggregate = evaluateScoreboard(graph('small', 'aggregate'), {
      seed: 101,
    });

    for (const result of [fullScan, cache, aggregate]) {
      expect(result.status).toBe('complete');
      expect(result.passed).toBe(true);
      expect(result.gates.filter((gate) => !gate.passed)).toEqual([]);
      expect(result.correctness?.valid).toBe(true);
      expect(result.freshness?.valid).toBe(true);
      expect(result.cost).not.toBeNull();
      expect(result.series.length).toBe(90);
      expect(result.trafficFrames.length).toBe(90);
      expect(parseScoreboardEvaluation(result).ok).toBe(true);
    }

    const fullCost = fullScan.cost?.actualUsd ?? 0;
    const cacheCost = cache.cost?.actualUsd ?? 0;
    const aggregateCost = aggregate.cost?.actualUsd ?? 0;
    expect(aggregateCost).toBeLessThan(cacheCost);
    expect(cacheCost).toBeLessThan(fullCost);

    // The cache is allowed to trail by under five seconds; a TTL-2 snapshot
    // must show real data lag, not a zero pretend value.
    expect(cache.freshness?.staleReads).toBe(0);
    expect(cache.freshness?.maxLagMs ?? 0).toBeGreaterThan(0);
    expect(cache.freshness?.maxLagMs ?? 0).toBeLessThan(5_000);
    expect(aggregate.freshness?.staleReads).toBe(0);
    expect(fullScan.freshness?.staleReads).toBe(0);

    // The same exogenous trace is offered to every strategy at one seed.
    expect(
      new Set([
        fullScan.operations?.read.offered,
        cache.operations?.read.offered,
        aggregate.operations?.read.offered,
      ]).size,
    ).toBe(1);
    expect(
      new Set([
        fullScan.operations?.write.offered,
        cache.operations?.write.offered,
        aggregate.operations?.write.offered,
      ]).size,
    ).toBe(1);

    // Conservation: every offered request is success, failure or pending.
    for (const result of [fullScan, cache, aggregate]) {
      for (const operation of ['read', 'write'] as const) {
        const metrics = result.operations?.[operation];
        expect(metrics).toBeDefined();
        if (metrics === undefined) {
          continue;
        }
        expect(
          metrics.offered,
        ).toBe(metrics.succeeded + metrics.failed + metrics.pending);
      }
    }

    // Hand-computed SQL work: one 100 ms single-core scan per successful read
    // plus 0.2 ms CPU per write. Disk persistence is a separate stage.
    const sqlNode = fullScan.nodes.find((node) => node.kind === 'sql');
    const reads = fullScan.operations?.read.succeeded ?? 0;
    const writes = fullScan.operations?.write.succeeded ?? 0;
    const expectedCoreMs = reads * 100 + writes * 0.2;
    expect(sqlNode?.cpu.busyCoreMs ?? 0).toBeGreaterThan(expectedCoreMs * 0.99);
    expect(sqlNode?.cpu.busyCoreMs ?? 0).toBeLessThan(expectedCoreMs * 1.01);
    expect(sqlNode?.cpu.busyCoresPeak).toBe(32);

    // TTL-2 fills are rare compared with reads: coalescing and TTL are real.
    const fill = cache.links.find((link) => link.role === 'fill');
    expect(fill?.requests.fill ?? 0).toBeGreaterThan(0);
    expect(fill?.requests.fill ?? 0).toBeLessThan(200);
    expect(cache.correctness?.writesCommitted).toBe(
      cache.correctness?.writesAcknowledged,
    );
  });

  it('fails freshness for TTL 15 under continual writes', () => {
    const result = evaluateScoreboard(
      graph('small', 'scan', { cacheTtl: 15 }),
      { seed: 101 },
    );
    expect(result.status).toBe('complete');
    expect(result.passed).toBe(false);
    expect(result.freshness?.staleReads ?? 0).toBeGreaterThan(0);
    expect(result.freshness?.maxLagMs ?? 0).toBeGreaterThan(5_000);
    expect(
      result.gates.find((gate) => gate.id === 'freshness')?.passed,
    ).toBe(false);
  });

  it('fails a small raw-scan database visibly, and app scaling does not fix it', () => {
    const result = evaluateScoreboard(
      graph('small', 'scan', { appInstances: 4 }),
      { seed: 101 },
    );
    expect(result.status).toBe('complete');
    expect(result.passed).toBe(false);
    expect(result.operations?.read.availability ?? 1).toBeLessThan(0.995);
    expect(result.operations?.read.rejected ?? 0).toBeGreaterThan(0);
    expect(result.operations?.read.timedOut ?? 0).toBeGreaterThan(0);
    const failed = result.gates
      .filter((gate) => !gate.passed)
      .map((gate) => gate.id);
    expect(failed).toContain('read-availability-whole');
    expect(failed).toContain('read-availability-peak');
    expect(failed).toContain('read-p95-peak');

    const sqlNode = result.nodes.find((node) => node.kind === 'sql');
    expect(sqlNode?.queue.waitingPeak ?? 0).toBeGreaterThan(0);
    expect(sqlNode?.queue.waitSamples ?? 0).toBeGreaterThan(0);
    expect(sqlNode?.queue.activePeak ?? 0).toBeGreaterThan(0);
    // Waiting and active work are reported separately, not conflated.
    expect(sqlNode?.queue.waitingPeak ?? 0).toBeGreaterThanOrEqual(
      sqlNode?.queue.activePeak ?? 0,
    );
  });

  it('rejects invalid graphs without fabricating a run', () => {
    const missing = evaluateScoreboard(
      {
        schemaVersion: 1,
        levelId: 'live-scoreboard',
        nodes: [users()],
        edges: [],
      },
      { seed: 101 },
    );
    expect(missing.status).toBe('invalid');
    expect(missing.passed).toBe(false);
    expect(missing.operations).toBeNull();
    expect(missing.cost).toBeNull();
    expect(missing.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['missing-app', 'missing-sql']),
    );

    const cyclicish = evaluateScoreboard(
      {
        schemaVersion: 1,
        levelId: 'live-scoreboard',
        nodes: [users(), app(), sql('small', 'scan')],
        edges: [
          { id: 'e1', from: 'users', to: 'app' },
          { id: 'e2', from: 'users', to: 'app' },
          { id: 'e3', from: 'app', to: 'sql' },
        ],
      },
      { seed: 101 },
    );
    expect(cyclicish.status).toBe('invalid');
    expect(cyclicish.issues.some((issue) => issue.code === 'ambiguous_link')).toBe(
      true,
    );
  });

  it('provides the same deterministic result from the incremental session', () => {
    const input = graph('small', 'aggregate');
    const synchronous = evaluateScoreboard(input, { seed: 211 });
    const incremental = createScoreboardSession(input, { seed: 211 })
      .runToCompletion(2_000);
    expect(incremental).toEqual(synchronous);
  });

  it('cancels cooperatively and returns actual partial telemetry, never a pass', () => {
    const session = createScoreboardSession(graph('small', 'aggregate'), {
      seed: 101,
    });
    const first = session.advance(2_000);
    expect(first.done).toBe(false);
    expect(first.progress.measuredElapsedMs).toBeGreaterThan(0);
    session.cancel();
    const result = session.result();
    expect(result?.status).toBe('incomplete');
    expect(result?.passed).toBe(false);
    expect(result?.series.length ?? 0).toBeGreaterThan(0);
    expect(result?.trafficFrames.length ?? 0).toBeGreaterThan(0);
    expect(
      result?.gates.find((gate) => gate.id === 'completion')?.passed,
    ).toBe(false);
    expect(parseScoreboardEvaluation(result).ok).toBe(true);
  });

  it('excludes prepare CPU from the measured summary but charges its rent', () => {
    const zeroTraffic: ScoreboardLevel = JSON.parse(
      JSON.stringify(SCOREBOARD_LEVEL),
    ) as ScoreboardLevel;
    zeroTraffic.workload.readPhases = [
      { fromMs: 0, toMs: 90_000, readsPerSecond: 0 },
    ];
    zeroTraffic.workload.voteChangesPerSecond = 0;

    const simulation = new ScoreboardSimulation(
      graph('small', 'aggregate'),
      { seed: 101 },
      zeroTraffic,
    );
    const result = simulation.runToCompletion();
    expect(result.status).toBe('complete');
    expect(result.preparation?.workCoreMs).toBe(102);
    expect(result.preparation?.durationMs).toBe(102);
    expect(result.window?.measuredStartMs).toBe(102);
    expect(result.operations?.read.offered).toBe(0);
    expect(result.operations?.write.offered).toBe(0);

    const sqlNode = result.nodes.find((node) => node.kind === 'sql');
    expect(sqlNode?.cpu.busyCoreMs).toBe(0);
    expect(sqlNode?.cpu.busyCoresPeak).toBe(0);
    expect(sqlNode?.tasks.submitted).toBe(0);
    expect(result.series[0]?.nodes.find((node) => node.nodeId === 'sql')?.cpuUtilization).toBe(0);

    // Preparation is not measured load, but its elapsed rent is billed.
    expect(result.cost?.preparationMs).toBe(102);
    expect(result.cost?.measuredMs).toBe(90_000);
    expect(result.cost?.drainMs).toBe(0);
    expect(result.cost?.billedMs).toBe(90_102);
    expect(
      Math.abs(
        (result.cost?.billedMs ?? 0) -
          ((result.cost?.preparationMs ?? 0) +
            (result.cost?.measuredMs ?? 0) +
            (result.cost?.drainMs ?? 0)),
      ),
    ).toBeLessThan(1e-6);
  });

  it('keeps cost duration consistent with prep, measurement and drain', () => {
    const result = evaluateScoreboard(graph('small', 'aggregate'), {
      seed: 101,
    });
    expect(result.cost).not.toBeNull();
    expect(result.window).not.toBeNull();
    if (result.cost === null || result.window === null) {
      return;
    }
    expect(result.cost.billedMs).toBeCloseTo(
      result.cost.preparationMs + result.cost.measuredMs + result.cost.drainMs,
      6,
    );
    expect(result.window.drainMs).toBeGreaterThanOrEqual(0);
  });
});
