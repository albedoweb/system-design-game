import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUDIENCE_CATALOG } from '../catalog';
import { AUDIENCE_LEVEL } from '../level';
import {
  AUDIENCE_PROFILE_VERSION,
  AUDIENCE_SCHEMA_VERSION,
  AUDIENCE_LEVEL_ID,
  createAudienceChallengeProfile,
  parseAudienceEvaluation,
  type AudienceCaseResult,
  type AudienceGraph,
} from '../contracts';
import {
  ActivityOverlay,
  LastSeenIndex,
  recomputeWindowRanking,
  type AudienceCommitLog,
  type AudienceRanking,
} from '../core/activity';
import {
  AudiencePrehistoryBuilder,
  Int32KeyTable,
  buildAudienceIngestTrace,
  buildAudienceReadTrace,
  type AudienceIngestTrace,
  type AudienceReadTrace,
} from '../core/workload';
import type { AudienceModel } from '../core/model';
import { AudienceSimulation } from '../session';
import { AudienceCaseSimulation } from '../core/case';
import { resolveAudienceTopology } from '../core/topology';

/**
 * Hand-computable tests for the exact rolling-distinct reference, the seeded
 * prehistory barrier and the case engine on an explicitly tiny private model.
 * The public entry points always use the frozen level and catalog; these tests
 * construct the engine directly so the numbers stay inspectable.
 */

const STREAMS = 4;
const WINDOW = 2_000;

interface BaseOptions {
  counts: number[];
  pairs: { key: number; lastMs: number }[];
  streamOf: (key: number) => number;
}

/**
 * Builds an exact prehistory snapshot by hand. Expiry instants are
 * `lastMs + WINDOW`, so every expectation below is arithmetic, not a replay.
 */
function manualBase(options: BaseOptions): {
  base: Parameters<typeof recomputeWindowRanking>[0];
  log: AudienceCommitLog;
} {
  const table = new Int32KeyTable(Math.max(16, options.pairs.length * 4));
  for (const pair of options.pairs) {
    table.add(pair.key);
  }
  const sorted = [...options.pairs].sort((a, b) => a.lastMs - b.lastMs);
  const eventTimes: number[] = [];
  for (const pair of sorted) {
    eventTimes.push(pair.lastMs);
  }
  const horizon = 2_600;
  const expiry: { end: number; key: number; stream: number }[] = [];
  for (const pair of sorted) {
    const end = pair.lastMs + WINDOW;
    if (end <= horizon) {
      expiry.push({ end, key: pair.key, stream: options.streamOf(pair.key) });
    }
  }
  expiry.sort((a, b) => a.end - b.end);
  const base = {
    counts: Int32Array.from(options.counts),
    totalPairs: options.pairs.length,
    pairs: table,
    pairKeys: Int32Array.from(sorted.map((pair) => pair.key)),
    pairLastMs: Float64Array.from(sorted.map((pair) => pair.lastMs)),
    expiryEndsMs: Float64Array.from(expiry.map((item) => item.end)),
    expiryKeys: Int32Array.from(expiry.map((item) => item.key)),
    expiryStreams: Uint8Array.from(expiry.map((item) => item.stream)),
    prehistoryEvents: options.pairs.length,
    prehistoryDistinctPairs: options.pairs.length,
    eventTimesMs: Float64Array.from(eventTimes),
    provisionDiskMs: 0,
    provisionBytes: 0,
  };
  const log: AudienceCommitLog = {
    count: 0,
    timesMs: new Float64Array(0),
    pairs: new Int32Array(0),
    streams: new Uint8Array(0),
  };
  return { base, log };
}

function emptyLog(capacity = 16): AudienceCommitLog {
  return {
    count: 0,
    timesMs: new Float64Array(capacity),
    pairs: new Int32Array(capacity),
    streams: new Uint8Array(capacity),
  };
}

function appendLog(
  log: AudienceCommitLog,
  timeMs: number,
  pairKey: number,
  stream: number,
): void {
  log.timesMs[log.count] = timeMs;
  log.pairs[log.count] = pairKey;
  log.streams[log.count] = stream;
  (log as { count: number }).count = log.count + 1;
}

/** Stream-ordered viewer counts read from the ranked top entries. */
function countsByStream(ranking: AudienceRanking, streams = STREAMS): number[] {
  const counts = new Array<number>(streams).fill(0);
  for (const entry of ranking.top) {
    counts[entry.stream] = entry.viewers;
  }
  return counts;
}

describe('exact rolling distinct reference', () => {
  it('expires the left edge, keeps renewed pairs and counts a user on several streams', () => {
    const { base } = (() => {
      // user*4 + stream keys.
      const pairs = [
        { key: 0, lastMs: -500 }, // user0/stream0 leaves the window at 1500
        { key: 1, lastMs: -100 }, // user0/stream1 leaves at 1900
        { key: 4, lastMs: -900 }, // user1/stream0 leaves at 1100
        { key: 8, lastMs: -700 }, // user2/stream0 leaves at 1300
      ];
      return manualBase({
        counts: [3, 1, 0, 0],
        pairs,
        streamOf: (key) => key % STREAMS,
      });
    })();
    const overlay = new ActivityOverlay(base, WINDOW, STREAMS);
    const audit = new LastSeenIndex(base, WINDOW, STREAMS);

    // Origin: stream0 has user0, user1 and user2; stream1 has user0.
    expect(countsByStream(overlay.ranking(0, 0, STREAMS))).toEqual([3, 1, 0, 0]);
    expect(audit.activePairs).toBe(4);

    // user1/stream0 leaves the window exactly at 1100: with the open left edge
    // its last activity is no longer strictly inside the window.
    expect(countsByStream(overlay.ranking(1_100, 0, STREAMS))).toEqual([2, 1, 0, 0]);
    // Renew user0/stream0 at 1_200, before its 1_500 boundary.
    overlay.applyCommit(0, 0, 1_200);
    audit.applyCommit(0, 1_200);
    // At 1_600 the original boundary passed but the renewal keeps user0/stream0
    // active; user1/stream0 (1_100) and user2/stream0 (1_300) are gone.
    expect(countsByStream(overlay.ranking(1_600, 1, STREAMS))).toEqual([1, 1, 0, 0]);
    expect(audit.ranking(1_600, 1, STREAMS).activePairs).toBe(2);
    // At 2_000 user0/stream1 (1_900) is gone while the renewed pair survives.
    expect(countsByStream(overlay.ranking(2_000, 1, STREAMS))).toEqual([1, 0, 0, 0]);
    expect(overlay.expiryMismatches).toBe(0);
  });

  it('counts a pair again when it renews after it already left the window', () => {
    const { base } = manualBase({
      counts: [1, 0, 0, 0],
      pairs: [{ key: 0, lastMs: -900 }], // leaves at 1_100
      streamOf: (key) => key % STREAMS,
    });
    const overlay = new ActivityOverlay(base, WINDOW, STREAMS);
    const audit = new LastSeenIndex(base, WINDOW, STREAMS);
    expect(countsByStream(overlay.ranking(1_200, 0, STREAMS))).toEqual([0, 0, 0, 0]);
    overlay.applyCommit(0, 0, 1_300);
    audit.applyCommit(0, 1_300);
    expect(countsByStream(overlay.ranking(1_300, 1, STREAMS))).toEqual([1, 0, 0, 0]);
    expect(audit.ranking(1_300, 1, STREAMS).top[0]).toEqual({
      stream: 0,
      viewers: 1,
    });
  });

  it('counts repeated commits of one pair once and matches the raw oracle', () => {
    const { base } = manualBase({
      counts: [1, 0, 0, 0],
      pairs: [{ key: 0, lastMs: -100 }],
      streamOf: (key) => key % STREAMS,
    });
    const overlay = new ActivityOverlay(base, WINDOW, STREAMS);
    const log = emptyLog();
    for (let index = 0; index < 5; index += 1) {
      overlay.applyCommit(0, 0, 50 + index);
      appendLog(log, 50 + index, 0, 0);
    }
    appendLog(log, 60, 1, 1);
    overlay.applyCommit(1, 1, 60);
    const ranking = overlay.ranking(100, log.count, STREAMS);
    expect(countsByStream(ranking)).toEqual([1, 1, 0, 0]);
    expect(ranking.activePairs).toBe(2);
    const raw = recomputeWindowRanking(base, log, ranking.snapshot, WINDOW, STREAMS, STREAMS);
    expect(raw.top).toEqual(ranking.top);
    expect(raw.activePairs).toBe(ranking.activePairs);
  });

  it('isolates rows above the commit cursor from the named snapshot', () => {
    const { base } = manualBase({
      counts: [0, 0, 0, 0],
      pairs: [],
      streamOf: (key) => key % STREAMS,
    });
    const log = emptyLog();
    appendLog(log, 10, 2, 2);
    appendLog(log, 20, 3, 3);
    const before = recomputeWindowRanking(
      base,
      log,
      { asOfMs: 20, throughCommitSequence: 1 },
      WINDOW,
      STREAMS,
      STREAMS,
    );
    expect(countsByStream(before)).toEqual([0, 0, 1, 0]);
    const after = recomputeWindowRanking(
      base,
      log,
      { asOfMs: 20, throughCommitSequence: 2 },
      WINDOW,
      STREAMS,
      STREAMS,
    );
    expect(countsByStream(after)).toEqual([0, 0, 1, 1]);
  });

  it('keeps fractional snapshot times exact', () => {
    const { base } = manualBase({
      counts: [0, 0, 0, 0],
      pairs: [],
      streamOf: (key) => key % STREAMS,
    });
    const log = emptyLog();
    appendLog(log, 100.25, 0, 0);
    const ranking = recomputeWindowRanking(
      base,
      log,
      { asOfMs: 100.25, throughCommitSequence: 1 },
      WINDOW,
      STREAMS,
      STREAMS,
    );
    expect(ranking.snapshot.asOfMs).toBe(100.25);
    const overlay = new ActivityOverlay(base, WINDOW, STREAMS);
    overlay.applyCommit(0, 0, 100.25);
    expect(overlay.ranking(100.25, 1, STREAMS).snapshot.asOfMs).toBe(100.25);
  });
});

// ---------------------------------------------------------------------------
// Tiny private model for engine behaviour
// ---------------------------------------------------------------------------

/**
 * Tiny private dataset with the *frozen* activity window and fault schedule, so
 * a complete fault case can satisfy the published result contract while the
 * numbers stay small: 400 prehistory rows, 30 ingest/s, 47 s measured window.
 */
const TINY_MEASURED_MS = 47_000;
const TINY_DRAIN_MS = 1_000;

function tinyModel(overrides: { ingestPerSecond?: number } = {}): AudienceModel {
  const level = JSON.parse(JSON.stringify(AUDIENCE_LEVEL));
  const catalog = JSON.parse(JSON.stringify(AUDIENCE_CATALOG));
  level.dataset.users = 40;
  level.dataset.streams = STREAMS;
  level.dataset.prehistoryEvents = 400;
  level.dataset.prehistoryRawBytes = 400 * 128;
  level.dataset.rankingBytes = 4_096;
  level.dataset.ingestAckBytes = 200;
  level.workload.measuredMs = TINY_MEASURED_MS;
  level.workload.drainMs = TINY_DRAIN_MS;
  level.workload.ingestEventsPerSecond = overrides.ingestPerSecond ?? 30;
  level.workload.readPhases = [{ fromMs: 0, toMs: TINY_MEASURED_MS, readsPerSecond: 20 }];
  level.workload.peakWindow = { fromMs: 20_000, toMs: 40_000 };
  level.workload.faultWindow = { fromMs: 30_000, toMs: 40_000 };
  level.workload.topN = 4;
  level.limits.maxEvents = 4_000_000;
  level.limits.maxPreparationMs = 120_000;
  level.calibrationSeeds = [1];
  level.holdoutSeeds = [2];
  catalog.components.app.cpuCoresPerInstance = 1;
  catalog.storage.queryWorkingPairBytes = 8;
  return { level, catalog } as AudienceModel;
}

/**
 * Tiny challenge profile: same shape as the frozen one, but with a 100 ms
 * crash instead of 30 s so a 400 ms measured window can observe the full
 * crash -> detection -> restart -> readiness chain.
 */
function tinyProfile(appInstances: number): ReturnType<
  typeof createAudienceChallengeProfile
> {
  const peakTraffic = {
    readPhases: [{ fromMs: 0, toMs: TINY_MEASURED_MS, readsPerSecond: 20 }],
    ingestEventsPerSecond: 30,
    trace: 'same-seed-input' as const,
  };
  const cases: ReturnType<typeof createAudienceChallengeProfile>['cases'][number][] = [
    {
      id: 'normal' as const,
      kind: 'normal' as const,
      label: 'Normal traffic',
      targetInstance: null,
      traffic: {
        readPhases: [{ fromMs: 0, toMs: TINY_MEASURED_MS, readsPerSecond: 5 }],
        ingestEventsPerSecond: 30,
        trace: 'same-seed-input' as const,
      },
      fault: null,
      criticalWindow: null,
    },
    {
      id: 'peak' as const,
      kind: 'peak' as const,
      label: 'Peak traffic',
      targetInstance: null,
      traffic: peakTraffic,
      fault: null,
      criticalWindow: { fromMs: 20_000, toMs: 40_000 },
    },
  ];
  for (let slot = 0; slot < appInstances; slot += 1) {
    cases.push({
      id: `app-failure-${slot}` as 'app-failure-0',
      kind: 'app-instance-failure' as const,
      label: `Peak + Application instance ${slot} failure`,
      targetInstance: slot,
      traffic: {
        readPhases: [{ fromMs: 0, toMs: TINY_MEASURED_MS, readsPerSecond: 20 }],
        ingestEventsPerSecond: 30,
        trace: 'same-seed-input' as const,
      },
      // The published fault schedule: 30 s crash, 15 s down, 1 s boot.
      fault: {
        kind: 'app-instance-crash' as const,
        crashAtMs: 30_000,
        downMs: 15_000,
        bootMs: 1_000,
        restartCount: 1 as const,
      },
      criticalWindow: { fromMs: 30_000, toMs: 40_000 },
    });
  }
  return {
    profileVersion: AUDIENCE_PROFILE_VERSION,
    appInstances,
    cases,
    requiredCaseIds: [
      'normal',
      'peak',
      ...Array.from(
        { length: appInstances },
        (_, index) => `app-failure-${index}` as 'app-failure-0',
      ),
    ],
    scoreCaseId: 'peak',
    qualification: 'all-required-cases',
    prehistoryReset: 'identical-per-case',
    costPolicy: 'peak-actual-only',
  };
}

function node(
  kind: AudienceGraph['nodes'][number]['kind'],
  id: string,
  config: Record<string, unknown> = {},
): AudienceGraph['nodes'][number] {
  return {
    id,
    kind,
    label: id,
    position: { x: 0, y: 0 },
    config,
  } as AudienceGraph['nodes'][number];
}

function graph(spec: {
  apps: number;
  lb: boolean;
  readPlan: 'query' | 'projection';
  cache?: number | null;
  workers?: number;
}): AudienceGraph {
  const nodes: AudienceGraph['nodes'] = [node('users', 'users')];
  if (spec.lb) {
    nodes.push(node('lb', 'lb'));
  }
  nodes.push(node('app', 'app', { instances: spec.apps }));
  nodes.push(node('sql', 'sql', { size: 'small', readPlan: spec.readPlan }));
  if (spec.cache !== undefined && spec.cache !== null) {
    nodes.push(node('cache', 'cache', { ttlSeconds: spec.cache }));
  }
  if (spec.workers !== undefined) {
    nodes.push(node('worker', 'worker', { instances: spec.workers }));
  }
  const edges: AudienceGraph['edges'] = [];
  const add = (from: string, to: string): void => {
    edges.push({ id: `${from}-${to}`, from, to });
  };
  add('users', spec.lb ? 'lb' : 'app');
  if (spec.lb) {
    add('lb', 'app');
  }
  add('app', 'sql');
  if (spec.cache !== undefined && spec.cache !== null) {
    add('app', 'cache');
    add('cache', 'sql');
  }
  if (spec.workers !== undefined) {
    add('worker', 'sql');
  }
  return { schemaVersion: AUDIENCE_SCHEMA_VERSION, levelId: AUDIENCE_LEVEL_ID, nodes, edges };
}

function run(
  g: AudienceGraph,
  model: AudienceModel,
  seed = 11,
  slice?: number,
): ReturnType<AudienceSimulation['runToCompletion']> {
  const apps = g.nodes.find((item) => item.kind === 'app');
  const instances = apps !== undefined ? (apps.config as { instances: number }).instances : 1;
  const session = new AudienceSimulation(
    g,
    { seed },
    model,
    tinyProfile(instances),
  );
  return session.runToCompletion(slice);
}

function caseById(
  cases: readonly AudienceCaseResult[],
  id: string,
): AudienceCaseResult {
  const found = cases.find((item) => item.id === id);
  if (found === undefined) {
    throw new Error(`missing case ${id}`);
  }
  return found;
}

describe('seeded prehistory setup barrier', () => {
  it('produces the exact promised rows, retained pairs and sorted expiry instants', () => {
    const model = tinyModel();
    const builder = new AudiencePrehistoryBuilder(model, 5);
    let guard = 0;
    while (!builder.done && guard < 1_000) {
      builder.step(7);
      guard += 1;
    }
    expect(builder.done).toBe(true);
    const base = builder.baseHistory;
    expect(base.prehistoryEvents).toBe(400);
    expect(base.eventTimesMs.length).toBe(400);
    expect(base.pairs.count).toBe(base.totalPairs);
    expect(base.pairKeys.length).toBe(base.totalPairs);
    // Ascending last activity is what the independent auditor relies on.
    for (let index = 1; index < base.pairLastMs.length; index += 1) {
      expect(base.pairLastMs[index]!).toBeGreaterThanOrEqual(
        base.pairLastMs[index - 1]!,
      );
    }
    expect(base.counts.reduce((sum, value) => sum + value, 0)).toBe(
      base.totalPairs,
    );
    for (let index = 1; index < base.expiryEndsMs.length; index += 1) {
      expect(base.expiryEndsMs[index]!).toBeGreaterThanOrEqual(
        base.expiryEndsMs[index - 1]!,
      );
    }
    // Every retained expiry is inside the case horizon (the builder keeps one
    // extra second of slack for a query admitted during the drain).
    const horizon =
      model.level.workload.measuredMs + model.level.workload.drainMs + 1_000;
    for (const end of base.expiryEndsMs) {
      expect(end).toBeLessThanOrEqual(horizon);
    }
  });

  it('is deterministic for one seed and independent of the graph', () => {
    const model = tinyModel();
    const first = new AudiencePrehistoryBuilder(model, 9);
    const second = new AudiencePrehistoryBuilder(model, 9);
    while (!first.done) first.step(11);
    while (!second.done) second.step(3);
    expect(Array.from(first.baseHistory.pairKeys)).toEqual(
      Array.from(second.baseHistory.pairKeys),
    );
    expect(Array.from(first.baseHistory.expiryEndsMs)).toEqual(
      Array.from(second.baseHistory.expiryEndsMs),
    );
  });
});

describe('audience case engine on a tiny private model', () => {
  const model = tinyModel();
  const queryGraph = graph({ apps: 2, lb: true, readPlan: 'query' });

  it('is slice invariant and parses as a complete qualified run', () => {
    const whole = run(queryGraph, model, 11);
    const sliced = run(queryGraph, model, 11, 3);
    expect(sliced.cases).toEqual(whole.cases);
    expect(sliced.status).toBe(whole.status);
    const parsed = parseAudienceEvaluation(whole);
    expect(parsed.issues).toEqual([]);
    expect(parsed.ok).toBe(true);
    expect(whole.status).toBe('complete');
    expect(whole.cases.map((item) => item.id)).toEqual([
      'normal',
      'peak',
      'app-failure-0',
      'app-failure-1',
    ]);
    // Cost is the peak case only and only for a passing run.
    const peak = caseById(whole.cases, 'peak');
    if (whole.passed) {
      expect(whole.score.costUsd).toBeCloseTo(peak.cost!.actualUsd, 12);
    } else {
      expect(whole.score.costUsd).toBeNull();
    }
  });

  it('keeps every successful ranking audited and fresh', () => {
    const result = run(queryGraph, model, 11);
    for (const item of result.cases) {
      expect(item.freshness!.checkedReads).toBe(item.freshness!.successfulReads);
      expect(item.freshness!.samples).toBe(item.freshness!.checkedReads);
      expect(item.correctness!.checkedSnapshots).toBe(
        item.freshness!.successfulReads,
      );
      expect(item.correctness!.snapshotMismatches).toBe(0);
      expect(item.correctness!.checkedExpiry).toBe(
        item.correctness!.expectedExpiries,
      );
      expect(item.finalSnapshot).toEqual(item.freshness!.latestSnapshot);
    }
  });

  it('names a fractional snapshot taken at SQL service start, not arrival', () => {
    const result = run(queryGraph, model, 13);
    const snapshots = result.cases
      .map((item) => item.finalSnapshot)
      .filter((item): item is NonNullable<typeof item> => item !== null);
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      expect(Number.isInteger(snapshot.asOfMs)).toBe(false);
      expect(snapshot.throughCommitSequence).toBeGreaterThan(0);
    }
    // The cursor can never exceed the durable high-water mark.
    const peak = caseById(result.cases, 'peak');
    expect(peak.finalSnapshot!.throughCommitSequence).toBeLessThanOrEqual(
      peak.correctness!.commitSequenceHighWater,
    );
  });

  it('tags traffic frames with the case id and keeps them bounded', () => {
    const result = run(queryGraph, model, 11);
    for (const item of result.cases) {
      expect(item.trafficFrames.length).toBeGreaterThan(0);
      expect(item.trafficFrames.length).toBeLessThanOrEqual(240);
      for (const frame of item.trafficFrames) {
        expect(frame.scopeId).toBe(item.id);
        expect(frame.scopeLabel).toBe(item.label);
      }
    }
  });

  it('rejects a projection without a worker as an invalid graph', () => {
    const result = run(
      graph({ apps: 2, lb: true, readPlan: 'projection' }),
      model,
    );
    expect(result.status).toBe('invalid');
    expect(result.passed).toBe(false);
    expect(result.provisioned).toBeNull();
    expect(result.issues.some((item) => item.severity === 'error')).toBe(true);
    expect(result.score).toEqual({
      eligible: false,
      costUsd: null,
      caseId: 'peak',
    });
  });

  it('runs a projection family with a worker and publishes an ordered prefix', () => {
    const result = run(
      graph({ apps: 2, lb: true, readPlan: 'projection', workers: 1 }),
      model,
      17,
    );
    expect(result.status).toBe('complete');
    for (const item of result.cases) {
      expect(item.correctness!.projectionLag).not.toBeNull();
      const lag = item.correctness!.projectionLag!;
      expect(lag.publishedThroughSequence).toBeLessThanOrEqual(
        item.correctness!.commitSequenceHighWater,
      );
      // The served response may lag the end-of-case publication, never lead it.
      if (item.finalSnapshot !== null) {
        expect(item.finalSnapshot.throughCommitSequence).toBeLessThanOrEqual(
          lag.publishedThroughSequence,
        );
      }
    }
  });

  it('keeps every graph link delivered within offered bytes', () => {
    const query = run(queryGraph, model, 11);
    for (const item of query.cases) {
      for (const link of item.links) {
        expect(link.bytesDelivered).toBeGreaterThanOrEqual(0);
        expect(link.bytesDelivered).toBeLessThanOrEqual(
          link.bytesOffered + 1e-9,
        );
      }
      // The query path uses the ingress, balance and primary links.
      expect(
        item.links.find((l) => l.role === 'ingress')?.bytesOffered ?? 0,
      ).toBeGreaterThan(0);
      expect(
        item.links.find((l) => l.role === 'balance')?.bytesOffered ?? 0,
      ).toBeGreaterThan(0);
      expect(
        item.links.find((l) => l.role === 'primary')?.bytesOffered ?? 0,
      ).toBeGreaterThan(0);
    }
    // The cache and projection paths use their own dependency links.
    const cache = run(
      graph({ apps: 2, lb: true, readPlan: 'query', cache: 2 }),
      model,
      11,
    );
    for (const item of cache.cases) {
      expect(
        item.links.find((l) => l.role === 'reads')?.bytesOffered ?? 0,
      ).toBeGreaterThan(0);
      expect(
        item.links.find((l) => l.role === 'fill')?.bytesOffered ?? 0,
      ).toBeGreaterThan(0);
    }
    const projection = run(
      graph({ apps: 2, lb: true, readPlan: 'projection', workers: 1 }),
      model,
      11,
    );
    for (const item of projection.cases) {
      expect(
        item.links.find((l) => l.role === 'projection')?.bytesOffered ?? 0,
      ).toBeGreaterThan(0);
    }
  });

  it('never reports volatile RAM as durable disk on stateless nodes', () => {
    const result = run(queryGraph, model, 11);
    for (const item of result.cases) {
      for (const node of item.nodes) {
        if (node.kind === 'app' || node.kind === 'lb') {
          // App and Load Balancer have no durable storage: their RAM working
          // set must never appear as disk occupancy.
          expect(node.storage.usedBytes).toBe(0);
          expect(node.storage.peakUsedBytes).toBe(0);
        }
        if (node.kind === 'sql') {
          // Only SQL provisions durable raw + index/state.
          expect(node.storage.usedBytes).toBeGreaterThan(0);
        }
      }
    }
  });

  it('never lets a queue average exceed its observed peak', () => {
    const result = run(queryGraph, model, 11);
    for (const item of result.cases) {
      for (const node of item.nodes) {
        expect(node.queue.waitingAverage).toBeLessThanOrEqual(
          node.queue.waitingPeak + 1e-9,
        );
        expect(node.cpu.utilizationAverage).toBeLessThanOrEqual(
          node.cpu.utilizationPeak + 1e-9,
        );
        expect(node.memory.residentBytesAverage).toBeLessThanOrEqual(
          node.memory.peakUsedBytes + 1e-9,
        );
        for (const instance of node.instances) {
          expect(instance.queue.waitingAverage).toBeLessThanOrEqual(
            instance.queue.waitingPeak + 1e-9,
          );
        }
      }
    }
  });

  it('treats the direct path as slot 0 and fails the single-instance fault case', () => {
    const single = run(graph({ apps: 1, lb: false, readPlan: 'query' }), model, 19);
    expect(single.status).toBe('complete');
    const fault = caseById(single.cases, 'app-failure-0');
    expect(fault.target!.instanceIndex).toBe(0);
    // Without a Load Balancer the direct path can only reach slot 0, so the
    // baseline may pass while the fault case loses its whole critical window.
    const critical = fault.operations!.critical;
    expect(critical).not.toBeNull();
    expect(critical!.ingest.availability!).toBeLessThan(
      single.levelId === 'live-audience' ? 0.995 : 0,
    );
    expect(fault.target!.routeRestoredAtMs).toBeNull();
  });

  it('fails readiness routing only after real probe timeouts', () => {
    const result = run(queryGraph, model, 23);
    const fault = caseById(result.cases, 'app-failure-0');
    const target = fault.target!;
    expect(target.crashAtMs).toBe(30_000);
    expect(target.downUntilMs).toBe(45_000);
    expect(target.detectedUnhealthyAtMs).toBeGreaterThan(target.crashAtMs ?? 0);
    // Two 250 ms probes with a 100 ms timeout cannot detect earlier than +200 ms
    // and must not detect at the crash instant.
    expect(target.detectedUnhealthyAtMs! - target.crashAtMs!).toBeGreaterThanOrEqual(
      100,
    );
    expect(fault.incidentTimeline.some((event) => event.kind === 'crash')).toBe(
      true,
    );
    expect(
      fault.incidentTimeline.some(
        (event) => event.kind === 'route-change' && event.instanceIndex === 0,
      ),
    ).toBe(true);
  });

  it('cancels cooperatively and never reports a partial run as passed', () => {
    const session = new AudienceSimulation(
      queryGraph,
      { seed: 29 },
      model,
      tinyProfile(2),
    );
    session.advance(5);
    session.cancel();
    expect(session.done).toBe(true);
    const result = session.result()!;
    expect(result.passed).toBe(false);
    expect(result.score).toEqual({
      eligible: false,
      costUsd: null,
      caseId: 'peak',
    });
    const free = result.cases.every((item) => item.status !== 'complete');
    expect(free).toBe(true);
  });

  it('reports identical results for repeated runs of the same seed', () => {
    const first = run(queryGraph, model, 31);
    const second = run(queryGraph, model, 31);
    expect(second.cases).toEqual(first.cases);
    expect(second.runId).toBe(first.runId);
    expect(second.graphDigest).toBe(first.graphDigest);
  });
});

describe('published fixture graphs parse as real evaluations', () => {
  it('keeps the candidate fixtures structurally valid Live Audience documents', () => {
    const manifest = JSON.parse(
      readFileSync('fixtures/audience/manifest.json', 'utf8'),
    ) as { fixtures: { file: string }[] };
    expect(manifest.fixtures.length).toBeGreaterThan(5);
  });

  it('derives one failure case per physical instance', () => {
    const profile = createAudienceChallengeProfile(3);
    expect(profile.requiredCaseIds).toEqual([
      'normal',
      'peak',
      'app-failure-0',
      'app-failure-1',
      'app-failure-2',
    ]);
    expect(profile.costPolicy).toBe('peak-actual-only');
  });
});

describe('idempotent ingest and Application crash semantics', () => {
  /**
   * Long SQL transactions make the crash deterministic: a handful of events are
   * always inside their durable transaction when the process dies, so their
   * Application work is lost while the commit still lands.
   */
  function crashModel(): AudienceModel {
    const base = tinyModel({ ingestPerSecond: 200 });
    const catalog = JSON.parse(JSON.stringify(base.catalog));
    catalog.work.sqlAppendCoreMsPerEvent = 60;
    catalog.work.sqlAppendDiskMsPerEvent = 1;
    catalog.components.sql.sizes.small.cores = 64;
    catalog.components.sql.sizes.small.memoryGb = 64;
    return { level: base.level, catalog };
  }
  const model = crashModel();
  const faultGraph = graph({ apps: 2, lb: true, readPlan: 'query' });

  function faultCase(
    configure?: (simulation: AudienceCaseSimulation) => void,
  ): AudienceCaseResult {
    const spec = tinyProfile(2).cases.find((item) => item.id === 'app-failure-0')!;
    const base = (() => {
      const builder = new AudiencePrehistoryBuilder(model, 41);
      while (!builder.done) builder.step(500);
      return builder.baseHistory;
    })();
    const topologyResult = resolveAudienceTopology(faultGraph, model);
    if (!topologyResult.ok) throw new Error('fault graph must be valid');
    const simulation = new AudienceCaseSimulation({
      model,
      topology: topologyResult.value,
      caseSpec: spec,
      seed: 41,
      base,
      ingest: buildAudienceIngestTrace(model, 41),
      reads: buildAudienceReadTrace(41, spec.traffic.readPhases, spec.id),
    });
    configure?.(simulation);
    while (!simulation.done) simulation.advance(1_000);
    return simulation.caseResult!;
  }

  it('keeps exactly one effect per logical event while an instance crashes', () => {
    const result = faultCase();
    expect(result.correctness!.duplicateLogicalEvents).toBe(0);
    expect(result.correctness!.lostAcknowledgedEvents).toBe(0);
    expect(result.correctness!.payloadConflicts).toBe(0);
    expect(result.correctness!.valid).toBe(true);
    // The crash really loses Application work while durable commits survive.
    expect(result.correctness!.commitsSurvivedAppCrash).toBeGreaterThan(0);
    expect(result.correctness!.idempotentReplays).toBeGreaterThan(0);
    expect(result.target!.restartCount).toBe(1);
  });

  it('rejects a mutated retry payload as a conflict with no second effect', () => {
    const result = faultCase((simulation) => simulation.setTestPayloadConflict());
    expect(result.correctness!.payloadConflicts).toBeGreaterThan(0);
    expect(result.correctness!.duplicateLogicalEvents).toBe(0);
    expect(result.correctness!.valid).toBe(false);
    const preservation = result.gates.find((gate) => gate.id === 'data-preservation');
    expect(preservation?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('keeps the durable commit when the client deadline passes before SQL finishes', () => {
    // One logical event with a 1.5 s SQL transaction and a 1 s deadline: the
    // client gives up, but the accepted transaction still commits durably.
    const base = tinyModel();
    const catalog = JSON.parse(JSON.stringify(base.catalog));
    catalog.work.sqlAppendCoreMsPerEvent = 1_500;
    catalog.work.sqlAppendDiskMsPerEvent = 1;
    catalog.components.sql.sizes.small.cores = 64;
    const model: AudienceModel = { level: base.level, catalog };
    const spec = tinyProfile(2).cases.find((item) => item.id === 'normal')!;
    const builder = new AudiencePrehistoryBuilder(model, 91);
    while (!builder.done) builder.step(500);
    const single: AudienceIngestTrace = {
      count: 1,
      timesMs: Float64Array.from([0]),
      users: Int32Array.from([2]),
      streams: Uint8Array.from([0]),
      pairs: Int32Array.from([2 * model.level.dataset.streams]),
    };
    const reads: AudienceReadTrace = { count: 0, timesMs: new Float64Array(0) };
    const topologyResult = resolveAudienceTopology(faultGraph, model);
    if (!topologyResult.ok) throw new Error('fault graph must be valid');
    const simulation = new AudienceCaseSimulation({
      model,
      topology: topologyResult.value,
      caseSpec: spec,
      seed: 91,
      base: builder.baseHistory,
      ingest: single,
      reads,
    });
    while (!simulation.done) simulation.advance(1_000);
    const result = simulation.caseResult!;
    expect(result.correctness!.ingestCommitted).toBe(1);
    expect(result.correctness!.ingestAcknowledged).toBe(0);
    expect(result.correctness!.committedUnacknowledged).toBe(1);
    expect(result.operations!.ingest.succeeded).toBe(0);
    // Accepted-but-unresolved SQL at the deadline is an unknown outcome, not a
    // definitive timeout: the transaction may still commit.
    expect(result.operations!.ingest.unknownOutcome).toBe(1);
    expect(result.operations!.ingest.timedOut).toBe(0);
    expect(result.correctness!.unknownCommitOutcomes).toBe(1);
    expect(result.correctness!.lostAcknowledgedEvents).toBe(0);
    expect(result.correctness!.valid).toBe(true);
  });

  it('makes a read retry pay its own scan after a crash, never a stale callback', () => {
    // One read whose ~100 ms SQL scan spans the 30 s crash: the old scan
    // callback must not deliver, and the single retry pays a fresh full scan.
    const base = tinyModel();
    const catalog = JSON.parse(JSON.stringify(base.catalog));
    catalog.work.queryResultGroupSortCoreMs = 100;
    catalog.work.queryScanCoreMsPerEvent = 0.0001;
    catalog.work.queryDistinctCoreMsPerPair = 0.001;
    catalog.components.sql.sizes.small.cores = 64;
    const model: AudienceModel = { level: base.level, catalog };
    const spec = tinyProfile(2).cases.find((item) => item.id === 'app-failure-0')!;
    const builder = new AudiencePrehistoryBuilder(model, 83);
    while (!builder.done) builder.step(500);
    const noIngest: AudienceIngestTrace = {
      count: 0,
      timesMs: new Float64Array(0),
      users: new Int32Array(0),
      streams: new Uint8Array(0),
      pairs: new Int32Array(0),
    };
    const reads: AudienceReadTrace = {
      count: 1,
      timesMs: Float64Array.from([29_950]),
    };
    const topologyResult = resolveAudienceTopology(faultGraph, model);
    if (!topologyResult.ok) throw new Error('fault graph must be valid');
    const simulation = new AudienceCaseSimulation({
      model,
      topology: topologyResult.value,
      caseSpec: spec,
      seed: 83,
      base: builder.baseHistory,
      ingest: noIngest,
      reads,
    });
    while (!simulation.done) simulation.advance(1_000);
    const result = simulation.caseResult!;
    expect(result.operations!.read.offered).toBe(1);
    expect(result.operations!.read.retries).toBe(1);
    expect(result.operations!.read.succeeded).toBe(1);
    expect(result.freshness!.checkedReads).toBe(1);
    expect(result.correctness!.checkedSnapshots).toBe(1);
    expect(result.correctness!.snapshotMismatches).toBe(0);
    // The retry really re-executed the scan; the stale callback could not have
    // shortened it, so the response latency is at least the scan work.
    expect(result.operations!.read.latency.maxMs!).toBeGreaterThanOrEqual(100);
    expect(result.correctness!.valid).toBe(true);
  });

  it('does not strand a coalesced cache waiter when its fill lead crashes', () => {
    // Two reads coalesce on one cache fill whose 100 ms scan spans the crash.
    // The lead connection drops and retries, but the fill still completes and
    // serves the waiter plus the retried lead instead of stranding them.
    const base = tinyModel();
    const catalog = JSON.parse(JSON.stringify(base.catalog));
    catalog.work.queryResultGroupSortCoreMs = 100;
    catalog.work.queryScanCoreMsPerEvent = 0.0001;
    catalog.work.queryDistinctCoreMsPerPair = 0.001;
    catalog.components.sql.sizes.small.cores = 64;
    const model: AudienceModel = { level: base.level, catalog };
    const spec = tinyProfile(2).cases.find((item) => item.id === 'app-failure-0')!;
    const builder = new AudiencePrehistoryBuilder(model, 71);
    while (!builder.done) builder.step(500);
    const noIngest: AudienceIngestTrace = {
      count: 0,
      timesMs: new Float64Array(0),
      users: new Int32Array(0),
      streams: new Uint8Array(0),
      pairs: new Int32Array(0),
    };
    const reads: AudienceReadTrace = {
      count: 2,
      timesMs: Float64Array.from([29_950, 29_950.2]),
    };
    const cacheGraph = graph({ apps: 2, lb: true, readPlan: 'query', cache: 2 });
    const topologyResult = resolveAudienceTopology(cacheGraph, model);
    if (!topologyResult.ok) throw new Error('cache graph must be valid');
    const simulation = new AudienceCaseSimulation({
      model,
      topology: topologyResult.value,
      caseSpec: spec,
      seed: 71,
      base: builder.baseHistory,
      ingest: noIngest,
      reads,
    });
    while (!simulation.done) simulation.advance(1_000);
    const result = simulation.caseResult!;
    expect(result.operations!.read.offered).toBe(2);
    expect(result.operations!.read.pending).toBe(0);
    expect(result.operations!.read.succeeded).toBe(2);
    expect(result.operations!.read.retries).toBeGreaterThanOrEqual(1);
    expect(result.correctness!.valid).toBe(true);
  });

  it('classifies a committed-but-ack-undelivered ingest at deadline as unknown', () => {
    // Commit lands before the 1 s deadline, but the ACK propagation is still in
    // flight when it fires: the client outcome is unknown, not a timeout.
    const base = tinyModel();
    const catalog = JSON.parse(JSON.stringify(base.catalog));
    catalog.work.sqlAppendCoreMsPerEvent = 990;
    catalog.work.sqlAppendDiskMsPerEvent = 1;
    catalog.components.sql.sizes.small.cores = 64;
    const model: AudienceModel = { level: base.level, catalog };
    const spec = tinyProfile(2).cases.find((item) => item.id === 'normal')!;
    const builder = new AudiencePrehistoryBuilder(model, 97);
    while (!builder.done) builder.step(500);
    const single: AudienceIngestTrace = {
      count: 1,
      timesMs: Float64Array.from([0]),
      users: Int32Array.from([5]),
      streams: Uint8Array.from([0]),
      pairs: Int32Array.from([5 * model.level.dataset.streams]),
    };
    const reads: AudienceReadTrace = { count: 0, timesMs: new Float64Array(0) };
    const topologyResult = resolveAudienceTopology(faultGraph, model);
    if (!topologyResult.ok) throw new Error('fault graph must be valid');
    const simulation = new AudienceCaseSimulation({
      model,
      topology: topologyResult.value,
      caseSpec: spec,
      seed: 97,
      base: builder.baseHistory,
      ingest: single,
      reads,
    });
    while (!simulation.done) simulation.advance(1_000);
    const result = simulation.caseResult!;
    expect(result.correctness!.ingestCommitted).toBe(1);
    expect(result.correctness!.ingestAcknowledged).toBe(0);
    expect(result.correctness!.committedUnacknowledged).toBe(1);
    expect(result.operations!.ingest.unknownOutcome).toBe(1);
    expect(result.operations!.ingest.timedOut).toBe(0);
    expect(result.correctness!.unknownCommitOutcomes).toBe(1);
    expect(result.correctness!.lostAcknowledgedEvents).toBe(0);
    expect(result.correctness!.valid).toBe(true);
  });

  it('drops one in-flight SQL commit at the crash with exactly one retry and one effect', () => {
    // One deterministic logical event whose 60 ms SQL transaction spans the
    // 30 s crash: the connection is observed dropped, the original commit
    // survives, and the single bounded retry replays the same id exactly once.
    const model = crashModel();
    const spec = tinyProfile(2).cases.find((item) => item.id === 'app-failure-0')!;
    const builder = new AudiencePrehistoryBuilder(model, 77);
    while (!builder.done) builder.step(500);
    const streams = model.level.dataset.streams;
    const single: AudienceIngestTrace = {
      count: 1,
      timesMs: Float64Array.from([29_950]),
      users: Int32Array.from([3]),
      streams: Uint8Array.from([1]),
      pairs: Int32Array.from([3 * streams + 1]),
    };
    const reads: AudienceReadTrace = { count: 0, timesMs: new Float64Array(0) };
    const topologyResult = resolveAudienceTopology(faultGraph, model);
    if (!topologyResult.ok) throw new Error('fault graph must be valid');
    const simulation = new AudienceCaseSimulation({
      model,
      topology: topologyResult.value,
      caseSpec: spec,
      seed: 77,
      base: builder.baseHistory,
      ingest: single,
      reads,
    });
    while (!simulation.done) simulation.advance(1_000);
    const result = simulation.caseResult!;
    expect(result.correctness!.ingestCommitted).toBe(1);
    expect(result.correctness!.commitsSurvivedAppCrash).toBe(1);
    expect(result.operations!.ingest.retries).toBe(1);
    expect(result.correctness!.idempotentReplays).toBe(1);
    expect(result.correctness!.duplicateLogicalEvents).toBe(0);
    expect(result.correctness!.lostAcknowledgedEvents).toBe(0);
    expect(result.operations!.ingest.succeeded).toBe(1);
    expect(result.operations!.ingest.failed).toBe(0);
    expect(result.correctness!.valid).toBe(true);
  });
});
