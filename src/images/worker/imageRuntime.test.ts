import { describe, expect, it, vi } from 'vitest';

import type { ImageEvaluation, ImageProgress } from '../contracts';
import { createImageWorkerRuntime, type ImageEvaluator } from './imageRuntime';
import {
  isImageWorkerResponse,
  type ImageWorkerResponse,
} from './image-worker-protocol';

const invalidEvaluation = {
  status: 'invalid',
  passed: false,
  meta: {
    schemaVersion: 1,
    modelVersion: '1.0.0',
    contentVersion: '1.0.0',
    pricingVersion: 'image-atlas-catalog-v1',
    levelId: 'image-atlas',
    seed: 101,
    graphDigest: null,
    requestedScenarios: ['normal'],
    requiredScenarios: [
      'normal',
      'peak',
      'node-failure',
      'link-failure',
      'region-na-failure',
      'region-eu-failure',
      'region-ap-failure',
    ],
    qualification: false,
    evaluationKind: 'exploratory',
    datasetDay: 30,
  },
  issues: [],
  diagnostics: [],
  checks: [],
  capacity: null,
  cost: null,
  assumptions: [],
  scenarios: [],
} as unknown as ImageEvaluation;

function collect() {
  const messages: ImageWorkerResponse[] = [];
  return {
    messages,
    post: (message: ImageWorkerResponse) => messages.push(message),
  };
}

const progress: ImageProgress = {
  phase: 'simulate',
  scenario: 'peak',
  completed: 2,
  total: 7,
  message: 'Simulating peak',
};

const graph = { nodes: [], edges: [] };

describe('Image Atlas worker runtime', () => {
  it('forwards evaluator progress with the scenario name and posts the result', () => {
    const sink = collect();
    const evaluator: ImageEvaluator = vi.fn((_input, options) => {
      options.onProgress?.(progress);
      return invalidEvaluation;
    });
    const runtime = createImageWorkerRuntime(sink.post, evaluator);

    runtime.handleMessage({
      type: 'run',
      runId: 'run-1',
      graph,
      seed: 101,
    });

    expect(evaluator).toHaveBeenCalledWith(graph, expect.objectContaining({ seed: 101 }));
    expect(sink.messages).toEqual([
      { type: 'progress', runId: 'run-1', progress },
      { type: 'result', runId: 'run-1', evaluation: invalidEvaluation },
    ]);
  });

  it('forwards observational traffic frames with the scenario scope', () => {
    const sink = collect();
    const evaluator: ImageEvaluator = vi.fn((_input, options) => {
      options.onTraffic?.({
        levelId: 'image-atlas',
        scopeId: 'normal',
        scopeLabel: 'Normal daily average',
        timeMs: 1000,
        windowMs: 1000,
        phase: 'measured',
        nodes: [],
        edges: [],
      });
      return invalidEvaluation;
    });
    const runtime = createImageWorkerRuntime(sink.post, evaluator);

    runtime.handleMessage({
      type: 'run',
      runId: 'run-traffic',
      graph,
      seed: 101,
    });

    expect(sink.messages.map((message) => message.type)).toEqual([
      'traffic',
      'result',
    ]);
    const frame = sink.messages[0];
    expect(frame?.runId).toBe('run-traffic');
    expect(frame?.type === 'traffic' && frame.frame.scopeId).toBe('normal');
    expect(isImageWorkerResponse(sink.messages[0])).toBe(true);
  });

  it('ignores malformed requests instead of starting an unspecified run', () => {
    const sink = collect();
    const evaluator = vi.fn(() => invalidEvaluation);
    const runtime = createImageWorkerRuntime(sink.post, evaluator);

    runtime.handleMessage(null);
    runtime.handleMessage({ type: 'run', runId: '', graph, seed: 101 });
    runtime.handleMessage({ type: 'run', runId: 'x', graph, seed: -1 });
    runtime.handleMessage({ type: 'run', runId: 'x', graph, seed: 1.5 });
    runtime.handleMessage({ type: 'run', runId: 'x', graph: null, seed: 101 });
    runtime.handleMessage({ type: 'other', runId: 'x', graph, seed: 101 });

    expect(evaluator).not.toHaveBeenCalled();
    expect(sink.messages).toEqual([]);
  });

  it('reports an engine failure as an error message for the same run id', () => {
    const sink = collect();
    const runtime = createImageWorkerRuntime(sink.post, () => {
      throw new Error('kernel exploded');
    });
    runtime.handleMessage({ type: 'run', runId: 'run-9', graph, seed: 211 });
    expect(sink.messages).toEqual([
      { type: 'error', runId: 'run-9', message: 'kernel exploded' },
    ]);
  });

  it('describes a non-error throw without inventing a cause', () => {
    const sink = collect();
    const runtime = createImageWorkerRuntime(sink.post, () => {
      throw 'nope';
    });
    runtime.handleMessage({ type: 'run', runId: 'run-10', graph, seed: 211 });
    expect(sink.messages[0]).toEqual({
      type: 'error',
      runId: 'run-10',
      message: 'The Image Atlas engine failed without a message.',
    });
  });
});
