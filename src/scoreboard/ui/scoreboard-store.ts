import { create } from 'zustand';

import {
  SCOREBOARD_CATALOG,
  SCOREBOARD_LEVEL,
  SCOREBOARD_MAX_SEED,
  cloneScoreboardGraph,
  createScoreboardNode,
  createScoreboardStarterGraph,
  parseScoreboardGraph,
  scoreboardLinkRole,
  type ScoreboardAppNode,
  type ScoreboardCacheNode,
  type ScoreboardEvaluation,
  type ScoreboardGraph,
  type ScoreboardIssue,
  type ScoreboardNode,
  type ScoreboardNodeKind,
  type ScoreboardProgress,
  type ScoreboardSqlNode,
  type ScoreboardSqlReadPlan,
  type ScoreboardSqlSize,
  type ScoreboardCacheTtlSeconds,
} from '../index';

export type ScoreboardSelection =
  | { type: 'node'; id: string }
  | { type: 'edge'; id: string }
  | null;

export type ScoreboardRunPhase =
  | 'idle'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'error'
  | 'blocked';

export interface ScoreboardMutationResult {
  ok: boolean;
  message?: string;
  issues?: readonly ScoreboardIssue[];
  id?: string;
}

export type AddableScoreboardKind = 'app' | 'sql' | 'cache';

export interface ScoreboardEditorState {
  graph: ScoreboardGraph;
  selection: ScoreboardSelection;
  past: ScoreboardGraph[];
  future: ScoreboardGraph[];
  revision: number;
  pendingMove: ScoreboardGraph | null;
  seed: number;

  runPhase: ScoreboardRunPhase;
  runId: string | null;
  progress: ScoreboardProgress | null;
  result: ScoreboardEvaluation | null;
  resultDigest: string | null;
  resultSeed: number | null;
  runIssues: readonly ScoreboardIssue[];
  runError: string | null;
  runStartedAt: number | null;
  runFinishedAt: number | null;

  addNode: (kind: AddableScoreboardKind) => ScoreboardMutationResult;
  removeNode: (id: string) => ScoreboardMutationResult;
  removeEdge: (id: string) => ScoreboardMutationResult;
  addEdge: (source: string, target: string) => ScoreboardMutationResult;
  setAppInstances: (id: string, instances: number) => ScoreboardMutationResult;
  setSqlSize: (id: string, size: ScoreboardSqlSize) => ScoreboardMutationResult;
  setSqlReadPlan: (
    id: string,
    plan: ScoreboardSqlReadPlan,
  ) => ScoreboardMutationResult;
  setCacheTtl: (
    id: string,
    ttlSeconds: ScoreboardCacheTtlSeconds,
  ) => ScoreboardMutationResult;
  updateNodeLabel: (id: string, label: string) => ScoreboardMutationResult;

  moveNode: (id: string, position: { x: number; y: number }) => void;
  beginMove: () => void;
  endMove: () => void;
  select: (selection: ScoreboardSelection) => void;
  clearSelection: () => void;
  undo: () => void;
  redo: () => void;

  resetGraph: () => void;
  openState: (graph: ScoreboardGraph, seed: number) => void;
  setSeed: (seed: number) => void;

  beginRun: (input: { runId: string; seed: number; digest: string }) => void;
  updateProgress: (progress: ScoreboardProgress) => void;
  completeRun: (input: {
    evaluation: ScoreboardEvaluation;
    seed: number;
    digest: string;
  }) => void;
  failRun: (message: string) => void;
  blockRun: (issues: readonly ScoreboardIssue[]) => void;
  cancelRun: () => void;
}

const HISTORY_LIMIT = 50;
const MAX_LABEL_LENGTH = 120;
const MAX_EDGES = 8;

const IDLE_RUN_STATE = {
  runPhase: 'idle' as ScoreboardRunPhase,
  runId: null,
  progress: null,
  result: null,
  resultDigest: null,
  resultSeed: null,
  runIssues: [] as readonly ScoreboardIssue[],
  runError: null,
  runStartedAt: null,
  runFinishedAt: null,
};

const NODE_PREFIX: Readonly<Record<AddableScoreboardKind, string>> = {
  app: 'app',
  sql: 'sql',
  cache: 'cache',
};

const NODE_LABEL: Readonly<Record<AddableScoreboardKind, string>> = {
  app: SCOREBOARD_CATALOG.components.app.label,
  sql: SCOREBOARD_CATALOG.components.sql.label,
  cache: SCOREBOARD_CATALOG.components.cache.label,
};

const NODE_POSITION: Readonly<
  Record<ScoreboardNodeKind, { x: number; y: number }>
> = {
  users: { x: 80, y: 220 },
  app: { x: 400, y: 200 },
  cache: { x: 700, y: 360 },
  sql: { x: 700, y: 150 },
};

function emptyRunState(): Pick<
  ScoreboardEditorState,
  | 'runPhase'
  | 'runId'
  | 'progress'
  | 'result'
  | 'resultDigest'
  | 'resultSeed'
  | 'runIssues'
  | 'runError'
  | 'runStartedAt'
  | 'runFinishedAt'
> {
  return { ...IDLE_RUN_STATE };
}

function commit(
  state: ScoreboardEditorState,
  graph: ScoreboardGraph,
  selection: ScoreboardSelection = state.selection,
): Partial<ScoreboardEditorState> {
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
  graph: ScoreboardGraph,
): { ok: true; graph: ScoreboardGraph } | { ok: false; message: string } {
  const parsed = parseScoreboardGraph(graph);
  if (!parsed.ok) {
    return {
      ok: false,
      message:
        parsed.issues.find((issue) => issue.severity === 'error')?.message ??
        'The graph does not match the Live Scoreboard schema.',
    };
  }
  return { ok: true, graph: parsed.value };
}

function countKind(graph: ScoreboardGraph, kind: ScoreboardNodeKind): number {
  return graph.nodes.filter((node) => node.kind === kind).length;
}

function nextNodeId(graph: ScoreboardGraph, kind: AddableScoreboardKind): string {
  const prefix = NODE_PREFIX[kind];
  const used = new Set(graph.nodes.map((node) => node.id));
  let index = 1;
  while (used.has(`${prefix}-${index}`)) {
    index += 1;
  }
  return `${prefix}-${index}`;
}

function nextEdgeId(graph: ScoreboardGraph): string {
  const used = new Set(graph.edges.map((edge) => edge.id));
  let index = 1;
  while (used.has(`link-${index}`)) {
    index += 1;
  }
  return `link-${index}`;
}

function defaultConfig(
  kind: AddableScoreboardKind,
): ScoreboardNode['config'] {
  if (kind === 'app') {
    return { instances: SCOREBOARD_CATALOG.components.app.instances.default };
  }
  if (kind === 'sql') {
    return { size: 'small', readPlan: 'scan' };
  }
  return { ttlSeconds: 2 };
}

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) {
    return SCOREBOARD_LEVEL.defaultSeed;
  }
  return Math.min(SCOREBOARD_MAX_SEED, Math.max(0, Math.round(seed)));
}

function samePosition(
  left: { x: number; y: number },
  right: { x: number; y: number },
): boolean {
  return left.x === right.x && left.y === right.y;
}

function selectionStillExists(
  graph: ScoreboardGraph,
  selection: ScoreboardSelection,
): ScoreboardSelection {
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

function replaceNode(
  graph: ScoreboardGraph,
  id: string,
  update: (node: ScoreboardNode) => ScoreboardNode,
): ScoreboardGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === id ? update(node) : node)),
  };
}

export const useScoreboardStore = create<ScoreboardEditorState>((set, get) => ({
  graph: createScoreboardStarterGraph(),
  selection: null,
  past: [],
  future: [],
  revision: 0,
  pendingMove: null,
  seed: SCOREBOARD_LEVEL.defaultSeed,
  ...emptyRunState(),

  addNode: (kind) => {
    const state = get();
    const count = countKind(state.graph, kind);
    if (kind === 'app' && count >= 1) {
      return {
        ok: false,
        message:
          'Exactly one Application service pool is allowed. Edit the existing pool instead.',
      };
    }
    if (kind === 'sql' && count >= 1) {
      return {
        ok: false,
        message:
          'Exactly one primary SQL Database is allowed. Edit the existing database instead.',
      };
    }
    if (kind === 'cache' && count >= 1) {
      return {
        ok: false,
        message: 'At most one Cache is allowed. Edit the existing cache instead.',
      };
    }
    if (state.graph.nodes.length >= 4) {
      return {
        ok: false,
        message: 'This level supports Users, Application, SQL and one optional Cache.',
      };
    }
    const id = nextNodeId(state.graph, kind);
    const node = {
      ...createScoreboardNode(kind, id, defaultConfig(kind), NODE_POSITION[kind]),
      label: NODE_LABEL[kind],
    } as ScoreboardNode;
    const normalized = normalizeCandidate({
      ...state.graph,
      nodes: [...state.graph.nodes, node],
    });
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
    if (node.kind === 'users') {
      return {
        ok: false,
        message: 'The fixed Users node is required and cannot be deleted.',
      };
    }
    const normalized = normalizeCandidate({
      ...state.graph,
      nodes: state.graph.nodes.filter((item) => item.id !== id),
      edges: state.graph.edges.filter(
        (edge) => edge.from !== id && edge.to !== id,
      ),
    });
    if (!normalized.ok) {
      return { ok: false, message: normalized.message };
    }
    const selection =
      state.selection?.type === 'node' && state.selection.id === id
        ? null
        : state.selection;
    set(() => commit(state, normalized.graph, selection));
    return { ok: true };
  },

  removeEdge: (id) => {
    const state = get();
    if (!state.graph.edges.some((edge) => edge.id === id)) {
      return { ok: false, message: 'Connection not found.' };
    }
    const normalized = normalizeCandidate({
      ...state.graph,
      edges: state.graph.edges.filter((edge) => edge.id !== id),
    });
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

  addEdge: (source, target) => {
    const state = get();
    if (source === target) {
      return { ok: false, message: 'A component cannot connect to itself.' };
    }
    const sourceNode = state.graph.nodes.find((node) => node.id === source);
    const targetNode = state.graph.nodes.find((node) => node.id === target);
    if (!sourceNode || !targetNode) {
      return { ok: false, message: 'Choose existing components.' };
    }
    if (scoreboardLinkRole(sourceNode.kind, targetNode.kind) === null) {
      return {
        ok: false,
        message: `A ${sourceNode.kind} component cannot connect directly to a ${targetNode.kind} component in this level.`,
      };
    }
    if (
      state.graph.edges.some(
        (edge) => edge.from === source && edge.to === target,
      )
    ) {
      return {
        ok: false,
        message:
          'These components are already connected. Remove the existing connection first.',
      };
    }
    if (state.graph.edges.length >= MAX_EDGES) {
      return {
        ok: false,
        message: `The graph already has ${MAX_EDGES} connections — that is the limit.`,
      };
    }
    const id = nextEdgeId(state.graph);
    const normalized = normalizeCandidate({
      ...state.graph,
      edges: [...state.graph.edges, { id, from: source, to: target }],
    });
    if (!normalized.ok) {
      return { ok: false, message: normalized.message };
    }
    set(() => commit(state, normalized.graph, { type: 'edge', id }));
    return { ok: true, id };
  },

  setAppInstances: (id, instances) =>
    mutateNode(set, get, id, (node) => {
      if (node.kind !== 'app') {
        return null;
      }
      const bounded = Math.min(4, Math.max(1, Math.round(instances)));
      return { ...node, config: { instances: bounded } } as ScoreboardAppNode;
    }),

  setSqlSize: (id, size) =>
    mutateNode(set, get, id, (node) => {
      if (node.kind !== 'sql') {
        return null;
      }
      return { ...node, config: { ...node.config, size } } as ScoreboardSqlNode;
    }),

  setSqlReadPlan: (id, plan) =>
    mutateNode(set, get, id, (node) => {
      if (node.kind !== 'sql') {
        return null;
      }
      return {
        ...node,
        config: { ...node.config, readPlan: plan },
      } as ScoreboardSqlNode;
    }),

  setCacheTtl: (id, ttlSeconds) =>
    mutateNode(set, get, id, (node) => {
      if (node.kind !== 'cache') {
        return null;
      }
      return { ...node, config: { ttlSeconds } } as ScoreboardCacheNode;
    }),

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
    const normalized = normalizeCandidate(
      replaceNode(state.graph, id, (item) => ({ ...item, label }) as ScoreboardNode),
    );
    if (!normalized.ok) {
      return { ok: false, message: normalized.message };
    }
    set(() => commit(state, normalized.graph));
    return { ok: true };
  },

  moveNode: (id, position) => {
    const state = get();
    const node = state.graph.nodes.find((item) => item.id === id);
    if (!node || samePosition(node.position, position)) {
      return;
    }
    set({
      graph: replaceNode(
        state.graph,
        id,
        (item) => ({ ...item, position }) as ScoreboardNode,
      ),
      revision: state.revision + 1,
    });
  },

  beginMove: () => {
    const state = get();
    if (state.pendingMove) {
      return;
    }
    set({ pendingMove: cloneScoreboardGraph(state.graph) });
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
    set({
      graph: createScoreboardStarterGraph(),
      selection: null,
      past: [],
      future: [],
      revision: state.revision + 1,
      pendingMove: null,
      seed: SCOREBOARD_LEVEL.defaultSeed,
      ...emptyRunState(),
    });
  },

  openState: (graph, seed) => {
    const normalized = normalizeCandidate(cloneScoreboardGraph(graph));
    if (!normalized.ok) {
      return;
    }
    const state = get();
    set({
      graph: normalized.graph,
      selection: null,
      past: [],
      future: [],
      revision: state.revision + 1,
      pendingMove: null,
      seed: normalizeSeed(seed),
      ...emptyRunState(),
    });
  },

  setSeed: (seed) => set({ seed: normalizeSeed(seed) }),

  beginRun: ({ runId, seed, digest }) =>
    set({
      runPhase: 'running',
      runId,
      progress: {
        phase: 'validate',
        nowMs: 0,
        measuredElapsedMs: 0,
        completedRequests: 0,
        totalRequests: 1,
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
    if (state.runPhase !== 'running' && state.runPhase !== 'stopping') {
      return;
    }
    set({ progress });
  },

  completeRun: ({ evaluation, seed, digest }) =>
    set({
      runPhase: 'completed',
      progress: null,
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
}));

type SetState = (
  partial:
    | Partial<ScoreboardEditorState>
    | ((
        state: ScoreboardEditorState,
      ) => Partial<ScoreboardEditorState>),
) => void;
type GetState = () => ScoreboardEditorState;

function mutateNode(
  set: SetState,
  get: GetState,
  id: string,
  update: (node: ScoreboardNode) => ScoreboardNode | null,
): ScoreboardMutationResult {
  const state = get();
  const node = state.graph.nodes.find((item) => item.id === id);
  if (!node) {
    return { ok: false, message: 'Node not found.' };
  }
  const next = update(node);
  if (!next) {
    return { ok: false, message: 'That setting does not apply to this component.' };
  }
  const normalized = normalizeCandidate(replaceNode(state.graph, id, () => next));
  if (!normalized.ok) {
    return { ok: false, message: normalized.message };
  }
  set(commit(state, normalized.graph));
  return { ok: true };
}
