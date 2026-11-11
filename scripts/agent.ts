#!/usr/bin/env node
/**
 * Agent balance CLI for all six levels. Structured JSON by default, bounded
 * input, no code execution. Every command dispatches through the shared
 * registry, so the CLI sees exactly the same cores as the browser/API.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUDIENCE_LEVEL,
  type AudienceEvaluation,
} from '../src/audience/index';
import {
  CART_DEFAULT_SEED,
  CART_REQUIRED_CASES,
  type CartEvaluation,
} from '../src/cart/index';
import {
  IMAGE_LEVEL,
  IMAGE_REQUIRED_SCENARIOS,
  IMAGE_SCENARIOS,
  type ImageEvaluation,
  type ImageScenarioName,
} from '../src/images/index';
import {
  PARCEL_LEVEL,
  type ParcelEvaluation,
  type ParcelHorizonYears,
  type ParcelIssue,
} from '../src/parcel/index';
import {
  SCOREBOARD_LEVEL,
  type ScoreboardEvaluation,
} from '../src/scoreboard/index';
import {
  DEFAULT_ENGINE_LEVEL_ID,
  ENGINE_SEED_MAX,
  createEngineRegistry,
  type EngineEvaluationResult,
  type EngineLevelEntry,
} from '../src/simulation/registry';

const EXIT_PASS = 0;
const EXIT_USAGE = 1;
const EXIT_FAILED = 2;
const EXIT_INTERNAL = 3;

const MAX_GRAPHS_PER_BATCH = 32;
const MAX_SEEDS_PER_BATCH = 16;
const MAX_DOCUMENT_BYTES = 1_000_000;

/**
 * Unwind instead of `process.exit` so stdout can drain fully through a pipe.
 * The top-level wrapper converts this into `process.exitCode`.
 */
class CliExit extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`CLI exit ${exitCode}`);
    this.name = 'CliExit';
    this.exitCode = exitCode;
  }
}

function exitWith(exitCode: number): never {
  throw new CliExit(exitCode);
}

const registry = createEngineRegistry();

type Command =
  | 'levels'
  | 'describe'
  | 'schema'
  | 'example'
  | 'validate'
  | 'run'
  | 'batch'
  | 'help';

interface ParsedArgs {
  command: Command;
  level: string;
  graph: string | null;
  graphs: string[];
  seed: number | null;
  seeds: number[];
  horizon: ParcelHorizonYears | null;
  scenarios: ImageScenarioName[];
  family: string;
  kind: string | null;
  pretty: boolean;
  /** Additive agent-friendly summary for `run`; full result stays the default. */
  compactResult: boolean;
  help: boolean;
}

const PARCEL_FIXTURES: Record<string, string> = {
  starter: 'starter.json',
  sql: 'family-sql-indexed.json',
  'sql-rollups': 'family-sql-rollups.json',
  kv: 'family-kv-rollups.json',
  hybrid: 'family-hybrid-analytics.json',
  'sql-indexed': 'family-sql-indexed.json',
  'kv-rollups': 'family-kv-rollups.json',
  'hybrid-analytics': 'family-hybrid-analytics.json',
  'fail-missing-route': 'fail-missing-route.json',
  'fail-missing-index': 'fail-missing-index.json',
  'fail-capacity': 'fail-capacity.json',
  'fail-freshness': 'fail-freshness.json',
  'fail-small-hardware': 'fail-small-hardware.json',
  'fail-overbudget': 'fail-overbudget.json',
};

/** Real Image Atlas fixtures shipped with the level contract. */
const IMAGE_FIXTURES: Record<string, string> = {
  starter: 'starter.json',
  'directory-direct': 'directory-direct.json',
  'cache-proxy': 'cache-proxy.json',
  'fail-storage': 'fail-storage.json',
  'fail-invalid-fixed-node': 'fail-invalid-fixed-node.json',
};

/**
 * Live Scoreboard fixtures owned by the frozen calibration commit. Names map to
 * real shipped files; `starter` is served from the core's Users-only graph.
 */
const SCOREBOARD_FIXTURES: Record<string, string> = {
  'family-fullscan': 'family-fullscan.json',
  'family-cache': 'family-cache.json',
  'family-aggregate': 'family-aggregate.json',
  'fail-small-scan': 'fail-small-scan.json',
  'fail-stale-cache': 'fail-stale-cache.json',
  'invalid-missing-sql': 'invalid-missing-sql.json',
  'invalid-ambiguous': 'invalid-ambiguous.json',
};

/**
 * Live Audience fixtures owned by the frozen contract commit. Names map to real
 * shipped files; `starter` is served from the core's Users-only graph.
 */
const AUDIENCE_FIXTURES: Record<string, string> = {
  'family-query-large': 'family-query-large.json',
  'family-cache-query': 'family-cache-query.json',
  'family-projection': 'family-projection.json',
  'fail-single-app': 'fail-single-app.json',
  'fail-direct-no-lb': 'fail-direct-no-lb.json',
  'fail-small-query': 'fail-small-query.json',
  'fail-stale-ttl': 'fail-stale-ttl.json',
  'invalid-projection-without-worker': 'invalid-projection-without-worker.json',
  'invalid-cross-level': 'invalid-cross-level.json',
  'invalid-unknown-config': 'invalid-unknown-config.json',
  'invalid-both-routes': 'invalid-both-routes.json',
  'invalid-cycle': 'invalid-cycle.json',
  'invalid-duplicate-app': 'invalid-duplicate-app.json',
  'invalid-dangling-edge': 'invalid-dangling-edge.json',
  'invalid-ambiguous-link': 'invalid-ambiguous-link.json',
};

function usage(): string {
  return [
    'Agent balance CLI for Cold Cache, Parcel Pulse, Image Atlas, Live Scoreboard, Live Audience and Global Cart',
    '',
    'Usage:',
    '  npm run --silent agent -- levels',
    '  npm run --silent agent -- describe --level parcel-pulse',
    '  npm run --silent agent -- schema [--level ID] [--kind graph|catalog|level|describe|result]',
    '  npm run --silent agent -- example [--level ID] [--family NAME]',
    '  npm run --silent agent -- validate --graph FILE|- [--level ID]',
    '  npm run --silent agent -- run --graph FILE|- [--level ID] [--seed N]',
    '      [--horizon 1|5]        Parcel Pulse only',
    '      [--scenario NAME,...]  Image Atlas exploratory only',
    '  npm run --silent agent -- batch --graphs FILE[,FILE...] --seeds N[,N...]',
    '',
    'Levels:',
    '  parcel-pulse     default; both mandatory horizons for an overall pass',
    '  cold-cache       the original app/cache/database level',
    '  image-atlas      seven mandatory qualification cases per seed',
    '  live-scoreboard  one 90 s voting run; whole-run and peak gates',
    '  live-audience    normal, peak and one fault case per Application instance',
    '  global-cart      six mandatory cases; regional cart service under a credit budget',
    '',
    'Options:',
    '  --graph FILE|-      Graph JSON; "-" reads stdin',
    '  --graphs LIST       Comma-separated graph files (batch)',
    '  --seed N            Integer seed; level-specific range is enforced',
    '  --seeds LIST        Comma-separated seeds (batch)',
    '  --horizon 1|5       Parcel investigation only; never a global pass',
    `  --scenario LIST     Image exploratory cases: ${IMAGE_REQUIRED_SCENARIOS.join(', ')}`,
    '  --level ID          parcel-pulse (default), cold-cache, image-atlas,',
    '                      live-scoreboard, live-audience or global-cart.',
    '                      Live Scoreboard, Live Audience and Global Cart',
    '                      accept neither --horizon nor --scenario.',
    '  --pretty            Pretty JSON (default)',
    '  --compact           Compact JSON',
    '  --compact-result    run: decision-useful summary instead of the full result',
    '',
    'Exit codes: 0 pass/success, 1 usage or invalid input, 2 evaluation ran but failed, 3 runtime incomplete or internal error.',
  ].join('\n');
}

function failWith(code: string, message: string, exitCode: number): never {
  process.stderr.write(`${message}\n`);
  process.stdout.write(
    `${JSON.stringify({ error: { code, message } }, null, 2)}\n`,
  );
  exitWith(exitCode);
}

function fail(code: string, message: string): never {
  failWith(code, message, EXIT_USAGE);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: 'help',
    level: DEFAULT_ENGINE_LEVEL_ID,
    graph: null,
    graphs: [],
    seed: null,
    seeds: [],
    horizon: null,
    scenarios: [],
    family: 'starter',
    kind: null,
    pretty: true,
    compactResult: false,
    help: false,
  };
  const command = argv[0];
  if (
    command === undefined ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    args.help = true;
    return args;
  }
  if (
    command !== 'levels' &&
    command !== 'describe' &&
    command !== 'schema' &&
    command !== 'example' &&
    command !== 'validate' &&
    command !== 'run' &&
    command !== 'batch'
  ) {
    fail('unknown_command', `Unknown command "${command}". Run with --help.`);
  }
  args.command = command;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--pretty':
        args.pretty = true;
        break;
      case '--compact':
        args.pretty = false;
        break;
      case '--compact-result':
        args.compactResult = true;
        break;
      case '--level': {
        const value = argv[index + 1];
        if (!value) {
          fail('missing_value', '--level requires a value.');
        }
        args.level = value;
        index += 1;
        break;
      }
      case '--graph': {
        const value = argv[index + 1];
        if (!value) {
          fail('missing_value', '--graph requires a file path or "-".');
        }
        args.graph = value;
        index += 1;
        break;
      }
      case '--graphs': {
        const value = argv[index + 1];
        if (!value) {
          fail('missing_value', '--graphs requires a comma-separated list.');
        }
        args.graphs.push(
          ...value
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0),
        );
        index += 1;
        break;
      }
      case '--seed': {
        const value = argv[index + 1];
        if (!value) {
          fail('missing_value', '--seed requires a value.');
        }
        args.seed = parseSeed(value);
        index += 1;
        break;
      }
      case '--seeds': {
        const value = argv[index + 1];
        if (!value) {
          fail('missing_value', '--seeds requires a comma-separated list.');
        }
        args.seeds.push(
          ...value
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
            .map(parseSeed),
        );
        index += 1;
        break;
      }
      case '--horizon': {
        const value = argv[index + 1];
        if (value !== '1' && value !== '5') {
          fail('invalid_horizon', '--horizon must be 1 or 5.');
        }
        args.horizon = value === '1' ? 1 : 5;
        index += 1;
        break;
      }
      case '--scenario':
      case '--scenarios': {
        const value = argv[index + 1];
        if (!value) {
          fail('missing_value', `${token} requires a comma-separated list.`);
        }
        const requested = value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        // An explicitly empty list must be a usage error. Collapsing it to
        // "option absent" would bypass the level-specific option guard.
        if (requested.length === 0) {
          fail(
            'missing_value',
            `${token} requires at least one scenario name.`,
          );
        }
        for (const name of requested) {
          if (!IMAGE_SCENARIOS.includes(name as ImageScenarioName)) {
            fail(
              'unknown_scenario',
              `Unknown scenario "${name}". Use one of: ${IMAGE_SCENARIOS.join(', ')}.`,
            );
          }
          args.scenarios.push(name as ImageScenarioName);
        }
        index += 1;
        break;
      }
      case '--family': {
        const value = argv[index + 1];
        if (!value) {
          fail('missing_value', '--family requires a value.');
        }
        args.family = value;
        index += 1;
        break;
      }
      case '--kind': {
        const value = argv[index + 1];
        if (!value) {
          fail('missing_value', '--kind requires a value.');
        }
        args.kind = value;
        index += 1;
        break;
      }
      default:
        fail('unknown_option', `Unknown option "${token}". Run with --help.`);
    }
  }
  return args;
}

function parseSeed(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    fail('invalid_seed', `Seed "${value}" is not a non-negative integer.`);
  }
  const seed = Number(value);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > ENGINE_SEED_MAX) {
    fail(
      'invalid_seed',
      `Seed must be in 0..${ENGINE_SEED_MAX}.`,
    );
  }
  return seed;
}

function levelEntry(args: ParsedArgs): EngineLevelEntry {
  const entry = registry.resolve(args.level);
  if (entry === null) {
    fail(
      'unsupported_level',
      `Unknown level "${args.level}". Registered levels: ${registry
        .levels()
        .map((level) => level.id)
        .join(', ')}.`,
    );
  }
  return entry;
}

function checkedSeed(entry: EngineLevelEntry, seed: number): number {
  const { min, max } = entry.descriptor.seed;
  if (!Number.isInteger(seed) || seed < min || seed > max) {
    fail(
      'invalid_seed',
      `Seed for ${entry.descriptor.id} must be in ${min}..${max}.`,
    );
  }
  return seed;
}

function requireParcelOnly(entry: EngineLevelEntry, option: string): void {
  if (entry.descriptor.id !== 'parcel-pulse') {
    fail(
      'unsupported_option',
      `${option} is supported only for parcel-pulse, not ${entry.descriptor.id}.`,
    );
  }
}

function requireImageOnly(entry: EngineLevelEntry, option: string): void {
  if (entry.descriptor.id !== 'image-atlas') {
    fail(
      'unsupported_option',
      `${option} is supported only for image-atlas, not ${entry.descriptor.id}.`,
    );
  }
}

/**
 * One strict option boundary for every level-specific command. `validate`
 * must not silently accept a run-only option that `run`/`batch` would reject.
 */
function requireSupportedOptions(
  entry: EngineLevelEntry,
  args: ParsedArgs,
): void {
  if (args.horizon !== null) {
    requireParcelOnly(entry, '--horizon');
  }
  if (args.scenarios.length > 0) {
    requireImageOnly(entry, '--scenario');
  }
}

type BoundedRead =
  | { readonly ok: true; readonly text: string; readonly label: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Shared bounded reader for file paths, stdin and batch items. It never reads
 * more than maxDocumentBytes + 1 bytes, so an oversized input cannot allocate
 * an unbounded string before the limit is enforced.
 */
function readBounded(path: string): BoundedRead {
  const label = path === '-' ? '<stdin>' : path;
  const limit = MAX_DOCUMENT_BYTES;
  const usesStdin = path === '-';
  let descriptor: number;
  try {
    descriptor = usesStdin ? 0 : openSync(resolve(path), 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        code: 'graph_not_found',
        message: `Graph file not found: ${path}`,
      };
    }
    return {
      ok: false,
      code: 'graph_read_error',
      message: `Could not open graph: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    if (!usesStdin) {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) {
        return {
          ok: false,
          code: 'graph_not_file',
          message: `Graph path is not a file: ${path}`,
        };
      }
      if (stat.size > limit) {
        return {
          ok: false,
          code: 'graph_too_large',
          message: `Graph exceeds ${limit} bytes.`,
        };
      }
    }
    for (;;) {
      const remaining = limit + 1 - total;
      if (remaining <= 0) {
        break;
      }
      const chunk = Buffer.alloc(Math.min(65_536, remaining));
      const bytes = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytes <= 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytes));
      total += bytes;
      if (total > limit) {
        return {
          ok: false,
          code: 'graph_too_large',
          message: `Graph exceeds ${limit} bytes.`,
        };
      }
    }
  } catch (error) {
    return {
      ok: false,
      code: 'graph_read_error',
      message: `Could not read graph: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    if (!usesStdin) {
      closeSync(descriptor);
    }
  }
  return {
    ok: true,
    text: Buffer.concat(chunks, total).toString('utf8'),
    label,
  };
}

function readDocument(path: string): { text: string; label: string } {
  const result = readBounded(path);
  if (!result.ok) {
    fail(result.code, result.message);
  }
  return { text: result.text, label: result.label };
}

function parseDocument(path: string): unknown {
  const { text, label } = readDocument(path);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    fail(
      'invalid_json',
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseBatchDocument(
  path: string,
): { ok: true; document: unknown } | { ok: false; code: string; message: string } {
  const read = readBounded(path);
  if (!read.ok) {
    return { ok: false, code: read.code, message: read.message };
  }
  try {
    return { ok: true, document: JSON.parse(read.text) as unknown };
  } catch (error) {
    return {
      ok: false,
      code: 'invalid_json',
      message: `${read.label}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function output(value: unknown, pretty: boolean): void {
  process.stdout.write(
    `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`,
  );
}

function errorIssues(issues: readonly (ParcelIssue | { severity?: string })[]) {
  return issues.filter((issue) => (issue.severity ?? 'error') === 'error');
}

function compactParcel(evaluation: ParcelEvaluation): unknown {
  if (evaluation.status !== 'ok') {
    return {
      status: evaluation.status,
      passed: false,
      graphDigest: evaluation.meta.graphDigest,
      error:
        evaluation.status === 'error'
          ? evaluation.error
          : undefined,
      issues: evaluation.issues,
    };
  }
  return {
    status: evaluation.status,
    passed: evaluation.passed,
    graphDigest: evaluation.meta.graphDigest,
    seed: evaluation.meta.seed,
    cost: {
      monthlyUsd: evaluation.cost.monthlyUsd,
      fiveYearTcoUsd: evaluation.cost.fiveYearTcoUsd,
      replicationFactor: evaluation.cost.replicationFactor,
      withinBudget: evaluation.cost.withinBudget,
    },
    horizons: evaluation.horizons.map((horizon) => ({
      horizonYears: horizon.horizonYears,
      passed: horizon.passed,
      checksFailed: horizon.checks
        .filter((check) => check.severity === 'required' && !check.passed)
        .map((check) => check.id),
      operations: Object.fromEntries(
        Object.entries(horizon.operations).map(([operation, metrics]) => [
          operation,
          {
            availability: metrics.availability,
            p95Ms: metrics.successP95Ms,
            success: metrics.counts.success,
            offered: metrics.counts.offered,
            timedOut: metrics.counts.timedOut,
            rejected: metrics.counts.rejected,
            missedData: metrics.counts.missedData,
            stale: metrics.counts.stale,
            freshnessMaxMs: metrics.freshnessMaxMs,
          },
        ]),
      ),
      capacity: {
        usedTb: horizon.capacity.totalUsedTb,
        provisionedTb: horizon.capacity.totalProvisionedTb,
        retentionOk: horizon.capacity.retentionOk,
      },
    })),
    checksFailed: evaluation.checks
      .filter((check) => check.severity === 'required' && !check.passed)
      .map((check) => check.id),
  };
}

function compactImage(evaluation: ImageEvaluation): unknown {
  const failedReasons: string[] = [];
  if (evaluation.status === 'incomplete') {
    failedReasons.push(evaluation.incompleteReason.code);
  }
  return {
    status: evaluation.status,
    passed: evaluation.passed,
    graphDigest: evaluation.meta.graphDigest,
    seed: evaluation.meta.seed,
    qualification: evaluation.meta.qualification,
    requestedScenarios: evaluation.meta.requestedScenarios,
    checksFailed: evaluation.checks
      .filter((check) => check.severity === 'required' && !check.passed)
      .map((check) => check.id),
    scenarios: evaluation.scenarios.map((scenario) => ({
      name: scenario.name,
      passed: scenario.passed,
      checksFailed: scenario.checks
        .filter(
          (check) => check.severity === 'required' && !check.passed,
        )
        .map((check) => check.id),
    })),
    ...(evaluation.status === 'incomplete'
      ? { incompleteReason: evaluation.incompleteReason }
      : {}),
    reasons: failedReasons,
    issues: evaluation.issues,
  };
}

function compactCold(result: Extract<EngineEvaluationResult, { levelId: 'cold-cache' }>['result']): unknown {
  return {
    status: result.status,
    passed: result.passed,
    graphDigest: result.meta.graphDigest,
    seed: result.meta.seed,
    checksFailed:
      result.result === null
        ? []
        : result.result.checks
            .filter((check) => !check.passed)
            .map((check) => check.id),
    ...(result.status === 'incomplete' ? { error: result.error } : {}),
    issues: result.issues,
  };
}

type ScoreboardOperationMetrics = NonNullable<
  ScoreboardEvaluation['operations']
>['read'];

function compactOperation(metrics: ScoreboardEvaluation['operations']) {
  if (metrics === null) {
    return null;
  }
  const summarize = (value: ScoreboardOperationMetrics) => ({
    offered: value.offered,
    succeeded: value.succeeded,
    failed: value.failed,
    rejected: value.rejected,
    timedOut: value.timedOut,
    errored: value.errored,
    pending: value.pending,
    availability: value.availability,
    p95Ms: value.latency.p95Ms,
    p99Ms: value.latency.p99Ms,
    maxMs: value.latency.maxMs,
    samples: value.latency.samples,
    insufficientSamples: value.latency.insufficientSamples,
  });
  return {
    read: summarize(metrics.read),
    write: summarize(metrics.write),
    peak: {
      read: summarize(metrics.peak.read),
      write: summarize(metrics.peak.write),
    },
  };
}

/** Compact but decision-useful Scoreboard result for agents. */
function compactScoreboard(evaluation: ScoreboardEvaluation): unknown {
  const required = evaluation.gates.filter(
    (gate) => gate.severity === 'required',
  );
  const failedGates = required
    .filter((gate) => !gate.passed)
    .map((gate) => ({
      id: gate.id,
      metric: gate.metric,
      ...(gate.operation === undefined ? {} : { operation: gate.operation }),
      ...(gate.window === undefined ? {} : { window: gate.window }),
      actual: gate.actual,
      limit: gate.limit,
      unit: gate.unit,
      sampleCount: gate.sampleCount,
    }));
  return {
    status: evaluation.status,
    passed: evaluation.passed,
    seed: evaluation.seed,
    graphDigest: evaluation.graphDigest,
    runId: evaluation.runId,
    identity: evaluation.identity,
    incompleteReasons: evaluation.incompleteReasons,
    issues: evaluation.issues,
    requiredGates: required.length,
    failedGates,
    operations: compactOperation(evaluation.operations),
    correctness:
      evaluation.correctness === null
        ? null
        : {
            valid: evaluation.correctness.valid,
            writesOffered: evaluation.correctness.writesOffered,
            writesCommitted: evaluation.correctness.writesCommitted,
            writesAcknowledged: evaluation.correctness.writesAcknowledged,
            committedUnacknowledged:
              evaluation.correctness.committedUnacknowledged,
            lostAcknowledgedVotes:
              evaluation.correctness.lostAcknowledgedVotes,
            doubleEffects: evaluation.correctness.doubleEffects,
            invalidVotes: evaluation.correctness.invalidVotes,
            finalStateMatchesReference:
              evaluation.correctness.finalStateMatchesReference,
            finalRawMatchesAggregate:
              evaluation.correctness.finalRawMatchesAggregate,
            finalVoteCount: evaluation.correctness.finalVoteCount,
          },
    freshness: evaluation.freshness,
    cost:
      evaluation.cost === null
        ? null
        : {
            hourlyUsd: evaluation.cost.hourlyUsd,
            scoreUsd: evaluation.cost.scoreUsd,
            actualUsd: evaluation.cost.actualUsd,
            rentalUsd: evaluation.cost.rentalUsd,
            bytesUsd: evaluation.cost.bytesUsd,
            billedMs: evaluation.cost.billedMs,
            billedBytes: evaluation.cost.billedBytes,
          },
    preparation: evaluation.preparation,
    window: evaluation.window,
  };
}

/** Compact but decision-useful Live Audience result for agents. */
function compactAudience(evaluation: AudienceEvaluation): unknown {
  const summarizeCase = (
    item: AudienceEvaluation['cases'][number],
  ): unknown => {
    const failedGates = item.gates
      .filter((gate) => gate.severity === 'required' && !gate.passed)
      .map((gate) => ({
        id: gate.id,
        metric: gate.metric,
        ...(gate.operation === undefined ? {} : { operation: gate.operation }),
        ...(gate.window === undefined ? {} : { window: gate.window }),
        actual: gate.actual,
        limit: gate.limit,
        unit: gate.unit,
        sampleCount: gate.sampleCount,
        message: gate.message,
      }));
    return {
      id: item.id,
      label: item.label,
      kind: item.kind,
      status: item.status,
      passed: item.passed,
      targetInstance: item.targetInstance,
      target: item.target,
      window: item.window,
      failedGates,
      operations:
        item.operations === null
          ? null
          : {
              ingest:
                item.operations.ingest.succeeded +
                '/' +
                item.operations.ingest.offered,
              read:
                item.operations.read.succeeded +
                '/' +
                item.operations.read.offered,
              critical:
                item.operations.critical === null
                  ? null
                  : {
                      ingest:
                        item.operations.critical.ingest.succeeded +
                        '/' +
                        item.operations.critical.ingest.offered,
                      read:
                        item.operations.critical.read.succeeded +
                        '/' +
                        item.operations.critical.read.offered,
                    },
            },
      correctness:
        item.correctness === null
          ? null
          : {
              valid: item.correctness.valid,
              ingestOffered: item.correctness.ingestOffered,
              ingestCommitted: item.correctness.ingestCommitted,
              ingestAcknowledged: item.correctness.ingestAcknowledged,
              lostAcknowledgedEvents:
                item.correctness.lostAcknowledgedEvents,
              duplicateLogicalEvents:
                item.correctness.duplicateLogicalEvents,
              snapshotMismatches: item.correctness.snapshotMismatches,
              expiryMismatches: item.correctness.expiryMismatches,
              finalRankingMatchesReference:
                item.correctness.finalRankingMatchesReference,
              finalActivePairs: item.correctness.finalActivePairs,
              expectedActivePairs: item.correctness.expectedActivePairs,
            },
      freshness: item.freshness,
      finalSnapshot: item.finalSnapshot,
      cost:
        item.cost === null
          ? null
          : {
              actualUsd: item.cost.actualUsd,
              rentalUsd: item.cost.rentalUsd,
              bytesUsd: item.cost.bytesUsd,
              billedMs: item.cost.billedMs,
              billedBytes: item.cost.billedBytes,
            },
      incidentTimeline: item.incidentTimeline,
    };
  };
  return {
    status: evaluation.status,
    passed: evaluation.passed,
    seed: evaluation.seed,
    graphDigest: evaluation.graphDigest,
    runId: evaluation.runId,
    identity: evaluation.identity,
    provisioned: evaluation.provisioned,
    score: evaluation.score,
    incompleteReasons: evaluation.incompleteReasons,
    issues: evaluation.issues,
    cases: evaluation.cases.map(summarizeCase),
  };
}

function compactCart(evaluation: CartEvaluation): unknown {
  return {
    levelId: evaluation.levelId,
    versions: evaluation.versions,
    graphDigest: evaluation.graphDigest,
    seed: evaluation.seed,
    requiredCases: [...evaluation.requiredCases],
    complete: evaluation.complete,
    qualified: evaluation.qualified,
    scoreCreditsPerHour: evaluation.scoreCreditsPerHour,
    issues: evaluation.issues,
    cases: evaluation.cases.map((item) => ({
      id: item.id,
      scheduled: item.scheduled,
      issued: item.issued,
      dependencyFailed: item.dependencyFailed,
      complete: item.complete,
      outcomes: item.outcomes,
      failedGates: item.gates
        .filter((gate) => !gate.pass)
        .map((gate) => ({
          code: gate.code,
          region: gate.region,
          operation: gate.operation,
          cohort: gate.cohort,
          observed: gate.observed,
          limit: gate.limit,
        })),
      cost: item.cost,
    })),
  };
}

function compact(
  outcome: EngineEvaluationResult,
): unknown {
  switch (outcome.levelId) {
    case 'cold-cache':
      return compactCold(outcome.result);
    case 'parcel-pulse':
      return compactParcel(outcome.result);
    case 'image-atlas':
      return compactImage(outcome.result);
    case 'live-scoreboard':
      return compactScoreboard(outcome.result);
    case 'live-audience':
      return compactAudience(outcome.result);
    case 'global-cart':
      return compactCart(outcome.result);
  }
}

function outcomeExit(outcome: EngineEvaluationResult): number {
  if (outcome.levelId === 'global-cart') {
    if (!outcome.result.complete) {
      return EXIT_INTERNAL;
    }
    return outcome.result.qualified ? EXIT_PASS : EXIT_FAILED;
  }
  const result = outcome.result;
  if (result.status === 'invalid') {
    return EXIT_USAGE;
  }
  if (
    result.status === 'error' ||
    result.status === 'incomplete' ||
    result.status === 'cancelled'
  ) {
    return EXIT_INTERNAL;
  }
  return result.passed ? EXIT_PASS : EXIT_FAILED;
}

function evaluate(
  args: ParsedArgs,
  entry: EngineLevelEntry,
  document: unknown,
  seed: number,
): EngineEvaluationResult {
  try {
    return registry.evaluate({
      levelId: entry.descriptor.id,
      graph: document,
      seed,
      ...(args.horizon === null ? {} : { horizonYears: args.horizon }),
      ...(args.scenarios.length === 0 ? {} : { scenarios: args.scenarios }),
    });
  } catch (error) {
    if (error instanceof Error) {
      const code = (error as { code?: string }).code;
      if (code === 'evaluator_unavailable') {
        failWith('evaluator_unavailable', error.message, EXIT_INTERNAL);
      }
      if (code === 'invalid_seed' || code === 'unsupported_option') {
        failWith(code, error.message, EXIT_USAGE);
      }
    }
    throw error;
  }
}

function commandLevels(args: ParsedArgs): void {
  const descriptors = registry.levels();
  const parcel = descriptors.find((level) => level.id === 'parcel-pulse');
  const cold = descriptors.find((level) => level.id === 'cold-cache');
  const image = descriptors.find((level) => level.id === 'image-atlas');
  const scoreboard = descriptors.find(
    (level) => level.id === 'live-scoreboard',
  );
  const audience = descriptors.find(
    (level) => level.id === 'live-audience',
  );
  const cart = descriptors.find((level) => level.id === 'global-cart');
  output(
    {
      command: 'levels',
      levels: [
        {
          id: 'parcel-pulse',
          title: parcel?.title ?? PARCEL_LEVEL.title,
          playable: true,
          engine: 'parcel-core',
          horizons: [...PARCEL_LEVEL.horizons],
          budgetMonthlyUsd: PARCEL_LEVEL.budget.monthlyUsd,
          description: parcel?.description ?? PARCEL_LEVEL.description,
        },
        {
          id: 'cold-cache',
          title: cold?.title ?? 'Cold Cache',
          playable: true,
          engine: 'cold-cache',
          modelVersion: cold?.modelVersion,
          agentAdapter: true,
          description: cold?.description,
        },
        {
          id: 'image-atlas',
          title: image?.title ?? IMAGE_LEVEL.title,
          playable: image?.availability === 'playable',
          engine: 'image-atlas',
          modelVersion: image?.modelVersion,
          scenarios: [...IMAGE_REQUIRED_SCENARIOS],
          budgetMonthlyUsd: IMAGE_LEVEL.budget.monthlyUsd,
          description: image?.description ?? IMAGE_LEVEL.description,
          ...(image?.availability === 'contract-only'
            ? {
                note: 'The Image Atlas evaluator is not available in this build; discovery and validation work, evaluation is unavailable.',
              }
            : {}),
        },
        {
          id: 'live-scoreboard',
          title: scoreboard?.title ?? SCOREBOARD_LEVEL.title,
          playable: scoreboard?.availability === 'playable',
          engine: 'live-scoreboard',
          modelVersion: scoreboard?.modelVersion,
          defaultSeed: scoreboard?.defaultSeed ?? SCOREBOARD_LEVEL.defaultSeed,
          description: scoreboard?.description ?? SCOREBOARD_LEVEL.summary,
          ...(scoreboard?.availability === 'contract-only'
            ? {
                note: 'The Live Scoreboard evaluator is not available in this build; discovery and validation work, evaluation is unavailable.',
              }
            : {}),
        },
        {
          id: 'live-audience',
          title: audience?.title ?? AUDIENCE_LEVEL.title,
          playable: audience?.availability === 'playable',
          engine: 'live-audience',
          modelVersion: audience?.modelVersion,
          defaultSeed: audience?.defaultSeed ?? AUDIENCE_LEVEL.defaultSeed,
          description: audience?.description ?? AUDIENCE_LEVEL.summary,
        },
        {
          id: 'global-cart',
          title: cart?.title ?? 'Global Cart',
          playable: cart?.availability === 'playable',
          engine: 'global-cart',
          modelVersion: cart?.modelVersion,
          pricingVersion: cart?.pricingVersion,
          profileVersion: cart?.profileVersion,
          defaultSeed: cart?.defaultSeed ?? CART_DEFAULT_SEED,
          seed: cart?.seed,
          requiredCases: [...(cart?.requiredCases ?? CART_REQUIRED_CASES)],
          description: cart?.description,
          ...(cart?.availability === 'contract-only'
            ? {
                note: 'The Global Cart evaluator is not available in this build; discovery and validation work, evaluation is unavailable.',
              }
            : {}),
        },
      ],
    },
    args.pretty,
  );
  exitWith(EXIT_PASS);
}

function commandDescribe(args: ParsedArgs): void {
  const entry = levelEntry(args);
  output({ command: 'describe', ...(entry.describe() as object) }, args.pretty);
  exitWith(EXIT_PASS);
}

function commandSchema(args: ParsedArgs): void {
  const entry = levelEntry(args);
  const kind = args.kind ?? 'all';
  if (
    kind !== 'all' &&
    kind !== 'graph' &&
    kind !== 'catalog' &&
    kind !== 'level' &&
    kind !== 'describe' &&
    kind !== 'result'
  ) {
    fail('unknown_schema_kind', `Unknown schema kind "${kind}".`);
  }
  const payload: Record<string, unknown> = { command: 'schema', kind };
  if (kind === 'all' || kind === 'graph') {
    payload.graph = entry.graphSchema();
  }
  if (kind === 'all' || kind === 'catalog') {
    payload.catalog = entry.components();
  }
  if (kind === 'all' || kind === 'level') {
    payload.level = entry.levelDefinition();
  }
  if (kind === 'all' || kind === 'describe') {
    payload.describe = entry.describe();
  }
  if (kind === 'all' || kind === 'result') {
    payload.result = entry.resultSchema();
  }
  output(payload, args.pretty);
  exitWith(EXIT_PASS);
}

function commandExample(args: ParsedArgs): void {
  const entry = levelEntry(args);
  if (args.family === 'starter') {
    output(entry.defaultGraph(), args.pretty);
    exitWith(EXIT_PASS);
  }
  if (entry.descriptor.id === 'cold-cache') {
    fail(
      'unknown_family',
      'Cold Cache examples support only "starter" in this release.',
    );
  }
  let table: Record<string, string>;
  let directory: string;
  switch (entry.descriptor.id) {
    case 'image-atlas':
      table = IMAGE_FIXTURES;
      directory = 'images';
      break;
    case 'live-scoreboard':
      table = SCOREBOARD_FIXTURES;
      directory = 'scoreboard';
      break;
    case 'live-audience':
      table = AUDIENCE_FIXTURES;
      directory = 'audience';
      break;
    default:
      table = PARCEL_FIXTURES;
      directory = 'parcel';
      break;
  }
  const file = table[args.family];
  if (!file) {
    fail(
      'unknown_family',
      `Unknown example family "${args.family}". Use one of: ${Object.keys(
        table,
      ).join(', ')}.`,
    );
  }
  const path = fileURLToPath(
    new URL(`../fixtures/${directory}/${file}`, import.meta.url),
  );
  output(parseDocument(path), args.pretty);
  exitWith(EXIT_PASS);
}

function commandValidate(args: ParsedArgs): void {
  const entry = levelEntry(args);
  requireSupportedOptions(entry, args);
  if (!args.graph) {
    fail('missing_graph', 'validate requires --graph FILE or --graph -.');
  }
  const document = parseDocument(args.graph);
  const result = registry.validate(entry.descriptor.id, document);
  const errors = errorIssues(result.issues);
  const payload = {
    command: 'validate',
    ok: result.ok && errors.length === 0,
    graphDigest: result.graphDigest,
    issues: result.issues,
  };
  output(payload, args.pretty);
  exitWith(payload.ok ? EXIT_PASS : EXIT_USAGE);
}

function commandRun(args: ParsedArgs): void {
  const entry = levelEntry(args);
  requireSupportedOptions(entry, args);
  if (!args.graph) {
    fail('missing_graph', 'run requires --graph FILE or --graph -.');
  }
  const seed = checkedSeed(
    entry,
    args.seed ?? entry.descriptor.defaultSeed,
  );
  const document = parseDocument(args.graph);
  const outcome = evaluate(args, entry, document, seed);
  output(
    args.compactResult
      ? {
          command: 'run',
          level: entry.descriptor.id,
          summary: compact(outcome),
        }
      : {
          command: 'run',
          level: entry.descriptor.id,
          ...(outcome.result as object),
        },
    args.pretty,
  );
  exitWith(outcomeExit(outcome));
}

function commandBatch(args: ParsedArgs): void {
  const entry = levelEntry(args);
  requireSupportedOptions(entry, args);
  const graphs = args.graphs.length > 0
    ? args.graphs
    : args.graph
      ? [args.graph]
      : [];
  if (graphs.length === 0) {
    fail('missing_graph', 'batch requires --graphs FILE[,FILE...].');
  }
  if (graphs.length > MAX_GRAPHS_PER_BATCH) {
    fail(
      'batch_too_large',
      `At most ${MAX_GRAPHS_PER_BATCH} graphs per batch.`,
    );
  }
  const seeds = (args.seeds.length > 0
    ? args.seeds
    : args.seed !== null
      ? [args.seed]
      : [entry.descriptor.defaultSeed]
  ).map((seed) => checkedSeed(entry, seed));
  if (seeds.length > MAX_SEEDS_PER_BATCH) {
    fail(
      'batch_too_large',
      `At most ${MAX_SEEDS_PER_BATCH} seeds per batch.`,
    );
  }
  const results: unknown[] = [];
  let passed = 0;
  let failed = 0;
  let invalid = 0;
  let errors = 0;
  for (const graphPath of graphs) {
    const loaded = parseBatchDocument(graphPath);
    if (!loaded.ok) {
      invalid += 1;
      results.push({
        graph: graphPath,
        seed: null,
        status: 'error',
        passed: false,
        error: { code: loaded.code, message: loaded.message },
      });
      continue;
    }
    for (const seed of seeds) {
      let outcome: EngineEvaluationResult;
      try {
        outcome = registry.evaluate({
          levelId: entry.descriptor.id,
          graph: loaded.document,
          seed,
          ...(args.horizon === null ? {} : { horizonYears: args.horizon }),
          ...(args.scenarios.length === 0
            ? {}
            : { scenarios: args.scenarios }),
        });
      } catch (error) {
        errors += 1;
        const code =
          error instanceof Error && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'engine_failure';
        results.push({
          graph: graphPath,
          seed,
          status: 'error',
          passed: false,
          error: {
            code,
            message:
              error instanceof Error ? error.message : String(error),
          },
        });
        continue;
      }
      const result = outcome.result;
      if (result.status === 'invalid') {
        invalid += 1;
      } else if (
        result.status === 'error' ||
        result.status === 'incomplete' ||
        result.status === 'cancelled'
      ) {
        errors += 1;
      } else if (result.passed) {
        passed += 1;
      } else {
        failed += 1;
      }
      results.push({
        graph: graphPath,
        seed,
        ...(compact(outcome) as Record<string, unknown>),
      });
    }
  }
  output(
    {
      command: 'batch',
      summary: {
        total: results.length,
        passed,
        failed,
        invalid,
        errors,
      },
      results,
    },
    args.pretty,
  );
  if (errors > 0) {
    exitWith(EXIT_INTERNAL);
  }
  if (invalid > 0) {
    exitWith(EXIT_USAGE);
  }
  exitWith(failed > 0 ? EXIT_FAILED : EXIT_PASS);
}

function runMain(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    if (!args.pretty) {
      process.stdout.write(`${JSON.stringify({ help: usage() })}\n`);
    } else {
      process.stdout.write(`${usage()}\n`);
    }
    return;
  }
  switch (args.command) {
    case 'levels':
      commandLevels(args);
      return;
    case 'describe':
      commandDescribe(args);
      return;
    case 'schema':
      commandSchema(args);
      return;
    case 'example':
      commandExample(args);
      return;
    case 'validate':
      commandValidate(args);
      return;
    case 'run':
      commandRun(args);
      return;
    case 'batch':
      commandBatch(args);
      return;
    default:
      process.stdout.write(`${usage()}\n`);
  }
}

function main(): void {
  try {
    runMain();
  } catch (error) {
    if (error instanceof CliExit) {
      // Do not call process.exit(): Node must drain stdout/stderr first.
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
}

main();
