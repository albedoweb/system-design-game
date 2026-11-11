import { z } from 'zod';

/**
 * Global Cart public contracts (cart-protocol-v1, B1).
 *
 * This module is the sole schema owner for the `global-cart` level. It holds
 * the versioned identities, the strict untrusted-import schemas, the shared
 * issue/diagnostic vocabulary, canonical JSON plus a deterministic SHA-256
 * digest, and the evaluation/session types that GC-011 implements.
 *
 * Rules that must not drift:
 * - An import is parsed completely or rejected; no partial graph escapes.
 * - Unknown fields, unsupported versions, non-finite numbers and out-of-range
 *   capacities are hard parse failures.
 * - Layout (positions), display labels, node enumeration, object key order and
 *   the evaluation seed are never semantic. The semantic graph digest covers
 *   only meaning-bearing topology.
 */

// ---------------------------------------------------------------------------
// Versioned identities and level constants (frozen by cart-protocol-v1)
// ---------------------------------------------------------------------------

export const CART_LEVEL_ID = 'global-cart' as const;

/**
 * Versioned workload profile identifiers. `original` is the frozen
 * 5 ms / 90 s profile; `desync100` is the adopted default (100 ms session
 * offset, 101 s measured window). Selecting a profile never changes offered
 * counts, identities, operation order, dependencies, faults, prices or SLOs.
 */
export const CART_WORKLOAD_PROFILE_IDS = {
  original: 'global-cart-v1-candidate',
  desync100: 'global-cart-v1-desync100',
  /** Cart Foundations (D002): fault-free Normal + Rush on the desync100 timing. */
  basic: 'global-cart-v1-basic-desync100',
} as const;

/**
 * Content identities. The Cart Foundations basic level (D002) carries its own
 * content version; `cart-content-v1` is the historical / advanced six-case
 * benchmark identity (explicit profiles only). Both share one graph shape, so a
 * historical v1 design can be imported through an explicit atomic restamp
 * (see parseCartGraph's target content), never silently reinterpreted.
 */
export const CART_CONTENT_VERSIONS = {
  basic: 'cart-content-v2-basic',
  advanced: 'cart-content-v1',
} as const;
export type CartContentVersion = (typeof CART_CONTENT_VERSIONS)[keyof typeof CART_CONTENT_VERSIONS];

/** Content identity a workload profile runs under. */
export function cartContentVersionForProfile(profileId: string): CartContentVersion {
  return profileId === CART_WORKLOAD_PROFILE_IDS.basic
    ? CART_CONTENT_VERSIONS.basic
    : CART_CONTENT_VERSIONS.advanced;
}

/** Canonical profile bound into a design's semantic digest for a content version. */
export function cartCanonicalProfileForContent(content: CartContentVersion): string {
  return content === CART_CONTENT_VERSIONS.basic
    ? CART_WORKLOAD_PROFILE_IDS.basic
    : CART_WORKLOAD_PROFILE_IDS.desync100;
}

export const CART_VERSIONS = {
  graph: 'cart-graph-v1',
  model: 'cart-model-v1',
  content: CART_CONTENT_VERSIONS.basic,
  pricing: 'cart-pricing-v1-candidate',
  profile: CART_WORKLOAD_PROFILE_IDS.basic,
  result: 'cart-result-v1',
  protocol: 'cart-protocol-v1',
} as const;

export type CartVersions = { -readonly [K in keyof typeof CART_VERSIONS]: (typeof CART_VERSIONS)[K] };

/** Original six-case advanced benchmark list (explicit profile only). */
export const CART_ADVANCED_REQUIRED_CASES = [
  'normal',
  'peak',
  'mobility',
  'concurrent',
  'partition',
  'checkout',
] as const;

/** Every case identifier that exists in any profile. */
export const CART_ALL_CASES = CART_ADVANCED_REQUIRED_CASES;

export type CartCaseId = (typeof CART_ALL_CASES)[number];

/**
 * Required cases of the default Cart Foundations level: exactly Normal and
 * Rush (`peak`), fault-free. Advanced cases are never part of this list and
 * are never reported as passed by it.
 */
export const CART_BASIC_REQUIRED_CASES = ['normal', 'peak'] as const satisfies readonly CartCaseId[];
export const CART_REQUIRED_CASES = CART_BASIC_REQUIRED_CASES;

/** Seed is a uint32; the protocol default is 1729. */
export const CART_MAX_SEED = 4_294_967_295;
export const CART_DEFAULT_SEED = 1729;

export const CART_REGIONS = ['us-west', 'eu-central', 'ap-northeast'] as const;
export type CartRegion = (typeof CART_REGIONS)[number];

export const CART_NODE_KINDS = [
  'customers',
  'application',
  'cache',
  'journal',
  'store',
  'inventory',
] as const;
export type CartNodeKind = (typeof CART_NODE_KINDS)[number];

export const CART_SERVICE_SIZES = ['S', 'M'] as const;
export type CartServiceSize = (typeof CART_SERVICE_SIZES)[number];

export const CART_READ_POLICIES = ['local-repair', 'parallel'] as const;
export type CartReadPolicy = (typeof CART_READ_POLICIES)[number];

export const CART_EDGE_KINDS = ['request', 'replication'] as const;
export type CartEdgeKind = (typeof CART_EDGE_KINDS)[number];

/** Independence WAN tiers per unordered region pair, per direction. */
export const CART_CIRCUIT_MBPS = [2, 8, 32] as const;
export type CartCircuitMbps = (typeof CART_CIRCUIT_MBPS)[number];

export interface CartRegionInfo {
  /** English display label. */
  readonly label: string;
  readonly city: string;
  /** Canonical ordinal used for semantic normalization; never player order. */
  readonly ordinal: number;
}

export const CART_REGION_INFO: Readonly<Record<CartRegion, CartRegionInfo>> = {
  'us-west': { label: 'US West', city: 'San Francisco', ordinal: 0 },
  'eu-central': { label: 'EU Central', city: 'Frankfurt', ordinal: 1 },
  'ap-northeast': { label: 'AP Northeast', city: 'Tokyo', ordinal: 2 },
};

export interface CartNodeKindInfo {
  readonly label: string;
  /** Canonical kind ordinal used for semantic normalization. */
  readonly ordinal: number;
  readonly role: 'source' | 'service';
  /** Durable nodes may be replication destinations and write authorities. */
  readonly durable: boolean;
  readonly fields: readonly string[];
}

export const CART_NODE_KIND_INFO: Readonly<Record<CartNodeKind, CartNodeKindInfo>> = {
  customers: {
    label: 'Regional customers',
    ordinal: 0,
    role: 'source',
    durable: false,
    fields: ['id', 'kind', 'region', 'position', 'label?'],
  },
  application: {
    label: 'Application',
    ordinal: 1,
    role: 'service',
    durable: false,
    fields: [
      'id',
      'kind',
      'region',
      'position',
      'label?',
      'size',
      'instances',
      'writeTarget',
      'readPolicy',
      'readTargets',
    ],
  },
  cache: {
    label: 'Cache',
    ordinal: 2,
    role: 'service',
    durable: false,
    fields: ['id', 'kind', 'region', 'position', 'label?', 'size'],
  },
  journal: {
    label: 'Durable journal',
    ordinal: 3,
    role: 'service',
    durable: true,
    fields: ['id', 'kind', 'region', 'position', 'label?', 'size'],
  },
  store: {
    label: 'Cart store',
    ordinal: 4,
    role: 'service',
    durable: true,
    fields: ['id', 'kind', 'region', 'position', 'label?', 'size'],
  },
  inventory: {
    label: 'Inventory',
    ordinal: 5,
    role: 'service',
    durable: true,
    fields: ['id', 'kind', 'region', 'position', 'label?', 'size'],
  },
};

/** Protocol caps that are not prices; numeric balance stays unproven. */
export const CART_LIMITS = {
  maxNodes: 24,
  maxEdges: 60,
  maxCircuits: 3,
  maxReadTargets: 8,
  maxDocumentBytes: 1_048_576,
  idPattern: '^[A-Za-z0-9._:-]{1,64}$',
  labelMaxLength: 80,
  position: { min: -10_000, max: 10_000 },
  seed: { min: 0, max: CART_MAX_SEED, default: CART_DEFAULT_SEED },
  regions: [...CART_REGIONS],
  nodeKinds: [...CART_NODE_KINDS],
  serviceSizes: [...CART_SERVICE_SIZES],
  readPolicies: [...CART_READ_POLICIES],
  edgeKinds: [...CART_EDGE_KINDS],
  circuitMbps: [...CART_CIRCUIT_MBPS],
  requiredCases: [...CART_REQUIRED_CASES],
} as const;

// ---------------------------------------------------------------------------
// Issues and parse results
// ---------------------------------------------------------------------------

export const cartIssueSchema = z.strictObject({
  /** Stable machine-readable identifier, for example `duplicate_node_id`. */
  code: z.string().min(1).max(96),
  /** English product message. */
  message: z.string().min(1).max(2_000),
  nodeId: z.string().min(1).max(64).optional(),
  edgeId: z.string().min(1).max(64).optional(),
});

export type CartIssue = z.infer<typeof cartIssueSchema>;

/**
 * Structural problems make a graph unusable. Qualification problems are
 * legitimate for the source-only starter and only describe missing
 * requirements, never hidden parser failures.
 */
export const CART_STRUCTURAL_ISSUE_CODES = [
  'duplicate_node_id',
  'duplicate_edge_id',
  'duplicate_semantic_edge',
  'duplicate_circuit',
  'unknown_node_ref',
  'self_edge',
  'customers_target_rule',
  'request_into_customers',
  'request_edge_endpoints',
  'replication_edge_endpoints',
  'replication_target_not_durable',
  'missing_circuit',
  'duplicate_regional_service',
  'source_id_not_canonical',
  'circuit_same_region',
  'circuit_regions_unsorted',
  'write_target_missing',
  'write_target_not_durable',
  'write_target_unreachable',
  'read_target_missing',
  'read_target_kind',
  'read_target_duplicate',
  'read_target_unreachable',
  'request_cycle',
  'inventory_unreachable',
  'node_limit_exceeded',
  'edge_limit_exceeded',
] as const;

export const CART_QUALIFICATION_ISSUE_CODES = [
  'missing_customers_region',
  'missing_application_region',
  'missing_inventory',
] as const;

export type CartStructuralIssueCode = (typeof CART_STRUCTURAL_ISSUE_CODES)[number];
export type CartQualificationIssueCode = (typeof CART_QUALIFICATION_ISSUE_CODES)[number];

const STRUCTURAL_CODES = new Set<string>(CART_STRUCTURAL_ISSUE_CODES);
const QUALIFICATION_CODES = new Set<string>(CART_QUALIFICATION_ISSUE_CODES);

/** True when an issue is a missing qualifying requirement, not invalid input. */
export function isCartQualificationIssue(issue: CartIssue): boolean {
  return QUALIFICATION_CODES.has(issue.code);
}

/** True when an issue makes the submitted graph structurally unusable. */
export function isCartStructuralIssue(issue: CartIssue): boolean {
  return STRUCTURAL_CODES.has(issue.code);
}

export type CartParseResult =
  | {
      readonly ok: true;
      readonly graph: CartGraph;
      /** Set only when an explicit compatibility restamp changed the content version. */
      readonly migratedFrom?: CartContentVersion;
    }
  | { readonly ok: false; readonly issues: CartIssue[] };

// ---------------------------------------------------------------------------
// Graph document schemas
// ---------------------------------------------------------------------------

export const cartIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const cartLabelSchema = z.string().min(1).max(CART_LIMITS.labelMaxLength);

export const cartPositionSchema = z.strictObject({
  x: z
    .number()
    .finite()
    .min(CART_LIMITS.position.min)
    .max(CART_LIMITS.position.max),
  y: z
    .number()
    .finite()
    .min(CART_LIMITS.position.min)
    .max(CART_LIMITS.position.max),
});

export const cartRegionSchema = z.enum(CART_REGIONS);
export const cartNodeKindSchema = z.enum(CART_NODE_KINDS);
export const cartServiceSizeSchema = z.enum(CART_SERVICE_SIZES);
export const cartReadPolicySchema = z.enum(CART_READ_POLICIES);
export const cartEdgeKindSchema = z.enum(CART_EDGE_KINDS);
export const cartCircuitMbpsSchema = z.union([
  z.literal(CART_CIRCUIT_MBPS[0]),
  z.literal(CART_CIRCUIT_MBPS[1]),
  z.literal(CART_CIRCUIT_MBPS[2]),
]);

export const cartCustomersNodeSchema = z.strictObject({
  id: cartIdSchema,
  kind: z.literal('customers'),
  region: cartRegionSchema,
  position: cartPositionSchema,
  label: cartLabelSchema.optional(),
});

export const cartApplicationNodeSchema = z.strictObject({
  id: cartIdSchema,
  kind: z.literal('application'),
  region: cartRegionSchema,
  position: cartPositionSchema,
  label: cartLabelSchema.optional(),
  size: cartServiceSizeSchema,
  instances: z.number().int().min(1).max(2),
  /** Origin write authority for this region's edit keys; must be reachable. */
  writeTarget: cartIdSchema,
  readPolicy: cartReadPolicySchema,
  /** Configured repair targets; order is not semantic. */
  readTargets: z.array(cartIdSchema).min(1).max(CART_LIMITS.maxReadTargets),
});

const cartSizedServiceFields = {
  size: cartServiceSizeSchema,
} as const;

export const cartCacheNodeSchema = z.strictObject({
  id: cartIdSchema,
  kind: z.literal('cache'),
  region: cartRegionSchema,
  position: cartPositionSchema,
  label: cartLabelSchema.optional(),
  ...cartSizedServiceFields,
});

export const cartJournalNodeSchema = z.strictObject({
  id: cartIdSchema,
  kind: z.literal('journal'),
  region: cartRegionSchema,
  position: cartPositionSchema,
  label: cartLabelSchema.optional(),
  ...cartSizedServiceFields,
});

export const cartStoreNodeSchema = z.strictObject({
  id: cartIdSchema,
  kind: z.literal('store'),
  region: cartRegionSchema,
  position: cartPositionSchema,
  label: cartLabelSchema.optional(),
  ...cartSizedServiceFields,
});

export const cartInventoryNodeSchema = z.strictObject({
  id: cartIdSchema,
  kind: z.literal('inventory'),
  region: cartRegionSchema,
  position: cartPositionSchema,
  label: cartLabelSchema.optional(),
  ...cartSizedServiceFields,
});

export const cartNodeSchema = z.discriminatedUnion('kind', [
  cartCustomersNodeSchema,
  cartApplicationNodeSchema,
  cartCacheNodeSchema,
  cartJournalNodeSchema,
  cartStoreNodeSchema,
  cartInventoryNodeSchema,
]);

export const cartEdgeSchema = z.strictObject({
  id: cartIdSchema,
  from: cartIdSchema,
  to: cartIdSchema,
  kind: cartEdgeKindSchema,
});

export const cartCircuitSchema = z.strictObject({
  /** Exactly two distinct regions in canonical ascending ordinal order. */
  regions: z.tuple([cartRegionSchema, cartRegionSchema]),
  mbps: cartCircuitMbpsSchema,
});

export const cartGraphSchema = z.strictObject({
  levelId: z.literal(CART_LEVEL_ID),
  graphVersion: z.literal(CART_VERSIONS.graph),
  contentVersion: z.enum([CART_CONTENT_VERSIONS.basic, CART_CONTENT_VERSIONS.advanced]),
  seed: z.number().int().min(0).max(CART_MAX_SEED),
  nodes: z.array(cartNodeSchema).max(CART_LIMITS.maxNodes),
  edges: z.array(cartEdgeSchema).max(CART_LIMITS.maxEdges),
  circuits: z.array(cartCircuitSchema).max(CART_LIMITS.maxCircuits),
});

export type CartCustomersNode = z.infer<typeof cartCustomersNodeSchema>;
export type CartApplicationNode = z.infer<typeof cartApplicationNodeSchema>;
export type CartSizedServiceNode =
  | z.infer<typeof cartCacheNodeSchema>
  | z.infer<typeof cartJournalNodeSchema>
  | z.infer<typeof cartStoreNodeSchema>
  | z.infer<typeof cartInventoryNodeSchema>;
export type CartCacheNode = z.infer<typeof cartCacheNodeSchema>;
export type CartJournalNode = z.infer<typeof cartJournalNodeSchema>;
export type CartStoreNode = z.infer<typeof cartStoreNodeSchema>;
export type CartInventoryNode = z.infer<typeof cartInventoryNodeSchema>;
export type CartNode = z.infer<typeof cartNodeSchema>;
export type CartEdge = z.infer<typeof cartEdgeSchema>;
export type CartCircuit = z.infer<typeof cartCircuitSchema>;
export type CartGraph = z.infer<typeof cartGraphSchema>;
export type CartPosition = z.infer<typeof cartPositionSchema>;

export function cartIssuesFromZod(error: z.ZodError): CartIssue[] {
  const issues: CartIssue[] = [];
  for (const issue of error.issues) {
    const path = issue.path.map(String).join('.');
    const base = {
      message: path === '' ? issue.message : `${path}: ${issue.message}`,
    };
    if (issue.code === 'unrecognized_keys') {
      const keys = 'keys' in issue && Array.isArray(issue.keys) ? issue.keys : [];
      for (const key of keys) {
        issues.push({
          ...base,
          code: 'unknown_field',
          message: `Unknown field "${String(key)}" is not allowed.`,
        });
      }
      continue;
    }
    if (issue.code === 'invalid_union' || issue.code === 'invalid_value' || issue.code === 'invalid_format') {
      issues.push({ ...base, code: 'invalid_value' });
      continue;
    }
    if (issue.code === 'too_big' || issue.code === 'too_small') {
      issues.push({ ...base, code: 'number_out_of_range' });
      continue;
    }
    issues.push({ ...base, code: 'invalid_type' });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Canonical JSON and synchronous SHA-256 (deterministic in browser and Node)
// ---------------------------------------------------------------------------

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function canonicalize(value: unknown, path: string): CanonicalValue {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value as string | boolean;
  if (type === 'number') {
    const numeric = value as number;
    if (!Number.isFinite(numeric)) {
      throw new Error(`Canonical JSON cannot encode a non-finite number at ${path}.`);
    }
    return numeric;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalize(entry, `${path}[${index}]`));
  }
  if (type === 'object') {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source)
      .filter((key) => source[key] !== undefined)
      .sort();
    const result: { [key: string]: CanonicalValue } = {};
    for (const key of keys) {
      if (!/^[\x20-\x7e]*$/.test(key)) {
        throw new Error(`Canonical JSON keys must be printable ASCII at ${path}.`);
      }
      result[key] = canonicalize(source[key], `${path}.${key}`);
    }
    return result;
  }
  throw new Error(`Canonical JSON cannot encode ${type} at ${path}.`);
}

/**
 * Canonical JSON: recursively lexicographically sorted keys, compact
 * separators, no insignificant numeric zeros and no undefined/NaN. Arrays keep
 * their order because callers normalize sets before serializing.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, '$'));
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, shift: number): number {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

/**
 * Deterministic synchronous SHA-256 over the UTF-8 bytes of `text`.
 * WebCrypto is async and Node's crypto is unavailable in the browser bundle,
 * so the cart module carries this small fixed implementation instead. The
 * digest is used for semantic graph identity and later trace/basket bindings.
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9) + 63) >> 6) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w: number[] = new Array<number>(64).fill(0);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] ?? 0;
      const y = w[i - 2] ?? 0;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const sigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choose + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const sigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((part) => part.toString(16).padStart(8, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Evaluation and session contracts (implemented by GC-011)
// ---------------------------------------------------------------------------

export const cartOperationClassSchema = z.enum(['edit', 'read', 'checkout', 'probe', 'audit']);
export type CartOperationClass = z.infer<typeof cartOperationClassSchema>;

export const cartVersionsSchema = z
  .strictObject({
    graph: z.literal(CART_VERSIONS.graph),
    model: z.literal(CART_VERSIONS.model),
    content: z.enum([CART_CONTENT_VERSIONS.basic, CART_CONTENT_VERSIONS.advanced]),
    pricing: z.literal(CART_VERSIONS.pricing),
    profile: z.enum([
      CART_WORKLOAD_PROFILE_IDS.basic,
      CART_WORKLOAD_PROFILE_IDS.desync100,
      CART_WORKLOAD_PROFILE_IDS.original,
    ]),
    result: z.literal(CART_VERSIONS.result),
    protocol: z.literal(CART_VERSIONS.protocol),
  })
  .refine((v) => v.content === cartContentVersionForProfile(v.profile), {
    path: ['content'],
    message: 'Content version does not match the workload profile (basic ↔ cart-content-v2-basic, advanced ↔ cart-content-v1).',
  });

/** Numeric counters keyed by a stable cohort/outcome code. */
const cartCounterRecordSchema = z.record(
  z.string().min(1).max(64),
  z.number().int().min(0),
);
const cartNumberRecordSchema = z.record(
  z.string().min(1).max(64),
  z.number().finite(),
);

export const cartGateSchema = z.strictObject({
  code: z.string().min(1).max(96),
  caseId: z.enum(CART_ALL_CASES),
  region: cartRegionSchema,
  operation: cartOperationClassSchema,
  cohort: z.string().min(1).max(120),
  observed: z.number().finite(),
  limit: z.number().finite(),
  pass: z.boolean(),
  evidenceIds: z.array(z.string().min(1).max(64)).max(1_000),
});

export type CartGate = z.infer<typeof cartGateSchema>;

const cartRunObservationSchema = z.strictObject({
  elapsedMs: z.number().nonnegative(),
  operations: z.array(z.strictObject({
    operation: z.string(), launched: z.number().nonnegative(), completed: z.number().nonnegative(),
    successful: z.number().nonnegative(), business: z.number().nonnegative(), errors: z.number().nonnegative(),
    timeouts: z.number().nonnegative(), pending: z.number().nonnegative(), samples: z.number().nonnegative(),
    p50Ms: z.number().nonnegative().nullable(), p95Ms: z.number().nonnegative().nullable(), p99Ms: z.number().nonnegative().nullable(),
  })).max(5),
  nodes: z.array(z.strictObject({
    nodeId: z.string(), cpuMs: z.number().nonnegative(), ramBytes: z.number().nonnegative(), ramCapacityBytes: z.number().nonnegative(),
    pendingTasks: z.number().nonnegative(), transactionQueue: z.number().nonnegative(), ioUnits: z.number().nonnegative(),
    storedBytes: z.number().nonnegative(), storageCapacityBytes: z.number().nonnegative(),
    // Additive load counters for the whole observed run; absent in results produced before they existed.
    load: z.strictObject({
      cpuLanes: z.number().int().positive(), cpuTasks: z.number().nonnegative(), cpuBusyMs: z.number().nonnegative(),
      cpuWaitAvgMs: z.number().nonnegative(), cpuWaitMaxMs: z.number().nonnegative(), cpuRejected: z.number().nonnegative(),
      ioTasks: z.number().nonnegative(), ioBusyMs: z.number().nonnegative(),
      ioWaitAvgMs: z.number().nonnegative(), ioWaitMaxMs: z.number().nonnegative(),
    }).optional(),
  })).max(100),
  // Additive: busy time and queue waits of every physical link that carried traffic.
  links: z.array(z.strictObject({
    id: z.string(), kind: z.enum(['nic', 'wan']), pair: z.string().nullable(), direction: z.string(),
    mbps: z.number().nonnegative(), jobs: z.number().nonnegative(), busyMs: z.number().nonnegative(),
    waitAvgMs: z.number().nonnegative(), waitMaxMs: z.number().nonnegative(),
  })).max(200).optional(),
});
export const cartCaseResultSchema = z.strictObject({
  observation: cartRunObservationSchema.optional(),
  id: z.enum(CART_ALL_CASES),
  scheduled: z.number().int().min(0),
  issued: z.number().int().min(0),
  dependencyFailed: z.number().int().min(0),
  outcomes: cartCounterRecordSchema,
  gates: z.array(cartGateSchema),
  resources: cartNumberRecordSchema,
  cost: cartNumberRecordSchema,
  complete: z.boolean(),
});

export type CartCaseResult = z.infer<typeof cartCaseResultSchema>;

export const cartEvaluationSchema = z.strictObject({
  levelId: z.literal(CART_LEVEL_ID),
  versions: cartVersionsSchema,
  graphDigest: z.string().regex(/^[0-9a-f]{64}$/),
  seed: z.number().int().min(0).max(CART_MAX_SEED),
  // Basic profile: 2 cases; explicit advanced benchmark profiles: 6 cases.
  requiredCases: z
    .array(z.enum(CART_ALL_CASES))
    .min(CART_BASIC_REQUIRED_CASES.length)
    .max(CART_ALL_CASES.length),
  cases: z
    .array(cartCaseResultSchema)
    .min(CART_BASIC_REQUIRED_CASES.length)
    .max(CART_ALL_CASES.length),
  complete: z.boolean(),
  qualified: z.boolean(),
  scoreCreditsPerHour: z.number().finite().nonnegative().nullable(),
  issues: z.array(cartIssueSchema),
  traceHash: z.string().regex(/^[0-9a-f]{64}$/),
}).superRefine((value, ctx) => {
  // Profile-aware cross-field validation: the public schema itself must reject
  // contradictory results (duplicate/omitted/mismatched cases, or a claimed pass
  // that is incomplete, has a failing gate, or carries no score).
  const expected: readonly string[] =
    value.versions.profile === CART_WORKLOAD_PROFILE_IDS.basic
      ? CART_BASIC_REQUIRED_CASES
      : CART_ADVANCED_REQUIRED_CASES;
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((item, index) => item === b[index]);
  if (!same(value.requiredCases, expected)) {
    ctx.addIssue({
      code: 'custom',
      path: ['requiredCases'],
      message: `requiredCases must be exactly [${expected.join(', ')}] in order for profile ${value.versions.profile}.`,
    });
  }
  if (!same(value.cases.map((item) => item.id), expected)) {
    ctx.addIssue({
      code: 'custom',
      path: ['cases'],
      message: `cases must be exactly [${expected.join(', ')}] in order, each once, for profile ${value.versions.profile}.`,
    });
  }
  const allComplete = value.cases.every((item) => item.complete);
  const anyFailedGate = value.cases.some((item) =>
    item.gates.some((gate) => !gate.pass),
  );
  if (value.complete !== allComplete) {
    ctx.addIssue({
      code: 'custom',
      path: ['complete'],
      message: 'complete must equal the conjunction of every case complete flag.',
    });
  }
  if (value.qualified) {
    if (!value.complete || anyFailedGate || value.scoreCreditsPerHour === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['qualified'],
        message: 'qualified requires a complete run, no failing gate and a non-null score.',
      });
    }
  } else if (value.scoreCreditsPerHour !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['scoreCreditsPerHour'],
      message: 'A non-qualified result must withhold the score (null).',
    });
  }
});

export type CartEvaluation = z.infer<typeof cartEvaluationSchema>;

export const cartProgressSchema = z.strictObject({
  /** Fault-free workload offers, not internal RPC/retry events; per current case. */
  caseEvents: z.number().int().min(0).optional(),
  caseEventsTotal: z.number().int().min(0).optional(),
  requestProblems: z.number().int().min(0).optional(),
  caseId: z.enum(CART_ALL_CASES).nullable(),
  casesCompleted: z.number().int().min(0).max(CART_ALL_CASES.length),
  events: z.number().int().min(0),
  elapsedUs: z.number().int().min(0),
  /** Short English phase description for the UI; never a correctness proof. */
  message: z.string().min(1).max(300).optional(),
});

export type CartProgress = z.infer<typeof cartProgressSchema>;

export interface CartAdvanceResult {
  readonly done: boolean;
  readonly progress: CartProgress;
}

/**
 * Worker-friendly evaluation session. `advance` processes at most 5000 events
 * per call; `cancel` yields an incomplete evaluation, never a pass; `result`
 * is null until the run has finished or been cancelled.
 */
export interface CartSession {
  advance(maxEvents: number): CartAdvanceResult;
  cancel(): void;
  result(): CartEvaluation | null;
}

/**
 * Worker message envelope for `cart-worker-v1`. The four mutation types share
 * one tagged shape so unknown combinations are rejected before dispatch.
 */
export const CART_WORKER_PROTOCOL = 'cart-worker-v1' as const;

export const cartWorkerMessageSchema = z.strictObject({
  protocol: z.literal(CART_WORKER_PROTOCOL),
  runId: z.string().min(1).max(64),
  generation: z.number().int().min(0),
  type: z.enum(['start', 'cancel', 'advance', 'result', 'progress', 'error']),
  payload: z.record(z.string().min(1).max(64), z.unknown()),
});

export type CartWorkerMessage = z.infer<typeof cartWorkerMessageSchema>;

export const CART_MAX_ADVANCE_EVENTS = 5_000;
export const CART_RETAINED_TRACE_EVENTS = 2_000;
export const CART_TELEMETRY_FRAME_MS = 100;

// ---------------------------------------------------------------------------
// JSON Schema exports (public boundary for agents, API and persistence)
// ---------------------------------------------------------------------------

export function cartGraphJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(cartGraphSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id: 'https://system-design-game.local/schemas/global-cart-graph.json',
    title: 'Global Cart graph (cart-graph-v1)',
  };
}

export function cartEvaluationJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(cartEvaluationSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id: 'https://system-design-game.local/schemas/global-cart-evaluation.json',
    title: 'Global Cart evaluation (cart-result-v1)',
  };
}
