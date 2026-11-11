/**
 * GC-PE8 focused regressions: the configured regional cache is a real read
 * target, is populated only from delivered attested reads, and is emptied by
 * the frozen 40 s cache transition without touching durable state.
 *
 * Everything is asserted through an actual `CartCaseModel` run: the read engine,
 * the shared network and the model scheduler execute the real protocol, and the
 * cache counters come from the real `CartVolatileCache` instances. No frozen
 * constant is changed and no protocol shortcut is introduced.
 */
import { describe, expect, it } from 'vitest';

import { CART_LEVEL_ID, CART_VERSIONS, type CartGraph } from '../index';
import { CART_MIB_BYTES } from '../core/resources';
import { CartCaseModel, analyzeCartTopology, CART_CACHE_CLEAR_US } from '../core/model';
import type { CartOperationIntent } from '../core/workload';

type Region = 'us-west' | 'eu-central' | 'ap-northeast';

const ALL_REGIONS: readonly Region[] = ['us-west', 'eu-central', 'ap-northeast'];

interface GraphOptions {
  /** Include a cache node per region; listed in the local Application's targets. */
  readonly caches?: readonly { readonly region: Region; readonly size: 'S' | 'M' }[];
}

function cacheGraph(options: GraphOptions = {}): CartGraph {
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];

  ALL_REGIONS.forEach((region, index) => {
    const x = 40 + index * 400;
    nodes.push({ id: `customers-${region}`, kind: 'customers', region, position: { x, y: 40 } });
    nodes.push({
      id: `journal-${region}`,
      kind: 'journal',
      region,
      position: { x: x + 40, y: 340 },
      size: 'S',
    });
    nodes.push({
      id: `app-${region}`,
      kind: 'application',
      region,
      position: { x: x + 40, y: 200 },
      size: 'S',
      instances: 1,
      writeTarget: `journal-${region}`,
      readPolicy: 'local-repair',
      readTargets: [
        ...(options.caches ?? [])
          .filter((candidate) => candidate.region === region)
          .map(() => `cache-${region}`),
        ...ALL_REGIONS.map((origin) => `journal-${origin}`),
      ],
    });
    edges.push({ id: `src-${region}`, from: `customers-${region}`, to: `app-${region}`, kind: 'request' });
    edges.push({ id: `write-${region}`, from: `app-${region}`, to: `journal-${region}`, kind: 'request' });
    for (const origin of ALL_REGIONS) {
      if (origin === region) continue;
      edges.push({ id: `read-${region}-${origin}`, from: `app-${region}`, to: `journal-${origin}`, kind: 'request' });
    }
  });
  for (const cache of options.caches ?? []) {
    nodes.push({
      id: `cache-${cache.region}`,
      kind: 'cache',
      region: cache.region,
      position: { x: 200, y: 120 },
      size: cache.size,
    });
    edges.push({ id: `use-cache-${cache.region}`, from: `app-${cache.region}`, to: `cache-${cache.region}`, kind: 'request' });
  }
  nodes.push({ id: 'inventory-us-west', kind: 'inventory', region: 'us-west', position: { x: 240, y: 480 }, size: 'M' });
  for (const region of ALL_REGIONS) {
    edges.push({ id: `inv-${region}`, from: `app-${region}`, to: 'inventory-us-west', kind: 'request' });
  }

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

function editIntent(id: string, region: Region, sequence: number, cartId: string, atUs: number): CartOperationIntent {
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
  servedBy: Region,
  cartId: string,
  atUs: number,
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

function runModel(graph: CartGraph, intents: readonly CartOperationIntent[]): CartCaseModel {
  const facts = analyzeCartTopology(graph);
  expect(facts.qualified).toBe(true);
  const model = new CartCaseModel('normal', facts, intents, [], graph);
  model.run();
  return model;
}

/** Node ids that received a real read-request RPC for one read. */
function readRequestTargets(model: CartCaseModel, requestId: string): string[] {
  const targets: string[] = [];
  for (const transfer of model.transferSnapshots) {
    if (transfer.purpose !== 'request') continue;
    if (!transfer.logicalId.startsWith(`${requestId}:r:`)) continue;
    if (transfer.to.kind === 'node') targets.push(transfer.to.nodeId);
  }
  return targets;
}

function outcomeOf(model: CartCaseModel, id: string) {
  return model.requestRecords.find((record) => record.id === id);
}

function cacheSnapshot(model: CartCaseModel, nodeId: string) {
  const snapshot = model.cacheSnapshots.find((entry) => entry.nodeId === nodeId);
  expect(snapshot).toBeDefined();
  return snapshot!;
}

const CART = 'cart-cache';

describe('configured volatile cache wiring', () => {
  it('serves a second eligible read from the real cache instead of rejecting the read', () => {
    const graph = cacheGraph({ caches: [{ region: 'us-west', size: 'S' }] });
    const model = runModel(graph, [
      editIntent('e1', 'us-west', 1, CART, 1_000_000),
      readIntent('r1', ['e1'], 'us-west', CART, 2_000_000),
      readIntent('r2', ['e1'], 'us-west', CART, 2_400_000),
    ]);

    // Before GC-PE8 a configured cache made `readEngine` return null, so every
    // read of that Application was rejected as 'no-write-authority'.
    expect(outcomeOf(model, 'e1')?.outcome).toBe('committed');
    expect(outcomeOf(model, 'r1')?.outcome).toBe('committed');
    expect(outcomeOf(model, 'r2')?.outcome).toBe('committed');
    expect(model.readResults.get('r2')?.coveredIds).toEqual(['us-west/client-a/1']);

    const cache = cacheSnapshot(model, "cache-us-west");
    expect(cache.stores).toBeGreaterThanOrEqual(1);
    expect(cache.hits).toBeGreaterThanOrEqual(1);
    // The second read is answered by the cache: it contacts no durable node.
    expect(readRequestTargets(model, 'r2')).toEqual(['cache-us-west']);
  });

  it('does not let a stale cached view satisfy a newer session token', () => {
    const graph = cacheGraph({ caches: [{ region: 'us-west', size: 'S' }] });
    const model = runModel(graph, [
      editIntent('e1', 'us-west', 1, CART, 1_000_000),
      readIntent('r1', ['e1'], 'us-west', CART, 2_000_000),
      editIntent('e2', 'us-west', 2, CART, 2_200_000),
      // 900 ms after r1's delivery: still inside the frozen 1 s reuse window,
      // so the cache lookup is a real `hit`, not a TTL-expired `stale` one.
      readIntent('r2', ['e1', 'e2'], 'us-west', CART, 2_900_000),
    ]);

    expect(outcomeOf(model, 'r2')?.outcome).toBe('committed');
    expect(model.readResults.get('r2')?.coveredIds).toEqual([
      'us-west/client-a/1',
      'us-west/client-a/2',
    ]);
    // The fresh entry covers only `e1`; the newer token id `e2` it does not
    // cover had to be repaired from a durable target over a real path. The
    // distinction matters: `staleHits` must stay zero, otherwise this case
    // would only prove TTL expiry instead of token incompleteness.
    const cache = cacheSnapshot(model, "cache-us-west");
    expect(cache.hits).toBeGreaterThanOrEqual(1);
    expect(cache.staleHits).toBe(0);
    expect(readRequestTargets(model, 'r2')).toContain('journal-us-west');
  });

  it('clears the cache before any same-time probe at the exact 40 s boundary', () => {
    const graph = cacheGraph({ caches: [{ region: 'us-west', size: 'S' }] });
    // A 288-byte 1-id read request takes 9_191 us from offer to arrival on the
    // real app → cache path, so this offer puts the cache probe's due
    // continuation exactly on the frozen transition instant. The assertion
    // below pins that arrival; a drift in the frozen constants fails loudly
    // instead of silently missing the boundary.
    const boundaryOfferUs = CART_CACHE_CLEAR_US - 9_191;
    const model = runModel(graph, [
      editIntent('e1', 'us-west', 1, CART, 1_000_000),
      readIntent('r1', ['e1'], 'us-west', CART, 2_000_000),
      readIntent('r2', ['e1'], 'us-west', CART, boundaryOfferUs),
    ]);

    const cacheRequests = model.transferSnapshots.filter(
      (transfer) =>
        transfer.purpose === 'request' &&
        transfer.logicalId.startsWith('r2:r:') &&
        transfer.to.kind === 'node' &&
        transfer.to.nodeId === 'cache-us-west',
    );
    expect(cacheRequests).toHaveLength(1);
    expect(cacheRequests[0]!.enqueuedAtUs).toBeLessThan(CART_CACHE_CLEAR_US);
    expect(cacheRequests[0]!.deliveredAtUs).toBe(CART_CACHE_CLEAR_US);

    const cache = cacheSnapshot(model, "cache-us-west");
    expect(cache.clears).toBe(1);
    // The probe due exactly at 40 s ran after the transition: it is a miss.
    // The prior candidate ran it first and reused the r1 entry (staleHits: 1,
    // misses: 2), so this assertion fails without the ordering fix.
    expect(cache.hits).toBe(0);
    expect(cache.staleHits).toBe(0);
    expect(cache.misses).toBeGreaterThanOrEqual(3);
    // No delivered read repopulated the cache at the boundary; only r1 stored.
    expect(cache.stores).toBe(1);
    expect(cache.entries).toBe(0);

    // The volatile clear never touches acknowledged durable state.
    expect(outcomeOf(model, 'e1')?.outcome).toBe('committed');
    expect(outcomeOf(model, 'e1')?.acknowledged).toBe(true);
    expect(model.cartLiveQuantity(CART)).toBe(2);
    // Inside the maintenance window the read honestly degrades; it cannot be
    // answered from an entry the frozen transition already removed.
    expect(outcomeOf(model, 'r2')?.outcome).toBe('unavailable');
  });

  it('empties the real cache at the frozen 40 s transition and keeps acknowledged edits', () => {
    const graph = cacheGraph({ caches: [{ region: 'us-west', size: 'S' }] });
    const model = runModel(graph, [
      editIntent('e1', 'us-west', 1, CART, 1_000_000),
      readIntent('r1', ['e1'], 'us-west', CART, 2_000_000),
      // Inside the Tokyo incident: every origin certificate is required, so this
      // read honestly degrades instead of succeeding.
      readIntent('r2', ['e1'], 'us-west', CART, 41_000_000),
      // After restoration the same acknowledged edit is readable again.
      readIntent('r3', ['e1'], 'us-west', CART, 54_000_000),
    ]);

    const cache = cacheSnapshot(model, "cache-us-west");
    expect(cache.clears).toBe(1);
    expect(cache.stores).toBe(2);
    // Nothing after the clear reused a cache entry, and the entry stored by r1
    // no longer existed at 41 s: every later read (including the recovery
    // barrier's) had to miss the cache instead of hitting or revalidating it.
    expect(cache.hits).toBe(0);
    expect(cache.staleHits).toBe(0);
    expect(cache.misses).toBeGreaterThanOrEqual(3);
    expect(cache.entries).toBe(1);

    // Acknowledged durable state survived the volatile clear.
    expect(outcomeOf(model, 'e1')?.outcome).toBe('committed');
    expect(outcomeOf(model, 'e1')?.acknowledged).toBe(true);
    expect(model.cartLiveQuantity(CART)).toBe(2);
    expect(outcomeOf(model, 'r3')?.outcome).toBe('committed');
  });

  it('exposes the frozen S/M capacities and a measurable cache-vs-durable difference', () => {
    const withCacheGraph = cacheGraph({
      caches: [
        { region: 'us-west', size: 'S' },
        { region: 'eu-central', size: 'M' },
      ],
    });
    const intents = [
      editIntent('e1', 'us-west', 1, CART, 1_000_000),
      readIntent('r1', ['e1'], 'us-west', CART, 2_000_000),
      readIntent('r2', ['e1'], 'us-west', CART, 2_400_000),
    ];
    const cached = runModel(withCacheGraph, intents);
    const plain = runModel(cacheGraph(), intents);

    expect(cacheSnapshot(cached, 'cache-us-west').capacityBytes).toBe(4 * CART_MIB_BYTES);
    expect(cacheSnapshot(cached, 'cache-eu-central').capacityBytes).toBe(16 * CART_MIB_BYTES);

    const cachedSecondRead = cached.readResults.get('r2');
    const plainSecondRead = plain.readResults.get('r2');
    expect(cachedSecondRead).toBeDefined();
    expect(plainSecondRead).toBeDefined();
    // Without a cache the second read pays durable CPU/IO and remote request
    // bytes; with it the same read is answered by the volatile view.
    expect(cachedSecondRead!.charge.ioUnits).toBe(0);
    expect(plainSecondRead!.charge.ioUnits).toBeGreaterThan(0);
    expect(cachedSecondRead!.charge.requestBytes).toBeLessThan(plainSecondRead!.charge.requestBytes);
    expect(plain.cacheSnapshots).toHaveLength(0);
  });
});
