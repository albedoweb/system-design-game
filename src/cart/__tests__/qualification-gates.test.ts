/**
 * GC-019Q1: ordinary p95 and advertised-budget qualification.
 *
 * These tests exercise the production gate builders that `core/case.ts` and
 * `session.ts` actually call, then prove the same gates reach the public
 * `evaluateCart` boundary on an official negative-control graph. Availability
 * denominators, probe gates and safety gates are asserted untouched.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CartCaseId,
  CartCaseResult,
  CartEvaluation,
  CartGate,
  CartGraph,
  CartRegion,
} from '../contracts';
import { auditCartSafety } from '../core/audit';
import {
  CART_CREDIT_BUDGET_PER_HOUR,
  buildCartBudgetGate,
  computeCartCost,
} from '../core/cost';
import type { CartRequestClass, CartRequestCohort, CartRequestRecord } from '../core/model';
import {
  CART_LATENCY_MIN_SAMPLES,
  CART_ORDINARY_LATENCY_LIMITS_US,
  CART_PEAK_WINDOW_US,
  buildCaseGates,
  nearestRankP95,
} from '../core/metrics';
import { evaluateCart } from '../session';

/**
 * Test-only dependency substitution at `createCartCaseRun` (authorised after
 * review148). It is inert by default, so every other test in this file keeps
 * running the real production case engine; only the controlled session
 * integration below flips it on. The seam substitutes complete case results
 * built from the REAL gate builders and the official cost definition. The
 * public `evaluateCart`, session final qualification, score withholding and the
 * budget comparison are never mocked.
 */
const mockCaseRun = vi.hoisted(() => ({
  active: false,
  build: null as
    | null
    | ((options: import('../core/case').CartCaseRunOptions) => unknown),
}));

vi.mock('../core/case', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/case')>();
  return {
    ...actual,
    createCartCaseRun: (options: import('../core/case').CartCaseRunOptions) => {
      if (mockCaseRun.active && mockCaseRun.build !== null) {
        return mockCaseRun.build(options) as ReturnType<typeof actual.createCartCaseRun>;
      }
      return actual.createCartCaseRun(options);
    },
  };
});

afterEach(() => {
  mockCaseRun.active = false;
  mockCaseRun.build = null;
});

const REGIONS: readonly CartRegion[] = ['us-west', 'eu-central', 'ap-northeast'];
const OPERATIONS: readonly CartRequestClass[] = ['edit', 'read', 'checkout'];

interface RecordOptions {
  readonly id: string;
  readonly region?: CartRegion;
  readonly operation?: CartRequestClass;
  readonly cohort?: CartRequestCohort;
  readonly caseId?: CartCaseId;
  readonly offeredUs?: number;
  /** Client-observed arrival-to-delivery latency in microseconds. */
  readonly latencyUs?: number;
  readonly acknowledged?: boolean;
  readonly outcome?: CartRequestRecord['outcome'];
}

/** Builds one fully modeled request record with an explicit client delivery. */
function record(options: RecordOptions): CartRequestRecord {
  const offeredUs = options.offeredUs ?? 1_000_000;
  const acknowledged = options.acknowledged ?? true;
  const deliveredUs = acknowledged ? offeredUs + (options.latencyUs ?? 1_000) : null;
  return {
    id: options.id,
    caseId: options.caseId ?? 'normal',
    cartId: `cart-${options.id}`,
    region: options.region ?? 'us-west',
    operation: options.operation ?? 'edit',
    cohort: options.cohort ?? 'healthy',
    offeredUs,
    deadlineUs: offeredUs + 1_000_000,
    deliveredUs,
    outcome: options.outcome ?? 'committed',
    committed: acknowledged,
    acknowledged,
    unresolved: !acknowledged,
    rejected: false,
    dependencyFailed: false,
    exempt: false,
    deliveryUs: deliveredUs,
    evidenceIds: [],
  };
}

function samples(options: {
  readonly count: number;
  readonly latencyUs: number;
  readonly prefix: string;
  readonly region?: CartRegion;
  readonly operation?: CartRequestClass;
  readonly cohort?: CartRequestCohort;
  readonly caseId?: CartCaseId;
  readonly offeredUs?: number;
}): CartRequestRecord[] {
  return Array.from({ length: options.count }, (_, index) =>
    record({
      id: `${options.prefix}-${index}`,
      region: options.region,
      operation: options.operation,
      cohort: options.cohort,
      caseId: options.caseId,
      offeredUs: options.offeredUs,
      latencyUs: options.latencyUs,
    }),
  );
}

function findGate(
  gates: ReturnType<typeof buildCaseGates>,
  code: string,
): ReturnType<typeof buildCaseGates>[number] | undefined {
  return gates.find((gate) => gate.code === code);
}

describe('nearest-rank p95', () => {
  it('uses ceil(.95*N) over ascending samples', () => {
    expect(nearestRankP95([])).toBeNull();
    expect(nearestRankP95([7])).toBe(7);
    // 100 samples: rank 95; the 96th..100th slowest values do not affect it.
    const ninetyFiveFast = [
      ...Array.from({ length: 95 }, () => 40_000),
      ...Array.from({ length: 5 }, () => 60_000),
    ];
    expect(nearestRankP95(ninetyFiveFast)).toBe(40_000);
    // One fewer fast sample moves the 95th value into the slow group.
    const ninetyFourFast = [
      ...Array.from({ length: 94 }, () => 40_000),
      ...Array.from({ length: 6 }, () => 60_000),
    ];
    expect(nearestRankP95(ninetyFourFast)).toBe(60_000);
    // 101 samples rank at ceil(95.95) = 96.
    const oneOhOne = [
      ...Array.from({ length: 95 }, () => 1_000),
      ...Array.from({ length: 6 }, () => 2_000),
    ];
    expect(nearestRankP95(oneOhOne)).toBe(2_000);
  });
});

describe('ordinary client-delivery latency gates', () => {
  it('fails the edit p95 while availability stays at 100%', () => {
    const records = samples({ count: 100, latencyUs: 60_000, prefix: 'slow-edit' });
    const gates = buildCaseGates('normal', records);
    const availability = findGate(gates, 'healthy-slo-edit-us-west');
    expect(availability?.observed).toBe(1);
    expect(availability?.pass).toBe(true);
    const p95 = findGate(gates, 'ordinary-p95-healthy-edit-us-west');
    expect(p95?.observed).toBe(60_000);
    expect(p95?.limit).toBe(CART_ORDINARY_LATENCY_LIMITS_US.edit);
    expect(p95?.pass).toBe(false);
    const count = findGate(gates, 'latency-samples-healthy-edit-us-west');
    expect(count?.observed).toBe(100);
    expect(count?.pass).toBe(true);
  });

  it('enforces the exact strict/inclusive threshold boundaries', () => {
    const editAtLimit = buildCaseGates(
      'normal',
      samples({ count: 100, latencyUs: 50_000, prefix: 'edit-at' }),
    );
    expect(findGate(editAtLimit, 'ordinary-p95-healthy-edit-us-west')?.pass).toBe(false);
    const editUnder = buildCaseGates(
      'normal',
      samples({ count: 100, latencyUs: 49_999, prefix: 'edit-under' }),
    );
    expect(findGate(editUnder, 'ordinary-p95-healthy-edit-us-west')?.pass).toBe(true);

    const readAtLimit = buildCaseGates(
      'normal',
      samples({ count: 100, latencyUs: 500_000, prefix: 'read-at', operation: 'read' }),
    );
    expect(findGate(readAtLimit, 'ordinary-p95-healthy-read-us-west')?.pass).toBe(true);
    const readOver = buildCaseGates(
      'normal',
      samples({ count: 100, latencyUs: 500_001, prefix: 'read-over', operation: 'read' }),
    );
    expect(findGate(readOver, 'ordinary-p95-healthy-read-us-west')?.pass).toBe(false);

    const checkoutAtLimit = buildCaseGates(
      'normal',
      samples({ count: 100, latencyUs: 750_000, prefix: 'checkout-at', operation: 'checkout' }),
    );
    expect(findGate(checkoutAtLimit, 'ordinary-p95-healthy-checkout-us-west')?.pass).toBe(true);
    const checkoutOver = buildCaseGates(
      'normal',
      samples({ count: 100, latencyUs: 750_001, prefix: 'checkout-over', operation: 'checkout' }),
    );
    expect(findGate(checkoutOver, 'ordinary-p95-healthy-checkout-us-west')?.pass).toBe(false);
  });

  it('never passes a p95 on fewer than 100 correct successes', () => {
    const records = [
      ...samples({ count: 99, latencyUs: 1_000, prefix: 'fast' }),
      record({ id: 'timeout', acknowledged: false, outcome: 'timeout' }),
    ];
    const gates = buildCaseGates('normal', records);
    // 99/100 still meets the 99% availability floor; the sample floor does not.
    const availability = findGate(gates, 'healthy-slo-edit-us-west');
    expect(availability?.observed).toBe(0.99);
    expect(availability?.pass).toBe(true);
    const count = findGate(gates, 'latency-samples-healthy-edit-us-west');
    expect(count?.observed).toBe(CART_LATENCY_MIN_SAMPLES - 1);
    expect(count?.pass).toBe(false);
    expect(findGate(gates, 'ordinary-p95-healthy-edit-us-west')).toBeUndefined();
  });

  it('publishes a failing sample gate when a healthy cohort has no correct success', () => {
    // Every read is offered but none delivers a correct success: the empty
    // cohort still gets an explicit failing sample gate, never an implicit pass.
    const records = [
      record({ id: 'read-timeout-1', operation: 'read', acknowledged: false, outcome: 'timeout' }),
      record({ id: 'read-timeout-2', operation: 'read', acknowledged: false, outcome: 'timeout' }),
    ];
    const gates = buildCaseGates('normal', records);
    const count = findGate(gates, 'latency-samples-healthy-read-us-west');
    expect(count?.observed).toBe(0);
    expect(count?.limit).toBe(CART_LATENCY_MIN_SAMPLES);
    expect(count?.pass).toBe(false);
    expect(findGate(gates, 'ordinary-p95-healthy-read-us-west')).toBeUndefined();
  });

  it('covers every region and operation class for healthy cohorts only', () => {
    const records: CartRequestRecord[] = [];
    for (const region of REGIONS) {
      for (const operation of OPERATIONS) {
        records.push(
          ...samples({
            count: 100,
            latencyUs: 10_000,
            prefix: `${region}-${operation}`,
            region,
            operation,
          }),
        );
      }
    }
    // Exempt incident cohorts keep their own gate and never contribute a p95.
    records.push(
      ...samples({
        count: 100,
        latencyUs: 900_000,
        prefix: 'exempt',
        region: 'us-west',
        operation: 'probe',
        cohort: 'incident-affected',
      }),
    );
    // Local-context partition edits retain the normal edit latency promise.
    records.push(
      ...samples({
        count: 100,
        latencyUs: 10_000,
        prefix: 'local',
        region: 'us-west',
        cohort: 'local-context-edit',
      }),
    );
    const gates = buildCaseGates('normal', records);
    for (const region of REGIONS) {
      for (const operation of OPERATIONS) {
        expect(findGate(gates, `ordinary-p95-healthy-${operation}-${region}`)?.pass).toBe(true);
        expect(findGate(gates, `latency-samples-healthy-${operation}-${region}`)?.pass).toBe(true);
      }
    }
    const local = findGate(gates, 'ordinary-p95-local-context-edit-edit-us-west');
    expect(local?.pass).toBe(true);
    expect(local?.cohort).toBe('ordinary-latency:local-context-edit:us-west:edit');
    const exemptP95 = gates.filter(
      (gate) => gate.code.startsWith('ordinary-p95-') && gate.cohort.includes('incident'),
    );
    expect(exemptP95).toHaveLength(0);
  });

  it('adds the step peak [20,60) s offer cohort with exact boundaries', () => {
    const records: CartRequestRecord[] = [
      ...samples({
        count: 100,
        latencyUs: 10_000,
        prefix: 'before-window',
        caseId: 'peak',
        offeredUs: CART_PEAK_WINDOW_US.startUs - 1,
      }),
      ...samples({
        count: 100,
        latencyUs: 10_000,
        prefix: 'window-start',
        caseId: 'peak',
        offeredUs: CART_PEAK_WINDOW_US.startUs,
      }),
      ...samples({
        count: 100,
        latencyUs: 10_000,
        prefix: 'window-end-inclusive',
        caseId: 'peak',
        offeredUs: CART_PEAK_WINDOW_US.endUs - 1,
      }),
      ...samples({
        count: 100,
        latencyUs: 10_000,
        prefix: 'at-window-end',
        caseId: 'peak',
        offeredUs: CART_PEAK_WINDOW_US.endUs,
      }),
    ];
    const gates = buildCaseGates('peak', records);
    // Whole case keeps the full offered denominator (400 samples).
    expect(findGate(gates, 'latency-samples-healthy-edit-us-west')?.observed).toBe(400);
    // Peak window is [20 s, 60 s): 200 included, 200 excluded.
    expect(findGate(gates, 'latency-samples-peak-healthy-edit-us-west')?.observed).toBe(200);
    expect(findGate(gates, 'ordinary-p95-peak-healthy-edit-us-west')?.pass).toBe(true);
  });
});

describe('advertised six-credit budget gate', () => {
  it('uses the frozen limit with exact-equality pass', () => {
    expect(CART_CREDIT_BUDGET_PER_HOUR).toBe(6);
    const atLimit = buildCartBudgetGate('peak', 6);
    expect(atLimit.observed).toBe(6);
    expect(atLimit.limit).toBe(6);
    expect(atLimit.pass).toBe(true);
    expect(atLimit.code).toBe('budget-credits-per-hour');
    expect(atLimit.caseId).toBe('peak');
    expect(buildCartBudgetGate('peak', 0).pass).toBe(true);
    const over = buildCartBudgetGate('peak', 6.000_001);
    expect(over.observed).toBe(6.000_001);
    expect(over.pass).toBe(false);
  });

  it('never passes an unmeasured or negative score', () => {
    for (const score of [null, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const gate = buildCartBudgetGate('peak', score);
      expect(gate.observed).toBe(-1);
      expect(gate.pass).toBe(false);
    }
  });

  it('withholds only the budget gate when every other gate passes', () => {
    const records: CartRequestRecord[] = [];
    for (const region of REGIONS) {
      for (const operation of OPERATIONS) {
        records.push(
          ...samples({
            count: 100,
            latencyUs: 10_000,
            prefix: `pass-${region}-${operation}`,
            region,
            operation,
            caseId: 'peak',
            offeredUs: CART_PEAK_WINDOW_US.startUs,
          }),
        );
      }
    }
    const passingGates = buildCaseGates('peak', records);
    expect(passingGates.length).toBeGreaterThan(0);
    expect(passingGates.filter((gate) => !gate.pass)).toEqual([]);

    const composed = [...passingGates, buildCartBudgetGate('peak', 6.25)];
    const failing = composed.filter((gate) => !gate.pass);
    expect(failing).toHaveLength(1);
    expect(failing[0]?.code).toBe('budget-credits-per-hour');
    expect(failing[0]?.observed).toBe(6.25);
    expect(failing[0]?.limit).toBe(6);
  });
});

describe('public evaluation wiring', () => {
  it('runs the committed near-qualifying candidate and withholds its score on budget', () => {
    // The closest committed design (family B at the 8 Mbit tier) passes the
    // probe-oracle and edit latency promises but still fails ordinary read
    // p95/checkout availability capacity gates on this engine. Its official
    // peak score, however, is over budget, and the public boundary must both
    // publish that gate and withhold the final score.
    const fixture = JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'tests/fixtures/cart/candidates/family-b-replicated-stores.json'),
        'utf8',
      ),
    ) as { graph: unknown };
    const evaluation = evaluateCart(fixture.graph, { seed: 1729 });
    const peak = evaluation.cases.find((entry) => entry.id === 'peak');
    expect(peak).toBeDefined();
    expect(peak?.complete).toBe(true);

    const budget = peak?.gates.find((gate) => gate.code === 'budget-credits-per-hour');
    expect(budget).toBeDefined();
    expect(budget?.limit).toBe(CART_CREDIT_BUDGET_PER_HOUR);
    expect(budget?.observed).toBeGreaterThan(CART_CREDIT_BUDGET_PER_HOUR);
    expect(budget?.observed).toBeCloseTo(peak?.cost.peakScoreCreditsPerHour ?? -1, 9);
    expect(budget?.pass).toBe(false);

    // The budget gate alone is not what makes this design unqualified; this
    // engine run also fails capacity gates. The public boundary never awards a
    // score for a failed evaluation.
    expect(evaluation.qualified).toBe(false);
    expect(evaluation.scoreCreditsPerHour).toBeNull();
  }, 180_000);

  it('runs a physically routed over-budget control and withholds its score on budget and latency', () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'tests/fixtures/cart/negative-controls/control-over-budget.json'),
        'utf8',
      ),
    ) as { graph: CartGraph };
    // The old all-local control no longer incurs synthetic WAN/drain charges.
    // Retain its full density and add one real remote read dependency per app
    // (still missing the third origin), so its budget failure measures bytes.
    const regions = ['us-west', 'eu-central', 'ap-northeast'] as const;
    for (const node of fixture.graph.nodes) {
      if (node.kind !== 'application') continue;
      const remote = regions[(regions.indexOf(node.region) + 1) % regions.length]!;
      const target = `journal-${remote}`;
      node.readTargets.push(target);
      fixture.graph.edges.push({id: `budget-remote-${node.id}`, from: node.id, to: target, kind: 'request'});
    }
    const evaluation = evaluateCart(fixture.graph, { seed: 1729 });
    const peak = evaluation.cases.find((entry) => entry.id === 'peak');
    expect(peak).toBeDefined();
    expect(peak?.complete).toBe(true);

    // Local-context edits keep their latency gate and observe real client
    // arrival-to-delivery timing (13,000 correct successes per region).
    const editSamples = peak?.gates.find(
      (gate) => gate.code === 'latency-samples-local-context-edit-edit-us-west',
    );
    expect(editSamples?.observed).toBeGreaterThanOrEqual(CART_LATENCY_MIN_SAMPLES);
    expect(editSamples?.pass).toBe(true);
    const editP95 = peak?.gates.find(
      (gate) => gate.code === 'ordinary-p95-local-context-edit-edit-us-west',
    );
    expect(editP95?.observed).toBeGreaterThan(0);
    expect(editP95?.limit).toBe(CART_ORDINARY_LATENCY_LIMITS_US.edit);
    expect(editP95?.pass).toBe(true);

    // Healthy reads in this control never deliver a correct success, so the
    // cohort publishes a failing sample gate and no passing percentile.
    const readSamples = peak?.gates.find(
      (gate) => gate.code === 'latency-samples-healthy-read-eu-central',
    );
    expect(readSamples?.observed).toBe(0);
    expect(readSamples?.pass).toBe(false);
    expect(
      peak?.gates.find((gate) => gate.code === 'ordinary-p95-healthy-read-eu-central'),
    ).toBeUndefined();

    const budget = peak?.gates.find((gate) => gate.code === 'budget-credits-per-hour');
    expect(budget).toBeDefined();
    expect(budget?.limit).toBe(CART_CREDIT_BUDGET_PER_HOUR);
    expect(budget?.observed).toBeGreaterThan(CART_CREDIT_BUDGET_PER_HOUR);
    expect(budget?.observed).toBeCloseTo(peak?.cost.peakScoreCreditsPerHour ?? -1, 9);
    expect(budget?.pass).toBe(false);

    // The hard gate reaches final qualification and the score.
    expect(evaluation.qualified).toBe(false);
    expect(evaluation.scoreCreditsPerHour).toBeNull();
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Review148-authorised controlled session integration.
//
// The committed candidate graphs cannot pass every non-budget gate on this
// engine, so an otherwise-passing public run does not exist. Instead of
// weakening gates, this block substitutes `createCartCaseRun` with complete,
// otherwise-passing case results. The results are assembled by the REAL
// `buildCaseGates`, the REAL `auditCartSafety`, the REAL `computeCartCost`
// (official 90 s measured-window score definition) and the REAL
// `buildCartBudgetGate`. `evaluateCart`, session final qualification, the
// budget comparison and score withholding stay untouched production code.
//
// This is controlled session integration, NOT a full physical-engine or
// gameplay-feasibility proof. The real graph runs above remain the evidence
// that the runtime emits real cost and gate rows.
// ---------------------------------------------------------------------------
type ControlledRun = ReturnType<typeof import('../core/case').createCartCaseRun>;

type ControlledPeakCost =
  | { readonly kind: 'official'; readonly wanBillableBytes: number }
  | { readonly kind: 'unscoreable' };

/** 100 correct client success samples per healthy region/operation. */
function controlledPassingRecords(caseId: CartCaseId): CartRequestRecord[] {
  const records: CartRequestRecord[] = [];
  for (const region of REGIONS) {
    for (const operation of OPERATIONS) {
      records.push(
        ...samples({
          count: 100,
          latencyUs: 10_000,
          prefix: `controlled-${caseId}-${region}-${operation}`,
          region,
          operation,
          caseId,
          offeredUs: caseId === 'peak' ? CART_PEAK_WINDOW_US.startUs : 1_000_000,
        }),
      );
    }
  }
  return records;
}

/**
 * One complete case result whose availability, ordinary p95, sample-count,
 * safety and (for peak) budget gates come from the production builders. The
 * peak cost is the official `computeCartCost` score over the frozen 90 s
 * measured window; `unscoreable` forces a genuinely ineligible cost (an
 * incomplete drain), which the official definition scores as null.
 */
function controlledCaseResult(
  caseId: CartCaseId,
  graph: CartGraph,
  peakCost: ControlledPeakCost,
): CartCaseResult {
  const isPeak = caseId === 'peak';
  const unscoreable = isPeak && peakCost.kind === 'unscoreable';
  const records = controlledPassingRecords(caseId);
  const gates: CartGate[] = [...buildCaseGates(caseId, records)];
  const audit = auditCartSafety(records, caseId);
  gates.push({
    code: 'safety-audit',
    caseId,
    region: 'us-west',
    operation: 'audit',
    cohort: 'all-requests',
    observed: audit.violations.length === 0 ? audit.denominator : 0,
    limit: audit.denominator,
    pass: audit.pass,
    evidenceIds: [],
  });
  const cost = computeCartCost({
    graph,
    wanBillableBytes: isPeak && peakCost.kind === 'official' ? peakCost.wanBillableBytes : 0,
    measuredUs: 90_000_000,
    drainComplete: !unscoreable,
    complete: true,
  });
  const score = cost.scoreCreditsPerHour;
  if (isPeak) gates.push(buildCartBudgetGate(caseId, score));
  return {
    id: caseId,
    scheduled: 1_300,
    issued: 1_300,
    dependencyFailed: 0,
    outcomes: { committed: 1_300 },
    gates,
    resources: { events: 1_300, requests: 1_300, chargedBusyMs: 0, wanBillableBytes: 0 },
    cost: {
      rentalPerHour: cost.rentalPerHour,
      wanCredits: cost.wanBillableBytes / 1_073_741_824,
      preparationSeconds: cost.preparationSeconds,
      drainSeconds: cost.drainSeconds,
      windowSeconds: cost.windowSeconds,
      peakScoreCreditsPerHour: score ?? -1,
    },
    complete: true,
  };
}

/** Controlled run whose single event step completes the case for the session. */
function controlledRun(
  options: import('../core/case').CartCaseRunOptions,
  peakCost: ControlledPeakCost,
): ControlledRun {
  const model = {
    events: 0,
    measuredEndUs: 90_000_000,
    step(): boolean {
      model.events = 1;
      return true;
    },
  };
  return {
    model: model as unknown as ControlledRun['model'],
    scheduled: 1_300,
    complete: () => ({
      result: controlledCaseResult(options.caseId, options.graph, peakCost),
      model: model as unknown as ControlledRun['model'],
    }),
  };
}

function evaluateControlled(graph: CartGraph, peakCost: ControlledPeakCost): CartEvaluation {
  mockCaseRun.active = true;
  mockCaseRun.build = (options) => controlledRun(options, peakCost);
  try {
    // Public boundary: the real parser, session and final qualification run.
    return evaluateCart(graph, { seed: 1729 });
  } finally {
    mockCaseRun.active = false;
    mockCaseRun.build = null;
  }
}

function qualifiedGraph(): CartGraph {
  const fixture = JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'tests/fixtures/cart/candidates/family-b-replicated-stores.json'),
      'utf8',
    ),
  ) as { graph: CartGraph };
  return fixture.graph;
}

const PEAK_BUDGET_CODE = 'budget-credits-per-hour';

function failingGates(evaluation: CartEvaluation): { caseId: CartCaseId; code: string }[] {
  return evaluation.cases.flatMap((entry) =>
    entry.gates.filter((gate) => !gate.pass).map((gate) => ({ caseId: entry.id, code: gate.code })),
  );
}

describe('public evaluation: controlled otherwise-passing session integration', () => {
  // Official 90 s score at family-B rental 4.32: 3600/90 * (4.32 + WAN/GiB).
  // One byte is worth ~1.49e-8 credits/hour, so these integer counts straddle
  // the frozen limit while keeping the official formula and integer traffic.
  const AT_LIMIT_BELOW = 45_097_156; // 5.999999977350235 credits/hour
  const AT_LIMIT_ABOVE = 45_097_157; // 6.000000014603138 credits/hour
  const OVER_BUDGET = 50_465_866; // 6.20000001013279 credits/hour

  function officialScore(graph: CartGraph, wanBillableBytes: number): number {
    const cost = computeCartCost({
      graph,
      wanBillableBytes,
      measuredUs: 90_000_000,
      drainComplete: true,
      complete: true,
    });
    expect(cost.scoreEligible).toBe(true);
    return cost.scoreCreditsPerHour as number;
  }

  it('qualifies and awards the official score when peak cost is at or under six', () => {
    const graph = qualifiedGraph();
    const expected = officialScore(graph, AT_LIMIT_BELOW);
    expect(expected).toBeLessThan(6);
    const evaluation = evaluateControlled(graph, {
      kind: 'official',
      wanBillableBytes: AT_LIMIT_BELOW,
    });
    expect(evaluation.complete).toBe(true);
    expect(evaluation.qualified).toBe(true);
    expect(evaluation.scoreCreditsPerHour).toBe(expected);

    const peak = evaluation.cases.find((entry) => entry.id === 'peak');
    expect(peak).toBeDefined();
    const budget = peak?.gates.find((gate) => gate.code === PEAK_BUDGET_CODE);
    expect(budget).toBeDefined();
    expect(budget?.limit).toBe(CART_CREDIT_BUDGET_PER_HOUR);
    expect(budget?.observed).toBe(expected);
    expect(budget?.pass).toBe(true);
    expect(peak?.cost.peakScoreCreditsPerHour).toBe(expected);
    // Every other gate really passed: availability denominators, the sample
    // floors and the ordinary p95 promises are all present and green.
    expect(failingGates(evaluation)).toEqual([]);
    const readSamples = peak?.gates.find(
      (gate) => gate.code === 'latency-samples-healthy-read-eu-central',
    );
    expect(readSamples?.observed).toBe(100);
    expect(readSamples?.pass).toBe(true);
  });

  it('withholds qualification and score when every other gate passes but budget alone fails', () => {
    const graph = qualifiedGraph();
    const expected = officialScore(graph, OVER_BUDGET);
    expect(expected).toBeGreaterThan(6);
    const evaluation = evaluateControlled(graph, {
      kind: 'official',
      wanBillableBytes: OVER_BUDGET,
    });
    expect(evaluation.complete).toBe(true);
    expect(evaluation.qualified).toBe(false);
    expect(evaluation.scoreCreditsPerHour).toBeNull();
    expect(failingGates(evaluation)).toEqual([{ caseId: 'peak', code: PEAK_BUDGET_CODE }]);

    const peak = evaluation.cases.find((entry) => entry.id === 'peak');
    const budget = peak?.gates.find((gate) => gate.code === PEAK_BUDGET_CODE);
    expect(budget?.observed).toBe(expected);
    expect(budget?.limit).toBe(6);
    expect(budget?.pass).toBe(false);
    expect(budget?.observed).toBeGreaterThan(budget?.limit ?? Number.NaN);
  });

  it('treats six as inclusive: one byte below passes, one byte above fails budget only', () => {
    const graph = qualifiedGraph();
    const below = officialScore(graph, AT_LIMIT_BELOW);
    const above = officialScore(graph, AT_LIMIT_ABOVE);
    expect(below).toBeLessThanOrEqual(6);
    expect(above).toBeGreaterThan(6);

    const passing = evaluateControlled(graph, {
      kind: 'official',
      wanBillableBytes: AT_LIMIT_BELOW,
    });
    expect(passing.qualified).toBe(true);
    expect(passing.scoreCreditsPerHour).toBe(below);

    const failing = evaluateControlled(graph, {
      kind: 'official',
      wanBillableBytes: AT_LIMIT_ABOVE,
    });
    expect(failing.complete).toBe(true);
    expect(failing.qualified).toBe(false);
    expect(failing.scoreCreditsPerHour).toBeNull();
    expect(failingGates(failing)).toEqual([{ caseId: 'peak', code: PEAK_BUDGET_CODE }]);
    const budget = failing.cases
      .find((entry) => entry.id === 'peak')
      ?.gates.find((gate) => gate.code === PEAK_BUDGET_CODE);
    expect(budget?.observed).toBe(above);
    expect(budget?.limit).toBe(6);
    expect(budget?.pass).toBe(false);
  });

  it('never passes a missing or invalid official peak cost', () => {
    const graph = qualifiedGraph();
    const evaluation = evaluateControlled(graph, { kind: 'unscoreable' });
    expect(evaluation.complete).toBe(true);
    expect(evaluation.qualified).toBe(false);
    expect(evaluation.scoreCreditsPerHour).toBeNull();
    expect(failingGates(evaluation)).toEqual([{ caseId: 'peak', code: PEAK_BUDGET_CODE }]);
    const peak = evaluation.cases.find((entry) => entry.id === 'peak');
    expect(peak?.cost.peakScoreCreditsPerHour).toBe(-1);
    const budget = peak?.gates.find((gate) => gate.code === PEAK_BUDGET_CODE);
    expect(budget?.observed).toBe(-1);
    expect(budget?.limit).toBe(6);
    expect(budget?.pass).toBe(false);
  });
});
