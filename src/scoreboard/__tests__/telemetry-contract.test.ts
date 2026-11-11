import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateScoreboard,
  parseScoreboardEvaluation,
  type ScoreboardGraph,
  type ScoreboardEvaluation,
} from '../index';

const directory = resolve(process.cwd(), 'fixtures/scoreboard');

function load(name: string): ScoreboardGraph {
  return JSON.parse(
    readFileSync(resolve(directory, `${name}.json`), 'utf8'),
  ) as ScoreboardGraph;
}

function expectBoundedCpu(result: ScoreboardEvaluation): void {
  for (const point of result.series) {
    for (const node of point.nodes) {
      if (node.cpuUtilization === null) {
        continue;
      }
      expect(node.cpuUtilization).toBeGreaterThanOrEqual(0);
      expect(node.cpuUtilization).toBeLessThanOrEqual(1);
    }
  }
  for (const node of result.nodes) {
    expect(node.cpu.utilizationAverage).toBeGreaterThanOrEqual(0);
    expect(node.cpu.utilizationAverage).toBeLessThanOrEqual(1);
    expect(node.cpu.utilizationPeak).toBeGreaterThanOrEqual(0);
    expect(node.cpu.utilizationPeak).toBeLessThanOrEqual(1);
  }
}

describe('Live Scoreboard CPU telemetry contract', () => {
  it('keeps failing-run CPU ratios parseable at seed 607 and nearby seeds', () => {
    // Before this fix, fail-small-scan seed 607 (and 307) produced a full-core
    // SQL sample of 1.0000000000000018, which parseScoreboardEvaluation
    // rejected as number_out_of_range. Failing runs must also be valid public
    // results; the failure belongs to gates, not to malformed telemetry.
    for (const seed of [101, 307, 607, 701]) {
      const result = evaluateScoreboard(load('fail-small-scan'), { seed });
      expect(result.status, `seed ${seed}`).toBe('complete');
      expectBoundedCpu(result);
      expect(parseScoreboardEvaluation(result).ok, `seed ${seed}`).toBe(true);
    }
  });

  it('still rejects a material CPU overrun instead of hiding it', () => {
    const result = evaluateScoreboard(load('family-cache'), { seed: 101 });
    expect(parseScoreboardEvaluation(result).ok).toBe(true);

    const overrun = JSON.parse(JSON.stringify(result)) as ScoreboardEvaluation;
    const point = overrun.series[0];
    const node = point?.nodes[0];
    if (node === undefined) {
      throw new Error('fixture produced no series node');
    }
    node.cpuUtilization = 1.0001;
    expect(parseScoreboardEvaluation(overrun).ok).toBe(false);

    const nodeOverrun = JSON.parse(JSON.stringify(result)) as ScoreboardEvaluation;
    const metric = nodeOverrun.nodes[0];
    if (metric === undefined) {
      throw new Error('fixture produced no node metric');
    }
    metric.cpu.utilizationAverage = 1.0001;
    expect(parseScoreboardEvaluation(nodeOverrun).ok).toBe(false);
  });

  it('keeps freshness-failing and passing results parseable at fixed seeds', () => {
    for (const [fixture, seed] of [
      ['fail-stale-cache', 607],
      ['family-fullscan', 607],
      ['family-cache', 607],
      ['family-aggregate', 607],
    ] as const) {
      const result = evaluateScoreboard(load(fixture), { seed });
      expectBoundedCpu(result);
      expect(parseScoreboardEvaluation(result).ok, fixture).toBe(true);
    }
  });
});
