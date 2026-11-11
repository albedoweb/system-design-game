import { estimateParcelCapacity } from './capacity';
import {
  PARCEL_LEVEL_ID,
  PARCEL_MAX_SEED,
  PARCEL_MODEL_VERSION,
  PARCEL_PRICING_VERSION,
  PARCEL_REQUIRED_HORIZONS,
  PARCEL_SCHEMA_VERSION,
  type ParcelBusinessOperation,
  type ParcelCapacityBreakdown,
  type ParcelCheck,
  type ParcelCostSummary,
  type ParcelDiagnostic,
  type ParcelEvaluation,
  type ParcelEvaluationMeta,
  type ParcelGraph,
  type ParcelHorizonResult,
  type ParcelHorizonYears,
  type ParcelRunOptions,
} from './contracts';
import {
  parcelGraphDigest,
  parseParcelGraph,
  validateParcelGraph,
} from './graph';
import { PARCEL_LEVEL } from './level';
import { generateParcelTrace } from './workload';
import { simulateParcelHorizon, type ParcelSimulationResult } from './simulate';

function baseMeta(
  seed: number,
  horizons: readonly ParcelHorizonYears[],
  digest: string | null,
): ParcelEvaluationMeta {
  return {
    schemaVersion: PARCEL_SCHEMA_VERSION,
    modelVersion: PARCEL_MODEL_VERSION,
    pricingVersion: PARCEL_PRICING_VERSION,
    contentVersion: PARCEL_LEVEL.contentVersion,
    levelId: PARCEL_LEVEL_ID,
    seed,
    graphDigest: digest,
    requestedHorizons: horizons,
    requiredHorizons: PARCEL_REQUIRED_HORIZONS,
    sampleFactor: PARCEL_LEVEL.workload.sampleFactor,
  };
}

function normalizeHorizons(
  requested: readonly ParcelHorizonYears[] | undefined,
): { ok: true; horizons: ParcelHorizonYears[] } | { ok: false; message: string } {
  if (requested === undefined) {
    return { ok: true, horizons: [...PARCEL_REQUIRED_HORIZONS] };
  }
  if (requested.length === 0) {
    return { ok: false, message: 'At least one horizon is required.' };
  }
  const seen = new Set<ParcelHorizonYears>();
  for (const value of requested) {
    if (value !== 1 && value !== 5) {
      return {
        ok: false,
        message: `Horizon ${String(value)} is not supported; use 1 or 5.`,
      };
    }
    seen.add(value);
  }
  return { ok: true, horizons: [...seen].sort((a, b) => a - b) };
}

function requiredCheck(
  id: string,
  label: string,
  passed: boolean,
  message: string,
  extra: Omit<ParcelCheck, 'id' | 'label' | 'passed' | 'message' | 'severity'> = {},
): ParcelCheck {
  return {
    id,
    label,
    passed,
    severity: 'required',
    message,
    ...extra,
  };
}

function checkAvailability(
  operation: ParcelBusinessOperation,
  metrics: ParcelSimulationResult['operations'][ParcelBusinessOperation],
): ParcelCheck {
  const limit = PARCEL_LEVEL.slo.availability;
  return requiredCheck(
    `availability:${operation}`,
    `${operation} availability`,
    metrics.availability >= limit,
    `${operation} availability ${(metrics.availability * 100).toFixed(
      2,
    )}% must be at least ${(limit * 100).toFixed(1)}%; rejected, timed out, stale and missing responses all count as failures.`,
    {
      operation,
      actual: metrics.availability,
      limit,
      unit: 'ratio',
    },
  );
}

function checkP95(
  operation: ParcelBusinessOperation,
  metrics: ParcelSimulationResult['operations'][ParcelBusinessOperation],
): ParcelCheck {
  const limit = PARCEL_LEVEL.slo.p95Ms[operation];
  const hasSamples = metrics.counts.success > 0;
  return requiredCheck(
    `p95:${operation}`,
    `${operation} p95`,
    hasSamples && metrics.successP95Ms <= limit,
    hasSamples
      ? `${operation} successful p95 is ${metrics.successP95Ms.toFixed(
          1,
        )} ms; limit ${limit} ms.`
      : `${operation} p95 is unavailable: there are no successful responses, so 0 ms is not a measured pass.`,
    {
      operation,
      ...(hasSamples ? { actual: metrics.successP95Ms } : {}),
      limit,
      unit: 'ms',
    },
  );
}

function checkFreshness(
  operation: 'status' | 'report',
  metrics: ParcelSimulationResult['operations'][ParcelBusinessOperation],
): ParcelCheck {
  const limit = PARCEL_LEVEL.slo.freshnessMs[operation];
  const actual = metrics.freshnessMaxMs;
  return requiredCheck(
    `freshness:${operation}`,
    `${operation} freshness`,
    actual !== null && actual <= limit,
    actual === null
      ? `${operation} has no successful freshness samples.`
      : `${operation} maximum observed lag is ${actual.toFixed(
          1,
        )} ms; limit ${limit} ms.`,
    {
      operation,
      actual: actual ?? limit + 1,
      limit,
      unit: 'ms',
    },
  );
}

function horizonChecks(
  horizonYears: ParcelHorizonYears,
  simulation: ParcelSimulationResult,
  capacity: ParcelCapacityBreakdown,
  cost: ParcelCostSummary,
): ParcelCheck[] {
  const checks: ParcelCheck[] = [];
  for (const operation of [
    'status',
    'history',
    'ingest',
    'report',
  ] as const) {
    const metrics = simulation.operations[operation];
    checks.push(checkAvailability(operation, metrics));
    checks.push(checkP95(operation, metrics));
    checks.push(
      requiredCheck(
        `non_zero:${operation}`,
        `${operation} workload`,
        metrics.counts.offered > 0,
        `${metrics.counts.offered} ${operation} request(s) were offered.`,
        {
          operation,
          actual: metrics.counts.offered,
          limit: 1,
          unit: 'requests',
        },
      ),
    );
  }
  checks.push(checkFreshness('status', simulation.operations.status));
  checks.push(checkFreshness('report', simulation.operations.report));

  for (const store of capacity.stores) {
    checks.push(
      requiredCheck(
        `storage_capacity:${store.nodeId}`,
        `Storage capacity · ${store.nodeId}`,
        store.capacityOk,
        `"${store.nodeId}" uses ${store.totalUsedTb.toFixed(
          3,
        )} TB of ${store.provisionedTb.toFixed(1)} TB provisioned.`,
        {
          nodeId: store.nodeId,
          actual: store.totalUsedTb,
          limit: store.provisionedTb,
          unit: 'TB',
        },
      ),
    );
  }
  const retentionStores = capacity.stores.filter(
    (store) =>
      store.roles.includes('ingest-primary') ||
      store.roles.includes('read:history'),
  );
  const minRetention =
    retentionStores.length > 0
      ? Math.min(...retentionStores.map((store) => store.retentionYears))
      : 0;
  checks.push(
    requiredCheck(
      'retention',
      'Five-year raw history',
      capacity.retentionOk,
      `The primary and history route retain ${minRetention} year(s); this horizon requires ${horizonYears}.`,
      {
        actual: minRetention,
        limit: horizonYears,
        unit: 'years',
      },
    ),
  );
  checks.push(
    requiredCheck(
      'capacity',
      'Provisioned capacity',
      capacity.capacityOk,
      capacity.capacityOk
        ? 'All stores fit inside their fixed provisioned capacity.'
        : 'At least one store exceeds its provisioned capacity.',
    ),
  );

  const unfinished =
    simulation.operations.status.counts.unfinished +
    simulation.operations.history.counts.unfinished +
    simulation.operations.ingest.counts.unfinished +
    simulation.operations.report.counts.unfinished;
  checks.push(
    requiredCheck(
      'workload_complete',
      'Workload completion',
      !simulation.exhausted && unfinished === 0,
      simulation.exhausted
        ? 'The bounded event budget was exhausted; this is not a partial pass.'
        : `${unfinished} request(s) remained unfinished at the simulation end.`,
      {
        actual: unfinished,
        limit: 0,
        unit: 'requests',
      },
    ),
  );

  if (horizonYears === 5) {
    const rate =
      simulation.historical.offered > 0
        ? simulation.historical.success / simulation.historical.offered
        : 0;
    checks.push(
      requiredCheck(
        'historical_cohort',
        'Four-year-old history cohort',
        simulation.historical.offered > 0 &&
          rate >= PARCEL_LEVEL.slo.availability,
        `${simulation.historical.success}/${simulation.historical.offered} four-year-old history requests returned retained data on time (${(rate * 100).toFixed(
          2,
        )}%).`,
        {
          operation: 'history',
          actual: rate,
          limit: PARCEL_LEVEL.slo.availability,
          unit: 'ratio',
        },
      ),
    );
  }

  const primary = capacity.stores.find((store) =>
    store.roles.includes('ingest-primary'),
  );
  const durable =
    primary !== undefined && (primary.kind === 'sql' || primary.kind === 'kv');
  checks.push(
    requiredCheck(
      'data_integrity',
      'Replication data integrity',
      simulation.dataIntegrity.replicationBatchesDropped === 0,
      simulation.dataIntegrity.replicationBatchesDropped === 0
        ? 'Every accepted write was covered by a completed or queued replication batch.'
        : `${simulation.dataIntegrity.replicationBatchesDropped} replication batch(es) covering ${simulation.dataIntegrity.replicationEventsDropped} event(s) were dropped by a full replica queue. A partial copy cannot pass.`,
      {
        actual: simulation.dataIntegrity.replicationBatchesDropped,
        limit: 0,
        unit: 'batches',
      },
    ),
  );

  checks.push(
    requiredCheck(
      'durable_ack',
      'Durable ingest acknowledgement',
      durable && simulation.operations.ingest.counts.success > 0,
      durable
        ? `Ingest acknowledged ${simulation.operations.ingest.counts.success} durable primary commits.`
        : 'Ingest has no durable SQL or KV primary commit.',
      {
        operation: 'ingest',
        actual: simulation.operations.ingest.counts.success,
        limit: 1,
        unit: 'requests',
      },
    ),
  );

  checks.push(
    requiredCheck(
      'budget',
      'Monthly budget',
      cost.withinBudget,
      `Monthly cost is $${cost.monthlyUsd.toFixed(
        2,
      )}; budget $${cost.budgetMonthlyUsd.toFixed(2)}.`,
      {
        actual: cost.monthlyUsd,
        limit: cost.budgetMonthlyUsd,
        unit: 'USD/month',
      },
    ),
  );
  return checks;
}

function capacityDiagnostics(
  horizonYears: ParcelHorizonYears,
  capacity: ParcelCapacityBreakdown,
  cost: ParcelCostSummary,
): ParcelDiagnostic[] {
  const diagnostics: ParcelDiagnostic[] = [];
  for (const store of capacity.stores) {
    if (!store.capacityOk) {
      diagnostics.push({
        id: `storage_capacity:${store.nodeId}`,
        severity: 'error',
        code: 'storage_capacity_exceeded',
        message: `"${store.nodeId}" needs ${store.totalUsedTb.toFixed(
          3,
        )} TB but only ${store.provisionedTb.toFixed(1)} TB is provisioned.`,
        nodeId: store.nodeId,
        horizonYears,
        value: store.totalUsedTb,
        limit: store.provisionedTb,
      });
    }
    if (store.utilization > 0.85) {
      diagnostics.push({
        id: `storage_pressure:${store.nodeId}`,
        severity: 'warning',
        code: 'storage_pressure',
        message: `"${store.nodeId}" uses ${Math.round(
          store.utilization * 100,
        )}% of provisioned storage at year ${horizonYears}.`,
        nodeId: store.nodeId,
        horizonYears,
        value: store.utilization,
        limit: 0.85,
      });
    }
  }
  if (!cost.withinBudget) {
    diagnostics.push({
      id: 'budget_exceeded',
      severity: 'error',
      code: 'budget_exceeded',
      message: `Monthly cost $${cost.monthlyUsd.toFixed(
        2,
      )} exceeds the $${cost.budgetMonthlyUsd.toFixed(2)} budget.`,
      horizonYears,
      value: cost.monthlyUsd,
      limit: cost.budgetMonthlyUsd,
    });
  }
  return diagnostics;
}

function horizonPassed(checks: readonly ParcelCheck[]): boolean {
  return checks.every((check) => check.severity !== 'required' || check.passed);
}

function combinedCost(
  horizons: readonly ParcelHorizonResult[],
): ParcelCostSummary {
  const highest = horizons.reduce((best, current) =>
    current.horizonYears > best.horizonYears ? current : best,
  );
  const used: Partial<Record<ParcelHorizonYears, number>> = {};
  for (const horizon of horizons) {
    used[horizon.horizonYears] = horizon.cost.usedStorageTbByHorizon[
      horizon.horizonYears
    ];
  }
  return {
    ...highest.cost,
    usedStorageTbByHorizon: used,
  };
}

function invalidMeta(
  seed: number,
  horizons: readonly ParcelHorizonYears[],
  graph: ParcelGraph | null,
): ParcelEvaluationMeta {
  return baseMeta(seed, horizons, graph ? parcelGraphDigest(graph) : null);
}

/**
 * Parse, validate, estimate capacity and run the deterministic request
 * simulation. Invalid documents return `status: "invalid"`; bounded compute
 * failures return `status: "error"`. The same function is shared by the
 * browser worker and the Node CLI.
 */
export function evaluateParcel(
  input: unknown,
  options: ParcelRunOptions = {},
): ParcelEvaluation {
  const normalized = normalizeHorizons(options.horizons);
  const requestedHorizons = normalized.ok
    ? normalized.horizons
    : ([] as ParcelHorizonYears[]);
  const seed = options.seed ?? PARCEL_LEVEL.defaultSeed;
  if (!Number.isInteger(seed) || seed < 0 || seed > PARCEL_MAX_SEED) {
    return {
      status: 'error',
      passed: false,
      meta: baseMeta(seed, requestedHorizons, null),
      issues: [],
      diagnostics: [],
      assumptions: PARCEL_LEVEL.assumptions,
      horizons: [],
      capacity: null,
      cost: null,
      checks: [],
      error: {
        code: 'invalid_seed',
        message: `Seed must be an integer in 0..${PARCEL_MAX_SEED}, received ${String(
          seed,
        )}.`,
      },
    };
  }
  if (!normalized.ok) {
    return {
      status: 'error',
      passed: false,
      meta: baseMeta(seed, requestedHorizons, null),
      issues: [],
      diagnostics: [],
      assumptions: PARCEL_LEVEL.assumptions,
      horizons: [],
      capacity: null,
      cost: null,
      checks: [],
      error: { code: 'invalid_horizons', message: normalized.message },
    };
  }

  options.onProgress?.({
    phase: 'validate',
    horizonYears: null,
    completed: 0,
    total: 1,
    message: 'Parsing and validating the graph',
  });

  const parsed = parseParcelGraph(input);
  if (!parsed.ok) {
    return {
      status: 'invalid',
      passed: false,
      meta: invalidMeta(seed, requestedHorizons, null),
      issues: parsed.issues,
      diagnostics: [],
      assumptions: PARCEL_LEVEL.assumptions,
      horizons: [],
      capacity: null,
      cost: null,
      checks: [],
    };
  }
  const graph = parsed.graph;
  const validationIssues = validateParcelGraph(graph, { mode: 'run' });
  const structuralErrors = validationIssues.filter(
    (issue) => issue.severity === 'error',
  );
  if (structuralErrors.length > 0) {
    return {
      status: 'invalid',
      passed: false,
      meta: invalidMeta(seed, requestedHorizons, graph),
      issues: validationIssues,
      diagnostics: structuralErrors.map((issue) => ({
        id: `validation:${issue.code}`,
        severity: 'error',
        code: issue.code,
        message: issue.message,
        ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
        ...(issue.edgeId === undefined ? {} : { edgeId: issue.edgeId }),
      })),
      assumptions: PARCEL_LEVEL.assumptions,
      horizons: [],
      capacity: null,
      cost: null,
      checks: [],
    };
  }

  const trace = generateParcelTrace(seed);
  const horizonResults: ParcelHorizonResult[] = [];
  const totalHorizons = requestedHorizons.length;

  for (let index = 0; index < requestedHorizons.length; index += 1) {
    const horizonYears = requestedHorizons[index];
    if (horizonYears === undefined) {
      continue;
    }
    options.onProgress?.({
      phase: 'capacity',
      horizonYears,
      completed: index,
      total: totalHorizons,
      message: `Estimating analytical capacity at year ${horizonYears}`,
    });
    const estimate = estimateParcelCapacity(graph, horizonYears);
    options.onProgress?.({
      phase: 'simulate',
      horizonYears,
      completed: index,
      total: totalHorizons,
      message: `Simulating the shared request trace at year ${horizonYears}`,
    });
    const simulation = simulateParcelHorizon(
      graph,
      horizonYears,
      trace,
      options.onTraffic,
    );
    if (simulation.exhausted) {
      return {
        status: 'error',
        passed: false,
        meta: baseMeta(seed, requestedHorizons, parcelGraphDigest(graph)),
        issues: validationIssues,
        diagnostics: simulation.diagnostics,
        assumptions: PARCEL_LEVEL.assumptions,
        horizons: [],
        capacity: null,
        cost: null,
        checks: [],
        error: {
          code: 'event_budget_exhausted',
          message: `Year ${horizonYears} exceeded the bounded event budget. Reduce the graph workload or investigate a narrower horizon; this is not a pass.`,
        },
      };
    }
    const checks = horizonChecks(
      horizonYears,
      simulation,
      estimate.capacity,
      estimate.cost,
    );
    const diagnostics = [
      ...simulation.diagnostics,
      ...capacityDiagnostics(horizonYears, estimate.capacity, estimate.cost),
    ];
    horizonResults.push({
      horizonYears,
      passed: horizonPassed(checks),
      workload: simulation.workload,
      operations: simulation.operations,
      nodes: simulation.nodes,
      capacity: estimate.capacity,
      cost: estimate.cost,
      checks,
      diagnostics,
    });
  }

  const horizonsComplete = requestedHorizons.includes(1) && requestedHorizons.includes(5);
  const topChecks: ParcelCheck[] = [
    requiredCheck(
      'horizons_complete',
      'Both mandatory horizons',
      horizonsComplete,
      horizonsComplete
        ? 'Years 1 and 5 were evaluated.'
        : 'An investigation run with one horizon can never report an overall pass; evaluate both years 1 and 5.',
      {
        actual: requestedHorizons.length,
        limit: 2,
        unit: 'horizons',
      },
    ),
  ];
  for (const result of horizonResults) {
    topChecks.push(
      requiredCheck(
        `horizon_pass:${result.horizonYears}`,
        `Year ${result.horizonYears}`,
        result.passed,
        result.passed
          ? `Year ${result.horizonYears} passes every required gate.`
          : `Year ${result.horizonYears} fails at least one required gate.`,
        { horizonYears: result.horizonYears },
      ),
    );
  }
  const passed =
    horizonsComplete &&
    horizonResults.length === 2 &&
    horizonResults.every((result) => result.passed);

  const highest = horizonResults.reduce((best, current) =>
    current.horizonYears > best.horizonYears ? current : best,
  );
  const diagnostics = horizonResults.flatMap((result) => result.diagnostics);

  options.onProgress?.({
    phase: 'done',
    horizonYears: null,
    completed: totalHorizons,
    total: totalHorizons,
    message: 'Evaluation complete',
  });

  return {
    status: 'ok',
    passed,
    meta: baseMeta(seed, requestedHorizons, parcelGraphDigest(graph)),
    issues: validationIssues,
    diagnostics,
    assumptions: PARCEL_LEVEL.assumptions,
    horizons: horizonResults,
    capacity: highest.capacity,
    cost: combinedCost(horizonResults),
    checks: topChecks,
  };
}
