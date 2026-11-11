import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import {
  CART_CATALOG,
  CART_DEFAULT_SEED,
  CART_LEVEL_ID,
  CART_LIMITS,
  CART_MAX_SEED,
  CART_REQUIRED_CASES,
  CART_VERSIONS,
  canonicalJson,
  cartEvaluationJsonSchema,
  cartEvaluationSchema,
  cartGraphJsonSchema,
  cartProgressSchema,
  cartGraphSchema,
  cloneCartCatalog,
  createCartStarterGraph,
  describeCartLevel,
  parseCartGraph,
  parseCartGraphJson,
  sha256Hex,
  type CartGraph,
} from '../index';

const VERSIONS_JSON = {
  graph: 'cart-graph-v1',
  model: 'cart-model-v1',
  content: 'cart-content-v1',
  pricing: 'cart-pricing-v1-candidate',
  profile: 'global-cart-v1-candidate',
  result: 'cart-result-v1',
  protocol: 'cart-protocol-v1',
};

/** Frozen versions.json with the GC-B01 basic Cart Foundations profile (D002). */
const ADOPTED_VERSIONS = {
  ...VERSIONS_JSON,
  content: 'cart-content-v2-basic',
  profile: 'global-cart-v1-basic-desync100',
};

const WORKLOAD_CASES = ['normal', 'peak'];

/** Exact literal from the frozen `starter.json` fixture. */
const STARTER_JSON = {
  levelId: 'global-cart',
  graphVersion: 'cart-graph-v1',
  contentVersion: 'cart-content-v2-basic',
  seed: 1729,
  nodes: [
    { id: 'customers-us-west', kind: 'customers', region: 'us-west', position: { x: 80, y: 80 } },
    { id: 'customers-eu-central', kind: 'customers', region: 'eu-central', position: { x: 480, y: 80 } },
    { id: 'customers-ap-northeast', kind: 'customers', region: 'ap-northeast', position: { x: 880, y: 80 } },
  ],
  edges: [],
  circuits: [],
};

function mutableStarter(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(STARTER_JSON)) as Record<string, unknown>;
}

function qualifyingGraphLike(): CartGraph {
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes: [
      { id: 'customers-us-west', kind: 'customers', region: 'us-west', position: { x: 0, y: 0 } },
      { id: 'customers-eu-central', kind: 'customers', region: 'eu-central', position: { x: 0, y: 0 } },
      { id: 'customers-ap-northeast', kind: 'customers', region: 'ap-northeast', position: { x: 0, y: 0 } },
      {
        id: 'app-us-west',
        kind: 'application',
        region: 'us-west',
        position: { x: 10, y: 10 },
        size: 'S',
        instances: 1,
        writeTarget: 'journal-us-west',
        readPolicy: 'local-repair',
        readTargets: ['journal-us-west'],
      },
      {
        id: 'app-eu-central',
        kind: 'application',
        region: 'eu-central',
        position: { x: 10, y: 10 },
        size: 'S',
        instances: 1,
        writeTarget: 'journal-eu-central',
        readPolicy: 'local-repair',
        readTargets: ['journal-eu-central'],
      },
      {
        id: 'app-ap-northeast',
        kind: 'application',
        region: 'ap-northeast',
        position: { x: 10, y: 10 },
        size: 'S',
        instances: 1,
        writeTarget: 'journal-ap-northeast',
        readPolicy: 'local-repair',
        readTargets: ['journal-ap-northeast'],
      },
      { id: 'journal-us-west', kind: 'journal', region: 'us-west', position: { x: 20, y: 20 }, size: 'S' },
      { id: 'journal-eu-central', kind: 'journal', region: 'eu-central', position: { x: 20, y: 20 }, size: 'S' },
      { id: 'journal-ap-northeast', kind: 'journal', region: 'ap-northeast', position: { x: 20, y: 20 }, size: 'S' },
      { id: 'inventory-us-west', kind: 'inventory', region: 'us-west', position: { x: 30, y: 30 }, size: 'M' },
    ],
    edges: [
      { id: 'e-c-us', from: 'customers-us-west', to: 'app-us-west', kind: 'request' },
      { id: 'e-c-eu', from: 'customers-eu-central', to: 'app-eu-central', kind: 'request' },
      { id: 'e-c-ap', from: 'customers-ap-northeast', to: 'app-ap-northeast', kind: 'request' },
      { id: 'e-a-j-us', from: 'app-us-west', to: 'journal-us-west', kind: 'request' },
      { id: 'e-a-j-eu', from: 'app-eu-central', to: 'journal-eu-central', kind: 'request' },
      { id: 'e-a-j-ap', from: 'app-ap-northeast', to: 'journal-ap-northeast', kind: 'request' },
      { id: 'e-a-i-us', from: 'app-us-west', to: 'inventory-us-west', kind: 'request' },
      { id: 'e-a-i-eu', from: 'app-eu-central', to: 'inventory-us-west', kind: 'request' },
      { id: 'e-a-i-ap', from: 'app-ap-northeast', to: 'inventory-us-west', kind: 'request' },
    ],
    circuits: [
      { regions: ['us-west', 'eu-central'], mbps: 8 },
      { regions: ['us-west', 'ap-northeast'], mbps: 32 },
    ],
  };
}

function expectRejected(input: unknown): void {
  const result = parseCartGraph(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected rejection');
  expect(result.issues.length).toBeGreaterThan(0);
  expect(Object.prototype.hasOwnProperty.call(result, 'graph')).toBe(false);
}

describe('versioned identities', () => {
  it('matches the frozen versions.json and workload case list', () => {
    // GC-WL2: only `profile` is intentionally the adopted desync version; every
    // other frozen literal is unchanged.
    expect({ ...CART_VERSIONS }).toEqual(ADOPTED_VERSIONS);
    expect([...CART_REQUIRED_CASES]).toEqual(WORKLOAD_CASES);
    expect(CART_LEVEL_ID).toBe('global-cart');
    expect(CART_MAX_SEED).toBe(4_294_967_295);
    expect(CART_DEFAULT_SEED).toBe(1729);
    expect([...CART_LIMITS.circuitMbps]).toEqual([2, 8, 32]);
    expect(CART_LIMITS.maxNodes).toBe(24);
    expect(CART_LIMITS.maxEdges).toBe(60);
  });
});

describe('canonical JSON and SHA-256', () => {
  it('produces the published SHA-256 test vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    // Multi-block input: 1,000,000 'a' characters.
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('sorts keys recursively and drops insignificant numeric zeros', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 2, 1] } })).toBe(
      '{"a":{"c":[3,2,1],"d":2},"b":1}',
    );
    expect(canonicalJson({ value: 0.3, whole: 2.0, negativeZero: -0 })).toBe(
      '{"negativeZero":0,"value":0.3,"whole":2}',
    );
    expect(canonicalJson({ present: null, missing: undefined })).toBe(
      '{"present":null}',
    );
  });

  it('rejects values it cannot represent deterministically', () => {
    expect(() => canonicalJson({ bad: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ bad: Number.POSITIVE_INFINITY })).toThrow(
      /non-finite/,
    );
    expect(() => canonicalJson({ bad: () => 1 })).toThrow(/cannot encode/);
  });
});

describe('parseCartGraph', () => {
  it('accepts the exact starter document', () => {
    const result = parseCartGraph(STARTER_JSON);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('starter must parse');
    expect(result.graph).toEqual(STARTER_JSON);
    expect(Object.prototype.hasOwnProperty.call(result, 'issues')).toBe(false);
  });

  it('accepts a graph with services, circuits and explicit authority', () => {
    expect(cartGraphSchema.safeParse(qualifyingGraphLike()).success).toBe(true);
    expect(parseCartGraph(qualifyingGraphLike()).ok).toBe(true);
  });

  it('rejects invalid kinds, roles, regions, capacities and versions atomically', () => {
    const brokenKind = mutableStarter();
    (brokenKind.nodes as Array<Record<string, unknown>>)[0]!.kind = 'database';
    expectRejected(brokenKind);

    const brokenRole = mutableStarter();
    (brokenRole.nodes as Array<Record<string, unknown>>)[0]!.kind = 'customers';
    // A valid source node with a stray service field is still rejected; roles
    // are covered by the read-policy check below.
    (brokenRole.nodes as Array<Record<string, unknown>>)[0]!.readPolicy = 'parallel';
    expectRejected(brokenRole);

    const brokenRegion = mutableStarter();
    (brokenRegion.nodes as Array<Record<string, unknown>>)[0]!.region = 'mars';
    expectRejected(brokenRegion);

    const brokenSize = mutableStarter();
    brokenSize.nodes = [
      {
        id: 'app-us-west',
        kind: 'application',
        region: 'us-west',
        position: { x: 0, y: 0 },
        size: 'XL',
        instances: 1,
        writeTarget: 'journal-us-west',
        readPolicy: 'local-repair',
        readTargets: ['journal-us-west'],
      },
    ];
    expectRejected(brokenSize);

    const brokenReadPolicy = mutableStarter();
    brokenReadPolicy.nodes = [
      {
        id: 'app-us-west',
        kind: 'application',
        region: 'us-west',
        position: { x: 0, y: 0 },
        size: 'S',
        instances: 1,
        writeTarget: 'journal-us-west',
        readPolicy: 'eventual',
        readTargets: ['journal-us-west'],
      },
    ];
    expectRejected(brokenReadPolicy);

    const tooManyInstances = qualifyingGraphLike();
    tooManyInstances.nodes[3] = {
      ...(tooManyInstances.nodes[3] as Extract<CartGraph['nodes'][number], { kind: 'application' }>),
      instances: 3,
    };
    expectRejected(tooManyInstances);

    const brokenCircuit = qualifyingGraphLike();
    (brokenCircuit.circuits[0] as { mbps: number }).mbps = 4;
    expectRejected(brokenCircuit);

    const wrongGraphVersion = { ...STARTER_JSON, graphVersion: 'cart-graph-v2' };
    expectRejected(wrongGraphVersion);

    const wrongContentVersion = { ...STARTER_JSON, contentVersion: 'cart-content-v0' };
    expectRejected(wrongContentVersion);

    const wrongLevel = { ...STARTER_JSON, levelId: 'image-atlas' };
    expectRejected(wrongLevel);

    const unknownField = mutableStarter();
    unknownField.autoSave = true;
    expectRejected(unknownField);

    const badSeed = { ...STARTER_JSON, seed: CART_MAX_SEED + 1 };
    expectRejected(badSeed);

    const fractionalSeed = { ...STARTER_JSON, seed: 1.5 };
    expectRejected(fractionalSeed);

    const nonFinitePosition = mutableStarter();
    (nonFinitePosition.nodes as Array<Record<string, unknown>>)[0]!.position = {
      x: Number.POSITIVE_INFINITY,
      y: 0,
    };
    expectRejected(nonFinitePosition);
  });

  it('rejects documents over the node and edge caps', () => {
    const tooManyNodes = mutableStarter();
    tooManyNodes.nodes = Array.from({ length: CART_LIMITS.maxNodes + 1 }, (_, index) => ({
      id: `customers-${index}`,
      kind: 'customers',
      region: 'us-west',
      position: { x: 0, y: 0 },
    }));
    expectRejected(tooManyNodes);

    const tooManyEdges = qualifyingGraphLike();
    tooManyEdges.edges = Array.from({ length: CART_LIMITS.maxEdges + 1 }, (_, index) => ({
      id: `edge-${index}`,
      from: 'app-us-west',
      to: 'journal-us-west',
      kind: 'request' as const,
    }));
    expectRejected(tooManyEdges);
  });

  it('returns stable English issues instead of throwing', () => {
    const result = parseCartGraph({ levelId: CART_LEVEL_ID, graphVersion: 'nope' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.every((issue) => issue.code.length > 0)).toBe(true);
    expect(
      result.issues.some((issue) => /^[a-z0-9_]+$/.test(issue.code)),
    ).toBe(true);
    expect(typeof result.issues[0]?.message).toBe('string');
  });

  it('maps unknown fields to a stable issue code', () => {
    const result = parseCartGraph({ ...STARTER_JSON, extra: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.issues.some((issue) => issue.code === 'unknown_field')).toBe(true);
  });

  it('parses JSON text atomically and rejects invalid JSON', () => {
    expect(parseCartGraphJson(JSON.stringify(STARTER_JSON)).ok).toBe(true);
    const bad = parseCartGraphJson('{ not json');
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('expected rejection');
    expect(bad.issues[0]?.code).toBe('invalid_json');

    const tooLarge = parseCartGraphJson('x'.repeat(CART_LIMITS.maxDocumentBytes + 1));
    expect(tooLarge.ok).toBe(false);
    if (tooLarge.ok) throw new Error('expected rejection');
    expect(tooLarge.issues[0]?.code).toBe('input_too_large');
  });

  it('never substitutes a partial graph for an invalid document', () => {
    const input = qualifyingGraphLike();
    input.edges.push({
      id: 'e-broken',
      from: 'missing',
      to: 'app-us-west',
      kind: 'request',
    });
    const result = parseCartGraph(input);
    // Unknown references are a semantic defect, not a shape defect: the
    // document still parses, but nothing is silently repaired.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected parse success');
    expect(result.graph.edges.some((edge) => edge.from === 'missing')).toBe(true);
  });
});

describe('JSON Schema exports', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });

  it('publishes a graph schema that validates the starter and a full graph', () => {
    const schema = cartGraphJsonSchema();
    expect(schema.$id).toBe(
      'https://system-design-game.local/schemas/global-cart-graph.json',
    );
    const validate = ajv.compile(schema);
    expect(validate(STARTER_JSON)).toBe(true);
    expect(validate(qualifyingGraphLike())).toBe(true);
    expect(validate({ ...STARTER_JSON, levelId: 'nope' })).toBe(false);
  });

  it('publishes an evaluation schema with the required result fields', () => {
    const schema = cartEvaluationJsonSchema();
    expect(schema.$id).toBe(
      'https://system-design-game.local/schemas/global-cart-evaluation.json',
    );
    const zeroDigest = '0'.repeat(64);
    const caseResult = {
      id: 'normal',
      scheduled: 1,
      issued: 1,
      dependencyFailed: 0,
      outcomes: { success: 1 },
      gates: [
        {
          code: 'reads.p95',
          caseId: 'normal',
          region: 'us-west',
          operation: 'read',
          cohort: 'healthy',
          observed: 1,
          limit: 500,
          pass: true,
          evidenceIds: ['op-1'],
        },
      ],
      resources: { cpuMs: 1 },
      cost: { credits: 0.1 },
      complete: true,
    };
    const evaluation = {
      levelId: CART_LEVEL_ID,
      versions: { ...CART_VERSIONS },
      graphDigest: zeroDigest,
      seed: 1729,
      requiredCases: [...CART_REQUIRED_CASES],
      cases: CART_REQUIRED_CASES.map((id) => ({ ...caseResult, id })),
      complete: true,
      qualified: true,
      scoreCreditsPerHour: 3.5,
      issues: [],
      traceHash: 'f'.repeat(64),
    };
    const validate = ajv.compile(schema);
    expect(validate(evaluation)).toBe(true);
    expect(cartEvaluationSchema.safeParse(evaluation).success).toBe(true);
    expect(
      validate({ ...evaluation, scoreCreditsPerHour: null, qualified: false }),
    ).toBe(true);
    expect(validate({ ...evaluation, cases: evaluation.cases.slice(0, 1) })).toBe(false);
    expect(cartProgressSchema.safeParse({ caseId: null, casesCompleted: 0, events: 0, elapsedUs: 0 }).success).toBe(true);
  });

  describe('profile-aware result cross-field validation', () => {
    const gate = (pass: boolean) => ({
      code: 'reads.p95',
      caseId: 'normal',
      region: 'us-west',
      operation: 'read',
      cohort: 'healthy',
      observed: 1,
      limit: 500,
      pass,
      evidenceIds: ['op-1'],
    });
    const caseOf = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      scheduled: 1,
      issued: 1,
      dependencyFailed: 0,
      outcomes: { success: 1 },
      gates: [gate(true)],
      resources: { cpuMs: 1 },
      cost: { credits: 0.1 },
      complete: true,
      ...over,
    });
    const build = (ids: readonly string[], over: Record<string, unknown> = {}) => {
      const advanced = ids.length === 6;
      const versions = advanced
        ? { ...CART_VERSIONS, content: 'cart-content-v1', profile: 'global-cart-v1-desync100' }
        : { ...CART_VERSIONS };
      return {
        levelId: CART_LEVEL_ID,
        versions,
        graphDigest: '0'.repeat(64),
        seed: 1729,
        requiredCases: [...ids],
        cases: ids.map((id) => caseOf(id)),
        complete: true,
        qualified: true,
        scoreCreditsPerHour: 3.5,
        issues: [],
        traceHash: 'f'.repeat(64),
        ...over,
      };
    };
    const basicIds = ['normal', 'peak'];
    const advancedIds = ['normal', 'peak', 'mobility', 'concurrent', 'partition', 'checkout'];
    const ok = (value: unknown): boolean => cartEvaluationSchema.safeParse(value).success;

    it('accepts valid basic, valid advanced and legitimate incomplete shapes', () => {
      expect(ok(build(basicIds))).toBe(true);
      expect(ok(build(advancedIds))).toBe(true);
      const incomplete = build(basicIds, {
        cases: [caseOf('normal'), caseOf('peak', { complete: false, gates: [] })],
        complete: false,
        qualified: false,
        scoreCreditsPerHour: null,
      });
      expect(ok(incomplete)).toBe(true);
    });

    it('rejects duplicate, omitted, reordered and cross-profile case sets', () => {
      expect(ok(build(['normal', 'normal']))).toBe(false);
      expect(ok(build(['peak', 'normal']))).toBe(false);
      expect(ok({ ...build(basicIds), cases: [caseOf('normal'), caseOf('normal')] })).toBe(false);
      expect(ok({ ...build(basicIds), requiredCases: ['normal', 'peak', 'mobility'] })).toBe(false);
      expect(ok({ ...build(advancedIds), requiredCases: basicIds, cases: [caseOf('normal'), caseOf('peak')] })).toBe(false);
      expect(ok({ ...build(advancedIds), cases: build(advancedIds).cases.slice(0, 5), requiredCases: advancedIds.slice(0, 5) })).toBe(false);
    });

    it('rejects a fabricated pass: incomplete, failing gate, missing or leaked score', () => {
      expect(ok({ ...build(basicIds), cases: [caseOf('normal'), caseOf('peak', { complete: false })] })).toBe(false);
      expect(ok(build(basicIds, { complete: false }))).toBe(false);
      expect(ok({ ...build(basicIds), cases: [caseOf('normal'), caseOf('peak', { gates: [gate(false)] })] })).toBe(false);
      expect(ok(build(basicIds, { scoreCreditsPerHour: null }))).toBe(false);
      expect(ok(build(basicIds, { qualified: false }))).toBe(false);
    });
  });
});

describe('catalog and calibrated-status metadata', () => {
  it('publishes the proposed price table without claiming measurement', () => {
    expect(CART_CATALOG.pricingVersion).toBe(VERSIONS_JSON.pricing);
    expect(CART_CATALOG.calibration.status).toBe('proposed');
    expect(CART_CATALOG.calibration.measured).toBe(false);
    expect(CART_CATALOG.calibration.calibratedAt).toBeNull();
    expect(CART_CATALOG.calibration.calibrationTask).toBe('GC-019');
    expect(CART_CATALOG.calibration.seeds).toEqual([]);
    expect(CART_CATALOG.nodes.application.sizes.S.hourlyCredits).toBe(0.2);
    expect(CART_CATALOG.nodes.application.sizes.M.hourlyCredits).toBe(0.36);
    expect(CART_CATALOG.nodes.cache.sizes.S.hourlyCredits).toBe(0.08);
    expect(CART_CATALOG.nodes.cache.sizes.M.hourlyCredits).toBe(0.14);
    expect(CART_CATALOG.nodes.journal.sizes.S.hourlyCredits).toBe(0.16);
    expect(CART_CATALOG.nodes.journal.sizes.M.hourlyCredits).toBe(0.28);
    expect(CART_CATALOG.nodes.store.sizes.S.hourlyCredits).toBe(0.3);
    expect(CART_CATALOG.nodes.store.sizes.M.hourlyCredits).toBe(0.54);
    expect(CART_CATALOG.nodes.inventory.sizes.S.hourlyCredits).toBe(0.24);
    expect(CART_CATALOG.nodes.inventory.sizes.M.hourlyCredits).toBe(0.42);
    expect(CART_CATALOG.nodes.journal.sizes.S.durableMiB).toBe(16);
    expect(CART_CATALOG.nodes.application.sizes.S.cpuLanes).toBe(1);
    expect(CART_CATALOG.work.applicationFrontDoorCpuMs).toBe(0.3);
    expect(CART_CATALOG.work.inventoryTransactionCpuMs).toBe(0.5);
    expect(CART_CATALOG.work.durableFlushMs).toBe(2);
    expect(CART_CATALOG.budget.creditsPerHour).toBe(6);
    expect(CART_CATALOG.budget.exactEqualityPasses).toBe(true);
  });

  it('shares physical circuit settings and forbids graph-selected propagation', () => {
    expect(CART_CATALOG.network.wanTiersMbps).toEqual([2, 8, 32]);
    expect(CART_CATALOG.network.wanHourlyCredits['2']).toBe(0.01);
    expect(CART_CATALOG.network.wanHourlyCredits['8']).toBe(0.04);
    expect(CART_CATALOG.network.wanHourlyCredits['32']).toBe(0.16);
    expect(CART_CATALOG.network.wanPropagationMs['us-west|eu-central']).toBe(80);
    expect(CART_CATALOG.network.wanPropagationMs['us-west|ap-northeast']).toBe(55);
    expect(CART_CATALOG.network.wanPropagationMs['eu-central|ap-northeast']).toBe(120);
    expect(CART_CATALOG.network.wanSemanticEdgesShareCircuit).toBe(true);
    expect(CART_CATALOG.network.graphCannotSelectPropagation).toBe(true);
    expect(CART_CATALOG.network.wanCreditsPerGiB).toBe(1);
  });

  it('grants no topology-label correctness bonus', () => {
    expect(CART_CATALOG.scoring.usesTopologyLabels).toBe(false);
    expect(CART_CATALOG.scoring.topologyLabelBonus).toBe(false);
    expect(CART_CATALOG.scoring.familyLabelRequired).toBe(false);
    const discovery = describeCartLevel();
    expect(discovery.scoring).toEqual(CART_CATALOG.scoring);
    expect(discovery.calibration).toEqual(CART_CATALOG.calibration);
  });

  it('returns a deep clone so callers cannot mutate the catalog', () => {
    const copy = cloneCartCatalog();
    (copy.nodes.application.sizes.S as { hourlyCredits: number }).hourlyCredits = 999;
    expect(CART_CATALOG.nodes.application.sizes.S.hourlyCredits).toBe(0.2);
  });
});

describe('level discovery', () => {
  it('describes the fixed regions, sources, authority and persistence rules', () => {
    const discovery = describeCartLevel();
    expect(discovery.levelId).toBe(CART_LEVEL_ID);
    expect(discovery.title).toBe('Global Cart');
    expect(discovery.description.length).toBeGreaterThan(80);
    expect(discovery.regions.map((region) => region.id)).toEqual([
      'us-west',
      'eu-central',
      'ap-northeast',
    ]);
    expect(discovery.regions.map((region) => region.ordinal)).toEqual([0, 1, 2]);
    expect(discovery.fixedSourceIds).toEqual([
      'customers-us-west',
      'customers-eu-central',
      'customers-ap-northeast',
    ]);
    expect(discovery.requiredCases).toEqual([...CART_REQUIRED_CASES]);
    expect(discovery.versions).toEqual(ADOPTED_VERSIONS);
    expect(discovery.authority.retryOriginAuthority).toMatch(/origin authority/i);
    expect(discovery.authority.inventoryAuthority).toMatch(/exactly one Inventory/i);
    expect(discovery.connectivity).toEqual({
      hiddenLinks: false,
      requiresExplicitEdge: true,
      undrawnTransit: false,
      note: expect.any(String),
    });
    expect(discovery.persistence.explicitOnly).toBe(true);
    expect(discovery.persistence.saveIncludes).toContain('seed');
    expect(discovery.nodeKinds.map((kind) => kind.kind)).toEqual([
      'customers',
      'application',
      'cache',
      'journal',
      'store',
      'inventory',
    ]);
  });

  it('is a deep clone and does not leak mutable state between callers', () => {
    const first = describeCartLevel();
    (first.requiredCases as unknown as string[]).push('normal');
    const second = describeCartLevel();
    expect(second.requiredCases).toHaveLength(2);
  });
});

describe('starter graph export', () => {
  it('builds the exact source-only starter', () => {
    expect(createCartStarterGraph()).toEqual(STARTER_JSON);
  });

  it('returns a fresh object on every call', () => {
    const first = createCartStarterGraph();
    first.nodes.push({
      id: 'extra',
      kind: 'customers',
      region: 'us-west',
      position: { x: 1, y: 1 },
    });
    expect(createCartStarterGraph().nodes).toHaveLength(3);
  });
});
