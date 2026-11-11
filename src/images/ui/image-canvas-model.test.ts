import { describe, expect, it } from 'vitest';

import type { ImageEdge, ImageNode } from '../contracts';
import {
  imageAllowedOperations,
  imageConnectionCandidates,
  imageConnectionExplanation,
  imageEdgeLanes,
  imageLogicalEdgeNote,
  IMAGE_REGION_PAIR_LINKS,
} from './image-canvas-model';
import {
  clampImagePosition,
  imageArrangeByRegion,
  imageNodeOutsideRegionLane,
  imageRegionLane,
  imageNewNodePosition,
  IMAGE_LANE_ANCHOR_Y,
  IMAGE_LANE_HEIGHT,
  IMAGE_MAX_COORDINATE,
  IMAGE_MIN_COORDINATE,
  IMAGE_NODE_EXTENT,
  IMAGE_REGION_LANES,
} from './image-layout';
import { IMAGE_COMPONENT_LIMITS } from '../contracts';
import { createImageGraph, createImageNode } from '../graph';

function node(kind: ImageNode['kind']): ImageNode {
  const graph = createImageGraph();
  const found = graph.nodes.find((item) => item.kind === kind);
  if (!found) {
    throw new Error(`starter has no ${kind}`);
  }
  return found;
}

const metadata2: ImageNode = { ...node('metadata'), id: 'metadata-eu', region: 'eu' };

describe('Image Atlas route inference', () => {
  it('offers exactly the contract-legal operation for every supported kind pair', () => {
    expect(imageAllowedOperations('client', 'app')).toEqual(['traffic']);
    expect(imageAllowedOperations('app', 'metadata')).toEqual(['metadata']);
    expect(imageAllowedOperations('metadata', 'metadata')).toEqual(['replicate']);
    expect(imageAllowedOperations('client', 'blob')).toEqual(['blob']);
    expect(imageAllowedOperations('app', 'blob')).toEqual(['blob']);
    expect(imageAllowedOperations('app', 'cache')).toEqual(['blob']);
    expect(imageAllowedOperations('cache', 'blob')).toEqual(['blob']);
  });

  it('rejects impossible directions instead of inventing a route', () => {
    expect(imageAllowedOperations('app', 'app')).toEqual([]);
    expect(imageAllowedOperations('client', 'metadata')).toEqual([]);
    expect(imageAllowedOperations('blob', 'app')).toEqual([]);
    expect(imageAllowedOperations('metadata', 'app')).toEqual([]);
    expect(imageAllowedOperations('app', 'client')).toEqual([]);
    expect(imageConnectionExplanation('app', 'app')).toMatch(/cannot be connected/i);
    expect(imageConnectionExplanation('blob', 'app')).toMatch(/cannot start a route/i);
    expect(imageConnectionExplanation('app', 'client')).toMatch(/Nothing can point/i);
  });

  it('hides an operation that already exists on the same pair', () => {
    const existing: ImageEdge[] = [
      { id: 'route-1', source: 'client-na', target: 'app-na', operation: 'traffic' },
    ];
    expect(
      imageConnectionCandidates(node('client'), node('app'), existing),
    ).toEqual([]);
    expect(
      imageConnectionCandidates(node('metadata'), metadata2, []),
    ).toEqual(['replicate']);
  });

  it('separates parallel routes with distinct lanes', () => {
    const lanes = imageEdgeLanes([
      { id: 'a', source: 'x', target: 'y', operation: 'metadata' },
      { id: 'b', source: 'x', target: 'y', operation: 'blob' },
      { id: 'c', source: 'x', target: 'z', operation: 'traffic' },
    ]);
    expect(lanes.get('a')?.total).toBe(2);
    expect(lanes.get('a')?.offset).not.toBe(lanes.get('b')?.offset);
    expect(lanes.get('c')?.total).toBe(1);
    expect(lanes.get('c')?.offset).toBe(0);
  });

  it('states that a logical route is not its own physical link', () => {
    for (const operation of ['traffic', 'metadata', 'blob', 'replicate'] as const) {
      const note = imageLogicalEdgeNote(operation);
      expect(note).toMatch(/logical route/i);
      expect(note).toMatch(/100 Gbit\/s/i);
      expect(note).toMatch(/10 Gbit\/s/i);
    }
    expect(IMAGE_REGION_PAIR_LINKS.map((link) => link.id)).toEqual([
      'na-eu',
      'eu-ap',
      'na-ap',
    ]);
    expect(
      IMAGE_REGION_PAIR_LINKS.every((link) => link.bandwidthGbitPerSec === 100),
    ).toBe(true);
  });
});

describe('Image Atlas regional lanes', () => {
  it('keeps the three lanes disjoint', () => {
    expect(IMAGE_REGION_LANES).toHaveLength(3);
    const sorted = [...IMAGE_REGION_LANES].sort((left, right) => left.top - right.top);
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index]!.top).toBeGreaterThanOrEqual(sorted[index - 1]!.bottom);
    }
    expect(imageRegionLane('na').bottom - imageRegionLane('na').top).toBe(
      IMAGE_LANE_HEIGHT,
    );
  });

  it('places every starter node except the shared metadata origin in a lane', () => {
    const graph = createImageGraph();
    const outside = graph.nodes.filter(imageNodeOutsideRegionLane).map((node) => node.id);
    // The frozen starter positions the shared metadata origin at the centre row.
    expect(outside).toEqual(['metadata-na']);
    expect(imageNodeOutsideRegionLane(node('client'))).toBe(false);
  });

  it('arranges nodes into their lane without changing semantics', () => {
    const graph = createImageGraph();
    const arranged = imageArrangeByRegion(graph);
    expect(arranged.nodes.every((item) => !imageNodeOutsideRegionLane(item))).toBe(
      true,
    );
    for (const region of ['na', 'eu', 'ap'] as const) {
      for (const item of arranged.nodes.filter((each) => each.region === region)) {
        expect(item.position.y).toBeGreaterThanOrEqual(IMAGE_LANE_ANCHOR_Y[region]);
      }
    }
    // Geometry only: identity, kind, region and configuration are untouched.
    expect(arranged.nodes.map((item) => [item.id, item.kind, item.region])).toEqual(
      graph.nodes.map((item) => [item.id, item.kind, item.region]),
    );
    expect(arranged.edges).toEqual(graph.edges);
  });

  it('stacks additional nodes of the same kind below the lane anchor', () => {
    const graph = createImageGraph();
    const first = imageNewNodePosition(graph, 'cache', 'ap');
    const withCache = {
      ...graph,
      nodes: [
        ...graph.nodes,
        { ...createImageNode('cache', 'cache-1', 'ap', first) },
      ],
    };
    const second = imageNewNodePosition(withCache, 'cache', 'ap');
    expect(second.y).toBeGreaterThan(first.y);
    expect(second.x).toBe(first.x);
  });
});

describe('Image Atlas position bounds', () => {
  it('derives the React Flow node extent from the frozen contract limits', () => {
    expect(IMAGE_MIN_COORDINATE).toBe(IMAGE_COMPONENT_LIMITS.position.min);
    expect(IMAGE_MAX_COORDINATE).toBe(IMAGE_COMPONENT_LIMITS.position.max);
    expect(IMAGE_NODE_EXTENT).toEqual([
      [-10_000, -10_000],
      [10_000, 10_000],
    ]);
  });

  it('clamps finite coordinates to each boundary and rejects non-finite input', () => {
    expect(clampImagePosition({ x: 10_000, y: -10_000 })).toEqual({
      x: 10_000,
      y: -10_000,
    });
    expect(clampImagePosition({ x: 10_001, y: -10_001 })).toEqual({
      x: 10_000,
      y: -10_000,
    });
    expect(clampImagePosition({ x: 25_000, y: 25_000 })).toEqual({
      x: 10_000,
      y: 10_000,
    });
    expect(clampImagePosition({ x: Number.NaN, y: 0 })).toBeNull();
    expect(clampImagePosition({ x: 0, y: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('keeps arranged and newly added nodes inside the same bounds', () => {
    const arranged = imageArrangeByRegion(createImageGraph());
    for (const node of arranged.nodes) {
      expect(node.position.x).toBeGreaterThanOrEqual(IMAGE_MIN_COORDINATE);
      expect(node.position.x).toBeLessThanOrEqual(IMAGE_MAX_COORDINATE);
      expect(node.position.y).toBeGreaterThanOrEqual(IMAGE_MIN_COORDINATE);
      expect(node.position.y).toBeLessThanOrEqual(IMAGE_MAX_COORDINATE);
    }
    const position = imageNewNodePosition(createImageGraph(), 'cache', 'na');
    expect(position).toEqual(clampImagePosition(position));
  });
});
