import { describe, expect, it } from 'vitest';
import {
  CART_CASE_OFFERED_COUNTS,
  CART_DEFAULT_WORKLOAD_PROFILE,
  CART_WORKLOAD_PROFILE_DESYNC100,
  CART_WORKLOAD_PROFILE_ORIGINAL,
  assertCartWorkloadProfile,
  buildCartCaseWorkload,
  buildCartWorkload,
  type CartWorkloadProfile,
} from '../core/workload';
import { CART_LEVEL_ID, CART_VERSIONS, CART_WORKLOAD_PROFILE_IDS, type CartGraph } from '../contracts';
import { createCartStarterGraph } from '../graph';
import { computeCartCost } from '../core/cost';
import { createCartCaseRun, runCartCase } from '../core/case';
import { createCartSession, evaluateCart } from '../session';

// Trace hashes of the frozen original profile captured on the GC-PG2 base 607eeea.
const ORIGINAL_TRACE_HASH = {
  normal: '3385a277bd5ed9fdc6bf53cae73aecc1d03be90d2f94efa8afdcf477e1e27411',
  peak: '3770da5a8d3bc0052d501f481e165d956d88a1578f567feb91c51db004d8bf7b',
} as const;


/** Working three-region fixture (mirrors the evaluation suite) so the tail actually resolves. */
function workingGraph(): CartGraph {
  const regions = [
    ['us-west', 40, 'S', 1, 'local-repair', 'S'],
    ['eu-central', 440, 'S', 2, 'parallel', 'M'],
    ['ap-northeast', 840, 'M', 1, 'local-repair', 'S'],
  ] as const;
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  const all = regions.map(([r]) => `journal-${r}`);
  for (const [r, x, appSize, instances, readPolicy, journalSize] of regions) {
    nodes.push({ id: `customers-${r}`, kind: 'customers', region: r, position: { x, y: 40 } });
    nodes.push({
      id: `app-${r}`, kind: 'application', region: r, position: { x: x + 40, y: 200 },
      size: appSize, instances, writeTarget: `journal-${r}`, readPolicy, readTargets: all,
    });
    nodes.push({ id: `journal-${r}`, kind: 'journal', region: r, position: { x: x + 40, y: 340 }, size: journalSize });
    edges.push({ id: `e-src-${r}`, from: `customers-${r}`, to: `app-${r}`, kind: 'request' });
    edges.push({ id: `e-ack-${r}`, from: `app-${r}`, to: `journal-${r}`, kind: 'request' });
    edges.push({ id: `e-inv-${r}`, from: `app-${r}`, to: 'inventory-us-west', kind: 'request' });
    for (const [other] of regions) {
      if (other !== r) edges.push({ id: `p-${r}-${other}`, from: `app-${r}`, to: `app-${other}`, kind: 'request' });
    }
  }
  nodes.push({ id: 'inventory-us-west', kind: 'inventory', region: 'us-west', position: { x: 240, y: 480 }, size: 'M' });
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes,
    edges,
    circuits: [
      { regions: ['us-west', 'eu-central'], mbps: 8 },
      { regions: ['us-west', 'ap-northeast'], mbps: 32 },
      { regions: ['eu-central', 'ap-northeast'], mbps: 8 },
    ],
  } as unknown as CartGraph;
}

const ORIGINAL = CART_WORKLOAD_PROFILE_ORIGINAL;
const DESYNC = CART_WORKLOAD_PROFILE_DESYNC100;

describe('GC-WL2 versioned workload profiles', () => {
  it('defines the explicit immutable advanced profiles; the default is the basic fault-free profile', () => {
    expect(ORIGINAL).toMatchObject({ id: 'global-cart-v1-candidate', sessionOffsetMs: 5, measuredUs: 90_000_000 });
    expect(DESYNC).toMatchObject({ id: 'global-cart-v1-desync100', sessionOffsetMs: 100, measuredUs: 101_000_000 });
    expect(ORIGINAL.cases).toHaveLength(6);
    expect(DESYNC.cases).toHaveLength(6);
    expect(DESYNC.faultFree).toBe(false);
    expect(CART_DEFAULT_WORKLOAD_PROFILE).toMatchObject({
      id: 'global-cart-v1-basic-desync100', sessionOffsetMs: 100, measuredUs: 101_000_000, faultFree: true,
    });
    expect(CART_DEFAULT_WORKLOAD_PROFILE.cases).toEqual(['normal', 'peak']);
    expect(Object.isFrozen(ORIGINAL)).toBe(true);
    expect(Object.isFrozen(DESYNC)).toBe(true);
    expect(CART_VERSIONS.profile).toBe(CART_WORKLOAD_PROFILE_IDS.basic);
  });

  it('rejects invalid profiles', () => {
    const bad = (patch: Partial<CartWorkloadProfile>): CartWorkloadProfile => ({ ...DESYNC, ...patch });
    expect(() => assertCartWorkloadProfile(bad({ sessionOffsetMs: -1 }))).toThrow(RangeError);
    expect(() => assertCartWorkloadProfile(bad({ sessionOffsetMs: 2.5 }))).toThrow(RangeError);
    expect(() => assertCartWorkloadProfile(bad({ sessionOffsetMs: 101 }))).toThrow(RangeError);
    expect(() => assertCartWorkloadProfile(bad({ measuredUs: 0 }))).toThrow(RangeError);
    expect(() => buildCartCaseWorkload('normal', 1729, bad({ sessionOffsetMs: -1 }))).toThrow(RangeError);
  });

  for (const caseId of ['normal', 'peak'] as const) {
    it(`both profiles are deterministic; original keeps its frozen hash (${caseId})`, () => {
      const o1 = buildCartCaseWorkload(caseId, 1729, ORIGINAL);
      const o2 = buildCartCaseWorkload(caseId, 1729, ORIGINAL);
      const d1 = buildCartCaseWorkload(caseId, 1729, DESYNC);
      const d2 = buildCartCaseWorkload(caseId, 1729, DESYNC);
      expect(o1.traceHash).toBe(ORIGINAL_TRACE_HASH[caseId]);
      expect(o2.traceHash).toBe(o1.traceHash);
      expect(d1.traceHash).toBe(d2.traceHash);
      expect(d1.traceHash).not.toBe(o1.traceHash);
      expect(o1.profileVersion).toBe('global-cart-v1-candidate');
      expect(d1.profileVersion).toBe('global-cart-v1-desync100');
      expect(d2.profile).toBe(DESYNC);
      // The default basic profile offers the identical traffic on the same timing.
      expect(buildCartCaseWorkload(caseId, 1729).scheduled).toBe(d1.scheduled);
    }, 120_000);

    it(`conserves every logical operation, dependency and order; full tail is offered inside 101 s (${caseId})`, () => {
      const base = buildCartCaseWorkload(caseId, 1729, ORIGINAL);
      const wide = buildCartCaseWorkload(caseId, 1729, DESYNC);
      expect(wide.scheduled).toBe(CART_CASE_OFFERED_COUNTS[caseId]);
      expect(wide.counts).toEqual(base.counts);
      expect(wide.intents.length).toBe(base.intents.length);
      const byId = new Map(wide.intents.map((i) => [i.id, i]));
      for (let n = 0; n < base.intents.length; n += 1) {
        const a = base.intents[n]!;
        const b = wide.intents[n]!;
        // Everything except the offer time is identical, in the same order.
        expect({ ...b, atUs: 0 }).toEqual({ ...a, atUs: 0 });
        // Causal order: every dependency is offered strictly earlier.
        for (const dep of b.dependsOn) {
          expect(byId.get(dep)!.atUs).toBeLessThan(b.atUs);
        }
      }
      let last = 0;
      for (const i of wide.intents) last = Math.max(last, i.atUs);
      let baseLast = 0;
      for (const i of base.intents) baseLast = Math.max(baseLast, i.atUs);
      expect(baseLast).toBeLessThan(90_000_000);
      expect(last).toBe(99_400_000);
      // Last offer plus the 1 s checkout deadline fits the 101 s window.
      expect(last + 1_000_000).toBeLessThanOrEqual(DESYNC.measuredUs);
      expect(wide.intents.filter((i) => i.atUs >= ORIGINAL.measuredUs).length).toBeGreaterThan(0);
    }, 120_000);
  }

  it('whole-workload builder threads the explicit profile to every case', () => {
    const w = buildCartWorkload(1729, {}, ORIGINAL);
    expect(w.profileVersion).toBe('global-cart-v1-candidate');
    for (const c of Object.values(w.cases)) expect(c.profile).toBe(ORIGINAL);
    expect(w.cases.normal.traceHash).toBe(ORIGINAL_TRACE_HASH.normal);
  }, 120_000);

  it('actually spreads the slot-18/19 checkout bursts (no phase lock)', () => {
    const bucket = (profile: CartWorkloadProfile): number => {
      const w = buildCartCaseWorkload('normal', 1729, profile);
      const perSecond = new Map<number, number>();
      for (const i of w.intents) {
        if (i.operation !== 'checkout' || i.region !== 'us-west') continue;
        const s = Math.floor(i.atUs / 1_000_000);
        perSecond.set(s, (perSecond.get(s) ?? 0) + 1);
      }
      return Math.max(...perSecond.values());
    };
    expect(bucket(ORIGINAL)).toBeGreaterThanOrEqual(190);
    expect(bucket(DESYNC)).toBeLessThanOrEqual(25);
  });

  it('interleaved profile builds never share state (no global experiment state)', () => {
    const o1 = buildCartCaseWorkload('normal', 1729, ORIGINAL);
    const d1 = buildCartCaseWorkload('normal', 1729, DESYNC);
    const o2 = buildCartCaseWorkload('normal', 1729, ORIGINAL);
    const d2 = buildCartCaseWorkload('normal', 1729, DESYNC);
    expect(o2.traceHash).toBe(o1.traceHash);
    expect(d2.traceHash).toBe(d1.traceHash);
    expect(o1.traceHash).toBe(ORIGINAL_TRACE_HASH.normal);
  }, 120_000);
});

describe('GC-WL2 cost accounting follows the effective profile window', () => {
  const graph = createCartStarterGraph();
  const base = {
    graph,
    wanBillableBytes: 0,
    drainComplete: true,
    complete: true,
  };

  it('computeCartCost uses the supplied measured window and defaults to the original 90 s', () => {
    const w90 = computeCartCost({ ...base, measuredUs: 90_000_000, drainUs: 2_000_000 });
    const w101 = computeCartCost({ ...base, measuredUs: 101_000_000, drainUs: 2_000_000 });
    expect(w90.windowSeconds).toBe(92);
    expect(w101.windowSeconds).toBe(103);
    expect(computeCartCost({ ...base }).windowSeconds).toBe(90);
    expect(w101.windowSeconds - w90.windowSeconds).toBe(11);
  });

  it('admits and resolves the full 90-99.4 s tail inside the 101 s window and drain bound', () => {
    const intents = buildCartCaseWorkload('normal', 1729, DESYNC).intents;
    const tail = intents.filter((i) => i.atUs >= 90_000_000);
    expect(tail.length).toBeGreaterThan(0);
    const tailIds = new Set(tail.map((i) => i.id));
    const { model, result } = runCartCase({ graph: workingGraph(), caseId: 'normal', seed: 1729 });
    const records = model.requestRecords.filter((r) => tailIds.has(r.id));
    // Every tail offer is admitted (recorded once) and none is left unresolved.
    expect(records.length).toBe(tail.length);
    expect(records.filter((r) => r.unresolved).length).toBe(0);
    expect(Math.max(...records.map((r) => r.offeredUs))).toBe(99_400_000);
    expect(model.drainEndUs).toBe(101_000_000 + 10_000_000);
    expect(model.drainEndUs).toBeGreaterThanOrEqual(model.measuredEndUs);
    expect(result.cost.windowSeconds).toBeGreaterThanOrEqual(101);
  }, 120_000);

  it('createCartCaseRun measures the full profile window and bills the actual denominator', () => {
    const d = createCartCaseRun({ graph, caseId: 'normal', seed: 1729 });
    const o = createCartCaseRun({ graph, caseId: 'normal', seed: 1729, workloadProfile: ORIGINAL });
    expect(d.model.measuredEndUs).toBe(101_000_000);
    expect(o.model.measuredEndUs).toBe(90_000_000);
    // An explicit testing override still wins over the profile window.
    const short = createCartCaseRun({ graph, caseId: 'normal', seed: 1729, measuredUs: 4_000_000 });
    expect(short.model.measuredEndUs).toBe(4_000_000);
  }, 120_000);
});

describe('GC-WL2 public session adopts the profile without cross-session interference', () => {
  const graph = createCartStarterGraph();

  it('reports the effective profile id for default and explicit sessions, interleaved', () => {
    const a = createCartSession(graph, { seed: 1729 });
    const b = createCartSession(graph, { seed: 1729, workloadProfile: ORIGINAL });
    const c = createCartSession(graph, { seed: 1729 });
    // Interleave construction/cancellation order; each keeps its own profile.
    b.cancel();
    a.cancel();
    c.cancel();
    expect(a.result()?.versions.profile).toBe('global-cart-v1-basic-desync100');
    expect(b.result()?.versions.profile).toBe('global-cart-v1-candidate');
    expect(c.result()?.versions.profile).toBe('global-cart-v1-basic-desync100');
    expect(a.result()?.traceHash).toBe(c.result()?.traceHash);
    expect(a.result()?.traceHash).not.toBe(b.result()?.traceHash);
  });

  it('interleaved advances of two sessions keep separate windows and complete the tail', () => {
    const a = createCartSession(graph, { seed: 1729 });
    const b = createCartSession(graph, { seed: 1729, workloadProfile: ORIGINAL });
    let doneA = false;
    let doneB = false;
    let guard = 0;
    while (!(doneA && doneB) && guard < 200_000) {
      guard += 1;
      if (!doneA) doneA = a.advance(5_000).done;
      if (!doneB) doneB = b.advance(5_000).done;
    }
    const ra = a.result()!;
    const rb = b.result()!;
    expect(ra.versions.profile).toBe('global-cart-v1-basic-desync100');
    expect(rb.versions.profile).toBe('global-cart-v1-candidate');
    // Basic default evaluates exactly Normal + Rush; the explicit advanced profile all six.
    expect(ra.cases.map((c) => c.id)).toEqual(['normal', 'peak']);
    expect(rb.cases).toHaveLength(6);
    for (const [r, window] of [[ra, 101], [rb, 90]] as const) {
      for (const c of r.cases) {
        // Offered denominators are profile independent and fully issued (tail included).
        expect(c.scheduled).toBe(c.outcomes.scheduled);
        expect(c.issued).toBeGreaterThanOrEqual(c.scheduled);
        expect(c.cost.windowSeconds).toBeGreaterThanOrEqual(window);
        expect(c.cost.windowSeconds).toBeLessThan(window + 16);
      }
    }
    expect(ra.cases.map((c) => c.scheduled)).toEqual([CART_CASE_OFFERED_COUNTS.normal, CART_CASE_OFFERED_COUNTS.peak]);
  }, 600_000);

  it('evaluateCart default path reports the adopted version', () => {
    expect(CART_VERSIONS.profile).toBe('global-cart-v1-basic-desync100');
    const evaluation = evaluateCart({ not: 'a graph' }, { seed: 1729 });
    expect(evaluation.versions.profile).toBe('global-cart-v1-basic-desync100');
    expect(evaluation.complete).toBe(false);
  });
});
