import { describe, expect, it } from 'vitest';

import { AUDIENCE_CATALOG } from '../catalog';
import { AUDIENCE_LEVEL } from '../level';
import {
  AUDIENCE_LEVEL_ID,
  AUDIENCE_PROFILE_VERSION,
  AUDIENCE_SCHEMA_VERSION,
  type AudienceCaseResult,
  type AudienceChallengeProfile,
  type AudienceGraph,
} from '../contracts';
import type { AudienceModel } from '../core/model';
import { AudienceSimulation } from '../session';

/**
 * Focused live-telemetry boundary test on a tiny private model.
 *
 * It uses the existing exact engine with a small dataset and a two-case
 * profile, so frame timing is fast but still real. No full qualification or
 * public 1M-user dataset is run here; `core.test.ts` keeps the broad engine
 * invariants.
 */

const STREAMS = 4;
const MEASURED_MS = 6_000;
const DRAIN_MS = 1_000;
const PREHISTORY = 80;

function tinyModel(): AudienceModel {
  const level = JSON.parse(JSON.stringify(AUDIENCE_LEVEL));
  const catalog = JSON.parse(JSON.stringify(AUDIENCE_CATALOG));
  level.dataset.users = 20;
  level.dataset.streams = STREAMS;
  level.dataset.prehistoryEvents = PREHISTORY;
  level.dataset.prehistoryRawBytes = PREHISTORY * 128;
  level.dataset.rankingBytes = 4_096;
  level.dataset.ingestAckBytes = 200;
  level.workload.measuredMs = MEASURED_MS;
  level.workload.drainMs = DRAIN_MS;
  level.workload.ingestEventsPerSecond = 20;
  level.workload.readPhases = [
    { fromMs: 0, toMs: MEASURED_MS, readsPerSecond: 10 },
  ];
  level.workload.peakWindow = { fromMs: 2_000, toMs: 4_000 };
  level.workload.faultWindow = { fromMs: 3_000, toMs: 5_000 };
  level.workload.topN = STREAMS;
  level.limits.maxEvents = 1_000_000;
  level.limits.maxPreparationMs = 120_000;
  level.calibrationSeeds = [1];
  level.holdoutSeeds = [2];
  catalog.components.app.cpuCoresPerInstance = 1;
  catalog.storage.queryWorkingPairBytes = 8;
  return { level, catalog } as AudienceModel;
}

function tinyProfile(): AudienceChallengeProfile {
  const traffic = {
    readPhases: [{ fromMs: 0, toMs: MEASURED_MS, readsPerSecond: 10 }],
    ingestEventsPerSecond: 20,
    trace: 'same-seed-input' as const,
  };
  return {
    profileVersion: AUDIENCE_PROFILE_VERSION,
    appInstances: 1,
    cases: [
      {
        id: 'normal',
        kind: 'normal',
        label: 'Normal traffic',
        targetInstance: null,
        traffic,
        fault: null,
        criticalWindow: null,
      },
      {
        id: 'peak',
        kind: 'peak',
        label: 'Peak traffic',
        targetInstance: null,
        traffic,
        fault: null,
        criticalWindow: { fromMs: 2_000, toMs: 4_000 },
      },
    ],
    requiredCaseIds: ['normal', 'peak'],
    scoreCaseId: 'peak',
    qualification: 'all-required-cases',
    prehistoryReset: 'identical-per-case',
    costPolicy: 'peak-actual-only',
  };
}

function node(
  kind: AudienceGraph['nodes'][number]['kind'],
  id: string,
  config: Record<string, unknown> = {},
): AudienceGraph['nodes'][number] {
  return {
    id,
    kind,
    label: id,
    position: { x: 0, y: 0 },
    config,
  } as AudienceGraph['nodes'][number];
}

function directGraph(): AudienceGraph {
  return {
    schemaVersion: AUDIENCE_SCHEMA_VERSION,
    levelId: AUDIENCE_LEVEL_ID,
    nodes: [
      node('users', 'users'),
      node('app', 'app', { instances: 1 }),
      node('sql', 'sql', { size: 'small', readPlan: 'query' }),
    ],
    edges: [
      { id: 'users-app', from: 'users', to: 'app' },
      { id: 'app-sql', from: 'app', to: 'sql' },
    ],
  };
}

function makeSession(): AudienceSimulation {
  return new AudienceSimulation(directGraph(), { seed: 7 }, tinyModel(), tinyProfile());
}

function caseById(
  cases: readonly AudienceCaseResult[],
  id: string,
): AudienceCaseResult {
  const found = cases.find((item) => item.id === id);
  if (found === undefined) {
    throw new Error(`missing case ${id}`);
  }
  return found;
}

/** Advance until a predicate holds or the session finishes. */
function advanceUntil(
  session: AudienceSimulation,
  predicate: () => boolean,
  maxSlices = 10_000,
): boolean {
  for (let index = 0; index < maxSlices; index += 1) {
    if (predicate()) {
      return true;
    }
    if (session.done) {
      return false;
    }
    session.advance(5);
  }
  return predicate();
}

describe('live audience telemetry boundary', () => {
  it('exposes real frames and measured time while the first case is running', () => {
    const session = makeSession();
    expect(session.progress().measuredElapsedMs).toBe(0);
    expect(session.frames()).toHaveLength(0);

    const running = advanceUntil(
      session,
      () =>
        !session.done &&
        session.progress().caseId === 'normal' &&
        session.progress().measuredElapsedMs > 0 &&
        session.frames().length > 0,
    );
    expect(running).toBe(true);
    const progress = session.progress();
    expect(progress.phase).toBe('run');
    expect(progress.measuredElapsedMs).toBeGreaterThan(0);
    expect(progress.measuredElapsedMs).toBeLessThanOrEqual(MEASURED_MS);

    const frames = session.frames();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(240);
    expect(frames.every((frame) => frame.scopeId === 'normal')).toBe(true);
    expect(frames.every((frame) => frame.phase === 'measured')).toBe(true);
    expect(frames[0]?.timeMs).toBe(1_000);
    expect(frames.at(-1)?.timeMs).toBeLessThanOrEqual(
      progress.measuredElapsedMs,
    );

    // read-only polling must not advance the simulation or synthesize frames
    const beforeProgress = session.progress();
    const beforeFrames = session.frames().length;
    for (let index = 0; index < 5; index += 1) {
      session.frames();
      session.progress();
    }
    expect(session.progress()).toEqual(beforeProgress);
    expect(session.frames()).toHaveLength(beforeFrames);

    const later = advanceUntil(
      session,
      () => !session.done && session.frames().length > beforeFrames,
      500,
    );
    expect(later).toBe(true);
    expect(session.frames().length).toBeGreaterThan(beforeFrames);
  });

  it('clears the previous scope when the next case starts', () => {
    const session = makeSession();
    let normalFrames = 0;
    const sawNormal = advanceUntil(
      session,
      () => {
        if (!session.done && session.progress().caseId === 'normal') {
          normalFrames = Math.max(normalFrames, session.frames().length);
        }
        return !session.done && session.progress().caseId === 'peak';
      },
    );
    expect(sawNormal).toBe(true);
    expect(normalFrames).toBeGreaterThan(0);
    const frames = session.frames();
    expect(frames.some((frame) => frame.scopeId === 'normal')).toBe(false);
    expect(frames.every((frame) => frame.scopeId === 'peak')).toBe(true);
    expect(session.progress().measuredElapsedMs).toBeGreaterThanOrEqual(0);
    expect(session.progress().measuredElapsedMs).toBeLessThanOrEqual(MEASURED_MS);
  });

  it('retains bounded completed-case frames and supports cancellation', () => {
    const completed = makeSession();
    const result = completed.runToCompletion(5);
    const peak = caseById(result.cases, 'peak');
    expect(peak.trafficFrames.length).toBeGreaterThan(0);
    expect(peak.trafficFrames.length).toBeLessThanOrEqual(240);
    const finalFrames = completed.frames();
    expect(finalFrames.map((frame) => frame.scopeId).every((id) => id === 'peak')).toBe(
      true,
    );
    expect(finalFrames).toHaveLength(peak.trafficFrames.length);

    const cancelled = makeSession();
    const running = advanceUntil(
      cancelled,
      () =>
        !cancelled.done &&
        cancelled.progress().caseId === 'normal' &&
        cancelled.frames().length > 0,
    );
    expect(running).toBe(true);
    cancelled.cancel();
    const cancelledResult = cancelled.result();
    expect(cancelledResult?.status).toBe('cancelled');
    expect(cancelledResult?.passed).toBe(false);
    expect(cancelled.done).toBe(true);
  });

  it('produces the same final result with or without frequent polling', () => {
    const plain = makeSession();
    const plainResult = plain.runToCompletion(5);

    const polled = makeSession();
    let slices = 0;
    while (!polled.done && slices < 100_000) {
      polled.advance(5);
      polled.frames();
      polled.progress();
      slices += 1;
    }
    expect(polled.done).toBe(true);
    expect(polled.result()).toEqual(plainResult);
  });
});
