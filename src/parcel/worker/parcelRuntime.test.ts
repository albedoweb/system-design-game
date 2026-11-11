import { describe, expect, it } from 'vitest';

import type { ParcelEvaluation, ParcelProgress } from '../contracts';
import { createParcelGraph } from '../graph';
import { createParcelWorkerRuntime } from './parcelRuntime';
import {
  isParcelWorkerResponse,
  type ParcelWorkerResponse,
} from './parcel-worker-protocol';

const evaluation: ParcelEvaluation = {
  status: 'invalid',
  passed: false,
  meta: {
    schemaVersion: 1,
    modelVersion: '1.0.0',
    pricingVersion: 'parcel-catalog-v1',
    contentVersion: '1.0.0',
    levelId: 'parcel-pulse',
    seed: 101,
    graphDigest: null,
    requestedHorizons: [1, 5],
    requiredHorizons: [1, 5],
    sampleFactor: 1,
  },
  horizons: [],
  capacity: null,
  cost: null,
  checks: [],
  issues: [],
  diagnostics: [],
  assumptions: [],
};

describe('Parcel worker runtime', () => {
  it('forwards progress and result for the requesting run only', () => {
    const messages: ParcelWorkerResponse[] = [];
    const runtime = createParcelWorkerRuntime(
      (message) => messages.push(message),
      (_input, options) => {
        options?.onProgress?.({
          phase: 'simulate',
          horizonYears: 5,
          completed: 1,
          total: 1,
          message: 'Simulating year 5',
        } satisfies ParcelProgress);
        return evaluation;
      },
    );

    runtime.handleMessage({
      type: 'run',
      runId: 'run-1',
      graph: createParcelGraph(),
      seed: 101,
    });
    expect(messages.map((message) => message.type)).toEqual([
      'progress',
      'result',
    ]);
    expect(messages.every((message) => message.runId === 'run-1')).toBe(true);
  });

  it('forwards observational traffic frames for the requesting run only', () => {
    const messages: ParcelWorkerResponse[] = [];
    const runtime = createParcelWorkerRuntime(
      (message) => messages.push(message),
      (_input, options) => {
        options?.onTraffic?.({
          levelId: 'parcel-pulse',
          scopeId: 'year-1',
          scopeLabel: 'Year 1',
          timeMs: 1000,
          windowMs: 1000,
          phase: 'measured',
          nodes: [],
          edges: [],
        });
        return evaluation;
      },
    );

    runtime.handleMessage({
      type: 'run',
      runId: 'run-traffic',
      graph: createParcelGraph(),
      seed: 101,
    });

    expect(messages.map((message) => message.type)).toEqual([
      'traffic',
      'result',
    ]);
    const frame = messages[0];
    expect(frame?.runId).toBe('run-traffic');
    expect(frame?.type === 'traffic' && frame.frame.scopeId).toBe('year-1');
    expect(isParcelWorkerResponse(messages[0])).toBe(true);
  });

  it('reports an evaluator exception as a bounded run error', () => {
    const messages: ParcelWorkerResponse[] = [];
    const runtime = createParcelWorkerRuntime(
      (message) => messages.push(message),
      () => {
        throw new Error('bounded compute exhausted');
      },
    );
    runtime.handleMessage({
      type: 'run',
      runId: 'run-2',
      graph: createParcelGraph(),
      seed: 211,
    });
    expect(messages).toEqual([
      {
        type: 'error',
        runId: 'run-2',
        message: 'bounded compute exhausted',
      },
    ]);
  });

  it('ignores malformed and unrelated worker messages', () => {
    const messages: ParcelWorkerResponse[] = [];
    const runtime = createParcelWorkerRuntime(
      (message) => messages.push(message),
      () => evaluation,
    );
    runtime.handleMessage({ type: 'stop' });
    runtime.handleMessage({ type: 'run', runId: 'broken' });
    expect(messages).toEqual([]);
  });
});
