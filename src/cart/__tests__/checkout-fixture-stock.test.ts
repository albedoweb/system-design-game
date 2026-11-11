/**
 * GC-PF3 focused regressions: isolated checkout fixture stock.
 *
 * The frozen checkout fixtures declare initial stock (race scarce=2,
 * known-stock 10, atomic scarce=1/abundant=10) in a per-round isolated SKU
 * namespace. GC-PD1 found the constructor ignored those declarations: race
 * started at 1,000,000 units and known-stock reused one SKU across rounds.
 *
 * Every probe is executed through an actual `CartCaseModel` run (one probe per
 * run, so the shared Inventory FIFO of other probes cannot disturb timing).
 * Durable results (orders, ledger rows, final stock) are asserted separately
 * from client delivery/timeouts: a durable commit whose reply misses the
 * deadline is still a durable success.
 */
import { describe, expect, it } from 'vitest';

import { CART_LEVEL_ID, CART_VERSIONS, type CartGraph } from '../index';
import { CartCaseModel, analyzeCartTopology } from '../core/model';
import { buildCartProbes, type CartProbe } from '../core/challenges';

function cartGraph(tokyoWriteTarget = 'journal-ap-northeast'): CartGraph {
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
    app('ap-northeast', 880, tokyoWriteTarget),
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
    { id: 'write-ap', from: 'app-ap-northeast', to: tokyoWriteTarget, kind: 'request' },
    { id: 'inv-us', from: 'app-us-west', to: 'inventory-us-west', kind: 'request' },
    { id: 'inv-eu', from: 'app-eu-central', to: 'inventory-us-west', kind: 'request' },
    { id: 'inv-ap', from: 'app-ap-northeast', to: 'inventory-us-west', kind: 'request' },
    // Peer application edges let each region complete a cross-region read.
    { id: 'p-us-eu', from: 'app-us-west', to: 'app-eu-central', kind: 'request' },
    { id: 'p-eu-us', from: 'app-eu-central', to: 'app-us-west', kind: 'request' },
    { id: 'p-eu-ap', from: 'app-eu-central', to: 'app-ap-northeast', kind: 'request' },
    { id: 'p-ap-eu', from: 'app-ap-northeast', to: 'app-eu-central', kind: 'request' },
    { id: 'p-us-ap', from: 'app-us-west', to: 'app-ap-northeast', kind: 'request' },
    { id: 'p-ap-us', from: 'app-ap-northeast', to: 'app-us-west', kind: 'request' },
  ];
  const circuits: Record<string, unknown>[] = [
    { regions: ['us-west', 'eu-central'], mbps: 8 },
    { regions: ['us-west', 'ap-northeast'], mbps: 32 },
    { regions: ['eu-central', 'ap-northeast'], mbps: 8 },
  ];
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes,
    edges,
    circuits,
  } as unknown as CartGraph;
}

function checkoutProbe(roundMs: number, family: CartProbe['family']): CartProbe {
  const found = buildCartProbes().probes.find(
    (entry) => entry.caseId === 'checkout' && entry.family === family && entry.atUs === roundMs * 1000,
  );
  if (found === undefined) throw new Error(`missing ${family} @${roundMs}`);
  return found;
}

function soldQuantity(model: CartCaseModel, sku: string): number {
  let total = 0;
  for (const order of model.inventoryOrders) {
    for (const line of order.lines) if (line.sku === sku) total += line.quantity;
  }
  return total;
}

function execute(probes: readonly CartProbe[], tokyoWriteTarget?: string): CartCaseModel {
  const graph = cartGraph(tokyoWriteTarget);
  const model = new CartCaseModel('checkout', analyzeCartTopology(graph), [], probes, graph);
  model.run();
  return model;
}

describe('frozen checkout fixture stock is installed once before execution', () => {
  it('race: starts with 2 units; exactly 2 durable successes, 1 OutOfStock, final 0', () => {
    const race = checkoutProbe(20_000, 'checkout-race');
    const sku = 'probe/20000/race/scarce';
    const model = execute([race]);
    // Durable result, independent of whether each client reply was delivered.
    expect(model.inventoryOrders).toHaveLength(2);
    expect(model.inventoryLedgerRows.filter((row) => row.outcome === 'committed')).toHaveLength(2);
    expect(model.inventoryLedgerRows.filter((row) => row.outcome === 'out-of-stock')).toHaveLength(1);
    expect(model.inventoryStock[sku]).toBe(0);
    // Delivery is a separate fact: all three attempts have records whether or
    // not their replies met the 1000 ms client deadline.
    const attempts = model.requestRecords.filter((entry) => entry.id.includes(':race-'));
    expect(attempts).toHaveLength(3);
  });

  it('known-stock: each round has its own SKU that starts at 10; purchases end at 9', () => {
    const rounds = [20_000, 40_000, 60_000];
    const probes = rounds.map((round) => checkoutProbe(round, 'checkout-known-stock'));
    const skus = probes.map((probe) => String(probe.steps.find((step) => step.action === 'checkout')?.detail.sku));
    expect(new Set(skus).size).toBe(3);
    rounds.forEach((round, index) => expect(skus[index]).toBe(`probe/${round}/known-stock/sku`));
    // Each frozen oracle literal is keyed by that round's own SKU.
    probes.forEach((probe, index) =>
      expect(probe.expected).toEqual({
        kind: 'checkout-success',
        stockAfter: { [skus[index] as string]: 9 },
        orders: 1,
      }),
    );
    // Round 40 000 ms offers its prerequisite read inside the Tokyo partition
    // window [30 000, 50 000). With Tokyo's write authority in Tokyo the read
    // lacks Tokyo's certificate and is honestly unavailable, so no checkout
    // runs. A topology whose Tokyo write authority is hosted on a reachable
    // journal satisfies the prerequisite, so every round's checkout genuinely
    // executes: the prerequisite read and the purchase are delivered inside
    // their deadlines, and each isolated SKU sells exactly one unit (10 -> 9).
    const reachable = execute(probes, 'journal-us-west');
    probes.forEach((probe, index) => {
      const round = rounds[index];
      const read = probe.steps.find((step) => step.action === 'read');
      const purchase = probe.steps.find((step) => step.action === 'checkout');
      const readRecord = reachable.requestRecords.find((entry) => entry.id === read?.id);
      const purchaseRecord = reachable.requestRecords.find((entry) => entry.id === purchase?.id);
      expect(readRecord?.outcome, `round ${round} prerequisite read`).toBe('committed');
      expect(purchaseRecord?.outcome, `round ${round} checkout`).toBe('committed');
      const sku = skus[index] as string;
      expect(soldQuantity(reachable, sku), `round ${round} durable units sold`).toBe(1);
      expect(reachable.inventoryStock[sku], `round ${round} final stock`).toBe(9);
    });
    expect(reachable.inventoryOrders).toHaveLength(3);
    // Rounds 20 000 and 60 000 also execute with the default graph.
    for (const index of [0, 2]) {
      const solo = execute([probes[index] as CartProbe]);
      expect(solo.inventoryOrders).toHaveLength(1);
      expect(solo.inventoryStock[skus[index] as string]).toBe(9);
    }
    // With the unreachable prerequisite no order is ever fabricated: the 10
    // installed units of round 40 000 stay untouched.
    const unreachable = execute([probes[1] as CartProbe]);
    expect(unreachable.inventoryOrders).toHaveLength(0);
    expect(unreachable.inventoryStock[skus[1] as string]).toBe(10);
  });

  it('atomic: scarce/abundant stock is 1/10 and exactly one basket commits', () => {
    const atomic = checkoutProbe(20_000, 'checkout-atomic');
    const model = execute([atomic]);
    expect(model.inventoryOrders).toHaveLength(1);
    expect(model.inventoryStock['probe/20000/atomic/scarce']).toBe(0);
    expect([7, 8]).toContain(model.inventoryStock['probe/20000/atomic/abundant']);
  });

  it('replay and ledger-unavailable fixtures start at 10 in their isolated SKU', () => {
    for (const [family, sku] of [
      ['checkout-lost-reply', 'probe/20000/lost-reply-edit-replay/sku'],
      ['checkout-cart-unavailable', 'probe/20000/cart-path-unavailable-replay/sku'],
      ['checkout-ledger-unavailable', 'probe/20000/ledger-unavailable/sku'],
      ['checkout-conflict', 'probe/20000/conflict/sku'],
    ] as const) {
      const model = execute([checkoutProbe(20_000, family)]);
      // Conservation against the declared initial 10 (never 1,000,000).
      expect((model.inventoryStock[sku] ?? 0) + soldQuantity(model, sku)).toBe(10);
    }
  });

  it('background SKUs keep their 1,000,000 initial stock', () => {
    const model = execute([checkoutProbe(20_000, 'checkout-race')]);
    expect(model.inventoryStock['0']).toBe(1_000_000);
  });
});
