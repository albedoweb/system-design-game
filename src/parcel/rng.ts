/**
 * Small deterministic RNG for the Parcel Pulse trace. Independent streams are
 * derived from the seed and a stream name, so status/history/ingest arrivals
 * never influence each other and never depend on the graph or horizon.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const ZERO_FALLBACK = 0x6d2b79f5;

export function parcelHash(text: string): number {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

export class ParcelRng {
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

  nextUnit(): number {
    return (this.nextUint32() + 0.5) / 4294967296;
  }
}

export function createParcelStream(seed: number, stream: string): ParcelRng {
  return new ParcelRng(parcelHash(`parcel-trace-v1|${seed >>> 0}|${stream}`));
}

/** Exponential hazard; never zero or infinite. */
export function parcelHazard(rng: ParcelRng): number {
  const unit = rng.nextUnit();
  const hazard = -Math.log(unit);
  return Number.isFinite(hazard) && hazard > 0 ? hazard : Number.MIN_VALUE;
}
