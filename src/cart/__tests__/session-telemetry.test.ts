/**
 * GC-012 public session ↔ telemetry integration.
 *
 * These tests import only the frozen public entry point (`src/cart/index.ts`),
 * drive the real `CartEvaluationSession` (no stubbed model), and prove that live
 * frame observation is additive: identical results/hash/costs with observation
 * disabled and at two frame cadences, correct per-case identity, bounded
 * retention, advance-budget honesty, cancellation flush and detached payloads.
 *
 * The real six-case run is bounded with the existing deterministic
 * `runtimeBudgetMs` test hook plus a synthetic monotonic clock, so the same
 * frozen workload and model execute and the comparison stays deterministic.
 */
import { describe, expect, it } from 'vitest';
import {
  CART_LEVEL_ID,
  CART_REQUIRED_CASES,
  CART_VERSIONS,
  createCartSession,
  createCartStarterGraph,
  type CartCaseTelemetry,
  type CartEvaluation,
  type CartGraph,
  type CartTelemetryObserver,
  type CartTrafficFrame,
} from '../index';

/**
 * Qualifying three-region fixture mirrored from the evaluation/telemetry suites:
 * every region has a durable write authority and the Inventory is reachable over
 * real request paths, so edits, reads and checkouts emit physical traffic.
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
    seed: 1729,
    nodes,
    edges,
    circuits,
  } as unknown as CartGraph;
}

/** Deterministic monotonic clock so `runtimeBudgetMs` is a stable input. */
function boundedClock(): () => number {
  let ticks = 0;
  return () => {
    ticks += 1;
    return ticks;
  };
}

interface ObservedSession {
  readonly evaluation: CartEvaluation;
  readonly frames: readonly CartTrafficFrame[];
  readonly cases: readonly CartCaseTelemetry[];
  readonly framesByAdvance: readonly number[];
  readonly eventsByAdvance: readonly number[];
}

/** Runs the real public session to completion with an optional observer. */
function runSession(telemetry?: CartTelemetryObserver): ObservedSession {
  const frames: CartTrafficFrame[] = [];
  const cases: CartCaseTelemetry[] = [];
  const framesByAdvance: number[] = [];
  const eventsByAdvance: number[] = [];
  const observed: CartTelemetryObserver | undefined =
    telemetry === undefined
      ? undefined
      : {
          ...telemetry,
          onFrame: (frame) => {
            frames.push(frame);
            telemetry.onFrame?.(frame);
          },
          onCaseTelemetry: (snapshot) => {
            cases.push(snapshot);
            telemetry.onCaseTelemetry?.(snapshot);
          },
        };
  const session = createCartSession(qualifyingGraph(), {
    seed: 1729,
    now: boundedClock(),
    runtimeBudgetMs: 400,
    ...(observed === undefined ? {} : { telemetry: observed }),
  });
  let last = { done: false, events: 0 };
  for (let guard = 0; guard < 64; guard += 1) {
    const step = session.advance(5_000);
    framesByAdvance.push(frames.length);
    eventsByAdvance.push(step.progress.events - last.events);
    last = { done: step.done, events: step.progress.events };
    if (step.done) break;
  }
  expect(last.done).toBe(true);
  const evaluation = session.result();
  expect(evaluation).not.toBeNull();
  return { evaluation: evaluation as CartEvaluation, frames, cases, framesByAdvance, eventsByAdvance };
}

function classSum(bytes: CartCaseTelemetry['totals']['byClass']): number {
  return bytes.request + bytes.reply + bytes.replication + bytes.repair + bytes.retry;
}

describe('GC-012 public session telemetry integration', () => {
  it('receives live frames before completion and keeps results, hash and costs identical', () => {
    const disabled = runSession();
    const fine = runSession({ cadenceUs: 20_000, maxFrames: 32, maxTraceEvents: 24 });
    const coarse = runSession({ cadenceUs: 500_000, maxFrames: 5, maxTraceEvents: 6 });

    // The public session really ran every required case in both modes.
    expect(disabled.evaluation.requiredCases).toEqual([...CART_REQUIRED_CASES]);
    expect(fine.cases).toHaveLength(CART_REQUIRED_CASES.length);
    expect(fine.cases.map((snapshot) => snapshot.caseId)).toEqual([...CART_REQUIRED_CASES]);
    expect(fine.evaluation.cases.map((caseResult) => caseResult.id)).toEqual([...CART_REQUIRED_CASES]);

    // Observation is additive: identical result, trace hash and costs.
    expect(fine.evaluation).toEqual(disabled.evaluation);
    expect(coarse.evaluation).toEqual(disabled.evaluation);
    expect(fine.evaluation.traceHash).toBe(disabled.evaluation.traceHash);
    expect(coarse.evaluation.traceHash).toBe(disabled.evaluation.traceHash);
    expect(fine.evaluation.cases.map((caseResult) => caseResult.cost)).toEqual(
      disabled.evaluation.cases.map((caseResult) => caseResult.cost),
    );

    // Live frames arrived while cases were still executing, not only at flush.
    expect(fine.frames.length).toBeGreaterThan(0);
    expect(fine.framesByAdvance[0]).toBeGreaterThan(0);
    expect(fine.framesByAdvance[fine.framesByAdvance.length - 1]).toBe(fine.frames.length);
    // Cadence changes presentation only: finer cadence yields more windows,
    // coarse sampling stays bounded, and every total/digest is identical.
    expect(fine.frames.length).toBeGreaterThan(coarse.frames.length);
    for (let position = 0; position < fine.cases.length; position += 1) {
      const fineCase = fine.cases[position] as CartCaseTelemetry;
      const coarseCase = coarse.cases[position] as CartCaseTelemetry;
      expect(coarseCase.totals).toEqual(fineCase.totals);
      expect(coarseCase.trace.digest).toBe(fineCase.trace.digest);
      expect(coarseCase.frames.length).toBeLessThanOrEqual(5);
      expect(fineCase.frames.length).toBeLessThanOrEqual(32);
      expect(fineCase.trace.retainedEvents).toBeLessThanOrEqual(24);
    }

    // Physical-circuit aggregation matches the case's own resource counters and
    // every frame is a partition of its own window.
    for (const snapshot of fine.cases) {
      const caseResult = fine.evaluation.cases.find((entry) => entry.id === snapshot.caseId);
      expect(caseResult).toBeDefined();
      expect(snapshot.complete).toBe(true);
      expect(snapshot.issues).toEqual([]);
      expect(snapshot.totals.wanBillableBytes).toBe(caseResult?.resources.wanBillableBytes);
      expect(classSum(snapshot.totals.byClass)).toBe(snapshot.totals.serializedBytes);
      expect(snapshot.totals.byCircuit.reduce((sum, circuit) => sum + circuit.bytes, 0)).toBe(
        snapshot.totals.wanBillableBytes,
      );
      for (const frame of snapshot.frames) {
        expect(frame.caseId).toBe(snapshot.caseId);
        expect(frame.serializedBytes).toBe(classSum(frame.bytes));
        expect(frame.wanBillableBytes).toBeLessThanOrEqual(frame.serializedBytes);
      }
      // Bounded retention may drop whole windows; it never rewrites one. When
      // nothing was sampled the frames are an exact partition of the totals.
      const retainedBytes = snapshot.frames.reduce((sum, frame) => sum + frame.serializedBytes, 0);
      expect(retainedBytes).toBeLessThanOrEqual(snapshot.totals.serializedBytes);
      const sampled = snapshot.frames.some((frame) => frame.sampled);
      expect(sampled).toBe(snapshot.windowCount > snapshot.frames.length);
      if (!sampled) expect(retainedBytes).toBe(snapshot.totals.serializedBytes);
      expect(snapshot.trace.totalEvents).toBe(snapshot.totals.byteEvents);
    }
  }, 600_000);

  it('honours the advance budget and flushes exactly once on cancellation', () => {
    const frames: CartTrafficFrame[] = [];
    const cases: CartCaseTelemetry[] = [];
    const session = createCartSession(qualifyingGraph(), {
      seed: 1729,
      telemetry: {
        cadenceUs: 10_000,
        maxFrames: 8,
        maxTraceEvents: 8,
        onFrame: (frame) => frames.push(frame),
        onCaseTelemetry: (snapshot) => cases.push(snapshot),
      },
    });

    const first = session.advance(40);
    expect(first.done).toBe(false);
    expect(first.progress.events).toBe(40);

    const framesBeforeCancel = frames.length;
    const casesBeforeCancel = cases.length;
    session.cancel();
    expect(cases.length).toBe(casesBeforeCancel + 1);
    const flushed = cases[cases.length - 1] as CartCaseTelemetry;
    expect(flushed.complete).toBe(false);
    expect(flushed.caseId).toBe('normal');
    expect(flushed.frames.length).toBeLessThanOrEqual(8);
    expect(flushed.trace.retainedEvents).toBeLessThanOrEqual(8);
    expect(frames.length).toBeGreaterThanOrEqual(framesBeforeCancel);

    // No later frames or payloads after cancellation, including a repeated
    // advance and a repeated cancel.
    const framesAfterCancel = frames.length;
    const casesAfterCancel = cases.length;
    expect(session.advance(5).done).toBe(true);
    session.cancel();
    expect(frames.length).toBe(framesAfterCancel);
    expect(cases.length).toBe(casesAfterCancel);
    expect(session.result()?.complete).toBe(false);
    expect(session.result()?.scoreCreditsPerHour).toBeNull();
  }, 120_000);

  it('emits no fabricated frames for structurally invalid input', () => {
    const frames: CartTrafficFrame[] = [];
    const cases: CartCaseTelemetry[] = [];
    const session = createCartSession(
      { levelId: CART_LEVEL_ID, nodes: 'not-a-graph' },
      {
        telemetry: {
          onFrame: (frame) => frames.push(frame),
          onCaseTelemetry: (snapshot) => cases.push(snapshot),
        },
      },
    );
    expect(session.advance(10).done).toBe(true);
    session.cancel();
    expect(frames).toHaveLength(0);
    expect(cases).toHaveLength(0);
    expect(session.result()?.complete).toBe(false);
    expect(session.result()?.qualified).toBe(false);
  });

  it('hands out detached frames that cannot mutate model state', () => {
    const seen: CartTrafficFrame[] = [];
    const evaluation = runSession({
      cadenceUs: 50_000,
      onFrame: (frame) => {
        seen.push(frame);
        expect(Object.isFrozen(frame)).toBe(true);
        expect(Object.isFrozen(frame.bytes)).toBe(true);
        // Strict-mode assignment to a frozen record must throw, proving the
        // callback cannot edit the accounting it was handed.
        expect(() => {
          (frame.bytes as { request: number }).request = -1;
        }).toThrow(TypeError);
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    const withoutObservation = runSession();
    expect(evaluation.evaluation).toEqual(withoutObservation.evaluation);
  }, 600_000);

  it('keeps the starter graph emission-free on the public boundary', () => {
    // The unqualified starter graph executes no physical bytes, so live
    // telemetry must not invent any traffic on the real session path either.
    const frames: CartTrafficFrame[] = [];
    const cases: CartCaseTelemetry[] = [];
    const session = createCartSession(createCartStarterGraph(), {
      seed: 1729,
      telemetry: {
        onFrame: (frame) => frames.push(frame),
        onCaseTelemetry: (snapshot) => cases.push(snapshot),
      },
    });
    let done = false;
    for (let guard = 0; guard < 1_000 && !done; guard += 1) {
      done = session.advance(5_000).done;
    }
    expect(done).toBe(true);
    expect(frames).toHaveLength(0);
    expect(cases).toHaveLength(CART_REQUIRED_CASES.length);
    for (const snapshot of cases) {
      expect(snapshot.complete).toBe(true);
      expect(snapshot.totals.serializedBytes).toBe(0);
      expect(snapshot.totals.wanBillableBytes).toBe(0);
      expect(snapshot.issues).toEqual([]);
    }
  }, 600_000);
});
