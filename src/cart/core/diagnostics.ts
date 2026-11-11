/**
 * Causal diagnostics for Global Cart gates (GC-012).
 *
 * Every failed gate is explained with its measured value, threshold, case and
 * cohort, then linked to concrete operations and graph locations:
 * - `evidenceIds` resolve to the executed request records retained by the run;
 * - those records map to the application, write authority and Inventory nodes
 *   of their region, plus the semantic edges that connect them;
 * - physical exchanges that belong to the operation explain ACK loss, queue
 *   waiting and retry attempts without inventing a second accounting path.
 *
 * Diagnostics are English product copy derived from observed data. They never
 * re-run, relax or suppress a gate.
 */
import {
  type CartCaseResult,
  type CartEvaluation,
  type CartGate,
  type CartGraph,
} from '../contracts';
import { analyzeCartTopology, type CartRequestRecord } from './model';
import type { CartTransfer } from './network';
import { isCartRetryTransfer } from './telemetry';
import type { CartReadOutcome } from './reads';

export type CartDiagnosticKind =
  | 'topology'
  | 'gate-failure'
  | 'missing-token'
  | 'commit-loss'
  | 'ack-loss'
  | 'resource-waiting'
  | 'checkout-decision';

export interface CartDiagnosticOperation {
  readonly recordId: string;
  readonly cartId: string;
  readonly region: string;
  readonly operation: string;
  readonly outcome: string;
  readonly committed: boolean;
  readonly acknowledged: boolean;
  readonly unresolved: boolean;
  readonly rejected: boolean;
  readonly offeredUs: number;
  readonly deliveredUs: number | null;
  readonly retryAttempts: number;
  readonly waitingUs: number;
}

export interface CartDiagnosticLocations {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
}

export interface CartDiagnostic {
  readonly id: string;
  readonly kind: CartDiagnosticKind;
  readonly severity: 'error' | 'warning';
  /** Failed gate this explains, when the diagnostic is gate-derived. */
  readonly gateCode: string | null;
  readonly caseId: string | null;
  readonly region: string | null;
  readonly operation: string | null;
  readonly cohort: string | null;
  readonly title: string;
  readonly message: string;
  readonly observed: number | null;
  readonly limit: number | null;
  readonly evidenceIds: readonly string[];
  readonly operations: readonly CartDiagnosticOperation[];
  readonly locations: CartDiagnosticLocations;
  readonly missingTokenIds: readonly string[];
}

export interface CartDiagnosticInput {
  readonly graph: CartGraph;
  readonly evaluation: CartEvaluation;
  /** Executed request records; required to link a gate to real operations. */
  readonly records?: readonly CartRequestRecord[];
  /** Physical transfers of the captured case; explains loss and waiting. */
  readonly transfers?: readonly CartTransfer[];
  /** Read outcomes by request id; names missing token operations. */
  readonly readResults?: ReadonlyMap<string, CartReadOutcome>;
}

function nodeIdsForRegion(input: CartDiagnosticInput, region: string): string[] {
  const ids: string[] = [];
  for (const node of input.graph.nodes) {
    if (node.region !== region) continue;
    if (node.kind === 'application' || node.kind === 'journal' || node.kind === 'store') {
      ids.push(node.id);
    } else if (node.kind === 'inventory') {
      ids.push(node.id);
    }
  }
  return ids;
}

function edgesForNodes(input: CartDiagnosticInput, nodeIds: readonly string[]): string[] {
  const set = new Set(nodeIds);
  const ids: string[] = [];
  for (const edge of input.graph.edges) {
    if (set.has(edge.from) || set.has(edge.to)) ids.push(edge.id);
  }
  return ids.slice(0, 12);
}

/**
 * Waiting time actually spent in physical FIFOs for one operation: each stage's
 * start minus the previous stage's completion (or the transfer's offer for the
 * first stage). Only positive waits count; serialization is not waiting.
 */
function transferWaitingUs(transfer: CartTransfer): number {
  let waiting = 0;
  let previous = transfer.enqueuedAtUs;
  for (const stage of transfer.stages) {
    if (stage.startedUs !== null && stage.startedUs > previous) {
      waiting += stage.startedUs - previous;
    }
    previous =
      stage.completedUs ??
      (stage.state === 'cancelled' ? (transfer.cancelledAtUs ?? previous) : previous);
  }
  return waiting;
}

function operationForRecord(
  record: CartRequestRecord,
  transfers: readonly CartTransfer[],
): CartDiagnosticOperation {
  const related = transfers.filter((transfer) => transfer.logicalId.startsWith(`${record.id}:`));
  return {
    recordId: record.id,
    cartId: record.cartId,
    region: record.region,
    operation: record.operation,
    outcome: record.outcome,
    committed: record.committed,
    acknowledged: record.acknowledged,
    unresolved: record.unresolved,
    rejected: record.rejected,
    offeredUs: record.offeredUs,
    deliveredUs: record.deliveredUs,
    retryAttempts: related.filter(isCartRetryTransfer).length,
    waitingUs: related.reduce((sum, transfer) => sum + transferWaitingUs(transfer), 0),
  };
}

function missingTokensFor(
  readResults: ReadonlyMap<string, CartReadOutcome> | undefined,
  recordIds: readonly string[],
): string[] {
  if (readResults === undefined) return [];
  const ids: string[] = [];
  for (const recordId of recordIds) {
    const outcome = readResults.get(recordId);
    if (outcome === undefined) continue;
    if (outcome.kind === 'complete') continue;
    for (const id of outcome.missingTokenIds) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids.slice(0, 20);
}

function classifyKind(
  gate: CartGate,
  operations: readonly CartDiagnosticOperation[],
  waitingUs: number,
): CartDiagnosticKind {
  if (gate.code === 'safety-audit' || gate.code.startsWith('recovery')) return 'ack-loss';
  if (gate.operation === 'checkout') return 'checkout-decision';
  if (gate.operation === 'read' || gate.operation === 'probe' || gate.operation === 'audit') {
    return 'missing-token';
  }
  if (operations.some((operation) => operation.committed && !operation.acknowledged)) {
    return 'commit-loss';
  }
  if (waitingUs > 0) return 'resource-waiting';
  if (operations.some((operation) => operation.unresolved && !operation.rejected)) return 'ack-loss';
  return 'gate-failure';
}

function gateMessage(
  gate: CartGate,
  kind: CartDiagnosticKind,
  operations: readonly CartDiagnosticOperation[],
  missingTokenIds: readonly string[],
): string {
  const head = `Gate ${gate.code} measured ${gate.observed} against a required ${gate.limit} for ${gate.cohort} in the ${gate.caseId} case (${gate.region}, ${gate.operation}).`;
  switch (kind) {
    case 'missing-token': {
      const suffix =
        missingTokenIds.length === 0
          ? 'No complete token or certificate evidence was available for the failing operations.'
          : `Missing operations: ${missingTokenIds.join(', ')}.`;
      return `${head} ${operations.length} evidence operation(s) could not close their required token coverage over the configured request paths. ${suffix}`;
    }
    case 'commit-loss':
      return `${head} An origin authority durably committed the edit, but the terminal acknowledgement never reached the client. The committed data stays committed, and the already serialized reply bytes remain billed.`;
    case 'ack-loss':
      return `${head} ${operations.filter((operation) => operation.unresolved).length} offered operation(s) ended without a terminal reply before their deadline. Work that ran is charged even though the client observed nothing.`;
    case 'resource-waiting': {
      const waiting = operations.reduce((sum, operation) => sum + operation.waitingUs, 0);
      return `${head} Physical FIFO waiting of ${waiting}µs delayed ${operations.length} evidence operation(s); saturated links are a capacity choice, not a protocol exemption.`;
    }
    case 'checkout-decision': {
      const outcomes = new Map<string, number>();
      for (const operation of operations) {
        outcomes.set(operation.outcome, (outcomes.get(operation.outcome) ?? 0) + 1);
      }
      const summary = [...outcomes.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([outcome, count]) => `${outcome}=${count}`)
        .join(', ');
      return `${head} Checkout outcomes were ${summary || 'not observed'}. Replay and conflict answers come from the durable ledger; an unknown key is never a stock failure.`;
    }
    case 'topology':
      return `${head} The submitted topology cannot satisfy this cohort; inspection issues identify the responsible nodes or edges.`;
    case 'gate-failure':
      return `${head} ${operations.length} evidence operation(s) did not meet the gate; each remains in the denominator.`;
  }
}

function diagnosticId(prefix: string, ordinal: number): string {
  return `${prefix}:${ordinal}`;
}

/** Builds one diagnostic for a failed gate. */
export function diagnoseCartGate(
  gate: CartGate,
  input: CartDiagnosticInput,
  ordinal = 0,
): CartDiagnostic {
  const records = input.records ?? [];
  const transfers = input.transfers ?? [];
  const evidence = new Set(gate.evidenceIds);
  const matched = records.filter((record) => evidence.has(record.id));
  const operations = matched.map((record) => operationForRecord(record, transfers)).slice(0, 20);
  const nodeIds = new Set<string>();
  for (const operation of operations) {
    for (const id of nodeIdsForRegion(input, operation.region)) nodeIds.add(id);
  }
  if (nodeIds.size === 0) {
    for (const id of nodeIdsForRegion(input, gate.region)) nodeIds.add(id);
  }
  // Show the actual physical endpoints that carried the evidence operations.
  for (const transfer of transfers) {
    if (!matched.some((record) => transfer.logicalId.startsWith(`${record.id}:`))) continue;
    for (const endpoint of [transfer.from, transfer.to]) {
      if (endpoint.kind === 'node') nodeIds.add(endpoint.nodeId);
    }
  }
  const waitingUs = operations.reduce((sum, operation) => sum + operation.waitingUs, 0);
  const kind = classifyKind(gate, operations, waitingUs);
  const missingTokenIds = missingTokensFor(input.readResults, matched.map((record) => record.id));
  return {
    id: diagnosticId(gate.code, ordinal),
    kind,
    severity: 'error',
    gateCode: gate.code,
    caseId: gate.caseId,
    region: gate.region,
    operation: gate.operation,
    cohort: gate.cohort,
    title: `Failed gate: ${gate.code}`,
    message: gateMessage(gate, kind, operations, missingTokenIds),
    observed: gate.observed,
    limit: gate.limit,
    evidenceIds: [...gate.evidenceIds].slice(0, 40),
    operations,
    locations: {
      nodeIds: [...nodeIds].sort(),
      edgeIds: edgesForNodes(input, [...nodeIds]),
    },
    missingTokenIds,
  };
}

/** Topology issues keep their named node/edge so the editor can focus it. */
export function diagnoseTopologyIssues(input: CartDiagnosticInput): CartDiagnostic[] {
  return input.evaluation.issues.map((issue, index) => ({
    id: diagnosticId('topology', index),
    kind: 'topology' as const,
    severity: 'error' as const,
    gateCode: null,
    caseId: null,
    region: null,
    operation: null,
    cohort: null,
    title: `Graph issue: ${issue.code}`,
    message: issue.message,
    observed: null,
    limit: null,
    evidenceIds: [],
    operations: [],
    locations: {
      nodeIds: issue.nodeId === undefined ? [] : [issue.nodeId],
      edgeIds: issue.edgeId === undefined ? [] : [issue.edgeId],
    },
    missingTokenIds: [],
  }));
}

function caseForGate(evaluation: CartEvaluation, gate: CartGate): CartCaseResult | null {
  return evaluation.cases.find((caseResult) => caseResult.id === gate.caseId) ?? null;
}

/**
 * Builds the diagnostics for the whole evaluation: every failed gate plus
 * declared topology issues. Passing gates produce nothing; there is no
 * diagnostic that can hide a failure or replace a runtime audit.
 */
export function buildCartDiagnostics(input: CartDiagnosticInput): CartDiagnostic[] {
  const diagnostics: CartDiagnostic[] = [];
  for (const caseResult of input.evaluation.cases) {
    const failed = caseResult.gates.filter((gate) => !gate.pass);
    failed.forEach((gate, index) => {
      diagnostics.push({
        ...diagnoseCartGate(gate, input, index),
        caseId: caseForGate(input.evaluation, gate)?.id ?? gate.caseId,
      });
    });
  }
  diagnostics.push(...diagnoseTopologyIssues(input));
  return diagnostics;
}

/**
 * English summary of observed queue pressure and lost exchanges, independent of
 * any gate. Used by the live result panel; never changes a result.
 */
export function summarizeCartTrafficHealth(
  transfers: readonly CartTransfer[],
): { readonly waitingUs: number; readonly cancelled: number; readonly retried: number } {
  let waitingUs = 0;
  let cancelled = 0;
  let retried = 0;
  for (const transfer of transfers) {
    waitingUs += transferWaitingUs(transfer);
    if (transfer.status === 'cancelled') cancelled += 1;
    if (isCartRetryTransfer(transfer)) retried += 1;
  }
  return { waitingUs, cancelled, retried };
}

/** Topology facts the results panel needs to place a diagnostic on the graph. */
export function diagnosticTopologyFacts(graph: CartGraph): ReturnType<typeof analyzeCartTopology> {
  return analyzeCartTopology(graph);
}
