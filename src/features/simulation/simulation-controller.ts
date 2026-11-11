import {
  calculateCost,
  cloneGraph,
  validateGraph,
  type GraphDocument,
  type LevelDefinition,
  type SimulationSpeed,
  type WorkerCommand,
} from '../../domain';
import { getBrowserStorage } from '../persistence/draft-storage';
import { readBestLocal, recordBestLocal } from '../../state/local-best';
import { useEditorStore } from '../../state/editor-store';
import { useSessionStore } from '../../state/session-store';
import { useTrafficStore } from '../traffic/traffic-store';
import { createSimulationWorker } from './worker-factory';
import {
  SimulationWorkerClient,
  type WorkerFactory,
} from './worker-client';

export interface StartSimulationInput {
  graph: GraphDocument;
  level: LevelDefinition;
  seed: number;
}

export interface SimulationController {
  start: (input: StartSimulationInput) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  setSpeed: (speed: SimulationSpeed) => void;
  dispose: () => void;
}

export interface SimulationControllerOptions {
  createWorker?: WorkerFactory;
  storage?: Storage | null;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

let runCounter = 0;

function nextRunId(): string {
  runCounter += 1;
  return `run-${Date.now().toString(36)}-${runCounter}`;
}

export function createSimulationController(
  options: SimulationControllerOptions = {},
): SimulationController {
  const createWorker = options.createWorker ?? createSimulationWorker;
  const storage =
    options.storage === undefined ? getBrowserStorage() : options.storage;
  const startTimeoutMs = options.startTimeoutMs ?? 5_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 1_000;

  let client: SimulationWorkerClient | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let ownedTrafficRunId: string | null = null;
  const clearStopTimer = () => {
    if (stopTimer !== null) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
  };

  const disposeClient = () => {
    client?.dispose();
    client = null;
    clearStopTimer();
  };

  const send = (command: WorkerCommand): void => {
    client?.send(command);
  };

  const start: SimulationController['start'] = ({
    graph,
    level,
    seed,
  }) => {
    disposeClient();
    // A new run starts from a clean telemetry buffer: no old live frames or
    // replay may survive into a different run or graph identity.
    const previousTraffic = useTrafficStore.getState();
    if (previousTraffic.run?.levelId === level.id) {
      previousTraffic.abortRun(previousTraffic.run.runId);
    }
    ownedTrafficRunId = null;
    const session = useSessionStore.getState();
    const issues = validateGraph(graph, { mode: 'run' });
    if (issues.length > 0) {
      useSessionStore.setState({
        phase: 'error',
        runId: null,
        error: `The graph is not ready to run: ${
          issues[0] ? issues[0].message : 'there are validation issues'
        }`,
        notice: null,
        result: null,
        resultRevision: null,
        snapshotRevision: null,
        snapshotSeed: null,
        isNewBest: false,
      });
      return;
    }

    const runId = nextRunId();
    const frozenGraph = cloneGraph(graph);
    const frozenCost = calculateCost(frozenGraph);
    const bestRead = readBestLocal(storage, level, seed);
    // Freshness of the eventual result belongs to the graph revision that was
    // actually sent to the worker. Reading the live store revision when the
    // result arrives would let edits made during the stop race mark a stale
    // result as current.
    const runConfigRevision = useEditorStore.getState().configRevision;
    ownedTrafficRunId = runId;
    useTrafficStore.getState().beginRun({
      levelId: level.id,
      runId,
      binding: `${level.id}|rev${runConfigRevision}|seed${seed}`,
    });

    useSessionStore.setState({
      phase: 'starting',
      runId,
      seed,
      snapshot: null,
      result: null,
      resultRevision: null,
      snapshotRevision: runConfigRevision,
      snapshotSeed: seed,
      error: null,
      notice: null,
      frozenCostMicroUsdPerHour: frozenCost,
      best: bestRead.best,
      bestError: bestRead.error,
      isNewBest: false,
    });

    try {
      client = new SimulationWorkerClient(
        createWorker,
        runId,
        {
          onSnapshot: (snapshot) => {
            if (useSessionStore.getState().runId !== runId) {
              return;
            }
            useSessionStore.setState((state) => ({
              snapshot,
              phase:
                state.phase === 'paused'
                  ? 'paused'
                  : state.phase === 'stopping'
                    ? 'stopping'
                    : 'running',
            }));
          },
          onResult: (result) => {
            if (useSessionStore.getState().runId !== runId) {
              return;
            }
            clearStopTimer();
            const best = recordBestLocal(storage, level, result);
            client = null;
            useTrafficStore.getState().completeRun(runId);
            useSessionStore.setState({
              phase: 'completed',
              result,
              snapshot: result.snapshot,
              resultRevision: runConfigRevision,
              error: null,
              notice: null,
              best: best.best,
              bestError: best.error,
              isNewBest: best.isNewBest,
            });
          },
          onPaused: () => {
            if (useSessionStore.getState().runId !== runId) {
              return;
            }
            useTrafficStore.getState().pauseLive(runId);
            useSessionStore.setState({ phase: 'paused' });
          },
          onResumed: () => {
            if (useSessionStore.getState().runId !== runId) {
              return;
            }
            useTrafficStore.getState().resumeLive(runId);
            useSessionStore.setState({ phase: 'running' });
          },
          onStopped: () => {
            if (useSessionStore.getState().runId !== runId) {
              return;
            }
            clearStopTimer();
            client = null;
            ownedTrafficRunId = null;
            useTrafficStore.getState().abortRun(runId);
            useSessionStore.setState({
              phase: 'stopped',
              error: null,
              notice: 'The run was stopped. The graph is unlocked.',
            });
          },
          onError: (message) => {
            if (useSessionStore.getState().runId !== runId) {
              return;
            }
            clearStopTimer();
            client = null;
            ownedTrafficRunId = null;
            useTrafficStore.getState().abortRun(runId);
            useSessionStore.setState({
              phase: 'error',
              error: message,
              notice: null,
            });
          },
          onTraffic: (frame) => {
            if (useSessionStore.getState().runId !== runId) {
              return;
            }
            useTrafficStore.getState().acceptFrame({
              levelId: level.id,
              runId,
              frame,
            });
          },
        },
        startTimeoutMs,
      );
      send({
        type: 'start',
        runId,
        graph: frozenGraph,
        level,
        seed,
        speed: session.speed,
      });
    } catch {
      disposeClient();
      ownedTrafficRunId = null;
      useTrafficStore.getState().abortRun(runId);
      useSessionStore.setState({
        phase: 'error',
        error:
          'Could not create the simulation engine. The graph is still editable; you can try again.',
        notice: null,
      });
    }
  };

  const pause = () => {
    const state = useSessionStore.getState();
    if (state.phase !== 'running' || !state.runId) {
      return;
    }
    useTrafficStore.getState().pauseLive(state.runId);
    useSessionStore.setState({ phase: 'paused', notice: null });
    send({ type: 'pause', runId: state.runId });
  };

  const resume = () => {
    const state = useSessionStore.getState();
    if (state.phase !== 'paused' || !state.runId) {
      return;
    }
    useTrafficStore.getState().resumeLive(state.runId);
    useSessionStore.setState({ phase: 'running', notice: null });
    send({ type: 'resume', runId: state.runId });
  };

  const stop = () => {
    const state = useSessionStore.getState();
    if (!client || !state.runId) {
      disposeClient();
      if (ownedTrafficRunId) {
        useTrafficStore.getState().abortRun(ownedTrafficRunId);
      }
      ownedTrafficRunId = null;
      useSessionStore.setState({
        phase: 'stopped',
        notice: 'The run was stopped.',
      });
      return;
    }
    clearStopTimer();
    ownedTrafficRunId = null;
    useTrafficStore.getState().abortRun(state.runId);
    send({ type: 'stop', runId: state.runId });
    useSessionStore.setState({
      phase: 'stopping',
      notice: 'Stopping the run…',
    });
    stopTimer = setTimeout(() => {
      disposeClient();
      if (ownedTrafficRunId) {
        useTrafficStore.getState().abortRun(ownedTrafficRunId);
        ownedTrafficRunId = null;
      }
      useSessionStore.setState({
        phase: 'stopped',
        notice: 'The run was stopped. The graph is unlocked.',
      });
    }, stopTimeoutMs);
  };

  const setSpeed = (speed: SimulationSpeed) => {
    useSessionStore.setState({ speed });
    const state = useSessionStore.getState();
    if (state.runId && client) {
      client.setSpeed(speed);
    }
  };

  const dispose = () => {
    disposeClient();
    if (ownedTrafficRunId) {
      useTrafficStore.getState().abortRun(ownedTrafficRunId);
    }
    ownedTrafficRunId = null;
  };

  return { start, pause, resume, stop, setSpeed, dispose };
}
