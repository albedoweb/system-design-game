import type { LevelDefinition, RunResult } from '../domain';

export interface BestLocalResult {
  costMicroUsdPerHour: number;
  readP95Ms: number | null;
  achievedAt: string;
}

export type BestReadResult =
  | { best: BestLocalResult | null; error: string | null };

function bestKey(level: LevelDefinition, seed: number): string {
  return [
    'sdg:best',
    level.id,
    level.contentVersion,
    level.modelVersion,
    level.pricingVersion,
    `seed-${seed}`,
  ].join(':');
}

function parseBest(raw: string): BestLocalResult | null {
  try {
    const value = JSON.parse(raw) as Partial<BestLocalResult>;
    if (
      typeof value.costMicroUsdPerHour !== 'number' ||
      !Number.isFinite(value.costMicroUsdPerHour)
    ) {
      return null;
    }
    return {
      costMicroUsdPerHour: value.costMicroUsdPerHour,
      readP95Ms:
        typeof value.readP95Ms === 'number' && Number.isFinite(value.readP95Ms)
          ? value.readP95Ms
          : null,
      achievedAt:
        typeof value.achievedAt === 'string'
          ? value.achievedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function readBestLocal(
  storage: Storage | null,
  level: LevelDefinition,
  seed: number,
): BestReadResult {
  if (!storage) {
    return { best: null, error: null };
  }
  try {
    const raw = storage.getItem(bestKey(level, seed));
    return { best: raw === null ? null : parseBest(raw), error: null };
  } catch {
    return {
      best: null,
      error: 'Could not read the local best result.',
    };
  }
}

export function recordBestLocal(
  storage: Storage | null,
  level: LevelDefinition,
  result: RunResult,
): { best: BestLocalResult | null; isNewBest: boolean; error: string | null } {
  const current = readBestLocal(storage, level, result.seed);
  if (!result.passed) {
    return { best: current.best, isNewBest: false, error: current.error };
  }
  if (!storage) {
    return {
      best: current.best,
      isNewBest: false,
      error: 'Local storage is unavailable — the result was not saved.',
    };
  }

  const candidate: BestLocalResult = {
    costMicroUsdPerHour: result.costMicroUsdPerHour,
    readP95Ms: result.snapshot.reads.p95Ms,
    achievedAt: new Date().toISOString(),
  };
  const isBetter =
    current.best === null ||
    candidate.costMicroUsdPerHour < current.best.costMicroUsdPerHour ||
    (candidate.costMicroUsdPerHour === current.best.costMicroUsdPerHour &&
      (candidate.readP95Ms ?? Number.POSITIVE_INFINITY) <
        (current.best.readP95Ms ?? Number.POSITIVE_INFINITY));

  if (!isBetter) {
    return { best: current.best, isNewBest: false, error: current.error };
  }

  try {
    storage.setItem(bestKey(level, result.seed), JSON.stringify(candidate));
    return { best: candidate, isNewBest: true, error: null };
  } catch {
    return {
      best: current.best,
      isNewBest: false,
      error: 'Could not save the local best result.',
    };
  }
}

export function bestLocalLabel(level: LevelDefinition, seed: number): string {
  return `seed ${seed} · content ${level.contentVersion} · model ${level.modelVersion} · pricing ${level.pricingVersion}`;
}
