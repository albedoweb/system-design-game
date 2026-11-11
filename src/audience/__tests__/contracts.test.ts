import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as audienceIndex from '../index';
import {
  AUDIENCE_AVAILABILITY_SLO,
  AUDIENCE_CATALOG,
  AUDIENCE_FRESHNESS_MS,
  AUDIENCE_LEVEL,
  AUDIENCE_MIN_LATENCY_SAMPLES,
  AUDIENCE_PROFILE_VERSION,
  AUDIENCE_SCHEMA_VERSION,
  AUDIENCE_SUCCESSFUL_P95_MS,
  audienceAppFailureCaseId,
  audienceEvaluationJsonSchema,
  audienceGraphJsonSchema,
  audienceRequiredCaseIds,
  audienceRequiredGateIds,
  audienceRequiredGateSpecs,
  cloneAudienceCatalog,
  cloneAudienceLevel,
  createAudienceChallengeProfile,
  createAudienceStarterGraph,
  parseAudienceCatalog,
  parseAudienceEvaluation,
  parseAudienceGraph,
  parseAudienceLevel,
  validateAudienceGraph,
  audienceGraphDigest,
  type AudienceCaseResult,
  type AudienceCorrectness,
  type AudienceEvaluation,
  type AudienceFreshness,
  type AudienceGate,
  type AudienceGateSpec,
  type AudienceGraph,
  type AudienceNodeMetrics,
  type AudienceOperationMetrics,
} from '../index';

const directory = resolve(process.cwd(), 'fixtures/audience');

function load(name: string): AudienceGraph {
  return JSON.parse(
    readFileSync(resolve(directory, `${name}.json`), 'utf8'),
  ) as AudienceGraph;
}

function errorCodes(graph: AudienceGraph): string[] {
  return validateAudienceGraph(graph)
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.code);
}

function hasErrors(input: unknown): boolean {
  const parsed = parseAudienceGraph(input);
  if (!parsed.ok) {
    return true;
  }
  return errorCodes(parsed.value).length > 0;
}

function operation(succeeded: number, offered: number): AudienceOperationMetrics {
  return {
    offered,
    attempts: offered,
    retries: 0,
    succeeded,
    failed: offered - succeeded,
    rejected: offered - succeeded,
    timedOut: 0,
    errored: 0,
    unknownOutcome: 0,
    pending: 0,
    availability: offered === 0 ? null : succeeded / offered,
    latency: {
      p50Ms: 10,
      p95Ms: 20,
      p99Ms: 30,
      maxMs: 40,
      samples: succeeded,
      insufficientSamples: false,
    },
    bytesOffered: offered * 1_000,
    bytesDelivered: succeeded * 1_000,
  };
}

type CaseOperations = NonNullable<AudienceCaseResult['operations']>;

function buildGate(
  spec: AudienceGateSpec,
  operations: CaseOperations,
  correctness: AudienceCorrectness,
  freshness: AudienceFreshness,
): AudienceGate {
  const cohort =
    spec.window === 'critical'
      ? operations.critical?.[spec.operation ?? 'read'] ?? null
      : operations[spec.operation ?? 'read'];
  let actual: number | null = null;
  let limit: number | null = null;
  let sampleCount = 0;
  let passed: boolean;
  if (spec.metric === 'availability') {
    actual = cohort?.availability ?? null;
    limit = AUDIENCE_AVAILABILITY_SLO;
    sampleCount = cohort?.offered ?? 0;
    passed =
      cohort !== null &&
      cohort.offered > 0 &&
      cohort.availability !== null &&
      cohort.availability >= AUDIENCE_AVAILABILITY_SLO;
  } else if (spec.metric === 'successfulP95Ms') {
    actual = cohort?.latency.p95Ms ?? null;
    limit = AUDIENCE_SUCCESSFUL_P95_MS;
    sampleCount = cohort?.latency.samples ?? 0;
    passed =
      cohort !== null &&
      sampleCount >= AUDIENCE_MIN_LATENCY_SAMPLES &&
      actual !== null &&
      actual <= AUDIENCE_SUCCESSFUL_P95_MS;
  } else if (spec.metric === 'preservation') {
    sampleCount = correctness.ingestAcknowledged;
    passed =
      correctness.lostAcknowledgedEvents === 0 &&
      correctness.duplicateLogicalEvents === 0 &&
      correctness.payloadConflicts === 0;
  } else if (spec.metric === 'exactSnapshotCorrectness') {
    sampleCount = correctness.checkedSnapshots;
    passed = correctness.valid;
  } else if (spec.metric === 'freshnessLagMs') {
    actual = freshness.maxLagMs;
    limit = AUDIENCE_FRESHNESS_MS;
    sampleCount = freshness.checkedReads;
    passed = freshness.valid;
  } else {
    actual = operations.ingest.pending + operations.read.pending;
    limit = 0;
    passed = actual === 0;
  }
  return {
    id: spec.id,
    label: spec.label,
    severity: 'required',
    ...(spec.operation === undefined ? {} : { operation: spec.operation }),
    ...(spec.window === undefined ? {} : { window: spec.window }),
    metric: spec.metric,
    actual,
    limit,
    unit: spec.unit,
    comparison: spec.comparison,
    sampleCount,
    passed,
    message: `${spec.label}: ${passed ? 'passed' : 'failed'}.`,
  };
}

function instanceMetrics(
  nodeId: string,
  kind: AudienceNodeMetrics['kind'],
  instanceIndex: number,
): AudienceNodeMetrics['instances'][number] {
  return {
    nodeId,
    kind,
    instanceIndex,
    label: `${nodeId} ${instanceIndex}`,
    health: 'healthy',
    cpu: {
      capacityCores: 1,
      busyCoresAverage: 0.2,
      busyCoresPeak: 0.8,
      busyCoreMs: 18_000,
      utilizationAverage: 0.2,
      utilizationPeak: 0.8,
    },
    memory: {
      capacityBytes: 8_000_000_000,
      workingSetBytes: 1_000_000_000,
      residentBytesAverage: 100_000_000,
      peakUsedBytes: 200_000_000,
    },
    io: {
      readOperations: 10,
      writeOperations: 100,
      bytesRead: 1_000,
      bytesWritten: 2_000,
      busyMs: 10,
      utilizationAverage: 0.1,
    },
    storage: {
      capacityBytes: 1_000_000_000,
      usedBytes: 100_000_000,
      peakUsedBytes: 200_000_000,
      bytesWritten: 1_000,
      bytesRead: 2_000,
    },
    queue: {
      waitingAverage: 0.1,
      waitingPeak: 1,
      waitMsAverage: 1,
      waitMsMax: 2,
      waitSamples: 5,
      activePeak: 2,
      rejectedOverflow: 0,
      deadlineTimeouts: 0,
    },
    network: {
      capacityGbitPerSec: 1,
      bytesOffered: 1_000,
      bytesDelivered: 900,
      averageGbitPerSec: 0.01,
      peakGbitPerSec: 0.1,
    },
    tasks: {
      submitted: 100,
      completed: 100,
      rejected: 0,
      timedOut: 0,
      interrupted: 0,
    },
  };
}

function nodeMetrics(
  nodeId: string,
  kind: AudienceNodeMetrics['kind'],
  instances: number,
  crashed = false,
): AudienceNodeMetrics {
  return {
    nodeId,
    kind,
    label: nodeId,
    provisionedInstances: instances,
    health: {
      state: 'healthy',
      totalInstances: instances,
      healthyInstances: instances,
      crashEvents: crashed ? 1 : 0,
      recoveryMs: crashed ? 1_100 : null,
    },
    cpu: {
      capacityCores: instances,
      busyCoresAverage: 0.2,
      busyCoresPeak: 0.8,
      busyCoreMs: 18_000,
      utilizationAverage: 0.2,
      utilizationPeak: 0.8,
    },
    memory: {
      capacityBytes: instances * 8_000_000_000,
      workingSetBytes: 1_000_000_000,
      residentBytesAverage: 100_000_000,
      peakUsedBytes: 200_000_000,
    },
    io: {
      readOperations: 10,
      writeOperations: 100,
      bytesRead: 1_000,
      bytesWritten: 2_000,
      busyMs: 10,
      utilizationAverage: 0.1,
    },
    storage: {
      capacityBytes: 1_000_000_000,
      usedBytes: 100_000_000,
      peakUsedBytes: 200_000_000,
      bytesWritten: 1_000,
      bytesRead: 2_000,
    },
    queue: {
      waitingAverage: 0.1,
      waitingPeak: 1,
      waitMsAverage: 1,
      waitMsMax: 2,
      waitSamples: 5,
      activePeak: 2,
      rejectedOverflow: 0,
      deadlineTimeouts: 0,
    },
    network: {
      capacityGbitPerSec: instances,
      bytesOffered: 1_000,
      bytesDelivered: 900,
      averageGbitPerSec: 0.01,
      peakGbitPerSec: 0.1,
    },
    tasks: {
      submitted: 100,
      completed: 100,
      rejected: 0,
      timedOut: 0,
      interrupted: crashed ? 1 : 0,
    },
    instances: Array.from({ length: instances }, (_, index) =>
      instanceMetrics(nodeId, kind, index),
    ),
  };
}

interface EvaluationOptions {
  readonly appInstances?: number;
  readonly readPlan?: 'query' | 'projection';
  readonly loadBalancer?: boolean;
}

function makeEvaluation(options: EvaluationOptions = {}): AudienceEvaluation {
  const appInstances = options.appInstances ?? 2;
  const readPlan = options.readPlan ?? 'query';
  const loadBalancer = options.loadBalancer ?? true;
  const snapshot = { asOfMs: 89_990, throughCommitSequence: 100 };
  const cost = {
    currency: 'USD' as const,
    hourlyUsd: 0.5,
    preparationMs: 1_000,
    measuredMs: 90_000,
    drainMs: 10_000,
    billedMs: 101_000,
    rentalUsd: 0.014,
    billedBytes: 1_000,
    bytesUsd: 0.00002,
    actualUsd: 0.01402,
    lines: [
      {
        nodeId: 'app',
        kind: 'app' as const,
        hourlyUsd: 0.12,
        hours: 0.028,
        usd: 0.00336,
      },
    ],
  };

  const caseResult = (
    id: AudienceCaseResult['id'],
    kind: AudienceCaseResult['kind'],
    targetInstance: number | null,
  ): AudienceCaseResult => {
    const fault = kind === 'app-instance-failure';
    const critical =
      kind === 'normal'
        ? null
        : kind === 'peak'
          ? { fromMs: 20_000, toMs: 60_000 }
          : { fromMs: 30_000, toMs: 50_000 };
    const app = nodeMetrics('app', 'app', appInstances, fault);
    const operations: CaseOperations = {
      ingest: operation(100, 100),
      read: operation(200, 200),
      critical:
        critical === null
          ? null
          : { ingest: operation(100, 100), read: operation(200, 200) },
    };
    const correctness: AudienceCorrectness = {
      valid: true,
      ingestOffered: 100,
      ingestCommitted: 100,
      ingestAcknowledged: 100,
      ingestPending: 0,
      committedUnacknowledged: 0,
      duplicateLogicalEvents: 0,
      lostAcknowledgedEvents: 0,
      retriedLogicalEvents: 0,
      idempotentReplays: 0,
      payloadConflicts: 0,
      unknownCommitOutcomes: 0,
      resolvedUnknownCommitOutcomes: 0,
      commitsSurvivedAppCrash: fault ? 1 : 0,
      commitSequenceHighWater: 100,
      checkedSnapshots: 200,
      snapshotMismatches: 0,
      expectedExpiries: 2,
      checkedExpiry: 2,
      expiryMismatches: 0,
      finalRankingMatchesReference: true,
      finalActivePairs: 40,
      expectedActivePairs: 40,
      projectionLag:
        readPlan === 'projection'
          ? {
              lagEvents: 0,
              lagMs: 0,
              publishedThroughSequence: 100,
              unpublishedJobs: 0,
              heartbeatExpiries: 1,
            }
          : null,
    };
    const freshness: AudienceFreshness = {
      valid: true,
      freshnessLimitMs: 5_000,
      successfulReads: 200,
      checkedReads: 200,
      staleReads: 0,
      wrongWindowReads: 0,
      maxLagMs: 1_000,
      p95LagMs: 900,
      samples: 200,
      latestSnapshot: snapshot,
    };
    return {
      id,
      label: id,
      kind,
      status: 'complete',
      passed: true,
      targetInstance,
      target:
        fault && targetInstance !== null
          ? {
              nodeId: 'app',
              kind: 'app',
              instanceIndex: targetInstance,
              crashAtMs: 30_000,
              downUntilMs: 45_000,
              detectedUnhealthyAtMs: loadBalancer ? 30_400 : null,
              readyAtMs: 46_000,
              routeRestoredAtMs: loadBalancer ? 46_500 : null,
              recoveredAtMs: 47_000,
              healthyAtEnd: true,
              restartCount: 1,
            }
          : null,
      window: {
        measuredStartMs: 0,
        measuredEndMs: 90_000,
        peakStartMs: 20_000,
        peakEndMs: 60_000,
        criticalStartMs: critical?.fromMs ?? null,
        criticalEndMs: critical?.toMs ?? null,
        drainMs: 10_000,
        totalRunMs: 100_000,
      },
      operations,
      gates: audienceRequiredGateSpecs(kind).map((spec) =>
        buildGate(spec, operations, correctness, freshness),
      ),
      correctness,
      freshness,
      finalSnapshot: snapshot,
      nodes: [app],
      links: [],
      cost,
      series: [
        {
          timeMs: 1_000,
          windowMs: 1_000,
          traffic: {
            ingest: { offered: 1, succeeded: 1, failed: 0 },
            read: { offered: 0, succeeded: 0, failed: 0 },
          },
          latency: { ingest: null, read: null },
          nodes: [],
        },
      ],
      trafficFrames: [
        {
          levelId: 'live-audience',
          scopeId: id,
          scopeLabel: id,
          timeMs: 1_000,
          windowMs: 1_000,
          phase: 'measured',
          nodes: [],
          edges: [],
        },
      ],
      incidentTimeline: fault
        ? [
            {
              atMs: 30_000,
              kind: 'crash',
              nodeId: 'app',
              instanceIndex: targetInstance,
              message: 'Application process crashed.',
            },
            {
              atMs: 46_000,
              kind: 'ready',
              nodeId: 'app',
              instanceIndex: targetInstance,
              message: 'Application process became ready.',
            },
          ]
        : [],
    };
  };

  const cases: AudienceCaseResult[] = [
    caseResult('normal', 'normal', null),
    caseResult('peak', 'peak', null),
    ...Array.from({ length: appInstances }, (_, index) =>
      caseResult(
        audienceAppFailureCaseId(index),
        'app-instance-failure',
        index,
      ),
    ),
  ];

  return {
    status: 'complete',
    passed: true,
    levelId: 'live-audience',
    modelVersion: '1.0.0',
    schemaVersion: AUDIENCE_SCHEMA_VERSION,
    contentVersion: '1.0.0',
    pricingVersion: 'audience-catalog-v1',
    profileVersion: AUDIENCE_PROFILE_VERSION,
    seed: 101,
    graphDigest: '0123456789abcdef',
    runId: 'audience-test-101',
    identity: {
      levelId: 'live-audience',
      modelVersion: '1.0.0',
      schemaVersion: AUDIENCE_SCHEMA_VERSION,
      contentVersion: '1.0.0',
      pricingVersion: 'audience-catalog-v1',
      profileVersion: AUDIENCE_PROFILE_VERSION,
      seed: 101,
      graphDigest: '0123456789abcdef',
      runId: 'audience-test-101',
    },
    provisioned: {
      appInstances,
      sqlSize: 'small',
      readPlan,
      cacheTtlSeconds: null,
      workerInstances: readPlan === 'projection' ? 2 : 0,
      loadBalancer,
    },
    cases,
    score: { eligible: true, costUsd: cost.actualUsd, caseId: 'peak' },
    issues: [],
    incompleteReasons: [],
  };
}

describe('Live Audience frozen contracts', () => {
  it('validates the authoritative level and catalog', () => {
    expect(AUDIENCE_LEVEL.id).toBe('live-audience');
    expect(AUDIENCE_LEVEL.workload.topN).toBe(20);
    expect(AUDIENCE_LEVEL.dataset.activityWindowMs).toBe(900_000);
    expect(AUDIENCE_LEVEL.challenges.requiredKinds).toEqual([
      'normal',
      'peak',
      'app-instance-failure',
    ]);
    expect(AUDIENCE_CATALOG.components.sql.sizes.large.cores).toBe(32);
    expect(AUDIENCE_CATALOG.components.cache.ttlOptionsSeconds).toEqual([
      0.5, 2, 5, 15,
    ]);
    expect(AUDIENCE_CATALOG.policies.projection.heartbeatMs).toBe(100);
    expect(AUDIENCE_CATALOG.policies.retry.backoffMs).toBe(25);
    expect(AUDIENCE_CATALOG.policies.schedulerTiePriority).toHaveLength(7);
    expect(parseAudienceLevel(cloneAudienceLevel()).ok).toBe(true);
    expect(parseAudienceCatalog(cloneAudienceCatalog()).ok).toBe(true);
  });

  it('exports the real evaluator and session, never a placeholder', () => {
    expect(audienceGraphJsonSchema().$id).toContain('live-audience-graph');
    expect(audienceEvaluationJsonSchema().$id).toContain(
      'live-audience-result',
    );
    // A101 adds the only real implementation. The starter graph is valid but
    // incomplete for a run, so the evaluator must return an `invalid` document
    // with error issues instead of a fabricated pass.
    const evaluate = audienceIndex.evaluateAudience;
    const createSession = audienceIndex.createAudienceSession;
    expect(typeof evaluate).toBe('function');
    expect(typeof createSession).toBe('function');
    const result = evaluate(audienceIndex.createAudienceStarterGraph());
    expect(result.status).toBe('invalid');
    expect(result.passed).toBe(false);
    expect(result.provisioned).toBeNull();
    expect(result.issues.some((issue) => issue.severity === 'error')).toBe(true);
    const session = createSession(audienceIndex.createAudienceStarterGraph());
    expect(session.done).toBe(true);
    expect(session.result()?.status).toBe('invalid');
    expect(session.totalRequests).toBe(0);
    expect(session.frames()).toEqual([]);
  });

  it('rejects malicious or cross-level graph inputs without throwing', () => {
    const valid = load('family-query-large');
    const cases: unknown[] = [
      null,
      'not-a-graph',
      { ...valid, schemaVersion: 2 },
      { ...valid, levelId: 'live-scoreboard' },
      { ...valid, nodes: [] },
      {
        ...valid,
        nodes: valid.nodes.map((node) =>
          node.kind === 'app'
            ? { ...node, config: { instances: 5 } }
            : node,
        ),
      },
      {
        ...valid,
        nodes: valid.nodes.map((node) =>
          node.kind === 'sql'
            ? { ...node, config: { size: 'xlarge', readPlan: 'query' } }
            : node,
        ),
      },
      {
        ...valid,
        nodes: valid.nodes.map((node) =>
          node.kind === 'app'
            ? { ...node, config: { instances: 2, price: 0 } }
            : node,
        ),
      },
      {
        ...valid,
        nodes: valid.nodes.map((node) =>
          node.kind === 'lb'
            ? { ...node, config: { ttlSeconds: 2 } }
            : node,
        ),
      },
    ];
    for (const input of cases) {
      expect(() => parseAudienceGraph(input)).not.toThrow();
      expect(parseAudienceGraph(input).ok).toBe(false);
    }
  });

  it('keeps the Users-only starter parseable but incomplete for a run', () => {
    const starter = createAudienceStarterGraph();
    expect(parseAudienceGraph(starter).ok).toBe(true);
    expect(errorCodes(starter)).toEqual(
      expect.arrayContaining(['missing-app', 'missing-sql']),
    );
    expect(hasErrors(load('starter'))).toBe(true);
  });

  it('accepts the three intended solution families and candidate negatives', () => {
    for (const name of [
      'family-query-large',
      'family-cache-query',
      'family-projection',
      'fail-single-app',
      'fail-direct-no-lb',
      'fail-small-query',
      'fail-stale-ttl',
    ]) {
      const parsed = parseAudienceGraph(load(name));
      expect(parsed.ok, name).toBe(true);
      expect(errorCodes(parsed.value as AudienceGraph), name).toEqual([]);
    }
  });

  it('rejects every invalid fixture manifest entry', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(directory, 'manifest.json'), 'utf8'),
    ) as {
      fixtures: { file: string; class: string }[];
    };
    for (const entry of manifest.fixtures) {
      const name = entry.file.replace(/\.json$/, '');
      if (entry.class === 'invalid') {
        expect(hasErrors(load(name)), name).toBe(true);
      }
    }
  });

  it('requires a worker for projection and warns about an unused worker', () => {
    expect(errorCodes(load('invalid-projection-without-worker'))).toContain(
      'missing-worker-for-projection',
    );

    const queryGraph = load('family-query-large');
    const withWorker: AudienceGraph = {
      ...queryGraph,
      nodes: [
        ...queryGraph.nodes,
        {
          id: 'worker',
          kind: 'worker',
          label: 'Worker pool',
          position: { x: 800, y: 400 },
          config: { instances: 1 },
        },
      ],
      edges: [
        ...queryGraph.edges,
        { id: 'e-worker-sql', from: 'worker', to: 'sql' },
      ],
    };
    expect(errorCodes(withWorker)).toEqual([]);
    expect(
      validateAudienceGraph(withWorker).some(
        (issue) => issue.code === 'unused-worker' && issue.severity === 'warning',
      ),
    ).toBe(true);
  });

  it('accepts a direct route but rejects both direct and LB routes', () => {
    expect(errorCodes(load('fail-direct-no-lb'))).toEqual([]);
    expect(errorCodes(load('invalid-both-routes'))).toEqual(
      expect.arrayContaining([
        'missing-traffic-link',
        'ambiguous-app-ingress',
      ]),
    );
  });

  it('keeps the semantic digest stable across visual and id-only edits', () => {
    const original = load('family-projection');
    const digest = audienceGraphDigest(original);

    const renamed: AudienceGraph = {
      ...original,
      nodes: [...original.nodes].reverse().map((node) => ({
        ...node,
        id: `x-${node.id}`,
        label: `Renamed ${node.label}`,
        position: { x: node.position.y, y: node.position.x },
        config:
          node.kind === 'sql'
            ? { readPlan: node.config.readPlan, size: node.config.size }
            : node.config,
      })) as AudienceGraph['nodes'],
      edges: [...original.edges].reverse().map((edge) => ({
        id: `x-${edge.id}`,
        from: `x-${edge.from}`,
        to: `x-${edge.to}`,
      })),
    };
    expect(audienceGraphDigest(renamed)).toBe(digest);

    const different: AudienceGraph = {
      ...original,
      nodes: original.nodes.map((node) =>
        node.kind === 'sql'
          ? { ...node, config: { ...node.config, size: 'medium' } }
          : node,
      ) as AudienceGraph['nodes'],
    };
    expect(audienceGraphDigest(different)).not.toBe(digest);
  });

  it('derives required cases and the fault profile from physical slot count', () => {
    expect(audienceRequiredCaseIds(1)).toEqual([
      'normal',
      'peak',
      'app-failure-0',
    ]);
    expect(audienceRequiredCaseIds(4)).toEqual([
      'normal',
      'peak',
      'app-failure-0',
      'app-failure-1',
      'app-failure-2',
      'app-failure-3',
    ]);
    expect(() => audienceRequiredCaseIds(0)).toThrow(RangeError);
    expect(() => audienceRequiredCaseIds(5)).toThrow(RangeError);

    const profile = createAudienceChallengeProfile(2);
    expect(profile.profileVersion).toBe(AUDIENCE_PROFILE_VERSION);
    expect(profile.cases).toHaveLength(4);
    expect(profile.requiredCaseIds).toEqual([
      'normal',
      'peak',
      'app-failure-0',
      'app-failure-1',
    ]);
    expect(profile.cases[2]?.targetInstance).toBe(0);
    expect(profile.cases[3]?.targetInstance).toBe(1);
    expect(profile.cases[2]?.fault?.crashAtMs).toBe(30_000);
  });

  it('accepts a coherent complete evaluation result', () => {
    const parsed = parseAudienceEvaluation(makeEvaluation());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(parsed.issues.map((issue) => issue.message).join('; '));
    }
    expect(parsed.value.score.eligible).toBe(true);
    expect(parsed.value.cases).toHaveLength(4);
  });

  it('accepts a projection result with ordered-prefix lag evidence', () => {
    const parsed = parseAudienceEvaluation(
      makeEvaluation({ readPlan: 'projection' }),
    );
    expect(parsed.ok).toBe(true);
  });

  it('derives a frozen required gate set from the case kind', () => {
    expect(audienceRequiredGateIds('normal')).toHaveLength(8);
    expect(audienceRequiredGateIds('peak')).toHaveLength(12);
    expect(audienceRequiredGateIds('app-instance-failure')).toHaveLength(12);

    const evaluation = makeEvaluation();
    for (const item of evaluation.cases) {
      const expected = [...audienceRequiredGateIds(item.kind)].sort();
      const actual = item.gates
        .filter((gate) => gate.severity === 'required')
        .map((gate) => gate.id)
        .sort();
      expect(actual, item.id).toEqual(expected);
    }
  });

  it('rejects gate omission, forged gate evidence and unbound pass state', () => {
    const omitted = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const omittedCase = omitted.cases.find((item) => item.id === 'peak');
    if (omittedCase === undefined) {
      throw new Error('fixture is missing the peak case');
    }
    omittedCase.gates = omittedCase.gates.filter(
      (gate) => gate.id !== 'read-critical-p95',
    );
    expect(parseAudienceEvaluation(omitted).ok).toBe(false);

    const forged = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const forgedCase = forged.cases.find((item) => item.id === 'peak');
    const availability = forgedCase?.gates.find(
      (gate) => gate.id === 'read-whole-availability',
    );
    if (availability === undefined) {
      throw new Error('fixture is missing the read availability gate');
    }
    availability.actual = 0.999;
    expect(parseAudienceEvaluation(forged).ok).toBe(false);

    const unbound = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const unboundCase = unbound.cases.find((item) => item.id === 'peak');
    if (unboundCase === undefined || unboundCase.correctness === null) {
      throw new Error('fixture is missing peak correctness');
    }
    unboundCase.correctness.valid = false;
    expect(parseAudienceEvaluation(unbound).ok).toBe(false);

    const preservation = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const preservationCase = preservation.cases.find(
      (item) => item.id === 'peak',
    );
    if (
      preservationCase === undefined ||
      preservationCase.correctness === null
    ) {
      throw new Error('fixture is missing peak correctness');
    }
    preservationCase.correctness.lostAcknowledgedEvents = 1;
    preservationCase.correctness.valid = false;
    expect(parseAudienceEvaluation(preservation).ok).toBe(false);
  });

  it('binds traffic frame scopes to the enclosing case identity', () => {
    const wrongId = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const idCase = wrongId.cases.find((item) => item.id === 'peak');
    if (idCase === undefined || idCase.trafficFrames[0] === undefined) {
      throw new Error('fixture is missing a traffic frame');
    }
    idCase.trafficFrames[0].scopeId = 'normal';
    expect(parseAudienceEvaluation(wrongId).ok).toBe(false);

    const wrongLabel = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const labelCase = wrongLabel.cases.find((item) => item.id === 'peak');
    if (labelCase === undefined || labelCase.trafficFrames[0] === undefined) {
      throw new Error('fixture is missing a traffic frame');
    }
    labelCase.trafficFrames[0].scopeLabel = 'Another case';
    expect(parseAudienceEvaluation(wrongLabel).ok).toBe(false);
  });

  it('requires every successful ranking and expected expiry to be audited', () => {
    const uncheckedFreshness = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const freshCase = uncheckedFreshness.cases.find(
      (item) => item.id === 'peak',
    );
    if (freshCase === undefined || freshCase.freshness === null) {
      throw new Error('fixture is missing peak freshness');
    }
    freshCase.freshness.checkedReads = 199;
    expect(parseAudienceEvaluation(uncheckedFreshness).ok).toBe(false);

    const uncheckedSnapshots = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const snapshotCase = uncheckedSnapshots.cases.find(
      (item) => item.id === 'peak',
    );
    if (snapshotCase === undefined || snapshotCase.correctness === null) {
      throw new Error('fixture is missing peak correctness');
    }
    snapshotCase.correctness.checkedSnapshots = 199;
    expect(parseAudienceEvaluation(uncheckedSnapshots).ok).toBe(false);

    const readTraffic = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const readCase = readTraffic.cases.find((item) => item.id === 'peak');
    if (
      readCase === undefined ||
      readCase.freshness === null ||
      readCase.correctness === null
    ) {
      throw new Error('fixture is missing peak read evidence');
    }
    readCase.freshness.successfulReads = 199;
    readCase.freshness.checkedReads = 199;
    readCase.freshness.samples = 199;
    readCase.correctness.checkedSnapshots = 199;
    expect(parseAudienceEvaluation(readTraffic).ok).toBe(false);

    const sampled = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const sampledCase = sampled.cases.find((item) => item.id === 'peak');
    if (sampledCase === undefined || sampledCase.operations === null) {
      throw new Error('fixture is missing peak operations');
    }
    sampledCase.operations.read.latency.samples = 199;
    expect(parseAudienceEvaluation(sampled).ok).toBe(false);

    const missedExpiry = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const expiryCase = missedExpiry.cases.find((item) => item.id === 'peak');
    if (expiryCase === undefined || expiryCase.correctness === null) {
      throw new Error('fixture is missing peak correctness');
    }
    expiryCase.correctness.expectedExpiries = 1;
    expiryCase.correctness.checkedExpiry = 0;
    expiryCase.correctness.expiryMismatches = 0;
    expect(parseAudienceEvaluation(missedExpiry).ok).toBe(false);

    const underAuditedExpiry = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const underAuditedCase = underAuditedExpiry.cases.find(
      (item) => item.id === 'peak',
    );
    if (
      underAuditedCase === undefined ||
      underAuditedCase.correctness === null
    ) {
      throw new Error('fixture is missing peak correctness');
    }
    underAuditedCase.correctness.expectedExpiries = 100;
    underAuditedCase.correctness.checkedExpiry = 1;
    underAuditedCase.correctness.expiryMismatches = 0;
    expect(parseAudienceEvaluation(underAuditedExpiry).ok).toBe(false);

    const noExpiry = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const noExpiryCase = noExpiry.cases.find((item) => item.id === 'peak');
    if (noExpiryCase === undefined || noExpiryCase.correctness === null) {
      throw new Error('fixture is missing peak correctness');
    }
    noExpiryCase.correctness.expectedExpiries = 0;
    noExpiryCase.correctness.checkedExpiry = 0;
    noExpiryCase.correctness.expiryMismatches = 0;
    expect(parseAudienceEvaluation(noExpiry).ok).toBe(true);
  });

  it('conserves logical ingest outcomes and distinguishes resolved unknown commits', () => {
    const offered = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const offeredCase = offered.cases.find((item) => item.id === 'peak');
    if (offeredCase === undefined || offeredCase.correctness === null) {
      throw new Error('fixture is missing peak correctness');
    }
    offeredCase.correctness.ingestOffered = 99;
    expect(parseAudienceEvaluation(offered).ok).toBe(false);

    const acknowledged = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const acknowledgedCase = acknowledged.cases.find(
      (item) => item.id === 'peak',
    );
    if (
      acknowledgedCase === undefined ||
      acknowledgedCase.correctness === null
    ) {
      throw new Error('fixture is missing peak correctness');
    }
    acknowledgedCase.correctness.ingestAcknowledged = 99;
    acknowledgedCase.correctness.committedUnacknowledged = 1;
    expect(parseAudienceEvaluation(acknowledged).ok).toBe(false);

    const retry = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const retryCase = retry.cases.find((item) => item.id === 'peak');
    if (retryCase === undefined || retryCase.correctness === null) {
      throw new Error('fixture is missing peak correctness');
    }
    retryCase.correctness.retriedLogicalEvents = 1;
    expect(parseAudienceEvaluation(retry).ok).toBe(false);

    const unknown = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const unknownCase = unknown.cases.find((item) => item.id === 'peak');
    if (unknownCase === undefined || unknownCase.correctness === null) {
      throw new Error('fixture is missing peak correctness');
    }
    unknownCase.correctness.unknownCommitOutcomes = 1;
    expect(parseAudienceEvaluation(unknown).ok).toBe(false);

    const resolved = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const resolvedCase = resolved.cases.find((item) => item.id === 'peak');
    if (
      resolvedCase === undefined ||
      resolvedCase.correctness === null ||
      resolvedCase.operations === null
    ) {
      throw new Error('fixture is missing peak evidence');
    }
    resolvedCase.operations.ingest.retries = 1;
    resolvedCase.operations.ingest.attempts = 101;
    resolvedCase.correctness.retriedLogicalEvents = 1;
    resolvedCase.correctness.resolvedUnknownCommitOutcomes = 1;
    resolvedCase.correctness.unknownCommitOutcomes = 1;
    expect(parseAudienceEvaluation(resolved).ok).toBe(true);

    const ambiguousTwice = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const twiceCase = ambiguousTwice.cases.find((item) => item.id === 'peak');
    if (
      twiceCase === undefined ||
      twiceCase.correctness === null ||
      twiceCase.freshness === null ||
      twiceCase.operations === null
    ) {
      throw new Error('fixture is missing peak evidence');
    }
    const operations = twiceCase.operations;
    const correctness = twiceCase.correctness;
    const freshness = twiceCase.freshness;
    const ingest = operations.ingest;
    ingest.succeeded = 99;
    ingest.failed = 1;
    ingest.rejected = 0;
    ingest.unknownOutcome = 1;
    ingest.pending = 0;
    ingest.availability = 0.99;
    ingest.latency.samples = 99;
    ingest.attempts = 101;
    ingest.retries = 1;
    ingest.bytesDelivered = 99_000;
    if (operations.critical !== null) {
      operations.critical.ingest = { ...ingest };
    }
    correctness.ingestCommitted = 99;
    correctness.ingestAcknowledged = 99;
    correctness.committedUnacknowledged = 0;
    correctness.retriedLogicalEvents = 1;
    correctness.resolvedUnknownCommitOutcomes = 0;
    correctness.unknownCommitOutcomes = 1;
    twiceCase.passed = false;
    ambiguousTwice.passed = false;
    ambiguousTwice.score = {
      eligible: false,
      costUsd: null,
      caseId: 'peak',
    };
    twiceCase.gates = audienceRequiredGateSpecs(twiceCase.kind).map((spec) =>
      buildGate(spec, operations, correctness, freshness),
    );
    expect(parseAudienceEvaluation(ambiguousTwice).ok).toBe(true);
  });

  it('binds the fault target slot and complete restart lifecycle', () => {
    const slot = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const slotCase = slot.cases.find((item) => item.id === 'app-failure-0');
    if (slotCase === undefined || slotCase.target === null) {
      throw new Error('fixture is missing the fault target');
    }
    slotCase.target.instanceIndex = 1;
    expect(parseAudienceEvaluation(slot).ok).toBe(false);

    const restart = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const restartCase = restart.cases.find(
      (item) => item.id === 'app-failure-0',
    );
    if (restartCase === undefined || restartCase.target === null) {
      throw new Error('fixture is missing the fault target');
    }
    restartCase.target.restartCount = 0;
    expect(parseAudienceEvaluation(restart).ok).toBe(false);
  });

  it('does not invent LB detection on a direct fault path', () => {
    const direct = makeEvaluation({ loadBalancer: false });
    expect(parseAudienceEvaluation(direct).ok).toBe(true);

    const forgedDetection = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const lbCase = forgedDetection.cases.find(
      (item) => item.id === 'app-failure-0',
    );
    if (lbCase === undefined || lbCase.target === null) {
      throw new Error('fixture is missing the fault target');
    }
    lbCase.target.detectedUnhealthyAtMs = null;
    expect(parseAudienceEvaluation(forgedDetection).ok).toBe(false);

    const directRoute = JSON.parse(
      JSON.stringify(makeEvaluation({ loadBalancer: false })),
    ) as AudienceEvaluation;
    const directCase = directRoute.cases.find(
      (item) => item.id === 'app-failure-0',
    );
    if (directCase === undefined || directCase.target === null) {
      throw new Error('fixture is missing the direct fault target');
    }
    directCase.target.routeRestoredAtMs = 46_500;
    expect(parseAudienceEvaluation(directRoute).ok).toBe(false);
  });

  it('allows a complete failed LB fault result without invented recovery', () => {
    const failed = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const fault = failed.cases.find((item) => item.id === 'app-failure-0');
    if (
      fault === undefined ||
      fault.target === null ||
      fault.operations === null ||
      fault.operations.critical === null ||
      fault.correctness === null ||
      fault.freshness === null
    ) {
      throw new Error('fixture is missing the fault case evidence');
    }
    const operations = fault.operations;
    const critical = operations.critical;
    if (critical === null) {
      throw new Error('fixture is missing the critical cohort');
    }
    const correctness = fault.correctness;
    const freshness = fault.freshness;
    critical.read = operation(0, 200);
    fault.target.readyAtMs = null;
    fault.target.routeRestoredAtMs = null;
    fault.target.recoveredAtMs = null;
    fault.target.healthyAtEnd = false;
    fault.incidentTimeline = fault.incidentTimeline.filter(
      (event) => event.kind === 'crash',
    );
    fault.passed = false;
    fault.gates = audienceRequiredGateSpecs(fault.kind).map((spec) =>
      buildGate(spec, operations, correctness, freshness),
    );
    failed.passed = false;
    failed.score = { eligible: false, costUsd: null, caseId: 'peak' };
    expect(parseAudienceEvaluation(failed).ok).toBe(true);
  });

  it('accepts fractional scheduler time in snapshots', () => {
    const evaluation = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const peak = evaluation.cases.find((item) => item.id === 'peak');
    if (
      peak === undefined ||
      peak.finalSnapshot === null ||
      peak.freshness === null ||
      peak.freshness.latestSnapshot === null
    ) {
      throw new Error('fixture is missing snapshot evidence');
    }
    peak.finalSnapshot.asOfMs = 89_990.375;
    peak.freshness.latestSnapshot.asOfMs = 89_990.375;
    expect(parseAudienceEvaluation(evaluation).ok).toBe(true);
  });

  it('bounds the response cursor by the final published projection prefix', () => {
    const lagging = JSON.parse(
      JSON.stringify(makeEvaluation({ readPlan: 'projection' })),
    ) as AudienceEvaluation;
    const laggingCase = lagging.cases.find((item) => item.id === 'peak');
    if (
      laggingCase === undefined ||
      laggingCase.finalSnapshot === null ||
      laggingCase.freshness?.latestSnapshot === null ||
      laggingCase.freshness === null
    ) {
      throw new Error('fixture is missing projection snapshots');
    }
    laggingCase.finalSnapshot.throughCommitSequence = 90;
    laggingCase.freshness.latestSnapshot.throughCommitSequence = 90;
    expect(parseAudienceEvaluation(lagging).ok).toBe(true);

    const ahead = JSON.parse(
      JSON.stringify(makeEvaluation({ readPlan: 'projection' })),
    ) as AudienceEvaluation;
    const aheadCase = ahead.cases.find((item) => item.id === 'peak');
    if (
      aheadCase === undefined ||
      aheadCase.correctness?.projectionLag === null ||
      aheadCase.correctness === null
    ) {
      throw new Error('fixture is missing projection lag');
    }
    aheadCase.correctness.projectionLag.publishedThroughSequence = 90;
    expect(parseAudienceEvaluation(ahead).ok).toBe(false);
  });

  it('keeps cache TTL as the actual retention policy', () => {
    expect(AUDIENCE_CATALOG.policies.cache.retention).toBe('selected-ttl');
    expect(AUDIENCE_CATALOG.policies.cache.responseSnapshot).toBe('original');
    expect(AUDIENCE_CATALOG.policies.cache.eviction).toBe('ttl-only');
    expect(AUDIENCE_CATALOG.policies.cache.deliveryAudit).toBe(
      'freshness-gate',
    );
    expect(AUDIENCE_CATALOG.components.cache.notes).toContain(
      'never secretly clamped',
    );
    expect(AUDIENCE_CATALOG.components.cache.ttlOptionsSeconds).toContain(15);
  });

  it('accepts a completed failing case without inventing successful reads', () => {
    const failed = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const peak = failed.cases.find((item) => item.id === 'peak');
    if (
      peak === undefined ||
      peak.operations === null ||
      peak.correctness === null ||
      peak.freshness === null
    ) {
      throw new Error('fixture is missing peak evidence');
    }
    const operations = peak.operations;
    const correctness = peak.correctness;
    const freshness = peak.freshness;
    failed.passed = false;
    failed.score = { eligible: false, costUsd: null, caseId: 'peak' };
    peak.passed = false;
    operations.read = operation(0, 200);
    if (operations.critical !== null) {
      operations.critical.read = operation(0, 200);
    }
    correctness.checkedSnapshots = 0;
    correctness.finalRankingMatchesReference = null;
    correctness.valid = false;
    freshness.successfulReads = 0;
    freshness.checkedReads = 0;
    freshness.samples = 0;
    freshness.latestSnapshot = null;
    peak.finalSnapshot = null;
    peak.gates = audienceRequiredGateSpecs(peak.kind).map((spec) =>
      buildGate(spec, operations, correctness, freshness),
    );
    expect(parseAudienceEvaluation(failed).ok).toBe(true);
  });

  it('accepts a cancelled fault case before any crash observation', () => {
    const cancelled = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    cancelled.status = 'cancelled';
    cancelled.passed = false;
    cancelled.incompleteReasons = ['Run cancelled before the fault window.'];
    cancelled.score = { eligible: false, costUsd: null, caseId: 'peak' };
    const fault = cancelled.cases.find(
      (item) => item.id === 'app-failure-0',
    );
    if (fault === undefined || fault.target === null) {
      throw new Error('fixture is missing a fault target');
    }
    fault.status = 'cancelled';
    fault.passed = false;
    fault.target = {
      nodeId: 'app',
      kind: 'app',
      instanceIndex: 0,
      crashAtMs: null,
      downUntilMs: null,
      detectedUnhealthyAtMs: null,
      readyAtMs: null,
      routeRestoredAtMs: null,
      recoveredAtMs: null,
      healthyAtEnd: null,
      restartCount: 0,
    };
    fault.incidentTimeline = [];
    expect(parseAudienceEvaluation(cancelled).ok).toBe(true);
  });

  it('rejects missing, duplicate and misidentified required cases', () => {
    const missing = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    missing.cases = missing.cases.filter((item) => item.id !== 'app-failure-1');
    expect(parseAudienceEvaluation(missing).ok).toBe(false);

    const duplicate = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const firstFault = duplicate.cases.find(
      (item) => item.id === 'app-failure-0',
    );
    const secondFault = duplicate.cases.find(
      (item) => item.id === 'app-failure-1',
    );
    if (firstFault === undefined || secondFault === undefined) {
      throw new Error('fixture is missing a fault case');
    }
    secondFault.id = firstFault.id;
    expect(parseAudienceEvaluation(duplicate).ok).toBe(false);

    const misidentified = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const fault = misidentified.cases.find(
      (item) => item.id === 'app-failure-0',
    );
    if (fault === undefined || fault.target === null) {
      throw new Error('fixture is missing its first fault target');
    }
    fault.targetInstance = 1;
    fault.target.instanceIndex = 1;
    expect(parseAudienceEvaluation(misidentified).ok).toBe(false);
  });

  it('rejects status, gate and score contradictions', () => {
    const incomplete = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    incomplete.status = 'incomplete';
    incomplete.incompleteReasons = ['Drain did not finish.'];
    expect(parseAudienceEvaluation(incomplete).ok).toBe(false);

    const gateMismatch = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const gate = gateMismatch.cases[0]?.gates[0];
    if (gate === undefined) {
      throw new Error('fixture is missing a gate');
    }
    gate.passed = false;
    expect(parseAudienceEvaluation(gateMismatch).ok).toBe(false);

    const failedWithPassedGates = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const firstCase = failedWithPassedGates.cases[0];
    if (firstCase === undefined) {
      throw new Error('fixture is missing a case');
    }
    firstCase.passed = false;
    expect(parseAudienceEvaluation(failedWithPassedGates).ok).toBe(false);

    const noScore = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    noScore.score.costUsd = null;
    expect(parseAudienceEvaluation(noScore).ok).toBe(false);

    const wrongScore = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    wrongScore.score.costUsd = 0.5;
    expect(parseAudienceEvaluation(wrongScore).ok).toBe(false);
  });

  it('rejects identity, numeric and snapshot contradictions', () => {
    const identity = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    identity.identity.seed = 202;
    expect(parseAudienceEvaluation(identity).ok).toBe(false);

    const numeric = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const node = numeric.cases[0]?.nodes[0];
    if (node === undefined) {
      throw new Error('fixture is missing node metrics');
    }
    node.cpu.utilizationAverage = Number.POSITIVE_INFINITY;
    expect(parseAudienceEvaluation(numeric).ok).toBe(false);

    const counts = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const op = counts.cases[0]?.operations?.read;
    if (op === undefined) {
      throw new Error('fixture is missing read operations');
    }
    op.offered = 10;
    expect(parseAudienceEvaluation(counts).ok).toBe(false);

    const stale = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const freshness = stale.cases[0]?.freshness;
    if (freshness === undefined || freshness === null) {
      throw new Error('fixture is missing freshness');
    }
    freshness.staleReads = 1;
    expect(parseAudienceEvaluation(stale).ok).toBe(false);

    const snapshot = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    const finalSnapshot = snapshot.cases[0]?.finalSnapshot;
    if (finalSnapshot === null || finalSnapshot === undefined) {
      throw new Error('fixture is missing a final snapshot');
    }
    finalSnapshot.throughCommitSequence = 99;
    expect(parseAudienceEvaluation(snapshot).ok).toBe(false);

    const wrongPlan = JSON.parse(
      JSON.stringify(makeEvaluation()),
    ) as AudienceEvaluation;
    if (wrongPlan.provisioned !== null) {
      wrongPlan.provisioned.readPlan = 'projection';
    }
    expect(parseAudienceEvaluation(wrongPlan).ok).toBe(false);
  });
});
