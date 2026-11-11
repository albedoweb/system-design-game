import { create } from 'zustand';

import {
  DEFAULT_COALESCING,
  DEFAULT_NODE_SIZE_BY_KIND,
  DEFAULT_POOL_SIZE,
  DEFAULT_QUEUE_LIMIT,
  DEFAULT_TTL_SECONDS,
  DomainValidationError,
  MAX_GRAPH_NODES,
  MAX_LABEL_LENGTH,
  MAX_POOL_SIZE,
  MAX_QUEUE_LIMIT,
  MAX_TTL_SECONDS,
  MIN_POOL_SIZE,
  MIN_QUEUE_LIMIT,
  MIN_TTL_SECONDS,
  NODE_KIND_LABELS,
  NODE_SIZES,
  cloneGraph,
  createInitialGraph,
  makeNode,
  parseGraph,
  validateGraph,
  type EdgeSourcePort,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
  type NodeConfig,
  type NodeKind,
  type ValidationIssue,
} from '../domain';

export type EditorSelection =
  | { type: 'node'; id: string }
  | { type: 'edge'; id: string }
  | null;

export interface MutationResult {
  ok: boolean;
  message?: string;
  issues?: ValidationIssue[];
  id?: string;
}

export interface EditorState {
  graph: GraphDocument;
  selection: EditorSelection;
  past: GraphDocument[];
  future: GraphDocument[];
  revision: number;
  configRevision: number;
  pendingMove: GraphDocument | null;
  addNode: (kind: NodeKind) => MutationResult;
  removeNode: (id: string) => MutationResult;
  removeEdge: (id: string) => MutationResult;
  updateNodeConfig: (id: string, patch: Partial<NodeConfig>) => MutationResult;
  updateNodeLabel: (id: string, label: string) => MutationResult;
  resetNode: (id: string) => MutationResult;
  addEdge: (
    source: string,
    sourcePort: EdgeSourcePort,
    target: string,
  ) => MutationResult;
  moveNode: (id: string, position: { x: number; y: number }) => void;
  beginMove: () => void;
  endMove: () => void;
  select: (selection: EditorSelection) => void;
  clearSelection: () => void;
  undo: () => void;
  redo: () => void;
  resetGraph: () => void;
  replaceGraph: (graph: GraphDocument) => void;
  loadGraph: (graph: GraphDocument) => void;
}

const HISTORY_LIMIT = 50;

function commit(
  state: EditorState,
  graph: GraphDocument,
  selection: EditorSelection = state.selection,
): Partial<EditorState> {
  return {
    graph,
    selection,
    past: [...state.past, state.graph].slice(-HISTORY_LIMIT),
    future: [],
    revision: state.revision + 1,
    configRevision: state.configRevision + 1,
    pendingMove: null,
  };
}

function modelSignature(graph: GraphDocument): string {
  return JSON.stringify({
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      config: node.config,
    })),
    edges: graph.edges,
  });
}

function samePosition(
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  return a.x === b.x && a.y === b.y;
}

function nextNodeId(graph: GraphDocument, prefix: string): string {
  const used = new Set(graph.nodes.map((node) => node.id));
  let index = 1;
  while (used.has(`${prefix}-${index}`)) {
    index += 1;
  }
  return `${prefix}-${index}`;
}

/**
 * Short sequential edge id. Endpoint ids may be up to `MAX_ID_LENGTH`
 * characters each (imported graphs), so an id built from them can exceed the
 * schema limit; a counter stays far below it.
 */
function nextEdgeId(graph: GraphDocument): string {
  const used = new Set(graph.edges.map((edge) => edge.id));
  let index = 1;
  while (used.has(`e-${index}`)) {
    index += 1;
  }
  return `e-${index}`;
}

function nodePrefix(kind: NodeKind): string {
  switch (kind) {
    case 'client':
      return 'client';
    case 'loadBalancer':
      return 'lb';
    case 'appServer':
      return 'app';
    case 'cache':
      return 'cache';
    case 'database':
      return 'db';
  }
}

function nextPosition(graph: GraphDocument): { x: number; y: number } {
  const maxX = graph.nodes.reduce(
    (max, node) => Math.max(max, node.position.x),
    0,
  );
  return { x: maxX + 240, y: 140 };
}

function addNodeLimitReached(graph: GraphDocument, kind: NodeKind): string | null {
  if (graph.nodes.length >= MAX_GRAPH_NODES) {
    return `The graph already has ${MAX_GRAPH_NODES} components — that is the limit`;
  }
  const count = graph.nodes.filter((node) => node.kind === kind).length;
  if (kind === 'appServer' && count >= 4) {
    return 'There are already four app servers';
  }
  if (kind === 'cache' && count >= 1) {
    return 'There can be only one cache';
  }
  if (kind === 'loadBalancer' && count >= 1) {
    return 'There can be only one load balancer';
  }
  return null;
}

function issueKey(issue: {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}): string {
  return `${issue.code}|${issue.message}|${issue.nodeId ?? ''}|${issue.edgeId ?? ''}`;
}

function clampInteger(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sanitizeConfig(
  current: NodeConfig,
  patch: Partial<NodeConfig>,
): NodeConfig {
  const size = NODE_SIZES.includes(patch.size ?? current.size)
    ? (patch.size ?? current.size)
    : current.size;
  return {
    size,
    queueLimit: clampInteger(
      patch.queueLimit ?? current.queueLimit,
      MIN_QUEUE_LIMIT,
      MAX_QUEUE_LIMIT,
      current.queueLimit,
    ),
    poolSize: clampInteger(
      patch.poolSize ?? current.poolSize,
      MIN_POOL_SIZE,
      MAX_POOL_SIZE,
      current.poolSize,
    ),
    ttlSeconds: clampInteger(
      patch.ttlSeconds ?? current.ttlSeconds,
      MIN_TTL_SECONDS,
      MAX_TTL_SECONDS,
      current.ttlSeconds,
    ),
    coalescing: patch.coalescing ?? current.coalescing,
  };
}

function findNode(graph: GraphDocument, id: string): GraphNode | undefined {
  return graph.nodes.find((node) => node.id === id);
}

export const useEditorStore = create<EditorState>((set, get) => ({
  graph: createInitialGraph(),
  selection: null,
  past: [],
  future: [],
  revision: 0,
  configRevision: 0,
  pendingMove: null,

  addNode: (kind) => {
    const state = get();
    if (kind !== 'appServer' && kind !== 'cache' && kind !== 'loadBalancer') {
      return { ok: false, message: 'This component cannot be added' };
    }
    const limit = addNodeLimitReached(state.graph, kind);
    if (limit) {
      return { ok: false, message: limit };
    }
    const id = nextNodeId(state.graph, nodePrefix(kind));
    const existingCount = state.graph.nodes.filter(
      (node) => node.kind === kind,
    ).length;
    const label =
      kind === 'appServer' && existingCount > 0
        ? `${NODE_KIND_LABELS[kind]} ${existingCount + 1}`
        : NODE_KIND_LABELS[kind];
    let node: GraphNode;
    try {
      node = makeNode(kind, id, nextPosition(state.graph), { label });
    } catch {
      return { ok: false, message: 'Could not create the component' };
    }
    const graph: GraphDocument = {
      ...state.graph,
      nodes: [...state.graph.nodes, node],
    };
    set(() => commit(state, graph, { type: 'node', id }));
    return { ok: true, id };
  },

  removeNode: (id) => {
    const state = get();
    const node = findNode(state.graph, id);
    if (!node) {
      return { ok: false, message: 'Component not found' };
    }
    if (node.kind === 'client') {
      return { ok: false, message: 'The client is fixed and cannot be deleted' };
    }
    if (node.kind === 'database') {
      return {
        ok: false,
        message: 'There is one database and it cannot be deleted — reset its settings instead',
      };
    }
    const graph: GraphDocument = {
      ...state.graph,
      nodes: state.graph.nodes.filter((item) => item.id !== id),
      edges: state.graph.edges.filter(
        (edge) => edge.source !== id && edge.target !== id,
      ),
    };
    const selection =
      state.selection?.id === id ? null : state.selection;
    set(() => commit(state, graph, selection));
    return { ok: true };
  },

  removeEdge: (id) => {
    const state = get();
    if (!state.graph.edges.some((edge) => edge.id === id)) {
      return { ok: false, message: 'Connection not found' };
    }
    const graph: GraphDocument = {
      ...state.graph,
      edges: state.graph.edges.filter((edge) => edge.id !== id),
    };
    const selection =
      state.selection?.type === 'edge' && state.selection.id === id
        ? null
        : state.selection;
    set(() => commit(state, graph, selection));
    return { ok: true };
  },

  updateNodeConfig: (id, patch) => {
    const state = get();
    const node = findNode(state.graph, id);
    if (!node) {
      return { ok: false, message: 'Component not found' };
    }
    const config = sanitizeConfig(node.config, patch);
    if (JSON.stringify(config) === JSON.stringify(node.config)) {
      return { ok: true };
    }
    const graph: GraphDocument = {
      ...state.graph,
      nodes: state.graph.nodes.map((item) =>
        item.id === id ? { ...item, config } : item,
      ),
    };
    set(() => commit(state, graph));
    return { ok: true };
  },

  updateNodeLabel: (id, rawLabel) => {
    const state = get();
    const node = findNode(state.graph, id);
    if (!node) {
      return { ok: false, message: 'Component not found' };
    }
    const label = rawLabel.trim().slice(0, MAX_LABEL_LENGTH);
    if (label.length === 0 || label === node.label) {
      return { ok: true };
    }
    const graph: GraphDocument = {
      ...state.graph,
      nodes: state.graph.nodes.map((item) =>
        item.id === id ? { ...item, label } : item,
      ),
    };
    set(() => commit(state, graph));
    return { ok: true };
  },

  resetNode: (id) => {
    const state = get();
    const node = findNode(state.graph, id);
    if (!node) {
      return { ok: false, message: 'Component not found' };
    }
    const reset: GraphNode = {
      ...node,
      config: {
        ...node.config,
        size: DEFAULT_NODE_SIZE_BY_KIND[node.kind],
        queueLimit: DEFAULT_QUEUE_LIMIT,
        poolSize: DEFAULT_POOL_SIZE,
        ttlSeconds: DEFAULT_TTL_SECONDS,
        coalescing: DEFAULT_COALESCING,
      },
    };
    const graph: GraphDocument = {
      ...state.graph,
      nodes: state.graph.nodes.map((item) => (item.id === id ? reset : item)),
    };
    set(() => commit(state, graph));
    return { ok: true };
  },

  addEdge: (source, sourcePort, target) => {
    const state = get();
    const sourceNode = findNode(state.graph, source);
    const targetNode = findNode(state.graph, target);
    if (!sourceNode || !targetNode) {
      return { ok: false, message: 'Choose existing components' };
    }
    if (
      state.graph.edges.some(
        (edge) =>
          edge.source === source &&
          edge.target === target &&
          edge.sourcePort === sourcePort,
      )
    ) {
      return { ok: false, message: 'This connection already exists' };
    }

    const edge: GraphEdge = {
      id: nextEdgeId(state.graph),
      source,
      sourcePort,
      target,
    };
    const candidate: GraphDocument = {
      ...state.graph,
      edges: [...state.graph.edges, edge],
    };
    // The candidate must satisfy the same strict schema the worker and the
    // import boundary use (id length/pattern, edge count, bounds) before it is
    // committed; otherwise the editor could accept a graph Run cannot parse.
    let parsed: GraphDocument;
    try {
      parsed = parseGraph(candidate);
    } catch (error) {
      if (error instanceof DomainValidationError) {
        return {
          ok: false,
          message: 'Connection rejected',
          issues: error.issues,
        };
      }
      return { ok: false, message: 'Connection rejected' };
    }
    const before = new Set(
      validateGraph(state.graph, { mode: 'draft' }).map(issueKey),
    );
    const introduced = validateGraph(parsed, { mode: 'draft' }).filter(
      (issue) => !before.has(issueKey(issue)),
    );
    if (introduced.length > 0) {
      return {
        ok: false,
        message: 'Connection rejected',
        issues: introduced,
      };
    }

    set(() => commit(state, parsed));
    return { ok: true, id: edge.id };
  },

  moveNode: (id, position) => {
    const state = get();
    const node = findNode(state.graph, id);
    if (!node || samePosition(node.position, position)) {
      return;
    }
    const graph: GraphDocument = {
      ...state.graph,
      nodes: state.graph.nodes.map((item) =>
        item.id === id ? { ...item, position } : item,
      ),
    };
    set({ graph, revision: state.revision + 1 });
  },

  beginMove: () => {
    const state = get();
    if (state.pendingMove) {
      return;
    }
    set({ pendingMove: cloneGraph(state.graph) });
  },

  endMove: () => {
    const state = get();
    if (!state.pendingMove) {
      return;
    }
    const changed = JSON.stringify(state.pendingMove) !== JSON.stringify(state.graph);
    set({
      pendingMove: null,
      past: changed
        ? [...state.past, state.pendingMove].slice(-HISTORY_LIMIT)
        : state.past,
      future: changed ? [] : state.future,
    });
  },

  select: (selection) => set({ selection }),
  clearSelection: () => set({ selection: null }),

  undo: () => {
    const state = get();
    const previous = state.past.at(-1);
    if (!previous) {
      return;
    }
    const selection =
      state.selection?.type === 'node' &&
      previous.nodes.some((node) => node.id === state.selection?.id)
        ? state.selection
        : state.selection?.type === 'edge' &&
            previous.edges.some((edge) => edge.id === state.selection?.id)
          ? state.selection
          : null;
    const modelChanged =
      modelSignature(state.graph) !== modelSignature(previous);
    set({
      graph: previous,
      past: state.past.slice(0, -1),
      future: [state.graph, ...state.future].slice(0, HISTORY_LIMIT),
      selection,
      revision: state.revision + 1,
      configRevision: state.configRevision + (modelChanged ? 1 : 0),
      pendingMove: null,
    });
  },

  redo: () => {
    const state = get();
    const next = state.future[0];
    if (!next) {
      return;
    }
    const selection =
      state.selection?.type === 'node' &&
      next.nodes.some((node) => node.id === state.selection?.id)
        ? state.selection
        : state.selection?.type === 'edge' &&
            next.edges.some((edge) => edge.id === state.selection?.id)
          ? state.selection
          : null;
    const modelChanged = modelSignature(state.graph) !== modelSignature(next);
    set({
      graph: next,
      past: [...state.past, state.graph].slice(-HISTORY_LIMIT),
      future: state.future.slice(1),
      selection,
      revision: state.revision + 1,
      configRevision: state.configRevision + (modelChanged ? 1 : 0),
      pendingMove: null,
    });
  },

  resetGraph: () => {
    const state = get();
    // Reset is a clean restart: no undo path back to the replaced graph.
    set(() => ({
      graph: createInitialGraph(),
      selection: null,
      past: [],
      future: [],
      revision: state.revision + 1,
      configRevision: state.configRevision + 1,
      pendingMove: null,
    }));
  },

  replaceGraph: (graph) => {
    const state = get();
    set(() => commit(state, cloneGraph(graph), null));
  },

  loadGraph: (graph) => {
    set({
      graph: cloneGraph(graph),
      selection: null,
      past: [],
      future: [],
      revision: 0,
      configRevision: 0,
      pendingMove: null,
    });
  },
}));

export function selectNodeById(
  graph: GraphDocument,
  id: string | null,
): GraphNode | null {
  if (!id) {
    return null;
  }
  return graph.nodes.find((node) => node.id === id) ?? null;
}

export function selectEdgeById(
  graph: GraphDocument,
  id: string | null,
): GraphEdge | null {
  if (!id) {
    return null;
  }
  return graph.edges.find((edge) => edge.id === id) ?? null;
}
