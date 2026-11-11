/**
 * Executable Image Atlas scenario simulation.
 *
 * This module turns a validated graph + compiled routes + a graph-independent
 * trace into a deterministic, resource-bound scenario result. It uses the
 * frozen reusable kernel in `src/simulation/resources` read-only: the kernel
 * owns capacity accounting, FIFO lanes, outages, cancellation and window
 * integrals; this file owns the Image Atlas work model, routing, metadata
 * protocol, cache accounting and the causal request DAG.
 *
 * Approximation summary (all disclosed in `public/help/image-atlas.md`):
 * - Transport reserves one 1 Gbit/s lane on each physical resource of the
 *   explicit path. A streaming proxy pipeline overlaps every hop into one
 *   serialization; buffered hops are store-and-forward and pay one
 *   serialization per hop plus a full payload buffer.
 * - The client's 20 ms regional RTT delays the arrival event itself, so it is
 *   charged once per business request without holding server resources.
 * - Geographic propagation is charged inside the transfer stage. That holds
 *   the same lanes slightly longer, which is conservative for shared links.
 * - Provider service start and durable service are separate stages; the RPC
 *   quota is an admission rate, never a long-held slot.
 * - A search joins its ten thumbnail children and then shares one end-user
 *   access stage, so ten children cannot each claim a full access link.
 * - Metadata is a bounded immutable log model: per-origin sequence numbers,
 *   direct replication progress, W/R quorums and read repair. Records are
 *   never materialised as billions of JavaScript rows.
 */

import {
  ByteLruCache,
  EventScheduler,
  MemoryLedger,
  ResourceKernel,
  type ResourceRequirement,
  type ResourceStats,
  type ScheduledHandle,
  type TaskHandle,
  type TaskResult,
} from '../simulation/resources';
import { trafficSampleStepMs, type TrafficScope } from '../engine/trafficSampling';
import { TrafficSampler, notifyTraffic } from '../engine/trafficSampling';
import type {
  TrafficEdge,
  TrafficNode,
  TrafficObserver,
  TrafficResource,
} from '../simulation/traffic-telemetry';
import { IMAGE_CATALOG } from './catalog';
import {
  type ImageBusinessOperation,
  type ImageCacheRoute,
  type ImageCheck,
  type ImageDiagnostic,
  type ImageGraph,
  type ImageMetadataIndexMode,
  type ImageMetadataNode,
  type ImageNode,
  type ImageNodeMetrics,
  type ImageOperationCounts,
  type ImageOperationMetrics,
  type ImagePhysicalLinkMetrics,
  type ImagePlayerNode,
  type ImageRegion,
  type ImageRoutePlan,
  type ImageScenarioFault,
  type ImageScenarioName,
  type ImageScenarioResult,
  type ImageScenarioWindow,
  type ImageScenarioWindowOperation,
} from './contracts';
import { IMAGE_LEVEL } from './level';
import {
  IMAGE_BYTES_PER_GB,
  IMAGE_WORK_MODEL,
  publicationLagBound,
  uploadKeyForOrdinal,
  MillisecondHistogram,
  ascending,
  metadataReadQuorum,
  metadataWriteQuorum,
  nearestRank,
  serializationMs,
  stageDurationMs,
} from './model';
import {
  providerReadBandMs,
  providerWriteBandMs,
  type ImageTrace,
} from './workload';
import { NodeQueueDepthMeter } from './queue-metrics';

const REPLICATION_BATCH_RECORDS = 8;
const REPLICATION_POLL_MS = 250;
const MAX_QUEUED_TASKS = 200_000;
const RECENT_RING_SIZE = 4_096;
const THUMBNAIL_VARIANT = 'thumb';
const ORIGINAL_VARIANT = 'orig';

type Op = ImageBusinessOperation;
type FailureCode =
  | 'no_healthy_route'
  | 'endpoint_unavailable'
  | 'metadata_quorum_unavailable'
  | 'metadata_index_missing'
  | 'metadata_origin_unavailable'
  | 'memory_rejected'
  | 'task_interrupted'
  | 'queue_full'
  | 'deadline_exceeded';

interface RamArea {
  readonly ledger: MemoryLedger;
  lastMs: number;
  areaBytesMs: number;
}

interface InstanceRuntime {
  readonly nodeId: string;
  readonly index: number;
  readonly cpu: string;
  readonly io: string;
  /** Directional interfaces: one 10 Gbit/s lane each way. */
  readonly rx: string;
  readonly tx: string;
  readonly ram: RamArea;
  readonly resident: ByteLruCache<number> | null;
  readonly cacheStore: ByteLruCache<number> | null;
  down: boolean;
}

interface PlayerRuntime {
  readonly node: ImagePlayerNode;
  readonly region: ImageRegion;
  readonly instances: InstanceRuntime[];
  readonly buffering: 'streaming' | 'buffered';
  readonly retries: number;
  readonly retryBackoffMs: number;
}

interface EndpointRuntime {
  readonly region: ImageRegion;
  /** Directional regional endpoint interfaces (100 Gbit/s each way). */
  readonly rx: string;
  readonly tx: string;
  down: boolean;
}

interface LinkRuntime {
  readonly id: string;
  readonly kind: ImagePhysicalLinkMetrics['kind'];
  readonly label: string;
  readonly regionA: ImageRegion;
  readonly regionB: ImageRegion | null;
  readonly direction: 'full-duplex' | 'one-way';
  readonly capacityGbitPerSec: number;
  /** Kernel resource ids belonging to this metrics row. */
  readonly kernelIds: readonly string[];
  /** Kernel ids that count as the "sent" direction of this row. */
  readonly sentIds: readonly string[];
  sentBytes: number;
  receivedBytes: number;
  transfers: number;
  waits: MillisecondHistogram;
  accessBusyMs: number;
  accessLatencyMs: number;
}

interface NodeAccumulator {
  requests: number;
  completed: number;
  errors: number;
  rejected: number;
  timedOut: number;
  bytesRead: number;
  bytesWritten: number;
  /** Distinct attempts waiting in this node's queue, mean/peak over the window. */
  queue: NodeQueueDepthMeter;
  waits: MillisecondHistogram;
  cacheCoalesced: number;
  replicatedWrites: number;
  replicationLagMaxMs: number;
}

interface OpAccumulator {
  offered: number;
  completed: number;
  onTime: number;
  correct: number;
  success: number;
  timedOut: number;
  rejected: number;
  incorrect: number;
  stale: number;
  missingData: number;
  unfinished: number;
  latencies: number[];
  queueWaits: number[];
  bytesRead: number;
  bytesWritten: number;
  errors: Map<string, number>;
}

interface WindowAccumulator {
  offered: number;
  success: number;
  latencies: number[];
}

interface RecentUpload {
  readonly ordinal: number;
  readonly uploadId: string;
  readonly key: number;
  readonly storeId: string;
  readonly region: ImageRegion;
  readonly seq: number;
  readonly committedAtMs: number;
  acked: boolean;
}

interface Request {
  readonly id: number;
  readonly op: Op;
  readonly index: number;
  readonly arrivalMs: number;
  readonly clientId: string;
  readonly clientRegion: ImageRegion;
  /** Business object key. A probe rebinds this to the resolved immutable upload. */
  key: number;
  readonly probeOrdinal: number;
  readonly searchKind: number;
  readonly band: number;
  readonly deadlineAtMs: number;
  readonly window: 'primary' | 'incident' | 'recovery';
  deadlineHandle: ScheduledHandle | null;
  readonly scored: boolean;
  finalized: boolean;
  committed: boolean;
  originStoreId: string | null;
  appId: string | null;
  appInstance: number;
  cacheId: string | null;
  cacheInstance: number;
  storeId: string | null;
  providerId: string | null;
  attempts: number;
  handles: TaskHandle[];
  queueWaitMs: number;
  probeState: 'none' | 'pending' | 'active' | 'succeeded' | 'failed';
  probeResolved: boolean;
  resolvedProbe: RecentUpload | null;
  /** Origin region when the requested immutable object is still young. */
  youngOriginRegion: ImageRegion | null;
  probeLagMs: number | null;
  probeOriginFallback: boolean;
  missKeys: string[] | null;
  fillWaitKeys: string[];
  ownedFills: { instance: InstanceRuntime; key: string; generation: number }[];
}

interface ScenarioTotals {
  clientEgressBytes: number;
  providerRetrievalBytes: number;
  crossRegionBytes: number;
  readRequests: number;
  writeRequests: number;
  retries: number;
  cacheHits: number;
  cacheMisses: number;
  coalesced: number;
  committedUploads: number;
  acknowledgedUploads: number;
  lostAckCommitted: number;
  duplicateEffects: number;
  missingSearchResults: number;
  visibilityViolations: number;
  freshnessProbes: number;
  freshnessSuccess: number;
  freshnessViolations: number;
}

export interface ImageMeasuredTraffic {
  readonly clientEgressBytes: number;
  readonly providerRetrievalBytes: number;
  readonly crossRegionBytes: number;
  readonly readRequests: number;
  readonly writeRequests: number;
  readonly retries: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly coalesced: number;
  readonly cacheHitRatio: number;
  readonly retryRatio: number;
}

export interface ImageResourceSnapshot {
  readonly id: string;
  readonly kind: string;
  readonly capacity: number;
  readonly averageBusyUnits: number;
  readonly peakBusyUnits: number;
  readonly queuedTasks: number;
}

export interface ImageScenarioSimulation {
  readonly result: ImageScenarioResult;
  readonly traffic: ImageMeasuredTraffic;
  /**
   * Internal diagnostic view of every kernel resource (capacity, average and
   * peak occupancy, queue depth). It is not part of the frozen evaluation
   * contract; calibration and tests use it to attribute a bottleneck.
   */
  readonly resources: readonly ImageResourceSnapshot[];
  /** Requests still live after the run; must be 0 for a healthy replay. */
  readonly liveRequestsAtEnd: number;
  /** Requests still live before the final safety pass (must be 0). */
  readonly liveRequestsBeforeFinish: number;
  /** Coalesced fills still registered after the run (must be 0). */
  readonly pendingFillsAtEnd: number;
  readonly processedEvents: number;
  readonly eventBudget: number;
  readonly exhausted: boolean;
}

interface PathPlan {
  readonly resources: ResourceRequirement[];
  /** Private region-pair links crossed by this transfer. */
  readonly privateLinks: readonly string[];
  /** Response propagation after serialization (never holds bandwidth). */
  readonly propagationMs: number;
  /** Request propagation before the provider can start service. */
  readonly requestPropagationMs: number;
  /** Client population metrics row, when the client is on the path. */
  readonly clientId: string | null;
  /** Provider endpoint metrics row, when the provider is on the path. */
  readonly providerId: string | null;
  /** App/cache pool ids whose full-duplex NIC relays the bytes. */
  readonly relayNodeIds: readonly string[];
}

interface StoreRuntime {
  readonly nodeId: string;
  readonly region: ImageRegion;
  readonly replicas: number;
  readonly shardCount: number;
  readonly indexBytes: number;
  seq: number;
  readonly commitTimes: number[];
  readonly applied: Map<string, number>;
}

const REGION_ORDER: readonly ImageRegion[] = IMAGE_LEVEL.regions.map((item) => item.id);
const REGION_INDEX = new Map<ImageRegion, number>(
  REGION_ORDER.map((region, index) => [region, index]),
);
/** Precomputed one-way latency matrix; no per-call allocation. */
const ONE_WAY_MS: readonly (readonly number[])[] = REGION_ORDER.map((from) =>
  REGION_ORDER.map((to) => {
    if (from === to) {
      return IMAGE_WORK_MODEL.transport.localPropagationMs;
    }
    const link = IMAGE_LEVEL.network.interRegionLinks.find(
      (item) =>
        (item.a === from && item.b === to) || (item.a === to && item.b === from),
    );
    return link?.oneWayLatencyMs ?? 10_000;
  }),
);

function regionDistanceMs(from: ImageRegion, to: ImageRegion): number {
  const a = REGION_INDEX.get(from) ?? 0;
  const b = REGION_INDEX.get(to) ?? 0;
  return ONE_WAY_MS[a]?.[b] ?? 10_000;
}

function indexBytesPerRecord(index: ImageMetadataIndexMode): number {
  return IMAGE_CATALOG.metadata.indexBytesPerObject[index];
}

function operationDeadlineMs(operation: Op): number {
  return IMAGE_LEVEL.slo.deadlinesMs[operation];
}

function isIncidentScenario(name: ImageScenarioName): boolean {
  return name !== 'normal' && name !== 'peak';
}

function requiredCheck(
  id: string,
  label: string,
  passed: boolean,
  message: string,
  extra: Omit<ImageCheck, 'id' | 'label' | 'passed' | 'message' | 'severity'> = {},
): ImageCheck {
  return { id, label, passed, severity: 'required', message, ...extra };
}

function advisoryCheck(
  id: string,
  label: string,
  passed: boolean,
  message: string,
  extra: Omit<ImageCheck, 'id' | 'label' | 'passed' | 'message' | 'severity'> = {},
): ImageCheck {
  return { id, label, passed, severity: 'advisory', message, ...extra };
}

function emptyOpAccumulator(): OpAccumulator {
  return {
    offered: 0,
    completed: 0,
    onTime: 0,
    correct: 0,
    success: 0,
    timedOut: 0,
    rejected: 0,
    incorrect: 0,
    stale: 0,
    missingData: 0,
    unfinished: 0,
    latencies: [],
    queueWaits: [],
    bytesRead: 0,
    bytesWritten: 0,
    errors: new Map<string, number>(),
  };
}

function emptyWindow(): WindowAccumulator {
  return { offered: 0, success: 0, latencies: [] };
}

function emptyNodeAccumulator(
  windowStartMs: number,
  windowEndMs: number,
): NodeAccumulator {
  return {
    requests: 0,
    completed: 0,
    errors: 0,
    rejected: 0,
    timedOut: 0,
    bytesRead: 0,
    bytesWritten: 0,
    queue: new NodeQueueDepthMeter(windowStartMs, windowEndMs),
    waits: new MillisecondHistogram(1, 20_000),
    cacheCoalesced: 0,
    replicatedWrites: 0,
    replicationLagMaxMs: 0,
  };
}

/**
 * One scenario run owns a scheduler, a kernel, the runtime graph state and all
 * accumulators. It never touches wall-clock time, DOM APIs or Worker APIs.
 */
class ImageSimulator {
  private readonly scheduler = new EventScheduler();
  private readonly kernel: ResourceKernel;
  private readonly nodes = new Map<string, ImageNode>();
  private readonly players = new Map<string, PlayerRuntime>();
  private readonly endpoints = new Map<ImageRegion, EndpointRuntime>();
  private readonly clientLinks = new Map<ImageRegion, { rx: string; tx: string }>();
  private readonly privateLinks = new Set<string>();
  private readonly linkRows = new Map<string, LinkRuntime>();
  private readonly resourceToRow = new Map<string, LinkRuntime>();
  private readonly accumulatorByNode = new Map<string, NodeAccumulator>();
  private readonly unavailable = new Set<string>();
  private readonly ops: Record<Op, OpAccumulator> = {
    upload: emptyOpAccumulator(),
    search: emptyOpAccumulator(),
    detail: emptyOpAccumulator(),
  };
  private readonly windows: Record<'incident' | 'recovery', Record<Op, WindowAccumulator>> = {
    incident: { upload: emptyWindow(), search: emptyWindow(), detail: emptyWindow() },
    recovery: { upload: emptyWindow(), search: emptyWindow(), detail: emptyWindow() },
  };
  private readonly totals: ScenarioTotals = {
    clientEgressBytes: 0,
    providerRetrievalBytes: 0,
    crossRegionBytes: 0,
    readRequests: 0,
    writeRequests: 0,
    retries: 0,
    cacheHits: 0,
    cacheMisses: 0,
    coalesced: 0,
    committedUploads: 0,
    acknowledgedUploads: 0,
    lostAckCommitted: 0,
    duplicateEffects: 0,
    missingSearchResults: 0,
    visibilityViolations: 0,
    freshnessProbes: 0,
    freshnessSuccess: 0,
    freshnessViolations: 0,
  };
  private readonly appRouteById = new Map<string, ImageRoutePlan['apps'][number]>();
  /** Static, pre-sorted routing choices; per-request routing allocates nothing. */
  private readonly clientApps = new Map<
    string,
    readonly { option: ImageRoutePlan['clients'][number]['apps'][number]; latency: number }[]
  >();
  private readonly clientProviders = new Map<
    string,
    readonly { id: string; region: ImageRegion; latency: number }[]
  >();
  private readonly clientRouteById = new Map<string, ImageRoutePlan['clients'][number]>();
  private readonly cacheRouteById = new Map<string, ImageCacheRoute>();
  private readonly replicationByOrigin = new Map<
    string,
    ImageRoutePlan['metadataReplication'][number][]
  >();
  private readonly stores = new Map<string, StoreRuntime>();
  private readonly replicaProgress = new Map<string, Map<string, number>>();
  /** Highest sequence a target has *received* (may still be in flight). */
  private readonly sentProgress = new Map<string, Map<string, number>>();
  /** In-flight batches waiting for their WAN flight to finish before apply. */
  private readonly applyQueues = new Map<string, { start: number; end: number; at: number }[]>();
  /** One durable apply per origin→target stream at a time. */
  private readonly applyInFlight = new Set<string>();
  private readonly recent = new Array<RecentUpload | undefined>(RECENT_RING_SIZE);
  private readonly cacheFillInFlight = new Map<
    string,
    {
      owner: Request;
      generation: number;
      waiters: { req: Request; cb: (ok: boolean) => void }[];
    }
  >();
  private fillGeneration = 0;
  private readonly providerQuota = new Map<string, number>();
  /** Live requests; every one must reach a terminal state exactly once. */
  private readonly liveRequests = new Set<Request>();
  private readonly trace: ImageTrace;
  private readonly scenario: ImageScenarioName;
  private readonly diagnostics: ImageDiagnostic[] = [];
  private readonly freshnessLags: number[] = [];
  private readonly resourceStats = new Map<string, ResourceStats>();
  private readonly traffic: TrafficSampler | null;
  private readonly trafficEdges = new Map<string, string>();
  private readonly trafficPreviousBusy = new Map<string, number>();
  private readonly trafficStepMs: number;

  private liveBeforeFinish = 0;
  private nextRequestId = 1;
  private incidentFromMs = Number.POSITIVE_INFINITY;
  private incidentToMs = Number.POSITIVE_INFINITY;
  private recoveryFromMs = Number.POSITIVE_INFINITY;
  private faultStartMs: number | null = null;
  private faultRegion: ImageRegion | null = null;
  private faultLink: { a: ImageRegion; b: ImageRegion } | null = null;
  private nodeFaultActive = false;
  private lastAckAtMs: number | null = null;

  constructor(
    private readonly graph: ImageGraph,
    routes: ImageRoutePlan,
    trace: ImageTrace,
    private readonly onTraffic?: TrafficObserver,
    /**
     * @internal Test-only bounded-queue override. It exists so a focused test
     * can exercise the real kernel `queue-full` rejection path without a
     * multi-hundred-thousand-task stress run. It is deliberately not part of
     * level, graph or screenshot options and the public evaluator never sets
     * it, so the production admission limit stays MAX_QUEUED_TASKS.
     */
    private readonly testOnlyQueueLimit?: number,
  ) {
    this.trace = trace;
    this.scenario = trace.scenario;
    const trafficSpec = IMAGE_LEVEL.qualification.scenarios.find(
      (item) => item.name === trace.scenario,
    );
    const trafficScope: TrafficScope = {
      levelId: 'image-atlas',
      scopeId: trace.scenario,
      scopeLabel: trafficSpec?.label ?? trace.scenario,
      startMs: 0,
      measuredFromMs: trace.measuredFromMs,
      measuredEndMs: trace.measuredFromMs + trace.measuredMs,
      drainEndMs: trace.measuredFromMs + trace.measuredMs + trace.drainMs,
      postludeEndMs:
        trace.measuredFromMs +
        trace.measuredMs +
        trace.drainMs +
        IMAGE_LEVEL.qualification.postlude.maxAfterLastAckMs,
    };
    this.trafficStepMs = trafficSampleStepMs(trafficScope);
    this.traffic = onTraffic
      ? new TrafficSampler(
          graph.edges.map((edge) => edge.id),
          graph.nodes.map((node) => node.id),
          trafficScope,
        )
      : null;
    for (const edge of graph.edges) {
      this.trafficEdges.set(
        `${edge.source}|${edge.target}|${edge.operation}`,
        edge.id,
      );
    }
    this.kernel = new ResourceKernel(this.scheduler, {
      windowStartMs: trace.measuredFromMs,
      windowEndMs: trace.measuredFromMs + trace.measuredMs,
      maxQueuedTasks: this.testOnlyQueueLimit ?? MAX_QUEUED_TASKS,
    });
    for (const node of graph.nodes) {
      this.nodes.set(node.id, node);
      this.accumulatorByNode.set(
        node.id,
        emptyNodeAccumulator(
          trace.measuredFromMs,
          trace.measuredFromMs + trace.measuredMs,
        ),
      );
    }
    for (const route of routes.apps) {
      this.appRouteById.set(route.appId, route);
    }
    for (const route of routes.clients) {
      this.clientRouteById.set(route.clientId, route);
      const apps = route.apps
        .map((option) => ({
          option,
          latency: regionDistanceMs(route.region, option.appRegion),
        }))
        .sort((left, right) =>
          left.latency !== right.latency
            ? left.latency - right.latency
            : left.option.appId.localeCompare(right.option.appId),
        );
      this.clientApps.set(route.clientId, apps);
      const providers = route.directProviderIds
        .map((id) => this.nodes.get(id))
        .filter((node): node is ImageNode => node?.kind === 'blob')
        .map((node) => ({
          id: node.id,
          region: node.region,
          latency: regionDistanceMs(route.region, node.region),
        }))
        .sort((left, right) =>
          left.latency !== right.latency
            ? left.latency - right.latency
            : left.id.localeCompare(right.id),
        );
      this.clientProviders.set(route.clientId, providers);
    }
    for (const route of routes.caches) {
      this.cacheRouteById.set(route.cacheId, route);
    }
    for (const replication of routes.metadataReplication) {
      const list = this.replicationByOrigin.get(replication.sourceNodeId) ?? [];
      list.push(replication);
      this.replicationByOrigin.set(replication.sourceNodeId, list);
    }
    this.buildRuntime();
    const spec = IMAGE_LEVEL.qualification.scenarios.find(
      (item) => item.name === trace.scenario,
    );
    const fault = spec?.fault;
    if (fault && fault.kind !== 'none' && isIncidentScenario(trace.scenario)) {
      this.incidentFromMs = trace.measuredFromMs + fault.atMeasuredMs;
      this.incidentToMs = trace.measuredFromMs + fault.atMeasuredMs + fault.durationMs;
      this.recoveryFromMs = Math.max(
        trace.measuredFromMs,
        trace.measuredFromMs + trace.measuredMs - IMAGE_LEVEL.slo.recoveryFinalWindowMs,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private buildRuntime(): void {
    for (const region of IMAGE_LEVEL.regions.map((item) => item.id)) {
      const endpoint: EndpointRuntime = {
        region,
        rx: `provider:${region}:rx`,
        tx: `provider:${region}:tx`,
        down: false,
      };
      this.endpoints.set(region, endpoint);
      this.registerNetwork(endpoint.rx, IMAGE_CATALOG.provider.endpointBandwidthGbitPerSec);
      this.registerNetwork(endpoint.tx, IMAGE_CATALOG.provider.endpointBandwidthGbitPerSec);
      this.addLinkRow({
        id: `provider-endpoint:${region}`,
        kind: 'provider-endpoint',
        label: `Global blob ${region.toUpperCase()} endpoint`,
        regionA: region,
        regionB: region,
        direction: 'full-duplex',
        capacityGbitPerSec: IMAGE_CATALOG.provider.endpointBandwidthGbitPerSec,
        kernelIds: [endpoint.rx, endpoint.tx],
        sentIds: [endpoint.tx],
      });

      const clientRx = `client:${region}:rx`;
      const clientTx = `client:${region}:tx`;
      this.clientLinks.set(region, { rx: clientRx, tx: clientTx });
      const aggregate = IMAGE_LEVEL.network.aggregateClientBandwidthGbitPerSec;
      this.registerNetwork(clientRx, aggregate);
      this.registerNetwork(clientTx, aggregate);
      this.addLinkRow({
        id: `client-population:${region}`,
        kind: 'client-population-link',
        label: `${region.toUpperCase()} client population aggregate`,
        regionA: region,
        regionB: region,
        direction: 'full-duplex',
        capacityGbitPerSec: aggregate,
        kernelIds: [clientRx, clientTx],
        sentIds: [clientTx],
      });
      this.addLinkRow({
        id: `request-access:${region}`,
        kind: 'request-access-link',
        label: `${region.toUpperCase()} per-request 1 Gbit/s access`,
        regionA: region,
        regionB: null,
        direction: 'one-way',
        capacityGbitPerSec: IMAGE_LEVEL.network.requestAccessBandwidthGbitPerSec,
        kernelIds: [],
        sentIds: [],
      });
    }

    for (const linkSpec of IMAGE_LEVEL.network.interRegionLinks) {
      const forward = `link:${linkSpec.a}:${linkSpec.b}`;
      const backward = `link:${linkSpec.b}:${linkSpec.a}`;
      this.registerNetwork(forward, linkSpec.bandwidthGbitPerSec);
      this.registerNetwork(backward, linkSpec.bandwidthGbitPerSec);
      this.privateLinks.add(forward);
      this.privateLinks.add(backward);
      this.addLinkRow({
        id: `region-pair:${linkSpec.a}-${linkSpec.b}`,
        kind: 'region-pair',
        label: `Private ${linkSpec.a.toUpperCase()}-${linkSpec.b.toUpperCase()} link`,
        regionA: linkSpec.a,
        regionB: linkSpec.b,
        direction: 'full-duplex',
        capacityGbitPerSec: linkSpec.bandwidthGbitPerSec,
        kernelIds: [forward, backward],
        sentIds: [forward],
      });
    }

    for (const node of this.graph.nodes) {
      if (node.kind === 'client' || node.kind === 'blob') {
        continue;
      }
      const instances: InstanceRuntime[] = [];
      for (let index = 0; index < node.config.instances; index += 1) {
        const prefix = `node:${node.id}:${index}`;
        const cpu = `${prefix}:cpu`;
        const io = `${prefix}:io`;
        const rx = `${prefix}:rx`;
        const tx = `${prefix}:tx`;
        this.kernel.registerResource({
          id: cpu,
          capacity: IMAGE_CATALOG.instance.cpuCores,
          kind: 'cpu',
        });
        this.kernel.registerResource({
          id: io,
          capacity: IMAGE_WORK_MODEL.io.lanesPerInstance,
          kind: 'io',
        });
        this.registerNetwork(rx, IMAGE_CATALOG.instance.networkGbitPerSec);
        this.registerNetwork(tx, IMAGE_CATALOG.instance.networkGbitPerSec);
        const residentCapacity =
          node.kind === 'metadata'
            ? node.config.residentCacheGb * IMAGE_BYTES_PER_GB
            : 0;
        const cacheCapacity =
          node.kind === 'cache'
            ? (node.config.capacityGb / node.config.instances) * IMAGE_BYTES_PER_GB
            : 0;
        const usable = IMAGE_CATALOG.instance.usableMemoryGb * IMAGE_BYTES_PER_GB;
        const ram: RamArea = {
          ledger: new MemoryLedger(usable),
          lastMs: this.trace.measuredFromMs,
          areaBytesMs: 0,
        };
        if (residentCapacity > 0) {
          ram.ledger.reserve(`${prefix}:resident`, residentCapacity);
        }
        if (cacheCapacity > 0) {
          ram.ledger.reserve(`${prefix}:cache`, cacheCapacity);
        }
        instances.push({
          nodeId: node.id,
          index,
          cpu,
          io,
          rx,
          tx,
          ram,
          resident:
            node.kind === 'metadata'
              ? new ByteLruCache<number>(residentCapacity)
              : null,
          cacheStore:
            node.kind === 'cache'
              ? new ByteLruCache<number>(cacheCapacity)
              : null,
          down: false,
        });
      }
      this.players.set(node.id, {
        node,
        region: node.region,
        instances,
        buffering: node.kind === 'app' ? node.config.buffering : 'streaming',
        retries: node.kind === 'app' ? node.config.retries : 0,
        retryBackoffMs: node.kind === 'app' ? node.config.retryBackoffMs : 0,
      });
      this.addLinkRow({
        id: `instance-nic:${node.id}`,
        kind: 'instance-nic',
        label: `${node.id} instance NICs`,
        regionA: node.region,
        regionB: null,
        direction: 'full-duplex',
        capacityGbitPerSec: IMAGE_CATALOG.instance.networkGbitPerSec * instances.length,
        kernelIds: instances.flatMap((instance) => [instance.rx, instance.tx]),
        sentIds: instances.map((instance) => instance.tx),
      });
      if (node.kind === 'metadata') {
        this.stores.set(node.id, {
          nodeId: node.id,
          region: node.region,
          replicas: Math.max(1, node.config.replicas),
          shardCount: Math.max(1, Math.floor(node.config.instances / node.config.replicas)),
          indexBytes: indexBytesPerRecord(node.config.index),
          seq: 0,
          commitTimes: [],
          applied: new Map<string, number>(),
        });
      }
    }
  }

  private registerNetwork(id: string, capacity: number): void {
    this.kernel.registerResource({ id, capacity, kind: 'network' });
  }

  private addLinkRow(input: Omit<LinkRuntime, 'sentBytes' | 'receivedBytes' | 'transfers' | 'waits' | 'accessBusyMs' | 'accessLatencyMs'>): void {
    const row: LinkRuntime = {
      ...input,
      sentBytes: 0,
      receivedBytes: 0,
      transfers: 0,
      waits: new MillisecondHistogram(1, 20_000),
      accessBusyMs: 0,
      accessLatencyMs: 0,
    };
    this.linkRows.set(row.id, row);
    for (const kernelId of row.kernelIds) {
      this.resourceToRow.set(kernelId, row);
    }
  }

  // -------------------------------------------------------------------------
  // Faults
  // -------------------------------------------------------------------------

  private scheduleFault(): void {
    const spec = IMAGE_LEVEL.qualification.scenarios.find(
      (item) => item.name === this.scenario,
    );
    const fault = spec?.fault;
    if (!fault || fault.kind === 'none') {
      return;
    }
    const startAt = this.trace.measuredFromMs + fault.atMeasuredMs;
    this.faultStartMs = startAt;
    this.scheduler.schedule(startAt, () => this.activateFault(fault), -1);
    this.scheduler.schedule(
      startAt + fault.durationMs,
      () => this.deactivateFault(fault),
      -1,
    );
  }

  private activateFault(fault: ImageScenarioFault): void {
    if (fault.kind === 'node') {
      this.nodeFaultActive = true;
      for (const player of this.players.values()) {
        const instance = player.instances[0];
        if (instance) {
          this.setInstanceDown(instance, true);
        }
      }
      this.diagnostics.push({
        id: 'fault:node',
        severity: 'warning',
        code: 'node_fault',
        message:
          'One physical instance (index 0) was removed from every player pool; a visual pool never multiplies surviving resources.',
        scenario: this.scenario,
      });
      return;
    }
    if (fault.kind === 'link') {
      this.faultLink = { a: fault.a, b: fault.b };
      this.setLinkAvailable(fault.a, fault.b, false);
      this.diagnostics.push({
        id: 'fault:link',
        severity: 'warning',
        code: 'link_fault',
        message: `Private ${fault.a.toUpperCase()}-${fault.b.toUpperCase()} link is unavailable in both directions; client public access is not rerouted through it.`,
        scenario: this.scenario,
      });
      return;
    }
    if (fault.kind === 'region') {
      this.faultRegion = fault.region;
      for (const player of this.players.values()) {
        if (player.region !== fault.region) {
          continue;
        }
        for (const instance of player.instances) {
          this.setInstanceDown(instance, true);
        }
      }
      const endpoint = this.endpoints.get(fault.region);
      if (endpoint) {
        endpoint.down = true;
        this.setResourceAvailable(endpoint.rx, false);
        this.setResourceAvailable(endpoint.tx, false);
      }
      for (const region of IMAGE_LEVEL.regions.map((item) => item.id)) {
        if (region !== fault.region) {
          this.setLinkAvailable(fault.region, region, false);
        }
      }
      this.diagnostics.push({
        id: 'fault:region',
        severity: 'error',
        code: 'region_fault',
        message: `${fault.region.toUpperCase()} datacenter resources and provider endpoint are unavailable until recovery; client demand is still offered and counted.`,
        scenario: this.scenario,
      });
    }
  }

  private deactivateFault(fault: ImageScenarioFault): void {
    if (this.nodeFaultActive) {
      this.nodeFaultActive = false;
      for (const player of this.players.values()) {
        const instance = player.instances[0];
        if (instance) {
          this.setInstanceDown(instance, false);
        }
      }
    }
    if (this.faultLink) {
      this.setLinkAvailable(this.faultLink.a, this.faultLink.b, true);
      this.faultLink = null;
    }
    if (fault.kind === 'region') {
      const region = fault.region;
      for (const player of this.players.values()) {
        if (player.region !== region) {
          continue;
        }
        for (const instance of player.instances) {
          this.setInstanceDown(instance, false);
        }
      }
      const endpoint = this.endpoints.get(region);
      if (endpoint) {
        endpoint.down = false;
        this.setResourceAvailable(endpoint.rx, true);
        this.setResourceAvailable(endpoint.tx, true);
      }
      for (const other of IMAGE_LEVEL.regions.map((item) => item.id)) {
        if (other !== region) {
          this.setLinkAvailable(region, other, true);
        }
      }
      this.faultRegion = null;
    }
  }

  private setInstanceDown(instance: InstanceRuntime, down: boolean): void {
    if (instance.down === down) {
      return;
    }
    instance.down = down;
    this.setResourceAvailable(instance.cpu, !down);
    this.setResourceAvailable(instance.io, !down);
    this.setResourceAvailable(instance.rx, !down);
    this.setResourceAvailable(instance.tx, !down);
  }

  private setResourceAvailable(id: string, available: boolean): void {
    this.kernel.setAvailable(id, available);
    if (available) {
      this.unavailable.delete(id);
    } else {
      this.unavailable.add(id);
    }
  }

  private setLinkAvailable(
    a: ImageRegion,
    b: ImageRegion,
    available: boolean,
  ): void {
    for (const id of [`link:${a}:${b}`, `link:${b}:${a}`]) {
      if (this.privateLinks.has(id)) {
        this.setResourceAvailable(id, available);
      }
    }
  }

  /** True when a client may still believe a failed region is usable. */
  private regionKnownHealthy(region: ImageRegion, nowMs: number): boolean {
    if (this.faultRegion !== region || this.faultStartMs === null) {
      return true;
    }
    return nowMs < this.faultStartMs + IMAGE_WORK_MODEL.transport.failureDetectionMs;
  }

  private endpointUsable(region: ImageRegion): boolean {
    const endpoint = this.endpoints.get(region);
    return endpoint !== undefined && !endpoint.down;
  }

  private playerUsable(nodeId: string): boolean {
    const player = this.players.get(nodeId);
    if (!player) {
      return false;
    }
    if (player.region === this.faultRegion) {
      return false;
    }
    return player.instances.some((instance) => !instance.down);
  }

  private playerKnownUsable(nodeId: string, nowMs: number): boolean {
    if (this.playerUsable(nodeId)) {
      return true;
    }
    const player = this.players.get(nodeId);
    if (!player || player.region !== this.faultRegion) {
      return false;
    }
    return this.regionKnownHealthy(player.region, nowMs);
  }

  private aliveInstances(player: PlayerRuntime): InstanceRuntime[] {
    return player.instances.filter((instance) => !instance.down);
  }

  /** k-th healthy instance without allocating an intermediate array. */
  private aliveInstanceAt(player: PlayerRuntime, ordinal: number): InstanceRuntime | null {
    let alive = 0;
    for (const instance of player.instances) {
      if (!instance.down) {
        alive += 1;
      }
    }
    if (alive === 0) {
      return null;
    }
    let target = ordinal % alive;
    for (const instance of player.instances) {
      if (instance.down) {
        continue;
      }
      if (target === 0) {
        return instance;
      }
      target -= 1;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  private pickApp(
    req: Request,
  ):
    | {
        appId: string;
        appNode: ImagePlayerNode;
        appInstance: InstanceRuntime;
        storeId: string;
        storeNode: ImageMetadataNode;
      }
    | null {
    const options = this.clientApps.get(req.clientId);
    if (!options) {
      return null;
    }
    const nowMs = this.scheduler.nowMs;
    let chosen: ImageRoutePlan['clients'][number]['apps'][number] | null = null;
    for (const entry of options) {
      const option = entry.option;
      if (!this.playerUsable(option.appId) && !this.regionKnownHealthy(option.appRegion, nowMs)) {
        continue;
      }
      if (!this.playerKnownUsable(option.metadataStoreNodeId, nowMs)) {
        continue;
      }
      if (req.originStoreId !== null && option.metadataStoreNodeId !== req.originStoreId) {
        continue;
      }
      if (req.youngOriginRegion !== null && !this.appCanReachOrigin(req, option, nowMs)) {
        continue;
      }
      if (option.delivery === 'proxy') {
        const blobPath = option.blobPath;
        if (!blobPath) {
          continue;
        }
        if (blobPath.cacheId && !this.playerKnownUsable(blobPath.cacheId, nowMs)) {
          continue;
        }
        if (!blobPath.cacheId && !this.endpointUsable(this.providerRegion(blobPath.providerId))) {
          continue;
        }
      }
      chosen = option;
      break;
    }
    if (!chosen) {
      return null;
    }
    const player = this.players.get(chosen.appId);
    const store = this.players.get(chosen.metadataStoreNodeId);
    if (!player || !store || store.node.kind !== 'metadata') {
      return null;
    }
    const instance = this.aliveInstanceAt(player, req.id);
    if (!instance) {
      return null;
    }
    return {
      appId: chosen.appId,
      appNode: player.node,
      appInstance: instance,
      storeId: chosen.metadataStoreNodeId,
      storeNode: store.node,
    };
  }

  private providerRegion(providerId: string): ImageRegion {
    const node = this.nodes.get(providerId);
    return node && node.kind === 'blob' ? node.region : 'na';
  }

  // -------------------------------------------------------------------------
  // Request lifecycle
  // -------------------------------------------------------------------------

  private offerRequest(op: Op, index: number, traceTimeMs: number): void {
    const measuredFrom = this.trace.measuredFromMs;
    const scored =
      traceTimeMs >= measuredFrom && traceTimeMs < measuredFrom + this.trace.measuredMs;
    const trace = this.trace;
    const stream =
      op === 'upload' ? trace.uploads : op === 'search' ? trace.searches : trace.details;
    const regionIndex = stream.region[index] ?? 0;
    const region = IMAGE_LEVEL.regions[regionIndex]?.id ?? 'na';
    const clientId = `client-${region}`;
    this.noteTrafficNode(clientId);
    const req: Request = {
      id: this.nextRequestId,
      op,
      index,
      arrivalMs: traceTimeMs,
      clientId,
      clientRegion: region,
      key:
        op === 'detail'
          ? (trace.details.key[index] ?? 0)
          : op === 'search'
            ? (trace.searches.keys[index * IMAGE_LEVEL.dataset.searchResultsPerSearch] ?? 0)
            : 0,
      probeOrdinal: op === 'detail' ? (trace.details.probeTarget[index] ?? -1) : -1,
      searchKind: op === 'search' ? (trace.searches.kind[index] ?? 0) : 0,
      band:
        op === 'upload'
          ? (trace.uploads.bands[index] ?? 0)
          : op === 'detail'
            ? (trace.details.bands[index] ?? 0)
            : 0,
      deadlineAtMs: traceTimeMs + operationDeadlineMs(op),
      window: this.windowFor(traceTimeMs),
      deadlineHandle: null,
      scored,
      finalized: false,
      committed: false,
      originStoreId: null,
      appId: null,
      appInstance: 0,
      cacheId: null,
      cacheInstance: 0,
      storeId: null,
      providerId: null,
      attempts: 0,
      handles: [],
      queueWaitMs: 0,
      probeState:
        op === 'detail' && (trace.details.probeTarget[index] ?? -1) >= 0
          ? 'pending'
          : 'none',
      probeResolved: false,
      resolvedProbe: null,
      youngOriginRegion: null,
      probeLagMs: null,
      probeOriginFallback: false,
      missKeys: null,
      fillWaitKeys: [],
      ownedFills: [],
    };
    this.nextRequestId += 1;
    if (scored) {
      this.ops[op].offered += 1;
      if (req.window === 'incident') {
        this.windows.incident[op].offered += 1;
      } else if (req.window === 'recovery') {
        this.windows.recovery[op].offered += 1;
      }
      const clientAcc = this.accumulatorByNode.get(clientId);
      if (clientAcc) {
        clientAcc.requests += 1;
      }
    }
    this.scheduleDeadline(req);
    this.startRequest(req);
  }

  private windowFor(arrivalMs: number): Request['window'] {
    if (!Number.isFinite(this.incidentFromMs)) {
      return 'primary';
    }
    if (arrivalMs >= this.recoveryFromMs) {
      return 'recovery';
    }
    if (arrivalMs >= this.incidentFromMs && arrivalMs < this.incidentToMs) {
      return 'incident';
    }
    return 'primary';
  }

  /**
   * Exact, cancellable per-request deadline. Kernel completions use priority 0
   * and this deadline uses priority 1, so a completion at the exact deadline
   * wins. The event is cancelled on every terminal path, so a finished request
   * retains nothing.
   */
  private scheduleDeadline(req: Request): void {
    this.liveRequests.add(req);
    req.deadlineHandle = this.scheduler.schedule(
      req.deadlineAtMs,
      () => this.timeoutRequest(req),
      1,
    );
  }

  private releaseDeadline(req: Request): void {
    req.deadlineHandle?.cancel();
    req.deadlineHandle = null;
    this.liveRequests.delete(req);
  }

  private startRequest(req: Request): void {
    req.attempts += 1;
    if (req.op === 'upload') {
      this.startUpload(req);
      return;
    }
    if (req.op === 'detail') {
      this.prepareDetailIdentity(req);
    }
    const app = this.pickApp(req);
    if (!app) {
      this.failRequest(req, 'no_healthy_route');
      return;
    }
    this.applyRoute(req, app.appId, app.appInstance.index, app.storeId);
    if (req.op === 'detail') {
      this.startDetailMetadata(req, app.storeNode, app.appInstance);
    } else {
      this.startSearchMetadata(req, app.storeNode, app.appInstance);
    }
  }

  private playerBuffering(nodeId: string): boolean {
    const player = this.players.get(nodeId);
    return player !== undefined && player.buffering === 'buffered';
  }

  private applyRoute(
    req: Request,
    appId: string,
    instanceIndex: number,
    storeId: string,
  ): void {
    req.appId = appId;
    req.appInstance = instanceIndex;
    req.storeId = storeId;
    this.noteTrafficNode(appId);
    this.noteTrafficEdge(req.clientId, appId, 'traffic');
    const appAcc = this.accumulatorByNode.get(appId);
    if (appAcc && req.attempts === 1) {
      appAcc.requests += 1;
    }
    const storeAcc = this.accumulatorByNode.get(storeId);
    if (storeAcc && req.attempts === 1) {
      storeAcc.requests += 1;
    }
  }

  private startUpload(req: Request): void {
    const app = this.pickApp(req);
    if (!app) {
      this.failRequest(req, 'no_healthy_route');
      return;
    }
    this.applyRoute(req, app.appId, app.appInstance.index, app.storeId);
    if (req.originStoreId === null) {
      // Origin binding happens before the first payload byte leaves the client.
      req.originStoreId = app.storeId;
    }
    const appRoute = this.appRouteById.get(app.appId);
    const direct = appRoute?.delivery === 'direct';
    let providerId: string | null = null;
    let cacheInstance: InstanceRuntime | null = null;
    let providerRegion: ImageRegion | null;
    if (direct) {
      providerId = this.pickProvider(req);
      if (!providerId) {
        this.failRequest(req, 'no_healthy_route');
        return;
      }
      providerRegion = this.providerRegion(providerId);
    } else {
      const blobPath = appRoute?.blobPath;
      if (!blobPath) {
        this.failRequest(req, 'no_healthy_route');
        return;
      }
      providerId = blobPath.providerId;
      providerRegion = this.providerRegion(providerId);
      if (!this.endpointUsable(providerRegion)) {
        this.failRequest(req, 'endpoint_unavailable');
        return;
      }
      if (blobPath.cacheId) {
        const cachePlayer = this.players.get(blobPath.cacheId);
        if (!cachePlayer) {
          this.failRequest(req, 'no_healthy_route');
          return;
        }
        req.cacheId = blobPath.cacheId;
        const alive = this.aliveInstances(cachePlayer);
        const chosen = alive[req.id % Math.max(1, alive.length)];
        cacheInstance = chosen ?? null;
        if (chosen) {
          req.cacheInstance = chosen.index;
        }
      }
    }
    req.providerId = providerId;
    if (providerId) {
      this.noteTrafficNode(providerId);
      if (direct) {
        this.noteTrafficEdge(req.clientId, providerId, 'blob');
      } else if (cacheInstance) {
        if (req.cacheId) {
          this.noteTrafficEdge(app.appId, req.cacheId, 'blob');
          this.noteTrafficEdge(req.cacheId, providerId, 'blob');
        }
      } else {
        this.noteTrafficEdge(app.appId, providerId, 'blob');
      }
    }
    const payloadBytes = IMAGE_LEVEL.dataset.originalBytes;
    const buffered = !direct && this.playerBuffering(app.appId);
    const hops = direct ? 1 : cacheInstance ? 3 : 2;
    const path = this.uploadPath(
      req.clientRegion,
      app.appInstance,
      app.appNode.region,
      cacheInstance,
      providerRegion,
      direct,
    );
    const serialization = serializationMs(payloadBytes) * (buffered ? hops : 1);
    const cpuMs =
      IMAGE_WORK_MODEL.app.parseCpuMs +
      IMAGE_WORK_MODEL.app.uploadCpuMs +
      (buffered ? (payloadBytes / 1_000_000) * IMAGE_WORK_MODEL.app.bufferedCopyCpuMsPerMb : 0);
    const bufferBytes = buffered
      ? payloadBytes * hops
      : IMAGE_WORK_MODEL.transport.streamingBufferBytesPerHop * hops;
    const bufferInstance = cacheInstance ?? app.appInstance;
    if (providerId) {
      const providerAcc = this.accumulatorByNode.get(providerId);
      if (providerAcc) {
        providerAcc.requests += 1;
      }
    }
    const admissionAt = providerRegion
      ? this.acquireProviderSlot(providerRegion, 'write', req.scored)
      : this.scheduler.nowMs;
    this.delayUntil(req, Math.max(this.scheduler.nowMs, admissionAt), () => {
      this.submitSerialized(req, {
        resources: path.resources,
        serializationMs: Math.max(serialization, stageDurationMs({ cpuMs })),
        propagationMs: path.propagationMs,
        buffer: { instance: bufferInstance, bytes: bufferBytes },
        nodeId: app.appId,
        kind: 'upload-payload',
        bytesUp: payloadBytes,
        transfer: { path, bytes: payloadBytes, direction: 'up' },
        onDone: (result, outcome) => {
          if (!result) {
            this.retryOrFail(req, 'endpoint_unavailable');
            return;
          }
          if (outcome === 'failed') {
            this.retryOrFail(
              req,
              this.stageFailureCode(result),
            );
            return;
          }
          if (outcome === 'propagation-lost') {
            this.retryOrFail(req, 'endpoint_unavailable');
            return;
          }
          this.afterUploadPayload(req, app.appInstance, providerId);
        },
      });
    });
  }

  private afterUploadPayload(
    req: Request,
    appInstance: InstanceRuntime,
    providerId: string | null,
  ): void {
    if (!providerId) {
      this.failRequest(req, 'no_healthy_route');
      return;
    }
    const startAt =
      this.scheduler.nowMs +
      providerWriteBandMs(req.band) +
      IMAGE_WORK_MODEL.provider.durableServiceMs;
    this.delayUntil(req, startAt, () => this.startMetadataCommit(req, appInstance));
  }

  private startMetadataCommit(req: Request, appInstance: InstanceRuntime): void {
    const storeId = req.originStoreId;
    if (!storeId) {
      this.failRequest(req, 'metadata_origin_unavailable');
      return;
    }
    const store = this.stores.get(storeId);
    const player = this.players.get(storeId);
    if (!store || !player) {
      this.failRequest(req, 'metadata_origin_unavailable');
      return;
    }
    const shard = this.shardFor(store, req.index);
    const copies = this.shardCopies(player, store, shard).filter((instance) => !instance.down);
    const writeQuorum = metadataWriteQuorum(store.replicas);
    if (copies.length < writeQuorum) {
      this.failRequest(req, 'metadata_quorum_unavailable');
      return;
    }
    const recordBytes = IMAGE_LEVEL.dataset.metadataBytes;
    const bytes = recordBytes + store.indexBytes;
    const resources: ResourceRequirement[] = [];
    for (const copy of copies) {
      resources.push(
        { id: copy.cpu, units: 1 },
        { id: copy.io, units: 1 },
        { id: copy.rx, units: 1 },
      );
    }
    resources.push({ id: appInstance.tx, units: 1 });
    const duration = stageDurationMs({
      cpuMs: IMAGE_WORK_MODEL.metadata.durableWriteCpuMsPerCopy,
      ioBytes: bytes,
      ioOps: IMAGE_WORK_MODEL.metadata.durableWriteIoOpsPerCopy,
    });
    // One durable stage writes every live copy; the ACK waits only for the
    // write quorum. Remaining copies are appended in the background below.
    this.noteTrafficEdge(req.appId ?? '', storeId, 'metadata');
    this.noteTrafficNode(storeId);
    this.submitStage(req, {
      resources,
      durationMs: duration,
      nodeId: storeId,
      kind: 'metadata-commit',
      bytesWritten: bytes,
      onDone: (result) => {
        if (!result || result.status !== 'completed') {
          this.retryOrFail(
            req,
            this.stageFailureCode(result),
          );
          return;
        }
        this.commitUpload(req, store, copies, recordBytes, store.indexBytes);
      },
    });
  }

  private commitUpload(
    req: Request,
    store: StoreRuntime,
    copies: readonly InstanceRuntime[],
    recordBytes: number,
    indexBytes: number,
  ): void {
    if (req.committed) {
      this.finishUploadAck(req);
      return;
    }
    store.seq += 1;
    store.commitTimes.push(this.scheduler.nowMs);
    req.committed = true;
    this.totals.committedUploads += 1;
    const ordinal = req.index;
    const uploadId = this.uploadId(ordinal);
    this.recent[ordinal % RECENT_RING_SIZE] = {
      ordinal,
      uploadId,
      key: this.uploadKey(ordinal),
      storeId: store.nodeId,
      region: store.region,
      seq: store.seq,
      committedAtMs: this.scheduler.nowMs,
      acked: false,
    };
    const writeQuorum = metadataWriteQuorum(store.replicas);
    const tail = copies.slice(writeQuorum);
    if (tail.length > 0) {
      this.submitTailCopy(store, tail, recordBytes + indexBytes);
    }
    this.finishUploadAck(req);
  }

  private submitTailCopy(
    store: StoreRuntime,
    tailCopies: readonly InstanceRuntime[],
    bytes: number,
  ): void {
    if (tailCopies.some((copy) => this.unavailable.has(copy.cpu) || this.unavailable.has(copy.io))) {
      return;
    }
    const resources: ResourceRequirement[] = [];
    for (const copy of tailCopies) {
      resources.push({ id: copy.cpu, units: 1 }, { id: copy.io, units: 1 });
    }
    const duration = stageDurationMs({
      cpuMs: IMAGE_WORK_MODEL.metadata.durableWriteCpuMsPerCopy,
      ioBytes: bytes,
      ioOps: IMAGE_WORK_MODEL.metadata.durableWriteIoOpsPerCopy,
    });
    this.kernel.submit({
      id: `tail:${store.nodeId}:${store.seq}`,
      resources,
      durationMs: duration,
      onFinish: (result) => {
        if (result.status === 'completed') {
          this.addNodeBytes(store.nodeId, 0, bytes);
        }
      },
    });
  }

  private finishUploadAck(req: Request): void {
    const app = req.appId ? this.players.get(req.appId) : undefined;
    const clientResource = this.clientLinks.get(req.clientRegion);
    if (!app || !clientResource) {
      this.failRequest(req, 'task_interrupted');
      return;
    }
    const alive = this.aliveInstances(app);
    const instance = alive[0];
    if (!instance) {
      if (req.committed) {
        this.totals.lostAckCommitted += 1;
      }
      this.failRequest(req, 'task_interrupted');
      return;
    }
    const responseBytes = IMAGE_WORK_MODEL.controlRequestBytes;
    this.submitSerialized(req, {
      resources: [
        { id: instance.tx, units: 1 },
        { id: clientResource.tx, units: 1 },
      ],
      serializationMs: serializationMs(responseBytes),
      propagationMs: IMAGE_LEVEL.network.clientRttMs / 2,
      nodeId: req.appId,
      kind: 'upload-ack',
      innerRows: {
        ids: [`client-population:${req.clientRegion}`],
        bytes: responseBytes,
      },
      onDone: (result, outcome) => {
        if (!result || outcome !== 'ok') {
          if (req.committed) {
            this.totals.lostAckCommitted += 1;
          }
          // Keep propagation-loss and pre-submit failures generic; only a real
          // kernel/queue rejection may keep its distinct final code.
          this.failRequest(
            req,
            outcome === 'failed' && result
              ? this.stageFailureCode(result)
              : 'task_interrupted',
          );
          return;
        }
        this.totals.acknowledgedUploads += 1;
        this.lastAckAtMs = Math.max(this.lastAckAtMs ?? 0, this.scheduler.nowMs);
        const slot = this.recent[req.index % RECENT_RING_SIZE];
        if (slot && slot.ordinal === req.index) {
          slot.acked = true;
        }
        this.completeSuccess(req, responseBytes * result.workFraction, 0);
      },
    });
  }

  private startDetailMetadata(
    req: Request,
    storeNode: ImageMetadataNode,
    appInstance: InstanceRuntime,
  ): void {
    const store = this.stores.get(storeNode.id);
    const player = this.players.get(storeNode.id);
    if (!store || !player) {
      this.failRequest(req, 'metadata_origin_unavailable');
      return;
    }
    const probe = this.resolveProbe(req);
    let originFallback = false;
    if (probe && !this.storeHasRecord(storeNode.id, probe)) {
      const originPlayer = this.players.get(probe.storeId);
      if (!originPlayer || !this.playerUsable(probe.storeId)) {
        if (req.probeState === 'active') {
          req.probeState = 'failed';
        }
        this.failRequest(req, 'metadata_origin_unavailable');
        return;
      }
      originFallback = true;
      req.probeOriginFallback = true;
    }
    const readQuorum = metadataReadQuorum(store.replicas);
    const shard = this.shardFor(store, probe ? probe.seq : req.index);
    const copies = this.shardCopies(player, store, shard).filter((instance) => !instance.down);
    if (copies.length < readQuorum) {
      this.failRequest(req, 'metadata_quorum_unavailable');
      return;
    }
    const quorum = copies.slice(0, readQuorum);
    const resident = quorum[0]?.resident ?? null;
    const residentKey = `record:${req.key}`;
    const residentHit = resident !== null && resident.peek(residentKey) !== undefined;
    if (resident && residentHit) {
      resident.get(residentKey);
    }
    const resources: ResourceRequirement[] = [
      { id: appInstance.cpu, units: 1 },
      { id: appInstance.io, units: 1 },
      { id: appInstance.tx, units: 1 },
      { id: appInstance.rx, units: 1 },
    ];
    for (const copy of quorum) {
      resources.push(
        { id: copy.cpu, units: 1 },
        { id: copy.io, units: 1 },
        { id: copy.rx, units: 1 },
        { id: copy.tx, units: 1 },
      );
    }
    const ioOps =
      IMAGE_WORK_MODEL.metadata.pointLookupPageOps +
      IMAGE_WORK_MODEL.metadata.pointLookupResultRecords +
      (residentHit ? 0 : IMAGE_WORK_MODEL.metadata.readRepairIoOps);
    const duration = stageDurationMs({
      cpuMs:
        IMAGE_WORK_MODEL.app.parseCpuMs +
        IMAGE_WORK_MODEL.app.detailCpuMs +
        IMAGE_WORK_MODEL.metadata.pointLookupCpuMs +
        (residentHit ? IMAGE_WORK_MODEL.metadata.residentLookupCpuMs : 0),
      ioBytes: IMAGE_LEVEL.dataset.metadataBytes,
      ioOps,
    });
    if (resident && !residentHit) {
      resident.put(residentKey, IMAGE_LEVEL.dataset.metadataBytes, 1);
    }
    this.noteTrafficEdge(req.appId ?? '', storeNode.id, 'metadata');
    this.noteTrafficNode(storeNode.id);
    this.submitStage(req, {
      resources,
      durationMs: duration,
      nodeId: player.node.id,
      kind: 'detail-lookup',
      bytesRead: IMAGE_LEVEL.dataset.metadataBytes,
      onDone: (result) => {
        if (!result || result.status !== 'completed') {
          this.retryOrFail(
            req,
            this.stageFailureCode(result),
          );
          return;
        }
        const rtt = this.appStoreRoundTrip(player.region, req);
        this.delayUntil(req, this.scheduler.nowMs + rtt, () => {
          if (!originFallback || !probe) {
            this.startDetailPayload(req, probe, false);
            return;
          }
          this.afterDetailLookup(req, probe);
        });
      },
    });
  }

  /** Origin fallback read: a separate tiny stage plus propagation, never a hold. */
  private afterDetailLookup(req: Request, probe: RecentUpload): void {
    const originPlayer = this.players.get(probe.storeId);
    const originStore = this.stores.get(probe.storeId);
    const localRegion = this.players.get(req.storeId ?? '')?.region ?? 'na';
    if (!originPlayer || !originStore || !this.playerUsable(probe.storeId)) {
      this.failRequest(req, 'metadata_origin_unavailable');
      return;
    }
    const readQuorum = metadataReadQuorum(originStore.replicas);
    const shard = this.shardFor(originStore, probe.seq);
    const copies = this.shardCopies(originPlayer, originStore, shard).filter(
      (instance) => !instance.down,
    );
    if (copies.length < readQuorum) {
      this.failRequest(req, 'metadata_quorum_unavailable');
      return;
    }
    const resources: ResourceRequirement[] = [];
    for (const copy of copies.slice(0, readQuorum)) {
      resources.push(
        { id: copy.cpu, units: 1 },
        { id: copy.io, units: 1 },
        { id: copy.rx, units: 1 },
        { id: copy.tx, units: 1 },
      );
    }
    const link = this.privateLink(localRegion, originPlayer.region);
    if (link) {
      resources.push({ id: link, units: 1 });
    }
    const duration = stageDurationMs({
      cpuMs: IMAGE_WORK_MODEL.metadata.pointLookupCpuMs,
      ioBytes: IMAGE_LEVEL.dataset.metadataBytes,
      ioOps: IMAGE_WORK_MODEL.metadata.pointLookupPageOps + 1,
    });
    this.noteTrafficEdge(req.appId ?? '', originPlayer.node.id, 'metadata');
    this.noteTrafficNode(originPlayer.node.id);
    this.submitStage(req, {
      resources,
      durationMs: duration,
      nodeId: originPlayer.node.id,
      kind: 'detail-origin-lookup',
      onDone: (result) => {
        if (!result || result.status !== 'completed') {
          this.retryOrFail(
            req,
            this.stageFailureCode(result),
          );
          return;
        }
        this.delayUntil(
          req,
          this.scheduler.nowMs + regionDistanceMs(localRegion, originPlayer.region) * 2,
          () => this.startDetailPayload(req, probe, true),
        );
      },
    });
  }

  private startDetailPayload(
    req: Request,
    probe: RecentUpload | null,
    originFallback: boolean,
  ): void {
    const appId = req.appId;
    const app = appId ? this.players.get(appId) : undefined;
    const appRoute = appId ? this.appRouteById.get(appId) : undefined;
    if (!app || !appRoute) {
      this.failRequest(req, 'no_healthy_route');
      return;
    }
    const appInstance =
      app.instances.find((instance) => instance.index === req.appInstance) ?? app.instances[0];
    if (!appInstance) {
      this.failRequest(req, 'no_healthy_route');
      return;
    }
    const payloadBytes = IMAGE_LEVEL.dataset.originalBytes;
    const direct = appRoute.delivery === 'direct';
    let providerRegion: ImageRegion | null = null;
    let cacheInstance: InstanceRuntime | null = null;
    let cacheHit = false;
    let providerId: string | null;
    // Blob visibility is independent of metadata replication: a record younger
    // than the provider's remote-visibility window is only readable at its
    // origin endpoint. Routing already restricted the app choice to a path that
    // can reach that origin; here we enforce it for the chosen path.
    const youngOrigin = req.youngOriginRegion;
    const blobInvisibleRemotely = youngOrigin !== null;
    if (direct) {
      providerId = this.pickProvider(req, youngOrigin, youngOrigin !== null);
      if (!providerId) {
        this.failRequest(req, blobInvisibleRemotely ? 'metadata_origin_unavailable' : 'no_healthy_route');
        return;
      }
      providerRegion = this.providerRegion(providerId);
      if (youngOrigin !== null && providerRegion !== youngOrigin) {
        // No explicit connected origin endpoint: the recent remote read cannot
        // be served correctly, so it must fail rather than invent visibility.
        this.failRequest(req, 'metadata_origin_unavailable');
        return;
      }
    } else {
      const blobPath = appRoute.blobPath;
      if (!blobPath) {
        this.failRequest(req, 'no_healthy_route');
        return;
      }
      providerId = blobPath.providerId;
      providerRegion = this.providerRegion(providerId);
      if (blobPath.cacheId) {
        const cachePlayer = this.players.get(blobPath.cacheId);
        if (!cachePlayer) {
          this.failRequest(req, 'no_healthy_route');
          return;
        }
        req.cacheId = blobPath.cacheId;
        const alive = this.aliveInstances(cachePlayer);
        const chosen = alive[req.id % Math.max(1, alive.length)] ?? null;
        cacheInstance = chosen;
        if (chosen) {
          req.cacheInstance = chosen.index;
          const cacheKey = this.cacheKey(req.key, ORIGINAL_VARIANT);
          const cacheStatus = this.cacheLookup(chosen, cacheKey, req);
          if (cacheStatus === 'hit') {
            cacheHit = true;
          } else if (cacheStatus === 'pending') {
            this.awaitFill(req, chosen, cacheKey, (ok) => {
              if (!ok) {
                this.retryOrFail(req, 'task_interrupted');
                return;
              }
              this.startDetailPayload(req, probe, originFallback);
            });
            return;
          }
        }
      }
    }
    if (!direct && !cacheHit && !this.endpointUsable(providerRegion)) {
      this.failRequest(req, 'endpoint_unavailable');
      return;
    }
    if (!direct && !cacheHit && youngOrigin !== null && providerRegion !== youngOrigin) {
      // The fixed proxy path cannot reach the origin endpoint; serving the
      // local endpoint would return an object that is not visible yet.
      this.failRequest(req, 'metadata_origin_unavailable');
      return;
    }
    req.providerId = providerId;
    const providerAcc = providerId ? this.accumulatorByNode.get(providerId) : undefined;
    if (providerAcc && (direct || !cacheHit)) {
      providerAcc.requests += 1;
      this.noteTrafficNode(providerId ?? '');
    }
    if (providerId) {
      if (direct) {
        if (!cacheHit) {
          this.noteTrafficEdge(req.clientId, providerId, 'blob');
        }
      } else if (cacheInstance) {
        if (req.cacheId) {
          if (!cacheHit) {
            this.noteTrafficEdge(req.cacheId, providerId, 'blob');
          }
        }
      } else if (!cacheHit) {
        this.noteTrafficEdge(appId ?? '', providerId, 'blob');
      }
    }
    const path = this.readPath({
      clientRegion: req.clientRegion,
      appInstance,
      appRegion: app.region,
      cacheInstance,
      providerRegion,
      includeProvider: !cacheHit && providerRegion !== null,
      direct,
    });
    const buffered = appRoute.delivery === 'proxy' && app.buffering === 'buffered';
    const hops = direct ? 1 : cacheInstance ? 3 : 2;
    const serialization = serializationMs(payloadBytes) * (buffered ? hops : 1);
    const bufferBytes = buffered
      ? payloadBytes * hops
      : IMAGE_WORK_MODEL.transport.streamingBufferBytesPerHop * hops;
    const bufferInstance = cacheInstance ?? appInstance;
    const ownedFillKey =
      cacheInstance !== null && !cacheHit ? this.cacheKey(req.key, ORIGINAL_VARIANT) : null;
    const cacheWorkCpuMs =
      cacheInstance !== null
        ? IMAGE_WORK_MODEL.cache.lookupCpuMs + IMAGE_WORK_MODEL.cache.fillCpuMsPerMb
        : 0;
    const startAt =
      !cacheHit && providerRegion
        ? Math.max(this.scheduler.nowMs, this.acquireProviderSlot(providerRegion, 'read', req.scored)) +
          (path.requestPropagationMs ?? path.propagationMs) +
          providerReadBandMs(req.band)
        : this.scheduler.nowMs;
    const proceed = (): void => {
      this.submitSerialized(req, {
        resources:
          cacheInstance !== null
            ? [
                ...path.resources,
                {
                  id: cacheInstance.cpu,
                  units: IMAGE_WORK_MODEL.transport.relayCpuUnitsPerFlow,
                },
                {
                  id: cacheInstance.io,
                  units: IMAGE_WORK_MODEL.transport.relayIoUnitsPerFlow,
                },
              ]
            : path.resources,
        serializationMs: Math.max(serialization, stageDurationMs({ cpuMs: cacheWorkCpuMs })),
        propagationMs: path.propagationMs,
        buffer: { instance: bufferInstance, bytes: bufferBytes },
        nodeId: appId ?? null,
        kind: 'detail-transfer',
        transfer: { path, bytes: payloadBytes, direction: 'down' },
        providerRetrievalBytes:
          !cacheHit && providerRegion !== null ? payloadBytes : 0,
        onDone: (result, outcome) => {
          if (!result) {
            this.retryOrFail(req, 'endpoint_unavailable');
            return;
          }
          const delivered = payloadBytes * result.workFraction;
          if (outcome === 'failed') {
            this.retryOrFail(
              req,
              this.stageFailureCode(result),
            );
            return;
          }
          if (outcome === 'propagation-lost') {
            this.failRequest(req, 'endpoint_unavailable');
            return;
          }
          if (cacheInstance !== null && ownedFillKey !== null) {
            this.fillOwned(cacheInstance, req, ownedFillKey, payloadBytes);
          }
          const servedRecent = this.recentForKey(req.key);
          if (
            servedRecent !== null &&
            providerRegion !== null &&
            providerRegion !== servedRecent.region &&
            this.scheduler.nowMs - servedRecent.committedAtMs <
              IMAGE_CATALOG.provider.remoteReadVisibilityMs
          ) {
            // Defensive assertion: a successful payload must belong to the
            // requested immutable key *and* be visible at the endpoint used.
            this.totals.visibilityViolations += 1;
            this.failRequest(req, 'metadata_origin_unavailable');
            return;
          }
          if (!this.probeIdentityOk(req)) {
            this.totals.visibilityViolations += 1;
            this.failRequest(req, 'metadata_origin_unavailable');
            return;
          }
          this.completeProbe(req);
          this.completeSuccess(req, delivered, 0);
        },
      });
    };
    if (startAt > this.scheduler.nowMs + 0.01) {
      this.delayUntil(req, startAt, proceed);
    } else {
      proceed();
    }
  }

  private startSearchMetadata(
    req: Request,
    storeNode: ImageMetadataNode,
    appInstance: InstanceRuntime,
  ): void {
    const player = this.players.get(storeNode.id);
    const store = this.stores.get(storeNode.id);
    if (!player || !store) {
      this.failRequest(req, 'metadata_origin_unavailable');
      return;
    }
    const index = storeNode.config.index;
    const indexOk =
      req.searchKind === 0
        ? index === 'user' || index === 'user-tag'
        : index === 'user-tag';
    if (!indexOk) {
      this.failRequest(req, 'metadata_index_missing');
      return;
    }
    const readQuorum = metadataReadQuorum(store.replicas);
    const shard = this.shardFor(store, req.index);
    const copies = this.shardCopies(player, store, shard).filter((instance) => !instance.down);
    if (copies.length < readQuorum) {
      this.failRequest(req, 'metadata_quorum_unavailable');
      return;
    }
    const quorum = copies.slice(0, readQuorum);
    const resources: ResourceRequirement[] = [
      { id: appInstance.cpu, units: 1 },
      { id: appInstance.io, units: 1 },
      { id: appInstance.tx, units: 1 },
      { id: appInstance.rx, units: 1 },
    ];
    for (const copy of quorum) {
      resources.push(
        { id: copy.cpu, units: 1 },
        { id: copy.io, units: 1 },
        { id: copy.rx, units: 1 },
        { id: copy.tx, units: 1 },
      );
    }
    const results = IMAGE_LEVEL.dataset.searchResultsPerSearch;
    const resultBytes = results * IMAGE_LEVEL.dataset.metadataBytes;
    const pageOps =
      req.searchKind === 0
        ? IMAGE_WORK_MODEL.metadata.userIndexPageOps
        : IMAGE_WORK_MODEL.metadata.tagIndexPageOps;
    const postings =
      req.searchKind === 0 ? 0 : IMAGE_WORK_MODEL.metadata.tagIndexPostingsScanned;
    const duration =
      stageDurationMs({
        cpuMs:
          IMAGE_WORK_MODEL.app.parseCpuMs +
          IMAGE_WORK_MODEL.app.searchCpuMs +
          (req.searchKind === 0
            ? IMAGE_WORK_MODEL.metadata.userIndexCpuMs
            : IMAGE_WORK_MODEL.metadata.tagIndexCpuMs),
        ioBytes: resultBytes + postings * IMAGE_CATALOG.metadata.tagPostingBytes,
        ioOps: pageOps + results,
      });
    this.noteTrafficEdge(req.appId ?? '', storeNode.id, 'metadata');
    this.noteTrafficNode(storeNode.id);
    this.submitStage(req, {
      resources,
      durationMs: duration,
      nodeId: player.node.id,
      kind: 'search-lookup',
      bytesRead: resultBytes,
      onDone: (result) => {
        if (!result || result.status !== 'completed') {
          this.retryOrFail(
            req,
            this.stageFailureCode(result),
          );
          return;
        }
        this.delayUntil(
          req,
          this.scheduler.nowMs + this.appStoreRoundTrip(player.region, req),
          () => this.startSearchThumbnails(req),
        );
      },
    });
  }

  private startSearchThumbnails(req: Request): void {
    const appId = req.appId;
    const app = appId ? this.players.get(appId) : undefined;
    const appRoute = appId ? this.appRouteById.get(appId) : undefined;
    if (!app || !appRoute) {
      this.failRequest(req, 'no_healthy_route');
      return;
    }
    const appInstance =
      app.instances.find((instance) => instance.index === req.appInstance) ?? app.instances[0];
    if (!appInstance) {
      this.failRequest(req, 'no_healthy_route');
      return;
    }
    const results = IMAGE_LEVEL.dataset.searchResultsPerSearch;
    const metaBytes = results * IMAGE_LEVEL.dataset.metadataBytes;
    const thumbBytes = results * IMAGE_LEVEL.dataset.thumbnailBytes;
    const allBytes = thumbBytes + metaBytes;
    const direct = appRoute.delivery === 'direct';
    let providerRegion: ImageRegion | null;
    let cacheInstance: InstanceRuntime | null = null;
    let misses = results;
    let providerId: string | null;
    const missBands: number[] = [];
    const pendingFills: { key: string; band: number }[] = [];
    if (direct) {
      providerId = this.pickProvider(req);
      if (!providerId) {
        this.failRequest(req, 'no_healthy_route');
        return;
      }
      providerRegion = this.providerRegion(providerId);
      for (let child = 0; child < results; child += 1) {
        missBands.push(this.trace.searches.bands[req.index * results + child] ?? 0);
      }
    } else {
      const blobPath = appRoute.blobPath;
      if (!blobPath) {
        this.failRequest(req, 'no_healthy_route');
        return;
      }
      providerId = blobPath.providerId;
      providerRegion = this.providerRegion(providerId);
      if (blobPath.cacheId) {
        const cachePlayer = this.players.get(blobPath.cacheId);
        if (!cachePlayer) {
          this.failRequest(req, 'no_healthy_route');
          return;
        }
        req.cacheId = blobPath.cacheId;
        const alive = this.aliveInstances(cachePlayer);
        cacheInstance = alive[req.id % Math.max(1, alive.length)] ?? null;
        if (cacheInstance) {
          req.cacheInstance = cacheInstance.index;
          misses = 0;
          const missKeys: string[] = [];
          for (let child = 0; child < results; child += 1) {
            const key = this.trace.searches.keys[req.index * results + child] ?? 0;
            const cacheKey = this.cacheKey(key, THUMBNAIL_VARIANT);
            const status = this.cacheLookup(cacheInstance, cacheKey, req);
            if (status === 'hit') {
              continue;
            }
            const band = this.trace.searches.bands[req.index * results + child] ?? 0;
            if (status === 'miss') {
              misses += 1;
              missKeys.push(cacheKey);
              missBands.push(band);
            } else {
              pendingFills.push({ key: cacheKey, band });
            }
          }
          req.missKeys = missKeys;
        } else {
          for (let child = 0; child < results; child += 1) {
            missBands.push(this.trace.searches.bands[req.index * results + child] ?? 0);
          }
        }
      } else {
        for (let child = 0; child < results; child += 1) {
          missBands.push(this.trace.searches.bands[req.index * results + child] ?? 0);
        }
      }
    }
    const providerUsed = direct || misses > 0;
    if (providerUsed && !this.endpointUsable(providerRegion)) {
      this.failRequest(req, 'endpoint_unavailable');
      return;
    }
    req.providerId = providerId;
    const providerAcc = providerId ? this.accumulatorByNode.get(providerId) : undefined;
    if (providerAcc && providerUsed) {
      providerAcc.requests += 1;
      this.noteTrafficNode(providerId ?? '');
    }
    if (providerId && providerUsed) {
      if (direct) {
        this.noteTrafficEdge(req.clientId, providerId, 'blob');
      } else if (cacheInstance) {
        if (req.cacheId) {
          this.noteTrafficEdge(req.cacheId, providerId, 'blob');
        }
      } else {
        this.noteTrafficEdge(appId ?? '', providerId, 'blob');
      }
    }
    let bandMs = 0;
    for (const band of missBands) {
      const ms = providerReadBandMs(band);
      if (ms > bandMs) {
        bandMs = ms;
      }
    }
    const buffered = appRoute.delivery === 'proxy' && app.buffering === 'buffered';
    const hops = direct ? 1 : cacheInstance ? 3 : 2;
    const cacheWorkCpuMs =
      cacheInstance !== null
        ? IMAGE_WORK_MODEL.cache.lookupCpuMs * results +
          IMAGE_WORK_MODEL.cache.fillCpuMsPerMb
        : 0;

    if (!cacheInstance) {
      // Direct or proxy-without-cache: every child is a provider read, and the
      // single response stage still shares one end-user 1 Gbit/s access link.
      const providerBytes = providerUsed ? results * IMAGE_LEVEL.dataset.thumbnailBytes : 0;
      const path = this.readPath({
        clientRegion: req.clientRegion,
        appInstance,
        appRegion: app.region,
        cacheInstance: null,
        providerRegion,
        includeProvider: providerUsed,
        direct,
      });
      const serialization = Math.max(
        serializationMs(allBytes) * (buffered ? hops : 1),
        serializationMs(providerBytes),
      );
      const startAt = providerUsed && providerRegion
        ? Math.max(this.scheduler.nowMs, this.acquireProviderSlots(providerRegion, 'read', results, req.scored)) +
          path.requestPropagationMs +
          bandMs
        : this.scheduler.nowMs;
      const proceed = (): void => {
        this.submitSerialized(req, {
          resources: path.resources,
          serializationMs: serialization,
          propagationMs: path.propagationMs,
          buffer: {
            instance: appInstance,
            bytes: buffered
              ? thumbBytes * hops
              : IMAGE_WORK_MODEL.transport.streamingBufferBytesPerHop * hops,
          },
          nodeId: appId ?? null,
          kind: 'search-thumbnails',
          transfer: { path, bytes: allBytes, direction: 'down' },
          providerRetrievalBytes: providerUsed ? providerBytes : 0,
          onDone: (result, outcome) => {
            if (!result) {
              this.retryOrFail(req, 'endpoint_unavailable');
              return;
            }
            const delivered = allBytes * result.workFraction;
            if (outcome === 'failed') {
              this.retryOrFail(
                req,
                this.stageFailureCode(result),
              );
              return;
            }
            if (outcome === 'propagation-lost') {
              this.failRequest(req, 'endpoint_unavailable');
              return;
            }
            this.completeSuccess(req, delivered, 0);
          },
        });
      };
      if (startAt > this.scheduler.nowMs + 0.01) {
        this.delayUntil(req, startAt, proceed);
      } else {
        proceed();
      }
      return;
    }

    // Cache path. The client stage carries all ten thumbnails plus metadata on
    // the shared end-user access link; the provider stage fetches only this
    // request's misses and pays only their RPC admission, start band and
    // bytes. Coalesced keys wait for the owner's fill; the client stage starts
    // only after those bytes (and every own miss) are ready.
    const cacheRegion = this.players.get(cacheInstance.nodeId)?.region ?? app.region;
    const link = providerRegion ? this.privateLink(providerRegion, cacheRegion) : null;
    const clientResources: ResourceRequirement[] = [
      { id: `client:${req.clientRegion}:tx`, units: 1 },
      { id: appInstance.tx, units: 1 },
      { id: appInstance.rx, units: 1 },
      { id: cacheInstance.tx, units: 1 },
      {
        id: cacheInstance.cpu,
        units: IMAGE_WORK_MODEL.transport.relayCpuUnitsPerFlow,
      },
      {
        id: cacheInstance.io,
        units: IMAGE_WORK_MODEL.transport.relayIoUnitsPerFlow,
      },
    ];
    const providerResources: ResourceRequirement[] = [];
    if (providerUsed) {
      providerResources.push(
        { id: `provider:${providerRegion ?? cacheRegion}:tx`, units: 1 },
        { id: cacheInstance.rx, units: 1 },
        {
          id: cacheInstance.cpu,
          units: IMAGE_WORK_MODEL.transport.relayCpuUnitsPerFlow,
        },
        {
          id: cacheInstance.io,
          units: IMAGE_WORK_MODEL.transport.relayIoUnitsPerFlow,
        },
      );
      if (link) {
        providerResources.push({ id: link, units: 1 });
      }
    }
    const clientPath: PathPlan = {
      resources: clientResources,
      privateLinks: [],
      propagationMs:
        regionDistanceMs(req.clientRegion, app.region) +
        (cacheRegion !== app.region ? regionDistanceMs(cacheRegion, app.region) : 0),
      clientId: `client-population:${req.clientRegion}`,
      providerId: null,
      relayNodeIds: [app.node.id, cacheInstance.nodeId],
      requestPropagationMs:
        regionDistanceMs(req.clientRegion, app.region) +
        (cacheRegion !== app.region ? regionDistanceMs(cacheRegion, app.region) : 0),
    };
    const providerPath: PathPlan = {
      resources: providerResources,
      privateLinks: link ? [link] : [],
      propagationMs:
        providerRegion && providerUsed
          ? regionDistanceMs(providerRegion, cacheRegion)
          : 0,
      clientId: null,
      providerId: providerUsed
        ? `provider-endpoint:${providerRegion ?? cacheRegion}`
        : null,
      relayNodeIds: [cacheInstance.nodeId],
      requestPropagationMs:
        providerRegion && providerUsed
          ? regionDistanceMs(cacheRegion, providerRegion)
          : 0,
    };
    const providerBytes = misses * IMAGE_LEVEL.dataset.thumbnailBytes;
    let pendingCount = pendingFills.length;
    let providerDone = misses === 0;
    let clientStarted = false;
    let failure: FailureCode | null = null;
    const startClientStage = (): void => {
      if (clientStarted || req.finalized) {
        return;
      }
      if (!providerDone || pendingCount > 0) {
        return;
      }
      if (failure !== null) {
        this.failRequest(req, failure);
        return;
      }
      clientStarted = true;
      this.submitSerialized(req, {
        resources: clientResources,
        serializationMs: Math.max(
          serializationMs(allBytes) * (buffered ? hops : 1),
          stageDurationMs({ cpuMs: cacheWorkCpuMs }),
        ),
        propagationMs: clientPath.propagationMs,
        buffer: {
          instance: cacheInstance,
          bytes: buffered
            ? thumbBytes * hops
            : IMAGE_WORK_MODEL.transport.streamingBufferBytesPerHop * hops,
        },
        nodeId: appId ?? null,
        kind: 'search-client-fanout',
        innerRows: {
          ids: [
            `client-population:${req.clientRegion}`,
            `instance-nic:${app.node.id}`,
            `instance-nic:${cacheInstance.nodeId}`,
          ],
          bytes: allBytes,
        },
        onDone: (result, outcome) => {
          if (!result) {
            this.failRequest(req, 'endpoint_unavailable');
            return;
          }
          const delivered = allBytes * result.workFraction;
          if (outcome !== 'ok') {
            this.failRequest(
              req,
              outcome === 'failed'
                ? this.stageFailureCode(result)
                : 'task_interrupted',
            );
            return;
          }
          this.completeSuccess(req, delivered, 0);
        },
      });
    };
    for (const pending of pendingFills) {
      this.awaitFill(req, cacheInstance, pending.key, (ok) => {
        if (!ok && failure === null) {
          // A generic fill failure is only a fallback: if this request already
          // recorded a specific provider queue_full/terminal code, keep it.
          failure = 'task_interrupted';
        }
        pendingCount -= 1;
        startClientStage();
      });
    }
    if (misses > 0 && providerRegion) {
      let bandMs = 0;
      for (const band of missBands) {
        bandMs = Math.max(bandMs, providerReadBandMs(band));
      }
      const startAt =
        Math.max(this.scheduler.nowMs, this.acquireProviderSlots(providerRegion, 'read', misses, req.scored)) +
        providerPath.requestPropagationMs +
        bandMs;
      this.delayUntil(req, startAt, () => {
        this.submitSerialized(req, {
          resources: providerResources,
          serializationMs: serializationMs(providerBytes),
          propagationMs: providerPath.propagationMs,
          buffer: null,
          nodeId: appId ?? null,
          kind: 'search-provider-misses',
          transfer: { path: providerPath, bytes: providerBytes, direction: 'down' },
          providerRetrievalBytes: providerBytes,
          onDone: (result, outcome) => {
            if (!result) {
              failure = 'task_interrupted';
              providerDone = true;
              startClientStage();
              return;
            }
            if (outcome === 'ok') {
              for (const key of req.missKeys ?? []) {
                this.fillOwned(cacheInstance, req, key, IMAGE_LEVEL.dataset.thumbnailBytes);
              }
            }
            req.missKeys = null;
            if (outcome !== 'ok') {
              // Preserve the real terminal code through the deferred fan-out
              // gate instead of flattening it to task_interrupted.
              failure = this.stageFailureCode(result);
            }
            providerDone = true;
            startClientStage();
          },
        });
      });
    } else {
      startClientStage();
    }
  }


  private uploadId(ordinal: number): string {
    return `upload:${ordinal}`;
  }

  private uploadKey(ordinal: number): number {
    return uploadKeyForOrdinal(ordinal);
  }

  /** Recent immutable upload addressed by a synthetic-trace key, if any. */
  private recentForKey(key: number): RecentUpload | null {
    const base =
      IMAGE_LEVEL.workload.hotKeys + IMAGE_LEVEL.workload.longTailRepresentativeKeys + 1;
    if (key < base) {
      return null;
    }
    const ordinal = key - base;
    const slot = this.recent[ordinal % RECENT_RING_SIZE];
    return slot && slot.ordinal === ordinal ? slot : null;
  }

  // -------------------------------------------------------------------------
  // Metadata helpers
  // -------------------------------------------------------------------------

  private shardFor(store: StoreRuntime, ordinal: number): number {
    return ((ordinal % store.shardCount) + store.shardCount) % store.shardCount;
  }

  private shardCopies(
    player: PlayerRuntime,
    store: StoreRuntime,
    shard: number,
  ): InstanceRuntime[] {
    const start = shard * store.replicas;
    const copies: InstanceRuntime[] = [];
    for (let offset = 0; offset < store.replicas; offset += 1) {
      const instance = player.instances[start + offset];
      if (instance) {
        copies.push(instance);
      }
    }
    return copies;
  }

  private storeHasRecord(storeId: string, record: RecentUpload): boolean {
    if (record.storeId === storeId) {
      return true;
    }
    const applied = this.replicaProgress.get(storeId)?.get(record.storeId) ?? 0;
    return applied >= record.seq;
  }

  private resolveProbe(req: Request): RecentUpload | null {
    if (req.probeResolved) {
      return req.resolvedProbe;
    }
    req.probeResolved = true;
    if (req.probeOrdinal < 0) {
      req.probeState = 'none';
      return null;
    }
    const slot = this.recent[req.probeOrdinal % RECENT_RING_SIZE];
    if (!slot || slot.ordinal !== req.probeOrdinal || !slot.acked) {
      req.probeState = 'none';
      return null;
    }
    req.probeState = 'active';
    // Bind the requested business object to the resolved immutable upload
    // before any routing, metadata, cache or blob work. A probe must read
    // exactly this key; the synthetic trace key is irrelevant from here on.
    req.key = slot.key;
    req.resolvedProbe = slot;
    this.totals.freshnessProbes += 1;
    return slot;
  }

  /**
   * Probe identity and young-object origin are resolved before app selection so
   * the router can pick a path that can actually reach the origin endpoint.
   */
  private prepareDetailIdentity(req: Request): void {
    const probe = this.resolveProbe(req);
    const recent = probe ?? this.recentForKey(req.key);
    req.youngOriginRegion =
      recent !== null &&
      this.scheduler.nowMs - recent.committedAtMs < IMAGE_CATALOG.provider.remoteReadVisibilityMs
        ? recent.region
        : null;
  }

  /** Can this app's explicit path reach the object's current origin endpoint? */
  private appCanReachOrigin(
    req: Request,
    option: ImageRoutePlan['clients'][number]['apps'][number],
    nowMs: number,
  ): boolean {
    const origin = req.youngOriginRegion;
    if (origin === null) {
      return true;
    }
    if (option.delivery === 'direct') {
      const providers = this.clientProviders.get(req.clientId) ?? [];
      for (const provider of providers) {
        if (provider.region === origin && this.endpointUsable(origin)) {
          return true;
        }
      }
      return false;
    }
    const blobPath = option.blobPath;
    if (!blobPath) {
      return false;
    }
    if (this.providerRegion(blobPath.providerId) !== origin) {
      return false;
    }
    if (blobPath.cacheId && !this.playerKnownUsable(blobPath.cacheId, nowMs)) {
      return false;
    }
    return this.endpointUsable(origin);
  }

  /**
   * A successful probe must have addressed the same committed upload that
   * resolveProbe bound. This is the identity assertion that no unrelated cache
   * hit or old object can satisfy.
   */
  private probeIdentityOk(req: Request): boolean {
    if (req.probeState !== 'active') {
      return true;
    }
    const record = this.recentForKey(req.key);
    return record !== null && record.ordinal === req.probeOrdinal;
  }

  private completeProbe(req: Request): void {
    if (req.probeState !== 'active') {
      return;
    }
    const probe = this.recent[req.probeOrdinal % RECENT_RING_SIZE];
    req.probeState = 'succeeded';
    this.totals.freshnessSuccess += 1;
    if (!probe || probe.ordinal !== req.probeOrdinal) {
      return;
    }
    const lag = req.probeOriginFallback
      ? 0
      : Math.max(0, this.scheduler.nowMs - probe.committedAtMs);
    req.probeLagMs = lag;
    this.freshnessLags.push(lag);
  }

  // -------------------------------------------------------------------------
  // Cache helpers
  // -------------------------------------------------------------------------

  private cacheKey(key: number, variant: string): string {
    return `${variant}:${key}`;
  }

  /**
   * Fill identity is per physical cache instance: the LRU store lives on one
   * instance, so a pool-wide key would let a waiter on another instance see a
   * hit that its own store does not contain.
   */
  private fillKeyFor(instance: InstanceRuntime, cacheKey: string): string {
    return `${instance.nodeId}:${instance.index}:${cacheKey}`;
  }

  /**
   * Classifies one cache child. `pending` means another request already owns
   * the fill: this request must wait for those bytes, never treat them as an
   * immediate hit. `miss` makes this request the fill owner.
   */
  private cacheLookup(
    instance: InstanceRuntime,
    key: string,
    req: Request,
  ): 'hit' | 'miss' | 'pending' {
    const cache = instance.cacheStore;
    this.noteTrafficNode(instance.nodeId);
    // One app -> cache logical dispatch per actual lookup, whatever the
    // outcome (hit, miss or coalesced pending). Bytes still relay through the
    // cache on a hit, so this route must never look idle.
    this.noteTrafficEdge(req.appId ?? '', instance.nodeId, 'blob');
    if (!cache) {
      return 'miss';
    }
    if (cache.peek(key) !== undefined) {
      cache.get(key);
      if (req.scored) {
        this.totals.cacheHits += 1;
      }
      return 'hit';
    }
    if (req.scored) {
      this.totals.cacheMisses += 1;
    }
    const fillKey = this.fillKeyFor(instance, key);
    if (this.cacheFillPolicy(instance.nodeId) === 'coalesce' && this.cacheFillInFlight.has(fillKey)) {
      if (req.scored) {
        this.totals.coalesced += 1;
      }
      const acc = this.accumulatorByNode.get(instance.nodeId);
      if (acc) {
        acc.cacheCoalesced += 1;
      }
      return 'pending';
    }
    this.fillGeneration += 1;
    this.cacheFillInFlight.set(fillKey, {
      owner: req,
      generation: this.fillGeneration,
      waiters: [],
    });
    req.ownedFills.push({ instance, key, generation: this.fillGeneration });
    return 'miss';
  }

  /** Waits for an in-flight coalesced fill; failed fills wake the waiter. */
  private awaitFill(
    req: Request,
    instance: InstanceRuntime,
    key: string,
    onReady: (ok: boolean) => void,
  ): void {
    const fillKey = this.fillKeyFor(instance, key);
    const entry = this.cacheFillInFlight.get(fillKey);
    if (!entry) {
      onReady(true);
      return;
    }
    req.fillWaitKeys.push(fillKey);
    entry.waiters.push({
      req,
      cb: (ok) => {
        if (!req.finalized) {
          onReady(ok);
        }
      },
    });
  }

  private resolveFill(instance: InstanceRuntime, key: string, ok: boolean, bytes: number): void {
    const fillKey = this.fillKeyFor(instance, key);
    const entry = this.cacheFillInFlight.get(fillKey);
    if (ok) {
      const cache = instance.cacheStore;
      if (cache) {
        cache.put(key, bytes, 1);
      }
    }
    this.cacheFillInFlight.delete(fillKey);
    if (!entry) {
      return;
    }
    for (const waiter of entry.waiters) {
      waiter.cb(ok);
    }
  }

  /**
   * Publishes a fill only when this request still owns this exact generation.
   * A late owner can never delete or replace a newer fill for the same key.
   */
  private fillOwned(instance: InstanceRuntime, req: Request, key: string, bytes: number): void {
    const fillKey = this.fillKeyFor(instance, key);
    const entry = this.cacheFillInFlight.get(fillKey);
    const ref = req.ownedFills.find(
      (item) => item.instance === instance && item.key === key,
    );
    if (!entry || !ref || entry.owner !== req || entry.generation !== ref.generation) {
      return;
    }
    req.ownedFills = req.ownedFills.filter((item) => item !== ref);
    this.resolveFill(instance, key, true, bytes);
  }

  /** Cancellation/failure: settle every still-owned fill and wake its waiters. */
  private settleOwnedFills(req: Request): void {
    if (req.ownedFills.length === 0) {
      return;
    }
    for (const ref of req.ownedFills) {
      const fillKey = this.fillKeyFor(ref.instance, ref.key);
      const entry = this.cacheFillInFlight.get(fillKey);
      if (!entry || entry.owner !== req || entry.generation !== ref.generation) {
        continue;
      }
      this.resolveFill(ref.instance, ref.key, false, 0);
    }
    req.ownedFills = [];
  }

  private finalizeCommon(req: Request): void {
    this.releaseDeadline(req);
    this.removeFillWaiters(req);
    this.settleOwnedFills(req);
  }



  private cacheFillPolicy(nodeId: string): 'coalesce' | 'independent' {
    const player = this.players.get(nodeId);
    if (player && player.node.kind === 'cache') {
      return player.node.config.fill;
    }
    return 'coalesce';
  }

  // -------------------------------------------------------------------------
  // Replication and publication
  // -------------------------------------------------------------------------

  private scheduleReplication(originId: string, targetId: string, delayMs: number): void {
    this.scheduler.schedule(
      this.scheduler.nowMs + Math.max(0, delayMs),
      () => this.runReplication(originId, targetId),
      4,
    );
  }

  private runReplication(originId: string, targetId: string): void {
    const origin = this.stores.get(originId);
    const target = this.stores.get(targetId);
    if (!origin || !target) {
      return;
    }
    const originPlayer = this.players.get(originId);
    const targetPlayer = this.players.get(targetId);
    if (!originPlayer || !targetPlayer) {
      return;
    }
    const key = `${originId}>${targetId}`;
    const sent = this.sentProgress.get(targetId)?.get(originId) ?? 0;
    const pending = origin.seq - sent;
    if (pending <= 0) {
      this.scheduleReplication(originId, targetId, REPLICATION_POLL_MS);
      return;
    }
    if (!this.playerUsable(targetId) || !this.playerUsable(originId)) {
      this.recordReplicationBacklog(targetId, origin, this.appliedSeq(targetId, originId));
      this.scheduleReplication(originId, targetId, REPLICATION_POLL_MS);
      return;
    }
    const batch = Math.min(pending, REPLICATION_BATCH_RECORDS);
    const bytes = batch * (IMAGE_LEVEL.dataset.metadataBytes + target.indexBytes);
    const originInstance = this.aliveInstanceAt(originPlayer, sent);
    const targetInstance = this.aliveInstanceAt(targetPlayer, sent);
    if (!originInstance || !targetInstance) {
      this.scheduleReplication(originId, targetId, REPLICATION_POLL_MS);
      return;
    }
    const link = this.privateLink(origin.region, target.region);
    const flightResources: ResourceRequirement[] = [
      { id: originInstance.tx, units: 1 },
      { id: targetInstance.rx, units: 1 },
    ];
    if (link) {
      flightResources.push({ id: link, units: 1 });
    }
    for (const item of flightResources) {
      if (this.unavailable.has(item.id)) {
        // Never queue a batch behind an outage: a blocked head would stall
        // every other task sharing the target store's FIFO queues.
        this.recordReplicationBacklog(targetId, origin, this.appliedSeq(targetId, originId));
        this.scheduleReplication(originId, targetId, REPLICATION_POLL_MS);
        return;
      }
    }
    const propagation = link
      ? regionDistanceMs(origin.region, target.region)
      : IMAGE_WORK_MODEL.transport.localPropagationMs;
    // The flight serializes bytes only. The apply stage (CPU + IO at the
    // target) starts after the records actually arrive, so a commit is never
    // teleported to a remote region.
    const flightMs = serializationMs(bytes);
    this.sentProgress.set(
      targetId,
      (this.sentProgress.get(targetId) ?? new Map<string, number>()).set(originId, sent + batch),
    );
    this.noteTrafficEdge(originId, targetId, 'replicate');
    this.noteTrafficNode(targetId);
    this.kernel.submit({
      id: `replicate:${key}:${sent}`,
      resources: flightResources,
      durationMs: flightMs,
      onFinish: (result) => {
        const transmitted = bytes * result.workFraction;
        if (link && transmitted > 0) {
          // Failed and partial flights keep the bytes they really moved.
          const row = this.linkRows.get(this.linkRowId(origin.region, target.region));
          if (row) {
            row.sentBytes += transmitted;
            row.receivedBytes += transmitted;
            row.transfers += 1;
          }
          // Cost attribution follows the measured window: only records whose
          // origin commit falls inside it contribute to the monthly bill.
          let measuredRecords = 0;
          for (let seq = sent; seq < sent + batch; seq += 1) {
            const commitAt = origin.commitTimes[seq];
            if (
              commitAt !== undefined &&
              commitAt >= this.trace.measuredFromMs &&
              commitAt < this.trace.measuredFromMs + this.trace.measuredMs
            ) {
              measuredRecords += 1;
            }
          }
          if (measuredRecords > 0) {
            this.totals.crossRegionBytes +=
              (measuredRecords * bytes * result.workFraction) / Math.max(1, batch);
          }
        }
        if (result.status !== 'completed') {
          // Fault or cancellation in transit: nothing arrived; retry the range.
          this.rollbackSent(targetId, originId, sent);
          this.scheduleReplication(originId, targetId, REPLICATION_POLL_MS);
          return;
        }
        // Pipeline the next flight immediately; applies stay ordered.
        this.scheduleReplication(originId, targetId, 0);
        const queue = this.applyQueues.get(key) ?? [];
        queue.push({
          start: sent,
          end: sent + batch,
          at: this.scheduler.nowMs + propagation,
        });
        this.applyQueues.set(key, queue);
        this.flushApplies(originId, targetId, target);
      },
    });
  }

  private appliedSeq(targetId: string, originId: string): number {
    return this.replicaProgress.get(targetId)?.get(originId) ?? 0;
  }

  private rollbackSent(targetId: string, originId: string, start: number): void {
    const progress = this.sentProgress.get(targetId);
    if (!progress) {
      return;
    }
    const current = progress.get(originId) ?? 0;
    if (current > start) {
      progress.set(originId, start);
    }
  }

  /**
   * Applies arrived batches in origin-sequence order. Network arrival alone
   * never advances the watermark: each batch runs a real durable CPU+IO apply
   * on the recipient store, and only a completed apply publishes the range.
   */
  private flushApplies(originId: string, targetId: string, target: StoreRuntime): void {
    const key = `${originId}>${targetId}`;
    const queue = this.applyQueues.get(key);
    if (!queue || queue.length === 0 || this.applyInFlight.has(key)) {
      return;
    }
    const head = queue[0];
    if (!head) {
      return;
    }
    const applied = this.appliedSeq(targetId, originId);
    if (head.start !== applied) {
      // A gap means an earlier flight is still in transit; its completion will
      // flush this stream. No polling, so a gap cannot spin forever.
      return;
    }
    if (head.at > this.scheduler.nowMs) {
      this.scheduler.schedule(head.at, () => this.flushApplies(originId, targetId, target), 4);
      return;
    }
    if (!this.playerUsable(targetId)) {
      this.applyQueues.delete(key);
      this.rollbackSent(targetId, originId, applied);
      this.scheduleReplication(originId, targetId, REPLICATION_POLL_MS);
      return;
    }
    const targetPlayer = this.players.get(targetId);
    const instance = targetPlayer ? this.aliveInstanceAt(targetPlayer, head.start) : null;
    if (!instance) {
      this.applyQueues.delete(key);
      this.rollbackSent(targetId, originId, applied);
      this.scheduleReplication(originId, targetId, REPLICATION_POLL_MS);
      return;
    }
    const records = head.end - head.start;
    const bytes = records * (IMAGE_LEVEL.dataset.metadataBytes + target.indexBytes);
    const resources: ResourceRequirement[] = [
      { id: instance.cpu, units: 1 },
      { id: instance.io, units: 1 },
    ];
    for (const item of resources) {
      if (this.unavailable.has(item.id)) {
        // Durable apply cannot run while the target storage is out.
        this.applyQueues.delete(key);
        this.rollbackSent(targetId, originId, applied);
        this.scheduleReplication(originId, targetId, REPLICATION_POLL_MS);
        return;
      }
    }
    this.applyInFlight.add(key);
    const duration = stageDurationMs({
      cpuMs: IMAGE_WORK_MODEL.metadata.durableWriteCpuMsPerCopy * records,
      ioBytes: bytes,
      ioOps: IMAGE_WORK_MODEL.metadata.durableWriteIoOpsPerCopy * records,
    });
    this.kernel.submit({
      id: `apply:${key}:${head.start}`,
      resources,
      durationMs: duration,
      onFinish: (result) => {
        this.applyInFlight.delete(key);
        if (result.status === 'completed' && this.playerUsable(targetId)) {
          queue.shift();
          const progress = this.replicaProgress.get(targetId) ?? new Map<string, number>();
          progress.set(originId, head.end);
          this.replicaProgress.set(targetId, progress);
          const acc = this.accumulatorByNode.get(targetId);
          if (acc) {
            acc.replicatedWrites += records;
          }
          this.recordApplyLag(targetId, originId, head.start);
          if (queue.length === 0) {
            this.applyQueues.delete(key);
          }
          this.flushApplies(originId, targetId, target);
          return;
        }
        // Durable apply failed or the target disappeared: nothing published.
        this.applyQueues.delete(key);
        this.rollbackSent(targetId, originId, applied);
        this.scheduleReplication(originId, targetId, REPLICATION_POLL_MS);
      },
    });
  }

  private recordApplyLag(targetId: string, originId: string, start: number): void {
    const acc = this.accumulatorByNode.get(targetId);
    const origin = this.stores.get(originId);
    if (!acc || !origin) {
      return;
    }
    const commit = origin.commitTimes[start];
    if (commit === undefined) {
      return;
    }
    const lag = Math.max(0, this.scheduler.nowMs - commit);
    if (lag > acc.replicationLagMaxMs) {
      acc.replicationLagMaxMs = lag;
    }
  }

  private recordReplicationBacklog(
    targetId: string,
    origin: StoreRuntime,
    applied: number,
  ): void {
    const acc = this.accumulatorByNode.get(targetId);
    if (!acc) {
      return;
    }
    const oldest = origin.commitTimes[applied];
    if (oldest === undefined) {
      return;
    }
    const lag = Math.max(0, this.scheduler.nowMs - oldest);
    if (lag > acc.replicationLagMaxMs) {
      acc.replicationLagMaxMs = lag;
    }
  }

  private publicationWatermark(originId: string): number {
    const origin = this.stores.get(originId);
    if (!origin) {
      return 0;
    }
    const targets = this.replicationByOrigin.get(originId) ?? [];
    if (targets.length === 0) {
      return origin.seq;
    }
    let watermark = origin.seq;
    for (const target of targets) {
      const applied = this.replicaProgress.get(target.targetNodeId)?.get(originId) ?? 0;
      if (applied < watermark) {
        watermark = applied;
      }
    }
    return watermark;
  }

  private privateLink(from: ImageRegion, to: ImageRegion): string | null {
    if (from === to) {
      return null;
    }
    const forward = `link:${from}:${to}`;
    return this.privateLinks.has(forward) ? forward : null;
  }

  private linkRowId(from: ImageRegion, to: ImageRegion): string {
    const found = IMAGE_LEVEL.network.interRegionLinks.find(
      (item) =>
        (item.a === from && item.b === to) || (item.a === to && item.b === from),
    );
    return found ? `region-pair:${found.a}-${found.b}` : `region-pair:${from}-${to}`;
  }

  // -------------------------------------------------------------------------
  // Paths and accounting
  // -------------------------------------------------------------------------

  private readPath(input: {
    clientRegion: ImageRegion;
    appInstance: InstanceRuntime;
    appRegion: ImageRegion;
    cacheInstance: InstanceRuntime | null;
    providerRegion: ImageRegion | null;
    includeProvider: boolean;
    direct: boolean;
  }): PathPlan {
    const resources: ResourceRequirement[] = [];
    const privateLinks: string[] = [];
    const add = (id: string, units = 1): void => {
      if (!resources.some((item) => item.id === id)) {
        resources.push({ id, units });
      }
    };
    add(`client:${input.clientRegion}:tx`);
    const clientId = `client-population:${input.clientRegion}`;
    if (input.direct) {
      // Public access bypasses player app NICs and the private mesh.
      if (input.includeProvider && input.providerRegion) {
        add(`provider:${input.providerRegion}:tx`);
      }
      const oneWay = regionDistanceMs(
        input.clientRegion,
        input.providerRegion ?? input.appRegion,
      );
      return {
        resources,
        privateLinks,
        propagationMs: oneWay,
        requestPropagationMs: oneWay,
        clientId,
        providerId: input.includeProvider && input.providerRegion
          ? `provider-endpoint:${input.providerRegion}`
          : null,
        relayNodeIds: [],
      };
    }
    let propagationMs = regionDistanceMs(input.clientRegion, input.appRegion);
    add(input.appInstance.tx);
    add(input.appInstance.rx);
    const relayNodeIds: string[] = [input.appInstance.nodeId];
    if (input.includeProvider && input.providerRegion) {
      add(`provider:${input.providerRegion}:tx`);
      const cacheRegion = input.cacheInstance
        ? (this.players.get(input.cacheInstance.nodeId)?.region ?? input.appRegion)
        : null;
      if (input.cacheInstance && cacheRegion) {
        add(input.cacheInstance.tx);
        add(input.cacheInstance.rx);
        relayNodeIds.push(input.cacheInstance.nodeId);
        const providerLink = this.privateLink(input.providerRegion, cacheRegion);
        if (providerLink) {
          add(providerLink);
          privateLinks.push(providerLink);
          propagationMs += regionDistanceMs(input.providerRegion, cacheRegion);
        }
        const cacheLink = this.privateLink(cacheRegion, input.appRegion);
        if (cacheLink) {
          add(cacheLink);
          privateLinks.push(cacheLink);
          propagationMs += regionDistanceMs(cacheRegion, input.appRegion);
        }
      } else {
        const providerLink = this.privateLink(input.providerRegion, input.appRegion);
        if (providerLink) {
          add(providerLink);
          privateLinks.push(providerLink);
          propagationMs += regionDistanceMs(input.providerRegion, input.appRegion);
        }
      }
    } else if (input.cacheInstance) {
      add(input.cacheInstance.tx);
      add(input.cacheInstance.rx);
      relayNodeIds.push(input.cacheInstance.nodeId);
      const cacheRegion = this.players.get(input.cacheInstance.nodeId)?.region ?? input.appRegion;
      const cacheLink = this.privateLink(cacheRegion, input.appRegion);
      if (cacheLink) {
        add(cacheLink);
        privateLinks.push(cacheLink);
        propagationMs += regionDistanceMs(cacheRegion, input.appRegion);
      }
    }
    return {
      resources,
      privateLinks,
      propagationMs,
      requestPropagationMs: propagationMs,
      clientId,
      providerId:
        input.includeProvider && input.providerRegion
          ? `provider-endpoint:${input.providerRegion}`
          : null,
      relayNodeIds,
    };
  }

  private uploadPath(
    clientRegion: ImageRegion,
    appInstance: InstanceRuntime,
    appRegion: ImageRegion,
    cacheInstance: InstanceRuntime | null,
    providerRegion: ImageRegion | null,
    direct: boolean,
  ): PathPlan {
    const resources: ResourceRequirement[] = [];
    const privateLinks: string[] = [];
    const add = (id: string, units = 1): void => {
      if (!resources.some((item) => item.id === id)) {
        resources.push({ id, units });
      }
    };
    add(`client:${clientRegion}:rx`);
    const clientId = `client-population:${clientRegion}`;
    if (direct) {
      if (providerRegion) {
        add(`provider:${providerRegion}:rx`);
      }
      const oneWay = regionDistanceMs(clientRegion, providerRegion ?? clientRegion);
      return {
        resources,
        privateLinks,
        propagationMs: oneWay,
        requestPropagationMs: oneWay,
        clientId,
        providerId: providerRegion ? `provider-endpoint:${providerRegion}` : null,
        relayNodeIds: [],
      };
    }
    add(appInstance.rx);
    add(appInstance.tx);
    const relayNodeIds: string[] = [appInstance.nodeId];
    let propagationMs = regionDistanceMs(clientRegion, appRegion);
    if (cacheInstance) {
      const cacheRegion = this.players.get(cacheInstance.nodeId)?.region ?? appRegion;
      add(cacheInstance.rx);
      add(cacheInstance.tx);
      relayNodeIds.push(cacheInstance.nodeId);
      const appLink = this.privateLink(appRegion, cacheRegion);
      if (appLink) {
        add(appLink);
        privateLinks.push(appLink);
        propagationMs += regionDistanceMs(appRegion, cacheRegion);
      }
      const providerLink = this.privateLink(cacheRegion, providerRegion ?? cacheRegion);
      if (providerLink) {
        add(providerLink);
        privateLinks.push(providerLink);
        propagationMs += regionDistanceMs(cacheRegion, providerRegion ?? cacheRegion);
      }
    } else {
      const providerLink = this.privateLink(appRegion, providerRegion ?? appRegion);
      if (providerLink) {
        add(providerLink);
        privateLinks.push(providerLink);
        propagationMs += regionDistanceMs(appRegion, providerRegion ?? appRegion);
      }
    }
    if (providerRegion) {
      add(`provider:${providerRegion}:rx`);
    }
    return {
      resources,
      privateLinks,
      propagationMs,
      requestPropagationMs: propagationMs,
      clientId,
      providerId: providerRegion ? `provider-endpoint:${providerRegion}` : null,
      relayNodeIds,
    };
  }

  /**
   * Charges one completed (or partially completed) transfer. Every physical
   * resource on the path keeps the bytes it really carried, and the client
   * egress and cross-region tariffs follow the same bytes.
   */
  private chargePath(
    req: Request,
    path: PathPlan,
    deliveredBytes: number,
    direction: 'down' | 'up',
  ): void {
    if (deliveredBytes <= 0) {
      return;
    }
    if (path.clientId) {
      const row = this.linkRows.get(path.clientId);
      if (row) {
        if (direction === 'down') {
          row.sentBytes += deliveredBytes;
        } else {
          row.receivedBytes += deliveredBytes;
        }
        row.transfers += 1;
      }
    }
    if (path.providerId) {
      const row = this.linkRows.get(path.providerId);
      if (row) {
        if (direction === 'down') {
          row.sentBytes += deliveredBytes;
        } else {
          row.receivedBytes += deliveredBytes;
        }
        row.transfers += 1;
      }
    }
    for (const nodeId of path.relayNodeIds) {
      const row = this.linkRows.get(`instance-nic:${nodeId}`);
      if (row) {
        // A relay carries the bytes in both directions (RX then TX).
        row.sentBytes += deliveredBytes;
        row.receivedBytes += deliveredBytes;
        row.transfers += 1;
      }
    }
    for (const link of path.privateLinks) {
      const row = this.linkRows.get(this.linkRowIdFor(link));
      if (row) {
        if (direction === 'down') {
          row.sentBytes += deliveredBytes;
        } else {
          row.receivedBytes += deliveredBytes;
        }
        row.transfers += 1;
      }
    }
    if (!req.scored) {
      return;
    }
    if (direction === 'down' && path.clientId !== null) {
      this.totals.clientEgressBytes += deliveredBytes;
    }
    this.totals.crossRegionBytes += deliveredBytes * path.privateLinks.length;
  }

  private linkRowIdFor(kernelLinkId: string): string {
    const parts = kernelLinkId.split(':');
    const a = (parts[1] ?? 'na') as ImageRegion;
    const b = (parts[2] ?? 'eu') as ImageRegion;
    return this.linkRowId(a, b);
  }

  private chargeInner(
    req: Request,
    rowIds: readonly string[],
    deliveredBytes: number,
    direction: 'down' | 'up',
  ): void {
    void direction;
    for (const id of rowIds) {
      const row = this.linkRows.get(id);
      if (!row) {
        continue;
      }
      row.sentBytes += deliveredBytes;
      row.transfers += 1;
    }
    if (req.scored) {
      this.totals.clientEgressBytes += deliveredBytes;
    }
  }

  private appStoreRoundTrip(appRegion: ImageRegion, req: Request): number {
    if (!req.storeId) {
      return 0;
    }
    const store = this.players.get(req.storeId);
    if (!store || store.region === appRegion) {
      return 0;
    }
    return regionDistanceMs(appRegion, store.region) * 2;
  }

  private pickProvider(
    req: Request,
    preference: ImageRegion | null = null,
    requireExplicit = false,
  ): string | null {
    const candidates = this.clientProviders.get(req.clientId);
    if (!candidates) {
      return null;
    }
    if (preference !== null) {
      for (const candidate of candidates) {
        if (candidate.region === preference && this.endpointUsable(candidate.region)) {
          return candidate.id;
        }
      }
      if (requireExplicit) {
        return null;
      }
    }
    for (const candidate of candidates) {
      if (this.endpointUsable(candidate.region)) {
        return candidate.id;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Stage submission and outcomes
  // -------------------------------------------------------------------------

  private submitStage(
    req: Request,
    options: {
      readonly resources: readonly ResourceRequirement[];
      readonly durationMs: number;
      readonly buffer?: { readonly instance: InstanceRuntime; readonly bytes: number } | null;
      readonly nodeId: string | null;
      readonly kind: string;
      readonly bytesRead?: number;
      readonly bytesWritten?: number;
      readonly bytesUp?: number;
      /**
       * Physical accounting charged exactly once per attempt, at the kernel's
       * terminal callback, before any cancelled/finalized guard. Partial work
       * fractions and failed transfers are therefore never free.
       */
      readonly transfer?: {
        readonly path: PathPlan;
        readonly bytes: number;
        readonly direction: 'down' | 'up';
      };
      readonly providerRetrievalBytes?: number;
      readonly innerRows?: { readonly ids: readonly string[]; readonly bytes: number };
      /** Settles owned resources (e.g. a cache fill) exactly once, even on cancellation. */
      readonly onTerminal?: (result: TaskResult | null) => void;
      readonly onDone: (result: TaskResult | null) => void;
    },
  ): void {
    if (req.finalized) {
      return;
    }
    for (const requirement of options.resources) {
      if (this.unavailable.has(requirement.id)) {
        options.onDone(null);
        return;
      }
    }
    const taskId = `req:${req.id}:${options.kind}`;
    let bufferId: string | null = null;
    if (options.buffer) {
      bufferId = `${taskId}:buf`;
      if (!this.reserveRam(options.buffer.instance, bufferId, options.buffer.bytes)) {
        options.onDone(null);
        return;
      }
    }
    const nodeId = options.nodeId;
    const acc = nodeId ? this.accumulatorByNode.get(nodeId) : undefined;
    const measuredFromMs = this.trace.measuredFromMs;
    const measuredEndMs = measuredFromMs + this.trace.measuredMs;
    const enqueuedAtMs = this.scheduler.nowMs;
    // Distinct-attempt queue ownership for this stage. A task that starts
    // synchronously inside submit() must never appear as a transient waiter;
    // only a genuinely queued attempt joins the node's waiting set.
    let waitingOnNode = false;
    let startedSynchronously = false;
    const leaveNodeQueue = (atMs: number): void => {
      if (!waitingOnNode) {
        return;
      }
      waitingOnNode = false;
      acc?.queue.end(atMs);
    };
    const handle = this.kernel.submit({
      id: taskId,
      resources: options.resources,
      durationMs: Math.max(0, options.durationMs),
      onStart: (startedAtMs) => {
        startedSynchronously = true;
        // The kernel only reports a real queued→active transition, so a task
        // cancelled or expired before service never reaches this callback.
        leaveNodeQueue(startedAtMs);
      },
      onFinish: (result) => {
        // A queued cancellation or timeout still leaves the queue here; its
        // waiting integral up to the terminal time is retained by the meter.
        leaveNodeQueue(result.endedAtMs);
        if (bufferId && options.buffer) {
          this.releaseRam(options.buffer.instance, bufferId);
        }
        if (result.startedAtMs !== null) {
          const wait = Math.max(0, result.startedAtMs - result.enqueuedAtMs);
          if (req.queueWaitMs === 0) {
            req.queueWaitMs = wait;
          }
          for (const requirement of options.resources) {
            const row = this.resourceToRow.get(requirement.id);
            if (row) {
              row.waits.record(wait);
            }
          }
        }
        if (acc && result.status !== 'rejected') {
          // Node wait p95 population: attempts enqueued inside the measured
          // window, whether they eventually started or were cancelled/timed
          // out while waiting. Warm-up enqueues and never-enqueued rejections
          // are outside the population. The value is the full wait until
          // service start or terminal time.
          if (result.enqueuedAtMs >= measuredFromMs && result.enqueuedAtMs < measuredEndMs) {
            const wait = Math.max(
              0,
              (result.startedAtMs ?? result.endedAtMs) - result.enqueuedAtMs,
            );
            acc.waits.record(wait);
          }
        }
        if (options.transfer) {
          const delivered = options.transfer.bytes * result.workFraction;
          if (delivered > 0) {
            this.chargePath(req, options.transfer.path, delivered, options.transfer.direction);
          }
        }
        if (options.providerRetrievalBytes && req.scored) {
          this.totals.providerRetrievalBytes +=
            options.providerRetrievalBytes * result.workFraction;
        }
        if (options.innerRows && result.workFraction > 0) {
          this.chargeInner(
            req,
            options.innerRows.ids,
            options.innerRows.bytes * result.workFraction,
            'down',
          );
        }
        if (result.status === 'completed') {
          if (options.bytesRead) {
            this.addNodeBytes(nodeId, options.bytesRead, 0);
          }
          if (options.bytesUp || options.bytesWritten) {
            this.addNodeBytes(nodeId, 0, (options.bytesUp ?? 0) + (options.bytesWritten ?? 0));
          }
        }
        if (options.onTerminal) {
          options.onTerminal(result);
        }
        if (req.finalized) {
          return;
        }
        options.onDone(result);
      },
    });
    if (acc && !startedSynchronously && handle.result === undefined) {
      // The task was accepted but did not start inside submit(); it is now
      // genuinely waiting in this node's queue. Rejected submissions never
      // join the waiting set.
      waitingOnNode = true;
      acc.queue.begin(enqueuedAtMs);
    }
    req.handles.push(handle);
  }

  /**
   * One network transfer: serialization holds every physical resource on the
   * path, while geographic propagation is a separate delay that holds no
   * bandwidth. A fault during propagation still loses the response, and bytes
   * already serialized stay charged.
   */
  private submitSerialized(
    req: Request,
    options: {
      readonly resources: readonly ResourceRequirement[];
      readonly serializationMs: number;
      readonly propagationMs: number;
      readonly buffer?: { readonly instance: InstanceRuntime; readonly bytes: number } | null;
      readonly nodeId: string | null;
      readonly kind: string;
      readonly bytesUp?: number;
      readonly transfer?: {
        readonly path: PathPlan;
        readonly bytes: number;
        readonly direction: 'down' | 'up';
      };
      readonly providerRetrievalBytes?: number;
      readonly innerRows?: { readonly ids: readonly string[]; readonly bytes: number };
      readonly onTerminal?: (result: TaskResult | null) => void;
      readonly onDone: (
        result: TaskResult | null,
        outcome: 'ok' | 'propagation-lost' | 'failed',
      ) => void;
    },
  ): void {
    this.submitStage(req, {
      resources: options.resources,
      durationMs: options.serializationMs,
      buffer: options.buffer,
      nodeId: options.nodeId,
      kind: options.kind,
      bytesUp: options.bytesUp,
      transfer: options.transfer,
      providerRetrievalBytes: options.providerRetrievalBytes,
      innerRows: options.innerRows,
      onTerminal: options.onTerminal,
      onDone: (result) => {
        if (!result || result.status !== 'completed') {
          options.onDone(result, 'failed');
          return;
        }
        if (options.propagationMs <= 0.001) {
          options.onDone(result, 'ok');
          return;
        }
        this.delayUntil(req, this.scheduler.nowMs + options.propagationMs, () => {
          let lost = false;
          for (const item of options.resources) {
            if (this.unavailable.has(item.id)) {
              lost = true;
              break;
            }
          }
          options.onDone(result, lost ? 'propagation-lost' : 'ok');
        });
      },
    });
  }

  private addNodeBytes(
    nodeId: string | null,
    readBytes: number,
    writtenBytes: number,
  ): void {
    if (!nodeId) {
      return;
    }
    const acc = this.accumulatorByNode.get(nodeId);
    if (!acc) {
      return;
    }
    acc.bytesRead += readBytes;
    acc.bytesWritten += writtenBytes;
  }

  private reserveRam(instance: InstanceRuntime, id: string, bytes: number): boolean {
    this.accrueRam(instance.ram);
    return instance.ram.ledger.reserve(id, bytes);
  }

  private releaseRam(instance: InstanceRuntime, id: string): void {
    this.accrueRam(instance.ram);
    instance.ram.ledger.release(id);
  }

  private accrueRam(ram: RamArea): void {
    const now = this.scheduler.nowMs;
    const from = Math.max(ram.lastMs, this.trace.measuredFromMs);
    const to = Math.min(now, this.trace.measuredFromMs + this.trace.measuredMs);
    if (to > from) {
      ram.areaBytesMs += ram.ledger.usedBytes * (to - from);
    }
    ram.lastMs = now;
  }

  private delayUntil(req: Request, atMs: number, callback: () => void): void {
    if (atMs <= this.scheduler.nowMs + 0.001) {
      callback();
      return;
    }
    this.scheduler.schedule(
      atMs,
      () => {
        if (req.finalized) {
          return;
        }
        callback();
      },
      2,
    );
  }

  private retryOrFail(req: Request, code: FailureCode): void {
    if (req.finalized) {
      return;
    }
    const appId = req.appId;
    const app = appId ? this.players.get(appId) : undefined;
    const allowed = app ? app.retries : 0;
    if (req.attempts <= allowed) {
      if (req.scored) {
        this.totals.retries += 1;
      }
      this.settleOwnedFills(req);
      const backoff = app ? app.retryBackoffMs : 0;
      this.cancelHandles(req);
      this.delayUntil(req, this.scheduler.nowMs + backoff, () => this.startRequest(req));
      return;
    }
    this.failRequest(req, code);
  }

  /** Drops this request's coalesced waiters so cancelled requests retain nothing. */
  private removeFillWaiters(req: Request): void {
    if (req.fillWaitKeys.length === 0) {
      return;
    }
    for (const fillKey of req.fillWaitKeys) {
      const entry = this.cacheFillInFlight.get(fillKey);
      if (!entry) {
        continue;
      }
      entry.waiters = entry.waiters.filter((waiter) => waiter.req !== req);
    }
    req.fillWaitKeys.length = 0;
  }

  private cancelHandles(req: Request): void {
    for (const handle of req.handles) {
      if (!handle.finished) {
        handle.cancel();
      }
    }
    req.handles.length = 0;
  }

  /**
   * Maps a kernel terminal result to the final business failure code.
   *
   * Only a real kernel `rejected` submission with reason `queue-full` keeps a
   * distinct code. Timeouts stay `deadline_exceeded`; interrupted stages and
   * other capacity/resource rejections keep the pre-existing
   * `task_interrupted` classification so a bounded-queue overflow is never
   * confused with a generic interruption or a request deadline.
   */
  private stageFailureCode(result: TaskResult | null | undefined): FailureCode {
    if (!result) {
      return 'task_interrupted';
    }
    if (result.status === 'timeout') {
      return 'deadline_exceeded';
    }
    if (result.status === 'rejected' && result.reason === 'queue-full') {
      return 'queue_full';
    }
    return 'task_interrupted';
  }

  private failRequest(req: Request, code: FailureCode): void {
    if (req.finalized) {
      return;
    }
    req.finalized = true;
    this.finalizeCommon(req);
    if (!req.scored) {
      this.cancelHandles(req);
      return;
    }
    const latency = Math.max(0, this.scheduler.nowMs - req.arrivalMs);
    const acc = this.ops[req.op];
    if (req.probeState === 'active') {
      req.probeState = 'failed';
    }
    this.cancelHandles(req);
    acc.completed += 1;
    switch (code) {
      case 'deadline_exceeded':
        acc.timedOut += 1;
        break;
      case 'metadata_index_missing':
        acc.missingData += 1;
        break;
      case 'metadata_origin_unavailable':
        acc.stale += 1;
        break;
      case 'metadata_quorum_unavailable':
      case 'no_healthy_route':
      case 'endpoint_unavailable':
      case 'memory_rejected':
      case 'task_interrupted':
      case 'queue_full':
        acc.rejected += 1;
        break;
      default:
        break;
    }
    acc.errors.set(code, (acc.errors.get(code) ?? 0) + 1);
    this.recordFailure(req, latency, code);
  }

  private completeSuccess(req: Request, bytesDown: number, bytesUp: number): void {
    if (req.finalized) {
      return;
    }
    if (!req.scored) {
      req.finalized = true;
      this.finalizeCommon(req);
      this.cancelHandles(req);
      return;
    }
    if (this.scheduler.nowMs > req.deadlineAtMs + 1e-9) {
      this.failRequest(req, 'deadline_exceeded');
      return;
    }
    const latency = Math.max(0, this.scheduler.nowMs - req.arrivalMs);
    req.finalized = true;
    this.finalizeCommon(req);
    const acc = this.ops[req.op];
    acc.completed += 1;
    acc.success += 1;
    acc.onTime += 1;
    acc.correct += 1;
    acc.latencies.push(latency);
    acc.queueWaits.push(req.queueWaitMs);
    acc.bytesRead += bytesDown;
    acc.bytesWritten += bytesUp;
    const window =
      req.window === 'incident'
        ? this.windows.incident[req.op]
        : req.window === 'recovery'
          ? this.windows.recovery[req.op]
          : null;
    if (window) {
      window.success += 1;
      window.latencies.push(latency);
    }
    const appAcc = req.appId ? this.accumulatorByNode.get(req.appId) : undefined;
    if (appAcc) {
      appAcc.completed += 1;
    }
    const storeAcc = req.storeId ? this.accumulatorByNode.get(req.storeId) : undefined;
    if (storeAcc) {
      storeAcc.completed += 1;
    }
    const clientAcc = this.accumulatorByNode.get(req.clientId);
    if (clientAcc) {
      clientAcc.completed += 1;
    }
    this.trackAccess(req, latency);
    this.cancelHandles(req);
  }

  private recordFailure(req: Request, latency: number, code: FailureCode): void {
    // Every touched node records the same final outcome exactly once. The
    // breakdown is an observed terminal outcome, not a claim that the node
    // caused the failure: `rejected` means a non-timeout failure and
    // `timedOut` means a deadline failure. Warm-up/non-scored requests never
    // reach this method, and retries that later succeed do not create an error.
    const noteOutcome = (acc: NodeAccumulator | undefined): void => {
      if (!acc) {
        return;
      }
      acc.errors += 1;
      if (code === 'deadline_exceeded') {
        acc.timedOut += 1;
      } else {
        acc.rejected += 1;
      }
    };
    noteOutcome(req.appId ? this.accumulatorByNode.get(req.appId) : undefined);
    noteOutcome(req.storeId ? this.accumulatorByNode.get(req.storeId) : undefined);
    noteOutcome(this.accumulatorByNode.get(req.clientId));
    this.trackAccess(req, latency);
  }

  private trackAccess(req: Request, latencyMs: number): void {
    const access = this.linkRows.get(`request-access:${req.clientRegion}`);
    if (!access) {
      return;
    }
    access.transfers += 1;
    access.accessBusyMs +=
      req.op === 'upload'
        ? serializationMs(IMAGE_LEVEL.dataset.originalBytes)
        : req.op === 'search'
          ? serializationMs(
              IMAGE_LEVEL.dataset.searchResultsPerSearch *
                (IMAGE_LEVEL.dataset.thumbnailBytes + IMAGE_LEVEL.dataset.metadataBytes),
            )
          : serializationMs(IMAGE_LEVEL.dataset.originalBytes);
    access.accessLatencyMs += Math.max(1e-9, latencyMs);
  }

  private acquireProviderSlot(
    region: ImageRegion,
    kind: 'read' | 'write',
    scored: boolean,
  ): number {
    const key = `${region}:${kind}`;
    const rate =
      kind === 'read'
        ? IMAGE_WORK_MODEL.provider.readRpcPerSec
        : IMAGE_WORK_MODEL.provider.writeRpcPerSec;
    const interval = 1_000 / rate;
    const next = this.providerQuota.get(key) ?? this.scheduler.nowMs;
    const at = Math.max(this.scheduler.nowMs, next);
    this.providerQuota.set(key, at + interval);
    if (scored) {
      if (kind === 'read') {
        this.totals.readRequests += 1;
      } else {
        this.totals.writeRequests += 1;
      }
    }
    return at;
  }

  private acquireProviderSlots(
    region: ImageRegion,
    kind: 'read' | 'write',
    count: number,
    scored: boolean,
  ): number {
    let latest = 0;
    for (let index = 0; index < count; index += 1) {
      latest = Math.max(latest, this.acquireProviderSlot(region, kind, scored));
    }
    return latest;
  }

  // -------------------------------------------------------------------------
  // Optional observational traffic telemetry
  // -------------------------------------------------------------------------

  private noteTrafficEdge(
    source: string,
    target: string,
    operation: 'traffic' | 'metadata' | 'blob' | 'replicate',
  ): void {
    if (!this.traffic) {
      return;
    }
    const edgeId = this.trafficEdges.get(`${source}|${target}|${operation}`);
    if (edgeId) {
      this.traffic.countEdge(edgeId);
    }
  }

  private noteTrafficNode(nodeId: string): void {
    this.traffic?.countNode(nodeId);
  }

  private trafficResourceUsage(
    nodeId: string,
    key: string,
    ids: readonly string[],
    rows: ReadonlyMap<string, ResourceStats>,
    windowMs: number,
    inWindow: boolean,
  ): { used: number; capacity: number; aggregation: TrafficResource['aggregation'] } {
    let busyUnitMs = 0;
    let instant = 0;
    let capacity = 0;
    for (const id of ids) {
      const row = rows.get(id);
      if (!row) {
        continue;
      }
      busyUnitMs += row.busyUnitMs;
      instant += row.busyUnits;
      capacity += row.nominalCapacity;
    }
    if (!inWindow) {
      return { used: instant, capacity, aggregation: 'instant' };
    }
    const previousKey = `${nodeId}:${key}`;
    const previous = this.trafficPreviousBusy.get(previousKey) ?? 0;
    this.trafficPreviousBusy.set(previousKey, busyUnitMs);
    return {
      used: windowMs > 0 ? Math.max(0, (busyUnitMs - previous) / windowMs) : 0,
      capacity,
      aggregation: 'window-average',
    };
  }

  private trafficQueue(
    ids: readonly string[],
    rows: ReadonlyMap<string, ResourceStats>,
  ): number | null {
    let deepest = -1;
    for (const id of ids) {
      const row = rows.get(id);
      if (row && row.queuedTasks > deepest) {
        deepest = row.queuedTasks;
      }
    }
    return deepest < 0 ? null : deepest;
  }

  /**
   * One bounded observation of what already happened. Kernel statistics are
   * read-only; RAM, queue depth and out-of-window samples are explicitly
   * classified as instant so no interval average is invented.
   */
  private sampleTraffic(atMs: number): void {
    if (!this.traffic) {
      return;
    }
    const stats = this.kernel.stats();
    const rows = new Map<string, ResourceStats>();
    for (const row of stats.resources) {
      rows.set(row.id, row);
    }
    const measuredFrom = this.trace.measuredFromMs;
    const measuredTo = measuredFrom + this.trace.measuredMs;
    const inWindow = atMs > measuredFrom && atMs <= measuredTo;
    const frame = this.traffic.sample(atMs, (context) => {
      const frameNodes: TrafficNode[] = this.graph.nodes.map((node) => {
        const resources: TrafficResource[] = [];
        let queue: number | null = null;
        let down = false;
        if (node.kind === 'client') {
          const links = this.clientLinks.get(node.region);
          const ids = links ? [links.rx, links.tx] : [];
          if (links) {
            const rx = this.trafficResourceUsage(
              node.id,
              'rx',
              [links.rx],
              rows,
              context.windowMs,
              inWindow,
            );
            const tx = this.trafficResourceUsage(
              node.id,
              'tx',
              [links.tx],
              rows,
              context.windowMs,
              inWindow,
            );
            resources.push(
              {
                key: 'network-rx',
                label: 'Client ingress flows',
                used: rx.used,
                capacity: rx.capacity,
                unit: 'lanes',
                aggregation: rx.aggregation,
              },
              {
                key: 'network-tx',
                label: 'Client egress flows',
                used: tx.used,
                capacity: tx.capacity,
                unit: 'lanes',
                aggregation: tx.aggregation,
              },
            );
          }
          queue = this.trafficQueue(ids, rows);
        } else if (node.kind === 'blob') {
          const endpoint = this.endpoints.get(node.region);
          const ids = endpoint ? [endpoint.rx, endpoint.tx] : [];
          if (endpoint) {
            const rx = this.trafficResourceUsage(
              node.id,
              'rx',
              [endpoint.rx],
              rows,
              context.windowMs,
              inWindow,
            );
            const tx = this.trafficResourceUsage(
              node.id,
              'tx',
              [endpoint.tx],
              rows,
              context.windowMs,
              inWindow,
            );
            resources.push(
              {
                key: 'network-rx',
                label: 'Provider ingress flows',
                used: rx.used,
                capacity: rx.capacity,
                unit: 'lanes',
                aggregation: rx.aggregation,
              },
              {
                key: 'network-tx',
                label: 'Provider egress flows',
                used: tx.used,
                capacity: tx.capacity,
                unit: 'lanes',
                aggregation: tx.aggregation,
              },
            );
          }
          queue = this.trafficQueue(ids, rows);
          down = !this.endpointUsable(node.region);
        } else {
          const player = this.players.get(node.id);
          if (player) {
            const channels: ReadonlyArray<{
              key: string;
              label: string;
              unit: TrafficResource['unit'];
              ids: string[];
            }> = [
              {
                key: 'cpu',
                label: 'CPU cores',
                unit: 'cores',
                ids: player.instances.map((instance) => instance.cpu),
              },
              {
                key: 'io',
                label: 'IO lanes',
                unit: 'lanes',
                ids: player.instances.map((instance) => instance.io),
              },
              {
                key: 'network-rx',
                label: 'NIC ingress flows',
                unit: 'lanes',
                ids: player.instances.map((instance) => instance.rx),
              },
              {
                key: 'network-tx',
                label: 'NIC egress flows',
                unit: 'lanes',
                ids: player.instances.map((instance) => instance.tx),
              },
            ];
            const allIds: string[] = [];
            for (const channel of channels) {
              allIds.push(...channel.ids);
              const usage = this.trafficResourceUsage(
                node.id,
                channel.key,
                channel.ids,
                rows,
                context.windowMs,
                inWindow,
              );
              resources.push({
                key: channel.key,
                label: channel.label,
                used: usage.used,
                capacity: usage.capacity,
                unit: channel.unit,
                aggregation: usage.aggregation,
              });
            }
            let usedBytes = 0;
            for (const instance of player.instances) {
              usedBytes += instance.ram.ledger.usedBytes;
            }
            resources.push({
              key: 'ram',
              label: 'RAM',
              used: usedBytes,
              capacity:
                player.instances.length *
                IMAGE_CATALOG.instance.usableMemoryGb *
                IMAGE_BYTES_PER_GB,
              unit: 'bytes',
              aggregation: 'instant',
            });
            queue = this.trafficQueue(allIds, rows);
            down = !this.playerUsable(node.id);
          }
        }
        return {
          nodeId: node.id,
          resources,
          requestsPerSecond: context.nodeRps(node.id),
          queue,
          down,
        };
      });
      const frameEdges: TrafficEdge[] = this.graph.edges.map((edge) => ({
        edgeId: edge.id,
        requestsPerSecond: context.edgeRps(edge.id),
        bytesPerSecond: null,
      }));
      return { nodes: frameNodes, edges: frameEdges };
    });
    if (frame) {
      notifyTraffic(this.onTraffic, frame);
    }
  }

  // -------------------------------------------------------------------------
  // Run
  // -------------------------------------------------------------------------

  run(): ImageScenarioSimulation {
    const trace = this.trace;
    const clientRtt = IMAGE_LEVEL.network.clientRttMs;
    this.scheduleFault();
    this.scheduleReplicationAll();
    this.scheduleArrivals('upload', trace.uploads.times, clientRtt);
    this.scheduleArrivals('search', trace.searches.times, clientRtt);
    this.scheduleArrivals('detail', trace.details.times, clientRtt);
    const budget = IMAGE_LEVEL.qualification.maxEventsPerScenario;
    const drainEnd = trace.measuredFromMs + trace.measuredMs + trace.drainMs;
    let processed = 0;
    let exhausted = false;
    if (!this.traffic) {
      const first = this.scheduler.runUntil(drainEnd, budget);
      processed = first.totalProcessedEvents;
      exhausted = first.exhausted;
    } else {
      const step = this.trafficStepMs;
      const measuredEnd = trace.measuredFromMs + trace.measuredMs;
      const measuredFrom = trace.measuredFromMs;
      // Explicit phase-boundary samples: a frame must never straddle
      // warm-up/measured or measured/drain, even when a custom trace is not
      // aligned to the sampling grid.
      const drainBoundaries: number[] = [];
      for (let boundary = step; boundary < drainEnd; boundary += step) {
        drainBoundaries.push(boundary);
      }
      for (const boundary of [measuredFrom, measuredEnd]) {
        if (boundary > 0 && boundary < drainEnd) {
          drainBoundaries.push(boundary);
        }
      }
      drainBoundaries.push(drainEnd);
      drainBoundaries.sort((left, right) => left - right);
      const advanceTo = (untilMs: number): void => {
        const result = this.scheduler.runUntil(
          untilMs,
          Math.max(0, budget - processed),
        );
        processed = result.totalProcessedEvents;
        exhausted = result.exhausted;
        if (!exhausted) {
          this.sampleTraffic(untilMs);
        }
      };
      let previousBoundary = -1;
      for (const boundary of drainBoundaries) {
        if (exhausted) {
          break;
        }
        if (boundary === previousBoundary) {
          continue;
        }
        previousBoundary = boundary;
        advanceTo(boundary);
      }
      if (!exhausted) {
        const postludeEnd = Math.max(
          drainEnd,
          (this.lastAckAtMs ?? drainEnd) +
            IMAGE_LEVEL.qualification.postlude.maxAfterLastAckMs,
        );
        let boundary = Math.ceil(drainEnd / step) * step;
        if (boundary <= drainEnd) {
          boundary += step;
        }
        let lastSampled = drainEnd;
        while (!exhausted && boundary < postludeEnd) {
          if (boundary > lastSampled) {
            lastSampled = boundary;
            advanceTo(boundary);
          }
          boundary += step;
        }
        if (!exhausted && postludeEnd > lastSampled) {
          advanceTo(postludeEnd);
        }
      }
    }
    if (!exhausted && !this.traffic) {
      const postludeEnd = Math.max(
        drainEnd,
        (this.lastAckAtMs ?? drainEnd) + IMAGE_LEVEL.qualification.postlude.maxAfterLastAckMs,
      );
      const second = this.scheduler.runUntil(
        postludeEnd,
        Math.max(0, budget - processed),
      );
      processed = second.totalProcessedEvents;
      exhausted = second.exhausted;
    }
    const statsSnapshot = this.kernel.stats();
    for (const row of statsSnapshot.resources) {
      this.resourceStats.set(row.id, row);
    }
    this.liveBeforeFinish = this.liveRequests.size;
    this.finishSimulation();
    return this.buildSimulationResult(processed, budget, exhausted);
  }

  private timeoutRequest(req: Request): void {
    if (req.finalized) {
      return;
    }
    req.finalized = true;
    this.finalizeCommon(req);
    if (req.probeState === 'active') {
      req.probeState = 'failed';
    }
    this.cancelHandles(req);
    if (!req.scored) {
      // Warm-up deadlines release resources but never enter the measured
      // denominator, so they must not change offered/completed/timeout counts.
      return;
    }
    const acc = this.ops[req.op];
    acc.completed += 1;
    acc.timedOut += 1;
    acc.errors.set('deadline_exceeded', (acc.errors.get('deadline_exceeded') ?? 0) + 1);
    this.recordFailure(req, Math.max(0, req.deadlineAtMs - req.arrivalMs), 'deadline_exceeded');
  }

  private scheduleArrivals(op: Op, times: Float64Array, clientRtt: number): void {
    const scheduleNext = (index: number): void => {
      if (index >= times.length) {
        return;
      }
      const traceTime = times[index] ?? 0;
      this.scheduler.schedule(
        traceTime + clientRtt,
        () => {
          this.offerRequest(op, index, traceTime);
          scheduleNext(index + 1);
        },
        0,
      );
    };
    scheduleNext(0);
  }

  private scheduleReplicationAll(): void {
    for (const targets of this.replicationByOrigin.values()) {
      for (const replication of targets) {
        this.scheduleReplication(replication.sourceNodeId, replication.targetNodeId, 0);
      }
    }
  }

  private finishSimulation(): void {
    // With exact deadlines every offered request must already be terminal.
    // Any leftover is reported as unfinished rather than silently dropped.
    for (const req of [...this.liveRequests]) {
      req.finalized = true;
      this.finalizeCommon(req);
      this.cancelHandles(req);
      if (!req.scored) {
        continue;
      }
      const acc = this.ops[req.op];
      acc.completed += 1;
      acc.unfinished += 1;
      acc.errors.set('unfinished', (acc.errors.get('unfinished') ?? 0) + 1);
    }
    for (const player of this.players.values()) {
      for (const instance of player.instances) {
        this.accrueRamAt(instance.ram, this.trace.measuredFromMs + this.trace.measuredMs);
      }
    }
    const measuredEndMs = this.trace.measuredFromMs + this.trace.measuredMs;
    for (const acc of this.accumulatorByNode.values()) {
      // Final clipped accrual: a task waiting across the measured-window end
      // (or a residual waiter cleaned up here) keeps its true waiting time.
      acc.queue.finish(measuredEndMs);
    }
  }

  private accrueRamAt(ram: RamArea, atMs: number): void {
    const from = Math.max(ram.lastMs, this.trace.measuredFromMs);
    const to = Math.min(atMs, this.trace.measuredFromMs + this.trace.measuredMs);
    if (to > from) {
      ram.areaBytesMs += ram.ledger.usedBytes * (to - from);
    }
    ram.lastMs = atMs;
  }

  // -------------------------------------------------------------------------
  // Result assembly
  // -------------------------------------------------------------------------

  private buildSimulationResult(
    processedEvents: number,
    eventBudget: number,
    exhausted: boolean,
  ): ImageScenarioSimulation {
    const trace = this.trace;
    const scenarioSpec = IMAGE_LEVEL.qualification.scenarios.find(
      (item) => item.name === this.scenario,
    );
    const incident = isIncidentScenario(this.scenario);
    const slo = incident ? IMAGE_LEVEL.slo.incident : IMAGE_LEVEL.slo.normal;
    const operations = this.buildOperations();
    const drainEnd = trace.measuredFromMs + trace.measuredMs + trace.drainMs;
    const postludeEnd = Math.max(
      drainEnd,
      (this.lastAckAtMs ?? drainEnd) + IMAGE_LEVEL.qualification.postlude.maxAfterLastAckMs,
    );
    let unpublished = 0;
    let backlogLag = 0;
    let observedApplyLag = 0;
    for (const acc of this.accumulatorByNode.values()) {
      observedApplyLag = Math.max(observedApplyLag, acc.replicationLagMaxMs);
    }
    for (const [originId, origin] of this.stores) {
      const watermark = this.publicationWatermark(originId);
      unpublished += Math.max(0, origin.seq - watermark);
      const oldest = origin.commitTimes[watermark];
      const replicationLag = oldest === undefined ? 0 : Math.max(0, postludeEnd - oldest);
      backlogLag = Math.max(backlogLag, replicationLag);
    }
    const maxPublicationLag = publicationLagBound(
      observedApplyLag,
      backlogLag,
      IMAGE_CATALOG.provider.remoteReadVisibilityMs,
    );
    const postludePassed =
      unpublished === 0 &&
      maxPublicationLag <= IMAGE_LEVEL.qualification.postlude.maxAfterLastAckMs;
    const unpublishedCommitted = unpublished;
    const postlude = {
      noNewOffers: true as const,
      startedAtMs: drainEnd,
      lastAckAtMs: this.lastAckAtMs,
      endedAtMs: postludeEnd,
      maxAfterLastAckMs: IMAGE_LEVEL.qualification.postlude.maxAfterLastAckMs,
      committedUploads: this.totals.committedUploads,
      acknowledgedUploads: this.totals.acknowledgedUploads,
      lostAckCommitted: this.totals.lostAckCommitted,
      publishedUploads: Math.max(0, this.totals.committedUploads - unpublishedCommitted),
      unpublishedCommitted,
      maxPublicationLagMs: maxPublicationLag,
      publicationDeadlineMs: postludeEnd,
      backgroundWorkCounted: true as const,
      includedInMeasuredLoad: false as const,
      passed: postludePassed,
    };
    const freshness = this.buildFreshness();
    const integrityPassed =
      this.totals.duplicateEffects === 0 &&
      this.totals.missingSearchResults === 0 &&
      this.totals.visibilityViolations === 0 &&
      postludePassed;
    const dataIntegrity = {
      acknowledgedUploads: this.totals.acknowledgedUploads,
      committedUploads: this.totals.committedUploads,
      lostAckCommitted: this.totals.lostAckCommitted,
      duplicateUploads: 0,
      duplicateEffects: this.totals.duplicateEffects,
      missingSearchResults: this.totals.missingSearchResults,
      visibilityViolations: this.totals.visibilityViolations,
      unpublishedCommitted,
      publicationPassed: postludePassed,
      passed: integrityPassed,
    };
    const incidentWindow = incident ? this.buildWindow('incident', slo) : null;
    const recoveryWindow = incident ? this.buildWindow('recovery', slo) : null;
    const checks = this.buildChecks(
      operations,
      freshness,
      dataIntegrity,
      postlude,
      incidentWindow,
      recoveryWindow,
      slo,
    );
    const workload = {
      warmupMs: trace.warmupMs,
      measuredMs: trace.measuredMs,
      drainMs: trace.drainMs,
      demandMultiplier: trace.demandMultiplier,
      offered: {
        upload: trace.counts.measuredUpload,
        search: trace.counts.measuredSearch,
        detail: trace.counts.measuredDetail,
      },
      sampleFactor: IMAGE_LEVEL.workload.sampleFactor,
      eventBudget,
      processedEvents,
      exhausted,
      hotKeyShare: IMAGE_LEVEL.workload.hotKeyShare,
      hotKeys: IMAGE_LEVEL.workload.hotKeys,
      longTailKeys: IMAGE_LEVEL.workload.longTailRepresentativeKeys,
      recentReadProbeShare: IMAGE_LEVEL.workload.recentReadProbeShare,
      cacheInitialState: 'empty' as const,
      matureDatasetDay: IMAGE_LEVEL.dataset.retentionDays as 30,
    };
    const result: ImageScenarioResult = {
      name: this.scenario,
      label: scenarioSpec?.label ?? this.scenario,
      passed: checks.every((check) => check.severity !== 'required' || check.passed),
      fault: this.faultResult(),
      workload,
      operations,
      freshness,
      dataIntegrity,
      postlude,
      incidentWindow,
      recoveryWindow,
      nodes: this.buildNodeMetrics(),
      links: this.buildLinkMetrics(),
      checks,
      diagnostics: this.diagnostics.filter(
        (item) => item.scenario === undefined || item.scenario === this.scenario,
      ),
    };
    const traffic: ImageMeasuredTraffic = {
      clientEgressBytes: this.totals.clientEgressBytes,
      providerRetrievalBytes: this.totals.providerRetrievalBytes,
      crossRegionBytes: this.totals.crossRegionBytes,
      readRequests: this.totals.readRequests,
      writeRequests: this.totals.writeRequests,
      retries: this.totals.retries,
      cacheHits: this.totals.cacheHits,
      cacheMisses: this.totals.cacheMisses,
      coalesced: this.totals.coalesced,
      cacheHitRatio:
        this.totals.cacheHits + this.totals.cacheMisses === 0
          ? 0
          : this.totals.cacheHits / (this.totals.cacheHits + this.totals.cacheMisses),
      retryRatio:
        this.ops.upload.offered + this.ops.search.offered + this.ops.detail.offered === 0
          ? 0
          : this.totals.retries /
            (this.ops.upload.offered + this.ops.search.offered + this.ops.detail.offered),
    };
    const resources: ImageResourceSnapshot[] = [...this.resourceStats.values()].map((row) => ({
      id: row.id,
      kind: row.kind,
      capacity: row.nominalCapacity,
      averageBusyUnits: row.averageBusyUnits,
      peakBusyUnits: row.peakBusyUnits,
      queuedTasks: row.queuedTasks,
    }));
    return {
      result,
      traffic,
      processedEvents,
      eventBudget,
      exhausted,
      resources,
      liveRequestsAtEnd: this.liveRequests.size,
      liveRequestsBeforeFinish: this.liveBeforeFinish,
      pendingFillsAtEnd: this.cacheFillInFlight.size,
    };
  }

  private faultResult(): ImageScenarioResult['fault'] {
    const spec = IMAGE_LEVEL.qualification.scenarios.find(
      (item) => item.name === this.scenario,
    );
    const fault = spec?.fault;
    if (!fault || fault.kind === 'none') {
      return {
        kind: 'none',
        atMeasuredMs: null,
        durationMs: null,
        target: null,
        region: null,
        linkA: null,
        linkB: null,
      };
    }
    return {
      kind: fault.kind,
      atMeasuredMs: fault.atMeasuredMs,
      durationMs: fault.durationMs,
      target:
        fault.kind === 'node'
          ? 'one-instance-per-pool'
          : fault.kind === 'link'
            ? `${fault.a}-${fault.b}`
            : fault.region,
      region: fault.kind === 'region' ? fault.region : null,
      linkA: fault.kind === 'link' ? fault.a : null,
      linkB: fault.kind === 'link' ? fault.b : null,
    };
  }

  private buildOperations(): ImageScenarioResult['operations'] {
    const build = (op: Op): ImageOperationMetrics => {
      const acc = this.ops[op];
      const counts: ImageOperationCounts = {
        offered: acc.offered,
        completed: acc.completed,
        onTime: acc.onTime,
        correct: acc.correct,
        success: acc.success,
        failed: acc.offered - acc.success,
        rejected: acc.rejected,
        timedOut: acc.timedOut,
        incorrect: acc.incorrect,
        stale: acc.stale,
        missingData: acc.missingData,
        duplicateEffects: 0,
        unfinished: acc.unfinished,
      };
      const sorted = ascending(acc.latencies);
      const waits = ascending(acc.queueWaits);
      const seconds = this.trace.measuredMs / 1000;
      return {
        operation: op,
        counts,
        availability: acc.offered === 0 ? 0 : acc.success / acc.offered,
        timelyRatio: acc.offered === 0 ? 0 : acc.onTime / acc.offered,
        correctnessRatio: acc.offered === 0 ? 0 : acc.correct / acc.offered,
        latencyP50Ms: nearestRank(sorted, 0.5),
        latencyP95Ms: nearestRank(sorted, 0.95),
        latencyP99Ms: nearestRank(sorted, 0.99),
        latencyP999Ms: nearestRank(sorted, 0.999),
        sampleCount: acc.success,
        p999SampleCount: acc.success,
        minimumP999Samples: IMAGE_LEVEL.qualification.minimumP999Samples,
        p999Reliable: acc.success >= IMAGE_LEVEL.qualification.minimumP999Samples,
        queueWaitP95Ms: nearestRank(waits, 0.95),
        bytesRead: acc.bytesRead,
        bytesWritten: acc.bytesWritten,
        requestsPerSecondAvg: seconds > 0 ? acc.offered / seconds : 0,
        errorsByCode: Object.fromEntries(
          [...acc.errors.entries()].sort(([left], [right]) => left.localeCompare(right)),
        ),
      };
    };
    return { upload: build('upload'), search: build('search'), detail: build('detail') };
  }

  private buildFreshness(): ImageScenarioResult['freshness'] {
    const lags = ascending(this.freshnessLags);
    const probes = this.totals.freshnessProbes;
    const limit = IMAGE_LEVEL.slo.freshnessMs;
    const maxLag = lags.length === 0 ? null : (lags[lags.length - 1] ?? 0);
    // Freshness is a consistency assertion, not a second availability gate: a
    // recent read that fails during an outage is counted in the business
    // availability denominator. The freshness gate requires at least one
    // observed assertion, no successful stale/missing/wrong response, and a
    // visibility lag within the bound.
    const passed =
      probes > 0 &&
      this.totals.freshnessViolations === 0 &&
      maxLag !== null &&
      maxLag <= limit;
    return {
      probes,
      success: this.totals.freshnessSuccess,
      maxLagMs: maxLag,
      p99LagMs: lags.length === 0 ? null : nearestRank(lags, 0.99),
      limitMs: limit,
      passed,
    };
  }

  private buildWindow(
    name: 'incident' | 'recovery',
    slo: {
      readonly availability: number;
      readonly detailP999Ms: number;
      readonly searchP999Ms: number;
      readonly uploadP999Ms: number;
    },
  ): ImageScenarioWindow {
    const from =
      (name === 'incident' ? this.incidentFromMs : this.recoveryFromMs) -
      this.trace.measuredFromMs;
    const to =
      (name === 'incident'
        ? this.incidentToMs
        : this.trace.measuredFromMs + this.trace.measuredMs) - this.trace.measuredFromMs;
    const availabilityLimit =
      name === 'incident'
        ? IMAGE_LEVEL.slo.incidentWindowAvailability
        : IMAGE_LEVEL.slo.recoveryAvailability;
    const buildOp = (op: Op): ImageScenarioWindowOperation => {
      const acc = this.windows[name][op];
      const availability = acc.offered === 0 ? 0 : acc.success / acc.offered;
      const p999 = nearestRank(ascending(acc.latencies), 0.999);
      const latencyLimit =
        op === 'upload' ? slo.uploadP999Ms : op === 'search' ? slo.searchP999Ms : slo.detailP999Ms;
      const availabilityOk = acc.offered > 0 && availability >= availabilityLimit;
      const latencyOk = acc.latencies.length > 0 && p999 <= latencyLimit;
      return {
        offered: acc.offered,
        success: acc.success,
        availability,
        latencyP999Ms: p999,
        sampleCount: acc.latencies.length,
        availabilityOk,
        latencyOk,
        passed: availabilityOk && latencyOk,
      };
    };
    const operations = {
      upload: buildOp('upload'),
      search: buildOp('search'),
      detail: buildOp('detail'),
    };
    return {
      fromMs: from,
      toMs: to,
      operations,
      passed: Object.values(operations).every((op) => op.passed),
    };
  }

  private buildChecks(
    operations: ImageScenarioResult['operations'],
    freshness: ImageScenarioResult['freshness'],
    integrity: ImageScenarioResult['dataIntegrity'],
    postlude: ImageScenarioResult['postlude'],
    incidentWindow: ImageScenarioWindow | null,
    recoveryWindow: ImageScenarioWindow | null,
    slo: {
      readonly availability: number;
      readonly detailP999Ms: number;
      readonly searchP999Ms: number;
      readonly uploadP999Ms: number;
    },
  ): ImageCheck[] {
    const checks: ImageCheck[] = [];
    for (const op of ['upload', 'search', 'detail'] as const) {
      const metrics = operations[op];
      checks.push(
        requiredCheck(
          `availability:${op}`,
          `${op} availability`,
          metrics.counts.offered > 0 && metrics.availability >= slo.availability,
          metrics.counts.offered === 0
            ? `No ${op} request was offered, so availability is not measured.`
            : `${op} availability ${(metrics.availability * 100).toFixed(2)}% must be at least ${(slo.availability * 100).toFixed(1)}%; every offered request counts, including rejected and timed-out ones.`,
          {
            operation: op,
            actual: metrics.availability,
            limit: slo.availability,
            unit: 'ratio',
            sampleCount: metrics.counts.offered,
          },
        ),
      );
      const limit =
        op === 'upload' ? slo.uploadP999Ms : op === 'search' ? slo.searchP999Ms : slo.detailP999Ms;
      const samples = metrics.p999SampleCount;
      checks.push(
        requiredCheck(
          `p999:${op}`,
          `${op} p99.9`,
          metrics.p999Reliable && samples > 0 && metrics.latencyP999Ms <= limit,
          !metrics.p999Reliable
            ? `${op} has ${samples} successful samples; p99.9 needs at least ${IMAGE_LEVEL.qualification.minimumP999Samples}.`
            : `${op} successful p99.9 is ${metrics.latencyP999Ms.toFixed(1)} ms; limit ${limit} ms over ${samples} samples.`,
          {
            operation: op,
            actual: metrics.latencyP999Ms,
            limit,
            unit: 'ms',
            sampleCount: samples,
          },
        ),
      );
    }
    checks.push(
      requiredCheck(
        'freshness',
        'Recent-read freshness',
        freshness.passed,
        freshness.probes === 0
          ? 'No recent-read probe observed an acknowledged upload, so freshness is unobserved and cannot pass.'
          : `Recent-read consistency: ${freshness.success} correct observation(s) of ${freshness.probes} attempt(s); failed attempts are counted in detail availability. Max visibility lag ${(freshness.maxLagMs ?? 0).toFixed(0)} ms; limit ${freshness.limitMs} ms; no successful stale or missing response.`,
        {
          actual: freshness.maxLagMs ?? 0,
          limit: freshness.limitMs,
          unit: 'ms',
          sampleCount: freshness.probes,
        },
      ),
    );
    checks.push(
      requiredCheck(
        'data_integrity',
        'Durability, idempotency and publication',
        integrity.passed,
        `Acknowledged uploads ${integrity.acknowledgedUploads}, durable commits ${integrity.committedUploads}, lost-ACK commits ${integrity.lostAckCommitted}, duplicate effects ${integrity.duplicateEffects}, missing search results ${integrity.missingSearchResults}, unpublished ${integrity.unpublishedCommitted}.`,
        { sampleCount: integrity.committedUploads },
      ),
    );
    checks.push(
      requiredCheck(
        'postlude',
        'Consistency postlude',
        postlude.passed,
        `No-new-offers postlude through last ACK + ${postlude.maxAfterLastAckMs} ms published ${postlude.publishedUploads}/${postlude.committedUploads} committed uploads.`,
        {
          actual: postlude.unpublishedCommitted,
          limit: 0,
          unit: 'records',
          sampleCount: postlude.committedUploads,
        },
      ),
    );
    checks.push(
      advisoryCheck(
        'workload_complete',
        'Full measured workload',
        this.ops.upload.offered > 0 && this.ops.search.offered > 0 && this.ops.detail.offered > 0,
        'Every offered business request of the measured window was simulated at sample factor 1.',
      ),
    );
    if (incidentWindow) {
      for (const op of ['upload', 'search', 'detail'] as const) {
        const window = incidentWindow.operations[op];
        checks.push(
          requiredCheck(
            `incident:${op}`,
            `${op} during the incident window`,
            window.passed,
            `${op} incident availability ${(window.availability * 100).toFixed(2)}% and p99.9 ${window.latencyP999Ms.toFixed(1)} ms over ${window.offered} offered requests.`,
            {
              operation: op,
              scenario: this.scenario,
              actual: window.availability,
              limit: IMAGE_LEVEL.slo.incidentWindowAvailability,
              unit: 'ratio',
              sampleCount: window.offered,
            },
          ),
        );
      }
    }
    if (recoveryWindow) {
      for (const op of ['upload', 'search', 'detail'] as const) {
        const window = recoveryWindow.operations[op];
        checks.push(
          requiredCheck(
            `recovery:${op}`,
            `${op} in the final recovery window`,
            window.passed,
            `${op} final-window availability ${(window.availability * 100).toFixed(2)}% and p99.9 ${window.latencyP999Ms.toFixed(1)} ms over ${window.offered} offered requests.`,
            {
              operation: op,
              scenario: this.scenario,
              actual: window.availability,
              limit: IMAGE_LEVEL.slo.recoveryAvailability,
              unit: 'ratio',
              sampleCount: window.offered,
            },
          ),
        );
      }
    }
    return checks;
  }

  private buildNodeMetrics(): ImageNodeMetrics[] {
    const rows: ImageNodeMetrics[] = [];
    for (const node of this.graph.nodes) {
      const acc =
        this.accumulatorByNode.get(node.id) ??
        emptyNodeAccumulator(
          this.trace.measuredFromMs,
          this.trace.measuredFromMs + this.trace.measuredMs,
        );
      const player = this.players.get(node.id);
      const instances = player ? player.instances.length : 1;
      const healthy = player
        ? player.instances.filter((instance) => !instance.down).length
        : node.kind === 'blob'
          ? this.endpointUsable(node.region)
            ? 1
            : 0
          : 1;
      const cpu = this.aggregateResources(node.id, 'cpu');
      const io = this.aggregateResources(node.id, 'io');
      const network = this.aggregateNetwork(node.id);
      const memoryAverage = player
        ? player.instances.reduce(
            (sum, instance) =>
              sum +
              (this.trace.measuredMs > 0 ? instance.ram.areaBytesMs / this.trace.measuredMs : 0),
            0,
          )
        : 0;
      const memoryPeak = player
        ? player.instances.reduce((sum, instance) => sum + instance.ram.ledger.peakBytes, 0)
        : 0;
      const cache =
        player && node.kind === 'cache' ? this.cacheMetrics(player) : null;
      const replication =
        player && node.kind === 'metadata'
          ? {
              replicatedWrites: acc.replicatedWrites,
              queuedBytes: this.replicationBacklogBytes(node.id),
              lagMaxMs: acc.replicationLagMaxMs,
            }
          : null;
      rows.push({
        nodeId: node.id,
        kind: node.kind,
        label: node.label,
        region: node.region,
        instances,
        healthyInstances: healthy,
        requests: acc.requests,
        completed: acc.completed,
        errors: acc.errors,
        rejected: acc.rejected,
        timedOut: acc.timedOut,
        cpuUtilizationAvg: cpu.average,
        cpuUtilizationPeak: cpu.peak,
        memoryBytesAvg: memoryAverage,
        memoryBytesPeak: memoryPeak,
        memoryLimitBytes: player
          ? player.instances.length * IMAGE_CATALOG.instance.usableMemoryGb * IMAGE_BYTES_PER_GB
          : 0,
        ioUtilizationAvg: io.average,
        ioUtilizationPeak: io.peak,
        networkIngressGbitAvg: network.ingressAverage,
        networkIngressGbitPeak: network.ingressPeak,
        networkEgressGbitAvg: network.egressAverage,
        networkEgressGbitPeak: network.egressPeak,
        queueDepthAvg: acc.queue.averageDepth,
        queueDepthPeak: acc.queue.peakDepth,
        queueWaitP95Ms: acc.waits.percentile(0.95),
        bytesRead: acc.bytesRead,
        bytesWritten: acc.bytesWritten,
        cache,
        replication,
      });
    }
    return rows;
  }

  private replicationBacklogBytes(originId: string): number {
    const origin = this.stores.get(originId);
    if (!origin) {
      return 0;
    }
    let bytes = 0;
    for (const target of this.replicationByOrigin.get(originId) ?? []) {
      const applied = this.replicaProgress.get(target.targetNodeId)?.get(originId) ?? 0;
      const targetStore = this.stores.get(target.targetNodeId);
      const amplification = targetStore?.indexBytes ?? 0;
      bytes += Math.max(0, origin.seq - applied) * (IMAGE_LEVEL.dataset.metadataBytes + amplification);
    }
    return bytes;
  }

  private cacheMetrics(player: PlayerRuntime): {
    hits: number;
    misses: number;
    coalesced: number;
    evictions: number;
    hitRatio: number | null;
  } {
    let hits = 0;
    let misses = 0;
    let evictions = 0;
    for (const instance of player.instances) {
      if (!instance.cacheStore) {
        continue;
      }
      hits += instance.cacheStore.hits;
      misses += instance.cacheStore.misses;
      evictions += instance.cacheStore.evictions;
    }
    const acc = this.accumulatorByNode.get(player.node.id);
    return {
      hits,
      misses,
      coalesced: acc?.cacheCoalesced ?? 0,
      evictions,
      hitRatio: hits + misses === 0 ? null : hits / (hits + misses),
    };
  }

  private aggregateResources(
    nodeId: string,
    kind: 'cpu' | 'io',
  ): { average: number; peak: number } {
    const player = this.players.get(nodeId);
    if (!player) {
      return { average: 0, peak: 0 };
    }
    const capacity =
      kind === 'cpu' ? IMAGE_CATALOG.instance.cpuCores : IMAGE_WORK_MODEL.io.lanesPerInstance;
    let busyUnitMs = 0;
    let peak = 0;
    let count = 0;
    for (const instance of player.instances) {
      const row = this.resourceStats.get(kind === 'cpu' ? instance.cpu : instance.io);
      if (!row) {
        continue;
      }
      busyUnitMs += row.busyUnitMs;
      peak += row.peakBusyUnits;
      count += 1;
    }
    if (count === 0 || this.trace.measuredMs <= 0) {
      return { average: 0, peak: 0 };
    }
    return {
      average: busyUnitMs / (capacity * count * this.trace.measuredMs),
      peak: peak / (capacity * count),
    };
  }

  private aggregateNetwork(nodeId: string): {
    ingressAverage: number;
    ingressPeak: number;
    egressAverage: number;
    egressPeak: number;
  } {
    const player = this.players.get(nodeId);
    if (!player) {
      return { ingressAverage: 0, ingressPeak: 0, egressAverage: 0, egressPeak: 0 };
    }
    let ingressMs = 0;
    let egressMs = 0;
    let ingressPeak = 0;
    let egressPeak = 0;
    for (const instance of player.instances) {
      const rx = this.resourceStats.get(instance.rx);
      const tx = this.resourceStats.get(instance.tx);
      ingressMs += rx?.busyUnitMs ?? 0;
      egressMs += tx?.busyUnitMs ?? 0;
      ingressPeak += rx?.peakBusyUnits ?? 0;
      egressPeak += tx?.peakBusyUnits ?? 0;
    }
    return {
      ingressAverage: ingressMs / this.trace.measuredMs,
      ingressPeak,
      egressAverage: egressMs / this.trace.measuredMs,
      egressPeak,
    };
  }

  private buildLinkMetrics(): ImagePhysicalLinkMetrics[] {
    const rows: ImagePhysicalLinkMetrics[] = [];
    for (const link of this.linkRows.values()) {
      let sentBusyMs = 0;
      let receivedBusyMs = 0;
      let sentPeak = 0;
      let receivedPeak = 0;
      for (const id of link.kernelIds) {
        const row = this.resourceStats.get(id);
        if (!row) {
          continue;
        }
        if (link.sentIds.includes(id)) {
          sentBusyMs += row.busyUnitMs;
          sentPeak += row.peakBusyUnits;
        } else {
          receivedBusyMs += row.busyUnitMs;
          receivedPeak += row.peakBusyUnits;
        }
      }
      // Displayed capacity is per direction; the busier direction sets the
      // utilization so the limit is never doubled by adding RX and TX.
      const busyMs = Math.max(sentBusyMs, receivedBusyMs);
      const peak = Math.max(sentPeak, receivedPeak);
      const capacity = Math.max(1, link.capacityGbitPerSec);
      rows.push({
        id: link.id,
        kind: link.kind,
        label: link.label,
        regionA: link.regionA,
        regionB: link.regionB,
        direction: link.direction,
        capacityGbitPerSec: link.capacityGbitPerSec,
        averageUtilization:
          link.kind === 'request-access-link'
            ? link.accessLatencyMs > 0
              ? link.accessBusyMs / link.accessLatencyMs
              : 0
            : busyMs / (capacity * this.trace.measuredMs),
        peakUtilization: peak / capacity,
        bytesSent: link.sentBytes,
        bytesReceived: link.receivedBytes,
        transfers: link.transfers,
        queueWaitP95Ms: link.waits.percentile(0.95),
      });
    }
    return rows;
  }
}

/** Public entry point for one scenario. */
export function simulateImageScenario(
  graph: ImageGraph,
  routes: ImageRoutePlan,
  trace: ImageTrace,
  onTraffic?: TrafficObserver,
  /** @internal Test-only bounded-queue override; see ImageSimulator. */
  testOnlyQueueLimit?: number,
): ImageScenarioSimulation {
  const simulator = new ImageSimulator(
    graph,
    routes,
    trace,
    onTraffic,
    testOnlyQueueLimit,
  );
  return simulator.run();
}
