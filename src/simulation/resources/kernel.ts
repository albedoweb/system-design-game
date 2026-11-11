import type { EventScheduler, ScheduledHandle } from './scheduler';

/**
 * A deterministic resource kernel for a bounded discrete-event simulation.
 *
 * The kernel owns capacity accounting, FIFO waiters, deadlines, cancellation
 * and observation-window statistics. It does not know about CPU, network or
 * disk catalogues, and it does not pretend those resources have the same
 * service duration. Callers submit a duration per task; a caller that needs a
 * CPU stage, an IO stage and a network stage submits three tasks linked by its
 * own causal logic.
 *
 * Fairness: each physical resource has its own FIFO waiter list. A task may
 * start only when it is the first waiter on every resource it needs and all
 * units fit atomically. This prevents partial acquisition and deadlock, and it
 * removes starvation: the first waiter of a resource eventually becomes
 * runnable or is finished by deadline/cancellation. The cost is possible
 * head-of-line blocking (a large head request can leave smaller later
 * requests waiting) and capacity fragmentation. Unrelated resources overlap
 * because their waiter lists are independent.
 */

const COMPLETION_PRIORITY = 0;
const DEADLINE_PRIORITY = 1;
const UNIT_TOLERANCE = 1e-9;

export interface ResourceInfo {
  readonly id: string;
  readonly capacity: number;
  readonly kind: string;
}

export interface ResourceRequirement {
  readonly id: string;
  readonly units: number;
}

export interface SubmitTaskRequest {
  readonly id: string;
  readonly resources: readonly ResourceRequirement[];
  /** Service time while all required resources are held. Non-negative. */
  readonly durationMs: number;
  /**
   * Optional deadline in milliseconds after enqueue (not an absolute
   * timestamp). A queued task expires at its deadline; an active task is
   * interrupted and reports partial work. Completion wins when completion and
   * deadline fall on exactly the same timestamp.
   */
  readonly deadlineMs?: number;
  /**
   * Optional observational notification invoked exactly once when this task
   * really starts (queued→active), after its allocations, waiter removal and
   * completion event are consistent. It is never invoked for a rejected
   * submission and never for a task that finishes while still queued. The
   * callback must not submit, cancel or otherwise mutate the kernel; public
   * mutators throw before applying any effect and exceptions are isolated, so
   * observation can never change a simulation result.
   */
  readonly onStart?: (startedAtMs: number) => void;
  readonly onFinish: (result: TaskResult) => void;
}

export type TaskTerminalStatus =
  | 'completed'
  | 'timeout'
  | 'interrupted'
  | 'rejected';

export type TaskFinishReason =
  | 'completed'
  | 'deadline-exceeded'
  | 'cancelled'
  | 'resource-unavailable'
  | 'duplicate-task-id'
  | 'duplicate-resource-id'
  | 'unknown-resource'
  | 'invalid-units'
  | 'capacity-exceeded'
  | 'queue-full';

export interface TaskResult {
  readonly taskId: string;
  readonly status: TaskTerminalStatus;
  readonly reason: TaskFinishReason;
  readonly enqueuedAtMs: number;
  readonly startedAtMs: number | null;
  readonly endedAtMs: number;
  /** Fraction of the requested service duration completed, in [0, 1]. */
  readonly workFraction: number;
}

export interface TaskHandle {
  readonly taskId: string;
  /** False for a submission rejected before it joined the queue. */
  readonly accepted: boolean;
  readonly finished: boolean;
  readonly result: TaskResult | undefined;
  /**
   * Cancels a queued or active task and reports `interrupted` with reason
   * `cancelled`. Returns false when the task already finished or the handle
   * belongs to a rejected submission.
   */
  cancel(): boolean;
}

export interface ResourceStats {
  readonly id: string;
  readonly kind: string;
  readonly nominalCapacity: number;
  readonly available: boolean;
  /** Zero while the resource is unavailable. */
  readonly availableCapacity: number;
  readonly busyUnits: number;
  readonly peakBusyUnits: number;
  /** Integral of busy units over the observation window, in unit-ms. */
  readonly busyUnitMs: number;
  /** `busyUnitMs / window duration`; drain after window end is excluded. */
  readonly averageBusyUnits: number;
  readonly queuedTasks: number;
  readonly activeTasks: number;
}

export interface ResourceKernelStats {
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly windowDurationMs: number;
  readonly nowMs: number;
  readonly queuedTasks: number;
  readonly activeTasks: number;
  readonly peakQueuedTasks: number;
  readonly completedTasks: number;
  readonly timedOutTasks: number;
  readonly interruptedTasks: number;
  readonly cancelledTasks: number;
  readonly resourceUnavailableInterruptions: number;
  readonly rejectedTasks: number;
  readonly queueWaitMsTotal: number;
  readonly queueWaitMsMax: number;
  readonly queueWaitMsAverage: number;
  readonly queueWaitSamples: number;
  readonly totalBusyUnitMs: number;
  readonly peakTotalBusyUnits: number;
  readonly averageTotalBusyUnits: number;
  readonly resources: readonly ResourceStats[];
}

export interface ResourceKernelOptions {
  /** Inclusive start of the measured window. */
  readonly windowStartMs: number;
  /** Exclusive end of the measured window. */
  readonly windowEndMs: number;
  /** Hard admission limit for queued (not active) tasks. */
  readonly maxQueuedTasks?: number;
}

type RuntimeState = 'queued' | 'active' | 'finished';

interface WaiterNode {
  readonly task: TaskRuntime;
  readonly resource: ResourceState;
  prev: WaiterNode | null;
  next: WaiterNode | null;
}

interface ResourceState {
  readonly id: string;
  readonly capacity: number;
  readonly kind: string;
  available: boolean;
  busyUnits: number;
  peakBusyUnits: number;
  busyUnitMs: number;
  lastBusyChangeMs: number;
  waitHead: WaiterNode | null;
  waitTail: WaiterNode | null;
  waitCount: number;
  readonly activeTasks: Set<TaskRuntime>;
}

interface TaskRuntime {
  readonly id: string;
  readonly resources: readonly ResourceRequirement[];
  readonly durationMs: number;
  readonly deadlineAtMs: number | null;
  readonly onStart: ((startedAtMs: number) => void) | undefined;
  readonly onFinish: (result: TaskResult) => void;
  readonly enqueuedAtMs: number;
  readonly waiterNodes: WaiterNode[];
  state: RuntimeState;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  deadlineHandle: ScheduledHandle | null;
  completionHandle: ScheduledHandle | null;
  allocated: boolean;
  result: TaskResult | null;
}

function unitTolerance(capacity: number): number {
  return Math.max(1, Math.abs(capacity)) * UNIT_TOLERANCE;
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value >= 1 ? 1 : value;
}

class KernelTaskHandle implements TaskHandle {
  constructor(
    private readonly kernel: ResourceKernel,
    private readonly task: TaskRuntime,
    readonly accepted: boolean,
  ) {}

  get taskId(): string {
    return this.task.id;
  }

  get finished(): boolean {
    return this.task.state === 'finished';
  }

  get result(): TaskResult | undefined {
    return this.task.result ?? undefined;
  }

  cancel(): boolean {
    if (this.task.state === 'finished') {
      return false;
    }
    return this.kernel.cancelTask(this.task.id);
  }
}

class RejectedTaskHandle implements TaskHandle {
  constructor(
    readonly taskId: string,
    readonly result: TaskResult,
  ) {}

  readonly accepted = false;
  readonly finished = true;

  cancel(): boolean {
    return false;
  }
}

export class ResourceKernel {
  private readonly resources = new Map<string, ResourceState>();
  private readonly liveTasks = new Map<string, TaskRuntime>();
  private readonly activeTasks = new Set<TaskRuntime>();
  private readonly dispatchResources = new Set<string>();

  private readonly windowStartMs: number;
  private readonly windowEndMs: number;
  private readonly windowDurationMs: number;
  private readonly maxQueuedTasks: number;

  private queuedTasks = 0;
  private peakQueuedTasks = 0;
  private totalBusyUnits = 0;
  private peakTotalBusyUnits = 0;
  private observingStart = false;

  private completedTasks = 0;
  private timedOutTasks = 0;
  private interruptedTasks = 0;
  private cancelledTasks = 0;
  private resourceUnavailableInterruptions = 0;
  private rejectedTasks = 0;
  private queueWaitMsTotal = 0;
  private queueWaitMsMax = 0;
  private queueWaitSamples = 0;

  constructor(
    private readonly scheduler: EventScheduler,
    options: ResourceKernelOptions,
  ) {
    if (
      !Number.isFinite(options.windowStartMs) ||
      !Number.isFinite(options.windowEndMs)
    ) {
      throw new RangeError('observation window bounds must be finite');
    }
    if (options.windowEndMs <= options.windowStartMs) {
      throw new RangeError('observation window end must be after its start');
    }
    const maxQueued = options.maxQueuedTasks ?? 10_000;
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new RangeError('maxQueuedTasks must be a non-negative integer');
    }

    this.windowStartMs = options.windowStartMs;
    this.windowEndMs = options.windowEndMs;
    this.windowDurationMs = options.windowEndMs - options.windowStartMs;
    this.maxQueuedTasks = maxQueued;
  }

  /**
   * Registers one physical resource. Capacity is expressed in caller-chosen
   * finite units (cores, IO lanes, 1 Gbit/s network lanes, bytes, ...).
   * Fractional capacities and fractional task units are supported; the kernel
   * conserves the units. Duplicate ids are rejected.
   */
  registerResource(spec: ResourceInfo): ResourceInfo {
    this.assertNotObserving('registerResource');
    if (typeof spec.id !== 'string' || spec.id.length === 0) {
      throw new TypeError('resource id must be a non-empty string');
    }
    if (!Number.isFinite(spec.capacity) || spec.capacity <= 0) {
      throw new RangeError('resource capacity must be finite and positive');
    }
    if (typeof spec.kind !== 'string' || spec.kind.length === 0) {
      throw new TypeError('resource kind must be a non-empty string');
    }
    if (this.resources.has(spec.id)) {
      throw new Error(`resource already registered: ${spec.id}`);
    }

    this.resources.set(spec.id, {
      id: spec.id,
      capacity: spec.capacity,
      kind: spec.kind,
      available: true,
      busyUnits: 0,
      peakBusyUnits: 0,
      busyUnitMs: 0,
      lastBusyChangeMs: this.windowStartMs,
      waitHead: null,
      waitTail: null,
      waitCount: 0,
      activeTasks: new Set(),
    });

    return { id: spec.id, capacity: spec.capacity, kind: spec.kind };
  }

  /**
   * Queues one task atomically. All resource requirements must fit at once;
   * the kernel never acquires a subset and never deadlocks.
   *
   * Rejections are reported through the callback exactly once with status
   * `rejected` and the task never enters the queue. Structural misuse (empty
   * id, invalid duration/deadline, missing callback) throws instead.
   */
  submit(request: SubmitTaskRequest): TaskHandle {
    this.assertNotObserving('submit');
    if (typeof request.id !== 'string' || request.id.length === 0) {
      throw new TypeError('task id must be a non-empty string');
    }
    if (typeof request.onFinish !== 'function') {
      throw new TypeError('task onFinish must be a function');
    }
    if (!Number.isFinite(request.durationMs) || request.durationMs < 0) {
      throw new RangeError('task duration must be finite and non-negative');
    }
    if (
      request.deadlineMs !== undefined &&
      (!Number.isFinite(request.deadlineMs) || request.deadlineMs < 0)
    ) {
      throw new RangeError('task deadline must be finite and non-negative');
    }
    if (!Array.isArray(request.resources)) {
      throw new TypeError('task resources must be an array');
    }

    const now = this.scheduler.nowMs;
    if (this.liveTasks.has(request.id)) {
      return this.reject(request, 'duplicate-task-id', now);
    }

    const seenResources = new Set<string>();
    const requirements: ResourceRequirement[] = [];
    for (const raw of request.resources) {
      if (typeof raw.id !== 'string' || raw.id.length === 0) {
        return this.reject(request, 'unknown-resource', now);
      }
      if (seenResources.has(raw.id)) {
        return this.reject(request, 'duplicate-resource-id', now);
      }
      seenResources.add(raw.id);
      const resource = this.resources.get(raw.id);
      if (resource === undefined) {
        return this.reject(request, 'unknown-resource', now);
      }
      if (!Number.isFinite(raw.units) || raw.units <= 0) {
        return this.reject(request, 'invalid-units', now);
      }
      if (raw.units > resource.capacity + unitTolerance(resource.capacity)) {
        return this.reject(request, 'capacity-exceeded', now);
      }
      requirements.push({ id: raw.id, units: raw.units });
    }

    if (this.queuedTasks >= this.maxQueuedTasks) {
      return this.reject(request, 'queue-full', now);
    }

    const deadlineAtMs =
      request.deadlineMs === undefined ? null : now + request.deadlineMs;
    if (
      (deadlineAtMs !== null && !Number.isFinite(deadlineAtMs)) ||
      !Number.isFinite(now + request.durationMs)
    ) {
      throw new RangeError('task end time is not finite');
    }
    const task: TaskRuntime = {
      id: request.id,
      resources: requirements,
      durationMs: request.durationMs,
      deadlineAtMs,
      onStart: request.onStart,
      onFinish: request.onFinish,
      enqueuedAtMs: now,
      waiterNodes: [],
      state: 'queued',
      startedAtMs: null,
      finishedAtMs: null,
      deadlineHandle: null,
      completionHandle: null,
      allocated: false,
      result: null,
    };
    this.liveTasks.set(task.id, task);
    this.queuedTasks += 1;
    if (this.queuedTasks > this.peakQueuedTasks) {
      this.peakQueuedTasks = this.queuedTasks;
    }

    if (deadlineAtMs !== null) {
      task.deadlineHandle = this.scheduler.schedule(
        deadlineAtMs,
        () => this.onDeadline(task),
        DEADLINE_PRIORITY,
      );
    }

    for (const requirement of requirements) {
      const resource = this.resources.get(requirement.id);
      if (resource === undefined) {
        // Registration cannot be removed; this is unreachable.
        throw new Error(`resource disappeared: ${requirement.id}`);
      }
      const node: WaiterNode = {
        task,
        resource,
        prev: resource.waitTail,
        next: null,
      };
      if (resource.waitTail === null) {
        resource.waitHead = node;
      } else {
        resource.waitTail.next = node;
      }
      resource.waitTail = node;
      resource.waitCount += 1;
      task.waiterNodes.push(node);
      this.dispatchResources.add(resource.id);
    }

    this.dispatch(now);
    if (requirements.length === 0) {
      // A task without resources cannot appear on a waiter list; start it
      // directly so it still completes exactly once.
      this.startTask(task, now);
    }
    return new KernelTaskHandle(this, task, true);
  }

  /** Cancels a live task by id. Returns false for unknown/finished ids. */
  cancelTask(taskId: string): boolean {
    this.assertNotObserving('cancelTask');
    const task = this.liveTasks.get(taskId);
    if (task === undefined || task.state === 'finished') {
      return false;
    }
    return this.finalizeTask(task, 'interrupted', 'cancelled', this.scheduler.nowMs);
  }

  /**
   * Marks a resource unavailable (for an outage) or available again.
   *
   * Going unavailable interrupts exactly the active tasks that hold that
   * resource; they release every unit they hold and report partial work.
   * Queued tasks stay queued until their deadline. Going available resumes
   * queued tasks; interrupted work is not silently restarted.
   */
  setAvailable(resourceId: string, available: boolean): void {
    this.assertNotObserving('setAvailable');
    const resource = this.resources.get(resourceId);
    if (resource === undefined) {
      throw new Error(`unknown resource: ${resourceId}`);
    }
    if (resource.available === available) {
      return;
    }
    resource.available = available;
    const now = this.scheduler.nowMs;

    if (!available) {
      const affected = [...resource.activeTasks];
      for (const task of affected) {
        if (task.state === 'active') {
          this.finalizeTask(
            task,
            'interrupted',
            'resource-unavailable',
            now,
          );
        }
      }
    } else {
      this.dispatchResources.add(resource.id);
      this.dispatch(now);
    }
  }

  /** Snapshot of counters and of observation-window integrals. */
  stats(): ResourceKernelStats {
    const now = this.scheduler.nowMs;
    const resources: ResourceStats[] = [];
    let totalBusyUnitMs = 0;

    for (const resource of this.resources.values()) {
      const busyUnitMs = this.snapshotBusyUnitMs(resource, now);
      totalBusyUnitMs += busyUnitMs;
      resources.push({
        id: resource.id,
        kind: resource.kind,
        nominalCapacity: resource.capacity,
        available: resource.available,
        availableCapacity: resource.available ? resource.capacity : 0,
        busyUnits: resource.busyUnits,
        peakBusyUnits: resource.peakBusyUnits,
        busyUnitMs,
        averageBusyUnits: busyUnitMs / this.windowDurationMs,
        queuedTasks: resource.waitCount,
        activeTasks: resource.activeTasks.size,
      });
    }

    return {
      windowStartMs: this.windowStartMs,
      windowEndMs: this.windowEndMs,
      windowDurationMs: this.windowDurationMs,
      nowMs: now,
      queuedTasks: this.queuedTasks,
      activeTasks: this.activeTasks.size,
      peakQueuedTasks: this.peakQueuedTasks,
      completedTasks: this.completedTasks,
      timedOutTasks: this.timedOutTasks,
      interruptedTasks: this.interruptedTasks,
      cancelledTasks: this.cancelledTasks,
      resourceUnavailableInterruptions: this.resourceUnavailableInterruptions,
      rejectedTasks: this.rejectedTasks,
      queueWaitMsTotal: this.queueWaitMsTotal,
      queueWaitMsMax: this.queueWaitMsMax,
      queueWaitMsAverage:
        this.queueWaitSamples === 0
          ? 0
          : this.queueWaitMsTotal / this.queueWaitSamples,
      queueWaitSamples: this.queueWaitSamples,
      totalBusyUnitMs,
      peakTotalBusyUnits: this.peakTotalBusyUnits,
      averageTotalBusyUnits: totalBusyUnitMs / this.windowDurationMs,
      resources,
    };
  }

  private reject(
    request: SubmitTaskRequest,
    reason: TaskFinishReason,
    atMs: number,
  ): TaskHandle {
    this.rejectedTasks += 1;
    const result: TaskResult = {
      taskId: request.id,
      status: 'rejected',
      reason,
      enqueuedAtMs: atMs,
      startedAtMs: null,
      endedAtMs: atMs,
      workFraction: 0,
    };
    request.onFinish(result);
    return new RejectedTaskHandle(request.id, result);
  }

  private onCompletion(task: TaskRuntime): void {
    if (task.state !== 'active') {
      return;
    }
    this.finalizeTask(task, 'completed', 'completed', this.scheduler.nowMs);
  }

  private onDeadline(task: TaskRuntime): void {
    if (task.state === 'finished') {
      return;
    }
    const now = this.scheduler.nowMs;
    this.finalizeTask(task, 'timeout', 'deadline-exceeded', now);
  }

  private finalizeTask(
    task: TaskRuntime,
    status: Exclude<TaskTerminalStatus, 'rejected'>,
    reason: TaskFinishReason,
    endedAtMs: number,
  ): boolean {
    if (task.state === 'finished') {
      return false;
    }

    const wasQueued = task.state === 'queued';
    const wasActive = task.state === 'active';
    const workFraction =
      status === 'completed'
        ? 1
        : this.workFractionAt(task, endedAtMs);

    task.state = 'finished';
    task.finishedAtMs = endedAtMs;
    task.result = {
      taskId: task.id,
      status,
      reason,
      enqueuedAtMs: task.enqueuedAtMs,
      startedAtMs: task.startedAtMs,
      endedAtMs,
      workFraction,
    };

    if (status === 'completed') {
      this.completedTasks += 1;
    } else if (status === 'timeout') {
      this.timedOutTasks += 1;
    } else {
      this.interruptedTasks += 1;
      if (reason === 'cancelled') {
        this.cancelledTasks += 1;
      } else if (reason === 'resource-unavailable') {
        this.resourceUnavailableInterruptions += 1;
      }
    }

    if (wasQueued) {
      this.queuedTasks -= 1;
      this.recordQueueWait(endedAtMs - task.enqueuedAtMs);
    }

    this.clearWaiters(task);
    task.deadlineHandle?.cancel();
    task.completionHandle?.cancel();
    task.deadlineHandle = null;
    task.completionHandle = null;

    if (wasActive) {
      this.activeTasks.delete(task);
      this.releaseAllocations(task, endedAtMs);
    }

    this.liveTasks.delete(task.id);
    try {
      task.onFinish(task.result);
    } finally {
      this.dispatch(endedAtMs);
    }
    return true;
  }

  private workFractionAt(task: TaskRuntime, atMs: number): number {
    if (task.startedAtMs === null || task.durationMs <= 0) {
      return 0;
    }
    return clampFraction((atMs - task.startedAtMs) / task.durationMs);
  }

  private recordQueueWait(waitMs: number): void {
    const wait = Math.max(0, waitMs);
    this.queueWaitMsTotal += wait;
    if (wait > this.queueWaitMsMax) {
      this.queueWaitMsMax = wait;
    }
    this.queueWaitSamples += 1;
  }

  private clearWaiters(task: TaskRuntime): void {
    for (const node of task.waiterNodes) {
      this.removeWaiter(node);
      this.dispatchResources.add(node.resource.id);
    }
    task.waiterNodes.length = 0;
  }

  private removeWaiter(node: WaiterNode): void {
    const { resource } = node;
    if (node.prev === null) {
      resource.waitHead = node.next;
    } else {
      node.prev.next = node.next;
    }
    if (node.next === null) {
      resource.waitTail = node.prev;
    } else {
      node.next.prev = node.prev;
    }
    node.prev = null;
    node.next = null;
    resource.waitCount -= 1;
    if (resource.waitCount < 0) {
      resource.waitCount = 0;
    }
  }

  private dispatch(now: number): void {
    while (this.dispatchResources.size > 0) {
      const resourceIds = [...this.dispatchResources].sort();
      this.dispatchResources.clear();
      let progressed = false;

      for (const resourceId of resourceIds) {
        const resource = this.resources.get(resourceId);
        if (resource === undefined) {
          continue;
        }
        for (;;) {
          const head = resource.waitHead;
          if (head === null) {
            break;
          }
          if (head.task.state !== 'queued') {
            this.removeWaiter(head);
            progressed = true;
            continue;
          }
          if (!this.canStart(head.task)) {
            break;
          }
          this.startTask(head.task, now);
          progressed = true;
        }
      }

      if (!progressed) {
        // No waiter became runnable; stale entries were already removed.
        break;
      }
    }
  }

  private canStart(task: TaskRuntime): boolean {
    // Completion callbacks run before deadline callbacks at the same time.
    // Leave an expired waiter queued for its already scheduled deadline event;
    // it must not acquire resources or inflate peak occupancy for zero work.
    if (
      task.deadlineAtMs !== null &&
      (task.deadlineAtMs < this.scheduler.nowMs ||
        (task.deadlineAtMs === this.scheduler.nowMs && task.durationMs > 0))
    ) {
      return false;
    }
    for (const node of task.waiterNodes) {
      if (node.resource.waitHead !== node) {
        return false;
      }
    }
    for (const requirement of task.resources) {
      const resource = this.resources.get(requirement.id);
      if (resource === undefined || !resource.available) {
        return false;
      }
      const free = resource.capacity - resource.busyUnits;
      if (requirement.units > free + unitTolerance(resource.capacity)) {
        return false;
      }
    }
    return true;
  }

  private startTask(task: TaskRuntime, now: number): void {
    task.state = 'active';
    task.startedAtMs = now;
    this.activeTasks.add(task);
    this.queuedTasks -= 1;
    this.recordQueueWait(now - task.enqueuedAtMs);

    let acquired = 0;
    for (const requirement of task.resources) {
      const resource = this.resources.get(requirement.id);
      if (resource === undefined) {
        throw new Error(`resource disappeared: ${requirement.id}`);
      }
      this.accrueResource(resource, now);
      resource.busyUnits += requirement.units;
      if (resource.busyUnits > resource.peakBusyUnits) {
        resource.peakBusyUnits = resource.busyUnits;
      }
      resource.activeTasks.add(task);
      acquired += requirement.units;
    }
    task.allocated = true;
    this.totalBusyUnits += acquired;
    if (this.totalBusyUnits > this.peakTotalBusyUnits) {
      this.peakTotalBusyUnits = this.totalBusyUnits;
    }

    for (const node of task.waiterNodes) {
      this.removeWaiter(node);
      this.dispatchResources.add(node.resource.id);
    }
    task.waiterNodes.length = 0;

    task.completionHandle = this.scheduler.schedule(
      now + task.durationMs,
      () => this.onCompletion(task),
      COMPLETION_PRIORITY,
    );

    // Notify only after the complete transition (state, allocations, waiters
    // and the completion event) is consistent, so a misbehaving observer can
    // never leave a stale completion behind for an already-finalised task.
    this.notifyStart(task, now);
  }

  private assertNotObserving(operation: string): void {
    if (this.observingStart) {
      throw new Error(`kernel ${operation} is not allowed during onStart observation`);
    }
  }

  /**
   * Delivers the optional start observation after the real transition, once,
   * with every kernel data structure already consistent. The observer may only
   * read: public mutators throw before any effect while it runs, and exceptions
   * are swallowed so telemetry can never change simulation results.
   */
  private notifyStart(task: TaskRuntime, atMs: number): void {
    const callback = task.onStart;
    if (callback === undefined) {
      return;
    }
    this.observingStart = true;
    try {
      callback(atMs);
    } catch {
      // Observation only; never let telemetry break resource accounting.
    } finally {
      this.observingStart = false;
    }
  }

  private releaseAllocations(task: TaskRuntime, now: number): void {
    if (!task.allocated) {
      return;
    }
    task.allocated = false;
    let released = 0;
    for (const requirement of task.resources) {
      const resource = this.resources.get(requirement.id);
      if (resource === undefined) {
        continue;
      }
      this.accrueResource(resource, now);
      resource.busyUnits -= requirement.units;
      const tolerance = unitTolerance(resource.capacity);
      if (resource.busyUnits < 0 && resource.busyUnits > -tolerance) {
        resource.busyUnits = 0;
      }
      if (resource.busyUnits < 0) {
        resource.busyUnits = 0;
      }
      resource.activeTasks.delete(task);
      released += requirement.units;
      this.dispatchResources.add(resource.id);
    }
    this.totalBusyUnits -= released;
    if (this.totalBusyUnits < 0) {
      this.totalBusyUnits = 0;
    }
  }

  private accrueResource(resource: ResourceState, atMs: number): void {
    const start = Math.max(resource.lastBusyChangeMs, this.windowStartMs);
    const end = Math.min(atMs, this.windowEndMs);
    if (end > start) {
      resource.busyUnitMs += resource.busyUnits * (end - start);
    }
    resource.lastBusyChangeMs = atMs;
  }

  private snapshotBusyUnitMs(resource: ResourceState, atMs: number): number {
    const start = Math.max(resource.lastBusyChangeMs, this.windowStartMs);
    const end = Math.min(atMs, this.windowEndMs);
    if (end <= start) {
      return resource.busyUnitMs;
    }
    return resource.busyUnitMs + resource.busyUnits * (end - start);
  }
}
