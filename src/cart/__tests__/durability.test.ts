/**
 * GC-008 focused tests: durable ingestion, retry identity, atomic
 * operation/dedup/outbox commits, charged materialization and finite storage.
 *
 * Every expectation below is derived from `cart-protocol-v1` §3/B2 and the
 * DEVELOPER §7 byte/work tables, not from the implementation's own constants
 * where a literal is available: envelope 512+32/context, 96 B dedup/result,
 * 32 B commit sequence/time, 64 B per pending obligation, 32 B/unit and
 * 24 B/tombstone. Journal append 0.20 CPU-ms + 1 IO, store ingest 0.50 + 0.01
 * per affected item + 1 IO, dedup hit 0.10 + 1 IO.
 */
import { describe, expect, it } from 'vitest';

import type { CartEffect, CartOperationEnvelope, CartOperationKey } from '../core/operations';
import { cartOperationId } from '../core/operations';
import {
  CART_ENVELOPE_BASE_BYTES,
  CartDurableStore,
  cartAckBytes,
  cartEditEnvelopeBytes,
  cartJournalScanIoUnits,
  cartSessionToken,
  cartSessionTokenBytes,
  mergeCartSessionTokens,
  type CartCommitResult,
  type CartDurableCheckpoint,
} from '../core/durable-store';

import type { CartRegion } from '../contracts';

function key(
  requestSequence: number,
  originRegion: CartOperationKey['originRegion'] = 'us-west',
  clientId = 'client-1',
): CartOperationKey {
  return { originRegion, clientId, requestSequence };
}

function edit(
  cartId: string,
  requestSequence: number,
  kind: 'add' | 'change' | 'remove',
  sku = 'sku-1',
  quantity: number | null = 1,
  observedContext: string[] = [],
  originRegion: CartOperationKey['originRegion'] = 'us-west',
): CartOperationEnvelope {
  return {
    cartId,
    key: key(requestSequence, originRegion),
    payload: { sku, kind, quantity },
    observedContext,
  };
}

function authorities(
  overrides: Partial<Record<CartRegion, string>> = {},
): Record<CartRegion, string> {
  return {
    'us-west': 'journal-uw',
    'eu-central': 'journal-fra',
    'ap-northeast': 'journal-tky',
    ...overrides,
  };
}

function journal(options: {
  nodeId?: string;
  edges?: readonly { edgeId: string; to: string }[];
  capacityBytes?: number;
  reachable?: readonly string[];
} = {}): CartDurableStore {
  return new CartDurableStore({
    nodeId: options.nodeId ?? 'journal-uw',
    kind: 'journal',
    size: 'S',
    writeAuthorities: authorities(),
    replicationEdges: options.edges ?? [],
    reachableNodeIds: options.reachable,
    durableCapacityBytes: options.capacityBytes,
  });
}

function store(options: {
  nodeId?: string;
  edges?: readonly { edgeId: string; to: string }[];
  capacityBytes?: number;
  workingRamBytes?: number;
  reachable?: readonly string[];
} = {}): CartDurableStore {
  return new CartDurableStore({
    nodeId: options.nodeId ?? 'store-uw',
    kind: 'store',
    size: 'S',
    writeAuthorities: authorities({ 'us-west': 'store-uw' }),
    replicationEdges: options.edges ?? [],
    reachableNodeIds: options.reachable,
    durableCapacityBytes: options.capacityBytes,
    workingRamBytes: options.workingRamBytes,
  });
}

function expectAccepted(result: CartCommitResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected acceptance, got ${result.reason}`);
  return result.ack;
}

function expectRejected(result: CartCommitResult) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected rejection');
  return result;
}
describe('durable ACK ordering', () => {
  it('builds the ACK only after envelope, binding and outbox obligations are durable', () => {
    const checkpoints: CartDurableCheckpoint[] = [];
    const node = new CartDurableStore({
      nodeId: 'journal-uw',
      kind: 'journal',
      size: 'S',
      writeAuthorities: authorities(),
      replicationEdges: [
        { edgeId: 'edge-uw-fra', to: 'journal-fra' },
        { edgeId: 'edge-uw-tky', to: 'journal-tky' },
      ],
      onDurableCommit: (checkpoint) => {
        // Observed inside the commit: durable log, binding and obligations all
        // already exist, and no ACK has been emitted yet.
        checkpoints.push({ ...checkpoint, tokenIds: [...checkpoint.tokenIds] });
      },
    });

    const ack = expectAccepted(node.commitEdit(edit('cart-1', 1, 'add')));
    expect(checkpoints).toHaveLength(1);
    const checkpoint = checkpoints[0];
    expect(checkpoint?.outboxEdgeIds).toEqual(['edge-uw-fra', 'edge-uw-tky']);
    expect(checkpoint?.tokenIds).toEqual([cartOperationId(key(1))]);
    expect(node.pendingDeliveryCount).toBe(2);
    expect(node.snapshot().committedOperations).toBe(1);
    expect(node.snapshot().ackCount).toBe(1);
    // ACK size itself: 128 B plus 32 B per token id.
    expect(ack.bytes).toBe(160);
    expect(ack.token.ids).toEqual([cartOperationId(key(1))]);
  });

  it('returns no ACK and mutates nothing when the durable reservation fails', () => {
    const node = journal({ capacityBytes: CART_ENVELOPE_BASE_BYTES + 96 + 32 - 1 });
    const result = expectRejected(node.commitEdit(edit('cart-1', 1, 'add')));
    expect(result.reason).toBe('durable-capacity');
    expect(node.snapshot().committedOperations).toBe(0);
    expect(node.snapshot().ackCount).toBe(0);
    expect(node.pendingDeliveryCount).toBe(0);
    expect(node.readCart('cart-1').ok).toBe(true);
  });

  it('reserves the whole commit atomically and never revokes acknowledged writes on overflow', () => {
    const oneCommit = CART_ENVELOPE_BASE_BYTES + 96 + 32; // no units in a journal
    const node = journal({ capacityBytes: oneCommit });
    expectAccepted(node.commitEdit(edit('cart-1', 1, 'add', 'sku-1', 3)));
    const afterFirst = node.snapshot();
    const tokenAfterFirst = node.tokenFor('cart-1');

    const overflow = expectRejected(node.commitEdit(edit('cart-1', 2, 'add')));
    expect(overflow.reason).toBe('durable-capacity');
    expect(node.snapshot().committedOperations).toBe(1);
    expect(node.snapshot().durableCommittedBytes).toBe(afterFirst.durableCommittedBytes);
    expect(node.tokenFor('cart-1')).toEqual(tokenAfterFirst);
    const read = node.readCart('cart-1');
    expect(read.ok && read.view.skus['sku-1']?.quantity).toBe(3);
  });
});

describe('retry identity', () => {
  it('replays the original acceptance and token without a second effect', () => {
    const node = journal({ edges: [{ edgeId: 'edge-a', to: 'journal-fra' }] });
    const first = expectAccepted(node.commitEdit(edit('cart-1', 1, 'add')));
    expectAccepted(node.commitEdit(edit('cart-1', 2, 'add')));
    const pendingBefore = node.pendingDeliveryCount;
    const retry = expectAccepted(node.commitEdit(edit('cart-1', 1, 'add')));

    expect(retry.status).toBe('duplicate');
    expect(retry.token).toEqual(first.token);
    expect(retry.token.ids).toEqual([cartOperationId(key(1))]);
    expect(node.tokenFor('cart-1').ids).toHaveLength(2);
    expect(node.snapshot().committedOperations).toBe(2);
    expect(node.snapshot().duplicateAttempts).toBe(1);
    expect(node.pendingDeliveryCount).toBe(pendingBefore);
  });

  it('fails a mismatched payload with IdempotencyConflict and no mutation', () => {
    const node = journal();
    expectAccepted(node.commitEdit(edit('cart-1', 1, 'add', 'sku-1', 2)));
    const before = node.snapshot();
    const conflict = expectRejected(node.commitEdit(edit('cart-1', 1, 'add', 'sku-1', 3)));
    expect(conflict.reason).toBe('idempotency-conflict');
    expect(node.snapshot().committedOperations).toBe(before.committedOperations);
    expect(node.snapshot().durableCommittedBytes).toBe(before.durableCommittedBytes);
    expect(node.snapshot().conflictAttempts).toBe(1);
    expect(node.readCart('cart-1').ok && node.quantity('cart-1', 'sku-1')).toBe(2);
  });

  it('routes a retry from another region to the key origin authority', () => {
    const frankfurt = journal({ nodeId: 'journal-fra' });
    const routed = expectRejected(
      frankfurt.commitEdit(
        edit('cart-1', 1, 'add', 'sku-1', 1, [], 'us-west'),
        0,
      ),
    );
    expect(routed.reason).toBe('route-to-authority');
    expect(routed.authorityNodeId).toBe('journal-uw');
    expect(frankfurt.snapshot().committedOperations).toBe(0);

    const isolated = journal({ nodeId: 'journal-fra', reachable: ['journal-fra'] });
    const unavailable = expectRejected(
      isolated.commitEdit(edit('cart-1', 1, 'add', 'sku-1', 1, [], 'us-west')),
    );
    expect(unavailable.reason).toBe('unavailable');
    expect(isolated.snapshot().committedOperations).toBe(0);
  });

  it('does not acknowledge an edit whose causal closure is not durable', () => {
    const node = journal();
    const missing = expectRejected(
      node.commitEdit(edit('cart-1', 2, 'change', 'sku-1', 4, [cartOperationId(key(1))])),
    );
    expect(missing.reason).toBe('dependency-unavailable');
    expect(node.snapshot().committedOperations).toBe(0);
    expect(node.snapshot().ackCount).toBe(0);
  });
});

describe('replica ingest', () => {
  it('buffers an out-of-order envelope and completes the view when its dependency arrives', () => {
    const authority = journal();
    const base = expectAccepted(authority.commitEdit(edit('cart-1', 1, 'add', 'sku-1', 2)));
    const baseId = base.operationId;
    const removal = expectAccepted(
      authority.commitEdit(edit('cart-1', 2, 'remove', 'sku-1', null, [baseId])),
    );

    const replica = store({ nodeId: 'store-uw' });
    const buffered = replica.ingestReplica(removal.envelope, { arrivalEdgeId: 'edge-1' });
    expect(buffered.ok).toBe(true);
    if (!buffered.ok) throw new Error('expected buffered accept');
    expect(replica.readCart('cart-1').ok).toBe(true);
    const bufferedRead = replica.readCart('cart-1');
    expect(bufferedRead.ok && bufferedRead.complete).toBe(false);
    expect(bufferedRead.ok && bufferedRead.view.bufferedIds).toEqual([removal.operationId]);
    expect(bufferedRead.ok && bufferedRead.view.missingDependencies[removal.operationId]).toEqual([
      baseId,
    ]);

    const dependency = replica.ingestReplica(base.envelope, { arrivalEdgeId: 'edge-1' });
    expect(dependency.ok).toBe(true);
    const read = replica.readCart('cart-1');
    expect(read.ok && read.complete).toBe(true);
    expect(replica.quantity('cart-1', 'sku-1')).toBe(0);
  });

  it('treats a duplicate delivery as one effect with no extra outbox obligation', () => {
    const authority = journal();
    const ack = expectAccepted(authority.commitEdit(edit('cart-1', 1, 'add', 'sku-1', 2)));
    const replica = store({ nodeId: 'store-uw', edges: [{ edgeId: 'edge-down', to: 'store-eu' }] });
    const first = replica.ingestReplica(ack.envelope, { arrivalEdgeId: 'edge-in' });
    expect(first.ok && first.ack.status).toBe('accepted');
    expect(first.ok && first.ack.outboxEdgeIds).toEqual(['edge-down']);
    const pending = replica.pendingDeliveryCount;
    const bytes = replica.snapshot().durableCommittedBytes;

    const duplicate = replica.ingestReplica(ack.envelope, { arrivalEdgeId: 'edge-in' });
    expect(duplicate.ok && duplicate.ack.status).toBe('duplicate');
    expect(duplicate.ok && duplicate.ack.outboxEdgeIds).toEqual([]);
    expect(replica.pendingDeliveryCount).toBe(pending);
    expect(replica.snapshot().durableCommittedBytes).toBe(bytes);
    expect(replica.quantity('cart-1', 'sku-1')).toBe(2);
  });

  it('rejects a replica envelope that declares a different derived effect', () => {
    const replica = store({ nodeId: 'store-uw' });
    const declared: CartEffect = { adds: ['cart-1/us-west/client-1/1#99'], tombstones: [] };
    const result = replica.ingestReplica(edit('cart-1', 1, 'add', 'sku-1', 1), {
      declaredEffect: declared,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('effect-mismatch');
    expect(replica.snapshot().committedOperations).toBe(0);
  });

  it('rejects a conflicting payload on the replica path without mutation', () => {
    const replica = store({ nodeId: 'store-uw' });
    expect(
      replica.ingestReplica(edit('cart-1', 1, 'add', 'sku-1', 1), { arrivalEdgeId: 'e' }).ok,
    ).toBe(true);
    const conflict = replica.ingestReplica(edit('cart-1', 1, 'add', 'sku-1', 2), {
      arrivalEdgeId: 'e',
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reason).toBe('idempotency-conflict');
    expect(replica.quantity('cart-1', 'sku-1')).toBe(1);
  });
});

describe('outbox obligations', () => {
  it('confirms only delivered obligations and retains the log and tombstones', () => {
    const node = store({ nodeId: 'store-uw', edges: [{ edgeId: 'edge-out', to: 'store-fra' }] });
    const first = expectAccepted(node.commitEdit(edit('cart-1', 1, 'add', 'sku-1', 2)));
    const second = expectAccepted(
      node.commitEdit(edit('cart-1', 2, 'change', 'sku-1', 1, [first.operationId])),
    );
    expect(node.pendingDeliveryCount).toBe(2);
    const committed = node.snapshot().durableCommittedBytes;

    expect(
      node.confirmDelivery('edge-out', [{ cartId: second.cartId, operationId: second.operationId }]),
    ).toBe(1);
    expect(node.pendingDeliveryCount).toBe(1);
    // 64 B of pending obligation released; retained history untouched.
    expect(node.snapshot().durableCommittedBytes).toBe(committed - 64);
    expect(node.snapshot().committedOperations).toBe(2);
    expect(node.readCart('cart-1').ok && node.quantity('cart-1', 'sku-1')).toBe(1);
    // Re-confirming the same ack is a no-op, never a double release.
    expect(
      node.confirmDelivery('edge-out', [{ cartId: second.cartId, operationId: second.operationId }]),
    ).toBe(0);
  });
});

describe('declared bytes and charges', () => {
  it('charges journal append, dedup hit and journal read exactly', () => {
    const node = journal();
    const ack = expectAccepted(node.commitEdit(edit('cart-1', 1, 'add')));
    expect(ack.charge).toEqual({ cpuMilliseconds: 0.2, ioUnits: 1 });
    expect(node.snapshot().cpuMilliseconds).toBeCloseTo(0.2, 10);
    expect(node.snapshot().ioUnits).toBe(1);

    expectAccepted(node.commitEdit(edit('cart-1', 1, 'add')));
    // Dedup hit: 0.10 CPU-ms and one IO at a durable service.
    expect(node.snapshot().cpuMilliseconds).toBeCloseTo(0.3, 10);
    expect(node.snapshot().ioUnits).toBe(2);

    const read = node.readCart('cart-1');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // 0.15 CPU-ms + 0.05 per retained operation; ceil(1/16) = 1 IO.
    expect(read.charge).toEqual({ cpuMilliseconds: 0.2, ioUnits: 1 });
  });

  it('accounts store ingest, materialized units and the doubled RAM working set', () => {
    const node = store({ nodeId: 'store-uw', edges: [{ edgeId: 'edge-out', to: 'store-fra' }] });
    const ack = expectAccepted(node.commitEdit(edit('cart-1', 1, 'add', 'sku-1', 2)));
    expect(ack.charge).toEqual({ cpuMilliseconds: 0.52, ioUnits: 1 });
    const snapshot = node.snapshot();
    // 512 envelope + 96 dedup/result + 32 sequence/time + 64 obligation
    // + 2 units * 32 B.
    expect(snapshot.durableCommittedBytes).toBe(512 + 96 + 32 + 64 + 2 * 32);
    expect(snapshot.materializedDurableBytes).toBe(2 * 32);
    expect(snapshot.materializedRamBytes).toBe(2 * 2 * 32);
  });

  it('rejects a commit that would exceed the store materialized RAM budget', () => {
    const node = store({ nodeId: 'store-uw', workingRamBytes: 100 });
    const rejected = expectRejected(node.commitEdit(edit('cart-1', 1, 'add', 'sku-1', 2)));
    expect(rejected.reason).toBe('working-ram');
    expect(node.snapshot().committedOperations).toBe(0);
  });

  it('enforces the RAM budget across all carts on the node, not one cart at a time', () => {
    // Each cart alone needs 2 units * 32 B * 2 = 128 B of working RAM, so both
    // fit individually under a 200 B node budget; together they need 256 B.
    const node = store({ nodeId: 'store-uw', workingRamBytes: 200 });
    const first = expectAccepted(node.commitEdit(edit('cart-a', 1, 'add', 'sku-1', 2)));
    expect(first.status).toBe('accepted');
    expect(node.snapshot().materializedRamBytes).toBe(2 * 32 * 2);

    const second = expectRejected(node.commitEdit(edit('cart-b', 1, 'add', 'sku-1', 2)));
    expect(second.reason).toBe('working-ram');
    // No ACK and no durable record for the rejected cart.
    expect(node.snapshot().carts).toBe(1);
    expect(node.snapshot().committedOperations).toBe(1);
    expect(node.snapshot().ackCount).toBe(1);
    expect(node.hasCart('cart-b')).toBe(false);
    expect(node.snapshot().materializedRamBytes).toBe(2 * 32 * 2);
    // The already acknowledged cart remains fully readable.
    const read = node.readCart('cart-a');
    expect(read.ok && read.view.skus['sku-1']?.quantity).toBe(2);
  });

  it('admits several carts when their combined working set fits the node budget', () => {
    const node = store({ nodeId: 'store-uw', workingRamBytes: 256 });
    expectAccepted(node.commitEdit(edit('cart-a', 1, 'add', 'sku-1', 2)));
    expectAccepted(node.commitEdit(edit('cart-b', 1, 'add', 'sku-1', 2)));
    const snapshot = node.snapshot();
    expect(snapshot.carts).toBe(2);
    expect(snapshot.ackCount).toBe(2);
    expect(snapshot.materializedRamBytes).toBe(2 * (2 * 32) * 2);
  });

  it('tracks commit sequence and durable flush time per operation', () => {
    const node = journal();
    const first = expectAccepted(node.commitEdit(edit('cart-1', 1, 'add'), 5_000));
    const second = expectAccepted(node.commitEdit(edit('cart-1', 2, 'add'), 9_000));
    expect(first.operationId).toBe(cartOperationId(key(1)));
    expect(node.commitSequenceFor('cart-1', first.operationId)).toBe(1);
    expect(node.commitSequenceFor('cart-1', second.operationId)).toBe(2);
    expect(node.commitTimeFor('cart-1', first.operationId)).toBe(5_000 + 2_000);
    expect(node.commitTimeFor('cart-1', second.operationId)).toBe(9_000 + 2_000);
  });

  it('keeps token and scan byte formulas exact', () => {
    const token = cartSessionToken('cart-1', ['b', 'a', 'a']);
    expect(token.ids).toEqual(['a', 'b']);
    expect(cartSessionTokenBytes(token)).toBe(64);
    expect(cartAckBytes(token)).toBe(192);
    expect(mergeCartSessionTokens(token, cartSessionToken('cart-1', ['c'])).ids).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(() => mergeCartSessionTokens(token, cartSessionToken('cart-2', []))).toThrow();
    expect(cartJournalScanIoUnits(0)).toBe(1);
    expect(cartJournalScanIoUnits(16)).toBe(1);
    expect(cartJournalScanIoUnits(17)).toBe(2);
    expect(cartEditEnvelopeBytes(new Array(3).fill(cartOperationId(key(1))))).toBe(512 + 96);
  });
});

describe('protocol caps', () => {
  it('rejects a context larger than the 400-id cap before mutation', () => {
    const node = journal();
    const context = Array.from({ length: 401 }, (_, index) => `ctx-${index}`);
    const rejected = expectRejected(node.commitEdit(edit('cart-1', 1, 'add', 'sku-1', 1, context)));
    expect(rejected.reason).toBe('context-too-large');
    expect(node.snapshot().committedOperations).toBe(0);
  });

  it('stops at 400 committed operations per cart with an explicit nonpassing outcome', () => {
    const node = journal();
    for (let sequence = 1; sequence <= 400; sequence += 1) {
      expectAccepted(node.commitEdit(edit('cart-1', sequence, 'add')));
    }
    const rejected = expectRejected(node.commitEdit(edit('cart-1', 401, 'add')));
    expect(rejected.reason).toBe('cart-operation-cap');
    expect(node.snapshot().committedOperations).toBe(400);
  });

  it('rejects malformed envelopes without charging durable storage', () => {
    const node = journal();
    const malformed = edit('cart-1', 1, 'add', 'sku-1', 99);
    const rejected = expectRejected(node.commitEdit(malformed));
    expect(rejected.reason).toBe('invalid-operation');
    expect(node.snapshot().committedOperations).toBe(0);
    expect(node.snapshot().durableCommittedBytes).toBe(0);
  });
});
