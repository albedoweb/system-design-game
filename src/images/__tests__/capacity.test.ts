import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IMAGE_CATALOG,
  IMAGE_LEVEL,
  estimateImageCapacity,
  parseImageGraph,
  validateImageGraph,
  type ImageGraph,
} from '../index';

interface MutableNode {
  id: string;
  kind: string;
  region: string;
  config: Record<string, unknown>;
}

interface MutableGraph {
  nodes: MutableNode[];
  edges: { id: string; source: string; target: string; operation: string }[];
}

function fixture(name: string): unknown {
  const path = resolve(process.cwd(), 'fixtures', 'images', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function parsed(name: string): ImageGraph {
  const result = parseImageGraph(fixture(name));
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`fixture ${name} did not parse`);
  }
  return result.graph;
}

function clone(graph: ImageGraph): MutableGraph {
  return JSON.parse(JSON.stringify(graph)) as MutableGraph;
}

function node(graph: MutableGraph, id: string): MutableNode {
  const found = graph.nodes.find((item) => item.id === id);
  if (!found) {
    throw new Error(`missing node ${id}`);
  }
  return found;
}

describe('Image Atlas mature dataset and metadata redundancy', () => {
  it('uses the exact day-30 counts from the frozen scenario', () => {
    const estimate = estimateImageCapacity(parsed('starter'));
    const dataset = estimate.capacity.dataset;
    expect(dataset.images).toBe(1_500_000_000);
    expect(dataset.originalBytes).toBe(6e15);
    expect(dataset.originalTb).toBe(6_000);
    expect(dataset.metadataBaseBytes).toBe(12e12);
    expect(dataset.metadataBaseTb).toBe(12);
    expect(dataset.thumbnailIfMaterializedTb).toBe(384);
    expect(dataset.materializedThumbnails).toBe(false);
    expect(estimate.capacity.provider.storedOriginalTb).toBe(6_000);
    expect(estimate.capacity.provider.materializedThumbnailTb).toBe(0);
    expect(estimate.capacity.provider.fixedMonthlyUsd).toBe(36_000);
    expect(estimate.capacity.retentionOk).toBe(true);
  });

  it('charges explicit user and user-tag index bytes on every metadata copy', () => {
    expect(IMAGE_CATALOG.metadata.indexBytesPerObject).toEqual({
      none: 0,
      user: 64,
      'user-tag': 352,
    });
    expect(
      IMAGE_CATALOG.metadata.userIndexBytesPerObject +
        IMAGE_CATALOG.metadata.tagPostingBytes *
          IMAGE_CATALOG.metadata.tagsPerImage,
    ).toBe(IMAGE_CATALOG.metadata.userTagIndexBytesPerObject);

    const starter = estimateImageCapacity(parsed('starter'));
    const none = starter.capacity.metadataNodes.find(
      (item) => item.nodeId === 'metadata-na',
    );
    expect(none?.serviceIndexTb).toBe(0);

    const indexed = estimateImageCapacity(parsed('directory-direct'));
    const home = indexed.capacity.metadataNodes.find(
      (item) => item.nodeId === 'metadata-na',
    );
    expect(home?.index).toBe('user-tag');
    expect(home?.serviceIndexTb).toBeCloseTo(0.528, 6);
    expect(home?.serviceDataTb).toBeCloseTo(12.528, 6);
    expect(
      indexed.capacity.metadataNodes.every(
        (item) => item.index === 'user-tag' && item.serviceIndexTb > 0,
      ),
    ).toBe(true);
  });

  it('applies shardCount, replicas, logical capacity and physical copies once', () => {
    const estimate = estimateImageCapacity(parsed('directory-direct'));
    const home = estimate.capacity.metadataNodes.find(
      (item) => item.nodeId === 'metadata-na',
    );
    expect(home).toBeDefined();
    expect(home?.instances).toBe(6);
    expect(home?.replicas).toBe(2);
    expect(home?.shardCount).toBe(3);
    expect(home?.logicalCapacityTb).toBe(24);
    expect(home?.provisionedDiskTb).toBe(48);
    expect(home?.physicalDataTb).toBeCloseTo(12.528 * 2, 6);
    expect(home?.serviceDataTb).toBeCloseTo(12.528, 6);
    expect(home?.utilizationLogical).toBeCloseTo(12.528 / 24, 6);
    expect(home?.capacityOk).toBe(true);

    const eu = estimate.capacity.metadataNodes.find(
      (item) => item.nodeId === 'metadata-eu',
    );
    expect(eu?.shardCount).toBe(2);
    expect(eu?.logicalCapacityTb).toBe(16);
    expect(eu?.provisionedDiskTb).toBe(32);
    expect(eu?.roles).toEqual(['origin', 'replica']);
    expect(eu?.appIds).toEqual(['app-eu']);
    expect(eu?.replicationSources.sort()).toEqual([
      'metadata-ap',
      'metadata-na',
    ]);

    expect(estimate.capacity.metadataLocalCopies).toBe(6);
    expect(estimate.capacity.metadataPhysicalTb).toBeCloseTo(
      12.528 * 2 * 3,
      6,
    );
    expect(estimate.capacity.metadataProvisionedTb).toBe(48 + 32 + 32);
    expect(estimate.routes.metadataOrigins).toHaveLength(3);
    expect(estimate.routes.metadataReplication).toHaveLength(6);
    // Three regional origins do not multiply the fixed global original base.
    expect(estimate.capacity.provider.storedOriginalTb).toBe(6_000);
    expect(estimate.capacity.provider.fixedMonthlyUsd).toBe(36_000);
    expect(estimate.capacity.capacityOk).toBe(true);

    const incomplete = clone(parsed('directory-direct'));
    incomplete.edges = incomplete.edges.filter(
      (item) => item.id !== 'replicate-eu-ap',
    );
    const incompleteEstimate = estimateImageCapacity(
      incomplete as unknown as ImageGraph,
    );
    expect(incompleteEstimate.routes.valid).toBe(true);
    expect(incompleteEstimate.routes.metadataReplication).toHaveLength(5);
    expect(incompleteEstimate.capacity.metadataServiceTb).toBeCloseTo(
      12.528 * 3,
      6,
    );
    expect(incompleteEstimate.capacity.capacityOk).toBe(true);
  });

  it('flags undersized metadata without crashing a partial graph', () => {
    const fail = estimateImageCapacity(parsed('fail-storage'));
    expect(fail.capacity.capacityOk).toBe(false);
    expect(fail.issues.map((issue) => issue.code)).toContain(
      'metadata_capacity_exceeded',
    );

    const starter = estimateImageCapacity(parsed('starter'));
    expect(starter.capacity.capacityOk).toBe(false);
    expect(starter.capacity.metadataNodes[0]?.capacityOk).toBe(false);

    const partial = clone(parsed('starter'));
    partial.nodes = partial.nodes.filter(
      (item) => item.kind !== 'metadata',
    );
    const partialEstimate = estimateImageCapacity(
      partial as unknown as ImageGraph,
    );
    expect(partialEstimate.capacity.metadataNodes).toHaveLength(0);
    expect(partialEstimate.capacity.capacityOk).toBe(false);
    expect(partialEstimate.issues.map((issue) => issue.code)).toContain(
      'metadata_missing',
    );
  });

  it('reports fixed-node validation problems but still returns an estimate', () => {
    const invalid = parsed('fail-invalid-fixed-node');
    expect(validateImageGraph(invalid).length).toBeGreaterThan(0);
    const estimate = estimateImageCapacity(invalid);
    expect(estimate.capacity.dataset.images).toBe(1_500_000_000);
    expect(estimate.routes.valid).toBe(false);
    expect(
      estimate.issues.some((issue) => issue.code.startsWith('fixed_')),
    ).toBe(true);
  });
});

describe('Image Atlas cache and cost accounting', () => {
  it('bounds RAM and SSD cache capacity per instance', () => {
    const proxy = estimateImageCapacity(parsed('cache-proxy'));
    const cache = proxy.capacity.caches.find(
      (item) => item.nodeId === 'cache-na',
    );
    expect(cache).toBeDefined();
    expect(cache?.perInstanceCapacityGb).toBe(20);
    expect(cache?.limitGbPerInstance).toBe(22);
    expect(cache?.fits).toBe(true);
    expect(cache?.provisionedDiskTb).toBe(0);

    const tooLarge = clone(parsed('cache-proxy'));
    node(tooLarge, 'cache-na').config.capacityGb = 45;
    const tooLargeEstimate = estimateImageCapacity(
      tooLarge as unknown as ImageGraph,
    );
    expect(tooLargeEstimate.capacity.cacheCapacityOk).toBe(false);
    expect(tooLargeEstimate.issues.map((issue) => issue.code)).toContain(
      'cache_capacity_exceeded',
    );

    const ssd = clone(parsed('cache-proxy'));
    const ssdCache = node(ssd, 'cache-na');
    ssdCache.config = {
      medium: 'ssd',
      instances: 2,
      capacityGb: 4_000,
      fill: 'coalesce',
      diskTb: 2,
    };
    const ssdEstimate = estimateImageCapacity(ssd as unknown as ImageGraph);
    const ssdUsage = ssdEstimate.capacity.caches.find(
      (item) => item.nodeId === 'cache-na',
    );
    expect(ssdUsage?.limitGbPerInstance).toBe(2_000);
    expect(ssdUsage?.perInstanceCapacityGb).toBe(2_000);
    expect(ssdUsage?.fits).toBe(true);
    expect(ssdUsage?.provisionedDiskTb).toBe(4);
  });

  it('never bills cache or metadata RAM a second time', () => {
    const base = estimateImageCapacity(parsed('cache-proxy'));

    const smallerCache = clone(parsed('cache-proxy'));
    node(smallerCache, 'cache-na').config.capacityGb = 20;
    const smaller = estimateImageCapacity(
      smallerCache as unknown as ImageGraph,
    );
    expect(smaller.cost.monthlyUsd).toBeCloseTo(base.cost.monthlyUsd, 6);

    for (const nodeCost of base.cost.byNode) {
      expect(nodeCost.memoryMonthlyUsd).toBe(0);
      expect(nodeCost.memoryIncludedInCompute).toBe(true);
      expect(nodeCost.totalMonthlyUsd).toBeCloseTo(
        nodeCost.computeMonthlyUsd + nodeCost.extraDiskMonthlyUsd,
        6,
      );
    }
    const cacheCost = base.cost.byNode.find(
      (item) => item.nodeId === 'cache-na',
    );
    expect(cacheCost?.computeMonthlyUsd).toBeCloseTo(
      2 * IMAGE_CATALOG.prices.computeUsdPerInstanceHour * 730,
      6,
    );
    expect(cacheCost?.extraDiskMonthlyUsd).toBe(0);
    expect(
      base.cost.breakdown.some(
        (line) =>
          line.nodeId === 'cache-na' && line.category === 'storage',
      ),
    ).toBe(false);
  });

  it('charges extra metadata disk only above the included 2 TB tier', () => {
    const estimate = estimateImageCapacity(parsed('directory-direct'));
    const home = estimate.cost.byNode.find(
      (item) => item.nodeId === 'metadata-na',
    );
    expect(home?.extraDiskTbPerInstance).toBe(6);
    expect(home?.extraDiskMonthlyUsd).toBeCloseTo(6 * 6 * 6, 6);
    expect(home?.totalMonthlyUsd).toBeCloseTo(6 * 0.2 * 730 + 216, 6);
  });

  it('shows the fixed provider base, traffic baseline and budget separately', () => {
    const estimate = estimateImageCapacity(parsed('directory-direct'));
    expect(estimate.cost.fixed.providerOriginalsUsd).toBe(36_000);
    expect(estimate.cost.fixedMonthlyUsd).toBe(36_000);
    expect(estimate.cost.daily.clientEgressGb).toBeCloseTo(533_200, 3);
    expect(estimate.cost.daily.providerRetrievalGb).toBeCloseTo(528_000, 3);
    expect(estimate.cost.daily.readRequests).toBe(150_000_000);
    expect(estimate.cost.daily.writeRequests).toBe(50_000_000);
    expect(estimate.cost.traffic.clientEgressUsd).toBeCloseTo(
      533_200 * 30 * 0.006,
      6,
    );
    expect(estimate.cost.traffic.providerRetrievalUsd).toBeCloseTo(
      528_000 * 30 * 0.002,
      6,
    );
    expect(estimate.cost.api.readFeesUsd).toBeCloseTo(1_800, 6);
    expect(estimate.cost.api.writeFeesUsd).toBeCloseTo(7_500, 6);
    expect(estimate.cost.budgetMonthlyUsd).toBe(IMAGE_LEVEL.budget.monthlyUsd);
    expect(estimate.cost.withinBudget).toBe(estimate.cost.monthlyUsd <= 205_000);
    expect(estimate.cost.provenance.measured).toBe(false);
    expect(estimate.cost.provenance.workloadBasis).toBe('normal-daily-average');
    expect(
      estimate.cost.byNode.reduce(
        (sum, item) => sum + item.totalMonthlyUsd,
        0,
      ),
    ).toBeCloseTo(estimate.cost.controllableMonthlyUsd, 6);
    expect(
      estimate.cost.fixedMonthlyUsd +
        estimate.cost.controllableMonthlyUsd +
        estimate.cost.trafficMonthlyUsd +
        estimate.cost.apiMonthlyUsd,
    ).toBeCloseTo(estimate.cost.monthlyUsd, 6);
  });

  it('keeps the reference candidates labelled uncalibrated', () => {
    for (const name of ['directory-direct', 'cache-proxy'] as const) {
      const graph = parsed(name);
      expect(graph.name?.toLowerCase()).toContain('uncalibrated');
      expect(estimateImageCapacity(graph).capacity.capacityOk).toBe(true);
    }
    const starter = parsed('starter');
    expect(starter.name?.toLowerCase()).toContain('uncalibrated');
    expect(estimateImageCapacity(starter).capacity.capacityOk).toBe(false);
  });
});
