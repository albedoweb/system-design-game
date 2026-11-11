import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CartGraph } from '../contracts';
import { CartCaseModel, analyzeCartTopology } from '../core/model';
import { buildCartCaseWorkload } from '../core/workload';
import { CART_DURABLE_FLUSH_US, cartIoServiceUs, CART_COMPONENT_TABLE } from '../core/resources';

import { CartDurableStore, type CartDurableCheckpoint } from '../core/durable-store';
import type { CartCaseModelOptions } from '../core/model';
import type { CartOperationIntent } from '../core/workload';
import { cartOperationId } from '../core/operations';

const graph = JSON.parse(readFileSync('tests/fixtures/cart/candidates/family-a-central-journal.json', 'utf8')).graph as CartGraph;
const add = buildCartCaseWorkload('normal', 1729).intents.find(i => i.region === 'us-west' && i.effect.kind === 'add' && i.dependsOn.length === 0)!;
function execute(intents = [{ ...add, atUs: 0 }]) {
  const model = new CartCaseModel('normal', analyzeCartTopology(graph), intents, [], graph);
  model.run();
  return model;
}

describe('model durable execution', () => {
  it('waits for journal append CPU, purchased IO, flush, and application merge before ACK', () => {
    const model = execute();
    const rpc = model.transferSnapshots.find(t => t.logicalId === `${add.id}:commit`)!;
    const ack = model.transferSnapshots.find(t => t.logicalId === `${add.id}:ack`)!;
    const journal = graph.nodes.find(n => n.id === analyzeCartTopology(graph).authorityByRegion['us-west'])!;
    if (journal.kind !== 'journal') throw new Error('expected journal');
    const expected = 200 + cartIoServiceUs(CART_COMPONENT_TABLE.journal[journal.size].ioPerSecond!) + CART_DURABLE_FLUSH_US + 200;
    console.info('D1 append service', { actual: ack.enqueuedAtUs - rpc.deliveredAtUs!, expected });
    expect(ack.enqueuedAtUs - rpc.deliveredAtUs!).toBe(expected);
    expect(model.requestRecords.find(r => r.id === add.id)?.acknowledged).toBe(true);
  });
});



function registered(capacity?: number, checkpoints: CartDurableCheckpoint[] = []) {
  const facts = analyzeCartTopology(graph);
  const nodeId = facts.authorityByRegion['us-west']!;
  const node = graph.nodes.find(n => n.id === nodeId)!;
  if (node.kind !== 'journal') throw new Error('expected journal');
  return new CartDurableStore({ nodeId, kind: 'journal', size: node.size,
    writeAuthorities: { 'us-west': nodeId }, durableCapacityBytes: capacity,
    replicationEdges: graph.edges.filter(e => e.kind === 'replication' && e.from === nodeId)
      .map(e => ({ edgeId: e.id, to: e.to })),
    onDurableCommit: c => checkpoints.push(c) });
}
function withStore(intents: CartOperationIntent[], store: CartDurableStore, chunk = Infinity, g = graph) {
  const options: CartCaseModelOptions = { durableStores: [store] };
  const model = new CartCaseModel('normal', analyzeCartTopology(g), intents, [], g, options);
  while (!model.step(chunk)) { /* shared scheduler */ }
  return model;
}

it('rejects full durable storage before ACK, token, ledger visibility or mutation', () => {
  const store = registered(704); // envelope 512 + dedup 96 + sequence 32 + outbox 64
  const second = { ...add, atUs: 100_000, id: 'second', key: { ...add.key, requestSequence: add.key.requestSequence + 1 } };
  const model = withStore([{ ...add, atUs: 0 }, second], store);
  const records = model.requestRecords.filter(r => r.operation === 'edit');
  expect(records.map(r => r.acknowledged)).toEqual([true, false]);
  // A later offer must not drag an earlier commit/ACK to its own horizon.
  expect(records[0]!.deliveredUs).toBeLessThan(second.atUs);
  expect(records[1]!.evidenceIds).toContain('durable-capacity');
  expect(model.transferSnapshots.some(t => t.logicalId === 'second:ack')).toBe(false);
  expect(store.snapshot()).toMatchObject({ committedOperations: 1, durableCommittedBytes: 640, durableFreeBytes: 64, pendingDeliveries: 0 });
  expect(store.retainedOperationIds(add.cartId)).toEqual([cartOperationId(add.key)]);
  const empty = registered(0);
  const rejected = withStore([{ ...add, atUs: 0 }], empty);
  expect(rejected.cartLiveQuantity(add.cartId)).toBe(0);
  expect(empty.snapshot()).toMatchObject({ committedOperations: 0, durableCommittedBytes: 0, ackCount: 0 });
});

it('commits only at scheduled flush completion and preserves retry single-effect', () => {
  const checkpoints: CartDurableCheckpoint[] = [];
  const store = registered(undefined, checkpoints);
  const retry = { ...add, id: 'retry', atUs: 100_000 };
  const model = withStore([{ ...add, atUs: 0 }, retry], store, 1);
  expect(model.requestRecords.filter(r => r.operation === 'edit').map(r => r.acknowledged)).toEqual([true, true]);
  expect(store.snapshot()).toMatchObject({ committedOperations: 1, duplicateAttempts: 1, durableCommittedBytes: 640 });
  expect(checkpoints).toHaveLength(1);
  const rpc = model.transferSnapshots.find(t => t.logicalId === `${add.id}:commit`)!;
  expect(checkpoints[0]!.atUs).toBe(rpc.deliveredAtUs! + 200 + 500 + CART_DURABLE_FLUSH_US);
  expect(store.commitTimeFor(add.cartId, cartOperationId(add.key))).toBe(checkpoints[0]!.atUs);
  expect(model.cartLiveQuantity(add.cartId)).toBe(add.effect.kind === 'add' ? add.effect.count : -1);
  const ack = model.transferSnapshots.find(t => t.logicalId === `${add.id}:ack`)!;
  expect(ack.enqueuedAtUs).toBe(checkpoints[0]!.atUs + 200);
});

it('queues actual IO under a same-time burst rather than adding a fixed database delay', () => {
  const intents = Array.from({ length: 12 }, (_, i) => ({ ...add, id: `burst-${i}`, cartId: `cart-${i}`, atUs: 0,
    key: { ...add.key, clientId: `client-${i}` } }));
  const store = registered();
  const model = withStore(intents, store);
  const windows = intents.map(i => {
    const rpc = model.transferSnapshots.find(t => t.logicalId === `${i.id}:commit`)!;
    const commit = store.commitTimeFor(i.cartId, cartOperationId(i.key))!;
    return { commit, service: commit - rpc.deliveredAtUs! };
  }).sort((a, b) => a.commit - b.commit);
  console.info('IO contention', windows);
  expect(windows[0]!.service).toBe(2700);
  expect(windows.at(-1)!.service).toBeGreaterThan(windows[0]!.service);
  for (let i = 1; i < windows.length; i++) expect(windows[i]!.commit - windows[i - 1]!.commit).toBe(500);
});

it('pays the read protocol CPU and certificate/enumeration IO before each response', () => {
  const read: CartOperationIntent = { ...add, id: 'durable-read', atUs: 500_000, operation: 'read', editKind: null,
    effect: { kind: 'read', servedBy: 'us-west', token: [add.id] }, observedContext: [], dependsOn: [add.id] };
  const store = registered();
  const g = structuredClone(graph);
  const app = g.nodes.find(n => n.id === 'app-us-west')!;
  if (app.kind !== 'application') throw new Error('expected application');
  app.readTargets = g.nodes.filter(n => n.kind === 'journal').map(n => n.id);
  for (const target of app.readTargets) g.edges.push({ id: `read-${target}`, kind: 'request', from: app.id, to: target });
  const model = withStore([{ ...add, atUs: 0 }, read], store, Infinity, g);
  const result = model.readResults.get(read.id)!;
  expect(result?.kind).toBe('complete');
  expect(result.coveredIds).toContain(cartOperationId(add.key));
  const transfers = model.transferSnapshots;
  const requests = transfers.filter(t => t.logicalId.startsWith(`${read.id}:r:`));
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    const response = transfers.find(t => t.logicalId === request.logicalId.replace(':r:', ':s:'))!;
    expect(response).toBeDefined();
    // Even an empty origin certificate enumerates at least one IO. Normal
    // durable probes also charge one IO plus 150us durable-read CPU.
    const target = request.to.kind === 'node' ? request.to.nodeId : '';
    expect(response.enqueuedAtUs - request.deliveredAtUs!).toBe(target === store.nodeId ? 1650 : 1550);
  }
  expect(store.snapshot().ioUnits).toBeGreaterThan(1);
  console.info('read work', result.charge, requests.map(request => ({ id: request.logicalId,
    serviceUs: transfers.find(t => t.logicalId === request.logicalId.replace(':r:', ':s:'))!.enqueuedAtUs - request.deliveredAtUs! })));
});

it('keeps durable commits, replies and IO queues invariant across bounded step sizes', () => {
  const intents = Array.from({ length: 8 }, (_, index) => ({ ...add, id: `step-${index}`, atUs: 0,
    cartId: `step-cart-${index}`, key: { ...add.key, clientId: `step-client-${index}` } }));
  const expected = withStore(intents, registered());
  for (const chunk of [1, 3]) {
    const actual = withStore(intents, registered(), chunk);
    expect(actual.requestRecords).toEqual(expected.requestRecords);
    expect(actual.transferSnapshots).toEqual(expected.transferSnapshots);
    expect(actual.chargedBusyUs).toEqual(expected.chargedBusyUs);
  }
});

it('uses Cart Store ingest demand rather than the journal append or old placeholder', () => {
  const g = structuredClone(graph);
  const authority = analyzeCartTopology(g).authorityByRegion['us-west']!;
  g.nodes = g.nodes.map(node => node.id === authority && node.kind === 'journal'
    ? { ...node, kind: 'store' as const } : node);
  const model = new CartCaseModel('normal', analyzeCartTopology(g), [{ ...add, atUs: 0 }], [], g);
  model.run();
  const rpc = model.transferSnapshots.find(t => t.logicalId === `${add.id}:commit`)!;
  const ack = model.transferSnapshots.find(t => t.logicalId === `${add.id}:ack`)!;
  const units = add.effect.kind === 'add' ? add.effect.count : 0;
  expect(ack.enqueuedAtUs - rpc.deliveredAtUs!).toBe(500 + units * 10 + 500 + CART_DURABLE_FLUSH_US + 200);
  expect(model.cartLiveQuantity(add.cartId)).toBe(units);
});
