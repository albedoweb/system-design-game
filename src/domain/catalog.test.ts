import { describe, expect, it } from 'vitest';

import {
  CATALOG,
  INITIAL_GRAPH,
  NODE_KINDS,
  NODE_KIND_LABELS,
  calculateCost,
  calculateCostUsd,
  createInitialGraph,
  getCacheCapacityKiB,
  getCapacity,
  getSizeSpec,
  makeNode,
  microUsdToUsd,
  type GraphDocument,
} from './index';

function mustNode(graph: GraphDocument, id: string): GraphDocument['nodes'][number] {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node) {
    throw new Error(`node ${id} not found`);
  }
  return node;
}

describe('catalog', () => {
  it('publishes Russian labels and units for every kind', () => {
    expect(NODE_KINDS).toEqual([
      'client',
      'loadBalancer',
      'appServer',
      'cache',
      'database',
    ]);
    for (const kind of NODE_KINDS) {
      expect(CATALOG[kind].label).toBe(NODE_KIND_LABELS[kind]);
      expect(CATALOG[kind].label.length).toBeGreaterThan(0);
      expect(CATALOG[kind].description.length).toBeGreaterThan(0);
      for (const size of ['small', 'medium', 'large'] as const) {
        expect(getSizeSpec(kind, size).label.length).toBeGreaterThan(0);
      }
    }
  });

  it('exposes capacities and prices from LEVELS', () => {
    expect(getCapacity('appServer', 'small')).toBe(16);
    expect(getCapacity('appServer', 'medium')).toBe(32);
    expect(getCapacity('appServer', 'large')).toBe(64);
    expect(getCapacity('database', 'small')).toBe(4);
    expect(getCapacity('database', 'medium')).toBe(8);
    expect(getCapacity('database', 'large')).toBe(16);
    expect(getCapacity('cache', 'small')).toBe(128);
    expect(getCapacity('cache', 'medium')).toBe(512);
    expect(getCapacity('cache', 'large')).toBe(2048);
    expect(getCapacity('client', 'small')).toBeNull();
    expect(getCapacity('loadBalancer', 'large')).toBeNull();

    expect(getSizeSpec('appServer', 'small').priceMicroUsdPerHour).toBe(200_000);
    expect(getSizeSpec('appServer', 'medium').priceMicroUsdPerHour).toBe(400_000);
    expect(getSizeSpec('appServer', 'large').priceMicroUsdPerHour).toBe(800_000);
    expect(getSizeSpec('database', 'small').priceMicroUsdPerHour).toBe(2_000_000);
    expect(getSizeSpec('database', 'medium').priceMicroUsdPerHour).toBe(4_000_000);
    expect(getSizeSpec('database', 'large').priceMicroUsdPerHour).toBe(8_000_000);
    expect(getSizeSpec('cache', 'small').priceMicroUsdPerHour).toBe(200_000);
    expect(getSizeSpec('cache', 'medium').priceMicroUsdPerHour).toBe(400_000);
    expect(getSizeSpec('cache', 'large').priceMicroUsdPerHour).toBe(800_000);
    expect(getSizeSpec('loadBalancer', 'small').priceMicroUsdPerHour).toBe(100_000);
    expect(getSizeSpec('client', 'small').priceMicroUsdPerHour).toBe(0);
  });

  it('derives cache capacity in KiB', () => {
    expect(getCacheCapacityKiB('small')).toBe(1024);
    expect(getCacheCapacityKiB('medium')).toBe(4096);
    expect(getCacheCapacityKiB('large')).toBe(16_384);
  });
});

describe('calculateCost', () => {
  it('sums the starter graph without hidden surcharges', () => {
    expect(calculateCost(INITIAL_GRAPH)).toBe(2_600_000);
    expect(calculateCostUsd(INITIAL_GRAPH)).toBe(2.6);
    expect(microUsdToUsd(5_500_000)).toBe(5.5);
  });

  it('prices every node kind and size', () => {
    const graph = createInitialGraph();
    graph.nodes.push(
      makeNode('loadBalancer', 'lb-1', { x: 0, y: 0 }),
      makeNode('appServer', 'app-2', { x: 0, y: 0 }, { config: { size: 'large' } }),
      makeNode('database', 'db-2', { x: 0, y: 0 }, { config: { size: 'medium' } }),
      makeNode('cache', 'cache-2', { x: 0, y: 0 }, { config: { size: 'small' } }),
    );
    // 2.60 + LB 0.10 + large app 0.80 + medium DB 4.00 + small cache 0.20
    expect(calculateCost(graph)).toBe(7_700_000);
  });

  it('depends only on kind and size, not on inactive config fields', () => {
    const baseline = calculateCost(createInitialGraph());
    const changed = createInitialGraph();
    mustNode(changed, 'app-1').config.queueLimit = 0;
    mustNode(changed, 'app-1').config.poolSize = 64;
    mustNode(changed, 'cache-1').config.ttlSeconds = 15;
    mustNode(changed, 'cache-1').config.coalescing = true;
    expect(calculateCost(changed)).toBe(baseline);
  });
});
