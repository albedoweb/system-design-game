import type {
  SimulationSpeed,
  WorkerCommand,
  WorkerMessage,
} from '../domain/worker';
import { createSimulation, type SimulationHandle } from '../engine';
import { trafficSampleStepMs } from '../engine/trafficSampling';


export const PACKAGE_MS = 100;
const SNAPSHOT_EVERY_PACKAGES = (speed: SimulationSpeed) => speed;

export interface WorkerTimerApi {
  set: (callback: () => void, delayMs: number) => unknown;
  clear: (handle: unknown) => void;
}

const defaultTimers: WorkerTimerApi = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export interface SimulationWorkerRuntime {
  handleCommand(command: WorkerCommand): void;
  dispose(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Worker state machine without any `self`/`postMessage` dependency, so it can
 * be exercised in Node. The browser entry point only wires messages in and out.
 */
export function createSimulationWorkerRuntime(
  post: (message: WorkerMessage) => void,
  timers: WorkerTimerApi = defaultTimers,
): SimulationWorkerRuntime {
  let runId: string | null = null;
  let engine: SimulationHandle | null = null;
  let timer: unknown = null;
  let speed: SimulationSpeed = 1;
  let paused = false;
  let stopped = true;
  let resultSent = false;
  let virtualTime = 0;
  let endTime = 0;
  let packagesSinceSnapshot = 0;
  let trafficStep = 0;
  let nextTrafficAt: number | null = null;
  let lastTrafficAt = 0;

  function cancelTimer(): void {
    if (timer !== null) {
      timers.clear(timer);
      timer = null;
    }
  }

  function fail(error: unknown): void {
    cancelTimer();
    stopped = true;
    engine = null;
    if (runId !== null) {
      post({ type: 'error', runId, message: errorMessage(error) });
    }
  }

  function scheduleNext(): void {
    if (paused || stopped || !engine || engine.done || timer !== null) {
      return;
    }
    cancelTimer();
    timer = timers.set(() => {
      timer = null;
      tick();
    }, PACKAGE_MS / speed);
  }

  function tick(): void {
    if (paused || stopped || !engine) {
      return;
    }
    try {
      let next = Math.min(virtualTime + PACKAGE_MS, endTime);
      if (nextTrafficAt !== null && nextTrafficAt <= next) {
        next = nextTrafficAt;
      }
      const snapshot = engine.advance(next);
      virtualTime = next;
      if (nextTrafficAt !== null && virtualTime >= nextTrafficAt) {
        emitTraffic(virtualTime);
        nextTrafficAt += trafficStep;
      }
      packagesSinceSnapshot += 1;
      if (packagesSinceSnapshot >= SNAPSHOT_EVERY_PACKAGES(speed)) {
        packagesSinceSnapshot = 0;
        post({ type: 'snapshot', runId: runId ?? '', snapshot });
      }
      if (engine.done) {
        if (virtualTime > lastTrafficAt) {
          emitTraffic(virtualTime);
        }
        if (!resultSent) {
          resultSent = true;
          post({ type: 'result', runId: runId ?? '', result: engine.result() });
        }
        return;
      }
      scheduleNext();
    } catch (error) {
      fail(error);
    }
  }

  /** Optional observational frame; never part of the run result. */
  function emitTraffic(atMs: number): void {
    if (!engine || runId === null) {
      return;
    }
    const frame = engine.trafficFrame(atMs);
    if (!frame) {
      return;
    }
    lastTrafficAt = atMs;
    post({ type: 'traffic', runId, frame });
  }

  function start(command: WorkerCommand & { type: 'start' }): void {
    cancelTimer();
    runId = command.runId;
    engine = null;
    paused = false;
    stopped = false;
    resultSent = false;
    packagesSinceSnapshot = 0;
    speed = command.speed;
    virtualTime = 0;
    endTime = 0;
    trafficStep = 0;
    nextTrafficAt = null;
    lastTrafficAt = 0;

    try {
      if (
        command.speed !== 1 &&
        command.speed !== 4 &&
        command.speed !== 16
      ) {
        throw new Error(`Invalid speed ${String(command.speed)}`);
      }
      const created = createSimulation(command.graph, command.level, command.seed);
      engine = created;
      virtualTime = -command.level.warmupMs;
      endTime = command.level.durationMs + command.level.drainMs;
      const scope = {
        levelId: 'cold-cache' as const,
        scopeId: 'cold-cache',
        scopeLabel: command.level.title,
        startMs: virtualTime,
        measuredFromMs: 0,
        measuredEndMs: command.level.durationMs,
        drainEndMs: endTime,
        postludeEndMs: endTime,
      };
      trafficStep = trafficSampleStepMs(scope);
      nextTrafficAt = virtualTime + trafficStep;
      lastTrafficAt = virtualTime;
      scheduleNext();
    } catch (error) {
      fail(error);
    }
  }

  function handleCommand(command: WorkerCommand): void {
    if (!isRecord(command) || typeof command.runId !== 'string') {
      return;
    }
    if (command.type === 'start') {
      start(command);
      return;
    }
    if (runId === null || command.runId !== runId) {
      return;
    }

    switch (command.type) {
      case 'pause':
        if (engine && !engine.done && !stopped && !paused) {
          cancelTimer();
          paused = true;
          post({ type: 'paused', runId });
        }
        break;
      case 'resume':
        if (engine && !engine.done && !stopped && paused) {
          paused = false;
          post({ type: 'resumed', runId });
          scheduleNext();
        }
        break;
      case 'speed':
        if (command.speed === 1 || command.speed === 4 || command.speed === 16) {
          speed = command.speed;
          if (!paused && !stopped && engine && !engine.done) {
            cancelTimer();
            scheduleNext();
          }
        }
        break;
      case 'stop':
        cancelTimer();
        stopped = true;
        paused = false;
        engine = null;
        post({ type: 'stopped', runId });
        break;
      default:
        break;
    }
  }

  function dispose(): void {
    cancelTimer();
    stopped = true;
    engine = null;
  }

  return { handleCommand, dispose };
}
