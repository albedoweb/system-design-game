import type { ParcelEvaluation, ParcelRunOptions } from '../contracts';
import { evaluateParcel } from '../evaluate';
import {
  isParcelWorkerRequest,
  type ParcelWorkerRequest,
  type ParcelWorkerResponse,
} from './parcel-worker-protocol';

export type ParcelEvaluator = (
  input: unknown,
  options?: ParcelRunOptions,
) => ParcelEvaluation;

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'The Parcel engine failed without a message.';
}

/**
 * Worker-side runtime. It contains no DOM or React code, so the same request
 * handling can be tested with a fake evaluator. The evaluator is injected only
 * for tests; production uses the frozen `evaluateParcel` entry point.
 */
export function createParcelWorkerRuntime(
  post: (message: ParcelWorkerResponse) => void,
  evaluator: ParcelEvaluator = evaluateParcel,
) {
  return {
    handleMessage(data: unknown): void {
      if (!isParcelWorkerRequest(data)) {
        return;
      }
      const request: ParcelWorkerRequest = data;
      try {
        const evaluation = evaluator(request.graph, {
          seed: request.seed,
          ...(request.horizons ? { horizons: request.horizons } : {}),
          onProgress: (progress) => {
            post({
              type: 'progress',
              runId: request.runId,
              progress,
            });
          },
          onTraffic: (frame) => {
            post({
              type: 'traffic',
              runId: request.runId,
              frame,
            });
          },
        });
        post({
          type: 'result',
          runId: request.runId,
          evaluation,
        });
      } catch (error) {
        post({
          type: 'error',
          runId: request.runId,
          message: describeError(error),
        });
      }
    },
  };
}
