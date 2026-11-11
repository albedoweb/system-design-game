import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateScoreboard,
  parseScoreboardGraph,
  validateScoreboardGraph,
  type ScoreboardGraph,
} from '../index';

const directory = resolve(process.cwd(), 'fixtures/scoreboard');

function load(name: string): ScoreboardGraph {
  return JSON.parse(
    readFileSync(resolve(directory, `${name}.json`), 'utf8'),
  ) as ScoreboardGraph;
}

function hasErrors(name: string): boolean {
  const parsed = parseScoreboardGraph(load(name));
  if (!parsed.ok) {
    return true;
  }
  return validateScoreboardGraph(parsed.value).some(
    (issue) => issue.severity === 'error',
  );
}

describe('Live Scoreboard canonical fixtures', () => {
  it('keeps passing and failing fixtures valid, and invalid fixtures rejected', () => {
    for (const name of [
      'family-fullscan',
      'family-cache',
      'family-aggregate',
      'fail-small-scan',
      'fail-stale-cache',
    ]) {
      const parsed = parseScoreboardGraph(load(name));
      expect(parsed.ok, name).toBe(true);
      expect(hasErrors(name), name).toBe(false);
    }
    for (const name of ['invalid-missing-sql', 'invalid-ambiguous']) {
      expect(hasErrors(name), name).toBe(true);
    }
  });

  it('demonstrates the intended outcomes from checked-in fixtures', () => {
    const aggregate = evaluateScoreboard(load('family-aggregate'), {
      seed: 101,
    });
    expect(aggregate.passed).toBe(true);
    expect(aggregate.cost?.actualUsd ?? Infinity).toBeLessThan(
      evaluateScoreboard(load('family-cache'), { seed: 101 }).cost
        ?.actualUsd ?? 0,
    );

    const cache = evaluateScoreboard(load('family-cache'), { seed: 101 });
    expect(cache.passed).toBe(true);
    expect(cache.freshness?.staleReads).toBe(0);
    expect(cache.freshness?.maxLagMs ?? 0).toBeGreaterThan(0);

    const stale = evaluateScoreboard(load('fail-stale-cache'), {
      seed: 101,
    });
    expect(stale.passed).toBe(false);
    expect(stale.freshness?.staleReads ?? 0).toBeGreaterThan(0);

    const small = evaluateScoreboard(load('fail-small-scan'), { seed: 101 });
    expect(small.passed).toBe(false);
    expect(small.operations?.read.availability ?? 1).toBeLessThan(0.995);

    const invalid = evaluateScoreboard(load('invalid-missing-sql'), {
      seed: 101,
    });
    expect(invalid.status).toBe('invalid');
  });
});
