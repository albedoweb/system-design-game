import type { CartCaseResult, CartGraph } from '../contracts';
import type { CartCaseModel } from './model';
import { createCartResourcePlan } from './resources';

export const CART_PROBLEM_OUTCOMES = ['rejected', 'unavailable', 'timeout', 'dependency-failed', 'validation-failed'];

/** Read-only snapshot; never advances simulation or evaluates partial SLOs. */
export function observeCartRun(model: CartCaseModel, graph: CartGraph): NonNullable<CartCaseResult['observation']> {
  const launched = model.launchedByOperation;
  const records = model.requestRecords;
  const problems = new Set(CART_PROBLEM_OUTCOMES);
  return {
    elapsedMs: model.observedTimeUs / 1000,
    operations: ['edit', 'read', 'checkout'].map(operation => {
      const rows = records.filter(record => record.operation === operation);
      const successful = rows.filter(record => record.outcome === 'committed' || record.outcome === 'duplicate-commit');
      const errors = rows.filter(record => problems.has(record.outcome)).length;
      const latency = successful.filter(record => record.deliveredUs !== null && record.deliveredUs <= model.observedTimeUs)
        .map(record => Math.max(0, record.deliveredUs! - record.offeredUs) / 1000).sort((a, b) => a - b);
      const percentile = (p: number) => latency.length ? latency[Math.ceil(p * latency.length) - 1]! : null;
      return { operation, launched: launched[operation] ?? 0, completed: rows.length, successful: successful.length,
        business: rows.length - successful.length - errors, errors, timeouts: rows.filter(record => record.outcome === 'timeout').length,
        pending: Math.max(0, (launched[operation] ?? 0) - rows.length), samples: latency.length,
        p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99) };
    }),
    nodes: [...createCartResourcePlan(graph).nodes.values()].map(capacity => {
      const snapshot = model.nodeResources(capacity.nodeId)!;
      const load = model.nodeLoad(capacity.nodeId);
      return { nodeId: capacity.nodeId, cpuMs: snapshot.cpuBusyMs,
        ramBytes: capacity.fixedRamBytes * capacity.instances + snapshot.queueRamBytes + snapshot.indexRamBytes,
        ramCapacityBytes: capacity.ramBytesTotal, pendingTasks: snapshot.pendingTasks,
        transactionQueue: model.waitingTransactions(capacity.nodeId), ioUnits: snapshot.ioUnits,
        storedBytes: snapshot.durableCommittedBytes, storageCapacityBytes: capacity.durableBytesTotal,
        load: { cpuLanes: capacity.cpuLanes * capacity.instances, cpuTasks: load.cpuTasks, cpuBusyMs: load.cpuBusyUs / 1000,
          cpuWaitAvgMs: load.cpuTasks ? load.cpuWaitTotalUs / load.cpuTasks / 1000 : 0, cpuWaitMaxMs: load.cpuWaitMaxUs / 1000,
          cpuRejected: load.cpuRejected, ioTasks: load.ioTasks, ioBusyMs: load.ioBusyUs / 1000,
          ioWaitAvgMs: load.ioTasks ? load.ioWaitTotalUs / load.ioTasks / 1000 : 0, ioWaitMaxMs: load.ioWaitMaxUs / 1000 } };
    }),
    // Per-session client access links are excluded: there are over a thousand and they are never a design choice.
    links: model.linkLoads.flatMap(link => link.kind !== 'wan' && link.kind !== 'nic' ? [] : [{ id: link.id, kind: link.kind, pair: link.pair, direction: link.direction,
      mbps: link.bitsPerSecond / 1_000_000, jobs: link.jobs, busyMs: link.busyUs / 1000,
      waitAvgMs: link.waitTotalUs / link.jobs / 1000, waitMaxMs: link.waitMaxUs / 1000 }]),
  };
}
