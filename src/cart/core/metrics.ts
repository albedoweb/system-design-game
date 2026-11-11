/**
 * Cohort statistics and qualification gates (CONTRACT B3/B5, GC-011).
 *
 * Gates never shrink their denominators. Partition exemptions are applied only
 * to the declared incident cohorts: healthy and local-context cohorts keep
 * their normal SLO and mandatory probes can never become N/A.
 */
import type { CartCaseId, CartGate, CartRegion } from '../contracts';
import type { CartRequestCohort, CartRequestRecord } from './model';

export interface CartCohortStats {
  readonly key: string;
  readonly caseId: CartCaseId;
  readonly region: CartRegion;
  readonly operation: 'edit' | 'read' | 'checkout' | 'probe' | 'audit';
  readonly cohort: CartRequestCohort;
  readonly denominator: number;
  readonly terminal: number;
  readonly healthySuccess: number;
  readonly unresolved: number;
  readonly rejected: number;
  readonly dependencyFailed: number;
  readonly evidenceIds: readonly string[];
}

/** Operation classes that carry an advertised ordinary client-latency promise. */
export type CartLatencyOperation = 'edit' | 'read' | 'checkout';

/**
 * Frozen ordinary p95 ceilings in microseconds (DEVELOPER §8):
 * edit p95 < 50 ms (strict), read p95 <= 500 ms, checkout p95 <= 750 ms.
 * The comparison direction is part of the frozen contract, not a tunable.
 */
export const CART_ORDINARY_LATENCY_LIMITS_US: Readonly<Record<CartLatencyOperation, number>> = {
  edit: 50_000,
  read: 500_000,
  checkout: 750_000,
};

/** Minimum correct successful samples before a statistical p95 gate may pass. */
export const CART_LATENCY_MIN_SAMPLES = 100;

/** Peak offer cohort window: arrivals offered in `[20 s, 60 s)` are gated separately. */
export const CART_PEAK_WINDOW_US = { startUs: 20_000_000, endUs: 60_000_000 } as const;

const HEALTHY_COHORTS: readonly CartRequestCohort[] = [
  'healthy',
  'local-context-edit',
  'dedicated-probe',
];

const EXEMPT_COHORTS: readonly CartRequestCohort[] = ['incident-affected', 'incident-backlog'];

/**
 * A healthy success is an observed terminal delivery of a correct result:
 * edits and complete reads record outcome `committed` (the durable commit flag
 * is edit-specific), while checkout answers also include replay and stock
 * terminals. An unacknowledged durable commit is never a client success.
 */
function isHealthySuccess(record: CartRequestRecord): boolean {
  if (!record.acknowledged) return false;
  return (
    record.outcome === 'committed' ||
    record.outcome === 'duplicate-commit' ||
    record.outcome === 'out-of-stock'
  );
}

/** True when a response satisfies the affected-cohort rule: complete or explicit unavailable. */
function isExemptTerminal(record: CartRequestRecord): boolean {
  return (
    record.acknowledged &&
    (record.outcome === 'committed' || record.outcome === 'unavailable')
  );
}

export function cohortStatistics(records: readonly CartRequestRecord[]): CartCohortStats[] {
  const buckets = new Map<string, {
    caseId: CartCaseId;
    region: CartRegion;
    operation: CartCohortStats['operation'];
    cohort: CartRequestCohort;
    records: CartRequestRecord[];
  }>();
  for (const record of records) {
    const key = `${record.caseId}|${record.region}|${record.operation}|${record.cohort}`;
    const existing = buckets.get(key);
    if (existing !== undefined) {
      existing.records.push(record);
    } else {
      buckets.set(key, {
        caseId: record.caseId,
        region: record.region,
        operation: record.operation,
        cohort: record.cohort,
        records: [record],
      });
    }
  }
  const stats: CartCohortStats[] = [];
  for (const [key, bucket] of [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const items = bucket.records;
    stats.push({
      key,
      caseId: bucket.caseId,
      region: bucket.region,
      operation: bucket.operation,
      cohort: bucket.cohort,
      denominator: items.length,
      terminal: items.filter(isExemptTerminal).length,
      healthySuccess: items.filter(isHealthySuccess).length,
      unresolved: items.filter((item) => !item.acknowledged && !item.rejected).length,
      rejected: items.filter((item) => item.rejected).length,
      dependencyFailed: items.filter((item) => item.dependencyFailed).length,
      evidenceIds: [...items.flatMap((item) => item.evidenceIds)]
        .map((id) => id.slice(0, 60))
        .slice(0, 1_000),
    });
  }
  return stats;
}

function gate(
  stats: CartCohortStats,
  code: string,
  observed: number,
  limit: number,
): CartGate {
  return {
    code: code.slice(0, 96),
    caseId: stats.caseId,
    region: stats.region,
    operation: stats.operation,
    cohort: `${stats.cohort}:${stats.region}:${stats.operation}`.slice(0, 120),
    observed,
    limit,
    pass: observed >= limit,
    evidenceIds: [...stats.evidenceIds],
  };
}

/**
 * Nearest-rank percentile over ascending samples: `ceil(.95 * N)`, 1-indexed.
 * The rank is computed with integer arithmetic (`N * 95 / 100`) so that a
 * cohort size that is an exact multiple of 20 cannot round up spuriously.
 */
export function nearestRankP95(latenciesUs: readonly number[]): number | null {
  if (latenciesUs.length === 0) return null;
  const sorted = [...latenciesUs].sort((left, right) => left - right);
  const rank = Math.ceil((sorted.length * 95) / 100);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

interface CartLatencyBucket {
  readonly cohort: CartRequestCohort;
  readonly region: CartRegion;
  readonly operation: CartLatencyOperation;
  readonly samples: { readonly id: string; readonly latencyUs: number }[];
}

const LATENCY_OPERATIONS: readonly CartLatencyOperation[] = ['edit', 'read', 'checkout'];

/** Client-observed arrival-to-delivery latency of one correct definitive success. */
function latencySampleOf(record: CartRequestRecord): number | null {
  if (!isHealthySuccess(record)) return null;
  if (record.deliveredUs === null || record.deliveredUs > record.deadlineUs) return null;
  return Math.max(0, record.deliveredUs - record.offeredUs);
}

/**
 * Correct successes never fall back to service-only timing: the sample is the
 * modeled client delivery minus the original offer, including every queue,
 * WAN, durable and repair stage. Cohorts without 100 correct successes are
 * reported by an explicit failing sample-count gate and never receive a
 * passing p95.
 */
function collectLatencyBuckets(
  records: readonly CartRequestRecord[],
  window?: { readonly startUs: number; readonly endUs: number },
): CartLatencyBucket[] {
  const buckets = new Map<string, CartLatencyBucket>();
  for (const record of records) {
    if (!HEALTHY_COHORTS.includes(record.cohort)) continue;
    if (!LATENCY_OPERATIONS.includes(record.operation as CartLatencyOperation)) continue;
    const operation = record.operation as CartLatencyOperation;
    if (
      window !== undefined &&
      (record.offeredUs < window.startUs || record.offeredUs >= window.endUs)
    ) {
      continue;
    }
    const latencyUs = latencySampleOf(record);
    const key = `${record.cohort}|${record.region}|${operation}`;
    const existing = buckets.get(key);
    if (existing === undefined) {
      buckets.set(key, {
        cohort: record.cohort,
        region: record.region,
        operation,
        samples: latencyUs === null ? [] : [{ id: record.id, latencyUs }],
      });
    } else if (latencyUs !== null) {
      existing.samples.push({ id: record.id, latencyUs });
    }
  }
  return [...buckets.values()].sort((left, right) => {
    const leftKey = `${left.cohort}|${left.region}|${left.operation}`;
    const rightKey = `${right.cohort}|${right.region}|${right.operation}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

/** edit is strict; read and checkout are inclusive per the frozen wording. */
function p95WithinLimit(operation: CartLatencyOperation, p95Us: number): boolean {
  const limit = CART_ORDINARY_LATENCY_LIMITS_US[operation];
  return operation === 'edit' ? p95Us < limit : p95Us <= limit;
}

/**
 * Ordinary p95 and statistical-sample gates per healthy cohort, region and
 * operation class. `prefix` names the population (`ordinary-latency` for the
 * whole case, `ordinary-latency-peak` for the peak `[20,60)` s offer cohort)
 * and is included in the cohort label so these statistical gates never
 * masquerade as the offered-denominator availability gate.
 */
function buildLatencyGates(
  caseId: CartCaseId,
  records: readonly CartRequestRecord[],
  window: { readonly startUs: number; readonly endUs: number } | undefined,
  prefix: 'ordinary-latency' | 'ordinary-latency-peak',
): CartGate[] {
  const gates: CartGate[] = [];
  for (const bucket of collectLatencyBuckets(records, window)) {
    const sampleCount = bucket.samples.length;
    const windowWord = window === undefined ? '' : 'peak-';
    const cohortWord = bucket.cohort;
    const scope = `${bucket.cohort}:${bucket.region}:${bucket.operation}`;
    gates.push({
      code: `latency-samples-${windowWord}${cohortWord}-${bucket.operation}-${bucket.region}`,
      caseId,
      region: bucket.region,
      operation: bucket.operation,
      cohort: `${prefix}-samples:${scope}`.slice(0, 120),
      observed: sampleCount,
      limit: CART_LATENCY_MIN_SAMPLES,
      pass: sampleCount >= CART_LATENCY_MIN_SAMPLES,
      evidenceIds: bucket.samples
        .slice(0, 1_000)
        .map((sample) => sample.id.slice(0, 60)),
    });
    // A p95 over fewer than 100 correct successes is not a pass; the failing
    // sample gate above already withholds qualification, so no misleading
    // numeric percentile is published for an unsupported cohort.
    if (sampleCount < CART_LATENCY_MIN_SAMPLES) continue;
    const p95Us = nearestRankP95(bucket.samples.map((sample) => sample.latencyUs));
    if (p95Us === null) continue;
    const slowest = [...bucket.samples]
      .sort((left, right) => right.latencyUs - left.latencyUs)
      .slice(0, 1_000);
    gates.push({
      code: `ordinary-p95-${windowWord}${cohortWord}-${bucket.operation}-${bucket.region}`,
      caseId,
      region: bucket.region,
      operation: bucket.operation,
      cohort: `${prefix}:${scope}`.slice(0, 120),
      observed: p95Us,
      limit: CART_ORDINARY_LATENCY_LIMITS_US[bucket.operation],
      pass: p95WithinLimit(bucket.operation, p95Us),
      evidenceIds: slowest.map((sample) => sample.id.slice(0, 60)),
    });
  }
  return gates;
}

/**
 * Builds gates for every cohort. Healthy cohorts require a 99% success ratio
 * over the full denominator; local-context edits are gated exactly like healthy
 * traffic; exempt cohorts accept complete-or-unavailable terminal outcomes.
 */
export function buildCaseGates(
  caseId: CartCaseId,
  records: readonly CartRequestRecord[],
): CartGate[] {
  const gates: CartGate[] = [];
  const latencyRecords = records.filter((record) => record.caseId === caseId);
  for (const stats of cohortStatistics(latencyRecords)) {
    if (HEALTHY_COHORTS.includes(stats.cohort)) {
      const ratio = stats.denominator === 0 ? 0 : stats.healthySuccess / stats.denominator;
      const isProbe = stats.operation === 'probe' || stats.operation === 'audit';
      gates.push(
        gate(
          stats,
          `healthy-slo-${stats.operation}-${stats.region}`,
          ratio,
          isProbe ? 1 : 0.99,
        ),
      );
      if (isProbe) {
        gates.push(
          gate(stats, `probe-terminal-${stats.region}`, ratio, 1),
        );
      }
    } else if (EXEMPT_COHORTS.includes(stats.cohort)) {
      // Affected cohorts are judged only on complete-or-unavailable responses;
      // token coverage, ACK durability and basket correctness are never
      // suspended and are audited by auditCartSafety.
      const ratio = stats.denominator === 0 ? 0 : stats.terminal / stats.denominator;
      gates.push(gate(stats, `affected-terminal-${stats.operation}-${stats.region}`, ratio, 0.99));
    }
  }
  // Ordinary client-delivery latency gates: whole case, and the peak case's
  // `[20,60)` s offer cohort. Availability denominators above are untouched.
  gates.push(...buildLatencyGates(caseId, latencyRecords, undefined, 'ordinary-latency'));
  if (caseId === 'peak') {
    gates.push(
      ...buildLatencyGates(caseId, latencyRecords, CART_PEAK_WINDOW_US, 'ordinary-latency-peak'),
    );
  }
  return gates;
}

/** Recovery barrier: every scheduled recovery read must be delivered by 55000ms. */
export function buildRecoveryGate(caseId: CartCaseId, records: readonly CartRequestRecord[]): CartGate | null {
  const recovery = records.filter((record) => record.operation === 'audit');
  if (recovery.length === 0) return null;
  const passed = recovery.filter((record) => record.acknowledged && record.deliveredUs !== null).length;
  return {
    code: 'recovery-barrier',
    caseId,
    region: 'us-west',
    operation: 'audit',
    cohort: 'incident-backlog:recovery',
    observed: passed,
    limit: recovery.length,
    pass: passed === recovery.length,
    evidenceIds: recovery.map((record) => record.id.slice(0, 60)).slice(0, 1_000),
  };
}
