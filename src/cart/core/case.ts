/**
 * Case orchestration (GC-011): frozen workload + probes -> model -> audit ->
 * gates -> cost. A case result keeps its offered denominator even when the
 * topology or the runtime budget prevents execution.
 */
import {
  CART_REQUIRED_CASES,
  type CartCaseId,
  type CartCaseResult,
  type CartGate,
  type CartGraph,
} from '../contracts';
import { observeCartRun } from './observations';
import { auditCartInventory, auditCartSafety } from './audit';
import { auditCartProbes } from './probe-oracle';
import { buildCartBudgetGate, computeCartCost } from './cost';
import {
  CART_DRAIN_LIMIT_US,
  CartCaseModel,
  analyzeCartTopology,
  type CartTopologyFacts,
} from './model';
import { buildCaseGates, buildRecoveryGate } from './metrics';
import { CART_PROBE_EXPECTED_COUNTS, buildCartProbes } from './challenges';
import {
  CART_CASE_OFFERED_COUNTS,
  CART_DEFAULT_WORKLOAD_PROFILE,
  buildCartCaseWorkload,
  type CartWorkloadProfile,
} from './workload';

export interface CartCaseRunOptions {
  readonly graph: CartGraph;
  readonly caseId: CartCaseId;
  readonly seed: number;
  readonly facts?: CartTopologyFacts;
  /** Explicit workload profile; defaults to the adopted desync profile. */
  readonly workloadProfile?: CartWorkloadProfile;
  /** Testing hook overriding the profile's measured window. */
  readonly measuredUs?: number;
  readonly drainUs?: number;
  readonly runtimeBudgetMs?: number;
  readonly now?: () => number;
  /** Optional pre-step hook used by the session to interleave cases. */
  readonly onStep?: (caseId: CartCaseId, done: boolean) => void;
}

export interface CartCaseRun {
  readonly result: CartCaseResult;
  readonly model: CartCaseModel;
}

function topologyGate(caseId: CartCaseId, code: string): CartGate {
  return {
    code,
    caseId,
    region: 'us-west',
    operation: 'probe',
    cohort: 'topology',
    observed: 0,
    limit: 1,
    pass: false,
    evidenceIds: [],
  };
}

/** Builds the deterministic case run. The session drives it in event slices. */
export function createCartCaseRun(options: CartCaseRunOptions): {
  readonly model: CartCaseModel;
  readonly scheduled: number;
  readonly complete: () => CartCaseRun;
} {
  const profile = options.workloadProfile ?? CART_DEFAULT_WORKLOAD_PROFILE;
  const workload = buildCartCaseWorkload(options.caseId, options.seed, profile);
  const facts = options.facts ?? analyzeCartTopology(options.graph);
  // Fault-free profiles disable the scripted advanced probes entirely; the
  // expected probe count of such a case is therefore zero (never "exempted").
  const probes = profile.faultFree
    ? []
    : buildCartProbes().probes.filter((probe) => probe.caseId === options.caseId);
  const expectedProbes = profile.faultFree ? 0 : CART_PROBE_EXPECTED_COUNTS[options.caseId];
  const model = new CartCaseModel(options.caseId, facts, workload.intents, probes, options.graph, {
    measuredUs: options.measuredUs ?? profile.measuredUs,
    faultFree: profile.faultFree,
    drainUs: options.drainUs,
    runtimeBudgetMs: options.runtimeBudgetMs,
    now: options.now,
  });
  const scheduled = workload.scheduled + probes.length;

  const complete = (): CartCaseRun => {
    const records = model.requestRecords;
    const audit = auditCartSafety(records, options.caseId);
    // Frozen per-probe oracle: post-execution comparison against CartProbe.expected.
    // It observes the finished case only and never feeds scheduling or responses.
    const oracle = auditCartProbes(probes, {
      records,
      reads: model.readResults,
      stock: model.inventoryStock,
      orders: model.inventoryOrders,
      cartQuantity: (cartId) => model.cartLiveQuantity(cartId),
    });
    const gates: CartGate[] = [];
    if (!facts.qualified) {
      gates.push(topologyGate(options.caseId, 'topology-qualified'));
    }
    gates.push(...buildCaseGates(options.caseId, records));
    gates.push({
      code: 'safety-audit',
      caseId: options.caseId,
      region: 'us-west',
      operation: 'audit',
      cohort: 'all-requests',
      observed: audit.violations.length === 0 ? audit.denominator : 0,
      limit: audit.denominator,
      pass: audit.pass,
      evidenceIds: audit.violations.map((violation) => violation.slice(0, 60)).slice(0, 1_000),
    });
    // Ordinary-case Inventory invariants hold even with zero scripted probes.
    const inventoryAudit = auditCartInventory({
      conservation: model.inventoryConservation,
      orders: model.inventoryOrders,
    });
    gates.push({
      code: 'inventory-invariants',
      caseId: options.caseId,
      region: 'us-west',
      operation: 'audit',
      cohort: 'all-requests',
      observed: inventoryAudit.pass ? inventoryAudit.orders + 1 : 0,
      limit: inventoryAudit.orders + 1,
      pass: inventoryAudit.pass,
      evidenceIds: inventoryAudit.violations.map((violation) => violation.slice(0, 60)).slice(0, 1_000),
    });
    const recovery = buildRecoveryGate(options.caseId, records);
    if (recovery !== null) gates.push(recovery);
    // Mandatory per-probe oracle gates: every scheduled frozen probe is either
    // qualified or withholds the case score; no probe can be exempted.
    gates.push(...oracle.gates);

    const drainComplete = model.drainEndUs <= model.measuredEndUs + CART_DRAIN_LIMIT_US;
    const issued = model.issuedCount;
    const expectedCaseCount = CART_CASE_OFFERED_COUNTS[options.caseId];
    const scheduledIntact = workload.scheduled === expectedCaseCount;
    const complete =
      facts.qualified &&
      !model.exceededResourceLimit &&
      issued >= scheduled &&
      scheduledIntact &&
      probes.length === expectedProbes;
    const cost = computeCartCost({
      graph: options.graph,
      wanBillableBytes: model.wanBillableBytes,
      wanPreparationBytes: model.wanPreparationBillableBytes,
      wanDrainBytes: model.wanDrainBillableBytes,
      wanMeasuredBytes:
        model.wanBillableBytes -
        model.wanPreparationBillableBytes -
        model.wanDrainBillableBytes,
      preparationUs: model.preparationUs,
      // Actual measured window of the effective profile (never a hardcoded 90 s).
      measuredUs: model.measuredEndUs,
      drainUs: model.actualDrainUs,
      drainComplete: drainComplete && (options.drainUs ?? CART_DRAIN_LIMIT_US) <= CART_DRAIN_LIMIT_US,
      complete,
    });

    // The advertised budget is the final hard gate on the score: the peak
    // case's official cost must measure <= 6 credits/hour. An otherwise
    // passing but over-budget design therefore withholds its score.
    if (options.caseId === 'peak') {
      gates.push(buildCartBudgetGate(options.caseId, cost.scoreCreditsPerHour));
    }

    const outcomes: Record<string, number> = {};
    for (const record of records) {
      outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1;
      outcomes[`cohort:${record.cohort}`] = (outcomes[`cohort:${record.cohort}`] ?? 0) + 1;
    }
    outcomes.scheduled = scheduled;
    outcomes.issued = issued;
    outcomes.auditFailures = audit.violations.length;
    outcomes.probeOracleAudited = oracle.audited;
    outcomes.probeOracleFailures = oracle.failed;

    const result: CartCaseResult = {
      observation: observeCartRun(model, options.graph),
      id: options.caseId,
      scheduled,
      issued,
      dependencyFailed: audit.dependencyFailed,
      outcomes,
      gates,
      resources: {
        events: model.events,
        requests: issued,
        chargedBusyMs: model.chargedBusyUs / 1_000,
        wanBillableBytes: model.wanBillableBytes,
      },
      cost: {
        rentalPerHour: cost.rentalPerHour,
        wanCredits: cost.wanBillableBytes / 1_073_741_824,
        preparationSeconds: cost.preparationSeconds,
        drainSeconds: cost.drainSeconds,
        windowSeconds: cost.windowSeconds,
        peakScoreCreditsPerHour: cost.scoreCreditsPerHour ?? -1,
      },
      complete,
    };
    return { result, model };
  };

  return { model, scheduled, complete };
}

/** Runs one case to completion. Used by focused tests and by evaluateCart. */
export function runCartCase(options: CartCaseRunOptions): CartCaseRun {
  const run = createCartCaseRun(options);
  while (!run.model.step(Number.POSITIVE_INFINITY)) {
    // step returns done
  }
  return run.complete();
}

export const CART_CASE_ORDER = [...CART_REQUIRED_CASES] as readonly CartCaseId[];
