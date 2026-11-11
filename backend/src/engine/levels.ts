/**
 * Discovery metadata for all registered levels.
 *
 * Every value comes from the shared registry, which in turn imports the
 * authoritative frozen cores. The backend keeps no second copy of titles,
 * catalog prices, limits or graph rules.
 */

import {
  createEngineRegistry,
  type EngineRegistry,
} from '../../../src/simulation/registry.js';
import { EngineError, type LevelSummary } from '../contracts.js';

/** Default registry used by the backend. Image evaluation requires I101 wiring. */
export function createBackendRegistry(): EngineRegistry {
  return createEngineRegistry();
}

export function levelSummaries(
  registry: EngineRegistry,
): readonly LevelSummary[] {
  return registry.levels().map((level) => ({
    id: level.id,
    title: level.title,
    description: level.description,
    defaultSeed: level.defaultSeed,
    horizons: level.horizons === undefined ? [] : [...level.horizons],
  }));
}

export function requireLevel(
  registry: EngineRegistry,
  levelId: string,
): void {
  if (registry.resolve(levelId) === null) {
    throw new EngineError('level_not_found', 'Level not found.', 404);
  }
}

export function requireSeed(
  registry: EngineRegistry,
  levelId: string,
  seed: number,
): void {
  const entry = registry.resolve(levelId);
  if (entry === null) {
    throw new EngineError('level_not_found', 'Level not found.', 404);
  }
  const { min, max } = entry.descriptor.seed;
  if (!Number.isInteger(seed) || seed < min || seed > max) {
    throw new EngineError(
      'invalid_seed',
      `Seed for ${levelId} must be an integer in ${min}..${max}.`,
      400,
    );
  }
}

export function levelDescription(
  registry: EngineRegistry,
  levelId: string,
): unknown {
  requireLevel(registry, levelId);
  return registry.describe(levelId);
}

export function levelComponents(
  registry: EngineRegistry,
  levelId: string,
): unknown {
  requireLevel(registry, levelId);
  return registry.components(levelId);
}

export function levelSchema(
  registry: EngineRegistry,
  levelId: string,
): unknown {
  requireLevel(registry, levelId);
  return registry.graphSchema(levelId);
}
