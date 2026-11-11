import type {
  ImageEdge,
  ImageGraph,
  ImageNode,
  ImageNodeKind,
  ImageOperation,
} from '../contracts';
import { IMAGE_LEVEL } from '../level';
import { IMAGE_OPERATION_META, IMAGE_REGION_LABELS } from './image-meta';

/**
 * Operations that make sense for a chosen source/target pair. The canvas keeps
 * one output and one input connector, so the operation belongs to the route.
 * Existing operations on the same pair are removed from the list, which makes a
 * single remaining option unambiguous.
 */
export function imageConnectionCandidates(
  source: ImageNode,
  target: ImageNode,
  existing: readonly ImageEdge[],
): ImageOperation[] {
  const used = new Set(existing.map((edge) => edge.operation));
  const options = imageAllowedOperations(source.kind, target.kind);
  return options.filter((operation) => !used.has(operation));
}

export function imageAllowedOperations(
  sourceKind: ImageNodeKind,
  targetKind: ImageNodeKind,
): ImageOperation[] {
  if (targetKind === 'client' || sourceKind === 'blob') {
    return [];
  }
  if (sourceKind === 'client' && targetKind === 'app') {
    return ['traffic'];
  }
  if (sourceKind === 'app' && targetKind === 'metadata') {
    return ['metadata'];
  }
  if (sourceKind === 'metadata' && targetKind === 'metadata') {
    return ['replicate'];
  }
  if (
    (sourceKind === 'client' && targetKind === 'blob') ||
    (sourceKind === 'app' && (targetKind === 'blob' || targetKind === 'cache')) ||
    (sourceKind === 'cache' && targetKind === 'blob')
  ) {
    return ['blob'];
  }
  return [];
}

export function imageConnectionExplanation(
  sourceKind: ImageNodeKind,
  targetKind: ImageNodeKind,
): string {
  if (targetKind === 'client') {
    return 'Nothing can point at a fixed Client population: it only emits traffic and blob routes.';
  }
  if (sourceKind === 'blob') {
    return 'The fixed provider endpoint cannot start a route. Reads are app or client → blob, and a cache fetches from a provider.';
  }
  if (sourceKind === 'client') {
    return targetKind === 'app'
      ? 'A client population can send traffic to an app pool.'
      : targetKind === 'blob'
        ? 'A client population can read bytes directly from a provider endpoint.'
        : 'A client can only reach app pools and blob endpoints.';
  }
  if (sourceKind === 'app') {
    if (targetKind === 'metadata') {
      return 'An app selects exactly one metadata store for reads and new uploads.';
    }
    if (targetKind === 'blob' || targetKind === 'cache') {
      return 'A proxy app carries bytes to one provider or through one cache.';
    }
    return 'App pools do not connect to each other: an app reaches metadata, a provider endpoint or one cache. These two nodes cannot be connected.';
  }
  if (sourceKind === 'cache') {
    return targetKind === 'blob'
      ? 'A cache fills from exactly one provider endpoint.'
      : 'A cache only fetches from a provider endpoint.';
  }
  if (targetKind === 'metadata') {
    return 'A metadata store replicates its origin log to another metadata store.';
  }
  return 'A metadata store only replicates to another metadata store. These two nodes cannot be connected.';
}

/** A second connect on the same pair must not silently duplicate a route. */
export function imagePairEdges(
  graph: ImageGraph,
  sourceId: string,
  targetId: string,
): ImageEdge[] {
  return graph.edges.filter(
    (edge) => edge.source === sourceId && edge.target === targetId,
  );
}

export interface ImageEdgeLane {
  offset: number;
  index: number;
  total: number;
}

/**
 * Parallel routes on the same node pair are separated and always carry a text
 * label, so an operation is never communicated by colour alone.
 */
export function imageEdgeLanes(
  edges: readonly ImageEdge[],
): ReadonlyMap<string, ImageEdgeLane> {
  const groups = new Map<string, ImageEdge[]>();
  for (const edge of edges) {
    const key = `${edge.source}\u0000${edge.target}`;
    const list = groups.get(key) ?? [];
    list.push(edge);
    groups.set(key, list);
  }
  const result = new Map<string, ImageEdgeLane>();
  for (const list of groups.values()) {
    const sorted = [...list].sort(
      (left, right) =>
        IMAGE_OPERATION_META[left.operation].order -
          IMAGE_OPERATION_META[right.operation].order ||
        left.id.localeCompare(right.id),
    );
    const total = sorted.length;
    sorted.forEach((edge, index) => {
      result.set(edge.id, {
        offset: (index - (total - 1) / 2) * 54,
        index,
        total,
      });
    });
  }
  return result;
}

/**
 * Accessible reminder attached to every logical edge. A visual arrow is a
 * logical route, never its own cable: region pairs are single shared channels.
 */
export function imageLogicalEdgeNote(operation: ImageOperation): string {
  return `${IMAGE_OPERATION_META[operation].label} is a logical route. It shares physical channels: a region pair is one shared 100 Gbit/s full-duplex link and each instance has a 10 Gbit/s NIC, so this arrow never adds bandwidth.`;
}

export interface ImageRegionPairLink {
  id: string;
  between: string;
  bandwidthGbitPerSec: number;
  oneWayLatencyMs: number;
}

/** Frozen full-mesh region pairs, shown on the canvas lane headers. */
export const IMAGE_REGION_PAIR_LINKS: readonly ImageRegionPairLink[] =
  IMAGE_LEVEL.network.interRegionLinks.map((link) => ({
    id: `${link.a}-${link.b}`,
    between: `${IMAGE_REGION_LABELS[link.a]} ↔ ${IMAGE_REGION_LABELS[link.b]}`,
    bandwidthGbitPerSec: link.bandwidthGbitPerSec,
    oneWayLatencyMs: link.oneWayLatencyMs,
  }));

export function imageNodeEndpointLabel(
  graph: ImageGraph,
  nodeId: string,
): string {
  return graph.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
}
