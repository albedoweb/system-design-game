/**
 * Deterministic cart execution model (cart-protocol-v1, GC-011).
 *
 * The evaluator drives the *accepted* cart engines rather than a private
 * simulator:
 * - `CartNetworkModel` plans and bills every physical transfer (including WAN
 *   bytes serialized before a partition cancels a delivery);
 * - `CartReadEngine` computes complete/partial/unavailable reads, certificate
 *   coverage, repair and freshness from real authority ledgers;
 * - `CartInventory` performs Lookup/Commit with real bindings, evidence and
 *   atomic stock effects.
 *
 * The workload and mandatory fixtures are offered by their frozen times; a
 * failed prerequisite is recorded as a failed descendant, never removed.
 */
import {
  CART_REGIONS,
  sha256Hex,
  type CartApplicationNode,
  type CartCaseId,
  type CartGraph,
  type CartNode,
  type CartRegion,
} from '../contracts';
import type { CartOperationIntent } from './workload';
import type { CartProbe, CartProbeStep } from './challenges';
import { declaredCheckoutStock } from './challenges';
import {
  CartNetworkModel,
  createCartTopology,
  type CartEndpoint,
  type CartTopology,
  type CartTransfer,
  type CartLinkLoad,
} from './network';
import { CartReplicationEngine, CART_REPLICATION_POLL_US, CART_REPLICATION_RETRY_US, CART_REPLICATION_BATCH_OVERHEAD_BYTES, type CartReplicationDelivery } from './replication';
import { CART_DURABLE_FLUSH_US, CartResourceLedger, createCartResourcePlan } from './resources';
import { CartServiceQueues, type CartCpuWindow, type CartNodeLoad } from './service-queues';
import { EventScheduler } from '../../simulation/resources/scheduler';
import { carryCartCertificate, cartCertificateBytes, type CartCertificate, type CartReplicatedCertificate, type CartDurableCommit, CART_READ_ATTEMPT_CPU_MS, CartOriginCommitLedger } from './tokens';
import { CART_SESSION_TOKEN_VERSION, CART_ACK_BASE_BYTES, CartDurableStore } from './durable-store';
import {
  CartReadEngine,
  type CartReadComplete,
  type CartReadExchange,
  type CartReadNode,
  type CartReadOutcome,
  type CartReadProtocol,
} from './reads';
import {
  CartInventory,
  CART_INVENTORY_LOOKUP_CPU_MS,
  CART_INVENTORY_LOOKUP_IO_UNITS,
  CART_INVENTORY_ORDER_INDEX_BYTES,
  CART_INVENTORY_SKU_INDEX_BYTES,
  type CartInventoryOptions,
  cartCheckoutLinesFromView,
  cartCheckoutReadFromView,
  createCartCheckoutBinding,
  createCartCheckoutEvidence,
  type CartBasketLine,
  type CartCheckoutBinding,
  type CartCheckoutEvidence,
  type CartInventoryOutcome,
  type CartInventoryOrder,
  type CartInventoryLedgerRow,
  type CartInventoryResult,
} from './inventory';
import {
  cartOperationFingerprint,
  cartOperationId,
  type CartEditKind,
  type CartOperationEnvelope,
  type CartOperationKey,
} from './operations';
import { acceptCartOperation, createCartOperationLog, materializeCartView } from './cart-state';
import { CartVolatileCache, type CartVolatileCacheSnapshot } from './cache';

/** Measured window, incident and eligibility boundaries (frozen). */
export const CART_CASE_MEASURED_US = 90_000_000;
export const CART_INCIDENT_START_US = 30_000_000;
export const CART_INCIDENT_END_US = 50_000_000;
export const CART_ELIGIBILITY_END_US = 55_000_000;
export const CART_FOREGROUND_DEADLINE_US = 1_000_000;
export const CART_FRESHNESS_US = 2_000_000;
export const CART_DRAIN_LIMIT_US = 10_000_000;
/** CONTRACT B5: maximum charged preparation window before measured traffic. */
export const CART_PREPARATION_LIMIT_US = 5_000_000;
export const CART_RECOVERY_OFFER_US = 54_000_000;
/** Frozen volatile-cache transition: every cart cache clears at 40 s. */
export const CART_CACHE_CLEAR_US = 40_000_000;

/** One client retry after a transport loss, 25 ms backoff, same absolute deadline. */
export const CART_CHECKOUT_RETRY_BACKOFF_US = 25_000;

/** Checkout wire sizes (bytes): request carries binding, reply carries result. */
export const CART_CHECKOUT_INGRESS_BYTES = 512;
export const CART_CHECKOUT_LOOKUP_REQUEST_BYTES = 256;
export const CART_CHECKOUT_COMMIT_REQUEST_BYTES = 512;
export const CART_CHECKOUT_REPLY_BYTES = 128;
export const CART_CHECKOUT_LINE_BYTES = 32;
export const CART_CHECKOUT_COVERED_ID_BYTES = 32;

/** One route a request actually needs to reach its required dependency. */
export interface CartCohortRequirement {
  readonly from: CartRegion;
  readonly to: CartRegion;
}

export interface CartCohortClassificationInput {
  readonly offerUs: number;
  readonly required: readonly CartCohortRequirement[];
  /** Route reachable on the fully enabled submitted topology. */
  readonly reachableEnabled: (requirement: CartCohortRequirement) => boolean;
  /** Route reachable at a modeled instant, with the incident applied. */
  readonly reachableAt: (requirement: CartCohortRequirement, atUs: number) => boolean;
}

/**
 * B3 cohort classification from actual required dependencies and allowed
 * routes. The frozen boundaries decide eligibility, but the exemption itself is
 * earned only by a dependency route that the incident actually removes:
 *
 * - a dependency that is unreachable even on the enabled graph is unhealthy
 *   topology and NEVER exempt (it must fail the normal gates);
 * - offers before 30s and from 55s on keep normal healthy gates;
 * - offers in [30s,50s) are `incident-affected` only when a required route is
 *   blocked at the offer instant (boundary ties included);
 * - offers in [50s,55s) are `incident-backlog` only when a required route was
 *   blocked during the incident, so an unrelated post-restoration queue delay
 *   cannot gain exemption.
 */
export function classifyCartCohort(input: CartCohortClassificationInput): CartRequestCohort {
  const { offerUs, required } = input;
  if (required.length === 0) return 'healthy';
  if (required.some((requirement) => !input.reachableEnabled(requirement))) return 'healthy';
  if (offerUs < CART_INCIDENT_START_US || offerUs >= CART_ELIGIBILITY_END_US) return 'healthy';
  if (offerUs < CART_INCIDENT_END_US) {
    return required.some((requirement) => !input.reachableAt(requirement, offerUs))
      ? 'incident-affected'
      : 'healthy';
  }
  return required.some((requirement) => !input.reachableAt(requirement, CART_INCIDENT_START_US))
    ? 'incident-backlog'
    : 'healthy';
}

export type CartRequestClass = 'edit' | 'read' | 'checkout' | 'probe' | 'audit';

/** Declared partition cohort for one offered request. */
export type CartRequestCohort =
  | 'healthy'
  | 'local-context-edit'
  | 'incident-affected'
  | 'incident-backlog'
  | 'dedicated-probe';

export type CartRequestOutcome =
  | 'committed'
  | 'duplicate-commit'
  | 'conflict'
  | 'rejected'
  | 'unavailable'
  | 'out-of-stock'
  | 'selection-changed'
  | 'validation-failed'
  | 'dependency-failed'
  | 'timeout';

export interface CartRequestRecord {
  readonly id: string;
  readonly caseId: CartCaseId;
  readonly cartId: string;
  readonly region: CartRegion;
  readonly operation: CartRequestClass;
  readonly cohort: CartRequestCohort;
  readonly offeredUs: number;
  readonly deadlineUs: number;
  /** Delivery time when the modeled client received a terminal reply. */
  readonly deliveredUs: number | null;
  readonly outcome: CartRequestOutcome;
  /** Durable commit actually happened at the configured origin authority. */
  readonly committed: boolean;
  /** Terminal reply reached the client (ACK / view / checkout answer). */
  readonly acknowledged: boolean;
  /** Offer was issued but no terminal reply was delivered by its deadline. */
  readonly unresolved: boolean;
  /** Attempt was explicitly rejected before any mutation. */
  readonly rejected: boolean;
  /** Required dependency unavailable at offer (recorded, never rescheduled). */
  readonly dependencyFailed: boolean;
  /** True only for declared incident cohorts in [30s,55s). */
  readonly exempt: boolean;
  readonly deliveryUs: number | null;
  readonly evidenceIds: readonly string[];
}

export interface CartTopologyFacts {
  readonly qualified: boolean;
  readonly authorityByRegion: Readonly<Record<CartRegion, string | null>>;
  readonly durableByRegion: Readonly<Record<CartRegion, string | null>>;
  readonly inventoryNodeId: string | null;
  readonly inventoryRegion: CartRegion | null;
  /** Directed request/replication region pairs available in the enabled graph. */
  readonly regionLinks: readonly (readonly [CartRegion, CartRegion])[];
  readonly issues: readonly string[];
}

const DURABLE_WRITE_KINDS: ReadonlySet<CartNode['kind']> = new Set(['journal', 'store']);

/**
 * Directed node-level adjacency of *drawn request* edges only. Replication
 * edges never appear here, so a replication-only path can never be mistaken
 * for a route that may carry a request RPC. This mirrors the semantic
 * validation in `graph.ts` (`reachableByRequest`).
 */
function requestPathAdjacency(graph: CartGraph): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) adjacency.set(node.id, []);
  for (const edge of graph.edges) {
    if (edge.kind !== 'request') continue;
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from)?.push(edge.to);
  }
  return adjacency;
}

/** Reachable through one or more drawn directed request edges. */
function reachableByRequestPath(
  adjacency: ReadonlyMap<string, readonly string[]>,
  from: string,
  target: string,
): boolean {
  if (from === target) return false;
  const seen = new Set<string>([from]);
  const queue = [...(adjacency.get(from) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (next === target) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(adjacency.get(next) ?? []));
  }
  return false;
}

/** Deterministic Application lookup: one Application per region, id ordered. */
function applicationNodes(graph: CartGraph): CartApplicationNode[] {
  return graph.nodes
    .filter((node): node is CartApplicationNode => node.kind === 'application')
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function isEmptyRegionRecord(): Record<CartRegion, string | null> {
  return { 'us-west': null, 'eu-central': null, 'ap-northeast': null };
}

/**
 * Derives the executed topology: authorities, durable nodes, region links.
 *
 * The write authority of a region is the durable journal/store that each
 * Application *configured* as `writeTarget` and can reach over drawn request
 * edges. Graph node order is never used to choose an authority: a missing,
 * unusable or replication-only `writeTarget` leaves the region unconfigured
 * and reports an explicit issue, so the model fails rather than substituting
 * an arbitrary durable node.
 */
export function analyzeCartTopology(graph: CartGraph): CartTopologyFacts {
  const authorityByRegion = isEmptyRegionRecord();
  const durableByRegion = isEmptyRegionRecord();
  const issues: string[] = [];
  const regionLinks: [CartRegion, CartRegion][] = [];
  let inventoryNodeId: string | null = null;
  let inventoryRegion: CartRegion | null = null;

  const nodeRegion = new Map<string, CartRegion>();
  const nodeById = new Map<string, CartNode>();
  for (const node of graph.nodes) {
    nodeRegion.set(node.id, node.region);
    nodeById.set(node.id, node);
    if (node.kind === 'inventory') {
      inventoryNodeId = node.id;
      inventoryRegion = node.region;
    }
  }

  const adjacency = requestPathAdjacency(graph);
  for (const application of applicationNodes(graph)) {
    const configured = application.writeTarget;
    const target = configured.length > 0 ? nodeById.get(configured) : undefined;
    if (target === undefined || !DURABLE_WRITE_KINDS.has(target.kind)) continue;
    if (!reachableByRequestPath(adjacency, application.id, target.id)) continue;
    const region = application.region;
    if (authorityByRegion[region] === null) {
      authorityByRegion[region] = target.id;
      durableByRegion[region] = target.id;
    } else if (authorityByRegion[region] !== target.id) {
      issues.push(`conflicting-write-authority:${region}`);
    }
  }
  for (const region of CART_REGIONS) {
    if (authorityByRegion[region] === null) issues.push(`missing-write-authority:${region}`);
    if (durableByRegion[region] === null) issues.push(`missing-durable-service:${region}`);
  }
  if (inventoryNodeId === null) issues.push('missing-inventory');

  // Coarse, region-level availability of drawn paths. It answers "which
  // regions are currently connected" for incident cohort classification; it is
  // never used to authorize a request (see `reachableByRequestPath`).
  for (const edge of graph.edges) {
    const from = nodeRegion.get(edge.from);
    const to = nodeRegion.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const duplicate = regionLinks.some(([a, b]) => a === from && b === to);
    if (!duplicate) regionLinks.push([from, to]);
  }

  return {
    qualified: issues.length === 0,
    authorityByRegion,
    durableByRegion,
    inventoryNodeId,
    inventoryRegion,
    regionLinks,
    issues,
  };
}

export interface CartCaseModelOptions {
  /** Optional registered engines for focused capacity tests and downstream replication. */
  readonly durableStores?: readonly CartDurableStore[];
  /** Focused engine admission/commit observation seam; production uses table capacity and frozen stock. */
  readonly inventoryOptions?: Partial<Pick<CartInventoryOptions, 'durableCapacityBytes' | 'onCommit' | 'initialStock'>>;
  readonly measuredUs?: number;
  /**
   * Fault-free scenario (basic level): no Tokyo partition/restoration and no
   * cache clear. Offered traffic, latency limits and safety audits are unchanged.
   */
  readonly faultFree?: boolean;
  readonly drainUs?: number;
  readonly runtimeBudgetMs?: number;
  readonly now?: () => number;
  /** Physical replication ACK loss: bytes are billed before the ACK is discarded. */
  readonly replicationFaults?: { readonly discardFirstAck?: boolean };
  /**
   * Scoped protocol fault injection used by the frozen lost-reply fixture
   * (`fixtures.json` checkout `lost-reply`): the first post-commit reply is
   * traversed and billed normally, then discarded before it can be observed.
   * This is a transport fault, never an Inventory shortcut.
   */
  readonly checkoutFaults?: {
    readonly discardFirstCommitReply?: boolean;
  };
}

interface ReadSlot {
  readonly complete: CartReadComplete;
  readonly deliveryUs: number;
}

interface CartState {
  tokens: string[];
  readIds: string[];
  lastReadId: string | null;
}

/** One executed unit of work, either a scheduled intent or a probe step. */
interface WorkItem {
  readonly atUs: number;
  readonly id: string;
  readonly intent: CartOperationIntent | null;
  readonly step: CartProbeStep | null;
  readonly probe: CartProbe | null;
  /**
   * ACK-relative probe step: `true` for the frozen missing-ACK fallback item
   * queued at the declared fallback time; dynamic ACK-triggered items carry
   * `false`/absent and an already resolved step.
   */
  readonly fallback?: boolean;
}

/**
 * One protocol continuation the event loop must run at a real completion time.
 * Continuations are queued from the network settlement callback and executed
 * only outside scheduler dispatch.
 */
interface Continuation {
  readonly atUs: number;
  readonly seq: number;
  readonly run: () => void;
}

/** Mutable per-request state of the completion-driven edit protocol. */
interface EditProtocol {
  /** Terminal record id: either the intent id or the probe step id. */
  readonly id: string;
  /** Scheduled edit intent, when this protocol carries ordinary workload. */
  readonly intent: CartOperationIntent | null;
  /** Probe whose fixture preparation this protocol executes, if any. */
  readonly probe: CartProbe | null;
  /** Frozen probe step whose id/time the record keeps, if this is a probe. */
  readonly step: CartProbeStep | null;
  readonly cartId: string;
  readonly key: CartOperationKey;
  readonly origin: CartRegion;
  readonly clientId: string;
  readonly offeredUs: number;
  readonly deadlineUs: number;
  readonly cohort: CartRequestCohort;
  readonly exempt: boolean;
  readonly app: string;
  readonly appInstance: number;
  readonly authority: string;
  readonly opId: string;
  readonly envelope: CartOperationEnvelope;
  readonly logicalIds: Set<string>;
  committed: boolean;
  ackBytes?: number;
  acknowledged: boolean;
  settled: boolean;
}

/** Mutable per-request state of one read executed on the shared scheduler. */
interface ReadTransport {
  readonly id: string;
  readonly offeredUs: number;
  readonly deadlineUs: number;
  readonly cohort: CartRequestCohort;
  readonly exempt: boolean;
  readonly app: string;
  readonly appInstance: number;
  readonly servedBy: CartRegion;
  readonly client: CartEndpoint;
  readonly protocol: CartReadProtocol;
  readonly intent: CartOperationIntent | null;
  readonly probe: CartProbe | null;
  readonly step: CartProbeStep | null;
  readonly logicalIds: Set<string>;
  settled: boolean;
}

/**
 * Mutable per-request state of the completion-driven checkout protocol:
 * client → Application → Inventory Lookup request/response → (on miss only)
 * Commit request/service/response → Application → client. Inventory owns the
 * atomic transaction and the durable idempotency row; this transport only
 * decides when each real exchange is allowed to run.
 */
interface CheckoutTransport {
  readonly id: string;
  readonly intent: CartOperationIntent | null;
  readonly probe: CartProbe | null;
  readonly step: CartProbeStep | null;
  readonly offeredUs: number;
  readonly deadlineUs: number;
  readonly cohort: CartRequestCohort;
  readonly exempt: boolean;
  readonly app: string;
  readonly appInstance: number;
  readonly inventoryNodeId: string;
  readonly client: CartEndpoint;
  readonly binding: CartCheckoutBinding;
  readonly lines: readonly CartBasketLine[];
  readonly selection: ReadSlot;
  readonly selectionId: string;
  readonly logicalIds: Set<string>;
  attempt: number;
  retried: boolean;
  committed: boolean;
  lastResult: CartInventoryResult | null;
  settled: boolean;
}

/**
 * The checkout state needed to answer the client without a purchase. A
 * selection that never delivered has no basket binding, but an incident-
 * affected request must still receive an explicit TemporarilyUnavailable
 * terminal response over its real reply path.
 */
type CheckoutReplyContext = Pick<
  CheckoutTransport,
  | 'id'
  | 'intent'
  | 'probe'
  | 'step'
  | 'offeredUs'
  | 'deadlineUs'
  | 'cohort'
  | 'app'
  | 'appInstance'
  | 'client'
  | 'attempt'
  | 'logicalIds'
> & { settled: boolean };

/**
 * One deterministic case execution. All request outcomes come from the shared
 * network/read/inventory engines; this class only schedules offers and records
 * the auditable per-request facts.
 */
export class CartCaseModel {
  readonly caseId: CartCaseId;
  readonly facts: CartTopologyFacts;
  private readonly options: CartCaseModelOptions;
  private readonly topology: CartTopology;
  private readonly network: CartNetworkModel;
  /** Directed node-level request routes; replication edges are excluded. */
  private readonly requestPaths: ReadonlyMap<string, readonly string[]>;
  private readonly cpu: CartServiceQueues;
  /** Single ledger for bounded pending work and bounded working memory. */
  private readonly resources: CartResourceLedger;
  private readonly ledgers = new Map<CartRegion, CartOriginCommitLedger>();
  private readonly authorities: Record<CartRegion, string> = {
    'us-west': '',
    'eu-central': '',
    'ap-northeast': '',
  };
  private readonly replication: CartReplicationEngine;
  private readonly replicationEdges: readonly {id: string; from: string; to: string}[];
  private readonly certificates = new Map<string, Map<string, CartReplicatedCertificate>>();
  private readonly certificateOutbox = new Map<string, {edge: {id: string; from: string; to: string}; certificate: CartCertificate; nextUs: number; active: boolean}>();
  private certificateAttempt = 0;
  private issuingCertificates: {nodeId: string; certificate: CartCertificate}[] | null = null;
  private replicationWakeAtUs = Infinity;
  private replicationWakeVersion = 0;
  private replicationAckDiscarded = false;
  private readonly durableStores = new Map<string, CartDurableStore>();
  /**
   * Configured volatile cart caches of this graph, one per cache node. They are
   * created here and only here; a read may use one solely through the
   * `CartReadNode.cache` seam, and nothing in this model ever reads durable
   * state out of a cache.
   */
  private readonly caches = new Map<string, CartVolatileCache>();
  /** Set once the frozen 40 s cache transition has been applied. */
  private cacheClearDone = false;
  private get isFaultFree(): boolean {
    return this.options.faultFree === true;
  }
  private readonly opIdByIntent = new Map<string, string>();
  private readonly originOfOp = new Map<string, CartRegion>();
  private readonly carts = new Map<string, CartState>();
  private readonly reads = new Map<string, ReadSlot>();
  private readonly records: CartRequestRecord[] = [];
  private readonly recorded = new Map<string, CartRequestRecord>();
  private readonly work: WorkItem[] = [];
  private readonly inventory: CartInventory | null;
  private workIndex = 0;
  /** ACK-relative step ids whose trigger already fired (ACK or fallback). */
  private readonly ackTriggered = new Set<string>();
  /** Set when an actual ACK inserted work; the event loop must re-pick its head. */
  private workDirty = false;
  private executingWork = false;
  private probeIssued = new Set<string>();
  /** Cohort computed from a probe step's actual dependencies and allowed routes. */
  private readonly probeCohorts = new Map<string, CartRequestCohort>();
  private recoveryDone = false;
  private eventCount = 0;
  private overResourceLimit = false;
  /** Shared chronological clock: network events plus protocol continuations. */
  private readonly scheduler = new EventScheduler();
  private readonly continuations: Continuation[] = [];
  private continuationSeq = 0;
  /** logicalId → settlement handler for the completion-driven edit protocol. */
  private readonly settleHandlers = new Map<string, (transfer: CartTransfer) => void>();
  /** Edit protocols that have not produced a terminal record yet. */
  private readonly openEdits = new Map<string, EditProtocol>();
  /** Reads whose request/service/response chain has not completed yet. */
  private readonly openReads = new Map<string, ReadTransport>();
  /** Checkouts whose Lookup/Commit exchange chain has not completed yet. */
  private readonly openCheckouts = new Map<string, CheckoutTransport>();
  private readonly checkoutFaults: NonNullable<CartCaseModelOptions['checkoutFaults']>;
  private checkoutReplyDiscarded = false;
  /** Step ids that prepare a later fixture step through charged graph writes/reads. */
  private readonly preparationStepIds = new Set<string>();
  /** Longest actual charged setup lead observed for a fixture (bounded by B5). */
  private preparationLeadUs = 0;
  /** Latest instant at which scheduled physical or protocol work actually ran. */
  private lastActivityUs = 0;
  /** Latest instant at which a physical transfer reached a terminal state. */
  private lastSettledUs = 0;

  constructor(
    caseId: CartCaseId,
    facts: CartTopologyFacts,
    intents: readonly CartOperationIntent[],
    probes: readonly CartProbe[],
    graph: CartGraph,
    options: CartCaseModelOptions = {},
  ) {
    this.caseId = caseId;
    this.facts = facts;
    this.options = options;
    this.checkoutFaults = options.checkoutFaults ?? {};
    this.topology = createCartTopology(graph);
    const plan = createCartResourcePlan(graph);
    this.resources = new CartResourceLedger(plan);
    this.cpu = new CartServiceQueues(plan, { ledger: this.resources });
    this.requestPaths = requestPathAdjacency(graph);
    // A single scheduler owns network, service and protocol time. Settlement is
    // only a notification: it queues a continuation and never re-enters the
    // scheduler, so the loop below always drives physical events chronologically.
    this.network = new CartNetworkModel(this.topology, {
      scheduler: this.scheduler,
      onSettled: (transfer) => this.onTransferSettled(transfer),
    });

    const authorityIds: Partial<Record<CartRegion, string>> = {};
    for (const region of CART_REGIONS) {
      const nodeId = facts.authorityByRegion[region];
      if (nodeId !== null) {
        this.authorities[region] = nodeId;
        authorityIds[region] = nodeId;
      }
    }
    for (const region of CART_REGIONS) {
      const nodeId = facts.authorityByRegion[region];
      if (nodeId !== null) {
        this.ledgers.set(region, new CartOriginCommitLedger(nodeId, authorityIds));
      }
    }

    for (const node of graph.nodes) {
      if (node.kind !== 'journal' && node.kind !== 'store') continue;
      const registered = options.durableStores?.find(store => store.nodeId === node.id);
      this.durableStores.set(node.id, registered ?? new CartDurableStore({
        nodeId: node.id, kind: node.kind, size: node.size, writeAuthorities: authorityIds,
        replicationEdges: graph.edges.filter(edge => edge.kind === 'replication' && edge.from === node.id)
          .map(edge => ({ edgeId: edge.id, to: edge.to })),
      }));
    }

    this.replicationEdges = graph.edges.filter(e => e.kind === 'replication');
    this.replication = new CartReplicationEngine({
      edges: graph.edges.filter(e => e.kind === 'replication').map(e => ({edgeId: e.id, from: e.from, to: e.to})),
      dispatch: delivery => this.dispatchReplication(delivery),
    });
    for (const store of this.durableStores.values()) this.replication.registerNode(store);
    this.wakeReplication();

    // Stationary part of the frozen partition fixture: both Tokyo WAN pairs are
    // disabled in [30000,50000)ms and restored at 50000ms. The network model
    // cancels affected deliveries and keeps serialized prefixes billable.
    // Fault-free (basic) scenarios inject no incident event at all.
    if (options.faultFree === true) {
      this.cacheClearDone = true;
    } else {
      this.network.setRegionPartitioned('ap-northeast', true, CART_INCIDENT_START_US);
      this.network.setRegionPartitioned('ap-northeast', false, CART_INCIDENT_END_US);
    }

    // Configured volatile caches. A cache can only vouch for material of a
    // modeled origin authority, so instances exist only when every origin has
    // its configured write authority; capacity is the frozen S/M payload.
    if (CART_REGIONS.every((region) => this.authorities[region].length > 0)) {
      for (const node of graph.nodes) {
        if (node.kind !== 'cache') continue;
        this.caches.set(
          node.id,
          new CartVolatileCache({
            nodeId: node.id,
            region: node.region,
            size: node.size,
            authorities: this.authorities,
          }),
        );
      }
    }

    const stock: Record<string, number> = {};
    for (let sku = 0; sku < 100; sku += 1) stock[String(sku)] = 1_000_000;
    for (const intent of intents) {
      if (intent.effect.kind === 'add' || intent.effect.kind === 'change') {
        stock[String(intent.effect.sku % 100)] = 1_000_000;
      }
    }
    for (const probe of probes) {
      // CONTRACT B5: a fixture's declared stock is initial data, not a runtime
      // gift. Seed every probe SKU (explicit or derived) with the quantity the
      // frozen checkout fixture declares, so a known-stock probe can never be
      // answered with a fictitious OutOfStock.
      const declared = probe.steps.find((step) => typeof step.detail.knownStock === 'number');
      const knownStock = declared === undefined ? undefined : Number(declared.detail.knownStock);
      probe.steps.forEach((step, index) => {
        if (step.action !== 'add' && step.action !== 'edit') return;
        const explicit = step.detail.sku;
        const sku = typeof explicit === 'string' ? explicit : `probe-sku-${index}`;
        if (!/^[\x20-\x7e]{1,64}$/.test(sku)) return;
        if (knownStock !== undefined) {
          stock[sku] = Math.max(stock[sku] ?? 0, knownStock);
        } else {
          stock[sku] = stock[sku] ?? 1_000_000;
        }
      });
      // Frozen checkout fixtures declare their initial stock (race scarce=2,
      // known-stock 10, atomic scarce=1/abundant=10) for the probe's isolated
      // SKU. Install it exactly, once, before execution: the generic 1,000,000
      // default must not mask intended contention. No later reset exists.
      for (const [declaredSku, declaredQuantity] of Object.entries(declaredCheckoutStock(probe))) {
        if (/^[\x20-\x7e]{1,64}$/.test(declaredSku)) stock[declaredSku] = declaredQuantity;
      }
    }
    this.inventory =
      facts.inventoryNodeId !== null
        ? new CartInventory({
            ...options.inventoryOptions,
            nodeId: facts.inventoryNodeId,
            size: this.inventorySize(graph),
            initialStock: options.inventoryOptions?.initialStock ?? stock,
            originAuthorities: Object.fromEntries(this.ledgers),
          })
        : null;

    if (this.inventory !== null && facts.inventoryNodeId !== null) {
      // Inventory's own order/SKU index is standing working memory (its own
      // accounting): reserve it once so queue admission cannot over-commit.
      this.resources.reserveWorkingRam(facts.inventoryNodeId, this.inventory.ramIndexBytes);
    }

    for (const intent of intents) {
      this.work.push({ atUs: intent.atUs, id: intent.id, intent, step: null, probe: null });
    }
    for (const probe of probes) {
      for (const step of probe.steps) {
        if (step.trigger === 'ack-relative' && step.fallbackAtUs !== null) {
          // The offer time is the ACTUAL source ACK + delay, known only when
          // the edit settles. Only the frozen missing-ACK fallback is queued
          // up front; an ACK in time supersedes it (see scheduleAckRelative).
          this.work.push({ atUs: step.fallbackAtUs, id: step.id, intent: null, step, probe, fallback: true });
          continue;
        }
        this.work.push({ atUs: step.atUs, id: step.id, intent: null, step, probe });
      }
    }
    this.work.sort((left, right) =>
      left.atUs === right.atUs ? (left.id < right.id ? -1 : 1) : left.atUs - right.atUs,
    );

    // Charged fixture preparation: a step that a later step depends on is the
    // ordinary write/read that builds the nonempty fixture. Its lead over the
    // dependent trigger is the actual setup window, bounded by CONTRACT B5.
    for (const probe of probes) {
      for (const step of probe.steps) {
        if (step.dependsOn.length === 0) continue;
        let earliest = Number.POSITIVE_INFINITY;
        for (const depId of step.dependsOn) {
          const dep = probe.steps.find((candidate) => candidate.id === depId);
          if (dep === undefined) continue;
          if (dep.action !== 'add' && dep.action !== 'edit' && dep.action !== 'read') continue;
          this.preparationStepIds.add(dep.id);
          earliest = Math.min(earliest, dep.atUs);
        }
        if (Number.isFinite(earliest)) {
          this.preparationLeadUs = Math.max(this.preparationLeadUs, step.atUs - earliest);
        }
      }
    }
    this.preparationLeadUs = Math.max(this.preparationLeadUs, 0);
  }

  private inventorySize(graph: CartGraph): 'S' | 'M' {
    const node = graph.nodes.find((entry) => entry.kind === 'inventory');
    return node !== undefined && 'size' in node && node.size === 'S' ? 'S' : 'M';
  }

  get observedTimeUs(): number { return this.network.currentTimeUs; }
  nodeResources(nodeId: string) { return this.resources.snapshot(nodeId); }
  waitingTransactions(nodeId: string): number { return this.cpu.waitingTransactions(nodeId); }
  get launchedByOperation(): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (let index = 0; index < this.workIndex; index += 1) {
      const operation = this.work[index]?.intent?.operation;
      if (operation) counts[operation] = (counts[operation] ?? 0) + 1;
    }
    return counts;
  }

  get requestRecords(): readonly CartRequestRecord[] {
    return this.records;
  }

  get measuredEndUs(): number {
    return this.options.measuredUs ?? CART_CASE_MEASURED_US;
  }

  get drainEndUs(): number {
    return this.measuredEndUs + (this.options.drainUs ?? CART_DRAIN_LIMIT_US);
  }

  get exceededResourceLimit(): boolean {
    return this.overResourceLimit;
  }

  get events(): number {
    return this.eventCount;
  }

  /** Every actual WAN byte billed by the shared network layer. */
  get wanBillableBytes(): number {
    return this.network.counters.wanBillableBytes;
  }

  /** Actual charged setup window measured from fixture preparation to trigger. */
  get preparationUs(): number {
    return this.preparationLeadUs;
  }

  /**
   * WAN bytes actually serialized by charged fixture-preparation transfers.
   * Each physical byte is attributed to exactly one phase.
   */
  get wanPreparationBillableBytes(): number {
    if (this.preparationStepIds.size === 0) return 0;
    let total = 0;
    for (const transfer of this.network.transfersSnapshot) {
      for (const id of this.preparationStepIds) {
        if (transfer.logicalId.startsWith(`${id}:`)) {
          total += transfer.billedWanBytes;
          break;
        }
      }
    }
    return total;
  }

  /** WAN bytes serialized by work that only starts inside the drain window. */
  get wanDrainBillableBytes(): number {
    let total = 0;
    for (const transfer of this.network.transfersSnapshot) {
      if (transfer.enqueuedAtUs >= this.measuredEndUs) total += transfer.billedWanBytes;
    }
    return total;
  }

  /** Drain time measured to the final settled work, bounded by the drain cap. */
  get actualDrainUs(): number {
    const tail = this.lastSettledUs - this.measuredEndUs;
    return Math.min(Math.max(tail, 0), CART_DRAIN_LIMIT_US);
  }

  /** Physical transfers (requests, replies and retried attempts) actually offered. */
  get transferSnapshots(): readonly CartTransfer[] {
    return this.network.transfersSnapshot;
  }

  /** Inventory stock after execution (evidence for single-decrement checks). */
  get inventoryStock(): Readonly<Record<string, number>> {
    return this.inventory?.stockSnapshot() ?? {};
  }

  /** Inventory conservation (non-negative stock, remaining + ordered = initial); null without Inventory. */
  get inventoryConservation(): { readonly conserved: boolean; readonly violations: readonly string[] } | null {
    return this.inventory?.conservation() ?? null;
  }

  /** Durable Inventory orders; one entry per committed purchase. */
  get inventoryOrders(): readonly CartInventoryOrder[] {
    return this.inventory?.ordersSnapshot() ?? [];
  }

  /** Durable Inventory ledger rows, including OutOfStock terminal records. */
  get inventoryLedgerRows(): readonly CartInventoryLedgerRow[] {
    return this.inventory?.ledgerSnapshot() ?? [];
  }

  /**
   * Complete read results keyed by their read step id. Post-execution oracle
   * evidence only: this snapshot is never consulted by scheduling, reads or
   * checkout, so it cannot select a service path or change any response.
   */
  get readResults(): ReadonlyMap<string, CartReadComplete> {
    const results = new Map<string, CartReadComplete>();
    for (const [id, slot] of this.reads) results.set(id, slot.complete);
    return results;
  }

  /**
   * Volatile cache counters, one snapshot per configured cache node. Post-
    * execution observation only: it never feeds scheduling or reads, so an
    * auditor sees exactly the stores, hits, stale hits, evictions and clears the
    * model really performed.
    */
   get cacheSnapshots(): readonly CartVolatileCacheSnapshot[] {
     return [...this.caches.values()]
       .map((cache) => cache.snapshot())
       .sort((left, right) => (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0));
   }

   /** Materialized live quantity of one cart after execution. Rebuilds the view
   * from retained committed envelopes; it performs no writes and no service
   * calls, so the oracle observes state without injecting or advancing it.
   */
  cartLiveQuantity(cartId: string): number {
    let log = createCartOperationLog(cartId);
    const envelopes = this.cartEnvelopes(cartId);
    if (envelopes !== undefined) {
      for (const operationId of [...envelopes.keys()].sort()) {
        const envelope = envelopes.get(operationId);
        if (envelope !== undefined) log = acceptCartOperation(log, envelope).log;
      }
    }
    const view = materializeCartView(log);
    let quantity = 0;
    for (const state of Object.values(view.skus)) quantity += state.quantity;
    return quantity;
  }

  get chargedBusyUs(): number {
    return this.cpu.chargedBusyUs;
  }

  /** Live queued/in-flight service tasks retained across every node (leak probe). */
  get pendingServiceTasks(): number {
    return this.cpu.pendingTasks;
  }

  /** Observed busy time and FIFO waits of every physical link that carried traffic. */
  get linkLoads(): readonly CartLinkLoad[] {
    return this.network.linkLoads;
  }

  /** Observed CPU/IO busy time and queue waits of one node (read-only counters). */
  nodeLoad(nodeId: string): CartNodeLoad {
    return this.cpu.nodeLoad(nodeId);
  }

  /** Service windows refused because a node's pending/RAM bound was full. */
  get admissionRejections(): number {
    return this.cpu.admissionRejections;
  }

  /** Queue RAM currently charged by live service tasks across all nodes. */
  get queuedRamBytes(): number {
    return this.resources.totals().queueRamBytes;
  }

  /** Standing Inventory order/SKU index working memory reserved in the ledger. */
  get inventoryIndexRamBytes(): number {
    if (this.facts.inventoryNodeId === null) return 0;
    return this.resources.snapshot(this.facts.inventoryNodeId)?.indexRamBytes ?? 0;
  }

  get issuedCount(): number {
    return this.records.filter((record) => record.operation !== 'audit').length;
  }

  run(): void {
    while (!this.step(Number.POSITIVE_INFINITY)) {
      // step returns done
    }
  }

  /**
   * Processes at most `maxEvents` scheduled work items. Deterministic: the
   * session's advance() cadence can never change outcomes, only slice them.
   */
  step(maxEvents: number): boolean {
    const startWall = this.options.now?.() ?? 0;
    const budget = this.options.runtimeBudgetMs ?? Number.POSITIVE_INFINITY;
    let processed = 0;
    while (this.workIndex < this.work.length) {
      if (processed >= maxEvents) return false;
      if (this.options.now !== undefined && this.options.now() - startWall > budget) {
        this.overResourceLimit = true;
        return true;
      }
      const item = this.work[this.workIndex] as WorkItem;
      this.workDirty = false;
      this.advanceTo(item.atUs, true);
      if (this.workDirty) {
        // An actual ACK queued an earlier ACK-relative offer: re-pick the head.
        this.workDirty = false;
        continue;
      }
      this.executingWork = true;
      try {
        if (item.intent !== null) {
          this.executeIntent(item.intent);
        } else if (item.step !== null && item.probe !== null) {
          if (item.fallback === true) {
            this.executeAckFallback(item.probe, item.step);
          } else {
            this.executeProbeStep(item.probe, item.step);
          }
        }
      } finally {
        this.executingWork = false;
      }
      this.workIndex += 1;
      this.eventCount += 1;
      processed += 1;
    }
    if (!this.recoveryDone) {
      this.advanceTo(CART_RECOVERY_OFFER_US);
      // Fault-free scenarios have no incident to recover from: no recovery
      // cohort, no exempt backlog records and no recovery-barrier gate.
      if (!this.isFaultFree) this.runRecoveryBarrier();
      this.recoveryDone = true;
    }
    // Drain the physical layer to the end of the measured window so every
    // serialized prefix (including partition-cancelled ones) is billed and
    // every queued protocol continuation actually runs.
    this.advanceTo(this.measuredEndUs);
    this.finalizeOpenEdits();
    this.finalizeOpenReads();
    this.finalizeOpenCheckouts();
    // Bounded drain: pending serializations, retries and terminal deadline
    // cancellations keep running and stay charged after measured traffic stops,
    // up to the contracted drain cap. Client-visible outcomes were already
    // finalized above, so a late settlement can never resurrect success.
    this.advanceTo(this.drainEndUs);
    // Conservation: every admitted service that completed inside the drain
    // window leaves the pending ledger; anything still live is a real leak and
    // stays visible in `pendingServiceTasks` instead of being hidden.
    this.cpu.releaseCompletedAll(this.drainEndUs);
    return true;
  }

  /**
   * Reads still mid-protocol when the measured window closes never produced a
   * client delivery: they stay unresolved instead of being credited from a plan.
   */
  private finalizeOpenReads(): void {
    for (const transport of [...this.openReads.values()]) {
      if (transport.intent !== null) {
        this.record(transport.intent, transport.offeredUs, transport.deadlineUs, 'timeout', {
          cohort: transport.cohort,
        });
      } else if (transport.probe !== null && transport.step !== null) {
        this.recordProbe(transport.probe, transport.step, 'timeout', {});
      }
      this.abandonRead(transport);
    }
  }

  // -------------------------------------------------------------------------
  // Shared chronological event loop
  // -------------------------------------------------------------------------

  /**
   * Runs network events and protocol continuations in one chronological order.
   *
   * Network events at a timestamp are dispatched before continuations queued at
   * that same timestamp, so a continuation always observes the transport state
   * it was triggered by. Offers are admitted only by advancing to their own
   * timestamp, so no offer's future runs before an earlier or equal offer.
   */
  private advanceTo(targetUs: number, stopOnNewWork = false): void {
    // Protocol arithmetic can produce sub-microsecond targets; the scheduler
    // runs on integer microseconds, so round up to the next representable tick.
    const target = Math.max(Math.ceil(targetUs), this.network.currentTimeUs);
    let iterations = 0;
    for (;;) {
      iterations += 1;
      if (iterations > 4_000_000) {
        throw new Error('cart event loop did not converge');
      }
      // Frozen same-time order: the 40 s cache transition precedes every
      // completion, delivery or continuation at that instant, so a read whose
      // cache probe is due exactly at 40 s can never observe, reuse or
      // repopulate an entry the transition should already have removed. The
      // transition only empties volatile entries; durable stores are untouched.
      if (!this.cacheClearDone && this.network.currentTimeUs >= CART_CACHE_CLEAR_US) {
        this.cacheClearDone = true;
        for (const cache of this.caches.values()) cache.clear();
        continue;
      }
      const due = this.takeContinuation(this.network.currentTimeUs);
      if (due !== null) {
        due.run();
        this.lastActivityUs = Math.max(this.lastActivityUs, this.network.currentTimeUs);
        if (stopOnNewWork && this.workDirty) return;
        continue;
      }
      if (this.network.currentTimeUs >= target) {
        return;
      }
      const next = this.nextContinuationUs();
      let until = next === null ? target : Math.min(target, next);
      // Never step over the transition: the clock reaches it first, the clear
      // runs, and only then does later work observe the emptied cache.
      if (!this.cacheClearDone && until > CART_CACHE_CLEAR_US) until = CART_CACHE_CLEAR_US;
      // One physical event at a time: a settlement queued by this event must be
      // continued before the clock moves past it, so no event is skipped.
      const advanced = this.network.advanceOneEvent(until);
      if (advanced.processed) {
        this.lastActivityUs = Math.max(this.lastActivityUs, advanced.nowUs);
      }
    }
  }

  private scheduleContinuation(atUs: number, run: () => void): void {
    const at = Math.max(atUs, this.network.currentTimeUs);
    // Wake the shared scheduler as well: runUntil(maxEvents=1) can otherwise
    // jump to its horizon after a settlement queues the first continuation.
    // The no-op keeps the clock at settlement; effects still run outside dispatch.
    this.scheduler.schedule(at / 1_000, () => {});
    this.continuations.push({ atUs: at, seq: this.continuationSeq, run });
    this.continuationSeq += 1;
    this.continuations.sort((left, right) =>
      left.atUs === right.atUs ? left.seq - right.seq : left.atUs - right.atUs,
    );
  }

  private nextContinuationUs(): number | null {
    let earliest: number | null = null;
    for (const continuation of this.continuations) {
      if (earliest === null || continuation.atUs < earliest) earliest = continuation.atUs;
    }
    return earliest;
  }

  private takeContinuation(nowUs: number): Continuation | null {
    for (let index = 0; index < this.continuations.length; index += 1) {
      const candidate = this.continuations[index] as Continuation;
      if (candidate.atUs <= nowUs) {
        this.continuations.splice(index, 1);
        return candidate;
      }
    }
    return null;
  }

  /** Queue only certificates minted by a completed, charged Cover service. */
  private queueCertificate(nodeId: string, certificate: CartCertificate): void {
    for (const edge of this.replicationEdges) {
      if (edge.from !== nodeId) continue;
      const key = `${edge.id}:${certificate.cartId}:${certificate.origin}`;
      const previous = this.certificateOutbox.get(key);
      if (previous !== undefined && previous.certificate.cutUs >= certificate.cutUs) continue;
      this.certificateOutbox.set(key, {edge, certificate, nextUs: Math.ceil(this.network.currentTimeUs / CART_REPLICATION_POLL_US) * CART_REPLICATION_POLL_US, active: false});
    }
    this.wakeReplication();
  }

  private pumpCertificates(): void {
    for (const [key, item] of this.certificateOutbox) {
      if (item.active || item.nextUs > this.network.currentTimeUs) continue;
      item.active = true;
      const {edge, certificate} = item;
      const id = `replication:certificate:${this.certificateAttempt++}`;
      const finish = (ack: boolean, atUs: number) => {
        if (this.certificateOutbox.get(key) !== item) return;
        if (ack) this.certificateOutbox.delete(key);
        else { item.active = false; item.nextUs = atUs + CART_REPLICATION_RETRY_US; }
        this.wakeReplication();
      };
      this.backgroundTransfer(id, CART_REPLICATION_BATCH_OVERHEAD_BYTES + cartCertificateBytes(certificate), edge.from, edge.to, (arrived, atUs) => {
        if (!arrived) { finish(false, atUs); return; }
        const carry = carryCartCertificate(certificate, edge.to, atUs);
        if (carry !== undefined) {
          const held = this.certificates.get(edge.to) ?? new Map<string, CartReplicatedCertificate>();
          this.certificates.set(edge.to, held);
          const slot = `${certificate.cartId}:${certificate.origin}`;
          if ((held.get(slot)?.certificate.cutUs ?? -Infinity) < certificate.cutUs) {
            held.set(slot, carry);
            this.queueCertificate(edge.to, certificate);
          }
        }
        this.backgroundTransfer(`${id}:ack`, CART_ACK_BASE_BYTES, edge.to, edge.from, finish);
      });
    }
  }

  private wakeReplication(): void {
    let next = this.replication.nextAttemptAtUs ?? Infinity;
    for (const item of this.certificateOutbox.values()) if (!item.active) next = Math.min(next, item.nextUs);
    const at = Math.max(this.network.currentTimeUs, next);
    if (!Number.isFinite(at) || at > this.drainEndUs || this.replicationWakeAtUs <= at) return;
    const version = ++this.replicationWakeVersion;
    this.replicationWakeAtUs = at;
    this.scheduleContinuation(at, () => {
      if (version !== this.replicationWakeVersion) return;
      this.replicationWakeAtUs = Infinity;
      this.replication.advanceTo(this.network.currentTimeUs);
      this.pumpCertificates();
      this.wakeReplication();
    });
  }

  /** Background transfers use the same physical queues, faults and settlement as RPCs. */
  private backgroundTransfer(id: string, bytes: number, from: string, to: string,
    done: (arrived: boolean, atUs: number) => void): void {
    const atUs = this.network.currentTimeUs;
    this.settleHandlers.set(id, transfer => {
      const at = transfer.deliveredAtUs ?? transfer.cancelledAtUs ?? this.network.currentTimeUs;
      this.scheduleContinuation(at, () => done(transfer.deliveredAtUs !== null, at));
    });
    const result = this.network.submit({logicalId: id, bytes, from: {kind: 'node', nodeId: from},
      to: {kind: 'node', nodeId: to}, purpose: 'replication', deadlineUs: this.drainEndUs}, atUs);
    if (!result.ok) {
      this.settleHandlers.delete(id);
      this.scheduleContinuation(atUs, () => done(false, atUs));
    }
  }

  private dispatchReplication(delivery: CartReplicationDelivery): void {
    const id = `replication:${delivery.edgeId}:${delivery.attempt}`;
    const finish = (ack: boolean, atUs: number) => {
      this.replication.settleDelivery(delivery, ack, atUs);
      this.wakeReplication();
    };
    this.backgroundTransfer(id, delivery.bytes, delivery.from, delivery.to, (arrived, atUs) => {
      if (!arrived) { finish(false, atUs); return; }
      const source = this.durableStores.get(delivery.from)!;
      const target = this.durableStores.get(delivery.to);
      if (target === undefined) { finish(false, atUs); return; }
      const serviceNext = (index: number, readyUs: number): void => {
        const key = delivery.ids[index];
        if (key === undefined) {
          this.replication.notifyCommit(delivery.to, readyUs);
          this.wakeReplication();
          this.backgroundTransfer(`${id}:ack`, this.replication.acknowledgementBytes(delivery),
            delivery.to, delivery.from, (ack, ackUs) => {
              if (ack && this.options.replicationFaults?.discardFirstAck && !this.replicationAckDiscarded) {
                this.replicationAckDiscarded = true;
                ack = false;
              }
              finish(ack, ackUs);
            });
          return;
        }
        const demand = target.editCharge(source.envelopeFor(key)!);
        const fresh = target.envelopeFor(key) === undefined;
        const cpuDone = this.cpuAt(delivery.to, readyUs,
          Math.ceil(demand.cpuMilliseconds * 1_000), 1, delivery.bytes);
        // Refused target service cannot apply or acknowledge the batch. Keep
        // the source obligation for a real retry after bounded admission frees.
        if (cpuDone === null) { finish(false, readyUs); return; }
        this.scheduleContinuation(cpuDone, () => {
          const done = this.cpu.reserveIo(delivery.to, cpuDone, demand.ioUnits).doneUs + (fresh ? CART_DURABLE_FLUSH_US : 0);
          this.scheduleContinuation(done, () => {
            this.replication.receiveOperation(delivery, key, done);
            serviceNext(index + 1, done);
          });
        });
      };
      serviceNext(0, atUs);
    });
  }

  /** Network settlement callback: queue a continuation, never re-enter. */
  private onTransferSettled(transfer: CartTransfer): void {
    const settledUs = transfer.deliveredAtUs ?? transfer.cancelledAtUs ?? this.network.currentTimeUs;
    this.lastSettledUs = Math.max(this.lastSettledUs, settledUs);
    const handler = this.settleHandlers.get(transfer.logicalId);
    if (handler === undefined) return;
    this.settleHandlers.delete(transfer.logicalId);
    handler(transfer);
  }

  // -------------------------------------------------------------------------
  // Physical execution helpers
  // -------------------------------------------------------------------------

  private cpuAt(
    nodeId: string,
    atUs: number,
    durationUs: number,
    instance = 1,
    payloadBytes = 0,
  ): number | null {
    return this.cpuWindow(nodeId, atUs, durationUs, instance, payloadBytes)?.doneUs ?? null;
  }

  /**
   * The Application serving a region. Selection is by node id, never by graph
   * array order, so reordering identical nodes cannot change behavior. A
   * region with several Applications is already a validation error; the model
   * still picks deterministically instead of depending on document order.
   */
  private appNode(region: CartRegion): string | null {
    const candidates: string[] = [];
    for (const entry of this.topology.nodes.values()) {
      if (entry.kind === 'application' && entry.region === region) candidates.push(entry.id);
    }
    candidates.sort();
    return candidates[0] ?? null;
  }

  /** Only one or more drawn directed request edges may carry a request RPC. */
  private requestPathReachable(fromNodeId: string, toNodeId: string): boolean {
    return reachableByRequestPath(this.requestPaths, fromNodeId, toNodeId);
  }

  private clientEndpoint(region: CartRegion, clientId: string): CartEndpoint {
    return { kind: 'client', region, clientId };
  }

  /** Runs one node service window and reports its actual start and completion.
   * Returns `null` when the node's bounded pending/RAM admission is full; the
   * caller must reject the operation instead of queueing unbounded work.
   */
  private cpuWindow(
    nodeId: string,
    atUs: number,
    durationUs: number,
    instance = 1,
    payloadBytes = 0,
  ): CartCpuWindow | null {
    return this.cpu.reserve(nodeId, atUs, durationUs, instance, payloadBytes);
  }

  /**
   * Submits one read exchange (request or response) and routes its actual
   * settlement through the shared scheduler. Nothing is assumed: the delivered
   * time is the arrival the network really produced, and a cancelled transfer
   * settles as a lost exchange rather than an invented completion.
   */
  private submitReadTransfer(
    transport: ReadTransport,
    logicalId: string,
    bytes: number,
    from: CartEndpoint,
    to: CartEndpoint,
    purpose: 'request' | 'reply',
    atUs: number,
    onDelivered: (deliveredAtUs: number) => void,
    onLost: (transfer: CartTransfer) => void,
  ): boolean {
    const at = Math.max(Math.ceil(atUs), this.network.currentTimeUs);
    if (at > this.network.currentTimeUs) this.advanceTo(at);
    // Continuations run during the advance may have moved the clock past the
    // requested instant; offer at the real model time, never in the past. An
    // offer that lands after the deadline is not admissible: no bytes are
    // serialized and the exchange settles as lost through the caller's path.
    const submitAt = Math.max(at, this.network.currentTimeUs);
    if (submitAt > transport.deadlineUs) return false;
    const result = this.network.submit(
      { logicalId, bytes, from, to, purpose, deadlineUs: transport.deadlineUs },
      submitAt,
    );
    if (!result.ok) return false;
    transport.logicalIds.add(logicalId);
    this.settleHandlers.set(logicalId, (transfer) => {
      if (transfer.status === 'delivered' && transfer.deliveredAtUs !== null) {
        const deliveredAtUs = transfer.deliveredAtUs;
        this.scheduleContinuation(deliveredAtUs, () => onDelivered(deliveredAtUs));
        return;
      }
      const lostAtUs = transfer.cancelledAtUs ?? this.network.currentTimeUs;
      this.scheduleContinuation(lostAtUs, () => onLost(transfer));
    });
    return true;
  }

  /**
   * Continues the resumable read protocol through real request/service/response
   * events. Each contact is issued on the shared network; the protocol only sees
   * an exchange when the request actually arrived and only collects evidence
   * when the response actually arrived.
   */
  private pumpRead(transport: ReadTransport): void {
    if (transport.settled) return;
    for (;;) {
      const progress = transport.protocol.next();
      if (progress.kind === 'wait') return;
      if (progress.kind === 'ready') {
        this.deliverRead(transport);
        return;
      }
      if (progress.kind === 'done') {
        // A locally terminal answer (for example an unreachable required
        // token) still has to reach the client over the real egress path.
        this.deliverRead(transport, progress.outcome);
        return;
      }
      const exchange = progress.exchange;
      if (!this.beginReadExchange(transport, exchange)) {
        // The request could not be offered at all: no service ran and no
        // evidence exists, so the protocol advances without this contact.
        transport.protocol.settleRequest(exchange.stepId, { serviceStartUs: null });
        continue;
      }
      return;
    }
  }

  private beginReadExchange(transport: ReadTransport, exchange: CartReadExchange): boolean {
    const stepId = exchange.stepId;
    return this.submitReadTransfer(
      transport,
      `${transport.id}:r:${stepId}`,
      exchange.requestBytes,
      { kind: 'node', nodeId: transport.app, instance: transport.appInstance },
      { kind: 'node', nodeId: exchange.nodeId },
      'request',
      exchange.atUs,
      (arrivedUs) => this.onReadRequestArrived(transport, exchange, arrivedUs),
      () => {
        if (transport.settled) return;
        transport.protocol.settleRequest(stepId, { serviceStartUs: null });
        this.pumpRead(transport);
      },
    );
  }

  private onReadRequestArrived(
    transport: ReadTransport,
    exchange: CartReadExchange,
    arrivedUs: number,
  ): void {
    if (transport.settled) return;
    // The request arrived; the node's service starts only when its CPU is free.
    // The protocol cuts certificates at this actual service start.
    const service = this.cpuWindow(
      exchange.nodeId,
      arrivedUs,
      Math.ceil(CART_READ_ATTEMPT_CPU_MS * 1_000),
      1,
      exchange.requestBytes,
    );
    if (service === null) {
      // Bounded admission refused this contact: no work ran, no evidence
      // exists, and the protocol advances without inventing a service start.
      transport.protocol.settleRequest(exchange.stepId, { serviceStartUs: null });
      this.pumpRead(transport);
      return;
    }
    this.scheduleContinuation(service.startUs, () => {
      const issued: {nodeId: string; certificate: CartCertificate}[] = [];
      this.issuingCertificates = issued;
      const reply = transport.protocol.settleRequest(exchange.stepId, { serviceStartUs: service.startUs });
      this.issuingCertificates = null;
      if (reply === null) {
        this.pumpRead(transport);
        return;
      }
      const remainingCpuUs = Math.max(0, Math.ceil(reply.cpuMilliseconds * 1_000) -
        Math.ceil(CART_READ_ATTEMPT_CPU_MS * 1_000));
      const cpuDoneUs = this.cpuAt(exchange.nodeId, service.doneUs, remainingCpuUs);
      if (cpuDoneUs === null) {
        transport.protocol.settleReply(exchange.stepId, { arrivedUs: null });
        this.pumpRead(transport);
        return;
      }
      this.scheduleContinuation(cpuDoneUs, () => {
        const doneUs = this.cpu.reserveIo(exchange.nodeId, cpuDoneUs, reply.ioUnits).doneUs;
        this.scheduleContinuation(doneUs, () => {
          for (const {nodeId, certificate} of issued) this.queueCertificate(nodeId, certificate);
          this.onReadServiceComplete(transport, exchange, reply.responseBytes, doneUs);
        });
      });
    });
  }

  private onReadServiceComplete(
    transport: ReadTransport,
    exchange: CartReadExchange,
    responseBytes: number,
    doneUs: number,
  ): void {
    if (transport.settled) return;
    const stepId = exchange.stepId;
    if (doneUs > transport.deadlineUs) {
      // Performed work stays charged, but no late evidence is delivered.
      transport.protocol.settleReply(stepId, { arrivedUs: null });
      this.pumpRead(transport);
      return;
    }
    const submitted = this.submitReadTransfer(
      transport,
      `${transport.id}:s:${stepId}`,
      responseBytes,
      { kind: 'node', nodeId: exchange.nodeId },
      { kind: 'node', nodeId: transport.app, instance: transport.appInstance },
      'reply',
      doneUs,
      (replyArrivedUs) => {
        if (transport.settled) return;
        transport.protocol.settleReply(stepId, { arrivedUs: replyArrivedUs });
        this.pumpRead(transport);
      },
      () => {
        if (transport.settled) return;
        transport.protocol.settleReply(stepId, { arrivedUs: null });
        this.pumpRead(transport);
      },
    );
    if (!submitted) {
      transport.protocol.settleReply(stepId, { arrivedUs: null });
      this.pumpRead(transport);
    }
  }

  /**
   * Client delivery: the terminal freshness audit runs at the real arrival.
   * A `terminal` outcome (already decided locally, no remote evidence) is sent
   * over the same `:out` client-egress transfer and is booked as delivered only
   * when that transfer actually arrives before the deadline.
   */
  private deliverRead(transport: ReadTransport, terminal: CartReadOutcome | null = null): void {
    if (transport.settled) return;
    const resolve = (atUs: number): CartReadOutcome => terminal ?? transport.protocol.complete(atUs);
    const ready = this.cpuWindow(transport.app, this.network.currentTimeUs, 100, transport.appInstance, 128);
    if (ready === null) {
      // The client answer cannot be serviced: withhold the delivery instead of
      // reporting an untransmitted success.
      this.finishRead(transport, resolve(this.network.currentTimeUs), null);
      return;
    }
    const submitted = this.submitReadTransfer(
      transport,
      `${transport.id}:out`,
      128,
      { kind: 'node', nodeId: transport.app, instance: transport.appInstance },
      transport.client,
      'reply',
      ready.doneUs,
      (deliveredUs) => {
        if (transport.settled) return;
        this.finishRead(transport, resolve(deliveredUs), deliveredUs);
      },
      () => {
        if (transport.settled) return;
        // The read ran, but its result never reached the client: withhold the
        // delivery instead of booking a success nobody observed.
        this.finishRead(transport, resolve(this.network.currentTimeUs), null);
      },
    );
    if (!submitted) {
      this.finishRead(transport, resolve(ready.doneUs), null);
    }
  }

  private finishRead(
    transport: ReadTransport,
    outcome: CartReadOutcome | null,
    deliveredAtUs: number | null,
  ): void {
    if (transport.settled) return;
    transport.settled = true;
    this.openReads.delete(transport.id);
    for (const logicalId of transport.logicalIds) this.settleHandlers.delete(logicalId);
    // Only a read the client actually observed in time may seed volatile
    // state; a late or lost reply never becomes cache evidence.
    if (
      outcome !== null &&
      outcome.kind === 'complete' &&
      deliveredAtUs !== null &&
      deliveredAtUs <= transport.deadlineUs
    ) {
      this.storeDeliveredView(transport.servedBy, transport.app, outcome, deliveredAtUs);
    }
    if (transport.intent !== null) {
      this.recordRead(
        transport.intent,
        transport.offeredUs,
        transport.deadlineUs,
        transport.cohort,
        transport.exempt,
        outcome,
        deliveredAtUs,
        transport.app,
        transport.appInstance,
      );
      return;
    }
    if (transport.probe !== null && transport.step !== null) {
      this.recordProbeRead(
        transport.probe,
        transport.step,
        outcome,
        deliveredAtUs,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Intent execution
  // -------------------------------------------------------------------------

  private executeIntent(intent: CartOperationIntent): void {
    const deadlineUs = intent.atUs + CART_FOREGROUND_DEADLINE_US;
    const blocked = this.dependencyFailure(intent);
    if (blocked !== null) {
      // A dependent event keeps its fixed offer time and its real cohort, so the
      // failure stays in the correct denominator instead of hiding in `healthy`.
      const cohort =
        intent.operation === 'edit'
          ? this.editCohort(intent)
          : intent.operation === 'read'
            ? this.readCohort(intent)
            : this.checkoutCohort(intent);
      this.record(intent, intent.atUs, deadlineUs, 'dependency-failed', {
        cohort,
        dependencyFailed: true,
        evidenceIds: blocked,
      });
      return;
    }
    switch (intent.operation) {
      case 'edit':
        this.executeEdit(intent, intent.atUs, deadlineUs);
        break;
      case 'read':
        this.executeRead(intent, intent.atUs, deadlineUs);
        break;
      default:
        this.executeCheckout(intent, intent.atUs, deadlineUs);
        break;
    }
  }

  private cartState(cartId: string): CartState {
    const existing = this.carts.get(cartId);
    if (existing !== undefined) return existing;
    const created: CartState = { tokens: [], readIds: [], lastReadId: null };
    this.carts.set(cartId, created);
    return created;
  }

  /** Observation/lookup over the capacity-enforced engines, never a second log. */
  private cartEnvelopes(cartId: string): Map<string, CartOperationEnvelope> {
    const result = new Map<string, CartOperationEnvelope>();
    for (const store of this.durableStores.values()) {
      for (const operationId of store.retainedOperationIds(cartId)) {
        const envelope = store.envelopeFor({ cartId, operationId });
        if (envelope !== undefined) result.set(operationId, envelope);
      }
    }
    return result;
  }

  private isCommitted(cartId: string, operationId: string): boolean {
    return this.cartEnvelopes(cartId)?.has(operationId) ?? false;
  }

  private dependencyFailure(intent: CartOperationIntent): readonly string[] | null {
    const failed: string[] = [];
    for (const parentId of intent.dependsOn) {
      const parent = this.recorded.get(parentId);
      if (parent === undefined || !parent.acknowledged) failed.push(parentId);
    }
    for (const contextId of intent.observedContext) {
      const opId = this.opIdByIntent.get(contextId) ?? contextId;
      if (!this.isCommitted(intent.cartId, opId)) failed.push(contextId);
    }
    return failed.length > 0 ? failed : null;
  }

  private editPayload(intent: CartOperationIntent): { sku: string; kind: CartEditKind; quantity: number | null } | null {
    const effect = intent.effect;
    if (effect.kind === 'add') {
      return { sku: String(effect.sku % 100), kind: 'add', quantity: effect.count };
    }
    if (effect.kind === 'change') {
      return { sku: String(effect.sku % 100), kind: 'change', quantity: effect.target };
    }
    if (effect.kind === 'remove') return { sku: String(effect.sku % 100), kind: 'remove', quantity: null };
    return null;
  }

  /**
   * Completion-driven edit protocol:
   * ingress → application service → authority request → durable service/commit
   * → application merge → ACK reply → client.
   *
   * Every transition is triggered by an actual transport settlement or a
   * service completion time observed by the shared scheduler; nothing is
   * derived from a plan estimate. The durable write exists as soon as the
   * authority service completes, so an ACK lost afterwards keeps the write but
   * never claims acknowledgement.
   */
  private executeEdit(intent: CartOperationIntent, offeredUs: number, deadlineUs: number): void {
    const origin = intent.key.originRegion;
    const cohort = this.editCohort(intent);
    const exempt = cohort === 'incident-affected' || cohort === 'incident-backlog';
    const payload = this.editPayload(intent);
    const app = this.appNode(origin);
    const authority = this.facts.authorityByRegion[origin];
    const ledger = this.ledgers.get(origin);
    if (
      payload === null ||
      app === null ||
      authority === null ||
      ledger === undefined ||
      // The configured authority must be reachable over drawn request edges:
      // a replication-only path can never authorize the commit RPC.
      !this.requestPathReachable(app, authority)
    ) {
      this.record(intent, offeredUs, deadlineUs, 'rejected', {
        rejected: true,
        cohort,
        evidenceIds: ['topology-unqualified'],
      });
      return;
    }
    const observedContext = intent.observedContext.map(
      (id) => this.opIdByIntent.get(id) ?? id,
    );
    const envelope: CartOperationEnvelope = {
      cartId: intent.cartId,
      key: { ...intent.key },
      payload,
      observedContext,
    };
    const protocol: EditProtocol = {
      id: intent.id,
      intent,
      probe: null,
      step: null,
      cartId: intent.cartId,
      key: intent.key,
      origin,
      clientId: intent.key.clientId,
      offeredUs,
      deadlineUs,
      cohort,
      exempt,
      app,
      appInstance: this.cpu.assignInstance(app),
      authority,
      opId: cartOperationId(intent.key),
      envelope,
      logicalIds: new Set<string>(),
      committed: false,
      acknowledged: false,
      settled: false,
    };
    this.beginEdit(protocol);
  }

  /**
   * Shared first stage of the completion-driven edit protocol. Both scheduled
   * edits and probe fixture preparation enter here, so preparation pays the
   * same client ingress, application service, authority RPC, durable
   * CPU/IO/flush, merge and reply stages as an equivalent ordinary edit.
   */
  private beginEdit(protocol: EditProtocol): void {
    this.openEdits.set(protocol.id, protocol);
    const bytes = 512 + 32 * protocol.envelope.observedContext.length;
    const client = this.clientEndpoint(protocol.origin, protocol.clientId);
    const appEndpoint: CartEndpoint = {
      kind: 'node',
      nodeId: protocol.app,
      instance: protocol.appInstance,
    };
    const dispatched = this.dispatchTransfer(
      protocol,
      `${protocol.id}:in`,
      bytes,
      client,
      appEndpoint,
      'request',
      protocol.offeredUs,
      (deliveredAtUs) => this.onEditIngressDelivered(protocol, deliveredAtUs),
    );
    if (!dispatched) {
      this.finishEdit(protocol, 'rejected', {
        rejected: true,
        evidenceIds: ['no-request-path'],
      });
    }
  }

  /** Submits one protocol envelope and routes its actual settlement. */
  private dispatchTransfer(
    protocol: EditProtocol,
    logicalId: string,
    bytes: number,
    from: CartEndpoint,
    to: CartEndpoint,
    purpose: 'request' | 'reply',
    atUs: number,
    onDelivered: (deliveredAtUs: number) => void,
  ): boolean {
    const at = Math.max(atUs, this.network.currentTimeUs);
    if (at > this.network.currentTimeUs) this.advanceTo(at);
    const submitAt = Math.max(at, this.network.currentTimeUs);
    if (submitAt > protocol.deadlineUs) return false;
    const result = this.network.submit(
      { logicalId, bytes, from, to, purpose, deadlineUs: protocol.deadlineUs },
      submitAt,
    );
    if (!result.ok) return false;
    protocol.logicalIds.add(logicalId);
    this.settleHandlers.set(logicalId, (transfer) => {
      if (transfer.status === 'delivered' && transfer.deliveredAtUs !== null) {
        const deliveredAtUs = transfer.deliveredAtUs;
        this.scheduleContinuation(deliveredAtUs, () => onDelivered(deliveredAtUs));
        return;
      }
      const lostAtUs = transfer.cancelledAtUs ?? this.network.currentTimeUs;
      this.scheduleContinuation(lostAtUs, () => this.onEditTransferLost(protocol, transfer));
    });
    return true;
  }

  private onEditIngressDelivered(protocol: EditProtocol, deliveredAtUs: number): void {
    if (protocol.settled) return;
    if (deliveredAtUs > protocol.deadlineUs) {
      this.finishEdit(protocol, 'timeout', { evidenceIds: [protocol.opId] });
      return;
    }
    const payloadBytes = 512 + 32 * protocol.envelope.observedContext.length;
    const readyUs = this.cpuAt(protocol.app, deliveredAtUs, 200, protocol.appInstance, payloadBytes);
    if (readyUs === null) {
      this.finishEdit(protocol, protocol.exempt ? 'unavailable' : 'rejected', {
        rejected: !protocol.exempt,
        evidenceIds: ['pending-overflow'],
      });
      return;
    }
    this.scheduleContinuation(readyUs, () => this.onEditApplicationReady(protocol, readyUs));
  }

  private onEditApplicationReady(protocol: EditProtocol, readyUs: number): void {
    if (protocol.settled) return;
    if (readyUs > protocol.deadlineUs) {
      this.finishEdit(protocol, 'timeout', { evidenceIds: [protocol.opId] });
      return;
    }
    const bytes = 512 + 32 * protocol.envelope.observedContext.length;
    const dispatched = this.dispatchTransfer(
      protocol,
      `${protocol.id}:commit`,
      bytes,
      { kind: 'node', nodeId: protocol.app, instance: protocol.appInstance },
      { kind: 'node', nodeId: protocol.authority },
      'request',
      readyUs,
      (deliveredAtUs) => this.onEditAuthorityArrived(protocol, deliveredAtUs),
    );
    if (!dispatched) {
      this.finishEdit(protocol, protocol.exempt ? 'unavailable' : 'rejected', {
        rejected: !protocol.exempt,
        evidenceIds: ['authority-unreachable'],
      });
    }
  }

  private onEditAuthorityArrived(protocol: EditProtocol, arrivedUs: number): void {
    if (protocol.settled) return;
    if (arrivedUs > protocol.deadlineUs) {
      this.finishEdit(protocol, 'timeout', { evidenceIds: [protocol.opId] });
      return;
    }
    const store = this.durableStores.get(protocol.authority);
    if (store === undefined) {
      this.finishEdit(protocol, 'rejected', { rejected: true, evidenceIds: ['authority-unreachable'] });
      return;
    }
    const demand = store.editCharge(protocol.envelope);
    const cpuUs = this.cpuAt(
      protocol.authority,
      arrivedUs,
      Math.ceil(demand.cpuMilliseconds * 1_000),
      1,
      this.editEnvelopeBytes(protocol),
    );
    if (cpuUs === null) {
      this.finishEdit(protocol, protocol.exempt ? 'unavailable' : 'rejected', {
        rejected: !protocol.exempt,
        evidenceIds: ['pending-overflow'],
      });
      return;
    }
    this.scheduleContinuation(cpuUs, () => {
      const io = this.cpu.reserveIo(protocol.authority, cpuUs, demand.ioUnits);
      const duplicate = store.envelopeFor({ cartId: protocol.envelope.cartId, operationId: protocol.opId }) !== undefined;
      const durableUs = io.doneUs + (duplicate ? 0 : CART_DURABLE_FLUSH_US);
      this.scheduleContinuation(durableUs, () => this.onEditDurableComplete(protocol, durableUs));
    });
  }

  private editEnvelopeBytes(protocol: EditProtocol): number {
    return 512 + 32 * protocol.envelope.observedContext.length;
  }

  private onEditDurableComplete(protocol: EditProtocol, completedUs: number): void {
    if (protocol.settled) return;
    if (completedUs > protocol.deadlineUs) {
      this.finishEdit(protocol, 'timeout', { evidenceIds: [protocol.opId] });
      return;
    }
    const origin = protocol.origin;
    // A partition that falls inside the durable window cancels the request;
    // the commit exists at its origin authority only if service completed.
    if (!this.regionReachableAt(origin, origin, completedUs) && !protocol.exempt) {
      this.finishEdit(protocol, 'rejected', {
        rejected: true,
        evidenceIds: ['authority-unreachable'],
      });
      return;
    }
    const ledger = this.ledgers.get(origin);
    if (ledger === undefined) {
      this.finishEdit(protocol, 'rejected', {
        rejected: true,
        evidenceIds: ['authority-unreachable'],
      });
      return;
    }
    const result = this.durableStores.get(protocol.authority)?.commitEdit(protocol.envelope, completedUs, true);
    if (result !== undefined && !result.ok && result.reason === 'idempotency-conflict' && protocol.probe !== null) {
      // GC-PF5: the dedup row answers a changed payload with a delivered
      // IdempotencyConflict reply; nothing was mutated or ledgered.
      this.replyEditConflict(protocol, completedUs);
      return;
    }
    if (result === undefined || !result.ok) {
      this.finishEdit(protocol, 'rejected', { rejected: true, evidenceIds: [result?.reason ?? 'authority-unreachable'] });
      return;
    }
    const commitUs = completedUs;
    ledger.record(
      protocol.cartId,
      origin,
      protocol.opId,
      commitUs,
      cartOperationFingerprint(protocol.envelope),
    );
    this.replication.notifyCommit(protocol.authority, commitUs);
    this.wakeReplication();
    this.opIdByIntent.set(protocol.id, protocol.opId);
    this.originOfOp.set(protocol.opId, origin);
    if (!this.cartState(protocol.cartId).tokens.includes(protocol.opId)) this.cartState(protocol.cartId).tokens.push(protocol.opId);
    protocol.committed = true;
    protocol.ackBytes = result.ack.bytes;

    // The application merge that produces the reply is a real service
    // completion after the commit, never a plan-time addition.
    const mergeUs = this.cpuAt(protocol.app, commitUs, 200, protocol.appInstance, this.editEnvelopeBytes(protocol));
    if (mergeUs === null || mergeUs > protocol.deadlineUs) {
      this.finishEdit(protocol, 'committed', {
        committed: true,
        acknowledged: false,
        evidenceIds: [protocol.opId],
      });
      return;
    }
    this.scheduleContinuation(mergeUs, () => this.onEditReplyReady(protocol, mergeUs));
  }

  /** Delivers the durable `IdempotencyConflict` rejection over the real reply path. */
  private replyEditConflict(protocol: EditProtocol, rejectedUs: number): void {
    const mergeUs = this.cpuAt(protocol.app, rejectedUs, 200, protocol.appInstance, this.editEnvelopeBytes(protocol));
    const evidenceIds = [protocol.opId, 'idempotency-conflict'];
    if (mergeUs === null || mergeUs > protocol.deadlineUs) {
      this.finishEdit(protocol, 'conflict', { rejected: true, acknowledged: false, evidenceIds });
      return;
    }
    this.scheduleContinuation(mergeUs, () => {
      if (protocol.settled) return;
      const dispatched = this.dispatchTransfer(
        protocol,
        `${protocol.id}:ack`,
        128,
        { kind: 'node', nodeId: protocol.app, instance: protocol.appInstance },
        this.clientEndpoint(protocol.origin, protocol.clientId),
        'reply',
        mergeUs,
        (deliveredAtUs) => {
          if (protocol.settled) return;
          const acknowledged = deliveredAtUs <= protocol.deadlineUs;
          this.finishEdit(protocol, 'conflict', {
            rejected: true,
            acknowledged,
            deliveredUs: acknowledged ? deliveredAtUs : null,
            evidenceIds,
          });
        },
      );
      if (!dispatched) this.finishEdit(protocol, 'conflict', { rejected: true, acknowledged: false, evidenceIds });
    });
  }

  private onEditReplyReady(protocol: EditProtocol, replyUs: number): void {
    if (protocol.settled) return;
    const client = this.clientEndpoint(
      protocol.origin,
      protocol.clientId,
    );
    const dispatched = this.dispatchTransfer(
      protocol,
      `${protocol.id}:ack`,
      protocol.ackBytes ?? 128,
      { kind: 'node', nodeId: protocol.app, instance: protocol.appInstance },
      client,
      'reply',
      replyUs,
      (deliveredAtUs) => {
        if (protocol.settled) return;
        const acknowledged = deliveredAtUs <= protocol.deadlineUs;
        this.finishEdit(protocol, 'committed', {
          committed: true,
          acknowledged,
          deliveredUs: acknowledged ? deliveredAtUs : null,
          evidenceIds: [protocol.opId],
        });
      },
    );
    if (!dispatched) {
      this.finishEdit(protocol, 'committed', {
        committed: true,
        acknowledged: false,
        evidenceIds: [protocol.opId],
      });
    }
  }

  private onEditTransferLost(protocol: EditProtocol, transfer: CartTransfer): void {
    if (protocol.settled) return;
    if (protocol.committed) {
      // The durable write already happened; a lost reply is not an ACK.
      this.finishEdit(protocol, 'committed', {
        committed: true,
        acknowledged: false,
        evidenceIds: [protocol.opId],
      });
      return;
    }
    if (transfer.cancelReason === 'deadline') {
      this.finishEdit(protocol, 'timeout', { evidenceIds: [protocol.opId] });
      return;
    }
    this.finishEdit(protocol, protocol.exempt ? 'unavailable' : 'rejected', {
      rejected: !protocol.exempt,
      evidenceIds: ['transport-cancelled'],
    });
  }

  private finishEdit(
    protocol: EditProtocol,
    outcome: CartRequestOutcome,
    extra: {
      readonly committed?: boolean;
      readonly acknowledged?: boolean;
      readonly deliveredUs?: number | null;
      readonly rejected?: boolean;
      readonly evidenceIds?: readonly string[];
    },
  ): void {
    if (protocol.settled) return;
    protocol.settled = true;
    this.openEdits.delete(protocol.id);
    for (const logicalId of protocol.logicalIds) this.settleHandlers.delete(logicalId);
    if (protocol.intent !== null) {
      this.record(protocol.intent, protocol.offeredUs, protocol.deadlineUs, outcome, {
        cohort: protocol.cohort,
        ...extra,
      });
      return;
    }
    if (protocol.probe !== null && protocol.step !== null) {
      // Probe fixture preparation keeps its frozen step id, offer time and
      // record deadline; only the settlement facts come from the shared stages.
      this.recordProbe(protocol.probe, protocol.step, outcome, extra);
    }
  }

  /** Offers that never settled inside the measured window stay unresolved. */
  private finalizeOpenEdits(): void {
    for (const protocol of [...this.openEdits.values()]) {
      this.finishEdit(protocol, protocol.committed ? 'committed' : 'unavailable', {
        committed: protocol.committed,
        acknowledged: false,
        deliveredUs: null,
        evidenceIds: [protocol.opId],
      });
    }
  }

  private executeRead(intent: CartOperationIntent, offeredUs: number, deadlineUs: number): void {
    const servedBy = intent.effect.kind === 'read' ? intent.effect.servedBy : intent.key.originRegion;
    const cart = this.cartState(intent.cartId);
    const tokenIds = intent.effect.kind === 'read' ? intent.effect.token.map((id) => this.opIdByIntent.get(id) ?? id) : [...cart.tokens];
    const cohort = this.readCohort(intent);
    const exempt = cohort === 'incident-affected' || cohort === 'incident-backlog';
    const app = this.appNode(servedBy);
    if (app === null) {
      this.record(intent, offeredUs, deadlineUs, 'rejected', {
        rejected: true,
        cohort,
        evidenceIds: ['no-application'],
      });
      return;
    }
    const engine = this.readEngine(intent.cartId, servedBy, app);
    if (engine === null) {
      this.record(intent, offeredUs, deadlineUs, 'rejected', {
        rejected: true,
        cohort,
        evidenceIds: ['no-write-authority'],
      });
      return;
    }
    const requestBytes = 256 + 32 * tokenIds.length;
    const client = this.clientEndpoint(servedBy, intent.key.clientId);
    const protocol = engine.protocol({
      token: { version: CART_SESSION_TOKEN_VERSION, cartId: intent.cartId, ids: [...tokenIds].sort() },
      requestUs: offeredUs,
    });
    const transport: ReadTransport = {
      id: intent.id,
      offeredUs,
      deadlineUs,
      cohort,
      exempt,
      app,
      appInstance: this.cpu.assignInstance(app),
      servedBy,
      client,
      protocol,
      intent,
      probe: null,
      step: null,
      logicalIds: new Set<string>(),
      settled: false,
    };
    this.openReads.set(intent.id, transport);
    const dispatched = this.submitReadTransfer(
      transport,
      `${intent.id}:in`,
      requestBytes,
      client,
      { kind: 'node', nodeId: app, instance: transport.appInstance },
      'request',
      offeredUs,
      (deliveredAtUs) => {
        if (transport.settled) return;
        if (deliveredAtUs > deadlineUs) {
          this.record(intent, offeredUs, deadlineUs, 'timeout', { cohort });
          this.abandonRead(transport);
          return;
        }
        this.pumpRead(transport);
      },
      () => {
        if (transport.settled) return;
        this.record(intent, offeredUs, deadlineUs, exempt ? 'unavailable' : 'rejected', {
          cohort,
          acknowledged: false,
          rejected: !exempt,
          evidenceIds: ['transport-cancelled'],
        });
        this.abandonRead(transport);
      },
    );
    if (!dispatched) {
      this.record(intent, offeredUs, deadlineUs, exempt ? 'unavailable' : 'rejected', {
        cohort,
        acknowledged: false,
        rejected: !exempt,
        evidenceIds: ['no-request-path'],
      });
      this.abandonRead(transport);
    }
  }

  /** Drops a read that will never produce a protocol outcome. */
  private abandonRead(transport: ReadTransport): void {
    transport.settled = true;
    this.openReads.delete(transport.id);
    for (const logicalId of transport.logicalIds) this.settleHandlers.delete(logicalId);
  }

  private recordRead(
    intent: CartOperationIntent,
    offeredUs: number,
    deadlineUs: number,
    cohort: CartRequestCohort,
    exempt: boolean,
    outcome: CartReadOutcome | null,
    deliveredAtUs: number | null,
    app: string,
    appInstance: number,
  ): void {
    const evidence = outcome !== null && outcome.kind === 'complete' ? outcome.coveredIds : [];
    const delivered = deliveredAtUs !== null && deliveredAtUs <= deadlineUs;
    if (outcome !== null && outcome.kind === 'complete' && delivered) {
      const deliveryUs = deliveredAtUs as number;
      // The terminal freshness audit is a real application service window. If
      // the node's bounded pending/RAM admission refuses it, the observation is
      // not a delivered success: publish nothing and book the overflow.
      if (this.cpuAt(app, deliveryUs, 100, appInstance) === null) {
        this.record(intent, offeredUs, deadlineUs, exempt ? 'unavailable' : 'rejected', {
          cohort,
          acknowledged: false,
          rejected: !exempt,
          evidenceIds: ['pending-overflow'],
        });
        return;
      }
      this.reads.set(intent.id, { complete: outcome, deliveryUs });
      const cart = this.cartState(intent.cartId);
      cart.readIds.push(intent.id);
      cart.lastReadId = intent.id;
      this.record(intent, offeredUs, deadlineUs, 'committed', {
        cohort,
        acknowledged: true,
        deliveredUs: deliveryUs,
        evidenceIds: evidence,
      });
      return;
    }
    if (
      outcome !== null &&
      (outcome.kind === 'unavailable' || outcome.kind === 'partial') &&
      deliveredAtUs !== null
    ) {
      // A degraded answer is a real terminal observation only if its response
      // actually reached the client before the deadline.
      this.record(intent, offeredUs, deadlineUs, exempt ? 'unavailable' : 'validation-failed', {
        cohort,
        acknowledged: delivered,
        deliveredUs: delivered ? deliveredAtUs : null,
        evidenceIds: evidence,
      });
      return;
    }
    // Complete-but-undelivered (lost/late reply) and never-finished reads stay
    // unresolved; no success is booked without an observed client delivery.
    this.record(intent, offeredUs, deadlineUs, 'timeout', { cohort, evidenceIds: evidence });
  }

  private recordProbeRead(
    probe: CartProbe,
    step: CartProbeStep,
    outcome: CartReadOutcome | null,
    deliveredAtUs: number | null,
  ): void {
    const deadlineUs = step.deadlineUs ?? step.atUs + CART_FOREGROUND_DEADLINE_US;
    const delivered = deliveredAtUs !== null && deliveredAtUs <= deadlineUs;
    const evidence = outcome !== null && outcome.kind === 'complete' ? outcome.coveredIds : [];
    if (outcome !== null && outcome.kind === 'complete' && delivered) {
      const deliveryUs = deliveredAtUs as number;
      const cartId = this.probeCart(probe, step);
      const cart = this.cartState(cartId);
      this.reads.set(step.id, { complete: outcome, deliveryUs });
      cart.readIds.push(step.id);
      cart.lastReadId = step.id;
      this.recordProbe(probe, step, 'committed', {
        acknowledged: true,
        deliveredUs: deliveryUs,
        evidenceIds: evidence,
      });
      return;
    }
    if (deliveredAtUs !== null && outcome !== null && (outcome.kind === 'unavailable' || outcome.kind === 'partial')) {
      const cohort = this.probeCohorts.get(step.id) ?? probe.cohort;
      const affected = cohort === 'incident-affected' || cohort === 'incident-backlog';
      this.recordProbe(probe, step, affected ? 'unavailable' : 'validation-failed', {
        acknowledged: delivered,
        deliveredUs: delivered ? deliveredAtUs : null,
        evidenceIds: evidence,
      });
      return;
    }
    this.recordProbe(probe, step, 'timeout', { evidenceIds: evidence });
  }

  /**
   * Builds the read engine from *configured storage paths* (GC-PE1):
   *
   * 1. the Application's `readTargets` — the repair/fallback sources it names;
   * 2. each origin's configured durable authority (`writeTarget`) — required to
   *    retain complete-origin coverage without enumerating the graph.
   *
   * The engine must never enumerate nodes: a target is queried only when it is
   * configured by one of those two paths, when its kind can answer a read, and
   * when a drawn directed *request* path connects the Application to it.
   * Invalid or empty configuration returns `null`, which the callers record as
   * an explicit rejection instead of silently falling back to another node.
   */
  private readEngine(cartId: string, servedBy: CartRegion, appNodeId: string): CartReadEngine | null {
    const ledgers: Partial<Record<CartRegion, CartOriginCommitLedger>> = {};
    for (const region of CART_REGIONS) {
      const ledger = this.ledgers.get(region);
      if (ledger === undefined) return null;
      ledgers[region] = ledger;
    }
    const app = this.topology.nodes.get(appNodeId);
    if (app === undefined || app.kind !== 'application') return null;
    const configured = app.readTargets;
    if (configured.length === 0) return null;

    // Authorities are configured by each region's Application `writeTarget`;
    // a region without one cannot prove complete-origin coverage, so fail here
    // rather than querying an arbitrary durable node.
    const targetIds: string[] = [...configured];
    for (const region of CART_REGIONS) {
      if (this.authorities[region].length === 0) return null;
    }

    const targets: CartReadNode[] = [];
    const seen = new Set<string>();
    for (const targetId of targetIds) {
      if (seen.has(targetId)) continue;
      seen.add(targetId);
      const node = this.topology.nodes.get(targetId);
      if (node === undefined) return null;
      // A configured cache is a real read target: it answers from volatile
      // covered views through the read engine's cache seam and never from
      // durable state. It cannot certify an origin or answer a repair.
      if (node.kind === 'cache') {
        const cache = this.caches.get(node.id);
        if (cache === undefined) return null;
        targets.push({
          nodeId: node.id,
          region: node.region,
          kind: 'cache',
          reachable: (atUs: number) =>
            this.regionReachableAt(servedBy, node.region, atUs) &&
            this.requestPathReachable(appNodeId, node.id),
          cache: () => cache,
        });
        continue;
      }
      // Only a journal, cart store or Application may answer a durable read;
      // any other kind is a configuration error, never a reason to substitute
      // a different node.
      if (node.kind !== 'application' && node.kind !== 'journal' && node.kind !== 'store') {
        return null;
      }
      const targetNode = node;
      targets.push({
        nodeId: targetNode.id,
        region: targetNode.region,
        kind: targetNode.kind,
        reachable: (atUs: number) =>
          // Both gates are required: the configured target must be physically
          // available in the region graph at this instant, and only drawn
          // request edges may carry the request RPC.
          this.regionReachableAt(servedBy, targetNode.region, atUs) &&
          this.requestPathReachable(appNodeId, targetNode.id),
        durableRead: this.durableStores.has(targetNode.id)
          ? (cart: string) => this.durableStores.get(targetNode.id)!.readCart(cart) : undefined,
        certifies: (origin: CartRegion) => {
          const ledger = this.ledgers.get(origin);
          if (ledger === undefined) return undefined;
          if (targetNode.id !== this.authorities[origin]) {
            const carry = this.certificates.get(targetNode.id)?.get(`${cartId}:${origin}`);
            return carry === undefined ? undefined : {role: 'replica', carry};
          }
          return {
            role: 'authority',
            kind: targetNode.kind === 'store' ? 'store' : 'journal',
            ledger,
          };
        },
        envelope: (cart: string, operationId: string) =>
          this.durableStores.get(targetNode.id)?.envelopeFor({ cartId: cart, operationId }),
      });
    }
    if (targets.length === 0) return null;
    const policy = app.readPolicy;
    return new CartReadEngine({
      cartId,
      policy: policy === 'parallel' ? 'parallel' : 'local-repair',
      localRegion: servedBy,
      targets,
      authorities: this.authorities,
      authorityLedgers: ledgers as Readonly<Record<CartRegion, CartOriginCommitLedger>>,
      onCertificateIssued: (nodeId, certificate) => this.issuingCertificates?.push({nodeId, certificate}),
    });
  }

  /** The volatile cache this Application actually configured, if any. */
  private configuredCache(region: CartRegion, appNodeId: string): CartVolatileCache | undefined {
    const app = this.topology.nodes.get(appNodeId);
    if (app === undefined || app.kind !== 'application') return undefined;
    for (const targetId of app.readTargets) {
      const node = this.topology.nodes.get(targetId);
      if (node === undefined || node.kind !== 'cache') continue;
      if (node.region !== region) continue;
      if (!this.requestPathReachable(appNodeId, node.id)) continue;
      return this.caches.get(node.id);
    }
    return undefined;
  }

  /**
   * Seeds the serving region's configured cache from one delivered, audited
   * read. Only attested material enters the cache: an envelope is retained
   * only when the exact origin authority ledger minted a durable-commit
   * attestation for this cart and payload, and only the authority-issued
   * certificates the read already audited are kept. The store time is the
   * actual client delivery, so TTL measures real reuse, not oracle claims.
   */
  private storeDeliveredView(
    servedBy: CartRegion,
    appNodeId: string,
    outcome: CartReadComplete,
    deliveredUs: number,
  ): void {
    const cache = this.configuredCache(servedBy, appNodeId);
    if (cache === undefined) return;
    const durable = this.cartEnvelopes(outcome.cartId);
    const envelopes: CartOperationEnvelope[] = [];
    const coveredIds: string[] = [];
    const provenance: CartDurableCommit[] = [];
    for (const operationId of outcome.coveredIds) {
      const envelope = durable.get(operationId);
      if (envelope === undefined) continue;
      const attestation = this.ledgers
        .get(envelope.key.originRegion)
        ?.attest(outcome.cartId, envelope);
      if (attestation === undefined) continue;
      envelopes.push(envelope);
      coveredIds.push(cartOperationId(envelope.key));
      provenance.push(attestation);
    }
    if (coveredIds.length === 0) return;
    cache.store(
      {
        cartId: outcome.cartId,
        coveredIds,
        envelopes,
        certificates: outcome.evidence.certificates,
        provenance,
      },
      deliveredUs,
    );
  }

  private executeCheckout(intent: CartOperationIntent, offeredUs: number, deadlineUs: number): void {
    const selectionId = intent.effect.kind === 'checkout' ? intent.effect.selectionReadId : '';
    const selection = this.reads.get(selectionId);
    const cohort = this.checkoutCohort(intent);
    const exempt = cohort === 'incident-affected' || cohort === 'incident-backlog';
    if (this.inventory === null || this.facts.inventoryNodeId === null) {
      this.record(intent, offeredUs, deadlineUs, 'rejected', {
        rejected: true,
        cohort,
        evidenceIds: ['missing-inventory'],
      });
      return;
    }
    if (selection === undefined || selection.deliveryUs > offeredUs) {
      // An incident-affected checkout still owes the client a terminal answer.
      // When the selection view is not usable, answer explicit
      // TemporarilyUnavailable over the real reply path instead of leaving a
      // silent dependency failure that the affected cohort never observes.
      // Healthy cohorts keep the scheduled dependency failure in their normal
      // denominator (the frozen workload's read-17 -> checkout cascade).
      if (exempt) {
        const app = this.appNode(intent.key.originRegion);
        if (app !== null) {
          this.deliverCheckoutUnavailable(
            {
              id: intent.id,
              intent,
              probe: null,
              step: null,
              offeredUs,
              deadlineUs,
              cohort,
              app,
              appInstance: this.cpu.assignInstance(app),
              client: this.clientEndpoint(intent.key.originRegion, intent.key.clientId),
              attempt: 0,
              logicalIds: new Set<string>(),
              settled: false,
            },
            `${selectionId}:selection-not-delivered`,
          );
          return;
        }
      }
      this.record(intent, offeredUs, deadlineUs, 'dependency-failed', {
        dependencyFailed: true,
        cohort,
        evidenceIds: [selectionId],
      });
      return;
    }
    const lines = cartCheckoutLinesFromView(selection.complete.view);
    if (lines.length === 0) {
      this.record(intent, offeredUs, deadlineUs, 'validation-failed', {
        rejected: true,
        cohort,
        evidenceIds: [selectionId],
      });
      return;
    }
    const app = this.appNode(intent.key.originRegion);
    if (app === null) {
      this.record(intent, offeredUs, deadlineUs, 'rejected', {
        rejected: true,
        cohort,
        evidenceIds: ['no-application'],
      });
      return;
    }
    // CONTRACT B4: retry identity is the original order key and binding. The
    // transport retry below keeps this exact binding for its whole lifetime.
    const orderKey = `${intent.key.clientId}#${intent.key.requestSequence}`;
    const binding = createCartCheckoutBinding(orderKey, {
      cartId: intent.cartId,
      coveredIds: [...selection.complete.coveredIds],
      lines,
    });
    const transport: CheckoutTransport = {
      id: intent.id,
      intent,
      probe: null,
      step: null,
      offeredUs,
      deadlineUs,
      cohort,
      exempt,
      app,
      appInstance: this.cpu.assignInstance(app),
      inventoryNodeId: this.facts.inventoryNodeId,
      client: this.clientEndpoint(intent.key.originRegion, intent.key.clientId),
      binding,
      lines,
      selection,
      selectionId,
      logicalIds: new Set<string>(),
      attempt: 0,
      retried: false,
      committed: false,
      lastResult: null,
      settled: false,
    };
    this.openCheckouts.set(intent.id, transport);
    this.beginCheckoutIngress(transport);
  }

  /**
   * Checkout transport: client request → Application → Inventory Lookup.
   *
   * Nothing touches stock in this phase. A Lookup miss is only a reply; the
   * complete read/evidence are consulted exclusively on a miss and Commit is
   * sent as a separate routed request. Inventory remains the sole owner of
   * atomic stock/ledger effects and durable retry results.
   */
  private beginCheckoutIngress(transport: CheckoutTransport): void {
    if (transport.settled) return;
    const bytes =
      CART_CHECKOUT_INGRESS_BYTES + CART_CHECKOUT_LINE_BYTES * transport.lines.length;
    const atUs = Math.max(transport.offeredUs, this.network.currentTimeUs);
    const dispatched = this.dispatchCheckoutTransfer(
      transport,
      `${transport.id}:in:${transport.attempt}`,
      bytes,
      transport.client,
      { kind: 'node', nodeId: transport.app, instance: transport.appInstance },
      'request',
      atUs,
      (deliveredAtUs) => this.onCheckoutIngressDelivered(transport, deliveredAtUs),
      () => this.onCheckoutLost(transport, 'ingress'),
    );
    if (!dispatched) this.finishCheckoutRouteFailure(transport, 'no-request-path');
  }

  private onCheckoutIngressDelivered(transport: CheckoutTransport, deliveredAtUs: number): void {
    if (transport.settled) return;
    if (deliveredAtUs > transport.deadlineUs) {
      this.finishCheckoutTimeout(transport);
      return;
    }
    const service = this.cpuWindow(transport.app, deliveredAtUs, 200, transport.appInstance, CART_CHECKOUT_INGRESS_BYTES);
    if (service === null) {
      this.rejectCheckoutAdmission(transport, 'pending-overflow');
      return;
    }
    if (service.doneUs > transport.deadlineUs) {
      this.finishCheckoutTimeout(transport);
      return;
    }
    this.scheduleContinuation(service.doneUs, () =>
      this.beginCheckoutLookup(transport, service.doneUs),
    );
  }

  /** Application → Inventory `Lookup(binding)`; the first stage of every attempt. */
  private beginCheckoutLookup(transport: CheckoutTransport, atUs: number): void {
    if (transport.settled) return;
    const bytes =
      CART_CHECKOUT_LOOKUP_REQUEST_BYTES +
      CART_CHECKOUT_LINE_BYTES * transport.lines.length +
      CART_CHECKOUT_COVERED_ID_BYTES * transport.selection.complete.coveredIds.length;
    const dispatched = this.dispatchCheckoutTransfer(
      transport,
      `${transport.id}:lookup:${transport.attempt}`,
      bytes,
      { kind: 'node', nodeId: transport.app, instance: transport.appInstance },
      { kind: 'node', nodeId: transport.inventoryNodeId },
      'request',
      atUs,
      (arrivedUs) => this.onCheckoutLookupArrived(transport, arrivedUs),
      () => this.onCheckoutLost(transport, 'lookup'),
    );
    if (!dispatched) this.finishCheckoutRouteFailure(transport, 'no-inventory-route');
  }

  private onCheckoutLookupArrived(transport: CheckoutTransport, arrivedUs: number): void {
    if (transport.settled) return;
    const inventory = this.inventory;
    if (inventory === null) {
      this.finishCheckoutRouteFailure(transport, 'missing-inventory');
      return;
    }
    this.cpu.enqueueExclusive(transport.inventoryNodeId, arrivedUs, (startUs, release) => {
      if (transport.settled || startUs > transport.deadlineUs) {
        release(startUs);
        return;
      }
      const service = this.cpuWindow(transport.inventoryNodeId, startUs,
        Math.ceil(CART_INVENTORY_LOOKUP_CPU_MS * 1_000), 1, CART_CHECKOUT_LOOKUP_REQUEST_BYTES);
      if (service === null) {
        release(startUs);
        this.rejectCheckoutAdmission(transport, 'pending-overflow');
        return;
      }
      this.scheduleContinuation(service.doneUs, () => {
        const doneUs = this.cpu.reserveIo(transport.inventoryNodeId, service.doneUs,
          CART_INVENTORY_LOOKUP_IO_UNITS).doneUs;
        this.scheduleContinuation(doneUs, () => {
          const result = inventory.lookup(transport.binding);
          transport.lastResult = result;
          if (result.outcome === 'committed' || result.outcome === 'out-of-stock') transport.committed = true;
          release(doneUs);
          if (transport.settled) return;
          const dispatched = this.dispatchCheckoutTransfer(transport,
            `${transport.id}:lookup-reply:${transport.attempt}`, CART_CHECKOUT_REPLY_BYTES,
            { kind: 'node', nodeId: transport.inventoryNodeId },
            { kind: 'node', nodeId: transport.app, instance: transport.appInstance },
            'reply', doneUs,
            replyUs => this.onCheckoutLookupReplied(transport, replyUs, result),
            () => this.onCheckoutLost(transport, 'lookup-reply'));
          if (!dispatched) this.finishCheckoutRouteFailure(transport, 'no-inventory-reply-route');
        });
      });
    });
  }

  private onCheckoutLookupReplied(
    transport: CheckoutTransport,
    arrivedUs: number,
    result: CartInventoryResult,
  ): void {
    if (transport.settled) return;
    if (arrivedUs > transport.deadlineUs) {
      this.finishCheckoutTimeout(transport);
      return;
    }
    const service = this.cpuWindow(transport.app, arrivedUs, 100, transport.appInstance, CART_CHECKOUT_REPLY_BYTES);
    if (service === null) {
      this.rejectCheckoutAdmission(transport, 'pending-overflow');
      return;
    }
    if (service.doneUs > transport.deadlineUs) {
      this.finishCheckoutTimeout(transport);
      return;
    }
    this.scheduleContinuation(service.doneUs, () => {
      if (transport.settled) return;
      if (result.outcome === 'lookup-miss') {
        // Miss is the only authorization to consult the accepted complete
        // read and send Commit; a hit already carries the durable outcome.
        this.beginCheckoutCommit(transport, service.doneUs);
      } else {
        this.beginCheckoutTerminalReply(transport, service.doneUs, result);
      }
    });
  }

  /** Application → Inventory `Commit(binding, evidence)` after a Lookup miss. */
  private beginCheckoutCommit(transport: CheckoutTransport, atUs: number): void {
    if (transport.settled) return;
    const evidence = createCartCheckoutEvidence(
      cartCheckoutReadFromView(transport.selection.complete, {
        deliveryUs: transport.selection.deliveryUs,
        requestId: transport.selectionId,
      }),
    );
    const bytes =
      CART_CHECKOUT_COMMIT_REQUEST_BYTES +
      CART_CHECKOUT_LINE_BYTES * transport.lines.length +
      CART_CHECKOUT_COVERED_ID_BYTES * transport.selection.complete.coveredIds.length;
    const dispatched = this.dispatchCheckoutTransfer(
      transport,
      `${transport.id}:commit:${transport.attempt}`,
      bytes,
      { kind: 'node', nodeId: transport.app, instance: transport.appInstance },
      { kind: 'node', nodeId: transport.inventoryNodeId },
      'request',
      atUs,
      (arrivedUs) => this.onCheckoutCommitArrived(transport, arrivedUs, evidence),
      () => this.onCheckoutLost(transport, 'commit'),
    );
    if (!dispatched) this.finishCheckoutRouteFailure(transport, 'no-inventory-route');
  }

  private onCheckoutCommitArrived(
    transport: CheckoutTransport,
    arrivedUs: number,
    evidence: CartCheckoutEvidence,
  ): void {
    if (transport.settled) return;
    const inventory = this.inventory;
    if (inventory === null) {
      this.finishCheckoutRouteFailure(transport, 'missing-inventory');
      return;
    }
    this.cpu.enqueueExclusive(transport.inventoryNodeId, arrivedUs, (startUs, release) => {
      if (transport.settled || startUs > transport.deadlineUs) {
        release(startUs);
        return;
      }
      const demand = inventory.commitService(transport.binding, evidence, startUs);
      const service = this.cpuWindow(transport.inventoryNodeId, startUs,
        Math.ceil(demand.charge.cpuMilliseconds * 1_000), 1, CART_CHECKOUT_COMMIT_REQUEST_BYTES);
      if (service === null) {
        release(startUs);
        this.rejectCheckoutAdmission(transport, 'pending-overflow');
        return;
      }
      this.scheduleContinuation(service.doneUs, () => {
        const io = this.cpu.reserveIo(transport.inventoryNodeId, service.doneUs, demand.charge.ioUnits);
        const doneUs = io.doneUs + demand.flushUs;
        this.scheduleContinuation(doneUs, () => {
          // Inventory's order/SKU index is its own working-memory accounting:
          // reserve the growth before the atomic commit so a full node rejects
          // the operation instead of over-committing RAM.
          const indexBefore = inventory.ramIndexBytes;
          const growth = this.inventoryIndexGrowth(transport, indexBefore);
          if (growth > 0) {
            const reserved = this.resources.reserveWorkingRam(transport.inventoryNodeId, growth);
            if (!reserved.ok) {
              release(doneUs);
              this.rejectCheckoutAdmission(transport, 'inventory-ram-full');
              return;
            }
          }
          // The accepted engine alone atomically publishes stock/order/ledger.
          // Even if the client has timed out, an admitted transaction completes.
          const result = inventory.commit(transport.binding, evidence, { atUs: startUs, completedUs: doneUs });
          const actualGrowth = inventory.ramIndexBytes - indexBefore;
          if (growth > actualGrowth) {
            // A validation/selection rejection adds no index row: give the
            // unused standing reservation back instead of leaking it.
            this.resources.releaseWorkingRam(transport.inventoryNodeId, growth - actualGrowth);
          }
          transport.lastResult = result;
          if (result.outcome === 'committed' || result.outcome === 'out-of-stock') transport.committed = true;
          release(doneUs);
          if (transport.settled) return;
          if (doneUs > transport.deadlineUs) {
            this.finishCheckoutResult(transport, result, null);
            return;
          }
          const dispatched = this.dispatchCheckoutTransfer(transport,
            `${transport.id}:commit-reply:${transport.attempt}`, CART_CHECKOUT_REPLY_BYTES,
            { kind: 'node', nodeId: transport.inventoryNodeId },
            { kind: 'node', nodeId: transport.app, instance: transport.appInstance },
            'reply', doneUs, replyUs => this.onCheckoutCommitReplied(transport, replyUs, result),
            () => this.onCheckoutLost(transport, 'commit-reply'));
          if (!dispatched) this.finishCheckoutRouteFailure(transport, 'no-inventory-reply-route');
        });
      });
    });
  }

  private onCheckoutCommitReplied(
    transport: CheckoutTransport,
    arrivedUs: number,
    result: CartInventoryResult,
  ): void {
    if (transport.settled) return;
    if (arrivedUs > transport.deadlineUs) {
      this.finishCheckoutResult(transport, result, null);
      return;
    }
    const service = this.cpuWindow(transport.app, arrivedUs, 100, transport.appInstance, CART_CHECKOUT_REPLY_BYTES);
    if (service === null) {
      this.finishCheckoutResult(transport, result, null);
      return;
    }
    if (service.doneUs > transport.deadlineUs) {
      this.finishCheckoutResult(transport, result, null);
      return;
    }
    this.scheduleContinuation(service.doneUs, () =>
      this.beginCheckoutTerminalReply(transport, service.doneUs, result),
    );
  }

  /** Application → client terminal answer; delivery, not planning, sets the ACK. */
  private beginCheckoutTerminalReply(
    transport: CheckoutTransport,
    atUs: number,
    result: CartInventoryResult,
  ): void {
    if (transport.settled) return;
    const ready = this.cpuWindow(transport.app, atUs, 100, transport.appInstance, CART_CHECKOUT_REPLY_BYTES);
    if (ready === null || ready.doneUs > transport.deadlineUs) {
      this.finishCheckoutResult(transport, result, null);
      return;
    }
    const dispatched = this.dispatchCheckoutTransfer(
      transport,
      `${transport.id}:out:${transport.attempt}`,
      CART_CHECKOUT_REPLY_BYTES,
      { kind: 'node', nodeId: transport.app, instance: transport.appInstance },
      transport.client,
      'reply',
      ready.doneUs,
      (deliveredAtUs) => this.finishCheckoutResult(transport, result, deliveredAtUs),
      () => this.onCheckoutLost(transport, 'out'),
    );
    if (!dispatched) this.finishCheckoutResult(transport, result, null);
  }

  /**
   * Explicit TemporarilyUnavailable answer for an affected request whose
   * Inventory route is unusable. The application can still answer the client
   * over its drawn local path, so the incident cohort gets a terminal response
   * rather than a silent timeout.
   */
  private deliverCheckoutUnavailable(
    transport: CheckoutReplyContext,
    evidenceId: string,
  ): void {
    if (transport.settled) return;
    const ready = this.cpuWindow(transport.app, this.network.currentTimeUs, 100, transport.appInstance, CART_CHECKOUT_REPLY_BYTES);
    if (ready === null || ready.doneUs > transport.deadlineUs) {
      this.finishCheckout(transport, 'unavailable', {
        cohort: transport.cohort,
        acknowledged: false,
        evidenceIds: [evidenceId],
      });
      return;
    }
    const dispatched = this.dispatchCheckoutTransfer(
      transport,
      `${transport.id}:unavailable:${transport.attempt}`,
      CART_CHECKOUT_REPLY_BYTES,
      { kind: 'node', nodeId: transport.app, instance: transport.appInstance },
      transport.client,
      'reply',
      ready.doneUs,
      (deliveredAtUs) => {
        const acknowledged = deliveredAtUs <= transport.deadlineUs;
        this.finishCheckout(transport, 'unavailable', {
          cohort: transport.cohort,
          acknowledged,
          deliveredUs: acknowledged ? deliveredAtUs : null,
          evidenceIds: [evidenceId],
        });
      },
      () =>
        this.finishCheckout(transport, 'unavailable', {
          cohort: transport.cohort,
          acknowledged: false,
          evidenceIds: [evidenceId],
        }),
    );
    if (!dispatched) {
      this.finishCheckout(transport, 'unavailable', {
        cohort: transport.cohort,
        acknowledged: false,
        evidenceIds: [evidenceId],
      });
    }
  }

  private inventoryIndexGrowth(transport: CheckoutTransport, indexBefore: number): number {
    const inventory = this.inventory;
    if (inventory === null) return 0;
    const skus = new Set(Object.keys(inventory.stockSnapshot()));
    for (const line of transport.lines) skus.add(line.sku);
    const predicted =
      (inventory.ledgerRowCount + 1) * CART_INVENTORY_ORDER_INDEX_BYTES +
      skus.size * CART_INVENTORY_SKU_INDEX_BYTES;
    return Math.max(0, predicted - indexBefore);
  }

  /** Bounded admission refused a checkout stage: reject instead of queueing. */
  private rejectCheckoutAdmission(transport: CheckoutTransport, evidenceId: string): void {
    if (transport.settled) return;
    if (transport.exempt) {
      this.deliverCheckoutUnavailable(transport, evidenceId);
      return;
    }
    this.finishCheckout(transport, 'rejected', {
      cohort: transport.cohort,
      rejected: true,
      evidenceIds: [evidenceId],
    });
  }

  private finishCheckoutRouteFailure(
    transport: CheckoutTransport,
    evidenceId: string,
  ): void {
    if (transport.settled) return;
    if (transport.exempt) {
      this.deliverCheckoutUnavailable(transport, evidenceId);
      return;
    }
    this.finishCheckout(transport, 'rejected', {
      cohort: transport.cohort,
      rejected: true,
      evidenceIds: [evidenceId],
    });
  }

  /**
   * One client retry after a transport loss, 25 ms later, with the same
   * original key, binding and absolute deadline. The retry always restarts at
   * Lookup, so a post-commit loss recovers the durable result without a second
   * decrement.
   */
  private onCheckoutLost(
    transport: CheckoutTransport,
    stage: 'ingress' | 'lookup' | 'lookup-reply' | 'commit' | 'commit-reply' | 'out',
  ): void {
    if (transport.settled) return;
    if (transport.retried) {
      this.finishCheckoutAfterLostAttempt(transport);
      return;
    }
    const retryAtUs = this.network.currentTimeUs + CART_CHECKOUT_RETRY_BACKOFF_US;
    if (retryAtUs > transport.deadlineUs) {
      this.finishCheckoutAfterLostAttempt(transport);
      return;
    }
    transport.retried = true;
    transport.attempt += 1;
    this.scheduleContinuation(retryAtUs, () => {
      if (transport.settled) return;
      if (stage === 'ingress') {
        this.beginCheckoutIngress(transport);
      } else {
        // Every retry starts with Lookup on the same binding (CONTRACT B4).
        this.beginCheckoutLookup(transport, retryAtUs);
      }
    });
  }

  private finishCheckoutAfterLostAttempt(transport: CheckoutTransport): void {
    if (transport.lastResult !== null && transport.lastResult.outcome !== 'lookup-miss') {
      this.finishCheckoutResult(transport, transport.lastResult, null);
      return;
    }
    if (transport.committed) {
      const durable: CartInventoryResult = {
        ...(transport.lastResult as CartInventoryResult),
        outcome: 'committed',
      };
      this.finishCheckoutResult(transport, durable, null);
      return;
    }
    this.finishCheckoutTimeout(transport);
  }

  private finishCheckoutTimeout(transport: CheckoutTransport): void {
    if (transport.settled) return;
    if (transport.lastResult !== null && transport.lastResult.outcome !== 'lookup-miss') {
      this.finishCheckoutResult(transport, transport.lastResult, null);
      return;
    }
    this.finishCheckout(transport, transport.exempt ? 'unavailable' : 'timeout', {
      cohort: transport.cohort,
      acknowledged: false,
      evidenceIds: [transport.binding.orderKey],
    });
  }

  /** Records the terminal Inventory outcome with an actual client delivery, if any. */
  private finishCheckoutResult(
    transport: CheckoutTransport,
    result: CartInventoryResult,
    deliveredAtUs: number | null,
  ): void {
    if (transport.settled) return;
    const acknowledged = deliveredAtUs !== null && deliveredAtUs <= transport.deadlineUs;
    // A durable terminal row whose reply never reached the client is not a
    // client success: keep the durable-commit fact, but the observable outcome
    // is a timeout (CONTRACT B4 lost response), so safety never reports a
    // success the client did not receive.
    const outcome = acknowledged ? this.checkoutOutcomeOf(result.outcome) : 'timeout';
    this.finishCheckout(transport, outcome, {
      cohort: transport.cohort,
      committed: result.outcome === 'committed' || result.outcome === 'out-of-stock',
      acknowledged,
      deliveredUs: acknowledged ? deliveredAtUs : null,
      rejected: outcome === 'validation-failed',
      evidenceIds: [
        transport.binding.orderKey,
        ...transport.selection.complete.coveredIds.slice(0, 8),
      ],
    });
  }

  private finishCheckout(
    transport: CheckoutReplyContext,
    outcome: CartRequestOutcome,
    extra: {
      readonly cohort?: CartRequestCohort;
      readonly committed?: boolean;
      readonly acknowledged?: boolean;
      readonly deliveredUs?: number | null;
      readonly rejected?: boolean;
      readonly evidenceIds?: readonly string[];
    },
  ): void {
    if (transport.settled) return;
    transport.settled = true;
    this.openCheckouts.delete(transport.id);
    for (const logicalId of transport.logicalIds) this.settleHandlers.delete(logicalId);
    if (transport.intent !== null) {
      this.record(transport.intent, transport.offeredUs, transport.deadlineUs, outcome, extra);
    } else if (transport.probe !== null && transport.step !== null) {
      this.recordProbe(transport.probe, transport.step, outcome, extra);
    }
  }

  private checkoutOutcomeOf(outcome: CartInventoryOutcome): CartRequestOutcome {
    switch (outcome) {
      case 'committed':
        return 'committed';
      case 'out-of-stock':
        return 'out-of-stock';
      case 'idempotency-conflict':
        return 'conflict';
      case 'selection-changed':
        return 'selection-changed';
      case 'validation-failed':
        return 'validation-failed';
      case 'lookup-miss':
        return 'dependency-failed';
      case 'unavailable':
        return 'unavailable';
    }
  }

  /** Offers that never produced a terminal answer stay unresolved. */
  private finalizeOpenCheckouts(): void {
    for (const transport of [...this.openCheckouts.values()]) {
      if (transport.lastResult !== null && transport.lastResult.outcome !== 'lookup-miss') {
        this.finishCheckoutResult(transport, transport.lastResult, null);
      } else {
        this.finishCheckout(transport, transport.exempt ? 'unavailable' : 'timeout', {
          cohort: transport.cohort,
          acknowledged: false,
          evidenceIds: [transport.binding.orderKey],
        });
      }
    }
  }

  /**
   * Submits one checkout exchange and routes its actual settlement through the
   * shared scheduler. Delivered time is the real arrival the network produced;
   * a cancelled transfer is a lost exchange, never an invented completion.
   */
  private dispatchCheckoutTransfer(
    transport: CheckoutReplyContext,
    logicalId: string,
    bytes: number,
    from: CartEndpoint,
    to: CartEndpoint,
    purpose: 'request' | 'reply',
    atUs: number,
    onDelivered: (deliveredAtUs: number) => void,
    onLost: (transfer: CartTransfer) => void,
  ): boolean {
    const at = Math.max(Math.ceil(atUs), this.network.currentTimeUs);
    if (at > this.network.currentTimeUs) this.advanceTo(at);
    // Continuations run during the advance may have moved the clock past the
    // requested instant; offer at the real model time, never in the past. An
    // offer that lands after the deadline is not admissible: no bytes are
    // serialized and the exchange settles as lost through the caller's path.
    const submitAt = Math.max(at, this.network.currentTimeUs);
    if (submitAt > transport.deadlineUs) return false;
    const result = this.network.submit(
      { logicalId, bytes, from, to, purpose, deadlineUs: transport.deadlineUs },
      submitAt,
    );
    if (!result.ok) return false;
    transport.logicalIds.add(logicalId);
    this.settleHandlers.set(logicalId, (transfer) => {
      if (transfer.status === 'delivered' && transfer.deliveredAtUs !== null) {
        const deliveredAtUs = transfer.deliveredAtUs;
        if (this.shouldDiscardCheckoutReply(logicalId)) {
          // Scoped lost-reply fixture: the reply traversed and was billed
          // normally, then the client observed nothing.
          this.scheduleContinuation(deliveredAtUs, () => onLost(transfer));
          return;
        }
        this.scheduleContinuation(deliveredAtUs, () => onDelivered(deliveredAtUs));
        return;
      }
      const lostAtUs = transfer.cancelledAtUs ?? this.network.currentTimeUs;
      this.scheduleContinuation(lostAtUs, () => onLost(transfer));
    });
    return true;
  }

  private shouldDiscardCheckoutReply(logicalId: string): boolean {
    if (!this.checkoutFaults.discardFirstCommitReply) return false;
    if (this.checkoutReplyDiscarded) return false;
    if (!logicalId.includes(':commit-reply:')) return false;
    this.checkoutReplyDiscarded = true;
    return true;
  }

  // -------------------------------------------------------------------------
  // Probes: preparation and reads execute through the same charged engines.
  // -------------------------------------------------------------------------

  private probeDependencyFailure(step: CartProbeStep): readonly string[] | null {
    const failed: string[] = [];
    for (const parentId of step.dependsOn) {
      const parent = this.recorded.get(parentId);
      if (parent === undefined || !parent.acknowledged) failed.push(parentId);
    }
    return failed.length > 0 ? failed : null;
  }

  private executeProbeStep(probe: CartProbe, step: CartProbeStep): void {
    if (!this.probeIssued.has(probe.id)) {
      this.probeIssued.add(probe.id);
      this.eventCount += 0;
    }
    const stepIndex = probe.steps.findIndex((candidate) => candidate.id === step.id);
    const cohort = this.probeCohort(probe, step);
    this.probeCohorts.set(step.id, cohort);
    // Causal re-add (fixtures.json concurrent.script): the edit "waits removal
    // ACK" and carries the removal as observed context. Its offer is the actual
    // removal ACK (never earlier); a removal that is not ACKed by the declared
    // fallback leaves the normal dependency failure at that fallback instant.
    if (
      step.action === 'edit' &&
      step.trigger === 'ack-relative' &&
      !this.probeReleased.has(step.id)
    ) {
      const pending = step.dependsOn.filter((parentId) => !this.recorded.has(parentId));
      if (pending.length > 0) {
        this.probeDeferred.set(step.id, { probe, step });
        this.scheduleContinuation(step.fallbackAtUs ?? step.atUs, () => this.releaseDeferredProbe(step.id));
        return;
      }
    }
    // CONTRACT B5: a failed prerequisite fails every predetermined descendant at
    // its fixed offer time. The step still yields one terminal record, so the
    // scheduled denominator never shrinks and nothing is rescheduled.
    const blocked = this.probeDependencyFailure(step);
    if (blocked !== null) {
      this.recordProbe(probe, step, 'dependency-failed', {
        dependencyFailed: true,
        evidenceIds: blocked,
      });
      return;
    }
    if (step.action === 'add' || step.action === 'edit') {
      this.executeProbeEdit(probe, step, stepIndex);
      return;
    }
    if (step.action === 'read' || step.action === 'audit') {
      this.executeProbeRead(probe, step, stepIndex);
      return;
    }
    if (step.action === 'checkout') {
      this.executeProbeCheckout(probe, step, stepIndex);
      return;
    }
    // GC-PF5: a concurrent-fixture replay (`identical-edit-retry` actor and the
    // `conflict-retry` probe) re-sends an *edit* envelope, not a checkout. It is
    // the charged original edit operation hitting the edit dedup path, so it
    // never requires a checkout original or an Inventory selection.
    if (step.action === 'replay' && probe.family === 'concurrent') {
      const retry = this.decodeConcurrentEditRetry(probe, step, this.probeCart(probe, step));
      if (retry === null) {
        this.recordProbe(probe, step, 'dependency-failed', {
          dependencyFailed: true,
          evidenceIds: ['edit-original-missing'],
        });
        return;
      }
      this.executeProbeEdit(probe, step, stepIndex);
      return;
    }
    // CONTRACT B4: an explicit replay sends the original order key and binding
    // again; Inventory returns its durable terminal row without a second
    // decrement. It is a distinct logical observation, never a synthetic
    // conflict, so it must go through the real Inventory exchange.
    this.executeProbeReplay(probe, step);
  }

  private probeCart(probe: CartProbe, step: CartProbeStep): string {
    // A probe's steps prepare and exercise one cart. Later steps (read, checkout,
    // replay) omit `cart`, so the cart must come from the probe's preparation
    // step; otherwise the read sees an empty cart and every checkout fails
    // validation instead of executing the frozen fixture.
    const bounded = (id: string): string => id.length <= 64 ? id : sha256Hex(id);
    const own = step.detail.cart;
    if (typeof own === 'string') return bounded(`probe-cart:${own}:${probe.id}`);
    for (const candidate of probe.steps) {
      const cart = candidate.detail.cart;
      if (typeof cart === 'string') return bounded(`probe-cart:${cart}:${probe.id}`);
    }
    return bounded(`probe-cart:${probe.id}`);
  }

  private probeKey(probe: CartProbe, step: CartProbeStep, index: number): CartOperationKey {
    const clientId = `probe:${probe.id}`.slice(0, 64);
    return { originRegion: step.region, clientId, requestSequence: index };
  }

  /**
   * Decodes a declared concurrent-edit step into the observed-unit operation
   * the frozen fixture names (`fixtures.json` concurrent.script): every actor
   * edits the *same SKU as its declared base* with the base operation as its
   * observed context, under its own distinct key (except the explicit
   * old-add replay, which re-sends the original base envelope). Returns null
   * for steps that are ordinary preparation adds.
   */
  private decodeConcurrentEdit(
    probe: CartProbe,
    step: CartProbeStep,
    index: number,
    cartId: string,
  ): { key: CartOperationKey; envelope: CartOperationEnvelope } | null {
    if (step.action === 'replay') return this.decodeConcurrentEditRetry(probe, step, cartId);
    const kind = step.detail.kind;
    const baseId = step.detail.base;
    if (step.action !== 'edit' || typeof kind !== 'string' || typeof baseId !== 'string') return null;
    const baseIndex = probe.steps.findIndex((candidate) => candidate.id === `${probe.id}:${baseId}`);
    const baseStep = baseIndex < 0 ? undefined : probe.steps[baseIndex];
    if (baseStep === undefined) return null;
    const baseSkuRaw = baseStep.detail.sku;
    const sku = (typeof baseSkuRaw === 'string' ? baseSkuRaw : `probe-sku-${baseIndex}`).slice(0, 64);
    const baseCount = typeof baseStep.detail.count === 'number' ? baseStep.detail.count : 1;
    const baseKey = this.probeKey(probe, baseStep, baseIndex);
    const baseOpId = cartOperationId(baseKey);
    const isSecondActor = step.id.endsWith(':actor-2');
    const key = this.probeKey(probe, step, index);
    const make = (
      payload: CartOperationEnvelope['payload'],
      observedContext: readonly string[],
      useKey: CartOperationKey = key,
    ): { key: CartOperationKey; envelope: CartOperationEnvelope } => ({
      key: useKey,
      envelope: { cartId, key: useKey, payload, observedContext },
    });
    const add1 = { sku, kind: 'add' as const, quantity: 1 };
    const remove = { sku, kind: 'remove' as const, quantity: null };
    switch (kind) {
      case 'concurrent-add':
      case 'identical-edit-retry':
        return make(add1, [baseOpId]);
      case 'change-2-to-3':
        return make({ sku, kind: 'change', quantity: 3 }, [baseOpId]);
      case 'change-2-to-1':
        return make({ sku, kind: 'change', quantity: 1 }, [baseOpId]);
      case 'remove-versus-add':
        return isSecondActor ? make(add1, [baseOpId]) : make(remove, [baseOpId]);
      case 'removed-old-add-replay':
        // The second actor replays the *original* base add (same key, same
        // empty-context payload): a duplicate that must not resurrect units.
        return isSecondActor
          ? make({ sku, kind: 'add', quantity: baseCount }, [], baseKey)
          : make(remove, [baseOpId]);
      case 'causal-readd': {
        if (!isSecondActor) return make(remove, [baseOpId]);
        const removalIndex = probe.steps.findIndex((candidate) => candidate.id === `${probe.id}:actor-1`);
        const removalStep = removalIndex < 0 ? undefined : probe.steps[removalIndex];
        if (removalStep === undefined) return null;
        const removalOpId = cartOperationId(this.probeKey(probe, removalStep, removalIndex));
        return make(add1, [baseOpId, removalOpId]);
      }
      default:
        return null;
    }
  }

  /**
   * GC-PF5: decodes a concurrent-fixture `replay` declaration into the edit it
   * re-sends. The original is the charged concurrent edit of the same declared
   * kind (preferring a declared dependency): `identical-edit-retry` re-sends its
   * exact key and payload (a dedup hit with one durable effect), while
   * `conflict-retry` ("same key different lines") re-sends the original key with
   * a changed payload (`IdempotencyConflict`, no mutation). Returns null when no
   * original edit exists.
   */
  private decodeConcurrentEditRetry(
    probe: CartProbe,
    step: CartProbeStep,
    cartId: string,
  ): { key: CartOperationKey; envelope: CartOperationEnvelope } | null {
    const kind = step.detail.kind;
    if (step.action !== 'replay' || typeof kind !== 'string') return null;
    const isEdit = (candidate: CartProbeStep): boolean =>
      candidate.action === 'edit' && candidate.detail.kind === kind && typeof candidate.detail.base === 'string';
    const original =
      step.dependsOn
        .map((id) => probe.steps.find((candidate) => candidate.id === id))
        .find((candidate): candidate is CartProbeStep => candidate !== undefined && isEdit(candidate)) ??
      probe.steps.find(isEdit);
    if (original === undefined) return null;
    const decoded = this.decodeConcurrentEdit(probe, original, probe.steps.indexOf(original), cartId);
    if (decoded === null) return null;
    if (step.detail.expected !== 'IdempotencyConflict') return decoded;
    // Same key, different lines: a changed payload bound to the original key.
    return {
      key: decoded.key,
      envelope: {
        ...decoded.envelope,
        payload: { sku: decoded.envelope.payload.sku, kind: 'add', quantity: 2 },
      },
    };
  }

  /**
   * Probe fixture preparation: the frozen fixture's nonempty cart is built by
   * the *ordinary* charged edit, not by a planned receipt. The step id, offer
   * time and recorded deadline stay exactly as declared; the transfer
   * settlements, durable CPU/IO/flush and reply come from the shared edit
   * stages, so a blocked or late preparation cannot commit or ACK.
   */
  private executeProbeEdit(probe: CartProbe, step: CartProbeStep, index: number): void {
    const cartId = this.probeCart(probe, step);
    const decoded = this.decodeConcurrentEdit(probe, step, index, cartId);
    const key = decoded?.key ?? this.probeKey(probe, step, index);
    // The client/application are the declared step region; durable authority
    // and ledger follow the operation key's origin (an old-add replay returns
    // to the key's original authority as a duplicate, never a second effect).
    const origin = step.region;
    const app = this.appNode(origin);
    const authority = this.facts.authorityByRegion[key.originRegion];
    const ledger = this.ledgers.get(key.originRegion);
    if (
      app === null ||
      authority === null ||
      ledger === undefined ||
      // Like an ordinary edit, the configured authority must be reachable over
      // drawn request edges; a replication-only path cannot authorize a write.
      !this.requestPathReachable(app, authority)
    ) {
      this.recordProbe(probe, step, 'rejected', { rejected: true, evidenceIds: ['topology-unqualified'] });
      return;
    }
    const skuRaw = step.detail.sku;
    const sku = typeof skuRaw === 'string' ? skuRaw : `probe-sku-${index}`;
    const count = typeof step.detail.count === 'number' ? step.detail.count : 1;
    const envelope: CartOperationEnvelope = decoded?.envelope ?? {
      cartId,
      key,
      payload: { sku: sku.slice(0, 64), kind: 'add', quantity: count },
      observedContext: [],
    };
    const protocol: EditProtocol = {
      id: step.id,
      intent: null,
      probe,
      step,
      cartId,
      key,
      origin,
      clientId: key.clientId,
      offeredUs: step.atUs,
      // Fixture preparation is a setup write bounded by CONTRACT B5, so its
      // protocol liveness uses the same foreground window as an equivalent
      // ordinary edit. `recordProbe` keeps the frozen declared deadline.
      deadlineUs: step.atUs + CART_FOREGROUND_DEADLINE_US,
      cohort: this.probeCohorts.get(step.id) ?? probe.cohort,
      exempt: false,
      app,
      appInstance: this.cpu.assignInstance(app),
      authority,
      opId: cartOperationId(key),
      envelope,
      logicalIds: new Set<string>(),
      committed: false,
      acknowledged: false,
      settled: false,
    };
    this.beginEdit(protocol);
  }

  private executeProbeRead(probe: CartProbe, step: CartProbeStep, index: number): void {
    const cartId = this.probeCart(probe, step);
    const cart = this.cartState(cartId);
    const app = this.appNode(step.region);
    if (app === null) {
      this.recordProbe(probe, step, 'rejected', { rejected: true, evidenceIds: ['no-application'] });
      return;
    }
    const engine = this.readEngine(cartId, step.region, app);
    if (engine === null) {
      this.recordProbe(probe, step, 'rejected', { rejected: true, evidenceIds: ['no-write-authority'] });
      return;
    }
    const offeredUs = step.atUs;
    const deadlineUs = step.deadlineUs ?? offeredUs + CART_FOREGROUND_DEADLINE_US;
    const client = this.clientEndpoint(step.region, `probe:${probe.id}`.slice(0, 64));
    const requestBytes = 256 + 32 * cart.tokens.length;
    const protocol = engine.protocol({
      token: { version: CART_SESSION_TOKEN_VERSION, cartId, ids: [...cart.tokens].sort() },
      requestUs: offeredUs,
    });
    const cohort = this.probeCohorts.get(step.id) ?? probe.cohort;
    const transport: ReadTransport = {
      id: step.id,
      offeredUs,
      deadlineUs,
      cohort,
      exempt: cohort === 'incident-affected' || cohort === 'incident-backlog',
      app,
      appInstance: this.cpu.assignInstance(app),
      servedBy: step.region,
      client,
      protocol,
      intent: null,
      probe,
      step,
      logicalIds: new Set<string>(),
      settled: false,
    };
    this.openReads.set(step.id, transport);
    const dispatched = this.submitReadTransfer(
      transport,
      `${step.id}:in`,
      requestBytes,
      client,
      { kind: 'node', nodeId: app, instance: transport.appInstance },
      'request',
      offeredUs,
      (deliveredAtUs) => {
        if (transport.settled) return;
        if (deliveredAtUs > deadlineUs) {
          this.recordProbe(probe, step, 'timeout', {});
          this.abandonRead(transport);
          return;
        }
        this.pumpRead(transport);
      },
      () => {
        if (transport.settled) return;
        this.recordProbe(probe, step, transport.exempt ? 'unavailable' : 'rejected', {
          rejected: !transport.exempt,
          evidenceIds: ['transport-cancelled'],
        });
        this.abandonRead(transport);
      },
    );
    if (!dispatched) {
      this.recordProbe(probe, step, transport.exempt ? 'unavailable' : 'rejected', {
        rejected: !transport.exempt,
        evidenceIds: ['no-request-path'],
      });
      this.abandonRead(transport);
    }
    void index;
  }

  private executeProbeCheckout(probe: CartProbe, step: CartProbeStep, index: number): void {
    const cartId = this.probeCart(probe, step);
    const cart = this.cartState(cartId);
    const selectionId = cart.lastReadId;
    const selection = selectionId === null ? undefined : this.reads.get(selectionId);
    const cohort = this.probeCohorts.get(step.id) ?? probe.cohort;
    const exempt = cohort === 'incident-affected' || cohort === 'incident-backlog';
    if (
      this.inventory === null ||
      this.facts.inventoryNodeId === null ||
      selectionId === null ||
      selection === undefined
    ) {
      this.recordProbe(probe, step, 'dependency-failed', { dependencyFailed: true });
      return;
    }
    const lines = cartCheckoutLinesFromView(selection.complete.view);
    if (lines.length === 0) {
      this.recordProbe(probe, step, 'validation-failed', { rejected: true });
      return;
    }
    const app = this.appNode(step.region);
    if (app === null) {
      this.recordProbe(probe, step, 'rejected', {
        rejected: true,
        evidenceIds: ['no-application'],
      });
      return;
    }
    const orderKey = `probe#${probe.id.slice(0, 40)}#${index}`.slice(0, 64);
    const binding = createCartCheckoutBinding(orderKey, {
      cartId,
      coveredIds: [...selection.complete.coveredIds],
      lines,
    });
    const offeredUs = step.atUs;
    const deadlineUs = step.deadlineUs ?? offeredUs + CART_FOREGROUND_DEADLINE_US;
    const transport: CheckoutTransport = {
      id: step.id,
      intent: null,
      probe,
      step,
      offeredUs,
      deadlineUs,
      cohort,
      exempt,
      app,
      appInstance: this.cpu.assignInstance(app),
      inventoryNodeId: this.facts.inventoryNodeId,
      client: this.clientEndpoint(step.region, `probe:${probe.id}`.slice(0, 64)),
      binding,
      lines,
      selection,
      selectionId,
      logicalIds: new Set<string>(),
      attempt: 0,
      retried: false,
      committed: false,
      lastResult: null,
      settled: false,
    };
    this.openCheckouts.set(step.id, transport);
    this.beginCheckoutIngress(transport);
  }

  /**
   * Explicit replay of an earlier probe purchase. The same order key, binding
   * and selected view are re-sent through the real Application/Inventory
   * exchange, so the durable row answers with its original terminal outcome and
   * no second decrement (CONTRACT B4).
   */
  private executeProbeReplay(probe: CartProbe, step: CartProbeStep): void {
    const cohort = this.probeCohorts.get(step.id) ?? probe.cohort;
    const exempt = cohort === 'incident-affected' || cohort === 'incident-backlog';
    const originalRef = step.detail.original;
    const original =
      typeof originalRef === 'string'
        ? probe.steps.find((candidate) => candidate.id === originalRef)
        : undefined;
    const originalIndex = original === undefined ? -1 : probe.steps.indexOf(original);
    const selectionRef = original?.detail.selection;
    const selectionId = typeof selectionRef === 'string' ? selectionRef : null;
    const selection = selectionId === null ? undefined : this.reads.get(selectionId);
    if (
      this.inventory === null ||
      this.facts.inventoryNodeId === null ||
      original === undefined ||
      originalIndex < 0 ||
      selectionId === null ||
      selection === undefined
    ) {
      this.recordProbe(probe, step, 'dependency-failed', { dependencyFailed: true });
      return;
    }
    const lines = cartCheckoutLinesFromView(selection.complete.view);
    if (lines.length === 0) {
      this.recordProbe(probe, step, 'validation-failed', { rejected: true });
      return;
    }
    const app = this.appNode(step.region);
    if (app === null) {
      this.recordProbe(probe, step, 'rejected', {
        rejected: true,
        evidenceIds: ['no-application'],
      });
      return;
    }
    const orderKey = `probe#${probe.id.slice(0, 40)}#${originalIndex}`.slice(0, 64);
    const binding = createCartCheckoutBinding(orderKey, {
      cartId: this.probeCart(probe, step),
      coveredIds: [...selection.complete.coveredIds],
      lines,
    });
    const offeredUs = step.atUs;
    const deadlineUs = step.deadlineUs ?? offeredUs + CART_FOREGROUND_DEADLINE_US;
    const transport: CheckoutTransport = {
      id: step.id,
      intent: null,
      probe,
      step,
      offeredUs,
      deadlineUs,
      cohort,
      exempt,
      app,
      appInstance: this.cpu.assignInstance(app),
      inventoryNodeId: this.facts.inventoryNodeId,
      client: this.clientEndpoint(step.region, `probe:${probe.id}`.slice(0, 64)),
      binding,
      lines,
      selection,
      selectionId,
      logicalIds: new Set<string>(),
      attempt: 0,
      retried: false,
      committed: false,
      lastResult: null,
      settled: false,
    };
    this.openCheckouts.set(step.id, transport);
    this.beginCheckoutIngress(transport);
  }

  /**
   * Frozen missing-ACK fallback of an ACK-relative step: it fires only when
   * the actual source ACK did not arrive in time to schedule the step. The
   * step is offered at round+1000ms+delay with its own relative deadline and
   * records one honest dependent failure (never a synthetic ACK).
   */
  private executeAckFallback(probe: CartProbe, step: CartProbeStep): void {
    if (this.ackTriggered.has(step.id)) return;
    this.ackTriggered.add(step.id);
    const atUs = step.fallbackAtUs ?? step.atUs;
    const deadlineUs = atUs + ((step.deadlineUs ?? step.atUs + CART_FOREGROUND_DEADLINE_US) - step.atUs);
    const resolved: CartProbeStep = { ...step, atUs, deadlineUs };
    this.probeCohorts.set(step.id, this.probeCohort(probe, resolved));
    const sources = step.dependsOn.filter((id) => {
      const source = probe.steps.find((candidate) => candidate.id === id);
      return source !== undefined && (source.action === 'add' || source.action === 'edit');
    });
    const unmet = this.probeDependencyFailure(resolved) ?? [];
    this.recordProbe(probe, resolved, 'dependency-failed', {
      dependencyFailed: true,
      evidenceIds: [...new Set([...unmet, ...sources])],
    });
  }

  /**
   * An acknowledged source edit schedules its ACK-relative steps at the ACTUAL
   * ACK delivery plus the frozen delay, each with its frozen relative deadline.
   * An ACK later than the fallback offer is treated as missing.
   */
  private scheduleAckRelative(probe: CartProbe, source: CartProbeStep, record: CartRequestRecord): void {
    if (!record.acknowledged || record.deliveredUs === null) return;
    if (source.action !== 'add' && source.action !== 'edit') return;
    const frozenSource = probe.steps.find((candidate) => candidate.id === source.id) ?? source;
    for (const candidate of probe.steps) {
      if (candidate.trigger !== 'ack-relative' || candidate.fallbackAtUs === null) continue;
      if (!candidate.dependsOn.includes(source.id) || this.ackTriggered.has(candidate.id)) continue;
      const atUs = record.deliveredUs + (candidate.atUs - frozenSource.atUs);
      if (atUs > candidate.fallbackAtUs) continue;
      this.ackTriggered.add(candidate.id);
      const relativeDeadlineUs =
        (candidate.deadlineUs ?? candidate.atUs + CART_FOREGROUND_DEADLINE_US) - candidate.atUs;
      const resolved: CartProbeStep = { ...candidate, atUs, deadlineUs: atUs + relativeDeadlineUs };
      const item: WorkItem = { atUs, id: candidate.id, intent: null, step: resolved, probe };
      // Deterministic same-time order (atUs, id); never before the head that
      // is already being executed.
      let index = this.workIndex + (this.executingWork ? 1 : 0);
      while (index < this.work.length) {
        const other = this.work[index] as WorkItem;
        if (other.atUs > atUs || (other.atUs === atUs && other.id > item.id)) break;
        index += 1;
      }
      this.work.splice(index, 0, item);
      this.workDirty = true;
    }
  }

  /** Probe denominator: one record per probe whose steps all executed. */
  private recordProbe(
    probe: CartProbe,
    step: CartProbeStep,
    outcome: CartRequestOutcome,
    extra: {
      readonly committed?: boolean;
      readonly acknowledged?: boolean;
      readonly deliveredUs?: number | null;
      readonly rejected?: boolean;
      readonly dependencyFailed?: boolean;
      readonly evidenceIds?: readonly string[];
    } = {},
  ): void {
    const acknowledged = extra.acknowledged ?? false;
    const cohort = this.probeCohorts.get(step.id) ?? probe.cohort;
    const record: CartRequestRecord = {
      id: step.id,
      caseId: this.caseId,
      cartId: this.probeCart(probe, step),
      region: step.region,
      operation: 'probe',
      cohort,
      offeredUs: step.atUs,
      deadlineUs: step.deadlineUs ?? step.atUs + CART_FOREGROUND_DEADLINE_US,
      deliveredUs: extra.deliveredUs ?? null,
      outcome,
      committed: extra.committed ?? false,
      acknowledged,
      unresolved: !acknowledged && !(extra.rejected ?? false),
      rejected: extra.rejected ?? false,
      dependencyFailed: extra.dependencyFailed ?? false,
      exempt: cohort === 'incident-affected' || cohort === 'incident-backlog',
      deliveryUs: extra.deliveredUs ?? null,
      evidenceIds: extra.evidenceIds ?? [],
    };
    this.records.push(record);
    this.recorded.set(step.id, record);
    this.scheduleAckRelative(probe, step, record);
    this.releaseReadyDeferredProbes();
  }

  private readonly probeDeferred = new Map<string, { probe: CartProbe; step: CartProbeStep }>();
  private readonly probeReleased = new Set<string>();

  private releaseReadyDeferredProbes(): void {
    for (const [id, entry] of this.probeDeferred) {
      if (entry.step.dependsOn.every((parentId) => this.recorded.has(parentId))) {
        this.scheduleContinuation(this.network.currentTimeUs, () => this.releaseDeferredProbe(id));
      }
    }
  }

  private releaseDeferredProbe(id: string): void {
    const entry = this.probeDeferred.get(id);
    if (entry === undefined) return;
    this.probeDeferred.delete(id);
    this.probeReleased.add(id);
    this.executeProbeStep(entry.probe, entry.step);
  }

  /**
   * Recovery barrier: one read per region/cart in C at 54000ms, delivered by
   * 55000ms with V covering C. Empty C still schedules one empty-cart read.
   */
  private runRecoveryBarrier(): void {
    for (const region of CART_REGIONS) {
      const cartIds = new Set<string>();
      for (const cartId of new Set([...this.durableStores.values()].flatMap(store => store.cartIds))) {
        const envelopes = this.cartEnvelopes(cartId);
        for (const envelope of envelopes.values()) {
          const committedAt = this.ledgers.get(envelope.key.originRegion)?.committedAt(cartId, cartOperationId(envelope.key));
          if (committedAt !== undefined && committedAt < CART_INCIDENT_END_US) cartIds.add(cartId);
        }
      }
      if (cartIds.size === 0) cartIds.add(`recovery:${region}:empty`);
      for (const cartId of [...cartIds].sort()) {
        const app = this.appNode(region);
        const engine = app === null ? null : this.readEngine(cartId, region, app);
        let passed = false;
        if (engine !== null) {
          const outcome = engine.read({
            token: { version: CART_SESSION_TOKEN_VERSION, cartId, ids: [] },
            requestUs: CART_RECOVERY_OFFER_US,
            deliveryUs: CART_RECOVERY_OFFER_US + 500,
          });
          passed = outcome.kind === 'complete';
        }
        this.records.push({
          id: `recovery:${region}:${cartId}`,
          caseId: this.caseId,
          cartId,
          region,
          operation: 'audit',
          cohort: 'incident-backlog',
          offeredUs: CART_RECOVERY_OFFER_US,
          deadlineUs: CART_ELIGIBILITY_END_US,
          deliveredUs: passed ? CART_RECOVERY_OFFER_US + 500 : null,
          outcome: passed ? 'committed' : 'unavailable',
          committed: false,
          acknowledged: passed,
          unresolved: !passed,
          rejected: false,
          dependencyFailed: false,
          exempt: true,
          deliveryUs: passed ? CART_RECOVERY_OFFER_US + 500 : null,
          evidenceIds: [],
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cohorts, reachability and records
  // -------------------------------------------------------------------------

  private inIncident(atUs: number): boolean {
    // Fault-free scenarios never schedule the Tokyo partition, so no instant is
    // an incident instant and no request can be classified incident-affected.
    if (this.isFaultFree) return false;
    return atUs >= CART_INCIDENT_START_US && atUs < CART_INCIDENT_END_US;
  }

  /**
   * Dependency-specific reachability: B3 disables both Tokyo WAN pairs, so a
   * request is affected only when its required dependency actually crosses one
   * of those pairs. Local dependencies remain reachable and gated normally.
   */
  private regionReachableEnabled(from: CartRegion, to: CartRegion): boolean {
    if (from === to) return true;
    const seen = new Set<CartRegion>([from]);
    const queue: CartRegion[] = [from];
    while (queue.length > 0) {
      const current = queue.shift() as CartRegion;
      for (const [a, b] of this.facts.regionLinks) {
        if (a !== current || seen.has(b)) continue;
        if (b === to) return true;
        seen.add(b);
        queue.push(b);
      }
    }
    return false;
  }

  private regionReachableAt(from: CartRegion, to: CartRegion, atUs: number): boolean {
    if (from === to) return true;
    if (this.inIncident(atUs) && (from === 'ap-northeast' || to === 'ap-northeast')) return false;
    return this.regionReachableEnabled(from, to);
  }

  private opOrigin(id: string): CartRegion | undefined {
    return this.originOfOp.get(this.opIdByIntent.get(id) ?? id);
  }

  /** Classifies one offer from its actual required routes and the incident. */
  private classify(offerUs: number, required: readonly CartCohortRequirement[]): CartRequestCohort {
    return classifyCartCohort({
      offerUs,
      required,
      reachableEnabled: (requirement) => this.regionReachableEnabled(requirement.from, requirement.to),
      reachableAt: (requirement, atUs) => this.regionReachableAt(requirement.from, requirement.to, atUs),
    });
  }

  /**
   * Actual required dependencies of one scheduled intent:
   * - other edits need their observed context origins plus the write authority;
   * - reads need token dependencies plus all origin coverage certificates;
   * - new checkouts need their selected view's evidence origins plus Inventory.
   * Local edits (context locally available at offer, empty included) are gated
   * separately and never exempted by this classifier.
   */
  private intentRequirements(intent: CartOperationIntent): CartCohortRequirement[] {
    const region =
      intent.operation === 'read' && intent.effect.kind === 'read'
        ? intent.effect.servedBy
        : intent.key.originRegion;
    const targets = new Set<CartRegion>();
    if (intent.operation === 'edit') {
      for (const id of intent.observedContext) {
        const origin = this.opOrigin(id);
        if (origin !== undefined) targets.add(origin);
      }
      targets.add(intent.key.originRegion);
    } else if (intent.operation === 'read') {
      if (intent.effect.kind === 'read') {
        for (const id of intent.effect.token) {
          const origin = this.opOrigin(id);
          if (origin !== undefined) targets.add(origin);
        }
      }
      // A globally fresh read needs every origin's coverage certificate.
      for (const dependency of CART_REGIONS) targets.add(dependency);
    } else {
      const selectionId = intent.effect.kind === 'checkout' ? intent.effect.selectionReadId : null;
      const selection = selectionId === null ? undefined : this.reads.get(selectionId);
      if (selection !== undefined) {
        for (const id of selection.complete.coveredIds) {
          const origin = this.opOrigin(id);
          if (origin !== undefined) targets.add(origin);
        }
      }
      for (const dependency of CART_REGIONS) targets.add(dependency);
      if (this.facts.inventoryRegion !== null) targets.add(this.facts.inventoryRegion);
    }
    return [...targets].map((to) => ({ from: region, to }));
  }

  /** Actual required routes of one probe step (mirrors the intent rules). */
  private probeRequirements(probe: CartProbe, step: CartProbeStep): CartCohortRequirement[] {
    if (step.action === 'add' || step.action === 'edit') return [];
    const targets = new Set<CartRegion>();
    if (step.action === 'read' || step.action === 'audit') {
      for (const dependency of CART_REGIONS) targets.add(dependency);
    } else {
      for (const dependency of CART_REGIONS) targets.add(dependency);
      if (this.facts.inventoryRegion !== null) targets.add(this.facts.inventoryRegion);
    }
    for (const depId of step.dependsOn) {
      const origin = this.opOrigin(depId);
      if (origin !== undefined) {
        targets.add(origin);
      } else {
        const dependencyStep = probe.steps.find((candidate) => candidate.id === depId);
        if (dependencyStep !== undefined) targets.add(dependencyStep.region);
      }
    }
    return [...targets].map((to) => ({ from: step.region, to }));
  }

  /**
   * Probe cohort from actual dependencies. The fixture's declared cohort only
   * survives when the computed exemption agrees with it: a declared affected
   * probe with an unhealthy dependency is downgraded to a normal gate, and a
   * declared healthy probe whose dependency the incident removes is exempted.
   */
  private probeCohort(probe: CartProbe, step: CartProbeStep): CartRequestCohort {
    if (step.action === 'add' || step.action === 'edit') {
      // Context is locally available at offer: local-context gates are retained.
      return 'local-context-edit';
    }
    const computed = this.classify(step.atUs, this.probeRequirements(probe, step));
    if (computed !== 'healthy') return computed;
    return probe.cohort === 'dedicated-probe' || probe.cohort === 'local-context-edit'
      ? probe.cohort
      : 'healthy';
  }

  private editCohort(intent: CartOperationIntent): CartRequestCohort {
    const locallyAvailable = intent.observedContext.every((id) =>
      this.isCommitted(intent.cartId, this.opIdByIntent.get(id) ?? id),
    );
    if (locallyAvailable) return 'local-context-edit';
    return this.classify(intent.atUs, this.intentRequirements(intent));
  }

  private readCohort(intent: CartOperationIntent): CartRequestCohort {
    return this.classify(intent.atUs, this.intentRequirements(intent));
  }

  private checkoutCohort(intent: CartOperationIntent): CartRequestCohort {
    return this.classify(intent.atUs, this.intentRequirements(intent));
  }

  private record(
    intent: CartOperationIntent,
    offeredUs: number,
    deadlineUs: number,
    outcome: CartRequestOutcome,
    extra: {
      readonly cohort?: CartRequestCohort;
      readonly committed?: boolean;
      readonly acknowledged?: boolean;
      readonly deliveredUs?: number | null;
      readonly rejected?: boolean;
      readonly dependencyFailed?: boolean;
      readonly evidenceIds?: readonly string[];
    } = {},
  ): void {
    const cohort = extra.cohort ?? 'healthy';
    const exempt = cohort === 'incident-affected' || cohort === 'incident-backlog';
    const delivered = extra.deliveredUs ?? null;
    const record: CartRequestRecord = {
      id: intent.id,
      caseId: this.caseId,
      cartId: intent.cartId,
      region: intent.region,
      operation: intent.operation,
      cohort,
      offeredUs,
      deadlineUs,
      deliveredUs: delivered,
      outcome,
      committed: extra.committed ?? false,
      acknowledged: extra.acknowledged ?? false,
      unresolved: extra.acknowledged !== true && !(extra.rejected ?? false),
      rejected: extra.rejected ?? false,
      dependencyFailed: extra.dependencyFailed ?? false,
      exempt,
      deliveryUs: delivered,
      evidenceIds: extra.evidenceIds ?? [],
    };
    this.records.push(record);
    this.recorded.set(intent.id, record);
  }
}
