import { IMAGE_CATALOG } from './catalog';
import { IMAGE_LEVEL } from './level';
import { compileImageRoutes } from './graph';
import {
  IMAGE_DATASET_DAY,
  IMAGE_LEVEL_ID,
  IMAGE_PRICING_VERSION,
  type ImageAppUsage,
  type ImageCacheUsage,
  type ImageCapacityBreakdown,
  type ImageCostLine,
  type ImageCostSummary,
  type ImageDatasetUsage,
  type ImageGraph,
  type ImageIssue,
  type ImageMetadataNodeUsage,
  type ImageNode,
  type ImageNodeCost,
  type ImageProviderUsage,
  type ImageRegion,
  type ImageRoutePlan,
} from './contracts';

const BYTES_PER_TB = 1_000_000_000_000;
const BYTES_PER_GB = 1_000_000_000;
const SECONDS_PER_DAY = 86_400;
const DAYS_PER_MONTH = 30;

// Explicit request/response sizes used only for the analytical traffic bill.
// Payload sizes come from the frozen level; these headers are disclosed here.
const CONTROL_REQUEST_BYTES = 1_024;
const SEARCH_REQUEST_BYTES = CONTROL_REQUEST_BYTES;
const DETAIL_REQUEST_BYTES = CONTROL_REQUEST_BYTES;

export interface ImageCapacityEstimate {
  readonly capacity: ImageCapacityBreakdown;
  readonly cost: ImageCostSummary;
  /** Capacity problems plus the semantic issues that affect the estimate. */
  readonly issues: readonly ImageIssue[];
  /** Shared route compilation so I101 does not invent another convention. */
  readonly routes: ImageRoutePlan;
}

function datasetUsage(): ImageDatasetUsage {
  const spec = IMAGE_LEVEL.dataset;
  const images =
    spec.users * spec.uploadsPerUserPerDay * spec.retentionDays;
  const originalBytes = images * spec.originalBytes;
  const metadataBaseBytes = images * spec.metadataBytes;
  const thumbnailIfMaterializedBytes = images * spec.thumbnailBytes;
  return {
    retentionDays: spec.retentionDays,
    day: IMAGE_DATASET_DAY,
    users: spec.users,
    uploadsPerUserPerDay: spec.uploadsPerUserPerDay,
    searchesPerUserPerDay: spec.searchesPerUserPerDay,
    detailClicksPerSearch: spec.detailClicksPerSearch,
    searchResultsPerSearch: spec.searchResultsPerSearch,
    originalBytesPerObject: spec.originalBytes,
    thumbnailBytesPerObject: spec.thumbnailBytes,
    metadataBytesPerObject: spec.metadataBytes,
    images,
    originalBytes,
    originalTb: originalBytes / BYTES_PER_TB,
    metadataBaseBytes,
    metadataBaseTb: metadataBaseBytes / BYTES_PER_TB,
    thumbnailIfMaterializedBytes,
    thumbnailIfMaterializedTb: thumbnailIfMaterializedBytes / BYTES_PER_TB,
    materializedThumbnails: false,
  };
}

function metadataIndexBytes(index: ImageMetadataNodeUsage['index']): number {
  return IMAGE_CATALOG.metadata.indexBytesPerObject[index];
}

interface MetadataRoleInfo {
  readonly roles: readonly ('origin' | 'replica')[];
  readonly appIds: readonly string[];
  readonly replicationSources: readonly string[];
}

function metadataRoles(
  graph: ImageGraph,
  routes: ImageRoutePlan,
): ReadonlyMap<string, MetadataRoleInfo> {
  const appIdsByOrigin = new Map<string, string[]>();
  for (const origin of routes.metadataOrigins) {
    appIdsByOrigin.set(origin.nodeId, [...origin.appIds]);
  }
  const sourcesByTarget = new Map<string, string[]>();
  for (const edge of routes.metadataReplication) {
    const list = sourcesByTarget.get(edge.targetNodeId) ?? [];
    if (!list.includes(edge.sourceNodeId)) {
      list.push(edge.sourceNodeId);
    }
    sourcesByTarget.set(edge.targetNodeId, list);
  }
  const result = new Map<string, MetadataRoleInfo>();
  for (const node of graph.nodes) {
    if (node.kind !== 'metadata') {
      continue;
    }
    const appIds = appIdsByOrigin.get(node.id) ?? [];
    const replicationSources = sourcesByTarget.get(node.id) ?? [];
    const roles: ('origin' | 'replica')[] = [];
    if (appIds.length > 0) {
      roles.push('origin');
    }
    if (replicationSources.length > 0) {
      roles.push('replica');
    }
    result.set(node.id, {
      roles,
      appIds: [...appIds],
      replicationSources: [...replicationSources],
    });
  }
  return result;
}

function buildMetadataUsage(
  graph: ImageGraph,
  dataset: ImageDatasetUsage,
  routes: ImageRoutePlan,
): ImageMetadataNodeUsage[] {
  const roles = metadataRoles(graph, routes);
  const usage: ImageMetadataNodeUsage[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'metadata') {
      continue;
    }
    const config = node.config;
    const replicas = Math.max(1, config.replicas);
    const instances = Math.max(1, config.instances);
    const divisible = instances % replicas === 0 && replicas <= instances;
    const shardCount = Math.floor(instances / replicas);
    const serviceBaseTb = dataset.metadataBaseTb;
    const serviceIndexTb =
      (dataset.images * metadataIndexBytes(config.index)) / BYTES_PER_TB;
    const serviceDataTb = serviceBaseTb + serviceIndexTb;
    const physicalDataTb = serviceDataTb * replicas;
    const provisionedDiskTb = instances * config.diskTb;
    const logicalCapacityTb = shardCount * config.diskTb;
    const residentCacheFits =
      config.residentCacheGb <=
      IMAGE_CATALOG.metadata.residentCacheMaxGbPerInstance;
    const capacityOk =
      divisible && serviceDataTb <= logicalCapacityTb && residentCacheFits;
    const role = roles.get(node.id) ?? {
      roles: [] as const,
      appIds: [] as const,
      replicationSources: [] as const,
    };
    usage.push({
      nodeId: node.id,
      region: node.region,
      roles: [...role.roles],
      appIds: [...role.appIds],
      replicationSources: [...role.replicationSources],
      backend: config.backend,
      index: config.index,
      instances,
      replicas,
      shardCount,
      divisible,
      diskTbPerInstance: config.diskTb,
      residentCacheGbPerInstance: config.residentCacheGb,
      residentCacheFits,
      serviceBaseTb,
      serviceIndexTb,
      serviceDataTb,
      physicalDataTb,
      provisionedDiskTb,
      logicalCapacityTb,
      utilizationLogical:
        logicalCapacityTb > 0 ? serviceDataTb / logicalCapacityTb : 0,
      utilizationProvisioned:
        provisionedDiskTb > 0 ? physicalDataTb / provisionedDiskTb : 0,
      capacityOk,
    });
  }
  return usage;
}

function buildCacheUsage(graph: ImageGraph): ImageCacheUsage[] {
  const usage: ImageCacheUsage[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'cache') {
      continue;
    }
    const config = node.config;
    const instances = Math.max(1, config.instances);
    const perInstanceCapacityGb = config.capacityGb / instances;
    const diskTbPerInstance =
      config.medium === 'ssd' ? (config.diskTb ?? null) : null;
    const limitGbPerInstance =
      config.medium === 'ram'
        ? IMAGE_CATALOG.cache.ramCapacityLimitGbPerInstance
        : (diskTbPerInstance ?? 0) * IMAGE_CATALOG.cache.ssdCapacityGbPerTb;
    const fits =
      limitGbPerInstance > 0 && perInstanceCapacityGb <= limitGbPerInstance;
    usage.push({
      nodeId: node.id,
      region: node.region,
      medium: config.medium,
      fill: config.fill,
      instances,
      capacityGb: config.capacityGb,
      perInstanceCapacityGb,
      limitGbPerInstance,
      diskTbPerInstance,
      provisionedDiskTb:
        config.medium === 'ssd' ? instances * (diskTbPerInstance ?? 0) : 0,
      fits,
    });
  }
  return usage;
}

function buildApps(graph: ImageGraph): ImageAppUsage[] {
  const usage: ImageAppUsage[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'app') {
      continue;
    }
    usage.push({
      nodeId: node.id,
      region: node.region,
      delivery: node.config.delivery,
      buffering: node.config.buffering,
      retries: node.config.retries,
      instances: node.config.instances,
      diskTbPerInstance: IMAGE_CATALOG.instance.diskTbOptions[0],
      memoryGb: node.config.instances * IMAGE_CATALOG.instance.memoryGb,
      networkGbitPerSec:
        node.config.instances * IMAGE_CATALOG.instance.networkGbitPerSec,
    });
  }
  return usage;
}

function buildCapacity(
  graph: ImageGraph,
  dataset: ImageDatasetUsage,
  routes: ImageRoutePlan,
): ImageCapacityBreakdown {
  const metadataNodes = buildMetadataUsage(graph, dataset, routes);
  const caches = buildCacheUsage(graph);
  const apps = buildApps(graph);
  const provider: ImageProviderUsage = {
    id: 'global-blob',
    storedOriginalTb: dataset.originalTb,
    storedOriginalBytes: dataset.originalBytes,
    materializedThumbnailTb: 0,
    internalReplicationIncluded: true,
    fixedMonthlyUsd:
      dataset.originalTb * IMAGE_CATALOG.prices.providerOriginalsUsdPerTbMonth,
  };
  const metadataCapacityOk =
    metadataNodes.length > 0 && metadataNodes.every((node) => node.capacityOk);
  const cacheCapacityOk = caches.every((cache) => cache.fits);
  return {
    dataset,
    metadataNodes,
    caches,
    apps,
    provider,
    metadataServiceTb: metadataNodes.reduce(
      (sum, node) => sum + node.serviceDataTb,
      0,
    ),
    metadataPhysicalTb: metadataNodes.reduce(
      (sum, node) => sum + node.physicalDataTb,
      0,
    ),
    metadataProvisionedTb: metadataNodes.reduce(
      (sum, node) => sum + node.provisionedDiskTb,
      0,
    ),
    metadataLocalCopies: metadataNodes.reduce(
      (sum, node) => sum + node.replicas,
      0,
    ),
    metadataInstances: metadataNodes.reduce(
      (sum, node) => sum + node.instances,
      0,
    ),
    cacheCapacityGb: caches.reduce((sum, cache) => sum + cache.capacityGb, 0),
    cacheInstances: caches.reduce((sum, cache) => sum + cache.instances, 0),
    appInstances: apps.reduce((sum, app) => sum + app.instances, 0),
    metadataCapacityOk,
    cacheCapacityOk,
    capacityOk:
      metadataCapacityOk &&
      cacheCapacityOk &&
      metadataNodes.length > 0 &&
      apps.length > 0,
    retentionOk: IMAGE_LEVEL.dataset.retentionDays === IMAGE_DATASET_DAY,
    topologyComplete: routes.valid,
    notes: [
      'The mature dataset is checked at day 30 and is never materialised as billions of JavaScript objects.',
      'Originals are billed through the fixed global provider; its internal replication is not a player-owned copy.',
      'Thumbnails are provider variant reads. The 384 TB materialised footprint is shown for context only and is not preallocated.',
      'Each metadata store is provisioned for the complete regional dataset independent of graph-delivered replication. shardCount = floor(instances / replicas); logical capacity = shardCount x diskTb.',
      'Every physical metadata copy consumes provisioned and billed disk. Workload bytes are not multiplied by copy count twice.',
      'Metadata index bytes are explicit: none 0 B, user 64 B, user-tag 352 B per image. Every store pays its own index amplification.',
      'Cache RAM capacity is bounded per instance at 22 GB; SSD capacity is bounded by the declared tier. Cache RAM is already included in compute price.',
    ],
  };
}

interface TrafficEstimate {
  readonly complete: boolean;
  readonly clientEgressGb: number;
  readonly providerRetrievalGb: number;
  readonly crossRegionGb: number;
  readonly readRequests: number;
  readonly writeRequests: number;
}

function regionLatencyMs(a: ImageRegion, b: ImageRegion): number {
  if (a === b) {
    return 0;
  }
  const link = IMAGE_LEVEL.network.interRegionLinks.find(
    (item) =>
      (item.a === a && item.b === b) || (item.a === b && item.b === a),
  );
  return link?.oneWayLatencyMs ?? 10_000;
}

/**
 * Analytical normal-health traffic bill. It chooses the lowest-latency
 * connected app (and provider endpoint for direct delivery) for each client
 * population, matching the evaluator's routing contract with no failures.
 */
function estimateBaselineTraffic(
  graph: ImageGraph,
  routes: ImageRoutePlan,
  dataset: ImageDatasetUsage,
): TrafficEstimate {
  const spec = IMAGE_LEVEL;
  const rates = spec.workload.operationRatesPerDay;
  const uploads = rates.upload;
  const searches = rates.search;
  const details = rates.detail;
  const shareByRegion = new Map(
    spec.regions.map((region) => [region.id, region.demandShare]),
  );
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const metadataBytes = dataset.metadataBytesPerObject;
  const searchMetadataBytes =
    dataset.searchResultsPerSearch * dataset.metadataBytesPerObject;
  const thumbnailPayload =
    dataset.thumbnailBytesPerObject * dataset.searchResultsPerSearch;
  const originalPayload = dataset.originalBytesPerObject;

  const clientEgressBytes =
    uploads * metadataBytes +
    searches * (searchMetadataBytes + thumbnailPayload) +
    details * (metadataBytes + originalPayload);
  const providerRetrievalBytes =
    searches * thumbnailPayload + details * originalPayload;

  let crossRegionBytes = 0;
  const uploadsByOrigin = new Map<string, number>();

  for (const route of routes.clients) {
    const share = shareByRegion.get(route.region) ?? 0;
    const clientUploads = uploads * share;
    const clientSearches = searches * share;
    const clientDetails = details * share;

    const chosen = [...route.apps].sort((left, right) => {
      const latency =
        regionLatencyMs(route.region, left.appRegion) -
        regionLatencyMs(route.region, right.appRegion);
      return latency !== 0 ? latency : left.appId.localeCompare(right.appId);
    })[0];
    if (!chosen) {
      continue;
    }

    const requestBytes =
      clientUploads * metadataBytes +
      clientSearches * SEARCH_REQUEST_BYTES +
      clientDetails * DETAIL_REQUEST_BYTES;
    const responseMetadataBytes =
      clientUploads * metadataBytes +
      clientSearches * searchMetadataBytes +
      clientDetails * metadataBytes;
    if (chosen.appRegion !== route.region) {
      crossRegionBytes += requestBytes + responseMetadataBytes;
    }

    const store = byId.get(chosen.metadataStoreNodeId);
    const storeIndex = store?.kind === 'metadata' ? store.config.index : 'none';
    if (store && store.region !== chosen.appRegion) {
      crossRegionBytes += clientSearches * searchMetadataBytes;
      crossRegionBytes += clientDetails * metadataBytes;
      crossRegionBytes +=
        clientUploads * (metadataBytes + metadataIndexBytes(storeIndex));
    }
    uploadsByOrigin.set(
      chosen.metadataStoreNodeId,
      (uploadsByOrigin.get(chosen.metadataStoreNodeId) ?? 0) + clientUploads,
    );

    const searchPayload = clientSearches * thumbnailPayload;
    const detailPayload = clientDetails * originalPayload;
    const readPayload = searchPayload + detailPayload;

    if (chosen.delivery === 'direct') {
      const provider = [...route.directProviderIds]
        .map((id) => byId.get(id))
        .filter((node): node is ImageNode => node?.kind === 'blob')
        .sort((left, right) => {
          const latency =
            regionLatencyMs(route.region, left.region) -
            regionLatencyMs(route.region, right.region);
          return latency !== 0 ? latency : left.id.localeCompare(right.id);
        })[0];
      if (provider && provider.region !== route.region) {
        crossRegionBytes += clientUploads * originalPayload + readPayload;
      }
      continue;
    }

    const blobPath = chosen.blobPath;
    if (!blobPath) {
      continue;
    }
    const provider = byId.get(blobPath.providerId);
    const providerRegion = provider?.region;
    const cache = blobPath.cacheId ? byId.get(blobPath.cacheId) : undefined;

    if (chosen.appRegion !== route.region) {
      crossRegionBytes += clientUploads * originalPayload;
    }
    if (providerRegion && providerRegion !== chosen.appRegion) {
      crossRegionBytes += clientUploads * originalPayload;
    }
    if (cache) {
      if (providerRegion && providerRegion !== cache.region) {
        crossRegionBytes += readPayload;
      }
      if (cache.region !== chosen.appRegion) {
        crossRegionBytes += readPayload;
      }
    } else if (providerRegion && providerRegion !== chosen.appRegion) {
      crossRegionBytes += readPayload;
    }
    if (chosen.appRegion !== route.region) {
      crossRegionBytes += readPayload;
    }
  }

  for (const replication of routes.metadataReplication) {
    const originUploads = uploadsByOrigin.get(replication.sourceNodeId) ?? 0;
    const target = byId.get(replication.targetNodeId);
    if (target?.kind !== 'metadata' || originUploads === 0) {
      continue;
    }
    if (replication.sourceRegion !== replication.targetRegion) {
      crossRegionBytes +=
        originUploads *
        (metadataBytes + metadataIndexBytes(target.config.index));
    }
  }

  const complete =
    routes.valid &&
    routes.clients.length === IMAGE_LEVEL.regions.length &&
    routes.fixedClientIds.length === IMAGE_LEVEL.regions.length &&
    routes.clients.every((route) => route.apps.length > 0);

  return {
    complete,
    clientEgressGb: clientEgressBytes / BYTES_PER_GB,
    providerRetrievalGb: providerRetrievalBytes / BYTES_PER_GB,
    crossRegionGb: crossRegionBytes / BYTES_PER_GB,
    readRequests: searches + details,
    writeRequests: uploads,
  };
}

function buildCost(
  graph: ImageGraph,
  capacity: ImageCapacityBreakdown,
  routes: ImageRoutePlan,
): ImageCostSummary {
  const byNode: ImageNodeCost[] = [];
  for (const node of graph.nodes) {
    if (
      node.kind !== 'app' &&
      node.kind !== 'metadata' &&
      node.kind !== 'cache'
    ) {
      continue;
    }
    const diskTb =
      node.kind === 'metadata'
        ? node.config.diskTb
        : node.kind === 'cache' && node.config.medium === 'ssd'
          ? (node.config.diskTb ?? IMAGE_CATALOG.instance.diskTbOptions[0])
          : IMAGE_CATALOG.instance.diskTbOptions[0];
    const extraDiskTbPerInstance = Math.max(
      0,
      diskTb - IMAGE_CATALOG.prices.includedDiskTb,
    );
    const computeMonthlyUsd =
      node.config.instances *
      IMAGE_CATALOG.prices.computeUsdPerInstanceHour *
      IMAGE_CATALOG.prices.billingHoursPerMonth;
    const extraDiskMonthlyUsd =
      node.config.instances *
      extraDiskTbPerInstance *
      IMAGE_CATALOG.prices.extraDiskUsdPerTbMonth;
    byNode.push({
      nodeId: node.id,
      kind: node.kind,
      region: node.region,
      instances: node.config.instances,
      computeMonthlyUsd,
      extraDiskTbPerInstance,
      extraDiskMonthlyUsd,
      memoryMonthlyUsd: 0,
      memoryIncludedInCompute: true,
      totalMonthlyUsd: computeMonthlyUsd + extraDiskMonthlyUsd,
    });
  }

  const computeUsd = byNode.reduce(
    (sum, node) => sum + node.computeMonthlyUsd,
    0,
  );
  const extraDiskUsd = byNode.reduce(
    (sum, node) => sum + node.extraDiskMonthlyUsd,
    0,
  );
  const fixedProviderUsd = capacity.provider.fixedMonthlyUsd;
  const traffic = estimateBaselineTraffic(graph, routes, capacity.dataset);
  const months = DAYS_PER_MONTH;
  const clientEgressUsd =
    traffic.clientEgressGb *
    months *
    IMAGE_CATALOG.prices.clientEgressUsdPerGb;
  const providerRetrievalUsd =
    traffic.providerRetrievalGb *
    months *
    IMAGE_CATALOG.prices.providerRetrievalUsdPerGb;
  const crossRegionUsd =
    traffic.crossRegionGb *
    months *
    IMAGE_CATALOG.prices.crossRegionUsdPerGb;
  const readFeesUsd =
    traffic.readRequests * months * IMAGE_CATALOG.prices.apiReadUsd;
  const writeFeesUsd =
    traffic.writeRequests * months * IMAGE_CATALOG.prices.apiWriteUsd;

  const controllableUsd = computeUsd + extraDiskUsd;
  const trafficUsd =
    clientEgressUsd + providerRetrievalUsd + crossRegionUsd;
  const apiUsd = readFeesUsd + writeFeesUsd;
  const monthlyUsd = fixedProviderUsd + controllableUsd + trafficUsd + apiUsd;

  const breakdown: ImageCostLine[] = [
    {
      id: 'provider-originals',
      category: 'fixed',
      label: 'Fixed global original storage (6 PB, provider replication included)',
      monthlyUsd: fixedProviderUsd,
      provenance: 'catalog',
    },
  ];
  for (const node of byNode) {
    breakdown.push({
      id: `compute:${node.nodeId}`,
      category: 'compute',
      label: `${node.nodeId} compute (${node.instances} instance${node.instances === 1 ? '' : 's'})`,
      monthlyUsd: node.computeMonthlyUsd,
      nodeId: node.nodeId,
      provenance: 'catalog',
    });
    if (node.extraDiskMonthlyUsd > 0) {
      breakdown.push({
        id: `storage:${node.nodeId}`,
        category: 'storage',
        label: `${node.nodeId} extra disk (${node.extraDiskTbPerInstance} TB above the included 2 TB)`,
        monthlyUsd: node.extraDiskMonthlyUsd,
        nodeId: node.nodeId,
        provenance: 'catalog',
      });
    }
  }
  breakdown.push(
    {
      id: 'traffic:client-egress',
      category: 'traffic',
      label: 'Client egress',
      monthlyUsd: clientEgressUsd,
      provenance: 'analytical-baseline',
    },
    {
      id: 'traffic:provider-retrieval',
      category: 'traffic',
      label: 'Provider retrieval',
      monthlyUsd: providerRetrievalUsd,
      provenance: 'analytical-baseline',
    },
    {
      id: 'traffic:cross-region',
      category: 'traffic',
      label: 'Cross-region player transfers',
      monthlyUsd: crossRegionUsd,
      provenance: 'analytical-baseline',
    },
    {
      id: 'api:reads',
      category: 'api',
      label: 'Business API reads',
      monthlyUsd: readFeesUsd,
      provenance: 'analytical-baseline',
    },
    {
      id: 'api:writes',
      category: 'api',
      label: 'Business API writes',
      monthlyUsd: writeFeesUsd,
      provenance: 'analytical-baseline',
    },
  );

  return {
    currency: 'USD',
    pricingVersion: IMAGE_PRICING_VERSION,
    monthlyUsd,
    fixedMonthlyUsd: fixedProviderUsd,
    controllableMonthlyUsd: controllableUsd,
    trafficMonthlyUsd: trafficUsd,
    apiMonthlyUsd: apiUsd,
    fixed: {
      providerOriginalsUsd: fixedProviderUsd,
      totalUsd: fixedProviderUsd,
    },
    controllable: {
      computeUsd,
      extraDiskUsd,
      totalUsd: controllableUsd,
    },
    traffic: {
      clientEgressUsd,
      providerRetrievalUsd,
      crossRegionUsd,
      totalUsd: trafficUsd,
    },
    api: {
      readFeesUsd,
      writeFeesUsd,
      totalUsd: apiUsd,
    },
    daily: {
      clientEgressGb: traffic.clientEgressGb,
      providerRetrievalGb: traffic.providerRetrievalGb,
      crossRegionGb: traffic.crossRegionGb,
      readRequests: traffic.readRequests,
      writeRequests: traffic.writeRequests,
    },
    byNode,
    breakdown,
    budgetMonthlyUsd: IMAGE_LEVEL.budget.monthlyUsd,
    withinBudget: monthlyUsd <= IMAGE_LEVEL.budget.monthlyUsd,
    provenance: {
      pricingVersion: IMAGE_PRICING_VERSION,
      workloadBasis: 'normal-daily-average',
      days: DAYS_PER_MONTH,
      measured: false,
      cacheHitRatioAssumed: 0,
      retryRatioAssumed: 0,
      trafficBaselineComplete: traffic.complete,
      note:
        'Analytical baseline before an evaluator run: normal daily demand x 30 days with zero assumed cache hits and zero retries. A real evaluation replaces these ratios with measured values and reports incident replay cost separately.',
    },
    notes: [
      'Fixed provider original storage is billed once and is not multiplied by player metadata replicas.',
      'Instance RAM (including cache and metadata resident pages) is part of compute price; memoryMonthlyUsd is always zero.',
      'Every metadata local copy and region replica is provisioned disk; workload bytes are not counted twice.',
      'Client egress and provider retrieval are charged on returned bytes. Cache hits would reduce provider retrieval, but the analytical baseline assumes no hits until measured.',
      'Cross-region bytes use the explicit compiled routes and the shared region-pair pricing.',
      'Incident replay cost is separate and is never extrapolated across the 30-day normal workload.',
    ],
  };
}

/**
 * Analytical day-30 capacity and monthly baseline cost. This function is pure,
 * seed-free and never throws for a partial or semantically invalid graph.
 */
export function estimateImageCapacity(
  graph: ImageGraph,
): ImageCapacityEstimate {
  const routes = compileImageRoutes(graph);
  const dataset = datasetUsage();
  const capacity = buildCapacity(graph, dataset, routes);
  const cost = buildCost(graph, capacity, routes);
  const issues: ImageIssue[] = [...routes.issues];

  for (const node of capacity.metadataNodes) {
    if (!node.divisible) {
      issues.push({
        severity: 'error',
        code: 'metadata_shard_not_divisible',
        message: `Metadata "${node.nodeId}" has ${node.instances} instances and ${node.replicas} replicas; instances must be divisible by replicas.`,
        nodeId: node.nodeId,
      });
    }
    if (!node.capacityOk) {
      issues.push({
        severity: 'error',
        code: 'metadata_capacity_exceeded',
        message: `Metadata "${node.nodeId}" stores ${node.serviceDataTb.toFixed(3)} TB per dataset but its logical capacity is ${node.logicalCapacityTb.toFixed(3)} TB (${node.instances} instances x ${node.diskTbPerInstance} TB / ${node.replicas} replicas).`,
        nodeId: node.nodeId,
        value: node.serviceDataTb,
        limit: node.logicalCapacityTb,
      });
    }
    if (!node.residentCacheFits) {
      issues.push({
        severity: 'error',
        code: 'metadata_resident_cache_exceeded',
        message: `Metadata "${node.nodeId}" allocates ${node.residentCacheGbPerInstance} GB resident pages per instance; the limit is ${IMAGE_CATALOG.metadata.residentCacheMaxGbPerInstance} GB.`,
        nodeId: node.nodeId,
      });
    }
  }
  for (const cache of capacity.caches) {
    if (!cache.fits) {
      issues.push({
        severity: 'error',
        code: 'cache_capacity_exceeded',
        message: `Cache "${cache.nodeId}" needs ${cache.perInstanceCapacityGb.toFixed(1)} GB per instance; its limit is ${cache.limitGbPerInstance.toFixed(1)} GB (${cache.medium}).`,
        nodeId: cache.nodeId,
        value: cache.perInstanceCapacityGb,
        limit: cache.limitGbPerInstance,
      });
    }
  }
  if (capacity.metadataNodes.length === 0) {
    issues.push({
      severity: 'error',
      code: 'metadata_missing',
      message: 'No metadata store exists, so no metadata capacity can be provisioned.',
    });
  }
  if (capacity.apps.length === 0) {
    issues.push({
      severity: 'error',
      code: 'app_missing',
      message: 'No application pool exists, so the workload has no serving path.',
    });
  }

  return { capacity, cost, issues, routes };
}

/** Convenience for callers that only need the fixed level identifier. */
export const IMAGE_CAPACITY_LEVEL_ID = IMAGE_LEVEL_ID;

/** Normal-daily baseline request counts, exposed for CLI explanations. */
export function imageBaselineRatesPerSecond(): {
  readonly upload: number;
  readonly search: number;
  readonly detail: number;
} {
  return { ...IMAGE_LEVEL.workload.averageRatesPerSecond };
}

/** Seconds in the frozen day; kept local so the capacity math is auditable. */
export const IMAGE_SECONDS_PER_DAY = SECONDS_PER_DAY;
