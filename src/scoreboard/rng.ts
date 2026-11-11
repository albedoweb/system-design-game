/**
 * Deterministic random streams for the Live Scoreboard workload.
 *
 * Arrivals and identities are generated before any graph or scheduler exists.
 * Stream names isolate reads, writes, participants and candidates, so changing
 * a strategy cannot change the offered request trace.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const ZERO_FALLBACK = 0x6d2b79f5;

export function scoreboardHash(text: string): number {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

export class ScoreboardRng {
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
    return (this.nextUint32() + 0.5) / 4_294_967_296;
  }
}

export function createScoreboardStream(
  seed: number,
  stream: string,
): ScoreboardRng {
  return new ScoreboardRng(
    scoreboardHash(`live-scoreboard-trace-v1|${seed >>> 0}|${stream}`),
  );
}

/** Exponential interarrival hazard; strictly positive and finite. */
export function scoreboardHazard(rng: ScoreboardRng): number {
  const unit = rng.nextUnit();
  const hazard = -Math.log(unit);
  return Number.isFinite(hazard) && hazard > 0 ? hazard : Number.MIN_VALUE;
}
