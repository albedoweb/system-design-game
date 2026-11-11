/**
 * Deterministic random streams for the Live Audience workload.
 *
 * Identity choices, per-user favourite streams, activity arrivals, read
 * arrivals and the fault schedule all use separate streams. Nothing here knows
 * about a graph, a strategy, the scheduler or resource contention, so the same
 * seed always offers the same input trace to every design.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const ZERO_FALLBACK = 0x6d2b79f5;

export function audienceHash(text: string): number {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

export class AudienceRng {
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

  /** Uniform in (0, 1); never exactly zero or one. */
  nextUnit(): number {
    return (this.nextUint32() + 0.5) / 4_294_967_296;
  }

  /** Uniform integer in [0, bound). */
  nextBelow(bound: number): number {
    return this.nextUint32() % bound;
  }
}

export function createAudienceStream(seed: number, stream: string): AudienceRng {
  return new AudienceRng(
    audienceHash(`live-audience-trace-v1|${seed >>> 0}|${stream}`),
  );
}

/** Exponential interarrival hazard in "interval units"; strictly positive. */
export function audienceHazard(rng: AudienceRng): number {
  const unit = rng.nextUnit();
  const hazard = -Math.log(unit);
  return Number.isFinite(hazard) && hazard > 0 ? hazard : Number.MIN_VALUE;
}
