import { describe, expect, it } from 'vitest';

import { AUDIENCE_CATALOG } from '../catalog';
import { AUDIENCE_LEVEL } from '../level';
import {
  AUDIENCE_LEVEL_ID,
  AUDIENCE_PROFILE_VERSION,
  AUDIENCE_SCHEMA_VERSION,
  type AudienceCaseResult,
  type AudienceChallengeProfile,
  type AudienceGraph,
  type AudienceTrafficFrame,
} from '../contracts';
import type { AudienceModel } from './model';
import {
  closeEdgeBucket,
  createEdge,
  observeEdge,
  openEdgeBucketRates,
} from './nodes';
import { AudienceSimulation } from '../session';

/**
 * Focused regression for the Live Audience edge telemetry boundary.
 *
 * The engine still runs for real; only the dataset, case window and read burst
 * are tiny so the test can assert exact per-window rates, window durations and
 * offered-counter conservation without a long qualification run.
 */

const MEASURED_MS = 4_000;
const DRAIN_MS = 10_000;
const STREAMS = 4;
const PREHISTORY = 80;

function tinyModel(): AudienceModel {
  const level = JSON.parse(JSON.stringify(AUDIENCE_LEVEL));
  const catalog = JSON.parse(JSON.stringify(AUDIENCE_CATALOG));
  level.dataset.users = 20;
  level.dataset.streams = STREAMS;
  level.dataset.prehistoryEvents = PREHISTORY;
  level.dataset.prehistoryRawBytes = PREHISTORY * 128;
  level.dataset.rankingBytes = 4_096;
  level.dataset.ingestAckBytes = 200;
  level.workload.measuredMs = MEASURED_MS;
  level.workload.drainMs = DRAIN_MS;
  level.workload.ingestEventsPerSecond = 0;
  level.workload.readPhases = [
    { fromMs: 0, toMs: 300, readsPerSecond: 30 },
    { fromMs: 300, toMs: MEASURED_MS, readsPerSecond: 0 },
  ];
  level.workload.peakWindow = { fromMs: 0, toMs: 1_000 };
  level.workload.faultWindow = { fromMs: 0, toMs: 1_000 };
  level.workload.topN = STREAMS;
  level.limits.maxEvents = 1_000_000;
  level.limits.maxPreparationMs = 120_000;
  level.calibrationSeeds = [1];
  level.holdoutSeeds = [2];
  catalog.components.app.cpuCoresPerInstance = 1;
  catalog.storage.queryWorkingPairBytes = 8;
  return { level, catalog } as AudienceModel;
}

function tinyProfile(): AudienceChallengeProfile {
  const traffic = {
    readPhases: [
      { fromMs: 0, toMs: 300, readsPerSecond: 30 },
      { fromMs: 300, toMs: MEASURED_MS, readsPerSecond: 0 },
    ],
    ingestEventsPerSecond: 0,
    trace: 'same-seed-input' as const,
  };
  return {
    profileVersion: AUDIENCE_PROFILE_VERSION,
    appInstances: 1,
    cases: [
      {
        id: 'normal',
        kind: 'normal',
        label: 'Normal traffic',
        targetInstance: null,
        traffic,
        fault: null,
        criticalWindow: null,
      },
      {
        id: 'peak',
        kind: 'peak',
        label: 'Peak traffic',
        targetInstance: null,
        traffic,
        fault: null,
        criticalWindow: { fromMs: 0, toMs: 300 },
      },
    ],
    requiredCaseIds: ['normal', 'peak'],
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

function directGraph(): AudienceGraph {
  return {
    schemaVersion: AUDIENCE_SCHEMA_VERSION,
    levelId: AUDIENCE_LEVEL_ID,
    nodes: [
      node('users', 'users'),
      node('app', 'app', { instances: 1 }),
      node('sql', 'sql', { size: 'small', readPlan: 'query' }),
    ],
    edges: [
      { id: 'users-app', from: 'users', to: 'app' },
      { id: 'app-sql', from: 'app', to: 'sql' },
    ],
  };
}

function loadBalancedGraph(): AudienceGraph {
  return {
    schemaVersion: AUDIENCE_SCHEMA_VERSION,
    levelId: AUDIENCE_LEVEL_ID,
    nodes: [
      node('users', 'users'),
      node('lb', 'lb'),
      node('app', 'app', { instances: 1 }),
      node('sql', 'sql', { size: 'small', readPlan: 'query' }),
    ],
    edges: [
      { id: 'users-lb', from: 'users', to: 'lb' },
      { id: 'lb-app', from: 'lb', to: 'app' },
      { id: 'app-sql', from: 'app', to: 'sql' },
    ],
  };
}

function normalCase(graph: AudienceGraph): AudienceCaseResult {
  const session = new AudienceSimulation(
    graph,
    { seed: 7 },
    tinyModel(),
    tinyProfile(),
  );
  const result = session.runToCompletion(5);
  const found = result.cases.find((item) => item.id === 'normal');
  if (found === undefined) {
    throw new Error('missing normal case');
  }
  return found;
}

function edgeRate(
  frame: AudienceTrafficFrame,
  edgeId: string,
): { requestsPerSecond: number; bytesPerSecond: number } {
  const edge = frame.edges.find((item) => item.edgeId === edgeId);
  if (edge === undefined) {
    throw new Error(`missing edge ${edgeId} in frame ${frame.timeMs}`);
  }
  return {
    requestsPerSecond: edge.requestsPerSecond,
    bytesPerSecond: edge.bytesPerSecond ?? 0,
  };
}

/** Sum of a rate over the real window it covers. */
function frameTotals(
  frame: AudienceTrafficFrame,
  edgeId: string,
): { requests: number; bytes: number } {
  const rates = edgeRate(frame, edgeId);
  const factor = frame.windowMs / 1_000;
  return {
    requests: rates.requestsPerSecond * factor,
    bytes: rates.bytesPerSecond * factor,
  };
}

describe('openEdgeBucketRates', () => {
  it('observes the open offered counters without consuming or resetting them', () => {
    const edge = createEdge('e-test', 'a', 'b', 'traffic');
    // One attempt is offered but not delivered; the other is delivered. The
    // rate must describe offered dispatch, not only acknowledged bandwidth.
    observeEdge(edge, 'read', 100, false);
    observeEdge(edge, 'read', 300, true);

    const first = openEdgeBucketRates(edge, 1_000);
    expect(first).toEqual({ requestsPerSecond: 2, bytesPerSecond: 400 });
    expect(openEdgeBucketRates(edge, 1_000)).toEqual(first);
    expect(edge.bucketRequests).toBe(2);
    expect(edge.bucketBytes).toBe(400);
    expect(edge.requestsTotal).toBe(2);
    expect(edge.bytesOffered).toBe(400);
    expect(edge.bytesDelivered).toBe(300);

    // A sub-second window is normalised by its own real duration.
    expect(openEdgeBucketRates(edge, 2_000)).toEqual({
      requestsPerSecond: 1,
      bytesPerSecond: 200,
    });

    // The existing close keeps its peak semantics and still resets the bucket.
    closeEdgeBucket(edge, 1_000);
    expect(edge.peakRequestsPerSecond).toBe(2);
    expect(edge.peakBytesPerSecond).toBe(400);
    expect(openEdgeBucketRates(edge, 1_000)).toEqual({
      requestsPerSecond: 0,
      bytesPerSecond: 0,
    });
    // Business totals survive the close and the observation.
    expect(edge.requestsTotal).toBe(2);
    expect(edge.bytesOffered).toBe(400);
    expect(edge.bytesDelivered).toBe(300);
  });
});

describe('Live Audience edge traffic frames', () => {
  it('reports active and idle measured windows from real offered work', () => {
    const normal = normalCase(directGraph());
    const frames = normal.trafficFrames;
    expect(frames).toHaveLength(MEASURED_MS / 1_000 + 1);

    const measured = frames.filter((frame) => frame.phase === 'measured');
    expect(measured.map((frame) => frame.timeMs)).toEqual([
      1_000,
      2_000,
      3_000,
      4_000,
    ]);
    expect(measured.every((frame) => frame.windowMs === 1_000)).toBe(true);

    const active = frames[0];
    if (active === undefined) {
      throw new Error('missing first frame');
    }
    expect(active.phase).toBe('measured');
    expect(
      active.edges.reduce((sum, edge) => sum + edge.requestsPerSecond, 0),
    ).toBeGreaterThan(0);

    for (const idle of frames.slice(1, 4)) {
      expect(idle.timeMs).toBeGreaterThanOrEqual(2_000);
      for (const edge of idle.edges) {
        expect(edge.requestsPerSecond).toBe(0);
        expect(edge.bytesPerSecond).toBe(0);
      }
    }

    for (const link of normal.links) {
      let requests = 0;
      let bytes = 0;
      for (const frame of frames) {
        const totals = frameTotals(frame, link.edgeId);
        requests += totals.requests;
        bytes += totals.bytes;
      }
      expect(requests).toBeCloseTo(link.requestsTotal, 6);
      expect(bytes).toBeCloseTo(link.bytesOffered, 6);
    }
  });

  it('exposes a strictly increasing, real final drain frame', () => {
    const normal = normalCase(loadBalancedGraph());
    const frames = normal.trafficFrames;
    expect(frames).toHaveLength(MEASURED_MS / 1_000 + 1);

    const times = frames.map((frame) => frame.timeMs);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]!).toBeGreaterThan(times[index - 1]!);
    }

    const drain = frames.at(-1);
    if (drain === undefined) {
      throw new Error('missing drain frame');
    }
    expect(drain.phase).toBe('drain');
    // The frame is reachable in timestamp replay and covers the real drain.
    expect(drain.timeMs).toBe(MEASURED_MS + DRAIN_MS);
    expect(drain.windowMs).toBe(DRAIN_MS);

    // Health probes are launched by the Load Balancer and may only traverse
    // LB -> Application. With clients idle during the drain, the Users -> LB
    // ingress link must stay at zero while the balance link shows the probes.
    expect(edgeRate(drain, 'users-lb')).toEqual({
      requestsPerSecond: 0,
      bytesPerSecond: 0,
    });
    expect(edgeRate(drain, 'app-sql')).toEqual({
      requestsPerSecond: 0,
      bytesPerSecond: 0,
    });
    // 10 s drain at a 250 ms probe interval: exactly 40 LB-local probes, so
    // the balance link reports 40 / 10 s = 4 req/s with zero probe payload.
    const balance = edgeRate(drain, 'lb-app');
    expect(balance.requestsPerSecond).toBeCloseTo(4, 10);
    expect(balance.bytesPerSecond).toBe(0);

    for (const frame of frames) {
      for (const edge of frame.edges) {
        expect(Number.isFinite(edge.requestsPerSecond)).toBe(true);
        expect(edge.requestsPerSecond).toBeGreaterThanOrEqual(0);
        expect(edge.bytesPerSecond).not.toBeNull();
        expect(Number.isFinite(edge.bytesPerSecond)).toBe(true);
        expect(edge.bytesPerSecond!).toBeGreaterThanOrEqual(0);
      }
    }

    for (const link of normal.links) {
      let requests = 0;
      let bytes = 0;
      for (const frame of frames) {
        const totals = frameTotals(frame, link.edgeId);
        requests += totals.requests;
        bytes += totals.bytes;
      }
      expect(requests).toBeCloseTo(link.requestsTotal, 6);
      expect(bytes).toBeCloseTo(link.bytesOffered, 6);

      // A peak is the maximum observed window rate. Every frame uses the same
      // real window, so the metric and the frames must agree.
      const rates = frames.map((frame) => edgeRate(frame, link.edgeId));
      const maxRequests = Math.max(
        ...rates.map((rate) => rate.requestsPerSecond),
      );
      const maxBytes = Math.max(...rates.map((rate) => rate.bytesPerSecond));
      expect(link.peakRequestsPerSecond + 1e-9).toBeGreaterThanOrEqual(
        maxRequests,
      );
      expect(link.peakBytesPerSecond + 1e-9).toBeGreaterThanOrEqual(maxBytes);
      expect(link.peakRequestsPerSecond).toBeCloseTo(maxRequests, 6);
      expect(link.peakBytesPerSecond).toBeCloseTo(maxBytes, 6);
    }
  });
});
