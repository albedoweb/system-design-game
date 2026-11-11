/**
 * Deterministic RNG v1 (see CONTRACTS.md): FNV-1a 32 over the UTF-8 seed
 * tuple, then xorshift32. The generator is deliberately small and has no
 * platform-dependent state.
 */

export const XORSHIFT_ZERO_FALLBACK = 0x6d2b79f5;

export function fnv1a32(text: string): number {
  const bytes = new TextEncoder().encode(text);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class Xorshift32 {
  private state: number;

  constructor(seed: number) {
    const normalized = seed >>> 0;
    this.state = normalized === 0 ? XORSHIFT_ZERO_FALLBACK : normalized;
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

  /** `(x + 0.5) / 2^32`, therefore strictly inside `(0, 1)`. */
  nextUnit(): number {
    return (this.nextUint32() + 0.5) / 4294967296;
  }
}

export type RngStreamRole = 'arrivals' | 'keys';

export function createStreamRng(
  seed: number,
  workloadId: string,
  role: RngStreamRole,
): Xorshift32 {
  const material = JSON.stringify(['rng-v1', seed >>> 0, workloadId, role]);
  return new Xorshift32(fnv1a32(material));
}

/** Exponential sample expressed as accumulated Poisson hazard. */
export function exponentialHazard(rng: { nextUnit(): number }): number {
  const unit = rng.nextUnit();
  const hazard = -Math.log(unit);
  return Number.isFinite(hazard) && hazard > 0 ? hazard : Number.MIN_VALUE;
}
