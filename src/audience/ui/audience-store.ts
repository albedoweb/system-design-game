import { create } from 'zustand';

import {
  AUDIENCE_CATALOG,
  AUDIENCE_LEVEL,
  AUDIENCE_MAX_EDGES,
  AUDIENCE_MAX_NODES,
  AUDIENCE_MAX_SEED,
  cloneAudienceGraph,
  createAudienceStarterGraph,
  parseAudienceGraph,
  audienceLinkRole,
  type AudienceCacheTtlSeconds,
  type AudienceCaseId,
  type AudienceCaseResult,
  type AudienceEvaluation,
  type AudienceGraph,
  type AudienceIssue,
  type AudienceNode,
  type AudienceNodeKind,
  type AudienceProgress,
  type AudienceSqlReadPlan,
  type AudienceSqlSize,
} from '../index';

export type AudienceSelection =
  | { type: 'node'; id: string }
  | { type: 'edge'; id: string }
  | null;

export type AudienceRunPhase =
  | 'idle'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'error'
  | 'blocked';

export type AudienceReplayMode = 'summary' | 'paused' | 'playing';

export interface AudienceMutationResult {
  ok: boolean;
  message?: string;
  issues?: readonly AudienceIssue[];
  id?: string;
}

export type AddableAudienceKind = Exclude<AudienceNodeKind, 'users'>;

export interface AudienceEditorState {
  graph: AudienceGraph;
  selection: AudienceSelection;
  past: AudienceGraph[];
  future: AudienceGraph[];
  revision: number;
  pendingMove: AudienceGraph | null;
  seed: number;
  /** Increments only on reset/import, so the canvas fits without fighting pan. */
  viewportEpoch: number;
  focusNodeId: string | null;
  focusNonce: number;

  runPhase: AudienceRunPhase;
  runId: string | null;
  progress: AudienceProgress | null;
  result: AudienceEvaluation | null;
  resultDigest: string | null;
  resultSeed: number | null;
  runIssues: readonly AudienceIssue[];
  runError: string | null;
  runStartedAt: number | null;
  runFinishedAt: number | null;

  selectedCaseId: AudienceCaseId | null;
  viewTimeMs: number | null;
  replayMode: AudienceReplayMode;

  addNode: (kind: AddableAudienceKind) => AudienceMutationResult;
  removeNode: (id: string) => AudienceMutationResult;
  removeEdge: (id: string) => AudienceMutationResult;
  addEdge: (source: string, target: string) => AudienceMutationResult;
  setAppInstances: (id: string, instances: number) => AudienceMutationResult;
  setSqlSize: (id: string, size: AudienceSqlSize) => AudienceMutationResult;
  setSqlReadPlan: (
    id: string,
    plan: AudienceSqlReadPlan,
  ) => AudienceMutationResult;
  setCacheTtl: (
    id: string,
    ttlSeconds: AudienceCacheTtlSeconds,
  ) => AudienceMutationResult;
  setWorkerInstances: (
    id: string,
    instances: number,
  ) => AudienceMutationResult;
  updateNodeLabel: (id: string, label: string) => AudienceMutationResult;

  moveNode: (id: string, position: { x: number; y: number }) => void;
  beginMove: () => void;
  endMove: () => void;
  select: (selection: AudienceSelection) => void;
  requestFocusNode: (id: string) => void;
  clearSelection: () => void;
  undo: () => void;
  redo: () => void;

  resetGraph: () => void;
  openState: (graph: AudienceGraph, seed: number) => void;
  setSeed: (seed: number) => void;

  beginRun: (input: { runId: string; seed: number; digest: string }) => void;
  updateProgress: (progress: AudienceProgress) => void;
  completeRun: (input: {
    evaluation: AudienceEvaluation;
    seed: number;
    digest: string;
  }) => void;
  failRun: (message: string) => void;
  blockRun: (issues: readonly AudienceIssue[]) => void;
  cancelRun: () => void;

  selectCase: (caseId: AudienceCaseId) => void;
  setViewTime: (timeMs: number | null) => void;
  startReplay: (timeMs: number) => void;
  playReplay: () => void;
  pauseReplay: () => void;
  seekReplay: (timeMs: number) => void;
  advanceReplay: (timeMs: number) => void;
  exitReplay: () => void;
}

const HISTORY_LIMIT = 50;
const MAX_LABEL_LENGTH = 120;

const IDLE_VIEW_STATE = {
  selectedCaseId: null as AudienceCaseId | null,
  viewTimeMs: null as number | null,
  replayMode: 'summary' as AudienceReplayMode,
};

const IDLE_RUN_STATE = {
  runPhase: 'idle' as AudienceRunPhase,
  runId: null,
  progress: null,
  result: null,
  resultDigest: null,
  resultSeed: null,
  runIssues: [] as readonly AudienceIssue[],
  runError: null,
  runStartedAt: null,
  runFinishedAt: null,
  ...IDLE_VIEW_STATE,
};

const NODE_PREFIX: Readonly<Record<AddableAudienceKind, string>> = {
  lb: 'lb',
  app: 'app',
  sql: 'sql',
  cache: 'cache',
  worker: 'worker',
};

const NODE_LABEL: Readonly<Record<AddableAudienceKind, string>> = {
  lb: AUDIENCE_CATALOG.components.lb.label,
  app: AUDIENCE_CATALOG.components.app.label,
  sql: AUDIENCE_CATALOG.components.sql.label,
  cache: AUDIENCE_CATALOG.components.cache.label,
  worker: AUDIENCE_CATALOG.components.worker.label,
};

/**
 * Two-dimensional default slots. Cards are about 262 x 230 px, so the columns
 * and rows keep a real gap instead of stretching one ever longer horizontal
 * row. Users owns the first slot; added components take the first free one.
 */
const NODE_SLOTS = [
  { x: 460, y: 160 },
  { x: 840, y: 160 },
  { x: 1220, y: 160 },
  { x: 460, y: 470 },
  { x: 840, y: 470 },
  { x: 1220, y: 470 },
] as const;
const CARD_WIDTH = 262;
const CARD_HEIGHT = 230;
const CARD_GAP = 40;

function positionsOverlap(
  left: { x: number; y: number },
  right: { x: number; y: number },
): boolean {
  return (
    Math.abs(left.x - right.x) < CARD_WIDTH + CARD_GAP &&
    Math.abs(left.y - right.y) < CARD_HEIGHT + CARD_GAP
  );
}

function nextNodePosition(graph: AudienceGraph): { x: number; y: number } {
  for (const slot of NODE_SLOTS) {
    if (!graph.nodes.some((node) => positionsOverlap(node.position, slot))) {
      return { ...slot };
    }
  }
  // The level caps the graph at six nodes, so this is a safety fallback only.
  return {
    x: 460 + (graph.nodes.length % 3) * (CARD_WIDTH + CARD_GAP),
    y: 470 + Math.floor(graph.nodes.length / 3) * (CARD_HEIGHT + CARD_GAP),
  };
}

function emptyRunState(): Pick<
  AudienceEditorState,
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
  | 'selectedCaseId'
  | 'viewTimeMs'
  | 'replayMode'
> {
  return { ...IDLE_RUN_STATE };
}

function commit(
  state: AudienceEditorState,
  graph: AudienceGraph,
  selection: AudienceSelection = state.selection,
): Partial<AudienceEditorState> {
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
  graph: AudienceGraph,
): { ok: true; graph: AudienceGraph } | { ok: false; message: string } {
  const parsed = parseAudienceGraph(graph);
  if (!parsed.ok) {
    return {
      ok: false,
      message:
        parsed.issues.find((issue) => issue.severity === 'error')?.message ??
        'The graph does not match the Live Audience schema.',
    };
  }
  return { ok: true, graph: parsed.value };
}

function countKind(graph: AudienceGraph, kind: AudienceNodeKind): number {
  return graph.nodes.filter((node) => node.kind === kind).length;
}

function nextNodeId(graph: AudienceGraph, kind: AddableAudienceKind): string {
  const prefix = NODE_PREFIX[kind];
  const used = new Set(graph.nodes.map((node) => node.id));
  let index = 1;
  while (used.has(`${prefix}-${index}`)) {
    index += 1;
  }
  return `${prefix}-${index}`;
}

function nextEdgeId(graph: AudienceGraph): string {
  const used = new Set(graph.edges.map((edge) => edge.id));
  let index = 1;
  while (used.has(`link-${index}`)) {
    index += 1;
  }
  return `link-${index}`;
}

function nodeFor(
  kind: AddableAudienceKind,
  id: string,
  graph: AudienceGraph,
): AudienceNode {
  const base = {
    id,
    label: NODE_LABEL[kind],
  };
  // Position is editor-only and never part of the semantic digest. Every new
  // node gets a free 2D slot; the canvas keeps the player's current zoom.
  const position = nextNodePosition(graph);
  switch (kind) {
    case 'lb':
      return { ...base, kind: 'lb', position, config: {} };
    case 'app':
      return {
        ...base,
        kind: 'app',
        position,
        config: { instances: AUDIENCE_CATALOG.components.app.instances.default },
      };
    case 'sql':
      return {
        ...base,
        kind: 'sql',
        position,
        config: { size: 'small', readPlan: 'query' },
      };
    case 'cache':
      return {
        ...base,
        kind: 'cache',
        position,
        config: { ttlSeconds: 2 },
      };
    case 'worker':
      return {
        ...base,
        kind: 'worker',
        position,
        config: {
          instances: AUDIENCE_CATALOG.components.worker.instances.default,
        },
      };
  }
}

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) {
    return AUDIENCE_LEVEL.defaultSeed;
  }
  return Math.min(AUDIENCE_MAX_SEED, Math.max(0, Math.round(seed)));
}

function samePosition(
  left: { x: number; y: number },
  right: { x: number; y: number },
): boolean {
  return left.x === right.x && left.y === right.y;
}

function selectionStillExists(
  graph: AudienceGraph,
  selection: AudienceSelection,
): AudienceSelection {
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
  graph: AudienceGraph,
  id: string,
  update: (node: AudienceNode) => AudienceNode,
): AudienceGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === id ? update(node) : node)),
  };
}

/**
 * One selected case drives every chart, table and recorded frame. The engine
 * result stays untouched; this is a view selector, never a filter on scoring.
 */
export function audienceSelectedCase(
  result: AudienceEvaluation | null,
  selectedCaseId: AudienceCaseId | null,
): AudienceCaseResult | null {
  if (!result || result.cases.length === 0) {
    return null;
  }
  return (
    result.cases.find((item) => item.id === selectedCaseId) ??
    result.cases[0] ??
    null
  );
}

export const useAudienceStore = create<AudienceEditorState>((set, get) => ({
  graph: createAudienceStarterGraph(),
  selection: null,
  past: [],
  future: [],
  revision: 0,
  pendingMove: null,
  seed: AUDIENCE_LEVEL.defaultSeed,
  viewportEpoch: 0,
  focusNodeId: null,
  focusNonce: 0,
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
    if (kind !== 'app' && kind !== 'sql' && count >= 1) {
      return {
        ok: false,
        message: `At most one ${NODE_LABEL[kind]} is allowed. Edit the existing component instead.`,
      };
    }
    if (state.graph.nodes.length >= AUDIENCE_MAX_NODES) {
      return {
        ok: false,
        message:
          'This level supports Users, one Application, one SQL Database, one Load Balancer, one Cache and one Worker pool.',
      };
    }
    const id = nextNodeId(state.graph, kind);
    const node = nodeFor(kind, id, state.graph);
    const normalized = normalizeCandidate({
      ...state.graph,
      nodes: [...state.graph.nodes, node],
    });
    if (!normalized.ok) {
      return { ok: false, message: normalized.message };
    }
    set(() => ({
      ...commit(state, normalized.graph, { type: 'node', id }),
      focusNodeId: id,
      focusNonce: state.focusNonce + 1,
    }));
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
    if (audienceLinkRole(sourceNode.kind, targetNode.kind) === null) {
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
    if (state.graph.edges.length >= AUDIENCE_MAX_EDGES) {
      return {
        ok: false,
        message: `The graph already has ${AUDIENCE_MAX_EDGES} connections — that is the limit.`,
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
      return { ...node, config: { instances: bounded } };
    }),

  setSqlSize: (id, size) =>
    mutateNode(set, get, id, (node) => {
      if (node.kind !== 'sql') {
        return null;
      }
      return { ...node, config: { ...node.config, size } };
    }),

  setSqlReadPlan: (id, plan) =>
    mutateNode(set, get, id, (node) => {
      if (node.kind !== 'sql') {
        return null;
      }
      return { ...node, config: { ...node.config, readPlan: plan } };
    }),

  setCacheTtl: (id, ttlSeconds) =>
    mutateNode(set, get, id, (node) => {
      if (node.kind !== 'cache') {
        return null;
      }
      return { ...node, config: { ttlSeconds } };
    }),

  setWorkerInstances: (id, instances) =>
    mutateNode(set, get, id, (node) => {
      if (node.kind !== 'worker') {
        return null;
      }
      const bounded = Math.min(4, Math.max(1, Math.round(instances)));
      return { ...node, config: { instances: bounded } };
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
      replaceNode(state.graph, id, (item) => ({ ...item, label }) as AudienceNode),
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
        (item) => ({ ...item, position }) as AudienceNode,
      ),
      revision: state.revision + 1,
    });
  },

  beginMove: () => {
    const state = get();
    if (state.pendingMove) {
      return;
    }
    set({ pendingMove: cloneAudienceGraph(state.graph) });
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
  requestFocusNode: (id) =>
    set((state) => ({ focusNodeId: id, focusNonce: state.focusNonce + 1 })),
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
      graph: createAudienceStarterGraph(),
      selection: null,
      past: [],
      future: [],
      revision: state.revision + 1,
      pendingMove: null,
      seed: AUDIENCE_LEVEL.defaultSeed,
      viewportEpoch: state.viewportEpoch + 1,
      focusNodeId: null,
      ...emptyRunState(),
    });
  },

  openState: (graph, seed) => {
    const normalized = normalizeCandidate(cloneAudienceGraph(graph));
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
      viewportEpoch: state.viewportEpoch + 1,
      focusNodeId: null,
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
        caseId: null,
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
      ...IDLE_VIEW_STATE,
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
      selectedCaseId: evaluation.cases[0]?.id ?? null,
      viewTimeMs: null,
      replayMode: 'summary',
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
      ...IDLE_VIEW_STATE,
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
      ...IDLE_VIEW_STATE,
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
      ...IDLE_VIEW_STATE,
    }),

  selectCase: (caseId) => {
    const state = get();
    if (!state.result?.cases.some((item) => item.id === caseId)) {
      return;
    }
    set({ selectedCaseId: caseId, viewTimeMs: null, replayMode: 'summary' });
  },

  setViewTime: (timeMs) =>
    set({
      viewTimeMs: timeMs,
      replayMode: timeMs === null ? 'summary' : 'paused',
    }),

  startReplay: (timeMs) =>
    set({ viewTimeMs: timeMs, replayMode: 'playing' }),

  playReplay: () => {
    const state = get();
    if (state.viewTimeMs === null) {
      return;
    }
    set({ replayMode: 'playing' });
  },

  pauseReplay: () => {
    const state = get();
    if (state.replayMode !== 'playing') {
      return;
    }
    set({ replayMode: 'paused' });
  },

  seekReplay: (timeMs) =>
    set({ viewTimeMs: timeMs, replayMode: 'paused' }),

  /**
   * Automatic replay tick. It moves the view without downgrading an active
   * replay to paused; only a manual seek or pause ends playback.
   */
  advanceReplay: (timeMs) => {
    if (get().replayMode !== 'playing') {
      return;
    }
    set({ viewTimeMs: timeMs });
  },

  exitReplay: () => set({ viewTimeMs: null, replayMode: 'summary' }),
}));

type SetState = (
  partial:
    | Partial<AudienceEditorState>
    | ((state: AudienceEditorState) => Partial<AudienceEditorState>),
) => void;
type GetState = () => AudienceEditorState;

function mutateNode(
  set: SetState,
  get: GetState,
  id: string,
  update: (node: AudienceNode) => AudienceNode | null,
): AudienceMutationResult {
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
