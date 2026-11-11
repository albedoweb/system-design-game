import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  SCOREBOARD_LEVEL,
  evaluateScoreboard,
  parseScoreboardEvaluation,
  type ScoreboardEvaluation,
  type ScoreboardGraph,
} from '../src/scoreboard';

/**
 * Live Scoreboard calibration matrix.
 *
 * Run with Node 24:
 *   npm run scoreboard:calibrate
 *   npm run scoreboard:calibrate -- --out=../tasks/reports/S100/calibration-matrix.json
 *
 * The report is bounded to aggregates: status, gates, percentiles, cost and
 * runtime. It never prints per-request logs or full result payloads.
 */

interface Fixture {
  readonly name: string;
  readonly path: string;
  readonly graph: ScoreboardGraph;
}

export interface CalibrationCase {
  readonly family: string;
  readonly seed: number;
  readonly fixture: string;
  readonly status: ScoreboardEvaluation['status'];
  readonly passed: boolean;
  readonly failedGates: readonly string[];
  readonly readAvailabilityWhole: number | null;
  readonly readAvailabilityPeak: number | null;
  readonly readP95Whole: number | null;
  readonly readP95Peak: number | null;
  readonly writeAvailabilityWhole: number | null;
  readonly writeP95Whole: number | null;
  readonly staleReads: number;
  readonly maxFreshnessLagMs: number;
  readonly correctnessValid: boolean | null;
  readonly actualCostUsd: number | null;
  readonly hourlyUsd: number | null;
  readonly billedBytes: number | null;
  readonly runtimeMs: number;
  readonly resultBytes: number;
  readonly resultParses: boolean;
}

export interface CalibrationReport {
  readonly generatedBy: string;
  readonly node: string;
  readonly seeds: { calibration: readonly number[]; holdout: readonly number[] };
  readonly cases: readonly CalibrationCase[];
  readonly checks: readonly {
    readonly id: string;
    readonly passed: boolean;
    readonly detail: string;
  }[];
  readonly benchmark: {
    readonly singleRunMs: number;
    readonly matrixMs: number;
    readonly heapUsedMb: number;
    readonly resultBytes: number;
    readonly maxSeriesPoints: number;
    readonly maxTrafficFrames: number;
  };
  readonly conclusion: {
    readonly allFamiliesPass: boolean;
    readonly costOrderConfirmed: boolean;
    readonly failSmallScanFails: boolean;
    readonly failStaleCacheFails: boolean;
    readonly invalidGraphsRejected: boolean;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '../fixtures/scoreboard');

function readFixture(name: string): Fixture {
  const path = resolve(fixturesDir, `${name}.json`);
  return {
    name,
    path,
    graph: JSON.parse(readFileSync(path, 'utf8')) as ScoreboardGraph,
  };
}

const FAMILIES: { family: string; fixture: string }[] = [
  { family: 'fullscan', fixture: 'family-fullscan' },
  { family: 'cache', fixture: 'family-cache' },
  { family: 'aggregate', fixture: 'family-aggregate' },
];

const FAILURES = [
  { family: 'fail-small-scan', fixture: 'fail-small-scan' },
  { family: 'fail-stale-cache', fixture: 'fail-stale-cache' },
  { family: 'invalid-missing-sql', fixture: 'invalid-missing-sql' },
  { family: 'invalid-ambiguous', fixture: 'invalid-ambiguous' },
];

function summarize(
  family: string,
  fixture: Fixture,
  seed: number,
  result: ScoreboardEvaluation,
  runtimeMs: number,
): CalibrationCase {
  const parsed = parseScoreboardEvaluation(result);
  return {
    family,
    seed,
    fixture: fixture.name,
    status: result.status,
    passed: result.passed,
    failedGates: result.gates.filter((gate) => !gate.passed).map((gate) => gate.id),
    readAvailabilityWhole: result.operations?.read.availability ?? null,
    readAvailabilityPeak: result.operations?.peak.read.availability ?? null,
    readP95Whole: result.operations?.read.latency.p95Ms ?? null,
    readP95Peak: result.operations?.peak.read.latency.p95Ms ?? null,
    writeAvailabilityWhole: result.operations?.write.availability ?? null,
    writeP95Whole: result.operations?.write.latency.p95Ms ?? null,
    staleReads: result.freshness?.staleReads ?? 0,
    maxFreshnessLagMs: result.freshness?.maxLagMs ?? 0,
    correctnessValid: result.correctness?.valid ?? null,
    actualCostUsd: result.cost?.actualUsd ?? null,
    hourlyUsd: result.cost?.hourlyUsd ?? null,
    billedBytes: result.cost?.billedBytes ?? null,
    runtimeMs,
    resultBytes: JSON.stringify(result).length,
    resultParses: parsed.ok,
  };
}

function runCase(
  family: string,
  fixture: Fixture,
  seed: number,
): CalibrationCase {
  const start = performance.now();
  const result = evaluateScoreboard(fixture.graph, { seed });
  return summarize(family, fixture, seed, result, performance.now() - start);
}

export function calibrate(): CalibrationReport {
  const startMatrix = performance.now();
  const seeds = [
    ...SCOREBOARD_LEVEL.calibrationSeeds,
    ...SCOREBOARD_LEVEL.holdoutSeeds,
  ];
  const fixtures = new Map<string, Fixture>();
  for (const item of [...FAMILIES, ...FAILURES]) {
    fixtures.set(item.fixture, readFixture(item.fixture));
  }

  const cases: CalibrationCase[] = [];
  for (const item of FAMILIES) {
    const fixture = fixtures.get(item.fixture);
    if (fixture === undefined) {
      continue;
    }
    for (const seed of seeds) {
      cases.push(runCase(item.family, fixture, seed));
    }
  }
  for (const item of FAILURES) {
    const fixture = fixtures.get(item.fixture);
    if (fixture === undefined) {
      continue;
    }
    for (const seed of [101, 607]) {
      cases.push(runCase(item.family, fixture, seed));
    }
  }

  const familyCases = (family: string) =>
    cases.filter((item) => item.family === family);
  const allFamiliesPass = FAMILIES.every((item) =>
    familyCases(item.family).every(
      (result) => result.status === 'complete' && result.passed && result.resultParses,
    ),
  );
  const costOrderConfirmed = seeds.every((seed) => {
    const aggregate = familyCases('aggregate').find((item) => item.seed === seed);
    const cache = familyCases('cache').find((item) => item.seed === seed);
    const full = familyCases('fullscan').find((item) => item.seed === seed);
    if (
      aggregate?.actualCostUsd == null ||
      cache?.actualCostUsd == null ||
      full?.actualCostUsd == null
    ) {
      return false;
    }
    return (
      aggregate.actualCostUsd < cache.actualCostUsd &&
      cache.actualCostUsd < full.actualCostUsd
    );
  });
  const failSmall = familyCases('fail-small-scan');
  const failStale = familyCases('fail-stale-cache');
  const invalid = [
    ...familyCases('invalid-missing-sql'),
    ...familyCases('invalid-ambiguous'),
  ];
  const failSmallScanFails = failSmall.every(
    (result) =>
      result.status === 'complete' &&
      !result.passed &&
      (result.readAvailabilityWhole ?? 1) < SCOREBOARD_LEVEL.slo.availability,
  );
  const failStaleCacheFails = failStale.every(
    (result) =>
      result.status === 'complete' &&
      !result.passed &&
      result.staleReads > 0 &&
      result.failedGates.includes('freshness'),
  );
  const invalidGraphsRejected = invalid.every(
    (result) => result.status === 'invalid' && !result.passed,
  );

  const single = cases[0];
  const report: CalibrationReport = {
    generatedBy: 'scripts/scoreboard-calibrate.ts',
    node: process.version,
    seeds: {
      calibration: [...SCOREBOARD_LEVEL.calibrationSeeds],
      holdout: [...SCOREBOARD_LEVEL.holdoutSeeds],
    },
    cases,
    checks: [
      {
        id: 'families-pass',
        passed: allFamiliesPass,
        detail:
          'fullscan, cache and aggregate each complete, pass all required gates and parse as public results for every calibration and holdout seed.',
      },
      {
        id: 'cost-order',
        passed: costOrderConfirmed,
        detail: 'aggregate < cache < fullscan actual run cost for every seed.',
      },
      {
        id: 'small-scan-fails',
        passed: failSmallScanFails,
        detail:
          'Small raw-scan database fails availability visibly even with the same application pool.',
      },
      {
        id: 'stale-cache-fails',
        passed: failStaleCacheFails,
        detail: 'TTL 15 cache fails freshness with real stale reads.',
      },
      {
        id: 'invalid-graphs-rejected',
        passed: invalidGraphsRejected,
        detail: 'Missing-SQL and ambiguous-link graphs are invalid, never evaluated.',
      },
    ],
    benchmark: {
      singleRunMs: single?.runtimeMs ?? 0,
      matrixMs: performance.now() - startMatrix,
      heapUsedMb: process.memoryUsage().heapUsed / 1_000_000,
      resultBytes: Math.max(...cases.map((item) => item.resultBytes)),
      maxSeriesPoints: 90,
      maxTrafficFrames: 90,
    },
    conclusion: {
      allFamiliesPass,
      costOrderConfirmed,
      failSmallScanFails,
      failStaleCacheFails,
      invalidGraphsRejected,
    },
  };
  return report;
}

function main(): void {
  const outArg = process.argv.find((arg) => arg.startsWith('--out='));
  const report = calibrate();
  for (const check of report.checks) {
    console.log(
      `${check.passed ? 'PASS' : 'FAIL'} ${check.id}: ${check.detail}`,
    );
  }
  console.log(
    `matrix: ${report.cases.length} cases, ${report.benchmark.matrixMs.toFixed(
      0,
    )} ms, max result ${(report.benchmark.resultBytes / 1_024).toFixed(1)} KiB`,
  );
  for (const item of report.cases) {
    console.log(
      [
        item.family.padEnd(18),
        String(item.seed).padStart(3),
        item.status.padEnd(8),
        item.passed ? 'PASS' : 'FAIL',
        `cost=$${item.actualCostUsd?.toFixed(6) ?? 'n/a'}`,
        `read=${(item.readAvailabilityWhole ?? 0).toFixed(4)}`,
        `p95=${item.readP95Whole?.toFixed(1) ?? 'n/a'}`,
        `stale=${item.staleReads}`,
        `lag=${item.maxFreshnessLagMs.toFixed(0)}ms`,
        `run=${item.runtimeMs.toFixed(0)}ms`,
        item.failedGates.length > 0 ? `failed=${item.failedGates.join(',')}` : '',
      ]
        .filter((part) => part.length > 0)
        .join(' '),
    );
  }
  if (outArg !== undefined) {
    const target = resolve(process.cwd(), outArg.slice('--out='.length));
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${target}`);
  }
  const failed = report.checks.filter((check) => !check.passed);
  if (failed.length > 0) {
    console.error(`calibration failed: ${failed.map((check) => check.id).join(', ')}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  main();
}
