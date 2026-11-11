import type {
  RunResult,
  SimulationSnapshot,
  SimulationSpeed,
  WorkerCommand,
  WorkerMessage,
} from '../../domain';
import type { TrafficFrame } from '../../simulation/traffic-telemetry';
import { isTrafficMessageFor } from '../traffic/traffic-protocol';

export type WorkerFactory = () => Worker;

export interface WorkerClientHandlers {
  onSnapshot: (snapshot: SimulationSnapshot) => void;
  onResult: (result: RunResult) => void;
  onPaused: () => void;
  onResumed: () => void;
  onStopped: () => void;
  onError: (message: string) => void;
  /** Optional measured frame from the same run; malformed messages are ignored. */
  onTraffic?: (frame: TrafficFrame) => void;
}

const MESSAGE_TYPES = new Set([
  'snapshot',
  'result',
  'error',
  'paused',
  'resumed',
  'stopped',
]);

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { type?: unknown; runId?: unknown };
  return (
    typeof candidate.type === 'string' &&
    MESSAGE_TYPES.has(candidate.type) &&
    typeof candidate.runId === 'string'
  );
}

/**
 * One worker connection for exactly one run. Messages for any other runId are
 * ignored, and the worker is always terminated on result, error, timeout,
 * stop or explicit dispose.
 */
export class SimulationWorkerClient {
  private readonly worker: Worker;
  private readonly runId: string;
  private readonly handlers: WorkerClientHandlers;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    factory: WorkerFactory,
    runId: string,
    handlers: WorkerClientHandlers,
    timeoutMs: number,
  ) {
    this.runId = runId;
    this.handlers = handlers;
    this.worker = factory();
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleWorkerError);
    this.worker.addEventListener('messageerror', this.handleMessageError);
    this.startTimer = setTimeout(() => {
      this.fail('The engine did not respond in time. Check the graph and try again.');
    }, timeoutMs);
  }

  private handleMessage = (event: Event): void => {
    if (this.disposed) {
      return;
    }
    const message: unknown = (event as MessageEvent).data;
    // Telemetry is an optional message outside the frozen domain union. It is
    // accepted only when the shared shape and this run's id both match.
    if (isTrafficMessageFor(message, 'cold-cache', this.runId)) {
      this.clearStartTimer();
      this.handlers.onTraffic?.(message.frame);
      return;
    }
    if (!isWorkerMessage(message) || message.runId !== this.runId) {
      return;
    }
    this.clearStartTimer();
    switch (message.type) {
      case 'snapshot':
        this.handlers.onSnapshot(message.snapshot);
        break;
      case 'result':
        this.handlers.onResult(message.result);
        this.dispose();
        break;
      case 'error':
        this.fail(message.message || 'The engine reported an error.');
        break;
      case 'paused':
        this.handlers.onPaused();
        break;
      case 'resumed':
        this.handlers.onResumed();
        break;
      case 'stopped':
        this.handlers.onStopped();
        this.dispose();
        break;
    }
  };

  private handleWorkerError = (event: Event): void => {
    const message = (event as ErrorEvent).message;
    this.fail(
      message
        ? `Engine error: ${message}`
        : 'Could not start the simulation engine.',
    );
  };

  private handleMessageError = (): void => {
    this.fail('The engine returned a message in an unknown format.');
  };

  private fail(message: string): void {
    if (this.disposed) {
      return;
    }
    this.handlers.onError(message);
    this.dispose();
  }

  private clearStartTimer(): void {
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  send(command: WorkerCommand): boolean {
    if (this.disposed) {
      return false;
    }
    try {
      this.worker.postMessage(command);
      return true;
    } catch {
      this.fail('Could not send a command to the engine.');
      return false;
    }
  }

  setSpeed(speed: SimulationSpeed): void {
    this.send({ type: 'speed', runId: this.runId, speed });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearStartTimer();
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleWorkerError);
    this.worker.removeEventListener('messageerror', this.handleMessageError);
    try {
      this.worker.terminate();
    } catch {
      // A worker that already failed may throw on terminate; nothing to clean.
    }
  }
}
