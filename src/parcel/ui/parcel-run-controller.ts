import type { ParcelGraph } from '../contracts';
import { parcelSemanticDigest, cloneParcelGraph, validateParcelGraph } from '../graph';
import type { TrafficFrame } from '../../simulation/traffic-telemetry';
import { isTrafficMessageFor } from '../../features/traffic/traffic-protocol';
import { useTrafficStore } from '../../features/traffic/traffic-store';
import type {
  ParcelWorkerRequest,
  ParcelWorkerResponse,
} from '../worker/parcel-worker-protocol';
import { isParcelWorkerResponse } from '../worker/parcel-worker-protocol';
import { createParcelWorker } from '../worker/parcel-worker-factory';
import { useParcelStore } from './parcel-store';

export interface ParcelWorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  terminate(): void;
}

export type ParcelWorkerFactory = () => ParcelWorkerLike;

export interface ParcelWorkerHandlers {
  onProgress: (progress: ParcelWorkerResponse & { type: 'progress' }) => void;
  onResult: (message: ParcelWorkerResponse & { type: 'result' }) => void;
  onError: (message: string) => void;
  /** Optional measured frame from the same run; malformed messages are ignored. */
  onTraffic?: (frame: TrafficFrame) => void;
}

export interface ParcelRunControllerOptions {
  createWorker?: ParcelWorkerFactory;
  /** Time allowed before the first message from the worker. */
  startTimeoutMs?: number;
  /** Hard bound for a single evaluation. */
  totalTimeoutMs?: number;
}

export interface ParcelRunController {
  start: (input: { graph: ParcelGraph; seed: number }) => void;
  cancel: () => void;
  dispose: () => void;
}

let runCounter = 0;

function nextRunId(): string {
  runCounter += 1;
  return `parcel-run-${Date.now().toString(36)}-${runCounter}`;
}

function friendlyEngineError(message: string): string {
  if (/failed to fetch|network/i.test(message)) {
    return 'The evaluation engine could not be started. The graph is safe; try again.';
  }
  return message.trim().length > 0
    ? message
    : 'The Parcel evaluation failed without a message. The graph is safe; try again.';
}

class ParcelWorkerClient {
  private readonly worker: ParcelWorkerLike;
  private readonly runId: string;
  private readonly handlers: ParcelWorkerHandlers;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    factory: ParcelWorkerFactory,
    runId: string,
    handlers: ParcelWorkerHandlers,
    options: Required<Pick<ParcelRunControllerOptions, 'startTimeoutMs' | 'totalTimeoutMs'>>,
  ) {
    this.runId = runId;
    this.handlers = handlers;
    this.worker = factory();
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleWorkerError);
    this.worker.addEventListener('messageerror', this.handleMessageError);
    this.startTimer = setTimeout(() => {
      this.fail(
        'The evaluation engine did not respond in time. The graph is safe; try again.',
      );
    }, options.startTimeoutMs);
    this.totalTimer = setTimeout(() => {
      this.fail(
        'The evaluation engine exceeded its time bound and was cancelled. No partial result is reported.',
      );
    }, options.totalTimeoutMs);
  }

  private handleMessage = (event: Event): void => {
    if (this.disposed) {
      return;
    }
    const message: unknown = (event as MessageEvent).data;
    // Optional browser telemetry is outside the frozen worker response union.
    // The narrow shared guard validates shape, bounds, level and run id.
    if (isTrafficMessageFor(message, 'parcel-pulse', this.runId)) {
      this.clearStartTimer();
      this.handlers.onTraffic?.(message.frame);
      return;
    }
    if (!isParcelWorkerResponse(message) || message.runId !== this.runId) {
      return;
    }
    this.clearStartTimer();
    switch (message.type) {
      case 'progress':
        this.handlers.onProgress(message);
        break;
      case 'result':
        this.handlers.onResult(message);
        this.dispose();
        break;
      case 'error':
        this.fail(message.message);
        break;
    }
  };

  private handleWorkerError = (event: Event): void => {
    const detail =
      event instanceof ErrorEvent && event.message.trim().length > 0
        ? event.message
        : '';
    this.fail(
      detail
        ? `Parcel engine error: ${detail}`
        : 'The Parcel engine could not start.',
    );
  };

  private handleMessageError = (): void => {
    this.fail('The Parcel engine returned an unreadable message.');
  };

  private clearStartTimer(): void {
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  private clearTotalTimer(): void {
    if (this.totalTimer !== null) {
      clearTimeout(this.totalTimer);
      this.totalTimer = null;
    }
  }

  private fail(message: string): void {
    if (this.disposed) {
      return;
    }
    this.handlers.onError(friendlyEngineError(message));
    this.dispose();
  }

  send(request: ParcelWorkerRequest): boolean {
    if (this.disposed) {
      return false;
    }
    try {
      this.worker.postMessage(request);
      return true;
    } catch {
      this.fail('Could not send the evaluation request to the engine.');
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearStartTimer();
    this.clearTotalTimer();
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleWorkerError);
    this.worker.removeEventListener('messageerror', this.handleMessageError);
    try {
      this.worker.terminate();
    } catch {
      // A worker that already failed may throw on terminate.
    }
  }
}

export function createParcelRunController(
  options: ParcelRunControllerOptions = {},
): ParcelRunController {
  const createWorker = options.createWorker ?? createParcelWorker;
  const startTimeoutMs = options.startTimeoutMs ?? 20_000;
  const totalTimeoutMs = options.totalTimeoutMs ?? 180_000;
  let client: ParcelWorkerClient | null = null;
  let ownedRunId: string | null = null;
  let ownedTrafficRunId: string | null = null;

  const disposeClient = () => {
    client?.dispose();
    client = null;
  };

  const isCurrent = (runId: string): boolean => {
    const state = useParcelStore.getState();
    return state.runId === runId && state.runPhase === 'running';
  };

  const releaseOwnedRunIfNeeded = () => {
    const runId = ownedRunId;
    ownedRunId = null;
    if (!runId) {
      return;
    }
    const state = useParcelStore.getState();
    if (
      state.runId === runId &&
      (state.runPhase === 'running' || state.runPhase === 'stopping')
    ) {
      useParcelStore.getState().cancelRun();
    }
  };

  const start: ParcelRunController['start'] = ({ graph, seed }) => {
    disposeClient();
    const previousTraffic = useTrafficStore.getState();
    if (previousTraffic.run?.levelId === 'parcel-pulse') {
      previousTraffic.abortRun(previousTraffic.run.runId);
    }
    ownedTrafficRunId = null;
    const blocking = validateParcelGraph(graph, { mode: 'run' }).filter(
      (issue) => issue.severity === 'error',
    );
    if (blocking.length > 0) {
      ownedRunId = null;
      useParcelStore.getState().blockRun(blocking);
      return;
    }
    const frozen = cloneParcelGraph(graph);
    const digest = parcelSemanticDigest(frozen);
    const runId = nextRunId();
    ownedRunId = runId;
    useParcelStore.getState().beginRun({ runId, seed, digest });
    useTrafficStore.getState().beginRun({
      levelId: 'parcel-pulse',
      runId,
      binding: `parcel-pulse|digest${digest}|seed${seed}`,
    });
    ownedTrafficRunId = runId;

    try {
      client = new ParcelWorkerClient(
        createWorker,
        runId,
        {
          onProgress: (message) => {
            if (!isCurrent(runId)) {
              return;
            }
            useParcelStore.getState().updateProgress(message.progress);
          },
          onResult: (message) => {
            if (!isCurrent(runId)) {
              return;
            }
            ownedRunId = null;
            useParcelStore.getState().completeRun({
              evaluation: message.evaluation,
              seed,
              digest,
            });
            useTrafficStore.getState().completeRun(runId);
          },
          onError: (message) => {
            if (!isCurrent(runId)) {
              return;
            }
            ownedRunId = null;
            useTrafficStore.getState().abortRun(runId);
            ownedTrafficRunId = null;
            useParcelStore.getState().failRun(message);
          },
          onTraffic: (frame) => {
            if (!isCurrent(runId)) {
              return;
            }
            useTrafficStore.getState().acceptFrame({
              levelId: 'parcel-pulse',
              runId,
              frame,
            });
          },
        },
        { startTimeoutMs, totalTimeoutMs },
      );
      client.send({
        type: 'run',
        runId,
        graph: frozen,
        seed,
      });
    } catch {
      disposeClient();
      ownedRunId = null;
      useTrafficStore.getState().abortRun(runId);
      ownedTrafficRunId = null;
      if (isCurrent(runId)) {
        useParcelStore
          .getState()
          .failRun(
            'Could not start the evaluation engine. The graph is editable; try again.',
          );
      }
    }
  };

  const cancel = () => {
    const runId = ownedRunId;
    const state = useParcelStore.getState();
    if (
      !runId ||
      state.runId !== runId ||
      (state.runPhase !== 'running' && state.runPhase !== 'stopping')
    ) {
      disposeClient();
      ownedRunId = null;
      if (ownedTrafficRunId) {
        useTrafficStore.getState().abortRun(ownedTrafficRunId);
        ownedTrafficRunId = null;
      }
      return;
    }
    disposeClient();
    ownedRunId = null;
    useTrafficStore.getState().abortRun(runId);
    ownedTrafficRunId = null;
    useParcelStore.getState().cancelRun();
  };

  const dispose = () => {
    disposeClient();
    if (ownedTrafficRunId) {
      useTrafficStore.getState().abortRun(ownedTrafficRunId);
      ownedTrafficRunId = null;
    }
    releaseOwnedRunIfNeeded();
  };

  return { start, cancel, dispose };
}
