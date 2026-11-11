import { z } from 'zod';
import { IMAGE_CATALOG } from './catalog';
import {
  IMAGE_COMPONENT_LIMITS,
  IMAGE_LEVEL_ID,
  IMAGE_MODEL_VERSION,
  IMAGE_REGIONS,
  IMAGE_SCHEMA_VERSION,
  imageGraphSchema,
  imageIssuesFromZod,
  type ImageAppNode,
  type ImageAppRoute,
  type ImageBlobNode,
  type ImageBlobPath,
  type ImageCacheNode,
  type ImageCacheRoute,
  type ImageClientAppOption,
  type ImageClientConfig,
  type ImageClientNode,
  type ImageClientRoute,
  type ImageEdge,
  type ImageGraph,
  type ImageGraphParseResult,
  type ImageIssue,
  type ImageMetadataNode,
  type ImageMetadataOriginRoute,
  type ImageMetadataReplicationRoute,
  type ImageNode,
  type ImagePlayerNode,
  type ImagePosition,
  type ImageRegion,
  type ImageRoutePlan,
  type ImageValidationOptions,
} from './contracts';

// ---------------------------------------------------------------------------
// Fixed endpoints
// ---------------------------------------------------------------------------

export const IMAGE_FIXED_CLIENT_CONFIG: ImageClientConfig = Object.freeze({
  clientRttMs: 20,
  fullDuplex: true,
  aggregateBandwidthGbitPerSec: 100,
  requestAccessBandwidthGbitPerSec: 1,
});

export const IMAGE_FIXED_BLOB_CONFIG = Object.freeze({
  providerId: IMAGE_CATALOG.provider.id,
  endpointBandwidthGbitPerSec:
    IMAGE_CATALOG.provider.endpointBandwidthGbitPerSec,
  readRpcPerSec: IMAGE_CATALOG.provider.readRpcPerSec,
  writeRpcPerSec: IMAGE_CATALOG.provider.writeRpcPerSec,
  remoteReadVisibilityMs: IMAGE_CATALOG.provider.remoteReadVisibilityMs,
  originReadYourWrites: IMAGE_CATALOG.provider.originReadYourWrites,
  durableAck: IMAGE_CATALOG.provider.durableAck,
  thumbnailVariantReads: IMAGE_CATALOG.provider.thumbnailVariantReads,
  materializedThumbnails: IMAGE_CATALOG.provider.materializedThumbnails,
});

export const IMAGE_FIXED_CLIENT_IDS: Readonly<Record<ImageRegion, string>> = {
  na: 'client-na',
  eu: 'client-eu',
  ap: 'client-ap',
};

export const IMAGE_FIXED_PROVIDER_IDS: Readonly<Record<ImageRegion, string>> = {
  na: 'blob-na',
  eu: 'blob-eu',
  ap: 'blob-ap',
};

const REGION_LABELS: Readonly<Record<ImageRegion, string>> = {
  na: 'North America',
  eu: 'Europe',
  ap: 'Asia Pacific',
};

const REGION_Y: Readonly<Record<ImageRegion, number>> = {
  na: -240,
  eu: 0,
  ap: 240,
};

function fixedClient(region: ImageRegion): ImageClientNode {
  return {
    id: IMAGE_FIXED_CLIENT_IDS[region],
    kind: 'client',
    label: `${REGION_LABELS[region]} clients`,
    position: { x: -900, y: REGION_Y[region] },
    region,
    config: { ...IMAGE_FIXED_CLIENT_CONFIG },
  };
}

function fixedProvider(region: ImageRegion): ImageBlobNode {
  return {
    id: IMAGE_FIXED_PROVIDER_IDS[region],
    kind: 'blob',
    label: `Global blob · ${region.toUpperCase()} endpoint`,
    position: { x: 900, y: REGION_Y[region] },
    region,
    config: { ...IMAGE_FIXED_BLOB_CONFIG },
  };
}

/** Fixed clients by region. Only label and position may be edited. */
export const IMAGE_FIXED_CLIENTS: Readonly<
  Record<ImageRegion, ImageClientNode>
> = Object.freeze({
  na: fixedClient('na'),
  eu: fixedClient('eu'),
  ap: fixedClient('ap'),
});

/** Fixed provider endpoints by region. Only label and position may be edited. */
export const IMAGE_FIXED_PROVIDERS: Readonly<
  Record<ImageRegion, ImageBlobNode>
> = Object.freeze({
  na: fixedProvider('na'),
  eu: fixedProvider('eu'),
  ap: fixedProvider('ap'),
});

const FIXED_CLIENT_IDS = new Set<string>(
  Object.values(IMAGE_FIXED_CLIENT_IDS),
);
const FIXED_PROVIDER_IDS = new Set<string>(
  Object.values(IMAGE_FIXED_PROVIDER_IDS),
);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Strictly parse an imported document. Shape problems are returned as
 * `ok: false`; semantic problems are reported by `validateImageGraph`.
 * The parser is atomic and never throws for ordinary bad JSON.
 */
export function parseImageGraph(input: unknown): ImageGraphParseResult {
  const parsed = imageGraphSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      graph: null,
      issues: imageIssuesFromZod(parsed.error),
    };
  }
  return { ok: true, graph: parsed.data, issues: [] };
}

/** Parse JSON text with the 1 MiB input bound applied before JSON.parse. */
export function parseImageGraphJson(text: string): ImageGraphParseResult {
  const bytes = utf8ByteLength(text);
  if (bytes > IMAGE_COMPONENT_LIMITS.maxDocumentBytes) {
    return {
      ok: false,
      graph: null,
      issues: [
        {
          severity: 'error',
          code: 'input_too_large',
          message: `The document is ${bytes} bytes; the limit is ${IMAGE_COMPONENT_LIMITS.maxDocumentBytes} bytes.`,
        },
      ],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      graph: null,
      issues: [
        {
          severity: 'error',
          code: 'invalid_json',
          message: 'The document is not valid JSON.',
        },
      ],
    };
  }
  return parseImageGraph(value);
}

// ---------------------------------------------------------------------------
// Node and graph helpers
// ---------------------------------------------------------------------------

export function cloneImageNode(node: ImageNode): ImageNode {
  return JSON.parse(JSON.stringify(node)) as ImageNode;
}

export function cloneImageGraph(graph: ImageGraph): ImageGraph {
  return JSON.parse(JSON.stringify(graph)) as ImageGraph;
}

export function createImageNode(
  kind: 'app' | 'metadata' | 'cache',
  id: string,
  region: ImageRegion,
  position: ImagePosition = { x: 0, y: 0 },
): ImagePlayerNode {
  if (kind === 'app') {
    const node: ImageAppNode = {
      id,
      kind,
      label: 'Application pool',
      position: { ...position },
      region,
      config: {
        instances: 2,
        delivery: 'proxy',
        buffering: 'streaming',
        retries: 0,
        retryBackoffMs: 0,
      },
    };
    return node;
  }
  if (kind === 'metadata') {
    const node: ImageMetadataNode = {
      id,
      kind,
      label: 'Metadata store',
      position: { ...position },
      region,
      config: {
        backend: 'sql',
        index: 'user',
        diskTb: 8,
        instances: 4,
        replicas: 2,
        residentCacheGb: IMAGE_CATALOG.metadata.residentCacheDefaultGbPerInstance,
      },
    };
    return node;
  }
  const node: ImageCacheNode = {
    id,
    kind,
    label: 'Byte-bounded cache',
    position: { ...position },
    region,
    config: {
      medium: IMAGE_CATALOG.cache.defaultMedium,
      instances: IMAGE_CATALOG.cache.defaultInstances,
      capacityGb: IMAGE_CATALOG.cache.defaultCapacityGb,
      fill: IMAGE_CATALOG.cache.defaultFill,
    },
  };
  return node;
}

/**
 * Starter graph: valid topology, deliberately undersized metadata with no
 * index. It is a starting experiment, not a promised passing witness.
 */
export function createImageGraph(): ImageGraph {
  const clients = IMAGE_REGIONS.map((region) =>
    cloneImageNode(IMAGE_FIXED_CLIENTS[region]),
  );
  const providers = IMAGE_REGIONS.map((region) =>
    cloneImageNode(IMAGE_FIXED_PROVIDERS[region]),
  );
  const apps: ImageAppNode[] = [];
  const edges: ImageEdge[] = [];

  for (const region of IMAGE_REGIONS) {
    const clientId = IMAGE_FIXED_CLIENT_IDS[region];
    const appId = `app-${region}`;
    const providerId = IMAGE_FIXED_PROVIDER_IDS[region];
    apps.push({
      id: appId,
      kind: 'app',
      label: `${REGION_LABELS[region]} app pool`,
      position: { x: -200, y: REGION_Y[region] },
      region,
      config: {
        instances: 2,
        delivery: 'proxy',
        buffering: 'streaming',
        retries: 0,
        retryBackoffMs: 0,
      },
    });
    edges.push({
      id: `traffic-${region}`,
      source: clientId,
      target: appId,
      operation: 'traffic',
    });
    edges.push({
      id: `blob-${region}`,
      source: appId,
      target: providerId,
      operation: 'blob',
    });
    edges.push({
      id: `metadata-${region}`,
      source: appId,
      target: 'metadata-na',
      operation: 'metadata',
    });
  }

  const origin: ImageMetadataNode = {
    id: 'metadata-na',
    kind: 'metadata',
    label: 'Shared metadata origin',
    position: { x: 330, y: 0 },
    region: 'na',
    config: {
      backend: 'sql',
      index: 'none',
      diskTb: 2,
      instances: 2,
      replicas: 1,
      residentCacheGb: IMAGE_CATALOG.metadata.residentCacheDefaultGbPerInstance,
    },
  };

  return {
    schemaVersion: IMAGE_SCHEMA_VERSION,
    levelId: IMAGE_LEVEL_ID,
    modelVersion: IMAGE_MODEL_VERSION,
    name: 'Starter (undersized, uncalibrated)',
    nodes: [...clients, ...apps, ...providers, origin],
    edges,
  };
}

// ---------------------------------------------------------------------------
// Semantic validation and route compilation
// ---------------------------------------------------------------------------

function pushIssue(
  issues: ImageIssue[],
  severity: ImageIssue['severity'],
  code: string,
  message: string,
  extra: Omit<ImageIssue, 'severity' | 'code' | 'message'> = {},
): void {
  issues.push({ severity, code, message, ...extra });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isOperationLegal(
  sourceKind: ImageNode['kind'],
  targetKind: ImageNode['kind'],
  operation: ImageEdge['operation'],
): boolean {
  switch (operation) {
    case 'traffic':
      return sourceKind === 'client' && targetKind === 'app';
    case 'metadata':
      return sourceKind === 'app' && targetKind === 'metadata';
    case 'replicate':
      return sourceKind === 'metadata' && targetKind === 'metadata';
    case 'blob':
      return (
        (sourceKind === 'client' && targetKind === 'blob') ||
        (sourceKind === 'app' && (targetKind === 'blob' || targetKind === 'cache')) ||
        (sourceKind === 'cache' && targetKind === 'blob')
      );
    default:
      return false;
  }
}

function findCycles(
  nodes: readonly ImageNode[],
  edges: readonly ImageEdge[],
): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node.id, []);
  }
  const ids = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      continue;
    }
    adjacency.get(edge.source)?.push(edge.target);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (nodeId: string): void => {
    state.set(nodeId, 1);
    stack.push(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      const nextState = state.get(next) ?? 0;
      if (nextState === 1) {
        const start = stack.indexOf(next);
        cycles.push([...stack.slice(start), next]);
      } else if (nextState === 0) {
        visit(next);
      }
    }
    stack.pop();
    state.set(nodeId, 2);
  };
  for (const node of nodes) {
    if ((state.get(node.id) ?? 0) === 0) {
      visit(node.id);
    }
  }
  return cycles;
}

/**
 * Replication cycles are legal: each recipient applies an origin record once
 * and never rebroadcasts it. Any other cycle remains an error.
 */
function cycleIsReplicateOnly(
  cycle: readonly string[],
  edges: readonly ImageEdge[],
): boolean {
  for (let index = 0; index < cycle.length - 1; index += 1) {
    const source = cycle[index];
    const target = cycle[index + 1];
    if (
      !edges.some(
        (edge) =>
          edge.source === source &&
          edge.target === target &&
          edge.operation === 'replicate',
      )
    ) {
      return false;
    }
  }
  return true;
}

function checkFixedNodes(
  nodes: readonly ImageNode[],
  issues: ImageIssue[],
): void {
  const clientNodes = nodes.filter((node) => node.kind === 'client');
  const blobNodes = nodes.filter((node) => node.kind === 'blob');

  if (clientNodes.length !== IMAGE_REGIONS.length) {
    pushIssue(
      issues,
      'error',
      'fixed_client_count',
      `Exactly ${IMAGE_REGIONS.length} fixed regional clients are required, found ${clientNodes.length}.`,
    );
  }
  if (blobNodes.length !== IMAGE_REGIONS.length) {
    pushIssue(
      issues,
      'error',
      'fixed_provider_count',
      `Exactly ${IMAGE_REGIONS.length} fixed regional providers are required, found ${blobNodes.length}.`,
    );
  }

  for (const region of IMAGE_REGIONS) {
    const expectedId = IMAGE_FIXED_CLIENT_IDS[region];
    const client = nodes.find((node) => node.id === expectedId);
    if (!client) {
      pushIssue(
        issues,
        'error',
        'fixed_endpoint_missing',
        `The fixed client "${expectedId}" is missing.`,
        { nodeId: expectedId },
      );
    } else if (client.kind !== 'client') {
      pushIssue(
        issues,
        'error',
        'fixed_endpoint_kind',
        `"${expectedId}" must remain a client node.`,
        { nodeId: expectedId },
      );
    } else {
      if (client.region !== region) {
        pushIssue(
          issues,
          'error',
          'fixed_endpoint_region',
          `Client "${expectedId}" must stay in region "${region}".`,
          { nodeId: expectedId },
        );
      }
      if (!sameJson(client.config, IMAGE_FIXED_CLIENT_CONFIG)) {
        pushIssue(
          issues,
          'error',
          'fixed_endpoint_config',
          `Client "${expectedId}" configuration is fixed: 1 Gbit/s and 20 ms regional RTT.`,
          { nodeId: expectedId },
        );
      }
    }

    const expectedProviderId = IMAGE_FIXED_PROVIDER_IDS[region];
    const provider = nodes.find((node) => node.id === expectedProviderId);
    if (!provider) {
      pushIssue(
        issues,
        'error',
        'fixed_endpoint_missing',
        `The fixed provider endpoint "${expectedProviderId}" is missing.`,
        { nodeId: expectedProviderId },
      );
    } else if (provider.kind !== 'blob') {
      pushIssue(
        issues,
        'error',
        'fixed_endpoint_kind',
        `"${expectedProviderId}" must remain a blob provider node.`,
        { nodeId: expectedProviderId },
      );
    } else {
      if (provider.region !== region) {
        pushIssue(
          issues,
          'error',
          'fixed_endpoint_region',
          `Provider "${expectedProviderId}" must stay in region "${region}".`,
          { nodeId: expectedProviderId },
        );
      }
      if (!sameJson(provider.config, IMAGE_FIXED_BLOB_CONFIG)) {
        pushIssue(
          issues,
          'error',
          'fixed_endpoint_config',
          `Provider "${expectedProviderId}" configuration is fixed by the level contract.`,
          { nodeId: expectedProviderId },
        );
      }
    }
  }

  for (const node of clientNodes) {
    if (!FIXED_CLIENT_IDS.has(node.id)) {
      pushIssue(
        issues,
        'error',
        'fixed_endpoint_unknown',
        `Client "${node.id}" is not a valid fixed endpoint. Use client-na, client-eu or client-ap.`,
        { nodeId: node.id },
      );
    }
  }
  for (const node of blobNodes) {
    if (!FIXED_PROVIDER_IDS.has(node.id)) {
      pushIssue(
        issues,
        'error',
        'fixed_endpoint_unknown',
        `Provider "${node.id}" is not a valid fixed endpoint. Use blob-na, blob-eu or blob-ap.`,
        { nodeId: node.id },
      );
    }
  }
}

interface CacheProviderResult {
  readonly providerId: string | null;
  readonly appIds: readonly string[];
}

function checkCaches(
  nodes: readonly ImageNode[],
  edges: readonly ImageEdge[],
  issues: ImageIssue[],
): Map<string, CacheProviderResult> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result = new Map<string, CacheProviderResult>();
  for (const cache of nodes) {
    if (cache.kind !== 'cache') {
      continue;
    }
    const out = edges.filter(
      (edge) => edge.source === cache.id && edge.operation === 'blob',
    );
    let providerId: string | null = null;
    if (out.length !== 1) {
      pushIssue(
        issues,
        'error',
        'cache_provider_count',
        `Cache "${cache.id}" must have exactly one blob edge to a provider, found ${out.length}.`,
        { nodeId: cache.id },
      );
    } else {
      const target = byId.get(out[0]?.target ?? '');
      if (!target || target.kind !== 'blob') {
        pushIssue(
          issues,
          'error',
          'cache_provider_target',
          `Cache "${cache.id}" must fetch from a fixed blob provider.`,
          { nodeId: cache.id, edgeId: out[0]?.id },
        );
      } else {
        providerId = target.id;
      }
    }

    const incomingApps = edges
      .filter((edge) => edge.target === cache.id && edge.operation === 'blob')
      .map((edge) => byId.get(edge.source))
      .filter((node): node is ImageAppNode => node?.kind === 'app')
      .map((node) => node.id);
    if (incomingApps.length === 0) {
      pushIssue(
        issues,
        'warning',
        'cache_unused',
        `Cache "${cache.id}" is not on any app path but still costs money.`,
        { nodeId: cache.id },
      );
    }

    const perInstance =
      cache.config.instances > 0
        ? cache.config.capacityGb / cache.config.instances
        : Number.POSITIVE_INFINITY;
    if (cache.config.medium === 'ram') {
      const limit = IMAGE_CATALOG.instance.usableMemoryGb;
      if (!(perInstance <= limit)) {
        pushIssue(
          issues,
          'error',
          'cache_memory_exceeded',
          `Cache "${cache.id}" needs ${perInstance.toFixed(1)} GB RAM per instance; the usable limit is ${limit} GB. Use more instances or SSD.`,
          { nodeId: cache.id },
        );
      }
    } else {
      const diskTb = cache.config.diskTb;
      if (diskTb === undefined) {
        pushIssue(
          issues,
          'error',
          'cache_disk_missing',
          `Cache "${cache.id}" uses SSD medium but declares no disk tier.`,
          { nodeId: cache.id },
        );
      } else {
        const limit = diskTb * IMAGE_CATALOG.cache.ssdCapacityGbPerTb;
        if (!(perInstance <= limit)) {
          pushIssue(
            issues,
            'error',
            'cache_ssd_exceeded',
            `Cache "${cache.id}" needs ${perInstance.toFixed(1)} GB per instance but its ${diskTb} TB tier provides ${limit} GB.`,
            { nodeId: cache.id },
          );
        }
      }
    }
    result.set(cache.id, { providerId, appIds: incomingApps });
  }
  return result;
}

interface MetadataPlanState {
  readonly origins: readonly ImageMetadataOriginRoute[];
  readonly replication: readonly ImageMetadataReplicationRoute[];
  readonly originAppIds: ReadonlyMap<string, readonly string[]>;
  readonly incomingReplicate: ReadonlyMap<string, readonly ImageEdge[]>;
}

/**
 * Build the origin set and direct origin -> recipient routes.
 *
 * Any metadata store with a metadata edge from an app is an origin: it can
 * append new immutable uploads and serve that app's reads. A store may be both
 * an origin and a replica. Replication edges are direct per-origin logs;
 * transitive paths are not inferred, and cycles are legal because applied
 * records are deduped by origin/sequence and never rebroadcast.
 */
function checkMetadata(
  nodes: readonly ImageNode[],
  edges: readonly ImageEdge[],
  issues: ImageIssue[],
): MetadataPlanState {
  const metadataNodes = nodes.filter(
    (node): node is ImageMetadataNode => node.kind === 'metadata',
  );
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const originAppIds = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.operation !== 'metadata') {
      continue;
    }
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target || source.kind !== 'app' || target.kind !== 'metadata') {
      continue;
    }
    const list = originAppIds.get(target.id) ?? [];
    if (!list.includes(source.id)) {
      list.push(source.id);
    }
    originAppIds.set(target.id, list);
  }

  const incomingReplicate = new Map<string, ImageEdge[]>();
  for (const edge of edges) {
    if (edge.operation !== 'replicate') {
      continue;
    }
    const list = incomingReplicate.get(edge.target) ?? [];
    list.push(edge);
    incomingReplicate.set(edge.target, list);
  }

  if (metadataNodes.length === 0) {
    pushIssue(
      issues,
      'error',
      'metadata_missing',
      'At least one metadata store is required.',
    );
    return {
      origins: [],
      replication: [],
      originAppIds,
      incomingReplicate,
    };
  }

  const origins: ImageMetadataOriginRoute[] = [];
  for (const node of metadataNodes) {
    const appIds = originAppIds.get(node.id);
    if (appIds && appIds.length > 0) {
      origins.push({
        nodeId: node.id,
        region: node.region,
        appIds: [...appIds],
      });
    }
  }

  const replication: ImageMetadataReplicationRoute[] = [];
  for (const edge of edges) {
    if (edge.operation !== 'replicate') {
      continue;
    }
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target || source.kind !== 'metadata' || target.kind !== 'metadata') {
      continue;
    }
    if (!originAppIds.has(source.id)) {
      pushIssue(
        issues,
        'error',
        'replicate_source_not_origin',
        `Replication edge "${edge.id}" starts at "${source.id}", which is not an origin attached to an app. Only local-origin logs may be replicated.`,
        { edgeId: edge.id, nodeId: source.id },
      );
      continue;
    }
    if (
      !replication.some(
        (route) =>
          route.sourceNodeId === source.id &&
          route.targetNodeId === target.id,
      )
    ) {
      replication.push({
        sourceNodeId: source.id,
        targetNodeId: target.id,
        sourceRegion: source.region,
        targetRegion: target.region,
      });
    }
  }

  for (const node of metadataNodes) {
    if (!originAppIds.has(node.id) && !incomingReplicate.has(node.id)) {
      pushIssue(
        issues,
        'warning',
        'metadata_unused',
        `Metadata store "${node.id}" is neither an app origin nor a replication recipient; it costs money but serves no route.`,
        { nodeId: node.id },
      );
    }
    const { instances, replicas } = node.config;
    if (replicas > instances) {
      pushIssue(
        issues,
        'error',
        'metadata_replicas_exceed_instances',
        `Metadata "${node.id}" declares ${replicas} replicas but only ${instances} instances.`,
        { nodeId: node.id },
      );
    } else if (instances % replicas !== 0) {
      pushIssue(
        issues,
        'error',
        'metadata_replicas_not_divisible',
        `Metadata "${node.id}" must have instances divisible by replicas (${instances} / ${replicas} is not an integer).`,
        { nodeId: node.id },
      );
    }
    if (
      node.config.residentCacheGb >
      IMAGE_CATALOG.metadata.residentCacheMaxGbPerInstance
    ) {
      pushIssue(
        issues,
        'error',
        'metadata_resident_cache_exceeded',
        `Metadata "${node.id}" allocates ${node.config.residentCacheGb} GB resident pages per instance; the limit is ${IMAGE_CATALOG.metadata.residentCacheMaxGbPerInstance} GB.`,
        { nodeId: node.id },
      );
    }
  }

  return { origins, replication, originAppIds, incomingReplicate };
}

function checkApps(
  nodes: readonly ImageNode[],
  edges: readonly ImageEdge[],
  cacheProviders: ReadonlyMap<string, CacheProviderResult>,
  issues: ImageIssue[],
): ImageAppRoute[] {
  const apps = nodes.filter((node): node is ImageAppNode => node.kind === 'app');
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (apps.length === 0) {
    pushIssue(
      issues,
      'error',
      'app_missing',
      'At least one application pool is required.',
    );
  }
  const routes: ImageAppRoute[] = [];
  for (const app of apps) {
    const metadataOut = edges.filter(
      (edge) => edge.source === app.id && edge.operation === 'metadata',
    );
    let metadataStoreNodeId: string | null = null;
    if (metadataOut.length !== 1) {
      pushIssue(
        issues,
        'error',
        'app_metadata_store_count',
        `App "${app.id}" needs exactly one metadata edge selecting its read/write store, found ${metadataOut.length}.`,
        { nodeId: app.id, edgeId: metadataOut[0]?.id },
      );
    } else {
      const edge = metadataOut[0];
      const target = edge ? byId.get(edge.target) : undefined;
      if (!edge || !target || target.kind !== 'metadata') {
        // Edge legality already reports the impossible endpoint.
      } else {
        metadataStoreNodeId = target.id;
      }
    }

    const blobOut = edges.filter(
      (edge) => edge.source === app.id && edge.operation === 'blob',
    );
    let blobPath: ImageBlobPath | null = null;
    if (app.config.delivery === 'direct') {
      if (blobOut.length > 0) {
        pushIssue(
          issues,
          'error',
          'app_direct_blob_edge',
          `Direct app "${app.id}" must not have a blob edge; clients fetch from their regional provider.`,
          { nodeId: app.id, edgeId: blobOut[0]?.id },
        );
      }
    } else if (blobOut.length !== 1) {
      pushIssue(
        issues,
        'error',
        'app_proxy_blob_count',
        `Proxy app "${app.id}" needs exactly one blob path, found ${blobOut.length}.`,
        { nodeId: app.id },
      );
    } else {
      const edge = blobOut[0];
      const target = edge ? byId.get(edge.target) : undefined;
      if (!edge || !target) {
        // Edge legality already reports the dangling endpoint.
      } else if (target.kind === 'blob') {
        blobPath = { mode: 'proxy', providerId: target.id, cacheId: null };
      } else if (target.kind === 'cache') {
        const cache = cacheProviders.get(target.id);
        if (cache?.providerId) {
          blobPath = {
            mode: 'proxy',
            providerId: cache.providerId,
            cacheId: target.id,
          };
        }
      } else {
        pushIssue(
          issues,
          'error',
          'app_blob_target',
          `App "${app.id}" blob path must target a provider or cache, not a ${target.kind}.`,
          { nodeId: app.id, edgeId: edge.id },
        );
      }
    }

    routes.push({
      appId: app.id,
      region: app.region,
      delivery: app.config.delivery,
      metadataStoreNodeId,
      blobPath,
      clientIds: [],
    });
  }
  return routes;
}

function checkClients(
  nodes: readonly ImageNode[],
  edges: readonly ImageEdge[],
  appRoutes: readonly ImageAppRoute[],
  issues: ImageIssue[],
): ImageClientRoute[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const appById = new Map(appRoutes.map((route) => [route.appId, route]));
  const clients = nodes.filter(
    (node): node is ImageClientNode => node.kind === 'client',
  );
  const routes: ImageClientRoute[] = [];

  for (const client of clients) {
    if (!FIXED_CLIENT_IDS.has(client.id)) {
      continue;
    }
    const trafficOut = edges.filter(
      (edge) => edge.source === client.id && edge.operation === 'traffic',
    );
    if (trafficOut.length === 0) {
      pushIssue(
        issues,
        'error',
        'client_traffic_missing',
        `Client "${client.id}" needs at least one explicit traffic edge to an app.`,
        { nodeId: client.id },
      );
    }

    const options: ImageClientAppOption[] = [];
    for (const traffic of trafficOut) {
      const app = byId.get(traffic.target);
      if (!app || app.kind !== 'app') {
        pushIssue(
          issues,
          'error',
          'client_traffic_target',
          `Client "${client.id}" traffic edge "${traffic.id}" must target an app.`,
          { nodeId: client.id, edgeId: traffic.id },
        );
        continue;
      }
      const appRoute = appById.get(app.id);
      if (!appRoute || !appRoute.metadataStoreNodeId) {
        continue;
      }
      if (appRoute.delivery === 'proxy' && !appRoute.blobPath) {
        continue;
      }
      options.push({
        appId: app.id,
        appRegion: app.region,
        delivery: appRoute.delivery,
        metadataStoreNodeId: appRoute.metadataStoreNodeId,
        blobPath: appRoute.blobPath,
      });
    }

    const blobOut = edges.filter(
      (edge) => edge.source === client.id && edge.operation === 'blob',
    );
    const directProviderIds: string[] = [];
    const hasDirect = options.some((option) => option.delivery === 'direct');
    if (hasDirect && blobOut.length === 0) {
      pushIssue(
        issues,
        'error',
        'client_blob_missing',
        `Client "${client.id}" has a direct app but no explicit provider endpoint edge.`,
        { nodeId: client.id },
      );
    }
    if (!hasDirect && blobOut.length > 0) {
      pushIssue(
        issues,
        'error',
        'client_blob_without_direct_app',
        `Client "${client.id}" has provider edges but no connected direct app; proxy apps forbid client blob edges.`,
        { nodeId: client.id, edgeId: blobOut[0]?.id },
      );
    }
    for (const edge of blobOut) {
      const target = byId.get(edge.target);
      if (!target || target.kind !== 'blob') {
        pushIssue(
          issues,
          'error',
          'client_blob_target',
          `Client "${client.id}" blob edge "${edge.id}" must target a fixed provider endpoint.`,
          { nodeId: client.id, edgeId: edge.id },
        );
        continue;
      }
      if (!directProviderIds.includes(target.id)) {
        directProviderIds.push(target.id);
      }
    }

    if (options.length > 0) {
      routes.push({
        clientId: client.id,
        region: client.region,
        apps: options,
        directProviderIds,
      });
    }
  }
  return routes;
}

function checkCommonStructure(
  graph: ImageGraph,
  issues: ImageIssue[],
): { byId: Map<string, ImageNode>; duplicates: Set<string> } {
  const byId = new Map<string, ImageNode>();
  const duplicates = new Set<string>();
  for (const node of graph.nodes) {
    if (byId.has(node.id)) {
      duplicates.add(node.id);
      pushIssue(
        issues,
        'error',
        'duplicate_node_id',
        `Duplicate node id "${node.id}".`,
        { nodeId: node.id },
      );
      continue;
    }
    byId.set(node.id, node);
  }

  const edgeIds = new Set<string>();
  const edgeTuples = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      pushIssue(
        issues,
        'error',
        'duplicate_edge_id',
        `Duplicate edge id "${edge.id}".`,
        { edgeId: edge.id },
      );
    }
    edgeIds.add(edge.id);
    const tuple = `${edge.source}|${edge.target}|${edge.operation}`;
    if (edgeTuples.has(tuple)) {
      pushIssue(
        issues,
        'error',
        'duplicate_edge',
        `Duplicate ${edge.operation} edge from "${edge.source}" to "${edge.target}".`,
        { edgeId: edge.id },
      );
    }
    edgeTuples.add(tuple);

    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) {
      pushIssue(
        issues,
        'error',
        'edge_endpoint_missing',
        `Edge "${edge.id}" references a missing node.`,
        { edgeId: edge.id },
      );
      continue;
    }
    if (edge.source === edge.target) {
      pushIssue(
        issues,
        'error',
        'self_loop',
        `Edge "${edge.id}" connects a node to itself.`,
        { edgeId: edge.id },
      );
      continue;
    }
    if (!isOperationLegal(source.kind, target.kind, edge.operation)) {
      pushIssue(
        issues,
        'error',
        'edge_route',
        `A ${edge.operation} edge cannot go from ${source.kind} "${source.id}" to ${target.kind} "${target.id}".`,
        { edgeId: edge.id, nodeId: target.id },
      );
    }
    if (target.kind === 'client') {
      pushIssue(
        issues,
        'error',
        'client_incoming',
        `Edges cannot enter client "${target.id}".`,
        { edgeId: edge.id, nodeId: target.id },
      );
    }
    if (source.kind === 'blob') {
      pushIssue(
        issues,
        'error',
        'provider_outgoing',
        `Fixed provider "${source.id}" cannot emit edges.`,
        { edgeId: edge.id, nodeId: source.id },
      );
    }
  }

  for (const cycle of findCycles(graph.nodes, graph.edges)) {
    if (cycleIsReplicateOnly(cycle, graph.edges)) {
      continue;
    }
    pushIssue(
      issues,
      'error',
      'graph_cycle',
      `Non-replicate route cycle detected: ${cycle.join(' -> ')}.`,
      { nodeId: cycle[0] },
    );
  }

  const used = new Set<string>();
  for (const edge of graph.edges) {
    used.add(edge.source);
    used.add(edge.target);
  }
  for (const node of graph.nodes) {
    if (!used.has(node.id)) {
      pushIssue(
        issues,
        'warning',
        'unused_node',
        `"${node.label}" is not connected to any route but still costs money.`,
        { nodeId: node.id },
      );
    }
  }

  return { byId, duplicates };
}

/**
 * Compile explicit client app/provider choices, app metadata stores and
 * origin -> recipient replication routes. This is lenient by design: a partial
 * graph still yields roles and capacity estimates, while the issue list
 * explains why it cannot run.
 */
export function compileImageRoutes(graph: ImageGraph): ImageRoutePlan {
  const issues: ImageIssue[] = [];
  if (
    !graph ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  ) {
    pushIssue(
      issues,
      'error',
      'invalid_document',
      'The graph must contain nodes and edges arrays.',
    );
    return {
      valid: false,
      issues,
      fixedClientIds: [],
      fixedProviderIds: [],
      metadataOrigins: [],
      metadataReplication: [],
      apps: [],
      clients: [],
      caches: [],
    };
  }

  checkCommonStructure(graph, issues);
  checkFixedNodes(graph.nodes, issues);
  const metadata = checkMetadata(graph.nodes, graph.edges, issues);
  const cacheProviders = checkCaches(graph.nodes, graph.edges, issues);
  const appRoutes = checkApps(
    graph.nodes,
    graph.edges,
    cacheProviders,
    issues,
  );
  const clientRoutes = checkClients(
    graph.nodes,
    graph.edges,
    appRoutes,
    issues,
  );

  const clientIdsByApp = new Map<string, string[]>();
  for (const route of clientRoutes) {
    for (const option of route.apps) {
      const list = clientIdsByApp.get(option.appId) ?? [];
      list.push(route.clientId);
      clientIdsByApp.set(option.appId, list);
    }
  }
  const apps: ImageAppRoute[] = appRoutes.map((route) => ({
    ...route,
    clientIds: clientIdsByApp.get(route.appId) ?? [],
  }));
  for (const route of apps) {
    if (route.clientIds.length === 0) {
      pushIssue(
        issues,
        'warning',
        'app_unused',
        `App "${route.appId}" receives no client traffic but still costs money.`,
        { nodeId: route.appId },
      );
    }
  }

  const caches: ImageCacheRoute[] = [];
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const [cacheId, info] of cacheProviders) {
    const cache = byId.get(cacheId);
    if (cache?.kind !== 'cache' || !info.providerId) {
      continue;
    }
    caches.push({
      cacheId,
      region: cache.region,
      providerId: info.providerId,
      appIds: info.appIds,
    });
  }

  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
    fixedClientIds: Object.values(IMAGE_FIXED_CLIENT_IDS),
    fixedProviderIds: Object.values(IMAGE_FIXED_PROVIDER_IDS),
    metadataOrigins: metadata.origins,
    metadataReplication: metadata.replication,
    apps,
    clients: clientRoutes,
    caches,
  };
}

/**
 * Semantic validation. Errors block a run; warnings remain editable. The
 * validator never throws for a parsed graph, and a partial graph still returns
 * every issue that can be computed.
 */
export function validateImageGraph(
  graph: ImageGraph,
  options: ImageValidationOptions = {},
): readonly ImageIssue[] {
  void options;
  return compileImageRoutes(graph).issues;
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        result[key] = stableValue(entry);
      }
    }
    return result;
  }
  return value;
}

function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Semantic digest. Positions, labels and the graph display name are ignored;
 * the seed is deliberately absent because it belongs to the save envelope.
 * Node ids remain part of the digest because edges reference them.
 */
export function imageGraphDigest(graph: ImageGraph): string {
  const semantic = {
    schemaVersion: graph.schemaVersion,
    levelId: graph.levelId,
    modelVersion: graph.modelVersion,
    nodes: [...graph.nodes]
      .map((node) => ({
        id: node.id,
        kind: node.kind,
        region: node.region,
        config: stableValue(node.config),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...graph.edges]
      .map((edge) => ({
        source: edge.source,
        target: edge.target,
        operation: edge.operation,
      }))
      .sort((left, right) =>
        `${left.source}|${left.target}|${left.operation}`.localeCompare(
          `${right.source}|${right.target}|${right.operation}`,
        ),
      ),
  };
  const text = JSON.stringify(semantic);
  const first = fnv1a32(text).toString(16).padStart(8, '0');
  const second = fnv1a32(`image:${text}`).toString(16).padStart(8, '0');
  return `${first}${second}`;
}

export const imageSemanticDigest = imageGraphDigest;

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

/** JSON Schema for an imported Image Atlas graph document. */
export function imageGraphJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(imageGraphSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id: 'https://system-design-game.local/schemas/image-atlas-graph.json',
    title: 'Image Atlas graph',
    'x-semantic-rules': [
      'Exactly three fixed clients client-na/eu/ap and three fixed providers blob-na/eu/ap.',
      'Fixed node kind, region and config are locked; only label and position are editable. The Client node has a 100 Gbit/s population aggregate link and each business request has a separate 1 Gbit/s access link shared by its children.',
      'Each client has one or more explicit traffic edges to apps. The engine selects the lowest-latency healthy connected app after 250 ms failure detection and never follows an implicit edge.',
      'Direct apps have no blob edge; direct clients may list one or more explicit provider endpoint edges and use the nearest healthy connected endpoint.',
      'Proxy apps have one blob path directly to a provider or through one cache that points to one provider; proxy clients have no blob edges.',
      'Each app has exactly one metadata edge selecting the store for its reads and new immutable uploads. Any metadata store attached to an app is an origin and may also be a replica.',
      'Replicate edges are direct origin-to-recipient logs. Replicate-only cycles are allowed and deduped per origin/sequence; records are not recursively rebroadcast. Missing edges are valid-but-incomplete distribution.',
      'Same upload id/same content has one effect; same id/different content is rejected. An id is bound to its first healthy origin and never appended elsewhere while the owner is unavailable.',
      'Metadata instances must be divisible by replicas; shardCount = instances / replicas. Capacity provisions the complete regional dataset for every store.',
      'A cache must fit per-instance RAM (22 GB) or its declared SSD tier.',
      'No self loops, duplicate ids/tuples, dangling endpoints, non-replicate cycles or extra fixed endpoints.',
      'Missing index, undersized metadata and capacity pressure are reported but do not crash capacity estimation.',
    ],
  };
}


