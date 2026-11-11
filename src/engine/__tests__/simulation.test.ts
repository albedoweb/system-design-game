import { describe, expect, it } from 'vitest';

import { DEFAULT_LEVEL } from '../../domain/level';
import { createInitialGraph } from '../../domain/graph';
import { DomainValidationError } from '../../domain/errors';
import { getCapacity } from '../../domain/catalog';
import {
  SimulationInputError,
  createSimulation,
  createSimulationFromTrace,
  generateOfferedTrace,
  nearestRank,
} from '../index';
import type { RunResult, SimulationSnapshot } from '../../domain/simulation';
import type { OfferedTrace } from '../workload';
import fixedTrace211 from './fixtures/trace-211.json';
import { makeTrace, offered, runTrace, testGraph, testLevel } from './helpers';

function node(snapshot: SimulationSnapshot, nodeId: string) {
  const metric = snapshot.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!metric) {
    throw new Error(`node ${nodeId} missing`);
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

describe('analytical latency', () => {
  // client 5 in + client→app 1 + app 2 + app→cache 1 + lookup 1
  // + cache→app 1 + app→client 1 + client 5 out = 17 ms.
  it('reads a warm cache in exactly 17 ms including the client edge', () => {
    const engine = runTrace(
      testGraph(),
      testLevel({ durationMs: 2000, warmupMs: 1000 }),
      [offered('read', 0, -500, 0, false), offered('read', 1, 0, 0)],
    );
    const result = engine.result();
    expect(result.snapshot.reads.succeeded).toBe(1);
    expect(result.snapshot.reads.p95Ms).toBe(17);
    expect(node(result.snapshot, 'cache-1').hits).toBe(1);
    expect(node(result.snapshot, 'cache-1').misses).toBe(0);
  });

  it('takes 35 ms for a cache miss and 32 ms for a direct database read', () => {
    const miss = runTrace(testGraph(), testLevel(), [offered('read', 0, 0, 0)]);
    expect(miss.result().snapshot.reads.p95Ms).toBe(35);

    const direct = runTrace(
      testGraph({ cache: null }),
      testLevel(),
      [offered('read', 0, 0, 0)],
    );
    expect(direct.result().snapshot.reads.p95Ms).toBe(32);
  });

  it('charges client→LB and LB→app edges in both directions', () => {
    // Direct DB path is 32 ms; via LB it additionally crosses client→LB and
    // app→LB (2 half-RTT edges) plus the 1 ms LB service time.
    const viaLb = runTrace(
      testGraph({ cache: null, apps: 2, clientToLoadBalancer: true }),
      testLevel(),
      [offered('read', 0, 0, 0)],
    );
    expect(viaLb.result().snapshot.reads.p95Ms).toBe(35);

    const warmCacheViaLb = runTrace(
      testGraph({ apps: 2, clientToLoadBalancer: true }),
      testLevel({ durationMs: 2000, warmupMs: 1000 }),
      [offered('read', 0, -500, 0, false), offered('read', 1, 0, 0)],
    );
    expect(warmCacheViaLb.result().snapshot.reads.p95Ms).toBe(20);
  });

  it('commits a write in 48 ms and counts it once', () => {
    const engine = runTrace(testGraph(), testLevel(), [
      offered('write', 0, 0, 0),
    ]);
    const result = engine.result();
    expect(result.snapshot.writes.succeeded).toBe(1);
    expect(result.snapshot.writes.p95Ms).toBe(48);
    expect(node(result.snapshot, 'db-1').completed).toBe(1);
  });
});

describe('admission and finite resources', () => {
  it('overflows a zero-length FIFO app queue instead of waiting', () => {
    const requests = Array.from({ length: 17 }, (_, index) =>
      offered('read', index, 0, index),
    );
    const engine = runTrace(
      testGraph({ app: { queueLimit: 0 } }),
      testLevel(),
      requests,
    );
    const result = engine.result();
    expect(result.snapshot.reads.failed).toBe(1);
    expect(result.snapshot.reads.succeeded).toBe(16);
    expect(result.snapshot.reads.errors.queue_overflow).toBe(1);
    expect(node(result.snapshot, 'app-1').errors).toBe(1);
  });

  it('holds database slots and reports the queued overflow separately', () => {
    const level = testLevel({ durationMs: 2000 });
    const engine = createSimulationFromTrace(
      testGraph({ cache: null }),
      level,
      makeTrace(
        Array.from({ length: 5 }, (_, index) =>
          offered('read', index, 0, index),
        ),
      ),
    );
    // Client RTT + client edge + app CPU complete at 8 ms; dependency calls
    // reach the database one edge later, at 9 ms.
    const snapshot = engine.advance(10);
    expect(node(snapshot, 'db-1').busy).toBe(4);
    expect(node(snapshot, 'db-1').queued).toBe(1);
    expect(node(snapshot, 'app-1').busy).toBe(5);
    engine.advance(level.durationMs + level.drainMs);
    const final = engine.result();
    expect(final.snapshot.reads.succeeded).toBe(5);
    expect(node(final.snapshot, 'db-1').busy).toBe(0);
  });

  it('holds app slots while requests wait for the shared downstream pool', () => {
    const level = testLevel({ durationMs: 2000 });
    const engine = createSimulationFromTrace(
      testGraph({ cache: null, app: { poolSize: 1 } }),
      level,
      makeTrace(
        Array.from({ length: 3 }, (_, index) =>
          offered('read', index, 0, index),
        ),
      ),
    );
    const snapshot = engine.advance(10);
    const app = node(snapshot, 'app-1');
    expect(app.busy).toBe(3);
    expect(app.poolBusy).toBe(1);
    expect(app.poolQueued).toBe(2);
    expect(node(snapshot, 'db-1').busy).toBe(1);
  });

  it('round-robins connected apps through the load balancer', () => {
    const engine = runTrace(
      testGraph({ cache: null, apps: 2, clientToLoadBalancer: true }),
      testLevel({ durationMs: 2000 }),
      Array.from({ length: 4 }, (_, index) =>
        offered('read', index, 0, index),
      ),
    );
    const result = engine.result();
    expect(result.snapshot.reads.succeeded).toBe(4);
    expect(node(result.snapshot, 'app-1').completed).toBe(2);
    expect(node(result.snapshot, 'app-2').completed).toBe(2);
  });
});

describe('cache behaviour', () => {
  it('coalesces concurrent misses onto one backend fill', () => {
    const coalesced = runTrace(
      testGraph({ cache: { coalescing: true, poolSize: 1 } }),
      testLevel({ durationMs: 2000 }),
      [offered('read', 0, 0, 0), offered('read', 1, 0, 0)],
    ).result();
    expect(coalesced.snapshot.reads.succeeded).toBe(2);
    expect(node(coalesced.snapshot, 'cache-1').coalesced).toBe(1);
    expect(node(coalesced.snapshot, 'db-1').completed).toBe(1);

    const separate = runTrace(
      testGraph({ cache: { coalescing: false, poolSize: 1 } }),
      testLevel({ durationMs: 2000 }),
      [offered('read', 0, 0, 0), offered('read', 1, 0, 0)],
    ).result();
    expect(node(separate.snapshot, 'cache-1').coalesced).toBe(0);
    expect(node(separate.snapshot, 'db-1').completed).toBe(2);
  });

  it('flush drops stored entries but lets an in-flight fill finish', () => {
    const engine = runTrace(
      testGraph(),
      testLevel({ durationMs: 2000, warmupMs: 1000, flushAtMs: 500 }),
      [
        offered('read', 0, -1000, 0, false),
        offered('read', 1, 0, 0),
        offered('read', 2, 490, 1),
        offered('read', 3, 520, 0),
        offered('read', 4, 550, 1),
      ],
    );
    const result = engine.result();
    const cache = node(result.snapshot, 'cache-1');
    expect(cache.hits).toBe(2);
    expect(cache.misses).toBe(2);
    expect(result.snapshot.events.some((event) => event.message.includes('flush'))).toBe(
      true,
    );
  });

  it('blocks a fill that started before write invalidation', () => {
    const engine = runTrace(
      testGraph(),
      testLevel({ durationMs: 1000 }),
      [
        offered('write', 0, 0, 0),
        offered('read', 0, 18, 0),
        offered('read', 1, 100, 0),
      ],
    );
    const result = engine.result();
    const cache = node(result.snapshot, 'cache-1');
    expect(cache.hits).toBe(0);
    expect(cache.misses).toBe(2);
    expect(result.snapshot.reads.succeeded).toBe(2);
  });
});

describe('deadlines and scoring', () => {
  it('keeps app and pool slots for started database work, releases queued waiters', () => {
    const level = testLevel({
      durationMs: 1000,
      deadlineMs: 100,
      drainMs: 300,
      timing: { dbReadMs: 200 },
    });
    const single = createSimulationFromTrace(
      testGraph({ cache: null }),
      level,
      makeTrace([offered('read', 0, 0, 0)]),
    );
    const atDeadline = single.advance(100);
    expect(node(atDeadline, 'app-1').busy).toBe(1);
    expect(node(atDeadline, 'db-1').busy).toBe(1);
    expect(atDeadline.reads.failed).toBe(1);
    single.advance(1000 + 300);
    const released = single.result().snapshot;
    expect(node(released, 'app-1').busy).toBe(0);
    expect(node(released, 'db-1').busy).toBe(0);

    const queued = createSimulationFromTrace(
      testGraph({ cache: null }),
      level,
      makeTrace(
        Array.from({ length: 5 }, (_, index) =>
          offered('read', index, 0, index),
        ),
      ),
    );
    const snapshot = queued.advance(100);
    expect(node(snapshot, 'db-1').busy).toBe(4);
    expect(node(snapshot, 'db-1').queued).toBe(0);
    expect(node(snapshot, 'app-1').busy).toBe(4);
    expect(snapshot.reads.failed).toBe(5);
  });

  it('times out without resurrection and releases capacity at the real callback', () => {
    const engine = runTrace(
      testGraph({ cache: null }),
      testLevel({
        durationMs: 1000,
        deadlineMs: 100,
        drainMs: 300,
        timing: { dbReadMs: 200 },
      }),
      [offered('read', 0, 0, 0)],
    );
    const result = engine.result();
    expect(result.snapshot.reads.failed).toBe(1);
    expect(result.snapshot.reads.succeeded).toBe(0);
    expect(result.snapshot.reads.errors.timeout).toBe(1);
    expect(result.snapshot.reads.pending).toBe(0);
    expect(node(result.snapshot, 'db-1').busy).toBe(0);
    expect(node(result.snapshot, 'app-1').busy).toBe(0);
  });

  it('excludes warmup arrivals from offered and success metrics', () => {
    const level = testLevel({
      warmupMs: 1000,
      durationMs: 2000,
      readSchedule: [{ atMs: 0, rps: 200 }],
    });
    const trace = generateOfferedTrace(level, 101);
    const scored = trace.requests.filter((request) => request.scored).length;
    expect(trace.requests.length).toBeGreaterThan(scored);
    expect(scored).toBeGreaterThan(0);

    const engine = createSimulation(testGraph(), level, 101);
    engine.advance(level.durationMs + level.drainMs);
    const result = engine.result();
    expect(result.snapshot.reads.offered).toBe(scored);
  });

  it('resets scored node counters after warmup and reports the first evaluation overflow', () => {
    const level = testLevel({
      warmupMs: 1000,
      durationMs: 2000,
      readSchedule: [{ atMs: 0, rps: 5 }],
    });
    // The database has 4 slots and a zero-length FIFO queue: the fifth
    // concurrent operation overflows before evaluation and again during it.
    const result = runTrace(
      testGraph({ cache: null, database: { queueLimit: 0 } }),
      level,
      [
        ...Array.from({ length: 5 }, (_, index) =>
          offered('read', index, -1000, index, false),
        ),
        ...Array.from({ length: 5 }, (_, index) =>
          offered('read', index + 5, 0, index),
        ),
      ],
    ).result();

    const database = node(result.snapshot, 'db-1');
    expect(database.errors).toBe(1);
    expect(database.completed).toBe(4);
    expect(result.snapshot.reads.failed).toBe(1);
    expect(result.snapshot.reads.errors.queue_overflow).toBe(1);
    const overflowEvents = result.snapshot.events.filter((event) =>
      event.message.includes('overflow'),
    );
    expect(overflowEvents).toHaveLength(1);
    expect(overflowEvents[0]?.nodeId).toBe('db-1');
  });

  it('uses exact nearest-rank percentiles and fails unknown latency', () => {
    expect(nearestRank([], 95)).toBeNull();
    expect(nearestRank([10, 20, 30, 40], 50)).toBe(20);
    expect(nearestRank([10, 20, 30, 40], 95)).toBe(40);

    const engine = runTrace(
      testGraph(),
      testLevel(),
      [offered('read', 0, 0, 0)],
    );
    const result = engine.result();
    const writeP95 = check(result, 'write-p95');
    expect(writeP95.actual).toBeNull();
    expect(writeP95.passed).toBe(false);
  });

  it('reports read and write availability separately', () => {
    const result = runTrace(
      testGraph({ app: { queueLimit: 0 } }),
      testLevel({ durationMs: 2000 }),
      [
        ...Array.from({ length: 17 }, (_, index) =>
          offered('read', index, 0, index),
        ),
        offered('write', 0, 100, 2),
      ],
    ).result();
    expect(check(result, 'read-availability').passed).toBe(false);
    expect(check(result, 'write-availability').passed).toBe(true);
    expect(result.passed).toBe(false);
  });
});

describe('input validation and reproducibility', () => {
  it('rejects result before done, decreasing time and an out-of-horizon advance', () => {
    const level = testLevel();
    const engine = createSimulationFromTrace(
      testGraph(),
      level,
      makeTrace([offered('read', 0, 0, 0)]),
    );
    expect(engine.done).toBe(false);
    expect(() => engine.result()).toThrow(SimulationInputError);
    engine.advance(100);
    expect(() => engine.advance(99)).toThrow(SimulationInputError);
    expect(() =>
      engine.advance(level.durationMs + level.drainMs + 1),
    ).toThrow(SimulationInputError);
    engine.advance(level.durationMs + level.drainMs);
    expect(engine.done).toBe(true);
    expect(engine.result().snapshot.reads.pending).toBe(0);

    expect(() => createSimulation(testGraph(), level, 1.5)).toThrow(
      SimulationInputError,
    );
  });

  it('never reports negative or over-capacity resources', () => {
    const graph = createInitialGraph();
    const capacities = new Map(
      graph.nodes.map((graphNode) => [
        graphNode.id,
        getCapacity(graphNode.kind, graphNode.config.size) ?? Number.POSITIVE_INFINITY,
      ]),
    );
    const engine = createSimulation(graph, DEFAULT_LEVEL, 211);
    const end = DEFAULT_LEVEL.durationMs + DEFAULT_LEVEL.drainMs;
    let last = engine.advance(0);
    for (let time = 100; time <= end; time += 100) {
      last = engine.advance(Math.min(end, time));
      expect(last.series.length).toBeLessThanOrEqual(180);
      for (const metric of last.nodes) {
        expect(metric.busy).toBeGreaterThanOrEqual(0);
        expect(metric.queued).toBeGreaterThanOrEqual(0);
        expect(metric.poolBusy).toBeGreaterThanOrEqual(0);
        expect(metric.poolQueued).toBeGreaterThanOrEqual(0);
        expect(metric.busy).toBeLessThanOrEqual(
          capacities.get(metric.nodeId) ?? 0,
        );
      }
      expect(last.reads.pending).toBe(
        last.reads.offered - last.reads.succeeded - last.reads.failed,
      );
      expect(last.writes.pending).toBe(
        last.writes.offered - last.writes.succeeded - last.writes.failed,
      );
    }
    expect(last.reads.pending).toBe(0);
    expect(last.writes.pending).toBe(0);
    // This full-level invariant sweep takes >5 s on the shared Linux CI runner.
    // Keep every 100 ms sample and assertion; this is not a wall-clock benchmark.
  }, 15_000);

  it('rejects disconnected or malformed graphs before compiling', () => {
    const graph = testGraph();
    graph.edges = graph.edges.filter((edge) => edge.id !== 'e-client-app-1');
    expect(() => createSimulationFromTrace(graph, testLevel(), { seed: 101, requests: [] })).toThrow(
      DomainValidationError,
    );

    const malformed = testGraph();
    const app = malformed.nodes.find((candidate) => candidate.id === 'app-1');
    if (!app) {
      throw new Error('missing app');
    }
    app.config.poolSize = 0;
    expect(() =>
      createSimulationFromTrace(malformed, testLevel(), {
        seed: 101,
        requests: [],
      }),
    ).toThrow(DomainValidationError);
  });

  it('keeps offered arrivals, keys and ids identical across graphs and chunks', () => {
    const graphA = testGraph();
    const graphB = testGraph({ cache: null, apps: 4, clientToLoadBalancer: true });
    const level = testLevel({
      durationMs: 1000,
      readSchedule: [{ atMs: 0, rps: 20 }],
      writeSchedule: [{ atMs: 0, rps: 5 }],
    });
    const expected = fixedTrace211 as OfferedTrace;

    // Fixed fixture pins the RNG streams and key mapping for seed 211.
    expect(generateOfferedTrace(level, 211)).toEqual(expected);

    const engineA = createSimulation(graphA, level, 211);
    const engineB = createSimulation(graphB, level, 211);
    expect(engineA.offeredTrace()).toEqual(expected);
    expect(engineB.offeredTrace()).toEqual(expected);

    // Run both architectures to completion with different advance chunk
    // sizes; the offered trace must not change while the run proceeds.
    const end = level.durationMs + level.drainMs;
    for (let time = 0; time < end; ) {
      time = Math.min(end, time + 7);
      engineA.advance(time);
    }
    engineB.advance(end);
    expect(engineA.done).toBe(true);
    expect(engineB.done).toBe(true);
    expect(engineA.offeredTrace()).toEqual(expected);
    expect(engineB.offeredTrace()).toEqual(expected);
  });

  it('is chunk-independent at 10 ms, 100 ms and 1000 ms', () => {
    const requests = Array.from({ length: 20 }, (_, index) =>
      index % 5 === 0
        ? offered('write', index, index * 45, index % 3)
        : offered('read', index, index * 45, index % 3),
    );
    const run = (chunkMs: number) =>
      runTrace(testGraph(), testLevel({ durationMs: 1000 }), requests, 307, chunkMs)
        .result();
    const fine = run(10);
    expect(run(100)).toEqual(fine);
    expect(run(1000)).toEqual(fine);
  });

  it('produces identical results for 100 ms, 1000 ms and one-shot advances', () => {
    const graph = createInitialGraph();
    const run = (chunkMs: number) => {
      const engine = createSimulation(graph, DEFAULT_LEVEL, 101);
      const end = DEFAULT_LEVEL.durationMs + DEFAULT_LEVEL.drainMs;
      if (chunkMs === 0) {
        engine.advance(end);
      } else {
        let time = 0;
        while (time < end) {
          time = Math.min(end, time + chunkMs);
          engine.advance(time);
        }
      }
      return engine.result();
    };
    const fine = run(100);
    const coarse = run(1000);
    const single = run(0);
    expect(coarse).toEqual(fine);
    expect(single).toEqual(fine);
  }, 30_000); // Full-level semantics, not a wall-clock performance assertion.

  it('keeps dbQueue peaks independent of chunks when depth spans a bin boundary', () => {
    // Four DB slots run while the fifth request waits in the queue. The
    // queue depth of 1 lasts from ~9 ms to 1509 ms, so [1000,1500) must
    // report peak 1 in both fine and one-shot advances.
    const level = testLevel({
      durationMs: 3000,
      drainMs: 2600,
      deadlineMs: 2500,
      timing: { dbReadMs: 1500 },
      readSchedule: [{ atMs: 0, rps: 5 }],
    });
    const requests = Array.from({ length: 5 }, (_, index) =>
      offered('read', index, 0, index),
    );
    const run = (chunkMs: number) =>
      runTrace(testGraph({ cache: null }), level, requests, 101, chunkMs)
        .result();
    const fine = run(10);
    expect(fine.snapshot.series.map((point) => point.dbQueue).slice(0, 3)).toEqual([
      1, 1, 0,
    ]);
    expect(run(100)).toEqual(fine);
    expect(run(1000)).toEqual(fine);
    expect(run(0)).toEqual(fine);
  });

  it('is chunk-independent for seven seeds at 100/1000 ms and one-shot', () => {
    const seeds = [
      ...DEFAULT_LEVEL.refs.calibrationSeeds,
      ...DEFAULT_LEVEL.refs.holdoutSeeds,
    ];
    expect(seeds).toEqual([101, 211, 307, 401, 503, 607, 701]);

    const end = DEFAULT_LEVEL.durationMs + DEFAULT_LEVEL.drainMs;
    const run = (seed: number, chunkMs: number) => {
      const engine = createSimulation(createInitialGraph(), DEFAULT_LEVEL, seed);
      if (chunkMs === 0) {
        engine.advance(end);
      } else {
        let time = -DEFAULT_LEVEL.warmupMs;
        while (time < end) {
          time = Math.min(end, time + chunkMs);
          engine.advance(time);
        }
      }
      return engine.result();
    };

    // The short boundary test above covers 10 ms. Full-level runs use the
    // production Worker quantum and coarser steps to keep this sweep bounded.
    for (const seed of seeds) {
      const fine = run(seed, 100);
      expect(run(seed, 1000)).toEqual(fine);
      expect(run(seed, 0)).toEqual(fine);
    }
  }, 120_000);

  it('fails a no-cache baseline at peak load', () => {
    const engine = createSimulation(
      testGraph({ cache: null }),
      DEFAULT_LEVEL,
      101,
    );
    engine.advance(DEFAULT_LEVEL.durationMs + DEFAULT_LEVEL.drainMs);
    const result = engine.result();
    expect(result.passed).toBe(false);
    expect(result.snapshot.writes.offered).toBeGreaterThan(0);
  });
});
