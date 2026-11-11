import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import {
  AUDIENCE_AVAILABILITY_SLO,
  AUDIENCE_CONTENT_VERSION,
  AUDIENCE_FRESHNESS_MS,
  AUDIENCE_LEVEL_ID,
  AUDIENCE_MODEL_VERSION,
  AUDIENCE_PRICING_VERSION,
  AUDIENCE_PROFILE_VERSION,
  AUDIENCE_SCHEMA_VERSION,
  AUDIENCE_SUCCESSFUL_P95_MS,
  audienceAppFailureCaseId,
  audienceRequiredGateSpecs,
  evaluateAudience,
  parseAudienceEvaluation,
  type AudienceCaseResult,
  type AudienceCorrectness,
  type AudienceEvaluation,
  type AudienceFreshness,
  type AudienceGate,
  type AudienceGateSpec,
  type AudienceLinkMetrics,
  type AudienceLinkRole,
  type AudienceNodeMetrics,
  type AudienceOperationMetrics,
} from '../../src/audience/index.js';
import { createApp } from '../src/app.js';
import type { JobSnapshot } from '../src/contracts.js';
import { WorkerEngine } from '../src/engine/index.js';
import type { EngineRunExpectation } from '../../src/simulation/contracts.js';
import {
  audienceRunExpectation,
} from '../../src/simulation/audience-adapter.js';
import {
  isAudienceEvaluationResult,
  type EngineResultBinding,
} from '../src/engine/result-validation.js';
import { parseWorkerMessage } from '../src/engine/protocol.js';

function fixture(relative: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8'),
  ) as unknown;
}

const candidate = fixture('fixtures/audience/family-query-large.json');
const expectation = audienceRunExpectation(candidate);
assert.ok(expectation !== null);

function operation(
  offered: number,
  succeeded: number,
): AudienceOperationMetrics {
  const p95 = succeeded === 0 ? null : 80;
  return {
    offered,
    attempts: offered,
    retries: 0,
    succeeded,
    failed: offered - succeeded,
    rejected: 0,
    timedOut: 0,
    errored: offered - succeeded,
    unknownOutcome: 0,
    pending: 0,
    availability: offered === 0 ? null : succeeded / offered,
    latency: {
      p50Ms: p95,
      p95Ms: p95,
      p99Ms: p95,
      maxMs: p95,
      samples: succeeded,
      insufficientSamples: succeeded < 100,
    },
    bytesOffered: offered * 256,
    bytesDelivered: succeeded * 256,
  };
}

function gateEvidence(
  spec: AudienceGateSpec,
  operations: NonNullable<AudienceCaseResult['operations']>,
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
      actual !== null &&
      actual >= AUDIENCE_AVAILABILITY_SLO;
  } else if (spec.metric === 'successfulP95Ms') {
    actual = cohort?.latency.p95Ms ?? null;
    limit = AUDIENCE_SUCCESSFUL_P95_MS;
    sampleCount = cohort?.latency.samples ?? 0;
    passed =
      cohort !== null &&
      sampleCount >= 100 &&
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
    label: `${nodeId}-${instanceIndex}`,
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
      crashEvents: 0,
      recoveryMs: null,
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
      interrupted: 0,
    },
    instances: Array.from({ length: instances }, (_, index) =>
      instanceMetrics(nodeId, kind, index),
    ),
  };
}

const HOURS = 101_000 / 3_600_000;

const expectedNodes = expectation?.nodes ?? [];
const expectedEdges = expectation?.edges ?? [];
const appNodeId =
  expectedNodes.find((node) => node.kind === 'app')?.id ?? 'app';

/** Presence and identity only; zero traffic is valid for unused links. */
function expectedLinks(): AudienceLinkMetrics[] {
  return expectedEdges.map((edge) => ({
    edgeId: edge.id,
    from: edge.from,
    to: edge.to,
    role: edge.role as AudienceLinkRole,
    requests: { ingest: 0, read: 0, projection: 0 },
    requestsTotal: 0,
    bytesOffered: 0,
    bytesDelivered: 0,
    peakRequestsPerSecond: 0,
    peakBytesPerSecond: 0,
  }));
}

function cost(): NonNullable<AudienceCaseResult['cost']> {
  const lines = [
    { nodeId: 'app', kind: 'app' as const, hourlyUsd: 0.12 },
    { nodeId: 'sql', kind: 'sql' as const, hourlyUsd: 1.28 },
    { nodeId: 'lb', kind: 'lb' as const, hourlyUsd: 0.04 },
  ].map((line) => ({
    ...line,
    hours: HOURS,
    usd: line.hourlyUsd * HOURS,
  }));
  const hourlyUsd = lines.reduce((sum, line) => sum + line.hourlyUsd, 0);
  const rentalUsd = lines.reduce((sum, line) => sum + line.usd, 0);
  const billedBytes = 1_000;
  const bytesUsd = (billedBytes / 1_000_000_000) * 0.02;
  return {
    currency: 'USD',
    hourlyUsd,
    preparationMs: 1_000,
    measuredMs: 90_000,
    drainMs: 10_000,
    billedMs: 101_000,
    rentalUsd,
    billedBytes,
    bytesUsd,
    actualUsd: rentalUsd + bytesUsd,
    lines,
  };
}

function expectedCase(
  id: AudienceCaseResult['id'],
  kind: AudienceCaseResult['kind'],
  targetInstance: number | null,
): AudienceCaseResult {
  const fault = kind === 'app-instance-failure';
  const critical =
    kind === 'normal'
      ? null
      : kind === 'peak'
        ? { fromMs: 20_000, toMs: 60_000 }
        : { fromMs: 30_000, toMs: 50_000 };
  const operations: NonNullable<AudienceCaseResult['operations']> = {
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
    projectionLag: null,
  };
  const snapshot = { asOfMs: 89_990, throughCommitSequence: 100 };
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
            nodeId: appNodeId,
            kind: 'app',
            instanceIndex: targetInstance,
            crashAtMs: 30_000,
            downUntilMs: 45_000,
            detectedUnhealthyAtMs: 30_400,
            readyAtMs: 46_000,
            routeRestoredAtMs: 46_500,
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
      gateEvidence(spec, operations, correctness, freshness),
    ),
    correctness,
    freshness,
    finalSnapshot: snapshot,
    nodes: expectedNodes.map((node) =>
      nodeMetrics(
        node.id,
        node.kind as AudienceNodeMetrics['kind'],
        node.instances,
      ),
    ),
    links: expectedLinks(),
    cost: cost(),
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
        levelId: AUDIENCE_LEVEL_ID,
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
            nodeId: appNodeId,
            instanceIndex: targetInstance,
            message: 'Application process crashed.',
          },
          {
            atMs: 46_000,
            kind: 'ready',
            nodeId: appNodeId,
            instanceIndex: targetInstance,
            message: 'Application process became ready.',
          },
        ]
      : [],
  };
}

function makeEvaluation(): AudienceEvaluation {
  const appInstances = expectation?.provisioning.appInstances ?? 2;
  const cases = [
    expectedCase('normal', 'normal', null),
    expectedCase('peak', 'peak', null),
    ...Array.from({ length: appInstances }, (_, index) =>
      expectedCase(audienceAppFailureCaseId(index), 'app-instance-failure', index),
    ),
  ];
  const peak = cases.find((item) => item.id === 'peak');
  assert.ok(peak?.cost !== null && peak?.cost !== undefined);
  return {
    status: 'complete',
    passed: true,
    levelId: AUDIENCE_LEVEL_ID,
    modelVersion: AUDIENCE_MODEL_VERSION,
    schemaVersion: AUDIENCE_SCHEMA_VERSION,
    contentVersion: AUDIENCE_CONTENT_VERSION,
    pricingVersion: AUDIENCE_PRICING_VERSION,
    profileVersion: AUDIENCE_PROFILE_VERSION,
    seed: 101,
    graphDigest: '0123456789abcdef',
    runId: 'audience-0123456789abcdef-101',
    identity: {
      levelId: AUDIENCE_LEVEL_ID,
      modelVersion: AUDIENCE_MODEL_VERSION,
      schemaVersion: AUDIENCE_SCHEMA_VERSION,
      contentVersion: AUDIENCE_CONTENT_VERSION,
      pricingVersion: AUDIENCE_PRICING_VERSION,
      profileVersion: AUDIENCE_PROFILE_VERSION,
      seed: 101,
      graphDigest: '0123456789abcdef',
      runId: 'audience-0123456789abcdef-101',
    },
    provisioned: {
      appInstances,
      sqlSize: 'large',
      readPlan: 'query',
      cacheTtlSeconds: null,
      workerInstances: 0,
      loadBalancer: true,
    },
    cases,
    score: { eligible: true, costUsd: peak.cost.actualUsd, caseId: 'peak' },
    issues: [],
    incompleteReasons: [],
  };
}

function bindingFor(result: AudienceEvaluation): EngineResultBinding {
  return {
    levelId: AUDIENCE_LEVEL_ID,
    modelVersion: AUDIENCE_MODEL_VERSION,
    schemaVersion: AUDIENCE_SCHEMA_VERSION,
    contentVersion: AUDIENCE_CONTENT_VERSION,
    pricingVersion: AUDIENCE_PRICING_VERSION,
    profileVersion: AUDIENCE_PROFILE_VERSION,
    seed: result.seed,
    graphDigest: result.graphDigest,
    expectation: expectation as EngineRunExpectation,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('Live Audience deep guard accepts a complete exact result', () => {
  const result = makeEvaluation();
  assert.equal(parseAudienceEvaluation(result).ok, true);
  assert.equal(isAudienceEvaluationResult(result, bindingFor(result)), true);
});

test('Live Audience deep guard binds identity, cases and targets to the graph', () => {
  const result = makeEvaluation();
  const binding = bindingFor(result);
  const mutations: [string, unknown, EngineResultBinding][] = [
    ['wrong seed', { ...result, seed: 102 }, binding],
    [
      'wrong identity seed',
      { ...result, identity: { ...result.identity, seed: 102 } },
      binding,
    ],
    [
      'wrong model version',
      { ...result, modelVersion: '9.9.9' },
      { ...binding, modelVersion: '9.9.9' },
    ],
    [
      'wrong content version',
      { ...result, contentVersion: '9.9.9' },
      { ...binding, contentVersion: '9.9.9' },
    ],
    [
      'wrong pricing version',
      { ...result, pricingVersion: 'audience-catalog-v9' },
      { ...binding, pricingVersion: 'audience-catalog-v9' },
    ],
    [
      'wrong profile version',
      { ...result, profileVersion: 'app-resilience-v9' },
      binding,
    ],
    ['wrong graph digest', { ...result, graphDigest: 'forged' }, binding],
    ['missing expectation', result, { ...binding, expectation: undefined }],
    [
      'missing required case',
      { ...result, cases: result.cases.slice(0, -1) },
      binding,
    ],
    [
      'extra case',
      {
        ...result,
        cases: [...result.cases, expectedCase('normal', 'normal', null)],
      },
      binding,
    ],
    [
      'retargeted fault slot',
      {
        ...result,
        cases: result.cases.map((item) =>
          item.id === 'app-failure-1'
            ? {
                ...item,
                targetInstance: 0,
                target: { ...item.target!, instanceIndex: 0 },
              }
            : item,
        ),
      },
      binding,
    ],
    [
      'wrong provisioned size',
      {
        ...result,
        provisioned: { ...result.provisioned!, sqlSize: 'small' },
      },
      binding,
    ],
  ];
  for (const [label, value, candidateBinding] of mutations) {
    assert.equal(
      isAudienceEvaluationResult(value, candidateBinding),
      false,
      `expected rejection: ${label}`,
    );
  }
});

test('Live Audience deep guard binds complete node and link identity to the graph', () => {
  const result = makeEvaluation();
  const binding = bindingFor(result);
  const peak = result.cases.find((item) => item.id === 'peak');
  assert.ok(peak !== undefined);
  const lbId = expectedNodes.find((node) => node.kind === 'lb')?.id;
  assert.ok(lbId !== undefined);
  const firstEdge = expectedEdges[0];
  assert.ok(firstEdge !== undefined);

  const withPeak = (mutate: (item: AudienceCaseResult) => AudienceCaseResult) =>
    ({
      ...result,
      cases: result.cases.map((item) =>
        item.id === 'peak' ? mutate(item) : item,
      ),
    }) as AudienceEvaluation;

  const mutations: [string, AudienceEvaluation][] = [
    [
      'omitted configured node',
      withPeak((item) => ({
        ...item,
        nodes: item.nodes.filter((node) => node.nodeId !== lbId),
      })),
    ],
    [
      'extra unconfigured node',
      withPeak((item) => ({
        ...item,
        nodes: [
          ...item.nodes,
          { ...item.nodes[0]!, nodeId: 'ghost-node' },
        ],
      })),
    ],
    [
      'wrong node kind',
      withPeak((item) => ({
        ...item,
        nodes: item.nodes.map((node) =>
          node.nodeId === lbId ? { ...node, kind: 'cache' as const } : node,
        ),
      })),
    ],
    [
      'wrong node id',
      withPeak((item) => ({
        ...item,
        nodes: item.nodes.map((node) =>
          node.nodeId === lbId ? { ...node, nodeId: 'lb-renamed' } : node,
        ),
      })),
    ],
    [
      'mislabeled instance identity',
      withPeak((item) => ({
        ...item,
        nodes: item.nodes.map((node) =>
          node.nodeId === lbId
            ? {
                ...node,
                instances: node.instances.map((instance) => ({
                  ...instance,
                  nodeId: 'ghost-instance-owner',
                })),
              }
            : node,
        ),
      })),
    ],
    [
      'omitted configured edge',
      withPeak((item) => ({
        ...item,
        links: item.links.filter(
          (link) => link.edgeId !== firstEdge.id,
        ),
      })),
    ],
    [
      'extra unconfigured edge',
      withPeak((item) => ({
        ...item,
        links: [
          ...item.links,
          { ...item.links[0]!, edgeId: 'ghost-edge' },
        ],
      })),
    ],
    [
      'wrong edge role',
      withPeak((item) => ({
        ...item,
        links: item.links.map((link) =>
          link.edgeId === firstEdge.id
            ? {
                ...link,
                role: (link.role === 'primary'
                  ? 'traffic'
                  : 'primary') as AudienceLinkRole,
              }
            : link,
        ),
      })),
    ],
    [
      'wrong edge endpoint',
      withPeak((item) => ({
        ...item,
        links: item.links.map((link) =>
          link.edgeId === firstEdge.id
            ? {
                ...link,
                to: expectedNodes.find((node) => node.id !== link.to)?.id ?? 'x',
              }
            : link,
        ),
      })),
    ],
  ];
  for (const [label, value] of mutations) {
    assert.equal(
      isAudienceEvaluationResult(value, binding),
      false,
      `expected rejection: ${label}`,
    );
  }
});

test('Live Audience deep guard rejects forged gate, audit, cost and score evidence', () => {
  const result = makeEvaluation();
  const binding = bindingFor(result);
  const withCase = (
    id: AudienceCaseResult['id'],
    mutate: (item: AudienceCaseResult) => AudienceCaseResult,
  ): unknown => ({
    ...result,
    cases: result.cases.map((item) => (item.id === id ? mutate(item) : item)),
  });
  const mutations: [string, unknown][] = [
    [
      'forged availability actual',
      withCase('peak', (item) => ({
        ...item,
        gates: item.gates.map((gate) =>
          gate.id === 'read-critical-availability'
            ? { ...gate, actual: 0.5 }
            : gate,
        ),
      })),
    ],
    [
      'forged availability pass',
      withCase('peak', (item) => ({
        ...item,
        gates: item.gates.map((gate) =>
          gate.id === 'read-critical-availability'
            ? { ...gate, passed: true, actual: 0.5 }
            : gate,
        ),
      })),
    ],
    [
      'dropped mandatory gate',
      withCase('peak', (item) => ({
        ...item,
        gates: item.gates.filter((gate) => gate.id !== 'drain-complete'),
      })),
    ],
    [
      'unchecked freshness reads',
      withCase('peak', (item) => ({
        ...item,
        freshness: { ...item.freshness!, checkedReads: 100, samples: 100 },
      })),
    ],
    [
      'unchecked ranking snapshots',
      withCase('peak', (item) => ({
        ...item,
        correctness: { ...item.correctness!, checkedSnapshots: 0 },
      })),
    ],
    [
      'missed expected expiry',
      withCase('peak', (item) => ({
        ...item,
        correctness: { ...item.correctness!, checkedExpiry: 1 },
      })),
    ],
    [
      'cost arithmetic mismatch',
      withCase('peak', (item) => ({
        ...item,
        cost: { ...item.cost!, actualUsd: item.cost!.actualUsd + 1 },
      })),
    ],
    [
      'traffic frame bound to another case',
      withCase('peak', (item) => ({
        ...item,
        trafficFrames: item.trafficFrames.map((frame) => ({
          ...frame,
          scopeId: 'normal' as const,
        })),
      })),
    ],
    [
      'score no longer equals peak cost',
      { ...result, score: { ...result.score, costUsd: 999 } },
    ],
  ];
  for (const [label, value] of mutations) {
    assert.equal(
      isAudienceEvaluationResult(value, binding),
      false,
      `expected rejection: ${label}`,
    );
  }
});

test('Live Audience deep guard accepts an ordinary completed failure', () => {
  const result = makeEvaluation();
  const failed = clone(result);
  const normal = failed.cases.find((item) => item.id === 'normal');
  assert.ok(normal !== undefined);
  normal.operations!.ingest = operation(100, 90);
  normal.correctness = {
    ...normal.correctness!,
    ingestCommitted: 90,
    ingestAcknowledged: 90,
    committedUnacknowledged: 0,
  };
  normal.gates = audienceRequiredGateSpecs('normal').map((spec) =>
    gateEvidence(
      spec,
      normal.operations!,
      normal.correctness!,
      normal.freshness!,
    ),
  );
  normal.passed = false;
  failed.passed = false;
  failed.score = { eligible: false, costUsd: null, caseId: 'peak' };

  assert.equal(parseAudienceEvaluation(failed).ok, true);
  assert.equal(isAudienceEvaluationResult(failed, bindingFor(failed)), true);
});

test('Live Audience deep guard accepts a partial cancelled envelope without evidence', () => {
  const result = makeEvaluation();
  const partial: AudienceCaseResult = {
    ...result.cases[0]!,
    status: 'incomplete',
    passed: false,
    operations: null,
    correctness: null,
    freshness: null,
    gates: [],
    cost: null,
    finalSnapshot: null,
    nodes: [],
    links: [],
    series: [],
    trafficFrames: [],
    incidentTimeline: [],
  };
  const cancelled: AudienceEvaluation = {
    ...result,
    status: 'incomplete',
    passed: false,
    cases: [partial],
    score: { eligible: false, costUsd: null, caseId: 'peak' },
    incompleteReasons: ['bounded event budget exhausted'],
  };
  assert.equal(parseAudienceEvaluation(cancelled).ok, true);
  assert.equal(
    isAudienceEvaluationResult(cancelled, bindingFor(cancelled)),
    true,
  );
});

test('Live Audience deep guard rejects a valid binding downgraded to an invalid result', () => {
  const result = makeEvaluation();
  const binding = bindingFor(result);
  assert.ok(binding.expectation !== undefined);

  const invalidEnvelope = (
    graphDigest: string,
  ): AudienceEvaluation => ({
    ...result,
    status: 'invalid',
    passed: false,
    graphDigest,
    runId: `la1-101-${graphDigest}`,
    identity: {
      ...result.identity,
      graphDigest,
      runId: `la1-101-${graphDigest}`,
    },
    provisioned: null,
    cases: [],
    score: { eligible: false, costUsd: null, caseId: 'peak' },
    issues: [
      {
        severity: 'error',
        code: 'invalid_graph',
        message: 'The graph is not a valid Live Audience design.',
      },
    ],
    incompleteReasons: [],
  });

  // Even a well-formed invalid envelope with an error issue and no evidence
  // cannot downgrade a fully validated input graph to a completed invalid run.
  assert.equal(
    isAudienceEvaluationResult(invalidEnvelope('invalid'), binding),
    false,
  );
  assert.equal(
    isAudienceEvaluationResult(
      invalidEnvelope(result.graphDigest),
      binding,
    ),
    false,
  );
});

test('Live Audience deep guard accepts genuine invalid input without an expectation', () => {
  const result = makeEvaluation();
  const invalid: AudienceEvaluation = {
    ...result,
    status: 'invalid',
    passed: false,
    graphDigest: 'invalid',
    runId: 'la1-101-invalid',
    identity: {
      ...result.identity,
      graphDigest: 'invalid',
      runId: 'la1-101-invalid',
    },
    provisioned: null,
    cases: [],
    score: { eligible: false, costUsd: null, caseId: 'peak' },
    issues: [
      {
        severity: 'error',
        code: 'invalid_graph',
        message: 'The graph is not a valid Live Audience design.',
      },
    ],
    incompleteReasons: [],
  };
  const base = bindingFor(result);
  // Unparseable input: no digest, no graph expectation.
  assert.equal(
    isAudienceEvaluationResult(invalid, {
      ...base,
      graphDigest: null,
      expectation: undefined,
    }),
    true,
  );
  // Semantically invalid but parseable input: digest exists, expectation does
  // not, and the core reports the literal invalid digest.
  assert.equal(
    isAudienceEvaluationResult(invalid, {
      ...base,
      graphDigest: '0123456789abcdef',
      expectation: undefined,
    }),
    true,
  );
});

test('Live Audience deep guard rejects invalid or incomplete envelopes carrying evidence', () => {
  const result = makeEvaluation();
  const binding = bindingFor(result);
  assert.equal(
    isAudienceEvaluationResult(
      { ...result, status: 'invalid' },
      binding,
    ),
    false,
  );
  assert.equal(
    isAudienceEvaluationResult(
      {
        ...result,
        status: 'incomplete',
        passed: false,
        incompleteReasons: [],
      },
      binding,
    ),
    false,
  );
});

test('Live Audience worker protocol rejects a result for another seed', () => {
  const result = makeEvaluation();
  const binding = bindingFor(result);
  const stats = {
    elapsedMs: 1,
    rssBytes: 1,
    heapUsedBytes: 1,
    heapTotalBytes: 1,
    heapSizeLimitBytes: 1,
    externalBytes: 1,
  };
  assert.equal(
    parseWorkerMessage({ type: 'result', result, stats }, binding).ok,
    true,
  );
  assert.equal(
    parseWorkerMessage(
      { type: 'result', result, stats },
      { ...binding, seed: 102 },
    ).ok,
    false,
  );
});

async function makeApp(engine: WorkerEngine): Promise<FastifyInstance> {
  return createApp({ engine, runTimeoutMs: 30_000 });
}

async function request(
  app: FastifyInstance,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined
      ? {}
      : { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.json() };
}

async function waitForJob(
  app: FastifyInstance,
  id: string,
): Promise<JobSnapshot> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await request(app, 'GET', `/v1/evaluations/${id}`);
    const job = response.body as JobSnapshot;
    if (
      job.status === 'completed' ||
      job.status === 'failed' ||
      job.status === 'cancelled'
    ) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('job did not finish in time');
}

test('Live Audience discovery, catalog and schema come from the core', async (t) => {
  const engine = new WorkerEngine();
  const app = await makeApp(engine);
  t.after(async () => {
    await app.close();
    await engine.close();
  });

  const levels = await request(app, 'GET', '/v1/levels');
  assert.equal(levels.status, 200);
  const listed = (levels.body as { levels: { id: string }[] }).levels;
  assert.ok(listed.some((level) => level.id === AUDIENCE_LEVEL_ID));

  const components = await request(
    app,
    'GET',
    `/v1/levels/${AUDIENCE_LEVEL_ID}/components`,
  );
  assert.equal(components.status, 200);
  const catalog = components.body as {
    pricingVersion: string;
    profileVersion: string;
    catalog: {
      components: { sql: { sizes: { large: { hourlyUsd: number } } } };
      work: { queryScanCoreMsPerEvent: number };
      policies: { cache: { retention: string } };
    };
    seeds: { calibration: number[] };
  };
  assert.equal(catalog.pricingVersion, 'audience-catalog-v1');
  assert.equal(catalog.profileVersion, AUDIENCE_PROFILE_VERSION);
  assert.equal(catalog.catalog.components.sql.sizes.large.hourlyUsd, 1.28);
  assert.equal(catalog.catalog.work.queryScanCoreMsPerEvent, 0.00002);
  assert.equal(catalog.catalog.policies.cache.retention, 'selected-ttl');
  assert.equal(catalog.seeds.calibration.length, 5);

  const schema = await request(
    app,
    'GET',
    `/v1/levels/${AUDIENCE_LEVEL_ID}/schema`,
  );
  assert.equal(schema.status, 200);
  assert.equal(
    (schema.body as { properties: { levelId: { const: string } } }).properties
      .levelId.const,
    AUDIENCE_LEVEL_ID,
  );
});

test('Live Audience invalid graph is a completed invalid result, not a failed job', async (t) => {
  const engine = new WorkerEngine();
  const app = await makeApp(engine);
  t.after(async () => {
    await app.close();
    await engine.close();
  });

  const created = await request(app, 'POST', '/v1/evaluations', {
    levelId: AUDIENCE_LEVEL_ID,
    graph: fixture('fixtures/audience/invalid-cross-level.json'),
    seed: 101,
  });
  assert.equal(created.status, 202);
  const job = await waitForJob(
    app,
    (created.body as { id: string }).id,
  );
  assert.equal(job.status, 'completed');
  const result = job.result as AudienceEvaluation;
  assert.equal(result.status, 'invalid');
  assert.equal(result.passed, false);
});

test(
  'Live Audience worker matches the core for a passing family and an ordinary failure',
  {
    skip:
      process.env.AUDIENCE_RUNTIME_TESTS !== '1'
        ? 'heavy draft-core qualification; run with AUDIENCE_RUNTIME_TESTS=1 after final Pro physics'
        : false,
    timeout: 120_000,
  },
  async (t) => {
    const engine = new WorkerEngine();
    const app = await makeApp(engine);
    t.after(async () => {
      await app.close();
      await engine.close();
    });

    for (const [graph, expectedPassed] of [
      [candidate, true],
      [fixture('fixtures/audience/fail-single-app.json'), false],
    ] as const) {
      const direct = evaluateAudience(graph, { seed: 101 });
      assert.equal(direct.status, 'complete');
      assert.equal(direct.passed, expectedPassed);

      const created = await request(app, 'POST', '/v1/evaluations', {
        levelId: AUDIENCE_LEVEL_ID,
        graph,
        seed: 101,
      });
      assert.equal(created.status, 202);
      const job = await waitForJob(
        app,
        (created.body as { id: string }).id,
      );
      assert.equal(job.status, 'completed');
      const result = job.result as AudienceEvaluation;
      assert.equal(result.status, 'complete');
      assert.equal(result.passed, expectedPassed);
      assert.equal(result.identity.levelId, AUDIENCE_LEVEL_ID);
      assert.equal(result.identity.seed, 101);
      assert.equal(result.identity.modelVersion, AUDIENCE_MODEL_VERSION);
      assert.equal(result.identity.pricingVersion, AUDIENCE_PRICING_VERSION);
      assert.equal(JSON.stringify(result), JSON.stringify(direct));
    }
  },
);
