import { describe, expect, it } from 'vitest';

import { createSimulation, createSimulationFromTrace } from '../index';
import { DEFAULT_LEVEL } from '../../domain/level';
import type { TrafficFrame } from '../../simulation/traffic-telemetry';
import {
  makeTrace,
  offered,
  runTrace,
  testGraph,
  testLevel,
} from './helpers';

function runCold(
  level: ReturnType<typeof testLevel>,
  graph = testGraph(),
  collect?: (frame: TrafficFrame) => void,
) {
  const engine = createSimulation(graph, level, 101);
  const end = level.durationMs + level.drainMs;
  const start = -level.warmupMs;
  const step = 1000;
  let time = start;
  while (time < end) {
    time = Math.min(end, time + step);
    engine.advance(time);
    if (collect) {
      const frame = engine.trafficFrame(time);
      if (frame) {
        collect(frame);
      }
    }
  }
  return engine.result();
}

function dispatchTotal(frames: readonly TrafficFrame[], edgeId: string): number {
  return frames.reduce((total, frame) => {
    const edge = frame.edges.find((item) => item.edgeId === edgeId);
    return total + (edge ? (edge.requestsPerSecond * frame.windowMs) / 1000 : 0);
  }, 0);
}

describe('Cold Cache observational traffic', () => {
  it('emits bounded, monotonic frames without changing the run result', () => {
    const frames: TrafficFrame[] = [];
    const withObserver = runCold(DEFAULT_LEVEL, testGraph(), (frame) =>
      frames.push(frame),
    );
    const withoutObserver = runCold(DEFAULT_LEVEL, testGraph());

    expect(withObserver).toEqual(withoutObserver);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(240);
    expect(frames.every((frame) => frame.scopeId === 'cold-cache')).toBe(true);

    let previous = -Infinity;
    const nodeIds = testGraph().nodes.map((node) => node.id).sort();
    const edgeIds = testGraph().edges.map((edge) => edge.id).sort();
    for (const frame of frames) {
      expect(frame.timeMs).toBeGreaterThan(previous);
      previous = frame.timeMs;
      expect(frame.windowMs).toBeGreaterThan(0);
      expect(frame.nodes.map((node) => node.nodeId).sort()).toEqual(nodeIds);
      expect(frame.edges.map((edge) => edge.edgeId).sort()).toEqual(edgeIds);
      for (const edge of frame.edges) {
        expect(Number.isFinite(edge.requestsPerSecond)).toBe(true);
        expect(edge.requestsPerSecond).toBeGreaterThanOrEqual(0);
      }
      for (const node of frame.nodes) {
        expect(Number.isFinite(node.requestsPerSecond ?? 0)).toBe(true);
        for (const resource of node.resources) {
          expect(resource.used === null || Number.isFinite(resource.used)).toBe(
            true,
          );
          expect(resource.aggregation).toBe('window-average');
        }
      }
    }
    expect(frames[0]?.phase).toBe('warmup');
    expect(frames.some((frame) => frame.phase === 'measured')).toBe(true);
    expect(frames.some((frame) => frame.phase === 'drain')).toBe(true);
  }, 60_000);

  it('counts actual cache dispatches per route: hits never traverse the miss edge', () => {
    const level = testLevel({
      durationMs: 3000,
      warmupMs: 0,
      drainMs: 800,
      flushAtMs: null,
    });
    const graph = testGraph();
    const requests = [
      offered('read', 0, 100, 7),
      offered('read', 1, 900, 7),
    ];
    const engine = createSimulationFromTrace(
      graph,
      level,
      makeTrace(requests, 101),
    );
    const frames: TrafficFrame[] = [];
    const end = level.durationMs + level.drainMs;
    for (let time = 0; time <= end; time += 100) {
      const next = Math.min(end, time + 100);
      engine.advance(next);
      if (next % 1000 === 0 || next === end) {
        const frame = engine.trafficFrame(next);
        if (frame) {
          frames.push(frame);
        }
      }
    }
    const result = engine.result();
    const cacheMetric = result.snapshot.nodes.find(
      (node) => node.nodeId === 'cache-1',
    );
    expect(cacheMetric?.hits).toBe(1);
    expect(cacheMetric?.misses).toBe(1);

    // Two reads traverse app -> cache, but only the miss fetches the database.
    expect(dispatchTotal(frames, 'e-app-1-read')).toBe(2);
    expect(dispatchTotal(frames, 'e-cache-db')).toBe(1);
    expect(dispatchTotal(frames, 'e-app-1-write')).toBe(0);
  }, 30_000);

  it('keeps the same trace result with and without observer reads', () => {
    const level = testLevel({
      durationMs: 2000,
      warmupMs: 500,
      drainMs: 800,
      flushAtMs: null,
    });
    const requests = [offered('read', 0, 100, 1), offered('read', 1, 1200, 1)];
    const observed = createSimulationFromTrace(
      testGraph(),
      level,
      makeTrace(requests, 101),
    );
    let total = 0;
    let cursor = -level.warmupMs;
    const final = level.durationMs + level.drainMs;
    while (cursor < final) {
      cursor = Math.min(final, cursor + 250);
      observed.advance(cursor);
      total += observed.trafficFrame(cursor) ? 1 : 0;
    }
    expect(total).toBeGreaterThan(0);
    const plain = runTrace(testGraph(), level, requests, 101, 0);
    expect(observed.result()).toEqual(plain.result());
  }, 30_000);
});
