/**
 * Frozen public API for Live Audience.
 *
 * Browser worker/UI (A102), agent CLI/API (A103) and tests import only from
 * this module. Contracts, catalog, level and graph helpers are re-exported from
 * their owning modules; the evaluator and session are the real core added by
 * A101.
 */
export * from './contracts';
export * from './catalog';
export * from './level';
export * from './graph';
export { evaluateAudience, createAudienceSession } from './session';
