import { describe, expect, it } from 'vitest';

import {
  createScoreboardStarterGraph,
  type ScoreboardProgress,
} from '../index';
import {
  isScoreboardWorkerRequest,
  isScoreboardWorkerResponse,
} from './scoreboard-worker-protocol';

const progress: ScoreboardProgress = {
  phase: 'run',
  nowMs: 20_000,
  measuredElapsedMs: 20_000,
  completedRequests: 100,
  totalRequests: 10_000,
  message: 'Running the measured window',
};

describe('Live Scoreboard worker protocol guards', () => {
  it('accepts a bounded run request and a cancel for the same run id', () => {
    expect(
      isScoreboardWorkerRequest({
        type: 'run',
        runId: 'run-1',
        graph: createScoreboardStarterGraph(),
        seed: 101,
        maxEventsPerAdvance: 5_000,
      }),
    ).toBe(true);
    expect(
      isScoreboardWorkerRequest({ type: 'cancel', runId: 'run-1' }),
    ).toBe(true);
  });

  it('rejects malformed requests instead of guessing', () => {
    expect(isScoreboardWorkerRequest(null)).toBe(false);
    expect(isScoreboardWorkerRequest({ type: 'run', runId: '', graph: {} })).toBe(
      false,
    );
    expect(
      isScoreboardWorkerRequest({
        type: 'run',
        runId: 'run-1',
        graph: {},
        seed: 1.5,
      }),
    ).toBe(false);
    expect(
      isScoreboardWorkerRequest({
        type: 'run',
        runId: 'run-1',
        graph: {},
        seed: 1,
        maxEventsPerAdvance: 0,
      }),
    ).toBe(false);
  });

  it('accepts only the known response kinds with a valid run id', () => {
    expect(
      isScoreboardWorkerResponse({
        type: 'progress',
        runId: 'run-1',
        progress,
      }),
    ).toBe(true);
    expect(
      isScoreboardWorkerResponse({
        type: 'result',
        runId: 'run-1',
        evaluation: { status: 'complete' },
      }),
    ).toBe(true);
    expect(
      isScoreboardWorkerResponse({
        type: 'error',
        runId: 'run-1',
        message: 'Engine failed',
      }),
    ).toBe(true);
    expect(
      isScoreboardWorkerResponse({
        type: 'traffic',
        runId: 'run-1',
        frame: { levelId: 'live-scoreboard' },
      }),
    ).toBe(true);
  });

  it('rejects unknown kinds and malformed progress', () => {
    expect(
      isScoreboardWorkerResponse({ type: 'done', runId: 'run-1' }),
    ).toBe(false);
    expect(
      isScoreboardWorkerResponse({
        type: 'progress',
        runId: 'run-1',
        progress: { ...progress, phase: 'unknown' },
      }),
    ).toBe(false);
    expect(
      isScoreboardWorkerResponse({ type: 'error', runId: 'run-1', message: '' }),
    ).toBe(false);
    expect(
      isScoreboardWorkerResponse({ type: 'result', runId: '', evaluation: {} }),
    ).toBe(false);
  });
});
