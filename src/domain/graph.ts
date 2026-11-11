import { z } from 'zod';

import {
  DEFAULT_COALESCING,
  DEFAULT_NODE_SIZE_BY_KIND,
  DEFAULT_POOL_SIZE,
  DEFAULT_QUEUE_LIMIT,
  DEFAULT_TTL_SECONDS,
  NODE_KINDS,
  NODE_KIND_LABELS,
  NODE_SIZES,
  type NodeKind,
  type NodeSize,
} from './catalog';
import {
  DomainValidationError,
  issuesFromSchemaError,
  utf8ByteLength,
  type ValidationIssue,
} from './errors';
import { deepFreeze } from './freeze';
import {
  ID_PATTERN,
  MAX_COORDINATE,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_NODES,
  MAX_ID_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_POOL_SIZE,
  MAX_QUEUE_LIMIT,
  MAX_TTL_SECONDS,
  MIN_POOL_SIZE,
  MIN_QUEUE_LIMIT,
  MIN_TTL_SECONDS,
  MAX_INPUT_BYTES,
} from './limits';

/**
 * Serializable graph document. This is the only shape stored, saved, exported
 * and sent to the worker; there are no class instances or library types.
 */
export interface GraphDocument {
  schemaVersion: 1;
  levelId: 'cold-cache';
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Position {
  x: number;
  y: number;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  position: Position;
  /**
   * One shared config object for every kind. Fields that do not apply to the
   * node's kind are preserved (so switching kind or saving never loses them)
   * but have no effect in the simulation and are not shown by the UI.
   */
  config: NodeConfig;
}

export interface NodeConfig {
  size: NodeSize;
  /** FIFO admission queue bound, 0..512; separate from active slots. */
  queueLimit: number;
  /** Downstream/app backend pool bound, 1..64. */
  poolSize: number;
  /** Cache TTL in seconds, 15..300 (inactive for non-cache kinds). */
  ttlSeconds: number;
  /** Cache fill coalescing (inactive for non-cache kinds). */
  coalescing: boolean;
}

export type EdgeSourcePort = 'out' | 'read' | 'write' | 'miss';

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** Semantics of the source port. The target port is implicit `in`. */
  sourcePort: EdgeSourcePort;
}

const idSchema = z
  .string()
  .min(1, 'id must not be empty')
  .max(MAX_ID_LENGTH, `id is longer than ${MAX_ID_LENGTH} characters`)
  .regex(ID_PATTERN, 'only Latin letters, digits, _ and - are allowed');

const positionSchema = z.strictObject({
  x: z
    .number()
    .min(-MAX_COORDINATE, `coordinate is below -${MAX_COORDINATE}`)
    .max(MAX_COORDINATE, `coordinate is above ${MAX_COORDINATE}`),
  y: z
    .number()
    .min(-MAX_COORDINATE, `coordinate is below -${MAX_COORDINATE}`)
    .max(MAX_COORDINATE, `coordinate is above ${MAX_COORDINATE}`),
});

export const nodeConfigSchema = z.strictObject({
  size: z.enum(NODE_SIZES),
  queueLimit: z.number().int().min(MIN_QUEUE_LIMIT).max(MAX_QUEUE_LIMIT),
  poolSize: z.number().int().min(MIN_POOL_SIZE).max(MAX_POOL_SIZE),
  ttlSeconds: z.number().int().min(MIN_TTL_SECONDS).max(MAX_TTL_SECONDS),
  coalescing: z.boolean(),
});

export const graphNodeSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(NODE_KINDS),
  label: z.string().min(1, 'label must not be empty').max(MAX_LABEL_LENGTH),
  position: positionSchema,
  config: nodeConfigSchema,
});

export const graphEdgeSchema = z.strictObject({
  id: idSchema,
  source: idSchema,
  target: idSchema,
  sourcePort: z.enum(['out', 'read', 'write', 'miss']),
});

export const graphDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  levelId: z.literal('cold-cache'),
  nodes: z.array(graphNodeSchema).max(MAX_GRAPH_NODES),
  edges: z.array(graphEdgeSchema).max(MAX_GRAPH_EDGES),
});

export interface MakeNodeOptions {
  label?: string;
  config?: Partial<NodeConfig>;
}

/**
 * Create a node with the catalog defaults for its kind:
 * small/medium/small sizes, queue 128, pool 8, TTL 120 s, coalescing off.
 * The result is validated, so invalid ids/labels/coordinates fail early.
 */
export function makeNode(
  kind: NodeKind,
  id: string,
  position: Position,
  options: MakeNodeOptions = {},
): GraphNode {
  const node: GraphNode = {
    id,
    kind,
    label: options.label ?? NODE_KIND_LABELS[kind],
    position: { x: position.x, y: position.y },
    config: {
      size: options.config?.size ?? DEFAULT_NODE_SIZE_BY_KIND[kind],
      queueLimit: options.config?.queueLimit ?? DEFAULT_QUEUE_LIMIT,
      poolSize: options.config?.poolSize ?? DEFAULT_POOL_SIZE,
      ttlSeconds: options.config?.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      coalescing: options.config?.coalescing ?? DEFAULT_COALESCING,
    },
  };

  const parsed = graphNodeSchema.safeParse(node);
  if (!parsed.success) {
    throw new DomainValidationError(
      `Invalid node "${id}"`,
      issuesFromSchemaError(parsed.error),
    );
  }
  return node;
}

/**
 * Strict schema parse for an untrusted graph. This validates shape, bounds and
 * unknown fields only; topology (including unfinished drafts) is checked by
 * `validateGraph` so editing an incomplete graph remains possible.
 */
export function parseGraph(input: unknown): GraphDocument {
  const parsed = graphDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainValidationError(
      'Invalid graph JSON',
      issuesFromSchemaError(parsed.error),
    );
  }
  return parsed.data;
}

/** Parse graph JSON text, enforcing the 1 MiB input bound first. */
export function parseGraphJson(text: string): GraphDocument {
  const bytes = utf8ByteLength(text);
  if (bytes > MAX_INPUT_BYTES) {
    throw new DomainValidationError('Graph JSON exceeds 1 MiB', [
      {
        code: 'input-too-large',
        message: `Size ${bytes} bytes exceeds the limit of ${MAX_INPUT_BYTES} bytes`,
      },
    ]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new DomainValidationError('Invalid graph JSON', [
      { code: 'invalid-json', message: 'Text is not valid JSON' },
    ]);
  }
  return parseGraph(value);
}

export interface ValidateGraphOptions {
  /**
   * `draft` keeps only structural checks (duplicates, dangling edges, loops,
   * illegal ports, cycles) so an unfinished graph can still be saved.
   * `run` additionally enforces counts, dependencies, routing and reachability.
   * Defaults to `run`.
   */
  mode?: 'draft' | 'run';
}

const SOURCE_PORTS: Readonly<Record<NodeKind, readonly EdgeSourcePort[]>> =
  Object.freeze({
    client: Object.freeze(['out'] as const),
    loadBalancer: Object.freeze(['out'] as const),
    appServer: Object.freeze(['read', 'write'] as const),
    cache: Object.freeze(['miss'] as const),
    database: Object.freeze([] as const),
  });

function isLegalEdge(source: NodeKind, target: NodeKind, port: EdgeSourcePort) {
  switch (port) {
    case 'out':
      return (
        (source === 'client' || source === 'loadBalancer') &&
        (target === 'appServer' || target === 'loadBalancer')
      );
    case 'read':
      return source === 'appServer' && (target === 'cache' || target === 'database');
    case 'write':
      return source === 'appServer' && target === 'database';
    case 'miss':
      return source === 'cache' && target === 'database';
  }
}

function edgesFrom(edges: readonly GraphEdge[], nodeId: string): GraphEdge[] {
  return edges.filter((edge) => edge.source === nodeId);
}

function findCycle(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  nodeIds: ReadonlySet<string>,
): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      adjacency.get(edge.source)?.push(edge.target);
    }
  }

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const nextState = state.get(next) ?? 0;
      if (nextState === 0) {
        const found = visit(next);
        if (found) {
          return found;
        }
      } else if (nextState === 1) {
        const start = stack.indexOf(next);
        return stack.slice(start);
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const node of nodes) {
    if ((state.get(node.id) ?? 0) === 0) {
      const found = visit(node.id);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Topology and dependency validation.
 *
 * Structural issues are reported in both modes. Run mode additionally enforces
 * one client and one database, 1..4 app servers, 0..1 cache/LB, client/LB/app/
 * cache wiring rules, reachability and LB-only routing for multiple apps.
 * Budget and SLO checks are intentionally not topology errors: exceeding the
 * price is a runtime SLO failure.
 */
export function validateGraph(
  graph: GraphDocument,
  options: ValidateGraphOptions = {},
): ValidationIssue[] {
  const mode = options.mode ?? 'run';
  const issues: ValidationIssue[] = [];
  const nodeById = new Map<string, GraphNode>();
  const duplicateNodeIds = new Set<string>();

  for (const node of graph.nodes) {
    if (nodeById.has(node.id)) {
      duplicateNodeIds.add(node.id);
    } else {
      nodeById.set(node.id, node);
    }
  }
  for (const id of duplicateNodeIds) {
    issues.push({
      code: 'duplicate-id',
      message: `Node id "${id}" is duplicated`,
      nodeId: id,
    });
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({
        code: 'duplicate-id',
        message: `Edge id "${edge.id}" is duplicated`,
        edgeId: edge.id,
      });
    }
    edgeIds.add(edge.id);
  }

  for (const edge of graph.edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) {
      issues.push({
        code: 'dangling-edge',
        message: `Edge "${edge.id}" references a missing node`,
        edgeId: edge.id,
      });
      continue;
    }
    if (edge.source === edge.target) {
      issues.push({
        code: 'self-loop',
        message: `Edge "${edge.id}" connects a node to itself`,
        edgeId: edge.id,
      });
      continue;
    }
    if (target.kind === 'client') {
      issues.push({
        code: 'edge-into-client',
        message: 'Edges cannot enter the client',
        edgeId: edge.id,
      });
      continue;
    }
    if (source.kind === 'database') {
      issues.push({
        code: 'edge-out-of-database',
        message: 'Edges cannot leave the database',
        edgeId: edge.id,
      });
      continue;
    }
    if (!SOURCE_PORTS[source.kind].includes(edge.sourcePort)) {
      issues.push({
        code: 'illegal-port',
        message: `Port "${edge.sourcePort}" is not available on node "${source.label}"`,
        edgeId: edge.id,
      });
      continue;
    }
    if (!isLegalEdge(source.kind, target.kind, edge.sourcePort)) {
      issues.push({
        code: 'illegal-port',
        message: `Port "${edge.sourcePort}" cannot connect to node "${target.label}"`,
        edgeId: edge.id,
      });
    }
  }

  const cycle = findCycle(graph.nodes, graph.edges, new Set(nodeById.keys()));
  if (cycle) {
    issues.push({
      code: 'cycle',
      message: `Cycle detected: ${cycle.join(' → ')}`,
      nodeId: cycle[0],
    });
  }

  if (mode === 'draft') {
    return issues;
  }

  const nodesOf = (kind: NodeKind) =>
    graph.nodes.filter((node) => node.kind === kind);
  const clients = nodesOf('client');
  const databases = nodesOf('database');
  const apps = nodesOf('appServer');
  const caches = nodesOf('cache');
  const balancers = nodesOf('loadBalancer');

  if (clients.length === 0) {
    issues.push({
      code: 'missing-client',
      message: 'One client is required as the load source',
    });
  } else if (clients.length > 1) {
    issues.push({
      code: 'client-count',
      message: `Exactly one client is required, found ${clients.length}`,
    });
  }

  if (databases.length === 0) {
    issues.push({
      code: 'missing-database',
      message: 'One database is required',
    });
  } else if (databases.length > 1) {
    issues.push({
      code: 'database-count',
      message: `Exactly one database is required, found ${databases.length}`,
    });
  }

  if (apps.length < 1 || apps.length > 4) {
    issues.push({
      code: 'app-count',
      message: `Between 1 and 4 app servers are required, found ${apps.length}`,
    });
  }

  if (caches.length > 1) {
    issues.push({
      code: 'cache-count',
      message: `At most one cache is allowed, found ${caches.length}`,
    });
  }

  if (balancers.length > 1) {
    issues.push({
      code: 'load-balancer-count',
      message: `At most one load balancer is allowed, found ${balancers.length}`,
    });
  }

  const primaryClient = clients[0];
  if (primaryClient) {
    const out = edgesFrom(graph.edges, primaryClient.id);
    if (out.length !== 1) {
      issues.push({
        code: 'client-connections',
        message: `The client must have exactly one outgoing edge, found ${out.length}`,
        nodeId: primaryClient.id,
      });
    }
    const onlyTarget = out.length === 1 ? nodeById.get(out[0]?.target ?? '') : undefined;
    if (onlyTarget && onlyTarget.kind === 'appServer' && apps.length > 1) {
      issues.push({
        code: 'routing-requires-lb',
        message:
          'Multiple app servers must be reachable only through a load balancer',
        nodeId: onlyTarget.id,
      });
    }
  }

  if (apps.length > 1 && balancers.length === 0) {
    issues.push({
      code: 'routing-requires-lb',
      message:
        'Multiple app servers must be reachable only through a load balancer',
    });
  }

  for (const balancer of balancers) {
    const out = edgesFrom(graph.edges, balancer.id);
    if (out.length === 0) {
      issues.push({
        code: 'lb-connections',
        message: 'The load balancer needs at least one outgoing edge to an app server',
        nodeId: balancer.id,
      });
    }
    const targets = new Set<string>();
    for (const edge of out) {
      const target = nodeById.get(edge.target);
      if (!target) {
        continue;
      }
      if (target.kind !== 'appServer') {
        issues.push({
          code: 'lb-connections',
          message: 'The load balancer can route traffic only to app servers',
          edgeId: edge.id,
        });
        continue;
      }
      if (targets.has(target.id)) {
        issues.push({
          code: 'lb-connections',
          message: `The load balancer routes traffic to "${target.label}" twice`,
          edgeId: edge.id,
        });
      }
      targets.add(target.id);
    }
  }

  for (const app of apps) {
    const out = edgesFrom(graph.edges, app.id);
    const readEdges = out.filter((edge) => edge.sourcePort === 'read');
    if (readEdges.length !== 1) {
      issues.push({
        code: 'app-read',
        message: `App server "${app.label}" must have exactly one read output, found ${readEdges.length}`,
        nodeId: app.id,
      });
    }
    const writeEdges = out.filter((edge) => edge.sourcePort === 'write');
    if (writeEdges.length !== 1) {
      issues.push({
        code: 'app-write',
        message: `App server "${app.label}" must have exactly one write output, found ${writeEdges.length}`,
        nodeId: app.id,
      });
    }
  }

  for (const cache of caches) {
    const out = edgesFrom(graph.edges, cache.id);
    const missEdges = out.filter((edge) => edge.sourcePort === 'miss');
    if (missEdges.length !== 1) {
      issues.push({
        code: 'cache-miss',
        message: `Cache "${cache.label}" must have exactly one miss output to the database, found ${missEdges.length}`,
        nodeId: cache.id,
      });
    }
  }

  if (primaryClient) {
    const reachable = new Set<string>([primaryClient.id]);
    const queue = [primaryClient.id];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        break;
      }
      for (const edge of graph.edges) {
        if (edge.source !== current || reachable.has(edge.target)) {
          continue;
        }
        if (nodeById.has(edge.target)) {
          reachable.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
    for (const node of graph.nodes) {
      if (!reachable.has(node.id)) {
        issues.push({
          code: 'unreachable-node',
          message: `Node "${node.label}" is unreachable from the client`,
          nodeId: node.id,
        });
      }
    }
  }

  return issues;
}

/** Convenience check: a graph may be run only when run-mode validation is clean. */
export function isGraphRunnable(graph: GraphDocument): boolean {
  return validateGraph(graph, { mode: 'run' }).length === 0;
}

/** Deep copy of a graph document; safe to hand to UI state or a worker. */
export function cloneGraph(graph: GraphDocument): GraphDocument {
  return {
    schemaVersion: graph.schemaVersion,
    levelId: graph.levelId,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      position: { x: node.position.x, y: node.position.y },
      config: { ...node.config },
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourcePort: edge.sourcePort,
    })),
  };
}

function buildInitialGraph(): GraphDocument {
  return {
    schemaVersion: 1,
    levelId: 'cold-cache',
    nodes: [
      makeNode('client', 'client-1', { x: 0, y: 160 }),
      makeNode('appServer', 'app-1', { x: 240, y: 160 }),
      makeNode('cache', 'cache-1', { x: 480, y: 40 }, { label: 'Catalog cache' }),
      makeNode('database', 'db-1', { x: 720, y: 160 }),
    ],
    edges: [
      { id: 'e-client-app', source: 'client-1', target: 'app-1', sourcePort: 'out' },
      { id: 'e-app-cache', source: 'app-1', target: 'cache-1', sourcePort: 'read' },
      { id: 'e-cache-db', source: 'cache-1', target: 'db-1', sourcePort: 'miss' },
      { id: 'e-app-db', source: 'app-1', target: 'db-1', sourcePort: 'write' },
    ],
  };
}

/**
 * Frozen starter graph: client → one small app; reads → medium cache → small
 * DB; writes → the same DB. Cost $2.60/h. Treat as the initial experiment, not
 * as a guaranteed failing graph.
 */
export const INITIAL_GRAPH: GraphDocument = deepFreeze(buildInitialGraph());

/** Fresh mutable copy of the starter graph. */
export function createInitialGraph(): GraphDocument {
  return cloneGraph(INITIAL_GRAPH);
}
