import type { GraphDocument } from './graph';
import type { LevelDefinition } from './level';
import type { RunResult, SimulationSnapshot } from './simulation';
import type { TrafficMessage } from '../simulation/traffic-telemetry';

/**
 * Worker wire protocol and engine contract (documentation + types only).
 * The engine/worker implementation lives in V101; UI code in V102. Every
 * message carries the `runId` so stale runs can be ignored.
 *
 * Runtime workload cap is an engine obligation, not a domain check: the domain
 * only bounds the **expected** Poisson arrivals. Before scheduling each request
 * the engine must count realized arrivals (including warmup) against
 * `MAX_ARRIVALS` (500,000) and terminate with the stable `workloadLimit`
 * outcome instead of silently dropping requests.
 */

/** Playback speed only; it must not change simulation results. */
export type SimulationSpeed = 1 | 4 | 16;

interface CommandBase {
  runId: string;
}

export interface StartCommand extends CommandBase {
  type: 'start';
  graph: GraphDocument;
  level: LevelDefinition;
  seed: number;
  speed: SimulationSpeed;
}

export interface PauseCommand extends CommandBase {
  type: 'pause';
}

export interface ResumeCommand extends CommandBase {
  type: 'resume';
}

export interface SpeedCommand extends CommandBase {
  type: 'speed';
  speed: SimulationSpeed;
}

export interface StopCommand extends CommandBase {
  type: 'stop';
}

export type WorkerCommand =
  | StartCommand
  | PauseCommand
  | ResumeCommand
  | SpeedCommand
  | StopCommand;

interface MessageBase {
  runId: string;
}

export interface SnapshotMessage extends MessageBase {
  type: 'snapshot';
  snapshot: SimulationSnapshot;
}

export interface ResultMessage extends MessageBase {
  type: 'result';
  result: RunResult;
}

export interface ErrorMessage extends MessageBase {
  type: 'error';
  message: string;
}

export interface PausedMessage extends MessageBase {
  type: 'paused';
}

export interface ResumedMessage extends MessageBase {
  type: 'resumed';
}

export interface StoppedMessage extends MessageBase {
  type: 'stopped';
}

export type WorkerMessage =
  | SnapshotMessage
  | ResultMessage
  | ErrorMessage
  | PausedMessage
  | ResumedMessage
  | StoppedMessage
  | TrafficMessage;

/**
 * Engine contract for `createSimulation(graph, level, seed)`:
 *
 * - `advance(untilMs)` takes evaluation-relative time and returns the snapshot
 *   at that time; `untilMs` is monotonic and must not exceed
 *   `durationMs + drainMs`.
 * - `result()` returns the final `RunResult`; calling it before `done` throws.
 * - `done` becomes true once the final snapshot (`durationMs + drainMs`) has
 *   been produced.
 * - The engine is pure TS and must not import React/DOM.
 */
export interface SimulationEngine {
  readonly done: boolean;
  advance(untilMs: number): SimulationSnapshot;
  result(): RunResult;
}

export type CreateSimulation = (
  graph: GraphDocument,
  level: LevelDefinition,
  seed: number,
) => SimulationEngine;

/**
 * Worker module path relative to the V102 adapter file in
 * `src/features/simulation/` (two directories below `src`), resolving to
 * `src/workers/simulation.worker.ts`.
 *
 * This constant is documentation only: Vite can statically bundle only a
 * literal URL, so the adapter must inline it, e.g.
 * `new Worker(new URL('../../workers/simulation.worker.ts', import.meta.url), { type: 'module' })`.
 */
export const SIMULATION_WORKER_PATH = '../../workers/simulation.worker.ts';
