import {
  createScoreboardSession,
  type ScoreboardRunOptions,
  type ScoreboardSession,
} from '../index';
import {
  isScoreboardWorkerRequest,
  type ScoreboardWorkerResponse,
} from './scoreboard-worker-protocol';

export type ScoreboardSessionFactory = (
  input: unknown,
  options?: ScoreboardRunOptions,
) => ScoreboardSession;

const DEFAULT_EVENTS_PER_ADVANCE = 5_000;
/** A cancelled session gets a bounded chance to report its incomplete result. */
const MAX_CANCEL_ADVANCES = 400;

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'The Live Scoreboard engine failed without a message.';
}

interface ActiveRun {
  runId: string;
  session: ScoreboardSession;
  cancelled: boolean;
  cancelAdvances: number;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

/**
 * Worker-side cooperative runtime. `advance` only limits scheduler events; it
 * never changes virtual time or the seeded trace. The event loop gets control
 * back after every bounded slice, so Stop and progress stay responsive.
 */
export function createScoreboardWorkerRuntime(
  post: (message: ScoreboardWorkerResponse) => void,
  createSession: ScoreboardSessionFactory = createScoreboardSession,
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

  const pump = (run: ActiveRun, budget: number): void => {
    if (run.stopped || active !== run) {
      return;
    }
    try {
      const advance = run.cancelled
        ? run.session.advance(1)
        : run.session.advance(budget);
      post({
        type: 'progress',
        runId: run.runId,
        progress: advance.progress,
      });

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
      if (!isScoreboardWorkerRequest(data)) {
        return;
      }

      if (data.type === 'cancel') {
        if (active !== null && active.runId === data.runId) {
          if (!active.cancelled) {
            active.cancelled = true;
            active.session.cancel();
          }
        }
        return;
      }

      if (active !== null) {
        active.session.cancel();
        stopTimers(active);
        active = null;
      }

      const budget =
        data.maxEventsPerAdvance ?? DEFAULT_EVENTS_PER_ADVANCE;
      let session: ScoreboardSession;
      try {
        session = createSession(data.graph, {
          seed: data.seed,
          onTraffic: (frame) => {
            if (active?.runId !== data.runId || active.stopped) {
              return;
            }
            post({
              type: 'traffic',
              runId: data.runId,
              frame: frame as never,
            });
          },
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
        cancelled: false,
        cancelAdvances: 0,
        timer: null,
        stopped: false,
      };
      active = run;
      post({ type: 'progress', runId: run.runId, progress: session.progress() });
      run.timer = setTimeout(() => pump(run, budget), 0);
    },

    /** Stop timers without producing a result; used on worker teardown. */
    dispose(): void {
      if (active !== null) {
        active.session.cancel();
        stopTimers(active);
        active = null;
      }
    },
  };
}
