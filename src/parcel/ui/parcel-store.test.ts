import { beforeEach, describe, expect, it } from 'vitest';

import { createParcelGraph, parcelSemanticDigest } from '../graph';
import type { ParcelEvaluation } from '../contracts';
import { parcelResultStale } from './parcel-diagnostics';
import { useParcelStore } from './parcel-store';

function resetStore(): void {
  useParcelStore.setState({
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
    hydrated: true,
  });
}

describe('parcel store semantics', () => {
  beforeEach(resetStore);

  it('ignores position and label changes but reacts to configuration and seed changes', () => {
    const store = useParcelStore.getState();
    const digest = parcelSemanticDigest(store.graph);
    const evaluation = {} as ParcelEvaluation;

    store.moveNode('sql-1', { x: 900, y: 420 });
    expect(parcelSemanticDigest(useParcelStore.getState().graph)).toBe(digest);
    expect(
      parcelResultStale(
        evaluation,
        digest,
        101,
        useParcelStore.getState().graph,
        101,
      ),
    ).toBe(false);

    store.updateNodeLabel('sql-1', 'Cold archive');
    expect(parcelSemanticDigest(useParcelStore.getState().graph)).toBe(digest);
    expect(
      parcelResultStale(
        evaluation,
        digest,
        101,
        useParcelStore.getState().graph,
        101,
      ),
    ).toBe(false);

    store.updateNodeConfig('sql-1', { retentionYears: 5 });
    expect(parcelSemanticDigest(useParcelStore.getState().graph)).not.toBe(digest);
    expect(
      parcelResultStale(
        evaluation,
        digest,
        101,
        useParcelStore.getState().graph,
        101,
      ),
    ).toBe(true);

    expect(
      parcelResultStale(
        evaluation,
        parcelSemanticDigest(useParcelStore.getState().graph),
        101,
        useParcelStore.getState().graph,
        211,
      ),
    ).toBe(true);
  });

  it('adds stores, edits routes and undoes the whole change', () => {
    const store = useParcelStore.getState();
    const added = store.addNode('kv');
    expect(added.ok).toBe(true);
    expect(added.id).toBe('kv-1');
    expect(useParcelStore.getState().graph.nodes.some((node) => node.id === 'kv-1')).toBe(true);

    const edge = useParcelStore.getState().addEdge('app-1', 'kv-1', 'history');
    expect(edge.ok).toBe(true);
    expect(useParcelStore.getState().graph.edges.some((item) => item.operation === 'history' && item.target === 'kv-1')).toBe(true);

    const operation = useParcelStore
      .getState()
      .updateEdgeOperation(edge.id!, 'status');
    expect(operation.ok).toBe(true);
    expect(
      useParcelStore
        .getState()
        .graph.edges.find((item) => item.id === edge.id)?.operation,
    ).toBe('status');

    useParcelStore.getState().undo();
    expect(
      useParcelStore
        .getState()
        .graph.edges.find((item) => item.id === edge.id)?.operation,
    ).toBe('history');
    useParcelStore.getState().undo();
    expect(useParcelStore.getState().graph.nodes.some((node) => node.id === 'kv-1')).toBe(true);
    useParcelStore.getState().undo();
    expect(useParcelStore.getState().graph.nodes.some((node) => node.id === 'kv-1')).toBe(false);
    useParcelStore.getState().redo();
    expect(useParcelStore.getState().graph.nodes.some((node) => node.id === 'kv-1')).toBe(true);
  });

  it('rejects out-of-range configuration and duplicate routes', () => {
    const store = useParcelStore.getState();
    const invalid = store.updateNodeConfig('sql-1', { storageTb: 300 });
    expect(invalid.ok).toBe(false);
    expect(useParcelStore.getState().graph.nodes.find((node) => node.id === 'sql-1')?.config.storageTb).toBe(1);

    const duplicate = useParcelStore.getState().addEdge('app-1', 'sql-1', 'history');
    expect(duplicate.ok).toBe(false);
  });

  it('keeps the required client and application while allowing imported duplicates to be removed', () => {
    const store = useParcelStore.getState();
    expect(store.removeNode('client-1').ok).toBe(false);
    expect(store.removeNode('app-1').ok).toBe(false);
    expect(store.addNode('client').ok).toBe(false);
    expect(store.addNode('app').ok).toBe(false);

    const duplicateApp = {
      ...createParcelGraph(),
      nodes: [
        ...createParcelGraph().nodes,
        {
          ...createParcelGraph().nodes.find((node) => node.kind === 'app')!,
          id: 'app-2',
        },
      ],
    };
    useParcelStore.getState().replaceGraph(duplicateApp);
    expect(useParcelStore.getState().removeNode('app-2').ok).toBe(true);
    expect(useParcelStore.getState().removeNode('app-1').ok).toBe(false);
  });

  it('reset and open state clear the previous run and start ready', () => {
    useParcelStore.setState({
      result: {} as ParcelEvaluation,
      resultDigest: 'digest',
      resultSeed: 101,
      runPhase: 'completed',
      runId: 'run-1',
      progress: null,
      runIssues: [],
      seed: 999,
    });

    useParcelStore.getState().addNode('kv');
    expect(useParcelStore.getState().past.length).toBeGreaterThan(0);
    useParcelStore.getState().resetGraph();
    const reset = useParcelStore.getState();
    expect(reset.runPhase).toBe('idle');
    expect(reset.result).toBeNull();
    expect(reset.resultDigest).toBeNull();
    expect(reset.resultSeed).toBeNull();
    expect(reset.seed).toBe(101);
    expect(reset.past).toEqual([]);
    expect(reset.future).toEqual([]);
    expect(reset.selection).toBeNull();
    // Reset cannot be undone back to the draft it replaced.
    useParcelStore.getState().undo();
    expect(useParcelStore.getState().graph).toEqual(createParcelGraph());

    useParcelStore.setState({
      result: {} as ParcelEvaluation,
      resultDigest: 'digest',
      resultSeed: 101,
      runPhase: 'completed',
    });
    const base = createParcelGraph();
    const graph = {
      ...base,
      nodes: base.nodes.map((node, index) =>
        index === 0 ? { ...node, position: { x: 50, y: 60 } } : node,
      ),
    };
    useParcelStore.getState().openState(graph, 321);
    const opened = useParcelStore.getState();
    expect(opened.runPhase).toBe('idle');
    expect(opened.result).toBeNull();
    expect(opened.resultDigest).toBeNull();
    expect(opened.seed).toBe(321);
    expect(opened.graph.nodes[0]!.position).toEqual({ x: 50, y: 60 });
  });
});
