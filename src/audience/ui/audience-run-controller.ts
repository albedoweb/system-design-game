import {
  AUDIENCE_LEVEL_ID,
  audienceGraphDigest,
  cloneAudienceGraph,
  parseAudienceEvaluation,
  validateAudienceGraph,
  type AudienceEvaluation,
  type AudienceGraph,
} from '../index';
import type { TrafficFrame } from '../../simulation/traffic-telemetry';
import { isTrafficMessageFor } from '../../features/traffic/traffic-protocol';
import {
  useTrafficStore,
  type TrafficLevelId,
} from '../../features/traffic/traffic-store';
import {
  isAudienceWorkerResponse,
  type AudienceWorkerRequest,
  type AudienceWorkerResponse,
} from '../worker/audience-worker-protocol';
import { createAudienceWorker } from '../worker/audience-worker-factory';
import { useAudienceStore } from './audience-store';

export interface AudienceWorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  terminate(): void;
}

export type AudienceWorkerFactory = () => AudienceWorkerLike;

export interface AudienceWorkerHandlers {
  onProgress: (
    message: AudienceWorkerResponse & { type: 'progress' },
  ) => void;
  onResult: (
    message: AudienceWorkerResponse & { type: 'result' },
  ) => void;
  onError: (message: string) => void;
  onTraffic?: (frame: TrafficFrame) => void;
}

export interface AudienceRunControllerOptions {
  createWorker?: AudienceWorkerFactory;
  startTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Grace period for an incomplete result after Stop. */
  cancelGraceMs?: number;
  maxTrafficFrames?: number;
}

export interface AudienceRunController {
  start: (input: { graph: AudienceGraph; seed: number }) => void;
  cancel: () => void;
  dispose: () => void;
}

export const AUDIENCE_TRAFFIC_LEVEL: TrafficLevelId = 'live-audience';

const MAX_TRAFFIC_FRAMES = 240;
const PROGRESS_INTERVAL_MS = 100;
let runCounter = 0;

function nextRunId(): string {
  runCounter += 1;
  return `audience-run-${Date.now().toString(36)}-${runCounter}`;
}

function friendlyEngineError(message: string): string {
  const trimmed = message.trim();
  if (/failed to fetch|network/i.test(trimmed)) {
    return 'The evaluation engine could not be started. The graph is safe; try again.';
  }
  return trimmed.length > 0
    ? trimmed
    : 'The Live Audience evaluation failed without a message. The graph is safe; try again.';
}

class AudienceWorkerClient {
  private readonly worker: AudienceWorkerLike;
  private readonly runId: string;
  private readonly handlers: AudienceWorkerHandlers;
  private readonly maxTrafficFrames: number;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressAt = 0;
  private readonly scopeFrameCounts = new Map<string, number>();
  private readonly scopeLastTime = new Map<string, number>();
  private disposed = false;

  constructor(
    factory: AudienceWorkerFactory,
    runId: string,
    handlers: AudienceWorkerHandlers,
    options: Required<
      Pick<
        AudienceRunControllerOptions,
        'startTimeoutMs' | 'totalTimeoutMs' | 'maxTrafficFrames'
      >
    >,
  ) {
    this.runId = runId;
    this.handlers = handlers;
    this.maxTrafficFrames = options.maxTrafficFrames;
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

    // Traffic is validated by the narrow shared guard: level, run id, bounds
    // and every frame field. Malformed or foreign frames never reach the UI.
    if (isTrafficMessageFor(message, AUDIENCE_LEVEL_ID, this.runId)) {
      this.clearStartTimer();
      // The 240-frame bound is per scope. Virtual time restarts for every case
      // inside the same published scope, so a regression marks a new case
      // segment and resets that scope's budget instead of exhausting it for
      // the last fault cases.
      const scopeId = message.frame.scopeId;
      const previousTime = this.scopeLastTime.get(scopeId);
      if (previousTime !== undefined && message.frame.timeMs <= previousTime) {
        this.scopeFrameCounts.set(scopeId, 0);
      }
      const count = this.scopeFrameCounts.get(scopeId) ?? 0;
      if (count >= this.maxTrafficFrames) {
        return;
      }
      this.scopeFrameCounts.set(scopeId, count + 1);
      this.scopeLastTime.set(scopeId, message.frame.timeMs);
      this.handlers.onTraffic?.(message.frame);
      return;
    }

    if (!isAudienceWorkerResponse(message) || message.runId !== this.runId) {
      return;
    }
    this.clearStartTimer();

    switch (message.type) {
      case 'progress': {
        const now = Date.now();
        if (
          now - this.lastProgressAt >= PROGRESS_INTERVAL_MS ||
          message.progress.phase === 'done'
        ) {
          this.lastProgressAt = now;
          this.handlers.onProgress(message);
        }
        break;
      }
      case 'result':
        this.handlers.onResult(message);
        this.dispose();
        break;
      case 'error':
        this.fail(message.message);
        break;
      case 'traffic':
        break;
    }
  };

  private handleWorkerError = (event: Event): void => {
    const detail =
      event instanceof ErrorEvent && typeof event.message === 'string'
        ? event.message.trim()
        : '';
    this.fail(
      detail
        ? `Live Audience engine error: ${detail}`
        : 'The Live Audience engine could not start.',
    );
  };

  private handleMessageError = (): void => {
    this.fail('The Live Audience engine returned an unreadable message.');
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

  send(request: AudienceWorkerRequest): boolean {
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

function identityMatches(
  evaluation: AudienceEvaluation,
  digest: string,
  seed: number,
): boolean {
  return (
    evaluation.levelId === AUDIENCE_LEVEL_ID &&
    evaluation.seed === seed &&
    evaluation.graphDigest === digest &&
    evaluation.identity.seed === seed &&
    evaluation.identity.graphDigest === digest
  );
}

export function createAudienceRunController(
  options: AudienceRunControllerOptions = {},
): AudienceRunController {
  const createWorker = options.createWorker ?? createAudienceWorker;
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  const totalTimeoutMs = options.totalTimeoutMs ?? 300_000;
  const cancelGraceMs = options.cancelGraceMs ?? 1_500;
  const maxTrafficFrames = options.maxTrafficFrames ?? MAX_TRAFFIC_FRAMES;

  let client: AudienceWorkerClient | null = null;
  let ownedRunId: string | null = null;
  let cancelTimer: ReturnType<typeof setTimeout> | null = null;

  const disposeClient = () => {
    client?.dispose();
    client = null;
  };

  const clearCancelTimer = () => {
    if (cancelTimer !== null) {
      clearTimeout(cancelTimer);
      cancelTimer = null;
    }
  };

  const isCurrent = (runId: string): boolean => {
    const state = useAudienceStore.getState();
    return (
      state.runId === runId &&
      (state.runPhase === 'running' || state.runPhase === 'stopping')
    );
  };

  const abortTraffic = (runId: string | null) => {
    if (!runId) {
      return;
    }
    const traffic = useTrafficStore.getState();
    if (traffic.run?.runId === runId) {
      traffic.abortRun(runId);
    }
  };

  const start: AudienceRunController['start'] = ({ graph, seed }) => {
    disposeClient();
    clearCancelTimer();
    abortTraffic(ownedRunId);
    ownedRunId = null;

    const blocking = validateAudienceGraph(graph).filter(
      (issue) => issue.severity === 'error',
    );
    if (blocking.length > 0) {
      useAudienceStore.getState().blockRun(blocking);
      return;
    }

    const frozen = cloneAudienceGraph(graph);
    const digest = audienceGraphDigest(frozen);
    const runId = nextRunId();
    ownedRunId = runId;
    useAudienceStore.getState().beginRun({ runId, seed, digest });
    useTrafficStore.getState().beginRun({
      levelId: AUDIENCE_TRAFFIC_LEVEL,
      runId,
      binding: `live-audience|digest${digest}|seed${seed}`,
    });

    try {
      client = new AudienceWorkerClient(
        createWorker,
        runId,
        {
          onProgress: (message) => {
            if (!isCurrent(runId)) {
              return;
            }
            useAudienceStore.getState().updateProgress(message.progress);
          },
          onResult: (message) => {
            if (!isCurrent(runId)) {
              return;
            }
            const parsed = parseAudienceEvaluation(message.evaluation);
            if (!parsed.ok) {
              ownedRunId = null;
              abortTraffic(runId);
              useAudienceStore
                .getState()
                .failRun(
                  parsed.issues[0]?.message ??
                    'The engine returned a result that does not match the Live Audience contract.',
                );
              return;
            }
            const evaluation = parsed.value;
            if (!identityMatches(evaluation, digest, seed)) {
              ownedRunId = null;
              abortTraffic(runId);
              useAudienceStore
                .getState()
                .failRun(
                  'The engine result does not match this graph, seed and run identity. It was rejected.',
                );
              return;
            }
            ownedRunId = null;
            clearCancelTimer();
            useAudienceStore.getState().completeRun({
              evaluation,
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
            clearCancelTimer();
            abortTraffic(runId);
            useAudienceStore.getState().failRun(message);
          },
          onTraffic: (frame) => {
            if (!isCurrent(runId)) {
              return;
            }
            useTrafficStore.getState().acceptFrame({
              levelId: AUDIENCE_TRAFFIC_LEVEL,
              runId,
              frame,
            });
          },
        },
        { startTimeoutMs, totalTimeoutMs, maxTrafficFrames },
      );
      client.send({ type: 'run', runId, graph: frozen, seed });
    } catch {
      disposeClient();
      ownedRunId = null;
      abortTraffic(runId);
      if (isCurrent(runId)) {
        useAudienceStore
          .getState()
          .failRun(
            'Could not start the evaluation engine. The graph is editable; try again.',
          );
      }
    }
  };

  const cancel: AudienceRunController['cancel'] = () => {
    const runId = ownedRunId;
    const state = useAudienceStore.getState();
    if (
      !runId ||
      state.runId !== runId ||
      (state.runPhase !== 'running' && state.runPhase !== 'stopping')
    ) {
      disposeClient();
      abortTraffic(ownedRunId);
      ownedRunId = null;
      return;
    }

    if (state.runPhase === 'running') {
      useAudienceStore.setState({ runPhase: 'stopping' });
    }
    client?.send({ type: 'cancel', runId });

    // The worker reports an incomplete/cancelled result when it can. If no
    // result arrives within the grace period the run is cleared; it is never
    // turned into a pass.
    clearCancelTimer();
    cancelTimer = setTimeout(() => {
      if (!isCurrent(runId)) {
        return;
      }
      disposeClient();
      ownedRunId = null;
      abortTraffic(runId);
      useAudienceStore.getState().cancelRun();
    }, cancelGraceMs);
  };

  const dispose = () => {
    clearCancelTimer();
    disposeClient();
    const runId = ownedRunId;
    ownedRunId = null;
    abortTraffic(runId);
    if (runId) {
      const state = useAudienceStore.getState();
      if (
        state.runId === runId &&
        (state.runPhase === 'running' || state.runPhase === 'stopping')
      ) {
        useAudienceStore.getState().cancelRun();
      }
    }
  };

  return { start, cancel, dispose };
}
