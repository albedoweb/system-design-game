import { describe, expect, it } from 'vitest';

import { evaluateParcel } from '../evaluate';
import { parseParcelGraph } from '../graph';
import type { TrafficFrame } from '../../simulation/traffic-telemetry';
import { fixture } from './helpers';

function dispatchTotal(frames: readonly TrafficFrame[], edgeId: string): number {
  return frames.reduce((total, frame) => {
    const edge = frame.edges.find((item) => item.edgeId === edgeId);
    return total + (edge ? (edge.requestsPerSecond * frame.windowMs) / 1000 : 0);
  }, 0);
}

describe('Parcel Pulse observational traffic', () => {
  it('keeps the evaluation deep-equal with and without the observer', () => {
    const graph = fixture('family-hybrid-analytics');
    const frames: TrafficFrame[] = [];
    const observed = evaluateParcel(graph, {
      seed: 101,
      horizons: [1],
      onTraffic: (frame) => frames.push(frame),
    });
    const plain = evaluateParcel(graph, { seed: 101, horizons: [1] });

    expect(observed).toEqual(plain);
    expect(observed.status).toBe('ok');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(240);
    expect(frames.every((frame) => frame.scopeId === 'year-1')).toBe(true);
    expect(frames.every((frame) => frame.scopeLabel === 'Year 1')).toBe(true);

    const parsed = parseParcelGraph(graph);
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
          expect(resource.used === null || Number.isFinite(resource.used)).toBe(
            true,
          );
          expect(['window-average', 'instant']).toContain(
            resource.aggregation,
          );
        }
      }
    }
  }, 120_000);

  it('attributes actual dispatches and leaves unused routes at zero', () => {
    const graph = fixture('family-hybrid-analytics');
    const frames: TrafficFrame[] = [];
    const result = evaluateParcel(graph, {
      seed: 101,
      horizons: [1],
      onTraffic: (frame) => frames.push(frame),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }

    // Client demand and every chosen business route were actually dispatched.
    expect(dispatchTotal(frames, 'edge-traffic')).toBeGreaterThan(0);
    expect(dispatchTotal(frames, 'edge-ingest')).toBeGreaterThan(0);
    expect(dispatchTotal(frames, 'edge-status')).toBeGreaterThan(0);
    expect(dispatchTotal(frames, 'edge-history')).toBeGreaterThan(0);
    expect(dispatchTotal(frames, 'edge-report')).toBeGreaterThan(0);
    // Replication is counted once per real flushed batch, never per record.
    const replicated = dispatchTotal(frames, 'edge-replicate');
    expect(replicated).toBeGreaterThan(0);
    expect(Number.isInteger(Math.round(replicated))).toBe(true);
    const batches = Math.round(replicated);
    expect(batches).toBeLessThan(
      result.horizons[0]?.operations.ingest.counts.success ?? 0,
    );
  }, 120_000);
});
