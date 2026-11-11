/**
 * Safety auditing over complete request records (CONTRACT B5, GC-011).
 *
 * The denominator is every offered request, classified exactly once. There is
 * no success-only denominator: committed, acknowledged, unresolved and rejected
 * requests all remain counted, and dependency failures stay in the denominator.
 */
import type { CartCaseId } from '../contracts';
import type { CartRequestRecord } from './model';

export type CartSafetyClass = 'committed' | 'acknowledged' | 'unresolved' | 'rejected';

export interface CartSafetySummary {
  readonly denominator: number;
  readonly committed: number;
  readonly acknowledged: number;
  readonly unresolved: number;
  readonly rejected: number;
  readonly dependencyFailed: number;
  readonly exempt: number;
  readonly violations: readonly string[];
  readonly pass: boolean;
}

/** Primary class of one record; every record gets exactly one. */
export function safetyClassOf(record: CartRequestRecord): CartSafetyClass {
  if (record.rejected) return 'rejected';
  if (record.committed) return 'committed';
  if (record.acknowledged) return 'acknowledged';
  return 'unresolved';
}

/**
 * Audits durable safety over the full record set:
 * - acknowledged without a recorded delivery is impossible;
 * - rejected and committed are mutually exclusive;
 * - unresolved means offered and undelivered, never silent;
 * - every record is classified, so committed+acknowledged+unresolved+rejected
 *   equals the denominator (no success-only loophole).
 */
export function auditCartSafety(
  records: readonly CartRequestRecord[],
  caseId?: CartCaseId,
): CartSafetySummary {
  const counts: Record<CartSafetyClass, number> = {
    committed: 0,
    acknowledged: 0,
    unresolved: 0,
    rejected: 0,
  };
  const violations: string[] = [];
  let dependencyFailed = 0;
  let exempt = 0;

  for (const record of records) {
    if (caseId !== undefined && record.caseId !== caseId) {
      violations.push(`foreign-case-record:${record.id}`);
      continue;
    }
    counts[safetyClassOf(record)] += 1;
    if (record.dependencyFailed) dependencyFailed += 1;
    if (record.exempt) exempt += 1;
    if (record.acknowledged && record.deliveredUs === null) {
      violations.push(`acknowledged-without-delivery:${record.id}`);
    }
    if (record.committed && record.rejected) {
      violations.push(`committed-and-rejected:${record.id}`);
    }
    if (record.unresolved && record.acknowledged) {
      violations.push(`unresolved-yet-acknowledged:${record.id}`);
    }
    if (record.committed && !record.acknowledged && record.outcome === 'committed') {
      violations.push(`success-outcome-without-ack:${record.id}`);
    }
    if (record.deliveredUs !== null && record.deliveredUs < record.offeredUs) {
      violations.push(`delivery-before-offer:${record.id}`);
    }
  }

  const classified = counts.committed + counts.acknowledged + counts.unresolved + counts.rejected;
  if (classified !== records.length) {
    violations.push(`denominator-mismatch:${classified}/${records.length}`);
  }

  return {
    denominator: records.length,
    committed: counts.committed,
    acknowledged: counts.acknowledged,
    unresolved: counts.unresolved,
    rejected: counts.rejected,
    dependencyFailed,
    exempt,
    violations,
    pass: violations.length === 0 && classified === records.length,
  };
}

export interface CartInventoryAuditInput {
  readonly conservation: { readonly conserved: boolean; readonly violations: readonly string[] } | null;
  readonly orders: readonly { readonly orderKey: string }[];
}

export interface CartInventoryAudit {
  readonly orders: number;
  readonly violations: readonly string[];
  readonly pass: boolean;
}

/**
 * Ordinary-case Inventory invariants, independent of any scripted probe:
 * stock is never negative, remaining + ordered units equal the initial stock
 * for every SKU (no oversell), and each idempotency key has exactly one
 * durable order (no duplicate purchase effect).
 */
export function auditCartInventory(input: CartInventoryAuditInput): CartInventoryAudit {
  const violations: string[] = [];
  if (input.conservation !== null) {
    for (const violation of input.conservation.violations) violations.push(`conservation:${violation}`);
    if (!input.conservation.conserved && input.conservation.violations.length === 0) {
      violations.push('conservation:unspecified');
    }
  }
  const seen = new Set<string>();
  for (const order of input.orders) {
    if (seen.has(order.orderKey)) violations.push(`duplicate-order-effect:${order.orderKey}`);
    seen.add(order.orderKey);
  }
  return { orders: input.orders.length, violations, pass: violations.length === 0 };
}
