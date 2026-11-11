import { create } from 'zustand';

import {
  IMAGE_CATALOG,
  IMAGE_COMPONENT_LIMITS,
  IMAGE_LEVEL,
  IMAGE_MAX_SEED,
  type ImageEdge,
  type ImageEvaluation,
  type ImageGraph,
  type ImageIssue,
  type ImageNodeKind,
  type ImageOperation,
  type ImageProgress,
  type ImageRegion,
  type ImageScenarioName,
} from '../index';
import {
  cloneImageGraph,
  createImageGraph,
  createImageNode,
  parseImageGraph,
} from '../graph';
import {
  imageAllowedOperations,
  imageConnectionExplanation,
} from './image-canvas-model';
import {
  clampImagePosition,
  imageArrangeByRegion,
  imageNewNodePosition,
  imageNodeOutsideRegionLane,
  IMAGE_LANE_ANCHOR_Y,
} from './image-layout';
import {
  IMAGE_ADDABLE_KINDS,
  IMAGE_FIXED_KINDS,
  IMAGE_NODE_KIND_LABELS,
} from './image-meta';

export type ImageSelection =
  | { type: 'node'; id: string }
  | { type: 'edge'; id: string }
  | null;

export type ImageRunPhase =
  | 'idle'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'error'
  | 'blocked';

export interface ImageMutationResult {
  ok: boolean;
  message?: string;
  issues?: readonly ImageIssue[];
  id?: string;
}

export interface ImageEditorState {
  graph: ImageGraph;
  selection: ImageSelection;
  past: ImageGraph[];
  future: ImageGraph[];
  revision: number;
  pendingMove: ImageGraph | null;
  seed: number;
  selectedScenario: ImageScenarioName;
  runPhase: ImageRunPhase;
  runId: string | null;
  progress: ImageProgress | null;
  result: ImageEvaluation | null;
  resultDigest: string | null;
  resultSeed: number | null;
  runIssues: readonly ImageIssue[];
  runError: string | null;
  runStartedAt: number | null;
  runFinishedAt: number | null;
  hydrated: boolean;

  addNode: (kind: ImageNodeKind, region: ImageRegion) => ImageMutationResult;
  removeNode: (id: string) => ImageMutationResult;
  removeEdge: (id: string) => ImageMutationResult;
  updateNodeConfig: (
    id: string,
    patch: Record<string, unknown>,
  ) => ImageMutationResult;
  resetNodeConfig: (id: string) => ImageMutationResult;
  updateNodeLabel: (id: string, label: string) => ImageMutationResult;
  setNodeRegion: (id: string, region: ImageRegion) => ImageMutationResult;
  updateEdgeOperation: (
    id: string,
    operation: ImageOperation,
  ) => ImageMutationResult;
  addEdge: (
    source: string,
    target: string,
    operation: ImageOperation,
  ) => ImageMutationResult;
  moveNode: (id: string, position: { x: number; y: number }) => void;
  beginMove: () => void;
  endMove: () => void;
  arrangeByRegion: () => ImageMutationResult;
  select: (selection: ImageSelection) => void;
  clearSelection: () => void;
  undo: () => void;
  redo: () => void;
  resetGraph: () => void;
  replaceGraph: (graph: ImageGraph) => ImageMutationResult;
  /** Open a saved file: replace the graph, set its seed and clear the run. */
  openState: (graph: ImageGraph, seed: number) => ImageMutationResult;
  loadGraph: (graph: ImageGraph) => void;
  setSeed: (seed: number) => void;
  setSelectedScenario: (scenario: ImageScenarioName) => void;
  beginRun: (input: { runId: string; seed: number; digest: string }) => void;
  updateProgress: (runId: string, progress: ImageProgress) => void;
  completeRun: (
    runId: string,
    input: { evaluation: ImageEvaluation; seed: number; digest: string },
  ) => void;
  failRun: (runId: string, message: string) => void;
  blockRun: (issues: readonly ImageIssue[]) => void;
  cancelRun: () => void;
  markHydrated: () => void;
}

const HISTORY_LIMIT = 50;
const MAX_NODES = IMAGE_COMPONENT_LIMITS.maxNodes;
const MAX_EDGES = IMAGE_COMPONENT_LIMITS.maxEdges;
const MAX_LABEL_LENGTH = IMAGE_COMPONENT_LIMITS.labelMaxLength;

const IDLE_RUN_STATE = {
  runPhase: 'idle' as ImageRunPhase,
  runId: null,
  progress: null,
  result: null,
  resultDigest: null,
  resultSeed: null,
  runIssues: [] as readonly ImageIssue[],
  runError: null,
  runStartedAt: null,
  runFinishedAt: null,
};

const NODE_PREFIX: Readonly<Record<ImageNodeKind, string>> = {
  client: 'client',
  app: 'app',
  metadata: 'metadata',
  cache: 'cache',
  blob: 'blob',
};

function isFixedKind(kind: ImageNodeKind): boolean {
  return IMAGE_FIXED_KINDS.includes(kind);
}

type ImagePlayerKind = 'app' | 'metadata' | 'cache';

function isPlayerKind(kind: ImageNodeKind): kind is ImagePlayerKind {
  return kind === 'app' || kind === 'metadata' || kind === 'cache';
}

function commit(
  state: ImageEditorState,
  graph: ImageGraph,
  selection: ImageSelection = state.selection,
): Partial<ImageEditorState> {
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
  graph: ImageGraph,
): { ok: true; graph: ImageGraph } | { ok: false; message: string } {
  const parsed = parseImageGraph(graph);
  if (!parsed.ok) {
    return {
      ok: false,
      message:
        parsed.issues.find((issue) => issue.severity === 'error')?.message ??
        'The graph does not match the Image Atlas schema.',
    };
  }
  return { ok: true, graph: parsed.graph };
}

function nextNodeId(graph: ImageGraph, kind: ImageNodeKind): string {
  const prefix = NODE_PREFIX[kind];
  const used = new Set(graph.nodes.map((node) => node.id));
  let index = 1;
  while (used.has(`${prefix}-${index}`)) {
    index += 1;
  }
  return `${prefix}-${index}`;
}

function countKind(graph: ImageGraph, kind: ImageNodeKind): number {
  return graph.nodes.filter((node) => node.kind === kind).length;
}

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) {
    return 0;
  }
  return Math.min(IMAGE_MAX_SEED, Math.max(0, Math.round(seed)));
}

function samePosition(
  left: { x: number; y: number },
  right: { x: number; y: number },
): boolean {
  return left.x === right.x && left.y === right.y;
}

function selectionStillExists(
  graph: ImageGraph,
  selection: ImageSelection,
): ImageSelection {
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

function firstScenario(evaluation: ImageEvaluation): ImageScenarioName {
  return evaluation.scenarios[0]?.name ?? 'normal';
}

export const useImageStore = create<ImageEditorState>((set, get) => ({
  graph: createImageGraph(),
  selection: null,
  past: [],
  future: [],
  revision: 0,
  pendingMove: null,
  seed: IMAGE_LEVEL.defaultSeed,
  selectedScenario: 'normal',
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

  addNode: (kind, region) => {
    const state = get();
    if (!isPlayerKind(kind) || !IMAGE_ADDABLE_KINDS.includes(kind)) {
      return {
        ok: false,
        message: `${IMAGE_NODE_KIND_LABELS[kind]} is a fixed endpoint: exactly one per region already exists.`,
      };
    }
    if (state.graph.nodes.length >= MAX_NODES) {
      return {
        ok: false,
        message: `The graph already has ${MAX_NODES} nodes — that is the limit.`,
      };
    }
    const count = countKind(state.graph, kind);
    const id = nextNodeId(state.graph, kind);
    const node = createImageNode(kind, id, region, { x: 0, y: 0 });
    const position =
      clampImagePosition(imageNewNodePosition(state.graph, kind, region)) ?? {
        x: 0,
        y: 0,
      };
    const spec = IMAGE_CATALOG.nodes[kind];
    const label = count === 0 ? spec.label : `${spec.label} ${count + 1}`;
    const candidate: ImageGraph = {
      ...state.graph,
      nodes: [...state.graph.nodes, { ...node, label, position }],
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
    if (isFixedKind(node.kind)) {
      return {
        ok: false,
        message: `${IMAGE_NODE_KIND_LABELS[node.kind]} "${node.id}" is a fixed endpoint of the level and cannot be deleted.`,
      };
    }
    const candidate: ImageGraph = {
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
    const selection = state.selection?.id === id ? null : state.selection;
    set(() => commit(state, normalized.graph, selection));
    return { ok: true };
  },

  removeEdge: (id) => {
    const state = get();
    if (!state.graph.edges.some((edge) => edge.id === id)) {
      return { ok: false, message: 'Route not found.' };
    }
    const candidate: ImageGraph = {
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
    if (isFixedKind(node.kind)) {
      return {
        ok: false,
        message: `${IMAGE_NODE_KIND_LABELS[node.kind]} configuration is fixed by the level contract; only the label and position are editable.`,
      };
    }
    const candidate = {
      ...state.graph,
      nodes: state.graph.nodes.map((item) =>
        item.id === id
          ? ({ ...item, config: { ...item.config, ...patch } } as typeof item)
          : item,
      ),
    } as ImageGraph;
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
    if (!isPlayerKind(node.kind)) {
      return {
        ok: false,
        message:
          'A fixed endpoint has no catalog defaults to restore; its configuration is locked.',
      };
    }
    const defaults = createImageNode(
      node.kind,
      node.id,
      node.region,
      node.position,
    ).config;
    const candidate = {
      ...state.graph,
      nodes: state.graph.nodes.map((item) =>
        item.id === id ? ({ ...item, config: defaults } as typeof item) : item,
      ),
    } as ImageGraph;
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
    const candidate: ImageGraph = {
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

  setNodeRegion: (id, region) => {
    const state = get();
    const node = state.graph.nodes.find((item) => item.id === id);
    if (!node) {
      return { ok: false, message: 'Node not found.' };
    }
    if (isFixedKind(node.kind)) {
      return {
        ok: false,
        message: `${IMAGE_NODE_KIND_LABELS[node.kind]} "${node.id}" must stay in region "${node.region}".`,
      };
    }
    if (node.region === region) {
      return { ok: true };
    }
    const nextPosition = imageNodeOutsideRegionLane({ ...node, region })
      ? { x: node.position.x, y: IMAGE_LANE_ANCHOR_Y[region] }
      : node.position;
    const position = clampImagePosition(nextPosition) ?? node.position;
    const candidate: ImageGraph = {
      ...state.graph,
      nodes: state.graph.nodes.map((item) =>
        item.id === id ? { ...item, region, position } : item,
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
    const edge = state.graph.edges.find((item) => item.id === id);
    if (!edge) {
      return { ok: false, message: 'Route not found.' };
    }
    const sourceNode = state.graph.nodes.find((node) => node.id === edge.source);
    const targetNode = state.graph.nodes.find((node) => node.id === edge.target);
    if (
      !sourceNode ||
      !targetNode ||
      !imageAllowedOperations(sourceNode.kind, targetNode.kind).includes(operation)
    ) {
      return {
        ok: false,
        message:
          sourceNode && targetNode
            ? imageConnectionExplanation(sourceNode.kind, targetNode.kind)
            : 'The route endpoints are missing.',
      };
    }
    const duplicate = state.graph.edges.some(
      (item) =>
        item.id !== id &&
        item.operation === operation &&
        item.source === edge.source &&
        item.target === edge.target,
    );
    if (duplicate) {
      return {
        ok: false,
        message: 'This operation already exists on the same pair of nodes.',
      };
    }
    const candidate: ImageGraph = {
      ...state.graph,
      edges: state.graph.edges.map((item) =>
        item.id === id ? { ...item, operation } : item,
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
      return { ok: false, message: 'Choose two existing nodes.' };
    }
    if (
      !imageAllowedOperations(sourceNode.kind, targetNode.kind).includes(operation)
    ) {
      return {
        ok: false,
        message: imageConnectionExplanation(sourceNode.kind, targetNode.kind),
      };
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
    const candidate: ImageGraph = {
      ...state.graph,
      edges: [...state.graph.edges, { id, source, target, operation } as ImageEdge],
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
    if (!node) {
      return;
    }
    // A drag can overshoot the canvas or receive a non-finite coordinate. Both
    // are clamped/rejected here so Export can never write a document that
    // Import rejects; the frozen limits are not extended.
    const bounded = clampImagePosition(position);
    if (!bounded || samePosition(node.position, bounded)) {
      return;
    }
    set({
      graph: {
        ...state.graph,
        nodes: state.graph.nodes.map((item) =>
          item.id === id ? { ...item, position: bounded } : item,
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
    set({ pendingMove: cloneImageGraph(state.graph) });
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

  arrangeByRegion: () => {
    const state = get();
    const arranged = imageArrangeByRegion(state.graph);
    // `imageArrangeByRegion` already bounds its geometry; the clamp keeps the
    // invariant at the store boundary too, so a future layout change cannot
    // leak an out-of-schema position into an export.
    const bounded: ImageGraph = {
      ...arranged,
      nodes: arranged.nodes.map((node) => ({
        ...node,
        position: clampImagePosition(node.position) ?? node.position,
      })),
    };
    if (JSON.stringify(bounded) === JSON.stringify(state.graph)) {
      return { ok: true };
    }
    set(() => commit(state, bounded));
    return { ok: true };
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
      graph: createImageGraph(),
      selection: null,
      past: [],
      future: [],
      revision: state.revision + 1,
      pendingMove: null,
      ...IDLE_RUN_STATE,
      seed: IMAGE_LEVEL.defaultSeed,
      selectedScenario: 'normal',
    }));
  },

  replaceGraph: (graph) => {
    const state = get();
    const normalized = normalizeCandidate(cloneImageGraph(graph));
    if (!normalized.ok) {
      return { ok: false, message: normalized.message };
    }
    set(() => commit(state, normalized.graph, null));
    return { ok: true };
  },

  openState: (graph, seed) => {
    const state = get();
    const normalized = normalizeCandidate(cloneImageGraph(graph));
    if (!normalized.ok) {
      return { ok: false, message: normalized.message };
    }
    set(() => ({
      ...commit(state, normalized.graph, null),
      ...IDLE_RUN_STATE,
      seed: normalizeSeed(seed),
      selectedScenario: 'normal',
    }));
    return { ok: true };
  },

  loadGraph: (graph) => {
    set({
      graph: cloneImageGraph(graph),
      selection: null,
      past: [],
      future: [],
      revision: 0,
      pendingMove: null,
      hydrated: true,
    });
  },

  setSeed: (seed) => set({ seed: normalizeSeed(seed) }),
  setSelectedScenario: (scenario) => set({ selectedScenario: scenario }),

  beginRun: ({ runId, seed, digest }) =>
    set({
      runPhase: 'running',
      runId,
      progress: {
        phase: 'validate',
        scenario: null,
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

  updateProgress: (runId, progress) => {
    const state = get();
    if (state.runPhase !== 'running' || state.runId !== runId) {
      return;
    }
    set({ progress });
  },

  completeRun: (runId, { evaluation, seed, digest }) => {
    const state = get();
    if (state.runId !== runId) {
      return;
    }
    set({
      runPhase: 'completed',
      progress: null,
      result: evaluation,
      resultDigest: digest,
      resultSeed: seed,
      runIssues: [],
      runError: null,
      runFinishedAt: Date.now(),
      selectedScenario:
        evaluation.scenarios.some(
          (scenario) => scenario.name === state.selectedScenario,
        )
          ? state.selectedScenario
          : firstScenario(evaluation),
    });
  },

  failRun: (runId, message) => {
    const state = get();
    if (state.runId !== runId) {
      return;
    }
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
    });
  },

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
