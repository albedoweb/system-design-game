import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEVEL,
  DomainValidationError,
  MAX_INPUT_BYTES,
  SUPPORTED_MODEL_VERSION,
  SUPPORTED_PRICING_VERSION,
  cloneLevel,
  createDefaultLevel,
  expectedArrivals,
  parseLevel,
  parseLevelJson,
  validateLevel,
  type LevelDefinition,
  type ValidationIssue,
} from './index';

function shippedJson(): unknown {
  const path = join(process.cwd(), 'public', 'levels', 'cold-cache.json');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function levelClone(): LevelDefinition {
  return structuredClone(DEFAULT_LEVEL);
}

function issuesOf(run: () => unknown): ValidationIssue[] {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainValidationError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error('expected DomainValidationError');
}

describe('DEFAULT_LEVEL', () => {
  it('is parsed from the static JSON source', () => {
    expect(DEFAULT_LEVEL).toEqual(shippedJson());
    expect(parseLevel(shippedJson())).toEqual(DEFAULT_LEVEL);
    expect(validateLevel(DEFAULT_LEVEL)).toEqual([]);
  });

  it('is deeply frozen so consumers cannot mutate shared defaults', () => {
    expect(Object.isFrozen(DEFAULT_LEVEL)).toBe(true);
    expect(Object.isFrozen(DEFAULT_LEVEL.workloads)).toBe(true);
    expect(Object.isFrozen(DEFAULT_LEVEL.workloads.read.schedule)).toBe(true);
    expect(Object.isFrozen(DEFAULT_LEVEL.workloads.read.schedule[0])).toBe(true);
    expect(Object.isFrozen(DEFAULT_LEVEL.timing)).toBe(true);
    expect(Object.isFrozen(DEFAULT_LEVEL.slo)).toBe(true);
    expect(Object.isFrozen(DEFAULT_LEVEL.refs)).toBe(true);
    expect(Object.isFrozen(DEFAULT_LEVEL.refs.calibrationSeeds)).toBe(true);

    expect(() => {
      DEFAULT_LEVEL.workloads.read.schedule[0] = { atMs: 0, rps: 1 };
    }).toThrow(TypeError);
    expect(() => {
      DEFAULT_LEVEL.slo.readP95Ms = 1;
    }).toThrow(TypeError);
    expect(() => {
      DEFAULT_LEVEL.refs.calibrationSeeds.push(999);
    }).toThrow(TypeError);
    expect(DEFAULT_LEVEL.workloads.read.schedule[0]?.rps).toBe(285);
    expect(DEFAULT_LEVEL.slo.readP95Ms).toBe(150);
    expect(DEFAULT_LEVEL.refs.calibrationSeeds).toEqual([101, 211, 307, 401, 503]);
  });

  it('provides fresh mutable copies without changing the frozen default', () => {
    const first = createDefaultLevel();
    first.workloads.read.schedule[0] = { atMs: 0, rps: 1 };
    first.workloads.write.schedule[0] = { atMs: 0, rps: 2 };
    first.timing.dbReadMs = 1;
    first.slo.writeP95Ms = 1;
    first.refs.calibrationSeeds.push(999);
    first.refs.holdoutSeeds.length = 0;

    expect(DEFAULT_LEVEL.workloads.read.schedule[0]?.rps).toBe(285);
    expect(DEFAULT_LEVEL.workloads.write.schedule[0]?.rps).toBe(15);
    expect(DEFAULT_LEVEL.timing.dbReadMs).toBe(16);
    expect(DEFAULT_LEVEL.slo.writeP95Ms).toBe(200);
    expect(DEFAULT_LEVEL.refs.calibrationSeeds).toHaveLength(5);
    expect(DEFAULT_LEVEL.refs.holdoutSeeds).toHaveLength(2);

    const second = createDefaultLevel();
    expect(second).toEqual(DEFAULT_LEVEL);
    expect(second.workloads.read.schedule).not.toBe(
      DEFAULT_LEVEL.workloads.read.schedule,
    );
    expect(second.refs.calibrationSeeds).not.toBe(
      DEFAULT_LEVEL.refs.calibrationSeeds,
    );

    const cloned = cloneLevel(DEFAULT_LEVEL);
    cloned.workloads.read.schedule[0] = { atMs: 0, rps: 3 };
    expect(cloned).not.toEqual(DEFAULT_LEVEL);
    expect(DEFAULT_LEVEL.workloads.read.schedule[0]?.rps).toBe(285);
  });

  it('keeps parseLevel output mutable for engine/UI input', () => {
    const parsed = parseLevel(shippedJson());
    expect(Object.isFrozen(parsed)).toBe(false);
    parsed.workloads.read.schedule[0] = { atMs: 0, rps: 1 };
    parsed.slo.readP95Ms = 151;
    expect(parsed.workloads.read.schedule[0]?.rps).toBe(1);
    expect(parsed.slo.readP95Ms).toBe(151);
  });

  it('carries the shipped level numbers and versions', () => {
    expect(DEFAULT_LEVEL).toMatchObject({
      schemaVersion: 1,
      contentVersion: '1.0.0',
      modelVersion: '1.0.0',
      pricingVersion: 'catalog-v1',
      id: 'cold-cache',
      durationMs: 60_000,
      warmupMs: 5_000,
      flushAtMs: 30_000,
      drainMs: 800,
      deadlineMs: 800,
      budgetMicroUsdPerHour: 5_500_000,
      defaultSeed: 101,
    });
    expect(DEFAULT_LEVEL.workloads.read.schedule).toEqual([
      { atMs: 0, rps: 285 },
      { atMs: 20_000, rps: 855 },
      { atMs: 45_000, rps: 285 },
    ]);
    expect(DEFAULT_LEVEL.workloads.write.schedule).toEqual([
      { atMs: 0, rps: 15 },
      { atMs: 20_000, rps: 45 },
      { atMs: 45_000, rps: 15 },
    ]);
    expect(DEFAULT_LEVEL.workloads.read).toMatchObject({
      keySpace: 5000,
      hotCount: 128,
      hotProbability: 0.95,
    });
    expect(DEFAULT_LEVEL.workloads.write.keySpace).toBe(5000);
    expect(DEFAULT_LEVEL.timing).toEqual({
      clientRttMs: 10,
      edgeRttMs: 2,
      appCpuMs: 2,
      cacheLookupMs: 1,
      dbReadMs: 16,
      dbWriteMs: 32,
      lbMs: 1,
      invalidationMs: 2,
    });
    expect(DEFAULT_LEVEL.slo).toEqual({
      availability: 0.995,
      readP95Ms: 150,
      writeP95Ms: 200,
      criticalFromMs: 30_000,
      criticalToMs: 35_000,
      criticalAvailability: 0.99,
      criticalReadP95Ms: 200,
      criticalWriteP95Ms: 250,
    });
    expect(DEFAULT_LEVEL.refs.calibrationSeeds).toEqual([101, 211, 307, 401, 503]);
    expect(DEFAULT_LEVEL.refs.holdoutSeeds).toEqual([607, 701]);
  });

  it('computes expected arrivals with and without warmup', () => {
    const { read, write } = DEFAULT_LEVEL.workloads;
    expect(expectedArrivals(read.schedule, 0, DEFAULT_LEVEL.durationMs)).toBe(31_350);
    expect(expectedArrivals(write.schedule, 0, DEFAULT_LEVEL.durationMs)).toBe(1_650);
    expect(expectedArrivals(read.schedule, 0, DEFAULT_LEVEL.warmupMs)).toBe(1_425);
    expect(expectedArrivals(write.schedule, 0, DEFAULT_LEVEL.warmupMs)).toBe(75);
  });
});

describe('parseLevel', () => {
  it('rejects unknown fields and malformed versions', () => {
    const unknown = { ...levelClone(), extra: true };
    expect(issuesOf(() => parseLevel(unknown))[0]?.code).toBe('schema');

    const badVersion = levelClone();
    badVersion.contentVersion = '1.0';
    expect(issuesOf(() => parseLevel(badVersion))[0]?.code).toBe('schema');

    const badId = levelClone();
    (badId as unknown as Record<string, unknown>).id = 'other-level';
    expect(issuesOf(() => parseLevel(badId))[0]?.code).toBe('schema');
  });

  it('rejects unsupported model and pricing versions', () => {
    expect(SUPPORTED_MODEL_VERSION).toBe('1.0.0');
    expect(SUPPORTED_PRICING_VERSION).toBe('catalog-v1');

    const model = levelClone();
    model.modelVersion = '2.0.0';
    expect(issuesOf(() => parseLevel(model)).map((i) => i.code)).toContain(
      'unsupported-version',
    );

    const pricing = levelClone();
    pricing.pricingVersion = 'catalog-v2';
    pricing.refs.pricingCatalog = 'catalog-v2';
    expect(issuesOf(() => parseLevel(pricing)).map((i) => i.code)).toContain(
      'unsupported-version',
    );

    const pricingMismatch = levelClone();
    pricingMismatch.refs.pricingCatalog = 'catalog-v2';
    expect(issuesOf(() => parseLevel(pricingMismatch)).map((i) => i.code)).toContain(
      'level-coherence',
    );
  });

  it('requires reads and writes to share one keyspace', () => {
    const level = levelClone();
    level.workloads.write.keySpace = level.workloads.read.keySpace + 1;
    const issues = issuesOf(() => parseLevel(level));
    expect(issues.map((i) => i.code)).toContain('level-coherence');
    expect(issues.some((issue) => issue.message.includes('key space'))).toBe(true);
  });

  it('bounds only expected arrivals; the runtime cap belongs to the engine', () => {
    const level = levelClone();
    level.warmupMs = 0;
    level.flushAtMs = null;
    level.workloads.read.schedule = [{ atMs: 0, rps: 7_000 }];
    level.workloads.write.schedule = [{ atMs: 0, rps: 0 }];
    // 7,000 rps for 60 s is 420,000 expected arrivals, below the domain guard.
    expect(
      expectedArrivals(level.workloads.read.schedule, 0, level.durationMs),
    ).toBe(420_000);
    expect(parseLevel(level)).toEqual(level);
  });

  it('rejects invalid schedules', () => {
    const notZero = levelClone();
    notZero.workloads.read.schedule = [{ atMs: 1000, rps: 285 }];
    expect(issuesOf(() => parseLevel(notZero)).map((i) => i.code)).toContain(
      'level-schedule',
    );

    const decreasing = levelClone();
    decreasing.workloads.write.schedule.push({ atMs: 19_000, rps: 15 });
    expect(issuesOf(() => parseLevel(decreasing)).map((i) => i.code)).toContain(
      'level-schedule',
    );

    const beyondEnd = levelClone();
    beyondEnd.workloads.read.schedule.push({ atMs: 60_000, rps: 1 });
    expect(issuesOf(() => parseLevel(beyondEnd)).map((i) => i.code)).toContain(
      'level-schedule',
    );

    const tooFast = levelClone();
    tooFast.workloads.write.schedule[0] = { atMs: 0, rps: 10_001 };
    expect(issuesOf(() => parseLevel(tooFast))[0]?.code).toBe('schema');
  });

  it('rejects invalid keyspace, hot set and probability', () => {
    const tooManyKeys = levelClone();
    tooManyKeys.workloads.read.keySpace = 100_001;
    expect(issuesOf(() => parseLevel(tooManyKeys))[0]?.code).toBe('schema');

    const hotEqualsKeys = levelClone();
    hotEqualsKeys.workloads.read.hotCount = hotEqualsKeys.workloads.read.keySpace;
    expect(issuesOf(() => parseLevel(hotEqualsKeys)).map((i) => i.code)).toContain(
      'level-coherence',
    );

    const badProbability = levelClone();
    badProbability.workloads.read.hotProbability = 1.1;
    expect(issuesOf(() => parseLevel(badProbability))[0]?.code).toBe('schema');
  });

  it('rejects incoherent durations, flush, drain and SLO windows', () => {
    const longDuration = levelClone();
    longDuration.durationMs = 120_001;
    expect(issuesOf(() => parseLevel(longDuration))[0]?.code).toBe('schema');

    const longWarmup = levelClone();
    longWarmup.warmupMs = longWarmup.durationMs;
    expect(issuesOf(() => parseLevel(longWarmup)).map((i) => i.code)).toContain(
      'level-coherence',
    );

    const lateFlush = levelClone();
    lateFlush.flushAtMs = lateFlush.durationMs;
    expect(issuesOf(() => parseLevel(lateFlush)).map((i) => i.code)).toContain(
      'level-coherence',
    );

    const shortDrain = levelClone();
    shortDrain.drainMs = 500;
    expect(issuesOf(() => parseLevel(shortDrain)).map((i) => i.code)).toContain(
      'level-coherence',
    );

    const emptyCritical = levelClone();
    emptyCritical.slo.criticalFromMs = 35_000;
    emptyCritical.slo.criticalToMs = 35_000;
    expect(issuesOf(() => parseLevel(emptyCritical)).map((i) => i.code)).toContain(
      'level-coherence',
    );

    const lateCritical = levelClone();
    lateCritical.slo.criticalToMs = 60_001;
    expect(issuesOf(() => parseLevel(lateCritical)).map((i) => i.code)).toContain(
      'level-coherence',
    );

    const zeroAvailability = levelClone();
    zeroAvailability.slo.availability = 0;
    expect(issuesOf(() => parseLevel(zeroAvailability))[0]?.code).toBe('schema');
  });

  it('rejects an arrival budget above 500k', () => {
    const level = levelClone();
    level.durationMs = 120_000;
    level.warmupMs = 0;
    level.flushAtMs = null;
    level.workloads.read.schedule = [{ atMs: 0, rps: 10_000 }];
    level.workloads.write.schedule = [{ atMs: 0, rps: 0 }];
    expect(issuesOf(() => parseLevel(level)).map((i) => i.code)).toContain(
      'level-arrivals',
    );
  });

  it('rejects a pricing reference mismatch', () => {
    const level = levelClone();
    level.refs.pricingCatalog = 'other-catalog';
    expect(issuesOf(() => parseLevel(level)).map((i) => i.code)).toContain(
      'level-coherence',
    );
  });

  it('accepts no flush and enforces the byte bound for level JSON', () => {
    const noFlush = levelClone();
    noFlush.flushAtMs = null;
    expect(parseLevel(noFlush).flushAtMs).toBeNull();
    expect(parseLevelJson(JSON.stringify(DEFAULT_LEVEL))).toEqual(DEFAULT_LEVEL);
    expect(issuesOf(() => parseLevelJson('{'))[0]?.code).toBe('invalid-json');

    const oversized = `${JSON.stringify(DEFAULT_LEVEL)}${' '.repeat(MAX_INPUT_BYTES)}`;
    expect(issuesOf(() => parseLevelJson(oversized))[0]?.code).toBe('input-too-large');
  });
});
