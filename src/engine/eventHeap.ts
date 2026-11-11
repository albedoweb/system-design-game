/**
 * Binary min-heap ordered by logical time, then priority, then insertion
 * sequence. No wall-clock or random component: identical event streams always
 * pop in the same order.
 */

export const EVENT_PRIORITY = Object.freeze({
  reset: 0,
  flush: 0,
  invalidation: 1,
  arrival: 2,
  completion: 3,
  timeout: 4,
});

export interface ScheduledEvent {
  readonly timeMs: number;
  readonly priority: number;
  readonly sequence: number;
  readonly run: () => void;
}

function before(a: ScheduledEvent, b: ScheduledEvent): boolean {
  if (a.timeMs !== b.timeMs) {
    return a.timeMs < b.timeMs;
  }
  if (a.priority !== b.priority) {
    return a.priority < b.priority;
  }
  return a.sequence < b.sequence;
}

export class SimulationEventHeap {
  private readonly items: ScheduledEvent[] = [];
  private sequence = 0;

  get size(): number {
    return this.items.length;
  }

  push(timeMs: number, priority: number, run: () => void): void {
    const event: ScheduledEvent = {
      timeMs,
      priority,
      sequence: this.sequence,
      run,
    };
    this.sequence += 1;
    this.items.push(event);
    this.bubbleUp(this.items.length - 1);
  }

  peek(): ScheduledEvent | undefined {
    return this.items[0];
  }

  pop(): ScheduledEvent | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last !== undefined) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  private bubbleUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const current = this.items[index];
      const above = this.items[parent];
      if (!current || !above || !before(current, above)) {
        return;
      }
      this.items[index] = above;
      this.items[parent] = current;
      index = parent;
    }
  }

  private bubbleDown(start: number): void {
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      const current = this.items[smallest];
      const leftItem = this.items[left];
      if (current && leftItem && before(leftItem, current)) {
        smallest = left;
      }
      const smallestItem = this.items[smallest];
      const rightItem = this.items[right];
      if (smallestItem && rightItem && before(rightItem, smallestItem)) {
        smallest = right;
      }
      if (smallest === index) {
        return;
      }
      const swap = this.items[index];
      const target = this.items[smallest];
      if (!swap || !target) {
        return;
      }
      this.items[index] = target;
      this.items[smallest] = swap;
      index = smallest;
    }
  }
}
