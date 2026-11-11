import { describe, expect, it } from 'vitest';
import {
  createParcelGraph,
  createParcelNode,
  parcelGraphDigest,
  parseParcelGraph,
  validateParcelGraph,
  type ParcelGraph,
  type ParcelNode,
} from '../index';

interface MutableGraph {
  schemaVersion: 1;
  levelId: 'parcel-pulse';
  name?: string;
  nodes: {
    id: string;
    kind: string;
    label: string;
    position: { x: number; y: number };
    config: Record<string, unknown>;
  }[];
  edges: {
    id: string;
    source: string;
    target: string;
    operation: string;
  }[];
}

function clone(graph: ParcelGraph): MutableGraph {
  return JSON.parse(JSON.stringify(graph)) as MutableGraph;
}

function mutableNode(node: ParcelNode): MutableGraph['nodes'][number] {
  return node as unknown as MutableGraph['nodes'][number];
}

function codes(graph: MutableGraph): string[] {
  return validateParcelGraph(graph as unknown as ParcelGraph).map(
    (issue) => issue.code,
  );
}

describe('Parcel graph strict parser', () => {
  it('parses and semantically accepts the stock starter', () => {
    const parsed = parseParcelGraph(createParcelGraph());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const errors = validateParcelGraph(parsed.graph).filter(
      (issue) => issue.severity === 'error',
    );
    expect(errors).toEqual([]);
  });

  it('rejects prototype keys and unknown top-level overrides', () => {
    const malicious = JSON.parse(
      '{"schemaVersion":1,"levelId":"parcel-pulse","__proto__":{"polluted":true},"nodes":[],"edges":[]}',
    ) as unknown;
    const parsed = parseParcelGraph(malicious);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.map((issue) => issue.code)).toContain('prototype_key');

    const override = parseParcelGraph({
      schemaVersion: 1,
      levelId: 'cold-cache',
      budget: 1,
      nodes: [],
      edges: [],
    });
    expect(override.ok).toBe(false);
    expect(override.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['level_override_rejected', 'unknown_field']),
    );
  });

  it('rejects unknown kinds, unsupported config fields and bounds', () => {
    const graph = clone(createParcelGraph());
    const badKind = {
      ...graph,
      nodes: graph.nodes.map((node, index) =>
        index === 2 ? { ...node, kind: 'warehouse' } : node,
      ),
    };
    expect(parseParcelGraph(badKind).ok).toBe(false);

    const badConfig = clone(createParcelGraph());
    badConfig.nodes[2]!.config = {
      ...badConfig.nodes[2]!.config,
      retentionYears: 9,
    } as never;
    expect(parseParcelGraph(badConfig).ok).toBe(false);

    const irrelevant = clone(createParcelGraph());
    irrelevant.nodes[2]!.config = {
      ...irrelevant.nodes[2]!.config,
      columnProjection: true,
    } as never;
    expect(parseParcelGraph(irrelevant).ok).toBe(false);
  });

  it('rejects duplicate ids and invalid positions', () => {
    const duplicate = clone(createParcelGraph());
    duplicate.nodes[1]!.id = duplicate.nodes[0]!.id;
    const parsed = parseParcelGraph(duplicate);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.map((issue) => issue.code)).toContain(
      'duplicate_node_id',
    );

    const position = clone(createParcelGraph());
    position.nodes[0]!.position = { x: 99_999, y: 0 };
    expect(parseParcelGraph(position).ok).toBe(false);
  });

  it('reports missing routes, unfed reads, cycles and bad status targets', () => {
    const graph = clone(createParcelGraph());
    graph.edges = graph.edges.filter((edge) => edge.operation !== 'report');
    expect(codes(graph)).toContain('missing_route');

    const unfed = clone(createParcelGraph());
    unfed.nodes.push(mutableNode(createParcelNode('sql', 'sql-2', { x: 10, y: 10 })));
    unfed.edges = unfed.edges.map((edge) =>
      edge.operation === 'status' ? { ...edge, target: 'sql-2' } : edge,
    );
    expect(codes(unfed)).toContain('read_target_unfed');

    const cycle = clone(createParcelGraph());
    cycle.nodes.push(
      mutableNode(createParcelNode('columnar', 'columnar-1', { x: 20, y: 20 })),
    );
    cycle.edges.push(
      { id: 'rep-1', source: 'sql-1', target: 'columnar-1', operation: 'replicate' },
      { id: 'rep-2', source: 'columnar-1', target: 'sql-1', operation: 'replicate' },
    );
    expect(codes(cycle)).toContain('graph_cycle');
    expect(codes(cycle)).toContain('replication_source');

    const columnarStatus = clone(createParcelGraph());
    columnarStatus.nodes.push(
      mutableNode(createParcelNode('columnar', 'columnar-1', { x: 20, y: 20 })),
    );
    columnarStatus.edges.push({
      id: 'rep-1',
      source: 'sql-1',
      target: 'columnar-1',
      operation: 'replicate',
    });
    columnarStatus.edges = columnarStatus.edges.map((edge) =>
      edge.operation === 'status' ? { ...edge, target: 'columnar-1' } : edge,
    );
    expect(codes(columnarStatus)).toContain('status_target_kind');
  });

  it('emits one retention warning when primary and history share a node', () => {
    const graph = clone(createParcelGraph());
    const warnings = validateParcelGraph(
      graph as unknown as ParcelGraph,
    ).filter((issue) => issue.code === 'retention_below_required');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.nodeId).toBe('sql-1');
  });

  it('keeps the semantic digest stable across visual-only edits', () => {
    const graph = createParcelGraph();
    const before = parcelGraphDigest(graph);
    const moved = clone(graph);
    moved.nodes[0]!.position = { x: 100, y: 200 };
    moved.nodes[0]!.label = 'Renamed client';
    expect(parcelGraphDigest(moved as unknown as ParcelGraph)).toBe(before);

    const configured = clone(graph);
    configured.nodes[2]!.config = {
      ...configured.nodes[2]!.config,
      index: 'parcel-warehouse',
    };
    expect(parcelGraphDigest(configured as unknown as ParcelGraph)).not.toBe(
      before,
    );
  });
});
