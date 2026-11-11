import { describe, expect, it } from 'vitest';

import { AUDIENCE_CATALOG } from '../catalog';
import { AUDIENCE_LEVEL } from '../level';
import {
  AUDIENCE_LEVEL_ID,
  AUDIENCE_SCHEMA_VERSION,
  type AudienceCaseSpec,
  type AudienceGraph,
  type AudienceLevel,
  type AudienceCatalog,
  type AudienceCaseResult,
} from '../contracts';
import type { AudienceModel } from '../core/model';
import {
  AudienceCaseSimulation,
} from '../core/case';
import {
  Int32KeyTable,
  buildAudienceIngestTrace,
  buildAudienceReadTrace,
  type AudienceBaseHistory,
} from '../core/workload';
import { resolveAudienceTopology } from '../core/topology';

/**
 * Arithmetic regression witnesses for Live Audience resource physics.
 *
 * These use a handcrafted tiny history and a private catalog/model. They are
 * intentionally not SLO qualification tests: the expected numbers below are
 * computed from the declared bytes and pair counts, never copied from the
 * implementation. They are executable against the future corrected Pro core.
 *
 * RED on the draft core is expected and intentional. Do not weaken them to
 * match draft physics.
 */

const STREAMS = 4;

function privateModel(options: {
  prehistoryEvents?: number;
  ingestPerSecond?: number;
  readsPerSecond?: number;
  measuredMs?: number;
  drainMs?: number;
  appNicGbitPerSec?: number;
  ingestRequestBytes?: number;
  ingestAckBytes?: number;
  rankingResponseBytes?: number;
} = {}): AudienceModel {
  const prehistoryEvents = options.prehistoryEvents ?? 6;
  const measuredMs = options.measuredMs ?? 300;
  const drainMs = options.drainMs ?? 100;
  const level = JSON.parse(JSON.stringify(AUDIENCE_LEVEL)) as AudienceLevel;
  const catalog = JSON.parse(
    JSON.stringify(AUDIENCE_CATALOG),
  ) as AudienceCatalog;
  level.dataset.users = 40;
  level.dataset.streams = STREAMS;
  level.dataset.prehistoryEvents = prehistoryEvents;
  level.dataset.prehistoryRawBytes =
    prehistoryEvents * level.dataset.eventBytes;
  level.workload.measuredMs = measuredMs;
  level.workload.drainMs = drainMs;
  level.workload.ingestEventsPerSecond = options.ingestPerSecond ?? 0;
  level.workload.readPhases = [
    {
      fromMs: 0,
      toMs: measuredMs,
      readsPerSecond: options.readsPerSecond ?? 0,
    },
  ];
  level.workload.peakWindow = { fromMs: 0, toMs: measuredMs };
  level.workload.faultWindow = { fromMs: 0, toMs: measuredMs };
  level.workload.topN = 4;
  level.limits.maxPreparationMs = 120_000;
  catalog.components.app.instances.default = 1;
  catalog.components.app.nicGbitPerSecPerInstance =
    options.appNicGbitPerSec ?? 1;
  catalog.components.sql.sizes.small.nicGbitPerSec = 10;
  catalog.network.ingestRequestBytes =
    options.ingestRequestBytes ?? catalog.network.ingestRequestBytes;
  catalog.network.ingestAckBytes =
    options.ingestAckBytes ?? catalog.network.ingestAckBytes;
  catalog.network.rankingResponseBytes =
    options.rankingResponseBytes ?? catalog.network.rankingResponseBytes;
  return { level, catalog };
}

function graph(readPlan: 'query' | 'projection'): AudienceGraph {
  const nodes: AudienceGraph['nodes'] = [
    {
      id: 'users',
      kind: 'users',
      label: 'Users',
      position: { x: 0, y: 0 },
      config: {},
    },
    {
      id: 'app',
      kind: 'app',
      label: 'Application',
      position: { x: 0, y: 0 },
      config: { instances: 1 },
    },
    {
      id: 'sql',
      kind: 'sql',
      label: 'SQL Database',
      position: { x: 0, y: 0 },
      config: { size: 'small', readPlan },
    },
  ];
  const edges: AudienceGraph['edges'] = [
    { id: 'users-app', from: 'users', to: 'app' },
    { id: 'app-sql', from: 'app', to: 'sql' },
  ];
  if (readPlan === 'projection') {
    nodes.push({
      id: 'worker',
      kind: 'worker',
      label: 'Worker pool',
      position: { x: 0, y: 0 },
      config: { instances: 1 },
    });
    edges.push({ id: 'worker-sql', from: 'worker', to: 'sql' });
  }
  return {
    schemaVersion: AUDIENCE_SCHEMA_VERSION,
    levelId: AUDIENCE_LEVEL_ID,
    nodes,
    edges,
  };
}

/**
 * Handcrafted history with exact pair counts and no expiry inside the short
 * measured+drain horizon. `prehistoryEvents` may be larger than the number of
 * distinct pairs, which is exactly the distinction the query and projection
 * setup formulas must preserve.
 */
function handcraftedBase(
  model: AudienceModel,
  options: {
    prehistoryEvents: number;
    pairLastMs?: readonly number[];
  },
): AudienceBaseHistory {
  const pairLastMs = options.pairLastMs ?? [-900, -600, -300];
  const table = new Int32KeyTable(16);
  for (const key of pairLastMs.keys()) {
    table.add(key);
  }
  const counts = new Int32Array(STREAMS);
  for (const key of pairLastMs.keys()) {
    counts[key % STREAMS] = (counts[key % STREAMS] ?? 0) + 1;
  }
  // The six raw rows include every distinct pair's last activity plus filler
  // instants, so the handcrafted history is internally coherent.
  const eventTimes = [...pairLastMs];
  for (let index = eventTimes.length; index < options.prehistoryEvents; index += 1) {
    eventTimes.push(-1_000 + index * 10);
  }
  eventTimes.sort((left, right) => left - right);
  return {
    counts,
    totalPairs: pairLastMs.length,
    pairs: table,
    pairKeys: Int32Array.from(pairLastMs.keys()),
    pairLastMs: Float64Array.from(pairLastMs),
    eventTimesMs: Float64Array.from(eventTimes),
    // The measured+drain horizon is far below the activity window, so none of
    // these handcrafted pairs expires inside this case.
    expiryEndsMs: new Float64Array(0),
    expiryKeys: new Int32Array(0),
    expiryStreams: new Uint8Array(0),
    prehistoryEvents: options.prehistoryEvents,
    prehistoryDistinctPairs: pairLastMs.length,
    // Match the real prehistory builder: raw prehistory storage is provisioned
    // up front and is the one source of those raw bytes.
    provisionDiskMs:
      options.prehistoryEvents * model.catalog.work.sqlAppendDiskMsPerEvent,
    provisionBytes:
      options.prehistoryEvents * model.catalog.storage.rawEventBytes,
  };
}

function normalSpec(model: AudienceModel): AudienceCaseSpec {
  return {
    id: 'normal',
    kind: 'normal',
    label: 'Normal traffic',
    targetInstance: null,
    traffic: {
      readPhases: model.level.workload.readPhases.map((phase) => ({
        ...phase,
      })),
      ingestEventsPerSecond: model.level.workload.ingestEventsPerSecond,
      trace: 'same-seed-input',
    },
    fault: null,
    criticalWindow: null,
  };
}

function runCase(
  model: AudienceModel,
  readPlan: 'query' | 'projection',
  base: AudienceBaseHistory,
  seed = 7,
): AudienceCaseResult {
  const topology = resolveAudienceTopology(graph(readPlan), model);
  if (!topology.ok) {
    throw new Error('private test graph must be valid');
  }
  const spec = normalSpec(model);
  const simulation = new AudienceCaseSimulation({
    model,
    topology: topology.value,
    caseSpec: spec,
    seed,
    base,
    ingest: buildAudienceIngestTrace(model, seed),
    reads: buildAudienceReadTrace(seed, spec.traffic.readPhases, spec.id),
  });
  let guard = 0;
  while (!simulation.done && guard < 100_000) {
    simulation.advance(10_000);
    guard += 1;
  }
  if (!simulation.done || simulation.caseResult === null) {
    throw new Error('private case did not complete');
  }
  return simulation.caseResult;
}

function node(
  result: AudienceCaseResult,
  kind: 'app' | 'sql' | 'users' | 'worker',
): NonNullable<AudienceCaseResult['nodes'][number]> {
  const found = result.nodes.find((item) => item.kind === kind);
  if (found === undefined) {
    throw new Error(`missing ${kind} node metrics`);
  }
  return found;
}

describe('Live Audience SQL storage arithmetic', () => {
  it('query storage keeps raw rows once and counts the index for every committed row', () => {
    const model = privateModel({
      prehistoryEvents: 6,
      ingestPerSecond: 0,
      measuredMs: 200,
      drainMs: 100,
    });
    const base = handcraftedBase(model, { prehistoryEvents: 6 });
    const result = runCase(model, 'query', base);
    const storage = node(result, 'sql').storage;
    const raw = model.catalog.storage.rawEventBytes;
    const index = model.catalog.storage.queryIndexBytesPerEvent;

    // No commits in this fixture: raw prehistory plus its exact index.
    expect(storage.usedBytes).toBeCloseTo(6 * raw + 6 * index, 9);
  });

  it('query storage adds raw and index bytes for every committed unique event', () => {
    const model = privateModel({
      prehistoryEvents: 6,
      ingestPerSecond: 20,
      measuredMs: 300,
      drainMs: 400,
    });
    const base = handcraftedBase(model, { prehistoryEvents: 6 });
    const result = runCase(model, 'query', base);
    const storage = node(result, 'sql').storage;
    const raw = model.catalog.storage.rawEventBytes;
    const index = model.catalog.storage.queryIndexBytesPerEvent;
    expect(result.correctness?.duplicateLogicalEvents).toBe(0);
    expect(result.correctness?.lostAcknowledgedEvents).toBe(0);
    const committed = result.correctness?.ingestCommitted ?? 0;
    expect(committed).toBeGreaterThan(0);

    // Every durable row keeps its raw bytes and its query-index entry.
    expect(storage.usedBytes).toBeCloseTo(
      6 * raw + 6 * index + committed * (raw + index),
      9,
    );
  });

  it('projection setup uses distinct pairs, not raw prehistory rows', () => {
    const model = privateModel({
      prehistoryEvents: 6,
      ingestPerSecond: 0,
      measuredMs: 200,
      drainMs: 100,
    });
    const base = handcraftedBase(model, { prehistoryEvents: 6 });
    expect(base.prehistoryDistinctPairs).toBe(3);
    const result = runCase(model, 'projection', base);
    const storage = node(result, 'sql').storage;
    const raw = model.catalog.storage.rawEventBytes;
    const pair = model.catalog.storage.projectionPairBytes;

    // Raw prehistory rows plus one durable state entry per distinct pair.
    // Prehistory rows are not outbox jobs, so no outbox bytes are added.
    expect(storage.usedBytes).toBeCloseTo(6 * raw + 3 * pair, 9);
  });

  it('projection drain releases completed outbox jobs and stays within an exact raw/state bound', () => {
    const model = privateModel({
      prehistoryEvents: 6,
      ingestPerSecond: 10,
      measuredMs: 300,
      drainMs: 2_000,
    });
    const base = handcraftedBase(model, { prehistoryEvents: 6 });
    const result = runCase(model, 'projection', base);
    const storage = node(result, 'sql').storage;
    const raw = model.catalog.storage.rawEventBytes;
    const pair = model.catalog.storage.projectionPairBytes;
    const lag = result.correctness?.projectionLag;
    expect(lag).not.toBeNull();
    expect(result.correctness?.duplicateLogicalEvents).toBe(0);
    const committed = result.correctness?.ingestCommitted ?? 0;
    expect(committed).toBeGreaterThan(0);

    // The bounded drain must publish every committed job before the case ends.
    expect(lag!.unpublishedJobs).toBe(0);
    expect(lag!.lagEvents).toBe(0);
    expect(lag!.publishedThroughSequence).toBe(
      result.correctness?.commitSequenceHighWater,
    );

    // Lower bound: retained raw history and the exact distinct prehistory state.
    // Upper bound: every committed row and at most one distinct state entry per
    // committed row; no outbox rows remain after the drain. This intentionally
    // avoids inventing a final distinct-pair constant.
    const lower = 6 * raw + 3 * pair;
    const upper = 6 * raw + committed * raw + (3 + committed) * pair;
    expect(storage.usedBytes).toBeGreaterThanOrEqual(lower - 1e-9);
    expect(storage.usedBytes).toBeLessThanOrEqual(upper + 1e-9);
  });
});

describe('Live Audience network arithmetic', () => {
  it('a used path reports nonzero bytes and average <= peak <= advertised NIC capacity', () => {
    const model = privateModel({
      prehistoryEvents: 6,
      ingestPerSecond: 20,
      measuredMs: 600,
      drainMs: 400,
      appNicGbitPerSec: 2,
      ingestRequestBytes: 2_000,
    });
    const base = handcraftedBase(model, { prehistoryEvents: 6 });
    const result = runCase(model, 'query', base);
    const app = node(result, 'app');
    const sql = node(result, 'sql');

    expect(app.network.bytesOffered).toBeGreaterThan(0);
    expect(app.network.bytesDelivered).toBeGreaterThan(0);
    expect(sql.network.bytesOffered).toBeGreaterThan(0);
    expect(sql.network.bytesDelivered).toBeGreaterThan(0);

    for (const item of [app, sql]) {
      expect(item.network.capacityGbitPerSec).toBe(
        item.kind === 'app'
          ? model.catalog.components.app.nicGbitPerSecPerInstance
          : model.catalog.components.sql.sizes.small.nicGbitPerSec,
      );
      expect(item.network.averageGbitPerSec).toBeLessThanOrEqual(
        item.network.peakGbitPerSec + 1e-9,
      );
      expect(item.network.peakGbitPerSec).toBeLessThanOrEqual(
        item.network.capacityGbitPerSec + 1e-9,
      );
    }
  });

  it('a constrained NIC changes the real read-response capacity outcome at low CPU', () => {
    // Identical tiny workloads; only the private Application NIC capacity
    // differs. Units: rankingResponseBytes are bytes, a 1 Gbit/s lane carries
    // 125_000 bytes/ms, so 8_000_000 bytes serialize in 64 ms per response.
    // At 40 responses/s the offered load is 8_000_000*8*40 = 2.56 Gbit/s:
    // above the constrained 1 Gbit/s lane and below the ample 8 Gbit/s pool.
    // CPU work stays negligible, so any outcome difference is network capacity.
    const RESPONSE_BYTES = 8_000_000;
    const READ_RPS = 40;
    const LOW_GBIT = 1;
    const HIGH_GBIT = 8;
    const SERIALIZATION_MS = (RESPONSE_BYTES * 8) / 1_000_000;
    const AGGREGATE_GBIT = (RESPONSE_BYTES * 8 * READ_RPS) / 1_000_000_000;
    expect(SERIALIZATION_MS).toBe(64);
    expect(AGGREGATE_GBIT).toBeGreaterThan(LOW_GBIT);
    expect(AGGREGATE_GBIT).toBeLessThan(HIGH_GBIT);

    const common = {
      prehistoryEvents: 6,
      ingestPerSecond: 0,
      readsPerSecond: READ_RPS,
      measuredMs: 1_000,
      drainMs: 2_000,
      rankingResponseBytes: RESPONSE_BYTES,
    } as const;
    const lowModel = privateModel({ ...common, appNicGbitPerSec: LOW_GBIT });
    const highModel = privateModel({ ...common, appNicGbitPerSec: HIGH_GBIT });
    const low = runCase(
      lowModel,
      'query',
      handcraftedBase(lowModel, { prehistoryEvents: 6 }),
    );
    const high = runCase(
      highModel,
      'query',
      handcraftedBase(highModel, { prehistoryEvents: 6 }),
    );

    const lowRead = low.operations!.read;
    const highRead = high.operations!.read;
    expect(highRead.succeeded).toBe(highRead.offered);
    expect(highRead.timedOut).toBe(0);
    expect(highRead.rejected).toBe(0);
    // One 1 Gbit/s lane serves ~15.6 responses/s; the 40 rps offered load
    // queues past the fixed 1000 ms deadline. Eight lanes serve ~125/s, so the
    // ample run completes without deadline loss.
    expect(lowRead.timedOut).toBeGreaterThan(0);
    expect(lowRead.succeeded).toBeLessThan(highRead.succeeded);

    const lowQueue = node(low, 'app').queue;
    const highQueue = node(high, 'app').queue;
    expect(lowQueue.waitMsMax).toBeGreaterThan(0);
    expect(lowQueue.waitMsMax).toBeGreaterThanOrEqual(highQueue.waitMsMax);
  });
});
