import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  audienceGraphDigest,
  parseAudienceGraph,
  type AudienceCaseResult,
  type AudienceEvaluation,
  type AudienceNodeMetrics,
  type AudienceSeriesPoint,
  type AudienceTrafficFrame,
} from '../index';
import projectionFixture from '../../../fixtures/audience/family-projection.json';
import { AudienceResultsPanel } from './AudienceResultsPanel';
import { useAudienceStore } from './audience-store';

function metric(
  nodeId: string,
  kind: 'users' | 'app' | 'sql',
  instances = 1,
  health: 'healthy' | 'crashed' = 'healthy',
): AudienceNodeMetrics {
  return {
    nodeId,
    kind,
    label: nodeId,
    provisionedInstances: instances,
    health: {
      state: health === 'healthy' ? 'healthy' : 'degraded',
      totalInstances: instances,
      healthyInstances: health === 'healthy' ? instances : instances - 1,
      crashEvents: health === 'healthy' ? 0 : 1,
      recoveryMs: health === 'healthy' ? null : 1_000,
    },
    cpu: {
      capacityCores: 1,
      busyCoresAverage: 0.5,
      busyCoresPeak: 1,
      busyCoreMs: 500,
      utilizationAverage: 0.5,
      utilizationPeak: 1,
    },
    memory: {
      capacityBytes: 1_000,
      workingSetBytes: 500,
      residentBytesAverage: 400,
      peakUsedBytes: 600,
    },
    io: {
      readOperations: 1,
      writeOperations: 1,
      bytesRead: 1,
      bytesWritten: 1,
      busyMs: 1,
      utilizationAverage: 0.1,
    },
    storage: {
      capacityBytes: 1_000,
      usedBytes: 400,
      peakUsedBytes: 400,
      bytesWritten: 1,
      bytesRead: 1,
    },
    queue: {
      waitingAverage: 1,
      waitingPeak: 2,
      waitMsAverage: 1,
      waitMsMax: 2,
      waitSamples: 1,
      activePeak: 1,
      rejectedOverflow: 0,
      deadlineTimeouts: 0,
    },
    network: {
      capacityGbitPerSec: 1,
      bytesOffered: 1,
      bytesDelivered: 1,
      averageGbitPerSec: 0.1,
      peakGbitPerSec: 0.2,
    },
    tasks: {
      submitted: 2,
      completed: 2,
      rejected: 0,
      timedOut: 0,
      interrupted: 0,
    },
    instances: Array.from({ length: instances }, (_, instanceIndex) => ({
      nodeId,
      kind,
      instanceIndex,
      label: `${nodeId} ${instanceIndex}`,
      health: health === 'healthy' || instanceIndex > 0 ? 'healthy' : 'crashed',
      cpu: {
        capacityCores: 1,
        busyCoresAverage: 0.5,
        busyCoresPeak: 1,
        busyCoreMs: 500,
        utilizationAverage: 0.5,
        utilizationPeak: 1,
      },
      memory: {
        capacityBytes: 1_000,
        workingSetBytes: 500,
        residentBytesAverage: 400,
        peakUsedBytes: 600,
      },
      io: {
        readOperations: 1,
        writeOperations: 1,
        bytesRead: 1,
        bytesWritten: 1,
        busyMs: 1,
        utilizationAverage: 0.1,
      },
      storage: {
        capacityBytes: 1_000,
        usedBytes: 400,
        peakUsedBytes: 400,
        bytesWritten: 1,
        bytesRead: 1,
      },
      queue: {
        waitingAverage: 1,
        waitingPeak: 2,
        waitMsAverage: 1,
        waitMsMax: 2,
        waitSamples: 1,
        activePeak: 1,
        rejectedOverflow: 0,
        deadlineTimeouts: 0,
      },
      network: {
        capacityGbitPerSec: 1,
        bytesOffered: 1,
        bytesDelivered: 1,
        averageGbitPerSec: 0.1,
        peakGbitPerSec: 0.2,
      },
      tasks: {
        submitted: 2,
        completed: 2,
        rejected: 0,
        timedOut: 0,
        interrupted: 0,
      },
    })),
  };
}

function seriesPoint(
  timeMs: number,
  framesId: string,
  overrides: Partial<AudienceSeriesPoint> = {},
): AudienceSeriesPoint {
  return {
    timeMs,
    windowMs: 1_000,
    traffic: {
      ingest: { offered: 2_000, succeeded: 2_000, failed: 0 },
      read: { offered: 10, succeeded: 10, failed: 0 },
    },
    latency: {
      ingest: { p50Ms: 5, p95Ms: 20, p99Ms: 30, samples: 2_000 },
      read: { p50Ms: 10, p95Ms: 40, p99Ms: 50, samples: 10 },
    },
    nodes: [
      {
        nodeId: framesId,
        instanceIndex: null,
        healthy: true,
        cpuUtilization: 0.5,
        ramUsedBytes: 1_000,
        queueWaiting: 1,
        networkGbitPerSec: 0.1,
      },
    ],
    ...overrides,
  };
}

function trafficFrame(
  id: 'normal' | 'peak' | 'app-failure-0' | 'app-failure-1',
  timeMs: number,
): AudienceTrafficFrame {
  return {
    levelId: 'live-audience',
    scopeId: id,
    scopeLabel: id,
    timeMs,
    windowMs: 1_000,
    phase: 'measured',
    nodes: [],
    edges: [],
  };
}

function caseResult(
  id: 'normal' | 'peak' | 'app-failure-0' | 'app-failure-1',
  passed = true,
): AudienceCaseResult {
  const isFault = id !== 'normal' && id !== 'peak';
  const faultInstance = isFault
    ? Number(id.slice('app-failure-'.length))
    : null;
  return {
    id,
    label: id,
    kind:
      id === 'normal'
        ? 'normal'
        : id === 'peak'
          ? 'peak'
          : 'app-instance-failure',
    status: 'complete',
    passed,
    targetInstance: faultInstance,
    target:
      faultInstance === null
        ? null
        : {
            nodeId: 'app',
            kind: 'app',
            instanceIndex: faultInstance,
            crashAtMs: 30_000,
            downUntilMs: 45_000,
            detectedUnhealthyAtMs: null,
            readyAtMs: 46_500,
            routeRestoredAtMs: 47_000,
            recoveredAtMs: 47_000,
            healthyAtEnd: true,
            restartCount: 1,
          },
    window: {
      measuredStartMs: 0,
      measuredEndMs: 90_000,
      peakStartMs: 20_000,
      peakEndMs: 60_000,
      criticalStartMs: isFault ? 30_000 : id === 'peak' ? 20_000 : null,
      criticalEndMs: isFault ? 50_000 : id === 'peak' ? 60_000 : null,
      drainMs: 10_000,
      totalRunMs: 100_000,
    },
    operations: {
      ingest: {
        offered: 180_000,
        attempts: 180_000,
        retries: 0,
        succeeded: 180_000,
        failed: 0,
        rejected: 0,
        timedOut: 0,
        errored: 0,
        unknownOutcome: 0,
        pending: 0,
        availability: 1,
        latency: {
          p50Ms: 5,
          p95Ms: 20,
          p99Ms: 30,
          maxMs: 40,
          samples: 180_000,
          insufficientSamples: false,
        },
        bytesOffered: 1_000,
        bytesDelivered: 1_000,
      },
      read: {
        offered: 10,
        attempts: 10,
        retries: 0,
        succeeded: 10,
        failed: 0,
        rejected: 0,
        timedOut: 0,
        errored: 0,
        unknownOutcome: 0,
        pending: 0,
        availability: 1,
        latency: {
          p50Ms: 10,
          p95Ms: 40,
          p99Ms: 50,
          maxMs: 60,
          samples: 10,
          insufficientSamples: true,
        },
        bytesOffered: 1_000,
        bytesDelivered: 1_000,
      },
      critical: null,
    },
    gates: [
      {
        id: 'read-whole-availability',
        label: 'View audience ranking availability',
        severity: 'required',
        operation: 'read',
        window: 'whole',
        metric: 'availability',
        actual: 1,
        limit: 0.995,
        unit: 'ratio',
        comparison: 'min',
        sampleCount: 10,
        passed,
        message: 'Availability meets the target for this case.',
      },
    ],
    correctness: {
      valid: true,
      ingestOffered: 180_000,
      ingestCommitted: 180_000,
      ingestAcknowledged: 180_000,
      ingestPending: 0,
      committedUnacknowledged: 0,
      duplicateLogicalEvents: 0,
      lostAcknowledgedEvents: 0,
      retriedLogicalEvents: 0,
      idempotentReplays: 0,
      payloadConflicts: 0,
      unknownCommitOutcomes: 0,
      resolvedUnknownCommitOutcomes: 0,
      commitsSurvivedAppCrash: isFault ? 3 : 0,
      commitSequenceHighWater: 180_000,
      checkedSnapshots: 10,
      snapshotMismatches: 0,
      checkedExpiry: 2,
      expectedExpiries: 2,
      expiryMismatches: 0,
      finalRankingMatchesReference: true,
      finalActivePairs: 20,
      expectedActivePairs: 20,
      projectionLag: null,
    },
    freshness: {
      valid: true,
      freshnessLimitMs: 5_000,
      successfulReads: 10,
      checkedReads: 10,
      staleReads: 0,
      wrongWindowReads: 0,
      maxLagMs: 100,
      p95LagMs: 90,
      samples: 10,
      latestSnapshot: { asOfMs: 89_500.25, throughCommitSequence: 180_000 },
    },
    finalSnapshot: { asOfMs: 89_500.25, throughCommitSequence: 180_000 },
    nodes: [
      metric('users', 'users'),
      metric('app', 'app', 2, isFault ? 'crashed' : 'healthy'),
      metric('sql', 'sql'),
    ],
    links: [],
    cost: {
      currency: 'USD',
      hourlyUsd: 0.28,
      preparationMs: 1_000,
      measuredMs: 90_000,
      drainMs: 10_000,
      billedMs: 101_000,
      rentalUsd: 0.007,
      billedBytes: 1_000,
      bytesUsd: 0.0001,
      actualUsd: 0.0071,
      lines: [
        {
          nodeId: 'app',
          kind: 'app',
          hourlyUsd: 0.12,
          hours: 0.028,
          usd: 0.003,
        },
      ],
    },
    series: [
      seriesPoint(1_000, 'app'),
      seriesPoint(2_000, 'app', {
        traffic: {
          ingest: { offered: 2_000, succeeded: 1_900, failed: 100 },
          read: { offered: 200, succeeded: 190, failed: 10 },
        },
      }),
    ],
    trafficFrames: [trafficFrame(id, 1_000), trafficFrame(id, 2_000)],
    incidentTimeline: isFault
      ? [
          {
            atMs: 30_000,
            kind: 'crash',
            nodeId: 'app',
            instanceIndex: 0,
            message: 'Application insta… crash injected',
          },
          {
            atMs: 45_000,
            kind: 'restart',
            nodeId: 'app',
            instanceIndex: 0,
            message: 'process started',
          },
          {
            atMs: 46_500,
            kind: 'ready',
            nodeId: 'app',
            instanceIndex: 0,
            message: 'two probes succeeded',
          },
        ]
      : [],
  };
}

function evaluation(slotOnePassed = true): AudienceEvaluation {
  const cases = [
    caseResult('normal'),
    caseResult('peak'),
    caseResult('app-failure-0'),
    caseResult('app-failure-1', slotOnePassed),
  ];
  const passed = cases.every((item) => item.passed);
  return {
    status: 'complete',
    passed,
    levelId: 'live-audience',
    modelVersion: '1.0.0',
    schemaVersion: 1,
    contentVersion: '1.0.0',
    pricingVersion: 'audience-catalog-v1',
    profileVersion: 'app-resilience-v1',
    seed: 101,
    graphDigest: 'digest',
    runId: 'run',
    identity: {
      levelId: 'live-audience',
      modelVersion: '1.0.0',
      schemaVersion: 1,
      contentVersion: '1.0.0',
      pricingVersion: 'audience-catalog-v1',
      profileVersion: 'app-resilience-v1',
      seed: 101,
      graphDigest: 'digest',
      runId: 'run',
    },
    provisioned: {
      appInstances: 2,
      sqlSize: 'small',
      readPlan: 'projection',
      cacheTtlSeconds: null,
      workerInstances: 2,
      loadBalancer: true,
    },
    cases,
    score: passed
      ? { eligible: true, costUsd: 0.0071, caseId: 'peak' }
      : { eligible: false, costUsd: null, caseId: 'peak' },
    issues: [],
    incompleteReasons: [],
  };
}

beforeEach(() => {
  const parsed = parseAudienceGraph(projectionFixture);
  if (!parsed.ok) {
    throw new Error('fixture did not parse');
  }
  const result = evaluation();
  useAudienceStore.setState({
    graph: parsed.value,
    seed: 101,
    runPhase: 'completed',
    result,
    resultDigest: audienceGraphDigest(parsed.value),
    resultSeed: 101,
    runIssues: [],
    runError: null,
    selectedCaseId: 'normal',
    viewTimeMs: null,
    replayMode: 'summary',
  });
});

async function renderReport() {
  render(
    <AudienceResultsPanel onFocusNode={() => undefined} onFocusEdge={() => undefined} />,
  );
}

describe('Live Audience results panel', () => {
  it('qualifies only through the all-case summary and shows per-case charts', async () => {
    const user = userEvent.setup();
    await renderReport();
    expect(
      screen.getByText('Qualified — every required case passed'),
    ).toBeVisible();
    expect(screen.getByText('Telemetry · Normal traffic')).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Telemetry · Normal traffic' }),
    ).toBeVisible();
    expect(screen.getByText('No Application failure is injected in this case.')).toBeVisible();

    await user.click(
      screen.getByRole('tab', { name: 'Live peak · pass' }),
    );
    expect(
      screen.getByRole('heading', { name: 'Telemetry · Live peak' }),
    ).toBeVisible();
    expect(screen.getByText('Live peak requirements')).toBeInTheDocument();

    await user.click(
      screen.getByRole('tab', { name: 'Application failure · slot 0 · pass' }),
    );
    expect(
      screen.getByRole('heading', {
        name: 'Telemetry · Application failure · slot 0',
      }),
    ).toBeVisible();
    expect(screen.getByText(/physical Application slot 0/)).toBeVisible();
    // A direct-path null observation must stay unknown, never invented.
    expect(screen.getByText('not observed')).toBeVisible();
    expect(screen.getAllByText('Crash').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
    expect(screen.getByText('Restarts')).toBeVisible();
  });

  it('exposes full accessible case names with verdicts while keeping compact visible labels', async () => {
    useAudienceStore.setState({ result: evaluation(false) });
    const user = userEvent.setup();
    await renderReport();

    const tabs = screen.getByRole('tablist', { name: 'Qualification case' });
    expect(within(tabs).getAllByRole('tab')).toHaveLength(4);
    const expected: ReadonlyArray<[string, string, string]> = [
      ['Normal traffic · pass', 'Normal', 'pass'],
      ['Live peak · pass', 'Peak', 'pass'],
      ['Application failure · slot 0 · pass', 'Failure · slot 0', 'pass'],
      ['Application failure · slot 1 · fail', 'Failure · slot 1', 'fail'],
    ];
    for (const [name, compact, verdict] of expected) {
      const tab = within(tabs).getByRole('tab', { name });
      // The full label is the accessible name; the compact label stays visual.
      expect(tab).toHaveTextContent(compact);
      expect(tab).not.toHaveTextContent(name);
      expect(tab.querySelector('small')).toHaveTextContent(verdict);
      expect(tab).toHaveAccessibleName(name);
    }

    // The same case-label path still drives the detail heading and verdict.
    await user.click(
      screen.getByRole('tab', { name: 'Live peak · pass' }),
    );
    expect(
      screen.getByRole('heading', { name: 'Telemetry · Live peak' }),
    ).toBeVisible();

    await user.click(
      screen.getByRole('tab', { name: 'Application failure · slot 1 · fail' }),
    );
    expect(
      screen.getByRole('heading', {
        name: 'Telemetry · Application failure · slot 1',
      }),
    ).toBeVisible();
    expect(
      document.querySelector('[data-audience-case-verdict]'),
    ).toHaveAttribute('data-audience-case-verdict', 'fail');
    expect(
      screen.getByRole('tab', { name: 'Application failure · slot 1 · fail' }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByRole('tab', { name: 'Normal traffic · pass' }),
    ).toHaveAttribute('aria-selected', 'false');
  });

  it('keeps units, cohorts, unknown values and cost scope labelled', async () => {
    await renderReport();
    expect(screen.getAllByText('requests/s').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Hourly rent/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Peak case only/)).toBeVisible();
    expect(screen.getByText(/Fault-case costs are never summed/)).toBeVisible();
    expect(screen.getByText('Expected expiry work')).toBeVisible();
    expect(screen.getByText('Resolved by same-id retry (logical)')).toBeVisible();
  });
});
