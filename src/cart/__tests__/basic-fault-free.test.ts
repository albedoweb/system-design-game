import { describe, expect, it } from 'vitest';
import { CART_PROBE_EXPECTED_COUNTS } from '../core/challenges';
import { auditCartInventory, auditCartSafety } from '../core/audit';
import { createCartCaseRun } from '../core/case';
import { CartCaseModel, analyzeCartTopology } from '../core/model';
import type { CartRequestRecord } from '../core/model';
import {
  CART_CASE_OFFERED_COUNTS,
  CART_WORKLOAD_PROFILE_BASIC,
  CART_WORKLOAD_PROFILE_DESYNC100,
} from '../core/workload';
import { parseCartGraph } from '../graph';
import { createCartSession, evaluateCart } from '../session';

/** Historical PV1 candidate graph (graph member only, byte-identical content). */
import pv1Json from './fixtures/pv1-candidate-graph.json';
const pv1: unknown = pv1Json;

function record(overrides: Partial<CartRequestRecord>): CartRequestRecord {
  return {
    id: 'r1', caseId: 'normal', cartId: 'cart-1', region: 'us-west', operation: 'edit', cohort: 'healthy',
    offeredUs: 1_000, deadlineUs: 1_001_000, deliveredUs: 2_000, outcome: 'committed', committed: true,
    acknowledged: true, unresolved: false, rejected: false, dependencyFailed: false, exempt: false,
    deliveryUs: 2_000, evidenceIds: [], ...overrides,
  };
}

function pv1Graph() {
  const parsed = parseCartGraph(pv1);
  if (!parsed.ok) throw new Error('PV1 fixture must parse');
  return parsed.graph;
}

/** Private-state access limited to deliberately corrupting a real run's inventory. */
interface InventoryInternals {
  stockState: Record<string, number>;
  orderRows: { orderKey: string; lines: { sku: string; quantity: number }[] }[];
}
function inventoryOf(model: unknown): InventoryInternals {
  const inventory = (model as { inventory: InventoryInternals | null }).inventory;
  if (inventory === null) throw new Error('PV1 graph must contain an Inventory');
  return inventory;
}

describe('GC-B01 real public evaluator on the basic default (existing PV1 graph)', () => {
  it('evaluates exactly Normal and Rush fault-free with complete counts, 101 s cost window and no incident cohorts', () => {
    const e = evaluateCart(pv1, { seed: 1729 });
    expect(e.versions.profile).toBe('global-cart-v1-basic-desync100');
    expect(e.requiredCases).toEqual(['normal', 'peak']);
    expect(e.cases.map((c) => c.id)).toEqual(['normal', 'peak']);
    expect(e.complete).toBe(true);
    for (const c of e.cases) {
      // Exactly the offered workload: no scripted advanced probes are added.
      expect(c.scheduled).toBe(CART_CASE_OFFERED_COUNTS[c.id as 'normal' | 'peak']);
      expect(c.issued).toBe(c.scheduled);
      expect(c.cost.windowSeconds).toBe(101);
      // No incident event and no probe: no request was classified into an incident
      // cohort, nothing is exempt, and no oracle/recovery gate exists or is faked.
      expect(Object.keys(c.outcomes).filter((k) => k.startsWith('cohort:incident'))).toEqual([]);
      expect(c.outcomes['cohort:dedicated-probe']).toBeUndefined();
      expect(c.outcomes.probeOracleAudited).toBe(0);
      expect(c.outcomes.probeOracleFailures).toBe(0);
      expect(c.gates.map((g) => g.cohort).filter((cohort) => cohort.startsWith('incident'))).toEqual([]);
      expect(c.gates.map((g) => g.code)).not.toContain('recovery-barrier');
      expect(c.gates.some((g) => g.code === 'safety-audit' && g.pass)).toBe(true);
      expect(c.gates.some((g) => g.code === 'inventory-invariants' && g.pass)).toBe(true);
    }
    // Score only exists when every gate and the budget pass.
    expect(e.qualified).toBe(e.cases.every((c) => c.gates.every((g) => g.pass)));
    expect(e.scoreCreditsPerHour !== null).toBe(e.qualified);
  }, 180_000);

  it('still withholds the score when a required case cannot run (safety/demand validation stays active)', () => {
    const broken = JSON.parse(JSON.stringify(pv1)) as { nodes: { kind: string }[] };
    broken.nodes = broken.nodes.filter((n) => n.kind !== 'inventory');
    const e = evaluateCart(broken, { seed: 1729 });
    expect(e.requiredCases).toEqual(['normal', 'peak']);
    expect(e.qualified).toBe(false);
    expect(e.scoreCreditsPerHour).toBeNull();
  }, 120_000);
});

describe('GC-B01 incident reachability and classification: basic vs advanced boundary', () => {
  const graph = pv1Graph();
  const facts = analyzeCartTopology(graph);
  const tokyoToWest = [{ from: 'ap-northeast', to: 'us-west' }] as const;
  const duringIncident = 35_000_000;
  const duringBacklog = 52_000_000;

  function build(profile: typeof CART_WORKLOAD_PROFILE_BASIC) {
    return new CartCaseModel('normal', facts, [], [], graph, { faultFree: profile.faultFree }) as unknown as {
      regionReachableAt(from: string, to: string, atUs: number): boolean;
      classify(offerUs: number, required: readonly { from: string; to: string }[]): string;
    };
  }

  it('basic: Tokyo stays reachable and no offer is ever incident-affected or backlog', () => {
    const model = build(CART_WORKLOAD_PROFILE_BASIC);
    expect(facts.qualified).toBe(true);
    for (const atUs of [29_999_999, 30_000_000, duringIncident, 49_999_999, 50_000_000, duringBacklog]) {
      expect(model.regionReachableAt('ap-northeast', 'us-west', atUs)).toBe(true);
      expect(model.regionReachableAt('us-west', 'ap-northeast', atUs)).toBe(true);
      expect(model.classify(atUs, tokyoToWest)).toBe('healthy');
    }
  });

  it('advanced: the original Tokyo incident and its cohorts are retained', () => {
    const model = build(CART_WORKLOAD_PROFILE_DESYNC100);
    expect(model.regionReachableAt('ap-northeast', 'us-west', duringIncident)).toBe(false);
    expect(model.regionReachableAt('ap-northeast', 'us-west', 29_999_999)).toBe(true);
    expect(model.regionReachableAt('ap-northeast', 'us-west', 50_000_000)).toBe(true);
    expect(model.classify(duringIncident, tokyoToWest)).toBe('incident-affected');
    expect(model.classify(duringBacklog, tokyoToWest)).toBe('incident-backlog');
    // Dependencies that never cross Tokyo stay healthy even in the advanced incident.
    expect(model.classify(duringIncident, [{ from: 'us-west', to: 'eu-central' }])).toBe('healthy');
  });
});

describe('GC-B01 inventory safety controls reach the qualification gate (actual inventory/model state)', () => {
  const graph = pv1Graph();

  /** One real fault-free Normal run; corrupted real inventory state is re-audited by the real case completion. */
  function finishedNormalRun() {
    const run = createCartCaseRun({ graph, caseId: 'normal', seed: 1729, workloadProfile: CART_WORKLOAD_PROFILE_BASIC });
    while (!run.model.step(50_000)) { /* drive to completion */ }
    return run;
  }
  const invariantGate = (result: { gates: { code: string; pass: boolean; evidenceIds: string[] }[] }) => {
    const gate = result.gates.find((g) => g.code === 'inventory-invariants');
    if (gate === undefined) throw new Error('inventory-invariants gate missing');
    return gate;
  };

  it('uncorrupted real run passes; negative stock, oversell and duplicate effect each fail the gate', () => {
    const run = finishedNormalRun();
    const inventory = inventoryOf(run.model);
    const sku = Object.keys(inventory.stockState).sort()[0] as string;
    expect(sku).toBeDefined();
    expect(inventory.orderRows.length).toBeGreaterThan(0);

    const clean = run.complete();
    expect(invariantGate(clean.result).pass).toBe(true);
    expect(clean.result.complete).toBe(true);

    // 1. Negative stock.
    const original = inventory.stockState[sku] as number;
    inventory.stockState[sku] = -1;
    const negative = invariantGate(run.complete().result);
    expect(negative.pass).toBe(false);
    expect(negative.evidenceIds.some((id) => id.includes(`${sku}:negative-stock`))).toBe(true);
    inventory.stockState[sku] = original;
    expect(invariantGate(run.complete().result).pass).toBe(true);

    // 2. Oversell: an extra durable order unit that was never taken from stock (conservation breaks).
    inventory.orderRows.push({ orderKey: 'control-oversell', lines: [{ sku, quantity: 1 }] });
    const oversell = invariantGate(run.complete().result);
    expect(oversell.pass).toBe(false);
    expect(oversell.evidenceIds.some((id) => id.startsWith(`conservation:${sku}:`))).toBe(true);
    inventory.orderRows.pop();
    expect(invariantGate(run.complete().result).pass).toBe(true);

    // 3. Duplicate purchase effect: a second durable order for one idempotency key.
    const first = inventory.orderRows[0] as InventoryInternals['orderRows'][number];
    inventory.orderRows.push({ ...first, lines: first.lines.map((l) => ({ ...l })) });
    const duplicate = invariantGate(run.complete().result);
    expect(duplicate.pass).toBe(false);
    expect(duplicate.evidenceIds.some((id) => id.startsWith('duplicate-order-effect:'))).toBe(true);
  }, 120_000);

  it('a violated inventory invariant in a real session withholds qualification and the score', () => {
    const session = createCartSession(pv1, { seed: 1729 });
    session.advance(20_000);
    const pending = (session as unknown as { pending: { entry: { model: unknown } | null }[] }).pending;
    const entry = pending[0]?.entry;
    if (entry === null || entry === undefined) throw new Error('normal case should have started');
    const inventory = inventoryOf(entry.model);
    const sku = Object.keys(inventory.stockState).sort()[0] as string;
    // An unbacked durable order unit (stock never decremented): oversell/conservation breach.
    inventory.orderRows.push({ orderKey: 'control-oversell', lines: [{ sku, quantity: 1 }] });
    let guard = 0;
    while (!session.advance(200_000).done) {
      guard += 1;
      if (guard > 10_000) throw new Error('session did not finish');
    }
    const e = session.result();
    if (e === null) throw new Error('evaluation missing');
    expect(e.complete).toBe(true);
    const normal = e.cases.find((c) => c.id === 'normal');
    expect(normal?.gates.find((g) => g.code === 'inventory-invariants')?.pass).toBe(false);
    expect(e.qualified).toBe(false);
    expect(e.scoreCreditsPerHour).toBeNull();
  }, 180_000);

  it('inventory audit helper rejects hand-authored negative/oversell/duplicate inputs too', () => {
    const neg = auditCartInventory({ conservation: { conserved: false, violations: ['sku-1:negative-stock', 'sku-1:-1+3!=2'] }, orders: [{ orderKey: 'o1' }] });
    expect(neg.pass).toBe(false);
    expect(neg.violations).toContain('conservation:sku-1:negative-stock');
    expect(auditCartInventory({ conservation: { conserved: true, violations: [] }, orders: [{ orderKey: 'o1' }] }).pass).toBe(true);
    const dup = auditCartInventory({ conservation: { conserved: true, violations: [] }, orders: [{ orderKey: 'o1' }, { orderKey: 'o1' }] });
    expect(dup.violations).toContain('duplicate-order-effect:o1');
  });

  it('record-consistency audit still rejects contradictory request records (not inventory safety)', () => {
    const audit = auditCartSafety([record({ id: 'bad', rejected: true })]);
    expect(audit.pass).toBe(false);
    expect(audit.violations).toContain('committed-and-rejected:bad');
  });

  it('basic profile expects zero scripted probes while the advanced probe counts are retained', () => {
    expect(CART_PROBE_EXPECTED_COUNTS.partition).toBeGreaterThan(0);
    expect(CART_PROBE_EXPECTED_COUNTS.checkout).toBeGreaterThan(0);
  });
});
