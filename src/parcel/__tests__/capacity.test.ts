import { describe, expect, it } from 'vitest';
import {
  PARCEL_CATALOG,
  PARCEL_LEVEL,
  estimateParcelCapacity,
  parseParcelGraph,
} from '../index';
import { FAMILY_FIXTURES, fixture } from './helpers';

function parsed(name: string) {
  const result = parseParcelGraph(fixture(name));
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error('fixture did not parse');
  }
  return result.graph;
}

describe('analytical capacity and TCO', () => {
  it('shows the five-year raw event volume from the specification', () => {
    const year1 = estimateParcelCapacity(parsed('family-sql-indexed'), 1);
    const year5 = estimateParcelCapacity(parsed('family-sql-indexed'), 5);
    const year5Raw =
      PARCEL_LEVEL.workload.dailyParcels *
      PARCEL_LEVEL.workload.eventsPerParcel *
      PARCEL_LEVEL.workload.daysPerYear *
      5 *
      PARCEL_LEVEL.workload.eventBytes;
    expect(year5.capacity.rawEventBytes).toBeCloseTo(44.8512e12, 0);
    expect(year1.capacity.rawEventBytes).toBeCloseTo(8.97024e12, 0);
    expect(year5.capacity.totalUsedTb).toBeGreaterThan(
      year1.capacity.totalUsedTb,
    );
    expect(year5Raw).toBeCloseTo(44.8512e12, 0);
  });

  it('charges indexes, rollups, buckets and columnar clustering explicitly', () => {
    const sql = estimateParcelCapacity(parsed('family-sql-indexed'), 5);
    const rollups = estimateParcelCapacity(parsed('family-sql-rollups'), 5);
    const kv = estimateParcelCapacity(parsed('family-kv-rollups'), 5);
    const hybrid = estimateParcelCapacity(parsed('family-hybrid-analytics'), 5);
    expect(sql.capacity.indexBytes).toBeGreaterThan(0);
    expect(sql.capacity.rollupBytes).toBe(0);
    expect(rollups.capacity.rollupBytes).toBeGreaterThan(0);
    expect(kv.capacity.stores[0]!.bucketOverheadBytes).toBeGreaterThan(0);
    expect(hybrid.capacity.replicationFactor).toBe(2);
    expect(hybrid.capacity.stores.some((store) => store.kind === 'columnar'))
      .toBe(true);
    expect(
      hybrid.capacity.stores
        .filter((store) => store.kind === 'columnar')
        .some((store) => store.indexBytes > 0),
    ).toBe(true);
  });

  it('charges every paid node, including unused ones', () => {
    const overbudget = estimateParcelCapacity(parsed('fail-overbudget'), 5);
    expect(overbudget.cost.byNode.map((node) => node.nodeId)).toContain(
      'columnar-1',
    );
    expect(overbudget.cost.withinBudget).toBe(false);
    expect(overbudget.cost.monthlyUsd).toBeGreaterThan(
      PARCEL_LEVEL.budget.monthlyUsd,
    );
  });

  it('uses fixed provisioned capacity and 60 months for five-year TCO', () => {
    const estimate = estimateParcelCapacity(parsed('family-kv-rollups'), 5);
    expect(estimate.cost.computeHours).toBe(
      PARCEL_CATALOG.storage.billingHoursPerMonth *
        PARCEL_CATALOG.storage.tcoMonths,
    );
    expect(estimate.cost.fiveYearTcoUsd).toBeCloseTo(
      estimate.cost.monthlyUsd * 60,
      6,
    );
    expect(estimate.capacity.totalProvisionedTb).toBe(24);
    expect(estimate.capacity.retentionOk).toBe(true);
  });

  it('flags an undersized store and a retention shortfall', () => {
    const capacity = estimateParcelCapacity(parsed('fail-capacity'), 5);
    expect(capacity.capacity.capacityOk).toBe(false);
    expect(capacity.issues.map((issue) => issue.code)).toContain(
      'storage_capacity_exceeded',
    );
    const retention = estimateParcelCapacity(parsed('fail-missing-index'), 5);
    expect(retention.capacity.retentionOk).toBe(true);
    expect(capacity.capacity.stores[0]!.provisionedTb).toBe(1);
  });

  it('keeps every family inside the calibrated budget and reports different costs', () => {
    const costs = FAMILY_FIXTURES.map((name) => ({
      name,
      estimate: estimateParcelCapacity(parsed(name), 5),
    }));
    for (const { estimate } of costs) {
      expect(estimate.cost.withinBudget).toBe(true);
    }
    const distinct = new Set(
      costs.map(({ estimate }) => estimate.cost.monthlyUsd.toFixed(2)),
    );
    expect(distinct.size).toBeGreaterThan(1);
  });
});
