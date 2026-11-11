import { describe, expect, it } from 'vitest';
import {
  CART_LEVEL_ID,
  CART_VERSIONS,
  type CartCircuit,
  type CartGraph,
  type CartNode,
} from '../contracts';
import {
  CART_GIB_BYTES,
  CartNetworkModel,
  cartSerializationUs,
  createCartTopology,
  planCartTransfer,
} from '../core/network';
import { buildNetworkTransferDemand } from '../../simulation/resources/network';

function customers(id: string, region: CartNode['region']): CartNode {
  return { id, kind: 'customers', region, position: { x: 0, y: 0 } };
}

function application(
  id: string,
  region: CartNode['region'],
  writeTarget: string,
  instances = 1,
): CartNode {
  return {
    id,
    kind: 'application',
    region,
    position: { x: 0, y: 0 },
    size: 'S',
    instances,
    writeTarget,
    readPolicy: 'local-repair',
    readTargets: [writeTarget],
  };
}

function journal(id: string, region: CartNode['region']): CartNode {
  return { id, kind: 'journal', region, position: { x: 0, y: 0 }, size: 'S' };
}

function store(id: string, region: CartNode['region']): CartNode {
  return { id, kind: 'store', region, position: { x: 0, y: 0 }, size: 'S' };
}

function inventory(id: string, region: CartNode['region']): CartNode {
  return { id, kind: 'inventory', region, position: { x: 0, y: 0 }, size: 'S' };
}

function graph(nodes: CartNode[], circuits: CartCircuit[] = []): CartGraph {
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

const CROSS_REGION_8: CartCircuit = { regions: ['us-west', 'eu-central'], mbps: 8 };

function baseGraph(circuit: CartCircuit = CROSS_REGION_8): CartGraph {
  return graph(
    [
      customers('customers-uw', 'us-west'),
      customers('customers-eu', 'eu-central'),
      application('app-uw', 'us-west', 'journal-uw'),
      journal('journal-uw', 'us-west'),
      journal('journal-fra', 'eu-central'),
      store('store-fra', 'eu-central'),
      inventory('inventory-fra', 'eu-central'),
    ],
    [circuit],
  );
}

function network(circuit: CartCircuit = CROSS_REGION_8): CartNetworkModel {
  return new CartNetworkModel(createCartTopology(baseGraph(circuit)));
}

describe('cart physical network: hand-calculated store-and-forward stages', () => {
  it('charges client access, Application ingress NIC and 8 ms propagation for a local request', () => {
    const model = network();
    const result = model.submit({
      logicalId: 'read-request',
      bytes: 320,
      from: { kind: 'client', region: 'us-west', clientId: 'client-1' },
      to: { kind: 'node', nodeId: 'app-uw' },
      purpose: 'request',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 2560 bits at 20 Mbit/s = 128 us; at 100 Mbit/s = 25.6 -> 26 us; +8000 us.
    expect(result.transfer.stages.map((stage) => cartSerializationUs(stage.bytes, stage.link.bitsPerSecond))).toEqual([
      128, 26,
    ]);
    model.advanceToUs(20_000);
    expect(result.transfer.status).toBe('delivered');
    expect(result.transfer.deliveredAtUs).toBe(8_154);
    expect(model.counters.wanBillableBytes).toBe(0);
    expect(model.counters.localSerializedBytes).toBe(320 + 320);
  });

  it('charges both NICs, the WAN serializer and 80 ms propagation exactly once', () => {
    const model = network();
    const request = model.submit({
      logicalId: 'cross-request',
      bytes: 320,
      from: { kind: 'node', nodeId: 'app-uw' },
      to: { kind: 'node', nodeId: 'journal-fra' },
      purpose: 'request',
    });
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    model.advanceToUs(100_000);
    // 26 us NIC egress + 320 us on 8 Mbit/s + 26 us NIC ingress + 80000 us.
    expect(request.transfer.deliveredAtUs).toBe(80_372);
    expect(request.transfer.status).toBe('delivered');
    expect(request.transfer.billedWanBytes).toBe(320);
    expect(model.counters.wanBillableBytes).toBe(320);
    expect(model.counters.localSerializedBytes).toBe(640);
  });

  it('charges response traffic on the reverse WAN direction separately', () => {
    const model = network();
    model.submit({
      logicalId: 'request',
      bytes: 320,
      from: { kind: 'client', region: 'us-west', clientId: 'client-1' },
      to: { kind: 'node', nodeId: 'app-uw' },
      purpose: 'request',
    });
    // The reply crosses the WAN back to the regional Application, then the
    // Application delivers it to the local client over a separate direction.
    const replyWan = model.submit({
      logicalId: 'response-wan',
      bytes: 384,
      from: { kind: 'node', nodeId: 'journal-fra' },
      to: { kind: 'node', nodeId: 'app-uw' },
      purpose: 'reply',
    });
    const replyClient = model.submit({
      logicalId: 'response-client',
      bytes: 384,
      from: { kind: 'node', nodeId: 'app-uw' },
      to: { kind: 'client', region: 'us-west', clientId: 'client-1' },
      purpose: 'reply',
    });
    expect(replyWan.ok && replyClient.ok).toBe(true);
    if (!replyWan.ok || !replyClient.ok) return;
    model.advanceToUs(100_000);
    // Reverse: 31 us NIC + 384 us WAN + 31 us NIC + 80000 us propagation.
    expect(replyWan.transfer.deliveredAtUs).toBe(80_446);
    // Client leg: 31 us Application egress NIC + 154 us access + 8000 us.
    expect(replyClient.transfer.deliveredAtUs).toBe(8_185);
    expect(model.counters.wanBillableBytes).toBe(384);
    const wan = model.linkSnapshots.find((link) => link.id === 'wan:us-west|eu-central:reverse');
    expect(wan?.serializedBytes).toBe(384);
  });
});

describe('cart physical network: shared physical bandwidth and circuit tiers', () => {
  it('makes duplicate semantic arrows share one WAN direction', () => {
    const model = network();
    const first = model.submit({
      logicalId: 'journal-replication',
      bytes: 512,
      from: { kind: 'node', nodeId: 'app-uw' },
      to: { kind: 'node', nodeId: 'journal-fra' },
      purpose: 'replication',
    });
    const second = model.submit({
      logicalId: 'store-replication',
      bytes: 512,
      from: { kind: 'node', nodeId: 'app-uw' },
      to: { kind: 'node', nodeId: 'store-fra' },
      purpose: 'replication',
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    model.advanceToUs(200_000);
    expect(first.transfer.deliveredAtUs).toBe(80_594);
    // Same 512-byte frame waits 512 us behind the first on the shared WAN.
    expect(second.transfer.deliveredAtUs).toBe(81_106);
    expect(model.counters.wanBillableBytes).toBe(1024);
    const wanLinks = model.linkSnapshots.filter((link) => link.kind === 'wan');
    expect(wanLinks).toHaveLength(1);
    expect(wanLinks[0]?.id).toBe('wan:us-west|eu-central:forward');
  });

  it('changes real queue time when the selected circuit tier changes', () => {
    const slow = network({ regions: ['us-west', 'eu-central'], mbps: 2 });
    const fast = network({ regions: ['us-west', 'eu-central'], mbps: 8 });
    const request = {
      logicalId: 'tier-probe',
      bytes: 1_000,
      from: { kind: 'node' as const, nodeId: 'app-uw' },
      to: { kind: 'node' as const, nodeId: 'journal-fra' },
      purpose: 'request' as const,
    };
    const slowResult = slow.submit(request);
    const fastResult = fast.submit(request);
    expect(slowResult.ok && fastResult.ok).toBe(true);
    if (!slowResult.ok || !fastResult.ok) return;
    slow.advanceToUs(200_000);
    fast.advanceToUs(200_000);
    // 8000 bits: 4000 us at 2 Mbit/s versus 1000 us at 8 Mbit/s.
    expect(slowResult.transfer.deliveredAtUs).toBe(84_160);
    expect(fastResult.transfer.deliveredAtUs).toBe(81_160);
    expect(slowResult.transfer.deliveredAtUs! - fastResult.transfer.deliveredAtUs!).toBe(3_000);
  });

  it('keeps the frozen 1 Gbit/s shared helper compatible for other levels', () => {
    const demand = buildNetworkTransferDemand({
      bytes: 1_000,
      sourceNicId: 'nic-a',
      destinationNicId: 'nic-b',
      linkIds: ['wan-a-b'],
      propagationMs: 80,
    });
    expect(demand.serviceDurationMs).toBe(0.008);
    expect(demand.totalDurationMs).toBe(80.008);
    expect(demand.resources).toHaveLength(3);
    expect(demand.lanesPerFlow).toBe(1);
  });
});

describe('cart physical network: finite queues, partitions and ties', () => {
  it('does not charge in-service bytes or not-yet-reached stages against waiting limits', () => {
    const model = network();
    const first = model.submit({
      logicalId: 'first-60k',
      bytes: 60_000,
      from: { kind: 'node', nodeId: 'app-uw' },
      to: { kind: 'node', nodeId: 'journal-fra' },
      purpose: 'replication',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const wanId = 'wan:us-west|eu-central:forward';
    const nicId = 'nic:app-uw:1:egress';
    const startNic = model.linkSnapshots.find((link) => link.id === nicId);
    const startWan = model.linkSnapshots.find((link) => link.id === wanId);
    // The source NIC serializes immediately, and the WAN stage has not been
    // reached at all: neither consumes waiting capacity.
    expect(startNic?.inFlightBytes).toBe(60_000);
    expect(startNic?.waitingBytes).toBe(0);
    expect(startWan?.inFlightBytes).toBe(0);
    expect(startWan?.waitingBytes).toBe(0);

    // At 4,800 us the NIC has finished and the WAN is serializing the frame.
    model.advanceToUs(4_800);
    const serializingWan = model.linkSnapshots.find((link) => link.id === wanId);
    expect(serializingWan?.inFlightBytes).toBe(60_000);
    expect(serializingWan?.waitingBytes).toBe(0);

    // A second 60,000-byte frame is admitted while the first is in service:
    // in-service bytes do not count against the 64 KiB waiting limit.
    const second = model.submit({
      logicalId: 'second-60k',
      bytes: 60_000,
      from: { kind: 'node', nodeId: 'app-uw' },
      to: { kind: 'node', nodeId: 'journal-fra' },
      purpose: 'replication',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    model.advanceToUs(9_600);
    const queuedWan = model.linkSnapshots.find((link) => link.id === wanId);
    expect(queuedWan?.waitingBytes).toBe(60_000);
    expect(queuedWan?.inFlightBytes).toBe(60_000);

    model.advanceToUs(300_000);
    // 4,800 NIC + 60,000 WAN + 4,800 NIC + 80,000 propagation.
    expect(first.transfer.deliveredAtUs).toBe(149_600);
    expect(second.transfer.deliveredAtUs).toBe(209_600);
    expect(model.counters.wanBillableBytes).toBe(120_000);
    expect(model.checkCapacityConservation()).toEqual({ ok: true, issues: [] });
  });

  it('cancels a transfer deterministically when it reaches a genuinely full WAN queue', () => {
    const model = network();
    const results = [1, 2, 3, 4].map((index) =>
      model.submit({
        logicalId: `queued-${index}`,
        bytes: 30_000,
        from: { kind: 'node', nodeId: 'app-uw' },
        to: { kind: 'node', nodeId: 'journal-fra' },
        purpose: 'replication',
      }),
    );
    const first = results[0];
    const second = results[1];
    const third = results[2];
    const fourth = results[3];
    if (!first?.ok || !second?.ok || !third?.ok || !fourth?.ok) {
      throw new Error('all four frames fit the 256 KiB source NIC FIFO');
    }

    // Arrival times on the 8 Mbit/s WAN: 2,400 / 4,800 / 7,200 / 9,600 us.
    // The fourth arrival would queue 90,000 bytes behind the in-service frame,
    // above the 65,536-byte WAN waiting limit.
    model.advanceToUs(20_000);
    expect(fourth.transfer.status).toBe('cancelled');
    expect(fourth.transfer.cancelReason).toBe('overflow');
    expect(fourth.transfer.deliveredAtUs).toBeNull();
    expect(fourth.transfer.billedWanBytes).toBe(0);
    // Its 30,000 bytes already crossed the source NIC and stay counted.
    expect(fourth.transfer.serializedBytes).toBe(30_000);
    expect(model.counters.cancelledTransfers).toBe(1);
    expect(model.counters.rejectedTransfers).toBe(0);
    const wan = model.linkSnapshots.find((link) => link.id === 'wan:us-west|eu-central:forward');
    expect(wan?.waitingBytes).toBe(60_000);
    expect(wan?.inFlightBytes).toBe(30_000);

    model.advanceToUs(400_000);
    expect(first.transfer.status).toBe('delivered');
    expect(second.transfer.status).toBe('delivered');
    expect(third.transfer.status).toBe('delivered');
    expect(first.transfer.deliveredAtUs).toBe(114_800);
    expect(third.transfer.deliveredAtUs).toBe(174_800);
    expect(model.counters.wanBillableBytes).toBe(90_000);
    expect(model.checkCapacityConservation()).toEqual({ ok: true, issues: [] });
    for (const link of model.linkSnapshots) {
      expect(link.waitingBytes).toBe(0);
    }
  });

  it('rejects an entry-FIFO overflow before serializing any bytes', () => {
    const model = network();
    const result = model.submit({
      logicalId: 'oversized-entry',
      bytes: 300_000,
      from: { kind: 'client', region: 'us-west', clientId: 'client-1' },
      to: { kind: 'node', nodeId: 'app-uw' },
      purpose: 'request',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'overflow',
      linkId: 'client-access:us-west:client-1:up',
      waitingBytes: 0,
      limitBytes: 262_144,
    });
    expect(model.counters.rejectedTransfers).toBe(1);
    expect(model.counters.offeredTransfers).toBe(0);
    expect(model.counters.serializedBytes).toBe(0);
    expect(model.checkCapacityConservation()).toEqual({ ok: true, issues: [] });
  });

  it('cancels queued and in-flight deliveries on partition but keeps serialized WAN bytes billable', () => {
    const model = network();
    const inFlight = model.submit({
      logicalId: 'in-flight',
      bytes: 8_000,
      from: { kind: 'node', nodeId: 'app-uw' },
      to: { kind: 'node', nodeId: 'journal-fra' },
      purpose: 'replication',
    });
    const queued = model.submit({
      logicalId: 'queued',
      bytes: 1_000,
      from: { kind: 'node', nodeId: 'app-uw' },
      to: { kind: 'node', nodeId: 'store-fra' },
      purpose: 'replication',
    });
    expect(inFlight.ok && queued.ok).toBe(true);
    if (!inFlight.ok || !queued.ok) return;

    // NIC egress finished at 640 us; the WAN stage serialized 4000 of 8000 us.
    model.advanceToUs(4_640);
    model.setWanBlocked('us-west', 'eu-central', 'both', true, 4_640);
    model.advanceToUs(4_640);

    expect(inFlight.transfer.status).toBe('cancelled');
    expect(inFlight.transfer.cancelReason).toBe('link-failure');
    expect(inFlight.transfer.deliveredAtUs).toBeNull();
    expect(inFlight.transfer.billedWanBytes).toBe(4_000);
    expect(queued.transfer.status).toBe('cancelled');
    expect(queued.transfer.billedWanBytes).toBe(0);
    expect(queued.transfer.serializedBytes).toBe(1_000);
    // Cancelling queued and in-flight work releases all waiting capacity.
    const wanAfterCancel = model.linkSnapshots.find(
      (link) => link.id === 'wan:us-west|eu-central:forward',
    );
    expect(wanAfterCancel?.waitingBytes).toBe(0);
    expect(wanAfterCancel?.inFlightBytes).toBe(0);
    expect(queued.transfer.stages[2]?.state).toBe('cancelled');

    // A retry is rejected while the direction is partitioned.
    const blockedRetry = model.submit({
      logicalId: 'blocked-retry',
      bytes: 100,
      from: { kind: 'node', nodeId: 'app-uw' },
      to: { kind: 'node', nodeId: 'journal-fra' },
      purpose: 'replication',
    });
    expect(blockedRetry).toEqual({
      ok: false,
      reason: 'partitioned',
      linkId: 'wan:us-west|eu-central:forward',
    });

    model.setWanBlocked('us-west', 'eu-central', 'both', false, 5_000);
    model.advanceToUs(5_000);
    const retry = model.submit({
      logicalId: 'retry',
      bytes: 1_000,
      from: { kind: 'node', nodeId: 'app-uw' },
      to: { kind: 'node', nodeId: 'journal-fra' },
      purpose: 'replication',
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    model.advanceToUs(200_000);
    expect(retry.transfer.status).toBe('delivered');
    expect(retry.transfer.deliveredAtUs).toBe(5_000 + 80 + 1_000 + 80 + 80_000);
  });

  it('lets a completion exactly at the deadline win, but not one microsecond later', () => {
    const exact = network();
    const exactResult = exact.submit({
      logicalId: 'exact',
      bytes: 512,
      from: { kind: 'node', nodeId: 'app-uw' },
      to: { kind: 'node', nodeId: 'journal-fra' },
      purpose: 'request',
      deadlineUs: 80_594,
    });
    expect(exactResult.ok).toBe(true);
    if (!exactResult.ok) return;
    exact.advanceToUs(100_000);
    expect(exactResult.transfer.status).toBe('delivered');
    expect(exactResult.transfer.deliveredAtUs).toBe(80_594);

    const late = network();
    const lateResult = late.submit({
      logicalId: 'late',
      bytes: 512,
      from: { kind: 'node', nodeId: 'app-uw' },
      to: { kind: 'node', nodeId: 'journal-fra' },
      purpose: 'request',
      deadlineUs: 80_593,
    });
    expect(lateResult.ok).toBe(true);
    if (!lateResult.ok) return;
    late.advanceToUs(100_000);
    expect(lateResult.transfer.status).toBe('cancelled');
    expect(lateResult.transfer.cancelReason).toBe('deadline');
    expect(lateResult.transfer.deliveredAtUs).toBeNull();
    expect(lateResult.transfer.billedWanBytes).toBe(512);
  });

  it('prevents delivery when the link fails exactly at the delivery instant', () => {
    const model = network();
    const result = model.submit({
      logicalId: 'tie',
      bytes: 512,
      from: { kind: 'node', nodeId: 'app-uw' },
      to: { kind: 'node', nodeId: 'journal-fra' },
      purpose: 'request',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    model.setWanBlocked('us-west', 'eu-central', 'both', true, 80_594);
    model.advanceToUs(100_000);
    expect(result.transfer.status).toBe('cancelled');
    expect(result.transfer.cancelReason).toBe('link-failure');
    expect(result.transfer.deliveredAtUs).toBeNull();
    // Fault ordering beats the same-microsecond completion; all bytes had
    // already crossed the WAN and stay billable.
    expect(result.transfer.billedWanBytes).toBe(512);
  });
});

describe('cart physical network: deterministic accounting', () => {
  it('conserves offered, delivered, cancelled and serialized bytes', () => {
    const model = network();
    model.submit({
      logicalId: 'ok-1',
      bytes: 320,
      from: { kind: 'client', region: 'us-west', clientId: 'client-1' },
      to: { kind: 'node', nodeId: 'app-uw' },
      purpose: 'request',
    });
    model.submit({
      logicalId: 'ok-2',
      bytes: 512,
      from: { kind: 'node', nodeId: 'app-uw' },
      to: { kind: 'node', nodeId: 'journal-fra' },
      purpose: 'request',
    });
    model.submit({
      logicalId: 'lost',
      bytes: 4_000,
      from: { kind: 'node', nodeId: 'app-uw' },
      to: { kind: 'node', nodeId: 'store-fra' },
      purpose: 'replication',
    });
    model.advanceToUs(2_000);
    model.setWanBlocked('us-west', 'eu-central', 'both', true, 2_000);
    model.advanceToUs(200_000);

    const counters = model.counters;
    expect(counters.deliveredTransfers).toBe(1);
    expect(counters.cancelledTransfers).toBe(2);
    expect(counters.offeredBytes).toBe(counters.deliveredBytes + counters.cancelledBytes);
    expect(counters.serializedBytes).toBe(counters.localSerializedBytes + counters.wanBillableBytes);
    expect(counters.wanCostCredits).toBeCloseTo(counters.wanBillableBytes / CART_GIB_BYTES, 12);
    expect(model.checkCapacityConservation()).toEqual({ ok: true, issues: [] });
    for (const link of model.linkSnapshots) {
      expect(link.waitingBytes).toBe(0);
    }
  });

  it('produces the same trace for the same input order and rejects client cross-region paths', () => {
    const run = (): string => {
      const model = network();
      model.submit({
        logicalId: 'a',
        bytes: 700,
        from: { kind: 'node', nodeId: 'app-uw' },
        to: { kind: 'node', nodeId: 'journal-fra' },
        purpose: 'replication',
      });
      model.submit({
        logicalId: 'b',
        bytes: 300,
        from: { kind: 'node', nodeId: 'journal-uw' },
        to: { kind: 'node', nodeId: 'app-uw' },
        purpose: 'other',
      });
      model.advanceToUs(200_000);
      return JSON.stringify(model.counters);
    };
    expect(run()).toBe(run());

    const model = network();
    const result = model.submit({
      logicalId: 'bad-client',
      bytes: 10,
      from: { kind: 'client', region: 'eu-central', clientId: 'client-9' },
      to: { kind: 'node', nodeId: 'app-uw' },
      purpose: 'request',
    });
    expect(result).toEqual({ ok: false, reason: 'cross_region_client' });
    const topology = createCartTopology(baseGraph());
    expect(
      planCartTransfer(topology, {
        bytes: 10,
        from: { kind: 'client', region: 'eu-central', clientId: 'client-9' },
        to: { kind: 'node', nodeId: 'app-uw' },
      }),
    ).toEqual({ ok: false, reason: 'cross_region_client' });
  });
});

describe('cart physical network: settlement notification seam', () => {
  interface Settlement {
    readonly logicalId: string;
    readonly status: string;
    readonly atUs: number | null;
    readonly cancelReason: string | null;
    readonly wanBillableBytes: number;
  }

  function watched(): { model: CartNetworkModel; settled: Settlement[] } {
    const settled: Settlement[] = [];
    const model = new CartNetworkModel(createCartTopology(baseGraph()), {
      onSettled: (transfer) => {
        // Snapshot at notification time: the state must already be final.
        settled.push({
          logicalId: transfer.logicalId,
          status: transfer.status,
          atUs: transfer.status === 'delivered' ? transfer.deliveredAtUs : transfer.cancelledAtUs,
          cancelReason: transfer.cancelReason,
          wanBillableBytes: transfer.billedWanBytes,
        });
      },
    });
    return { model, settled };
  }

  const localRequest = {
    logicalId: 'watch-local',
    bytes: 320,
    from: { kind: 'client' as const, region: 'us-west' as const, clientId: 'client-1' },
    to: { kind: 'node' as const, nodeId: 'app-uw' },
    purpose: 'request' as const,
  };

  it('notifies exactly once on delivery with final state and unchanged accounting', () => {
    const plain = network();
    const { model, settled } = watched();
    expect(plain.submit(localRequest).ok).toBe(true);
    expect(model.submit(localRequest).ok).toBe(true);
    expect(settled).toEqual([]);

    plain.advanceToUs(20_000);
    model.advanceToUs(20_000);

    expect(settled).toEqual([
      {
        logicalId: 'watch-local',
        status: 'delivered',
        atUs: 8_154,
        cancelReason: null,
        wanBillableBytes: 0,
      },
    ]);
    // Adding the observer cannot change a single byte or counter.
    expect(model.counters).toEqual(plain.counters);
    expect(model.checkCapacityConservation()).toEqual({ ok: true, issues: [] });
  });

  it('notifies exactly once when the deadline cancels an in-flight transfer', () => {
    const plain = network();
    const { model, settled } = watched();
    const request = {
      logicalId: 'watch-cross',
      bytes: 320,
      from: { kind: 'node' as const, nodeId: 'app-uw' },
      to: { kind: 'node' as const, nodeId: 'journal-fra' },
      purpose: 'replication' as const,
      deadlineUs: 40_000,
    };
    expect(plain.submit(request).ok).toBe(true);
    expect(model.submit(request).ok).toBe(true);

    plain.advanceToUs(200_000);
    model.advanceToUs(200_000);

    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      logicalId: 'watch-cross',
      status: 'cancelled',
      atUs: 40_000,
      cancelReason: 'deadline',
    });
    // Bytes serialized before cancellation stay billable and identical.
    expect(settled[0]?.wanBillableBytes).toBeGreaterThan(0);
    expect(model.counters).toEqual(plain.counters);
  });

  it('delivers when the completion lands exactly on the deadline', () => {
    const probe = network();
    const reference = probe.submit({
      logicalId: 'tie-reference',
      bytes: 320,
      from: { kind: 'client', region: 'us-west', clientId: 'client-1' },
      to: { kind: 'node', nodeId: 'app-uw' },
      purpose: 'request',
    });
    expect(reference.ok).toBe(true);
    if (!reference.ok) return;
    probe.advanceToUs(20_000);
    const deliveredAtUs = reference.transfer.deliveredAtUs;
    expect(deliveredAtUs).not.toBeNull();

    const { model, settled } = watched();
    const result = model.submit({
      logicalId: 'tie',
      bytes: 320,
      from: { kind: 'client', region: 'us-west', clientId: 'client-1' },
      to: { kind: 'node', nodeId: 'app-uw' },
      purpose: 'request',
      deadlineUs: deliveredAtUs as number,
    });
    expect(result.ok).toBe(true);
    model.advanceToUs(20_000);
    expect(settled).toEqual([
      {
        logicalId: 'tie',
        status: 'delivered',
        atUs: deliveredAtUs,
        cancelReason: null,
        wanBillableBytes: 0,
      },
    ]);
    expect(model.counters.cancelledTransfers).toBe(0);
  });

  it('never notifies for a submission rejected before serialization', () => {
    const { model, settled } = watched();
    const rejected = model.submit({
      logicalId: 'watch-rejected',
      bytes: 10,
      from: { kind: 'client', region: 'eu-central', clientId: 'client-9' },
      to: { kind: 'node', nodeId: 'app-uw' },
      purpose: 'request',
    });
    expect(rejected).toEqual({ ok: false, reason: 'cross_region_client' });
    model.advanceToUs(20_000);
    expect(settled).toEqual([]);
    expect(model.counters.rejectedTransfers).toBe(1);
  });
});
