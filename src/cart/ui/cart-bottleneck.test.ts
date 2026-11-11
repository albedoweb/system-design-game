import { describe, expect, it } from 'vitest';

import type { CartGraph } from '../index';
import {
  cartBottleneckSentence,
  cartBottlenecks,
  type CartRunObservation,
} from './cart-bottleneck';

const graph = {
  levelId: 'global-cart',
  nodes: [
    { id: 'store-eu', kind: 'store', region: 'eu-central', label: 'Cart store', position: { x: 0, y: 0 } },
    { id: 'app', kind: 'application', region: 'us-west', position: { x: 0, y: 0 } },
  ],
  edges: [],
} as unknown as CartGraph;

const idleLoad = {
  cpuLanes: 4, cpuTasks: 0, cpuBusyMs: 0, cpuWaitAvgMs: 0, cpuWaitMaxMs: 0, cpuRejected: 0,
  ioTasks: 0, ioBusyMs: 0, ioWaitAvgMs: 0, ioWaitMaxMs: 0,
};

function observation(nodes: CartRunObservation['nodes']): CartRunObservation {
  return { elapsedMs: 40_000, operations: [], nodes } as CartRunObservation;
}

describe('cartBottlenecks', () => {
  it('uses a 50 ms threshold for disk and CPU waits', () => {
    const below = observation([{
      nodeId: 'store-eu', cpuMs: 0, ramBytes: 0, ramCapacityBytes: 1, pendingTasks: 0, transactionQueue: 0,
      ioUnits: 0, storedBytes: 0, storageCapacityBytes: 1,
      load: { ...idleLoad, ioTasks: 5, ioBusyMs: 1000, ioWaitMaxMs: 49.9, cpuWaitMaxMs: 49.9 },
    }]);
    expect(cartBottlenecks(graph, below)).toEqual([]);

    const at = observation([{
      nodeId: 'store-eu', cpuMs: 0, ramBytes: 0, ramCapacityBytes: 1, pendingTasks: 0, transactionQueue: 0,
      ioUnits: 0, storedBytes: 0, storageCapacityBytes: 1,
      load: { ...idleLoad, ioTasks: 5, ioBusyMs: 1000, ioWaitMaxMs: 50 },
    }]);
    const result = cartBottlenecks(graph, at);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ resource: 'disk', waitMaxMs: 50, label: 'Cart store · EU Central' });
  });

  it('returns nothing without observation or load counters', () => {
    expect(cartBottlenecks(graph, undefined)).toEqual([]);
    expect(cartBottlenecks(graph, observation([{
      nodeId: 'store-eu', cpuMs: 0, ramBytes: 0, ramCapacityBytes: 1, pendingTasks: 0, transactionQueue: 0,
      ioUnits: 0, storedBytes: 0, storageCapacityBytes: 1,
    }]))).toEqual([]);
  });

  it('falls back to the node id when the node is not in the graph', () => {
    const result = cartBottlenecks(graph, observation([{
      nodeId: 'ghost', cpuMs: 0, ramBytes: 0, ramCapacityBytes: 1, pendingTasks: 0, transactionQueue: 0,
      ioUnits: 0, storedBytes: 0, storageCapacityBytes: 1,
      load: { ...idleLoad, cpuWaitMaxMs: 80, cpuWaitAvgMs: 10, cpuBusyMs: 80_000 },
    }]));
    expect(result[0]!.label).toBe('ghost');
    expect(result[0]!.busyShare).toBeCloseTo(0.5);
  });

  it('sorts by longest wait and puts admission refusals last', () => {
    const result = cartBottlenecks(graph, observation([
      {
        nodeId: 'store-eu', cpuMs: 0, ramBytes: 0, ramCapacityBytes: 1, pendingTasks: 0, transactionQueue: 0,
        ioUnits: 0, storedBytes: 0, storageCapacityBytes: 1,
        load: { ...idleLoad, ioTasks: 5, ioBusyMs: 1000, ioWaitMaxMs: 543.1, ioWaitAvgMs: 197.5, cpuRejected: 3 },
      },
      {
        nodeId: 'app', cpuMs: 0, ramBytes: 0, ramCapacityBytes: 1, pendingTasks: 0, transactionQueue: 0,
        ioUnits: 0, storedBytes: 0, storageCapacityBytes: 1,
        load: { ...idleLoad, cpuWaitMaxMs: 120, cpuWaitAvgMs: 4, cpuRejected: 1 },
      },
    ]));
    expect(result.map((item) => `${item.label}:${item.resource}`)).toEqual([
      'Cart store · EU Central:disk',
      'Application · US West:cpu',
      'Cart store · EU Central:admission',
      'Application · US West:admission',
    ]);
  });
});

describe('cartBottleneckSentence', () => {
  it('formats disk, CPU and admission sentences', () => {
    expect(cartBottleneckSentence({
      nodeId: 'store-eu', label: 'Cart store · EU Central', resource: 'disk',
      waitMaxMs: 543.1, waitAvgMs: 197.5, busyShare: 0.635, rejected: 0,
    })).toBe('Cart store · EU Central: operations waited up to 543 ms for its disk (198 ms on average). Its disk was busy 64% of the run. Try a larger size.');
    expect(cartBottleneckSentence({
      nodeId: 'app', label: 'Cart API · US West', resource: 'cpu',
      waitMaxMs: 2.94, waitAvgMs: 0.4, busyShare: 0.231, rejected: 0,
    })).toBe('Cart API · US West: operations waited up to 2.9 ms for CPU (0.4 ms on average). CPU was busy 23% of the run. Try a larger size or a second instance.');
    expect(cartBottleneckSentence({
      nodeId: 'app', label: 'Cart API · US West', resource: 'admission',
      waitMaxMs: 0, waitAvgMs: 0, busyShare: 0, rejected: 12,
    })).toBe('Cart API · US West: refused 12 operations because its queue or memory was full. Try a larger size.');
  });
});

const wanLink = (overrides: Partial<NonNullable<CartRunObservation['links']>[number]>) => ({
  id: 'wan:us-west|eu-central:forward', kind: 'wan' as const, pair: 'us-west|eu-central', direction: 'forward',
  mbps: 2, jobs: 1000, busyMs: 18_960, waitAvgMs: 8.74, waitMaxMs: 95.1, ...overrides,
});

function observationWithLinks(
  nodes: CartRunObservation['nodes'],
  links: CartRunObservation['links'],
): CartRunObservation {
  return { elapsedMs: 40_000, operations: [], nodes, links } as CartRunObservation;
}

describe('cartBottlenecks circuits', () => {
  it('uses the same 50 ms threshold for WAN link waits', () => {
    expect(cartBottlenecks(graph, observationWithLinks([], [wanLink({ waitMaxMs: 49.9 })]))).toEqual([]);
    const at = cartBottlenecks(graph, observationWithLinks([], [wanLink({ waitMaxMs: 50 })]));
    expect(at).toHaveLength(1);
    expect(at[0]).toMatchObject({ resource: 'circuit', waitMaxMs: 50, mbps: 2, busyShare: 18_960 / 40_000 });
  });

  it('labels forward and reverse directions from the sending region', () => {
    const result = cartBottlenecks(graph, observationWithLinks([], [
      wanLink({}),
      wanLink({ id: 'wan:us-west|eu-central:reverse', direction: 'reverse', waitMaxMs: 60 }),
    ]));
    expect(result.map((item) => item.label)).toEqual([
      'Circuit US West → EU Central',
      'Circuit EU Central → US West',
    ]);
    expect(result[1]!.nodeId).toBe('wan:us-west|eu-central:reverse');
  });

  it('sorts circuits together with node entries by longest wait', () => {
    const result = cartBottlenecks(graph, observationWithLinks([
      {
        nodeId: 'store-eu', cpuMs: 0, ramBytes: 0, ramCapacityBytes: 1, pendingTasks: 0, transactionQueue: 0,
        ioUnits: 0, storedBytes: 0, storageCapacityBytes: 1,
        load: { ...idleLoad, ioTasks: 5, ioBusyMs: 1000, ioWaitMaxMs: 60, ioWaitAvgMs: 10 },
      },
    ], [wanLink({ waitMaxMs: 95.1 }), wanLink({ id: 'wan:x', direction: 'reverse', waitMaxMs: 70 })]));
    expect(result.map((item) => `${item.label}:${item.resource}`)).toEqual([
      'Circuit US West → EU Central:circuit',
      'Circuit EU Central → US West:circuit',
      'Cart store · EU Central:disk',
    ]);
  });

  it('emits nothing for circuits when links are absent or not WAN', () => {
    expect(cartBottlenecks(graph, observationWithLinks([], undefined))).toEqual([]);
    expect(cartBottlenecks(graph, observationWithLinks([], [
      wanLink({ kind: 'nic', pair: null, waitMaxMs: 500 }),
    ]))).toEqual([]);
  });
});

describe('cartBottleneckSentence circuits', () => {
  it('formats the circuit sentence', () => {
    expect(cartBottleneckSentence({
      nodeId: 'wan:us-west|eu-central:forward', label: 'Circuit US West → EU Central', resource: 'circuit', mbps: 2,
      waitMaxMs: 95.1, waitAvgMs: 8.74, busyShare: 0.474, rejected: 0,
    })).toBe('Circuit US West → EU Central (2 Mbit/s): messages waited up to 95 ms to be sent (8.7 ms on average). The circuit was busy 47% of the run. Try a faster circuit for this region pair.');
  });
});
