import { PARCEL_CATALOG } from './catalog';
import {
  PARCEL_LEVEL,
} from './level';
import {
  PARCEL_REQUIRED_HORIZONS,
  type ParcelCapacityBreakdown,
  type ParcelCapacityEstimate,
  type ParcelCostSummary,
  type ParcelGraph,
  type ParcelHorizonYears,
  type ParcelIssue,
  type ParcelNode,
  type ParcelNodeCost,
  type ParcelStoreKind,
  type ParcelStoreUsage,
} from './contracts';
import { compressionOf } from './model';

function storeKind(node: ParcelNode): node is ParcelNode & { kind: ParcelStoreKind } {
  return node.kind === 'sql' || node.kind === 'kv' || node.kind === 'columnar';
}

function compressionFactor(node: ParcelNode): number {
  return PARCEL_CATALOG.storageModel.compressionFactor[compressionOf(node)];
}

interface StoreRoles {
  readonly primary: string | null;
  readonly replicas: ReadonlySet<string>;
  readonly reads: ReadonlyMap<string, string>;
}

function collectRoles(graph: ParcelGraph): StoreRoles {
  const app = graph.nodes.find((node) => node.kind === 'app');
  const ingest = app
    ? graph.edges.find(
        (edge) => edge.source === app.id && edge.operation === 'ingest',
      )
    : undefined;
  const primary = ingest?.target ?? null;
  const replicas = new Set(
    graph.edges
      .filter((edge) => edge.operation === 'replicate')
      .map((edge) => edge.target),
  );
  const reads = new Map<string, string>();
  if (app) {
    for (const edge of graph.edges) {
      if (
        edge.source === app.id &&
        (edge.operation === 'status' ||
          edge.operation === 'history' ||
          edge.operation === 'report')
      ) {
        reads.set(edge.operation, edge.target);
      }
    }
  }
  return { primary, replicas, reads };
}

function roleNames(nodeId: string, roles: StoreRoles): string[] {
  const names: string[] = [];
  if (roles.primary === nodeId) {
    names.push('ingest-primary');
  }
  if (roles.replicas.has(nodeId)) {
    names.push('replica');
  }
  for (const [operation, target] of roles.reads) {
    if (target === nodeId) {
      names.push(`read:${operation}`);
    }
  }
  if (names.length === 0) {
    names.push('unused');
  }
  return names;
}

function storageCost(
  datasetYears: number,
  retentionYears: number,
): { events: number; parcels: number; years: number } {
  const years = Math.min(datasetYears, retentionYears);
  const eventsPerYear =
    PARCEL_LEVEL.workload.dailyParcels *
    PARCEL_LEVEL.workload.daysPerYear *
    PARCEL_LEVEL.workload.eventsPerParcel;
  const parcelsPerYear =
    PARCEL_LEVEL.workload.dailyParcels * PARCEL_LEVEL.workload.daysPerYear;
  return {
    events: eventsPerYear * years,
    parcels: parcelsPerYear * years,
    years,
  };
}

function buildStoreUsage(
  node: ParcelNode & { kind: ParcelStoreKind },
  horizonYears: ParcelHorizonYears,
  roles: StoreRoles,
): ParcelStoreUsage {
  const retention = node.config.retentionYears ?? 1;
  const hasData = roles.primary === node.id || roles.replicas.has(node.id);
  const dataset = storageCost(horizonYears, retention);
  const events = hasData ? dataset.events : 0;
  const parcels = hasData ? dataset.parcels : 0;
  const factor = compressionFactor(node);
  const payload =
    node.kind === 'columnar'
      ? node.config.columnProjection
        ? PARCEL_CATALOG.storageModel.columnarProjectionBytes
        : PARCEL_LEVEL.workload.eventBytes
      : PARCEL_LEVEL.workload.eventBytes;
  const overhead =
    node.kind === 'columnar'
      ? PARCEL_CATALOG.storageModel.columnarRowOverheadBytes
      : PARCEL_CATALOG.storageModel.eventRowOverheadBytes;
  const rawEventBytes = events * PARCEL_LEVEL.workload.eventBytes;
  const physicalEventBytes = events * (payload + overhead) * factor;

  let indexBytes = 0;
  if (node.kind === 'sql' && hasData) {
    if (node.config.index === 'parcel') {
      indexBytes =
        parcels * PARCEL_CATALOG.storageModel.parcelIndexBytesPerParcel;
    } else if (node.config.index === 'parcel-warehouse') {
      indexBytes =
        events * PARCEL_CATALOG.storageModel.warehouseIndexBytesPerEvent;
    }
  }
  if (node.kind === 'columnar' && hasData) {
    indexBytes =
      events *
      PARCEL_CATALOG.storageModel.columnarWarehouseClusterBytesPerEvent;
  }

  const latestStatusBytes =
    hasData && (node.kind === 'sql' || node.kind === 'kv') && node.config.latestStatus
      ? parcels * PARCEL_CATALOG.storageModel.latestRowBytes * factor
      : 0;

  const rollupRows =
    PARCEL_LEVEL.workload.warehouseCount * 24 * 365 * dataset.years;
  // dataset.years is the retained window, independent of the horizon.
  const rollupBytes =
    hasData && node.config.rollups
      ? rollupRows * PARCEL_CATALOG.storageModel.rollupRowBytes * factor
      : 0;

  const bucketOverheadBytes =
    hasData && node.kind === 'kv'
      ? parcels * PARCEL_CATALOG.storageModel.kvBucketOverheadBytesPerParcel
      : 0;

  const totalUsedBytes =
    physicalEventBytes +
    indexBytes +
    latestStatusBytes +
    rollupBytes +
    bucketOverheadBytes;
  const provisionedTb = node.config.storageTb ?? 1;
  return {
    nodeId: node.id,
    kind: node.kind,
    roles: roleNames(node.id, roles),
    retentionYears: retention,
    horizonYears,
    rawEventBytes,
    physicalEventBytes,
    indexBytes,
    latestStatusBytes,
    rollupBytes,
    bucketOverheadBytes,
    totalUsedBytes,
    totalUsedTb: totalUsedBytes / 1e12,
    provisionedTb,
    utilization: provisionedTb > 0 ? totalUsedBytes / (provisionedTb * 1e12) : 0,
    capacityOk: totalUsedBytes <= provisionedTb * 1e12,
    ...(roles.replicas.has(node.id) && roles.primary
      ? { replicatedFrom: roles.primary }
      : {}),
    compression: compressionOf(node),
    index: node.kind === 'sql' ? (node.config.index ?? 'none') : 'none',
    partition: node.config.partition ?? 'none',
  };
}

function buildCost(
  graph: ParcelGraph,
  capacity: ParcelCapacityBreakdown,
  horizonYears: ParcelHorizonYears,
): ParcelCostSummary {
  const byNode: ParcelNodeCost[] = graph.nodes.map((node) => {
    const hardware = PARCEL_CATALOG.hardware[node.config.size];
    const computeMonthlyUsd =
      hardware.hourlyUsd * PARCEL_CATALOG.storage.billingHoursPerMonth;
    const storageTb =
      node.kind === 'sql' || node.kind === 'kv' || node.kind === 'columnar'
        ? (node.config.storageTb ?? 1)
        : 0;
    const storageMonthlyUsd =
      storageTb * PARCEL_CATALOG.storage.priceUsdPerTbMonth;
    return {
      nodeId: node.id,
      kind: node.kind,
      size: node.config.size,
      computeMonthlyUsd,
      provisionedStorageTb: storageTb,
      storageMonthlyUsd,
      totalMonthlyUsd: computeMonthlyUsd + storageMonthlyUsd,
    };
  });
  const computeMonthlyUsd = byNode.reduce(
    (sum, item) => sum + item.computeMonthlyUsd,
    0,
  );
  const storageMonthlyUsd = byNode.reduce(
    (sum, item) => sum + item.storageMonthlyUsd,
    0,
  );
  const monthlyUsd = computeMonthlyUsd + storageMonthlyUsd;
  return {
    currency: 'USD',
    pricingVersion: PARCEL_CATALOG.pricingVersion,
    monthlyUsd,
    computeMonthlyUsd,
    storageMonthlyUsd,
    fiveYearTcoUsd: monthlyUsd * PARCEL_CATALOG.storage.tcoMonths,
    computeHours:
      PARCEL_CATALOG.storage.billingHoursPerMonth *
      PARCEL_CATALOG.storage.tcoMonths,
    tcoMonths: PARCEL_CATALOG.storage.tcoMonths,
    provisionedStorageTb: capacity.totalProvisionedTb,
    usedStorageTbByHorizon: { [horizonYears]: capacity.totalUsedTb },
    replicationFactor: capacity.replicationFactor,
    byNode,
    budgetMonthlyUsd: PARCEL_LEVEL.budget.monthlyUsd,
    withinBudget: monthlyUsd <= PARCEL_LEVEL.budget.monthlyUsd,
    note: PARCEL_LEVEL.budget.note,
  };
}

/**
 * Analytical capacity, storage and five-year TCO estimate. This function is
 * pure: it never simulates requests and never depends on a seed.
 */
export function estimateParcelCapacity(
  graph: ParcelGraph,
  horizonYears: ParcelHorizonYears,
): ParcelCapacityEstimate {
  if (!(PARCEL_REQUIRED_HORIZONS as readonly number[]).includes(horizonYears)) {
    throw new RangeError(`Horizon must be 1 or 5, received ${horizonYears}.`);
  }
  const roles = collectRoles(graph);
  const stores = graph.nodes
    .filter(storeKind)
    .map((node) => buildStoreUsage(node, horizonYears, roles));
  const dataCopies = stores.filter((store) =>
    store.roles.some(
      (role) => role === 'ingest-primary' || role === 'replica',
    ),
  ).length;
  const primaryStore = stores.find((store) =>
    store.roles.includes('ingest-primary'),
  );
  const historyStore = stores.find((store) =>
    store.roles.includes('read:history'),
  );
  const retentionStores = [primaryStore, historyStore].filter(
    (store): store is ParcelStoreUsage => store !== undefined,
  );
  const retentionOk =
    retentionStores.length > 0 &&
    retentionStores.every((store) => store.retentionYears >= horizonYears);

  const capacity: ParcelCapacityBreakdown = {
    horizonYears,
    stores,
    rawEventBytes: stores.reduce((sum, store) => sum + store.rawEventBytes, 0),
    physicalBytes: stores.reduce(
      (sum, store) => sum + store.physicalEventBytes,
      0,
    ),
    indexBytes: stores.reduce((sum, store) => sum + store.indexBytes, 0),
    latestStatusBytes: stores.reduce(
      (sum, store) => sum + store.latestStatusBytes,
      0,
    ),
    rollupBytes: stores.reduce((sum, store) => sum + store.rollupBytes, 0),
    totalUsedTb: stores.reduce((sum, store) => sum + store.totalUsedTb, 0),
    totalProvisionedTb: stores.reduce(
      (sum, store) => sum + store.provisionedTb,
      0,
    ),
    replicationCopies: dataCopies,
    replicationFactor: Math.max(1, dataCopies),
    retentionYearsRequired: horizonYears,
    retentionOk,
    capacityOk: stores.every((store) => store.capacityOk),
    notes: [
      'Used storage is analytical; raw event volume is retained for the store retention window.',
      'Provisioned storage is fixed for the five-year TCO window and charged once per physical copy.',
      'Columnar projection and compression reduce physical bytes but pay explicit CPU on reads and writes.',
      'Rollups store hourly per-warehouse aggregates; indexes are charged at their declared granularity.',
    ],
  };

  const issues: ParcelIssue[] = [];
  if (!retentionOk) {
    issues.push({
      severity: 'error',
      code: 'retention_covers_horizon',
      message: `The ingest primary and history store must retain ${horizonYears} year(s) of raw history at this horizon.`,
      horizonYears,
    });
  }
  for (const store of stores) {
    if (!store.capacityOk) {
      issues.push({
        severity: 'error',
        code: 'storage_capacity_exceeded',
        message: `"${store.nodeId}" needs ${store.totalUsedTb.toFixed(
          3,
        )} TB but only ${store.provisionedTb.toFixed(1)} TB is provisioned.`,
        nodeId: store.nodeId,
        horizonYears,
      });
    }
  }

  return {
    horizonYears,
    capacity,
    cost: buildCost(graph, capacity, horizonYears),
    issues,
  };
}
