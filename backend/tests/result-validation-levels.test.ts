import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  IMAGE_BUSINESS_OPERATIONS,
  IMAGE_CONTENT_VERSION,
  IMAGE_LEVEL,
  IMAGE_LEVEL_ID,
  IMAGE_MODEL_VERSION,
  IMAGE_PRICING_VERSION,
  IMAGE_REQUIRED_SCENARIOS,
  IMAGE_SCHEMA_VERSION,
  estimateImageCapacity,
  imageEvaluationSchema,
  parseImageGraph,
  type ImageEvaluation,
  type ImageScenarioResult,
  type ImageScenarioWindow,
} from '../../src/images/index.js';
import { createEngineRegistry } from '../../src/simulation/registry.js';
import {
  CART_DEFAULT_SEED,
  CART_MAX_SEED,
  CART_REQUIRED_CASES,
  CART_VERSIONS,
  evaluateCart,
} from '../../src/cart/index.js';
import { createParcelGraph } from '../../src/parcel/index.js';
import {
  isCartEvaluationResult,
  isColdCacheEvaluationResult,
  isEngineEvaluationResult,
  isImageEvaluationResult,
  type EngineResultBinding,
} from '../src/engine/result-validation.js';

const coldPass = JSON.parse(
  readFileSync(
    new URL('../../tests/calibration/cheap-pass.json', import.meta.url),
    'utf8',
  ),
) as { graph: unknown };
const coldFail = JSON.parse(
  readFileSync(
    new URL('../../tests/calibration/overbudget.json', import.meta.url),
    'utf8',
  ),
) as { graph: unknown };

test('Cold envelope validation rejects a forged pass, missing checks and wrong bindings', () => {
  const registry = createEngineRegistry();
  const outcome = registry.evaluate({
    levelId: 'cold-cache',
    graph: coldPass.graph,
    seed: 101,
  });
  assert.equal(outcome.levelId, 'cold-cache');
  const envelope = outcome.result;
  assert.equal(envelope.status, 'ok');
  if (envelope.status !== 'ok') {
    throw new Error('expected an ok Cold envelope');
  }
  const binding: EngineResultBinding = {
    levelId: 'cold-cache',
    modelVersion: envelope.meta.modelVersion,
    seed: envelope.meta.seed,
    graphDigest: envelope.meta.graphDigest,
  };
  assert.equal(isColdCacheEvaluationResult(envelope, binding), true);

  const firstCheck = envelope.result.checks[0];
  assert.ok(firstCheck !== undefined);

  const failedCheck = {
    ...envelope,
    result: {
      ...envelope.result,
      passed: true,
      checks: [{ ...firstCheck, passed: false }, ...envelope.result.checks.slice(1)],
    },
  };
  assert.equal(isColdCacheEvaluationResult(failedCheck, binding), false);

  const noChecks = {
    ...envelope,
    result: { ...envelope.result, passed: true, checks: [] },
  };
  assert.equal(isColdCacheEvaluationResult(noChecks, binding), false);

  const missingCheck = {
    ...envelope,
    result: {
      ...envelope.result,
      passed: true,
      checks: envelope.result.checks.slice(1),
    },
  };
  assert.equal(isColdCacheEvaluationResult(missingCheck, binding), false);

  const duplicateCheck = {
    ...envelope,
    result: {
      ...envelope.result,
      passed: true,
      checks: [firstCheck, ...envelope.result.checks],
    },
  };
  assert.equal(isColdCacheEvaluationResult(duplicateCheck, binding), false);

  const arbitraryCheckId = {
    ...envelope,
    result: {
      ...envelope.result,
      passed: true,
      checks: [
        { ...firstCheck, id: 'not-a-required-gate' },
        ...envelope.result.checks.slice(1),
      ],
    },
  };
  assert.equal(isColdCacheEvaluationResult(arbitraryCheckId, binding), false);

  const wrongTarget = {
    ...envelope,
    result: {
      ...envelope.result,
      passed: true,
      checks: [
        { ...firstCheck, target: firstCheck.target + 1 },
        ...envelope.result.checks.slice(1),
      ],
    },
  };
  assert.equal(isColdCacheEvaluationResult(wrongTarget, binding), false);

  const wrongUnit = {
    ...envelope,
    result: {
      ...envelope.result,
      passed: true,
      checks: [
        { ...firstCheck, unit: 'ms' },
        ...envelope.result.checks.slice(1),
      ],
    },
  };
  assert.equal(isColdCacheEvaluationResult(wrongUnit, binding), false);

  const readP95 = envelope.result.checks.find(
    (check) => check.id === 'read-p95',
  );
  assert.ok(readP95 !== undefined);
  const thresholdContradiction = {
    ...envelope,
    result: {
      ...envelope.result,
      passed: true,
      checks: envelope.result.checks.map((check) =>
        check.id === 'read-p95'
          ? { ...check, actual: 1e9, passed: true }
          : check,
      ),
    },
  };
  assert.equal(
    isColdCacheEvaluationResult(thresholdContradiction, binding),
    false,
  );

  const snapshotMismatch = {
    ...envelope,
    result: {
      ...envelope.result,
      snapshot: {
        ...envelope.result.snapshot,
        reads: {
          ...(envelope.result.snapshot.reads as unknown as Record<string, unknown>),
          succeeded: 0,
        },
      },
    },
  };
  assert.equal(isColdCacheEvaluationResult(snapshotMismatch, binding), false);

  const costMismatch = {
    ...envelope,
    result: {
      ...envelope.result,
      costMicroUsdPerHour: envelope.result.costMicroUsdPerHour + 1_000_000,
    },
  };
  assert.equal(isColdCacheEvaluationResult(costMismatch, binding), false);

  const envelopeSaysPassed = {
    ...envelope,
    passed: true,
    result: { ...envelope.result, passed: false },
  };
  assert.equal(isColdCacheEvaluationResult(envelopeSaysPassed, binding), false);

  const nullDigest = {
    ...envelope,
    meta: { ...envelope.meta, graphDigest: null },
  };
  assert.equal(isColdCacheEvaluationResult(nullDigest, binding), false);
  assert.equal(
    isColdCacheEvaluationResult(nullDigest, {
      ...binding,
      graphDigest: null,
    }),
    false,
  );

  const pendingSnapshot = {
    ...envelope,
    result: {
      ...envelope.result,
      snapshot: {
        ...envelope.result.snapshot,
        reads: {
          ...envelope.result.snapshot.reads,
          pending: 1,
        },
      },
    },
  };
  assert.equal(isColdCacheEvaluationResult(pendingSnapshot, binding), false);

  const countGapSnapshot = {
    ...envelope,
    result: {
      ...envelope.result,
      snapshot: {
        ...envelope.result.snapshot,
        reads: {
          ...envelope.result.snapshot.reads,
          offered: envelope.result.snapshot.reads.offered + 1,
        },
      },
    },
  };
  assert.equal(isColdCacheEvaluationResult(countGapSnapshot, binding), false);

  const failedOutcome = registry.evaluate({
    levelId: 'cold-cache',
    graph: coldFail.graph,
    seed: 101,
  });
  assert.equal(failedOutcome.levelId, 'cold-cache');
  const failedEnvelope = failedOutcome.result;
  if (failedEnvelope.status !== 'ok') {
    throw new Error('expected an ok failed Cold envelope');
  }
  assert.equal(failedEnvelope.passed, false);
  assert.equal(
    isColdCacheEvaluationResult(failedEnvelope, {
      levelId: 'cold-cache',
      modelVersion: failedEnvelope.meta.modelVersion,
      seed: failedEnvelope.meta.seed,
      graphDigest: failedEnvelope.meta.graphDigest,
    }),
    true,
  );

  assert.equal(
    isColdCacheEvaluationResult(envelope, { ...binding, seed: 202 }),
    false,
  );
  assert.equal(
    isColdCacheEvaluationResult(envelope, { ...binding, graphDigest: 'ffffffffffffffff' }),
    false,
  );
  assert.equal(
    isColdCacheEvaluationResult(envelope, {
      ...binding,
      levelId: 'parcel-pulse',
    }),
    false,
  );
});

const imageGraphFixture = JSON.parse(
  readFileSync(
    new URL('../../fixtures/images/directory-direct.json', import.meta.url),
    'utf8',
  ),
) as unknown;
const parsedImageGraph = parseImageGraph(imageGraphFixture);
if (!parsedImageGraph.ok) {
  throw new Error('The directory-direct Image fixture must parse.');
}
const imageEstimate = estimateImageCapacity(parsedImageGraph.graph);

type ImageOperation = (typeof IMAGE_BUSINESS_OPERATIONS)[number];

function operationCheck(prefix: 'availability' | 'p999', operation: ImageOperation) {
  return {
    id: `${prefix}:${operation}`,
    label: `${operation} ${prefix}`,
    passed: true,
    severity: 'required' as const,
    operation,
    message: 'Synthetic full-gate evidence; not an engine calibration witness.',
  };
}

function scenarioChecks() {
  return IMAGE_BUSINESS_OPERATIONS.flatMap((operation) => [
    operationCheck('availability', operation),
    operationCheck('p999', operation),
  ]);
}

function scenarioFault(
  spec: (typeof IMAGE_LEVEL.qualification.scenarios)[number],
): ImageScenarioResult['fault'] {
  if (spec.fault.kind === 'none') {
    return {
      kind: 'none' as const,
      atMeasuredMs: null,
      durationMs: null,
      target: null,
      region: null,
      linkA: null,
      linkB: null,
    };
  }
  if (spec.fault.kind === 'node') {
    return {
      kind: 'node' as const,
      atMeasuredMs: spec.fault.atMeasuredMs,
      durationMs: spec.fault.durationMs,
      target: spec.fault.target,
      region: null,
      linkA: null,
      linkB: null,
    };
  }
  if (spec.fault.kind === 'link') {
    return {
      kind: 'link' as const,
      atMeasuredMs: spec.fault.atMeasuredMs,
      durationMs: spec.fault.durationMs,
      target: null,
      region: null,
      linkA: spec.fault.a,
      linkB: spec.fault.b,
    };
  }
  return {
    kind: 'region' as const,
    atMeasuredMs: spec.fault.atMeasuredMs,
    durationMs: spec.fault.durationMs,
    target: null,
    region: spec.fault.region,
    linkA: null,
    linkB: null,
  };
}

function passingOperation(operation: ImageOperation) {
  const counts = {
    offered: 10_000,
    completed: 10_000,
    onTime: 10_000,
    correct: 10_000,
    success: 10_000,
    failed: 0,
    rejected: 0,
    timedOut: 0,
    incorrect: 0,
    stale: 0,
    missingData: 0,
    duplicateEffects: 0,
    unfinished: 0,
  };
  return {
    operation,
    counts,
    availability: 1,
    timelyRatio: 1,
    correctnessRatio: 1,
    latencyP50Ms: 1,
    latencyP95Ms: 1,
    latencyP99Ms: 1,
    latencyP999Ms: 1,
    sampleCount: counts.success,
    p999SampleCount: counts.success,
    minimumP999Samples: IMAGE_LEVEL.qualification.minimumP999Samples,
    p999Reliable: true,
    queueWaitP95Ms: 1,
    bytesRead: 0,
    bytesWritten: 0,
    requestsPerSecondAvg: 1,
    errorsByCode: {},
  };
}

function passingWindow(fromMs: number, toMs: number): ImageScenarioWindow {
  const operation = () => ({
    offered: 1_000,
    success: 1_000,
    availability: 1,
    latencyP999Ms: 1,
    sampleCount: 1_000,
    availabilityOk: true,
    latencyOk: true,
    passed: true,
  });
  return {
    fromMs,
    toMs,
    operations: {
      upload: operation(),
      search: operation(),
      detail: operation(),
    },
    passed: true,
  };
}

function imageScenario(name: string): ImageScenarioResult {
  const spec = IMAGE_LEVEL.qualification.scenarios.find(
    (candidate) => candidate.name === name,
  );
  if (spec === undefined) {
    throw new Error(`Missing Image scenario spec ${name}`);
  }
  const incident = spec.fault.kind !== 'none';
  const incidentWindow =
    spec.fault.kind === 'none'
      ? null
      : passingWindow(
          spec.fault.atMeasuredMs,
          spec.fault.atMeasuredMs + spec.fault.durationMs,
        );
  const recoveryStart =
    IMAGE_LEVEL.qualification.measuredMs - IMAGE_LEVEL.slo.recoveryFinalWindowMs;
  return {
    name: spec.name,
    label: spec.label,
    passed: true,
    fault: scenarioFault(spec),
    workload: {
      warmupMs: IMAGE_LEVEL.qualification.warmupMs,
      measuredMs: IMAGE_LEVEL.qualification.measuredMs,
      drainMs: IMAGE_LEVEL.qualification.drainMs,
      demandMultiplier: spec.demandMultiplier,
      offered: { upload: 10_000, search: 10_000, detail: 10_000 },
      sampleFactor: IMAGE_LEVEL.workload.sampleFactor,
      eventBudget: 100_000,
      processedEvents: 30_000,
      exhausted: false,
      hotKeyShare: IMAGE_LEVEL.workload.hotKeyShare,
      hotKeys: IMAGE_LEVEL.workload.hotKeys,
      longTailKeys: IMAGE_LEVEL.workload.longTailRepresentativeKeys,
      recentReadProbeShare: IMAGE_LEVEL.workload.recentReadProbeShare,
      cacheInitialState: 'empty' as const,
      matureDatasetDay: 30 as const,
    },
    operations: {
      upload: passingOperation('upload'),
      search: passingOperation('search'),
      detail: passingOperation('detail'),
    },
    freshness: {
      probes: 100,
      success: 100,
      maxLagMs: 1_000,
      p99LagMs: 1_000,
      limitMs: IMAGE_LEVEL.slo.freshnessMs,
      passed: true,
    },
    dataIntegrity: {
      acknowledgedUploads: 100,
      committedUploads: 100,
      lostAckCommitted: 0,
      duplicateUploads: 0,
      duplicateEffects: 0,
      missingSearchResults: 0,
      visibilityViolations: 0,
      unpublishedCommitted: 0,
      publicationPassed: true,
      passed: true,
    },
    postlude: {
      noNewOffers: true,
      startedAtMs: 70_000,
      lastAckAtMs: 70_000,
      endedAtMs: 190_000,
      maxAfterLastAckMs: IMAGE_LEVEL.slo.globalIndexBoundMs,
      committedUploads: 100,
      acknowledgedUploads: 100,
      lostAckCommitted: 0,
      publishedUploads: 100,
      unpublishedCommitted: 0,
      maxPublicationLagMs: 1_000,
      publicationDeadlineMs: 190_000,
      backgroundWorkCounted: true,
      includedInMeasuredLoad: false,
      passed: true,
    },
    incidentWindow,
    recoveryWindow: incident ? passingWindow(recoveryStart, IMAGE_LEVEL.qualification.measuredMs) : null,
    nodes: [],
    links: [],
    checks: scenarioChecks(),
    diagnostics: [],
  };
}

/**
 * Synthetic full-gate result used only to exercise the backend pass guard.
 * Capacity/cost come from the real frozen estimate for `directory-direct`, but
 * the workload/SLO values are a contract fixture, not an engine calibration or
 * a claim that this graph passes in a real evaluator.
 */
function imageCompleteFixture(passed = true): ImageEvaluation {
  return {
    status: 'complete',
    passed,
    meta: {
      schemaVersion: IMAGE_SCHEMA_VERSION,
      modelVersion: IMAGE_MODEL_VERSION,
      contentVersion: IMAGE_CONTENT_VERSION,
      pricingVersion: IMAGE_PRICING_VERSION,
      levelId: IMAGE_LEVEL_ID,
      seed: 101,
      graphDigest: 'abc123',
      requestedScenarios: [...IMAGE_REQUIRED_SCENARIOS],
      requiredScenarios: [...IMAGE_REQUIRED_SCENARIOS],
      qualification: true,
      evaluationKind: 'qualification',
      datasetDay: 30,
    },
    issues: [],
    diagnostics: [],
    checks: [
      {
        id: 'qualification_scenarios',
        label: 'All required scenarios',
        passed: true,
        severity: 'required',
        message: 'Synthetic contract gate.',
      },
    ],
    capacity: JSON.parse(JSON.stringify(imageEstimate.capacity)),
    cost: {
      ...JSON.parse(JSON.stringify(imageEstimate.cost)),
      provenance: {
        ...imageEstimate.cost.provenance,
        measured: true,
      },
    },
    assumptions: [...IMAGE_LEVEL.assumptions],
    scenarios: IMAGE_LEVEL.qualification.requiredScenarios.map((name) =>
      imageScenario(name),
    ),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('Image pass validation checks frozen SLOs, per-operation gates and integrity evidence', () => {
  const binding: EngineResultBinding = {
    levelId: IMAGE_LEVEL_ID,
    modelVersion: IMAGE_MODEL_VERSION,
    seed: 101,
    graphDigest: 'abc123',
  };
  const passing = imageCompleteFixture(true);
  assert.equal(isImageEvaluationResult(passing, binding), true);
  assert.equal(
    isImageEvaluationResult(imageCompleteFixture(false), binding),
    true,
  );

  const normal = (result: ImageEvaluation) => {
    const scenario = result.scenarios.find((item) => item.name === 'normal');
    assert.ok(scenario !== undefined);
    return scenario;
  };
  const incident = (result: ImageEvaluation) => {
    const scenario = result.scenarios.find(
      (item) => item.name === 'node-failure',
    );
    assert.ok(scenario !== undefined);
    return scenario;
  };

  const mutations: [string, (result: ImageEvaluation) => void][] = [
    [
      'p99.9 above the frozen target',
      (result) => {
        normal(result).operations.detail.latencyP999Ms = 1e9;
      },
    ],
    [
      'availability below the frozen target with balanced counts',
      (result) => {
        const metrics = normal(result).operations.detail;
        metrics.counts.offered = 10_000;
        metrics.counts.success = 9_850;
        metrics.counts.onTime = 9_850;
        metrics.counts.correct = 9_850;
        metrics.counts.failed = 150;
        metrics.availability = 0.985;
        metrics.timelyRatio = 0.985;
        metrics.correctnessRatio = 0.985;
        metrics.sampleCount = 9_850;
        metrics.p999SampleCount = 9_850;
        metrics.p999Reliable = false;
      },
    ],
    [
      'missing required per-operation check',
      (result) => {
        normal(result).checks = normal(result).checks.filter(
          (check) => check.id !== 'availability:detail',
        );
      },
    ],
    [
      'replaced required per-operation check',
      (result) => {
        const check = normal(result).checks.find(
          (item) => item.id === 'availability:detail',
        );
        assert.ok(check !== undefined);
        check.id = 'availability:replaced';
      },
    ],
    [
      'incident window availability contradicted by its pass flag',
      (result) => {
        const window = incident(result).incidentWindow;
        assert.ok(window !== null);
        window.operations.detail.availability = 0.5;
        window.operations.detail.availabilityOk = true;
        window.operations.detail.passed = true;
      },
    ],
    [
      'recovery window latency contradicted by its pass flag',
      (result) => {
        const window = incident(result).recoveryWindow;
        assert.ok(window !== null);
        window.operations.search.latencyP999Ms = 1e9;
        window.operations.search.latencyOk = true;
        window.operations.search.passed = true;
      },
    ],
    [
      'freshness limit not bound to the frozen level',
      (result) => {
        normal(result).freshness.limitMs = 1;
      },
    ],
    [
      'zero freshness probes',
      (result) => {
        normal(result).freshness.probes = 0;
        normal(result).freshness.success = 0;
      },
    ],
    [
      'publication lag above the frozen bound',
      (result) => {
        normal(result).postlude.maxPublicationLagMs =
          IMAGE_LEVEL.slo.globalIndexBoundMs + 1;
      },
    ],
    [
      'data-integrity violation',
      (result) => {
        normal(result).dataIntegrity.duplicateEffects = 1;
      },
    ],
    [
      'workload sample factor not 1',
      (result) => {
        normal(result).workload.sampleFactor = 2;
      },
    ],
    [
      'minimum p99.9 samples metadata altered',
      (result) => {
        normal(result).operations.detail.minimumP999Samples = 0;
      },
    ],
    [
      'too few successful p99.9 samples',
      (result) => {
        normal(result).operations.search.p999SampleCount = 1;
        normal(result).operations.search.p999Reliable = false;
      },
    ],
    [
      'detail evidence relabeled as upload with a latency between the two targets',
      (result) => {
        const metrics = normal(result).operations.detail;
        metrics.operation = 'upload';
        metrics.latencyP999Ms =
          (IMAGE_LEVEL.slo.normal.detailP999Ms +
            IMAGE_LEVEL.slo.normal.uploadP999Ms) /
          2;
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    const candidate = clone(passing);
    mutate(candidate);
    assert.equal(
      imageEvaluationSchema.safeParse(candidate).success,
      true,
      `${name} must remain schema-valid so the backend guard is exercised`,
    );
    assert.equal(
      isImageEvaluationResult(candidate, binding),
      false,
      name,
    );
  }

  const incidentWindowMutations: [string, (result: ImageEvaluation) => void][] = [
    [
      'empty incident window',
      (result) => {
        const window = incident(result).incidentWindow;
        assert.ok(window !== null);
        window.operations.detail.offered = 0;
        window.operations.detail.success = 0;
        window.operations.detail.sampleCount = 0;
        window.operations.detail.availability = 1;
        window.operations.detail.availabilityOk = true;
        window.operations.detail.passed = true;
      },
    ],
    [
      'incident window not aligned to the frozen fault interval',
      (result) => {
        const window = incident(result).incidentWindow;
        assert.ok(window !== null);
        window.fromMs += 1;
      },
    ],
    [
      'recovery window not aligned to the frozen final interval',
      (result) => {
        const window = incident(result).recoveryWindow;
        assert.ok(window !== null);
        window.fromMs -= 1;
      },
    ],
    [
      'window availability not recomputed from success / offered',
      (result) => {
        const window = incident(result).incidentWindow;
        assert.ok(window !== null);
        window.operations.detail.offered = 2_000;
        window.operations.detail.availability = 1;
      },
    ],
    [
      'window success greater than offered',
      (result) => {
        const window = incident(result).incidentWindow;
        assert.ok(window !== null);
        window.operations.search.success = 2_000;
        window.operations.search.sampleCount = 2_000;
      },
    ],
    [
      'window sample count does not equal success',
      (result) => {
        const window = incident(result).incidentWindow;
        assert.ok(window !== null);
        window.operations.upload.sampleCount = 999;
      },
    ],
    [
      'window count exceeds the whole case count',
      (result) => {
        const window = incident(result).incidentWindow;
        assert.ok(window !== null);
        window.operations.detail.offered = 20_000;
        window.operations.detail.success = 20_000;
        window.operations.detail.sampleCount = 20_000;
      },
    ],
    [
      'incident and recovery counts together exceed the whole case count',
      (result) => {
        const incidentWindow = incident(result).incidentWindow;
        const recoveryWindow = incident(result).recoveryWindow;
        assert.ok(incidentWindow !== null);
        assert.ok(recoveryWindow !== null);
        for (const operation of ['upload', 'search', 'detail'] as const) {
          incidentWindow.operations[operation].offered = 6_000;
          incidentWindow.operations[operation].success = 6_000;
          incidentWindow.operations[operation].sampleCount = 6_000;
          recoveryWindow.operations[operation].offered = 6_000;
          recoveryWindow.operations[operation].success = 6_000;
          recoveryWindow.operations[operation].sampleCount = 6_000;
        }
      },
    ],
  ];
  for (const [name, mutate] of incidentWindowMutations) {
    const candidate = clone(passing);
    mutate(candidate);
    assert.equal(
      imageEvaluationSchema.safeParse(candidate).success,
      true,
      `${name} must remain schema-valid so the backend guard is exercised`,
    );
    assert.equal(
      isImageEvaluationResult(candidate, binding),
      false,
      name,
    );
  }

  for (const key of IMAGE_BUSINESS_OPERATIONS) {
    for (const label of IMAGE_BUSINESS_OPERATIONS) {
      if (label === key) {
        continue;
      }
      const candidate = clone(passing);
      normal(candidate).operations[key].operation = label;
      assert.equal(
        imageEvaluationSchema.safeParse(candidate).success,
        true,
        `${key} relabeled as ${label} must remain schema-valid`,
      );
      assert.equal(
        isImageEvaluationResult(candidate, binding),
        false,
        `${key} evidence must not use the ${label} operation label`,
      );
    }
  }

  // Freshness probes are consistency assertions, not a demand that every
  // recent business attempt succeeds during an outage. A failed probe attempt
  // already counts in business availability and must not force 100% freshness
  // success on a passing result.
  const tolerantFreshness = clone(passing);
  normal(tolerantFreshness).freshness.success = 99;
  assert.equal(isImageEvaluationResult(tolerantFreshness, binding), true);

  assert.equal(
    isImageEvaluationResult(passing, { ...binding, seed: 202 }),
    false,
  );
  assert.equal(
    isImageEvaluationResult(passing, {
      ...binding,
      graphDigest: 'ffffffffffffffff',
    }),
    false,
  );
  assert.equal(
    isImageEvaluationResult(passing, {
      ...binding,
      modelVersion: '9.9.9',
    }),
    false,
  );
  assert.equal(
    isImageEvaluationResult(passing, {
      ...binding,
      levelId: 'parcel-pulse',
    }),
    false,
  );

  const missingCase = clone(passing);
  missingCase.scenarios = missingCase.scenarios.filter(
    (scenario) => scenario.name !== 'normal',
  );
  assert.equal(isImageEvaluationResult(missingCase, binding), false);

  const exploratory = clone(passing);
  exploratory.meta.qualification = false;
  exploratory.meta.evaluationKind = 'exploratory';
  assert.equal(isImageEvaluationResult(exploratory, binding), false);

  const invalid = {
    status: 'invalid',
    passed: false,
    meta: passing.meta,
    issues: [
      { severity: 'error', code: 'invalid_graph', message: 'bad graph' },
    ],
    diagnostics: [],
    checks: [],
    capacity: null,
    cost: null,
    assumptions: ['fixture only'],
    scenarios: [],
  };
  assert.equal(isImageEvaluationResult(invalid, binding), true);
  assert.equal(
    isImageEvaluationResult({ ...invalid, passed: true }, binding),
    false,
  );
});

test('Global Cart dispatch binds versions, seed, topology digest and the six cases', () => {
  const result = evaluateCart(createParcelGraph(), { seed: CART_DEFAULT_SEED });
  const binding: EngineResultBinding = {
    levelId: 'global-cart',
    modelVersion: CART_VERSIONS.model,
    schemaVersion: 1,
    contentVersion: CART_VERSIONS.content,
    pricingVersion: CART_VERSIONS.pricing,
    profileVersion: CART_VERSIONS.profile,
    seed: CART_DEFAULT_SEED,
    graphDigest: null,
    requiredCaseIds: [...CART_REQUIRED_CASES],
  };
  assert.equal(
    isEngineEvaluationResult('global-cart', result, binding),
    true,
  );
  assert.equal(
    isEngineEvaluationResult('global-cart', result, {
      ...binding,
      modelVersion: 'cart-model-v9',
    }),
    false,
  );
  assert.equal(
    isEngineEvaluationResult('global-cart', result, {
      ...binding,
      requiredCaseIds: [...CART_REQUIRED_CASES].slice(1),
    }),
    false,
  );
  assert.equal(
    isEngineEvaluationResult('global-cart', result, {
      ...binding,
      graphDigest: 'b'.repeat(64),
    }),
    false,
  );
  assert.equal(
    isEngineEvaluationResult('pass-grid-v1', result, binding),
    false,
  );
  assert.deepEqual(
    result.cases.map((item) => item.id),
    [...CART_REQUIRED_CASES],
  );
  assert.equal(isCartEvaluationResult(result, binding), true);
  assert.ok(CART_MAX_SEED >= CART_DEFAULT_SEED);
});
