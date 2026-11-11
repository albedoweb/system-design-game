import { describe, expect, it } from 'vitest';

import { AUDIENCE_CATALOG } from '../catalog';
import { AUDIENCE_LEVEL } from '../level';
import type { AudienceCatalog, AudienceLevel } from '../contracts';
import type { AudienceModel } from '../core/model';
import {
  ActivityOverlay,
  LastSeenIndex,
  recomputeWindowRanking,
  type AudienceCommitLog,
  type AudienceRanking,
} from '../core/activity';
import {
  AudiencePrehistoryBuilder,
  Int32KeyTable,
  type AudienceBaseHistory,
} from '../core/workload';

/**
 * Memory-shape regressions for the exact raw oracle and prehistory builder.
 *
 * These witnesses deliberately recompute the expected ranking with a plain
 * `Set`, independent of the scratch table under test. They protect exact
 * distinct-pair/open-left-window semantics while the implementation reuses a
 * cleared table and compacts its over-provisioned builder allocations.
 */

const STREAMS = 4;
const WINDOW = 1_000;

function baseHistory(
  pairs: readonly { key: number; lastMs: number }[],
  horizon: number,
): AudienceBaseHistory {
  const table = new Int32KeyTable(Math.max(16, pairs.length * 8));
  for (const pair of pairs) {
    table.add(pair.key);
  }
  const sorted = [...pairs].sort((left, right) => left.lastMs - right.lastMs);
  const expiry = sorted
    .map((pair) => ({
      end: pair.lastMs + WINDOW,
      key: pair.key,
      stream: pair.key % STREAMS,
    }))
    .filter((item) => item.end <= horizon)
    .sort((left, right) => left.end - right.end);
  const counts = new Int32Array(STREAMS);
  for (const pair of pairs) {
    counts[pair.key % STREAMS] = (counts[pair.key % STREAMS] ?? 0) + 1;
  }
  return {
    counts,
    totalPairs: pairs.length,
    pairs: table,
    pairKeys: Int32Array.from(sorted.map((pair) => pair.key)),
    pairLastMs: Float64Array.from(sorted.map((pair) => pair.lastMs)),
    eventTimesMs: Float64Array.from(sorted.map((pair) => pair.lastMs)),
    expiryEndsMs: Float64Array.from(expiry.map((item) => item.end)),
    expiryKeys: Int32Array.from(expiry.map((item) => item.key)),
    expiryStreams: Uint8Array.from(expiry.map((item) => item.stream)),
    prehistoryEvents: pairs.length,
    prehistoryDistinctPairs: pairs.length,
    provisionDiskMs: 0,
    provisionBytes: 0,
  };
}

function commitLog(
  rows: readonly { timeMs: number; key: number }[],
  capacity = rows.length + 8,
): AudienceCommitLog {
  const log: AudienceCommitLog = {
    count: rows.length,
    timesMs: new Float64Array(capacity),
    pairs: new Int32Array(capacity),
    streams: new Uint8Array(capacity),
  };
  rows.forEach((row, index) => {
    log.timesMs[index] = row.timeMs;
    log.pairs[index] = row.key;
    log.streams[index] = row.key % STREAMS;
  });
  return log;
}

/**
 * Plain reference: filter retained pairs by last activity, filter committed
 * rows by the same open-left window and the snapshot cursor, deduplicate with a
 * `Set`, then rank streams exactly like the public contract.
 */
function referenceRanking(
  base: AudienceBaseHistory,
  log: AudienceCommitLog,
  asOfMs: number,
  throughCommitSequence: number,
): AudienceRanking {
  const left = asOfMs - WINDOW;
  const active = new Set<number>();
  for (let index = 0; index < base.pairLastMs.length; index += 1) {
    if ((base.pairLastMs[index] ?? 0) > left) {
      active.add(base.pairKeys[index] ?? 0);
    }
  }
  const limit = Math.min(log.count, throughCommitSequence);
  for (let index = 0; index < limit; index += 1) {
    const time = log.timesMs[index] ?? 0;
    if (time > asOfMs) {
      break;
    }
    if (time > left) {
      active.add(log.pairs[index] ?? 0);
    }
  }
  const counts = new Array<number>(STREAMS).fill(0);
  for (const key of active) {
    counts[key % STREAMS] = (counts[key % STREAMS] ?? 0) + 1;
  }
  const order = Array.from({ length: STREAMS }, (_, stream) => stream).sort(
    (leftStream, rightStream) => {
      const byCount = (counts[rightStream] ?? 0) - (counts[leftStream] ?? 0);
      return byCount === 0 ? leftStream - rightStream : byCount;
    },
  );
  return {
    snapshot: { asOfMs, throughCommitSequence },
    top: order.slice(0, STREAMS).map((stream) => ({
      stream,
      viewers: counts[stream] ?? 0,
    })),
    activePairs: active.size,
  };
}

function expectSameRanking(actual: AudienceRanking, expected: AudienceRanking): void {
  expect(actual.snapshot).toEqual(expected.snapshot);
  expect(actual.activePairs).toBe(expected.activePairs);
  expect(actual.top).toEqual(expected.top);
}

/** Small private prehistory model: 400 rows over 40 users and 4 streams. */
function tinyBuilderModel(): AudienceModel {
  const level = JSON.parse(JSON.stringify(AUDIENCE_LEVEL)) as AudienceLevel;
  const catalog = JSON.parse(JSON.stringify(AUDIENCE_CATALOG)) as AudienceCatalog;
  level.dataset.users = 40;
  level.dataset.streams = STREAMS;
  level.dataset.prehistoryEvents = 400;
  level.workload.measuredMs = 47_000;
  level.workload.drainMs = 1_000;
  return { level, catalog } as AudienceModel;
}

describe('reusable exact raw-audit scratch', () => {
  const pairs = [
    { key: 0, lastMs: -900 },
    { key: 1, lastMs: -800 },
    { key: 4, lastMs: -700 },
    { key: 5, lastMs: -650 },
    { key: 8, lastMs: -600 },
    { key: 9, lastMs: -550 },
    { key: 12, lastMs: -400 },
    { key: 13, lastMs: -300 },
    { key: 16, lastMs: -200 },
    { key: 17, lastMs: -100 },
    { key: 20, lastMs: -50 },
    { key: 21, lastMs: -10 },
  ];
  const rows = [
    { timeMs: -450, key: 0 }, // renewal of a retained pair
    { timeMs: -300, key: 24 }, // new pair
    { timeMs: -200, key: 4 }, // renewal outside its old expiry
    { timeMs: -100, key: 25 },
    { timeMs: 0, key: 0 }, // same pair again in the same snapshot
    { timeMs: 100, key: 28 },
    { timeMs: 250, key: 24 },
    { timeMs: 400, key: 29 },
    { timeMs: 700, key: 32 },
    { timeMs: 900, key: 33 },
    { timeMs: 1_100, key: 36 },
  ];
  const base = baseHistory(pairs, 1_500);
  const log = commitLog(rows);

  it('keeps exact results across repeated, growing and re-entered snapshots', () => {
    const snapshots: { asOfMs: number; through: number }[] = [];
    for (let asOfMs = 0; asOfMs <= 1_200; asOfMs += 50) {
      for (let through = 0; through <= log.count; through += 3) {
        snapshots.push({ asOfMs, through });
      }
    }
    let guard = 0;
    for (const snapshot of snapshots) {
      guard += 1;
      const actual = recomputeWindowRanking(
        base,
        log,
        {
          asOfMs: snapshot.asOfMs,
          throughCommitSequence: snapshot.through,
        },
        WINDOW,
        STREAMS,
        STREAMS,
      );
      expectSameRanking(
        actual,
        referenceRanking(base, log, snapshot.asOfMs, snapshot.through),
      );
    }
    expect(guard).toBe(snapshots.length);

    // Re-entering an early snapshot after many larger tables must not retain
    // slots or counts from the later call.
    const first = recomputeWindowRanking(
      base,
      log,
      { asOfMs: 0, throughCommitSequence: 0 },
      WINDOW,
      STREAMS,
      STREAMS,
    );
    expectSameRanking(first, referenceRanking(base, log, 0, 0));
    const again = recomputeWindowRanking(
      base,
      log,
      { asOfMs: 0, throughCommitSequence: 0 },
      WINDOW,
      STREAMS,
      STREAMS,
    );
    expectSameRanking(again, first);
  });

  it('does not mix scratch state between different base histories', () => {
    const otherPairs = [
      { key: 2, lastMs: -500 },
      { key: 3, lastMs: -250 },
      { key: 6, lastMs: -100 },
      { key: 7, lastMs: -50 },
    ];
    const otherBase = baseHistory(otherPairs, 1_500);
    const otherLog = commitLog([{ timeMs: -120, key: 10 }]);

    for (let asOfMs = 0; asOfMs <= 900; asOfMs += 100) {
      const first = recomputeWindowRanking(
        base,
        log,
        { asOfMs, throughCommitSequence: log.count },
        WINDOW,
        STREAMS,
        STREAMS,
      );
      const other = recomputeWindowRanking(
        otherBase,
        otherLog,
        { asOfMs, throughCommitSequence: otherLog.count },
        WINDOW,
        STREAMS,
        STREAMS,
      );
      expectSameRanking(
        first,
        referenceRanking(base, log, asOfMs, log.count),
      );
      expectSameRanking(
        other,
        referenceRanking(otherBase, otherLog, asOfMs, otherLog.count),
      );
    }
  });
});

describe('compact served and audit indexes', () => {
  it('matches a plain active-set reference across expiries and renewals', () => {
    const users = 40;
    const windowMs = WINDOW;
    let seed = 0x1a2b3c4d;
    const nextRandom = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    // Deterministic unique prehistory pairs spanning the whole activity window.
    const used = new Set<number>();
    const pairs: { key: number; lastMs: number }[] = [];
    while (pairs.length < 120) {
      const key =
        Math.floor(nextRandom() * users) * STREAMS +
        Math.floor(nextRandom() * STREAMS);
      if (used.has(key)) {
        continue;
      }
      used.add(key);
      pairs.push({
        key,
        lastMs: -windowMs + 1 + Math.floor(nextRandom() * (windowMs - 1)),
      });
    }

    const base = baseHistory(pairs, 2_000);
    const overlay = new ActivityOverlay(base, windowMs, STREAMS);
    const audit = new LastSeenIndex(base, windowMs, STREAMS);
    const referenceSeen = new Map<number, number>();
    const referenceActive = new Set<number>();
    for (const pair of pairs) {
      referenceSeen.set(pair.key, pair.lastMs);
      referenceActive.add(pair.key);
    }

    const rankingOf = (active: Set<number>): AudienceRanking => {
      const counts = new Array<number>(STREAMS).fill(0);
      for (const key of active) {
        counts[key % STREAMS] = (counts[key % STREAMS] ?? 0) + 1;
      }
      const order = Array.from({ length: STREAMS }, (_, stream) => stream).sort(
        (left, right) =>
          (counts[right] ?? 0) - (counts[left] ?? 0) || left - right,
      );
      return {
        snapshot: { asOfMs: 0, throughCommitSequence: 0 },
        top: order.map((stream) => ({
          stream,
          viewers: counts[stream] ?? 0,
        })),
        activePairs: active.size,
      };
    };

    let sequence = 0;
    for (let asOfMs = 0; asOfMs <= 900; asOfMs += 5) {
      const commits = Math.floor(nextRandom() * 3);
      for (let count = 0; count < commits; count += 1) {
        // A mix of retained pairs (renewals) and pairs first seen in measured
        // traffic. Keys above the prehistory population are genuinely new.
        const key =
          nextRandom() < 0.7
            ? pairs[Math.floor(nextRandom() * pairs.length)]!.key
            : users * STREAMS + Math.floor(nextRandom() * 40);
        overlay.applyCommit(key, key % STREAMS, asOfMs);
        audit.applyCommit(key, asOfMs);
        referenceSeen.set(key, asOfMs);
        referenceActive.add(key);
        sequence += 1;
      }

      // Open left edge: the pair leaves exactly when last + window <= asOf.
      for (const [key, lastMs] of referenceSeen) {
        if (lastMs + windowMs <= asOfMs) {
          referenceSeen.delete(key);
          referenceActive.delete(key);
        }
      }

      const expected = rankingOf(referenceActive);
      const served = overlay.ranking(asOfMs, sequence, STREAMS);
      const audited = audit.ranking(asOfMs, sequence, STREAMS);
      expect(served.activePairs).toBe(expected.activePairs);
      expect(served.top).toEqual(expected.top);
      expect(audited.activePairs).toBe(expected.activePairs);
      expect(audited.top).toEqual(expected.top);
      expect(overlay.expectedExpiriesThrough(asOfMs)).toBe(
        base.expiryEndsMs.reduce(
          (total, end) => total + (end <= asOfMs ? 1 : 0),
          0,
        ),
      );
    }
  });
});

describe('compacted prehistory membership table', () => {
  it('preserves exact membership while shrinking the pre-count allocation', () => {
    const original = new Int32KeyTable(4_096);
    const keys = [0, 1, 2, 17, 4_095, 12_345, 7, 99, 1_000_000];
    for (const key of keys) {
      original.add(key);
    }
    const before = original.capacity;
    const compacted = original.compact();
    expect(compacted.count).toBe(keys.length);
    expect(compacted.capacity).toBeLessThan(before);
    expect(compacted.capacity).toBeGreaterThanOrEqual(keys.length);
    for (const key of keys) {
      expect(compacted.has(key)).toBe(true);
      // Adding an existing key reports presence and creates no new key.
      expect(compacted.add(key)).toBe(true);
    }
    expect(compacted.count).toBe(keys.length);
    for (const key of [3, 18, 4_096, 12_346, 2_000_000]) {
      expect(compacted.has(key)).toBe(false);
      expect(compacted.add(key)).toBe(false);
    }
    expect(compacted.count).toBe(keys.length + 5);
  });

  it('replaces the builder over-allocation once the distinct count is known', () => {
    const model = tinyBuilderModel();
    const builder = new AudiencePrehistoryBuilder(model, 5);
    let guard = 0;
    while (!builder.done && guard < 1_000) {
      builder.step(7);
      guard += 1;
    }
    expect(builder.done).toBe(true);
    const base = builder.baseHistory;
    expect(base.pairs.count).toBe(base.totalPairs);
    // Pre-count capacity for 400 rows is 2^10; the compacted table keeps every
    // pair while fitting far fewer slots.
    expect(base.pairs.capacity).toBeLessThan(1_024);
    expect(base.pairs.capacity).toBeGreaterThanOrEqual(base.totalPairs);
    for (const key of base.pairKeys) {
      expect(base.pairs.has(key)).toBe(true);
    }
    expect(base.pairs.has(2_000_000)).toBe(false);
    expect(base.totalPairs).toBe(base.prehistoryDistinctPairs);
  });

  it('keeps the exact base across tiny budgets and never exposes a partial base', () => {
    const wholeBuilder = new AudiencePrehistoryBuilder(tinyBuilderModel(), 5);
    let guard = 0;
    while (!wholeBuilder.done && guard < 100_000) {
      wholeBuilder.step(20_000);
      guard += 1;
    }
    expect(wholeBuilder.done).toBe(true);
    const whole = wholeBuilder.baseHistory;

    const slicedBuilder = new AudiencePrehistoryBuilder(tinyBuilderModel(), 5);
    let lastProgress = slicedBuilder.progress;
    let steps = 0;
    while (!slicedBuilder.done && steps < 100_000) {
      // Progress never moves backwards across event, scan, compact and assemble
      // stages, and a non-done builder cannot expose a partial base.
      expect(slicedBuilder.progress).toBeGreaterThanOrEqual(lastProgress);
      lastProgress = slicedBuilder.progress;
      expect(() => slicedBuilder.baseHistory).toThrow();
      slicedBuilder.step(1);
      steps += 1;
    }
    expect(slicedBuilder.done).toBe(true);
    expect(slicedBuilder.progress).toBe(1);
    const sliced = slicedBuilder.baseHistory;

    expect(sliced.totalPairs).toBe(whole.totalPairs);
    expect(Array.from(sliced.counts)).toEqual(Array.from(whole.counts));
    expect(Array.from(sliced.pairKeys)).toEqual(Array.from(whole.pairKeys));
    expect(Array.from(sliced.pairLastMs)).toEqual(Array.from(whole.pairLastMs));
    expect(Array.from(sliced.eventTimesMs)).toEqual(
      Array.from(whole.eventTimesMs),
    );
    expect(Array.from(sliced.expiryEndsMs)).toEqual(
      Array.from(whole.expiryEndsMs),
    );
    expect(Array.from(sliced.expiryKeys)).toEqual(Array.from(whole.expiryKeys));
    expect(Array.from(sliced.expiryStreams)).toEqual(
      Array.from(whole.expiryStreams),
    );
    expect(sliced.prehistoryEvents).toBe(whole.prehistoryEvents);
    expect(sliced.prehistoryDistinctPairs).toBe(whole.prehistoryDistinctPairs);
    expect(sliced.provisionDiskMs).toBe(whole.provisionDiskMs);
    expect(sliced.provisionBytes).toBe(whole.provisionBytes);
    expect(sliced.pairs.capacity).toBe(whole.pairs.capacity);
    expect(sliced.pairs.count).toBe(whole.pairs.count);
    for (const key of whole.pairKeys) {
      expect(sliced.pairs.has(key)).toBe(true);
    }
    expect(steps).toBeGreaterThan(0);
  });
});
