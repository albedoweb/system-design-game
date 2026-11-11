/**
 * Frozen public API for the Global Cart level (cart-protocol-v1 B1).
 *
 * Browser worker/UI, agent CLI/API, persistence and tests import only from this
 * module. GC-003 owns these schemas, the catalog, the starter graph, semantic
 * validation and the digest.
 *
 * GC-011 adds the real `createCartSession`/`evaluateCart` driver from
 * `./session`; the export is the executed implementation, never a stub.
 *
 * GC-012 adds the bounded traffic-telemetry payload types, the causal
 * diagnostics API and deterministic trace regeneration. Only detached data
 * shapes and pure graph/case helpers are exported: the mutable model and the
 * live observation handle stay internal to the session.
 */
export * from './contracts';
export * from './catalog';
export * from './graph';
export * from './level';
export { createCartSession, evaluateCart, type CartEvaluatorOptions } from './session';

export type {
  CartTrafficClass,
  CartTrafficPhase,
  CartTrafficBytes,
  CartNodeTraffic,
  CartLinkTraffic,
  CartCircuitTraffic,
  CartTrafficFrame,
  CartTelemetryTotals,
  CartTelemetryFrames,
  CartTraceEvent,
  CartTraceDetail,
  CartCaseTelemetry,
  CartTelemetryObserver,
  CartTelemetryOptions,
  CartTelemetryCapture,
} from './core/telemetry';
export {
  captureCartTelemetry,
  reconcileCartTelemetry,
  regenerateCartTrace,
} from './core/telemetry';

export type {
  CartDiagnosticKind,
  CartDiagnosticOperation,
  CartDiagnosticLocations,
  CartDiagnostic,
  CartDiagnosticInput,
} from './core/diagnostics';
export {
  buildCartDiagnostics,
  diagnoseCartGate,
  diagnoseTopologyIssues,
  summarizeCartTrafficHealth,
} from './core/diagnostics';
