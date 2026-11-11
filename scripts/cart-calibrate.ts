/**
 * GC-018 Global Cart calibration harness.
 *
 * A repeatable, machine-readable sweep over the three candidate solution
 * families, service size profiles, the single Inventory placement and the
 * physical WAN circuit tiers, plus deliberate negative controls.
 *
 * Invariants:
 * - Every number comes from the frozen public API (`evaluateCart`). The
 *   harness never builds a partial evaluation, never skips a required case and
 *   exposes no flag that can disable, relax or re-classify a gate.
 * - Challenge membership is frozen: each result is checked against
 *   `CART_LEVEL_ID`, `CART_REQUIRED_CASES` and `CART_VERSIONS`; a mismatch is a
 *   harness failure, never a filtered-out case.
 * - Candidate families carry no preliminary verdict. A fixture that claims a
 *   pass is rejected before it is evaluated.
 * - Negative controls are expected to fail for a stated reason; the harness
 *   records whether the engine actually produced that evidence.
 *
 * Usage:
 *   npx tsx scripts/cart-calibrate.ts --out=calibration.json
 *   npx tsx scripts/cart-calibrate.ts --families=central-journal --sizes=S
 *   npx tsx scripts/cart-calibrate.ts --jobs=1 --resume --out=calibration.json
 *   npx tsx scripts/cart-calibrate.ts --emit-fixtures
 *   npx tsx scripts/cart-calibrate.ts --list
 *
 * The official measured window (90 s per case) is always used. There is no
 * shortened-window option, because that would change gate outcomes.
 *
 * Evidence retention (GC-019H1): when `--out` is given, every completed
 * evaluation is also written as its own atomically-renamed checkpoint under
 * `<out>.checkpoints/` (or `<stem>.checkpoints/` for an `--out` ending in
 * `.json`). Each checkpoint is tagged with the exact source revision, cart
 * versions, plan fingerprint, task identity, seed and graph digest. A worker
 * error is recorded as an explicit failure and does not delete evidence that
 * already completed; the matrix then reports `complete: false` and the process
 * exits nonzero, so it can never be read as a calibration PASS. `--resume`
 * reuses a checkpoint only after its provenance matches the current source,
 * versions and plan; stale or mismatched checkpoints are rejected and the task
 * is re-evaluated. `--jobs=1` is the bounded sequential rerun; concurrency is
 * deliberately not part of the plan fingerprint, because `jobs` never changes
 * the official cases, windows, gates, caps or seeds.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
  CART_CATALOG,
  CART_CIRCUIT_MBPS,
  CART_LEVEL_ID,
  CART_REQUIRED_CASES,
  CART_REGIONS,
  CART_SERVICE_SIZES,
  CART_VERSIONS,
  canonicalJson,
  evaluateCart,
  isCartStructuralIssue,
  parseCartGraph,
  sha256Hex,
  validateCartGraph,
  type CartCaseId,
  type CartCircuitMbps,
  type CartEvaluation,
  type CartGate,
  type CartGraph,
  type CartRegion,
  type CartServiceSize,
} from '../src/cart';

// ---------------------------------------------------------------------------
// Public evidence shapes
// ---------------------------------------------------------------------------

export type CandidateFamily = 'central-journal' | 'replicated-stores' | 'parallel-cache';
export type NegativeControlId =
  | 'central-synchronous'
  | 'stale-cache'
  | 'undercapacity'
  | 'over-budget';
export type SizeProfile = CartServiceSize;

export interface CalibrationPlan {
  readonly schemaVersion: 1;
  readonly seeds: readonly number[];
  readonly families: readonly CandidateFamily[];
  readonly sizes: readonly SizeProfile[];
  readonly placements: readonly CartRegion[];
  readonly tiers: readonly CartCircuitMbps[];
  readonly controls: readonly NegativeControlId[];
  readonly jobs: number;
}

export interface CaseEvidence {
  readonly id: CartCaseId;
  readonly issued: number;
  readonly scheduled: number;
  readonly complete: boolean;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly resources: Readonly<Record<string, number>>;
  readonly cost: Readonly<Record<string, number>>;
  readonly failedGates: readonly string[];
  readonly gates: readonly {
    readonly code: string;
    readonly region: string;
    readonly operation: string;
    readonly cohort: string;
    readonly observed: number;
    readonly limit: number;
    readonly pass: boolean;
    readonly evidenceCount: number;
  }[];
}

export interface RunEvidence {
  readonly id: string;
  readonly kind: 'candidate' | 'negative-control';
  readonly family: string;
  readonly size: SizeProfile | null;
  readonly placement: CartRegion;
  readonly tierMbps: CartCircuitMbps;
  readonly seed: number;
  readonly sourceSha: string;
  readonly sourceDirty: boolean;
  readonly nodeVersion: string;
  readonly versions: typeof CART_VERSIONS;
  readonly graphDigest: string;
  readonly graphSha256: string;
  readonly structuralIssues: readonly string[];
  readonly issueCodes: readonly string[];
  readonly complete: boolean;
  readonly qualified: boolean;
  readonly scoreCreditsPerHour: number | null;
  readonly peakCreditsPerHour: number | null;
  readonly budgetCreditsPerHour: number;
  readonly executionMs: number;
  readonly failedGateCount: number;
  readonly cases: readonly CaseEvidence[];
  readonly graph: CartGraph;
}

export interface ControlEvidence {
  readonly id: NegativeControlId;
  readonly title: string;
  readonly expectation: string;
  readonly expectationMet: boolean;
  readonly detail: string;
}

export interface CalibrationReport {
  readonly generatedBy: string;
  readonly schemaVersion: 1;
  readonly sourceSha: string;
  readonly sourceDirty: boolean;
  readonly nodeVersion: string;
  readonly versions: typeof CART_VERSIONS;
  readonly plan: CalibrationPlan;
  readonly generatedAt: string;
  readonly official: {
    readonly levelId: string;
    readonly requiredCases: readonly CartCaseId[];
    readonly budgetCreditsPerHour: number;
    readonly measuredCaseMs: number;
  };
  readonly runs: readonly RunEvidence[];
  /** Planned evaluations that raised a worker/checkpoint error in this attempt. */
  readonly failures: readonly CalibrationFailure[];
  /** Planned evaluations with neither evidence nor an explicit failure. */
  readonly missing: readonly string[];
  readonly checkpoints: CalibrationCheckpointSummary;
  /** True only when every planned evaluation has durable evidence. */
  readonly complete: boolean;
  readonly controls: readonly ControlEvidence[];
  readonly checks: readonly {
    readonly id: string;
    readonly passed: boolean;
    readonly detail: string;
  }[];
  readonly totals: {
    readonly planned: number;
    readonly runs: number;
    readonly matrixMs: number;
    readonly evaluationMs: number;
    readonly qualifiedCandidates: number;
    readonly failingCandidates: number;
  };
  readonly conclusion: {
    readonly familiesRepresented: boolean;
    readonly controlsRepresented: boolean;
    readonly controlsFailAsDesigned: boolean;
    readonly officialMembershipPreserved: boolean;
    readonly gateIntegrityPreserved: boolean;
    readonly matrixComplete: boolean;
    readonly calibrationPass: boolean;
  };
}

/**
 * One durable, independently replaceable unit of calibration evidence.
 *
 * A checkpoint holds exactly one completed evaluation plus the provenance
 * needed to decide, without re-running anything, whether it may be reused for
 * the current plan at the current source revision. It intentionally stores no
 * verdict that the engine did not produce.
 */
export interface CalibrationCheckpoint {
  readonly schemaVersion: 1;
  readonly kind: 'cart-calibration-checkpoint';
  readonly generatedBy: 'scripts/cart-calibrate.ts';
  readonly planDigest: string;
  readonly sourceSha: string;
  readonly sourceDirty: boolean;
  readonly nodeVersion: string;
  readonly versions: typeof CART_VERSIONS;
  readonly task: {
    readonly id: string;
    readonly kind: 'candidate' | 'negative-control';
    readonly family: string;
    readonly size: SizeProfile | null;
    readonly placement: CartRegion;
    readonly tierMbps: CartCircuitMbps;
    readonly seed: number;
    readonly graphSha256: string;
  };
  readonly writtenAt: string;
  readonly run: RunEvidence;
}

export interface CalibrationFailure {
  readonly id: string;
  readonly error: string;
}

export interface CalibrationCheckpointSummary {
  /** Absolute checkpoint directory, or null when no `--out` path was given. */
  readonly directory: string | null;
  /** Checkpoints written from evaluations completed in this attempt. */
  readonly written: number;
  /** Checkpoints reused from a previous attempt after provenance validation. */
  readonly reused: number;
  /** Existing checkpoints that failed provenance validation and were re-run. */
  readonly rejected: readonly { readonly taskId: string; readonly reason: string }[];
}

export interface CalibrationExecution {
  /** Completed evidence, in plan order; failed tasks leave a sparse slot. */
  readonly runs: readonly RunEvidence[];
  readonly failures: readonly CalibrationFailure[];
  readonly missing: readonly string[];
  readonly checkpoints: CalibrationCheckpointSummary;
}

export interface MatrixSummary {
  readonly familiesRepresented: boolean;
  readonly controlsRepresented: boolean;
  readonly controlsFailAsDesigned: boolean;
  readonly officialMembershipPreserved: boolean;
  readonly gateIntegrityPreserved: boolean;
  /** Every planned evaluation has evidence and no task is failed or missing. */
  readonly matrixComplete: boolean;
  readonly missingTaskIds: readonly string[];
  /** The only condition under which the harness may report a calibration PASS. */
  readonly calibrationPass: boolean;
}

// ---------------------------------------------------------------------------
// Fixture shapes and builders
// ---------------------------------------------------------------------------

export interface CandidateFixture {
  readonly id: string;
  readonly kind: 'candidate';
  readonly family: CandidateFamily;
  readonly title: string;
  readonly description: string;
  /** Always null: a topology may not be labelled passing before measurement. */
  readonly preliminaryVerdict: null;
  readonly sweep: { readonly sizes: true; readonly placements: true; readonly tiers: true };
  readonly graph: CartGraph;
}

export interface ControlFixture {
  readonly id: string;
  readonly kind: 'negative-control';
  readonly control: NegativeControlId;
  readonly title: string;
  readonly expectation: string;
  readonly preliminaryVerdict: null;
  readonly graph: CartGraph;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(HERE, '../tests/fixtures/cart');
const CANDIDATE_DIR = resolve(FIXTURES_ROOT, 'candidates');
const CONTROL_DIR = resolve(FIXTURES_ROOT, 'negative-controls');
const CALIBRATION_DIR = resolve(FIXTURES_ROOT, 'calibration');

const REGION_INDEX: Readonly<Record<CartRegion, number>> = {
  'us-west': 0,
  'eu-central': 1,
  'ap-northeast': 2,
};

function position(region: CartRegion, column: number): { x: number; y: number } {
  return { x: 120 + REGION_INDEX[region] * 400 + column * 40, y: 80 + column * 120 };
}

function customersId(region: CartRegion): string {
  return `customers-${region}`;
}

function appId(region: CartRegion): string {
  return `app-${region}`;
}

function journalId(region: CartRegion): string {
  return `journal-${region}`;
}

function storeId(region: CartRegion): string {
  return `store-${region}`;
}

function cacheId(region: CartRegion): string {
  return `cache-${region}`;
}

function commonNodes(placement: CartRegion): unknown[] {
  return [
    ...CART_REGIONS.map((region) => ({
      id: customersId(region),
      kind: 'customers',
      region,
      position: { x: 120 + REGION_INDEX[region] * 400, y: 40 },
    })),
    {
      id: 'inventory',
      kind: 'inventory',
      region: placement,
      position: position(placement, 3),
      size: 'M',
    },
  ];
}

const ALL_PAIRS: ReadonlyArray<readonly [CartRegion, CartRegion]> = [
  ['us-west', 'eu-central'],
  ['us-west', 'ap-northeast'],
  ['eu-central', 'ap-northeast'],
];

function circuits(tier: CartCircuitMbps): unknown[] {
  return ALL_PAIRS.map((regions) => ({ regions, mbps: tier }));
}

interface BuildOptions {
  readonly size: SizeProfile;
  readonly placement: CartRegion;
  readonly tier: CartCircuitMbps;
}

function scale(size: SizeProfile): { size: SizeProfile; instances: number } {
  return size === 'S' ? { size: 'S', instances: 1 } : { size: 'M', instances: 2 };
}

/** Family A: regional journals acknowledge locally; one central store holds the union. */
function buildCentralJournal({ size, placement, tier }: BuildOptions): unknown {
  const { size: nodeSize, instances } = scale(size);
  const store = 'store-central';
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes: [
      ...commonNodes(placement),
      ...CART_REGIONS.map((region) => ({
        id: appId(region),
        kind: 'application',
        region,
        position: position(region, 1),
        size: nodeSize,
        instances,
        writeTarget: journalId(region),
        readPolicy: 'local-repair',
        readTargets: [journalId(region)],
      })),
      ...CART_REGIONS.map((region) => ({
        id: journalId(region),
        kind: 'journal',
        region,
        position: position(region, 2),
        size: nodeSize,
      })),
      {
        id: store,
        kind: 'store',
        region: 'us-west',
        position: position('us-west', 4),
        size: nodeSize,
      },
    ],
    edges: [
      ...CART_REGIONS.map((region) => ({
        id: `src-${region}`,
        from: customersId(region),
        to: appId(region),
        kind: 'request',
      })),
      ...CART_REGIONS.map((region) => ({
        id: `ack-${region}`,
        from: appId(region),
        to: journalId(region),
        kind: 'request',
      })),
      ...CART_REGIONS.map((region) => ({
        id: `replicate-${region}`,
        from: journalId(region),
        to: store,
        kind: 'replication',
      })),
      ...CART_REGIONS.map((region) => ({
        id: `inventory-${region}`,
        from: appId(region),
        to: 'inventory',
        kind: 'request',
      })),
    ],
    circuits: circuits(tier),
  };
}

/** Family B: every region runs an active store; stores replicate to each other. */
function buildReplicatedStores({ size, placement, tier }: BuildOptions): unknown {
  const { size: nodeSize, instances } = scale(size);
  const replication: unknown[] = [];
  for (const [left, right] of ALL_PAIRS) {
    replication.push({
      id: `replicate-${left}-${right}`,
      from: storeId(left),
      to: storeId(right),
      kind: 'replication',
    });
    replication.push({
      id: `replicate-${right}-${left}`,
      from: storeId(right),
      to: storeId(left),
      kind: 'replication',
    });
  }
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes: [
      ...commonNodes(placement),
      ...CART_REGIONS.map((region) => ({
        id: appId(region),
        kind: 'application',
        region,
        position: position(region, 1),
        size: nodeSize,
        instances,
        writeTarget: storeId(region),
        readPolicy: 'parallel',
        readTargets: [storeId(region)],
      })),
      ...CART_REGIONS.map((region) => ({
        id: storeId(region),
        kind: 'store',
        region,
        position: position(region, 2),
        size: nodeSize,
      })),
    ],
    edges: [
      ...CART_REGIONS.map((region) => ({
        id: `src-${region}`,
        from: customersId(region),
        to: appId(region),
        kind: 'request',
      })),
      ...CART_REGIONS.map((region) => ({
        id: `ack-${region}`,
        from: appId(region),
        to: storeId(region),
        kind: 'request',
      })),
      ...replication,
      ...CART_REGIONS.map((region) => ({
        id: `inventory-${region}`,
        from: appId(region),
        to: 'inventory',
        kind: 'request',
      })),
    ],
    circuits: circuits(tier),
  };
}

/** Family C: regional journals plus a volatile cache; reads fan out in parallel. */
function buildParallelCache({ size, placement, tier }: BuildOptions): unknown {
  const { size: nodeSize, instances } = scale(size);
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes: [
      ...commonNodes(placement),
      ...CART_REGIONS.map((region) => ({
        id: appId(region),
        kind: 'application',
        region,
        position: position(region, 1),
        size: nodeSize,
        instances,
        writeTarget: journalId(region),
        readPolicy: 'parallel',
        readTargets: [...CART_REGIONS.map((target) => journalId(target))],
      })),
      ...CART_REGIONS.map((region) => ({
        id: journalId(region),
        kind: 'journal',
        region,
        position: position(region, 3),
        size: nodeSize,
      })),
      ...CART_REGIONS.map((region) => ({
        id: cacheId(region),
        kind: 'cache',
        region,
        position: position(region, 2),
        size: nodeSize,
      })),
    ],
    edges: [
      ...CART_REGIONS.map((region) => ({
        id: `src-${region}`,
        from: customersId(region),
        to: appId(region),
        kind: 'request',
      })),
      ...CART_REGIONS.map((region) => ({
        id: `ack-${region}`,
        from: appId(region),
        to: journalId(region),
        kind: 'request',
      })),
      ...CART_REGIONS.flatMap((region) =>
        CART_REGIONS.filter((target) => target !== region).map((target) => ({
          id: `fanout-${region}-${target}`,
          from: appId(region),
          to: journalId(target),
          kind: 'request',
        })),
      ),
      ...CART_REGIONS.map((region) => ({
        id: `cache-read-${region}`,
        from: appId(region),
        to: cacheId(region),
        kind: 'request',
      })),
      ...CART_REGIONS.map((region) => ({
        id: `inventory-${region}`,
        from: appId(region),
        to: 'inventory',
        kind: 'request',
      })),
    ],
    circuits: circuits(tier),
  };
}

const CONTROL_PLACEMENT: CartRegion = 'us-west';
const CONTROL_TIER: CartCircuitMbps = 8;

function buildCentralSynchronous(): unknown {
  const store = 'journal-central';
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes: [
      ...commonNodes(CONTROL_PLACEMENT),
      ...CART_REGIONS.map((region) => ({
        id: appId(region),
        kind: 'application',
        region,
        position: position(region, 1),
        size: 'M',
        instances: 1,
        writeTarget: store,
        readPolicy: 'local-repair',
        readTargets: [store],
      })),
      { id: store, kind: 'journal', region: 'us-west', position: position('us-west', 2), size: 'M' },
    ],
    edges: [
      ...CART_REGIONS.map((region) => ({
        id: `src-${region}`,
        from: customersId(region),
        to: appId(region),
        kind: 'request',
      })),
      ...CART_REGIONS.map((region) => ({
        id: `central-write-${region}`,
        from: appId(region),
        to: store,
        kind: 'request',
      })),
      ...CART_REGIONS.map((region) => ({
        id: `inventory-${region}`,
        from: appId(region),
        to: 'inventory',
        kind: 'request',
      })),
    ],
    circuits: circuits(CONTROL_TIER),
  };
}

function buildStaleCache(): unknown {
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes: [
      ...commonNodes(CONTROL_PLACEMENT),
      ...CART_REGIONS.map((region) => ({
        id: appId(region),
        kind: 'application',
        region,
        position: position(region, 1),
        size: 'M',
        instances: 1,
        writeTarget: journalId(region),
        // Deliberate defect: a 1 s volatile cache is named as the read-repair
        // authority. The engine must reject a cache as a certificate source.
        readPolicy: 'local-repair',
        readTargets: [cacheId(region)],
      })),
      ...CART_REGIONS.map((region) => ({
        id: journalId(region),
        kind: 'journal',
        region,
        position: position(region, 3),
        size: 'M',
      })),
      ...CART_REGIONS.map((region) => ({
        id: cacheId(region),
        kind: 'cache',
        region,
        position: position(region, 2),
        size: 'M',
      })),
    ],
    edges: [
      ...CART_REGIONS.map((region) => ({
        id: `src-${region}`,
        from: customersId(region),
        to: appId(region),
        kind: 'request',
      })),
      ...CART_REGIONS.map((region) => ({
        id: `ack-${region}`,
        from: appId(region),
        to: journalId(region),
        kind: 'request',
      })),
      ...CART_REGIONS.map((region) => ({
        id: `cache-read-${region}`,
        from: appId(region),
        to: cacheId(region),
        kind: 'request',
      })),
      ...CART_REGIONS.map((region) => ({
        id: `inventory-${region}`,
        from: appId(region),
        to: 'inventory',
        kind: 'request',
      })),
    ],
    circuits: circuits(CONTROL_TIER),
  };
}

function buildUndercapacity(): unknown {
  return buildCentralJournal({ size: 'S', placement: 'ap-northeast', tier: 2 });
}

/** Maximum static density: the proposed 6 credit/hour budget cannot hold it. */
function buildOverBudget(): unknown {
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes: [
      ...commonNodes(CONTROL_PLACEMENT),
      ...CART_REGIONS.map((region) => ({
        id: appId(region),
        kind: 'application',
        region,
        position: position(region, 1),
        size: 'M',
        instances: 2,
        writeTarget: storeId(region),
        readPolicy: 'parallel',
        readTargets: [storeId(region), journalId(region)],
      })),
      ...CART_REGIONS.map((region) => ({
        id: storeId(region),
        kind: 'store',
        region,
        position: position(region, 2),
        size: 'M',
      })),
      ...CART_REGIONS.map((region) => ({
        id: journalId(region),
        kind: 'journal',
        region,
        position: position(region, 3),
        size: 'M',
      })),
      ...CART_REGIONS.map((region) => ({
        id: cacheId(region),
        kind: 'cache',
        region,
        position: position(region, 4),
        size: 'M',
      })),
    ],
    edges: [
      ...CART_REGIONS.map((region) => ({
        id: `src-${region}`,
        from: customersId(region),
        to: appId(region),
        kind: 'request',
      })),
      ...CART_REGIONS.map((region) => ({
        id: `ack-${region}`,
        from: appId(region),
        to: storeId(region),
        kind: 'request',
      })),
      ...CART_REGIONS.map((region) => ({
        id: `read-${region}`,
        from: appId(region),
        to: journalId(region),
        kind: 'request',
      })),
      ...CART_REGIONS.map((region) => ({
        id: `inventory-${region}`,
        from: appId(region),
        to: 'inventory',
        kind: 'request',
      })),
    ],
    circuits: circuits(32),
  };
}

function requireGraph(value: unknown, label: string): CartGraph {
  const parsed = parseCartGraph(value);
  if (!parsed.ok) {
    throw new Error(
      `${label} is not a valid cart graph: ${parsed.issues.map((issue) => issue.code).join(', ')}`,
    );
  }
  return parsed.graph;
}

const CANDIDATE_SPECS: readonly {
  readonly id: string;
  readonly family: CandidateFamily;
  readonly title: string;
  readonly description: string;
  readonly build: (options: BuildOptions) => unknown;
}[] = [
  {
    id: 'family-a-central-journal',
    family: 'central-journal',
    title: 'Family A — regional journals and a central store',
    description:
      'Each Application acknowledges a local durable journal; journals replicate to one central store. Inventory placement is swept independently.',
    build: buildCentralJournal,
  },
  {
    id: 'family-b-replicated-stores',
    family: 'replicated-stores',
    title: 'Family B — replicated regional stores',
    description:
      'Every region runs an active cart store and each store replicates both directions with its peers. Inventory placement is swept independently.',
    build: buildReplicatedStores,
  },
  {
    id: 'family-c-parallel-cache',
    family: 'parallel-cache',
    title: 'Family C — parallel reads and regional caches',
    description:
      'Applications acknowledge local journals and fan reads out in parallel to every regional journal, with a volatile regional cache attached.',
    build: buildParallelCache,
  },
];

const CONTROL_SPECS: readonly {
  readonly id: string;
  readonly control: NegativeControlId;
  readonly title: string;
  readonly expectation: string;
  readonly build: () => unknown;
}[] = [
  {
    id: 'control-central-synchronous',
    control: 'central-synchronous',
    title: 'Central synchronous writes',
    expectation:
      'Every region writes synchronously to one central journal, so the design must not qualify: cross-region write latency and shared serial durability show up in the gates.',
    build: buildCentralSynchronous,
  },
  {
    id: 'control-stale-cache',
    control: 'stale-cache',
    title: 'Stale-cache reads',
    expectation:
      'A 1 s volatile cache is named as the read-repair authority, so semantic validation must reject a cache certificate and the design must not qualify.',
    build: buildStaleCache,
  },
  {
    id: 'control-undercapacity',
    control: 'undercapacity',
    title: 'Undercapacity',
    expectation:
      'Small single-instance services on 2 Mbit circuits with the Inventory farthest away must fail at least one performance gate in the peak case.',
    build: buildUndercapacity,
  },
  {
    id: 'control-over-budget',
    control: 'over-budget',
    title: 'Over-budget density',
    expectation:
      'The densest legal topology at the 32 Mbit tier must measure a peak cost above the 6 credit/hour budget.',
    build: buildOverBudget,
  },
];

export function buildCandidateFixtures(): CandidateFixture[] {
  return CANDIDATE_SPECS.map((spec) => ({
    id: spec.id,
    kind: 'candidate',
    family: spec.family,
    title: spec.title,
    description: spec.description,
    preliminaryVerdict: null,
    sweep: { sizes: true, placements: true, tiers: true },
    graph: requireGraph(
      spec.build({ size: 'M', placement: 'us-west', tier: 8 }),
      spec.id,
    ),
  }));
}

export function buildControlFixtures(): ControlFixture[] {
  return CONTROL_SPECS.map((spec) => ({
    id: spec.id,
    kind: 'negative-control',
    control: spec.control,
    title: spec.title,
    expectation: spec.expectation,
    preliminaryVerdict: null,
    graph: requireGraph(spec.build(), spec.id),
  }));
}

export function defaultPlan(): CalibrationPlan {
  return normalizePlan(readPlanFile());
}

function readPlanFile(): Partial<CalibrationPlan> {
  const planPath = resolve(CALIBRATION_DIR, 'plan.json');
  if (!existsSync(planPath)) return {};
  return JSON.parse(readFileSync(planPath, 'utf8')) as Partial<CalibrationPlan>;
}

function normalizePlan(raw: Partial<CalibrationPlan>): CalibrationPlan {
  const families = raw.families ?? CANDIDATE_SPECS.map((spec) => spec.family);
  const sizes = raw.sizes ?? [...CART_SERVICE_SIZES];
  const placements = raw.placements ?? [...CART_REGIONS];
  const tiers = raw.tiers ?? [...CART_CIRCUIT_MBPS];
  const seeds = raw.seeds ?? [1729];
  const controls = raw.controls ?? CONTROL_SPECS.map((spec) => spec.control);
  const jobs = raw.jobs ?? 6;
  const unknownFamily = families.find(
    (family) => !CANDIDATE_SPECS.some((spec) => spec.family === family),
  );
  if (unknownFamily !== undefined) throw new Error(`unknown candidate family: ${unknownFamily}`);
  const unknownControl = controls.find(
    (control) => !CONTROL_SPECS.some((spec) => spec.control === control),
  );
  if (unknownControl !== undefined) throw new Error(`unknown negative control: ${unknownControl}`);
  const badSize = sizes.find((size) => !CART_SERVICE_SIZES.includes(size));
  if (badSize !== undefined) throw new Error(`unknown service size: ${badSize}`);
  const badPlacement = placements.find((region) => !CART_REGIONS.includes(region));
  if (badPlacement !== undefined) throw new Error(`unknown region: ${badPlacement}`);
  const badTier = tiers.find((tier) => !CART_CIRCUIT_MBPS.includes(tier));
  if (badTier !== undefined) throw new Error(`unsupported circuit tier: ${badTier}`);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) {
    throw new Error('jobs must be an integer between 1 and 16');
  }
  if (seeds.length === 0 || seeds.some((seed) => !Number.isInteger(seed) || seed < 0)) {
    throw new Error('seeds must be non-negative integers');
  }
  return { schemaVersion: 1, seeds, families, sizes, placements, tiers, controls, jobs };
}

// ---------------------------------------------------------------------------
// Dimension overrides (documented, deterministic, topology-preserving)
// ---------------------------------------------------------------------------

export function applyOverrides(
  graph: CartGraph,
  options: { readonly size: SizeProfile; readonly placement: CartRegion; readonly tier: CartCircuitMbps },
): CartGraph {
  const copy = JSON.parse(JSON.stringify(graph)) as CartGraph;
  const { size, instances } = scale(options.size);
  for (const node of copy.nodes) {
    if (node.kind === 'inventory') {
      node.region = options.placement;
      node.position = position(options.placement, 3);
    }
    if ('size' in node) node.size = size;
    if (node.kind === 'application') node.instances = instances;
  }
  for (const circuit of copy.circuits) {
    circuit.mbps = options.tier;
  }
  const parsed = parseCartGraph(copy);
  if (!parsed.ok) {
    throw new Error(
      `overridden graph is invalid: ${parsed.issues.map((issue) => issue.code).join(', ')}`,
    );
  }
  return parsed.graph;
}

// ---------------------------------------------------------------------------
// Evaluation summary (shared by workers and the main thread)
// ---------------------------------------------------------------------------

function summarizeGate(gate: CartGate): CaseEvidence['gates'][number] {
  return {
    code: gate.code,
    region: gate.region,
    operation: gate.operation,
    cohort: gate.cohort,
    observed: gate.observed,
    limit: gate.limit,
    pass: gate.pass,
    evidenceCount: gate.evidenceIds.length,
  };
}

/**
 * The only transformation of an official result. Every field is copied from
 * the engine evaluation; no caller can pass a verdict or mutate a gate.
 */
export function summarizeEvaluation(
  evaluation: CartEvaluation,
  context: {
    readonly id: string;
    readonly kind: 'candidate' | 'negative-control';
    readonly family: string;
    readonly size: SizeProfile | null;
    readonly placement: CartRegion;
    readonly tierMbps: CartCircuitMbps;
    readonly seed: number;
    readonly graph: CartGraph;
    readonly executionMs: number;
  },
  source: { readonly sha: string; readonly dirty: boolean },
): RunEvidence {
  if (evaluation.levelId !== CART_LEVEL_ID) {
    throw new Error(`official level identity changed: ${evaluation.levelId}`);
  }
  if (canonicalJson(evaluation.requiredCases) !== canonicalJson([...CART_REQUIRED_CASES])) {
    throw new Error('official required-case membership changed');
  }
  if (canonicalJson(evaluation.versions) !== canonicalJson(CART_VERSIONS)) {
    throw new Error('official cart versions changed');
  }
  const peak = evaluation.cases.find((entry) => entry.id === 'peak');
  const peakCreditsPerHour = peak?.cost.peakScoreCreditsPerHour ?? null;
  return {
    id: context.id,
    kind: context.kind,
    family: context.family,
    size: context.size,
    placement: context.placement,
    tierMbps: context.tierMbps,
    seed: context.seed,
    sourceSha: source.sha,
    sourceDirty: source.dirty,
    nodeVersion: process.version,
    versions: { ...CART_VERSIONS },
    graphDigest: evaluation.graphDigest,
    graphSha256: sha256Hex(canonicalJson(context.graph)),
    structuralIssues: validateCartGraph(context.graph)
      .filter((issue) => isCartStructuralIssue(issue))
      .map((issue) => issue.code),
    issueCodes: evaluation.issues.map((issue) => issue.code),
    complete: evaluation.complete,
    qualified: evaluation.qualified,
    scoreCreditsPerHour: evaluation.scoreCreditsPerHour,
    peakCreditsPerHour,
    budgetCreditsPerHour: CART_CATALOG.budget.creditsPerHour,
    executionMs: Math.round(context.executionMs),
    failedGateCount: evaluation.cases.reduce(
      (total, entry) => total + entry.gates.filter((gate) => !gate.pass).length,
      0,
    ),
    cases: evaluation.cases.map((entry) => ({
      id: entry.id,
      issued: entry.issued,
      scheduled: entry.scheduled,
      complete: entry.complete,
      outcomes: { ...entry.outcomes },
      resources: { ...entry.resources },
      cost: { ...entry.cost },
      failedGates: entry.gates.filter((gate) => !gate.pass).map((gate) => gate.code),
      gates: entry.gates.map(summarizeGate),
    })),
    graph: context.graph,
  };
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

export interface WorkerTask {
  readonly id: string;
  readonly kind: 'candidate' | 'negative-control';
  readonly family: string;
  readonly size: SizeProfile | null;
  readonly placement: CartRegion;
  readonly tierMbps: CartCircuitMbps;
  readonly seed: number;
  readonly graph: CartGraph;
}

interface WorkerRequest {
  readonly task: WorkerTask;
  readonly source: { readonly sha: string; readonly dirty: boolean };
}

interface WorkerResponse {
  readonly ok: boolean;
  readonly run?: RunEvidence;
  readonly error?: string;
}

async function runTask(request: WorkerRequest): Promise<RunEvidence> {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: request });
    let settled = false;
    worker.once('message', (message: WorkerResponse) => {
      if (!settled) {
        settled = true;
        if (message.ok && message.run !== undefined) resolvePromise(message.run);
        else reject(new Error(message.error ?? 'cart calibration worker failed'));
      }
      void worker.terminate();
    });
    worker.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    worker.once('exit', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`cart calibration worker exited with code ${code}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Durable per-evaluation checkpoints
// ---------------------------------------------------------------------------

/** Bound for one checkpoint file. Evidence above it fails loudly, never truncates. */
export const CHECKPOINT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Plan fingerprint used for checkpoint provenance.
 *
 * `jobs` is deliberately excluded: concurrency changes neither the official
 * cases, windows, gates, caps nor seeds, so a `--jobs=1` rerun must be able to
 * reuse evidence produced by a wider pool (and vice versa). Everything that
 * could change an outcome is included and order-sensitive.
 */
export function planFingerprint(plan: CalibrationPlan): string {
  return sha256Hex(
    canonicalJson({
      schemaVersion: plan.schemaVersion,
      seeds: plan.seeds,
      families: plan.families,
      sizes: plan.sizes,
      placements: plan.placements,
      tiers: plan.tiers,
      controls: plan.controls,
    }),
  );
}

export function taskGraphSha256(task: WorkerTask): string {
  return sha256Hex(canonicalJson(task.graph));
}

/** `<out>.checkpoints/`, or `<stem>.checkpoints/` when out ends in `.json`. */
export function checkpointDirectory(outPath: string): string {
  const absolute = resolve(outPath);
  return absolute.endsWith('.json')
    ? resolve(dirname(absolute), `${basename(absolute, '.json')}.checkpoints`)
    : `${absolute}.checkpoints`;
}

function checkpointPath(directory: string, taskId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._=-]*$/.test(taskId) || taskId.includes('..')) {
    throw new Error(`task id ${taskId} is not a safe checkpoint file name`);
  }
  return resolve(directory, `${taskId}.json`);
}

/**
 * Atomically publish one checkpoint: write a sibling temp file, then rename it
 * onto the final name. A crash leaves either no file or the previous complete
 * file at the target path, never a half-written checkpoint.
 */
export function writeCheckpoint(directory: string, checkpoint: CalibrationCheckpoint): string {
  const path = checkpointPath(directory, checkpoint.task.id);
  const text = `${JSON.stringify(checkpoint, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > CHECKPOINT_MAX_BYTES) {
    throw new Error(
      `checkpoint for ${checkpoint.task.id} is ${bytes} bytes, above the ${CHECKPOINT_MAX_BYTES}-byte evidence bound`,
    );
  }
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The rename may already have consumed the temp file; cleanup is best effort.
    }
    throw error;
  }
  return path;
}

export interface CheckpointRead {
  readonly path: string;
  readonly existed: boolean;
  readonly checkpoint?: CalibrationCheckpoint;
  readonly reason?: string;
}

/** A non-null, non-array object, the only shape checkpoint records may take. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isFiniteNumber);
}

function isVersionRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isCaseEvidence(value: unknown): value is CaseEvidence {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    isFiniteNumber(value.issued) &&
    isFiniteNumber(value.scheduled) &&
    typeof value.complete === 'boolean' &&
    isNumberRecord(value.outcomes) &&
    isNumberRecord(value.resources) &&
    isNumberRecord(value.cost) &&
    isStringArray(value.failedGates) &&
    Array.isArray(value.gates) &&
    value.gates.every(
      (gate) =>
        isRecord(gate) &&
        typeof gate.code === 'string' &&
        typeof gate.region === 'string' &&
        typeof gate.operation === 'string' &&
        typeof gate.cohort === 'string' &&
        isFiniteNumber(gate.observed) &&
        isFiniteNumber(gate.limit) &&
        typeof gate.pass === 'boolean' &&
        isFiniteNumber(gate.evidenceCount),
    )
  );
}

/**
 * Strict structural validation of stored run evidence.
 *
 * Every field that `checkpointRejection` or the report path dereferences is
 * checked here, so a malformed-but-parseable checkpoint is treated as
 * `existed: true, reason: schema mismatch` and re-evaluated instead of throwing
 * inside provenance validation and aborting the whole matrix.
 */
function isRunEvidence(value: unknown): value is RunEvidence {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    (value.kind === 'candidate' || value.kind === 'negative-control') &&
    typeof value.family === 'string' &&
    (value.size === null || typeof value.size === 'string') &&
    typeof value.placement === 'string' &&
    isFiniteNumber(value.tierMbps) &&
    isFiniteNumber(value.seed) &&
    typeof value.sourceSha === 'string' &&
    typeof value.sourceDirty === 'boolean' &&
    typeof value.nodeVersion === 'string' &&
    isVersionRecord(value.versions) &&
    typeof value.graphDigest === 'string' &&
    typeof value.graphSha256 === 'string' &&
    isStringArray(value.structuralIssues) &&
    isStringArray(value.issueCodes) &&
    typeof value.complete === 'boolean' &&
    typeof value.qualified === 'boolean' &&
    isOptionalFiniteNumber(value.scoreCreditsPerHour) &&
    isOptionalFiniteNumber(value.peakCreditsPerHour) &&
    isFiniteNumber(value.budgetCreditsPerHour) &&
    isFiniteNumber(value.executionMs) &&
    isFiniteNumber(value.failedGateCount) &&
    Array.isArray(value.cases) &&
    value.cases.every(isCaseEvidence) &&
    isRecord(value.graph)
  );
}

function isCheckpointTask(value: unknown): value is CalibrationCheckpoint['task'] {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    (value.kind === 'candidate' || value.kind === 'negative-control') &&
    typeof value.family === 'string' &&
    (value.size === null || typeof value.size === 'string') &&
    typeof value.placement === 'string' &&
    isFiniteNumber(value.tierMbps) &&
    isFiniteNumber(value.seed) &&
    typeof value.graphSha256 === 'string'
  );
}

function isCheckpoint(value: unknown): value is CalibrationCheckpoint {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    value.kind === 'cart-calibration-checkpoint' &&
    value.generatedBy === 'scripts/cart-calibrate.ts' &&
    typeof value.planDigest === 'string' &&
    typeof value.sourceSha === 'string' &&
    typeof value.sourceDirty === 'boolean' &&
    typeof value.nodeVersion === 'string' &&
    isVersionRecord(value.versions) &&
    typeof value.writtenAt === 'string' &&
    isCheckpointTask(value.task) &&
    isRunEvidence(value.run)
  );
}

export function readCheckpoint(directory: string, taskId: string): CheckpointRead {
  const path = checkpointPath(directory, taskId);
  if (!existsSync(path)) return { path, existed: false, reason: 'no checkpoint for this task' };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isCheckpoint(parsed)) {
      return { path, existed: true, reason: 'checkpoint does not match the checkpoint schema' };
    }
    return { path, existed: true, checkpoint: parsed };
  } catch (error) {
    return {
      path,
      existed: true,
      reason: `unreadable checkpoint JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Decide whether a stored checkpoint may be reused for `task` in this attempt.
 * Returns null when it matches exactly, otherwise a human-readable rejection.
 * A dirty tree is never resumable: the evidence cannot be tied to a revision.
 */
export function checkpointRejection(
  checkpoint: CalibrationCheckpoint,
  task: WorkerTask,
  expected: { readonly planDigest: string; readonly source: WorkerRequest['source'] },
): string | null {
  if (checkpoint.planDigest !== expected.planDigest) {
    return `plan fingerprint ${checkpoint.planDigest} does not match ${expected.planDigest}`;
  }
  if (checkpoint.sourceDirty || expected.source.dirty) {
    return 'checkpoint or current working tree is dirty, so provenance cannot be validated';
  }
  if (checkpoint.sourceSha !== expected.source.sha) {
    return `source ${checkpoint.sourceSha} does not match ${expected.source.sha}`;
  }
  if (canonicalJson(checkpoint.versions) !== canonicalJson(CART_VERSIONS)) {
    return 'cart versions changed since the checkpoint was written';
  }
  if (checkpoint.nodeVersion !== process.version) {
    return `checkpoint runtime ${checkpoint.nodeVersion} does not match ${process.version}`;
  }
  const graphSha256 = taskGraphSha256(task);
  const expectedTask = {
    id: task.id,
    kind: task.kind,
    family: task.family,
    size: task.size,
    placement: task.placement,
    tierMbps: task.tierMbps,
    seed: task.seed,
    graphSha256,
  };
  if (canonicalJson(checkpoint.task) !== canonicalJson(expectedTask)) {
    return 'task identity, seed or graph digest changed';
  }
  const run = checkpoint.run;
  if (run.id !== task.id || run.seed !== task.seed) {
    return 'checkpoint run does not belong to this task and seed';
  }
  if (run.sourceSha !== expected.source.sha || run.sourceDirty) {
    return 'checkpoint run source provenance does not match the current revision';
  }
  if (run.graphSha256 !== graphSha256) {
    return 'checkpoint run graph digest does not match the planned graph';
  }
  if (canonicalJson(run.versions) !== canonicalJson(CART_VERSIONS)) {
    return 'checkpoint run cart versions changed';
  }
  if (run.nodeVersion !== process.version) {
    return 'checkpoint run runtime does not match the current runtime';
  }
  if (canonicalJson(run.cases.map((entry) => entry.id)) !== canonicalJson([...CART_REQUIRED_CASES])) {
    return 'checkpoint run does not hold the frozen official cases in order';
  }
  return null;
}

export function createCheckpoint(
  task: WorkerTask,
  run: RunEvidence,
  expected: { readonly planDigest: string; readonly source: WorkerRequest['source'] },
  writtenAt: string,
): CalibrationCheckpoint {
  return {
    schemaVersion: 1,
    kind: 'cart-calibration-checkpoint',
    generatedBy: 'scripts/cart-calibrate.ts',
    planDigest: expected.planDigest,
    sourceSha: expected.source.sha,
    sourceDirty: expected.source.dirty,
    nodeVersion: process.version,
    versions: { ...CART_VERSIONS },
    task: {
      id: task.id,
      kind: task.kind,
      family: task.family,
      size: task.size,
      placement: task.placement,
      tierMbps: task.tierMbps,
      seed: task.seed,
      graphSha256: taskGraphSha256(task),
    },
    writtenAt,
    run,
  };
}

export type TaskExecutor = (
  task: WorkerTask,
  source: WorkerRequest['source'],
) => Promise<RunEvidence>;

export interface ExecuteCalibrationOptions {
  readonly plan: CalibrationPlan;
  readonly source: WorkerRequest['source'];
  readonly outPath: string | null;
  readonly resume?: boolean;
  /** Bounded worker concurrency; 1 is the sequential rerun. Defaults to 1. */
  readonly jobs?: number;
  readonly execute?: TaskExecutor;
  readonly now?: () => string;
}

/**
 * Run the planned tasks with per-task fault isolation.
 *
 * Every success is durably checkpointed before the lane takes another task. A
 * worker error is recorded against its task id and the remaining tasks
 * continue, so one failure cannot discard unrelated completed evidence.
 * Concurrency is bounded by `jobs`; each lane owns at most one evaluation.
 */
export async function executeCalibration(
  tasks: readonly WorkerTask[],
  options: ExecuteCalibrationOptions,
): Promise<CalibrationExecution> {
  const execute = options.execute ?? ((task, source) => runTask({ task, source }));
  const planDigest = planFingerprint(options.plan);
  const directory = options.outPath === null ? null : checkpointDirectory(options.outPath);
  const now = options.now ?? (() => new Date().toISOString());
  const runs: Array<RunEvidence | undefined> = new Array(tasks.length).fill(undefined);
  const failures: CalibrationFailure[] = [];
  const rejected: { taskId: string; reason: string }[] = [];
  const accounted = new Array<boolean>(tasks.length).fill(false);
  let written = 0;
  let reused = 0;
  let next = 0;
  const requested = options.jobs ?? 1;
  const lanes = Math.max(1, Math.min(requested, tasks.length, 16));

  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (task === undefined) return;
      if (options.resume === true && directory !== null) {
        const stored = readCheckpoint(directory, task.id);
        if (stored.checkpoint !== undefined) {
          let reason: string | null;
          try {
            reason = checkpointRejection(stored.checkpoint, task, {
              planDigest,
              source: options.source,
            });
          } catch (error) {
            // Defence in depth: validation above is strict, but a checkpoint
            // that still cannot be validated must fail closed (re-run) rather
            // than abort the whole matrix and lose unattempted evidence.
            reason = `checkpoint validation failed: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
          if (reason === null) {
            runs[index] = stored.checkpoint.run;
            accounted[index] = true;
            reused += 1;
            continue;
          }
          rejected.push({ taskId: task.id, reason });
        } else if (stored.existed) {
          rejected.push({ taskId: task.id, reason: stored.reason ?? 'invalid checkpoint' });
        }
      }
      try {
        const run = await execute(task, options.source);
        if (directory !== null) {
          const checkpoint = createCheckpoint(task, run, { planDigest, source: options.source }, now());
          writeCheckpoint(directory, checkpoint);
          written += 1;
        }
        runs[index] = run;
        accounted[index] = true;
      } catch (error) {
        failures.push({
          id: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
        accounted[index] = true;
      }
    }
  };

  await Promise.all(Array.from({ length: lanes }, () => lane()));

  const missing = tasks
    .filter((task, index) => task !== undefined && accounted[index] !== true)
    .map((task) => task.id);
  return {
    runs: runs.filter((run): run is RunEvidence => run !== undefined),
    failures,
    missing,
    checkpoints: { directory, written, reused, rejected },
  };
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

async function workerMain(): Promise<void> {
  const request = workerData as WorkerRequest;
  try {
    const started = performance.now();
    const evaluation = evaluateCart(request.task.graph, { seed: request.task.seed });
    const executionMs = performance.now() - started;
    const run = summarizeEvaluation(evaluation, { ...request.task, executionMs }, request.source);
    parentPort?.postMessage({ ok: true, run } satisfies WorkerResponse);
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse);
  }
}

// ---------------------------------------------------------------------------
// Plan materialization and checks
// ---------------------------------------------------------------------------

interface PlanCase {
  readonly task: WorkerTask;
}

export function materializePlan(
  plan: CalibrationPlan,
  candidates: readonly CandidateFixture[],
  controls: readonly ControlFixture[],
): PlanCase[] {
  const cases: PlanCase[] = [];
  for (const family of plan.families) {
    const fixture = candidates.find((entry) => entry.family === family);
    if (fixture === undefined) throw new Error(`no fixture for candidate family ${family}`);
    for (const size of plan.sizes) {
      for (const placement of plan.placements) {
        for (const tier of plan.tiers) {
          for (const seed of plan.seeds) {
            const graph = applyOverrides(fixture.graph, { size, placement, tier });
            cases.push({
              task: {
                id: `${fixture.id}--size=${size}--placement=${placement}--tier=${tier}--seed=${seed}`,
                kind: 'candidate',
                family,
                size,
                placement,
                tierMbps: tier,
                seed,
                graph,
              },
            });
          }
        }
      }
    }
  }
  for (const control of plan.controls) {
    const fixture = controls.find((entry) => entry.control === control);
    if (fixture === undefined) throw new Error(`no fixture for negative control ${control}`);
    const inventory = fixture.graph.nodes.find((node) => node.kind === 'inventory');
    const inventoryRegion = inventory?.region ?? 'us-west';
    for (const seed of plan.seeds) {
      cases.push({
        task: {
          id: `${fixture.id}--seed=${seed}`,
          kind: 'negative-control',
          family: 'negative-control',
          size: null,
          placement: inventoryRegion,
          tierMbps: (fixture.graph.circuits[0]?.mbps ?? 8) as CartCircuitMbps,
          seed,
          graph: fixture.graph,
        },
      });
    }
  }
  return cases;
}

function controlEvidence(
  control: NegativeControlId,
  runs: readonly RunEvidence[],
): ControlEvidence {
  const spec = CONTROL_SPECS.find((entry) => entry.control === control);
  if (spec === undefined) throw new Error(`unknown control ${control}`);
  const relevant = runs.filter((run) => run.id.startsWith(spec.id));
  if (relevant.length === 0) {
    return {
      id: control,
      title: spec.title,
      expectation: spec.expectation,
      expectationMet: false,
      detail: 'control did not run',
    };
  }
  let met = true;
  const details: string[] = [];
  for (const run of relevant) {
    const peak = run.cases.find((entry) => entry.id === 'peak');
    switch (control) {
      case 'over-budget': {
        const over = (run.peakCreditsPerHour ?? 0) > CART_CATALOG.budget.creditsPerHour;
        met &&= over;
        details.push(`peak=${run.peakCreditsPerHour?.toFixed(3) ?? 'n/a'} > ${CART_CATALOG.budget.creditsPerHour}? ${over}`);
        break;
      }
      case 'stale-cache': {
        const rejected = run.issueCodes.includes('read_target_kind');
        met &&= rejected && !run.qualified;
        details.push(`read_target_kind=${rejected} qualified=${run.qualified}`);
        break;
      }
      case 'undercapacity': {
        const failedPeak = (peak?.failedGates.length ?? 0) > 0;
        met &&= !run.qualified && failedPeak;
        details.push(`qualified=${run.qualified} peakFailedGates=${peak?.failedGates.length ?? 0}`);
        break;
      }
      case 'central-synchronous': {
        met &&= !run.qualified;
        details.push(`qualified=${run.qualified} failedGates=${run.failedGateCount}`);
        break;
      }
    }
  }
  return { id: control, title: spec.title, expectation: spec.expectation, expectationMet: met, detail: details.join('; ') };
}

/**
 * Derive harness verdicts from evidence that actually exists.
 *
 * `calibrationPass` is intentionally the conjunction of every integrity check
 * and full task coverage: a run that lost a worker, a task, or a checkpoint can
 * never print a PASS, regardless of how good the surviving rows look.
 */
export function summarizeMatrix(input: {
  readonly plan: CalibrationPlan;
  readonly runs: readonly RunEvidence[];
  readonly controls: readonly ControlEvidence[];
  readonly failures: readonly CalibrationFailure[];
  readonly missing: readonly string[];
  readonly plannedTaskIds: readonly string[];
}): MatrixSummary {
  const observedFamilies = new Set(input.runs.filter((run) => run.kind === 'candidate').map((run) => run.family));
  const familiesRepresented =
    observedFamilies.size === input.plan.families.length &&
    input.plan.families.every((family) => observedFamilies.has(family));
  const controlsRepresented =
    input.controls.length === input.plan.controls.length &&
    input.plan.controls.every((control) => input.controls.some((entry) => entry.id === control));
  const controlsFailAsDesigned = input.controls.every((control) => control.expectationMet);
  const officialMembershipPreserved = input.runs.every(
    (run) =>
      run.cases.length === CART_REQUIRED_CASES.length &&
      run.cases.every((entry, index) => entry.id === CART_REQUIRED_CASES[index]) &&
      canonicalJson(run.versions) === canonicalJson(CART_VERSIONS),
  );
  const gateIntegrityPreserved = input.runs.every((run) =>
    run.cases.every((entry) => entry.gates.every((gate) => typeof gate.pass === 'boolean')),
  );
  const matrixComplete =
    input.failures.length === 0 &&
    input.missing.length === 0 &&
    input.runs.length === input.plannedTaskIds.length;
  return {
    familiesRepresented,
    controlsRepresented,
    controlsFailAsDesigned,
    officialMembershipPreserved,
    gateIntegrityPreserved,
    matrixComplete,
    missingTaskIds: [...input.missing],
    calibrationPass:
      matrixComplete &&
      familiesRepresented &&
      controlsRepresented &&
      controlsFailAsDesigned &&
      officialMembershipPreserved &&
      gateIntegrityPreserved,
  };
}

function assertFixtureIntegrity(
  candidates: readonly CandidateFixture[],
  controls: readonly ControlFixture[],
): void {
  for (const fixture of candidates) {
    if (fixture.preliminaryVerdict !== null) {
      throw new Error(`candidate ${fixture.id} carries a preliminary verdict`);
    }
    const raw = JSON.stringify(fixture);
    if (/"passed"\s*:|"qualified"\s*:/.test(raw)) {
      throw new Error(`candidate ${fixture.id} claims a passing result in its fixture`);
    }
    const issues = validateCartGraph(fixture.graph);
    const structural = issues.filter((issue) => issue.code === 'missing_circuit' || issue.code === 'request_cycle');
    if (structural.length > 0) {
      throw new Error(`candidate ${fixture.id} has structural issues: ${structural.map((issue) => issue.code).join(', ')}`);
    }
  }
  for (const fixture of controls) {
    if (fixture.preliminaryVerdict !== null) {
      throw new Error(`control ${fixture.id} carries a preliminary verdict`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture IO
// ---------------------------------------------------------------------------

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup; the target keeps its previous complete content.
    }
    throw error;
  }
}

export function emitFixtures(): { readonly candidates: readonly string[]; readonly controls: readonly string[] } {
  const candidates = buildCandidateFixtures();
  const controls = buildControlFixtures();
  for (const fixture of candidates) writeJson(resolve(CANDIDATE_DIR, `${fixture.id}.json`), fixture);
  for (const fixture of controls) writeJson(resolve(CONTROL_DIR, `${fixture.id}.json`), fixture);
  writeJson(resolve(CALIBRATION_DIR, 'plan.json'), defaultPlanFile());
  return {
    candidates: candidates.map((fixture) => resolve(CANDIDATE_DIR, `${fixture.id}.json`)),
    controls: controls.map((fixture) => resolve(CONTROL_DIR, `${fixture.id}.json`)),
  };
}

function defaultPlanFile(): CalibrationPlan {
  return {
    schemaVersion: 1,
    seeds: [1729],
    families: CANDIDATE_SPECS.map((spec) => spec.family),
    sizes: [...CART_SERVICE_SIZES],
    placements: [...CART_REGIONS],
    tiers: [...CART_CIRCUIT_MBPS],
    controls: CONTROL_SPECS.map((spec) => spec.control),
    jobs: 6,
  };
}

function readFixtures(): {
  readonly candidates: CandidateFixture[];
  readonly controls: ControlFixture[];
} {
  const candidates = CANDIDATE_SPECS.map((spec) => {
    const path = resolve(CANDIDATE_DIR, `${spec.id}.json`);
    if (!existsSync(path)) throw new Error(`missing candidate fixture ${path}; run --emit-fixtures`);
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as CandidateFixture;
    if (fixture.kind !== 'candidate') throw new Error(`${path} is not a candidate fixture`);
    const graph = requireGraph(fixture.graph, path);
    return { ...fixture, graph };
  });
  const controls = CONTROL_SPECS.map((spec) => {
    const path = resolve(CONTROL_DIR, `${spec.id}.json`);
    if (!existsSync(path)) throw new Error(`missing negative-control fixture ${path}; run --emit-fixtures`);
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as ControlFixture;
    if (fixture.kind !== 'negative-control') throw new Error(`${path} is not a control fixture`);
    const graph = requireGraph(fixture.graph, path);
    return { ...fixture, graph };
  });
  return { candidates, controls };
}

// ---------------------------------------------------------------------------
// Source revision
// ---------------------------------------------------------------------------

function sourceRevision(): { sha: string; dirty: boolean } {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: HERE, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: HERE, encoding: 'utf8' });
    return { sha, dirty: status.trim().length > 0 };
  } catch {
    return { sha: '0'.repeat(40), dirty: true };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const KNOWN_FLAGS = new Set([
  '--out',
  '--jobs',
  '--families',
  '--sizes',
  '--placements',
  '--tiers',
  '--seeds',
  '--controls',
  '--emit-fixtures',
  '--list',
  '--json',
  '--resume',
]);

interface CliOptions {
  readonly out: string | null;
  readonly emitFixtures: boolean;
  readonly list: boolean;
  readonly json: boolean;
  readonly resume: boolean;
  readonly plan: CalibrationPlan;
}

function parseList<T extends string>(
  value: string | undefined,
  order: readonly T[],
  label: string,
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error(`${label} must not be empty`);
  return parts.map((part) => {
    if (!(order as readonly string[]).includes(part)) {
      throw new Error(`unknown ${label}: ${part}`);
    }
    return part as T;
  });
}

function parseCli(argv: readonly string[]): CliOptions {
  let out: string | null = null;
  let emit = false;
  let list = false;
  let json = false;
  let resume = false;
  const overrides: { -readonly [K in keyof CalibrationPlan]?: CalibrationPlan[K] } = {};

  for (const arg of argv) {
    if (arg === '--emit-fixtures') {
      emit = true;
      continue;
    }
    if (arg === '--list') {
      list = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--resume') {
      resume = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const equals = arg.indexOf('=');
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    const value = equals < 0 ? undefined : arg.slice(equals + 1);
    if (!KNOWN_FLAGS.has(flag)) throw new Error(`unknown option: ${flag}`);
    if (flag === '--out') {
      if (value === undefined || value.length === 0) throw new Error('--out needs a path');
      out = value;
      continue;
    }
    if (value === undefined) throw new Error(`${flag} needs a value`);
    switch (flag) {
      case '--jobs': {
        const jobs = Number(value);
        if (!Number.isInteger(jobs)) throw new Error('--jobs must be an integer');
        overrides.jobs = jobs;
        break;
      }
      case '--families': {
        const values = parseList(
          value,
          CANDIDATE_SPECS.map((spec) => spec.family),
          'candidate family',
        );
        if (values !== undefined) overrides.families = values;
        break;
      }
      case '--sizes': {
        const values = parseList(value, CART_SERVICE_SIZES, 'service size');
        if (values !== undefined) overrides.sizes = values;
        break;
      }
      case '--placements': {
        const values = parseList(value, CART_REGIONS, 'region');
        if (values !== undefined) overrides.placements = values;
        break;
      }
      case '--tiers': {
        const values = value
          .split(',')
          .map((part) => Number(part.trim()))
          .filter((tier) => Number.isFinite(tier));
        if (values.length === 0 || values.some((tier) => !CART_CIRCUIT_MBPS.includes(tier as CartCircuitMbps))) {
          throw new Error(`--tiers must be a subset of ${CART_CIRCUIT_MBPS.join(',')}`);
        }
        overrides.tiers = values as CartCircuitMbps[];
        break;
      }
      case '--seeds': {
        const values = value
          .split(',')
          .map((part) => Number(part.trim()))
          .filter((seed) => Number.isInteger(seed) && seed >= 0);
        if (values.length === 0) throw new Error('--seeds must be non-negative integers');
        overrides.seeds = values;
        break;
      }
      case '--controls': {
        if (value === 'none') {
          overrides.controls = [];
          break;
        }
        const values = parseList(
          value,
          CONTROL_SPECS.map((spec) => spec.control),
          'negative control',
        );
        overrides.controls = values ?? [];
        break;
      }
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }
  if (resume && out === null) {
    throw new Error('--resume requires --out=<path> because checkpoints live under the output path');
  }
  return {
    out,
    emitFixtures: emit,
    list,
    json,
    resume,
    plan: normalizePlan({ ...readPlanFile(), ...overrides }),
  };
}

function printHuman(report: CalibrationReport): void {
  for (const check of report.checks) {
    console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.id}: ${check.detail}`);
  }
  const checkpointStatus =
    report.checkpoints.directory === null
      ? 'checkpoints disabled (no --out)'
      : `${report.checkpoints.written} written, ${report.checkpoints.reused} reused, ${report.checkpoints.rejected.length} rejected`;
  console.log(
    `\n${report.runs.length}/${report.totals.planned} planned runs with evidence in ${(report.totals.matrixMs / 1000).toFixed(1)} s; ${checkpointStatus}`,
  );
  for (const run of report.runs) {
    console.log(
      [
        run.id,
        run.complete ? 'complete' : 'incomplete',
        run.qualified ? 'qualified' : 'not-qualified',
        `peakh=${run.peakCreditsPerHour?.toFixed(3) ?? 'n/a'}`,
        `failed=${run.failedGateCount}`,
        `run=${run.executionMs}ms`,
      ].join(' '),
    );
  }
  console.log('\nnegative controls:');
  for (const control of report.controls) {
    console.log(
      `${control.expectationMet ? 'MET' : 'NOT-MET'} ${control.id}: ${control.detail}`,
    );
  }
  if (report.failures.length > 0) {
    console.log('\nfailed tasks (explicit; no evidence is claimed for them):');
    for (const failure of report.failures) console.log(`FAILED ${failure.id}: ${failure.error}`);
  }
  if (report.missing.length > 0) {
    console.log('\nmissing tasks (neither evidence nor failure recorded):');
    for (const id of report.missing) console.log(`MISSING ${id}`);
  }
  for (const rejected of report.checkpoints.rejected) {
    console.log(`REJECTED checkpoint ${rejected.taskId}: ${rejected.reason}`);
  }
  if (!report.complete) {
    console.log(
      '\nCALIBRATION INCOMPLETE — NOT PASS: evidence covers only a subset of the planned matrix.',
    );
  } else if (!report.conclusion.calibrationPass) {
    console.log('\nCALIBRATION EVIDENCE COMPLETE — NOT PASS: a harness integrity check failed.');
  } else {
    console.log(
      '\nCALIBRATION PASS: evidence covers the planned matrix and every integrity check passed.',
    );
  }
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  if (options.emitFixtures) {
    const written = emitFixtures();
    console.log(`wrote ${written.candidates.length} candidate and ${written.controls.length} negative-control fixtures`);
    return;
  }
  const { candidates, controls } = readFixtures();
  assertFixtureIntegrity(candidates, controls);
  const cases = materializePlan(options.plan, candidates, controls);
  if (options.list) {
    for (const item of cases) console.log(item.task.id);
    console.log(`${cases.length} planned runs`);
    return;
  }
  const plannedTaskIds = cases.map((item) => item.task.id);
  const outPath = options.out === null ? null : resolve(process.cwd(), options.out);
  const started = performance.now();
  const source = sourceRevision();
  const execution = await executeCalibration(
    cases.map((item) => item.task),
    { plan: options.plan, source, outPath, resume: options.resume, jobs: options.plan.jobs },
  );
  const matrixMs = performance.now() - started;
  const runs = execution.runs;
  const controlResults = options.plan.controls.map((control) => controlEvidence(control, runs));
  const summary = summarizeMatrix({
    plan: options.plan,
    runs,
    controls: controlResults,
    failures: execution.failures,
    missing: execution.missing,
    plannedTaskIds,
  });
  const qualifiedCandidates = runs.filter((run) => run.kind === 'candidate' && run.qualified).length;
  const report: CalibrationReport = {
    generatedBy: 'scripts/cart-calibrate.ts',
    schemaVersion: 1,
    sourceSha: source.sha,
    sourceDirty: source.dirty,
    nodeVersion: process.version,
    versions: { ...CART_VERSIONS },
    plan: options.plan,
    generatedAt: new Date().toISOString(),
    official: {
      levelId: CART_LEVEL_ID,
      requiredCases: [...CART_REQUIRED_CASES],
      budgetCreditsPerHour: CART_CATALOG.budget.creditsPerHour,
      measuredCaseMs: CART_CATALOG.budget.caseMeasuredMs,
    },
    runs,
    failures: execution.failures,
    missing: execution.missing,
    checkpoints: execution.checkpoints,
    complete: summary.matrixComplete,
    controls: controlResults,
    checks: [
      {
        id: 'candidate-families-represented',
        passed: summary.familiesRepresented,
        detail: `swept families: ${options.plan.families.join(', ')}; no candidate is pre-labelled passing.`,
      },
      {
        id: 'negative-controls-represented',
        passed: summary.controlsRepresented,
        detail: `controls: ${options.plan.controls.join(', ') || 'none'}.`,
      },
      {
        id: 'negative-controls-fail-as-designed',
        passed: summary.controlsFailAsDesigned,
        detail: controlResults.map((control) => `${control.id}=${control.expectationMet ? 'met' : 'not-met'}`).join('; ') || 'no controls requested',
      },
      {
        id: 'official-challenge-membership-preserved',
        passed: summary.officialMembershipPreserved,
        detail: 'every run reports the frozen level id, six required cases in frozen order and the frozen cart versions.',
      },
      {
        id: 'gate-integrity-preserved',
        passed: summary.gateIntegrityPreserved,
        detail: 'every gate row is copied from the engine evaluation with its own boolean verdict; no override option exists.',
      },
      {
        id: 'matrix-coverage-complete',
        passed: summary.matrixComplete,
        detail: `${runs.length}/${plannedTaskIds.length} planned tasks hold evidence; ${execution.failures.length} failed; ${execution.missing.length} missing. An incomplete matrix never reports PASS.`,
      },
    ],
    totals: {
      planned: plannedTaskIds.length,
      runs: runs.length,
      matrixMs: Math.round(matrixMs),
      evaluationMs: runs.reduce((total, run) => total + run.executionMs, 0),
      qualifiedCandidates,
      failingCandidates: runs.filter((run) => run.kind === 'candidate' && !run.qualified).length,
    },
    conclusion: {
      familiesRepresented: summary.familiesRepresented,
      controlsRepresented: summary.controlsRepresented,
      controlsFailAsDesigned: summary.controlsFailAsDesigned,
      officialMembershipPreserved: summary.officialMembershipPreserved,
      gateIntegrityPreserved: summary.gateIntegrityPreserved,
      matrixComplete: summary.matrixComplete,
      calibrationPass: summary.calibrationPass,
    },
  };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
  if (outPath !== null) {
    writeJson(outPath, report);
    console.error(`wrote ${outPath}`);
  }
  if (!summary.calibrationPass) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

if (!isMainThread) {
  void workerMain();
} else {
  const invokedPath = process.argv[1];
  if (
    invokedPath !== undefined &&
    pathToFileURL(resolve(invokedPath)).href === import.meta.url
  ) {
    void main();
  }
}
