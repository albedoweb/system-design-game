/**
 * Frame projection for the Global Cart results view (GC-014).
 *
 * Traffic telemetry arrives as bounded windows (`CartTrafficFrame`). This
 * module turns those windows into the chart/report series used by the results
 * panel and maps a physical link identity back to the semantic graph path that
 * shares it. It never re-bills bytes and never changes a measured total:
 * every number here is derived from the frame payload or the graph itself.
 */
import {
  CART_REGION_INFO,
  type CartCaseId,
  type CartCaseTelemetry,
  type CartGraph,
  type CartNode,
  type CartRegion,
  type CartTrafficClass,
  type CartTrafficFrame,
} from '../index';

export const CART_TRAFFIC_CLASS_LABELS: Readonly<Record<CartTrafficClass, string>> = {
  request: 'Request',
  reply: 'Reply',
  replication: 'Replication',
  repair: 'Repair',
  retry: 'Retry',
};

export const CART_TRAFFIC_CLASS_ORDER: readonly CartTrafficClass[] = [
  'request',
  'reply',
  'replication',
  'repair',
  'retry',
];

export interface CartSeriesPoint {
  readonly atMs: number;
  readonly windowMs: number;
  readonly sampled: boolean;
}

export interface CartNamedSeries {
  readonly label: string;
  readonly values: readonly (number | null)[];
}

export interface CartTrafficSeries {
  readonly points: readonly CartSeriesPoint[];
  readonly durationMs: number;
  readonly byClass: readonly CartNamedSeries[];
  readonly wan: readonly CartNamedSeries[];
}

export interface CartRegionBytes {
  readonly region: CartRegion;
  readonly label: string;
  readonly bytes: number;
  readonly byClass: Readonly<Record<CartTrafficClass, number>>;
}

export interface CartLinkRow {
  readonly linkId: string;
  readonly kind: 'client-access' | 'nic' | 'fabric' | 'wan';
  readonly label: string;
  readonly bytes: number;
  readonly peakBytesPerSecond: number;
  /** WAN circuit capacity from the submitted graph, when the link is WAN. */
  readonly capacityBitsPerSecond: number | null;
  /** Peak bytes/s divided by capacity; null when the capacity is not modeled. */
  readonly saturation: number | null;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
}

export interface CartRegionRow {
  readonly region: CartRegion;
  readonly label: string;
  readonly bytes: number;
  readonly byClass: Readonly<Record<CartTrafficClass, number>>;
}

function emptyClassBytes(): Record<CartTrafficClass, number> {
  return { request: 0, reply: 0, replication: 0, repair: 0, retry: 0 };
}

export function cartRegionName(region: CartRegion): string {
  const info = CART_REGION_INFO[region];
  return `${info.label} · ${info.city}`;
}

export function cartNodeName(node: CartNode): string {
  return node.label?.trim() || `${node.kind} ${node.id}`;
}

function nodeRegion(graph: CartGraph, nodeId: string): CartRegion | null {
  return graph.nodes.find((node) => node.id === nodeId)?.region ?? null;
}

/** Bytes in one frame attributed to the region that actually carried them. */
export function cartFrameRegionBytes(
  frame: CartTrafficFrame,
  graph: CartGraph,
): Readonly<Record<CartRegion, number>> {
  const totals: Record<CartRegion, number> = {
    'us-west': 0,
    'eu-central': 0,
    'ap-northeast': 0,
  };
  for (const node of frame.nodes) {
    const region =
      node.region === null
        ? node.role === 'node'
          ? nodeRegion(graph, node.id)
          : null
        : (node.region as CartRegion);
    if (region !== null) totals[region] += node.bytes;
  }
  return totals;
}

export function buildCartTrafficSeries(telemetry: CartCaseTelemetry): CartTrafficSeries {
  const points: CartSeriesPoint[] = telemetry.frames.map((frame) => ({
    atMs: frame.windowEndUs / 1_000,
    windowMs: frame.windowUs / 1_000,
    sampled: frame.sampled,
  }));
  const durationMs =
    telemetry.frames.length === 0
      ? 1
      : Math.max(
          1,
          (telemetry.frames[telemetry.frames.length - 1]?.windowEndUs ?? 0) / 1_000,
        );
  const byClass: CartNamedSeries[] = CART_TRAFFIC_CLASS_ORDER.map((trafficClass) => ({
    label: CART_TRAFFIC_CLASS_LABELS[trafficClass],
    values: telemetry.frames.map((frame) =>
      frame.windowUs === 0 ? null : (frame.bytes[trafficClass] * 1_000_000) / frame.windowUs,
    ),
  }));
  return {
    points,
    durationMs,
    byClass,
    wan: [
      {
        label: 'Between regions',
        values: telemetry.frames.map((frame) =>
          frame.windowUs === 0 ? null : (frame.wanBillableBytes * 1_000_000) / frame.windowUs,
        ),
      },
    ],
  };
}

/**
 * Semantic edges that share a physical circuit. Physical circuits are shared by
 * direction, so both directions of the pair contribute their graph paths.
 */
function crossingEdges(graph: CartGraph, regions: readonly CartRegion[]): string[] {
  const ids: string[] = [];
  for (const edge of graph.edges) {
    const from = nodeRegion(graph, edge.from);
    const to = nodeRegion(graph, edge.to);
    if (from === null || to === null) continue;
    if (from === to) continue;
    if (regions.includes(from) && regions.includes(to)) ids.push(edge.id);
  }
  return ids;
}

function endpointNodes(graph: CartGraph, regions: readonly CartRegion[]): string[] {
  const ids = new Set<string>();
  for (const edge of graph.edges) {
    const from = nodeRegion(graph, edge.from);
    const to = nodeRegion(graph, edge.to);
    if (from === null || to === null) continue;
    if (from !== to && regions.includes(from) && regions.includes(to)) {
      ids.add(edge.from);
      ids.add(edge.to);
    }
  }
  return [...ids].sort();
}

function wanPairRegions(pair: string): CartRegion[] {
  const regions: CartRegion[] = [];
  for (const region of Object.keys(CART_REGION_INFO) as CartRegion[]) {
    if (pair.split('|').includes(region)) regions.push(region);
  }
  return regions;
}

/** Human label for a physical link, plus the semantic graph path behind it. */
export function cartLinkPath(
  linkId: string,
  graph: CartGraph,
): { label: string; kind: CartLinkRow['kind']; nodeIds: string[]; edgeIds: string[] } {
  const [prefix, first, second] = linkId.split(':');
  switch (prefix) {
    case 'nic': {
      const node = graph.nodes.find((item) => item.id === first);
      const direction = second ?? '';
      return {
        label: `${node ? cartNodeName(node) : (first ?? linkId)} network interface · ${direction}`,
        kind: 'nic',
        nodeIds: first ? [first] : [],
        edgeIds: [],
      };
    }
    case 'client-access': {
      const region = first as CartRegion | undefined;
      return {
        label: `${region && region in CART_REGION_INFO ? cartRegionName(region) : (first ?? '')} client access · ${second ?? ''}`,
        kind: 'client-access',
        nodeIds: region ? graph.nodes.filter((node) => node.region === region).map((node) => node.id) : [],
        edgeIds: [],
      };
    }
    case 'fabric': {
      const region = first as CartRegion | undefined;
      return {
        label: `${region && region in CART_REGION_INFO ? cartRegionName(region) : (first ?? '')} regional fabric`,
        kind: 'fabric',
        nodeIds: region ? graph.nodes.filter((node) => node.region === region).map((node) => node.id) : [],
        edgeIds: [],
      };
    }
    case 'wan': {
      const pair = first ?? '';
      const regions = wanPairRegions(pair);
      const nodeIds = endpointNodes(graph, regions);
      const edgeIds = crossingEdges(graph, regions);
      const connecting = graph.edges.find((edge) => edgeIds.includes(edge.id));
      const pathLabel =
        connecting === undefined
          ? regions.length === 2
            ? `${cartRegionName(regions[0]!)} ↔ ${cartRegionName(regions[1]!)}`
            : pair
          : `${cartNodeName(graph.nodes.find((node) => node.id === connecting.from)!)} ↔ ${cartNodeName(graph.nodes.find((node) => node.id === connecting.to)!)}`;
      return {
        label: `${pathLabel} WAN · ${second ?? ''}`,
        kind: 'wan',
        nodeIds,
        edgeIds,
      };
    }
    default:
      return { label: linkId, kind: 'fabric', nodeIds: [], edgeIds: [] };
  }
}

/** Circuit capacity for one WAN link, read from the submitted graph. */
export function cartWanCapacityBitsPerSecond(linkId: string, graph: CartGraph): number | null {
  const [prefix, pair] = linkId.split(':');
  if (prefix !== 'wan' || pair === undefined) return null;
  const regions = wanPairRegions(pair);
  if (regions.length !== 2) return null;
  for (const circuit of graph.circuits) {
    const [left, right] = circuit.regions;
    if (
      (left === regions[0] && right === regions[1]) ||
      (left === regions[1] && right === regions[0])
    ) {
      return circuit.mbps * 1_000_000;
    }
  }
  return null;
}

/** Per-link totals and peak rate, with circuit saturation where it exists. */
export function buildCartLinkRows(
  telemetry: CartCaseTelemetry,
  graph: CartGraph,
): CartLinkRow[] {
  const totals = new Map<string, number>();
  const peaks = new Map<string, number>();
  for (const frame of telemetry.frames) {
    for (const link of frame.links) {
      totals.set(link.linkId, (totals.get(link.linkId) ?? 0) + link.bytes);
      const rate = frame.windowUs === 0 ? 0 : (link.bytes * 1_000_000) / frame.windowUs;
      peaks.set(link.linkId, Math.max(peaks.get(link.linkId) ?? 0, rate));
    }
  }
  const rows: CartLinkRow[] = [];
  for (const [linkId, bytes] of totals) {
    const path = cartLinkPath(linkId, graph);
    const capacity = cartWanCapacityBitsPerSecond(linkId, graph);
    const peak = peaks.get(linkId) ?? 0;
    rows.push({
      linkId,
      kind: path.kind,
      label: path.label,
      bytes,
      peakBytesPerSecond: peak,
      capacityBitsPerSecond: capacity,
      saturation: capacity === null || capacity === 0 ? null : (peak * 8) / capacity,
      nodeIds: path.nodeIds,
      edgeIds: path.edgeIds,
    });
  }
  const kindRank: Record<CartLinkRow['kind'], number> = {
    wan: 0,
    nic: 1,
    fabric: 2,
    'client-access': 3,
  };
  return rows.sort((left, right) => {
    if (kindRank[left.kind] !== kindRank[right.kind]) {
      return kindRank[left.kind] - kindRank[right.kind];
    }
    return left.linkId < right.linkId ? -1 : left.linkId > right.linkId ? 1 : 0;
  });
}

/** Per-region bytes for the selected case, split by the five traffic classes. */
export function buildCartRegionRows(
  telemetry: CartCaseTelemetry,
  graph: CartGraph,
): CartRegionRow[] {
  const byRegion = new Map<CartRegion, { bytes: number; byClass: Record<CartTrafficClass, number> }>();
  for (const frame of telemetry.frames) {
    // Class attribution is available per node; region attribution already is.
    const regions = cartFrameRegionBytes(frame, graph);
    for (const node of frame.nodes) {
      const region =
        node.region === null ? nodeRegion(graph, node.id) : (node.region as CartRegion);
      if (region === null) continue;
      const bucket = byRegion.get(region) ?? { bytes: 0, byClass: emptyClassBytes() };
      for (const trafficClass of CART_TRAFFIC_CLASS_ORDER) {
        bucket.byClass[trafficClass] += node.byClass[trafficClass];
      }
      byRegion.set(region, bucket);
    }
    for (const [region, bytes] of Object.entries(regions) as Array<[CartRegion, number]>) {
      const bucket = byRegion.get(region) ?? { bytes: 0, byClass: emptyClassBytes() };
      bucket.bytes += bytes;
      byRegion.set(region, bucket);
    }
  }
  return (Object.keys(CART_REGION_INFO) as CartRegion[])
    .map((region) => {
      const bucket = byRegion.get(region) ?? { bytes: 0, byClass: emptyClassBytes() };
      return {
        region,
        label: cartRegionName(region),
        bytes: bucket.bytes,
        byClass: bucket.byClass,
      };
    })
    .filter((item) => item.bytes > 0);
}

export function emptyCartCaseTraffic(caseId: CartCaseId): CartCaseTelemetry {
  return {
    levelId: 'global-cart',
    caseId,
    complete: false,
    frames: [],
    totals: {
      serializedBytes: 0,
      wanBillableBytes: 0,
      localSerializedBytes: 0,
      byClass: emptyClassBytes(),
      byCircuit: [],
      byteEvents: 0,
      transfers: 0,
    },
    trace: {
      caseId,
      events: [],
      totalEvents: 0,
      retainedEvents: 0,
      truncated: false,
      digest: '0'.repeat(64),
    },
    windowCount: 0,
    measuredEndUs: 0,
    issues: [],
  };
}
