import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { CartGraph } from '../contracts';
import { CartCaseModel, analyzeCartTopology, type CartCaseModelOptions } from '../core/model';
import type { CartOperationIntent } from '../core/workload';
import { CART_COMPONENT_TABLE, cartIoServiceUs } from '../core/resources';

function graph(): CartGraph {
  const g = JSON.parse(readFileSync('tests/fixtures/cart/candidates/family-a-central-journal.json', 'utf8')).graph as CartGraph;
  const app = g.nodes.find(n => n.id === 'app-us-west')!;
  if (app.kind !== 'application') throw new Error('application');
  app.readTargets = g.nodes.filter(n => n.kind === 'journal').map(n => n.id);
  for (const target of app.readTargets) g.edges.push({ id: `read-${target}`, kind: 'request', from: app.id, to: target });
  const inv = g.nodes.find(n => n.kind === 'inventory')!;
  inv.region = 'us-west';
  return g;
}
function intents(count = 1): CartOperationIntent[] {
  const edit: CartOperationIntent = { id: 'edit', caseId: 'normal', atUs: 0, cartId: 'basket', region: 'us-west', remoteReadRegion: null,
    key: { originRegion: 'us-west', clientId: 'buyer', requestSequence: 1 }, slotIndex: 0, stream: 'base', operation: 'edit', editKind: 'add',
    effect: { kind: 'add', sku: 7, count: 1 }, observedContext: [], dependsOn: [] };
  const read: CartOperationIntent = { ...edit, id: 'read', atUs: 100_000, operation: 'read', editKind: null,
    effect: { kind: 'read', servedBy: 'us-west', token: ['edit'] }, dependsOn: ['edit'] };
  return [edit, read, ...Array.from({ length: count }, (_, i): CartOperationIntent => ({ ...edit, id: `buy-${i}`, atUs: 500_000,
    key: { ...edit.key, requestSequence: i + 3 }, operation: 'checkout', editKind: null,
    effect: { kind: 'checkout', selectionReadId: 'read' }, dependsOn: ['read'] }))];
}
function execute(count = 1, options: CartCaseModelOptions = {}, chunk = Infinity) {
  const g = graph();
  const model = new CartCaseModel('normal', analyzeCartTopology(g), intents(count), [], g, options);
  while (!model.step(chunk)) { /* actual shared scheduler */ }
  return model;
}
it('D1: delivers lookup IO and transaction CPU, evidence, IO and flush before reply', () => {
  const model = execute();
  expect(model.requestRecords.find(r => r.id === 'buy-0')?.outcome).toBe('committed');
  const transfers = model.transferSnapshots;
  const lookup = transfers.find(t => t.logicalId === 'buy-0:lookup:0')!;
  const lookupReply = transfers.find(t => t.logicalId === 'buy-0:lookup-reply:0')!;
  const commit = transfers.find(t => t.logicalId === 'buy-0:commit:0')!;
  const reply = transfers.find(t => t.logicalId === 'buy-0:commit-reply:0')!;
  const inv = graph().nodes.find(n => n.kind === 'inventory')!;
  if (inv.kind !== 'inventory') throw new Error('inventory');
  const io = cartIoServiceUs(CART_COMPONENT_TABLE.inventory[inv.size].ioPerSecond!, 1);
  console.info('D1 inventory service', { lookupUs: lookupReply.enqueuedAtUs - lookup.deliveredAtUs!, commitUs: reply.enqueuedAtUs - commit.deliveredAtUs!, io });
  expect(lookupReply.enqueuedAtUs - lookup.deliveredAtUs!).toBe(100 + io);
  expect(reply.enqueuedAtUs - commit.deliveredAtUs!).toBe(700 + 2 * io + 2000);
  expect(model.inventoryOrders[0]!.committedAtUs).toBe(reply.enqueuedAtUs);
});

it('holds the transaction slot through IO/flush even with two Inventory CPU lanes', () => {
  const model = execute(3);
  const orders = model.inventoryOrders;
  expect(orders).toHaveLength(3);
  const commits = model.transferSnapshots.filter(t => /^buy-\d:commit:0$/.test(t.logicalId));
  expect(commits).toHaveLength(3);
  const firstReply = model.transferSnapshots.find(t => t.logicalId === 'buy-0:commit-reply:0')!;
  expect(commits.every(t => t.deliveredAtUs! < firstReply.enqueuedAtUs)).toBe(true);
  console.info('transaction completion times', orders.map(o => o.committedAtUs));
  for (let i = 1; i < orders.length; i++) {
    expect(orders[i]!.committedAtUs - orders[i - 1]!.committedAtUs).toBe(3700);
  }
});

it('publishes no stock/order/ledger while an arrived transaction is still flushing', () => {
  const reference = execute();
  const arrivalUs = reference.transferSnapshots.find(t => t.logicalId === 'buy-0:commit:0')!.deliveredAtUs!;
  const g = graph();
  const work = intents();
  // Additional real read offers make bounded step() yield during the flush.
  work.push({ ...work[1]!, id: 'during-flush', atUs: arrivalUs + 1000 });
  work.push({ ...work[1]!, id: 'after-flush', atUs: arrivalUs + 10_000 });
  const model = new CartCaseModel('normal', analyzeCartTopology(g), work, [], g);
  for (let i = 0; i < 4; i++) expect(model.step(1)).toBe(false);
  expect(model.transferSnapshots.find(t => t.logicalId === 'buy-0:commit:0')?.status).toBe('delivered');
  expect(model.inventoryOrders).toHaveLength(0);
  expect(model.inventoryLedgerRows).toHaveLength(0);
  expect(model.inventoryStock['7']).toBe(1_000_000);
  model.run();
  expect(model.inventoryOrders).toHaveLength(1);
});

it('keeps the exact stock-two race at two successes and one durable OutOfStock', () => {
  const model = execute(3, { inventoryOptions: { initialStock: { '7': 2 } } });
  expect(model.requestRecords.filter(r => r.operation === 'checkout').map(r => r.outcome).sort())
    .toEqual(['committed', 'committed', 'out-of-stock']);
  expect(model.inventoryOrders).toHaveLength(2);
  expect(model.inventoryLedgerRows).toHaveLength(3);
  expect(model.inventoryStock['7']).toBe(0);
});

it('rejects a full ledger without a stock effect and preserves the accepted row', () => {
  const model = execute(3, { inventoryOptions: { durableCapacityBytes: 288 } });
  expect(model.requestRecords.filter(r => r.operation === 'checkout').map(r => r.outcome)).toEqual(['committed', 'unavailable', 'unavailable']);
  expect(model.inventoryOrders).toHaveLength(1);
  expect(model.inventoryLedgerRows).toHaveLength(1);
  expect(model.inventoryStock['7']).toBe(999_999);
  const zero = execute(1, { inventoryOptions: { durableCapacityBytes: 0 } });
  expect(zero.inventoryOrders).toHaveLength(0);
  expect(zero.inventoryStock['7']).toBe(1_000_000);
});

it('replays a lost reply with the original binding after a later cart edit', () => {
  const g = graph();
  const work = intents();
  // This edit lands during the first lost-reply retry backoff.
  work.push({ ...work[0]!, id: 'later-edit', atUs: 550_000,
    key: { ...work[0]!.key, requestSequence: 20 }, effect: { kind: 'add', sku: 7, count: 3 } });
  const model = new CartCaseModel('normal', analyzeCartTopology(g), work, [], g,
    { checkoutFaults: { discardFirstCommitReply: true } });
  model.run();
  expect(model.requestRecords.find(r => r.id === 'buy-0')?.outcome).toBe('committed');
  expect(model.inventoryOrders).toHaveLength(1);
  expect(model.inventoryOrders[0]!.lines).toEqual([{ sku: '7', quantity: 1 }]);
  expect(model.inventoryStock['7']).toBe(999_999);
  expect(model.cartLiveQuantity('basket')).toBe(4);
  expect(model.transferSnapshots.some(t => t.logicalId === 'buy-0:lookup:1')).toBe(true);
  expect(model.transferSnapshots.some(t => t.logicalId === 'buy-0:commit:1')).toBe(false);
});

it('charges the reported engine CPU demand and is invariant across scheduler chunks', () => {
  const g = graph();
  const base = new CartCaseModel('normal', analyzeCartTopology(g), intents().slice(0, 2), [], g);
  base.run();
  const full = execute(3);
  // Per checkout: Application 200 ingress + 100 lookup merge + 100
  // commit merge + 100 terminal; Inventory 100 lookup + 700 transaction.
  expect(full.chargedBusyUs - base.chargedBusyUs).toBe(3 * 1300);
  for (const chunk of [1, 3]) {
    const actual = execute(3, {}, chunk);
    expect(actual.requestRecords).toEqual(full.requestRecords);
    expect(actual.inventoryLedgerRows).toEqual(full.inventoryLedgerRows);
    expect(actual.transferSnapshots).toEqual(full.transferSnapshots);
    expect(actual.chargedBusyUs).toBe(full.chargedBusyUs);
  }
});
