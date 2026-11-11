import type {
  ParcelEvaluation,
  ParcelGraph,
  ParcelHorizonYears,
  ParcelProgress,
} from '../contracts';
import type { TrafficFrame } from '../../simulation/traffic-telemetry';

export interface ParcelWorkerRunRequest {
  type: 'run';
  runId: string;
  graph: ParcelGraph;
  seed: number;
  horizons?: readonly ParcelHorizonYears[];
}

export type ParcelWorkerRequest = ParcelWorkerRunRequest;

export type ParcelWorkerResponse =
  | {
      type: 'progress';
      runId: string;
      progress: ParcelProgress;
    }
  | {
      type: 'result';
      runId: string;
      evaluation: ParcelEvaluation;
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

export function isParcelWorkerRequest(value: unknown): value is ParcelWorkerRequest {
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
    typeof candidate.graph === 'object' &&
    candidate.graph !== null &&
    typeof candidate.seed === 'number' &&
    Number.isFinite(candidate.seed)
  );
}

export function isParcelWorkerResponse(
  value: unknown,
): value is ParcelWorkerResponse {
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
