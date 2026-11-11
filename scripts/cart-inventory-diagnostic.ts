/**
 * GC-PD2 — Inventory queue and checkout feasibility diagnostic.
 *
 * Read-only measurement harness. It drives the production cart model through
 * `runCartCase` (the same `createCartCaseRun` path `evaluateCart` uses) and
 * reconstructs the Inventory lookup/commit stage timeline exclusively from
 * existing observable seams:
 *   - `model.requestRecords`      (per-offer outcome, cohort, deadline, delivery)
 *   - `model.transferSnapshots`   (physical request/reply transfers + stages)
 *   - `model.readResults`         (the accepted complete read used by Checkout)
 *   - `model.inventoryOrders` / `inventoryStock` / `inventoryLedgerRows`
 *   - `result.gates`              (the frozen percentile and availability gates)
 *
 * It never mutates the engine, workload, prices, protocol, oracle or gates, and
 * it exposes no flag that can relax a gate. Synthetic/modified load is not part
 * of this harness: the official workload and seed 1729 are always used.
 *
 * Usage:
 *   npx tsx scripts/cart-inventory-diagnostic.ts --graph=<path> [--case=normal]
 *       [--seed=1729] [--json-out=<path>] [--trace=<checkoutId>]
 *
 * The frozen service constants are printed next to the observed occupancy so a
 * reader can see the decomposition. Where production exposes no seam for a
 * quantity (per-node CPU/IO accounting), the output says so instead of
 * inventing a number.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CART_REGIONS,
  cartGraphDigest,
  parseCartGraph,
  sha256Hex,
  canonicalJson,
  type CartCaseId,
  type CartGraph,
  type CartRegion,
} from '../src/cart';
import { runCartCase } from '../src/cart/core/case';
import {
  CART_BACKGROUND,
  CART_BACKGROUND_SLOTS,
  buildCartCaseWorkload,
} from '../src/cart/core/workload';
import { CART_DURABLE_FLUSH_US, cartIoServiceUs } from '../src/cart/core/resources';
import {
  CART_INVENTORY_EVIDENCE_PER_ID_CPU_MS,
  CART_INVENTORY_LOOKUP_CPU_MS,
  CART_INVENTORY_LOOKUP_IO_UNITS,
  CART_INVENTORY_TRANSACTION_CPU_MS,
  CART_INVENTORY_TRANSACTION_IO_UNITS,
  CART_INVENTORY_TRANSACTION_PER_LINE_CPU_MS,
  cartCheckoutLinesFromView,
} from '../src/cart/core/inventory';
import {
  CART_LATENCY_MIN_SAMPLES,
  CART_ORDINARY_LATENCY_LIMITS_US,
  nearestRankP95,
} from '../src/cart/core/metrics';
import type { CartRequestRecord } from '../src/cart/core/model';
import type { CartTransfer } from '../src/cart/core/network';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  readonly graphPath: string | null;
  readonly caseId: CartCaseId;
  readonly seed: number;
  readonly jsonOut: string | null;
  readonly traceId: string | null;
  readonly workloadOnly: boolean;
}

function parseCli(argv: readonly string[]): CliOptions {
  let graphPath: string | null = null;
  let caseId: CartCaseId = 'normal';
  let seed = 1729;
  let jsonOut: string | null = null;
  let traceId: string | null = null;
  let workloadOnly = false;
  for (const arg of argv) {
    const equals = arg.indexOf('=');
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    const value = equals < 0 ? undefined : arg.slice(equals + 1);
    const need = (): string => {
      if (value === undefined || value.length === 0) throw new Error(`${flag} needs a value`);
      return value;
    };
    switch (flag) {
      case '--graph':
        graphPath = need();
        break;
      case '--case':
        caseId = need() as CartCaseId;
        break;
      case '--seed':
        seed = Number(need());
        break;
      case '--json-out':
        jsonOut = need();
        break;
      case '--trace':
        traceId = need();
        break;
      case '--workload-only':
        workloadOnly = true;
        break;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }
  if (!workloadOnly && graphPath === null) throw new Error('--graph=<path> is required');
  if (!Number.isInteger(seed) || seed < 0) throw new Error('--seed must be a non-negative integer');
  return { graphPath, caseId, seed, jsonOut, traceId, workloadOnly };
}

// ---------------------------------------------------------------------------
// Small statistics helpers (frozen nearest-rank, no interpolation)
// ---------------------------------------------------------------------------

interface Summary {
  readonly count: number;
  readonly minUs: number | null;
  readonly p50Us: number | null;
  readonly p90Us: number | null;
  readonly p95Us: number | null;
  readonly p99Us: number | null;
  readonly maxUs: number | null;
  readonly meanUs: number | null;
}

function nearestRank(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((sorted.length * percentile) / 100);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

function summarize(values: readonly number[]): Summary {
  if (values.length === 0) {
    return { count: 0, minUs: null, p50Us: null, p90Us: null, p95Us: null, p99Us: null, maxUs: null, meanUs: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    minUs: sorted[0] ?? null,
    p50Us: nearestRank(sorted, 50),
    p90Us: nearestRank(sorted, 90),
    p95Us: nearestRank(sorted, 95),
    p99Us: nearestRank(sorted, 99),
    maxUs: sorted[sorted.length - 1] ?? null,
    meanUs: Math.round(total / sorted.length),
  };
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Frozen modeled Inventory service decomposition
// ---------------------------------------------------------------------------

const INVENTORY_IO_PER_SECOND = 2_000; // inventory size M, resources.ts
const LOOKUP_CPU_US = Math.ceil(CART_INVENTORY_LOOKUP_CPU_MS * 1_000);
const LOOKUP_IO_US = cartIoServiceUs(INVENTORY_IO_PER_SECOND, CART_INVENTORY_LOOKUP_IO_UNITS);
const COMMIT_IO_US = cartIoServiceUs(INVENTORY_IO_PER_SECOND, CART_INVENTORY_TRANSACTION_IO_UNITS);

function commitServiceUs(lines: number, coveredIds: number, terminal: boolean): number {
  const cpuMs =
    CART_INVENTORY_TRANSACTION_CPU_MS +
    CART_INVENTORY_TRANSACTION_PER_LINE_CPU_MS * lines +
    CART_INVENTORY_EVIDENCE_PER_ID_CPU_MS * coveredIds;
  return Math.ceil(cpuMs * 1_000) + COMMIT_IO_US + (terminal ? CART_DURABLE_FLUSH_US : 0);
}

// ---------------------------------------------------------------------------
// Transfer logical-id parsing: `${checkoutId}:(in|lookup|lookup-reply|commit|
// commit-reply|out):${attempt}`. Checkout ids contain ':' themselves, so the
// id is the greedy prefix and the last two segments are the stage and attempt.
// ---------------------------------------------------------------------------

type CheckoutStage = 'in' | 'lookup' | 'lookup-reply' | 'commit' | 'commit-reply' | 'out';
const STAGE_PATTERN = /^(.*):(in|lookup|lookup-reply|commit|commit-reply|out):(\d+)$/;

interface ParsedTransfer {
  readonly checkoutId: string;
  readonly stage: CheckoutStage;
  readonly attempt: number;
  readonly transfer: CartTransfer;
}

function indexTransfers(
  transfers: readonly CartTransfer[],
  checkoutIds: ReadonlySet<string>,
): Map<string, ParsedTransfer[]> {
  const byCheckout = new Map<string, ParsedTransfer[]>();
  for (const transfer of transfers) {
    const match = STAGE_PATTERN.exec(transfer.logicalId);
    if (match === null) continue;
    const checkoutId = match[1];
    const stage = match[2] as CheckoutStage;
    const attempt = Number(match[3]);
    if (checkoutId === undefined || !checkoutIds.has(checkoutId)) continue;
    const list = byCheckout.get(checkoutId);
    const parsed: ParsedTransfer = { checkoutId, stage, attempt, transfer };
    if (list === undefined) byCheckout.set(checkoutId, [parsed]);
    else list.push(parsed);
  }
  return byCheckout;
}

/**
 * Earliest delivered attempt of a request stage, with its attempt number. A
 * retry never rewrites an earlier leg, so occupancy is measured on the first
 * leg that really reached the node.
 */
function pickDeliveredAttempt(
  list: readonly ParsedTransfer[] | undefined,
  stage: CheckoutStage,
): { transfer: CartTransfer; attempt: number } | null {
  if (list === undefined) return null;
  let chosen: ParsedTransfer | null = null;
  for (const entry of list) {
    if (entry.stage !== stage || entry.transfer.deliveredAtUs === null) continue;
    if (chosen === null || entry.transfer.deliveredAtUs < (chosen.transfer.deliveredAtUs ?? Infinity)) {
      chosen = entry;
    }
  }
  return chosen === null ? null : { transfer: chosen.transfer, attempt: chosen.attempt };
}

/** The reply transfer of a given attempt, delivered or still dispatched/in-flight. */
function replyForAttempt(
  list: readonly ParsedTransfer[] | undefined,
  stage: CheckoutStage,
  attempt: number,
): CartTransfer | null {
  if (list === undefined) return null;
  for (const entry of list) {
    if (entry.stage === stage && entry.attempt === attempt) return entry.transfer;
  }
  return null;
}

/** Earliest delivered transfer per stage (used for the human stage trace). */
function pickStage(list: readonly ParsedTransfer[] | undefined, stage: CheckoutStage): CartTransfer | null {
  if (list === undefined) return null;
  let chosen: CartTransfer | null = null;
  for (const entry of list) {
    if (entry.stage !== stage || entry.transfer.deliveredAtUs === null) continue;
    if (chosen === null || entry.transfer.deliveredAtUs < (chosen.deliveredAtUs ?? Infinity)) {
      chosen = entry.transfer;
    }
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Per-offer classification (frozen CONTRACT semantics, read-only)
// ---------------------------------------------------------------------------

function isHealthySuccess(record: CartRequestRecord): boolean {
  if (!record.acknowledged) return false;
  return (
    record.outcome === 'committed' ||
    record.outcome === 'duplicate-commit' ||
    record.outcome === 'out-of-stock'
  );
}

function latencySampleUs(record: CartRequestRecord): number | null {
  if (!isHealthySuccess(record)) return null;
  if (record.deliveredUs === null || record.deliveredUs > record.deadlineUs) return null;
  return Math.max(0, record.deliveredUs - record.offeredUs);
}

const HEALTHY_COHORTS: readonly string[] = ['healthy', 'local-context-edit', 'dedicated-probe'];

// ---------------------------------------------------------------------------
// Workload arithmetic (frozen constants; no evaluation)
// ---------------------------------------------------------------------------

interface WorkloadArithmetic {
  readonly slotsPerSession: number;
  readonly checkoutSlots: readonly number[];
  readonly slotSpacingMs: number;
  readonly sessionOffsetMs: number;
  readonly sessionsPerRegionPerRound: number;
  readonly regions: number;
  readonly offersPerRegionPerRound: number;
  readonly offersPerRound: number;
  /** Actual span of the two staggered checkout clusters within a round, µs. */
  readonly clusterSpanUs: number;
  /** Distinct checkout cluster start offsets inside one round, ms. */
  readonly clusterStartOffsetsMs: readonly number[];
  readonly baseRounds: number;
  readonly peakExtraRounds: number;
  /** Rounds whose checkout clusters coincide under the peak extra stream. */
  readonly peakDoubledOffsetsMs: readonly number[];
  readonly peakOffersOnDoubledRound: number;
  readonly peakOffersOnSingleRound: number;
}

function workloadArithmetic(caseId: CartCaseId): WorkloadArithmetic {
  const checkoutSlots: number[] = [];
  for (let index = 0; index < CART_BACKGROUND_SLOTS.length; index += 1) {
    const name = CART_BACKGROUND_SLOTS[index];
    if (name === 'Checkout') checkoutSlots.push(index);
  }
  const offersPerRegionPerRound = CART_BACKGROUND.sessionsPerRegionPerRound * checkoutSlots.length;
  const offersPerRound = offersPerRegionPerRound * CART_REGIONS.length;
  const clusterStartOffsetsMs = checkoutSlots.map((slot) => slot * CART_BACKGROUND.slotSpacingMs);
  const first = Math.min(...clusterStartOffsetsMs);
  const last = Math.max(...clusterStartOffsetsMs);
  const clusterSpanUs =
    (last - first) * 1_000 + (CART_BACKGROUND.sessionsPerRegionPerRound - 1) * CART_BACKGROUND.sessionOffsetMs * 1_000;
  const extra = caseId === 'peak' ? [...CART_BACKGROUND.extraPeakRoundStartMs] : [];
  const base = CART_BACKGROUND.roundStartMs.map((ms) => ms + first);
  const extraCheckoutStarts = extra.map((ms) => ms + first);
  const peakDoubledOffsetsMs = extraCheckoutStarts.filter((ms) => base.includes(ms));
  return {
    slotsPerSession: CART_BACKGROUND_SLOTS.length,
    checkoutSlots,
    slotSpacingMs: CART_BACKGROUND.slotSpacingMs,
    sessionOffsetMs: CART_BACKGROUND.sessionOffsetMs,
    sessionsPerRegionPerRound: CART_BACKGROUND.sessionsPerRegionPerRound,
    regions: CART_REGIONS.length,
    offersPerRegionPerRound,
    offersPerRound,
    clusterSpanUs,
    clusterStartOffsetsMs,
    baseRounds: CART_BACKGROUND.roundStartMs.length,
    peakExtraRounds: extra.length,
    peakDoubledOffsetsMs,
    peakOffersOnDoubledRound: offersPerRound * 2,
    peakOffersOnSingleRound: offersPerRound,
  };
}

// CART_BACKGROUND_SLOTS is frozen and imported at the top of the file.

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const options = parseCli(process.argv.slice(2));
  if (options.workloadOnly) {
    const output = {
      schemaVersion: 1,
      kind: 'cart-inventory-workload-arithmetic',
      caseId: options.caseId,
      seed: options.seed,
      sourceSha: sourceRevision(),
      workloadArithmetic: workloadArithmetic(options.caseId),
      note:
        'Pure frozen-constant arithmetic. Two checkout clusters start at 9.0 s and 9.5 s after each round start, each spread by 100 sessions at 5 ms offsets. Offers are staggered, never simultaneous.',
    };
    const text = `${JSON.stringify(output, null, 2)}\n`;
    if (options.jsonOut !== null) writeFileSync(resolve(options.jsonOut), text);
    process.stdout.write(text);
    return;
  }
  if (options.graphPath === null) throw new Error('--graph=<path> is required');
  const raw = JSON.parse(readFileSync(resolve(options.graphPath), 'utf8')) as { graph?: unknown } | unknown;
  const graphValue =
    typeof raw === 'object' && raw !== null && 'graph' in raw ? (raw as { graph: unknown }).graph : raw;
  const parsed = parseCartGraph(graphValue);
  if (!parsed.ok) {
    throw new Error(`invalid cart graph: ${parsed.issues.map((issue) => issue.code).join(', ')}`);
  }
  const graph: CartGraph = parsed.graph;
  const inventory = graph.nodes.find((node) => node.kind === 'inventory');
  const inventoryRegion: CartRegion = inventory?.region ?? 'us-west';

  const workload = buildCartCaseWorkload(options.caseId, options.seed);
  const selectionByCheckout = new Map<string, string>();
  for (const intent of workload.intents) {
    if (intent.operation === 'checkout' && intent.effect.kind === 'checkout') {
      selectionByCheckout.set(intent.id, intent.effect.selectionReadId);
    }
  }

  const started = performance.now();
  const run = runCartCase({ graph, caseId: options.caseId, seed: options.seed });
  const wallMs = performance.now() - started;
  const model = run.model;
  const result = run.result;

  const checkouts = model.requestRecords.filter((record) => record.operation === 'checkout');
  const checkoutIds = new Set(checkouts.map((record) => record.id));
  const transfersByCheckout = indexTransfers(model.transferSnapshots, checkoutIds);
  const readResults = model.readResults;

  // Exact modeled service per checkout (lines + covered ids are the frozen
  // commit demand inputs; the selection read is the accepted complete read).
  const modeled = new Map<string, { lines: number; coveredIds: number; commitServiceUs: number }>();
  for (const record of checkouts) {
    const selectionId = selectionByCheckout.get(record.id);
    if (selectionId === undefined) continue;
    const complete = readResults.get(selectionId);
    if (complete === undefined) continue;
    const lines = cartCheckoutLinesFromView(complete.view).length;
    const coveredIds = complete.coveredIds.length;
    modeled.set(record.id, {
      lines,
      coveredIds,
      commitServiceUs: commitServiceUs(lines, coveredIds, true),
    });
  }

  // Stage occupancies and queue waits.
  interface StageAccumulator {
    visits: number;
    occupancyUs: number[];
    serviceUs: number[];
    queueWaitUs: number[];
  }
  const emptyAccumulator = (): StageAccumulator => ({ visits: 0, occupancyUs: [], serviceUs: [], queueWaitUs: [] });
  const lookup = emptyAccumulator();
  const commit = emptyAccumulator();
  const lookupByRegion = new Map<CartRegion, StageAccumulator>();
  const commitByRegion = new Map<CartRegion, StageAccumulator>();
  for (const region of CART_REGIONS) {
    lookupByRegion.set(region, emptyAccumulator());
    commitByRegion.set(region, emptyAccumulator());
  }

  const stageTrace: Array<{
    id: string;
    region: CartRegion;
    outcome: string;
    offeredUs: number;
    deadlineUs: number;
    deliveredUs: number | null;
    stages: Array<{ stage: CheckoutStage; enqueuedUs: number | null; deliveredUs: number | null }>;
    lookupOccupancyUs: number | null;
    lookupQueueWaitUs: number | null;
    commitOccupancyUs: number | null;
    commitQueueWaitUs: number | null;
  }> = [];

  const traceSlowestId = options.traceId === 'slowest' ? slowestId(checkouts) : null;
  for (const record of checkouts) {
    const list = transfersByCheckout.get(record.id);
    const lookupLeg = pickDeliveredAttempt(list, 'lookup');
    const commitLeg = pickDeliveredAttempt(list, 'commit');
    const lookupReply = lookupLeg === null ? null : replyForAttempt(list, 'lookup-reply', lookupLeg.attempt);
    const commitReply = commitLeg === null ? null : replyForAttempt(list, 'commit-reply', commitLeg.attempt);
    const lookupRegionAcc = lookupByRegion.get(record.region);
    const commitRegionAcc = commitByRegion.get(record.region);

    let lookupOccupancyUs: number | null = null;
    let lookupQueueWaitUs: number | null = null;
    if (lookupLeg !== null && lookupLeg.transfer.deliveredAtUs != null && lookupReply !== null) {
      lookupOccupancyUs = lookupReply.enqueuedAtUs - lookupLeg.transfer.deliveredAtUs;
      lookupQueueWaitUs = lookupOccupancyUs - (LOOKUP_CPU_US + LOOKUP_IO_US);
      lookup.visits += 1;
      lookup.occupancyUs.push(lookupOccupancyUs);
      lookup.serviceUs.push(LOOKUP_CPU_US + LOOKUP_IO_US);
      lookup.queueWaitUs.push(Math.max(0, lookupQueueWaitUs));
      if (lookupRegionAcc !== undefined) {
        lookupRegionAcc.visits += 1;
        lookupRegionAcc.occupancyUs.push(lookupOccupancyUs);
        lookupRegionAcc.serviceUs.push(LOOKUP_CPU_US + LOOKUP_IO_US);
        lookupRegionAcc.queueWaitUs.push(Math.max(0, lookupQueueWaitUs));
      }
    }

    let commitOccupancyUs: number | null = null;
    let commitQueueWaitUs: number | null = null;
    if (commitLeg !== null && commitLeg.transfer.deliveredAtUs != null && commitReply !== null) {
      const demand = modeled.get(record.id);
      const serviceUs = demand?.commitServiceUs ?? commitServiceUs(1, 0, true);
      commitOccupancyUs = commitReply.enqueuedAtUs - commitLeg.transfer.deliveredAtUs;
      commitQueueWaitUs = commitOccupancyUs - serviceUs;
      commit.visits += 1;
      commit.occupancyUs.push(commitOccupancyUs);
      commit.serviceUs.push(serviceUs);
      commit.queueWaitUs.push(Math.max(0, commitQueueWaitUs));
      if (commitRegionAcc !== undefined) {
        commitRegionAcc.visits += 1;
        commitRegionAcc.occupancyUs.push(commitOccupancyUs);
        commitRegionAcc.serviceUs.push(serviceUs);
        commitRegionAcc.queueWaitUs.push(Math.max(0, commitQueueWaitUs));
      }
    }

    if (options.traceId === record.id || (traceSlowestId !== null && record.id === traceSlowestId)) {
      stageTrace.push({
        id: record.id,
        region: record.region,
        outcome: record.outcome,
        offeredUs: record.offeredUs,
        deadlineUs: record.deadlineUs,
        deliveredUs: record.deliveredUs,
        stages: (['in', 'lookup', 'lookup-reply', 'commit', 'commit-reply', 'out'] as CheckoutStage[]).map(
          (stage) => {
            const transfer = pickStage(list, stage) ?? list?.find((entry) => entry.stage === stage)?.transfer ?? null;
            return {
              stage,
              enqueuedUs: transfer?.enqueuedAtUs ?? null,
              deliveredUs: transfer?.deliveredAtUs ?? null,
            };
          },
        ),
        lookupOccupancyUs,
        lookupQueueWaitUs,
        commitOccupancyUs,
        commitQueueWaitUs,
      });
    }
  }

  function slowestId(records: readonly CartRequestRecord[]): string | null {
    let best: CartRequestRecord | null = null;
    for (const record of records) {
      if (record.operation !== 'checkout' || record.deliveredUs === null) continue;
      const latency = record.deliveredUs - record.offeredUs;
      if (best === null || best.deliveredUs === null || latency > best.deliveredUs - best.offeredUs) best = record;
    }
    return best?.id ?? null;
  }

  // Per-region offered/outcome counts.
  interface RegionCounts {
    offered: number;
    healthySuccess: number;
    acknowledged: number;
    timeout: number;
    dependencyFailed: number;
    rejected: number;
    unavailable: number;
    exempt: number;
    unresolved: number;
    deliveredAfterDeadline: number;
    notDelivered: number;
    otherOutcomes: Record<string, number>;
    lookupAttempted: number;
    lookupArrived: number;
    lookupReplySent: number;
    commitAttempted: number;
    commitCompleted: number;
    commitReplySent: number;
    noTransfer: number;
  }
  const emptyRegionCounts = (): RegionCounts => ({
    offered: 0,
    healthySuccess: 0,
    acknowledged: 0,
    timeout: 0,
    dependencyFailed: 0,
    rejected: 0,
    unavailable: 0,
    exempt: 0,
    unresolved: 0,
    deliveredAfterDeadline: 0,
    notDelivered: 0,
    otherOutcomes: {},
    lookupAttempted: 0,
    lookupArrived: 0,
    lookupReplySent: 0,
    commitAttempted: 0,
    commitCompleted: 0,
    commitReplySent: 0,
    noTransfer: 0,
  });
  const perRegion = new Map<CartRegion, RegionCounts>();
  const totalCounts: RegionCounts = emptyRegionCounts();
  const bumpRegion = (region: CartRegion): RegionCounts => {
    let counts = perRegion.get(region);
    if (counts === undefined) {
      counts = emptyRegionCounts();
      perRegion.set(region, counts);
    }
    return counts;
  };
  for (const record of checkouts) {
    const counts = bumpRegion(record.region);
    for (const target of [counts, totalCounts]) {
      target.offered += 1;
      if (isHealthySuccess(record)) target.healthySuccess += 1;
      if (record.acknowledged) target.acknowledged += 1;
      if (record.outcome === 'timeout') target.timeout += 1;
      if (record.dependencyFailed) target.dependencyFailed += 1;
      if (record.rejected) target.rejected += 1;
      if (record.outcome === 'unavailable') target.unavailable += 1;
      if (record.exempt) target.exempt += 1;
      if (record.unresolved) target.unresolved += 1;
      if (record.deliveredUs !== null && record.deliveredUs > record.deadlineUs) target.deliveredAfterDeadline += 1;
      if (record.deliveredUs === null) target.notDelivered += 1;
      if (!['committed', 'duplicate-commit', 'out-of-stock', 'timeout', 'unavailable', 'rejected'].includes(record.outcome)) {
        target.otherOutcomes[record.outcome] = (target.otherOutcomes[record.outcome] ?? 0) + 1;
      }
    }
    const list = transfersByCheckout.get(record.id);
    if (list !== undefined) {
      const lookupAttempts = list.filter((entry) => entry.stage === 'lookup');
      const commitAttempts = list.filter((entry) => entry.stage === 'commit');
      const lookupArrivals = lookupAttempts.filter((entry) => entry.transfer.deliveredAtUs !== null).length;
      const commitArrivals = commitAttempts.filter((entry) => entry.transfer.deliveredAtUs !== null).length;
      const lookupReplies = list.filter((entry) => entry.stage === 'lookup-reply');
      const commitReplies = list.filter((entry) => entry.stage === 'commit-reply');
      for (const target of [counts, totalCounts]) {
        target.lookupAttempted += lookupAttempts.length;
        target.lookupArrived += lookupArrivals;
        target.lookupReplySent += lookupReplies.length;
        target.commitAttempted += commitAttempts.length;
        target.commitCompleted += commitArrivals;
        target.commitReplySent += commitReplies.length;
      }
    } else {
      for (const target of [counts, totalCounts]) target.noTransfer += 1;
    }
  }

  // Burst buckets: group checkout offers by 10 s round window.
  const bucketCounts = new Map<number, { offers: number; modeledOffers: number; byRegion: Record<string, number>; lookupServiceUs: number; commitServiceUs: number }>();
  for (const record of checkouts) {
    const bucket = Math.floor(record.offeredUs / 10_000_000);
    let entry = bucketCounts.get(bucket);
    if (entry === undefined) {
      entry = { offers: 0, modeledOffers: 0, byRegion: {}, lookupServiceUs: 0, commitServiceUs: 0 };
      bucketCounts.set(bucket, entry);
    }
    entry.offers += 1;
    if (modeled.has(record.id)) entry.modeledOffers += 1;
    entry.byRegion[record.region] = (entry.byRegion[record.region] ?? 0) + 1;
    entry.lookupServiceUs += LOOKUP_CPU_US + LOOKUP_IO_US;
    entry.commitServiceUs += modeled.get(record.id)?.commitServiceUs ?? commitServiceUs(1, 0, true);
  }
  const burstBuckets = [...bucketCounts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucket, entry]) => ({
      secondStartUs: bucket * 10_000_000,
      offers: entry.offers,
      modeledOffers: entry.modeledOffers,
      byRegion: entry.byRegion,
      modeledInventoryServiceMs: round((entry.lookupServiceUs + entry.commitServiceUs) / 1_000, 1),
    }));

  // Percentile cohorts (frozen whole-case healthy checkout p95).
  const p95Cohorts = CART_REGIONS.map((region) => {
    const population = checkouts.filter((record) => record.region === region && HEALTHY_COHORTS.includes(record.cohort));
    const samples = population
      .map((record) => ({ id: record.id, latencyUs: latencySampleUs(record) }))
      .filter((entry): entry is { id: string; latencyUs: number } => entry.latencyUs !== null)
      .sort((a, b) => a.latencyUs - b.latencyUs);
    const rank = Math.ceil((samples.length * 95) / 100);
    const value = nearestRankP95(samples.map((entry) => entry.latencyUs));
    const sampleGate = result.gates.find((gate) => gate.code === `latency-samples-healthy-checkout-${region}`);
    const p95Gate = result.gates.find((gate) => gate.code === `ordinary-p95-healthy-checkout-${region}`);
    return {
      region,
      offeredDenominator: population.length,
      sampleDenominator: samples.length,
      minSamplesRequired: CART_LATENCY_MIN_SAMPLES,
      nearestRank: rank,
      p95Us: value,
      limitUs: CART_ORDINARY_LATENCY_LIMITS_US.checkout,
      gateSampleObserved: sampleGate?.observed ?? null,
      gateP95Observed: p95Gate?.observed ?? null,
      gateP95Pass: p95Gate?.pass ?? null,
      matchesEngineSampleGate: sampleGate?.observed === samples.length,
      matchesEngineP95Gate: p95Gate?.observed === value,
      slowestSampleIds: samples.slice(-3).reverse().map((entry) => entry.id),
    };
  });

  // Conservation / independent cross-checks.
  const orders = model.inventoryOrders;
  const ledgerRows = model.inventoryLedgerRows;
  const stock = model.inventoryStock;
  const committedRecords = checkouts.filter((record) => record.committed).length;
  const committedButUndelivered = checkouts.filter((record) => record.committed && !record.acknowledged).length;
  // Frozen audit primary classes (audit.ts safetyClassOf): rejected > committed
  // > acknowledged > unresolved. A committed-but-undelivered record is primary
  // `committed`; its record-level `unresolved` boolean is still true, so both
  // views are reported and never conflated.
  const auditClasses = {
    committed: checkouts.filter((record) => !record.rejected && record.committed).length,
    acknowledgedOnly: checkouts.filter((record) => !record.rejected && !record.committed && record.acknowledged).length,
    unresolvedOnly: checkouts.filter((record) => !record.rejected && !record.committed && !record.acknowledged).length,
    rejected: checkouts.filter((record) => record.rejected).length,
  };
  const auditClassTotal =
    auditClasses.committed + auditClasses.acknowledgedOnly + auditClasses.unresolvedOnly + auditClasses.rejected;
  const recordUnresolvedFlag = checkouts.filter((record) => record.unresolved).length;

  // Stock conservation on the 100 frozen base SKUs ("0".."99", initial 1e6
  // each). Probe SKUs carry engine-internal initial data, so their initial is
  // not exposed by a public seam and is reported, not guessed.
  const isBaseSku = (sku: string): boolean => /^(0|[1-9][0-9]?)$/.test(sku) && Number(sku) < CART_BACKGROUND.skus;
  const baseInitialTotal = CART_BACKGROUND.skus * CART_BACKGROUND.initialStockPerSku;
  let baseRemainingTotal = 0;
  let nonBaseStockKeys = 0;
  let nonBaseStockTotal = 0;
  for (const [sku, quantity] of Object.entries(stock)) {
    if (isBaseSku(sku)) baseRemainingTotal += quantity;
    else {
      nonBaseStockKeys += 1;
      nonBaseStockTotal += quantity;
    }
  }
  let baseOrderedUnits = 0;
  let nonBaseOrderedUnits = 0;
  let totalOrderedUnits = 0;
  for (const order of orders) {
    for (const line of order.lines) {
      totalOrderedUnits += line.quantity;
      if (isBaseSku(line.sku)) baseOrderedUnits += line.quantity;
      else nonBaseOrderedUnits += line.quantity;
    }
  }

  // Hand arithmetic: total exclusive service demand vs observed span.
  const allLookupServiceUs = lookup.serviceUs.reduce((sum, value) => sum + value, 0);
  const allCommitServiceUs = commit.serviceUs.reduce((sum, value) => sum + value, 0);
  const measuredWindowUs = model.measuredEndUs;
  const burstCount = burstBuckets.length;
  const serviceDemandInBurstsMs = burstBuckets.reduce((sum, bucket) => sum + bucket.modeledInventoryServiceMs, 0);
  const busiest = burstBuckets.reduce<{ offers: number; modeledInventoryServiceMs: number } | null>(
    (best, bucket) => (best === null || bucket.modeledInventoryServiceMs > best.modeledInventoryServiceMs ? bucket : best),
    null,
  );

  const output = {
    schemaVersion: 1,
    kind: 'cart-inventory-diagnostic',
    candidateGraph: {
      path: resolve(options.graphPath),
      digest: cartGraphDigest(graph),
      canonicalSha256: sha256Hex(canonicalJson(graph)),
      inventoryRegion,
      inventoryNodeId: inventory?.id ?? null,
      inventorySize: inventory !== undefined && 'size' in inventory ? inventory.size : null,
    },
    run: {
      caseId: options.caseId,
      seed: options.seed,
      sourceSha: sourceRevision(),
      nodeVersion: process.version,
      wallMs: Math.round(wallMs),
      scheduled: result.scheduled,
      issued: result.issued,
      complete: result.complete,
      outcomeCounts: result.outcomes,
      failedGates: result.gates.filter((gate) => !gate.pass).map((gate) => gate.code),
      resources: result.resources,
    },
    frozenServiceModel: {
      inventoryIoPerSecond: INVENTORY_IO_PER_SECOND,
      lookup: { cpuUs: LOOKUP_CPU_US, ioUs: LOOKUP_IO_US, totalUs: LOOKUP_CPU_US + LOOKUP_IO_US },
      commit: {
        baseCpuUs: Math.ceil(CART_INVENTORY_TRANSACTION_CPU_MS * 1_000),
        perLineCpuUs: Math.ceil(CART_INVENTORY_TRANSACTION_PER_LINE_CPU_MS * 1_000),
        evidencePerIdCpuUs: Math.ceil(CART_INVENTORY_EVIDENCE_PER_ID_CPU_MS * 1_000),
        ioUnits: CART_INVENTORY_TRANSACTION_IO_UNITS,
        ioUs: COMMIT_IO_US,
        flushUs: CART_DURABLE_FLUSH_US,
        meanModeledUs: summarize(commit.serviceUs).meanUs,
      },
    },
    workloadArithmetic: workloadArithmetic(options.caseId),
    checkoutWorkloadObserved: {
      offersPerRoundBucket: burstBuckets,
      busiestBucket: busiest,
      note:
        'Offers are staggered within a round (session offset 5 ms), not simultaneous; a bucket is a 10 s round window.',
    },
    perRegion: Object.fromEntries(
      CART_REGIONS.map((region) => [region, perRegion.get(region) ?? null]),
    ),
    totals: totalCounts,
    inventoryStages: {
      lookup: {
        visits: lookup.visits,
        occupancyUs: summarize(lookup.occupancyUs),
        modeledServiceUs: summarize(lookup.serviceUs),
        queueWaitUs: summarize(lookup.queueWaitUs),
      },
      commit: {
        visits: commit.visits,
        occupancyUs: summarize(commit.occupancyUs),
        modeledServiceUs: summarize(commit.serviceUs),
        queueWaitUs: summarize(commit.queueWaitUs),
      },
      byRegion: Object.fromEntries(
        CART_REGIONS.map((region) => [
          region,
          {
            lookup: {
              visits: lookupByRegion.get(region)?.visits ?? 0,
              occupancyUs: summarize(lookupByRegion.get(region)?.occupancyUs ?? []),
              queueWaitUs: summarize(lookupByRegion.get(region)?.queueWaitUs ?? []),
            },
            commit: {
              visits: commitByRegion.get(region)?.visits ?? 0,
              occupancyUs: summarize(commitByRegion.get(region)?.occupancyUs ?? []),
              queueWaitUs: summarize(commitByRegion.get(region)?.queueWaitUs ?? []),
            },
          },
        ]),
      ),
      missingSeam:
        'Production exposes no per-node CPU/IO busy, queue-depth or enqueue-order counter. Occupancy is reconstructed as reply-dispatch minus inventory arrival from transfer snapshots; queueWaitUs is derived by subtracting the frozen modeled service constant from that occupancy. It is an inferred residual, not a directly measured internal queue counter, and it includes any unmodeled per-stage overhead inside the same span.',
    },
    p95Cohorts,
    conservation: {
      offeredCheckoutRecords: checkouts.length,
      auditClassTotal,
      auditClasses,
      conservationHolds: auditClassTotal === checkouts.length,
      recordUnresolvedFlag,
      committedFlagRecords: committedRecords,
      committedButUndelivered,
      inventoryOrders: orders.length,
      inventoryLedgerRows: ledgerRows.length,
      stock: {
        baseSkus: CART_BACKGROUND.skus,
        baseInitialTotal,
        baseRemainingTotal,
        baseOrderedUnits,
        baseConserved: baseRemainingTotal + baseOrderedUnits === baseInitialTotal,
        nonBaseStockKeys,
        nonBaseStockTotal,
        nonBaseOrderedUnits,
        totalOrderedUnits,
        note:
          'Base SKUs "0".."99" start at 1,000,000 each. Probe SKUs carry engine-internal initial stock (declared knownStock or 1,000,000) with no public initial-map seam, so only their remaining/ordered totals are reported.',
      },
    },
    handArithmetic: {
      observedLookupServiceMs: round(allLookupServiceUs / 1_000, 2),
      observedCommitServiceMs: round(allCommitServiceUs / 1_000, 2),
      observedExclusiveServiceMs: round((allLookupServiceUs + allCommitServiceUs) / 1_000, 2),
      observedServedUtilizationAcrossBursts: round(
        (allLookupServiceUs + allCommitServiceUs) / 1_000 / (burstCount * 1_000),
        3,
      ),
      modeledServiceMsAcrossBursts: round(serviceDemandInBurstsMs, 1),
      burstCount,
      busiestBurst: busiest,
      measuredWindowSeconds: measuredWindowUs / 1_000_000,
      offeredWorkUtilizationAcrossBursts: round(
        serviceDemandInBurstsMs / (burstCount * 1_000),
        3,
      ),
      note:
        'Both utilization fields use the same denominator: burstCount × 1 000 ms, i.e. the nine ~1 s checkout stagger spans, not the 90 s measured window. offeredWorkUtilization counts every modeled lookup+commit demand; observedServedUtilization counts only service the run actually admitted (resolved transfer pairs). Values above 1 mean modeled demand exceeds one second of single-slot service per burst, so a burst cannot drain inside its own stagger span; the 10 s round period leaves drain time between bursts, so this ratio is not by itself a p95 lower-bound proof. Percentiles are over successful deliveries only, and deadlines, retries and unavailable/exempt outcomes decide which offers reach the commit stage.',
    },
    stageTrace,
    wallMs: Math.round(wallMs),
  };

  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (options.jsonOut !== null) writeFileSync(resolve(options.jsonOut), text);
  process.stdout.write(text);
}

function sourceRevision(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
  } catch {
    return '0'.repeat(40);
  }
}

main();
