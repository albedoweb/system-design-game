/**
 * GC-PE5 focused regressions: probe preparation is an ordinary charged write.
 *
 * GC-019D1 found that `executeProbeEdit` planned a transfer duration and then
 * recorded a future commit plus an ACK at `commitUs + 500` without waiting for
 * any actual settlement. A preparation write whose request/commit/ACK traffic
 * was cut or late still produced a durable commit, a ledger entry and a
 * successful client ACK.
 *
 * Every expectation below is asserted through an actual `CartCaseModel` run on
 * the shared network: the model really offers client→application, application→
 * authority and reply transfers, and the record must follow their settlement.
 * No frozen constant, fixture, oracle or workload is changed.
 */
import { describe, expect, it } from 'vitest';

import { CART_LEVEL_ID, CART_VERSIONS, type CartGraph } from '../index';
import { CartCaseModel, analyzeCartTopology } from '../core/model';
import { buildCartProbes } from '../core/challenges';
import { CartDurableStore } from '../core/durable-store';
import type { CartProbe, CartProbeStep } from '../core/challenges';
import { buildCartCaseWorkload, type CartOperationIntent } from '../core/workload';

interface GraphOptions {
  /** Move Tokyo's configured write authority across the partitioned WAN. */
  readonly apWriteAuthorityInEu?: boolean;
}

/**
 * Three-region qualified graph. WAN circuits exist for every pair, so a write
 * authority placed in another region is reachable and physically routed.
 */
function cartGraph(options: GraphOptions = {}): CartGraph {
  const customers = (region: string, x: number): Record<string, unknown> => ({
    id: `customers-${region}`,
    kind: 'customers',
    region,
    position: { x, y: 40 },
  });
  const app = (region: string, x: number, writeTarget: string): Record<string, unknown> => ({
    id: `app-${region}`,
    kind: 'application',
    region,
    position: { x, y: 200 },
    size: 'S',
    instances: 1,
    writeTarget,
    readPolicy: 'local-repair',
    readTargets: ['journal-us-west', 'journal-eu-central', 'journal-ap-northeast'],
  });
  const nodes: Record<string, unknown>[] = [
    customers('us-west', 40),
    customers('eu-central', 440),
    customers('ap-northeast', 840),
    app('us-west', 80, 'journal-us-west'),
    app('eu-central', 480, 'journal-eu-central'),
    app('ap-northeast', 880, options.apWriteAuthorityInEu === true ? 'journal-eu-central' : 'journal-ap-northeast'),
    { id: 'journal-us-west', kind: 'journal', region: 'us-west', position: { x: 80, y: 340 }, size: 'S' },
    { id: 'journal-eu-central', kind: 'journal', region: 'eu-central', position: { x: 480, y: 340 }, size: 'M' },
    { id: 'journal-ap-northeast', kind: 'journal', region: 'ap-northeast', position: { x: 880, y: 340 }, size: 'S' },
    { id: 'inventory-us-west', kind: 'inventory', region: 'us-west', position: { x: 240, y: 480 }, size: 'M' },
  ];
  const edges: Record<string, unknown>[] = [
    { id: 'src-us', from: 'customers-us-west', to: 'app-us-west', kind: 'request' },
    { id: 'src-eu', from: 'customers-eu-central', to: 'app-eu-central', kind: 'request' },
    { id: 'src-ap', from: 'customers-ap-northeast', to: 'app-ap-northeast', kind: 'request' },
    { id: 'write-us', from: 'app-us-west', to: 'journal-us-west', kind: 'request' },
    { id: 'write-eu', from: 'app-eu-central', to: 'journal-eu-central', kind: 'request' },
    { id: 'write-ap', from: 'app-ap-northeast', to: 'journal-ap-northeast', kind: 'request' },
    { id: 'inv-us', from: 'app-us-west', to: 'inventory-us-west', kind: 'request' },
    { id: 'inv-eu', from: 'app-eu-central', to: 'inventory-us-west', kind: 'request' },
    { id: 'inv-ap', from: 'app-ap-northeast', to: 'inventory-us-west', kind: 'request' },
  ];
  if (options.apWriteAuthorityInEu === true) {
    // The configured Tokyo authority is the east journal: a full request path
    // exists, but the commit RPC has to cross the Tokyo WAN circuit.
    edges.push({ id: 'write-ap-eu', from: 'app-ap-northeast', to: 'journal-eu-central', kind: 'request' });
  }
  const circuits: Record<string, unknown>[] = [
    { regions: ['us-west', 'eu-central'], mbps: 8 },
    { regions: ['us-west', 'ap-northeast'], mbps: 32 },
    { regions: ['eu-central', 'ap-northeast'], mbps: 8 },
  ];
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

function probeStep(
  probeId: string,
  part: string,
  action: CartProbeStep['action'],
  region: CartProbeStep['region'],
  atUs: number,
  deadlineUs: number | null,
  detail: CartProbeStep['detail'],
  dependsOn: readonly string[] = [],
): CartProbeStep {
  return {
    id: `${probeId}:${part}`,
    probeId,
    action,
    region,
    atUs,
    deadlineUs,
    trigger: 'scheduled',
    fallbackAtUs: null,
    dependsOn,
    detail,
  };
}

/** One probe: a prepared add at `prepAtUs`, then a read at `readAtUs`. */
function probe(id: string, region: CartProbeStep['region'], prepAtUs: number, readAtUs: number): CartProbe {
  const prep = probeStep(id, 'prep', 'add', region, prepAtUs, null, {
    sku: 'normal/probe',
    count: 2,
    observedContext: 'empty',
  });
  const read = probeStep(
    id,
    'read',
    'read',
    region,
    readAtUs,
    readAtUs + 1_000_000,
    { expectedQuantity: 2, certificateOrigins: 3 },
    [prep.id],
  );
  return {
    id,
    caseId: 'normal',
    family: 'normal-read',
    region,
    cohort: 'healthy',
    atUs: readAtUs,
    deadlineUs: readAtUs + 3_000_000,
    prerequisiteIds: [prep.id],
    steps: [prep, read],
    expected: { kind: 'complete-read', quantity: 2 },
    denominator: 1,
  };
}

function run(options: GraphOptions, steps: readonly CartProbe[]): CartCaseModel {
  const graph = cartGraph(options);
  const model = new CartCaseModel('normal', analyzeCartTopology(graph), [], steps, graph);
  model.run();
  return model;
}

describe('probe preparation commits only after actual settlement', () => {
  it('does not commit or acknowledge a preparation write the incident cut', () => {
    // Offer 1 ms before the 30 s Tokyo partition: ingress and application CPU
    // still run, but the commit RPC to the east journal is not admissible.
    const probes = [probe('probe:pe5:cut', 'ap-northeast', 29_999_000, 32_000_000)];
    const model = run({ apWriteAuthorityInEu: true }, probes);
    const prep = model.requestRecords.find((record) => record.id === 'probe:pe5:cut:prep');
    expect(prep).toBeDefined();
    // The durable write never reached the configured authority, so the record
    // may not claim a commit and the client observed no ACK.
    expect(prep?.committed).toBe(false);
    expect(prep?.acknowledged).toBe(false);
    expect(prep?.deliveryUs).toBeNull();
    expect(['rejected', 'unavailable', 'timeout']).toContain(prep?.outcome);
    // The cart stayed empty and no ACK was ever serialized.
    const cartId = prep?.cartId ?? '';
    expect(model.cartLiveQuantity(cartId)).toBe(0);
    expect(model.transferSnapshots.some((transfer) => transfer.logicalId === 'probe:pe5:cut:prep:ack'))
      .toBe(false);
  });

  it('keeps the dependent read at its frozen offer time with an honest failure', () => {
    const readAtUs = 32_000_000;
    const probes = [probe('probe:pe5:cut-dependent', 'ap-northeast', 29_999_000, readAtUs)];
    const model = run({ apWriteAuthorityInEu: true }, probes);
    const read = model.requestRecords.find((record) => record.id === 'probe:pe5:cut-dependent:read');
    expect(read).toBeDefined();
    expect(read?.offeredUs).toBe(readAtUs);
    expect(read?.dependencyFailed).toBe(true);
    expect(read?.outcome).toBe('dependency-failed');
    expect(read?.acknowledged).toBe(false);
  });
});

describe('probe preparation uses the ordinary edit timeline', () => {
  it('matches an equivalent ordinary add in commit, reply and delivery accounting', () => {
    const atUs = 1_000_000;
    const graph = cartGraph();
    const facts = analyzeCartTopology(graph);
    const workload = buildCartCaseWorkload('normal', 1729);
    const template = workload.intents.find(
      (intent) => intent.region === 'us-west' && intent.effect.kind === 'add' && intent.dependsOn.length === 0,
    ) as CartOperationIntent;
    const ordinary: CartOperationIntent = {
      ...template,
      id: 'ordinary-add',
      atUs,
      cartId: 'ordinary-cart',
      key: { ...template.key, clientId: 'ordinary-client', requestSequence: 0 },
      observedContext: [],
      dependsOn: [],
    };
    const intentModel = new CartCaseModel('normal', facts, [ordinary], [], graph);
    intentModel.run();
    const probeModel = new CartCaseModel(
      'normal',
      facts,
      [],
      [probe('probe:pe5:parity', 'us-west', atUs, atUs + 1_000_000)],
      graph,
    );
    probeModel.run();

    const intentRecord = intentModel.requestRecords.find((record) => record.id === 'ordinary-add');
    const prepRecord = probeModel.requestRecords.find((record) => record.id === 'probe:pe5:parity:prep');
    expect(intentRecord?.committed).toBe(true);
    expect(intentRecord?.acknowledged).toBe(true);
    expect(prepRecord?.committed).toBe(true);
    expect(prepRecord?.acknowledged).toBe(true);

    const intentCommit = intentModel.transferSnapshots.find(
      (transfer) => transfer.logicalId === 'ordinary-add:commit',
    );
    const intentAck = intentModel.transferSnapshots.find(
      (transfer) => transfer.logicalId === 'ordinary-add:ack',
    );
    const prepCommit = probeModel.transferSnapshots.find(
      (transfer) => transfer.logicalId === 'probe:pe5:parity:prep:commit',
    );
    const prepAck = probeModel.transferSnapshots.find(
      (transfer) => transfer.logicalId === 'probe:pe5:parity:prep:ack',
    );
    expect(intentCommit?.status).toBe('delivered');
    expect(prepCommit?.status).toBe('delivered');
    expect(intentAck?.status).toBe('delivered');
    expect(prepAck?.status).toBe('delivered');
    // Same protocol stages from the same offer time produce the same absolute
    // commit arrival and the same real reply enqueue point.
    expect(prepCommit?.deliveredAtUs).toBe(intentCommit?.deliveredAtUs);
    expect(prepAck?.enqueuedAtUs).toBe(intentAck?.enqueuedAtUs);
    // The acknowledged delivery is the real ACK arrival, never a receipt
    // invented 500 us after the planned commit.
    expect(prepRecord?.deliveredUs).toBe(prepAck?.deliveredAtUs);
    expect(prepRecord?.deliveredUs).not.toBe((prepCommit?.deliveredAtUs ?? 0) + 500);
  });
});


it('replicates completion-driven preparation only after its actual durable commit', () => {
  const graph = cartGraph();
  graph.edges.push({id: 'prepared-copy', from: 'journal-us-west', to: 'journal-eu-central', kind: 'replication'});
  const facts = analyzeCartTopology(graph);
  const stores = graph.nodes.filter(n => n.kind === 'journal').map(n => {
    if (n.kind !== 'journal') throw new Error('journal required');
    return new CartDurableStore({nodeId: n.id, kind: n.kind, size: n.size,
      writeAuthorities: Object.fromEntries(Object.entries(facts.authorityByRegion).filter(([,id]) => id !== null)),
      replicationEdges: graph.edges.filter(e => e.kind === 'replication' && e.from === n.id)
        .map(e => ({edgeId: e.id, to: e.to}))});
  });
  const model = new CartCaseModel('normal', facts, [],
    [probe('probe:pg1:replicated', 'us-west', 1_000_000, 2_000_000)], graph, {durableStores: stores});
  model.run();
  const prep = model.requestRecords.find(r => r.id === 'probe:pg1:replicated:prep')!;
  expect(prep.committed).toBe(true);
  expect(prep.acknowledged).toBe(true);
  const target = stores.find(s => s.nodeId === 'journal-eu-central')!;
  const ids = target.retainedOperationIds(prep.cartId);
  expect(ids).toHaveLength(1);
  const batch = model.transferSnapshots.find(t => t.logicalId.startsWith('replication:prepared-copy:') && !t.logicalId.endsWith(':ack'))!;
  const origin = stores.find(s => s.nodeId === 'journal-us-west')!;
  expect(batch.enqueuedAtUs).toBeGreaterThanOrEqual(origin.commitTimeFor(prep.cartId, ids[0]!)!);
  expect(target.commitTimeFor(prep.cartId, ids[0]!)).toBeGreaterThan(batch.deliveredAtUs!);
  expect(stores.every(s => s.pendingDeliveryCount === 0)).toBe(true);
  expect(model.pendingServiceTasks).toBe(0);
});


it('keeps long frozen partition cart identifiers valid and distinct through actual preparation', () => {
  const graph = cartGraph();
  const probes = buildCartProbes().probes.filter(p => p.family === 'partition-boundary');
  expect(probes).toHaveLength(18);
  const model = new CartCaseModel('partition', analyzeCartTopology(graph), [], probes, graph);
  model.run();
  const records = model.requestRecords.filter(r => r.operation === 'probe');
  expect(records).toHaveLength(18);
  expect(new Set(records.map(r => r.cartId)).size).toBe(18);
  expect(records.every(r => r.cartId.length <= 64 && r.committed && r.acknowledged)).toBe(true);
  expect(records.every(r => r.deadlineUs === r.offeredUs + 1_000)).toBe(true);
  // Real flush exceeds the frozen probe target; never disguise this as a gate
  // PASS. The mandatory oracle remains responsible for qualification.
  expect(records.every(r => r.deliveredUs! > r.deadlineUs)).toBe(true);
});
