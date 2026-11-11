/**
 * Message protocol between the adapter (main thread) and a simulation worker.
 *
 * The worker is trusted product code, but the adapter still validates every
 * message so a crashed or miscompiled worker cannot resolve a job with an
 * unknown payload. No message carries a stack trace, file path or raw error.
 */

import {
  isEngineEvaluationResult,
  type EngineResultBinding,
} from './result-validation.js';

export interface WorkerRequest {
  readonly levelId: string;
  readonly graph: unknown;
  readonly seed: number;
}

export interface WorkerRunStats {
  readonly elapsedMs: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapTotalBytes: number;
  readonly heapSizeLimitBytes: number;
  readonly externalBytes: number;
}

export interface WorkerProgress {
  readonly phase:
    | 'validate'
    | 'prepare'
    | 'capacity'
    | 'workload'
    | 'run'
    | 'simulate'
    | 'drain'
    | 'done';
  /** Parcel horizon; null for Cold Cache and Image Atlas. */
  readonly horizonYears: 1 | 5 | null;
  /** Image scenario; null for the other levels. */
  readonly scenario: string | null;
  readonly completed: number;
  readonly total: number;
  readonly message: string;
}

export interface WorkerProgressMessage {
  readonly type: 'progress';
  readonly progress: WorkerProgress;
}

export interface WorkerResultMessage {
  readonly type: 'result';
  readonly result: unknown;
  readonly stats: WorkerRunStats;
}

export interface WorkerErrorMessage {
  readonly type: 'error';
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export type WorkerMessage =
  | WorkerProgressMessage
  | WorkerResultMessage
  | WorkerErrorMessage;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PROGRESS_PHASES = new Set([
  'validate',
  'prepare',
  'capacity',
  'workload',
  'run',
  'simulate',
  'drain',
  'done',
]);

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_MESSAGE_LENGTH = 500;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isProgress(value: unknown): value is WorkerProgress {
  if (!isRecord(value)) {
    return false;
  }
  const phase = value.phase;
  const horizonYears = value.horizonYears;
  const scenario = value.scenario;
  return (
    typeof phase === 'string' &&
    PROGRESS_PHASES.has(phase) &&
    (horizonYears === null || horizonYears === 1 || horizonYears === 5) &&
    (scenario === null ||
      (typeof scenario === 'string' && scenario.length > 0 && scenario.length <= 64)) &&
    isFiniteNumber(value.completed) &&
    isFiniteNumber(value.total) &&
    typeof value.message === 'string'
  );
}

function isStats(value: unknown): value is WorkerRunStats {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.elapsedMs) &&
    isFiniteNumber(value.rssBytes) &&
    isFiniteNumber(value.heapUsedBytes) &&
    isFiniteNumber(value.heapTotalBytes) &&
    isFiniteNumber(value.heapSizeLimitBytes) &&
    isFiniteNumber(value.externalBytes)
  );
}

function isSafeError(value: unknown): value is WorkerErrorMessage['error'] {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    SAFE_CODE.test(value.code) &&
    typeof value.message === 'string' &&
    value.message.trim().length > 0 &&
    value.message.length <= MAX_MESSAGE_LENGTH
  );
}

export type ParseWorkerMessage =
  | { readonly ok: true; readonly message: WorkerMessage }
  | { readonly ok: false };

export function parseWorkerMessage(
  value: unknown,
  binding: EngineResultBinding,
): ParseWorkerMessage {
  if (!isRecord(value)) {
    return { ok: false };
  }
  switch (value.type) {
    case 'progress':
      return isProgress(value.progress)
        ? { ok: true, message: { type: 'progress', progress: value.progress } }
        : { ok: false };
    case 'result':
      return isEngineEvaluationResult(binding.levelId, value.result, binding) &&
        isStats(value.stats)
        ? {
            ok: true,
            message: {
              type: 'result',
              result: value.result,
              stats: value.stats,
            },
          }
        : { ok: false };
    case 'error':
      return isSafeError(value.error)
        ? { ok: true, message: { type: 'error', error: value.error } }
        : { ok: false };
    default:
      return { ok: false };
  }
}
