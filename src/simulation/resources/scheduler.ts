/**
 * Deterministic discrete-event scheduler.
 *
 * The scheduler owns a logical clock only. It has no wall-clock, timer, DOM or
 * random dependency, so replaying the same event stream always yields the same
 * order on every machine.
 *
 * Ordering at one timestamp is: lower numeric priority first, then insertion
 * order. The default priority is 0. The resource kernel uses priority 0 for
 * completions and priority 1 for deadlines, which makes "completion exactly at
 * the deadline" win over timeout.
 */

export interface ScheduledHandle {
  readonly id: number;
  readonly atMs: number;
  readonly priority: number;
  /** True after `cancel()` was accepted. */
  readonly cancelled: boolean;
  /** True after the callback has been invoked. */
  readonly ran: boolean;
  /**
   * Cancels the event if it has not run yet. Returns false when the event
   * already ran or was already cancelled. A stale callback is never invoked.
   */
  cancel(): boolean;
}

export interface SchedulerRunResult {
  /** Callbacks invoked by this call. */
  readonly processedEvents: number;
  /** Total callbacks invoked by this scheduler. */
  readonly totalProcessedEvents: number;
  /** True when the per-call event budget stopped the run with work left due. */
  readonly exhausted: boolean;
  readonly nowMs: number;
  /** Events still queued, including cancelled tombstones. */
  readonly remainingEvents: number;
}

interface EventRecord {
  readonly id: number;
  readonly atMs: number;
  readonly priority: number;
  readonly sequence: number;
  readonly callback: () => void;
  cancelled: boolean;
  ran: boolean;
  /** Current binary-heap position, or -1 when not queued. */
  index: number;
}

class Handle implements ScheduledHandle {
  constructor(
    private readonly scheduler: EventScheduler,
    private readonly event: EventRecord,
  ) {}

  get id(): number {
    return this.event.id;
  }

  get atMs(): number {
    return this.event.atMs;
  }

  get priority(): number {
    return this.event.priority;
  }

  get cancelled(): boolean {
    return this.event.cancelled;
  }

  get ran(): boolean {
    return this.event.ran;
  }

  cancel(): boolean {
    return this.scheduler.cancelEvent(this.event);
  }
}

function before(a: EventRecord, b: EventRecord): boolean {
  if (a.atMs !== b.atMs) {
    return a.atMs < b.atMs;
  }
  if (a.priority !== b.priority) {
    return a.priority < b.priority;
  }
  return a.sequence < b.sequence;
}

export class EventScheduler {
  private now = 0;
  private readonly events: EventRecord[] = [];
  private sequence = 0;
  private nextId = 1;
  private totalProcessed = 0;
  private exhaustedFlag = false;
  private running = false;

  get nowMs(): number {
    return this.now;
  }

  /** Total callbacks invoked so far (cancelled events are not counted). */
  get processedEvents(): number {
    return this.totalProcessed;
  }

  /**
   * True when the last `runUntil` stopped because its event budget was
   * reached while events were still due. The budget condition is explicit;
   * the scheduler never silently drops the remaining work.
   */
  get exhausted(): boolean {
    return this.exhaustedFlag;
  }

  /** Events still held, including cancelled tombstones not yet popped. */
  get pendingEvents(): number {
    return this.events.length;
  }

  /**
   * Schedules a callback at an absolute logical timestamp.
   *
   * `atMs` must be finite and not earlier than the current logical time.
   * Scheduling at the current time is allowed and is ordered after events
   * already scheduled for the same timestamp.
   */
  schedule(
    atMs: number,
    callback: () => void,
    priority = 0,
  ): ScheduledHandle {
    if (!Number.isFinite(atMs)) {
      throw new RangeError('schedule time must be finite');
    }
    if (atMs < this.now) {
      throw new RangeError(
        `cannot schedule an event in the past: atMs=${atMs}, nowMs=${this.now}`,
      );
    }
    if (!Number.isFinite(priority)) {
      throw new RangeError('event priority must be finite');
    }
    if (typeof callback !== 'function') {
      throw new TypeError('event callback must be a function');
    }

    const event: EventRecord = {
      id: this.nextId,
      atMs,
      priority,
      sequence: this.sequence,
      callback,
      cancelled: false,
      ran: false,
      index: this.events.length,
    };
    this.nextId += 1;
    this.sequence += 1;
    this.events.push(event);
    this.bubbleUp(this.events.length - 1);
    return new Handle(this, event);
  }

  /**
   * Runs every event due at or before `untilMs`, then advances the logical
   * clock to `untilMs`. At most `maxEvents` callbacks are invoked.
   *
   * When the budget is hit, the clock stays at the last processed timestamp,
   * remaining due events stay queued and `exhausted` becomes true. A later
   * call can continue the same queue. Cancelled events are discarded and do
   * not consume the callback budget.
   */
  runUntil(
    untilMs: number,
    maxEvents = Number.POSITIVE_INFINITY,
  ): SchedulerRunResult {
    if (!Number.isFinite(untilMs)) {
      throw new RangeError('runUntil time must be finite');
    }
    if (untilMs < this.now) {
      throw new RangeError(
        `cannot run backwards: untilMs=${untilMs}, nowMs=${this.now}`,
      );
    }
    if (
      Number.isNaN(maxEvents) ||
      maxEvents < 0 ||
      (Number.isFinite(maxEvents) && !Number.isInteger(maxEvents))
    ) {
      throw new RangeError('maxEvents must be a non-negative integer or Infinity');
    }
    if (this.running) {
      throw new Error('EventScheduler.runUntil cannot be re-entered');
    }

    this.running = true;
    this.exhaustedFlag = false;
    let processed = 0;
    let exhausted = false;

    try {
      while (this.events.length > 0) {
        const next = this.events[0];
        if (next === undefined || next.atMs > untilMs) {
          break;
        }
        if (processed >= maxEvents) {
          exhausted = true;
          break;
        }

        const event = this.pop();
        if (event === undefined) {
          break;
        }
        if (event.cancelled) {
          continue;
        }

        this.now = event.atMs;
        event.ran = true;
        processed += 1;
        this.totalProcessed += 1;
        event.callback();
      }

      if (!exhausted) {
        this.now = untilMs;
      }
    } finally {
      this.running = false;
      this.exhaustedFlag = exhausted;
    }

    return {
      processedEvents: processed,
      totalProcessedEvents: this.totalProcessed,
      exhausted,
      nowMs: this.now,
      remainingEvents: this.events.length,
    };
  }

  private pop(): EventRecord | undefined {
    const first = this.events[0];
    const last = this.events.pop();
    if (first !== undefined) {
      first.index = -1;
    }
    if (this.events.length > 0 && last !== undefined) {
      last.index = 0;
      this.events[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  /** Used by the returned handle. Removes the event eagerly. */
  cancelEvent(event: EventRecord): boolean {
    if (event.cancelled || event.ran || event.index < 0) {
      return false;
    }
    event.cancelled = true;
    const index = event.index;
    const last = this.events.pop();
    event.index = -1;
    if (last === undefined || last === event) {
      return true;
    }
    if (index < this.events.length) {
      last.index = index;
      this.events[index] = last;
      const parent = (index - 1) >> 1;
      const above = this.events[parent];
      if (index > 0 && above !== undefined && before(last, above)) {
        this.bubbleUp(index);
      } else {
        this.bubbleDown(index);
      }
    }
    return true;
  }

  private bubbleUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const current = this.events[index];
      const above = this.events[parent];
      if (current === undefined || above === undefined || !before(current, above)) {
        return;
      }
      this.events[index] = above;
      above.index = index;
      this.events[parent] = current;
      current.index = parent;
      index = parent;
    }
  }

  private bubbleDown(start: number): void {
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      const current = this.events[smallest];
      const leftItem = this.events[left];
      if (current !== undefined && leftItem !== undefined && before(leftItem, current)) {
        smallest = left;
      }
      const smallestItem = this.events[smallest];
      const rightItem = this.events[right];
      if (
        smallestItem !== undefined &&
        rightItem !== undefined &&
        before(rightItem, smallestItem)
      ) {
        smallest = right;
      }
      if (smallest === index) {
        return;
      }
      const swap = this.events[index];
      const target = this.events[smallest];
      if (swap === undefined || target === undefined) {
        return;
      }
      this.events[index] = target;
      target.index = index;
      this.events[smallest] = swap;
      swap.index = smallest;
      index = smallest;
    }
  }
}
