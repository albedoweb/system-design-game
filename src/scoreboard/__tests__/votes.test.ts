import { describe, expect, it } from 'vitest';
import { SCOREBOARD_LEVEL } from '../level';
import {
  applyVoteChange,
  countsEqual,
  createVoteState,
  freshnessForSnapshot,
  histogramFromVotes,
  latestCommitAtOrBefore,
  leaderboard,
  recomputeHistogram,
  reconstructCountsAtVersion,
  snapshotCounts,
  totalVotes,
} from '../votes';

describe('Live Scoreboard vote state', () => {
  it('builds 500,000 current votes and 100 exact candidate counts', () => {
    const state = createVoteState(101, SCOREBOARD_LEVEL, 'scan');
    expect(state.votes.length).toBe(500_000);
    expect(state.counts.length).toBe(100);
    expect(totalVotes(state.counts)).toBe(500_000);
    expect(recomputeHistogram(state).every((value) => value > 0)).toBe(true);
    expect(countsEqual(state.counts, state.initialCounts)).toBe(true);
  });

  it('replaces one vote atomically and keeps raw counts exact', () => {
    const state = createVoteState(101, SCOREBOARD_LEVEL, 'aggregate');
    const participant = 42;
    const previous = state.votes[participant] ?? 0;
    const next = (previous + 7) % 100;
    const beforeOld = state.counts[previous] ?? 0;
    const beforeNew = state.counts[next] ?? 0;

    const outcome = applyVoteChange(state, participant, next, 1_250);
    expect(outcome).toMatchObject({
      version: 1,
      previous,
      next,
      changed: true,
    });
    expect(state.votes[participant]).toBe(next);
    expect(state.counts[previous]).toBe(beforeOld - 1);
    expect(state.counts[next]).toBe(beforeNew + 1);
    expect(state.aggregateCounts?.[previous]).toBe(beforeOld - 1);
    expect(state.aggregateCounts?.[next]).toBe(beforeNew + 1);
    expect(totalVotes(state.counts)).toBe(500_000);
    expect(countsEqual(recomputeHistogram(state), state.counts)).toBe(true);
    expect(countsEqual(state.aggregateCounts ?? new Uint32Array(100), state.counts)).toBe(true);
  });

  it('serializes repeated changes for the same participant', () => {
    const state = createVoteState(101, SCOREBOARD_LEVEL, 'scan');
    const participant = 7;
    const first = (state.votes[participant] ?? 0) + 1;
    const second = (first + 1) % 100;

    applyVoteChange(state, participant, first, 100);
    applyVoteChange(state, participant, second, 200);

    expect(state.votes[participant]).toBe(second);
    expect(totalVotes(state.counts)).toBe(500_000);
    expect(countsEqual(recomputeHistogram(state), state.counts)).toBe(true);
    expect(state.writes.length).toBe(2);
    expect(state.writes[0]?.next).toBe(first);
    expect(state.writes[1]?.previous).toBe(first);
  });

  it('treats selecting the current candidate as one committed no-op', () => {
    const state = createVoteState(101, SCOREBOARD_LEVEL, 'scan');
    const participant = 11;
    const current = state.votes[participant] ?? 0;
    const before = snapshotCounts(state);
    const outcome = applyVoteChange(state, participant, current, 10);
    expect(outcome.changed).toBe(false);
    expect(countsEqual(before, state.counts)).toBe(true);
    expect(state.version).toBe(1);
  });

  it('reconstructs any committed version for a correctness check', () => {
    const state = createVoteState(101, SCOREBOARD_LEVEL, 'scan');
    applyVoteChange(state, 1, (state.votes[1] ?? 0) + 1, 100);
    applyVoteChange(state, 2, (state.votes[2] ?? 0) + 1, 200);
    applyVoteChange(state, 1, (state.votes[1] ?? 0) + 1, 300);

    const atOne = reconstructCountsAtVersion(state, 1);
    const atThree = reconstructCountsAtVersion(state, 3);
    expect(countsEqual(atOne, state.initialCounts) === false).toBe(true);
    expect(countsEqual(atThree, state.counts)).toBe(true);
    expect(countsEqual(reconstructCountsAtVersion(state, 0), state.initialCounts)).toBe(true);
  });

  it('selects the latest committed version at or before a response time', () => {
    const state = createVoteState(101, SCOREBOARD_LEVEL, 'scan');
    applyVoteChange(state, 1, (state.votes[1] ?? 0) + 1, 1_000);
    applyVoteChange(state, 2, (state.votes[2] ?? 0) + 1, 2_000);
    applyVoteChange(state, 3, (state.votes[3] ?? 0) + 1, 3_000);

    expect(latestCommitAtOrBefore(state, 999)).toEqual({ version: 0, timeMs: 0 });
    expect(latestCommitAtOrBefore(state, 2_000)).toEqual({
      version: 2,
      timeMs: 2_000,
    });
    expect(latestCommitAtOrBefore(state, 9_999)).toEqual({
      version: 3,
      timeMs: 3_000,
    });
  });

  it('sorts the leaderboard by votes and then ascending candidate id', () => {
    const counts = new Uint32Array([5, 9, 9, 9, 1]);
    expect(leaderboard(counts, 3)).toEqual([
      { candidate: 1, votes: 9 },
      { candidate: 2, votes: 9 },
      { candidate: 3, votes: 9 },
    ]);

    const state = createVoteState(101, SCOREBOARD_LEVEL, 'scan');
    const top = leaderboard(state.counts, 20);
    expect(top.length).toBe(20);
    for (let index = 1; index < top.length; index += 1) {
      const previous = top[index - 1];
      const current = top[index];
      if (previous === undefined || current === undefined) {
        continue;
      }
      expect(previous.votes).toBeGreaterThanOrEqual(current.votes);
      if (previous.votes === current.votes) {
        expect(previous.candidate).toBeLessThan(current.candidate);
      }
    }
  });

  it('recomputes the same histogram independently of the stored counts', () => {
    const state = createVoteState(211, SCOREBOARD_LEVEL, 'scan');
    for (let index = 0; index < 100; index += 1) {
      const participant = index * 97;
      applyVoteChange(
        state,
        participant,
        ((state.votes[participant] ?? 0) + 3) % 100,
        index,
      );
    }
    expect(countsEqual(histogramFromVotes(state.votes, 100), state.counts)).toBe(
      true,
    );
  });
});

describe('Live Scoreboard freshness semantics', () => {
  function committedState(commits: { participant: number; atMs: number }[]) {
    const state = createVoteState(101, SCOREBOARD_LEVEL, 'scan');
    for (const commit of commits) {
      applyVoteChange(
        state,
        commit.participant,
        ((state.votes[commit.participant] ?? 0) + 1) % 100,
        commit.atMs,
      );
    }
    return state;
  }

  it('reports zero lag when no newer commit is missing', () => {
    const state = committedState([
      { participant: 1, atMs: 1_000 },
      { participant: 2, atMs: 2_000 },
    ]);
    const freshness = freshnessForSnapshot(state, 2, 10_000, 5_000);
    expect(freshness.stale).toBe(false);
    expect(freshness.lagMs).toBe(0);
    expect(freshness.firstMissingCommitMs).toBeNull();
  });

  it('reports a TTL-like data lag below the freshness limit without stale', () => {
    const state = committedState([
      { participant: 1, atMs: 1_000 },
      { participant: 2, atMs: 1_100 },
      { participant: 3, atMs: 3_000 },
      { participant: 4, atMs: 3_100 },
    ]);
    // Snapshot version 2 was captured before the 3 s commits; it is now 5.1 s.
    const freshness = freshnessForSnapshot(state, 2, 5_100, 5_000);
    expect(freshness.stale).toBe(false);
    expect(freshness.requiredVersion).toBe(0);
    expect(freshness.firstMissingCommitMs).toBe(3_000);
    expect(freshness.lagMs).toBe(2_100);
    expect(freshness.lagMs).toBeGreaterThan(0);
    expect(freshness.lagMs).toBeLessThan(5_000);
  });

  it('counts a TTL-15 snapshot as stale with large data lag', () => {
    const state = committedState([
      { participant: 1, atMs: 1_000 },
      { participant: 2, atMs: 2_000 },
      { participant: 3, atMs: 16_000 },
    ]);
    const freshness = freshnessForSnapshot(state, 1, 17_000, 5_000);
    expect(freshness.requiredVersion).toBe(2);
    expect(freshness.stale).toBe(true);
    expect(freshness.lagMs).toBe(15_000);
  });

  it('uses the version, not timestamp age, for same-timestamp commits', () => {
    const state = committedState([
      { participant: 1, atMs: 1_000 },
      { participant: 2, atMs: 1_000 },
    ]);
    // Required version is 2 at the same commit timestamp as the snapshot's
    // version 1. A timestamp-difference test would report zero, but the
    // snapshot genuinely misses a committed update.
    const freshness = freshnessForSnapshot(state, 1, 6_000, 5_000);
    expect(freshness.requiredVersion).toBe(2);
    expect(freshness.requiredTimeMs).toBe(1_000);
    expect(freshness.stale).toBe(true);
    expect(freshness.lagMs).toBe(5_000);
  });
});
