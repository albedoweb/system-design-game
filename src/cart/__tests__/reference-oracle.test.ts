/**
 * GC-004 independent oracle tests.
 *
 * These tests load literal expectations from tests/fixtures/cart/oracle/ and
 * compare them with src/cart/__tests__/reference-oracle.ts. Nothing here — and
 * nothing in the oracle module — imports the production cart reducer, session,
 * evaluator, registry, fixtures or protocols.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  applyOperations,
  auditRead,
  basketDigest,
  canonicalLines,
  checkout,
  deriveEffect,
  inventoryConserved,
  type BasketLine,
  type Certificate,
  type CheckoutEvidence,
  type CheckoutOutcome,
  type CheckoutRequest,
  type EditKind,
  type InventoryState,
  type Operation,
  type ReadAudit,
  type Region,
} from './reference-oracle';

const fixtureRoot = resolve(process.cwd(), 'tests/fixtures/cart/oracle');

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8')) as T;
}

interface OperationFields {
  id: string;
  key: { originRegion: Region; clientId: string; requestSequence: number };
  kind: EditKind;
  quantity: number | null;
  observedContext: string[];
  commitAtUs: number;
}

interface AlgebraExpectation {
  live: string[];
  quantity: number;
  buffered?: string[];
  conflicts?: string[];
  duplicates?: string[];
  missingDependencies?: Record<string, string[]>;
}

interface AlgebraHistory {
  id: string;
  cartId: string;
  sku: string;
  operations: OperationFields[];
  expectedEffects: Record<
    string,
    { adds: string[]; tombstones: string[]; status?: 'derived' | 'missing-dependency' }
  >;
  deliveryOrders: string[][];
  expectations: AlgebraExpectation[];
}

interface AlgebraFixture {
  contract: string;
  histories: AlgebraHistory[];
}

interface TokenCase {
  id: string;
  healthy: boolean;
  operations: OperationFields[];
  attempts: Array<{
    coveredIds: string[];
    tokenIds: string[];
    certificates: Certificate[];
    deliveryUs: number;
    servedFromCache: boolean;
  }>;
  expectations: Array<{
    status: ReadAudit['status'];
    quantityBySku: Record<string, number>;
    missingIds: string[];
    expiredOrigins: Region[];
    outgoingTokenIds: string[];
    reasons?: string[];
  }>;
}

interface TokenFixture {
  contract: string;
  freshnessWindowUs: number;
  configuredOrigins: Region[];
  cases: TokenCase[];
}

interface BasketRequest {
  orderKey: string;
  cartId: string;
  coveredIds: string[];
  tokenIds?: string[];
  lines: BasketLine[];
  expectedDigest?: string;
}

interface SequenceStep {
  label: string;
  request?: BasketRequest;
  noRequest?: boolean;
  evidenceMode?: 'self' | 'absent';
  ledgerReachable: boolean;
  cartReadPathAvailable?: boolean;
  replyDiscardedAfterCommit?: boolean;
  expectedOutcome?: CheckoutOutcome;
  expectedDuplicate?: boolean;
  expectedStockAfter?: Record<string, number>;
  expectedCartQuantity?: number;
}

interface CheckoutScenario {
  id: string;
  kind: 'permutations' | 'single' | 'sequence' | 'validation';
  initialStock: Record<string, number>;
  // permutations
  baskets?: BasketRequest[];
  permutations?: Array<{
    order: number[];
    outcomes: CheckoutOutcome[];
    finalStock: Record<string, number>;
    orderCount: number;
  }>;
  // single
  request?: BasketRequest;
  evidenceMode?: 'self' | 'absent';
  ledgerReachable?: boolean;
  expectedOutcome?: CheckoutOutcome;
  expectedOutcomes?: CheckoutOutcome[];
  forbiddenOutcomes?: CheckoutOutcome[];
  expectedFinalStock?: Record<string, number>;
  expectedOrderCount?: number;
  expectedLedgerRows?: number;
  // sequence
  steps?: SequenceStep[];
  // validation
  cases?: Array<{ label: string; lines: BasketLine[]; coveredIds: string[]; tokenIds: string[]; expectedOutcome: CheckoutOutcome }>;
  expectedFinal?: {
    stock: Record<string, number>;
    orders: number;
    ledgerRows: number;
    cartQuantity?: number;
  };
}

interface CheckoutFixture {
  contract: string;
  scenarios: CheckoutScenario[];
}

interface HoldoutFixture {
  contract: string;
  frozenAgainstRevision: string;
  existingNamedSeeds: { default: number; training: number[]; publicAdversarial: number[] };
  holdoutSeeds: number[];
  derivation: { indexes: number[]; rule: string };
}

const algebra = loadFixture<AlgebraFixture>('cart-algebra.json');
const tokens = loadFixture<TokenFixture>('token-coverage.json');
const checkoutTables = loadFixture<CheckoutFixture>('checkout-tables.json');
const holdouts = loadFixture<HoldoutFixture>('holdout-seeds.json');

const toOperations = (cartId: string, sku: string, fields: OperationFields[]): Operation[] =>
  fields.map((field) => ({ ...field, cartId, sku }));

const usWest = (clientId: string, requestSequence = 1): OperationFields['key'] => ({
  originRegion: 'us-west',
  clientId,
  requestSequence,
});

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function requestFrom(basket: BasketRequest): CheckoutRequest {
  return {
    orderKey: basket.orderKey,
    cartId: basket.cartId,
    lines: basket.lines,
    coveredIds: basket.coveredIds,
    tokenIds: basket.tokenIds ?? [],
  };
}

function evidenceFor(request: CheckoutRequest): CheckoutEvidence {
  return {
    digest: basketDigest(request.cartId, request.coveredIds, request.lines),
    lines: canonicalLines(request.lines),
    coveredIds: request.coveredIds,
    tokenIds: request.tokenIds,
  };
}

function initialState(stock: Record<string, number>): InventoryState {
  return { stock: { ...stock }, ledger: [], orders: [] };
}

function expectConservation(initial: Record<string, number>, state: InventoryState): void {
  const conservation = inventoryConserved(initial, state);
  expect(conservation.violations).toEqual([]);
  expect(conservation.conserved).toBe(true);
}

describe('GC-004 fixture inventory', () => {
  it('pins the candidate contract and unique fixture ids', () => {
    expect(algebra.contract).toBe('cart-protocol-v1');
    expect(tokens.contract).toBe('cart-protocol-v1');
    expect(checkoutTables.contract).toBe('cart-protocol-v1');
    expect(holdouts.contract).toBe('cart-protocol-v1');
    expect(new Set(algebra.histories.map((history) => history.id)).size).toBe(
      algebra.histories.length,
    );
    expect(new Set(tokens.cases.map((testCase) => testCase.id)).size).toBe(tokens.cases.length);
    expect(new Set(checkoutTables.scenarios.map((scenario) => scenario.id)).size).toBe(
      checkoutTables.scenarios.length,
    );
  });

  it('pins the three configured origins that each owe a read certificate', () => {
    expect(tokens.configuredOrigins).toEqual(['us-west', 'eu-central', 'ap-northeast']);
    const known = new Set(tokens.configuredOrigins);
    for (const testCase of tokens.cases) {
      for (const attempt of testCase.attempts) {
        for (const certificate of attempt.certificates) {
          expect(known.has(certificate.origin), certificate.origin).toBe(true);
        }
      }
    }
  });

  it('freezes holdout seeds before tuning and disjoint from named seeds', () => {
    const named = new Set([
      holdouts.existingNamedSeeds.default,
      ...holdouts.existingNamedSeeds.training,
      ...holdouts.existingNamedSeeds.publicAdversarial,
    ]);
    expect(holdouts.holdoutSeeds.length).toBe(6);
    expect(new Set(holdouts.holdoutSeeds).size).toBe(holdouts.holdoutSeeds.length);
    for (const seed of holdouts.holdoutSeeds) {
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThan(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
      expect(named.has(seed)).toBe(false);
    }
    // Reproduce the documented derivation instead of trusting the literal.
    const derived: number[] = [];
    let index = 1;
    while (derived.length < holdouts.holdoutSeeds.length) {
      const digest = createHash('sha256').update(`global-cart-v1/holdout/${index}`).digest();
      const value = digest.readUInt32BE(0);
      if (value !== 0 && !named.has(value) && !derived.includes(value)) derived.push(value);
      index += 1;
    }
    expect(derived).toEqual(holdouts.holdoutSeeds);
    expect(holdouts.frozenAgainstRevision).toBe('25dbbf544af33923f357ba2b5caf70743e58ce28');
  });

  it('does not import production cart logic', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/cart/__tests__/reference-oracle.ts'),
      'utf8',
    );
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    expect(imports).toEqual(['node:crypto']);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\bfrom\s+'\.\.?\//);
  });
});

describe('cart algebra fixtures', () => {
  for (const history of algebra.histories) {
    it(history.id, () => {
      const operations = toOperations(history.cartId, history.sku, history.operations);
      const byId = new Map(operations.map((operation) => [operation.id, operation]));

      for (const operation of history.operations) {
        const expected = history.expectedEffects[operation.id];
        expect(expected, `missing expected effect for ${operation.id}`).toBeDefined();
        const derived = deriveEffect(byId.get(operation.id) as Operation, byId);
        expect(derived.status, `${operation.id} dependency status`).toBe(
          expected?.status ?? 'derived',
        );
        expect({ adds: derived.effect.adds, tombstones: derived.effect.tombstones }).toEqual({
          adds: expected?.adds,
          tombstones: expected?.tombstones,
        });
      }

      expect(history.deliveryOrders.length).toBe(history.expectations.length);
      history.deliveryOrders.forEach((order, index) => {
        const expectation = history.expectations[index] as AlgebraExpectation;
        const result = applyOperations(operations, order);
        const materialized = result.state[history.sku];
        expect(materialized?.live ?? [], `${history.id} live for order ${index}`).toEqual(
          expectation.live,
        );
        expect(materialized?.quantity ?? 0, `${history.id} quantity for order ${index}`).toBe(
          expectation.quantity,
        );
        if (expectation.buffered) expect(result.bufferedIds).toEqual(expectation.buffered);
        if (expectation.conflicts) expect(result.conflicts).toEqual(expectation.conflicts);
        if (expectation.duplicates) expect(result.duplicates).toEqual(expectation.duplicates);
        if (expectation.missingDependencies) {
          expect(result.missingDependencies).toEqual(expectation.missingDependencies);
        }
        // Ordering may change which payload is rejected, never the union invariants.
        expect(materialized?.removed.length ?? 0).toBeLessThanOrEqual(
          new Set(materialized?.added ?? []).size,
        );
      });
    });
  }

  it('never resurrects removed units across every delivery permutation of the replay history', () => {
    const history = algebra.histories.find((entry) => entry.id === 'removed-old-add-replay');
    expect(history).toBeDefined();
    if (!history) return;
    const operations = toOperations(history.cartId, history.sku, history.operations);
    for (const order of history.deliveryOrders) {
      const result = applyOperations(operations, order);
      expect(result.state[history.sku]?.quantity ?? 0).toBe(0);
    }
  });
});

describe('token coverage fixtures', () => {
  for (const testCase of tokens.cases) {
    it(testCase.id, () => {
      const operations = toOperations(testCase.id, 'sku-1', testCase.operations);
      expect(testCase.attempts.length).toBe(testCase.expectations.length);
      testCase.attempts.forEach((attempt, index) => {
        const expected = testCase.expectations[index];
        const audit = auditRead(
          {
            cartId: testCase.id,
            tokenIds: attempt.tokenIds,
            coveredIds: attempt.coveredIds,
            certificates: attempt.certificates,
            deliveryUs: attempt.deliveryUs,
            servedFromCache: attempt.servedFromCache,
          },
          operations,
          {
            healthy: testCase.healthy,
            configuredOrigins: tokens.configuredOrigins,
            freshnessWindowUs: tokens.freshnessWindowUs,
          },
        );
        expect(audit.status).toBe(expected?.status);
        expect(audit.quantityBySku).toEqual(expected?.quantityBySku);
        expect(audit.missingIds).toEqual(expected?.missingIds);
        expect(audit.expiredOrigins).toEqual(expected?.expiredOrigins);
        expect(audit.outgoingTokenIds).toEqual(expected?.outgoingTokenIds);
        if (expected?.reasons) expect(audit.reasons).toEqual(expected.reasons);
        for (const tokenId of testCase.attempts[index]?.tokenIds ?? []) {
          expect(audit.outgoingTokenIds).toContain(tokenId);
        }
      });
    });
  }

  it('treats a cache hit as evidence-free until repaired', () => {
    const testCase = tokens.cases.find((entry) => entry.id === 'stale-populated-cache');
    expect(testCase).toBeDefined();
    if (!testCase) return;
    const operations = toOperations(testCase.id, 'sku-1', testCase.operations);
    const cacheAttempt = testCase.attempts[0];
    const repairedAttempt = testCase.attempts[1];
    expect(cacheAttempt).toBeDefined();
    expect(repairedAttempt).toBeDefined();
    if (!cacheAttempt || !repairedAttempt) return;
    const auditCache = auditRead(
      { ...cacheAttempt, cartId: testCase.id, servedFromCache: true },
      operations,
      {
        healthy: true,
        configuredOrigins: tokens.configuredOrigins,
        freshnessWindowUs: tokens.freshnessWindowUs,
      },
    );
    const auditRepaired = auditRead(
      { cartId: testCase.id, ...repairedAttempt, servedFromCache: false },
      operations,
      {
        healthy: true,
        configuredOrigins: tokens.configuredOrigins,
        freshnessWindowUs: tokens.freshnessWindowUs,
      },
    );
    expect(auditCache.status).toBe('incomplete');
    expect(auditCache.quantityBySku['sku-1']).toBe(2);
    expect(auditRepaired.status).toBe('ok');
    expect(auditRepaired.quantityBySku['sku-1']).toBe(3);
  });
});

describe('checkout tables', () => {
  it('binds B4 to literal recursively sorted JSON bytes, independent of input key order', () => {
    const bytes = '{"cartId":"cart-race-us-west","coveredIds":["op-race-us-west"],"lines":[{"quantity":1,"sku":"probe/race/20/race/scarce"}]}';
    const expected = '02bd5a56e91aa56fd2524bf299bd882176cb019c20bb9de109a1de482ba1355d';
    expect(createHash('sha256').update(bytes, 'utf8').digest('hex')).toBe(expected);
    for (const line of [
      { sku: 'probe/race/20/race/scarce', quantity: 1 },
      { quantity: 1, sku: 'probe/race/20/race/scarce' },
    ]) {
      expect(basketDigest('cart-race-us-west', ['op-race-us-west'], [line])).toBe(expected);
    }
  });

  for (const scenario of checkoutTables.scenarios) {
    it(scenario.id, () => {
      const initial = scenario.initialStock;
      const state = initialState(initial);

      if (scenario.kind === 'permutations') {
        expect(scenario.baskets).toBeDefined();
        expect(scenario.permutations).toBeDefined();
        for (const basket of scenario.baskets ?? []) {
          if (basket.expectedDigest) {
            expect(basketDigest(basket.cartId, basket.coveredIds, basket.lines)).toBe(
              basket.expectedDigest,
            );
          }
        }
        for (const permutation of scenario.permutations ?? []) {
          let run = initialState(initial);
          permutation.order.forEach((basketIndex, slot) => {
            const basket = (scenario.baskets ?? [])[basketIndex] as BasketRequest;
            const request = requestFrom(basket);
            const result = checkout(run, request, {
              ledgerReachable: true,
              evidence: evidenceFor(request),
            });
            expect(result.outcome, `${scenario.id} order ${permutation.order.join(',')}`).toBe(
              permutation.outcomes[slot],
            );
            const beforeStock = run.stock;
            if (result.outcome !== 'committed') {
              expect(result.next.stock).toEqual(beforeStock);
            }
            run = result.next;
          });
          expect(sortedRecord(run.stock)).toEqual(sortedRecord(permutation.finalStock));
          expect(run.orders.length).toBe(permutation.orderCount);
          expectConservation(initial, run);
        }
        return;
      }

      if (scenario.kind === 'single') {
        const basket = scenario.request as BasketRequest;
        const request = requestFrom(basket);
        if (basket.expectedDigest) {
          expect(basketDigest(basket.cartId, basket.coveredIds, basket.lines)).toBe(
            basket.expectedDigest,
          );
        }
        const result = checkout(state, request, {
          ledgerReachable: scenario.ledgerReachable ?? true,
          evidence: scenario.evidenceMode === 'self' ? evidenceFor(request) : undefined,
        });
        if (scenario.expectedOutcomes) {
          expect(scenario.expectedOutcomes).toContain(result.outcome);
        } else {
          expect(result.outcome).toBe(scenario.expectedOutcome);
        }
        for (const forbidden of scenario.forbiddenOutcomes ?? []) {
          expect(result.outcome).not.toBe(forbidden);
        }
        expect(sortedRecord(result.next.stock)).toEqual(
          sortedRecord(scenario.expectedFinalStock as Record<string, number>),
        );
        expect(result.next.orders.length).toBe(scenario.expectedOrderCount);
        expect(result.next.ledger.length).toBe(scenario.expectedLedgerRows);
        expectConservation(initial, result.next);
        return;
      }

      if (scenario.kind === 'sequence') {
        let run = state;
        let cartQuantity = 1;
        for (const step of scenario.steps ?? []) {
          if (step.noRequest) {
            if (step.expectedCartQuantity !== undefined) cartQuantity = step.expectedCartQuantity;
            if (step.expectedStockAfter) {
              expect(sortedRecord(run.stock)).toEqual(sortedRecord(step.expectedStockAfter));
            }
            continue;
          }
          const basket = step.request as BasketRequest;
          if (basket.expectedDigest) {
            expect(basketDigest(basket.cartId, basket.coveredIds, basket.lines)).toBe(
              basket.expectedDigest,
            );
          }
          const request = requestFrom(basket);
          const result = checkout(run, request, {
            ledgerReachable: step.ledgerReachable,
            evidence: step.evidenceMode === 'self' ? evidenceFor(request) : undefined,
          });
          expect(result.outcome, step.label).toBe(step.expectedOutcome);
          if (step.expectedDuplicate !== undefined) {
            expect(result.duplicate, step.label).toBe(step.expectedDuplicate);
          }
          if (step.replyDiscardedAfterCommit) {
            // The commit is durable even though the client never saw the reply.
            expect(result.outcome).toBe('committed');
            expect(result.next.orders.length).toBe(1);
          }
          if (step.expectedStockAfter) {
            expect(sortedRecord(result.next.stock)).toEqual(sortedRecord(step.expectedStockAfter));
          }
          run = result.next;
        }
        const finalExpectation = scenario.expectedFinal as NonNullable<
          CheckoutScenario['expectedFinal']
        >;
        expect(sortedRecord(run.stock)).toEqual(sortedRecord(finalExpectation.stock));
        expect(run.orders.length).toBe(finalExpectation.orders);
        expect(run.ledger.length).toBe(finalExpectation.ledgerRows);
        if (finalExpectation.cartQuantity !== undefined) {
          expect(cartQuantity).toBe(finalExpectation.cartQuantity);
        }
        expectConservation(initial, run);
        return;
      }

      // validation
      for (const validationCase of scenario.cases ?? []) {
        const request: CheckoutRequest = {
          orderKey: `order-${scenario.id}-${validationCase.label}`,
          cartId: `cart-${scenario.id}`,
          lines: validationCase.lines,
          coveredIds: validationCase.coveredIds,
          tokenIds: validationCase.tokenIds,
        };
        const result = checkout(state, request, {
          ledgerReachable: true,
          evidence: evidenceFor(request),
        });
        expect(result.outcome, validationCase.label).toBe(validationCase.expectedOutcome);
        expect(sortedRecord(result.next.stock)).toEqual(
          sortedRecord(scenario.expectedFinalStock as Record<string, number>),
        );
        expect(result.next.orders.length).toBe(0);
        expect(result.next.ledger.length).toBe(0);
        expectConservation(initial, result.next);
      }
    });
  }

  it('keeps the loser of the multi-SKU race from decrementing either line', () => {
    const scenario = checkoutTables.scenarios.find((entry) => entry.id === 'atomic');
    expect(scenario).toBeDefined();
    if (!scenario) return;
    for (const permutation of scenario.permutations ?? []) {
      let run = initialState(scenario.initialStock);
      permutation.order.forEach((basketIndex, slot) => {
        const basket = (scenario.baskets ?? [])[basketIndex] as BasketRequest;
        const request = requestFrom(basket);
        const result = checkout(run, request, {
          ledgerReachable: true,
          evidence: evidenceFor(request),
        });
        expect(result.outcome).toBe(permutation.outcomes[slot]);
        if (result.outcome === 'out-of-stock') {
          expect(result.next.stock).toEqual(run.stock);
          expect(result.next.orders).toEqual(run.orders);
        }
        run = result.next;
      });
    }
  });

  it('namespaces probe SKUs away from background shopping', () => {
    const skus: string[] = [];
    for (const scenario of checkoutTables.scenarios) {
      for (const basket of scenario.baskets ?? []) {
        skus.push(...basket.lines.map((line) => line.sku));
      }
      if (scenario.request) skus.push(...scenario.request.lines.map((line) => line.sku));
      for (const step of scenario.steps ?? []) {
        if (step.request) skus.push(...step.request.lines.map((line) => line.sku));
      }
      for (const testCase of scenario.cases ?? []) {
        skus.push(...testCase.lines.map((line) => line.sku));
      }
    }
    for (const sku of skus) {
      expect(sku.startsWith('probe/'), sku).toBe(true);
      expect(sku).not.toMatch(/^sku-\d+$/);
    }
  });
});

describe('hand-audited quantity oracles', () => {
  it('matches the seven spec quantity examples', () => {
    const a = usWest('c1', 1);
    const operations: Operation[] = [
      {
        id: 'base',
        cartId: 'cart-hand',
        key: a,
        sku: 'sku-1',
        kind: 'add',
        quantity: 2,
        observedContext: [],
        commitAtUs: 0,
      },
      {
        id: 'add-x',
        cartId: 'cart-hand',
        key: usWest('c2', 1),
        sku: 'sku-1',
        kind: 'add',
        quantity: 1,
        observedContext: ['base'],
        commitAtUs: 1,
      },
      {
        id: 'change-three-a',
        cartId: 'cart-hand',
        key: usWest('c3', 1),
        sku: 'sku-1',
        kind: 'change',
        quantity: 3,
        observedContext: ['base'],
        commitAtUs: 1,
      },
      {
        id: 'change-three-b',
        cartId: 'cart-hand',
        key: usWest('c4', 1),
        sku: 'sku-1',
        kind: 'change',
        quantity: 3,
        observedContext: ['base'],
        commitAtUs: 1,
      },
      {
        id: 'change-one-a',
        cartId: 'cart-hand',
        key: usWest('c5', 1),
        sku: 'sku-1',
        kind: 'change',
        quantity: 1,
        observedContext: ['base'],
        commitAtUs: 1,
      },
      {
        id: 'change-one-b',
        cartId: 'cart-hand',
        key: usWest('c6', 1),
        sku: 'sku-1',
        kind: 'change',
        quantity: 1,
        observedContext: ['base'],
        commitAtUs: 1,
      },
      {
        id: 'remove-observed',
        cartId: 'cart-hand',
        key: usWest('c7', 1),
        sku: 'sku-1',
        kind: 'remove',
        quantity: null,
        observedContext: ['base'],
        commitAtUs: 1,
      },
    ];
    const quantity = (ids: string[]) =>
      applyOperations(operations, ids).state['sku-1']?.quantity ?? 0;

    // concurrent add: 2 + 1 = 3; replaying the identical add is one effect
    expect(quantity(['base', 'add-x'])).toBe(3);
    expect(quantity(['base', 'add-x', 'add-x'])).toBe(3);
    // two independent 2->3 changes = 4
    expect(quantity(['base', 'change-three-a', 'change-three-b'])).toBe(4);
    // two independent 2->1 changes remove the same observed unit = 1
    expect(quantity(['base', 'change-one-a', 'change-one-b'])).toBe(1);
    // remove of observed units while an unseen add lands = 1
    expect(quantity(['base', 'remove-observed', 'add-x'])).toBe(1);
  });
});
