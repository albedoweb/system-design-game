import type { WorkerCommand, WorkerMessage } from '../domain/worker';
import { createSimulationWorkerRuntime } from './simulationRuntime';

/**
 * Dedicated worker entry point. Vite bundles this module via the literal URL
 * documented in `SIMULATION_WORKER_PATH`; the UI adapter owns lifecycle.
 */
interface WorkerScope {
  postMessage(message: WorkerMessage): void;
  onmessage: ((event: MessageEvent<WorkerCommand>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const runtime = createSimulationWorkerRuntime((message) => {
  scope.postMessage(message);
});

scope.onmessage = (event) => {
  runtime.handleCommand(event.data);
};
