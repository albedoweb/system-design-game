import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileImageRoutes, parseImageGraph } from '../graph';
import { simulateImageScenario } from '../simulate';
import { metadataReadQuorum, metadataWriteQuorum, uploadKeyForOrdinal } from '../model';
import type { ImageGraph } from '../contracts';
import type { ImageTrace } from '../workload';

interface TinyInput {
  readonly measuredMs?: number;
  readonly detail?: readonly { time: number; region: number; key: number }[];
  readonly search?: readonly { time: number; region: number; keys: readonly number[] }[];
}

const RESULTS = 10;

function tinyTrace(input: TinyInput): ImageTrace {
  const measuredMs = input.measuredMs ?? 2_000;
  const details = input.detail ?? [];
  const searches = input.search ?? [];
  return {
    seed: 101,
    scenario: 'normal',
    demandMultiplier: 1,
    warmupMs: 0,
    measuredMs,
    drainMs: 100,
    measuredFromMs: 0,
    traceStartMs: 0,
    uploads: {
      times: new Float64Array(),
      region: new Uint8Array(),
      bands: new Uint8Array(),
    },
    searches: {
      times: Float64Array.from(searches.map((item) => item.time)),
      region: Uint8Array.from(searches.map((item) => item.region)),
      keys: Uint32Array.from(searches.flatMap((item) => item.keys.slice(0, RESULTS))),
      kind: Uint8Array.from(searches.map(() => 0)),
      bands: new Uint8Array(searches.length * RESULTS),
    },
    details: {
      times: Float64Array.from(details.map((item) => item.time)),
      region: Uint8Array.from(details.map((item) => item.region)),
      key: Uint32Array.from(details.map((item) => item.key)),
      probeTarget: new Int32Array(details.length).fill(-1),
      bands: new Uint8Array(details.length),
    },
    counts: {
      upload: 0,
      search: searches.length,
      detail: details.length,
      measuredUpload: 0,
      measuredSearch: searches.length,
      measuredDetail: details.length,
      probes: 0,
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

describe('metadata quorum', () => {
  it('uses a strict majority write quorum and an intersecting read quorum', () => {
    expect(metadataWriteQuorum(1)).toBe(1);
    expect(metadataWriteQuorum(2)).toBe(2);
    expect(metadataWriteQuorum(3)).toBe(2);
    expect(metadataWriteQuorum(4)).toBe(3);
    for (const replicas of [1, 2, 3, 4, 5]) {
      const write = metadataWriteQuorum(replicas);
      const read = metadataReadQuorum(replicas);
      expect(write + read).toBeGreaterThan(replicas);
      expect(write).toBeLessThanOrEqual(replicas);
      expect(read).toBeGreaterThanOrEqual(1);
    }
  });

  it('three copies tolerate one instance loss, two copies cannot', () => {
    expect(metadataWriteQuorum(3)).toBeLessThanOrEqual(2);
    expect(metadataReadQuorum(3)).toBeLessThanOrEqual(2);
    // N=2 needs both copies for a write: the mandatory one-instance-per-pool
    // fault would make that shard unable to commit, which is the intended
    // causal failure of a two-copy candidate.
    expect(metadataWriteQuorum(2)).toBe(2);
  });
});

describe('upload key namespace', () => {
  it('never aliases synthetic hot or long-tail keys', () => {
    const hot = 10_000;
    const tail = 1_000_000;
    expect(uploadKeyForOrdinal(0)).toBeGreaterThan(hot + tail);
    for (const ordinal of [0, 1, 10_500, 999_999, 1_000_000, 5_000_000]) {
      const key = uploadKeyForOrdinal(ordinal);
      expect(key).toBeGreaterThanOrEqual(hot + tail + 1);
      // The previous formula (hot + ordinal) collided with the long tail.
      if (ordinal < tail) {
        expect(key).not.toBe(hot + ordinal);
      }
    }
    expect(uploadKeyForOrdinal(0)).not.toBe(uploadKeyForOrdinal(1));
  });
});

describe('cache coalescing', () => {
  it('makes a coalesced reader wait for the real fill, not an instant hit', () => {
    const graph = loadGraph('family-proxy-cache.json', (edited) => {
      for (const node of edited.nodes) {
        if (node.kind === 'cache') {
          (node.config as { instances: number; capacityGb: number }).instances = 1;
          (node.config as { instances: number; capacityGb: number }).capacityGb = 20;
        }
      }
    });
    const simulation = run(
      graph,
      tinyTrace({
        detail: [
          { time: 0, region: 0, key: 4_242 },
          { time: 0.5, region: 0, key: 4_242 },
        ],
      }),
    );
    const detail = simulation.result.operations.detail;
    expect(detail.counts.success).toBe(2);
    // One provider fill, one coalesced waiter. A synthetic immediate hit would
    // finish with almost no latency and would not reach the provider at all.
    expect(simulation.traffic.cacheMisses).toBeGreaterThanOrEqual(1);
    expect(simulation.traffic.coalesced).toBe(1);
    // Exactly one provider fill (4 MB), not two.
    expect(simulation.traffic.providerRetrievalBytes).toBeGreaterThan(0);
    expect(simulation.traffic.providerRetrievalBytes).toBeLessThan(6_000_000);
    // A synthetic instant hit would finish far below the provider service start.
    expect(detail.latencyP50Ms).toBeGreaterThan(30);
  });

  it('counts provider request fees for every admitted read RPC', () => {
    const graph = loadGraph('family-proxy-cache.json');
    const simulation = run(
      graph,
      tinyTrace({
        search: [
          {
            time: 0,
            region: 0,
            keys: Array.from({ length: RESULTS }, (_, index) => 200 + index),
          },
        ],
      }),
    );
    expect(simulation.result.operations.search.counts.success).toBe(1);
    // Ten cache misses are ten admitted provider read RPCs, not one business
    // request. A cheap failing search fan-out must still be billed.
    expect(simulation.traffic.readRequests).toBe(RESULTS);
  });
});
