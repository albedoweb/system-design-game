import { createAudienceWorkerRuntime } from './audienceRuntime';
import type {
  AudienceWorkerRequest,
  AudienceWorkerResponse,
} from './audience-worker-protocol';

/**
 * Dedicated worker entry point. The UI creates exactly one worker per run and
 * terminates it on completion, cancellation or unmount.
 */
interface AudienceWorkerScope {
  postMessage(message: AudienceWorkerResponse): void;
  onmessage: ((event: MessageEvent<AudienceWorkerRequest>) => void) | null;
}

const scope = self as unknown as AudienceWorkerScope;
const runtime = createAudienceWorkerRuntime((message) => {
  scope.postMessage(message);
});

scope.onmessage = (event) => {
  runtime.handleMessage(event.data);
};
