import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARCEL_COMPONENT_LIMITS } from '../index';
import { fixture } from './helpers';

const root = process.cwd();
const tsxCli = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function cli(...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [tsxCli, 'scripts/agent.ts', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function cliInput(input: string, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [tsxCli, 'scripts/agent.ts', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      input,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('agent CLI', () => {
  it('flushes a large piped JSON document before exiting', () => {
    const result = cli(
      'schema',
      '--level',
      'image-atlas',
      '--compact',
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.length).toBeGreaterThan(250_000);
    const parsed = JSON.parse(result.stdout) as {
      command: string;
      graph: { properties: { levelId: { const: string } } };
    };
    expect(parsed.command).toBe('schema');
    expect(parsed.graph.properties.levelId.const).toBe('image-atlas');
  });

  it('keeps the documented npm --silent example parseable as one JSON document', () => {
    const result = spawnSync('npm', ['run', '--silent', 'agent', '--', 'levels'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
    expect(result.stdout.trim().startsWith('{')).toBe(true);
  });

  it('emits a directly importable graph from example', () => {
    const result = cli('example', '--family', 'starter', '--compact');
    expect(result.status).toBe(0);
    const graph = JSON.parse(result.stdout) as {
      schemaVersion: number;
      nodes: { id: string; position: { x: number } }[];
    };
    expect(graph.schemaVersion).toBe(1);
    expect(graph.nodes.find((node) => node.id === 'app-1')?.position.x).toBe(420);
  });

  it('reads normal stdin and rejects oversized stdin before parsing', () => {
    const normal = cliInput(
      JSON.stringify(fixture('starter')),
      'validate',
      '--graph',
      '-',
    );
    expect(normal.status).toBe(0);
    expect((JSON.parse(normal.stdout) as { ok: boolean }).ok).toBe(true);

    const oversized = cliInput(
      'x'.repeat(PARCEL_COMPONENT_LIMITS.maxDocumentBytes + 1),
      'validate',
      '--graph',
      '-',
    );
    expect(oversized.status).toBe(1);
    expect(
      (JSON.parse(oversized.stdout) as { error: { code: string } }).error.code,
    ).toBe('graph_too_large');
  });

  it('returns a structured per-item oversize error for an oversized batch file', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'parcel-cli-'));
    const path = resolve(directory, 'oversized.json');
    try {
      writeFileSync(
        path,
        'x'.repeat(PARCEL_COMPONENT_LIMITS.maxDocumentBytes + 1),
      );
      const result = cli(
        'batch',
        '--graphs',
        path,
        '--seeds',
        '101',
        '--compact',
      );
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout) as {
        results: { error: { code: string } }[];
      };
      expect(parsed.results[0]?.error.code).toBe('graph_too_large');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects unknown levels on every level-specific command', () => {
    const graph = 'fixtures/parcel/family-sql-indexed.json';
    const cases = [
      ['describe', '--level', 'definitely-not-a-level'],
      ['schema', '--level', 'definitely-not-a-level', '--kind', 'result'],
      ['example', '--level', 'definitely-not-a-level'],
      ['validate', '--level', 'definitely-not-a-level', '--graph', graph],
      ['run', '--level', 'definitely-not-a-level', '--graph', graph],
      ['batch', '--level', 'definitely-not-a-level', '--graphs', graph, '--seeds', '101'],
    ];
    for (const args of cases) {
      const result = cli(...args);
      expect(result.status, args.join(' ')).toBe(1);
      const parsed = JSON.parse(result.stdout) as {
        error: { code: string };
        passed?: boolean;
      };
      expect(parsed.error.code).toBe('unsupported_level');
      expect(parsed.passed).toBeUndefined();
    }
  });

  it('runs Cold Cache through the real adapter', () => {
    const example = cli('example', '--level', 'cold-cache', '--compact');
    expect(example.status).toBe(0);
    const run = cliInput(
      example.stdout,
      'run',
      '--level',
      'cold-cache',
      '--graph',
      '-',
      '--seed',
      '101',
      '--compact',
    );
    expect(run.status).toBe(2);
    const parsed = JSON.parse(run.stdout) as {
      level: string;
      status: string;
      passed: boolean;
      meta: { graphDigest: string };
    };
    expect(parsed.level).toBe('cold-cache');
    expect(parsed.status).toBe('ok');
    expect(parsed.passed).toBe(false);
    expect(parsed.meta.graphDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('discovers and describes all supported levels', () => {
    for (const level of [
      'cold-cache',
      'parcel-pulse',
      'image-atlas',
      'live-scoreboard',
      'live-audience',
    ]) {
      const described = cli('describe', '--level', level);
      expect(described.status, level).toBe(0);
      const payload = JSON.parse(described.stdout) as {
        level: { id: string; modelVersion: string };
      };
      expect(payload.level.id).toBe(level);
      expect(payload.level.modelVersion).toBe('1.0.0');

      const schema = cli('schema', '--level', level, '--kind', 'graph');
      expect(schema.status, level).toBe(0);
      const graphSchema = JSON.parse(schema.stdout) as {
        graph: { properties: { levelId: { const: string } } };
      };
      expect(graphSchema.graph.properties.levelId.const).toBe(level);
    }
  });

  it('discovers levels and schemas as structured JSON', () => {
    const levels = cli('levels');
    expect(levels.status).toBe(0);
    const parsed = JSON.parse(levels.stdout) as {
      levels: { id: string }[];
    };
    expect(parsed.levels.map((level) => level.id)).toEqual([
      'parcel-pulse',
      'cold-cache',
      'image-atlas',
      'live-scoreboard',
      'live-audience',
      'global-cart',
    ]);

    const schema = cli('schema', '--kind', 'graph');
    expect(schema.status).toBe(0);
    const graphSchema = JSON.parse(schema.stdout) as {
      graph: { properties: { nodes: { maxItems: number } } };
    };
    expect(graphSchema.graph.properties.nodes.maxItems).toBe(32);

    const resultSchema = cli('schema', '--kind', 'result');
    expect(resultSchema.status).toBe(0);
    const result = JSON.parse(resultSchema.stdout) as {
      result: { $id: string; oneOf: unknown[] };
    };
    expect(result.result.$id).toContain('parcel-pulse-result');
    expect(result.result.oneOf).toHaveLength(3);

    const describe = cli('describe', '--level', 'parcel-pulse');
    expect(describe.status).toBe(0);
    const described = JSON.parse(describe.stdout) as {
      componentLimits: { seed: { max: number } };
      graphSchema: { type: string };
      resultSchema: { $id: string };
    };
    expect(described.componentLimits.seed.max).toBe(2_147_483_647);
    expect(described.graphSchema.type).toBe('object');
    expect(described.resultSchema.$id).toContain('parcel-pulse-result');
  });

  it('returns stable exit codes for valid, invalid and failing evaluations', () => {
    const valid = cli(
      'validate',
      '--graph',
      'fixtures/parcel/family-sql-indexed.json',
    );
    expect(valid.status).toBe(0);
    expect((JSON.parse(valid.stdout) as { ok: boolean }).ok).toBe(true);

    const invalid = cli(
      'validate',
      '--graph',
      'fixtures/parcel/fail-missing-route.json',
    );
    expect(invalid.status).toBe(1);
    expect((JSON.parse(invalid.stdout) as { ok: boolean }).ok).toBe(false);

    const pass = cli(
      'run',
      '--graph',
      'fixtures/parcel/family-kv-rollups.json',
      '--seed',
      '101',
      '--compact',
    );
    expect(pass.status).toBe(0);
    expect((JSON.parse(pass.stdout) as { passed: boolean }).passed).toBe(true);

    const fail = cli(
      'run',
      '--graph',
      'fixtures/parcel/starter.json',
      '--seed',
      '101',
      '--compact',
    );
    expect(fail.status).toBe(2);
    expect((JSON.parse(fail.stdout) as { passed: boolean }).passed).toBe(false);
  });

  it('exposes the real Live Scoreboard core with strict options and exit codes', () => {
    const described = cli('describe', '--level', 'live-scoreboard');
    expect(described.status).toBe(0);
    const description = JSON.parse(described.stdout) as {
      level: { id: string; modelVersion: string; defaultSeed: number };
      seeds: { calibration: number[]; holdout: number[] };
    };
    expect(description.level.id).toBe('live-scoreboard');
    expect(description.level.modelVersion).toBe('1.0.0');
    expect(description.level.defaultSeed).toBe(101);
    expect(description.seeds.calibration).toContain(211);
    expect(description.seeds.holdout.length).toBeGreaterThan(0);

    const catalog = cli(
      'schema',
      '--level',
      'live-scoreboard',
      '--kind',
      'catalog',
    );
    expect(catalog.status).toBe(0);
    const catalogPayload = JSON.parse(catalog.stdout) as {
      catalog: {
        pricingVersion: string;
        currency: string;
        catalog: {
          components: { sql: { sizes: { large: { hourlyUsd: number } } } };
          work: { rawScanCoreMsPerRow: number };
          network: { laneGbitPerSec: number };
        };
      };
    };
    expect(catalogPayload.catalog.pricingVersion).toBe(
      'scoreboard-catalog-v1',
    );
    expect(catalogPayload.catalog.currency).toBe('USD');
    expect(
      catalogPayload.catalog.catalog.components.sql.sizes.large.hourlyUsd,
    ).toBe(1.28);
    expect(
      catalogPayload.catalog.catalog.work.rawScanCoreMsPerRow,
    ).toBe(0.0002);
    expect(
      catalogPayload.catalog.catalog.network.laneGbitPerSec,
    ).toBe(1);

    const starter = cli('example', '--level', 'live-scoreboard');
    expect(starter.status).toBe(0);
    const starterGraph = JSON.parse(starter.stdout) as {
      levelId: string;
      nodes: { kind: string }[];
      edges: unknown[];
    };
    expect(starterGraph.levelId).toBe('live-scoreboard');
    expect(starterGraph.nodes.map((node) => node.kind)).toEqual(['users']);
    expect(starterGraph.edges).toEqual([]);

    const aggregate = cli(
      'example',
      '--level',
      'live-scoreboard',
      '--family',
      'family-aggregate',
    );
    expect(aggregate.status).toBe(0);
    expect(
      (JSON.parse(aggregate.stdout) as { nodes: { kind: string }[] }).nodes.map(
        (node) => node.kind,
      ),
    ).toEqual(['users', 'app', 'sql']);

    const invalid = cli(
      'validate',
      '--level',
      'live-scoreboard',
      '--graph',
      'fixtures/scoreboard/invalid-missing-sql.json',
    );
    expect(invalid.status).toBe(1);
    const invalidPayload = JSON.parse(invalid.stdout) as {
      ok: boolean;
      issues: { severity: string }[];
    };
    expect(invalidPayload.ok).toBe(false);
    expect(
      invalidPayload.issues.some((issue) => issue.severity === 'error'),
    ).toBe(true);

    const pass = cli(
      'run',
      '--level',
      'live-scoreboard',
      '--graph',
      'fixtures/scoreboard/family-aggregate.json',
      '--seed',
      '101',
      '--compact-result',
      '--compact',
    );
    expect(pass.status).toBe(0);
    const passPayload = JSON.parse(pass.stdout) as {
      summary: {
        status: string;
        passed: boolean;
        seed: number;
        failedGates: unknown[];
        cost: { scoreUsd: number };
      };
    };
    expect(passPayload.summary.status).toBe('complete');
    expect(passPayload.summary.passed).toBe(true);
    expect(passPayload.summary.seed).toBe(101);
    expect(passPayload.summary.failedGates).toEqual([]);
    expect(passPayload.summary.cost.scoreUsd).toBeGreaterThan(0);

    const fail = cli(
      'run',
      '--level',
      'live-scoreboard',
      '--graph',
      'fixtures/scoreboard/fail-small-scan.json',
      '--seed',
      '101',
      '--compact-result',
      '--compact',
    );
    expect(fail.status).toBe(2);
    const failPayload = JSON.parse(fail.stdout) as {
      summary: { passed: boolean; failedGates: { id: string }[] };
    };
    expect(failPayload.summary.passed).toBe(false);
    expect(
      failPayload.summary.failedGates.some((gate) => gate.id.includes('availability')),
    ).toBe(true);

    const invalidRun = cli(
      'run',
      '--level',
      'live-scoreboard',
      '--graph',
      'fixtures/scoreboard/invalid-ambiguous.json',
      '--seed',
      '101',
      '--compact',
    );
    expect(invalidRun.status).toBe(1);

    const unsupported = cli(
      'run',
      '--level',
      'live-scoreboard',
      '--graph',
      'fixtures/scoreboard/family-aggregate.json',
      '--seed',
      '101',
      '--horizon',
      '5',
    );
    expect(unsupported.status).toBe(1);
    expect(unsupported.stdout).toContain('unsupported_option');
  }, 60_000);

  it('enforces level-specific options on validate and rejects empty scenario lists', () => {
    const scoreboardValidateHorizon = cli(
      'validate',
      '--level',
      'live-scoreboard',
      '--graph',
      'fixtures/scoreboard/family-aggregate.json',
      '--horizon',
      '5',
    );
    expect(scoreboardValidateHorizon.status).toBe(1);
    expect(scoreboardValidateHorizon.stdout).toContain('unsupported_option');

    const scoreboardValidateScenario = cli(
      'validate',
      '--level',
      'live-scoreboard',
      '--graph',
      'fixtures/scoreboard/family-aggregate.json',
      '--scenario',
      'normal',
    );
    expect(scoreboardValidateScenario.status).toBe(1);
    expect(scoreboardValidateScenario.stdout).toContain('unsupported_option');

    for (const option of [
      ['--horizon', '5'],
      ['--scenario', 'normal'],
    ]) {
      const audienceValidate = cli(
        'validate',
        '--level',
        'live-audience',
        '--graph',
        'fixtures/audience/starter.json',
        ...option,
      );
      expect(audienceValidate.status, option.join(' ')).toBe(1);
      expect(audienceValidate.stdout).toContain('unsupported_option');
    }

    for (const scenario of [',', ' , ', ',,']) {
      const empty = cli(
        'run',
        '--level',
        'live-scoreboard',
        '--graph',
        'fixtures/scoreboard/family-aggregate.json',
        '--scenario',
        scenario,
      );
      expect(empty.status, scenario).toBe(1);
      expect(empty.stdout, scenario).toContain('missing_value');
    }

    const emptyValidate = cli(
      'validate',
      '--level',
      'live-scoreboard',
      '--graph',
      'fixtures/scoreboard/family-aggregate.json',
      '--scenario',
      ',',
    );
    expect(emptyValidate.status).toBe(1);
    expect(emptyValidate.stdout).toContain('missing_value');

    // Supported legacy option/level pairs keep working for validate.
    const parcelHorizon = cli(
      'validate',
      '--level',
      'parcel-pulse',
      '--graph',
      'fixtures/parcel/family-sql-indexed.json',
      '--horizon',
      '5',
    );
    expect(parcelHorizon.status).toBe(0);

    const imageScenario = cli(
      'validate',
      '--level',
      'image-atlas',
      '--graph',
      'fixtures/images/starter.json',
      '--scenario',
      'normal',
    );
    expect(imageScenario.status).toBe(0);
  }, 60_000);

  it('bounds batch work and keeps each item structured', () => {
    const batch = cli(
      'batch',
      '--graphs',
      'fixtures/parcel/family-sql-indexed.json,fixtures/parcel/family-kv-rollups.json',
      '--seeds',
      '101,211',
      '--compact',
    );
    expect(batch.status).toBe(0);
    const parsed = JSON.parse(batch.stdout) as {
      summary: { total: number; passed: number };
      results: unknown[];
    };
    expect(parsed.summary.total).toBe(4);
    expect(parsed.summary.passed).toBe(4);
    expect(parsed.results).toHaveLength(4);

    const tooMany = cli(
      'batch',
      '--graphs',
      Array.from({ length: 33 }, () => 'fixtures/parcel/starter.json').join(','),
      '--seeds',
      '101',
    );
    expect(tooMany.status).toBe(1);
  }, 30_000);
});
