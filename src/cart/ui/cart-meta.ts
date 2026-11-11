import {
  Boxes,
  Layers,
  Monitor,
  Server,
  Database,
  FileText,
  type LucideIcon,
} from 'lucide-react';
import type { Edge, Node } from '@xyflow/react';

import {
  CART_CIRCUIT_MBPS,
  CART_LIMITS,
  CART_NODE_KIND_INFO,
  CART_REGION_INFO,
  CART_REGIONS,
  type CartCircuit,
  type CartCircuitMbps,
  type CartEdgeKind,
  type CartGraph,
  type CartNode,
  type CartNodeKind,
  type CartRegion,
} from '../index';

/** UI-only descriptions. They add no gameplay semantics. */
export interface CartKindUi {
  readonly label: string;
  readonly short: string;
  readonly description: string;
  readonly color: string;
  readonly icon: LucideIcon;
}

export const CART_KIND_UI: Readonly<Record<CartNodeKind, CartKindUi>> = {
  customers: {
    label: 'Customers',
    short: 'Customers',
    description:
      'Fixed traffic source for its region; it can connect only to that region’s Application.',
    color: '#0e7490',
    icon: Monitor,
  },
  application: {
    label: CART_NODE_KIND_INFO.application.label,
    short: 'Application',
    description:
      'Serves its region’s requests; exactly one per region, with 1–2 instances and a chosen size.',
    color: '#1d4ed8',
    icon: Server,
  },
  cache: {
    label: CART_NODE_KIND_INFO.cache.label,
    short: 'Cache',
    description:
      'Speeds up reads; can never confirm a write or a purchase.',
    color: '#b45309',
    icon: Layers,
  },
  journal: {
    label: CART_NODE_KIND_INFO.journal.label,
    short: 'Journal',
    description:
      'Saves every cart change durably; at most one per region.',
    color: '#7c3aed',
    icon: FileText,
  },
  store: {
    label: CART_NODE_KIND_INFO.store.label,
    short: 'Store',
    description:
      'Saves cart changes durably and keeps a precomputed view; at most one per region.',
    color: '#0f766e',
    icon: Database,
  },
  inventory: {
    label: CART_NODE_KIND_INFO.inventory.label,
    short: 'Inventory',
    description:
      'The single source of truth for stock and orders; exactly one in the whole design.',
    color: '#b42318',
    icon: Boxes,
  },
};

export const CART_ADDABLE_KINDS: readonly CartNodeKind[] = [
  'application',
  'cache',
  'journal',
  'store',
  'inventory',
];

export interface CartEdgeKindUi {
  readonly label: string;
  readonly description: string;
  readonly color: string;
  readonly dash?: string;
}

export const CART_EDGE_UI: Readonly<Record<CartEdgeKind, CartEdgeKindUi>> = {
  request: {
    label: 'Request path',
    description:
      'A one-way path that requests follow; replies return along the same path. Request paths may not loop.',
    color: '#0e7490',
  },
  replication: {
    label: 'Replication path',
    description:
      'One-way delivery of cart changes to a journal or cart store; retries are removed as duplicates.',
    color: '#7c3aed',
    dash: '7 4',
  },
};

export const CART_REGION_ORDER: readonly CartRegion[] = CART_REGIONS;

export function cartRegionLabel(region: CartRegion): string {
  return `${CART_REGION_INFO[region].label} · ${CART_REGION_INFO[region].city}`;
}

export function cartRegionShort(region: CartRegion): string {
  return CART_REGION_INFO[region].label;
}

export function cartNodeDisplayName(node: CartNode): string {
  return node.label?.trim() || CART_KIND_UI[node.kind].label;
}

export function cartNodeSummary(
  node: CartNode,
  graph?: CartGraph,
): readonly string[] {
  switch (node.kind) {
    case 'customers':
      return ['fixed traffic source', 'edits originate here'];
    case 'application': {
      const target = node.writeTarget
        ? graph?.nodes.find((item) => item.id === node.writeTarget)
        : undefined;
      let writes: string;
      if (!node.writeTarget) {
        writes = 'writes: not set';
      } else if (target) {
        writes = `writes to ${cartNodeDisplayName(target)} · ${cartRegionShort(target.region)}`;
      } else {
        writes = 'writes: configured';
      }
      return [
        `${node.size} · ${node.instances} instance${node.instances === 1 ? '' : 's'}`,
        writes,
        `reads: ${node.readPolicy === 'parallel' ? 'all targets in parallel' : 'local first'}`,
        `${node.readTargets.length} read target${node.readTargets.length === 1 ? '' : 's'}`,
      ];
    }
    case 'cache':
      return [`${node.size} · 1 s freshness`, 'speeds up reads'];
    case 'journal':
      return [`${node.size} · append-only log`, 'saves every cart change'];
    case 'store':
      return [`${node.size} · log + precomputed view`, 'saves cart data'];
    case 'inventory':
      return [`${node.size} · single source of truth`, 'holds stock and orders'];
  }
}

export function cartKindAddLimit(
  graph: CartGraph,
  kind: CartNodeKind,
  region: CartRegion,
): string | null {
  if (kind === 'customers') {
    return 'Customers are fixed and cannot be added.';
  }
  if (graph.nodes.length >= CART_LIMITS.maxNodes) {
    return `The design already has ${CART_LIMITS.maxNodes} components, the maximum.`;
  }
  if (kind === 'inventory') {
    if (graph.nodes.some((node) => node.kind === 'inventory')) {
      return 'Only one Inventory is allowed in the whole design.';
    }
    return null;
  }
  const existing = graph.nodes.find(
    (node) => node.kind === kind && node.region === region,
  );
  if (!existing) {
    return null;
  }
  if (kind === 'application') {
    return `${cartRegionShort(region)} already has an Application. Each region needs exactly one.`;
  }
  return `${cartRegionShort(region)} already has a ${CART_KIND_UI[kind].label}. Only one per region is allowed.`;
}

const NODE_ID_PREFIX: Readonly<Record<CartNodeKind, string>> = {
  customers: 'customers',
  application: 'app',
  cache: 'cache',
  journal: 'journal',
  store: 'store',
  inventory: 'inventory',
};

export function nextCartNodeId(
  graph: CartGraph,
  kind: CartNodeKind,
  region: CartRegion,
): string {
  const base = `${NODE_ID_PREFIX[kind]}-${region}`;
  const used = new Set(graph.nodes.map((node) => node.id));
  if (!used.has(base)) {
    return base;
  }
  let index = 2;
  while (used.has(`${base}-${index}`)) {
    index += 1;
  }
  return `${base}-${index}`;
}

const KIND_ROW: Readonly<Record<CartNodeKind, number>> = {
  customers: 70,
  application: 190,
  cache: 330,
  journal: 450,
  store: 570,
  inventory: 690,
};

export function cartDefaultPosition(
  graph: CartGraph,
  kind: CartNodeKind,
  region: CartRegion,
): { x: number; y: number } {
  const column = 80 + CART_REGION_INFO[region].ordinal * 400;
  let x = column;
  let y = KIND_ROW[kind];
  const crowded = (candidateX: number, candidateY: number) =>
    graph.nodes.some(
      (node) =>
        node.region === region &&
        Math.abs(node.position.x - candidateX) < 90 &&
        Math.abs(node.position.y - candidateY) < 70,
    );
  while (crowded(x, y)) {
    x += 220;
    if (x > column + 660) {
      x = column;
      y += 90;
    }
  }
  return { x, y };
}

export function cartCircuitKey(a: CartRegion, b: CartRegion): string {
  return CART_REGION_INFO[a].ordinal <= CART_REGION_INFO[b].ordinal
    ? `${a}|${b}`
    : `${b}|${a}`;
}

export const CART_CIRCUIT_PAIRS: ReadonlyArray<readonly [CartRegion, CartRegion]> = [
  ['us-west', 'eu-central'],
  ['us-west', 'ap-northeast'],
  ['eu-central', 'ap-northeast'],
];

export function cartCircuitFor(
  graph: CartGraph,
  a: CartRegion,
  b: CartRegion,
): CartCircuit | undefined {
  const key = cartCircuitKey(a, b);
  return graph.circuits.find(
    (circuit) => cartCircuitKey(circuit.regions[0], circuit.regions[1]) === key,
  );
}

export function cartCircuitLabel(
  graph: CartGraph,
  a: CartRegion,
  b: CartRegion,
): string {
  const circuit = cartCircuitFor(graph, a, b);
  return circuit
    ? `${circuit.mbps} Mbit/s per direction, shared`
    : 'No circuit purchased';
}

export function cartCircuitShortLabel(
  graph: CartGraph,
  a: CartRegion,
  b: CartRegion,
): string {
  const circuit = cartCircuitFor(graph, a, b);
  return circuit ? `${circuit.mbps} Mbit/s shared` : 'no circuit';
}

export function cartCircuitTiers(): readonly CartCircuitMbps[] {
  return CART_CIRCUIT_MBPS;
}

export function cartPairLabel(a: CartRegion, b: CartRegion): string {
  return `${CART_REGION_INFO[a].label} ↔ ${CART_REGION_INFO[b].label}`;
}

export interface CartConnectRequest {
  readonly from: string;
  readonly to: string;
  readonly kind?: CartEdgeKind;
}

export interface CartFlowNodeData extends Record<string, unknown> {
  node: CartNode;
  issueCount: number;
  /** Card facts resolved against the whole design (target names, not ids). */
  summary?: readonly string[];
}

export type CartFlowNode = Node<CartFlowNodeData, 'cart-node'>;

export interface CartFlowLaneData extends Record<string, unknown> {
  region: CartRegion;
  nodeCount: number;
  circuits: string;
  /** Measured circuit overload notes for this region, shown in the lane header. */
  hotNotes?: readonly string[];
}

export type CartFlowLane = Node<CartFlowLaneData, 'cart-lane'>;

export interface CartFlowEdgeData extends Record<string, unknown> {
  edge: import('../index').CartEdge;
  fromLabel: string;
  toLabel: string;
  crossRegion: boolean;
  roles?: string;
  circuit: string;
}

export type CartFlowEdge = Edge<CartFlowEdgeData, 'cart-edge'>;

/** Scenario requirements shown to players. */
export interface CartGateRow {
  readonly gate: string;
  readonly draft: string;
  readonly detail: string;
}

export const CART_GATE_ROWS: readonly CartGateRow[] = [
  {
    gate: 'Cart edits',
    draft: 'p95 < 50 ms · ≥ 99% success in every region',
    detail: 'Measured in each region, including the network and the durable save.',
  },
  {
    gate: 'Cart reads',
    draft: 'p95 ≤ 500 ms · ≥ 99% success in every region',
    detail: 'Measured in each region.',
  },
  {
    gate: 'Checkout',
    draft: 'p95 ≤ 750 ms · ≥ 99% success in every region',
    detail: 'Buys the whole basket or nothing.',
  },
  {
    gate: 'Safety',
    draft: 'No oversell · no double charge on a retry',
    detail: 'Checked throughout both scenarios.',
  },
  {
    gate: 'Budget',
    draft: 'Shopping Rush cost ≤ 6 credits/hour',
    detail: 'Among passing designs, the lowest Rush cost scores best.',
  },
];

export const CART_CANDIDATE_FAMILIES: readonly string[] = [
  'Regional caches and durable journals feeding a central cart store.',
  'Regional cart stores exchanging operations asynchronously.',
  'Regional cart stores with parallel reads that merge reachable data.',
];

export const CART_FIXED_RULES: readonly string[] = [
  'Dragging a component only moves it on screen; its region is set in Properties.',
  'Each region pair has one circuit, at 2, 8 or 32 Mbit/s per direction; all paths between that pair share it.',
  'Nothing is connected unless you draw it: every request, repair and replication path must be drawn.',
  'Customers only send requests to their own region’s Application; Inventory never starts a request.',
];

export const CART_KEYBOARD_HELP: readonly string[] = [
  'C opens the keyboard-friendly connection form.',
  'Delete or Backspace removes the selected component or path.',
  'Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z redoes.',
  'Escape clears the selection or closes the form.',
];

export function canSource(node: CartNode, kind: CartEdgeKind): boolean {
  if (kind === 'request') return node.kind !== 'inventory';
  return node.kind === 'application' || node.kind === 'journal' || node.kind === 'store';
}

export function canTarget(
  source: CartNode | undefined,
  node: CartNode,
  kind: CartEdgeKind,
): boolean {
  if (!source || node.id === source.id) return false;
  if (kind === 'request') {
    if (node.kind === 'customers') return false;
    if (source.kind === 'customers') {
      return node.kind === 'application' && node.region === source.region;
    }
    return true;
  }
  return node.kind === 'journal' || node.kind === 'store';
}
