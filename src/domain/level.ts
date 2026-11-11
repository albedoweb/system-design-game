import { z } from 'zod';

import levelJson from '../../public/levels/cold-cache.json';
import { SUPPORTED_PRICING_VERSION } from './catalog';
import {
  DomainValidationError,
  issuesFromSchemaError,
  utf8ByteLength,
  type ValidationIssue,
} from './errors';
import { deepFreeze } from './freeze';
import { MAX_INPUT_BYTES } from './limits';

/**
 * Strict level definition. Every number the engine needs comes from here (or
 * from the frozen catalog); engine code must not hardcode level conditions.
 * JSON (`public/levels/cold-cache.json`) is the source of `DEFAULT_LEVEL`.
 */

export const MAX_LEVEL_DURATION_MS = 120_000;
export const MAX_RPS = 10_000;
export const MAX_KEY_SPACE = 100_000;

/**
 * Bound on **expected** Poisson arrivals (mean) over warmup + evaluation.
 *
 * This is an expected-workload guard for level validation only. It is not a
 * cap on realized arrivals: a Poisson stream may exceed its mean. The engine
 * (V101) must enforce the runtime cap on realized arrivals, including warmup,
 * before scheduling each request and terminate with the stable `workloadLimit`
 * outcome instead of silently dropping work. Domain validation cannot prove
 * that a runtime cap was respected.
 */
export const MAX_ARRIVALS = 500_000;

export const MAX_SEED = 0xffff_ffff;

/**
 * Engine/model revision this domain contract was written for. Levels that
 * declare another model version are rejected rather than silently evaluated
 * with different semantics.
 */
export const SUPPORTED_MODEL_VERSION = '1.0.0';

export interface SchedulePoint {
  /** Evaluation-relative time at which `rps` becomes effective. */
  atMs: number;
  /** Mean arrivals per second (Poisson stream). */
  rps: number;
}

export interface ReadWorkload {
  schedule: SchedulePoint[];
  keySpace: number;
  hotCount: number;
  hotProbability: number;
}

export interface WriteWorkload {
  schedule: SchedulePoint[];
  keySpace: number;
}

export interface LevelWorkloads {
  read: ReadWorkload;
  write: WriteWorkload;
}

export interface LevelTiming {
  /** External RTT, 5 ms in + 5 ms out in the shipped level. */
  clientRttMs: number;
  /** Per internal edge, 1 ms each way. */
  edgeRttMs: number;
  appCpuMs: number;
  cacheLookupMs: number;
  dbReadMs: number;
  dbWriteMs: number;
  lbMs: number;
  invalidationMs: number;
}

export interface LevelSlo {
  /** Fraction 0..1; player-facing checks report percentages 0..100. */
  availability: number;
  readP95Ms: number;
  writeP95Ms: number;
  /** Critical cohort is selected by logical arrival time, evaluation-relative. */
  criticalFromMs: number;
  criticalToMs: number;
  criticalAvailability: number;
  criticalReadP95Ms: number;
  criticalWriteP95Ms: number;
}

/** References frozen with the level so results are only compared on equal inputs. */
export interface LevelRefs {
  pricingCatalog: string;
  calibrationSeeds: number[];
  holdoutSeeds: number[];
}

export interface LevelDefinition {
  schemaVersion: 1;
  contentVersion: string;
  /** Must equal `SUPPORTED_MODEL_VERSION`; other models are rejected. */
  modelVersion: string;
  /** Must equal `SUPPORTED_PRICING_VERSION`; other catalogs are rejected. */
  pricingVersion: string;
  id: 'cold-cache';
  title: string;
  description: string;
  durationMs: number;
  /** Warmup arrivals are generated but excluded from every score denominator. */
  warmupMs: number;
  /** Content flush at this evaluation-relative time, or null for no flush. */
  flushAtMs: number | null;
  /** Time after generation stops for remaining logical requests. */
  drainMs: number;
  /** Global deadline from logical arrival. */
  deadlineMs: number;
  budgetMicroUsdPerHour: number;
  workloads: LevelWorkloads;
  timing: LevelTiming;
  slo: LevelSlo;
  defaultSeed: number;
  refs: LevelRefs;
}

const versionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'expected a version like 1.0.0')
  .max(64);

const schedulePointSchema = z.strictObject({
  atMs: z.number().int().min(0).max(MAX_LEVEL_DURATION_MS),
  rps: z.number().min(0).max(MAX_RPS),
});

const scheduleSchema = z
  .array(schedulePointSchema)
  .min(1, 'schedule cannot be empty')
  .max(64);

const timingEntry = z.number().min(0).max(5_000);

const timingSchema = z.strictObject({
  clientRttMs: timingEntry,
  edgeRttMs: timingEntry,
  appCpuMs: timingEntry,
  cacheLookupMs: timingEntry,
  dbReadMs: timingEntry,
  dbWriteMs: timingEntry,
  lbMs: timingEntry,
  invalidationMs: timingEntry,
});

const seedSchema = z.number().int().min(0).max(MAX_SEED);

const workloadBase = {
  schedule: scheduleSchema,
  keySpace: z.number().int().min(1).max(MAX_KEY_SPACE),
};

const readWorkloadSchema = z.strictObject({
  ...workloadBase,
  hotCount: z.number().int().min(1).max(MAX_KEY_SPACE),
  hotProbability: z.number().min(0).max(1),
});

const writeWorkloadSchema = z.strictObject(workloadBase);

const sloSchema = z.strictObject({
  availability: z.number().gt(0).max(1),
  readP95Ms: z.number().gt(0).max(MAX_LEVEL_DURATION_MS),
  writeP95Ms: z.number().gt(0).max(MAX_LEVEL_DURATION_MS),
  criticalFromMs: z.number().int().min(0).max(MAX_LEVEL_DURATION_MS),
  criticalToMs: z.number().int().min(0).max(MAX_LEVEL_DURATION_MS),
  criticalAvailability: z.number().gt(0).max(1),
  criticalReadP95Ms: z.number().gt(0).max(MAX_LEVEL_DURATION_MS),
  criticalWriteP95Ms: z.number().gt(0).max(MAX_LEVEL_DURATION_MS),
});

export const levelDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  contentVersion: versionSchema,
  modelVersion: versionSchema,
  pricingVersion: z.string().min(1).max(64),
  id: z.literal('cold-cache'),
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(2_000),
  durationMs: z.number().int().gt(0).max(MAX_LEVEL_DURATION_MS),
  warmupMs: z.number().int().min(0).max(MAX_LEVEL_DURATION_MS),
  flushAtMs: z.number().int().min(0).max(MAX_LEVEL_DURATION_MS).nullable(),
  drainMs: z.number().int().min(0).max(MAX_LEVEL_DURATION_MS),
  deadlineMs: z.number().int().gt(0).max(MAX_LEVEL_DURATION_MS),
  budgetMicroUsdPerHour: z.number().int().gt(0).max(100_000_000),
  workloads: z.strictObject({
    read: readWorkloadSchema,
    write: writeWorkloadSchema,
  }),
  timing: timingSchema,
  slo: sloSchema,
  defaultSeed: seedSchema,
  refs: z.strictObject({
    pricingCatalog: z.string().min(1).max(64),
    calibrationSeeds: z.array(seedSchema).min(1).max(32),
    holdoutSeeds: z.array(seedSchema).max(32),
  }),
});

/**
 * Expected arrivals from a piecewise-constant Poisson schedule in `[fromMs, toMs)`.
 * Used for the 500k event-budget bound and for briefing explanations.
 */
export function expectedArrivals(
  schedule: readonly SchedulePoint[],
  fromMs: number,
  toMs: number,
): number {
  let total = 0;
  for (let index = 0; index < schedule.length; index += 1) {
    const point = schedule[index];
    if (!point) {
      continue;
    }
    const next = schedule[index + 1];
    const windowStart = Math.max(point.atMs, fromMs);
    const windowEnd = Math.min(next ? next.atMs : toMs, toMs);
    if (windowEnd > windowStart) {
      total += (point.rps * (windowEnd - windowStart)) / 1000;
    }
  }
  return total;
}

function checkSchedule(
  name: string,
  schedule: readonly SchedulePoint[],
  durationMs: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const first = schedule[0];
  if (!first || first.atMs !== 0) {
    issues.push({
      code: 'level-schedule',
      message: `The ${name} schedule must start at atMs = 0`,
    });
  }
  for (let index = 1; index < schedule.length; index += 1) {
    const previous = schedule[index - 1];
    const current = schedule[index];
    if (!previous || !current) {
      continue;
    }
    if (current.atMs <= previous.atMs) {
      issues.push({
        code: 'level-schedule',
        message: `The ${name} schedule must increase: ${current.atMs} ms after ${previous.atMs} ms`,
      });
    }
  }
  for (const point of schedule) {
    if (point.atMs >= durationMs) {
      issues.push({
        code: 'level-schedule',
        message: `${name} schedule point (${point.atMs} ms) must be before the end of the evaluation`,
      });
    }
  }
  return issues;
}

/**
 * Coherence checks that sit on top of the strict JSON schema. Structural
 * schema problems are raised by `parseLevel`; this function is also exported
 * for callers that build a level object in code.
 */
export function validateLevel(level: LevelDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { workloads, slo } = level;

  if (level.modelVersion !== SUPPORTED_MODEL_VERSION) {
    issues.push({
      code: 'unsupported-version',
      message: `Model version ${level.modelVersion} is not supported; available version is ${SUPPORTED_MODEL_VERSION}`,
    });
  }

  if (level.pricingVersion !== SUPPORTED_PRICING_VERSION) {
    issues.push({
      code: 'unsupported-version',
      message: `Pricing version ${level.pricingVersion} is not supported; available version is ${SUPPORTED_PRICING_VERSION}`,
    });
  }

  issues.push(...checkSchedule('read', workloads.read.schedule, level.durationMs));
  issues.push(...checkSchedule('write', workloads.write.schedule, level.durationMs));

  // L01 uses one shared `catalog` namespace: reads and writes must address the
  // same key domain, otherwise write invalidation has no well-defined target.
  if (workloads.read.keySpace !== workloads.write.keySpace) {
    issues.push({
      code: 'level-coherence',
      message: 'Reads and writes must use the same key space of equal size',
    });
  }

  if (workloads.read.hotCount >= workloads.read.keySpace) {
    issues.push({
      code: 'level-coherence',
      message: 'The number of hot keys must be smaller than the key space',
    });
  }

  if (level.warmupMs >= level.durationMs) {
    issues.push({
      code: 'level-coherence',
      message: 'Warmup must be shorter than the evaluation duration',
    });
  }

  if (level.flushAtMs !== null && level.flushAtMs >= level.durationMs) {
    issues.push({
      code: 'level-coherence',
      message: 'The cache flush must happen before the end of the evaluation',
    });
  }

  if (level.drainMs < level.deadlineMs) {
    issues.push({
      code: 'level-coherence',
      message: 'Drain is shorter than the global deadline — requests will not finish in time',
    });
  }

  if (level.deadlineMs > level.durationMs) {
    issues.push({
      code: 'level-coherence',
      message: 'The deadline cannot exceed the evaluation duration',
    });
  }

  if (slo.criticalFromMs >= slo.criticalToMs) {
    issues.push({
      code: 'level-coherence',
      message: 'The critical window must have a positive length',
    });
  }

  if (slo.criticalToMs > level.durationMs) {
    issues.push({
      code: 'level-coherence',
      message: 'The critical window must lie inside the evaluation',
    });
  }

  if (level.refs.pricingCatalog !== level.pricingVersion) {
    issues.push({
      code: 'level-coherence',
      message: 'The pricing catalog reference does not match the level pricingVersion',
    });
  }

  const totals =
    expectedArrivals(workloads.read.schedule, 0, level.durationMs) +
    expectedArrivals(workloads.read.schedule, 0, level.warmupMs) +
    expectedArrivals(workloads.write.schedule, 0, level.durationMs) +
    expectedArrivals(workloads.write.schedule, 0, level.warmupMs);
  if (totals > MAX_ARRIVALS) {
    issues.push({
      code: 'level-arrivals',
      message: `Expected arrivals ${Math.ceil(totals)} exceed the limit of ${MAX_ARRIVALS}`,
    });
  }

  return issues;
}

/**
 * Strict parse plus coherence validation for an untrusted level object.
 * Unknown fields are rejected; the returned object is a plain JSON value.
 */
export function parseLevel(input: unknown): LevelDefinition {
  const parsed = levelDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainValidationError(
      'Invalid level definition',
      issuesFromSchemaError(parsed.error),
    );
  }
  const level = parsed.data;
  const issues = validateLevel(level);
  if (issues.length > 0) {
    throw new DomainValidationError('Invalid level definition', issues);
  }
  return level;
}

/** Parse level JSON text, enforcing the 1 MiB input bound first. */
export function parseLevelJson(text: string): LevelDefinition {
  const bytes = utf8ByteLength(text);
  if (bytes > MAX_INPUT_BYTES) {
    throw new DomainValidationError('Level JSON exceeds 1 MiB', [
      {
        code: 'input-too-large',
        message: `Size ${bytes} bytes exceeds the limit of ${MAX_INPUT_BYTES} bytes`,
      },
    ]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new DomainValidationError('Invalid level JSON', [
      { code: 'invalid-json', message: 'Text is not valid JSON' },
    ]);
  }
  return parseLevel(value);
}

/** Deep copy of any level, including schedules, timing, SLO and seed arrays. */
export function cloneLevel(level: LevelDefinition): LevelDefinition {
  return {
    ...level,
    workloads: {
      read: {
        ...level.workloads.read,
        schedule: level.workloads.read.schedule.map((point) => ({ ...point })),
      },
      write: {
        ...level.workloads.write,
        schedule: level.workloads.write.schedule.map((point) => ({ ...point })),
      },
    },
    timing: { ...level.timing },
    slo: { ...level.slo },
    refs: {
      ...level.refs,
      calibrationSeeds: [...level.refs.calibrationSeeds],
      holdoutSeeds: [...level.refs.holdoutSeeds],
    },
  };
}

/** Fresh mutable working copy of the frozen shipped level. */
export function createDefaultLevel(): LevelDefinition {
  return cloneLevel(DEFAULT_LEVEL);
}

/**
 * The shipped level, parsed from `public/levels/cold-cache.json` and deep-frozen.
 * Consumers that need to edit a level must use `createDefaultLevel()` (or
 * `cloneLevel`) so the shared default cannot be mutated in place. `parseLevel`
 * itself still returns ordinary mutable data, keeping the engine/UI input shape.
 */
export const DEFAULT_LEVEL: LevelDefinition = deepFreeze(parseLevel(levelJson));
