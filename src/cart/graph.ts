import {
  CART_LEVEL_ID,
  CART_LIMITS,
  CART_NODE_KIND_INFO,
  CART_REGIONS,
  CART_REGION_INFO,
  CART_VERSIONS,
  canonicalJson,
  cartGraphSchema,
  cartCanonicalProfileForContent,
  type CartContentVersion,
  cartIssuesFromZod,
  sha256Hex,
  type CartApplicationNode,
  type CartCircuit,
  type CartEdge,
  type CartGraph,
  type CartIssue,
  type CartNode,
  type CartParseResult,
  type CartRegion,
  type CartSizedServiceNode,
} from './contracts';

/**
 * Global Cart graph parsing, starter graph, semantic validation and digest.
 *
 * Parsing is atomic: a document is either accepted whole or rejected with
 * issues, and nothing partial replaces the player's current design. Validation
 * distinguishes structural defects (the graph is unusable) from qualification
 * gaps (a source-only starter is a legitimate intermediate state).
 */

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Strict parse. With `targetContent`, a design stamped with the *other* known
 * content version is accepted only through an explicit, atomic restamp: the
 * whole document is first validated by the strict schema, then only
 * `contentVersion` is rewritten and the original identity is reported in
 * `migratedFrom`. Unknown content versions are always rejected.
 */
export function parseCartGraph(input: unknown, targetContent?: CartContentVersion): CartParseResult {
  const parsed = cartGraphSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: cartIssuesFromZod(parsed.error) };
  }
  if (targetContent !== undefined && parsed.data.contentVersion !== targetContent) {
    return {
      ok: true,
      graph: { ...parsed.data, contentVersion: targetContent },
      migratedFrom: parsed.data.contentVersion,
    };
  }
  return { ok: true, graph: parsed.data };
}

export function parseCartGraphJson(text: string, targetContent?: CartContentVersion): CartParseResult {
  const bytes = utf8ByteLength(text);
  if (bytes > CART_LIMITS.maxDocumentBytes) {
    return {
      ok: false,
      issues: [
        {
          code: 'input_too_large',
          message: `The document is ${bytes} bytes; the limit is ${CART_LIMITS.maxDocumentBytes} bytes.`,
        },
      ],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      issues: [{ code: 'invalid_json', message: 'The document is not valid JSON.' }],
    };
  }
  return parseCartGraph(value, targetContent);
}

export function cloneCartNode(node: CartNode): CartNode {
  return JSON.parse(JSON.stringify(node)) as CartNode;
}

export function cloneCartGraph(graph: CartGraph): CartGraph {
  return JSON.parse(JSON.stringify(graph)) as CartGraph;
}

// ---------------------------------------------------------------------------
// Starter graph (source-only reset/import fixture; exact cart-protocol-v1 B1)
// ---------------------------------------------------------------------------

const STARTER_POSITIONS: Readonly<Record<CartRegion, { readonly x: number; readonly y: number }>> = {
  'us-west': { x: 80, y: 80 },
  'eu-central': { x: 480, y: 80 },
  'ap-northeast': { x: 880, y: 80 },
};

/** Canonical fixed regional customer source ids. */
export function cartCustomersId(region: CartRegion): string {
  return `customers-${region}`;
}

/**
 * The exact reset/import starter: three fixed regional customer sources, no
 * services, no edges and no provisioned circuits. Refresh and Reset use this
 * fixture; it is never restored automatically from a saved design.
 */
export function createCartStarterGraph(): CartGraph {
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes: CART_REGIONS.map((region) => ({
      id: cartCustomersId(region),
      kind: 'customers' as const,
      region,
      position: { x: STARTER_POSITIONS[region].x, y: STARTER_POSITIONS[region].y },
    })),
    edges: [],
    circuits: [],
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function pushIssue(
  issues: CartIssue[],
  code: string,
  message: string,
  refs: { nodeId?: string; edgeId?: string } = {},
): void {
  issues.push({ code, message, ...refs });
}

const DURABLE_WRITE_KINDS: ReadonlySet<CartNode['kind']> = new Set(['journal', 'store']);
const READ_TARGET_KINDS: ReadonlySet<CartNode['kind']> = new Set([
  'journal',
  'store',
  'application',
]);

function circuitKey(a: CartRegion, b: CartRegion): string {
  const ordinalA = CART_REGION_INFO[a].ordinal;
  const ordinalB = CART_REGION_INFO[b].ordinal;
  return ordinalA <= ordinalB ? `${a}|${b}` : `${b}|${a}`;
}

function requestAdjacency(
  graph: CartGraph,
  byId: ReadonlyMap<string, CartNode>,
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) adjacency.set(node.id, []);
  for (const edge of graph.edges) {
    if (edge.kind !== 'request') continue;
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const out = adjacency.get(edge.from);
    if (out) out.push(edge.to);
  }
  return adjacency;
}

/** Reachable through one or more drawn request edges (directed, no transit). */
function reachableByRequest(
  adjacency: ReadonlyMap<string, readonly string[]>,
  from: string,
  target: string,
): boolean {
  const seen = new Set<string>([from]);
  const queue = [...(adjacency.get(from) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (next === target) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(adjacency.get(next) ?? []));
  }
  return false;
}

function findRequestCycles(
  graph: CartGraph,
  byId: ReadonlyMap<string, CartNode>,
  adjacency: ReadonlyMap<string, readonly string[]>,
): Array<{ nodeIds: string[]; edgeId?: string }> {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: Array<{ nodeIds: string[]; edgeId?: string }> = [];
  const edgeFor = new Map<string, CartEdge>();
  for (const edge of graph.edges) {
    if (edge.kind === 'request') edgeFor.set(`${edge.from}>${edge.to}`, edge);
  }

  const visit = (nodeId: string): void => {
    state.set(nodeId, 1);
    stack.push(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      if (!byId.has(next)) continue;
      const nextState = state.get(next) ?? 0;
      if (nextState === 0) {
        visit(next);
      } else if (nextState === 1) {
        const start = stack.indexOf(next);
        const nodeIds = stack.slice(start >= 0 ? start : 0).concat(next);
        cycles.push({
          nodeIds,
          edgeId: edgeFor.get(`${nodeId}>${next}`)?.id,
        });
      }
    }
    stack.pop();
    state.set(nodeId, 2);
  };

  for (const node of graph.nodes) {
    if ((state.get(node.id) ?? 0) === 0) visit(node.id);
  }
  return cycles;
}

// ---------------------------------------------------------------------------
// Semantic validation
// ---------------------------------------------------------------------------

/**
 * Semantic validation. Every problem is returned with a stable code and a
 * short English message; this function never throws for ordinary input.
 */
export function validateCartGraph(graph: CartGraph): CartIssue[] {
  const issues: CartIssue[] = [];
  const byId = new Map<string, CartNode>();

  if (graph.nodes.length > CART_LIMITS.maxNodes) {
    pushIssue(
      issues,
      'node_limit_exceeded',
      `The graph has ${graph.nodes.length} nodes; the limit is ${CART_LIMITS.maxNodes}.`,
    );
  }
  if (graph.edges.length > CART_LIMITS.maxEdges) {
    pushIssue(
      issues,
      'edge_limit_exceeded',
      `The graph has ${graph.edges.length} edges; the limit is ${CART_LIMITS.maxEdges}.`,
    );
  }
  if (graph.circuits.length > CART_LIMITS.maxCircuits) {
    pushIssue(
      issues,
      'duplicate_circuit',
      `The graph has ${graph.circuits.length} circuits; at most one per unordered region pair is allowed.`,
    );
  }

  for (const node of graph.nodes) {
    if (byId.has(node.id)) {
      pushIssue(
        issues,
        'duplicate_node_id',
        `Node id "${node.id}" is used more than once.`,
        { nodeId: node.id },
      );
      continue;
    }
    byId.set(node.id, node);
  }

  // Fixed regional sources: exactly one canonical customers node per region.
  for (const region of CART_REGIONS) {
    const sources = graph.nodes.filter(
      (node) => node.kind === 'customers' && node.region === region,
    );
    if (sources.length === 0) {
      pushIssue(
        issues,
        'missing_customers_region',
        `Region ${CART_REGION_INFO[region].label} has no customer source.`,
        { nodeId: cartCustomersId(region) },
      );
    }
    for (const source of sources) {
      const expectedId = cartCustomersId(region);
      if (source.id !== expectedId) {
        pushIssue(
          issues,
          'source_id_not_canonical',
          `The customer source for ${CART_REGION_INFO[region].label} must use the fixed id "${expectedId}".`,
          { nodeId: source.id },
        );
      }
    }
  }

  // Regional singleton services.
  for (const region of CART_REGIONS) {
    const applications = graph.nodes.filter(
      (node) => node.kind === 'application' && node.region === region,
    );
    if (applications.length === 0) {
      pushIssue(
        issues,
        'missing_application_region',
        `Region ${CART_REGION_INFO[region].label} has no Application.`,
      );
    }
    if (applications.length > 1) {
      for (const extra of applications.slice(1)) {
        pushIssue(
          issues,
          'duplicate_regional_service',
          `Region ${CART_REGION_INFO[region].label} has more than one Application.`,
          { nodeId: extra.id },
        );
      }
    }
    for (const kind of ['cache', 'journal', 'store'] as const) {
      const nodes = graph.nodes.filter(
        (node) => node.kind === kind && node.region === region,
      );
      for (const extra of nodes.slice(1)) {
        pushIssue(
          issues,
          'duplicate_regional_service',
          `Region ${CART_REGION_INFO[region].label} has more than one ${CART_NODE_KIND_INFO[kind].label}.`,
          { nodeId: extra.id },
        );
      }
    }
  }

  const inventories = graph.nodes.filter((node) => node.kind === 'inventory');
  if (inventories.length === 0) {
    pushIssue(
      issues,
      'missing_inventory',
      'A qualifying graph needs exactly one Inventory node.',
    );
  }
  for (const extra of inventories.slice(1)) {
    pushIssue(
      issues,
      'duplicate_regional_service',
      'Only one Inventory node is allowed in the whole graph.',
      { nodeId: extra.id },
    );
  }

  // Edge structure.
  const adjacency = requestAdjacency(graph, byId);
  const seenEdgeIds = new Set<string>();
  const seenSemanticEdges = new Set<string>();
  const purchasedPairs = new Set<string>();

  for (const circuit of graph.circuits) {
    const [a, b] = circuit.regions;
    if (a === b) {
      pushIssue(
        issues,
        'circuit_same_region',
        `A circuit must connect two different regions, not ${a} to itself.`,
      );
      continue;
    }
    if (CART_REGION_INFO[a].ordinal > CART_REGION_INFO[b].ordinal) {
      pushIssue(
        issues,
        'circuit_regions_unsorted',
        `Circuit regions must be in canonical order: "${b}", "${a}".`,
      );
    }
    const key = circuitKey(a, b);
    if (purchasedPairs.has(key)) {
      pushIssue(
        issues,
        'duplicate_circuit',
        `Only one circuit may be purchased for the ${a} / ${b} pair.`,
      );
    }
    purchasedPairs.add(key);
  }

  for (const edge of graph.edges) {
    if (seenEdgeIds.has(edge.id)) {
      pushIssue(
        issues,
        'duplicate_edge_id',
        `Edge id "${edge.id}" is used more than once.`,
        { edgeId: edge.id },
      );
      continue;
    }
    seenEdgeIds.add(edge.id);

    const semanticKey = `${edge.from}|${edge.to}|${edge.kind}`;
    if (seenSemanticEdges.has(semanticKey)) {
      pushIssue(
        issues,
        'duplicate_semantic_edge',
        `Duplicate ${edge.kind} edge from "${edge.from}" to "${edge.to}".`,
        { edgeId: edge.id },
      );
      continue;
    }
    seenSemanticEdges.add(semanticKey);

    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      const missing = !from ? edge.from : edge.to;
      pushIssue(
        issues,
        'unknown_node_ref',
        `Edge "${edge.id}" references the missing node "${missing}".`,
        { edgeId: edge.id, nodeId: missing },
      );
      continue;
    }
    if (from.id === to.id) {
      pushIssue(
        issues,
        'self_edge',
        `Edge "${edge.id}" connects "${edge.from}" to itself.`,
        { edgeId: edge.id, nodeId: edge.id },
      );
      continue;
    }

    if (edge.kind === 'request') {
      if (from.kind === 'customers') {
        const targetIsOwnApplication =
          to.kind === 'application' && to.region === from.region;
        if (!targetIsOwnApplication) {
          pushIssue(
            issues,
            'customers_target_rule',
            `Customer source "${from.id}" may only connect to its own region's Application.`,
            { edgeId: edge.id, nodeId: from.id },
          );
        }
      } else if (to.kind === 'customers') {
        pushIssue(
          issues,
          'request_into_customers',
          `Requests cannot target the customer source "${to.id}".`,
          { edgeId: edge.id, nodeId: to.id },
        );
      } else if (from.kind === 'inventory') {
        pushIssue(
          issues,
          'request_edge_endpoints',
          'Inventory answers transactions; it cannot be a request source.',
          { edgeId: edge.id, nodeId: from.id },
        );
      }
    } else {
      if (from.kind === 'customers' || from.kind === 'cache' || from.kind === 'inventory') {
        pushIssue(
          issues,
          'replication_edge_endpoints',
          `A ${from.kind} node cannot originate replication.`,
          { edgeId: edge.id, nodeId: from.id },
        );
      }
      if (!DURABLE_WRITE_KINDS.has(to.kind)) {
        pushIssue(
          issues,
          'replication_target_not_durable',
          `Replication must target a durable journal or cart store, not "${to.kind}".`,
          { edgeId: edge.id, nodeId: to.id },
        );
      }
    }

    if (from.region !== to.region) {
      const key = circuitKey(from.region, to.region);
      if (!purchasedPairs.has(key)) {
        pushIssue(
          issues,
          'missing_circuit',
          `Cross-region edge "${edge.id}" needs a purchased ${from.region} / ${to.region} circuit.`,
          { edgeId: edge.id },
        );
      }
    }
  }

  // Application authority/fallback paths must be explicit and reachable.
  for (const node of graph.nodes) {
    if (node.kind !== 'application') continue;
    const application: CartApplicationNode = node;

    const writeTarget = byId.get(application.writeTarget);
    if (!writeTarget) {
      pushIssue(
        issues,
        'write_target_missing',
        `Application "${application.id}" names the missing write target "${application.writeTarget}".`,
        { nodeId: application.id },
      );
    } else if (!DURABLE_WRITE_KINDS.has(writeTarget.kind)) {
      pushIssue(
        issues,
        'write_target_not_durable',
        `Application "${application.id}" must acknowledge on a durable journal or cart store, not a ${writeTarget.kind}.`,
        { nodeId: application.id },
      );
    } else if (!reachableByRequest(adjacency, application.id, writeTarget.id)) {
      pushIssue(
        issues,
        'write_target_unreachable',
        `Application "${application.id}" has no drawn request path to its write target "${writeTarget.id}".`,
        { nodeId: application.id },
      );
    }

    const seenTargets = new Set<string>();
    for (const targetId of application.readTargets) {
      if (seenTargets.has(targetId)) {
        pushIssue(
          issues,
          'read_target_duplicate',
          `Application "${application.id}" lists read target "${targetId}" more than once.`,
          { nodeId: application.id },
        );
        continue;
      }
      seenTargets.add(targetId);

      const target = byId.get(targetId);
      if (!target) {
        pushIssue(
          issues,
          'read_target_missing',
          `Application "${application.id}" names the missing read target "${targetId}".`,
          { nodeId: application.id },
        );
      } else if (!READ_TARGET_KINDS.has(target.kind)) {
        pushIssue(
          issues,
          'read_target_kind',
          `Read repair may target a journal, cart store or Application, not a ${target.kind}.`,
          { nodeId: application.id },
        );
      } else if (!reachableByRequest(adjacency, application.id, target.id)) {
        pushIssue(
          issues,
          'read_target_unreachable',
          `Application "${application.id}" has no drawn request path to read target "${target.id}".`,
          { nodeId: application.id },
        );
      }
    }
    const inventory = inventories[0];
    if (
      inventory !== undefined &&
      !reachableByRequest(adjacency, application.id, inventory.id)
    ) {
      pushIssue(
        issues,
        'inventory_unreachable',
        `Application "${application.id}" has no drawn request path to the Inventory node "${inventory.id}".`,
        { nodeId: application.id },
      );
    }
  }

  for (const cycle of findRequestCycles(graph, byId, adjacency)) {
    pushIssue(
      issues,
      'request_cycle',
      `Request routing cannot cycle: ${cycle.nodeIds.join(' -> ')}.`,
      {
        ...(cycle.edgeId === undefined ? {} : { edgeId: cycle.edgeId }),
      },
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Canonical semantic normalization and digest
// ---------------------------------------------------------------------------

interface CartSlot {
  readonly region: number;
  readonly kind: number;
}

function nodeSlot(node: CartNode): CartSlot {
  return {
    region: CART_REGION_INFO[node.region].ordinal,
    kind: CART_NODE_KIND_INFO[node.kind].ordinal,
  };
}

function slotKey(slot: CartSlot | null): string {
  return slot === null ? '~' : `${slot.region}:${slot.kind}`;
}

function sortByKeys<T>(entries: T[], keyOf: (entry: T) => string): T[] {
  return [...entries].sort((left, right) => {
    const leftKey = keyOf(left);
    const rightKey = keyOf(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function nodeBody(
  node: CartNode,
  slotOf: (id: string) => CartSlot | null,
): Record<string, unknown> {
  switch (node.kind) {
    case 'customers':
      return {};
    case 'application':
      return {
        size: node.size,
        instances: node.instances,
        writeTarget: slotOf(node.writeTarget),
        readPolicy: node.readPolicy,
        readTargets: node.readTargets.map(slotOf),
      };
    default: {
      const service: CartSizedServiceNode = node;
      return { size: service.size };
    }
  }
}

/**
 * Semantic normalization: node ids become fixed `(region ordinal, kind
 * ordinal)` slots, target slots and read targets are sorted as sets, edges are
 * sorted by `(fromSlot,toSlot,kind)` and circuits by unordered region pair.
 * Labels, positions, ids, enumeration order, object key order and the seed do
 * not participate. SHA-256 over canonical JSON is the semantic graph digest.
 */
export function cartGraphDigest(graph: CartGraph): string {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const slotOf = (id: string): CartSlot | null => {
    const node = byId.get(id);
    return node ? nodeSlot(node) : null;
  };

  const nodes = sortByKeys(
    graph.nodes.map((node) => ({
      slot: nodeSlot(node),
      body: nodeBody(node, slotOf),
    })),
    (entry) => `${slotKey(entry.slot)}|${canonicalJson(entry.body)}`,
  );

  const edges = sortByKeys(
    graph.edges.map((edge) => ({
      from: slotOf(edge.from),
      to: slotOf(edge.to),
      kind: edge.kind,
    })),
    (entry) => `${slotKey(entry.from)}>${slotKey(entry.to)}|${entry.kind}`,
  );

  const circuits: Array<{ regions: number[]; mbps: number }> = sortByKeys(
    graph.circuits.map((circuit: CartCircuit) => ({
      regions: circuit.regions
        .map((region) => CART_REGION_INFO[region].ordinal)
        .sort((left, right) => left - right),
      mbps: circuit.mbps,
    })),
    (entry) => `${entry.regions.join(':')}|${entry.mbps}`,
  );

  const semantic = {
    levelId: graph.levelId,
    graphVersion: graph.graphVersion,
    contentVersion: graph.contentVersion,
    profileVersion: cartCanonicalProfileForContent(graph.contentVersion),
    nodes,
    edges,
    circuits,
  };

  return sha256Hex(canonicalJson(semantic));
}
