import { describe, expect, it } from 'vitest';
import {
  CART_DEFAULT_SEED,
  CART_REGIONS,
  CART_REQUIRED_CASES,
  canonicalJson,
  sha256Hex,
  type CartCaseId,
} from '../contracts';
import {
  CART_CASE_OFFERED_COUNTS,
  CART_WORKLOAD_PROFILE_VERSION,
  buildCartCaseWorkload,
  buildCartWorkload,
  cartCaseOfferedCount,
  cartCaseTraceHash,
  cartWorkloadTraceHash,
  resolveCartIntentFailures,
  type CartCaseWorkload,
} from '../core/workload';
import {
  CART_CONCURRENT,
  CART_MOBILITY,
  CART_PARTITION,
  CART_PROBE_EXPECTED_COUNTS,
  buildCartProbes,
  cartProbeCount,
  resolveCartProbeFailures,
  type CartProbeSet,
} from '../core/challenges';
import {
  CART_STREAM_TAGS,
  cartRequestId,
  createCartCaseStreams,
  createCartRngStream,
  isCartSeed,
} from '../core/rng';

// Building all six cases is the expensive part; do it once and reuse.
const full = buildCartWorkload(CART_DEFAULT_SEED);
const probes: CartProbeSet = buildCartProbes();

function caseOf(caseId: CartCaseId): CartCaseWorkload {
  return full.cases[caseId];
}

function probeById(idPrefix: string) {
  const found = probes.probes.filter((probe) => probe.id.startsWith(idPrefix));
  return found;
}

describe('cart rng streams', () => {
  it('matches the frozen recurrence literally', () => {
    const stream = createCartRngStream(CART_DEFAULT_SEED, CART_STREAM_TAGS.add);
    const x0 = (CART_DEFAULT_SEED ^ Math.imul(CART_STREAM_TAGS.add, 2_654_435_761)) >>> 0;
    expect(stream.state()).toBe(x0);
    const expected = [
      (Math.imul(1_664_525, x0) + 1_013_904_223) >>> 0,
      (Math.imul(1_664_525, ((Math.imul(1_664_525, x0) + 1_013_904_223) >>> 0)) + 1_013_904_223) >>> 0,
    ];
    expect(stream.nextUint32()).toBe(expected[0]);
    expect(stream.nextUint32()).toBe(expected[1]);
  });

  it('keeps streams independent of one another', () => {
    const expectedSku = [createCartRngStream(99, CART_STREAM_TAGS.sku).nextUint32()];
    const streams = createCartCaseStreams(99);
    // Draw heavily from the other streams first.
    for (let i = 0; i < 100; i += 1) {
      streams.add.nextUint32();
      streams.change.nextUint32();
      streams.rotation.nextUint32();
    }
    expect([streams.sku.nextUint32()]).toEqual(expectedSku);
  });

  it('reproduces the same sequence from the same seed and tag', () => {
    const a = createCartRngStream(7, 2);
    const b = createCartRngStream(7, 2);
    const sequenceA = Array.from({ length: 32 }, () => a.drawModulo(100));
    const sequenceB = Array.from({ length: 32 }, () => b.drawModulo(100));
    expect(sequenceB).toEqual(sequenceA);
    expect(new Set(sequenceA).size).toBeGreaterThan(1);
  });

  it('rejects invalid seeds and tags instead of silently coercing', () => {
    expect(isCartSeed(0)).toBe(true);
    expect(isCartSeed(4_294_967_295)).toBe(true);
    expect(isCartSeed(-1)).toBe(false);
    expect(isCartSeed(1.5)).toBe(false);
    expect(() => createCartRngStream(-1, 1)).toThrow(RangeError);
    expect(() => createCartRngStream(1, 0)).toThrow(RangeError);
    expect(() => createCartRngStream(1, 1.5)).toThrow(RangeError);
    expect(() => createCartRngStream(1, 1).drawModulo(0)).toThrow(RangeError);
  });

  it('builds request ids from explicit parts and rejects unsafe part text', () => {
    expect(cartRequestId(['probe', 'mobility', 20_000, 'us-west-eu-central', 10])).toBe(
      'probe:mobility:20000:us-west-eu-central:10',
    );
    expect(() => cartRequestId([])).toThrow();
    expect(() => cartRequestId(['bad part'])).toThrow();
  });
});

describe('background workload', () => {
  it('schedules exactly the frozen offered count for every case', () => {
    expect(CART_CASE_OFFERED_COUNTS).toEqual({
      normal: 54_000,
      peak: 78_000,
      mobility: 54_000,
      concurrent: 54_000,
      partition: 54_000,
      checkout: 54_000,
    });
    for (const caseId of CART_REQUIRED_CASES) {
      const workload = caseOf(caseId);
      expect(workload.scheduled).toBe(CART_CASE_OFFERED_COUNTS[caseId]);
      expect(workload.intents).toHaveLength(CART_CASE_OFFERED_COUNTS[caseId]);
      expect(cartCaseOfferedCount(caseId)).toBe(CART_CASE_OFFERED_COUNTS[caseId]);
      expect(workload.profileVersion).toBe(CART_WORKLOAD_PROFILE_VERSION);
      expect(workload.seed).toBe(CART_DEFAULT_SEED);
    }
  });

  it('derives a topology-independent count from constants only', () => {
    // The count API takes no graph at all; a graph cannot change denominators.
    const offered = cartCaseOfferedCount('peak');
    expect(offered).toBe(78_000);
    expect(cartCaseOfferedCount('normal')).toBe(54_000);
  });

  it('resets every case independently of evaluation order', { timeout: 30_000 }, () => {
    const reversed = [...CART_REQUIRED_CASES].reverse();
    for (const caseId of reversed) {
      const standalone = buildCartCaseWorkload(caseId, CART_DEFAULT_SEED);
      expect(standalone.traceHash).toBe(caseOf(caseId).traceHash);
      expect(standalone.scheduled).toBe(caseOf(caseId).scheduled);
    }
  });

  it('has a stable hash under callback and scheduler changes', { timeout: 60_000 }, () => {
    const observed: string[] = [];
    const withHooks = buildCartWorkload(CART_DEFAULT_SEED, {
      onCaseStart: (caseId) => observed.push(`start:${caseId}`),
      onIntent: () => undefined,
      onCaseEnd: (workload) => observed.push(`end:${workload.caseId}`),
    });
    expect(withHooks.traceHash).toBe(full.traceHash);
    expect(observed).toHaveLength(CART_REQUIRED_CASES.length * 2);
    expect(cartWorkloadTraceHash(withHooks)).toBe(cartWorkloadTraceHash(full));
  });

  it('is insensitive to intent enumeration order but sensitive to content', () => {
    const normal = caseOf('normal');
    const forward = cartCaseTraceHash(normal.intents);
    const shuffled = [...normal.intents].reverse();
    expect(cartCaseTraceHash(shuffled)).toBe(forward);
    expect(forward).toMatch(/^[0-9a-f]{64}$/);
    const mutated = normal.intents.map((intent, index) =>
      index === 0 ? { ...intent, atUs: intent.atUs + 1 } : intent,
    );
    expect(cartCaseTraceHash(mutated)).not.toBe(forward);
  });

  it('uses unique request ids within every case', () => {
    for (const caseId of CART_REQUIRED_CASES) {
      const workload = caseOf(caseId);
      const ids = new Set(workload.intents.map((intent) => intent.id));
      expect(ids.size).toBe(workload.intents.length);
      const keys = new Set(
        workload.intents.map(
          (intent) => `${intent.key.originRegion}|${intent.key.clientId}|${intent.key.requestSequence}`,
        ),
      );
      expect(keys.size).toBe(workload.intents.length);
    }
  });

  it('binds edits to the exact observed prefix and reads to the token', () => {
    const normal = caseOf('normal');
    const byId = new Map(normal.intents.map((intent) => [intent.id, intent]));
    for (const intent of normal.intents) {
      for (const dep of intent.dependsOn) {
        const parent = byId.get(dep);
        expect(parent).toBeDefined();
        if (parent) expect(parent.atUs).toBeLessThanOrEqual(intent.atUs);
      }
      if (intent.operation === 'edit') {
        expect(intent.observedContext).toEqual(intent.dependsOn);
      }
      if (intent.operation === 'read') {
        expect(intent.effect.kind).toBe('read');
        if (intent.effect.kind === 'read') {
          expect(intent.effect.token).toEqual(intent.dependsOn);
        }
      }
      if (intent.operation === 'checkout') {
        const parent = byId.get(intent.dependsOn[0] ?? '');
        expect(parent?.operation).toBe('read');
      }
    }
  });

  it('has peaks add four extra concurrent rounds without touching base counts', () => {
    const normal = caseOf('normal');
    const peak = caseOf('peak');
    expect(peak.scheduled - normal.scheduled).toBe(24_000);
    expect(peak.counts.edits - normal.counts.edits).toBe(24_000 * (10 / 20));
    expect(peak.sessions).toBe(normal.sessions + 4 * 3 * 100);
  });

  it('routes exactly 5% of sessions through a remote read device', () => {
    const normal = caseOf('normal');
    expect(normal.counts.remoteReads).toBe(9 * 3 * 5 * 8);
    expect(normal.counts.remoteReads / normal.counts.reads).toBeCloseTo(0.05, 10);
  });

  it('keeps failed parents in the denominator as dependency failures', () => {
    const normal = caseOf('normal');
    const firstSession = normal.intents.filter((intent) => intent.cartId === 'cart:0000');
    const firstEdit = firstSession.find((intent) => intent.operation === 'edit');
    expect(firstEdit).toBeDefined();
    const resolution = resolveCartIntentFailures(normal.intents, firstEdit ? [firstEdit.id] : []);
    expect(resolution.scheduled).toBe(normal.scheduled);
    expect(resolution.offered).toBe(normal.scheduled);
    expect(resolution.outcomes).toHaveLength(normal.scheduled);
    expect(resolution.failed).toBeGreaterThan(1);
    expect(resolution.dependencyFailed).toBe(resolution.failed - 1);
    expect(resolution.intact).toBe(normal.scheduled - resolution.failed);

    const everything = resolveCartIntentFailures(
      normal.intents,
      normal.intents.map((intent) => intent.id),
    );
    expect(everything.offered).toBe(normal.scheduled);
    expect(everything.outcomes).toHaveLength(normal.scheduled);
    expect(everything.failed).toBe(normal.scheduled);
    expect(everything.intact).toBe(0);
  });
});

describe('mandatory probes', () => {
  it('expands every case to the frozen probe count', () => {
    expect(CART_PROBE_EXPECTED_COUNTS).toEqual({
      normal: 9,
      peak: 0,
      mobility: 24,
      concurrent: 14,
      partition: 36,
      checkout: 24,
    });
    for (const caseId of CART_REQUIRED_CASES) {
      expect(probes.counts[caseId]).toBe(CART_PROBE_EXPECTED_COUNTS[caseId]);
      expect(cartProbeCount(caseId)).toBe(CART_PROBE_EXPECTED_COUNTS[caseId]);
    }
    const ids = new Set(probes.probes.map((probe) => probe.id));
    expect(ids.size).toBe(probes.probes.length);
    const stepIds = probes.probes.flatMap((probe) => probe.steps.map((step) => step.id));
    expect(new Set(stepIds).size).toBe(stepIds.length);
    for (const probe of probes.probes) expect(probe.denominator).toBe(1);
  });

  it('contains every directed mobility pair with both ACK delays and a stale destination view', () => {
    const expanded = new Set<string>();
    const rounds = new Set<string>();
    const byPair = new Map<string, { staleBeforeEdit: number; ackReads: number }>();
    for (const probe of probes.probes.filter((entry) => entry.family === 'mobility')) {
      const [, , roundMs, pair, delayMs] = probe.id.split(':');
      rounds.add(roundMs ?? '');
      expanded.add(`${pair}|${delayMs}`);
      const stale = probe.steps.find((step) => step.id.endsWith(':stale-view'));
      const edit = probe.steps.find((step) => step.id.endsWith(':source-add-1'));
      const ackRead = probe.steps.find((step) => step.id.endsWith(':ack-read'));
      expect(stale).toBeDefined();
      expect(edit).toBeDefined();
      expect(ackRead).toBeDefined();
      if (stale && edit) expect(stale.atUs).toBeLessThan(edit.atUs);
      expect(ackRead?.trigger).toBe('ack-relative');
      expect(ackRead?.fallbackAtUs).not.toBeNull();
      expect(ackRead?.deadlineUs).toBeGreaterThan((ackRead?.atUs ?? 0));
      byPair.set(pair ?? '', { staleBeforeEdit: 1, ackReads: 1 });
      expect(roundMs).toBeDefined();
    }
    expect(expanded.size).toBe(12);
    expect(rounds.size).toBe(CART_MOBILITY.roundsMs.length);
    expect(byPair.size).toBe(6);
    for (const [source, destination] of CART_MOBILITY.orderedPairs) {
      for (const delayMs of CART_MOBILITY.delaysAfterAckMs) {
        expect(expanded.has(`${source}-${destination}|${delayMs}`)).toBe(true);
      }
    }
  });

  it('covers all seven concurrency kinds in both rounds with literal live sets', () => {
    const kinds = new Set<string>();
    const rounds = new Set<string>();
    for (const probe of probes.probes.filter((entry) => entry.family === 'concurrent')) {
      const [, , roundMs, kind] = probe.id.split(':');
      rounds.add(roundMs ?? '');
      kinds.add(kind ?? '');
      const finalRead = probe.steps.find((step) => step.id.endsWith(':final-eu-central'));
      expect(finalRead?.detail.expectedLive).toEqual(
        (await0(kind ?? '') as readonly string[]),
      );
      expect(probe.steps.some((step) => step.id.endsWith(':conflict-retry'))).toBe(true);
    }
    expect(rounds.size).toBe(CART_CONCURRENT.roundsMs.length);
    expect(kinds.size).toBe(CART_CONCURRENT.kinds.length);
    for (const kind of CART_CONCURRENT.kinds) expect(kinds.has(kind)).toBe(true);
  });

  it('includes every partition boundary, incident cohort and recovery deadline', () => {
    const boundaries = new Set<string>();
    for (const probe of probes.probes.filter((entry) => entry.family === 'partition-boundary')) {
      const [, , , boundaryUs] = probe.id.split(':');
      boundaries.add(boundaryUs ?? '');
    }
    for (const boundaryUs of CART_PARTITION.boundaryTimesUs) {
      expect(boundaries.has(String(boundaryUs))).toBe(true);
    }
    expect(boundaries.size).toBe(CART_PARTITION.boundaryTimesUs.length);
    expect(probeById('probe:partition:directed').length).toBe(6);
    expect(probeById('probe:partition:cache-clear').length).toBe(3);
    expect(probeById('probe:partition:new-checkout').length).toBe(3);
    expect(probeById('probe:partition:replay').length).toBe(3);
    const recovery = probeById('probe:partition:recovery');
    expect(recovery.length).toBe(3);
    for (const probe of recovery) {
      expect(probe.deadlineUs).toBe(CART_PARTITION.recoveryDeadlineMs * 1_000);
      expect(probe.steps[0]?.detail.token).toBe('empty');
    }
    const localContext = probes.probes.filter((entry) => entry.cohort === 'local-context-edit');
    expect(localContext).toHaveLength(18);
  });

  it('contains stock races, atomic multi-line checkout and lost-response replays', () => {
    const race = probes.probes.find((entry) => entry.family === 'checkout-race');
    expect(race).toBeDefined();
    const raceCheckouts = race?.steps.filter((step) => step.action === 'checkout') ?? [];
    expect(raceCheckouts).toHaveLength(3);
    expect(new Set(raceCheckouts.map((step) => step.region)).size).toBe(3);
    expect(race?.expected.kind).toBe('admissible-stock-set');
    if (race?.expected.kind === 'admissible-stock-set') {
      expect(race.expected.orders).toBe(2);
      expect(race.expected.alternatives).toHaveLength(1);
    }

    const atomic = probes.probes.find((entry) => entry.family === 'checkout-atomic');
    expect(atomic?.steps.filter((step) => step.action === 'checkout')).toHaveLength(2);
    if (atomic?.expected.kind === 'admissible-stock-set') {
      expect(atomic.expected.orders).toBe(1);
      expect(atomic.expected.alternatives).toEqual([
        { scarce: 0, abundant: 8 },
        { scarce: 0, abundant: 7 },
      ]);
    }

    // Regression: the frozen atomic fixture submits two multi-line baskets and
    // requires ordinary Adds plus a complete selected read of BOTH lines in each
    // participating region before the simultaneous checkouts are offered.
    const atomicProbes = probes.probes.filter((entry) => entry.family === 'checkout-atomic');
    expect(atomicProbes).toHaveLength(3);
    for (const probe of atomicProbes) {
      const checkouts = probe.steps.filter((step) => step.action === 'checkout');
      expect(checkouts.map((step) => step.region)).toEqual(['us-west', 'eu-central']);
      expect(checkouts.map((step) => [step.detail.basketScarce, step.detail.basketAbundant])).toEqual([
        [1, 2],
        [1, 3],
      ]);
      const scarceSku = checkouts[0]?.detail.scarceSku;
      const abundantSku = checkouts[0]?.detail.abundantSku;
      expect(scarceSku).toMatch(/^probe\/\d+\/atomic\/scarce$/);
      expect(abundantSku).toMatch(/^probe\/\d+\/atomic\/abundant$/);

      for (const checkout of checkouts) {
        expect(checkout.detail.scarceSku).toBe(scarceSku);
        expect(checkout.detail.abundantSku).toBe(abundantSku);
        expect(checkout.detail.stockScarce).toBe(1);
        expect(checkout.detail.stockAbundant).toBe(10);
        const cart = checkout.detail.cart;
        const basket: readonly [number, number] = [
          checkout.detail.basketScarce as number,
          checkout.detail.basketAbundant as number,
        ];

        // Both basket lines are prepared in the submitting region with exactly
        // the basket quantities via ordinary Add operations.
        const regionAdds = probe.steps.filter((step) => step.action === 'add' && step.region === checkout.region);
        expect(regionAdds.map((step) => [step.detail.sku, step.detail.count, step.detail.cart])).toEqual([
          [scarceSku, basket[0], cart],
          [abundantSku, basket[1], cart],
        ]);

        // Exactly one complete selected read per cart, issued after both local
        // Adds and covering both lines in a single snapshot (CONTRACT B4).
        const regionReads = probe.steps.filter((step) => step.action === 'read' && step.region === checkout.region);
        expect(regionReads).toHaveLength(1);
        const selectedRead = regionReads[0];
        if (!selectedRead) throw new Error('atomic probe is missing its complete selected read');
        expect(selectedRead.detail).toMatchObject({
          cart,
          lines: 2,
          skus: [scarceSku, abundantSku],
          expectedLines: [`scarce:${basket[0]}`, `abundant:${basket[1]}`],
          expectedQuantity: basket[0] + basket[1],
        });
        expect(selectedRead.dependsOn).toEqual(regionAdds.map((step) => step.id));
        for (const add of regionAdds) expect(selectedRead.atUs).toBeGreaterThan(add.atUs);

        // Checkout is bound to that one read, not to a combination of reads.
        expect(checkout.dependsOn).toEqual([selectedRead.id]);
        expect(checkout.detail.selectedRead).toBe(selectedRead.id);
      }
    }

    const lost = probes.probes.filter((entry) => entry.family === 'checkout-lost-reply');
    expect(lost).toHaveLength(3);
    for (const probe of lost) {
      const fault = probe.steps.find((step) => step.id.endsWith(':lose-reply'));
      const replay = probe.steps.find((step) => step.id.endsWith(':explicit-replay'));
      expect(fault).toBeDefined();
      expect(replay).toBeDefined();
      expect(replay?.detail.attempts).toBe('Lookup first, no cart read');
      expect(probe.expected).toMatchObject({ kind: 'checkout-success', orders: 1, cartQuantity: 2 });
    }

    const cartUnavailable = probes.probes.filter((entry) => entry.family === 'checkout-cart-unavailable');
    expect(cartUnavailable).toHaveLength(3);
    for (const probe of cartUnavailable) {
      expect(probe.steps.some((step) => step.id.endsWith(':deny-cart-read'))).toBe(true);
    }

    for (const family of ['checkout-ledger-unavailable', 'checkout-conflict', 'checkout-unknown-key'] as const) {
      expect(probes.probes.filter((entry) => entry.family === family)).toHaveLength(3);
    }
    const ledger = probes.probes.find((entry) => entry.family === 'checkout-ledger-unavailable');
    expect(ledger?.expected.kind).toBe('unavailable');
    const unknown = probes.probes.find((entry) => entry.family === 'checkout-unknown-key');
    expect(unknown?.expected).toMatchObject({ kind: 'validation-failed', orders: 0 });
  });

  it('keeps dependent probes in the denominator when every prerequisite fails', () => {
    const allIds = probes.probes.flatMap((probe) => [probe.id, ...probe.steps.map((step) => step.id)]);
    const resolution = resolveCartProbeFailures(probes.probes, allIds);
    expect(resolution.scheduled).toBe(probes.probes.length);
    expect(resolution.offered).toBe(probes.probes.length);
    expect(resolution.outcomes).toHaveLength(probes.probes.length);
    expect(resolution.failed).toBe(probes.probes.length);
    expect(resolution.intact).toBe(0);

    // A single preparation failure fails its descendants but removes nothing.
    const mobility = probes.probes.find((probe) => probe.family === 'mobility');
    const prep = mobility?.steps[0];
    expect(prep).toBeDefined();
    const partial = resolveCartProbeFailures(probes.probes, prep ? [prep.id] : []);
    expect(partial.scheduled).toBe(probes.probes.length);
    expect(partial.offered).toBe(probes.probes.length);
    expect(partial.failed).toBeGreaterThanOrEqual(1);
    expect(partial.outcomes.filter((entry) => entry.failed).map((entry) => entry.id)).toContain(mobility?.id);
  });

  it('hashes probe definitions stably across rebuilds', { timeout: 30_000 }, () => {
    const again = buildCartProbes();
    expect(again.hash).toBe(probes.hash);
    expect(again.hash).toBe(sha256Hex(canonicalJson([...again.probes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))));
    expect(probes.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps probe regions inside the frozen region set', () => {
    for (const probe of probes.probes) {
      expect(CART_REGIONS).toContain(probe.region);
      for (const step of probe.steps) expect(CART_REGIONS).toContain(step.region);
    }
  });
});

// Local indirection so the concurrency test can read the literal table without
// importing the production table into the expectation by reference.
function await0(kind: string): readonly string[] {
  return CONCURRENT_LIVE_SETS[kind] ?? [];
}

const CONCURRENT_LIVE_SETS: Readonly<Record<string, readonly string[]>> = {
  'concurrent-add': ['u0', 'u1', 'a', 'b'],
  'change-2-to-3': ['u0', 'u1', 'a', 'b'],
  'change-2-to-1': ['u1'],
  'remove-versus-add': ['a'],
  'removed-old-add-replay': [],
  'causal-readd': ['fresh'],
  'identical-edit-retry': ['u0', 'u1', 'a'],
};
