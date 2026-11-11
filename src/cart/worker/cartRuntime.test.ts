/**
 * GC-015 worker transport evidence.
 *
 * These tests exercise the real pure core through the cooperative runtime:
 * bounded manual advances, live frames, protocol rejection, stale-generation
 * filtering and cancellation. They import only the public cart entry point for
 * the engine; the runtime and protocol are the assigned transport layer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CART_DEFAULT_SEED,
  CART_LEVEL_ID,
  CART_MAX_ADVANCE_EVENTS,
  CART_REQUIRED_CASES,
  CART_VERSIONS,
  CART_WORKER_PROTOCOL,
  createCartSession,
  createCartStarterGraph,
  type CartEvaluation,
  type CartGraph,
  type CartTrafficFrame,
} from '../index';
import {
  cartWorkerResponse,
  parseCartWorkerRequest,
  parseCartWorkerResponse,
  type CartWorkerRequest,
  type CartWorkerResponse,
} from './cart-worker-protocol';
import {
  createCartWorkerRuntime,
  type CartSessionFactory,
} from './cartRuntime';

/**
 * Qualifying three-region fixture mirrored from the GC-012 session suite:
 * every region has a durable write authority and Inventory is reachable over
 * real request paths, so the run emits physical traffic.
 */
function qualifyingGraph(): CartGraph {
  const nodes: Record<string, unknown>[] = [
    { id: 'customers-us-west', kind: 'customers', region: 'us-west', position: { x: 40, y: 40 } },
    { id: 'customers-eu-central', kind: 'customers', region: 'eu-central', position: { x: 440, y: 40 } },
    { id: 'customers-ap-northeast', kind: 'customers', region: 'ap-northeast', position: { x: 840, y: 40 } },
    {
      id: 'app-us-west',
      kind: 'application',
      region: 'us-west',
      position: { x: 80, y: 200 },
      size: 'S',
      instances: 1,
      writeTarget: 'journal-us-west',
      readPolicy: 'local-repair',
      readTargets: ['journal-us-west'],
    },
    {
      id: 'app-eu-central',
      kind: 'application',
      region: 'eu-central',
      position: { x: 480, y: 200 },
      size: 'S',
      instances: 2,
      writeTarget: 'journal-eu-central',
      readPolicy: 'parallel',
      readTargets: ['journal-eu-central'],
    },
    {
      id: 'app-ap-northeast',
      kind: 'application',
      region: 'ap-northeast',
      position: { x: 880, y: 200 },
      size: 'M',
      instances: 1,
      writeTarget: 'journal-ap-northeast',
      readPolicy: 'local-repair',
      readTargets: ['journal-ap-northeast'],
    },
    { id: 'journal-us-west', kind: 'journal', region: 'us-west', position: { x: 80, y: 340 }, size: 'S' },
    { id: 'journal-eu-central', kind: 'journal', region: 'eu-central', position: { x: 480, y: 340 }, size: 'M' },
    { id: 'journal-ap-northeast', kind: 'journal', region: 'ap-northeast', position: { x: 880, y: 340 }, size: 'S' },
    { id: 'inventory-us-west', kind: 'inventory', region: 'us-west', position: { x: 240, y: 480 }, size: 'M' },
  ];
  const edges: Record<string, unknown>[] = [
    { id: 'e-source-us', from: 'customers-us-west', to: 'app-us-west', kind: 'request' },
    { id: 'e-source-eu', from: 'customers-eu-central', to: 'app-eu-central', kind: 'request' },
    { id: 'e-source-ap', from: 'customers-ap-northeast', to: 'app-ap-northeast', kind: 'request' },
    { id: 'e-ack-us', from: 'app-us-west', to: 'journal-us-west', kind: 'request' },
    { id: 'e-ack-eu', from: 'app-eu-central', to: 'journal-eu-central', kind: 'request' },
    { id: 'e-ack-ap', from: 'app-ap-northeast', to: 'journal-ap-northeast', kind: 'request' },
    { id: 'e-inv-us', from: 'app-us-west', to: 'inventory-us-west', kind: 'request' },
    { id: 'e-inv-eu', from: 'app-eu-central', to: 'inventory-us-west', kind: 'request' },
    { id: 'e-inv-ap', from: 'app-ap-northeast', to: 'inventory-us-west', kind: 'request' },
    { id: 'p-us-eu', from: 'app-us-west', to: 'app-eu-central', kind: 'request' },
    { id: 'p-eu-us', from: 'app-eu-central', to: 'app-us-west', kind: 'request' },
    { id: 'p-eu-ap', from: 'app-eu-central', to: 'app-ap-northeast', kind: 'request' },
    { id: 'p-ap-eu', from: 'app-ap-northeast', to: 'app-eu-central', kind: 'request' },
    { id: 'p-us-ap', from: 'app-us-west', to: 'app-ap-northeast', kind: 'request' },
    { id: 'p-ap-us', from: 'app-ap-northeast', to: 'app-us-west', kind: 'request' },
  ];
  const circuits: Record<string, unknown>[] = [
    { regions: ['us-west', 'eu-central'], mbps: 8 },
    { regions: ['us-west', 'ap-northeast'], mbps: 32 },
    { regions: ['eu-central', 'ap-northeast'], mbps: 8 },
  ];
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: CART_DEFAULT_SEED,
    nodes,
    edges,
    circuits,
  } as unknown as CartGraph;
}

function boundedClock(): () => number {
  let ticks = 0;
  return () => {
    ticks += 1;
    return ticks;
  };
}

/** Real session with the documented deterministic test hook; no case skipped. */
const boundedSessionFactory: CartSessionFactory = (input, options) =>
  createCartSession(input, {
    ...options,
    now: boundedClock(),
    runtimeBudgetMs: 300,
  });

function startMessage(
  runId: string,
  generation: number,
  graph: CartGraph,
  options: {
    maxEventsPerAdvance?: number;
    autoplay?: boolean;
    telemetry?: {
      cadenceUs?: number;
      maxFrames?: number;
      maxTraceEvents?: number;
    };
  } = {},
): CartWorkerRequest {
  return {
    protocol: CART_WORKER_PROTOCOL,
    runId,
    generation,
    type: 'start',
    payload: {
      graph,
      seed: CART_DEFAULT_SEED,
      ...options,
    },
  };
}

function advanceMessage(
  runId: string,
  generation: number,
  maxEvents: number,
): CartWorkerRequest {
  return {
    protocol: CART_WORKER_PROTOCOL,
    runId,
    generation,
    type: 'advance',
    payload: { maxEvents },
  };
}

function cancelMessage(runId: string, generation: number): CartWorkerRequest {
  return {
    protocol: CART_WORKER_PROTOCOL,
    runId,
    generation,
    type: 'cancel',
    payload: {},
  };
}

function progressMessages(messages: readonly CartWorkerResponse[]) {
  return messages.filter((message) => message.type === 'progress');
}

function resultMessage(
  messages: readonly CartWorkerResponse[],
): (CartWorkerResponse & { type: 'result' }) | undefined {
  return messages.find(
    (message): message is CartWorkerResponse & { type: 'result' } =>
      message.type === 'result',
  );
}

function errorMessages(messages: readonly CartWorkerResponse[]) {
  return messages.filter((message) => message.type === 'error');
}

function runToCompletion(
  runtime: ReturnType<typeof createCartWorkerRuntime>,
  messages: CartWorkerResponse[],
  runId: string,
  generation: number,
  maxEvents = CART_MAX_ADVANCE_EVENTS,
): CartEvaluation {
  for (let step = 0; step < 4_000; step += 1) {
    const result = resultMessage(messages);
    if (result !== undefined) return result.payload.evaluation;
    runtime.handleMessage(advanceMessage(runId, generation, maxEvents));
  }
  throw new Error('the bounded runtime did not finish the evaluation');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Global Cart worker protocol', () => {
  it('accepts only the tagged start/cancel/advance request combinations', () => {
    const graph = createCartStarterGraph();
    const valid = parseCartWorkerRequest(startMessage('run-1', 0, graph));
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.message.type).toBe('start');
      expect(valid.message.protocol).toBe(CART_WORKER_PROTOCOL);
    }

    const responseAsRequest = parseCartWorkerRequest(
      cartWorkerResponse('run-1', 0, 'progress', {
        progress: {
          caseId: null,
          casesCompleted: 0,
          events: 0,
          elapsedUs: 0,
        },
      }),
    );
    expect(responseAsRequest.ok).toBe(false);
    if (!responseAsRequest.ok) {
      expect(responseAsRequest.reason).toMatch(/does not accept "progress" as a request/);
    }

    const missingGraph = parseCartWorkerRequest({
      protocol: CART_WORKER_PROTOCOL,
      runId: 'run-1',
      generation: 0,
      type: 'start',
      payload: { seed: 1 },
    });
    expect(missingGraph.ok).toBe(false);
    if (!missingGraph.ok) expect(missingGraph.reason.length).toBeLessThanOrEqual(280);
  });

  it('rejects malformed frames in a response instead of trusting them', () => {
    const parsed = parseCartWorkerResponse({
      protocol: CART_WORKER_PROTOCOL,
      runId: 'run-1',
      generation: 0,
      type: 'progress',
      payload: {
        progress: { caseId: null, casesCompleted: 0, events: 0, elapsedUs: 0 },
        frames: [{ levelId: CART_LEVEL_ID, caseId: 'normal', index: 0 }],
      },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toMatch(/malformed progress/);
      expect(parsed.reason.length).toBeLessThanOrEqual(280);
    }
  });
});

describe('Global Cart worker runtime', () => {
  it('produces one identical final result and trace hash at two telemetry cadences', () => {
    const graph = qualifyingGraph();
    const observeRun = (
      runId: string,
      cadenceUs: number,
      maxFrames: number,
    ): {
      messages: CartWorkerResponse[];
      evaluation: CartEvaluation;
      frames: CartTrafficFrame[];
    } => {
      const messages: CartWorkerResponse[] = [];
      const frames: CartTrafficFrame[] = [];
      const runtime = createCartWorkerRuntime(
        (message) => {
          const parsed = parseCartWorkerResponse(message);
          expect(parsed.ok).toBe(true);
          messages.push(message);
          if (message.type === 'progress') {
            for (const frame of message.payload.frames ?? []) frames.push(frame);
          }
        },
        boundedSessionFactory,
      );
      runtime.handleMessage(
        startMessage(runId, 0, graph, {
          maxEventsPerAdvance: CART_MAX_ADVANCE_EVENTS,
          autoplay: false,
          telemetry: { cadenceUs, maxFrames, maxTraceEvents: 8 },
        }),
      );
      const evaluation = runToCompletion(runtime, messages, runId, 0);
      runtime.dispose();
      return { messages, evaluation, frames };
    };

    const fine = observeRun('fine-run', 20_000, 12);
    const coarse = observeRun('coarse-run', 500_000, 3);

    expect(fine.evaluation.requiredCases).toEqual([...CART_REQUIRED_CASES]);
    expect(fine.evaluation.cases.map((entry) => entry.id)).toEqual([...CART_REQUIRED_CASES]);
    expect(fine.frames.length).toBeGreaterThan(0);
    expect(coarse.frames.length).toBeGreaterThan(0);
    expect(fine.frames.length).toBeGreaterThan(coarse.frames.length);

    // Cadence is presentation-only: final result, costs and trace hash agree.
    expect(fine.evaluation).toEqual(coarse.evaluation);
    expect(fine.evaluation.traceHash).toBe(coarse.evaluation.traceHash);

    const telemetryOf = (messages: CartWorkerResponse[]) => {
      const result = resultMessage(messages);
      expect(result).toBeDefined();
      return result?.payload.telemetry ?? [];
    };
    const fineTelemetry = telemetryOf(fine.messages);
    const coarseTelemetry = telemetryOf(coarse.messages);
    expect(fineTelemetry.map((entry) => entry.caseId)).toEqual([...CART_REQUIRED_CASES]);
    expect(coarseTelemetry.map((entry) => entry.caseId)).toEqual([...CART_REQUIRED_CASES]);
    for (let index = 0; index < fineTelemetry.length; index += 1) {
      const fineCase = fineTelemetry[index];
      const coarseCase = coarseTelemetry[index];
      expect(fineCase?.totals).toEqual(coarseCase?.totals);
      expect(fineCase?.trace.digest).toBe(coarseCase?.trace.digest);
    }
  }, 600_000);

  it('answers malformed messages with bounded English errors and keeps running', () => {
    const messages: CartWorkerResponse[] = [];
    const runtime = createCartWorkerRuntime((message) => messages.push(message));

    expect(() => runtime.handleMessage(null)).not.toThrow();
    expect(() =>
      runtime.handleMessage({
        protocol: CART_WORKER_PROTOCOL,
        runId: 'abused-run',
        generation: 0,
        type: 'result',
        payload: {},
      }),
    ).not.toThrow();
    expect(() =>
      runtime.handleMessage({
        protocol: CART_WORKER_PROTOCOL,
        runId: 'abused-run',
        generation: 0,
        type: 'start',
        payload: { seed: 1 },
      }),
    ).not.toThrow();
    expect(() =>
      runtime.handleMessage({
        protocol: CART_WORKER_PROTOCOL,
        runId: 'abused-run',
        generation: 0,
        type: 'advance',
        payload: { maxEvents: -5 },
      }),
    ).not.toThrow();

    const errors = errorMessages(messages);
    expect(errors).toHaveLength(4);
    for (const error of errors) {
      if (error.type !== 'error') continue;
      expect(error.payload.message.length).toBeGreaterThan(0);
      expect(error.payload.message.length).toBeLessThanOrEqual(280);
      expect(error.payload.message).toMatch(/[A-Za-z]/);
    }

    // The same runtime still accepts a well-formed run afterwards.
    runtime.handleMessage(
      startMessage('healthy-run', 1, createCartStarterGraph(), {
        autoplay: false,
        maxEventsPerAdvance: CART_MAX_ADVANCE_EVENTS,
      }),
    );
    const evaluation = runToCompletion(runtime, messages, 'healthy-run', 1);
    expect(evaluation.levelId).toBe(CART_LEVEL_ID);
    expect(evaluation.complete).toBe(false);
    expect(evaluation.qualified).toBe(false);
    runtime.dispose();
  }, 120_000);

  it('honours pause, bounded advances and cancellation between event batches', () => {
    vi.useFakeTimers();
    const messages: CartWorkerResponse[] = [];
    const runtime = createCartWorkerRuntime(
      (message) => messages.push(message),
      boundedSessionFactory,
    );
    runtime.handleMessage(
      startMessage('paused-run', 0, qualifyingGraph(), {
        autoplay: false,
        maxEventsPerAdvance: 250,
        telemetry: { cadenceUs: 50_000, maxFrames: 4 },
      }),
    );

    // Paused: only the initial ready progress exists, and time does not step.
    expect(messages).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(messages).toHaveLength(1);

    runtime.handleMessage(advanceMessage('paused-run', 0, 250));
    const afterFirst = progressMessages(messages);
    expect(afterFirst.length).toBeGreaterThanOrEqual(2);
    const lastEvents = afterFirst[afterFirst.length - 1]?.payload.progress.events ?? 0;
    expect(lastEvents).toBeLessThanOrEqual(250);

    // A stale generation cannot cancel or advance the active run.
    runtime.handleMessage(cancelMessage('paused-run', 99));
    runtime.handleMessage(advanceMessage('paused-run', 99, 250));
    expect(resultMessage(messages)).toBeUndefined();

    runtime.handleMessage(cancelMessage('paused-run', 0));
    const cancelled = resultMessage(messages);
    expect(cancelled).toBeDefined();
    expect(cancelled?.payload.evaluation.complete).toBe(false);
    expect(cancelled?.payload.evaluation.qualified).toBe(false);
    expect(cancelled?.payload.evaluation.scoreCreditsPerHour).toBeNull();

    const messageCount = messages.length;
    vi.advanceTimersByTime(10_000);
    runtime.handleMessage(advanceMessage('paused-run', 0, 250));
    expect(messages).toHaveLength(messageCount);
    runtime.dispose();
  }, 120_000);

  it('runs the Worker with the basic fault-free workload profile by default', () => {
    vi.useFakeTimers();
    const messages: CartWorkerResponse[] = [];
    const runtime = createCartWorkerRuntime((message) => messages.push(message));
    runtime.handleMessage(
      startMessage('profile-run', 0, qualifyingGraph(), { autoplay: false, maxEventsPerAdvance: 250 }),
    );
    runtime.handleMessage(advanceMessage('profile-run', 0, 250));
    runtime.handleMessage(cancelMessage('profile-run', 0));
    const evaluation = resultMessage(messages)?.payload.evaluation;
    expect(evaluation?.versions.profile).toBe('global-cart-v1-basic-desync100');
    expect(evaluation?.versions.profile).toBe(CART_VERSIONS.profile);
    runtime.dispose();
  }, 120_000);

  it('stops a superseded autoplay run before starting its replacement', () => {
    vi.useFakeTimers();
    const messages: CartWorkerResponse[] = [];
    const runtime = createCartWorkerRuntime(
      (message) => messages.push(message),
      boundedSessionFactory,
    );
    runtime.handleMessage(
      startMessage('first-run', 0, qualifyingGraph(), {
        autoplay: true,
        maxEventsPerAdvance: 200,
      }),
    );
    expect(progressMessages(messages)).toHaveLength(1);

    // One cooperative tick executes exactly one bounded slice and yields.
    vi.advanceTimersByTime(0);
    expect(resultMessage(messages)).toBeUndefined();

    runtime.handleMessage(
      startMessage('second-run', 0, createCartStarterGraph(), {
        autoplay: false,
      }),
    );
    const afterReset = messages.length;
    vi.advanceTimersByTime(10_000);
    expect(messages).toHaveLength(afterReset);
    expect(resultMessage(messages)).toBeUndefined();

    // The old run can no longer advance the replacement.
    runtime.handleMessage(advanceMessage('first-run', 0, 200));
    expect(resultMessage(messages)).toBeUndefined();
    runtime.dispose();
  }, 120_000);
});
