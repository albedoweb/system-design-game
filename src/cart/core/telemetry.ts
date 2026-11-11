/**
 * Bounded live traffic telemetry and deterministic trace regeneration (GC-012).
 *
 * The model already bills every physical stage exactly once in
 * `CartNetworkModel`. This module never re-bills anything: it projects the
 * final per-stage serialization facts of a real `CartCaseModel` run into
 * bounded time windows and a five-way traffic partition
 * (`request`, `reply`, `replication`, `repair`, `retry`).
 *
 * Invariants this module exists to protect:
 * - Every physical byte belongs to exactly one class; class sums equal the
 *   serialized byte total, and WAN-class sums equal the model's billable WAN
 *   counter (`case.resources.wanBillableBytes`).
 * - Frame cadence and frame sampling are presentation-only. Totals, the case
 *   result and the trace digest are computed from the full byte-event list, so
 *   a different UI cadence can never change what was measured or audited.
 * - The capture is a pure function of the frozen inputs `(graph, role, seed,
 *   case)` plus the model's own deterministic schedule, so a bounded detail
 *   view can always be regenerated from those inputs.
 */
import {
  CART_LEVEL_ID,
  CART_TELEMETRY_FRAME_MS,
  CART_RETAINED_TRACE_EVENTS,
  canonicalJson,
  sha256Hex,
  type CartCaseId,
  type CartCaseResult,
  type CartGraph,
} from '../contracts';
import { createCartCaseRun } from './case';
import type { CartWorkloadProfile } from './workload';
import {
  analyzeCartTopology,
  type CartCaseModel,
  type CartRequestRecord,
  type CartTopologyFacts,
} from './model';
import type {
  CartEndpoint,
  CartPhysicalLinkKind,
  CartTransfer,
  CartTransferStatus,
} from './network';
import type { CartReadOutcome } from './reads';

// ---------------------------------------------------------------------------
// Traffic partition
// ---------------------------------------------------------------------------

/**
 * The five traffic classes required by the developer requirements. The
 * partition is applied to physical stage bytes, never to logical messages, so
 * a retried checkout attempt is counted once as `retry` instead of again as a
 * request plus a reply.
 */
export type CartTrafficClass = 'request' | 'reply' | 'replication' | 'repair' | 'retry';

export const CART_TRAFFIC_CLASSES = [
  'request',
  'reply',
  'replication',
  'repair',
  'retry',
] as const satisfies readonly CartTrafficClass[];

export type CartTrafficPhase = 'measured' | 'drain';

export interface CartTrafficBytes {
  readonly request: number;
  readonly reply: number;
  readonly replication: number;
  readonly repair: number;
  readonly retry: number;
}

export function emptyCartTrafficBytes(): CartTrafficBytes {
  return { request: 0, reply: 0, replication: 0, repair: 0, retry: 0 };
}

function addBytes(target: CartTrafficBytes, trafficClass: CartTrafficClass, bytes: number): void {
  // The record is intentionally mutable internally and frozen on export.
  (target as Record<CartTrafficClass, number>)[trafficClass] += bytes;
}

function sumCartTrafficBytes(bytes: CartTrafficBytes): number {
  let total = 0;
  for (const trafficClass of CART_TRAFFIC_CLASSES) total += bytes[trafficClass];
  return total;
}

// ---------------------------------------------------------------------------
// Byte events (the underlying exact accounting)
// ---------------------------------------------------------------------------

/**
 * One physical serialization fact. `atUs` is the instant the bytes were
 * charged: stage completion for a fully serialized stage, or the transfer's
 * cancellation instant for the serialized prefix that is still billed.
 */
export interface CartByteEvent {
  readonly atUs: number;
  readonly phase: CartTrafficPhase;
  readonly trafficClass: CartTrafficClass;
  readonly bytes: number;
  readonly logicalId: string;
  readonly linkId: string;
  readonly linkKind: CartPhysicalLinkKind;
  readonly wanPair: string | null;
  readonly wanDirection: string | null;
  readonly from: CartEndpoint;
  readonly to: CartEndpoint;
  readonly status: CartTransferStatus;
}

const CHECKOUT_RETRY_SUFFIX =
  /:(?:in|lookup|lookup-reply|commit|commit-reply|out|unavailable):(\d+)$/;

/** True when the transfer belongs to a checkout transport retry attempt (>0). */
export function isCartRetryTransfer(transfer: Pick<CartTransfer, 'logicalId'>): boolean {
  const match = CHECKOUT_RETRY_SUFFIX.exec(transfer.logicalId);
  if (match === null) return false;
  return Number(match[1] ?? '0') > 0;
}

interface RepairSelection {
  readonly requests: Set<CartTransfer>;
  readonly replies: Set<CartTransfer>;
}

function endpointNodeId(endpoint: CartEndpoint): string | null {
  return endpoint.kind === 'node' ? endpoint.nodeId : null;
}

/**
 * Read exchanges are billed as `${readId}:r:${stepId}` / `${readId}:s:${stepId}`.
 * The capture is non-greedy so a read id keeps every segment before its first
 * exchange marker.
 */
const READ_TRANSFER_PATTERN = /^(.*?):([rs]):/;

function repairAttemptsOf(outcome: CartReadOutcome): CartReadOutcome['attempts'] {
  return outcome.attempts.filter(
    (attempt) =>
      attempt.reachable && (attempt.phase === 'repair' || attempt.phase === 'refresh'),
  );
}

function claimRepairAttempts(
  requests: Set<CartTransfer>,
  replies: Set<CartTransfer>,
  attempts: CartReadOutcome['attempts'],
  requestTransfers: readonly CartTransfer[],
  replyTransfers: readonly CartTransfer[],
): void {
  for (const attempt of attempts) {
    if (attempt.requestBytes > 0) {
      const request = requestTransfers.find(
        (transfer) =>
          !requests.has(transfer) &&
          endpointNodeId(transfer.to) === attempt.nodeId &&
          transfer.bytes === attempt.requestBytes,
      );
      if (request !== undefined) requests.add(request);
    }
    if (attempt.responseBytes > 0) {
      const reply = replyTransfers.find(
        (transfer) =>
          !replies.has(transfer) &&
          endpointNodeId(transfer.from) === attempt.nodeId &&
          transfer.bytes === attempt.responseBytes,
      );
      if (reply !== undefined) replies.add(reply);
    }
  }
}

/**
 * Marks the read transfers that executed a `repair`/`refresh` exchange.
 *
 * The read engine records one attempt per exchange with its phase, node and
 * exact request/response sizes, but a transfer's logical id only carries the
 * read id plus a sequence number. Attribution therefore matches attempts and
 * transfers by `(readId, nodeId, bytes)` in deterministic attempt order: the
 * first unclaimed transfer of the read that matches an attempt is that
 * attempt's exchange. Unreachable attempts never produced a transfer and are
 * skipped, so the marker can only ever reduce the plain request/reply buckets.
 *
 * Transfers are grouped by read id in one pass, so this is linear in the
 * transfer list instead of the previous `reads × transfers` rescan. The
 * matching order (read-result map order, then transfer order) is unchanged.
 */
export function markCartRepairTransfers(
  readResults: ReadonlyMap<string, CartReadOutcome>,
  transfers: readonly CartTransfer[],
): RepairSelection {
  const requests = new Set<CartTransfer>();
  const replies = new Set<CartTransfer>();
  const repairReads = new Set<string>();
  for (const [readId, outcome] of readResults) {
    if (repairAttemptsOf(outcome).length > 0) repairReads.add(readId);
  }
  if (repairReads.size === 0) return { requests, replies };

  const grouped = new Map<string, { requests: CartTransfer[]; replies: CartTransfer[] }>();
  for (const transfer of transfers) {
    const match = READ_TRANSFER_PATTERN.exec(transfer.logicalId);
    if (match === null) continue;
    const readId = match[1] as string;
    if (!repairReads.has(readId)) continue;
    const kind = match[2];
    let group = grouped.get(readId);
    if (group === undefined) {
      group = { requests: [], replies: [] };
      grouped.set(readId, group);
    }
    if (kind === 'r') group.requests.push(transfer);
    else group.replies.push(transfer);
  }

  for (const [readId, outcome] of readResults) {
    if (!repairReads.has(readId)) continue;
    const group = grouped.get(readId);
    if (group === undefined) continue;
    claimRepairAttempts(
      requests,
      replies,
      repairAttemptsOf(outcome),
      group.requests,
      group.replies,
    );
  }
  return { requests, replies };
}

function classifyTransfer(
  transfer: CartTransfer,
  repair: RepairSelection,
): CartTrafficClass {
  if (transfer.purpose === 'replication') return 'replication';
  if (isCartRetryTransfer(transfer)) return 'retry';
  if (repair.requests.has(transfer)) return 'repair';
  if (repair.replies.has(transfer)) return 'repair';
  if (transfer.purpose === 'reply') return 'reply';
  // `other` purpose is not currently produced by the cart model; treat it as a
  // request-side exchange rather than dropping billed bytes from the partition.
  return 'request';
}

/**
 * Converts finished transfers into exact byte events. Each stage contributes
 * its `serializedBytes` once, at the instant those bytes were charged.
 */
export function buildCartByteEvents(input: {
  readonly transfers: readonly CartTransfer[];
  readonly readResults: ReadonlyMap<string, CartReadOutcome>;
  readonly measuredEndUs: number;
}): CartByteEvent[] {
  const repair = markCartRepairTransfers(input.readResults, input.transfers);
  const events: CartByteEvent[] = [];
  for (const transfer of input.transfers) {
    const trafficClass = classifyTransfer(transfer, repair);
    for (const stage of transfer.stages) {
      if (stage.serializedBytes <= 0) continue;
      const atUs =
        stage.state === 'done' && stage.completedUs !== null
          ? stage.completedUs
          : (transfer.cancelledAtUs ?? stage.startedUs ?? transfer.enqueuedAtUs);
      events.push({
        atUs,
        phase: atUs > input.measuredEndUs ? 'drain' : 'measured',
        trafficClass,
        bytes: stage.serializedBytes,
        logicalId: transfer.logicalId,
        linkId: stage.link.id,
        linkKind: stage.link.kind,
        wanPair: stage.link.pair ?? null,
        wanDirection: stage.link.kind === 'wan' ? stage.link.direction : null,
        from: transfer.from,
        to: transfer.to,
        status: transfer.status,
      });
    }
  }
  events.sort((left, right) => {
    if (left.atUs !== right.atUs) return left.atUs - right.atUs;
    if (left.logicalId !== right.logicalId) return left.logicalId < right.logicalId ? -1 : 1;
    if (left.linkId !== right.linkId) return left.linkId < right.linkId ? -1 : 1;
    return 0;
  });
  return events;
}

// ---------------------------------------------------------------------------
// Bounded frames
// ---------------------------------------------------------------------------

export interface CartNodeTraffic {
  readonly id: string;
  readonly role: 'node' | 'client';
  readonly region: string | null;
  readonly bytes: number;
  readonly byClass: CartTrafficBytes;
}

export interface CartLinkTraffic {
  readonly linkId: string;
  readonly kind: CartPhysicalLinkKind;
  readonly bytes: number;
}

export interface CartCircuitTraffic {
  /** Canonical unordered region pair, for example `us-west|eu-central`. */
  readonly pair: string;
  readonly direction: 'forward' | 'reverse';
  readonly bytes: number;
}

export interface CartTrafficFrame {
  readonly levelId: typeof CART_LEVEL_ID;
  readonly caseId: CartCaseId;
  readonly index: number;
  /** Window start, inclusive. */
  readonly windowStartUs: number;
  /** Window end, exclusive. */
  readonly windowEndUs: number;
  readonly windowUs: number;
  readonly phase: CartTrafficPhase;
  readonly bytes: CartTrafficBytes;
  readonly serializedBytes: number;
  readonly wanBillableBytes: number;
  readonly nodes: readonly CartNodeTraffic[];
  readonly links: readonly CartLinkTraffic[];
  readonly circuits: readonly CartCircuitTraffic[];
  /** True when the window was kept by bounded retention, not by cadence alone. */
  readonly sampled: boolean;
}

export interface CartTelemetryTotals {
  readonly serializedBytes: number;
  readonly wanBillableBytes: number;
  readonly localSerializedBytes: number;
  readonly byClass: CartTrafficBytes;
  readonly byCircuit: readonly CartCircuitTraffic[];
  readonly byteEvents: number;
  readonly transfers: number;
}

export interface CartTelemetryFrames {
  readonly frames: readonly CartTrafficFrame[];
  readonly totals: CartTelemetryTotals;
  readonly firstAtUs: number;
  readonly lastAtUs: number;
  /** Windows produced by the requested cadence before bounded retention. */
  readonly windowCount: number;
}

export const CART_TELEMETRY_MAX_FRAMES = 240;

function frameKey(index: number): number {
  return index;
}

/**
 * Partitions byte events into fixed cadence windows. Empty windows are kept so
 * a live UI can show an idle interval without inventing traffic, but every
 * total is derived from the event list, not from frame contents.
 */
export function buildCartTrafficFrames(input: {
  readonly caseId: CartCaseId;
  readonly events: readonly CartByteEvent[];
  readonly cadenceUs?: number;
  readonly maxFrames?: number;
  readonly sampled?: boolean;
}): CartTelemetryFrames {
  const cadence = Math.max(1, Math.floor(input.cadenceUs ?? CART_TELEMETRY_FRAME_MS * 1_000));
  const firstAtUs = input.events[0]?.atUs ?? 0;
  const lastAtUs = input.events[input.events.length - 1]?.atUs ?? 0;
  const windowCount = input.events.length === 0 ? 0 : Math.floor(lastAtUs / cadence) + 1;

  const totals = emptyCartTrafficBytes();
  let serializedBytes = 0;
  let wanBillableBytes = 0;
  const circuits = new Map<string, CartCircuitTraffic>();

  for (const event of input.events) {
    addBytes(totals, event.trafficClass, event.bytes);
    serializedBytes += event.bytes;
    if (event.linkKind === 'wan' && event.wanPair !== null && event.wanDirection !== null) {
      wanBillableBytes += event.bytes;
      const key = `${event.wanPair}|${event.wanDirection}`;
      const existing = circuits.get(key);
      circuits.set(key, {
        pair: event.wanPair,
        direction: event.wanDirection === 'reverse' ? 'reverse' : 'forward',
        bytes: (existing?.bytes ?? 0) + event.bytes,
      });
    }
  }

  const buckets = new Map<number, CartByteEvent[]>();
  for (const event of input.events) {
    const index = Math.floor(event.atUs / cadence);
    const bucket = buckets.get(index);
    if (bucket === undefined) buckets.set(index, [event]);
    else bucket.push(event);
  }

  const built: CartTrafficFrame[] = [];
  for (let index = 0; index < windowCount; index += 1) {
    const events = buckets.get(index) ?? [];
    built.push(frameForWindow(input.caseId, index, cadence, events, false));
  }

  const limit = Math.max(1, Math.floor(input.maxFrames ?? CART_TELEMETRY_MAX_FRAMES));
  const retained = retainFrames(built, limit);
  const frames = input.sampled === false ? built : retained;

  return {
    frames,
    totals: Object.freeze({
      serializedBytes,
      wanBillableBytes,
      localSerializedBytes: serializedBytes - wanBillableBytes,
      byClass: Object.freeze({ ...totals }),
      byCircuit: [...circuits.values()].sort((left, right) => {
        const leftKey = `${left.pair}|${left.direction}`;
        const rightKey = `${right.pair}|${right.direction}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
      byteEvents: input.events.length,
      transfers: new Set(input.events.map((event) => event.logicalId)).size,
    }),
    firstAtUs,
    lastAtUs,
    windowCount,
  };
}

/**
 * Deterministic bounded retention: always keeps the first and last window and
 * an even stride of the rest. A one-frame bound cannot hold two endpoints, so
 * the LAST window is the single representative: it is the most recent state a
 * live view shows, it is deterministic, and it is marked `sampled` because
 * earlier windows were hidden. Sampling can only hide detail, never change a
 * total, and the same input always keeps the same windows.
 */
function retainFrames(frames: readonly CartTrafficFrame[], limit: number): CartTrafficFrame[] {
  if (frames.length <= limit) return frames.map((frame) => ({ ...frame, sampled: false }));
  if (limit === 1) {
    const last = frames[frames.length - 1];
    return last === undefined ? [] : [{ ...last, sampled: true }];
  }
  const kept: CartTrafficFrame[] = [];
  const stride = (frames.length - 1) / (limit - 1);
  let lastIndex = -1;
  for (let slot = 0; slot < limit; slot += 1) {
    const index = Math.min(frames.length - 1, Math.round(slot * stride));
    if (index === lastIndex) continue;
    lastIndex = index;
    const frame = frames[index];
    if (frame !== undefined) kept.push({ ...frame, sampled: true });
  }
  return kept;
}

function frameForWindow(
  caseId: CartCaseId,
  index: number,
  cadence: number,
  events: readonly CartByteEvent[],
  sampled: boolean,
): CartTrafficFrame {
  const bytes = emptyCartTrafficBytes();
  const nodes = new Map<string, { id: string; role: 'node' | 'client'; region: string | null; bytes: number; byClass: CartTrafficBytes }>();
  const links = new Map<string, CartLinkTraffic>();
  const circuits = new Map<string, CartCircuitTraffic>();
  let wanBillableBytes = 0;
  let phase: CartTrafficPhase = 'measured';

  for (const event of events) {
    addBytes(bytes, event.trafficClass, event.bytes);
    if (event.phase === 'drain') phase = 'drain';
    for (const endpoint of [event.from, event.to]) {
      const id = endpoint.kind === 'node' ? endpoint.nodeId : `client:${endpoint.region}:${endpoint.clientId}`;
      const region = endpoint.kind === 'client' ? endpoint.region : null;
      const existing = nodes.get(id) ?? {
        id,
        role: endpoint.kind === 'client' ? 'client' : 'node',
        region,
        bytes: 0,
        byClass: emptyCartTrafficBytes(),
      };
      existing.bytes += event.bytes;
      addBytes(existing.byClass, event.trafficClass, event.bytes);
      nodes.set(id, existing);
    }
    const link = links.get(event.linkId);
    links.set(event.linkId, {
      linkId: event.linkId,
      kind: event.linkKind,
      bytes: (link?.bytes ?? 0) + event.bytes,
    });
    if (event.linkKind === 'wan' && event.wanPair !== null && event.wanDirection !== null) {
      wanBillableBytes += event.bytes;
      const key = `${event.wanPair}|${event.wanDirection}`;
      const existing = circuits.get(key);
      circuits.set(key, {
        pair: event.wanPair,
        direction: event.wanDirection === 'reverse' ? 'reverse' : 'forward',
        bytes: (existing?.bytes ?? 0) + event.bytes,
      });
    }
  }

  return {
    levelId: CART_LEVEL_ID,
    caseId,
    index: frameKey(index),
    windowStartUs: index * cadence,
    windowEndUs: (index + 1) * cadence,
    windowUs: cadence,
    phase,
    bytes: Object.freeze({ ...bytes }),
    serializedBytes: sumCartTrafficBytes(bytes),
    wanBillableBytes,
    nodes: [...nodes.values()]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((node) => ({ ...node, byClass: Object.freeze({ ...node.byClass }) })),
    links: [...links.values()].sort((left, right) =>
      left.linkId < right.linkId ? -1 : left.linkId > right.linkId ? 1 : 0,
    ),
    circuits: [...circuits.values()].sort((left, right) => {
      const leftKey = `${left.pair}|${left.direction}`;
      const rightKey = `${right.pair}|${right.direction}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
    sampled,
  };
}

// ---------------------------------------------------------------------------
// Deterministic representative trace
// ---------------------------------------------------------------------------

export interface CartTraceEvent {
  readonly atUs: number;
  readonly phase: CartTrafficPhase;
  readonly trafficClass: CartTrafficClass;
  readonly logicalId: string;
  readonly linkId: string;
  readonly linkKind: CartPhysicalLinkKind;
  readonly bytes: number;
  readonly status: CartTransferStatus;
}

export interface CartTraceDetail {
  readonly caseId: CartCaseId;
  readonly events: readonly CartTraceEvent[];
  /** Full event count before bounded retention. */
  readonly totalEvents: number;
  readonly retainedEvents: number;
  readonly truncated: boolean;
  /** SHA-256 over the full event fingerprint; independent of retention. */
  readonly digest: string;
}

/**
 * Keeps every failed/retried exchange and an even sample of the rest, so the
 * retained detail contains the counterexamples a failure explanation needs.
 * The digest always covers the complete event list.
 */
export function buildCartTraceDetail(input: {
  readonly caseId: CartCaseId;
  readonly events: readonly CartByteEvent[];
  readonly maxEvents?: number;
}): CartTraceDetail {
  const traceEvents: CartTraceEvent[] = input.events.map((event) => ({
    atUs: event.atUs,
    phase: event.phase,
    trafficClass: event.trafficClass,
    logicalId: event.logicalId,
    linkId: event.linkId,
    linkKind: event.linkKind,
    bytes: event.bytes,
    status: event.status,
  }));
  const digest = sha256Hex(
    canonicalJson({
      caseId: input.caseId,
      events: traceEvents.map((event) => [
        event.atUs,
        event.phase,
        event.trafficClass,
        event.logicalId,
        event.linkId,
        event.linkKind,
        event.bytes,
        event.status,
      ]),
    }),
  );
  const limit = Math.max(1, Math.floor(input.maxEvents ?? CART_RETAINED_TRACE_EVENTS));
  if (traceEvents.length <= limit) {
    return {
      caseId: input.caseId,
      events: traceEvents,
      totalEvents: traceEvents.length,
      retainedEvents: traceEvents.length,
      truncated: false,
      digest,
    };
  }
  const priority = traceEvents.filter(
    (event) => event.status !== 'delivered' || event.trafficClass === 'retry' || event.trafficClass === 'repair',
  );
  const rest = traceEvents.filter((event) => !priority.includes(event));
  const remaining = Math.max(0, limit - Math.min(priority.length, limit));
  const kept = new Set<CartTraceEvent>(priority.slice(0, limit));
  if (remaining > 0 && rest.length > 0) {
    const stride = rest.length / remaining;
    for (let slot = 0; slot < remaining; slot += 1) {
      const event = rest[Math.min(rest.length - 1, Math.round(slot * stride))];
      if (event !== undefined) kept.add(event);
    }
  }
  const retained = traceEvents.filter((event) => kept.has(event));
  return {
    caseId: input.caseId,
    events: retained,
    totalEvents: traceEvents.length,
    retainedEvents: retained.length,
    truncated: true,
    digest,
  };
}

// ---------------------------------------------------------------------------
// Capture: one real deterministic case run observed end to end
// ---------------------------------------------------------------------------

export interface CartTelemetryOptions {
  readonly graph: CartGraph;
  readonly caseId: CartCaseId;
  readonly seed: number;
  readonly cadenceUs?: number;
  readonly maxFrames?: number;
  readonly maxTraceEvents?: number;
  /** Testing hook forwarded to the model; never used by product callers. */
  readonly measuredUs?: number;
  /** Explicit workload profile; defaults to the adopted desync profile. */
  readonly workloadProfile?: CartWorkloadProfile;
  readonly drainUs?: number;
  /** Live frame callback. Cadence must never affect the captured result. */
  readonly onFrame?: (frame: CartTrafficFrame) => void;
}

export interface CartTelemetryCapture {
  readonly caseId: CartCaseId;
  readonly result: CartCaseResult;
  readonly records: readonly CartRequestRecord[];
  readonly transfers: readonly CartTransfer[];
  readonly readResults: ReadonlyMap<string, CartReadOutcome>;
  readonly facts: CartTopologyFacts;
  readonly frames: readonly CartTrafficFrame[];
  readonly totals: CartTelemetryTotals;
  readonly trace: CartTraceDetail;
  readonly windowCount: number;
  /** Reconciles telemetry totals against the case's own resource counters. */
  readonly issues: readonly string[];
}

/** Telemetry projected from one already-executed model, without a case audit. */
export interface CartModelTelemetry {
  readonly caseId: CartCaseId;
  readonly records: readonly CartRequestRecord[];
  readonly transfers: readonly CartTransfer[];
  readonly readResults: ReadonlyMap<string, CartReadOutcome>;
  readonly frames: readonly CartTrafficFrame[];
  readonly totals: CartTelemetryTotals;
  readonly trace: CartTraceDetail;
  readonly windowCount: number;
  readonly measuredEndUs: number;
}

/** Cadence/retention knobs plus the optional bounded live frame sink. */
export interface CartTelemetryObserver {
  readonly cadenceUs?: number;
  readonly maxFrames?: number;
  readonly maxTraceEvents?: number;
  /**
   * Receives one bounded frame whenever a cadence window can no longer receive
   * bytes. Frames are detached copies: callbacks can never mutate model state.
   */
  readonly onFrame?: (frame: CartTrafficFrame) => void;
  /**
   * Receives exactly one bounded per-case payload at completion or cancellation
   * (never for structurally invalid input). This is the transport-shaped unit
   * the worker layer forwards; it is emitted after the final frame flush.
   */
  readonly onCaseTelemetry?: (telemetry: CartCaseTelemetry) => void;
}

/**
 * One bounded per-case telemetry payload. This is the shape a worker transport
 * or results panel forwards: bounded frames, aggregated totals, bounded detail
 * and the retention-independent digest, never the unbounded event list.
 */
export interface CartCaseTelemetry {
  readonly levelId: typeof CART_LEVEL_ID;
  readonly caseId: CartCaseId;
  /** True when the case ran to the end of its modeled window. */
  readonly complete: boolean;
  readonly frames: readonly CartTrafficFrame[];
  readonly totals: CartTelemetryTotals;
  readonly trace: CartTraceDetail;
  readonly windowCount: number;
  readonly measuredEndUs: number;
  /** Reconciliation against the case's own resource counters; empty otherwise. */
  readonly issues: readonly string[];
}

/**
 * Incremental projection over a live model, deliberately separated from
 * execution: `collect()` only inspects the model and never steps it, so the
 * session stays the sole driver and its event budget is never exceeded here.
 */
export interface CartTelemetryObservation {
  readonly caseId: CartCaseId;
  readonly finished: boolean;
  /** Projects every physical stage that is final now. Call after each slice. */
  collect(): void;
  /** Flushes remaining frames and returns the bounded payload. Idempotent. */
  finish(result?: CartCaseResult): CartCaseTelemetry;
}

/**
 * Creates the incremental observation for one live model.
 *
 * Only final stages (`done` or `cancelled`) are booked, each exactly once, so a
 * partially serialized stage is never counted early or twice. Repair/retry
 * attribution is derived incrementally per read id instead of rescanning all
 * reads for every transfer, and transfer/stage scanning resumes from the last
 * slice instead of walking the whole history on every event.
 */
export function createCartTelemetryObservation(
  options: { readonly caseId: CartCaseId; readonly model: CartCaseModel } & CartTelemetryObserver,
): CartTelemetryObservation {
  const model = options.model;
  const cadence = Math.max(1, Math.floor(options.cadenceUs ?? CART_TELEMETRY_FRAME_MS * 1_000));
  const onFrame = options.onFrame;
  const live = onFrame !== undefined;

  const seenStages = new Set<string>();
  const openTransfers = new Set<CartTransfer>();
  const buckets = live ? new Map<number, CartByteEvent[]>() : null;
  const readGroups = new Map<string, { requests: CartTransfer[]; replies: CartTransfer[] }>();
  const seenReadIds = new Set<string>();
  const repair: { requests: Set<CartTransfer>; replies: Set<CartTransfer> } = {
    requests: new Set(),
    replies: new Set(),
  };
  let transferCursor = 0;
  let readCount = 0;
  let latestAtUs = -1;
  let lastEmittedWindow = -1;
  let finished = false;
  let snapshot: CartCaseTelemetry | null = null;

  const emitReady = (flush: boolean): void => {
    if (!live || buckets === null) return;
    for (const window of [...buckets.keys()].sort((left, right) => left - right)) {
      if (!flush && (window + 1) * cadence > latestAtUs) break;
      if (window <= lastEmittedWindow) {
        buckets.delete(window);
        continue;
      }
      lastEmittedWindow = window;
      onFrame(Object.freeze(frameForWindow(options.caseId, window, cadence, buckets.get(window) ?? [], false)));
      buckets.delete(window);
    }
  };

  /** Groups a read exchange so repair attribution never rescans the history. */
  const indexTransfer = (transfer: CartTransfer): void => {
    const match = READ_TRANSFER_PATTERN.exec(transfer.logicalId);
    if (match === null) return;
    const readId = match[1] as string;
    let group = readGroups.get(readId);
    if (group === undefined) {
      group = { requests: [], replies: [] };
      readGroups.set(readId, group);
    }
    if (match[2] === 'r') group.requests.push(transfer);
    else group.replies.push(transfer);
  };

  /** Claims repair exchanges for reads that became complete since last collect. */
  const updateRepairMarks = (): void => {
    const readResults = model.readResults;
    if (readResults.size === readCount) return;
    readCount = readResults.size;
    for (const [readId, outcome] of readResults) {
      if (seenReadIds.has(readId)) continue;
      seenReadIds.add(readId);
      const attempts = repairAttemptsOf(outcome);
      if (attempts.length === 0) continue;
      const group = readGroups.get(readId);
      if (group === undefined) continue;
      claimRepairAttempts(repair.requests, repair.replies, attempts, group.requests, group.replies);
    }
  };

  const collect = (): void => {
    if (!live || finished) return;
    const transfers = model.transferSnapshots;
    const inspect: CartTransfer[] = [];
    // Only transfers appended since the previous slice are new; already-open
    // transfers are re-checked because their stages may finish in any order.
    while (transferCursor < transfers.length) {
      const transfer = transfers[transferCursor] as CartTransfer;
      transferCursor += 1;
      indexTransfer(transfer);
      inspect.push(transfer);
    }
    for (const transfer of openTransfers) inspect.push(transfer);
    updateRepairMarks();

    for (const transfer of inspect) {
      const trafficClass = classifyTransfer(transfer, repair);
      let pending = false;
      for (const [stageIndex, stage] of transfer.stages.entries()) {
        if (stage.serializedBytes > 0 && stage.state !== 'done' && stage.state !== 'cancelled') {
          pending = true;
          continue;
        }
        if (stage.serializedBytes <= 0) continue;
        const key = `${transfer.id}:${stageIndex}`;
        if (seenStages.has(key)) continue;
        seenStages.add(key);
        const atUs =
          stage.state === 'done' && stage.completedUs !== null
            ? stage.completedUs
            : (transfer.cancelledAtUs ?? stage.startedUs ?? transfer.enqueuedAtUs);
        const event: CartByteEvent = {
          atUs,
          phase: atUs > model.measuredEndUs ? 'drain' : 'measured',
          trafficClass,
          bytes: stage.serializedBytes,
          logicalId: transfer.logicalId,
          linkId: stage.link.id,
          linkKind: stage.link.kind,
          wanPair: stage.link.pair ?? null,
          wanDirection: stage.link.kind === 'wan' ? stage.link.direction : null,
          from: transfer.from,
          to: transfer.to,
          status: transfer.status,
        };
        latestAtUs = Math.max(latestAtUs, atUs);
        if (buckets !== null) {
          const window = Math.floor(atUs / cadence);
          const bucket = buckets.get(window);
          if (bucket === undefined) buckets.set(window, [event]);
          else bucket.push(event);
        }
      }
      if (pending) openTransfers.add(transfer);
      else openTransfers.delete(transfer);
    }
    emitReady(false);
  };

  const finish = (result?: CartCaseResult): CartCaseTelemetry => {
    if (snapshot !== null) return snapshot;
    finished = true;
    emitReady(true);
    // The bounded payload is recomputed from the complete physical snapshot,
    // independently of live cadence and incremental booking, so frame cadence
    // and sampling can never change totals or the digest.
    const byteEvents = buildCartByteEvents({
      transfers: model.transferSnapshots,
      readResults: model.readResults,
      measuredEndUs: model.measuredEndUs,
    });
    const telemetry = buildCartTrafficFrames({
      caseId: options.caseId,
      events: byteEvents,
      cadenceUs: cadence,
      ...(options.maxFrames === undefined ? {} : { maxFrames: options.maxFrames }),
      sampled: true,
    });
    const trace = buildCartTraceDetail({
      caseId: options.caseId,
      events: byteEvents,
      ...(options.maxTraceEvents === undefined ? {} : { maxEvents: options.maxTraceEvents }),
    });
    const issues = result === undefined ? [] : reconcileCartTelemetry(telemetry.totals, result);
    snapshot = Object.freeze({
      levelId: CART_LEVEL_ID,
      caseId: options.caseId,
      complete: result !== undefined,
      frames: telemetry.frames,
      totals: telemetry.totals,
      trace,
      windowCount: telemetry.windowCount,
      measuredEndUs: model.measuredEndUs,
      issues: [...issues],
    });
    return snapshot;
  };

  return {
    caseId: options.caseId,
    get finished(): boolean {
      return finished;
    },
    collect,
    finish,
  };
}

/**
 * Runs one already-constructed model to completion and returns its projection.
 * This is the bounded-slice seam tests and adapters use; `captureCartTelemetry`
 * wraps the same observation with the complete case audit.
 */
export function observeCartModelTelemetry(options: {
  readonly caseId: CartCaseId;
  readonly model: CartCaseModel;
  readonly cadenceUs?: number;
  readonly maxFrames?: number;
  readonly maxTraceEvents?: number;
  readonly onFrame?: (frame: CartTrafficFrame) => void;
}): CartModelTelemetry {
  const observation = createCartTelemetryObservation(options);
  observation.collect();
  while (!options.model.step(5_000)) {
    observation.collect();
  }
  observation.collect();
  const finished = observation.finish();
  return {
    caseId: options.caseId,
    records: options.model.requestRecords,
    transfers: options.model.transferSnapshots,
    readResults: options.model.readResults,
    frames: finished.frames,
    totals: finished.totals,
    trace: finished.trace,
    windowCount: finished.windowCount,
    measuredEndUs: options.model.measuredEndUs,
  };
}

/** Reconciles the telemetry partition with the model's audited counters. */
export function reconcileCartTelemetry(
  totals: CartTelemetryTotals,
  result: CartCaseResult,
): string[] {
  const issues: string[] = [];
  const classSum = sumCartTrafficBytes(totals.byClass);
  if (classSum !== totals.serializedBytes) {
    issues.push(`class-partition-mismatch:${classSum}/${totals.serializedBytes}`);
  }
  if (totals.localSerializedBytes + totals.wanBillableBytes !== totals.serializedBytes) {
    issues.push(
      `stage-partition-mismatch:${totals.localSerializedBytes + totals.wanBillableBytes}/${totals.serializedBytes}`,
    );
  }
  const circuitSum = totals.byCircuit.reduce((sum, circuit) => sum + circuit.bytes, 0);
  if (circuitSum !== totals.wanBillableBytes) {
    issues.push(`circuit-accounting-mismatch:${circuitSum}/${totals.wanBillableBytes}`);
  }
  const resourceWan = result.resources.wanBillableBytes ?? 0;
  if (totals.wanBillableBytes !== resourceWan) {
    issues.push(`wan-counter-mismatch:${totals.wanBillableBytes}/${resourceWan}`);
  }
  return issues;
}

/**
 * Runs one frozen case with the real deterministic model and projects the
 * resulting physical accounting into frames, totals and a bounded trace.
 * Live frames are emitted as the run advances; changing how often they are
 * emitted cannot alter the captured result, totals or digest.
 */
export function captureCartTelemetry(options: CartTelemetryOptions): CartTelemetryCapture {
  const facts = analyzeCartTopology(options.graph);
  const run = createCartCaseRun({
    graph: options.graph,
    caseId: options.caseId,
    seed: options.seed,
    facts,
    ...(options.measuredUs === undefined ? {} : { measuredUs: options.measuredUs }),
    ...(options.workloadProfile === undefined ? {} : { workloadProfile: options.workloadProfile }),
    ...(options.drainUs === undefined ? {} : { drainUs: options.drainUs }),
  });

  const observation = createCartTelemetryObservation({
    caseId: options.caseId,
    model: run.model,
    ...(options.cadenceUs === undefined ? {} : { cadenceUs: options.cadenceUs }),
    ...(options.maxFrames === undefined ? {} : { maxFrames: options.maxFrames }),
    ...(options.maxTraceEvents === undefined ? {} : { maxTraceEvents: options.maxTraceEvents }),
    ...(options.onFrame === undefined ? {} : { onFrame: options.onFrame }),
  });
  observation.collect();
  while (!run.model.step(5_000)) {
    observation.collect();
  }
  observation.collect();

  const completed = run.complete();
  const finished = observation.finish(completed.result);

  return {
    caseId: options.caseId,
    result: completed.result,
    records: completed.model.requestRecords,
    transfers: completed.model.transferSnapshots,
    readResults: completed.model.readResults,
    facts,
    frames: finished.frames,
    totals: finished.totals,
    trace: finished.trace,
    windowCount: finished.windowCount,
    issues: [...finished.issues],
  };
}

/**
 * Deterministic trace regeneration from the frozen inputs. Two calls with the
 * same inputs (and any cadence) must return the same case result and digest;
 * this is the API the results panel and a later replay button use instead of
 * retaining unbounded traces in every snapshot.
 */
export function regenerateCartTrace(options: {
  readonly graph: CartGraph;
  readonly caseId: CartCaseId;
  readonly seed: number;
  readonly cadenceUs?: number;
  readonly maxEvents?: number;
}): CartTraceDetail {
  return captureCartTelemetry({
    ...options,
    maxTraceEvents: options.maxEvents,
  }).trace;
}
