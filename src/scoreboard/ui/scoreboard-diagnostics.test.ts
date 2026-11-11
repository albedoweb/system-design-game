import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SCOREBOARD_LEVEL,
  evaluateScoreboard,
  type ScoreboardEvaluation,
  type ScoreboardNodeMetrics,
} from '../index';
import {
  scoreboardProblemMaps,
  uniqueScoreboardIssues,
} from './scoreboard-diagnostics';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'fixtures', 'scoreboard', `${name}.json`),
      'utf8',
    ),
  );
}

function metrics(
  overrides: Partial<ScoreboardNodeMetrics> = {},
): ScoreboardNodeMetrics {
  return {
    nodeId: 'sql-1',
    kind: 'sql',
    label: 'SQL Database',
    instances: 1,
    cpu: {
      capacityCores: 2,
      busyCoresAverage: 0.1,
      busyCoresPeak: 0.2,
      busyCoreMs: 100,
      utilizationAverage: 0.05,
      utilizationPeak: 0.1,
    },
    memory: {
      capacityBytes: 4_000_000_000,
      workingSetBytes: 64_000_000,
      residentBytesAverage: 70_000_000,
      peakUsedBytes: 80_000_000,
    },
    queue: {
      waitingAverage: 0,
      waitingPeak: 0,
      waitMsAverage: 0,
      waitMsMax: 0,
      waitSamples: 0,
      activePeak: 1,
    },
    network: {
      capacityGbitPerSec: 10,
      bytesOffered: 100,
      bytesDelivered: 100,
      averageGbitPerSec: 0.01,
      peakGbitPerSec: 0.02,
    },
    tasks: {
      submitted: 100,
      completed: 100,
      rejected: 0,
      timedOut: 0,
      interrupted: 0,
    },
    ...overrides,
  };
}

function evaluationWith(
  node: ScoreboardNodeMetrics,
  issues: ScoreboardEvaluation['issues'] = [],
): ScoreboardEvaluation {
  return {
    issues,
    nodes: [node],
  } as unknown as ScoreboardEvaluation;
}

describe('Live Scoreboard local failure evidence', () => {
  it('never turns ordinary brief occupancy peaks into node errors', () => {
    const maps = scoreboardProblemMaps(
      [],
      evaluationWith(
        metrics({
          cpu: {
            capacityCores: 2,
            busyCoresAverage: 0.1,
            busyCoresPeak: 2,
            busyCoreMs: 100,
            utilizationAverage: 0.05,
            utilizationPeak: 1,
          },
          memory: {
            capacityBytes: 4_000_000_000,
            workingSetBytes: 64_000_000,
            residentBytesAverage: 70_000_000,
            peakUsedBytes: 4_000_000_000,
          },
          queue: {
            waitingAverage: 4,
            waitingPeak: SCOREBOARD_LEVEL.limits.maxSqlWaitingTasks,
            waitMsAverage: 120,
            waitMsMax: 800,
            waitSamples: 40,
            activePeak: 2,
          },
          network: {
            capacityGbitPerSec: 10,
            bytesOffered: 100,
            bytesDelivered: 100,
            averageGbitPerSec: 0.01,
            peakGbitPerSec: 10,
          },
        }),
      ),
    );
    expect(maps.byNode.size).toBe(0);
  });

  it('treats local rejections as error evidence and timeouts as pressure', () => {
    const maps = scoreboardProblemMaps(
      [],
      evaluationWith(
        metrics({
          tasks: {
            submitted: 10,
            completed: 7,
            rejected: 2,
            timedOut: 1,
            interrupted: 0,
          },
        }),
      ),
    );
    expect(maps.byNode.get('sql-1')?.severity).toBe('error');
    expect(maps.byNode.get('sql-1')?.messages.join(' ')).toMatch(
      /rejected 2 tasks/,
    );
  });

  it('keeps validation issues and deduplicates repeated messages', () => {
    const issue = {
      severity: 'error' as const,
      code: 'missing-sql',
      message: 'SQL is missing.',
      nodeId: 'app-1',
    };
    const unique = uniqueScoreboardIssues([issue, issue]);
    expect(unique).toHaveLength(1);
    const maps = scoreboardProblemMaps(unique, null);
    expect(maps.byNode.get('app-1')?.severity).toBe('error');
  });

  it('shows no false error or pressure badge on the real passing aggregate result', () => {
    const evaluation = evaluateScoreboard(fixture('family-aggregate'), {
      seed: 101,
    });
    expect(evaluation.status).toBe('complete');
    expect(evaluation.passed).toBe(true);
    expect(evaluation.issues).toEqual([]);
    // The run does reach instantaneous CPU peaks of 100% on individual cores.
    expect(
      evaluation.nodes.some((node) => node.cpu.utilizationPeak >= 0.99),
    ).toBe(true);

    const maps = scoreboardProblemMaps(evaluation.issues, evaluation);
    expect(maps.byNode.size).toBe(0);
  });

  it('identifies the actual rejecting component on the failing small scan', () => {
    const evaluation = evaluateScoreboard(fixture('fail-small-scan'), {
      seed: 101,
    });
    expect(evaluation.status).toBe('complete');
    expect(evaluation.passed).toBe(false);

    const maps = scoreboardProblemMaps(evaluation.issues, evaluation);
    const sql = maps.byNode.get('sql');
    expect(sql?.severity).toBe('error');
    expect(sql?.messages.join(' ')).toMatch(/rejected|queue/i);
    expect(maps.byNode.has('app')).toBe(false);
    expect(maps.byNode.has('users')).toBe(false);
  });
});
