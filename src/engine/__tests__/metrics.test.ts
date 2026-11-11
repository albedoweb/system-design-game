import { describe, expect, it } from 'vitest';

import { Telemetry } from '../metrics';

/** DB queue peaks for bins [0,1000), [1000,2000), [2000,3000). */
function peaks(telemetry: Telemetry): number[] {
  return telemetry
    .series(3000)
    .slice(0, 3)
    .map((point) => point.dbQueue);
}

describe('dbQueue series bins', () => {
  it('carries depth through the part of a bin before the next observation', () => {
    const telemetry = new Telemetry(3000, 0);
    telemetry.recordDbQueue(0, 0);
    telemetry.recordDbQueue(9, 1);
    // Queue drops to zero at 1509, so [1000,1500) still had depth 1.
    telemetry.recordDbQueue(1509, 0);
    expect(peaks(telemetry)).toEqual([1, 1, 0]);
  });

  it('does not carry prior depth across a change exactly at the bin boundary', () => {
    const telemetry = new Telemetry(3000, 0);
    telemetry.recordDbQueue(0, 0);
    telemetry.recordDbQueue(9, 1);
    // The depth change at exactly 1000 belongs to the second bin only.
    telemetry.recordDbQueue(1000, 0);
    expect(peaks(telemetry)).toEqual([1, 0, 0]);
  });

  it('is idempotent under extra sync observations of the same depth', () => {
    const sparse = new Telemetry(3000, 0);
    sparse.recordDbQueue(0, 0);
    sparse.recordDbQueue(9, 1);
    sparse.recordDbQueue(1509, 0);

    const dense = new Telemetry(3000, 0);
    dense.recordDbQueue(0, 0);
    dense.recordDbQueue(9, 1);
    dense.recordDbQueue(500, 1);
    dense.recordDbQueue(1000, 1);
    dense.recordDbQueue(1200, 1);
    dense.recordDbQueue(1509, 0);

    expect(peaks(dense)).toEqual(peaks(sparse));
  });

  it('keeps the highest depth when a bin contains several levels', () => {
    const telemetry = new Telemetry(3000, 0);
    telemetry.recordDbQueue(0, 0);
    telemetry.recordDbQueue(500, 3);
    telemetry.recordDbQueue(1500, 1);
    telemetry.recordDbQueue(2500, 0);
    expect(peaks(telemetry)).toEqual([3, 3, 1]);
  });
});
