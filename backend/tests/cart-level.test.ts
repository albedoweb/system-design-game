/**
 * GC-016: Global Cart through the shared backend worker path.
 *
 * The API/worker must agree with the authoritative registry/core for the same
 * graph, versions and seed, and a worker result that is not bound to the
 * submitted topology must be rejected.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CART_DEFAULT_SEED,
  CART_MAX_SEED,
  CART_REQUIRED_CASES,
  CART_VERSIONS,
  evaluateCart,
  type CartEvaluation,
} from '../../src/cart/index.js';
import { createParcelGraph } from '../../src/parcel/index.js';
import { createEngineRegistry } from '../../src/simulation/registry.js';
import { WorkerEngine } from '../src/engine/index.js';
import {
  isCartEvaluationResult,
  type EngineResultBinding,
} from '../src/engine/result-validation.js';

function cartBinding(
  overrides: Partial<EngineResultBinding> = {},
): EngineResultBinding {
  return {
    levelId: 'global-cart',
    modelVersion: CART_VERSIONS.model,
    schemaVersion: 1,
    contentVersion: CART_VERSIONS.content,
    pricingVersion: CART_VERSIONS.pricing,
    profileVersion: CART_VERSIONS.profile,
    seed: CART_DEFAULT_SEED,
    graphDigest: null,
    requiredCaseIds: [...CART_REQUIRED_CASES],
    ...overrides,
  };
}

test('backend discovery exposes exact Global Cart rules, tables and cases', async () => {
  const engine = new WorkerEngine();
  try {
    const levels = await engine.levels();
    const summary = levels.find((level) => level.id === 'global-cart');
    assert.ok(summary);
    assert.equal(summary.defaultSeed, CART_DEFAULT_SEED);
    assert.deepEqual(summary.horizons, []);

    const describe = (await engine.describe('global-cart')) as {
      levelId: string;
      versions: Record<string, string>;
      requiredCases: string[];
      regions: { id: string }[];
      catalog: { pricingVersion: string };
    };
    assert.equal(describe.levelId, 'global-cart');
    assert.deepEqual(describe.versions, { ...CART_VERSIONS });
    assert.equal(describe.versions.content, 'cart-content-v2-basic');
    assert.deepEqual(describe.requiredCases, [...CART_REQUIRED_CASES]);
    assert.deepEqual(
      describe.regions.map((region) => region.id),
      ['us-west', 'eu-central', 'ap-northeast'],
    );
    assert.equal(describe.catalog.pricingVersion, CART_VERSIONS.pricing);

    const components = (await engine.components('global-cart')) as {
      operations: string[];
      requiredCases: string[];
      work: Record<string, unknown>;
      pricing: Record<string, unknown>;
      catalog: { nodes: Record<string, unknown> };
    };
    assert.deepEqual(components.requiredCases, [...CART_REQUIRED_CASES]);
    assert.deepEqual(components.operations, [
      'edit',
      'read',
      'checkout',
      'probe',
      'audit',
    ]);
    assert.ok(Object.keys(components.work).length > 0);
    assert.ok(Object.keys(components.pricing).length > 0);
    assert.ok(Object.keys(components.catalog.nodes).length > 0);

    assert.deepEqual(
      await engine.schema('global-cart'),
      createEngineRegistry().graphSchema('global-cart'),
    );
  } finally {
    await engine.close();
  }
});

test('Node worker returns exactly the core evaluation for the same graph, versions and seed', async () => {
  const engine = new WorkerEngine();
  try {
    // A cross-level graph is rejected structurally by the cart parser. The
    // evaluation is therefore a fast, deterministic "not executed" envelope,
    // which still exercises the full worker + binding + validation path.
    const graph: unknown = createParcelGraph();
    const direct = evaluateCart(graph, { seed: CART_DEFAULT_SEED });
    const worker = (await engine.evaluate(
      { levelId: 'global-cart', graph, seed: CART_DEFAULT_SEED },
      new AbortController().signal,
    )) as CartEvaluation;

    assert.deepEqual(worker, direct);
    assert.equal(worker.levelId, 'global-cart');
    assert.deepEqual(worker.versions, { ...CART_VERSIONS });
    assert.equal(worker.seed, CART_DEFAULT_SEED);
    assert.deepEqual(worker.requiredCases, [...CART_REQUIRED_CASES]);
    assert.deepEqual(
      worker.cases.map((item) => item.id),
      [...CART_REQUIRED_CASES],
    );
    assert.equal(worker.complete, false);
    assert.equal(worker.qualified, false);
    assert.equal(worker.scoreCreditsPerHour, null);

    assert.equal(
      isCartEvaluationResult(worker, cartBinding({ graphDigest: null })),
      true,
    );
  } finally {
    await engine.close();
  }
});

test('Global Cart validation rejects forged topology, versions and cases', async () => {
  const graph: unknown = createParcelGraph();
  const result = evaluateCart(graph, { seed: CART_DEFAULT_SEED });
  const binding = cartBinding({ graphDigest: null });

  assert.equal(isCartEvaluationResult(result, binding), true);

  assert.equal(
    isCartEvaluationResult(result, cartBinding({ graphDigest: 'a'.repeat(64) })),
    false,
    'forged topology digest must be rejected',
  );
  assert.equal(
    isCartEvaluationResult(
      result,
      cartBinding({ graphDigest: null, modelVersion: 'cart-model-v9' }),
    ),
    false,
    'wrong model version must be rejected',
  );
  assert.equal(
    isCartEvaluationResult(
      result,
      cartBinding({ graphDigest: null, pricingVersion: 'cart-pricing-v9' }),
    ),
    false,
    'wrong pricing version must be rejected',
  );
  assert.equal(
    isCartEvaluationResult(
      result,
      cartBinding({ graphDigest: null, seed: CART_DEFAULT_SEED + 1 }),
    ),
    false,
    'wrong seed must be rejected',
  );

  const omitted: CartEvaluation = {
    ...result,
    requiredCases: [...CART_REQUIRED_CASES].slice(0, 1) as never,
  };
  assert.equal(isCartEvaluationResult(omitted, binding), false);

  // The advanced six-case list is not the basic level's required set.
  const advancedSet: CartEvaluation = {
    ...result,
    requiredCases: ['normal', 'peak', 'mobility', 'concurrent', 'partition', 'checkout'] as never,
  };
  assert.equal(isCartEvaluationResult(advancedSet, binding), false);

  const wrongCaseSet: CartEvaluation = {
    ...result,
    cases: result.cases.slice(1),
  };
  assert.equal(isCartEvaluationResult(wrongCaseSet, binding), false);

  const forgedPass: CartEvaluation = {
    ...result,
    complete: true,
    qualified: true,
    scoreCreditsPerHour: 0,
  };
  assert.equal(isCartEvaluationResult(forgedPass, binding), false);

  const wrongLevel: CartEvaluation = { ...result, levelId: 'parcel-pulse' as never };
  assert.equal(isCartEvaluationResult(wrongLevel, binding), false);

  assert.ok(CART_MAX_SEED > 0);
});
