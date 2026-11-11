import type {
  AudienceInstanceMetrics,
  AudienceLinkMetrics,
  AudienceLinkRole,
  AudienceNodeKind,
  AudienceNodeMetrics,
} from '../contracts';
import type { z } from 'zod';
import {
  audienceInstanceHealthSchema,
  audienceQueueMetricsSchema,
} from '../contracts';

type AudienceInstanceHealth = z.infer<typeof audienceInstanceHealthSchema>;
type AudienceQueueMetrics = z.infer<typeof audienceQueueMetricsSchema>;
import { ResourceKernel } from '../../simulation/resources/kernel';
import { MemoryLedger } from '../../simulation/resources/memory';
import { NodeQueueDepthMeter } from '../../simulation/resources/queue-metrics';
import type { EventScheduler } from '../../simulation/resources/scheduler';
import { boundedAverage, boundedRatio } from './metrics';

/** One physical instance: its own kernel, queues, limits and lifecycle state. */
export interface InstanceRuntime {
  readonly nodeId: string;
  readonly kind: AudienceNodeKind;
  readonly instanceIndex: number;
  readonly label: string;
  readonly kernel: ResourceKernel;
  readonly cpuId: string;
  readonly nicId: string;
  readonly diskId: string | null;
  readonly memory: MemoryLedger;
  readonly memoryCapacityBytes: number;
  workingSetBytes: number;
  readonly cpuCapacityCores: number;
  readonly nicLanes: number;
  readonly diskLanes: number;
  readonly queueLimit: number;
  readonly queue: NodeQueueDepthMeter;
  waitTotalMs: number;
  waitMaxMs: number;
  waitSamples: number;
  active: number;
  activePeak: number;
  submitted: number;
  completed: number;
  rejected: number;
  timedOut: number;
  interrupted: number;
  netOfferedBytes: number;
  netDeliveredBytes: number;
  storageCapacityBytes: number;
  storageUsedBytes: number;
  storagePeakBytes: number;
  storageWrittenBytes: number;
  storageReadBytes: number;
  ioReadOperations: number;
  ioWriteOperations: number;
  memoryIntegralBytesMs: number;
  memoryObservedMs: number;
  /** Measured-window bounds the RAM integral is clipped to (no prep/drain). */
  readonly memoryWindowStartMs: number;
  readonly memoryWindowEndMs: number;
  /** Health of the actual process, independent of what the LB believes. */
  health: AudienceInstanceHealth;
  processUp: boolean;
  /** True while the restarted process boots and is not yet serving. */
  booting: boolean;
  /** Load-Balancer-known readiness; always true on a direct path. */
  lbReady: boolean;
  probeFailures: number;
  probeSuccesses: number;
  crashCount: number;
  incarnation: number;
  /** Requests currently owning queued or active work on this instance. */
  readonly owned: Set<{ readonly id: number }>;
}

export interface InstanceSpec {
  readonly nodeId: string;
  readonly kind: AudienceNodeKind;
  readonly instanceIndex: number;
  readonly label: string;
  readonly cpuCores: number;
  readonly nicLanes: number;
  readonly diskLanes: number;
  readonly memoryBytes: number;
  workingSetBytes: number;
  readonly queueLimit: number;
  readonly storageCapacityBytes: number;
}

export function createInstance(
  scheduler: EventScheduler,
  windowStartMs: number,
  windowEndMs: number,
  spec: InstanceSpec,
): InstanceRuntime {
  const kernel = new ResourceKernel(scheduler, {
    windowStartMs,
    windowEndMs,
    maxQueuedTasks: spec.queueLimit,
  });
  const cpuId = `${spec.nodeId}:i${spec.instanceIndex}:cpu`;
  const nicId = `${spec.nodeId}:i${spec.instanceIndex}:nic`;
  kernel.registerResource({ id: cpuId, capacity: spec.cpuCores, kind: 'cpu' });
  kernel.registerResource({
    id: nicId,
    capacity: spec.nicLanes,
    kind: 'network',
  });
  let diskId: string | null = null;
  if (spec.diskLanes > 0) {
    diskId = `${spec.nodeId}:i${spec.instanceIndex}:disk`;
    kernel.registerResource({
      id: diskId,
      capacity: spec.diskLanes,
      kind: 'disk',
    });
  }
  const memory = new MemoryLedger(spec.memoryBytes);
  if (spec.workingSetBytes > 0) {
    if (!memory.reserve('resident-working-set', spec.workingSetBytes)) {
      throw new Error(`node ${spec.nodeId} memory cannot hold its working set`);
    }
  }
  return {
    nodeId: spec.nodeId,
    kind: spec.kind,
    instanceIndex: spec.instanceIndex,
    label: spec.label,
    kernel,
    cpuId,
    nicId,
    diskId,
    memory,
    memoryCapacityBytes: spec.memoryBytes,
    workingSetBytes: spec.workingSetBytes,
    cpuCapacityCores: spec.cpuCores,
    nicLanes: spec.nicLanes,
    diskLanes: spec.diskLanes,
    queueLimit: spec.queueLimit,
    queue: new NodeQueueDepthMeter(windowStartMs, windowEndMs),
    waitTotalMs: 0,
    waitMaxMs: 0,
    waitSamples: 0,
    active: 0,
    activePeak: 0,
    submitted: 0,
    completed: 0,
    rejected: 0,
    timedOut: 0,
    interrupted: 0,
    netOfferedBytes: 0,
    netDeliveredBytes: 0,
    storageCapacityBytes: spec.storageCapacityBytes,
    storageUsedBytes: 0,
    storagePeakBytes: 0,
    storageWrittenBytes: 0,
    storageReadBytes: 0,
    ioReadOperations: 0,
    ioWriteOperations: 0,
    memoryIntegralBytesMs: 0,
    memoryObservedMs: 0,
    memoryWindowStartMs: windowStartMs,
    memoryWindowEndMs: windowEndMs,
    health: 'healthy',
    processUp: true,
    booting: false,
    lbReady: true,
    probeFailures: 0,
    probeSuccesses: 0,
    crashCount: 0,
    incarnation: 1,
    owned: new Set(),
  };
}

export function observeMemory(instance: InstanceRuntime, atMs: number): void {
  const used = instance.memory.usedBytes;
  // The RAM integral is clipped to the measured window so preparation and drain
  // can never dilute the resident average.
  const from = Math.max(instance.memoryObservedMs, instance.memoryWindowStartMs);
  const to = Math.min(atMs, instance.memoryWindowEndMs);
  if (to > from) {
    instance.memoryIntegralBytesMs += used * (to - from);
  }
  if (atMs > instance.memoryObservedMs) {
    instance.memoryObservedMs = atMs;
  }
}

function instanceMetrics(
  instance: InstanceRuntime,
  windowMs: number,
  healthOverride: AudienceInstanceHealth,
): AudienceInstanceMetrics {
  const stats = instance.kernel.stats();
  const cpu = stats.resources.find((item) => item.id === instance.cpuId);
  const nic = stats.resources.find((item) => item.id === instance.nicId);
  const disk = instance.diskId === null
    ? undefined
    : stats.resources.find((item) => item.id === instance.diskId);
  const busyCoreMs = cpu?.busyUnitMs ?? 0;
  const busyCoresAverage = busyCoreMs / windowMs;
  const busyCoresPeak = cpu?.peakBusyUnits ?? 0;
  const residentAverage =
    instance.memoryWindowEndMs > instance.memoryWindowStartMs
      ? instance.memoryIntegralBytesMs /
        (instance.memoryWindowEndMs - instance.memoryWindowStartMs)
      : instance.memory.usedBytes;
  const diskBusyMs = disk?.busyUnitMs ?? 0;
  const queue: AudienceQueueMetrics = {
    waitingAverage: boundedAverage(
      instance.queue.waitingMs,
      windowMs,
      instance.queue.peakDepth,
    ),
    waitingPeak: instance.queue.peakDepth,
    waitMsAverage:
      instance.waitSamples > 0
        ? instance.waitTotalMs / instance.waitSamples
        : 0,
    waitMsMax: instance.waitMaxMs,
    waitSamples: instance.waitSamples,
    activePeak: instance.activePeak,
    rejectedOverflow: instance.rejected,
    deadlineTimeouts: instance.timedOut,
  };
  return {
    nodeId: instance.nodeId,
    kind: instance.kind,
    instanceIndex: instance.instanceIndex,
    label: instance.label,
    health: healthOverride,
    cpu: {
      capacityCores: instance.cpuCapacityCores,
      busyCoresAverage,
      busyCoresPeak,
      busyCoreMs,
      utilizationAverage: boundedRatio(busyCoresAverage, instance.cpuCapacityCores),
      utilizationPeak: boundedRatio(busyCoresPeak, instance.cpuCapacityCores),
    },
    memory: {
      capacityBytes: instance.memoryCapacityBytes,
      workingSetBytes: instance.workingSetBytes,
      residentBytesAverage: Math.min(residentAverage, instance.memoryCapacityBytes),
      peakUsedBytes: Math.max(instance.memory.peakBytes, instance.workingSetBytes),
    },
    io: {
      readOperations: instance.ioReadOperations,
      writeOperations: instance.ioWriteOperations,
      bytesRead: instance.storageReadBytes,
      bytesWritten: instance.storageWrittenBytes,
      busyMs: instance.diskLanes > 0 ? diskBusyMs / instance.diskLanes : 0,
      utilizationAverage: boundedRatio(
        diskBusyMs / windowMs,
        instance.diskLanes,
      ),
    },
    storage: {
      capacityBytes: instance.storageCapacityBytes,
      usedBytes: instance.storageUsedBytes,
      peakUsedBytes: instance.storagePeakBytes,
      bytesWritten: instance.storageWrittenBytes,
      bytesRead: instance.storageReadBytes,
    },
    queue,
    network: {
      capacityGbitPerSec: instance.nicLanes,
      bytesOffered: instance.netOfferedBytes,
      bytesDelivered: instance.netDeliveredBytes,
      averageGbitPerSec: boundedAverage(
        nic?.busyUnitMs ?? 0,
        windowMs,
        nic?.peakBusyUnits ?? 0,
      ),
      peakGbitPerSec: nic?.peakBusyUnits ?? 0,
    },
    tasks: {
      submitted: instance.submitted,
      completed: instance.completed,
      rejected: instance.rejected,
      timedOut: instance.timedOut,
      interrupted: instance.interrupted,
    },
  };
}

export interface NodeRuntime {
  readonly nodeId: string;
  readonly kind: AudienceNodeKind;
  readonly label: string;
  readonly instances: readonly InstanceRuntime[];
  crashEvents: number;
  recoveryMs: number | null;
}

/** Aggregates physical instances into one node metric block. */
export function nodeMetrics(
  node: NodeRuntime,
  windowMs: number,
  healthOf: (instance: InstanceRuntime) => AudienceInstanceHealth,
): AudienceNodeMetrics {
  const instances = node.instances.map((instance) =>
    instanceMetrics(instance, windowMs, healthOf(instance)),
  );
  const sum = <T>(pick: (item: AudienceInstanceMetrics) => T, zero: T, add: (a: T, b: T) => T): T =>
    instances.reduce((total, item) => add(total, pick(item)), zero);
  const cpuCapacity = sum((item) => item.cpu.capacityCores, 0, (a, b) => a + b);
  const cpuAverage = sum((item) => item.cpu.busyCoresAverage, 0, (a, b) => a + b);
  const cpuPeak = sum((item) => item.cpu.busyCoresPeak, 0, (a, b) => a + b);
  const cpuCoreMs = sum((item) => item.cpu.busyCoreMs, 0, (a, b) => a + b);
  const healthy = instances.filter((item) => item.health === 'healthy').length;
  const firstQueue = instances[0]?.queue;
  return {
    nodeId: node.nodeId,
    kind: node.kind,
    label: node.label,
    provisionedInstances: Math.max(1, instances.length),
    health: {
      state: healthy === instances.length ? 'healthy' : 'degraded',
      totalInstances: Math.max(1, instances.length),
      healthyInstances: healthy,
      crashEvents: node.crashEvents,
      recoveryMs: node.recoveryMs,
    },
    cpu: {
      capacityCores: cpuCapacity,
      busyCoresAverage: cpuAverage,
      busyCoresPeak: cpuPeak,
      busyCoreMs: cpuCoreMs,
      utilizationAverage: boundedRatio(cpuAverage, cpuCapacity),
      utilizationPeak: boundedRatio(cpuPeak, cpuCapacity),
    },
    memory: {
      capacityBytes: sum((item) => item.memory.capacityBytes, 0, (a, b) => a + b),
      workingSetBytes: sum((item) => item.memory.workingSetBytes, 0, (a, b) => a + b),
      residentBytesAverage: sum(
        (item) => item.memory.residentBytesAverage,
        0,
        (a, b) => a + b,
      ),
      peakUsedBytes: sum((item) => item.memory.peakUsedBytes, 0, (a, b) => a + b),
    },
    io: {
      readOperations: sum((item) => item.io.readOperations, 0, (a, b) => a + b),
      writeOperations: sum((item) => item.io.writeOperations, 0, (a, b) => a + b),
      bytesRead: sum((item) => item.io.bytesRead, 0, (a, b) => a + b),
      bytesWritten: sum((item) => item.io.bytesWritten, 0, (a, b) => a + b),
      busyMs: sum((item) => item.io.busyMs, 0, (a, b) => a + b),
      utilizationAverage: Math.min(
        1,
        sum((item) => item.io.utilizationAverage, 0, (a, b) => a + b) /
          Math.max(1, instances.length),
      ),
    },
    storage: {
      capacityBytes: sum((item) => item.storage.capacityBytes, 0, (a, b) => a + b),
      usedBytes: sum((item) => item.storage.usedBytes, 0, (a, b) => a + b),
      peakUsedBytes: sum((item) => item.storage.peakUsedBytes, 0, (a, b) => a + b),
      bytesWritten: sum((item) => item.storage.bytesWritten, 0, (a, b) => a + b),
      bytesRead: sum((item) => item.storage.bytesRead, 0, (a, b) => a + b),
    },
    queue: {
      waitingAverage: sum((item) => item.queue.waitingAverage, 0, (a, b) => a + b),
      waitingPeak: sum((item) => item.queue.waitingPeak, 0, (a, b) => a + b),
      waitMsAverage: firstQueue?.waitMsAverage ?? 0,
      waitMsMax: Math.max(0, ...instances.map((item) => item.queue.waitMsMax)),
      waitSamples: sum((item) => item.queue.waitSamples, 0, (a, b) => a + b),
      activePeak: sum((item) => item.queue.activePeak, 0, (a, b) => a + b),
      rejectedOverflow: sum((item) => item.queue.rejectedOverflow, 0, (a, b) => a + b),
      deadlineTimeouts: sum((item) => item.queue.deadlineTimeouts, 0, (a, b) => a + b),
    },
    network: {
      capacityGbitPerSec: sum((item) => item.network.capacityGbitPerSec, 0, (a, b) => a + b),
      bytesOffered: sum((item) => item.network.bytesOffered, 0, (a, b) => a + b),
      bytesDelivered: sum((item) => item.network.bytesDelivered, 0, (a, b) => a + b),
      averageGbitPerSec: sum(
        (item) => item.network.averageGbitPerSec,
        0,
        (a, b) => a + b,
      ),
      peakGbitPerSec: sum((item) => item.network.peakGbitPerSec, 0, (a, b) => a + b),
    },
    tasks: {
      submitted: sum((item) => item.tasks.submitted, 0, (a, b) => a + b),
      completed: sum((item) => item.tasks.completed, 0, (a, b) => a + b),
      rejected: sum((item) => item.tasks.rejected, 0, (a, b) => a + b),
      timedOut: sum((item) => item.tasks.timedOut, 0, (a, b) => a + b),
      interrupted: sum((item) => item.tasks.interrupted, 0, (a, b) => a + b),
    },
    instances,
  };
}

/** Per-edge traffic counters with one-second peaks. */
export interface EdgeRuntime {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
  readonly role: AudienceLinkRole;
  readonly requests: { ingest: number; read: number; projection: number };
  requestsTotal: number;
  bytesOffered: number;
  bytesDelivered: number;
  bucketRequests: number;
  bucketBytes: number;
  peakRequestsPerSecond: number;
  peakBytesPerSecond: number;
}

export function createEdge(
  edgeId: string,
  from: string,
  to: string,
  role: AudienceLinkRole,
): EdgeRuntime {
  return {
    edgeId,
    from,
    to,
    role,
    requests: { ingest: 0, read: 0, projection: 0 },
    requestsTotal: 0,
    bytesOffered: 0,
    bytesDelivered: 0,
    bucketRequests: 0,
    bucketBytes: 0,
    peakRequestsPerSecond: 0,
    peakBytesPerSecond: 0,
  };
}

export function observeEdge(
  edge: EdgeRuntime,
  operation: 'ingest' | 'read' | 'projection',
  bytes: number,
  delivered: boolean,
): void {
  edge.requests[operation] += 1;
  edge.requestsTotal += 1;
  edge.bytesOffered += bytes;
  if (delivered) {
    edge.bytesDelivered += bytes;
  }
  edge.bucketRequests += 1;
  edge.bucketBytes += bytes;
}

export interface EdgeBucketRates {
  /** Offered traversals observed in the open bucket, normalised per second. */
  readonly requestsPerSecond: number;
  /** Offered payload bytes observed in the open bucket, per second. */
  readonly bytesPerSecond: number;
}

/**
 * Read the open window without closing, consuming or resetting the bucket.
 *
 * The counters are offered-work observations: `bucketRequests` counts every
 * dispatched logical traversal (including an attempt that later fails) and
 * `bucketBytes` counts payloads handed to the hop, not bytes acknowledged by
 * the receiver. Rates are normalised by the actual interval the bucket covers
 * so a drain window shorter or longer than one second stays truthful.
 */
export function openEdgeBucketRates(
  edge: EdgeRuntime,
  windowMs: number,
): EdgeBucketRates {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return { requestsPerSecond: 0, bytesPerSecond: 0 };
  }
  const perSecond = 1_000 / windowMs;
  const requestsPerSecond = edge.bucketRequests * perSecond;
  const bytesPerSecond = edge.bucketBytes * perSecond;
  return {
    requestsPerSecond: Number.isFinite(requestsPerSecond)
      ? Math.max(0, requestsPerSecond)
      : 0,
    bytesPerSecond: Number.isFinite(bytesPerSecond)
      ? Math.max(0, bytesPerSecond)
      : 0,
  };
}

export function closeEdgeBucket(edge: EdgeRuntime, bucketMs: number): void {
  if (bucketMs <= 0) {
    return;
  }
  const requestsPerSecond = (edge.bucketRequests * 1_000) / bucketMs;
  const bytesPerSecond = (edge.bucketBytes * 1_000) / bucketMs;
  if (requestsPerSecond > edge.peakRequestsPerSecond) {
    edge.peakRequestsPerSecond = requestsPerSecond;
  }
  if (bytesPerSecond > edge.peakBytesPerSecond) {
    edge.peakBytesPerSecond = bytesPerSecond;
  }
  edge.bucketRequests = 0;
  edge.bucketBytes = 0;
}

export function edgeMetrics(edge: EdgeRuntime): AudienceLinkMetrics {
  return {
    edgeId: edge.edgeId,
    from: edge.from,
    to: edge.to,
    role: edge.role,
    requests: { ...edge.requests },
    requestsTotal: edge.requestsTotal,
    bytesOffered: edge.bytesOffered,
    bytesDelivered: edge.bytesDelivered,
    peakRequestsPerSecond: edge.peakRequestsPerSecond,
    peakBytesPerSecond: edge.peakBytesPerSecond,
  };
}
