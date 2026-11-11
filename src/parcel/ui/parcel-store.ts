import { create } from 'zustand';

import { PARCEL_CATALOG } from '../catalog';
import { PARCEL_LEVEL } from '../level';
import {
  PARCEL_MAX_SEED,
  type ParcelEvaluation,
  type ParcelGraph,
  type ParcelHorizonYears,
  type ParcelIssue,
  type ParcelNode,
  type ParcelNodeConfig,
  type ParcelNodeKind,
  type ParcelOperation,
  type ParcelProgress,
} from '../contracts';
import {
  cloneParcelGraph,
  createParcelGraph,
  createParcelNode,
  parseParcelGraph,
} from '../graph';

export type ParcelSelection =
  | { type: 'node'; id: string }
  | { type: 'edge'; id: string }
  | null;

export type ParcelRunPhase =
  | 'idle'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'error'
  | 'blocked';

export interface ParcelMutationResult {
  ok: boolean;
  message?: string;
  issues?: readonly ParcelIssue[];
  id?: string;
}

export interface ParcelEditorState {
  graph: ParcelGraph;
  selection: ParcelSelection;
  past: ParcelGraph[];
  future: ParcelGraph[];
  revision: number;
  pendingMove: ParcelGraph | null;
  seed: number;
  selectedHorizon: ParcelHorizonYears;
  runPhase: ParcelRunPhase;
  runId: string | null;
  progress: ParcelProgress | null;
  result: ParcelEvaluation | null;
  resultDigest: string | null;
  resultSeed: number | null;
  runIssues: readonly ParcelIssue[];
  runError: string | null;
  runStartedAt: number | null;
  runFinishedAt: number | null;
  hydrated: boolean;

  addNode: (kind: ParcelNodeKind) => ParcelMutationResult;
  removeNode: (id: string) => ParcelMutationResult;
  removeEdge: (id: string) => ParcelMutationResult;
  updateNodeConfig: (
    id: string,
    patch: Partial<ParcelNodeConfig>,
  ) => ParcelMutationResult;
  resetNodeConfig: (id: string) => ParcelMutationResult;
  updateNodeLabel: (id: string, label: string) => ParcelMutationResult;
  updateEdgeOperation: (
    id: string,
    operation: ParcelOperation,
  ) => ParcelMutationResult;
  addEdge: (
    source: string,
    target: string,
    operation: ParcelOperation,
  ) => ParcelMutationResult;
  moveNode: (id: string, position: { x: number; y: number }) => void;
  beginMove: () => void;
  endMove: () => void;
  select: (selection: ParcelSelection) => void;
  clearSelection: () => void;
  undo: () => void;
  redo: () => void;
  resetGraph: () => void;
  replaceGraph: (graph: ParcelGraph) => void;
  /** Open a saved file: replace the graph, set its seed and clear the run. */
  openState: (graph: ParcelGraph, seed: number) => void;
  loadGraph: (graph: ParcelGraph) => void;
  setSeed: (seed: number) => void;
  setSelectedHorizon: (horizon: ParcelHorizonYears) => void;
  beginRun: (input: { runId: string; seed: number; digest: string }) => void;
  updateProgress: (progress: ParcelProgress) => void;
  completeRun: (input: {
    evaluation: ParcelEvaluation;
    seed: number;
    digest: string;
  }) => void;
  failRun: (message: string) => void;
  blockRun: (issues: readonly ParcelIssue[]) => void;
  cancelRun: () => void;
  markHydrated: () => void;
}

const HISTORY_LIMIT = 50;
const MAX_NODES = 32;
const MAX_EDGES = 64;

/**
 * Explicit open/reset starts ready: no previous result may be presented as
 * current or as a stale measurement of the new graph.
 */
const IDLE_RUN_STATE = {
  runPhase: 'idle' as ParcelRunPhase,
  runId: null,
  progress: null,
  result: null,
  resultDigest: null,
  resultSeed: null,
  runIssues: [] as readonly ParcelIssue[],
  runError: null,
  runStartedAt: null,
  runFinishedAt: null,
};
const MAX_LABEL_LENGTH = 80;

const NODE_PREFIX: Readonly<Record<ParcelNodeKind, string>> = {
  client: 'client',
  app: 'app',
  sql: 'sql',
  kv: 'kv',
  columnar: 'columnar',
};

function commit(
  state: ParcelEditorState,
  graph: ParcelGraph,
  selection: ParcelSelection = state.selection,
): Partial<ParcelEditorState> {
  return {
    graph,
    selection,
    past: [...state.past, state.graph].slice(-HISTORY_LIMIT),
    future: [],
    revision: state.revision + 1,
    pendingMove: null,
  };
}

function normalizeCandidate(
  graph: ParcelGraph,
): { ok: true; graph: ParcelGraph } | { ok: false; message: string } {
  const parsed = parseParcelGraph(graph);
  if (!parsed.ok) {
    return {
      ok: false,
      message:
        parsed.issues.find((issue) => issue.severity === 'error')?.message ??
        'The graph does not match the Parcel schema.',
    };
  }
  return { ok: true, graph: parsed.graph };
}

function nextNodeId(graph: ParcelGraph, kind: ParcelNodeKind): string {
  const prefix = NODE_PREFIX[kind];
  const used = new Set(graph.nodes.map((node) => node.id));
  let index = 1;
  while (used.has(`${prefix}-${index}`)) {
    index += 1;
  }
  return `${prefix}-${index}`;
}

function nextNodePosition(graph: ParcelGraph): { x: number; y: number } {
  if (graph.nodes.length === 0) {
    return { x: 80, y: 160 };
  }
  const maxX = graph.nodes.reduce(
    (max, node) => Math.max(max, node.position.x),
    0,
  );
  const row = graph.nodes.length % 3;
  return { x: maxX + 260, y: 120 + row * 170 };
}

function countKind(graph: ParcelGraph, kind: ParcelNodeKind): number {
  return graph.nodes.filter((node) => node.kind === kind).length;
}

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) {
    return 0;
  }
  return Math.min(PARCEL_MAX_SEED, Math.max(0, Math.round(seed)));
}

function samePosition(
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  return a.x === b.x && a.y === b.y;
}

function selectionStillExists(
  graph: ParcelGraph,
  selection: ParcelSelection,
): ParcelSelection {
  if (!selection) {
    return null;
  }
  if (selection.type === 'node') {
    return graph.nodes.some((node) => node.id === selection.id)
      ? selection
      : null;
  }
  return graph.edges.some((edge) => edge.id === selection.id)
    ? selection
    : null;
}

function defaultsFor(kind: ParcelNodeKind): ParcelNodeConfig {
  return { ...PARCEL_CATALOG.nodes[kind].defaults };
}

export const useParcelStore = create<ParcelEditorState>((set, get) => ({
  graph: createParcelGraph(),
  selection: null,
  past: [],
  future: [],
  revision: 0,
  pendingMove: null,
  seed: 101,
  selectedHorizon: 5,
  runPhase: 'idle',
  runId: null,
  progress: null,
  result: null,
  resultDigest: null,
  resultSeed: null,
  runIssues: [],
  runError: null,
  runStartedAt: null,
  runFinishedAt: null,
  hydrated: false,

  addNode: (kind) => {
    const state = get();
    if (state.graph.nodes.length >= MAX_NODES) {
      return {
        ok: false,
        message: `The graph already has ${MAX_NODES} nodes — that is the limit.`,
      };
    }
    const count = countKind(state.graph, kind);
    if (kind === 'client' && count >= 1) {
      return {
        ok: false,
        message:
          'Exactly one client is required. Edit the existing client instead of adding another.',
      };
    }
    if (kind === 'app' && count >= 1) {
      return {
        ok: false,
        message:
          'Exactly one application is required. Edit the existing application instead of adding another.',
      };
    }
    const id = nextNodeId(state.graph, kind);
    const spec = PARCEL_CATALOG.nodes[kind];
    const label =
      count === 0 ? spec.label : `${spec.label} ${count + 1}`;
    const node: ParcelNode = {
      ...createParcelNode(kind, id, nextNodePosition(state.graph)),
      label,
      config: defaultsFor(kind),
    };
    const candidate: ParcelGraph = {
      ...state.graph,
      nodes: [...state.graph.nodes, node],
    };
    const normalized = normalizeCandidate(candidate);
    if (!normalized.ok) {
      return { ok: false, message: normalized.message };
    }
    set(() => commit(state, normalized.graph, { type: 'node', id }));
    return { ok: true, id };
  },

  removeNode: (id) => {
    const state = get();
    const node = state.graph.nodes.find((item) => item.id === id);
    if (!node) {
      return { ok: false, message: 'Node not found.' };
    }
    if (
      (node.kind === 'client' || node.kind === 'app') &&
      countKind(state.graph, node.kind) <= 1
    ) {
      return {
        ok: false,
        message:
          node.kind === 'client'
            ? 'The client is required and cannot be deleted.'
            : 'The application is required and cannot be deleted.',
      };
    }
    const candidate: ParcelGraph = {
      ...state.graph,
      nodes: state.graph.nodes.filter((item) => item.id !== id),
      edges: state.graph.edges.filter(
        (edge) => edge.source !== id && edge.target !== id,
      ),
    };
    const normalized = normalizeCandidate(candidate);
    if (!normalized.ok) {
      return { ok: false, message: normalized.message };
    }
    const selection =
      state.selection?.id === id ? null : state.selection;
    set(() => commit(state, normalized.graph, selection));
    return { ok: true };
  },

  removeEdge: (id) => {
    const state = get();
    if (!state.graph.edges.some((edge) => edge.id === id)) {
      return { ok: false, message: 'Route not found.' };
    }
    const candidate: ParcelGraph = {
      ...state.graph,
      edges: state.graph.edges.filter((edge) => edge.id !== id),
    };
    const normalized = normalizeCandidate(candidate);
    if (!normalized.ok) {
      return { ok: false, message: normalized.message };
    }
    const selection =
      state.selection?.type === 'edge' && state.selection.id === id
        ? null
        : state.selection;
    set(() => commit(state, normalized.graph, selection));
    return { ok: true };
  },

  updateNodeConfig: (id, patch) => {
    const state = get();
    const node = state.graph.nodes.find((item) => item.id === id);
    if (!node) {
      return { ok: false, message: 'Node not found.' };
    }
    const config: ParcelNodeConfig = { ...node.config, ...patch };
    const candidate: ParcelGraph = {
      ...state.graph,
      nodes: state.graph.nodes.map((item) =>
        item.id === id ? { ...item, config } : item,
      ),
    };
    const normalized = normalizeCandidate(candidate);
    if (!normalized.ok) {
      return { ok: false, message: normalized.message };
    }
    set(() => commit(state, normalized.graph));
    return { ok: true };
  },

  resetNodeConfig: (id) => {
    const state = get();
    const node = state.graph.nodes.find((item) => item.id === id);
    if (!node) {
      return { ok: false, message: 'Node not found.' };
    }
    const config = defaultsFor(node.kind);
    const candidate: ParcelGraph = {
      ...state.graph,
      nodes: state.graph.nodes.map((item) =>
        item.id === id ? { ...item, config } : item,
      ),
    };
    const normalized = normalizeCandidate(candidate);
    if (!normalized.ok) {
      return { ok: false, message: normalized.message };
    }
    set(() => commit(state, normalized.graph));
    return { ok: true };
  },

  updateNodeLabel: (id, rawLabel) => {
    const state = get();
    const node = state.graph.nodes.find((item) => item.id === id);
    if (!node) {
      return { ok: false, message: 'Node not found.' };
    }
    const label = rawLabel.trim().slice(0, MAX_LABEL_LENGTH);
    if (label.length === 0 || label === node.label) {
      return { ok: true };
    }
    const candidate: ParcelGraph = {
      ...state.graph,
      nodes: state.graph.nodes.map((item) =>
        item.id === id ? { ...item, label } : item,
      ),
    };
    const normalized = normalizeCandidate(candidate);
    if (!normalized.ok) {
      return { ok: false, message: normalized.message };
    }
    set(() => commit(state, normalized.graph));
    return { ok: true };
  },

  updateEdgeOperation: (id, operation) => {
    const state = get();
    if (!state.graph.edges.some((edge) => edge.id === id)) {
      return { ok: false, message: 'Route not found.' };
    }
    const duplicate = state.graph.edges.some(
      (edge) =>
        edge.id !== id &&
        edge.operation === operation &&
        edge.source === state.graph.edges.find((item) => item.id === id)?.source &&
        edge.target === state.graph.edges.find((item) => item.id === id)?.target,
    );
    if (duplicate) {
      return {
        ok: false,
        message: 'This operation already exists between the same pair of nodes.',
      };
    }
    const candidate: ParcelGraph = {
      ...state.graph,
      edges: state.graph.edges.map((edge) =>
        edge.id === id ? { ...edge, operation } : edge,
      ),
    };
    const normalized = normalizeCandidate(candidate);
    if (!normalized.ok) {
      return { ok: false, message: normalized.message };
    }
    set(() => commit(state, normalized.graph));
    return { ok: true };
  },

  addEdge: (source, target, operation) => {
    const state = get();
    if (state.graph.edges.length >= MAX_EDGES) {
      return {
        ok: false,
        message: `The graph already has ${MAX_EDGES} routes — that is the limit.`,
      };
    }
    if (source === target) {
      return { ok: false, message: 'A node cannot connect to itself.' };
    }
    const sourceNode = state.graph.nodes.find((node) => node.id === source);
    const targetNode = state.graph.nodes.find((node) => node.id === target);
    if (!sourceNode || !targetNode) {
      return { ok: false, message: 'Choose existing nodes.' };
    }
    if (
      state.graph.edges.some(
        (edge) =>
          edge.source === source &&
          edge.target === target &&
          edge.operation === operation,
      )
    ) {
      return {
        ok: false,
        message: 'This operation already exists between these nodes.',
      };
    }
    const used = new Set(state.graph.edges.map((edge) => edge.id));
    let index = 1;
    while (used.has(`route-${index}`)) {
      index += 1;
    }
    const id = `route-${index}`;
    const candidate: ParcelGraph = {
      ...state.graph,
      edges: [...state.graph.edges, { id, source, target, operation }],
    };
    const normalized = normalizeCandidate(candidate);
    if (!normalized.ok) {
      return { ok: false, message: normalized.message };
    }
    set(() => commit(state, normalized.graph, { type: 'edge', id }));
    return { ok: true, id };
  },

  moveNode: (id, position) => {
    const state = get();
    const node = state.graph.nodes.find((item) => item.id === id);
    if (!node || samePosition(node.position, position)) {
      return;
    }
    set({
      graph: {
        ...state.graph,
        nodes: state.graph.nodes.map((item) =>
          item.id === id ? { ...item, position } : item,
        ),
      },
      revision: state.revision + 1,
    });
  },

  beginMove: () => {
    const state = get();
    if (state.pendingMove) {
      return;
    }
    set({ pendingMove: cloneParcelGraph(state.graph) });
  },

  endMove: () => {
    const state = get();
    if (!state.pendingMove) {
      return;
    }
    const changed =
      JSON.stringify(state.pendingMove) !== JSON.stringify(state.graph);
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
    set({
      graph: previous,
      past: state.past.slice(0, -1),
      future: [state.graph, ...state.future].slice(0, HISTORY_LIMIT),
      selection: selectionStillExists(previous, state.selection),
      revision: state.revision + 1,
      pendingMove: null,
    });
  },

  redo: () => {
    const state = get();
    const next = state.future[0];
    if (!next) {
      return;
    }
    set({
      graph: next,
      past: [...state.past, state.graph].slice(-HISTORY_LIMIT),
      future: state.future.slice(1),
      selection: selectionStillExists(next, state.selection),
      revision: state.revision + 1,
      pendingMove: null,
    });
  },

  resetGraph: () => {
    const state = get();
    set(() => ({
      graph: createParcelGraph(),
      selection: null,
      past: [],
      future: [],
      revision: state.revision + 1,
      pendingMove: null,
      ...IDLE_RUN_STATE,
      seed: PARCEL_LEVEL.defaultSeed,
    }));
  },

  replaceGraph: (graph) => {
    const state = get();
    const normalized = normalizeCandidate(cloneParcelGraph(graph));
    if (!normalized.ok) {
      return;
    }
    set(() => commit(state, normalized.graph, null));
  },

  openState: (graph, seed) => {
    const state = get();
    const normalized = normalizeCandidate(cloneParcelGraph(graph));
    if (!normalized.ok) {
      return;
    }
    set(() => ({
      ...commit(state, normalized.graph, null),
      ...IDLE_RUN_STATE,
      seed: normalizeSeed(seed),
    }));
  },

  loadGraph: (graph) => {
    set({
      graph: cloneParcelGraph(graph),
      selection: null,
      past: [],
      future: [],
      revision: 0,
      pendingMove: null,
      hydrated: true,
    });
  },

  setSeed: (seed) => set({ seed: normalizeSeed(seed) }),
  setSelectedHorizon: (horizon) => set({ selectedHorizon: horizon }),

  beginRun: ({ runId, seed, digest }) =>
    set({
      runPhase: 'running',
      runId,
      progress: {
        phase: 'validate',
        horizonYears: null,
        completed: 0,
        total: 1,
        message: 'Preparing the frozen graph and seed…',
      },
      result: null,
      resultDigest: digest,
      resultSeed: seed,
      runIssues: [],
      runError: null,
      runStartedAt: Date.now(),
      runFinishedAt: null,
    }),

  updateProgress: (progress) => {
    const state = get();
    if (state.runPhase !== 'running') {
      return;
    }
    set({ progress });
  },

  completeRun: ({ evaluation, seed, digest }) =>
    set({
      runPhase: 'completed',
      progress:
        evaluation.status === 'ok'
          ? null
          : {
              phase: 'done',
              horizonYears: null,
              completed: 1,
              total: 1,
              message: evaluation.status === 'invalid' ? 'Run blocked by validation.' : 'Run failed.',
            },
      result: evaluation,
      resultDigest: digest,
      resultSeed: seed,
      runIssues: [],
      runError: null,
      runFinishedAt: Date.now(),
    }),

  failRun: (message) =>
    set({
      runPhase: 'error',
      runId: null,
      progress: null,
      result: null,
      resultDigest: null,
      resultSeed: null,
      runIssues: [],
      runError: message,
      runFinishedAt: Date.now(),
    }),

  blockRun: (issues) =>
    set({
      runPhase: 'blocked',
      runId: null,
      progress: null,
      result: null,
      resultDigest: null,
      resultSeed: null,
      runIssues: issues,
      runError: null,
      runFinishedAt: Date.now(),
    }),

  cancelRun: () =>
    set({
      runPhase: 'stopped',
      runId: null,
      progress: null,
      result: null,
      resultDigest: null,
      resultSeed: null,
      runIssues: [],
      runError: null,
      runFinishedAt: Date.now(),
    }),

  markHydrated: () => set({ hydrated: true }),
}));
