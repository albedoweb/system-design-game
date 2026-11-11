/**
 * GC-007 — cart operation log and exact materialization (`cart-protocol-v1` §3).
 *
 * The log is an immutable set of durable envelopes plus the per-key payload
 * bindings used for retry identity (`cart-protocol-v1` §3, "Retry identity and
 * durability"):
 *
 * - same key + identical payload performs no second effect (duplicate),
 * - same key + different payload is `IdempotencyConflict` (conflict),
 * - a conflict is rejected before mutation and never enters the envelope set.
 *
 * Materialization is the join `(A, R)` over every expandable operation: live
 * units are `A \ R`, quantity is their count, and the join itself is a set
 * union of both sides. Effects are derived from declared observed contexts, so
 * delivery permutation and duplication cannot change the resulting cart.
 * Out-of-order envelopes whose causal closure is absent are buffered and the
 * view is explicitly incomplete. Quantities are never clamped.
 *
 * Work is charged for the materialization itself: every unit and tombstone
 * visited by the union merge, plus the encoded durable bytes of the retained
 * sets (32 B per unit, 24 B per tombstone, `cart-protocol-v1` message sizes).
 */
import {
  cartOperationFingerprint,
  cartOperationId,
  cartUnitNamespace,
  expandCartOperations,
  sortCartUnitIds,
  type CartEffect,
  type CartOperationEnvelope,
  type CartOperationKey,
} from './operations';

/** Encoded durable size of one materialized unit / tombstone. */
export const CART_UNIT_ENCODED_BYTES = 32;
export const CART_TOMBSTONE_ENCODED_BYTES = 24;
/** Proposed materialization work: 0.01 CPU-ms per unit/tombstone visited. */
export const CART_MATERIALIZE_CPU_MS_PER_ITEM = 0.01;

export interface CartOperationLog {
  readonly cartId: string;
  /** Accepted envelopes by operation id (unique within the cart). */
  readonly envelopes: ReadonlyMap<string, CartOperationEnvelope>;
  /** First accepted payload fingerprint per operation id. */
  readonly bindings: ReadonlyMap<string, string>;
  /** Operation ids whose identical payload was re-delivered. */
  readonly duplicates: readonly string[];
  /** Operation ids whose conflicting payload was rejected. */
  readonly conflicts: readonly string[];
}

export type CartAcceptStatus = 'accepted' | 'duplicate' | 'conflict' | 'cart-mismatch';

export interface CartAcceptResult {
  readonly log: CartOperationLog;
  readonly status: CartAcceptStatus;
}

export function createCartOperationLog(cartId: string): CartOperationLog {
  return {
    cartId,
    envelopes: new Map(),
    bindings: new Map(),
    duplicates: [],
    conflicts: [],
  };
}

/**
 * Durably accept one envelope. Retry identity is bound to the first accepted
 * payload for the operation key; replaying that payload is a duplicate, and a
 * different payload for the same key is a conflict with no mutation.
 */
export function acceptCartOperation(
  log: CartOperationLog,
  envelope: CartOperationEnvelope,
): CartAcceptResult {
  if (envelope.cartId !== log.cartId) {
    return { log, status: 'cart-mismatch' };
  }

  const operationId = cartOperationId(envelope.key);
  const fingerprint = cartOperationFingerprint(envelope);
  const bound = log.bindings.get(operationId);

  if (bound === undefined) {
    const envelopes = new Map(log.envelopes);
    envelopes.set(operationId, envelope);
    const bindings = new Map(log.bindings);
    bindings.set(operationId, fingerprint);
    return {
      log: { ...log, envelopes, bindings },
      status: 'accepted',
    };
  }

  if (bound === fingerprint) {
    return {
      log: { ...log, duplicates: [...log.duplicates, operationId] },
      status: 'duplicate',
    };
  }

  return {
    log: { ...log, conflicts: [...log.conflicts, operationId] },
    status: 'conflict',
  };
}

export interface CartSkuState {
  readonly added: readonly string[];
  readonly tombstones: readonly string[];
  /** `added \ tombstones`, ascending unit-id order. */
  readonly live: readonly string[];
  readonly quantity: number;
}

/** Charged work description for one materialization pass. */
export interface CartMaterializationWork {
  readonly operationsApplied: number;
  /** Units/tombstones visited by the union merge, counting repeated inputs. */
  readonly unitsAdded: number;
  readonly tombstonesAdded: number;
  /** Distinct retained units/tombstones after the join. */
  readonly uniqueUnits: number;
  readonly uniqueTombstones: number;
  readonly liveUnits: number;
  readonly encodedUnitBytes: number;
  readonly encodedTombstoneBytes: number;
  readonly cpuMilliseconds: number;
}

export interface CartMaterializedView {
  readonly cartId: string;
  readonly skus: Readonly<Record<string, CartSkuState>>;
  /** Derived effects of every applied operation, by operation id. */
  readonly effects: Readonly<Record<string, CartEffect>>;
  readonly appliedIds: readonly string[];
  /** Envelopes retained but not expandable yet (missing causal closure). */
  readonly bufferedIds: readonly string[];
  readonly missingDependencies: Readonly<Record<string, readonly string[]>>;
  readonly cyclicIds: readonly string[];
  /** Unique ids of duplicates/conflicts observed by the log. */
  readonly duplicates: readonly string[];
  readonly conflicts: readonly string[];
  /**
   * A complete view requires every retained operation to be causally
   * expandable. Missing dependencies therefore never expose a complete view.
   */
  readonly complete: boolean;
  readonly work: CartMaterializationWork;
}

interface MutableSkuState {
  added: Set<string>;
  tombstones: Set<string>;
}

function stateFor(
  states: Map<string, MutableSkuState>,
  sku: string,
): MutableSkuState {
  const existing = states.get(sku);
  if (existing !== undefined) return existing;
  const created: MutableSkuState = { added: new Set(), tombstones: new Set() };
  states.set(sku, created);
  return created;
}

function sortedRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const record: Record<string, T> = {};
  for (const [key, value] of [...entries].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    record[key] = value;
  }
  return record;
}

/**
 * Materialize the exact cart view for a committed operation log.
 *
 * This function has no receiver-state parameter by design: a quantity change
 * can only be expanded from the observed context recorded in its envelope.
 */
export function materializeCartView(log: CartOperationLog): CartMaterializedView {
  const summary = expandCartOperations(log.envelopes);
  const states = new Map<string, MutableSkuState>();
  const effects: Record<string, CartEffect> = {};
  let unitsAdded = 0;
  let tombstonesAdded = 0;

  const appliedIds = [...summary.expansions.keys()].sort();
  for (const operationId of appliedIds) {
    const expansion = summary.expansions.get(operationId);
    if (expansion === undefined) continue;
    const envelope = log.envelopes.get(operationId);
    if (envelope === undefined) continue;

    const target = stateFor(states, envelope.payload.sku);
    for (const unit of expansion.effect.adds) {
      target.added.add(unit);
      unitsAdded += 1;
    }
    for (const unit of expansion.effect.tombstones) {
      target.tombstones.add(unit);
      tombstonesAdded += 1;
    }
    effects[operationId] = {
      adds: [...expansion.effect.adds],
      tombstones: [...expansion.effect.tombstones],
    };
  }

  let uniqueUnits = 0;
  let uniqueTombstones = 0;
  let liveUnits = 0;
  const skus: Record<string, CartSkuState> = {};
  for (const sku of [...states.keys()].sort()) {
    const state = stateFor(states, sku);
    const added = sortCartUnitIds(state.added);
    const tombstones = sortCartUnitIds(state.tombstones);
    const live = added.filter((unit) => !state.tombstones.has(unit));
    uniqueUnits += added.length;
    uniqueTombstones += tombstones.length;
    liveUnits += live.length;
    skus[sku] = { added, tombstones, live, quantity: live.length };
  }

  const visitedItems = unitsAdded + tombstonesAdded;
  const work: CartMaterializationWork = {
    operationsApplied: appliedIds.length,
    unitsAdded,
    tombstonesAdded,
    uniqueUnits,
    uniqueTombstones,
    liveUnits,
    encodedUnitBytes: uniqueUnits * CART_UNIT_ENCODED_BYTES,
    encodedTombstoneBytes: uniqueTombstones * CART_TOMBSTONE_ENCODED_BYTES,
    cpuMilliseconds: visitedItems * CART_MATERIALIZE_CPU_MS_PER_ITEM,
  };

  return {
    cartId: log.cartId,
    skus,
    effects: sortedRecord(Object.entries(effects)),
    appliedIds,
    bufferedIds: summary.bufferedIds,
    missingDependencies: sortedRecord(Object.entries(summary.missingDependencies)),
    cyclicIds: summary.cyclicIds,
    duplicates: [...new Set(log.duplicates)].sort(),
    conflicts: [...new Set(log.conflicts)].sort(),
    complete: summary.bufferedIds.length === 0 && summary.cyclicIds.length === 0,
    work,
  };
}

/** Convenience lookup used by read/checkout paths. */
export function cartViewQuantity(view: CartMaterializedView, sku: string): number {
  return view.skus[sku]?.quantity ?? 0;
}

/** Whether an envelope's unit ids belong to the declared cart/key prefix. */
export function cartEnvelopeUnitPrefix(envelope: CartOperationEnvelope): string {
  return `${cartUnitNamespace(envelope.cartId)}/${cartOperationId(envelope.key)}`;
}

export type { CartOperationKey };
