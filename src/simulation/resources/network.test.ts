import { describe, expect, it } from 'vitest';
import {
  EventScheduler,
  ResourceKernel,
  accountTransferBytes,
  buildNetworkTransferDemand,
  networkLanesForBandwidth,
  type TaskResult,
} from './index';

describe('network transfer adapter', () => {
  it('builds one shared 1 Gbit/s quantum per physical hop', () => {
    const demand = buildNetworkTransferDemand({
      bytes: 1_000_000,
      sourceNicId: 'src-nic',
      destinationNicId: 'dst-nic',
      linkIds: ['link-1', 'link-2'],
      accessIds: ['user-access'],
    });

    expect(demand.serviceDurationMs).toBe(8);
    expect(demand.lanesPerFlow).toBe(1);
    expect(demand.resources).toEqual([
      { id: 'src-nic', units: 1 },
      { id: 'link-1', units: 1 },
      { id: 'link-2', units: 1 },
      { id: 'dst-nic', units: 1 },
      { id: 'user-access', units: 1 },
    ]);
  });

  it('normalizes repeated physical ids and keeps propagation off the lane hold', () => {
    const demand = buildNetworkTransferDemand({
      bytes: 2_000_000,
      sourceNicId: 'nic',
      destinationNicId: 'nic',
      linkIds: ['link', 'link'],
      accessIds: ['nic', 'access'],
      propagationMs: 40,
    });

    expect(demand.resources.map((r) => r.id)).toEqual(['nic', 'link', 'access']);
    expect(demand.resources.every((r) => r.units === 1)).toBe(true);
    expect(demand.serviceDurationMs).toBe(16);
    expect(demand.propagationMs).toBe(40);
    expect(demand.totalDurationMs).toBe(56);
  });

  it('converts explicit bandwidth into lanes', () => {
    expect(networkLanesForBandwidth(1_000_000_000)).toBe(1);
    expect(networkLanesForBandwidth(10_000_000_000)).toBe(10);
    expect(networkLanesForBandwidth(100_000_000_000)).toBe(100);
    expect(networkLanesForBandwidth(500_000_000)).toBe(0.5);
  });

  it('accounts delivered and undelivered bytes from workFraction', () => {
    const accounting = accountTransferBytes(8_000_000, 0.25);
    expect(accounting.deliveredBytes).toBe(2_000_000);
    expect(accounting.undeliveredBytes).toBe(6_000_000);
    expect(accounting.workFraction).toBe(0.25);

    expect(accountTransferBytes(100, -1).deliveredBytes).toBe(0);
    expect(accountTransferBytes(100, 2).deliveredBytes).toBe(100);
  });

  it('keeps peak use within shared NIC capacity and replays deterministically', () => {
    const run = () => {
      const scheduler = new EventScheduler();
      const kernel = new ResourceKernel(scheduler, {
        windowStartMs: 0,
        windowEndMs: 1000,
      });
      kernel.registerResource({ id: 'src-nic', capacity: 10, kind: 'network' });
      kernel.registerResource({ id: 'link', capacity: 100, kind: 'network' });
      kernel.registerResource({ id: 'dst-nic', capacity: 100, kind: 'network' });
      const demand = buildNetworkTransferDemand({
        bytes: 1_000_000,
        sourceNicId: 'src-nic',
        destinationNicId: 'dst-nic',
        linkIds: ['link'],
      });
      const results: TaskResult[] = [];
      for (let index = 0; index < 20; index += 1) {
        kernel.submit({
          id: `flow-${index}`,
          resources: demand.resources,
          durationMs: demand.serviceDurationMs,
          onFinish: (result) => results.push(result),
        });
      }

      const initial = kernel.stats();
      expect(initial.activeTasks).toBe(10);
      expect(
        initial.resources.find((resource) => resource.id === 'src-nic')
          ?.busyUnits,
      ).toBe(10);

      scheduler.runUntil(1000);
      const final = kernel.stats();
      expect(final.completedTasks).toBe(20);
      expect(
        final.resources.find((resource) => resource.id === 'src-nic')
          ?.peakBusyUnits,
      ).toBe(10);
      expect(
        final.resources.find((resource) => resource.id === 'link')
          ?.peakBusyUnits,
      ).toBe(10);
      return results.map((result) => [
        result.taskId,
        result.startedAtMs,
        result.endedAtMs,
      ]);
    };

    const first = run();
    expect(run()).toEqual(first);
    expect(first.filter((entry) => entry[1] === 0)).toHaveLength(10);
  });

  it('makes a second logical flow share the same physical NIC', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 100,
    });
    kernel.registerResource({ id: 'nic', capacity: 1, kind: 'network' });
    kernel.registerResource({ id: 'link', capacity: 100, kind: 'network' });
    kernel.registerResource({ id: 'dst', capacity: 100, kind: 'network' });
    const demand = buildNetworkTransferDemand({
      bytes: 1_000_000,
      sourceNicId: 'nic',
      destinationNicId: 'dst',
      linkIds: ['link'],
    });
    const results: TaskResult[] = [];

    const first = kernel.submit({
      id: 'first',
      resources: demand.resources,
      durationMs: demand.serviceDurationMs,
      onFinish: (result) => results.push(result),
    });
    const second = kernel.submit({
      id: 'second',
      resources: demand.resources,
      durationMs: demand.serviceDurationMs,
      onFinish: (result) => results.push(result),
    });

    scheduler.runUntil(100);
    expect(first.result?.startedAtMs).toBe(0);
    expect(first.result?.endedAtMs).toBe(8);
    expect(second.result?.startedAtMs).toBe(8);
    expect(second.result?.endedAtMs).toBe(16);
    expect(results).toHaveLength(2);
  });

  it('serializes a fan-out through one end-user access lane', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 200,
    });
    kernel.registerResource({ id: 'access', capacity: 1, kind: 'network' });
    kernel.registerResource({ id: 'nic', capacity: 100, kind: 'network' });
    kernel.registerResource({ id: 'link', capacity: 100, kind: 'network' });
    kernel.registerResource({ id: 'dst', capacity: 100, kind: 'network' });
    const demand = buildNetworkTransferDemand({
      bytes: 1_000_000,
      sourceNicId: 'nic',
      destinationNicId: 'dst',
      linkIds: ['link'],
      accessIds: ['access'],
    });
    const results: TaskResult[] = [];

    for (let index = 0; index < 10; index += 1) {
      kernel.submit({
        id: `child-${index}`,
        resources: demand.resources,
        durationMs: demand.serviceDurationMs,
        onFinish: (result) => results.push(result),
      });
    }

    scheduler.runUntil(200);
    const byId = new Map(results.map((result) => [result.taskId, result]));
    for (let index = 0; index < 10; index += 1) {
      const result = byId.get(`child-${index}`);
      expect(result?.startedAtMs).toBe(index * 8);
      expect(result?.endedAtMs).toBe((index + 1) * 8);
    }

    const final = kernel.stats();
    expect(final.resources.find((resource) => resource.id === 'access')?.peakBusyUnits).toBe(1);
    expect(final.resources.find((resource) => resource.id === 'nic')?.peakBusyUnits).toBe(1);
    expect(final.completedTasks).toBe(10);
  });

  it('uses 100 lanes for a 100 Gbit/s regional link instead of one lane', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 100,
    });
    const regionalLanes = networkLanesForBandwidth(100_000_000_000);
    expect(regionalLanes).toBe(100);
    kernel.registerResource({
      id: 'regional',
      capacity: regionalLanes,
      kind: 'network',
    });
    kernel.registerResource({ id: 'src', capacity: 1000, kind: 'network' });
    kernel.registerResource({ id: 'dst', capacity: 1000, kind: 'network' });

    const demand = buildNetworkTransferDemand({
      bytes: 1_000_000,
      sourceNicId: 'src',
      destinationNicId: 'dst',
      linkIds: ['regional'],
    });
    const results: TaskResult[] = [];
    for (let index = 0; index < 50; index += 1) {
      kernel.submit({
        id: `flow-${index}`,
        resources: demand.resources,
        durationMs: demand.serviceDurationMs,
        onFinish: (result) => results.push(result),
      });
    }

    const initial = kernel.stats();
    expect(initial.activeTasks).toBe(50);
    expect(
      initial.resources.find((resource) => resource.id === 'regional')
        ?.busyUnits,
    ).toBe(50);

    scheduler.runUntil(100);
    const final = kernel.stats();
    const regional = final.resources.find((resource) => resource.id === 'regional');
    expect(regional?.peakBusyUnits).toBe(50);
    expect(regional?.peakBusyUnits).toBeGreaterThan(1);
    expect(regional?.peakBusyUnits).toBeLessThanOrEqual(100);
    expect(final.completedTasks).toBe(50);
  });
});
