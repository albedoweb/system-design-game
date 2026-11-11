import { describe, expect, it } from 'vitest';
import {
  CART_LEVEL_ID,
  CART_VERSIONS,
  type CartCircuit,
  type CartGraph,
  type CartNode,
} from '../contracts';
import {
  CART_COMPONENT_TABLE,
  CART_MIB_BYTES,
  CartResourceLedger,
  cartComponentSpec,
  cartCpuCapacityMs,
  cartDurableBytes,
  cartIoServiceUs,
  cartPeakScoreCreditsPerHour,
  cartQueueRamBytes,
  createCartNodeCapacity,
  createCartResourcePlan,
} from '../core/resources';

function application(
  id: string,
  region: CartNode['region'],
  size: 'S' | 'M',
  instances: number,
): CartNode {
  return {
    id,
    kind: 'application',
    region,
    position: { x: 0, y: 0 },
    size,
    instances,
    writeTarget: 'journal-uw',
    readPolicy: 'local-repair',
    readTargets: ['journal-uw'],
  };
}

function journal(id: string, region: CartNode['region'], size: 'S' | 'M'): CartNode {
  return { id, kind: 'journal', region, position: { x: 0, y: 0 }, size };
}

function inventory(id: string, region: CartNode['region'], size: 'S' | 'M'): CartNode {
  return { id, kind: 'inventory', region, position: { x: 0, y: 0 }, size };
}

function graph(nodes: CartNode[], circuits: CartCircuit[]): CartGraph {
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes,
    edges: [],
    circuits,
  };
}

const CIRCUIT_8: CartCircuit = { regions: ['us-west', 'eu-central'], mbps: 8 };

function plan() {
  return createCartResourcePlan(
    graph(
      [application('app-uw', 'us-west', 'S', 2), journal('journal-uw', 'us-west', 'M'), inventory('inv-fra', 'eu-central', 'S')],
      [CIRCUIT_8],
    ),
  );
}

describe('cart resource table', () => {
  it('matches the proposed CPU, RAM, durable and rental candidates', () => {
    const appS = cartComponentSpec('application', 'S');
    expect(appS.cpuLanes).toBe(1);
    expect(appS.ramBytes).toBe(64 * CART_MIB_BYTES);
    expect(appS.rentalPerHour).toBe(0.2);
    expect(appS.pendingLimit).toBe(256);
    expect(cartComponentSpec('application', 'M').cpuLanes).toBe(2);
    expect(cartComponentSpec('journal', 'S').ioPerSecond).toBe(1_000);
    expect(cartComponentSpec('journal', 'M').ioPerSecond).toBe(2_000);
    expect(cartComponentSpec('store', 'S').rentalPerHour).toBe(0.3);
    expect(cartComponentSpec('inventory', 'M').rentalPerHour).toBe(0.42);
    expect(CART_COMPONENT_TABLE.cache.M.usablePayloadBytes).toBe(16 * CART_MIB_BYTES);
  });

  it('multiplies Application rental by instance count and sums circuit rentals', () => {
    const resourcePlan = plan();
    const app = resourcePlan.nodes.get('app-uw');
    expect(app?.instances).toBe(2);
    expect(app?.rentalPerHourTotal).toBeCloseTo(0.4, 12);
    expect(resourcePlan.componentRentalPerHour).toBeCloseTo(0.4 + 0.28 + 0.24, 12);
    expect(resourcePlan.circuitRentalPerHour).toBe(0.04);
    expect(resourcePlan.totalRentalPerHour).toBeCloseTo(0.96, 12);
    expect(createCartNodeCapacity({ id: 'x', kind: 'customers', region: 'us-west', position: { x: 0, y: 0 } })).toBeNull();
  });

  it('computes CPU, IO and exact durable byte formulas', () => {
    expect(cartCpuCapacityMs(1, 1_000)).toBe(1_000);
    expect(cartCpuCapacityMs(2, 1_000)).toBe(2_000);
    expect(cartIoServiceUs(1_000)).toBe(1_000);
    expect(cartIoServiceUs(2_000)).toBe(500);
    expect(cartIoServiceUs(1_000, 3)).toBe(3_000);
    expect(cartIoServiceUs(2_000, 3)).toBe(1_500);
    expect(cartQueueRamBytes(3, 2_000)).toBe(3 * 1_024 + 2_000);
    // 608 B envelope + 96 metadata + 2*64 deliveries + 5*32 units + 2*24 tombstones.
    expect(
      cartDurableBytes({ envelopeBytes: 512 + 32 * 3, pendingDeliveries: 2, units: 5, tombstones: 2 }),
    ).toBe(1_040);
  });

  it('reproduces the B5 peak score formula exactly', () => {
    // R = 2 credits/hour over 90 s plus exactly 1 GiB of WAN bytes.
    expect(
      cartPeakScoreCreditsPerHour({ rentalPerHour: 2, wanBillableBytes: 1_073_741_824 }),
    ).toBeCloseTo(42, 12);
    // Preparation and drain extend the rental window.
    expect(
      cartPeakScoreCreditsPerHour({
        rentalPerHour: 2,
        wanBillableBytes: 0,
        preparationSeconds: 2,
        drainSeconds: 8,
      }),
    ).toBeCloseTo(40 * (2 * (100 / 3_600)), 12);
  });
});

describe('cart reservation ledger', () => {
  it('enforces per-instance pending limits without shrinking the denominator', () => {
    const ledger = new CartResourceLedger(plan());
    for (let index = 0; index < 256; index += 1) {
      expect(ledger.enqueueTask('app-uw', 0, 1)).toEqual({ ok: true });
    }
    expect(ledger.enqueueTask('app-uw', 0, 1)).toEqual({
      ok: false,
      reason: 'pending_limit',
      requested: 257,
      available: 256,
    });
    // The second Application instance has its own independent limit.
    expect(ledger.enqueueTask('app-uw', 0, 2)).toEqual({ ok: true });
    expect(ledger.snapshot('app-uw')?.pendingTasks).toBe(257);
    expect(ledger.enqueueTask('app-uw', 0, 3)).toEqual({
      ok: false,
      reason: 'invalid_reservation',
      requested: 0,
      available: 0,
    });
  });

  it('rejects queue RAM overflow deterministically and charges 1024 B per waiting task', () => {
    const ledger = new CartResourceLedger(plan());
    expect(ledger.enqueueTask('journal-uw', 1_000)).toEqual({ ok: true });
    const snapshot = ledger.snapshot('journal-uw');
    // Journal M: 64 MiB total RAM minus 16 MiB fixed process RAM.
    expect(snapshot?.workingRamBytes).toBe(48 * CART_MIB_BYTES);
    expect(snapshot?.queueRamBytes).toBe(1_024 + 1_000);

    const oversized = ledger.enqueueTask('journal-uw', 48 * CART_MIB_BYTES);
    expect(oversized.ok).toBe(false);
    if (oversized.ok) return;
    expect(oversized.reason).toBe('queue_ram');
    expect(ledger.snapshot('journal-uw')?.queueRamBytes).toBe(2_024);
    expect(ledger.completeTask('journal-uw', 1_000)).toBe(true);
    expect(ledger.snapshot('journal-uw')?.queueRamBytes).toBe(0);
    expect(ledger.completeTask('journal-uw', 1_000)).toBe(false);
  });

  it('conserves durable capacity and never revokes committed bytes', () => {
    const ledger = new CartResourceLedger(plan());
    const capacity = createCartNodeCapacity(journal('journal-uw', 'us-west', 'M'));
    expect(capacity?.durableBytesTotal).toBe(64 * CART_MIB_BYTES);

    expect(ledger.reserveDurable('journal-uw', 60 * CART_MIB_BYTES)).toEqual({ ok: true });
    expect(ledger.reserveDurable('journal-uw', 5 * CART_MIB_BYTES)).toEqual({
      ok: false,
      reason: 'durable_capacity',
      requested: 65 * CART_MIB_BYTES,
      available: 64 * CART_MIB_BYTES,
    });
    expect(ledger.commitDurable('journal-uw', 60 * CART_MIB_BYTES)).toBe(true);
    expect(ledger.releaseDurable('journal-uw', CART_MIB_BYTES)).toBe(false);
    expect(ledger.snapshot('journal-uw')?.durableCommittedBytes).toBe(60 * CART_MIB_BYTES);
    expect(ledger.snapshot('journal-uw')?.durableFreeBytes).toBe(4 * CART_MIB_BYTES);

    const totals = ledger.totals();
    // Journal M 64 MiB + Inventory S 16 MiB of durable capacity.
    expect(totals.durableCapacityBytes).toBe(80 * CART_MIB_BYTES);
    expect(totals.durableCommittedBytes).toBe(60 * CART_MIB_BYTES);
    expect(totals.durableReservedBytes).toBe(0);
    expect(totals.durableCommittedBytes + 20 * CART_MIB_BYTES).toBe(totals.durableCapacityBytes);
    expect(ledger.reserveDurable('missing', 1)).toEqual({
      ok: false,
      reason: 'unknown_node',
      requested: 1,
      available: 0,
    });
  });

  it('charges CPU and IO work without losing counters', () => {
    const ledger = new CartResourceLedger(plan());
    expect(ledger.chargeCpu('app-uw', 0.3)).toBe(true);
    expect(ledger.chargeCpu('app-uw', 0.4)).toBe(true);
    expect(ledger.chargeIo('journal-uw', 2)).toBe(true);
    expect(ledger.chargeIo('journal-uw', 1)).toBe(true);
    expect(ledger.snapshot('app-uw')?.cpuBusyMs).toBeCloseTo(0.7, 12);
    expect(ledger.snapshot('journal-uw')?.ioUnits).toBe(3);
    expect(ledger.chargeCpu('missing', 1)).toBe(false);
  });
});
