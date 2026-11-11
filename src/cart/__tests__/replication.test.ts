/**
 * GC-008 focused tests: bounded batched at-least-once replication.
 *
 * Scripted transports cover the three protocol outcomes that matter: a batch
 * that never arrives (retry with the same ids after 1000 ms), a batch that
 * arrives while its ACK is lost (duplicate work/bytes, one effect), and a
 * healthy delivery. Replication cycles are run to quiescence to prove the
 * forwarding bound.
 */
import { describe, expect, it } from 'vitest';

import type { CartOperationEnvelope, CartOperationKey } from '../core/operations';
import { cartOperationId } from '../core/operations';
import { CartDurableStore } from '../core/durable-store';
import {
  CART_REPLICATION_BATCH_OVERHEAD_BYTES,
  CartReplicationEngine,
  cartReplicationBatchBytes,
  selectReplicationBatch,
  type CartReplicationDelivery,
  type CartReplicationTransportOutcome,
} from '../core/replication';

const AUTHORITIES = {
  'us-west': 'journal-uw',
  'eu-central': 'journal-fra',
  'ap-northeast': 'journal-tky',
} as const;

function key(requestSequence: number): CartOperationKey {
  return { originRegion: 'us-west', clientId: 'client-1', requestSequence };
}

function edit(requestSequence: number, quantity = 1): CartOperationEnvelope {
  return {
    cartId: 'cart-1',
    key: key(requestSequence),
    payload: { sku: 'sku-1', kind: 'add', quantity },
    observedContext: [],
  };
}

function journal(nodeId: string, edges: readonly { edgeId: string; to: string }[] = []) {
  return new CartDurableStore({
    nodeId,
    kind: 'journal',
    size: 'S',
    writeAuthorities: AUTHORITIES,
    replicationEdges: edges,
  });
}

function store(
  nodeId: string,
  options: {
    edges?: readonly { edgeId: string; to: string }[];
    capacityBytes?: number;
  } = {},
) {
  return new CartDurableStore({
    nodeId,
    kind: 'store',
    size: 'S',
    writeAuthorities: AUTHORITIES,
    replicationEdges: options.edges ?? [],
    durableCapacityBytes: options.capacityBytes,
  });
}

describe('batch formation', () => {
  it('charges the batch overhead plus every complete envelope', () => {
    expect(cartReplicationBatchBytes([])).toBe(CART_REPLICATION_BATCH_OVERHEAD_BYTES);
    expect(cartReplicationBatchBytes([512, 640])).toBe(128 + 512 + 640);
    expect(() => cartReplicationBatchBytes([-1])).toThrow();
  });

  it('caps by 64 operations and by 32 KiB without fragmenting an envelope', () => {
    const ids = Array.from({ length: 100 }, (_, index) => ({
      cartId: 'cart-1',
      operationId: `op-${String(index).padStart(3, '0')}`,
    }));
    const sizes = new Map(ids.map((id) => [id.operationId, 512]));
    const first = selectReplicationBatch(ids, (id) => sizes.get(id.operationId) ?? null);
    // 128 + 64*512 = 32896 B > 32 KiB: the byte cap binds before the op cap.
    expect(first.ids).toHaveLength(63);
    expect(first.bytes).toBe(128 + 63 * 512);
    expect(first.oversizedSingle).toBe(false);

    const second = selectReplicationBatch(ids.slice(63), (id) => sizes.get(id.operationId) ?? null);
    expect(second.ids).toHaveLength(37);

    const compact = selectReplicationBatch(ids, () => 1);
    expect(compact.ids).toHaveLength(64);
    expect(compact.bytes).toBe(128 + 64);

    const wide = selectReplicationBatch(ids.slice(0, 70), () => 8_000);
    // 128 + 4*8000 = 32128 <= 32768; a fifth envelope would exceed the cap.
    expect(wide.ids).toHaveLength(4);
    expect(wide.bytes).toBe(128 + 4 * 8_000);
  });

  it('lets one bounded oversized envelope travel alone in its own message', () => {
    const ids = [
      { cartId: 'cart-1', operationId: 'op-1' },
      { cartId: 'cart-1', operationId: 'op-2' },
    ];
    const batch = selectReplicationBatch(ids, () => 40_000);
    expect(batch.ids).toHaveLength(1);
    expect(batch.oversizedSingle).toBe(true);
  });
});

describe('polling and immediate sends', () => {
  it('delivers on the 100 ms poll and confirms the only obligation', () => {
    const source = journal('journal-uw', [{ edgeId: 'ab', to: 'store-fra' }]);
    const target = store('store-fra');
    const engine = new CartReplicationEngine({
      edges: [{ edgeId: 'ab', from: 'journal-uw', to: 'store-fra' }],
    });
    engine.registerNode(source);
    engine.registerNode(target);

    const ack = source.commitEdit(edit(1), 50_000);
    expect(ack.ok).toBe(true);
    engine.notifyCommit('journal-uw', 50_000);
    // The next 100 ms poll is at 100 000 µs; the earlier tick never sees it.
    expect(engine.advanceTo(99_999)).toHaveLength(0);
    const results = engine.advanceTo(100_000);
    expect(results).toHaveLength(1);
    expect(results[0]?.delivery.scheduledAtUs).toBe(100_000);
    expect(results[0]?.delivery.bytes).toBe(512 + CART_REPLICATION_BATCH_OVERHEAD_BYTES);
    expect(results[0]?.accepted).toBe(1);
    expect(results[0]?.confirmed).toBe(1);
    expect(source.pendingDeliveryCount).toBe(0);
    expect(target.quantity('cart-1', 'sku-1')).toBe(1);
    expect(engine.counters.bitableBytes).toBe(640);
  });

  it('sends a full batch immediately when the source asks', () => {
    const source = journal('journal-uw', [{ edgeId: 'ab', to: 'store-fra' }]);
    const target = store('store-fra');
    const engine = new CartReplicationEngine({
      edges: [{ edgeId: 'ab', from: 'journal-uw', to: 'store-fra' }],
    });
    engine.registerNode(source);
    engine.registerNode(target);
    engine.advanceTo(0);
    source.setTimeUs(50_000);
    expect(source.commitEdit(edit(1), 50_000).ok).toBe(true);
    engine.scheduleImmediate('journal-uw', 50_000);
    const results = engine.advanceTo(50_000);
    expect(results).toHaveLength(1);
    expect(results[0]?.delivery.scheduledAtUs).toBe(50_000);
    expect(target.quantity('cart-1', 'sku-1')).toBe(1);
  });
});

describe('at-least-once failure handling', () => {
  it('retries a lost batch after 1000 ms with the same operation ids', () => {
    let attempt = 0;
    const attempts: CartReplicationDelivery[] = [];
    const transport = (delivery: CartReplicationDelivery): CartReplicationTransportOutcome => {
      attempt += 1;
      attempts.push(delivery);
      return attempt === 1
        ? { delivered: false, ackReceived: false }
        : { delivered: true, ackReceived: true };
    };
    const source = journal('journal-uw', [{ edgeId: 'ab', to: 'store-fra' }]);
    const target = store('store-fra');
    const engine = new CartReplicationEngine({
      edges: [{ edgeId: 'ab', from: 'journal-uw', to: 'store-fra' }],
      transport,
    });
    engine.registerNode(source);
    engine.registerNode(target);
    source.commitEdit(edit(1));

    const first = engine.advanceTo(0);
    expect(first[0]?.delivered).toBe(false);
    expect(source.pendingDeliveryCount).toBe(1);
    expect(target.snapshot().committedOperations).toBe(0);

    expect(engine.advanceTo(999_999)).toHaveLength(0);
    const second = engine.advanceTo(1_000_000);
    expect(second).toHaveLength(1);
    expect(second[0]?.delivery.ids).toEqual(first[0]?.delivery.ids);
    expect(source.pendingDeliveryCount).toBe(0);
    expect(target.snapshot().committedOperations).toBe(1);
    expect(attempts).toHaveLength(2);
  });

  it('duplicates real work and bytes after a lost ACK but never the effect', () => {
    let attempt = 0;
    const transport = (): CartReplicationTransportOutcome => {
      attempt += 1;
      return attempt === 1
        ? { delivered: true, ackReceived: false }
        : { delivered: true, ackReceived: true };
    };
    const source = journal('journal-uw', [{ edgeId: 'ab', to: 'store-fra' }]);
    const target = store('store-fra');
    const engine = new CartReplicationEngine({
      edges: [{ edgeId: 'ab', from: 'journal-uw', to: 'store-fra' }],
      transport,
    });
    engine.registerNode(source);
    engine.registerNode(target);
    source.commitEdit(edit(1, 2));

    const first = engine.advanceTo(0);
    // Delivered, ingested and mutable, but the sender has not been told.
    expect(first[0]?.accepted).toBe(1);
    expect(first[0]?.confirmed).toBe(0);
    expect(source.pendingDeliveryCount).toBe(1);
    expect(target.quantity('cart-1', 'sku-1')).toBe(2);

    engine.advanceTo(1_000_000);
    expect(source.pendingDeliveryCount).toBe(0);
    expect(target.quantity('cart-1', 'sku-1')).toBe(2);
    expect(target.snapshot().committedOperations).toBe(1);
    expect(engine.counters.duplicateOperations).toBe(1);
    expect(engine.counters.bitableBytes).toBe(2 * 640);
  });

  it('keeps an obligation when the target cannot durably accept the batch', () => {
    const source = journal('journal-uw', [{ edgeId: 'ab', to: 'store-fra' }]);
    // The target has room for one 736 B store commit, not two.
    const target = store('store-fra', { capacityBytes: 1_000 });
    const engine = new CartReplicationEngine({
      edges: [{ edgeId: 'ab', from: 'journal-uw', to: 'store-fra' }],
    });
    engine.registerNode(source);
    engine.registerNode(target);
    source.commitEdit(edit(1));
    source.commitEdit(edit(2));

    const results = engine.advanceTo(0);
    expect(results[0]?.accepted).toBe(1);
    expect(results[0]?.rejected).toBe(1);
    expect(results[0]?.confirmed).toBe(1);
    expect(target.snapshot().committedOperations).toBe(1);
    expect(source.pendingDeliveryCount).toBe(1);

    const retried = engine.advanceTo(1_000_000);
    expect(retried[0]?.delivery.ids).toHaveLength(1);
    expect(source.pendingDeliveryCount).toBe(1);
  });

  it('retains obligations through a partition and delivers after recovery', () => {
    const transport = (delivery: CartReplicationDelivery): CartReplicationTransportOutcome =>
      delivery.scheduledAtUs < 1_500_000
        ? { delivered: false, ackReceived: false }
        : { delivered: true, ackReceived: true };
    const source = journal('journal-uw', [{ edgeId: 'ab', to: 'store-fra' }]);
    const target = store('store-fra');
    const engine = new CartReplicationEngine({
      edges: [{ edgeId: 'ab', from: 'journal-uw', to: 'store-fra' }],
      transport,
    });
    engine.registerNode(source);
    engine.registerNode(target);
    source.commitEdit(edit(1, 3));

    engine.advanceTo(0);
    engine.advanceTo(1_000_000);
    expect(source.pendingDeliveryCount).toBe(1);
    expect(target.snapshot().committedOperations).toBe(0);

    engine.advanceTo(2_000_000);
    expect(source.pendingDeliveryCount).toBe(0);
    expect(target.quantity('cart-1', 'sku-1')).toBe(3);
  });
});

describe('bounded forwarding', () => {
  it('stops a three-node replication cycle after one hop per edge', () => {
    const edges = [
      { edgeId: 'ab', from: 'journal-uw', to: 'store-fra' },
      { edgeId: 'bc', from: 'store-fra', to: 'store-tky' },
      { edgeId: 'ca', from: 'store-tky', to: 'journal-uw' },
    ];
    const a = journal('journal-uw', [{ edgeId: 'ab', to: 'store-fra' }]);
    const b = store('store-fra', { edges: [{ edgeId: 'bc', to: 'store-tky' }] });
    const c = store('store-tky', { edges: [{ edgeId: 'ca', to: 'journal-uw' }] });
    const engine = new CartReplicationEngine({ edges });
    engine.registerNode(a);
    engine.registerNode(b);
    engine.registerNode(c);
    a.commitEdit(edit(1, 2));

    const first = engine.advanceTo(0);
    expect(first).toHaveLength(3);
    expect(a.snapshot().committedOperations).toBe(1);
    expect(b.snapshot().committedOperations).toBe(1);
    expect(c.snapshot().committedOperations).toBe(1);
    expect(engine.pendingObligations).toBe(0);
    expect(engine.counters.duplicateOperations).toBe(1);
    // The forwarding hop back into the origin is a duplicate, not a new effect.
    expect(a.quantity('cart-1', 'sku-1')).toBe(2);

    const second = engine.advanceTo(10_000_000);
    expect(second).toHaveLength(0);
    expect(engine.counters.attempts).toBe(3);
    expect(a.snapshot().committedOperations).toBe(1);
  });

  it('delivers a batch in 64-operation slices across consecutive polls', () => {
    const source = journal('journal-uw', [{ edgeId: 'ab', to: 'store-fra' }]);
    const target = store('store-fra');
    const engine = new CartReplicationEngine({
      edges: [{ edgeId: 'ab', from: 'journal-uw', to: 'store-fra' }],
    });
    engine.registerNode(source);
    engine.registerNode(target);
    for (let sequence = 1; sequence <= 100; sequence += 1) {
      expect(source.commitEdit(edit(sequence)).ok).toBe(true);
    }
    expect(source.pendingDeliveryCount).toBe(100);

    const first = engine.advanceTo(0);
    expect(first[0]?.delivery.ids).toHaveLength(63);
    expect(first[0]?.delivery.bytes).toBe(128 + 63 * 512);
    expect(source.pendingDeliveryCount).toBe(37);

    const second = engine.advanceTo(100_000);
    expect(second[0]?.delivery.ids).toHaveLength(37);
    expect(source.pendingDeliveryCount).toBe(0);
    expect(target.snapshot().committedOperations).toBe(100);
    expect(target.readCart('cart-1').ok && target.quantity('cart-1', 'sku-1')).toBe(100);
    // Same key/context set expands to the same unit ids at every replica.
    expect(target.tokenFor('cart-1').ids).toHaveLength(100);
    expect(engine.counters.bitableBytes).toBe(2 * 128 + 100 * 512);
    expect(cartOperationId(key(100))).toBe('us-west/client-1/100');
  });
});
