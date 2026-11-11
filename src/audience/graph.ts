import {
  AUDIENCE_LEVEL_ID,
  AUDIENCE_SCHEMA_VERSION,
  audienceGraphSchema,
  audienceIssueSchema,
  audienceIssuesFromZod,
  audienceLinkRole,
  type AudienceEdge,
  type AudienceGraph,
  type AudienceIssue,
  type AudienceLinkRole,
  type AudienceNode,
  type AudienceNodeKind,
  type AudienceParseResult,
} from './contracts';

/**
 * Parsing, semantic validation and digest for the Live Audience graph.
 *
 * The starter document contains only the fixed Users node: it parses but is
 * incomplete for a run. Validation reports actionable English issues and is
 * safe on every keystroke. The digest ignores labels, positions, node/edge
 * order, edge ids and node id spelling; it keeps component kinds, configs and
 * semantic routes. Physical fault targets therefore depend only on the
 * zero-based slot index and the case id.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const SECOND_OFFSET = 0x9e3779b9;

function hash32(text: string, offset: number): number {
  let hash = offset >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** JSON with recursively sorted object keys, so config key order is irrelevant. */
function canonicalString(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalString(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    return `{${entries
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalString(item)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Stable 16-hex-character semantic digest. Not a cryptographic hash and never
 * a substitute for server-side graph validation.
 */
export function audienceGraphDigest(graph: AudienceGraph): string {
  const nodes = graph.nodes
    .map((node) => ({
      kind: node.kind,
      config: canonicalString(node.config),
    }))
    .sort((left, right) => {
      const byKind = compareText(left.kind, right.kind);
      return byKind === 0 ? compareText(left.config, right.config) : byKind;
    });
  const kindById = new Map<string, AudienceNodeKind>();
  for (const node of graph.nodes) {
    if (!kindById.has(node.id)) {
      kindById.set(node.id, node.kind);
    }
  }
  const edges = graph.edges
    .map((edge) => ({
      fromKind: kindById.get(edge.from) ?? '?',
      toKind: kindById.get(edge.to) ?? '?',
      role: audienceLinkRole(
        kindById.get(edge.from) ?? 'users',
        kindById.get(edge.to) ?? 'users',
      ),
    }))
    .sort((left, right) => {
      const byFrom = compareText(left.fromKind, right.fromKind);
      if (byFrom !== 0) {
        return byFrom;
      }
      const byTo = compareText(left.toKind, right.toKind);
      return byTo === 0 ? compareText(left.role ?? '', right.role ?? '') : byTo;
    });
  const canonical = canonicalString({
    schemaVersion: graph.schemaVersion,
    levelId: graph.levelId,
    nodes,
    edges,
  });
  const first = hash32(canonical, FNV_OFFSET);
  const second = hash32(canonical, SECOND_OFFSET);
  return `${first.toString(16).padStart(8, '0')}${second
    .toString(16)
    .padStart(8, '0')}`;
}

export function parseAudienceGraph(
  input: unknown,
): AudienceParseResult<AudienceGraph> {
  const parsed = audienceGraphSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      value: null,
      issues: audienceIssuesFromZod(parsed.error),
    };
  }
  return { ok: true, value: parsed.data, issues: [] };
}

interface NodeIndex {
  readonly byId: Map<string, AudienceNode>;
  readonly counts: Record<AudienceNodeKind, number>;
}

function indexNodes(nodes: readonly AudienceNode[]): NodeIndex {
  const byId = new Map<string, AudienceNode>();
  const counts: Record<AudienceNodeKind, number> = {
    users: 0,
    lb: 0,
    app: 0,
    sql: 0,
    cache: 0,
    worker: 0,
  };
  for (const node of nodes) {
    counts[node.kind] += 1;
    if (!byId.has(node.id)) {
      byId.set(node.id, node);
    }
  }
  return { byId, counts };
}

function issue(
  code: string,
  message: string,
  options: Partial<AudienceIssue> = {},
): AudienceIssue {
  return audienceIssueSchema.parse({
    severity: 'error',
    code,
    message,
    ...options,
  });
}

export function validateAudienceGraph(
  graph: AudienceGraph,
): readonly AudienceIssue[] {
  const issues: AudienceIssue[] = [];
  const { byId, counts } = indexNodes(graph.nodes);

  if (byId.size !== graph.nodes.length) {
    issues.push(issue('duplicate_node_id', 'Every node needs a unique id.'));
  }
  if (counts.users !== 1) {
    issues.push(
      issue(
        counts.users === 0 ? 'missing-users' : 'duplicate-users',
        'The graph must contain exactly one fixed Users node.',
      ),
    );
  }
  if (counts.app !== 1) {
    issues.push(
      issue(
        counts.app === 0 ? 'missing-app' : 'duplicate-app',
        'The graph must contain exactly one Application service pool.',
      ),
    );
  }
  if (counts.sql !== 1) {
    issues.push(
      issue(
        counts.sql === 0 ? 'missing-sql' : 'duplicate-sql',
        'The graph must contain exactly one primary SQL Database.',
      ),
    );
  }
  if (counts.lb > 1) {
    issues.push(issue('duplicate-lb', 'At most one Load Balancer is allowed.'));
  }
  if (counts.cache > 1) {
    issues.push(issue('duplicate-cache', 'At most one Cache is allowed.'));
  }
  if (counts.worker > 1) {
    issues.push(issue('duplicate-worker', 'At most one Worker pool is allowed.'));
  }

  const edgeIds = new Set<string>();
  const endpointPairs = new Set<string>();
  const outgoing = new Map<string, AudienceEdge[]>();
  const incoming = new Map<string, AudienceEdge[]>();
  const nodeCount = byId.size;

  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push(
        issue('duplicate_edge_id', 'Every connection needs a unique id.', {
          edgeId: edge.id,
        }),
      );
    }
    edgeIds.add(edge.id);
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from === undefined || to === undefined) {
      issues.push(
        issue('dangling_edge', 'A connection points to a missing node.', {
          edgeId: edge.id,
        }),
      );
      continue;
    }
    if (edge.from === edge.to) {
      issues.push(
        issue('self_loop', 'A component cannot connect to itself.', {
          edgeId: edge.id,
        }),
      );
      continue;
    }
    const pair = `${edge.from}\u0000${edge.to}`;
    if (endpointPairs.has(pair)) {
      issues.push(
        issue(
          'ambiguous_link',
          'Two connections between the same components make the route ambiguous.',
          { edgeId: edge.id },
        ),
      );
      continue;
    }
    endpointPairs.add(pair);
    if (audienceLinkRole(from.kind, to.kind) === null) {
      issues.push(
        issue(
          'invalid_link',
          `A ${from.kind} component cannot connect directly to a ${to.kind} component in this level.`,
          { edgeId: edge.id },
        ),
      );
      continue;
    }
    const list = outgoing.get(from.id) ?? [];
    list.push(edge);
    outgoing.set(from.id, list);
    const back = incoming.get(to.id) ?? [];
    back.push(edge);
    incoming.set(to.id, back);
  }

  const users = graph.nodes.find((node) => node.kind === 'users');
  const lb = graph.nodes.find((node) => node.kind === 'lb');
  const app = graph.nodes.find((node) => node.kind === 'app');
  const sql = graph.nodes.find((node) => node.kind === 'sql');
  const cache = graph.nodes.find((node) => node.kind === 'cache');
  const worker = graph.nodes.find((node) => node.kind === 'worker');

  if (users !== undefined) {
    if ((incoming.get(users.id) ?? []).length > 0) {
      issues.push(
        issue('users-has-incoming-link', 'Users is a traffic source and has no incoming dependency.', {
          nodeId: users.id,
        }),
      );
    }
    const out = outgoing.get(users.id) ?? [];
    if (out.length !== 1) {
      issues.push(
        issue(
          'missing-traffic-link',
          'Users must have exactly one outgoing connection, either directly to the Application pool or to the Load Balancer.',
          { nodeId: users.id },
        ),
      );
    }
  }

  if (lb !== undefined && users !== undefined && app !== undefined) {
    const fromUsers = (outgoing.get(users.id) ?? []).filter(
      (edge) => edge.to === lb.id,
    );
    const toApp = (outgoing.get(lb.id) ?? []).filter(
      (edge) => edge.to === app.id,
    );
    if (fromUsers.length !== 1) {
      issues.push(
        issue(
          'missing-lb-ingress',
          'A Load Balancer needs the one Users -> Load Balancer connection.',
          { nodeId: lb.id },
        ),
      );
    }
    if (toApp.length !== 1) {
      issues.push(
        issue(
          'missing-lb-backend',
          'A Load Balancer needs exactly one connection to the Application pool.',
          { nodeId: lb.id },
        ),
      );
    }
    if ((incoming.get(lb.id) ?? []).length !== 1) {
      issues.push(
        issue('ambiguous-lb-ingress', 'The Load Balancer must have exactly one ingress connection.', {
          nodeId: lb.id,
        }),
      );
    }
  }

  if (app !== undefined) {
    const appIn = incoming.get(app.id) ?? [];
    if (appIn.length !== 1) {
      issues.push(
        issue(
          'ambiguous-app-ingress',
          'The Application pool must have exactly one ingress route: direct Users or a single Load Balancer. Spare instances are not used without the Load Balancer.',
          { nodeId: app.id },
        ),
      );
    }
    const appOut = outgoing.get(app.id) ?? [];
    if (sql !== undefined) {
      const toSql = appOut.filter((edge) => edge.to === sql.id);
      if (toSql.length !== 1) {
        issues.push(
          issue(
            'missing-primary-link',
            'The Application pool must connect to the primary SQL Database for ingest and direct reads.',
            { nodeId: app.id },
          ),
        );
      }
    }
    if (cache !== undefined) {
      const toCache = appOut.filter((edge) => edge.to === cache.id);
      if (toCache.length !== 1) {
        issues.push(
          issue(
            'missing-cache-read-link',
            'The Application pool must connect to the Cache for ranking reads.',
            { nodeId: cache.id },
          ),
        );
      }
    } else {
      const toCache = appOut.filter((edge) => {
        const to = byId.get(edge.to);
        return to?.kind === 'cache';
      });
      if (toCache.length > 0) {
        issues.push(
          issue('orphan-cache-link', 'A cache connection requires a Cache component.'),
        );
      }
    }
    const unexpected = appOut.filter((edge) => {
      const to = byId.get(edge.to);
      return to?.kind !== 'sql' && to?.kind !== 'cache';
    });
    if (unexpected.length > 0) {
      issues.push(
        issue('invalid-app-dependency', 'The Application pool may depend only on SQL and the optional Cache.', {
          nodeId: app.id,
        }),
      );
    }
  }

  if (cache !== undefined) {
    const cacheIn = incoming.get(cache.id) ?? [];
    const cacheOut = outgoing.get(cache.id) ?? [];
    if (cacheIn.length !== 1 || cacheOut.length !== 1) {
      issues.push(
        issue(
          'incomplete-cache-path',
          'The Cache needs one incoming Application connection and one outgoing SQL connection.',
          { nodeId: cache.id },
        ),
      );
    }
    if (
      sql !== undefined &&
      cacheOut.filter((edge) => edge.to === sql.id).length !== 1
    ) {
      issues.push(
        issue(
          'missing-cache-fill-link',
          'The Cache must connect to the same primary SQL Database for fills.',
          { nodeId: cache.id },
        ),
      );
    }
  } else {
    for (const edge of graph.edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (from?.kind === 'app' && to?.kind === 'cache') {
        issues.push(
          issue(
            'orphan-cache-link',
            'A cache connection requires a Cache component.',
            { edgeId: edge.id },
          ),
        );
      }
    }
  }

  if (worker !== undefined) {
    const workerIn = incoming.get(worker.id) ?? [];
    const workerOut = outgoing.get(worker.id) ?? [];
    if (workerIn.length > 0) {
      issues.push(
        issue('worker-has-incoming-link', 'A Worker polls SQL; it has no incoming dependency.', {
          nodeId: worker.id,
        }),
      );
    }
    if (
      sql === undefined ||
      workerOut.length !== 1 ||
      workerOut[0]?.to !== sql.id
    ) {
      issues.push(
        issue(
          'missing-worker-sql-link',
          'The Worker pool needs exactly one RPC dependency on the primary SQL Database.',
          { nodeId: worker.id },
        ),
      );
    }
  }

  if (sql !== undefined) {
    const sqlOut = outgoing.get(sql.id) ?? [];
    if (sqlOut.length > 0) {
      issues.push(
        issue(
          'sql-has-outgoing-link',
          'The primary SQL Database is a data sink; it has no outgoing dependency.',
          { nodeId: sql.id },
        ),
      );
    }
    const sqlIn = incoming.get(sql.id) ?? [];
    if (sqlIn.length === 0) {
      issues.push(
        issue('missing-sql-ingress', 'The primary SQL Database needs an Application connection.', {
          nodeId: sql.id,
        }),
      );
    }
  }

  if (app !== undefined && sql !== undefined) {
    const sqlNode = graph.nodes.find(
      (node): node is Extract<AudienceNode, { kind: 'sql' }> =>
        node.kind === 'sql',
    );
    const plan = sqlNode?.config.readPlan ?? null;
    if (plan === 'projection' && worker === undefined) {
      issues.push(
        issue(
          'missing-worker-for-projection',
          'The projection read plan needs a Worker pool connected to SQL. Without a worker the projection cannot complete.',
          { nodeId: sql.id },
        ),
      );
    }
    if (plan === 'query' && worker !== undefined) {
      issues.push(
        issue(
          'unused-worker',
          'The Worker pool only maintains a projection; with the query read plan it does no useful work but is still billed.',
          { severity: 'warning', nodeId: worker.id },
        ),
      );
    }
  }

  // Reachability uses validated semantic links only. Worker -> SQL is a data
  // dependency, so connectivity is checked without direction.
  const semantic = graph.edges.filter((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    return (
      from !== undefined &&
      to !== undefined &&
      from.id !== to.id &&
      audienceLinkRole(from.kind, to.kind) !== null
    );
  });
  const undirected = new Map<string, string[]>();
  const adjacency = new Map<string, string[]>();
  for (const edge of semantic) {
    const forward = adjacency.get(edge.from) ?? [];
    forward.push(edge.to);
    adjacency.set(edge.from, forward);
    const a = undirected.get(edge.from) ?? [];
    a.push(edge.to);
    undirected.set(edge.from, a);
    const b = undirected.get(edge.to) ?? [];
    b.push(edge.from);
    undirected.set(edge.to, b);
  }

  if (users !== undefined) {
    const reachable = new Set<string>();
    const stack = [users.id];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || reachable.has(current)) {
        continue;
      }
      reachable.add(current);
      for (const next of undirected.get(current) ?? []) {
        stack.push(next);
      }
    }
    if (reachable.size !== nodeCount) {
      const missing = graph.nodes
        .filter((node) => !reachable.has(node.id))
        .map((node) => node.id);
      issues.push(
        issue(
          'disconnected_graph',
          `Every component must be reachable from Users. Unreachable: ${missing.join(', ')}.`,
        ),
      );
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleNodes = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      cycleNodes.add(id);
      return;
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) {
      visit(next);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of graph.nodes) {
    visit(node.id);
  }
  if (cycleNodes.size > 0) {
    issues.push(
      issue('cyclic_graph', 'Dependency cycles are not supported by this level.'),
    );
  }

  return issues;
}

export function parseAndValidateAudienceGraph(
  input: unknown,
): AudienceParseResult<AudienceGraph> {
  const parsed = parseAudienceGraph(input);
  if (!parsed.ok) {
    return parsed;
  }
  const issues = validateAudienceGraph(parsed.value);
  if (issues.some((item) => item.severity === 'error')) {
    return { ok: false, value: null, issues };
  }
  return { ok: true, value: parsed.value, issues };
}

/** Starter document: the fixed Users node and nothing else. */
export function createAudienceStarterGraph(): AudienceGraph {
  return {
    schemaVersion: AUDIENCE_SCHEMA_VERSION,
    levelId: AUDIENCE_LEVEL_ID,
    nodes: [
      {
        id: 'users',
        kind: 'users',
        label: 'Users',
        position: { x: 80, y: 180 },
        config: {},
      },
    ],
    edges: [],
  };
}

export function cloneAudienceGraph(graph: AudienceGraph): AudienceGraph {
  return JSON.parse(JSON.stringify(graph)) as AudienceGraph;
}

/** Convenience for tests/UI factories; validation is still authoritative. */
export function createAudienceNode(
  kind: AudienceNodeKind,
  id: string,
  config: AudienceNode['config'],
  position = { x: 0, y: 0 },
): AudienceNode {
  return { id, kind, label: kind, position, config } as AudienceNode;
}

export function linkRoleOfAudienceEdge(
  graph: AudienceGraph,
  edge: AudienceEdge,
): AudienceLinkRole | null {
  const from = graph.nodes.find((node) => node.id === edge.from);
  const to = graph.nodes.find((node) => node.id === edge.to);
  if (from === undefined || to === undefined) {
    return null;
  }
  return audienceLinkRole(from.kind, to.kind);
}
