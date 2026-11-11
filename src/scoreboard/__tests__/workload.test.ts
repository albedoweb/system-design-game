import { describe, expect, it } from 'vitest';
import { SCOREBOARD_LEVEL } from '../level';
import {
  generateInitialVotes,
  generateScoreboardTrace,
} from '../workload';

describe('Live Scoreboard workload', () => {
  it('offers the same trace for one seed and different traces for another', () => {
    const first = generateScoreboardTrace(101, SCOREBOARD_LEVEL);
    const second = generateScoreboardTrace(101, SCOREBOARD_LEVEL);
    const other = generateScoreboardTrace(211, SCOREBOARD_LEVEL);

    expect(first.requests).toEqual(second.requests);
    expect(first.readCount).toBe(second.readCount);
    expect(first.writeCount).toBe(second.writeCount);
    expect(first.requests).not.toEqual(other.requests);
  });

  it('keeps read arrivals inside their phase and writes inside 90 s', () => {
    const trace = generateScoreboardTrace(101, SCOREBOARD_LEVEL);
    expect(trace.readCount).toBeGreaterThan(7_000);
    expect(trace.readCount).toBeLessThan(10_000);
    expect(trace.writeCount).toBeGreaterThan(8_000);
    expect(trace.writeCount).toBeLessThan(10_000);

    for (const request of trace.requests) {
      expect(request.atMs).toBeGreaterThanOrEqual(0);
      expect(request.atMs).toBeLessThan(90_000);
    }

    const peakReads = trace.requests.filter(
      (request) =>
        request.operation === 'read' &&
        request.atMs >= 20_000 &&
        request.atMs < 60_000,
    );
    expect(peakReads.length).toBeGreaterThan(7_000);
  });

  it('draws participants and candidates from independent bounded streams', () => {
    const trace = generateScoreboardTrace(307, SCOREBOARD_LEVEL);
    const writes = trace.requests.filter(
      (request) => request.operation === 'write',
    );
    for (const write of writes) {
      if (write.operation !== 'write') {
        continue;
      }
      expect(write.participant).toBeGreaterThanOrEqual(0);
      expect(write.participant).toBeLessThan(500_000);
      expect(write.candidate).toBeGreaterThanOrEqual(0);
      expect(write.candidate).toBeLessThan(100);
    }
    const distinctParticipants = new Set(
      writes.map((write) =>
        write.operation === 'write' ? write.participant : -1,
      ),
    );
    expect(distinctParticipants.size).toBeGreaterThan(7_000);
  });

  it('generates deterministic initial votes with the fixed totals', () => {
    const first = generateInitialVotes(101, SCOREBOARD_LEVEL);
    const second = generateInitialVotes(101, SCOREBOARD_LEVEL);
    const other = generateInitialVotes(211, SCOREBOARD_LEVEL);
    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
    expect(first.length).toBe(500_000);

    const counts = new Uint32Array(SCOREBOARD_LEVEL.dataset.candidates);
    for (const vote of first) {
      counts[vote] = (counts[vote] ?? 0) + 1;
    }
    expect(counts.reduce((sum, value) => sum + value, 0)).toBe(500_000);
    expect(counts.every((value) => value > 0)).toBe(true);
  });
});
