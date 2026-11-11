import {
  estimateImageCapacity,
  IMAGE_CATALOG,
  type ImageCapacityBreakdown,
  type ImageCostSummary,
  type ImageGraph,
  type ImageIssue,
  type ImageMetadataNode,
  type ImageCacheNode,
  type ImageRoutePlan,
} from '../index';
import { imageUniqueIssues } from './image-diagnostics';

export interface ImageLiveEstimate {
  readonly capacity: ImageCapacityBreakdown;
  readonly cost: ImageCostSummary;
  /** Capacity problems plus semantic issues, de-duplicated for display. */
  readonly issues: readonly ImageIssue[];
  readonly routes: ImageRoutePlan;
  readonly errorCount: number;
  readonly warningCount: number;
}

/**
 * Day-30 analytical capacity and the monthly baseline cost. Pure, synchronous
 * and seed-free: the header and the inspector show the estimate of the graph
 * that is currently on the canvas, not the frozen input of the last run.
 */
export function imageLiveEstimate(graph: ImageGraph): ImageLiveEstimate {
  const estimate = estimateImageCapacity(graph);
  const issues = imageUniqueIssues(estimate.issues);
  return {
    capacity: estimate.capacity,
    cost: estimate.cost,
    issues,
    routes: estimate.routes,
    errorCount: issues.filter((issue) => issue.severity === 'error').length,
    warningCount: issues.filter((issue) => issue.severity === 'warning').length,
  };
}

export interface ImageNodeCapacityLoad {
  /** Analytical day-30 fraction of the declared capacity. */
  readonly fraction: number;
  readonly label: string;
  readonly detail: string;
}

/**
 * Capacity load shown on a node meter. It is explicitly analytical: metadata
 * uses provisioned physical disk, a cache uses its per-instance limit.
 */
export function imageNodeCapacityLoad(
  capacity: ImageCapacityBreakdown,
  nodeId: string,
): ImageNodeCapacityLoad | null {
  const metadata = capacity.metadataNodes.find((item) => item.nodeId === nodeId);
  if (metadata) {
    return {
      fraction: metadata.utilizationProvisioned,
      label: 'Disk',
      detail: `${metadata.serviceDataTb.toFixed(2)} TB per dataset · ${metadata.provisionedDiskTb} TB provisioned across ${metadata.instances} instances (analytical day 30)`,
    };
  }
  const cache = capacity.caches.find((item) => item.nodeId === nodeId);
  if (cache) {
    const fraction =
      cache.limitGbPerInstance > 0
        ? cache.perInstanceCapacityGb / cache.limitGbPerInstance
        : 0;
    return {
      fraction,
      label: 'Capacity',
      detail: `${cache.perInstanceCapacityGb.toFixed(1)} of ${cache.limitGbPerInstance.toFixed(1)} GB per instance (${cache.medium})`,
    };
  }
  return null;
}

export function imageMetadataShardSummary(node: ImageMetadataNode): {
  shardCount: number;
  divisible: boolean;
  logicalCapacityTb: number;
  provisionedDiskTb: number;
} {
  const { instances, replicas, diskTb } = node.config;
  const shardCount = replicas > 0 ? Math.floor(instances / replicas) : 0;
  return {
    shardCount,
    divisible: replicas > 0 && instances % replicas === 0,
    logicalCapacityTb: shardCount * diskTb,
    provisionedDiskTb: instances * diskTb,
  };
}

export function imageCacheLimit(node: ImageCacheNode): {
  perInstanceGb: number;
  limitGb: number;
  fits: boolean;
} {
  const perInstanceGb =
    node.config.instances > 0
      ? node.config.capacityGb / node.config.instances
      : Number.POSITIVE_INFINITY;
  const limitGb =
    node.config.medium === 'ram'
      ? IMAGE_CATALOG.instance.usableMemoryGb
      : (node.config.diskTb ?? 0) * IMAGE_CATALOG.cache.ssdCapacityGbPerTb;
  return { perInstanceGb, limitGb, fits: perInstanceGb <= limitGb };
}
