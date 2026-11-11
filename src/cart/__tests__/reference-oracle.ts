/**
 * GC-004 reference oracle: a deliberately small, hand-auditable enumerator for
 * cart algebra, session-token coverage and strict Inventory semantics.
 *
 * Independence rule: this module MUST NOT import or otherwise consult the
 * production cart reducer, session, evaluator, fixtures or registry. Expected
 * outcomes live as literal data under tests/fixtures/cart/oracle/ and are
 * compared against this implementation by reference-oracle.test.ts.
 *
 * The only allowed import is a standard-library hash used for canonical basket
 * digests. A static guard in the test enforces both rules.
 */
import { createHash } from 'node:crypto';

export type Region = 'us-west' | 'eu-central' | 'ap-northeast';

export interface CartKey {
  originRegion: Region;
  clientId: string;
  requestSequence: number;
}

export type EditKind = 'add' | 'change' | 'remove';

/** Immutable operation envelope from cart-protocol-v1 §3. */
export interface Operation {
  id: string;
  cartId: string;
  key: CartKey;
  sku: string;
  kind: EditKind;
  /** add count or change target; absent for remove */
  quantity: number | null;
  observedContext: string[];
  commitAtUs: number;
}

export interface Effect {
  adds: string[];
  tombstones: string[];
}

export interface MaterializedSku {
  live: string[];
  quantity: number;
  added: string[];
  removed: string[];
}

export type CartState = Record<string, MaterializedSku>;

export interface ReductionResult {
  state: CartState;
  appliedIds: string[];
  bufferedIds: string[];
  missingDependencies: Record<string, string[]>;
  duplicates: string[];
  conflicts: string[];
}

export function keyId(key: CartKey): string {
  return `${key.originRegion}/${key.clientId}/${key.requestSequence}`;
}

export function unitIds(key: CartKey, count: number): string[] {
  const base = keyId(key);
  return Array.from({ length: count }, (_, index) => `${base}#${index}`);
}

/** Sort units by (region, origin ordinal, clientId, numeric sequence, index). */
export function compareUnitIds(left: string, right: string): number {
  const leftParts = parseUnitId(left);
  const rightParts = parseUnitId(right);
  const keys: Array<keyof typeof leftParts> = [
    'regionOrdinal',
    'clientId',
    'requestSequence',
    'unitIndex',
  ];
  for (const part of keys) {
    const a = leftParts[part];
    const b = rightParts[part];
    if (a === b) continue;
    return a < b ? -1 : 1;
  }
  return 0;
}

function parseUnitId(unitId: string): {
  regionOrdinal: number;
  clientId: string;
  requestSequence: number;
  unitIndex: number;
} {
  const hash = unitId.lastIndexOf('#');
  const keyText = unitId.slice(0, hash);
  const unitIndex = Number(unitId.slice(hash + 1));
  const parts = keyText.split('/');
  const region = parts[0] ?? '';
  const clientId = parts[1] ?? '';
  const requestSequence = Number(parts[2] ?? '0');
  const regionOrdinal = region === 'us-west' ? 0 : region === 'eu-central' ? 1 : 2;
  return { regionOrdinal, clientId, requestSequence, unitIndex };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareUnitIds);
}

function payloadSignature(operation: Operation): string {
  return JSON.stringify({
    sku: operation.sku,
    kind: operation.kind,
    quantity: operation.quantity,
    observedContext: [...operation.observedContext].sort(),
  });
}

interface Derived {
  status: 'derived' | 'missing-dependency';
  effect: Effect;
  missing: string[];
  liveInContext: string[];
}

/**
 * Derive the immutable add/tombstone effect of one operation from its declared
 * observed context. Effect derivation never looks at delivery order.
 */
export function deriveEffect(
  operation: Operation,
  operationsById: ReadonlyMap<string, Operation>,
  memo: Map<string, Derived> = new Map(),
): Derived {
  const cached = memo.get(operation.id);
  if (cached) return cached;

  const missing: string[] = [];
  const closure = new Set<string>();
  const stack = [...operation.observedContext];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (closure.has(id)) continue;
    closure.add(id);
    const dependency = operationsById.get(id);
    if (!dependency) {
      missing.push(id);
      continue;
    }
    stack.push(...dependency.observedContext);
  }

  if (missing.length > 0) {
    const result: Derived = {
      status: 'missing-dependency',
      effect: { adds: [], tombstones: [] },
      missing: sortedIds(missing),
      liveInContext: [],
    };
    memo.set(operation.id, result);
    return result;
  }

  const added = new Set<string>();
  const removed = new Set<string>();
  const contextOps = [...closure]
    .map((id) => operationsById.get(id) as Operation)
    .filter((dependency) => dependency.sku === operation.sku)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (const dependency of contextOps) {
    const derived = deriveEffect(dependency, operationsById, memo);
    for (const unit of derived.effect.adds) added.add(unit);
    for (const unit of derived.effect.tombstones) removed.add(unit);
  }
  const liveInContext = sortedUnique([...added].filter((unit) => !removed.has(unit)));

  const effect: Effect = { adds: [], tombstones: [] };
  if (operation.kind === 'add') {
    effect.adds = unitIds(operation.key, operation.quantity ?? 0);
  } else if (operation.kind === 'remove') {
    effect.tombstones = liveInContext;
  } else {
    const target = operation.quantity ?? 0;
    if (target > liveInContext.length) {
      effect.adds = unitIds(operation.key, target - liveInContext.length);
    } else if (target < liveInContext.length) {
      effect.tombstones = liveInContext.slice(0, liveInContext.length - target);
    }
  }

  const result: Derived = {
    status: 'derived',
    effect,
    missing: [],
    liveInContext,
  };
  memo.set(operation.id, result);
  return result;
}

function sortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/** Fold delivered operations into per-SKU (A, R) sets. */
export function applyOperations(
  operations: readonly Operation[],
  deliveryOrder: readonly string[],
): ReductionResult {
  const operationsById = new Map(operations.map((operation) => [operation.id, operation]));
  const effects = new Map<string, Derived>();
  for (const operation of operations) {
    effects.set(operation.id, deriveEffect(operation, operationsById, effects));
  }

  const applied = new Set<string>();
  const appliedKeys = new Set<string>();
  const buffered = new Set<string>();
  const duplicates: string[] = [];
  const conflicts: string[] = [];
  const bindings = new Map<string, string>();

  const state = new Map<string, { added: Set<string>; removed: Set<string> }>();
  const stateFor = (sku: string) => {
    const existing = state.get(sku);
    if (existing) return existing;
    const created = { added: new Set<string>(), removed: new Set<string>() };
    state.set(sku, created);
    return created;
  };

  const canApply = (operation: Operation): boolean =>
    operation.observedContext.every((id) => {
      if (applied.has(id)) return true;
      const dependency = operationsById.get(id);
      return dependency !== undefined && appliedKeys.has(keyId(dependency.key));
    });

  const applyOne = (operation: Operation) => {
    const derived = effects.get(operation.id) as Derived;
    if (derived.status !== 'derived') return;
    const target = stateFor(operation.sku);
    for (const unit of derived.effect.adds) target.added.add(unit);
    for (const unit of derived.effect.tombstones) target.removed.add(unit);
    applied.add(operation.id);
    appliedKeys.add(keyId(operation.key));
    buffered.delete(operation.id);
  };

  for (const id of deliveryOrder) {
    const operation = operationsById.get(id);
    if (!operation) continue;
    if (applied.has(id)) {
      duplicates.push(id);
      continue;
    }
    const signature = payloadSignature(operation);
    const key = keyId(operation.key);
    const bound = bindings.get(key);
    if (bound !== undefined) {
      if (bound === signature) {
        duplicates.push(id);
      } else {
        conflicts.push(id);
      }
      continue;
    }
    bindings.set(key, signature);
    if (!canApply(operation)) {
      buffered.add(id);
      continue;
    }
    applyOne(operation);
  }

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const id of deliveryOrder) {
      if (!buffered.has(id)) continue;
      const operation = operationsById.get(id);
      if (operation && canApply(operation)) {
        applyOne(operation);
        progressed = true;
      }
    }
  }

  const missingDependencies: Record<string, string[]> = {};
  for (const id of [...buffered].sort()) {
    const operation = operationsById.get(id) as Operation;
    missingDependencies[id] = operation.observedContext.filter(
      (dependency) => !applied.has(dependency),
    );
  }

  const materialized: CartState = {};
  for (const [sku, sets] of [...state.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const added = sortedUnique(sets.added);
    const removed = sortedUnique(sets.removed);
    const live = added.filter((unit) => !sets.removed.has(unit));
    materialized[sku] = {
      live,
      quantity: live.length,
      added,
      removed,
    };
  }

  return {
    state: materialized,
    appliedIds: [...applied].sort(),
    bufferedIds: [...buffered].sort(),
    missingDependencies,
    duplicates,
    conflicts,
  };
}

export interface Certificate {
  origin: Region;
  cutUs: number;
  ids: string[];
}

export interface ReadAttempt {
  cartId: string;
  tokenIds: string[];
  /** V: the actually returned causally closed operation set */
  coveredIds: string[];
  certificates: Certificate[];
  deliveryUs: number;
  /** Marks an attempt that only served a stale, already populated cache view. */
  servedFromCache: boolean;
}

export interface ReadAudit {
  status: 'ok' | 'temporarily-unavailable' | 'incomplete';
  reasons: string[];
  missingIds: string[];
  expiredOrigins: Region[];
  quantityBySku: Record<string, number>;
  outgoingTokenIds: string[];
}

export const FRESHNESS_WINDOW_US = 2_000_000;

/**
 * Audit a delivered read against B2 token/certificate/freshness rules.
 *
 * B2 requires exactly one certificate per configured origin on every complete
 * read, including an explicitly empty certificate for an idle origin. The
 * configured-origin set is supplied by the caller (it is deployment shape, not
 * cart state) so the audit can reject an omitted idle origin instead of
 * inferring completeness from whatever certificates happened to arrive.
 */
export function auditRead(
  attempt: ReadAttempt,
  operations: readonly Operation[],
  options: {
    healthy: boolean;
    configuredOrigins: readonly Region[];
    freshnessWindowUs?: number;
  },
): ReadAudit {
  const operationsById = new Map(operations.map((operation) => [operation.id, operation]));
  const covered = new Set(attempt.coveredIds);
  const reasons: string[] = [];
  const missing = new Set<string>();
  const expiredOrigins: Region[] = [];

  for (const id of attempt.coveredIds) {
    const operation = operationsById.get(id);
    if (!operation || operation.commitAtUs > attempt.deliveryUs) {
      missing.add(id);
      reasons.push('covered-id-not-durable-before-delivery');
    }
  }

  for (const id of attempt.tokenIds) {
    if (!covered.has(id)) {
      missing.add(id);
      reasons.push('token-not-covered');
    }
  }

  for (const id of attempt.coveredIds) {
    const operation = operationsById.get(id);
    if (!operation) continue;
    for (const dependency of operation.observedContext) {
      if (!covered.has(dependency)) {
        missing.add(dependency);
        reasons.push('causal-closure-gap');
      }
    }
  }

  // B2 certificate coverage is unconditional for a complete read; an idle
  // origin still owes one (empty) certificate, and two certificates for the
  // same origin are evidence of a malformed view rather than extra coverage.
  const certificateCountByOrigin = new Map<Region, number>();
  for (const certificate of attempt.certificates) {
    certificateCountByOrigin.set(
      certificate.origin,
      (certificateCountByOrigin.get(certificate.origin) ?? 0) + 1,
    );
  }
  for (const origin of options.configuredOrigins) {
    const count = certificateCountByOrigin.get(origin) ?? 0;
    if (count === 0) reasons.push(`missing-origin-certificate:${origin}`);
    else if (count > 1) reasons.push(`duplicate-origin-certificate:${origin}`);
  }

  const window = options.freshnessWindowUs ?? FRESHNESS_WINDOW_US;
  if (options.healthy) {
    for (const certificate of attempt.certificates) {
      for (const id of certificate.ids) {
        if (!covered.has(id)) {
          missing.add(id);
          reasons.push('certificate-id-not-covered');
        }
      }
      if (certificate.cutUs < attempt.deliveryUs - window) {
        expiredOrigins.push(certificate.origin);
        reasons.push('expired-freshness-evidence');
      }
    }
  } else {
    for (const certificate of attempt.certificates) {
      for (const id of certificate.ids) {
        if (!covered.has(id)) missing.add(id);
      }
    }
  }

  const state = applyOperations(operations, attempt.coveredIds).state;
  const quantityBySku: Record<string, number> = {};
  for (const [sku, materialized] of Object.entries(state)) {
    quantityBySku[sku] = materialized.quantity;
  }

  const outgoingTokenIds = sortedIds([...attempt.tokenIds, ...attempt.coveredIds]);
  let status: ReadAudit['status'] = 'ok';
  if (reasons.includes('expired-freshness-evidence')) {
    status = 'temporarily-unavailable';
  } else if (reasons.length > 0) {
    status = 'incomplete';
  }

  return {
    status,
    reasons: sortedIds(reasons),
    missingIds: sortedIds(missing),
    expiredOrigins: sortedIds(expiredOrigins) as Region[],
    quantityBySku,
    outgoingTokenIds,
  };
}

export interface BasketLine {
  sku: string;
  quantity: number;
}

export interface BasketBinding {
  orderKey: string;
  cartId: string;
  lines: BasketLine[];
  digest: string;
}

export interface LedgerRow {
  binding: BasketBinding;
  outcome: 'committed' | 'out-of-stock';
}

export interface OrderRecord {
  orderKey: string;
  lines: BasketLine[];
}

export interface InventoryState {
  stock: Record<string, number>;
  ledger: LedgerRow[];
  orders: OrderRecord[];
}

export interface CheckoutRequest {
  orderKey: string;
  cartId: string;
  lines: BasketLine[];
  /** operation ids that the validated complete read covered */
  coveredIds: string[];
  /** session token the read carried */
  tokenIds: string[];
}

export interface CheckoutEvidence {
  digest: string;
  lines: BasketLine[];
  coveredIds: string[];
  tokenIds: string[];
}

export type CheckoutOutcome =
  | 'committed'
  | 'out-of-stock'
  | 'idempotency-conflict'
  | 'validation-failed'
  | 'unavailable';

export interface CheckoutResult {
  outcome: CheckoutOutcome;
  duplicate: boolean;
  next: InventoryState;
}

export function canonicalLines(lines: readonly BasketLine[]): BasketLine[] {
  return [...lines]
    .map((line) => ({ sku: line.sku, quantity: line.quantity }))
    .sort((left, right) => (left.sku < right.sku ? -1 : left.sku > right.sku ? 1 : 0));
}

/** SHA-256 of canonical {cartId, coveredIds, lines}, per B4. */
export function basketDigest(
  cartId: string,
  coveredIds: readonly string[],
  lines: readonly BasketLine[],
): string {
  const canonical = JSON.stringify({
    cartId,
    coveredIds: [...coveredIds].sort(),
    lines: canonicalLines(lines).map(({ quantity, sku }) => ({ quantity, sku })),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function bindingFor(request: CheckoutRequest): BasketBinding {
  const lines = canonicalLines(request.lines);
  return {
    orderKey: request.orderKey,
    cartId: request.cartId,
    lines,
    digest: basketDigest(request.cartId, request.coveredIds, lines),
  };
}

function sameBinding(left: BasketBinding, right: BasketBinding): boolean {
  return (
    left.orderKey === right.orderKey &&
    left.cartId === right.cartId &&
    left.digest === right.digest &&
    JSON.stringify(left.lines) === JSON.stringify(right.lines)
  );
}

/** Validation that happens before any ledger or stock mutation. */
export function validateBasket(lines: readonly BasketLine[]): string[] {
  const issues: string[] = [];
  if (lines.length === 0) issues.push('empty-basket');
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.sku)) issues.push(`duplicate-sku:${line.sku}`);
    seen.add(line.sku);
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      issues.push(`non-positive-quantity:${line.sku}`);
    }
  }
  return issues;
}

/**
 * Strict Inventory transaction: ledger lookup first, then an all-or-nothing
 * stock check and atomic commit. Pure: never mutates the incoming state.
 */
export function checkout(
  state: InventoryState,
  request: CheckoutRequest,
  options: { ledgerReachable: boolean; evidence?: CheckoutEvidence },
): CheckoutResult {
  if (!options.ledgerReachable) {
    return { outcome: 'unavailable', duplicate: false, next: state };
  }

  const issues = validateBasket(request.lines);
  const binding = bindingFor(request);
  const existing = state.ledger.find((row) => row.binding.orderKey === request.orderKey);
  if (existing) {
    if (!sameBinding(existing.binding, binding)) {
      return { outcome: 'idempotency-conflict', duplicate: false, next: state };
    }
    return { outcome: existing.outcome, duplicate: true, next: state };
  }

  if (issues.length > 0) {
    return { outcome: 'validation-failed', duplicate: false, next: state };
  }

  const evidence = options.evidence;
  if (!evidence) {
    return { outcome: 'validation-failed', duplicate: false, next: state };
  }
  const covered = new Set(evidence.coveredIds);
  const coversToken = evidence.tokenIds.every((id) => covered.has(id));
  if (
    evidence.digest !== binding.digest ||
    JSON.stringify(canonicalLines(evidence.lines)) !== JSON.stringify(binding.lines) ||
    !coversToken
  ) {
    return { outcome: 'validation-failed', duplicate: false, next: state };
  }

  const stock = { ...state.stock };
  for (const line of binding.lines) {
    const available = stock[line.sku] ?? 0;
    if (available < line.quantity) {
      const ledgerRow: LedgerRow = { binding, outcome: 'out-of-stock' };
      return {
        outcome: 'out-of-stock',
        duplicate: false,
        next: { ...state, ledger: [...state.ledger, ledgerRow] },
      };
    }
  }
  for (const line of binding.lines) {
    stock[line.sku] = (stock[line.sku] ?? 0) - line.quantity;
  }
  const ledgerRow: LedgerRow = { binding, outcome: 'committed' };
  return {
    outcome: 'committed',
    duplicate: false,
    next: {
      stock,
      ledger: [...state.ledger, ledgerRow],
      orders: [...state.orders, { orderKey: request.orderKey, lines: binding.lines }],
    },
  };
}

/** remaining + committed == initial for every SKU in the run. */
export function inventoryConserved(
  initial: Readonly<Record<string, number>>,
  state: InventoryState,
): { conserved: boolean; violations: string[] } {
  const violations: string[] = [];
  const committed = new Map<string, number>();
  for (const order of state.orders) {
    for (const line of order.lines) {
      committed.set(line.sku, (committed.get(line.sku) ?? 0) + line.quantity);
    }
  }
  for (const [sku, start] of Object.entries(initial)) {
    const remaining = state.stock[sku] ?? 0;
    const total = remaining + (committed.get(sku) ?? 0);
    if (total !== start) violations.push(`${sku}:${remaining}+${committed.get(sku) ?? 0}!=${start}`);
    if (remaining < 0) violations.push(`${sku}:negative-stock`);
  }
  return { conserved: violations.length === 0, violations };
}

export function reduceQuantity(operations: readonly Operation[], order: readonly string[]) {
  return applyOperations(operations, order);
}
