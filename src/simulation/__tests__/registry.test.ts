import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEVEL,
} from '../../domain/level';
import {
  createInitialGraph,
  type GraphDocument,
} from '../../domain/graph';
import { createSimulation } from '../../engine';
import { ClassMetrics } from '../../engine/metrics';
import { buildChecks } from '../../engine/result';
import { COLD_CACHE_CHECK_IDS } from '../legacy-schema';
import {
  IMAGE_COMPONENT_LIMITS,
  IMAGE_REQUIRED_SCENARIOS,
  createImageGraph,
} from '../../images/index';
import {
  PARCEL_LEVEL,
  createParcelGraph,
} from '../../parcel/index';
import {
  SCOREBOARD_LEVEL,
  createScoreboardStarterGraph,
} from '../../scoreboard/index';
import {
  AUDIENCE_LEVEL,
  AUDIENCE_PROFILE_VERSION,
  createAudienceStarterGraph,
} from '../../audience/index';
import {
  CART_DEFAULT_SEED,
  CART_MAX_SEED,
  CART_REQUIRED_CASES,
  CART_VERSIONS,
  createCartStarterGraph,
} from '../../cart/index';
import {
  EngineLevelError,
} from '../contracts';
import {
  createEngineRegistry,
  type EngineEvaluationResult,
} from '../registry';

function fixture(relative: string): unknown {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), relative), 'utf8'),
  ) as unknown;
}

function coldGraph(relative: string): GraphDocument {
  return (fixture(relative) as { graph: GraphDocument }).graph;
}

describe('common engine registry', () => {
  it('discovers all six levels with exact versions and availability', () => {
    const registry = createEngineRegistry();
    const levels = registry.levels();
    expect(levels.map((level) => level.id)).toEqual([
      'cold-cache',
      'parcel-pulse',
      'image-atlas',
      'live-scoreboard',
      'live-audience',
      'global-cart',
    ]);
    for (const level of levels.slice(0, 5)) {
      expect(level.modelVersion).toBe('1.0.0');
      expect(level.schemaVersion).toBe(1);
      expect(level.contentVersion).toBe('1.0.0');
      expect(level.defaultSeed).toBe(101);
    }
    expect(levels[0]?.pricingVersion).toBe(DEFAULT_LEVEL.pricingVersion);
    expect(levels[1]?.pricingVersion).toBe('parcel-catalog-v1');
    expect(levels[2]?.pricingVersion).toBe('image-atlas-catalog-v1');
    expect(
      createEngineRegistry({ imageEvaluator: null }).levels()[2]?.availability,
    ).toBe('contract-only');
    expect(levels[2]?.requiredScenarios).toEqual([...IMAGE_REQUIRED_SCENARIOS]);
    expect(levels[3]?.pricingVersion).toBe('scoreboard-catalog-v1');
    expect(levels[3]?.availability).toBe('playable');
    expect(levels[3]?.defaultSeed).toBe(SCOREBOARD_LEVEL.defaultSeed);
    expect(levels[3]?.horizons).toBeUndefined();
    expect(levels[4]?.pricingVersion).toBe('audience-catalog-v1');
    expect(levels[4]?.profileVersion).toBe(AUDIENCE_PROFILE_VERSION);
    expect(levels[4]?.availability).toBe('playable');
    expect(levels[4]?.defaultSeed).toBe(AUDIENCE_LEVEL.defaultSeed);
    expect(levels[4]?.horizons).toBeUndefined();
    expect(
      createEngineRegistry({ audienceEvaluator: () => ({}) as never }).levels()[4]
        ?.availability,
    ).toBe('playable');
  });

  it('exposes a graph JSON Schema that matches each level parser', () => {
    const registry = createEngineRegistry();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const coldSchema = ajv.compile(registry.graphSchema('cold-cache'));
    const parcelSchema = ajv.compile(registry.graphSchema('parcel-pulse'));
    const imageSchema = ajv.compile(registry.graphSchema('image-atlas'));
    const scoreboardSchema = ajv.compile(
      registry.graphSchema('live-scoreboard'),
    );
    const audienceSchema = ajv.compile(
      registry.graphSchema('live-audience'),
    );
    const cartSchema = ajv.compile(registry.graphSchema('global-cart'));

    const cold = createInitialGraph();
    const parcel = createParcelGraph();
    const image = createImageGraph();
    const scoreboard = createScoreboardStarterGraph();
    const audience = createAudienceStarterGraph();
    const cart = createCartStarterGraph();
    expect(coldSchema(cold)).toBe(true);
    expect(parcelSchema(parcel)).toBe(true);
    expect(imageSchema(image)).toBe(true);
    expect(scoreboardSchema(scoreboard)).toBe(true);
    expect(audienceSchema(audience)).toBe(true);
    expect(cartSchema(cart)).toBe(true);
    expect(cartSchema({ ...cart, levelId: 'cold-cache' })).toBe(false);
    expect(cartSchema({ ...cart, unexpected: true })).toBe(false);

    expect(coldSchema({ ...cold, levelId: 'parcel-pulse' })).toBe(false);
    expect(coldSchema({ ...cold, unexpected: true })).toBe(false);
    expect(parcelSchema({ ...parcel, levelId: 'cold-cache' })).toBe(false);
    expect(imageSchema({ ...image, levelId: 'cold-cache' })).toBe(false);
    expect(scoreboardSchema({ ...scoreboard, levelId: 'cold-cache' })).toBe(
      false,
    );
    expect(scoreboardSchema({ ...scoreboard, unexpected: true })).toBe(false);
    expect(audienceSchema({ ...audience, levelId: 'cold-cache' })).toBe(false);
    expect(audienceSchema({ ...audience, unexpected: true })).toBe(false);
    expect(
      imageSchema({ ...image, nodes: new Array(IMAGE_COMPONENT_LIMITS.maxNodes + 1).fill(image.nodes[0]) }),
    ).toBe(false);
  });

  it('validates each level through its own core without an evaluator', () => {
    const registry = createEngineRegistry();
    const cold = registry.validate('cold-cache', createInitialGraph());
    expect(cold.ok).toBe(true);
    expect(cold.graphDigest).toMatch(/^[0-9a-f]{16}$/);

    expect(registry.validate('cold-cache', createParcelGraph()).ok).toBe(false);
    expect(registry.validate('parcel-pulse', createParcelGraph()).ok).toBe(true);
    expect(registry.validate('parcel-pulse', createInitialGraph()).ok).toBe(false);
    expect(registry.validate('image-atlas', createImageGraph()).ok).toBe(true);
    expect(registry.validate('image-atlas', createParcelGraph()).ok).toBe(false);
    expect(registry.validate('live-audience', createAudienceStarterGraph()).ok).toBe(
      false,
    );
    expect(registry.validate('live-audience', createParcelGraph()).ok).toBe(false);

    const invalid = registry.validate('cold-cache', {
      schemaVersion: 1,
      levelId: 'cold-cache',
      nodes: [],
      edges: [],
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.issues.some((issue) => issue.severity === 'error')).toBe(true);
  });

  it('runs real Cold Cache pass and fail witnesses through the adapter', () => {
    const registry = createEngineRegistry();
    const pass = registry.evaluate({
      levelId: 'cold-cache',
      graph: coldGraph('tests/calibration/cheap-pass.json'),
      seed: 101,
    }) as Extract<EngineEvaluationResult, { levelId: 'cold-cache' }>;
    expect(pass.levelId).toBe('cold-cache');
    expect(pass.result.status).toBe('ok');
    expect(pass.result.passed).toBe(true);
    expect(pass.result.meta.levelId).toBe('cold-cache');
    expect(pass.result.meta.seed).toBe(101);

    const fail = registry.evaluate({
      levelId: 'cold-cache',
      graph: coldGraph('tests/calibration/overbudget.json'),
      seed: 101,
    }) as Extract<EngineEvaluationResult, { levelId: 'cold-cache' }>;
    expect(fail.result.status).toBe('ok');
    expect(fail.result.passed).toBe(false);
    expect(
      fail.result.result?.checks.some(
        (check) => check.id === 'cost' && !check.passed,
      ),
    ).toBe(true);
  });

  it('keeps the Cold Cache result body byte-identical to the frozen engine', () => {
    const registry = createEngineRegistry();
    const graph = coldGraph('tests/calibration/cheap-pass.json');
    const expected = createSimulation(graph, DEFAULT_LEVEL, 101);
    expected.advance(DEFAULT_LEVEL.durationMs + DEFAULT_LEVEL.drainMs);
    const direct = expected.result();

    const outcome = registry.evaluate({
      levelId: 'cold-cache',
      graph,
      seed: 101,
    }) as Extract<EngineEvaluationResult, { levelId: 'cold-cache' }>;
    expect(JSON.stringify(outcome.result.result)).toBe(
      JSON.stringify(direct),
    );
    const second = createSimulation(graph, DEFAULT_LEVEL, 101);
    second.advance(DEFAULT_LEVEL.durationMs + DEFAULT_LEVEL.drainMs);
    expect(JSON.stringify(outcome.result.result)).toBe(
      JSON.stringify(second.result()),
    );
  });

  it('runs real Parcel Pulse pass and fail witnesses through the adapter', () => {
    const registry = createEngineRegistry();
    const pass = registry.evaluate({
      levelId: 'parcel-pulse',
      graph: fixture('fixtures/parcel/family-sql-indexed.json'),
      seed: 101,
    }) as Extract<EngineEvaluationResult, { levelId: 'parcel-pulse' }>;
    expect(pass.levelId).toBe('parcel-pulse');
    expect(pass.result.status).toBe('ok');
    expect(pass.result.passed).toBe(true);
    expect(pass.result.meta.levelId).toBe('parcel-pulse');
    expect(pass.result.meta.requestedHorizons).toEqual([1, 5]);

    const fail = registry.evaluate({
      levelId: 'parcel-pulse',
      graph: fixture('fixtures/parcel/fail-capacity.json'),
      seed: 101,
    }) as Extract<EngineEvaluationResult, { levelId: 'parcel-pulse' }>;
    expect(fail.result.status).toBe('ok');
    expect(fail.result.passed).toBe(false);
    expect(
      fail.result.checks.some(
        (check) => check.id === 'capacity' && !check.passed,
      ) ||
        fail.result.horizons.some((horizon) =>
          horizon.checks.some(
            (check) => check.id === 'capacity' && !check.passed,
          ),
        ),
    ).toBe(true);
  }, 30_000);

  it('runs real Live Scoreboard pass and fail witnesses through the adapter', () => {
    const registry = createEngineRegistry();
    const starter = registry.validate(
      'live-scoreboard',
      createScoreboardStarterGraph(),
    );
    expect(starter.ok).toBe(false);
    expect(starter.issues.map((issue) => issue.code)).toContain('missing-app');
    expect(starter.issues.map((issue) => issue.code)).toContain('missing-sql');

    const pass = registry.evaluate({
      levelId: 'live-scoreboard',
      graph: fixture('fixtures/scoreboard/family-aggregate.json'),
      seed: 101,
    }) as Extract<EngineEvaluationResult, { levelId: 'live-scoreboard' }>;
    expect(pass.result.status).toBe('complete');
    expect(pass.result.passed).toBe(true);
    expect(pass.result.identity).toEqual({
      levelId: 'live-scoreboard',
      modelVersion: '1.0.0',
      schemaVersion: 1,
      contentVersion: '1.0.0',
      pricingVersion: 'scoreboard-catalog-v1',
      seed: 101,
      graphDigest: pass.result.graphDigest,
      runId: pass.result.runId,
    });
    expect(pass.result.cost?.scoreUsd).toBeGreaterThan(0);

    const fail = registry.evaluate({
      levelId: 'live-scoreboard',
      graph: fixture('fixtures/scoreboard/fail-small-scan.json'),
      seed: 101,
    }) as Extract<EngineEvaluationResult, { levelId: 'live-scoreboard' }>;
    expect(fail.result.status).toBe('complete');
    expect(fail.result.passed).toBe(false);
    expect(
      fail.result.gates.some(
        (gate) => gate.operation === 'read' && !gate.passed,
      ),
    ).toBe(true);

    const invalid = registry.evaluate({
      levelId: 'live-scoreboard',
      graph: fixture('fixtures/scoreboard/invalid-missing-sql.json'),
      seed: 101,
    }) as Extract<EngineEvaluationResult, { levelId: 'live-scoreboard' }>;
    expect(invalid.result.status).toBe('invalid');
    expect(invalid.result.passed).toBe(false);

    expect(() =>
      registry.evaluate({
        levelId: 'live-scoreboard',
        graph: fixture('fixtures/scoreboard/family-aggregate.json'),
        seed: 101,
        horizonYears: 5,
      }),
    ).toThrowError(/--horizon/);
    expect(() =>
      registry.evaluate({
        levelId: 'live-scoreboard',
        graph: fixture('fixtures/scoreboard/family-aggregate.json'),
        seed: 101,
        scenarios: ['normal'],
      }),
    ).toThrowError(/--scenario/);
    expect(() =>
      registry.evaluate({
        levelId: 'live-scoreboard',
        graph: fixture('fixtures/scoreboard/family-aggregate.json'),
        seed: 101,
        modelVersion: '9.9.9',
      }),
    ).toThrowError(/model version/);
  }, 30_000);

  it('publishes the authoritative Live Audience catalog, profile and Users-only example', () => {
    const registry = createEngineRegistry();
    const components = registry.components('live-audience') as {
      pricingVersion: string;
      profileVersion: string;
      catalog: {
        components: { sql: { sizes: { large: { hourlyUsd: number } } } };
        work: { queryScanCoreMsPerEvent: number };
        policies: { health: { intervalMs: number } };
        storage: { rawEventBytes: number };
      };
      seeds: { calibration: number[]; holdout: number[] };
      challenges: { profileVersion: string; requiredKinds: string[] };
      maxInstancesChallengeProfile: {
        cases: { id: string; targetInstance: number | null }[];
        requiredCaseIds: string[];
      };
    };
    expect(components.pricingVersion).toBe('audience-catalog-v1');
    expect(components.profileVersion).toBe(AUDIENCE_PROFILE_VERSION);
    expect(components.catalog.components.sql.sizes.large.hourlyUsd).toBe(1.28);
    expect(components.catalog.work.queryScanCoreMsPerEvent).toBe(0.00002);
    expect(components.catalog.policies.health.intervalMs).toBe(250);
    expect(components.catalog.storage.rawEventBytes).toBe(128);
    expect(components.seeds.calibration).toEqual([101, 211, 307, 401, 503]);
    expect(components.seeds.holdout).toEqual([607, 701]);
    expect(components.challenges.profileVersion).toBe(AUDIENCE_PROFILE_VERSION);
    expect(components.challenges.requiredKinds).toEqual([
      'normal',
      'peak',
      'app-instance-failure',
    ]);
    expect(components.maxInstancesChallengeProfile.requiredCaseIds).toEqual([
      'normal',
      'peak',
      'app-failure-0',
      'app-failure-1',
      'app-failure-2',
      'app-failure-3',
    ]);

    const example = registry.example('live-audience') as {
      levelId: string;
      nodes: { kind: string }[];
      edges: unknown[];
    };
    expect(example.levelId).toBe('live-audience');
    expect(example.nodes.map((node) => node.kind)).toEqual(['users']);
    expect(example.edges).toEqual([]);

    const level = registry.levelDefinition('live-audience') as {
      id: string;
      dataset: { users: number; streams: number };
      workload: { measuredMs: number; topN: number };
    };
    expect(level.id).toBe('live-audience');
    expect(level.dataset.users).toBe(1_000_000);
    expect(level.dataset.streams).toBe(100);
    expect(level.workload.measuredMs).toBe(90_000);
    expect(level.workload.topN).toBe(20);

    const resultSchema = registry.resultSchema('live-audience') as {
      $id: string;
    };
    expect(resultSchema.$id).toContain('live-audience-result');
  });

  it('exposes the real Live Audience evaluator as a playable level', () => {
    const registry = createEngineRegistry();
    expect(registry.levels()[4]?.availability).toBe('playable');
    expect(typeof registry.resolve('live-audience')?.adapter.evaluate).toBe(
      'function',
    );
  });

  it('routes Live Audience through the injected core with seed and progress only', () => {
    const calls: {
      seed: number | undefined;
      keys: string[];
      progress: unknown;
    }[] = [];
    const registry = createEngineRegistry({
      audienceEvaluator: (input, options) => {
        expect(input).toEqual(createAudienceStarterGraph());
        calls.push({
          seed: options.seed,
          keys: Object.keys(options).sort(),
          progress: options.onProgress,
        });
        return { status: 'invalid' } as never;
      },
    });
    const progress = (): void => undefined;
    const outcome = registry.evaluate({
      levelId: 'live-audience',
      graph: createAudienceStarterGraph(),
      seed: 211,
      onProgress: progress,
    }) as Extract<EngineEvaluationResult, { levelId: 'live-audience' }>;
    expect(outcome.levelId).toBe('live-audience');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.seed).toBe(211);
    expect(calls[0]?.keys).toEqual(['onProgress', 'seed']);
    expect(typeof calls[0]?.progress).toBe('function');

    expect(() =>
      registry.evaluate({
        levelId: 'live-audience',
        graph: createAudienceStarterGraph(),
        seed: 101,
        horizonYears: 5,
      }),
    ).toThrowError(/--horizon/);
    expect(() =>
      registry.evaluate({
        levelId: 'live-audience',
        graph: createAudienceStarterGraph(),
        seed: 101,
        scenarios: ['normal'],
      }),
    ).toThrowError(/--scenario/);
    expect(() =>
      registry.evaluate({
        levelId: 'live-audience',
        graph: createAudienceStarterGraph(),
        seed: 101,
        modelVersion: '9.9.9',
      }),
    ).toThrowError(/model version/);
  });

  it('publishes the authoritative Live Scoreboard catalog and Users-only example', () => {
    const registry = createEngineRegistry();
    const components = registry.components('live-scoreboard') as {
      pricingVersion: string;
      catalog: {
        components: { sql: { sizes: { large: { hourlyUsd: number } } } };
        billing: { bytesPerGb: number };
      };
    };
    expect(components.pricingVersion).toBe('scoreboard-catalog-v1');
    expect(components.catalog.components.sql.sizes.large.hourlyUsd).toBe(1.28);
    expect(components.catalog.billing.bytesPerGb).toBe(1_000_000_000);

    const example = registry.example('live-scoreboard') as {
      levelId: string;
      nodes: { kind: string }[];
      edges: unknown[];
    };
    expect(example.levelId).toBe('live-scoreboard');
    expect(example.nodes.map((node) => node.kind)).toEqual(['users']);
    expect(example.edges).toEqual([]);

    const level = registry.levelDefinition('live-scoreboard') as {
      id: string;
      dataset: { participants: number };
      workload: { measuredMs: number };
    };
    expect(level.id).toBe('live-scoreboard');
    expect(level.dataset.participants).toBe(500_000);
    expect(level.workload.measuredMs).toBe(90_000);

    const resultSchema = registry.resultSchema('live-scoreboard') as {
      $id: string;
    };
    expect(resultSchema.$id).toContain('live-scoreboard-result');
  });

  it('keeps Image Atlas contract-only with an explicit null evaluator and never fakes a pass', () => {
    const registry = createEngineRegistry({ imageEvaluator: null });
    expect(() =>
      registry.evaluate({
        levelId: 'image-atlas',
        graph: createImageGraph(),
        seed: 101,
      }),
    ).toThrowError(EngineLevelError);
    try {
      registry.evaluate({
        levelId: 'image-atlas',
        graph: createImageGraph(),
        seed: 101,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(EngineLevelError);
      expect((error as EngineLevelError).code).toBe('evaluator_unavailable');
    }
  });

  it('rejects unknown levels, versions, seeds and cross-level graphs', () => {
    const registry = createEngineRegistry();
    expect(() =>
      registry.evaluate({
        levelId: 'not-a-level',
        graph: createParcelGraph(),
        seed: 101,
      }),
    ).toThrowError(/Unknown level/);
    expect(() =>
      registry.evaluate({
        levelId: 'parcel-pulse',
        modelVersion: '9.9.9',
        graph: createParcelGraph(),
        seed: 101,
      }),
    ).toThrowError(/model version/);
    expect(() =>
      registry.evaluate({
        levelId: 'parcel-pulse',
        graph: createParcelGraph(),
        seed: 2_147_483_648,
      }),
    ).toThrowError(/Seed/);
    expect(() =>
      registry.evaluate({
        levelId: 'cold-cache',
        graph: createInitialGraph(),
        seed: 4_294_967_296,
      }),
    ).toThrowError(/Seed/);
    expect(() =>
      registry.evaluate({
        levelId: 'cold-cache',
        graph: createInitialGraph(),
        seed: 101,
        horizonYears: 5,
      }),
    ).toThrowError(/--horizon/);
    expect(() =>
      registry.evaluate({
        levelId: 'parcel-pulse',
        graph: createParcelGraph(),
        seed: 101,
        scenarios: ['normal'],
      }),
    ).toThrowError(/--scenario/);

    const cross = registry.evaluate({
      levelId: 'parcel-pulse',
      graph: createInitialGraph(),
      seed: 101,
    }) as Extract<EngineEvaluationResult, { levelId: 'parcel-pulse' }>;
    expect(cross.result.status).toBe('invalid');
    expect(cross.result.passed).toBe(false);
  });

  it('keeps digests visual-free, seed-free and model-separated', () => {
    const registry = createEngineRegistry();
    const base = createInitialGraph();
    const moved: GraphDocument = JSON.parse(JSON.stringify(base)) as GraphDocument;
    moved.nodes[0]!.position.x += 100;
    moved.nodes[0]!.label = 'Moved client';
    expect(registry.semanticDigest('cold-cache', moved)).toBe(
      registry.semanticDigest('cold-cache', base),
    );
    const changed: GraphDocument = JSON.parse(JSON.stringify(base)) as GraphDocument;
    changed.nodes[0]!.config.size = 'large';
    expect(registry.semanticDigest('cold-cache', changed)).not.toBe(
      registry.semanticDigest('cold-cache', base),
    );

    const parcelDigest = registry.semanticDigest('parcel-pulse', createParcelGraph());
    const imageDigest = registry.semanticDigest('image-atlas', createImageGraph());
    expect(parcelDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(imageDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(parcelDigest).not.toBe(imageDigest);
  });

  it('publishes exactly the nine frozen Cold gates', () => {
    const expected = buildChecks(
      DEFAULT_LEVEL,
      new ClassMetrics(),
      new ClassMetrics(),
      0,
    );
    expect([...COLD_CACHE_CHECK_IDS]).toEqual(
      expected.map((check) => check.id),
    );
    expect(new Set(COLD_CACHE_CHECK_IDS).size).toBe(9);
  });

  it('registers Global Cart with the frozen versions, required cases and real evaluator', () => {
    const registry = createEngineRegistry();
    const level = registry.levels().find((item) => item.id === 'global-cart');
    expect(level).toBeDefined();
    expect(level?.modelVersion).toBe(CART_VERSIONS.model);
    expect(level?.contentVersion).toBe(CART_VERSIONS.content);
    expect(level?.pricingVersion).toBe(CART_VERSIONS.pricing);
    expect(level?.profileVersion).toBe(CART_VERSIONS.profile);
    expect(level?.defaultSeed).toBe(CART_DEFAULT_SEED);
    expect(level?.seed).toEqual({ min: 0, max: CART_MAX_SEED });
    expect(level?.availability).toBe('playable');
    expect(level?.requiredCases).toEqual([...CART_REQUIRED_CASES]);

    const starter = createCartStarterGraph();
    const validation = registry.validate('global-cart', starter);
    expect(validation.graphDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.semanticDigest('global-cart', starter)).toBe(
      validation.graphDigest,
    );
    expect(registry.semanticDigest('global-cart', createParcelGraph())).toBeNull();

    const components = registry.components('global-cart') as {
      versions: Record<string, string>;
      regions: string[];
      nodeKinds: string[];
      operations: string[];
      requiredCases: string[];
      work: Record<string, number>;
      pricing: { nodes: Record<string, unknown>; budget: unknown };
      catalog: { pricingVersion: string; calibration: { measured: boolean } };
    };
    expect(components.versions).toEqual({ ...CART_VERSIONS });
    expect(components.regions).toEqual(['us-west', 'eu-central', 'ap-northeast']);
    expect(components.nodeKinds).toEqual([
      'customers',
      'application',
      'cache',
      'journal',
      'store',
      'inventory',
    ]);
    expect(components.operations).toEqual([
      'edit',
      'read',
      'checkout',
      'probe',
      'audit',
    ]);
    expect(components.requiredCases).toEqual([...CART_REQUIRED_CASES]);
    expect(Object.keys(components.work).length).toBeGreaterThan(0);
    expect(components.pricing.nodes).toBeDefined();
    expect(components.pricing.budget).toBeDefined();
    expect(components.catalog.pricingVersion).toBe(CART_VERSIONS.pricing);
    expect(components.catalog.calibration.measured).toBe(false);

    const rejected = registry.evaluate({
      levelId: 'global-cart',
      graph: createParcelGraph(),
      seed: CART_DEFAULT_SEED,
    }) as Extract<EngineEvaluationResult, { levelId: 'global-cart' }>;
    expect(rejected.levelId).toBe('global-cart');
    expect(rejected.result.levelId).toBe('global-cart');
    expect(rejected.result.versions).toEqual({ ...CART_VERSIONS });
    expect(rejected.result.seed).toBe(CART_DEFAULT_SEED);
    expect(rejected.result.requiredCases).toEqual([...CART_REQUIRED_CASES]);
    expect(rejected.result.cases.map((item) => item.id)).toEqual([
      ...CART_REQUIRED_CASES,
    ]);
    expect(rejected.result.complete).toBe(false);
    expect(rejected.result.qualified).toBe(false);
    expect(rejected.result.scoreCreditsPerHour).toBeNull();
    expect(rejected.result.issues.length).toBeGreaterThan(0);

    expect(() =>
      registry.evaluate({
        levelId: 'global-cart',
        graph: starter,
        seed: CART_DEFAULT_SEED,
        horizonYears: 5,
      }),
    ).toThrowError(/--horizon/);
    expect(() =>
      registry.evaluate({
        levelId: 'global-cart',
        graph: starter,
        seed: CART_DEFAULT_SEED,
        scenarios: ['normal'],
      }),
    ).toThrowError(/--scenario/);
    expect(() =>
      registry.evaluate({
        levelId: 'global-cart',
        graph: starter,
        seed: CART_MAX_SEED + 1,
      }),
    ).toThrowError(/Seed/);
  });

  it('returns the confirmed starter examples from the real cores', () => {
    const registry = createEngineRegistry();
    expect(registry.example('cold-cache')).toEqual(createInitialGraph());
    expect(registry.example('parcel-pulse')).toEqual(createParcelGraph());
    expect(registry.example('image-atlas')).toEqual(createImageGraph());
    expect(registry.example('live-scoreboard')).toEqual(
      createScoreboardStarterGraph(),
    );
    expect(registry.example('live-audience')).toEqual(
      createAudienceStarterGraph(),
    );
    expect(registry.example('global-cart')).toEqual(createCartStarterGraph());
    expect(PARCEL_LEVEL.horizons).toEqual([1, 5]);
  });
});

/**
 * The CLI is a discovery surface of its own: `levels` must reflect the shared
 * registry rather than a stale hand-maintained list, so a newly registered
 * level cannot silently disappear from agent-facing discovery.
 */
describe('agent CLI discovery', () => {
  const root = process.cwd();
  const tsxCli = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  function cli(...args: string[]) {
    const result = spawnSync(
      process.execPath,
      [tsxCli, 'scripts/agent.ts', ...args],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  it('lists Global Cart in levels with its descriptor and mandatory cases', () => {
    const result = cli('levels', '--compact');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout) as {
      command: string;
      levels: Array<{
        id: string;
        playable?: boolean;
        defaultSeed?: number;
        requiredCases?: string[];
        seed?: { min: number; max: number };
      }>;
    };
    expect(payload.command).toBe('levels');
    expect(payload.levels.map((level) => level.id)).toEqual([
      'parcel-pulse',
      'cold-cache',
      'image-atlas',
      'live-scoreboard',
      'live-audience',
      'global-cart',
    ]);
    const cart = payload.levels.find((level) => level.id === 'global-cart');
    expect(cart?.playable).toBe(true);
    expect(cart?.defaultSeed).toBe(CART_DEFAULT_SEED);
    expect(cart?.seed).toEqual({ min: 0, max: CART_MAX_SEED });
    expect(cart?.requiredCases).toEqual([...CART_REQUIRED_CASES]);
  });

  it('advertises Global Cart in the CLI help', () => {
    const result = cli('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('global-cart');
    expect(result.stdout).toContain('Global Cart');
  });
});
