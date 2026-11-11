/**
 * Peak cost and score eligibility (CONTRACT B5, GC-011).
 *
 * Peak credit/hour counts rental for every component and purchased circuit over
 * the measured window plus attributable preparation and drain, plus billable
 * WAN bytes. Setup/drain work remains charged after the foreground deadline.
 * An incomplete drain or an execution-cap breach yields no score at all.
 */
import type { CartCaseId, CartGate, CartGraph } from '../contracts';
import { cartPeakScoreCreditsPerHour, createCartResourcePlan } from './resources';

/**
 * Frozen advertised peak budget (DEVELOPER §7): a design must measure
 * `<= 6` credits/hour using the official peak score definition. Exact equality
 * passes. This is a qualification gate, not a price or a tunable.
 */
export const CART_CREDIT_BUDGET_PER_HOUR = 6;

/**
 * Enforces the advertised peak budget at final qualification. A missing or
 * ineligible peak score (no scoreable run) can never silently pass: it is
 * reported with the same `-1` sentinel the case cost uses for "no score".
 */
export function buildCartBudgetGate(
  caseId: CartCaseId,
  scoreCreditsPerHour: number | null,
): CartGate {
  const measured =
    typeof scoreCreditsPerHour === 'number' &&
    Number.isFinite(scoreCreditsPerHour) &&
    scoreCreditsPerHour >= 0;
  const observed = measured ? (scoreCreditsPerHour as number) : -1;
  return {
    code: 'budget-credits-per-hour',
    caseId,
    region: 'us-west',
    operation: 'audit',
    cohort: 'budget:peak:score',
    observed,
    limit: CART_CREDIT_BUDGET_PER_HOUR,
    pass: measured && observed <= CART_CREDIT_BUDGET_PER_HOUR,
    evidenceIds: [],
  };
}

export interface CartCostInput {
  readonly graph: CartGraph;
  readonly wanBillableBytes: number;
  /**
   * Actual physical WAN bytes attributed to charged fixture preparation,
   * measured traffic and drain. Each physical byte belongs to exactly one
   * phase; when all three are supplied their sum must equal
   * `wanBillableBytes` so no byte is billed twice.
   */
  readonly wanPreparationBytes?: number;
  readonly wanMeasuredBytes?: number;
  readonly wanDrainBytes?: number;
  /** Charged preparation time before the measured window (default zero). */
  readonly preparationUs?: number;
  /** Drain time measured to the actual completed final audit. */
  readonly drainUs?: number;
  readonly measuredUs?: number;
  /** False when the drain exceeds its bound, a cap was hit, or it never finished. */
  readonly drainComplete: boolean;
  /** False when the case did not execute (caps, cancellation, unqualified graph). */
  readonly complete: boolean;
}

export interface CartCostBreakdown {
  readonly rentalPerHour: number;
  readonly componentRentalPerHour: number;
  readonly circuitRentalPerHour: number;
  readonly wanBillableBytes: number;
  readonly wanPreparationBytes: number;
  readonly wanMeasuredBytes: number;
  readonly wanDrainBytes: number;
  readonly preparationSeconds: number;
  readonly drainSeconds: number;
  readonly windowSeconds: number;
  /** Null when no score may be awarded; never a fabricated number. */
  readonly scoreCreditsPerHour: number | null;
  readonly scoreEligible: boolean;
  readonly reasons: readonly string[];
}

export function computeCartCost(input: CartCostInput): CartCostBreakdown {
  const plan = createCartResourcePlan(input.graph);
  const measuredUs = input.measuredUs ?? 90_000_000;
  const preparationUs = input.preparationUs ?? 0;
  const drainUs = input.drainUs ?? 0;
  const reasons: string[] = [];
  const wanPreparationBytes = input.wanPreparationBytes ?? 0;
  const wanDrainBytes = input.wanDrainBytes ?? 0;
  const wanMeasuredBytes = input.wanMeasuredBytes ?? input.wanBillableBytes - wanPreparationBytes - wanDrainBytes;
  if (
    [
      wanPreparationBytes,
      wanMeasuredBytes,
      wanDrainBytes,
    ].some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new RangeError('WAN phase bytes must be finite and non-negative');
  }
  if (wanPreparationBytes + wanMeasuredBytes + wanDrainBytes !== input.wanBillableBytes) {
    // Every physical byte is billed exactly once: phases partition the total.
    throw new RangeError('WAN phase bytes must sum to wanBillableBytes');
  }
  if (!input.complete) reasons.push('case-incomplete');
  if (!input.drainComplete) reasons.push('drain-incomplete');
  if (preparationUs > 5_000_000) reasons.push('preparation-over-limit');
  if (drainUs > 10_000_000) reasons.push('drain-over-limit');

  const preparationSeconds = preparationUs / 1_000_000;
  const drainSeconds = drainUs / 1_000_000;
  const windowSeconds = measuredUs / 1_000_000 + preparationSeconds + drainSeconds;
  const scoreEligible = reasons.length === 0;
  const scoreCreditsPerHour = scoreEligible
    ? cartPeakScoreCreditsPerHour({
        rentalPerHour: plan.totalRentalPerHour,
        wanBillableBytes: input.wanBillableBytes,
        measuredSeconds: measuredUs / 1_000_000,
        preparationSeconds,
        drainSeconds,
      })
    : null;

  return {
    rentalPerHour: plan.totalRentalPerHour,
    componentRentalPerHour: plan.componentRentalPerHour,
    circuitRentalPerHour: plan.circuitRentalPerHour,
    wanBillableBytes: input.wanBillableBytes,
    wanPreparationBytes,
    wanMeasuredBytes,
    wanDrainBytes,
    preparationSeconds,
    drainSeconds,
    windowSeconds,
    scoreCreditsPerHour,
    scoreEligible,
    reasons,
  };
}
