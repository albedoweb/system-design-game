/**
 * Hard bounds applied at the UI/JSON boundary. Keeping them in one module lets
 * the UI show the same limits it enforces without importing the parsers.
 *
 * Workload caps are intentionally not input-byte limits: `level.ts` validates
 * the expected Poisson workload, while the engine enforces the realized-arrival
 * cap at runtime (see `MAX_ARRIVALS`).
 */

/** Imports/saves larger than 1 MiB are rejected before JSON parsing. */
export const MAX_INPUT_BYTES = 1024 * 1024;

export const MAX_GRAPH_NODES = 16;
export const MAX_GRAPH_EDGES = 24;
export const MAX_ID_LENGTH = 64;
export const MAX_LABEL_LENGTH = 80;
export const MAX_COORDINATE = 10_000;

export const MIN_QUEUE_LIMIT = 0;
export const MAX_QUEUE_LIMIT = 512;
export const MIN_POOL_SIZE = 1;
export const MAX_POOL_SIZE = 64;
export const MIN_TTL_SECONDS = 15;
export const MAX_TTL_SECONDS = 300;

/** Node/edge ids are safe for URLs, JSON and DOM keys. */
export const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
