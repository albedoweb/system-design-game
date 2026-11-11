/**
 * Mandatory qualification probes (GC-006).
 *
 * Frozen data source: immutable `experiments/global-cart-v1/input/fixtures.json`
 * plus the incident rules in `CONTRACT.md` B3/B5. Probes are *not* drawn from a
 * random stream: every listed expansion has a stable id and a fixed offer time,
 * exactly as required by `workload.json.probePolicy`. The RNG streams in
 * `rng.ts` seed the background trace only.
 *
 * Two invariants this module exists to protect:
 * - A probe is never removed because a prerequisite failed. The denominator is
 *   the literal expansion count and the outcome becomes `DependencyFailed`.
 * - A failed parent step has a frozen fallback offer time; nothing is
 *   rescheduled to hide latency except the two ACK-relative mobility/replay
 *   triggers, which carry an explicit fallback.
 */

import {
  CART_REQUIRED_CASES,
  CART_REGIONS,
  canonicalJson,
  sha256Hex,
  type CartCaseId,
  type CartRegion,
} from '../contracts';
import { cartRequestId } from './rng';

// ---------------------------------------------------------------------------
// Frozen fixture mirrors
// ---------------------------------------------------------------------------

export const CART_MOBILITY = {
  roundsMs: [20_000, 60_000],
  delaysAfterAckMs: [10, 2_000],
  orderedPairs: [
    ['us-west', 'eu-central'],
    ['us-west', 'ap-northeast'],
    ['eu-central', 'us-west'],
    ['eu-central', 'ap-northeast'],
    ['ap-northeast', 'us-west'],
    ['ap-northeast', 'eu-central'],
  ] as readonly (readonly [CartRegion, CartRegion])[],
  count: 24,
} as const;

export const CART_CONCURRENT = {
  roundsMs: [20_000, 60_000],
  kinds: [
    'concurrent-add',
    'change-2-to-3',
    'change-2-to-1',
    'remove-versus-add',
    'removed-old-add-replay',
    'causal-readd',
    'identical-edit-retry',
  ] as const,
  count: 14,
} as const;

export type CartConcurrentKind = (typeof CART_CONCURRENT.kinds)[number];

/**
 * Literal expected live unit sets, mirrored from fixtures.json
 * `quantityOracles`. The production reducer must match these; the enumerator
 * that proves them independently is GC-004's own fixture, not this table.
 */
export const CART_CONCURRENT_LIVE_SETS: Readonly<Record<CartConcurrentKind, readonly string[]>> = {
  'concurrent-add': ['u0', 'u1', 'a', 'b'],
  'change-2-to-3': ['u0', 'u1', 'a', 'b'],
  'change-2-to-1': ['u1'],
  'remove-versus-add': ['a'],
  'removed-old-add-replay': [],
  'causal-readd': ['fresh'],
  'identical-edit-retry': ['u0', 'u1', 'a'],
};

export const CART_PARTITION = {
  boundaryTimesUs: [29_999_999, 30_000_000, 49_999_999, 50_000_000, 54_999_999, 55_000_000],
  directedReadOfferMs: 31_000,
  directedSourceAckMs: 30_500,
  cacheClearOfferMs: 41_000,
  cacheClearEditMs: 39_000,
  newCheckoutOfferMs: 32_000,
  newCheckoutViewMs: 29_000,
  replayOfferMs: 42_000,
  orderPrepAddMs: 25_000,
  orderPrepReadMs: 26_000,
  orderEstablishedMs: 28_000,
  recoveryOfferMs: 54_000,
  recoveryDeadlineMs: 55_000,
} as const;

export const CART_NORMAL_PROBE = {
  readProbeTimesMs: [10_000, 45_000, 80_000],
  preparationLeadMs: 3_000,
  checkoutLeadMs: 1_000,
} as const;

export const CART_CHECKOUT_PROBE = {
  roundsMs: [20_000, 40_000, 60_000],
  families: [
    'race',
    'atomic',
    'known-stock',
    'lost-reply-edit-replay',
    'cart-path-unavailable-replay',
    'ledger-unavailable',
    'conflict',
    'unknown-key-no-evidence',
  ] as const,
  prepAddLeadMs: 4_000,
  prepReadLeadMs: 2_500,
  deadlineMs: 1_000,
} as const;

export type CartCheckoutFamily = (typeof CART_CHECKOUT_PROBE.families)[number];

// ---------------------------------------------------------------------------
// Probe model
// ---------------------------------------------------------------------------

export type CartProbeFamily =
  | 'normal-read'
  | 'mobility'
  | 'concurrent'
  | 'partition-boundary'
  | 'partition-directed-read'
  | 'partition-cache-clear'
  | 'partition-new-checkout'
  | 'partition-replay'
  | 'partition-recovery'
  | 'checkout-race'
  | 'checkout-atomic'
  | 'checkout-known-stock'
  | 'checkout-lost-reply'
  | 'checkout-cart-unavailable'
  | 'checkout-ledger-unavailable'
  | 'checkout-conflict'
  | 'checkout-unknown-key';

export type CartProbeAction = 'add' | 'edit' | 'read' | 'checkout' | 'replay' | 'audit';

export type CartProbeTrigger = 'scheduled' | 'ack-relative' | 'boundary';

/** B3 incident cohort that owns the probe's gate exemption, if any. */
export type CartProbeCohort =
  | 'healthy'
  | 'local-context-edit'
  | 'incident-affected'
  | 'incident-backlog'
  | 'dedicated-probe';

export interface CartProbeDetail {
  readonly [key: string]: string | number | readonly string[];
}

export interface CartProbeStep {
  readonly id: string;
  readonly probeId: string;
  readonly action: CartProbeAction;
  readonly region: CartRegion;
  readonly atUs: number;
  readonly deadlineUs: number | null;
  readonly trigger: CartProbeTrigger;
  /** Frozen fallback offer time when an ACK-relative trigger never fires. */
  readonly fallbackAtUs: number | null;
  readonly dependsOn: readonly string[];
  readonly detail: CartProbeDetail;
}

export type CartProbeExpectation =
  | { readonly kind: 'complete-read'; readonly quantity: number }
  | { readonly kind: 'checkout-success'; readonly stockAfter: Readonly<Record<string, number>>; readonly orders: number; readonly cartQuantity?: number }
  | { readonly kind: 'admissible-stock-set'; readonly alternatives: readonly Readonly<Record<string, number>>[]; readonly orders: number }
  | { readonly kind: 'out-of-stock'; readonly stockAfter: Readonly<Record<string, number>> }
  | { readonly kind: 'unavailable'; readonly stockAfter?: Readonly<Record<string, number>>; readonly reason: string }
  | { readonly kind: 'conflict'; readonly orders: number }
  | { readonly kind: 'validation-failed'; readonly orders: number };

export interface CartProbe {
  /** Stable probe id: case/family/expansion key, never graph-selected. */
  readonly id: string;
  readonly caseId: CartCaseId;
  readonly family: CartProbeFamily;
  readonly region: CartRegion;
  readonly cohort: CartProbeCohort;
  readonly atUs: number;
  readonly deadlineUs: number | null;
  /** Ids of steps or probes whose success this probe depends on. */
  readonly prerequisiteIds: readonly string[];
  readonly steps: readonly CartProbeStep[];
  readonly expected: CartProbeExpectation;
  /** Always 1: a probe is one denominator unit even when it fails. */
  readonly denominator: 1;
}

export const CART_PROBE_EXPECTED_COUNTS: Readonly<Record<CartCaseId, number>> = {
  normal: 9,
  peak: 0,
  mobility: 24,
  concurrent: 14,
  partition: 36,
  checkout: 24,
};

export interface CartProbeSet {
  readonly probes: readonly CartProbe[];
  readonly counts: Readonly<Record<CartCaseId, number>>;
  readonly hash: string;
}

/**
 * Initial Inventory stock declared by a probe's checkout steps (frozen
 * fixtures.json `checkout.<family>.stock`), keyed by the probe's isolated SKU.
 * The model installs these once, before execution; they are initial data, never
 * a mid-run reset. Shapes: `{sku, stock}` or the atomic
 * `{scarceSku, stockScarce, abundantSku, stockAbundant}` pair.
 */
export function declaredCheckoutStock(probe: CartProbe): Readonly<Record<string, number>> {
  const declared: Record<string, number> = {};
  for (const entry of probe.steps) {
    if (entry.action !== 'checkout') continue;
    const detail = entry.detail;
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['sku', 'stock'],
      ['scarceSku', 'stockScarce'],
      ['abundantSku', 'stockAbundant'],
    ];
    for (const [skuKey, stockKey] of pairs) {
      const sku = detail[skuKey];
      const stock = detail[stockKey];
      if (typeof sku === 'string' && typeof stock === 'number') declared[sku] = stock;
    }
  }
  return declared;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function ms(value: number): number {
  return value * 1_000;
}

function step(
  probeId: string,
  part: string,
  action: CartProbeAction,
  region: CartRegion,
  atUs: number,
  deadlineUs: number | null,
  detail: CartProbeDetail,
  dependsOn: readonly string[] = [],
  trigger: CartProbeTrigger = 'scheduled',
  fallbackAtUs: number | null = null,
): CartProbeStep {
  const suffix = part.length > 40 ? part.slice(0, 40) : part;
  return {
    id: `${probeId}:${suffix}`,
    probeId,
    action,
    region,
    atUs,
    deadlineUs,
    trigger,
    fallbackAtUs,
    dependsOn,
    detail,
  };
}

function buildNormalProbes(): CartProbe[] {
  const probes: CartProbe[] = [];
  for (const readAtMs of CART_NORMAL_PROBE.readProbeTimesMs) {
    for (const region of CART_REGIONS) {
      const id = cartRequestId(['probe', 'normal', readAtMs, region]);
      const prep = step(id, 'prep', 'add', region, ms(readAtMs - CART_NORMAL_PROBE.preparationLeadMs), null, {
        sku: 'normal/probe',
        count: 2,
        observedContext: 'empty',
      });
      const read = step(id, 'read', 'read', region, ms(readAtMs), ms(readAtMs + 1_000), {
        expectedQuantity: 2,
        certificateOrigins: CART_REGIONS.length,
      }, [prep.id]);
      const checkout = step(id, 'checkout', 'checkout', region, ms(readAtMs + CART_NORMAL_PROBE.checkoutLeadMs), ms(readAtMs + 2_000), {
        selection: read.id,
        knownStock: 1_000_000,
      }, [read.id]);
      probes.push({
        id,
        caseId: 'normal',
        family: 'normal-read',
        region,
        cohort: 'healthy',
        atUs: ms(readAtMs),
        deadlineUs: ms(readAtMs + 3_000),
        prerequisiteIds: [prep.id],
        steps: [prep, read, checkout],
        expected: { kind: 'complete-read', quantity: 2 },
        denominator: 1,
      });
    }
  }
  return probes;
}

function buildMobilityProbes(): CartProbe[] {
  const probes: CartProbe[] = [];
  for (const roundMs of CART_MOBILITY.roundsMs) {
    for (const pair of CART_MOBILITY.orderedPairs) {
      const [source, destination] = pair;
      for (const delayMs of CART_MOBILITY.delaysAfterAckMs) {
        const id = cartRequestId(['probe', 'mobility', roundMs, `${source}-${destination}`, delayMs]);
        const prep = step(id, 'source-add', 'add', source, ms(roundMs - 3_000), null, {
          count: 2,
          cart: 'mobility',
          observedContext: 'empty',
        });
        // Stale destination view: the destination device reads before the later edit.
        const staleView = step(id, 'stale-view', 'read', destination, ms(roundMs - 2_000), null, {
          expectedQuantity: 2,
          purpose: 'retain stale device view/cache',
        }, [prep.id]);
        const edit = step(id, 'source-add-1', 'add', source, ms(roundMs), ms(roundMs + 1_000), {
          count: 1,
          observes: prep.id,
          origin: source,
        }, [prep.id]);
        const ackRead = step(
          id,
          'ack-read',
          'read',
          destination,
          ms(roundMs + delayMs),
          ms(roundMs + delayMs + 500),
          {
            expectedQuantity: 3,
            token: 'base+add1',
            deadlineMs: 500,
          },
          [edit.id, staleView.id],
          'ack-relative',
          ms(roundMs + 1_000 + delayMs),
        );
        probes.push({
          id,
          caseId: 'mobility',
          family: 'mobility',
          region: source,
          cohort: 'healthy',
          atUs: ms(roundMs),
          deadlineUs: ms(roundMs + delayMs + 500),
          prerequisiteIds: [prep.id, edit.id],
          steps: [prep, staleView, edit, ackRead],
          expected: { kind: 'complete-read', quantity: 3 },
          denominator: 1,
        });
      }
    }
  }
  return probes;
}

function buildConcurrentProbes(): CartProbe[] {
  const probes: CartProbe[] = [];
  for (const roundMs of CART_CONCURRENT.roundsMs) {
    for (const kind of CART_CONCURRENT.kinds) {
      const id = cartRequestId(['probe', 'concurrent', roundMs, kind]);
      const prep = step(id, 'base-add', 'add', 'us-west', ms(roundMs - 3_000), null, {
        count: 2,
        cart: 'concurrent',
        observedContext: 'empty',
      });
      const baseReads = [
        step(id, 'base-read-eu', 'read', 'eu-central', ms(roundMs - 2_000), null, { expectedQuantity: 2 }, [prep.id]),
        step(id, 'base-read-ap', 'read', 'ap-northeast', ms(roundMs - 2_000), null, { expectedQuantity: 2 }, [prep.id]),
      ];
      const actorOne = step(id, 'actor-1', kind === 'identical-edit-retry' ? 'replay' : 'edit', 'us-west', ms(roundMs), ms(roundMs + 1_000), {
        kind,
        binding: kind === 'identical-edit-retry' ? 'original key' : 'distinct key',
        base: 'base-add',
      }, [prep.id]);
      const actorTwo = step(id, 'actor-2', 'edit', 'eu-central', ms(roundMs), ms(roundMs + 1_000), {
        kind,
        binding: kind === 'causal-readd' ? 'removal ACK context' : 'distinct key',
        base: 'base-add',
      }, kind === 'causal-readd' ? [prep.id, actorOne.id] : [prep.id],
      kind === 'causal-readd' ? 'ack-relative' : 'scheduled',
      kind === 'causal-readd' ? ms(roundMs + 1_000) : null);
      const finalReads = CART_REGIONS.map((region) =>
        step(id, `final-${region}`, 'read', region, ms(roundMs + 2_000), ms(roundMs + 3_000), {
          expectedLive: CART_CONCURRENT_LIVE_SETS[kind],
          deadlineMs: 1_000,
        }, [actorOne.id, actorTwo.id]),
      );
      const conflict = step(id, 'conflict-retry', 'replay', 'us-west', ms(roundMs + 4_000), ms(roundMs + 5_000), {
        kind,
        expected: 'IdempotencyConflict',
        payload: 'same key different lines',
      }, [actorOne.id]);
      probes.push({
        id,
        caseId: 'concurrent',
        family: 'concurrent',
        region: 'us-west',
        cohort: 'healthy',
        atUs: ms(roundMs),
        deadlineUs: ms(roundMs + 5_000),
        prerequisiteIds: [prep.id],
        steps: [prep, ...baseReads, actorOne, actorTwo, ...finalReads, conflict],
        expected: { kind: 'complete-read', quantity: CART_CONCURRENT_LIVE_SETS[kind].length },
        denominator: 1,
      });
    }
  }
  return probes;
}

function buildPartitionProbes(): CartProbe[] {
  const probes: CartProbe[] = [];

  // 18 boundary edits: every boundary × every region, distinct isolation carts.
  for (const boundaryUs of CART_PARTITION.boundaryTimesUs) {
    for (const region of CART_REGIONS) {
      const id = cartRequestId(['probe', 'partition', 'boundary', boundaryUs, region]);
      const edit = step(id, 'isolation-add', 'add', region, boundaryUs, boundaryUs + 1_000, {
        count: 1,
        cart: `isolation-${String(boundaryUs)}-${region}`,
        observedContext: 'empty',
        cohort: 'local-context-edit',
      });
      probes.push({
        id,
        caseId: 'partition',
        family: 'partition-boundary',
        region,
        cohort: 'local-context-edit',
        atUs: boundaryUs,
        deadlineUs: boundaryUs + 1_000,
        prerequisiteIds: [],
        steps: [edit],
        expected: { kind: 'complete-read', quantity: 1 },
        denominator: 1,
      });
    }
  }

  // 6 directed-pair reads carrying a source edit ACKed at 30 500 ms.
  for (const pair of CART_MOBILITY.orderedPairs) {
    const [source, destination] = pair;
    const id = cartRequestId(['probe', 'partition', 'directed', `${source}-${destination}`]);
    const prep = step(id, 'source-add', 'add', source, ms(CART_PARTITION.directedSourceAckMs), null, {
      count: 1,
      cart: `directed-${source}-${destination}`,
      observedContext: 'empty',
    });
    const read = step(id, 'directed-read', 'read', destination, ms(CART_PARTITION.directedReadOfferMs), ms(CART_PARTITION.directedReadOfferMs + 1_000), {
      token: 'source-add-ack',
      expectedQuantity: 1,
    }, [prep.id]);
    probes.push({
      id,
      caseId: 'partition',
      family: 'partition-directed-read',
      region: destination,
      cohort: 'incident-affected',
      atUs: ms(CART_PARTITION.directedReadOfferMs),
      deadlineUs: ms(CART_PARTITION.directedReadOfferMs + 1_000),
      prerequisiteIds: [prep.id],
      steps: [prep, read],
      expected: { kind: 'complete-read', quantity: 1 },
      denominator: 1,
    });
  }

  // 3 cache-clear durability reads (edit 39 000 ms, read 41 000 ms after the clear).
  for (const region of CART_REGIONS) {
    const id = cartRequestId(['probe', 'partition', 'cache-clear', region]);
    const edit = step(id, 'durable-add', 'add', region, ms(CART_PARTITION.cacheClearEditMs), null, {
      count: 1,
      cart: `cache-clear-${region}`,
      observedContext: 'empty',
    });
    const read = step(id, 'durable-read', 'read', region, ms(CART_PARTITION.cacheClearOfferMs), ms(CART_PARTITION.cacheClearOfferMs + 1_000), {
      expectedQuantity: 1,
      afterCacheClear: 40_000,
    }, [edit.id]);
    probes.push({
      id,
      caseId: 'partition',
      family: 'partition-cache-clear',
      region,
      cohort: 'healthy',
      atUs: ms(CART_PARTITION.cacheClearOfferMs),
      deadlineUs: ms(CART_PARTITION.cacheClearOfferMs + 1_000),
      prerequisiteIds: [edit.id],
      steps: [edit, read],
      expected: { kind: 'complete-read', quantity: 1 },
      denominator: 1,
    });
  }

  // 3 new known-stock checkouts from a view read at 29 000 ms, offered 32 000 ms.
  for (const region of CART_REGIONS) {
    const id = cartRequestId(['probe', 'partition', 'new-checkout', region]);
    const add = step(id, 'basket-add', 'add', region, ms(CART_PARTITION.orderPrepAddMs), null, {
      count: 1,
      cart: `checkout-${region}`,
      observedContext: 'empty',
    });
    const read = step(id, 'selection-read', 'read', region, ms(CART_PARTITION.newCheckoutViewMs), null, {
      expectedQuantity: 1,
    }, [add.id]);
    const checkout = step(id, 'new-checkout', 'checkout', region, ms(CART_PARTITION.newCheckoutOfferMs), ms(CART_PARTITION.newCheckoutOfferMs + 1_000), {
      selection: read.id,
      knownStock: 1_000_000,
      newKey: 1,
    }, [read.id]);
    probes.push({
      id,
      caseId: 'partition',
      family: 'partition-new-checkout',
      region,
      cohort: 'incident-affected',
      atUs: ms(CART_PARTITION.newCheckoutOfferMs),
      deadlineUs: ms(CART_PARTITION.newCheckoutOfferMs + 1_000),
      prerequisiteIds: [add.id, read.id],
      steps: [add, read, checkout],
      expected: { kind: 'checkout-success', stockAfter: { sku: 999_999 }, orders: 1 },
      denominator: 1,
    });
  }

  // 3 explicit replays of an order established at 28 000 ms, replayed 42 000 ms.
  for (const region of CART_REGIONS) {
    const id = cartRequestId(['probe', 'partition', 'replay', region]);
    const add = step(id, 'basket-add', 'add', region, ms(CART_PARTITION.orderPrepAddMs), null, {
      count: 1,
      cart: `replay-${region}`,
      observedContext: 'empty',
    });
    const read = step(id, 'selection-read', 'read', region, ms(CART_PARTITION.orderPrepReadMs), null, {
      expectedQuantity: 1,
    }, [add.id]);
    const purchase = step(id, 'purchase', 'checkout', region, ms(CART_PARTITION.orderEstablishedMs), ms(CART_PARTITION.orderEstablishedMs + 1_000), {
      selection: read.id,
      knownStock: 1_000_000,
    }, [read.id]);
    const replay = step(id, 'replay', 'replay', region, ms(CART_PARTITION.replayOfferMs), ms(CART_PARTITION.replayOfferMs + 1_000), {
      original: purchase.id,
      expected: 'original result, no second decrement',
    }, [purchase.id]);
    probes.push({
      id,
      caseId: 'partition',
      family: 'partition-replay',
      region,
      cohort: 'incident-backlog',
      atUs: ms(CART_PARTITION.replayOfferMs),
      deadlineUs: ms(CART_PARTITION.replayOfferMs + 1_000),
      prerequisiteIds: [add.id, read.id, purchase.id],
      steps: [add, read, purchase, replay],
      expected: { kind: 'checkout-success', stockAfter: { sku: 999_999 }, orders: 1 },
      denominator: 1,
    });
  }

  // 3 recovery reads at 54 000 ms, delivered by 55 000 ms, T = empty.
  for (const region of CART_REGIONS) {
    const id = cartRequestId(['probe', 'partition', 'recovery', region]);
    const read = step(id, 'recovery-read', 'read', region, ms(CART_PARTITION.recoveryOfferMs), ms(CART_PARTITION.recoveryDeadlineMs), {
      token: 'empty',
      expected: 'complete view covering C',
      deliveryDeadlineMs: CART_PARTITION.recoveryDeadlineMs,
    });
    probes.push({
      id,
      caseId: 'partition',
      family: 'partition-recovery',
      region,
      cohort: 'incident-backlog',
      atUs: ms(CART_PARTITION.recoveryOfferMs),
      deadlineUs: ms(CART_PARTITION.recoveryDeadlineMs),
      prerequisiteIds: [],
      steps: [read],
      expected: { kind: 'complete-read', quantity: 0 },
      denominator: 1,
    });
  }

  return probes;
}

function buildCheckoutProbes(): CartProbe[] {
  const probes: CartProbe[] = [];

  for (const roundMs of CART_CHECKOUT_PROBE.roundsMs) {
    for (const family of CART_CHECKOUT_PROBE.families) {
      const id = cartRequestId(['probe', 'checkout', roundMs, family]);
      const prepAtUs = ms(roundMs - CART_CHECKOUT_PROBE.prepAddLeadMs);
      const readAtUs = ms(roundMs - CART_CHECKOUT_PROBE.prepReadLeadMs);
      const deadlineUs = ms(roundMs + CART_CHECKOUT_PROBE.deadlineMs);
      const steps: CartProbeStep[] = [];
      let expected: CartProbeExpectation;

      const prep = (cart: string, count: number, sku: string): CartProbeStep =>
        step(id, `prep-${cart}`, 'add', 'us-west', prepAtUs, null, {
          count,
          cart,
          sku,
          observedContext: 'empty',
        });
      const read = (cart: string, sku: string, quantity: number, region: CartRegion, depends: string): CartProbeStep =>
        step(id, `read-${cart}`, 'read', region, readAtUs, null, { expectedQuantity: quantity, sku }, [depends]);

      if (family === 'race') {
        const sku = `probe/${roundMs}/race/scarce`;
        const prepStep = prep('race', 1, sku);
        const readStep = read('race', sku, 1, 'us-west', prepStep.id);
        steps.push(prepStep, readStep);
        for (const region of CART_REGIONS) {
          steps.push(step(id, `race-${region}`, 'checkout', region, ms(roundMs), deadlineUs, {
            sku,
            basket: 1,
            stock: 2, // frozen fixtures.json checkout.race.stock.scarce
            offered: 'simultaneous',
          }, [readStep.id]));
        }
        expected = { kind: 'admissible-stock-set', alternatives: [{ [sku]: 0 }], orders: 2 };
      } else if (family === 'atomic') {
        // Frozen fixtures.json atomic case: stock {scarce:1, abundant:10} and two
        // simultaneous multi-line baskets {scarce:1,abundant:2} from us-west and
        // {scarce:1,abundant:3} from eu-central. Both baskets must be prepared
        // through ordinary Add intents and completely read in their own region
        // before either checkout is offered; otherwise the probe can fail at
        // validation instead of exercising Inventory all-or-nothing semantics.
        const scarceSku = `probe/${roundMs}/atomic/scarce`;
        const abundantSku = `probe/${roundMs}/atomic/abundant`;
        const atomicPrep = (
          cart: string,
          region: CartRegion,
          line: 'scarce' | 'abundant',
          sku: string,
          count: number,
        ): CartProbeStep =>
          step(id, `prep-${cart}-${line}`, 'add', region, prepAtUs, null, {
            count,
            cart,
            sku,
            observedContext: 'empty',
          });
        const atomicRead = (
          cart: string,
          region: CartRegion,
          basket: readonly [number, number],
          depends: readonly string[],
        ): CartProbeStep =>
          step(id, `read-${cart}`, 'read', region, readAtUs, null, {
            cart,
            lines: 2,
            skus: [scarceSku, abundantSku],
            expectedLines: [`scarce:${basket[0]}`, `abundant:${basket[1]}`],
            expectedQuantity: basket[0] + basket[1],
          }, depends);

        const usWestCart = 'atomic-us-west';
        const euCentralCart = 'atomic-eu-central';
        const usWestScarcePrep = atomicPrep(usWestCart, 'us-west', 'scarce', scarceSku, 1);
        const usWestAbundantPrep = atomicPrep(usWestCart, 'us-west', 'abundant', abundantSku, 2);
        const euCentralScarcePrep = atomicPrep(euCentralCart, 'eu-central', 'scarce', scarceSku, 1);
        const euCentralAbundantPrep = atomicPrep(euCentralCart, 'eu-central', 'abundant', abundantSku, 3);
        // One complete selected read per cart, issued after *both* local Adds and
        // covering both lines in a single snapshot/token. CONTRACT B4 binds
        // checkout to exactly one selected view; splitting the basket across two
        // reads would make the combination inadmissible evidence.
        const usWestRead = atomicRead(usWestCart, 'us-west', [1, 2], [
          usWestScarcePrep.id,
          usWestAbundantPrep.id,
        ]);
        const euCentralRead = atomicRead(euCentralCart, 'eu-central', [1, 3], [
          euCentralScarcePrep.id,
          euCentralAbundantPrep.id,
        ]);
        steps.push(
          usWestScarcePrep,
          usWestAbundantPrep,
          euCentralScarcePrep,
          euCentralAbundantPrep,
          usWestRead,
          euCentralRead,
        );
        steps.push(step(id, 'atomic-us-west', 'checkout', 'us-west', ms(roundMs), deadlineUs, {
          basketScarce: 1,
          basketAbundant: 2,
          scarceSku,
          abundantSku,
          cart: usWestCart,
          stockScarce: 1,
          stockAbundant: 10,
          selectedRead: usWestRead.id,
        }, [usWestRead.id]));
        steps.push(step(id, 'atomic-eu-central', 'checkout', 'eu-central', ms(roundMs), deadlineUs, {
          basketScarce: 1,
          basketAbundant: 3,
          scarceSku,
          abundantSku,
          cart: euCentralCart,
          stockScarce: 1,
          stockAbundant: 10,
          selectedRead: euCentralRead.id,
        }, [euCentralRead.id]));
        expected = {
          kind: 'admissible-stock-set',
          alternatives: [
            { scarce: 0, abundant: 8 },
            { scarce: 0, abundant: 7 },
          ],
          orders: 1,
        };
      } else if (family === 'known-stock') {
        // Frozen isolatedSkuNamespace: probe/<round>/<family>/<sku>.
        const sku = `probe/${roundMs}/known-stock/sku`;
        const prepStep = prep('known-stock', 1, sku);
        const readStep = read('known-stock', sku, 1, 'us-west', prepStep.id);
        steps.push(
          prepStep,
          readStep,
          step(id, 'purchase', 'checkout', 'us-west', ms(roundMs), deadlineUs, {
            sku,
            basket: 1,
            stock: 10,
          }, [readStep.id]),
        );
        expected = { kind: 'checkout-success', stockAfter: { [sku]: 9 }, orders: 1 };
      } else if (family === 'lost-reply-edit-replay' || family === 'cart-path-unavailable-replay') {
        const sku = `probe/${roundMs}/${family}/sku`;
        const prepStep = prep(family, 1, sku);
        const readStep = read(family, sku, 1, 'us-west', prepStep.id);
        const purchase = step(id, 'purchase', 'checkout', 'us-west', ms(roundMs), deadlineUs, {
          sku,
          basket: 1,
          stock: 10,
        }, [readStep.id]);
        const lostReply =
          family === 'lost-reply-edit-replay'
            ? step(id, 'lose-reply', 'audit', 'us-west', ms(roundMs + 500), null, {
                fault: 'discard first post-commit reply',
              }, [purchase.id])
            : step(id, 'deny-cart-read', 'audit', 'us-west', ms(roundMs + 500), null, {
                fault: 'deny cart-read RPC only for this replay',
                ledgerReachable: 1,
              }, [purchase.id]);
        const addAfter = step(id, 'add-after', 'add', 'us-west', ms(roundMs + 1_500), null, {
          count: 1,
          sku,
          observedContext: purchase.id,
        }, [purchase.id]);
        const replay = step(id, 'explicit-replay', 'replay', 'us-west', ms(roundMs + 3_000), ms(roundMs + 4_000), {
          original: purchase.id,
          cartQuantity: 2,
          attempts: 'Lookup first, no cart read',
        }, [purchase.id, lostReply.id]);
        steps.push(prepStep, readStep, purchase, lostReply, addAfter, replay);
        expected = {
          kind: 'checkout-success',
          stockAfter: { [sku]: 9 },
          orders: 1,
          cartQuantity: 2,
        };
      } else if (family === 'ledger-unavailable') {
        const sku = `probe/${roundMs}/ledger-unavailable/sku`;
        const prepStep = prep('ledger-unavailable', 1, sku);
        const readStep = read('ledger-unavailable', sku, 1, 'us-west', prepStep.id);
        steps.push(
          prepStep,
          readStep,
          step(id, 'deny-inventory', 'audit', 'us-west', ms(roundMs), null, {
            scope: 'this probe only',
          }, [readStep.id]),
          step(id, 'attempt', 'checkout', 'us-west', ms(roundMs), deadlineUs, {
            sku,
            basket: 1,
            stock: 10,
          }, [readStep.id]),
        );
        expected = { kind: 'unavailable', stockAfter: { [sku]: 10 }, reason: 'Inventory unreachable, no stock mutation' };
      } else if (family === 'conflict') {
        const sku = `probe/${roundMs}/conflict/sku`;
        const prepStep = prep('conflict', 1, sku);
        const readStep = read('conflict', sku, 1, 'us-west', prepStep.id);
        steps.push(
          prepStep,
          readStep,
          step(id, 'purchase', 'checkout', 'us-west', ms(roundMs), deadlineUs, {
            sku,
            basket: 1,
            stock: 10,
          }, [readStep.id]),
          step(id, 'conflicting-replay', 'replay', 'us-west', ms(roundMs + 2_000), ms(roundMs + 3_000), {
            expected: 'IdempotencyConflict',
            payload: 'same key different lines/digest',
          }, [readStep.id]),
        );
        expected = { kind: 'conflict', orders: 1 };
      } else {
        const sku = `probe/${roundMs}/unknown-key/sku`;
        const prepStep = prep('unknown-key', 1, sku);
        steps.push(
          prepStep,
          step(id, 'deny-cart-read', 'audit', 'us-west', ms(roundMs), null, {
            scope: 'deny cart-read path',
          }, [prepStep.id]),
          step(id, 'unknown-key', 'checkout', 'us-west', ms(roundMs), deadlineUs, {
            sku,
            noEvidence: 1,
            stock: 10,
          }, [prepStep.id]),
        );
        expected = { kind: 'validation-failed', orders: 0 };
      }

      probes.push({
        id,
        caseId: 'checkout',
        family: family === 'race' ? 'checkout-race'
          : family === 'atomic' ? 'checkout-atomic'
          : family === 'known-stock' ? 'checkout-known-stock'
          : family === 'lost-reply-edit-replay' ? 'checkout-lost-reply'
          : family === 'cart-path-unavailable-replay' ? 'checkout-cart-unavailable'
          : family === 'ledger-unavailable' ? 'checkout-ledger-unavailable'
          : family === 'conflict' ? 'checkout-conflict'
          : 'checkout-unknown-key',
        region: 'us-west',
        cohort: 'dedicated-probe',
        atUs: ms(roundMs),
        deadlineUs,
        prerequisiteIds: steps.filter((entry) => entry.action === 'add' || entry.action === 'read').map((entry) => entry.id),
        steps,
        expected,
        denominator: 1,
      });
    }
  }

  return probes;
}

/** Build the complete mandatory probe set. Pure function; no shared state. */
export function buildCartProbes(): CartProbeSet {
  const probes = [
    ...buildNormalProbes(),
    ...buildMobilityProbes(),
    ...buildConcurrentProbes(),
    ...buildPartitionProbes(),
    ...buildCheckoutProbes(),
  ];
  const counts = {} as Record<CartCaseId, number>;
  for (const caseId of CART_REQUIRED_CASES) counts[caseId] = 0;
  for (const probe of probes) counts[probe.caseId] += 1;
  const expectedCounts = CART_PROBE_EXPECTED_COUNTS;
  for (const caseId of CART_REQUIRED_CASES) {
    if (counts[caseId] !== expectedCounts[caseId]) {
      throw new Error(
        `Cart probes for ${caseId} expanded to ${counts[caseId]}, frozen fixtures require ${expectedCounts[caseId]}.`,
      );
    }
  }
  return {
    probes,
    counts,
    hash: sha256Hex(canonicalJson([...probes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))),
  };
}

// ---------------------------------------------------------------------------
// Failure resolution (denominators never shrink)
// ---------------------------------------------------------------------------

export interface CartProbeFailureResolution {
  readonly scheduled: number;
  readonly offered: number;
  readonly failed: number;
  readonly dependencyFailed: number;
  readonly intact: number;
  readonly outcomes: readonly { readonly id: string; readonly failed: boolean }[];
}

/**
 * Mark failed prerequisites and their transitive dependents. Every probe stays
 * in `outcomes`; the offered denominator equals the scheduled expansion count.
 */
export function resolveCartProbeFailures(
  probes: readonly CartProbe[],
  failedIds: Iterable<string>,
): CartProbeFailureResolution {
  const failed = new Set<string>(failedIds);
  const failedProbes = new Set<string>();
  const outcomes: { id: string; failed: boolean }[] = [];
  let dependencyFailed = 0;

  for (const probe of probes) {
    const direct = failed.has(probe.id) || probe.steps.some((entry) => failed.has(entry.id));
    const inherited = probe.prerequisiteIds.some((dep) => failed.has(dep) || failedProbes.has(dep));
    const isFailed = direct || inherited;
    if (isFailed) {
      if (!direct) dependencyFailed += 1;
      failedProbes.add(probe.id);
      for (const entry of probe.steps) failed.add(entry.id);
    }
    outcomes.push({ id: probe.id, failed: isFailed });
  }

  const failedCount = outcomes.filter((entry) => entry.failed).length;
  return {
    scheduled: probes.length,
    offered: probes.length,
    failed: failedCount,
    dependencyFailed,
    intact: probes.length - failedCount,
    outcomes,
  };
}

/** Probe count for one case; takes no topology argument. */
export function cartProbeCount(caseId: CartCaseId): number {
  return CART_PROBE_EXPECTED_COUNTS[caseId];
}
