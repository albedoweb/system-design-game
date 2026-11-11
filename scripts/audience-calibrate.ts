import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AUDIENCE_LEVEL } from '../src/audience/level';
import type {
  AudienceEvaluation,
  AudienceOperationMetrics,
} from '../src/audience/contracts';

/**
 * Executable Live Audience calibration harness.
 *
 * This tool only orchestrates the real public evaluator. It never implements
 * simulation math, never turns a model error/timeout into an expected negative,
 * and never writes into the repository. Every evaluation runs in its own Node
 * child process (tsx loader) so peak RSS and the wall-clock budget are isolated.
 *
 * Typical commands:
 *   npx tsx scripts/audience-calibrate.ts --help
 *   npx tsx scripts/audience-calibrate.ts --output-dir /tmp/audience-matrix
 *   npx tsx scripts/audience-calibrate.ts --output-dir /tmp/audience-witness \
 *     --family family-query-large --seed 101
 *
 * The full matrix is only executed when explicitly invoked. This script does
 * not run automatically on import.
 */

export const TIMEOUT_MS = 60_000;
/**
 * Calibration child CLI uses --max-old-space-size=192 --max-semi-space-size=8.
 * The Live Audience Worker API uses maxOldGenerationSizeMb=192,
 * maxYoungGenerationSizeMb=16, stackSizeMb=4. On Node 24 (v24.22.2) both
 * measured the same effective V8 heap ceiling: 226,492,416 bytes (216 MiB).
 * The option names are still distinct; do not describe the 8 MiB semi-space
 * as a literal 16 MiB young generation. These flags constrain V8 heap, not
 * total process RSS; `MAX_RSS_TARGET_MIB` remains the separate observed-
 * resident guard.
 */
export const NODE_MAX_OLD_SPACE_MB = 192;
export const NODE_SEMI_SPACE_MB = 8;
export const MAX_RSS_TARGET_MIB = 512;
const CHILD_FLAG = '--child';
const SCHEMA_KIND = 'audience-calibration-raw';
const SUMMARY_KIND = 'audience-calibration-summary';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const fixturesDir = resolve(repoRoot, 'fixtures/audience');
const scriptPath = fileURLToPath(import.meta.url);

type ExpectedKind =
  | 'pass'
  | 'invalid'
  | 'single-app-fault-fail'
  | 'direct-fault-fail'
  | 'peak-fail'
  | 'freshness-fail';

interface FamilySpec {
  readonly id: string;
  readonly fixture: string;
  readonly expected: ExpectedKind;
  readonly expectation: string;
}

const PASS_FAMILIES: readonly FamilySpec[] = [
  {
    id: 'family-query-large',
    fixture: 'family-query-large',
    expected: 'pass',
    expectation:
      'complete and passing on every calibration and holdout seed, with all required cases and an eligible peak-case cost score',
  },
  {
    id: 'family-cache-query',
    fixture: 'family-cache-query',
    expected: 'pass',
    expectation:
      'complete and passing on every calibration and holdout seed, with all required cases and an eligible peak-case cost score',
  },
  {
    id: 'family-projection',
    fixture: 'family-projection',
    expected: 'pass',
    expectation:
      'complete and passing on every calibration and holdout seed, with all required cases and an eligible peak-case cost score',
  },
];

const NEGATIVE_FAMILIES: readonly FamilySpec[] = [
  {
    id: 'fail-single-app',
    fixture: 'fail-single-app',
    expected: 'single-app-fault-fail',
    expectation:
      'normal traffic passes but the required app-failure-0 case fails (single Application instance)',
  },
  {
    id: 'fail-direct-no-lb',
    fixture: 'fail-direct-no-lb',
    expected: 'direct-fault-fail',
    expectation:
      'the direct Users -> Application path cannot route spare slots, so at least one required Application failure case fails',
  },
  {
    id: 'fail-small-query',
    fixture: 'fail-small-query',
    expected: 'peak-fail',
    expectation:
      'small SQL with the query plan fails the peak case or one of its required critical gates',
  },
  {
    id: 'fail-stale-ttl',
    fixture: 'fail-stale-ttl',
    expected: 'freshness-fail',
    expectation:
      'the selected 15 s TTL is real retention and at least one successful ranking fails freshness',
  },
  {
    id: 'invalid-projection-without-worker',
    fixture: 'invalid-projection-without-worker',
    expected: 'invalid',
    expectation:
      'the projection read plan without a Worker is rejected as invalid and is never evaluated',
  },
];

const VALIDATION_FAMILIES: readonly FamilySpec[] = [
  {
    id: 'starter',
    fixture: 'starter',
    expected: 'invalid',
    expectation:
      'Users-only starter is a structurally parseable but incomplete document and is rejected as invalid',
  },
];

const ALL_FAMILIES: readonly FamilySpec[] = [
  ...PASS_FAMILIES,
  ...NEGATIVE_FAMILIES,
  ...VALIDATION_FAMILIES,
];

const FAMILY_ALIASES: Readonly<Record<string, string>> = {
  'query-large': 'family-query-large',
  'cache-query': 'family-cache-query',
  projection: 'family-projection',
  'single-app': 'fail-single-app',
  'direct-no-lb': 'fail-direct-no-lb',
  'small-query': 'fail-small-query',
  'stale-ttl': 'fail-stale-ttl',
  'missing-worker': 'invalid-projection-without-worker',
  'missing-worker-invalid': 'invalid-projection-without-worker',
  'invalid-missing-worker': 'invalid-projection-without-worker',
};

interface Options {
  readonly help: boolean;
  readonly outputDir: string | null;
  readonly families: readonly string[];
  readonly seeds: readonly number[];
  readonly child: boolean;
  readonly childFixture: string | null;
  readonly childSeed: number | null;
  readonly childOutput: string | null;
  readonly childFamily: string | null;
  readonly runSha: string | null;
  readonly runNonce: string | null;
  readonly planOnly: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: readonly string[]): Options {
  let help = false;
  let outputDir: string | null = null;
  let child = false;
  let childFixture: string | null = null;
  let childSeed: number | null = null;
  let childOutput: string | null = null;
  let childFamily: string | null = null;
  let runSha: string | null = null;
  let runNonce: string | null = null;
  let planOnly = false;
  const families: string[] = [];
  const seeds: number[] = [];

  const valueAfter = (index: number, name: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`missing value after ${name}`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const equals = arg.indexOf('=');
    const key = equals >= 0 ? arg.slice(0, equals) : arg;
    const inline = equals >= 0 ? arg.slice(equals + 1) : null;
    const take = (name: string): string => {
      if (inline !== null) {
        return inline;
      }
      const value = valueAfter(index, name);
      index += 1;
      return value;
    };
    switch (key) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--output-dir':
        outputDir = take(key);
        break;
      case '--family':
        families.push(take(key));
        break;
      case '--seed': {
        const raw = take(key);
        const seed = Number(raw);
        if (!Number.isInteger(seed) || seed < 0) {
          fail(`invalid seed: ${raw}`);
        }
        seeds.push(seed);
        break;
      }
      case '--timeout-ms':
        // Accepted only to reject accidental overrides: the bound is fixed.
        fail(
          `--timeout-ms is not supported; every evaluation has a fixed ${TIMEOUT_MS} ms wall-clock bound`,
        );
        break;
      case CHILD_FLAG:
        child = true;
        break;
      case '--child-fixture':
        childFixture = take(key);
        break;
      case '--child-seed': {
        const raw = take(key);
        const seed = Number(raw);
        if (!Number.isInteger(seed) || seed < 0) {
          fail(`invalid child seed: ${raw}`);
        }
        childSeed = seed;
        break;
      }
      case '--child-output':
        childOutput = take(key);
        break;
      case '--child-family':
        childFamily = take(key);
        break;
      case '--run-sha':
        runSha = take(key);
        break;
      case '--run-nonce':
        runNonce = take(key);
        break;
      case '--plan-only':
        planOnly = true;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  return {
    help,
    outputDir,
    families,
    seeds,
    child,
    childFixture,
    childSeed,
    childOutput,
    childFamily,
    runSha,
    runNonce,
    planOnly,
  };
}

function printHelp(): void {
  console.log(`Live Audience calibration harness (executable only)

Usage:
  npx tsx scripts/audience-calibrate.ts --output-dir <outside-repo-path> [options]

Required for a matrix run:
  --output-dir <path>     A NEW, non-existent directory OUTSIDE the Git
                          repository. Existing directories, files and symlinks
                          are refused before any file mutation and are never
                          deleted or modified. Old artifacts are preserved.
                          Raw evaluations, logs and summary.json are written here.

Filters:
  --family <id>           Run only one or more families (repeatable or comma list).
                          Pass families: family-query-large, family-cache-query,
                          family-projection.
                          Negatives: fail-single-app, fail-direct-no-lb,
                          fail-small-query, fail-stale-ttl,
                          invalid-projection-without-worker.
                          Validation-only (not in the default matrix): starter.
                          Aliases: query-large, cache-query, projection,
                          single-app, direct-no-lb, small-query, stale-ttl,
                          missing-worker.
  --seed <n>              Run positive families only for these seeds
                          (repeatable or comma list). Negatives run at 101 when
                          the selected seed scope includes 101; an explicitly
                          selected negative requires seed 101.

Examples:
  # first single witness
  npx tsx scripts/audience-calibrate.ts --output-dir /tmp/audience-witness \\
    --family family-query-large --seed 101

  # explicit full matrix (3 families x 5 calibration + 2 holdout seeds,
  # plus five negative fixtures at seed 101); this harness does NOT run it
  # automatically and this command is intentionally not executed by A102:
  npx tsx scripts/audience-calibrate.ts --output-dir /tmp/audience-matrix

Behaviour:
  - Each evaluation is a separate Node 24 child with the local tsx loader.
  - Sequential only; a hard ${TIMEOUT_MS} ms wall-clock limit per child.
  - Each child Node process starts with
    --max-old-space-size=${NODE_MAX_OLD_SPACE_MB} --max-semi-space-size=${NODE_SEMI_SPACE_MB}.
    On Node 24 this CLI pair and the Live Audience Worker API limits
    (maxOldGenerationSizeMb=192, maxYoungGenerationSizeMb=16, stackSizeMb=4)
    measured the same effective V8 heap ceiling: 226,492,416 bytes (216 MiB).
    The option names are distinct; the 8 MiB semi-space is not a literal 16 MiB
    young generation. Observed maxRSS is reported separately and a value above
    ${MAX_RSS_TARGET_MIB} MiB fails an explicit memory check. The V8 flags
    bound child heap only; they do not bound browser or total RSS.
  - --plan-only prints the selected run plan and scope checks without running
    any evaluator; use it to validate filters before a witness run.
  - The actual public evaluateAudience result is strictly parsed with
    parseAudienceEvaluation. Full raw results are preserved.
  - Child errors/timeouts are recorded as actual failures, never converted
    into an expected negative or a passing family.
  - Exit code is non-zero if any run misses its expectation or a full-matrix
    summary check fails.

A full matrix passing does not by itself prove model balance or release the
draft physics; treat it as expectation evidence for A101/A104 review.
`);
}

function resolveFamily(raw: string): FamilySpec {
  const normalized = FAMILY_ALIASES[raw] ?? raw;
  const found = ALL_FAMILIES.find((item) => item.id === normalized);
  if (found === undefined) {
    fail(
      `unknown family "${raw}". Known: ${ALL_FAMILIES.map((item) => item.id).join(', ')}`,
    );
  }
  return found;
}

function assertNode24(): void {
  const major = Number(process.version.replace(/^v/, '').split('.')[0]);
  if (major !== 24) {
    fail(
      `Live Audience calibration requires Node 24; current runtime is ${process.version}.`,
    );
  }
}

function gitInfo(): { sha: string; dirtyFiles: string[] } {
  const shaResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const statusResult = spawnSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const sha = (shaResult.stdout ?? '').trim() || 'unknown';
  const dirtyFiles = (statusResult.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { sha, dirtyFiles };
}

function readManifest(): Record<string, { class: string; note: string }> {
  const path = resolve(fixturesDir, 'manifest.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    fixtures?: readonly { file?: unknown; class?: unknown; note?: unknown }[];
  };
  const map: Record<string, { class: string; note: string }> = {};
  for (const item of parsed.fixtures ?? []) {
    if (typeof item.file !== 'string') {
      continue;
    }
    map[item.file.replace(/\.json$/, '')] = {
      class: typeof item.class === 'string' ? item.class : 'unknown',
      note: typeof item.note === 'string' ? item.note : '',
    };
  }
  return map;
}

function nearestExistingPath(target: string): string {
  let current = target;
  for (;;) {
    if (existsSync(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

/** Resolve symlinks for the existing prefix and keep any non-existing tail. */
function canonicalFileSystemPath(target: string): string {
  const absolute = resolve(target);
  const existing = nearestExistingPath(absolute);
  const realExisting = realpathSync(existing);
  const tail = relative(existing, absolute);
  return tail === '' ? realExisting : resolve(realExisting, join(tail));
}

/**
 * Exact parent/separator check on real paths. A directory merely named with a
 * ".." prefix is still inside the repository; symlinks are resolved before the
 * comparison so an output path cannot escape or enter the checkout invisibly.
 */
/** True for an existing file/dir/symlink, including a dangling symlink. */
export function outputPathExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export function isOutsideRepositoryRoot(
  repositoryRoot: string,
  target: string,
): boolean {
  const realRoot = canonicalFileSystemPath(repositoryRoot);
  const realTarget = canonicalFileSystemPath(target);
  const rel = relative(realRoot, realTarget);
  if (rel === '') {
    return false;
  }
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function safeTail(value: string | Buffer | undefined, limit = 4_000): string {
  const text = typeof value === 'string' ? value : (value?.toString('utf8') ?? '');
  return text.length <= limit ? text : text.slice(-limit);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Child mode
// ---------------------------------------------------------------------------

interface OperationSummary {
  offered: number;
  succeeded: number;
  pending: number;
  availability: number | null;
  p95Ms: number | null;
  samples: number;
  insufficientSamples: boolean;
}

interface GateSummary {
  id: string;
  passed: boolean;
  actual: number | null;
  limit: number | null;
  unit: string;
  sampleCount: number;
  message: string;
}

interface CaseSummary {
  id: string;
  kind: string;
  status: string;
  passed: boolean;
  targetInstance: number | null;
  costUsd: number | null;
  failedGateIds: string[];
  gates: GateSummary[];
  operations: {
    ingest: OperationSummary | null;
    read: OperationSummary | null;
    criticalIngest: OperationSummary | null;
    criticalRead: OperationSummary | null;
  };
  freshness: {
    valid: boolean;
    checkedReads: number;
    successfulReads: number;
    staleReads: number;
    wrongWindowReads: number;
    maxLagMs: number;
  } | null;
  correctness: {
    valid: boolean;
    checkedSnapshots: number;
    snapshotMismatches: number;
    checkedExpiry: number;
    expectedExpiries: number;
    expiryMismatches: number;
    lostAcknowledgedEvents: number;
    duplicateLogicalEvents: number;
  } | null;
}

interface EvaluationSummary {
  status: string;
  passed: boolean;
  modelVersion: string;
  contentVersion: string;
  pricingVersion: string;
  profileVersion: string;
  score: {
    eligible: boolean;
    costUsd: number | null;
    caseId: string;
  };
  provisioned: AudienceEvaluation['provisioned'];
  requiredCaseIds: string[];
  caseIds: string[];
  caseCount: number;
  passedCaseCount: number;
  allCasesPassed: boolean;
  scoreMatchesAllCases: boolean;
  cases: CaseSummary[];
  issues: readonly unknown[];
  incompleteReasons: readonly string[];
}

interface ChildOutput {
  kind: string;
  metadata: {
    gitSha: string;
    family: string;
    fixture: string;
    seed: number;
    node: string;
    pid: number;
    startedAt: string;
    finishedAt: string;
    evaluatorWallClockMs: number;
    maxRssKiB: number;
    maxRssMiB: number;
    heapUsedMiB: number;
    heapTotalMiB: number;
    externalMiB: number;
    timeoutMs: number;
    nodeMaxOldSpaceMb: number;
    nodeSemiSpaceMb: number;
    maxRssTargetMiB: number;
    runNonce: string;
    resourceUsageNote: string;
  };
  parse: {
    ok: boolean;
    issues: readonly unknown[];
  };
  error: {
    kind: 'evaluate-threw';
    name: string;
    message: string;
    stackTail: string;
  } | null;
  summary: EvaluationSummary | null;
  evaluation: AudienceEvaluation | null;
}

function operationSummary(value: AudienceOperationMetrics): OperationSummary {
  return {
    offered: value.offered,
    succeeded: value.succeeded,
    pending: value.pending,
    availability: value.availability,
    p95Ms: value.latency.p95Ms,
    samples: value.latency.samples,
    insufficientSamples: value.latency.insufficientSamples,
  };
}

function requiredCaseIds(
  provisioned: AudienceEvaluation['provisioned'],
): string[] {
  if (provisioned === null) {
    return [];
  }
  return [
    'normal',
    'peak',
    ...Array.from(
      { length: provisioned.appInstances },
      (_, index) => `app-failure-${index}`,
    ),
  ];
}

function summarizeEvaluation(
  evaluation: AudienceEvaluation,
): EvaluationSummary {
  const cases: CaseSummary[] = evaluation.cases.map((item) => ({
    id: item.id,
    kind: item.kind,
    status: item.status,
    passed: item.passed,
    targetInstance: item.targetInstance,
    costUsd: item.cost?.actualUsd ?? null,
    failedGateIds: item.gates
      .filter((gate) => !gate.passed)
      .map((gate) => gate.id),
    gates: item.gates.map((gate) => ({
      id: gate.id,
      passed: gate.passed,
      actual: gate.actual,
      limit: gate.limit,
      unit: gate.unit,
      sampleCount: gate.sampleCount,
      message: gate.message,
    })),
    operations: {
      ingest:
        item.operations === null
          ? null
          : operationSummary(item.operations.ingest),
      read:
        item.operations === null
          ? null
          : operationSummary(item.operations.read),
      criticalIngest:
        item.operations?.critical === null ||
        item.operations?.critical === undefined
          ? null
          : operationSummary(item.operations.critical.ingest),
      criticalRead:
        item.operations?.critical === null ||
        item.operations?.critical === undefined
          ? null
          : operationSummary(item.operations.critical.read),
    },
    freshness:
      item.freshness === null
        ? null
        : {
            valid: item.freshness.valid,
            checkedReads: item.freshness.checkedReads,
            successfulReads: item.freshness.successfulReads,
            staleReads: item.freshness.staleReads,
            wrongWindowReads: item.freshness.wrongWindowReads,
            maxLagMs: item.freshness.maxLagMs,
          },
    correctness:
      item.correctness === null
        ? null
        : {
            valid: item.correctness.valid,
            checkedSnapshots: item.correctness.checkedSnapshots,
            snapshotMismatches: item.correctness.snapshotMismatches,
            checkedExpiry: item.correctness.checkedExpiry,
            expectedExpiries: item.correctness.expectedExpiries,
            expiryMismatches: item.correctness.expiryMismatches,
            lostAcknowledgedEvents: item.correctness.lostAcknowledgedEvents,
            duplicateLogicalEvents: item.correctness.duplicateLogicalEvents,
          },
  }));
  const caseIds = cases.map((item) => item.id);
  const allCasesPassed =
    evaluation.status === 'complete' &&
    cases.length > 0 &&
    cases.every((item) => item.passed);
  return {
    status: evaluation.status,
    passed: evaluation.passed,
    modelVersion: evaluation.modelVersion,
    contentVersion: evaluation.contentVersion,
    pricingVersion: evaluation.pricingVersion,
    profileVersion: evaluation.profileVersion,
    score: {
      eligible: evaluation.score.eligible,
      costUsd: evaluation.score.costUsd,
      caseId: evaluation.score.caseId,
    },
    provisioned: evaluation.provisioned,
    requiredCaseIds: requiredCaseIds(evaluation.provisioned),
    caseIds,
    caseCount: cases.length,
    passedCaseCount: cases.filter((item) => item.passed).length,
    allCasesPassed,
    scoreMatchesAllCases: evaluation.score.eligible === allCasesPassed,
    cases,
    issues: evaluation.issues,
    incompleteReasons: evaluation.incompleteReasons,
  };
}

function describeThrown(error: unknown): ChildOutput['error'] {
  if (error instanceof Error) {
    return {
      kind: 'evaluate-threw',
      name: error.name,
      message: error.message,
      stackTail: (error.stack ?? '').slice(-2_000),
    };
  }
  return {
    kind: 'evaluate-threw',
    name: 'unknown',
    message: String(error),
    stackTail: '',
  };
}

async function childMain(options: Options): Promise<void> {
  assertNode24();
  if (
    options.childFixture === null ||
    options.childSeed === null ||
    options.childOutput === null
  ) {
    fail('child mode requires --child-fixture, --child-seed and --child-output');
  }
  const fixturePath = resolve(options.childFixture);
  const outputPath = resolve(options.childOutput);
  const family = options.childFamily ?? 'unknown';
  if (options.runNonce === null) {
    fail('child mode requires --run-nonce');
  }
  const gitSha = options.runSha ?? gitInfo().sha;
  const startedAt = new Date().toISOString();

  const graph: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const { evaluateAudience, parseAudienceEvaluation } = await import(
    '../src/audience'
  );

  let evaluation: AudienceEvaluation | null = null;
  let error: ChildOutput['error'] = null;
  const wallStart = performance.now();
  try {
    evaluation = evaluateAudience(graph, { seed: options.childSeed });
  } catch (thrown) {
    error = describeThrown(thrown);
  }
  const evaluatorWallClockMs = performance.now() - wallStart;

  const parsed =
    evaluation === null
      ? null
      : parseAudienceEvaluation(evaluation);
  const usage = process.resourceUsage();
  const memory = process.memoryUsage();
  const finishedAt = new Date().toISOString();

  const output: ChildOutput = {
    kind: SCHEMA_KIND,
    metadata: {
      gitSha,
      family,
      fixture: relative(repoRoot, fixturePath),
      seed: options.childSeed,
      node: process.version,
      pid: process.pid,
      startedAt,
      finishedAt,
      evaluatorWallClockMs,
      maxRssKiB: usage.maxRSS,
      maxRssMiB: usage.maxRSS / 1_024,
      heapUsedMiB: memory.heapUsed / (1024 * 1024),
      heapTotalMiB: memory.heapTotal / (1024 * 1024),
      externalMiB: memory.external / (1024 * 1024),
      timeoutMs: TIMEOUT_MS,
      nodeMaxOldSpaceMb: NODE_MAX_OLD_SPACE_MB,
      nodeSemiSpaceMb: NODE_SEMI_SPACE_MB,
      maxRssTargetMiB: MAX_RSS_TARGET_MIB,
      runNonce: options.runNonce ?? 'missing-nonce',
      resourceUsageNote:
        'process.resourceUsage().maxRSS is reported by Node in KiB; MiB values divide by 1024 and include Node+tsx overhead. --max-old-space-size and --max-semi-space-size bound V8 heap, not total process RSS.',
    },
    parse: {
      ok: parsed?.ok ?? false,
      issues: parsed?.issues ?? [],
    },
    error,
    summary: evaluation === null ? null : summarizeEvaluation(evaluation),
    evaluation,
  };
  writeJson(outputPath, output);
  process.exitCode = error !== null ? 2 : parsed?.ok === true ? 0 : 3;
}

// ---------------------------------------------------------------------------
// Parent mode
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fresh-child guards (exported for the narrow harness unit test)
// ---------------------------------------------------------------------------

export interface ExpectedChildIdentity {
  family: string;
  fixtureRelative: string;
  seed: number;
  gitSha: string;
  runNonce: string;
}

export interface ChildExecutionState {
  status: number | null;
  signal: string | null;
  spawnError: string | null;
  timedOut: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A child must exit 0 with no signal/spawn error, independent of raw output. */
export function childExecutionError(state: ChildExecutionState): string | null {
  if (state.timedOut) {
    return `child exceeded the fixed ${TIMEOUT_MS} ms wall-clock limit`;
  }
  if (state.signal !== null) {
    return `child terminated by signal ${state.signal}`;
  }
  if (state.spawnError !== null) {
    return `child spawn/execution error: ${state.spawnError}`;
  }
  if (state.status !== 0) {
    return `child exited with status ${state.status === null ? 'none' : state.status}`;
  }
  return null;
}

/**
 * Reject a raw file that does not belong to this exact child invocation. This
 * prevents a previously written raw result from satisfying a failed child.
 */
export function validateChildRunIdentity(
  raw: unknown,
  expected: ExpectedChildIdentity,
): string | null {
  if (!isRecord(raw)) {
    return 'raw evaluation is not a JSON object';
  }
  if (raw.kind !== SCHEMA_KIND) {
    return `raw evaluation kind mismatch: ${String(raw.kind)}`;
  }
  const metadata = raw.metadata;
  if (!isRecord(metadata)) {
    return 'raw evaluation metadata is missing';
  }
  if (metadata.family !== expected.family) {
    return `raw metadata family ${String(metadata.family)} does not match ${expected.family}`;
  }
  if (metadata.fixture !== expected.fixtureRelative) {
    return `raw metadata fixture ${String(metadata.fixture)} does not match ${expected.fixtureRelative}`;
  }
  if (metadata.seed !== expected.seed) {
    return `raw metadata seed ${String(metadata.seed)} does not match ${expected.seed}`;
  }
  if (metadata.gitSha !== expected.gitSha) {
    return `raw metadata gitSha ${String(metadata.gitSha)} does not match ${expected.gitSha}`;
  }
  if (metadata.runNonce !== expected.runNonce) {
    return 'raw metadata runNonce does not match this child invocation';
  }
  return null;
}

/**
 * Combined guard used by the parent. Execution failure wins even when a
 * perfectly matching raw file exists, so a failed child can never satisfy a
 * positive or negative expectation.
 */
export function childRunGuard(input: {
  execution: ChildExecutionState;
  raw: unknown;
  expected: ExpectedChildIdentity;
}): string | null {
  const executionError = childExecutionError(input.execution);
  if (executionError !== null) {
    return executionError;
  }
  if (input.raw === null) {
    return 'child produced no readable raw evaluation';
  }
  return validateChildRunIdentity(input.raw, input.expected);
}

interface RunRecord {
  runId: string;
  family: string;
  fixture: string;
  fixtureClass: string;
  fixtureNote: string;
  seed: number;
  expected: ExpectedKind;
  expectationText: string;
  rawPath: string;
  stdoutLog: string;
  stderrLog: string;
  child: {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    spawnError: string | null;
    processWallClockMs: number;
    evaluatorWallClockMs: number | null;
    maxRssMiB: number | null;
    heapUsedMiB: number | null;
    node: string | null;
    pid: number | null;
    stdoutTail: string;
    stderrTail: string;
  };
  rawGuard: {
    runNonce: string;
    accepted: boolean;
    error: string | null;
  };
  parse: {
    ok: boolean;
    issueCount: number;
    issues: readonly unknown[];
  } | null;
  evaluation: EvaluationSummary | null;
  error: ChildOutput['error'] | null;
  expectation: {
    expected: ExpectedKind;
    expectedText: string;
    met: boolean;
    reason: string;
    checks: readonly { id: string; passed: boolean; detail: string }[];
  };
}

interface ExpectationResult {
  met: boolean;
  reason: string;
  checks: readonly { id: string; passed: boolean; detail: string }[];
}

function caseById(
  summary: EvaluationSummary,
  id: string,
): CaseSummary | undefined {
  return summary.cases.find((item) => item.id === id);
}

function expectationFor(
  spec: FamilySpec,
  summary: EvaluationSummary | null,
  parseOk: boolean,
  error: ChildOutput['error'] | null,
  childError: string | null,
): ExpectationResult {
  if (childError !== null) {
    return {
      met: false,
      reason: childError,
      checks: [{ id: 'child-ran', passed: false, detail: childError }],
    };
  }
  if (error !== null) {
    return {
      met: false,
      reason: `evaluator threw ${error.name}: ${error.message}`,
      checks: [
        {
          id: 'evaluator-completed',
          passed: false,
          detail: `${error.name}: ${error.message}`,
        },
      ],
    };
  }
  if (summary === null) {
    return {
      met: false,
      reason: 'no evaluation produced',
      checks: [
        { id: 'evaluation-present', passed: false, detail: 'no evaluation' },
      ],
    };
  }
  if (!parseOk) {
    return {
      met: false,
      reason: 'public result failed strict parseAudienceEvaluation',
      checks: [
        {
          id: 'strict-parse',
          passed: false,
          detail: 'parseAudienceEvaluation rejected the result',
        },
      ],
    };
  }

  const complete = summary.status === 'complete';
  const requiredIdsMatch =
    summary.requiredCaseIds.length === summary.caseIds.length &&
    summary.requiredCaseIds.every((id, index) => summary.caseIds[index] === id);
  const base = [
    { id: 'complete', passed: complete, detail: `status=${summary.status}` },
    {
      id: 'required-cases',
      passed: requiredIdsMatch,
      detail: `${summary.caseIds.join(',')} expected ${summary.requiredCaseIds.join(',')}`,
    },
  ];

  if (spec.expected === 'pass') {
    const checks = [
      ...base,
      { id: 'passed', passed: summary.passed, detail: `passed=${summary.passed}` },
      {
        id: 'all-cases-passed',
        passed: summary.allCasesPassed,
        detail: `${summary.cases.filter((item) => item.passed).length}/${summary.cases.length} cases passed`,
      },
      {
        id: 'score-eligible',
        passed: summary.score.eligible && summary.score.costUsd !== null,
        detail: `eligible=${summary.score.eligible} costUsd=${summary.score.costUsd ?? 'null'}`,
      },
      {
        id: 'score-matches-all-cases',
        passed: summary.scoreMatchesAllCases,
        detail: `score.eligible=${summary.score.eligible}, allCasesPassed=${summary.allCasesPassed}`,
      },
    ];
    const met = checks.every((item) => item.passed);
    return {
      met,
      reason: met ? 'complete, passing, all cases and eligible score' : 'pass-family expectation not met',
      checks,
    };
  }

  if (spec.expected === 'invalid') {
    const checks = [
      {
        id: 'invalid',
        passed: summary.status === 'invalid',
        detail: `status=${summary.status}`,
      },
      { id: 'not-passed', passed: !summary.passed, detail: `passed=${summary.passed}` },
      {
        id: 'issues-present',
        passed: summary.issues.length > 0,
        detail: `${summary.issues.length} issue(s)`,
      },
      {
        id: 'no-cases',
        passed: summary.cases.length === 0,
        detail: `${summary.cases.length} case(s)`,
      },
    ];
    const met = checks.every((item) => item.passed);
    return {
      met,
      reason: met ? 'rejected as invalid before evaluation' : 'invalid expectation not met',
      checks,
    };
  }

  if (spec.expected === 'single-app-fault-fail') {
    const normal = caseById(summary, 'normal');
    const fault = caseById(summary, 'app-failure-0');
    const checks = [
      ...base,
      { id: 'not-passed', passed: !summary.passed, detail: `passed=${summary.passed}` },
      {
        id: 'normal-passed',
        passed: normal?.passed === true,
        detail: `normal=${normal?.status ?? 'missing'}/${normal?.passed ?? 'n/a'}`,
      },
      {
        id: 'fault-failed',
        passed: fault?.passed === false,
        detail: `app-failure-0=${fault?.status ?? 'missing'}/${fault?.passed ?? 'n/a'} failedGates=${fault?.failedGateIds.join(',') ?? ''}`,
      },
    ];
    const met = checks.every((item) => item.passed);
    return {
      met,
      reason: met ? 'normal passes and the single-instance fault case fails' : 'single-app witness not met',
      checks,
    };
  }

  if (spec.expected === 'direct-fault-fail') {
    const faults = summary.cases.filter((item) =>
      item.id.startsWith('app-failure-'),
    );
    const failed = faults.filter((item) => !item.passed);
    const checks = [
      ...base,
      { id: 'not-passed', passed: !summary.passed, detail: `passed=${summary.passed}` },
      {
        id: 'fault-failed',
        passed: failed.length > 0,
        detail: `${failed.length}/${faults.length} fault case(s) failed`,
      },
    ];
    const met = checks.every((item) => item.passed);
    return {
      met,
      reason: met ? 'direct path cannot hide the failed Application slot' : 'direct-path fault expectation not met',
      checks,
    };
  }

  if (spec.expected === 'peak-fail') {
    const peak = caseById(summary, 'peak');
    const checks = [
      ...base,
      { id: 'not-passed', passed: !summary.passed, detail: `passed=${summary.passed}` },
      {
        id: 'peak-failed',
        passed: peak?.passed === false,
        detail: `peak=${peak?.status ?? 'missing'}/${peak?.passed ?? 'n/a'} failedGates=${peak?.failedGateIds.join(',') ?? ''}`,
      },
    ];
    const met = checks.every((item) => item.passed);
    return {
      met,
      reason: met ? 'peak case fails under the undersized query plan' : 'peak-fail expectation not met',
      checks,
    };
  }

  const failedFreshness = summary.cases.filter(
    (item) =>
      item.freshness?.valid === false ||
      item.failedGateIds.includes('freshness') ||
      (item.freshness?.staleReads ?? 0) > 0,
  );
  const checks = [
    ...base,
    { id: 'not-passed', passed: !summary.passed, detail: `passed=${summary.passed}` },
    {
      id: 'freshness-failed',
      passed: failedFreshness.length > 0,
      detail: failedFreshness
        .map(
          (item) =>
            `${item.id}: valid=${item.freshness?.valid ?? 'n/a'} stale=${item.freshness?.staleReads ?? 'n/a'} gates=${item.failedGateIds.join(',')}`,
        )
        .join(' | '),
    },
  ];
  const met = checks.every((item) => item.passed);
  return {
    met,
    reason: met ? 'selected TTL produces real stale rankings' : 'freshness-fail expectation not met',
    checks,
  };
}

function runChild(
  spec: FamilySpec,
  seed: number,
  outputDir: string,
  gitSha: string,
  manifest: Record<string, { class: string; note: string }>,
): RunRecord {
  const runId = `${spec.id}__seed-${seed}`;
  const rawPath = resolve(outputDir, 'raw', `${runId}.json`);
  const stdoutLog = resolve(outputDir, 'logs', `${runId}.stdout.log`);
  const stderrLog = resolve(outputDir, 'logs', `${runId}.stderr.log`);
  const fixturePath = resolve(fixturesDir, `${spec.fixture}.json`);
  if (!existsSync(fixturePath)) {
    fail(`fixture not found: ${fixturePath}`);
  }
  // The parent guarantees a brand-new output directory, so this raw path is
  // fresh. The nonce/metadata guard remains as defence against a wrong or
  // externally replaced file, without deleting anything.
  const runNonce = randomUUID();
  const args = [
    `--max-old-space-size=${NODE_MAX_OLD_SPACE_MB}`,
    `--max-semi-space-size=${NODE_SEMI_SPACE_MB}`,
    '--import',
    'tsx',
    scriptPath,
    CHILD_FLAG,
    '--child-fixture',
    fixturePath,
    '--child-seed',
    String(seed),
    '--child-output',
    rawPath,
    '--child-family',
    spec.id,
    '--run-sha',
    gitSha,
    '--run-nonce',
    runNonce,
  ];
  const start = performance.now();
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const processWallClockMs = performance.now() - start;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  writeFileSync(stdoutLog, stdout);
  writeFileSync(stderrLog, stderr);

  let parsedRaw: unknown = null;
  if (existsSync(rawPath)) {
    try {
      parsedRaw = JSON.parse(readFileSync(rawPath, 'utf8')) as unknown;
    } catch {
      parsedRaw = null;
    }
  }

  const spawnError =
    result.error === undefined
      ? null
      : `${(result.error as NodeJS.ErrnoException).code ?? result.error.name}: ${result.error.message}`;
  const timedOut =
    result.error !== undefined &&
    (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const expectedIdentity: ExpectedChildIdentity = {
    family: spec.id,
    fixtureRelative: relative(repoRoot, fixturePath),
    seed,
    gitSha,
    runNonce,
  };
  const guardError = childRunGuard({
    execution: {
      status: result.status,
      signal: result.signal,
      spawnError,
      timedOut,
    },
    raw: parsedRaw,
    expected: expectedIdentity,
  });
  const childError = guardError;
  const childOutput =
    guardError === null ? (parsedRaw as ChildOutput) : null;
  const summary = childOutput?.summary ?? null;
  const parse = childOutput?.parse ?? null;
  const expectation = expectationFor(
    spec,
    summary,
    parse?.ok === true,
    childOutput?.error ?? null,
    childError,
  );
  const manifestEntry = manifest[spec.fixture] ?? {
    class: 'unknown',
    note: '',
  };
  return {
    runId,
    family: spec.id,
    fixture: spec.fixture,
    fixtureClass: manifestEntry.class,
    fixtureNote: manifestEntry.note,
    seed,
    expected: spec.expected,
    expectationText: spec.expectation,
    rawPath,
    stdoutLog,
    stderrLog,
    rawGuard: {
      runNonce,
      accepted: guardError === null,
      error: guardError,
    },
    child: {
      exitCode: result.status,
      signal: result.signal,
      timedOut,
      spawnError,
      processWallClockMs,
      evaluatorWallClockMs: childOutput?.metadata.evaluatorWallClockMs ?? null,
      maxRssMiB: childOutput?.metadata.maxRssMiB ?? null,
      heapUsedMiB: childOutput?.metadata.heapUsedMiB ?? null,
      node: childOutput?.metadata.node ?? null,
      pid: childOutput?.metadata.pid ?? null,
      stdoutTail: safeTail(stdout),
      stderrTail: safeTail(stderr),
    },
    parse:
      parse === null
        ? null
        : {
            ok: parse.ok,
            issueCount: parse.issues.length,
            issues: parse.issues,
          },
    evaluation: summary,
    error: childOutput?.error ?? null,
    expectation: {
      expected: spec.expected,
      expectedText: spec.expectation,
      met: expectation.met,
      reason: expectation.reason,
      checks: expectation.checks,
    },
  };
}

function familyGroupCheck(
  family: FamilySpec,
  runs: readonly RunRecord[],
  seeds: readonly number[],
): { id: string; passed: boolean; detail: string } {
  const familyRuns = runs.filter((run) => run.family === family.id);
  const missingSeeds = seeds.filter(
    (seed) => !familyRuns.some((run) => run.seed === seed),
  );
  const failed = familyRuns.filter((run) => !run.expectation.met);
  const passed = missingSeeds.length === 0 && failed.length === 0 && familyRuns.length === seeds.length;
  return {
    id: `${family.id}-all-seeds`,
    passed,
    detail: passed
      ? `${familyRuns.length}/${seeds.length} seed runs met the expectation`
      : `missing seeds [${missingSeeds.join(', ')}]; failed [${failed
          .map((run) => `${run.seed}: ${run.expectation.reason}`)
          .join(' | ')}]`,
  };
}

function singleAppWitness(
  runs: readonly RunRecord[],
): Record<string, unknown> | null {
  const run = runs.find((item) => item.family === 'fail-single-app');
  if (run === undefined || run.evaluation === null) {
    return null;
  }
  const byId = (id: string) =>
    run.evaluation?.cases.find((item) => item.id === id) ?? null;
  return {
    runId: run.runId,
    seed: run.seed,
    expectation: run.expectation,
    normal: byId('normal'),
    fault: byId('app-failure-0'),
    witness: {
      normalPassed: byId('normal')?.passed ?? null,
      faultFailed: byId('app-failure-0')?.passed === false,
      faultFailedGates: byId('app-failure-0')?.failedGateIds ?? [],
    },
  };
}

interface SummaryFile {
  kind: string;
  generatedBy: string;
  generatedAt: string;
  sourceCommit: string;
  dirtyFilesAtStart: readonly string[];
  node: string;
  level: {
    levelId: string;
    modelVersion: string;
    contentVersion: string;
    pricingVersion: string;
    profileVersion: string;
    defaultSeed: number;
    calibrationSeeds: readonly number[];
    holdoutSeeds: readonly number[];
  };
  command: readonly string[];
  outputDir: string;
  timeoutMs: number;
  configuredLimits: {
    nodeMaxOldSpaceMb: number;
    nodeSemiSpaceMb: number;
    maxRssTargetMiB: number;
    wallClockMs: number;
    note: string;
  };
  memoryAndPerformance: {
    observed: {
      maxRssMiB: number | null;
      maxHeapUsedMiB: number | null;
      maxProcessWallClockMs: number | null;
      maxEvaluatorWallClockMs: number | null;
      runsWithMemoryEvidence: number;
      runCount: number;
    };
  };
  scope: {
    fullMatrixRequested: boolean;
    families: readonly string[];
    positiveSeeds: readonly number[];
    negativeSeed: number | null;
  };
  families: readonly {
    id: string;
    fixture: string;
    fixtureClass: string;
    expected: ExpectedKind;
    expectation: string;
  }[];
  checks: readonly { id: string; passed: boolean | null; detail: string }[];
  modelConclusion: {
    note: string;
    allThreeFamiliesPassOnAllSeeds: boolean | null;
    distinctPassingFamilies: number;
    minimumTwoDistinctFamilies: boolean | null;
    negativeExpectedConditions: Record<string, boolean | null>;
    allSelectedRunsMetExpectations: boolean;
    overallExpectationsMet: boolean;
  };
  negativeWitnesses: Record<string, unknown> | null;
  runs: readonly RunRecord[];
}

async function parentMain(options: Options): Promise<void> {
  assertNode24();
  const git = gitInfo();
  const manifest = readManifest();
  const familyFilter =
    options.families.length === 0
      ? null
      : options.families.flatMap((item) =>
          item
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part.length > 0),
        );
  const seedFilter = [...new Set(options.seeds)];

  const selectedFamilies =
    familyFilter === null
      ? [...PASS_FAMILIES, ...NEGATIVE_FAMILIES]
      : [...new Set(familyFilter.map(resolveFamily))];

  const selectedPositive = selectedFamilies.filter((spec) =>
    PASS_FAMILIES.some((family) => family.id === spec.id),
  );
  const selectedNegative = selectedFamilies.filter((spec) =>
    NEGATIVE_FAMILIES.some((family) => family.id === spec.id),
  );
  const selectedValidation = selectedFamilies.filter((spec) =>
    VALIDATION_FAMILIES.some((family) => family.id === spec.id),
  );
  if (selectedFamilies.length === 0) {
    fail('the family filter matched no known family');
  }

  const positiveSeeds =
    seedFilter.length > 0
      ? seedFilter
      : [
          ...AUDIENCE_LEVEL.calibrationSeeds,
          ...AUDIENCE_LEVEL.holdoutSeeds,
        ];
  let negativeSeed: number | null = null;
  if (selectedNegative.length > 0) {
    if (seedFilter.length > 0 && !seedFilter.includes(101)) {
      fail(
        'negative fixtures are calibrated at seed 101; include --seed 101 or omit the seed filter',
      );
    }
    negativeSeed = 101;
  }

  const plan: { spec: FamilySpec; seed: number }[] = [];
  for (const spec of selectedPositive) {
    for (const seed of positiveSeeds) {
      plan.push({ spec, seed });
    }
  }
  if (negativeSeed !== null) {
    for (const spec of selectedNegative) {
      plan.push({ spec, seed: negativeSeed });
    }
  }
  for (const spec of selectedValidation) {
    const seed = seedFilter[0] ?? AUDIENCE_LEVEL.defaultSeed;
    plan.push({ spec, seed });
  }

  const unique = new Set<string>();
  for (const item of plan) {
    const key = `${item.spec.id}__${item.seed}`;
    if (unique.has(key)) {
      fail(`duplicate run plan entry: ${key}`);
    }
    unique.add(key);
  }

  const fullMatrixRequested =
    familyFilter === null &&
    seedFilter.length === 0 &&
    selectedPositive.length === PASS_FAMILIES.length &&
    selectedNegative.length === NEGATIVE_FAMILIES.length &&
    positiveSeeds.length ===
      AUDIENCE_LEVEL.calibrationSeeds.length +
        AUDIENCE_LEVEL.holdoutSeeds.length;

  if (options.planOnly) {
    console.log(
      `plan-only: ${plan.length} run(s); Node ${process.version}; source ${git.sha}`,
    );
    for (const item of plan) {
      console.log(`  - ${item.spec.id} seed ${item.seed}`);
    }
    console.log(
      `full matrix: ${fullMatrixRequested ? 'yes' : 'no'} | positive families: ${selectedPositive.length} | positive seeds: ${positiveSeeds.join(',') || 'none'} | negative seed: ${negativeSeed ?? 'none'}`,
    );
    console.log(
      selectedPositive.length >= 2 || fullMatrixRequested
        ? 'minimum-two-distinct-families: assessed (requires at least two passing families)'
        : 'minimum-two-distinct-families: NOT-ASSESSED (filtered run with fewer than two selected positive families)',
    );
    return;
  }

  if (options.outputDir === null) {
    fail('--output-dir is required for a calibration run');
  }
  const outputDir = resolve(process.cwd(), options.outputDir);
  if (outputPathExists(outputDir)) {
    fail(
      `--output-dir must be a new, non-existent directory. Choose a fresh directory (for example ${outputDir}-attempt-2); existing directories, files and symlinks are refused and never modified. Old artifacts are preserved and are not auto-deleted.`,
    );
  }
  if (!isOutsideRepositoryRoot(repoRoot, outputDir)) {
    fail(
      `--output-dir must be outside the Git repository after resolving symlinks (${repoRoot}); got ${outputDir}`,
    );
  }
  // The fresh-directory policy removes the stale-artifact and symlinked-child
  // gap without deleting or reusing anything: raw/logs are created only under
  // this brand-new directory.
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(resolve(outputDir, 'raw'));
  mkdirSync(resolve(outputDir, 'logs'));

  console.log(
    `Live Audience calibration: ${plan.length} isolated child run(s), Node ${process.version}, source ${git.sha}`,
  );
  console.log(
    `output: ${outputDir} (outside repo); hard wall-clock per run: ${TIMEOUT_MS} ms; sequential`,
  );

  const runs: RunRecord[] = [];
  for (const item of plan) {
    process.stdout.write(
      `- ${item.spec.id} seed ${item.seed} ... `,
    );
    const run = runChild(item.spec, item.seed, outputDir, git.sha, manifest);
    runs.push(run);
    const evaluation = run.evaluation;
    const status = evaluation?.status ?? (run.error === null ? 'no-result' : 'threw');
    const passed = evaluation?.passed === true;
    const cost = evaluation?.score.costUsd;
    console.log(
      [
        status,
        passed ? 'PASS' : 'not-passed',
        run.expectation.met ? 'expectation-met' : 'EXPECTATION-FAILED',
        `cost=${cost === null || cost === undefined ? 'n/a' : `$${cost.toFixed(6)}`}`,
        `run=${run.child.processWallClockMs.toFixed(0)}ms`,
        `rss=${run.child.maxRssMiB === null ? 'n/a' : `${run.child.maxRssMiB.toFixed(1)}MiB`}`,
        run.expectation.met ? '' : `reason=${run.expectation.reason}`,
      ]
        .filter((part) => part.length > 0)
        .join(' '),
    );
  }

  const positiveChecks = PASS_FAMILIES.map((family) =>
    familyGroupCheck(family, runs, positiveSeeds),
  ).filter((check) =>
    selectedPositive.some((spec) => check.id.startsWith(`${spec.id}-`)),
  );
  const allThreePass =
    fullMatrixRequested &&
    PASS_FAMILIES.every((family) => {
      const check = positiveChecks.find((item) =>
        item.id.startsWith(`${family.id}-`),
      );
      return check?.passed === true;
    });
  const distinctPassingFamilies = positiveChecks.filter(
    (check) => check.passed,
  ).length;

  const negativeChecks = NEGATIVE_FAMILIES.map((family) => {
    const familyRuns = runs.filter((run) => run.family === family.id);
    if (familyRuns.length === 0) {
      return {
        id: `negative-${family.id}`,
        passed: null as boolean | null,
        detail: 'family not in the selected scope',
      };
    }
    const failed = familyRuns.filter((run) => !run.expectation.met);
    return {
      id: `negative-${family.id}`,
      passed: failed.length === 0,
      detail:
        failed.length === 0
          ? familyRuns.map((run) => run.expectation.reason).join('; ')
          : failed
              .map(
                (run) =>
                  `${run.seed}: ${run.expectation.reason} (${run.expectation.checks
                    .filter((check) => !check.passed)
                    .map((check) => check.id)
                    .join(',')})`,
              )
              .join(' | '),
    };
  });

  const validationChecks = selectedValidation.map((family) => {
    const familyRuns = runs.filter((run) => run.family === family.id);
    const failed = familyRuns.filter((run) => !run.expectation.met);
    return {
      id: `validation-${family.id}`,
      passed: familyRuns.length > 0 && failed.length === 0,
      detail:
        failed.length === 0
          ? family.expectation
          : failed.map((run) => run.expectation.reason).join(' | '),
    };
  });

  const allRunsMet = runs.every((run) => run.expectation.met);
  const negativeExpectedConditions: Record<string, boolean | null> = {};
  for (const family of NEGATIVE_FAMILIES) {
    const familyRuns = runs.filter((run) => run.family === family.id);
    negativeExpectedConditions[family.id] =
      familyRuns.length === 0
        ? null
        : familyRuns.every((run) => run.expectation.met);
  }

  const checks: { id: string; passed: boolean | null; detail: string }[] = [
    {
      id: 'selected-runs-met-expectations',
      passed: allRunsMet,
      detail: `${runs.filter((run) => run.expectation.met).length}/${runs.length} selected run(s) met their expectation`,
    },
    {
      id: 'all-three-families-all-seeds',
      passed: fullMatrixRequested ? allThreePass : null,
      detail: fullMatrixRequested
        ? PASS_FAMILIES.map((family) => {
            const check = positiveChecks.find((item) =>
              item.id.startsWith(`${family.id}-`),
            );
            return `${family.id}: ${check?.passed === true ? 'met' : 'not met'}`;
          }).join('; ')
        : 'filtered run: full 3-family x all-seeds expectation is not claimed',
    },
    {
      id: 'minimum-two-distinct-families',
      passed:
        selectedPositive.length >= 2 || fullMatrixRequested
          ? distinctPassingFamilies >= 2
          : null,
      detail:
        selectedPositive.length >= 2 || fullMatrixRequested
          ? `${distinctPassingFamilies} distinct positive famil${distinctPassingFamilies === 1 ? 'y' : 'ies'} met every selected-seed expectation`
          : 'not assessed: a filtered run selected fewer than two positive compute families',
    },
    ...positiveChecks.map((check) => ({
      id: check.id,
      passed: check.passed,
      detail: check.detail,
    })),
    ...negativeChecks,
    ...validationChecks,
  ];

  const memoryRuns = runs.filter(
    (run) => run.child.maxRssMiB !== null,
  );
  const maxRssMiB =
    memoryRuns.length === 0
      ? null
      : Math.max(...memoryRuns.map((run) => run.child.maxRssMiB ?? 0));
  const missingMemory = runs.length - memoryRuns.length;
  const rssWithinTarget =
    runs.length > 0 &&
    missingMemory === 0 &&
    memoryRuns.every(
      (run) => (run.child.maxRssMiB ?? Number.POSITIVE_INFINITY) <= MAX_RSS_TARGET_MIB,
    );
  checks.push({
    id: 'rss-under-512-mib',
    passed: rssWithinTarget,
    detail:
      maxRssMiB === null
        ? 'no observed maxRSS evidence from any child'
        : `max observed child maxRSS ${maxRssMiB.toFixed(1)} MiB (target ≤ ${MAX_RSS_TARGET_MIB} MiB; configured Node old-space ${NODE_MAX_OLD_SPACE_MB} MiB and semi-space ${NODE_SEMI_SPACE_MB} MiB are different limits), missing evidence for ${missingMemory} run(s)`,
  });
  const maxProcessWallClockMs =
    runs.length === 0
      ? null
      : Math.max(...runs.map((run) => run.child.processWallClockMs));
  const wallClockWithinBound =
    runs.length > 0 &&
    runs.every(
      (run) =>
        !run.child.timedOut &&
        run.child.processWallClockMs <= TIMEOUT_MS &&
        run.child.evaluatorWallClockMs !== null,
    );
  checks.push({
    id: 'wall-clock-under-60s',
    passed: wallClockWithinBound,
    detail:
      maxProcessWallClockMs === null
        ? 'no child wall-clock evidence'
        : `max child process wall clock ${maxProcessWallClockMs.toFixed(0)} ms of ${TIMEOUT_MS} ms; timed-out runs: ${runs.filter((run) => run.child.timedOut).length}`,
  });
  const maxHeapUsedMiB =
    memoryRuns.length === 0
      ? null
      : Math.max(...memoryRuns.map((run) => run.child.heapUsedMiB ?? 0));
  const maxEvaluatorWallClockMs = runs.length
    ? Math.max(
        ...runs.map((run) => run.child.evaluatorWallClockMs ?? 0),
      )
    : null;

  const failedChecks = checks.filter((check) => check.passed === false);
  const overallExpectationsMet =
    failedChecks.length === 0 && allRunsMet;

  const summary: SummaryFile = {
    kind: SUMMARY_KIND,
    generatedBy: 'scripts/audience-calibrate.ts',
    generatedAt: new Date().toISOString(),
    sourceCommit: git.sha,
    dirtyFilesAtStart: git.dirtyFiles,
    node: process.version,
    level: {
      levelId: AUDIENCE_LEVEL.id,
      modelVersion: AUDIENCE_LEVEL.modelVersion,
      contentVersion: AUDIENCE_LEVEL.contentVersion,
      pricingVersion: AUDIENCE_LEVEL.pricingVersion,
      profileVersion: AUDIENCE_LEVEL.profileVersion,
      defaultSeed: AUDIENCE_LEVEL.defaultSeed,
      calibrationSeeds: [...AUDIENCE_LEVEL.calibrationSeeds],
      holdoutSeeds: [...AUDIENCE_LEVEL.holdoutSeeds],
    },
    command: [process.execPath, scriptPath, ...process.argv.slice(2)],
    outputDir,
    timeoutMs: TIMEOUT_MS,
    configuredLimits: {
      nodeMaxOldSpaceMb: NODE_MAX_OLD_SPACE_MB,
      nodeSemiSpaceMb: NODE_SEMI_SPACE_MB,
      maxRssTargetMiB: MAX_RSS_TARGET_MIB,
      wallClockMs: TIMEOUT_MS,
      note: `The child is started with --max-old-space-size=${NODE_MAX_OLD_SPACE_MB} and --max-semi-space-size=${NODE_SEMI_SPACE_MB} (V8 old-space and semi-space CLI limits). On Node 24 this pair and the Live Audience Worker API limits (maxOldGenerationSizeMb=192, maxYoungGenerationSizeMb=16, stackSizeMb=4) measured the same effective heap ceiling: 226,492,416 bytes (216 MiB). The option names are distinct; the 8 MiB semi-space is not a literal 16 MiB young generation. Observed maxRSS from process.resourceUsage() is a separate total-resident measurement and includes Node+tsx overhead; an observed maxRSS above ${MAX_RSS_TARGET_MIB} MiB fails the explicit memory check. The V8 flags do not bound browser runtime memory.`,
    },
    memoryAndPerformance: {
      observed: {
        maxRssMiB,
        maxHeapUsedMiB,
        maxProcessWallClockMs,
        maxEvaluatorWallClockMs,
        runsWithMemoryEvidence: memoryRuns.length,
        runCount: runs.length,
      },
    },
    scope: {
      fullMatrixRequested,
      families: selectedFamilies.map((family) => family.id),
      positiveSeeds: [...positiveSeeds],
      negativeSeed,
    },
    families: selectedFamilies.map((family) => ({
      id: family.id,
      fixture: family.fixture,
      fixtureClass: manifest[family.fixture]?.class ?? 'unknown',
      expected: family.expected,
      expectation: family.expectation,
    })),
    checks,
    modelConclusion: {
      note: 'Expectation evidence only. A passing matrix does not by itself prove balance, release the draft physics, or replace A101 calibration and A104 review. A model error or timeout is recorded as a failure, never as an expected negative.',
      allThreeFamiliesPassOnAllSeeds: fullMatrixRequested
        ? allThreePass
        : null,
      distinctPassingFamilies,
      minimumTwoDistinctFamilies:
        selectedPositive.length >= 2 || fullMatrixRequested
          ? distinctPassingFamilies >= 2
          : null,
      negativeExpectedConditions,
      allSelectedRunsMetExpectations: allRunsMet,
      overallExpectationsMet,
    },
    negativeWitnesses: singleAppWitness(runs),
    runs,
  };

  const summaryPath = resolve(outputDir, 'summary.json');
  writeJson(summaryPath, summary);
  console.log('');
  for (const check of checks) {
    const label =
      check.passed === null ? 'NOT-ASSESSED' : check.passed ? 'PASS' : 'FAIL';
    console.log(`${label} ${check.id}: ${check.detail}`);
  }
  const witness = summary.negativeWitnesses;
  if (witness !== null) {
    console.log(
      `single-app witness: normal=${String(
        (witness as { witness?: { normalPassed?: unknown } }).witness
          ?.normalPassed,
      )} faultFailed=${String(
        (witness as { witness?: { faultFailed?: unknown } }).witness
          ?.faultFailed,
      )}`,
    );
  }
  console.log(`summary: ${summaryPath}`);
  console.log(`overall expectations met: ${overallExpectationsMet ? 'yes' : 'NO'}`);
  if (!overallExpectationsMet) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const invokedPath = process.argv[1];
const invokedDirectly =
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.child) {
    await childMain(options);
    return;
  }
  await parentMain(options);
}

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(
      `audience-calibrate: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
