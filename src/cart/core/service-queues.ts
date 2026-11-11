import { cartIoServiceUs, type CartResourceLedger, type CartResourcePlan } from './resources';

export interface CartCpuWindow {
  readonly instance: number;
  /** Zero-based lane within the selected instance. */
  readonly lane: number;
  readonly startUs: number;
  readonly doneUs: number;
  /**
   * Admission token. A granted window holds one pending-task reservation in the
   * resource ledger until `release()` (or the lazy retirement at its `doneUs`).
   */
  readonly token: number;
}

export interface CartServiceQueueOptions {
  /**
   * Ledger that owns bounded pending/RAM admission for live queued and
   * in-flight service work. Without it the queue is unbounded (memory-only
   * unit seam); the integrated model always supplies one.
   */
  readonly ledger?: CartResourceLedger;
}

/** Read-only load counters for one node; they never influence scheduling. */
export interface CartNodeLoad {
  readonly cpuTasks: number;
  readonly cpuBusyUs: number;
  readonly cpuWaitTotalUs: number;
  readonly cpuWaitMaxUs: number;
  readonly cpuRejected: number;
  readonly ioTasks: number;
  readonly ioBusyUs: number;
  readonly ioWaitTotalUs: number;
  readonly ioWaitMaxUs: number;
}

type MutableNodeLoad = { -readonly [K in keyof CartNodeLoad]: CartNodeLoad[K] };

interface PendingReservation {
  readonly nodeId: string;
  readonly instance: number;
  readonly payloadBytes: number;
  readonly doneUs: number;
}

/**
 * Non-preemptive FIFO CPU reservations. Callers enqueue in scheduler arrival
 * order and schedule semantic effects at doneUs (never at reservation time).
 * Equal availability chooses the lowest lane. Instances never borrow lanes.
 * IO uses an independent FIFO serializer.
 *
 * Bounded admission (GC-PE7): every granted window is a live pending task. The
 * resource ledger enforces the frozen pending-task limit and queue RAM before
 * the window exists, so timestamp scheduling can never imply infinite queue
 * capacity. A rejected window returns `null`, reserves nothing and is never
 * released (the caller rejects the operation instead of storing it forever).
 */
export class CartServiceQueues {
  private readonly lanes = new Map<string, number[][]>();
  private readonly nextInstance = new Map<string, number>();
  private busyUs = 0;
  private readonly exclusive = new Map<string, Array<(atUs: number) => void>>();
  private readonly ledger: CartResourceLedger | undefined;
  private readonly pending = new Map<number, PendingReservation>();
  private nextToken = 0;
  private rejectedAdmissions = 0;
  private readonly load = new Map<string, MutableNodeLoad>();

  /** Inventory's single FIFO transaction slot, independent of CPU lane count.
   * Release only at actual IO/flush completion, never when CPU becomes free.
   */
  enqueueExclusive(nodeId: string, atUs: number,
    run: (startUs: number, release: (doneUs: number) => void) => void): void {
    const waiting = this.exclusive.get(nodeId);
    const start = (startUs: number): void => run(startUs, doneUs => {
      const queue = this.exclusive.get(nodeId)!;
      const next = queue.shift();
      if (next) next(doneUs);
      else this.exclusive.delete(nodeId);
    });
    if (waiting) waiting.push(start);
    else {
      this.exclusive.set(nodeId, []);
      start(atUs);
    }
  }

  waitingTransactions(nodeId: string): number { return this.exclusive.get(nodeId)?.length ?? 0; }

  private readonly io = new Map<string, { rate: number; freeUs: number }>();

  constructor(plan: CartResourcePlan, options: CartServiceQueueOptions = {}) {
    this.ledger = options.ledger;
    for (const [id, capacity] of plan.nodes) {
      if (capacity.ioPerSecond !== null) this.io.set(id, { rate: capacity.ioPerSecond, freeUs: 0 });
      this.lanes.set(id, Array.from({ length: capacity.instances }, () =>
        Array<number>(capacity.cpuLanes).fill(0)));
    }
  }

  /** Stable round-robin at logical admission; retain this value across retries. */
  assignInstance(nodeId: string): number {
    const instances = this.node(nodeId);
    const index = this.nextInstance.get(nodeId) ?? 0;
    this.nextInstance.set(nodeId, (index + 1) % instances.length);
    return index + 1;
  }

  /**
   * Admits one CPU service window. Returns `null` — having reserved nothing —
   * when the node's pending-task limit or queue RAM is already full.
   */
  reserve(
    nodeId: string,
    atUs: number,
    durationUs: number,
    instance = 1,
    payloadBytes = 0,
  ): CartCpuWindow | null {
    if (!Number.isSafeInteger(atUs) || atUs < 0 ||
        !Number.isSafeInteger(durationUs) || durationUs < 0) {
      throw new RangeError('CPU time must be non-negative integer microseconds');
    }
    const lanes = this.node(nodeId)[instance - 1];
    if (!Number.isInteger(instance) || lanes === undefined) {
      throw new RangeError(`Unknown CPU instance ${nodeId}:${instance}`);
    }
    if (!Number.isFinite(payloadBytes) || payloadBytes < 0) {
      throw new RangeError('payload bytes must be finite and non-negative');
    }
    // Lazy but exact release: work whose service already completed at this
    // admission instant has left the queue, so it stops counting immediately.
    this.releaseCompleted(nodeId, atUs);
    if (this.ledger !== undefined) {
      const admitted = this.ledger.enqueueTask(nodeId, payloadBytes, instance, atUs);
      if (!admitted.ok) {
        this.rejectedAdmissions += 1;
        this.loadOf(nodeId).cpuRejected += 1;
        return null;
      }
    }
    let lane = 0;
    for (let index = 1; index < lanes.length; index += 1) {
      if (Math.max(atUs, lanes[index]!) < Math.max(atUs, lanes[lane]!)) lane = index;
    }
    const startUs = Math.max(atUs, lanes[lane]!);
    const doneUs = startUs + durationUs;
    lanes[lane] = doneUs;
    this.busyUs += durationUs;
    const load = this.loadOf(nodeId);
    const waitUs = startUs - atUs;
    load.cpuTasks += 1;
    load.cpuBusyUs += durationUs;
    load.cpuWaitTotalUs += waitUs;
    if (waitUs > load.cpuWaitMaxUs) load.cpuWaitMaxUs = waitUs;
    this.nextToken += 1;
    const token = this.nextToken;
    this.pending.set(token, { nodeId, instance, payloadBytes, doneUs });
    return { instance, lane, startUs, doneUs, token };
  }

  /** Releases one pending reservation exactly once; a second call is a no-op. */
  release(window: CartCpuWindow): boolean {
    return this.releaseToken(window.token);
  }

  private releaseToken(token: number): boolean {
    const reservation = this.pending.get(token);
    if (reservation === undefined) return false;
    this.pending.delete(token);
    this.ledger?.completeTask(reservation.nodeId, reservation.payloadBytes, reservation.instance);
    return true;
  }

  /** Releases every completed service on one node at or before `throughUs`. */
  releaseCompleted(nodeId: string, throughUs: number): void {
    for (const [token, reservation] of [...this.pending]) {
      if (reservation.nodeId === nodeId && reservation.doneUs <= throughUs) this.releaseToken(token);
    }
  }

  /** Releases every completed service on every node at or before `throughUs`. */
  releaseCompletedAll(throughUs: number): void {
    for (const [token, reservation] of [...this.pending]) {
      if (reservation.doneUs <= throughUs) this.releaseToken(token);
    }
  }

  /** Live queued/in-flight tasks retained by this seam (leak/conservation probe). */
  get pendingTasks(): number {
    return this.pending.size;
  }

  /** Windows refused because the node's bound was already full. */
  get admissionRejections(): number {
    return this.rejectedAdmissions;
  }

  /** FIFO IO service at the purchased IOPS; flush is a separate caller stage. */
  reserveIo(nodeId: string, atUs: number, units: number): { startUs: number; doneUs: number } {
    if (units === 0) return { startUs: atUs, doneUs: atUs };
    const io = this.io.get(nodeId);
    if (io === undefined) throw new RangeError(`Unknown IO node ${nodeId}`);
    const startUs = Math.max(atUs, io.freeUs);
    const doneUs = startUs + cartIoServiceUs(io.rate, units);
    io.freeUs = doneUs;
    const load = this.loadOf(nodeId);
    const waitUs = startUs - atUs;
    load.ioTasks += 1;
    load.ioBusyUs += doneUs - startUs;
    load.ioWaitTotalUs += waitUs;
    if (waitUs > load.ioWaitMaxUs) load.ioWaitMaxUs = waitUs;
    return { startUs, doneUs };
  }

  /** Observed CPU/IO load of one node so far (zeros when it never served work). */
  nodeLoad(nodeId: string): CartNodeLoad {
    return { ...this.loadOf(nodeId) };
  }

  private loadOf(nodeId: string): MutableNodeLoad {
    let load = this.load.get(nodeId);
    if (load === undefined) {
      load = { cpuTasks: 0, cpuBusyUs: 0, cpuWaitTotalUs: 0, cpuWaitMaxUs: 0, cpuRejected: 0,
        ioTasks: 0, ioBusyUs: 0, ioWaitTotalUs: 0, ioWaitMaxUs: 0 };
      this.load.set(nodeId, load);
    }
    return load;
  }

  /** Sum of admitted CPU service, excluding queue waits and transport latency. */
  get chargedBusyUs(): number { return this.busyUs; }

  private node(nodeId: string): number[][] {
    const instances = this.lanes.get(nodeId);
    if (instances === undefined) throw new RangeError(`Unknown CPU node ${nodeId}`);
    return instances;
  }
}
