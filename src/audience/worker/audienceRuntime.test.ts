import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAudienceStarterGraph,
  type AudienceAdvance,
  type AudienceEvaluation,
  type AudienceIdentity,
  type AudienceProgress,
  type AudienceSession,
  type AudienceTrafficFrame,
} from '../index';
import {
  audienceFrameOverlap,
  audienceFrameSignature,
  createAudienceWorkerRuntime,
} from './audienceRuntime';

function frame(
  timeMs: number,
  caseId: 'normal' | 'peak' = 'normal',
): AudienceTrafficFrame {
  return {
    levelId: 'live-audience',
    scopeId: caseId,
    scopeLabel: caseId,
    timeMs,
    windowMs: 1_000,
    phase: 'measured',
    nodes: [],
    edges: [],
  };
}

class FakeSession implements AudienceSession {
  readonly identity = {} as AudienceIdentity;
  readonly totalRequests = 10;
  done = false;
  cancelled = false;
  private calls = 0;
  private readonly plan: Array<() => void>;
  frameList: AudienceTrafficFrame[] = [];

  constructor(plan: Array<() => void>) {
    this.plan = plan;
  }

  progress(): AudienceProgress {
    return {
      phase: 'run',
      caseId: null,
      nowMs: 0,
      measuredElapsedMs: 0,
      completedRequests: 0,
      totalRequests: 10,
      message: 'running',
    };
  }

  advance(): AudienceAdvance {
    const step = this.plan[Math.min(this.calls, this.plan.length - 1)];
    this.calls += 1;
    step?.();
    return {
      done: this.done,
      progress: this.progress(),
      processedEvents: 1,
      exhausted: false,
    };
  }

  runToCompletion(): AudienceEvaluation {
    this.done = true;
    return {} as AudienceEvaluation;
  }

  cancel(): void {
    this.cancelled = true;
  }

  result(): AudienceEvaluation | null {
    return this.done ? ({} as AudienceEvaluation) : null;
  }

  frames(): readonly AudienceTrafficFrame[] {
    return this.frameList;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('audience worker frame delivery', () => {
  it('finds the overlap for growth, bounded ring and per-case reset', () => {
    const a = audienceFrameSignature(frame(1_000, 'normal'));
    const b = audienceFrameSignature(frame(2_000, 'normal'));
    const c = audienceFrameSignature(frame(3_000, 'normal'));
    const d = audienceFrameSignature(frame(4_000, 'normal'));
    expect(audienceFrameOverlap([a, b], [a, b, c])).toBe(2);
    expect(audienceFrameOverlap([a, b, c], [b, c, d])).toBe(2);
    expect(audienceFrameOverlap([a, b, c], [a, b, c])).toBe(3);
    // A per-case reset has no overlap, so frame 0 of the new case is posted.
    const firstOfNextCase = audienceFrameSignature(frame(0, 'peak'));
    expect(audienceFrameOverlap([a, b, c], [firstOfNextCase])).toBe(0);
  });

  it('posts each new frame once across growth and a case reset', () => {
    vi.useFakeTimers();
    const posted: string[] = [];
    const f0 = frame(1_000, 'normal');
    const f1 = frame(2_000, 'normal');
    const nextCase = frame(0, 'peak');
    const session = new FakeSession([
      () => {
        session.frameList = [f0, f1];
      },
      () => {
        session.frameList = [nextCase];
        session.done = true;
      },
    ]);
    const runtime = createAudienceWorkerRuntime(
      (message) => {
        if (message.type === 'traffic') {
          posted.push(audienceFrameSignature(message.frame));
        }
      },
      () => session,
    );

    runtime.handleMessage({
      type: 'run',
      runId: 'run-1',
      graph: { schemaVersion: 1, levelId: 'live-audience', nodes: [], edges: [] },
      seed: 101,
    });
    vi.runOnlyPendingTimers();
    expect(posted).toEqual([
      audienceFrameSignature(f0),
      audienceFrameSignature(f1),
    ]);

    vi.runOnlyPendingTimers();
    expect(posted).toEqual([
      audienceFrameSignature(f0),
      audienceFrameSignature(f1),
      audienceFrameSignature(nextCase),
    ]);
  });

  it('uses the typed real session by default instead of a placeholder', () => {
    vi.useFakeTimers();
    const results: AudienceEvaluation[] = [];
    const errors: string[] = [];
    const runtime = createAudienceWorkerRuntime((message) => {
      if (message.type === 'result') {
        results.push(message.evaluation);
      }
      if (message.type === 'error') {
        errors.push(message.message);
      }
    });
    runtime.handleMessage({
      type: 'run',
      runId: 'run-real',
      graph: createAudienceStarterGraph(),
      seed: 101,
    });
    for (let index = 0; index < 20 && results.length === 0; index += 1) {
      vi.runOnlyPendingTimers();
    }
    expect(errors).toEqual([]);
    expect(results).toHaveLength(1);
    // The starter is structurally complete but semantically invalid: the real
    // engine must say so rather than fabricating a pass.
    expect(results[0]?.status).toBe('invalid');
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.cases).toHaveLength(0);
  });

  it('cancels cooperatively and reports the partial result instead of a pass', () => {
    vi.useFakeTimers();
    const results: AudienceEvaluation[] = [];
    const session = new FakeSession([
      () => {
        if (session.cancelled) {
          session.done = true;
        }
      },
    ]);
    const runtime = createAudienceWorkerRuntime(
      (message) => {
        if (message.type === 'result') {
          results.push(message.evaluation);
        }
      },
      () => session,
    );
    runtime.handleMessage({
      type: 'run',
      runId: 'run-2',
      graph: { schemaVersion: 1, levelId: 'live-audience', nodes: [], edges: [] },
      seed: 101,
    });
    vi.runOnlyPendingTimers();
    runtime.handleMessage({ type: 'cancel', runId: 'run-2' });
    expect(session.cancelled).toBe(true);
    vi.runOnlyPendingTimers();
    expect(results).toHaveLength(1);
  });
});
