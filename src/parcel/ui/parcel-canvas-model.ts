import type {
  ParcelEdge,
  ParcelGraph,
  ParcelNode,
  ParcelNodeKind,
  ParcelOperation,
} from '../contracts';
import { PARCEL_BUSINESS_OPERATIONS } from '../contracts';

const BUSINESS_ORDER: readonly ParcelOperation[] = PARCEL_BUSINESS_OPERATIONS;

function isStoreKind(kind: ParcelNodeKind): boolean {
  return kind === 'sql' || kind === 'kv' || kind === 'columnar';
}

/**
 * Operations that make sense for a chosen source/target pair. The UI keeps a
 * single connector per side; the operation belongs to the route, never to a
 * hidden port taxonomy. Existing operations are removed so a second connect
 * can auto-pick the one missing business route when it is unambiguous.
 */
export function parcelConnectionCandidates(
  source: ParcelNode,
  target: ParcelNode,
  existing: readonly ParcelEdge[],
): ParcelOperation[] {
  const used = new Set(existing.map((edge) => edge.operation));
  if (source.kind === 'client' && target.kind === 'app') {
    return used.has('traffic') ? [] : ['traffic'];
  }
  if (source.kind === 'app' && isStoreKind(target.kind)) {
    return BUSINESS_ORDER.filter((operation) => !used.has(operation));
  }
  if (isStoreKind(source.kind) && isStoreKind(target.kind)) {
    return used.has('replicate') ? [] : ['replicate'];
  }
  return [];
}

export function parcelConnectionExplanation(
  sourceKind: ParcelNodeKind,
  targetKind: ParcelNodeKind,
): string {
  if (sourceKind === 'client') {
    return targetKind === 'app'
      ? 'The client can send traffic to the application.'
      : 'The client can only send traffic to the application.';
  }
  if (sourceKind === 'app') {
    return isStoreKind(targetKind)
      ? 'The application can send ingest, status, history and report routes to a store.'
      : 'The application sends business routes to stores only.';
  }
  if (isStoreKind(sourceKind)) {
    return isStoreKind(targetKind)
      ? 'A store can asynchronously replicate to another store.'
      : 'A store can only replicate to another store.';
  }
  return 'These nodes cannot be connected.';
}

export function parcelPairEdges(
  graph: ParcelGraph,
  sourceId: string,
  targetId: string,
): ParcelEdge[] {
  return graph.edges.filter(
    (edge) => edge.source === sourceId && edge.target === targetId,
  );
}

export interface ParcelEdgeLane {
  offset: number;
  index: number;
  total: number;
}

/**
 * Parallel routes on the same node pair are separated by a perpendicular
 * offset and always carry a text label, so operation is never color-only.
 */
export function parcelEdgeLanes(
  edges: readonly ParcelEdge[],
): ReadonlyMap<string, ParcelEdgeLane> {
  const groups = new Map<string, ParcelEdge[]>();
  for (const edge of edges) {
    const key = `${edge.source}\u0000${edge.target}`;
    const list = groups.get(key) ?? [];
    list.push(edge);
    groups.set(key, list);
  }
  const result = new Map<string, ParcelEdgeLane>();
  for (const list of groups.values()) {
    const sorted = [...list].sort(
      (a, b) =>
        PARCEL_OPERATION_ORDER[a.operation] -
          PARCEL_OPERATION_ORDER[b.operation] ||
        a.id.localeCompare(b.id),
    );
    const total = sorted.length;
    sorted.forEach((edge, index) => {
      result.set(edge.id, {
        offset: (index - (total - 1) / 2) * 56,
        index,
        total,
      });
    });
  }
  return result;
}

export const PARCEL_OPERATION_ORDER: Readonly<Record<ParcelOperation, number>> = {
  traffic: 0,
  ingest: 1,
  status: 2,
  history: 3,
  report: 4,
  replicate: 5,
};

export function parcelNodeRouteSummary(graph: ParcelGraph, nodeId: string) {
  const outgoing = graph.edges.filter((edge) => edge.source === nodeId);
  const incoming = graph.edges.filter((edge) => edge.target === nodeId);
  return { outgoing, incoming };
}
