import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CartGraph } from '../contracts';
import { CartCaseModel, analyzeCartTopology } from '../core/model';
import {
  CartResourceLedger,
  CART_QUEUE_TASK_RAM_BYTES,
  type CartNodeCapacity,
  type CartResourcePlan,
} from '../core/resources';
import { CartServiceQueues } from '../core/service-queues';
import { buildCartCaseWorkload, type CartOperationIntent } from '../core/workload';

/**
 * GC-PE7 boundary microcases. These exercise the executed service seam
 * (`CartServiceQueues` + `CartResourceLedger`) that every model stage uses;
 * timestamp scheduling alone can no longer imply an unbounded queue.
 */
function capacity(nodeId: string, overrides: Partial<CartNodeCapacity> = {}): CartNodeCapacity {
  const base: CartNodeCapacity = {
    nodeId,
    kind: 'application',
    size: 'S',
    region: 'us-west',
    instances: 1,
    cpuLanes: 1,
    ioPerSecond: null,
    ramBytes: 4 * 1024 * 1024,
    usablePayloadBytes: null,
    durableBytes: 0,
    fixedRamBytes: 0,
    pendingLimit: 128,
    rentalPerHour: 0,
    cpuLanesTotal: 1,
    ramBytesTotal: 4 * 1024 * 1024,
    durableBytesTotal: 0,
    rentalPerHourTotal: 0,
  };
  return { ...base, ...overrides };
}

function planOf(nodes: readonly CartNodeCapacity[]): CartResourcePlan {
  return {
    nodes: new Map(nodes.map((node) => [node.nodeId, node])),
    circuits: new Map(),
    componentRentalPerHour: 0,
    circuitRentalPerHour: 0,
    totalRentalPerHour: 0,
  };
}

function seam(node: CartNodeCapacity): { queue: CartServiceQueues; ledger: CartResourceLedger } {
  const ledger = new CartResourceLedger(planOf([node]));
  return { queue: new CartServiceQueues(planOf([node]), { ledger }), ledger };
}

describe('bounded pending/queue-RAM admission', () => {
  it('fills the pending-task limit, rejects the next window and admits again after release', () => {
    const { queue, ledger } = seam(capacity('node-a', { pendingLimit: 2 }));
    const first = queue.reserve('node-a', 0, 1_000);
    const second = queue.reserve('node-a', 0, 1_000);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(ledger.snapshot('node-a')!.pendingTasks).toBe(2);

    expect(queue.reserve('node-a', 0, 1_000)).toBeNull();
    expect(queue.admissionRejections).toBe(1);
    // Rejection reserved nothing and mutated no bound.
    expect(ledger.snapshot('node-a')!.pendingTasks).toBe(2);
    expect(ledger.snapshot('node-a')!.queueRamBytes).toBe(2 * CART_QUEUE_TASK_RAM_BYTES);

    expect(queue.release(first!)).toBe(true);
    expect(queue.reserve('node-a', 0, 1_000)).not.toBeNull();
    expect(ledger.snapshot('node-a')!.pendingTasks).toBe(2);
  });

  it('rejects the next operation when queue RAM is full and admits after release', () => {
    const { queue, ledger } = seam(
      capacity('node-a', { pendingLimit: 128, ramBytesTotal: 4_096, ramBytes: 4_096 }),
    );
    const payload = 1_000; // 1024 B task + payload = 2024 B per live task.
    const first = queue.reserve('node-a', 0, 1_000, 1, payload);
    const second = queue.reserve('node-a', 0, 1_000, 1, payload);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(ledger.snapshot('node-a')!.queueRamBytes).toBe(2 * (CART_QUEUE_TASK_RAM_BYTES + payload));

    expect(queue.reserve('node-a', 0, 1_000, 1, payload)).toBeNull();
    expect(queue.admissionRejections).toBe(1);

    queue.release(second!);
    expect(queue.reserve('node-a', 0, 1_000, 1, payload)).not.toBeNull();
  });

  it('does not leak or double-count reservations across cancel-replay', () => {
    const { queue, ledger } = seam(capacity('node-a'));
    const attempt = queue.reserve('node-a', 0, 5_000, 1, 200);
    expect(attempt).not.toBeNull();
    // Client cancellation releases the pending task exactly once.
    expect(queue.release(attempt!)).toBe(true);
    expect(queue.release(attempt!)).toBe(false);
    expect(queue.pendingTasks).toBe(0);
    expect(ledger.snapshot('node-a')!.pendingTasks).toBe(0);

    // A retry is a new admission, never a second charge for the old attempt.
    const retry = queue.reserve('node-a', 10, 5_000, 1, 200);
    expect(retry).not.toBeNull();
    expect(queue.pendingTasks).toBe(1);
    expect(ledger.snapshot('node-a')!.pendingTasks).toBe(1);
    expect(ledger.snapshot('node-a')!.queueRamBytes).toBe(CART_QUEUE_TASK_RAM_BYTES + 200);
  });

  it('retires completed work at its own completion time without a second release', () => {
    const { queue, ledger } = seam(capacity('node-a'));
    const done = queue.reserve('node-a', 0, 1_000);
    expect(done).not.toBeNull();
    // Nothing completed before doneUs.
    queue.releaseCompleted('node-a', 999);
    expect(queue.pendingTasks).toBe(1);
    // Lazy retirement at/after completion frees the reservation once.
    queue.releaseCompleted('node-a', 1_000);
    expect(queue.pendingTasks).toBe(0);
    expect(ledger.snapshot('node-a')!.pendingTasks).toBe(0);
    expect(queue.release(done!)).toBe(false);
  });

  it('includes standing index working memory in the queue budget', async () => {
    const { queue, ledger } = seam(
      capacity('node-a', { pendingLimit: 128, ramBytesTotal: 4_096, ramBytes: 4_096 }),
    );
    const { CART_INVENTORY_ORDER_INDEX_BYTES, CART_INVENTORY_SKU_INDEX_BYTES } = await import('../core/inventory');
    // 3000 B of Inventory order/SKU index is unavailable to queues.
    const index = 30 * CART_INVENTORY_ORDER_INDEX_BYTES + 30 * CART_INVENTORY_SKU_INDEX_BYTES;
    expect(ledger.reserveWorkingRam('node-a', index).ok).toBe(true);
    expect(index).toBe(2_880);
    expect(queue.reserve('node-a', 0, 1_000, 1, 1_000)).toBeNull();
    expect(ledger.snapshot('node-a')!.indexRamBytes).toBe(index);
    // Releasing the index memory admits the operation again.
    expect(ledger.releaseWorkingRam('node-a', index)).toBe(true);
    expect(queue.reserve('node-a', 0, 1_000, 1, 1_000)).not.toBeNull();
    expect(queue.admissionRejections).toBe(1);
  });

  it('keeps the sampled average queue at or below its observed peak', () => {
    const { queue } = seam(capacity('node-a', { pendingLimit: 4 }));
    const samples: number[] = [];
    const live: NonNullable<ReturnType<CartServiceQueues['reserve']>>[] = [];
    for (let round = 0; round < 40; round += 1) {
      const window = queue.reserve('node-a', round * 10, 5, 1, 64);
      if (window !== null) live.push(window);
      samples.push(queue.pendingTasks);
      if (live.length === 4) {
        queue.release(live.shift()!);
        samples.push(queue.pendingTasks);
      }
    }
    queue.releaseCompletedAll(10_000);
    samples.push(queue.pendingTasks);
    const peak = Math.max(...samples);
    const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    expect(peak).toBeLessThanOrEqual(4);
    expect(average).toBeLessThanOrEqual(peak);
    expect(queue.pendingTasks).toBe(0);
  });

  it('retires the delivered answer before admitting the terminal freshness audit', () => {
    const { queue, ledger } = seam(capacity('node-a', { pendingLimit: 2 }));
    // The read delivery stage admits a 100 us answer window (128 B payload) at
    // its real arrival; the terminal freshness audit is a later 100 us window.
    const answer = queue.reserve('node-a', 0, 100, 1, 128);
    const other = queue.reserve('node-a', 0, 5_000);
    expect(answer).not.toBeNull();
    expect(other).not.toBeNull();
    expect(queue.reserve('node-a', 0, 100, 1, 0)).toBeNull();
    // The answer window always completes at or before the client delivery
    // instant, so lazy retirement at delivery frees its slot for the audit.
    const audit = queue.reserve('node-a', 100, 100, 1, 0);
    expect(audit).not.toBeNull();
    expect(ledger.snapshot('node-a')!.pendingTasks).toBe(2);
    expect(queue.release(audit!)).toBe(true);
    expect(queue.release(other!)).toBe(true);
    expect(ledger.snapshot('node-a')!.pendingTasks).toBe(0);
  });
});

describe('executed model admission accounting', () => {
  const base = JSON.parse(
    readFileSync('tests/fixtures/cart/candidates/family-a-central-journal.json', 'utf8'),
  ).graph as CartGraph;
  function burst(limit = 100): CartOperationIntent[] {
    return buildCartCaseWorkload('normal', 1729).intents
      .filter((intent) => intent.effect.kind === 'add' && intent.region === 'us-west' && intent.dependsOn.length === 0)
      .slice(0, limit)
      .map((intent) => ({ ...intent, atUs: 0 }));
  }
  function run(intents: readonly CartOperationIntent[]): CartCaseModel {
    const model = new CartCaseModel('normal', analyzeCartTopology(base), intents, [], base);
    model.run();
    return model;
  }

  it('drains an ordinary burst with zero leaked reservations', () => {
    const model = run(burst());
    expect(model.pendingServiceTasks).toBe(0);
    expect(model.queuedRamBytes).toBe(0);
    // The 100-add burst stays inside the frozen 256-task Application bound, so
    // the repair changes no ordinary outcome.
    expect(model.admissionRejections).toBe(0);
    expect(model.requestRecords.filter((record) => record.operation === 'edit')).toHaveLength(100);
    expect(model.inventoryIndexRamBytes).toBeGreaterThan(0);
  });

  function readGraph(): CartGraph {
    const graph = structuredClone(base);
    const app = graph.nodes.find((node) => node.id === 'app-us-west');
    if (app === undefined || app.kind !== 'application') throw new Error('application expected');
    app.readTargets = graph.nodes.filter((node) => node.kind === 'journal').map((node) => node.id);
    for (const target of app.readTargets) {
      graph.edges.push({ id: `read-${target}`, kind: 'request', from: app.id, to: target });
    }
    return graph;
  }
  const editIntent: CartOperationIntent = {
    id: 'read-setup-edit',
    caseId: 'normal',
    atUs: 0,
    cartId: 'read-basket',
    region: 'us-west',
    remoteReadRegion: null,
    key: { originRegion: 'us-west', clientId: 'buyer', requestSequence: 1 },
    slotIndex: 0,
    stream: 'base',
    operation: 'edit',
    editKind: 'add',
    effect: { kind: 'add', sku: 7, count: 1 },
    observedContext: [],
    dependsOn: [],
  };
  const readIntent: CartOperationIntent = {
    ...editIntent,
    id: 'read-target',
    atUs: 100_000,
    operation: 'read',
    editKind: null,
    effect: { kind: 'read', servedBy: 'us-west', token: ['read-setup-edit'] },
    dependsOn: ['read-setup-edit'],
  };

  it('commits a delivered read only after its terminal audit window is admitted', () => {
    const graph = readGraph();
    const model = new CartCaseModel('normal', analyzeCartTopology(graph), [editIntent, readIntent], [], graph);
    model.run();
    const record = model.requestRecords.find((entry) => entry.id === 'read-target');
    expect(record?.outcome).toBe('committed');
    expect(record?.acknowledged).toBe(true);
    expect(record?.deliveredUs).not.toBeNull();
    expect(model.admissionRejections).toBe(0);
    expect(model.pendingServiceTasks).toBe(0);
    expect(model.queuedRamBytes).toBe(0);
  });

  it('never books a delivered read that the bounded service path refused to finish', () => {
    const graph = readGraph();
    // A saturated Application bound (real read offers through the same
    // client→app→authority path) must reject bounded overflow instead of
    // growing the queue, and every answer that did reach a client must stay
    // committed with no reservation leak.
    const saturated = Array.from({ length: 2000 }, (_, index): CartOperationIntent => ({
      ...readIntent,
      id: `saturated-read-${index}`,
      atUs: 300_000,
    }));
    const model = new CartCaseModel('normal', analyzeCartTopology(graph), [editIntent, ...saturated], [], graph);
    model.run();
    const reads = model.requestRecords.filter((record) => record.operation === 'read');
    expect(reads.length).toBeGreaterThan(1_000);
    expect(model.admissionRejections).toBeGreaterThan(0);
    expect(reads.filter((record) => record.deliveredUs !== null && record.outcome !== 'committed')).toEqual([]);
    expect(model.pendingServiceTasks).toBe(0);
    expect(model.queuedRamBytes).toBe(0);
  });
});
