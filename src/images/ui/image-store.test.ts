import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  IMAGE_MAX_SEED,
  type ImageGraph,
} from '../contracts';
import { createImageGraph, parseImageGraph } from '../graph';
import { parseImageState, serializeImageState } from './image-persistence';
import { imageNodeOutsideRegionLane, IMAGE_LANE_ANCHOR_Y } from './image-layout';
import { useImageStore } from './image-store';

function fixtureGraph(name: string): ImageGraph {
  const raw = JSON.parse(
    readFileSync(resolve(process.cwd(), 'fixtures', 'images', `${name}.json`), 'utf8'),
  ) as unknown;
  const parsed = parseImageGraph(raw);
  if (!parsed.ok) {
    throw new Error(`fixture ${name} did not parse`);
  }
  return parsed.graph;
}

function resetStore(): void {
  useImageStore.setState({
    graph: createImageGraph(),
    selection: null,
    past: [],
    future: [],
    revision: 0,
    pendingMove: null,
    seed: 101,
    selectedScenario: 'normal',
    runPhase: 'idle',
    runId: null,
    progress: null,
    result: null,
    resultDigest: null,
    resultSeed: null,
    runIssues: [],
    runError: null,
    runStartedAt: null,
    runFinishedAt: null,
    hydrated: true,
  });
}

function ids(graph: ImageGraph): string[] {
  return graph.nodes.map((node) => node.id).sort();
}

describe('Image Atlas editor store', () => {
  beforeEach(resetStore);

  it('starts from the frozen starter with the level default seed', () => {
    const state = useImageStore.getState();
    expect(ids(state.graph)).toEqual(
      [
        'app-ap',
        'app-eu',
        'app-na',
        'blob-ap',
        'blob-eu',
        'blob-na',
        'client-ap',
        'client-eu',
        'client-na',
        'metadata-na',
      ].sort(),
    );
    expect(state.seed).toBe(101);
    expect(state.past).toHaveLength(0);
    expect(state.runPhase).toBe('idle');
  });

  it('adds player nodes into the requested region and keeps history', () => {
    const store = useImageStore.getState();
    const result = store.addNode('cache', 'eu');
    expect(result.ok).toBe(true);
    const state = useImageStore.getState();
    const cache = state.graph.nodes.find((node) => node.id === result.id);
    expect(cache?.kind).toBe('cache');
    expect(cache?.region).toBe('eu');
    expect(state.past).toHaveLength(1);
    expect(state.selection).toEqual({ type: 'node', id: result.id });
    expect(cache && imageNodeOutsideRegionLane(cache)).toBe(false);

    expect(useImageStore.getState().addNode('client', 'na').ok).toBe(false);
    expect(useImageStore.getState().addNode('blob', 'ap').ok).toBe(false);
  });

  it('locks the six fixed endpoints against delete, region and config edits', () => {
    const store = useImageStore.getState();
    expect(store.removeNode('client-na').ok).toBe(false);
    expect(store.removeNode('blob-ap').ok).toBe(false);
    expect(store.setNodeRegion('client-eu', 'ap').ok).toBe(false);
    expect(
      store.updateNodeConfig('blob-na', { remoteReadVisibilityMs: 1 }).ok,
    ).toBe(false);
    expect(store.resetNodeConfig('client-ap').ok).toBe(false);
    // Only the label and the position stay editable for a fixed endpoint.
    expect(store.updateNodeLabel('client-eu', 'EU visitors').ok).toBe(true);
    expect(
      useImageStore.getState().graph.nodes.find((node) => node.id === 'client-eu')
        ?.label,
    ).toBe('EU visitors');
  });

  it('rejects an out-of-range configuration instead of writing it', () => {
    const store = useImageStore.getState();
    expect(store.updateNodeConfig('app-na', { instances: 0 }).ok).toBe(false);
    expect(store.updateNodeConfig('app-na', { delivery: 'magic' }).ok).toBe(false);
    expect(store.updateNodeConfig('app-na', { retries: 1 }).ok).toBe(true);
    expect(
      useImageStore.getState().graph.nodes.find((node) => node.id === 'app-na')
        ?.config,
    ).toMatchObject({ retries: 1 });
  });

  it('creates a route once, rejects duplicates and undoes it', () => {
    const store = useImageStore.getState();
    const existing = store.graph.edges.find(
      (edge) => edge.source === 'app-eu' && edge.operation === 'metadata',
    );
    expect(existing).toBeDefined();
    expect(store.removeEdge(existing!.id).ok).toBe(true);
    const created = useImageStore.getState().addEdge(
      'app-eu',
      'metadata-na',
      'metadata',
    );
    expect(created.ok).toBe(true);
    expect(
      useImageStore.getState().addEdge('app-eu', 'metadata-na', 'metadata').ok,
    ).toBe(false);
    expect(useImageStore.getState().addEdge('app-eu', 'app-na', 'traffic').ok).toBe(
      false,
    );
    const edgeCount = useImageStore.getState().graph.edges.length;
    useImageStore.getState().undo();
    expect(useImageStore.getState().graph.edges).toHaveLength(edgeCount - 1);
    useImageStore.getState().redo();
    expect(useImageStore.getState().graph.edges).toHaveLength(edgeCount);
  });

  it('records one undo step for a drag and keeps positions out of semantics', () => {
    const store = useImageStore.getState();
    const before = store.graph.nodes.find((node) => node.id === 'app-na')!.position;
    store.beginMove();
    store.moveNode('app-na', { x: before.x + 120, y: before.y + 40 });
    store.moveNode('app-na', { x: before.x + 140, y: before.y + 60 });
    store.endMove();
    expect(useImageStore.getState().past).toHaveLength(1);
    useImageStore.getState().undo();
    expect(
      useImageStore.getState().graph.nodes.find((node) => node.id === 'app-na')
        ?.position,
    ).toEqual(before);
  });

  it('clamps a drag to the frozen position range and keeps the file importable', () => {
    const store = useImageStore.getState();
    store.beginMove();
    store.moveNode('app-na', { x: 999_999, y: -999_999 });
    store.endMove();
    const clamped = useImageStore
      .getState()
      .graph.nodes.find((node) => node.id === 'app-na')?.position;
    expect(clamped).toEqual({ x: 10_000, y: -10_000 });

    // Exactly at the boundary is still a valid document.
    useImageStore.getState().moveNode('app-na', { x: 10_000, y: 10_000 });
    expect(
      useImageStore.getState().graph.nodes.find((node) => node.id === 'app-na')
        ?.position,
    ).toEqual({ x: 10_000, y: 10_000 });
    expect(parseImageGraph(useImageStore.getState().graph).ok).toBe(true);

    // A non-finite coordinate is ignored instead of being written.
    const before = useImageStore.getState().graph;
    useImageStore.getState().moveNode('app-na', { x: Number.NaN, y: 0 });
    expect(useImageStore.getState().graph).toBe(before);

    const seed = useImageStore.getState().seed;
    const exported = serializeImageState(useImageStore.getState().graph, seed);
    const reopened = parseImageState(exported);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) {
      return;
    }
    expect(reopened.seed).toBe(seed);
    expect(reopened.graph.nodes).toEqual(useImageStore.getState().graph.nodes);
  });

  it('normalizes the seed into the frozen range', () => {
    useImageStore.getState().setSeed(-12);
    expect(useImageStore.getState().seed).toBe(0);
    useImageStore.getState().setSeed(3.6);
    expect(useImageStore.getState().seed).toBe(4);
    useImageStore.getState().setSeed(IMAGE_MAX_SEED + 100);
    expect(useImageStore.getState().seed).toBe(IMAGE_MAX_SEED);
  });

  it('restores the starter and clears history and the previous result on reset', () => {
    const store = useImageStore.getState();
    store.addNode('metadata', 'ap');
    store.setSeed(999);
    store.beginRun({ runId: 'r1', seed: 999, digest: 'digest' });
    store.cancelRun();

    useImageStore.getState().resetGraph();
    const state = useImageStore.getState();
    expect(state.graph.nodes).toHaveLength(10);
    expect(state.seed).toBe(101);
    expect(state.past).toHaveLength(0);
    expect(state.future).toHaveLength(0);
    expect(state.result).toBeNull();
    expect(state.runId).toBeNull();
    expect(state.runPhase).toBe('idle');
  });

  it('opens a saved state atomically and refuses an invalid graph', () => {
    const directory = fixtureGraph('directory-direct');
    const opened = useImageStore.getState().openState(directory, 4242);
    expect(opened.ok).toBe(true);
    expect(useImageStore.getState().seed).toBe(4242);
    expect(useImageStore.getState().selection).toBeNull();
    expect(
      useImageStore.getState().graph.nodes.some((node) => node.id === 'metadata-eu'),
    ).toBe(true);

    const broken = { ...createImageGraph(), nodes: [] } as unknown as ImageGraph;
    const before = useImageStore.getState().graph;
    const rejected = useImageStore.getState().openState(broken, 1);
    expect(rejected.ok).toBe(false);
    expect(useImageStore.getState().graph).toBe(before);
    expect(useImageStore.getState().seed).toBe(4242);
  });

  it('groups nodes into region lanes and undoes the layout change', () => {
    const before = useImageStore.getState().graph;
    expect(
      before.nodes.some((node) => imageNodeOutsideRegionLane(node)),
    ).toBe(true);
    const result = useImageStore.getState().arrangeByRegion();
    expect(result.ok).toBe(true);
    const arranged = useImageStore.getState().graph;
    expect(arranged.nodes.every((node) => !imageNodeOutsideRegionLane(node))).toBe(
      true,
    );
    for (const node of arranged.nodes) {
      expect(node.position.y).toBeGreaterThanOrEqual(
        IMAGE_LANE_ANCHOR_Y[node.region] - 400,
      );
    }
    useImageStore.getState().undo();
    expect(useImageStore.getState().graph.nodes).toEqual(before.nodes);
  });

  it('ignores progress and completion from an older run id', () => {
    const store = useImageStore.getState();
    store.beginRun({ runId: 'run-new', seed: 101, digest: 'digest' });
    store.updateProgress('run-old', {
      phase: 'simulate',
      scenario: 'peak',
      completed: 1,
      total: 7,
      message: 'stale',
    });
    expect(useImageStore.getState().progress?.message).not.toBe('stale');

    store.failRun('run-old', 'late failure');
    expect(useImageStore.getState().runPhase).toBe('running');
    expect(useImageStore.getState().runError).toBeNull();

    store.cancelRun();
    const stale = { status: 'invalid', passed: false } as never;
    store.completeRun('run-new', { evaluation: stale, seed: 101, digest: 'digest' });
    expect(useImageStore.getState().runPhase).toBe('stopped');
    expect(useImageStore.getState().result).toBeNull();
  });
});
