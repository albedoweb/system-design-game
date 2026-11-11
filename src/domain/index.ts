/**
 * Public domain contract for the playable “Cold Cache” level.
 *
 * Consumers (engine V101, UI V102) import only from `src/domain`:
 * graph/level parsing and validation, catalog and cost calculation, starter
 * graph, simulation wire types, worker protocol and the engine interface.
 * Everything exported here is frozen between V100 and engine/UI development;
 * changes require a coordinator decision.
 */
export * from './catalog';
export * from './errors';
export * from './graph';
export * from './level';
export * from './limits';
export * from './simulation';
export * from './worker';
