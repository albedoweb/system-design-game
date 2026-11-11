/**
 * GC-008 — at-least-once batched replication (`cart-protocol-v1` §6, B2).
 *
 * Durable journals and cart stores pull pending outbox obligations every 100 ms
 * in fixed batches of at most 64 operations or 32 KiB (whichever comes first),
 * and a full batch is sent immediately rather than waiting for the poll tick.
 * A failed batch retries after 1000 ms with the same operation ids: the
 * obligation stays durable until a durable delivery ACK confirms it. Bytes are
 * charged per attempt, so duplicates and lost ACKs cost real bandwidth while
 * never producing a second effect — the receiver's original retry binding is
 * the only authority that can decide an envelope.
 *
 * Replication cycles are bounded: a replicated envelope creates at most one
 * forwarding obligation per outgoing edge (excluding the edge it arrived on),
 * and an operation id already known to the receiver creates none. A cycle
 * therefore consumes one delivery per configured edge and stops; already known
 * operation ids are reported as duplicates without re-materialization.
 *
 * The engine is deterministic. It never reads a wall clock: callers advance an
 * integer-microsecond clock. Transport behaviour is injected so the session
 * model can wire the physical `CartNetworkModel`; tests use scripted loss,
 * duplication and partitions.
 */
import { CART_ACK_BASE_BYTES, CART_TOKEN_ID_BYTES, type CartReplicationId, type CartDurableStore } from './durable-store';

/** Asynchronous replication poll interval. */
export const CART_REPLICATION_POLL_US = 100_000;
/** Failed-batch retry interval; the same operation ids are retried. */
export const CART_REPLICATION_RETRY_US = 1_000_000;
/** Batch caps: operations and bytes, whichever is reached first. */
export const CART_REPLICATION_MAX_BATCH_OPS = 64;
export const CART_REPLICATION_MAX_BATCH_BYTES = 32 * 1024;
/** A delta batch adds 128 B per message; one batch is one message. */
export const CART_REPLICATION_BATCH_OVERHEAD_BYTES = 128;

export interface CartReplicationLimits {
  readonly maxOperations?: number;
  readonly maxBytes?: number;
}

export interface CartReplicationBatch {
  readonly ids: readonly CartReplicationId[];
  /** Complete encoded envelopes plus the batch message overhead. */
  readonly bytes: number;
  /**
   * True when a single bounded envelope alone exceeds the batch byte cap; §6
   * allows an oversized single operation to travel in its own bounded envelope.
   */
  readonly oversizedSingle: boolean;
}

/** One batch message: 128 B plus every complete edit envelope it carries. */
export function cartReplicationBatchBytes(envelopeBytes: readonly number[]): number {
  for (const bytes of envelopeBytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError('replication envelope bytes must be finite and non-negative');
    }
  }
  return (
    CART_REPLICATION_BATCH_OVERHEAD_BYTES +
    envelopeBytes.reduce((total, bytes) => total + bytes, 0)
  );
}

/**
 * Deterministic batch selection in outbox (commit) order. Never fragments an
 * envelope; never exceeds the operation or byte cap unless a single bounded
 * envelope cannot fit, which travels alone.
 */
export function selectReplicationBatch(
  ids: readonly CartReplicationId[],
  envelopeBytesOf: (id: CartReplicationId) => number | null,
  limits: CartReplicationLimits = {},
): CartReplicationBatch {
  const maxOperations = limits.maxOperations ?? CART_REPLICATION_MAX_BATCH_OPS;
  const maxBytes = limits.maxBytes ?? CART_REPLICATION_MAX_BATCH_BYTES;
  if (!Number.isInteger(maxOperations) || maxOperations < 1) {
    throw new RangeError('maxOperations must be a positive integer');
  }
  if (!Number.isFinite(maxBytes) || maxBytes < 1) {
    throw new RangeError('maxBytes must be positive');
  }

  const selected: CartReplicationId[] = [];
  const sizes: number[] = [];
  let oversizedSingle = false;
  for (const id of ids) {
    const size = envelopeBytesOf(id);
    if (size === null || !Number.isFinite(size) || size < 0) {
      continue;
    }
    if (selected.length === 0) {
      selected.push(id);
      sizes.push(size);
      oversizedSingle = cartReplicationBatchBytes([size]) > maxBytes;
      if (oversizedSingle) {
        break;
      }
      continue;
    }
    if (selected.length + 1 > maxOperations) break;
    if (cartReplicationBatchBytes([...sizes, size]) > maxBytes) break;
    selected.push(id);
    sizes.push(size);
  }
  return {
    ids: selected,
    bytes: cartReplicationBatchBytes(sizes),
    oversizedSingle,
  };
}

// ---------------------------------------------------------------------------
// Topology, transport and engine
// ---------------------------------------------------------------------------

export interface CartReplicationEdge {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
}

export interface CartReplicationDelivery {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
  readonly ids: readonly CartReplicationId[];
  readonly bytes: number;
  readonly attempt: number;
  readonly scheduledAtUs: number;
}

/**
 * Scripted transport result. `delivered` says whether the logical envelope
 * reached the target's durable handler; `ackReceived` says whether the sender
 * learned the durable ingest acknowledgement. A delivered batch without an ACK
 * is retried and duplicates real work/bytes but never a cart effect.
 */
export interface CartReplicationTransportOutcome {
  readonly delivered: boolean;
  readonly ackReceived: boolean;
}

export type CartReplicationTransport = (
  delivery: CartReplicationDelivery,
) => CartReplicationTransportOutcome;

export interface CartReplicationEngineOptions {
  readonly edges: readonly CartReplicationEdge[];
  readonly transport?: CartReplicationTransport;
  /** Completion-driven physical adapter. One batch remains in flight per edge. */
  readonly dispatch?: (delivery: CartReplicationDelivery) => void;
  readonly pollIntervalUs?: number;
  readonly retryIntervalUs?: number;
  readonly limits?: CartReplicationLimits;
}

export interface CartReplicationDeliveryResult {
  readonly delivery: CartReplicationDelivery;
  readonly delivered: boolean;
  readonly ackReceived: boolean;
  readonly confirmed: number;
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly cpuMilliseconds: number;
  readonly ioUnits: number;
}

export interface CartReplicationCounters {
  readonly attempts: number;
  readonly deliveredBatches: number;
  readonly ackedBatches: number;
  readonly failedBatches: number;
  readonly bitableBytes: number;
  readonly operationsDelivered: number;
  readonly duplicateOperations: number;
  readonly rejectedOperations: number;
  readonly confirmedObligations: number;
  readonly cpuMilliseconds: number;
  readonly ioUnits: number;
}

const DEFAULT_TRANSPORT: CartReplicationTransport = () => ({
  delivered: true,
  ackReceived: true,
});

/**
 * Drives outbox obligations between registered durable nodes. Polls are 100 ms
 * apart; a batch that reaches a cap is sent immediately via
 * `scheduleImmediate(sourceNodeId)` and does not wait for the poll.
 */
export class CartReplicationEngine {
  private readonly edges: readonly CartReplicationEdge[];
  private readonly transport: CartReplicationTransport;
  private readonly pollIntervalUs: number;
  private readonly retryIntervalUs: number;
  private readonly limits: CartReplicationLimits;
  private readonly nodes = new Map<string, CartDurableStore>();
  private readonly nextAttemptUs = new Map<string, number>();
  private readonly attemptsByEdge = new Map<string, number>();
  private readonly retryIds = new Map<string, readonly CartReplicationId[]>();
  private nowUs = 0;
  private readonly dispatch?: (delivery: CartReplicationDelivery) => void;
  private readonly inFlight = new Map<string, { delivery: CartReplicationDelivery; ackedIds: CartReplicationId[]; received: boolean }>();

  private attempts = 0;
  private deliveredBatches = 0;
  private ackedBatches = 0;
  private failedBatches = 0;
  private bitableBytes = 0;
  private operationsDelivered = 0;
  private duplicateOperations = 0;
  private rejectedOperations = 0;
  private confirmedObligations = 0;
  private cpuMilliseconds = 0;
  private ioUnits = 0;

  constructor(options: CartReplicationEngineOptions) {
    this.edges = [...options.edges];
    this.dispatch = options.dispatch;
    this.transport = options.transport ?? DEFAULT_TRANSPORT;
    this.pollIntervalUs = options.pollIntervalUs ?? CART_REPLICATION_POLL_US;
    this.retryIntervalUs = options.retryIntervalUs ?? CART_REPLICATION_RETRY_US;
    this.limits = options.limits ?? {};
    if (this.pollIntervalUs <= 0 || this.retryIntervalUs <= 0) {
      throw new RangeError('replication intervals must be positive');
    }
    for (const edge of this.edges) {
      if (edge.from === edge.to) {
        throw new RangeError(`replication edge ${edge.edgeId} targets its own source`);
      }
      this.nextAttemptUs.set(edge.edgeId, Number.POSITIVE_INFINITY);
    }
  }

  get currentTimeUs(): number {
    return this.nowUs;
  }

  registerNode(store: CartDurableStore): void {
    this.nodes.set(store.nodeId, store);
  }

  node(nodeId: string): CartDurableStore | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * A full batch (or any fresh commit) is sent immediately: move the next
   * attempt of every outgoing edge of the source to the current time.
   */
  scheduleImmediate(sourceNodeId: string, atUs = this.nowUs): void {
    for (const edge of this.edges) {
      if (edge.from === sourceNodeId && !this.retryIds.has(edge.edgeId)) {
        this.nextAttemptUs.set(edge.edgeId, Math.min(this.nextAttemptUs.get(edge.edgeId) ?? 0, atUs));
      }
    }
  }

  /**
   * Record a commit so polling starts at the next 100 ms tick at or after it,
   * never at an earlier tick that happened before the obligation existed.
   */
  notifyCommit(sourceNodeId: string, atUs = this.nowUs): void {
    const tick = Math.ceil(atUs / this.pollIntervalUs) * this.pollIntervalUs;
    for (const edge of this.edges) {
      if (edge.from === sourceNodeId && !this.retryIds.has(edge.edgeId)) {
        const source = this.nodes.get(sourceNodeId);
        const pending = source?.pendingForEdge(edge.edgeId) ?? [];
        const batch = selectReplicationBatch(pending, id => source!.envelopeBytes(id), this.limits);
        const full = pending.length > batch.ids.length || batch.ids.length >= (this.limits.maxOperations ?? CART_REPLICATION_MAX_BATCH_OPS) || batch.bytes >= (this.limits.maxBytes ?? CART_REPLICATION_MAX_BATCH_BYTES);
        this.nextAttemptUs.set(
          edge.edgeId,
          Math.min(this.nextAttemptUs.get(edge.edgeId) ?? Number.POSITIVE_INFINITY, full ? atUs : tick),
        );
      }
    }
  }

  /** Earliest work that can start; in-flight edges wait for physical settlement. */
  get nextAttemptAtUs(): number | null {
    let next = Infinity;
    for (const edge of this.edges) {
      if (this.inFlight.has(edge.edgeId) || !this.nodes.get(edge.from)?.pendingForEdge(edge.edgeId).length) continue;
      const due = this.nextAttemptUs.get(edge.edgeId) ?? Infinity;
      next = Math.min(next, Number.isFinite(due) ? due : this.nowUs);
    }
    return Number.isFinite(next) ? next : null;
  }

  /**
   * Run every poll/retry attempt due at or before `atUs` in deterministic edge
   * order and return the attempts performed. One batch per attempt; a delivered
   * and acknowledged batch waits for the next 100 ms poll, while a failed batch
   * waits 1000 ms and retries the same operation ids.
   */
  advanceTo(atUs: number): CartReplicationDeliveryResult[] {
    if (!Number.isFinite(atUs) || atUs < this.nowUs) {
      throw new RangeError(`cannot advance replication from ${this.nowUs}us to ${String(atUs)}us`);
    }
    this.nowUs = atUs;
    const results: CartReplicationDeliveryResult[] = [];
    for (const edge of [...this.edges].sort((left, right) =>
      left.edgeId < right.edgeId ? -1 : left.edgeId > right.edgeId ? 1 : 0,
    )) {
      if (this.inFlight.has(edge.edgeId)) continue;
      const source = this.nodes.get(edge.from);
      if (source === undefined) continue;
      let scheduled = this.nextAttemptUs.get(edge.edgeId) ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(scheduled)) {
        // The first poll of a freshly created engine is due at its first
        // advance; later commits use `notifyCommit`.
        scheduled = atUs;
      }
      let guard = 0;
      while (scheduled <= atUs) {
        guard += 1;
        if (guard > 10_000) {
          throw new Error(`replication edge ${edge.edgeId} exceeded its bounded attempt loop`);
        }
        const pending = source.pendingForEdge(edge.edgeId);
        if (pending.length === 0) {
          scheduled = atUs + this.pollIntervalUs;
          break;
        }
        const retry = this.retryIds.get(edge.edgeId);
        const result = this.attempt(edge, source, retry ?? pending, scheduled);
        results.push(result);
        if (this.inFlight.has(edge.edgeId)) {
          scheduled = Number.POSITIVE_INFINITY;
          break;
        }
        if (result.delivered && result.ackReceived && result.rejected === 0) {
          this.retryIds.delete(edge.edgeId);
          scheduled = scheduled + this.pollIntervalUs;
        } else {
          const remaining = source.pendingForEdge(edge.edgeId);
          this.retryIds.set(edge.edgeId, result.delivery.ids.filter(id => remaining.some(p => p.cartId === id.cartId && p.operationId === id.operationId)));
          scheduled = scheduled + this.retryIntervalUs;
        }
      }
      this.nextAttemptUs.set(edge.edgeId, scheduled);
    }
    return results;
  }

  /** Attempt one batch for an edge at a scheduled time. */
  private attempt(
    edge: CartReplicationEdge,
    source: CartDurableStore,
    pending: readonly CartReplicationId[],
    scheduledAtUs: number,
  ): CartReplicationDeliveryResult {
    const batch = selectReplicationBatch(
      pending,
      (id) => source.envelopeBytes(id),
      this.limits,
    );
    if (batch.ids.length === 0) {
      return {
        delivery: {
          edgeId: edge.edgeId,
          from: edge.from,
          to: edge.to,
          ids: [],
          bytes: 0,
          attempt: 0,
          scheduledAtUs,
        },
        delivered: false,
        ackReceived: false,
        confirmed: 0,
        accepted: 0,
        duplicates: 0,
        rejected: 0,
        cpuMilliseconds: 0,
        ioUnits: 0,
      };
    }

    const attempt = (this.attemptsByEdge.get(edge.edgeId) ?? 0) + 1;
    this.attemptsByEdge.set(edge.edgeId, attempt);
    this.attempts += 1;
    this.bitableBytes += batch.bytes;

    const delivery: CartReplicationDelivery = {
      edgeId: edge.edgeId,
      from: edge.from,
      to: edge.to,
      ids: batch.ids,
      bytes: batch.bytes,
      attempt,
      scheduledAtUs,
    };
    if (this.dispatch !== undefined) {
      this.inFlight.set(edge.edgeId, { delivery, ackedIds: [], received: false });
      this.dispatch(delivery);
      return { delivery, delivered: false, ackReceived: false, confirmed: 0,
        accepted: 0, duplicates: 0, rejected: 0, cpuMilliseconds: 0, ioUnits: 0 };
    }
    return this.applyDelivery(delivery, this.transport(delivery), scheduledAtUs);
  }

  /** Apply only after physical arrival and durable target service complete. */
  receiveDelivery(delivery: CartReplicationDelivery, atUs: number): CartReplicationDeliveryResult {
    const active = this.inFlight.get(delivery.edgeId);
    if (active?.delivery !== delivery || active.received) throw new Error('unknown replication delivery');
    active.received = true;
    return this.applyDelivery(delivery, { delivered: true, ackReceived: false }, atUs, active.ackedIds, true, true);
  }

  /** Resumable per-envelope service within one physical batch. */
  receiveOperation(delivery: CartReplicationDelivery, id: CartReplicationId, atUs: number): CartReplicationDeliveryResult {
    const active = this.inFlight.get(delivery.edgeId);
    if (active?.delivery !== delivery || !delivery.ids.includes(id) || active.ackedIds.includes(id)) {
      throw new Error('unknown replication operation');
    }
    const first = !active.received;
    active.received = true;
    return this.applyDelivery({...delivery, ids: [id]}, {delivered: true, ackReceived: false},
      atUs, active.ackedIds, first, true);
  }

  acknowledgementBytes(delivery: CartReplicationDelivery): number {
    const active = this.inFlight.get(delivery.edgeId);
    if (active?.delivery !== delivery) throw new Error('unknown replication delivery');
    return CART_ACK_BASE_BYTES + CART_TOKEN_ID_BYTES * active.ackedIds.length;
  }

  /** Only a physically received ACK retires obligations; loss keeps the exact IDs. */
  settleDelivery(delivery: CartReplicationDelivery, ackReceived: boolean, atUs: number): void {
    const active = this.inFlight.get(delivery.edgeId);
    if (active?.delivery !== delivery) throw new Error('unknown replication ACK');
    if (ackReceived && active.received && active.ackedIds.length > 0) {
      this.confirmedObligations += this.nodes.get(delivery.from)!.confirmDelivery(delivery.edgeId, active.ackedIds);
      this.ackedBatches += 1;
    } else this.failedBatches += 1;
    this.inFlight.delete(delivery.edgeId);
    const complete = ackReceived && active.ackedIds.length === delivery.ids.length;
    if (complete) this.retryIds.delete(delivery.edgeId);
    else this.retryIds.set(delivery.edgeId, ackReceived
      ? delivery.ids.filter(id => !active.ackedIds.includes(id)) : delivery.ids);
    this.nextAttemptUs.set(delivery.edgeId, atUs + (complete ? this.pollIntervalUs : this.retryIntervalUs));
  }

  private applyDelivery(
    delivery: CartReplicationDelivery,
    outcome: CartReplicationTransportOutcome,
    atUs: number,
    retainedAckIds?: CartReplicationId[],
    countBatch = true,
    flushCompleted = false,
  ): CartReplicationDeliveryResult {
    const source = this.nodes.get(delivery.from)!;
    const edge = { edgeId: delivery.edgeId, from: delivery.from, to: delivery.to };
    const batch = delivery;

    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    let confirmed = 0;
    let cpuMilliseconds = 0;
    let ioUnits = 0;
    const ackedIds: CartReplicationId[] = retainedAckIds ?? [];

    if (outcome.delivered) {
      if (countBatch) this.deliveredBatches += 1;
      this.operationsDelivered += batch.ids.length;
      const target = this.nodes.get(edge.to);
      if (target !== undefined) {
        for (const id of batch.ids) {
          const envelope = source.envelopeFor(id);
          if (envelope === undefined) continue;
          const ingested = target.ingestReplica(envelope, {
            arrivalEdgeId: edge.edgeId,
            atUs,
            flushCompleted,
          });
          if (ingested.ok) {
            if (ingested.ack.status === 'accepted') {
              accepted += 1;
              ackedIds.push(id);
            } else {
              duplicates += 1;
              this.duplicateOperations += 1;
              // A duplicate is already durable at the target: the delivery ack
              // may remove the sender's obligation.
              ackedIds.push(id);
            }
            cpuMilliseconds += ingested.ack.charge.cpuMilliseconds;
            ioUnits += ingested.ack.charge.ioUnits;
          } else {
            rejected += 1;
            this.rejectedOperations += 1;
            cpuMilliseconds += ingested.charge.cpuMilliseconds;
            ioUnits += ingested.charge.ioUnits;
          }
        }
      } else {
        rejected += batch.ids.length;
        this.rejectedOperations += batch.ids.length;
      }
      if (outcome.ackReceived && ackedIds.length > 0) {
        confirmed = source.confirmDelivery(edge.edgeId, ackedIds);
        this.confirmedObligations += confirmed;
        this.ackedBatches += 1;
      } else if (!outcome.ackReceived && retainedAckIds === undefined) {
        this.failedBatches += 1;
      }
    } else {
      this.failedBatches += 1;
    }

    this.cpuMilliseconds += cpuMilliseconds;
    this.ioUnits += ioUnits;
    return {
      delivery,
      delivered: outcome.delivered,
      ackReceived: outcome.ackReceived,
      confirmed,
      accepted,
      duplicates,
      rejected,
      cpuMilliseconds,
      ioUnits,
    };
  }

  get counters(): CartReplicationCounters {
    return {
      attempts: this.attempts,
      deliveredBatches: this.deliveredBatches,
      ackedBatches: this.ackedBatches,
      failedBatches: this.failedBatches,
      bitableBytes: this.bitableBytes,
      operationsDelivered: this.operationsDelivered,
      duplicateOperations: this.duplicateOperations,
      rejectedOperations: this.rejectedOperations,
      confirmedObligations: this.confirmedObligations,
      cpuMilliseconds: this.cpuMilliseconds,
      ioUnits: this.ioUnits,
    };
  }

  /** Total obligations still pending across every registered source. */
  get pendingObligations(): number {
    let total = 0;
    for (const store of this.nodes.values()) {
      total += store.pendingDeliveryCount;
    }
    return total;
  }
}
