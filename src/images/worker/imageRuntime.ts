import type {
  ImageEvaluation,
  ImageRunOptions,
} from '../contracts';
import {
  isImageWorkerRequest,
  type ImageWorkerResponse,
} from './image-worker-protocol';

/** The frozen evaluator ABI supplied by I101 (`src/images/evaluate.ts`). */
export type ImageEvaluator = (
  input: unknown,
  options: ImageRunOptions,
) => ImageEvaluation;

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'The Image Atlas engine failed without a message.';
}

/**
 * Worker-side runtime with no DOM or React dependency, so the request handling
 * can be tested against a fake evaluator. Production passes the real
 * `evaluateImages` entry point from the dedicated worker file.
 */
export function createImageWorkerRuntime(
  post: (message: ImageWorkerResponse) => void,
  evaluator: ImageEvaluator,
) {
  return {
    handleMessage(data: unknown): void {
      if (!isImageWorkerRequest(data)) {
        return;
      }
      const request = data;
      try {
        const evaluation = evaluator(request.graph, {
          seed: request.seed,
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
