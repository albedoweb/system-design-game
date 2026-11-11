import { DomainValidationError } from '../domain/errors';
import {
  cloneGraph,
  parseGraph,
  validateGraph,
  type GraphDocument,
} from '../domain/graph';
import {
  MAX_SEED,
  parseLevel,
  type LevelDefinition,
} from '../domain/level';
import type { SimulationEngine } from '../domain/worker';
import type { TrafficFrame } from '../simulation/traffic-telemetry';
import { compileScenario } from './compile';
import { Simulation, type SimulationStats } from './simulation';
import { SimulationInputError } from './errors';
import {
  generateOfferedTrace,
  validateOfferedTrace,
  type OfferedTrace,
} from './workload';

export type SimulationHandle = SimulationEngine & {
  readonly stats: SimulationStats;
  /** Read-only copy of the offered trace fixed at engine creation. */
  offeredTrace(): OfferedTrace;
  /**
   * Optional observational telemetry. Reports what already happened in the
   * interval ending at `untilMs`; it never advances the engine or affects a
   * result, and returns null for a non-advancing read.
   */
  trafficFrame(untilMs: number): TrafficFrame | null;
};

function copyLevel(level: LevelDefinition): LevelDefinition {
  try {
    return parseLevel(JSON.parse(JSON.stringify(level)) as unknown);
  } catch (error) {
    if (error instanceof DomainValidationError) {
      throw error;
    }
    throw new SimulationInputError(
      `Invalid level definition: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function prepareGraph(graph: GraphDocument): GraphDocument {
  const cloned = cloneGraph(parseGraph(graph));
  const issues = validateGraph(cloned, { mode: 'run' });
  if (issues.length > 0) {
    throw new DomainValidationError('The graph cannot be run', issues);
  }
  return cloned;
}

/**
 * Frozen engine entry point. Inputs are parsed and validated before any
 * simulation state exists; the offered trace depends only on the level and
 * seed, never on the graph.
 */
export function createSimulation(
  graph: GraphDocument,
  level: LevelDefinition,
  seed: number,
): SimulationHandle {
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new SimulationInputError(
      `Seed must be an integer in 0..${MAX_SEED}, received ${seed}`,
    );
  }
  const levelCopy = copyLevel(level);
  const graphCopy = prepareGraph(graph);
  const trace = generateOfferedTrace(levelCopy, seed);
  const scenario = compileScenario(graphCopy, levelCopy);
  return new Simulation(scenario, trace);
}

/**
 * Test hook: run an explicit offered trace. The trace still passes the same
 * bounds checks; production code should use `createSimulation`.
 */
export function createSimulationFromTrace(
  graph: GraphDocument,
  level: LevelDefinition,
  trace: OfferedTrace,
): SimulationHandle {
  const levelCopy = copyLevel(level);
  const graphCopy = prepareGraph(graph);
  validateOfferedTrace(trace, levelCopy);
  const scenario = compileScenario(graphCopy, levelCopy);
  return new Simulation(scenario, trace);
}

export { Simulation, MAX_EVENTS, type SimulationStats } from './simulation';
export { SimulationInputError, SimulationLimitError } from './errors';
export { nearestRank } from './metrics';
export {
  arrivalTimesFromHazards,
  generateOfferedTrace,
  validateOfferedTrace,
  type OfferedRequest,
  type OfferedTrace,
  type TrafficClass,
} from './workload';
