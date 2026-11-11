import { LIMITS, MAX_SEED, MIN_SEED } from '../contracts.js';

export const levelIdSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: LIMITS.levelIdPattern,
} as const;

export const jobIdSchema = {
  type: 'string',
  minLength: 8,
  maxLength: 64,
  pattern: LIMITS.jobIdPattern,
} as const;

export const levelParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: levelIdSchema,
  },
};

export const jobParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: jobIdSchema,
  },
};

/**
 * Top-level submission fields are closed. Graph internals stay open because
 * the level graph schema, owned by the engine, is authoritative there.
 */
export const evaluationBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['levelId', 'graph'],
  properties: {
    levelId: levelIdSchema,
    graph: {
      type: 'object',
      additionalProperties: true,
    },
    seed: {
      type: 'integer',
      minimum: MIN_SEED,
      maximum: MAX_SEED,
    },
  },
};
