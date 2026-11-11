import { createParcelWorkerRuntime } from './parcelRuntime';
import type {
  ParcelWorkerRequest,
  ParcelWorkerResponse,
} from './parcel-worker-protocol';

/**
 * Dedicated worker entry point. Vite bundles this module through the literal
 * URL in `parcel-worker-factory.ts`; the UI keeps one worker per evaluation.
 */
interface ParcelWorkerScope {
  postMessage(message: ParcelWorkerResponse): void;
  onmessage: ((event: MessageEvent<ParcelWorkerRequest>) => void) | null;
}

const scope = self as unknown as ParcelWorkerScope;
const runtime = createParcelWorkerRuntime((message) => {
  scope.postMessage(message);
});

scope.onmessage = (event) => {
  runtime.handleMessage(event.data);
};
