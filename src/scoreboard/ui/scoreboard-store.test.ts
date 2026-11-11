import { beforeEach, describe, expect, it } from 'vitest';

import {
  SCOREBOARD_LEVEL,
  createScoreboardStarterGraph,
  scoreboardGraphDigest,
  type ScoreboardEvaluation,
} from '../index';
import { scoreboardResultStale } from './scoreboard-diagnostics';
import { useScoreboardStore } from './scoreboard-store';

function reset() {
  useScoreboardStore.getState().resetGraph();
}

describe('Live Scoreboard editor store', () => {
  beforeEach(reset);

  it('starts with Users only, the default seed and no result', () => {
    const state = useScoreboardStore.getState();
    expect(state.graph).toEqual(createScoreboardStarterGraph());
    expect(state.graph.nodes.map((node) => node.kind)).toEqual(['users']);
    expect(state.seed).toBe(SCOREBOARD_LEVEL.defaultSeed);
    expect(state.result).toBeNull();
    expect(state.runPhase).toBe('idle');
    expect(state.past).toEqual([]);
  });

  it('adds only the catalog components with catalog defaults', () => {
    const store = useScoreboardStore.getState();
    expect(store.addNode('app').ok).toBe(true);
    expect(store.addNode('sql').ok).toBe(true);
    expect(store.addNode('cache').ok).toBe(true);
    expect(store.addNode('cache').ok).toBe(false);

    const graph = useScoreboardStore.getState().graph;
    const app = graph.nodes.find((node) => node.kind === 'app');
    const sql = graph.nodes.find((node) => node.kind === 'sql');
    const cache = graph.nodes.find((node) => node.kind === 'cache');
    expect(app?.config).toEqual({ instances: 1 });
    expect(sql?.config).toEqual({ size: 'small', readPlan: 'scan' });
    expect(cache?.config).toEqual({ ttlSeconds: 2 });
  });

  it('infers link roles from endpoints and rejects illegal or duplicate pairs', () => {
    const store = useScoreboardStore.getState();
    store.addNode('app');
    store.addNode('sql');
    store.addNode('cache');

    expect(store.addEdge('users', 'sql').ok).toBe(false);
    expect(store.addEdge('users', 'app-1').ok).toBe(true);
    expect(store.addEdge('app-1', 'sql-1').ok).toBe(true);
    expect(store.addEdge('app-1', 'cache-1').ok).toBe(true);
    expect(store.addEdge('cache-1', 'sql-1').ok).toBe(true);
    expect(store.addEdge('users', 'app-1').ok).toBe(false);

    const edges = useScoreboardStore.getState().graph.edges;
    expect(edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
      'users->app-1',
      'app-1->sql-1',
      'app-1->cache-1',
      'cache-1->sql-1',
    ]);
  });

  it('keeps Users fixed and undeletable while deleting dependent links', () => {
    const store = useScoreboardStore.getState();
    store.addNode('app');
    store.addNode('sql');
    store.addEdge('users', 'app-1');
    store.addEdge('app-1', 'sql-1');

    const before = useScoreboardStore.getState().graph;
    expect(store.removeNode('users').ok).toBe(false);
    expect(store.removeNode('app-1').ok).toBe(true);
    const after = useScoreboardStore.getState().graph;
    expect(after.nodes.map((node) => node.id)).toEqual(['users', 'sql-1']);
    expect(after.edges).toEqual([]);
    expect(after).not.toEqual(before);
  });

  it('updates settings through the catalog with undo and redo', () => {
    const store = useScoreboardStore.getState();
    store.addNode('app');
    store.addNode('sql');
    store.addNode('cache');
    expect(store.setAppInstances('app-1', 4).ok).toBe(true);
    expect(store.setSqlSize('sql-1', 'large').ok).toBe(true);
    expect(store.setSqlReadPlan('sql-1', 'aggregate').ok).toBe(true);
    expect(store.setCacheTtl('cache-1', 15).ok).toBe(true);

    const graph = useScoreboardStore.getState().graph;
    expect(graph.nodes.find((node) => node.id === 'app-1')?.config).toEqual({
      instances: 4,
    });
    expect(graph.nodes.find((node) => node.id === 'sql-1')?.config).toEqual({
      size: 'large',
      readPlan: 'aggregate',
    });
    expect(graph.nodes.find((node) => node.id === 'cache-1')?.config).toEqual({
      ttlSeconds: 15,
    });

    useScoreboardStore.getState().undo();
    expect(
      useScoreboardStore
        .getState()
        .graph.nodes.find((node) => node.id === 'cache-1')?.config,
    ).toEqual({ ttlSeconds: 2 });
    useScoreboardStore.getState().redo();
    expect(
      useScoreboardStore
        .getState()
        .graph.nodes.find((node) => node.id === 'cache-1')?.config,
    ).toEqual({ ttlSeconds: 15 });
  });

  it('does not change the semantic digest when a node moves', () => {
    const store = useScoreboardStore.getState();
    store.addNode('app');
    const before = useScoreboardStore.getState().graph;
    store.beginMove();
    store.moveNode('app-1', { x: 777, y: 333 });
    store.endMove();
    const after = useScoreboardStore.getState().graph;
    expect(after.nodes.find((node) => node.id === 'app-1')?.position).toEqual({
      x: 777,
      y: 333,
    });
    expect(scoreboardGraphDigest(after)).toBe(scoreboardGraphDigest(before));
  });

  it('marks a result stale on semantic or seed changes, not on position', () => {
    const graph = useScoreboardStore.getState().graph;
    const digest = scoreboardGraphDigest(graph);
    const evaluation = {
      graphDigest: digest,
      seed: 101,
    } as ScoreboardEvaluation;
    expect(scoreboardResultStale(evaluation, digest, 101, graph, 101)).toBe(
      false,
    );
    expect(scoreboardResultStale(evaluation, digest, 101, graph, 202)).toBe(
      true,
    );
    const changed = { ...graph, nodes: [...graph.nodes] };
    expect(
      scoreboardResultStale(evaluation, 'different', 101, changed, 101),
    ).toBe(true);
  });

  it('reset restores Users, the default seed and clears an in-progress run', () => {
    const store = useScoreboardStore.getState();
    store.addNode('app');
    store.setSeed(907);
    store.beginRun({ runId: 'run-1', seed: 907, digest: 'digest' });
    expect(useScoreboardStore.getState().runPhase).toBe('running');

    useScoreboardStore.getState().resetGraph();
    const state = useScoreboardStore.getState();
    expect(state.graph).toEqual(createScoreboardStarterGraph());
    expect(state.seed).toBe(SCOREBOARD_LEVEL.defaultSeed);
    expect(state.runPhase).toBe('idle');
    expect(state.runId).toBeNull();
    expect(state.result).toBeNull();
    expect(state.past).toEqual([]);
  });

  it('opens a saved state without keeping the previous result or history', () => {
    const store = useScoreboardStore.getState();
    store.addNode('app');
    store.beginRun({ runId: 'run-1', seed: 101, digest: 'digest' });
    const graph = useScoreboardStore.getState().graph;
    useScoreboardStore.getState().openState(graph, 404);
    const state = useScoreboardStore.getState();
    expect(state.seed).toBe(404);
    expect(state.runPhase).toBe('idle');
    expect(state.result).toBeNull();
    expect(state.past).toEqual([]);
  });
});
