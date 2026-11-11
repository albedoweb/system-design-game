/**
 * Runnable local API entry point.
 *
 * Binds loopback by default, injects the real Worker-backed Parcel Pulse
 * engine into the frozen P205 app, and owns process signals and worker
 * termination. It never publishes, authenticates or exposes a tournament.
 */

import { isIP } from 'node:net';

import type { FastifyInstance } from 'fastify';

import { createApp } from './app.js';
import { LIMITS } from './contracts.js';
import { createWorkerEngine } from './engine/index.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;
const LOG_LEVELS = new Set([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

function configError(name: string, message: string): Error {
  return new Error(`${name} ${message}`);
}

function readHost(value: string | undefined): string {
  const host = (value ?? DEFAULT_HOST).trim();
  if (host.length === 0) {
    throw configError('HOST', 'must not be empty.');
  }
  if (host.length > 253 || /[\s/\\?#@[\]]/.test(host) || host.includes('://')) {
    throw configError('HOST', 'must be a hostname or IP address.');
  }
  if (host.includes(':')) {
    if (isIP(host) !== 6) {
      throw configError('HOST', 'must be a valid IPv6 address.');
    }
    return host;
  }
  if (isIP(host) === 4) {
    return host;
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) {
    throw configError('HOST', 'must be a hostname or IP address.');
  }
  return host;
}

function readPort(value: string | undefined): number {
  const raw = (value ?? String(DEFAULT_PORT)).trim();
  if (!/^\d{1,5}$/.test(raw)) {
    throw configError('PORT', 'must be an integer in 0..65535.');
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw configError('PORT', 'must be an integer in 0..65535.');
  }
  return port;
}

function readLogLevel(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    return 'info';
  }
  const level = value.trim().toLowerCase();
  if (!LOG_LEVELS.has(level)) {
    throw configError(
      'LOG_LEVEL',
      `must be one of ${[...LOG_LEVELS].join(', ')}.`,
    );
  }
  return level;
}

function isLoopback(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '127.0.0.1' ||
    host.startsWith('127.')
  );
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error.';
  return message.replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function start(): Promise<void> {
  const host = readHost(process.env.HOST);
  const port = readPort(process.env.PORT);
  const logLevel = readLogLevel(process.env.LOG_LEVEL);
  const isTypeScript = import.meta.url.endsWith('.ts');
  const workerEntry = new URL(
    isTypeScript ? './engine/worker.ts' : './engine/worker.js',
    import.meta.url,
  );

  const engine = createWorkerEngine({ workerEntry });
  engine.assertReady();

  let app: FastifyInstance | null = null;
  try {
    app = await createApp({
      engine,
      logger: { level: logLevel },
      isReady: () => engine.ready(),
      // P205 defaults are the initial resource budget: one worker, a bounded
      // queue/registry, a 1 MiB body and a 60 s run timeout.
      maxConcurrent: LIMITS.maxConcurrent.default,
      maxQueue: LIMITS.maxQueue.default,
      maxRegistry: LIMITS.maxRegistry.default,
      jobTtlMs: LIMITS.jobTtlMs.default,
      runTimeoutMs: LIMITS.runTimeoutMs.default,
      sweepIntervalMs: LIMITS.sweepIntervalMs.default,
      closeDrainMs: LIMITS.closeDrainMs.default,
      bodyLimit: LIMITS.bodyLimit,
    });
    const address = await app.listen({ host, port });
    console.log(`PARCEL_API_LISTENING ${address}`);
    if (!isLoopback(host)) {
      console.warn(
        `PARCEL_API_WARNING binding to ${host}; this API has no authentication.`,
      );
    }
  } catch (error) {
    await engine.close().catch(() => undefined);
    throw error;
  }

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      process.exit(1);
    }
    stopping = true;
    console.log(`PARCEL_API_STOPPING ${signal}`);
    try {
      await app.close();
      await engine.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

start().catch((error: unknown) => {
  console.error(`PARCEL_API_STARTUP_FAILED ${safeMessage(error)}`);
  process.exitCode = 1;
});
