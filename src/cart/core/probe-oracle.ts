/**
 * Post-execution per-probe oracle audit (GC-011R6).
 *
 * Every scheduled frozen probe declares its expected terminal result on
 * `CartProbe.expected` (mirrored from immutable `fixtures.json`). Production
 * execution never reads that field: the oracle runs *after* the deterministic
 * case has finished and compares the retained actual evidence with the frozen
 * expectation. It cannot inject state, choose service paths or alter responses.
 *
 * The denominator is the scheduled probe expansion, never a success-only set:
 * a probe with an unexecuted step, a dependency-failed terminal or a wrong
 * result still yields one audited result and one mandatory gate.
 *
 * CONTRACT B3 makes one explicit allowance: an incident-affected/backlog
 * cohort may answer with an acknowledged explicit TemporarilyUnavailable
 * instead of a complete correct result. That allowance is cohort-scoped to the
 * frozen incident records and never applies to healthy, local-context or
 * dedicated-probe cohorts.
 */
import type { CartCaseId, CartGate, CartRegion } from '../contracts';
import type { CartProbe, CartProbeExpectation, CartProbeStep } from './challenges';
import type { CartRequestRecord } from './model';
import type { CartReadComplete } from './reads';
import type { CartInventoryOrder } from './inventory';

/** Retained post-execution evidence the oracle is allowed to observe. */
export interface CartProbeOracleEvidence {
  readonly records: readonly CartRequestRecord[];
  /** Complete read results keyed by their read step id. */
  readonly reads: ReadonlyMap<string, CartReadComplete>;
  /** Inventory stock snapshot after the case finished. */
  readonly stock: Readonly<Record<string, number>>;
  /** Durable Inventory orders after the case finished. */
  readonly orders: readonly CartInventoryOrder[];
  /** Post-execution materialized live quantity of one probe cart. */
  readonly cartQuantity: (cartId: string) => number;
}

export interface CartProbeOracleResult {
  readonly probeId: string;
  readonly caseId: CartCaseId;
  readonly family: CartProbe['family'];
  readonly region: CartRegion;
  readonly expectedKind: CartProbeExpectation['kind'];
  readonly pass: boolean;
  /** Machine-readable reason: `ok` or the first unmet expectation. */
  readonly reason: string;
  readonly evidenceIds: readonly string[];
}

export interface CartProbeOracleReport {
  /** Scheduled probe expansion; the audit never shrinks this denominator. */
  readonly scheduled: number;
  /** One audited result for every scheduled probe. */
  readonly audited: number;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly CartProbeOracleResult[];
  readonly gates: readonly CartGate[];
}

interface Audit {
  readonly pass: boolean;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
}

function ok(evidenceIds: readonly string[] = []): Audit {
  return { pass: true, reason: 'ok', evidenceIds };
}

function fail(reason: string, evidenceIds: readonly string[] = []): Audit {
  return { pass: false, reason, evidenceIds };
}

function recordById(evidence: CartProbeOracleEvidence, id: string): CartRequestRecord | undefined {
  return evidence.records.find((record) => record.id === id);
}

function isIncident(record: CartRequestRecord): boolean {
  return (
    record.exempt ||
    record.cohort === 'incident-affected' ||
    record.cohort === 'incident-backlog'
  );
}

/**
 * B3's explicit-unavailable terminal is admissible only for records the
 * evaluator classified into a frozen incident cohort, and only when the
 * response actually reached the client. A timeout, partial-view claim,
 * healthy rejection or unclassified record is not.
 */
function isAdmissibleUnavailable(record: CartRequestRecord): boolean {
  if (!record.acknowledged || record.outcome !== 'unavailable') return false;
  return isIncident(record);
}

function liveQuantity(view: CartReadComplete['view']): number {
  let total = 0;
  for (const state of Object.values(view.skus)) total += state.quantity;
  return total;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

/**
 * Reads that carry the frozen observation. A read declares its role through
 * `expectedQuantity`/`expectedLive`; unlabeled reads (recovery-style) fall
 * back to the probe's final read.
 */
function readObservationSteps(probe: CartProbe, expected: { readonly quantity: number }): CartProbeStep[] {
  const reads = probe.steps.filter((step) => step.action === 'read');
  if (reads.length === 0) return [];
  const declaring = reads.filter((step) => {
    const quantity = step.detail.expectedQuantity;
    const live = step.detail.expectedLive;
    if (typeof quantity === 'number' && quantity === expected.quantity) return true;
    if (Array.isArray(live) && live.length === expected.quantity) return true;
    return false;
  });
  if (declaring.length > 0) return declaring;
  const implicit = reads.filter(
    (step) =>
      typeof step.detail.expectedQuantity !== 'number' && !Array.isArray(step.detail.expectedLive),
  );
  const last = implicit[implicit.length - 1] ?? reads[reads.length - 1];
  return last === undefined ? [] : [last];
}

function terminalCheckoutStep(probe: CartProbe): CartProbeStep | undefined {
  const steps = probe.steps.filter((step) => step.action === 'checkout' || step.action === 'replay');
  return steps[steps.length - 1];
}

function probeOrders(probe: CartProbe, evidence: CartProbeOracleEvidence): CartInventoryOrder[] {
  const cartIds = new Set<string>();
  for (const step of probe.steps) {
    const record = recordById(evidence, step.id);
    if (record !== undefined) cartIds.add(record.cartId);
  }
  return evidence.orders.filter((order) => cartIds.has(order.cartId));
}

/**
 * Frozen request identity of one checkout/replay step: the durable Inventory
 * order key the probe's binding must carry. The key is derived from the probe
 * id and the step's scheduled position, and an explicit replay reuses the
 * original checkout step's key so it can never masquerade as a second request.
 * Auditing this post-execution means a successful attempt cannot satisfy the
 * oracle with another attempt's (or another probe's) durable row.
 */
function expectedProbeOrderKey(probe: CartProbe, step: CartProbeStep): string {
  let index = probe.steps.indexOf(step);
  if (step.action === 'replay') {
    const originalRef = step.detail.original;
    const original =
      typeof originalRef === 'string'
        ? probe.steps.find((candidate) => candidate.id === originalRef)
        : undefined;
    if (original !== undefined) index = probe.steps.indexOf(original);
  }
  return `probe#${probe.id.slice(0, 40)}#${index}`.slice(0, 64);
}

/** One successful checkout attempt bound to the scheduled step that produced it. */
interface FrozenAttemptSuccess {
  readonly step: CartProbeStep;
  readonly record: CartRequestRecord;
}

/**
 * Binds every successful attempt to its own durable probe order. The checkout
 * record's first evidence id is the Inventory binding orderKey, so it must be
 * the frozen step identity, a durable row for this probe's cart, and every
 * durable order row must be claimed exactly once. This distinguishes real
 * settlement from fabricated-but-distinct keys sitting next to valid orders.
 */
function auditCheckoutOrderBinding(
  probe: CartProbe,
  successes: readonly FrozenAttemptSuccess[],
  orders: readonly CartInventoryOrder[],
): Audit {
  const durable = new Map<string, CartInventoryOrder>();
  for (const order of orders) {
    if (durable.has(order.orderKey)) {
      return fail('order-key-not-distinct', [`duplicate:${order.orderKey}`.slice(0, 64)]);
    }
    durable.set(order.orderKey, order);
  }
  const claimed = new Set<string>();
  for (const { step, record } of successes) {
    const key = record.evidenceIds[0];
    if (key === undefined || key.length === 0) return fail('checkout-key-missing', [record.id]);
    const expected = expectedProbeOrderKey(probe, step);
    if (key !== expected) {
      return fail('checkout-order-identity', [record.id, `key:${key}`, `expected:${expected}`]);
    }
    if (claimed.has(key)) return fail('checkout-key-not-distinct', [record.id, `key:${key}`]);
    const order = durable.get(key);
    if (order === undefined) {
      return fail('checkout-order-identity', [record.id, `unbound:${key}`]);
    }
    if (order.cartId !== record.cartId) {
      return fail('checkout-order-identity', [record.id, `cart:${order.cartId}`, `record:${record.cartId}`]);
    }
    claimed.add(key);
  }
  for (const key of durable.keys()) {
    if (!claimed.has(key)) return fail('checkout-order-identity', [`unclaimed:${key}`]);
  }
  return ok([...claimed]);
}

/** Actual SKUs the probe touches, from frozen step declarations and real orders. */
function probeSkus(probe: CartProbe, orders: readonly CartInventoryOrder[]): string[] {
  const skus = new Set<string>();
  for (const step of probe.steps) {
    const direct = step.detail.sku;
    if (typeof direct === 'string') skus.add(direct);
    const scarce = step.detail.scarceSku;
    if (typeof scarce === 'string') skus.add(scarce);
    const abundant = step.detail.abundantSku;
    if (typeof abundant === 'string') skus.add(abundant);
    const list = step.detail.skus;
    if (Array.isArray(list)) {
      for (const entry of list) if (typeof entry === 'string') skus.add(entry);
    }
  }
  for (const order of orders) {
    for (const line of order.lines) skus.add(line.sku);
  }
  return [...skus];
}

/**
 * Maps a frozen fixture key (e.g. atomic's `scarce`, or partition's literal
 * `sku` placeholder) onto the concrete SKU the probe actually used. An exact
 * stock key wins; otherwise a unique suffix or the probe's only SKU resolves.
 */
function resolveStockKey(
  key: string,
  probe: CartProbe,
  orders: readonly CartInventoryOrder[],
  stock: Readonly<Record<string, number>>,
): string | null {
  if (Object.prototype.hasOwnProperty.call(stock, key)) return key;
  const skus = probeSkus(probe, orders);
  const suffix = skus.filter((sku) => sku.endsWith(`/${key}`) || sku.endsWith(`:${key}`));
  if (suffix.length === 1) return suffix[0] ?? null;
  if (skus.length === 1) return skus[0] ?? null;
  return null;
}

/** Declared starting stock for the probe's own SKU (frozen step detail). */
function declaredInitialStock(probe: CartProbe): number | null {
  for (const step of probe.steps) {
    if (step.action !== 'checkout') continue;
    const known = step.detail.knownStock;
    if (typeof known === 'number') return known;
    const stock = step.detail.stock;
    if (typeof stock === 'number') return stock;
  }
  return null;
}

function orderedQuantity(orders: readonly CartInventoryOrder[], sku: string): number {
  let total = 0;
  for (const order of orders) {
    for (const line of order.lines) if (line.sku === sku) total += line.quantity;
  }
  return total;
}

/**
 * Checks the frozen post-state for every declared SKU. A literal key is an
 * isolated namespace and must match exactly. A placeholder key (e.g.
 * partition's `sku`) names the probe's own SKU whose stock is shared with peer
 * probes in the same case: the frozen value is that probe's own post-purchase
 * level (`declaredInitial - ownOrderedQuantity`), and the retained stock plus
 * every committed order on that SKU must still conserve the declared initial.
 * This distinguishes "wrong expected outcome" from "another probe also bought
 * the same scarce item".
 */
function checkStock(
  probe: CartProbe,
  expectedAfter: Readonly<Record<string, number>>,
  ownOrders: readonly CartInventoryOrder[],
  allOrders: readonly CartInventoryOrder[],
  stock: Readonly<Record<string, number>>,
): string | null {
  for (const [key, expected] of Object.entries(expectedAfter)) {
    const literal = Object.prototype.hasOwnProperty.call(stock, key);
    const actualKey = resolveStockKey(key, probe, ownOrders, stock);
    if (actualKey === null) return `stock-key-unresolved:${key}`;
    const actual = stock[actualKey];
    if (actual === undefined) return `stock-missing:${actualKey}`;
    if (literal) {
      if (actual !== expected) return `stock:${key}=${actual}!=${expected}`;
      continue;
    }
    const initial = declaredInitialStock(probe);
    if (initial === null) return `stock-baseline-missing:${key}`;
    const own = orderedQuantity(ownOrders, actualKey);
    if (initial - own !== expected) return `stock-placeholder:${key}=${expected}!=${initial}-${own}`;
    const total = orderedQuantity(allOrders, actualKey);
    if (actual + total !== initial) {
      return `stock-conservation:${actualKey}=${actual}+${total}!=${initial}`;
    }
  }
  return null;
}

function auditCompleteRead(
  probe: CartProbe,
  expected: Extract<CartProbeExpectation, { kind: 'complete-read' }>,
  evidence: CartProbeOracleEvidence,
): Audit {
  const observations = readObservationSteps(probe, expected);
  if (observations.length === 0) {
    // Boundary probes declare a complete-read quantity but script only the
    // isolation edit. Audit the committed edit plus the real live cart state.
    const edit = [...probe.steps].reverse().find((step) => step.action === 'add' || step.action === 'edit');
    if (edit === undefined) return fail('no-observation-step');
    const record = recordById(evidence, edit.id);
    if (record === undefined) return fail('missing-record', [edit.id]);
    if (record.dependencyFailed) return fail('dependency-failed', [record.id]);
    if (!record.acknowledged || !record.committed) {
      return fail('edit-not-terminal', [record.id, `outcome:${record.outcome}`]);
    }
    const quantity = evidence.cartQuantity(record.cartId);
    if (quantity !== expected.quantity) {
      return fail('live-quantity', [`expected:${expected.quantity}`, `actual:${quantity}`]);
    }
    return ok([record.id]);
  }

  const evidenceIds: string[] = [];
  for (const step of observations) {
    const record = recordById(evidence, step.id);
    if (record === undefined) return fail('missing-read', [step.id]);
    if (record.dependencyFailed) return fail('dependency-failed', [record.id]);
    if (!record.acknowledged) return fail('read-not-delivered', [record.id, `outcome:${record.outcome}`]);
    const complete = evidence.reads.get(step.id);
    if (complete === undefined) {
      if (isAdmissibleUnavailable(record)) {
        evidenceIds.push(record.id, 'unavailable-admissible');
        continue;
      }
      return fail('read-not-complete', [record.id, `outcome:${record.outcome}`]);
    }
    if (!complete.view.complete) return fail('view-incomplete', [step.id]);
    if (!sameIds(complete.coveredIds, complete.view.appliedIds)) {
      return fail('coverage-gap', [
        step.id,
        `covered:${complete.coveredIds.length}`,
        `applied:${complete.view.appliedIds.length}`,
      ]);
    }
    const quantity = liveQuantity(complete.view);
    if (quantity !== expected.quantity) {
      return fail('live-quantity', [step.id, `expected:${expected.quantity}`, `actual:${quantity}`]);
    }
    evidenceIds.push(step.id);
  }
  return ok(evidenceIds);
}

function auditCheckoutSuccess(
  probe: CartProbe,
  expected: Extract<CartProbeExpectation, { kind: 'checkout-success' }>,
  evidence: CartProbeOracleEvidence,
): Audit {
  const step = terminalCheckoutStep(probe);
  if (step === undefined) return fail('no-terminal-step');
  const record = recordById(evidence, step.id);
  if (record === undefined) return fail('missing-record', [step.id]);
  if (record.dependencyFailed) return fail('dependency-failed', [record.id]);

  // Explicit replay must re-deliver the original durable result: the original
  // order has to exist and the replayed binding must be the same order key, so
  // a replay can never fabricate a second order or a fresh success.
  const replayStep = probe.steps.find((entry) => entry.action === 'replay');
  if (replayStep !== undefined) {
    const purchases = probe.steps.filter((entry) => entry.action === 'checkout');
    const originalStep = purchases[purchases.length - 1];
    if (originalStep === undefined) return fail('replay-without-original', [replayStep.id]);
    const original = recordById(evidence, originalStep.id);
    if (original === undefined) return fail('missing-record', [originalStep.id]);
    if (original.dependencyFailed) return fail('dependency-failed', [original.id]);
    if (!original.committed) {
      return fail('replay-without-original', [original.id, `outcome:${original.outcome}`]);
    }
    const originalKey = original.evidenceIds[0];
    const replayKey = record.evidenceIds[0];
    if (originalKey === undefined || replayKey === undefined || originalKey !== replayKey) {
      return fail('replay-identity', [original.id, record.id]);
    }
  }

  if (!record.acknowledged) return fail('not-delivered', [record.id, `outcome:${record.outcome}`]);
  if (isAdmissibleUnavailable(record)) {
    return ok([record.id, 'unavailable-admissible']);
  }
  if (record.outcome !== 'committed' && record.outcome !== 'duplicate-commit') {
    return fail('wrong-outcome', [record.id, `outcome:${record.outcome}`]);
  }
  const orders = probeOrders(probe, evidence);
  if (orders.length !== expected.orders) {
    return fail('orders', [`expected:${expected.orders}`, `actual:${orders.length}`]);
  }
  // The delivered success must be the probe's own durable order: the record's
  // binding key is bound to the frozen step identity and to the order row.
  // For an explicit replay this also pins the replayed key to the original row.
  const binding = auditCheckoutOrderBinding(probe, [{ step, record }], orders);
  if (!binding.pass) return binding;
  const stockFailure = checkStock(probe, expected.stockAfter, orders, evidence.orders, evidence.stock);
  if (stockFailure !== null) return fail(stockFailure, [record.id]);
  if (expected.cartQuantity !== undefined) {
    const actual = evidence.cartQuantity(record.cartId);
    if (actual !== expected.cartQuantity) {
      return fail('cart-quantity', [`expected:${expected.cartQuantity}`, `actual:${actual}`]);
    }
  }
  return ok([record.id]);
}

/**
 * Frozen attempt-level outcome distribution for the two admissible-stock-set
 * families. `CartProbe.expected` names the admissible final stock set because
 * the regional winner is free, but immutable `input/fixtures.json` also fixes
 * how many simultaneous attempts may succeed:
 *
 * - checkout.race: "Any two distinct keys succeed, one OutOfStock by1000ms.
 *   Final scarce=0; exactly2 orders. Do not assume regional winner."
 * - checkout.atomic: "exactly1 success,1 OutOfStock, loser decrements neither".
 *
 * Aggregate order count plus final stock does not imply that distribution
 * (three committed replies can still leave two durable orders), so the
 * per-attempt outcomes are audited here. Any other family carrying this
 * expectation shape has no frozen distribution and must fail rather than pass
 * unaudited.
 */
interface FrozenCheckoutOutcomes {
  readonly successes: number;
  readonly outOfStock: number;
}

const FROZEN_CHECKOUT_OUTCOMES: Readonly<
  Partial<Record<CartProbe['family'], FrozenCheckoutOutcomes>>
> = {
  'checkout-race': { successes: 2, outOfStock: 1 },
  'checkout-atomic': { successes: 1, outOfStock: 1 },
};

function isCheckoutSuccess(record: CartRequestRecord): boolean {
  return record.outcome === 'committed' || record.outcome === 'duplicate-commit';
}

/**
 * Audits the frozen per-attempt checkout outcomes and retargets the successful
 * attempts (step + terminal record) so the caller can bind each one to its own
 * durable order row.
 */
interface CheckoutAttemptAudit extends Audit {
  readonly successes: readonly FrozenAttemptSuccess[];
}

function attemptFail(reason: string, evidenceIds: readonly string[] = []): CheckoutAttemptAudit {
  return { pass: false, reason, evidenceIds, successes: [] };
}

function auditCheckoutAttemptDistribution(
  probe: CartProbe,
  checkouts: readonly CartProbeStep[],
  evidence: CartProbeOracleEvidence,
): CheckoutAttemptAudit {
  const frozen = FROZEN_CHECKOUT_OUTCOMES[probe.family];
  if (frozen === undefined) return attemptFail('outcome-distribution-unfrozen', [probe.family]);
  const expectedAttempts = frozen.successes + frozen.outOfStock;
  if (checkouts.length !== expectedAttempts) {
    return attemptFail('outcome-cardinality-frozen', [
      `scheduled:${checkouts.length}`,
      `frozen:${expectedAttempts}`,
    ]);
  }

  const successes: FrozenAttemptSuccess[] = [];
  const outOfStock: CartRequestRecord[] = [];
  for (const step of checkouts) {
    const record = recordById(evidence, step.id);
    if (record === undefined) return attemptFail('missing-record', [step.id]);
    if (record.dependencyFailed) return attemptFail('dependency-failed', [record.id]);
    if (!record.acknowledged) {
      return attemptFail('not-delivered', [record.id, `outcome:${record.outcome}`]);
    }
    if (isCheckoutSuccess(record)) {
      if (!record.committed) return attemptFail('not-committed', [record.id]);
      successes.push({ step, record });
      continue;
    }
    if (record.outcome === 'out-of-stock') {
      outOfStock.push(record);
      continue;
    }
    return attemptFail('wrong-outcome', [record.id, `outcome:${record.outcome}`]);
  }

  if (successes.length !== frozen.successes) {
    return attemptFail('checkout-outcomes', [
      `success:${successes.length}!=${frozen.successes}`,
      ...successes.map(({ record }) => record.id),
    ]);
  }
  if (outOfStock.length !== frozen.outOfStock) {
    return attemptFail('checkout-outcomes', [
      `out-of-stock:${outOfStock.length}!=${frozen.outOfStock}`,
      ...outOfStock.map((record) => record.id),
    ]);
  }

  const successKeys = successes.map(({ record }) => record.evidenceIds[0]);
  if (successKeys.some((key) => key === undefined || key.length === 0)) {
    return attemptFail('checkout-key-missing', successes.map(({ record }) => record.id));
  }
  if (new Set(successKeys).size !== successKeys.length) {
    return attemptFail('checkout-key-not-distinct', [
      ...successes.map(({ record }) => record.id),
      ...successKeys.map((key) => `key:${key}`),
    ]);
  }
  return {
    pass: true,
    reason: 'ok',
    evidenceIds: successKeys.map((key) => key ?? ''),
    successes,
  };
}

function auditAdmissibleStockSet(
  probe: CartProbe,
  expected: Extract<CartProbeExpectation, { kind: 'admissible-stock-set' }>,
  evidence: CartProbeOracleEvidence,
): Audit {
  const checkouts = probe.steps.filter((step) => step.action === 'checkout' || step.action === 'replay');
  if (checkouts.length === 0) return fail('no-terminal-step');
  const attempts = auditCheckoutAttemptDistribution(probe, checkouts, evidence);
  if (!attempts.pass) return attempts;

  const orders = probeOrders(probe, evidence);
  if (orders.length !== expected.orders) {
    return fail('orders', [`expected:${expected.orders}`, `actual:${orders.length}`]);
  }
  // Each successful attempt must own its durable order row: fabricated or
  // swapped keys, cross-probe keys and unclaimed rows all fail here.
  const binding = auditCheckoutOrderBinding(probe, attempts.successes, orders);
  if (!binding.pass) return binding;
  const failures: string[] = [];
  for (const alternative of expected.alternatives) {
    const failure = checkStock(probe, alternative, orders, evidence.orders, evidence.stock);
    if (failure === null) return ok(checkouts.map((step) => step.id));
    failures.push(failure);
  }
  return fail('stock-set', failures.slice(0, 3));
}

function auditOutOfStock(
  probe: CartProbe,
  expected: Extract<CartProbeExpectation, { kind: 'out-of-stock' }>,
  evidence: CartProbeOracleEvidence,
): Audit {
  const step = terminalCheckoutStep(probe);
  if (step === undefined) return fail('no-terminal-step');
  const record = recordById(evidence, step.id);
  if (record === undefined) return fail('missing-record', [step.id]);
  if (record.dependencyFailed) return fail('dependency-failed', [record.id]);
  if (!record.acknowledged || record.outcome !== 'out-of-stock') {
    return fail('wrong-outcome', [record.id, `outcome:${record.outcome}`]);
  }
  const orders = probeOrders(probe, evidence);
  if (orders.length !== 0) return fail('orders', [`expected:0`, `actual:${orders.length}`]);
  const stockFailure = checkStock(probe, expected.stockAfter, orders, evidence.orders, evidence.stock);
  if (stockFailure !== null) return fail(stockFailure, [record.id]);
  return ok([record.id]);
}

function auditUnavailable(
  probe: CartProbe,
  expected: Extract<CartProbeExpectation, { kind: 'unavailable' }>,
  evidence: CartProbeOracleEvidence,
): Audit {
  const step = terminalCheckoutStep(probe);
  if (step === undefined) return fail('no-terminal-step');
  const record = recordById(evidence, step.id);
  if (record === undefined) return fail('missing-record', [step.id]);
  if (record.dependencyFailed) return fail('dependency-failed', [record.id]);
  if (!record.acknowledged || record.outcome !== 'unavailable') {
    return fail('wrong-outcome', [record.id, `outcome:${record.outcome}`]);
  }
  const orders = probeOrders(probe, evidence);
  if (orders.length !== 0) return fail('orders', [`expected:0`, `actual:${orders.length}`]);
  if (expected.stockAfter !== undefined) {
    const stockFailure = checkStock(probe, expected.stockAfter, orders, evidence.orders, evidence.stock);
    if (stockFailure !== null) return fail(stockFailure, [record.id]);
  }
  return ok([record.id]);
}

function auditConflict(
  probe: CartProbe,
  expected: Extract<CartProbeExpectation, { kind: 'conflict' }>,
  evidence: CartProbeOracleEvidence,
): Audit {
  const step = terminalCheckoutStep(probe);
  if (step === undefined) return fail('no-terminal-step');
  const record = recordById(evidence, step.id);
  if (record === undefined) return fail('missing-record', [step.id]);
  if (record.dependencyFailed) return fail('dependency-failed', [record.id]);
  if (!record.acknowledged || record.outcome !== 'conflict') {
    return fail('wrong-outcome', [record.id, `outcome:${record.outcome}`]);
  }
  const orders = probeOrders(probe, evidence);
  if (orders.length !== expected.orders) {
    return fail('orders', [`expected:${expected.orders}`, `actual:${orders.length}`]);
  }
  return ok([record.id]);
}

function auditValidationFailed(
  probe: CartProbe,
  expected: Extract<CartProbeExpectation, { kind: 'validation-failed' }>,
  evidence: CartProbeOracleEvidence,
): Audit {
  const step = terminalCheckoutStep(probe);
  if (step === undefined) return fail('no-terminal-step');
  const record = recordById(evidence, step.id);
  if (record === undefined) return fail('missing-record', [step.id]);
  if (record.dependencyFailed) return fail('dependency-failed', [record.id]);
  if (!record.acknowledged || record.outcome !== 'validation-failed') {
    return fail('wrong-outcome', [record.id, `outcome:${record.outcome}`]);
  }
  const orders = probeOrders(probe, evidence);
  if (orders.length !== expected.orders) {
    return fail('orders', [`expected:${expected.orders}`, `actual:${orders.length}`]);
  }
  return ok([record.id]);
}

/** Audits one frozen probe against its declared expectation. */
export function auditCartProbe(probe: CartProbe, evidence: CartProbeOracleEvidence): CartProbeOracleResult {
  const missing = probe.steps.filter((step) => recordById(evidence, step.id) === undefined);
  let audit: Audit;
  if (missing.length > 0) {
    audit = fail('unexecuted-step', missing.map((step) => step.id));
  } else {
    const expected = probe.expected;
    switch (expected.kind) {
      case 'complete-read':
        audit = auditCompleteRead(probe, expected, evidence);
        break;
      case 'checkout-success':
        audit = auditCheckoutSuccess(probe, expected, evidence);
        break;
      case 'admissible-stock-set':
        audit = auditAdmissibleStockSet(probe, expected, evidence);
        break;
      case 'out-of-stock':
        audit = auditOutOfStock(probe, expected, evidence);
        break;
      case 'unavailable':
        audit = auditUnavailable(probe, expected, evidence);
        break;
      case 'conflict':
        audit = auditConflict(probe, expected, evidence);
        break;
      case 'validation-failed':
        audit = auditValidationFailed(probe, expected, evidence);
        break;
      default:
        audit = fail('unknown-expectation');
        break;
    }
  }
  return {
    probeId: probe.id,
    caseId: probe.caseId,
    family: probe.family,
    region: probe.region,
    expectedKind: probe.expected.kind,
    pass: audit.pass,
    reason: audit.reason,
    evidenceIds: audit.evidenceIds,
  };
}

function gateFor(result: CartProbeOracleResult): CartGate {
  return {
    code: `probe-oracle:${result.probeId}`.slice(0, 96),
    caseId: result.caseId,
    region: result.region,
    operation: 'probe',
    cohort: `probe-oracle:${result.family}`.slice(0, 120),
    observed: result.pass ? 1 : 0,
    limit: 1,
    pass: result.pass,
    evidenceIds: [result.reason, ...result.evidenceIds]
      .map((id) => id.slice(0, 64))
      .slice(0, 1_000),
  };
}

/**
 * Audits every scheduled probe and emits mandatory gates. Each probe is one
 * denominator unit; the report is never filtered by outcome.
 */
export function auditCartProbes(
  probes: readonly CartProbe[],
  evidence: CartProbeOracleEvidence,
): CartProbeOracleReport {
  const results = probes.map((probe) => auditCartProbe(probe, evidence));
  const passed = results.filter((result) => result.pass).length;
  const failed = results.length - passed;
  const gates: CartGate[] = results.map(gateFor);
  if (probes.length > 0) {
    const caseId = probes[0]?.caseId ?? 'peak';
    gates.push({
      code: 'probe-oracle-denominator',
      caseId,
      region: 'us-west',
      operation: 'audit',
      cohort: 'probe-oracle:denominator',
      observed: results.length,
      limit: probes.length,
      pass: results.length === probes.length,
      evidenceIds: results
        .filter((result) => !result.pass)
        .map((result) => result.probeId.slice(0, 60))
        .slice(0, 1_000),
    });
    gates.push({
      code: 'probe-oracle-pass',
      caseId,
      region: 'us-west',
      operation: 'audit',
      cohort: 'probe-oracle:mandatory',
      observed: passed,
      limit: probes.length,
      pass: passed === probes.length,
      evidenceIds: results
        .filter((result) => !result.pass)
        .map((result) => result.probeId.slice(0, 60))
        .slice(0, 1_000),
    });
  }
  return {
    scheduled: probes.length,
    audited: results.length,
    passed,
    failed,
    results,
    gates,
  };
}
