import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IMAGE_CATALOG,
  IMAGE_COMPONENT_LIMITS,
  IMAGE_LEVEL,
  IMAGE_LEVEL_ID,
  IMAGE_MODEL_VERSION,
  IMAGE_PRICING_VERSION,
  IMAGE_REQUIRED_SCENARIOS,
  IMAGE_SCHEMA_VERSION,
  IMAGE_SCENARIOS,
  estimateImageCapacity,
  imageCatalogJsonSchema,
  imageEvaluationJsonSchema,
  imageGraphJsonSchema,
  imageLevelJsonSchema,
  parseImageCatalog,
  parseImageEvaluation,
  parseImageGraph,
  parseImageGraphJson,
  parseImageLevel,
  type ImageBusinessOperation,
  type ImageEvaluation,
  type ImageOperationMetrics,
  type ImageScenarioName,
  type ImageScenarioResult,
  type ImageScenarioWindow,
} from '../index';

function fixture(name: string): unknown {
  const path = resolve(process.cwd(), 'fixtures', 'images', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function graphFixture(name: string) {
  const parsed = parseImageGraph(fixture(name));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error(`fixture ${name} did not parse`);
  }
  return parsed.graph;
}

function operation(
  operation: ImageBusinessOperation,
): ImageOperationMetrics {
  return {
    operation,
    counts: {
      offered: 20_000,
      completed: 20_000,
      onTime: 20_000,
      correct: 20_000,
      success: 20_000,
      failed: 0,
      rejected: 0,
      timedOut: 0,
      incorrect: 0,
      stale: 0,
      missingData: 0,
      duplicateEffects: 0,
      unfinished: 0,
    },
    availability: 1,
    timelyRatio: 1,
    correctnessRatio: 1,
    latencyP50Ms: 10,
    latencyP95Ms: 20,
    latencyP99Ms: 30,
    latencyP999Ms: 40,
    sampleCount: 20_000,
    p999SampleCount: 20_000,
    minimumP999Samples: IMAGE_LEVEL.qualification.minimumP999Samples,
    p999Reliable: true,
    queueWaitP95Ms: 1,
    bytesRead: 1_000,
    bytesWritten: 1_000,
    requestsPerSecondAvg: 100,
    errorsByCode: {},
  };
}

function windowMetrics(fromMs: number, toMs: number): ImageScenarioWindow {
  const windowOperation = () => ({
    offered: 1_000,
    success: 1_000,
    availability: 1,
    latencyP999Ms: 10,
    sampleCount: 1_000,
    availabilityOk: true,
    latencyOk: true,
    passed: true,
  });
  return {
    fromMs,
    toMs,
    operations: {
      upload: windowOperation(),
      search: windowOperation(),
      detail: windowOperation(),
    },
    passed: true,
  };
}

function scenario(name: ImageScenarioName): ImageScenarioResult {
  const incident = name === 'node-failure' || name === 'link-failure' || name.startsWith('region-');
  const fault =
    name === 'node-failure'
      ? {
          kind: 'node' as const,
          atMeasuredMs: 20_000,
          durationMs: 20_000,
          target: 'one-instance-per-pool',
          region: null,
          linkA: null,
          linkB: null,
        }
      : name === 'link-failure'
        ? {
            kind: 'link' as const,
            atMeasuredMs: 20_000,
            durationMs: 20_000,
            target: null,
            region: null,
            linkA: 'na' as const,
            linkB: 'eu' as const,
          }
        : name.startsWith('region-')
          ? {
              kind: 'region' as const,
              atMeasuredMs: 20_000,
              durationMs: 20_000,
              target: null,
              region: name === 'region-na-failure' ? 'na' as const : name === 'region-eu-failure' ? 'eu' as const : 'ap' as const,
              linkA: null,
              linkB: null,
            }
          : {
              kind: 'none' as const,
              atMeasuredMs: null,
              durationMs: null,
              target: null,
              region: null,
              linkA: null,
              linkB: null,
            };
  return {
    name,
    label: name,
    passed: true,
    fault,
    workload: {
      warmupMs: 20_000,
      measuredMs: 60_000,
      drainMs: 10_000,
      demandMultiplier: name === 'normal' ? 1 : 2,
      offered: { upload: 50_000, search: 50_000, detail: 100_000 },
      sampleFactor: 1,
      eventBudget: 12_000_000,
      processedEvents: 200_000,
      exhausted: false,
      hotKeyShare: 0.8,
      hotKeys: 10_000,
      longTailKeys: 1_000_000,
      recentReadProbeShare: 0.01,
      cacheInitialState: 'empty',
      matureDatasetDay: 30,
    },
    operations: {
      upload: operation('upload'),
      search: operation('search'),
      detail: operation('detail'),
    },
    freshness: {
      probes: 500,
      success: 500,
      maxLagMs: 2_000,
      p99LagMs: 1_000,
      limitMs: IMAGE_LEVEL.slo.freshnessMs,
      passed: true,
    },
    dataIntegrity: {
      acknowledgedUploads: 50_000,
      committedUploads: 50_000,
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
      maxAfterLastAckMs: 120_000,
      committedUploads: 50_000,
      acknowledgedUploads: 50_000,
      lostAckCommitted: 0,
      publishedUploads: 50_000,
      unpublishedCommitted: 0,
      maxPublicationLagMs: 2_000,
      publicationDeadlineMs: 190_000,
      backgroundWorkCounted: true,
      includedInMeasuredLoad: false,
      passed: true,
    },
    incidentWindow: incident ? windowMetrics(20_000, 40_000) : null,
    recoveryWindow: incident ? windowMetrics(50_000, 60_000) : null,
    nodes: [],
    links: [],
    checks: [
      {
        id: `scenario:${name}`,
        label: `${name} gate`,
        passed: true,
        severity: 'required',
        message: 'Synthetic contract sample.',
      },
    ],
    diagnostics: [],
  };
}

function completeResult(): ImageEvaluation {
  const graph = graphFixture('directory-direct');
  const estimate = estimateImageCapacity(graph);
  return {
    status: 'complete',
    passed: true,
    meta: {
      schemaVersion: IMAGE_SCHEMA_VERSION,
      modelVersion: IMAGE_MODEL_VERSION,
      contentVersion: IMAGE_LEVEL.contentVersion,
      pricingVersion: IMAGE_PRICING_VERSION,
      levelId: IMAGE_LEVEL_ID,
      seed: 101,
      graphDigest: 'deadbeefdeadbeef',
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
        message: 'All required cases were evaluated at the selected replay seed.',
      },
    ],
    capacity: estimate.capacity,
    cost: { ...estimate.cost, provenance: { ...estimate.cost.provenance, measured: true } },
    assumptions: IMAGE_LEVEL.assumptions,
    scenarios: IMAGE_SCENARIOS.map((name) => scenario(name)),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resultValidator() {
  return new Ajv2020({ strict: false, allErrors: true }).compile(
    imageEvaluationJsonSchema(),
  );
}

describe('Image Atlas result contract', () => {
  const passMutations: [string, (result: ImageEvaluation) => void][] = [
    ['missing graph binding', (r) => { r.meta.graphDigest = null; }],
    ['missing capacity', (r) => { r.capacity = null; }],
    ['failed capacity', (r) => { if (r.capacity) r.capacity.capacityOk = false; }],
    ['failed retention', (r) => { if (r.capacity) r.capacity.retentionOk = false; }],
    ['incomplete topology', (r) => { if (r.capacity) r.capacity.topologyComplete = false; }],
    ['failed store', (r) => { if (r.capacity?.metadataNodes[0]) r.capacity.metadataNodes[0].capacityOk = false; }],
    ['missing cost', (r) => { r.cost = null; }],
    ['failed budget', (r) => { if (r.cost) r.cost.withinBudget = false; }],
    ['forged within-budget flag', (r) => { if (r.cost) r.cost.monthlyUsd = 205_001; }],
    ['unmeasured cost', (r) => { if (r.cost) r.cost.provenance.measured = false; }],
    ['wrong regional fault', (r) => { const c = r.scenarios.find((item) => item.name === 'region-eu-failure'); if (c) c.fault.region = 'na'; }],
  ];

  it.each(passMutations)('rejects a pass with %s in runtime and portable schema', (_name, mutate) => {
    const result = clone(completeResult());
    mutate(result);
    expect(parseImageEvaluation(result).ok).toBe(false);
    expect(resultValidator()(result)).toBe(false);
  });

  it('validates a complete qualification result with Zod and JSON Schema', () => {
    const result = completeResult();
    const parsed = parseImageEvaluation(result);
    expect(parsed.ok).toBe(true);
    const validate = resultValidator();
    expect(validate(result)).toBe(true);
  });

  it('rejects a single-scenario exploratory run that claims a pass', () => {
    const result = clone(completeResult());
    result.meta.requestedScenarios = ['normal'];
    result.meta.qualification = false;
    result.meta.evaluationKind = 'exploratory';
    result.scenarios = [scenario('normal')];
    const parsed = parseImageEvaluation(result);
    expect(parsed.ok).toBe(false);

    const validate = resultValidator();
    expect(validate(result)).toBe(false);
  });

  it('requires the qualification gate and all required scenarios for a pass', () => {
    const noGate = clone(completeResult());
    noGate.checks = [];
    expect(parseImageEvaluation(noGate).ok).toBe(false);

    const missingRegion = clone(completeResult());
    missingRegion.scenarios = missingRegion.scenarios.filter(
      (item) => item.name !== 'region-na-failure',
    );
    expect(parseImageEvaluation(missingRegion).ok).toBe(false);

    const noRecoveryWindow = clone(completeResult());
    const incident = noRecoveryWindow.scenarios.find(
      (item) => item.name.startsWith('region-'),
    );
    if (incident) {
      incident.recoveryWindow = null;
    }
    expect(parseImageEvaluation(noRecoveryWindow).ok).toBe(false);

    const failedRequiredGate = clone(completeResult());
    failedRequiredGate.checks.push({
      id: 'availability:gate',
      label: 'Synthetic failed gate',
      passed: false,
      severity: 'required',
      message: 'Must reject a pass with a failed required gate.',
    });
    expect(parseImageEvaluation(failedRequiredGate).ok).toBe(false);
    expect(resultValidator()(failedRequiredGate)).toBe(false);

    const unpublished = clone(completeResult());
    const postludeScenario = unpublished.scenarios.find(
      (item) => item.name.startsWith('region-'),
    );
    if (postludeScenario) {
      postludeScenario.postlude.unpublishedCommitted = 1;
      postludeScenario.postlude.passed = false;
    }
    expect(parseImageEvaluation(unpublished).ok).toBe(false);

    const noSamples = clone(completeResult());
    noSamples.scenarios[0]!.operations.detail.sampleCount = 0;
    expect(parseImageEvaluation(noSamples).ok).toBe(false);
    expect(resultValidator()(noSamples)).toBe(false);
  });

  it('rejects unknown fields, malformed counts and missing mandatory structure', () => {
    const extra = clone(completeResult()) as unknown as Record<string, unknown>;
    extra.trustMe = true;
    expect(parseImageEvaluation(extra).ok).toBe(false);

    const malformed = clone(completeResult()) as unknown as {
      scenarios: { operations: { upload: { counts: { offered: unknown } } } }[];
    };
    malformed.scenarios[0]!.operations.upload.counts.offered = 'many';
    expect(parseImageEvaluation(malformed).ok).toBe(false);

    const noCounts = clone(completeResult()) as unknown as {
      scenarios: { operations: { upload: { counts: Record<string, unknown> } } }[];
    };
    delete noCounts.scenarios[0]!.operations.upload.counts.success;
    expect(parseImageEvaluation(noCounts).ok).toBe(false);

    const noMeta = clone(completeResult()) as unknown as Record<string, unknown>;
    delete noMeta.meta;
    expect(parseImageEvaluation(noMeta).ok).toBe(false);
  });

  it('accepts an incomplete result only with an explicit bounded reason', () => {
    const complete = completeResult();
    const incomplete = clone(complete) as unknown as Record<string, unknown>;
    incomplete.status = 'incomplete';
    incomplete.passed = false;
    incomplete.scenarios = [];
    (incomplete as { incompleteReason?: unknown }).incompleteReason = {
      code: 'event_budget_exhausted',
      message: 'The bounded event budget was exhausted; this is not a pass.',
    };
    expect(parseImageEvaluation(incomplete).ok).toBe(true);

    delete (incomplete as { incompleteReason?: unknown }).incompleteReason;
    expect(parseImageEvaluation(incomplete).ok).toBe(false);
  });
});

describe('Image Atlas document schemas', () => {
  it('parses the starter and validates it against the graph JSON Schema', () => {
    const parsed = parseImageGraph(fixture('starter'));
    expect(parsed.ok).toBe(true);
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(
      imageGraphJsonSchema(),
    );
    expect(validate(fixture('starter'))).toBe(true);
  });

  it('rejects malformed and adversarial documents atomically', () => {
    for (const input of [
      null,
      [],
      'graph',
      42,
      {},
      { schemaVersion: 1, levelId: 'image-atlas', modelVersion: '1.0.0', nodes: [], edges: [] },
      { schemaVersion: 2, levelId: 'image-atlas', modelVersion: '1.0.0', nodes: [], edges: [] },
      {
        schemaVersion: 1,
        levelId: 'cold-cache',
        modelVersion: '1.0.0',
        nodes: [],
        edges: [],
      },
      {
        schemaVersion: 1,
        levelId: 'image-atlas',
        modelVersion: '1.0.0',
        workload: { users: 1 },
        nodes: [],
        edges: [],
      },
      {
        schemaVersion: 1,
        levelId: 'image-atlas',
        modelVersion: '1.0.0',
        prices: { compute: 0 },
        nodes: [],
        edges: [],
      },
      {
        schemaVersion: 1,
        levelId: 'image-atlas',
        modelVersion: '1.0.0',
        seed: 101,
        nodes: [],
        edges: [],
      },
    ]) {
      const parsed = parseImageGraph(input);
      expect(parsed.ok).toBe(false);
      expect(parsed.issues.length).toBeGreaterThan(0);
    }

    const proto = JSON.parse(
      '{"schemaVersion":1,"levelId":"image-atlas","modelVersion":"1.0.0","__proto__":{"polluted":true},"nodes":[],"edges":[]}',
    ) as unknown;
    const parsed = parseImageGraph(proto);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.map((issue) => issue.code)).toContain('unknown_field');

    const huge = parseImageGraph({
      schemaVersion: 1,
      levelId: 'image-atlas',
      modelVersion: '1.0.0',
      nodes: [],
      edges: [],
      name: 'x'.repeat(81),
    });
    expect(huge.ok).toBe(false);
  });

  it('rejects invalid JSON text and oversized documents without throwing', () => {
    const invalid = parseImageGraphJson('{ nope');
    expect(invalid.ok).toBe(false);
    expect(invalid.issues[0]?.code).toBe('invalid_json');

    const oversized = parseImageGraphJson(
      `"${'x'.repeat(IMAGE_COMPONENT_LIMITS.maxDocumentBytes)}"`,
    );
    expect(oversized.ok).toBe(false);
    expect(oversized.issues[0]?.code).toBe('input_too_large');

    const valid = parseImageGraphJson(JSON.stringify(fixture('starter')));
    expect(valid.ok).toBe(true);
  });

  it('validates the frozen level, catalog and all four JSON Schemas', () => {
    expect(parseImageLevel(IMAGE_LEVEL).ok).toBe(true);
    expect(parseImageCatalog(IMAGE_CATALOG).ok).toBe(true);
    expect(parseImageLevel({ ...IMAGE_LEVEL, budget: 1 }).ok).toBe(false);
    expect(parseImageCatalog({ ...IMAGE_CATALOG, prices: {} }).ok).toBe(false);

    const levelAjv = new Ajv2020({ strict: false, allErrors: true });
    const levelValidate = levelAjv.compile(imageLevelJsonSchema());
    expect(levelValidate(IMAGE_LEVEL)).toBe(true);
    expect(levelValidate({ ...IMAGE_LEVEL, budget: 1 })).toBe(false);

    const catalogAjv = new Ajv2020({ strict: false, allErrors: true });
    const catalogValidate = catalogAjv.compile(imageCatalogJsonSchema());
    expect(catalogValidate(IMAGE_CATALOG)).toBe(true);
    expect(catalogValidate({ ...IMAGE_CATALOG, prices: {} })).toBe(false);
  });

  it('keeps the JSON Schema free of any-passthrough objects at the result root', () => {
    const schema = imageEvaluationJsonSchema() as Record<string, unknown>;
    expect(schema.type).toBeUndefined();
    expect(schema.oneOf).toBeDefined();
    expect(schema.allOf).toBeDefined();
  });
});
