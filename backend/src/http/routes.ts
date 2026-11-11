import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  DEFAULT_SEED,
  ERROR_CODES,
  type JobSnapshot,
} from '../contracts.js';
import {
  JobQueue,
  JobQueueClosedError,
  JobQueueFullError,
} from '../jobs/queue.js';
import type { DiscoveryCache } from './discovery.js';
import { sendError } from './errors.js';
import { inspectGraph } from './graph.js';
import {
  evaluationBodySchema,
  jobParamsSchema,
  levelParamsSchema,
} from './schemas.js';

export interface RouteContext {
  readonly discovery: DiscoveryCache;
  readonly jobs: JobQueue;
  readonly isReady: () => boolean;
}

interface LevelParams {
  readonly id: string;
}

interface JobParams {
  readonly id: string;
}

interface EvaluationBody {
  readonly levelId: string;
  readonly graph: unknown;
  readonly seed?: number;
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('Cache-Control', 'no-store');
}

function isJsonContentType(value: string | undefined): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  return value.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

export function registerRoutes(app: FastifyInstance, context: RouteContext): void {
  app.get('/healthz', async (_request, reply) => {
    let ready: boolean;
    try {
      ready = context.isReady();
    } catch {
      ready = false;
    }
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? 'ok' : 'unavailable', ready });
  });

  app.get('/v1/levels', async (_request, reply) => {
    const levels = await context.discovery.levels();
    return noStore(reply).send({ levels });
  });

  app.get<{ Params: LevelParams }>(
    '/v1/levels/:id',
    { schema: { params: levelParamsSchema } },
    async (request, reply) => {
      await context.discovery.requireLevel(request.params.id);
      return noStore(reply).send(await context.discovery.describe(request.params.id));
    },
  );

  app.get<{ Params: LevelParams }>(
    '/v1/levels/:id/components',
    { schema: { params: levelParamsSchema } },
    async (request, reply) => {
      await context.discovery.requireLevel(request.params.id);
      return noStore(reply).send(
        await context.discovery.components(request.params.id),
      );
    },
  );

  app.get<{ Params: LevelParams }>(
    '/v1/levels/:id/schema',
    { schema: { params: levelParamsSchema } },
    async (request, reply) => {
      await context.discovery.requireLevel(request.params.id);
      return noStore(reply).send(await context.discovery.schema(request.params.id));
    },
  );

  app.post<{ Body: EvaluationBody }>(
    '/v1/evaluations',
    {
      schema: { body: evaluationBodySchema },
      preValidation: async (request, reply) => {
        if (!isJsonContentType(request.headers['content-type'])) {
          return sendError(
            reply,
            415,
            ERROR_CODES.unsupportedMediaType,
            'Use application/json for this request.',
          );
        }
      },
    },
    async (request, reply) => {
      const body = request.body;
      await context.discovery.requireLevel(body.levelId);

      const graphIssue = inspectGraph(body.graph);
      if (graphIssue !== null) {
        return sendError(
          reply,
          422,
          ERROR_CODES.graphInvalid,
          graphIssue.message,
          [{ path: graphIssue.path, message: graphIssue.message }],
        );
      }

      const seed = body.seed ?? DEFAULT_SEED;
      let job: JobSnapshot;
      try {
        job = context.jobs.submit({
          levelId: body.levelId,
          graph: body.graph,
          seed,
        });
      } catch (error) {
        if (error instanceof JobQueueFullError) {
          reply.header('Retry-After', '1');
          return sendError(reply, 429, error.code, error.message);
        }
        if (error instanceof JobQueueClosedError) {
          return sendError(
            reply,
            503,
            ERROR_CODES.serviceUnavailable,
            error.message,
          );
        }
        throw error;
      }

      return noStore(reply)
        .code(202)
        .header('Location', job.links.self)
        .send(job);
    },
  );

  app.get<{ Params: JobParams }>(
    '/v1/evaluations/:id',
    { schema: { params: jobParamsSchema } },
    async (request, reply) => {
      const job = context.jobs.get(request.params.id);
      if (job === null) {
        return sendError(reply, 404, ERROR_CODES.jobNotFound, 'Job not found.');
      }
      return noStore(reply).send(job);
    },
  );

  app.delete<{ Params: JobParams }>(
    '/v1/evaluations/:id',
    { schema: { params: jobParamsSchema } },
    async (request, reply) => {
      const job = context.jobs.cancel(request.params.id);
      if (job === null) {
        return sendError(reply, 404, ERROR_CODES.jobNotFound, 'Job not found.');
      }
      return noStore(reply).send(job);
    },
  );
}
