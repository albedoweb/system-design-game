import { describe, expect, it } from 'vitest';
import {
  EventScheduler,
  ResourceKernel,
  type ResourceRequirement,
  type TaskResult,
} from './index';

function finishedById(results: readonly TaskResult[]): Map<string, TaskResult> {
  const map = new Map<string, TaskResult>();
  for (const result of results) {
    map.set(result.taskId, result);
  }
  return map;
}

describe('ResourceKernel', () => {
  it.each([0, 10])('allows zero work to complete at its exact deadline after waiting %i ms', (waitMs) => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0, windowEndMs: 30,
    });
    kernel.registerResource({ id: 'cpu', capacity: 1, kind: 'cpu' });
    if (waitMs > 0) {
      kernel.submit({
        id: 'occupant', resources: [{ id: 'cpu', units: 1 }],
        durationMs: waitMs, onFinish: () => {},
      });
    }
    const results: TaskResult[] = [];
    kernel.submit({
      id: 'zero-work', resources: [{ id: 'cpu', units: 1 }],
      durationMs: 0, deadlineMs: waitMs, onFinish: (result) => results.push(result),
    });
    scheduler.runUntil(30);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: 'completed', startedAtMs: waitMs, endedAtMs: waitMs, workFraction: 1,
    });
    expect(kernel.stats().activeTasks).toBe(0);
    expect(kernel.stats().queuedTasks).toBe(0);
  });

  it('does not allocate an expired waiter when another task completes at its deadline', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 30,
    });
    kernel.registerResource({ id: 'cpu', capacity: 10, kind: 'cpu' });
    const results: TaskResult[] = [];
    const onFinish = (result: TaskResult) => results.push(result);
    kernel.submit({ id: 'running', resources: [{ id: 'cpu', units: 1 }], durationMs: 10, onFinish });
    kernel.submit({ id: 'expired', resources: [{ id: 'cpu', units: 10 }], durationMs: 5, deadlineMs: 10, onFinish });
    kernel.submit({ id: 'following', resources: [{ id: 'cpu', units: 1 }], durationMs: 5, deadlineMs: 30, onFinish });

    scheduler.runUntil(30);

    const byId = finishedById(results);
    expect(byId.get('expired')).toMatchObject({
      status: 'timeout', startedAtMs: null, endedAtMs: 10, workFraction: 0,
    });
    expect(byId.get('following')).toMatchObject({
      status: 'completed', startedAtMs: 10, endedAtMs: 15,
    });
    expect(results).toHaveLength(3);
    expect(kernel.stats().resources[0]?.peakBusyUnits).toBe(1);
    expect(kernel.stats().activeTasks).toBe(0);
    expect(kernel.stats().queuedTasks).toBe(0);
  });

  it('serializes one shared resource and overlaps independent resources', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 100,
    });
    kernel.registerResource({ id: 'cpu', capacity: 1, kind: 'cpu' });
    kernel.registerResource({ id: 'io', capacity: 1, kind: 'io' });

    const results: TaskResult[] = [];
    const submit = (id: string, resourceId: string, durationMs: number) =>
      kernel.submit({
        id,
        resources: [{ id: resourceId, units: 1 }],
        durationMs,
        onFinish: (result) => results.push(result),
      });

    const a = submit('a', 'cpu', 10);
    submit('b', 'cpu', 10);
    const c = submit('c', 'io', 10);

    const initial = kernel.stats();
    expect(initial.activeTasks).toBe(2);
    expect(initial.queuedTasks).toBe(1);
    expect(initial.resources.find((r) => r.id === 'cpu')?.busyUnits).toBe(1);
    expect(initial.resources.find((r) => r.id === 'io')?.busyUnits).toBe(1);

    scheduler.runUntil(100);

    const byId = finishedById(results);
    expect(a.result?.status).toBe('completed');
    expect(c.result?.status).toBe('completed');
    expect(byId.get('a')?.endedAtMs).toBe(10);
    expect(byId.get('c')?.endedAtMs).toBe(10);
    expect(byId.get('b')?.startedAtMs).toBe(10);
    expect(byId.get('b')?.endedAtMs).toBe(20);

    const final = kernel.stats();
    expect(final.completedTasks).toBe(3);
    expect(final.activeTasks).toBe(0);
    expect(final.resources.find((r) => r.id === 'cpu')?.peakBusyUnits).toBe(1);
    expect(final.resources.find((r) => r.id === 'io')?.peakBusyUnits).toBe(1);
  });

  it('acquires all required resources atomically, never partially', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 100,
    });
    kernel.registerResource({ id: 'a', capacity: 1, kind: 'test' });
    kernel.registerResource({ id: 'b', capacity: 1, kind: 'test' });

    const results: TaskResult[] = [];
    const submit = (id: string, resources: ResourceRequirement[], durationMs: number) =>
      kernel.submit({
        id,
        resources,
        durationMs,
        onFinish: (result) => results.push(result),
      });

    const x = submit('x', [{ id: 'a', units: 1 }], 10);
    const y = submit(
      'y',
      [
        { id: 'a', units: 1 },
        { id: 'b', units: 1 },
      ],
      5,
    );

    scheduler.runUntil(5);
    const waiting = kernel.stats();
    expect(waiting.resources.find((r) => r.id === 'a')?.busyUnits).toBe(1);
    expect(waiting.resources.find((r) => r.id === 'b')?.busyUnits).toBe(0);
    expect(x.result).toBeUndefined();
    expect(y.result).toBeUndefined();

    scheduler.runUntil(10);
    const acquired = kernel.stats();
    expect(acquired.resources.find((r) => r.id === 'a')?.busyUnits).toBe(1);
    expect(acquired.resources.find((r) => r.id === 'b')?.busyUnits).toBe(1);

    scheduler.runUntil(100);
    expect(finishedById(results).get('x')?.status).toBe('completed');
    expect(finishedById(results).get('y')?.status).toBe('completed');
    const final = kernel.stats();
    for (const resource of final.resources) {
      expect(resource.busyUnits).toBe(0);
      expect(resource.peakBusyUnits).toBeLessThanOrEqual(
        resource.nominalCapacity + 1e-9,
      );
    }
  });

  it('expires a queued deadline without starting the task', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 200,
    });
    kernel.registerResource({ id: 'r', capacity: 1, kind: 'test' });
    const results: TaskResult[] = [];

    const blocker = kernel.submit({
      id: 'blocker',
      resources: [{ id: 'r', units: 1 }],
      durationMs: 100,
      onFinish: (result) => results.push(result),
    });
    const waiting = kernel.submit({
      id: 'waiting',
      resources: [{ id: 'r', units: 1 }],
      durationMs: 10,
      deadlineMs: 20,
      onFinish: (result) => results.push(result),
    });

    scheduler.runUntil(30);
    const expired = waiting.result;
    expect(expired?.status).toBe('timeout');
    expect(expired?.reason).toBe('deadline-exceeded');
    expect(expired?.startedAtMs).toBeNull();
    expect(expired?.endedAtMs).toBe(20);
    expect(expired?.workFraction).toBe(0);
    expect(blocker.result).toBeUndefined();
    expect(kernel.stats().timedOutTasks).toBe(1);
    expect(kernel.stats().activeTasks).toBe(1);

    scheduler.runUntil(200);
    expect(blocker.result?.status).toBe('completed');
    expect(results.filter((r) => r.taskId === 'waiting')).toHaveLength(1);
  });

  it('interrupts active work at its deadline with partial work', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 200,
    });
    kernel.registerResource({ id: 'r', capacity: 1, kind: 'test' });
    const results: TaskResult[] = [];

    const timed = kernel.submit({
      id: 'timed',
      resources: [{ id: 'r', units: 1 }],
      durationMs: 100,
      deadlineMs: 30,
      onFinish: (result) => results.push(result),
    });
    const next = kernel.submit({
      id: 'next',
      resources: [{ id: 'r', units: 1 }],
      durationMs: 10,
      deadlineMs: 100,
      onFinish: (result) => results.push(result),
    });

    scheduler.runUntil(50);
    const timeout = timed.result;
    expect(timeout?.status).toBe('timeout');
    expect(timeout?.startedAtMs).toBe(0);
    expect(timeout?.endedAtMs).toBe(30);
    expect(timeout?.workFraction).toBeCloseTo(0.3, 12);
    expect(next.result?.status).toBe('completed');
    expect(next.result?.startedAtMs).toBe(30);
    expect(next.result?.endedAtMs).toBe(40);
  });

  it('prefers completion when completion and deadline share a timestamp', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 100,
    });
    kernel.registerResource({ id: 'r', capacity: 1, kind: 'test' });
    const results: TaskResult[] = [];

    const exact = kernel.submit({
      id: 'exact',
      resources: [{ id: 'r', units: 1 }],
      durationMs: 30,
      deadlineMs: 30,
      onFinish: (result) => results.push(result),
    });

    scheduler.runUntil(30);
    expect(exact.result?.status).toBe('completed');
    expect(exact.result?.endedAtMs).toBe(30);
    expect(exact.result?.workFraction).toBe(1);
    expect(kernel.stats().timedOutTasks).toBe(0);
  });

  it('faults only affected active work, keeps queued work and recovers', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 300,
    });
    kernel.registerResource({ id: 'cpu', capacity: 2, kind: 'cpu' });
    kernel.registerResource({ id: 'io', capacity: 1, kind: 'io' });
    const results: TaskResult[] = [];

    const submit = (
      id: string,
      resourceId: string,
      durationMs: number,
      deadlineMs?: number,
    ) =>
      kernel.submit({
        id,
        resources: [{ id: resourceId, units: 1 }],
        durationMs,
        deadlineMs,
        onFinish: (result) => results.push(result),
      });

    const a = submit('a', 'cpu', 100);
    const b = submit('b', 'cpu', 100);
    const c = submit('c', 'io', 100);
    const e = submit('e', 'cpu', 10, 40);

    scheduler.schedule(20, () => kernel.setAvailable('cpu', false));
    scheduler.runUntil(20);

    const duringOutage = kernel.stats();
    const cpu = duringOutage.resources.find((r) => r.id === 'cpu');
    expect(cpu?.available).toBe(false);
    expect(cpu?.availableCapacity).toBe(0);
    expect(cpu?.nominalCapacity).toBe(2);
    expect(cpu?.busyUnits).toBe(0);
    expect(duringOutage.resourceUnavailableInterruptions).toBe(2);
    expect(duringOutage.interruptedTasks).toBe(2);
    expect(duringOutage.queuedTasks).toBe(1);
    expect(c.result).toBeUndefined();
    expect(e.result).toBeUndefined();

    const queued = submit('d', 'cpu', 10, 300);
    expect(queued.accepted).toBe(true);

    scheduler.schedule(50, () => kernel.setAvailable('cpu', true));
    scheduler.runUntil(200);

    expect(a.result?.status).toBe('interrupted');
    expect(a.result?.reason).toBe('resource-unavailable');
    expect(a.result?.workFraction).toBeCloseTo(0.2, 12);
    expect(b.result?.status).toBe('interrupted');
    expect(c.result?.status).toBe('completed');
    expect(c.result?.workFraction).toBe(1);
    expect(queued.result?.status).toBe('completed');
    expect(queued.result?.startedAtMs).toBe(50);
    expect(queued.result?.endedAtMs).toBe(60);
    expect(e.result?.status).toBe('timeout');
    expect(e.result?.startedAtMs).toBeNull();
    expect(e.result?.endedAtMs).toBe(40);

    const final = kernel.stats();
    expect(final.completedTasks).toBe(2);
    expect(final.interruptedTasks).toBe(2);
    expect(final.timedOutTasks).toBe(1);
    expect(final.activeTasks).toBe(0);
    expect(final.queuedTasks).toBe(0);
    expect(final.resources.find((r) => r.id === 'cpu')?.busyUnits).toBe(0);
    expect(results).toHaveLength(5);
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      expect(results.filter((r) => r.taskId === id)).toHaveLength(1);
    }
  });

  it('cancels queued and active tasks, frees once and starts the next waiter', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 300,
    });
    kernel.registerResource({ id: 'r', capacity: 1, kind: 'test' });
    const results: TaskResult[] = [];

    const submit = (id: string, durationMs: number) =>
      kernel.submit({
        id,
        resources: [{ id: 'r', units: 1 }],
        durationMs,
        onFinish: (result) => results.push(result),
      });

    const a = submit('a', 100);
    const b = submit('b', 10);
    submit('c', 5);

    scheduler.schedule(5, () => {
      expect(b.cancel()).toBe(true);
      expect(b.cancel()).toBe(false);
    });
    scheduler.schedule(20, () => {
      expect(a.cancel()).toBe(true);
    });
    scheduler.runUntil(300);

    const byId = finishedById(results);
    expect(byId.get('b')?.status).toBe('interrupted');
    expect(byId.get('b')?.reason).toBe('cancelled');
    expect(byId.get('b')?.startedAtMs).toBeNull();
    expect(byId.get('b')?.endedAtMs).toBe(5);
    expect(byId.get('a')?.status).toBe('interrupted');
    expect(byId.get('a')?.workFraction).toBeCloseTo(0.2, 12);
    expect(byId.get('a')?.endedAtMs).toBe(20);
    expect(byId.get('c')?.status).toBe('completed');
    expect(byId.get('c')?.startedAtMs).toBe(20);
    expect(byId.get('c')?.endedAtMs).toBe(25);

    const final = kernel.stats();
    expect(final.cancelledTasks).toBe(2);
    expect(final.interruptedTasks).toBe(2);
    expect(final.completedTasks).toBe(1);
    expect(final.resources[0]?.busyUnits).toBe(0);
    expect(results).toHaveLength(3);
  });

  it('ignores stale completion events after an interruption', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 500,
    });
    kernel.registerResource({ id: 'r', capacity: 1, kind: 'test' });
    const results: TaskResult[] = [];

    const task = kernel.submit({
      id: 'task',
      resources: [{ id: 'r', units: 1 }],
      durationMs: 100,
      onFinish: (result) => results.push(result),
    });

    scheduler.schedule(10, () => kernel.setAvailable('r', false));
    scheduler.runUntil(500);

    expect(task.result?.status).toBe('interrupted');
    expect(task.result?.endedAtMs).toBe(10);
    expect(task.result?.workFraction).toBeCloseTo(0.1, 12);
    expect(results).toHaveLength(1);
    const resource = kernel.stats().resources[0];
    expect(resource?.busyUnits).toBe(0);
    expect(resource?.peakBusyUnits).toBe(1);
    expect(kernel.stats().completedTasks).toBe(0);
  });

  it('excludes post-window drain from observation-window averages', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 100,
    });
    kernel.registerResource({ id: 'r', capacity: 1, kind: 'test' });
    const results: TaskResult[] = [];

    const task = kernel.submit({
      id: 'long',
      resources: [{ id: 'r', units: 1 }],
      durationMs: 200,
      onFinish: (result) => results.push(result),
    });

    scheduler.runUntil(50);
    const halfway = kernel.stats();
    expect(halfway.totalBusyUnitMs).toBeCloseTo(50, 9);
    expect(halfway.averageTotalBusyUnits).toBeCloseTo(0.5, 9);

    scheduler.runUntil(250);
    expect(task.result?.status).toBe('completed');
    const drained = kernel.stats();
    expect(drained.totalBusyUnitMs).toBeCloseTo(100, 9);
    expect(drained.averageTotalBusyUnits).toBeCloseTo(1, 9);
    expect(drained.resources[0]?.averageBusyUnits).toBeCloseTo(1, 9);
    expect(drained.completedTasks).toBe(1);
  });

  it('records deterministic FIFO start order and queue wait', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 100,
    });
    kernel.registerResource({ id: 'r', capacity: 1, kind: 'test' });
    const results: TaskResult[] = [];

    for (const id of ['a', 'b', 'c']) {
      kernel.submit({
        id,
        resources: [{ id: 'r', units: 1 }],
        durationMs: 10,
        onFinish: (result) => results.push(result),
      });
    }

    scheduler.runUntil(100);
    expect(results.map((r) => r.taskId)).toEqual(['a', 'b', 'c']);
    expect(results.map((r) => r.startedAtMs)).toEqual([0, 10, 20]);
    expect(results.map((r) => r.endedAtMs)).toEqual([10, 20, 30]);

    const stats = kernel.stats();
    expect(stats.queueWaitMsTotal).toBe(30);
    expect(stats.queueWaitMsMax).toBe(20);
    expect(stats.queueWaitSamples).toBe(3);
    expect(stats.queueWaitMsAverage).toBe(10);
  });

  it('rejects duplicate ids, duplicate requirements, unknown resources, invalid units and over-capacity demand', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 100,
    });
    kernel.registerResource({ id: 'r', capacity: 2, kind: 'test' });
    const results: TaskResult[] = [];

    const submit = (id: string, resources: ResourceRequirement[]) =>
      kernel.submit({
        id,
        resources,
        durationMs: 10,
        onFinish: (result) => results.push(result),
      });

    const first = submit('same', [{ id: 'r', units: 1 }]);
    expect(first.accepted).toBe(true);

    const duplicateId = submit('same', [{ id: 'r', units: 1 }]);
    expect(duplicateId.accepted).toBe(false);
    expect(duplicateId.result?.reason).toBe('duplicate-task-id');

    const duplicateRequirement = submit('duplicate-resource', [
      { id: 'r', units: 1 },
      { id: 'r', units: 1 },
    ]);
    expect(duplicateRequirement.result?.reason).toBe('duplicate-resource-id');

    const unknown = submit('unknown', [{ id: 'nope', units: 1 }]);
    expect(unknown.result?.reason).toBe('unknown-resource');

    const invalidUnits = submit('invalid-units', [{ id: 'r', units: 0 }]);
    expect(invalidUnits.result?.reason).toBe('invalid-units');

    const tooLarge = submit('too-large', [{ id: 'r', units: 3 }]);
    expect(tooLarge.result?.reason).toBe('capacity-exceeded');

    expect(kernel.stats().rejectedTasks).toBe(5);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(results).toHaveLength(5);
    expect(() => kernel.registerResource({ id: 'r', capacity: 1, kind: 'x' })).toThrow(
      /already registered/,
    );
  });

  it('enforces the configured hard queued-task limit', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 100,
      maxQueuedTasks: 1,
    });
    kernel.registerResource({ id: 'r', capacity: 1, kind: 'test' });
    kernel.registerResource({ id: 'free', capacity: 1, kind: 'test' });
    const results: TaskResult[] = [];

    const active = kernel.submit({
      id: 'active',
      resources: [{ id: 'r', units: 1 }],
      durationMs: 100,
      onFinish: (result) => results.push(result),
    });
    const queued = kernel.submit({
      id: 'queued',
      resources: [{ id: 'r', units: 1 }],
      durationMs: 10,
      onFinish: (result) => results.push(result),
    });
    const rejectedByBacklog = kernel.submit({
      id: 'backlog',
      resources: [{ id: 'free', units: 1 }],
      durationMs: 10,
      onFinish: (result) => results.push(result),
    });

    expect(active.accepted).toBe(true);
    expect(queued.accepted).toBe(true);
    expect(rejectedByBacklog.accepted).toBe(false);
    expect(rejectedByBacklog.result?.reason).toBe('queue-full');

    scheduler.runUntil(200);
    expect(active.result?.status).toBe('completed');
    expect(queued.result?.status).toBe('completed');
  });

  it('notifies onStart exactly once for immediate and queued starts, never for rejections', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 100,
    });
    kernel.registerResource({ id: 'r', capacity: 1, kind: 'test' });
    const starts: string[] = [];
    const finishes: string[] = [];
    const finish = (result: TaskResult): void => {
      finishes.push(`${result.taskId}:${result.status}`);
    };

    kernel.submit({
      id: 'a',
      resources: [{ id: 'r', units: 1 }],
      durationMs: 10,
      onStart: (startedAtMs) => starts.push(`a:${startedAtMs}`),
      onFinish: finish,
    });
    kernel.submit({
      id: 'b',
      resources: [{ id: 'r', units: 1 }],
      durationMs: 10,
      onStart: (startedAtMs) => starts.push(`b:${startedAtMs}`),
      onFinish: finish,
    });
    const rejected = kernel.submit({
      id: 'never',
      resources: [{ id: 'r', units: 5 }],
      durationMs: 10,
      onStart: () => starts.push('never'),
      onFinish: finish,
    });

    expect(rejected.result?.status).toBe('rejected');
    scheduler.runUntil(100);
    expect(starts).toEqual(['a:0', 'b:10']);
    // The rejected submission reports synchronously inside submit().
    expect(finishes).toEqual(['never:rejected', 'a:completed', 'b:completed']);
  });

  it('does not notify onStart for a queued timeout or cancellation', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 300,
    });
    kernel.registerResource({ id: 'r', capacity: 1, kind: 'test' });
    const starts: string[] = [];
    const results: TaskResult[] = [];

    kernel.submit({
      id: 'blocker',
      resources: [{ id: 'r', units: 1 }],
      durationMs: 200,
      onFinish: () => {},
    });
    kernel.submit({
      id: 'expires',
      resources: [{ id: 'r', units: 1 }],
      durationMs: 10,
      deadlineMs: 20,
      onStart: () => starts.push('expires'),
      onFinish: (result) => results.push(result),
    });
    const cancelled = kernel.submit({
      id: 'cancelled',
      resources: [{ id: 'r', units: 1 }],
      durationMs: 10,
      onStart: () => starts.push('cancelled'),
      onFinish: (result) => results.push(result),
    });

    scheduler.schedule(40, () => {
      expect(cancelled.cancel()).toBe(true);
    });
    scheduler.runUntil(300);

    const byId = finishedById(results);
    expect(byId.get('expires')).toMatchObject({
      status: 'timeout',
      startedAtMs: null,
      endedAtMs: 20,
    });
    expect(byId.get('cancelled')).toMatchObject({
      status: 'interrupted',
      reason: 'cancelled',
      startedAtMs: null,
      endedAtMs: 40,
    });
    expect(starts).toEqual([]);
  });

  it('prevents kernel mutation from onStart without changing accounting', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 100,
    });
    kernel.registerResource({ id: 'r', capacity: 1, kind: 'test' });
    kernel.registerResource({ id: 'free', capacity: 1, kind: 'test' });
    const starts: string[] = [];
    const mutationErrors: string[] = [];
    let innerFinished = 0;

    kernel.submit({
      id: 'outer',
      resources: [{ id: 'r', units: 1 }],
      durationMs: 10,
      onStart: () => {
        starts.push('outer');
        const attempts: [string, () => unknown][] = [
          ['cancel', () => kernel.cancelTask('outer')],
          [
            'submit',
            () =>
              kernel.submit({
                id: 'inner',
                resources: [{ id: 'free', units: 1 }],
                durationMs: 5,
                onFinish: () => {
                  innerFinished += 1;
                },
              }),
          ],
          ['outage', () => kernel.setAvailable('free', false)],
        ];
        for (const [name, attempt] of attempts) {
          try {
            attempt();
            mutationErrors.push(`${name}:allowed`);
          } catch (error) {
            mutationErrors.push(`${name}:${error instanceof Error ? error.message : String(error)}`);
          }
        }
        throw new Error('observer failure must not escape');
      },
      onFinish: () => {},
    });

    expect(() => scheduler.runUntil(100)).not.toThrow();
    expect(starts).toEqual(['outer']);
    expect(mutationErrors).toHaveLength(3);
    for (const message of mutationErrors) {
      expect(message).toMatch(/not allowed during onStart observation/);
    }
    expect(innerFinished).toBe(0);
    const stats = kernel.stats();
    expect(stats.completedTasks).toBe(1);
    expect(stats.activeTasks).toBe(0);
    expect(stats.queuedTasks).toBe(0);
    expect(stats.resources.find((row) => row.id === 'free')?.available).toBe(true);
  });

  it('starts a zero-resource task exactly once', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 10,
    });
    const results: TaskResult[] = [];
    const task = kernel.submit({
      id: 'empty',
      resources: [],
      durationMs: 5,
      onFinish: (result) => results.push(result),
    });

    expect(kernel.stats().activeTasks).toBe(1);
    scheduler.runUntil(10);
    expect(task.result?.status).toBe('completed');
    expect(task.result?.startedAtMs).toBe(0);
    expect(task.result?.endedAtMs).toBe(5);
    expect(results).toHaveLength(1);
  });

  it('reports an exhausted event budget explicitly instead of dropping kernel work', () => {
    const scheduler = new EventScheduler();
    const kernel = new ResourceKernel(scheduler, {
      windowStartMs: 0,
      windowEndMs: 100,
    });
    kernel.registerResource({ id: 'r', capacity: 1, kind: 'test' });
    const results: TaskResult[] = [];
    for (const id of ['a', 'b', 'c']) {
      kernel.submit({
        id,
        resources: [{ id: 'r', units: 1 }],
        durationMs: 10,
        onFinish: (result) => results.push(result),
      });
    }

    const first = scheduler.runUntil(100, 1);
    expect(first.exhausted).toBe(true);
    expect(scheduler.exhausted).toBe(true);
    const partial = kernel.stats();
    expect(partial.completedTasks).toBe(1);
    expect(partial.activeTasks).toBe(1);
    expect(partial.queuedTasks).toBe(1);

    const second = scheduler.runUntil(100);
    expect(second.exhausted).toBe(false);
    const final = kernel.stats();
    expect(final.completedTasks).toBe(3);
    expect(final.activeTasks).toBe(0);
    expect(final.queuedTasks).toBe(0);
    expect(results).toHaveLength(3);
  });
});
