/**
 * Public API of the reusable bounded resource kernel.
 *
 * This module has no dependency on the Image Atlas evaluator, the existing
 * parcel/cold-cache engines, React or the backend. It is a pure TypeScript
 * discrete-event layer that an evaluator can compose with caller-owned work
 * stages.
 */

export { EventScheduler } from './scheduler';
export type {
  ScheduledHandle,
  SchedulerRunResult,
} from './scheduler';

export { ResourceKernel } from './kernel';
export type {
  ResourceInfo,
  ResourceKernelOptions,
  ResourceKernelStats,
  ResourceRequirement,
  ResourceStats,
  SubmitTaskRequest,
  TaskFinishReason,
  TaskHandle,
  TaskResult,
  TaskTerminalStatus,
} from './kernel';

export { MemoryLedger } from './memory';

export { NodeQueueDepthMeter } from './queue-metrics';

export { ByteLruCache } from './cache';
export type { ByteCacheEntry } from './cache';

export {
  buildNetworkTransferDemand,
  accountTransferBytes,
  networkLanesForBandwidth,
  NETWORK_LANE_BITS_PER_MS,
  NETWORK_LANE_BITS_PER_SECOND,
} from './network';
export type {
  NetworkTransferDemand,
  NetworkTransferInput,
  TransferByteAccounting,
} from './network';
