/**
 * GC-007 — immutable cart operation algebra (`cart-protocol-v1` §3/B1).
 *
 * An edit operation is `{cartId,key,payload,observedContext}`. The effect of an
 * operation (the units it creates and the units it tombstones) is a pure
 * function of that operation and the exact causal closure named by its
 * `observedContext`. Delivery order is never an input here: a receiver cannot
 * select different units by arriving earlier or later, and replaying the same
 * envelope can never produce a second effect.
 *
 * `ChangeQuantity` is a *relative* adjustment against the observed view, not a
 * global assignment. Its target selects a difference in fresh units or
 * tombstones the lowest unit ids of the observed live set. Because the effect
 * is fixed in the envelope, two concurrent changes to the same target can
 * legitimately leave a merged quantity above the proposed input range; nothing
 * in this module clamps a merged quantity.
 *
 * All functions are deterministic and return fresh, ascening-unit-id sorted
 * arrays. Inputs are never mutated.
 */
import { CART_REGIONS, type CartRegion } from '../contracts';

/** An operation key is immutable and unique within a cart. */
export interface CartOperationKey {
  readonly originRegion: CartRegion;
  readonly clientId: string;
  readonly requestSequence: number;
}

export type CartEditKind = 'add' | 'change' | 'remove';

export interface CartOperationPayload {
  readonly sku: string;
  readonly kind: CartEditKind;
  /**
   * `add`: count of fresh units (proposed 1..5).
   * `change`: relative target quantity for the observed view (proposed 0..20).
   * `remove`: always null.
   */
  readonly quantity: number | null;
}

/** The immutable durable envelope recorded by an origin authority. */
export interface CartOperationEnvelope {
  readonly cartId: string;
  readonly key: CartOperationKey;
  readonly payload: CartOperationPayload;
  /** Exact causal operation closure represented by the edited view. */
  readonly observedContext: readonly string[];
}

export interface CartEffect {
  readonly adds: readonly string[];
  readonly tombstones: readonly string[];
}

/** A durable envelope that also carries its validated derived effect. */
export interface CartOperation extends CartOperationEnvelope {
  readonly effect: CartEffect;
}

/**
 * Proposed input bounds from `cart-protocol-v1` §3. They validate the declared
 * payload only; a merged cart quantity is never clamped to them.
 */
export const CART_ADD_QUANTITY_MIN = 1;
export const CART_ADD_QUANTITY_MAX = 5;
export const CART_CHANGE_TARGET_MIN = 0;
export const CART_CHANGE_TARGET_MAX = 20;

const REGION_ORDINAL: ReadonlyMap<string, number> = new Map(
  CART_REGIONS.map((region, index) => [region, index]),
);

const IDENTIFIER_PATTERN = /^[\x20-\x7e]{1,64}$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Stable operation id: the canonical form of the operation key. */
export function cartOperationId(key: CartOperationKey): string {
  return `${key.originRegion}/${key.clientId}/${key.requestSequence}`;
}

/**
 * Canonical cart namespace for unit ids. The cart id is percent-encoded so it
 * cannot be confused with the `region/clientId/requestSequence` key segments
 * even when it contains printable delimiters such as `/` or `#`.
 */
export function cartUnitNamespace(cartId: string): string {
  if (typeof cartId !== 'string' || cartId.length === 0) {
    throw new TypeError(`invalid cart id: ${String(cartId)}`);
  }
  return encodeURIComponent(cartId);
}

/**
 * Unit ids created by an addition are `(cartId, key, unitIndex)`, encoded as
 * `cartNamespace/region/clientId/requestSequence#unitIndex`. The cart
 * namespace is part of the identity: identical keys in separate carts never
 * alias the same unit.
 */
export function cartUnitId(
  cartId: string,
  key: CartOperationKey,
  unitIndex: number,
): string {
  if (!Number.isInteger(unitIndex) || unitIndex < 0) {
    throw new RangeError(`invalid cart unit index: ${String(unitIndex)}`);
  }
  return `${cartUnitNamespace(cartId)}/${cartOperationId(key)}#${unitIndex}`;
}

export function cartUnitIds(
  cartId: string,
  key: CartOperationKey,
  count: number,
  startIndex = 0,
): string[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`invalid cart unit count: ${String(count)}`);
  }
  if (!Number.isInteger(startIndex) || startIndex < 0) {
    throw new RangeError(`invalid cart unit start index: ${String(startIndex)}`);
  }
  return Array.from({ length: count }, (_, offset) =>
    cartUnitId(cartId, key, startIndex + offset),
  );
}

export interface ParsedCartUnitId {
  readonly cartId: string;
  readonly originRegion: CartRegion;
  readonly regionOrdinal: number;
  readonly clientId: string;
  readonly requestSequence: number;
  readonly unitIndex: number;
}

/**
 * Parse `cartNamespace/region/clientId/requestSequence#unitIndex`; null when
 * malformed. The decoded cart id is recovered from the leading, percent-encoded
 * namespace segment.
 */
export function parseCartUnitId(unitId: string): ParsedCartUnitId | null {
  const namespaceSlash = unitId.indexOf('/');
  if (namespaceSlash <= 0) return null;
  let cartId: string;
  try {
    cartId = decodeURIComponent(unitId.slice(0, namespaceSlash));
  } catch {
    return null;
  }
  if (cartId.length === 0) return null;

  const hash = unitId.lastIndexOf('#');
  if (hash <= namespaceSlash) return null;
  const keyText = unitId.slice(namespaceSlash + 1, hash);
  const indexText = unitId.slice(hash + 1);
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(indexText)) return null;

  const firstSlash = keyText.indexOf('/');
  const lastSlash = keyText.lastIndexOf('/');
  if (firstSlash <= 0 || lastSlash === firstSlash) return null;
  const clientId = keyText.slice(firstSlash + 1, lastSlash);
  if (clientId.length === 0) return null;
  const sequenceText = keyText.slice(lastSlash + 1);
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(sequenceText)) return null;

  const regionOrdinal = REGION_ORDINAL.get(keyText.slice(0, firstSlash));
  if (regionOrdinal === undefined) return null;

  return {
    cartId,
    originRegion: keyText.slice(0, firstSlash) as CartRegion,
    regionOrdinal,
    clientId,
    requestSequence: Number(sequenceText),
    unitIndex: Number(indexText),
  };
}

/**
 * Total order `(cartId, region ordinal, clientId, numeric requestSequence,
 * unitIndex)`. The cart namespace leads so ids never tie across carts. Numeric
 * sequences compare numerically, never lexicographically. Malformed ids sort
 * after well-formed ones by raw string so the order stays total.
 */
export function compareCartUnitIds(left: string, right: string): number {
  const a = parseCartUnitId(left);
  const b = parseCartUnitId(right);
  if (a === null || b === null) {
    if (a !== null) return -1;
    if (b !== null) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (a.cartId !== b.cartId) return a.cartId < b.cartId ? -1 : 1;
  if (a.regionOrdinal !== b.regionOrdinal) return a.regionOrdinal < b.regionOrdinal ? -1 : 1;
  if (a.clientId !== b.clientId) return a.clientId < b.clientId ? -1 : 1;
  if (a.requestSequence !== b.requestSequence) {
    return a.requestSequence < b.requestSequence ? -1 : 1;
  }
  if (a.unitIndex !== b.unitIndex) return a.unitIndex < b.unitIndex ? -1 : 1;
  return 0;
}

/** Ascending unique unit-id order; duplicate inputs collapse. */
export function sortCartUnitIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort(compareCartUnitIds);
}

/**
 * Payload binding used for retry identity. Context order is not semantic, so it
 * is sorted before comparison.
 */
export function cartOperationFingerprint(operation: CartOperationEnvelope): string {
  return JSON.stringify({
    sku: operation.payload.sku,
    kind: operation.payload.kind,
    quantity: operation.payload.quantity,
    observedContext: [...new Set(operation.observedContext)].sort(),
  });
}

// ---------------------------------------------------------------------------
// Effect expansion
// ---------------------------------------------------------------------------

export interface CartExpandedEffect {
  readonly status: 'expanded';
  readonly effect: CartEffect;
  /** Live units of this SKU inside the declared observed context. */
  readonly liveInObservedContext: readonly string[];
}

/** Dependencies are not present yet: buffer the envelope, expose no effect. */
export interface CartBufferedEffect {
  readonly status: 'missing-dependency';
  readonly missing: readonly string[];
}

/** A malformed causal graph; never materialized. */
export interface CartCyclicEffect {
  readonly status: 'causal-cycle';
  readonly cycle: readonly string[];
}

export type CartOperationExpansion =
  | CartExpandedEffect
  | CartBufferedEffect
  | CartCyclicEffect;

/**
 * Derive one operation's immutable add/tombstone effect from its declared
 * observed context. Dependencies must all be present; otherwise the operation
 * is not expandable and no partial effect is invented.
 */
export function expandCartOperation(
  operation: CartOperationEnvelope,
  envelopesById: ReadonlyMap<string, CartOperationEnvelope>,
  memo: Map<string, CartOperationExpansion> = new Map(),
): CartOperationExpansion {
  const table = new Map(envelopesById);
  table.set(cartOperationId(operation.key), operation);
  const walk: WalkContext = { cycle: null, missing: new Set<string>() };
  const result = expandWithin(
    table,
    cartOperationId(operation.key),
    memo,
    new Set<string>(),
    walk,
  );
  if (result !== null) return result;
  if (walk.cycle !== null) return { status: 'causal-cycle', cycle: [...walk.cycle] };
  return { status: 'missing-dependency', missing: [...walk.missing].sort() };
}

interface WalkContext {
  cycle: readonly string[] | null;
  missing: Set<string>;
}

function expandWithin(
  table: ReadonlyMap<string, CartOperationEnvelope>,
  operationId: string,
  memo: Map<string, CartOperationExpansion>,
  visiting: Set<string>,
  walk: WalkContext,
): CartOperationExpansion | null {
  const cached = memo.get(operationId);
  if (cached !== undefined) return cached;

  const envelope = table.get(operationId);
  if (envelope === undefined) {
    walk.missing.add(operationId);
    return null;
  }
  if (visiting.has(operationId)) {
    walk.cycle = [...visiting, operationId];
    return null;
  }

  visiting.add(operationId);
  let blocked = false;
  for (const dependencyId of envelope.observedContext) {
    const dependency = expandWithin(table, dependencyId, memo, visiting, walk);
    if (dependency === null || dependency.status !== 'expanded') blocked = true;
    if (dependency !== null && dependency.status === 'causal-cycle' && walk.cycle === null) {
      walk.cycle = dependency.cycle;
    }
    if (walk.cycle !== null) break;
  }
  visiting.delete(operationId);

  if (walk.cycle !== null) {
    const cyclic: CartCyclicEffect = { status: 'causal-cycle', cycle: [...walk.cycle] };
    memo.set(operationId, cyclic);
    return cyclic;
  }
  if (blocked) return null;

  const derived = deriveFromDependencies(envelope, table, memo);
  memo.set(operationId, derived);
  return derived;
}

function deriveFromDependencies(
  envelope: CartOperationEnvelope,
  table: ReadonlyMap<string, CartOperationEnvelope>,
  memo: Map<string, CartOperationExpansion>,
): CartExpandedEffect {
  const added = new Set<string>();
  const removed = new Set<string>();

  const sameSkuDependencies = [...new Set(envelope.observedContext)]
    .filter((dependencyId) => table.get(dependencyId)?.payload.sku === envelope.payload.sku)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  for (const dependencyId of sameSkuDependencies) {
    const dependency = memo.get(dependencyId);
    if (dependency === undefined || dependency.status !== 'expanded') continue;
    for (const unit of dependency.effect.adds) added.add(unit);
    for (const unit of dependency.effect.tombstones) removed.add(unit);
  }

  const liveInObservedContext = sortCartUnitIds(
    [...added].filter((unit) => !removed.has(unit)),
  );
  const effect = effectForPayload(envelope, liveInObservedContext);
  return { status: 'expanded', effect, liveInObservedContext };
}

function effectForPayload(
  envelope: CartOperationEnvelope,
  liveInObservedContext: readonly string[],
): CartEffect {
  const declared = envelope.payload.quantity;
  const quantity = Number.isInteger(declared) && (declared as number) >= 0 ? (declared as number) : 0;

  if (envelope.payload.kind === 'add') {
    return { adds: cartUnitIds(envelope.cartId, envelope.key, quantity), tombstones: [] };
  }
  if (envelope.payload.kind === 'remove') {
    return { adds: [], tombstones: liveInObservedContext };
  }
  if (quantity > liveInObservedContext.length) {
    return {
      adds: cartUnitIds(envelope.cartId, envelope.key, quantity - liveInObservedContext.length),
      tombstones: [],
    };
  }
  if (quantity < liveInObservedContext.length) {
    return {
      adds: [],
      tombstones: liveInObservedContext.slice(0, liveInObservedContext.length - quantity),
    };
  }
  return { adds: [], tombstones: [] };
}

export interface CartExpansionSummary {
  readonly expansions: ReadonlyMap<string, CartExpandedEffect>;
  readonly bufferedIds: readonly string[];
  readonly cyclicIds: readonly string[];
  readonly missingDependencies: Readonly<Record<string, readonly string[]>>;
  readonly cycles: Readonly<Record<string, readonly string[]>>;
}

/** Expand a whole committed set with one shared memo. */
export function expandCartOperations(
  envelopesById: ReadonlyMap<string, CartOperationEnvelope>,
): CartExpansionSummary {
  const memo = new Map<string, CartOperationExpansion>();
  const expansions = new Map<string, CartExpandedEffect>();
  const buffered: string[] = [];
  const cyclic: string[] = [];
  const missingDependencies: Record<string, readonly string[]> = {};
  const cycles: Record<string, readonly string[]> = {};

  for (const operationId of [...envelopesById.keys()].sort()) {
    const walk: WalkContext = { cycle: null, missing: new Set() };
    const result =
      expandWithin(envelopesById, operationId, memo, new Set<string>(), walk) ??
      ({
        status: 'missing-dependency',
        missing: [...walk.missing].sort(),
      } satisfies CartBufferedEffect);

    if (result.status === 'expanded') {
      expansions.set(operationId, result);
    } else if (result.status === 'causal-cycle') {
      cyclic.push(operationId);
      cycles[operationId] = result.cycle;
    } else {
      buffered.push(operationId);
      missingDependencies[operationId] =
        result.missing.length > 0 ? result.missing : walk.missing.size > 0 ? [...walk.missing].sort() : [];
    }
  }

  return {
    expansions,
    bufferedIds: buffered.sort(),
    cyclicIds: cyclic.sort(),
    missingDependencies,
    cycles,
  };
}

// ---------------------------------------------------------------------------
// Envelope and effect validation
// ---------------------------------------------------------------------------

export const CART_OPERATION_ISSUE_CODES = [
  'cart-invalid-id',
  'key-invalid-client',
  'key-invalid-sequence',
  'payload-invalid-sku',
  'payload-invalid-kind',
  'payload-invalid-quantity',
  'context-invalid-id',
  'context-duplicate',
  'context-self-reference',
  'effect-unverifiable',
  'effect-adds-mismatch',
  'effect-tombstones-mismatch',
] as const;

export type CartOperationIssueCode = (typeof CART_OPERATION_ISSUE_CODES)[number];

export interface CartOperationIssue {
  readonly code: CartOperationIssueCode;
  readonly message: string;
  readonly operationId?: string;
}

function identifierIssue(
  value: unknown,
): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

/**
 * Structural validation of an untrusted edit envelope. It does not consult the
 * log: dependencies are checked by expansion, never assumed from arrival order.
 */
export function validateCartOperationEnvelope(
  operation: CartOperationEnvelope,
): CartOperationIssue[] {
  const issues: CartOperationIssue[] = [];
  const operationId = cartOperationId(operation.key);

  if (!identifierIssue(operation.cartId)) {
    issues.push({
      code: 'cart-invalid-id',
      message: 'cartId must be 1..64 printable ASCII characters',
    });
  }
  if (!identifierIssue(operation.key.clientId)) {
    issues.push({
      code: 'key-invalid-client',
      message: 'clientId must be 1..64 printable ASCII characters',
      operationId,
    });
  }
  if (
    !Number.isInteger(operation.key.requestSequence) ||
    operation.key.requestSequence < 0 ||
    operation.key.requestSequence > 4_294_967_295
  ) {
    issues.push({
      code: 'key-invalid-sequence',
      message: 'requestSequence must be a uint32',
      operationId,
    });
  }
  if (!identifierIssue(operation.payload.sku)) {
    issues.push({
      code: 'payload-invalid-sku',
      message: 'sku must be 1..64 printable ASCII characters',
      operationId,
    });
  }

  const { kind, quantity } = operation.payload;
  if (kind !== 'add' && kind !== 'change' && kind !== 'remove') {
    issues.push({ code: 'payload-invalid-kind', message: 'unknown edit kind', operationId });
  } else if (kind === 'remove') {
    if (quantity !== null) {
      issues.push({
        code: 'payload-invalid-quantity',
        message: 'remove must not declare a quantity',
        operationId,
      });
    }
  } else {
    const minimum = kind === 'add' ? CART_ADD_QUANTITY_MIN : CART_CHANGE_TARGET_MIN;
    const maximum = kind === 'add' ? CART_ADD_QUANTITY_MAX : CART_CHANGE_TARGET_MAX;
    if (
      quantity === null ||
      !Number.isInteger(quantity) ||
      quantity < minimum ||
      quantity > maximum
    ) {
      issues.push({
        code: 'payload-invalid-quantity',
        message: `${kind} quantity must be an integer in ${minimum}..${maximum}`,
        operationId,
      });
    }
  }

  const seen = new Set<string>();
  for (const contextId of operation.observedContext) {
    if (!identifierIssue(contextId)) {
      issues.push({
        code: 'context-invalid-id',
        message: 'observed context ids must be 1..64 printable ASCII characters',
        operationId,
      });
      continue;
    }
    if (contextId === operationId) {
      issues.push({
        code: 'context-self-reference',
        message: 'an operation cannot observe itself',
        operationId,
      });
    }
    if (seen.has(contextId)) {
      issues.push({
        code: 'context-duplicate',
        message: `duplicate observed context id ${contextId}`,
        operationId,
      });
      continue;
    }
    seen.add(contextId);
  }

  return issues;
}

/**
 * Recompute the declared effect and compare it with the durable envelope. The
 * authority validates this before commit; a receiver validates it at ingest.
 */
export function validateCartOperationEffect(
  operation: CartOperation,
  envelopesById: ReadonlyMap<string, CartOperationEnvelope>,
): CartOperationIssue[] {
  const operationId = cartOperationId(operation.key);
  const expansion = expandCartOperation(operation, envelopesById);

  if (expansion.status !== 'expanded') {
    return [
      {
        code: 'effect-unverifiable',
        message:
          expansion.status === 'causal-cycle'
            ? `causal cycle: ${expansion.cycle.join(' -> ')}`
            : `missing dependencies: ${expansion.missing.join(', ') || 'unknown'}`,
        operationId,
      },
    ];
  }

  const issues: CartOperationIssue[] = [];
  const declaredAdds = [...new Set(operation.effect.adds)].sort(compareCartUnitIds);
  const declaredTombstones = [...new Set(operation.effect.tombstones)].sort(compareCartUnitIds);
  if (!sameStrings(declaredAdds, expansion.effect.adds)) {
    issues.push({
      code: 'effect-adds-mismatch',
      message: `declared adds differ from derived context effect`,
      operationId,
    });
  }
  if (!sameStrings(declaredTombstones, expansion.effect.tombstones)) {
    issues.push({
      code: 'effect-tombstones-mismatch',
      message: `declared tombstones differ from derived context effect`,
      operationId,
    });
  }
  return issues;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
