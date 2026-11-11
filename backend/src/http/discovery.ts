import {
  EngineError,
  ERROR_CODES,
  LIMITS,
  MAX_SEED,
  MIN_SEED,
  type Engine,
  type LevelSummary,
} from '../contracts.js';

const LEVEL_ID = new RegExp(LIMITS.levelIdPattern);

function engineContractError(): EngineError {
  return new EngineError(
    'engine_contract',
    'The engine returned invalid discovery metadata.',
    503,
  );
}

function unavailable(error: unknown): EngineError {
  if (error instanceof EngineError) {
    return error;
  }
  return new EngineError(
    ERROR_CODES.engineUnavailable,
    'The simulation engine is unavailable.',
    503,
  );
}

function validateLevels(value: unknown): readonly LevelSummary[] {
  if (!Array.isArray(value)) {
    throw engineContractError();
  }
  const seen = new Set<string>();
  const levels: LevelSummary[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      throw engineContractError();
    }
    const record = item as Record<string, unknown>;
    const id = record.id;
    const title = record.title;
    const description = record.description;
    const defaultSeed = record.defaultSeed;
    const horizons = record.horizons;
    if (
      typeof id !== 'string' ||
      !LEVEL_ID.test(id) ||
      seen.has(id) ||
      typeof title !== 'string' ||
      typeof description !== 'string' ||
      typeof defaultSeed !== 'number' ||
      !Number.isInteger(defaultSeed) ||
      defaultSeed < MIN_SEED ||
      defaultSeed > MAX_SEED ||
      !Array.isArray(horizons) ||
      horizons.some(
        (horizon) => typeof horizon !== 'number' || !Number.isFinite(horizon),
      )
    ) {
      throw engineContractError();
    }
    seen.add(id);
    levels.push({
      id,
      title,
      description,
      defaultSeed,
      horizons: horizons as number[],
    });
  }
  return levels;
}

/**
 * Per-app discovery cache. Metadata is trusted engine data and does not change
 * during a process lifetime; a failed load is removed so a later GET can retry.
 */
export class DiscoveryCache {
  private readonly engine: Engine;
  private levelsPromise: Promise<readonly LevelSummary[]> | null = null;
  private readonly payloads = new Map<string, Promise<unknown>>();

  constructor(engine: Engine) {
    this.engine = engine;
  }

  levels(): Promise<readonly LevelSummary[]> {
    if (this.levelsPromise === null) {
      this.levelsPromise = Promise.resolve()
        .then(() => this.engine.levels())
        .then(
          (value) => {
            try {
              return validateLevels(value);
            } catch (error) {
              this.levelsPromise = null;
              throw unavailable(error);
            }
          },
          (error: unknown) => {
            this.levelsPromise = null;
            throw unavailable(error);
          },
        );
    }
    return this.levelsPromise;
  }

  async requireLevel(levelId: string): Promise<void> {
    const levels = await this.levels();
    if (!levels.some((level) => level.id === levelId)) {
      throw new EngineError('level_not_found', 'Level not found.', 404);
    }
  }

  describe(levelId: string): Promise<unknown> {
    return this.cached('describe', levelId, () => this.engine.describe(levelId));
  }

  components(levelId: string): Promise<unknown> {
    return this.cached('components', levelId, () =>
      this.engine.components(levelId),
    );
  }

  schema(levelId: string): Promise<unknown> {
    return this.cached('schema', levelId, () => this.engine.schema(levelId));
  }

  private cached(
    kind: 'describe' | 'components' | 'schema',
    levelId: string,
    load: () => Promise<unknown>,
  ): Promise<unknown> {
    const key = `${kind}:${levelId}`;
    const existing = this.payloads.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const promise = Promise.resolve()
      .then(load)
      .catch((error: unknown) => {
        this.payloads.delete(key);
        throw unavailable(error);
      });
    this.payloads.set(key, promise);
    return promise;
  }
}
