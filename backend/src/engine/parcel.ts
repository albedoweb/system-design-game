/**
 * Authoritative Parcel Pulse metadata for the backend adapter.
 *
 * Every value here comes from the shared P200 core. The backend keeps no
 * second copy of level titles, catalog prices, limits or graph rules.
 */

import {
  PARCEL_LEVEL,
  PARCEL_MAX_SEED,
  describeParcelLevel,
  parcelCatalogPayload,
  parcelGraphJsonSchema,
} from '../../../src/parcel/index.js';

import { EngineError, type LevelSummary } from '../contracts.js';

export function parcelLevels(): readonly LevelSummary[] {
  return [
    {
      id: PARCEL_LEVEL.id,
      title: PARCEL_LEVEL.title,
      description: PARCEL_LEVEL.description,
      defaultSeed: PARCEL_LEVEL.defaultSeed,
      horizons: [...PARCEL_LEVEL.horizons],
    },
  ];
}

export function requireParcelLevel(levelId: string): void {
  if (levelId !== PARCEL_LEVEL.id) {
    throw new EngineError('level_not_found', 'Level not found.', 404);
  }
}

export function requireParcelSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > PARCEL_MAX_SEED) {
    throw new EngineError(
      'invalid_seed',
      `Seed must be an integer in 0..${PARCEL_MAX_SEED}.`,
      400,
    );
  }
}

export function parcelDescription(levelId: string): unknown {
  requireParcelLevel(levelId);
  return describeParcelLevel();
}

export function parcelComponents(levelId: string): unknown {
  requireParcelLevel(levelId);
  return parcelCatalogPayload();
}

export function parcelSchema(levelId: string): unknown {
  requireParcelLevel(levelId);
  return parcelGraphJsonSchema();
}
