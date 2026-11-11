import { describe, expect, it } from 'vitest';
import {
  SCOREBOARD_CATALOG,
  cloneScoreboardCatalog,
  parseScoreboardCatalog,
} from '../catalog';
import {
  SCOREBOARD_LEVEL,
  cloneScoreboardLevel,
  parseScoreboardLevel,
} from '../level';
import {
  SCOREBOARD_LEVEL_ID,
  SCOREBOARD_SCHEMA_VERSION,
  scoreboardCatalogJsonSchema,
  scoreboardEvaluationJsonSchema,
  scoreboardGraphJsonSchema,
  scoreboardLevelJsonSchema,
  scoreboardLinkRole,
  type ScoreboardGraph,
} from '../contracts';
import {
  cloneScoreboardGraph,
  createScoreboardStarterGraph,
  parseScoreboardGraph,
  scoreboardGraphDigest,
  validateScoreboardGraph,
} from '../graph';

function app(id = 'app'): ScoreboardGraph['nodes'][number] {
  return {
    id,
    kind: 'app',
    label: `Application ${id}`,
    position: { x: 300, y: 180 },
    config: { instances: 1 },
  };
}

function sql(
  id = 'sql',
  readPlan: 'scan' | 'aggregate' = 'scan',
): ScoreboardGraph['nodes'][number] {
  return {
    id,
    kind: 'sql',
    label: `SQL ${id}`,
    position: { x: 520, y: 180 },
    config: { size: 'small', readPlan },
  };
}

function cache(id = 'cache', ttlSeconds: 0.5 | 2 | 5 | 15 = 2): ScoreboardGraph['nodes'][number] {
  return {
    id,
    kind: 'cache',
    label: `Cache ${id}`,
    position: { x: 420, y: 300 },
    config: { ttlSeconds },
  };
}

function graph(
  nodes: ScoreboardGraph['nodes'],
  edges: ScoreboardGraph['edges'],
): ScoreboardGraph {
  return {
    schemaVersion: SCOREBOARD_SCHEMA_VERSION,
    levelId: SCOREBOARD_LEVEL_ID,
    nodes,
    edges,
  };
}

function usersOnly(): ScoreboardGraph['nodes'] {
  return [
    {
      id: 'users',
      kind: 'users',
      label: 'Users',
      position: { x: 80, y: 180 },
      config: {},
    },
  ];
}

function validScanGraph(): ScoreboardGraph {
  return graph(
    [...usersOnly(), app(), sql()],
    [
      { id: 'e1', from: 'users', to: 'app' },
      { id: 'e2', from: 'app', to: 'sql' },
    ],
  );
}

function validCacheGraph(): ScoreboardGraph {
  return graph(
    [...usersOnly(), app(), sql(), cache()],
    [
      { id: 'e1', from: 'users', to: 'app' },
      { id: 'e2', from: 'app', to: 'sql' },
      { id: 'e3', from: 'app', to: 'cache' },
      { id: 'e4', from: 'cache', to: 'sql' },
    ],
  );
}

function errorCodes(value: ScoreboardGraph): string[] {
  return validateScoreboardGraph(value)
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.code);
}

describe('Live Scoreboard frozen contracts', () => {
  it('validates the authoritative level and catalog', () => {
    expect(SCOREBOARD_LEVEL.id).toBe('live-scoreboard');
    expect(SCOREBOARD_LEVEL.workload.measuredMs).toBe(90_000);
    expect(SCOREBOARD_LEVEL.dataset.participants).toBe(500_000);
    expect(SCOREBOARD_CATALOG.components.sql.sizes.large.cores).toBe(32);
    expect(SCOREBOARD_CATALOG.components.cache.ttlOptionsSeconds).toEqual([
      0.5, 2, 5, 15,
    ]);
    expect(parseScoreboardLevel(cloneScoreboardLevel()).ok).toBe(true);
    expect(parseScoreboardCatalog(cloneScoreboardCatalog()).ok).toBe(true);
  });

  it('rejects graph shape mismatches without throwing', () => {
    const cases: unknown[] = [
      null,
      'not-a-graph',
      { ...validScanGraph(), schemaVersion: 2 },
      { ...validScanGraph(), levelId: 'image-atlas' },
      { ...validScanGraph(), nodes: [] },
      {
        ...validScanGraph(),
        nodes: [...usersOnly(), app(), { ...sql(), config: { size: 'xlarge', readPlan: 'scan' } }],
      },
      {
        ...validScanGraph(),
        nodes: [...usersOnly(), { ...app(), config: { instances: 5 } }, sql()],
      },
      {
        ...validScanGraph(),
        nodes: [...usersOnly(), app(), sql(), { ...cache(), config: { ttlSeconds: 3 } }],
      },
      {
        ...validScanGraph(),
        nodes: [...usersOnly(), { ...app(), config: { instances: 1, price: 0 } }, sql()],
      },
    ];
    for (const input of cases) {
      expect(() => parseScoreboardGraph(input)).not.toThrow();
      expect(parseScoreboardGraph(input).ok).toBe(false);
    }
  });

  it('accepts a starter Users-only graph for parsing but reports missing services', () => {
    const starter = createScoreboardStarterGraph();
    expect(parseScoreboardGraph(starter).ok).toBe(true);
    expect(errorCodes(starter)).toEqual(
      expect.arrayContaining(['missing-app', 'missing-sql']),
    );
  });

  it('accepts the three intended solution families', () => {
    expect(errorCodes(validScanGraph())).toEqual([]);
    expect(errorCodes(validCacheGraph())).toEqual([]);
    const aggregate = graph(
      [...usersOnly(), app(), sql('sql', 'aggregate')],
      [
        { id: 'e1', from: 'users', to: 'app' },
        { id: 'e2', from: 'app', to: 'sql' },
      ],
    );
    expect(errorCodes(aggregate)).toEqual([]);
  });

  it('rejects disconnected, ambiguous, duplicate and illegal routes', () => {
    const disconnected = graph(
      [...usersOnly(), app(), sql(), cache()],
      [
        { id: 'e1', from: 'users', to: 'app' },
        { id: 'e2', from: 'app', to: 'sql' },
      ],
    );
    expect(errorCodes(disconnected)).toEqual(
      expect.arrayContaining(['missing-cache-read-link', 'disconnected_graph']),
    );

    const ambiguous = graph(
      [...usersOnly(), app(), sql()],
      [
        { id: 'e1', from: 'users', to: 'app' },
        { id: 'e2', from: 'users', to: 'app' },
        { id: 'e3', from: 'app', to: 'sql' },
      ],
    );
    expect(errorCodes(ambiguous)).toEqual(
      expect.arrayContaining(['ambiguous_link']),
    );

    const twoApps = graph(
      [...usersOnly(), app('app-a'), app('app-b'), sql()],
      [
        { id: 'e1', from: 'users', to: 'app-a' },
        { id: 'e2', from: 'users', to: 'app-b' },
        { id: 'e3', from: 'app-a', to: 'sql' },
        { id: 'e4', from: 'app-b', to: 'sql' },
      ],
    );
    expect(errorCodes(twoApps)).toEqual(
      expect.arrayContaining(['duplicate-app']),
    );

    const illegal = graph(
      [...usersOnly(), app(), sql()],
      [
        { id: 'e1', from: 'users', to: 'app' },
        { id: 'e2', from: 'app', to: 'sql' },
        { id: 'e3', from: 'sql', to: 'users' },
      ],
    );
    expect(errorCodes(illegal)).toEqual(
      expect.arrayContaining(['invalid_link']),
    );

    const dangling = graph(
      [...usersOnly(), app(), sql()],
      [
        { id: 'e1', from: 'users', to: 'app' },
        { id: 'e2', from: 'app', to: 'sql' },
        { id: 'e3', from: 'app', to: 'ghost' },
      ],
    );
    expect(errorCodes(dangling)).toEqual(
      expect.arrayContaining(['dangling_edge']),
    );
  });

  it('digest ignores presentation and edge ids but keeps semantics', () => {
    const base = validCacheGraph();
    const restyled = cloneScoreboardGraph(base);
    restyled.nodes = [...restyled.nodes].reverse().map((node) => ({
      ...node,
      label: `Edited ${node.id}`,
      position: { x: node.position.x + 50, y: node.position.y - 20 },
    }));
    restyled.edges = [...restyled.edges]
      .reverse()
      .map((edge, index) => ({ ...edge, id: `edited-${index}` }));

    expect(scoreboardGraphDigest(base)).toBe(scoreboardGraphDigest(restyled));

    const changedTtl = cloneScoreboardGraph(base);
    const cacheNode = changedTtl.nodes.find((node) => node.kind === 'cache');
    if (cacheNode?.kind === 'cache') {
      cacheNode.config = { ttlSeconds: 15 };
    }
    expect(scoreboardGraphDigest(base)).not.toBe(
      scoreboardGraphDigest(changedTtl),
    );

    const changedPlan = cloneScoreboardGraph(validScanGraph());
    const sqlNode = changedPlan.nodes.find((node) => node.kind === 'sql');
    if (sqlNode?.kind === 'sql') {
      sqlNode.config = { size: 'small', readPlan: 'aggregate' };
    }
    expect(scoreboardGraphDigest(validScanGraph())).not.toBe(
      scoreboardGraphDigest(changedPlan),
    );

    const removedEdge = cloneScoreboardGraph(validScanGraph());
    removedEdge.edges = removedEdge.edges.slice(0, 1);
    expect(scoreboardGraphDigest(validScanGraph())).not.toBe(
      scoreboardGraphDigest(removedEdge),
    );
  });

  it('exposes JSON schemas for graph, level, catalog and result', () => {
    for (const schema of [
      scoreboardGraphJsonSchema(),
      scoreboardLevelJsonSchema(),
      scoreboardCatalogJsonSchema(),
      scoreboardEvaluationJsonSchema(),
    ]) {
      expect(schema).toMatchObject({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
      });
      expect(typeof schema.$id).toBe('string');
    }
  });
});

describe('Live Scoreboard result boundary', () => {
  function minimalResult(): Record<string, unknown> {
    const identity = {
      levelId: 'live-scoreboard',
      modelVersion: '1.0.0',
      schemaVersion: 1,
      contentVersion: '1.0.0',
      pricingVersion: 'scoreboard-catalog-v1',
      seed: 101,
      graphDigest: '0123456789abcdef',
      runId: 'sb1-101-0123456789abcdef',
    };
    return {
      status: 'invalid',
      passed: false,
      ...identity,
      identity,
      issues: [],
      incompleteReasons: [],
      preparation: null,
      window: null,
      gates: [],
      operations: null,
      nodes: [],
      links: [],
      correctness: null,
      freshness: null,
      cost: null,
      series: [],
      trafficFrames: [],
    };
  }

  it('caps validation issues, unknown-key summaries and messages', async () => {
    const { z } = await import('zod');
    const { scoreboardIssuesFromZod } = await import('../contracts');
    const strict = z.strictObject({
      a: z.number(),
      b: z.number(),
      c: z.number(),
      d: z.number(),
      e: z.number(),
      f: z.number(),
      g: z.number(),
      h: z.number(),
      i: z.number(),
      j: z.number(),
    });
    const parsed = strict.safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }
    const issues = scoreboardIssuesFromZod(parsed.error, '', 5);
    expect(issues.length).toBeLessThanOrEqual(5);
    expect(issues.at(-1)?.code).toBe('issues_truncated');

    const unknown: Record<string, unknown> = {
      a: 0,
      b: 0,
      c: 0,
      d: 0,
      e: 0,
      f: 0,
      g: 0,
      h: 0,
      i: 0,
      j: 0,
    };
    for (let index = 0; index < 200; index += 1) {
      unknown[`unknown_${index}`] = index;
    }
    const withUnknown = strict.safeParse(unknown);
    expect(withUnknown.success).toBe(false);
    if (withUnknown.success) {
      return;
    }
    const unknownIssues = scoreboardIssuesFromZod(withUnknown.error, '', 5);
    expect(unknownIssues.length).toBeLessThanOrEqual(5);
    for (const issue of unknownIssues) {
      expect(issue.message.length).toBeLessThanOrEqual(2_000);
    }
    expect(
      unknownIssues.some((issue) => issue.message.includes('more')),
    ).toBe(true);
  });

  it('rejects over-limit result arrays at the public boundary', async () => {
    const { parseScoreboardEvaluation } = await import('../contracts');
    const base = minimalResult();
    const issues = Array.from({ length: 33 }, (_, index) => ({
      severity: 'warning',
      code: `issue_${index}`,
      message: 'x',
    }));
    expect(
      parseScoreboardEvaluation({ ...base, issues }).ok,
    ).toBe(false);

    const reasons = Array.from({ length: 33 }, (_, index) => `reason ${index}`);
    expect(
      parseScoreboardEvaluation({ ...base, incompleteReasons: reasons }).ok,
    ).toBe(false);

    const point = {
      timeMs: 1_000,
      windowMs: 1_000,
      traffic: {
        read: { offered: 0, succeeded: 0, failed: 0 },
        write: { offered: 0, succeeded: 0, failed: 0 },
      },
      latency: { read: null, write: null },
      nodes: [],
    };
    expect(
      parseScoreboardEvaluation({
        ...base,
        series: Array.from({ length: 241 }, () => ({ ...point })),
      }).ok,
    ).toBe(false);

    const frame = {
      levelId: 'live-scoreboard',
      scopeId: 'live-measured',
      scopeLabel: 'Measured',
      timeMs: 1_000,
      windowMs: 1_000,
      phase: 'measured',
      nodes: [],
      edges: [],
    };
    expect(
      parseScoreboardEvaluation({
        ...base,
        trafficFrames: Array.from({ length: 241 }, () => ({ ...frame })),
      }).ok,
    ).toBe(false);
  });

  it('rejects contradictory identity and passed/status fields', async () => {
    const { parseScoreboardEvaluation } = await import('../contracts');
    const base = minimalResult();
    expect(parseScoreboardEvaluation(base).ok).toBe(true);

    const identity = base.identity as Record<string, unknown>;
    expect(
      parseScoreboardEvaluation({
        ...base,
        identity: { ...identity, seed: 999 },
      }).ok,
    ).toBe(false);
    expect(
      parseScoreboardEvaluation({
        ...base,
        identity: { ...identity, runId: 'different-run' },
      }).ok,
    ).toBe(false);
    expect(
      parseScoreboardEvaluation({ ...base, passed: true }).ok,
    ).toBe(false);
    expect(
      parseScoreboardEvaluation({ ...base, status: 'incomplete', passed: true })
        .ok,
    ).toBe(false);
  });

  it('keeps the App -> SQL role neutral and operation-neutral', () => {
    expect(scoreboardLinkRole('app', 'sql')).toBe('primary');
    expect(scoreboardLinkRole('users', 'app')).toBe('traffic');
    expect(scoreboardLinkRole('app', 'cache')).toBe('reads');
    expect(scoreboardLinkRole('cache', 'sql')).toBe('fill');
    expect(scoreboardLinkRole('sql', 'app')).toBeNull();
  });

  it('encodes the status/passed invariant in JSON Schema', () => {
    const schema = scoreboardEvaluationJsonSchema();
    expect(Array.isArray(schema.allOf)).toBe(true);
  });
});
