/**
 * Strict response validation for the trusted simulation worker.
 *
 * The worker is product code, but a miscompiled or corrupted worker must not
 * be able to complete a job with a partial or self-contradictory
 * ParcelEvaluation. This module checks the frozen P200 result shape, including
 * both mandatory horizons and the status-specific empty/null/error contract.
 * It does not re-run the simulation or recompute model numbers.
 */

import {
  PARCEL_BUSINESS_OPERATIONS,
  PARCEL_CONTENT_VERSION,
  PARCEL_LEVEL_ID,
  PARCEL_MAX_SEED,
  PARCEL_MODEL_VERSION,
  PARCEL_PRICING_VERSION,
  PARCEL_REQUIRED_HORIZONS,
  PARCEL_SCHEMA_VERSION,
} from '../../../src/parcel/index.js';
import {
  IMAGE_BUSINESS_OPERATIONS,
  IMAGE_LEVEL,
  IMAGE_LEVEL_ID,
  IMAGE_MODEL_VERSION,
  IMAGE_REQUIRED_SCENARIOS,
  imageEvaluationSchema,
  type ImageEvaluation,
  type ImageScenarioResult,
  type ImageScenarioWindow,
} from '../../../src/images/index.js';
import {
  SCOREBOARD_CATALOG,
  SCOREBOARD_LEVEL,
  SCOREBOARD_LEVEL_ID,
  parseScoreboardEvaluation,
  type ScoreboardEvaluation,
  type ScoreboardGate,
  type ScoreboardOperationMetrics,
} from '../../../src/scoreboard/index.js';
import {
  COLD_CACHE_LEVEL_ID,
  coldCacheEvaluationSchema,
} from '../../../src/simulation/legacy-schema.js';
import {
  AUDIENCE_AVAILABILITY_SLO,
  AUDIENCE_CONTENT_VERSION,
  AUDIENCE_DRAIN_MS,
  AUDIENCE_FAULT_CRITICAL_WINDOW,
  AUDIENCE_FAULT_SCHEDULE,
  AUDIENCE_FRESHNESS_MS,
  AUDIENCE_LEVEL_ID,
  AUDIENCE_MEASURED_MS,
  AUDIENCE_MIN_LATENCY_SAMPLES,
  AUDIENCE_MODEL_VERSION,
  AUDIENCE_NETWORK_POLICY,
  AUDIENCE_PEAK_WINDOW,
  AUDIENCE_PRICING_VERSION,
  AUDIENCE_PROFILE_VERSION,
  AUDIENCE_SCHEMA_VERSION,
  AUDIENCE_SUCCESSFUL_P95_MS,
  audienceRequiredCaseIds,
  audienceRequiredGateSpecs,
  parseAudienceEvaluation,
  type AudienceCaseResult,
  type AudienceEvaluation,
  type AudienceGate,
  type AudienceGateSpec,
  type AudienceNodeMetrics,
  type AudienceOperationMetrics,
} from '../../../src/audience/index.js';
import type { EngineRunExpectation } from '../../../src/simulation/contracts.js';
import {
  CART_LEVEL_ID,
  CART_MAX_SEED,
  CART_REQUIRED_CASES,
  CART_VERSIONS,
  cartEvaluationSchema,
  type CartEvaluation,
} from '../../../src/cart/index.js';
import { microUsdToUsd } from '../../../src/domain/catalog.js';
import { DEFAULT_LEVEL } from '../../../src/domain/level.js';
import { buildChecks } from '../../../src/engine/result.js';
import { ClassMetrics } from '../../../src/engine/metrics.js';

const ISSUE_SEVERITIES = new Set(['error', 'warning', 'info']);
const CHECK_SEVERITIES = new Set(['required', 'advisory']);
const BUSINESS_OPERATIONS = new Set<string>(PARCEL_BUSINESS_OPERATIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegative(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && isNonNegative(value);
}

function isHorizonYears(value: unknown): value is 1 | 5 {
  return value === 1 || value === 5;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isHorizonList(value: unknown): value is (1 | 5)[] {
  return (
    Array.isArray(value) &&
    value.every(isHorizonYears) &&
    new Set(value).size === value.length
  );
}

function isExactHorizons(value: unknown, expected: readonly number[]): boolean {
  return (
    isHorizonList(value) &&
    value.length === expected.length &&
    value.every((year, index) => year === expected[index])
  );
}

function isIssue(value: unknown): boolean {
  return (
    isRecord(value) &&
    ISSUE_SEVERITIES.has(value.severity as string) &&
    isNonEmptyString(value.code) &&
    isString(value.message) &&
    isOptionalString(value.nodeId) &&
    isOptionalString(value.edgeId) &&
    (value.horizonYears === undefined || isHorizonYears(value.horizonYears))
  );
}

function isDiagnostic(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    ISSUE_SEVERITIES.has(value.severity as string) &&
    isNonEmptyString(value.code) &&
    isString(value.message) &&
    isOptionalString(value.nodeId) &&
    isOptionalString(value.edgeId) &&
    isOptionalString(value.operation) &&
    (value.horizonYears === undefined || isHorizonYears(value.horizonYears)) &&
    isOptionalNumber(value.value) &&
    isOptionalNumber(value.limit)
  );
}

function isCheck(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.label) &&
    typeof value.passed === 'boolean' &&
    CHECK_SEVERITIES.has(value.severity as string) &&
    isString(value.message) &&
    (value.horizonYears === undefined || isHorizonYears(value.horizonYears)) &&
    isOptionalString(value.operation) &&
    isOptionalString(value.nodeId) &&
    isOptionalString(value.unit) &&
    isOptionalNumber(value.actual) &&
    isOptionalNumber(value.limit)
  );
}

function isCounts(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return [
    'sampled',
    'offered',
    'success',
    'failed',
    'rejected',
    'timedOut',
    'missedData',
    'stale',
    'unfinished',
  ].every((key) => isNonNegativeInteger(value[key]));
}

function isErrorsByCode(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every((count) => isNonNegativeInteger(count))
  );
}

function isOperationMetrics(value: unknown, expected: string): boolean {
  return (
    isRecord(value) &&
    value.operation === expected &&
    isFiniteNumber(value.sampleFactor) &&
    value.sampleFactor > 0 &&
    isCounts(value.counts) &&
    isFiniteNumber(value.availability) &&
    value.availability >= 0 &&
    value.availability <= 1 &&
    isNonNegative(value.latencyP50Ms) &&
    isNonNegative(value.latencyP95Ms) &&
    isNonNegative(value.latencyP99Ms) &&
    isNonNegativeInteger(value.timeoutCount) &&
    isNonNegativeInteger(value.rejectCount) &&
    isNonNegative(value.successP95Ms) &&
    isNonNegative(value.queueWaitP95Ms) &&
    (value.freshnessP95Ms === null || isNonNegative(value.freshnessP95Ms)) &&
    (value.freshnessMaxMs === null || isNonNegative(value.freshnessMaxMs)) &&
    isNonNegative(value.rowsScanned) &&
    isNonNegative(value.bytesRead) &&
    isNonNegative(value.bytesWritten) &&
    isNonNegative(value.estimatedThroughputPerSec) &&
    isErrorsByCode(value.errorsByCode)
  );
}

function isOperations(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === BUSINESS_OPERATIONS.size &&
    keys.every((key) => BUSINESS_OPERATIONS.has(key)) &&
    PARCEL_BUSINESS_OPERATIONS.every((operation) =>
      isOperationMetrics(value[operation], operation),
    )
  );
}

function isWorkload(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegative(value.durationMs) &&
    isNonNegative(value.drainMs) &&
    isNonNegative(value.simulationEndMs) &&
    isFiniteNumber(value.sampleFactor) &&
    value.sampleFactor > 0 &&
    isNonNegativeInteger(value.sampledRequests) &&
    isNonNegativeInteger(value.estimatedOfferedRequests) &&
    isNonNegativeInteger(value.scheduledReports) &&
    isNonNegativeInteger(value.oldHistoryRequests) &&
    isNonNegativeInteger(value.eventBudget) &&
    isNonNegativeInteger(value.processedEvents) &&
    typeof value.exhausted === 'boolean' &&
    isNonNegativeInteger(value.keyspace) &&
    isString(value.causalTimestamps)
  );
}

function isNodeOperation(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.requests) &&
    isNonNegativeInteger(value.completed) &&
    isNonNegativeInteger(value.errors) &&
    isNonNegativeInteger(value.timedOut) &&
    isNonNegative(value.p95Ms)
  );
}

function isNodeMetrics(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value.nodeId) &&
    isNonEmptyString(value.kind) &&
    isString(value.label) &&
    isNonNegativeInteger(value.requests) &&
    isNonNegativeInteger(value.completed) &&
    isNonNegativeInteger(value.errors) &&
    isNonNegativeInteger(value.timedOut) &&
    isNonNegativeInteger(value.rejected) &&
    isFiniteNumber(value.averageCpuUtilization) &&
    isFiniteNumber(value.peakCpuUtilization) &&
    isFiniteNumber(value.averageIoUtilization) &&
    isFiniteNumber(value.peakIoUtilization) &&
    isFiniteNumber(value.averageNetworkUtilization) &&
    isFiniteNumber(value.peakNetworkUtilization) &&
    isNonNegative(value.averageQueueDepth) &&
    isNonNegative(value.peakQueueDepth) &&
    isNonNegative(value.queueWaitP95Ms) &&
    isNonNegative(value.bytesRead) &&
    isNonNegative(value.bytesWritten) &&
    isRecord(value.operations) &&
    Object.values(value.operations).every(isNodeOperation)
  );
}

function isStoreUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.nodeId) &&
    isNonEmptyString(value.kind) &&
    isStringArray(value.roles) &&
    isNonNegativeInteger(value.retentionYears) &&
    isHorizonYears(value.horizonYears) &&
    isNonNegative(value.rawEventBytes) &&
    isNonNegative(value.physicalEventBytes) &&
    isNonNegative(value.indexBytes) &&
    isNonNegative(value.latestStatusBytes) &&
    isNonNegative(value.rollupBytes) &&
    isNonNegative(value.bucketOverheadBytes) &&
    isNonNegative(value.totalUsedBytes) &&
    isNonNegative(value.totalUsedTb) &&
    isNonNegative(value.provisionedTb) &&
    isNonNegative(value.utilization) &&
    typeof value.capacityOk === 'boolean' &&
    isOptionalString(value.replicatedFrom) &&
    isNonEmptyString(value.compression) &&
    isNonEmptyString(value.index) &&
    isNonEmptyString(value.partition)
  );
}

function isCapacity(value: unknown, expectedHorizon: 1 | 5): boolean {
  return (
    isRecord(value) &&
    value.horizonYears === expectedHorizon &&
    Array.isArray(value.stores) &&
    value.stores.length > 0 &&
    value.stores.every(isStoreUsage) &&
    isNonNegative(value.rawEventBytes) &&
    isNonNegative(value.physicalBytes) &&
    isNonNegative(value.indexBytes) &&
    isNonNegative(value.latestStatusBytes) &&
    isNonNegative(value.rollupBytes) &&
    isNonNegative(value.totalUsedTb) &&
    isNonNegative(value.totalProvisionedTb) &&
    isNonNegativeInteger(value.replicationCopies) &&
    isNonNegative(value.replicationFactor) &&
    isNonNegativeInteger(value.retentionYearsRequired) &&
    typeof value.retentionOk === 'boolean' &&
    typeof value.capacityOk === 'boolean' &&
    isStringArray(value.notes)
  );
}

function isNodeCost(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.nodeId) &&
    isNonEmptyString(value.kind) &&
    isNonEmptyString(value.size) &&
    isNonNegative(value.computeMonthlyUsd) &&
    isNonNegative(value.provisionedStorageTb) &&
    isNonNegative(value.storageMonthlyUsd) &&
    isNonNegative(value.totalMonthlyUsd)
  );
}

function isCost(value: unknown, expectedHorizons: readonly string[]): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.currency !== 'USD' ||
    !isNonEmptyString(value.pricingVersion) ||
    !isNonNegative(value.monthlyUsd) ||
    !isNonNegative(value.computeMonthlyUsd) ||
    !isNonNegative(value.storageMonthlyUsd) ||
    !isNonNegative(value.fiveYearTcoUsd) ||
    !isNonNegative(value.computeHours) ||
    !isNonNegativeInteger(value.tcoMonths) ||
    !isNonNegative(value.provisionedStorageTb) ||
    !isNonNegative(value.replicationFactor) ||
    !Array.isArray(value.byNode) ||
    value.byNode.length === 0 ||
    !value.byNode.every(isNodeCost) ||
    !isNonNegative(value.budgetMonthlyUsd) ||
    typeof value.withinBudget !== 'boolean' ||
    !isString(value.note) ||
    !isRecord(value.usedStorageTbByHorizon)
  ) {
    return false;
  }
  const used = value.usedStorageTbByHorizon;
  const keys = Object.keys(used);
  return (
    keys.length === expectedHorizons.length &&
    keys.every((key) => expectedHorizons.includes(key)) &&
    expectedHorizons.every((key) => isNonNegative(used[key]))
  );
}

interface CheckExpectation {
  readonly horizon: 1 | 5;
  /** `null` means the check must not name an operation. */
  readonly operation: string | null;
  /** `null` means the check must not name a node. */
  readonly nodeId: string | null;
}

const MANDATORY_BASE_CHECKS: readonly {
  readonly id: string;
  readonly operation: string | null;
}[] = [
  { id: 'freshness:status', operation: 'status' },
  { id: 'freshness:report', operation: 'report' },
  { id: 'retention', operation: null },
  { id: 'capacity', operation: null },
  { id: 'workload_complete', operation: null },
  { id: 'data_integrity', operation: null },
  { id: 'durable_ack', operation: 'ingest' },
  { id: 'budget', operation: null },
];

function hasUniqueCheckIds(checks: readonly unknown[]): boolean {
  const ids = new Set<string>();
  for (const check of checks) {
    if (
      !isRecord(check) ||
      typeof check.id !== 'string' ||
      ids.has(check.id)
    ) {
      return false;
    }
    ids.add(check.id);
  }
  return true;
}

function hasRequiredHorizonCheck(
  checks: readonly unknown[],
  id: string,
  expectation: CheckExpectation,
): boolean {
  const matches = checks.filter(
    (check) => isRecord(check) && check.id === id,
  );
  if (matches.length !== 1) {
    return false;
  }
  const check = matches[0];
  if (!isRecord(check) || check.severity !== 'required') {
    return false;
  }
  if (
    check.horizonYears !== undefined &&
    check.horizonYears !== expectation.horizon
  ) {
    return false;
  }
  if (expectation.operation === null) {
    if (check.operation !== undefined) {
      return false;
    }
  } else if (check.operation !== expectation.operation) {
    return false;
  }
  if (expectation.nodeId === null) {
    if (check.nodeId !== undefined) {
      return false;
    }
  } else if (check.nodeId !== expectation.nodeId) {
    return false;
  }
  return true;
}

/**
 * Contract completeness for one horizon. The core remains the only place
 * that computes these gates; this guard only requires the complete fixed set
 * to be present with unique IDs and the expected operation/node context.
 */
function hasMandatoryHorizonChecks(
  checks: readonly unknown[],
  stores: readonly { nodeId: string }[],
  horizon: 1 | 5,
): boolean {
  if (!hasUniqueCheckIds(checks)) {
    return false;
  }
  if (
    horizon === 1 &&
    checks.some((check) => isRecord(check) && check.id === 'historical_cohort')
  ) {
    return false;
  }

  for (const operation of PARCEL_BUSINESS_OPERATIONS) {
    for (const prefix of ['availability', 'p95', 'non_zero'] as const) {
      if (
        !hasRequiredHorizonCheck(checks, `${prefix}:${operation}`, {
          horizon,
          operation,
          nodeId: null,
        })
      ) {
        return false;
      }
    }
  }
  for (const required of MANDATORY_BASE_CHECKS) {
    if (
      !hasRequiredHorizonCheck(checks, required.id, {
        horizon,
        operation: required.operation,
        nodeId: null,
      })
    ) {
      return false;
    }
  }
  if (
    horizon === 5 &&
    !hasRequiredHorizonCheck(checks, 'historical_cohort', {
      horizon,
      operation: 'history',
      nodeId: null,
    })
  ) {
    return false;
  }

  const storageChecks = checks.filter(
    (check) =>
      isRecord(check) &&
      typeof check.id === 'string' &&
      check.id.startsWith('storage_capacity:'),
  );
  if (storageChecks.length !== stores.length) {
    return false;
  }
  for (const store of stores) {
    if (
      !hasRequiredHorizonCheck(checks, `storage_capacity:${store.nodeId}`, {
        horizon,
        operation: null,
        nodeId: store.nodeId,
      })
    ) {
      return false;
    }
  }
  return true;
}

function isHorizonResult(value: unknown, expectedHorizon: 1 | 5): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const checks = value.checks;
  if (!Array.isArray(checks) || checks.length === 0 || !checks.every(isCheck)) {
    return false;
  }
  const capacity = value.capacity;
  if (!isCapacity(capacity, expectedHorizon)) {
    return false;
  }
  if (
    !isHorizonYears(value.horizonYears) ||
    value.horizonYears !== expectedHorizon ||
    typeof value.passed !== 'boolean' ||
    !isWorkload(value.workload) ||
    !isOperations(value.operations) ||
    !Array.isArray(value.nodes) ||
    value.nodes.length === 0 ||
    !value.nodes.every(isNodeMetrics) ||
    !isCost(value.cost, [String(expectedHorizon)]) ||
    !Array.isArray(value.diagnostics) ||
    !value.diagnostics.every(isDiagnostic)
  ) {
    return false;
  }
  const stores = (capacity as { stores: readonly { nodeId: string }[] }).stores;
  if (!hasMandatoryHorizonChecks(checks, stores, expectedHorizon)) {
    return false;
  }
  return (
    value.passed ===
    checks.every(
      (check) => check.severity !== 'required' || check.passed === true,
    )
  );
}

function isMeta(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.schemaVersion === PARCEL_SCHEMA_VERSION &&
    value.modelVersion === PARCEL_MODEL_VERSION &&
    value.pricingVersion === PARCEL_PRICING_VERSION &&
    value.contentVersion === PARCEL_CONTENT_VERSION &&
    value.levelId === PARCEL_LEVEL_ID &&
    Number.isInteger(value.seed) &&
    isFiniteNumber(value.seed) &&
    (value.graphDigest === null ||
      (isNonEmptyString(value.graphDigest) &&
        value.graphDigest.length <= 128)) &&
    isHorizonList(value.requestedHorizons) &&
    isExactHorizons(value.requiredHorizons, PARCEL_REQUIRED_HORIZONS) &&
    isFiniteNumber(value.sampleFactor) &&
    value.sampleFactor > 0
  );
}

function isErrorValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.code) &&
    /^[a-z][a-z0-9_]{0,63}$/.test(value.code) &&
    isNonEmptyString(value.message) &&
    value.message.length <= 500
  );
}

function hasRequiredCheck(
  checks: readonly unknown[],
  id: string,
  expectedPassed?: boolean,
  expectedHorizon?: 1 | 5,
): boolean {
  const check = checks.find(
    (candidate) => isRecord(candidate) && candidate.id === id,
  );
  if (!isRecord(check) || check.severity !== 'required') {
    return false;
  }
  if (expectedHorizon !== undefined && check.horizonYears !== expectedHorizon) {
    return false;
  }
  return expectedPassed === undefined || check.passed === expectedPassed;
}

/**
 * True only for a complete, internally consistent ParcelEvaluation.
 * `status: "ok"` requires both mandatory horizons, per-horizon operations,
 * capacity/cost and the horizon checks. Invalid/error results require the
 * documented empty arrays, null capacity/cost and `passed: false`.
 */
/**
 * Binding supplied by the trusted adapter and checked against every worker
 * result. The graph digest never includes the seed; the seed is checked
 * separately, and the exact model version prevents cross-model digest reuse.
 */
export interface EngineResultBinding {
  readonly levelId: string;
  readonly modelVersion: string;
  readonly seed: number;
  readonly graphDigest: string | null;
  /**
   * Versioned contract identity. Legacy levels historically bound only the
   * model version; newer adapters require the exact schema/content/pricing
   * identity as well.
   */
  readonly schemaVersion?: number;
  readonly contentVersion?: string;
  readonly pricingVersion?: string;
  /** Challenge-profile identity for levels that publish one. */
  readonly profileVersion?: string;
  /**
   * Exact qualification expectation derived from the submitted graph. Used by
   * the Live Audience guard; other levels leave it undefined.
   */
  readonly expectation?: EngineRunExpectation;
  /**
   * Frozen mandatory case ids derived from the registered level, never from a
   * result. Global Cart sets them so omitted or retargeted cases are rejected.
   */
  readonly requiredCaseIds?: readonly string[];
}

interface ColdCheckSpec {
  readonly id: string;
  readonly target: number;
  readonly unit: '%' | 'ms' | '$/h';
}

/**
 * The exact nine gates emitted by the frozen `buildChecks` for `DEFAULT_LEVEL`.
 * Empty metrics and zero cost are used only to obtain stable IDs/targets/units;
 * actual values are always tied to the submitted result.
 */
const COLD_CHECK_SPECS = new Map<string, ColdCheckSpec>(
  buildChecks(DEFAULT_LEVEL, new ClassMetrics(), new ClassMetrics(), 0).map(
    (check) => [
      check.id,
      { id: check.id, target: check.target, unit: check.unit },
    ],
  ),
);

const COLD_BUDGET_MICRO_USD = DEFAULT_LEVEL.budgetMicroUsdPerHour;

interface ColdSnapshotMetric {
  readonly offered: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly pending: number;
  readonly p95Ms: number | null;
}

/**
 * Final Cold snapshots are terminal. Every offered request must be resolved
 * (`pending === 0`) and all terminal counts must be conserved.
 */
function readColdSnapshotMetric(value: unknown): ColdSnapshotMetric | null {
  if (!isRecord(value)) {
    return null;
  }
  const offered = value.offered;
  const succeeded = value.succeeded;
  const failed = value.failed;
  const pending = value.pending;
  const p95Ms = value.p95Ms;
  if (
    !isNonNegativeInteger(offered) ||
    !isNonNegativeInteger(succeeded) ||
    !isNonNegativeInteger(failed) ||
    !isNonNegativeInteger(pending) ||
    pending !== 0 ||
    succeeded + failed !== offered ||
    (p95Ms !== null && (!isFiniteNumber(p95Ms) || p95Ms < 0))
  ) {
    return null;
  }
  return { offered, succeeded, failed, pending, p95Ms };
}

function sameNullableNumber(
  actual: number | null,
  expected: number | null,
): boolean {
  if (actual === null || expected === null) {
    return actual === expected;
  }
  return Math.abs(actual - expected) <= 1e-9;
}

function expectedCheckPassed(
  spec: ColdCheckSpec,
  actual: number | null,
): boolean {
  if (actual === null || actual < 0) {
    return false;
  }
  if (spec.unit === '%') {
    return actual <= 100 && actual + 1e-9 >= spec.target;
  }
  return actual <= spec.target + 1e-9;
}

function availabilityOf(metric: ColdSnapshotMetric): number | null {
  return metric.offered === 0 ? null : (metric.succeeded / metric.offered) * 100;
}

/**
 * Validate the complete Cold `RunResult` evidence, not just a non-empty list.
 * The real engine always emits exactly the nine `buildChecks` gates, and a pass
 * must be consistent with the returned cost/snapshot summary.
 */
function isColdRunResultConsistent(
  result: {
    readonly passed: boolean;
    readonly costMicroUsdPerHour: number;
    readonly checks: readonly {
      readonly id: string;
      readonly actual: number | null;
      readonly target: number;
      readonly unit: '%' | 'ms' | '$/h';
      readonly passed: boolean;
    }[];
    readonly snapshot: { readonly phase: string; readonly reads: unknown; readonly writes: unknown };
  },
  envelopePassed: boolean,
): boolean {
  if (result.passed !== envelopePassed) {
    return false;
  }
  const reads = readColdSnapshotMetric(result.snapshot.reads);
  const writes = readColdSnapshotMetric(result.snapshot.writes);
  if (
    result.snapshot.phase !== 'completed' ||
    reads === null ||
    writes === null
  ) {
    return false;
  }

  const seen = new Set<string>();
  for (const check of result.checks) {
    const spec = COLD_CHECK_SPECS.get(check.id);
    if (
      spec === undefined ||
      seen.has(check.id) ||
      check.unit !== spec.unit ||
      !sameNullableNumber(check.target, spec.target)
    ) {
      return false;
    }
    seen.add(check.id);
    if (
      (check.unit === '%' &&
        check.actual !== null &&
        (check.actual < 0 || check.actual > 100)) ||
      check.passed !== expectedCheckPassed(spec, check.actual)
    ) {
      return false;
    }

    switch (check.id) {
      case 'read-availability':
        if (!sameNullableNumber(check.actual, availabilityOf(reads))) {
          return false;
        }
        break;
      case 'write-availability':
        if (!sameNullableNumber(check.actual, availabilityOf(writes))) {
          return false;
        }
        break;
      case 'read-p95':
        if (!sameNullableNumber(check.actual, reads.p95Ms)) {
          return false;
        }
        break;
      case 'write-p95':
        if (!sameNullableNumber(check.actual, writes.p95Ms)) {
          return false;
        }
        break;
      case 'cost':
        if (
          !sameNullableNumber(
            check.actual,
            microUsdToUsd(result.costMicroUsdPerHour),
          ) ||
          check.passed !==
            (result.costMicroUsdPerHour <= COLD_BUDGET_MICRO_USD)
        ) {
          return false;
        }
        break;
      default:
        break;
    }
  }
  if (seen.size !== COLD_CHECK_SPECS.size) {
    return false;
  }
  return result.passed === result.checks.every((check) => check.passed);
}

/**
 * Cold Cache result guard. The envelope's `result` is the original engine
 * `RunResult`, so a forged `{passed:true}` with an arbitrary, incomplete,
 * duplicated or self-contradictory check list is rejected even when the
 * worker is trusted.
 */
export function isColdCacheEvaluationResult(
  value: unknown,
  binding: EngineResultBinding,
): boolean {
  const parsed = coldCacheEvaluationSchema.safeParse(value);
  if (!parsed.success) {
    return false;
  }
  const result = parsed.data;
  if (
    binding.levelId !== COLD_CACHE_LEVEL_ID ||
    result.meta.levelId !== COLD_CACHE_LEVEL_ID ||
    result.meta.modelVersion !== binding.modelVersion ||
    result.meta.seed !== binding.seed ||
    result.meta.graphDigest !== binding.graphDigest
  ) {
    return false;
  }
  if (result.status === 'invalid') {
    return (
      result.passed === false &&
      result.issues.some((issue) => issue.severity === 'error')
    );
  }
  if (result.status === 'incomplete') {
    return result.passed === false;
  }
  // A parsed, completed Cold run always has a semantic graph digest. Requiring
  // it here prevents a forged pass with a null digest on both sides.
  if (result.meta.graphDigest === null || binding.graphDigest === null) {
    return false;
  }
  if (result.result.seed !== result.meta.seed) {
    return false;
  }
  return isColdRunResultConsistent(result.result, result.passed);
}

type ImageBusinessOperation = (typeof IMAGE_BUSINESS_OPERATIONS)[number];
type ImageScenarioSpec = (typeof IMAGE_LEVEL.qualification.scenarios)[number];

const IMAGE_OPERATION_LIST: readonly ImageBusinessOperation[] =
  IMAGE_BUSINESS_OPERATIONS;

function imageScenarioSpec(name: string): ImageScenarioSpec | undefined {
  return IMAGE_LEVEL.qualification.scenarios.find(
    (scenario) => scenario.name === name,
  );
}

function imageIsIncident(spec: ImageScenarioSpec): boolean {
  return spec.fault.kind !== 'none';
}

function imageAvailabilityTarget(incident: boolean): number {
  return incident
    ? IMAGE_LEVEL.slo.incident.availability
    : IMAGE_LEVEL.slo.normal.availability;
}

function imageLatencyTarget(
  incident: boolean,
  operation: ImageBusinessOperation,
): number {
  const profile = incident ? IMAGE_LEVEL.slo.incident : IMAGE_LEVEL.slo.normal;
  switch (operation) {
    case 'upload':
      return profile.uploadP999Ms;
    case 'search':
      return profile.searchP999Ms;
    case 'detail':
      return profile.detailP999Ms;
  }
}

/**
 * Required per-operation evidence gate. The registry contract uses stable
 * `availability:<operation>` and `p999:<operation>` required checks inside
 * each scenario. A replaced or removed ID is rejected even when another
 * required check claims a pass.
 */
function hasRequiredImageCheck(
  scenario: ImageScenarioResult,
  prefix: 'availability' | 'p999',
  operation: ImageBusinessOperation,
): boolean {
  const id = `${prefix}:${operation}`;
  const matches = scenario.checks.filter(
    (check) => check.id === id && check.severity === 'required',
  );
  if (matches.length !== 1) {
    return false;
  }
  const check = matches[0];
  if (check === undefined || !check.passed) {
    return false;
  }
  return check.operation === undefined || check.operation === operation;
}

function isImageOperationEvidence(
  metrics: ImageScenarioResult['operations'][ImageBusinessOperation],
  incident: boolean,
  operation: ImageBusinessOperation,
): boolean {
  if (metrics.operation !== operation) {
    return false;
  }
  if (metrics.availability + 1e-9 < imageAvailabilityTarget(incident)) {
    return false;
  }
  if (
    metrics.latencyP999Ms >
    imageLatencyTarget(incident, operation) + 1e-9
  ) {
    return false;
  }
  const minimumSamples = IMAGE_LEVEL.qualification.minimumP999Samples;
  if (
    metrics.minimumP999Samples !== minimumSamples ||
    !metrics.p999Reliable ||
    metrics.p999SampleCount < minimumSamples ||
    metrics.sampleCount < minimumSamples
  ) {
    return false;
  }
  return metrics.counts.offered > 0;
}

function isImageWindowEvidence(
  window: ImageScenarioWindow | null,
  incident: boolean,
  availabilityTarget: number,
  expectedFromMs: number,
  expectedToMs: number,
  caseOperations: ImageScenarioResult['operations'],
): boolean {
  if (window === null || !window.passed) {
    return false;
  }
  if (
    window.fromMs !== expectedFromMs ||
    window.toMs !== expectedToMs ||
    window.toMs <= window.fromMs
  ) {
    return false;
  }
  let allPassed = true;
  for (const operation of IMAGE_OPERATION_LIST) {
    const metrics = window.operations[operation];
    const caseMetrics = caseOperations[operation];
    if (
      metrics.offered <= 0 ||
      metrics.success <= 0 ||
      metrics.success > metrics.offered ||
      metrics.sampleCount !== metrics.success ||
      metrics.offered > caseMetrics.counts.offered ||
      metrics.success > caseMetrics.counts.success
    ) {
      return false;
    }
    const actualAvailability = metrics.success / metrics.offered;
    if (Math.abs(metrics.availability - actualAvailability) > 1e-9) {
      return false;
    }
    const availabilityOk =
      actualAvailability + 1e-9 >= availabilityTarget;
    const latencyOk =
      metrics.latencyP999Ms <=
      imageLatencyTarget(incident, operation) + 1e-9;
    if (
      metrics.availabilityOk !== availabilityOk ||
      metrics.latencyOk !== latencyOk ||
      metrics.passed !== (availabilityOk && latencyOk) ||
      !(availabilityOk && latencyOk)
    ) {
      return false;
    }
    allPassed = allPassed && metrics.passed;
  }
  return window.passed === allPassed;
}

/**
 * Passing Image evidence is checked directly against the frozen level SLO,
 * workload and required scenario set. The evaluator's own pass flags are not
 * trusted on their own.
 */
function isImageScenarioPassEvidence(scenario: ImageScenarioResult): boolean {
  const spec = imageScenarioSpec(scenario.name);
  if (spec === undefined) {
    return false;
  }
  const incident = imageIsIncident(spec);
  if (
    scenario.fault.kind !== spec.fault.kind ||
    (spec.fault.kind !== 'none' &&
      (scenario.fault.atMeasuredMs !== spec.fault.atMeasuredMs ||
        scenario.fault.durationMs !== spec.fault.durationMs)) ||
    (spec.fault.kind === 'region' &&
      scenario.fault.region !== spec.fault.region) ||
    (spec.fault.kind === 'link' &&
      (scenario.fault.linkA !== spec.fault.a ||
        scenario.fault.linkB !== spec.fault.b))
  ) {
    return false;
  }
  if (
    scenario.workload.sampleFactor !== IMAGE_LEVEL.workload.sampleFactor ||
    scenario.workload.exhausted
  ) {
    return false;
  }

  for (const operation of IMAGE_OPERATION_LIST) {
    if (
      !hasRequiredImageCheck(scenario, 'availability', operation) ||
      !hasRequiredImageCheck(scenario, 'p999', operation) ||
      !isImageOperationEvidence(
        scenario.operations[operation],
        incident,
        operation,
      )
    ) {
      return false;
    }
  }

  const freshness = scenario.freshness;
  if (
    !freshness.passed ||
    freshness.probes <= 0 ||
    freshness.success <= 0 ||
    freshness.success > freshness.probes ||
    freshness.limitMs !== IMAGE_LEVEL.slo.freshnessMs ||
    freshness.maxLagMs === null ||
    freshness.maxLagMs > freshness.limitMs ||
    (freshness.p99LagMs !== null && freshness.p99LagMs > freshness.limitMs)
  ) {
    return false;
  }

  const integrity = scenario.dataIntegrity;
  if (
    !integrity.passed ||
    !integrity.publicationPassed ||
    integrity.duplicateEffects !== 0 ||
    integrity.missingSearchResults !== 0 ||
    integrity.visibilityViolations !== 0 ||
    integrity.unpublishedCommitted !== 0
  ) {
    return false;
  }

  const postlude = scenario.postlude;
  if (
    !postlude.passed ||
    postlude.unpublishedCommitted !== 0 ||
    postlude.committedUploads <= 0 ||
    postlude.maxAfterLastAckMs <= 0 ||
    postlude.maxAfterLastAckMs > IMAGE_LEVEL.slo.globalIndexBoundMs ||
    postlude.maxPublicationLagMs === null ||
    postlude.maxPublicationLagMs > IMAGE_LEVEL.slo.globalIndexBoundMs
  ) {
    return false;
  }

  if (!incident) {
    if (scenario.incidentWindow !== null || scenario.recoveryWindow !== null) {
      return false;
    }
  } else {
    if (spec.fault.kind === 'none') {
      return false;
    }
    const incidentWindow = scenario.incidentWindow;
    const recoveryWindow = scenario.recoveryWindow;
    if (incidentWindow === null || recoveryWindow === null) {
      return false;
    }
    const incidentFrom = spec.fault.atMeasuredMs;
    const incidentTo = incidentFrom + spec.fault.durationMs;
    const recoveryTo = IMAGE_LEVEL.qualification.measuredMs;
    const recoveryFrom =
      recoveryTo - IMAGE_LEVEL.slo.recoveryFinalWindowMs;
    if (
      !isImageWindowEvidence(
        incidentWindow,
        true,
        IMAGE_LEVEL.slo.incidentWindowAvailability,
        incidentFrom,
        incidentTo,
        scenario.operations,
      ) ||
      !isImageWindowEvidence(
        recoveryWindow,
        true,
        IMAGE_LEVEL.slo.recoveryAvailability,
        recoveryFrom,
        recoveryTo,
        scenario.operations,
      )
    ) {
      return false;
    }
    for (const operation of IMAGE_OPERATION_LIST) {
      const caseCounts = scenario.operations[operation].counts;
      const incidentOp = incidentWindow.operations[operation];
      const recoveryOp = recoveryWindow.operations[operation];
      if (
        incidentOp.offered + recoveryOp.offered > caseCounts.offered ||
        incidentOp.success + recoveryOp.success > caseCounts.success
      ) {
        return false;
      }
    }
  }

  return scenario.passed === true;
}

function isImagePassEvidenceConsistent(result: ImageEvaluation): boolean {
  if (
    result.status !== 'complete' ||
    !result.passed ||
    result.meta.graphDigest === null
  ) {
    return false;
  }
  const qualificationGates = result.checks.filter(
    (check) =>
      check.id === 'qualification_scenarios' &&
      check.severity === 'required',
  );
  if (
    qualificationGates.length !== 1 ||
    qualificationGates[0]?.passed !== true
  ) {
    return false;
  }
  for (const name of IMAGE_LEVEL.qualification.requiredScenarios) {
    const scenario = result.scenarios.find((item) => item.name === name);
    if (scenario === undefined || !isImageScenarioPassEvidence(scenario)) {
      return false;
    }
  }
  return true;
}

/**
 * Image Atlas result guard. In addition to the frozen Zod contract this
 * requires the exact registered model version, a full qualification request
 * covering every required level scenario, the input binding and, for a pass,
 * evidence validated against the frozen level SLO/workload thresholds. A
 * scenario subset can never pass and is rejected by the schema.
 */
export function isImageEvaluationResult(
  value: unknown,
  binding: EngineResultBinding,
): boolean {
  const parsed = imageEvaluationSchema.safeParse(value);
  if (!parsed.success) {
    return false;
  }
  const result = parsed.data;
  if (
    binding.levelId !== IMAGE_LEVEL_ID ||
    result.meta.levelId !== IMAGE_LEVEL_ID ||
    result.meta.modelVersion !== IMAGE_MODEL_VERSION ||
    result.meta.modelVersion !== binding.modelVersion ||
    result.meta.seed !== binding.seed ||
    result.meta.graphDigest !== binding.graphDigest ||
    !result.meta.qualification ||
    result.meta.evaluationKind !== 'qualification'
  ) {
    return false;
  }
  if (
    !IMAGE_REQUIRED_SCENARIOS.every((name) =>
      result.meta.requestedScenarios.includes(name),
    )
  ) {
    return false;
  }
  if (result.status !== 'complete') {
    return result.passed === false;
  }
  if (
    !IMAGE_LEVEL.qualification.requiredScenarios.every((name) =>
      result.scenarios.some((scenario) => scenario.name === name),
    )
  ) {
    return false;
  }
  // Non-passing completed runs keep the cheap schema/binding checks. Only a
  // claimed pass gets the full SLO/workload/integrity evidence validation.
  return result.passed ? isImagePassEvidenceConsistent(result) : true;
}

const SCOREBOARD_MINIMUM_SAMPLES = SCOREBOARD_LEVEL.slo.minimumLatencySamples;
const SCOREBOARD_GATE_IDS = [
  'read-availability-whole',
  'read-p95-whole',
  'read-availability-peak',
  'read-p95-peak',
  'write-availability-whole',
  'write-p95-whole',
  'write-availability-peak',
  'write-p95-peak',
  'correctness',
  'freshness',
  'completion',
] as const;

function closeNumber(actual: number, expected: number): boolean {
  return (
    Number.isFinite(actual) &&
    Number.isFinite(expected) &&
    Math.abs(actual - expected) <=
      1e-9 + 1e-9 * Math.max(Math.abs(actual), Math.abs(expected))
  );
}

function sameOptionalNumber(actual: number | null, expected: number | null): boolean {
  return actual === null || expected === null
    ? actual === expected
    : closeNumber(actual, expected);
}

function scoreboardOperationConsistent(
  metrics: ScoreboardOperationMetrics,
): boolean {
  const { latency } = metrics;
  if (
    metrics.offered !==
      metrics.succeeded + metrics.failed ||
    metrics.failed !==
      metrics.rejected + metrics.timedOut + metrics.errored ||
    metrics.pending !== 0 ||
    metrics.bytesDelivered > metrics.bytesOffered
  ) {
    return false;
  }
  const availability =
    metrics.offered === 0 ? null : metrics.succeeded / metrics.offered;
  if (!sameOptionalNumber(metrics.availability, availability)) {
    return false;
  }
  if (latency.samples !== metrics.succeeded) {
    return false;
  }
  if (latency.samples === 0) {
    if (
      latency.p50Ms !== null ||
      latency.p95Ms !== null ||
      latency.p99Ms !== null ||
      latency.maxMs !== null
    ) {
      return false;
    }
  } else if (
    latency.p50Ms === null ||
    latency.p95Ms === null ||
    latency.p99Ms === null ||
    latency.maxMs === null ||
    latency.p50Ms > latency.p95Ms ||
    latency.p95Ms > latency.p99Ms ||
    latency.p99Ms > latency.maxMs
  ) {
    return false;
  }
  return (
    latency.insufficientSamples ===
    latency.samples < SCOREBOARD_MINIMUM_SAMPLES
  );
}

function scoreboardGate(
  gates: readonly ScoreboardGate[],
  id: string,
): ScoreboardGate | null {
  const matches = gates.filter((gate) => gate.id === id);
  return matches.length === 1 ? (matches[0] as ScoreboardGate) : null;
}

function scoreboardAvailabilityGate(
  gate: ScoreboardGate | null,
  metrics: ScoreboardOperationMetrics,
  operation: 'read' | 'write',
  window: 'whole' | 'peak',
): boolean {
  if (gate === null) {
    return false;
  }
  const actual = metrics.availability;
  const limit = SCOREBOARD_LEVEL.slo.availability;
  return (
    gate.severity === 'required' &&
    gate.metric === 'availability' &&
    gate.operation === operation &&
    gate.window === window &&
    gate.unit === 'ratio' &&
    sameOptionalNumber(gate.actual, actual) &&
    sameOptionalNumber(gate.limit, limit) &&
    gate.sampleCount === metrics.offered &&
    gate.passed === (actual !== null && actual >= limit)
  );
}

function scoreboardP95Gate(
  gate: ScoreboardGate | null,
  metrics: ScoreboardOperationMetrics,
  operation: 'read' | 'write',
  window: 'whole' | 'peak',
): boolean {
  if (gate === null) {
    return false;
  }
  const actual = metrics.latency.p95Ms;
  const limit = SCOREBOARD_LEVEL.slo.successfulP95Ms;
  const enoughSamples =
    metrics.latency.samples >= SCOREBOARD_MINIMUM_SAMPLES &&
    !metrics.latency.insufficientSamples;
  return (
    gate.severity === 'required' &&
    gate.metric === 'successful-p95' &&
    gate.operation === operation &&
    gate.window === window &&
    gate.unit === 'ms' &&
    sameOptionalNumber(gate.actual, actual) &&
    sameOptionalNumber(gate.limit, limit) &&
    gate.sampleCount === metrics.latency.samples &&
    gate.passed === (actual !== null && enoughSamples && actual <= limit)
  );
}

function scoreboardCostConsistent(
  cost: NonNullable<ScoreboardEvaluation['cost']>,
  preparation: NonNullable<ScoreboardEvaluation['preparation']>,
  window: NonNullable<ScoreboardEvaluation['window']>,
  operations: NonNullable<ScoreboardEvaluation['operations']>,
): boolean {
  if (
    !closeNumber(
      cost.preparationMs,
      preparation.durationMs,
    ) ||
    !closeNumber(cost.measuredMs, SCOREBOARD_LEVEL.workload.measuredMs) ||
    !closeNumber(cost.drainMs, window.drainMs) ||
    !closeNumber(
      cost.billedMs,
      cost.preparationMs + cost.measuredMs + cost.drainMs,
    ) ||
    !closeNumber(
      cost.billedBytes,
      operations.read.bytesDelivered + operations.write.bytesDelivered,
    ) ||
    cost.lines.length < 2 ||
    cost.lines.length > 4
  ) {
    return false;
  }
  const hours = cost.billedMs / 3_600_000;
  let hourlySum = 0;
  let lineSum = 0;
  for (const line of cost.lines) {
    if (
      !closeNumber(line.hours, hours) ||
      !closeNumber(line.usd, line.hourlyUsd * line.hours)
    ) {
      return false;
    }
    hourlySum += line.hourlyUsd;
    lineSum += line.usd;
  }
  const bytesUsd =
    (cost.billedBytes / SCOREBOARD_CATALOG.billing.bytesPerGb) *
    SCOREBOARD_CATALOG.billing.responseBytesUsdPerGb;
  return (
    closeNumber(cost.hourlyUsd, hourlySum) &&
    closeNumber(cost.rentalUsd, lineSum) &&
    closeNumber(cost.bytesUsd, bytesUsd) &&
    closeNumber(cost.actualUsd, cost.rentalUsd + cost.bytesUsd) &&
    closeNumber(cost.scoreUsd, cost.actualUsd)
  );
}

/**
 * Semantic guard for a Live Scoreboard evaluation from the trusted worker.
 *
 * The public Zod parser owns the shape and identity invariants. This function
 * adds cross-field consistency that the simulation itself guarantees: request
 * conservation, gate flags derived from the reported operations/freshness,
 * average-vs-peak resources and arithmetic cost provenance. It never re-runs
 * the simulation, recomputes thresholds or mutates the result.
 */
export function isScoreboardEvaluationResult(
  value: unknown,
  binding: EngineResultBinding,
): boolean {
  const parsed = parseScoreboardEvaluation(value);
  if (!parsed.ok) {
    return false;
  }
  const result = parsed.value;
  if (
    binding.levelId !== SCOREBOARD_LEVEL_ID ||
    binding.modelVersion !== SCOREBOARD_LEVEL.modelVersion ||
    binding.schemaVersion !== SCOREBOARD_LEVEL.schemaVersion ||
    binding.contentVersion !== SCOREBOARD_LEVEL.contentVersion ||
    binding.pricingVersion !== SCOREBOARD_LEVEL.pricingVersion ||
    result.levelId !== SCOREBOARD_LEVEL_ID ||
    result.modelVersion !== binding.modelVersion ||
    result.schemaVersion !== binding.schemaVersion ||
    result.contentVersion !== binding.contentVersion ||
    result.pricingVersion !== binding.pricingVersion ||
    result.seed !== binding.seed ||
    result.identity.levelId !== result.levelId ||
    result.identity.modelVersion !== result.modelVersion ||
    result.identity.schemaVersion !== result.schemaVersion ||
    result.identity.contentVersion !== result.contentVersion ||
    result.identity.pricingVersion !== result.pricingVersion ||
    result.identity.seed !== result.seed ||
    result.identity.graphDigest !== result.graphDigest ||
    result.identity.runId !== result.runId
  ) {
    return false;
  }

  if (result.status === 'invalid') {
    // The core reports the literal `invalid` digest for a graph that failed
    // semantic validation; a graph that did not parse has no digest at all.
    // An invalid result never carries evaluation evidence, so it cannot claim
    // a different graph identity than the submission.
    return (
      (binding.graphDigest === null ||
        binding.graphDigest === result.graphDigest ||
        result.graphDigest === 'invalid') &&
      result.passed === false &&
      result.issues.some((issue) => issue.severity === 'error') &&
      result.gates.length === 0 &&
      result.preparation === null &&
      result.window === null &&
      result.operations === null &&
      result.correctness === null &&
      result.freshness === null &&
      result.cost === null
    );
  }

  if (
    binding.graphDigest === null ||
    result.graphDigest !== binding.graphDigest
  ) {
    return false;
  }

  if (result.status === 'incomplete') {
    return (
      result.passed === false &&
      result.incompleteReasons.length > 0 &&
      (result.window === null || result.window.runEndedIncomplete === true)
    );
  }

  const { operations, correctness, freshness, cost, window, preparation } =
    result;
  if (
    operations === null ||
    correctness === null ||
    freshness === null ||
    cost === null ||
    window === null ||
    preparation === null ||
    window.runEndedIncomplete ||
    !closeNumber(
      window.measuredEndMs - window.measuredStartMs,
      SCOREBOARD_LEVEL.workload.measuredMs,
    ) ||
    !closeNumber(
      window.peakStartMs - window.measuredStartMs,
      SCOREBOARD_LEVEL.workload.peakWindow.fromMs,
    ) ||
    !closeNumber(
      window.peakEndMs - window.measuredStartMs,
      SCOREBOARD_LEVEL.workload.peakWindow.toMs,
    ) ||
    !closeNumber(window.totalRunMs, window.measuredEndMs + window.drainMs)
  ) {
    return false;
  }
  if (
    !scoreboardOperationConsistent(operations.read) ||
    !scoreboardOperationConsistent(operations.write) ||
    !scoreboardOperationConsistent(operations.peak.read) ||
    !scoreboardOperationConsistent(operations.peak.write)
  ) {
    return false;
  }
  for (const operation of ['read', 'write'] as const) {
    for (const key of ['offered', 'succeeded', 'failed', 'rejected', 'timedOut'] as const) {
      if (operations.peak[operation][key] > operations[operation][key]) {
        return false;
      }
    }
  }
  if (
    operations.write.offered !== correctness.writesOffered ||
    correctness.writesAcknowledged !== operations.write.succeeded ||
    correctness.writesCommitted !==
      correctness.writesAcknowledged + correctness.committedUnacknowledged ||
    correctness.writesCommitted > correctness.writesOffered ||
    correctness.finalVoteCount !== SCOREBOARD_LEVEL.dataset.participants ||
    correctness.finalCandidateVotes !== SCOREBOARD_LEVEL.dataset.candidates ||
    correctness.valid !==
      (correctness.invalidVotes === 0 &&
        correctness.doubleEffects === 0 &&
        correctness.lostAcknowledgedVotes === 0 &&
        correctness.aggregateMismatches === 0 &&
        correctness.snapshotMismatches === 0) ||
    (preparation.plan === 'aggregate'
      ? correctness.finalRawMatchesAggregate !== true
      : correctness.finalRawMatchesAggregate !== null)
  ) {
    return false;
  }
  if (
    freshness.freshnessLimitMs !== SCOREBOARD_LEVEL.slo.freshnessMs ||
    freshness.successfulReads !== operations.read.succeeded ||
    freshness.checkedReads !== freshness.samples ||
    freshness.checkedReads > freshness.successfulReads ||
    freshness.staleReads > freshness.checkedReads ||
    (freshness.samples === 0
      ? freshness.maxLagMs !== 0 || freshness.p95LagMs !== 0
      : freshness.p95LagMs > freshness.maxLagMs) ||
    freshness.valid !== (freshness.staleReads === 0) ||
    (freshness.valid && freshness.maxLagMs > freshness.freshnessLimitMs)
  ) {
    return false;
  }
  if (!scoreboardCostConsistent(cost, preparation, window, operations)) {
    return false;
  }
  if (
    result.nodes.length < 2 ||
    result.nodes.length > 4 ||
    !result.nodes.every((node) => {
      const cpuCapacity = node.cpu.capacityCores;
      const networkCapacity = node.network.capacityGbitPerSec;
      return (
        node.cpu.busyCoresAverage <= node.cpu.busyCoresPeak + 1e-9 &&
        node.cpu.utilizationAverage <= node.cpu.utilizationPeak + 1e-9 &&
        closeNumber(
          node.cpu.busyCoreMs,
          node.cpu.busyCoresAverage * SCOREBOARD_LEVEL.workload.measuredMs,
        ) &&
        (cpuCapacity === 0
          ? node.cpu.busyCoresAverage === 0 &&
            node.cpu.busyCoresPeak === 0 &&
            node.cpu.utilizationAverage === 0 &&
            node.cpu.utilizationPeak === 0
          : closeNumber(
              node.cpu.utilizationAverage,
              node.cpu.busyCoresAverage / cpuCapacity,
            ) &&
            closeNumber(
              node.cpu.utilizationPeak,
              node.cpu.busyCoresPeak / cpuCapacity,
            )) &&
        node.queue.waitingAverage <= node.queue.waitingPeak &&
        (node.queue.waitSamples === 0
          ? node.queue.waitMsAverage === 0 && node.queue.waitMsMax === 0
          : node.queue.waitMsAverage <= node.queue.waitMsMax) &&
        node.network.averageGbitPerSec <= node.network.peakGbitPerSec + 1e-9 &&
        node.network.bytesDelivered <= node.network.bytesOffered &&
        (networkCapacity === 0
          ? node.network.averageGbitPerSec === 0 &&
            node.network.peakGbitPerSec === 0
          : true) &&
        node.memory.peakUsedBytes <= node.memory.capacityBytes &&
        node.memory.workingSetBytes <= node.memory.capacityBytes
      );
    }) ||
    !result.links.every(
      (link) =>
        link.requestsTotal ===
          link.requests.read + link.requests.write + link.requests.fill &&
        link.bytesDelivered <= link.bytesOffered,
    )
  ) {
    return false;
  }

  const gates = result.gates;
  if (
    gates.length !== SCOREBOARD_GATE_IDS.length ||
    new Set(gates.map((gate) => gate.id)).size !== gates.length ||
    !SCOREBOARD_GATE_IDS.every((id) => scoreboardGate(gates, id) !== null) ||
    !scoreboardAvailabilityGate(
      scoreboardGate(gates, 'read-availability-whole'),
      operations.read,
      'read',
      'whole',
    ) ||
    !scoreboardP95Gate(
      scoreboardGate(gates, 'read-p95-whole'),
      operations.read,
      'read',
      'whole',
    ) ||
    !scoreboardAvailabilityGate(
      scoreboardGate(gates, 'read-availability-peak'),
      operations.peak.read,
      'read',
      'peak',
    ) ||
    !scoreboardP95Gate(
      scoreboardGate(gates, 'read-p95-peak'),
      operations.peak.read,
      'read',
      'peak',
    ) ||
    !scoreboardAvailabilityGate(
      scoreboardGate(gates, 'write-availability-whole'),
      operations.write,
      'write',
      'whole',
    ) ||
    !scoreboardP95Gate(
      scoreboardGate(gates, 'write-p95-whole'),
      operations.write,
      'write',
      'whole',
    ) ||
    !scoreboardAvailabilityGate(
      scoreboardGate(gates, 'write-availability-peak'),
      operations.peak.write,
      'write',
      'peak',
    ) ||
    !scoreboardP95Gate(
      scoreboardGate(gates, 'write-p95-peak'),
      operations.peak.write,
      'write',
      'peak',
    )
  ) {
    return false;
  }
  const correctnessGate = scoreboardGate(gates, 'correctness');
  if (
    correctnessGate === null ||
    correctnessGate.severity !== 'required' ||
    correctnessGate.metric !== 'correctness' ||
    correctnessGate.unit !== 'boolean' ||
    correctnessGate.operation !== undefined ||
    correctnessGate.window !== undefined ||
    correctnessGate.actual !== null ||
    correctnessGate.limit !== null ||
    correctnessGate.passed !== correctness.valid
  ) {
    return false;
  }
  const freshnessGate = scoreboardGate(gates, 'freshness');
  if (
    freshnessGate === null ||
    freshnessGate.severity !== 'required' ||
    freshnessGate.metric !== 'freshness-lag' ||
    freshnessGate.unit !== 'ms' ||
    freshnessGate.operation !== undefined ||
    freshnessGate.window !== undefined ||
    !closeNumber(freshnessGate.actual ?? Number.NaN, freshness.maxLagMs) ||
    !closeNumber(
      freshnessGate.limit ?? Number.NaN,
      SCOREBOARD_LEVEL.slo.freshnessMs,
    ) ||
    freshnessGate.sampleCount !== freshness.samples ||
    freshnessGate.passed !== freshness.valid
  ) {
    return false;
  }
  const pending =
    operations.read.pending + operations.write.pending;
  const completionGate = scoreboardGate(gates, 'completion');
  if (
    completionGate === null ||
    completionGate.severity !== 'required' ||
    completionGate.metric !== 'pending-requests' ||
    completionGate.unit !== 'requests' ||
    completionGate.operation !== undefined ||
    completionGate.window !== undefined ||
    !closeNumber(completionGate.actual ?? Number.NaN, pending) ||
    !closeNumber(completionGate.limit ?? Number.NaN, 0) ||
    completionGate.sampleCount !==
      operations.read.offered + operations.write.offered ||
    completionGate.passed !== (pending === 0 && !window.runEndedIncomplete)
  ) {
    return false;
  }

  const requiredPassed = gates
    .filter((gate) => gate.severity === 'required')
    .every((gate) => gate.passed);
  return (
    result.passed ===
    (requiredPassed && correctness.valid && freshness.valid)
  );
}

// ---------------------------------------------------------------------------
// Live Audience deep result binding
// ---------------------------------------------------------------------------

function audienceOptionalNumberMatches(
  actual: number | null,
  expected: number | null,
): boolean {
  return actual === null || expected === null
    ? actual === expected
    : closeNumber(actual, expected);
}

/**
 * Request accounting and percentile algebra for one operation cohort. This is
 * the same conservation the core reports; the guard recomputes it instead of
 * trusting a `passed` flag.
 */
function audienceOperationConsistent(
  metrics: AudienceOperationMetrics,
): boolean {
  if (
    metrics.attempts !== metrics.offered + metrics.retries ||
    metrics.retries > metrics.attempts ||
    metrics.failed !==
      metrics.rejected +
        metrics.timedOut +
        metrics.errored +
        metrics.unknownOutcome ||
    metrics.offered !==
      metrics.succeeded + metrics.failed + metrics.pending ||
    metrics.succeeded > metrics.offered ||
    metrics.pending !== 0 ||
    metrics.bytesDelivered > metrics.bytesOffered + 1e-9
  ) {
    return false;
  }
  const availability =
    metrics.offered === 0 ? null : metrics.succeeded / metrics.offered;
  if (!audienceOptionalNumberMatches(metrics.availability, availability)) {
    return false;
  }
  const latency = metrics.latency;
  if (latency.samples !== metrics.succeeded) {
    return false;
  }
  if (latency.samples === 0) {
    if (
      latency.p50Ms !== null ||
      latency.p95Ms !== null ||
      latency.p99Ms !== null ||
      latency.maxMs !== null
    ) {
      return false;
    }
  } else if (
    latency.p50Ms === null ||
    latency.p95Ms === null ||
    latency.p99Ms === null ||
    latency.maxMs === null ||
    latency.p50Ms > latency.p95Ms ||
    latency.p95Ms > latency.p99Ms ||
    latency.p99Ms > latency.maxMs
  ) {
    return false;
  }
  return (
    latency.insufficientSamples ===
    latency.samples < AUDIENCE_MIN_LATENCY_SAMPLES
  );
}

interface AudienceGateEvidence {
  readonly actual: number | null;
  readonly limit: number | null;
  readonly sampleCount: number;
  readonly passed: boolean;
}

/**
 * Recompute the frozen gate evidence from the reported case metrics. The gate
 * ids, labels, operations, windows, metrics and units are compiled from
 * `audienceRequiredGateSpecs`; no id or threshold is redefined here.
 */
function audienceExpectedGate(
  spec: AudienceGateSpec,
  operations: NonNullable<AudienceCaseResult['operations']>,
  correctness: NonNullable<AudienceCaseResult['correctness']>,
  freshness: NonNullable<AudienceCaseResult['freshness']>,
): AudienceGateEvidence {
  const cohort =
    spec.window === 'critical'
      ? operations.critical?.[spec.operation ?? 'read'] ?? null
      : operations[spec.operation ?? 'read'];
  if (spec.metric === 'availability') {
    const actual = cohort?.availability ?? null;
    return {
      actual,
      limit: AUDIENCE_AVAILABILITY_SLO,
      sampleCount: cohort?.offered ?? 0,
      passed:
        cohort !== null &&
        cohort.offered > 0 &&
        actual !== null &&
        actual + 1e-9 >= AUDIENCE_AVAILABILITY_SLO,
    };
  }
  if (spec.metric === 'successfulP95Ms') {
    const actual = cohort?.latency.p95Ms ?? null;
    return {
      actual,
      limit: AUDIENCE_SUCCESSFUL_P95_MS,
      sampleCount: cohort?.latency.samples ?? 0,
      passed:
        cohort !== null &&
        actual !== null &&
        cohort.latency.samples >= AUDIENCE_MIN_LATENCY_SAMPLES &&
        !cohort.latency.insufficientSamples &&
        actual <= AUDIENCE_SUCCESSFUL_P95_MS + 1e-9,
    };
  }
  if (spec.metric === 'preservation') {
    return {
      actual: null,
      limit: null,
      sampleCount: correctness.ingestAcknowledged,
      passed:
        correctness.lostAcknowledgedEvents === 0 &&
        correctness.duplicateLogicalEvents === 0 &&
        correctness.payloadConflicts === 0,
    };
  }
  if (spec.metric === 'exactSnapshotCorrectness') {
    return {
      actual: null,
      limit: null,
      sampleCount: correctness.checkedSnapshots,
      passed: correctness.valid,
    };
  }
  if (spec.metric === 'freshnessLagMs') {
    return {
      actual: freshness.maxLagMs,
      limit: AUDIENCE_FRESHNESS_MS,
      sampleCount: freshness.checkedReads,
      passed: freshness.valid,
    };
  }
  const pending = operations.ingest.pending + operations.read.pending;
  return {
    actual: pending,
    limit: 0,
    sampleCount: 0,
    passed: pending === 0,
  };
}

function audienceGateMatchesSpec(
  gate: AudienceGate,
  spec: AudienceGateSpec,
): boolean {
  return (
    gate.severity === 'required' &&
    gate.id === spec.id &&
    gate.label === spec.label &&
    gate.operation === spec.operation &&
    gate.window === spec.window &&
    gate.metric === spec.metric &&
    gate.unit === spec.unit &&
    gate.comparison === spec.comparison
  );
}

/**
 * A complete case carries exactly the frozen gate set for its kind, and every
 * gate's evidence is derived from the reported metrics. An ordinary completed
 * failure keeps the same shape; a forged pass cannot substitute a cheaper gate
 * subset or a hand-authored numeric pass.
 */
function audienceGatesConsistent(item: AudienceCaseResult): boolean {
  if (item.status !== 'complete') {
    return true;
  }
  if (!audienceOperationsConsistent(item)) {
    return false;
  }
  const operations = item.operations;
  const correctness = item.correctness;
  const freshness = item.freshness;
  if (operations === null || correctness === null || freshness === null) {
    return false;
  }
  const specs = audienceRequiredGateSpecs(item.kind);
  const requiredGates = item.gates.filter(
    (gate) => gate.severity === 'required',
  );
  if (requiredGates.length !== specs.length) {
    return false;
  }
  for (const spec of specs) {
    const matches = requiredGates.filter((gate) => gate.id === spec.id);
    if (matches.length !== 1) {
      return false;
    }
    const gate = matches[0] as AudienceGate;
    if (!audienceGateMatchesSpec(gate, spec)) {
      return false;
    }
    const expected = audienceExpectedGate(
      spec,
      operations,
      correctness,
      freshness,
    );
    if (
      !audienceOptionalNumberMatches(gate.actual, expected.actual) ||
      !audienceOptionalNumberMatches(gate.limit, expected.limit) ||
      gate.sampleCount !== expected.sampleCount ||
      gate.passed !== expected.passed
    ) {
      return false;
    }
  }
  return true;
}

function audienceWindowConsistent(item: AudienceCaseResult): boolean {
  const window = item.window;
  const measured = window.measuredEndMs - window.measuredStartMs;
  if (
    !closeNumber(measured, AUDIENCE_MEASURED_MS) ||
    !closeNumber(
      window.peakStartMs - window.measuredStartMs,
      AUDIENCE_PEAK_WINDOW.fromMs,
    ) ||
    !closeNumber(
      window.peakEndMs - window.measuredStartMs,
      AUDIENCE_PEAK_WINDOW.toMs,
    ) ||
    !closeNumber(window.drainMs, AUDIENCE_DRAIN_MS) ||
    !closeNumber(window.totalRunMs, window.measuredEndMs + window.drainMs)
  ) {
    return false;
  }
  if (item.id === 'normal') {
    return (
      window.criticalStartMs === null && window.criticalEndMs === null
    );
  }
  const expected =
    item.id === 'peak'
      ? AUDIENCE_PEAK_WINDOW
      : AUDIENCE_FAULT_CRITICAL_WINDOW;
  return (
    window.criticalStartMs !== null &&
    window.criticalEndMs !== null &&
    closeNumber(
      window.criticalStartMs - window.measuredStartMs,
      expected.fromMs,
    ) &&
    closeNumber(
      window.criticalEndMs - window.measuredStartMs,
      expected.toMs,
    )
  );
}

function audienceCostConsistent(
  cost: NonNullable<AudienceCaseResult['cost']>,
): boolean {
  if (
    !closeNumber(cost.measuredMs, AUDIENCE_MEASURED_MS) ||
    !closeNumber(cost.drainMs, AUDIENCE_DRAIN_MS) ||
    !closeNumber(
      cost.billedMs,
      cost.preparationMs + cost.measuredMs + cost.drainMs,
    ) ||
    !closeNumber(cost.actualUsd, cost.rentalUsd + cost.bytesUsd)
  ) {
    return false;
  }
  const hours = cost.billedMs / 3_600_000;
  let hourlySum = 0;
  let lineSum = 0;
  for (const line of cost.lines) {
    if (
      !closeNumber(line.hours, hours) ||
      !closeNumber(line.usd, line.hourlyUsd * line.hours)
    ) {
      return false;
    }
    hourlySum += line.hourlyUsd;
    lineSum += line.usd;
  }
  const bytesUsd =
    (cost.billedBytes / AUDIENCE_NETWORK_POLICY.bytesPerGb) *
    AUDIENCE_NETWORK_POLICY.responseBytesUsdPerGb;
  return (
    cost.lines.length > 0 &&
    closeNumber(cost.hourlyUsd, hourlySum) &&
    closeNumber(cost.rentalUsd, lineSum) &&
    closeNumber(cost.bytesUsd, bytesUsd)
  );
}

function audienceOperationsConsistent(item: AudienceCaseResult): boolean {
  const operations = item.operations;
  if (operations === null) {
    return false;
  }
  if (
    !audienceOperationConsistent(operations.ingest) ||
    !audienceOperationConsistent(operations.read)
  ) {
    return false;
  }
  if (item.id === 'normal') {
    return operations.critical === null;
  }
  if (operations.critical === null) {
    return false;
  }
  if (
    !audienceOperationConsistent(operations.critical.ingest) ||
    !audienceOperationConsistent(operations.critical.read)
  ) {
    return false;
  }
  for (const [critical, whole] of [
    [operations.critical.ingest, operations.ingest],
    [operations.critical.read, operations.read],
  ] as const) {
    if (
      critical.offered > whole.offered ||
      critical.succeeded > whole.succeeded ||
      critical.bytesDelivered > whole.bytesDelivered + 1e-9
    ) {
      return false;
    }
  }
  return true;
}

function audienceCorrectnessConsistent(item: AudienceCaseResult): boolean {
  const correctness = item.correctness;
  const freshness = item.freshness;
  const operations = item.operations;
  if (correctness === null || freshness === null || operations === null) {
    return false;
  }
  const ingest = operations.ingest;
  const read = operations.read;
  if (
    correctness.ingestOffered !== ingest.offered ||
    correctness.ingestAcknowledged !== ingest.succeeded ||
    correctness.ingestPending !== ingest.pending ||
    correctness.ingestCommitted > ingest.offered ||
    correctness.ingestAcknowledged > correctness.ingestCommitted ||
    correctness.retriedLogicalEvents !== ingest.retries ||
    correctness.resolvedUnknownCommitOutcomes > ingest.retries ||
    correctness.unknownCommitOutcomes !==
      ingest.unknownOutcome + correctness.resolvedUnknownCommitOutcomes ||
    correctness.commitsSurvivedAppCrash > correctness.ingestCommitted ||
    correctness.idempotentReplays > correctness.ingestOffered ||
    correctness.checkedSnapshots !== read.succeeded ||
    (correctness.expectedExpiries === 0
      ? correctness.checkedExpiry !== 0
      : correctness.checkedExpiry !== correctness.expectedExpiries) ||
    correctness.expiryMismatches > correctness.checkedExpiry
  ) {
    return false;
  }
  if (
    correctness.valid &&
    (correctness.finalActivePairs !== correctness.expectedActivePairs ||
      correctness.finalRankingMatchesReference !== true)
  ) {
    return false;
  }
  if (
    freshness.freshnessLimitMs !== AUDIENCE_FRESHNESS_MS ||
    freshness.successfulReads !== read.succeeded ||
    (freshness.successfulReads > 0 &&
      (freshness.checkedReads !== freshness.successfulReads ||
        freshness.samples !== freshness.checkedReads))
  ) {
    return false;
  }
  if (item.finalSnapshot !== null) {
    if (
      item.finalSnapshot.throughCommitSequence >
      correctness.commitSequenceHighWater
    ) {
      return false;
    }
    if (correctness.projectionLag !== null) {
      // A response can be delivered before the projection worker publishes
      // later durable jobs, so the last served cursor is bounded by the final
      // published prefix, not forced equal to it.
      if (
        item.finalSnapshot.throughCommitSequence >
        correctness.projectionLag.publishedThroughSequence
      ) {
        return false;
      }
    }
  }
  return true;
}

function audienceNodesConsistent(
  item: AudienceCaseResult,
  expected: EngineRunExpectation,
): boolean {
  const expectedNodes = expected.nodes;
  if (
    expectedNodes === undefined ||
    expectedNodes.length !== item.nodes.length
  ) {
    return false;
  }
  const expectedIds = expectedNodes.map((node) => node.id);
  const actualIds = item.nodes.map((node) => node.nodeId);
  if (
    new Set(expectedIds).size !== expectedIds.length ||
    new Set(actualIds).size !== actualIds.length
  ) {
    return false;
  }
  for (const expectedNode of expectedNodes) {
    const matches = item.nodes.filter(
      (node) => node.nodeId === expectedNode.id,
    );
    if (matches.length !== 1) {
      return false;
    }
    const node = matches[0] as AudienceNodeMetrics;
    if (
      node.kind !== expectedNode.kind ||
      node.provisionedInstances !== expectedNode.instances ||
      node.instances.length !== node.provisionedInstances ||
      node.health.totalInstances !== node.provisionedInstances ||
      node.instances.some(
        (instance) =>
          instance.nodeId !== node.nodeId || instance.kind !== node.kind,
      )
    ) {
      return false;
    }
    const indexes = node.instances
      .map((instance) => instance.instanceIndex)
      .sort();
    if (!indexes.every((index, position) => index === position)) {
      return false;
    }
  }
  return true;
}

/**
 * Bind the reported per-case link identities to the submitted graph. Only
 * presence and identity are required: an unused direct-path spare, an unused
 * Worker or any zero-traffic edge still appears with zero counters. Traffic
 * activity remains visible evidence but is not a binding precondition.
 */
function audienceLinksConsistent(
  item: AudienceCaseResult,
  expected: EngineRunExpectation,
): boolean {
  const expectedEdges = expected.edges;
  if (
    expectedEdges === undefined ||
    expectedEdges.length !== item.links.length
  ) {
    return false;
  }
  const key = (edge: {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly role: string;
  }): string => `${edge.id}\u0000${edge.from}\u0000${edge.to}\u0000${edge.role}`;
  const expectedKeys = expectedEdges.map((edge) =>
    key({ id: edge.id, from: edge.from, to: edge.to, role: edge.role }),
  );
  const actualKeys = item.links.map((link) =>
    key({
      id: link.edgeId,
      from: link.from,
      to: link.to,
      role: link.role,
    }),
  );
  if (
    new Set(expectedKeys).size !== expectedKeys.length ||
    new Set(actualKeys).size !== actualKeys.length
  ) {
    return false;
  }
  return expectedKeys.every((expectedKey) => actualKeys.includes(expectedKey));
}

function audienceCaseConsistent(
  item: AudienceCaseResult,
  expected: EngineRunExpectation,
): boolean {
  const expectedCase = expected.cases.find((candidate) => candidate.id === item.id);
  if (
    expectedCase === undefined ||
    item.kind !== expectedCase.kind ||
    item.targetInstance !== expectedCase.targetInstance
  ) {
    return false;
  }
  if (item.status === 'complete') {
    if (
      !audienceWindowConsistent(item) ||
      !audienceGatesConsistent(item) ||
      !audienceCorrectnessConsistent(item) ||
      !audienceNodesConsistent(item, expected) ||
      !audienceLinksConsistent(item, expected)
    ) {
      return false;
    }
  }
  if (
    item.trafficFrames.some(
      (frame) =>
        frame.scopeId !== item.id || frame.scopeLabel !== item.label,
    )
  ) {
    return false;
  }
  if (expectedCase.targetInstance !== null) {
    const target = item.target;
    const app = item.nodes.find((node) => node.kind === 'app');
    if (target === null) {
      if (item.status === 'complete') {
        return false;
      }
    } else {
      if (target.instanceIndex !== expectedCase.targetInstance) {
        return false;
      }
      if (item.status === 'complete') {
        if (app === undefined || target.nodeId !== app.nodeId) {
          return false;
        }
        if (
          target.crashAtMs !== AUDIENCE_FAULT_SCHEDULE.crashAtMs ||
          target.downUntilMs !==
            AUDIENCE_FAULT_SCHEDULE.crashAtMs +
              AUDIENCE_FAULT_SCHEDULE.downMs ||
          target.restartCount !== AUDIENCE_FAULT_SCHEDULE.restartCount
        ) {
          return false;
        }
      } else if (app !== undefined && target.nodeId !== app.nodeId) {
        return false;
      }
    }
  } else if (item.target !== null) {
    return false;
  }
  if (item.status === 'complete') {
    if (!item.passed) {
      return true;
    }
    const operations = item.operations;
    const correctness = item.correctness;
    const freshness = item.freshness;
    if (operations === null || correctness === null || freshness === null) {
      return false;
    }
    if (item.id !== 'normal' && operations.critical === null) {
      return false;
    }
    if (
      !correctness.valid ||
      !freshness.valid ||
      correctness.finalRankingMatchesReference !== true ||
      correctness.lostAcknowledgedEvents !== 0 ||
      correctness.duplicateLogicalEvents !== 0 ||
      correctness.payloadConflicts !== 0 ||
      correctness.snapshotMismatches !== 0 ||
      correctness.expiryMismatches !== 0
    ) {
      return false;
    }
    const cohorts = [
      operations.ingest,
      operations.read,
      ...(operations.critical === null
        ? []
        : [operations.critical.ingest, operations.critical.read]),
    ];
    for (const metrics of cohorts) {
      const availability = metrics.availability;
      const latency = metrics.latency;
      if (
        availability === null ||
        availability + 1e-9 < AUDIENCE_AVAILABILITY_SLO ||
        latency.p95Ms === null ||
        latency.samples < AUDIENCE_MIN_LATENCY_SAMPLES ||
        latency.insufficientSamples ||
        latency.p95Ms > AUDIENCE_SUCCESSFUL_P95_MS + 1e-9
      ) {
        return false;
      }
    }
  }
  return true;
}

function audienceProvisionedMatches(
  result: AudienceEvaluation,
  expected: EngineRunExpectation,
): boolean {
  const provisioned = result.provisioned;
  if (provisioned === null) {
    return false;
  }
  return (
    provisioned.appInstances === expected.provisioning.appInstances &&
    provisioned.sqlSize === expected.provisioning.sqlSize &&
    provisioned.readPlan === expected.provisioning.readPlan &&
    provisioned.cacheTtlSeconds === expected.provisioning.cacheTtlSeconds &&
    provisioned.workerInstances === expected.provisioning.workerInstances &&
    provisioned.loadBalancer === expected.provisioning.loadBalancer
  );
}

/**
 * Deep guard for a Live Audience evaluation from the trusted worker.
 *
 * `parseAudienceEvaluation` owns the frozen shape and local cross-field
 * invariants. This guards the identity against the exact submitted graph and
 * seed, derives the required case set and physical fault targets from the
 * graph, recomputes operation conservation/availability/percentile arithmetic,
 * and requires a passing case to prove valid correctness, freshness, exact
 * reference agreement and every required SLO gate. It never recomputes the
 * simulation and never mutates the result.
 */
export function isAudienceEvaluationResult(
  value: unknown,
  binding: EngineResultBinding,
): boolean {
  const parsed = parseAudienceEvaluation(value);
  if (!parsed.ok) {
    return false;
  }
  const result = parsed.value;
  if (
    binding.levelId !== AUDIENCE_LEVEL_ID ||
    binding.modelVersion !== AUDIENCE_MODEL_VERSION ||
    binding.schemaVersion !== AUDIENCE_SCHEMA_VERSION ||
    binding.contentVersion !== AUDIENCE_CONTENT_VERSION ||
    binding.pricingVersion !== AUDIENCE_PRICING_VERSION ||
    binding.profileVersion !== AUDIENCE_PROFILE_VERSION ||
    result.levelId !== AUDIENCE_LEVEL_ID ||
    result.modelVersion !== AUDIENCE_MODEL_VERSION ||
    result.schemaVersion !== AUDIENCE_SCHEMA_VERSION ||
    result.contentVersion !== AUDIENCE_CONTENT_VERSION ||
    result.pricingVersion !== AUDIENCE_PRICING_VERSION ||
    result.profileVersion !== AUDIENCE_PROFILE_VERSION ||
    result.seed !== binding.seed ||
    result.identity.levelId !== result.levelId ||
    result.identity.modelVersion !== result.modelVersion ||
    result.identity.schemaVersion !== result.schemaVersion ||
    result.identity.contentVersion !== result.contentVersion ||
    result.identity.pricingVersion !== result.pricingVersion ||
    result.identity.profileVersion !== result.profileVersion ||
    result.identity.seed !== result.seed ||
    result.identity.graphDigest !== result.graphDigest ||
    result.identity.runId !== result.runId
  ) {
    return false;
  }
  if (result.status === 'invalid') {
    // An invalid result is honest only when the bound input itself could not
    // yield a valid qualification expectation. A valid submitted graph always
    // produces an expectation, so an evaluator failure cannot be downgraded to
    // a completed invalid-design result.
    if (binding.expectation !== undefined) {
      return false;
    }
    return (
      (binding.graphDigest === null ||
        binding.graphDigest === result.graphDigest ||
        result.graphDigest === 'invalid') &&
      result.passed === false &&
      result.issues.some((issue) => issue.severity === 'error') &&
      result.provisioned === null &&
      result.cases.length === 0 &&
      result.score.eligible === false &&
      result.score.costUsd === null
    );
  }

  const expectation = binding.expectation;
  if (expectation === undefined) {
    return false;
  }
  const requiredIds = audienceRequiredCaseIds(
    expectation.provisioning.appInstances,
  );
  if (
    expectation.cases.length !== requiredIds.length ||
    expectation.cases.some((item, index) => item.id !== requiredIds[index])
  ) {
    return false;
  }

  if (
    binding.graphDigest === null ||
    result.graphDigest !== binding.graphDigest
  ) {
    return false;
  }

  if (result.status === 'cancelled' || result.status === 'incomplete') {
    if (
      result.passed !== false ||
      result.incompleteReasons.length === 0 ||
      result.score.eligible !== false ||
      result.score.costUsd !== null
    ) {
      return false;
    }
    return result.cases.every((item) =>
      audienceCaseConsistent(item, expectation),
    );
  }

  if (
    result.provisioned === null ||
    !audienceProvisionedMatches(result, expectation) ||
    result.cases.length !== expectation.cases.length ||
    !expectation.cases.every(
      (expectedCase) =>
        result.cases.filter((item) => item.id === expectedCase.id).length === 1,
    ) ||
    result.cases.some((item) => item.status !== 'complete') ||
    !result.cases.every((item) => audienceCaseConsistent(item, expectation))
  ) {
    return false;
  }

  const peak = result.cases.find((item) => item.id === 'peak');
  if (
    peak === undefined ||
    peak.cost === null ||
    !audienceCostConsistent(peak.cost) ||
    result.cases.some(
      (item) => item.cost !== null && !audienceCostConsistent(item.cost),
    )
  ) {
    return false;
  }
  if (result.score.eligible) {
    if (
      result.passed !== true ||
      result.score.caseId !== 'peak' ||
      result.score.costUsd === null ||
      !closeNumber(result.score.costUsd, peak.cost.actualUsd)
    ) {
      return false;
    }
  } else if (result.score.costUsd !== null) {
    return false;
  }

  return result.passed === result.cases.every((item) => item.passed);
}

function sameStringList(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

/**
 * Global Cart envelope guard.
 *
 * The worker cannot fabricate a result: the strict public schema is applied
 * first, then every identity is bound to the submission (level, seed, all
 * seven versioned identities and the submitted graph digest). The six
 * mandatory cases must appear exactly once in frozen order, `complete` must
 * equal the per-case conjunction, and a pass can only be claimed by a complete
 * run with no failing gate, no structural issue and a finite score.
 */
export function isCartEvaluationResult(
  value: unknown,
  binding: EngineResultBinding,
): boolean {
  if (binding.levelId !== CART_LEVEL_ID || value === null) {
    return false;
  }
  const parsed = cartEvaluationSchema.safeParse(value);
  if (!parsed.success) {
    return false;
  }
  const result: CartEvaluation = parsed.data;
  if (
    result.levelId !== binding.levelId ||
    result.seed !== binding.seed ||
    result.seed > CART_MAX_SEED ||
    result.versions.model !== binding.modelVersion ||
    result.versions.graph !== CART_VERSIONS.graph ||
    result.versions.content !==
      (binding.contentVersion ?? CART_VERSIONS.content) ||
    result.versions.pricing !==
      (binding.pricingVersion ?? CART_VERSIONS.pricing) ||
    result.versions.profile !==
      (binding.profileVersion ?? CART_VERSIONS.profile) ||
    result.versions.result !== CART_VERSIONS.result ||
    result.versions.protocol !== CART_VERSIONS.protocol
  ) {
    return false;
  }
  if (
    typeof binding.graphDigest !== 'string'
      ? result.graphDigest !== '0'.repeat(64)
      : result.graphDigest !== binding.graphDigest
  ) {
    return false;
  }
  if (!sameStringList(result.requiredCases, CART_REQUIRED_CASES)) {
    return false;
  }
  if (
    binding.requiredCaseIds !== undefined &&
    !sameStringList(result.requiredCases, binding.requiredCaseIds)
  ) {
    return false;
  }
  if (
    !sameStringList(
      result.cases.map((item) => item.id),
      CART_REQUIRED_CASES,
    )
  ) {
    return false;
  }

  let allCasesComplete = true;
  let anyFailedGate = false;
  for (const item of result.cases) {
    if (
      item.issued > item.scheduled ||
      item.dependencyFailed > item.issued ||
      item.gates.some((gate) => gate.caseId !== item.id)
    ) {
      return false;
    }
    if (!item.complete) {
      allCasesComplete = false;
    }
    if (item.gates.some((gate) => !gate.pass)) {
      anyFailedGate = true;
    }
    if (item.complete && item.issued === 0 && item.gates.length === 0) {
      return false;
    }
  }
  if (result.complete !== allCasesComplete) {
    return false;
  }

  if (result.qualified) {
    if (
      !result.complete ||
      anyFailedGate ||
      result.issues.length > 0 ||
      result.scoreCreditsPerHour === null
    ) {
      return false;
    }
    return result.scoreCreditsPerHour >= 0;
  }
  return result.scoreCreditsPerHour === null;
}

/** Dispatch result validation by registered level, never by caller claim. */
export function isEngineEvaluationResult(
  levelId: string,
  value: unknown,
  binding: EngineResultBinding,
): boolean {
  if (binding.levelId !== levelId) {
    return false;
  }
  switch (levelId) {
    case COLD_CACHE_LEVEL_ID:
      return isColdCacheEvaluationResult(value, binding);
    case PARCEL_LEVEL_ID:
      return (
        isParcelEvaluationResult(value) &&
        isRecord(value) &&
        isRecord(value.meta) &&
        value.meta.levelId === binding.levelId &&
        value.meta.modelVersion === binding.modelVersion &&
        value.meta.seed === binding.seed &&
        value.meta.graphDigest === binding.graphDigest
      );
    case IMAGE_LEVEL_ID:
      return isImageEvaluationResult(value, binding);
    case SCOREBOARD_LEVEL_ID:
      return isScoreboardEvaluationResult(value, binding);
    case AUDIENCE_LEVEL_ID:
      return isAudienceEvaluationResult(value, binding);
    case CART_LEVEL_ID:
      return isCartEvaluationResult(value, binding);
    default:
      return false;
  }
}

export function isParcelEvaluationResult(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const meta = value.meta;
  if (!isMeta(meta)) {
    return false;
  }
  if (
    (value.status !== 'ok' &&
      value.status !== 'invalid' &&
      value.status !== 'error') ||
    typeof value.passed !== 'boolean' ||
    !Array.isArray(value.issues) ||
    !value.issues.every(isIssue) ||
    !Array.isArray(value.diagnostics) ||
    !value.diagnostics.every(isDiagnostic) ||
    !isStringArray(value.assumptions) ||
    value.assumptions.length === 0 ||
    !Array.isArray(value.checks) ||
    !value.checks.every(isCheck)
  ) {
    return false;
  }

  if (value.status !== 'error') {
    const seed = meta.seed;
    if (typeof seed !== 'number' || seed < 0 || seed > PARCEL_MAX_SEED) {
      return false;
    }
  }

  if (value.status === 'invalid' || value.status === 'error') {
    if (
      value.passed !== false ||
      !Array.isArray(value.horizons) ||
      value.horizons.length !== 0 ||
      value.capacity !== null ||
      value.cost !== null ||
      value.checks.length !== 0
    ) {
      return false;
    }
    if (value.status === 'invalid') {
      return (
        value.error === undefined &&
        value.issues.some(
          (issue) => isRecord(issue) && issue.severity === 'error',
        )
      );
    }
    return isErrorValue(value.error);
  }

  if (
    value.error !== undefined ||
    !isNonEmptyString(meta.graphDigest) ||
    !isExactHorizons(meta.requestedHorizons, PARCEL_REQUIRED_HORIZONS) ||
    !Array.isArray(value.horizons) ||
    value.horizons.length !== 2 ||
    !isHorizonResult(value.horizons[0], 1) ||
    !isHorizonResult(value.horizons[1], 5) ||
    !isCapacity(value.capacity, 5) ||
    !isCost(value.cost, ['1', '5']) ||
    value.checks.length < 3
  ) {
    return false;
  }

  const first = value.horizons[0] as { passed: boolean };
  const second = value.horizons[1] as { passed: boolean };
  if (
    !hasUniqueCheckIds(value.checks) ||
    !hasRequiredCheck(value.checks, 'horizons_complete', true) ||
    !hasRequiredCheck(value.checks, 'horizon_pass:1', first.passed, 1) ||
    !hasRequiredCheck(value.checks, 'horizon_pass:5', second.passed, 5)
  ) {
    return false;
  }
  if (value.passed !== (first.passed && second.passed)) {
    return false;
  }
  if (
    value.passed &&
    value.checks.some(
      (check) =>
        isRecord(check) &&
        check.severity === 'required' &&
        check.passed !== true,
    )
  ) {
    return false;
  }
  return true;
}
