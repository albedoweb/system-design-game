import { describe, expect, it } from 'vitest';

import type { CartEvaluation, CartGraph } from '../index';
import { CART_NO_HOTSPOTS, cartHotspots } from './cart-hotspots';
import type { CartRunObservation } from './cart-bottleneck';

const graph = { levelId: 'global-cart', nodes: [], edges: [] } as unknown as CartGraph;

const idleLoad = {
  cpuLanes: 4, cpuTasks: 0, cpuBusyMs: 0, cpuWaitAvgMs: 0, cpuWaitMaxMs: 0, cpuRejected: 0,
  ioTasks: 0, ioBusyMs: 0, ioWaitAvgMs: 0, ioWaitMaxMs: 0,
};

function link(id: string, direction: 'forward' | 'reverse', waitMaxMs: number) {
  return {
    id, kind: 'wan', pair: 'us-west|eu-central', direction, mbps: 2,
    waitMaxMs, waitAvgMs: waitMaxMs / 2, busyMs: 1_000, jobs: 10,
  };
}

function observation(options: { disk?: number; circuitForward?: number; circuitReverse?: number }): CartRunObservation {
  const nodes = options.disk === undefined ? [] : [{
    nodeId: 'store-eu', ramBytes: 0, ramCapacityBytes: 1, storedBytes: 0, storageCapacityBytes: 1,
    pendingTasks: 0, transactionQueue: 0,
    load: { ...idleLoad, ioTasks: 5, ioBusyMs: 3_000, ioWaitMaxMs: options.disk, ioWaitAvgMs: 10 },
  }];
  const links = [
    ...(options.circuitForward === undefined ? [] : [link('wan:us-west|eu-central:forward', 'forward', options.circuitForward)]),
    ...(options.circuitReverse === undefined ? [] : [link('wan:us-west|eu-central:reverse', 'reverse', options.circuitReverse)]),
  ];
  return { elapsedMs: 40_000, operations: [], nodes, links } as unknown as CartRunObservation;
}

function evaluation(cases: { id: string; pass: boolean; obs: CartRunObservation }[]): CartEvaluation {
  return {
    complete: true,
    qualified: false,
    cases: cases.map((item) => ({
      id: item.id,
      complete: true,
      gates: [{ code: 'gate', pass: item.pass }],
      observation: item.obs,
    })),
  } as unknown as CartEvaluation;
}

describe('cartHotspots', () => {
  it('returns no hotspots without an evaluation', () => {
    expect(cartHotspots(graph, null)).toBe(CART_NO_HOTSPOTS);
  });

  it('returns no hotspots when every scenario passed', () => {
    const passing = evaluation([
      { id: 'normal', pass: true, obs: observation({ disk: 556.3, circuitForward: 95.1 }) },
      { id: 'peak', pass: true, obs: observation({ disk: 556.3 }) },
    ]);
    const result = cartHotspots(graph, passing);
    expect(result.nodes).toEqual({});
    expect(result.circuits).toEqual({});
  });

  it('labels a waiting disk and the two directions of a circuit in a failing scenario', () => {
    const failing = evaluation([
      { id: 'peak', pass: false, obs: observation({ disk: 556.3, circuitForward: 95.1, circuitReverse: 60 }) },
    ]);
    const result = cartHotspots(graph, failing);
    expect(result.nodes).toEqual({ 'store-eu': 'disk wait up to 556 ms' });
    expect(result.circuits).toEqual({ 'us-west|eu-central': 'queue up to 95 ms at 2 Mbit/s' });
  });

  it('keeps the largest wait across failing scenarios', () => {
    const failing = evaluation([
      { id: 'normal', pass: false, obs: observation({ disk: 120, circuitReverse: 200 }) },
      { id: 'peak', pass: false, obs: observation({ disk: 556.3, circuitForward: 95.1 }) },
    ]);
    const result = cartHotspots(graph, failing);
    expect(result.nodes['store-eu']).toBe('disk wait up to 556 ms');
    expect(result.circuits['us-west|eu-central']).toBe('queue up to 200 ms at 2 Mbit/s');
  });
});
