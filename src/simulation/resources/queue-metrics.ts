/**
 * Bounded streaming queue-depth accounting for one physical node.
 *
 * A node's queue contains distinct task attempts that have been enqueued for
 * that node but have not started yet. The meter deliberately counts tasks, not
 * resource wait lists: one attempt may need CPU, IO and several network lanes,
 * and it is still exactly one waiting task. Running attempts are never counted.
 *
 * `begin`/`end` are called from the kernel's real enqueue/start/terminal
 * transitions. The meter retains no per-task history: it keeps only a current
 * count, a time integral and a peak. All accrual is clipped to the measured
 * observation window, so warm-up and drain cannot inflate the average, while a
 * task that is still queued across a window boundary contributes its waiting
 * time only inside the window.
 *
 * Invariant: `averageDepth <= peakDepth` by construction. Every segment of the
 * window is weighted by a count that was itself observed as a peak candidate,
 * so no cosmetic clamp is needed.
 */
export class NodeQueueDepthMeter {
  private waitingTasks = 0;
  private lastMs: number;
  private windowSeeded = false;
  private waitingTaskMs = 0;
  private peakTasks = 0;

  constructor(
    private readonly windowStartMs: number,
    private readonly windowEndMs: number,
  ) {
    if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) {
      throw new RangeError('queue observation window bounds must be finite');
    }
    if (windowEndMs < windowStartMs) {
      throw new RangeError('queue observation window end must not precede its start');
    }
    this.lastMs = windowStartMs;
  }

  /** One distinct attempt joined this node's queue (real enqueue transition). */
  begin(atMs: number): void {
    this.observe(atMs);
    this.waitingTasks += 1;
    if (
      atMs >= this.windowStartMs &&
      atMs < this.windowEndMs &&
      this.waitingTasks > this.peakTasks
    ) {
      this.peakTasks = this.waitingTasks;
    }
  }

  /**
   * One waiting attempt left the queue, either because it really started or
   * because it was cancelled/timed out before its first service. Both cases
   * keep the waiting time already accumulated.
   */
  end(atMs: number): void {
    this.observe(atMs);
    if (this.waitingTasks > 0) {
      this.waitingTasks -= 1;
    }
  }

  /**
   * Final accrual at the end of the run. Safe to call when every task already
   * ended; it only extends the integral to the measured window end and seeds
   * the peak for an attempt waiting across the whole window.
   */
  finish(atMs: number = this.windowEndMs): void {
    this.observe(atMs);
  }

  /** Time-average number of waiting tasks over the measured window. */
  get averageDepth(): number {
    const durationMs = this.windowEndMs - this.windowStartMs;
    return durationMs > 0 ? this.waitingTaskMs / durationMs : 0;
  }

  /** Integral of waiting task count over the measured window, in task-ms. */
  get waitingMs(): number {
    return this.waitingTaskMs;
  }

  /** Highest number of waiting tasks observed inside the measured window. */
  get peakDepth(): number {
    return this.peakTasks;
  }

  /** Current waiting task count (zero after a clean run). */
  get waitingCount(): number {
    return this.waitingTasks;
  }

  /** Backwards-compatible name used by Image Atlas. */
  get currentTasks(): number {
    return this.waitingTasks;
  }

  private observe(atMs: number): void {
    const from = Math.max(this.lastMs, this.windowStartMs);
    const to = Math.min(atMs, this.windowEndMs);
    if (to > from) {
      this.waitingTaskMs += this.waitingTasks * (to - from);
    }
    if (atMs > this.lastMs) {
      this.lastMs = atMs;
    }
    if (!this.windowSeeded && atMs >= this.windowStartMs) {
      // The first transition at/after the window start proves which attempts
      // were already waiting when the window opened. Seeding here also covers
      // an attempt that waits across the entire window and ends during drain.
      this.windowSeeded = true;
      if (this.waitingTasks > this.peakTasks) {
        this.peakTasks = this.waitingTasks;
      }
    }
  }
}
