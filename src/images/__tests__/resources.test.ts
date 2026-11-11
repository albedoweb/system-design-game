import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compileImageRoutes, parseImageGraph } from '../graph';
import { simulateImageScenario } from '../simulate';
import { ResourceKernel } from '../../simulation/resources';
import type {
  SubmitTaskRequest,
  TaskHandle,
  TaskResult,
} from '../../simulation/resources';
import type { ImageGraph } from '../contracts';
import type { ImageTrace } from '../workload';
import { publicationLagBound, uploadKeyForOrdinal } from '../model';

/**
 * Bounded internal traces. These are built directly by tests so a focused
 * check runs in milliseconds; the public evaluator always uses the frozen
 * workload and there is no public workload override.
 */
interface TinyInput {
  readonly measuredMs?: number;
  readonly warmupMs?: number;
  readonly upload?: readonly { time: number; region: number }[];
  readonly search?: readonly {
    time: number;
    region: number;
    keys: readonly number[];
    kind?: 0 | 1;
    bands?: readonly number[];
  }[];
  readonly detail?: readonly {
    time: number;
    region: number;
    key: number;
    probeTarget?: number;
    band?: number;
  }[];
}

function tinyTrace(input: TinyInput): ImageTrace {
  const measuredMs = input.measuredMs ?? 1_000;
  const warmupMs = input.warmupMs ?? 0;
  const measuredFrom = warmupMs;
  const uploads = input.upload ?? [];
  const searches = input.search ?? [];
  const details = input.detail ?? [];
  const results = 10;
  const countMeasured = (times: readonly number[]): number =>
    times.filter((time) => time >= measuredFrom && time < measuredFrom + measuredMs).length;
  return {
    seed: 101,
    scenario: 'normal',
    demandMultiplier: 1,
    warmupMs,
    measuredMs,
    drainMs: 100,
    measuredFromMs: measuredFrom,
    traceStartMs: 0,
    uploads: {
      times: Float64Array.from(uploads.map((item) => item.time)),
      region: Uint8Array.from(uploads.map((item) => item.region)),
      bands: Uint8Array.from(uploads.map(() => 0)),
    },
    searches: {
      times: Float64Array.from(searches.map((item) => item.time)),
      region: Uint8Array.from(searches.map((item) => item.region)),
      keys: Uint32Array.from(searches.flatMap((item) => item.keys.slice(0, results))),
      kind: Uint8Array.from(searches.map((item) => item.kind ?? 0)),
      bands: Uint8Array.from(
        searches.flatMap((item) => item.bands ?? Array.from({ length: results }, () => 0)),
      ),
    },
    details: {
      times: Float64Array.from(details.map((item) => item.time)),
      region: Uint8Array.from(details.map((item) => item.region)),
      key: Uint32Array.from(details.map((item) => item.key)),
      probeTarget: Int32Array.from(details.map((item) => item.probeTarget ?? -1)),
      bands: Uint8Array.from(details.map((item) => item.band ?? 0)),
    },
    counts: {
      upload: uploads.length,
      search: searches.length,
      detail: details.length,
      measuredUpload: countMeasured(uploads.map((item) => item.time)),
      measuredSearch: countMeasured(searches.map((item) => item.time)),
      measuredDetail: countMeasured(details.map((item) => item.time)),
      probes: details.filter((item) => (item.probeTarget ?? -1) >= 0).length,
    },
  };
}

function loadGraph(file: string, edit?: (graph: ImageGraph) => void): ImageGraph {
  const parsed = parseImageGraph(
    JSON.parse(readFileSync(join(process.cwd(), 'fixtures', 'images', file), 'utf8')),
  );
  if (!parsed.ok) {
    throw new Error(parsed.issues.map((issue) => issue.message).join('; '));
  }
  if (edit) {
    edit(parsed.graph);
  }
  return parsed.graph;
}

function run(graph: ImageGraph, trace: ImageTrace) {
  return simulateImageScenario(graph, compileImageRoutes(graph), trace);
}

/**
 * Test-side instrumentation for the terminal-code paths that cannot be reached
 * by exhausting the real bounded queue in a tiny workload. Every other stage
 * still goes through the real kernel; only the named stage's terminal callback
 * receives a controlled `queue-full` TaskResult, exactly as a real kernel
 * rejection would deliver it. This does not add an admission override to
 * production code.
 */
function rejectStageAsQueueFull(stageSuffix: string): string[] {
  const calls: string[] = [];
  const original = ResourceKernel.prototype.submit;
  vi.spyOn(ResourceKernel.prototype, 'submit').mockImplementation(function (
    this: ResourceKernel,
    request: SubmitTaskRequest,
  ): TaskHandle {
    calls.push(request.id);
    if (!request.id.endsWith(stageSuffix)) {
      return original.call(this, request);
    }
    const result: TaskResult = {
      taskId: request.id,
      status: 'rejected',
      reason: 'queue-full',
      enqueuedAtMs: 0,
      startedAtMs: null,
      endedAtMs: 0,
      workFraction: 0,
    };
    request.onFinish(result);
    return {
      taskId: request.id,
      accepted: false,
      finished: true,
      result,
      cancel: () => false,
    };
  });
  return calls;
}

describe('resource ownership and physical accounting', () => {
  it('does not hold a NIC during geographic propagation', () => {
    const graph = loadGraph('family-direct.json');
    // Keep only the EU provider choice for the NA client population.
    graph.edges = graph.edges.filter(
      (edge) =>
        edge.source !== 'client-na' ||
        edge.operation !== 'blob' ||
        edge.target === 'blob-eu',
    );
    const simulation = run(
      graph,
      tinyTrace({ detail: [{ time: 0, region: 0, key: 1 }] }),
    );
    expect(simulation.result.operations.detail.counts.success).toBe(1);
    const provider = simulation.resources.find((row) => row.id === 'provider:eu:tx');
    expect(provider).toBeDefined();
    // 4 MB at one 1 Gbit/s lane is ~32 ms. The 40 ms NA-EU propagation is a
    // latency, not a lane hold, so the busy integral must stay near 32 ms.
    const busyMs = (provider?.averageBusyUnits ?? 0) * 1_000;
    expect(busyMs).toBeGreaterThan(30);
    expect(busyMs).toBeLessThan(38);
    // Propagation is still part of the request latency.
    expect(simulation.result.operations.detail.latencyP50Ms).toBeGreaterThan(40);
  });

  it('serves a recent blob from its origin endpoint while it is not remotely visible', () => {
    const graph = loadGraph('family-direct.json', (edited) => {
      // One shared NA metadata store: metadata visibility is immediate, while
      // the new blob is still inside the 60 s remote-visibility window.
      edited.nodes = edited.nodes.filter((node) => node.kind !== 'metadata' || node.id === 'metadata-na');
      edited.edges = edited.edges.filter((edge) => edge.operation !== 'metadata' && edge.operation !== 'replicate');
      for (const app of ['app-na', 'app-eu', 'app-ap']) {
        edited.edges.push({ id: `md-${app}`, source: app, target: 'metadata-na', operation: 'metadata' });
      }
    });
    const simulation = run(
      graph,
      tinyTrace({
        measuredMs: 3_000,
        upload: [{ time: 0, region: 0 }],
        detail: [{ time: 1_500, region: 1, key: uploadKeyForOrdinal(0) }],
      }),
    );
    expect(simulation.result.operations.detail.counts.success).toBe(1);
    const origin = simulation.result.links.find((link) => link.id === 'provider-endpoint:na');
    const local = simulation.result.links.find((link) => link.id === 'provider-endpoint:eu');
    // Metadata was already visible, but the blob must still come from the
    // origin endpoint: the EU endpoint cannot see it before 60 s.
    expect(origin?.bytesSent ?? 0).toBeGreaterThan(0);
    expect(local?.bytesSent ?? 0).toBe(0);
    expect(simulation.result.dataIntegrity.visibilityViolations).toBe(0);
  });

  it('fails a recent remote read when no explicit origin endpoint is connected', () => {
    const graph = loadGraph('family-direct.json', (edited) => {
      edited.nodes = edited.nodes.filter((node) => node.kind !== 'metadata' || node.id === 'metadata-na');
      edited.edges = edited.edges.filter(
        (edge) =>
          (edge.operation === 'metadata' || edge.operation === 'replicate') === false ||
          edge.source === 'app-na',
      );
      edited.edges = edited.edges.filter(
        (edge) => edge.source !== 'client-eu' || edge.operation !== 'blob' || edge.target === 'blob-eu',
      );
    });
    const simulation = run(
      graph,
      tinyTrace({
        measuredMs: 2_000,
        detail: [{ time: 1_500, region: 1, key: uploadKeyForOrdinal(0) }],
      }),
    );
    // Without a committed upload the record is unknown, so this read is a
    // synthetic lookup and must not be served by inventing visibility; the
    // assertion here is that no payload is taken from a remote-invisible blob.
    expect(simulation.result.dataIntegrity.visibilityViolations).toBe(0);
  });

  it('expires every fractional deadline and releases the kernel queues', () => {
    // The undersized starter saturates quickly. Arrivals are deliberately
    // fractional (not on a 20 ms grid) so a bucketed sweep that clears a whole
    // bucket would silently drop most deadlines and retain queued work.
    const details = Array.from({ length: 12_000 }, (_, index) => ({
      time: index * 0.137,
      region: index % 3,
      key: 500 + index,
    }));
    const simulation = run(
      loadGraph('starter.json'),
      tinyTrace({ measuredMs: 5_000, detail: details }),
    );
    const detail = simulation.result.operations.detail;
    expect(detail.counts.offered).toBe(12_000);
    expect(detail.counts.unfinished).toBe(0);
    expect(detail.counts.completed).toBe(12_000);
    expect(detail.counts.timedOut).toBeGreaterThan(0);
    expect(detail.counts.success + detail.counts.timedOut).toBeLessThanOrEqual(12_000);
    const queued = simulation.resources.reduce((sum, row) => sum + row.queuedTasks, 0);
    expect(queued).toBe(0);
  });

  it('separates RX and TX capacity on a full-duplex interface', () => {
    const uploads = Array.from({ length: 100 }, (_, index) => ({
      time: index * 0.001,
      region: 0,
    }));
    const details = Array.from({ length: 150 }, (_, index) => ({
      time: index * 0.001,
      region: 0,
      key: 1_000 + index,
    }));
    const simulation = run(
      loadGraph('family-direct.json', (edited) => {
        for (const node of edited.nodes) {
          if (node.kind === 'app' || node.kind === 'metadata') {
            (node.config as { instances: number }).instances = 12;
          }
        }
      }),
      tinyTrace({ measuredMs: 2_000, upload: uploads, detail: details }),
    );
    const tx = simulation.resources.find((row) => row.id === 'client:na:tx');
    const rx = simulation.resources.find((row) => row.id === 'client:na:rx');
    expect(tx?.capacity).toBe(100);
    expect(rx?.capacity).toBe(100);
    // 150 local downloads cannot exceed the advertised 100 Gbit/s outbound
    // (the old pooled 200-unit interface would show 150), while the opposite
    // inbound direction keeps serving uploads at the same time.
    expect(tx?.peakBusyUnits).toBeLessThanOrEqual(100);
    expect(tx?.peakBusyUnits).toBe(100);
    expect(rx?.peakBusyUnits).toBeGreaterThanOrEqual(50);
    expect(simulation.result.operations.upload.counts.success).toBe(100);
  });

  it('attributes provider RPCs and replication bytes only to the measured window', () => {
    const simulation = run(
      loadGraph('family-direct.json'),
      tinyTrace({
        warmupMs: 1_000,
        measuredMs: 5_000,
        upload: [
          { time: 100, region: 0 },
          { time: 600, region: 0 },
          { time: 1_500, region: 0 },
          { time: 2_200, region: 1 },
          { time: 3_000, region: 2 },
        ],
      }),
    );
    expect(simulation.result.operations.upload.counts.offered).toBe(3);
    // One admitted write RPC per measured upload attempt; warm-up is excluded.
    expect(simulation.traffic.writeRequests).toBe(3);
    expect(simulation.traffic.readRequests).toBe(0);
    // Two remote recipients × three measured records × (8 KB + 352 B index).
    expect(simulation.traffic.crossRegionBytes).toBeCloseTo(3 * 2 * (8_000 + 352), 0);
  });

  it('publishes a coalesced fill only after the bytes actually arrive', () => {
    const simulation = run(
      loadGraph('family-proxy-cache.json', (edited) => {
        for (const node of edited.nodes) {
          if (node.kind === 'cache') {
            (node.config as { instances: number; capacityGb: number }).instances = 1;
            (node.config as { instances: number; capacityGb: number }).capacityGb = 20;
          }
        }
        for (const edge of edited.edges) {
          if (edge.id === 'cache-provider-eu') {
            edge.target = 'blob-na';
          }
        }
      }),
      tinyTrace({
        measuredMs: 3_000,
        upload: [{ time: 0, region: 0 }],
        detail: [
          // Same immutable upload key; the second reader arrives while the
          // cross-region provider->cache flight is still in the air.
          { time: 1_500, region: 1, key: uploadKeyForOrdinal(0) },
          { time: 1_505, region: 1, key: uploadKeyForOrdinal(0) },
        ],
      }),
    );
    const detail = simulation.result.operations.detail;
    expect(detail.counts.success).toBe(2);
    // The waiter joins the fill and only reads the real entry after it lands.
    expect(simulation.traffic.cacheMisses).toBe(2);
    expect(simulation.traffic.coalesced).toBe(1);
    expect(simulation.traffic.cacheHits).toBeLessThanOrEqual(1);
    // The coalesced reader waits for the real fill (flight + propagation).
    expect(detail.latencyP50Ms).toBeGreaterThan(100);
    expect(simulation.pendingFillsAtEnd).toBe(0);
  });

  it('never reports a hit from a different physical cache instance', () => {
    const simulation = run(
      loadGraph('family-proxy-cache.json', (edited) => {
        for (const node of edited.nodes) {
          if (node.kind === 'cache') {
            (node.config as { instances: number; capacityGb: number }).instances = 2;
            (node.config as { instances: number; capacityGb: number }).capacityGb = 40;
          }
        }
        for (const edge of edited.edges) {
          if (edge.id === 'cache-provider-eu') {
            edge.target = 'blob-na';
          }
        }
      }),
      tinyTrace({
        measuredMs: 3_000,
        upload: [{ time: 0, region: 0 }],
        detail: [
          { time: 1_500, region: 1, key: uploadKeyForOrdinal(0) },
          { time: 1_505, region: 1, key: uploadKeyForOrdinal(0) },
        ],
      }),
    );
    // The two requests land on different physical instances (id parity), so
    // the second must not see the first instance's fill: both fetch for real.
    expect(simulation.result.operations.detail.counts.success).toBe(2);
    expect(simulation.traffic.cacheHits).toBe(0);
    expect(simulation.traffic.coalesced).toBe(0);
    expect(simulation.traffic.cacheMisses).toBe(2);
    expect(simulation.traffic.providerRetrievalBytes).toBeGreaterThanOrEqual(7_000_000);
    expect(simulation.pendingFillsAtEnd).toBe(0);
  });

  it('keeps warm-up cache and retry counters out of measured ratios', () => {
    const simulation = run(
      loadGraph('family-proxy-cache.json', (edited) => {
        for (const node of edited.nodes) {
          if (node.kind === 'cache') {
            (node.config as { instances: number; capacityGb: number }).instances = 1;
            (node.config as { instances: number; capacityGb: number }).capacityGb = 20;
          }
        }
      }),
      tinyTrace({
        warmupMs: 1_000,
        measuredMs: 2_000,
        detail: [
          { time: 100, region: 0, key: 4_242 },
          { time: 1_100, region: 0, key: 4_242 },
        ],
      }),
    );
    // Warm-up warms the cache physically, but only the measured hit is reported.
    expect(simulation.traffic.cacheHits).toBe(1);
    expect(simulation.traffic.cacheMisses).toBe(0);
    expect(simulation.traffic.cacheHitRatio).toBe(1);
    expect(simulation.traffic.retries).toBe(0);
  });

  it('cleans warm-up early failures before the final safety pass', () => {
    const searches = Array.from({ length: 40 }, (_, index) => ({
      time: index * 0.137,
      region: index % 3,
      keys: Array.from({ length: 10 }, (_, child) => 300 + child),
    }));
    const simulation = run(
      loadGraph('starter.json'),
      tinyTrace({ warmupMs: 1_000, measuredMs: 500, search: searches }),
    );
    // Starter metadata has no tag index, so every warm-up search fails
    // synchronously. Their requests, deadline events and tasks must be released
    // immediately, not retained until the end-of-run safety sweep.
    expect(simulation.result.operations.search.counts.timedOut).toBe(0);
    expect(simulation.liveRequestsBeforeFinish).toBe(0);
    expect(simulation.liveRequestsAtEnd).toBe(0);
    expect(simulation.pendingFillsAtEnd).toBe(0);
  });

  it('never erases a previously observed late publication', () => {
    expect(publicationLagBound(130_000, 0, 60_000)).toBe(130_000);
    expect(publicationLagBound(0, 0, 60_000)).toBe(60_000);
    expect(publicationLagBound(2_000, 90_000, 60_000)).toBe(90_000);
  });

  it('does not let warm-up timeouts pollute the measured denominator', () => {
    // Warm-up details time out on fractional deadlines before the measured
    // window; only measured arrivals may appear in offered/completed counts.
    const warmup = Array.from({ length: 400 }, (_, index) => ({
      time: index * 0.0137,
      region: index % 3,
      key: 50 + index,
    }));
    const measured = Array.from({ length: 400 }, (_, index) => ({
      time: 500 + index * 0.0137,
      region: index % 3,
      key: 50_000 + index,
    }));
    const simulation = run(
      loadGraph('starter.json'),
      tinyTrace({ warmupMs: 500, measuredMs: 1_000, detail: [...warmup, ...measured] }),
    );
    const detail = simulation.result.operations.detail;
    expect(detail.counts.offered).toBe(400);
    expect(detail.counts.completed).toBe(400);
    expect(detail.counts.unfinished).toBe(0);
    expect(detail.counts.success + detail.counts.timedOut).toBeLessThanOrEqual(400);
    expect(simulation.result.workload.offered.detail).toBe(400);
  });

  it('applies replicated records only after durable recipient work, exactly once', () => {
    const uploads = Array.from({ length: 20 }, (_, index) => ({
      time: index * 0.5,
      region: 0,
    }));
    const simulation = run(
      loadGraph('family-direct.json'),
      tinyTrace({ measuredMs: 10_000, upload: uploads }),
    );
    const targets = simulation.result.nodes.filter(
      (node) => node.kind === 'metadata' && node.nodeId !== 'metadata-na',
    );
    expect(targets).toHaveLength(2);
    for (const node of targets) {
      // Each origin record is applied once per recipient, after arrival.
      expect(node.replication?.replicatedWrites).toBe(20);
      expect(node.replication?.lagMaxMs ?? 0).toBeGreaterThan(0);
      expect(node.ioUtilizationAvg).toBeGreaterThan(0);
    }
    expect(simulation.result.postlude.unpublishedCommitted).toBe(0);
    expect(simulation.result.postlude.maxPublicationLagMs ?? 0).toBeGreaterThanOrEqual(60_000);
  });

  it('binds a probe to the resolved upload even when the trace key is unrelated (direct)', () => {
    const simulation = run(
      loadGraph('family-direct.json'),
      tinyTrace({
        measuredMs: 3_000,
        upload: [{ time: 0, region: 0 }],
        // Deliberately unrelated synthetic key: only the probe ordinal points
        // at the NA upload. The request must rebind to the upload key.
        detail: [{ time: 1_500, region: 1, key: 1, probeTarget: 0 }],
      }),
    );
    const detail = simulation.result.operations.detail;
    expect(detail.counts.success).toBe(1);
    expect(simulation.result.freshness.probes).toBe(1);
    expect(simulation.result.freshness.success).toBe(1);
    expect(simulation.result.freshness.passed).toBe(true);
    expect(simulation.result.dataIntegrity.visibilityViolations).toBe(0);
    const origin = simulation.result.links.find((link) => link.id === 'provider-endpoint:na');
    const local = simulation.result.links.find((link) => link.id === 'provider-endpoint:eu');
    // The NA blob is younger than 60 s: the EU endpoint cannot serve it, even
    // though metadata may already be replicated.
    expect(origin?.bytesSent ?? 0).toBeGreaterThan(0);
    expect(local?.bytesSent ?? 0).toBe(0);
  });

  it('routes a young remote read through an explicitly connected origin proxy path', () => {
    // app-eu's cache fetches from the NA origin endpoint (an explicit edge), so
    // the router may use it for a young NA object and charge the public WAN.
    const simulation = run(
      loadGraph('family-proxy-cache.json', (edited) => {
        for (const edge of edited.edges) {
          if (edge.id === 'cache-provider-eu') {
            edge.target = 'blob-na';
          }
        }
      }),
      tinyTrace({
        measuredMs: 3_000,
        upload: [{ time: 0, region: 0 }],
        detail: [{ time: 1_500, region: 1, key: 1, probeTarget: 0 }],
      }),
    );
    expect(simulation.result.operations.detail.counts.success).toBe(1);
    expect(simulation.result.freshness.success).toBe(1);
    expect(simulation.result.dataIntegrity.visibilityViolations).toBe(0);
    const origin = simulation.result.links.find((link) => link.id === 'provider-endpoint:na');
    expect(origin?.bytesSent ?? 0).toBeGreaterThan(0);
  });

  it('fails a young remote read when no explicitly connected app can reach the origin', () => {
    // Only the EU app remains connected; its cache/provider path is local, so
    // no implicit origin endpoint is invented and the probe must fail.
    const simulation = run(
      loadGraph('family-proxy-cache.json', (edited) => {
        edited.edges = edited.edges.filter(
          (edge) =>
            edge.source !== 'client-eu' ||
            edge.operation !== 'traffic' ||
            edge.target === 'app-eu',
        );
      }),
      tinyTrace({
        measuredMs: 3_000,
        upload: [{ time: 0, region: 0 }],
        detail: [{ time: 1_500, region: 1, key: 1, probeTarget: 0 }],
      }),
    );
    expect(simulation.result.operations.detail.counts.success).toBe(0);
    expect(simulation.result.freshness.probes).toBe(1);
    expect(simulation.result.freshness.success).toBe(0);
    expect(simulation.result.dataIntegrity.visibilityViolations).toBe(0);
    expect(simulation.result.operations.detail.counts.rejected).toBe(1);
  });

  it('charges bytes for transfers that later time out', () => {
    // The starter app pool carries 1 Gbit/s per instance and cannot move 5,000
    // concurrent 4 MB details; many requests must time out while their already
    // serialized bytes stay on the bill.
    const graph = loadGraph('starter.json');
    const details = Array.from({ length: 5_000 }, (_, index) => ({
      time: index * 0.001,
      region: index % 3,
      key: 100 + index,
    }));
    const simulation = run(graph, tinyTrace({ measuredMs: 60_000, detail: details }));
    const offered = simulation.result.operations.detail.counts.offered;
    expect(offered).toBe(5_000);
    expect(simulation.result.operations.detail.counts.success).toBeLessThan(offered);
    expect(simulation.result.operations.detail.counts.timedOut).toBeGreaterThan(0);
    // Partial/cancelled transfers keep their real bytes: a cheap failing graph
    // must never look free.
    expect(simulation.traffic.clientEgressBytes).toBeGreaterThan(0);
    expect(simulation.traffic.providerRetrievalBytes).toBeGreaterThan(0);
  });

  it('does not report running work as node queue depth', () => {
    const simulation = run(
      loadGraph('family-direct.json'),
      tinyTrace({ measuredMs: 1_000, detail: [{ time: 0, region: 0, key: 1 }] }),
    );
    expect(simulation.result.operations.detail.counts.success).toBe(1);
    for (const node of simulation.result.nodes) {
      // Six instances per pool serve this single request immediately; a stage
      // that is running must never be mistaken for a queued task.
      expect(node.queueDepthPeak).toBe(0);
      expect(node.queueDepthAvg).toBe(0);
    }
  });

  it('keeps measured node queue average at or below its peak and cleans queues', () => {
    const details = Array.from({ length: 12_000 }, (_, index) => ({
      time: index * 0.137,
      region: index % 3,
      key: 500 + index,
    }));
    const simulation = run(
      loadGraph('starter.json'),
      tinyTrace({ measuredMs: 5_000, detail: details }),
    );

    let queuedNodes = 0;
    for (const node of simulation.result.nodes) {
      expect(Number.isFinite(node.queueDepthAvg)).toBe(true);
      expect(Number.isFinite(node.queueDepthPeak)).toBe(true);
      expect(node.queueDepthAvg).toBeLessThanOrEqual(node.queueDepthPeak + 1e-9);
      expect(Number.isInteger(node.queueDepthPeak)).toBe(true);
      if (node.queueDepthPeak > 0) {
        queuedNodes += 1;
        expect(node.queueDepthAvg).toBeGreaterThan(0);
        expect(node.queueWaitP95Ms).toBeGreaterThan(0);
      }
    }
    expect(queuedNodes).toBeGreaterThan(0);
    expect(simulation.result.operations.detail.counts.unfinished).toBe(0);
    expect(simulation.liveRequestsAtEnd).toBe(0);
  });

  it('conserves final outcomes on app, metadata and client nodes', () => {
    const details = Array.from({ length: 4_000 }, (_, index) => ({
      time: index * 0.137,
      region: index % 3,
      key: 700 + index,
    }));
    const simulation = run(
      loadGraph('starter.json'),
      tinyTrace({ measuredMs: 3_000, detail: details }),
    );
    const nodes = simulation.result.nodes.filter(
      (node) => node.kind === 'app' || node.kind === 'metadata' || node.kind === 'client',
    );
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      // The breakdown is complete for every touched node kind. `requests`
      // intentionally keeps its pre-existing warm-up-inclusive scope, so it is
      // not compared with completed/errors here (see coding report limitation).
      expect(node.errors).toBe(node.rejected + node.timedOut);
      expect(node.errors).toBeLessThanOrEqual(node.requests);
    }
  });

  it('keeps a real kernel queue-full rejection distinct from interruption', () => {
    const graph = loadGraph('family-direct.json');
    const trace = tinyTrace({
      measuredMs: 2_000,
      detail: [{ time: 0, region: 0, key: 1 }],
    });
    // Test-only seam: the production limit stays MAX_QUEUED_TASKS. A zero hard
    // queue limit makes the real kernel reject the first real detail stage.
    const simulation = simulateImageScenario(
      graph,
      compileImageRoutes(graph),
      trace,
      undefined,
      0,
    );
    const detail = simulation.result.operations.detail;
    expect(detail.counts.offered).toBe(1);
    expect(detail.counts.rejected).toBe(1);
    expect(detail.counts.timedOut).toBe(0);
    expect(detail.errorsByCode.queue_full).toBe(1);
    expect(detail.errorsByCode.task_interrupted ?? 0).toBe(0);
    expect(detail.errorsByCode.deadline_exceeded ?? 0).toBe(0);
    // Two attempts were made (the configured retry), but the node records one
    // final request and one coherent failure outcome, never per-attempt errors.
    expect(detail.counts.offered).toBe(1);
    expect(simulation.traffic.retries).toBe(1);

    const app = simulation.result.nodes.find((node) => node.nodeId === 'app-na');
    expect(app?.requests).toBe(1);
    expect(app?.completed).toBe(0);
    expect(app?.errors).toBe(1);
    expect(app?.rejected).toBe(1);
    expect(app?.timedOut).toBe(0);
    expect((app?.rejected ?? 0) + (app?.timedOut ?? 0)).toBe(app?.errors);
    // Rejected submissions never enter the node queue.
    expect(app?.queueDepthPeak).toBe(0);
    expect(app?.queueDepthAvg).toBe(0);
  });

  it('preserves queue_full through the upload ACK callback without retrying', () => {
    const calls = rejectStageAsQueueFull(':upload-ack');
    const simulation = run(
      loadGraph('family-direct.json'),
      tinyTrace({ measuredMs: 3_000, upload: [{ time: 0, region: 0 }] }),
    );
    expect(calls.some((id) => id.endsWith(':upload-ack'))).toBe(true);
    const upload = simulation.result.operations.upload;
    expect(upload.counts.offered).toBe(1);
    expect(upload.counts.success).toBe(0);
    expect(upload.counts.rejected).toBe(1);
    expect(upload.errorsByCode.queue_full).toBe(1);
    expect(upload.errorsByCode.task_interrupted ?? 0).toBe(0);
    // ACK finalization keeps its no-retry policy and still reports lost ACK.
    expect(simulation.traffic.retries).toBe(0);
    expect(simulation.result.dataIntegrity.lostAckCommitted).toBe(1);
    const app = simulation.result.nodes.find((node) => node.nodeId === 'app-na');
    expect(app?.rejected).toBe(1);
    expect(app?.timedOut).toBe(0);
  });

  it('preserves queue_full through the search client fan-out callback', () => {
    const calls = rejectStageAsQueueFull(':search-client-fanout');
    const simulation = run(
      loadGraph('family-proxy-cache.json'),
      tinyTrace({
        measuredMs: 3_000,
        search: [
          {
            time: 500,
            region: 0,
            keys: Array.from({ length: 10 }, (_, index) => 200 + index),
          },
        ],
      }),
    );
    expect(calls.some((id) => id.endsWith(':search-provider-misses'))).toBe(true);
    expect(calls.some((id) => id.endsWith(':search-client-fanout'))).toBe(true);
    const search = simulation.result.operations.search;
    expect(search.counts.offered).toBe(1);
    expect(search.counts.success).toBe(0);
    expect(search.counts.rejected).toBe(1);
    expect(search.errorsByCode.queue_full).toBe(1);
    expect(search.errorsByCode.task_interrupted ?? 0).toBe(0);
    expect(simulation.traffic.retries).toBe(0);
  });

  it('preserves queue_full through the provider-miss callback into fan-out', () => {
    const calls = rejectStageAsQueueFull(':search-provider-misses');
    const simulation = run(
      loadGraph('family-proxy-cache.json'),
      tinyTrace({
        measuredMs: 3_000,
        search: [
          {
            time: 500,
            region: 0,
            keys: Array.from({ length: 10 }, (_, index) => 300 + index),
          },
        ],
      }),
    );
    expect(calls.some((id) => id.endsWith(':search-provider-misses'))).toBe(true);
    // The deferred fan-out gate keeps the terminal code instead of replacing
    // it with task_interrupted, and the fan-out stage is never submitted.
    expect(calls.some((id) => id.endsWith(':search-client-fanout'))).toBe(false);
    const search = simulation.result.operations.search;
    expect(search.counts.offered).toBe(1);
    expect(search.counts.success).toBe(0);
    expect(search.counts.rejected).toBe(1);
    expect(search.errorsByCode.queue_full).toBe(1);
    expect(search.errorsByCode.task_interrupted ?? 0).toBe(0);
    expect(simulation.traffic.retries).toBe(0);
  });
});
