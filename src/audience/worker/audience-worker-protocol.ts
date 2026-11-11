import type {
  AudienceCaseId,
  AudienceEvaluation,
  AudienceGraph,
  AudienceProgress,
  AudienceTrafficFrame,
} from '../index';

/**
 * Browser worker boundary for Live Audience. Every message carries the
 * main-thread run id; the controller rejects anything for another run or with
 * a malformed shape. Frames are validated again by the shared traffic guard.
 */

export interface AudienceWorkerRunRequest {
  type: 'run';
  runId: string;
  graph: AudienceGraph;
  seed: number;
  maxEventsPerAdvance?: number;
}

export interface AudienceWorkerCancelRequest {
  type: 'cancel';
  runId: string;
}

export type AudienceWorkerRequest =
  | AudienceWorkerRunRequest
  | AudienceWorkerCancelRequest;

export type AudienceWorkerResponse =
  | {
      type: 'progress';
      runId: string;
      progress: AudienceProgress;
    }
  | {
      type: 'result';
      runId: string;
      evaluation: AudienceEvaluation;
    }
  | {
      type: 'error';
      runId: string;
      message: string;
    }
  | {
      type: 'traffic';
      runId: string;
      frame: AudienceTrafficFrame;
    };

const PHASES = new Set<string>(['validate', 'prepare', 'run', 'drain', 'done']);
const CASE_IDS = new Set<string>([
  'normal',
  'peak',
  'app-failure-0',
  'app-failure-1',
  'app-failure-2',
  'app-failure-3',
]);
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

export function isAudienceWorkerRequest(
  value: unknown,
): value is AudienceWorkerRequest {
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

function isProgress(value: unknown): value is AudienceProgress {
  if (!isRecord(value)) {
    return false;
  }
  const caseId = value.caseId;
  return (
    typeof value.phase === 'string' &&
    PHASES.has(value.phase) &&
    (caseId === null ||
      (typeof caseId === 'string' && CASE_IDS.has(caseId as AudienceCaseId))) &&
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

export function isAudienceWorkerResponse(
  value: unknown,
): value is AudienceWorkerResponse {
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
