/**
 * GC-PE1 focused regressions: the case model must honor each Application's
 * configured `writeTarget`, `readTargets` and read policy instead of picking
 * the first durable node by graph order, enumerating every node as a read
 * target, or treating coarse region reachability as request authorization.
 *
 * Every expectation below is asserted through an actual `CartCaseModel` run:
 * the shared network records the physical transfers the model really offered,
 * so a transfer to a wrong node is visible in `transferSnapshots`. No frozen
 * constant is changed and no protocol shortcut is introduced.
 */
import { describe, expect, it } from 'vitest';

import { CART_LEVEL_ID, CART_VERSIONS, type CartGraph } from '../index';
import { CartCaseModel, analyzeCartTopology } from '../core/model';
import type { CartOperationIntent } from '../core/workload';

interface GraphOptions {
  /** Reverse the node array; every legal node set must behave identically. */
  readonly reverseNodes?: boolean;
  /** Add a reachable cache that no Application configures as a read target. */
  readonly unconfiguredCache?: boolean;
  /** Route the west Application's write target through a replication-only edge. */
  readonly replicationOnlyWrite?: boolean;
  /** Configure only the east journal as the west Application's read target. */
  readonly replicationOnlyReadTarget?: boolean;
  /** Replace the west write target with a name that no node defines. */
  readonly missingWriteTarget?: boolean;
}

const READ_ALL_REGIONS = ['journal-us-west', 'journal-eu-central', 'journal-ap-northeast'];

function cartGraph(options: GraphOptions = {}): CartGraph {
  const customers = (region: string, x: number): Record<string, unknown> => ({
    id: `customers-${region}`,
    kind: 'customers',
    region,
    position: { x, y: 40 },
  });
  const sized = (
    id: string,
    kind: 'journal' | 'store' | 'cache',
    region: string,
    x: number,
    size: 'S' | 'M',
  ): Record<string, unknown> => ({
    id,
    kind,
    region,
    position: { x, y: 340 },
    size,
  });

  const nodes: Record<string, unknown>[] = [
    customers('us-west', 40),
    customers('eu-central', 440),
    customers('ap-northeast', 840),
    // The west and east regions hold BOTH a journal and a cart store, so the
    // configured write target can actually be a different durable node than
    // the first one in graph order.
    sized('journal-us-west', 'journal', 'us-west', 80, 'S'),
    sized('store-us-west', 'store', 'us-west', 140, 'S'),
    sized('journal-eu-central', 'journal', 'eu-central', 480, 'M'),
    sized('store-eu-central', 'store', 'eu-central', 540, 'M'),
    sized('journal-ap-northeast', 'journal', 'ap-northeast', 880, 'S'),
    {
      id: 'app-us-west',
      kind: 'application',
      region: 'us-west',
      position: { x: 80, y: 200 },
      size: 'S',
      instances: 1,
      writeTarget: options.missingWriteTarget
        ? 'journal-ghost'
        : options.replicationOnlyWrite
          ? 'journal-eu-central'
          : 'store-us-west',
      readPolicy: 'local-repair',
      readTargets: options.replicationOnlyReadTarget
        ? ['journal-eu-central']
        : READ_ALL_REGIONS,
    },
    {
      id: 'app-eu-central',
      kind: 'application',
      region: 'eu-central',
      position: { x: 480, y: 200 },
      size: 'S',
      instances: 2,
      writeTarget: 'store-eu-central',
      readPolicy: 'parallel',
      readTargets: ['journal-eu-central'],
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
      readTargets: ['journal-ap-northeast'],
    },
    { id: 'inventory-us-west', kind: 'inventory', region: 'us-west', position: { x: 240, y: 480 }, size: 'M' },
  ];
  if (options.unconfiguredCache === true) {
    nodes.push(sized('cache-us-west', 'cache', 'us-west', 200, 'S'));
  }

  const edges: Record<string, unknown>[] = [
    { id: 'src-us', from: 'customers-us-west', to: 'app-us-west', kind: 'request' },
    { id: 'src-eu', from: 'customers-eu-central', to: 'app-eu-central', kind: 'request' },
    { id: 'src-ap', from: 'customers-ap-northeast', to: 'app-ap-northeast', kind: 'request' },
    { id: 'ack-us', from: 'app-us-west', to: 'journal-us-west', kind: 'request' },
    { id: 'ack-eu', from: 'app-eu-central', to: 'journal-eu-central', kind: 'request' },
    { id: 'ack-ap', from: 'app-ap-northeast', to: 'journal-ap-northeast', kind: 'request' },
    { id: 'inv-us', from: 'app-us-west', to: 'inventory-us-west', kind: 'request' },
    { id: 'inv-eu', from: 'app-eu-central', to: 'inventory-us-west', kind: 'request' },
    { id: 'inv-ap', from: 'app-ap-northeast', to: 'inventory-us-west', kind: 'request' },
  ];
  if (options.replicationOnlyWrite === true) {
    // No drawn request path from the west Application to the east journal.
    edges.push({ id: 'rep-us-eu', from: 'journal-us-west', to: 'journal-eu-central', kind: 'replication' });
  } else {
    edges.push({ id: 'wstore-us', from: 'app-us-west', to: 'store-us-west', kind: 'request' });
    edges.push({ id: 'wstore-eu', from: 'app-eu-central', to: 'store-eu-central', kind: 'request' });
  }
  if (options.replicationOnlyReadTarget !== true && options.replicationOnlyWrite !== true) {
    edges.push({ id: 'read-eu', from: 'app-us-west', to: 'journal-eu-central', kind: 'request' });
    edges.push({ id: 'read-ap', from: 'app-us-west', to: 'journal-ap-northeast', kind: 'request' });
    // Complete-origin coverage needs the configured eu authority; the west
    // Application must draw a request path to it (storage paths are honored,
    // never invented).
    edges.push({ id: 'read-eu-store', from: 'app-us-west', to: 'store-eu-central', kind: 'request' });
  }
  if (options.unconfiguredCache === true) {
    edges.push({ id: 'read-cache', from: 'app-us-west', to: 'cache-us-west', kind: 'request' });
  }

  const circuits = [
    { regions: ['us-west', 'eu-central'], mbps: 8 },
    { regions: ['us-west', 'ap-northeast'], mbps: 32 },
    { regions: ['eu-central', 'ap-northeast'], mbps: 8 },
  ];

  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes: options.reverseNodes === true ? [...nodes].reverse() : nodes,
    edges,
    circuits,
  } as unknown as CartGraph;
}

function editIntent(
  id: string,
  region: 'us-west' | 'eu-central' | 'ap-northeast',
  sequence: number,
  cartId: string,
  atUs = 1_000_000,
): CartOperationIntent {
  return {
    id,
    caseId: 'normal',
    atUs,
    cartId,
    region,
    remoteReadRegion: null,
    key: { originRegion: region, clientId: 'client-a', requestSequence: sequence },
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
  id: string,
  tokenIds: readonly string[],
  servedBy: 'us-west' | 'eu-central' | 'ap-northeast',
  cartId: string,
  atUs = 4_000_000,
): CartOperationIntent {
  return {
    id,
    caseId: 'normal',
    atUs,
    cartId,
    region: servedBy,
    remoteReadRegion: servedBy,
    key: { originRegion: servedBy, clientId: 'client-a', requestSequence: 9 },
    slotIndex: 1,
    stream: 'base',
    operation: 'read',
    editKind: null,
    effect: { kind: 'read', token: [...tokenIds], servedBy },
    observedContext: [],
    dependsOn: [...tokenIds],
  };
}

/** Destination node of the real commit RPC the network actually carried. */
function commitDestinations(model: CartCaseModel): Map<string, string> {
  const destinations = new Map<string, string>();
  for (const transfer of model.transferSnapshots) {
    if (transfer.purpose !== 'request' || !transfer.logicalId.endsWith(':commit')) continue;
    const to = transfer.to;
    if (to.kind === 'node') destinations.set(transfer.logicalId, to.nodeId);
  }
  return destinations;
}

/** Node ids that received a real read request RPC from the west Application. */
function readRequestTargets(model: CartCaseModel, requestId: string): string[] {
  const targets: string[] = [];
  for (const transfer of model.transferSnapshots) {
    if (transfer.purpose !== 'request') continue;
    if (!transfer.logicalId.startsWith(`${requestId}:r:`)) continue;
    const to = transfer.to;
    if (to.kind === 'node') targets.push(to.nodeId);
  }
  return targets;
}

describe('configured cart storage paths', () => {
  it('writes each origin to its configured durable authority', () => {
    const graph = cartGraph();
    const facts = analyzeCartTopology(graph);
    expect(facts.qualified).toBe(true);
    expect(facts.authorityByRegion['us-west']).toBe('store-us-west');
    expect(facts.authorityByRegion['eu-central']).toBe('store-eu-central');
    expect(facts.authorityByRegion['ap-northeast']).toBe('journal-ap-northeast');

    const model = new CartCaseModel(
      'normal',
      facts,
      [
        editIntent('e1', 'us-west', 1, 'cart-west'),
        editIntent('e2', 'eu-central', 2, 'cart-east'),
      ],
      [],
      graph,
      { measuredUs: 6_000_000 },
    );
    model.run();

    expect(model.requestRecords.find((record) => record.id === 'e1')?.outcome).toBe('committed');
    expect(model.requestRecords.find((record) => record.id === 'e2')?.outcome).toBe('committed');

    const destinations = commitDestinations(model);
    expect(destinations.get('e1:commit')).toBe('store-us-west');
    expect(destinations.get('e2:commit')).toBe('store-eu-central');
  });

  it('is invariant under graph node reordering', () => {
    const forward = cartGraph();
    const reversed = cartGraph({ reverseNodes: true });
    const forwardFacts = analyzeCartTopology(forward);
    const reversedFacts = analyzeCartTopology(reversed);
    expect(reversedFacts.authorityByRegion).toEqual(forwardFacts.authorityByRegion);

    const run = (graph: CartGraph, facts: ReturnType<typeof analyzeCartTopology>) => {
      const model = new CartCaseModel(
        'normal',
        facts,
        [editIntent('e1', 'us-west', 1, 'cart-west')],
        [],
        graph,
        { measuredUs: 4_000_000 },
      );
      model.run();
      return model;
    };
    const forwardRun = run(forward, forwardFacts);
    const reversedRun = run(reversed, reversedFacts);
    expect(commitDestinations(reversedRun).get('e1:commit')).toBe(
      commitDestinations(forwardRun).get('e1:commit'),
    );
    expect(commitDestinations(forwardRun).get('e1:commit')).toBe('store-us-west');
  });

  it('never queries a reachable node that the Application did not configure', () => {
    const graph = cartGraph({ unconfiguredCache: true });
    const app = graph.nodes.find(node => node.id === 'app-us-west')!;
    if (app.kind !== 'application') throw new Error('expected Application');
    app.readTargets = ['store-us-west', 'store-eu-central', 'journal-ap-northeast'];
    const facts = analyzeCartTopology(graph);
    const model = new CartCaseModel(
      'normal',
      facts,
      [editIntent('e1', 'us-west', 1, 'cart-west'), readIntent('r1', ['e1'], 'us-west', 'cart-west')],
      [],
      graph,
      { measuredUs: 8_000_000 },
    );
    model.run();

    const targets = readRequestTargets(model, 'r1');
    expect(targets.length).toBeGreaterThan(0);
    // Complete-origin authorities must themselves be named as read targets;
    // an origin's writeTarget does not authorize an undisclosed read RPC.
    const configuredTargets = new Set(app.readTargets);
    expect(targets.every((target) => configuredTargets.has(target))).toBe(true);
    // A reachable cache that no Application configures is never queried.
    expect(targets).not.toContain('cache-us-west');
    // Complete-origin coverage is retained through the configured authorities.
    expect(readRequestTargets(model, 'r1')).toEqual(
      expect.arrayContaining(['store-us-west', 'store-eu-central', 'journal-ap-northeast']),
    );
    const read = model.requestRecords.find((record) => record.id === 'r1');
    expect(read).toBeDefined();
    expect(read?.outcome).toBe('committed');
    expect(read?.evidenceIds.every((id) => id !== 'cache-us-west')).toBe(true);
  });

  it('does not invent reachable authority targets to complete missing evidence', () => {
    const graph = cartGraph();
    const model = new CartCaseModel('normal', analyzeCartTopology(graph),
      [editIntent('e1', 'us-west', 1, 'cart-west'), readIntent('r1', ['e1'], 'us-west', 'cart-west')],
      [], graph, { measuredUs: 8_000_000 });
    model.run();
    const targets = readRequestTargets(model, 'r1');
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every(target => READ_ALL_REGIONS.includes(target))).toBe(true);
    expect(targets).not.toContain('store-us-west');
    expect(targets).not.toContain('store-eu-central');
    expect(model.readResults.get('r1')?.kind).not.toBe('complete');
    // The unavailable answer is now delivered to the client (GC-PF1), but a
    // healthy-cohort request earns no exemption: it stays a failed outcome.
    const record = model.requestRecords.find(candidate => candidate.id === 'r1');
    expect(record?.outcome).toBe('validation-failed');
    expect(record?.exempt).toBe(false);
  });

  it('does not let a replication-only edge carry a request RPC', () => {
    // Read side: the only drawn path to the east journal is replication.
    const readGraph = cartGraph({ replicationOnlyReadTarget: true });
    const readFacts = analyzeCartTopology(readGraph);
    const readModel = new CartCaseModel(
      'normal',
      readFacts,
      [editIntent('e1', 'us-west', 1, 'cart-west'), readIntent('r1', ['e1'], 'us-west', 'cart-west')],
      [],
      readGraph,
      { measuredUs: 8_000_000 },
    );
    readModel.run();
    const replicationOnlyTargets = readRequestTargets(readModel, 'r1');
    // The east journal is configured but only reachable through a replication
    // edge, so it may not receive the request: the local authority may.
    expect(replicationOnlyTargets).not.toContain('journal-eu-central');
    expect(replicationOnlyTargets.every((target) => target === 'store-us-west')).toBe(true);
    const read = readModel.requestRecords.find((record) => record.id === 'r1');
    expect(read?.outcome).not.toBe('committed');

    // Write side: a replication-only write target is not a configured authority.
    const writeGraph = cartGraph({ replicationOnlyWrite: true });
    const writeFacts = analyzeCartTopology(writeGraph);
    expect(writeFacts.authorityByRegion['us-west']).toBeNull();
    expect(writeFacts.qualified).toBe(false);
    expect(writeFacts.issues).toContain('missing-write-authority:us-west');
    const writeModel = new CartCaseModel(
      'normal',
      writeFacts,
      [editIntent('e1', 'us-west', 1, 'cart-west')],
      [],
      writeGraph,
      { measuredUs: 4_000_000 },
    );
    writeModel.run();
    const writeRecord = writeModel.requestRecords.find((record) => record.id === 'e1');
    expect(writeRecord?.rejected).toBe(true);
    expect(writeRecord?.committed).toBe(false);
    expect(writeRecord?.evidenceIds).toContain('topology-unqualified');
    expect(commitDestinations(writeModel).has('e1:commit')).toBe(false);
  });

  it('fails explicitly for a missing write target instead of choosing another node', () => {
    const graph = cartGraph({ missingWriteTarget: true });
    const facts = analyzeCartTopology(graph);
    expect(facts.authorityByRegion['us-west']).toBeNull();
    expect(facts.issues).toContain('missing-write-authority:us-west');
    expect(facts.qualified).toBe(false);

    const model = new CartCaseModel(
      'normal',
      facts,
      [
        editIntent('e1', 'us-west', 1, 'cart-west'),
        { ...readIntent('r1', ['e1'], 'us-west', 'cart-west'), dependsOn: [] },
      ],
      [],
      graph,
      { measuredUs: 4_000_000 },
    );
    model.run();
    const edit = model.requestRecords.find((record) => record.id === 'e1');
    expect(edit?.rejected).toBe(true);
    expect(edit?.evidenceIds).toContain('topology-unqualified');
    expect(commitDestinations(model).has('e1:commit')).toBe(false);
    const read = model.requestRecords.find((record) => record.id === 'r1');
    expect(read?.rejected).toBe(true);
    expect(read?.evidenceIds).toContain('no-write-authority');
  });
});
