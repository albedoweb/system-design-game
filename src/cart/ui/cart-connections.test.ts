import { beforeEach, expect, it } from 'vitest';
import { useCartStore } from './cart-store';

beforeEach(() => useCartStore.getState().resetGraph());
function setup() {
  const store = useCartStore.getState();
  const app = store.addNode('application', 'eu-central').id!;
  const target = store.addNode('store', 'eu-central').id!;
  return { store, app, target };
}
it('drawing a storage request configures read and write atomically, with undo/redo', () => {
  const { store, app, target } = setup();
  expect(store.addEdge(app, target, 'request').ok).toBe(true);
  expect(useCartStore.getState().graph.nodes.find(n => n.id === app)).toMatchObject({ readTargets: [target], writeTarget: target });
  store.undo();
  expect(useCartStore.getState().graph.edges).toHaveLength(0);
  expect(useCartStore.getState().graph.nodes.find(n => n.id === app)).toMatchObject({ readTargets: [], writeTarget: '' });
  store.redo();
  expect(useCartStore.getState().graph.edges).toHaveLength(1);
});
it('properties create one visible path and preserve a chosen write destination', () => {
  const { store, app, target } = setup();
  store.updateApplication(app, { readTargets: [target], writeTarget: target });
  expect(useCartStore.getState().graph.edges).toHaveLength(1);
  const journal = store.addNode('journal', 'eu-central').id!;
  store.addEdge(app, journal, 'request');
  expect(useCartStore.getState().graph.nodes.find(n => n.id === app)).toMatchObject({ readTargets: [target, journal], writeTarget: target });
  store.toggleReadTarget(app, target);
  expect(useCartStore.getState().graph.edges).toHaveLength(2);
  expect(useCartStore.getState().graph.nodes.find(n => n.id === app)).toMatchObject({ readTargets: [journal], writeTarget: target });
});
it('replication paths do not silently become application reads or writes', () => {
  const { store, app, target } = setup();
  store.addEdge(app, target, 'replication');
  expect(useCartStore.getState().graph.nodes.find(n => n.id === app)).toMatchObject({ readTargets: [], writeTarget: '' });
});

it('removing the last role removes the path; deleting the path clears its roles', () => {
  const { store, app, target } = setup();
  store.updateApplication(app, { readTargets: [target] });
  store.toggleReadTarget(app, target);
  expect(useCartStore.getState().graph.edges).toHaveLength(0);
  const edge = store.addEdge(app, target, 'request');
  store.removeEdge(edge.id!);
  expect(useCartStore.getState().graph.nodes.find(n => n.id === app)).toMatchObject({ readTargets: [], writeTarget: '' });
  store.undo();
  expect(useCartStore.getState().graph.nodes.find(n => n.id === app)).toMatchObject({ readTargets: [target], writeTarget: target });
});
