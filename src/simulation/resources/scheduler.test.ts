import { describe, expect, it } from 'vitest';
import { EventScheduler } from './index';

describe('EventScheduler', () => {
  it('orders equal-time events by priority then insertion order', () => {
    const scheduler = new EventScheduler();
    const log: string[] = [];

    scheduler.schedule(10, () => log.push('default-a'));
    scheduler.schedule(10, () => log.push('early'), -1);
    scheduler.schedule(10, () => log.push('default-b'));
    scheduler.schedule(10, () => log.push('late'), 1);

    const result = scheduler.runUntil(10);
    expect(log).toEqual(['early', 'default-a', 'default-b', 'late']);
    expect(result.processedEvents).toBe(4);
    expect(result.totalProcessedEvents).toBe(4);
    expect(result.exhausted).toBe(false);
    expect(result.nowMs).toBe(10);
  });

  it('keeps nested schedules deterministic', () => {
    const scheduler = new EventScheduler();
    const log: string[] = [];

    scheduler.schedule(5, () => {
      log.push('a');
      scheduler.schedule(5, () => log.push('d'));
    });
    scheduler.schedule(5, () => log.push('b'));
    scheduler.schedule(5, () => log.push('c'));

    scheduler.runUntil(5);
    expect(log).toEqual(['a', 'b', 'c', 'd']);
  });

  it('rejects events in the past and non-finite times', () => {
    const scheduler = new EventScheduler();
    scheduler.runUntil(10);

    expect(() => scheduler.schedule(9, () => undefined)).toThrow(RangeError);
    expect(() => scheduler.schedule(Number.NaN, () => undefined)).toThrow(
      RangeError,
    );
    expect(() => scheduler.runUntil(Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
    expect(() => scheduler.runUntil(9)).toThrow(RangeError);
  });

  it('cancels stale work without invoking it and releases the event', () => {
    const scheduler = new EventScheduler();
    const log: string[] = [];

    const first = scheduler.schedule(5, () => log.push('first'));
    scheduler.schedule(6, () => log.push('second'));

    expect(first.cancel()).toBe(true);
    expect(first.cancelled).toBe(true);
    expect(first.cancel()).toBe(false);
    expect(scheduler.pendingEvents).toBe(1);

    scheduler.runUntil(10);
    expect(log).toEqual(['second']);
    expect(first.ran).toBe(false);
    expect(first.cancel()).toBe(false);
    expect(scheduler.processedEvents).toBe(1);
  });

  it('stops explicitly on the event budget and can resume', () => {
    const scheduler = new EventScheduler();
    const log: number[] = [];
    scheduler.schedule(1, () => log.push(1));
    scheduler.schedule(1, () => log.push(2));
    scheduler.schedule(1, () => log.push(3));

    const first = scheduler.runUntil(10, 2);
    expect(first.exhausted).toBe(true);
    expect(first.processedEvents).toBe(2);
    expect(first.nowMs).toBe(1);
    expect(first.remainingEvents).toBe(1);
    expect(scheduler.exhausted).toBe(true);
    expect(scheduler.processedEvents).toBe(2);

    const second = scheduler.runUntil(10);
    expect(second.exhausted).toBe(false);
    expect(second.processedEvents).toBe(1);
    expect(second.nowMs).toBe(10);
    expect(scheduler.pendingEvents).toBe(0);
    expect(log).toEqual([1, 2, 3]);
  });

  it('advances idle time to the requested horizon', () => {
    const scheduler = new EventScheduler();
    const result = scheduler.runUntil(42);
    expect(result.nowMs).toBe(42);
    expect(result.processedEvents).toBe(0);
    expect(result.exhausted).toBe(false);
    expect(scheduler.nowMs).toBe(42);
  });
});
