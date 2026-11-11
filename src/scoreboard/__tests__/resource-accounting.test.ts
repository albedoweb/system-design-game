import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCOREBOARD_LEVEL,
  ScoreboardSimulation,
  evaluateScoreboard,
  type ScoreboardGraph,
  type ScoreboardLevel,
} from '../index';

const directory = resolve(process.cwd(), 'fixtures/scoreboard');

function load(name: string): ScoreboardGraph {
  return JSON.parse(
    readFileSync(resolve(directory, `${name}.json`), 'utf8'),
  ) as ScoreboardGraph;
}

function cacheMemory(simulation: ScoreboardSimulation): {
  has: (id: string) => boolean;
  usedBytes: number;
} | null {
  const node = (
    simulation as unknown as {
      cacheNode: {
        memory: { has: (id: string) => boolean; usedBytes: number } | null;
      } | null;
    }
  ).cacheNode;
  return node?.memory ?? null;
}

describe('Live Scoreboard resource accounting', () => {
  it('never reports more waiters than the real node queue can hold', () => {
    const small = evaluateScoreboard(load('fail-small-scan'), { seed: 101 });
    const limits = new Map([
      ['app', SCOREBOARD_LEVEL.limits.maxAppWaitingTasks],
      ['sql', SCOREBOARD_LEVEL.limits.maxSqlWaitingTasks],
      ['cache', SCOREBOARD_LEVEL.limits.maxCacheWaitingTasks],
    ]);
    for (const node of small.nodes) {
      const limit = limits.get(node.kind);
      if (limit !== undefined) {
        expect(node.queue.waitingPeak, node.kind).toBeLessThanOrEqual(limit);
      }
    }
    const sql = small.nodes.find((node) => node.kind === 'sql');
    expect(sql?.queue.waitingPeak).toBe(
      SCOREBOARD_LEVEL.limits.maxSqlWaitingTasks,
    );

    // A cache-only small database has no queued SQL work: an immediately
    // admitted task is not reported as a waiter.
    const cache = evaluateScoreboard(load('family-cache'), { seed: 101 });
    expect(cache.nodes.find((node) => node.kind === 'sql')?.queue.waitingPeak).toBe(0);
    expect(
      cache.nodes.find((node) => node.kind === 'cache')?.queue.waitingPeak ?? 0,
    ).toBeGreaterThan(0);
  });

  it('holds the filled cache entry in RAM while resident', () => {
    const result = evaluateScoreboard(load('family-cache'), { seed: 101 });
    const cacheNode = result.nodes.find((node) => node.kind === 'cache');
    expect(cacheNode?.memory.peakUsedBytes ?? 0).toBeGreaterThanOrEqual(4_096);
    expect(cacheNode?.memory.residentBytesAverage ?? 0).toBeGreaterThan(3_500);
    const tenSeconds = result.series[10]?.nodes.find(
      (node) => node.nodeId === cacheNode?.nodeId,
    );
    expect(tenSeconds?.ramUsedBytes ?? 0).toBeGreaterThanOrEqual(4_096);
  });

  it('releases cache-entry residency on TTL expiry and at run end', () => {
    const level: ScoreboardLevel = JSON.parse(
      JSON.stringify(SCOREBOARD_LEVEL),
    ) as ScoreboardLevel;
    level.workload.readPhases = [
      { fromMs: 0, toMs: 100, readsPerSecond: 1_000 },
    ];
    level.workload.voteChangesPerSecond = 0;

    const simulation = new ScoreboardSimulation(
      load('family-cache'),
      { seed: 101 },
      level,
    );
    const result = simulation.runToCompletion();
    const cacheNode = result.nodes.find((node) => node.kind === 'cache');
    expect(cacheNode?.memory.peakUsedBytes ?? 0).toBeGreaterThanOrEqual(4_096);

    const atOneSecond = result.series[0]?.nodes.find(
      (node) => node.nodeId === cacheNode?.nodeId,
    );
    expect(atOneSecond?.ramUsedBytes ?? 0).toBeGreaterThanOrEqual(4_096);
    const afterExpiry = result.series[4]?.nodes.find(
      (node) => node.nodeId === cacheNode?.nodeId,
    );
    expect(afterExpiry?.ramUsedBytes ?? -1).toBe(0);

    // Ownership cleanup: the persistent ledger reservation is gone after the
    // session finalises, and no double release occurred.
    expect(cacheMemory(simulation)?.has('cache-entry')).toBe(false);
  });
});
