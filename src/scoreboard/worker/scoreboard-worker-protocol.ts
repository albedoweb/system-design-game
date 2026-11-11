import type {
  ScoreboardEvaluation,
  ScoreboardGraph,
  ScoreboardProgress,
  ScoreboardTrafficFrame,
} from '../index';

/**
 * Browser worker boundary. Every message carries the main-thread run id; the
 * controller rejects anything for another run or with a malformed shape.
 */

export interface ScoreboardWorkerRunRequest {
  type: 'run';
  runId: string;
  graph: ScoreboardGraph;
  seed: number;
  maxEventsPerAdvance?: number;
}

export interface ScoreboardWorkerCancelRequest {
  type: 'cancel';
  runId: string;
}

export type ScoreboardWorkerRequest =
  | ScoreboardWorkerRunRequest
  | ScoreboardWorkerCancelRequest;

export type ScoreboardWorkerResponse =
  | {
      type: 'progress';
      runId: string;
      progress: ScoreboardProgress;
    }
  | {
      type: 'result';
      runId: string;
      evaluation: ScoreboardEvaluation;
    }
  | {
      type: 'error';
      runId: string;
      message: string;
    }
  | {
      type: 'traffic';
      runId: string;
      frame: ScoreboardTrafficFrame;
    };

const PHASES = new Set<string>(['validate', 'prepare', 'run', 'drain', 'done']);
const MAX_MESSAGE_LENGTH = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function boundedRunId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 160
  );
}

export function isScoreboardWorkerRequest(
  value: unknown,
): value is ScoreboardWorkerRequest {
  if (!isRecord(value) || !boundedRunId(value.runId)) {
    return false;
  }
  if (value.type === 'cancel') {
    return true;
  }
  return (
    value.type === 'run' &&
    isRecord(value.graph) &&
    typeof value.seed === 'number' &&
    Number.isInteger(value.seed) &&
    value.seed >= 0 &&
    (value.maxEventsPerAdvance === undefined ||
      (typeof value.maxEventsPerAdvance === 'number' &&
        Number.isInteger(value.maxEventsPerAdvance) &&
        value.maxEventsPerAdvance > 0))
  );
}

function isProgress(value: unknown): value is ScoreboardProgress {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.phase === 'string' &&
    PHASES.has(value.phase) &&
    typeof value.nowMs === 'number' &&
    Number.isFinite(value.nowMs) &&
    typeof value.measuredElapsedMs === 'number' &&
    Number.isFinite(value.measuredElapsedMs) &&
    typeof value.completedRequests === 'number' &&
    Number.isFinite(value.completedRequests) &&
    typeof value.totalRequests === 'number' &&
    Number.isFinite(value.totalRequests) &&
    typeof value.message === 'string' &&
    value.message.length <= MAX_MESSAGE_LENGTH
  );
}

export function isScoreboardWorkerResponse(
  value: unknown,
): value is ScoreboardWorkerResponse {
  if (!isRecord(value) || !boundedRunId(value.runId)) {
    return false;
  }
  switch (value.type) {
    case 'progress':
      return isProgress(value.progress);
    case 'result':
      return isRecord(value.evaluation);
    case 'error':
      return (
        typeof value.message === 'string' &&
        value.message.trim().length > 0 &&
        value.message.length <= MAX_MESSAGE_LENGTH
      );
    case 'traffic':
      return isRecord(value.frame);
    default:
      return false;
  }
}
