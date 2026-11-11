import { describe, expect, it } from 'vitest';

import type { TrafficNode } from '../../simulation/traffic-telemetry';
import {
  buildTrafficActivity,
  buildTrafficEdgeView,
  buildTrafficMeterRows,
  formatTrafficRate,
  trafficLoadBand,
} from './traffic-ui';

const parcelNode: TrafficNode = {
  nodeId: 'app-1',
  resources: [
    {
      key: 'cpu',
      label: 'CPU',
      used: 1,
      capacity: 4,
      unit: 'cores',
      aggregation: 'window-average',
    },
    {
      key: 'io',
      label: 'IO',
      used: null,
      capacity: 100,
      unit: 'lanes',
      aggregation: 'instant',
    },
    {
      key: 'egress',
      label: 'Egress',
      used: 3,
      capacity: null,
      unit: 'gbit/s',
      aggregation: 'window-average',
    },
  ],
  requestsPerSecond: 25,
  queue: 2,
  down: false,
};

describe('shared traffic UI model', () => {
  it('uses the disclosed five bands', () => {
    expect(trafficLoadBand(null)).toBeNull();
    expect(trafficLoadBand(0.49)).toBe('green');
    expect(trafficLoadBand(0.5)).toBe('yellow');
    expect(trafficLoadBand(0.7)).toBe('orange');
    expect(trafficLoadBand(0.85)).toBe('red');
    expect(trafficLoadBand(1)).toBe('dark-red');
  });

  it('keeps neutral dashed rows before telemetry instead of inventing zero', () => {
    const rows = buildTrafficMeterRows('parcel-pulse', 'app', null);
    expect(rows.map((row) => row.label)).toEqual(['CPU', 'IO', 'Net']);
    for (const row of rows) {
      expect(row.placeholder).toBe(true);
      expect(row.valueText).toBe('—');
      expect(row.fraction).toBeNull();
      expect(row.accessible).toContain('unknown, not a measured zero');
    }
  });

  it('shows units, aggregation and no capacity percentage only when defined', () => {
    const rows = buildTrafficMeterRows('parcel-pulse', 'app', parcelNode);
    const cpu = rows.find((row) => row.label === 'CPU');
    const io = rows.find((row) => row.label === 'IO');
    const net = rows.find((row) => row.label === 'Egress');

    expect(cpu?.valueText).toBe('25%');
    expect(cpu?.band).toBe('green');
    expect(cpu?.accessible).toContain('Sampled as an interval average');
    expect(io?.valueText).toBe('—');
    expect(io?.accessible).toContain('instant value');
    expect(net?.valueText).toBe('3.00 Gbit/s');
    expect(net?.secondaryText).toBe('no finite capacity');
    expect(net?.accessible).toContain('no utilization percentage');
  });

  it('describes client/provider activity without inventing CPU capacity', () => {
    const activity = buildTrafficActivity(parcelNode);
    expect(activity.state).toBe('active');
    expect(activity.text).toBe('25 req/s');
    expect(activity.title).toContain('including attempts that may fail');
    expect(activity.queueText).toBe('queue 2');

    expect(buildTrafficActivity(null).state).toBe('unknown');
    expect(
      buildTrafficActivity({
        ...parcelNode,
        requestsPerSecond: 0,
      }).state,
    ).toBe('idle');
    expect(
      buildTrafficActivity({
        ...parcelNode,
        down: true,
      }).state,
    ).toBe('down');
    expect(formatTrafficRate(1_250)).toBe('1,250 req/s');
  });

  it('keeps expected rows for client and provider network activity', () => {
    expect(
      buildTrafficMeterRows('image-atlas', 'client', null).map((row) => row.label),
    ).toEqual(['Net']);
    expect(
      buildTrafficMeterRows('image-atlas', 'app', null).map((row) => row.label),
    ).toEqual(['CPU', 'RAM', 'IO', 'Net']);
  });

  it('encodes edge activity without claiming packet counts', () => {
    const view = buildTrafficEdgeView({
      edge: {
        edgeId: 'route-1',
        requestsPerSecond: 42,
        bytesPerSecond: 12_500_000_000,
      },
      frame: {
        levelId: 'parcel-pulse',
        scopeId: 'year-1',
        scopeLabel: 'Year 1',
        timeMs: 1_000,
        windowMs: 1_000,
        phase: 'measured',
        nodes: [],
        edges: [],
      },
      modeLabel: 'Live · Year 1 · t=1.0 s',
      animate: true,
      reducedMotion: false,
    });
    expect(view?.active).toBe(true);
    expect(view?.animate).toBe(true);
    expect(view?.title).toContain('logical dispatches');
    expect(view?.title).toContain('not successful throughput');

    const reduced = buildTrafficEdgeView({
      edge: {
        edgeId: 'route-1',
        requestsPerSecond: 42,
        bytesPerSecond: null,
      },
      frame: null,
      modeLabel: 'Replay paused',
      animate: true,
      reducedMotion: true,
    });
    expect(reduced?.active).toBe(true);
    expect(reduced?.animate).toBe(false);
  });
});
