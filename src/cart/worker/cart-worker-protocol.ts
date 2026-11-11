/**
 * Browser worker boundary for the Global Cart level (`cart-worker-v1`, B1).
 *
 * Every message is the frozen tagged envelope
 * `{protocol, runId, generation, type, payload}`. Requests are `start`,
 * `cancel` and `advance`; responses are `progress`, `result` and `error`.
 * The four mutation types share one tagged shape, so a response type sent as a
 * request (or the reverse) is rejected as an unknown combination instead of
 * being dispatched. Payloads are validated strictly and every diagnostic is a
 * bounded English sentence: a malformed message can never crash the worker or
 * another level's run.
 */
import {
  CART_LEVEL_ID,
  CART_MAX_ADVANCE_EVENTS,
  CART_MAX_SEED,
  CART_REQUIRED_CASES,
  CART_RETAINED_TRACE_EVENTS,
  CART_WORKER_PROTOCOL,
  cartProgressSchema,
  cartWorkerMessageSchema,
  type CartCaseId,
  type CartCaseTelemetry,
  type CartEvaluation,
  type CartProgress,
  type CartTrafficBytes,
  type CartTrafficFrame,
} from '../index';

const MAX_MESSAGE_LENGTH = 280;
const MAX_BOUNDED_STRING = 200;
const MAX_TRAFFIC_ITEMS = 1_024;
const MAX_PROGRESS_FRAMES = 128;
/**
 * Frozen bounded-retention ceiling for one case. The public index exports the
 * payload types but not this presentation constant; keep the transport guard
 * aligned with `core/telemetry.ts`.
 */
export const CART_WORKER_MAX_TELEMETRY_FRAMES = 240;

const TRAFFIC_PHASES = new Set<string>(['measured', 'drain']);
const TRAFFIC_CLASSES = [
  'request',
  'reply',
  'replication',
  'repair',
  'retry',
] as const;
const LINK_KINDS = new Set<string>(['client-access', 'nic', 'fabric', 'wan']);
const CASE_IDS = new Set<string>([...CART_REQUIRED_CASES]);

export interface CartWorkerTelemetryRequest {
  readonly cadenceUs?: number;
  readonly maxFrames?: number;
  readonly maxTraceEvents?: number;
}

export interface CartWorkerStartPayload {
  readonly graph: unknown;
  readonly seed?: number;
  readonly maxEventsPerAdvance?: number;
  readonly autoplay?: boolean;
  readonly telemetry?: CartWorkerTelemetryRequest;
}

export interface CartWorkerAdvancePayload {
  readonly maxEvents?: number;
}

export interface CartWorkerProgressPayload {
  readonly progress: CartProgress;
  readonly frames?: readonly CartTrafficFrame[];
  readonly telemetry?: readonly CartCaseTelemetry[];
  readonly droppedFrames?: number;
}

export interface CartWorkerResultPayload {
  readonly evaluation: CartEvaluation;
  readonly telemetry?: readonly CartCaseTelemetry[];
}

export interface CartWorkerErrorPayload {
  readonly message: string;
}

interface EnvelopeBase {
  readonly protocol: typeof CART_WORKER_PROTOCOL;
  readonly runId: string;
  readonly generation: number;
}

export type CartWorkerRequest =
  | (EnvelopeBase & { readonly type: 'start'; readonly payload: CartWorkerStartPayload })
  | (EnvelopeBase & { readonly type: 'cancel'; readonly payload: Record<string, never> })
  | (EnvelopeBase & { readonly type: 'advance'; readonly payload: CartWorkerAdvancePayload });

export type CartWorkerResponse =
  | (EnvelopeBase & { readonly type: 'progress'; readonly payload: CartWorkerProgressPayload })
  | (EnvelopeBase & { readonly type: 'result'; readonly payload: CartWorkerResultPayload })
  | (EnvelopeBase & { readonly type: 'error'; readonly payload: CartWorkerErrorPayload });

export type CartWorkerRequestType = CartWorkerRequest['type'];
export type CartWorkerResponseType = CartWorkerResponse['type'];

export type CartWorkerParse<T> =
  | { readonly ok: true; readonly message: T }
  | {
      readonly ok: false;
      /** Bounded English diagnostic; safe to show in product UI. */
      readonly reason: string;
      readonly runId: string | null;
      readonly generation: number | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max = MAX_BOUNDED_STRING): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function boundedInt(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= max
  );
}

function boundedOptionalNumber(value: unknown, max: number): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= max)
  );
}

function isTrafficBytes(value: unknown): value is CartTrafficBytes {
  if (!isRecord(value)) return false;
  return TRAFFIC_CLASSES.every((trafficClass) => boundedInt(value[trafficClass]));
}

function isNodeTraffic(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    boundedString(value.id, 160) &&
    (value.role === 'node' || value.role === 'client') &&
    (value.region === null || boundedString(value.region, 64)) &&
    boundedInt(value.bytes) &&
    isTrafficBytes(value.byClass)
  );
}

function isLinkTraffic(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    boundedString(value.linkId, 160) &&
    typeof value.kind === 'string' &&
    LINK_KINDS.has(value.kind) &&
    boundedInt(value.bytes)
  );
}

function isCircuitTraffic(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    boundedString(value.pair, 160) &&
    (value.direction === 'forward' || value.direction === 'reverse') &&
    boundedInt(value.bytes)
  );
}

/**
 * Narrow traffic guard. A frame is accepted only when it is a bounded,
 * self-consistent partition of one cadence window. Presentation sampling is
 * allowed, but shape regressions and forged huge payloads are rejected.
 */
export function isCartTrafficFrame(value: unknown): value is CartTrafficFrame {
  if (!isRecord(value)) return false;
  if (value.levelId !== CART_LEVEL_ID) return false;
  if (typeof value.caseId !== 'string' || !CASE_IDS.has(value.caseId)) return false;
  if (!boundedInt(value.index) || !boundedInt(value.windowStartUs)) return false;
  if (!boundedInt(value.windowEndUs) || !boundedInt(value.windowUs)) return false;
  if (value.windowUs < 1) return false;
  if (value.windowStartUs !== value.index * value.windowUs) return false;
  if (value.windowEndUs !== (value.index + 1) * value.windowUs) return false;
  if (typeof value.phase !== 'string' || !TRAFFIC_PHASES.has(value.phase)) return false;
  if (!isTrafficBytes(value.bytes)) return false;
  if (!boundedInt(value.serializedBytes) || !boundedInt(value.wanBillableBytes)) return false;
  if (value.wanBillableBytes > value.serializedBytes) return false;
  if (typeof value.sampled !== 'boolean') return false;
  if (!Array.isArray(value.nodes) || value.nodes.length > MAX_TRAFFIC_ITEMS) return false;
  if (!value.nodes.every(isNodeTraffic)) return false;
  if (!Array.isArray(value.links) || value.links.length > MAX_TRAFFIC_ITEMS) return false;
  if (!value.links.every(isLinkTraffic)) return false;
  if (!Array.isArray(value.circuits) || value.circuits.length > MAX_TRAFFIC_ITEMS) return false;
  return value.circuits.every(isCircuitTraffic);
}

function isCircuitArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_TRAFFIC_ITEMS &&
    value.every(isCircuitTraffic)
  );
}

function isTelemetryTotals(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    boundedInt(value.serializedBytes) &&
    boundedInt(value.wanBillableBytes) &&
    boundedInt(value.localSerializedBytes) &&
    boundedInt(value.byteEvents) &&
    boundedInt(value.transfers) &&
    isTrafficBytes(value.byClass) &&
    isCircuitArray(value.byCircuit)
  );
}

function isCaseTelemetry(value: unknown): value is CartCaseTelemetry {
  if (!isRecord(value)) return false;
  if (value.levelId !== CART_LEVEL_ID) return false;
  if (typeof value.caseId !== 'string' || !CASE_IDS.has(value.caseId)) return false;
  if (typeof value.complete !== 'boolean') return false;
  if (!Array.isArray(value.frames) || value.frames.length > CART_WORKER_MAX_TELEMETRY_FRAMES) {
    return false;
  }
  if (!value.frames.every(isCartTrafficFrame)) return false;
  if (!isTelemetryTotals(value.totals)) return false;
  if (!isRecord(value.trace)) return false;
  if (value.trace.caseId !== value.caseId) return false;
  if (
    typeof value.trace.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.trace.digest)
  ) {
    return false;
  }
  if (!boundedInt(value.trace.totalEvents) || !boundedInt(value.trace.retainedEvents)) {
    return false;
  }
  if (typeof value.trace.truncated !== 'boolean') return false;
  if (!Array.isArray(value.trace.events)) return false;
  if (!boundedInt(value.windowCount) || !boundedInt(value.measuredEndUs)) return false;
  if (!Array.isArray(value.issues) || value.issues.length > 32) return false;
  return value.issues.every((issue) => boundedString(issue, 500));
}

function boundedText(text: string, fallback: string): string {
  const trimmed = text.trim();
  const value = trimmed.length > 0 ? trimmed : fallback;
  return value.length <= MAX_MESSAGE_LENGTH
    ? value
    : `${value.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

/**
 * Extracts the tagged identity for an error reply without trusting the rest of
 * a malformed message. Only a bounded run id and a safe generation survive.
 */
function salvageIdentity(value: unknown): { runId: string | null; generation: number | null } {
  if (!isRecord(value)) return { runId: null, generation: null };
  const runId =
    typeof value.runId === 'string' && value.runId.length > 0 && value.runId.length <= 64
      ? value.runId
      : null;
  const generation =
    typeof value.generation === 'number' &&
    Number.isInteger(value.generation) &&
    value.generation >= 0
      ? value.generation
      : null;
  return { runId, generation };
}

function parseFailure<T>(
  value: unknown,
  reason: string,
): CartWorkerParse<T> {
  const identity = salvageIdentity(value);
  return { ok: false, reason, ...identity };
}

const emptyPayloadSchema: Record<string, never> = {};

function isOptionalPositiveInt(value: unknown, max: number): boolean {
  return value === undefined || (boundedInt(value, max) && value >= 1);
}

function validateStartPayload(payload: unknown): CartWorkerStartPayload | null {
  if (!isRecord(payload) || !isRecord(payload.graph)) return null;
  if (!isOptionalPositiveInt(payload.seed, CART_MAX_SEED)) return null;
  if (!isOptionalPositiveInt(payload.maxEventsPerAdvance, CART_MAX_ADVANCE_EVENTS)) {
    return null;
  }
  if (payload.autoplay !== undefined && typeof payload.autoplay !== 'boolean') return null;
  if (payload.telemetry !== undefined) {
    if (!isRecord(payload.telemetry)) return null;
    const telemetry = payload.telemetry;
    if (!boundedOptionalNumber(telemetry.cadenceUs, 60_000_000)) return null;
    if (!isOptionalPositiveInt(telemetry.maxFrames, CART_WORKER_MAX_TELEMETRY_FRAMES)) return null;
    if (!isOptionalPositiveInt(telemetry.maxTraceEvents, CART_RETAINED_TRACE_EVENTS * 2)) {
      return null;
    }
  }
  return payload as unknown as CartWorkerStartPayload;
}

function validateAdvancePayload(payload: unknown): CartWorkerAdvancePayload | null {
  if (!isRecord(payload)) return null;
  if (!isOptionalPositiveInt(payload.maxEvents, CART_MAX_ADVANCE_EVENTS)) return null;
  return payload as CartWorkerAdvancePayload;
}

function validateProgressPayload(payload: unknown): CartWorkerProgressPayload | null {
  if (!isRecord(payload)) return null;
  const parsedProgress = cartProgressSchema.safeParse(payload.progress);
  if (!parsedProgress.success) return null;
  if (payload.frames !== undefined) {
    if (!Array.isArray(payload.frames) || payload.frames.length > MAX_PROGRESS_FRAMES) {
      return null;
    }
    if (!payload.frames.every(isCartTrafficFrame)) return null;
  }
  if (payload.telemetry !== undefined) {
    if (
      !Array.isArray(payload.telemetry) ||
      payload.telemetry.length > CART_REQUIRED_CASES.length ||
      !payload.telemetry.every(isCaseTelemetry)
    ) {
      return null;
    }
  }
  if (payload.droppedFrames !== undefined && !boundedInt(payload.droppedFrames)) return null;
  return payload as unknown as CartWorkerProgressPayload;
}

function validateResultPayload(payload: unknown): CartWorkerResultPayload | null {
  if (!isRecord(payload) || !isRecord(payload.evaluation)) return null;
  if (payload.telemetry !== undefined) {
    if (
      !Array.isArray(payload.telemetry) ||
      payload.telemetry.length > CART_REQUIRED_CASES.length ||
      !payload.telemetry.every(isCaseTelemetry)
    ) {
      return null;
    }
  }
  return payload as unknown as CartWorkerResultPayload;
}

function validateErrorPayload(payload: unknown): CartWorkerErrorPayload | null {
  if (!isRecord(payload) || typeof payload.message !== 'string') return null;
  return { message: boundedText(payload.message, 'The Global Cart engine failed.') };
}

function parseEnvelope<T extends CartWorkerRequestType | CartWorkerResponseType>(
  value: unknown,
  allowed: readonly T[],
  meaning: 'request' | 'response',
): CartWorkerParse<{
  protocol: typeof CART_WORKER_PROTOCOL;
  runId: string;
  generation: number;
  type: T;
  payload: Record<string, unknown>;
}> {
  const envelope = cartWorkerMessageSchema.safeParse(value);
  if (!envelope.success) {
    return parseFailure(
      value,
      `The Global Cart worker rejected a malformed ${meaning}: it does not match cart-worker-v1.`,
    );
  }
  const message = envelope.data;
  if (!allowed.includes(message.type as T)) {
    return parseFailure(
      value,
      `The Global Cart worker does not accept "${message.type}" as a ${meaning} in cart-worker-v1.`,
    );
  }
  return {
    ok: true,
    message: {
      protocol: message.protocol,
      runId: message.runId,
      generation: message.generation,
      type: message.type as T,
      payload: message.payload,
    },
  };
}

const REQUEST_TYPES = ['start', 'cancel', 'advance'] as const;
const RESPONSE_TYPES = ['progress', 'result', 'error'] as const;

export function parseCartWorkerRequest(value: unknown): CartWorkerParse<CartWorkerRequest> {
  const envelope = parseEnvelope(value, REQUEST_TYPES, 'request');
  if (!envelope.ok) return envelope;
  const { protocol, runId, generation, type, payload } = envelope.message;

  if (type === 'start') {
    const start = validateStartPayload(payload);
    if (start === null) {
      return parseFailure(
        value,
        'The Global Cart worker rejected a start request: graph, seed, advance budget, autoplay or telemetry options are invalid.',
      );
    }
    return { ok: true, message: { protocol, runId, generation, type, payload: start } };
  }

  if (type === 'cancel') {
    const keys = Object.keys(payload);
    if (keys.length !== 0) {
      return parseFailure(
        value,
        'The Global Cart worker rejected a cancel request: the payload must be empty.',
      );
    }
    return {
      ok: true,
      message: { protocol, runId, generation, type, payload: emptyPayloadSchema },
    };
  }

  const advance = validateAdvancePayload(payload);
  if (advance === null) {
    return parseFailure(
      value,
      'The Global Cart worker rejected an advance request: maxEvents must be a bounded positive integer.',
    );
  }
  return { ok: true, message: { protocol, runId, generation, type: 'advance', payload: advance } };
}

export function parseCartWorkerResponse(value: unknown): CartWorkerParse<CartWorkerResponse> {
  const envelope = parseEnvelope(value, RESPONSE_TYPES, 'response');
  if (!envelope.ok) return envelope;
  const { protocol, runId, generation, type, payload } = envelope.message;

  if (type === 'progress') {
    const progress = validateProgressPayload(payload);
    if (progress === null) {
      return parseFailure(
        value,
        'The Global Cart engine returned malformed progress: the progress or traffic payload is invalid.',
      );
    }
    return { ok: true, message: { protocol, runId, generation, type, payload: progress } };
  }

  if (type === 'result') {
    const result = validateResultPayload(payload);
    if (result === null) {
      return parseFailure(
        value,
        'The Global Cart engine returned a malformed result payload. The graph is unchanged.',
      );
    }
    return { ok: true, message: { protocol, runId, generation, type, payload: result } };
  }

  const error = validateErrorPayload(payload);
  if (error === null) {
    return parseFailure(
      value,
      'The Global Cart engine returned a malformed error message. The graph is unchanged.',
    );
  }
  return { ok: true, message: { protocol, runId, generation, type, payload: error } };
}

/** Builds a response envelope so every worker message keeps the frozen shape. */
export function cartWorkerResponse<T extends CartWorkerResponseType>(
  runId: string,
  generation: number,
  type: T,
  payload: T extends 'progress'
    ? CartWorkerProgressPayload
    : T extends 'result'
      ? CartWorkerResultPayload
      : CartWorkerErrorPayload,
): CartWorkerResponse {
  return {
    protocol: CART_WORKER_PROTOCOL,
    runId,
    generation,
    type,
    payload,
  } as CartWorkerResponse;
}

/** Bounded English worker diagnostic used for malformed requests. */
export function cartWorkerParseError(parse: {
  readonly reason: string;
  readonly runId: string | null;
  readonly generation: number | null;
}): CartWorkerResponse {
  return cartWorkerResponse(
    parse.runId ?? 'cart-worker-unknown',
    parse.generation ?? 0,
    'error',
    { message: boundedText(parse.reason, 'The Global Cart worker rejected a malformed message.') },
  );
}

export type { CartCaseId };
