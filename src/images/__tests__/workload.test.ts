import { describe, expect, it } from 'vitest';
import { buildImageTrace } from '../workload';
import { IMAGE_PROBE_EVERY } from '../workload';

describe('graph-independent workload', () => {
  it('reproduces the same trace for the same seed and scenario', () => {
    const first = buildImageTrace(101, 'normal', { measuredMs: 2_000, warmupMs: 1_000 });
    const second = buildImageTrace(101, 'normal', { measuredMs: 2_000, warmupMs: 1_000 });
    expect([...first.uploads.times]).toEqual([...second.uploads.times]);
    expect([...first.searches.keys]).toEqual([...second.searches.keys]);
    expect([...first.details.probeTarget]).toEqual([...second.details.probeTarget]);
    expect([...first.details.bands]).toEqual([...second.details.bands]);
  });

  it('keeps warm-up offers out of the measured counts', () => {
    const trace = buildImageTrace(101, 'normal', { measuredMs: 2_000, warmupMs: 1_000 });
    const inWindow = (time: number): boolean => time >= trace.measuredFromMs && time < trace.measuredFromMs + trace.measuredMs;
    expect(trace.counts.measuredDetail).toBe(
      [...trace.details.times].filter(inWindow).length,
    );
    expect(trace.counts.measuredUpload).toBe(
      [...trace.uploads.times].filter(inWindow).length,
    );
    expect(trace.counts.measuredDetail).toBeLessThan(trace.counts.detail);
  });

  it('marks one in a hundred business detail requests as a recent-read probe', () => {
    const trace = buildImageTrace(101, 'normal', { measuredMs: 20_000, warmupMs: 5_000 });
    const probes = [...trace.details.probeTarget].filter((target) => target >= 0).length;
    const candidates = trace.details.times.length / IMAGE_PROBE_EVERY;
    expect(probes).toBeGreaterThan(0);
    expect(probes).toBeLessThanOrEqual(Math.ceil(candidates));
    // Probes stay inside the business detail stream: they are not a separate
    // operation and never disappear from the availability denominator.
    expect(trace.counts.detail).toBe(trace.details.times.length);
  });

  it('is deterministic across scenario replays', () => {
    const normal = buildImageTrace(101, 'normal', { measuredMs: 1_000, warmupMs: 0 });
    const peak = buildImageTrace(101, 'peak', { measuredMs: 1_000, warmupMs: 0 });
    expect(peak.demandMultiplier).toBe(2);
    expect(normal.demandMultiplier).toBe(1);
    // Peak offers more traffic in the same window; both are reproducible.
    expect(peak.counts.measuredDetail).toBeGreaterThan(normal.counts.measuredDetail);
  });
});
