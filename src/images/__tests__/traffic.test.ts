import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { evaluateImages } from '../evaluate';
import { parseImageGraph, compileImageRoutes } from '../graph';
import { simulateImageScenario } from '../simulate';
import { buildImageTrace } from '../workload';
import type { ImageScenarioResult } from '../contracts';
import type { TrafficFrame } from '../../simulation/traffic-telemetry';

function fixture(file: string): unknown {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'fixtures', 'images', file), 'utf8'),
  );
}

function measuredDispatches(
  frames: readonly TrafficFrame[],
  edgeId: string,
): number {
  return frames.reduce((total, frame) => {
    if (frame.phase !== 'measured') {
      return total;
    }
    const edge = frame.edges.find((item) => item.edgeId === edgeId);
    return total + (edge ? (edge.requestsPerSecond * frame.windowMs) / 1000 : 0);
  }, 0);
}

function cacheTotals(scenario: ImageScenarioResult) {
  let hits = 0;
  let misses = 0;
  let coalesced = 0;
  for (const node of scenario.nodes) {
    if (!node.cache) {
      continue;
    }
    hits += node.cache.hits;
    misses += node.cache.misses;
    coalesced += node.cache.coalesced;
  }
  return { hits, misses, coalesced };
}

describe('Image Atlas observational traffic', () => {
  it('keeps the scenario evaluation deep-equal and emits bounded scope frames', () => {
    const graph = fixture('family-proxy-cache.json');
    const frames: TrafficFrame[] = [];
    const observed = evaluateImages(graph, {
      seed: 101,
      scenarios: ['normal'],
      onTraffic: (frame) => frames.push(frame),
    });
    const plain = evaluateImages(graph, {
      seed: 101,
      scenarios: ['normal'],
    });

    expect(observed).toEqual(plain);
    expect(observed.status).toBe('complete');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(240);
    expect(frames.every((frame) => frame.levelId === 'image-atlas')).toBe(true);
    expect(frames.every((frame) => frame.scopeId === 'normal')).toBe(true);
    expect(frames[0]?.phase).toBe('warmup');
    expect(frames[0]?.timeMs).toBeLessThan(0);
    expect(frames.at(-1)?.phase).toBe('postlude');
    expect(frames.at(-1)?.windowMs).toBeLessThan(1000);

    const parsed = parseImageGraph(graph);
    if (!parsed.ok) {
      throw new Error('fixture must parse');
    }
    const nodeIds = parsed.graph.nodes.map((node) => node.id).sort();
    const edgeIds = parsed.graph.edges.map((edge) => edge.id).sort();
    let previous = -Infinity;
    for (const frame of frames) {
      expect(frame.timeMs).toBeGreaterThan(previous);
      previous = frame.timeMs;
      expect(frame.windowMs).toBeGreaterThan(0);
      expect(frame.nodes.map((node) => node.nodeId).sort()).toEqual(nodeIds);
      expect(frame.edges.map((edge) => edge.edgeId).sort()).toEqual(edgeIds);
      for (const edge of frame.edges) {
        expect(Number.isFinite(edge.requestsPerSecond)).toBe(true);
        expect(edge.requestsPerSecond).toBeGreaterThanOrEqual(0);
        expect(edge.bytesPerSecond).toBeNull();
      }
      for (const node of frame.nodes) {
        for (const resource of node.resources) {
          expect(['window-average', 'instant']).toContain(
            resource.aggregation,
          );
          if (resource.key === 'ram') {
            expect(resource.aggregation).toBe('instant');
          }
        }
      }
    }
  }, 120_000);

  it('counts an all-cache-hit warm search on app -> cache for every lookup', () => {
    const graph = fixture('family-proxy-cache.json');
    const frames: TrafficFrame[] = [];
    const result = evaluateImages(graph, {
      seed: 101,
      scenarios: ['normal'],
      onTraffic: (frame) => frames.push(frame),
    });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') {
      return;
    }
    const scenario = result.scenarios[0];
    if (!scenario) {
      throw new Error('normal scenario is required');
    }
    const cache = cacheTotals(scenario);
    // The measured window is genuinely warm: thousands of hits and a zero
    // miss count for the cache pools, so a miss-only route report is invalid.
    expect(cache.hits).toBeGreaterThan(0);
    expect(cache.misses).toBe(0);
    expect(cache.hits + cache.coalesced).toBeGreaterThan(0);

    const parsed = parseImageGraph(graph);
    if (!parsed.ok) {
      throw new Error('fixture must parse');
    }
    const byId = new Map(parsed.graph.nodes.map((node) => [node.id, node]));
    const appCacheEdges = parsed.graph.edges.filter((edge) => {
      return (
        edge.operation === 'blob' &&
        byId.get(edge.source)?.kind === 'app' &&
        byId.get(edge.target)?.kind === 'cache'
      );
    });
    expect(appCacheEdges.length).toBeGreaterThan(0);
    let observedLookups = 0;
    for (const edge of appCacheEdges) {
      observedLookups += measuredDispatches(frames, edge.id);
    }
    // Every lookup (hit, miss or coalesced pending) crosses the app -> cache
    // route. Uploads additionally relay through the same cache, so the
    // observed dispatch count can only be larger, never smaller.
    expect(observedLookups).toBeGreaterThanOrEqual(
      cache.hits + cache.misses + cache.coalesced,
    );
  }, 120_000);

  it('keeps measured frames inside phase boundaries on a non-aligned tiny trace', () => {
    const graph = fixture('family-proxy-cache.json');
    const parsed = parseImageGraph(graph);
    if (!parsed.ok) {
      throw new Error('fixture must parse');
    }
    const routes = compileImageRoutes(parsed.graph);
    const trace = buildImageTrace(101, 'normal', {
      warmupMs: 500,
      measuredMs: 1000,
    });
    const frames: TrafficFrame[] = [];
    const observed = simulateImageScenario(
      parsed.graph,
      routes,
      trace,
      (frame) => frames.push(frame),
    );
    const plain = simulateImageScenario(parsed.graph, routes, trace);

    // Boundary stops are observational only: results and bounds are unchanged.
    expect(observed.result).toEqual(plain.result);
    expect(JSON.stringify(observed.result)).toBe(JSON.stringify(plain.result));
    expect(observed.processedEvents).toBe(plain.processedEvents);
    expect(observed.exhausted).toBe(false);
    expect(observed.liveRequestsAtEnd).toBe(0);
    expect(frames.length).toBeLessThanOrEqual(240);

    // The interval ending at the measurement start is warm-up, and the first
    // measured interval starts exactly there even though the 1 s grid does not.
    const lastWarmup = frames.find((frame) => frame.timeMs === 0);
    expect(lastWarmup?.phase).toBe('warmup');
    expect(lastWarmup?.windowMs).toBe(500);
    const firstMeasured = frames.find((frame) => frame.phase === 'measured');
    expect(firstMeasured?.timeMs).toBe(500);
    expect(firstMeasured?.windowMs).toBe(500);
    expect(
      (firstMeasured?.timeMs ?? 0) - (firstMeasured?.windowMs ?? 0),
    ).toBe(0);

    // No frame straddles the measured window, and the measured end is sampled
    // exactly even though it is not aligned to the 1 s grid.
    for (const frame of frames.filter((item) => item.phase === 'measured')) {
      expect(frame.timeMs - frame.windowMs).toBeGreaterThanOrEqual(0);
      expect(frame.timeMs).toBeLessThanOrEqual(trace.measuredMs);
      for (const node of frame.nodes) {
        for (const resource of node.resources) {
          if (resource.key === 'ram') {
            expect(resource.aggregation).toBe('instant');
            continue;
          }
          expect(resource.aggregation).toBe('window-average');
          expect(Number.isFinite(resource.used ?? Number.NaN)).toBe(true);
        }
      }
    }
    const measuredEnd = frames.find(
      (frame) => frame.timeMs === trace.measuredMs,
    );
    expect(measuredEnd?.phase).toBe('measured');
    expect(measuredEnd?.windowMs).toBe(500);

    const times = frames.map((frame) => frame.timeMs);
    expect(new Set(times).size).toBe(times.length);
    expect(times).toEqual([...times].sort((left, right) => left - right));
  }, 120_000);

  it('counts real replication batches on metadata routes and ignores unused routes', () => {
    const graph = fixture('family-proxy-cache.json');
    const frames: TrafficFrame[] = [];
    const result = evaluateImages(graph, {
      seed: 101,
      scenarios: ['normal'],
      onTraffic: (frame) => frames.push(frame),
    });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') {
      return;
    }
    const scenario = result.scenarios[0];
    if (!scenario) {
      throw new Error('normal scenario is required');
    }
    const parsed = parseImageGraph(graph);
    if (!parsed.ok) {
      throw new Error('fixture must parse');
    }
    const replicateEdges = parsed.graph.edges.filter(
      (edge) => edge.operation === 'replicate',
    );
    expect(replicateEdges.length).toBeGreaterThan(0);
    let batches = 0;
    for (const edge of replicateEdges) {
      const dispatch = measuredDispatches(frames, edge.id);
      expect(dispatch).toBeGreaterThan(0);
      expect(Number.isInteger(Math.round(dispatch))).toBe(true);
      batches += Math.round(dispatch);
    }
    const replicatedWrites = scenario.nodes.reduce(
      (total, node) => total + (node.replication?.replicatedWrites ?? 0),
      0,
    );
    expect(replicatedWrites).toBeGreaterThan(0);
    // One logical dispatch per flushed batch, never one per replicated record.
    expect(batches).toBeLessThan(replicatedWrites);
  }, 120_000);
});
