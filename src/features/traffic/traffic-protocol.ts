import type {
  TrafficEdge,
  TrafficFrame,
  TrafficMessage,
  TrafficNode,
  TrafficResource,
} from '../../simulation/traffic-telemetry';

/**
 * Narrow boundary guard for the optional browser telemetry message. The worker
 * protocol modules are owned elsewhere; this file only validates the shared
 * shape before UI state is touched. Any malformed frame is ignored silently:
 * telemetry must never break a run or turn into a fake measurement.
 */

const LEVELS = new Set<string>([
  'cold-cache',
  'parcel-pulse',
  'image-atlas',
  'live-scoreboard',
  'live-audience',
]);
const PHASES = new Set<string>(['warmup', 'measured', 'drain', 'postlude']);
const UNITS = new Set<string>([
  'slots',
  'connections',
  'cores',
  'lanes',
  'bytes',
  'gbit/s',
]);
const AGGREGATIONS = new Set<string>(['window-average', 'instant']);

export const TRAFFIC_MAX_NODES_PER_FRAME = 512;
export const TRAFFIC_MAX_EDGES_PER_FRAME = 2_048;
export const TRAFFIC_MAX_RESOURCES_PER_NODE = 24;
/** Absolute sanity bound for virtual time only. Bytes and RAM are much larger. */
const MAX_TIME_MS = 1_000_000_000;
const MAX_COUNT = Number.MAX_SAFE_INTEGER;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteNumber(
  value: unknown,
  {
    min = Number.MIN_SAFE_INTEGER,
    max = MAX_COUNT,
  }: { min?: number; max?: number } = {},
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

function finiteOrNull(
  value: unknown,
  options?: { min?: number; max?: number },
): value is number | null {
  return value === null || finiteNumber(value, options);
}

function boundedString(value: unknown, maxLength = 160): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function isResource(value: unknown): value is TrafficResource {
  if (!isRecord(value)) {
    return false;
  }
  return (
    boundedString(value.key, 120) &&
    boundedString(value.label, 120) &&
    finiteOrNull(value.used, { min: 0 }) &&
    finiteOrNull(value.capacity, { min: 0 }) &&
    typeof value.unit === 'string' &&
    UNITS.has(value.unit) &&
    (value.aggregation === undefined ||
      (typeof value.aggregation === 'string' && AGGREGATIONS.has(value.aggregation)))
  );
}

function isNode(value: unknown): value is TrafficNode {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !boundedString(value.nodeId, 128) ||
    !Array.isArray(value.resources) ||
    value.resources.length > TRAFFIC_MAX_RESOURCES_PER_NODE ||
    !value.resources.every(isResource) ||
    !finiteOrNull(value.requestsPerSecond, { min: 0 }) ||
    !finiteOrNull(value.queue, { min: 0 }) ||
    typeof value.down !== 'boolean'
  ) {
    return false;
  }
  return true;
}

function isEdge(value: unknown): value is TrafficEdge {
  if (!isRecord(value)) {
    return false;
  }
  return (
    boundedString(value.edgeId, 128) &&
    finiteNumber(value.requestsPerSecond, { min: 0 }) &&
    finiteOrNull(value.bytesPerSecond, { min: 0 })
  );
}

function isFrame(
  value: unknown,
  expectedLevelId: string,
): value is TrafficFrame {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value.levelId !== 'string' ||
    value.levelId !== expectedLevelId ||
    !LEVELS.has(value.levelId) ||
    !boundedString(value.scopeId, 120) ||
    !boundedString(value.scopeLabel, 160) ||
    !finiteNumber(value.timeMs, { min: -MAX_TIME_MS, max: MAX_TIME_MS }) ||
    !finiteNumber(value.windowMs, { min: 0, max: MAX_TIME_MS }) ||
    typeof value.phase !== 'string' ||
    !PHASES.has(value.phase) ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > TRAFFIC_MAX_NODES_PER_FRAME ||
    !Array.isArray(value.edges) ||
    value.edges.length > TRAFFIC_MAX_EDGES_PER_FRAME
  ) {
    return false;
  }
  return value.nodes.every(isNode) && value.edges.every(isEdge);
}

export function parseTrafficMessage(
  value: unknown,
  expectedLevelId: string,
  expectedRunId: string,
): TrafficMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.type !== 'traffic' ||
    value.runId !== expectedRunId ||
    !boundedString(value.runId, 160)
  ) {
    return null;
  }
  if (!isFrame(value.frame, expectedLevelId)) {
    return null;
  }
  return value as unknown as TrafficMessage;
}

/** True only for a complete, finite, in-scope traffic message. */
export function isTrafficMessageFor(
  value: unknown,
  expectedLevelId: string,
  expectedRunId: string,
): value is TrafficMessage {
  return parseTrafficMessage(value, expectedLevelId, expectedRunId) !== null;
}
