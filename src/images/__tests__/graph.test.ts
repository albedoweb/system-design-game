import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IMAGE_FIXED_CLIENTS,
  IMAGE_FIXED_PROVIDERS,
  IMAGE_REGIONS,
  compileImageRoutes,
  createImageGraph,
  imageGraphDigest,
  parseImageGraph,
  validateImageGraph,
  type ImageGraph,
} from '../index';

interface MutableNode {
  id: string;
  kind: string;
  label: string;
  region: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

interface MutableEdge {
  id: string;
  source: string;
  target: string;
  operation: string;
}

interface MutableGraph {
  schemaVersion: number;
  levelId: string;
  modelVersion: string;
  name?: string;
  nodes: MutableNode[];
  edges: MutableEdge[];
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

function codes(graph: MutableGraph): string[] {
  return validateImageGraph(graph as unknown as ImageGraph).map(
    (issue) => issue.code,
  );
}

function node(graph: MutableGraph, id: string): MutableNode {
  const found = graph.nodes.find((item) => item.id === id);
  if (!found) {
    throw new Error(`missing node ${id}`);
  }
  return found;
}

function edge(graph: MutableGraph, id: string): MutableEdge {
  const found = graph.edges.find((item) => item.id === id);
  if (!found) {
    throw new Error(`missing edge ${id}`);
  }
  return found;
}

function fixedNode(
  source: typeof IMAGE_FIXED_CLIENTS.na | typeof IMAGE_FIXED_PROVIDERS.na,
  id: string,
): MutableNode {
  const copy = JSON.parse(JSON.stringify(source)) as MutableNode;
  copy.id = id;
  return copy;
}

describe('Image Atlas strict parser and fixed endpoints', () => {
  it('parses and accepts the stock starter', () => {
    const starter = createImageGraph();
    const result = parseImageGraph(starter);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const errors = validateImageGraph(result.graph).filter(
      (issue) => issue.severity === 'error',
    );
    expect(errors).toEqual([]);
    expect(node(clone(result.graph), 'client-na').config).toEqual({
      clientRttMs: 20,
      fullDuplex: true,
      aggregateBandwidthGbitPerSec: 100,
      requestAccessBandwidthGbitPerSec: 1,
    });
  });

  it('rejects changed fixed configuration and extra fixed endpoints', () => {
    const configChanged = clone(parsed('starter'));
    node(configChanged, 'client-na').config.aggregateBandwidthGbitPerSec = 200;
    expect(parseImageGraph(configChanged).ok).toBe(false);

    const regionChanged = clone(parsed('starter'));
    node(regionChanged, 'client-na').region = 'eu';
    expect(codes(regionChanged)).toContain('fixed_endpoint_region');

    const extraClient = clone(parsed('starter'));
    extraClient.nodes.push(fixedNode(IMAGE_FIXED_CLIENTS.na, 'client-edge'));
    const extraClientCodes = codes(extraClient);
    expect(extraClientCodes).toContain('fixed_client_count');
    expect(extraClientCodes).toContain('fixed_endpoint_unknown');

    const extraProvider = clone(parsed('starter'));
    extraProvider.nodes.push(fixedNode(IMAGE_FIXED_PROVIDERS.na, 'blob-edge'));
    const extraProviderCodes = codes(extraProvider);
    expect(extraProviderCodes).toContain('fixed_provider_count');
    expect(extraProviderCodes).toContain('fixed_endpoint_unknown');

    const missingProvider = clone(parsed('starter'));
    missingProvider.nodes = missingProvider.nodes.filter(
      (item) => item.id !== 'blob-ap',
    );
    expect(codes(missingProvider)).toContain('fixed_endpoint_missing');
  });

  it('rejects duplicate node ids and duplicate edge ids/tuples', () => {
    const duplicateNode = clone(parsed('starter'));
    node(duplicateNode, 'app-eu').id = 'app-na';
    expect(codes(duplicateNode)).toContain('duplicate_node_id');

    const duplicateEdgeId = clone(parsed('starter'));
    duplicateEdgeId.edges.push({ ...edge(duplicateEdgeId, 'traffic-na') });
    const duplicateEdgeCodes = codes(duplicateEdgeId);
    expect(duplicateEdgeCodes).toContain('duplicate_edge_id');
    expect(duplicateEdgeCodes).toContain('duplicate_edge');

    const duplicateTuple = clone(parsed('starter'));
    duplicateTuple.edges.push({
      id: 'traffic-na-copy',
      source: 'client-na',
      target: 'app-na',
      operation: 'traffic',
    });
    expect(codes(duplicateTuple)).toContain('duplicate_edge');
  });

  it('rejects impossible links, self loops and outgoing providers', () => {
    const badOperation = clone(parsed('starter'));
    badOperation.edges.push({
      id: 'bad',
      source: 'client-na',
      target: 'metadata-na',
      operation: 'metadata',
    });
    expect(codes(badOperation)).toContain('edge_route');

    const selfLoop = clone(parsed('starter'));
    selfLoop.edges.push({
      id: 'self',
      source: 'app-na',
      target: 'app-na',
      operation: 'blob',
    });
    expect(codes(selfLoop)).toContain('self_loop');

    const providerOut = clone(parsed('starter'));
    providerOut.edges.push({
      id: 'provider-out',
      source: 'blob-na',
      target: 'app-na',
      operation: 'blob',
    });
    expect(codes(providerOut)).toContain('provider_outgoing');
  });

  it('allows replicate-only cycles and valid-but-incomplete distribution', () => {
    const mesh = parsed('directory-direct');
    expect(codes(clone(mesh))).not.toContain('graph_cycle');

    const incomplete = clone(mesh);
    incomplete.edges = incomplete.edges.filter(
      (item) => item.id !== 'replicate-eu-ap',
    );
    expect(
      validateImageGraph(incomplete as unknown as ImageGraph).filter(
        (issue) => issue.severity === 'error',
      ),
    ).toEqual([]);
  });
});

describe('Image Atlas routing semantics', () => {
  it('allows explicit multi-app and multi-provider failover choices', () => {
    const missingTraffic = clone(parsed('starter'));
    missingTraffic.edges = missingTraffic.edges.filter(
      (item) => item.id !== 'traffic-na',
    );
    expect(codes(missingTraffic)).toContain('client_traffic_missing');

    const directBlob = clone(parsed('directory-direct'));
    directBlob.edges.push({
      id: 'app-direct-blob',
      source: 'app-na',
      target: 'blob-na',
      operation: 'blob',
    });
    expect(codes(directBlob)).toContain('app_direct_blob_edge');

    const proxyClientBlob = clone(parsed('cache-proxy'));
    proxyClientBlob.edges.push({
      id: 'client-proxy-blob',
      source: 'client-na',
      target: 'blob-na',
      operation: 'blob',
    });
    expect(codes(proxyClientBlob)).toContain('client_blob_without_direct_app');

    const failover = clone(parsed('directory-direct'));
    const option = compileImageRoutes(
      failover as unknown as ImageGraph,
    ).clients.find((route) => route.clientId === 'client-na');
    expect(option?.apps.map((item) => item.appId).sort()).toEqual([
      'app-ap',
      'app-eu',
      'app-na',
    ]);
    expect([...(option?.directProviderIds ?? [])].sort()).toEqual([
      'blob-ap',
      'blob-eu',
      'blob-na',
    ]);
  });

  it('uses local-origin metadata stores and direct per-origin replication', () => {
    const extraUnused = clone(parsed('starter'));
    extraUnused.nodes.push({
      id: 'metadata-eu',
      kind: 'metadata',
      label: 'Unattached metadata',
      region: 'eu',
      position: { x: 200, y: 200 },
      config: {
        backend: 'sql',
        index: 'user-tag',
        diskTb: 8,
        instances: 4,
        replicas: 2,
        residentCacheGb: 8,
      },
    });
    expect(codes(extraUnused)).toContain('metadata_unused');

    const secondStore = clone(parsed('starter'));
    secondStore.edges.push({
      id: 'app-na-second-metadata',
      source: 'app-na',
      target: 'metadata-eu',
      operation: 'metadata',
    });
    expect(codes(secondStore)).toContain('app_metadata_store_count');

    const undivisible = clone(parsed('starter'));
    const origin = node(undivisible, 'metadata-na');
    origin.config.instances = 3;
    origin.config.replicas = 2;
    expect(codes(undivisible)).toContain('metadata_replicas_not_divisible');

    const nonOriginReplication = clone(parsed('directory-direct'));
    nonOriginReplication.nodes.push({
      id: 'metadata-extra',
      kind: 'metadata',
      label: 'Replica-only store',
      region: 'na',
      position: { x: 200, y: 500 },
      config: {
        backend: 'sql',
        index: 'user-tag',
        diskTb: 8,
        instances: 4,
        replicas: 2,
        residentCacheGb: 8,
      },
    });
    nonOriginReplication.edges.push({
      id: 'replicate-non-origin',
      source: 'metadata-extra',
      target: 'metadata-na',
      operation: 'replicate',
    });
    expect(codes(nonOriginReplication)).toContain(
      'replicate_source_not_origin',
    );
  });

  it('bounds cache allocations by per-instance RAM or declared SSD', () => {
    const tooMuchRam = clone(parsed('cache-proxy'));
    node(tooMuchRam, 'cache-na').config.capacityGb = 100;
    expect(codes(tooMuchRam)).toContain('cache_memory_exceeded');

    const ssdOk = clone(parsed('cache-proxy'));
    const cache = node(ssdOk, 'cache-na');
    cache.config = {
      medium: 'ssd',
      instances: 2,
      capacityGb: 4_000,
      fill: 'coalesce',
      diskTb: 2,
    };
    expect(codes(ssdOk)).not.toContain('cache_ssd_exceeded');

    const ssdTooLarge = clone(parsed('cache-proxy'));
    const ssdCache = node(ssdTooLarge, 'cache-na');
    ssdCache.config = {
      medium: 'ssd',
      instances: 2,
      capacityGb: 4_001,
      fill: 'coalesce',
      diskTb: 2,
    };
    expect(codes(ssdTooLarge)).toContain('cache_ssd_exceeded');
  });
});

describe('Image Atlas route compilation and digest', () => {
  it('compiles explicit app choices and origin -> recipient routes', () => {
    const starter = compileImageRoutes(parsed('starter'));
    expect(starter.valid).toBe(true);
    expect(starter.metadataOrigins.map((item) => item.nodeId)).toEqual([
      'metadata-na',
    ]);
    expect([...(starter.metadataOrigins[0]?.appIds ?? [])].sort()).toEqual([
      'app-ap',
      'app-eu',
      'app-na',
    ]);
    expect(starter.clients).toHaveLength(3);
    expect(starter.apps).toHaveLength(3);
    expect(starter.metadataReplication).toHaveLength(0);
    for (const route of starter.clients) {
      expect(route.apps).toHaveLength(1);
      expect(route.apps[0]?.blobPath?.mode).toBe('proxy');
      expect(route.directProviderIds).toEqual([]);
    }

    const direct = compileImageRoutes(parsed('directory-direct'));
    expect(direct.valid).toBe(true);
    expect(direct.metadataOrigins.map((item) => item.nodeId).sort()).toEqual([
      'metadata-ap',
      'metadata-eu',
      'metadata-na',
    ]);
    expect(direct.metadataReplication).toHaveLength(6);
    expect(
      direct.metadataReplication.map(
        (item) => `${item.sourceNodeId}->${item.targetNodeId}`,
      ).sort(),
    ).toEqual([
      'metadata-ap->metadata-eu',
      'metadata-ap->metadata-na',
      'metadata-eu->metadata-ap',
      'metadata-eu->metadata-na',
      'metadata-na->metadata-ap',
      'metadata-na->metadata-eu',
    ]);
    for (const route of direct.clients) {
      expect(route.apps).toHaveLength(3);
      expect(route.apps.every((item) => item.delivery === 'direct')).toBe(true);
      expect(route.apps.every((item) => item.blobPath === null)).toBe(true);
      expect([...route.directProviderIds].sort()).toEqual([
        'blob-ap',
        'blob-eu',
        'blob-na',
      ]);
    }
    expect(
      direct.clients
        .find((route) => route.clientId === 'client-eu')
        ?.apps.find((item) => item.appId === 'app-eu')?.metadataStoreNodeId,
    ).toBe('metadata-eu');

    const proxy = compileImageRoutes(parsed('cache-proxy'));
    expect(proxy.valid).toBe(true);
    expect(proxy.caches).toHaveLength(3);
    for (const route of proxy.clients) {
      const local = route.apps.find(
        (item) => item.appId === `app-${route.region}`,
      );
      expect(local?.delivery).toBe('proxy');
      expect(local?.blobPath?.mode).toBe('proxy');
      expect(local?.blobPath?.cacheId).toBe(`cache-${route.region}`);
      expect(local?.blobPath?.providerId).toBe(`blob-${route.region}`);
      expect(local?.metadataStoreNodeId).toBe(`metadata-${route.region}`);
      expect(route.directProviderIds).toEqual([]);
    }
  });

  it('keeps the semantic digest stable across visual edits only', () => {
    const graph = parsed('directory-direct');
    const before = imageGraphDigest(graph);
    expect(before).toMatch(/^[0-9a-f]{16}$/);

    const moved = clone(graph);
    moved.name = 'Renamed';
    node(moved, 'client-na').label = 'Renamed client';
    node(moved, 'client-na').position = { x: 123, y: 456 };
    expect(imageGraphDigest(moved as unknown as ImageGraph)).toBe(before);

    const changed = clone(graph);
    node(changed, 'metadata-na').config.index = 'user';
    expect(imageGraphDigest(changed as unknown as ImageGraph)).not.toBe(before);
  });

  it('always creates the three fixed clients and providers', () => {
    const graph = createImageGraph();
    expect(
      graph.nodes
        .filter((item) => item.kind === 'client')
        .map((item) => item.region)
        .sort(),
    ).toEqual([...IMAGE_REGIONS].sort());
    expect(
      graph.nodes
        .filter((item) => item.kind === 'blob')
        .map((item) => item.region)
        .sort(),
    ).toEqual([...IMAGE_REGIONS].sort());
  });
});
