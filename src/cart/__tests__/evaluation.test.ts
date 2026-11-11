import { describe, expect, it } from 'vitest';
import {
  CART_ADVANCED_REQUIRED_CASES,
  CART_LEVEL_ID,
  CART_REQUIRED_CASES,
  CART_VERSIONS,
  createCartStarterGraph,
  type CartGraph,
  type CartRegion,
} from '../index';
import { auditCartSafety, safetyClassOf } from '../core/audit';
import { computeCartCost } from '../core/cost';
import { buildCaseGates } from '../core/metrics';
import {
  analyzeCartTopology,
  CartCaseModel,
  CART_CHECKOUT_COMMIT_REQUEST_BYTES,
  CART_CHECKOUT_COVERED_ID_BYTES,
  CART_CHECKOUT_INGRESS_BYTES,
  CART_CHECKOUT_LINE_BYTES,
  CART_CHECKOUT_LOOKUP_REQUEST_BYTES,
  CART_CHECKOUT_REPLY_BYTES,
  CART_CHECKOUT_RETRY_BACKOFF_US,
  CART_DRAIN_LIMIT_US,
  CART_PREPARATION_LIMIT_US,
  classifyCartCohort,
  type CartRequestRecord,
} from '../core/model';
import { CART_PROBE_EXPECTED_COUNTS, buildCartProbes } from '../core/challenges';
import { runCartCase } from '../core/case';
import {
  CART_CASE_OFFERED_COUNTS,
  CART_WORKLOAD_PROFILE_DESYNC100,
  CART_WORKLOAD_PROFILE_ORIGINAL,
} from '../core/workload';
import { createCartSession, evaluateCart } from '../session';
import type { CartOperationIntent } from '../core/workload';

/** Qualifying fixture mirrored from the graph suite (three regions + inventory). */
function qualifyingGraph(withCrossRegion: boolean): CartGraph {
  const nodes: Record<string, unknown>[] = [
    { id: 'customers-us-west', kind: 'customers', region: 'us-west', position: { x: 40, y: 40 } },
    { id: 'customers-eu-central', kind: 'customers', region: 'eu-central', position: { x: 440, y: 40 } },
    { id: 'customers-ap-northeast', kind: 'customers', region: 'ap-northeast', position: { x: 840, y: 40 } },
    {
      id: 'app-us-west',
      kind: 'application',
      region: 'us-west',
      position: { x: 80, y: 200 },
      size: 'S',
      instances: 1,
      writeTarget: 'journal-us-west',
      readPolicy: 'local-repair',
      readTargets: withCrossRegion ? ['journal-us-west', 'journal-eu-central', 'journal-ap-northeast'] : ['journal-us-west'],
    },
    {
      id: 'app-eu-central',
      kind: 'application',
      region: 'eu-central',
      position: { x: 480, y: 200 },
      size: 'S',
      instances: 2,
      writeTarget: 'journal-eu-central',
      readPolicy: 'parallel',
      readTargets: withCrossRegion ? ['journal-us-west', 'journal-eu-central', 'journal-ap-northeast'] : ['journal-eu-central'],
    },
    {
      id: 'app-ap-northeast',
      kind: 'application',
      region: 'ap-northeast',
      position: { x: 880, y: 200 },
      size: 'M',
      instances: 1,
      writeTarget: 'journal-ap-northeast',
      readPolicy: 'local-repair',
      readTargets: withCrossRegion ? ['journal-us-west', 'journal-eu-central', 'journal-ap-northeast'] : ['journal-ap-northeast'],
    },
    { id: 'journal-us-west', kind: 'journal', region: 'us-west', position: { x: 80, y: 340 }, size: 'S' },
    { id: 'journal-eu-central', kind: 'journal', region: 'eu-central', position: { x: 480, y: 340 }, size: 'M' },
    { id: 'journal-ap-northeast', kind: 'journal', region: 'ap-northeast', position: { x: 880, y: 340 }, size: 'S' },
    { id: 'inventory-us-west', kind: 'inventory', region: 'us-west', position: { x: 240, y: 480 }, size: 'M' },
  ];
  const edges: Record<string, unknown>[] = [
    { id: 'e-source-us', from: 'customers-us-west', to: 'app-us-west', kind: 'request' },
    { id: 'e-source-eu', from: 'customers-eu-central', to: 'app-eu-central', kind: 'request' },
    { id: 'e-source-ap', from: 'customers-ap-northeast', to: 'app-ap-northeast', kind: 'request' },
    { id: 'e-ack-us', from: 'app-us-west', to: 'journal-us-west', kind: 'request' },
    { id: 'e-ack-eu', from: 'app-eu-central', to: 'journal-eu-central', kind: 'request' },
    { id: 'e-ack-ap', from: 'app-ap-northeast', to: 'journal-ap-northeast', kind: 'request' },
    { id: 'e-inv-us', from: 'app-us-west', to: 'inventory-us-west', kind: 'request' },
    { id: 'e-inv-eu', from: 'app-eu-central', to: 'inventory-us-west', kind: 'request' },
    { id: 'e-inv-ap', from: 'app-ap-northeast', to: 'inventory-us-west', kind: 'request' },
  ];
  const circuits: Record<string, unknown>[] = [
    { regions: ['us-west', 'eu-central'], mbps: 8 },
    { regions: ['us-west', 'ap-northeast'], mbps: 32 },
    { regions: ['eu-central', 'ap-northeast'], mbps: 8 },
  ];
  if (withCrossRegion) {
    edges.push(
      { id: 'p-us-eu', from: 'app-us-west', to: 'app-eu-central', kind: 'request' },
      { id: 'p-eu-us', from: 'app-eu-central', to: 'app-us-west', kind: 'request' },
      { id: 'p-eu-ap', from: 'app-eu-central', to: 'app-ap-northeast', kind: 'request' },
      { id: 'p-ap-eu', from: 'app-ap-northeast', to: 'app-eu-central', kind: 'request' },
      { id: 'p-us-ap', from: 'app-us-west', to: 'app-ap-northeast', kind: 'request' },
      { id: 'p-ap-us', from: 'app-ap-northeast', to: 'app-us-west', kind: 'request' },
    );
  }
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes,
    edges,
    circuits,
  } as unknown as CartGraph;
}

function record(overrides: Partial<CartRequestRecord>): CartRequestRecord {
  return {
    id: 'r1',
    caseId: 'normal',
    cartId: 'cart-1',
    region: 'us-west',
    operation: 'edit',
    cohort: 'healthy',
    offeredUs: 1_000,
    deadlineUs: 1_001_000,
    deliveredUs: 2_000,
    outcome: 'committed',
    committed: true,
    acknowledged: true,
    unresolved: false,
    rejected: false,
    dependencyFailed: false,
    exempt: false,
    deliveryUs: 2_000,
    evidenceIds: [],
    ...overrides,
  };
}

describe('safety audit denominators', () => {
  it('classifies committed, acknowledged, unresolved and rejected requests exactly once', () => {
    const records = [
      record({ id: 'a' }),
      record({ id: 'b', committed: false, outcome: 'unavailable' }),
      record({ id: 'c', committed: false, acknowledged: false, deliveredUs: null, deliveryUs: null }),
      record({ id: 'd', committed: false, acknowledged: false, rejected: true, deliveredUs: null, deliveryUs: null }),
    ];
    const audit = auditCartSafety(records);
    expect(audit.denominator).toBe(4);
    expect(audit.committed).toBe(1);
    expect(audit.acknowledged).toBe(1);
    expect(audit.unresolved).toBe(1);
    expect(audit.rejected).toBe(1);
    expect(audit.pass).toBe(true);
    expect(records.map(safetyClassOf)).toEqual(['committed', 'acknowledged', 'unresolved', 'rejected']);
  });

  it('rejects an acknowledged request without a delivery and keeps failure denominators', () => {
    const audit = auditCartSafety([
      record({ id: 'a' }),
      record({ id: 'x', committed: false, deliveredUs: null, deliveryUs: null }),
    ]);
    expect(audit.denominator).toBe(2);
    expect(audit.pass).toBe(false);
    expect(audit.violations).toContain('acknowledged-without-delivery:x');
  });
});

describe('partition exemption scoping', () => {
  it('exempts declared incident cohorts but keeps healthy and local-context gates', () => {
    const records = [
      record({ id: 'h1', cohort: 'healthy' }),
      record({ id: 'h2', cohort: 'healthy', committed: false, acknowledged: false, deliveredUs: null, deliveryUs: null }),
      record({ id: 'l1', cohort: 'local-context-edit', committed: false, acknowledged: false, deliveredUs: null, deliveryUs: null }),
      record({ id: 'p1', cohort: 'incident-affected', committed: false, outcome: 'unavailable' }),
    ];
    const gates = buildCaseGates('normal', records);
    const healthy = gates.find((gate) => gate.code === 'healthy-slo-edit-us-west');
    expect(healthy).toBeDefined();
    expect(healthy?.observed).toBeCloseTo(0.5, 5);
    expect(healthy?.pass).toBe(false);
    const affected = gates.find((gate) => gate.code.startsWith('affected-terminal-'));
    expect(affected?.observed).toBeCloseTo(1, 5);
    // The healthy cohort gate counts every record in its own denominator.
    const localGates = gates.filter((gate) => gate.cohort.startsWith('local-context-edit'));
    expect(localGates).toHaveLength(1);
    expect(localGates[0]?.pass).toBe(false);
  });
});

describe('cost and score eligibility', () => {
  const graph = qualifyingGraph(true);

  it('awards no score for an incomplete drain and charges setup/drain in the window', () => {
    const complete = computeCartCost({
      graph,
      wanBillableBytes: 1_073_741_824,
      drainUs: 10_000_000,
      drainComplete: true,
      complete: true,
    });
    expect(complete.scoreEligible).toBe(true);
    expect(complete.scoreCreditsPerHour).not.toBeNull();
    expect(complete.windowSeconds).toBeCloseTo(100, 6);

    const incomplete = computeCartCost({
      graph,
      wanBillableBytes: 1_073_741_824,
      drainUs: 10_000_000,
      drainComplete: false,
      complete: true,
    });
    expect(incomplete.scoreCreditsPerHour).toBeNull();
    expect(incomplete.reasons).toContain('drain-incomplete');
  });

  it('costs more as attributable preparation and drain time grow', () => {
    const base = computeCartCost({
      graph,
      wanBillableBytes: 0,
      drainComplete: true,
      complete: true,
    });
    const extended = computeCartCost({
      graph,
      wanBillableBytes: 0,
      preparationUs: 5_000_000,
      drainUs: 10_000_000,
      drainComplete: true,
      complete: true,
    });
    expect(extended.windowSeconds).toBeGreaterThan(base.windowSeconds);
    expect(extended.scoreCreditsPerHour).toBeGreaterThan(base.scoreCreditsPerHour as number);
  });
});

describe('session and case execution', () => {
  it('treats the source-only starter as unqualified and never awards a score', () => {
    const evaluation = evaluateCart(createCartStarterGraph(), { seed: 1729 });
    expect(evaluation.requiredCases).toEqual([...CART_REQUIRED_CASES]);
    expect(evaluation.complete).toBe(false);
    expect(evaluation.qualified).toBe(false);
    expect(evaluation.scoreCreditsPerHour).toBeNull();
    expect(evaluation.issues.length).toBeGreaterThan(0);
  });

  it('exposes an advance/cancel/result session that never scores a cancelled run', () => {
    const session = createCartSession(createCartStarterGraph(), { seed: 1729 });
    const first = session.advance(10);
    expect(first.progress.casesCompleted).toBeLessThanOrEqual(CART_REQUIRED_CASES.length);
    session.cancel();
    const cancelled = session.result();
    expect(cancelled).not.toBeNull();
    expect(cancelled?.complete).toBe(false);
    expect(cancelled?.scoreCreditsPerHour).toBeNull();
  });

  it('derives authorities, inventory and region links from the executed topology', () => {
    const facts = analyzeCartTopology(qualifyingGraph(true));
    expect(facts.qualified).toBe(true);
    expect(facts.authorityByRegion['us-west']).toBe('journal-us-west');
    expect(facts.inventoryNodeId).toBe('inventory-us-west');
    expect(facts.regionLinks.length).toBe(6);
  });
});

describe('engine-backed execution', () => {
  it('runs a read and checkout through the shared read/inventory engines and bills WAN bytes', () => {
    const graph = qualifyingGraph(true);
    const facts = analyzeCartTopology(graph);
    const edit: CartOperationIntent = {
      id: 'e1',
      caseId: 'normal',
      atUs: 1_000_000,
      cartId: 'cart-x',
      region: 'us-west',
      remoteReadRegion: null,
      key: { originRegion: 'us-west', clientId: 'client-a', requestSequence: 1 },
      slotIndex: 0,
      stream: 'base',
      operation: 'edit',
      editKind: 'add',
      effect: { kind: 'add', sku: 7, count: 2 },
      observedContext: [],
      dependsOn: [],
    };
    // Remote read: it must cross a real WAN pair, so the shared network bills bytes.
    const read: CartOperationIntent = {
      id: 'r1',
      caseId: 'normal',
      atUs: 4_000_000,
      cartId: 'cart-x',
      region: 'eu-central',
      remoteReadRegion: 'eu-central',
      key: { originRegion: 'us-west', clientId: 'client-a', requestSequence: 2 },
      slotIndex: 1,
      stream: 'base',
      operation: 'read',
      editKind: null,
      effect: { kind: 'read', token: ['e1'], servedBy: 'eu-central' },
      observedContext: [],
      dependsOn: ['e1'],
    };
    const checkout: CartOperationIntent = {
      id: 'c1',
      caseId: 'normal',
      atUs: 9_000_000,
      cartId: 'cart-x',
      region: 'eu-central',
      remoteReadRegion: null,
      key: { originRegion: 'eu-central', clientId: 'client-a', requestSequence: 3 },
      slotIndex: 2,
      stream: 'base',
      operation: 'checkout',
      editKind: null,
      effect: { kind: 'checkout', selectionReadId: 'r1' },
      observedContext: [],
      dependsOn: ['r1'],
    };
    const model = new CartCaseModel('normal', facts, [edit, read, checkout], [], graph, {
      measuredUs: 12_000_000,
    });
    model.run();
    const records = model.requestRecords;
    const editRecord = records.find((record) => record.id === 'e1');
    const readRecord = records.find((record) => record.id === 'r1');
    const checkoutRecord = records.find((record) => record.id === 'c1');
    expect(editRecord?.outcome).toBe('committed');
    // The read outcome and its covered operation set come from CartReadEngine.
    expect(readRecord?.outcome).toBe('committed');
    expect(readRecord?.evidenceIds).toContain('us-west/client-a/1');
    // The checkout terminal row comes from CartInventory Lookup/Commit.
    expect(checkoutRecord?.committed).toBe(true);
    expect(checkoutRecord?.outcome).toBe('committed');
    // Physical WAN serialization of the remote read is really billed.
    expect(model.wanBillableBytes).toBeGreaterThan(0);
  });
});

describe('completion-driven edit protocol', () => {
  function editIntent(id: string, sequence: number, atUs = 1_000_000): CartOperationIntent {
    return {
      id,
      caseId: 'normal',
      atUs,
      cartId: 'cart-fifo',
      region: 'us-west',
      remoteReadRegion: null,
      key: { originRegion: 'us-west', clientId: 'client-a', requestSequence: sequence },
      slotIndex: sequence - 1,
      stream: 'base',
      operation: 'edit',
      editKind: 'add',
      effect: { kind: 'add', sku: 7, count: 2 },
      observedContext: [],
      dependsOn: [],
    };
  }

  it('admits simultaneous offers through the shared clock in FIFO order', () => {
    const graph = qualifyingGraph(true);
    const facts = analyzeCartTopology(graph);
    const model = new CartCaseModel(
      'normal',
      facts,
      [editIntent('e1', 1), editIntent('e2', 2)],
      [],
      graph,
      { measuredUs: 4_000_000 },
    );
    model.run();
    const first = model.requestRecords.find((record) => record.id === 'e1');
    const second = model.requestRecords.find((record) => record.id === 'e2');
    expect(first?.outcome).toBe('committed');
    expect(second?.outcome).toBe('committed');
    expect(first?.acknowledged).toBe(true);
    expect(second?.acknowledged).toBe(true);
    // The second offer queues behind the first on the shared client link and
    // application service: identical delivery times would mean the protocol is
    // duration-only rather than physically ordered.
    expect(first?.deliveredUs).not.toBeNull();
    expect(second?.deliveredUs).not.toBeNull();
    expect(second?.deliveredUs as number).toBeGreaterThan(first?.deliveredUs as number);
  });

  it('yields identical records at two different advance cadences', () => {
    const graph = qualifyingGraph(true);
    const facts = analyzeCartTopology(graph);
    const intents = [editIntent('e1', 1), editIntent('e2', 2), editIntent('e3', 3, 1_050_000)];
    const whole = new CartCaseModel('normal', facts, intents, [], graph, { measuredUs: 4_000_000 });
    whole.run();
    const sliced = new CartCaseModel('normal', facts, intents, [], graph, { measuredUs: 4_000_000 });
    let guard = 0;
    while (!sliced.step(1)) {
      guard += 1;
      if (guard > 1000) throw new Error('advance cadence did not terminate');
    }
    expect(sliced.requestRecords).toEqual(whole.requestRecords);
  });

  it('commits only after the protocol completes, never at offer time', () => {
    const graph = qualifyingGraph(true);
    const facts = analyzeCartTopology(graph);
    // The measured window closes before ingress can be delivered (the client
    // access propagation alone is 8 ms), so the request must stay uncommitted
    // and unresolved instead of being booked as a plan-time success.
    const model = new CartCaseModel('normal', facts, [editIntent('e1', 1, 89_999_000)], [], graph);
    model.run();
    const early = model.requestRecords.find((entry) => entry.id === 'e1');
    expect(early?.committed).toBe(false);
    expect(early?.acknowledged).toBe(false);
    expect(early?.unresolved).toBe(true);
    expect(early?.deliveredUs).toBeNull();

    const complete = new CartCaseModel('normal', facts, [editIntent('e1', 1)], [], graph, {
      measuredUs: 4_000_000,
    });
    complete.run();
    const record = complete.requestRecords.find((entry) => entry.id === 'e1');
    expect(record?.committed).toBe(true);
    expect(record?.acknowledged).toBe(true);
    // Delivery is a real completion after the offered time.
    expect(record?.deliveredUs as number).toBeGreaterThan(1_000_000);
  });
});

describe('reads executed through real network events', () => {
  function intentBase(id: string, sequence: number, atUs: number, cartId: string) {
    return {
      id,
      caseId: 'normal' as const,
      atUs,
      cartId,
      region: 'us-west' as const,
      remoteReadRegion: null,
      key: { originRegion: 'us-west' as const, clientId: 'client-a', requestSequence: sequence },
      slotIndex: sequence - 1,
      stream: 'base' as const,
      observedContext: [],
      dependsOn: [],
    };
  }

  function editIntent(id: string, sequence: number, atUs = 1_000_000): CartOperationIntent {
    return {
      ...intentBase(id, sequence, atUs, 'cart-net'),
      operation: 'edit',
      editKind: 'add',
      effect: { kind: 'add', sku: 7, count: 2 },
    };
  }

  function readIntent(
    id: string,
    sequence: number,
    atUs: number,
    token: readonly string[] = [],
  ): CartOperationIntent {
    return {
      ...intentBase(id, sequence, atUs, 'cart-net'),
      operation: 'read',
      editKind: null,
      effect: { kind: 'read', token: [...token], servedBy: 'us-west' },
      dependsOn: [...token],
    };
  }

  it('interleaves a simultaneous edit and read on one shared scheduler', () => {
    const graph = qualifyingGraph(true);
    const facts = analyzeCartTopology(graph);
    const offeredUs = 5_000_000;
    const model = new CartCaseModel(
      'normal',
      facts,
      [editIntent('e1', 1, offeredUs), readIntent('r1', 2, offeredUs)],
      [],
      graph,
      { measuredUs: 12_000_000 },
    );
    model.run();
    const edit = model.requestRecords.find((entry) => entry.id === 'e1');
    const read = model.requestRecords.find((entry) => entry.id === 'r1');
    expect(edit?.outcome).toBe('committed');
    expect(edit?.acknowledged).toBe(true);
    expect(read?.outcome).toBe('committed');
    expect(read?.acknowledged).toBe(true);
    // Both were offered at the same instant; neither is delivered at offer
    // time, and the shared client link/app service keeps them distinct.
    expect(edit?.deliveredUs as number).toBeGreaterThan(offeredUs);
    expect(read?.deliveredUs as number).toBeGreaterThan(offeredUs);
    expect(read?.deliveredUs).not.toBe(edit?.deliveredUs);
  });

  it('keeps reads unavailable when the drawn path or drawn token is missing', () => {
    const graph = qualifyingGraph(true);
    const withoutApp = {
      ...graph,
      nodes: graph.nodes.filter((node) => node.id !== 'app-ap-northeast'),
    } as CartGraph;
    const facts = analyzeCartTopology(withoutApp);
    const missingPath: CartOperationIntent = {
      id: 'r-path',
      caseId: 'normal',
      atUs: 1_000_000,
      cartId: 'cart-missing',
      region: 'ap-northeast',
      remoteReadRegion: null,
      key: { originRegion: 'ap-northeast', clientId: 'client-a', requestSequence: 1 },
      slotIndex: 0,
      stream: 'base',
      operation: 'read',
      editKind: null,
      effect: { kind: 'read', token: [], servedBy: 'ap-northeast' },
      observedContext: [],
      dependsOn: [],
    };
    const model = new CartCaseModel('normal', facts, [missingPath], [], withoutApp, {
      measuredUs: 8_000_000,
    });
    model.run();
    const pathRecord = model.requestRecords.find((entry) => entry.id === 'r-path');
    expect(pathRecord?.committed).toBe(false);
    expect(pathRecord?.acknowledged).toBe(false);
    expect(pathRecord?.outcome).toBe('rejected');
    expect(pathRecord?.evidenceIds).toContain('no-application');

    const complete = analyzeCartTopology(graph);
    const orphan = {
      ...readIntent('r-token', 1, 1_000_000, ['never-drawn']),
      dependsOn: [],
    };
    const orphanToken = new CartCaseModel(
      'normal',
      complete,
      [orphan],
      [],
      graph,
      { measuredUs: 8_000_000 },
    );
    orphanToken.run();
    const tokenRecord = orphanToken.requestRecords.find((entry) => entry.id === 'r-token');
    expect(tokenRecord?.committed).toBe(false);
    expect(['validation-failed', 'unavailable', 'timeout']).toContain(tokenRecord?.outcome);
  });

  it('withholds a read whose contact is cancelled by the partition', () => {
    const graph = qualifyingGraph(true);
    const facts = analyzeCartTopology(graph);
    // Offered just before the Tokyo partition; the cross-region contact runs
    // into the disabled WAN pair, so the response never arrives.
    const remote: CartOperationIntent = {
      id: 'r-partition',
      caseId: 'normal',
      atUs: 29_950_000,
      cartId: 'cart-partition',
      region: 'us-west',
      remoteReadRegion: 'ap-northeast',
      key: { originRegion: 'us-west', clientId: 'client-a', requestSequence: 1 },
      slotIndex: 0,
      stream: 'base',
      operation: 'read',
      editKind: null,
      effect: { kind: 'read', token: [], servedBy: 'us-west' },
      observedContext: [],
      dependsOn: [],
    };
    const model = new CartCaseModel('normal', facts, [remote], [], graph, {
      measuredUs: 55_000_000,
    });
    model.run();
    const record = model.requestRecords.find((entry) => entry.id === 'r-partition');
    expect(record?.committed).toBe(false);
    expect(record?.outcome).not.toBe('committed');
  });

  it('does not credit a read whose client delivery lands after the window', () => {
    const graph = qualifyingGraph(true);
    const facts = analyzeCartTopology(graph);
    const model = new CartCaseModel('normal', facts, [readIntent('r-late', 1, 89_999_000)], [], graph, {
      measuredUs: 90_000_000,
    });
    model.run();
    const record = model.requestRecords.find((entry) => entry.id === 'r-late');
    expect(record?.committed).toBe(false);
    expect(record?.acknowledged).toBe(false);
    expect(record?.unresolved).toBe(true);
    expect(record?.deliveredUs).toBeNull();
    expect(record?.outcome).toBe('timeout');
  });

  it('produces identical records at two advance cadences for a mixed edit/read trace', () => {
    const graph = qualifyingGraph(true);
    const facts = analyzeCartTopology(graph);
    const intents = [
      editIntent('e1', 1, 1_000_000),
      readIntent('r1', 2, 1_050_000),
      editIntent('e2', 3, 1_100_000),
    ];
    const whole = new CartCaseModel('normal', facts, intents, [], graph, { measuredUs: 6_000_000 });
    whole.run();
    const sliced = new CartCaseModel('normal', facts, intents, [], graph, { measuredUs: 6_000_000 });
    let guard = 0;
    while (!sliced.step(1)) {
      guard += 1;
      if (guard > 1_000) throw new Error('advance cadence did not terminate');
    }
    expect(sliced.requestRecords).toEqual(whole.requestRecords);
  });
});

describe('atomic checkout over drawn network routes', () => {
  function graphWithInventory(
    region: CartRegion,
    omitCircuits: readonly (readonly [CartRegion, CartRegion])[] = [],
  ): CartGraph {
    const base = qualifyingGraph(true);
    const nodes = base.nodes.map((node) =>
      node.id === 'inventory-us-west' ? { ...node, id: 'inventory', region } : node,
    );
    const edges = base.edges.map((edge) =>
      edge.to === 'inventory-us-west' ? { ...edge, to: 'inventory' } : edge,
    );
    const circuits = base.circuits.filter(
      (circuit) =>
        !omitCircuits.some(
          ([left, right]) =>
            circuit.regions.includes(left) && circuit.regions.includes(right),
        ),
    );
    return { ...base, nodes, edges, circuits } as unknown as CartGraph;
  }

  function editIntent(
    id = 'e1',
    atUs = 1_000_000,
    cartId = 'cart-checkout',
  ): CartOperationIntent {
    return {
      id,
      caseId: 'normal',
      atUs,
      cartId,
      region: 'us-west',
      remoteReadRegion: null,
      key: { originRegion: 'us-west', clientId: 'client-a', requestSequence: 1 },
      slotIndex: 0,
      stream: 'base',
      operation: 'edit',
      editKind: 'add',
      effect: { kind: 'add', sku: 7, count: 2 },
      observedContext: [],
      dependsOn: [],
    };
  }

  function readIntent(
    id = 'r1',
    atUs = 2_000_000,
    cartId = 'cart-checkout',
    servedBy: CartRegion = 'us-west',
  ): CartOperationIntent {
    return {
      id,
      caseId: 'normal',
      atUs,
      cartId,
      region: servedBy,
      remoteReadRegion: null,
      key: { originRegion: servedBy, clientId: 'client-a', requestSequence: 2 },
      slotIndex: 1,
      stream: 'base',
      operation: 'read',
      editKind: null,
      effect: { kind: 'read', token: ['e1'], servedBy },
      observedContext: [],
      dependsOn: ['e1'],
    };
  }

  function checkoutIntent(options: {
    readonly id: string;
    readonly atUs: number;
    readonly origin: CartRegion;
    readonly sequence: number;
    readonly cartId?: string;
    readonly clientId?: string;
  }): CartOperationIntent {
    return {
      id: options.id,
      caseId: 'normal',
      atUs: options.atUs,
      cartId: options.cartId ?? 'cart-checkout',
      region: options.origin,
      remoteReadRegion: null,
      key: {
        originRegion: options.origin,
        clientId: options.clientId ?? 'client-a',
        requestSequence: options.sequence,
      },
      slotIndex: options.sequence,
      stream: 'base',
      operation: 'checkout',
      editKind: null,
      effect: { kind: 'checkout', selectionReadId: 'r1' },
      observedContext: [],
      dependsOn: ['r1'],
    };
  }

  function transfersFor(model: CartCaseModel, id: string) {
    return model.transferSnapshots.filter((transfer) => transfer.logicalId.startsWith(`${id}:`));
  }

  function wanBilled(model: CartCaseModel, id: string): number {
    return transfersFor(model, id)
      .filter((transfer) => transfer.wanPair !== null)
      .reduce((sum, transfer) => sum + transfer.billedWanBytes, 0);
  }

  it('runs Lookup then Commit as real routed exchanges and bills every WAN stage once', () => {
    const graph = graphWithInventory('eu-central');
    const facts = analyzeCartTopology(graph);
    const checkout = checkoutIntent({ id: 'c1', atUs: 3_000_000, origin: 'us-west', sequence: 3 });
    const model = new CartCaseModel(
      'normal',
      facts,
      [editIntent(), readIntent(), checkout],
      [],
      graph,
      { measuredUs: 8_000_000 },
    );
    model.run();

    const record = model.requestRecords.find((entry) => entry.id === 'c1');
    expect(record?.outcome).toBe('committed');
    expect(record?.committed).toBe(true);
    expect(record?.acknowledged).toBe(true);
    expect(record?.deliveredUs as number).toBeGreaterThan(3_000_000);
    expect(model.inventoryOrders).toHaveLength(1);
    expect(model.inventoryStock['7']).toBe(1_000_000 - 2);

    const transfers = transfersFor(model, 'c1');
    expect(transfers.map((transfer) => transfer.logicalId).sort()).toEqual([
      'c1:commit-reply:0',
      'c1:commit:0',
      'c1:in:0',
      'c1:lookup-reply:0',
      'c1:lookup:0',
      'c1:out:0',
    ]);
    for (const transfer of transfers) {
      expect(transfer.status).toBe('delivered');
      expect(transfer.deadlineUs).toBe(3_000_000 + 1_000_000);
    }
    // Every physical stage appears exactly once; WAN bytes are the actual
    // serialized bytes of the four cross-region exchanges, never double-billed.
    const wanStages = transfers.filter((transfer) => transfer.wanPair !== null);
    expect(wanStages).toHaveLength(4);
    for (const transfer of wanStages) {
      expect(transfer.billedWanBytes).toBe(transfer.bytes);
    }
    // The read protocol's own WAN exchanges are separate; the checkout adds
    // exactly its four WAN stages to the model total.
    expect(model.wanBillableBytes).toBe(wanBilled(model, 'r1') + wanBilled(model, 'c1'));
    expect(transfers.find((transfer) => transfer.logicalId === 'c1:in:0')?.bytes).toBe(
      CART_CHECKOUT_INGRESS_BYTES + CART_CHECKOUT_LINE_BYTES * 1,
    );

    const lookupBytes =
      CART_CHECKOUT_LOOKUP_REQUEST_BYTES +
      CART_CHECKOUT_LINE_BYTES * 1 +
      CART_CHECKOUT_COVERED_ID_BYTES * 1;
    const commitBytes =
      CART_CHECKOUT_COMMIT_REQUEST_BYTES +
      CART_CHECKOUT_LINE_BYTES * 1 +
      CART_CHECKOUT_COVERED_ID_BYTES * 1;
    expect(wanBilled(model, 'c1')).toBe(
      lookupBytes + CART_CHECKOUT_REPLY_BYTES + commitBytes + CART_CHECKOUT_REPLY_BYTES,
    );
  });

  it('never mutates stock or the ledger before the Commit request arrives', () => {
    const graph = graphWithInventory('eu-central');
    const facts = analyzeCartTopology(graph);
    const late = checkoutIntent({
      id: 'c-late',
      atUs: 89_999_000,
      origin: 'us-west',
      sequence: 3,
    });
    const model = new CartCaseModel(
      'normal',
      facts,
      [editIntent(), readIntent(), late],
      [],
      graph,
      { measuredUs: 90_000_000 },
    );
    model.run();

    const record = model.requestRecords.find((entry) => entry.id === 'c-late');
    expect(record?.committed).toBe(false);
    expect(record?.acknowledged).toBe(false);
    expect(record?.unresolved).toBe(true);
    expect(record?.deliveredUs).toBeNull();
    expect(model.inventoryOrders).toHaveLength(0);
    expect(model.inventoryLedgerRows).toHaveLength(0);
    expect(model.inventoryStock['7']).toBe(1_000_000);
    // Only the client request was ever offered; no Lookup or Commit with its
    // stock effect can exist before that request arrived.
    expect(transfersFor(model, 'c-late').map((transfer) => transfer.logicalId)).toEqual([
      'c-late:in:0',
    ]);
  });

  it('keeps concurrent Lookup misses from double-buying one binding', () => {
    const graph = graphWithInventory('eu-central');
    const facts = analyzeCartTopology(graph);
    // Same cart, read, order key and binding from two regions, offered at the
    // same instant. Both Lookups reach Inventory before either Commit.
    const first = checkoutIntent({ id: 'c1', atUs: 3_000_000, origin: 'us-west', sequence: 9 });
    const second = checkoutIntent({
      id: 'c2',
      atUs: 3_000_000,
      origin: 'ap-northeast',
      sequence: 9,
    });
    const model = new CartCaseModel(
      'normal',
      facts,
      [editIntent(), readIntent(), first, second],
      [],
      graph,
      { measuredUs: 8_000_000 },
    );
    model.run();

    const records = model.requestRecords.filter((entry) => entry.id === 'c1' || entry.id === 'c2');
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.outcome)).toEqual(['committed', 'committed']);
    // Both sent Commit (both Lookups missed), but Inventory's in-transaction
    // ledger recheck published exactly one order and one decrement.
    expect(transfersFor(model, 'c1').some((transfer) => transfer.logicalId === 'c1:commit:0')).toBe(true);
    expect(transfersFor(model, 'c2').some((transfer) => transfer.logicalId === 'c2:commit:0')).toBe(true);
    expect(model.inventoryOrders).toHaveLength(1);
    expect(model.inventoryLedgerRows).toHaveLength(1);
    expect(model.inventoryStock['7']).toBe(1_000_000 - 2);
  });

  it('retries a lost post-commit reply with the same absolute deadline and one decrement', () => {
    const graph = graphWithInventory('eu-central');
    const facts = analyzeCartTopology(graph);
    const checkout = checkoutIntent({ id: 'c1', atUs: 3_000_000, origin: 'us-west', sequence: 3 });
    const model = new CartCaseModel(
      'normal',
      facts,
      [editIntent(), readIntent(), checkout],
      [],
      graph,
      {
        measuredUs: 8_000_000,
        checkoutFaults: { discardFirstCommitReply: true },
      },
    );
    model.run();

    const record = model.requestRecords.find((entry) => entry.id === 'c1');
    expect(record?.outcome).toBe('committed');
    expect(record?.committed).toBe(true);
    expect(record?.acknowledged).toBe(true);
    expect(record?.deliveredUs as number).toBeGreaterThan(3_000_000);
    expect(model.inventoryOrders).toHaveLength(1);
    expect(model.inventoryStock['7']).toBe(1_000_000 - 2);

    const transfers = transfersFor(model, 'c1');
    const ids = transfers.map((transfer) => transfer.logicalId);
    const firstReply = transfers.find((transfer) => transfer.logicalId === 'c1:commit-reply:0');
    const retryLookup = transfers.find((transfer) => transfer.logicalId === 'c1:lookup:1');
    expect(firstReply?.status).toBe('delivered');
    expect(retryLookup).toBeDefined();
    expect(ids).not.toContain('c1:commit:1');
    // The retry starts 25 ms after the lost reply, not with a fresh deadline.
    expect((retryLookup?.enqueuedAtUs as number) - (firstReply?.deliveredAtUs as number)).toBeGreaterThanOrEqual(
      CART_CHECKOUT_RETRY_BACKOFF_US,
    );
    for (const transfer of transfers) {
      expect(transfer.deadlineUs).toBe(3_000_000 + 1_000_000);
    }
    // The lost reply still crossed and was billed; the retry's Lookup and
    // reply are additional actual traffic, and nothing is billed twice.
    expect(firstReply?.billedWanBytes).toBe(CART_CHECKOUT_REPLY_BYTES);
    expect(model.wanBillableBytes).toBe(wanBilled(model, 'r1') + wanBilled(model, 'c1'));
  });

  it('rejects a checkout with no drawn Inventory dependency', () => {
    const base = qualifyingGraph(true);
    const graph = {
      ...base,
      nodes: base.nodes.filter((node) => node.id !== 'inventory-us-west'),
      edges: base.edges.filter((edge) => edge.to !== 'inventory-us-west'),
    } as unknown as CartGraph;
    const facts = analyzeCartTopology(graph);
    const checkout = checkoutIntent({ id: 'c1', atUs: 3_000_000, origin: 'us-west', sequence: 3 });
    const model = new CartCaseModel(
      'normal',
      facts,
      [editIntent(), readIntent(), checkout],
      [],
      graph,
      { measuredUs: 8_000_000 },
    );
    model.run();

    const record = model.requestRecords.find((entry) => entry.id === 'c1');
    expect(record?.outcome).toBe('rejected');
    expect(record?.committed).toBe(false);
    expect(record?.acknowledged).toBe(false);
    expect(record?.evidenceIds).toContain('missing-inventory');
    expect(model.inventoryOrders).toHaveLength(0);
    expect(transfersFor(model, 'c1')).toHaveLength(0);
  });

  it('answers an unreachable Inventory dependency with explicit unavailable before the deadline', () => {
    const graph = graphWithInventory('ap-northeast');
    const facts = analyzeCartTopology(graph);
    const checkout = checkoutIntent({
      id: 'c1',
      atUs: 35_000_000,
      origin: 'us-west',
      sequence: 3,
    });
    const model = new CartCaseModel(
      'normal',
      facts,
      [editIntent(), readIntent(), checkout],
      [],
      graph,
      { measuredUs: 40_000_000 },
    );
    model.run();

    const record = model.requestRecords.find((entry) => entry.id === 'c1');
    expect(record?.cohort).toBe('incident-affected');
    expect(record?.outcome).toBe('unavailable');
    expect(record?.committed).toBe(false);
    expect(record?.acknowledged).toBe(true);
    expect(record?.deliveredUs as number).toBeLessThanOrEqual(35_000_000 + 1_000_000);
    expect(record?.evidenceIds).toContain('no-inventory-route');
    expect(model.inventoryOrders).toHaveLength(0);
    expect(model.inventoryStock['7']).toBe(1_000_000);
    const unavailable = transfersFor(model, 'c1').find(
      (transfer) => transfer.logicalId === 'c1:unavailable:0',
    );
    expect(unavailable?.status).toBe('delivered');
  });
});

describe('preparation and full execution cost', () => {
  const graph = qualifyingGraph(true);

  it('known-answer cost partitions WAN by phase and adds measured prep/drain once', () => {
    const gib = 1_073_741_824;
    const cost = computeCartCost({
      graph,
      wanBillableBytes: 2 * gib,
      wanPreparationBytes: gib / 4,
      wanMeasuredBytes: (3 * gib) / 2,
      wanDrainBytes: gib / 4,
      preparationUs: 1_000_000,
      drainUs: 2_000_000,
      measuredUs: 90_000_000,
      drainComplete: true,
      complete: true,
    });
    expect(cost.windowSeconds).toBeCloseTo(93, 9);
    expect(cost.wanPreparationBytes).toBe(gib / 4);
    expect(cost.wanMeasuredBytes).toBe((3 * gib) / 2);
    expect(cost.wanDrainBytes).toBe(gib / 4);
    const expected = (3_600 / 90) * ((cost.rentalPerHour * 93) / 3_600 + 2);
    expect(cost.scoreCreditsPerHour).toBeCloseTo(expected, 9);

    // A byte assigned to two phases (or lost from all) cannot be scored.
    expect(() =>
      computeCartCost({
        graph,
        wanBillableBytes: gib,
        wanPreparationBytes: gib / 2,
        wanMeasuredBytes: gib / 2,
        wanDrainBytes: gib / 2,
        drainComplete: true,
        complete: true,
      }),
    ).toThrow(/sum to wanBillableBytes/);
  });

  it('prepares nonempty fixtures through charged graph writes and measures the setup window', () => {
    const probes = buildCartProbes().probes.filter((probe) => probe.caseId === 'normal');
    // Pinned to the original 5 ms / 90 s profile: with the adopted 101 s window
    // the last offer settles before the window ends, so drain is legitimately 0.
    const run = runCartCase({ graph, caseId: 'normal', seed: 1729, workloadProfile: CART_WORKLOAD_PROFILE_ORIGINAL });
    const model = run.model;
    const prepIds = new Set(
      probes.flatMap((probe) => probe.steps.flatMap((step) => step.dependsOn)),
    );
    const prepSteps = probes.flatMap((probe) => probe.steps).filter((step) => prepIds.has(step.id));
    expect(prepSteps.length).toBeGreaterThan(0);
    for (const step of prepSteps) {
      expect(model.requestRecords.find((record) => record.id === step.id)?.acknowledged).toBe(true);
    }
    expect(model.preparationUs).toBeGreaterThan(0);
    expect(model.preparationUs).toBeLessThanOrEqual(CART_PREPARATION_LIMIT_US);
    expect(model.wanPreparationBillableBytes).toBeGreaterThan(0);
    expect(model.wanPreparationBillableBytes + model.wanDrainBillableBytes).toBeLessThanOrEqual(
      model.wanBillableBytes,
    );
    expect(model.wanBillableBytes - model.wanPreparationBillableBytes - model.wanDrainBillableBytes)
      .toBeGreaterThan(0);
    // Measured drain: pending serializations after traffic stop actually settle
    // inside the bounded window, so setup and drain are real measured values.
    expect(model.transferSnapshots.every((transfer) => transfer.status !== 'in-flight')).toBe(true);
    expect(model.actualDrainUs).toBeGreaterThan(0);
    expect(model.actualDrainUs).toBeLessThanOrEqual(CART_DRAIN_LIMIT_US);
    // Correct physical preparation can finish all WAN offers before 90 s;
    // drain time does not imply a new post-window WAN transfer was enqueued.
    expect(model.wanDrainBillableBytes).toBe(model.transferSnapshots
      .filter(transfer => transfer.enqueuedAtUs >= model.measuredEndUs)
      .reduce((bytes, transfer) => bytes + transfer.billedWanBytes, 0));
    const cost = computeCartCost({
      graph,
      wanBillableBytes: model.wanBillableBytes,
      wanPreparationBytes: model.wanPreparationBillableBytes,
      wanDrainBytes: model.wanDrainBillableBytes,
      wanMeasuredBytes:
        model.wanBillableBytes - model.wanPreparationBillableBytes - model.wanDrainBillableBytes,
      preparationUs: model.preparationUs,
      drainUs: model.actualDrainUs,
      drainComplete: true,
      complete: true,
    });
    // The phases partition every physical byte exactly once.
    expect(cost.wanPreparationBytes + cost.wanMeasuredBytes + cost.wanDrainBytes).toBe(
      cost.wanBillableBytes,
    );
    expect(cost.preparationSeconds).toBeCloseTo(model.preparationUs / 1_000_000, 9);
    expect(cost.drainSeconds).toBeCloseTo(model.actualDrainUs / 1_000_000, 9);
    expect(cost.windowSeconds).toBeCloseTo(
      90 + model.preparationUs / 1_000_000 + model.actualDrainUs / 1_000_000,
      9,
    );
  }, 60_000); // full 90 s original-profile case: ~12 s at accepted base ca1176a too (inherited 5 s default timeout was too small)

  it('keeps every predetermined descendant and denominator when preparation fails', () => {
    const probes = buildCartProbes().probes.filter((probe) => probe.caseId === 'normal');
    // Remove the us-west write path: preparation rejects and must cascade.
    const broken = {
      ...graph,
      nodes: graph.nodes.filter((node) => node.id !== 'app-us-west'),
      edges: graph.edges.filter((edge) => edge.from !== 'app-us-west' && edge.to !== 'app-us-west'),
    } as unknown as CartGraph;
    const facts = analyzeCartTopology(broken);
    const model = new CartCaseModel('normal', facts, [], probes, broken, { measuredUs: 90_000_000 });
    model.run();
    const allSteps = probes.flatMap((probe) => probe.steps);
    const usWest = allSteps.filter((step) => step.region === 'us-west');
    expect(usWest.length).toBeGreaterThan(0);
    expect(usWest.every((step) => model.requestRecords.some((record) => record.id === step.id))).toBe(true);
    const dependents = usWest.filter((step) => step.dependsOn.length > 0);
    expect(dependents.length).toBeGreaterThan(0);
    expect(
      dependents.every(
        (step) =>
          step.dependsOn.some((id) => {
            const parent = model.requestRecords.find((record) => record.id === id);
            return parent !== undefined && !parent.acknowledged;
          }) &&
          step.dependsOn.every((id) => {
            const parent = model.requestRecords.find((record) => record.id === id);
            return parent !== undefined && !parent.acknowledged
              ? model.requestRecords.find((record) => record.id === step.id)?.dependencyFailed === true
              : true;
          }),
      ),
    ).toBe(true);
    // No predetermined offer is dropped: one terminal record per scripted step.
    const stepIds = new Set(allSteps.map((step) => step.id));
    expect(model.requestRecords.filter((record) => stepIds.has(record.id))).toHaveLength(
      allSteps.length,
    );
  });
});

describe('R5 incident cohort classification and frozen fixtures', () => {
  it('classifies B3 boundary ties from actual required routes', () => {
    const route = { from: 'us-west' as const, to: 'ap-northeast' as const };
    const classify = (offerUs: number): string =>
      classifyCartCohort({
        offerUs,
        required: [route],
        reachableEnabled: () => true,
        reachableAt: (_requirement, atUs) => !(atUs >= 30_000_000 && atUs < 50_000_000),
      });
    expect(
      [29_999_999, 30_000_000, 49_999_999, 50_000_000, 54_999_999, 55_000_000].map(classify),
    ).toEqual([
      'healthy',
      'incident-affected',
      'incident-affected',
      'incident-backlog',
      'incident-backlog',
      'healthy',
    ]);
  });

  it('never exempts unhealthy topology or unrelated post-restoration delay', () => {
    expect(
      classifyCartCohort({
        offerUs: 35_000_000,
        required: [{ from: 'us-west', to: 'ap-northeast' }],
        reachableEnabled: () => false,
        reachableAt: () => false,
      }),
    ).toBe('healthy');
    expect(
      classifyCartCohort({
        offerUs: 54_000_000,
        required: [{ from: 'us-west', to: 'us-west' }],
        reachableEnabled: () => true,
        reachableAt: () => true,
      }),
    ).toBe('healthy');
  });

  it('executes the frozen partition fixtures with frozen probes and denominators', () => {
    const graph = qualifyingGraph(true);
    const probes = buildCartProbes().probes.filter((probe) => probe.caseId === 'partition');
    expect(probes).toHaveLength(36);
    const run = runCartCase({ graph, caseId: 'partition', seed: 1729, workloadProfile: CART_WORKLOAD_PROFILE_DESYNC100 });
    expect(run.result.scheduled).toBe(CART_CASE_OFFERED_COUNTS.partition + 36);
    expect(run.result.issued).toBeGreaterThanOrEqual(run.result.scheduled);
    const familyByStep = new Map<string, string>();
    for (const probe of probes) {
      for (const step of probe.steps) familyByStep.set(step.id, probe.family);
    }
    const records = run.model.requestRecords.filter((record) => record.operation === 'probe');
    const count = (family: string, predicate: (record: CartRequestRecord) => boolean): number =>
      records.filter((record) => familyByStep.get(record.id) === family && predicate(record)).length;
    // 18 boundary local-context edits stay committed and retain local gates.
    expect(
      count('partition-boundary', (record) => record.committed && record.cohort === 'local-context-edit'),
    ).toBe(18);
    // Directed/cache-clear reads are exempt only because the incident removes a
    // required origin route; they may never be counted as healthy success.
    expect(
      count(
        'partition-directed-read',
        (record) => record.operation === 'probe' && record.exempt && record.cohort === 'incident-affected',
      ),
    ).toBe(6);
    expect(count('partition-cache-clear', (record) => record.cohort === 'incident-affected')).toBe(3);
    expect(
      count('partition-cache-clear', (record) => record.acknowledged && record.outcome === 'unavailable'),
    ).toBe(3);
    // Empty-or-not recovery: every cart in C gets one delivered read per
    // region by 55000ms (thousands of carts here), including empty C.
    const recovery = run.model.requestRecords.filter((record) => record.operation === 'audit');
    expect(recovery.length).toBeGreaterThanOrEqual(3);
    expect(new Set(recovery.map((record) => record.region)).size).toBe(3);
    expect(
      recovery.every(
        (record) =>
          record.acknowledged && record.deliveredUs !== null && record.deliveredUs <= 55_000_000,
      ),
    ).toBe(true);
  }, 120_000);

  it('schedules one empty recovery read per region when the incident commits nothing', () => {
    const graph = qualifyingGraph(true);
    const facts = analyzeCartTopology(graph);
    const model = new CartCaseModel('partition', facts, [], [], graph);
    model.step(Number.POSITIVE_INFINITY);
    const audits = model.requestRecords.filter((record) => record.operation === 'audit');
    expect(audits).toHaveLength(3);
    expect(
      audits.every(
        (record) =>
          record.acknowledged && record.deliveredUs !== null && record.deliveredUs <= 55_000_000,
      ),
    ).toBe(true);
  });

  it('executes every frozen partition fixture through real Inventory replay and safety', () => {
    const run = runCartCase({
      graph: qualifyingGraph(true),
      caseId: 'partition',
      seed: 1729,
      workloadProfile: CART_WORKLOAD_PROFILE_DESYNC100,
    });
    expect(run.result.scheduled).toBe(CART_CASE_OFFERED_COUNTS.partition + 36);
    const probes = run.model.requestRecords.filter((entry) => entry.operation === 'probe');
    // Every fixture step keeps a terminal record: denominators never shrink.
    expect(probes.length).toBeGreaterThanOrEqual(36);
    // An explicit replay is a durable duplicate, never a synthetic conflict.
    const replays = probes.filter((entry) => entry.id.endsWith(':replay'));
    expect(replays).toHaveLength(3);
    expect(replays.every((entry) => entry.outcome !== 'conflict' && entry.acknowledged)).toBe(true);
    // A known-stock fixture may never be answered with a fictitious rejection.
    expect(probes.some((entry) => entry.outcome === 'out-of-stock')).toBe(false);
    // The full audit passes: no durable success is ever reported without a
    // client-visible delivery, and every offer is classified exactly once.
    expect(auditCartSafety(run.model.requestRecords, 'partition').pass).toBe(true);
    // Incident backlog stays in its own denominator with a delivered recovery.
    expect(run.result.outcomes['cohort:incident-backlog'] ?? 0).toBeGreaterThan(0);
    const recovery = run.model.requestRecords.filter((entry) => entry.operation === 'audit');
    expect(new Set(recovery.map((entry) => entry.region))).toEqual(
      new Set(['us-west', 'eu-central', 'ap-northeast']),
    );
  }, 120_000);

  it('runs every required case on the actual full graph and withholds any ineligible score', () => {
    const graph = qualifyingGraph(true);
    // Public boundary entry point: all six required cases really execute.
    const evaluation = evaluateCart(graph, { seed: 1729, workloadProfile: CART_WORKLOAD_PROFILE_DESYNC100 });
    expect(evaluation.requiredCases).toEqual([...CART_ADVANCED_REQUIRED_CASES]);
    expect(evaluation.cases.map((entry) => entry.id)).toEqual([...CART_ADVANCED_REQUIRED_CASES]);
    for (const caseResult of evaluation.cases) {
      // Fixed frozen denominator: workload offers plus every mandatory probe.
      expect(caseResult.scheduled).toBe(
        CART_CASE_OFFERED_COUNTS[caseResult.id] + CART_PROBE_EXPECTED_COUNTS[caseResult.id],
      );
      expect(caseResult.outcomes.scheduled).toBe(caseResult.scheduled);
      expect(caseResult.issued).toBeGreaterThanOrEqual(caseResult.scheduled);
      expect(caseResult.complete).toBe(true);
      // Safety runs over the full record set, not a retained sample.
      const safety = caseResult.gates.find((gate) => gate.code === 'safety-audit');
      expect(safety).toBeDefined();
      expect(safety?.pass).toBe(true);
      expect(safety?.limit).toBeGreaterThan(0);
      expect(caseResult.outcomes.auditFailures).toBe(0);
    }
    expect(evaluation.complete).toBe(true);
    // Eligibility is all-or-nothing: a single failed gate (performance,
    // safety, recovery or denominator) withholds the whole score.
    const failing = evaluation.cases.flatMap((entry) =>
      entry.gates.filter((gate) => !gate.pass).map((gate) => `${entry.id}:${gate.code}`),
    );
    expect(evaluation.qualified).toBe(failing.length === 0);
    if (failing.length === 0) {
      expect(evaluation.scoreCreditsPerHour).not.toBeNull();
    } else {
      expect(evaluation.scoreCreditsPerHour).toBeNull();
    }

    // Negative control: an over-cap drain ends the case with no eligible score
    // even though the offered denominator and issued work are unchanged.
    const overDrain = runCartCase({
      graph,
      caseId: 'normal',
      seed: 1729,
      drainUs: CART_DRAIN_LIMIT_US + 1,
    });
    expect(overDrain.result.cost.peakScoreCreditsPerHour).toBe(-1);

    // Negative control: a breached execution cap leaves the case incomplete
    // after only part of the immutable denominator was issued.
    const overBudget = runCartCase({
      graph,
      caseId: 'normal',
      seed: 1729,
      runtimeBudgetMs: 1,
      now: () => Date.now(),
    });
    expect(overBudget.result.complete).toBe(false);
    expect(overBudget.result.issued).toBeLessThan(overBudget.result.scheduled);
    expect(overBudget.result.cost.peakScoreCreditsPerHour).toBe(-1);
  }, 600_000);
});
