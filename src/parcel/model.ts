import { PARCEL_CATALOG } from './catalog';
import { PARCEL_LEVEL } from './level';
import type {
  ParcelBusinessOperation,
  ParcelCompression,
  ParcelHorizonYears,
  ParcelNode,
  ParcelNodeSize,
  ParcelStoreKind,
  ParcelWorkloadPhase,
  ParcelWorkloadSummary,
} from './contracts';

/** Dataset at a horizon, independent of the graph. */
export interface ParcelDataset {
  readonly horizonYears: ParcelHorizonYears;
  readonly years: number;
  readonly events: number;
  readonly parcels: number;
  readonly rawBytes: number;
  readonly eventsPerYear: number;
  readonly parcelsPerYear: number;
  readonly last30dEvents: number;
}

export function parcelDataset(horizonYears: ParcelHorizonYears): ParcelDataset {
  const workload = PARCEL_LEVEL.workload;
  const years = horizonYears;
  const eventsPerYear =
    workload.dailyParcels * workload.daysPerYear * workload.eventsPerParcel;
  const parcelsPerYear = workload.dailyParcels * workload.daysPerYear;
  return {
    horizonYears,
    years,
    events: eventsPerYear * years,
    parcels: parcelsPerYear * years,
    rawBytes: eventsPerYear * years * workload.eventBytes,
    eventsPerYear,
    parcelsPerYear,
    /** Per-warehouse events in the report window. */
    last30dEvents:
      (workload.dailyParcels *
        workload.eventsPerParcel *
        workload.reportWindowDays) /
      workload.warehouseCount,
  };
}

export function storeDataset(
  node: ParcelNode,
  horizonYears: ParcelHorizonYears,
): ParcelDataset {
  const full = parcelDataset(horizonYears);
  const retention = node.config.retentionYears ?? 1;
  const years = Math.min(full.years, retention);
  return {
    ...full,
    years,
    events: full.eventsPerYear * years,
    parcels: full.parcelsPerYear * years,
    rawBytes: full.eventsPerYear * years * PARCEL_LEVEL.workload.eventBytes,
  };
}

export function compressionOf(node: ParcelNode): ParcelCompression {
  return node.config.compression ?? 'none';
}

function compressionFactor(node: ParcelNode): number {
  return PARCEL_CATALOG.storageModel.compressionFactor[compressionOf(node)];
}

function compressionCpuMs(node: ParcelNode, logicalBytes: number): number {
  if (logicalBytes <= 0) {
    return 0;
  }
  return (
    (logicalBytes / 1024) *
    PARCEL_CATALOG.service.compressionCpuMsPerKb[compressionOf(node)]
  );
}

export function eventPayloadBytes(node: ParcelNode): number {
  if (node.kind === 'columnar') {
    return node.config.columnProjection
      ? PARCEL_CATALOG.storageModel.columnarProjectionBytes
      : PARCEL_LEVEL.workload.eventBytes;
  }
  return PARCEL_LEVEL.workload.eventBytes;
}

export function eventPhysicalBytes(node: ParcelNode): number {
  const overhead =
    node.kind === 'columnar'
      ? PARCEL_CATALOG.storageModel.columnarRowOverheadBytes
      : PARCEL_CATALOG.storageModel.eventRowOverheadBytes;
  return (eventPayloadBytes(node) + overhead) * compressionFactor(node);
}

function latestPhysicalBytes(node: ParcelNode): number {
  return PARCEL_CATALOG.storageModel.latestRowBytes * compressionFactor(node);
}

function rollupPhysicalBytes(node: ParcelNode): number {
  return PARCEL_CATALOG.storageModel.rollupRowBytes * compressionFactor(node);
}

/** Explicit work vector for one queue lane item. */
export interface ParcelWorkVector {
  readonly cpuMs: number;
  readonly ioBytes: number;
  readonly ioOps: number;
  readonly netBytes: number;
  readonly rows: number;
  readonly bytesRead: number;
  readonly bytesWritten: number;
  readonly accessPath: string;
  readonly missingData: boolean;
}

function emptyWork(accessPath: string): ParcelWorkVector {
  return {
    cpuMs: 0,
    ioBytes: 0,
    ioOps: 0,
    netBytes: 0,
    rows: 0,
    bytesRead: 0,
    bytesWritten: 0,
    accessPath,
    missingData: false,
  };
}

/**
 * Ingest write work. The primary acknowledges only after its durable commit;
 * the same formula is used for replica writes (without the ack semantics).
 * Every extra index, latest-status row and rollup update is charged explicitly.
 */
export function writeEventWork(node: ParcelNode, count: number): ParcelWorkVector {
  const service = PARCEL_CATALOG.service.ingest;
  const storage = PARCEL_CATALOG.storageModel;
  const logicalPayload = count * PARCEL_LEVEL.workload.eventBytes;
  const physicalPayload = count * eventPhysicalBytes(node);
  let extraIo = 0;
  let cpu =
    count * service.baseCpuMsPerEvent + count * service.durabilityCpuMsPerEvent;

  if (node.kind === 'sql' && node.config.index === 'parcel') {
    extraIo += (count / PARCEL_LEVEL.workload.eventsPerParcel) * storage.parcelIndexBytesPerParcel;
    cpu += count * service.parcelIndexCpuMsPerEvent;
  }
  if (node.kind === 'sql' && node.config.index === 'parcel-warehouse') {
    extraIo += count * storage.warehouseIndexBytesPerEvent;
    cpu += count * service.warehouseIndexCpuMsPerEvent;
  }
  if (node.kind === 'kv') {
    extraIo += (count / PARCEL_LEVEL.workload.eventsPerParcel) * storage.kvBucketOverheadBytesPerParcel;
  }
  if ((node.kind === 'sql' || node.kind === 'kv') && node.config.latestStatus) {
    extraIo += count * latestPhysicalBytes(node);
    cpu += count * service.latestCpuMsPerEvent;
  }
  if (node.config.rollups) {
    extraIo += count * rollupPhysicalBytes(node);
    cpu += count * service.rollupCpuMsPerEvent;
  }
  if (node.kind === 'columnar') {
    extraIo +=
      count * PARCEL_CATALOG.storageModel.columnarWarehouseClusterBytesPerEvent;
    cpu += count * PARCEL_CATALOG.service.columnarClusterCpuMsPerEvent;
  }
  cpu += compressionCpuMs(node, logicalPayload);
  const ioBytes = physicalPayload + extraIo;
  return {
    cpuMs: cpu,
    ioBytes,
    ioOps: count * service.ioOpsPerEvent,
    netBytes: physicalPayload,
    rows: count,
    bytesRead: 0,
    bytesWritten: ioBytes,
    accessPath: 'event-write',
    missingData: false,
  };
}

/** Reputation of the latest durable row for status. */
export function statusWork(node: ParcelNode, dataset: ParcelDataset): ParcelWorkVector {
  const service = PARCEL_CATALOG.service.status;
  if (node.kind === 'sql' && node.config.latestStatus) {
    const bytes = latestPhysicalBytes(node);
    return {
      ...emptyWork('latest-status-row'),
      cpuMs: service.latestCpuMs + compressionCpuMs(node, PARCEL_CATALOG.storageModel.latestRowBytes),
      ioBytes: bytes,
      ioOps: service.probeIoOps,
      netBytes: bytes,
      rows: 1,
      bytesRead: bytes,
    };
  }
  if (node.kind === 'kv' && node.config.latestStatus) {
    const bytes = latestPhysicalBytes(node);
    return {
      ...emptyWork('latest-status-bucket'),
      cpuMs: service.latestCpuMs + compressionCpuMs(node, PARCEL_CATALOG.storageModel.latestRowBytes),
      ioBytes: bytes,
      ioOps: service.probeIoOps,
      netBytes: bytes,
      rows: 1,
      bytesRead: bytes,
    };
  }
  const pointAccess =
    (node.kind === 'sql' &&
      (node.config.index === 'parcel' || node.config.index === 'parcel-warehouse')) ||
    node.kind === 'kv';
  if (pointAccess) {
    const events = PARCEL_LEVEL.workload.eventsPerParcel;
    const bytes = events * eventPhysicalBytes(node);
    return {
      ...emptyWork(node.kind === 'kv' ? 'parcel-bucket-scan' : 'parcel-index-scan'),
      cpuMs:
        events * service.scanCpuMsPerEvent +
        compressionCpuMs(node, events * PARCEL_LEVEL.workload.eventBytes),
      ioBytes: bytes,
      ioOps: service.probeIoOps * 2,
      netBytes: latestPhysicalBytes(node),
      rows: events,
      bytesRead: bytes,
    };
  }
  const events = dataset.events;
  const bytes = events * eventPhysicalBytes(node);
  return {
    ...emptyWork('status-full-scan'),
    cpuMs:
      events * service.scanCpuMsPerEvent +
      compressionCpuMs(node, events * PARCEL_LEVEL.workload.eventBytes),
    ioBytes: bytes,
    ioOps: (events / 1000) * 0.5,
    netBytes: latestPhysicalBytes(node),
    rows: events,
    bytesRead: bytes,
  };
}

export function historyWork(
  node: ParcelNode,
  dataset: ParcelDataset,
  ageDays: number,
): ParcelWorkVector {
  const retentionDays = (node.config.retentionYears ?? 1) * 365;
  if (ageDays > retentionDays) {
    return {
      ...emptyWork('expired-retention'),
      missingData: true,
    };
  }
  if (node.kind === 'columnar' && node.config.columnProjection) {
    return {
      ...emptyWork('columnar-projection-cannot-return-payload'),
      missingData: true,
    };
  }
  const events = PARCEL_LEVEL.workload.eventsPerParcel;
  const physical = events * eventPhysicalBytes(node);
  const monthsInRetention = Math.max(1, dataset.years * 12);
  const monthScanRows =
    node.config.partition === 'month'
      ? dataset.events / monthsInRetention
      : dataset.events;
  if (node.kind === 'sql' && node.config.index === 'none') {
    return {
      ...emptyWork(
        node.config.partition === 'month'
          ? 'history-month-partition-scan'
          : 'history-full-scan',
      ),
      cpuMs:
        monthScanRows * PARCEL_CATALOG.service.report.scanCpuMsPerRow +
        compressionCpuMs(node, monthScanRows * PARCEL_LEVEL.workload.eventBytes),
      ioBytes: monthScanRows * eventPhysicalBytes(node),
      ioOps: (monthScanRows / 1000) * 0.5,
      netBytes: physical,
      rows: monthScanRows,
      bytesRead: monthScanRows * eventPhysicalBytes(node),
    };
  }
  if (node.kind === 'columnar') {
    const rows = monthScanRows;
    return {
      ...emptyWork(
        node.config.partition === 'month'
          ? 'columnar-history-month-scan'
          : 'columnar-history-scan',
      ),
      cpuMs:
        rows * PARCEL_CATALOG.service.report.scanCpuMsPerRow +
        compressionCpuMs(node, rows * PARCEL_LEVEL.workload.eventBytes),
      ioBytes: rows * eventPhysicalBytes(node),
      ioOps: (rows / 1000) * 0.5,
      netBytes: physical,
      rows,
      bytesRead: rows * eventPhysicalBytes(node),
    };
  }
  return {
    ...emptyWork(node.kind === 'kv' ? 'parcel-bucket-history' : 'parcel-index-history'),
    cpuMs:
      events * PARCEL_CATALOG.service.history.eventCpuMs +
      compressionCpuMs(node, events * PARCEL_LEVEL.workload.eventBytes),
    ioBytes: physical,
    ioOps: PARCEL_CATALOG.service.history.bucketIoOps,
    netBytes: physical,
    rows: events,
    bytesRead: physical,
  };
}

/** Warehouse report for the last 30 days. */
export function reportWork(node: ParcelNode, dataset: ParcelDataset): ParcelWorkVector {
  const service = PARCEL_CATALOG.service.report;
  const logicalPerRow = (node.config.columnProjection
    ? PARCEL_CATALOG.storageModel.columnarProjectionBytes
    : PARCEL_LEVEL.workload.eventBytes);
  const physicalPerRow =
    node.kind === 'columnar'
      ? (logicalPerRow + PARCEL_CATALOG.storageModel.columnarRowOverheadBytes) *
        compressionFactor(node)
      : eventPhysicalBytes(node);

  if (node.config.rollups) {
    const rows = service.rollupRowsPerReport;
    const logical = rows * PARCEL_CATALOG.storageModel.rollupRowBytes;
    return {
      ...emptyWork('warehouse-rollups'),
      cpuMs: rows * service.rollupCpuMsPerRow + compressionCpuMs(node, logical),
      ioBytes: rows * rollupPhysicalBytes(node),
      ioOps: service.rollupIoOps,
      netBytes: logical,
      rows,
      bytesRead: rows * rollupPhysicalBytes(node),
    };
  }

  if (node.kind === 'sql' && node.config.index === 'parcel-warehouse') {
    const rows = dataset.last30dEvents;
    const logical = rows * PARCEL_LEVEL.workload.eventBytes;
    const bytes = rows * physicalPerRow + rows * PARCEL_CATALOG.storageModel.warehouseIndexBytesPerEvent;
    return {
      ...emptyWork('warehouse-index-scan'),
      cpuMs: rows * service.indexedCpuMsPerRow + compressionCpuMs(node, logical),
      ioBytes: bytes,
      ioOps: (rows / 1000) * service.scanIoOpsPerKRow,
      netBytes: logicalPerRow * 100,
      rows,
      bytesRead: bytes,
    };
  }

  if (node.kind === 'sql' || node.kind === 'kv') {
    // Without rollups or a warehouse index the query must scan every
    // warehouse. Monthly partitioning prunes to the two-month boundary, but
    // it is still a scan across all 1000 warehouses.
    const rows =
      node.config.partition === 'month'
        ? PARCEL_LEVEL.workload.dailyParcels *
          PARCEL_LEVEL.workload.eventsPerParcel *
          60
        : dataset.events;
    const logical = rows * PARCEL_LEVEL.workload.eventBytes;
    const bytes = rows * physicalPerRow;
    return {
      ...emptyWork(
        node.config.partition === 'month'
          ? 'report-month-partition-scan'
          : 'report-full-scan',
      ),
      cpuMs: rows * service.scanCpuMsPerRow + compressionCpuMs(node, logical),
      ioBytes: bytes,
      ioOps: (rows / 1000) * service.scanIoOpsPerKRow,
      netBytes: logicalPerRow * 100,
      rows,
      bytesRead: bytes,
    };
  }

  // Columnar projections are clustered by warehouse (explicitly charged in
  // write work and capacity). Month partitions prune each warehouse to two
  // months; without partitions the query reads that warehouse's retention.
  const rows =
    node.config.partition === 'month'
      ? dataset.last30dEvents * 2
      : dataset.events / PARCEL_LEVEL.workload.warehouseCount;
  const bytes = rows * physicalPerRow;
  const logical = rows * logicalPerRow;
  return {
    ...emptyWork(
      node.config.partition === 'month'
        ? 'columnar-month-partition'
        : 'columnar-warehouse-cluster-scan',
    ),
    cpuMs: rows * service.columnarCpuMsPerRow + compressionCpuMs(node, logical),
    ioBytes: bytes,
    ioOps: (rows / 1000) * service.scanIoOpsPerKRow,
    netBytes: logicalPerRow * 100,
    rows,
    bytesRead: bytes,
  };
}

export function appWork(operation: ParcelBusinessOperation): ParcelWorkVector {
  const isReport = operation === 'report';
  const responseBytes =
    operation === 'history'
      ? 15_000
      : operation === 'report'
        ? 100_000
        : 1_000;
  return {
    ...emptyWork('application-dispatch'),
    cpuMs: isReport
      ? PARCEL_CATALOG.service.appCpuMsPerReport
      : PARCEL_CATALOG.service.appCpuMsPerRequest,
    netBytes: responseBytes,
  };
}

export interface ParcelTaskDemand {
  readonly serviceMs: number;
  readonly cpuUnits: number;
  readonly ioUnits: number;
  readonly netUnits: number;
  readonly cpuServiceMs: number;
  readonly ioServiceMs: number;
  readonly netServiceMs: number;
}

/**
 * Convert rows/bytes work into exclusive lane demand. Disk and network
 * bandwidth are properties of the whole node: a node's declared MB/s is split
 * across its declared lanes, never multiplied by them.
 */
export function taskDemand(
  node: ParcelNode,
  work: ParcelWorkVector,
  parallelCpuUnits = 1,
): ParcelTaskDemand {
  const hw = PARCEL_CATALOG.hardware[node.config.size];
  const cpuUnits =
    work.cpuMs > 0
      ? Math.max(1, Math.min(parallelCpuUnits, hw.cpuCores))
      : 0;
  const ioUnits = work.ioOps > 0 || work.ioBytes > 0 ? 1 : 0;
  const netUnits = work.netBytes > 0 ? 1 : 0;
  const cpuServiceMs = cpuUnits > 0 ? work.cpuMs / cpuUnits : 0;
  const diskPerLaneMbPerSec = hw.diskMbps / hw.ioLanes;
  const iopsPerLane = hw.diskIops / hw.ioLanes;
  const ioServiceMs = Math.max(
    (work.ioBytes / 1_000_000 / diskPerLaneMbPerSec) * 1000,
    (work.ioOps / iopsPerLane) * 1000,
  );
  const netPerLaneMbPerSec = hw.networkMbps / 8 / hw.networkLanes;
  const netServiceMs =
    work.netBytes > 0
      ? (work.netBytes / 1_000_000 / netPerLaneMbPerSec) * 1000
      : 0;
  const serviceMs = Math.max(cpuServiceMs, ioServiceMs, netServiceMs, 0.001);
  return {
    serviceMs,
    cpuUnits,
    ioUnits,
    netUnits,
    cpuServiceMs,
    ioServiceMs,
    netServiceMs,
  };
}

export function nodeSizeLabel(size: ParcelNodeSize): string {
  return size;
}

export function datasetSummary(dataset: ParcelDataset): string {
  const tb = dataset.rawBytes / 1e12;
  return `${dataset.events.toLocaleString('en-US')} retained events, ${tb.toFixed(
    3,
  )} TB raw at year ${dataset.years}`;
}

/** Exposed for JSON-schema/help text: phase list in one place. */
export function workloadPhases(): readonly ParcelWorkloadPhase[] {
  return PARCEL_LEVEL.workload.phaseMultiplier;
}

export function emptyWorkloadSummary(): ParcelWorkloadSummary {
  return {
    durationMs: PARCEL_LEVEL.durationMs,
    drainMs: PARCEL_LEVEL.drainMs,
    simulationEndMs: PARCEL_LEVEL.durationMs + PARCEL_LEVEL.drainMs,
    sampleFactor: PARCEL_LEVEL.workload.sampleFactor,
    sampledRequests: 0,
    estimatedOfferedRequests: 0,
    scheduledReports: 0,
    oldHistoryRequests: 0,
    eventBudget: 0,
    processedEvents: 0,
    exhausted: false,
    keyspace: PARCEL_LEVEL.workload.sampledParcelKeys,
    causalTimestamps:
      'Causal ages and a bounded parcel keyspace replace materialising billions of payload rows.',
  };
}

export type { ParcelBusinessOperation, ParcelStoreKind };
