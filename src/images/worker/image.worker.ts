import { evaluateImages } from '../evaluate';
import { createImageWorkerRuntime } from './imageRuntime';
import type {
  ImageWorkerRequest,
  ImageWorkerResponse,
} from './image-worker-protocol';

/**
 * Dedicated worker entry point for Image Atlas.
 *
 * `evaluateImages` is the frozen evaluator ABI owned by I101 and lives in
 * `src/images/evaluate.ts`. This module is the only place that binds the engine
 * to the worker: there is no stub, no fallback simulation and no duplicate
 * formula set in the UI. The call is type-checked against
 * `(input: unknown, options: ImageRunOptions) => ImageEvaluation`.
 */
interface ImageWorkerScope {
  postMessage(message: ImageWorkerResponse): void;
  onmessage: ((event: MessageEvent<ImageWorkerRequest>) => void) | null;
}

const scope = self as unknown as ImageWorkerScope;
const runtime = createImageWorkerRuntime(
  (message) => {
    scope.postMessage(message);
  },
  evaluateImages,
);

scope.onmessage = (event) => {
  runtime.handleMessage(event.data);
};
