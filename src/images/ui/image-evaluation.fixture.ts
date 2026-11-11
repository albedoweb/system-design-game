/**
 * UI rendering fixture for the results panel.
 *
 * This is NOT a simulation result and proves nothing about balance. It is a
 * contract-valid evaluation document used to render every results section in a
 * component test. The capacity and cost sections are the real analytical
 * estimate of the starter graph, so the panels are exercised with the genuine
 * data shapes of the frozen contracts.
 */
import {
  IMAGE_LEVEL,
  IMAGE_REQUIRED_SCENARIOS,
  estimateImageCapacity,
  type ImageBusinessOperation,
  type ImageEvaluation,
  type ImageOperationMetrics,
  type ImageScenarioName,
  type ImageScenarioResult,
} from '../index';
import { createImageGraph } from '../graph';

const graph = createImageGraph();
const estimate = estimateImageCapacity(graph);

function operationMetrics(
  operation: ImageBusinessOperation,
  offered: number,
  success: number,
): ImageOperationMetrics {
  return {
    operation,
    counts: {
      offered,
      completed: success,
      onTime: success,
      correct: success,
      success,
      failed: offered - success,
      rejected: offered - success,
      timedOut: 0,
      incorrect: 0,
      stale: 0,
      missingData: 0,
      duplicateEffects: 0,
      unfinished: 0,
    },
    availability: offered === 0 ? 0 : success / offered,
    timelyRatio: offered === 0 ? 0 : success / offered,
    correctnessRatio: offered === 0 ? 0 : success / offered,
    latencyP50Ms: 40,
    latencyP95Ms: 120,
    latencyP99Ms: 180,
    latencyP999Ms: 240,
    sampleCount: success,
    p999SampleCount: success,
    minimumP999Samples: 10_000,
    p999Reliable: success >= 10_000,
    queueWaitP95Ms: 12,
    bytesRead: 4e12,
    bytesWritten: 8e11,
    requestsPerSecondAvg: 578,
    errorsByCode: { deadline_exceeded: offered - success },
  };
}

function windowOperation(offered: number, success: number) {
  return {
    offered,
    success,
    availability: offered === 0 ? 0 : success / offered,
    latencyP999Ms: 280,
    sampleCount: success,
    availabilityOk: success / offered >= 0.98,
    latencyOk: true,
    passed: success / offered >= 0.98,
  };
}

function scenario(name: ImageScenarioName, passed: boolean): ImageScenarioResult {
  const fault =
    name === 'node-failure'
        ? { kind: 'node' as const }
      : name === 'link-failure'
        ? { kind: 'link' as const }
        : name.startsWith('region-')
          ? { kind: 'region' as const }
          : { kind: 'none' as const };
  const incident = name !== 'normal' && name !== 'peak';
  const region = name.startsWith('region-')
    ? (name.split('-')[1] as 'na' | 'eu' | 'ap')
    : null;
  const offered = { upload: 12_050, search: 12_050, detail: 24_100 };
  const successor = passed ? 12_000 : 11_800;
  return {
    name,
    label: name,
    passed,
    fault: {
      kind: fault.kind,
      atMeasuredMs: incident ? 20_000 : null,
      durationMs: incident ? 20_000 : null,
      target: name === 'node-failure' ? 'one-instance-per-pool' : null,
      region,
      linkA: name === 'link-failure' ? 'na' : null,
      linkB: name === 'link-failure' ? 'eu' : null,
    },
    workload: {
      warmupMs: 20_000,
      measuredMs: 60_000,
      drainMs: 10_000,
      demandMultiplier: name === 'normal' ? 1 : 2,
      offered,
      sampleFactor: 1,
      eventBudget: 12_000_000,
      processedEvents: 1_000_000,
      exhausted: false,
      hotKeyShare: 0.8,
      hotKeys: 10_000,
      longTailKeys: 1_000_000,
      recentReadProbeShare: 0.01,
      cacheInitialState: 'empty',
      matureDatasetDay: 30,
    },
    operations: {
      upload: operationMetrics('upload', offered.upload, successor),
      search: operationMetrics('search', offered.search, successor),
      detail: operationMetrics('detail', offered.detail, successor * 2),
    },
    freshness: {
      probes: 120,
      success: 120,
      maxLagMs: 4_000,
      p99LagMs: 3_000,
      limitMs: 120_000,
      passed,
    },
    dataIntegrity: {
      acknowledgedUploads: successor,
      committedUploads: successor,
      lostAckCommitted: 0,
      duplicateUploads: 0,
      duplicateEffects: 0,
      missingSearchResults: 0,
      visibilityViolations: 0,
      unpublishedCommitted: 0,
      publicationPassed: passed,
      passed,
    },
    postlude: {
      noNewOffers: true,
      startedAtMs: 90_000,
      lastAckAtMs: 90_500,
      endedAtMs: 210_000,
      maxAfterLastAckMs: 120_000,
      committedUploads: successor,
      acknowledgedUploads: successor,
      lostAckCommitted: 0,
      publishedUploads: successor,
      unpublishedCommitted: 0,
      maxPublicationLagMs: 8_000,
      publicationDeadlineMs: 120_000,
      backgroundWorkCounted: true,
      includedInMeasuredLoad: false,
      passed,
    },
    incidentWindow: incident
      ? {
          fromMs: 20_000,
          toMs: 40_000,
          operations: {
            upload: windowOperation(4_000, 3_950),
            search: windowOperation(4_000, 3_960),
            detail: windowOperation(8_000, 7_940),
          },
          passed,
        }
      : null,
    recoveryWindow: incident
      ? {
          fromMs: 50_000,
          toMs: 60_000,
          operations: {
            upload: windowOperation(2_000, 1_995),
            search: windowOperation(2_000, 1_996),
            detail: windowOperation(4_000, 3_992),
          },
          passed,
        }
      : null,
    nodes: graph.nodes.map((node) => {
      const instances = node.kind === 'client' || node.kind === 'blob' ? 1 : 2;
      return {
      nodeId: node.id,
      kind: node.kind,
      label: node.label,
      region: node.region,
      instances,
      healthyInstances:
        name === 'node-failure' ? Math.max(1, instances - 1) : instances,
      requests: 1_200,
      completed: 1_190,
      errors: 10,
      rejected: 4,
      timedOut: 2,
      cpuUtilizationAvg: 0.52,
      cpuUtilizationPeak: 0.91,
      memoryBytesAvg: 9e9,
      memoryBytesPeak: 15e9,
      memoryLimitBytes: 22e9,
      ioUtilizationAvg: 0.34,
      ioUtilizationPeak: 0.72,
      networkIngressGbitAvg: 1.4,
      networkIngressGbitPeak: 6.1,
      networkEgressGbitAvg: 1.8,
      networkEgressGbitPeak: 8.4,
      queueDepthAvg: 3,
      queueDepthPeak: 22,
      queueWaitP95Ms: 18,
      bytesRead: 2e12,
      bytesWritten: 4e11,
      cache:
        node.kind === 'cache'
          ? {
              hits: 800,
              misses: 200,
              coalesced: 40,
              evictions: 12,
              hitRatio: 0.8,
            }
          : null,
      replication:
        node.kind === 'metadata'
          ? { replicatedWrites: 400, queuedBytes: 2e7, lagMaxMs: 2_500 }
          : null,
      };
    }),
    links: IMAGE_LEVEL.network.interRegionLinks.map((link) => ({
      id: `region-pair-${link.a}-${link.b}`,
      kind: 'region-pair' as const,
      label: `Region pair ${link.a}-${link.b}`,
      regionA: link.a,
      regionB: link.b,
      direction: 'full-duplex' as const,
      capacityGbitPerSec: link.bandwidthGbitPerSec,
      averageUtilization: 0.42,
      peakUtilization: 0.88,
      bytesSent: 3e12,
      bytesReceived: 2.6e12,
      transfers: 5_000,
      queueWaitP95Ms: 9,
    })),
    checks: [
      {
        id: `${name}_detail_p999`,
        label: 'Detail p99.9',
        passed,
        severity: 'required',
        scenario: name,
        operation: 'detail',
        metric: 'latency',
        actual: passed ? 190 : 320,
        limit: 200,
        unit: 'ms',
        sampleCount: successor * 2,
        message: passed
          ? 'Detail p99.9 is inside the normal target.'
          : 'Detail p99.9 exceeds the normal target.',
        ...(passed ? {} : { nodeId: 'app-na' }),
      },
      {
        id: `${name}_capacity`,
        label: 'Capacity',
        passed: true,
        severity: 'required',
        scenario: name,
        metric: 'capacity',
        message: 'Storage and cache capacity fit.',
      },
    ],
    diagnostics: [
      {
        id: `${name}-diag`,
        severity: 'warning',
        code: 'capacity_headroom',
        message: 'Metadata-na headroom is thin at day 30.',
        nodeId: 'metadata-na',
        metric: 'capacity',
        scenario: name,
      },
    ],
  };
}

const scenarios: ImageScenarioResult[] = IMAGE_REQUIRED_SCENARIOS.map((name) =>
  scenario(name, name !== 'peak'),
);

export const imageEvaluationFixture: ImageEvaluation = {
  status: 'complete',
  passed: false,
  meta: {
    schemaVersion: 1,
    modelVersion: IMAGE_LEVEL.modelVersion,
    contentVersion: IMAGE_LEVEL.contentVersion,
    pricingVersion: IMAGE_LEVEL.pricingVersion,
    levelId: 'image-atlas',
    seed: 101,
    graphDigest: 'fixture-digest',
    requestedScenarios: [...IMAGE_REQUIRED_SCENARIOS],
    requiredScenarios: [...IMAGE_REQUIRED_SCENARIOS],
    qualification: true,
    evaluationKind: 'qualification',
    datasetDay: 30,
  },
  issues: [
    {
      severity: 'warning',
      code: 'capacity_headroom',
      message: 'Metadata-na has little headroom at day 30.',
      nodeId: 'metadata-na',
    },
  ],
  diagnostics: [],
  checks: [
    {
      id: 'qualification_scenarios',
      label: 'All required scenarios',
      passed: false,
      severity: 'required',
      message: 'Peak detail p99.9 exceeds its target.',
    },
  ],
  capacity: estimate.capacity,
  cost: estimate.cost,
  assumptions: ['Teaching fixture used for UI rendering, not a simulation result.'],
  scenarios,
};
