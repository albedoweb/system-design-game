/**
 * GC-PF4 regressions: concurrent-edit probe declarations execute as their
 * declared same-SKU observed-unit operations through the real charged edit
 * path (no ledger injection, no fake ACK, no oracle change).
 *
 * Frozen expectations: fixtures.json `quantityOracles`, mirrored as
 * CART_CONCURRENT_LIVE_SETS. Unit labels: u0/u1 are the two units of the base
 * Add2; a/b/fresh are the units created by the first/second actor.
 */
import { describe, expect, it } from 'vitest';

import { CART_LEVEL_ID, CART_VERSIONS, type CartGraph } from '../index';
import { CartCaseModel, analyzeCartTopology } from '../core/model';
import { CART_CONCURRENT, buildCartProbes, type CartProbe } from '../core/challenges';
import { CartDurableStore } from '../core/durable-store';
import { cartUnitId, type CartOperationKey } from '../core/operations';

function cartGraph(options: { readonly inventory?: boolean } = {}): CartGraph {
  const customers = (region: string, x: number): Record<string, unknown> => ({
    id: `customers-${region}`,
    kind: 'customers',
    region,
    position: { x, y: 40 },
  });
  const app = (region: string, x: number, writeTarget: string): Record<string, unknown> => ({
    id: `app-${region}`,
    kind: 'application',
    region,
    position: { x, y: 200 },
    size: 'S',
    instances: 1,
    writeTarget,
    readPolicy: 'local-repair',
    readTargets: ['journal-us-west', 'journal-eu-central', 'journal-ap-northeast'],
  });
  const nodes: Record<string, unknown>[] = [
    customers('us-west', 40),
    customers('eu-central', 440),
    customers('ap-northeast', 840),
    app('us-west', 80, 'journal-us-west'),
    app('eu-central', 480, 'journal-eu-central'),
    app('ap-northeast', 880, 'journal-ap-northeast'),
    { id: 'journal-us-west', kind: 'journal', region: 'us-west', position: { x: 80, y: 340 }, size: 'S' },
    { id: 'journal-eu-central', kind: 'journal', region: 'eu-central', position: { x: 480, y: 340 }, size: 'M' },
    { id: 'journal-ap-northeast', kind: 'journal', region: 'ap-northeast', position: { x: 880, y: 340 }, size: 'S' },
    { id: 'inventory-us-west', kind: 'inventory', region: 'us-west', position: { x: 240, y: 480 }, size: 'M' },
  ];
  const edges: Record<string, unknown>[] = [
    { id: 'src-us', from: 'customers-us-west', to: 'app-us-west', kind: 'request' },
    { id: 'src-eu', from: 'customers-eu-central', to: 'app-eu-central', kind: 'request' },
    { id: 'src-ap', from: 'customers-ap-northeast', to: 'app-ap-northeast', kind: 'request' },
    { id: 'write-us', from: 'app-us-west', to: 'journal-us-west', kind: 'request' },
    { id: 'write-eu', from: 'app-eu-central', to: 'journal-eu-central', kind: 'request' },
    { id: 'write-ap', from: 'app-ap-northeast', to: 'journal-ap-northeast', kind: 'request' },
    { id: 'inv-us', from: 'app-us-west', to: 'inventory-us-west', kind: 'request' },
    { id: 'inv-eu', from: 'app-eu-central', to: 'inventory-us-west', kind: 'request' },
    { id: 'inv-ap', from: 'app-ap-northeast', to: 'inventory-us-west', kind: 'request' },
  ];
  const circuits: Record<string, unknown>[] = [
    { regions: ['us-west', 'eu-central'], mbps: 8 },
    { regions: ['us-west', 'ap-northeast'], mbps: 32 },
    { regions: ['eu-central', 'ap-northeast'], mbps: 8 },
  ];
  const withInventory = options.inventory !== false;
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes: withInventory ? nodes : nodes.filter((node) => node.kind !== 'inventory'),
    edges: withInventory ? edges : edges.filter((edge) => !String(edge.to).startsWith('inventory')),
    circuits,
  } as unknown as CartGraph;
}

function withReplayPath(graph: CartGraph): CartGraph {
  // Reads and the old-add replay need drawn request paths from every
  // application to every region's journal (the player draws these edges).
  const regions = ['us-west', 'eu-central', 'ap-northeast'];
  for (const from of regions) {
    for (const to of regions) {
      if (from === to) continue;
      (graph.edges as unknown as Record<string, unknown>[]).push({
        id: `mesh-${from}-${to}`,
        from: `app-${from}`,
        to: `journal-${to}`,
        kind: 'request',
      });
    }
  }
  return graph;
}

function concurrentProbe(kind: string, roundMs = 20_000): CartProbe {
  const found = buildCartProbes().probes.find(
    (probe) => probe.family === 'concurrent' && probe.id.endsWith(`${roundMs}:${kind}`),
  );
  if (found === undefined) throw new Error(`missing concurrent probe ${kind}`);
  return found;
}

function runProbe(probe: CartProbe): CartCaseModel {
  return runProbeWithStores(probe).model;
}

function runProbeWithStores(
  probe: CartProbe,
  options: { readonly inventory?: boolean } = {},
): { readonly model: CartCaseModel; readonly stores: readonly CartDurableStore[] } {
  const graph = withReplayPath(cartGraph(options));
  const regions = ['us-west', 'eu-central', 'ap-northeast'];
  // Player-drawn full journal replication mesh: an edit observing another
  // region's operation can only be ACKed once that closure is durable there.
  for (const from of regions) {
    for (const to of regions) {
      if (from === to) continue;
      (graph.edges as unknown as Record<string, unknown>[]).push({
        id: `repl-${from}-${to}`,
        from: `journal-${from}`,
        to: `journal-${to}`,
        kind: 'replication',
      });
    }
  }
  const facts = analyzeCartTopology(graph);
  const stores = graph.nodes
    .filter((node) => node.kind === 'journal')
    .map((node) => {
      if (node.kind !== 'journal') throw new Error('journal required');
      return new CartDurableStore({
        nodeId: node.id,
        kind: node.kind,
        size: node.size,
        writeAuthorities: Object.fromEntries(
          Object.entries(facts.authorityByRegion).filter(([, id]) => id !== null),
        ) as Record<string, string>,
        replicationEdges: graph.edges
          .filter((edge) => edge.kind === 'replication' && edge.from === node.id)
          .map((edge) => ({ edgeId: edge.id, to: edge.to })),
      });
    });
  const model = new CartCaseModel('concurrent', facts, [], [probe], graph, { durableStores: stores });
  model.run();
  return { model, stores };
}

function keyOf(probe: CartProbe, part: string, region: CartOperationKey['originRegion']): CartOperationKey {
  const index = probe.steps.findIndex((step) => step.id === `${probe.id}:${part}`);
  return { originRegion: region, clientId: `probe:${probe.id}`.slice(0, 64), requestSequence: index };
}

/** Exact expected live unit ids per frozen oracle kind (u0,u1,a,b,fresh). */
function expectedUnits(probe: CartProbe, cartId: string, kind: string): string[] {
  const baseKey = keyOf(probe, 'base-add', 'us-west');
  const one = keyOf(probe, 'actor-1', 'us-west');
  const two = keyOf(probe, 'actor-2', 'eu-central');
  const u0 = cartUnitId(cartId, baseKey, 0);
  const u1 = cartUnitId(cartId, baseKey, 1);
  const unitOf = (key: CartOperationKey, index = 0): string => cartUnitId(cartId, key, index);
  switch (kind) {
    case 'concurrent-add':
      return [u0, u1, unitOf(one), unitOf(two)];
    case 'change-2-to-3':
      return [u0, u1, unitOf(one), unitOf(two)];
    case 'change-2-to-1':
      return [u1];
    case 'remove-versus-add':
      return [unitOf(two)];
    case 'removed-old-add-replay':
      return [];
    case 'causal-readd':
      return [unitOf(two)];
    default:
      throw new Error(kind);
  }
}

function liveUnits(model: CartCaseModel, stepId: string): string[] {
  const read = model.readResults.get(stepId);
  if (read === undefined) throw new Error(`no complete read ${stepId}`);
  return Object.values(read.view.skus).flatMap((state) => [...state.live]).sort();
}

describe('concurrent edits execute their declared observed-unit operations', () => {
  const kinds = CART_CONCURRENT.kinds.filter(
    (kind) => kind !== 'identical-edit-retry' && kind !== 'causal-readd',
  );

  it('change-2-to-1 ends with exactly {u1} / quantity 1 instead of 4', () => {
    const probe = concurrentProbe('change-2-to-1');
    const model = runProbe(probe);
    const actors = ['actor-1', 'actor-2'].map((part) =>
      model.requestRecords.find((record) => record.id === `${probe.id}:${part}`),
    );
    expect(actors.every((record) => record?.committed === true && record.acknowledged)).toBe(true);
    const cartId = actors[0]?.cartId ?? '';
    expect(model.cartLiveQuantity(cartId)).toBe(1);
    for (const region of ['us-west', 'eu-central', 'ap-northeast']) {
      expect(liveUnits(model, `${probe.id}:final-${region}`)).toEqual(
        expectedUnits(probe, cartId, 'change-2-to-1'),
      );
    }
  });

  for (const kind of kinds) {
    it(`${kind}: exact frozen live set at every final read`, () => {
      const probe = concurrentProbe(kind);
      const model = runProbe(probe);
      const base = model.requestRecords.find((record) => record.id === `${probe.id}:base-add`);
      const cartId = base?.cartId ?? '';
      const expected = expectedUnits(probe, cartId, kind).sort();
      for (const region of ['us-west', 'eu-central', 'ap-northeast']) {
        expect(liveUnits(model, `${probe.id}:final-${region}`)).toEqual(expected);
      }
      expect(model.cartLiveQuantity(cartId)).toBe(expected.length);
      // Both actors went through the real charged edit path: network + durable.
      for (const part of ['actor-1', 'actor-2']) {
        const record = model.requestRecords.find((entry) => entry.id === `${probe.id}:${part}`);
        expect(record?.acknowledged).toBe(true);
        const commit = model.transferSnapshots.find((t) => t.logicalId === `${probe.id}:${part}:commit`);
        expect(commit?.status).toBe('delivered');
      }
    });
  }

  it('causal re-add carries the removal as observed context: local closure re-adds exactly {fresh}', () => {
    // Same frozen declaration, with both actors in us-west so the removal's
    // closure is durable at the re-add's authority.
    const original = concurrentProbe('causal-readd');
    const probe: CartProbe = {
      ...original,
      steps: original.steps.map((step) =>
        step.id === `${original.id}:actor-2` ? { ...step, region: 'us-west' as const } : step,
      ),
    };
    const model = runProbe(probe);
    const removal = model.requestRecords.find((record) => record.id === `${probe.id}:actor-1`);
    const readd = model.requestRecords.find((record) => record.id === `${probe.id}:actor-2`);
    expect(removal?.acknowledged).toBe(true);
    expect(readd?.acknowledged).toBe(true);
    // Offered no earlier than the actual removal ACK delivery.
    const ack = model.transferSnapshots.find((t) => t.logicalId === `${probe.id}:actor-1:ack`);
    const readdIn = model.transferSnapshots.find((t) => t.logicalId === `${probe.id}:actor-2:in`);
    expect(ack?.status).toBe('delivered');
    expect(readdIn?.enqueuedAtUs ?? 0).toBeGreaterThanOrEqual(ack?.deliveredAtUs ?? Infinity);
    const cartId = removal?.cartId ?? '';
    const fresh = cartUnitId(cartId, keyOf(probe, 'actor-2', 'us-west'), 0);
    for (const region of ['us-west', 'eu-central', 'ap-northeast']) {
      expect(liveUnits(model, `${probe.id}:final-${region}`)).toEqual([fresh]);
    }
    expect(model.cartLiveQuantity(cartId)).toBe(1);
  });

  it('causal re-add in Frankfurt is not ACKed before the removal closure is durable there', () => {
    const probe = concurrentProbe('causal-readd');
    const model = runProbe(probe);
    const readd = model.requestRecords.find((record) => record.id === `${probe.id}:actor-2`);
    // Honest durable-store rejection: no fabricated ACK, no applied re-add.
    expect(readd?.acknowledged).toBe(false);
    expect(readd?.evidenceIds).toContain('dependency-unavailable');
    expect(model.cartLiveQuantity(readd?.cartId ?? '')).toBe(0);
  });
});

describe('GC-PF5: edit retries stay on the edit dedup path, separate from checkout replay', () => {
  const regions = ['us-west', 'eu-central', 'ap-northeast'];
  const totals = (stores: readonly CartDurableStore[]): { duplicates: number; conflicts: number; committed: number } => ({
    duplicates: stores.reduce((sum, store) => sum + store.snapshot().duplicateAttempts, 0),
    conflicts: stores.reduce((sum, store) => sum + store.snapshot().conflictAttempts, 0),
    // Distinct committed envelopes at the single authority that owns the retry key.
    committed: Math.max(...stores.map((store) => store.snapshot().committedOperations)),
  });

  // No Inventory node exists: any checkout/Inventory selection would fail the step.
  for (const withInventory of [true, false]) {
    it(`identical retry: one durable effect and a recorded reply (inventory node ${withInventory ? 'drawn' : 'absent'})`, () => {
      const probe = concurrentProbe('identical-edit-retry');
      const { model, stores } = runProbeWithStores(probe, { inventory: withInventory });
      const original = model.requestRecords.find((record) => record.id === `${probe.id}:actor-2`);
      const retry = model.requestRecords.find((record) => record.id === `${probe.id}:actor-1`);
      for (const record of [original, retry]) {
        expect(record?.dependencyFailed).toBeFalsy();
        expect(record?.acknowledged).toBe(true);
        expect(record?.committed).toBe(true);
        expect(record?.evidenceIds).toEqual([original?.evidenceIds[0]]);
      }
      // The retry carries the original operation id (exact key/payload).
      expect(retry?.evidenceIds[0]).toBe(original?.evidenceIds[0]);
      // Charged real reply path, no Inventory exchange.
      expect(model.transferSnapshots.find((t) => t.logicalId === `${probe.id}:actor-1:ack`)?.status).toBe('delivered');
      expect(model.transferSnapshots.some((t) => t.logicalId.includes('inventory'))).toBe(false);
      const cartId = original?.cartId ?? '';
      const baseKey = keyOf(probe, 'base-add', 'us-west');
      const effectUnit = cartUnitId(cartId, keyOf(probe, 'actor-2', 'eu-central'), 0);
      const expected = [cartUnitId(cartId, baseKey, 0), cartUnitId(cartId, baseKey, 1), effectUnit].sort();
      for (const region of regions) {
        expect(liveUnits(model, `${probe.id}:final-${region}`)).toEqual(expected);
      }
      expect(model.cartLiveQuantity(cartId)).toBe(3);
      // base Add + the single original edit; the retry added no second envelope.
      const stats = totals(stores);
      expect(stats.duplicates).toBeGreaterThanOrEqual(1); // replica deliveries also count as dedup hits
      expect(stats.conflicts).toBe(1); // the probe's own conflict-retry step only
      const euStore = stores.find((store) => store.snapshot().nodeId === 'journal-eu-central');
      expect(euStore?.snapshot().committedOperations).toBe(2);
    });

    it(`conflict-retry: IdempotencyConflict reply with unchanged exact set (inventory node ${withInventory ? 'drawn' : 'absent'})`, () => {
      const probe = concurrentProbe('change-2-to-1');
      const { model, stores } = runProbeWithStores(probe, { inventory: withInventory });
      const conflict = model.requestRecords.find((record) => record.id === `${probe.id}:conflict-retry`);
      expect(conflict?.dependencyFailed).toBeFalsy();
      expect(conflict?.outcome).toBe('conflict');
      expect(conflict?.acknowledged).toBe(true);
      expect(conflict?.committed).toBeFalsy();
      expect(conflict?.evidenceIds).toContain('idempotency-conflict');
      expect(model.transferSnapshots.find((t) => t.logicalId === `${probe.id}:conflict-retry:ack`)?.status).toBe('delivered');
      expect(model.transferSnapshots.some((t) => t.logicalId.includes('inventory'))).toBe(false);
      expect(totals(stores).conflicts).toBe(1);
      const cartId = conflict?.cartId ?? '';
      expect(model.cartLiveQuantity(cartId)).toBe(1);
      for (const region of regions) {
        expect(liveUnits(model, `${probe.id}:final-${region}`)).toEqual(expectedUnits(probe, cartId, 'change-2-to-1'));
      }
    });
  }

  it('identical-edit-retry conflict-retry also resolves against the original edit key, not a checkout', () => {
    const probe = concurrentProbe('identical-edit-retry');
    const { model, stores } = runProbeWithStores(probe, { inventory: false });
    const conflict = model.requestRecords.find((record) => record.id === `${probe.id}:conflict-retry`);
    expect(conflict?.outcome).toBe('conflict');
    expect(conflict?.acknowledged).toBe(true);
    expect(totals(stores).conflicts).toBe(1);
    expect(model.cartLiveQuantity(conflict?.cartId ?? '')).toBe(3);
  });
});
