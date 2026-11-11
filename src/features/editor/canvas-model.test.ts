import { describe, expect, it } from 'vitest';

import {
  createInitialGraph,
  makeNode,
  type Diagnostic,
  type NodeMetric,
} from '../../domain';
import {
  buildNodeOccupancy,
  toCanvasNodes,
  type CanvasEvidence,
} from './canvas-model';
import { loadBand, occupancyBand } from '../metrics/load-bands';

function metric(overrides: Partial<NodeMetric> = {}): NodeMetric {
  return {
    nodeId: 'app-1',
    busy: 0,
    queued: 0,
    poolBusy: 0,
    poolQueued: 0,
    hits: 0,
    misses: 0,
    coalesced: 0,
    errors: 0,
    maxQueued: 0,
    completed: 0,
    ...overrides,
  };
}

function pressure(overrides: Partial<NonNullable<NodeMetric['pressure']>> = {}) {
  return {
    observedMs: 60_000,
    busyPeak: 14,
    poolBusyPeak: 8,
    poolQueuedPeak: 3,
    busyAvg: 9.5,
    poolBusyAvg: 7.1,
    failures: [],
    ...overrides,
  };
}

describe('component occupancy model', () => {
  it('uses real slots for app and database capacity', () => {
    const app = makeNode('appServer', 'app-1', { x: 0, y: 0 });
    const database = makeNode('database', 'db-1', { x: 0, y: 0 });

    const appLoads = buildNodeOccupancy(
      'appServer',
      app.config,
      metric({ busy: 8, poolBusy: 8, poolQueued: 2 }),
      'live',
      false,
    );
    expect(appLoads).toHaveLength(2);
    expect(appLoads[0]).toMatchObject({
      key: 'slots',
      label: 'Slots',
      used: 8,
      capacity: 16,
      average: null,
    });
    expect(appLoads[0]?.note).toBeUndefined();
    expect(occupancyBand(appLoads[0]!)).toBe('yellow');

    const pool = appLoads[1]!;
    expect(pool).toMatchObject({
      key: 'pool',
      label: 'Pool',
      used: 8,
      capacity: app.config.poolSize,
    });
    expect(occupancyBand(pool)).toBe('dark-red');

    const dbLoads = buildNodeOccupancy(
      'database',
      database.config,
      metric({ nodeId: 'db-1', busy: 3 }),
      'live',
      false,
    );
    expect(dbLoads).toHaveLength(1);
    expect(dbLoads[0]).toMatchObject({
      key: 'slots',
      used: 3,
      capacity: 4,
    });
  });

  it('shows the cache backend pool, never cache entry fullness as load', () => {
    const cache = makeNode('cache', 'cache-1', { x: 0, y: 0 });
    const loads = buildNodeOccupancy(
      'cache',
      cache.config,
      metric({ nodeId: 'cache-1', poolBusy: 4, poolQueued: 1 }),
      'live',
      false,
    );
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({
      key: 'pool',
      label: 'Pool',
      used: 4,
      capacity: cache.config.poolSize,
    });
    expect(loads[0]?.capacity).not.toBe(512);
  });

  it('does not invent occupancy for unlimited client and load balancer', () => {
    const client = makeNode('client', 'client-1', { x: 0, y: 0 });
    const lb = makeNode('loadBalancer', 'lb-1', { x: 0, y: 0 });
    expect(
      buildNodeOccupancy('client', client.config, metric(), 'live', false),
    ).toEqual([]);
    expect(
      buildNodeOccupancy('loadBalancer', lb.config, metric(), 'live', false),
    ).toEqual([]);
  });

  it('colors completed occupancy by the time-weighted average, not the peak', () => {
    const app = makeNode('appServer', 'app-1', { x: 0, y: 0 });
    const loads = buildNodeOccupancy(
      'appServer',
      app.config,
      metric({ pressure: pressure() }),
      'peak',
      false,
    );
    expect(loads[0]).toMatchObject({
      used: 9.5,
      capacity: 16,
      average: 9.5,
      peak: 14,
      note: undefined,
    });
    expect(loads[1]).toMatchObject({
      used: 7.1,
      capacity: 8,
      average: 7.1,
      peak: 8,
      note: undefined,
    });
    expect(loadBand(loads[0]!.used!, loads[0]!.capacity!)).toBe('yellow');
    expect(loadBand(loads[1]!.used!, loads[1]!.capacity!)).toBe('red');
  });

  it('never uses a capacity peak as a missing average', () => {
    const app = makeNode('appServer', 'app-1', { x: 0, y: 0 });
    const loads = buildNodeOccupancy(
      'appServer',
      app.config,
      metric({ pressure: pressure({ busyAvg: Number.NaN }) }),
      'peak',
      false,
    );
    expect(loads[0]).toMatchObject({
      used: null,
      average: null,
      peak: 14,
      note: 'Run average unavailable',
    });
    expect(occupancyBand(loads[0]!)).toBeNull();
  });

  it('marks absent peak pressure and stale evidence as unknown', () => {
    const app = makeNode('appServer', 'app-1', { x: 0, y: 0 });
    const missing = buildNodeOccupancy(
      'appServer',
      app.config,
      metric(),
      'peak',
      false,
    );
    expect(missing[0]).toMatchObject({ used: null, capacity: 16 });
    expect(missing[0]?.note).toBe('Run average unavailable');

    const stale = buildNodeOccupancy(
      'appServer',
      app.config,
      metric(),
      'none',
      true,
    );
    expect(stale[0]).toMatchObject({ used: null, note: 'Previous run hidden' });
  });

  it('links only node-scoped diagnostics and preserves their text', () => {
    const graph = createInitialGraph();
    const diagnostic: Diagnostic = {
      severity: 'error',
      message: '5 writes failed at the database queue (queue_overflow)',
      nodeId: 'db-1',
    };
    const evidence: CanvasEvidence = {
      mode: 'peak',
      stale: false,
      diagnosticsByNode: new Map([['db-1', [diagnostic]]]),
    };
    const nodes = toCanvasNodes(
      graph,
      new Map([
        [
          'db-1',
          metric({
            nodeId: 'db-1',
            busy: 0,
            maxQueued: 7,
            pressure: pressure({ failures: [{ code: 'queue_overflow', stage: 'dbQueue', count: 5 }] }),
          }),
        ],
      ]),
      evidence,
    );
    const db = nodes.find((node) => node.id === 'db-1');
    expect(db?.data.highlight).toBe('error');
    expect(db?.data.diagnostics).toEqual([diagnostic]);
    expect(db?.data.tooltip).toContain(
      '5 writes failed at the database queue (queue_overflow)',
    );
    expect(db?.data.tooltip).toContain('queue_overflow at dbQueue ×5');
    expect(db?.data.loadMode).toBe('peak');
    const client = nodes.find((node) => node.id === 'client-1');
    expect(client?.data.highlight).toBeNull();
    expect(client?.data.occupancy).toEqual([]);
  });

  it('keeps a true failure border when the average stays low', () => {
    const graph = createInitialGraph();
    const diagnostic: Diagnostic = {
      severity: 'error',
      message: '5 writes failed at the database queue (queue_overflow)',
      nodeId: 'db-1',
    };
    const nodes = toCanvasNodes(
      graph,
      new Map([
        [
          'db-1',
          metric({
            nodeId: 'db-1',
            maxQueued: 7,
            pressure: pressure({
              busyAvg: 0.5,
              busyPeak: 4,
              failures: [
                { code: 'queue_overflow', stage: 'dbQueue', count: 5 },
              ],
            }),
          }),
        ],
      ]),
      {
        mode: 'peak',
        stale: false,
        diagnosticsByNode: new Map([['db-1', [diagnostic]]]),
      },
    );
    const db = nodes.find((node) => node.id === 'db-1');
    expect(db?.data.occupancy[0]).toMatchObject({
      used: 0.5,
      average: 0.5,
      peak: 4,
      capacity: 4,
    });
    expect(db?.data.highlight).toBe('error');
    expect(db?.data.tooltip).toContain('Run average 0.5 of 4 slots');
    expect(db?.data.tooltip).toContain('Peak 4 of 4');
    expect(db?.data.tooltip).toContain(
      'peak alone does not show how long load was high',
    );
  });
});
