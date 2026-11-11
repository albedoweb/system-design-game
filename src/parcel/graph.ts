import { PARCEL_CATALOG } from './catalog';
import {
  PARCEL_BUSINESS_OPERATIONS,
  PARCEL_LEVEL_ID,
  PARCEL_NODE_KINDS,
  PARCEL_OPERATIONS,
  PARCEL_SCHEMA_VERSION,
  PARCEL_STORE_KINDS,
  type ParcelBusinessOperation,
  type ParcelEdge,
  type ParcelGraph,
  type ParcelIssue,
  type ParcelNode,
  type ParcelNodeConfig,
  type ParcelNodeKind,
  type ParcelNodeSize,
  type ParcelOperation,
  type ParcelParseResult,
  type ParcelPosition,
  type ParcelValidationOptions,
} from './contracts';

const MAX_NODES = 32;
const MAX_EDGES = 64;
const MAX_STORAGE_TB = 256;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const NODE_KEYS = ['id', 'kind', 'label', 'position', 'config'] as const;
const EDGE_KEYS = ['id', 'source', 'target', 'operation'] as const;
const GRAPH_KEYS = ['schemaVersion', 'levelId', 'name', 'nodes', 'edges'] as const;
const POSITION_KEYS = ['x', 'y'] as const;
const CONFIG_KEYS_BY_KIND: Record<ParcelNodeKind, readonly string[]> = {
  client: ['size'],
  app: ['size'],
  sql: [
    'size',
    'storageTb',
    'index',
    'partition',
    'latestStatus',
    'rollups',
    'retentionYears',
    'compression',
  ],
  kv: [
    'size',
    'storageTb',
    'partition',
    'latestStatus',
    'rollups',
    'retentionYears',
    'compression',
  ],
  columnar: [
    'size',
    'storageTb',
    'partition',
    'rollups',
    'retentionYears',
    'batchIntervalMs',
    'compression',
    'columnProjection',
  ],
};

function issue(
  severity: 'error' | 'warning' | 'info',
  code: string,
  message: string,
  extra: Omit<ParcelIssue, 'severity' | 'code' | 'message'> = {},
): ParcelIssue {
  return { severity, code, message, ...extra };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ParcelIssue[],
): boolean {
  let ok = true;
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      issues.push(
        issue('error', 'prototype_key', `Unsafe key "${key}" is not allowed at ${path}.`),
      );
      ok = false;
      continue;
    }
    if (!allowed.includes(key)) {
      issues.push(
        issue(
          'error',
          'unknown_field',
          `Unknown field "${key}" at ${path}. Imported graphs cannot add fields or override the level.`,
        ),
      );
      ok = false;
    }
  }
  return ok;
}

function readString(
  value: unknown,
  path: string,
  issues: ParcelIssue[],
  fallback?: string,
): string | null {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(issue('error', 'invalid_string', `${path} must be a non-empty string.`));
    return null;
  }
  return value;
}

function readId(value: unknown, path: string, issues: ParcelIssue[]): string | null {
  const text = readString(value, path, issues);
  if (text === null) {
    return null;
  }
  if (!ID_PATTERN.test(text)) {
    issues.push(
      issue(
        'error',
        'invalid_id',
        `${path} must match ${ID_PATTERN.source} (letters, digits, dot, underscore, colon or dash).`,
      ),
    );
    return null;
  }
  return text;
}

function readNumber(
  value: unknown,
  path: string,
  min: number,
  max: number,
  issues: ParcelIssue[],
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(issue('error', 'invalid_number', `${path} must be a finite number.`));
    return null;
  }
  if (value < min || value > max) {
    issues.push(
      issue(
        'error',
        'number_out_of_range',
        `${path} must be between ${min} and ${max}, received ${value}.`,
      ),
    );
    return null;
  }
  return value;
}

function readInteger(
  value: unknown,
  path: string,
  min: number,
  max: number,
  issues: ParcelIssue[],
): number | null {
  const number = readNumber(value, path, min, max, issues);
  if (number === null) {
    return null;
  }
  if (!Number.isInteger(number)) {
    issues.push(issue('error', 'invalid_integer', `${path} must be an integer.`));
    return null;
  }
  return number;
}

function readBoolean(
  value: unknown,
  path: string,
  issues: ParcelIssue[],
): boolean | null {
  if (typeof value !== 'boolean') {
    issues.push(issue('error', 'invalid_boolean', `${path} must be a boolean.`));
    return null;
  }
  return value;
}

function isNodeKind(value: string): value is ParcelNodeKind {
  return (PARCEL_NODE_KINDS as readonly string[]).includes(value);
}

function isNodeSize(value: string): value is ParcelNodeSize {
  return (['small', 'medium', 'large'] as readonly string[]).includes(value);
}

function isOperation(value: string): value is ParcelOperation {
  return (PARCEL_OPERATIONS as readonly string[]).includes(value);
}

function isStoreKind(value: ParcelNodeKind): boolean {
  return (PARCEL_STORE_KINDS as readonly string[]).includes(value);
}

function parseConfig(
  raw: unknown,
  kind: ParcelNodeKind,
  path: string,
  issues: ParcelIssue[],
): ParcelNodeConfig | null {
  if (!isPlainObject(raw)) {
    issues.push(issue('error', 'invalid_config', `${path} must be an object.`));
    return null;
  }
  checkKeys(raw, CONFIG_KEYS_BY_KIND[kind], path, issues);
  const spec = PARCEL_CATALOG.nodes[kind];
  const config: Record<string, unknown> = { ...spec.defaults };

  if (raw.size !== undefined) {
    if (typeof raw.size !== 'string' || !isNodeSize(raw.size)) {
      issues.push(
        issue('error', 'invalid_config_value', `${path}.size must be small, medium or large.`),
      );
    } else if (!spec.allowedSizes.includes(raw.size)) {
      issues.push(
        issue(
          'error',
          'unsupported_size',
          `${path}.size "${raw.size}" is not available for ${kind}.`,
        ),
      );
    } else {
      config.size = raw.size;
    }
  }

  if (spec.storage) {
    if (raw.storageTb !== undefined) {
      const storage = readNumber(
        raw.storageTb,
        `${path}.storageTb`,
        1,
        MAX_STORAGE_TB,
        issues,
      );
      if (storage !== null) {
        config.storageTb = storage;
      }
    }
    if (raw.retentionYears !== undefined) {
      const retention = readInteger(
        raw.retentionYears,
        `${path}.retentionYears`,
        1,
        5,
        issues,
      );
      if (retention !== null) {
        config.retentionYears = retention;
      }
    }
    if (raw.partition !== undefined) {
      if (raw.partition !== 'none' && raw.partition !== 'month') {
        issues.push(
          issue(
            'error',
            'invalid_config_value',
            `${path}.partition must be "none" or "month".`,
          ),
        );
      } else {
        config.partition = raw.partition;
      }
    }
    if (raw.compression !== undefined) {
      if (raw.compression !== 'none' && raw.compression !== 'lz4' && raw.compression !== 'zstd') {
        issues.push(
          issue(
            'error',
            'invalid_config_value',
            `${path}.compression must be "none", "lz4" or "zstd".`,
          ),
        );
      } else {
        config.compression = raw.compression;
      }
    }
  }

  if (kind === 'sql' && raw.index !== undefined) {
    if (raw.index !== 'none' && raw.index !== 'parcel' && raw.index !== 'parcel-warehouse') {
      issues.push(
        issue(
          'error',
          'invalid_config_value',
          `${path}.index must be "none", "parcel" or "parcel-warehouse".`,
        ),
      );
    } else {
      config.index = raw.index;
    }
  }

  if ((kind === 'sql' || kind === 'kv') && raw.latestStatus !== undefined) {
    const latest = readBoolean(raw.latestStatus, `${path}.latestStatus`, issues);
    if (latest !== null) {
      config.latestStatus = latest;
    }
  }

  if ((kind === 'sql' || kind === 'kv' || kind === 'columnar') && raw.rollups !== undefined) {
    const rollups = readBoolean(raw.rollups, `${path}.rollups`, issues);
    if (rollups !== null) {
      config.rollups = rollups;
    }
  }

  if (kind === 'columnar') {
    if (raw.batchIntervalMs !== undefined) {
      const batch = readInteger(
        raw.batchIntervalMs,
        `${path}.batchIntervalMs`,
        0,
        5_000,
        issues,
      );
      if (batch !== null) {
        config.batchIntervalMs = batch;
      }
    }
    if (raw.columnProjection !== undefined) {
      const projection = readBoolean(
        raw.columnProjection,
        `${path}.columnProjection`,
        issues,
      );
      if (projection !== null) {
        config.columnProjection = projection;
      }
    }
  }

  return config as unknown as ParcelNodeConfig;
}

function parseNode(raw: unknown, index: number, issues: ParcelIssue[]): ParcelNode | null {
  const path = `nodes[${index}]`;
  if (!isPlainObject(raw)) {
    issues.push(issue('error', 'invalid_node', `${path} must be an object.`));
    return null;
  }
  checkKeys(raw, NODE_KEYS, path, issues);

  const id = readId(raw.id, `${path}.id`, issues);
  const kindText =
    typeof raw.kind === 'string'
      ? raw.kind
      : (issues.push(issue('error', 'invalid_node_kind', `${path}.kind is required.`)),
        null);
  if (kindText !== null && !isNodeKind(kindText)) {
    issues.push(
      issue(
        'error',
        'unknown_node_kind',
        `${path}.kind "${kindText}" is not a known node kind (client, app, sql, kv, columnar).`,
      ),
    );
    return null;
  }
  if (id === null || kindText === null || !isNodeKind(kindText)) {
    return null;
  }

  const label = readString(
    raw.label,
    `${path}.label`,
    issues,
    PARCEL_CATALOG.nodes[kindText].label,
  );
  if (label === null) {
    return null;
  }
  if (label.length > 80) {
    issues.push(issue('error', 'label_too_long', `${path}.label must be at most 80 characters.`));
    return null;
  }

  let position: ParcelPosition = { x: 0, y: 0 };
  if (raw.position !== undefined) {
    if (!isPlainObject(raw.position)) {
      issues.push(issue('error', 'invalid_position', `${path}.position must be an object.`));
      return null;
    }
    checkKeys(raw.position, POSITION_KEYS, `${path}.position`, issues);
    const x = readNumber(raw.position.x, `${path}.position.x`, -10_000, 10_000, issues);
    const y = readNumber(raw.position.y, `${path}.position.y`, -10_000, 10_000, issues);
    if (x === null || y === null) {
      return null;
    }
    position = { x, y };
  }

  const config = parseConfig(raw.config, kindText, `${path}.config`, issues);
  if (config === null) {
    return null;
  }

  return { id, kind: kindText, label, position, config };
}

function parseEdge(raw: unknown, index: number, issues: ParcelIssue[]): ParcelEdge | null {
  const path = `edges[${index}]`;
  if (!isPlainObject(raw)) {
    issues.push(issue('error', 'invalid_edge', `${path} must be an object.`));
    return null;
  }
  checkKeys(raw, EDGE_KEYS, path, issues);
  const id = readId(raw.id, `${path}.id`, issues);
  const source = readId(raw.source, `${path}.source`, issues);
  const target = readId(raw.target, `${path}.target`, issues);
  const operationText =
    typeof raw.operation === 'string'
      ? raw.operation
      : (issues.push(issue('error', 'invalid_operation', `${path}.operation is required.`)),
        null);
  if (operationText !== null && !isOperation(operationText)) {
    issues.push(
      issue(
        'error',
        'unknown_operation',
        `${path}.operation "${operationText}" is not a known operation.`,
      ),
    );
    return null;
  }
  if (id === null || source === null || target === null || operationText === null) {
    return null;
  }
  if (!isOperation(operationText)) {
    return null;
  }
  return { id, source, target, operation: operationText };
}

/**
 * Strictly parse an imported document. Shape problems are returned as
 * `ok: false`; semantic problems (routes, cycles, capabilities) are reported by
 * `validateParcelGraph`.
 */
export function parseParcelGraph(input: unknown): ParcelParseResult {
  const issues: ParcelIssue[] = [];
  if (!isPlainObject(input)) {
    issues.push(
      issue('error', 'invalid_document', 'The graph document must be a JSON object.'),
    );
    return { ok: false, graph: null, issues };
  }
  checkKeys(input, GRAPH_KEYS, 'graph', issues);

  if (input.schemaVersion !== undefined && input.schemaVersion !== PARCEL_SCHEMA_VERSION) {
    issues.push(
      issue(
        'error',
        'unsupported_schema_version',
        `schemaVersion must be ${PARCEL_SCHEMA_VERSION}.`,
      ),
    );
  }
  if (input.levelId !== undefined && input.levelId !== PARCEL_LEVEL_ID) {
    issues.push(
      issue(
        'error',
        'level_override_rejected',
        `levelId must be "${PARCEL_LEVEL_ID}". Imported graphs cannot select or override a level.`,
      ),
    );
  }
  let name: string | undefined;
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.length > 80) {
      issues.push(
        issue('error', 'invalid_name', 'name must be a string of at most 80 characters.'),
      );
    } else {
      name = input.name;
    }
  }

  if (!Array.isArray(input.nodes)) {
    issues.push(issue('error', 'invalid_nodes', 'nodes must be an array.'));
  }
  if (!Array.isArray(input.edges)) {
    issues.push(issue('error', 'invalid_edges', 'edges must be an array.'));
  }
  if (issues.some((item) => item.severity === 'error')) {
    return { ok: false, graph: null, issues };
  }

  const nodesRaw = input.nodes as unknown[];
  const edgesRaw = input.edges as unknown[];
  if (nodesRaw.length > MAX_NODES) {
    issues.push(issue('error', 'too_many_nodes', `At most ${MAX_NODES} nodes are allowed.`));
  }
  if (edgesRaw.length > MAX_EDGES) {
    issues.push(issue('error', 'too_many_edges', `At most ${MAX_EDGES} edges are allowed.`));
  }

  const nodes: ParcelNode[] = [];
  const nodeIds = new Set<string>();
  nodesRaw.forEach((raw, index) => {
    const node = parseNode(raw, index, issues);
    if (node === null) {
      return;
    }
    if (nodeIds.has(node.id)) {
      issues.push(
        issue('error', 'duplicate_node_id', `Duplicate node id "${node.id}".`, {
          nodeId: node.id,
        }),
      );
      return;
    }
    nodeIds.add(node.id);
    nodes.push(node);
  });

  const edges: ParcelEdge[] = [];
  const edgeIds = new Set<string>();
  edgesRaw.forEach((raw, index) => {
    const edge = parseEdge(raw, index, issues);
    if (edge === null) {
      return;
    }
    if (edgeIds.has(edge.id)) {
      issues.push(
        issue('error', 'duplicate_edge_id', `Duplicate edge id "${edge.id}".`, {
          edgeId: edge.id,
        }),
      );
      return;
    }
    edgeIds.add(edge.id);
    edges.push(edge);
  });

  if (issues.some((item) => item.severity === 'error')) {
    return { ok: false, graph: null, issues };
  }

  const graph: ParcelGraph = {
    schemaVersion: PARCEL_SCHEMA_VERSION,
    levelId: PARCEL_LEVEL_ID,
    ...(name === undefined ? {} : { name }),
    nodes,
    edges,
  };
  return { ok: true, graph, issues };
}

function outEdges(graph: ParcelGraph, nodeId: string): ParcelEdge[] {
  return graph.edges.filter((edge) => edge.source === nodeId);
}

function inEdges(graph: ParcelGraph, nodeId: string): ParcelEdge[] {
  return graph.edges.filter((edge) => edge.target === nodeId);
}

function findCycles(graph: ParcelGraph): string[][] {
  const bySource = new Map<string, ParcelEdge[]>();
  for (const edge of graph.edges) {
    const list = bySource.get(edge.source) ?? [];
    list.push(edge);
    bySource.set(edge.source, list);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (nodeId: string): void => {
    state.set(nodeId, 1);
    stack.push(nodeId);
    for (const edge of bySource.get(nodeId) ?? []) {
      const next = state.get(edge.target) ?? 0;
      if (next === 1) {
        const start = stack.indexOf(edge.target);
        cycles.push([...stack.slice(start), edge.target]);
      } else if (next === 0) {
        visit(edge.target);
      }
    }
    stack.pop();
    state.set(nodeId, 2);
  };
  for (const node of graph.nodes) {
    if ((state.get(node.id) ?? 0) === 0) {
      visit(node.id);
    }
  }
  return cycles;
}

/**
 * Semantic validation. Errors block a run; warnings remain editable.
 * `mode: 'edit'` keeps the same errors so the UI can explain them before Run.
 */
export function validateParcelGraph(
  graph: ParcelGraph,
  options: ParcelValidationOptions = {},
): ParcelIssue[] {
  const issues: ParcelIssue[] = [];
  const mode = options.mode ?? 'edit';
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const clients = graph.nodes.filter((node) => node.kind === 'client');
  const apps = graph.nodes.filter((node) => node.kind === 'app');

  if (clients.length !== 1) {
    issues.push(
      issue('error', 'client_count', 'Exactly one client node is required.', {
        nodeId: clients[0]?.id,
      }),
    );
  }
  if (apps.length !== 1) {
    issues.push(
      issue('error', 'app_count', 'Exactly one application node is required.', {
        nodeId: apps[0]?.id,
      }),
    );
  }
  const app = apps[0];
  const client = clients[0];

  for (const edge of graph.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) {
      issues.push(
        issue(
          'error',
          'edge_endpoint_missing',
          `Edge "${edge.id}" references a missing node.`,
          { edgeId: edge.id },
        ),
      );
      continue;
    }
    if (edge.source === edge.target) {
      issues.push(
        issue('error', 'self_loop', `Edge "${edge.id}" connects a node to itself.`, {
          edgeId: edge.id,
        }),
      );
    }
    if (edge.operation === 'traffic') {
      if (source.kind !== 'client' || target.kind !== 'app') {
        issues.push(
          issue(
            'error',
            'traffic_route',
            'Traffic edges must go from the client to the application.',
            { edgeId: edge.id },
          ),
        );
      }
    } else if (edge.operation === 'replicate') {
      if (!isStoreKind(source.kind) || !isStoreKind(target.kind)) {
        issues.push(
          issue(
            'error',
            'replication_route',
            'Replication edges must go from a store to another store.',
            { edgeId: edge.id },
          ),
        );
      }
    } else {
      if (!app || edge.source !== app.id) {
        issues.push(
          issue(
            'error',
            'business_route_source',
            `${edge.operation} routes must start at the application node.`,
            { edgeId: edge.id },
          ),
        );
      }
      if (!isStoreKind(target.kind)) {
        issues.push(
          issue(
            'error',
            'business_route_target',
            `${edge.operation} routes must end at a store (SQL, KV or columnar).`,
            { edgeId: edge.id },
          ),
        );
      }
    }
  }

  if (client) {
    const clientOut = outEdges(graph, client.id);
    const traffic = clientOut.filter((edge) => edge.operation === 'traffic');
    if (traffic.length !== 1) {
      issues.push(
        issue(
          'error',
          'traffic_route_count',
          'The client must have exactly one traffic route to the application.',
          { nodeId: client.id },
        ),
      );
    }
    if (clientOut.some((edge) => edge.operation !== 'traffic')) {
      issues.push(
        issue(
          'error',
          'client_route',
          'The client may only send traffic to the application.',
          { nodeId: client.id },
        ),
      );
    }
    if (inEdges(graph, client.id).length > 0) {
      issues.push(
        issue('error', 'client_input', 'The client cannot have incoming routes.', {
          nodeId: client.id,
        }),
      );
    }
  }

  const routes = new Map<ParcelBusinessOperation, ParcelEdge[]>();
  for (const operation of PARCEL_BUSINESS_OPERATIONS) {
    routes.set(operation, []);
  }
  if (app) {
    for (const edge of outEdges(graph, app.id)) {
      if (edge.operation === 'traffic' || edge.operation === 'replicate') {
        issues.push(
          issue(
            'error',
            'app_invalid_route',
            `The application cannot emit ${edge.operation} edges.`,
            { edgeId: edge.id },
          ),
        );
        continue;
      }
      const list = routes.get(edge.operation as ParcelBusinessOperation);
      list?.push(edge);
    }
  }
  for (const operation of PARCEL_BUSINESS_OPERATIONS) {
    const list = routes.get(operation) ?? [];
    if (list.length !== 1) {
      issues.push(
        issue(
          'error',
          'missing_route',
          `The application needs exactly one ${operation} route, found ${list.length}.`,
          { nodeId: app?.id, edgeId: list[0]?.id },
        ),
      );
    }
  }

  const ingest = routes.get('ingest')?.[0];
  const primary = ingest ? byId.get(ingest.target) : undefined;
  if (ingest && primary && primary.kind !== 'sql' && primary.kind !== 'kv') {
    issues.push(
      issue(
        'error',
        'ingest_primary_kind',
        'Ingest must acknowledge a durable SQL or KV primary.',
        { edgeId: ingest.id, nodeId: primary.id },
      ),
    );
  }

  const replicas = new Map<string, ParcelEdge>();
  for (const edge of graph.edges) {
    if (edge.operation !== 'replicate') {
      continue;
    }
    if (!primary || edge.source !== primary.id) {
      issues.push(
        issue(
          'error',
          'replication_source',
          'Asynchronous replication must start at the ingest primary.',
          { edgeId: edge.id, nodeId: edge.source },
        ),
      );
    }
    if (replicas.has(edge.target)) {
      issues.push(
        issue(
          'error',
          'replication_duplicate_target',
          'Each replica may have only one replication input.',
          { edgeId: edge.id, nodeId: edge.target },
        ),
      );
    }
    if (primary && edge.target === primary.id) {
      issues.push(
        issue(
          'error',
          'replication_self',
          'The ingest primary cannot replicate to itself.',
          { edgeId: edge.id, nodeId: edge.target },
        ),
      );
    }
    replicas.set(edge.target, edge);
  }

  for (const cycle of findCycles(graph)) {
    issues.push(
      issue(
        'error',
        'graph_cycle',
        `Route cycle detected: ${cycle.join(' -> ')}.`,
        { nodeId: cycle[0] },
      ),
    );
  }

  const retentionWarnings = new Set<string>();
  for (const operation of ['status', 'history', 'report'] as const) {
    const route = routes.get(operation)?.[0];
    if (!route) {
      continue;
    }
    const target = byId.get(route.target);
    if (!target || !isStoreKind(target.kind)) {
      continue;
    }
    const fedDirectly = primary?.id === target.id;
    const replicated = replicas.get(target.id);
    if (!fedDirectly && !replicated) {
      issues.push(
        issue(
          'error',
          'read_target_unfed',
          `The ${operation} route reads from "${target.id}", but that store is not fed by ingest or replication.`,
          { edgeId: route.id, nodeId: target.id },
        ),
      );
    }
    if (operation === 'status' && target.kind === 'columnar') {
      issues.push(
        issue(
          'error',
          'status_target_kind',
          'Status lookups must use a SQL or KV store; a columnar projection cannot serve per-parcel latest status.',
          { edgeId: route.id, nodeId: target.id },
        ),
      );
    }
    if (operation === 'history' && target.kind === 'columnar') {
      issues.push(
        issue(
          'warning',
          'history_columnar_scan',
          'A columnar projection has no parcel key access path; history reads will scan the retained dataset and may miss the deadline.',
          { edgeId: route.id, nodeId: target.id },
        ),
      );
    }
    if (operation === 'history' && target.kind === 'sql' && target.config.index === 'none') {
      issues.push(
        issue(
          'warning',
          'history_index_missing',
          'SQL history without a parcel index scans the retained event dataset.',
          { edgeId: route.id, nodeId: target.id },
        ),
      );
    }
    if (operation === 'history' && target.kind === 'kv') {
      // KV history is explicit parcel-bucket access; no extra config needed.
    }
    if (operation === 'report' && target.kind === 'kv' && target.config.rollups !== true) {
      issues.push(
        issue(
          'warning',
          'report_kv_rollups_missing',
          'KV reports without rollups cannot aggregate by warehouse cheaply.',
          { edgeId: route.id, nodeId: target.id },
        ),
      );
    }
    if (
      operation === 'report' &&
      target.kind === 'sql' &&
      target.config.rollups !== true &&
      target.config.index !== 'parcel-warehouse'
    ) {
      issues.push(
        issue(
          'warning',
          'report_index_missing',
          'SQL reports need rollups or a parcel-warehouse index; otherwise they scan the five-year dataset.',
          { edgeId: route.id, nodeId: target.id },
        ),
      );
    }
    if (operation === 'history' && (target.config.retentionYears ?? 1) < 5) {
      retentionWarnings.add(target.id);
    }
  }

  if (primary && (primary.config.retentionYears ?? 1) < 5) {
    retentionWarnings.add(primary.id);
  }
  for (const nodeId of retentionWarnings) {
    const node = byId.get(nodeId);
    if (!node) {
      continue;
    }
    const retention = node.config.retentionYears ?? 1;
    issues.push(
      issue(
        'warning',
        'retention_below_required',
        `"${node.id}" retains ${retention} year(s); the year-5 primary/history role requires 5 years of raw history.`,
        { nodeId: node.id },
      ),
    );
  }

  const used = new Set<string>();
  for (const edge of graph.edges) {
    used.add(edge.source);
    used.add(edge.target);
  }
  for (const node of graph.nodes) {
    if (!used.has(node.id)) {
      issues.push(
        issue(
          'warning',
          'unused_node',
          `"${node.label}" is not connected to any route but still costs money.`,
          { nodeId: node.id },
        ),
      );
    }
  }

  if (mode === 'run' && issues.some((item) => item.severity === 'error')) {
    return issues;
  }
  return issues;
}

/** Defaults for a fresh node, cloned so callers can edit freely. */
export function createParcelNode(
  kind: ParcelNodeKind,
  id: string,
  position: ParcelPosition = { x: 0, y: 0 },
): ParcelNode {
  const spec = PARCEL_CATALOG.nodes[kind];
  return {
    id,
    kind,
    label: spec.label,
    position: { ...position },
    config: { ...spec.defaults },
  };
}

/**
 * Stock starter: structurally valid, deliberately poor strategy. It has no
 * index, no latest-status maintenance, one year of retention and only 1 TB.
 * It is not auto-solved and is intended to be replaced by the player.
 */
export function createParcelGraph(): ParcelGraph {
  const client = createParcelNode('client', 'client-1', { x: 0, y: 160 });
  const app = createParcelNode('app', 'app-1', { x: 420, y: 160 });
  const store = createParcelNode('sql', 'sql-1', { x: 920, y: 160 });
  const edges: ParcelEdge[] = [
    { id: 'edge-traffic', source: client.id, target: app.id, operation: 'traffic' },
    { id: 'edge-ingest', source: app.id, target: store.id, operation: 'ingest' },
    { id: 'edge-status', source: app.id, target: store.id, operation: 'status' },
    { id: 'edge-history', source: app.id, target: store.id, operation: 'history' },
    { id: 'edge-report', source: app.id, target: store.id, operation: 'report' },
  ];
  return {
    schemaVersion: PARCEL_SCHEMA_VERSION,
    levelId: PARCEL_LEVEL_ID,
    name: 'Starter',
    nodes: [client, app, store],
    edges,
  };
}

export function cloneParcelGraph(graph: ParcelGraph): ParcelGraph {
  return JSON.parse(JSON.stringify(graph)) as ParcelGraph;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) {
        result[key] = stableValue(entry);
      }
    }
    return result;
  }
  return value;
}

function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Semantic digest. Positions and labels are visual only and are ignored, so
 * moving a node never invalidates a result. Seed is deliberately excluded.
 */
export function parcelGraphDigest(graph: ParcelGraph): string {
  const semantic = {
    schemaVersion: graph.schemaVersion,
    levelId: graph.levelId,
    nodes: [...graph.nodes]
      .map((node) => ({
        id: node.id,
        kind: node.kind,
        config: stableValue(node.config),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges]
      .map((edge) => ({
        source: edge.source,
        target: edge.target,
        operation: edge.operation,
      }))
      .sort((a, b) =>
        `${a.source}|${a.target}|${a.operation}`.localeCompare(
          `${b.source}|${b.target}|${b.operation}`,
        ),
      ),
  };
  const text = JSON.stringify(semantic);
  const first = fnv1a32(text).toString(16).padStart(8, '0');
  const second = fnv1a32(`parcel:${text}`).toString(16).padStart(8, '0');
  return `${first}${second}`;
}

/**
 * UI-facing alias for stale-result detection. Changing positions, labels,
 * seed or result formatting never changes this digest.
 */
export const parcelSemanticDigest = parcelGraphDigest;

/** Convenience for callers that need both parse and semantic validation. */
export function parseAndValidateParcelGraph(
  input: unknown,
  options: ParcelValidationOptions = {},
): { graph: ParcelGraph | null; issues: ParcelIssue[] } {
  const parsed = parseParcelGraph(input);
  if (!parsed.ok) {
    return { graph: null, issues: [...parsed.issues] };
  }
  return {
    graph: parsed.graph,
    issues: [...parsed.issues, ...validateParcelGraph(parsed.graph, options)],
  };
}
