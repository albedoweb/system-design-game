import type { FastifyReply } from 'fastify';

import {
  EngineError,
  ERROR_CODES,
  type ErrorDetail,
  type ErrorEnvelope,
  type JobFailure,
} from '../contracts.js';

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_MESSAGE_MAX = 500;
const MAX_DETAILS = 10;

export interface MappedHttpError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: readonly ErrorDetail[];
}

export function errorEnvelope(
  code: string,
  message: string,
  details?: readonly ErrorDetail[],
): ErrorEnvelope {
  const error: { code: string; message: string; details?: readonly ErrorDetail[] } = {
    code,
    message,
  };
  if (details !== undefined && details.length > 0) {
    error.details = details;
  }
  return { error };
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: readonly ErrorDetail[],
): FastifyReply {
  return reply.code(status).send(errorEnvelope(code, message, details));
}

export function sanitizeCode(
  value: unknown,
  fallback: string = ERROR_CODES.internalError,
): string {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : fallback;
}

export function sanitizeMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length === 0 ? fallback : collapsed.slice(0, SAFE_MESSAGE_MAX);
}

function safePath(value: string): string {
  // eslint-disable-next-line no-control-regex -- Remove untrusted control characters from diagnostic paths.
  const collapsed = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (collapsed.length === 0) {
    return '/';
  }
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}...` : collapsed;
}

function validationDetails(
  validation: readonly {
    instancePath?: string;
    message?: string;
    params?: Record<string, unknown>;
  }[],
): ErrorDetail[] {
  return validation.slice(0, MAX_DETAILS).map((item) => {
    let path = item.instancePath ?? '';
    const params = item.params;
    const missing =
      params !== undefined && typeof params.missingProperty === 'string'
        ? params.missingProperty
        : null;
    const additional =
      params !== undefined && typeof params.additionalProperty === 'string'
        ? params.additionalProperty
        : null;
    if (missing !== null) {
      path = `${path}/${missing}`;
    } else if (additional !== null) {
      path = `${path}/${additional}`;
    }
    return {
      path: safePath(
        path.length === 0 ? '/' : path.startsWith('/') ? path : `/${path}`,
      ),
      message: sanitizeMessage(item.message, 'is invalid'),
    };
  });
}

interface FastifyLikeError extends Error {
  readonly code?: unknown;
  readonly statusCode?: unknown;
  readonly validation?: readonly {
    instancePath?: string;
    message?: string;
    params?: Record<string, unknown>;
  }[];
}

function isFastifyLikeError(error: unknown): error is FastifyLikeError {
  return error instanceof Error;
}

function fastifyErrorCode(error: FastifyLikeError): string | null {
  return typeof error.code === 'string' ? error.code : null;
}

export function mapHttpError(error: unknown): MappedHttpError {
  if (error instanceof EngineError) {
    const status =
      error.httpStatus !== undefined &&
      [400, 404, 409, 422, 429, 503].includes(error.httpStatus)
        ? error.httpStatus
        : 503;
    return {
      status,
      code: sanitizeCode(error.code, ERROR_CODES.engineUnavailable),
      message: sanitizeMessage(
        error.message,
        'The simulation engine is unavailable.',
      ),
    };
  }

  if (!isFastifyLikeError(error)) {
    return {
      status: 500,
      code: ERROR_CODES.internalError,
      message: 'The request could not be completed.',
    };
  }

  if (Array.isArray(error.validation) && error.validation.length > 0) {
    return {
      status: 400,
      code: ERROR_CODES.invalidRequest,
      message: 'Request validation failed.',
      details: validationDetails(error.validation),
    };
  }

  switch (fastifyErrorCode(error)) {
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return {
        status: 400,
        code: ERROR_CODES.invalidJson,
        message: 'The request body must be valid JSON.',
      };
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return {
        status: 413,
        code: ERROR_CODES.payloadTooLarge,
        message: 'The request body exceeds the 1 MiB limit.',
      };
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
    case 'FST_ERR_CTP_INVALID_CONTENT_TYPE':
      return {
        status: 415,
        code: ERROR_CODES.unsupportedMediaType,
        message: 'Use application/json for this request.',
      };
    case 'FST_ERR_BAD_URL':
      return {
        status: 400,
        code: ERROR_CODES.invalidRequest,
        message: 'The request URL is invalid.',
      };
    default:
      break;
  }

  const status = typeof error.statusCode === 'number' ? error.statusCode : null;
  if (status === 413) {
    return {
      status: 413,
      code: ERROR_CODES.payloadTooLarge,
      message: 'The request body exceeds the 1 MiB limit.',
    };
  }
  if (status === 415) {
    return {
      status: 415,
      code: ERROR_CODES.unsupportedMediaType,
      message: 'Use application/json for this request.',
    };
  }

  return {
    status: 500,
    code: ERROR_CODES.internalError,
    message: 'The request could not be completed.',
  };
}

/** Safe failure payload stored on a failed job. Never contains a stack. */
export function safeEngineFailure(error: unknown): JobFailure {
  if (error instanceof EngineError) {
    return {
      code: sanitizeCode(error.code, ERROR_CODES.engineFailure),
      message: sanitizeMessage(
        error.message,
        'The evaluation failed unexpectedly.',
      ),
    };
  }
  return {
    code: ERROR_CODES.engineFailure,
    message: 'The evaluation failed unexpectedly.',
  };
}
