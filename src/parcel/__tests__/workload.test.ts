import { describe, expect, it } from 'vitest';
import { PARCEL_LEVEL } from '../level';
import { generateParcelTrace } from '../workload';

describe('frozen Parcel trace', () => {
  it('is deterministic and independent of the graph/horizon', () => {
    const first = generateParcelTrace(101);
    const second = generateParcelTrace(101);
    expect(second.counts).toEqual(first.counts);
    expect(Array.from(second.statusTimes)).toEqual(Array.from(first.statusTimes));
    expect(Array.from(second.historyTimes)).toEqual(
      Array.from(first.historyTimes),
    );

    const other = generateParcelTrace(211);
    // Same demand model, not the same Poisson sample: counts stay within a
    // small band while the actual arrivals differ.
    expect(
      Math.abs(other.counts.status - first.counts.status) / first.counts.status,
    ).toBeLessThan(0.05);
    expect(Array.from(other.statusTimes)).not.toEqual(
      Array.from(first.statusTimes),
    );
  });

  it('schedules exactly six reports at the declared times and warehouses', () => {
    const trace = generateParcelTrace(101);
    expect(trace.reports.map((report) => report.timeMs)).toEqual([
      10_000, 20_000, 25_000, 30_000, 35_000, 50_000,
    ]);
    expect(trace.reports.map((report) => report.warehouseId)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(trace.counts.report).toBe(6);
  });

  it('keeps the year-5 old-history cohort at every fifth request', () => {
    const trace = generateParcelTrace(101);
    const old = Array.from(trace.historyOld);
    expect(old.filter((value) => value === 1).length).toBe(
      Math.ceil(old.length / 5),
    );
    for (let index = 0; index < old.length; index += 1) {
      expect(old[index]).toBe(index % 5 === 0 ? 1 : 0);
    }
    expect(trace.counts.oldHistory).toBeGreaterThan(0);
    expect(trace.counts.oldHistory).toBeLessThan(trace.counts.history);
  });

  it('keeps the full 60 second phase shape without thinning', () => {
    const trace = generateParcelTrace(101);
    expect(trace.counts.status).toBeGreaterThan(250_000);
    expect(trace.counts.history).toBeGreaterThan(10_000);
    expect(trace.counts.ingest).toBeGreaterThan(100_000);
    expect(trace.statusTimes[trace.statusTimes.length - 1]).toBeLessThanOrEqual(
      PARCEL_LEVEL.durationMs,
    );
  });
});
