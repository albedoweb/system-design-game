/**
 * Deterministic random streams for the Image Atlas evaluator.
 *
 * The trace generator is the only consumer of randomness. Every stream is
 * derived from the seed and a stream name, so arrivals, keys, provider
 * latency bands and fault traces never depend on the graph, node ids, labels,
 * positions or insertion order. Replaying the same seed with the same model
 * and content versions reproduces the same bytes.
 *
 * This module is pure: no Date, no Math.random, no DOM and no Worker APIs.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** xorshift32 must never start at zero; this is the parcel/engine fallback. */
const ZERO_FALLBACK = 0x6d2b79f5;

/** 32-bit FNV-1a hash used to derive independent streams. */
export function imageHash(text: string): number {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

export class ImageRng {
  private state: number;

  constructor(seed: number) {
    const normalized = seed >>> 0;
    this.state = normalized === 0 ? ZERO_FALLBACK : normalized;
  }

  nextUint32(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x >>>= 0;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x;
  }

  /** Uniform in (0, 1); never exactly zero so exponential hazards stay finite. */
  nextUnit(): number {
    return (this.nextUint32() + 0.5) / 4294967296;
  }

  /** Uniform integer in [0, bound). `bound` must be a positive integer. */
  nextBelow(bound: number): number {
    return this.nextUint32() % bound;
  }
}

export function createImageStream(seed: number, stream: string): ImageRng {
  return new ImageRng(imageHash(`image-atlas-trace-v1|${seed >>> 0}|${stream}`));
}

/** Exponential hazard used for Poisson arrivals; never zero or infinite. */
export function imageHazard(rng: ImageRng): number {
  const unit = rng.nextUnit();
  const hazard = -Math.log(unit);
  return Number.isFinite(hazard) && hazard > 0 ? hazard : Number.MIN_VALUE;
}

/**
 * Picks one latency band index from declared probabilities. The cumulative
 * sum is compared against a uniform sample; a floating-point overshoot falls
 * back to the last band, so the choice is always a declared band.
 */
export function pickBandIndex(
  rng: ImageRng,
  probabilities: readonly number[],
): number {
  const unit = rng.nextUnit();
  let cumulative = 0;
  for (let index = 0; index < probabilities.length; index += 1) {
    cumulative += probabilities[index] ?? 0;
    if (unit < cumulative) {
      return index;
    }
  }
  return Math.max(0, probabilities.length - 1);
}
