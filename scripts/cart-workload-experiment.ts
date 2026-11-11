/**
 * GC-WL1 — desynchronized-workload measurement (experiment only).
 *
 * Runs the PRODUCTION case evaluator (`runCartCase`, the same path
 * `evaluateCart` uses) on one fixed candidate graph and seed, comparing the
 * frozen `sessionOffsetMs = 5` against an explicit larger session offset.
 * Only the offer *times* of sessions change (see `CartWorkloadProfile`);
 * every logical operation, id, dependency, RNG draw and gate is untouched.
 *
 * Arms (default): original@90s (frozen baseline), original@window,
 * offset@window and offset@90s (shows what the unextended cutoff would do).
 * `window` defaults to 101 s: the last offset-100 offer is at 99.4 s and each
 * foreground offer has a 1 s deadline, so 101 s is the smallest whole-second
 * window in which every deadline resolves inside the measured window.
 *
 * Usage:
 *   npx tsx scripts/cart-workload-experiment.ts --graph=<path> [--cases=normal,peak]
 *     [--seed=1729] [--offset=100] [--window-s=101] [--json-out=<path>]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { cartGraphDigest, parseCartGraph, type CartCaseId, type CartGraph } from '../src/cart';
import { runCartCase } from '../src/cart/core/case';
import {
  CART_WORKLOAD_PROFILE_ORIGINAL,
  buildCartCaseWorkload,
  type CartWorkloadProfile,
} from '../src/cart/core/workload';
import type { CartTransfer } from '../src/cart/core/network';

interface Arm {
  readonly label: string;
  readonly sessionOffsetMs: number;
  readonly measuredS: number;
}

function parseCli(argv: readonly string[]) {
  const o = { graph: '', cases: ['normal'] as CartCaseId[], seed: 1729, offset: 100, windowS: 101, out: '' };
  for (const arg of argv) {
    const [flag, value = ''] = arg.split('=');
    if (flag === '--graph') o.graph = value;
    else if (flag === '--cases') o.cases = value.split(',') as CartCaseId[];
    else if (flag === '--seed') o.seed = Number(value);
    else if (flag === '--offset') o.offset = Number(value);
    else if (flag === '--window-s') o.windowS = Number(value);
    else if (flag === '--json-out') o.out = value;
    else throw new Error(`unknown option ${flag}`);
  }
  if (o.graph === '') throw new Error('--graph is required');
  return o;
}

function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(Math.max(Math.ceil((sorted.length * p) / 100), 1), sorted.length) - 1] ?? null;
}

const STAGE = /^(.*):(lookup|lookup-reply|commit|commit-reply):(\d+)$/;

/** Inventory sojourn (arrival at node -> reply enqueued) from existing transfer snapshots. */
function inventorySojourn(transfers: readonly CartTransfer[]) {
  const req = new Map<string, CartTransfer>();
  const rep = new Map<string, CartTransfer>();
  for (const t of transfers) {
    const m = STAGE.exec(t.logicalId);
    if (m === null) continue;
    const key = `${m[1]}:${m[3]}`;
    if (m[2] === 'lookup' || m[2] === 'commit') req.set(`${m[2]}|${key}`, t);
    else rep.set(`${m[2] === 'lookup-reply' ? 'lookup' : 'commit'}|${key}`, t);
  }
  const out: Record<string, { n: number; p50Us: number | null; p95Us: number | null; maxUs: number | null; perSecondPeakArrivals: number }> = {};
  for (const stage of ['lookup', 'commit']) {
    const waits: number[] = [];
    const perSecond = new Map<number, number>();
    for (const [k, r] of req) {
      if (!k.startsWith(`${stage}|`) || r.deliveredAtUs === null) continue;
      const sec = Math.floor(r.deliveredAtUs / 1_000_000);
      perSecond.set(sec, (perSecond.get(sec) ?? 0) + 1);
      const reply = rep.get(k);
      if (reply !== undefined) waits.push(reply.enqueuedAtUs - r.deliveredAtUs);
    }
    waits.sort((a, b) => a - b);
    out[stage] = {
      n: waits.length,
      p50Us: nearestRank(waits, 50),
      p95Us: nearestRank(waits, 95),
      maxUs: waits.length === 0 ? null : (waits[waits.length - 1] ?? null),
      perSecondPeakArrivals: Math.max(0, ...perSecond.values()),
    };
  }
  return out;
}

function runArm(graph: CartGraph, caseId: CartCaseId, seed: number, arm: Arm) {
  const started = Date.now();
  // Explicit immutable profile per arm: no module-global state is involved.
  const profile: CartWorkloadProfile = {
    ...CART_WORKLOAD_PROFILE_ORIGINAL,
    sessionOffsetMs: arm.sessionOffsetMs,
    measuredUs: arm.measuredS * 1_000_000,
  };
  {
    const workload = buildCartCaseWorkload(caseId, seed, profile);
    const offered: Record<string, number> = { edit: 0, read: 0, checkout: 0 };
    const buckets: Record<string, Record<string, number>> = {};
    let lastOfferUs = 0;
    let beyondWindow = 0;
    for (const i of workload.intents) {
      offered[i.operation] = (offered[i.operation] ?? 0) + 1;
      const b = String(Math.floor(i.atUs / 10_000_000) * 10);
      const row = (buckets[b] ??= { edit: 0, read: 0, checkout: 0 });
      row[i.operation] = (row[i.operation] ?? 0) + 1;
      lastOfferUs = Math.max(lastOfferUs, i.atUs);
      if (i.atUs >= arm.measuredS * 1_000_000) beyondWindow += 1;
    }
    const run = runCartCase({ graph, caseId, seed, workloadProfile: profile });
    const { result, model } = run;
    const records = model.requestRecords.filter((r) => r.operation !== 'audit');
    const byOp: Record<string, Record<string, number>> = {};
    const checkoutByRegion: Record<string, { offered: number; ack: number; unresolved: number; committedOrOos: number }> = {};
    const offeredBuckets: Record<string, number> = {};
    for (const r of records) {
      const op = (byOp[r.operation] ??= { total: 0, acknowledged: 0, unresolved: 0, dependencyFailed: 0, rejected: 0 });
      op.total = (op.total ?? 0) + 1;
      if (r.acknowledged) op.acknowledged = (op.acknowledged ?? 0) + 1;
      if (r.unresolved) op.unresolved = (op.unresolved ?? 0) + 1;
      if (r.dependencyFailed) op.dependencyFailed = (op.dependencyFailed ?? 0) + 1;
      if (r.rejected) op.rejected = (op.rejected ?? 0) + 1;
      const key = String(Math.floor(r.offeredUs / 10_000_000) * 10);
      offeredBuckets[key] = (offeredBuckets[key] ?? 0) + 1;
      if (r.operation === 'checkout') {
        const c = (checkoutByRegion[r.region] ??= { offered: 0, ack: 0, unresolved: 0, committedOrOos: 0 });
        c.offered += 1;
        if (r.acknowledged) c.ack += 1;
        if (r.unresolved) c.unresolved += 1;
        if (r.outcome === 'committed' || r.outcome === 'duplicate-commit' || r.outcome === 'out-of-stock') c.committedOrOos += 1;
      }
    }
    return {
      arm,
      wallMs: Date.now() - started,
      scheduledIntentsOffered: offered,
      scheduledOfferedByTenSecondBucket: buckets,
      lastScheduledOfferS: lastOfferUs / 1_000_000,
      scheduledOffersAtOrAfterMeasuredEnd: beyondWindow,
      probeNonAcknowledged: records
        .filter((r) => r.operation === 'probe' && !r.acknowledged)
        .map((r) => ({
          id: r.id,
          region: r.region,
          cohort: r.cohort,
          outcome: r.outcome,
          offeredS: r.offeredUs / 1_000_000,
          dependencyFailed: r.dependencyFailed,
          unresolved: r.unresolved,
          evidenceIds: r.evidenceIds.slice(0, 5),
        })),
      traceHash: workload.traceHash,
      scheduled: result.scheduled,
      issued: result.issued,
      complete: result.complete,
      dependencyFailed: result.dependencyFailed,
      outcomes: result.outcomes,
      recordsByOperation: byOp,
      issuedRecordsByTenSecondBucket: offeredBuckets,
      checkoutByRegion,
      pendingServiceTasks: model.pendingServiceTasks,
      inventorySojourn: inventorySojourn(model.transferSnapshots),
      checkoutGates: result.gates
        .filter((g) => g.operation === 'checkout')
        .map((g) => ({ code: g.code, region: g.region, cohort: g.cohort, observed: g.observed, limit: g.limit, pass: g.pass })),
      failedGates: result.gates
        .filter((g) => !g.pass)
        .map((g) => ({ code: g.code, region: g.region, operation: g.operation, cohort: g.cohort, observed: g.observed, limit: g.limit })),
      gateCounts: { failed: result.gates.filter((g) => !g.pass).length, total: result.gates.length },
      safetyAuditPass: result.gates.find((g) => g.code === 'safety-audit')?.pass ?? null,
      cost: result.cost,
    };
  }
}

function main(): void {
  const o = parseCli(process.argv.slice(2));
  const input: unknown = JSON.parse(readFileSync(o.graph, 'utf8'));
  // Candidate files wrap the graph as `{ id, ..., graph }`; bare graphs are accepted too.
  const wrapped = (input as { graph?: unknown }).graph;
  const parsed = parseCartGraph(wrapped === undefined ? input : wrapped);
  if (!parsed.ok) throw new Error(`graph rejected: ${JSON.stringify(parsed.issues).slice(0, 400)}`);
  const graph = parsed.graph;
  const arms: Arm[] = [
    { label: 'original-5ms@90s (frozen baseline)', sessionOffsetMs: 5, measuredS: 90 },
    { label: `original-5ms@${o.windowS}s`, sessionOffsetMs: 5, measuredS: o.windowS },
    { label: `offset-${o.offset}ms@${o.windowS}s`, sessionOffsetMs: o.offset, measuredS: o.windowS },
    { label: `offset-${o.offset}ms@90s (unextended; offers after 90 s)`, sessionOffsetMs: o.offset, measuredS: 90 },
  ];
  const results: Record<string, unknown[]> = {};
  for (const caseId of o.cases) {
    results[caseId] = arms.map((arm) => {
      const r = runArm(graph, caseId, o.seed, arm);
      process.stderr.write(`${caseId} ${arm.label}: ${r.wallMs}ms failed=${r.gateCounts.failed}/${r.gateCounts.total}\n`);
      return { label: arm.label, ...r };
    });
  }
  const sha = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
  const doc = {
    experiment: 'GC-WL1',
    seed: o.seed,
    sourceRevision: sha,
    graphId: (input as { id?: string }).id ?? null,
    graphDigest: cartGraphDigest(graph),
    results,
  };
  const text = `${JSON.stringify(doc, null, 1)}\n`;
  if (o.out !== '') writeFileSync(o.out, text);
  else process.stdout.write(text);
}

main();
