/**
 * GC-009 focused tests: token coverage, origin certificates, delivery-time
 * freshness, finite volatile caches and the two read policies.
 *
 * Expectations come from `cart-protocol-v1` §4/B2 and the §7 byte/work tables:
 * certificate 128+32/id and 0.10 CPU-ms + 1 IO (journal adds 0.05/op and one IO
 * per 16 scanned ops), read request 256+32/token id, missing-ID request
 * 128+32/id, covered view 256+32/covered+32/unit+24/tombstone+certs, freshness
 * cut `delivery - 2000 ms`, cache TTL 1 s with 4 MiB S payload.
 */
import { describe, expect, it } from 'vitest';

import { CART_REGIONS, type CartRegion } from '../contracts';
import type { CartOperationEnvelope, CartOperationKey } from '../core/operations';
import { cartOperationId } from '../core/operations';
import {
  CartDurableStore,
  cartSessionToken,
  type CartDurableReadResult,
  type CartSessionToken,
} from '../core/durable-store';
import { CartVolatileCache, type CartCacheEntry } from '../core/cache';
import {
  CartOriginCommitLedger,
  auditCartCertificates,
  cartCertificateBytes,
  cartCertificateCharge,
  cartCoveredViewBytes,
  cartDeliveryFreshnessCut,
  cartMissingIdRequestBytes,
  cartReadRequestBytes,
  cartTokenMissing,
  cartTokenUnion,
  carryCartCertificate,
  isCertificateIssuedBy,
  mergeCartCertificates,
  parseCartSessionToken,
  type CartCertificate,
  type CartDurableCommit,
  type CartReplicatedCertificate,
} from '../core/tokens';
import {
  CartReadEngine,
  orderCartReadTargets,
  type CartReadExchange,
  type CartReadNode,
  type CartReadOutcome,
} from '../core/reads';

const CART = 'cart-read-1';

const AUTHORITIES: Record<CartRegion, string> = {
  'us-west': 'journal-uw',
  'eu-central': 'journal-fra',
  'ap-northeast': 'journal-tky',
};

/** A cache that wrongly believes one rogue node is every origin's authority. */
const FORGED_AUTHORITIES: Record<CartRegion, string> = {
  'us-west': 'rogue-cache',
  'eu-central': 'rogue-cache',
  'ap-northeast': 'rogue-cache',
};

function edit(
  sequence: number,
  origin: CartRegion,
  quantity = 1,
  sku = 'sku-a',
): CartOperationEnvelope {
  const key: CartOperationKey = {
    originRegion: origin,
    clientId: 'client-1',
    requestSequence: sequence,
  };
  return { cartId: CART, key, payload: { sku, kind: 'add', quantity }, observedContext: [] };
}

interface Journal {
  readonly store: CartDurableStore;
  readonly ledger: CartOriginCommitLedger;
  readonly region: CartRegion;
}

function makeJournal(region: CartRegion): Journal {
  const nodeId = AUTHORITIES[region];
  const ledger = new CartOriginCommitLedger(nodeId, AUTHORITIES);
  const store = new CartDurableStore({
    nodeId,
    kind: 'journal',
    size: 'S',
    writeAuthorities: AUTHORITIES,
    replicationEdges: [],
    onDurableCommit: (checkpoint) => {
      ledger.record(
        checkpoint.cartId,
        region,
        checkpoint.operationId,
        checkpoint.atUs,
        checkpoint.fingerprint,
      );
    },
  });
  return { store, ledger, region };
}

function makeReplica(): { store: CartDurableStore; ledger: CartOriginCommitLedger } {
  const ledger = new CartOriginCommitLedger('store-uw', AUTHORITIES);
  const store = new CartDurableStore({
    nodeId: 'store-uw',
    kind: 'store',
    size: 'S',
    writeAuthorities: AUTHORITIES,
    replicationEdges: [],
    onDurableCommit: (checkpoint) => {
      const origin = checkpoint.operationId.split('/')[0] as CartRegion;
      ledger.record(
        checkpoint.cartId,
        origin,
        checkpoint.operationId,
        checkpoint.atUs,
        checkpoint.fingerprint,
      );
    },
  });
  return { store, ledger };
}

/** Branded durable provenance for one committed edit. */
function attestFor(journal: Journal, sequence: number, quantity = 1): CartDurableCommit {
  return attestCart(journal, CART, sequence, quantity);
}

function cartEnvelope(
  cartId: string,
  region: CartRegion,
  sequence: number,
  quantity = 1,
): CartOperationEnvelope {
  return { ...edit(sequence, region, quantity), cartId };
}

/** Branded durable provenance for one committed edit in an arbitrary cart. */
function attestCart(
  journal: Journal,
  cartId: string,
  sequence: number,
  quantity = 1,
): CartDurableCommit {
  const attestation = journal.ledger.attest(
    cartId,
    cartEnvelope(cartId, journal.region, sequence, quantity),
  );
  if (attestation === undefined) throw new Error('durable attestation failed');
  return attestation;
}

function journalNode(journal: Journal, reachable: (atUs: number) => boolean): CartReadNode {
  return {
    nodeId: journal.store.nodeId,
    region: journal.region,
    kind: 'journal',
    reachable,
    durableRead: (cartId): CartDurableReadResult => journal.store.readCart(cartId),
    envelope: (cartId, operationId) =>
      journal.store.envelopeFor({ cartId, operationId }),
    certifies: (origin) =>
      origin === journal.region
        ? { role: 'authority', ledger: journal.ledger, kind: 'journal' }
        : undefined,
  };
}

function replicaNode(store: CartDurableStore, reachable: () => boolean): CartReadNode {
  return {
    nodeId: store.nodeId,
    region: 'us-west',
    kind: 'store',
    reachable,
    durableRead: (cartId) => store.readCart(cartId),
    envelope: (cartId, operationId) => store.envelopeFor({ cartId, operationId }),
  };
}

function commit(journal: Journal, sequence: number, atUs: number, quantity = 1): string {
  const envelope = edit(sequence, journal.region, quantity);
  const result = journal.store.commitEdit(envelope, atUs);
  if (!result.ok) throw new Error(`commit rejected: ${result.reason}`);
  return cartOperationId(envelope.key);
}

/** The modeled authority durable ledgers a topology is configured with. */
function authorityLedgerMap(
  journals: readonly Journal[],
): Record<CartRegion, CartOriginCommitLedger> {
  const ledgers = {} as Record<CartRegion, CartOriginCommitLedger>;
  for (const journal of journals) ledgers[journal.region] = journal.ledger;
  return ledgers;
}

/** Configured but empty authority ledgers, for topologies that use no journal. */
function emptyAuthorityLedgers(): Record<CartRegion, CartOriginCommitLedger> {
  return authorityLedgerMap(CART_REGIONS.map((region) => makeJournal(region)));
}

function engine(
  targets: readonly CartReadNode[],
  policy: 'local-repair' | 'parallel' = 'local-repair',
  authorityLedgers: Record<CartRegion, CartOriginCommitLedger> = emptyAuthorityLedgers(),
): CartReadEngine {
  return new CartReadEngine({
    cartId: CART,
    policy,
    localRegion: 'us-west',
    targets,
    authorities: AUTHORITIES,
    authorityLedgers,
  });
}

function expectComplete(outcome: CartReadOutcome) {
  if (outcome.kind !== 'complete') {
    throw new Error(`expected complete read, got ${outcome.kind}: ${JSON.stringify(outcome).slice(0, 400)}`);
  }
  return outcome;
}

describe('coverage certificates and tokens', () => {
  it('lists exactly the origin commits at or before the cut, sorted', () => {
    const journal = makeJournal('us-west');
    const first = commit(journal, 1, 1_000);
    const second = commit(journal, 2, 2_000);
    commit(journal, 3, 3_000);

    const early = journal.ledger.issue(CART, 'us-west', 1_500);
    expect(early.ok).toBe(true);
    if (!early.ok) return;
    expect(early.certificate.ids).toEqual([first].sort());
    expect(early.certificate.cutUs).toBe(1_500);
    expect(early.certificate.authorityNodeId).toBe('journal-uw');

    const full = journal.ledger.issue(CART, 'us-west', 2_000);
    if (!full.ok) return;
    expect(full.certificate.ids).toEqual([first, second].sort());

    // Only the configured authority of an origin may mint its certificate; a
    // ledger for another origin (even with the same broker map) cannot.
    expect(journal.ledger.issue(CART, 'eu-central', 2_000)).toMatchObject({
      ok: false,
      reason: 'authority-not-configured',
    });
    // The real eu authority has no commits here: an explicit empty certificate.
    const euAuthority = makeJournal('eu-central');
    const other = euAuthority.ledger.issue(CART, 'eu-central', 2_000);
    if (!other.ok) return;
    expect(other.certificate.ids).toEqual([]);
    expect(isCertificateIssuedBy(other.certificate, euAuthority.ledger)).toBe(true);
    expect(isCertificateIssuedBy(other.certificate, journal.ledger)).toBe(false);
  });

  it('charges journal enumeration and store materialization differently', () => {
    // 0.10 + 0.05*17 = 0.95 CPU-ms, ceil(17/16) = 2 IO for a journal.
    const journal = cartCertificateCharge('journal', 17);
    expect(journal.cpuMilliseconds).toBeCloseTo(0.95, 10);
    expect(journal.ioUnits).toBe(2);
    expect(cartCertificateCharge('journal', 0)).toEqual({ cpuMilliseconds: 0.1, ioUnits: 1 });
    expect(cartCertificateCharge('store', 17)).toEqual({ cpuMilliseconds: 0.1, ioUnits: 1 });
  });

  it('validates token versions, duplicates and the 400-id cap', () => {
    const valid = parseCartSessionToken({
      version: 'cart-session-token-v1',
      cartId: CART,
      ids: ['b', 'a'],
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.token.ids).toEqual(['a', 'b']);

    expect(parseCartSessionToken({ version: 'cart-session-token-v9', cartId: CART, ids: [] })).toMatchObject({
      ok: false,
      reason: 'unknown-token-version',
    });
    expect(
      parseCartSessionToken({ version: 'cart-session-token-v1', cartId: CART, ids: ['a', 'a'] }),
    ).toMatchObject({ ok: false, reason: 'malformed-token' });
    const overflow = Array.from({ length: 401 }, (_, index) => `op-${index}`);
    expect(
      parseCartSessionToken({ version: 'cart-session-token-v1', cartId: CART, ids: overflow }),
    ).toMatchObject({ ok: false, reason: 'token-overflow' });
  });

  it('audits freshness at delivery, inclusive at exactly 2000 ms', () => {
    expect(cartDeliveryFreshnessCut(5_000_000)).toBe(3_000_000);
    const certificate: CartCertificate = {
      cartId: CART,
      origin: 'us-west',
      authorityNodeId: 'journal-uw',
      cutUs: 3_000_000,
      ids: [],
    };
    expect(auditCartCertificates([certificate], 5_000_000).fresh).toBe(true);
    expect(auditCartCertificates([{ ...certificate, cutUs: 2_999_999 }], 5_000_000)).toMatchObject({
      fresh: false,
      staleOrigins: ['us-west'],
    });
    // Per origin the newest cut wins; a union never looks stale because of an older copy.
    const merged = mergeCartCertificates([certificate], [{ ...certificate, cutUs: 4_900_000 }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.cutUs).toBe(4_900_000);
  });

  it('uses the frozen wire sizes', () => {
    expect(cartReadRequestBytes(3)).toBe(256 + 96);
    expect(cartMissingIdRequestBytes(2)).toBe(128 + 64);
    const certificate: CartCertificate = {
      cartId: CART,
      origin: 'eu-central',
      authorityNodeId: 'journal-fra',
      cutUs: 10,
      ids: ['a', 'b'],
    };
    expect(cartCertificateBytes(certificate)).toBe(128 + 64);
    expect(
      cartCoveredViewBytes({
        coveredIds: 3,
        unitCount: 2,
        tombstoneCount: 1,
        certificates: [certificate],
      }),
    ).toBe(256 + 96 + 64 + 24 + 192);
  });

  it('computes token coverage and union', () => {
    const token = cartSessionToken(CART, ['a', 'b']);
    expect(cartTokenMissing(token, ['b'])).toEqual(['a']);
    expect(cartTokenUnion(token, ['c', 'a']).ids).toEqual(['a', 'b', 'c']);
  });
});

describe('finite volatile caches', () => {
  it('reports TTL hits and stale revalidation without refreshing certificate cuts', () => {
    const journal = makeJournal('us-west');
    const first = commit(journal, 1, 1_000);
    const certificate = journal.ledger.issue(CART, 'us-west', 999, 'journal');
    if (!certificate.ok) throw new Error('certificate failed');
    const cache = new CartVolatileCache({
      nodeId: 'cache-uw',
      region: 'us-west',
      size: 'S',
      authorities: AUTHORITIES,
    });
    cache.store(
      {
        cartId: CART,
        coveredIds: [first],
        envelopes: [edit(1, 'us-west')],
        certificates: [certificate.certificate],
        provenance: [attestFor(journal, 1)],
      },
      1_000,
    );

    const hit = cache.lookup(CART, 1_000 + 1_000);
    expect(hit.status).toBe('hit');
    const stale = cache.lookup(CART, 1_000 + 1_000_001, [first]);
    expect(stale.status).toBe('stale');
    if (stale.status !== 'miss') {
      expect(stale.missingIds).toEqual([]);
      expect(stale.entry.certificates[0]?.cutUs).toBe(999);
    }
  });

  it('evicts LRU entries under capacity and rejects an oversized entry', () => {
    const journal = makeJournal('us-west');
    const cache = new CartVolatileCache({
      nodeId: 'cache-uw',
      region: 'us-west',
      size: 'S',
      authorities: AUTHORITIES,
      capacityBytes: 1_200,
    });
    // One 1-context envelope is 544 B, so two fit and a third forces eviction.
    const envelopeA = cartEnvelope('a', 'us-west', 1);
    const envelopeB = cartEnvelope('b', 'us-west', 2);
    const envelopeC = cartEnvelope('c', 'us-west', 3);
    expect(journal.store.commitEdit(envelopeA, 0).ok).toBe(true);
    expect(journal.store.commitEdit(envelopeB, 1).ok).toBe(true);
    expect(journal.store.commitEdit(envelopeC, 2).ok).toBe(true);
    expect(
      cache.store(
        {
          cartId: 'a',
          coveredIds: [cartOperationId(envelopeA.key)],
          envelopes: [envelopeA],
          provenance: [attestCart(journal, 'a', 1)],
        },
        0,
      ).ok,
    ).toBe(true);
    expect(
      cache.store(
        {
          cartId: 'b',
          coveredIds: [cartOperationId(envelopeB.key)],
          envelopes: [envelopeB],
          provenance: [attestCart(journal, 'b', 2)],
        },
        1,
      ).ok,
    ).toBe(true);
    const third = cache.store(
      {
        cartId: 'c',
        coveredIds: [cartOperationId(envelopeC.key)],
        envelopes: [envelopeC],
        provenance: [attestCart(journal, 'c', 3)],
      },
      2,
    );
    expect(third.ok).toBe(true);
    expect(third.evictedCartIds).toEqual(['a']);
    expect(cache.get('a')).toBeUndefined();

    const oversized = new CartVolatileCache({
      nodeId: 'cache-small',
      region: 'us-west',
      size: 'S',
      authorities: AUTHORITIES,
      capacityBytes: 100,
    });
    const oversizedEnvelope = cartEnvelope('x', 'us-west', 4);
    expect(journal.store.commitEdit(oversizedEnvelope, 3).ok).toBe(true);
    expect(
      oversized.store(
        {
          cartId: 'x',
          coveredIds: [cartOperationId(oversizedEnvelope.key)],
          envelopes: [oversizedEnvelope],
          provenance: [attestCart(journal, 'x', 4)],
        },
        0,
      ),
    ).toMatchObject({
      ok: false,
      reason: 'cache-payload-capacity',
    });
  });

  it('clears only volatile entries', () => {
    const journal = makeJournal('us-west');
    const first = commit(journal, 1, 1_000);
    const before = journal.store.snapshot();
    const cache = new CartVolatileCache({
      nodeId: 'cache-uw',
      region: 'us-west',
      size: 'S',
      authorities: AUTHORITIES,
    });
    cache.store(
      {
        cartId: CART,
        coveredIds: [first],
        envelopes: [edit(1, 'us-west')],
        provenance: [attestFor(journal, 1)],
      },
      0,
    );
    const cleared = cache.clear();
    expect(cleared.clearedCartIds).toEqual([CART]);
    expect(cache.snapshot().entries).toBe(0);
    expect(journal.store.snapshot()).toEqual(before);
  });

  it('rejects envelopes without durable evidence and non-issued certificates', () => {
    const journal = makeJournal('us-west');
    commit(journal, 1, 1_000);
    const cache = new CartVolatileCache({
      nodeId: 'cache-uw',
      region: 'us-west',
      size: 'S',
      authorities: AUTHORITIES,
    });
    const envelope = edit(1, 'us-west');
    const operationId = cartOperationId(envelope.key);

    // No provenance at all: never admitted.
    expect(
      cache.store({ cartId: CART, coveredIds: [operationId], envelopes: [envelope] }, 0),
    ).toMatchObject({
      ok: false,
      reason: 'cache-missing-provenance',
      untrustedIds: [operationId],
    });
    // A correctly shaped plain object naming the correct authority is not
    // issuance: only a branded durable attestation can admit an envelope.
    const fabricatedAttestation = {
      cartId: CART,
      origin: 'us-west',
      operationId,
      fingerprint: 'fabricated',
      originAuthorityId: 'journal-uw',
      holderNodeId: 'journal-uw',
      committedAtUs: 1_000,
    } as CartDurableCommit;
    expect(
      cache.store(
        {
          cartId: CART,
          coveredIds: [operationId],
          envelopes: [envelope],
          provenance: [fabricatedAttestation],
        },
        0,
      ),
    ).toMatchObject({ ok: false, reason: 'cache-missing-provenance' });

    // Evidence reused from an unrelated cart is not provenance for this cart.
    expect(journal.store.commitEdit(cartEnvelope('other-cart', 'us-west', 1), 2_000).ok).toBe(
      true,
    );
    const foreignAttestation = journal.ledger.attest(
      'other-cart',
      cartEnvelope('other-cart', 'us-west', 1),
    );
    if (foreignAttestation === undefined) throw new Error('attestation failed');
    expect(
      cache.store(
        {
          cartId: CART,
          coveredIds: [operationId],
          envelopes: [envelope],
          provenance: [foreignAttestation],
        },
        0,
      ),
    ).toMatchObject({ ok: false, reason: 'cache-missing-provenance' });

    // Genuine durable evidence is refused when the cache's own topology claims
    // a different authority: strings cannot re-home provenance.
    const rogueTopology = new CartVolatileCache({
      nodeId: 'cache-rogue',
      region: 'us-west',
      size: 'S',
      authorities: FORGED_AUTHORITIES,
    });
    expect(
      rogueTopology.store(
        {
          cartId: CART,
          coveredIds: [operationId],
          envelopes: [envelope],
          provenance: [attestFor(journal, 1)],
        },
        0,
      ),
    ).toMatchObject({ ok: false, reason: 'cache-missing-provenance' });

    // Certificate minted by a non-authority node.
    const forged: CartCertificate = {
      cartId: CART,
      origin: 'us-west',
      authorityNodeId: 'rogue-cache',
      cutUs: 10,
      ids: [],
    };
    expect(
      cache.store({ cartId: CART, coveredIds: [], envelopes: [], certificates: [forged] }, 0),
    ).toMatchObject({
      ok: false,
      reason: 'cache-untrusted-certificate',
      untrustedOrigins: ['us-west'],
    });
    // Correct authority name, never issued: still refused.
    expect(
      cache.store(
        {
          cartId: CART,
          coveredIds: [],
          envelopes: [],
          certificates: [{ ...forged, authorityNodeId: 'journal-uw' }],
        },
        0,
      ),
    ).toMatchObject({ ok: false, reason: 'cache-untrusted-certificate' });
    // A genuine certificate reshaped or copied is no longer issuance.
    const genuine = journal.ledger.issue(CART, 'us-west', 999, 'journal');
    if (!genuine.ok) throw new Error('certificate failed');
    expect(
      cache.store(
        {
          cartId: CART,
          coveredIds: [],
          envelopes: [],
          certificates: [{ ...genuine.certificate, cutUs: 10 }],
        },
        0,
      ),
    ).toMatchObject({ ok: false, reason: 'cache-untrusted-certificate' });
    // Genuine issuance for a different cart is not reusable evidence.
    const otherCartCertificate = journal.ledger.issue('other-cart', 'us-west', 999, 'journal');
    if (!otherCartCertificate.ok) throw new Error('certificate failed');
    expect(
      cache.store(
        {
          cartId: CART,
          coveredIds: [],
          envelopes: [],
          certificates: [otherCartCertificate.certificate],
        },
        0,
      ),
    ).toMatchObject({ ok: false, reason: 'cache-untrusted-certificate' });

    expect(cache.snapshot().entries).toBe(0);
    expect(cache.snapshot().rejections).toBe(7);
    expect(rogueTopology.snapshot().rejections).toBe(1);
  });
});

describe('token-aware reads', () => {
  it('returns a complete local-repair read covering the token and fresh certificates', () => {
    const journals = (['us-west', 'eu-central', 'ap-northeast'] as CartRegion[]).map(makeJournal);
    const usWest = journals[0] as Journal;
    const eu = journals[1] as Journal;
    const ap = journals[2] as Journal;
    commit(usWest, 1, 10_000, 2);
    commit(eu, 1, 11_000, 1);
    commit(ap, 1, 12_000, 1);

    const outcome = engine(
      journals.map((journal) => journalNode(journal, () => true)),
      'local-repair',
      authorityLedgerMap(journals),
    ).read({
      token: cartSessionToken(CART, []),
      requestUs: 20_000,
      deliveryUs: 20_500,
    });
    const complete = expectComplete(outcome);
    expect(complete.coveredIds).toHaveLength(3);
    expect(complete.view.complete).toBe(true);
    expect(complete.view.skus['sku-a']?.quantity).toBe(4);
    expect(complete.evidence.certificates).toHaveLength(3);
    expect(complete.evidence.minimumCutUs).toBeGreaterThanOrEqual(
      cartDeliveryFreshnessCut(20_500),
    );
    expect(complete.charge.requests).toBeGreaterThan(0);
    expect(complete.charge.requestBytes).toBeGreaterThan(0);
    expect(complete.charge.responseBytes).toBeGreaterThan(0);
    expect(complete.charge.cpuMilliseconds).toBeGreaterThan(0);
    // Every covered id came from a reachable journal actually holding it.
    expect([...complete.dataSources].sort()).toEqual(['journal-fra', 'journal-tky', 'journal-uw']);
    expect(complete.outgoingToken.ids).toEqual([...complete.coveredIds].sort());
  });

  it('repairs a stale nonempty cache when the session token has a missing id', () => {
    const journal = makeJournal('us-west');
    const first = commit(journal, 1, 1_000);
    const second = commit(journal, 2, 2_000);
    const cache = new CartVolatileCache({
      nodeId: 'cache-uw',
      region: 'us-west',
      size: 'S',
      authorities: AUTHORITIES,
    });
    cache.store(
      {
        cartId: CART,
        coveredIds: [first],
        envelopes: [edit(1, 'us-west')],
        provenance: [attestFor(journal, 1)],
      },
      0,
    );

    // The application can fetch a missing id from its replica but holds only a
    // stale cache copy locally.
    const proxy: CartReadNode = {
      nodeId: 'app-uw',
      region: 'us-west',
      kind: 'application',
      reachable: () => true,
      cache: () => cache,
      envelope: (_cartId, operationId) =>
        operationId === second ? edit(2, 'us-west') : undefined,
    };
    const eu = makeJournal('eu-central');
    const ap = makeJournal('ap-northeast');
    const targets = [
      proxy,
      {
        // Certificate + missing-id repair only: no bulk durable view here.
        nodeId: 'journal-uw',
        region: 'us-west' as CartRegion,
        kind: 'journal' as const,
        reachable: () => true,
        envelope: (cartId: string, operationId: string) =>
          journal.store.envelopeFor({ cartId, operationId }),
        certifies: (origin: CartRegion) =>
          origin === 'us-west'
            ? { role: 'authority' as const, ledger: journal.ledger, kind: 'journal' as const }
            : undefined,
      },
      journalNode(eu, () => true),
      journalNode(ap, () => true),
    ];

    const outcome = engine(targets, 'local-repair', authorityLedgerMap([journal, eu, ap])).read({
      token: cartSessionToken(CART, [second]),
      requestUs: 2_000_000,
      deliveryUs: 2_000_500,
    });
    const complete = expectComplete(outcome);
    expect(cache.snapshot().staleHits).toBe(1);
    expect(complete.coveredIds).toEqual([first, second].sort());
    const repair = complete.attempts.find((attempt) => attempt.phase === 'repair');
    expect(repair).toBeDefined();
    expect(repair?.requestBytes).toBe(128 + 32);
    expect(repair?.coveredIds).toEqual([second]);
    expect(complete.incomingToken.ids).toEqual([second]);
    expect(complete.outgoingToken.ids).toEqual([first, second].sort());
  });

  it('serves a fresh covering cache hit without inventing targets', () => {
    const usWest = makeJournal('us-west');
    const eu = makeJournal('eu-central');
    const ap = makeJournal('ap-northeast');
    const first = commit(usWest, 1, 1_000);
    const certificates: CartCertificate[] = [];
    for (const journal of [usWest, eu, ap]) {
      const certificate = journal.ledger.issue(CART, journal.region, 999, 'journal');
      if (!certificate.ok) throw new Error('certificate failed');
      certificates.push(certificate.certificate);
    }
    const cache = new CartVolatileCache({
      nodeId: 'cache-uw',
      region: 'us-west',
      size: 'S',
      authorities: AUTHORITIES,
    });
    cache.store(
      {
        cartId: CART,
        coveredIds: [first],
        envelopes: [edit(1, 'us-west')],
        certificates,
        provenance: [attestFor(usWest, 1)],
      },
      1_000,
    );

    const outcome = engine(
      [
        {
          nodeId: 'app-uw',
          region: 'us-west',
          kind: 'application',
          reachable: () => true,
          cache: () => cache,
        },
        journalNode(usWest, () => true),
        journalNode(eu, () => true),
        journalNode(ap, () => true),
      ],
      'local-repair',
      authorityLedgerMap([usWest, eu, ap]),
    ).read({ token: cartSessionToken(CART, [first]), requestUs: 1_500, deliveryUs: 1_900 });
    const complete = expectComplete(outcome);
    expect(cache.snapshot().hits).toBeGreaterThanOrEqual(1);
    expect(complete.coveredIds).toEqual([first]);
    expect(complete.evidence.certificates).toHaveLength(3);
    // The first attempt is the local cache and already carried the covered set.
    expect(complete.attempts[0]?.nodeId).toBe('app-uw');
    expect(complete.attempts[0]?.coveredIds).toEqual([first]);
  });

  it('charges every read request with the incoming token id count', () => {
    // Frozen contract §2: Read request = 256 + 32 * tokenCount.
    const outcome = engine([
      {
        nodeId: 'app-uw',
        region: 'us-west',
        kind: 'application',
        reachable: () => true,
      },
    ]).read({
      token: cartSessionToken(CART, ['op-a', 'op-b']),
      requestUs: 20_000,
      deliveryUs: 20_500,
    });
    expect(outcome.kind).toBe('unavailable');
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]?.requestBytes).toBe(256 + 32 * 2);
    expect(outcome.charge.requestBytes).toBe(256 + 32 * 2);
    expect(outcome.charge.requests).toBe(1);
  });

  it('charges the covered-view response for cache-served data exactly once', () => {
    const journal = makeJournal('us-west');
    const first = commit(journal, 1, 10_000);
    const cache = new CartVolatileCache({
      nodeId: 'cache-uw',
      region: 'us-west',
      size: 'S',
      authorities: AUTHORITIES,
    });
    expect(
      cache.store(
        {
          cartId: CART,
          coveredIds: [first],
          envelopes: [edit(1, 'us-west')],
          provenance: [attestFor(journal, 1)],
        },
        19_500,
      ).ok,
    ).toBe(true);
    const duplicate = new CartVolatileCache({
      nodeId: 'cache-eu',
      region: 'eu-central',
      size: 'S',
      authorities: AUTHORITIES,
    });
    duplicate.store(
      {
        cartId: CART,
        coveredIds: [first],
        envelopes: [edit(1, 'us-west')],
        provenance: [attestFor(journal, 1)],
      },
      19_500,
    );

    const eu = makeJournal('eu-central');
    const ap = makeJournal('ap-northeast');
    const outcome = engine(
      [
        {
          nodeId: 'app-uw',
          region: 'us-west',
          kind: 'application',
          reachable: () => true,
          cache: () => cache,
        },
        {
          nodeId: 'app-eu',
          region: 'eu-central',
          kind: 'application',
          reachable: () => true,
          cache: () => duplicate,
        },
        journalNode(journal, () => true),
        journalNode(eu, () => true),
        journalNode(ap, () => true),
      ],
      'local-repair',
      authorityLedgerMap([journal, eu, ap]),
    ).read({ token: cartSessionToken(CART, [first]), requestUs: 20_000, deliveryUs: 20_500 });

    const complete = expectComplete(outcome);
    const firstAttempt = complete.attempts[0];
    expect(firstAttempt?.nodeId).toBe('app-uw');
    expect(firstAttempt?.coveredIds).toEqual([first]);
    // covered view = 256 + 32*1 covered + 32*1 unit + 24*0 tombs, no certs.
    expect(firstAttempt?.requestBytes).toBe(256 + 32);
    expect(firstAttempt?.responseBytes).toBe(256 + 32 + 32);
    // The duplicate cache contributes no new payload, so it is not charged twice.
    const duplicateAttempt = complete.attempts.find((attempt) => attempt.nodeId === 'app-eu');
    expect(duplicateAttempt).toBeDefined();
    expect(duplicateAttempt?.coveredIds).toEqual([]);
    expect(duplicateAttempt?.responseBytes).toBe(0);
    expect(complete.charge.requestBytes).toBeGreaterThanOrEqual(2 * (256 + 32));
    // Cache-supplied data records its durable provenance (the origin authority),
    // never the volatile cache node itself.
    expect([...complete.dataSources]).toContain('journal-uw');
    expect([...complete.dataSources]).not.toContain('app-uw');
  });

  it('never mints coverage or freshness from a lying cache-only entry', () => {
    // The coordinator's reproduction: a cache-only topology whose cache offers
    // correctly named but never-issued empty certificates and an envelope with
    // a correctly shaped but unbranded provenance record. Cache.store refuses
    // this material; here a hostile cache bypasses admission entirely to prove
    // the read engine itself re-validates against branded issuance.
    const envelope = edit(1, 'us-west');
    const operationId = cartOperationId(envelope.key);
    const forgedCertificates: CartCertificate[] = CART_REGIONS.map((origin) => ({
      cartId: CART,
      origin,
      authorityNodeId: AUTHORITIES[origin],
      cutUs: 19_999,
      ids: [],
    }));
    const fabricatedAttestation = {
      cartId: CART,
      origin: 'us-west',
      operationId,
      fingerprint: 'never-recorded',
      originAuthorityId: 'journal-uw',
      holderNodeId: 'journal-uw',
      committedAtUs: 1_000,
    } as CartDurableCommit;
    const lyingEntry: CartCacheEntry = {
      cartId: CART,
      coveredIds: [operationId],
      envelopes: new Map([[operationId, envelope]]),
      certificates: forgedCertificates,
      provenance: new Map([[operationId, fabricatedAttestation]]),
      storedAtUs: 19_000,
      lastUsedUs: 19_000,
      payloadBytes: 0,
    };
    const lyingCache = {
      nodeId: 'cache-uw',
      region: 'us-west',
      lookup: () => ({ status: 'hit', entry: lyingEntry, missingIds: [] }),
    } as unknown as CartVolatileCache;

    const outcome = engine([
      {
        nodeId: 'app-uw',
        region: 'us-west',
        kind: 'application',
        reachable: () => true,
        cache: () => lyingCache,
      },
    ]).read({
      token: cartSessionToken(CART, [operationId]),
      requestUs: 20_000,
      deliveryUs: 20_500,
    });

    // Unissued freshness is discarded, and the token operation is not covered.
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toBe('unreachable-token-operations');
    expect(outcome.missingTokenIds).toEqual([operationId]);
    expect(outcome.attempts[0]?.coveredIds).toEqual([]);
    expect(outcome.attempts[0]?.certificates).toEqual([]);
    expect(outcome.attempts[0]?.discarded).toEqual(
      [...CART_REGIONS, operationId].sort(),
    );
    // Refused evidence is not a delivered response.
    expect(outcome.attempts[0]?.responseBytes).toBe(0);
  });

  it('rejects a cache-only complete read with correctly named unissued certificates', () => {
    // Exact coordinator reproduction: one cache, no durable nodes or ledgers,
    // three fabricated empty certificates naming the configured authorities,
    // an empty token, store cut 19999, read 20000, deliver 20500. Previously
    // this returned `complete`; issued evidence is required now.
    const forgedCertificates: CartCertificate[] = CART_REGIONS.map((origin) => ({
      cartId: CART,
      origin,
      authorityNodeId: AUTHORITIES[origin],
      cutUs: 19_999,
      ids: [],
    }));
    const lyingEntry: CartCacheEntry = {
      cartId: CART,
      coveredIds: [],
      envelopes: new Map(),
      certificates: forgedCertificates,
      provenance: new Map(),
      storedAtUs: 19_000,
      lastUsedUs: 19_000,
      payloadBytes: 0,
    };
    const lyingCache = {
      nodeId: 'cache-uw',
      region: 'us-west',
      lookup: () => ({ status: 'hit', entry: lyingEntry, missingIds: [] }),
    } as unknown as CartVolatileCache;

    const outcome = engine([
      {
        nodeId: 'app-uw',
        region: 'us-west',
        kind: 'application',
        reachable: () => true,
        cache: () => lyingCache,
      },
    ]).read({ token: cartSessionToken(CART, []), requestUs: 20_000, deliveryUs: 20_500 });

    expect(outcome.kind).not.toBe('complete');
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.reason).toBe('missing-origin-evidence');
    expect(outcome.evidence.certificates).toEqual([]);
    expect(outcome.evidence.missingOrigins).toEqual([...CART_REGIONS]);
    expect(outcome.attempts[0]?.discarded).toEqual([...CART_REGIONS].sort());
    expect(outcome.attempts[0]?.responseBytes).toBe(0);
  });

  it('ignores certificates from a non-issuing certifies callback', () => {
    // A modeled node can only supply freshness through branded authority
    // issuance. A callback returning a plain certificate shape mints nothing.
    const fabricated = (origin: CartRegion): CartCertificate => ({
      cartId: CART,
      origin,
      authorityNodeId: AUTHORITIES[origin],
      cutUs: 19_999,
      ids: [],
    });
    const fakeLedger = {
      issue: (cartId: string, origin: CartRegion) => ({
        ok: true,
        certificate: { ...fabricated(origin), cartId },
        charge: { cpuMilliseconds: 0, ioUnits: 0 },
      }),
    } as unknown as CartOriginCommitLedger;

    const outcome = engine([
      {
        nodeId: 'app-uw',
        region: 'us-west',
        kind: 'application',
        reachable: () => true,
        certifies: () => ({ role: 'authority', ledger: fakeLedger, kind: 'store' }),
      },
    ]).read({ token: cartSessionToken(CART, []), requestUs: 20_000, deliveryUs: 20_500 });

    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.reason).toBe('missing-origin-evidence');
    expect(outcome.evidence.certificates).toEqual([]);
    expect(outcome.evidence.missingOrigins).toEqual([...CART_REGIONS]);
  });

  it('refuses freshness minted by empty ledgers that only name the configured authorities', () => {
    // Reviewer reproduction: one reachable cache-only application target
    // exposes three caller-built ledgers whose node ids are the configured
    // authorities but which recorded nothing. Issuance branding must not be
    // enough; the read recognizes only the configured authority ledger object.
    const configured = emptyAuthorityLedgers();
    const forged = CART_REGIONS.map(
      (origin) => new CartOriginCommitLedger(AUTHORITIES[origin], AUTHORITIES),
    );
    const minted = forged[0]!.issue(CART, 'us-west', 19_999);
    expect(minted.ok).toBe(true);
    if (minted.ok) {
      expect(minted.certificate.authorityNodeId).toBe('journal-uw');
      expect(isCertificateIssuedBy(minted.certificate, configured['us-west'])).toBe(false);
    }

    const outcome = engine([
      {
        nodeId: 'app-uw',
        region: 'us-west',
        kind: 'application',
        reachable: () => true,
        certifies: (origin) => {
          const ledger = forged[CART_REGIONS.indexOf(origin)];
          return ledger === undefined
            ? undefined
            : { role: 'authority' as const, ledger, kind: 'store' as const };
        },
      },
    ]).read({ token: cartSessionToken(CART, []), requestUs: 20_000, deliveryUs: 20_500 });

    expect(outcome.kind).not.toBe('complete');
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.reason).toBe('missing-origin-evidence');
    expect(outcome.evidence.certificates).toEqual([]);
    expect(outcome.evidence.missingOrigins).toEqual([...CART_REGIONS]);
  });

  it('discards cached branded certificates the configured authority ledger never minted', () => {
    const forged = new CartOriginCommitLedger('journal-uw', AUTHORITIES);
    const minted = forged.issue(CART, 'us-west', 19_999);
    if (!minted.ok) throw new Error('forged issuance failed');
    const lyingEntry: CartCacheEntry = {
      cartId: CART,
      coveredIds: [],
      envelopes: new Map(),
      certificates: [minted.certificate],
      provenance: new Map(),
      storedAtUs: 19_000,
      lastUsedUs: 19_000,
      payloadBytes: 0,
    };
    const lyingCache = {
      nodeId: 'cache-uw',
      region: 'us-west',
      lookup: () => ({ status: 'hit', entry: lyingEntry, missingIds: [] }),
    } as unknown as CartVolatileCache;

    const outcome = engine([
      {
        nodeId: 'app-uw',
        region: 'us-west',
        kind: 'application',
        reachable: () => true,
        cache: () => lyingCache,
      },
    ]).read({ token: cartSessionToken(CART, []), requestUs: 20_000, deliveryUs: 20_500 });

    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.evidence.certificates).toEqual([]);
    expect(outcome.attempts[0]?.discarded).toEqual(['us-west']);
    expect(outcome.attempts[0]?.responseBytes).toBe(0);
  });

  it('completes from replica-carried authority certificates without advancing their cut', () => {
    const journals = CART_REGIONS.map((region) => makeJournal(region));
    const carries = journals.map((journal) => {
      const issued = journal.ledger.issue(CART, journal.region, 19_000, 'journal');
      if (!issued.ok) throw new Error('certificate failed');
      const carry = carryCartCertificate(issued.certificate, 'store-uw', 19_500);
      if (carry === undefined) throw new Error('carry failed');
      return { region: journal.region, carry };
    });
    const replica: CartReadNode = {
      nodeId: 'store-uw',
      region: 'us-west',
      kind: 'store',
      reachable: () => true,
      certifies: (origin) => {
        const found = carries.find((candidate) => candidate.region === origin);
        return found === undefined ? undefined : { role: 'replica', carry: found.carry };
      },
    };

    const outcome = engine([replica], 'local-repair', authorityLedgerMap(journals)).read({
      token: cartSessionToken(CART, []),
      requestUs: 20_000,
      deliveryUs: 20_500,
    });
    const complete = expectComplete(outcome);
    // Carried evidence keeps the authority's original cut and identity.
    expect(complete.evidence.certificates.map((certificate) => certificate.cutUs)).toEqual([
      19_000, 19_000, 19_000,
    ]);
    for (const certificate of complete.evidence.certificates) {
      expect(certificate.authorityNodeId).toBe(AUTHORITIES[certificate.origin]);
    }
    expect(complete.charge.responseBytes).toBeGreaterThan(0);
  });

  it('refuses replica carries that were not issued by the configured authority ledger', () => {
    const journals = CART_REGIONS.map((region) => makeJournal(region));
    const genuine = journals[0]!.ledger.issue(CART, 'us-west', 19_000, 'journal');
    if (!genuine.ok) throw new Error('certificate failed');
    // A genuine certificate may only be carried once replication completed, and
    // only evidence replicated before the read's last allowed cut is usable.
    const late = carryCartCertificate(genuine.certificate, 'store-uw', 21_000);
    if (late === undefined) throw new Error('carry failed');
    // A caller-built ledger naming the authority mints branded statements, but
    // those are not the configured authority's durable issuance.
    const forged = new CartOriginCommitLedger('journal-uw', AUTHORITIES);
    const forgedIssue = forged.issue(CART, 'us-west', 19_999);
    if (!forgedIssue.ok) throw new Error('forged issuance failed');
    const forgedCarry = carryCartCertificate(forgedIssue.certificate, 'store-uw', 19_900);
    if (forgedCarry === undefined) throw new Error('carry failed');

    const replica = (carry: CartReplicatedCertificate): CartReadNode => ({
      nodeId: 'store-uw',
      region: 'us-west',
      kind: 'store',
      reachable: () => true,
      certifies: (origin) => (origin === 'us-west' ? { role: 'replica', carry } : undefined),
    });

    for (const carry of [late, forgedCarry]) {
      const outcome = engine([replica(carry)], 'local-repair', authorityLedgerMap(journals)).read({
        token: cartSessionToken(CART, []),
        requestUs: 20_000,
        deliveryUs: 20_500,
      });
      expect(outcome.kind).not.toBe('complete');
      expect(outcome.kind).toBe('partial');
      if (outcome.kind !== 'partial') return;
      expect(outcome.evidence.certificates).toEqual([]);
      expect(outcome.evidence.missingOrigins).toEqual([...CART_REGIONS]);
    }
  });

  it('reuses replica-mediated evidence while preserving origin authority and cut', () => {
    const authority = makeJournal('us-west');
    const first = commit(authority, 1, 10_000, 2);
    const replica = makeReplica();
    const envelope = authority.store.envelopeFor({ cartId: CART, operationId: first })!;
    expect(replica.store.ingestReplica(envelope, { atUs: 11_000 }).ok).toBe(true);
    // The replica durably holds the exact payload; provenance still names the
    // origin authority, so a replica is not rejected merely for its node id.
    const replicaEvidence = replica.ledger.attest(CART, envelope);
    if (replicaEvidence === undefined) throw new Error('replica attestation failed');
    expect(replicaEvidence.originAuthorityId).toBe('journal-uw');
    expect(replicaEvidence.holderNodeId).toBe('store-uw');

    const journals = CART_REGIONS.map((region) => makeJournal(region));
    const certificates: CartCertificate[] = [];
    for (const journal of journals) {
      const certificate = journal.ledger.issue(CART, journal.region, 19_999, 'journal');
      if (!certificate.ok) throw new Error('certificate failed');
      certificates.push(certificate.certificate);
    }
    const cache = new CartVolatileCache({
      nodeId: 'cache-uw',
      region: 'us-west',
      size: 'S',
      authorities: AUTHORITIES,
    });
    expect(
      cache.store(
        {
          cartId: CART,
          coveredIds: [first],
          envelopes: [envelope],
          certificates,
          provenance: [replicaEvidence],
        },
        19_000,
      ).ok,
    ).toBe(true);

    const outcome = engine(
      [
        {
          nodeId: 'app-uw',
          region: 'us-west',
          kind: 'application',
          reachable: () => true,
          cache: () => cache,
        },
      ],
      'local-repair',
      authorityLedgerMap(journals),
    ).read({ token: cartSessionToken(CART, [first]), requestUs: 20_000, deliveryUs: 20_500 });

    const complete = expectComplete(outcome);
    expect(complete.coveredIds).toEqual([first]);
    expect(complete.view.skus['sku-a']?.quantity).toBe(2);
    expect(complete.evidence.minimumCutUs).toBe(19_999);
    expect(complete.dataSources).toEqual(['store-uw']);
  });

  it('does not paper over a certificate gap with a maximum sequence number', () => {
    // Contract B2: certificate ids {a1,a2} but the replica holds only a2 is an
    // incomplete read even though the maximum sequence number matches.
    const authority = makeJournal('us-west');
    const a1 = commit(authority, 1, 1_000);
    const a2 = commit(authority, 2, 2_000);
    const replica = makeReplica();
    expect(
      replica.store.ingestReplica(
        authority.store.envelopeFor({ cartId: CART, operationId: a2 })!,
        { atUs: 3_000 },
      ).ok,
    ).toBe(true);

    const authorityNode: CartReadNode = {
      nodeId: 'journal-uw',
      region: 'us-west',
      kind: 'journal',
      reachable: () => true,
      certifies: (origin) =>
        origin === 'us-west'
          ? { role: 'authority', ledger: authority.ledger, kind: 'journal' }
          : undefined,
    };
    const eu = makeJournal('eu-central');
    const ap = makeJournal('ap-northeast');

    const outcome = engine(
      [
        authorityNode,
        replicaNode(replica.store, () => true),
        journalNode(eu, () => true),
        journalNode(ap, () => true),
      ],
      'local-repair',
      authorityLedgerMap([authority, eu, ap]),
    ).read({ token: cartSessionToken(CART, []), requestUs: 20_000, deliveryUs: 20_500 });

    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toBe('unreachable-coverage-operations');
    expect(outcome.missingTokenIds).toEqual([a1]);
  });

  it('rejects expired evidence instead of claiming a fresh success', () => {
    const journal = makeJournal('us-west');
    commit(journal, 1, 1_000);
    const eu = makeJournal('eu-central');
    const ap = makeJournal('ap-northeast');
    const reachable = (atUs: number): boolean => atUs < 1_500_000;
    // Only reachable during the request, not during the refresh round.
    const targets = [
      journalNode(journal, reachable),
      journalNode(eu, reachable),
      journalNode(ap, reachable),
    ];
    const outcome = engine(targets, 'local-repair', authorityLedgerMap([journal, eu, ap])).read({
      token: cartSessionToken(CART, []),
      requestUs: 1_000_000,
      deliveryUs: 3_500_000,
      refreshUs: 2_000_000,
    });
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toBe('stale-evidence');
    expect(outcome.staleOrigins.length).toBeGreaterThan(0);
    expect(outcome.charge.requests).toBeGreaterThan(0);
  });

  it('uses one charged refresh round when the refreshed cut is in bound', () => {
    const journals = (['us-west', 'eu-central', 'ap-northeast'] as CartRegion[]).map(makeJournal);
    commit(journals[0] as Journal, 1, 10_000);
    const cache = new CartVolatileCache({
      nodeId: 'cache-uw',
      region: 'us-west',
      size: 'S',
      authorities: AUTHORITIES,
    });
    const staleCertificate = journals[0]!.ledger.issue(CART, 'us-west', 0, 'journal');
    if (!staleCertificate.ok) throw new Error('certificate failed');
    cache.store(
      {
        cartId: CART,
        coveredIds: [],
        envelopes: [],
        certificates: [staleCertificate.certificate],
      },
      10_000,
    );
    const outcome = engine(
      [
        {
          nodeId: 'app-uw',
          region: 'us-west',
          kind: 'application',
          reachable: () => true,
          cache: () => cache,
        },
        ...journals.map((journal) => journalNode(journal, () => true)),
      ],
      'local-repair',
      authorityLedgerMap(journals),
    ).read({
      token: cartSessionToken(CART, []),
      requestUs: 1_000_000,
      deliveryUs: 3_500_000,
      refreshUs: 2_000_000,
    });
    const complete = expectComplete(outcome);
    expect(complete.evidence.minimumCutUs).toBe(1_999_999);
    expect(complete.evidence.requiredCutUs).toBe(1_500_000);
    expect(complete.attempts.some((attempt) => attempt.phase === 'refresh')).toBe(true);
  });

  it('parallel fan-out has no free completeness: a missing origin is explicitly partial', () => {
    const usWest = makeJournal('us-west');
    const eu = makeJournal('eu-central');
    commit(usWest, 1, 10_000);
    commit(eu, 1, 11_000);
    const apJournal = makeJournal('ap-northeast');
    commit(apJournal, 1, 12_000);
    const replica = makeReplica();
    for (const [journal, sequence] of [
      [usWest, 1],
      [eu, 1],
      [apJournal, 1],
    ] as const) {
      const id = cartOperationId(edit(sequence, journal.region).key);
      expect(replica.store.ingestReplica(journal.store.envelopeFor({ cartId: CART, operationId: id })!, { atUs: 20_000 }).ok).toBe(true);
    }

    const outcome = engine(
      [
        replicaNode(replica.store, () => true),
        journalNode(usWest, () => true),
        journalNode(eu, () => true),
        journalNode(apJournal, () => false),
      ],
      'parallel',
      authorityLedgerMap([usWest, eu, apJournal]),
    ).read({ token: cartSessionToken(CART, []), requestUs: 30_000, deliveryUs: 30_500 });
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.reason).toBe('missing-origin-evidence');
    expect(outcome.evidence.missingOrigins).toEqual(['ap-northeast']);
    expect(outcome.attempts.some((attempt) => attempt.reachable === false)).toBe(true);
    expect(outcome.charge.requests).toBeGreaterThan(0);
  });

  it('reports unavailable when a token operation is only on an unreachable dependency', () => {
    const replica = makeReplica();
    const journal = makeJournal('us-west');
    const id = commit(journal, 1, 10_000);
    expect(
      replica.store.ingestReplica(journal.store.envelopeFor({ cartId: CART, operationId: id })!, {
        atUs: 11_000,
      }).ok,
    ).toBe(true);

    const outcome = engine([replicaNode(replica.store, () => false)], 'parallel').read({
      token: cartSessionToken(CART, [id]),
      requestUs: 20_000,
      deliveryUs: 20_500,
    });
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toBe('unreachable-token-operations');
    expect(outcome.missingTokenIds).toEqual([id]);
    expect(cartTokenMissing(cartSessionToken(CART, [id]), [])).toEqual([id]);
  });

  it('charges journal scan and union-merge work per retained operation', () => {
    const small = makeJournal('us-west');
    commit(small, 1, 1_000);
    const smallRead = small.store.readCart(CART);
    if (!smallRead.ok) throw new Error('read failed');
    // 0.15 + 0.05*1 = 0.20 CPU-ms, one IO for <=16 operations.
    expect(smallRead.charge.cpuMilliseconds).toBeCloseTo(0.2, 10);
    expect(smallRead.charge.ioUnits).toBe(1);

    const large = makeJournal('us-west');
    for (let sequence = 1; sequence <= 17; sequence += 1) commit(large, sequence, sequence * 1_000);
    const largeRead = large.store.readCart(CART);
    if (!largeRead.ok) throw new Error('read failed');
    expect(largeRead.charge.cpuMilliseconds).toBeCloseTo(0.15 + 0.05 * 17, 10);
    expect(largeRead.charge.ioUnits).toBe(2);

    const eu = makeJournal('eu-central');
    const ap = makeJournal('ap-northeast');
    const outcome = engine(
      [journalNode(small, () => true), journalNode(eu, () => true), journalNode(ap, () => true)],
      'local-repair',
      authorityLedgerMap([small, eu, ap]),
    ).read({
      token: cartSessionToken(CART, []),
      requestUs: 20_000,
      deliveryUs: 20_500,
    });
    const complete = expectComplete(outcome);
    // Application front door + journal scan + union merge over one unit.
    expect(complete.charge.cpuMilliseconds).toBeGreaterThan(
      smallRead.charge.cpuMilliseconds,
    );
    expect(complete.charge.ioUnits).toBeGreaterThanOrEqual(1);
  });

  it('reconstructs a complete read after a cache clear without losing durable writes', () => {
    const journal = makeJournal('us-west');
    const first = commit(journal, 1, 1_000, 2);
    const cache = new CartVolatileCache({
      nodeId: 'cache-uw',
      region: 'us-west',
      size: 'S',
      authorities: AUTHORITIES,
    });
    cache.store(
      {
        cartId: CART,
        coveredIds: [first],
        envelopes: [edit(1, 'us-west', 2)],
        provenance: [attestFor(journal, 1, 2)],
      },
      1_000,
    );
    const durableBefore = journal.store.snapshot();
    cache.clear();
    expect(journal.store.snapshot()).toEqual(durableBefore);

    const eu = makeJournal('eu-central');
    const ap = makeJournal('ap-northeast');
    const outcome = engine(
      [journalNode(journal, () => true), journalNode(eu, () => true), journalNode(ap, () => true)],
      'local-repair',
      authorityLedgerMap([journal, eu, ap]),
    ).read({
      token: cartSessionToken(CART, [first]),
      requestUs: 40_000,
      deliveryUs: 40_500,
    });
    const complete = expectComplete(outcome);
    expect(complete.view.skus['sku-a']?.quantity).toBe(2);
    expect(complete.coveredIds).toEqual([first]);
  });

  it('orders targets local-region first, then fixed region and kind order', () => {
    const node = (nodeId: string, region: CartRegion, kind: CartReadNode['kind']): CartReadNode => ({
      nodeId,
      region,
      kind,
      reachable: () => true,
    });
    const ordered = orderCartReadTargets(
      [
        node('z-store-ap', 'ap-northeast', 'store'),
        node('a-app-uw', 'us-west', 'application'),
        node('b-store-uw', 'us-west', 'store'),
        node('c-app-eu', 'eu-central', 'application'),
      ],
      'us-west',
    );
    expect(ordered.map((target) => target.nodeId)).toEqual([
      'a-app-uw',
      'b-store-uw',
      'c-app-eu',
      'z-store-ap',
    ]);
  });
});

/**
 * GC-011 D005 transport-level regressions. These drive the resumable protocol
 * exactly as a real scheduler does — every probe is issued before the first
 * wait, requests and replies are lost, answered late or out of order — and
 * assert the frozen contract only: delivered evidence survives a failed
 * sibling, executed work survives a lost reply, undelivered data is not
 * evidence, and completion is only legal after the protocol reached ready.
 *
 * The starting checkpoint 612ce7c contained three independent defects these
 * tests reproduce (see reports/GC-011-run61-verification).
 */
describe('resumable read protocol transport', () => {
  type Protocol = ReturnType<CartReadEngine['protocol']>;

  /** Freshness-safe delivery: probes are cut at 2999, so 2600 needs cut >= 600. */
  const DELIVERY_US = 2_600;

  function preparedProtocol(): Protocol {
    const journals = CART_REGIONS.map((region) => makeJournal(region));
    commit(journals[0] as Journal, 1, 1_000);
    const reader = engine(
      journals.map((journal) => journalNode(journal, () => true)),
      'parallel',
      authorityLedgerMap(journals),
    );
    return reader.protocol({
      token: cartSessionToken(CART, []),
      requestUs: 2_000,
      deliveryBoundUs: DELIVERY_US,
    });
  }

  function exchange(protocol: Protocol): CartReadExchange {
    const progress = protocol.next();
    if (progress.kind !== 'exchange') {
      throw new Error(`expected exchange, got ${progress.kind}`);
    }
    return progress.exchange;
  }

  /**
   * Drives every remaining stage while losing every remaining request, so a
   * bounded loop is observable rather than a hang. Throws if the protocol
   * never reaches ready within the configured target/repair bound.
   */
  function finishWithRemainingTransportFailed(
    protocol: Protocol,
    deliveryUs = DELIVERY_US,
  ): CartReadOutcome {
    for (let step = 0; step < 64; step += 1) {
      const progress = protocol.next();
      if (progress.kind === 'ready') return protocol.complete(deliveryUs);
      if (progress.kind === 'done') return progress.outcome;
      if (progress.kind === 'wait') throw new Error('unexpected outstanding exchange');
      protocol.settleRequest(progress.exchange.stepId, { serviceStartUs: null });
    }
    throw new Error('protocol did not terminate within the bounded target count');
  }

  it('issues every parallel probe before the first wait', () => {
    const protocol = preparedProtocol();
    const first = exchange(protocol);
    const second = exchange(protocol);
    // A third call must still be an exchange, never a wait: the fan-out may
    // not stop early just because earlier probes are outstanding.
    const third = exchange(protocol);
    expect(new Set([first.stepId, second.stepId, third.stepId]).size).toBe(3);
    expect([first.phase, second.phase, third.phase]).toEqual(['parallel', 'parallel', 'parallel']);
    expect(protocol.next()).toEqual({ kind: 'wait' });
  });

  it('preserves completed sibling evidence after another parallel request fails', () => {
    const journals = CART_REGIONS.map((region) => makeJournal(region));
    const id = commit(journals[0] as Journal, 1, 1_000);
    const protocol = engine(
      journals.map((journal) => journalNode(journal, () => true)),
      'parallel',
      authorityLedgerMap(journals),
    ).protocol({ token: cartSessionToken(CART, []), requestUs: 2_000, deliveryBoundUs: DELIVERY_US });

    const a = exchange(protocol);
    const b = exchange(protocol);
    const c = exchange(protocol);
    // The first sibling really answers; its two peers never receive a request.
    expect(protocol.settleRequest(a.stepId, { serviceStartUs: 3_000 })).not.toBeNull();
    protocol.settleReply(a.stepId, { arrivedUs: 4_000 });
    protocol.settleRequest(b.stepId, { serviceStartUs: null });
    protocol.settleRequest(c.stepId, { serviceStartUs: null });

    const result = finishWithRemainingTransportFailed(protocol);
    expect(result.kind).toBe('partial');
    if (result.kind !== 'partial') throw new Error('expected a partial read');
    // One failed contact may not erase work another exchange already delivered.
    expect(result.coveredIds).toContain(id);
    expect(result.dataSources).toContain('journal-uw');
    const failedProbes = result.attempts.filter(
      (attempt) => !attempt.reachable && attempt.phase === 'parallel',
    );
    expect(failedProbes).toHaveLength(2);
    expect(failedProbes.every((attempt) => attempt.requestBytes === 0)).toBe(true);
  });

  it('settles parallel replies out of order without losing or double counting work', () => {
    const journals = CART_REGIONS.map((region) => makeJournal(region));
    const id = commit(journals[0] as Journal, 1, 1_000);
    const protocol = engine(
      journals.map((journal) => journalNode(journal, () => true)),
      'parallel',
      authorityLedgerMap(journals),
    ).protocol({ token: cartSessionToken(CART, []), requestUs: 2_000, deliveryBoundUs: DELIVERY_US });

    const a = exchange(protocol);
    const b = exchange(protocol);
    const c = exchange(protocol);
    const replyA = protocol.settleRequest(a.stepId, { serviceStartUs: 3_000 });
    const replyB = protocol.settleRequest(b.stepId, { serviceStartUs: 3_100 });
    const replyC = protocol.settleRequest(c.stepId, { serviceStartUs: 3_200 });
    expect(replyA).not.toBeNull();
    expect(replyB).not.toBeNull();
    expect(replyC).not.toBeNull();
    // Reverse arrival order: the last target answers first, the first last.
    protocol.settleReply(c.stepId, { arrivedUs: 4_000 });
    protocol.settleReply(b.stepId, { arrivedUs: 3_900 });
    protocol.settleReply(a.stepId, { arrivedUs: 3_800 });

    const result = finishWithRemainingTransportFailed(protocol);
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('expected a complete read');
    expect(result.coveredIds).toEqual([id]);
    const replies = [replyA, replyB, replyC] as const;
    // Each response is billed once, exactly as it actually arrived.
    expect(result.charge.responseBytes).toBe(
      replies.reduce((sum, reply) => sum + (reply?.responseBytes ?? 0), 0),
    );
    expect(result.charge.ioUnits).toBe(
      replies.reduce((sum, reply) => sum + (reply?.ioUnits ?? 0), 0),
    );
    expect(result.charge.cpuMilliseconds).toBeGreaterThanOrEqual(
      replies.reduce((sum, reply) => sum + (reply?.cpuMilliseconds ?? 0), 0),
    );
    // One probe request per configured target plus one certificate exchange each.
    expect(result.charge.requests).toBe(6);
    // Certificates are cut at the actual service start, not at launch time.
    const usWest = result.evidence.certificates.find(
      (certificate) => certificate.origin === 'us-west',
    );
    expect(usWest?.cutUs).toBe(2_999);
  });

  it('retains executed service work after its reply is lost, without claiming data', () => {
    const protocol = preparedProtocol();
    const a = exchange(protocol);
    const b = exchange(protocol);
    const c = exchange(protocol);
    protocol.settleRequest(b.stepId, { serviceStartUs: null });
    protocol.settleRequest(c.stepId, { serviceStartUs: null });
    const reply = protocol.settleRequest(a.stepId, { serviceStartUs: 3_000 });
    expect(reply).not.toBeNull();
    expect(reply?.ioUnits ?? 0).toBeGreaterThan(0);
    protocol.settleReply(a.stepId, { arrivedUs: null });

    const result = finishWithRemainingTransportFailed(protocol);
    expect(result.kind).toBe('partial');
    if (result.kind !== 'partial') throw new Error('expected a partial read');
    // The node really performed the read: CPU/IO/requests stay charged exactly once.
    expect(result.charge.ioUnits).toBe(reply?.ioUnits);
    expect(result.charge.cpuMilliseconds).toBeCloseTo(reply?.cpuMilliseconds ?? -1, 9);
    expect(result.charge.requests).toBeGreaterThan(0);
    // The response never arrived, so no bytes, envelope or certificate is claimed.
    expect(result.charge.responseBytes).toBe(0);
    expect(result.coveredIds).toEqual([]);
    expect(result.dataSources).toEqual([]);
    expect(result.evidence.certificates).toEqual([]);
  });

  it('refuses completion before ready, then stays terminal and immutable', () => {
    const protocol = preparedProtocol();
    // Nothing has run yet: there is no ready stage to complete.
    expect(() => protocol.complete(DELIVERY_US)).toThrow(/ready/);
    const a = exchange(protocol);
    const b = exchange(protocol);
    const c = exchange(protocol);
    // Pending exchanges block completion before the ready check.
    expect(() => protocol.complete(DELIVERY_US)).toThrow(/outstanding/);
    for (const current of [a, b, c]) {
      expect(protocol.settleRequest(current.stepId, { serviceStartUs: 3_000 })).not.toBeNull();
      protocol.settleReply(current.stepId, { arrivedUs: 3_500 });
    }
    // Every exchange settled, but the protocol itself still owes its ready stage.
    expect(() => protocol.complete(DELIVERY_US)).toThrow(/ready/);
    expect(protocol.next().kind).toBe('ready');

    const first = protocol.complete(DELIVERY_US);
    // Duplicate completion returns the exact same immutable outcome.
    expect(protocol.complete(DELIVERY_US)).toBe(first);
    expect(protocol.complete(9_999)).toBe(first);
    expect(protocol.next()).toEqual({ kind: 'done', outcome: first });
    // Late callbacks cannot resurrect a terminal read.
    expect(() => protocol.settleReply(a.stepId, { arrivedUs: 20_000 })).toThrow();
    expect(() => protocol.settleRequest(a.stepId, { serviceStartUs: 20_000 })).toThrow();
  });

  it('bounds repair rounds when every repair contact fails', () => {
    const protocol = preparedProtocol();
    for (let index = 0; index < 3; index += 1) {
      protocol.settleRequest(exchange(protocol).stepId, { serviceStartUs: null });
    }
    const result = finishWithRemainingTransportFailed(protocol);
    // Every configured target was contacted, but nothing arrived: a partial read
    // with no delivered bytes, no charge, and a bounded number of attempts.
    expect(result.kind).toBe('partial');
    if (result.kind !== 'partial') throw new Error('expected a partial read');
    expect(result.charge.requests).toBe(0);
    expect(result.charge.ioUnits).toBe(0);
    expect(result.charge.responseBytes).toBe(0);
    expect(result.coveredIds).toEqual([]);
    expect(result.attempts).toHaveLength(6);
    expect(result.attempts.every((attempt) => !attempt.reachable)).toBe(true);
  });

  it('terminates an unknown token without issuing any exchange', () => {
    const journal = makeJournal('us-west');
    const protocol = engine([journalNode(journal, () => true)]).protocol({
      token: { version: 99, cartId: CART, ids: [] } as unknown as CartSessionToken,
      requestUs: 2_000,
    });
    for (let step = 0; step < 4; step += 1) {
      const progress = protocol.next();
      expect(progress.kind).toBe('done');
      if (progress.kind !== 'done') return;
      expect(progress.outcome.kind).toBe('unavailable');
      if (progress.outcome.kind !== 'unavailable') return;
      expect(progress.outcome.reason).toBe('unknown-token');
      expect(progress.outcome.attempts).toEqual([]);
      expect(protocol.complete(2_600)).toBe(progress.outcome);
    }
    expect(() => protocol.settleRequest('x:0', { serviceStartUs: 1 })).toThrow();
    expect(() => protocol.settleReply('x:0', { arrivedUs: 1 })).toThrow();
  });

  it('terminates when a token operation only lives on an unreachable target', () => {
    const journal = makeJournal('us-west');
    const id = commit(journal, 1, 1_000);
    const protocol = engine([journalNode(journal, () => false)]).protocol({
      token: cartSessionToken(CART, [id]),
      requestUs: 2_000,
    });
    const progress = protocol.next();
    expect(progress.kind).toBe('done');
    if (progress.kind !== 'done') return;
    expect(progress.outcome.kind).toBe('unavailable');
    if (progress.outcome.kind !== 'unavailable') return;
    expect(progress.outcome.reason).toBe('unreachable-token-operations');
    expect(progress.outcome.missingTokenIds).toEqual([id]);
    expect(progress.outcome.charge.requests).toBe(0);
    expect(protocol.complete(2_600)).toBe(progress.outcome);
  });

  it('terminates when certificate-covered operations are held by no target', () => {
    const journal = makeJournal('us-west');
    commit(journal, 1, 1_000);
    // The node is the configured authority and can certify, but retains no
    // envelope itself: its certificate will demand an operation nobody serves.
    const certifyingOnly: CartReadNode = {
      nodeId: 'journal-uw',
      region: 'us-west',
      kind: 'journal',
      reachable: () => true,
      certifies: (origin) =>
        origin === 'us-west'
          ? { role: 'authority', ledger: journal.ledger, kind: 'journal' }
          : undefined,
    };
    const protocol = engine(
      [certifyingOnly],
      'parallel',
      { ...emptyAuthorityLedgers(), 'us-west': journal.ledger },
    ).protocol({
      token: cartSessionToken(CART, []),
      requestUs: 2_000,
      deliveryBoundUs: DELIVERY_US,
    });
    const probe = exchange(protocol);
    expect(protocol.settleRequest(probe.stepId, { serviceStartUs: 3_000 })).not.toBeNull();
    protocol.settleReply(probe.stepId, { arrivedUs: 3_200 });
    const progress = protocol.next();
    expect(progress.kind).toBe('done');
    if (progress.kind !== 'done') return;
    expect(progress.outcome.kind).toBe('unavailable');
    if (progress.outcome.kind !== 'unavailable') return;
    expect(progress.outcome.reason).toBe('unreachable-coverage-operations');
    expect(protocol.complete(DELIVERY_US)).toBe(progress.outcome);
  });

  it('cancels a pending exchange and rejects its late callbacks', () => {
    const protocol = preparedProtocol();
    const a = exchange(protocol);
    const b = exchange(protocol);
    const c = exchange(protocol);
    expect(protocol.settleRequest(a.stepId, { serviceStartUs: 3_000 })).not.toBeNull();
    // Cancelled before the request left the caller: no work, no reply.
    expect(protocol.settleRequest(b.stepId, { serviceStartUs: null })).toBeNull();
    // A cancelled exchange can never be settled later.
    expect(() => protocol.settleReply(b.stepId, { arrivedUs: 4_000 })).toThrow(/unknown/);
    // The served sibling's response is lost.
    protocol.settleReply(a.stepId, { arrivedUs: null });
    protocol.settleRequest(c.stepId, { serviceStartUs: null });

    const result = finishWithRemainingTransportFailed(protocol);
    expect(result.kind).toBe('partial');
    // The completed terminal protocol rejects every late callback, including
    // one for an exchange that was actually served.
    expect(() => protocol.settleReply(a.stepId, { arrivedUs: 50_000 })).toThrow();
    expect(() => protocol.settleReply(b.stepId, { arrivedUs: 50_000 })).toThrow();
    expect(() => protocol.settleRequest(c.stepId, { serviceStartUs: 50_000 })).toThrow();
    expect(protocol.next()).toEqual({ kind: 'done', outcome: result });
    expect(protocol.complete(60_000)).toBe(result);
  });
});
