import { create } from 'zustand';

import {
  CART_DEFAULT_SEED,
  CART_LIMITS,
  CART_MAX_SEED,
  CART_REGION_INFO,
  createCartStarterGraph,
  type CartApplicationNode,
  type CartCircuitMbps,
  type CartEdge,
  type CartEdgeKind,
  type CartGraph,
  type CartIssue,
  type CartNode,
  type CartNodeKind,
  type CartReadPolicy,
  type CartRegion,
  type CartServiceSize,
} from '../index';
import {
  cartCircuitKey,
  cartDefaultPosition,
  cartKindAddLimit,
  nextCartNodeId,
} from './cart-meta';

export type CartSelection =
  | { type: 'node'; id: string }
  | { type: 'edge'; id: string }
  | null;

export interface CartMutation {
  ok: boolean;
  message?: string;
  issues?: CartIssue[];
  id?: string;
}

export interface CartEditorState {
  graph: CartGraph;
  selection: CartSelection;
  past: CartGraph[];
  future: CartGraph[];
  revision: number;
  pendingMove: CartGraph | null;
  addNode: (kind: CartNodeKind, region: CartRegion) => CartMutation;
  removeNode: (id: string) => CartMutation;
  removeEdge: (id: string) => CartMutation;
  updateNodeLabel: (id: string, label: string) => CartMutation;
  updateNodeRegion: (id: string, region: CartRegion) => CartMutation;
  updateServiceSize: (id: string, size: CartServiceSize) => CartMutation;
  updateApplication: (
    id: string,
    patch: {
      instances?: 1 | 2;
      writeTarget?: string;
      readPolicy?: CartReadPolicy;
      readTargets?: string[];
    },
  ) => CartMutation;
  toggleReadTarget: (applicationId: string, targetId: string) => CartMutation;
  addEdge: (from: string, to: string, kind: CartEdgeKind) => CartMutation;
  setCircuit: (
    a: CartRegion,
    b: CartRegion,
    mbps: CartCircuitMbps | null,
  ) => CartMutation;
  setSeed: (seed: number) => void;
  moveNode: (id: string, position: { x: number; y: number }) => void;
  endMove: () => void;
  select: (selection: CartSelection) => void;
  clearSelection: () => void;
  undo: () => void;
  redo: () => void;
  resetGraph: () => void;
  replaceGraph: (graph: CartGraph) => void;
}

const HISTORY_LIMIT = 50;
const DURABLE_KINDS = new Set<CartNodeKind>(['journal', 'store']);
const READ_TARGET_KINDS = new Set<CartNodeKind>([
  'journal',
  'store',
  'application',
]);

function cloneGraph(graph: CartGraph): CartGraph {
  return JSON.parse(JSON.stringify(graph)) as CartGraph;
}

function commit(
  state: CartEditorState,
  graph: CartGraph,
  selection: CartSelection = state.selection,
): Partial<CartEditorState> {
  return {
    graph,
    selection,
    past: [...state.past, state.graph].slice(-HISTORY_LIMIT),
    future: [],
    revision: state.revision + 1,
    pendingMove: null,
  };
}

function findNode(graph: CartGraph, id: string): CartNode | undefined {
  return graph.nodes.find((node) => node.id === id);
}

function nextEdgeId(graph: CartGraph): string {
  const used = new Set(graph.edges.map((edge) => edge.id));
  let index = 1;
  while (used.has(`edge-${index}`)) {
    index += 1;
  }
  return `edge-${index}`;
}

function clampPosition(value: number): number {
  return Math.min(
    CART_LIMITS.position.max,
    Math.max(CART_LIMITS.position.min, Math.round(value)),
  );
}

function withLabel(node: CartNode, label: string): CartNode {
  const trimmed = label.trim().slice(0, CART_LIMITS.labelMaxLength);
  const next = { ...node };
  if (trimmed.length === 0) {
    delete next.label;
  } else {
    next.label = trimmed;
  }
  return next;
}

function replaceNode(graph: CartGraph, next: CartNode): CartGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === next.id ? next : node)),
  };
}

function regionHasService(
  graph: CartGraph,
  region: CartRegion,
  kind: CartNodeKind,
  exceptId?: string,
): boolean {
  return graph.nodes.some(
    (node) =>
      node.region === region &&
      node.kind === kind &&
      node.id !== exceptId,
  );
}

function regionConflict(
  graph: CartGraph,
  region: CartRegion,
  kind: CartNodeKind,
  exceptId?: string,
): string | null {
  if (!regionHasService(graph, region, kind, exceptId)) {
    return null;
  }
  if (kind === 'application') {
    return `That region already has an Application. A qualifying graph has exactly one per region.`;
  }
  if (kind === 'inventory') {
    return 'Only one Inventory node is allowed in the whole graph.';
  }
  if (kind === 'cache' || kind === 'journal' || kind === 'store') {
    return `That region already has a ${kind}. At most one is allowed per region.`;
  }
  return 'That region already contains this component.';
}

function sanitizeReadTargets(
  graph: CartGraph,
  application: CartApplicationNode,
  candidates: readonly string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of candidates) {
    if (id === application.id || seen.has(id)) continue;
    const target = findNode(graph, id);
    if (!target || !READ_TARGET_KINDS.has(target.kind)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= CART_LIMITS.maxReadTargets) break;
  }
  return result;
}

export const useCartStore = create<CartEditorState>((set, get) => ({
  graph: createCartStarterGraph(),
  selection: null,
  past: [],
  future: [],
  revision: 0,
  pendingMove: null,

  addNode: (kind, region) => {
    const state = get();
    const limit = cartKindAddLimit(state.graph, kind, region);
    if (limit) {
      return { ok: false, message: limit };
    }
    const id = nextCartNodeId(state.graph, kind, region);
    const position = cartDefaultPosition(state.graph, kind, region);
    let node: CartNode;
    if (kind === 'application') {
      node = {
        id,
        kind,
        region,
        position,
        size: 'S',
        instances: 1,
        writeTarget: '',
        readPolicy: 'local-repair',
        readTargets: [],
      };
    } else if (kind === 'customers') {
      return {
        ok: false,
        message: 'Regional customer sources are fixed and cannot be added.',
      };
    } else {
      node = { id, kind, region, position, size: 'S' };
    }
    const graph: CartGraph = { ...state.graph, nodes: [...state.graph.nodes, node] };
    set(commit(state, graph, { type: 'node', id }));
    return {
      ok: true,
      id,
      message:
        kind === 'application'
          ? 'Application added. Configure its write target and at least one read target, then draw the request paths.'
          : 'Component added. Draw every request and replication path it needs.',
    };
  },

  removeNode: (id) => {
    const state = get();
    const node = findNode(state.graph, id);
    if (!node) {
      return { ok: false, message: 'That component no longer exists.' };
    }
    if (node.kind === 'customers') {
      return {
        ok: false,
        message: 'Regional customer sources are fixed and cannot be deleted.',
      };
    }
    const nodes = state.graph.nodes
      .filter((item) => item.id !== id)
      .map((item) => {
        if (item.kind !== 'application') return item;
        return {
          ...item,
          writeTarget: item.writeTarget === id ? '' : item.writeTarget,
          readTargets: item.readTargets.filter((target) => target !== id),
        };
      });
    const graph: CartGraph = {
      ...state.graph,
      nodes,
      edges: state.graph.edges.filter(
        (edge) => edge.from !== id && edge.to !== id,
      ),
    };
    const selection =
      state.selection?.type === 'node' && state.selection.id === id
        ? null
        : state.selection;
    set(commit(state, graph, selection));
    return { ok: true };
  },

  removeEdge: (id) => {
    const state = get();
    if (!state.graph.edges.some((edge) => edge.id === id)) {
      return { ok: false, message: 'That path no longer exists.' };
    }
    const removed = state.graph.edges.find((edge) => edge.id === id)!;
    const graph: CartGraph = {
      ...state.graph,
      nodes: state.graph.nodes.map((node) => node.kind === 'application' && node.id === removed.from && removed.kind === 'request'
        ? { ...node, readTargets: node.readTargets.filter((target) => target !== removed.to), writeTarget: node.writeTarget === removed.to ? '' : node.writeTarget }
        : node),
      edges: state.graph.edges.filter((edge) => edge.id !== id),
    };
    const selection =
      state.selection?.type === 'edge' && state.selection.id === id
        ? null
        : state.selection;
    set(commit(state, graph, selection));
    return { ok: true };
  },

  updateNodeLabel: (id, label) => {
    const state = get();
    const node = findNode(state.graph, id);
    if (!node) {
      return { ok: false, message: 'That component no longer exists.' };
    }
    set(commit(state, replaceNode(state.graph, withLabel(node, label))));
    return { ok: true };
  },

  updateNodeRegion: (id, region) => {
    const state = get();
    const node = findNode(state.graph, id);
    if (!node) {
      return { ok: false, message: 'That component no longer exists.' };
    }
    if (node.kind === 'customers') {
      return {
        ok: false,
        message:
          'A customer source is fixed to its region. Its canonical id encodes the location.',
      };
    }
    const conflict = regionConflict(state.graph, region, node.kind, id);
    if (conflict) {
      return { ok: false, message: conflict };
    }
    const position = cartDefaultPosition(state.graph, node.kind, region);
    set(commit(state, replaceNode(state.graph, { ...node, region, position })));
    return { ok: true };
  },

  updateServiceSize: (id, size) => {
    const state = get();
    const node = findNode(state.graph, id);
    if (!node || node.kind === 'customers') {
      return {
        ok: false,
        message: 'Customer sources have no selectable size.',
      };
    }
    const service: CartNode = { ...node, size };
    set(commit(state, replaceNode(state.graph, service)));
    return { ok: true };
  },

  updateApplication: (id, patch) => {
    const state = get();
    const node = findNode(state.graph, id);
    if (!node || node.kind !== 'application') {
      return { ok: false, message: 'Select an Application to edit these settings.' };
    }
    if (patch.writeTarget !== undefined && patch.writeTarget !== '') {
      const target = findNode(state.graph, patch.writeTarget);
      if (!target) {
        return { ok: false, message: 'That write target no longer exists.' };
      }
      if (!DURABLE_KINDS.has(target.kind)) {
        return {
          ok: false,
          message:
            'A write target must be a durable journal or cart store. A cache cannot acknowledge durability.',
        };
      }
    }
    const next: CartApplicationNode = {
      ...node,
      ...(patch.instances === undefined ? {} : { instances: patch.instances }),
      ...(patch.writeTarget === undefined
        ? {}
        : { writeTarget: patch.writeTarget }),
      ...(patch.readPolicy === undefined ? {} : { readPolicy: patch.readPolicy }),
      ...(patch.readTargets === undefined
        ? {}
        : {
            readTargets: sanitizeReadTargets(
              state.graph,
              node,
              patch.readTargets,
            ),
          }),
    };
    let graph = replaceNode(state.graph, next);
    const targets = new Set([...next.readTargets, ...(next.writeTarget ? [next.writeTarget] : [])]);
    const previousTargets = new Set([...node.readTargets, node.writeTarget]);
    graph = { ...graph, edges: graph.edges.filter((edge) => !(edge.kind === 'request' && edge.from === id && previousTargets.has(edge.to) && !targets.has(edge.to))) };
    for (const target of targets) {
      if (graph.edges.some((edge) => edge.kind === 'request' && edge.from === id && edge.to === target)) continue;
      if (graph.edges.length >= CART_LIMITS.maxEdges) return { ok: false, message: 'Remove a path before adding another target.' };
      graph = { ...graph, edges: [...graph.edges, { id: nextEdgeId(graph), from: id, to: target, kind: 'request' }] };
    }
    set(commit(state, graph));
    return { ok: true };
  },

  toggleReadTarget: (applicationId, targetId) => {
    const state = get();
    const node = findNode(state.graph, applicationId);
    if (!node || node.kind !== 'application') {
      return { ok: false, message: 'Select an Application first.' };
    }
    if (node.readTargets.includes(targetId)) {
      return get().updateApplication(applicationId, {
        readTargets: node.readTargets.filter((id) => id !== targetId),
      });
    }
    if (node.readTargets.length >= CART_LIMITS.maxReadTargets) {
      return {
        ok: false,
        message: `An Application may name at most ${CART_LIMITS.maxReadTargets} read targets.`,
      };
    }
    return get().updateApplication(applicationId, {
      readTargets: [...node.readTargets, targetId],
    });
  },

  addEdge: (from, to, kind) => {
    const state = get();
    const graph = state.graph;
    if (graph.edges.length >= CART_LIMITS.maxEdges) {
      return {
        ok: false,
        message: `The graph already has ${CART_LIMITS.maxEdges} paths — that is the limit.`,
      };
    }
    const source = findNode(graph, from);
    const target = findNode(graph, to);
    if (!source || !target) {
      return { ok: false, message: 'Choose two existing components.' };
    }
    if (source.id === target.id) {
      return { ok: false, message: 'A component cannot connect to itself.' };
    }
    if (
      graph.edges.some(
        (edge) =>
          edge.from === from && edge.to === to && edge.kind === kind,
      )
    ) {
      return {
        ok: false,
        message: `A ${kind} path already exists between these two components. Duplicate semantic paths are rejected.`,
      };
    }
    if (kind === 'request') {
      if (source.kind === 'customers') {
        if (!(target.kind === 'application' && target.region === source.region)) {
          return {
            ok: false,
            message:
              'A customer source may only connect to its own region’s Application.',
          };
        }
      } else if (target.kind === 'customers') {
        return {
          ok: false,
          message: 'Requests cannot target the customer source.',
        };
      } else if (source.kind === 'inventory') {
        return {
          ok: false,
          message:
            'Inventory answers transactions; it cannot start a request path.',
        };
      }
    } else {
      if (
        source.kind === 'customers' ||
        source.kind === 'cache' ||
        source.kind === 'inventory'
      ) {
        return {
          ok: false,
          message: `A ${source.kind} node cannot originate replication.`,
        };
      }
      if (!DURABLE_KINDS.has(target.kind)) {
        return {
          ok: false,
          message:
            'Replication must target a durable journal or cart store, not a cache, Application or customer source.',
        };
      }
    }
    const edge: CartEdge = {
      id: nextEdgeId(graph),
      from,
      to,
      kind,
    };
    let nextGraph: CartGraph = { ...graph, edges: [...graph.edges, edge] };
    if (kind === 'request' && source.kind === 'application' && READ_TARGET_KINDS.has(target.kind)) {
      if (!source.readTargets.includes(to) && source.readTargets.length >= CART_LIMITS.maxReadTargets) {
        return { ok: false, message: 'Remove a read target before connecting another.' };
      }
      nextGraph = replaceNode(nextGraph, {
        ...source,
        readTargets: [...new Set([...source.readTargets, to])],
        writeTarget: source.writeTarget || (DURABLE_KINDS.has(target.kind) ? to : ''),
      });
    }
    const crossRegion = source.region !== target.region;
    const circuitMissing =
      crossRegion && !graph.circuits.some((circuit) =>
        cartCircuitKey(circuit.regions[0], circuit.regions[1]) ===
        cartCircuitKey(source.region, target.region),
      );
    set(commit(state, nextGraph, { type: 'edge', id: edge.id }));
    return {
      ok: true,
      id: edge.id,
      message: circuitMissing
        ? 'Path added, but the region pair has no purchased circuit yet. Buy one in the circuit settings; cross-region edges cannot run without it.'
        : `${kind === 'request' ? 'Request path' : 'Replication path'} added. Multiple arrows on one region pair share the same circuit capacity.`,
    };
  },

  setCircuit: (a, b, mbps) => {
    const state = get();
    if (a === b) {
      return { ok: false, message: 'A circuit needs two different regions.' };
    }
    const key = cartCircuitKey(a, b);
    const remaining = state.graph.circuits.filter(
      (circuit) =>
        cartCircuitKey(circuit.regions[0], circuit.regions[1]) !== key,
    );
    if (mbps === null) {
      if (remaining.length === state.graph.circuits.length) {
        return { ok: false, message: 'That region pair has no purchased circuit.' };
      }
      set(commit(state, { ...state.graph, circuits: remaining }));
      return {
        ok: true,
        message: 'Circuit removed. Cross-region paths on that pair now fail validation.',
      };
    }
    const sorted: [CartRegion, CartRegion] =
      CART_REGION_INFO[a].ordinal <= CART_REGION_INFO[b].ordinal
        ? [a, b]
        : [b, a];
    const circuit = { regions: sorted, mbps };
    set(
      commit(state, {
        ...state.graph,
        circuits: [...remaining, circuit],
      }),
    );
    return {
      ok: true,
      message: `${mbps} Mbit/s shared circuit set for this region pair. Every arrow in both directions uses it.`,
    };
  },

  setSeed: (seed) => {
    const state = get();
    if (!Number.isFinite(seed)) return;
    const nextSeed = Math.min(
      CART_MAX_SEED,
      Math.max(0, Math.round(seed)),
    );
    if (nextSeed === state.graph.seed) return;
    set(commit(state, { ...state.graph, seed: nextSeed }));
  },

  moveNode: (id, position) => {
    const state = get();
    const node = findNode(state.graph, id);
    if (!node) return;
    const nextPosition = {
      x: clampPosition(position.x),
      y: clampPosition(position.y),
    };
    if (
      node.position.x === nextPosition.x &&
      node.position.y === nextPosition.y
    ) {
      return;
    }
    set({
      graph: replaceNode(state.graph, { ...node, position: nextPosition }),
      pendingMove: state.pendingMove ?? cloneGraph(state.graph),
      revision: state.revision + 1,
    });
  },

  endMove: () => {
    const state = get();
    if (!state.pendingMove) return;
    set({
      past: [...state.past, state.pendingMove].slice(-HISTORY_LIMIT),
      future: [],
      pendingMove: null,
    });
  },

  select: (selection) => set({ selection }),
  clearSelection: () => set({ selection: null }),

  undo: () => {
    const state = get();
    const previous = state.past[state.past.length - 1];
    if (!previous) return;
    set({
      graph: previous,
      past: state.past.slice(0, -1),
      future: [state.graph, ...state.future].slice(0, HISTORY_LIMIT),
      selection: null,
      revision: state.revision + 1,
      pendingMove: null,
    });
  },

  redo: () => {
    const state = get();
    const next = state.future[0];
    if (!next) return;
    set({
      graph: next,
      past: [...state.past, state.graph].slice(-HISTORY_LIMIT),
      future: state.future.slice(1),
      selection: null,
      revision: state.revision + 1,
      pendingMove: null,
    });
  },

  resetGraph: () => {
    const state = get();
    set(commit(state, createCartStarterGraph(), null));
  },

  replaceGraph: (graph) => {
    const state = get();
    set(commit(state, cloneGraph(graph), null));
  },
}));

export const CART_EDITOR_STARTER_SEED = CART_DEFAULT_SEED;
