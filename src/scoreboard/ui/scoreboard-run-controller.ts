import {
  SCOREBOARD_LEVEL_ID,
  cloneScoreboardGraph,
  parseScoreboardEvaluation,
  scoreboardGraphDigest,
  validateScoreboardGraph,
  type ScoreboardEvaluation,
  type ScoreboardGraph,
} from '../index';
import type { TrafficFrame } from '../../simulation/traffic-telemetry';
import { isTrafficMessageFor } from '../../features/traffic/traffic-protocol';
import {
  useTrafficStore,
  type TrafficLevelId,
} from '../../features/traffic/traffic-store';
import {
  isScoreboardWorkerResponse,
  type ScoreboardWorkerRequest,
  type ScoreboardWorkerResponse,
} from '../worker/scoreboard-worker-protocol';
import { createScoreboardWorker } from '../worker/scoreboard-worker-factory';
import { useScoreboardStore } from './scoreboard-store';

export interface ScoreboardWorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  terminate(): void;
}

export type ScoreboardWorkerFactory = () => ScoreboardWorkerLike;

export interface ScoreboardWorkerHandlers {
  onProgress: (
    message: ScoreboardWorkerResponse & { type: 'progress' },
  ) => void;
  onResult: (
    message: ScoreboardWorkerResponse & { type: 'result' },
  ) => void;
  onError: (message: string) => void;
  onTraffic?: (frame: TrafficFrame) => void;
}

export interface ScoreboardRunControllerOptions {
  createWorker?: ScoreboardWorkerFactory;
  startTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Grace period for an incomplete result after Stop. */
  cancelGraceMs?: number;
  maxTrafficFrames?: number;
}

export interface ScoreboardRunController {
  start: (input: { graph: ScoreboardGraph; seed: number }) => void;
  cancel: () => void;
  dispose: () => void;
}

/**
 * The shared traffic store and TrafficFrame union currently list the three
 * legacy levels. This is the single documented bridge until the shared type
 * gains live-scoreboard; the runtime frame is already validated below.
 */
const SCOREBOARD_TRAFFIC_LEVEL = 'live-scoreboard' as TrafficLevelId;

const MAX_TRAFFIC_FRAMES = 240;
const PROGRESS_INTERVAL_MS = 100;
let runCounter = 0;

function nextRunId(): string {
  runCounter += 1;
  return `scoreboard-run-${Date.now().toString(36)}-${runCounter}`;
}

function friendlyEngineError(message: string): string {
  const trimmed = message.trim();
  if (/failed to fetch|network/i.test(trimmed)) {
    return 'The evaluation engine could not be started. The graph is safe; try again.';
  }
  return trimmed.length > 0
    ? trimmed
    : 'The Live Scoreboard evaluation failed without a message. The graph is safe; try again.';
}

class ScoreboardWorkerClient {
  private readonly worker: ScoreboardWorkerLike;
  private readonly runId: string;
  private readonly handlers: ScoreboardWorkerHandlers;
  private readonly maxTrafficFrames: number;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressAt = 0;
  private trafficFrames = 0;
  private disposed = false;

  constructor(
    factory: ScoreboardWorkerFactory,
    runId: string,
    handlers: ScoreboardWorkerHandlers,
    options: Required<
      Pick<
        ScoreboardRunControllerOptions,
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
    if (isTrafficMessageFor(message, SCOREBOARD_LEVEL_ID, this.runId)) {
      this.clearStartTimer();
      if (this.trafficFrames >= this.maxTrafficFrames) {
        return;
      }
      this.trafficFrames += 1;
      this.handlers.onTraffic?.(
        message.frame as unknown as TrafficFrame,
      );
      return;
    }

    if (!isScoreboardWorkerResponse(message) || message.runId !== this.runId) {
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
      event instanceof ErrorEvent && event.message.trim().length > 0
        ? event.message
        : '';
    this.fail(
      detail
        ? `Live Scoreboard engine error: ${detail}`
        : 'The Live Scoreboard engine could not start.',
    );
  };

  private handleMessageError = (): void => {
    this.fail('The Live Scoreboard engine returned an unreadable message.');
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

  send(request: ScoreboardWorkerRequest): boolean {
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
  evaluation: ScoreboardEvaluation,
  digest: string,
  seed: number,
): boolean {
  return (
    evaluation.levelId === SCOREBOARD_LEVEL_ID &&
    evaluation.seed === seed &&
    evaluation.graphDigest === digest &&
    evaluation.identity.seed === seed &&
    evaluation.identity.graphDigest === digest
  );
}

export function createScoreboardRunController(
  options: ScoreboardRunControllerOptions = {},
): ScoreboardRunController {
  const createWorker = options.createWorker ?? createScoreboardWorker;
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  const totalTimeoutMs = options.totalTimeoutMs ?? 180_000;
  const cancelGraceMs = options.cancelGraceMs ?? 1_500;
  const maxTrafficFrames = options.maxTrafficFrames ?? MAX_TRAFFIC_FRAMES;

  let client: ScoreboardWorkerClient | null = null;
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
    const state = useScoreboardStore.getState();
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

  const start: ScoreboardRunController['start'] = ({ graph, seed }) => {
    disposeClient();
    clearCancelTimer();
    abortTraffic(ownedRunId);
    ownedRunId = null;

    const blocking = validateScoreboardGraph(graph).filter(
      (issue) => issue.severity === 'error',
    );
    if (blocking.length > 0) {
      useScoreboardStore.getState().blockRun(blocking);
      return;
    }

    const frozen = cloneScoreboardGraph(graph);
    const digest = scoreboardGraphDigest(frozen);
    const runId = nextRunId();
    ownedRunId = runId;
    useScoreboardStore.getState().beginRun({ runId, seed, digest });
    useTrafficStore.getState().beginRun({
      levelId: SCOREBOARD_TRAFFIC_LEVEL,
      runId,
      binding: `live-scoreboard|digest${digest}|seed${seed}`,
    });

    try {
      client = new ScoreboardWorkerClient(
        createWorker,
        runId,
        {
          onProgress: (message) => {
            if (!isCurrent(runId)) {
              return;
            }
            useScoreboardStore.getState().updateProgress(message.progress);
          },
          onResult: (message) => {
            if (!isCurrent(runId)) {
              return;
            }
            const parsed = parseScoreboardEvaluation(message.evaluation);
            if (!parsed.ok) {
              ownedRunId = null;
              abortTraffic(runId);
              useScoreboardStore
                .getState()
                .failRun(
                  parsed.issues[0]?.message ??
                    'The engine returned a result that does not match the Live Scoreboard contract.',
                );
              return;
            }
            const evaluation = parsed.value;
            if (!identityMatches(evaluation, digest, seed)) {
              ownedRunId = null;
              abortTraffic(runId);
              useScoreboardStore
                .getState()
                .failRun(
                  'The engine result does not match this graph, seed and run identity. It was rejected.',
                );
              return;
            }
            ownedRunId = null;
            clearCancelTimer();
            useScoreboardStore.getState().completeRun({
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
            useScoreboardStore.getState().failRun(message);
          },
          onTraffic: (frame) => {
            if (!isCurrent(runId)) {
              return;
            }
            useTrafficStore.getState().acceptFrame({
              levelId: SCOREBOARD_TRAFFIC_LEVEL,
              runId,
              frame,
            });
          },
        },
        { startTimeoutMs, totalTimeoutMs, maxTrafficFrames },
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
      abortTraffic(runId);
      if (isCurrent(runId)) {
        useScoreboardStore
          .getState()
          .failRun(
            'Could not start the evaluation engine. The graph is editable; try again.',
          );
      }
    }
  };

  const cancel: ScoreboardRunController['cancel'] = () => {
    const runId = ownedRunId;
    const state = useScoreboardStore.getState();
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
      useScoreboardStore.setState({ runPhase: 'stopping' });
    }
    client?.send({ type: 'cancel', runId });

    // The worker reports an incomplete result when it can. If no result arrives
    // within the grace period the run is cleared; it is never turned into a pass.
    clearCancelTimer();
    cancelTimer = setTimeout(() => {
      if (!isCurrent(runId)) {
        return;
      }
      disposeClient();
      ownedRunId = null;
      abortTraffic(runId);
      useScoreboardStore.getState().cancelRun();
    }, cancelGraceMs);
  };

  const dispose = () => {
    clearCancelTimer();
    disposeClient();
    const runId = ownedRunId;
    ownedRunId = null;
    abortTraffic(runId);
    if (runId) {
      const state = useScoreboardStore.getState();
      if (
        state.runId === runId &&
        (state.runPhase === 'running' || state.runPhase === 'stopping')
      ) {
        useScoreboardStore.getState().cancelRun();
      }
    }
  };

  return { start, cancel, dispose };
}
