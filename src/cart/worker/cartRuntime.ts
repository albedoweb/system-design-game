/**
 * Worker-side cooperative runtime for the Global Cart pure core (GC-015).
 *
 * The session stays the only driver. This runtime only slices work into bounded
 * `advance` calls, yields to the worker event loop between slices, forwards
 * bounded telemetry frames and per-case payloads, and turns cancellation into
 * the session's incomplete result (never a pass). Every request is checked for
 * its exact protocol/type combination first, so a malformed message produces a
 * bounded English error instead of an exception.
 */
import {
  CART_MAX_ADVANCE_EVENTS,
  createCartSession,
  type CartCaseTelemetry,
  type CartEvaluatorOptions,
  type CartProgress,
  type CartSession,
  type CartTrafficFrame,
} from '../index';
import {
  CART_WORKER_MAX_TELEMETRY_FRAMES,
  cartWorkerParseError,
  cartWorkerResponse,
  parseCartWorkerRequest,
  type CartWorkerAdvancePayload,
  type CartWorkerResponse,
  type CartWorkerStartPayload,
} from './cart-worker-protocol';

export type CartSessionFactory = (
  input: unknown,
  options?: CartEvaluatorOptions,
) => CartSession;

const DEFAULT_EVENTS_PER_ADVANCE = 5_000;
const DEFAULT_AUTOPLAY = true;
/** Frames per progress message; presentation-only, never accounting. */
const MAX_FRAMES_PER_MESSAGE = 48;
/** Hard queue bound. Over-budget frames are dropped, not rerun. */
const MAX_PENDING_FRAMES = 480;
const MAX_SEEN_RUNS = 8;
const READY_PROGRESS: CartProgress = {
  caseId: null,
  casesCompleted: 0,
  events: 0,
  elapsedUs: 0,
  message: 'Ready to advance',
};

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    const message = error.message.trim();
    return message.length <= 240 ? message : `${message.slice(0, 239)}…`;
  }
  return 'The Global Cart engine failed without a message.';
}

function clampAdvance(value: number | undefined, fallback: number): number {
  const requested = value ?? fallback;
  return Math.max(1, Math.min(Math.floor(requested), CART_MAX_ADVANCE_EVENTS));
}

interface ActiveRun {
  readonly runId: string;
  readonly generation: number;
  readonly budget: number;
  readonly autoplay: boolean;
  readonly session: CartSession;
  readonly pendingFrames: CartTrafficFrame[];
  readonly caseTelemetry: CartCaseTelemetry[];
  readonly counters: { droppedFrames: number };
  readonly sentTelemetry: Set<CartCaseId>;
  progress: CartProgress;
  cancelled: boolean;
  stopped: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

type CartCaseId = CartCaseTelemetry['caseId'];

function createTelemetryObserver(
  run: Pick<ActiveRun, 'pendingFrames' | 'caseTelemetry' | 'counters'>,
  request: NonNullable<CartWorkerStartPayload['telemetry']>,
): NonNullable<CartEvaluatorOptions['telemetry']> {
  return {
    ...(request.cadenceUs === undefined ? {} : { cadenceUs: request.cadenceUs }),
    maxFrames: Math.max(
      1,
      Math.min(
        Math.floor(request.maxFrames ?? CART_WORKER_MAX_TELEMETRY_FRAMES),
        CART_WORKER_MAX_TELEMETRY_FRAMES,
      ),
    ),
    ...(request.maxTraceEvents === undefined
      ? {}
      : { maxTraceEvents: Math.max(1, Math.floor(request.maxTraceEvents)) }),
    onFrame: (frame) => {
      if (run.pendingFrames.length >= MAX_PENDING_FRAMES) {
        run.pendingFrames.shift();
        run.counters.droppedFrames += 1;
      }
      run.pendingFrames.push(frame);
    },
    onCaseTelemetry: (snapshot) => {
      run.caseTelemetry.push(snapshot);
    },
  };
}

export interface CartWorkerRuntime {
  /** Handles one raw worker message. Never throws for malformed input. */
  handleMessage(data: unknown): void;
  /** Stops timers/session without emitting a result (worker teardown). */
  dispose(): void;
}

export function createCartWorkerRuntime(
  post: (message: CartWorkerResponse) => void,
  createSession: CartSessionFactory = createCartSession,
): CartWorkerRuntime {
  let active: ActiveRun | null = null;
  const seenGenerations = new Map<string, number>();
  let closed = false;

  const rememberRun = (runId: string, generation: number): void => {
    seenGenerations.set(runId, generation);
    if (seenGenerations.size > MAX_SEEN_RUNS) {
      const oldest = seenGenerations.keys().next().value;
      if (oldest !== undefined) seenGenerations.delete(oldest);
    }
  };

  const stopTimers = (run: ActiveRun): void => {
    run.stopped = true;
    if (run.timer !== null) {
      clearTimeout(run.timer);
      run.timer = null;
    }
  };

  const finish = (run: ActiveRun): void => {
    stopTimers(run);
    if (active === run) active = null;
  };

  const postProgress = (
    run: ActiveRun,
    progress: CartProgress,
    frames: readonly CartTrafficFrame[],
    telemetry: readonly CartCaseTelemetry[],
    droppedFrames: number,
  ): void => {
    post(
      cartWorkerResponse(run.runId, run.generation, 'progress', {
        progress,
        ...(frames.length === 0 ? {} : { frames }),
        ...(telemetry.length === 0 ? {} : { telemetry }),
        ...(droppedFrames === 0 ? {} : { droppedFrames }),
      }),
    );
  };

  /** Sends newly completed per-case payloads exactly once. */
  const takeNewTelemetry = (run: ActiveRun): CartCaseTelemetry[] => {
    const fresh: CartCaseTelemetry[] = [];
    for (const snapshot of run.caseTelemetry) {
      if (run.sentTelemetry.has(snapshot.caseId)) continue;
      run.sentTelemetry.add(snapshot.caseId);
      fresh.push(snapshot);
    }
    return fresh;
  };

  const flush = (run: ActiveRun, progress: CartProgress): void => {
    let fresh = takeNewTelemetry(run);
    if (run.pendingFrames.length === 0) {
      // Every advance must acknowledge completion, including slices without traffic.
      const dropped = run.counters.droppedFrames;
      run.counters.droppedFrames = 0;
      postProgress(run, progress, [], fresh, dropped);
      return;
    }
    while (run.pendingFrames.length > 0) {
      const frames = run.pendingFrames.splice(0, MAX_FRAMES_PER_MESSAGE);
      const dropped = run.counters.droppedFrames;
      run.counters.droppedFrames = 0;
      postProgress(run, progress, frames, fresh, dropped);
      fresh = [];
    }
  };

  const postResult = (run: ActiveRun): void => {
    const evaluation = run.session.result();
    if (evaluation === null) {
      post(
        cartWorkerResponse(run.runId, run.generation, 'error', {
          message: 'The Global Cart evaluation finished without a result. The graph is unchanged.',
        }),
      );
    } else {
      post(
        cartWorkerResponse(run.runId, run.generation, 'result', {
          evaluation,
          ...(run.caseTelemetry.length === 0 ? {} : { telemetry: run.caseTelemetry }),
        }),
      );
    }
    finish(run);
  };

  const schedule = (run: ActiveRun): void => {
    if (closed || run.stopped || run.cancelled || !run.autoplay) return;
    run.timer = setTimeout(() => {
      run.timer = null;
      pump(run, run.budget);
    }, 0);
  };

  const pump = (run: ActiveRun, budget: number): void => {
    if (closed || run.stopped || active !== run) return;
    try {
      const step = run.session.advance(clampAdvance(budget, run.budget));
      run.progress = step.progress;
      flush(run, step.progress);
      if (step.done) {
        postResult(run);
        return;
      }
      schedule(run);
    } catch (error) {
      post(
        cartWorkerResponse(run.runId, run.generation, 'error', {
          message: describeError(error),
        }),
      );
      finish(run);
    }
  };

  const stopActive = (): void => {
    if (active === null) return;
    const previous = active;
    active = null;
    previous.cancelled = true;
    try {
      previous.session.cancel();
    } catch {
      // Teardown never reports a result for a superseded run.
    }
    stopTimers(previous);
  };

  const start = (runId: string, generation: number, payload: CartWorkerStartPayload): void => {
    stopActive();
    rememberRun(runId, generation);

    const holder = {
      pendingFrames: [] as CartTrafficFrame[],
      caseTelemetry: [] as CartCaseTelemetry[],
      counters: { droppedFrames: 0 },
    };
    const options: CartEvaluatorOptions = {
      seed: payload.seed,
      ...(payload.telemetry === undefined
        ? {}
        : { telemetry: createTelemetryObserver(holder, payload.telemetry) }),
    };

    let session: CartSession;
    try {
      session = createSession(payload.graph, options);
    } catch (error) {
      post(
        cartWorkerResponse(runId, generation, 'error', {
          message: describeError(error),
        }),
      );
      return;
    }

    const run: ActiveRun = {
      runId,
      generation,
      budget: clampAdvance(payload.maxEventsPerAdvance, DEFAULT_EVENTS_PER_ADVANCE),
      autoplay: payload.autoplay ?? DEFAULT_AUTOPLAY,
      session,
      pendingFrames: holder.pendingFrames,
      caseTelemetry: holder.caseTelemetry,
      counters: holder.counters,
      sentTelemetry: new Set<CartCaseId>(),
      progress: READY_PROGRESS,
      cancelled: false,
      stopped: false,
      timer: null,
    };
    active = run;
    postProgress(run, READY_PROGRESS, [], [], 0);
    schedule(run);
  };

  const cancel = (run: ActiveRun): void => {
    if (run.cancelled || run.stopped) return;
    run.cancelled = true;
    if (run.timer !== null) {
      clearTimeout(run.timer);
      run.timer = null;
    }
    try {
      // The session builds its incomplete evaluation and flushes the bounded
      // telemetry payload synchronously; no later advance can turn this into a
      // pass or emit more traffic.
      run.session.cancel();
      flush(run, run.progress);
      postResult(run);
    } catch (error) {
      post(
        cartWorkerResponse(run.runId, run.generation, 'error', {
          message: describeError(error),
        }),
      );
      finish(run);
    }
  };

  const advance = (run: ActiveRun, payload: CartWorkerAdvancePayload): void => {
    if (run.cancelled || run.stopped) return;
    if (run.timer !== null) {
      clearTimeout(run.timer);
      run.timer = null;
    }
    // One bounded slice per message; autoplay (if enabled) resumes afterwards.
    pump(run, clampAdvance(payload.maxEvents, run.budget));
  };

  return {
    handleMessage(data: unknown): void {
      if (closed) return;
      const parsed = parseCartWorkerRequest(data);
      if (!parsed.ok) {
        post(cartWorkerParseError(parsed));
        return;
      }
      const message = parsed.message;

      // Stale generation for an already-seen run is ignored, so a delayed
      // cancel/advance from a reset run cannot disturb the replacement run.
      const seen = seenGenerations.get(message.runId);
      if (
        message.type !== 'start' &&
        (seen === undefined || message.generation < seen)
      ) {
        return;
      }
      if (message.type !== 'start' && (active === null || active.runId !== message.runId)) {
        return;
      }
      if (message.type !== 'start' && active !== null && message.generation !== active.generation) {
        return;
      }

      if (message.type === 'start') {
        const seenGeneration = seenGenerations.get(message.runId);
        if (seenGeneration !== undefined && message.generation <= seenGeneration) {
          return;
        }
        start(message.runId, message.generation, message.payload);
        return;
      }
      if (active === null) return;
      if (message.type === 'cancel') {
        cancel(active);
        return;
      }
      advance(active, message.payload);
    },

    dispose(): void {
      closed = true;
      stopActive();
    },
  };
}
