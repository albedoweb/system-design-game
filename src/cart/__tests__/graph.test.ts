import { describe, expect, it } from 'vitest';
import {
  CART_LEVEL_ID,
  CART_VERSIONS,
  cartGraphDigest,
  createCartStarterGraph,
  isCartQualificationIssue,
  isCartStructuralIssue,
  parseCartGraph,
  validateCartGraph,
  type CartGraph,
} from '../index';

interface MutableNode {
  id: string;
  kind: string;
  region: string;
  position: { x: number; y: number };
  label?: string;
  size?: string;
  instances?: number;
  writeTarget?: string;
  readPolicy?: string;
  readTargets?: string[];
}

interface MutableEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
}

interface MutableCircuit {
  regions: [string, string];
  mbps: number;
}

interface MutableGraph {
  levelId: string;
  graphVersion: string;
  contentVersion: string;
  seed: number;
  nodes: MutableNode[];
  edges: MutableEdge[];
  circuits: MutableCircuit[];
}

/**
 * A small qualifying graph: three fixed sources, one Application per region,
 * a local durable write authority per region, and exactly one Inventory in
 * US West reached by explicit cross-region request paths on purchased circuits.
 */
function qualifyingGraph(): CartGraph {
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes: [
      { id: 'customers-us-west', kind: 'customers', region: 'us-west', position: { x: 40, y: 40 } },
      { id: 'customers-eu-central', kind: 'customers', region: 'eu-central', position: { x: 440, y: 40 } },
      { id: 'customers-ap-northeast', kind: 'customers', region: 'ap-northeast', position: { x: 840, y: 40 } },
      {
        id: 'app-us-west',
        kind: 'application',
        region: 'us-west',
        position: { x: 80, y: 200 },
        label: 'US checkout front door',
        size: 'S',
        instances: 1,
        writeTarget: 'journal-us-west',
        readPolicy: 'local-repair',
        readTargets: ['journal-us-west'],
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
      { id: 'journal-us-west', kind: 'journal', region: 'us-west', position: { x: 80, y: 340 }, size: 'S' },
      { id: 'journal-eu-central', kind: 'journal', region: 'eu-central', position: { x: 480, y: 340 }, size: 'M' },
      { id: 'journal-ap-northeast', kind: 'journal', region: 'ap-northeast', position: { x: 880, y: 340 }, size: 'S' },
      { id: 'inventory-us-west', kind: 'inventory', region: 'us-west', position: { x: 240, y: 480 }, size: 'M' },
    ],
    edges: [
      { id: 'e-source-us', from: 'customers-us-west', to: 'app-us-west', kind: 'request' },
      { id: 'e-source-eu', from: 'customers-eu-central', to: 'app-eu-central', kind: 'request' },
      { id: 'e-source-ap', from: 'customers-ap-northeast', to: 'app-ap-northeast', kind: 'request' },
      { id: 'e-ack-us', from: 'app-us-west', to: 'journal-us-west', kind: 'request' },
      { id: 'e-ack-eu', from: 'app-eu-central', to: 'journal-eu-central', kind: 'request' },
      { id: 'e-ack-ap', from: 'app-ap-northeast', to: 'journal-ap-northeast', kind: 'request' },
      { id: 'e-inv-us', from: 'app-us-west', to: 'inventory-us-west', kind: 'request' },
      { id: 'e-inv-eu', from: 'app-eu-central', to: 'inventory-us-west', kind: 'request' },
      { id: 'e-inv-ap', from: 'app-ap-northeast', to: 'inventory-us-west', kind: 'request' },
    ],
    circuits: [
      { regions: ['us-west', 'eu-central'], mbps: 8 },
      { regions: ['us-west', 'ap-northeast'], mbps: 32 },
    ],
  };
}

function mutable(graph: CartGraph = qualifyingGraph()): MutableGraph {
  return JSON.parse(JSON.stringify(graph)) as MutableGraph;
}

function asGraph(graph: MutableGraph): CartGraph {
  const result = parseCartGraph(graph);
  if (!result.ok) {
    throw new Error(`fixture must parse: ${result.issues.map((issue) => issue.code).join(', ')}`);
  }
  return result.graph;
}

function codes(graph: MutableGraph): string[] {
  return validateCartGraph(asGraph(graph)).map((issue) => issue.code);
}

function node(graph: MutableGraph, id: string): MutableNode {
  const found = graph.nodes.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing fixture node ${id}`);
  return found;
}

function edge(graph: MutableGraph, id: string): MutableEdge {
  const found = graph.edges.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing fixture edge ${id}`);
  return found;
}

describe('starter graph and qualification', () => {
  it('reports the source-only starter as missing requirements, not invalid input', () => {
    const starter = createCartStarterGraph();
    const parsed = parseCartGraph(starter);
    expect(parsed.ok).toBe(true);

    const issues = validateCartGraph(starter);
    expect(issues.map((issue) => issue.code).sort()).toEqual([
      'missing_application_region',
      'missing_application_region',
      'missing_application_region',
      'missing_inventory',
    ]);
    expect(issues.every((issue) => isCartQualificationIssue(issue))).toBe(true);
    expect(issues.some((issue) => isCartStructuralIssue(issue))).toBe(false);
  });

  it('accepts a qualifying graph with no issues', () => {
    expect(validateCartGraph(qualifyingGraph())).toEqual([]);
  });
});

describe('semantic digest', () => {
  it('is a stable 64-hex SHA-256 over normalized semantics', () => {
    const digest = cartGraphDigest(qualifyingGraph());
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(cartGraphDigest(qualifyingGraph())).toBe(digest);
    expect(cartGraphDigest(JSON.parse(JSON.stringify(qualifyingGraph())) as CartGraph)).toBe(
      digest,
    );
  });

  it('ignores layout, labels, ids, enumeration order, target order and seed', () => {
    const baseline = cartGraphDigest(qualifyingGraph());
    const renamed = mutable();

    // Deliberately hostile renaming: every id changes, every label/position
    // changes, arrays are reversed and the evaluation seed moves.
    const rename = new Map<string, string>();
    renamed.nodes.forEach((entry, index) => {
      rename.set(entry.id, `x${index}-${entry.kind}`);
    });
    for (const entry of renamed.nodes) {
      entry.id = rename.get(entry.id) as string;
      entry.position = { x: 10_000 - entry.position.x, y: -entry.position.y };
      entry.label = `relabelled ${entry.id}`;
      if (entry.kind === 'application') {
        entry.writeTarget = rename.get(entry.writeTarget as string) as string;
        entry.readTargets = (entry.readTargets ?? [])
          .map((target) => rename.get(target) as string)
          .reverse();
      }
    }
    for (const entry of renamed.edges) {
      entry.from = rename.get(entry.from) as string;
      entry.to = rename.get(entry.to) as string;
    }
    renamed.nodes.reverse();
    renamed.edges.reverse();
    renamed.circuits.reverse();
    renamed.seed = 20261108;

    expect(cartGraphDigest(asGraph(renamed))).toBe(baseline);
  });

  it('changes when meaning-bearing configuration changes', () => {
    const baseline = cartGraphDigest(qualifyingGraph());
    const variants: MutableGraph[] = [];

    const biggerStore = mutable();
    node(biggerStore, 'journal-us-west').size = 'M';
    variants.push(biggerStore);

    const moreInstances = mutable();
    node(moreInstances, 'app-us-west').instances = 2;
    variants.push(moreInstances);

    const otherPolicy = mutable();
    node(otherPolicy, 'app-us-west').readPolicy = 'parallel';
    variants.push(otherPolicy);

    const otherReadTargets = mutable();
    node(otherReadTargets, 'app-us-west').readTargets = ['app-us-west', 'journal-us-west'];
    variants.push(otherReadTargets);

    const removedEdge = mutable();
    removedEdge.edges = removedEdge.edges.filter((entry) => entry.id !== 'e-inv-ap');
    variants.push(removedEdge);

    const fasterCircuit = mutable();
    fasterCircuit.circuits[0] = { regions: ['us-west', 'eu-central'], mbps: 32 };
    variants.push(fasterCircuit);

    const replicationInstead = mutable();
    edge(replicationInstead, 'e-ack-us').kind = 'replication';
    variants.push(replicationInstead);

    const digests = variants.map((variant) => cartGraphDigest(asGraph(variant)));
    expect(new Set([baseline, ...digests]).size).toBe(digests.length + 1);
  });

  it('treats a label-only change as non-semantic', () => {
    const labelled = mutable();
    node(labelled, 'journal-us-west').label = 'The only durable journal';
    expect(cartGraphDigest(asGraph(labelled))).toBe(cartGraphDigest(qualifyingGraph()));
  });
});

describe('structural validation', () => {
  it('rejects duplicate ids and duplicate semantic edges', () => {
    const duplicateNode = mutable();
    duplicateNode.nodes.push({ ...node(duplicateNode, 'journal-us-west') });
    expect(codes(duplicateNode)).toContain('duplicate_node_id');

    const duplicateEdgeId = mutable();
    edge(duplicateEdgeId, 'e-ack-eu').id = 'e-ack-us';
    expect(codes(duplicateEdgeId)).toContain('duplicate_edge_id');

    const duplicateSemantic = mutable();
    duplicateSemantic.edges.push({
      id: 'e-ack-us-copy',
      from: 'app-us-west',
      to: 'journal-us-west',
      kind: 'request',
    });
    expect(codes(duplicateSemantic)).toContain('duplicate_semantic_edge');
  });

  it('rejects dangling references and self edges', () => {
    const unknown = mutable();
    edge(unknown, 'e-ack-us').to = 'ghost';
    expect(codes(unknown)).toContain('unknown_node_ref');

    const self = mutable();
    const selfEdge = edge(self, 'e-ack-us');
    selfEdge.from = 'app-us-west';
    selfEdge.to = 'app-us-west';
    expect(codes(self)).toContain('self_edge');
  });

  it('enforces explicit client paths and endpoint roles', () => {
    const crossRegionClient = mutable();
    crossRegionClient.edges.push({
      id: 'e-client-cross',
      from: 'customers-us-west',
      to: 'app-eu-central',
      kind: 'request',
    });
    expect(codes(crossRegionClient)).toContain('customers_target_rule');

    const clientToService = mutable();
    clientToService.edges.push({
      id: 'e-client-journal',
      from: 'customers-us-west',
      to: 'journal-us-west',
      kind: 'request',
    });
    expect(codes(clientToService)).toContain('customers_target_rule');

    const intoCustomers = mutable();
    intoCustomers.edges.push({
      id: 'e-into-customers',
      from: 'app-us-west',
      to: 'customers-us-west',
      kind: 'request',
    });
    expect(codes(intoCustomers)).toContain('request_into_customers');

    const inventorySource = mutable();
    inventorySource.edges.push({
      id: 'e-inventory-source',
      from: 'inventory-us-west',
      to: 'app-us-west',
      kind: 'request',
    });
    expect(codes(inventorySource)).toContain('request_edge_endpoints');
  });

  it('restricts replication to durable destinations', () => {
    const withCache = mutable();
    withCache.nodes.push({
      id: 'cache-us-west',
      kind: 'cache',
      region: 'us-west',
      position: { x: 120, y: 420 },
      size: 'S',
    });
    withCache.edges.push({
      id: 'e-replicate-cache',
      from: 'app-us-west',
      to: 'cache-us-west',
      kind: 'replication',
    });
    const cacheCodes = codes(withCache);
    expect(cacheCodes).toContain('replication_target_not_durable');

    const cacheSource = mutable();
    cacheSource.nodes.push({
      id: 'cache-us-west',
      kind: 'cache',
      region: 'us-west',
      position: { x: 120, y: 420 },
      size: 'S',
    });
    cacheSource.edges.push({
      id: 'e-cache-replicates',
      from: 'cache-us-west',
      to: 'journal-us-west',
      kind: 'replication',
    });
    expect(codes(cacheSource)).toContain('replication_edge_endpoints');

    const inventoryReplication = mutable();
    inventoryReplication.edges.push({
      id: 'e-replicate-inventory',
      from: 'app-us-west',
      to: 'inventory-us-west',
      kind: 'replication',
    });
    expect(codes(inventoryReplication)).toContain('replication_target_not_durable');
  });

  it('requires a purchased circuit for every cross-region edge', () => {
    const withoutCircuit = mutable();
    withoutCircuit.circuits = withoutCircuit.circuits.filter(
      (entry) => !(entry.regions[0] === 'us-west' && entry.regions[1] === 'eu-central'),
    );
    expect(codes(withoutCircuit)).toContain('missing_circuit');
  });

  it('validates circuit pairs and canonical order', () => {
    const sameRegion = mutable();
    sameRegion.circuits[0] = { regions: ['us-west', 'us-west'], mbps: 8 };
    expect(codes(sameRegion)).toContain('circuit_same_region');

    const unsorted = mutable();
    unsorted.circuits[0] = { regions: ['eu-central', 'us-west'], mbps: 8 };
    expect(codes(unsorted)).toContain('circuit_regions_unsorted');

    const duplicate = mutable();
    duplicate.circuits.push({ regions: ['eu-central', 'us-west'], mbps: 32 });
    expect(codes(duplicate)).toContain('duplicate_circuit');
  });

  it('rejects request cycles but permits replication cycles', () => {
    const requestCycle = mutable();
    requestCycle.edges.push({
      id: 'e-journal-back',
      from: 'journal-us-west',
      to: 'app-us-west',
      kind: 'request',
    });
    expect(codes(requestCycle)).toContain('request_cycle');

    const replicationCycle = mutable();
    replicationCycle.edges.push({
      id: 'e-replicate-eu-us',
      from: 'journal-eu-central',
      to: 'journal-us-west',
      kind: 'replication',
    });
    replicationCycle.edges.push({
      id: 'e-replicate-us-eu',
      from: 'journal-us-west',
      to: 'journal-eu-central',
      kind: 'replication',
    });
    expect(codes(replicationCycle)).toEqual([]);
  });
});

describe('explicit authority and fallback paths', () => {
  it('requires a durable, reachable write target', () => {
    const missing = mutable();
    node(missing, 'app-us-west').writeTarget = 'ghost';
    expect(codes(missing)).toContain('write_target_missing');

    const cacheAuthority = mutable();
    cacheAuthority.nodes.push({
      id: 'cache-us-west',
      kind: 'cache',
      region: 'us-west',
      position: { x: 120, y: 420 },
      size: 'S',
    });
    node(cacheAuthority, 'app-us-west').writeTarget = 'cache-us-west';
    cacheAuthority.edges.push({
      id: 'e-app-cache',
      from: 'app-us-west',
      to: 'cache-us-west',
      kind: 'request',
    });
    expect(codes(cacheAuthority)).toContain('write_target_not_durable');

    const unreachable = mutable();
    unreachable.edges = unreachable.edges.filter((entry) => entry.id !== 'e-ack-us');
    const unreachableCodes = codes(unreachable);
    expect(unreachableCodes).toContain('write_target_unreachable');
    expect(unreachableCodes).toContain('read_target_unreachable');
  });

  it('requires explicit reachable repair targets', () => {
    const missingTarget = mutable();
    node(missingTarget, 'app-us-west').readTargets = ['ghost'];
    expect(codes(missingTarget)).toContain('read_target_missing');

    const wrongKind = mutable();
    wrongKind.nodes.push({
      id: 'cache-us-west',
      kind: 'cache',
      region: 'us-west',
      position: { x: 120, y: 420 },
      size: 'S',
    });
    node(wrongKind, 'app-us-west').readTargets = ['cache-us-west'];
    wrongKind.edges.push({
      id: 'e-app-cache',
      from: 'app-us-west',
      to: 'cache-us-west',
      kind: 'request',
    });
    expect(codes(wrongKind)).toContain('read_target_kind');

    const duplicateTarget = mutable();
    node(duplicateTarget, 'app-us-west').readTargets = [
      'journal-us-west',
      'journal-us-west',
    ];
    expect(codes(duplicateTarget)).toContain('read_target_duplicate');
  });

  it('requires Inventory to be reachable from every Application', () => {
    const unreachableInventory = mutable();
    unreachableInventory.edges = unreachableInventory.edges.filter(
      (entry) => entry.id !== 'e-inv-eu',
    );
    expect(codes(unreachableInventory)).toContain('inventory_unreachable');
  });

  it('enforces singletons and canonical fixed source ids', () => {
    const twoApplications = mutable();
    twoApplications.nodes.push({
      ...node(twoApplications, 'app-us-west'),
      id: 'app-us-west-secondary',
      readTargets: ['journal-us-west'],
    });
    expect(codes(twoApplications)).toContain('duplicate_regional_service');

    const twoInventories = mutable();
    twoInventories.nodes.push({
      ...node(twoInventories, 'inventory-us-west'),
      id: 'inventory-eu-central',
      region: 'eu-central',
    });
    expect(codes(twoInventories)).toContain('duplicate_regional_service');

    const twoCaches = mutable();
    for (const suffix of ['a', 'b']) {
      twoCaches.nodes.push({
        id: `cache-us-west-${suffix}`,
        kind: 'cache',
        region: 'us-west',
        position: { x: 0, y: 0 },
        size: 'S',
      });
    }
    expect(codes(twoCaches)).toContain('duplicate_regional_service');

    const renamedSource = mutable();
    node(renamedSource, 'customers-us-west').id = 'customers-us';
    edge(renamedSource, 'e-source-us').from = 'customers-us';
    expect(codes(renamedSource)).toContain('source_id_not_canonical');

    const missingSource = mutable();
    missingSource.nodes = missingSource.nodes.filter(
      (entry) => entry.id !== 'customers-us-west',
    );
    missingSource.edges = missingSource.edges.filter(
      (entry) => entry.id !== 'e-source-us',
    );
    expect(codes(missingSource)).toContain('missing_customers_region');
  });
});
