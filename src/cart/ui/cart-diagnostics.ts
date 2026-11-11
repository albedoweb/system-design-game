/**
 * View model for Global Cart results (GC-014).
 *
 * The engine emits gates as bare numbers. This module turns each gate into a
 * readable check: a title built from the gate code, region and operation, the
 * measured value and the required value formatted by kind, and a plain-English
 * sentence about the sample behind it. Business outcomes are classified into
 * distinct classes so OutOfStock, an unavailable answer, a partial cart and a
 * reply lost after a durable commit can never be confused with each other.
 *
 * Graph locations come from the executed request records when the caller
 * attaches capture evidence; without that evidence the view says so instead of
 * inventing a path.
 */
import {
  CART_REGION_INFO,
  CART_REQUIRED_CASES,
  buildCartDiagnostics,
  type CartCaseId,
  type CartCaseResult,
  type CartDiagnostic,
  type CartEvaluation,
  type CartGate,
  type CartGraph,
  type CartOperationClass,
  type CartRegion,
  type CartTelemetryCapture,
} from '../index';
import { formatInteger } from '../../ui/format';
import {
  cartNodeName,
  cartRegionName,
} from './cart-frames';

export interface CartEvidenceView {
  readonly records: CartTelemetryCapture['records'];
  readonly transfers: CartTelemetryCapture['transfers'];
  readonly readResults: CartTelemetryCapture['readResults'];
}

/** Stable class ids stay pronouncable in tests; labels are the product copy. */
export type CartOutcomeClass =
  | 'out-of-stock'
  | 'unavailable'
  | 'partial-cart'
  | 'lost-reply-after-commit'
  | 'committed'
  | 'replay'
  | 'conflict'
  | 'selection-changed'
  | 'validation-failed'
  | 'dependency-failed'
  | 'timeout'
  | 'rejected';

export const CART_OUTCOME_LABELS: Readonly<Record<CartOutcomeClass, string>> = {
  'out-of-stock': 'OutOfStock',
  unavailable: 'Temporarily unavailable',
  'partial-cart': 'Partial cart',
  'lost-reply-after-commit': 'Lost reply after commit',
  committed: 'Committed',
  replay: 'Replay accepted',
  conflict: 'Idempotency conflict',
  'selection-changed': 'Selection changed',
  'validation-failed': 'Validation failed',
  'dependency-failed': 'Dependency unavailable',
  timeout: 'No reply before deadline',
  rejected: 'Rejected before mutation',
};

export const CART_OUTCOME_EXPLANATIONS: Readonly<Record<CartOutcomeClass, string>> = {
  'out-of-stock':
    'The Inventory transaction compared every basket line against stock, changed nothing and recorded a durable OutOfStock result. It is a business answer, not an availability failure.',
  unavailable:
    'No authoritative result could be obtained. This is an explicit unavailable answer; an unknown ledger is never reported as OutOfStock.',
  'partial-cart':
    'The read returned a PartialCart diagnostic with missing token coverage. It is not a complete view and never qualifies a checkout.',
  'lost-reply-after-commit':
    'The origin authority durably committed the operation, but the terminal reply never reached the client. The commit survives; the already serialized reply bytes are still billed.',
  committed: 'The operation was durably committed and its terminal reply reached the client.',
  replay: 'A retry with the same key and payload returned the original recorded outcome without a second effect.',
  conflict: 'The same key carried a different payload or context. Nothing was mutated.',
  'selection-changed': 'The submitted selection differed from the token-complete view. Nothing was bought.',
  'validation-failed': 'The request failed validation before reaching durable state.',
  'dependency-failed': 'A required dependency was unavailable when the request was offered; it was recorded, not rescheduled.',
  timeout: 'The offered request ended without a terminal reply before its absolute deadline.',
  rejected: 'The attempt was explicitly rejected before any mutation.',
};

export interface CartGateView {
  readonly key: string;
  /** Raw engine code; shown only as a tooltip. */
  readonly code: string;
  /** Readable check title, e.g. "Read latency p95 — EU Central · Frankfurt". */
  readonly title: string;
  readonly caseId: CartCaseId;
  readonly region: CartRegion;
  readonly operation: CartOperationClass;
  readonly cohort: string;
  readonly observed: number;
  readonly limit: number;
  readonly pass: boolean;
  readonly measuredLabel: string;
  readonly limitLabel: string;
  /** Plain-English requirement this check enforces; empty when not known. */
  readonly requirement: string;
  /** Measured value, required value, sample size and, for failures, what it means. */
  readonly explanation: string;
  readonly evidenceCount: number;
  readonly diagnostics: readonly CartDiagnostic[];
}

/** How a gate's numbers are displayed; decided from the code because gates carry no unit. */
export type CartGateValueKind = 'ratio' | 'latency' | 'count' | 'credits';

const RATIO_GATE_PREFIXES = [
  'healthy-slo-',
  'affected-terminal-',
  'probe-terminal-',
];

const OPERATION_NAMES: Readonly<Record<string, string>> = {
  edit: 'Edit',
  read: 'Read',
  checkout: 'Checkout',
  probe: 'Scripted check',
  audit: 'Audit',
};

export function cartGateValueKind(code: string): CartGateValueKind {
  if (code.startsWith('budget-credits-per-hour')) return 'credits';
  if (RATIO_GATE_PREFIXES.some((prefix) => code.startsWith(prefix))) return 'ratio';
  if ((code.includes('p95') || code.includes('latency')) && !code.includes('samples')) return 'latency';
  return 'count';
}

/** Latency values are stored in microseconds and shown as milliseconds with one decimal. */
const LATENCY_MS_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function cartLatencyLabel(microseconds: number): string {
  return `${LATENCY_MS_FORMAT.format(microseconds / 1_000)} ms`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function creditsPerHour(value: number): string {
  return `${value.toFixed(2)} credits/hour`;
}

function formatGateValue(gate: Pick<CartGate, 'code' | 'observed' | 'limit'>, value: number): string {
  switch (cartGateValueKind(gate.code)) {
    case 'ratio':
      return percent(value);
    case 'latency':
      return cartLatencyLabel(value);
    case 'credits':
      return value < 0 ? 'not measured' : creditsPerHour(value);
    case 'count':
      return formatInteger(value);
  }
}

export function cartGateMeasuredLabel(gate: CartGate): string {
  return formatGateValue(gate, gate.observed);
}

export function cartGateLimitLabel(gate: CartGate): string {
  return formatGateValue(gate, gate.limit);
}

function humanize(text: string): string {
  const spaced = text.replace(/[-_]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function withoutSuffix(text: string, suffix: string): string {
  return text.endsWith(`-${suffix}`) ? text.slice(0, -(suffix.length + 1)) : text;
}

/**
 * Edits that arrived while an earlier change of the same cart was still waiting
 * to be saved. The normal case has the `local-context-edit` cohort instead.
 */
function isBacklogEditCohort(cohort: string | undefined): boolean {
  return cohort !== undefined && cohort.startsWith('healthy');
}

/** Readable check title from the gate code, region, operation and cohort. */
export function cartGateTitle(gate: Pick<CartGate, 'code' | 'region' | 'operation'> & { readonly cohort?: string }): string {
  const { code, region, operation, cohort } = gate;
  const regionName = region in CART_REGION_INFO ? cartRegionName(region) : region;
  const op = OPERATION_NAMES[operation] ?? humanize(operation);
  const inRegion = (text: string) => `${text} — ${regionName}`;
  // Latency and sample gates encode "peak-" and a cohort between the prefix and the operation.
  const cohortParts = (prefix: string) => {
    const middle = withoutSuffix(withoutSuffix(code, region), operation).replace(prefix, '');
    const peak = middle.startsWith('peak-');
    const cohort = peak ? middle.slice('peak-'.length) : middle;
    return {
      peak,
      cohortNote: cohort === '' || cohort === 'healthy' || cohort === 'local-context-edit' ? '' : ` (${cohort.replace(/-/g, ' ')})`,
    };
  };

  if (code.startsWith('healthy-slo-edit') && isBacklogEditCohort(cohort)) {
    return inRegion('Edits that arrived before the previous change was saved');
  }
  if (code.startsWith('healthy-slo-')) {
    return inRegion(operation === 'read' ? `${op} availability` : `${op} success rate`);
  }
  if (code.startsWith('probe-terminal-')) {
    return inRegion('Scripted checks reaching their expected result');
  }
  if (code.startsWith('affected-terminal-')) {
    return inRegion(`${op} answers during the incident`);
  }
  if (code.startsWith('ordinary-p95-')) {
    const { peak, cohortNote } = cohortParts('ordinary-p95-');
    return inRegion(`${op} latency p95${peak ? ' during the rush' : ''}${cohortNote}`);
  }
  if (code.startsWith('latency-samples-')) {
    const { peak, cohortNote } = cohortParts('latency-samples-');
    return inRegion(`Enough latency samples (${operation}${peak ? ' during the rush' : ''}${cohortNote})`);
  }
  if (code.startsWith('budget-credits-per-hour')) return 'Peak cost within budget';
  if (code === 'safety-audit') return 'Safety audit of every request';
  if (code === 'inventory-invariants') return 'Inventory stock invariants';
  if (code === 'topology-qualified') return 'Topology serves every region';
  if (code === 'recovery-barrier') return 'Recovery reads delivered on time';
  if (code === 'probe-oracle-denominator') return 'Scripted check count';
  if (code === 'probe-oracle-pass') return 'Every scripted check matches';
  if (code.startsWith('probe-oracle:')) return `Scripted check: ${humanize(code.slice('probe-oracle:'.length))}`;
  return humanize(code);
}

/** Frozen requirement text for a gate code family; empty when the family is unknown. */
export function cartGateRequirement(code: string): string {
  if (code.startsWith('healthy-slo-edit')) {
    return 'Healthy-region edits require p95 < 50 ms and at least 99% of offered edits to get a correct saved confirmation by the 1000 ms deadline.';
  }
  if (code.startsWith('healthy-slo-read')) {
    return 'Healthy-region reads require p95 ≤ 500 ms and at least 99% availability, with the session token and every causally required edit covered.';
  }
  if (code.startsWith('healthy-slo-checkout')) {
    return 'Checkout requires p95 ≤ 750 ms and at least 99% definitive answers per region; an unknown ledger never counts as a stock answer.';
  }
  if (code.startsWith('healthy-slo-probe') || code.startsWith('probe-terminal')) {
    return 'Every scheduled scripted check must reach its expected result; checks are never sampled away or exempted.';
  }
  if (code.startsWith('affected-terminal')) {
    return 'Operations affected by an incident must return a provably correct complete result or an explicit TemporarilyUnavailable within 1000 ms.';
  }
  if (code.startsWith('recovery-barrier')) {
    return 'Every recovery read must be delivered by 55 s and include all edits committed before restoration at 50 s.';
  }
  if (code === 'safety-audit') {
    return 'Every request must pass the full safety audit: token coverage, causal closure, exact basket, durable confirmation and idempotent replay.';
  }
  if (code === 'topology-qualified') {
    return 'The submitted topology must provide a reachable origin authority, a durable write target, and the Inventory authority required by every region.';
  }
  if (code.startsWith('probe-oracle')) {
    return 'Each scripted check must match its expected outcome, including exact stock effects and replay behaviour.';
  }
  return '';
}

/** What a failed check means, in plain words. Empty for passing checks. */
function gateHint(gate: CartGate): string {
  if (gate.pass) return '';
  if (gate.code.startsWith('healthy-slo-edit') && isBacklogEditCohort(gate.cohort)) {
    return 'A small group that appears only when storage is backlogged; see Overloaded components.';
  }
  if (gate.code.startsWith('healthy-slo-edit')) {
    return 'At least one offered edit did not get a correct saved confirmation before its deadline; the slowest edits are listed in the request timeline.';
  }
  if (gate.code.startsWith('healthy-slo-read')) {
    return 'At least one read did not return a complete view or an explicit unavailable answer.';
  }
  if (gate.code.startsWith('healthy-slo-checkout')) {
    return 'At least one checkout did not reach a definitive answer. Business outcomes separate out-of-stock, unavailable and lost replies after commit.';
  }
  if (gate.code.startsWith('affected-terminal')) {
    return 'At least one operation during the incident did not return a complete result or an explicit unavailable answer.';
  }
  if (gate.code.startsWith('probe-oracle')) {
    return 'A scripted check did not match its expected outcome.';
  }
  if (gate.code === 'safety-audit' || gate.code.startsWith('recovery')) {
    return 'The safety or recovery audit found at least one contract violation; no partition group can relax this check.';
  }
  return '';
}

function gateExplanation(gate: CartGate, evidenceCount: number): string {
  const kind = cartGateValueKind(gate.code);
  const direction = kind === 'latency' || kind === 'credits' ? 'at most' : 'at least';
  const measured = kind === 'credits' && gate.observed < 0
    ? 'No cost was measured'
    : `Measured ${cartGateMeasuredLabel(gate)}`;
  const sentence = `${measured}; required ${direction} ${cartGateLimitLabel(gate)}.`;
  const sample = evidenceCount > 0
    ? ` Based on ${formatInteger(evidenceCount)} sampled request${evidenceCount === 1 ? '' : 's'}.`
    : '';
  const hint = gateHint(gate);
  return `${sentence}${sample}${hint ? ` ${hint}` : ''}`;
}

/**
 * Builds the gate rows for the evaluation, attaching core diagnostics when
 * execution evidence is available. Passing gates never get a diagnostic, but
 * they still get a row with measured value, limit and sample size.
 */
export function buildCartGateViews(
  evaluation: CartEvaluation,
  options: {
    readonly graph: CartGraph;
    readonly evidence?: ReadonlyMap<CartCaseId, CartEvidenceView>;
    readonly caseFilter?: CartCaseId;
  },
): CartGateView[] {
  const diagnosticsByCase = new Map<CartCaseId, CartDiagnostic[]>();
  if (options.evidence !== undefined) {
    for (const [caseId, evidence] of options.evidence) {
      diagnosticsByCase.set(
        caseId,
        buildCartDiagnostics({
          graph: options.graph,
          evaluation,
          records: evidence.records,
          transfers: evidence.transfers,
          readResults: evidence.readResults,
        }).filter((diagnostic) => diagnostic.kind !== 'topology' && diagnostic.caseId === caseId),
      );
    }
  }
  const views: CartGateView[] = [];
  for (const caseResult of evaluation.cases) {
    if (options.caseFilter !== undefined && caseResult.id !== options.caseFilter) continue;
    const diagnostics = diagnosticsByCase.get(caseResult.id) ?? [];
    for (const gate of caseResult.gates) {
      const matched = diagnostics.filter(
        (diagnostic) => diagnostic.gateCode === gate.code &&
          diagnostic.region === gate.region && diagnostic.operation === gate.operation &&
          diagnostic.cohort === gate.cohort,
      ).map((diagnostic) => ({
        ...diagnostic,
        locations: requestLocations(options.graph, options.evidence?.get(caseResult.id)?.transfers ?? [], new Set(gate.evidenceIds)),
      }));
      views.push({
        key: `${caseResult.id}|${gate.code}|${gate.region}|${gate.operation}|${gate.cohort}`,
        code: gate.code,
        title: cartGateTitle(gate),
        caseId: caseResult.id,
        region: gate.region,
        operation: gate.operation,
        cohort: gate.cohort,
        observed: gate.observed,
        limit: gate.limit,
        pass: gate.pass,
        measuredLabel: cartGateMeasuredLabel(gate),
        limitLabel: cartGateLimitLabel(gate),
        requirement: cartGateRequirement(gate.code),
        explanation: gateExplanation(gate, gate.evidenceIds.length),
        evidenceCount: gate.evidenceIds.length,
        diagnostics: matched,
      });
    }
  }
  return views;
}

/**
 * Failed-check order for "What failed" and the per-scenario failed table:
 * (1) whole-scenario latency p95, (2) rush-window latency p95, (3) rate checks
 * (success, availability, terminal answers), (4) latency sample counts,
 * (5) everything else. Stable within a group.
 */
export function cartGateOrderGroup(code: string): number {
  if (code.startsWith('ordinary-p95-peak-')) return 2;
  if (code.startsWith('ordinary-p95-')) return 1;
  if (RATIO_GATE_PREFIXES.some((prefix) => code.startsWith(prefix))) return 3;
  if (code.startsWith('latency-samples-')) return 4;
  return 5;
}

export function orderFailedCartViews(views: readonly CartGateView[]): CartGateView[] {
  return views
    .map((view, index) => ({ view, index }))
    .sort((a, b) => cartGateOrderGroup(a.view.code) - cartGateOrderGroup(b.view.code) || a.index - b.index)
    .map((item) => item.view);
}

/** Whether a scenario passed: complete, with gates, and every gate passing. */
export function cartCasePassed(evaluation: CartEvaluation, caseId: CartCaseId): boolean {
  const caseResult = evaluation.cases.find((item) => item.id === caseId);
  if (caseResult === undefined) return false;
  return caseResult.complete && caseResult.gates.length > 0 && caseResult.gates.every((gate) => gate.pass);
}

export interface CartGateSummary {
  readonly total: number;
  readonly failed: number;
  readonly failedCases: readonly CartCaseId[];
}

export function summarizeCartGates(evaluation: CartEvaluation): CartGateSummary {
  let total = 0;
  let failed = 0;
  const failedCases: CartCaseId[] = [];
  for (const caseResult of evaluation.cases) {
    let caseFailed = false;
    for (const gate of caseResult.gates) {
      total += 1;
      if (!gate.pass) {
        failed += 1;
        caseFailed = true;
      }
    }
    if (caseFailed) failedCases.push(caseResult.id);
  }
  return { total, failed, failedCases };
}

/** True only when a complete run passed every required gate. */
export function cartRankingEligible(evaluation: CartEvaluation): boolean {
  return (
    evaluation.complete &&
    evaluation.qualified &&
    evaluation.scoreCreditsPerHour !== null &&
    Number.isFinite(evaluation.scoreCreditsPerHour) &&
    evaluation.scoreCreditsPerHour >= 0 &&
    CART_REQUIRED_CASES.every((id) => {
      const cases = evaluation.cases.filter((item) => item.id === id);
      return cases.length === 1 && cases[0]!.complete && cases[0]!.gates.length > 0 &&
        cases[0]!.gates.every((gate) => gate.pass);
    })
  );
}

/** Only endpoints of observed exchanges are request locations, not nearby nodes. */
function requestLocations(
  graph: CartGraph,
  transfers: CartEvidenceView['transfers'],
  recordIds: ReadonlySet<string>,
): { nodeIds: string[]; edgeIds: string[] } {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  for (const transfer of transfers) {
    if (![...recordIds].some((id) => transfer.logicalId.startsWith(`${id}:`))) continue;
    const endpoints = [transfer.from, transfer.to].map((endpoint) =>
      endpoint.kind === 'node' ? endpoint.nodeId :
        graph.nodes.find((node) => node.kind === 'customers' && node.region === endpoint.region)?.id,
    );
    for (const id of endpoints) if (id !== undefined) nodes.add(id);
    for (const edge of graph.edges) {
      if ((edge.from === endpoints[0] && edge.to === endpoints[1]) ||
          (edge.from === endpoints[1] && edge.to === endpoints[0])) edges.add(edge.id);
    }
  }
  return { nodeIds: [...nodes].sort(), edgeIds: [...edges].sort() };
}

function retryAttempts(transfers: CartEvidenceView['transfers'], recordId: string): number {
  const pattern = /:(?:in|lookup|lookup-reply|commit|commit-reply|out|unavailable):(\d+)$/;
  let attempts = 0;
  for (const transfer of transfers) {
    if (!transfer.logicalId.startsWith(`${recordId}:`)) continue;
    const match = pattern.exec(transfer.logicalId);
    if (match !== null && Number(match[1] ?? '0') > 0) attempts = Math.max(attempts, Number(match[1]));
  }
  return attempts;
}

function waitingUs(transfers: CartEvidenceView['transfers'], recordId: string): number {
  let waiting = 0;
  for (const transfer of transfers) {
    if (!transfer.logicalId.startsWith(`${recordId}:`)) continue;
    let previous = transfer.enqueuedAtUs;
    for (const stage of transfer.stages) {
      if (stage.startedUs !== null && stage.startedUs > previous) {
        waiting += stage.startedUs - previous;
      }
      previous =
        stage.completedUs ??
        (stage.state === 'cancelled' ? (transfer.cancelledAtUs ?? previous) : previous);
    }
  }
  return waiting;
}

export interface CartOutcomeRow {
  readonly key: string;
  readonly recordId: string;
  readonly outcomeClass: CartOutcomeClass;
  readonly label: string;
  readonly operation: string;
  readonly region: CartRegion;
  readonly cartId: string;
  readonly offeredMs: number;
  readonly deliveredMs: number | null;
  readonly durationMs: number | null;
  readonly retryAttempts: number;
  readonly waitingMs: number;
  readonly explanation: string;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
}

function classifyOutcome(
  record: CartEvidenceView['records'][number],
  readKind: 'complete' | 'partial' | 'unavailable' | null,
): CartOutcomeClass {
  if (readKind === 'partial') return 'partial-cart';
  if (record.committed && !record.acknowledged) return 'lost-reply-after-commit';
  switch (record.outcome) {
    case 'out-of-stock':
      return 'out-of-stock';
    case 'unavailable':
      return 'unavailable';
    case 'committed':
      return 'committed';
    case 'duplicate-commit':
      return 'replay';
    case 'conflict':
      return 'conflict';
    case 'selection-changed':
      return 'selection-changed';
    case 'validation-failed':
      return 'validation-failed';
    case 'dependency-failed':
      return 'dependency-failed';
    case 'timeout':
      return 'timeout';
    case 'rejected':
      return 'rejected';
    default:
      return 'timeout';
  }
}

/**
 * One row per executed request, ordered by offer time. A partial read is
 * classified before the generic durable/ACK flags, and a durable commit without
 * an acknowledgement is never shown as unavailable or OutOfStock.
 */
export function buildCartOutcomeRows(
  graph: CartGraph,
  evidence: CartEvidenceView,
): CartOutcomeRow[] {
  return [...evidence.records]
    .sort((left, right) => left.offeredUs - right.offeredUs || (left.id < right.id ? -1 : 1))
    .map((record) => {
      const read = evidence.readResults.get(record.id);
      const readKind = read === undefined ? null : read.kind;
      const outcomeClass = classifyOutcome(record, readKind);
      const locations = requestLocations(graph, evidence.transfers, new Set([record.id]));
      const delivered = record.deliveredUs;
      return {
        key: `${record.caseId}|${record.id}`,
        recordId: record.id,
        outcomeClass,
        label: CART_OUTCOME_LABELS[outcomeClass],
        operation: record.operation,
        region: record.region as CartRegion,
        cartId: record.cartId,
        offeredMs: record.offeredUs / 1_000,
        deliveredMs: delivered === null ? null : delivered / 1_000,
        durationMs: delivered === null ? null : (delivered - record.offeredUs) / 1_000,
        retryAttempts: retryAttempts(evidence.transfers, record.id),
        waitingMs: waitingUs(evidence.transfers, record.id) / 1_000,
        explanation: `${CART_OUTCOME_EXPLANATIONS[outcomeClass]}${read !== undefined && read.kind !== 'complete' ? ` Missing token operations: ${read.missingTokenIds.join(', ') || 'none recorded'}.` : ''}`,
        nodeIds: locations.nodeIds,
        edgeIds: locations.edgeIds,
      };
    });
}

/** Focus label for a location: the graph node name, not its internal id. */
export function cartLocationLabel(graph: CartGraph, nodeId: string): string {
  const node = graph.nodes.find((item) => item.id === nodeId);
  return node === undefined ? nodeId : cartNodeName(node);
}

export { cartRegionName } from './cart-frames';

/** Scenario name shown to players; `normal` and `peak` are the Foundations scenarios. */
export function cartCaseLabel(caseId: CartCaseId): string {
  switch (caseId) {
    case 'normal':
      return 'Normal shopping';
    case 'peak':
      return 'Shopping Rush';
    case 'mobility':
      return 'Moving regions';
    case 'concurrent':
      return 'Concurrent edits';
    case 'partition':
      return 'Tokyo partition';
    case 'checkout':
      return 'Checkout races';
  }
}

export function caseResultById(
  evaluation: CartEvaluation,
  caseId: CartCaseId,
): CartCaseResult | null {
  return evaluation.cases.find((caseResult) => caseResult.id === caseId) ?? null;
}
