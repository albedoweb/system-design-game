/**
 * Cold Cache compatibility schema and metadata.
 *
 * The frozen Cold Cache domain keeps its own graph parser and runtime result
 * shape. This module only adds a JSON Schema for the graph, a semantic digest
 * that ignores visual fields, and an explicit adapter envelope for metadata.
 * The envelope's `result` field is the untouched `RunResult` produced by the
 * original engine, so existing result bodies do not change.
 */

import { z } from 'zod';

import {
  CATALOG,
  NODE_KINDS,
  NODE_SIZES,
} from '../domain/catalog';
import {
  graphDocumentSchema,
  type GraphDocument,
} from '../domain/graph';
import {
  DEFAULT_LEVEL,
  MAX_SEED,
  SUPPORTED_MODEL_VERSION,
  type LevelDefinition,
} from '../domain/level';
import {
  ID_PATTERN,
  MAX_COORDINATE,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_NODES,
  MAX_ID_LENGTH,
  MAX_INPUT_BYTES,
  MAX_LABEL_LENGTH,
  MAX_POOL_SIZE,
  MAX_QUEUE_LIMIT,
  MAX_TTL_SECONDS,
  MIN_POOL_SIZE,
  MIN_QUEUE_LIMIT,
  MIN_TTL_SECONDS,
} from '../domain/limits';
import type { RunResult } from '../domain/simulation';

export const COLD_CACHE_LEVEL_ID = 'cold-cache' as const;
export const COLD_CACHE_SCHEMA_VERSION = 1 as const;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
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
 * Semantic digest of a Cold Cache graph. Positions and labels are visual only
 * and are ignored, so moving a node never invalidates a saved result. The seed
 * is deliberately excluded because it belongs to the save envelope.
 */
export function coldCacheGraphDigest(graph: GraphDocument): string {
  const semantic = {
    schemaVersion: graph.schemaVersion,
    levelId: graph.levelId,
    nodes: [...graph.nodes]
      .map((node) => ({
        id: node.id,
        kind: node.kind,
        config: stableValue(node.config),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...graph.edges]
      .map((edge) => ({
        source: edge.source,
        target: edge.target,
        sourcePort: edge.sourcePort,
      }))
      .sort((left, right) =>
        `${left.source}|${left.target}|${left.sourcePort}`.localeCompare(
          `${right.source}|${right.target}|${right.sourcePort}`,
        ),
      ),
  };
  const text = JSON.stringify(semantic);
  const first = fnv1a32(text).toString(16).padStart(8, '0');
  const second = fnv1a32(`cold:${text}`).toString(16).padStart(8, '0');
  return `${first}${second}`;
}

const coldGraphJsonSchemaId =
  'https://system-design-game.local/schemas/cold-cache-graph.json';

/** JSON Schema generated from the same Zod object used by `parseGraph`. */
export function coldCacheGraphJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(graphDocumentSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: coldGraphJsonSchemaId,
    title: 'Cold Cache graph',
    'x-semantic-rules': [
      'Exactly one client and one database are required in run mode.',
      'Every client path must reach an app server and a database.',
      'Cache and load-balancer routes must be explicit.',
      'Unused nodes are allowed and still charged.',
    ],
  };
}

const coldIssueSchema = z.strictObject({
  code: z.string().min(1).max(96),
  message: z.string().min(1).max(2_000),
  severity: z.enum(['error', 'warning', 'info']),
  nodeId: z.string().min(1).max(64).optional(),
  edgeId: z.string().min(1).max(64).optional(),
});

export type ColdCacheIssue = z.infer<typeof coldIssueSchema>;

/**
 * The nine gates emitted by the frozen `buildChecks` for `DEFAULT_LEVEL`.
 * Kept here so the published result schema rejects unknown IDs as well; a test
 * verifies parity with `buildChecks`.
 */
export const COLD_CACHE_CHECK_IDS = [
  'read-availability',
  'write-availability',
  'read-p95',
  'write-p95',
  'critical-read-availability',
  'critical-write-availability',
  'critical-read-p95',
  'critical-write-p95',
  'cost',
] as const;

export type ColdCacheCheckId = (typeof COLD_CACHE_CHECK_IDS)[number];

const coldCheckSchema = z.strictObject({
  id: z.enum(COLD_CACHE_CHECK_IDS),
  label: z.string().min(1).max(200),
  actual: z.number().finite().nullable(),
  target: z.number().finite(),
  unit: z.enum(['%', 'ms', '$/h']),
  passed: z.boolean(),
});

const coldDiagnosticSchema = z.strictObject({
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().min(1).max(2_000),
  nodeId: z.string().min(1).max(64).optional(),
});

const coldSnapshotSchema = z.strictObject({
  timeMs: z.number().finite(),
  phase: z.enum(['warmup', 'running', 'draining', 'completed']),
  // The frozen snapshot types are plain JSON data. The adapter envelope does
  // not re-implement their full schema; the original engine remains the only
  // producer and the worker guard checks the outer shape.
  reads: z.any(),
  writes: z.any(),
  nodes: z.any(),
  series: z.any(),
  events: z.any(),
});

const coldRunResultSchema = z.strictObject({
  seed: z.number().int().min(0).max(MAX_SEED),
  passed: z.boolean(),
  costMicroUsdPerHour: z.number().finite().min(0),
  checks: z.array(coldCheckSchema).min(1),
  snapshot: coldSnapshotSchema,
  diagnostics: z.array(coldDiagnosticSchema),
});

const coldMetaSchema = z.strictObject({
  schemaVersion: z.literal(COLD_CACHE_SCHEMA_VERSION),
  levelId: z.literal(COLD_CACHE_LEVEL_ID),
  modelVersion: z.literal(SUPPORTED_MODEL_VERSION),
  contentVersion: z.literal(DEFAULT_LEVEL.contentVersion),
  pricingVersion: z.literal(DEFAULT_LEVEL.pricingVersion),
  seed: z.number().int().min(0).max(MAX_SEED),
  graphDigest: z.string().min(1).max(128).nullable(),
});

export type ColdCacheMeta = z.infer<typeof coldMetaSchema>;

const coldErrorSchema = z.strictObject({
  code: z
    .string()
    .min(1)
    .max(96)
    .regex(/^[a-z][a-z0-9_]{0,63}$/),
  message: z.string().min(1).max(500),
});

export type ColdCacheError = z.infer<typeof coldErrorSchema>;

/**
 * Explicit Cold Cache adapter envelope. `result` is the original engine
 * `RunResult`; `meta` binds the model/version/seed/digest for stale-result
 * detection. `invalid` means parsing or semantic validation blocked the run;
 * `incomplete` is a bounded runtime limit and can never claim a pass.
 */
export const coldCacheEvaluationSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    passed: z.boolean(),
    meta: coldMetaSchema,
    issues: z.array(coldIssueSchema),
    result: coldRunResultSchema,
  }),
  z.strictObject({
    status: z.literal('invalid'),
    passed: z.literal(false),
    meta: coldMetaSchema,
    issues: z.array(coldIssueSchema).min(1),
    result: z.null(),
  }),
  z.strictObject({
    status: z.literal('incomplete'),
    passed: z.literal(false),
    meta: coldMetaSchema,
    issues: z.array(coldIssueSchema),
    result: z.null(),
    error: coldErrorSchema,
  }),
]);

/**
 * Public envelope type. The `result` field deliberately keeps the frozen
 * `RunResult` type (not the Zod-narrowed check-id union), so the adapter returns
 * the untouched engine body while the schema still validates its shape.
 */
export type ColdCacheEvaluation =
  | {
      readonly status: 'ok';
      readonly passed: boolean;
      readonly meta: ColdCacheMeta;
      readonly issues: readonly ColdCacheIssue[];
      readonly result: RunResult;
    }
  | {
      readonly status: 'invalid';
      readonly passed: false;
      readonly meta: ColdCacheMeta;
      readonly issues: readonly ColdCacheIssue[];
      readonly result: null;
    }
  | {
      readonly status: 'incomplete';
      readonly passed: false;
      readonly meta: ColdCacheMeta;
      readonly issues: readonly ColdCacheIssue[];
      readonly result: null;
      readonly error: ColdCacheError;
    };

/** JSON Schema for the Cold Cache adapter envelope. */
export function coldCacheResultJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(coldCacheEvaluationSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://system-design-game.local/schemas/cold-cache-result.json',
    title: 'Cold Cache evaluation envelope',
  };
}

/** Deep, JSON-safe copy of the frozen level definition. */
export function coldCacheLevelPayload(): LevelDefinition {
  return JSON.parse(JSON.stringify(DEFAULT_LEVEL)) as LevelDefinition;
}

/** Catalog plus machine-readable constraints for adapters and UIs. */
export function coldCacheCatalogPayload(): {
  catalog: typeof CATALOG;
  componentLimits: ReturnType<typeof coldCacheComponentLimits>;
  nodeKinds: readonly string[];
  nodeSizes: readonly string[];
} {
  return {
    catalog: JSON.parse(JSON.stringify(CATALOG)) as typeof CATALOG,
    componentLimits: coldCacheComponentLimits(),
    nodeKinds: [...NODE_KINDS],
    nodeSizes: [...NODE_SIZES],
  };
}

export function coldCacheComponentLimits(): {
  maxNodes: number;
  maxEdges: number;
  maxDocumentBytes: number;
  idPattern: string;
  idMaxLength: number;
  labelMaxLength: number;
  coordinate: { min: number; max: number };
  queueLimit: { min: number; max: number };
  poolSize: { min: number; max: number };
  ttlSeconds: { min: number; max: number };
  seed: { min: number; max: number };
} {
  return {
    maxNodes: MAX_GRAPH_NODES,
    maxEdges: MAX_GRAPH_EDGES,
    maxDocumentBytes: MAX_INPUT_BYTES,
    idPattern: ID_PATTERN.source,
    idMaxLength: MAX_ID_LENGTH,
    labelMaxLength: MAX_LABEL_LENGTH,
    coordinate: { min: -MAX_COORDINATE, max: MAX_COORDINATE },
    queueLimit: { min: MIN_QUEUE_LIMIT, max: MAX_QUEUE_LIMIT },
    poolSize: { min: MIN_POOL_SIZE, max: MAX_POOL_SIZE },
    ttlSeconds: { min: MIN_TTL_SECONDS, max: MAX_TTL_SECONDS },
    seed: { min: 0, max: MAX_SEED },
  };
}

/** One authoritative payload for CLI/API discovery and public help. */
export function describeColdCacheLevel(): {
  level: LevelDefinition;
  catalog: typeof CATALOG;
  graphSchema: Record<string, unknown>;
  resultSchema: Record<string, unknown>;
  componentLimits: ReturnType<typeof coldCacheComponentLimits>;
  rules: readonly string[];
} {
  return {
    level: coldCacheLevelPayload(),
    catalog: JSON.parse(JSON.stringify(CATALOG)) as typeof CATALOG,
    graphSchema: coldCacheGraphJsonSchema(),
    resultSchema: coldCacheResultJsonSchema(),
    componentLimits: coldCacheComponentLimits(),
    rules: [
      'One client, one database and at least one app server are required in run mode.',
      'Every client request path must be wired to a database; caches miss to a database.',
      'Node size, queue limit, pool size, TTL and coalescing are charged from the visible catalog.',
      'The run advances the real frozen engine to duration + drain; the adapter never fabricates a result.',
      'A bounded runtime limit is reported as an incomplete envelope and can never pass.',
    ],
  };
}

/** Convenience for callers that need the untouched run body type. */
export type ColdCacheRunResult = RunResult;
