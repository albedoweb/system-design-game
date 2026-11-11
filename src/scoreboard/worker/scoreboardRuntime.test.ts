import { describe, expect, it } from 'vitest';

import {
  createScoreboardStarterGraph,
  type ScoreboardEvaluation,
  type ScoreboardProgress,
  type ScoreboardSession,
} from '../index';
import { createScoreboardWorkerRuntime } from './scoreboardRuntime';
import type { ScoreboardWorkerResponse } from './scoreboard-worker-protocol';

function progress(phase: ScoreboardProgress['phase'], now: number): ScoreboardProgress {
  return {
    phase,
    nowMs: now,
    measuredElapsedMs: now,
    completedRequests: now / 1_000,
    totalRequests: 10,
    message: phase,
  };
}

function fakeSession(
  options: { onTraffic?: (frame: unknown) => void } = {},
): ScoreboardSession & { advanceCalls: number; cancelled: boolean } {
  let now = 0;
  let cancelled = false;
  const session = {
    identity: {
      levelId: 'live-scoreboard' as const,
      modelVersion: '1.0.0' as const,
      schemaVersion: 1 as const,
      contentVersion: '1.0.0' as const,
      pricingVersion: 'scoreboard-catalog-v1' as const,
      seed: 101,
      graphDigest: 'digest',
      runId: 'identity-run',
    },
    totalRequests: 10,
    advanceCalls: 0,
    cancelled: false,
    get done() {
      return now >= 3 || cancelled;
    },
    progress: () => progress(now >= 3 ? 'done' : 'run', now),
    advance() {
      this.advanceCalls += 1;
      now += 1;
      options.onTraffic?.({
        levelId: 'live-scoreboard',
        scopeId: 'live-measured',
        scopeLabel: 'Live measured',
        timeMs: now * 1_000,
        windowMs: 1_000,
        phase: 'measured',
        nodes: [],
        edges: [],
      });
      return {
        done: now >= 3 || cancelled,
        progress: progress(now >= 3 ? 'done' : 'run', now),
        processedEvents: 1,
        exhausted: false,
      };
    },
    runToCompletion() {
      return evaluation('complete');
    },
    cancel() {
      cancelled = true;
      this.cancelled = true;
    },
    result() {
      return now >= 3
        ? evaluation('complete')
        : cancelled
          ? evaluation('incomplete')
          : null;
    },
  };
  return session as ScoreboardSession & {
    advanceCalls: number;
    cancelled: boolean;
  };
}

function evaluation(
  status: 'complete' | 'incomplete' = 'complete',
): ScoreboardEvaluation {
  return {
    status,
    passed: status === 'complete',
    runId: 'identity-run',
    incompleteReasons: status === 'incomplete' ? ['Cancelled by the player.'] : [],
  } as unknown as ScoreboardEvaluation;
}

function waitFor(
  messages: ScoreboardWorkerResponse[],
  predicate: (message: ScoreboardWorkerResponse) => boolean,
): Promise<ScoreboardWorkerResponse> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = messages.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > 2_000) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for a worker message.'));
      }
    }, 5);
  });
}

describe('Live Scoreboard cooperative worker runtime', () => {
  it('advances in bounded slices and posts progress, traffic and a result', async () => {
    const messages: ScoreboardWorkerResponse[] = [];
    const sessions: ReturnType<typeof fakeSession>[] = [];
    const runtime = createScoreboardWorkerRuntime(
      (message) => messages.push(message),
      (_input, options) => {
        const session = fakeSession({
          onTraffic: options?.onTraffic as ((frame: unknown) => void) | undefined,
        });
        sessions.push(session);
        return session;
      },
    );

    runtime.handleMessage({
      type: 'run',
      runId: 'run-1',
      graph: createScoreboardStarterGraph(),
      seed: 101,
      maxEventsPerAdvance: 1,
    });

    const result = await waitFor(messages, (message) => message.type === 'result');
    expect(result.type).toBe('result');
    expect(messages.some((message) => message.type === 'traffic')).toBe(true);
    expect(
      messages.filter((message) => message.type === 'progress').length,
    ).toBeGreaterThan(1);
    expect(sessions[0]?.advanceCalls).toBeGreaterThanOrEqual(3);
    expect(
      messages.every(
        (message) => 'runId' in message && message.runId === 'run-1',
      ),
    ).toBe(true);
  });

  it('cancels into an incomplete result rather than a fake pass', async () => {
    const messages: ScoreboardWorkerResponse[] = [];
    const sessions: ReturnType<typeof fakeSession>[] = [];
    const runtime = createScoreboardWorkerRuntime(
      (message) => messages.push(message),
      (_input, options) => {
        const session = fakeSession({
          onTraffic: options?.onTraffic as ((frame: unknown) => void) | undefined,
        });
        sessions.push(session);
        return session;
      },
    );

    runtime.handleMessage({
      type: 'run',
      runId: 'run-2',
      graph: createScoreboardStarterGraph(),
      seed: 101,
    });
    runtime.handleMessage({ type: 'cancel', runId: 'run-2' });

    const result = await waitFor(messages, (message) => message.type === 'result');
    expect(result.type).toBe('result');
    if (result.type === 'result') {
      expect(result.evaluation.status).toBe('incomplete');
      expect(result.evaluation.passed).toBe(false);
    }
    expect(sessions[0]?.cancelled).toBe(true);
  });

  it('ignores messages for unknown or foreign runs', () => {
    const messages: ScoreboardWorkerResponse[] = [];
    const runtime = createScoreboardWorkerRuntime(
      (message) => messages.push(message),
      () => fakeSession(),
    );
    runtime.handleMessage({ type: 'cancel', runId: 'not-started' });
    runtime.handleMessage({ nonsense: true });
    expect(messages).toEqual([]);
  });
});
