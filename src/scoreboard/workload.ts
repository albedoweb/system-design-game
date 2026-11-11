import type { ScoreboardLevel } from './contracts';
import { createScoreboardStream, scoreboardHazard } from './rng';

/**
 * Frozen, graph-independent offered trace for one seed.
 *
 * The trace contains every accepted offer before the simulation starts. Reads
 * use three phase rates; vote changes run at a constant average rate. Identity
 * streams choose the participant and proposed candidate. The simulator only
 * decides how those identical offers are served.
 */

export interface ScoreboardReadRequest {
  readonly id: number;
  readonly operation: 'read';
  /** Time relative to the measured start. */
  readonly atMs: number;
}

export interface ScoreboardWriteRequest {
  readonly id: number;
  readonly operation: 'write';
  readonly atMs: number;
  readonly participant: number;
  readonly candidate: number;
}

export type ScoreboardRequest =
  | ScoreboardReadRequest
  | ScoreboardWriteRequest;

export interface ScoreboardTrace {
  readonly seed: number;
  readonly requests: readonly ScoreboardRequest[];
  readonly readCount: number;
  readonly writeCount: number;
  readonly firstReadAtMs: number;
  readonly firstWriteAtMs: number;
}

interface Arrival {
  readonly atMs: number;
  readonly order: number;
}

function readArrivals(level: ScoreboardLevel, seed: number): Arrival[] {
  const arrivals: Arrival[] = [];
  let order = 0;
  level.workload.readPhases.forEach((phase, phaseIndex) => {
    if (phase.readsPerSecond <= 0 || phase.toMs <= phase.fromMs) {
      return;
    }
    const rng = createScoreboardStream(seed, `read-arrivals-${phaseIndex}`);
    const ratePerMs = phase.readsPerSecond / 1_000;
    let timeMs = phase.fromMs;
    for (;;) {
      timeMs += scoreboardHazard(rng) / ratePerMs;
      if (timeMs >= phase.toMs) {
        break;
      }
      arrivals.push({ atMs: timeMs, order });
      order += 1;
    }
  });
  return arrivals;
}

function writeArrivals(level: ScoreboardLevel, seed: number): Arrival[] {
  if (level.workload.voteChangesPerSecond <= 0) {
    return [];
  }
  const rng = createScoreboardStream(seed, 'write-arrivals');
  const ratePerMs = level.workload.voteChangesPerSecond / 1_000;
  const arrivals: Arrival[] = [];
  let timeMs = 0;
  let order = 0;
  for (;;) {
    timeMs += scoreboardHazard(rng) / ratePerMs;
    if (timeMs >= level.workload.measuredMs) {
      break;
    }
    arrivals.push({ atMs: timeMs, order });
    order += 1;
  }
  return arrivals;
}

/**
 * Generate the same offered trace for every graph and strategy at one seed.
 * Request ids are assigned after the deterministic ordering, so they are also
 * stable across runs.
 */
export function generateScoreboardTrace(
  seed: number,
  level: ScoreboardLevel,
): ScoreboardTrace {
  const reads = readArrivals(level, seed);
  const writes = writeArrivals(level, seed);
  const participantRng = createScoreboardStream(seed, 'write-participants');
  const candidateRng = createScoreboardStream(seed, 'write-candidates');

  type Ordered =
    | { readonly kind: 'read'; readonly atMs: number; readonly order: number }
    | {
        readonly kind: 'write';
        readonly atMs: number;
        readonly order: number;
        readonly participant: number;
        readonly candidate: number;
      };

  const all: Ordered[] = [];
  for (const arrival of reads) {
    all.push({ kind: 'read', ...arrival });
  }
  for (const arrival of writes) {
    all.push({
      kind: 'write',
      ...arrival,
      participant:
        participantRng.nextUint32() % level.dataset.participants,
      candidate: candidateRng.nextUint32() % level.dataset.candidates,
    });
  }

  // Reads before writes at an identical timestamp; both are deterministic.
  all.sort((a, b) => {
    if (a.atMs !== b.atMs) {
      return a.atMs - b.atMs;
    }
    if (a.kind !== b.kind) {
      return a.kind === 'read' ? -1 : 1;
    }
    return a.order - b.order;
  });

  const requests: ScoreboardRequest[] = all.map((item, id) =>
    item.kind === 'read'
      ? { id, operation: 'read', atMs: item.atMs }
      : {
          id,
          operation: 'write',
          atMs: item.atMs,
          participant: item.participant,
          candidate: item.candidate,
        },
  );

  return {
    seed,
    requests,
    readCount: reads.length,
    writeCount: writes.length,
    firstReadAtMs: reads[0]?.atMs ?? 0,
    firstWriteAtMs: writes[0]?.atMs ?? 0,
  };
}

/** Deterministic initial current vote for every participant. */
export function generateInitialVotes(
  seed: number,
  level: ScoreboardLevel,
): Uint16Array {
  const rng = createScoreboardStream(seed, 'initial-votes');
  const votes = new Uint16Array(level.dataset.participants);
  const candidates = level.dataset.candidates;
  for (let participant = 0; participant < votes.length; participant += 1) {
    votes[participant] = rng.nextUint32() % candidates;
  }
  return votes;
}
