/**
 * GC-007 focused tests for the production cart operation algebra.
 *
 * The literal expectations below come from the frozen fixture
 * `tests/fixtures/cart/oracle/cart-algebra.json`, which was hand-written for the
 * GC-004 independent oracle. Production code never imports those fixtures; this
 * test cross-checks production output against the independent examples, then
 * re-runs each history under every delivery permutation and with duplicated
 * deliveries.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { CartRegion } from '../contracts';
import {
  CART_ADD_QUANTITY_MAX,
  CART_CHANGE_TARGET_MAX,
  cartOperationFingerprint,
  cartOperationId,
  cartUnitId,
  cartUnitIds,
  cartUnitNamespace,
  compareCartUnitIds,
  expandCartOperation,
  expandCartOperations,
  parseCartUnitId,
  sortCartUnitIds,
  validateCartOperationEffect,
  validateCartOperationEnvelope,
  type CartOperation,
  type CartOperationEnvelope,
  type CartOperationKey,
} from '../core/operations';
import {
  acceptCartOperation,
  cartViewQuantity,
  createCartOperationLog,
  materializeCartView,
  type CartAcceptStatus,
  type CartMaterializedView,
  type CartOperationLog,
} from '../core/cart-state';

// ---------------------------------------------------------------------------
// Fixtures (read-only)
// ---------------------------------------------------------------------------

interface FixtureOperation {
  id: string;
  key: { originRegion: CartRegion; clientId: string; requestSequence: number };
  kind: 'add' | 'change' | 'remove';
  quantity: number | null;
  observedContext: string[];
  commitAtUs: number;
}

interface FixtureExpectation {
  live: string[];
  quantity: number;
  buffered?: string[];
  conflicts?: string[];
  duplicates?: string[];
  missingDependencies?: Record<string, string[]>;
}

interface FixtureHistory {
  id: string;
  cartId: string;
  sku: string;
  operations: FixtureOperation[];
  expectedEffects: Record<
    string,
    { adds: string[]; tombstones: string[]; status?: 'derived' | 'missing-dependency' }
  >;
  deliveryOrders: string[][];
  expectations: FixtureExpectation[];
}

interface AlgebraFixture {
  contract: string;
  fixtureVersion: number;
  histories: FixtureHistory[];
}

const algebra = JSON.parse(
  readFileSync(resolve(process.cwd(), 'tests/fixtures/cart/oracle/cart-algebra.json'), 'utf8'),
) as AlgebraFixture;

interface HistoryIndex {
  history: FixtureHistory;
  /** Fixture-local operation ids are aliases for cart operation ids. */
  operationIdByFixtureId: Map<string, string>;
  envelopeByFixtureId: Map<string, CartOperationEnvelope>;
}

function indexHistory(history: FixtureHistory): HistoryIndex {
  const operationIdByFixtureId = new Map<string, string>();
  for (const operation of history.operations) {
    operationIdByFixtureId.set(operation.id, cartOperationId(operation.key));
  }
  const envelopeByFixtureId = new Map<string, CartOperationEnvelope>();
  for (const operation of history.operations) {
    envelopeByFixtureId.set(operation.id, {
      cartId: history.cartId,
      key: { ...operation.key },
      payload: { sku: history.sku, kind: operation.kind, quantity: operation.quantity },
      observedContext: operation.observedContext.map(
        (fixtureId) => operationIdByFixtureId.get(fixtureId) ?? fixtureId,
      ),
    });
  }
  return { history, operationIdByFixtureId, envelopeByFixtureId };
}

const histories = algebra.histories.map(indexHistory);

function uniqueEnvelopes(index: HistoryIndex): CartOperationEnvelope[] {
  const seen = new Map<string, CartOperationEnvelope>();
  for (const envelope of index.envelopeByFixtureId.values()) {
    const operationId = cartOperationId(envelope.key);
    if (!seen.has(operationId)) seen.set(operationId, envelope);
  }
  return [...seen.values()];
}

function envelopeById(index: HistoryIndex): Map<string, CartOperationEnvelope> {
  return new Map(
    uniqueEnvelopes(index).map((envelope) => [cartOperationId(envelope.key), envelope]),
  );
}

/** Environment for expanding one fixture variant when a key has two payloads. */
function variantTable(
  index: HistoryIndex,
  targetFixtureId: string,
): Map<string, CartOperationEnvelope> {
  const table = new Map<string, CartOperationEnvelope>();
  const target = index.envelopeByFixtureId.get(targetFixtureId);
  if (target !== undefined) table.set(cartOperationId(target.key), target);
  for (const [fixtureId, envelope] of index.envelopeByFixtureId) {
    if (fixtureId === targetFixtureId) continue;
    const operationId = cartOperationId(envelope.key);
    if (!table.has(operationId)) table.set(operationId, envelope);
  }
  return table;
}

function deliver(
  index: HistoryIndex,
  deliveryOrder: readonly string[],
): { log: CartOperationLog; statuses: CartAcceptStatus[] } {
  let log = createCartOperationLog(index.history.cartId);
  const statuses: CartAcceptStatus[] = [];
  for (const fixtureId of deliveryOrder) {
    const envelope = index.envelopeByFixtureId.get(fixtureId);
    if (envelope === undefined) throw new Error(`unknown fixture operation ${fixtureId}`);
    const result = acceptCartOperation(log, envelope);
    log = result.log;
    statuses.push(result.status);
  }
  return { log, statuses };
}

function mappedIds(index: HistoryIndex, fixtureIds: readonly string[] | undefined): string[] {
  return [
    ...new Set((fixtureIds ?? []).map((fixtureId) => index.operationIdByFixtureId.get(fixtureId) ?? fixtureId)),
  ].sort();
}

/**
 * The independent fixture names units by key only. Production unit ids carry
 * the cart namespace from `(cartId, key, unitIndex)`, so scope each expected
 * fixture unit id by the history's declared cart id before comparing.
 */
function canonicalUnits(cartId: string, unitIds: readonly string[]): string[] {
  const namespace = cartUnitNamespace(cartId);
  return unitIds.map((unitId) => `${namespace}/${unitId}`);
}

function expectFixtureExpectation(
  index: HistoryIndex,
  view: CartMaterializedView,
  expectation: FixtureExpectation,
): void {
  const skuState = view.skus[index.history.sku];
  expect(skuState?.live ?? []).toEqual(canonicalUnits(index.history.cartId, expectation.live));
  expect(skuState?.quantity ?? 0).toBe(expectation.quantity);
  expect(view.duplicates).toEqual(mappedIds(index, expectation.duplicates));
  expect(view.conflicts).toEqual(mappedIds(index, expectation.conflicts));
  expect(view.bufferedIds).toEqual(mappedIds(index, expectation.buffered));

  const expectedMissing: Record<string, readonly string[]> = {};
  for (const [fixtureId, dependencies] of Object.entries(expectation.missingDependencies ?? {})) {
    expectedMissing[index.operationIdByFixtureId.get(fixtureId) ?? fixtureId] = dependencies;
  }
  expect(view.missingDependencies).toEqual(expectedMissing);
}

// ---------------------------------------------------------------------------
// Helpers for hand-built histories
// ---------------------------------------------------------------------------

function key(clientId: string, requestSequence = 1, region: CartRegion = 'us-west'): CartOperationKey {
  return { originRegion: region, clientId, requestSequence };
}

function edit(
  cartId: string,
  operationKey: CartOperationKey,
  sku: string,
  kind: 'add' | 'change' | 'remove',
  quantity: number | null,
  observedContext: readonly string[] = [],
): CartOperationEnvelope {
  return { cartId, key: operationKey, payload: { sku, kind, quantity }, observedContext };
}

function runEnvelopes(
  cartId: string,
  envelopes: readonly CartOperationEnvelope[],
): { log: CartOperationLog; statuses: CartAcceptStatus[] } {
  let log = createCartOperationLog(cartId);
  const statuses: CartAcceptStatus[] = [];
  for (const envelope of envelopes) {
    const result = acceptCartOperation(log, envelope);
    log = result.log;
    statuses.push(result.status);
  }
  return { log, statuses };
}

function skuView(view: CartMaterializedView, sku: string): { live: string[]; quantity: number } {
  const state = view.skus[sku];
  return { live: [...(state?.live ?? [])], quantity: state?.quantity ?? 0 };
}

// ---------------------------------------------------------------------------
// Independent fixture examples
// ---------------------------------------------------------------------------

describe('cart operation algebra vs independent fixture examples', () => {
  for (const index of histories) {
    it(`${index.history.id}: derives each operation effect from its observed context`, () => {
      for (const operation of index.history.operations) {
        const envelope = index.envelopeByFixtureId.get(operation.id) as CartOperationEnvelope;
        const expected = index.history.expectedEffects[operation.id];
        expect(expected, `fixture expectation for ${operation.id}`).toBeDefined();
        if (expected === undefined) continue;

        const expansion = expandCartOperation(envelope, variantTable(index, operation.id));
        if (expected.status === 'missing-dependency') {
          expect(expansion.status).toBe('missing-dependency');
          expect(expected.adds).toEqual([]);
          expect(expected.tombstones).toEqual([]);
          if (expansion.status === 'missing-dependency') {
            expect([...expansion.missing]).toEqual(['op-missing']);
          }
          continue;
        }
        expect(expansion.status).toBe('expanded');
        if (expansion.status !== 'expanded') continue;
        expect([...expansion.effect.adds]).toEqual(
          canonicalUnits(index.history.cartId, expected.adds),
        );
        expect([...expansion.effect.tombstones]).toEqual(
          canonicalUnits(index.history.cartId, expected.tombstones),
        );
      }
    });

    it(`${index.history.id}: materializes the fixture expectation for every declared delivery order`, () => {
      expect(index.history.deliveryOrders.length).toBe(index.history.expectations.length);
      index.history.deliveryOrders.forEach((deliveryOrder, position) => {
        const expectation = index.history.expectations[position];
        expect(expectation).toBeDefined();
        if (expectation === undefined) return;
        const { log } = deliver(index, deliveryOrder);
        const view = materializeCartView(log);
        expectFixtureExpectation(index, view, expectation);
        expect(view.complete).toBe(view.bufferedIds.length === 0 && view.cyclicIds.length === 0);
        expect(view.cartId).toBe(index.history.cartId);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Permutation and duplication invariance
// ---------------------------------------------------------------------------

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const result: T[][] = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) result.push([item, ...tail]);
  });
  return result;
}

describe('arbitrary delivery permutation and duplication', () => {
  const permutable = histories.filter((index) => index.history.id !== 'conflicting-id');

  for (const index of permutable) {
    it(`${index.history.id}: every delivery permutation produces the same exact view`, () => {
      const canonicalOrder = index.history.deliveryOrders[0];
      if (canonicalOrder === undefined) throw new Error('fixture needs a delivery order');
      const canonical = materializeCartView(deliver(index, canonicalOrder).log);

      for (const permutation of permutations(uniqueEnvelopes(index))) {
        const view = materializeCartView(runEnvelopes(index.history.cartId, permutation).log);
        expect(view.skus).toEqual(canonical.skus);
        expect(view.effects).toEqual(canonical.effects);
        expect(view.complete).toBe(canonical.complete);
      }
    });

    it(`${index.history.id}: duplicating every delivery leaves the cart unchanged`, () => {
      const canonicalOrder = index.history.deliveryOrders[0];
      if (canonicalOrder === undefined) throw new Error('fixture needs a delivery order');
      const canonical = materializeCartView(deliver(index, canonicalOrder).log);
      const duplicated = [...canonicalOrder, ...[...canonicalOrder].reverse(), ...canonicalOrder];
      const { log, statuses } = deliver(index, duplicated);
      const view = materializeCartView(log);
      expect(view.skus).toEqual(canonical.skus);
      expect(view.effects).toEqual(canonical.effects);
      expect(statuses.filter((status) => status === 'duplicate').length).toBe(
        duplicated.length - new Set(duplicated.map((id) => index.operationIdByFixtureId.get(id))).size,
      );
      expect(view.complete).toBe(canonical.complete);
    });
  }

  it('conflicting-id: the first delivered payload binds, in all six orders', () => {
    const index = histories.find((candidate) => candidate.history.id === 'conflicting-id');
    if (index === undefined) throw new Error('missing fixture history');
    const conflict = index.envelopeByFixtureId.get('op-b-conflict') as CartOperationEnvelope;
    const original = index.envelopeByFixtureId.get('op-b') as CartOperationEnvelope;

    for (const permutation of permutations([original, conflict])) {
      // Keep op-a first so the two same-key variants are the only decision.
      const { log } = deliver(index, ['op-a', ...permutation.map((envelope) => (envelope === conflict ? 'op-b-conflict' : 'op-b'))]);
      const view = materializeCartView(log);
      const winner = cartOperationFingerprint(permutation[0] ?? conflict);
      if (winner === cartOperationFingerprint(original)) {
        expect(skuView(view, index.history.sku)).toEqual({
          live: canonicalUnits(index.history.cartId, [
            'us-west/c1/1#0',
            'us-west/c1/1#1',
            'us-west/c2/1#0',
          ]),
          quantity: 3,
        });
        expect(view.conflicts).toEqual([cartOperationId(conflict.key)]);
      } else {
        expect(skuView(view, index.history.sku)).toEqual({
          live: canonicalUnits(index.history.cartId, [
            'us-west/c1/1#0',
            'us-west/c1/1#1',
            'us-west/c2/1#0',
            'us-west/c2/1#1',
          ]),
          quantity: 4,
        });
        expect(view.conflicts).toEqual([cartOperationId(original.key)]);
      }
    }
  });

  it('a delivery list built in reverse map insertion order yields identical expansion', () => {
    for (const index of histories) {
      const forward = expandCartOperations(envelopeById(index));
      const reversed = new Map([...envelopeById(index)].reverse());
      const backward = expandCartOperations(reversed);
      expect(backward.bufferedIds).toEqual(forward.bufferedIds);
      expect(backward.cyclicIds).toEqual(forward.cyclicIds);
      expect([...backward.expansions.entries()]).toEqual([...forward.expansions.entries()]);
    }
  });
});

// ---------------------------------------------------------------------------
// Observed-context semantics, tombstones and quantity
// ---------------------------------------------------------------------------

describe('observed-unit cart operations', () => {
  const cartId = 'cart-observed-unit';
  const sku = 'sku-1';
  const base = edit(cartId, key('c1'), sku, 'add', 2);
  const unseen = edit(cartId, key('c2'), sku, 'add', 1, [cartOperationId(key('c1'))]);
  const change = edit(cartId, key('c3'), sku, 'change', 1, [cartOperationId(key('c1'))]);

  it('quantity changes use the declared observed context, not receiver state', () => {
    const environment = new Map([
      [cartOperationId(base.key), base],
      [cartOperationId(unseen.key), unseen],
    ]);
    const expansion = expandCartOperation(change, environment);
    expect(expansion.status).toBe('expanded');
    if (expansion.status !== 'expanded') return;
    expect([...expansion.liveInObservedContext]).toEqual([
      'cart-observed-unit/us-west/c1/1#0',
      'cart-observed-unit/us-west/c1/1#1',
    ]);
    expect([...expansion.effect.tombstones]).toEqual(['cart-observed-unit/us-west/c1/1#0']);
    expect([...expansion.effect.adds]).toEqual([]);

    const first = materializeCartView(runEnvelopes(cartId, [base, unseen, change]).log);
    const second = materializeCartView(runEnvelopes(cartId, [change, base, unseen]).log);
    expect(skuView(first, sku)).toEqual({
      live: [
        'cart-observed-unit/us-west/c1/1#1',
        'cart-observed-unit/us-west/c2/1#0',
      ],
      quantity: 2,
    });
    expect(skuView(second, sku)).toEqual(skuView(first, sku));
  });

  it('a tombstone arriving before its addition prevents resurrection', () => {
    const remove = edit(cartId, key('c2'), sku, 'remove', null, [cartOperationId(base.key)]);

    const early = materializeCartView(runEnvelopes(cartId, [remove]).log);
    expect(early.complete).toBe(false);
    expect(early.bufferedIds).toEqual([cartOperationId(remove.key)]);
    expect(early.missingDependencies[cartOperationId(remove.key)]).toEqual([
      cartOperationId(base.key),
    ]);
    expect(skuView(early, sku)).toEqual({ live: [], quantity: 0 });

    const complete = materializeCartView(runEnvelopes(cartId, [remove, base]).log);
    expect(complete.complete).toBe(true);
    expect(skuView(complete, sku)).toEqual({ live: [], quantity: 0 });
    expect([...(complete.effects[cartOperationId(remove.key)]?.tombstones ?? [])]).toEqual([
      'cart-observed-unit/us-west/c1/1#0',
      'cart-observed-unit/us-west/c1/1#1',
    ]);
  });

  it('a fresh re-add that observed the removal is legitimate', () => {
    const remove = edit(cartId, key('c2'), sku, 'remove', null, [cartOperationId(base.key)]);
    const readd = edit(cartId, key('c2', 2), sku, 'add', 1, [cartOperationId(remove.key)]);
    const view = materializeCartView(runEnvelopes(cartId, [readd, remove, base]).log);
    expect(view.complete).toBe(true);
    expect(skuView(view, sku)).toEqual({
      live: ['cart-observed-unit/us-west/c2/2#0'],
      quantity: 1,
    });
  });

  it('merged quantities are never silently clamped', () => {
    const first = edit(cartId, key('c1'), sku, 'change', CART_CHANGE_TARGET_MAX);
    const second = edit(cartId, key('c2'), sku, 'change', CART_CHANGE_TARGET_MAX);
    const view = materializeCartView(runEnvelopes(cartId, [second, first]).log);
    expect(view.complete).toBe(true);
    expect(skuView(view, sku).quantity).toBe(CART_CHANGE_TARGET_MAX * 2);
    expect(skuView(view, sku).live).toHaveLength(CART_CHANGE_TARGET_MAX * 2);
    expect(view.skus[sku]?.quantity).toBe(40);
  });

  it('remove tombstones only the units declared in its observed context', () => {
    const addWest = edit(cartId, key('c1'), sku, 'add', 2);
    const addOtherWest = edit(cartId, key('c2'), sku, 'add', 1, [cartOperationId(addWest.key)]);
    const addEast = edit(cartId, key('c3', 1, 'eu-central'), sku, 'add', 1, [
      cartOperationId(addWest.key),
    ]);
    const remove = edit(cartId, key('c4'), sku, 'remove', null, [
      cartOperationId(addWest.key),
      cartOperationId(addOtherWest.key),
      cartOperationId(addEast.key),
    ]);
    const expansion = expandCartOperation(remove, new Map([
      [cartOperationId(addWest.key), addWest],
      [cartOperationId(addOtherWest.key), addOtherWest],
      [cartOperationId(addEast.key), addEast],
    ]));
    expect(expansion.status).toBe('expanded');
    if (expansion.status !== 'expanded') return;
    expect([...expansion.effect.tombstones]).toEqual([
      'cart-observed-unit/us-west/c1/1#0',
      'cart-observed-unit/us-west/c1/1#1',
      'cart-observed-unit/us-west/c2/1#0',
      'cart-observed-unit/eu-central/c3/1#0',
    ]);

    const withNewAdd = edit(cartId, key('c5'), sku, 'add', 1, [cartOperationId(addWest.key)]);
    const view = materializeCartView(
      runEnvelopes(cartId, [addWest, addOtherWest, addEast, remove, withNewAdd]).log,
    );
    expect(skuView(view, sku)).toEqual({
      live: ['cart-observed-unit/us-west/c5/1#0'],
      quantity: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Deterministic unit ordering
// ---------------------------------------------------------------------------

describe('deterministic ascending unit order', () => {
  it('orders by cart id, region ordinal, client id, numeric sequence, unit index', () => {
    const ordered = sortCartUnitIds([
      'cart-order/eu-central/c0/1#0',
      'cart-order/us-west/c2/1#0',
      'cart-order/us-west/c1/10#0',
      'cart-order/us-west/c1/2#1',
      'cart-order/us-west/c1/2#0',
      'cart-order/us-west/c1/10#1',
    ]);
    expect(ordered).toEqual([
      'cart-order/us-west/c1/2#0',
      'cart-order/us-west/c1/2#1',
      'cart-order/us-west/c1/10#0',
      'cart-order/us-west/c1/10#1',
      'cart-order/us-west/c2/1#0',
      'cart-order/eu-central/c0/1#0',
    ]);
    expect(compareCartUnitIds('cart-order/us-west/c1/2#0', 'cart-order/us-west/c1/10#0')).toBeLessThan(0);
    expect(compareCartUnitIds('cart-order/us-west/c1/2#0', 'cart-order/us-west/c1/2#0')).toBe(0);
    expect(compareCartUnitIds('cart-order/us-west/c9/1#0', 'cart-order/eu-central/c1/1#0')).toBeLessThan(0);
    expect(compareCartUnitIds('cart-a/us-west/c1/1#0', 'cart-b/us-west/c1/1#0')).toBeLessThan(0);
  });

  it('namespaces unit ids by cart id so identical keys never alias', () => {
    const sharedKey = key('c1');
    const first = cartUnitId('cart-a', sharedKey, 0);
    const second = cartUnitId('cart-b', sharedKey, 0);
    expect(first).toBe('cart-a/us-west/c1/1#0');
    expect(second).toBe('cart-b/us-west/c1/1#0');
    expect(first).not.toBe(second);
    expect(parseCartUnitId(first)).toEqual({
      cartId: 'cart-a',
      originRegion: 'us-west',
      regionOrdinal: 0,
      clientId: 'c1',
      requestSequence: 1,
      unitIndex: 0,
    });
    expect(parseCartUnitId(second)?.cartId).toBe('cart-b');
    expect(cartUnitId('cart-a', sharedKey, 0)).toBe(first);

    // Delimiters inside a cart id cannot leak into the key segments.
    const odd = cartUnitId('cart/with#odd id', sharedKey, 1);
    expect(parseCartUnitId(odd)?.cartId).toBe('cart/with#odd id');
    expect(parseCartUnitId(odd)?.unitIndex).toBe(1);

    // Same key in separate carts: equal quantities, disjoint unit identities.
    const cartA = materializeCartView(
      runEnvelopes('cart-a', [edit('cart-a', sharedKey, 'sku-1', 'add', 2)]).log,
    );
    const cartB = materializeCartView(
      runEnvelopes('cart-b', [edit('cart-b', sharedKey, 'sku-1', 'add', 2)]).log,
    );
    expect(cartViewQuantity(cartA, 'sku-1')).toBe(2);
    expect(cartViewQuantity(cartB, 'sku-1')).toBe(2);
    expect(cartA.skus['sku-1']?.live).toEqual([
      'cart-a/us-west/c1/1#0',
      'cart-a/us-west/c1/1#1',
    ]);
    expect(cartB.skus['sku-1']?.live).toEqual([
      'cart-b/us-west/c1/1#0',
      'cart-b/us-west/c1/1#1',
    ]);

    // A declared effect may not borrow unit ids from another cart's namespace.
    const foreignAdd = edit('cart-b', sharedKey, 'sku-1', 'add', 1);
    const environment = new Map([[cartOperationId(foreignAdd.key), foreignAdd]]);
    const derived = expandCartOperation(foreignAdd, environment);
    expect(derived.status).toBe('expanded');
    const tampered = {
      ...foreignAdd,
      effect: { adds: cartUnitIds('cart-a', sharedKey, 1), tombstones: [] },
    };
    expect(
      validateCartOperationEffect(tampered, environment).map((issue) => issue.code),
    ).toEqual(['effect-adds-mismatch']);
  });

  it('parses malformed unit ids as null and sorts them last', () => {
    expect(parseCartUnitId('not-a-unit')).toBeNull();
    expect(parseCartUnitId('cart-order/mars/c1/1#0')).toBeNull();
    expect(parseCartUnitId('cart-order/us-west/c1/x#0')).toBeNull();
    expect(parseCartUnitId('cart-order/us-west/c1/1#-1')).toBeNull();
    const ordered = sortCartUnitIds(['zzz', 'cart-order/us-west/c1/1#0']);
    expect(ordered).toEqual(['cart-order/us-west/c1/1#0', 'zzz']);
  });

  it('a quantity reduction removes the lowest observed units, not the newest arrival', () => {
    const cartId = 'cart-order';
    const west = edit(cartId, key('c1'), 'sku-1', 'add', 2);
    const otherWest = edit(cartId, key('c2'), 'sku-1', 'add', 1, [cartOperationId(west.key)]);
    const east = edit(cartId, key('c3', 1, 'eu-central'), 'sku-1', 'add', 1, [
      cartOperationId(west.key),
    ]);
    const change = edit(cartId, key('c4'), 'sku-1', 'change', 2, [
      cartOperationId(west.key),
      cartOperationId(otherWest.key),
      cartOperationId(east.key),
    ]);
    const view = materializeCartView(runEnvelopes(cartId, [east, otherWest, change, west]).log);
    expect([...(view.effects[cartOperationId(change.key)]?.tombstones ?? [])]).toEqual([
      'cart-order/us-west/c1/1#0',
      'cart-order/us-west/c1/1#1',
    ]);
    expect(skuView(view, 'sku-1')).toEqual({
      live: ['cart-order/us-west/c2/1#0', 'cart-order/eu-central/c3/1#0'],
      quantity: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// Retry identity, validation and charged work
// ---------------------------------------------------------------------------

describe('retry identity and effect validation', () => {
  const cartId = 'cart-retry';
  const base = edit(cartId, key('c1'), 'sku-1', 'add', 2);

  it('accepts, deduplicates and rejects conflicting payloads without mutation', () => {
    const first = acceptCartOperation(createCartOperationLog(cartId), base);
    expect(first.status).toBe('accepted');
    expect(first.log.envelopes.size).toBe(1);

    const duplicate = acceptCartOperation(first.log, edit(cartId, key('c1'), 'sku-1', 'add', 2));
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.log.envelopes.size).toBe(1);

    const conflict = acceptCartOperation(first.log, edit(cartId, key('c1'), 'sku-1', 'add', 3));
    expect(conflict.status).toBe('conflict');
    expect(conflict.log.envelopes.size).toBe(1);
    expect(materializeCartView(conflict.log).skus['sku-1']?.live).toEqual([
      'cart-retry/us-west/c1/1#0',
      'cart-retry/us-west/c1/1#1',
    ]);

    const foreign = acceptCartOperation(first.log, edit('other-cart', key('c1'), 'sku-1', 'add', 2));
    expect(foreign.status).toBe('cart-mismatch');
    expect(foreign.log).toBe(first.log);
  });

  it('treats context ordering as non-semantic for retry identity', () => {
    const left = edit(cartId, key('c2'), 'sku-1', 'add', 1, ['op-x', 'op-y']);
    const right = edit(cartId, key('c2'), 'sku-1', 'add', 1, ['op-y', 'op-x']);
    expect(cartOperationFingerprint(left)).toBe(cartOperationFingerprint(right));
  });

  it('validates derived effects and rejects tampered envelopes', () => {
    const expansion = expandCartOperation(base, new Map([[cartOperationId(base.key), base]]));
    expect(expansion.status).toBe('expanded');
    if (expansion.status !== 'expanded') return;
    const sealed: CartOperation = { ...base, effect: expansion.effect };
    expect(validateCartOperationEffect(sealed, new Map())).toEqual([]);

    const missingAdd = {
      ...sealed,
      effect: { adds: sealed.effect.adds.slice(1), tombstones: [] },
    };
    expect(validateCartOperationEffect(missingAdd, new Map()).map((issue) => issue.code)).toEqual([
      'effect-adds-mismatch',
    ]);

    const bogusTombstone = {
      ...sealed,
      effect: { adds: sealed.effect.adds, tombstones: [cartUnitId(base.cartId, base.key, 9)] },
    };
    expect(
      validateCartOperationEffect(bogusTombstone, new Map()).map((issue) => issue.code),
    ).toEqual(['effect-tombstones-mismatch']);

    const unverifiable = edit(cartId, key('c2'), 'sku-1', 'change', 1, ['op-missing']);
    const unverifiableExpansion = expandCartOperation(unverifiable, new Map());
    expect(unverifiableExpansion.status).toBe('missing-dependency');
    expect(
      validateCartOperationEffect({ ...unverifiable, effect: { adds: [], tombstones: [] } }, new Map())
        .map((issue) => issue.code),
    ).toEqual(['effect-unverifiable']);
  });

  it('rejects malformed payloads and self-referential contexts', () => {
    const tooMany = edit(cartId, key('c1'), 'sku-1', 'add', CART_ADD_QUANTITY_MAX + 1);
    expect(validateCartOperationEnvelope(tooMany).map((issue) => issue.code)).toEqual([
      'payload-invalid-quantity',
    ]);

    const tooLargeTarget = edit(cartId, key('c1'), 'sku-1', 'change', CART_CHANGE_TARGET_MAX + 1);
    expect(validateCartOperationEnvelope(tooLargeTarget).map((issue) => issue.code)).toEqual([
      'payload-invalid-quantity',
    ]);

    const removeWithQuantity = edit(cartId, key('c1'), 'sku-1', 'remove', 3);
    expect(validateCartOperationEnvelope(removeWithQuantity).map((issue) => issue.code)).toEqual([
      'payload-invalid-quantity',
    ]);

    const selfReference = edit(cartId, key('c1'), 'sku-1', 'add', 1, [cartOperationId(key('c1'))]);
    expect(validateCartOperationEnvelope(selfReference).map((issue) => issue.code)).toContain(
      'context-self-reference',
    );

    expect(validateCartOperationEnvelope(base)).toEqual([]);
  });

  it('rejects causal cycles and never materializes them', () => {
    const left = edit(cartId, key('c1'), 'sku-1', 'add', 1, [cartOperationId(key('c2'))]);
    const right = edit(cartId, key('c2'), 'sku-1', 'add', 1, [cartOperationId(key('c1'))]);
    const expansion = expandCartOperation(left, new Map([
      [cartOperationId(left.key), left],
      [cartOperationId(right.key), right],
    ]));
    expect(expansion.status).toBe('causal-cycle');

    const view = materializeCartView(runEnvelopes(cartId, [left, right]).log);
    expect(view.complete).toBe(false);
    expect(view.cyclicIds).toEqual([cartOperationId(left.key), cartOperationId(right.key)]);
    expect(skuView(view, 'sku-1')).toEqual({ live: [], quantity: 0 });
  });

  it('describes the charged work of the union merge exactly', () => {
    const addTwo = edit(cartId, key('c1'), 'sku-1', 'add', 2);
    const addOne = edit(cartId, key('c2'), 'sku-1', 'add', 1, [cartOperationId(addTwo.key)]);
    const addAnother = edit(cartId, key('c3'), 'sku-1', 'add', 1, [cartOperationId(addTwo.key)]);
    const added = materializeCartView(runEnvelopes(cartId, [addTwo, addOne, addAnother]).log);
    expect(added.work).toEqual({
      operationsApplied: 3,
      unitsAdded: 4,
      tombstonesAdded: 0,
      uniqueUnits: 4,
      uniqueTombstones: 0,
      liveUnits: 4,
      encodedUnitBytes: 4 * 32,
      encodedTombstoneBytes: 0,
      cpuMilliseconds: 0.04,
    });

    const remove = edit(cartId, key('c4'), 'sku-1', 'remove', null, [cartOperationId(addTwo.key)]);
    const removed = materializeCartView(runEnvelopes(cartId, [addTwo, remove]).log);
    expect(removed.work).toEqual({
      operationsApplied: 2,
      unitsAdded: 2,
      tombstonesAdded: 2,
      uniqueUnits: 2,
      uniqueTombstones: 2,
      liveUnits: 0,
      encodedUnitBytes: 64,
      encodedTombstoneBytes: 48,
      cpuMilliseconds: 0.04,
    });
    expect(cartViewQuantity(removed, 'sku-1')).toBe(0);
    expect(cartViewQuantity(removed, 'sku-missing')).toBe(0);
  });

  it('expands a unit range without mutating the declared envelope', () => {
    const units = cartUnitIds('cart-range', key('c1'), 2);
    expect(units).toEqual(['cart-range/us-west/c1/1#0', 'cart-range/us-west/c1/1#1']);
    expect(() => cartUnitIds('cart-range', key('c1'), -1)).toThrow(RangeError);

    const snapshot = JSON.stringify(base);
    expandCartOperations(new Map([[cartOperationId(base.key), base]]));
    materializeCartView(runEnvelopes(cartId, [base]).log);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});
