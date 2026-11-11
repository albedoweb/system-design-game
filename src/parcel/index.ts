/**
 * Frozen public API for the Parcel Pulse level (P200).
 *
 * Browser worker, React UI and the agent CLI import only from this module.
 * The model is pure TypeScript: no React, DOM or Node imports. The same
 * parse/validate/evaluate functions run in the browser and in Node.
 */
export * from './contracts';
export * from './catalog';
export * from './level';
export * from './graph';
export * from './capacity';
export * from './evaluate';
export * from './schema';
export { generateParcelTrace, type ParcelTrace } from './workload';
