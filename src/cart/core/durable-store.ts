/**
 * GC-008 — durable ingestion, retry identity, atomic commit and outbox
 * (`cart-protocol-v1` §§3/6/7, B2).
 *
 * A `CartDurableStore` models one durable journal or cart store node. It is the
 * only place where an edit becomes durable, and it enforces the ordering the
 * profile promises to players:
 *
 * - **No ACK before durability.** `commitEdit` returns an acknowledgement only
 *   after the operation envelope, the retry binding/result and every required
 *   outbox obligation are committed together. Rejections return no token, no
 *   operation and no obligation; already committed records are never revoked.
 * - **One effect per origin key.** The authoritative node for a key atomically
 *   records the first accepted payload fingerprint. A replay of the identical
 *   payload/context returns the original acceptance and token and performs no
 *   second effect; a different payload is `idempotency-conflict` with no
 *   mutation. A retry arriving at another region is routed back to the key's
 *   original authority, or reported unavailable when that authority cannot be
 *   reached.
 * - **Finite storage.** Logs, dedup/result metadata, commit sequence/time,
 *   materialized units and tombstones, and pending delivery obligations all
 *   consume declared durable bytes. A commit that cannot reserve all of them is
 *   rejected before mutation; a later shortage never erases an acknowledged
 *   write. The cart store's in-memory working set is charged at twice the
 *   encoded unit/tombstone bytes; the journal keeps no materialized index.
 * - **Charged work.** Append/ingest/read/dedup work follows DEVELOPER §7; the
 *   journal read cost scans retained operations and pays one IO per 16 scanned
 *   operations (minimum one).
 *
 * The module is deterministic: no wall clock, randomness or DOM. Retry routing
 * and replication polling live in `./replication`.
 */
import type { CartRegion, CartServiceSize } from '../contracts';
import {
  CART_COMPONENT_TABLE,
  CART_DURABLE_FLUSH_US,
  CART_PENDING_LIMIT,
  type CartServiceKind,
} from './resources';
import {
  cartOperationFingerprint,
  cartOperationId,
  expandCartOperation,
  validateCartOperationEffect,
  validateCartOperationEnvelope,
  type CartEffect,
  type CartOperationEnvelope,
} from './operations';
import {
  acceptCartOperation,
  cartViewQuantity,
  createCartOperationLog,
  materializeCartView,
  type CartMaterializationWork,
  type CartMaterializedView,
  type CartOperationLog,
} from './cart-state';

// ---------------------------------------------------------------------------
// Protocol caps and byte formulas
// ---------------------------------------------------------------------------

/** Edit envelope: 512 B plus 32 B per observed-context id. */
export const CART_ENVELOPE_BASE_BYTES = 512;
export const CART_CONTEXT_ID_BYTES = 32;
/** Maximum accepted edit envelope; fragmentation is not allowed. */
export const CART_EDIT_ENVELOPE_MAX_BYTES = 16_384;
/** Durable payload of one edit plus dedup/result metadata. */
export const CART_DEDUP_RESULT_BYTES = 96;
/** B2: per-operation commit sequence/time metadata. */
export const CART_COMMIT_SEQUENCE_BYTES = 32;
/** One outgoing pending delivery obligation. */
export const CART_OUTBOX_OBLIGATION_BYTES = 64;
/** Encoded materialized unit / tombstone sizes. */
export const CART_ENCODED_UNIT_BYTES = 32;
export const CART_ENCODED_TOMBSTONE_BYTES = 24;
/** Simple ACK: 128 B plus 32 B per token id. */
export const CART_ACK_BASE_BYTES = 128;
export const CART_TOKEN_ID_BYTES = 32;

export const CART_SESSION_TOKEN_VERSION = 'cart-session-token-v1' as const;
export const CART_MAX_TOKEN_IDS = 400;
export const CART_MAX_CONTEXT_IDS = 400;
export const CART_MAX_CART_COMMITTED_OPS = 400;

/** Journal append, cart-store ingest, dedup hit and journal scan charges. */
export const CART_JOURNAL_APPEND_CPU_MS = 0.2;
export const CART_STORE_INGEST_BASE_CPU_MS = 0.5;
export const CART_STORE_INGEST_ITEM_CPU_MS = 0.01;
export const CART_JOURNAL_READ_CPU_MS = 0.15;
export const CART_JOURNAL_READ_PER_OP_CPU_MS = 0.05;
export const CART_STORE_READ_BASE_CPU_MS = 0.15;
export const CART_STORE_READ_ITEM_CPU_MS = 0.01;
export const CART_DEDUP_HIT_CPU_MS = 0.1;
/** Journal scan: one IO per 16 retained operations, minimum one. */
export const CART_JOURNAL_SCAN_OPS_PER_IO = 16;

export type CartDurableKind = 'journal' | 'store';

export function cartEditEnvelopeBytes(observedContext: readonly string[]): number {
  return CART_ENVELOPE_BASE_BYTES + CART_CONTEXT_ID_BYTES * observedContext.length;
}

/** Journal enumeration IO for a read or certificate: ceil(ops / 16), min 1. */
export function cartJournalScanIoUnits(retainedOperations: number): number {
  if (!Number.isInteger(retainedOperations) || retainedOperations < 0) {
    throw new RangeError('retained operation count must be a non-negative integer');
  }
  return Math.max(1, Math.ceil(retainedOperations / CART_JOURNAL_SCAN_OPS_PER_IO));
}

/** Work charged to a durable node for one attempt. */
export interface CartDurableCharge {
  readonly cpuMilliseconds: number;
  readonly ioUnits: number;
}

function charge(cpuMilliseconds: number, ioUnits: number): CartDurableCharge {
  return { cpuMilliseconds, ioUnits };
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

/** Exact-set session token (`cart-protocol-v1` §4): all bytes are charged. */
export interface CartSessionToken {
  readonly version: typeof CART_SESSION_TOKEN_VERSION;
  readonly cartId: string;
  readonly ids: readonly string[];
}

export function cartSessionToken(cartId: string, ids: Iterable<string>): CartSessionToken {
  return {
    version: CART_SESSION_TOKEN_VERSION,
    cartId,
    ids: [...new Set(ids)].sort(),
  };
}

/** Token bytes on the wire: base ACK plus 32 B per id. */
export function cartSessionTokenBytes(token: CartSessionToken): number {
  return CART_TOKEN_ID_BYTES * token.ids.length;
}

/** ACK message size: 128 B plus 32 B per token id. */
export function cartAckBytes(token: CartSessionToken): number {
  return CART_ACK_BASE_BYTES + cartSessionTokenBytes(token);
}

/** Union of two tokens for the same cart (never grants another device's set). */
export function mergeCartSessionTokens(
  left: CartSessionToken,
  right: CartSessionToken,
): CartSessionToken {
  if (left.cartId !== right.cartId) {
    throw new RangeError('session tokens belong to different carts');
  }
  return cartSessionToken(left.cartId, [...left.ids, ...right.ids]);
}

// ---------------------------------------------------------------------------
// Durable store state
// ---------------------------------------------------------------------------

/** Stable identity of a replicated operation: keys are cart-scoped. */
export interface CartReplicationId {
  readonly cartId: string;
  readonly operationId: string;
}

export function cartReplicationIdKey(id: CartReplicationId): string {
  return `${id.cartId.length}:${id.cartId}${id.operationId}`;
}

export interface CartOutgoingReplicationEdge {
  readonly edgeId: string;
  readonly to: string;
}

export interface CartDurableStoreOptions {
  readonly nodeId: string;
  readonly kind: CartDurableKind;
  /** Size drives the durable/RAM capacity from the frozen resource table. */
  readonly size: CartServiceSize;
  /** Region → node id of that region's configured immutable write authority. */
  readonly writeAuthorities: Readonly<Partial<Record<CartRegion, string>>>;
  /** Outgoing replication destinations with their stable edge ids. */
  readonly replicationEdges?: readonly CartOutgoingReplicationEdge[];
  /**
   * Durable nodes a retry may be routed to. Defaults to every configured write
   * authority plus this node. A retry whose origin authority is absent from this
   * set is reported unavailable instead of being silently re-homed.
   */
  readonly reachableNodeIds?: readonly string[];
  /** Overrides the table capacity for focused capacity tests. */
  readonly durableCapacityBytes?: number;
  /** Overrides the table working RAM for focused capacity tests. */
  readonly workingRamBytes?: number;
  /**
   * Observation point invoked after every durable write and before the ACK is
   * constructed. Tests use it to prove no ACK can precede durable state.
   */
  readonly onDurableCommit?: (checkpoint: CartDurableCheckpoint) => void;
}

export interface CartDurableCheckpoint {
  readonly nodeId: string;
  readonly kind: CartDurableKind;
  readonly cartId: string;
  readonly operationId: string;
  readonly fingerprint: string;
  readonly tokenIds: readonly string[];
  readonly outboxEdgeIds: readonly string[];
  readonly durableBytes: number;
  readonly commitSequence: number;
  readonly atUs: number;
}

interface CartDurableCartState {
  log: CartOperationLog;
  view: CartMaterializedView | null;
  /** Original acceptance token per operation id (retry reply). */
  readonly ackTokens: Map<string, CartSessionToken>;
  readonly commitSequences: Map<string, number>;
  readonly commitTimesUs: Map<string, number>;
  /** Bytes currently charged for this cart's unique materialized set. */
  materializedBytes: number;
}

export type CartDurableRejection =
  | 'idempotency-conflict'
  | 'route-to-authority'
  | 'unavailable'
  | 'invalid-operation'
  | 'context-too-large'
  | 'envelope-too-large'
  | 'cart-operation-cap'
  | 'dependency-unavailable'
  | 'effect-mismatch'
  | 'durable-capacity'
  | 'working-ram'
  | 'unknown-cart';

export interface CartDurableFailure {
  readonly ok: false;
  readonly reason: CartDurableRejection;
  readonly message: string;
  /** For `route-to-authority`: the original authority of the edit key. */
  readonly authorityNodeId?: string;
  readonly charge: CartDurableCharge;
}

export interface CartAck {
  readonly operationId: string;
  readonly cartId: string;
  /** `accepted` for the first durable commit, `duplicate` for a replay. */
  readonly status: 'accepted' | 'duplicate';
  readonly token: CartSessionToken;
  /** Bytes on the wire for this ACK. */
  readonly bytes: number;
  readonly envelope: CartOperationEnvelope;
  readonly charge: CartDurableCharge;
}

export type CartCommitResult =
  | { readonly ok: true; readonly ack: CartAck }
  | CartDurableFailure;

/** Outcome of a replica delivery: a durable-ingest acknowledgement. */
export interface CartReplicaAck {
  readonly cartId: string;
  readonly operationId: string;
  readonly status: 'accepted' | 'duplicate';
  readonly token: CartSessionToken;
  readonly outboxEdgeIds: readonly string[];
  readonly charge: CartDurableCharge;
}

export type CartReplicaIngestResult =
  | { readonly ok: true; readonly ack: CartReplicaAck }
  | CartDurableFailure;

export interface CartDurableRead {
  readonly ok: true;
  readonly cartId: string;
  readonly view: CartMaterializedView;
  readonly token: CartSessionToken;
  readonly complete: boolean;
  readonly charge: CartDurableCharge;
  readonly materialization: CartMaterializationWork | null;
}

export type CartDurableReadResult = CartDurableRead | CartDurableFailure;

export interface CartDurableSnapshot {
  readonly nodeId: string;
  readonly kind: CartDurableKind;
  readonly carts: number;
  readonly committedOperations: number;
  readonly duplicateAttempts: number;
  readonly conflictAttempts: number;
  readonly rejectedCommits: number;
  readonly ackCount: number;
  readonly cpuMilliseconds: number;
  readonly ioUnits: number;
  readonly durableCapacityBytes: number;
  readonly durableReservedBytes: number;
  readonly durableCommittedBytes: number;
  readonly durableFreeBytes: number;
  readonly materializedDurableBytes: number;
  readonly materializedRamBytes: number;
  readonly workingRamBytes: number;
  readonly pendingDeliveries: number;
  readonly pendingDeliveryBytes: number;
  readonly bufferedOperations: number;
}

function rejection(
  reason: CartDurableRejection,
  message: string,
  durableCharge: CartDurableCharge,
  authorityNodeId?: string,
): CartDurableFailure {
  return authorityNodeId === undefined
    ? { ok: false, reason, message, charge: durableCharge }
    : { ok: false, reason, message, authorityNodeId, charge: durableCharge };
}

function tableCapacity(kind: CartDurableKind, size: CartServiceSize): {
  durableBytes: number;
  workingRamBytes: number;
  ioPerSecond: number;
} {
  const spec = CART_COMPONENT_TABLE[kind as CartServiceKind][size];
  return {
    durableBytes: spec.durableBytes,
    workingRamBytes: spec.ramBytes - spec.fixedRamBytes,
    ioPerSecond: spec.ioPerSecond ?? CART_PENDING_LIMIT.otherNode,
  };
}

/** One durable journal or cart store node. */
export class CartDurableStore {
  readonly nodeId: string;
  readonly kind: CartDurableKind;
  private readonly writeAuthorities: Readonly<Partial<Record<CartRegion, string>>>;
  private readonly replicationEdges: readonly CartOutgoingReplicationEdge[];
  private readonly reachable: ReadonlySet<string>;
  private readonly capacityBytes: number;
  private readonly workingRamLimitBytes: number;
  private readonly onDurableCommit:
    | ((checkpoint: CartDurableCheckpoint) => void)
    | undefined;

  private readonly carts = new Map<string, CartDurableCartState>();
  /** Pending obligations per outgoing edge, in commit order. */
  private readonly outbox = new Map<string, CartReplicationId[]>();
  private readonly outboxKeys = new Set<string>();

  private durableCommittedBytes = 0;
  private durableReservedBytes = 0;
  private materializedDurableBytes = 0;
  private nextCommitSequence = 1;
  private nowUs = 0;

  private duplicateAttempts = 0;
  private conflictAttempts = 0;
  private rejectedCommits = 0;
  private ackCount = 0;
  private cpuMilliseconds = 0;
  private ioUnits = 0;

  constructor(options: CartDurableStoreOptions) {
    if (options.nodeId.length === 0) {
      throw new TypeError('durable store nodeId must be non-empty');
    }
    this.nodeId = options.nodeId;
    this.kind = options.kind;
    this.writeAuthorities = options.writeAuthorities;
    this.replicationEdges = [...(options.replicationEdges ?? [])];
    const authorities = Object.values(options.writeAuthorities).filter(
      (value): value is string => typeof value === 'string',
    );
    this.reachable = new Set<string>(
      options.reachableNodeIds ?? [...authorities, options.nodeId],
    );
    const table = tableCapacity(options.kind, options.size);
    this.capacityBytes = options.durableCapacityBytes ?? table.durableBytes;
    this.workingRamLimitBytes =
      options.workingRamBytes ??
      (options.kind === 'store' ? table.workingRamBytes : 0);
    this.onDurableCommit = options.onDurableCommit;
    for (const edge of this.replicationEdges) {
      this.outbox.set(edge.edgeId, []);
    }
  }

  get currentTimeUs(): number {
    return this.nowUs;
  }

  setTimeUs(us: number): void {
    if (!Number.isFinite(us) || us < this.nowUs) {
      throw new RangeError(`cannot move durable time backwards from ${this.nowUs}us`);
    }
    this.nowUs = us;
  }

  /** Original write authority for an edit key's origin region. */
  authorityFor(region: CartRegion): string | undefined {
    return this.writeAuthorities[region];
  }

  get outgoingEdges(): readonly CartOutgoingReplicationEdge[] {
    return this.replicationEdges;
  }

  get cartIds(): readonly string[] {
    return [...this.carts.keys()].sort();
  }

  hasCart(cartId: string): boolean {
    return this.carts.has(cartId);
  }

  // -------------------------------------------------------------------------
  // Client edit path
  // -------------------------------------------------------------------------

  /**
   * Durably commit one client edit at its origin authority and return the ACK.
   *
   * Rejections never mutate durable state and never return a token. A
   * successful result is constructed only after the envelope, fingerprint
   * binding, commit sequence/time and all outbox obligations are durable.
   * `flushCompleted` is the scheduler adapter seam: true means atUs is the
   * already executed flush completion, not a second synthetic flush start.
   */
  commitEdit(envelope: CartOperationEnvelope, atUs = this.nowUs, flushCompleted = false): CartCommitResult {
    this.setTimeUs(atUs);

    const authority = this.writeAuthorities[envelope.key.originRegion];
    if (authority === undefined) {
      return this.fail(
        'unavailable',
        `no durable write authority is configured for ${envelope.key.originRegion}`,
        charge(0, 0),
      );
    }
    if (authority !== this.nodeId) {
      if (this.reachable.has(authority)) {
        return this.fail(
          'route-to-authority',
          `edit key ${cartOperationId(envelope.key)} is owned by ${authority}; retry must route there`,
          charge(0, 0),
          authority,
        );
      }
      return this.fail(
        'unavailable',
        `origin authority ${authority} for ${cartOperationId(envelope.key)} is unreachable`,
        charge(0, 0),
        authority,
      );
    }

    return this.applyEnvelope(envelope, {
      mode: 'client',
      flushCompleted,
      declaredEffect: undefined,
      arrivalEdgeId: undefined,
      atUs,
    });
  }

  /**
   * Adapter demand preview only: no mutation, ACK or capacity admission. The
   * scheduler calls commitEdit(..., completedUs, true) after CPU/IO/flush;
   * commit revalidates atomically against all writes completed in the meantime.
   */
  editCharge(envelope: CartOperationEnvelope): CartDurableCharge {
    const log = this.carts.get(envelope.cartId)?.log;
    if (log?.bindings.has(cartOperationId(envelope.key))) return charge(CART_DEDUP_HIT_CPU_MS, 1);
    if (this.kind === 'journal') return charge(CART_JOURNAL_APPEND_CPU_MS, 1);
    const expansion = expandCartOperation(envelope, log?.envelopes ?? new Map());
    const items = expansion.status === 'expanded'
      ? expansion.effect.adds.length + expansion.effect.tombstones.length : 0;
    return charge(CART_STORE_INGEST_BASE_CPU_MS + CART_STORE_INGEST_ITEM_CPU_MS * items, 1);
  }

  // -------------------------------------------------------------------------
  // Replica ingest path
  // -------------------------------------------------------------------------

  /**
   * Durably ingest a committed envelope delivered by replication. Delivery uses
   * the original binding: the same payload is a duplicate without a second
   * effect, and a conflicting payload is rejected before mutation. Known
   * operation ids create no new forwarding obligation, which bounds cycles.
   */
  ingestReplica(
    envelope: CartOperationEnvelope,
    options: {
      readonly arrivalEdgeId?: string;
      readonly declaredEffect?: CartEffect;
      readonly atUs?: number;
      /** Scheduler already completed the durable flush at atUs. */
      readonly flushCompleted?: boolean;
    } = {},
  ): CartReplicaIngestResult {
    const atUs = options.atUs ?? this.nowUs;
    this.setTimeUs(atUs);
    const result = this.applyEnvelope(envelope, {
      mode: 'replica',
      declaredEffect: options.declaredEffect,
      arrivalEdgeId: options.arrivalEdgeId,
      atUs,
      flushCompleted: options.flushCompleted,
    });
    if (!result.ok) {
      return result;
    }
    return {
      ok: true,
      ack: {
        cartId: result.ack.cartId,
        operationId: result.ack.operationId,
        status: result.ack.status,
        token: result.ack.token,
        outboxEdgeIds:
          result.ack.status === 'accepted'
            ? this.replicationEdges
                .filter((edge) => edge.edgeId !== options.arrivalEdgeId)
                .map((edge) => edge.edgeId)
            : [],
        charge: result.ack.charge,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Charged read: exact reducer view plus the cart's exact-set session token. */
  readCart(cartId: string): CartDurableReadResult {
    const state = this.carts.get(cartId);
    if (state === undefined) {
      const emptyLog = createCartOperationLog(cartId);
      const view = materializeCartView(emptyLog);
      const durableCharge =
        this.kind === 'journal'
          ? charge(CART_JOURNAL_READ_CPU_MS, cartJournalScanIoUnits(0))
          : charge(CART_STORE_READ_BASE_CPU_MS, 1);
      this.record(durableCharge);
      return {
        ok: true,
        cartId,
        view,
        token: cartSessionToken(cartId, []),
        complete: true,
        charge: durableCharge,
        materialization: null,
      };
    }

    const retained = state.log.envelopes.size;
    let durableCharge: CartDurableCharge;
    let view: CartMaterializedView;
    if (this.kind === 'journal') {
      durableCharge = charge(
        CART_JOURNAL_READ_CPU_MS + CART_JOURNAL_READ_PER_OP_CPU_MS * retained,
        cartJournalScanIoUnits(retained),
      );
      view = materializeCartView(state.log);
    } else {
      view = state.view ?? materializeCartView(state.log);
      const items = view.work.uniqueUnits + view.work.uniqueTombstones;
      durableCharge = charge(
        CART_STORE_READ_BASE_CPU_MS + CART_STORE_READ_ITEM_CPU_MS * items,
        1,
      );
    }
    this.record(durableCharge);
    return {
      ok: true,
      cartId,
      view,
      token: cartSessionToken(cartId, [...state.log.envelopes.keys()]),
      complete: view.complete,
      charge: durableCharge,
      materialization: view.work,
    };
  }

  /** Current exact-set token for a cart; the empty cart has an empty token. */
  tokenFor(cartId: string): CartSessionToken {
    const state = this.carts.get(cartId);
    return cartSessionToken(cartId, state === undefined ? [] : [...state.log.envelopes.keys()]);
  }

  quantity(cartId: string, sku: string): number {
    const state = this.carts.get(cartId);
    if (state === undefined) return 0;
    const view = state.view ?? materializeCartView(state.log);
    return cartViewQuantity(view, sku);
  }

  // -------------------------------------------------------------------------
  // Outbox
  // -------------------------------------------------------------------------

  pendingForEdge(edgeId: string): readonly CartReplicationId[] {
    return [...(this.outbox.get(edgeId) ?? [])];
  }

  get pendingDeliveryCount(): number {
    let total = 0;
    for (const ids of this.outbox.values()) total += ids.length;
    return total;
  }

  get allPendingDeliveries(): readonly (CartReplicationId & { readonly edgeId: string })[] {
    const result: (CartReplicationId & { readonly edgeId: string })[] = [];
    for (const edgeId of [...this.outbox.keys()].sort()) {
      for (const id of this.outbox.get(edgeId) ?? []) {
        result.push({ ...id, edgeId });
      }
    }
    return result;
  }

  /** Retained envelope for a replication id (bytes are recomputed, not cached). */
  envelopeFor(id: CartReplicationId): CartOperationEnvelope | undefined {
    return this.carts.get(id.cartId)?.log.envelopes.get(id.operationId);
  }

  /** Complete edit envelope bytes for a replication id. */
  envelopeBytes(id: CartReplicationId): number | null {
    const envelope = this.envelopeFor(id);
    return envelope === undefined ? null : cartEditEnvelopeBytes(envelope.observedContext);
  }

  /**
   * Acknowledge delivered obligations. Removes only confirmed outbox entries;
   * retained dedup records, envelopes and tombstones are never touched.
   */
  confirmDelivery(edgeId: string, ids: readonly CartReplicationId[]): number {
    const queue = this.outbox.get(edgeId);
    if (queue === undefined) return 0;
    const removals = new Set<string>();
    for (const id of ids) {
      const key = cartReplicationIdKey(id);
      if (this.outboxKeys.has(`${edgeId}\u0000${key}`)) {
        removals.add(key);
      }
    }
    if (removals.size === 0) return 0;
    const kept: CartReplicationId[] = [];
    let removed = 0;
    for (const id of queue) {
      if (removals.has(cartReplicationIdKey(id))) {
        removed += 1;
        this.outboxKeys.delete(`${edgeId}\u0000${cartReplicationIdKey(id)}`);
      } else {
        kept.push(id);
      }
    }
    this.outbox.set(edgeId, kept);
    this.durableCommittedBytes -= removed * CART_OUTBOX_OBLIGATION_BYTES;
    return removed;
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  snapshot(): CartDurableSnapshot {
    let committedOperations = 0;
    let bufferedOperations = 0;
    for (const state of this.carts.values()) {
      committedOperations += state.log.envelopes.size;
      bufferedOperations += state.view?.bufferedIds.length ?? state.log.envelopes.size;
    }
    const pending = this.pendingDeliveryCount;
    return {
      nodeId: this.nodeId,
      kind: this.kind,
      carts: this.carts.size,
      committedOperations,
      duplicateAttempts: this.duplicateAttempts,
      conflictAttempts: this.conflictAttempts,
      rejectedCommits: this.rejectedCommits,
      ackCount: this.ackCount,
      cpuMilliseconds: this.cpuMilliseconds,
      ioUnits: this.ioUnits,
      durableCapacityBytes: this.capacityBytes,
      durableReservedBytes: this.durableReservedBytes,
      durableCommittedBytes: this.durableCommittedBytes,
      durableFreeBytes: this.capacityBytes - this.durableReservedBytes - this.durableCommittedBytes,
      materializedDurableBytes: this.materializedDurableBytes,
      materializedRamBytes:
        this.kind === 'store' ? this.nodeMaterializedBytes() * 2 : 0,
      workingRamBytes: this.workingRamLimitBytes,
      pendingDeliveries: pending,
      pendingDeliveryBytes: pending * CART_OUTBOX_OBLIGATION_BYTES,
      bufferedOperations,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private fail(
    reason: CartDurableRejection,
    message: string,
    durableCharge: CartDurableCharge,
    authorityNodeId?: string,
  ): CartDurableFailure {
    this.rejectedCommits += 1;
    this.record(durableCharge);
    return rejection(reason, message, durableCharge, authorityNodeId);
  }

  private record(durableCharge: CartDurableCharge): void {
    this.cpuMilliseconds += durableCharge.cpuMilliseconds;
    this.ioUnits += durableCharge.ioUnits;
  }

  /**
   * Sum of every cart's current materialized unit/tombstone bytes. The store's
   * RAM budget covers the node's whole working set, so admission must consider
   * all carts together rather than one cart in isolation.
   */
  private nodeMaterializedBytes(): number {
    let total = 0;
    for (const cartState of this.carts.values()) {
      total += cartState.materializedBytes;
    }
    return total;
  }

  private applyEnvelope(
    envelope: CartOperationEnvelope,
    context: {
      readonly mode: 'client' | 'replica';
      readonly declaredEffect: CartEffect | undefined;
      readonly arrivalEdgeId: string | undefined;
      readonly atUs: number;
      readonly flushCompleted?: boolean;
    },
  ): CartCommitResult {
    // Structure first: nothing is charged to durable storage for malformed input.
    const structural = validateCartOperationEnvelope(envelope);
    if (structural.length > 0) {
      return this.fail(
        'invalid-operation',
        structural.map((issue) => `${issue.code}: ${issue.message}`).join('; '),
        charge(0, 0),
      );
    }
    if (envelope.observedContext.length > CART_MAX_CONTEXT_IDS) {
      return this.fail(
        'context-too-large',
        `observed context has ${envelope.observedContext.length} ids; the cap is ${CART_MAX_CONTEXT_IDS}`,
        charge(0, 0),
      );
    }
    const envelopeBytes = cartEditEnvelopeBytes(envelope.observedContext);
    if (envelopeBytes > CART_EDIT_ENVELOPE_MAX_BYTES) {
      return this.fail(
        'envelope-too-large',
        `edit envelope ${envelopeBytes} B exceeds ${CART_EDIT_ENVELOPE_MAX_BYTES} B`,
        charge(0, 0),
      );
    }

    const operationId = cartOperationId(envelope.key);
    const existing = this.carts.get(envelope.cartId);
    const state = existing ?? this.createCartState(envelope.cartId);
    const fingerprint = cartOperationFingerprint(envelope);
    const bound = state.log.bindings.get(operationId);

    if (bound !== undefined) {
      const durableCharge = charge(CART_DEDUP_HIT_CPU_MS, 1);
      this.record(durableCharge);
      if (bound !== fingerprint) {
        this.conflictAttempts += 1;
        return rejection(
          'idempotency-conflict',
          `key ${operationId} is already bound to a different payload/context`,
          durableCharge,
        );
      }
      this.duplicateAttempts += 1;
      const token =
        state.ackTokens.get(operationId) ??
        cartSessionToken(envelope.cartId, [...state.log.envelopes.keys()]);
      return {
        ok: true,
        ack: {
          operationId,
          cartId: envelope.cartId,
          status: 'duplicate',
          token,
          bytes: cartAckBytes(token),
          envelope,
          charge: durableCharge,
        },
      };
    }

    if (state.log.envelopes.size + 1 > CART_MAX_CART_COMMITTED_OPS) {
      return this.fail(
        'cart-operation-cap',
        `cart ${envelope.cartId} would exceed ${CART_MAX_CART_COMMITTED_OPS} committed operations`,
        charge(0, 0),
      );
    }

    const expansion = expandCartOperation(envelope, state.log.envelopes);
    let effect: CartEffect;
    if (expansion.status === 'expanded') {
      effect = expansion.effect;
    } else if (expansion.status === 'causal-cycle') {
      return this.fail(
        'effect-mismatch',
        `causal cycle: ${expansion.cycle.join(' -> ')}`,
        charge(0, 0),
      );
    } else if (context.mode === 'client') {
      // An edit may not be acknowledged before its real causal closure exists.
      return this.fail(
        'dependency-unavailable',
        `observed context is not yet durable: ${[...expansion.missing].sort().join(', ') || 'unknown'}`,
        charge(0, 0),
      );
    } else {
      // Out-of-order replica envelopes are durably buffered without an effect.
      effect = { adds: [], tombstones: [] };
    }

    if (context.declaredEffect !== undefined && expansion.status === 'expanded') {
      const candidate = { ...envelope, effect };
      const effectIssues = validateCartOperationEffect(candidate, state.log.envelopes);
      if (effectIssues.length > 0) {
        return this.fail(
          'effect-mismatch',
          effectIssues.map((issue) => `${issue.code}: ${issue.message}`).join('; '),
          charge(0, 0),
        );
      }
      if (
        !sameStrings(context.declaredEffect.adds, effect.adds) ||
        !sameStrings(context.declaredEffect.tombstones, effect.tombstones)
      ) {
        return this.fail(
          'effect-mismatch',
          'replicated envelope declares an effect that differs from its context derivation',
          charge(0, 0),
        );
      }
    }

    const accepted = acceptCartOperation(state.log, envelope);
    if (accepted.status !== 'accepted') {
      // Defensive: the binding check above already rejected conflicts.
      return this.fail(
        'invalid-operation',
        `replica log refused the envelope with status ${accepted.status}`,
        charge(0, 0),
      );
    }
    const nextLog = accepted.log;
    const nextView = materializeCartView(nextLog);
    const materializedBytes =
      this.kind === 'store'
        ? nextView.work.uniqueUnits * CART_ENCODED_UNIT_BYTES +
          nextView.work.uniqueTombstones * CART_ENCODED_TOMBSTONE_BYTES
        : 0;
    const materializedDelta = materializedBytes - state.materializedBytes;

    const outboxEdges =
      context.mode === 'client'
        ? this.replicationEdges
        : this.replicationEdges.filter((edge) => edge.edgeId !== context.arrivalEdgeId);
    const outboxBytes = outboxEdges.length * CART_OUTBOX_OBLIGATION_BYTES;
    const workItems = effect.adds.length + effect.tombstones.length;
    const durableBytes =
      envelopeBytes +
      CART_DEDUP_RESULT_BYTES +
      CART_COMMIT_SEQUENCE_BYTES +
      outboxBytes +
      Math.max(0, materializedDelta);
    // The RAM budget is a property of the node, not of one cart: every cart's
    // materialized working set is resident at the same time. Project this
    // commit by replacing this cart's current contribution with its next one.
    const nodeMaterializedBytes = this.nodeMaterializedBytes();
    const projectedMaterializedBytes =
      nodeMaterializedBytes - state.materializedBytes + materializedBytes;
    const ramBytes = this.kind === 'store' ? projectedMaterializedBytes * 2 : 0;
    const durableCharge =
      context.mode === 'client' && this.kind === 'journal'
        ? charge(CART_JOURNAL_APPEND_CPU_MS, 1)
        : charge(
            (this.kind === 'journal'
              ? CART_JOURNAL_APPEND_CPU_MS
              : CART_STORE_INGEST_BASE_CPU_MS) +
              (this.kind === 'store' ? CART_STORE_INGEST_ITEM_CPU_MS * workItems : 0),
            1,
          );

    const used = this.durableReservedBytes + this.durableCommittedBytes;
    if (used + durableBytes > this.capacityBytes) {
      return this.fail(
        'durable-capacity',
        `commit needs ${durableBytes} durable bytes but only ${this.capacityBytes - used} remain`,
        durableCharge,
      );
    }
    if (this.kind === 'store' && ramBytes > this.workingRamLimitBytes) {
      return this.fail(
        'working-ram',
        `projected node-wide materialized working set ${ramBytes} B exceeds ${this.workingRamLimitBytes} B of RAM`,
        durableCharge,
      );
    }

    // ---- atomic durable write: reservation is all-or-nothing ----
    this.durableReservedBytes += durableBytes;
    const commitSequence = this.nextCommitSequence;
    this.nextCommitSequence += 1;
    const commitTimeUs = context.atUs + (context.flushCompleted ? 0 : CART_DURABLE_FLUSH_US);

    state.log = nextLog;
    state.view = nextView;
    state.materializedBytes = materializedBytes;
    state.commitSequences.set(operationId, commitSequence);
    state.commitTimesUs.set(operationId, commitTimeUs);
    const token = cartSessionToken(envelope.cartId, [...nextLog.envelopes.keys()]);
    state.ackTokens.set(operationId, token);
    this.carts.set(envelope.cartId, state);

    for (const edge of outboxEdges) {
      this.appendObligation(edge.edgeId, { cartId: envelope.cartId, operationId });
    }
    this.durableCommittedBytes += durableBytes;
    this.durableReservedBytes -= durableBytes;
    this.materializedDurableBytes += Math.max(0, materializedDelta);
    this.record(durableCharge);
    this.ackCount += 1;

    this.onDurableCommit?.({
      nodeId: this.nodeId,
      kind: this.kind,
      cartId: envelope.cartId,
      operationId,
      fingerprint,
      tokenIds: token.ids,
      outboxEdgeIds: outboxEdges.map((edge) => edge.edgeId),
      durableBytes,
      commitSequence,
      atUs: context.atUs,
    });

    return {
      ok: true,
      ack: {
        operationId,
        cartId: envelope.cartId,
        status: 'accepted',
        token,
        bytes: cartAckBytes(token),
        envelope,
        charge: durableCharge,
      },
    };
  }

  private createCartState(cartId: string): CartDurableCartState {
    return {
      log: createCartOperationLog(cartId),
      view: null,
      ackTokens: new Map(),
      commitSequences: new Map(),
      commitTimesUs: new Map(),
      materializedBytes: 0,
    };
  }

  private appendObligation(edgeId: string, id: CartReplicationId): void {
    const key = `${edgeId}\u0000${cartReplicationIdKey(id)}`;
    if (this.outboxKeys.has(key)) return;
    this.outboxKeys.add(key);
    const queue = this.outbox.get(edgeId);
    if (queue === undefined) {
      this.outbox.set(edgeId, [id]);
    } else {
      queue.push(id);
    }
  }

  /** Commit sequence assigned to a retained operation, for freshness evidence. */
  commitSequenceFor(cartId: string, operationId: string): number | undefined {
    return this.carts.get(cartId)?.commitSequences.get(operationId);
  }

  /** Durable commit time (including flush) of a retained operation. */
  commitTimeFor(cartId: string, operationId: string): number | undefined {
    return this.carts.get(cartId)?.commitTimesUs.get(operationId);
  }

  retainedOperationIds(cartId: string): readonly string[] {
    return [...(this.carts.get(cartId)?.log.envelopes.keys() ?? [])].sort();
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
