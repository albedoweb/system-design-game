import { createCartWorkerRuntime } from './cartRuntime';
import type {
  CartWorkerRequest,
  CartWorkerResponse,
} from './cart-worker-protocol';

/**
 * Dedicated Global Cart worker entry point. The UI creates one worker per run
 * and terminates it on completion, cancellation, reset or unmount.
 */
interface CartWorkerScope {
  postMessage(message: CartWorkerResponse): void;
  onmessage: ((event: MessageEvent<CartWorkerRequest>) => void) | null;
}

const scope = self as unknown as CartWorkerScope;
const runtime = createCartWorkerRuntime((message) => {
  scope.postMessage(message);
});

scope.onmessage = (event) => {
  runtime.handleMessage(event.data);
};
