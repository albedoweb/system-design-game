import { createScoreboardWorkerRuntime } from './scoreboardRuntime';
import type {
  ScoreboardWorkerRequest,
  ScoreboardWorkerResponse,
} from './scoreboard-worker-protocol';

/**
 * Dedicated worker entry point. The UI creates exactly one worker per run and
 * terminates it on completion, cancellation or unmount.
 */
interface ScoreboardWorkerScope {
  postMessage(message: ScoreboardWorkerResponse): void;
  onmessage: ((event: MessageEvent<ScoreboardWorkerRequest>) => void) | null;
}

const scope = self as unknown as ScoreboardWorkerScope;
const runtime = createScoreboardWorkerRuntime((message) => {
  scope.postMessage(message);
});

scope.onmessage = (event) => {
  runtime.handleMessage(event.data);
};
