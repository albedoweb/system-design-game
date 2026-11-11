import { describe, expect, it } from 'vitest';

import { NodeQueueDepthMeter } from '../queue-metrics';

describe('NodeQueueDepthMeter', () => {
  it('hand-calculates mean and peak across warm-up, measured and drain', () => {
    // Measured window [100, 200). Task A waits from warm-up into drain; B and
    // C queue and start inside the window; D is enqueued only during drain.
    const meter = new NodeQueueDepthMeter(100, 200);

    meter.begin(90); // A is already waiting when the window opens
    meter.begin(110); // B joins; two distinct waiters
    meter.end(130); // B starts
    meter.begin(140); // C joins; two waiters again
    meter.end(150); // C starts
    meter.begin(205); // D is a drain enqueue and must not raise the peak
    meter.end(210); // A starts only during drain
    meter.end(215); // D starts during drain
    meter.finish(220);

    // Integral: [100,110) 1 + [110,130) 2 + [130,140) 1 + [140,150) 2
    // + [150,200) 1 = 10 + 40 + 10 + 20 + 50 = 130 task-ms.
    expect(meter.averageDepth).toBeCloseTo(130 / 100, 12);
    expect(meter.peakDepth).toBe(2);
    expect(meter.averageDepth).toBeLessThanOrEqual(meter.peakDepth);
    expect(meter.currentTasks).toBe(0);
  });

  it('keeps waiting time for tasks cancelled or timed out before starting', () => {
    const meter = new NodeQueueDepthMeter(0, 100);
    meter.begin(10);
    meter.begin(20);
    meter.end(60); // first attempt is cancelled/timed out while still queued
    meter.end(140); // second attempt waits past the measured window end
    meter.finish(150);

    // [10,20) 1 + [20,60) 2 + [60,100) 1 = 10 + 80 + 40 = 130 task-ms.
    expect(meter.averageDepth).toBeCloseTo(1.3, 12);
    expect(meter.peakDepth).toBe(2);
    expect(meter.currentTasks).toBe(0);
  });

  it('stays at zero when no task ever waits and ignores pre-window history', () => {
    const meter = new NodeQueueDepthMeter(50, 150);
    meter.begin(10);
    meter.end(20);
    meter.begin(160);
    meter.end(170);
    meter.finish(200);

    expect(meter.averageDepth).toBe(0);
    expect(meter.peakDepth).toBe(0);
    expect(meter.currentTasks).toBe(0);
  });

  it('cannot report an average above its own peak for arbitrary transitions', () => {
    const meter = new NodeQueueDepthMeter(10, 110);
    let at = 0;
    let live = 0;
    for (let step = 0; step < 200; step += 1) {
      at += 0.5;
      if (live === 0 || step % 3 !== 0) {
        meter.begin(at);
        live += 1;
      } else {
        meter.end(at);
        live -= 1;
      }
      expect(meter.averageDepth).toBeLessThanOrEqual(meter.peakDepth);
    }
    meter.finish(120);
    expect(meter.averageDepth).toBeLessThanOrEqual(meter.peakDepth);
  });
});
