/**
 * Main-thread controller for the Global Cart browser worker (GC-015).
 *
 * It owns exactly one run at a time and tags every request with a fresh
 * `runId` and a monotonically increasing `generation`. Responses are accepted
 * only when both match the active run, so a result that arrives after a reset,
 * level switch or cancellation can never change the new run. Progress is
 * presentation-throttled while complete telemetry frames are forwarded through
 * a bounded per-case guard. All diagnostics are bounded English text.
 */
import {
  CART_DEFAULT_SEED,
  CART_LEVEL_ID,
  CART_MAX_SEED,
  CART_MAX_ADVANCE_EVENTS,
  CART_REGION_INFO,
  CART_REQUIRED_CASES,
  CART_WORKER_PROTOCOL,
  cartEvaluationSchema,
  cartGraphDigest,
  cloneCartGraph,
  isCartStructuralIssue,
  validateCartGraph,
  type CartCaseTelemetry,
  type CartEvaluation,
  type CartGraph,
  type CartIssue,
  type CartProgress,
  type CartTrafficFrame,
} from '../index';
import {
  parseCartWorkerResponse,
  type CartWorkerRequest,
} from '../worker/cart-worker-protocol';
import { createCartWorker } from '../worker/cart-worker-factory';
import { parseDraftCartGraph } from './cart-persistence';

export interface CartWorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  terminate(): void;
}

export type CartWorkerFactory = () => CartWorkerLike;

export interface CartRunStartInput {
  readonly graph: CartGraph;
  readonly seed?: number;
  readonly maxEventsPerAdvance?: number;
  /** False starts paused; `advance()` still steps one bounded slice. */
  readonly autoplay?: boolean;
  readonly telemetry?: {
    readonly cadenceUs?: number;
    readonly maxFrames?: number;
    readonly maxTraceEvents?: number;
  };
}

export interface CartRunHandlers {
  onProgress?: (progress: CartProgress, frames: readonly CartTrafficFrame[]) => void;
  onFrame?: (frame: CartTrafficFrame) => void;
  onTelemetry?: (telemetry: CartCaseTelemetry) => void;
  onResult?: (evaluation: CartEvaluation) => void;
  /** Cancelled or stopped runs deliver their incomplete result here, never `onResult`. */
  onCancelled?: (evaluation: CartEvaluation | null) => void;
  onError?: (message: string) => void;
  /**
   * An incomplete draft never reaches a worker: its actionable causes arrive
   * here so the UI can open the named component's Properties directly.
   */
  onBlocked?: (issues: readonly CartIssue[]) => void;
}

export type CartRunPreflightResult =
  | { readonly ok: true; readonly graph: CartGraph; readonly seed: number }
  | { readonly ok: false; readonly issues: readonly CartIssue[] };

function applicationLabel(graph: CartGraph, nodeId: string | undefined): string {
  if (nodeId === undefined) return 'Application';
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.kind !== 'application') return 'Application';
  const region = CART_REGION_INFO[node.region].label;
  return `${node.label ?? 'Application'} (${region})`;
}

/**
 * Rewrites engine-shaped target issues into concise English causes that name
 * the Application, its region and the missing setting. Never changes the graph.
 */
function withApplicationContext(graph: CartGraph, issue: CartIssue): CartIssue {
  const name = applicationLabel(graph, issue.nodeId);
  switch (issue.code) {
    case 'write_target_missing':
      return {
        ...issue,
        message: `${name} has no durable write authority. Open its Properties and choose a journal or cart store.`,
      };
    case 'write_target_not_durable':
      return {
        ...issue,
        message: `${name} must acknowledge on a journal or cart store. Open its Properties and choose a durable target.`,
      };
    case 'write_target_unreachable':
      return {
        ...issue,
        message: `${name} has no drawn request path to its write target. Draw the path, then confirm the target in its Properties.`,
      };
    case 'read_target_missing':
    case 'read_target_kind':
    case 'read_target_unreachable':
    case 'read_target_duplicate':
      return {
        ...issue,
        message: `${name} has an unusable read/fallback target. Open its Properties and choose reachable targets.`,
      };
    default:
      return issue;
  }
}

/**
 * Preflight for a real run. Returns the exact graph and seed a worker may
 * receive, or the complete set of actionable blocking causes. It never
 * auto-selects an authority, read target or any other setting.
 */
export function preflightCartRun(input: {
  readonly graph: CartGraph;
  readonly seed?: number;
}): CartRunPreflightResult {
  const parsed = parseDraftCartGraph(input.graph);
  if (!parsed.ok) {
    return {
      ok: false,
      issues: parsed.issues.map((issue) => ({
        ...issue,
        message: `The design document is not valid: ${issue.message}`,
      })),
    };
  }
  const graph = parsed.graph;
  const seed = input.seed ?? CART_DEFAULT_SEED;
  if (!Number.isInteger(seed) || seed < 0 || seed > CART_MAX_SEED) {
    return {
      ok: false,
      issues: [
        {
          code: 'seed_out_of_range',
          message: 'The seed must be an integer between 0 and 4294967295.',
        },
      ],
    };
  }
  // Structural defects make the graph unusable and must never reach a worker.
  // Missing qualifying regions stay a legitimate incomplete state: a source-only
  // design still runs and reports honestly instead of inventing services.
  const issues: CartIssue[] = validateCartGraph(graph)
    .filter((issue) => isCartStructuralIssue(issue))
    .map((issue) => withApplicationContext(graph, issue));
  for (const node of graph.nodes) {
    if (node.kind !== 'application') continue;
    if (node.writeTarget === '') {
      // Already reported as a write-target cause above; keep one cause per gap.
      continue;
    }
    if (node.readTargets.length === 0) {
      issues.push({
        code: 'read_targets_unconfigured',
        nodeId: node.id,
        message: `${applicationLabel(graph, node.id)} has no configured read/fallback targets. Open its Properties and select at least one.`,
      });
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, graph, seed };
}

/** One bounded English line for the first blocking cause plus a count. */
export function describeCartPreflight(issues: readonly CartIssue[]): string {
  const first = issues[0];
  if (first === undefined) {
    return 'This design cannot run yet. The graph is unchanged.';
  }
  const extra =
    issues.length > 1
      ? ` (and ${issues.length - 1} more ${issues.length === 2 ? 'cause' : 'causes'})`
      : '';
  return `Cannot run yet: ${first.message}${extra}`;
}

export interface CartRunControllerOptions {
  createWorker?: CartWorkerFactory;
  startTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Grace period for an incomplete result after cancel. */
  cancelGraceMs?: number;
  /** Minimum gap between progress callbacks; frames are never throttled. */
  progressIntervalMs?: number;
  maxFramesPerCase?: number;
}

export interface CartRunController {
  /** Starts a fresh run; any previous worker is terminated first. */
  start(input: CartRunStartInput, handlers?: CartRunHandlers): CartRunToken | null;
  /** Steps one bounded slice; only meaningful when `autoplay` is false. */
  advance(maxEvents?: number): boolean;
  cancel(): void;
  dispose(): void;
  current(): CartRunToken | null;
}

export interface CartRunToken {
  readonly runId: string;
  readonly generation: number;
}

const MAX_MESSAGE_LENGTH = 280;
const MAX_FRAMES_PER_CASE = 240;
const DEFAULT_PROGRESS_INTERVAL_MS = 100;
let runCounter = 0;

function nextRunId(): string {
  runCounter += 1;
  const suffix = `${Date.now().toString(36)}-${runCounter.toString(36)}`;
  return `cart-run-${suffix}`;
}

function boundedEnglish(message: string, fallback: string): string {
  const trimmed = message.trim();
  const value = trimmed.length > 0 ? trimmed : fallback;
  return value.length <= MAX_MESSAGE_LENGTH
    ? value
    : `${value.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

function friendlyEngineError(message: string): string {
  const bounded = boundedEnglish(
    message,
    'The Global Cart evaluation failed without a message. The graph is unchanged.',
  );
  if (/failed to fetch|network/i.test(bounded)) {
    return 'The Global Cart engine could not be started. The graph is unchanged; try again.';
  }
  return bounded;
}

function evaluationIdentityMatches(
  evaluation: CartEvaluation,
  digest: string,
  seed: number,
): boolean {
  if (
    evaluation.levelId !== CART_LEVEL_ID ||
    evaluation.seed !== seed ||
    evaluation.graphDigest !== digest
  ) {
    return false;
  }
  if (evaluation.requiredCases.length !== CART_REQUIRED_CASES.length) return false;
  for (let index = 0; index < CART_REQUIRED_CASES.length; index += 1) {
    if (evaluation.requiredCases[index] !== CART_REQUIRED_CASES[index]) return false;
    if (evaluation.cases[index]?.id !== CART_REQUIRED_CASES[index]) return false;
  }
  return evaluation.cases.length === CART_REQUIRED_CASES.length;
}

interface ClientOptions {
  readonly startTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly progressIntervalMs: number;
  readonly maxFramesPerCase: number;
}

class CartWorkerClient {
  private readonly worker: CartWorkerLike;
  private readonly handlers: CartRunHandlers;
  private readonly options: ClientOptions;
  private readonly digest: string;
  private readonly seed: number;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressAt = 0;
  private readonly lastFrameIndex = new Map<string, number>();
  private readonly frameCounts = new Map<string, number>();
  private readonly seenTelemetry = new Set<string>();
  private cancelling = false;
  private disposed = false;

  constructor(
    factory: CartWorkerFactory,
    private readonly token: CartRunToken,
    digest: string,
    seed: number,
    handlers: CartRunHandlers,
    options: ClientOptions,
  ) {
    this.handlers = handlers;
    this.options = options;
    this.digest = digest;
    this.seed = seed;
    this.worker = factory();
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleWorkerError);
    this.worker.addEventListener('messageerror', this.handleMessageError);
    this.startTimer = setTimeout(() => {
      this.fail(
        'The Global Cart evaluation engine did not respond in time. The graph is unchanged; try again.',
      );
    }, options.startTimeoutMs);
    this.totalTimer = setTimeout(() => {
      this.fail(
        'The Global Cart evaluation exceeded its time bound and was cancelled. No partial result is reported.',
      );
    }, options.totalTimeoutMs);
  }

  markCancelling(): void {
    this.cancelling = true;
  }

  private clearStartTimer(): void {
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearStartTimer();
    if (this.totalTimer !== null) {
      clearTimeout(this.totalTimer);
      this.totalTimer = null;
    }
  }

  private acceptFrames(frames: readonly CartTrafficFrame[]): CartTrafficFrame[] {
    const accepted: CartTrafficFrame[] = [];
    for (const frame of frames) {
      const lastIndex = this.lastFrameIndex.get(frame.caseId);
      // A duplicate or out-of-order frame is presentation noise, never a new
      // measurement; dropping it keeps the timeline monotonic.
      if (lastIndex !== undefined && frame.index <= lastIndex) continue;
      const count = this.frameCounts.get(frame.caseId) ?? 0;
      if (count >= this.options.maxFramesPerCase) continue;
      this.lastFrameIndex.set(frame.caseId, frame.index);
      this.frameCounts.set(frame.caseId, count + 1);
      accepted.push(frame);
    }
    return accepted;
  }

  private acceptTelemetry(telemetry: readonly CartCaseTelemetry[] | undefined): void {
    if (telemetry === undefined) return;
    for (const snapshot of telemetry) {
      if (this.seenTelemetry.has(snapshot.caseId)) continue;
      this.seenTelemetry.add(snapshot.caseId);
      this.handlers.onTelemetry?.(snapshot);
    }
  }

  private fail(message: string): void {
    if (this.disposed) return;
    const text = friendlyEngineError(message);
    this.dispose();
    this.handlers.onError?.(text);
  }

  private handleMessage = (event: Event): void => {
    if (this.disposed) return;
    const data: unknown = (event as MessageEvent).data;
    const parsed = parseCartWorkerResponse(data);
    if (!parsed.ok) {
      // Only a reply that claims this exact run may surface an error; foreign
      // or unidentifiable traffic is ignored rather than blamed on this run.
      if (
        parsed.runId === this.token.runId &&
        parsed.generation === this.token.generation
      ) {
        this.fail(parsed.reason);
      }
      return;
    }
    const message = parsed.message;
    if (
      message.runId !== this.token.runId ||
      message.generation !== this.token.generation
    ) {
      return;
    }
    this.clearStartTimer();

    switch (message.type) {
      case 'progress': {
        this.acceptTelemetry(message.payload.telemetry);
        const frames = this.acceptFrames(message.payload.frames ?? []);
        for (const frame of frames) this.handlers.onFrame?.(frame);
        const now = Date.now();
        if (
          now - this.lastProgressAt >= this.options.progressIntervalMs ||
          message.payload.progress.caseId === null
        ) {
          this.lastProgressAt = now;
          this.handlers.onProgress?.(message.payload.progress, frames);
        }
        break;
      }
      case 'result': {
        const parsedEvaluation = cartEvaluationSchema.safeParse(
          message.payload.evaluation,
        );
        if (!parsedEvaluation.success) {
          this.fail(
            'The result could not be read. Please run again.',
          );
          return;
        }
        const evaluation = parsedEvaluation.data;
        if (!evaluationIdentityMatches(evaluation, this.digest, this.seed)) {
          this.fail(
            'The result does not match the design and seed you ran. It was discarded. Please run again.',
          );
          return;
        }
        if (this.cancelling) {
          if (evaluation.complete) {
            const handlers = this.handlers;
            this.dispose();
            handlers.onError?.(
              'The Global Cart engine returned a completed result after cancellation. It was rejected.',
            );
            handlers.onCancelled?.(null);
            return;
          }
          this.acceptTelemetry(message.payload.telemetry);
          const handlers = this.handlers;
          this.dispose();
          handlers.onCancelled?.(evaluation);
          return;
        }
        this.acceptTelemetry(message.payload.telemetry);
        const handlers = this.handlers;
        this.dispose();
        handlers.onResult?.(evaluation);
        break;
      }
      case 'error':
        this.fail(message.payload.message);
        break;
      default:
        break;
    }
  };

  private handleWorkerError = (event: Event): void => {
    const detail =
      event instanceof ErrorEvent && typeof event.message === 'string'
        ? event.message.trim()
        : '';
    this.fail(
      detail
        ? `The simulation stopped with an error: ${detail}`
        : 'The Global Cart evaluation engine could not start.',
    );
  };

  private handleMessageError = (): void => {
    this.fail('The Global Cart evaluation engine returned an unreadable message.');
  };

  send(request: CartWorkerRequest): boolean {
    if (this.disposed) return false;
    try {
      this.worker.postMessage(request);
      return true;
    } catch {
      this.fail('Could not send the evaluation request to the Global Cart engine.');
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleWorkerError);
    this.worker.removeEventListener('messageerror', this.handleMessageError);
    try {
      this.worker.terminate();
    } catch {
      // A worker that already failed may throw on terminate.
    }
  }
}

export function createCartRunController(
  options: CartRunControllerOptions = {},
): CartRunController {
  const createWorker = options.createWorker ?? createCartWorker;
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  const totalTimeoutMs = options.totalTimeoutMs ?? 300_000;
  const cancelGraceMs = options.cancelGraceMs ?? 1_500;
  const progressIntervalMs =
    options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  const maxFramesPerCase = options.maxFramesPerCase ?? MAX_FRAMES_PER_CASE;

  let client: CartWorkerClient | null = null;
  let active: CartRunToken | null = null;
  let activeHandlers: CartRunHandlers = {};
  let generation = -1;
  let cancelTimer: ReturnType<typeof setTimeout> | null = null;

  const clearCancelTimer = (): void => {
    if (cancelTimer !== null) {
      clearTimeout(cancelTimer);
      cancelTimer = null;
    }
  };

  const isCurrent = (token: CartRunToken): boolean =>
    active !== null &&
    active.runId === token.runId &&
    active.generation === token.generation;

  const disposeClient = (): void => {
    client?.dispose();
    client = null;
  };

  const onClientError = (token: CartRunToken, message: string): void => {
    if (!isCurrent(token)) return;
    clearCancelTimer();
    const cancelling = client !== null;
    disposeClient();
    active = null;
    activeHandlers.onError?.(boundedEnglish(message, 'The Global Cart engine failed.'));
    if (cancelling) activeHandlers.onCancelled?.(null);
  };

  const start: CartRunController['start'] = (input, handlers = {}) => {
    const preflight = preflightCartRun({ graph: input.graph, seed: input.seed });
    if (!preflight.ok) {
      // No worker is created for an incomplete draft; the graph is untouched.
      handlers.onBlocked?.(preflight.issues);
      handlers.onError?.(describeCartPreflight(preflight.issues));
      return null;
    }
    const seed = preflight.seed;

    disposeClient();
    clearCancelTimer();
    activeHandlers = handlers;

    const graph = cloneCartGraph(preflight.graph);
    const digest = cartGraphDigest(graph);
    generation += 1;
    const token: CartRunToken = { runId: nextRunId(), generation };
    active = token;

    try {
      const workerClient = new CartWorkerClient(
        createWorker,
        token,
        digest,
        seed,
        {
          onProgress: (progress, frames) => {
            if (!isCurrent(token)) return;
            handlers.onProgress?.(progress, frames);
          },
          onFrame: (frame) => {
            if (!isCurrent(token)) return;
            handlers.onFrame?.(frame);
          },
          onTelemetry: (telemetry) => {
            if (!isCurrent(token)) return;
            handlers.onTelemetry?.(telemetry);
          },
          onResult: (evaluation) => {
            if (!isCurrent(token)) return;
            clearCancelTimer();
            disposeClient();
            active = null;
            handlers.onResult?.(evaluation);
          },
          onCancelled: (evaluation) => {
            if (!isCurrent(token)) return;
            clearCancelTimer();
            disposeClient();
            active = null;
            handlers.onCancelled?.(evaluation);
          },
          onError: (message) => onClientError(token, message),
        },
        { startTimeoutMs, totalTimeoutMs, progressIntervalMs, maxFramesPerCase },
      );
      client = workerClient;
      const sent = workerClient.send({
        protocol: CART_WORKER_PROTOCOL,
        runId: token.runId,
        generation: token.generation,
        type: 'start',
        payload: {
          graph,
          seed,
          ...(input.maxEventsPerAdvance === undefined
            ? {}
            : { maxEventsPerAdvance: input.maxEventsPerAdvance }),
          ...(input.autoplay === undefined ? {} : { autoplay: input.autoplay }),
          ...(input.telemetry === undefined ? {} : { telemetry: input.telemetry }),
        },
      });
      if (!sent) return null;
      return token;
    } catch {
      disposeClient();
      active = null;
      handlers.onError?.(
        'Could not start the Global Cart evaluation engine. The graph is editable; try again.',
      );
      return null;
    }
  };

  const advance: CartRunController['advance'] = (maxEvents) => {
    if (client === null || active === null) return false;
    return client.send({
      protocol: CART_WORKER_PROTOCOL,
      runId: active.runId,
      generation: active.generation,
      type: 'advance',
      payload:
        maxEvents === undefined
          ? {}
          : {
              maxEvents: Math.max(
                1,
                Math.min(Math.floor(maxEvents), CART_MAX_ADVANCE_EVENTS),
              ),
            },
    });
  };

  const cancel: CartRunController['cancel'] = () => {
    const token = active;
    const workerClient = client;
    if (token === null || workerClient === null) {
      disposeClient();
      active = null;
      return;
    }
    workerClient.markCancelling();
    workerClient.send({
      protocol: CART_WORKER_PROTOCOL,
      runId: token.runId,
      generation: token.generation,
      type: 'cancel',
      payload: {},
    });
    clearCancelTimer();
    cancelTimer = setTimeout(() => {
      if (!isCurrent(token)) return;
      disposeClient();
      active = null;
      activeHandlers.onCancelled?.(null);
    }, cancelGraceMs);
  };

  const dispose: CartRunController['dispose'] = () => {
    clearCancelTimer();
    if (client !== null && active !== null) {
      client.send({
        protocol: CART_WORKER_PROTOCOL,
        runId: active.runId,
        generation: active.generation,
        type: 'cancel',
        payload: {},
      });
    }
    disposeClient();
    active = null;
  };

  return {
    start,
    advance,
    cancel,
    dispose,
    current: () => active,
  };
}
