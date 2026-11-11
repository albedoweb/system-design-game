import {
  SCOREBOARD_LEVEL_ID,
  SCOREBOARD_SCHEMA_VERSION,
  scoreboardGraphSchema,
  scoreboardIssueSchema,
  scoreboardIssuesFromZod,
  scoreboardLinkRole,
  type ScoreboardEdge,
  type ScoreboardGraph,
  type ScoreboardIssue,
  type ScoreboardLinkRole,
  type ScoreboardNode,
  type ScoreboardNodeKind,
  type ScoreboardParseResult,
} from './contracts';

/**
 * Parsing, semantic validation and digest for the Live Scoreboard graph.
 *
 * The starter document contains only the fixed Users node. Parsing never
 * throws on unknown JSON; validation reports actionable English issues and is
 * safe to call on every keystroke. The digest ignores labels, positions and
 * edge ids but keeps every semantic node/config/endpoint decision.
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

/** Stable 16-hex-character digest. Not a cryptographic hash. */
export function scoreboardGraphDigest(graph: ScoreboardGraph): string {
  const nodes = [...graph.nodes]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((node) => ({ id: node.id, kind: node.kind, config: node.config }));
  const edges = [...graph.edges]
    .map((edge) => ({ from: edge.from, to: edge.to }))
    .sort((a, b) =>
      a.from < b.from
        ? -1
        : a.from > b.from
          ? 1
          : a.to < b.to
            ? -1
            : a.to > b.to
              ? 1
              : 0,
    );
  const canonical = JSON.stringify({
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

export function parseScoreboardGraph(
  input: unknown,
): ScoreboardParseResult<ScoreboardGraph> {
  const parsed = scoreboardGraphSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      value: null,
      issues: scoreboardIssuesFromZod(parsed.error),
    };
  }
  return { ok: true, value: parsed.data, issues: [] };
}

interface NodeIndex {
  readonly byId: Map<string, ScoreboardNode>;
  readonly counts: Record<ScoreboardNodeKind, number>;
}

function indexNodes(nodes: readonly ScoreboardNode[]): NodeIndex {
  const byId = new Map<string, ScoreboardNode>();
  const counts: Record<ScoreboardNodeKind, number> = {
    users: 0,
    app: 0,
    sql: 0,
    cache: 0,
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
  options: Partial<ScoreboardIssue> = {},
): ScoreboardIssue {
  return scoreboardIssueSchema.parse({
    severity: 'error',
    code,
    message,
    ...options,
  });
}

export function validateScoreboardGraph(
  graph: ScoreboardGraph,
): readonly ScoreboardIssue[] {
  const issues: ScoreboardIssue[] = [];
  const { byId, counts } = indexNodes(graph.nodes);

  if (byId.size !== graph.nodes.length) {
    issues.push(
      issue('duplicate_node_id', 'Every node needs a unique id.'),
    );
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
  if (counts.cache > 1) {
    issues.push(
      issue('duplicate-cache', 'At most one Cache is allowed.'),
    );
  }

  const edgeIds = new Set<string>();
  const endpointPairs = new Set<string>();
  const nodeCount = byId.size;
  const outgoing = new Map<string, ScoreboardEdge[]>();
  const incoming = new Map<string, ScoreboardEdge[]>();

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
    const role = scoreboardLinkRole(from.kind, to.kind);
    if (role === null) {
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
  const app = graph.nodes.find((node) => node.kind === 'app');
  const sql = graph.nodes.find((node) => node.kind === 'sql');
  const cache = graph.nodes.find((node) => node.kind === 'cache');

  if (users !== undefined && app !== undefined) {
    const fromUsers = outgoing.get(users.id) ?? [];
    const toApp = incoming.get(app.id) ?? [];
    if (fromUsers.length !== 1 || toApp.length !== 1) {
      issues.push(
        issue(
          'missing-traffic-link',
          'Users must have exactly one connection to the Application pool.',
          { nodeId: app.id },
        ),
      );
    }
  }

  if (app !== undefined && sql !== undefined) {
    const appToSql = (outgoing.get(app.id) ?? []).filter(
      (edge) => edge.to === sql.id,
    );
    if (appToSql.length !== 1) {
      issues.push(
        issue(
          'missing-write-link',
          'The Application pool must connect to the primary SQL Database.',
          { nodeId: app.id },
        ),
      );
    }
  }

  if (cache !== undefined) {
    if (app !== undefined) {
      const appToCache = (outgoing.get(app.id) ?? []).filter(
        (edge) => edge.to === cache.id,
      );
      if (appToCache.length !== 1) {
        issues.push(
          issue(
            'missing-cache-read-link',
            'The Application pool must connect to the Cache for leaderboard reads.',
            { nodeId: cache.id },
          ),
        );
      }
    }
    if (sql !== undefined) {
      const cacheToSql = (outgoing.get(cache.id) ?? []).filter(
        (edge) => edge.to === sql.id,
      );
      if (cacheToSql.length !== 1) {
        issues.push(
          issue(
            'missing-cache-fill-link',
            'The Cache must connect to the same primary SQL Database for fills.',
            { nodeId: cache.id },
          ),
        );
      }
    }
  } else {
    for (const edge of graph.edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (
        (from?.kind === 'app' && to?.kind === 'cache') ||
        (from?.kind === 'cache' && to?.kind === 'sql')
      ) {
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

  if (sql !== undefined) {
    const sqlOut = outgoing.get(sql.id) ?? [];
    if (sqlOut.length > 0) {
      issues.push(
        issue('sql-has-outgoing-link', 'The primary SQL Database is a data sink; it has no outgoing dependency.', {
          nodeId: sql.id,
        }),
      );
    }
    if (cache === undefined) {
      const appToCache = graph.edges.filter((edge) => {
        const to = byId.get(edge.to);
        return to?.kind === 'cache';
      });
      if (appToCache.length > 0) {
        issues.push(
          issue('orphan-cache-link', 'A cache connection requires a Cache component.'),
        );
      }
    }
  }

  // Reachability and cycle checks use only validated semantic links.
  const semantic = graph.edges.filter((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    return (
      from !== undefined &&
      to !== undefined &&
      from.id !== to.id &&
      scoreboardLinkRole(from.kind, to.kind) !== null
    );
  });
  const adjacency = new Map<string, string[]>();
  for (const edge of semantic) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }

  const reachable = new Set<string>();
  if (users !== undefined) {
    const stack = [users.id];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || reachable.has(current)) {
        continue;
      }
      reachable.add(current);
      for (const next of adjacency.get(current) ?? []) {
        stack.push(next);
      }
    }
  }
  if (users !== undefined && reachable.size !== nodeCount) {
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
      issue(
        'cyclic_graph',
        'Dependency cycles are not supported by this level.',
      ),
    );
  }

  return issues;
}

export function parseAndValidateScoreboardGraph(
  input: unknown,
): ScoreboardParseResult<ScoreboardGraph> {
  const parsed = parseScoreboardGraph(input);
  if (!parsed.ok) {
    return parsed;
  }
  const issues = validateScoreboardGraph(parsed.value);
  if (issues.some((item) => item.severity === 'error')) {
    return { ok: false, value: null, issues };
  }
  return { ok: true, value: parsed.value, issues };
}

/** Starter document: the fixed Users node and nothing else. */
export function createScoreboardStarterGraph(): ScoreboardGraph {
  return {
    schemaVersion: SCOREBOARD_SCHEMA_VERSION,
    levelId: SCOREBOARD_LEVEL_ID,
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

export function cloneScoreboardGraph(graph: ScoreboardGraph): ScoreboardGraph {
  return JSON.parse(JSON.stringify(graph)) as ScoreboardGraph;
}

/** Convenience for tests/UI factories; validation is still authoritative. */
export function createScoreboardNode(
  kind: ScoreboardNodeKind,
  id: string,
  config: ScoreboardNode['config'],
  position = { x: 0, y: 0 },
): ScoreboardNode {
  return { id, kind, label: kind, position, config } as ScoreboardNode;
}

export function linkRoleOfEdge(
  graph: ScoreboardGraph,
  edge: ScoreboardEdge,
): ScoreboardLinkRole | null {
  const from = graph.nodes.find((node) => node.id === edge.from);
  const to = graph.nodes.find((node) => node.id === edge.to);
  if (from === undefined || to === undefined) {
    return null;
  }
  return scoreboardLinkRole(from.kind, to.kind);
}
