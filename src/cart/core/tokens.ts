/**
 * GC-009 — causal tokens, origin coverage certificates and freshness evidence
 * (`cart-protocol-v1` §4 and B2).
 *
 * A session token is an exact, versioned set of committed operation ids. A read
 * may only be `complete` when its displayed view is the reducer applied to a
 * causally closed durable set that covers the incoming token, and when every
 * origin's coverage certificate is fresh at client delivery time.
 *
 * Certificates are immutable historical statements produced by an authoritative
 * durable node: they list exactly that origin's cart commits at or before a cut
 * (`startUs - 1µs`). They are never refreshed by a cache hit, and an empty
 * origin still pays for its empty certificate — absence of edits is not free
 * knowledge.
 */
import type { CartRegion } from '../contracts';
import {
  CART_MAX_TOKEN_IDS,
  CART_SESSION_TOKEN_VERSION,
  CART_TOKEN_ID_BYTES,
  type CartSessionToken,
} from './durable-store';
import { CART_JOURNAL_SCAN_OPS_PER_IO } from './durable-store';
import { cartOperationFingerprint, cartOperationId, type CartOperationEnvelope } from './operations';

/** Healthy-network freshness bound: certificates must cut at or after d - 2 s. */
export const CART_FRESHNESS_BOUND_US = 2_000_000;

/** `Certificate = 128 + 32 * idCount` (`cart-protocol-v1` encoding section). */
export const CART_CERTIFICATE_BASE_BYTES = 128;
export const CART_CERTIFICATE_ID_BYTES = 32;
/** `Read request = 256 + 32 * tokenCount`. */
export const CART_READ_REQUEST_BASE_BYTES = 256;
/** `Missing-ID request = 128 + 32 * idCount`. */
export const CART_MISSING_ID_REQUEST_BASE_BYTES = 128;
/** `Covered view response = 256 + 32*covered + 32*units + 24*tombstones + certs`. */
export const CART_COVERED_VIEW_BASE_BYTES = 256;
export const CART_COVERED_VIEW_COVERED_BYTES = 32;
export const CART_COVERED_VIEW_UNIT_BYTES = 32;
export const CART_COVERED_VIEW_TOMBSTONE_BYTES = 24;
/** Generic unavailable / conflict / lookup-miss reply. */
export const CART_UNAVAILABLE_RESPONSE_BYTES = 128;

/** Certificate issuance: 0.10 CPU-ms + one IO at any authority. */
export const CART_CERTIFICATE_BASE_CPU_MS = 0.1;
/** Journal enumeration additionally 0.05 CPU-ms per retained cart operation. */
export const CART_CERTIFICATE_JOURNAL_PER_OP_CPU_MS = 0.05;
/** Application front door attempt charge used by the read engine. */
export const CART_READ_ATTEMPT_CPU_MS = 0.3;
/** Union merge charge per visited unit/tombstone (`cart-protocol-v1` §7). */
export const CART_MERGE_ITEM_CPU_MS = 0.01;

export interface CartCertificateCharge {
  readonly cpuMilliseconds: number;
  readonly ioUnits: number;
}

/**
 * An origin's exact coverage statement: every cart commit of that origin at or
 * before `cutUs`. It carries the authority identity that produced it, so a
 * certificate can never be forged by a non-authoritative cache.
 */
export interface CartCertificate {
  readonly cartId: string;
  readonly origin: CartRegion;
  readonly authorityNodeId: string;
  readonly cutUs: number;
  readonly ids: readonly string[];
}

/**
 * Modeled durable-commit attestation.
 *
 * A cache may carry an envelope only with evidence that a durable boundary
 * (the origin authority or a replica that durably accepted replication)
 * actually recorded that exact immutable payload. `originAuthorityId` is the
 * immutable write authority for the envelope's origin; `holderNodeId` is the
 * node whose durable state holds the envelope, which may legitimately be a
 * replica rather than the authority.
 */
export interface CartDurableCommit {
  readonly cartId: string;
  readonly origin: CartRegion;
  readonly operationId: string;
  readonly fingerprint: string;
  readonly originAuthorityId: string;
  readonly holderNodeId: string;
  readonly committedAtUs: number;
}

/**
 * Brand registries. Object identity, not caller-supplied strings, is the proof
 * of authority issuance: only a ledger that is the configured immutable write
 * authority of an origin mints a certificate for it, and only this module can
 * brand the result. A plain object shaped like the evidence — even one naming
 * the correct configured authority — is never accepted.
 */
const AUTHORITY_ISSUED_CERTIFICATES = new WeakSet<object>();
const DURABLE_COMMIT_ATTESTATIONS = new WeakSet<object>();
/**
 * Which durable ledger object actually minted a certificate. Matching the
 * authority *name* is not issuance; a read must recognize the exact configured
 * authority ledger object, so a caller-built ledger with a colliding node id
 * cannot hand out coverage or freshness.
 */
const CERTIFICATE_ISSUER = new WeakMap<object, CartOriginCommitLedger>();
const REPLICATED_CERTIFICATES = new WeakSet<object>();

export function isAuthorityIssuedCertificate(value: unknown): value is CartCertificate {
  return typeof value === 'object' && value !== null && AUTHORITY_ISSUED_CERTIFICATES.has(value);
}

/** Whether this exact certificate object was minted by that durable ledger. */
export function isCertificateIssuedBy(
  value: unknown,
  ledger: CartOriginCommitLedger,
): value is CartCertificate {
  return (
    typeof value === 'object' && value !== null && CERTIFICATE_ISSUER.get(value) === ledger
  );
}

/**
 * Authority-issued certificate carried by a replica through explicit completed
 * replication. A replica may only *carry* an already-issued statement: it never
 * mints, never refreshes and never advances the cut. The wrapped certificate is
 * the original frozen object, so its ids and cut are unchanged by the carry.
 */
export interface CartReplicatedCertificate {
  readonly certificate: CartCertificate;
  readonly carrierNodeId: string;
  readonly completedAtUs: number;
}

export function isReplicatedCertificate(value: unknown): value is CartReplicatedCertificate {
  return typeof value === 'object' && value !== null && REPLICATED_CERTIFICATES.has(value);
}

/**
 * Model one completed replication transfer of an authority-issued certificate
 * into a replica. Only branded authority issuance can be carried, and a node
 * cannot "carry" its own authority statement.
 */
export function carryCartCertificate(
  certificate: CartCertificate,
  carrierNodeId: string,
  completedAtUs: number,
): CartReplicatedCertificate | undefined {
  if (!isAuthorityIssuedCertificate(certificate)) return undefined;
  if (carrierNodeId.length === 0 || carrierNodeId === certificate.authorityNodeId) return undefined;
  if (!Number.isInteger(completedAtUs) || completedAtUs < 0) return undefined;
  const carry: CartReplicatedCertificate = Object.freeze({
    certificate,
    carrierNodeId,
    completedAtUs,
  });
  REPLICATED_CERTIFICATES.add(carry);
  return carry;
}

export function isDurableCommitAttestation(value: unknown): value is CartDurableCommit {
  return typeof value === 'object' && value !== null && DURABLE_COMMIT_ATTESTATIONS.has(value);
}

/**
 * Whether an attestation proves durable provenance for this exact envelope in
 * this cart under the given modeled authority. Fingerprint equality binds the
 * original immutable payload; origin and authority bind the issuer.
 */
export function cartDurableCommitMatches(
  attestation: CartDurableCommit,
  cartId: string,
  envelope: CartOperationEnvelope,
  originAuthorityId: string | undefined,
): boolean {
  return (
    isDurableCommitAttestation(attestation) &&
    attestation.cartId === cartId &&
    attestation.operationId === cartOperationId(envelope.key) &&
    attestation.origin === envelope.key.originRegion &&
    attestation.fingerprint === cartOperationFingerprint(envelope) &&
    originAuthorityId !== undefined &&
    attestation.originAuthorityId === originAuthorityId
  );
}

export function cartCertificateBytes(certificate: CartCertificate): number {
  return CART_CERTIFICATE_BASE_BYTES + CART_CERTIFICATE_ID_BYTES * certificate.ids.length;
}

/**
 * Work charged to the authority for issuing one certificate. Journal-backed
 * authorities enumerate their retained operations (per-op CPU and one IO per 16
 * scanned operations); a materialized store pays a single IO.
 */
export function cartCertificateCharge(
  kind: 'journal' | 'store',
  retainedOperations: number,
): CartCertificateCharge {
  if (!Number.isInteger(retainedOperations) || retainedOperations < 0) {
    throw new RangeError('retained operation count must be a non-negative integer');
  }
  if (kind === 'store') {
    return { cpuMilliseconds: CART_CERTIFICATE_BASE_CPU_MS, ioUnits: 1 };
  }
  return {
    cpuMilliseconds:
      CART_CERTIFICATE_BASE_CPU_MS +
      CART_CERTIFICATE_JOURNAL_PER_OP_CPU_MS * retainedOperations,
    ioUnits: Math.max(1, Math.ceil(retainedOperations / CART_JOURNAL_SCAN_OPS_PER_IO)),
  };
}

export interface CartCommittedOperation {
  readonly operationId: string;
  readonly origin: CartRegion;
  readonly committedAtUs: number;
}

export type CartCertificateIssue =
  | {
      readonly ok: true;
      readonly certificate: CartCertificate;
      readonly charge: CartCertificateCharge;
    }
  | {
      readonly ok: false;
      readonly reason: 'authority-not-configured';
      readonly charge: CartCertificateCharge;
    };

/**
 * Durable per-origin commit bookkeeping of one authority.
 *
 * The authority records an operation only after its durable commit, together
 * with the original commit time. Per-origin commit order is the record order,
 * and a cut answers with the exact prefix at or before that time — a maximum
 * sequence number is never used to paper over holes.
 */
export class CartOriginCommitLedger {
  readonly nodeId: string;
  private readonly authorities: Readonly<Partial<Record<CartRegion, string>>> | undefined;
  private readonly commits = new Map<string, CartCommittedOperation[]>();
  private readonly byCart = new Map<string, Map<string, CartCommittedOperation>>();
  private readonly fingerprints = new Map<string, string>();
  private lastCommitUs = 0;

  constructor(
    nodeId: string,
    authorities?: Readonly<Partial<Record<CartRegion, string>>>,
  ) {
    if (nodeId.length === 0) throw new RangeError('authority node id must be non-empty');
    this.nodeId = nodeId;
    this.authorities = authorities;
  }

  /** Durable-commit hook: commit times never move backwards. */
  record(
    cartId: string,
    origin: CartRegion,
    operationId: string,
    committedAtUs: number,
    fingerprint = '',
  ): void {
    if (!Number.isInteger(committedAtUs) || committedAtUs < 0) {
      throw new RangeError('commit time must be a non-negative integer microsecond value');
    }
    if (committedAtUs < this.lastCommitUs) {
      throw new RangeError('durable commit times must be non-decreasing');
    }
    const key = `${cartId}\u0000${origin}`;
    const existing = this.commits.get(key) ?? [];
    if (existing.some((commit) => commit.operationId === operationId)) return;
    const commit: CartCommittedOperation = {
      operationId,
      origin,
      committedAtUs,
    };
    this.commits.set(key, [...existing, commit]);
    const cart = this.byCart.get(cartId) ?? new Map<string, CartCommittedOperation>();
    cart.set(operationId, commit);
    this.byCart.set(cartId, cart);
    this.fingerprints.set(`${cartId}\u0000${operationId}`, fingerprint);
    this.lastCommitUs = committedAtUs;
  }

  /**
   * Durable provenance for one exact envelope. Returns undefined unless this
   * node genuinely recorded that operation for the cart *and* the recorded
   * immutable payload fingerprint matches. The returned object is branded;
   * only this boundary can mint it.
   */
  attest(cartId: string, envelope: CartOperationEnvelope): CartDurableCommit | undefined {
    const operationId = cartOperationId(envelope.key);
    const commit = this.byCart.get(cartId)?.get(operationId);
    if (commit === undefined) return undefined;
    const fingerprint = this.fingerprints.get(`${cartId}\u0000${operationId}`);
    if (fingerprint === undefined || fingerprint !== cartOperationFingerprint(envelope)) {
      return undefined;
    }
    const origin = envelope.key.originRegion;
    const attestation: CartDurableCommit = Object.freeze({
      cartId,
      origin,
      operationId,
      fingerprint,
      originAuthorityId: this.authorities?.[origin] ?? this.nodeId,
      holderNodeId: this.nodeId,
      committedAtUs: commit.committedAtUs,
    });
    DURABLE_COMMIT_ATTESTATIONS.add(attestation);
    return attestation;
  }

  committedAt(cartId: string, operationId: string): number | undefined {
    return this.byCart.get(cartId)?.get(operationId)?.committedAtUs;
  }

  /** Retained operations across the cart, used for scan charges. */
  retained(cartId: string): number {
    return this.byCart.get(cartId)?.size ?? 0;
  }

  commitsFor(cartId: string, origin: CartRegion): readonly CartCommittedOperation[] {
    return this.commits.get(`${cartId}\u0000${origin}`) ?? [];
  }

  /** Whether this authority holds a durable commit for `origin`. */
  isAuthorityFor(origin: CartRegion): boolean {
    for (const key of this.commits.keys()) {
      if (key.endsWith(`\u0000${origin}`)) return true;
    }
    return false;
  }

  /**
   * Issue the exact certificate at `cutUs`: all and only this origin's cart
   * commits whose durable commit time is at or before the cut.
   *
   * Only the configured immutable write authority of that origin may mint. The
   * authority binding is the modeled topology this ledger was constructed with,
   * so a caller-built ledger — even one whose node id collides with a real
   * authority name — cannot produce coverage or freshness evidence for an
   * origin it is not configured to own.
   */
  issue(
    cartId: string,
    origin: CartRegion,
    cutUs: number,
    kind: 'journal' | 'store' = 'store',
  ): CartCertificateIssue {
    if (!Number.isInteger(cutUs)) {
      throw new RangeError('certificate cut must be an integer microsecond value');
    }
    const retained = this.retained(cartId);
    const charge = cartCertificateCharge(kind, retained);
    if (this.authorities?.[origin] !== this.nodeId) {
      return { ok: false, reason: 'authority-not-configured', charge };
    }
    const ids = this.commitsFor(cartId, origin)
      .filter((commit) => commit.committedAtUs <= cutUs)
      .map((commit) => commit.operationId)
      .sort();
    const certificate = issueCertificate({
      cartId,
      origin,
      authorityNodeId: this.nodeId,
      cutUs,
      ids,
    });
    CERTIFICATE_ISSUER.set(certificate, this);
    return { ok: true, certificate, charge };
  }
}

/** Mint and brand one authority certificate. Module-private by construction. */
function issueCertificate(fields: CartCertificate): CartCertificate {
  const certificate: CartCertificate = Object.freeze({
    cartId: fields.cartId,
    origin: fields.origin,
    authorityNodeId: fields.authorityNodeId,
    cutUs: fields.cutUs,
    ids: Object.freeze([...fields.ids]),
  });
  AUTHORITY_ISSUED_CERTIFICATES.add(certificate);
  return certificate;
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

export type CartTokenIssueReason =
  | 'unknown-token-version'
  | 'malformed-token'
  | 'token-overflow'
  | 'token-cart-mismatch';

export type CartTokenParse =
  | { readonly ok: true; readonly token: CartSessionToken }
  | { readonly ok: false; readonly reason: CartTokenIssueReason; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an incoming session token. Unknown versions and oversized sets are
 * explicit non-passing outcomes, never silently truncated or upgraded.
 */
export function parseCartSessionToken(input: unknown): CartTokenParse {
  if (!isRecord(input)) {
    return { ok: false, reason: 'malformed-token', message: 'session token must be an object' };
  }
  if (input.version !== CART_SESSION_TOKEN_VERSION) {
    return {
      ok: false,
      reason: 'unknown-token-version',
      message: `unsupported session token version ${String(input.version)}`,
    };
  }
  if (typeof input.cartId !== 'string' || input.cartId.length === 0) {
    return { ok: false, reason: 'malformed-token', message: 'session token cart id is invalid' };
  }
  const rawIds = input.ids;
  if (!Array.isArray(rawIds)) {
    return { ok: false, reason: 'malformed-token', message: 'session token ids must be an array' };
  }
  const ids: string[] = [];
  for (const raw of rawIds) {
    if (typeof raw !== 'string' || raw.length === 0) {
      return {
        ok: false,
        reason: 'malformed-token',
        message: 'session token ids must be non-empty strings',
      };
    }
    ids.push(raw);
  }
  if (ids.length > CART_MAX_TOKEN_IDS) {
    return {
      ok: false,
      reason: 'token-overflow',
      message: `session token carries ${ids.length} ids, limit ${CART_MAX_TOKEN_IDS}`,
    };
  }
  const unique = [...new Set(ids)].sort();
  if (unique.length !== ids.length) {
    return {
      ok: false,
      reason: 'malformed-token',
      message: 'session token ids must be unique',
    };
  }
  return {
    ok: true,
    token: { version: CART_SESSION_TOKEN_VERSION, cartId: input.cartId, ids: unique },
  };
}

/** Ids required by the token that the covered set does not contain. */
export function cartTokenMissing(
  token: CartSessionToken,
  covered: Iterable<string>,
): string[] {
  const held = new Set(covered);
  return token.ids.filter((id) => !held.has(id)).sort();
}

export function cartTokenIdsCovers(token: CartSessionToken, ids: readonly string[]): boolean {
  const held = new Set(token.ids);
  return ids.every((id) => held.has(id));
}

/** Outgoing token: union of the client's prior token and the covered set. */
export function cartTokenUnion(token: CartSessionToken, covered: readonly string[]): CartSessionToken {
  return {
    version: CART_SESSION_TOKEN_VERSION,
    cartId: token.cartId,
    ids: [...new Set([...token.ids, ...covered])].sort(),
  };
}

// ---------------------------------------------------------------------------
// Wire sizes and freshness evidence
// ---------------------------------------------------------------------------

export function cartReadRequestBytes(tokenCount: number): number {
  if (!Number.isInteger(tokenCount) || tokenCount < 0) {
    throw new RangeError('token count must be a non-negative integer');
  }
  return CART_READ_REQUEST_BASE_BYTES + CART_TOKEN_ID_BYTES * tokenCount;
}

export function cartMissingIdRequestBytes(idCount: number): number {
  if (!Number.isInteger(idCount) || idCount < 0) {
    throw new RangeError('missing id count must be a non-negative integer');
  }
  return CART_MISSING_ID_REQUEST_BASE_BYTES + CART_TOKEN_ID_BYTES * idCount;
}

export interface CartCoveredViewBytesInput {
  readonly coveredIds: number;
  readonly unitCount: number;
  readonly tombstoneCount: number;
  readonly certificates: readonly CartCertificate[];
}

export function cartCoveredViewBytes(input: CartCoveredViewBytesInput): number {
  const certificateBytes = input.certificates.reduce(
    (total, certificate) => total + cartCertificateBytes(certificate),
    0,
  );
  return (
    CART_COVERED_VIEW_BASE_BYTES +
    CART_COVERED_VIEW_COVERED_BYTES * input.coveredIds +
    CART_COVERED_VIEW_UNIT_BYTES * input.unitCount +
    CART_COVERED_VIEW_TOMBSTONE_BYTES * input.tombstoneCount +
    certificateBytes
  );
}

/** Earliest acceptable certificate cut for delivery at `deliveryUs`. */
export function cartDeliveryFreshnessCut(deliveryUs: number): number {
  if (!Number.isInteger(deliveryUs) || deliveryUs < 0) {
    throw new RangeError('delivery time must be a non-negative integer microsecond value');
  }
  return Math.max(0, deliveryUs - CART_FRESHNESS_BOUND_US);
}

export interface CartFreshnessAudit {
  readonly fresh: boolean;
  readonly requiredCutUs: number;
  readonly staleOrigins: readonly CartRegion[];
}

/**
 * Freshness is audited at client delivery, never at request launch: a
 * certificate cut exactly at `deliveryUs - 2000 ms` is eligible, one
 * microsecond earlier is not.
 */
export function auditCartCertificates(
  certificates: readonly CartCertificate[],
  deliveryUs: number,
): CartFreshnessAudit {
  const requiredCutUs = cartDeliveryFreshnessCut(deliveryUs);
  const byOrigin = new Map<CartRegion, CartCertificate>();
  for (const certificate of certificates) {
    const existing = byOrigin.get(certificate.origin);
    if (existing === undefined || certificate.cutUs > existing.cutUs) {
      byOrigin.set(certificate.origin, certificate);
    }
  }
  const staleOrigins: CartRegion[] = [];
  for (const certificate of byOrigin.values()) {
    if (certificate.cutUs < requiredCutUs) staleOrigins.push(certificate.origin);
  }
  staleOrigins.sort();
  return { fresh: staleOrigins.length === 0, requiredCutUs, staleOrigins };
}

/** Union of certificates per origin, keeping the newest cut per origin. */
export function mergeCartCertificates(
  existing: Iterable<CartCertificate>,
  incoming: Iterable<CartCertificate>,
): CartCertificate[] {
  const byOrigin = new Map<CartRegion, CartCertificate>();
  for (const certificate of [...existing, ...incoming]) {
    const current = byOrigin.get(certificate.origin);
    if (current === undefined || certificate.cutUs > current.cutUs) {
      byOrigin.set(certificate.origin, certificate);
    }
  }
  return [...byOrigin.values()].sort((left, right) =>
    left.origin < right.origin ? -1 : left.origin > right.origin ? 1 : 0,
  );
}
