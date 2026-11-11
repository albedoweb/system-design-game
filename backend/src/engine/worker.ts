/**
 * Trusted simulation worker entry.
 *
 * It dispatches through the shared five-level registry, so the backend uses
 * exactly the same parsers, evaluators and result bodies as the browser/CLI.
 * The only input is structured-clone `workerData`; there is no dynamic import,
 * eval, file path or caller-supplied level definition.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { getHeapStatistics } from 'node:v8';

import {
  createEngineRegistry,
  type EngineEvaluationResult,
} from '../../../src/simulation/registry.js';
import { EngineLevelError } from '../../../src/simulation/contracts.js';

import {
  isRecord,
  type WorkerMessage,
  type WorkerRequest,
  type WorkerRunStats,
} from './protocol.js';

const port = parentPort;
const registry = createEngineRegistry();

function post(message: WorkerMessage): void {
  port?.postMessage(message);
}

function stats(startedAt: number): WorkerRunStats {
  const memory = process.memoryUsage();
  return {
    elapsedMs: performance.now() - startedAt,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    heapSizeLimitBytes: getHeapStatistics().heap_size_limit,
    externalBytes: memory.external,
  };
}

function request(value: unknown): WorkerRequest {
  if (
    !isRecord(value) ||
    typeof value.levelId !== 'string' ||
    typeof value.seed !== 'number' ||
    !Number.isInteger(value.seed)
  ) {
    throw new Error('invalid_worker_request');
  }
  const entry = registry.resolve(value.levelId);
  if (entry === null) {
    throw new Error('invalid_worker_request');
  }
  const { min, max } = entry.descriptor.seed;
  if (value.seed < min || value.seed > max) {
    throw new Error('invalid_worker_request');
  }
  return { levelId: value.levelId, graph: value.graph, seed: value.seed };
}

function evaluate(input: WorkerRequest): EngineEvaluationResult {
  return registry.evaluate({
    levelId: input.levelId,
    graph: input.graph,
    seed: input.seed,
    // The API always requests full qualification: no horizon or scenario
    // override enters through the trusted worker protocol.
    onProgress: (progress) => {
      post({ type: 'progress', progress });
    },
  });
}

function run(): void {
  const startedAt = performance.now();
  try {
    const input = request(workerData);
    const outcome = evaluate(input);
    post({
      type: 'result',
      result: outcome.result,
      stats: stats(startedAt),
    });
  } catch (error) {
    const code =
      error instanceof EngineLevelError ? error.code : 'engine_failure';
    post({
      type: 'error',
      error: {
        code,
        message:
          error instanceof EngineLevelError
            ? error.message
            : 'The simulation worker failed.',
      },
    });
  }
}

run();
