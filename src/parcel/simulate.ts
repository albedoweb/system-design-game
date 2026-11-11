import { SimulationEventHeap } from '../engine/eventHeap';
import { TrafficSampler, notifyTraffic, trafficSampleStepMs, type TrafficScope } from '../engine/trafficSampling';
import type {
  TrafficEdge,
  TrafficNode,
  TrafficObserver,
  TrafficResource,
} from '../simulation/traffic-telemetry';
import { PARCEL_CATALOG } from './catalog';
import { PARCEL_LEVEL } from './level';
import {
  appWork,
  historyWork,
  reportWork,
  statusWork,
  storeDataset,
  taskDemand,
  writeEventWork,
  type ParcelTaskDemand,
  type ParcelWorkVector,
} from './model';
import {
  PARCEL_BUSINESS_OPERATIONS,
  type ParcelBusinessOperation,
  type ParcelCheck,
  type ParcelDiagnostic,
  type ParcelEdge,
  type ParcelGraph,
  type ParcelHorizonYears,
  type ParcelNode,
  type ParcelNodeMetrics,
  type ParcelNodeOperationMetrics,
  type ParcelOperation,
  type ParcelOperationMetrics,
  type ParcelOperationMetricsMap,
  type ParcelWorkloadSummary,
} from './contracts';
import { historyAgeDays, type ParcelTrace } from './workload';

const MAX_EVENTS_PER_HORIZON = 4_000_000;
const REPLICA_BATCH_MS_DEFAULT = 50;
const REPORT_CPU_PARALLEL = 16;
const REPLICATION_CPU_PARALLEL = 4;
const PRIORITY_REPLICATION_FLUSH = 0;
const PRIORITY_COMPLETION = 2;

type FinalState = 'success' | 'rejected' | 'missing' | 'timeout' | 'stale';
type Lane = 'cpu' | 'io' | 'net';

interface RequestRuntime {
  readonly id: number;
  readonly operation: ParcelBusinessOperation;
  readonly arrivalMs: number;
  readonly deadlineMs: number;
  readonly targetId: string;
  readonly primaryId: string;
  readonly appNode: SimNode;
  readonly targetNode: SimNode;
  readonly oldHistory: boolean;
  readonly warehouseId: number | null;
  freshnessLagMs: number;
  queueWaitMs: number;
  appCompleted: boolean;
  finalized: boolean;
}

interface TaskRuntime {
  readonly id: number;
  readonly node: SimNode;
  readonly operation: ParcelOperation;
  readonly business: ParcelBusinessOperation | null;
  readonly request: RequestRuntime | null;
  readonly work: ParcelWorkVector;
  readonly demand: ParcelTaskDemand;
  readonly enqueueMs: number;
  readonly replicationSeqStart: number | null;
  readonly replicationSeqEnd: number | null;
  startMs: number;
  cpuReleased: boolean;
  ioReleased: boolean;
  netReleased: boolean;
}

interface NodeOperationAccumulator {
  requests: number;
  completed: number;
  errors: number;
  timedOut: number;
  durations: number[];
}

interface NodeAccumulator {
  requests: number;
  completed: number;
  errors: number;
  timedOut: number;
  rejected: number;
  queueWaits: number[];
  durations: number[];
  bytesRead: number;
  bytesWritten: number;
  operations: Map<ParcelOperation, NodeOperationAccumulator>;
}

class SimNode {
  readonly node: ParcelNode;
  readonly cores: number;
  readonly ioLanes: number;
  readonly networkLanes: number;
  readonly maxQueueDepth: number;
  readonly observationEndMs: number;
  readonly queue: TaskRuntime[] = [];
  queueHead = 0;
  cpuUsed = 0;
  ioUsed = 0;
  netUsed = 0;
  lastChangeMs: number;
  cpuArea = 0;
  ioArea = 0;
  netArea = 0;
  queueArea = 0;
  peakCpuUsed = 0;
  peakIoUsed = 0;
  peakNetUsed = 0;
  peakQueue = 0;
  readonly accumulator: NodeAccumulator = {
    requests: 0,
    completed: 0,
    errors: 0,
    timedOut: 0,
    rejected: 0,
    queueWaits: [],
    durations: [],
    bytesRead: 0,
    bytesWritten: 0,
    operations: new Map(),
  };

  constructor(node: ParcelNode, startMs: number, observationEndMs: number) {
    this.node = node;
    const hardware = PARCEL_CATALOG.hardware[node.config.size];
    this.cores = hardware.cpuCores;
    this.ioLanes = hardware.ioLanes;
    this.networkLanes = hardware.networkLanes;
    this.observationEndMs = observationEndMs;
    this.maxQueueDepth = Math.max(
      1,
      Math.floor(
        hardware.cpuCores * PARCEL_CATALOG.service.queueLimitPerCore,
      ),
    );
    this.lastChangeMs = startMs;
  }

  get queueLength(): number {
    return this.queue.length - this.queueHead;
  }

  touch(nowMs: number): void {
    // Resource/queue averages describe the offered traffic window 0..60s.
    // Drain work still runs and is checked by deadlines, but empty drain time
    // must not halve a fully busy offered window.
    const from = Math.min(this.lastChangeMs, this.observationEndMs);
    const to = Math.min(nowMs, this.observationEndMs);
    const elapsed = Math.max(0, to - from);
    this.cpuArea += this.cpuUsed * elapsed;
    this.ioArea += this.ioUsed * elapsed;
    this.netArea += this.netUsed * elapsed;
    this.queueArea += this.queueLength * elapsed;
    this.lastChangeMs = nowMs;
  }

  recordTask(task: TaskRuntime): void {
    this.accumulator.requests += 1;
    let op = this.accumulator.operations.get(task.operation);
    if (!op) {
      op = { requests: 0, completed: 0, errors: 0, timedOut: 0, durations: [] };
      this.accumulator.operations.set(task.operation, op);
    }
    op.requests += 1;
  }

  enqueue(task: TaskRuntime, nowMs: number): void {
    this.touch(nowMs);
    this.queue.push(task);
    if (
      nowMs <= this.observationEndMs &&
      this.queueLength > this.peakQueue
    ) {
      this.peakQueue = this.queueLength;
    }
  }

  canStart(demand: ParcelTaskDemand): boolean {
    return (
      this.cpuUsed + demand.cpuUnits <= this.cores &&
      this.ioUsed + demand.ioUnits <= this.ioLanes &&
      this.netUsed + demand.netUnits <= this.networkLanes
    );
  }

  start(task: TaskRuntime, nowMs: number): void {
    this.touch(nowMs);
    this.cpuUsed += task.demand.cpuUnits;
    this.ioUsed += task.demand.ioUnits;
    this.netUsed += task.demand.netUnits;
    task.cpuReleased = task.demand.cpuUnits === 0;
    task.ioReleased = task.demand.ioUnits === 0;
    task.netReleased = task.demand.netUnits === 0;
    if (nowMs <= this.observationEndMs) {
      if (this.cpuUsed > this.peakCpuUsed) {
        this.peakCpuUsed = this.cpuUsed;
      }
      if (this.ioUsed > this.peakIoUsed) {
        this.peakIoUsed = this.ioUsed;
      }
      if (this.netUsed > this.peakNetUsed) {
        this.peakNetUsed = this.netUsed;
      }
    }
    this.accumulator.queueWaits.push(nowMs - task.enqueueMs);
  }

  releaseLane(task: TaskRuntime, lane: Lane, nowMs: number): void {
    this.touch(nowMs);
    if (lane === 'cpu' && !task.cpuReleased) {
      task.cpuReleased = true;
      this.cpuUsed -= task.demand.cpuUnits;
    } else if (lane === 'io' && !task.ioReleased) {
      task.ioReleased = true;
      this.ioUsed -= task.demand.ioUnits;
    } else if (lane === 'net' && !task.netReleased) {
      task.netReleased = true;
      this.netUsed -= task.demand.netUnits;
    }
  }

  complete(task: TaskRuntime, nowMs: number): void {
    this.touch(nowMs);
    if (!task.cpuReleased) {
      task.cpuReleased = true;
      this.cpuUsed -= task.demand.cpuUnits;
    }
    if (!task.ioReleased) {
      task.ioReleased = true;
      this.ioUsed -= task.demand.ioUnits;
    }
    if (!task.netReleased) {
      task.netReleased = true;
      this.netUsed -= task.demand.netUnits;
    }
    this.accumulator.completed += 1;
    this.accumulator.durations.push(nowMs - task.enqueueMs);
    this.accumulator.bytesRead += task.work.bytesRead;
    this.accumulator.bytesWritten += task.work.bytesWritten;
    const op = this.accumulator.operations.get(task.operation);
    if (op) {
      op.completed += 1;
      op.durations.push(nowMs - task.enqueueMs);
    }
  }

  flush(nowMs: number): void {
    this.touch(nowMs);
  }
}

interface OpAccumulator {
  offered: number;
  success: number;
  rejected: number;
  timedOut: number;
  missedData: number;
  stale: number;
  unfinished: number;
  successLatencies: number[];
  freshness: number[];
  queueWaits: number[];
  rowsScanned: number;
  bytesRead: number;
  bytesWritten: number;
  errors: Map<string, number>;
}

function newOpAccumulator(): OpAccumulator {
  return {
    offered: 0,
    success: 0,
    rejected: 0,
    timedOut: 0,
    missedData: 0,
    stale: 0,
    unfinished: 0,
    successLatencies: [],
    freshness: [],
    queueWaits: [],
    rowsScanned: 0,
    bytesRead: 0,
    bytesWritten: 0,
    errors: new Map(),
  };
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(rank - 1, sorted.length - 1)] ?? 0;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function operationMetrics(
  operation: ParcelBusinessOperation,
  accumulator: OpAccumulator,
): ParcelOperationMetrics {
  const offered = accumulator.offered;
  const latencyP50 = percentile(accumulator.successLatencies, 0.5);
  const latencyP95 = percentile(accumulator.successLatencies, 0.95);
  const latencyP99 = percentile(accumulator.successLatencies, 0.99);
  const failures = offered - accumulator.success;
  const errors = Object.fromEntries(
    [...accumulator.errors.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    operation,
    sampleFactor: PARCEL_LEVEL.workload.sampleFactor,
    counts: {
      sampled: offered,
      offered,
      success: accumulator.success,
      failed: failures,
      rejected: accumulator.rejected,
      timedOut: accumulator.timedOut,
      missedData: accumulator.missedData,
      stale: accumulator.stale,
      unfinished: accumulator.unfinished,
    },
    availability: offered > 0 ? accumulator.success / offered : 0,
    latencyP50Ms: latencyP50,
    latencyP95Ms: latencyP95,
    latencyP99Ms: latencyP99,
    timeoutCount: accumulator.timedOut,
    rejectCount: accumulator.rejected,
    successP95Ms: latencyP95,
    queueWaitP95Ms: percentile(accumulator.queueWaits, 0.95),
    freshnessP95Ms:
      accumulator.freshness.length > 0
        ? percentile(accumulator.freshness, 0.95)
        : null,
    freshnessMaxMs:
      accumulator.freshness.length > 0
        ? accumulator.freshness.reduce(
            (maximum, value) => (value > maximum ? value : maximum),
            0,
          )
        : null,
    rowsScanned: accumulator.rowsScanned,
    bytesRead: accumulator.bytesRead,
    bytesWritten: accumulator.bytesWritten,
    estimatedThroughputPerSec:
      accumulator.success / (PARCEL_LEVEL.durationMs / 1000),
    errorsByCode: errors,
  };
}

function nodeMetrics(node: SimNode, elapsedMs: number): ParcelNodeMetrics {
  const acc = node.accumulator;
  const operations: Partial<
    Record<ParcelOperation, ParcelNodeOperationMetrics>
  > = {};
  for (const [operation, op] of acc.operations) {
    operations[operation] = {
      requests: op.requests,
      completed: op.completed,
      errors: op.errors,
      timedOut: op.timedOut,
      p95Ms: percentile(op.durations, 0.95),
    };
  }
  return {
    nodeId: node.node.id,
    kind: node.node.kind,
    label: node.node.label,
    requests: acc.requests,
    completed: acc.completed,
    errors: acc.errors,
    timedOut: acc.timedOut,
    rejected: acc.rejected,
    averageCpuUtilization:
      elapsedMs > 0 ? node.cpuArea / (node.cores * elapsedMs) : 0,
    peakCpuUtilization: node.cores > 0 ? node.peakCpuUsed / node.cores : 0,
    averageIoUtilization:
      elapsedMs > 0 ? node.ioArea / (node.ioLanes * elapsedMs) : 0,
    peakIoUtilization: node.ioLanes > 0 ? node.peakIoUsed / node.ioLanes : 0,
    averageNetworkUtilization:
      elapsedMs > 0 ? node.netArea / (node.networkLanes * elapsedMs) : 0,
    peakNetworkUtilization:
      node.networkLanes > 0 ? node.peakNetUsed / node.networkLanes : 0,
    averageQueueDepth: elapsedMs > 0 ? node.queueArea / elapsedMs : 0,
    peakQueueDepth: node.peakQueue,
    queueWaitP95Ms: percentile(acc.queueWaits, 0.95),
    bytesRead: acc.bytesRead,
    bytesWritten: acc.bytesWritten,
    operations,
  };
}

function routeTargets(graph: ParcelGraph): {
  app: ParcelNode;
  primary: ParcelNode | null;
  targets: Map<ParcelBusinessOperation, string>;
  replicas: ParcelEdge[];
} {
  const app = graph.nodes.find((node) => node.kind === 'app');
  if (!app) {
    throw new Error('Validated graph has no application node.');
  }
  const targets = new Map<ParcelBusinessOperation, string>();
  for (const edge of graph.edges) {
    if (edge.source === app.id && edge.operation !== 'traffic' && edge.operation !== 'replicate') {
      targets.set(edge.operation as ParcelBusinessOperation, edge.target);
    }
  }
  const primaryId = targets.get('ingest');
  const primary = graph.nodes.find((node) => node.id === primaryId) ?? null;
  return {
    app,
    primary,
    targets,
    replicas: graph.edges.filter((edge) => edge.operation === 'replicate'),
  };
}

interface ReplicaBuffer {
  readonly target: SimNode;
  readonly intervalMs: number;
  pendingEvents: number;
  pendingFirstSeq: number;
  pendingLastSeq: number;
  scheduled: boolean;
  /** Out-of-order completed batch ranges, keyed by sequence start. */
  readonly completedRanges: Map<number, number>;
  nextContiguousSeq: number;
  overflowReported: boolean;
}

export interface ParcelSimulationResult {
  readonly workload: ParcelWorkloadSummary;
  readonly operations: ParcelOperationMetricsMap;
  readonly nodes: readonly ParcelNodeMetrics[];
  readonly diagnostics: readonly ParcelDiagnostic[];
  readonly exhausted: boolean;
  readonly historical: {
    readonly offered: number;
    readonly success: number;
  };
  readonly dataIntegrity: {
    readonly replicationBatchesDropped: number;
    readonly replicationEventsDropped: number;
    readonly sampledReplicationGap: boolean;
  };
}

/**
 * Deterministic discrete-event simulation for one horizon. Arrivals are
 * generated from the frozen trace; only completions and replication flushes
 * enter the heap.
 */
export function simulateParcelHorizon(
  graph: ParcelGraph,
  horizonYears: ParcelHorizonYears,
  trace: ParcelTrace,
  onTraffic?: TrafficObserver,
): ParcelSimulationResult {
  const startMs = 0;
  const endMs = PARCEL_LEVEL.durationMs + PARCEL_LEVEL.drainMs;
  const nodes = new Map<string, SimNode>();
  const observationEndMs = PARCEL_LEVEL.durationMs;
  for (const node of graph.nodes) {
    nodes.set(node.id, new SimNode(node, startMs, observationEndMs));
  }
  const { app, primary, targets, replicas } = routeTargets(graph);
  const appNode = nodes.get(app.id);
  if (!appNode) {
    throw new Error('Validated graph has no application runtime.');
  }
  const primaryNode = primary ? nodes.get(primary.id) ?? null : null;
  const primaryId = primary?.id ?? '';

  const operations = new Map<ParcelBusinessOperation, OpAccumulator>();
  for (const operation of PARCEL_BUSINESS_OPERATIONS) {
    operations.set(operation, newOpAccumulator());
  }
  const diagnostics: ParcelDiagnostic[] = [];
  const pendingRequests: RequestRuntime[] = [];
  const heap = new SimulationEventHeap();
  let nextRequestId = 0;
  let processedEvents = 0;
  let exhausted = false;
  let latestAckMs = 0;
  const ackTimes: number[] = [];
  const historical = { offered: 0, success: 0 };
  const dataIntegrity = {
    replicationBatchesDropped: 0,
    replicationEventsDropped: 0,
    sampledReplicationGap: false,
  };
  const replicaUpTo = new Map<string, number>();
  const buffers = new Map<string, ReplicaBuffer>();
  const replicaEdgeByTarget = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.operation === 'replicate') {
      replicaEdgeByTarget.set(edge.target, edge.id);
    }
  }

  for (const edge of replicas) {
    const target = nodes.get(edge.target);
    if (target) {
      const configured = target.node.config.batchIntervalMs;
      const intervalMs =
        target.node.kind === 'columnar'
          ? (configured ?? 1_000)
          : REPLICA_BATCH_MS_DEFAULT;
      replicaUpTo.set(edge.target, 0);
      buffers.set(edge.target, {
        target,
        intervalMs: Math.max(1, intervalMs),
        pendingEvents: 0,
        pendingFirstSeq: -1,
        pendingLastSeq: -1,
        scheduled: false,
        completedRanges: new Map(),
        nextContiguousSeq: 0,
        overflowReported: false,
      });
    }
  }

  // Optional observational telemetry: separate counters and read-only area
  // deltas over the existing accumulators. It never enters the event heap.
  const trafficScope: TrafficScope = {
    levelId: 'parcel-pulse',
    scopeId: `year-${horizonYears}`,
    scopeLabel: `Year ${horizonYears}`,
    startMs,
    measuredFromMs: 0,
    measuredEndMs: observationEndMs,
    drainEndMs: endMs,
    postludeEndMs: endMs,
  };
  const trafficEdgeIds = new Map<string, string>();
  for (const edge of graph.edges) {
    trafficEdgeIds.set(
      `${edge.source}|${edge.target}|${edge.operation}`,
      edge.id,
    );
  }
  const trafficSampler = onTraffic
    ? new TrafficSampler(
        graph.edges.map((edge) => edge.id),
        graph.nodes.map((node) => node.id),
        trafficScope,
      )
    : null;
  const trafficStep = trafficSampleStepMs(trafficScope);
  let nextTrafficBoundary = startMs + trafficStep;
  let lastTrafficBoundary = startMs;
  const clientNodeId =
    graph.nodes.find((node) => node.kind === 'client')?.id ?? '';
  const sampledAreas = new Map<
    string,
    { cpu: number; io: number; net: number }
  >();
  for (const node of graph.nodes) {
    sampledAreas.set(node.id, { cpu: 0, io: 0, net: 0 });
  }
  const noteEdge = (
    source: string,
    target: string,
    operation: ParcelOperation,
  ): void => {
    if (!trafficSampler) {
      return;
    }
    const edgeId = trafficEdgeIds.get(`${source}|${target}|${operation}`);
    if (edgeId) {
      trafficSampler.countEdge(edgeId);
    }
  };
  const trafficArea = (
    node: SimNode,
    atMs: number,
  ): { cpu: number; io: number; net: number } => {
    const to = Math.min(atMs, observationEndMs);
    const elapsed = Math.max(0, to - node.lastChangeMs);
    return {
      cpu: node.cpuArea + node.cpuUsed * elapsed,
      io: node.ioArea + node.ioUsed * elapsed,
      net: node.netArea + node.netUsed * elapsed,
    };
  };
  const emitTrafficFrame = (boundaryMs: number): void => {
    if (!trafficSampler) {
      return;
    }
    const frame = trafficSampler.sample(boundaryMs, (context) => {
      const inWindow = boundaryMs <= observationEndMs;
      const frameNodes: TrafficNode[] = graph.nodes.map((graphNode) => {
        const runtime = nodes.get(graphNode.id);
        if (!runtime) {
          return {
            nodeId: graphNode.id,
            resources: [],
            requestsPerSecond: context.nodeRps(graphNode.id),
            queue: null,
            down: false,
          };
        }
        if (graphNode.kind === 'client') {
          return {
            nodeId: graphNode.id,
            resources: [],
            requestsPerSecond: context.nodeRps(graphNode.id),
            queue: null,
            down: false,
          };
        }
        let cpuUsed = runtime.cpuUsed;
        let ioUsed = runtime.ioUsed;
        let netUsed = runtime.netUsed;
        let aggregation: TrafficResource['aggregation'] = 'instant';
        if (inWindow) {
          const area = trafficArea(runtime, boundaryMs);
          const previous = sampledAreas.get(graphNode.id) ?? {
            cpu: 0,
            io: 0,
            net: 0,
          };
          if (context.windowMs > 0) {
            cpuUsed = Math.max(0, (area.cpu - previous.cpu) / context.windowMs);
            ioUsed = Math.max(0, (area.io - previous.io) / context.windowMs);
            netUsed = Math.max(0, (area.net - previous.net) / context.windowMs);
          }
          sampledAreas.set(graphNode.id, area);
          aggregation = 'window-average';
        }
        const resources: TrafficResource[] = [
          {
            key: 'cpu',
            label: 'CPU cores',
            used: cpuUsed,
            capacity: runtime.cores,
            unit: 'cores',
            aggregation,
          },
          {
            key: 'io',
            label: 'IO lanes',
            used: ioUsed,
            capacity: runtime.ioLanes,
            unit: 'lanes',
            aggregation,
          },
          {
            key: 'network',
            label: 'Network lanes',
            used: netUsed,
            capacity: runtime.networkLanes,
            unit: 'lanes',
            aggregation,
          },
        ];
        return {
          nodeId: graphNode.id,
          resources,
          requestsPerSecond: context.nodeRps(graphNode.id),
          queue: runtime.queueLength,
          down: false,
        };
      });
      const frameEdges: TrafficEdge[] = graph.edges.map((edge) => ({
        edgeId: edge.id,
        requestsPerSecond: context.edgeRps(edge.id),
        bytesPerSecond: null,
      }));
      return { nodes: frameNodes, edges: frameEdges };
    });
    if (frame) {
      lastTrafficBoundary = boundaryMs;
      notifyTraffic(onTraffic, frame);
    }
  };

  const recordNodeFailure = (
    node: SimNode,
    operation: ParcelOperation,
    kind: 'rejected' | 'error' | 'timeout',
  ): void => {
    if (kind === 'rejected') {
      node.accumulator.rejected += 1;
    }
    if (kind === 'timeout') {
      node.accumulator.timedOut += 1;
    }
    node.accumulator.errors += 1;
    const op = node.accumulator.operations.get(operation);
    if (op) {
      op.errors += 1;
      if (kind === 'timeout') {
        op.timedOut += 1;
      }
    }
  };

  const finalize = (
    request: RequestRuntime,
    completionMs: number,
    state: FinalState,
    work: ParcelWorkVector | null,
    failingNode: SimNode = request.targetNode,
  ): void => {
    if (request.finalized) {
      return;
    }
    request.finalized = true;
    if (request.oldHistory) {
      historical.offered += 1;
    }
    const accumulator = operations.get(request.operation);
    if (!accumulator) {
      return;
    }
    const latency = Math.max(0, completionMs - request.arrivalMs);
    accumulator.queueWaits.push(request.queueWaitMs);
    if (work) {
      accumulator.rowsScanned += work.rows;
      accumulator.bytesRead += work.bytesRead;
      accumulator.bytesWritten += work.bytesWritten;
    }
    if (request.operation === 'status' || request.operation === 'report') {
      accumulator.freshness.push(request.freshnessLagMs);
    }
    if (state === 'success') {
      accumulator.success += 1;
      accumulator.successLatencies.push(latency);
      if (request.oldHistory) {
        historical.success += 1;
      }
      return;
    }
    if (state === 'rejected') {
      accumulator.rejected += 1;
      increment(accumulator.errors, 'rejected');
      recordNodeFailure(failingNode, request.operation, 'rejected');
    } else if (state === 'missing') {
      accumulator.missedData += 1;
      increment(accumulator.errors, 'missing_data');
      recordNodeFailure(failingNode, request.operation, 'error');
    } else if (state === 'timeout') {
      accumulator.timedOut += 1;
      increment(accumulator.errors, 'timeout');
      recordNodeFailure(failingNode, request.operation, 'timeout');
    } else {
      accumulator.stale += 1;
      increment(accumulator.errors, 'stale');
      recordNodeFailure(failingNode, request.operation, 'error');
    }
  };

  const canStart = (node: SimNode, task: TaskRuntime): boolean =>
    node.canStart(task.demand);

  const drain = (node: SimNode, nowMs: number): void => {
    while (node.queueLength > 0) {
      const task = node.queue[node.queueHead];
      if (!task || !canStart(node, task)) {
        return;
      }
      node.queueHead += 1;
      startTask(node, task, nowMs);
      if (node.queueHead > 256 && node.queueHead * 2 > node.queue.length) {
        node.queue.splice(0, node.queueHead);
        node.queueHead = 0;
      }
    }
  };

  const markReplicated = (
    buffer: ReplicaBuffer,
    seqStart: number,
    seqEnd: number,
  ): void => {
    if (seqEnd < buffer.nextContiguousSeq) {
      return;
    }
    buffer.completedRanges.set(seqStart, seqEnd);
    while (buffer.completedRanges.has(buffer.nextContiguousSeq)) {
      const rangeEnd = buffer.completedRanges.get(buffer.nextContiguousSeq);
      if (rangeEnd === undefined) {
        break;
      }
      buffer.completedRanges.delete(buffer.nextContiguousSeq);
      buffer.nextContiguousSeq = rangeEnd + 1;
      const replicatedAck = ackTimes[rangeEnd];
      if (replicatedAck !== undefined) {
        const previous = replicaUpTo.get(buffer.target.node.id) ?? 0;
        if (replicatedAck > previous) {
          replicaUpTo.set(buffer.target.node.id, replicatedAck);
        }
      }
    }
  };

  const completeTask = (task: TaskRuntime, nowMs: number): void => {
    processedEvents += 1;
    if (processedEvents > MAX_EVENTS_PER_HORIZON) {
      exhausted = true;
      return;
    }
    task.node.complete(task, nowMs);
    if (task.operation === 'replicate') {
      const buffer = buffers.get(task.node.node.id);
      if (
        buffer &&
        task.replicationSeqStart !== null &&
        task.replicationSeqEnd !== null
      ) {
        markReplicated(buffer, task.replicationSeqStart, task.replicationSeqEnd);
      }
      drain(task.node, nowMs);
      return;
    }
    const request = task.request;
    if (request) {
      if (task.business === request.operation && task.node === request.appNode) {
        request.appCompleted = true;
        noteEdge(
          request.appNode.node.id,
          request.targetNode.node.id,
          request.operation,
        );
        const targetNode = request.targetNode;
        const work = request.operation === 'ingest'
          ? writeEventWork(targetNode.node, 1)
          : request.operation === 'status'
            ? statusWork(targetNode.node, storeDataset(targetNode.node, horizonYears))
            : request.operation === 'history'
              ? historyWork(
                  targetNode.node,
                  storeDataset(targetNode.node, horizonYears),
                  historyAgeDays(request.oldHistory, horizonYears, request.id),
                )
              : reportWork(
                  targetNode.node,
                  storeDataset(targetNode.node, horizonYears),
                );
        const parallel =
          request.operation === 'report'
            ? Math.min(targetNode.cores, REPORT_CPU_PARALLEL)
            : 1;
        const accepted = enqueueTask(
          targetNode,
          {
            operation: request.operation,
            business: request.operation,
            request,
            work,
            demand: taskDemand(targetNode.node, work, parallel),
            enqueueMs: nowMs,
            replicationSeqStart: null,
            replicationSeqEnd: null,
          },
          nowMs,
        );
        if (!accepted) {
          const accumulator = operations.get(request.operation);
          if (accumulator) {
            increment(accumulator.errors, 'queue_full');
          }
          finalize(request, nowMs, 'rejected', null, targetNode);
        }
      } else {
        const work = task.work;
        if (work.missingData) {
          finalize(request, nowMs, 'missing', work);
        } else {
          if (request.operation === 'ingest') {
            // A durable commit happens even if the caller response missed its
            // deadline. Replication is triggered from storage completion, not
            // from client success.
            const ackSeq = ackTimes.length;
            ackTimes.push(nowMs);
            latestAckMs = Math.max(latestAckMs, nowMs);
            scheduleReplication(ackSeq, nowMs);
          }
          const onTime = nowMs - request.arrivalMs <= request.deadlineMs;
          const stale =
            (request.operation === 'status' || request.operation === 'report') &&
            request.freshnessLagMs >
              (request.operation === 'status'
                ? PARCEL_LEVEL.slo.freshnessMs.status
                : PARCEL_LEVEL.slo.freshnessMs.report);
          if (!onTime) {
            finalize(request, nowMs, 'timeout', work);
          } else if (stale) {
            finalize(request, nowMs, 'stale', work);
          } else {
            finalize(request, nowMs, 'success', work);
          }
        }
      }
    }
    drain(task.node, nowMs);
  };

  const releaseTaskLane = (task: TaskRuntime, lane: Lane, nowMs: number): void => {
    processedEvents += 1;
    if (processedEvents > MAX_EVENTS_PER_HORIZON) {
      exhausted = true;
      return;
    }
    task.node.releaseLane(task, lane, nowMs);
    drain(task.node, nowMs);
  };

  const startTask = (node: SimNode, task: TaskRuntime, nowMs: number): void => {
    const waitMs = nowMs - task.enqueueMs;
    if (task.request) {
      task.request.queueWaitMs += waitMs;
      if (
        task.node === task.request.targetNode &&
        (task.request.operation === 'status' ||
          task.request.operation === 'report')
      ) {
        task.request.freshnessLagMs =
          task.request.targetId === primaryId
            ? 0
            : Math.max(
                0,
                latestAckMs -
                  (replicaUpTo.get(task.request.targetId) ?? 0),
              );
      }
    }
    node.start(task, nowMs);
    const completionMs = nowMs + task.demand.serviceMs;
    const laneReleases: [Lane, number, number][] = [
      ['cpu', task.demand.cpuUnits, task.demand.cpuServiceMs],
      ['io', task.demand.ioUnits, task.demand.ioServiceMs],
      ['net', task.demand.netUnits, task.demand.netServiceMs],
    ];
    for (const [lane, units, laneMs] of laneReleases) {
      if (units > 0 && laneMs < task.demand.serviceMs - 1e-9) {
        const releaseAt = nowMs + laneMs;
        heap.push(releaseAt, 1, () => releaseTaskLane(task, lane, releaseAt));
      }
    }
    heap.push(completionMs, PRIORITY_COMPLETION, () =>
      completeTask(task, completionMs),
    );
  };

  const enqueueTask = (
    node: SimNode,
    partial: {
      operation: ParcelOperation;
      business: ParcelBusinessOperation | null;
      request: RequestRuntime | null;
      work: ParcelWorkVector;
      demand: ParcelTaskDemand;
      enqueueMs: number;
      replicationSeqStart: number | null;
      replicationSeqEnd: number | null;
    },
    nowMs: number,
  ): boolean => {
    if (trafficSampler) {
      trafficSampler.countNode(node.node.id);
    }
    const task: TaskRuntime = {
      id: nextRequestId++,
      node,
      operation: partial.operation,
      business: partial.business,
      request: partial.request,
      work: partial.work,
      demand: partial.demand,
      enqueueMs: partial.enqueueMs,
      replicationSeqStart: partial.replicationSeqStart,
      replicationSeqEnd: partial.replicationSeqEnd,
      startMs: -1,
      cpuReleased: partial.demand.cpuUnits === 0,
      ioReleased: partial.demand.ioUnits === 0,
      netReleased: partial.demand.netUnits === 0,
    };
    node.recordTask(task);
    if (node.queueLength === 0 && node.canStart(task.demand)) {
      startTask(node, task, nowMs);
      return true;
    }
    if (node.queueLength >= node.maxQueueDepth) {
      return false;
    }
    node.enqueue(task, nowMs);
    return true;
  };

  const scheduleReplication = (ackSeq: number, nowMs: number): void => {
    for (const buffer of buffers.values()) {
      if (buffer.pendingEvents === 0) {
        buffer.pendingFirstSeq = ackSeq;
      }
      buffer.pendingEvents += 1;
      buffer.pendingLastSeq = ackSeq;
      if (!buffer.scheduled) {
        buffer.scheduled = true;
        const flushAt = nowMs + buffer.intervalMs;
        heap.push(flushAt, PRIORITY_REPLICATION_FLUSH, () =>
          flushReplica(buffer, flushAt),
        );
      }
    }
  };

  const flushReplica = (buffer: ReplicaBuffer, nowMs: number): void => {
    buffer.scheduled = false;
    const events = buffer.pendingEvents;
    const seqStart = buffer.pendingFirstSeq;
    const seqEnd = buffer.pendingLastSeq;
    buffer.pendingEvents = 0;
    buffer.pendingFirstSeq = -1;
    buffer.pendingLastSeq = -1;
    if (events <= 0 || seqStart < 0 || seqEnd < 0) {
      return;
    }
    const work = writeEventWork(buffer.target.node, events);
    const parallel = Math.min(buffer.target.cores, REPLICATION_CPU_PARALLEL);
    const replicaEdgeId = replicaEdgeByTarget.get(buffer.target.node.id);
    if (trafficSampler && replicaEdgeId) {
      trafficSampler.countEdge(replicaEdgeId);
    }
    const accepted = enqueueTask(
      buffer.target,
      {
        operation: 'replicate',
        business: null,
        request: null,
        work,
        demand: taskDemand(buffer.target.node, work, parallel),
        enqueueMs: nowMs,
        replicationSeqStart: seqStart,
        replicationSeqEnd: seqEnd,
      },
      nowMs,
    );
    if (!accepted) {
      dataIntegrity.replicationBatchesDropped += 1;
      dataIntegrity.replicationEventsDropped += events;
      dataIntegrity.sampledReplicationGap = true;
      recordNodeFailure(buffer.target, 'replicate', 'rejected');
      if (!buffer.overflowReported) {
        buffer.overflowReported = true;
        diagnostics.push({
          id: `replication_overflow:${buffer.target.node.id}`,
          severity: 'error',
          code: 'replication_queue_overflow',
          message: `"${buffer.target.node.label}" rejected a replication batch because its bounded queue was full. Freshness cannot advance across the missing sequence and the horizon cannot pass.`,
          nodeId: buffer.target.node.id,
          horizonYears,
          value: events,
        });
      }
    }
  };

  interface Arrival {
    operation: ParcelBusinessOperation;
    timeMs: number;
    key: number;
    old: boolean;
    warehouseId: number;
  }

  // Fixed report schedule and independent Poisson streams. Peeking must never
  // consume an arrival: a completion may be processed first.
  let statusIndex = 0;
  let historyIndex = 0;
  let ingestIndex = 0;
  let reportIndex = 0;

  const peekArrival = (): Arrival | null => {
    const candidates: (Arrival & { order: number })[] = [];
    if (statusIndex < trace.statusTimes.length) {
      candidates.push({
        operation: 'status',
        timeMs: trace.statusTimes[statusIndex] ?? Number.POSITIVE_INFINITY,
        key: trace.statusKeys[statusIndex] ?? 0,
        old: false,
        warehouseId: -1,
        order: 0,
      });
    }
    if (historyIndex < trace.historyTimes.length) {
      candidates.push({
        operation: 'history',
        timeMs: trace.historyTimes[historyIndex] ?? Number.POSITIVE_INFINITY,
        key: trace.historyKeys[historyIndex] ?? 0,
        old: (trace.historyOld[historyIndex] ?? 0) === 1,
        warehouseId: -1,
        order: 1,
      });
    }
    if (ingestIndex < trace.ingestTimes.length) {
      candidates.push({
        operation: 'ingest',
        timeMs: trace.ingestTimes[ingestIndex] ?? Number.POSITIVE_INFINITY,
        key: trace.ingestKeys[ingestIndex] ?? 0,
        old: false,
        warehouseId: -1,
        order: 2,
      });
    }
    if (reportIndex < trace.reports.length) {
      const report = trace.reports[reportIndex];
      candidates.push({
        operation: 'report',
        timeMs: report?.timeMs ?? Number.POSITIVE_INFINITY,
        key: 0,
        old: false,
        warehouseId: report?.warehouseId ?? -1,
        order: 3,
      });
    }
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => a.timeMs - b.timeMs || a.order - b.order);
    return candidates[0] ?? null;
  };

  const consumeArrival = (operation: ParcelBusinessOperation): void => {
    if (operation === 'status') {
      statusIndex += 1;
    } else if (operation === 'history') {
      historyIndex += 1;
    } else if (operation === 'ingest') {
      ingestIndex += 1;
    } else {
      reportIndex += 1;
    }
  };

  let pendingArrival: Arrival | null | undefined;
  for (;;) {
    if (exhausted) {
      break;
    }
    if (pendingArrival === undefined) {
      pendingArrival = peekArrival();
    }
    const arrival = pendingArrival;
    const completion = heap.peek();
    const arrivalTime = arrival?.timeMs ?? Number.POSITIVE_INFINITY;
    const completionTime = completion?.timeMs ?? Number.POSITIVE_INFINITY;
    if (trafficSampler) {
      const horizon = Math.min(
        arrivalTime < completionTime ? arrivalTime : completionTime,
        endMs,
      );
      while (nextTrafficBoundary < horizon) {
        emitTrafficFrame(nextTrafficBoundary);
        nextTrafficBoundary += trafficStep;
      }
    }
    if (arrivalTime > endMs && completionTime > endMs) {
      break;
    }
    if (arrival && arrivalTime <= completionTime) {
      if (arrivalTime > endMs) {
        break;
      }
      consumeArrival(arrival.operation);
      pendingArrival = undefined;
      processedEvents += 1;
      if (trafficSampler) {
        trafficSampler.countNode(clientNodeId);
      }
      if (processedEvents > MAX_EVENTS_PER_HORIZON) {
        exhausted = true;
        break;
      }
      const operation = arrival.operation;
      const targetId = targets.get(operation);
      const targetNode = targetId ? nodes.get(targetId) : undefined;
      const accumulator = operations.get(operation);
      if (accumulator) {
        accumulator.offered += 1;
      }
      if (!targetNode || !accumulator) {
        // Validation blocks this in normal use; a direct evaluator call still
        // fails safely instead of inventing a success.
        if (primaryNode) {
          primaryNode.accumulator.rejected += 1;
        }
        const synthetic: RequestRuntime = {
          id: nextRequestId++,
          operation,
          arrivalMs: arrivalTime,
          deadlineMs: PARCEL_LEVEL.slo.deadlineMs[operation],
          targetId: targetId ?? '',
          primaryId,
          appNode,
          targetNode: targetNode ?? appNode,
          oldHistory: arrival.old,
          warehouseId: arrival.warehouseId >= 0 ? arrival.warehouseId : null,
          freshnessLagMs: 0,
          queueWaitMs: 0,
          appCompleted: false,
          finalized: false,
        };
        finalize(synthetic, arrivalTime, 'rejected', null, appNode);
        continue;
      }
      const request: RequestRuntime = {
        id: nextRequestId++,
        operation,
        arrivalMs: arrivalTime,
        deadlineMs: PARCEL_LEVEL.slo.deadlineMs[operation],
        targetId: targetNode.node.id,
        primaryId,
        appNode,
        targetNode,
        oldHistory: arrival.old,
        warehouseId: arrival.warehouseId >= 0 ? arrival.warehouseId : null,
        freshnessLagMs: 0,
        queueWaitMs: 0,
        appCompleted: false,
        finalized: false,
      };
      pendingRequests.push(request);
      const work = appWork(operation);
      noteEdge(clientNodeId, appNode.node.id, 'traffic');
      const accepted = enqueueTask(
        appNode,
        {
          operation,
          business: operation,
          request,
          work,
          demand: taskDemand(appNode.node, work, 1),
          enqueueMs: arrivalTime,
          replicationSeqStart: null,
          replicationSeqEnd: null,
        },
        arrivalTime,
      );
      if (!accepted) {
        const opAccumulator = operations.get(operation);
        if (opAccumulator) {
          increment(opAccumulator.errors, 'queue_full');
        }
        finalize(request, arrivalTime, 'rejected', null, appNode);
      }
      continue;
    }
    if (completion) {
      if (completionTime > endMs) {
        break;
      }
      heap.pop();
      completion.run();
      continue;
    }
    break;
  }

  if (trafficSampler) {
    while (nextTrafficBoundary <= endMs) {
      emitTrafficFrame(nextTrafficBoundary);
      nextTrafficBoundary += trafficStep;
    }
    if (lastTrafficBoundary < endMs) {
      emitTrafficFrame(endMs);
    }
  }

  for (const request of pendingRequests) {
    if (!request.finalized) {
      finalize(
        request,
        endMs,
        'timeout',
        null,
      );
      const accumulator = operations.get(request.operation);
      if (accumulator) {
        accumulator.unfinished += 1;
        increment(accumulator.errors, 'unfinished');
      }
    }
  }

  const elapsedMs = observationEndMs - startMs;
  for (const node of nodes.values()) {
    node.flush(endMs);
  }
  const nodeResults = graph.nodes.map((node) => {
    const runtime = nodes.get(node.id);
    return runtime
      ? nodeMetrics(runtime, elapsedMs)
      : {
          nodeId: node.id,
          kind: node.kind,
          label: node.label,
          requests: 0,
          completed: 0,
          errors: 0,
          timedOut: 0,
          rejected: 0,
          averageCpuUtilization: 0,
          peakCpuUtilization: 0,
          averageIoUtilization: 0,
          peakIoUtilization: 0,
          averageNetworkUtilization: 0,
          peakNetworkUtilization: 0,
          averageQueueDepth: 0,
          peakQueueDepth: 0,
          queueWaitP95Ms: 0,
          bytesRead: 0,
          bytesWritten: 0,
          operations: {},
        };
  });

  const operationResults = {} as Record<
    ParcelBusinessOperation,
    ParcelOperationMetrics
  >;
  for (const operation of PARCEL_BUSINESS_OPERATIONS) {
    operationResults[operation] = operationMetrics(
      operation,
      operations.get(operation) ?? newOpAccumulator(),
    );
  }

  // Actionable diagnostics, bounded to avoid enormous results.
  for (const node of nodes.values()) {
    const metrics = nodeMetrics(node, elapsedMs);
    if (
      metrics.averageCpuUtilization > 0.85 ||
      (metrics.peakCpuUtilization > 0.98 &&
        metrics.averageCpuUtilization > 0.5)
    ) {
      diagnostics.push({
        id: `queue_bottleneck:${node.node.id}`,
        severity: 'warning',
        code: 'queue_bottleneck',
        message: `"${node.node.label}" is a CPU bottleneck (average ${Math.round(
          metrics.averageCpuUtilization * 100,
        )}%, peak ${Math.round(metrics.peakCpuUtilization * 100)}%).`,
        nodeId: node.node.id,
        horizonYears,
        value: metrics.averageCpuUtilization,
        limit: 0.85,
      });
    }
    if (
      metrics.averageIoUtilization > 0.85 ||
      (metrics.peakIoUtilization > 0.98 &&
        metrics.averageIoUtilization > 0.5)
    ) {
      diagnostics.push({
        id: `io_bottleneck:${node.node.id}`,
        severity: 'warning',
        code: 'queue_bottleneck',
        message: `"${node.node.label}" is an IO bottleneck (average ${Math.round(
          metrics.averageIoUtilization * 100,
        )}%, peak ${Math.round(metrics.peakIoUtilization * 100)}%).`,
        nodeId: node.node.id,
        horizonYears,
        value: metrics.averageIoUtilization,
        limit: 0.85,
      });
    }
  }
  for (const operation of PARCEL_BUSINESS_OPERATIONS) {
    const metrics = operationResults[operation];
    if (metrics.counts.offered === 0) {
      diagnostics.push({
        id: `no_requests:${operation}`,
        severity: 'error',
        code: 'no_requests',
        message: `No ${operation} requests were offered; the operation cannot pass by omission.`,
        operation,
        horizonYears,
      });
    }
    if (metrics.counts.unfinished > 0) {
      diagnostics.push({
        id: `unfinished:${operation}`,
        severity: 'error',
        code: 'unfinished_work',
        message: `${metrics.counts.unfinished} ${operation} request(s) were still queued or running at the simulation end.`,
        operation,
        horizonYears,
        value: metrics.counts.unfinished,
      });
    }
    if (metrics.counts.missedData > 0) {
      diagnostics.push({
        id: `missing_data:${operation}`,
        severity: 'error',
        code: 'missing_data',
        message: `${metrics.counts.missedData} ${operation} request(s) could not read retained data.`,
        operation,
        horizonYears,
        value: metrics.counts.missedData,
      });
    }
    if (metrics.counts.stale > 0) {
      diagnostics.push({
        id: `stale:${operation}`,
        severity: 'error',
        code: 'stale_data',
        message: `${metrics.counts.stale} ${operation} request(s) exceeded the freshness SLO.`,
        operation,
        horizonYears,
        value: metrics.counts.stale,
      });
    }
  }

  return {
    workload: {
      durationMs: PARCEL_LEVEL.durationMs,
      drainMs: PARCEL_LEVEL.drainMs,
      simulationEndMs: endMs,
      sampleFactor: PARCEL_LEVEL.workload.sampleFactor,
      sampledRequests:
        trace.statusTimes.length +
        trace.historyTimes.length +
        trace.ingestTimes.length +
        trace.reports.length,
      estimatedOfferedRequests:
        trace.statusTimes.length +
        trace.historyTimes.length +
        trace.ingestTimes.length +
        trace.reports.length,
      scheduledReports: trace.reports.length,
      oldHistoryRequests: trace.counts.oldHistory,
      eventBudget: MAX_EVENTS_PER_HORIZON,
      processedEvents,
      exhausted,
      keyspace: PARCEL_LEVEL.workload.sampledParcelKeys,
      causalTimestamps:
        'Historical ages are causal; a bounded parcel keyspace is used for status/history.',
    },
    operations: operationResults as ParcelOperationMetricsMap,
    nodes: nodeResults,
    diagnostics,
    exhausted,
    historical,
    dataIntegrity,
  };
}

export type { ParcelCheck };
