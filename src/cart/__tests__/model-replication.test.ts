import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { CartServiceQueues } from '../core/service-queues';
import type { CartGraph } from '../contracts';
import { CartCaseModel, analyzeCartTopology, type CartCaseModelOptions } from '../core/model';
import { CartDurableStore } from '../core/durable-store';
import { buildCartCaseWorkload, type CartOperationIntent } from '../core/workload';
import { cartOperationId } from '../core/operations';
import { CART_COMPONENT_TABLE, CART_DURABLE_FLUSH_US, cartIoServiceUs } from '../core/resources';
import { CART_STORE_INGEST_BASE_CPU_MS, CART_STORE_INGEST_ITEM_CPU_MS } from '../core/durable-store';
const graph = JSON.parse(readFileSync('tests/fixtures/cart/candidates/family-a-central-journal.json', 'utf8')).graph as CartGraph;
const add = buildCartCaseWorkload('normal', 1729).intents.find(i => i.region === 'eu-central' && i.effect.kind === 'add' && i.dependsOn.length === 0)!;
function setup(g = graph, atUs = 0, options: CartCaseModelOptions = {}, offers: CartOperationIntent[] = [{...add, atUs}]) {
  const facts = analyzeCartTopology(g);
  const authorities = Object.fromEntries(Object.entries(facts.authorityByRegion).filter(([, id]) => id !== null));
  const stores = g.nodes.filter(n => n.kind === 'store' || n.kind === 'journal').map(n => {
    if (n.kind !== 'store' && n.kind !== 'journal') throw new Error('durable');
    return new CartDurableStore({ nodeId: n.id, kind: n.kind, size: n.size, writeAuthorities: authorities,
      replicationEdges: g.edges.filter(e => e.kind === 'replication' && e.from === n.id).map(e => ({edgeId: e.id, to: e.to})) });
  });
  const model = new CartCaseModel('normal', facts, offers, [], g, {...options, durableStores: stores});
  return {model, stores, target: stores.find(s => s.nodeId === 'store-central')!};
}
it('D1 drawn replication arrow delivers real bytes and target contents', () => {
  const {model, target} = setup();
  model.run();
  console.info('D1 replication', { transfers: model.transferSnapshots.filter(t => t.purpose === 'replication').length, target: target.retainedOperationIds(add.cartId), wanBytes: model.wanBillableBytes, targetCommitUs: target.commitTimeFor(add.cartId, cartOperationId(add.key)), batchDeliveryUs: model.transferSnapshots.find(t => t.purpose === 'replication')?.deliveredAtUs });
  expect(target.retainedOperationIds(add.cartId)).toContain(cartOperationId(add.key));
  expect(model.transferSnapshots.some(t => t.purpose === 'replication' && t.billedWanBytes > 0 && t.deliveredAtUs !== null)).toBe(true);
  const targetNode = graph.nodes.find(node => node.id === target.nodeId)!;
  if (targetNode.kind !== 'store' || add.effect.kind !== 'add') throw new Error('expected store and add');
  const serviceUs = Math.ceil(1_000 * (CART_STORE_INGEST_BASE_CPU_MS + CART_STORE_INGEST_ITEM_CPU_MS * add.effect.count))
    + cartIoServiceUs(CART_COMPONENT_TABLE.store[targetNode.size].ioPerSecond!) + CART_DURABLE_FLUSH_US;
  expect(target.commitTimeFor(add.cartId, cartOperationId(add.key))).toBe(
    model.transferSnapshots.find(t => t.purpose === 'replication')!.deliveredAtUs! + serviceUs);
});
it('removing the arrow never copies state', () => {
  const g = structuredClone(graph); g.edges = g.edges.filter(e => e.id !== 'replicate-eu-central');
  const {model, target} = setup(g); model.run();
  expect(target.retainedOperationIds(add.cartId)).toEqual([]);
});

function read(id: string, atUs: number, region: 'us-west' | 'eu-central' = 'us-west'): CartOperationIntent {
  return {...add, id, atUs, region, operation: 'read', editKind: null, dependsOn: [], observedContext: [],
    effect: {kind: 'read', servedBy: region, token: []}};
}
it('does not expose a copy before physical batch delivery and durable flush', () => {
  const {model, target} = setup(graph, 0, {}, [{...add, atUs: 0}, read('barrier', 100_000), read('tail', 2_000_000)]);
  expect(model.step(1)).toBe(false);
  expect(model.step(1)).toBe(false);
  const transfer = model.transferSnapshots.find(t => t.purpose === 'replication')!;
  expect(transfer.deliveredAtUs).toBeNull();
  expect(target.retainedOperationIds(add.cartId)).toEqual([]);
  model.run();
  // This trace also reads the target, so real shared IO contention can delay flush.
  expect(target.commitTimeFor(add.cartId, cartOperationId(add.key))).toBeGreaterThan(
    model.transferSnapshots.find(t => t.logicalId === transfer.logicalId)!.deliveredAtUs!);
});
it('lost physical ACK retains the obligation and retries with only one effect', () => {
  const {model, stores, target} = setup(graph, 0, {replicationFaults: {discardFirstAck: true}},
    [{...add, atUs: 0}, read('after-lost-ack', 500_000), read('tail', 2_000_000)]);
  model.step(1); model.step(1);
  expect(target.retainedOperationIds(add.cartId)).toHaveLength(1);
  expect(stores.find(s => s.nodeId === 'journal-eu-central')!.pendingDeliveryCount).toBe(1);
  model.run();
  expect(target.snapshot()).toMatchObject({committedOperations: 1, duplicateAttempts: 1});
  expect(stores.every(s => s.pendingDeliveryCount === 0)).toBe(true);
  const attempts = model.transferSnapshots.filter(t => t.logicalId.startsWith('replication:replicate-eu-central:') && !t.logicalId.endsWith(':ack'));
  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.enqueuedAtUs - attempts[0]!.enqueuedAtUs).toBeGreaterThanOrEqual(1_000_000);
});
it('Tokyo outage preserves obligations and recovery drains real retries', () => {
  const tokyo = buildCartCaseWorkload('normal', 1729).intents.find(i => i.region === 'ap-northeast' && i.effect.kind === 'add' && i.dependsOn.length === 0)!;
  const {model, stores, target} = setup(graph, 0, {}, [{...tokyo, atUs: 31_000_000}, read('during', 49_000_000), read('tail', 52_000_000)]);
  model.step(1); model.step(1);
  const source = stores.find(s => s.nodeId === 'journal-ap-northeast')!;
  expect(source.pendingDeliveryCount).toBe(1);
  expect(target.retainedOperationIds(tokyo.cartId)).toEqual([]);
  model.run();
  expect(source.pendingDeliveryCount).toBe(0);
  expect(target.retainedOperationIds(tokyo.cartId)).toContain(cartOperationId(tokyo.key));
  expect(model.transferSnapshots.some(t => t.purpose === 'replication' && t.enqueuedAtUs >= 50_000_000 && t.deliveredAtUs !== null)).toBe(true);
});
function certificateGraph(omitIdleOrigin = false) {
  const g = structuredClone(graph);
  const origins = g.nodes.filter(n => n.kind === 'journal').map(n => n.id);
  for (const n of g.nodes) if (n.kind === 'application') {
    n.readTargets = n.region === 'eu-central' ? origins : ['store-central'];
    for (const target of n.readTargets) if (!g.edges.some(e => e.from === n.id && e.to === target && e.kind === 'request'))
      g.edges.push({id: `cover-${n.id}-${target}`, from: n.id, to: target, kind: 'request'});
  }
  if (omitIdleOrigin) g.edges = g.edges.filter(e => e.id !== 'replicate-ap-northeast');
  return g;
}
it('carries real Cover certificates including idle origins without advancing cuts', () => {
  const g = certificateGraph();
  const {model} = setup(g, 0, {}, [{...add, atUs: 0}, read('cover', 500_000, 'eu-central'), read('replica-read', 1_200_000)]);
  model.run();
  const issued = model.readResults.get('cover')!;
  const replicated = model.readResults.get('replica-read')!;
  expect(issued.kind).toBe('complete'); expect(replicated.kind).toBe('complete');
  if (issued.kind !== 'complete' || replicated.kind !== 'complete') throw new Error('complete evidence required');
  expect(replicated.dataSources).toEqual(['store-central']);
  expect(replicated.evidence.certificates).toEqual(issued.evidence.certificates);
  expect(replicated.evidence.certificates).toHaveLength(3);
  expect(replicated.evidence.certificates.filter(c => c.ids.length === 0)).toHaveLength(2);
  expect(replicated.coveredIds).toContain(cartOperationId(add.key));
  expect(model.transferSnapshots.filter(t => t.logicalId.startsWith('replica-read:r:')).every(t => t.to.kind === 'node' && t.to.nodeId === 'store-central')).toBe(true);
});
it('missing idle-origin replication is not knowledge of an empty origin', () => {
  const {model} = setup(certificateGraph(true), 0, {}, [{...add, atUs: 0}, read('cover', 500_000, 'eu-central'), read('missing-idle', 1_200_000)]);
  model.run();
  expect(model.readResults.get('cover')?.kind).toBe('complete');
  expect(model.readResults.get('missing-idle')?.kind).not.toBe('complete');
});
it('scheduler chunks preserve deliveries, state and physical accounting', () => {
  const baseline = setup(); baseline.model.run();
  const chunked = setup(); while (!chunked.model.step(1)) { /* real scheduler */ }
  expect(chunked.model.transferSnapshots).toEqual(baseline.model.transferSnapshots);
  expect(chunked.target.snapshot()).toEqual(baseline.target.snapshot());
});

it('relays certificates over two drawn hops without minting a new cut', () => {
  const g = certificateGraph();
  const central = g.nodes.find(n => n.id === 'store-central')!;
  if (central.kind !== 'store') throw new Error('store');
  g.nodes.push({...central, id: 'store-relay'});
  g.edges.push({id: 'relay', from: central.id, to: 'store-relay', kind: 'replication'});
  const app = g.nodes.find(n => n.id === 'app-us-west')!;
  if (app.kind !== 'application') throw new Error('app');
  app.readTargets = ['store-relay'];
  g.edges.push({id: 'read-relay', from: app.id, to: 'store-relay', kind: 'request'});
  const {model} = setup(g, 0, {}, [{...add, atUs: 0}, read('cover', 500_000, 'eu-central'), read('relay-read', 1_200_000)]);
  model.run();
  const original = model.readResults.get('cover')!, relayed = model.readResults.get('relay-read')!;
  expect(original.kind).toBe('complete'); expect(relayed.kind).toBe('complete');
  if (original.kind !== 'complete' || relayed.kind !== 'complete') throw new Error('missing evidence');
  expect(relayed.evidence.certificates).toEqual(original.evidence.certificates);
  expect(relayed.dataSources).toEqual(['store-relay']);
});
it('real replication continues into the bounded drain and stays billable', () => {
  const {model, stores, target} = setup(graph, 89_950_000);
  model.run();
  expect(target.commitTimeFor(add.cartId, cartOperationId(add.key))).toBeGreaterThan(90_000_000);
  expect(stores.every(s => s.pendingDeliveryCount === 0)).toBe(true);
  expect(model.wanDrainBillableBytes).toBeGreaterThan(0);
  expect(model.actualDrainUs).toBeGreaterThan(0);
});

it('a lost-ACK retry keeps the original batch when newer writes arrive', () => {
  const newer = {...add, id: 'newer', atUs: 500_000, key: {...add.key, requestSequence: add.key.requestSequence + 1}};
  const {model, target} = setup(graph, 0, {replicationFaults: {discardFirstAck: true}}, [{...add, atUs: 0}, newer]);
  model.run();
  const batches = model.transferSnapshots.filter(t => t.logicalId.startsWith('replication:replicate-eu-central:') && !t.logicalId.endsWith(':ack'));
  expect(batches.map(t => t.bytes)).toEqual([640, 640, 640]);
  expect(target.snapshot()).toMatchObject({committedOperations: 2, duplicateAttempts: 1});
});
it('capacity rejection never retires an undelivered obligation', () => {
  const {stores} = setup();
  const target = new CartDurableStore({nodeId: 'store-central', kind: 'store', size: 'M', writeAuthorities: {'eu-central': 'journal-eu-central'}, durableCapacityBytes: 0});
  const model = new CartCaseModel('normal', analyzeCartTopology(graph), [{...add, atUs: 0}], [], graph,
    {durableStores: [...stores.filter(s => s.nodeId !== target.nodeId), target]});
  model.run();
  expect(target.snapshot().committedOperations).toBe(0);
  expect(stores.find(s => s.nodeId === 'journal-eu-central')!.pendingDeliveryCount).toBe(1);
});


it('retries a physical batch after real target admission refuses saturated service', () => {
  const original = CartServiceQueues.prototype.reserve;
  let saturated = false;
  // Inject competing work through the real bounded queue, not a fabricated
  // refusal result. All reservations retire through the production ledger.
  const spy = vi.spyOn(CartServiceQueues.prototype, 'reserve').mockImplementation(function (
    this: CartServiceQueues, nodeId, atUs, durationUs, instance = 1, payloadBytes = 0,
  ) {
    if (nodeId === 'store-central' && !saturated) {
      saturated = true;
      for (let i = 0; i < CART_COMPONENT_TABLE.store.M.pendingLimit; i += 1) {
        expect(original.call(this, nodeId, atUs, 10_000, instance, 512)).not.toBeNull();
      }
    }
    return original.call(this, nodeId, atUs, durationUs, instance, payloadBytes);
  });
  try {
    const {model, stores, target} = setup();
    model.run();
    const batches = model.transferSnapshots.filter(t =>
      t.logicalId.startsWith('replication:replicate-eu-central:') && !t.logicalId.endsWith(':ack'));
    expect(saturated).toBe(true);
    expect(model.admissionRejections).toBeGreaterThan(0);
    expect(batches.length).toBeGreaterThan(1);
    expect(target.commitTimeFor(add.cartId, cartOperationId(add.key)))
      .toBeGreaterThan(batches[1]!.deliveredAtUs!);
    expect(target.snapshot()).toMatchObject({committedOperations: 1, duplicateAttempts: 0});
    expect(stores.every(s => s.pendingDeliveryCount === 0)).toBe(true);
    expect(model.pendingServiceTasks).toBe(0);
    expect(model.queuedRamBytes).toBe(0);
  } finally {
    spy.mockRestore();
  }
});
