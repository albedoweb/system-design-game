/**
 * Deterministic pseudo-random streams for the Global Cart workload (GC-006).
 *
 * `workload.json` freezes one linear-congruential recurrence and four named
 * stream tags. Nothing here may consult `Math.random`, `Date`, locale state or
 * object key order: a run must be reproducible from `(seed, tag)` alone, in any
 * case order, on any scheduler cadence.
 *
 * Frozen recurrence (frozen input `workload.json`, `background.seededFields`):
 *   x0 = (seed XOR tag * 2654435761) mod 2^32
 *   xn = (1664525 * x(n-1) + 1013904223) mod 2^32
 *
 * Draws are plain `next % limit`, exactly as specified. Streams are separate
 * per tag so that adding a draw in one stream (for example a rarer SKU) can
 * never shift the values observed by another stream.
 */

export const CART_RNG_MULTIPLIER = 1_664_525;
export const CART_RNG_INCREMENT = 1_013_904_223;
export const CART_RNG_TAG_MULTIPLIER = 2_654_435_761;

/** Stream tags frozen by `workload.json`: 1=SKU, 2=Add, 3=Change, 4=rotation. */
export const CART_STREAM_TAGS = {
  sku: 1,
  add: 2,
  change: 3,
  rotation: 4,
} as const;

export type CartStreamName = keyof typeof CART_STREAM_TAGS;
export type CartStreamTag = (typeof CART_STREAM_TAGS)[CartStreamName];

export const CART_STREAM_NAMES = Object.keys(CART_STREAM_TAGS) as readonly CartStreamName[];

const UINT32_MAX = 4_294_967_295;
const MAX_TAG = 0xffff;

/** Seed must be a uint32 integer; the protocol default is 1729. */
export function isCartSeed(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= UINT32_MAX
  );
}

function assertSeed(seed: number): void {
  if (!isCartSeed(seed)) {
    throw new RangeError(`Cart seed must be a uint32 integer (got ${String(seed)}).`);
  }
}

function assertTag(tag: number): void {
  if (!Number.isInteger(tag) || tag < 1 || tag > MAX_TAG) {
    throw new RangeError(`Cart stream tag must be an integer in 1..${MAX_TAG} (got ${String(tag)}).`);
  }
}

/**
 * Mutable cursor over one frozen RNG stream. The object is intentionally not
 * frozen (it has state), but every value it produces is a pure function of
 * `(seed, tag)` and the number of draws taken before it.
 */
export interface CartRngStream {
  readonly seed: number;
  readonly tag: number;
  /** Current 32-bit state, exposed for reproducible evidence only. */
  state(): number;
  /** Next uint32 in the frozen recurrence. */
  nextUint32(): number;
  /** `nextUint32() % limit`; unchecked bias is part of the frozen contract. */
  drawModulo(limit: number): number;
}

export function createCartRngStream(seed: number, tag: number): CartRngStream {
  assertSeed(seed);
  assertTag(tag);

  let state = (seed ^ Math.imul(tag, CART_RNG_TAG_MULTIPLIER)) >>> 0;

  const nextUint32 = (): number => {
    state = (Math.imul(CART_RNG_MULTIPLIER, state) + CART_RNG_INCREMENT) >>> 0;
    return state;
  };

  return {
    seed,
    tag,
    state: () => state,
    nextUint32,
    drawModulo(limit: number): number {
      if (!Number.isInteger(limit) || limit < 1 || limit > 0x1_0000_0000) {
        throw new RangeError(`drawModulo limit must be an integer in 1..2^32 (got ${String(limit)}).`);
      }
      return nextUint32() % limit;
    },
  };
}

/**
 * Four independent streams for one evaluation run. Every case builds its own
 * set from the same seed, so case order can never change a case's draws and a
 * case reset is indistinguishable from a first run.
 *
 * The rotation stream is exposed because `workload.json` reserves tag 4 for
 * rotation-dependent scripts. The current frozen background script derives
 * alternation from the session ordinal (`c` parity) and remote-read rotation
 * from the region ordinal, so it takes no rotation draw — drawing only at
 * relevant intents is required, and an unused draw would shift nothing but
 * would misrepresent the schedule.
 */
export function createCartCaseStreams(seed: number): Readonly<Record<CartStreamName, CartRngStream>> {
  return {
    sku: createCartRngStream(seed, CART_STREAM_TAGS.sku),
    add: createCartRngStream(seed, CART_STREAM_TAGS.add),
    change: createCartRngStream(seed, CART_STREAM_TAGS.change),
    rotation: createCartRngStream(seed, CART_STREAM_TAGS.rotation),
  };
}

/** ASCII identifier part accepted by the protocol (1..64 chars per token). */
const ID_PART = /^[A-Za-z0-9._@:-]+$/;

/**
 * Deterministic request identifier built from explicit parts. Two requests can
 * only collide if every part collides, so callers that keep `(case, round,
 * stream, region, session, slot)` distinct always get distinct ids.
 */
export function cartRequestId(parts: readonly (string | number)[]): string {
  if (parts.length === 0) {
    throw new Error('cartRequestId requires at least one part.');
  }
  const rendered = parts.map((part) => {
    const text = String(part);
    if (text.length === 0 || text.length > 64 || !ID_PART.test(text)) {
      throw new Error(`Invalid cart request id part: ${JSON.stringify(text)}`);
    }
    return text;
  });
  return rendered.join(':');
}
