/**
 * Cart-local physical network model (cart-protocol-v1, DEVELOPER §6).
 *
 * The frozen shared helper `src/simulation/resources/network.ts` assumes
 * 1 Gbit/s lane quanta and stays unchanged for the existing levels. The cart
 * profile contains sub-Gbit links (2/8/32 Mbit/s WAN, 20 Mbit/s client access,
 * 100 Mbit/s NICs), so this module implements an explicit store-and-forward
 * approximation instead of feeding tiny capacities into the 1 Gbit/s helper:
 *
 * - one FIFO serializer per physical direction (client access, component NIC,
 *   regional fabric, WAN circuit);
 * - a transfer visits source NIC egress, then the regional fabric OR the WAN
 *   direction, then destination NIC ingress, then propagation;
 * - each stage waits in its own FIFO, so small messages pay several
 *   serialization stages;
 * - duplicate semantic arrows never multiply capacity: physical ids are
 *   derived from regions, device instances and direction only, never from
 *   semantic edge ids;
 * - finite waiting-byte limits count only jobs actually queued at a physical
 *   FIFO: bytes in service, and bytes still travelling through earlier stages,
 *   do not consume waiting capacity. The entry FIFO is checked before any
 *   serialization; a transfer whose later stage arrives at a full FIFO is
 *   cancelled without delivering its logical envelope and keeps its already
 *   serialized bytes counted;
 * - a partition cancels queued and in-flight logical deliveries but keeps
 *   already serialized WAN bytes billable;
 * - ordering uses the frozen `EventScheduler` with cart-local priorities:
 *   fault transitions, completions/commits, absolute deadlines, foreground
 *   arrivals, background polls.
 *
 * Durations are integer microseconds rounded up, as required by the protocol
 * clock. No wall clock, randomness or DOM is used.
 */

import {
  CART_REGION_INFO,
  type CartCircuitMbps,
  type CartGraph,
  type CartNode,
  type CartRegion,
} from '../contracts';
import {
  EventScheduler,
  type ScheduledHandle,
} from '../../simulation/resources/scheduler';

// ---------------------------------------------------------------------------
// Physical profile (proposed values, calibration pending)
// ---------------------------------------------------------------------------

/** Client access: fixed 20 Mbit/s per logical client. */
export const CART_CLIENT_ACCESS_BPS = 20_000_000;
/** Component NIC: 100 Mbit/s per instance. */
export const CART_COMPONENT_NIC_BPS = 100_000_000;
/** Intra-region fabric: 1 Gbit/s per direction, shared by region components. */
export const CART_REGIONAL_FABRIC_BPS = 1_000_000_000;

/** One-way propagation, in integer microseconds. */
export const CART_PROPAGATION_US = {
  client: 8_000,
  local: 1_000,
  wan: {
    'us-west|eu-central': 80_000,
    'us-west|ap-northeast': 55_000,
    'eu-central|ap-northeast': 120_000,
  },
} as const;

/** WAN direction waiting-byte limit. */
export const CART_WAN_WAITING_BYTE_LIMIT = 64 * 1024;
/** NIC and regional fabric waiting-byte limit. */
export const CART_COMPONENT_WAITING_BYTE_LIMIT = 256 * 1024;

/**
 * Cart-local scheduler priorities. Lower numeric value runs first, matching
 * the frozen scheduler. Completion (1) precedes deadline (2), so a completion
 * exactly at the deadline wins; a fault transition (0) precedes completion, so
 * a link failure exactly at delivery prevents delivery.
 */
export const CART_EVENT_PRIORITY = {
  fault: 0,
  completion: 1,
  deadline: 2,
  arrival: 3,
  poll: 4,
} as const;

export type CartEventPriority = (typeof CART_EVENT_PRIORITY)[keyof typeof CART_EVENT_PRIORITY];

export const CART_GIB_BYTES = 1_073_741_824;
/** Pricing candidate: all interregional serialized bytes cost 1 credit/GiB. */
export const CART_WAN_CREDITS_PER_GIB = 1;

// ---------------------------------------------------------------------------
// Physical topology
// ---------------------------------------------------------------------------

export type CartPhysicalLinkKind = 'client-access' | 'nic' | 'fabric' | 'wan';

export interface CartPhysicalLink {
  readonly id: string;
  readonly kind: CartPhysicalLinkKind;
  readonly bitsPerSecond: number;
  readonly waitingByteLimit: number;
  /** Region for fabric/client links; originating component region for NICs. */
  readonly region?: CartRegion;
  /** Canonical region pair for WAN links. */
  readonly pair?: string;
  readonly direction: string;
}

export interface CartTopology {
  readonly nodes: ReadonlyMap<string, CartNode>;
  readonly circuits: ReadonlyMap<string, CartCircuitMbps>;
}

export type CartEndpoint =
  | { readonly kind: 'client'; readonly region: CartRegion; readonly clientId: string }
  | { readonly kind: 'node'; readonly nodeId: string; readonly instance?: number };

export type CartTransferPurpose = 'request' | 'reply' | 'replication' | 'other';

export interface CartTransferRequest {
  readonly logicalId: string;
  readonly bytes: number;
  readonly from: CartEndpoint;
  readonly to: CartEndpoint;
  readonly purpose: CartTransferPurpose;
  /** Absolute deadline in microseconds; a completion exactly at it wins. */
  readonly deadlineUs?: number;
}

/** Canonical unordered region pair key, ordered by canonical ordinal. */
export function cartRegionPairKey(a: CartRegion, b: CartRegion): string {
  const left = CART_REGION_INFO[a];
  const right = CART_REGION_INFO[b];
  return left.ordinal < right.ordinal ? `${a}|${b}` : `${b}|${a}`;
}

/** One-way propagation between two distinct regions, in microseconds. */
export function cartWanPropagationUs(a: CartRegion, b: CartRegion): number {
  const key = cartRegionPairKey(a, b);
  const table = CART_PROPAGATION_US.wan as Readonly<Record<string, number>>;
  const value = table[key];
  if (value === undefined) {
    throw new RangeError(`no physical WAN propagation for pair ${key}`);
  }
  return value;
}

export function createCartTopology(graph: CartGraph): CartTopology {
  const nodes = new Map<string, CartNode>();
  for (const node of graph.nodes) {
    nodes.set(node.id, node);
  }
  const circuits = new Map<string, CartCircuitMbps>();
  for (const circuit of graph.circuits) {
    const [first, second] = circuit.regions;
    circuits.set(cartRegionPairKey(first, second), circuit.mbps);
  }
  return { nodes, circuits };
}

/** Deterministic physical ids; semantic edge or label data never appears. */
export function cartClientAccessLinkId(
  region: CartRegion,
  clientId: string,
  direction: 'up' | 'down',
): string {
  return `client-access:${region}:${clientId}:${direction}`;
}

export function cartNicLinkId(
  nodeId: string,
  instance: number,
  direction: 'egress' | 'ingress',
): string {
  return `nic:${nodeId}:${instance}:${direction}`;
}

export function cartFabricLinkId(region: CartRegion, direction: string): string {
  return `fabric:${region}:${direction}`;
}

export function cartWanLinkId(
  pair: string,
  direction: 'forward' | 'reverse',
): string {
  return `wan:${pair}:${direction}`;
}

/** Canonical flow direction: forward follows ascending region ordinal. */
export function cartLinkDirection(
  from: CartRegion,
  to: CartRegion,
): 'forward' | 'reverse' {
  return CART_REGION_INFO[from].ordinal < CART_REGION_INFO[to].ordinal
    ? 'forward'
    : 'reverse';
}

function instanceCount(node: CartNode): number {
  return node.kind === 'application' ? node.instances : 1;
}

function nodeInstance(node: CartNode, instance: number | undefined): number {
  const count = instanceCount(node);
  const value = instance ?? 1;
  if (!Number.isInteger(value) || value < 1 || value > count) {
    throw new RangeError(`node ${node.id} has no instance ${String(value)}`);
  }
  return value;
}

function endpointRegion(topology: CartTopology, endpoint: CartEndpoint): CartRegion {
  if (endpoint.kind === 'client') {
    return endpoint.region;
  }
  const node = topology.nodes.get(endpoint.nodeId);
  if (node === undefined) {
    throw new RangeError(`unknown node ${endpoint.nodeId}`);
  }
  return node.region;
}

// ---------------------------------------------------------------------------
// Path planning
// ---------------------------------------------------------------------------

export interface CartStagePlan {
  readonly link: CartPhysicalLink;
  readonly bytes: number;
}

export type CartPathPlan =
  | {
      readonly ok: true;
      readonly stages: readonly CartStagePlan[];
      readonly propagationUs: number;
      readonly pathKind: 'client' | 'local' | 'wan';
      readonly wanPair?: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'client_to_client'
        | 'unknown_node'
        | 'cross_region_client'
        | 'missing_circuit';
    };

/**
 * Builds the ordered physical stages for one transfer. Request and reply are
 * separate calls over opposite directions; they never share a serializer.
 */
export function planCartTransfer(
  topology: CartTopology,
  request: Pick<CartTransferRequest, 'bytes' | 'from' | 'to'>,
): CartPathPlan {
  const bytes = request.bytes;
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError('transfer bytes must be finite and non-negative');
  }
  if (request.from.kind === 'client' && request.to.kind === 'client') {
    return { ok: false, reason: 'client_to_client' };
  }
  for (const endpoint of [request.from, request.to]) {
    if (endpoint.kind === 'node' && !topology.nodes.has(endpoint.nodeId)) {
      return { ok: false, reason: 'unknown_node' };
    }
  }

  const fromNode =
    request.from.kind === 'node' ? topology.nodes.get(request.from.nodeId) : undefined;
  const toNode =
    request.to.kind === 'node' ? topology.nodes.get(request.to.nodeId) : undefined;

  if (request.from.kind === 'client' && toNode === undefined) {
    return { ok: false, reason: 'unknown_node' };
  }
  if (request.to.kind === 'client' && fromNode === undefined) {
    return { ok: false, reason: 'unknown_node' };
  }

  const fromRegion = endpointRegion(topology, request.from);
  const toRegion = endpointRegion(topology, request.to);

  // A client edge connects only its own region's Application; a client may
  // never reach another region directly.
  if (request.from.kind === 'client' || request.to.kind === 'client') {
    if (fromRegion !== toRegion) {
      return { ok: false, reason: 'cross_region_client' };
    }
    if (request.from.kind === 'client') {
      if (request.to.kind !== 'node') {
        return { ok: false, reason: 'client_to_client' };
      }
      const node = topology.nodes.get(request.to.nodeId);
      if (node === undefined) {
        return { ok: false, reason: 'unknown_node' };
      }
      const instance = nodeInstance(node, request.to.instance);
      const clientLink: CartPhysicalLink = {
        id: cartClientAccessLinkId(request.from.region, request.from.clientId, 'up'),
        kind: 'client-access',
        bitsPerSecond: CART_CLIENT_ACCESS_BPS,
        waitingByteLimit: CART_COMPONENT_WAITING_BYTE_LIMIT,
        region: request.from.region,
        direction: 'up',
      };
      const nodeNic: CartPhysicalLink = {
        id: cartNicLinkId(node.id, instance, 'ingress'),
        kind: 'nic',
        bitsPerSecond: CART_COMPONENT_NIC_BPS,
        waitingByteLimit: CART_COMPONENT_WAITING_BYTE_LIMIT,
        region: node.region,
        direction: 'ingress',
      };
      return {
        ok: true,
        stages: [
          { link: clientLink, bytes },
          { link: nodeNic, bytes },
        ],
        propagationUs: CART_PROPAGATION_US.client,
        pathKind: 'client',
      };
    }
    if (request.from.kind !== 'node') {
      return { ok: false, reason: 'client_to_client' };
    }
    if (request.to.kind !== 'client') {
      return { ok: false, reason: 'client_to_client' };
    }
    const node = topology.nodes.get(request.from.nodeId);
    if (node === undefined) {
      return { ok: false, reason: 'unknown_node' };
    }
    const instance = nodeInstance(node, request.from.instance);
    const nodeNic: CartPhysicalLink = {
      id: cartNicLinkId(node.id, instance, 'egress'),
      kind: 'nic',
      bitsPerSecond: CART_COMPONENT_NIC_BPS,
      waitingByteLimit: CART_COMPONENT_WAITING_BYTE_LIMIT,
      region: node.region,
      direction: 'egress',
    };
    const clientLink: CartPhysicalLink = {
      id: cartClientAccessLinkId(request.to.region, request.to.clientId, 'down'),
      kind: 'client-access',
      bitsPerSecond: CART_CLIENT_ACCESS_BPS,
      waitingByteLimit: CART_COMPONENT_WAITING_BYTE_LIMIT,
      region: request.to.region,
      direction: 'down',
    };
    return {
      ok: true,
      stages: [
        { link: nodeNic, bytes },
        { link: clientLink, bytes },
      ],
      propagationUs: CART_PROPAGATION_US.client,
      pathKind: 'client',
    };
  }

  if (fromNode === undefined || toNode === undefined) {
    return { ok: false, reason: 'unknown_node' };
  }
  const fromInstance = nodeInstance(fromNode, request.from.kind === 'node' ? request.from.instance : undefined);
  const toInstance = nodeInstance(toNode, request.to.kind === 'node' ? request.to.instance : undefined);
  const egress: CartPhysicalLink = {
    id: cartNicLinkId(fromNode.id, fromInstance, 'egress'),
    kind: 'nic',
    bitsPerSecond: CART_COMPONENT_NIC_BPS,
    waitingByteLimit: CART_COMPONENT_WAITING_BYTE_LIMIT,
    region: fromNode.region,
    direction: 'egress',
  };
  const ingress: CartPhysicalLink = {
    id: cartNicLinkId(toNode.id, toInstance, 'ingress'),
    kind: 'nic',
    bitsPerSecond: CART_COMPONENT_NIC_BPS,
    waitingByteLimit: CART_COMPONENT_WAITING_BYTE_LIMIT,
    region: toNode.region,
    direction: 'ingress',
  };

  if (fromNode.region === toNode.region) {
    const fabric: CartPhysicalLink = {
      id: cartFabricLinkId(fromNode.region, 'local'),
      kind: 'fabric',
      bitsPerSecond: CART_REGIONAL_FABRIC_BPS,
      waitingByteLimit: CART_COMPONENT_WAITING_BYTE_LIMIT,
      region: fromNode.region,
      direction: 'local',
    };
    return {
      ok: true,
      stages: [
        { link: egress, bytes },
        { link: fabric, bytes },
        { link: ingress, bytes },
      ],
      propagationUs: CART_PROPAGATION_US.local,
      pathKind: 'local',
    };
  }

  const pair = cartRegionPairKey(fromNode.region, toNode.region);
  const mbps = topology.circuits.get(pair);
  if (mbps === undefined) {
    return { ok: false, reason: 'missing_circuit' };
  }
  const direction = cartLinkDirection(fromNode.region, toNode.region);
  const wan: CartPhysicalLink = {
    id: cartWanLinkId(pair, direction),
    kind: 'wan',
    bitsPerSecond: mbps * 1_000_000,
    waitingByteLimit: CART_WAN_WAITING_BYTE_LIMIT,
    pair,
    direction,
  };
  return {
    ok: true,
    stages: [
      { link: egress, bytes },
      { link: wan, bytes },
      { link: ingress, bytes },
    ],
    propagationUs: cartWanPropagationUs(fromNode.region, toNode.region),
    pathKind: 'wan',
    wanPair: pair,
  };
}

// ---------------------------------------------------------------------------
// Serializer durations
// ---------------------------------------------------------------------------

/**
 * Serialization time for one stage in integer microseconds, rounded up.
 * `bytes * 8` bits at `bitsPerSecond`; zero bytes stay zero.
 */
export function cartSerializationUs(bytes: number, bitsPerSecond: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError('bytes must be finite and non-negative');
  }
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) {
    throw new RangeError('bitsPerSecond must be finite and positive');
  }
  if (bytes === 0) {
    return 0;
  }
  return Math.ceil((bytes * 8 * 1_000_000) / bitsPerSecond);
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type CartTransferStatus = 'in-flight' | 'delivered' | 'cancelled';
export type CartCancelReason = 'deadline' | 'link-failure' | 'manual' | 'overflow';
/** `pending` stages have not reached their FIFO yet and consume no capacity. */
export type CartStageState = 'pending' | 'waiting' | 'serializing' | 'done' | 'cancelled';

export interface CartTransferStage {
  readonly link: CartPhysicalLink;
  readonly bytes: number;
  serializedBytes: number;
  state: CartStageState;
  startedUs: number | null;
  completedUs: number | null;
}

export interface CartTransfer {
  readonly id: number;
  readonly logicalId: string;
  readonly purpose: CartTransferPurpose;
  readonly from: CartEndpoint;
  readonly to: CartEndpoint;
  readonly bytes: number;
  readonly stages: CartTransferStage[];
  readonly propagationUs: number;
  readonly pathKind: 'client' | 'local' | 'wan';
  readonly wanPair: string | null;
  readonly enqueuedAtUs: number;
  readonly deadlineUs: number | null;
  status: CartTransferStatus;
  cancelReason: CartCancelReason | null;
  cancelledAtUs: number | null;
  deliveredAtUs: number | null;
  /** WAN bytes actually serialized, including prefixes lost to failures. */
  billedWanBytes: number;
  /** Bytes serialized on every stage, billable or not. */
  serializedBytes: number;
}

export type CartTransferResult =
  | { readonly ok: true; readonly transfer: CartTransfer }
  | {
      readonly ok: false;
      readonly reason:
        | 'overflow'
        | 'partitioned'
        | 'client_to_client'
        | 'unknown_node'
        | 'cross_region_client'
        | 'missing_circuit';
      /** Physical link that rejected the transfer, when applicable. */
      readonly linkId?: string;
      readonly waitingBytes?: number;
      readonly limitBytes?: number;
    };

export interface CartLinkSnapshot {
  readonly id: string;
  readonly kind: CartPhysicalLinkKind;
  readonly bitsPerSecond: number;
  readonly waitingByteLimit: number;
  readonly waitingBytes: number;
  readonly serializedBytes: number;
  readonly inFlightBytes: number;
  readonly blocked: boolean;
}

/** Observed load of one physical link so far (read-only counters). */
export interface CartLinkLoad {
  readonly id: string;
  readonly kind: CartPhysicalLinkKind;
  readonly pair: string | null;
  readonly direction: string;
  readonly bitsPerSecond: number;
  readonly jobs: number;
  readonly busyUs: number;
  readonly waitTotalUs: number;
  readonly waitMaxUs: number;
}

export interface CartNetworkCounters {
  readonly offeredTransfers: number;
  readonly deliveredTransfers: number;
  readonly cancelledTransfers: number;
  readonly rejectedTransfers: number;
  readonly offeredBytes: number;
  readonly deliveredBytes: number;
  readonly cancelledBytes: number;
  readonly serializedBytes: number;
  readonly wanBillableBytes: number;
  readonly wanBillableGib: number;
  readonly wanCostCredits: number;
  readonly localSerializedBytes: number;
}

interface LinkState {
  readonly link: CartPhysicalLink;
  waitingBytes: number;
  serializedBytes: number;
  queue: StageJob[];
  inFlight: StageJob | null;
  inFlightStartedUs: number;
  inFlightDurationUs: number;
  blocked: boolean;
  /** Read-only load counters; they never influence scheduling. */
  loadJobs: number;
  loadBusyUs: number;
  loadWaitTotalUs: number;
  loadWaitMaxUs: number;
}

interface StageJob {
  readonly transfer: CartTransfer;
  readonly stage: CartTransferStage;
  handle: ScheduledHandle | null;
  /** When this stage entered the link FIFO; observation only. */
  readonly enqueuedUs: number;
}

export interface CartNetworkOptions {
  /** Reuse an existing frozen scheduler; defaults to a fresh one. */
  readonly scheduler?: EventScheduler;
  /**
   * Settlement notification (GC-011 integration seam).
   *
   * Invoked exactly once per transfer, after its terminal `status`
   * (`delivered`/`cancelled`), `deliveredAtUs`/`cancelledAtUs` and every byte
   * counter are final. Rejected submissions never settle and never notify.
   *
   * The callback runs inside the scheduler's event dispatch. It must not
   * re-enter `runUntil`/`advanceToUs` or mutate transfers synchronously; it is
   * intended to queue protocol continuations that the caller drives afterwards.
   * Callers that omit it keep the previous behaviour byte-for-byte.
   */
  readonly onSettled?: (transfer: CartTransfer) => void;
}

/**
 * Deterministic cart-local network. All times are integer microseconds;
 * the shared scheduler runs in milliseconds so microsecond values are passed
 * as `us / 1000` (exact for whole microseconds up to 2^43).
 */
export class CartNetworkModel {
  private readonly topology: CartTopology;
  private readonly scheduler: EventScheduler;
  private readonly links = new Map<string, LinkState>();
  private readonly transfers: CartTransfer[] = [];
  private nowUs = 0;
  private nextTransferId = 1;
  private offeredTransfers = 0;
  private deliveredTransfers = 0;
  private cancelledTransfers = 0;
  private rejectedTransfers = 0;
  private offeredBytes = 0;
  private deliveredBytes = 0;
  private cancelledBytes = 0;
  private wanBillableBytes = 0;
  private totalSerializedBytes = 0;

  private readonly onSettled: ((transfer: CartTransfer) => void) | null;
  private readonly settled = new WeakSet<CartTransfer>();

  constructor(topology: CartTopology, options: CartNetworkOptions = {}) {
    this.topology = topology;
    this.scheduler = options.scheduler ?? new EventScheduler();
    this.onSettled = options.onSettled ?? null;
  }

  private notifySettled(transfer: CartTransfer): void {
    if (this.onSettled === null || this.settled.has(transfer)) return;
    this.settled.add(transfer);
    this.onSettled(transfer);
  }

  get schedulerRef(): EventScheduler {
    return this.scheduler;
  }

  get currentTimeUs(): number {
    return this.nowUs;
  }

  /** Advances the logical clock to `us`, running due events in frozen order. */
  advanceToUs(us: number): number {
    if (!Number.isFinite(us) || us < this.nowUs) {
      throw new RangeError(`cannot advance from ${this.nowUs}us to ${String(us)}us`);
    }
    this.scheduler.runUntil(us / 1000);
    this.nowUs = us;
    return this.nowUs;
  }

  /**
   * Advances at most one scheduled event, never past `untilUs`. A settlement
   * notification therefore reaches the caller before the clock moves beyond it.
   */
  advanceOneEvent(untilUs: number): { readonly processed: boolean; readonly nowUs: number } {
    if (!Number.isFinite(untilUs) || untilUs < this.nowUs) {
      throw new RangeError(`cannot advance from ${this.nowUs}us to ${String(untilUs)}us`);
    }
    const result = this.scheduler.runUntil(untilUs / 1000, 1);
    this.nowUs = Math.min(untilUs, Math.max(this.nowUs, Math.round(result.nowMs * 1000)));
    return { processed: result.processedEvents > 0, nowUs: this.nowUs };
  }

  private linkState(link: CartPhysicalLink): LinkState {
    const existing = this.links.get(link.id);
    if (existing !== undefined) {
      return existing;
    }
    const created: LinkState = {
      link,
      waitingBytes: 0,
      serializedBytes: 0,
      queue: [],
      inFlight: null,
      inFlightStartedUs: 0,
      inFlightDurationUs: 0,
      blocked: false,
      loadJobs: 0,
      loadBusyUs: 0,
      loadWaitTotalUs: 0,
      loadWaitMaxUs: 0,
    };
    this.links.set(link.id, created);
    return created;
  }

  /** Submits one logical delivery. Rejection happens before any serialization. */
  submit(request: CartTransferRequest, atUs = this.nowUs): CartTransferResult {
    if (!Number.isFinite(request.bytes) || request.bytes < 0) {
      throw new RangeError('transfer bytes must be finite and non-negative');
    }
    if (typeof request.logicalId !== 'string' || request.logicalId.length === 0) {
      throw new TypeError('logicalId must be a non-empty string');
    }
    if (atUs < this.nowUs) {
      throw new RangeError(`submit time ${atUs}us precedes model time ${this.nowUs}us`);
    }
    this.nowUs = atUs;

    const plan = planCartTransfer(this.topology, request);
    if (!plan.ok) {
      this.rejectedTransfers += 1;
      return { ok: false, reason: plan.reason };
    }

    for (const stage of plan.stages) {
      const link = this.linkState(stage.link);
      if (link.blocked) {
        this.rejectedTransfers += 1;
        return { ok: false, reason: 'partitioned', linkId: link.link.id };
      }
    }

    // Only the entry FIFO receives bytes right now. Later stages are checked
    // when they actually arrive; counting them here would charge a queue for
    // bytes that are still travelling through earlier serializers.
    const firstPlannedStage = plan.stages[0];
    if (firstPlannedStage === undefined) {
      throw new Error('a cart transfer always has at least one physical stage');
    }
    const entryLink = this.linkState(firstPlannedStage.link);
    if (entryLink.waitingBytes + firstPlannedStage.bytes > entryLink.link.waitingByteLimit) {
      this.rejectedTransfers += 1;
      return {
        ok: false,
        reason: 'overflow',
        linkId: entryLink.link.id,
        waitingBytes: entryLink.waitingBytes,
        limitBytes: entryLink.link.waitingByteLimit,
      };
    }

    const stages: CartTransferStage[] = plan.stages.map(
      (stage, index): CartTransferStage => ({
        link: stage.link,
        bytes: stage.bytes,
        serializedBytes: 0,
        state: index === 0 ? 'waiting' : 'pending',
        startedUs: null,
        completedUs: null,
      }),
    );
    const transfer: CartTransfer = {
      id: this.nextTransferId,
      logicalId: request.logicalId,
      purpose: request.purpose,
      from: request.from,
      to: request.to,
      bytes: request.bytes,
      stages,
      propagationUs: plan.propagationUs,
      pathKind: plan.pathKind,
      wanPair: plan.wanPair ?? null,
      enqueuedAtUs: atUs,
      deadlineUs: request.deadlineUs ?? null,
      status: 'in-flight',
      cancelReason: null,
      cancelledAtUs: null,
      deliveredAtUs: null,
      billedWanBytes: 0,
      serializedBytes: 0,
    };
    this.nextTransferId += 1;
    this.transfers.push(transfer);
    this.offeredTransfers += 1;
    this.offeredBytes += request.bytes;

    if (transfer.deadlineUs !== null) {
      this.scheduler.schedule(
        transfer.deadlineUs / 1000,
        () => this.expireTransfer(transfer, transfer.deadlineUs ?? atUs),
        CART_EVENT_PRIORITY.deadline,
      );
    }

    // Charge waiting capacity only for the stage entering its FIFO now; later
    // stages are charged on arrival so FIFO order follows arrival and never
    // submission lookahead.
    const firstStage = stages[0];
    if (firstStage === undefined) {
      throw new Error('a cart transfer always has at least one physical stage');
    }
    const firstLink = this.linkState(firstStage.link);
    firstLink.waitingBytes += firstStage.bytes;
    firstLink.queue.push({ transfer, stage: firstStage, handle: null, enqueuedUs: atUs });
    this.pump(firstLink, atUs);
    return { ok: true, transfer };
  }

  /** Completes all queued work due at or before `us`. */
  private pump(link: LinkState, atUs: number): void {
    if (link.inFlight !== null || link.blocked) {
      return;
    }
    const job = link.queue.shift();
    if (job === undefined) {
      return;
    }
    // A job that starts serializing leaves the waiting queue, so only bytes
    // actually queued behind it count against the waiting-byte limit.
    link.waitingBytes -= job.stage.bytes;
    job.stage.state = 'serializing';
    job.stage.startedUs = atUs;
    link.inFlight = job;
    link.inFlightStartedUs = atUs;
    const durationUs = cartSerializationUs(job.stage.bytes, link.link.bitsPerSecond);
    link.inFlightDurationUs = durationUs;
    const waitedUs = Math.max(0, atUs - job.enqueuedUs);
    link.loadJobs += 1;
    link.loadBusyUs += durationUs;
    link.loadWaitTotalUs += waitedUs;
    if (waitedUs > link.loadWaitMaxUs) link.loadWaitMaxUs = waitedUs;
    const finishUs = atUs + durationUs;
    job.handle = this.scheduler.schedule(
      finishUs / 1000,
      () => this.completeStage(link, job, finishUs),
      CART_EVENT_PRIORITY.completion,
    );
  }

  private completeStage(link: LinkState, job: StageJob, atUs: number): void {
    this.nowUs = atUs;
    const stage = job.stage;
    const transfer = job.transfer;
    stage.state = 'done';
    stage.serializedBytes = stage.bytes;
    stage.completedUs = atUs;
    link.inFlight = null;
    link.inFlightStartedUs = 0;
    link.inFlightDurationUs = 0;
    link.serializedBytes += stage.bytes;
    this.totalSerializedBytes += stage.bytes;
    transfer.serializedBytes += stage.bytes;
    if (link.link.kind === 'wan') {
      transfer.billedWanBytes += stage.bytes;
      this.wanBillableBytes += stage.bytes;
    }

    const index = transfer.stages.indexOf(stage);
    const next = transfer.stages[index + 1];
    if (next === undefined) {
      // Propagation is pure delay: the logical envelope is delivered only
      // after it completes, so a fault exactly at delivery still prevents it.
      const deliveryUs = atUs + transfer.propagationUs;
      this.scheduler.schedule(
        deliveryUs / 1000,
        () => this.deliverTransfer(transfer, deliveryUs),
        CART_EVENT_PRIORITY.completion,
      );
    } else {
      this.enqueueNextStage(transfer, next, atUs);
    }

    this.pump(link, atUs);
  }

  /**
   * Places the next stage in its physical FIFO when the previous stage has
   * finished. The queue is checked on arrival: in-service bytes and stages not
   * yet reached never consume waiting capacity. A blocked link or a full FIFO
   * cancels the logical delivery; bytes already serialized stay counted.
   */
  private enqueueNextStage(transfer: CartTransfer, stage: CartTransferStage, atUs: number): void {
    const link = this.linkState(stage.link);
    if (link.blocked) {
      this.cancelTransfer(transfer, 'link-failure', atUs);
      return;
    }
    if (link.waitingBytes + stage.bytes > link.link.waitingByteLimit) {
      this.cancelTransfer(transfer, 'overflow', atUs);
      return;
    }
    stage.state = 'waiting';
    link.waitingBytes += stage.bytes;
    link.queue.push({ transfer, stage, handle: null, enqueuedUs: atUs });
    this.pump(link, atUs);
  }

  private deliverTransfer(transfer: CartTransfer, atUs: number): void {
    this.nowUs = atUs;
    if (transfer.status !== 'in-flight') {
      return;
    }
    transfer.status = 'delivered';
    transfer.deliveredAtUs = atUs;
    this.deliveredTransfers += 1;
    this.deliveredBytes += transfer.bytes;
    this.notifySettled(transfer);
  }

  private expireTransfer(transfer: CartTransfer, atUs: number): void {
    this.nowUs = atUs;
    if (transfer.status === 'in-flight') {
      this.cancelTransfer(transfer, 'deadline', atUs);
    }
  }

  /** Cancels a logical delivery; already serialized bytes stay counted. */
  cancelTransfer(transfer: CartTransfer, reason: CartCancelReason, atUs = this.nowUs): boolean {
    if (transfer.status !== 'in-flight') {
      return false;
    }
    transfer.status = 'cancelled';
    transfer.cancelReason = reason;
    transfer.cancelledAtUs = atUs;
    this.cancelledTransfers += 1;
    this.cancelledBytes += transfer.bytes;

    for (const stage of transfer.stages) {
      if (stage.state === 'waiting') {
        const link = this.linkState(stage.link);
        const queuedIndex = link.queue.findIndex((job) => job.stage === stage);
        if (queuedIndex >= 0) {
          link.queue.splice(queuedIndex, 1);
          link.waitingBytes -= stage.bytes;
        }
        stage.state = 'cancelled';
        continue;
      }
      if (stage.state === 'serializing') {
        const link = this.linkState(stage.link);
        const elapsedUs = Math.max(0, atUs - (stage.startedUs ?? atUs));
        const bitsSerialized = (elapsedUs * link.link.bitsPerSecond) / 1_000_000;
        const bytesSerialized = Math.min(
          stage.bytes,
          Math.floor(bitsSerialized / 8),
        );
        stage.serializedBytes = bytesSerialized;
        stage.state = 'cancelled';
        link.serializedBytes += bytesSerialized;
        this.totalSerializedBytes += bytesSerialized;
        transfer.serializedBytes += bytesSerialized;
        if (link.link.kind === 'wan') {
          transfer.billedWanBytes += bytesSerialized;
          this.wanBillableBytes += bytesSerialized;
        }
        const job = link.inFlight;
        if (job !== null && job.stage === stage) {
          job.handle?.cancel();
          link.inFlight = null;
          link.inFlightStartedUs = 0;
          link.inFlightDurationUs = 0;
          this.pump(link, atUs);
        }
        continue;
      }
      if (stage.state === 'pending') {
        stage.state = 'cancelled';
      }
    }
    this.notifySettled(transfer);
    return true;
  }

  /**
   * Marks one WAN direction (or both) blocked/unblocked at `atUs`. A block
   * cancels every logical delivery that still needs the link; serialized WAN
   * bytes remain billable. Restoration resumes queued work at its arrival.
   */
  setWanBlocked(
    a: CartRegion,
    b: CartRegion,
    direction: 'forward' | 'reverse' | 'both',
    blocked: boolean,
    atUs = this.nowUs,
  ): void {
    const pair = cartRegionPairKey(a, b);
    const directions: readonly ('forward' | 'reverse')[] =
      direction === 'both' ? ['forward', 'reverse'] : [direction];
    const apply = (): void => {
      this.nowUs = atUs;
      for (const dir of directions) {
        const mbps = this.topology.circuits.get(pair);
        if (mbps === undefined) {
          continue;
        }
        const id = cartWanLinkId(pair, dir);
        const existing = this.linkState({
          id,
          kind: 'wan',
          bitsPerSecond: mbps * 1_000_000,
          waitingByteLimit: CART_WAN_WAITING_BYTE_LIMIT,
          pair,
          direction: dir,
        });
        existing.blocked = blocked;
        if (blocked) {
          for (const transfer of [...this.transfers]) {
            if (
              transfer.status === 'in-flight' &&
              transfer.stages.some((stage) => stage.link.id === id)
            ) {
              this.cancelTransfer(transfer, 'link-failure', atUs);
            }
          }
        } else {
          this.pump(existing, atUs);
        }
      }
    };
    if (atUs <= this.nowUs) {
      apply();
      return;
    }
    this.scheduler.schedule(atUs / 1000, apply, CART_EVENT_PRIORITY.fault);
  }

  /** Blocks every WAN direction incident to `region` (partition fixture). */
  setRegionPartitioned(region: CartRegion, blocked: boolean, atUs = this.nowUs): void {
    for (const other of Object.keys(CART_REGION_INFO) as CartRegion[]) {
      if (other !== region) {
        this.setWanBlocked(region, other, 'both', blocked, atUs);
      }
    }
  }

  getTransfer(logicalId: string): CartTransfer | undefined {
    return this.transfers.find((transfer) => transfer.logicalId === logicalId);
  }

  get transfersSnapshot(): readonly CartTransfer[] {
    return this.transfers;
  }

  /** Busy time and FIFO waits per physical link that carried at least one job. */
  get linkLoads(): readonly CartLinkLoad[] {
    return [...this.links.values()]
      .filter((state) => state.loadJobs > 0)
      .map((state) => ({
        id: state.link.id,
        kind: state.link.kind,
        pair: state.link.pair ?? null,
        direction: state.link.direction,
        bitsPerSecond: state.link.bitsPerSecond,
        jobs: state.loadJobs,
        busyUs: state.loadBusyUs,
        waitTotalUs: state.loadWaitTotalUs,
        waitMaxUs: state.loadWaitMaxUs,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get linkSnapshots(): readonly CartLinkSnapshot[] {
    return [...this.links.values()].map((state) => ({
      id: state.link.id,
      kind: state.link.kind,
      bitsPerSecond: state.link.bitsPerSecond,
      waitingByteLimit: state.link.waitingByteLimit,
      waitingBytes: state.waitingBytes,
      serializedBytes: state.serializedBytes,
      inFlightBytes: state.inFlight?.stage.bytes ?? 0,
      blocked: state.blocked,
    }));
  }

  get counters(): CartNetworkCounters {
    return {
      offeredTransfers: this.offeredTransfers,
      deliveredTransfers: this.deliveredTransfers,
      cancelledTransfers: this.cancelledTransfers,
      rejectedTransfers: this.rejectedTransfers,
      offeredBytes: this.offeredBytes,
      deliveredBytes: this.deliveredBytes,
      cancelledBytes: this.cancelledBytes,
      serializedBytes: this.totalSerializedBytes,
      wanBillableBytes: this.wanBillableBytes,
      wanBillableGib: this.wanBillableBytes / CART_GIB_BYTES,
      wanCostCredits: (this.wanBillableBytes / CART_GIB_BYTES) * CART_WAN_CREDITS_PER_GIB,
      localSerializedBytes: this.totalSerializedBytes - this.wanBillableBytes,
    };
  }

  /**
   * Conservation check: physical serialized counters equal the sum of every
   * transfer stage, and each link's waiting counter equals the bytes actually
   * queued behind its serializer. Returns explicit mismatches instead of
   * throwing.
   */
  checkCapacityConservation(): { ok: boolean; issues: string[] } {
    const issues: string[] = [];
    let stageTotal = 0;
    for (const transfer of this.transfers) {
      for (const stage of transfer.stages) {
        stageTotal += stage.serializedBytes;
      }
    }

    const queuedStages = new Set<CartTransferStage>();
    let linkTotal = 0;
    for (const state of this.links.values()) {
      let queuedBytes = 0;
      for (const job of state.queue) {
        queuedBytes += job.stage.bytes;
        if (job.stage.state !== 'waiting') {
          issues.push(`link ${state.link.id} queues a non-waiting job`);
        }
        if (job.stage.link.id !== state.link.id) {
          issues.push(`link ${state.link.id} queues a job for ${job.stage.link.id}`);
        }
        if (queuedStages.has(job.stage)) {
          issues.push(`stage queued more than once at ${state.link.id}`);
        }
        queuedStages.add(job.stage);
      }
      linkTotal += state.serializedBytes;
      if (state.waitingBytes !== queuedBytes) {
        issues.push(
          `link ${state.link.id} waiting bytes ${state.waitingBytes} differ from queued ${queuedBytes}`,
        );
      }
      if (state.waitingBytes < 0) {
        issues.push(`link ${state.link.id} has negative waiting bytes`);
      }
      if (state.waitingBytes > state.link.waitingByteLimit) {
        issues.push(`link ${state.link.id} exceeds its waiting-byte limit`);
      }
      const inFlight = state.inFlight;
      if (inFlight !== null && inFlight.stage.state !== 'serializing') {
        issues.push(`link ${state.link.id} holds a non-serializing job`);
      }
    }
    for (const transfer of this.transfers) {
      for (const stage of transfer.stages) {
        if (stage.state === 'waiting' && !queuedStages.has(stage)) {
          issues.push(`stage at ${stage.link.id} is marked waiting but not queued`);
        }
        if (stage.state !== 'waiting' && queuedStages.has(stage)) {
          issues.push(`stage at ${stage.link.id} is queued while ${stage.state}`);
        }
      }
    }
    if (stageTotal !== this.totalSerializedBytes) {
      issues.push(
        `stage serialized bytes ${stageTotal} differ from counter ${this.totalSerializedBytes}`,
      );
    }
    if (linkTotal !== this.totalSerializedBytes) {
      issues.push(`link serialized bytes ${linkTotal} differ from counter ${this.totalSerializedBytes}`);
    }
    return { ok: issues.length === 0, issues };
  }
}
