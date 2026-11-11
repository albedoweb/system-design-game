import type { ImageGraph } from '../contracts';
import { cloneImageGraph, imageGraphDigest, validateImageGraph } from '../graph';
import type { TrafficFrame } from '../../simulation/traffic-telemetry';
import { isTrafficMessageFor } from '../../features/traffic/traffic-protocol';
import { useTrafficStore } from '../../features/traffic/traffic-store';
import type {
  ImageWorkerRequest,
  ImageWorkerResponse,
} from '../worker/image-worker-protocol';
import { isImageWorkerResponse } from '../worker/image-worker-protocol';
import { createImageWorker } from '../worker/image-worker-factory';
import { useImageStore } from './image-store';

export interface ImageWorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  terminate(): void;
}

export type ImageWorkerFactory = () => ImageWorkerLike;

export interface ImageWorkerHandlers {
  onProgress: (progress: ImageWorkerResponse & { type: 'progress' }) => void;
  onResult: (message: ImageWorkerResponse & { type: 'result' }) => void;
  onError: (message: string) => void;
  /** Optional measured frame from the same run; malformed messages are ignored. */
  onTraffic?: (frame: TrafficFrame) => void;
}

export interface ImageRunControllerOptions {
  createWorker?: ImageWorkerFactory;
  /** Time allowed before the first message from the worker. */
  startTimeoutMs?: number;
  /** Hard bound for a full seven-case qualification run. */
  totalTimeoutMs?: number;
}

export interface ImageRunController {
  start: (input: { graph: ImageGraph; seed: number }) => void;
  cancel: () => void;
  dispose: () => void;
}

let runCounter = 0;

function nextRunId(): string {
  runCounter += 1;
  return `image-run-${Date.now().toString(36)}-${runCounter}`;
}

function friendlyEngineError(message: string): string {
  if (/failed to fetch|network/i.test(message)) {
    return 'The evaluation engine could not be started. The graph is safe; try again.';
  }
  if (/failed to resolve|evaluate|not found/i.test(message)) {
    return `The Image Atlas evaluator is not available in this build: ${message}`;
  }
  return message.trim().length > 0
    ? message
    : 'The Image Atlas evaluation failed without a message. The graph is safe; try again.';
}

class ImageWorkerClient {
  private readonly worker: ImageWorkerLike;
  private readonly runId: string;
  private readonly handlers: ImageWorkerHandlers;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    factory: ImageWorkerFactory,
    runId: string,
    handlers: ImageWorkerHandlers,
    options: Required<
      Pick<ImageRunControllerOptions, 'startTimeoutMs' | 'totalTimeoutMs'>
    >,
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
    if (isTrafficMessageFor(message, 'image-atlas', this.runId)) {
      this.clearStartTimer();
      this.handlers.onTraffic?.(message.frame);
      return;
    }
    if (!isImageWorkerResponse(message) || message.runId !== this.runId) {
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
        ? `Image Atlas engine error: ${detail}`
        : 'The Image Atlas engine could not start.',
    );
  };

  private handleMessageError = (): void => {
    this.fail('The Image Atlas engine returned an unreadable message.');
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

  send(request: ImageWorkerRequest): boolean {
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

/**
 * One controller owns at most one worker. Every callback is bound to the run id
 * that this controller started, and the store rejects any message whose run id
 * is not the current one, so an older run can never publish over a newer run or
 * over a Reset.
 */
export function createImageRunController(
  options: ImageRunControllerOptions = {},
): ImageRunController {
  const createWorker = options.createWorker ?? createImageWorker;
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  // A full seven-case qualification with p99.9 sample extension may take
  // minutes; the bound still guarantees that a hung worker cannot run forever.
  const totalTimeoutMs = options.totalTimeoutMs ?? 900_000;
  let client: ImageWorkerClient | null = null;
  let ownedRunId: string | null = null;
  let ownedTrafficRunId: string | null = null;

  const disposeClient = () => {
    client?.dispose();
    client = null;
  };

  const isCurrent = (runId: string): boolean => {
    const state = useImageStore.getState();
    return state.runId === runId && state.runPhase === 'running';
  };

  const releaseOwnedRunIfNeeded = () => {
    const runId = ownedRunId;
    ownedRunId = null;
    if (!runId) {
      return;
    }
    const state = useImageStore.getState();
    if (
      state.runId === runId &&
      (state.runPhase === 'running' || state.runPhase === 'stopping')
    ) {
      useImageStore.getState().cancelRun();
    }
  };

  const start: ImageRunController['start'] = ({ graph, seed }) => {
    disposeClient();
    const previousTraffic = useTrafficStore.getState();
    if (previousTraffic.run?.levelId === 'image-atlas') {
      previousTraffic.abortRun(previousTraffic.run.runId);
    }
    ownedTrafficRunId = null;
    const blocking = validateImageGraph(graph, { mode: 'run' }).filter(
      (issue) => issue.severity === 'error',
    );
    if (blocking.length > 0) {
      ownedRunId = null;
      useImageStore.getState().blockRun(blocking);
      return;
    }
    const frozen = cloneImageGraph(graph);
    const digest = imageGraphDigest(frozen);
    const runId = nextRunId();
    ownedRunId = runId;
    useImageStore.getState().beginRun({ runId, seed, digest });
    useTrafficStore.getState().beginRun({
      levelId: 'image-atlas',
      runId,
      binding: `image-atlas|digest${digest}|seed${seed}`,
    });
    ownedTrafficRunId = runId;

    try {
      client = new ImageWorkerClient(
        createWorker,
        runId,
        {
          onProgress: (message) => {
            if (!isCurrent(runId)) {
              return;
            }
            useImageStore.getState().updateProgress(runId, message.progress);
          },
          onResult: (message) => {
            if (!isCurrent(runId)) {
              return;
            }
            ownedRunId = null;
            useImageStore.getState().completeRun(runId, {
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
            useImageStore.getState().failRun(runId, message);
          },
          onTraffic: (frame) => {
            if (!isCurrent(runId)) {
              return;
            }
            useTrafficStore.getState().acceptFrame({
              levelId: 'image-atlas',
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
        useImageStore
          .getState()
          .failRun(
            runId,
            'Could not start the evaluation engine. The graph is editable; try again.',
          );
      }
    }
  };

  const cancel = () => {
    const runId = ownedRunId;
    const state = useImageStore.getState();
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
    useImageStore.getState().cancelRun();
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
