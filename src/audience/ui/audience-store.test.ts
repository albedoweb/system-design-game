import { beforeEach, describe, expect, it } from 'vitest';

import {
  AUDIENCE_LEVEL,
  audienceGraphDigest,
  createAudienceStarterGraph,
  validateAudienceGraph,
  type AudienceEvaluation,
} from '../index';
import {
  audienceResultStale,
  audienceProblemMaps,
  uniqueAudienceIssues,
} from './audience-diagnostics';
import {
  audienceSelectedCase,
  useAudienceStore,
} from './audience-store';

function reset() {
  useAudienceStore.getState().resetGraph();
}

describe('Live Audience editor store', () => {
  beforeEach(reset);

  it('starts from the Users-only starter and the default seed', () => {
    const state = useAudienceStore.getState();
    expect(state.graph).toEqual(createAudienceStarterGraph());
    expect(state.graph.nodes.map((node) => node.kind)).toEqual(['users']);
    expect(state.seed).toBe(AUDIENCE_LEVEL.defaultSeed);
    expect(state.result).toBeNull();
    expect(state.runPhase).toBe('idle');
    expect(validateAudienceGraph(state.graph).some((issue) => issue.severity === 'error')).toBe(true);
  });

  it('adds the general components and builds a runnable route', () => {
    const store = useAudienceStore.getState();
    expect(store.addNode('lb').ok).toBe(true);
    expect(store.addNode('app').ok).toBe(true);
    expect(store.addNode('sql').ok).toBe(true);
    expect(store.addNode('cache').ok).toBe(true);
    expect(store.addNode('worker').ok).toBe(true);

    const graph = useAudienceStore.getState().graph;
    expect(graph.nodes.map((node) => node.kind).sort()).toEqual(
      ['app', 'cache', 'lb', 'sql', 'users', 'worker'].sort(),
    );
    const idOf = (kind: string) =>
      useAudienceStore
        .getState()
        .graph.nodes.find((node) => node.kind === kind)!.id;
    const connect = (from: string, to: string) =>
      useAudienceStore.getState().addEdge(idOf(from), idOf(to));
    expect(connect('users', 'lb').ok).toBe(true);
    expect(connect('lb', 'app').ok).toBe(true);
    expect(connect('app', 'sql').ok).toBe(true);
    expect(connect('app', 'cache').ok).toBe(true);
    expect(connect('cache', 'sql').ok).toBe(true);
    expect(connect('worker', 'sql').ok).toBe(true);

    const configured = useAudienceStore.getState();
    expect(configured.setAppInstances(idOf('app'), 3).ok).toBe(true);
    expect(configured.setSqlSize(idOf('sql'), 'medium').ok).toBe(true);
    expect(configured.setSqlReadPlan(idOf('sql'), 'projection').ok).toBe(true);
    expect(configured.setCacheTtl(idOf('cache'), 15).ok).toBe(true);
    expect(configured.setWorkerInstances(idOf('worker'), 2).ok).toBe(true);

    const next = useAudienceStore.getState().graph;
    expect(validateAudienceGraph(next).filter((issue) => issue.severity === 'error')).toEqual([]);
    const sql = next.nodes.find((node) => node.kind === 'sql');
    expect(sql?.kind === 'sql' ? sql.config : null).toEqual({
      size: 'medium',
      readPlan: 'projection',
    });
  });

  it('places all added components in free 2D slots without overlap', () => {
    const store = useAudienceStore.getState();
    const epoch = store.viewportEpoch;
    const focusNonce = store.focusNonce;
    for (const kind of ['lb', 'app', 'sql', 'cache', 'worker'] as const) {
      expect(store.addNode(kind).ok).toBe(true);
    }
    const graph = useAudienceStore.getState().graph;
    expect(graph.nodes).toHaveLength(6);
    // Adding nodes must not request a fresh fit-to-view epoch.
    expect(useAudienceStore.getState().viewportEpoch).toBe(epoch);
    expect(useAudienceStore.getState().focusNonce).toBe(focusNonce + 5);

    for (const [index, left] of graph.nodes.entries()) {
      for (const right of graph.nodes.slice(index + 1)) {
        const horizontal = Math.abs(left.position.x - right.position.x);
        const vertical = Math.abs(left.position.y - right.position.y);
        expect(
          horizontal >= 280 || vertical >= 240,
          `${left.id} overlaps ${right.id}`,
        ).toBe(true);
      }
    }
    // At least two vertical rows are used, not one ever-longer horizontal row.
    expect(new Set(graph.nodes.map((node) => node.position.y)).size).toBeGreaterThan(1);
  });

  it('enforces one Application and SQL pool, and one optional component each', () => {
    const store = useAudienceStore.getState();
    expect(store.addNode('app').ok).toBe(true);
    expect(store.addNode('app').ok).toBe(false);
    expect(store.addNode('sql').ok).toBe(true);
    expect(store.addNode('sql').ok).toBe(false);
    expect(store.addNode('lb').ok).toBe(true);
    expect(store.addNode('lb').ok).toBe(false);
    expect(store.addNode('cache').ok).toBe(true);
    expect(store.addNode('cache').ok).toBe(false);
    expect(store.addNode('worker').ok).toBe(true);
    expect(store.addNode('worker').ok).toBe(false);
  });

  it('rejects unsupported links and keeps Users undeletable', () => {
    const store = useAudienceStore.getState();
    expect(store.addNode('app').ok).toBe(true);
    const graph = useAudienceStore.getState().graph;
    const app = graph.nodes.find((node) => node.kind === 'app')!;
    expect(useAudienceStore.getState().addEdge(app.id, 'users').ok).toBe(false);
    expect(useAudienceStore.getState().removeNode('users').ok).toBe(false);
  });

  it('undoes, redoes and resets to the starter with seed 101', () => {
    const store = useAudienceStore.getState();
    store.addNode('app');
    expect(useAudienceStore.getState().graph.nodes).toHaveLength(2);
    useAudienceStore.getState().undo();
    expect(useAudienceStore.getState().graph.nodes).toHaveLength(1);
    useAudienceStore.getState().redo();
    expect(useAudienceStore.getState().graph.nodes).toHaveLength(2);
    useAudienceStore.getState().setSeed(4242);
    const epoch = useAudienceStore.getState().viewportEpoch;
    useAudienceStore.getState().resetGraph();
    expect(useAudienceStore.getState().graph).toEqual(createAudienceStarterGraph());
    expect(useAudienceStore.getState().seed).toBe(101);
    expect(useAudienceStore.getState().result).toBeNull();
    expect(useAudienceStore.getState().viewportEpoch).toBe(epoch + 1);
  });

  it('keeps a result current after a move but not after a semantic edit', () => {
    const store = useAudienceStore.getState();
    store.addNode('app');
    store.addNode('sql');
    store.addEdge('users', 'app');
    store.addEdge('app', 'sql');
    const graph = useAudienceStore.getState().graph;
    const digest = audienceGraphDigest(graph);
    // The stale helper only needs a real result object to exist; this unit
    // exercises the digest/seed boundary, not result parsing.
    const evaluation = { cases: [] } as unknown as AudienceEvaluation;

    const app = graph.nodes.find((node) => node.kind === 'app')!;
    useAudienceStore.getState().moveNode(app.id, { x: 1_000, y: 500 });
    const moved = useAudienceStore.getState().graph;
    expect(audienceGraphDigest(moved)).toBe(digest);
    expect(audienceResultStale(evaluation, digest, 101, moved, 101)).toBe(false);

    useAudienceStore.getState().updateNodeLabel(app.id, 'Renamed pool');
    expect(audienceGraphDigest(useAudienceStore.getState().graph)).toBe(digest);

    useAudienceStore.getState().setAppInstances(app.id, 3);
    const changed = useAudienceStore.getState().graph;
    expect(audienceGraphDigest(changed)).not.toBe(digest);
    expect(audienceResultStale(evaluation, digest, 101, changed, 101)).toBe(true);
    expect(audienceResultStale(evaluation, digest, 101, changed, 307)).toBe(true);
    expect(useAudienceStore.getState().result).toBeNull();
  });

  it('binds the selected case to a real case object, never just a label', () => {
    const evaluation = {
      cases: [
        { id: 'normal', label: 'Normal' },
        { id: 'peak', label: 'Peak' },
      ],
    } as unknown as AudienceEvaluation;
    expect(audienceSelectedCase(evaluation, 'peak')?.label).toBe('Peak');
    expect(audienceSelectedCase(evaluation, 'app-failure-3')?.id).toBe('normal');
    expect(audienceSelectedCase(null, 'peak')).toBeNull();
  });

  it('deduplicates issues and only marks measured local failure evidence', () => {
    const issues = uniqueAudienceIssues([
      { severity: 'error', code: 'a', message: 'same', nodeId: 'app' },
      { severity: 'error', code: 'a', message: 'same', nodeId: 'app' },
      { severity: 'warning', code: 'b', message: 'other', edgeId: 'e' },
    ]);
    expect(issues).toHaveLength(2);

    const baseMetric = {
      nodeId: 'app',
      kind: 'app' as const,
      label: 'Application',
      provisionedInstances: 1,
      health: {
        state: 'healthy' as const,
        totalInstances: 1,
        healthyInstances: 1,
        crashEvents: 0,
        recoveryMs: null,
      },
      cpu: {
        capacityCores: 1,
        busyCoresAverage: 1,
        busyCoresPeak: 1,
        busyCoreMs: 1,
        utilizationAverage: 1,
        utilizationPeak: 1,
      },
      memory: {
        capacityBytes: 1,
        workingSetBytes: 1,
        residentBytesAverage: 1,
        peakUsedBytes: 1,
      },
      io: {
        readOperations: 0,
        writeOperations: 0,
        bytesRead: 0,
        bytesWritten: 0,
        busyMs: 0,
        utilizationAverage: 0,
      },
      storage: {
        capacityBytes: 1,
        usedBytes: 0,
        peakUsedBytes: 0,
        bytesWritten: 0,
        bytesRead: 0,
      },
      queue: {
        waitingAverage: 0,
        waitingPeak: 0,
        waitMsAverage: 0,
        waitMsMax: 0,
        waitSamples: 0,
        activePeak: 1,
        rejectedOverflow: 0,
        deadlineTimeouts: 0,
      },
      network: {
        capacityGbitPerSec: 1,
        bytesOffered: 0,
        bytesDelivered: 0,
        averageGbitPerSec: 0,
        peakGbitPerSec: 0,
      },
      tasks: {
        submitted: 1,
        completed: 1,
        rejected: 0,
        timedOut: 0,
        interrupted: 0,
      },
      instances: [],
    };
    const validation = audienceProblemMaps(
      [{ severity: 'error', code: 'missing-app', message: 'Missing app', nodeId: 'app' }],
      null,
      'validation',
    );
    expect(validation.byNode.get('app')).toMatchObject({
      validation: true,
      runtime: false,
    });

    const quiet = audienceProblemMaps([], {
      id: 'peak',
      label: 'Peak',
      kind: 'peak',
      status: 'complete',
      passed: true,
      targetInstance: null,
      target: null,
      window: {
        measuredStartMs: 0,
        measuredEndMs: 90_000,
        peakStartMs: 20_000,
        peakEndMs: 60_000,
        criticalStartMs: 20_000,
        criticalEndMs: 60_000,
        drainMs: 10_000,
        totalRunMs: 100_000,
      },
      operations: null,
      gates: [],
      correctness: null,
      freshness: null,
      finalSnapshot: null,
      nodes: [baseMetric],
      links: [],
      cost: null,
      series: [],
      trafficFrames: [],
      incidentTimeline: [],
    });
    // A 100% CPU peak with no local failure evidence is not a node error.
    expect(quiet.byNode.get('app')).toBeUndefined();

    const rejected = audienceProblemMaps([], {
      id: 'peak',
      label: 'Peak',
      kind: 'peak',
      status: 'complete',
      passed: false,
      targetInstance: null,
      target: null,
      window: {
        measuredStartMs: 0,
        measuredEndMs: 90_000,
        peakStartMs: 20_000,
        peakEndMs: 60_000,
        criticalStartMs: 20_000,
        criticalEndMs: 60_000,
        drainMs: 10_000,
        totalRunMs: 100_000,
      },
      operations: null,
      gates: [],
      correctness: null,
      freshness: null,
      finalSnapshot: null,
      nodes: [
        {
          ...baseMetric,
          tasks: { ...baseMetric.tasks, rejected: 2 },
        },
      ],
      links: [],
      cost: null,
      series: [],
      trafficFrames: [],
      incidentTimeline: [],
    });
    expect(rejected.byNode.get('app')?.severity).toBe('error');
    expect(rejected.byNode.get('app')).toMatchObject({
      validation: false,
      runtime: true,
    });
  });

  it('advances automatic replay without pausing, while seek and pause stay manual', () => {
    const store = useAudienceStore.getState();

    store.startReplay(1_000);
    expect(useAudienceStore.getState().viewTimeMs).toBe(1_000);
    expect(useAudienceStore.getState().replayMode).toBe('playing');

    // The automatic timer path only moves the view.
    store.advanceReplay(2_000);
    expect(useAudienceStore.getState().viewTimeMs).toBe(2_000);
    expect(useAudienceStore.getState().replayMode).toBe('playing');
    store.advanceReplay(3_000);
    expect(useAudienceStore.getState().viewTimeMs).toBe(3_000);
    expect(useAudienceStore.getState().replayMode).toBe('playing');

    // Manual seek is explicit and pauses playback.
    store.seekReplay(2_000);
    expect(useAudienceStore.getState().viewTimeMs).toBe(2_000);
    expect(useAudienceStore.getState().replayMode).toBe('paused');
    store.advanceReplay(3_000);
    expect(useAudienceStore.getState().viewTimeMs).toBe(2_000);
    expect(useAudienceStore.getState().replayMode).toBe('paused');

    store.playReplay();
    store.advanceReplay(3_000);
    expect(useAudienceStore.getState().viewTimeMs).toBe(3_000);
    expect(useAudienceStore.getState().replayMode).toBe('playing');

    store.pauseReplay();
    store.advanceReplay(4_000);
    expect(useAudienceStore.getState().viewTimeMs).toBe(3_000);
    expect(useAudienceStore.getState().replayMode).toBe('paused');
  });

  it('clears the replay view when the case changes', () => {
    useAudienceStore.setState({
      result: {
        cases: [{ id: 'normal' }, { id: 'peak' }],
      } as unknown as AudienceEvaluation,
    });
    const store = useAudienceStore.getState();
    store.startReplay(1_000);
    expect(useAudienceStore.getState().replayMode).toBe('playing');

    store.selectCase('peak');
    const state = useAudienceStore.getState();
    expect(state.selectedCaseId).toBe('peak');
    expect(state.viewTimeMs).toBeNull();
    expect(state.replayMode).toBe('summary');
  });
});
