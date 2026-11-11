import { microUsdToUsd } from '../domain/catalog';
import type { LevelDefinition } from '../domain/level';
import type { Diagnostic, SloCheck } from '../domain/simulation';
import { ClassMetrics, nearestRank } from './metrics';

function availabilityCheck(
  id: string,
  label: string,
  metrics: ClassMetrics,
  targetFraction: number,
  critical = false,
): SloCheck {
  const offered = critical ? metrics.criticalOffered : metrics.offered;
  const succeeded = critical ? metrics.criticalSucceeded : metrics.succeeded;
  const actual = offered === 0 ? null : (succeeded / offered) * 100;
  const target = Math.round(targetFraction * 100 * 1000) / 1000;
  return {
    id,
    label,
    actual,
    target,
    unit: '%',
    passed: actual !== null && actual + 1e-9 >= target,
  };
}

function percentileCheck(
  id: string,
  label: string,
  actual: number | null,
  target: number,
): SloCheck {
  return {
    id,
    label,
    actual,
    target,
    unit: 'ms',
    passed: actual !== null && actual <= target + 1e-9,
  };
}

/** All SLO gates, evaluated over successful scored traffic only. */
export function buildChecks(
  level: LevelDefinition,
  reads: ClassMetrics,
  writes: ClassMetrics,
  costMicroUsdPerHour: number,
): SloCheck[] {
  const slo = level.slo;
  const budget = level.budgetMicroUsdPerHour;
  return [
    availabilityCheck('read-availability', 'Read availability', reads, slo.availability),
    availabilityCheck(
      'write-availability',
      'Write availability',
      writes,
      slo.availability,
    ),
    percentileCheck(
      'read-p95',
      'Read p95',
      nearestRank(reads.latencies, 95),
      slo.readP95Ms,
    ),
    percentileCheck(
      'write-p95',
      'Write p95',
      nearestRank(writes.latencies, 95),
      slo.writeP95Ms,
    ),
    availabilityCheck(
      'critical-read-availability',
      'Read availability in the critical window',
      reads,
      slo.criticalAvailability,
      true,
    ),
    availabilityCheck(
      'critical-write-availability',
      'Write availability in the critical window',
      writes,
      slo.criticalAvailability,
      true,
    ),
    percentileCheck(
      'critical-read-p95',
      'Read p95 in the critical window',
      nearestRank(reads.criticalLatencies, 95),
      slo.criticalReadP95Ms,
    ),
    percentileCheck(
      'critical-write-p95',
      'Write p95 in the critical window',
      nearestRank(writes.criticalLatencies, 95),
      slo.criticalWriteP95Ms,
    ),
    {
      id: 'cost',
      label: 'Cost',
      actual: microUsdToUsd(costMicroUsdPerHour),
      target: microUsdToUsd(budget),
      unit: '$/h',
      passed: costMicroUsdPerHour <= budget,
    },
  ];
}

interface CacheDiagnostics {
  nodeId: string;
  label: string;
  hits: number;
  misses: number;
  coalesced: number;
}

/** Evaluation-only measured resource summary for one graph node. */
export interface PressureNodeSummary {
  nodeId: string;
  label: string;
  kind: 'client' | 'loadBalancer' | 'appServer' | 'cache' | 'database';
  capacity: number | null;
  poolSize: number | null;
  queueLimit: number;
  maxQueued: number;
  busyPeak: number;
  busyAvg: number;
  poolBusyPeak: number;
  poolBusyAvg: number;
  poolQueuedPeak: number;
  failures: Array<{ code: string; stage: string; count: number }>;
  errors: number;
}

export interface NoCacheDemand {
  readPeakRps: number;
  writePeakRps: number;
  readMs: number;
  writeMs: number;
  capacity: number;
}

export interface DiagnosticsInput {
  costMicroUsdPerHour: number;
  budgetMicroUsdPerHour: number;
  deadlineMs: number;
  reads: ClassMetrics;
  writes: ClassMetrics;
  nodes: PressureNodeSummary[];
  cache?: CacheDiagnostics;
  noCacheDemand?: NoCacheDemand;
}

const STAGE_LABELS: Readonly<Record<string, string>> = {
  appQueue: 'admission queue',
  appCpu: 'app processing slot',
  poolQueue: 'app connection pool',
  cacheLookup: 'cache lookup',
  backendQueue: 'cache backend pool',
  fillWait: 'in-flight cache fill',
  dbQueue: 'database queue',
  dbExecuting: 'database execution',
  edgeToDependency: 'dependency edge',
  edgeResponse: 'response return path',
  lb: 'load-balancer path',
  client: 'client path',
};

const STAGE_ORDER = [
  'appQueue',
  'appCpu',
  'poolQueue',
  'cacheLookup',
  'backendQueue',
  'fillWait',
  'dbQueue',
  'dbExecuting',
  'edgeToDependency',
  'edgeResponse',
  'lb',
  'client',
];

interface StageGroup {
  stage: string;
  total: number;
  codes: Map<string, number>;
}

function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDecimal(value: number, digits = 2): string {
  const fixed = value.toFixed(digits);
  return fixed.replace(/\.?0+$/, '') || '0';
}

function capacityText(capacity: number | null): string {
  return capacity === null ? 'unbounded' : String(capacity);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stageGroups(
  failures: ReadonlyArray<{ code: string; stage: string; count: number }>,
): StageGroup[] {
  const groups = new Map<string, StageGroup>();
  for (const failure of failures) {
    let group = groups.get(failure.stage);
    if (!group) {
      group = { stage: failure.stage, total: 0, codes: new Map() };
      groups.set(failure.stage, group);
    }
    group.total += failure.count;
    group.codes.set(
      failure.code,
      (group.codes.get(failure.code) ?? 0) + failure.count,
    );
  }
  return [...groups.values()].sort((left, right) => {
    const leftIndex = STAGE_ORDER.indexOf(left.stage);
    const rightIndex = STAGE_ORDER.indexOf(right.stage);
    if (leftIndex !== rightIndex) {
      return (
        (leftIndex < 0 ? STAGE_ORDER.length : leftIndex) -
        (rightIndex < 0 ? STAGE_ORDER.length : rightIndex)
      );
    }
    return compareText(left.stage, right.stage);
  });
}

function codeSummary(group: StageGroup): string {
  return [...group.codes.entries()]
    .map(([code, count]) => `${code}: ${formatCount(count)}`)
    .join(', ');
}

function databaseHeadroomNote(
  database: PressureNodeSummary | undefined,
): string {
  if (!database || database.capacity === null) {
    return '';
  }
  if (database.busyPeak < database.capacity) {
    return ` The database was below its slot limit at peak (${database.busyPeak} of ${database.capacity}), so the app pool was the observed wait location; this does not prove the database caused it.`;
  }
  return ` The database also reached its slot limit at peak (${database.busyPeak} of ${database.capacity}), so widening the app pool may mostly move the wait to the database.`;
}

function appPoolMetrics(node: PressureNodeSummary): string {
  return `connection pool peak ${node.poolBusyPeak} of ${capacityText(node.poolSize)}, average ${formatDecimal(node.poolBusyAvg)} of ${capacityText(node.poolSize)}, waiter peak ${node.poolQueuedPeak}`;
}

/**
 * Explain measured app-pool pressure next to measured database occupancy for
 * admission failures, where the request never reached `poolQueue`. This states
 * observed capacity facts and a cautious tuning tradeoff, not a causal claim.
 */
function appAdmissionCapacityNote(
  node: PressureNodeSummary,
  database: PressureNodeSummary | undefined,
): string {
  if (!database || database.capacity === null) {
    return '';
  }
  const peak = `${database.busyPeak} of ${database.capacity}`;
  const average = formatDecimal(database.busyAvg);
  const poolAtLimit =
    node.poolSize !== null && node.poolBusyPeak >= node.poolSize;
  const hasPoolWait = node.poolQueuedPeak > 0;
  const poolClause = poolAtLimit
    ? 'while the app pool was at its measured limit'
    : hasPoolWait
      ? 'while the app pool had measured waiters'
      : '';
  const poolObservation = poolClause ? `, ${poolClause}` : '';

  if (database.busyPeak < database.capacity) {
    // Wait-specific tuning advice is only justified by measured waiters. A
    // full pool peak with zero waiters is still a fact, but not a pool wait.
    const poolTradeoff = hasPoolWait
      ? '; more app slots or queue capacity would not by itself remove the pool wait unless the dependency can absorb more concurrency'
      : '';
    return ` The database was below its slot limit at peak (${peak}, average ${average})${poolObservation}${poolTradeoff}. This is measured pressure, not proof of a single root cause.`;
  }

  const waitAdvice = hasPoolWait
    ? '; widening the app pool may mostly move the wait to the database'
    : '';
  const caveat = hasPoolWait
    ? ''
    : ' This is measured pressure, not proof of a single root cause.';
  return ` The database also reached its slot limit at peak (${peak}, average ${average})${poolObservation}${waitAdvice}.${caveat}`;
}

function failureDiagnostics(
  node: PressureNodeSummary,
  database: PressureNodeSummary | undefined,
  deadlineMs: number,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const group of stageGroups(node.failures)) {
    const overflow = group.codes.get('queue_overflow') ?? 0;
    const timeouts = group.codes.get('timeout') ?? 0;
    const other = group.total - overflow - timeouts;
    const parts: string[] = [];

    switch (group.stage) {
      case 'appQueue':
        if (overflow > 0) {
          parts.push(
            `${formatCount(overflow)} requests were rejected because the admission queue was full`,
          );
        }
        if (timeouts > 0) {
          parts.push(
            `${formatCount(timeouts)} requests passed the ${deadlineMs} ms deadline waiting for a processing slot`,
          );
        }
        if (other > 0) {
          parts.push(
            `${formatCount(other)} requests failed while waiting for admission (${codeSummary(group)})`,
          );
        }
        diagnostics.push({
          severity: 'error',
          nodeId: node.nodeId,
          message: `App "${node.label}": ${parts.join('; ')}. Observed admission queue peak ${node.maxQueued} of ${node.queueLimit}, slots peak ${node.busyPeak} of ${capacityText(node.capacity)}, average ${formatDecimal(node.busyAvg)} of ${capacityText(node.capacity)}; ${appPoolMetrics(node)}.${appAdmissionCapacityNote(node, database)} A larger queue or more slots admits more work; if the app connection pool or a downstream dependency is already saturated, it only moves the wait.`,
        });
        break;
      case 'appCpu':
        if (overflow > 0) {
          parts.push(
            `${formatCount(overflow)} requests were rejected while holding a processing slot`,
          );
        }
        if (timeouts > 0) {
          parts.push(
            `${formatCount(timeouts)} requests passed the ${deadlineMs} ms deadline while occupying a processing slot`,
          );
        }
        if (other > 0) {
          parts.push(
            `${formatCount(other)} requests failed in app execution (${codeSummary(group)})`,
          );
        }
        diagnostics.push({
          severity: 'error',
          nodeId: node.nodeId,
          message: `App "${node.label}": ${parts.join('; ')}. Observed slots peak ${node.busyPeak} of ${capacityText(node.capacity)}, average ${formatDecimal(node.busyAvg)} of ${capacityText(node.capacity)}. Started app work keeps its slot until it finishes; a longer deadline accepts more waiting, a shorter one rejects earlier.`,
        });
        break;
      case 'poolQueue':
        if (timeouts > 0) {
          parts.push(
            `${formatCount(timeouts)} requests passed the ${deadlineMs} ms deadline waiting for an app connection pool slot`,
          );
        }
        if (overflow > 0) {
          parts.push(
            `${formatCount(overflow)} requests were rejected at the app connection pool`,
          );
        }
        if (other > 0) {
          parts.push(
            `${formatCount(other)} requests failed at the app connection pool (${codeSummary(group)})`,
          );
        }
        diagnostics.push({
          severity: 'error',
          nodeId: node.nodeId,
          message: `App "${node.label}": ${parts.join('; ')}. Observed pool peak ${node.poolBusyPeak} of ${capacityText(node.poolSize)}, average ${formatDecimal(node.poolBusyAvg)} of ${capacityText(node.poolSize)}, waiter peak ${node.poolQueuedPeak}.${databaseHeadroomNote(database)} Widening the pool can help only if the downstream can absorb the extra concurrency.`,
        });
        break;
      case 'backendQueue':
        if (overflow > 0) {
          parts.push(
            `${formatCount(overflow)} requests were rejected because the cache backend queue was full`,
          );
        }
        if (timeouts > 0) {
          parts.push(
            `${formatCount(timeouts)} requests passed the ${deadlineMs} ms deadline in the cache backend path while a fill held or waited for a backend slot`,
          );
        }
        if (other > 0) {
          parts.push(
            `${formatCount(other)} requests failed at the cache backend (${codeSummary(group)})`,
          );
        }
        diagnostics.push({
          severity: 'error',
          nodeId: node.nodeId,
          message: `Cache "${node.label}": ${parts.join('; ')}. Observed backend queue peak ${node.maxQueued} of ${node.queueLimit}, backend pool peak ${node.poolBusyPeak} of ${capacityText(node.poolSize)}, average ${formatDecimal(node.poolBusyAvg)} of ${capacityText(node.poolSize)}, waiter peak ${node.poolQueuedPeak}. A larger backend pool or queue changes where cache-miss waiting happens; it does not reduce database work by itself.`,
        });
        break;
      case 'fillWait':
        diagnostics.push({
          severity: 'error',
          nodeId: node.nodeId,
          message: `Cache "${node.label}": ${formatCount(group.total)} requests (${codeSummary(group)}) ${group.total === 1 ? 'was' : 'were'} waiting for an in-flight cache fill when the outcome was decided. Observed backend pool peak ${node.poolBusyPeak} of ${capacityText(node.poolSize)}, average ${formatDecimal(node.poolBusyAvg)} of ${capacityText(node.poolSize)}, backend queue peak ${node.maxQueued} of ${node.queueLimit}. Coalescing reduces duplicate database reads but does not add backend capacity; fewer concurrent misses, more backend capacity, or a different deadline changes this wait.`,
        });
        break;
      case 'dbQueue':
        if (overflow > 0) {
          parts.push(
            `${formatCount(overflow)} requests were rejected because the database queue was full`,
          );
        }
        if (timeouts > 0) {
          parts.push(
            `${formatCount(timeouts)} requests passed the ${deadlineMs} ms deadline waiting for a database slot`,
          );
        }
        if (other > 0) {
          parts.push(
            `${formatCount(other)} requests failed in the database queue (${codeSummary(group)})`,
          );
        }
        diagnostics.push({
          severity: 'error',
          nodeId: node.nodeId,
          message: `Database "${node.label}": ${parts.join('; ')}. Observed slots peak ${node.busyPeak} of ${capacityText(node.capacity)}, average ${formatDecimal(node.busyAvg)} of ${capacityText(node.capacity)}, queue peak ${node.maxQueued} of ${node.queueLimit}. More database slots or a larger queue raises concurrency; if offered work already exceeds slot capacity, it delays rather than removes the wait.`,
        });
        break;
      case 'dbExecuting': {
        const headroom =
          node.capacity !== null && node.busyPeak < node.capacity
            ? ` The database was below its slot limit at peak (${node.busyPeak} of ${node.capacity}); this is the observed failure stage and capacity at peak, not a reconstruction of earlier wait history.`
            : '';
        diagnostics.push({
          severity: 'error',
          nodeId: node.nodeId,
          message: `Database "${node.label}": ${formatCount(group.total)} requests (${codeSummary(group)}) passed the ${deadlineMs} ms deadline while a database operation was still executing. Observed slots peak ${node.busyPeak} of ${capacityText(node.capacity)}, average ${formatDecimal(node.busyAvg)} of ${capacityText(node.capacity)}.${headroom} Started operations keep their slot until they finish, so this is deadline pressure at execution rather than a queue rejection.`,
        });
        break;
      }
      default: {
        const label = STAGE_LABELS[group.stage] ?? group.stage;
        diagnostics.push({
          severity: 'error',
          nodeId: node.nodeId,
          message: `Node "${node.label}": ${formatCount(group.total)} requests failed at the ${label} (${codeSummary(group)}). This is the observed location of the rejection or deadline, not an inferred root cause.`,
        });
        break;
      }
    }
  }
  return diagnostics;
}

function pressureInfoDiagnostic(
  node: PressureNodeSummary,
  database: PressureNodeSummary | undefined,
): Diagnostic | undefined {
  if (node.kind === 'appServer' && node.capacity !== null) {
    const poolFull =
      node.poolSize !== null && node.poolBusyPeak >= node.poolSize;
    if (
      node.busyPeak >= node.capacity ||
      node.maxQueued > 0 ||
      node.poolQueuedPeak > 0 ||
      poolFull
    ) {
      const headroom =
        node.poolQueuedPeak > 0 ? databaseHeadroomNote(database) : '';
      return {
        severity: 'info',
        nodeId: node.nodeId,
        message: `App "${node.label}": observed slots peak ${node.busyPeak} of ${node.capacity} (average ${formatDecimal(node.busyAvg)}), admission queue peak ${node.maxQueued} of ${node.queueLimit}, connection pool peak ${node.poolBusyPeak} of ${capacityText(node.poolSize)} (average ${formatDecimal(node.poolBusyAvg)}) with waiter peak ${node.poolQueuedPeak}.${headroom} Peak occupancy is measured pressure, not by itself proof of a bottleneck.`,
      };
    }
    return undefined;
  }

  if (node.kind === 'database' && node.capacity !== null) {
    if (node.busyPeak >= node.capacity || node.maxQueued > 0) {
      return {
        severity: 'info',
        nodeId: node.nodeId,
        message: `Database "${node.label}": observed slots peak ${node.busyPeak} of ${node.capacity} (average ${formatDecimal(node.busyAvg)}), queue peak ${node.maxQueued} of ${node.queueLimit}. Peak occupancy is measured pressure, not by itself proof of a bottleneck.`,
      };
    }
    return undefined;
  }

  if (node.kind === 'cache' && node.poolSize !== null) {
    if (
      node.poolBusyPeak >= node.poolSize ||
      node.maxQueued > 0 ||
      node.poolQueuedPeak > 0
    ) {
      return {
        severity: 'info',
        nodeId: node.nodeId,
        message: `Cache "${node.label}": backend pool peak ${node.poolBusyPeak} of ${node.poolSize} (average ${formatDecimal(node.poolBusyAvg)}), backend queue peak ${node.maxQueued} of ${node.queueLimit}, waiter peak ${node.poolQueuedPeak}. Peak occupancy is measured pressure, not by itself proof of a bottleneck.`,
      };
    }
  }

  return undefined;
}

/** Bounded, player-facing explanation of the final run. */
export function buildDiagnostics(input: DiagnosticsInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { costMicroUsdPerHour: cost, budgetMicroUsdPerHour: budget } = input;
  if (cost > budget) {
    diagnostics.push({
      severity: 'error',
      message: `Cost ${microUsdToUsd(cost).toFixed(2)} $/h is above the budget of ${microUsdToUsd(budget).toFixed(2)} $/h. Cost is a separate gate from the traffic SLO: a cost-only failure does not blame a node, and a cache is not required if another architecture meets the traffic SLO.`,
    });
  }

  const classes: Array<[string, ClassMetrics]> = [
    ['reads', input.reads],
    ['writes', input.writes],
  ];
  for (const [name, metrics] of classes) {
    if (metrics.offered === 0) {
      diagnostics.push({
        severity: 'warning',
        message: `No offered ${name}: metric unknown, SLO not met`,
      });
      continue;
    }
    if (metrics.failed > 0) {
      const breakdown = Object.entries(metrics.errors)
        .map(([code, count]) => `${code}: ${count}`)
        .join(', ');
      diagnostics.push({
        severity: 'error',
        message: `${metrics.failed} of ${metrics.offered} ${name} failed (${breakdown})`,
      });
    }
    if (metrics.succeeded === 0) {
      diagnostics.push({
        severity: 'warning',
        message: `No successful ${name}: p95 unknown, SLO not met`,
      });
    }
  }

  const failedNodes = input.nodes.filter((node) => node.failures.length > 0);
  if (failedNodes.length > 0) {
    diagnostics.push({
      severity: 'info',
      message:
        'Failure locations below are the observed rejection or deadline stage, not an inferred root cause.',
    });
  }

  const database = input.nodes.find((node) => node.kind === 'database');
  for (const node of failedNodes) {
    diagnostics.push(...failureDiagnostics(node, database, input.deadlineMs));
  }

  const demand = input.noCacheDemand;
  if (demand && demand.capacity > 0) {
    const readSlots = (demand.readPeakRps * demand.readMs) / 1000;
    const writeSlots = (demand.writePeakRps * demand.writeMs) / 1000;
    const totalSlots = readSlots + writeSlots;
    if (totalSlots >= demand.capacity * 0.5) {
      diagnostics.push({
        severity: 'info',
        nodeId: database?.nodeId,
        message: `No cache: every offered read adds database work. At the busiest scheduled second the model implies ${formatDecimal(totalSlots)} slots of database work (${formatDecimal(demand.readPeakRps)} reads/s × ${formatDecimal(demand.readMs)} ms + ${formatDecimal(demand.writePeakRps)} writes/s × ${formatDecimal(demand.writeMs)} ms) against ${demand.capacity} database slots (${((totalSlots / demand.capacity) * 100).toFixed(1)}% of capacity). This is a theoretical estimate from the level schedule and service times, not measured throughput.`,
      });
    }
  }

  for (const node of input.nodes) {
    if (node.failures.length === 0) {
      const info = pressureInfoDiagnostic(node, database);
      if (info) {
        diagnostics.push(info);
      }
    }
  }

  const cache = input.cache;
  if (cache) {
    const lookups = cache.hits + cache.misses;
    if (lookups > 0) {
      diagnostics.push({
        severity: 'info',
        message: `Cache hits: ${((cache.hits / lookups) * 100).toFixed(1)}% (${cache.hits}/${lookups})`,
        nodeId: cache.nodeId,
      });
    }
    if (cache.coalesced > 0) {
      diagnostics.push({
        severity: 'info',
        message: `Coalescing shared ${cache.coalesced} in-flight cache misses`,
        nodeId: cache.nodeId,
      });
    }
  }

  for (const node of input.nodes) {
    if (node.errors > 0 && node.failures.length === 0) {
      diagnostics.push({
        severity: 'warning',
        message: `Node "${node.label}": ${node.errors} errors`,
        nodeId: node.nodeId,
      });
    }
  }

  return diagnostics.slice(0, 100);
}
