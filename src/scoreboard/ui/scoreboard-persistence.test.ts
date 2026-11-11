import { describe, expect, it } from 'vitest';

import {
  SCOREBOARD_LEVEL,
  createScoreboardStarterGraph,
  scoreboardGraphDigest,
  type ScoreboardGraph,
} from '../index';
import {
  SCOREBOARD_MAX_IMPORT_BYTES,
  parseScoreboardState,
  serializeScoreboardState,
} from './scoreboard-persistence';

function twoNodeGraph(): ScoreboardGraph {
  return {
    schemaVersion: 1,
    levelId: 'live-scoreboard',
    nodes: [
      ...createScoreboardStarterGraph().nodes,
      {
        id: 'app-1',
        kind: 'app',
        label: 'Application',
        position: { x: 360, y: 200 },
        config: { instances: 2 },
      },
    ],
    edges: [{ id: 'link-1', from: 'users', to: 'app-1' }],
  };
}

describe('explicit Live Scoreboard files', () => {
  it('round-trips the graph, positions, settings and seed', () => {
    const graph = twoNodeGraph();
    const text = serializeScoreboardState(graph, 307);
    const parsed = parseScoreboardState(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.format).toBe('state');
    expect(parsed.seed).toBe(307);
    expect(parsed.graph.nodes.find((node) => node.id === 'app-1')).toMatchObject({
      config: { instances: 2 },
      position: { x: 360, y: 200 },
    });
  });

  it('accepts an older bare graph file and uses the level seed', () => {
    const graph = twoNodeGraph();
    const parsed = parseScoreboardState(JSON.stringify(graph));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.format).toBe('graph');
    expect(parsed.seed).toBeNull();
    expect(parsed.graph).toEqual(graph);
  });

  it('rejects another level, another content version and an invalid seed', () => {
    const graph = twoNodeGraph();
    const base = JSON.parse(serializeScoreboardState(graph, 101)) as Record<
      string,
      unknown
    >;
    expect(
      parseScoreboardState(JSON.stringify({ ...base, levelId: 'parcel-pulse' }))
        .ok,
    ).toBe(false);
    expect(
      parseScoreboardState(
        JSON.stringify({ ...base, contentVersion: '0.0.0' }),
      ).ok,
    ).toBe(false);
    expect(
      parseScoreboardState(JSON.stringify({ ...base, seed: -1 })).ok,
    ).toBe(false);
  });

  it('rejects oversized and malformed files without a partial graph', () => {
    expect(
      parseScoreboardState('{', SCOREBOARD_MAX_IMPORT_BYTES + 1).ok,
    ).toBe(false);
    expect(parseScoreboardState('{').ok).toBe(false);
    expect(
      parseScoreboardState(JSON.stringify({ schemaVersion: 1 })).ok,
    ).toBe(false);
  });

  it('keeps the digest unchanged when only positions change', () => {
    const graph = twoNodeGraph();
    const moved: ScoreboardGraph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === 'app-1'
          ? { ...node, position: { x: 900, y: 500 } }
          : node,
      ),
    };
    expect(scoreboardGraphDigest(moved)).toBe(scoreboardGraphDigest(graph));
    const changed: ScoreboardGraph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.kind === 'app' ? { ...node, config: { instances: 3 } } : node,
      ),
    };
    expect(scoreboardGraphDigest(changed)).not.toBe(
      scoreboardGraphDigest(graph),
    );
    expect(SCOREBOARD_LEVEL.defaultSeed).toBe(101);
  });
});
