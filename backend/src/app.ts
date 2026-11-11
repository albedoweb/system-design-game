import { randomUUID } from 'node:crypto';

import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import {
  ERROR_CODES,
  LIMITS,
  type CreateAppOptions,
  type Engine,
} from './contracts.js';
import { DiscoveryCache } from './http/discovery.js';
import { mapHttpError, sendError } from './http/errors.js';
import { registerRoutes } from './http/routes.js';
import { JobQueue } from './jobs/queue.js';

type LoggerSetting = Exclude<FastifyServerOptions['logger'], undefined>;

interface ResolvedOptions {
  readonly engine: Engine;
  readonly logger: LoggerSetting;
  readonly maxConcurrent: number;
  readonly maxQueue: number;
  readonly maxRegistry: number;
  readonly jobTtlMs: number;
  readonly runTimeoutMs: number;
  readonly sweepIntervalMs: number;
  readonly closeDrainMs: number;
  readonly bodyLimit: number;
  readonly corsOrigin: string | null;
  readonly isReady: () => boolean;
  readonly now: () => number;
  readonly generateId: () => string;
}

interface Bounds {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

function boundedInteger(name: string, value: number | undefined, bounds: Bounds): number {
  const resolved = value ?? bounds.default;
  if (
    !Number.isInteger(resolved) ||
    resolved < bounds.min ||
    resolved > bounds.max
  ) {
    throw new RangeError(
      `${name} must be an integer between ${bounds.min} and ${bounds.max}.`,
    );
  }
  return resolved;
}

function validateOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new RangeError('corsOrigin must be an absolute http(s) origin.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RangeError('corsOrigin must use http or https.');
  }
  if (url.origin !== origin) {
    throw new RangeError(
      'corsOrigin must be an exact origin without a path, query or trailing slash.',
    );
  }
  return url.origin;
}

function assertOptionalFunction(name: string, value: unknown): void {
  if (value !== undefined && typeof value !== 'function') {
    throw new TypeError(`${name} must be a function.`);
  }
}

function assertEngine(engine: Engine): void {
  if (typeof engine !== 'object' || engine === null) {
    throw new TypeError('engine must be an object.');
  }
  for (const method of [
    'levels',
    'describe',
    'components',
    'schema',
    'evaluate',
  ] as const) {
    if (typeof engine[method] !== 'function') {
      throw new TypeError(`engine.${method} must be a function.`);
    }
  }
}

function resolveOptions(options: CreateAppOptions): ResolvedOptions {
  assertEngine(options.engine);

  const maxConcurrent = boundedInteger(
    'maxConcurrent',
    options.maxConcurrent,
    LIMITS.maxConcurrent,
  );
  const maxQueue = boundedInteger('maxQueue', options.maxQueue, LIMITS.maxQueue);
  const maxRegistry = boundedInteger(
    'maxRegistry',
    options.maxRegistry,
    LIMITS.maxRegistry,
  );
  if (maxRegistry < maxConcurrent + maxQueue) {
    throw new RangeError(
      'maxRegistry must be at least maxConcurrent + maxQueue.',
    );
  }
  if (options.corsOrigin !== undefined && options.corsOrigin.length === 0) {
    throw new RangeError('corsOrigin must not be empty.');
  }
  assertOptionalFunction('isReady', options.isReady);
  assertOptionalFunction('now', options.now);
  assertOptionalFunction('generateId', options.generateId);

  return {
    engine: options.engine,
    logger: options.logger ?? false,
    maxConcurrent,
    maxQueue,
    maxRegistry,
    jobTtlMs: boundedInteger('jobTtlMs', options.jobTtlMs, LIMITS.jobTtlMs),
    runTimeoutMs: boundedInteger(
      'runTimeoutMs',
      options.runTimeoutMs,
      LIMITS.runTimeoutMs,
    ),
    sweepIntervalMs: boundedInteger(
      'sweepIntervalMs',
      options.sweepIntervalMs,
      LIMITS.sweepIntervalMs,
    ),
    closeDrainMs: boundedInteger(
      'closeDrainMs',
      options.closeDrainMs,
      LIMITS.closeDrainMs,
    ),
    bodyLimit: boundedInteger('bodyLimit', options.bodyLimit, {
      default: LIMITS.bodyLimit,
      min: 1024,
      max: LIMITS.bodyLimit,
    }),
    corsOrigin:
      options.corsOrigin === undefined ? null : validateOrigin(options.corsOrigin),
    isReady: options.isReady ?? (() => true),
    now: options.now ?? Date.now,
    generateId: options.generateId ?? randomUUID,
  };
}

/**
 * Build the Fastify app around an injected engine. This function does not
 * bind, listen, install process signal handlers or close the engine; P206 owns
 * those responsibilities in `src/main.ts`.
 */
export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const config = resolveOptions(options);
  const app = Fastify({
    logger: config.logger,
    bodyLimit: config.bodyLimit,
    // Leave prototype-looking keys for inspectGraph, which rejects them with
    // a controlled 422 instead of a parser-specific error shape.
    onProtoPoisoning: 'ignore',
    onConstructorPoisoning: 'ignore',
    ajv: {
      customOptions: {
        coerceTypes: false,
        useDefaults: false,
        removeAdditional: false,
        allErrors: true,
      },
    },
  });

  if (config.corsOrigin !== null) {
    const allowed = config.corsOrigin;
    app.addHook('onRequest', async (request, reply) => {
      reply.header('Vary', 'Origin');
      const origin = request.headers.origin;
      if (origin !== allowed) {
        return;
      }
      reply.header('Access-Control-Allow-Origin', allowed);
      if (request.method === 'OPTIONS') {
        reply.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'content-type');
        reply.header('Access-Control-Max-Age', '600');
        return reply.code(204).send();
      }
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const mapped = mapHttpError(error);
    if (mapped.status >= 500) {
      request.log.error({ statusCode: mapped.status }, 'request failed');
    }
    if (reply.sent) {
      return;
    }
    return sendError(
      reply,
      mapped.status,
      mapped.code,
      mapped.message,
      mapped.details,
    );
  });

  app.setNotFoundHandler((_request, reply) =>
    sendError(reply, 404, ERROR_CODES.routeNotFound, 'Route not found.'),
  );

  const jobs = new JobQueue({
    engine: config.engine,
    maxConcurrent: config.maxConcurrent,
    maxQueue: config.maxQueue,
    maxRegistry: config.maxRegistry,
    jobTtlMs: config.jobTtlMs,
    runTimeoutMs: config.runTimeoutMs,
    sweepIntervalMs: config.sweepIntervalMs,
    closeDrainMs: config.closeDrainMs,
    now: config.now,
    generateId: config.generateId,
  });

  registerRoutes(app, {
    discovery: new DiscoveryCache(config.engine),
    jobs,
    isReady: config.isReady,
  });

  app.addHook('onClose', async () => {
    await jobs.close();
  });

  return app;
}
