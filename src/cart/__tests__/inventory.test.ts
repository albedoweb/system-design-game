/**
 * GC-010 focused tests: one-authority serial Inventory, selected-view basket
 * binding, atomic multi-line commit, durable terminal outcomes and replay-safe
 * stock/order mutations.
 *
 * Expectations come from `cart-protocol-v1` §5/B4, the DEVELOPER §7 work/byte
 * tables and the D001 canonical-JSON basket-digest known answers:
 * lookup 0.10 CPU-ms + 1 IO, transaction 0.50 + 0.10/line + 2 IO, evidence
 * 0.10 per covered id, terminal record 256 + 32/line, flush 2 ms, RAM index
 * 64/order + 32/SKU. The independent reference oracle is used where it can
 * answer the same question so this module is never its own only witness.
 */
import { describe, expect, it } from 'vitest';

import { CART_REGIONS, type CartRegion } from '../contracts';
import {
  CART_INVENTORY_BASKET_LINE_BYTES,
  CART_INVENTORY_EVIDENCE_PER_ID_CPU_MS,
  CART_INVENTORY_LOOKUP_CPU_MS,
  CART_INVENTORY_LOOKUP_IO_UNITS,
  CART_INVENTORY_MAX_BASKET_LINES,
  CART_INVENTORY_ORDER_INDEX_BYTES,
  CART_INVENTORY_SKU_INDEX_BYTES,
  CART_INVENTORY_TERMINAL_RESULT_BYTES,
  CART_INVENTORY_TRANSACTION_CPU_MS,
  CART_INVENTORY_TRANSACTION_IO_UNITS,
  CART_INVENTORY_TRANSACTION_PER_LINE_CPU_MS,
  CartInventory,
  cartCheckoutReadFromView,
  cartCheckoutLinesFromView,
  cartSelectedViewDigest,
  createCartCheckoutBinding,
  createCartCheckoutEvidence,
  validateCartBasket,
  validateCartCheckoutBinding,
  type CartBasketLine,
  type CartCheckoutBinding,
  type CartCheckoutEvidence,
  type CartCheckoutRead,
  type CartInventoryCommitRecord,
  type CartInventoryResult,
} from '../core/inventory';
import { CART_COMPONENT_TABLE, CART_DURABLE_FLUSH_US } from '../core/resources';
import type { CartReadComplete } from '../core/reads';
import type { CartCertificate } from '../core/tokens';
import { CartOriginCommitLedger, isAuthorityIssuedCertificate } from '../core/tokens';
import {
  basketDigest,
  checkout as oracleCheckout,
  inventoryConserved,
  type BasketLine,
  type InventoryState,
} from './reference-oracle';

const RACE_SKU = 'probe/race/20/race/scarce';
const ATOMIC_SCARCE = 'probe/atomic/20/atomic/scarce';
const ATOMIC_ABUNDANT = 'probe/atomic/20/atomic/abundant';
const PLAIN_SKU = 'probe/gc-010/sku';

function line(sku: string, quantity: number): CartBasketLine {
  return { sku, quantity };
}

/**
 * Genuine modeled origin authorities for one test inventory: the exact ledger
 * objects the inventory is configured with, which are also the only objects
 * that can mint checkout provenance for these tests.
 */
class GenuineAuthorities {
  private readonly ledgers = new Map<CartRegion, CartOriginCommitLedger>();

  constructor() {
    for (const origin of CART_REGIONS) {
      this.ledgers.set(
        origin,
        new CartOriginCommitLedger(`journal-${origin}`, { [origin]: `journal-${origin}` }),
      );
    }
  }

  configured(): Partial<Record<CartRegion, CartOriginCommitLedger>> {
    const configured: Partial<Record<CartRegion, CartOriginCommitLedger>> = {};
    for (const [origin, ledger] of this.ledgers) configured[origin] = ledger;
    return configured;
  }

  ledger(origin: CartRegion): CartOriginCommitLedger {
    const ledger = this.ledgers.get(origin);
    if (!ledger) throw new Error(`no authority ledger configured for ${origin}`);
    return ledger;
  }

  /** Genuine certificates, one per origin, covering exactly these ids. */
  certificates(cartId: string, coveredIds: readonly string[], cutUs: number): CartCertificate[] {
    return CART_REGIONS.map((origin) => {
      const ledger = this.ledger(origin);
      for (const id of coveredIds) ledger.record(cartId, origin, id, 0);
      const issue = ledger.issue(cartId, origin, cutUs);
      if (!issue.ok) throw new Error(`authority for ${origin} could not issue a certificate`);
      return issue.certificate;
    });
  }
}

const INVENTORY_AUTHORITIES = new WeakMap<CartInventory, GenuineAuthorities>();

function authoritiesFor(inventory: CartInventory): GenuineAuthorities {
  const authorities = INVENTORY_AUTHORITIES.get(inventory);
  if (!authorities) throw new Error('test inventory has no configured origin authorities');
  return authorities;
}

function certificatesFor(
  inventory: CartInventory,
  cartId: string,
  coveredIds: readonly string[],
  cutUs: number,
): CartCertificate[] {
  return authoritiesFor(inventory).certificates(cartId, coveredIds, cutUs);
}

function completeRead(
  inventory: CartInventory,
  cartId: string,
  coveredIds: readonly string[],
  lines: readonly CartBasketLine[],
  deliveryUs: number,
  options: { certificates?: CartCertificate[]; requestId?: string } = {},
): CartCheckoutRead {
  return {
    cartId,
    coveredIds,
    lines,
    certificates:
      options.certificates ?? certificatesFor(inventory, cartId, coveredIds, deliveryUs),
    deliveryUs,
    requestId: options.requestId ?? `read-${cartId}`,
  };
}

function bindingFor(
  orderKey: string,
  cartId: string,
  coveredIds: readonly string[],
  lines: readonly CartBasketLine[],
): CartCheckoutBinding {
  return createCartCheckoutBinding(orderKey, { cartId, coveredIds, lines });
}

function evidenceFor(read: CartCheckoutRead): CartCheckoutEvidence {
  return createCartCheckoutEvidence(read);
}

function inventoryFor(
  stock: Readonly<Record<string, number>>,
  options: {
    size?: 'S' | 'M';
    capacity?: number;
    onCommit?: (record: CartInventoryCommitRecord) => void;
    authorities?: GenuineAuthorities;
  } = {},
): CartInventory {
  const authorities = options.authorities ?? new GenuineAuthorities();
  const inventory = new CartInventory({
    nodeId: 'inventory-1',
    size: options.size ?? 'S',
    initialStock: stock,
    originAuthorities: authorities.configured(),
    ...(options.capacity === undefined ? {} : { durableCapacityBytes: options.capacity }),
    ...(options.onCommit === undefined ? {} : { onCommit: options.onCommit }),
  });
  INVENTORY_AUTHORITIES.set(inventory, authorities);
  return inventory;
}

/** First purchase: complete read delivered one microsecond before commit. */
function purchase(
  inventory: CartInventory,
  orderKey: string,
  cartId: string,
  coveredIds: readonly string[],
  lines: readonly CartBasketLine[],
  atUs = 1_000,
): CartInventoryResult {
  const binding = bindingFor(orderKey, cartId, coveredIds, lines);
  const read = completeRead(inventory, cartId, coveredIds, lines, atUs - 1);
  return inventory.commit(binding, evidenceFor(read), { atUs });
}

describe('selected-view digest', () => {
  it('reproduces the canonical-JSON known answers as fixed bytes', () => {
    expect(
      cartSelectedViewDigest('cart-race-us-west', ['op-race-us-west'], [line(RACE_SKU, 1)]),
    ).toBe('02bd5a56e91aa56fd2524bf299bd882176cb019c20bb9de109a1de482ba1355d');
    expect(
      cartSelectedViewDigest('cart-known-20', ['op-known-base'], [
        line('probe/known/20/known-stock/sku', 1),
      ]),
    ).toBe('19ad48feecd7f3c63885f8c153be43a61c2201738fae80fb15037e95399e7d3f');
    expect(
      cartSelectedViewDigest('cart-replay-20', ['op-replay-base'], [
        line('probe/replay/20/lost-reply-edit-replay/sku', 1),
      ]),
    ).toBe('9b2181f733881e9f4909c5ac677a6e1eb76df3d7df0807f10d1433636bceb83d');
  });

  it('hashes the literal recursively sorted bytes, not insertion order', () => {
    const raceBytes =
      '{"cartId":"cart-race-us-west","coveredIds":["op-race-us-west"],' +
      '"lines":[{"quantity":1,"sku":"probe/race/20/race/scarce"}]}';
    expect(raceBytes).toContain('{"quantity":1,"sku":');
    expect(
      cartSelectedViewDigest('cart-race-us-west', ['op-race-us-west'], [line(RACE_SKU, 1)]),
    ).toBe('02bd5a56e91aa56fd2524bf299bd882176cb019c20bb9de109a1de482ba1355d');
  });

  it('is insensitive to line key insertion order', () => {
    const bySkuFirst: CartBasketLine = { sku: RACE_SKU, quantity: 1 };
    const byQuantityFirst: CartBasketLine = { quantity: 1, sku: RACE_SKU };
    expect(Object.keys(bySkuFirst)).toEqual(['sku', 'quantity']);
    expect(Object.keys(byQuantityFirst)).toEqual(['quantity', 'sku']);
    expect(
      cartSelectedViewDigest('cart-race-us-west', ['op-race-us-west'], [bySkuFirst]),
    ).toBe(cartSelectedViewDigest('cart-race-us-west', ['op-race-us-west'], [byQuantityFirst]));
  });

  it('agrees with the independent reference oracle for permuted inputs', () => {
    const cases: Array<{ cartId: string; covered: string[]; lines: BasketLine[] }> = [
      { cartId: 'cart-a', covered: ['op-2', 'op-1'], lines: [{ sku: 'sku-b', quantity: 3 }] },
      {
        cartId: 'cart-b',
        covered: ['op-3', 'op-1', 'op-2'],
        lines: [
          { sku: 'sku-b', quantity: 1 },
          { sku: 'sku-a', quantity: 2 },
        ],
      },
    ];
    for (const entry of cases) {
      expect(cartSelectedViewDigest(entry.cartId, entry.covered, entry.lines)).toBe(
        basketDigest(entry.cartId, entry.covered, entry.lines),
      );
    }
  });

  it('is insensitive to input line order and covered-id order', () => {
    const ab = cartSelectedViewDigest('cart-order', ['op-b', 'op-a'], [
      line('sku-b', 1),
      line('sku-a', 2),
    ]);
    const ba = cartSelectedViewDigest('cart-order', ['op-a', 'op-b'], [
      line('sku-a', 2),
      line('sku-b', 1),
    ]);
    expect(ab).toBe(ba);
    expect(ab).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('pre-mutation validation', () => {
  it('rejects empty, duplicate, non-positive, non-integer and malformed baskets', () => {
    expect(validateCartBasket([])).toContain('empty-basket');
    expect(
      validateCartBasket([line(PLAIN_SKU, 1), line(PLAIN_SKU, 2)]),
    ).toContain(`duplicate-sku:${PLAIN_SKU}`);
    expect(validateCartBasket([line(PLAIN_SKU, 0)])).toContain(
      `non-positive-quantity:${PLAIN_SKU}`,
    );
    expect(validateCartBasket([line(PLAIN_SKU, -3)])).toContain(
      `non-positive-quantity:${PLAIN_SKU}`,
    );
    expect(validateCartBasket([line(PLAIN_SKU, 1.5)])).toContain(
      `non-integer-quantity:${PLAIN_SKU}`,
    );
    expect(validateCartBasket([line('', 1)])).toContain('invalid-sku:');
  });

  it('caps a basket at the 400-operation cart bound', () => {
    const oversized = Array.from({ length: CART_INVENTORY_MAX_BASKET_LINES + 1 }, (_, index) =>
      line(`sku-${index}`, 1),
    );
    expect(validateCartBasket(oversized)).toContain('too-many-lines');
  });

  it('reports binding issues before any ledger or stock mutation', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 5 });
    const invalidKey = {
      ...bindingFor('order-1', 'cart-1', ['op-1'], [line(PLAIN_SKU, 1)]),
      orderKey: '',
    };
    expect(validateCartCheckoutBinding(invalidKey)).toContain('invalid-order-key');
    const result = inventory.commit(invalidKey, evidenceFor(
      completeRead(inventory, 'cart-1', ['op-1'], [line(PLAIN_SKU, 1)], 999),
    ), { atUs: 1_000 });
    expect(result.outcome).toBe('validation-failed');
    expect(result.issues).toContain('invalid-order-key');
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(5);
    expect(inventory.ledgerSnapshot()).toHaveLength(0);
    expect(inventory.durableBytesUsed).toBe(0);
  });
});

describe('race: three one-unit orders against stock two', () => {
  const permutations: readonly (readonly number[])[] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];

  const orders = [0, 1, 2].map((index) => ({
    orderKey: `order-race-${index}`,
    cartId: `cart-race-${index}`,
    coveredIds: [`op-race-${index}`],
  }));

  it.each(permutations.map((order) => [order.join('>'), order] as const))(
    'serializes %s to exactly two successes and one rejection',
    (_label, order) => {
      const inventory = inventoryFor({ [RACE_SKU]: 2 });
      const outcomes: string[] = [];
      for (const index of order) {
        const entry = orders[index] as (typeof orders)[number];
        const result = purchase(inventory, entry.orderKey, entry.cartId, entry.coveredIds, [
          line(RACE_SKU, 1),
        ]);
        outcomes.push(result.outcome);
      }
      expect(outcomes.filter((outcome) => outcome === 'committed')).toHaveLength(2);
      expect(outcomes.filter((outcome) => outcome === 'out-of-stock')).toHaveLength(1);
      expect(inventory.stockSnapshot()[RACE_SKU]).toBe(0);
      expect(inventory.ordersSnapshot()).toHaveLength(2);
      expect(inventory.ledgerSnapshot()).toHaveLength(3);
      expect(inventory.conservation()).toEqual({ conserved: true, violations: [] });
    },
  );

  it('matches the independent oracle on the fixture race scenario', () => {
    const requests = orders.map((entry) => ({
      orderKey: entry.orderKey,
      cartId: entry.cartId,
      coveredIds: entry.coveredIds,
      tokenIds: entry.coveredIds,
      lines: [line(RACE_SKU, 1)],
    }));

    let oracleState: InventoryState = { stock: { [RACE_SKU]: 2 }, ledger: [], orders: [] };
    const oracleOutcomes: string[] = [];
    for (const request of requests) {
      const result = oracleCheckout(oracleState, request, {
        ledgerReachable: true,
        evidence: {
          digest: basketDigest(request.cartId, request.coveredIds, request.lines),
          lines: request.lines,
          coveredIds: request.coveredIds,
          tokenIds: request.tokenIds,
        },
      });
      oracleState = result.next;
      oracleOutcomes.push(result.outcome);
    }

    const inventory = inventoryFor({ [RACE_SKU]: 2 });
    const inventoryOutcomes = requests.map(
      (request) =>
        purchase(inventory, request.orderKey, request.cartId, request.coveredIds, request.lines)
          .outcome,
    );

    expect(inventoryOutcomes).toEqual(oracleOutcomes);
    expect(inventory.stockSnapshot()).toEqual(oracleState.stock);
    expect(inventory.ordersSnapshot()).toHaveLength(oracleState.orders.length);
    expect(oracleState.orders).toHaveLength(2);
    expect(inventoryConserved({ [RACE_SKU]: 2 }, oracleState).conserved).toBe(true);
  });
});

describe('concurrent lookup misses', () => {
  it('cannot both mutate the same key: the second commit replays the first', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 5 });
    const binding = bindingFor('order-once', 'cart-once', ['op-once'], [line(PLAIN_SKU, 1)]);

    const firstLookup = inventory.lookup(binding);
    const secondLookup = inventory.lookup(binding);
    expect(firstLookup.outcome).toBe('lookup-miss');
    expect(secondLookup.outcome).toBe('lookup-miss');
    expect(inventory.ledgerSnapshot()).toHaveLength(0);
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(5);

    const evidence = evidenceFor(completeRead(inventory, 'cart-once', ['op-once'], [line(PLAIN_SKU, 1)], 999));
    const first = inventory.commit(binding, evidence, { atUs: 1_000 });
    const second = inventory.commit(binding, evidence, { atUs: 1_001 });

    expect(first.outcome).toBe('committed');
    expect(first.duplicate).toBe(false);
    expect(second.outcome).toBe('committed');
    expect(second.duplicate).toBe(true);
    expect(second.durableAtUs).toBe(first.durableAtUs);
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(4);
    expect(inventory.ordersSnapshot()).toHaveLength(1);
    expect(inventory.ledgerSnapshot()).toHaveLength(1);
    expect(inventory.conservation().conserved).toBe(true);
  });
});

describe('atomic multi-line checkout', () => {
  const orders = [
    {
      orderKey: 'order-atomic-us-west',
      cartId: 'cart-atomic-us-west',
      coveredIds: ['op-atomic-us-west'],
      lines: [line(ATOMIC_ABUNDANT, 2), line(ATOMIC_SCARCE, 1)],
    },
    {
      orderKey: 'order-atomic-eu-central',
      cartId: 'cart-atomic-eu-central',
      coveredIds: ['op-atomic-eu-central'],
      lines: [line(ATOMIC_ABUNDANT, 3), line(ATOMIC_SCARCE, 1)],
    },
  ];

  it.each([
    ['first wins', [0, 1]],
    ['second wins', [1, 0]],
  ] as const)('%s: the losing basket decrements no line', (_label, order) => {
    const initial = { [ATOMIC_SCARCE]: 1, [ATOMIC_ABUNDANT]: 10 };
    const inventory = inventoryFor(initial);
    const outcomes: string[] = [];
    for (const index of order) {
      const entry = orders[index] as (typeof orders)[number];
      outcomes.push(
        purchase(inventory, entry.orderKey, entry.cartId, entry.coveredIds, entry.lines).outcome,
      );
    }

    expect(outcomes.filter((outcome) => outcome === 'committed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'out-of-stock')).toHaveLength(1);
    expect(inventory.stockSnapshot()[ATOMIC_SCARCE]).toBe(0);
    expect(inventory.stockSnapshot()[ATOMIC_ABUNDANT]).toBe(
      order[0] === 0 ? 8 : 7,
    );
    expect(inventory.ordersSnapshot()).toHaveLength(1);
    expect(inventory.conservation().conserved).toBe(true);
  });

  it('reports conservation at every durable transaction, including rejections', () => {
    const initial = { [ATOMIC_SCARCE]: 1, [ATOMIC_ABUNDANT]: 10 };
    const checkpoints: CartInventoryCommitRecord[] = [];
    const inventory = inventoryFor(initial, { onCommit: (record) => checkpoints.push(record) });

    purchase(inventory, 'order-a', 'cart-a', ['op-a'], orders[0]?.lines ?? []);
    purchase(inventory, 'order-b', 'cart-b', ['op-b'], orders[1]?.lines ?? []);

    expect(checkpoints).toHaveLength(2);
    const committed = new Map<string, number>();
    for (const checkpoint of checkpoints) {
      if (checkpoint.outcome === 'committed') {
        for (const entry of checkpoint.lines) {
          committed.set(entry.sku, (committed.get(entry.sku) ?? 0) + entry.quantity);
        }
      }
      for (const sku of Object.keys(initial)) {
        const remaining = checkpoint.stockAfter[sku] ?? 0;
        expect(remaining).toBeGreaterThanOrEqual(0);
        expect(remaining + (committed.get(sku) ?? 0)).toBe(
          initial[sku as keyof typeof initial],
        );
      }
      if (checkpoint.outcome === 'out-of-stock') {
        expect(checkpoint.stockAfter).toEqual(checkpoint.stockBefore);
      }
    }
    expect(inventory.conservation().conserved).toBe(true);
  });

  it('does not emit a durable checkpoint for validation, conflict or capacity failures', () => {
    const checkpoints: CartInventoryCommitRecord[] = [];
    const inventory = inventoryFor({ [PLAIN_SKU]: 1 }, {
      capacity: CART_INVENTORY_TERMINAL_RESULT_BYTES + CART_INVENTORY_BASKET_LINE_BYTES,
      onCommit: (record) => checkpoints.push(record),
    });

    inventory.commit(bindingFor('order-empty', 'cart-x', ['op-x'], []), null);
    purchase(inventory, 'order-live', 'cart-live', ['op-live'], [line(PLAIN_SKU, 1)]);
    purchase(inventory, 'order-conflict', 'cart-conflict', ['op-c1'], [line(PLAIN_SKU, 1)]);
    purchase(inventory, 'order-full', 'cart-full', ['op-full'], [line(PLAIN_SKU, 1)]);

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.outcome).toBe('committed');
  });
});

describe('lost response and replay', () => {
  it('recovers the original committed outcome without a second decrement or cart read', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const binding = bindingFor('order-lost', 'cart-lost', ['op-lost'], [line(PLAIN_SKU, 1)]);
    const read = completeRead(inventory, 'cart-lost', ['op-lost'], [line(PLAIN_SKU, 1)], 999);

    const lost = inventory.checkout(
      { binding, read: () => read },
      { atUs: 1_000, deliverReply: false },
    );
    expect(lost.outcome).toBe('committed');
    expect(lost.replyDelivered).toBe(false);
    expect(lost.clientOutcome).toBe('unknown');
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(9);
    expect(inventory.ordersSnapshot()).toHaveLength(1);

    // The cart may change after the lost reply; the retry must never re-read it.
    let reads = 0;
    const retry = inventory.checkout({
      binding,
      read: () => {
        reads += 1;
        return completeRead(inventory, 'cart-lost', ['op-lost'], [line(PLAIN_SKU, 5)], 2_000);
      },
    });

    expect(reads).toBe(0);
    expect(retry.outcome).toBe('committed');
    expect(retry.duplicate).toBe(true);
    expect(retry.replyDelivered).toBe(true);
    expect(retry.durableAtUs).toBe(lost.durableAtUs);
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(9);
    expect(inventory.ordersSnapshot()).toHaveLength(1);
    expect(inventory.ledgerSnapshot()).toHaveLength(1);
    expect(inventory.conservation().conserved).toBe(true);
  });

  it('replays a committed order with absent evidence even when the cart path is down', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const binding = bindingFor('order-path', 'cart-path', ['op-path'], [line(PLAIN_SKU, 1)]);
    const first = inventory.commit(
      binding,
      evidenceFor(completeRead(inventory, 'cart-path', ['op-path'], [line(PLAIN_SKU, 1)], 999)),
      { atUs: 1_000 },
    );
    expect(first.outcome).toBe('committed');

    const replay = inventory.commit(binding, null, { atUs: 2_000 });
    expect(replay.outcome).toBe('committed');
    expect(replay.duplicate).toBe(true);
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(9);

    const checkoutReplay = inventory.checkout({ binding });
    expect(checkoutReplay.outcome).toBe('committed');
    expect(checkoutReplay.duplicate).toBe(true);
    expect(inventory.ordersSnapshot()).toHaveLength(1);
  });

  it('returns unavailable, not a business outcome, when the checkout read is down on a miss', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const binding = bindingFor('order-noread', 'cart-noread', ['op-noread'], [line(PLAIN_SKU, 1)]);
    const result = inventory.checkout({ binding, read: () => undefined }, { atUs: 1_000 });
    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toBe('read-unavailable');
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(10);
    expect(inventory.ledgerSnapshot()).toHaveLength(0);
  });
});

describe('unavailable authority', () => {
  it('never authorizes a purchase and never reports out-of-stock', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 }, { capacity: 10_000 });
    inventory.setReachable(false);

    const binding = bindingFor('order-down', 'cart-down', ['op-down'], [line(PLAIN_SKU, 1)]);
    const lookup = inventory.lookup(binding);
    const commit = inventory.commit(
      binding,
      evidenceFor(completeRead(inventory, 'cart-down', ['op-down'], [line(PLAIN_SKU, 1)], 999)),
      { atUs: 1_000 },
    );
    const checkout = inventory.checkout({ binding });

    for (const result of [lookup, commit, checkout]) {
      expect(result.outcome).toBe('unavailable');
      expect(result.outcome).not.toBe('out-of-stock');
      expect(result.clientOutcome).toBe('unknown');
      expect(result.replyDelivered).toBe(false);
    }
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(10);
    expect(inventory.ledgerSnapshot()).toHaveLength(0);
    expect(inventory.ordersSnapshot()).toHaveLength(0);

    inventory.setReachable(true);
    const restored = purchase(inventory, 'order-down', 'cart-down', ['op-down'], [
      line(PLAIN_SKU, 1),
    ]);
    expect(restored.outcome).toBe('committed');
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(9);
  });
});

describe('finite durable ledger', () => {
  it('rejects a new purchase when the full result cannot be reserved, with no stock effect', () => {
    const oneLineBytes = CART_INVENTORY_TERMINAL_RESULT_BYTES + CART_INVENTORY_BASKET_LINE_BYTES;
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 }, { capacity: oneLineBytes });

    const first = purchase(inventory, 'order-fit', 'cart-fit', ['op-fit'], [line(PLAIN_SKU, 1)]);
    expect(first.outcome).toBe('committed');
    expect(inventory.durableBytesUsed).toBe(oneLineBytes);

    const second = purchase(inventory, 'order-over', 'cart-over', ['op-over'], [
      line(PLAIN_SKU, 1),
    ]);
    expect(second.outcome).toBe('unavailable');
    expect(second.reason).toBe('ledger-full');
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(9);
    expect(inventory.ordersSnapshot()).toHaveLength(1);
    expect(inventory.ledgerSnapshot()).toHaveLength(1);
    expect(inventory.durableBytesUsed).toBe(oneLineBytes);

    // Already committed records survive a full ledger and replay for free.
    const replay = inventory.commit(
      bindingFor('order-fit', 'cart-fit', ['op-fit'], [line(PLAIN_SKU, 1)]),
      null,
      { atUs: 2_000 },
    );
    expect(replay.outcome).toBe('committed');
    expect(replay.duplicate).toBe(true);
    expect(inventory.durableBytesUsed).toBe(oneLineBytes);
    expect(inventory.conservation().conserved).toBe(true);
  });

  it('sizes the default ledger from the frozen inventory table', () => {
    expect(inventoryFor({}, { size: 'S' }).durableCapacityBytes).toBe(
      CART_COMPONENT_TABLE.inventory.S.durableBytes,
    );
    expect(inventoryFor({}, { size: 'M' }).durableCapacityBytes).toBe(
      CART_COMPONENT_TABLE.inventory.M.durableBytes,
    );
  });

  it('charges the full terminal record for an out-of-stock rejection', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 0 });
    const result = purchase(inventory, 'order-oos', 'cart-oos', ['op-oos'], [
      line(PLAIN_SKU, 1),
    ]);
    expect(result.outcome).toBe('out-of-stock');
    expect(inventory.durableBytesUsed).toBe(
      CART_INVENTORY_TERMINAL_RESULT_BYTES + CART_INVENTORY_BASKET_LINE_BYTES,
    );
    expect(inventory.ledgerSnapshot()[0]?.outcome).toBe('out-of-stock');
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(0);
  });

  it('keeps a durable out-of-stock outcome across retries without a second record', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 0 });
    const binding = bindingFor('order-oos-replay', 'cart-oos-replay', ['op-r'], [
      line(PLAIN_SKU, 1),
    ]);
    const first = purchase(inventory, 'order-oos-replay', 'cart-oos-replay', ['op-r'], [
      line(PLAIN_SKU, 1),
    ]);
    expect(first.outcome).toBe('out-of-stock');

    const replay = inventory.commit(binding, null, { atUs: 5_000 });
    const checkoutReplay = inventory.checkout({ binding });
    expect(replay.outcome).toBe('out-of-stock');
    expect(replay.duplicate).toBe(true);
    expect(checkoutReplay.outcome).toBe('out-of-stock');
    expect(checkoutReplay.duplicate).toBe(true);
    expect(inventory.ledgerSnapshot()).toHaveLength(1);
    expect(inventory.ordersSnapshot()).toHaveLength(0);
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(0);
    expect(inventory.conservation().conserved).toBe(true);
  });
});

describe('conflicting keys', () => {
  it('returns an idempotency conflict with zero extra effect', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const binding = bindingFor('order-conflict', 'cart-conflict', ['op-base'], [
      line(PLAIN_SKU, 1),
    ]);
    const first = purchase(inventory, 'order-conflict', 'cart-conflict', ['op-base'], [
      line(PLAIN_SKU, 1),
    ]);
    expect(first.outcome).toBe('committed');
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(9);

    const sameKeyDifferentLines = bindingFor('order-conflict', 'cart-conflict', ['op-base'], [
      line(PLAIN_SKU, 2),
    ]);
    const conflict = inventory.commit(
      sameKeyDifferentLines,
      evidenceFor(completeRead(inventory, 'cart-conflict', ['op-base'], [line(PLAIN_SKU, 2)], 1_500)),
      { atUs: 2_000 },
    );
    expect(conflict.outcome).toBe('idempotency-conflict');
    expect(conflict.duplicate).toBe(false);
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(9);
    expect(inventory.ordersSnapshot()).toHaveLength(1);
    expect(inventory.ledgerSnapshot()).toHaveLength(1);

    // Same key and lines but a different cart is a different binding.
    const otherCart = bindingFor('order-conflict', 'cart-other', ['op-base'], [
      line(PLAIN_SKU, 1),
    ]);
    expect(inventory.lookup(binding).outcome).toBe('committed');
    expect(inventory.lookup(otherCart).outcome).toBe('idempotency-conflict');
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(9);
  });
});

describe('selected-view evidence is required for a first purchase', () => {
  it('rejects an unknown key with no evidence', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const binding = bindingFor('order-unknown', 'cart-unknown', ['op-u'], [line(PLAIN_SKU, 1)]);
    const result = inventory.commit(binding, null, { atUs: 1_000 });
    expect(result.outcome).toBe('validation-failed');
    expect(result.issues).toContain('missing-read-evidence');
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(10);
    expect(inventory.ledgerSnapshot()).toHaveLength(0);
  });

  it('returns selection-changed when the displayed view no longer matches the binding', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const binding = bindingFor('order-changed', 'cart-changed', ['op-c'], [line(PLAIN_SKU, 1)]);
    const changedRead = completeRead(inventory, 'cart-changed', ['op-c'], [line(PLAIN_SKU, 2)], 999);
    const result = inventory.commit(binding, evidenceFor(changedRead), { atUs: 1_000 });
    expect(result.outcome).toBe('selection-changed');
    expect(result.issues).toContain('displayed-lines-mismatch');
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(10);
    expect(inventory.ledgerSnapshot()).toHaveLength(0);
  });

  it('returns selection-changed when covered ids do not reproduce the bound digest', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const binding = bindingFor('order-digest', 'cart-digest', ['op-c'], [line(PLAIN_SKU, 1)]);
    const forgedRead = completeRead(inventory, 'cart-digest', ['op-other'], [line(PLAIN_SKU, 1)], 999);
    const result = inventory.commit(binding, evidenceFor(forgedRead), { atUs: 1_000 });
    expect(result.outcome).toBe('selection-changed');
    expect(result.issues).toContain('selected-view-digest-mismatch');
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(10);
    expect(inventory.ledgerSnapshot()).toHaveLength(0);
  });

  it('returns selection-changed when the read view gained or lost lines', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const binding = bindingFor('order-count', 'cart-count', ['op-c'], [line(PLAIN_SKU, 1)]);
    const extraLineRead = completeRead(
      inventory,
      'cart-count',
      ['op-c'],
      [line(PLAIN_SKU, 1), line('sku-extra', 1)],
      999,
    );
    const result = inventory.commit(binding, evidenceFor(extraLineRead), { atUs: 1_000 });
    expect(result.outcome).toBe('selection-changed');
    expect(result.issues).toContain('displayed-lines-mismatch');
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(10);
    expect(inventory.ledgerSnapshot()).toHaveLength(0);
  });

  it('rejects certificates whose cut predates the read delivery by over two seconds', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const binding = bindingFor('order-stale', 'cart-stale', ['op-s'], [line(PLAIN_SKU, 1)]);
    const stale = certificatesFor(inventory, 'cart-stale', ['op-s'], 1_000_000);
    const read = completeRead(inventory, 'cart-stale', ['op-s'], [line(PLAIN_SKU, 1)], 10_000_000, {
      certificates: stale,
    });
    const result = inventory.commit(binding, evidenceFor(read), { atUs: 10_000_000 });
    expect(result.outcome).toBe('validation-failed');
    expect(result.issues.filter((issue) => issue.startsWith('stale-certificate-cut:'))).toHaveLength(3);
    expect(inventory.ledgerSnapshot()).toHaveLength(0);
  });

  it('rejects a malformed basket payload at runtime instead of throwing', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const binding = {
      ...bindingFor('order-malformed', 'cart-malformed', ['op-m'], [line(PLAIN_SKU, 1)]),
      lines: 'not-an-array' as unknown as readonly CartBasketLine[],
    };
    const lookup = inventory.lookup(binding);
    const commit = inventory.commit(binding, null, { atUs: 1_000 });
    expect(lookup.outcome).toBe('validation-failed');
    expect(commit.outcome).toBe('validation-failed');
    expect(commit.issues).toContain('invalid-basket-lines');
    expect(inventory.ledgerSnapshot()).toHaveLength(0);
  });

  it('rejects missing, mis-scoped or future-dated provenance', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const binding = bindingFor('order-prov', 'cart-prov', ['op-p'], [line(PLAIN_SKU, 1)]);
    const lines = [line(PLAIN_SKU, 1)];

    const noCertificates = inventory.commit(
      binding,
      evidenceFor(
        completeRead(inventory, 'cart-prov', ['op-p'], lines, 999, { certificates: [] }),
      ),
      { atUs: 1_000 },
    );
    expect(noCertificates.outcome).toBe('validation-failed');
    expect(
      noCertificates.issues.filter((issue) => issue.startsWith('missing-origin-certificate:')),
    ).toHaveLength(3);

    const otherCart = inventory.commit(
      binding,
      evidenceFor(completeRead(inventory, 'cart-other', ['op-p'], lines, 999)),
      { atUs: 1_000 },
    );
    expect(otherCart.outcome).toBe('validation-failed');
    expect(otherCart.issues).toContain('evidence-cart-mismatch');

    const future = inventory.commit(
      binding,
      evidenceFor(completeRead(inventory, 'cart-prov', ['op-p'], lines, 5_000)),
      { atUs: 1_000 },
    );
    expect(future.outcome).toBe('validation-failed');
    expect(future.issues).toContain('evidence-from-future');

    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(10);
    expect(inventory.ledgerSnapshot()).toHaveLength(0);
  });

  it('rejects genuine certificates whose ids were not covered by the read', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const binding = bindingFor('order-cert', 'cart-cert', ['op-c'], [line(PLAIN_SKU, 1)]);
    // Genuinely issued by the configured authorities, but the packet omits
    // `op-smuggled` from its covered set: provenance does not widen coverage.
    const certificates = certificatesFor(
      inventory,
      'cart-cert',
      ['op-c', 'op-smuggled'],
      999,
    );
    const result = inventory.commit(
      binding,
      evidenceFor(
        completeRead(inventory, 'cart-cert', ['op-c'], [line(PLAIN_SKU, 1)], 999, { certificates }),
      ),
      { atUs: 1_000 },
    );
    expect(result.outcome).toBe('validation-failed');
    expect(result.issues).toContain('certificate-id-not-covered:op-smuggled');
    expect(inventory.ledgerSnapshot()).toHaveLength(0);
  });
});

describe('checkout provenance trust boundary', () => {
  it('rejects caller-fabricated plain certificates that name the configured authority', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const binding = bindingFor('order-forged-plain', 'cart-forged-plain', ['op-f'], [
      line(PLAIN_SKU, 1),
    ]);
    // Every field is correct, including the configured authority name and a
    // fresh cut; only the issuance brand is missing.
    const forged: CartCertificate[] = CART_REGIONS.map((origin) => ({
      cartId: 'cart-forged-plain',
      origin,
      authorityNodeId: `journal-${origin}`,
      cutUs: 999,
      ids: ['op-f'],
    }));
    expect(forged.every(isAuthorityIssuedCertificate)).toBe(false);

    const result = inventory.commit(
      binding,
      evidenceFor(
        completeRead(inventory, 'cart-forged-plain', ['op-f'], [line(PLAIN_SKU, 1)], 999, {
          certificates: forged,
        }),
      ),
      { atUs: 1_000 },
    );

    expect(result.outcome).toBe('validation-failed');
    expect(
      result.issues.filter((issue) => issue.startsWith('untrusted-certificate-authority:')),
    ).toHaveLength(CART_REGIONS.length);
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(10);
    expect(inventory.ledgerSnapshot()).toHaveLength(0);
    expect(inventory.ordersSnapshot()).toHaveLength(0);
    expect(inventory.durableBytesUsed).toBe(0);
  });

  it('rejects certificates from a caller-built ledger with a colliding authority name', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const binding = bindingFor('order-forged-ledger', 'cart-forged-ledger', ['op-f'], [
      line(PLAIN_SKU, 1),
    ]);
    const forged = CART_REGIONS.map((origin) => {
      const ledger = new CartOriginCommitLedger(`journal-${origin}`, {
        [origin]: `journal-${origin}`,
      });
      ledger.record('cart-forged-ledger', origin, 'op-f', 0);
      const issue = ledger.issue('cart-forged-ledger', origin, 999);
      if (!issue.ok) throw new Error('caller-built ledger unexpectedly failed to issue');
      return issue.certificate;
    });
    // These are branded by *some* ledger and name the right authority, but they
    // were not minted by the exact authority objects the Inventory is bound to.
    expect(forged.every(isAuthorityIssuedCertificate)).toBe(true);

    const result = inventory.commit(
      binding,
      evidenceFor(
        completeRead(inventory, 'cart-forged-ledger', ['op-f'], [line(PLAIN_SKU, 1)], 999, {
          certificates: forged,
        }),
      ),
      { atUs: 1_000 },
    );

    expect(result.outcome).toBe('validation-failed');
    expect(
      result.issues.filter((issue) => issue.startsWith('untrusted-certificate-authority:')),
    ).toHaveLength(CART_REGIONS.length);
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(10);
    expect(inventory.ledgerSnapshot()).toHaveLength(0);
    expect(inventory.ordersSnapshot()).toHaveLength(0);
    expect(inventory.durableBytesUsed).toBe(0);
  });

  it('rejects genuine issuance from an authority ledger the Inventory is not configured with', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 }, { authorities: new GenuineAuthorities() });
    const binding = bindingFor('order-other-authority', 'cart-other-authority', ['op-f'], [
      line(PLAIN_SKU, 1),
    ]);
    // A second real authority set, correctly self-consistent, minted the
    // certificates: they are genuine, just not *this* Inventory's authority.
    const foreign = new GenuineAuthorities();
    const certificates = foreign.certificates('cart-other-authority', ['op-f'], 999);

    const result = inventory.commit(
      binding,
      evidenceFor(
        completeRead(
          inventory,
          'cart-other-authority',
          ['op-f'],
          [line(PLAIN_SKU, 1)],
          999,
          { certificates },
        ),
      ),
      { atUs: 1_000 },
    );

    expect(result.outcome).toBe('validation-failed');
    expect(
      result.issues.filter((issue) => issue.startsWith('untrusted-certificate-authority:')),
    ).toHaveLength(CART_REGIONS.length);
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(10);
    expect(inventory.ledgerSnapshot()).toHaveLength(0);
  });

  it('accepts only the exact configured-authority issuance for a successful decrement', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const result = purchase(inventory, 'order-genuine', 'cart-genuine', ['op-g'], [
      line(PLAIN_SKU, 1),
    ]);
    expect(result.outcome).toBe('committed');
    expect(inventory.stockSnapshot()[PLAIN_SKU]).toBe(9);
    expect(inventory.ledgerSnapshot()).toHaveLength(1);
  });
});

describe('charges, bytes and frozen records', () => {
  it('charges lookup and transaction work exactly as the DEVELOPER table says', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 }, { capacity: 10_000 });
    const binding = bindingFor('order-charge', 'cart-charge', ['op-1'], [line(PLAIN_SKU, 1)]);

    const lookup = inventory.lookup(binding);
    expect(lookup.charge.cpuMilliseconds).toBeCloseTo(CART_INVENTORY_LOOKUP_CPU_MS, 10);
    expect(lookup.charge.ioUnits).toBe(CART_INVENTORY_LOOKUP_IO_UNITS);
    expect(lookup.charge.requests).toBe(1);

    const commit = inventory.commit(
      binding,
      evidenceFor(completeRead(inventory, 'cart-charge', ['op-1'], [line(PLAIN_SKU, 1)], 999)),
      { atUs: 1_000 },
    );
    expect(commit.charge.cpuMilliseconds).toBeCloseTo(
      CART_INVENTORY_TRANSACTION_CPU_MS +
        CART_INVENTORY_TRANSACTION_PER_LINE_CPU_MS * 1 +
        CART_INVENTORY_EVIDENCE_PER_ID_CPU_MS * 1,
      10,
    );
    expect(commit.charge.ioUnits).toBe(CART_INVENTORY_TRANSACTION_IO_UNITS);
    expect(commit.charge.requests).toBe(1);
    expect(commit.durableAtUs).toBe(1_000 + CART_DURABLE_FLUSH_US);
  });

  it('charges evidence per covered id and two lines per transaction line', () => {
    const inventory = inventoryFor(
      { [ATOMIC_SCARCE]: 5, [ATOMIC_ABUNDANT]: 5 },
      { capacity: 10_000 },
    );
    const binding = bindingFor('order-two', 'cart-two', ['op-a', 'op-b'], [
      line(ATOMIC_ABUNDANT, 1),
      line(ATOMIC_SCARCE, 1),
    ]);
    const result = inventory.commit(
      binding,
      evidenceFor(
        completeRead(inventory, 'cart-two', ['op-a', 'op-b'], binding.lines, 999),
      ),
      { atUs: 1_000 },
    );
    expect(result.outcome).toBe('committed');
    expect(result.charge.cpuMilliseconds).toBeCloseTo(
      CART_INVENTORY_TRANSACTION_CPU_MS +
        CART_INVENTORY_TRANSACTION_PER_LINE_CPU_MS * 2 +
        CART_INVENTORY_EVIDENCE_PER_ID_CPU_MS * 2,
      10,
    );
    expect(inventory.durableBytesUsed).toBe(
      CART_INVENTORY_TERMINAL_RESULT_BYTES + CART_INVENTORY_BASKET_LINE_BYTES * 2,
    );
    expect(inventory.ramIndexBytes).toBe(
      CART_INVENTORY_ORDER_INDEX_BYTES + CART_INVENTORY_SKU_INDEX_BYTES * 2,
    );
  });

  it('charges a full checkout as lookup plus transaction', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const binding = bindingFor('order-flow', 'cart-flow', ['op-f'], [line(PLAIN_SKU, 1)]);
    const result = inventory.checkout(
      { binding, read: () => completeRead(inventory, 'cart-flow', ['op-f'], [line(PLAIN_SKU, 1)], 999) },
      { atUs: 1_000 },
    );
    expect(result.outcome).toBe('committed');
    expect(result.charge.cpuMilliseconds).toBeCloseTo(
      CART_INVENTORY_LOOKUP_CPU_MS +
        CART_INVENTORY_TRANSACTION_CPU_MS +
        CART_INVENTORY_TRANSACTION_PER_LINE_CPU_MS +
        CART_INVENTORY_EVIDENCE_PER_ID_CPU_MS,
      10,
    );
    expect(result.charge.ioUnits).toBe(
      CART_INVENTORY_LOOKUP_IO_UNITS + CART_INVENTORY_TRANSACTION_IO_UNITS,
    );
    expect(result.charge.requests).toBe(2);
  });

  it('never exposes mutable internal records', () => {
    const inventory = inventoryFor({ [PLAIN_SKU]: 10 });
    const mutableInput: CartBasketLine[] = [line(PLAIN_SKU, 1)];
    const binding = bindingFor('order-immutable', 'cart-immutable', ['op-i'], mutableInput);
    inventory.commit(
      binding,
      evidenceFor(completeRead(inventory, 'cart-immutable', ['op-i'], mutableInput, 999)),
      { atUs: 1_000 },
    );
    mutableInput.push(line('other-sku', 5));

    const row = inventory.ledgerSnapshot()[0];
    expect(row).toBeDefined();
    if (!row) throw new Error('expected one ledger row');
    (row.lines[0] as { quantity: number }).quantity = 99;
    (row.lines as CartBasketLine[]).push({ sku: 'injected', quantity: 1 });

    const fresh = inventory.ledgerSnapshot()[0];
    expect(fresh?.lines).toEqual([line(PLAIN_SKU, 1)]);
    expect(inventory.ordersSnapshot()[0]?.lines).toEqual([line(PLAIN_SKU, 1)]);
  });
});

describe('read adapter', () => {
  it('extracts only live, ascending SKU lines from a complete view', () => {
    const view = {
      cartId: 'cart-view',
      skus: {
        'sku-b': { added: [], tombstones: [], live: [], quantity: 2 },
        'sku-a': { added: [], tombstones: [], live: [], quantity: 1 },
        'sku-empty': { added: [], tombstones: [], live: [], quantity: 0 },
      },
      effects: {},
      appliedIds: [],
      bufferedIds: [],
      missingDependencies: {},
      cyclicIds: [],
      duplicates: [],
      conflicts: [],
      complete: true,
      work: {
        operationsApplied: 0,
        unitsAdded: 0,
        tombstonesAdded: 0,
        uniqueUnits: 0,
        uniqueTombstones: 0,
        liveUnits: 0,
        encodedUnitBytes: 0,
        encodedTombstoneBytes: 0,
        cpuMilliseconds: 0,
      },
    };
    expect(cartCheckoutLinesFromView(view)).toEqual([line('sku-a', 1), line('sku-b', 2)]);
  });

  it('packages a complete read as evidence preserving genuine issuance', () => {
    const authorities = new GenuineAuthorities();
    const certificateList = authorities.certificates('cart-adapt', ['op-a'], 10);
    const read: CartCheckoutRead = {
      cartId: 'cart-adapt',
      coveredIds: ['op-a'],
      lines: [line('sku-a', 1)],
      certificates: certificateList,
      deliveryUs: 10,
      requestId: 'read-adapt',
    };
    const evidence = createCartCheckoutEvidence(read);
    const originalCertificate = certificateList[0];
    if (!originalCertificate) throw new Error('expected one certificate');

    // The exact branded object is the provenance proof and must survive.
    expect(evidence.certificates[0]).toBe(originalCertificate);
    expect(isAuthorityIssuedCertificate(evidence.certificates[0])).toBe(true);
    // Plain data arrays are fresh copies, not aliases of the caller's arrays.
    expect(evidence.coveredIds).not.toBe(read.coveredIds);
    expect(evidence.displayedLines).not.toBe(read.lines);
    expect(evidence.coveredIds).toEqual(['op-a']);
    expect(evidence.readDeliveryUs).toBe(10);
    expect(evidence.readRequestId).toBe('read-adapt');
    expect(evidence.displayedLines).toEqual([line('sku-a', 1)]);
  });

  it('exposes a typed adapter for CartReadComplete results that preserves issuance', () => {
    // Compilation-level contract: the adapter accepts the GC-009 read outcome
    // and never invents coverage; its signature is exercised by the typecheck.
    expect(typeof cartCheckoutReadFromView).toBe('function');

    const authorities = new GenuineAuthorities();
    const certificates = authorities.certificates('cart-adapt-view', ['op-v'], 999);
    const complete = {
      kind: 'complete',
      cartId: 'cart-adapt-view',
      view: {
        cartId: 'cart-adapt-view',
        skus: {
          [PLAIN_SKU]: { added: [], tombstones: [], live: [], quantity: 1 },
        },
        effects: {},
        appliedIds: [],
        bufferedIds: [],
        missingDependencies: {},
        cyclicIds: [],
        duplicates: [],
        conflicts: [],
        complete: true,
        work: {
          operationsApplied: 0,
          unitsAdded: 0,
          tombstonesAdded: 0,
          uniqueUnits: 0,
          uniqueTombstones: 0,
          liveUnits: 0,
          encodedUnitBytes: 0,
          encodedTombstoneBytes: 0,
          cpuMilliseconds: 0,
        },
      },
      coveredIds: ['op-v'],
      evidence: { certificates },
    } as unknown as CartReadComplete;

    const adapted = cartCheckoutReadFromView(complete, {
      deliveryUs: 999,
      requestId: 'read-adapted',
    });
    expect(adapted.certificates).toHaveLength(CART_REGIONS.length);
    expect(adapted.certificates[0]).toBe(certificates[0]);
    expect(adapted.lines).toEqual([line(PLAIN_SKU, 1)]);
    expect(adapted.certificates.every(isAuthorityIssuedCertificate)).toBe(true);
  });
});
