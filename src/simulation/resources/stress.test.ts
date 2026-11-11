import { describe, expect, it } from 'vitest';
import { EventScheduler, ResourceKernel } from './index';

describe('resource kernel stress', () => {
  it(
    'completes 100k short bounded tasks without growing the kernel queue forever',
    () => {
      const scheduler = new EventScheduler();
      const kernel = new ResourceKernel(scheduler, {
        windowStartMs: 0,
        windowEndMs: 1_000_000,
        maxQueuedTasks: 200_000,
      });
      kernel.registerResource({ id: 'lanes', capacity: 64, kind: 'cpu' });

      let finished = 0;
      const started = Date.now();
      for (let index = 0; index < 100_000; index += 1) {
        kernel.submit({
          id: `task-${index}`,
          resources: [{ id: 'lanes', units: 1 }],
          durationMs: 1,
          onFinish: () => {
            finished += 1;
          },
        });
      }

      scheduler.runUntil(1_000_000);
      const elapsedMs = Date.now() - started;
      const stats = kernel.stats();

      expect(finished).toBe(100_000);
      expect(stats.completedTasks).toBe(100_000);
      expect(stats.activeTasks).toBe(0);
      expect(stats.queuedTasks).toBe(0);
      expect(stats.resources[0]?.busyUnits).toBe(0);
      expect(stats.resources[0]?.peakBusyUnits).toBe(64);
      expect(elapsedMs).toBeLessThan(10_000);
    },
    20_000,
  );
});
