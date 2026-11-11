/**
 * GC-015 main-thread control evidence.
 *
 * The worker is a fake transport here: the tests prove run/generation guards,
 * frame and result validation, bounded English errors, cancellation semantics
 * and that recorded replay changes only the view. Deterministic core execution
 * through the real runtime is covered by `src/cart/worker/cartRuntime.test.ts`.
 */
import { createElement } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CART_LEVEL_ID,
  CART_REQUIRED_CASES,
  CART_VERSIONS,
  CART_WORKER_PROTOCOL,
  cartGraphDigest,
  createCartStarterGraph,
  type CartEvaluation,
  type CartGraph,
  type CartProgress,
  type CartTrafficFrame,
} from '../index';
import type { CartWorkerRequest } from '../worker/cart-worker-protocol';
import {
  createCartRunController,
  describeCartPreflight,
  preflightCartRun,
  type CartRunHandlers,
  type CartWorkerLike,
} from './cart-run-controller';
import { CartReplayControl } from './CartReplayControl';

class FakeWorker implements CartWorkerLike {
  readonly sent: CartWorkerRequest[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<EventListener>>();

  postMessage(message: unknown): void {
    this.sent.push(message as CartWorkerRequest);
  }

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener(new MessageEvent('message', { data }));
    }
  }
}

function factory(workers: FakeWorker[]) {
  return () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  };
}

function progress(value: Partial<CartProgress> = {}): CartProgress {
  return {
    caseId: 'normal',
    casesCompleted: 0,
    events: 10,
    elapsedUs: 100,
    ...value,
  };
}

function frame(index: number, windowUs = 100_000): CartTrafficFrame {
  return {
    levelId: CART_LEVEL_ID,
    caseId: 'normal',
    index,
    windowStartUs: index * windowUs,
    windowEndUs: (index + 1) * windowUs,
    windowUs,
    phase: 'measured',
    bytes: { request: 0, reply: 0, replication: 0, repair: 0, retry: 0 },
    serializedBytes: 0,
    wanBillableBytes: 0,
    nodes: [],
    links: [],
    circuits: [],
    sampled: false,
  };
}

function progressMessage(
  run: { runId: string; generation: number },
  value: CartProgress,
  frames: CartTrafficFrame[] = [],
  overrides: { runId?: string; generation?: number } = {},
): unknown {
  return {
    protocol: CART_WORKER_PROTOCOL,
    runId: overrides.runId ?? run.runId,
    generation: overrides.generation ?? run.generation,
    type: 'progress',
    payload: { progress: value, frames },
  };
}

function evaluation(
  graph: CartGraph,
  complete = false,
): CartEvaluation {
  const emptyCase = (id: (typeof CART_REQUIRED_CASES)[number]) => ({
    id,
    scheduled: 0,
    issued: 0,
    dependencyFailed: 0,
    outcomes: {},
    gates: [],
    resources: {},
    cost: {},
    complete,
  });
  return {
    levelId: CART_LEVEL_ID,
    versions: { ...CART_VERSIONS },
    graphDigest: cartGraphDigest(graph),
    seed: 17,
    requiredCases: [...CART_REQUIRED_CASES],
    cases: CART_REQUIRED_CASES.map(emptyCase),
    complete,
    qualified: false,
    scoreCreditsPerHour: null,
    issues: [],
    traceHash: 'a'.repeat(64),
  };
}

function resultMessage(
  run: { runId: string; generation: number },
  result: CartEvaluation,
  overrides: { runId?: string; generation?: number } = {},
): unknown {
  return {
    protocol: CART_WORKER_PROTOCOL,
    runId: overrides.runId ?? run.runId,
    generation: overrides.generation ?? run.generation,
    type: 'result',
    payload: { evaluation: result },
  };
}

function handlers(overrides: Partial<CartRunHandlers> = {}): CartRunHandlers & {
  progress: CartProgress[];
  frames: CartTrafficFrame[];
  results: CartEvaluation[];
  cancelled: (CartEvaluation | null)[];
  errors: string[];
} {
  const progress: CartProgress[] = [];
  const frames: CartTrafficFrame[] = [];
  const results: CartEvaluation[] = [];
  const cancelled: (CartEvaluation | null)[] = [];
  const errors: string[] = [];
  return {
    progress,
    frames,
    results,
    cancelled,
    errors,
    onProgress: (value, accepted) => {
      progress.push(value);
      overrides.onProgress?.(value, accepted);
    },
    onFrame: (value) => {
      frames.push(value);
      overrides.onFrame?.(value);
    },
    onResult: (value) => {
      results.push(value);
      overrides.onResult?.(value);
    },
    onCancelled: (value) => {
      cancelled.push(value);
      overrides.onCancelled?.(value);
    },
    onError: (message) => {
      errors.push(message);
      overrides.onError?.(message);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Global Cart run controller', () => {
  it('tags requests with runId/generation and ignores stale generations', () => {
    const workers: FakeWorker[] = [];
    const controller = createCartRunController({
      createWorker: factory(workers),
      progressIntervalMs: 0,
      maxFramesPerCase: 3,
    });
    const seen = handlers();
    const graph = createCartStarterGraph();
    const token = controller.start({ graph, seed: 17 }, seen);
    expect(token).not.toBeNull();
    const run = token as { runId: string; generation: number };

    const worker = workers[0] as FakeWorker;
    const sent = worker.sent[0] as CartWorkerRequest;
    expect(sent.protocol).toBe(CART_WORKER_PROTOCOL);
    expect(sent.runId).toBe(run.runId);
    expect(sent.generation).toBe(run.generation);
    expect(sent.type).toBe('start');

    // Wrong generation and wrong runId are ignored before dispatch.
    worker.emit(progressMessage(run, progress(), [], { generation: run.generation + 9 }));
    expect(seen.progress).toHaveLength(0);
    worker.emit(progressMessage(run, progress(), [], { runId: 'other-run' }));
    expect(seen.progress).toHaveLength(0);

    worker.emit(progressMessage(run, progress(), [frame(0), frame(1)]));
    expect(seen.frames.map((entry) => entry.index)).toEqual([0, 1]);
    expect(seen.progress).toHaveLength(1);

    // Duplicate/out-of-order frames are dropped; the per-case cap is enforced.
    worker.emit(progressMessage(run, progress({ events: 20 }), [frame(1), frame(2)]));
    worker.emit(progressMessage(run, progress({ events: 30 }), [frame(3)]));
    expect(seen.frames.map((entry) => entry.index)).toEqual([0, 1, 2]);

    const result = evaluation(graph);
    worker.emit(resultMessage(run, result));
    expect(seen.results).toHaveLength(1);
    expect(seen.results[0]?.traceHash).toBe(result.traceHash);
    expect(worker.terminated).toBe(true);
    expect(controller.current()).toBeNull();
    controller.dispose();
  });

  it('rejects results after a reset or level switch by runId and generation', () => {
    const workers: FakeWorker[] = [];
    const controller = createCartRunController({
      createWorker: factory(workers),
      progressIntervalMs: 0,
    });
    const firstHandlers = handlers();
    const secondHandlers = handlers();
    const graph = createCartStarterGraph();

    const first = controller.start({ graph, seed: 17 }, firstHandlers) as {
      runId: string;
      generation: number;
    };
    const firstWorker = workers[0] as FakeWorker;
    const second = controller.start({ graph, seed: 17 }, secondHandlers) as {
      runId: string;
      generation: number;
    };
    const secondWorker = workers[1] as FakeWorker;

    expect(second.generation).toBe(first.generation + 1);
    expect(firstWorker.terminated).toBe(true);
    expect(controller.current()).toEqual(second);

    // A stale result for the previous runId may arrive with the new generation.
    secondWorker.emit(
      resultMessage(second, evaluation(graph), { runId: first.runId }),
    );
    expect(secondHandlers.results).toHaveLength(0);

    // A stale generation with the right runId is also rejected.
    secondWorker.emit(
      resultMessage(second, evaluation(graph), { generation: first.generation }),
    );
    expect(secondHandlers.results).toHaveLength(0);

    const accepted = evaluation(graph);
    secondWorker.emit(resultMessage(second, accepted));
    expect(secondHandlers.results).toHaveLength(1);
    expect(firstHandlers.results).toHaveLength(0);
    controller.dispose();
  });

  it('never turns a cancelled run into a passing result', () => {
    const workers: FakeWorker[] = [];
    const controller = createCartRunController({
      createWorker: factory(workers),
      cancelGraceMs: 1_000,
      progressIntervalMs: 0,
    });
    const graph = createCartStarterGraph();

    const seen = handlers();
    const run = controller.start({ graph, seed: 17 }, seen) as {
      runId: string;
      generation: number;
    };
    let worker = workers[0] as FakeWorker;
    controller.cancel();
    expect(worker.sent.some((message) => message.type === 'cancel')).toBe(true);
    expect(seen.cancelled).toHaveLength(0);

    const incomplete = evaluation(graph);
    worker.emit(resultMessage(run, incomplete));
    expect(seen.results).toHaveLength(0);
    expect(seen.cancelled).toHaveLength(1);
    expect(seen.cancelled[0]?.complete).toBe(false);
    expect(worker.terminated).toBe(true);

    // A forged completed result after cancel is rejected, never delivered.
    const forgedHandlers = handlers();
    const forged = controller.start({ graph, seed: 17 }, forgedHandlers) as {
      runId: string;
      generation: number;
    };
    worker = workers[1] as FakeWorker;
    controller.cancel();
    worker.emit(resultMessage(forged, evaluation(graph, true)));
    expect(forgedHandlers.results).toHaveLength(0);
    expect(forgedHandlers.cancelled).toEqual([null]);
    expect(forgedHandlers.errors).toHaveLength(1);
    expect(forgedHandlers.errors[0]?.length).toBeLessThanOrEqual(280);

    // Grace expiry still clears the run without inventing a result.
    const silentHandlers = handlers();
    controller.start({ graph, seed: 17 }, silentHandlers);
    worker = workers[2] as FakeWorker;
    controller.cancel();
    act(() => {
      vi.advanceTimersByTime(1_100);
    });
    expect(silentHandlers.results).toHaveLength(0);
    expect(silentHandlers.cancelled).toEqual([null]);
    expect(worker.terminated).toBe(true);
    controller.dispose();
  });

  it('surfaces malformed replies as bounded English errors and stays usable', () => {
    const workers: FakeWorker[] = [];
    const controller = createCartRunController({
      createWorker: factory(workers),
      progressIntervalMs: 0,
    });
    const graph = createCartStarterGraph();
    const firstHandlers = handlers();
    const run = controller.start({ graph, seed: 17 }, firstHandlers) as {
      runId: string;
      generation: number;
    };
    const firstWorker = workers[0] as FakeWorker;

    expect(() =>
      firstWorker.emit({
        protocol: CART_WORKER_PROTOCOL,
        runId: run.runId,
        generation: run.generation,
        type: 'progress',
        payload: { progress: { bogus: true } },
      }),
    ).not.toThrow();
    expect(firstHandlers.errors).toHaveLength(1);
    expect(firstHandlers.errors[0]).toMatch(/malformed progress/);
    expect(firstHandlers.errors[0]?.length).toBeLessThanOrEqual(280);
    expect(firstWorker.terminated).toBe(true);
    expect(controller.current()).toBeNull();

    // A new run works normally on a fresh worker.
    const secondHandlers = handlers();
    const second = controller.start({ graph, seed: 17 }, secondHandlers) as {
      runId: string;
      generation: number;
    };
    const secondWorker = workers[1] as FakeWorker;
    secondWorker.emit(resultMessage(second, evaluation(graph)));
    expect(secondHandlers.results).toHaveLength(1);
    controller.dispose();
  });
});

describe('Global Cart recorded replay', () => {
  it('changes only the view and playback speed, never the measured frames', () => {
    const frames = [0, 1, 2, 3].map((index) => frame(index));
    const before = frames.map((entry) => ({ ...entry }));
    const viewed: number[] = [];

    render(
      createElement(CartReplayControl, {
        frames,
        caseLabel: 'Normal traffic',
        onViewFrame: (entry) => {
          if (entry !== null) viewed.push(entry.index);
        },
      }),
    );

    expect(screen.getByTestId('cart-case-replay')).toHaveAttribute(
      'data-cart-replay-mode',
      'summary',
    );
    expect(screen.getByText(/4 measured samples/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    expect(screen.getByTestId('cart-case-replay')).toHaveAttribute(
      'data-cart-replay-mode',
      'playing',
    );
    expect(screen.getByText(/sample 1\/4/)).toBeVisible();

    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.getByText(/sample 2\/4/)).toBeVisible();

    fireEvent.change(screen.getByRole('combobox', { name: 'Replay speed' }), {
      target: { value: '2' },
    });
    expect(screen.getByTestId('cart-case-replay')).toHaveAttribute(
      'data-cart-replay-speed',
      '2',
    );
    // At 2× the dwell time halves; speed is presentation-only.
    act(() => {
      vi.advanceTimersByTime(175);
    });
    expect(screen.getByText(/sample 3\/4/)).toBeVisible();

    act(() => {
      vi.advanceTimersByTime(175);
    });
    expect(screen.getByText(/sample 4\/4/)).toBeVisible();
    act(() => {
      vi.advanceTimersByTime(175);
    });
    expect(screen.getByTestId('cart-case-replay')).toHaveAttribute(
      'data-cart-replay-mode',
      'paused',
    );
    expect(screen.getByRole('button', { name: 'Play replay' })).toBeVisible();

    // Seeking and speed changes never touch the recorded measurement.
    fireEvent.change(screen.getByRole('slider', { name: 'Replay sample' }), {
      target: { value: '0' },
    });
    expect(screen.getByText(/sample 1\/4/)).toBeVisible();
    expect(frames).toEqual(before);
    expect(viewed.every((index) => Number.isInteger(index))).toBe(true);
  });
});

describe('Global Cart run preflight', () => {
  function incompleteGraph(): CartGraph {
    const starter = createCartStarterGraph();
    return {
      ...starter,
      nodes: [
        ...starter.nodes,
        {
          id: 'app-us-west-1',
          kind: 'application',
          region: 'us-west',
          position: { x: 220, y: 180 },
          size: 'S',
          instances: 1,
          writeTarget: '',
          readPolicy: 'local-repair',
          readTargets: [],
        },
      ],
    } as CartGraph;
  }

  it('refuses an unconfigured Application before any worker exists', () => {
    const workers: FakeWorker[] = [];
    const controller = createCartRunController({ createWorker: factory(workers) });
    const graph = incompleteGraph();
    const errors: string[] = [];
    const blocked: string[] = [];
    const token = controller.start({ graph, seed: 17 }, {
      onError: (message) => errors.push(message),
      onBlocked: (issues) => blocked.push(...issues.map((issue) => issue.message)),
    });
    expect(token).toBeNull();
    expect(workers).toHaveLength(0);
    expect(controller.current()).toBeNull();
    expect(blocked[0]).toMatch(/US West/);
    expect(blocked[0]).toMatch(/write authority/);
    expect(errors.join(' ')).toMatch(/Cannot run yet/);
    expect(errors.join(' ')).not.toMatch(/nodes\.\d|writeTarget|invalid_type/);
    // Preflight never mutates the draft into a runnable graph.
    expect(graph.nodes).toHaveLength(4);
    expect(graph.nodes[3]).toMatchObject({ writeTarget: '', readTargets: [] });
  });

  it('reports an unusable configured design as concise English causes', () => {
    const graph = incompleteGraph();
    const app = graph.nodes[3];
    if (app?.kind !== 'application') throw new Error('fixture');
    const configured: CartGraph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === app.id ? { ...app, writeTarget: 'missing-journal' } : node,
      ),
    };
    const result = preflightCartRun({ graph: configured, seed: 17 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.nodeId === app.id)).toBe(true);
    const text = describeCartPreflight(result.issues);
    expect(text).toMatch(/^Cannot run yet: /);
    expect(text).not.toMatch(/nodes\.\d|writeTarget/);
  });

  it('lets a source-only starter through so a run reports honestly', () => {
    const workers: FakeWorker[] = [];
    const controller = createCartRunController({ createWorker: factory(workers) });
    const token = controller.start({ graph: createCartStarterGraph(), seed: 17 });
    expect(token).not.toBeNull();
    expect(workers).toHaveLength(1);
    controller.dispose();
  });
});
