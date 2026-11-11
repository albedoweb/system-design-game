/**
 * GC-009 — finite volatile cart caches (`cart-protocol-v1` §2 cache row, B2).
 *
 * A cache holds covered views plus the original coverage certificates and
 * freshness evidence that produced them. It is strictly volatile:
 *
 * - capacity is the size's usable payload (4 MiB S / 16 MiB M) with LRU eviction;
 * - TTL (1 s) only controls reuse — a hit never refreshes a certificate's cut;
 * - clearing a cache removes only volatile entries and can never touch durable
 *   journals, stores or acknowledged writes;
 * - a stale or incomplete hit never answers a token it does not cover.
 */
import { CART_REGIONS, type CartRegion, type CartServiceSize } from '../contracts';
import { cartOperationId, type CartOperationEnvelope } from './operations';
import { cartEditEnvelopeBytes } from './durable-store';
import { CART_COMPONENT_TABLE } from './resources';
import {
  cartCertificateBytes,
  cartDurableCommitMatches,
  isAuthorityIssuedCertificate,
  type CartCertificate,
  type CartDurableCommit,
} from './tokens';

/** Cache reuse window; it is not a freshness proof. */
export const CART_CACHE_TTL_US = 1_000_000;

export interface CartCachedViewInput {
  readonly cartId: string;
  readonly coveredIds: readonly string[];
  readonly envelopes: Iterable<CartOperationEnvelope>;
  readonly certificates?: readonly CartCertificate[];
  /**
   * Branded durable-commit attestations, one per covered operation id. These
   * can only be minted by the origin authority (or a replica that durably
   * accepted replication); caller-supplied node-name strings are not accepted.
   */
  readonly provenance?: Iterable<CartDurableCommit>;
}

export interface CartCacheEntry {
  readonly cartId: string;
  readonly coveredIds: readonly string[];
  readonly envelopes: ReadonlyMap<string, CartOperationEnvelope>;
  readonly certificates: readonly CartCertificate[];
  readonly provenance: ReadonlyMap<string, CartDurableCommit>;
  readonly storedAtUs: number;
  readonly lastUsedUs: number;
  /** Usable-payload bytes this entry occupies. */
  readonly payloadBytes: number;
}

export type CartCacheLookup =
  | { readonly status: 'miss' }
  | {
      readonly status: 'hit' | 'stale';
      readonly entry: CartCacheEntry;
      /** Ids the caller asked for that this entry does not cover. */
      readonly missingIds: readonly string[];
    };

export interface CartCacheStoreResult {
  readonly ok: boolean;
  readonly reason?:
    | 'cache-payload-capacity'
    | 'cache-missing-provenance'
    | 'cache-untrusted-certificate';
  readonly entry?: CartCacheEntry;
  readonly evictedCartIds?: readonly string[];
  readonly payloadBytes?: number;
  /** Covered ids refused because they carry no authority provenance. */
  readonly untrustedIds?: readonly string[];
  /** Origins refused because the certificate was not issued by their authority. */
  readonly untrustedOrigins?: readonly CartRegion[];
}

export interface CartVolatileCacheSnapshot {
  readonly nodeId: string;
  readonly region: CartRegion;
  readonly entries: number;
  readonly payloadBytes: number;
  readonly capacityBytes: number;
  readonly ttlUs: number;
  readonly stores: number;
  readonly hits: number;
  readonly staleHits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly rejections: number;
  readonly clears: number;
}

export interface CartVolatileCacheOptions {
  readonly nodeId: string;
  readonly region: CartRegion;
  readonly size: CartServiceSize;
  /**
   * Configured immutable write authority per origin (modeled topology). A cache
   * may only retain data that names the real authority as its durable
   * provenance and certificates that authority actually issued; anything else
   * is rejected at the store boundary instead of being replayed later.
   */
  readonly authorities: Readonly<Record<CartRegion, string>>;
  /** Focused-capacity override; defaults to the frozen table payload. */
  readonly capacityBytes?: number;
  readonly ttlUs?: number;
}

function entryPayloadBytes(
  envelopes: Iterable<CartOperationEnvelope>,
  certificates: readonly CartCertificate[],
): number {
  let bytes = 0;
  for (const envelope of envelopes) {
    bytes += cartEditEnvelopeBytes(envelope.observedContext);
  }
  for (const certificate of certificates) bytes += cartCertificateBytes(certificate);
  return bytes;
}

/** One volatile cache node. Holds no durable state whatsoever. */
export class CartVolatileCache {
  readonly nodeId: string;
  readonly region: CartRegion;
  readonly capacityBytes: number;
  readonly ttlUs: number;
  readonly authorities: Readonly<Record<CartRegion, string>>;

  private readonly entries = new Map<string, CartCacheEntry>();
  private payloadBytes = 0;
  private stores = 0;
  private hits = 0;
  private staleHits = 0;
  private misses = 0;
  private evictions = 0;
  private rejections = 0;
  private clears = 0;

  constructor(options: CartVolatileCacheOptions) {
    const spec = CART_COMPONENT_TABLE.cache[options.size];
    const capacity = options.capacityBytes ?? spec.usablePayloadBytes;
    if (capacity === null || capacity <= 0) {
      throw new RangeError('cache capacity must be a positive byte count');
    }
    this.nodeId = options.nodeId;
    this.region = options.region;
    this.capacityBytes = capacity;
    this.ttlUs = options.ttlUs ?? CART_CACHE_TTL_US;
    this.authorities = options.authorities;
    for (const origin of CART_REGIONS) {
      const authority = this.authorities[origin];
      if (typeof authority !== 'string' || authority.length === 0) {
        throw new RangeError(`cache requires a configured write authority for ${origin}`);
      }
    }
  }

  /**
   * Store (or replace) one covered view. An entry larger than the whole cache
   * is rejected explicitly; smaller entries evict the least recently used
   * entries only.
   */
  store(input: CartCachedViewInput, atUs: number): CartCacheStoreResult {
    const envelopes = new Map<string, CartOperationEnvelope>();
    for (const envelope of input.envelopes) {
      envelopes.set(cartOperationId(envelope.key), envelope);
    }
    const certificates = [...(input.certificates ?? [])];
    const coveredIds = [...new Set(input.coveredIds)].sort();
    const provenance = new Map<string, CartDurableCommit>();
    for (const attestation of input.provenance ?? []) {
      provenance.set(attestation.operationId, attestation);
    }

    // Trust boundary: a volatile cache may only retain material whose durable
    // provenance and origin authority it can verify. A covered id is admitted
    // only with a branded attestation minted by a durable boundary that
    // recorded this exact immutable payload; name strings alone never qualify.
    // Certificates must be branded authority issuance for this cart/origin.
    const untrustedIds = new Set<string>();
    const covered = new Set(coveredIds);
    for (const operationId of covered) {
      if (!envelopes.has(operationId)) untrustedIds.add(operationId);
    }
    for (const [operationId, envelope] of envelopes) {
      if (!covered.has(operationId)) untrustedIds.add(operationId);
      const attestation = provenance.get(operationId);
      const authority = this.authorities[envelope.key.originRegion];
      if (
        attestation === undefined ||
        !cartDurableCommitMatches(attestation, input.cartId, envelope, authority)
      ) {
        untrustedIds.add(operationId);
      }
    }
    if (untrustedIds.size > 0) {
      this.rejections += 1;
      return { ok: false, reason: 'cache-missing-provenance', untrustedIds: [...untrustedIds].sort() };
    }
    const untrustedOrigins = [
      ...new Set(
        certificates
          .filter(
            (certificate) =>
              !isAuthorityIssuedCertificate(certificate) ||
              certificate.cartId !== input.cartId ||
              this.authorities[certificate.origin] !== certificate.authorityNodeId,
          )
          .map((certificate) => certificate.origin),
      ),
    ].sort();
    if (untrustedOrigins.length > 0) {
      this.rejections += 1;
      return {
        ok: false,
        reason: 'cache-untrusted-certificate',
        untrustedOrigins,
      };
    }

    const payloadBytes = entryPayloadBytes(envelopes.values(), certificates);
    if (payloadBytes > this.capacityBytes) {
      this.rejections += 1;
      return { ok: false, reason: 'cache-payload-capacity' };
    }

    const previous = this.entries.get(input.cartId);
    let available = this.capacityBytes - this.payloadBytes + (previous?.payloadBytes ?? 0);
    const evicted: string[] = [];
    if (payloadBytes > available) {
      const candidates = [...this.entries.values()]
        .filter((entry) => entry.cartId !== input.cartId)
        .sort((left, right) =>
          left.lastUsedUs !== right.lastUsedUs
            ? left.lastUsedUs - right.lastUsedUs
            : left.cartId < right.cartId
              ? -1
              : 1,
        );
      for (const candidate of candidates) {
        if (payloadBytes <= available) break;
        this.entries.delete(candidate.cartId);
        this.payloadBytes -= candidate.payloadBytes;
        available += candidate.payloadBytes;
        evicted.push(candidate.cartId);
        this.evictions += 1;
      }
    }

    const entry: CartCacheEntry = {
      cartId: input.cartId,
      coveredIds,
      envelopes,
      certificates,
      provenance,
      storedAtUs: atUs,
      lastUsedUs: atUs,
      payloadBytes,
    };
    if (previous !== undefined) this.payloadBytes -= previous.payloadBytes;
    this.entries.set(input.cartId, entry);
    this.payloadBytes += payloadBytes;
    this.stores += 1;
    return {
      ok: true,
      entry,
      evictedCartIds: evicted,
      payloadBytes: this.payloadBytes,
    };
  }

  /**
   * Look up a cart's cached view. `hit` means the entry is inside the reuse
   * TTL; `stale` means the entry exists but must be revalidated (token coverage
   * and certificate freshness) before it can contribute to a successful read.
   */
  lookup(cartId: string, atUs: number, requiredIds: readonly string[] = []): CartCacheLookup {
    const entry = this.entries.get(cartId);
    if (entry === undefined) {
      this.misses += 1;
      return { status: 'miss' };
    }
    const refreshed: CartCacheEntry = { ...entry, lastUsedUs: atUs };
    this.entries.set(cartId, refreshed);
    const held = new Set(refreshed.coveredIds);
    const missingIds = requiredIds.filter((id) => !held.has(id)).sort();
    const age = atUs - refreshed.storedAtUs;
    if (age > this.ttlUs) {
      this.staleHits += 1;
      return { status: 'stale', entry: refreshed, missingIds };
    }
    this.hits += 1;
    return { status: 'hit', entry: refreshed, missingIds };
  }

  get(cartId: string): CartCacheEntry | undefined {
    return this.entries.get(cartId);
  }

  get size(): number {
    return this.entries.size;
  }

  get usedBytes(): number {
    return this.payloadBytes;
  }

  /**
   * Clear every volatile entry. Returns what was dropped so callers can audit
   * that no durable fact was involved; no durable object is reachable from here.
   */
  clear(): { readonly clearedCartIds: readonly string[]; readonly clearedBytes: number } {
    const clearedCartIds = [...this.entries.keys()].sort();
    const clearedBytes = this.payloadBytes;
    this.entries.clear();
    this.payloadBytes = 0;
    this.clears += 1;
    return { clearedCartIds, clearedBytes };
  }

  snapshot(): CartVolatileCacheSnapshot {
    return {
      nodeId: this.nodeId,
      region: this.region,
      entries: this.entries.size,
      payloadBytes: this.payloadBytes,
      capacityBytes: this.capacityBytes,
      ttlUs: this.ttlUs,
      stores: this.stores,
      hits: this.hits,
      staleHits: this.staleHits,
      misses: this.misses,
      evictions: this.evictions,
      rejections: this.rejections,
      clears: this.clears,
    };
  }
}
