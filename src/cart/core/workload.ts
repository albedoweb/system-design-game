/**
 * Fixed Global Cart workload (GC-006).
 *
 * Everything in this module is a pure function of `(caseId, seed)`. It never
 * reads a topology, a graph, a clock, a locale or the DOM, so the scheduled and
 * offered logical counts are topology-independent and every case resets
 * independently: building `peak` before or after `normal` yields identical
 * intents and identical hashes.
 *
 * Frozen data source: immutable `experiments/global-cart-v1/input/workload.json`
 * (profile `global-cart-v1-candidate`). The constants below mirror that file
 * literally; the tests pin the mirrors to the frozen literals.
 *
 * Each intent is an immutable operation request with its causal dependency
 * DAG. Failures never delete work: `resolveCartIntentFailures` marks dependent
 * offers as failed while the offered denominator stays exactly as scheduled.
 */

import {
  CART_DEFAULT_SEED,
  CART_WORKLOAD_PROFILE_IDS,
  CART_ADVANCED_REQUIRED_CASES,
  CART_ALL_CASES,
  CART_BASIC_REQUIRED_CASES,
  CART_REGIONS,
  canonicalJson,
  sha256Hex,
  type CartCaseId,
  type CartRegion,
} from '../contracts';
import {
  cartRequestId,
  createCartCaseStreams,
  isCartSeed,
  type CartRngStream,
} from './rng';

// ---------------------------------------------------------------------------
// Frozen workload profile (mirror of workload.json)
// ---------------------------------------------------------------------------

/** Effective profile id of the gameplay default. */
export const CART_WORKLOAD_PROFILE_VERSION = CART_WORKLOAD_PROFILE_IDS.basic;

export type CartBackgroundSlot =
  | 'Add'
  | 'Read'
  | 'ChangeQuantity'
  | 'Alternating'
  | 'RemoveItem'
  | 'Checkout';

/** Twenty slots per session, in order (workload.json `background.slots`). */
export const CART_BACKGROUND_SLOTS = [
  'Add',
  'Read',
  'Add',
  'Read',
  'Add',
  'Read',
  'ChangeQuantity',
  'Read',
  'ChangeQuantity',
  'Read',
  'Add',
  'Read',
  'Alternating',
  'Read',
  'RemoveItem',
  'Add',
  'Add',
  'Read',
  'Checkout',
  'Checkout',
] as const satisfies readonly CartBackgroundSlot[];

/** Read slots that may execute at the next region when `c % 20 === 0`. */
export const CART_REMOTE_READ_SLOTS = [1, 3, 5, 7, 9, 11, 13, 17] as const;

export const CART_BACKGROUND = {
  carts: 3_000,
  skus: 100,
  initialStockPerSku: 1_000_000,
  clientsPerRegion: 20,
  roundStartMs: [0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000],
  sessionsPerRegionPerRound: 100,
  slotSpacingMs: 500,
  sessionOffsetMs: 5,
  extraPeakRoundStartMs: [20_000, 30_000, 40_000, 50_000],
  /** Fraction of sessions whose remote reads run in the next region. */
  remoteReadModulo: 20,
} as const;

// ---------------------------------------------------------------------------
// Versioned workload profiles (GC-WL2)
// ---------------------------------------------------------------------------

export type CartWorkloadProfileId =
  (typeof CART_WORKLOAD_PROFILE_IDS)[keyof typeof CART_WORKLOAD_PROFILE_IDS];

/**
 * Immutable scheduling profile. It changes only the offer *times* of sessions
 * (`sessionOffsetMs`) and the length of the measured accounting window that
 * must cover the last offer plus its deadline. Logical ids, request sequences,
 * effects, dependencies, RNG draws and offered counts are untouched, and the
 * values are topology independent. It is passed explicitly through the
 * workload, model, session and cost accounting; there is no module state.
 */
export interface CartWorkloadProfile {
  readonly id: CartWorkloadProfileId;
  readonly sessionOffsetMs: number;
  readonly measuredUs: number;
  /** Required cases of this profile, in evaluation order. */
  readonly cases: readonly CartCaseId[];
  /**
   * Fault-free profile: no Tokyo partition/restoration, no cache clear and no
   * scripted advanced probes. Background traffic and safety audits stay real.
   */
  readonly faultFree: boolean;
}

/** Frozen original profile: 5 ms session offset, 90 s measured window. */
export const CART_WORKLOAD_PROFILE_ORIGINAL: CartWorkloadProfile = Object.freeze({
  id: CART_WORKLOAD_PROFILE_IDS.original,
  sessionOffsetMs: 5,
  measuredUs: 90_000_000,
  cases: CART_ADVANCED_REQUIRED_CASES,
  faultFree: false,
});

/**
 * Adopted candidate: 100 ms session offset. The last offer is at 99.4 s and
 * has a 1 s deadline, so the measured window is 101 s.
 */
export const CART_WORKLOAD_PROFILE_DESYNC100: CartWorkloadProfile = Object.freeze({
  id: CART_WORKLOAD_PROFILE_IDS.desync100,
  sessionOffsetMs: 100,
  measuredUs: 101_000_000,
  cases: CART_ADVANCED_REQUIRED_CASES,
  faultFree: false,
});

/**
 * Cart Foundations (D002): the gameplay default. Same 100 ms offset, 101 s
 * measured window and offered counts as desync100, but only Normal and Rush,
 * with no incident events and no scripted advanced probes.
 */
export const CART_WORKLOAD_PROFILE_BASIC: CartWorkloadProfile = Object.freeze({
  id: CART_WORKLOAD_PROFILE_IDS.basic,
  sessionOffsetMs: 100,
  measuredUs: 101_000_000,
  cases: CART_BASIC_REQUIRED_CASES,
  faultFree: true,
});

export const CART_WORKLOAD_PROFILES: Readonly<Record<CartWorkloadProfileId, CartWorkloadProfile>> =
  Object.freeze({
    [CART_WORKLOAD_PROFILE_IDS.original]: CART_WORKLOAD_PROFILE_ORIGINAL,
    [CART_WORKLOAD_PROFILE_IDS.desync100]: CART_WORKLOAD_PROFILE_DESYNC100,
    [CART_WORKLOAD_PROFILE_IDS.basic]: CART_WORKLOAD_PROFILE_BASIC,
  });

/** Gameplay evaluation default (public session, evaluator and worker). */
export const CART_DEFAULT_WORKLOAD_PROFILE: CartWorkloadProfile = CART_WORKLOAD_PROFILE_BASIC;

/** Validates a (possibly experimental) profile; throws RangeError when unusable. */
export function assertCartWorkloadProfile(profile: CartWorkloadProfile): CartWorkloadProfile {
  const offset = profile.sessionOffsetMs;
  if (!Number.isInteger(offset) || offset < 0 || offset > 100) {
    throw new RangeError(`sessionOffsetMs must be an integer in [0,100] (got ${String(offset)}).`);
  }
  if (!Number.isInteger(profile.measuredUs) || profile.measuredUs <= 0) {
    throw new RangeError(`measuredUs must be a positive integer (got ${String(profile.measuredUs)}).`);
  }
  return profile;
}

export const CART_CASE_OFFERED_COUNTS: Readonly<Record<CartCaseId, number>> = {
  normal: 54_000,
  peak: 78_000,
  mobility: 54_000,
  concurrent: 54_000,
  partition: 54_000,
  checkout: 54_000,
};

// ---------------------------------------------------------------------------
// Intent model
// ---------------------------------------------------------------------------

export type CartIntentOperation = 'edit' | 'read' | 'checkout';
export type CartIntentEditKind = 'add' | 'change' | 'remove';
export type CartIntentStream = 'base' | 'extra-peak';

export interface CartIntentKey {
  readonly originRegion: CartRegion;
  readonly clientId: string;
  readonly requestSequence: number;
}

export interface CartAddEffect {
  readonly kind: 'add';
  readonly sku: number;
  readonly count: number;
}

export interface CartChangeEffect {
  readonly kind: 'change';
  readonly sku: number;
  readonly target: number;
}

export interface CartRemoveEffect {
  readonly kind: 'remove';
  readonly sku: number;
}

export interface CartReadEffect {
  readonly kind: 'read';
  /** Session edit prefix token this read must cover. */
  readonly token: readonly string[];
  /** Region whose device executes the read; the edit origin never moves. */
  readonly servedBy: CartRegion;
}

export interface CartCheckoutEffect {
  readonly kind: 'checkout';
  /** Immutable binding to the complete read at slot 17. */
  readonly selectionReadId: string;
}

export type CartIntentEffect =
  | CartAddEffect
  | CartChangeEffect
  | CartRemoveEffect
  | CartReadEffect
  | CartCheckoutEffect;

export interface CartOperationIntent {
  /** Unique request id; deterministic and collision-free by construction. */
  readonly id: string;
  readonly caseId: CartCaseId;
  readonly atUs: number;
  readonly cartId: string;
  readonly region: CartRegion;
  readonly remoteReadRegion: CartRegion | null;
  readonly key: CartIntentKey;
  readonly slotIndex: number;
  readonly stream: CartIntentStream;
  readonly operation: CartIntentOperation;
  readonly editKind: CartIntentEditKind | null;
  readonly effect: CartIntentEffect;
  /** Complete dependencies, already ACKed before this offer. */
  readonly observedContext: readonly string[];
  /** Causal DAG parents; a failed parent fails this offer, never removes it. */
  readonly dependsOn: readonly string[];
}

export interface CartCaseIntentCounts {
  readonly add: number;
  readonly change: number;
  readonly remove: number;
  readonly edits: number;
  readonly reads: number;
  readonly remoteReads: number;
  readonly checkouts: number;
}

export interface CartCaseWorkload {
  readonly caseId: CartCaseId;
  readonly seed: number;
  readonly profileVersion: CartWorkloadProfileId;
  readonly profile: CartWorkloadProfile;
  readonly rounds: number;
  readonly sessions: number;
  readonly scheduled: number;
  readonly counts: CartCaseIntentCounts;
  readonly intents: readonly CartOperationIntent[];
  readonly traceHash: string;
}

export interface CartWorkload {
  readonly seed: number;
  readonly profileVersion: CartWorkloadProfileId;
  readonly profile: CartWorkloadProfile;
  readonly cases: Readonly<Record<CartCaseId, CartCaseWorkload>>;
  readonly traceHash: string;
}

/** Optional observation hooks; they may never influence the trace. */
export interface CartWorkloadHooks {
  readonly onCaseStart?: (caseId: CartCaseId, seed: number) => void;
  readonly onIntent?: (intent: CartOperationIntent) => void;
  readonly onCaseEnd?: (workload: CartCaseWorkload) => void;
}

// ---------------------------------------------------------------------------
// Trace hashing
// ---------------------------------------------------------------------------

/**
 * Hash of the semantic trace: intents sorted by `(atUs, id)` so that a different
 * construction or scheduler cadence with the same scheduled offers hashes
 * identically. Labels, positions and object key order never participate.
 */
export function cartCaseTraceHash(intents: readonly CartOperationIntent[]): string {
  const ordered = [...intents].sort((a, b) => {
    if (a.atUs !== b.atUs) return a.atUs - b.atUs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sha256Hex(canonicalJson(ordered));
}

/**
 * Trace hash over one case or a whole workload. The whole-workload hash is
 * case-order independent because cases are emitted in canonical case order.
 */
export function cartWorkloadTraceHash(
  workload: Pick<CartWorkload, 'cases'> | Pick<CartCaseWorkload, 'intents'>,
): string {
  if ('cases' in workload) {
    const cases = CART_ALL_CASES.filter((caseId) => caseId in workload.cases).map(
      (caseId) => workload.cases[caseId],
    );
    return sha256Hex(canonicalJson(cases.map((entry) => entry.traceHash)));
  }
  return cartCaseTraceHash(workload.intents);
}

// ---------------------------------------------------------------------------
// Failure resolution (denominators never shrink)
// ---------------------------------------------------------------------------

export interface CartFailureResolution {
  readonly scheduled: number;
  readonly offered: number;
  readonly failed: number;
  readonly dependencyFailed: number;
  readonly intact: number;
  /** Every scheduled intent, still present, with its resolved outcome. */
  readonly outcomes: readonly { readonly id: string; readonly failed: boolean }[];
}

/**
 * Resolve direct failures and their transitive dependents. The offered
 * denominator (`scheduled === offered`) is reported unchanged by construction:
 * callers can record failed probes without ever removing them from a gate.
 */
export function resolveCartIntentFailures(
  intents: readonly CartOperationIntent[],
  failedIds: Iterable<string>,
): CartFailureResolution {
  const failed = new Set<string>(failedIds);
  const outcomes: { id: string; failed: boolean }[] = [];
  let dependencyFailed = 0;
  // Inputs are topologically ordered by construction (dependencies precede
  // dependents), so one forward pass propagates transitive failures.
  for (const intent of intents) {
    const direct = failed.has(intent.id);
    const inherited = intent.dependsOn.some((dep) => failed.has(dep));
    const isFailed = direct || inherited;
    if (isFailed) failed.add(intent.id);
    if (inherited && !direct) dependencyFailed += 1;
    outcomes.push({ id: intent.id, failed: isFailed });
  }
  const failedCount = outcomes.filter((entry) => entry.failed).length;
  return {
    scheduled: intents.length,
    offered: intents.length,
    failed: failedCount,
    dependencyFailed,
    intact: outcomes.length - failedCount,
    outcomes,
  };
}

// ---------------------------------------------------------------------------
// Case construction
// ---------------------------------------------------------------------------

function nextRegion(region: CartRegion): CartRegion {
  const index = CART_REGIONS.indexOf(region);
  const next = CART_REGIONS[(index + 1) % CART_REGIONS.length];
  return next ?? CART_REGIONS[0];
}

function rect(region: CartRegion): number {
  return CART_REGIONS.indexOf(region);
}

interface SessionPlan {
  readonly caseId: CartCaseId;
  readonly round: number;
  readonly roundStartUs: number;
  readonly stream: CartIntentStream;
  readonly streamOrdinal: number;
  readonly extraRound: number | null;
  readonly region: CartRegion;
  readonly regionOrdinal: number;
  readonly sessionIndex: number;
  readonly cartIndex: number;
}

function buildSessionPlan(
  caseId: CartCaseId,
  round: number,
  roundStartMs: number,
  stream: CartIntentStream,
  streamOrdinal: number,
  extraRound: number | null,
): SessionPlan[] {
  const plans: SessionPlan[] = [];
  for (const region of CART_REGIONS) {
    const regionOrdinal = rect(region);
    for (let c = 0; c < CART_BACKGROUND.sessionsPerRegionPerRound; c += 1) {
      const cartIndex =
        stream === 'base'
          ? round * 300 + regionOrdinal * 100 + c
          : (2_700 + (extraRound ?? 0) * 300 + regionOrdinal * 100 + c) % CART_BACKGROUND.carts;
      plans.push({
        caseId,
        round,
        roundStartUs: roundStartMs * 1_000,
        stream,
        streamOrdinal,
        extraRound,
        region,
        regionOrdinal,
        sessionIndex: c,
        cartIndex,
      });
    }
  }
  return plans;
}

function resolveSlotName(slot: CartBackgroundSlot, sessionIndex: number): 'Add' | 'Read' | 'ChangeQuantity' | 'RemoveItem' | 'Checkout' {
  if (slot === 'Alternating') {
    return sessionIndex % 2 === 0 ? 'ChangeQuantity' : 'RemoveItem';
  }
  return slot;
}

function buildSessionIntents(
  plan: SessionPlan,
  profile: CartWorkloadProfile,
  streams: Readonly<Record<'sku' | 'add' | 'change' | 'rotation', CartRngStream>>,
): CartOperationIntent[] {
  const intents: CartOperationIntent[] = [];
  const clientId = `bg:${plan.region}:${plan.round}:${plan.sessionIndex % CART_BACKGROUND.clientsPerRegion}`;
  const cartId = `cart:${String(plan.cartIndex).padStart(4, '0')}`;
  const sku = streams.sku.drawModulo(CART_BACKGROUND.skus);
  const prefix: string[] = [];
  let selectionReadId: string | null = null;

  for (let slotIndex = 0; slotIndex < CART_BACKGROUND_SLOTS.length; slotIndex += 1) {
    const slot = CART_BACKGROUND_SLOTS[slotIndex];
    if (slot === undefined) continue;
    const name = resolveSlotName(slot, plan.sessionIndex);
    const atUs =
      plan.roundStartUs +
      plan.sessionIndex * profile.sessionOffsetMs * 1_000 +
      slotIndex * CART_BACKGROUND.slotSpacingMs * 1_000;
    const requestSequence = (plan.streamOrdinal * 100 + plan.sessionIndex) * 20 + slotIndex;
    const id = cartRequestId([
      plan.caseId,
      plan.round,
      plan.streamOrdinal,
      plan.region,
      plan.sessionIndex,
      slotIndex,
    ]);
    const key: CartIntentKey = {
      originRegion: plan.region,
      clientId,
      requestSequence,
    };
    const base = {
      id,
      caseId: plan.caseId,
      atUs,
      cartId,
      region: plan.region,
      key,
      slotIndex,
      stream: plan.stream,
    } as const;

    if (name === 'Read') {
      const remote =
        plan.sessionIndex % CART_BACKGROUND.remoteReadModulo === 0 &&
        (CART_REMOTE_READ_SLOTS as readonly number[]).includes(slotIndex);
      const servedBy = remote ? nextRegion(plan.region) : plan.region;
      const token = [...prefix];
      if (slotIndex === 17) selectionReadId = id;
      intents.push({
        ...base,
        remoteReadRegion: remote ? servedBy : null,
        operation: 'read',
        editKind: null,
        effect: { kind: 'read', token, servedBy },
        observedContext: [],
        dependsOn: token,
      });
      continue;
    }

    if (name === 'Checkout') {
      if (selectionReadId === null) {
        throw new Error(`Checkout slot ${slotIndex} has no complete selection read for ${id}.`);
      }
      const selection = selectionReadId;
      intents.push({
        ...base,
        remoteReadRegion: null,
        operation: 'checkout',
        editKind: null,
        effect: { kind: 'checkout', selectionReadId: selection },
        observedContext: [],
        dependsOn: [selection],
      });
      continue;
    }

    const observedContext = [...prefix];
    let editKind: CartIntentEditKind;
    let effect: CartIntentEffect;
    if (name === 'Add') {
      editKind = 'add';
      effect = {
        kind: 'add',
        sku,
        count: 1 + streams.add.drawModulo(5),
      };
    } else if (name === 'ChangeQuantity') {
      editKind = 'change';
      effect = {
        kind: 'change',
        sku,
        target: streams.change.drawModulo(21),
      };
    } else {
      editKind = 'remove';
      effect = { kind: 'remove', sku };
    }

    intents.push({
      ...base,
      remoteReadRegion: null,
      operation: 'edit',
      editKind,
      effect,
      observedContext,
      dependsOn: observedContext,
    });
    prefix.push(id);
  }

  return intents;
}

function emptyCounts(): {
  add: number;
  change: number;
  remove: number;
  edits: number;
  reads: number;
  remoteReads: number;
  checkouts: number;
} {
  return { add: 0, change: 0, remove: 0, edits: 0, reads: 0, remoteReads: 0, checkouts: 0 };
}

/** Build one case in isolation. No case can observe another case's state. */
export function buildCartCaseWorkload(
  caseId: CartCaseId,
  seed: number = CART_DEFAULT_SEED,
  profile: CartWorkloadProfile = CART_DEFAULT_WORKLOAD_PROFILE,
): CartCaseWorkload {
  assertCartWorkloadProfile(profile);
  if (!isCartSeed(seed)) {
    throw new RangeError(`Cart workload seed must be a uint32 integer (got ${String(seed)}).`);
  }
  if (!(CART_ALL_CASES as readonly string[]).includes(caseId)) {
    throw new Error(`Unknown cart case: ${String(caseId)}`);
  }
  if (!profile.cases.includes(caseId)) {
    throw new Error(`Cart case ${String(caseId)} is not part of profile ${profile.id}.`);
  }

  const streams = createCartCaseStreams(seed);
  const intents: CartOperationIntent[] = [];
  const counts = emptyCounts();
  let sessions = 0;

  for (let round = 0; round < CART_BACKGROUND.roundStartMs.length; round += 1) {
    const roundStartMs = CART_BACKGROUND.roundStartMs[round];
    if (roundStartMs === undefined) continue;
    // Frozen iteration order: (round, streamOrdinal, region, session, slot).
    const plans = buildSessionPlan(caseId, round, roundStartMs, 'base', 0, null);
    if (caseId === 'peak') {
      const extraRound = (CART_BACKGROUND.extraPeakRoundStartMs as readonly number[]).indexOf(roundStartMs);
      if (extraRound >= 0) {
        plans.push(
          ...buildSessionPlan(caseId, round, roundStartMs, 'extra-peak', 1, extraRound),
        );
      }
    }

    for (const plan of plans) {
      sessions += 1;
      const sessionIntents = buildSessionIntents(plan, profile, streams);
      for (const intent of sessionIntents) {
        intents.push(intent);
        if (intent.operation === 'edit') {
          counts.edits += 1;
          if (intent.editKind === 'add') counts.add += 1;
          else if (intent.editKind === 'change') counts.change += 1;
          else counts.remove += 1;
        } else if (intent.operation === 'read') {
          counts.reads += 1;
          if (intent.remoteReadRegion !== null) counts.remoteReads += 1;
        } else {
          counts.checkouts += 1;
        }
      }
    }
  }

  const expected = CART_CASE_OFFERED_COUNTS[caseId];
  if (intents.length !== expected) {
    throw new Error(
      `Cart case ${caseId} scheduled ${intents.length} intents, frozen profile requires ${expected}.`,
    );
  }

  return {
    caseId,
    seed,
    profileVersion: profile.id,
    profile,
    rounds: CART_BACKGROUND.roundStartMs.length,
    sessions,
    scheduled: intents.length,
    counts,
    intents,
    traceHash: cartCaseTraceHash(intents),
  };
}

/**
 * Build all six cases. Cases are independent: each one re-creates its own RNG
 * streams from the same seed, so evaluation order cannot change any draw.
 */
export function buildCartWorkload(
  seed: number = CART_DEFAULT_SEED,
  hooks: CartWorkloadHooks = {},
  profile: CartWorkloadProfile = CART_DEFAULT_WORKLOAD_PROFILE,
): CartWorkload {
  assertCartWorkloadProfile(profile);
  if (!isCartSeed(seed)) {
    throw new RangeError(`Cart workload seed must be a uint32 integer (got ${String(seed)}).`);
  }
  const cases = {} as Record<CartCaseId, CartCaseWorkload>;
  for (const caseId of profile.cases) {
    hooks.onCaseStart?.(caseId, seed);
    const workload = buildCartCaseWorkload(caseId, seed, profile);
    if (hooks.onIntent) {
      for (const intent of workload.intents) hooks.onIntent(intent);
    }
    hooks.onCaseEnd?.(workload);
    cases[caseId] = workload;
  }
  return {
    seed,
    profileVersion: profile.id,
    profile,
    cases,
    traceHash: sha256Hex(canonicalJson(profile.cases.map((caseId) => cases[caseId].traceHash))),
  };
}

/**
 * Offered logical count for one case. Takes no topology argument at all: a
 * player graph can never change how many logical operations a case offers.
 */
export function cartCaseOfferedCount(caseId: CartCaseId): number {
  return CART_CASE_OFFERED_COUNTS[caseId];
}
