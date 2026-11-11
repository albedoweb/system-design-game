import { describe, expect, it, vi } from 'vitest';
import { CART_LIMITS, createCartStarterGraph } from '../index';
import { parseCartState, serializeCartState } from './cart-persistence';
import { useCartStore } from './cart-store';

describe('explicit cart design files', () => {
  it('roundtrips settings, IDs, positions, circuits and the full uint32 seed without run state', () => {
    const store = useCartStore.getState();
    store.resetGraph();
    store.addNode('application', 'us-west');
    store.addNode('store', 'us-west');
    const app = useCartStore.getState().graph.nodes.find((node) => node.kind === 'application')!;
    const target = useCartStore.getState().graph.nodes.find((node) => node.kind === 'store')!;
    store.updateApplication(app.id, { instances: 2, writeTarget: target.id, readPolicy: 'parallel', readTargets: [target.id] });
    store.addEdge(app.id, target.id, 'request');
    store.setCircuit('us-west', 'eu-central', 32);
    store.moveNode(app.id, { x: 481, y: 332 });
    store.setSeed(4294967295);
    const graph = useCartStore.getState().graph;
    const text = serializeCartState(graph);
    expect(parseCartState(text)).toEqual({ ok: true, graph });
    expect(Object.keys(JSON.parse(text))).toEqual(Object.keys(createCartStarterGraph()));
  });

  it.each(['graphVersion', 'contentVersion', 'levelId'])('rejects unsupported %s atomically', (field) => {
    const current = useCartStore.getState().graph;
    const result = parseCartState(JSON.stringify({ ...current, [field]: 'wrong-version' }));
    expect(result.ok).toBe(false);
    expect(useCartStore.getState().graph).toBe(current);
  });

  it('accepts the source-only starter but rejects malformed, oversized and extra run-state data', () => {
    const starter = createCartStarterGraph();
    expect(parseCartState(JSON.stringify(starter))).toEqual({ ok: true, graph: starter });
    for (const text of ['{', ' '.repeat(CART_LIMITS.maxDocumentBytes + 1), JSON.stringify({ ...starter, result: {} })]) {
      expect(parseCartState(text).ok).toBe(false);
    }
  });
});

describe('editable draft documents', () => {
  function incompleteDraft() {
    const store = useCartStore.getState();
    store.resetGraph();
    store.addNode('application', 'us-west');
    const app = useCartStore.getState().graph.nodes.find((node) => node.kind === 'application')!;
    store.moveNode(app.id, { x: 240, y: 160 });
    store.setSeed(31337);
    return useCartStore.getState().graph;
  }

  it('exports, re-imports and recovers an Application with blank targets exactly', () => {
    const draft = incompleteDraft();
    const app = draft.nodes.find((node) => node.kind === 'application');
    expect(app).toMatchObject({ writeTarget: '', readTargets: [] });
    const text = serializeCartState(draft);
    const restored = parseCartState(text);
    expect(restored).toEqual({ ok: true, graph: draft });
    expect(JSON.parse(text).nodes.find((node: { kind: string }) => node.kind === 'application'))
      .toMatchObject({ writeTarget: '', readTargets: [] });
  });

  it('keeps a partially built design with removed targets loadable', () => {
    incompleteDraft();
    const store = useCartStore.getState();
    store.addNode('store', 'us-west');
    const storeNode = useCartStore.getState().graph.nodes.find((node) => node.kind === 'store')!;
    const app = useCartStore.getState().graph.nodes.find((node) => node.kind === 'application')!;
    store.updateApplication(app.id, { writeTarget: storeNode.id, readTargets: [storeNode.id] });
    store.removeNode(storeNode.id);
    const removed = useCartStore.getState().graph;
    expect(parseCartState(serializeCartState(removed))).toEqual({ ok: true, graph: removed });
  });

  it('still rejects malformed, oversized, unknown-version and extra-field documents', () => {
    const draft = incompleteDraft();
    const cases = [
      '{',
      ' '.repeat(CART_LIMITS.maxDocumentBytes + 1),
      JSON.stringify({ ...draft, graphVersion: 'cart-graph-v2' }),
      JSON.stringify({ ...draft, contentVersion: 'cart-content-v9' }),
      JSON.stringify({ ...draft, levelId: 'wrong-level' }),
      JSON.stringify({ ...draft, result: {} }),
      JSON.stringify({ ...draft, nodes: [{ ...draft.nodes[0], extra: true }] }),
    ];
    for (const text of cases) expect(parseCartState(text).ok).toBe(false);
  });

  it('never touches the current design when a document is invalid', () => {
    const current = incompleteDraft();
    const before = useCartStore.getState().graph;
    expect(parseCartState('{').ok).toBe(false);
    expect(useCartStore.getState().graph).toBe(before);
    expect(useCartStore.getState().graph).toEqual(current);
  });
});


describe('independent page module lifetimes', () => {
  it('starts fresh and shares neither graph nor history between page module instances', async () => {
    vi.resetModules();
    const first = (await import('./cart-store')).useCartStore;
    first.getState().setSeed(44);
    first.getState().addNode('cache', 'us-west');
    vi.resetModules();
    const second = (await import('./cart-store')).useCartStore;
    expect(second.getState().graph).toEqual(createCartStarterGraph());
    expect(second.getState().past).toEqual([]);
    second.getState().setSeed(55);
    expect(first.getState().graph.seed).toBe(44);
    expect(first.getState().graph.nodes).toHaveLength(4);
    expect(second.getState().graph.nodes).toHaveLength(3);
  });
});
