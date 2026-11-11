import { describe, expect, it } from 'vitest';
import {
  CART_LEVEL_ID,
  CART_VERSIONS,
  type CartGraph,
} from '../index';
import { CART_PROBE_EXPECTED_COUNTS, buildCartProbes, type CartProbe } from '../core/challenges';
import { runCartCase } from '../core/case';
import { evaluateCart } from '../session';
import { CART_WORKLOAD_PROFILE_DESYNC100 } from '../core/workload';
import type { CartInventoryOrder } from '../core/inventory';
import type { CartReadComplete } from '../core/reads';
import {
  auditCartProbe,
  auditCartProbes,
  type CartProbeOracleEvidence,
} from '../core/probe-oracle';

function qualifyingGraph(): CartGraph {
  const nodes: Record<string, unknown>[] = [
    { id: 'customers-us-west', kind: 'customers', region: 'us-west', position: { x: 40, y: 40 } },
    { id: 'customers-eu-central', kind: 'customers', region: 'eu-central', position: { x: 440, y: 40 } },
    { id: 'customers-ap-northeast', kind: 'customers', region: 'ap-northeast', position: { x: 840, y: 40 } },
    { id: 'app-us-west', kind: 'application', region: 'us-west', position: { x: 80, y: 200 }, size: 'S', instances: 1, writeTarget: 'journal-us-west', readPolicy: 'local-repair', readTargets: ['journal-us-west'] },
    { id: 'app-eu-central', kind: 'application', region: 'eu-central', position: { x: 480, y: 200 }, size: 'S', instances: 2, writeTarget: 'journal-eu-central', readPolicy: 'parallel', readTargets: ['journal-eu-central'] },
    { id: 'app-ap-northeast', kind: 'application', region: 'ap-northeast', position: { x: 880, y: 200 }, size: 'M', instances: 1, writeTarget: 'journal-ap-northeast', readPolicy: 'local-repair', readTargets: ['journal-ap-northeast'] },
    { id: 'journal-us-west', kind: 'journal', region: 'us-west', position: { x: 80, y: 340 }, size: 'S' },
    { id: 'journal-eu-central', kind: 'journal', region: 'eu-central', position: { x: 480, y: 340 }, size: 'M' },
    { id: 'journal-ap-northeast', kind: 'journal', region: 'ap-northeast', position: { x: 880, y: 340 }, size: 'S' },
    { id: 'inventory-us-west', kind: 'inventory', region: 'us-west', position: { x: 240, y: 480 }, size: 'M' },
  ];
  const edges: Record<string, unknown>[] = [
    { id: 'e0', from: 'customers-us-west', to: 'app-us-west', kind: 'request' },
    { id: 'e1', from: 'customers-eu-central', to: 'app-eu-central', kind: 'request' },
    { id: 'e2', from: 'customers-ap-northeast', to: 'app-ap-northeast', kind: 'request' },
    { id: 'e3', from: 'app-us-west', to: 'journal-us-west', kind: 'request' },
    { id: 'e4', from: 'app-eu-central', to: 'journal-eu-central', kind: 'request' },
    { id: 'e5', from: 'app-ap-northeast', to: 'journal-ap-northeast', kind: 'request' },
    { id: 'e6', from: 'app-us-west', to: 'inventory-us-west', kind: 'request' },
    { id: 'e7', from: 'app-eu-central', to: 'inventory-us-west', kind: 'request' },
    { id: 'e8', from: 'app-ap-northeast', to: 'inventory-us-west', kind: 'request' },
    { id: 'p1', from: 'app-us-west', to: 'app-eu-central', kind: 'request' },
    { id: 'p2', from: 'app-eu-central', to: 'app-us-west', kind: 'request' },
    { id: 'p3', from: 'app-eu-central', to: 'app-ap-northeast', kind: 'request' },
    { id: 'p4', from: 'app-ap-northeast', to: 'app-eu-central', kind: 'request' },
    { id: 'p5', from: 'app-us-west', to: 'app-ap-northeast', kind: 'request' },
    { id: 'p6', from: 'app-ap-northeast', to: 'app-us-west', kind: 'request' },
  ];
  const circuits = [
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

function completeView(cartId: string, quantity: number): CartReadComplete {
  const skus =
    quantity === 0
      ? {}
      : {
          synthetic: {
            added: [],
            tombstones: [],
            live: Array.from({ length: quantity }, (_, index) => `unit-${index}`),
            quantity,
          },
        };
  return {
    kind: 'complete',
    cartId,
    view: {
      cartId,
      skus,
      effects: {},
      appliedIds: ['op-1'],
      bufferedIds: [],
      missingDependencies: {},
      cyclicIds: [],
      duplicates: [],
      conflicts: [],
      complete: true,
      work: {},
    },
    incomingToken: {},
    outgoingToken: {},
    coveredIds: ['op-1'],
    evidence: {},
    attempts: [],
    charge: {},
    dataSources: [],
  } as unknown as CartReadComplete;
}

function record(id: string, cartId: string, overrides: Partial<import('../core/model').CartRequestRecord> = {}) {
  return {
    id,
    caseId: 'normal',
    cartId,
    region: 'us-west',
    operation: 'probe',
    cohort: 'healthy',
    offeredUs: 0,
    deadlineUs: 1,
    deliveredUs: 1,
    outcome: 'committed',
    committed: true,
    acknowledged: true,
    unresolved: false,
    rejected: false,
    dependencyFailed: false,
    exempt: false,
    deliveryUs: 1,
    evidenceIds: [],
    ...overrides,
  } as import('../core/model').CartRequestRecord;
}

function terminalStep(probe: CartProbe) {
  const steps = probe.steps.filter((step) => step.action === 'checkout' || step.action === 'replay');
  return steps[steps.length - 1];
}

/**
 * Declared expectation shapes are part of the public probe contract even when
 * the frozen fixtures never instantiate one (fixtures.json has no bare
 * `out-of-stock` probe). This builder covers such a shape without claiming it
 * is scheduled; the frozen-set test above only asserts scheduled kinds.
 */
function syntheticProbe(expected: CartProbe['expected']): CartProbe {
  const id = 'synthetic/out-of-stock';
  const add = {
    id: `${id}:add`,
    probeId: id,
    action: 'add' as const,
    region: 'us-west' as const,
    atUs: 0,
    deadlineUs: null,
    trigger: 'scheduled' as const,
    fallbackAtUs: null,
    dependsOn: [] as readonly string[],
    detail: { sku: 'synthetic/sku', count: 1 },
  };
  const checkout = {
    ...add,
    id: `${id}:checkout`,
    action: 'checkout' as const,
    dependsOn: [add.id],
    detail: { sku: 'synthetic/sku', basket: 1 },
  };
  return {
    id,
    caseId: 'checkout',
    family: 'checkout-known-stock',
    region: 'us-west',
    cohort: 'dedicated-probe',
    atUs: 0,
    deadlineUs: null,
    prerequisiteIds: [add.id],
    steps: [add, checkout],
    expected,
    denominator: 1,
  };
}

function ordersFor(
  cartId: string,
  count: number,
  lines: Record<string, number>,
  keys: readonly string[] = [],
): CartInventoryOrder[] {
  const basket = Object.entries(lines).map(([sku, quantity]) => ({ sku, quantity }));
  return Array.from({ length: count }, (_, index) => ({
    orderKey: keys[index] ?? `order-${index}`,
    cartId,
    selectedViewDigest: 'digest',
    lines: basket,
    commitSequence: index + 1,
    committedAtUs: index + 1,
  }));
}

/** Frozen request identity the checkout/replay binding must carry. */
function probeOrderKey(probe: CartProbe, step: CartProbe['steps'][number]): string {
  let index = probe.steps.indexOf(step);
  if (step.action === 'replay') {
    const ref = step.detail.original;
    const original =
      typeof ref === 'string'
        ? probe.steps.find((candidate) => candidate.id === ref)
        : undefined;
    if (original !== undefined) index = probe.steps.indexOf(original);
  }
  return `probe#${probe.id.slice(0, 40)}#${index}`.slice(0, 64);
}

interface MutableEvidence extends Omit<CartProbeOracleEvidence, 'records' | 'reads' | 'orders'> {
  records: import('../core/model').CartRequestRecord[];
  reads: Map<string, CartReadComplete>;
  orders: CartInventoryOrder[];
}

/** Evidence that satisfies the frozen expectation, independent of production. */
function passingEvidence(
  probe: CartProbe,
  override: { quantityDelta?: number; stockDelta?: number; ordersDelta?: number; mutate?: 'missing' | 'dependency' | 'timeout' } = {},
): MutableEvidence {
  const cartId = `synthetic-cart:${probe.id}`;
  const records = probe.steps
    .filter((step) => !(override.mutate === 'missing' && step.action === 'read'))
    .map((step) => record(step.id, cartId));
  const terminal = terminalStep(probe);
  const expected = probe.expected;
  let reads = new Map<string, CartReadComplete>();
  let stock: Record<string, number> = {};
  let orders: CartInventoryOrder[] = [];
  let cartQuantity = 0;

  if (expected.kind === 'complete-read') {
    cartQuantity = expected.quantity + (override.quantityDelta ?? 0);
    for (const step of probe.steps.filter((entry) => entry.action === 'read')) {
      reads.set(step.id, completeView(cartId, expected.quantity + (override.quantityDelta ?? 0)));
    }
  } else if (expected.kind === 'checkout-success') {
    stock = {};
    for (const [key, value] of Object.entries(expected.stockAfter)) {
      stock[key] = value + (override.stockDelta ?? 0);
    }
    const orderCount = expected.orders + (override.ordersDelta ?? 0);
    const purchases = probe.steps.filter((step) => step.action === 'checkout');
    const durableStep = purchases[purchases.length - 1];
    const keys = durableStep === undefined ? [] : [probeOrderKey(probe, durableStep)];
    orders = ordersFor(cartId, orderCount, expected.stockAfter, keys);
    // The delivered success reports its own durable order key.
    const terminal = terminalStep(probe);
    const orderKey = orders[0]?.orderKey;
    if (terminal !== undefined && orderKey !== undefined) {
      const recordIndex = records.findIndex((entry) => entry.id === terminal.id);
      const existing = records[recordIndex];
      if (recordIndex >= 0 && existing !== undefined) {
        records[recordIndex] = { ...existing, evidenceIds: [orderKey] };
      }
    }
    cartQuantity = expected.cartQuantity ?? 0;
  } else if (expected.kind === 'admissible-stock-set') {
    const alternative = expected.alternatives[0] ?? {};
    for (const [key, value] of Object.entries(alternative)) {
      stock[key] = value + (override.stockDelta ?? 0);
    }
    // The frozen attempt-level distribution is not implied by the aggregate
    // order count: race must produce two successful keys plus one OutOfStock
    // and atomic exactly one of each. Build that legitimate baseline here;
    // individual tests permute which scheduled attempt is the loser.
    const checkouts = probe.steps.filter((step) => step.action === 'checkout' || step.action === 'replay');
    const successCount = probe.family === 'checkout-race' ? 2 : 1;
    const orderCount = expected.orders + (override.ordersDelta ?? 0);
    // Durable rows carry the frozen request identity of the attempts that own
    // them; a successful attempt must match one of these keys exactly.
    const keys = checkouts.slice(0, orderCount).map((step) => probeOrderKey(probe, step));
    orders = ordersFor(cartId, orderCount, alternative, keys);
    checkouts.forEach((step, index) => {
      const recordIndex = records.findIndex((entry) => entry.id === step.id);
      const existing = records[recordIndex];
      if (recordIndex < 0 || existing === undefined) return;
      const success = index < successCount;
      records[recordIndex] = {
        ...existing,
        outcome: success ? 'committed' : 'out-of-stock',
        committed: success,
        evidenceIds: success ? [orders[index]?.orderKey ?? ''] : [],
      };
    });
  } else if (expected.kind === 'out-of-stock') {
    for (const [key, value] of Object.entries(expected.stockAfter)) stock[key] = value;
  } else if (expected.kind === 'unavailable') {
    for (const [key, value] of Object.entries(expected.stockAfter ?? {})) stock[key] = value;
  } else if (expected.kind === 'conflict' || expected.kind === 'validation-failed') {
    orders = ordersFor(cartId, expected.orders, {});
  }

  if (terminal !== undefined && override.mutate !== undefined) {
    const index = records.findIndex((entry) => entry.id === terminal.id);
    if (override.mutate === 'dependency' && index >= 0) {
      records[index] = record(terminal.id, cartId, { outcome: 'dependency-failed', committed: false, acknowledged: false, unresolved: true, dependencyFailed: true });
    }
    if (override.mutate === 'timeout' && index >= 0) {
      records[index] = record(terminal.id, cartId, { outcome: 'timeout', committed: false, acknowledged: false, unresolved: true });
    }
  }
  if (expected.kind === 'out-of-stock' && terminal !== undefined) {
    const index = records.findIndex((entry) => entry.id === terminal.id);
    if (index >= 0) records[index] = record(terminal.id, cartId, { outcome: 'out-of-stock', committed: true });
  }
  if (expected.kind === 'unavailable' && terminal !== undefined) {
    const index = records.findIndex((entry) => entry.id === terminal.id);
    if (index >= 0) records[index] = record(terminal.id, cartId, { outcome: 'unavailable', committed: false, exempt: true, cohort: 'incident-affected' });
  }
  if (expected.kind === 'conflict' && terminal !== undefined) {
    const index = records.findIndex((entry) => entry.id === terminal.id);
    if (index >= 0) records[index] = record(terminal.id, cartId, { outcome: 'conflict', committed: false });
  }
  if (expected.kind === 'validation-failed' && terminal !== undefined) {
    const index = records.findIndex((entry) => entry.id === terminal.id);
    if (index >= 0) records[index] = record(terminal.id, cartId, { outcome: 'validation-failed', committed: false, rejected: true });
  }
  // Explicit replays carry the original order key as their first evidence id.
  const replayStep = probe.steps.find((entry) => entry.action === 'replay');
  const purchases = probe.steps.filter((entry) => entry.action === 'checkout');
  const originalStep = purchases[purchases.length - 1];
  if (replayStep !== undefined && originalStep !== undefined) {
    // A replay reports the original durable order key, which is the durable
    // row's request identity for the original checkout attempt.
    const orderKey = orders[0]?.orderKey ?? probeOrderKey(probe, originalStep);
    for (const id of [originalStep.id, replayStep.id]) {
      const index = records.findIndex((entry) => entry.id === id);
      const existing = records[index];
      if (index >= 0 && existing !== undefined) {
        records[index] = { ...existing, evidenceIds: [orderKey] };
      }
    }
  }
  reads = new Map(reads);
  return { records, reads, stock, orders, cartQuantity: () => cartQuantity };
}

function checkoutSteps(probe: CartProbe) {
  return probe.steps.filter((step) => step.action === 'checkout' || step.action === 'replay');
}

function setCheckoutOutcome(
  probe: CartProbe,
  evidence: MutableEvidence,
  index: number,
  overrides: Partial<import('../core/model').CartRequestRecord>,
): CartProbe['steps'][number] {
  const step = checkoutSteps(probe)[index]!;
  const recordIndex = evidence.records.findIndex((entry) => entry.id === step.id);
  evidence.records[recordIndex] = { ...evidence.records[recordIndex]!, ...overrides };
  return step;
}

/**
 * Applies one legitimate winner permutation: the selected attempt is
 * OutOfStock and every other attempt commits under its own frozen request
 * identity, with a durable order row for exactly those attempts.
 */
function applyWinnerPermutation(probe: CartProbe, evidence: MutableEvidence, loser: number): void {
  const checkouts = checkoutSteps(probe);
  const cartId = evidence.records[0]!.cartId;
  const lines: Record<string, number> = {};
  for (const line of evidence.orders[0]?.lines ?? []) lines[line.sku] = line.quantity;
  const successes = checkouts.filter((_, index) => index !== loser);
  evidence.orders = ordersFor(
    cartId,
    successes.length,
    lines,
    successes.map((step) => probeOrderKey(probe, step)),
  );
  checkouts.forEach((step, index) => {
    const success = index !== loser;
    setCheckoutOutcome(probe, evidence, index, {
      outcome: success ? 'committed' : 'out-of-stock',
      committed: success,
      evidenceIds: success ? [probeOrderKey(probe, step)] : [],
    });
  });
}

describe('frozen probe oracle', () => {
  const probes = buildCartProbes().probes;

  it('visits and passes every frozen probe expectation, including every expectation kind', () => {
    const kinds = new Set<string>();
    for (const probe of probes) {
      const result = auditCartProbe(probe, passingEvidence(probe));
      expect(result.pass, `${probe.id}: ${result.reason}`).toBe(true);
      kinds.add(probe.expected.kind);
    }
    // Frozen fixtures.json never declares a bare `out-of-stock` expectation:
    // race requires one OutOfStock *terminal* inside `admissible-stock-set`
    // (fixtures.checkout.race.expected), and atomic's loser must decrement
    // nothing. The branch is exercised by the synthetic shape test below.
    expect([...kinds].sort()).toEqual([
      'admissible-stock-set',
      'checkout-success',
      'complete-read',
      'conflict',
      'unavailable',
      'validation-failed',
    ]);
    const families = new Set(probes.map((probe) => probe.family));
    for (const family of [
      'partition-boundary',
      'partition-cache-clear',
      'partition-recovery',
      'partition-replay',
      'checkout-race',
      'checkout-lost-reply',
    ]) {
      expect(families.has(family as never), family).toBe(true);
    }
  });

  it('fails a wrong complete-read quantity and an incomplete view', () => {
    const probe = probes.find((entry) => entry.expected.kind === 'complete-read' && entry.steps.some((step) => step.action === 'read'))!;
    const wrong = auditCartProbe(probe, passingEvidence(probe, { quantityDelta: 1 }));
    expect(wrong.pass).toBe(false);
    expect(wrong.reason).toBe('live-quantity');

    const evidence = passingEvidence(probe);
    const [step] = probe.steps.filter((entry) => entry.action === 'read');
    const read = evidence.reads.get(step!.id)!;
    evidence.reads.set(step!.id, {
      ...read,
      view: { ...read.view, complete: false },
    });
    expect(auditCartProbe(probe, evidence).reason).toBe('view-incomplete');
  });

  it('fails missing and dependency-failed descendants without shrinking the denominator', () => {
    const probe = probes.find(
      (entry) => entry.expected.kind === 'checkout-success',
    )!;
    const missing = auditCartProbes([probe], passingEvidence(probe, { mutate: 'missing' }));
    expect(missing.audited).toBe(1);
    expect(missing.failed).toBe(1);
    expect(missing.results[0]?.reason).toBe('unexecuted-step');
    expect(missing.gates.find((gate) => gate.code === 'probe-oracle-denominator')?.pass).toBe(true);

    const failed = auditCartProbe(probe, passingEvidence(probe, { mutate: 'dependency' }));
    expect(failed.pass).toBe(false);
    expect(failed.reason).toBe('dependency-failed');
  });

  it('fails wrong checkout stock, order count and cart quantity', () => {
    const probe = probes.find(
      (entry) => entry.expected.kind === 'checkout-success' && !entry.steps.some((step) => step.action === 'replay'),
    )!;
    expect(auditCartProbe(probe, passingEvidence(probe)).pass).toBe(true);
    expect(auditCartProbe(probe, passingEvidence(probe, { stockDelta: 1 })).reason).toMatch(/^stock/);
    expect(auditCartProbe(probe, passingEvidence(probe, { ordersDelta: 1 })).reason).toBe('orders');

    // A delivered success whose reported key is not its own durable order row
    // must not qualify even when the order count and stock still match.
    const fabricated = passingEvidence(probe);
    const terminal = terminalStep(probe)!;
    const index = fabricated.records.findIndex((entry) => entry.id === terminal.id);
    fabricated.records[index] = { ...fabricated.records[index]!, evidenceIds: ['fake-order-key'] };
    expect(auditCartProbe(probe, fabricated).reason).toBe('checkout-order-identity');
  });

  it('fails wrong admissible stock sets and wrong success where unavailable is required', () => {
    const race = probes.find((entry) => entry.family === 'checkout-race')!;
    expect(auditCartProbe(race, passingEvidence(race)).pass).toBe(true);
    expect(auditCartProbe(race, passingEvidence(race, { stockDelta: 1 })).reason).toBe('stock-set');

    const ledger = probes.find((entry) => entry.family === 'checkout-ledger-unavailable')!;
    const evidence = passingEvidence(ledger);
    const terminal = terminalStep(ledger)!;
    const index = evidence.records.findIndex((entry) => entry.id === terminal.id);
    evidence.records[index] = record(terminal.id, evidence.records[index]!.cartId, { outcome: 'committed' });
    expect(auditCartProbe(ledger, evidence).reason).toBe('wrong-outcome');
  });

  it('audits a shared-SKU placeholder expectation against the probe own decrement and conservation', () => {
    // partition-replay declares stockAfter { sku: 999_999 } while every peer
    // probe buys the same probe-sku-0. Exact final global stock cannot equal
    // each probe's own post-state; the oracle must audit the probe's own
    // decrement plus SKU-wide conservation instead of falsely failing peers.
    const replay = probes.find((entry) => entry.family === 'partition-replay')!;
    const sku = 'probe-sku-0';
    const clone = (evidence: MutableEvidence, overrides: Partial<MutableEvidence> = {}): MutableEvidence => ({
      ...evidence,
      stock: { ...evidence.stock },
      orders: [...evidence.orders],
      ...overrides,
    });
    const base = passingEvidence(replay);
    const cartId = base.records[0]!.cartId;
    const purchaseStep = replay.steps.filter((entry) => entry.action === 'checkout').pop()!;
    const own = ordersFor(cartId, 1, { [sku]: 1 }, [probeOrderKey(replay, purchaseStep)]);
    const peers = [...ordersFor('peer-cart-1', 1, { [sku]: 1 }), ...ordersFor('peer-cart-2', 1, { [sku]: 1 })];
    const healthy = clone(base, { stock: { [sku]: 999_997 }, orders: [...own, ...peers] });
    expect(auditCartProbe(replay, healthy).pass).toBe(true);

    // One missing committed order breaks conservation even though the probe's
    // own order count still matches.
    const missingOrder = clone(healthy, { orders: [...own, ...peers.slice(0, 1)] });
    expect(auditCartProbe(replay, missingOrder).reason).toMatch(/^stock-conservation/);

    // A replay that decrements twice without a second durable order is caught
    // by the same conservation check.
    const doubleDecrement = clone(healthy, { stock: { [sku]: 999_996 } });
    expect(auditCartProbe(replay, doubleDecrement).reason).toMatch(/^stock-conservation/);

    // The frozen placeholder must equal declared initial stock minus this
    // probe's own ordered quantity.
    const wrongOwnBasket = clone(healthy, {
      orders: [...ordersFor(cartId, 1, { [sku]: 2 }, [probeOrderKey(replay, purchaseStep)]), ...peers],
    });
    expect(auditCartProbe(replay, wrongOwnBasket).reason).toMatch(/^stock-placeholder/);

    // Replay identity: the replayed binding must be the original order key.
    const wrongKey = clone(healthy);
    const replayStep = replay.steps.find((entry) => entry.action === 'replay')!;
    const index = wrongKey.records.findIndex((entry) => entry.id === replayStep.id);
    wrongKey.records[index] = { ...wrongKey.records[index]!, evidenceIds: ['different-order-key'] };
    expect(auditCartProbe(replay, wrongKey).reason).toBe('replay-identity');

    // A replay whose original checkout never committed cannot deliver a result.
    const noOriginal = clone(healthy);
    const originalStep = replay.steps.filter((entry) => entry.action === 'checkout').pop()!;
    const originalIndex = noOriginal.records.findIndex((entry) => entry.id === originalStep.id);
    noOriginal.records[originalIndex] = {
      ...noOriginal.records[originalIndex]!,
      outcome: 'validation-failed',
      committed: false,
      acknowledged: false,
    };
    expect(auditCartProbe(replay, noOriginal).reason).toBe('replay-without-original');
  });

  it('accepts every legitimate race winner while keeping the frozen 2-success/1-OutOfStock distribution', () => {
    const race = probes.find((entry) => entry.family === 'checkout-race')!;
    // fixtures.checkout.race.expected: any two distinct keys succeed and one
    // is OutOfStock by1000ms; the oracle must not assume a regional winner.
    const checkouts = checkoutSteps(race);
    expect(checkouts).toHaveLength(3);
    for (let loser = 0; loser < checkouts.length; loser += 1) {
      const evidence = passingEvidence(race);
      applyWinnerPermutation(race, evidence, loser);
      const result = auditCartProbe(race, evidence);
      expect(result.pass, `loser ${loser}: ${result.reason}`).toBe(true);
    }

    // The frozen aggregate is still audited: one durable order is missing.
    const missingOrder = passingEvidence(race);
    missingOrder.orders = [];
    expect(auditCartProbe(race, missingOrder).reason).toBe('orders');
  });

  it('fails race attempt outcomes that do not match the frozen distribution', () => {
    const race = probes.find((entry) => entry.family === 'checkout-race')!;

    // All three replies claim success while only two durable orders exist.
    // Aggregate order count plus final stock previously let this pass.
    const allCommitted = passingEvidence(race);
    for (let index = 0; index < checkoutSteps(race).length; index += 1) {
      setCheckoutOutcome(race, allCommitted, index, { outcome: 'committed', committed: true });
    }
    expect(allCommitted.orders).toHaveLength(2);
    const wrongSuccesses = auditCartProbe(race, allCommitted);
    expect(wrongSuccesses.pass).toBe(false);
    expect(wrongSuccesses.reason).toBe('checkout-outcomes');
    expect(wrongSuccesses.evidenceIds).toContain('success:3!=2');

    // Zero successes is equally wrong even with two fabricated orders.
    const allLosers = passingEvidence(race);
    for (let index = 0; index < checkoutSteps(race).length; index += 1) {
      setCheckoutOutcome(race, allLosers, index, { outcome: 'out-of-stock' });
    }
    const wrongLosers = auditCartProbe(race, allLosers);
    expect(wrongLosers.pass).toBe(false);
    expect(wrongLosers.reason).toBe('checkout-outcomes');
    expect(wrongLosers.evidenceIds).toContain('success:0!=2');

    // An attempt with a non-terminal outcome can never be counted as success.
    const timedOut = passingEvidence(race);
    setCheckoutOutcome(race, timedOut, 0, {
      outcome: 'timeout',
      committed: false,
      acknowledged: false,
      unresolved: true,
    });
    expect(auditCartProbe(race, timedOut).reason).toBe('not-delivered');

    // "Two distinct keys succeed" is required: a duplicate durable checkout
    // key is not a second success.
    const duplicateKey = passingEvidence(race);
    setCheckoutOutcome(race, duplicateKey, 1, {
      evidenceIds: [probeOrderKey(race, checkoutSteps(race)[0]!)],
    });
    expect(auditCartProbe(race, duplicateKey).reason).toBe('checkout-key-not-distinct');

    // A success without the durable checkout key cannot demonstrate
    // distinctness and must not count.
    const missingKey = passingEvidence(race);
    setCheckoutOutcome(race, missingKey, 0, { evidenceIds: [] });
    expect(auditCartProbe(race, missingKey).reason).toBe('checkout-key-missing');
  });

  it('enforces the frozen atomic 1-success/1-OutOfStock distribution for either winner', () => {
    const atomic = probes.find((entry) => entry.family === 'checkout-atomic')!;
    const checkouts = checkoutSteps(atomic);
    expect(checkouts).toHaveLength(2);

    for (let loser = 0; loser < checkouts.length; loser += 1) {
      const evidence = passingEvidence(atomic);
      applyWinnerPermutation(atomic, evidence, loser);
      const result = auditCartProbe(atomic, evidence);
      expect(result.pass, `loser ${loser}: ${result.reason}`).toBe(true);
    }

    // Both simultaneous baskets cannot both succeed on one scarce unit.
    const bothCommitted = passingEvidence(atomic);
    for (let index = 0; index < checkouts.length; index += 1) {
      setCheckoutOutcome(atomic, bothCommitted, index, { outcome: 'committed', committed: true });
    }
    expect(bothCommitted.orders).toHaveLength(1);
    const wrongSuccesses = auditCartProbe(atomic, bothCommitted);
    expect(wrongSuccesses.pass).toBe(false);
    expect(wrongSuccesses.reason).toBe('checkout-outcomes');
    expect(wrongSuccesses.evidenceIds).toContain('success:2!=1');

    // Both losing is also impossible even if a stray order row exists.
    const bothLosers = passingEvidence(atomic);
    for (let index = 0; index < checkouts.length; index += 1) {
      setCheckoutOutcome(atomic, bothLosers, index, { outcome: 'out-of-stock' });
    }
    const wrongLosers = auditCartProbe(atomic, bothLosers);
    expect(wrongLosers.pass).toBe(false);
    expect(wrongLosers.reason).toBe('checkout-outcomes');
    expect(wrongLosers.evidenceIds).toContain('success:0!=1');
  });

  it('binds every successful attempt to its own durable probe order row', () => {
    const race = probes.find((entry) => entry.family === 'checkout-race')!;
    const checkouts = checkoutSteps(race);
    expect(auditCartProbe(race, passingEvidence(race)).pass).toBe(true);

    // Distinct fabricated keys next to otherwise-valid durable orders: the
    // aggregate stock and order checks still hold, but neither success owns a
    // row, so the attempt-to-order binding must fail.
    const fabricated = passingEvidence(race);
    setCheckoutOutcome(race, fabricated, 0, { evidenceIds: ['fake-a'] });
    setCheckoutOutcome(race, fabricated, 1, { evidenceIds: ['fake-b'] });
    expect(fabricated.orders).toHaveLength(2);
    const fake = auditCartProbe(race, fabricated);
    expect(fake.pass).toBe(false);
    expect(fake.reason).toBe('checkout-order-identity');

    // Swapped keys: both name real durable rows, but not the attempt's own.
    const swapped = passingEvidence(race);
    setCheckoutOutcome(race, swapped, 0, { evidenceIds: [probeOrderKey(race, checkouts[1]!)] });
    setCheckoutOutcome(race, swapped, 1, { evidenceIds: [probeOrderKey(race, checkouts[0]!)] });
    const swap = auditCartProbe(race, swapped);
    expect(swap.pass).toBe(false);
    expect(swap.reason).toBe('checkout-order-identity');

    // Cross-probe identity is not this probe's durable row.
    const crossProbe = passingEvidence(race);
    setCheckoutOutcome(race, crossProbe, 0, { evidenceIds: ['probe#some-other-probe#2'] });
    expect(auditCartProbe(race, crossProbe).reason).toBe('checkout-order-identity');

    // A success whose own durable row is absent (but the count is intact)
    // cannot stand in for the order of another attempt.
    const unbound = passingEvidence(race);
    unbound.orders = unbound.orders.map((order, index) =>
      index === 1 ? { ...order, orderKey: 'unrelated-order-key' } : order,
    );
    expect(auditCartProbe(race, unbound).reason).toBe('checkout-order-identity');

    // Duplicate durable rows cannot back two distinct successful attempts.
    const duplicateRows = passingEvidence(race);
    duplicateRows.orders = duplicateRows.orders.map((order, index) =>
      index === 1 ? { ...order, orderKey: duplicateRows.orders[0]!.orderKey } : order,
    );
    expect(auditCartProbe(race, duplicateRows).reason).toBe('order-key-not-distinct');
  });

  it('covers the declared out-of-stock expectation shape on a synthetic probe', () => {
    const probe = syntheticProbe({ kind: 'out-of-stock', stockAfter: { 'synthetic/sku': 0 } });
    expect(auditCartProbe(probe, passingEvidence(probe)).pass).toBe(true);

    const terminal = terminalStep(probe)!;
    const committed = passingEvidence(probe);
    const index = committed.records.findIndex((entry) => entry.id === terminal.id);
    committed.records[index] = record(terminal.id, committed.records[index]!.cartId, {
      outcome: 'committed',
    });
    expect(auditCartProbe(probe, committed).reason).toBe('wrong-outcome');

    const withOrder = passingEvidence(probe);
    withOrder.orders = ordersFor(withOrder.records[0]!.cartId, 1, { 'synthetic/sku': 1 });
    expect(auditCartProbe(probe, withOrder).reason).toBe('orders');
  });

  it('admits B3 explicit unavailable only for incident records and never a timeout', () => {
    const directed = probes.find((entry) => entry.family === 'partition-directed-read')!;
    const evidence = passingEvidence(directed);
    const terminal = directed.steps.find((step) => step.action === 'read')!;
    const index = evidence.records.findIndex((entry) => entry.id === terminal.id);
    evidence.reads.delete(terminal.id);
    evidence.records[index] = record(terminal.id, evidence.records[index]!.cartId, {
      outcome: 'unavailable',
      committed: false,
      exempt: true,
      cohort: 'incident-affected',
    });
    expect(auditCartProbe(directed, evidence).pass).toBe(true);

    evidence.records[index] = record(terminal.id, evidence.records[index]!.cartId, {
      outcome: 'timeout',
      committed: false,
      acknowledged: false,
      unresolved: true,
      exempt: true,
      cohort: 'incident-affected',
    });
    expect(auditCartProbe(directed, evidence).pass).toBe(false);
  });

  it('wires mandatory per-probe gates through the case boundary and withholds qualification', () => {
    const run = runCartCase({
      graph: qualifyingGraph(),
      caseId: 'mobility',
      seed: 1729,
      workloadProfile: CART_WORKLOAD_PROFILE_DESYNC100,
    });
    const oracleGates = run.result.gates.filter((gate) => gate.code.startsWith('probe-oracle:'));
    expect(oracleGates).toHaveLength(CART_PROBE_EXPECTED_COUNTS.mobility);
    expect(run.result.outcomes.probeOracleAudited).toBe(CART_PROBE_EXPECTED_COUNTS.mobility);
    expect(run.result.outcomes.probeOracleFailures).toBe(
      oracleGates.filter((gate) => !gate.pass).length,
    );
    expect(oracleGates.some((gate) => !gate.pass)).toBe(true);
    expect(run.result.gates.find((gate) => gate.code === 'probe-oracle-denominator')?.pass).toBe(true);
    expect(run.result.gates.find((gate) => gate.code === 'probe-oracle-pass')?.pass).toBe(false);
  }, 120_000);

  it('withholds qualification and score at the evaluation boundary when a frozen probe oracle fails', () => {
    const evaluation = evaluateCart(qualifyingGraph(), {
      seed: 1729,
      workloadProfile: CART_WORKLOAD_PROFILE_DESYNC100,
    });
    const mobility = evaluation.cases.find((entry) => entry.id === 'mobility')!;
    expect(mobility.gates.find((gate) => gate.code === 'probe-oracle-pass')?.pass).toBe(false);
    expect(mobility.gates.some((gate) => gate.code.startsWith('probe-oracle:') && !gate.pass)).toBe(true);
    // Mandatory gates reach the existing aggregation: any failing gate keeps
    // the run unqualified and the score null, so a wrong frozen outcome can
    // never be scored as a valid solution.
    expect(evaluation.qualified).toBe(false);
    expect(evaluation.scoreCreditsPerHour).toBeNull();
  }, 300_000);
});
