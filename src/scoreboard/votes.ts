import type { ScoreboardLevel, ScoreboardSqlReadPlan } from './contracts';
import { generateInitialVotes } from './workload';

/**
 * Versioned current-vote state.
 *
 * One participant has exactly one current vote. A commit is one synchronous
 * function that updates the participant row, adjusts the old/new candidate
 * counts and (for the aggregate plan) the maintained projection. JavaScript
 * runs that function atomically, so same-participant updates serialize in
 * deterministic scheduler order; a late callback can never observe half a
 * commit.
 */

export interface VoteCommit {
  /** One-based committed version. */
  readonly version: number;
  readonly participant: number;
  readonly previous: number;
  readonly next: number;
  readonly commitMs: number;
}

export interface VoteCommitOutcome {
  readonly version: number;
  readonly previous: number;
  readonly next: number;
  readonly changed: boolean;
}

export interface VoteState {
  readonly participants: number;
  readonly candidates: number;
  readonly votes: Uint16Array;
  readonly counts: Uint32Array;
  /** Maintained projection for the aggregate plan, otherwise null. */
  readonly aggregateCounts: Uint32Array | null;
  readonly initialCounts: Uint32Array;
  readonly writes: VoteCommit[];
  version: number;
}

export interface LeaderboardEntry {
  readonly candidate: number;
  readonly votes: number;
}

export function histogramFromVotes(
  votes: Uint16Array,
  candidates: number,
): Uint32Array {
  const counts = new Uint32Array(candidates);
  for (let index = 0; index < votes.length; index += 1) {
    const candidate = votes[index];
    if (candidate === undefined || candidate >= candidates) {
      throw new RangeError('vote index outside the candidate range');
    }
    counts[candidate] = (counts[candidate] ?? 0) + 1;
  }
  return counts;
}

export function createVoteState(
  seed: number,
  level: ScoreboardLevel,
  plan: ScoreboardSqlReadPlan,
): VoteState {
  const votes = generateInitialVotes(seed, level);
  const counts = histogramFromVotes(votes, level.dataset.candidates);
  return {
    participants: level.dataset.participants,
    candidates: level.dataset.candidates,
    votes,
    counts,
    aggregateCounts: plan === 'aggregate' ? counts.slice() : null,
    initialCounts: counts.slice(),
    writes: [],
    version: 0,
  };
}

/**
 * One atomic committed vote replacement. Returns the resulting version and the
 * old/new candidates. Setting the same candidate is an idempotent no-op for
 * counters but still consumes one committed version.
 */
export function applyVoteChange(
  state: VoteState,
  participant: number,
  candidate: number,
  commitMs: number,
): VoteCommitOutcome {
  if (!Number.isInteger(participant) || participant < 0 || participant >= state.participants) {
    throw new RangeError('participant outside the fixed population');
  }
  if (!Number.isInteger(candidate) || candidate < 0 || candidate >= state.candidates) {
    throw new RangeError('candidate outside the fixed candidate set');
  }
  const previous = state.votes[participant];
  if (previous === undefined || previous >= state.candidates) {
    throw new Error('stored vote is outside the candidate range');
  }
  const changed = previous !== candidate;

  if (changed) {
    const oldCount = state.counts[previous] ?? 0;
    if (oldCount <= 0) {
      throw new Error('cannot decrement an empty candidate count');
    }
    state.counts[previous] = oldCount - 1;
    state.counts[candidate] = (state.counts[candidate] ?? 0) + 1;
    if (state.aggregateCounts !== null) {
      state.aggregateCounts[previous] = oldCount - 1;
      state.aggregateCounts[candidate] =
        (state.aggregateCounts[candidate] ?? 0) + 1;
    }
  }

  state.votes[participant] = candidate;
  state.version += 1;
  state.writes.push({
    version: state.version,
    participant,
    previous,
    next: candidate,
    commitMs,
  });

  return {
    version: state.version,
    previous,
    next: candidate,
    changed,
  };
}

/** Consistent copy of the committed counts at the current version. */
export function snapshotCounts(state: VoteState): Uint32Array {
  return state.counts.slice();
}

/** Stable top-N: more votes first, then ascending candidate id. */
export function leaderboard(
  counts: Uint32Array,
  topN: number,
): LeaderboardEntry[] {
  const entries: LeaderboardEntry[] = [];
  for (let candidate = 0; candidate < counts.length; candidate += 1) {
    entries.push({ candidate, votes: counts[candidate] ?? 0 });
  }
  entries.sort((a, b) =>
    b.votes !== a.votes ? b.votes - a.votes : a.candidate - b.candidate,
  );
  return entries.slice(0, Math.max(0, topN));
}

/** Independent recomputation from raw participant rows. */
export function recomputeHistogram(state: VoteState): Uint32Array {
  return histogramFromVotes(state.votes, state.candidates);
}

export function countsEqual(
  left: Uint32Array,
  right: Uint32Array,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Rebuild the committed histogram at one version from initial votes and the
 * recorded commits. Used only by correctness checks; it grants no runtime
 * benefit to the simulated system.
 */
export function reconstructCountsAtVersion(
  state: VoteState,
  version: number,
): Uint32Array {
  if (!Number.isInteger(version) || version < 0 || version > state.version) {
    throw new RangeError('version outside committed history');
  }
  const counts = state.initialCounts.slice();
  for (let index = 0; index < version; index += 1) {
    const commit = state.writes[index];
    if (commit === undefined) {
      throw new Error('missing commit history entry');
    }
    if (commit.previous !== commit.next) {
      counts[commit.previous] = (counts[commit.previous] ?? 0) - 1;
      counts[commit.next] = (counts[commit.next] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Latest committed version whose commit time is at or before `timeMs`.
 * Commit times are non-decreasing, so this is a binary search.
 */
export function latestCommitAtOrBefore(
  state: VoteState,
  timeMs: number,
): { readonly version: number; readonly timeMs: number } {
  let low = 0;
  let high = state.writes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const commit = state.writes[middle];
    if (commit !== undefined && commit.commitMs <= timeMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const last = low > 0 ? state.writes[low - 1] : undefined;
  return { version: low, timeMs: last?.commitMs ?? 0 };
}

export interface SnapshotFreshness {
  /** Authoritative gate: the snapshot lacks a commit older than the limit. */
  readonly stale: boolean;
  /**
   * Data age of the oldest committed update missing from the snapshot:
   * `now - writes[snapshotVersion].commitMs`, or 0 when no later commit exists.
   * This is not cache age and does not invent staleness when nothing changed.
   */
  readonly lagMs: number;
  readonly requiredVersion: number;
  readonly requiredTimeMs: number;
  readonly firstMissingCommitMs: number | null;
}

/**
 * Evaluate read freshness against one consistent committed version.
 *
 * The authority is the version comparison, never a TTL or a timestamp-only
 * heuristic. Two commits with the same timestamp still produce distinct
 * versions, so a snapshot that misses the second one is stale even when
 * `requiredTimeMs - snapshotCommitMs` is zero.
 */
export function freshnessForSnapshot(
  state: VoteState,
  snapshotVersion: number,
  nowMs: number,
  freshnessLimitMs: number,
): SnapshotFreshness {
  const required = latestCommitAtOrBefore(state, nowMs - freshnessLimitMs);
  const firstMissing = state.writes[snapshotVersion];
  const stale = snapshotVersion < required.version;
  const lagMs =
    firstMissing === undefined ? 0 : Math.max(0, nowMs - firstMissing.commitMs);
  return {
    stale,
    lagMs,
    requiredVersion: required.version,
    requiredTimeMs: required.timeMs,
    firstMissingCommitMs: firstMissing?.commitMs ?? null,
  };
}

export function totalVotes(counts: Uint32Array): number {
  let total = 0;
  for (const value of counts) {
    total += value;
  }
  return total;
}
