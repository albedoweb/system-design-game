import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CartGraph, CartServiceSize } from '../contracts';
import { CartCaseModel, analyzeCartTopology } from '../core/model';
import { CART_JOURNAL_APPEND_CPU_MS, CART_STORE_INGEST_BASE_CPU_MS, CART_STORE_INGEST_ITEM_CPU_MS } from '../core/durable-store';
import { createCartResourcePlan } from '../core/resources';
import { CartServiceQueues } from '../core/service-queues';
import { buildCartCaseWorkload, type CartOperationIntent } from '../core/workload';

const base = JSON.parse(readFileSync('tests/fixtures/cart/candidates/family-a-central-journal.json', 'utf8')).graph as CartGraph;
function graph(size: CartServiceSize, instances: 1 | 2, allSizes = false): CartGraph {
  const result = structuredClone(base);
  for (const node of result.nodes) {
    if (node.kind === 'application') { node.size = size; node.instances = instances; }
    else if (allSizes && node.kind !== 'customers') node.size = size;
  }
  return result;
}
function burst(): CartOperationIntent[] {
  return buildCartCaseWorkload('normal', 1729).intents
    .filter(i => i.effect.kind === 'add' && i.region === 'us-west' && i.dependsOn.length === 0)
    .slice(0, 100).map(i => ({ ...i, atUs: 0 }));
}
function run(g: CartGraph, intents = burst(), chunk = Infinity): CartCaseModel {
  const model = new CartCaseModel('normal', analyzeCartTopology(g), intents, [], g);
  while (!model.step(chunk)) { /* exercise session-sized advances */ }
  return model;
}
function edits(model: CartCaseModel) { return model.requestRecords.filter(r => r.operation === 'edit'); }
function summary(model: CartCaseModel) {
  const records = edits(model);
  return { min: Math.min(...records.map(r => r.deliveredUs!)), max: Math.max(...records.map(r => r.deliveredUs!)), busyUs: model.chargedBusyUs };
}

describe('purchased CPU execution', () => {
  it('reproduces the D1 100-add workload with capacity-sensitive outcomes', () => {
    const models = [run(graph('S', 1, true)), run(graph('M', 1, true)), run(graph('M', 2, true))];
    console.info('D1 after', models.map(summary));
    for (const model of models) {
      expect(edits(model)).toHaveLength(100);
      expect(edits(model).every(r => r.acknowledged)).toBe(true);
      // Current edit stages: 200us front door + documented 0.20ms journal
      // append + 200us Application merge. IO/flush/waits are not CPU service.
      const cpuUsPerEdit = 200 + CART_JOURNAL_APPEND_CPU_MS * 1_000 + 200;
      // The drawn journal -> Cart Store arrow now also performs each real ingest.
      const replicaCpuUs = burst().reduce((sum, intent) => sum + Math.ceil(1_000 *
        (CART_STORE_INGEST_BASE_CPU_MS + CART_STORE_INGEST_ITEM_CPU_MS *
          (intent.effect.kind === 'add' ? intent.effect.count : 0))), 0);
      expect(model.chargedBusyUs).toBe(100 * cpuUsPerEdit + replicaCpuUs);
    }
    expect(edits(models[1]!)).not.toEqual(edits(models[0]!));
    expect(edits(models[2]!)).not.toEqual(edits(models[1]!));
    expect(summary(models[1]!).max).toBeLessThan(summary(models[0]!).max);
    // More Application lanes improve early delivery, but cannot accelerate
    // the shared journal IO bottleneck draining the tail of this burst.
    expect(summary(models[2]!).min).toBeLessThan(summary(models[1]!).min);
    expect(summary(models[2]!).max).toBeLessThanOrEqual(summary(models[1]!).max);
    // Three full model runs take about 7 s locally; the default 5 s limit is too tight.
  }, 30_000);

  it('isolates front-door CPU before any durable response can compete', () => {
    // Unique clients remove the 20 Mbit/s per-client bottleneck. The first
    // commit RPCs expose Application service completion on the actual network.
    const intents = burst().slice(0, 4).map((i, index) => ({ ...i, key: { ...i.key, clientId: `isolated-${index}` } }));
    const ends = [run(graph('S', 1), intents), run(graph('M', 1), intents), run(graph('M', 2), intents)].map(model =>
      model.transferSnapshots.filter(t => t.logicalId.endsWith(':commit')).map(t => t.enqueuedAtUs));
    console.info('isolated commit offers', ends);
    // 512 B: ceil(4096/20) + ceil(4096/100) + 8000 = 8246 us.
    // One NIC serializes subsequent ingresses 41 us apart; two NICs
    // deliver pairs at 8246 and 8287. Each front-door CPU costs 200 us.
    expect(ends).toEqual([
      [8446, 8646, 8846, 9046],
      [8446, 8487, 8646, 8687],
      [8446, 8446, 8487, 8487],
    ]);
  });

  it('keeps one instance across ingress, commit and ACK, distributing admissions', () => {
    const model = run(graph('M', 2));
    const instances = new Set<number>();
    for (const intent of burst()) {
      const transfers = model.transferSnapshots.filter(t => t.logicalId.startsWith(`${intent.id}:`));
      const ingress = transfers.find(t => t.logicalId.endsWith(':in'))!;
      expect(ingress.to.kind).toBe('node');
      if (ingress.to.kind !== 'node') throw new Error('missing ingress');
      instances.add(ingress.to.instance!);
      for (const transfer of transfers) {
        if (transfer.from.kind === 'node' && transfer.from.nodeId === 'app-us-west') expect(transfer.from.instance).toBe(ingress.to.instance);
      }
    }
    expect([...instances].sort()).toEqual([1, 2]);
  });

  it('does not speed up uncongested service just by adding idle lanes', () => {
    const intent = burst().slice(0, 1);
    expect(edits(run(graph('S', 1), intent))).toEqual(edits(run(graph('M', 2), intent)));
  });

  it('is invariant to seed and advance chunk size', () => {
    const g = graph('M', 2);
    const expected = run(g);
    const changedSeed = { ...g, seed: 999 };
    for (const chunk of [1, 7, 33]) {
      const actual = run(changedSeed, burst(), chunk);
      expect(actual.requestRecords).toEqual(expected.requestRecords);
      expect(actual.transferSnapshots).toEqual(expected.transferSnapshots);
      expect(actual.chargedBusyUs).toBe(expected.chargedBusyUs);
      expect(actual.events).toBe(expected.events);
    }
  });
});

describe('CPU lane hand calculations', () => {
  it('preserves FIFO on each lane and stable lane ties without instance borrowing', () => {
    const queues = new CartServiceQueues(createCartResourcePlan(graph('M', 2)));
    expect([queues.assignInstance('app-us-west'), queues.assignInstance('app-us-west'), queues.assignInstance('app-us-west')]).toEqual([1, 2, 1]);
    // Admission grants carry an opaque release token (GC-PE7); the lane/start/
    // done hand calculation below is unchanged and asserted exactly.
    const at = (expected: Record<string, number>) => expect.objectContaining(expected);
    expect(queues.reserve('app-us-west', 10, 100, 1)).toEqual(at({ instance: 1, lane: 0, startUs: 10, doneUs: 110 }));
    expect(queues.reserve('app-us-west', 10, 50, 1)).toEqual(at({ instance: 1, lane: 1, startUs: 10, doneUs: 60 }));
    expect(queues.reserve('app-us-west', 20, 60, 1)).toEqual(at({ instance: 1, lane: 1, startUs: 60, doneUs: 120 }));
    expect(queues.reserve('app-us-west', 20, 30, 1)).toEqual(at({ instance: 1, lane: 0, startUs: 110, doneUs: 140 }));
    expect(queues.reserve('app-us-west', 20, 30, 2)).toEqual(at({ instance: 2, lane: 0, startUs: 20, doneUs: 50 }));
    expect(queues.chargedBusyUs).toBe(270);
  });
});
