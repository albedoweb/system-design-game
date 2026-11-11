import {
  IMAGE_MAX_SEED,
  type ImageEvaluation,
  type ImageGraph,
  type ImageProgress,
} from '../contracts';
import type { TrafficFrame } from '../../simulation/traffic-telemetry';

export interface ImageWorkerRunRequest {
  type: 'run';
  runId: string;
  graph: ImageGraph;
  seed: number;
}

export type ImageWorkerRequest = ImageWorkerRunRequest;

export type ImageWorkerResponse =
  | {
      type: 'progress';
      runId: string;
      progress: ImageProgress;
    }
  | {
      type: 'result';
      runId: string;
      evaluation: ImageEvaluation;
    }
  | {
      type: 'error';
      runId: string;
      message: string;
    }
  | {
      type: 'traffic';
      runId: string;
      frame: TrafficFrame;
    };

export function isImageWorkerRequest(
  value: unknown,
): value is ImageWorkerRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as {
    type?: unknown;
    runId?: unknown;
    graph?: unknown;
    seed?: unknown;
  };
  return (
    candidate.type === 'run' &&
    typeof candidate.runId === 'string' &&
    candidate.runId.length > 0 &&
    candidate.runId.length <= 128 &&
    typeof candidate.graph === 'object' &&
    candidate.graph !== null &&
    typeof candidate.seed === 'number' &&
    Number.isInteger(candidate.seed) &&
    candidate.seed >= 0 &&
    candidate.seed <= IMAGE_MAX_SEED
  );
}

export function isImageWorkerResponse(
  value: unknown,
): value is ImageWorkerResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { type?: unknown; runId?: unknown };
  if (typeof candidate.runId !== 'string') {
    return false;
  }
  return (
    candidate.type === 'progress' ||
    candidate.type === 'result' ||
    candidate.type === 'error' ||
    candidate.type === 'traffic'
  );
}
