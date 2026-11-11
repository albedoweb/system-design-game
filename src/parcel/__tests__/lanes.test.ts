import { describe, expect, it } from 'vitest';
import { parseParcelGraph, type ParcelTrace } from '../index';
import { simulateParcelHorizon } from '../simulate';
import { fixture } from './helpers';

function oneReportTrace(): ParcelTrace {
  return {
    seed: 101,
    statusTimes: new Float64Array(),
    statusKeys: new Uint32Array(),
    historyTimes: new Float64Array(),
    historyKeys: new Uint32Array(),
    historyOld: new Uint8Array(),
    ingestTimes: new Float64Array(),
    ingestKeys: new Uint32Array(),
    reports: [{ timeMs: 1_000, warehouseId: 0 }],
    counts: {
      status: 0,
      history: 0,
      ingest: 0,
      report: 1,
      oldHistory: 0,
    },
  };
}

describe('per-lane resource release', () => {
  it('releases CPU early on an IO-bound report scan and never overcommits lanes', () => {
    const parsed = parseParcelGraph(fixture('family-sql-indexed'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const result = simulateParcelHorizon(parsed.graph, 5, oneReportTrace());
    const store = result.nodes.find((node) => node.nodeId === 'sql-1');
    expect(store).toBeDefined();
    // A short CPU burst releases early; the scan keeps one of four IO lanes.
    expect(store!.averageIoUtilization).toBeGreaterThan(0.002);
    expect(store!.averageCpuUtilization).toBeLessThan(0.002);
    expect(store!.peakCpuUtilization).toBeGreaterThan(0.4);
    for (const node of result.nodes) {
      expect(node.peakCpuUtilization).toBeLessThanOrEqual(1);
      expect(node.peakIoUtilization).toBeLessThanOrEqual(1);
      expect(node.peakNetworkUtilization).toBeLessThanOrEqual(1);
      expect(node.averageCpuUtilization).toBeGreaterThanOrEqual(0);
      expect(node.averageIoUtilization).toBeGreaterThanOrEqual(0);
    }
    expect(result.operations.report.counts.offered).toBe(1);
  });

  it('keeps simultaneous release/completion ordering deterministic', () => {
    const parsed = parseParcelGraph(fixture('family-sql-indexed'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const first = simulateParcelHorizon(parsed.graph, 1, oneReportTrace());
    const second = simulateParcelHorizon(parsed.graph, 1, oneReportTrace());
    expect(JSON.stringify(second.nodes)).toBe(JSON.stringify(first.nodes));
    expect(JSON.stringify(second.operations)).toBe(
      JSON.stringify(first.operations),
    );
  });
});
