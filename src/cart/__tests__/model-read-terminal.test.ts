/**
 * GC-PF1 focused regressions: a locally terminal read outcome (for example an
 * unavailable answer because a required token is unreachable during the Tokyo
 * partition) must still reach the client over the real `:out` client-egress
 * transfer. Before the fix `pumpRead` finished a `done` protocol with no
 * delivery time, the oracle saw no reply and booked a timeout.
 *
 * Everything is asserted through an actual `CartCaseModel` run on the shared
 * network. No frozen constant, fixture, oracle or workload is changed.
 */
import { describe, expect, it } from 'vitest';

import { CART_LEVEL_ID, CART_VERSIONS, type CartGraph } from '../index';
import { CartCaseModel, analyzeCartTopology } from '../core/model';
import type { CartOperationIntent } from '../core/workload';

type Region = 'us-west' | 'eu-central' | 'ap-northeast';

const ALL_REGIONS: readonly Region[] = ['us-west', 'eu-central', 'ap-northeast'];

function graph(): CartGraph {
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  ALL_REGIONS.forEach((region, index) => {
    const x = 40 + index * 400;
    nodes.push({ id: `customers-${region}`, kind: 'customers', region, position: { x, y: 40 } });
    nodes.push({ id: `journal-${region}`, kind: 'journal', region, position: { x: x + 40, y: 340 }, size: 'S' });
    nodes.push({
      id: `app-${region}`,
      kind: 'application',
      region,
      position: { x: x + 40, y: 200 },
      size: 'S',
      instances: 1,
      writeTarget: `journal-${region}`,
      readPolicy: 'local-repair',
      readTargets: ALL_REGIONS.map((origin) => `journal-${origin}`),
    });
    edges.push({ id: `src-${region}`, from: `customers-${region}`, to: `app-${region}`, kind: 'request' });
    edges.push({ id: `write-${region}`, from: `app-${region}`, to: `journal-${region}`, kind: 'request' });
    for (const origin of ALL_REGIONS) {
      if (origin === region) continue;
      edges.push({ id: `read-${region}-${origin}`, from: `app-${region}`, to: `journal-${origin}`, kind: 'request' });
    }
  });
  nodes.push({ id: 'inventory-us-west', kind: 'inventory', region: 'us-west', position: { x: 240, y: 480 }, size: 'M' });
  for (const region of ALL_REGIONS) {
    edges.push({ id: `inv-${region}`, from: `app-${region}`, to: 'inventory-us-west', kind: 'request' });
  }
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes,
    edges,
    circuits: [
      { regions: ['us-west', 'eu-central'], mbps: 8 },
      { regions: ['us-west', 'ap-northeast'], mbps: 32 },
      { regions: ['eu-central', 'ap-northeast'], mbps: 8 },
    ],
  } as unknown as CartGraph;
}

function editIntent(id: string, region: Region, sequence: number, cartId: string, atUs: number): CartOperationIntent {
  return {
    id,
    caseId: 'normal',
    atUs,
    cartId,
    region,
    remoteReadRegion: null,
    key: { originRegion: region, clientId: 'client-a', requestSequence: sequence },
    slotIndex: 0,
    stream: 'base',
    operation: 'edit',
    editKind: 'add',
    effect: { kind: 'add', sku: 7, count: 2 },
    observedContext: [],
    dependsOn: [],
  };
}

function readIntent(
  id: string,
  tokenIds: readonly string[],
  servedBy: Region,
  cartId: string,
  atUs: number,
): CartOperationIntent {
  return {
    id,
    caseId: 'normal',
    atUs,
    cartId,
    region: servedBy,
    remoteReadRegion: servedBy,
    key: { originRegion: servedBy, clientId: 'client-a', requestSequence: 9 },
    slotIndex: 1,
    stream: 'base',
    operation: 'read',
    editKind: null,
    effect: { kind: 'read', token: [...tokenIds], servedBy },
    observedContext: [],
    dependsOn: [...tokenIds],
  };
}

function runModel(intents: readonly CartOperationIntent[]): CartCaseModel {
  const g = graph();
  const facts = analyzeCartTopology(g);
  expect(facts.qualified).toBe(true);
  const model = new CartCaseModel('normal', facts, intents, [], g);
  model.run();
  return model;
}

const CART = 'cart-terminal';

function recordOf(model: CartCaseModel, id: string) {
  const record = model.requestRecords.find((candidate) => candidate.id === id);
  expect(record).toBeDefined();
  return record!;
}

function transferOf(model: CartCaseModel, logicalId: string) {
  return model.transferSnapshots.find((transfer) => transfer.logicalId === logicalId);
}

describe('locally terminal read outcome reaches the client', () => {
  it('sends an unreachable-token unavailable answer over the real :out transfer', () => {
    // e1 is acknowledged at Tokyo before the partition; the us-west read at 41 s
    // needs Tokyo's journal, which the partition makes unreachable.
    const model = runModel([
      editIntent('e1', 'ap-northeast', 1, CART, 20_000_000),
      readIntent('r1', ['e1'], 'us-west', CART, 41_000_000),
    ]);

    const record = recordOf(model, 'r1');
    const out = transferOf(model, 'r1:out');
    // Before GC-PF1 no :out transfer existed and the oracle booked a timeout.
    expect(out).toBeDefined();
    expect(out!.status).toBe('delivered');
    expect(out!.bytes).toBe(128);
    expect(out!.to.kind).toBe('client');
    expect(record.outcome).toBe('unavailable');
    expect(record.cohort).toBe('incident-affected');
    expect(record.exempt).toBe(true);
    expect(record.acknowledged).toBe(true);
    expect(record.unresolved).toBe(false);
    // The delivery time is the actual network arrival, inside the 1000 ms deadline.
    expect(record.deliveredUs).toBe(out!.deliveredAtUs);
    expect(record.deliveredUs!).toBeGreaterThan(record.offeredUs);
    expect(record.deliveredUs!).toBeLessThanOrEqual(record.deadlineUs);
    expect(record.deadlineUs - record.offeredUs).toBe(1_000_000);
    // No remote data is invented: no evidence, no completed read result.
    expect(record.evidenceIds).toEqual([]);
    expect(model.readResults.has('r1')).toBe(false);
  });

  it('keeps lost, saturated and rejected terminal answers undelivered under a burst', () => {
    const intents: CartOperationIntent[] = [editIntent('e1', 'ap-northeast', 1, CART, 20_000_000)];
    for (let i = 0; i < 1500; i += 1) {
      intents.push(readIntent(`b${i}`, ['e1'], 'us-west', CART, 41_000_000 + i * 10));
    }
    const model = runModel(intents);

    let acknowledgedUnavailable = 0;
    let undeliveredTimeouts = 0;
    let cancelledOut = 0;
    for (const record of model.requestRecords) {
      if (!record.id.startsWith('b') || record.operation !== 'read') continue;
      const out = transferOf(model, `${record.id}:out`);
      if (record.outcome === 'unavailable' && record.acknowledged) {
        // Success only with an actual delivered reply inside the deadline.
        expect(out?.status).toBe('delivered');
        expect(record.deliveredUs).toBe(out!.deliveredAtUs);
        expect(record.deliveredUs!).toBeLessThanOrEqual(record.deadlineUs);
        acknowledgedUnavailable += 1;
      }
      if (record.outcome === 'timeout') {
        // Computed-unavailable but never delivered stays an unresolved failure.
        expect(record.acknowledged).toBe(false);
        expect(record.deliveredUs).toBeNull();
        expect(out?.status === 'delivered').toBe(false);
        undeliveredTimeouts += 1;
        if (out?.status === 'cancelled') cancelledOut += 1;
      }
    }
    // Non-vacuous: the burst has both delivered answers and deadline-cancelled ones.
    expect(acknowledgedUnavailable).toBeGreaterThan(0);
    expect(undeliveredTimeouts).toBeGreaterThan(0);
    expect(cancelledOut).toBeGreaterThan(0);
  });

  it('leaves healthy reads unchanged: no unavailable exemption outside the partition', () => {
    const model = runModel([
      editIntent('e1', 'ap-northeast', 1, CART, 20_000_000),
      readIntent('before', ['e1'], 'us-west', CART, 25_000_000),
      readIntent('after', ['e1'], 'us-west', CART, 56_000_000),
    ]);
    for (const id of ['before', 'after']) {
      const record = recordOf(model, id);
      expect(record.outcome).toBe('committed');
      expect(record.exempt).toBe(false);
      expect(model.readResults.get(id)?.coveredIds).toEqual(['ap-northeast/client-a/1']);
    }
  });
});
