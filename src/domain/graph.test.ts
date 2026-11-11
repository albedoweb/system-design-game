import { describe, expect, it } from 'vitest';

import {
  DomainValidationError,
  INITIAL_GRAPH,
  MAX_INPUT_BYTES,
  calculateCost,
  createInitialGraph,
  isGraphRunnable,
  makeNode,
  parseGraph,
  parseGraphJson,
  validateGraph,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
  type ValidationIssue,
} from './index';

function mustNode(graph: GraphDocument, id: string): GraphNode {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node) {
    throw new Error(`node ${id} not found`);
  }
  return node;
}

function mustEdge(graph: GraphDocument, id: string): GraphEdge {
  const edge = graph.edges.find((candidate) => candidate.id === id);
  if (!edge) {
    throw new Error(`edge ${id} not found`);
  }
  return edge;
}

function issuesOf(run: () => unknown): ValidationIssue[] {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainValidationError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error('expected DomainValidationError');
}

function addApp(
  graph: GraphDocument,
  id: string,
  readTarget: string,
  writeTarget: string,
): void {
  graph.nodes.push(makeNode('appServer', id, { x: 400, y: 400 }));
  graph.edges.push(
    { id: `${id}-read`, source: id, target: readTarget, sourcePort: 'read' },
    { id: `${id}-write`, source: id, target: writeTarget, sourcePort: 'write' },
  );
}

describe('INITIAL_GRAPH', () => {
  it('is a schema-valid, runnable starter graph', () => {
    expect(parseGraph(INITIAL_GRAPH)).toEqual(INITIAL_GRAPH);
    expect(isGraphRunnable(INITIAL_GRAPH)).toBe(true);
    expect(validateGraph(INITIAL_GRAPH, { mode: 'draft' })).toEqual([]);
    expect(validateGraph(INITIAL_GRAPH)).toEqual([]);
  });

  it('costs $2.60 per hour', () => {
    expect(createInitialGraph().nodes.map((node) => node.config.size)).toEqual([
      'small',
      'small',
      'medium',
      'small',
    ]);
    expect(calculateCost(INITIAL_GRAPH)).toBe(2_600_000);
    expect(calculateCost(INITIAL_GRAPH) / 1_000_000).toBe(2.6);
  });

  it('does not leak mutable shared defaults', () => {
    const first = createInitialGraph();
    mustNode(first, 'client-1').label = 'Changed';
    mustNode(first, 'client-1').config.queueLimit = 0;
    first.nodes.push(makeNode('database', 'db-2', { x: 0, y: 0 }));

    const second = createInitialGraph();
    expect(mustNode(second, 'client-1').label).toBe('Client');
    expect(mustNode(second, 'client-1').config.queueLimit).toBe(128);
    expect(second.nodes).toHaveLength(4);
    expect(mustNode(INITIAL_GRAPH, 'client-1').label).toBe('Client');
    expect(INITIAL_GRAPH.nodes).toHaveLength(4);

    expect(Object.isFrozen(INITIAL_GRAPH)).toBe(true);
    expect(Object.isFrozen(INITIAL_GRAPH.nodes)).toBe(true);
    expect(Object.isFrozen(mustNode(INITIAL_GRAPH, 'client-1').config)).toBe(true);
  });
});

describe('makeNode', () => {
  it('applies catalog defaults per kind', () => {
    const app = makeNode('appServer', 'app-x', { x: 1, y: 2 });
    expect(app.label).toBe('App Server');
    expect(app.config).toEqual({
      size: 'small',
      queueLimit: 128,
      poolSize: 8,
      ttlSeconds: 120,
      coalescing: false,
    });
    expect(makeNode('cache', 'cache-x', { x: 0, y: 0 }).config.size).toBe('medium');
    expect(makeNode('database', 'db-x', { x: 0, y: 0 }).config.size).toBe('small');
    expect(makeNode('loadBalancer', 'lb-x', { x: 0, y: 0 }).label).toBe(
      'Load Balancer',
    );
  });

  it('accepts overrides and rejects invalid ids or coordinates', () => {
    const node = makeNode(
      'cache',
      'cache-x',
      { x: 5, y: 6 },
      { config: { coalescing: true, ttlSeconds: 30 } },
    );
    expect(node.config.coalescing).toBe(true);
    expect(node.config.ttlSeconds).toBe(30);
    expect(node.config.queueLimit).toBe(128);
    expect(() => makeNode('appServer', 'bad id', { x: 0, y: 0 })).toThrow(
      DomainValidationError,
    );
    expect(() => makeNode('appServer', 'x', { x: 10_001, y: 0 })).toThrow(
      DomainValidationError,
    );
  });
});

describe('parseGraph', () => {
  it('rejects unknown fields at document, node and config level', () => {
    const root = { ...createInitialGraph(), extra: true };
    expect(issuesOf(() => parseGraph(root))[0]?.code).toBe('schema');

    const nodeUnknown = createInitialGraph();
    const node = mustNode(nodeUnknown, 'app-1');
    (node as unknown as Record<string, unknown>).extra = 1;
    expect(issuesOf(() => parseGraph(nodeUnknown))[0]?.code).toBe('schema');

    const configUnknown = createInitialGraph();
    (mustNode(configUnknown, 'app-1').config as unknown as Record<string, unknown>).extra =
      1;
    expect(issuesOf(() => parseGraph(configUnknown))[0]?.code).toBe('schema');
  });

  it('rejects out-of-range ids, labels, coordinates, queues, pools and TTL', () => {
    const longId = createInitialGraph();
    mustNode(longId, 'app-1').id = `a${'b'.repeat(64)}`;
    expect(issuesOf(() => parseGraph(longId))[0]?.code).toBe('schema');

    const longLabel = createInitialGraph();
    mustNode(longLabel, 'app-1').label = 'l'.repeat(81);
    expect(issuesOf(() => parseGraph(longLabel))[0]?.code).toBe('schema');

    const coordinate = createInitialGraph();
    mustNode(coordinate, 'app-1').position.x = -10_001;
    expect(issuesOf(() => parseGraph(coordinate))[0]?.code).toBe('schema');

    const queue = createInitialGraph();
    mustNode(queue, 'app-1').config.queueLimit = 513;
    expect(issuesOf(() => parseGraph(queue))[0]?.code).toBe('schema');

    const pool = createInitialGraph();
    mustNode(pool, 'app-1').config.poolSize = 0;
    expect(issuesOf(() => parseGraph(pool))[0]?.code).toBe('schema');

    const ttl = createInitialGraph();
    mustNode(ttl, 'cache-1').config.ttlSeconds = 14;
    expect(issuesOf(() => parseGraph(ttl))[0]?.code).toBe('schema');

    const badPort = createInitialGraph();
    mustEdge(badPort, 'e-app-cache').sourcePort = 'in' as GraphEdge['sourcePort'];
    expect(issuesOf(() => parseGraph(badPort))[0]?.code).toBe('schema');

    const nonFinite = createInitialGraph();
    mustNode(nonFinite, 'app-1').position.x = Number.NaN;
    expect(issuesOf(() => parseGraph(nonFinite))[0]?.code).toBe('schema');
  });

  it('accepts the inclusive config bounds', () => {
    const graph = createInitialGraph();
    mustNode(graph, 'app-1').config.queueLimit = 512;
    mustNode(graph, 'app-1').config.poolSize = 64;
    mustNode(graph, 'cache-1').config.ttlSeconds = 15;
    mustNode(graph, 'cache-1').config.coalescing = true;
    mustNode(graph, 'cache-1').config.size = 'large';
    const parsed = parseGraph(graph);
    expect(mustNode(parsed, 'app-1').config.queueLimit).toBe(512);
    expect(mustNode(parsed, 'cache-1').config.ttlSeconds).toBe(15);
  });

  it('rejects more than 16 nodes or 24 edges and accepts the bounds', () => {
    const nodes = Array.from({ length: 17 }, (_, index) =>
      makeNode('client', `c-${index}`, { x: index, y: 0 }),
    );
    const tooManyNodes: GraphDocument = {
      schemaVersion: 1,
      levelId: 'cold-cache',
      nodes,
      edges: [],
    };
    expect(issuesOf(() => parseGraph(tooManyNodes))[0]?.code).toBe('schema');

    const edges = Array.from({ length: 25 }, (_, index) => ({
      id: `e-${index}`,
      source: 'client-1',
      target: 'app-1',
      sourcePort: 'out' as const,
    }));
    const tooManyEdges: GraphDocument = {
      schemaVersion: 1,
      levelId: 'cold-cache',
      nodes: Array.from({ length: 16 }, (_, index) =>
        makeNode('client', `c-${index}`, { x: index, y: 0 }),
      ),
      edges,
    };
    expect(issuesOf(() => parseGraph(tooManyEdges))[0]?.code).toBe('schema');

    const atNodeBound: GraphDocument = {
      schemaVersion: 1,
      levelId: 'cold-cache',
      nodes: nodes.slice(0, 16),
      edges: [],
    };
    expect(parseGraph(atNodeBound).nodes).toHaveLength(16);
    expect(validateGraph(atNodeBound, { mode: 'draft' })).toEqual([]);

    const atEdgeBound: GraphDocument = {
      schemaVersion: 1,
      levelId: 'cold-cache',
      nodes: nodes.slice(0, 2),
      edges: Array.from({ length: 24 }, (_, index) => ({
        id: `e-${index}`,
        source: 'client-1',
        target: 'app-1',
        sourcePort: 'out' as const,
      })),
    };
    expect(parseGraph(atEdgeBound).edges).toHaveLength(24);
  });

  it('parses JSON text and enforces the 1 MiB input bound', () => {
    const graph = createInitialGraph();
    expect(parseGraphJson(JSON.stringify(graph))).toEqual(graph);
    expect(issuesOf(() => parseGraphJson('{'))[0]?.code).toBe('invalid-json');

    const tooLarge = `${JSON.stringify(graph)}${' '.repeat(MAX_INPUT_BYTES)}`;
    expect(issuesOf(() => parseGraphJson(tooLarge))[0]?.code).toBe('input-too-large');
  });
});

describe('validateGraph structural checks', () => {
  it('detects duplicate node and edge ids', () => {
    const duplicateNode = createInitialGraph();
    duplicateNode.nodes.push({ ...mustNode(duplicateNode, 'app-1') });
    expect(validateGraph(duplicateNode, { mode: 'draft' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'duplicate-id', nodeId: 'app-1' }),
      ]),
    );

    const duplicateEdge = createInitialGraph();
    mustEdge(duplicateEdge, 'e-app-db').id = 'e-app-cache';
    expect(validateGraph(duplicateEdge, { mode: 'draft' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'duplicate-id', edgeId: 'e-app-cache' }),
      ]),
    );
  });

  it('detects dangling edges and self loops', () => {
    const dangling = createInitialGraph();
    mustEdge(dangling, 'e-app-cache').target = 'ghost';
    expect(validateGraph(dangling, { mode: 'draft' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'dangling-edge', edgeId: 'e-app-cache' }),
      ]),
    );

    const selfLoop = createInitialGraph();
    mustEdge(selfLoop, 'e-app-cache').target = 'app-1';
    expect(validateGraph(selfLoop, { mode: 'draft' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'self-loop' })]),
    );
  });

  it('detects cycles', () => {
    const graph = createInitialGraph();
    graph.edges.push({
      id: 'e-cache-app',
      source: 'cache-1',
      target: 'app-1',
      sourcePort: 'miss',
    });
    const codes = validateGraph(graph, { mode: 'draft' }).map((issue) => issue.code);
    expect(codes).toContain('cycle');
  });

  it('detects illegal ports and traffic into client or out of database', () => {
    const appOut = createInitialGraph();
    mustEdge(appOut, 'e-app-cache').sourcePort = 'out';
    expect(validateGraph(appOut, { mode: 'draft' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'illegal-port', edgeId: 'e-app-cache' }),
      ]),
    );

    const wrongTarget = createInitialGraph();
    mustEdge(wrongTarget, 'e-cache-db').target = 'app-1';
    expect(validateGraph(wrongTarget, { mode: 'draft' }).map((i) => i.code)).toContain(
      'illegal-port',
    );

    const intoClient = createInitialGraph();
    intoClient.edges.push({
      id: 'e-app-client',
      source: 'app-1',
      target: 'client-1',
      sourcePort: 'read',
    });
    expect(validateGraph(intoClient, { mode: 'draft' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'edge-into-client', edgeId: 'e-app-client' }),
      ]),
    );

    const outOfDb = createInitialGraph();
    outOfDb.edges.push({
      id: 'e-db-app',
      source: 'db-1',
      target: 'app-1',
      sourcePort: 'out',
    });
    expect(validateGraph(outOfDb, { mode: 'draft' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'edge-out-of-database', edgeId: 'e-db-app' }),
      ]),
    );
  });
});

describe('validateGraph drafts and run gates', () => {
  it('allows saving an unfinished graph but refuses to run it', () => {
    const withoutDb = createInitialGraph();
    withoutDb.nodes = withoutDb.nodes.filter((node) => node.id !== 'db-1');
    withoutDb.edges = withoutDb.edges.filter(
      (edge) => edge.source !== 'db-1' && edge.target !== 'db-1',
    );
    expect(parseGraph(withoutDb)).toEqual(withoutDb);
    expect(validateGraph(withoutDb, { mode: 'draft' })).toEqual([]);
    const runCodes = validateGraph(withoutDb).map((issue) => issue.code);
    expect(runCodes).toEqual(
      expect.arrayContaining(['missing-database', 'app-write', 'cache-miss']),
    );
  });

  it('accepts an empty draft and rejects required counts at run time', () => {
    const empty: GraphDocument = {
      schemaVersion: 1,
      levelId: 'cold-cache',
      nodes: [],
      edges: [],
    };
    expect(validateGraph(empty, { mode: 'draft' })).toEqual([]);
    const codes = validateGraph(empty).map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining(['missing-client', 'missing-database', 'app-count']),
    );
  });

  it('requires exactly one client out-edge, one app read/write and one cache miss', () => {
    const clientOut = createInitialGraph();
    clientOut.edges.push({
      id: 'e-client-db',
      source: 'client-1',
      target: 'db-1',
      sourcePort: 'out',
    });
    expect(validateGraph(clientOut).map((issue) => issue.code)).toContain(
      'client-connections',
    );

    const appWrite = createInitialGraph();
    appWrite.edges = appWrite.edges.filter((edge) => edge.id !== 'e-app-db');
    expect(validateGraph(appWrite).map((issue) => issue.code)).toContain('app-write');

    const appRead = createInitialGraph();
    appRead.edges = appRead.edges.filter((edge) => edge.id !== 'e-app-cache');
    expect(validateGraph(appRead).map((issue) => issue.code)).toContain('app-read');

    const cacheMiss = createInitialGraph();
    cacheMiss.edges = cacheMiss.edges.filter((edge) => edge.id !== 'e-cache-db');
    expect(validateGraph(cacheMiss).map((issue) => issue.code)).toContain('cache-miss');
  });

  it('allows an app to read directly from the database without a cache', () => {
    const graph = createInitialGraph();
    graph.nodes = graph.nodes.filter((node) => node.kind !== 'cache');
    graph.edges = graph.edges.filter(
      (edge) => edge.id !== 'e-app-cache' && edge.id !== 'e-cache-db',
    );
    mustEdge(graph, 'e-app-db').sourcePort = 'write';
    graph.edges.push({
      id: 'e-app-db-read',
      source: 'app-1',
      target: 'db-1',
      sourcePort: 'read',
    });
    expect(validateGraph(graph)).toEqual([]);
    expect(calculateCost(graph)).toBe(2_200_000);
  });

  it('reports unreachable nodes', () => {
    const graph = createInitialGraph();
    addApp(graph, 'app-2', 'cache-1', 'db-1');
    expect(validateGraph(graph)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unreachable-node',
          nodeId: 'app-2',
        }),
      ]),
    );
  });

  it('accepts multiple apps only through a load balancer', () => {
    const graph = createInitialGraph();
    graph.nodes.push(makeNode('loadBalancer', 'lb-1', { x: 120, y: 160 }));
    graph.nodes.push(makeNode('appServer', 'app-2', { x: 360, y: 280 }));
    graph.edges = graph.edges.filter((edge) => edge.id !== 'e-client-app');
    graph.edges.push(
      { id: 'e-client-lb', source: 'client-1', target: 'lb-1', sourcePort: 'out' },
      { id: 'e-lb-app1', source: 'lb-1', target: 'app-1', sourcePort: 'out' },
      { id: 'e-lb-app2', source: 'lb-1', target: 'app-2', sourcePort: 'out' },
      { id: 'e-app2-cache', source: 'app-2', target: 'cache-1', sourcePort: 'read' },
      { id: 'e-app2-db', source: 'app-2', target: 'db-1', sourcePort: 'write' },
    );
    expect(validateGraph(graph)).toEqual([]);

    const duplicateTarget = createInitialGraph();
    duplicateTarget.nodes.push(makeNode('loadBalancer', 'lb-1', { x: 120, y: 160 }));
    duplicateTarget.edges = duplicateTarget.edges.filter(
      (edge) => edge.id !== 'e-client-app',
    );
    duplicateTarget.edges.push(
      {
        id: 'e-client-lb',
        source: 'client-1',
        target: 'lb-1',
        sourcePort: 'out',
      },
      { id: 'e-lb-app1', source: 'lb-1', target: 'app-1', sourcePort: 'out' },
      { id: 'e-lb-app1-b', source: 'lb-1', target: 'app-1', sourcePort: 'out' },
    );
    expect(validateGraph(duplicateTarget).map((issue) => issue.code)).toContain(
      'lb-connections',
    );

    const emptyBalancer = createInitialGraph();
    emptyBalancer.nodes.push(makeNode('loadBalancer', 'lb-1', { x: 120, y: 160 }));
    emptyBalancer.edges = emptyBalancer.edges.filter(
      (edge) => edge.id !== 'e-client-app',
    );
    emptyBalancer.edges.push({
      id: 'e-client-lb',
      source: 'client-1',
      target: 'lb-1',
      sourcePort: 'out',
    });
    expect(validateGraph(emptyBalancer).map((issue) => issue.code)).toContain(
      'lb-connections',
    );
  });

  it('rejects multiple apps connected directly to the client', () => {
    const graph = createInitialGraph();
    addApp(graph, 'app-2', 'cache-1', 'db-1');
    graph.edges.push({
      id: 'e-client-app2',
      source: 'client-1',
      target: 'app-2',
      sourcePort: 'out',
    });
    expect(validateGraph(graph).map((issue) => issue.code)).toContain(
      'routing-requires-lb',
    );
  });

  it('does not treat an over-budget price as a topology error', () => {
    const graph = createInitialGraph();
    mustNode(graph, 'db-1').config.size = 'large';
    mustNode(graph, 'app-1').config.size = 'large';
    expect(calculateCost(graph)).toBeGreaterThan(5_500_000);
    expect(validateGraph(graph)).toEqual([]);
  });
});
