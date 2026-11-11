/**
 * Frozen public API for Image Atlas (I100 contracts) plus the I101 evaluator.
 *
 * Browser worker/UI (I104), agent CLI/API (I103) and tests import only from
 * this module. Contracts, catalog, level, graph and capacity stay frozen; I101
 * adds the executable evaluator and its disclosed work model.
 */
export * from './contracts';
export * from './catalog';
export * from './level';
export * from './graph';
export * from './capacity';
export { evaluateImages } from './evaluate';
export { IMAGE_WORK_MODEL } from './model';
