/**
 * GC-009 — token-aware reads, repair and honest degraded outcomes
 * (`cart-protocol-v1` §4 and B2).
 *
 * Two read policies share one reducer and one session rule:
 *
 * - `local-repair` queries the local configured target first, then the distinct
 *   remaining targets in fixed region/kind order, stopping only on complete
 *   evidence.
 * - `parallel` starts every configured target, merges whatever actually arrived,
 *   then fetches the missing origin evidence over the same allowed paths.
 *
 * Neither policy invents targets or contents. Fan-out buys latency, never a
 * completeness guarantee: a successful read needs the incoming token covered by
 * causally closed durable data *and* every origin certificate fresh at client
 * delivery. Anything less is `partial` (a `PartialCart` diagnostic that never
 * counts as success) or `unavailable`.
 */
import {
  CART_REGIONS,
  type CartRegion,
} from '../contracts';
import {
  acceptCartOperation,
  createCartOperationLog,
  materializeCartView,
  type CartMaterializationWork,
  type CartMaterializedView,
} from './cart-state';
import type { CartDurableReadResult, CartSessionToken } from './durable-store';
import { cartEditEnvelopeBytes } from './durable-store';
import { cartOperationId, type CartOperationEnvelope } from './operations';
import type { CartVolatileCache, CartCacheEntry } from './cache';
import {
  CART_MERGE_ITEM_CPU_MS,
  CART_MISSING_ID_REQUEST_BASE_BYTES,
  CART_READ_ATTEMPT_CPU_MS,
  CART_UNAVAILABLE_RESPONSE_BYTES,
  auditCartCertificates,
  cartCertificateBytes,
  cartCoveredViewBytes,
  cartDeliveryFreshnessCut,
  cartDurableCommitMatches,
  cartMissingIdRequestBytes,
  cartReadRequestBytes,
  cartTokenMissing,
  cartTokenUnion,
  isAuthorityIssuedCertificate,
  isCertificateIssuedBy,
  isReplicatedCertificate,
  mergeCartCertificates,
  parseCartSessionToken,
  type CartCertificate,
  type CartDurableCommit,
  type CartOriginCommitLedger,
  type CartReplicatedCertificate,
  type CartTokenIssueReason,
} from './tokens';

export type CartReadPolicy = 'local-repair' | 'parallel';
export type CartReadNodeKind = 'application' | 'cache' | 'journal' | 'store';

/**
 * Where a target's coverage statement comes from.
 *
 * - `authority`: the node itself is the configured immutable write authority for
 *   that origin and exposes the modeled authority durable ledger. The read
 *   recognizes that exact ledger object; only it may mint a new certificate.
 * - `replica`: the node carries an earlier authority-issued certificate that
 *   arrived through explicit completed replication. A replica may never mint,
 *   refresh or advance the cut of what it carries.
 */
export type CartCertificateSource =
  | {
      readonly role: 'authority';
      readonly kind: 'journal' | 'store';
      readonly ledger: CartOriginCommitLedger;
    }
  | {
      readonly role: 'replica';
      readonly carry: CartReplicatedCertificate;
    };

/**
 * One node a read may explicitly interrogate. `durableRead` is the GC-008
 * charged durable read; `certifies` exposes an origin whose coverage this node
 * can answer from its own authority state or from replicated evidence.
 */
export interface CartReadNode {
  readonly nodeId: string;
  readonly region: CartRegion;
  readonly kind: CartReadNodeKind;
  reachable(atUs: number): boolean;
  /** Volatile cache attached to this node, if any. */
  cache?(): CartVolatileCache | undefined;
  durableRead?(cartId: string): CartDurableReadResult;
  /** Retained envelope for a client-visible operation id. */
  envelope?(cartId: string, operationId: string): CartOperationEnvelope | undefined;
  certifies?(origin: CartRegion): CartCertificateSource | undefined;
}

/** Deterministic target order: local region first, then fixed region/kind order. */
const KIND_ORDER: Readonly<Record<CartReadNodeKind, number>> = {
  application: 0,
  cache: 1,
  journal: 2,
  store: 3,
};

export function orderCartReadTargets(
  targets: readonly CartReadNode[],
  localRegion: CartRegion,
): CartReadNode[] {
  const regionOrder = (region: CartRegion): number =>
    region === localRegion ? -1 : CART_REGIONS.indexOf(region);
  return [...targets].sort((left, right) => {
    const byRegion = regionOrder(left.region) - regionOrder(right.region);
    if (byRegion !== 0) return byRegion;
    const byKind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    if (byKind !== 0) return byKind;
    return left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0;
  });
}

export interface CartReadAttempt {
  readonly nodeId: string;
  readonly region: CartRegion;
  readonly kind: CartReadNodeKind | 'client';
  readonly phase: 'local' | 'fallback' | 'parallel' | 'repair' | 'refresh';
  readonly reachable: boolean;
  readonly coveredIds: readonly string[];
  readonly certificates: readonly CartRegion[];
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly cpuMilliseconds: number;
  readonly ioUnits: number;
  /**
   * Cache-supplied material refused because its origin authority or durable
   * provenance did not match the modeled topology. Discarded data never counts
   * toward coverage, freshness or response bytes.
   */
  readonly discarded?: readonly string[];
}

export interface CartReadCharge {
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly cpuMilliseconds: number;
  readonly ioUnits: number;
  readonly requests: number;
}

export interface CartReadRequest {
  readonly token: CartSessionToken;
  /** Request launch time; certificates cut at `requestUs - 1µs`. */
  readonly requestUs: number;
  /** Client delivery time; freshness is audited here, never at launch. */
  readonly deliveryUs: number;
  /** Modeled time of the single allowed refresh round. */
  readonly refreshUs?: number;
}

export interface CartReadEvidence {
  readonly coveredIds: readonly string[];
  readonly certificates: readonly CartCertificate[];
  readonly requiredCutUs: number;
  readonly minimumCutUs: number;
  readonly staleOrigins: readonly CartRegion[];
  readonly missingOrigins: readonly CartRegion[];
}

export interface CartReadComplete {
  readonly kind: 'complete';
  readonly cartId: string;
  readonly view: CartMaterializedView;
  readonly incomingToken: CartSessionToken;
  readonly outgoingToken: CartSessionToken;
  readonly coveredIds: readonly string[];
  readonly evidence: CartReadEvidence;
  readonly attempts: readonly CartReadAttempt[];
  readonly charge: CartReadCharge;
  /** Durable nodes whose actual retained data formed the covered set. */
  readonly dataSources: readonly string[];
}

export interface CartReadPartial {
  readonly kind: 'partial';
  readonly cartId: string;
  /** Diagnostic only; never counts as a successful complete read. */
  readonly reason: 'missing-origin-evidence' | 'causal-gap';
  readonly view: CartMaterializedView;
  readonly incomingToken: CartSessionToken;
  readonly outgoingToken: CartSessionToken;
  readonly coveredIds: readonly string[];
  readonly missingTokenIds: readonly string[];
  readonly evidence: CartReadEvidence;
  readonly attempts: readonly CartReadAttempt[];
  readonly charge: CartReadCharge;
  readonly dataSources: readonly string[];
}

export interface CartReadUnavailable {
  readonly kind: 'unavailable';
  readonly cartId: string;
  readonly reason:
    | 'unknown-token'
    | 'no-reachable-target'
    | 'unreachable-token-operations'
    | 'unreachable-coverage-operations'
    | 'stale-evidence';
  readonly message: string;
  readonly missingTokenIds: readonly string[];
  readonly missingOrigins: readonly CartRegion[];
  readonly staleOrigins: readonly CartRegion[];
  readonly attempts: readonly CartReadAttempt[];
  readonly charge: CartReadCharge;
  readonly dataSources: readonly string[];
}

export type CartReadOutcome = CartReadComplete | CartReadPartial | CartReadUnavailable;

/**
 * Everything a resumable read needs before any traffic exists. `deliveryBoundUs`
 * is the latest delivery the caller may report to `complete`: refresh decisions
 * are made against that bound so evidence can never be assumed fresh for an
 * arrival that has not happened yet.
 */
export interface CartReadStart {
  readonly token: CartSessionToken;
  /** Request launch time; certificates cut at the actual service start − 1µs. */
  readonly requestUs: number;
  /** Modeled time of the single allowed refresh round. */
  readonly refreshUs?: number;
  readonly deliveryBoundUs?: number;
}

/**
 * One request/response exchange the caller must execute on the real transport.
 * `requestBytes` is the modeled request size; `atUs` is the earliest launch
 * time. The engine supplies the response size only after the request actually
 * arrived (`settleRequest`), so a reply can never be billed for data that was
 * never collected.
 */
export interface CartReadExchange {
  readonly stepId: string;
  readonly nodeId: string;
  readonly region: CartRegion;
  readonly kind: CartReadNodeKind;
  readonly phase: CartReadAttempt['phase'];
  readonly atUs: number;
  readonly requestBytes: number;
}

export interface CartReadReply {
  readonly stepId: string;
  readonly nodeId: string;
  readonly responseBytes: number;
  readonly cpuMilliseconds: number;
  readonly ioUnits: number;
}

export type CartReadProgress =
  | { readonly kind: 'exchange'; readonly exchange: CartReadExchange }
  | { readonly kind: 'wait' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'done'; readonly outcome: CartReadOutcome };

/**
 * Resumable read protocol. `next()` yields the next exchange (or `wait` while
 * one is outstanding, or `ready` when every stage finished); data enters the
 * collected state only in `settleReply`, and the terminal outcome is computed
 * by `complete` at the actual client delivery time.
 */
export interface CartReadProtocol {
  next(): CartReadProgress;
  settleRequest(
    stepId: string,
    settlement: { readonly serviceStartUs: number | null },
  ): CartReadReply | null;
  settleReply(stepId: string, settlement: { readonly arrivedUs: number | null }): void;
  complete(deliveryUs: number): CartReadOutcome;
}

export interface CartReadEngineOptions {
  readonly cartId: string;
  readonly policy: CartReadPolicy;
  readonly localRegion: CartRegion;
  readonly targets: readonly CartReadNode[];
  /**
   * Configured immutable write authority per origin. Every certificate and
   * cached envelope is checked against this modeled topology, so a cache can
   * never mint coverage evidence or vouch for unproven data.
   */
  readonly authorities: Readonly<Record<CartRegion, string>>;
  /**
   * The modeled authority durable ledger object per origin. This is the only
   * object permitted to mint a new certificate: a target claiming authority is
   * accepted only when it presents exactly this ledger, so a caller-built
   * ledger with a colliding node id never counts as issuance. Replicas may only
   * carry certificates this ledger already issued.
   */
  readonly authorityLedgers: Readonly<Record<CartRegion, CartOriginCommitLedger>>;
  /** Observe real issuance; adapters must wait for charged service completion before forwarding. */
  readonly onCertificateIssued?: (nodeId: string, certificate: CartCertificate) => void;
}

interface Collected {
  readonly envelopes: Map<string, CartOperationEnvelope>;
  readonly sources: Map<string, string>;
  readonly certificates: Map<CartRegion, CartCertificate>;
  readonly attempts: CartReadAttempt[];
  requestBytes: number;
  responseBytes: number;
  cpuMilliseconds: number;
  ioUnits: number;
  requests: number;
}

function collected(): Collected {
  return {
    envelopes: new Map(),
    sources: new Map(),
    certificates: new Map(),
    attempts: [],
    requestBytes: 0,
    responseBytes: 0,
    cpuMilliseconds: 0,
    ioUnits: 0,
    requests: 0,
  };
}

function cloneCollected(source: Collected): Collected {
  return {
    envelopes: new Map(source.envelopes),
    sources: new Map(source.sources),
    certificates: new Map(source.certificates),
    attempts: [...source.attempts],
    requestBytes: source.requestBytes,
    responseBytes: source.responseBytes,
    cpuMilliseconds: source.cpuMilliseconds,
    ioUnits: source.ioUnits,
    requests: source.requests,
  };
}

/**
 * Applies exactly one exchange's delta. `base` is the collected snapshot the
 * exchange started from, so only real contributions are added: an exchange that
 * delivered nothing (or arrived after cancellation) changes no counters.
 */
function applyCollectedDelta(target: Collected, base: Collected, scratch: Collected): void {
  for (const [operationId, envelope] of scratch.envelopes) {
    if (target.envelopes.has(operationId)) continue;
    target.envelopes.set(operationId, envelope);
    const source = scratch.sources.get(operationId);
    if (source !== undefined) target.sources.set(operationId, source);
  }
  const merged = mergeCartCertificates(
    target.certificates.values(),
    scratch.certificates.values(),
  );
  target.certificates.clear();
  for (const certificate of merged) target.certificates.set(certificate.origin, certificate);
  target.attempts.push(...scratch.attempts.slice(base.attempts.length));
  target.requestBytes += scratch.requestBytes - base.requestBytes;
  target.responseBytes += scratch.responseBytes - base.responseBytes;
  target.cpuMilliseconds += scratch.cpuMilliseconds - base.cpuMilliseconds;
  target.ioUnits += scratch.ioUnits - base.ioUnits;
  target.requests += scratch.requests - base.requests;
}

/**
 * Applies only the work an exchange actually performed, never the data it
 * would have delivered. Used when the response is lost after service: the
 * node's CPU/IO and the attempt stay charged — the work really happened — while
 * envelopes, certificates and response bytes are withheld, because undelivered
 * data is not evidence.
 */
function applyPerformedWorkDelta(target: Collected, base: Collected, scratch: Collected): void {
  for (const attempt of scratch.attempts.slice(base.attempts.length)) {
    target.attempts.push({
      ...attempt,
      reachable: true,
      coveredIds: [],
      certificates: [],
      responseBytes: 0,
    });
  }
  target.requestBytes += scratch.requestBytes - base.requestBytes;
  target.cpuMilliseconds += scratch.cpuMilliseconds - base.cpuMilliseconds;
  target.ioUnits += scratch.ioUnits - base.ioUnits;
  target.requests += scratch.requests - base.requests;
}

interface PendingExchange {
  readonly role: 'probe' | 'repair-token' | 'refresh' | 'repair-cert';
  readonly exchange: CartReadExchange;
  readonly base: Collected;
  readonly compute: (base: Collected, serviceStartUs: number) => Collected | null;
  contribution: Collected | null;
}

/** A read that fails before any exchange (bad token) is already terminal. */
function settledReadProtocol(outcome: CartReadOutcome): CartReadProtocol {
  return {
    next: () => ({ kind: 'done', outcome }),
    settleRequest: () => {
      throw new RangeError('a settled read protocol has no exchanges');
    },
    settleReply: () => {
      throw new RangeError('a settled read protocol has no exchanges');
    },
    complete: () => outcome,
  };
}


export class CartReadEngine {
  readonly cartId: string;
  readonly policy: CartReadPolicy;
  readonly localRegion: CartRegion;
  readonly authorities: Readonly<Record<CartRegion, string>>;
  readonly onCertificateIssued?: (nodeId: string, certificate: CartCertificate) => void;
  readonly authorityLedgers: Readonly<Record<CartRegion, CartOriginCommitLedger>>;
  private readonly targets: readonly CartReadNode[];

  constructor(options: CartReadEngineOptions) {
    if (options.targets.length === 0) {
      throw new RangeError('a read engine requires at least one configured target');
    }
    for (const origin of CART_REGIONS) {
      const authority = options.authorities[origin];
      if (typeof authority !== 'string' || authority.length === 0) {
        throw new RangeError(`read engine requires a configured write authority for ${origin}`);
      }
      const ledger = options.authorityLedgers[origin];
      if (ledger === undefined || ledger.nodeId !== authority) {
        throw new RangeError(
          `read engine requires the configured durable ledger of the ${origin} authority`,
        );
      }
    }
    this.onCertificateIssued = options.onCertificateIssued;
    this.cartId = options.cartId;
    this.policy = options.policy;
    this.localRegion = options.localRegion;
    this.authorities = options.authorities;
    this.authorityLedgers = options.authorityLedgers;
    this.targets = options.targets;
  }

  /**
   * The synchronous read API is an adapter over the resumable protocol: the
   * same stages, the same probe/repair/refresh rules and the same collected
   * state. It settles every exchange at the exchange's modeled time, which is
   * exactly the semantics this API always had. It is *not* a second algorithm,
   * so callers that can execute transfers on the shared scheduler use
   * `protocol()` directly and get identical evidence rules with real arrival
   * times.
   */
  read(request: CartReadRequest): CartReadOutcome {
    const protocol = this.protocol({
      token: request.token,
      requestUs: request.requestUs,
      deliveryBoundUs: request.deliveryUs,
      ...(request.refreshUs === undefined ? {} : { refreshUs: request.refreshUs }),
    });
    for (;;) {
      const progress = protocol.next();
      if (progress.kind === 'ready') return protocol.complete(request.deliveryUs);
      if (progress.kind === 'done') return progress.outcome;
      if (progress.kind === 'wait') {
        throw new Error('synchronous read adapter cannot wait on an unsettled exchange');
      }
      const exchange = progress.exchange;
      const reply = protocol.settleRequest(exchange.stepId, { serviceStartUs: exchange.atUs });
      if (reply !== null) protocol.settleReply(exchange.stepId, { arrivedUs: exchange.atUs });
    }
  }

  /**
   * Resumable, deterministic read protocol.
   *
   * Every target contact is an explicit request/response exchange the caller
   * executes on the shared scheduler. The engine never assumes a contact
   * completed: evidence and data enter the collected state only in
   * `settleReply`, at the actual response arrival the caller reports, and the
   * authority certificate cut uses the actual authority service start. A
   * cancelled or late exchange contributes nothing.
   */
  protocol(start: CartReadStart): CartReadProtocol {
    const parsed = parseCartSessionToken(start.token);
    if (!parsed.ok) {
      return settledReadProtocol(
        this.unavailableFromToken('unknown-token', start.token, parsed.reason, parsed.message),
      );
    }
    if (parsed.token.cartId !== this.cartId) {
      return settledReadProtocol(
        this.unavailableFromToken(
          'unknown-token',
          start.token,
          'token-cart-mismatch',
          `session token belongs to cart ${parsed.token.cartId}`,
        ),
      );
    }
    const token = parsed.token;
    const requestUs = start.requestUs;
    const cutUs = requestUs - 1;
    const refreshUs = start.refreshUs ?? requestUs + 1_000;
    const refreshCutUs = refreshUs - 1;
    const ordered = orderCartReadTargets(this.targets, this.localRegion);
    let state = collected();
    let anyReachable = false;
    let stage: 'probe' | 'repair-token' | 'refresh' | 'repair-cert' | 'done' = 'probe';
    let probeIndex = 0;
    let refreshIndex = 0;
    let refreshNeeded: boolean | null = null;
    let outcome: CartReadOutcome | null = null;
    let readyReached = false;
    let seq = 0;
    const pending = new Map<string, PendingExchange>();

    const phaseOf = (target: CartReadNode): CartReadAttempt['phase'] =>
      this.policy === 'parallel'
        ? 'parallel'
        : target.region === this.localRegion
          ? 'local'
          : 'fallback';

    const advanceAfter = (role: PendingExchange['role']): void => {
      if (role === 'repair-token') {
        stage = 'refresh';
        refreshNeeded = null;
        return;
      }
      if (role === 'repair-cert') stage = 'done';
    };

    const begin = (
      role: PendingExchange['role'],
      target: CartReadNode,
      phase: CartReadAttempt['phase'],
      atUs: number,
      requestBytes: number,
      compute: (base: Collected, serviceStartUs: number) => Collected | null,
    ): CartReadExchange => {
      const exchange: CartReadExchange = {
        stepId: `${this.cartId}:${seq}`,
        nodeId: target.nodeId,
        region: target.region,
        kind: target.kind,
        phase,
        atUs,
        requestBytes,
      };
      seq += 1;
      pending.set(exchange.stepId, {
        role,
        exchange,
        base: cloneCollected(state),
        compute,
        contribution: null,
      });
      return exchange;
    };

    const next = (): CartReadProgress => {
      if (outcome !== null) return { kind: 'done', outcome };
      if (pending.size > 0 && !(this.policy === 'parallel' && stage === 'probe')) {
        return { kind: 'wait' };
      }
      for (;;) {
        if (outcome !== null) return { kind: 'done', outcome };
        if (stage === 'probe') {
          if (
            probeIndex >= ordered.length ||
            (this.policy !== 'parallel' && this.isComplete(state, token))
          ) {
            // Parallel fan-out must issue every configured target before it
            // waits; a local-repair read may stop early, a parallel read may
            // not, because an early stop would silently drop coverage.
            if (pending.size > 0) return { kind: 'wait' };
            stage = 'repair-token';
            continue;
          }
          const target = ordered[probeIndex] as CartReadNode;
          probeIndex += 1;
          if (!target.reachable(requestUs)) {
            // An unreachable target sends no request: record the attempt with
            // no wire traffic, exactly as the frozen read rules require.
            const scratch = cloneCollected(state);
            this.probe(target, token.ids.length, cutUs, false, phaseOf(target), scratch);
            state = scratch;
            continue;
          }
          anyReachable = true;
          const phase = phaseOf(target);
          return {
            kind: 'exchange',
            exchange: begin(
              'probe',
              target,
              phase,
              requestUs,
              cartReadRequestBytes(token.ids.length),
              (base, serviceStartUs) => {
                const scratch = cloneCollected(base);
                this.probe(target, token.ids.length, serviceStartUs - 1, true, phase, scratch);
                return scratch;
              },
            ),
          };
        }
        if (stage === 'repair-token') {
          const missing = cartTokenMissing(token, state.envelopes.keys());
          if (missing.length === 0) {
            stage = 'refresh';
            continue;
          }
          const target = ordered.find(
            (candidate) =>
              candidate.reachable(requestUs) &&
              missing.some((id) => candidate.envelope?.(this.cartId, id) !== undefined),
          );
          if (target === undefined) {
            outcome = this.unavailable('unreachable-token-operations', state, missing, []);
            continue;
          }
          anyReachable = true;
          return {
            kind: 'exchange',
            exchange: begin(
              'repair-token',
              target,
              'repair',
              requestUs,
              cartMissingIdRequestBytes(missing.length),
              (base) => {
                const scratch = cloneCollected(base);
                this.repair(target, cartTokenMissing(token, base.envelopes.keys()), scratch);
                return scratch;
              },
            ),
          };
        }
        if (stage === 'refresh') {
          if (refreshNeeded === null) {
            const requiredCutUs = cartDeliveryFreshnessCut(start.deliveryBoundUs ?? requestUs);
            refreshNeeded =
              CART_REGIONS.some((region) => !state.certificates.has(region)) ||
              [...state.certificates.values()].some(
                (certificate) => certificate.cutUs < requiredCutUs,
              );
          }
          if (!refreshNeeded) {
            stage = 'repair-cert';
            continue;
          }
          while (refreshIndex < ordered.length) {
            const target = ordered[refreshIndex] as CartReadNode;
            refreshIndex += 1;
            if (!target.reachable(refreshUs)) continue;
            if (this.previewIssue(target, refreshCutUs, state).length === 0) {
              continue;
            }
            return {
              kind: 'exchange',
              exchange: begin(
                'refresh',
                target,
                'refresh',
                refreshUs,
                CART_MISSING_ID_REQUEST_BASE,
                (base, serviceStartUs) => {
                  const scratch = cloneCollected(base);
                  this.issueCertificates(target, serviceStartUs - 1, 'refresh', scratch);
                  return scratch.requests === base.requests ? null : scratch;
                },
              ),
            };
          }
          stage = 'repair-cert';
          continue;
        }
        if (stage === 'repair-cert') {
          const missing = this.missingCertificateIds(state, token);
          if (missing.length === 0) {
            stage = 'done';
            continue;
          }
          const target = ordered.find(
            (candidate) =>
              candidate.reachable(requestUs) &&
              missing.some((id) => candidate.envelope?.(this.cartId, id) !== undefined),
          );
          if (target === undefined) {
            outcome = this.unavailable('unreachable-coverage-operations', state, missing, []);
            continue;
          }
          anyReachable = true;
          return {
            kind: 'exchange',
            exchange: begin(
              'repair-cert',
              target,
              'repair',
              requestUs,
              cartMissingIdRequestBytes(missing.length),
              (base) => {
                const scratch = cloneCollected(base);
                const ids = this.missingCertificateIds(scratch, token);
                if (ids.length > 0) this.repair(target, ids, scratch);
                return scratch;
              },
            ),
          };
        }
        readyReached = true;
        return { kind: 'ready' };
      }
    };

    const settleRequest = (
      stepId: string,
      settlement: { readonly serviceStartUs: number | null },
    ): CartReadReply | null => {
      const current = pending.get(stepId) ?? null;
      if (current === null) {
        throw new RangeError(`unknown cart read exchange ${stepId}`);
      }
      if (settlement.serviceStartUs === null) {
        // The request never reached the node: no data, no evidence, no reply and
        // no charge. The live collected state is *not* rolled back to this
        // exchange's snapshot — a parallel sibling may already have delivered
        // evidence after that snapshot was taken, and one failed contact must
        // never erase another exchange's completed work.
        state.attempts.push({
          nodeId: current.exchange.nodeId,
          region: current.exchange.region,
          kind: current.exchange.kind,
          phase: current.exchange.phase,
          reachable: false,
          coveredIds: [],
          certificates: [],
          requestBytes: 0,
          responseBytes: 0,
          cpuMilliseconds: 0,
          ioUnits: 0,
        });
        pending.delete(stepId);
        advanceAfter(current.role);
        return null;
      }
      const contribution = current.compute(current.base, settlement.serviceStartUs);
      if (contribution === null) {
        pending.delete(stepId);
        advanceAfter(current.role);
        return null;
      }
      current.contribution = contribution;
      return {
        stepId,
        nodeId: current.exchange.nodeId,
        responseBytes: Math.max(0, contribution.responseBytes - current.base.responseBytes),
        cpuMilliseconds: Math.max(
          0,
          contribution.cpuMilliseconds - current.base.cpuMilliseconds,
        ),
        ioUnits: Math.max(0, contribution.ioUnits - current.base.ioUnits),
      };
    };

    const settleReply = (
      stepId: string,
      settlement: { readonly arrivedUs: number | null },
    ): void => {
      const current = pending.get(stepId) ?? null;
      if (current === null) {
        throw new RangeError(`unknown cart read exchange ${stepId}`);
      }
      if (settlement.arrivedUs !== null && current.contribution !== null) {
        applyCollectedDelta(state, current.base, current.contribution);
      } else if (current.contribution !== null) {
        // The node really performed the work (it reported a service start) but
        // the response never arrived. Performed CPU/IO/requests stay charged;
        // every delivered byte, envelope and certificate is withheld, because
        // undelivered data is not evidence.
        applyPerformedWorkDelta(state, current.base, current.contribution);
      }
      pending.delete(stepId);
      advanceAfter(current.role);
    };

    return {
      next,
      settleRequest,
      settleReply,
      complete: (deliveryUs: number) => {
        // Completion is terminal: it may not race in-flight exchanges, it may
        // not jump ahead of the protocol's own stages, and a second call
        // returns the exact same immutable outcome.
        if (outcome !== null) return outcome;
        if (pending.size > 0) {
          throw new RangeError('cart read protocol has outstanding exchanges');
        }
        if (!readyReached) {
          throw new RangeError('cart read protocol has not reached ready');
        }
        outcome = this.finalizeRead(state, deliveryUs, token, anyReachable);
        return outcome;
      },
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Terminal outcome at the actual delivery time. Freshness is audited here,
   * never at launch: evidence that arrived in time but expired before client
   * delivery is honestly unused.
   */
  private finalizeRead(
    state: Collected,
    deliveryUs: number,
    token: CartSessionToken,
    anyReachable: boolean,
  ): CartReadOutcome {
    const missingTokenIds = cartTokenMissing(token, state.envelopes.keys());
    const view = this.materialize(state);
    const coveredIds = [...state.envelopes.keys()].sort();
    const certificates = [...state.certificates.values()].sort((left, right) =>
      left.origin < right.origin ? -1 : left.origin > right.origin ? 1 : 0,
    );
    const audit = auditCartCertificates(certificates, deliveryUs);
    const missingOrigins = CART_REGIONS.filter((region) => !state.certificates.has(region));
    const minimumCutUs = certificates.reduce(
      (minimum, certificate) => Math.min(minimum, certificate.cutUs),
      Number.MAX_SAFE_INTEGER,
    );
    const evidence: CartReadEvidence = {
      coveredIds,
      certificates,
      requiredCutUs: audit.requiredCutUs,
      minimumCutUs: certificates.length === 0 ? 0 : minimumCutUs,
      staleOrigins: audit.staleOrigins,
      missingOrigins,
    };
    const outgoingToken = cartTokenUnion(token, coveredIds);
    const dataSources = [...new Set(state.sources.values())].sort();
    const charge = this.charge(state);

    if (!anyReachable && state.envelopes.size === 0) {
      return {
        kind: 'unavailable',
        cartId: this.cartId,
        reason: 'no-reachable-target',
        message: 'no configured read target is reachable',
        missingTokenIds,
        missingOrigins,
        staleOrigins: audit.staleOrigins,
        attempts: state.attempts,
        charge,
        dataSources,
      };
    }

    if (missingOrigins.length > 0) {
      return {
        kind: 'partial',
        cartId: this.cartId,
        reason: 'missing-origin-evidence',
        view,
        incomingToken: token,
        outgoingToken,
        coveredIds,
        missingTokenIds,
        evidence,
        attempts: state.attempts,
        charge,
        dataSources,
      };
    }

    if (!audit.fresh) {
      return {
        kind: 'unavailable',
        cartId: this.cartId,
        reason: 'stale-evidence',
        message: `coverage evidence expired before client delivery: ${audit.staleOrigins.join(', ')}`,
        missingTokenIds,
        missingOrigins,
        staleOrigins: audit.staleOrigins,
        attempts: state.attempts,
        charge,
        dataSources,
      };
    }

    if (!view.complete) {
      return {
        kind: 'partial',
        cartId: this.cartId,
        reason: 'causal-gap',
        view,
        incomingToken: token,
        outgoingToken,
        coveredIds,
        missingTokenIds,
        evidence,
        attempts: state.attempts,
        charge,
        dataSources,
      };
    }

    return {
      kind: 'complete',
      cartId: this.cartId,
      view,
      incomingToken: token,
      outgoingToken,
      coveredIds,
      evidence,
      attempts: state.attempts,
      charge,
      dataSources,
    };
  }

  /**
   * Which origins a refresh contact with this target could newly cover, using
   * the same acceptance rules as `issueCertificates` but with no side effects.
   * Used only to decide whether a refresh exchange is worth sending at all.
   */
  private previewIssue(target: CartReadNode, cutUs: number, state: Collected): CartRegion[] {
    if (target.certifies === undefined) return [];
    const origins: CartRegion[] = [];
    for (const region of CART_REGIONS) {
      const existing = state.certificates.get(region);
      if (existing !== undefined && existing.cutUs >= cutUs) continue;
      const source = target.certifies(region);
      if (source === undefined) continue;
      if (source.role === 'authority') {
        if (target.nodeId !== this.authorities[region]) continue;
        if (source.ledger !== this.authorityLedgers[region]) continue;
        if (source.ledger.nodeId !== target.nodeId) continue;
        origins.push(region);
        continue;
      }
      const carry = source.carry;
      if (!isReplicatedCertificate(carry)) continue;
      if (carry.carrierNodeId !== target.nodeId) continue;
      if (carry.completedAtUs > cutUs) continue;
      const certificate = carry.certificate;
      if (!isCertificateIssuedBy(certificate, this.authorityLedgers[region])) continue;
      if (certificate.cartId !== this.cartId || certificate.origin !== region) continue;
      if (certificate.authorityNodeId !== this.authorities[region]) continue;
      if (certificate.cutUs > cutUs) continue;
      origins.push(region);
    }
    return origins;
  }

  private isComplete(state: Collected, token: CartSessionToken): boolean {
    if (cartTokenMissing(token, state.envelopes.keys()).length > 0) return false;
    return state.certificates.size === CART_REGIONS.length;
  }

  /**
   * Token ids and every certificate id must be present as durable envelopes.
   * A certificate may legitimately list commits this requester does not hold
   * yet; that is a real repair, not a free success.
   */
  private missingCertificateIds(state: Collected, token: CartSessionToken): string[] {
    const required = new Set(token.ids);
    for (const certificate of state.certificates.values()) {
      for (const operationId of certificate.ids) required.add(operationId);
    }
    return [...required].filter((operationId) => !state.envelopes.has(operationId)).sort();
  }

  private probe(
    target: CartReadNode,
    tokenCount: number,
    cutUs: number,
    reachable: boolean,
    phase: CartReadAttempt['phase'],
    state: Collected,
  ): void {
    // Every probe is a read request carrying the incoming session token:
    // `Read request = 256 + 32 * tokenCount` (frozen contract §2).
    const requestBytes = cartReadRequestBytes(tokenCount);
    if (!reachable) {
      state.attempts.push({
        nodeId: target.nodeId,
        region: target.region,
        kind: target.kind,
        phase,
        reachable: false,
        coveredIds: [],
        certificates: [],
        requestBytes: 0,
        responseBytes: 0,
        cpuMilliseconds: 0,
        ioUnits: 0,
      });
      return;
    }

    const coveredIds: string[] = [];
    let responseBytes = 0;
    let cpuMilliseconds = CART_READ_ATTEMPT_CPU_MS;
    const discarded: string[] = [];

    const cache = target.cache?.();
    if (cache !== undefined) {
      const lookup = cache.lookup(this.cartId, cutUs);
      if (lookup.status !== 'miss') {
        // Re-verify the cache's claim against the read's own modeled topology:
        // a cache can neither vouch for an envelope it cannot trace to the
        // origin authority nor mint a certificate that authority never issued.
        const trusted = this.trustCacheEntry(lookup.entry, discarded);
        const supplied: CartOperationEnvelope[] = [];
        for (const [operationId, envelope] of trusted.envelopes) {
          if (state.envelopes.has(operationId)) continue;
          state.envelopes.set(operationId, envelope);
          state.sources.set(operationId, trusted.provenance.get(operationId) ?? target.nodeId);
          coveredIds.push(operationId);
          supplied.push(envelope);
        }
        const previouslyHeld = new Map(state.certificates);
        const merged = mergeCartCertificates(state.certificates.values(), trusted.certificates);
        state.certificates.clear();
        for (const certificate of merged) state.certificates.set(certificate.origin, certificate);
        const contributedCertificates = merged.filter((certificate) => {
          const before = previouslyHeld.get(certificate.origin);
          return (
            before === undefined ||
            before.cutUs !== certificate.cutUs ||
            before.authorityNodeId !== certificate.authorityNodeId
          );
        });
        // A cache answer is still a wire response: charge the frozen covered
        // view encoding for exactly the data this cache contributed. Ids an
        // earlier source already delivered are not charged twice.
        if (supplied.length > 0 || contributedCertificates.length > 0) {
          const cacheView = this.viewOfWork(supplied);
          responseBytes += cartCoveredViewBytes({
            coveredIds: supplied.length,
            unitCount: cacheView.uniqueUnits,
            tombstoneCount: cacheView.uniqueTombstones,
            certificates: contributedCertificates,
          });
        }
      }
    }

    if (target.durableRead !== undefined) {
      const read = target.durableRead(this.cartId);
      cpuMilliseconds += read.charge.cpuMilliseconds;
      // The durable read charges its own CPU/IO internally; mirror it for the
      // read's visible total.
      state.ioUnits += read.charge.ioUnits;
      if (read.ok) {
        for (const operationId of read.token.ids) {
          if (state.envelopes.has(operationId)) continue;
          const envelope = target.envelope?.(this.cartId, operationId);
          if (envelope === undefined) continue;
          state.envelopes.set(operationId, envelope);
          state.sources.set(operationId, target.nodeId);
          coveredIds.push(operationId);
        }
        responseBytes += cartCoveredViewBytes({
          coveredIds: read.token.ids.length,
          unitCount: read.view.work.uniqueUnits,
          tombstoneCount: read.view.work.uniqueTombstones,
          certificates: [],
        });
      } else {
        responseBytes += CART_UNAVAILABLE_RESPONSE_BYTES;
      }
    }

    const certificateOrigins = this.issueCertificates(target, cutUs, phase, state);

    state.requestBytes += requestBytes;
    state.responseBytes += responseBytes;
    state.cpuMilliseconds += cpuMilliseconds;
    state.requests += 1;
    state.attempts.push({
      nodeId: target.nodeId,
      region: target.region,
      kind: target.kind,
      phase,
      reachable: true,
      coveredIds: coveredIds.sort(),
      certificates: certificateOrigins,
      requestBytes,
      responseBytes,
      cpuMilliseconds,
      ioUnits: 0,
      ...(discarded.length === 0 ? {} : { discarded: [...new Set(discarded)].sort() }),
    });
  }

  /**
   * Split a cache entry into the material the read may actually use. Trust is
   * derived from branded durable evidence re-validated against the read's own
   * authority map, never from the cache's claims or from matching name strings:
   *
   * - an envelope is usable only when its attestation is a branded durable
   *   commit for this cart, naming this exact immutable payload, issued under
   *   the configured authority of its origin. The holder may be a replica;
   *   provenance survives transfer even though the serving node differs;
   * - a certificate is usable only when it is branded authority issuance for
   *   this cart and the exact configured authority ledger object of its origin
   *   minted it. Copies, reshaped objects or certificates from a caller-built
   *   ledger with a colliding authority name are not issuance.
   *
   * Refused ids/origins are reported as `discarded` and contribute no coverage,
   * freshness or wire bytes.
   */
  private trustCacheEntry(
    entry: CartCacheEntry,
    discarded: string[],
  ): {
    envelopes: Map<string, CartOperationEnvelope>;
    certificates: CartCertificate[];
    provenance: Map<string, string>;
  } {
    const envelopes = new Map<string, CartOperationEnvelope>();
    const provenance = new Map<string, string>();
    const covered = new Set(entry.coveredIds);
    for (const [operationId, envelope] of entry.envelopes) {
      const attestation: CartDurableCommit | undefined = entry.provenance.get(operationId);
      const authority = this.authorities[envelope.key.originRegion];
      const trusted =
        covered.has(operationId) &&
        attestation !== undefined &&
        cartDurableCommitMatches(attestation, this.cartId, envelope, authority);
      if (!trusted) {
        discarded.push(operationId);
        continue;
      }
      envelopes.set(operationId, envelope);
      provenance.set(operationId, attestation.holderNodeId);
    }
    for (const operationId of covered) {
      if (!envelopes.has(operationId)) discarded.push(operationId);
    }
    const certificates: CartCertificate[] = [];
    for (const certificate of entry.certificates) {
      if (
        !isAuthorityIssuedCertificate(certificate) ||
        certificate.cartId !== this.cartId ||
        this.authorities[certificate.origin] !== certificate.authorityNodeId ||
        !isCertificateIssuedBy(certificate, this.authorityLedgers[certificate.origin])
      ) {
        discarded.push(certificate.origin);
        continue;
      }
      certificates.push(certificate);
    }
    return { envelopes, certificates, provenance };
  }

  private repair(target: CartReadNode, missingIds: readonly string[], state: Collected): void {
    const requestBytes = cartMissingIdRequestBytes(missingIds.length);
    let bytes = 0;
    for (const operationId of missingIds) {
      const envelope = target.envelope?.(this.cartId, operationId);
      if (envelope === undefined) continue;
      state.envelopes.set(operationId, envelope);
      state.sources.set(operationId, target.nodeId);
      bytes += cartEditBytes(envelope);
    }
    state.requestBytes += requestBytes;
    state.responseBytes += bytes;
    state.cpuMilliseconds += CART_READ_ATTEMPT_CPU_MS;
    state.requests += 1;
    state.attempts.push({
      nodeId: target.nodeId,
      region: target.region,
      kind: target.kind,
      phase: 'repair',
      reachable: true,
      coveredIds: [...missingIds].sort(),
      certificates: [],
      requestBytes,
      responseBytes: bytes,
      cpuMilliseconds: CART_READ_ATTEMPT_CPU_MS,
      ioUnits: 0,
    });
  }

  /**
   * Obtain coverage for every origin this target can legitimately answer.
   *
   * Only two paths exist, and neither lets a target invent evidence:
   *
   * - The target is the configured authority node *and* presents the modeled
   *   authority durable ledger object itself. Issuance is charged to that
   *   ledger; a caller-built ledger with a colliding node id is refused.
   * - The target is a replica carrying an earlier authority-issued certificate
   *   through explicit completed replication. The certificate is accepted only
   *   when the configured authority ledger minted it, its origin/cart/authority
   *   match, and its cut is not advanced (it is the original frozen object).
   */
  private issueCertificates(
    target: CartReadNode,
    cutUs: number,
    phase: CartReadAttempt['phase'],
    state: Collected,
  ): CartRegion[] {
    if (target.certifies === undefined) return [];
    const issued: CartRegion[] = [];
    for (const region of CART_REGIONS) {
      const existing = state.certificates.get(region);
      if (existing !== undefined && existing.cutUs >= cutUs) continue;
      const source = target.certifies(region);
      if (source === undefined) continue;
      const authorityLedger = this.authorityLedgers[region];
      if (source.role === 'authority') {
        // The target must *be* the configured authority node and must present
        // the modeled authority durable ledger by identity. A fabricated ledger
        // naming the right node is not the authority's durable state.
        if (target.nodeId !== this.authorities[region]) continue;
        if (source.ledger !== authorityLedger) continue;
        if (source.ledger.nodeId !== target.nodeId) continue;
        const issue = source.ledger.issue(this.cartId, region, cutUs, source.kind);
        if (!issue.ok) continue;
        if (!isCertificateIssuedBy(issue.certificate, authorityLedger)) continue;
        this.onCertificateIssued?.(target.nodeId, issue.certificate);
        state.certificates.set(region, issue.certificate);
        state.responseBytes += cartCertificateBytes(issue.certificate);
        state.cpuMilliseconds += issue.charge.cpuMilliseconds;
        state.ioUnits += issue.charge.ioUnits;
        issued.push(region);
        continue;
      }
      if (source.role !== 'replica') continue;
      const carry = source.carry;
      if (!isReplicatedCertificate(carry)) continue;
      // Explicit replication ends at this carrier, before the request cut.
      if (carry.carrierNodeId !== target.nodeId) continue;
      if (carry.completedAtUs > cutUs) continue;
      const certificate = carry.certificate;
      if (!isCertificateIssuedBy(certificate, authorityLedger)) continue;
      if (certificate.cartId !== this.cartId || certificate.origin !== region) continue;
      if (certificate.authorityNodeId !== this.authorities[region]) continue;
      // A carried certificate is earlier evidence: it can never be newer than
      // the request cut, nor can a replica advance the authority's cut.
      if (certificate.cutUs > cutUs) continue;
      state.certificates.set(region, certificate);
      state.responseBytes += cartCertificateBytes(certificate);
      issued.push(region);
    }
    if (issued.length > 0) {
      state.requests += 1;
      const attempt: CartReadAttempt = {
        nodeId: target.nodeId,
        region: target.region,
        kind: target.kind,
        phase,
        reachable: true,
        coveredIds: [],
        certificates: issued,
        requestBytes: CART_MISSING_ID_REQUEST_BASE,
        responseBytes: issued.reduce((total, region) => {
          const certificate = state.certificates.get(region);
          return total + (certificate === undefined ? 0 : cartCertificateBytes(certificate));
        }, 0),
        cpuMilliseconds: 0,
        ioUnits: 0,
      };
      state.attempts.push(attempt);
      state.requestBytes += attempt.requestBytes;
    }
    return issued;
  }

  /**
   * Materialization work for one contributed envelope set, with no charge side
   * effects. Used to size the covered-view wire response a cache answer really
   * delivered, without double-charging payload another source already sent.
   */
  private viewOfWork(envelopes: readonly CartOperationEnvelope[]): CartMaterializationWork {
    const byId = new Map<string, CartOperationEnvelope>();
    for (const envelope of envelopes) byId.set(cartOperationId(envelope.key), envelope);
    let log = createCartOperationLog(this.cartId);
    for (const operationId of [...byId.keys()].sort()) {
      const envelope = byId.get(operationId);
      if (envelope === undefined) continue;
      log = acceptCartOperation(log, envelope).log;
    }
    return materializeCartView(log).work;
  }

  private materialize(state: Collected): CartMaterializedView {
    let log = createCartOperationLog(this.cartId);
    for (const operationId of [...state.envelopes.keys()].sort()) {
      const envelope = state.envelopes.get(operationId);
      if (envelope === undefined) continue;
      log = acceptCartOperation(log, envelope).log;
    }
    const view = materializeCartView(log);
    // Union merge work is charged per visited unit/tombstone on top of the
    // durable read's own charges.
    state.cpuMilliseconds += view.work.unitsAdded * CART_MERGE_ITEM_CPU_MS;
    return view;
  }

  private charge(state: Collected): CartReadCharge {
    return {
      requestBytes: state.requestBytes,
      responseBytes: state.responseBytes,
      cpuMilliseconds: state.cpuMilliseconds,
      ioUnits: state.ioUnits,
      requests: state.requests,
    };
  }

  private unavailableFromToken(
    reason: CartReadUnavailable['reason'],
    token: CartSessionToken,
    issue: CartTokenIssueReason,
    message: string,
  ): CartReadUnavailable {
    return {
      kind: 'unavailable',
      cartId: this.cartId,
      reason,
      message: `${issue}: ${message}`,
      missingTokenIds: [...token.ids].sort(),
      missingOrigins: [...CART_REGIONS],
      staleOrigins: [],
      attempts: [],
      charge: {
        requestBytes: 0,
        responseBytes: CART_UNAVAILABLE_RESPONSE_BYTES,
        cpuMilliseconds: 0,
        ioUnits: 0,
        requests: 0,
      },
      dataSources: [],
    };
  }

  private unavailable(
    reason: CartReadUnavailable['reason'],
    state: Collected,
    missingTokenIds: readonly string[],
    staleOrigins: readonly CartRegion[],
  ): CartReadUnavailable {
    return {
      kind: 'unavailable',
      cartId: this.cartId,
      reason,
      message:
        reason === 'unreachable-token-operations'
          ? `no reachable node holds token operations ${missingTokenIds.join(', ')}`
          : reason === 'unreachable-coverage-operations'
            ? `no reachable node holds certificate-covered operations ${missingTokenIds.join(', ')}`
            : 'read evidence is unavailable',
      missingTokenIds: [...missingTokenIds].sort(),
      missingOrigins: CART_REGIONS.filter((region) => !state.certificates.has(region)),
      staleOrigins: [...staleOrigins],
      attempts: state.attempts,
      charge: this.charge(state),
      dataSources: [...new Set(state.sources.values())].sort(),
    };
  }
}

const CART_MISSING_ID_REQUEST_BASE = CART_MISSING_ID_REQUEST_BASE_BYTES;

function cartEditBytes(envelope: CartOperationEnvelope): number {
  return cartEditEnvelopeBytes(envelope.observedContext);
}

export function createCartReadEngine(options: CartReadEngineOptions): CartReadEngine {
  return new CartReadEngine(options);
}
