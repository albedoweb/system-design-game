import { createAudienceSession } from '../index';
import type {
  AudienceProgress,
  AudienceRunOptions,
  AudienceSession,
  AudienceTrafficFrame,
} from '../index';
import {
  isAudienceWorkerRequest,
  type AudienceWorkerResponse,
} from './audience-worker-protocol';

export type AudienceSessionFactory = (
  input: unknown,
  options?: AudienceRunOptions,
) => AudienceSession;

const DEFAULT_EVENTS_PER_ADVANCE = 5_000;
/** A cancelled session gets a bounded chance to report its incomplete result. */
const MAX_CANCEL_ADVANCES = 400;

/**
 * Cheap identity for one frame emission. Virtual time restarts for every case,
 * so the scope label and the surrounding counts are included to keep the
 * overlap comparison stable when only a bounded tail is returned.
 */
export function audienceFrameSignature(frame: AudienceTrafficFrame): string {
  return [
    frame.scopeId,
    frame.scopeLabel,
    frame.timeMs,
    frame.windowMs,
    frame.phase,
    frame.nodes.length,
    frame.edges.length,
  ].join('|');
}

/**
 * Number of leading frames in `current` that were already present at the end
 * of `previous`. This supports all three plausible `frames()` policies without
 * assuming one: a growing cumulative list, a truncated bounded ring, and a
 * per-case reset. A reset has no overlap, so its frame 0 is never dropped.
 */
export function audienceFrameOverlap(
  previous: readonly string[],
  current: readonly string[],
): number {
  const max = Math.min(previous.length, current.length);
  for (let length = max; length >= 1; length -= 1) {
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      if (previous[previous.length - length + index] !== current[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return length;
    }
  }
  return 0;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'The Live Audience engine failed without a message.';
}

interface ActiveRun {
  runId: string;
  session: AudienceSession;
  controller: AbortController;
  cancelled: boolean;
  cancelAdvances: number;
  lastFrameSignatures: string[];
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

/**
 * Worker-side cooperative runtime. `advance` only limits scheduler events; it
 * never changes virtual time or the seeded trace. The event loop gets control
 * back after every bounded slice, so Stop and progress stay responsive.
 */
export function createAudienceWorkerRuntime(
  post: (message: AudienceWorkerResponse) => void,
  createSession?: AudienceSessionFactory,
) {
  let active: ActiveRun | null = null;

  const stopTimers = (run: ActiveRun): void => {
    run.stopped = true;
    if (run.timer !== null) {
      clearTimeout(run.timer);
      run.timer = null;
    }
  };

  const finish = (run: ActiveRun): void => {
    if (active === run) {
      stopTimers(run);
      active = null;
    }
  };

  const postNewFrames = (run: ActiveRun): void => {
    const frames: readonly AudienceTrafficFrame[] = run.session.frames();
    const signatures = frames.map(audienceFrameSignature);
    const overlap = audienceFrameOverlap(run.lastFrameSignatures, signatures);
    for (const frame of frames.slice(overlap)) {
      post({ type: 'traffic', runId: run.runId, frame });
    }
    run.lastFrameSignatures = signatures;
  };

  const postProgress = (run: ActiveRun, progress: AudienceProgress): void => {
    post({ type: 'progress', runId: run.runId, progress });
  };

  const pump = (run: ActiveRun, budget: number): void => {
    if (run.stopped || active !== run) {
      return;
    }
    try {
      const advance = run.cancelled
        ? run.session.advance(1)
        : run.session.advance(budget);
      postNewFrames(run);
      postProgress(run, advance.progress);

      if (advance.done) {
        const result = run.session.result();
        if (result === null) {
          post({
            type: 'error',
            runId: run.runId,
            message: 'The evaluation finished without a result.',
          });
        } else {
          post({ type: 'result', runId: run.runId, evaluation: result });
        }
        finish(run);
        return;
      }

      if (run.cancelled) {
        run.cancelAdvances += 1;
        if (run.cancelAdvances > MAX_CANCEL_ADVANCES) {
          const partial = run.session.result();
          if (partial !== null) {
            post({ type: 'result', runId: run.runId, evaluation: partial });
          } else {
            post({
              type: 'error',
              runId: run.runId,
              message: 'The run was cancelled before a result was available.',
            });
          }
          finish(run);
          return;
        }
      }

      run.timer = setTimeout(() => pump(run, budget), 0);
    } catch (error) {
      post({
        type: 'error',
        runId: run.runId,
        message: describeError(error),
      });
      finish(run);
    }
  };

  return {
    handleMessage(data: unknown): void {
      if (!isAudienceWorkerRequest(data)) {
        return;
      }

      if (data.type === 'cancel') {
        if (active !== null && active.runId === data.runId) {
          if (!active.cancelled) {
            active.cancelled = true;
            active.controller.abort();
            active.session.cancel();
          }
        }
        return;
      }

      if (active !== null) {
        active.controller.abort();
        active.session.cancel();
        stopTimers(active);
        active = null;
      }

      const budget = data.maxEventsPerAdvance ?? DEFAULT_EVENTS_PER_ADVANCE;
      let session: AudienceSession;
      const controller = new AbortController();
      try {
        const factory = createSession ?? createAudienceSession;
        session = factory(data.graph, {
          seed: data.seed,
          abort: controller.signal,
        });
      } catch (error) {
        post({
          type: 'error',
          runId: data.runId,
          message: describeError(error),
        });
        return;
      }

      const run: ActiveRun = {
        runId: data.runId,
        session,
        controller,
        cancelled: false,
        cancelAdvances: 0,
        lastFrameSignatures: [],
        timer: null,
        stopped: false,
      };
      active = run;
      postProgress(run, session.progress());
      run.timer = setTimeout(() => pump(run, budget), 0);
    },

    /** Stop timers without producing a result; used on worker teardown. */
    dispose(): void {
      if (active !== null) {
        active.controller.abort();
        active.session.cancel();
        stopTimers(active);
        active = null;
      }
    },
  };
}
