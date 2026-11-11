/**
 * Image Atlas evaluator.
 *
 * `evaluateImages` is the single deterministic entry point shared by the
 * browser Worker (I104), the agent CLI/API (I103) and tests. It parses and
 * validates the submitted document with the frozen contracts, estimates
 * analytical capacity/cost, runs every requested scenario with the executable
 * model and returns an `ImageEvaluation` that satisfies the frozen runtime
 * schema.
 *
 * The function never trusts caller-supplied workloads, prices, coefficients or
 * results: only the graph document and a seed/scenario selection are accepted.
 * It is synchronous and has no DOM, Worker or wall-clock dependency.
 */

import { IMAGE_CATALOG } from './catalog';
import {
  IMAGE_EVALUATION_STATUSES,
  IMAGE_LEVEL_ID,
  IMAGE_MAX_SEED,
  IMAGE_REQUIRED_SCENARIOS,
  IMAGE_SCENARIOS,
  imageEvaluationSchema,
  type ImageCapacityBreakdown,
  type ImageCheck,
  type ImageCostLine,
  type ImageCostSummary,
  type ImageEvaluation,
  type ImageEvaluationMeta,
  type ImageGraph,
  type ImageIncompleteReason,
  type ImageIssue,
  type ImageProgress,
  type ImageRunOptions,
  type ImageScenarioName,
  type ImageScenarioResult,
} from './contracts';
import { estimateImageCapacity, type ImageCapacityEstimate } from './capacity';
import { imageGraphDigest, parseImageGraph } from './graph';
import { IMAGE_LEVEL } from './level';
import { IMAGE_WORK_MODEL } from './model';
import { buildImageTrace } from './workload';
import { simulateImageScenario, type ImageMeasuredTraffic } from './simulate';

const SECONDS_PER_DAY = 86_400;
const DAYS_PER_MONTH = 30;

function baseMeta(
  seed: number,
  requestedScenarios: readonly ImageScenarioName[],
  qualification: boolean,
  digest: string | null,
): ImageEvaluationMeta {
  return {
    schemaVersion: IMAGE_LEVEL.schemaVersion,
    modelVersion: IMAGE_LEVEL.modelVersion,
    contentVersion: IMAGE_LEVEL.contentVersion,
    pricingVersion: IMAGE_LEVEL.pricingVersion,
    levelId: IMAGE_LEVEL_ID,
    seed,
    graphDigest: digest,
    requestedScenarios: [...requestedScenarios],
    requiredScenarios: [...IMAGE_REQUIRED_SCENARIOS],
    qualification,
    evaluationKind: qualification ? 'qualification' : 'exploratory',
    datasetDay: IMAGE_LEVEL.dataset.retentionDays,
  };
}

function normalizeScenarios(
  requested: readonly ImageScenarioName[] | undefined,
): { readonly ok: true; readonly scenarios: ImageScenarioName[] } | { readonly ok: false; readonly message: string } {
  if (requested === undefined) {
    return { ok: true, scenarios: [...IMAGE_REQUIRED_SCENARIOS] };
  }
  if (requested.length === 0) {
    return { ok: false, message: 'At least one scenario is required; an empty selection cannot be evaluated.' };
  }
  const seen = new Set<ImageScenarioName>();
  for (const name of requested) {
    if (!IMAGE_SCENARIOS.includes(name)) {
      return { ok: false, message: `Scenario "${String(name)}" is not part of the frozen Image Atlas qualification set.` };
    }
    seen.add(name);
  }
  const ordered = IMAGE_REQUIRED_SCENARIOS.filter((name) => seen.has(name));
  return { ok: true, scenarios: ordered };
}

function normalizeSeed(seed: number | undefined): number | null {
  if (seed === undefined) {
    return IMAGE_LEVEL.defaultSeed;
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > IMAGE_MAX_SEED) {
    return null;
  }
  return seed;
}

function requiredCheck(
  id: string,
  label: string,
  passed: boolean,
  message: string,
  extra: Omit<ImageCheck, 'id' | 'label' | 'passed' | 'message' | 'severity'> = {},
): ImageCheck {
  return { id, label, passed, severity: 'required', message, ...extra };
}

function advisoryCheck(
  id: string,
  label: string,
  passed: boolean,
  message: string,
  extra: Omit<ImageCheck, 'id' | 'label' | 'passed' | 'message' | 'severity'> = {},
): ImageCheck {
  return { id, label, passed, severity: 'advisory', message, ...extra };
}

function capacityReady(capacity: ImageCapacityBreakdown | null): boolean {
  if (!capacity) {
    return false;
  }
  return (
    capacity.capacityOk &&
    capacity.metadataCapacityOk &&
    capacity.cacheCapacityOk &&
    capacity.retentionOk &&
    capacity.topologyComplete &&
    capacity.metadataNodes.length > 0 &&
    capacity.metadataNodes.every(
      (node) => node.capacityOk && node.divisible && node.residentCacheFits,
    ) &&
    capacity.caches.every((cache) => cache.fits)
  );
}

/**
 * Measured monthly bill: fixed provider base, compute and provisioned disk come
 * from the analytical capacity estimate (they are catalog prices, not
 * traffic), while every traffic and API line uses the bytes and requests the
 * normal scenario actually produced. Incident replay cost is never
 * extrapolated into this number.
 */
function measuredCost(
  estimate: ImageCapacityEstimate,
  normal: ImageMeasuredTraffic | null,
  measuredMs: number,
): ImageCostSummary {
  const analytical = estimate.cost;
  if (!normal || measuredMs <= 0) {
    return {
      ...analytical,
      provenance: {
        ...analytical.provenance,
        measured: false,
        note:
          'No normal scenario was run, so the traffic and API lines are the analytical baseline; a passing result requires measured cost.',
      },
    };
  }
  const scale = SECONDS_PER_DAY / (measuredMs / 1000);
  const dailyEgressGb = (normal.clientEgressBytes / 1_000_000_000) * scale;
  const dailyProviderGb = (normal.providerRetrievalBytes / 1_000_000_000) * scale;
  const dailyCrossGb = (normal.crossRegionBytes / 1_000_000_000) * scale;
  const dailyReads = normal.readRequests * scale;
  const dailyWrites = normal.writeRequests * scale;

  const clientEgressUsd =
    dailyEgressGb * DAYS_PER_MONTH * IMAGE_CATALOG.prices.clientEgressUsdPerGb;
  const providerRetrievalUsd =
    dailyProviderGb * DAYS_PER_MONTH * IMAGE_CATALOG.prices.providerRetrievalUsdPerGb;
  const crossRegionUsd =
    dailyCrossGb * DAYS_PER_MONTH * IMAGE_CATALOG.prices.crossRegionUsdPerGb;
  const readFeesUsd = dailyReads * DAYS_PER_MONTH * IMAGE_CATALOG.prices.apiReadUsd;
  const writeFeesUsd = dailyWrites * DAYS_PER_MONTH * IMAGE_CATALOG.prices.apiWriteUsd;

  const fixedUsd = analytical.fixed.totalUsd;
  const controllableUsd = analytical.controllable.totalUsd;
  const trafficUsd = clientEgressUsd + providerRetrievalUsd + crossRegionUsd;
  const apiUsd = readFeesUsd + writeFeesUsd;
  const monthlyUsd = fixedUsd + controllableUsd + trafficUsd + apiUsd;

  const breakdown: ImageCostLine[] = [
    ...analytical.breakdown.filter((line) => line.category === 'fixed' || line.category === 'compute' || line.category === 'storage'),
    {
      id: 'traffic:client-egress',
      category: 'traffic',
      label: 'Client egress (measured normal replay)',
      monthlyUsd: clientEgressUsd,
      provenance: 'measured-run',
    },
    {
      id: 'traffic:provider-retrieval',
      category: 'traffic',
      label: 'Provider retrieval (measured normal replay, cache hits applied)',
      monthlyUsd: providerRetrievalUsd,
      provenance: 'measured-run',
    },
    {
      id: 'traffic:cross-region',
      category: 'traffic',
      label: 'Cross-region private transfers (measured normal replay)',
      monthlyUsd: crossRegionUsd,
      provenance: 'measured-run',
    },
    {
      id: 'api:reads',
      category: 'api',
      label: 'Business API reads (measured normal replay)',
      monthlyUsd: readFeesUsd,
      provenance: 'measured-run',
    },
    {
      id: 'api:writes',
      category: 'api',
      label: 'Business API writes (measured normal replay)',
      monthlyUsd: writeFeesUsd,
      provenance: 'measured-run',
    },
  ];

  return {
    currency: 'USD',
    pricingVersion: IMAGE_CATALOG.pricingVersion,
    monthlyUsd,
    fixedMonthlyUsd: fixedUsd,
    controllableMonthlyUsd: controllableUsd,
    trafficMonthlyUsd: trafficUsd,
    apiMonthlyUsd: apiUsd,
    fixed: { providerOriginalsUsd: fixedUsd, totalUsd: fixedUsd },
    controllable: {
      computeUsd: analytical.controllable.computeUsd,
      extraDiskUsd: analytical.controllable.extraDiskUsd,
      totalUsd: controllableUsd,
    },
    traffic: {
      clientEgressUsd,
      providerRetrievalUsd,
      crossRegionUsd,
      totalUsd: trafficUsd,
    },
    api: { readFeesUsd, writeFeesUsd, totalUsd: apiUsd },
    daily: {
      clientEgressGb: dailyEgressGb,
      providerRetrievalGb: dailyProviderGb,
      crossRegionGb: dailyCrossGb,
      readRequests: dailyReads,
      writeRequests: dailyWrites,
    },
    byNode: analytical.byNode,
    breakdown,
    budgetMonthlyUsd: IMAGE_LEVEL.budget.monthlyUsd,
    withinBudget: monthlyUsd <= IMAGE_LEVEL.budget.monthlyUsd,
    provenance: {
      pricingVersion: IMAGE_CATALOG.pricingVersion,
      workloadBasis: 'normal-daily-average',
      days: DAYS_PER_MONTH,
      measured: true,
      cacheHitRatioAssumed: normal.cacheHitRatio,
      retryRatioAssumed: normal.retryRatio,
      trafficBaselineComplete:
        estimate.routes.valid && estimate.routes.clients.length === IMAGE_LEVEL.regions.length,
      note:
        'Traffic and API lines are measured from the normal 60 s replay and scaled to a 30-day month; compute, provisioned disk and the fixed provider base are catalog prices. Incident replay cost is separate.',
    },
    notes: [
      'The fixed global original storage base is billed once and is never multiplied by metadata replicas.',
      'Instance RAM (including cache and metadata resident pages) is included in compute and is never billed again.',
      'Every metadata local copy is provisioned disk; measured workload bytes are not counted twice.',
      'Client egress is charged on measured returned bytes; a cache hit saves provider retrieval, not the client transfer.',
      'Retries and cache fills are measured, not assumed; incident replay cost is reported separately and never extrapolated.',
    ],
  };
}

function costDiagnostics(cost: ImageCostSummary): { id: string; severity: 'error' | 'warning' | 'info'; code: string; message: string; value?: number; limit?: number }[] {
  const diagnostics: { id: string; severity: 'error' | 'warning' | 'info'; code: string; message: string; value?: number; limit?: number }[] = [];
  if (!cost.withinBudget) {
    diagnostics.push({
      id: 'budget_exceeded',
      severity: 'error',
      code: 'budget_exceeded',
      message: `Monthly cost $${cost.monthlyUsd.toFixed(2)} exceeds the $${cost.budgetMonthlyUsd.toFixed(2)} budget.`,
      value: cost.monthlyUsd,
      limit: cost.budgetMonthlyUsd,
    });
  }
  if (!cost.provenance.measured) {
    diagnostics.push({
      id: 'cost_not_measured',
      severity: 'warning',
      code: 'cost_not_measured',
      message: 'Traffic cost is analytical because no normal scenario was run; a qualification pass needs measured cost.',
    });
  }
  return diagnostics;
}

function scenarioSummaryChecks(
  scenarios: readonly ImageScenarioResult[],
  requested: readonly ImageScenarioName[],
  qualification: boolean,
): ImageCheck[] {
  const checks: ImageCheck[] = [];
  const present = new Set(scenarios.map((scenario) => scenario.name));
  const missing = requested.filter((name) => !present.has(name));
  const allRequired = IMAGE_REQUIRED_SCENARIOS.every((name) => present.has(name));
  const allPassed = scenarios.every((scenario) => scenario.passed);
  const complete = qualification && allRequired && missing.length === 0;
  checks.push(
    requiredCheck(
      'qualification_scenarios',
      'Required qualification scenarios',
      complete && allPassed,
      !qualification
        ? 'A scenario subset is exploratory and cannot report a qualification pass; request all seven required cases.'
        : missing.length > 0
          ? `Missing scenarios: ${missing.join(', ')}.`
          : allPassed
            ? 'All seven required cases passed on this seed.'
            : 'At least one required case failed; see the per-scenario gates.',
      {
        actual: scenarios.filter((scenario) => scenario.passed).length,
        limit: IMAGE_REQUIRED_SCENARIOS.length,
        unit: 'scenarios',
        sampleCount: scenarios.length,
      },
    ),
  );
  for (const scenario of scenarios) {
    checks.push(
      requiredCheck(
        `scenario_pass:${scenario.name}`,
        `Scenario ${scenario.name}`,
        scenario.passed,
        scenario.passed
          ? `Scenario "${scenario.label}" passes every required gate.`
          : `Scenario "${scenario.label}" fails at least one required gate; see its checks and diagnostics.`,
        { scenario: scenario.name },
      ),
    );
  }
  return checks;
}

function incomplete(
  seed: number,
  requested: readonly ImageScenarioName[],
  reason: ImageIncompleteReason,
  scenarios: readonly ImageScenarioResult[],
  issues: readonly ImageIssue[],
  capacity: ImageCapacityBreakdown | null,
  cost: ImageCostSummary | null,
  diagnostics: ImageEvaluation['diagnostics'],
  digest: string | null,
): ImageEvaluation {
  return imageEvaluationSchema.parse({
    status: 'incomplete',
    passed: false,
    meta: baseMeta(seed, requested, false, digest),
    issues: [...issues],
    diagnostics: [...diagnostics],
    checks: [
      requiredCheck(
        'evaluation_bounded',
        'Bounded evaluation',
        false,
        reason.message,
      ),
    ],
    capacity,
    cost,
    assumptions: assumptions(),
    scenarios: [...scenarios],
    incompleteReason: reason,
  } satisfies ImageEvaluation);
}

function assumptions(): string[] {
  const values = [
    ...IMAGE_LEVEL.assumptions,
    ...IMAGE_WORK_MODEL.notes,
    'Work model version: ' + IMAGE_WORK_MODEL.version + '.',
    'A scenario subset is exploratory; only the full seven-case qualification can pass.',
    'Offered requests are simulated at sample factor 1; there is no sampling shortcut.',
    'The consistency postlude starts after the request drain and ends at the last ACK + 120 s.',
    'Measured cost scales the normal 60 s replay to 30 days and never extrapolates incident replay.',
  ];
  return values.slice(0, IMAGE_LEVEL.assumptions.length + IMAGE_WORK_MODEL.notes.length + 5);
}

export function evaluateImages(
  input: unknown,
  options: ImageRunOptions,
): ImageEvaluation {
  const seed = normalizeSeed(options?.seed);
  const requestedRaw = options?.scenarios;
  const normalized = normalizeScenarios(requestedRaw);
  const requested: ImageScenarioName[] = normalized.ok
    ? normalized.scenarios
    : requestedRaw && requestedRaw.length > 0
      ? [...requestedRaw].filter((name): name is ImageScenarioName => IMAGE_SCENARIOS.includes(name)).slice(0, IMAGE_REQUIRED_SCENARIOS.length)
      : [...IMAGE_REQUIRED_SCENARIOS];
  const qualification =
    requested.length === IMAGE_REQUIRED_SCENARIOS.length &&
    IMAGE_REQUIRED_SCENARIOS.every((name) => requested.includes(name));
  const progress = (value: ImageProgress): void => {
    options?.onProgress?.(value);
  };

  if (seed === null) {
    return imageEvaluationSchema.parse({
      status: 'invalid',
      passed: false,
      meta: baseMeta(IMAGE_LEVEL.defaultSeed, requested.length > 0 ? requested : [...IMAGE_REQUIRED_SCENARIOS], false, null),
      issues: [
        {
          severity: 'error',
          code: 'invalid_seed',
          message: `Seed must be an integer in 0..${IMAGE_MAX_SEED}.`,
        },
      ],
      diagnostics: [],
      checks: [],
      capacity: null,
      cost: null,
      assumptions: assumptions(),
      scenarios: [],
    } satisfies ImageEvaluation);
  }

  if (!normalized.ok) {
    return imageEvaluationSchema.parse({
      status: 'invalid',
      passed: false,
      meta: baseMeta(seed, requested.length > 0 ? requested : [...IMAGE_REQUIRED_SCENARIOS], false, null),
      issues: [{ severity: 'error', code: 'invalid_scenarios', message: normalized.message }],
      diagnostics: [],
      checks: [],
      capacity: null,
      cost: null,
      assumptions: assumptions(),
      scenarios: [],
    } satisfies ImageEvaluation);
  }

  progress({ phase: 'validate', scenario: null, completed: 0, total: 1, message: 'Parsing and validating the graph' });
  const parsed = parseImageGraph(input);
  if (!parsed.ok) {
    return imageEvaluationSchema.parse({
      status: 'invalid',
      passed: false,
      meta: baseMeta(seed, requested, false, null),
      issues: [...parsed.issues],
      diagnostics: parsed.issues.map((issue) => ({
        id: `validation:${issue.code}`,
        severity: 'error',
        code: issue.code,
        message: issue.message,
        ...(issue.path === undefined ? {} : { path: issue.path }),
        ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
        ...(issue.edgeId === undefined ? {} : { edgeId: issue.edgeId }),
      })),
      checks: [],
      capacity: null,
      cost: null,
      assumptions: assumptions(),
      scenarios: [],
    } satisfies ImageEvaluation);
  }
  const graph: ImageGraph = parsed.graph;
  const digest = imageGraphDigest(graph);

  progress({ phase: 'capacity', scenario: null, completed: 0, total: 1, message: 'Estimating day-30 capacity and cost' });
  const estimate = estimateImageCapacity(graph);
  if (!estimate.routes.valid) {
    const structuralErrors = estimate.issues.filter((issue) => issue.severity === 'error');
    return imageEvaluationSchema.parse({
      status: 'invalid',
      passed: false,
      meta: baseMeta(seed, requested, qualification, digest),
      issues: [...estimate.issues],
      diagnostics: structuralErrors.map((issue) => ({
        id: `validation:${issue.code}`,
        severity: 'error',
        code: issue.code,
        message: issue.message,
        ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
        ...(issue.edgeId === undefined ? {} : { edgeId: issue.edgeId }),
      })),
      checks: [],
      capacity: estimate.capacity,
      cost: estimate.cost,
      assumptions: assumptions(),
      scenarios: [],
    } satisfies ImageEvaluation);
  }

  progress({ phase: 'workload', scenario: null, completed: 0, total: 1, message: 'Building the graph-independent request trace' });
  const scenarios: ImageScenarioResult[] = [];
  const diagnostics: ImageEvaluation['diagnostics'] = [];
  let normalTraffic: ImageMeasuredTraffic | null = null;
  let exhausted: ImageIncompleteReason | null = null;
  let totalEvents = 0;

  for (let index = 0; index < requested.length; index += 1) {
    const name = requested[index];
    if (!name) {
      continue;
    }
    progress({
      phase: 'simulate',
      scenario: name,
      completed: index,
      total: requested.length,
      message: `Simulating ${name} with full offered workload`,
    });
    let trace;
    try {
      trace = buildImageTrace(seed, name);
    } catch (error) {
      return incomplete(
        seed,
        requested,
        {
          code: 'trace_generation_failed',
          message: `The workload trace for ${name} could not be generated: ${error instanceof Error ? error.message : String(error)}.`,
        },
        scenarios,
        estimate.issues,
        estimate.capacity,
        estimate.cost,
        diagnostics,
        digest,
      );
    }
    let simulation;
    try {
      simulation = simulateImageScenario(
        graph,
        estimate.routes,
        trace,
        options.onTraffic,
      );
    } catch (error) {
      return incomplete(
        seed,
        requested,
        {
          code: 'simulation_failed',
          message: `Scenario ${name} could not be simulated: ${error instanceof Error ? error.message : String(error)}.`,
        },
        scenarios,
        estimate.issues,
        estimate.capacity,
        estimate.cost,
        diagnostics,
        digest,
      );
    }
    totalEvents += simulation.processedEvents;
    scenarios.push(simulation.result);
    diagnostics.push(...simulation.result.diagnostics);
    if (simulation.result.workload.exhausted || simulation.exhausted) {
      exhausted = {
        code: 'event_budget_exhausted',
        message: `Scenario ${name} reached the bounded event budget (${simulation.eventBudget}); the result is incomplete, never a pass.`,
      };
      break;
    }
    if (name === 'normal') {
      normalTraffic = simulation.traffic;
    }
  }

  const cost = measuredCost(estimate, normalTraffic, IMAGE_LEVEL.qualification.measuredMs);
  diagnostics.push(...costDiagnostics(cost));
  const checks: ImageCheck[] = [
    ...scenarioSummaryChecks(scenarios, requested, qualification),
    requiredCheck(
      'capacity',
      'Day-30 capacity',
      capacityReady(estimate.capacity),
      capacityReady(estimate.capacity)
        ? 'Storage, replicas, resident pages, caches, retention and topology all fit at day 30.'
        : 'At least one metadata store, cache, retention or topology capacity gate fails; see issues and capacity breakdown.',
    ),
    requiredCheck(
      'budget',
      'Measured monthly budget',
      cost.provenance.measured && cost.withinBudget,
      `Measured monthly cost $${cost.monthlyUsd.toFixed(2)} against the $${cost.budgetMonthlyUsd.toFixed(2)} budget.`,
      { actual: cost.monthlyUsd, limit: cost.budgetMonthlyUsd, unit: 'usd' },
    ),
    advisoryCheck(
      'events_bounded',
      'Bounded event budget',
      totalEvents < IMAGE_LEVEL.qualification.maxEventsPerScenario * IMAGE_REQUIRED_SCENARIOS.length,
      `${totalEvents} events were processed across ${scenarios.length} scenario(s).`,
    ),
  ];

  if (exhausted) {
    return incomplete(
      seed,
      requested,
      exhausted,
      scenarios,
      estimate.issues,
      estimate.capacity,
      cost,
      diagnostics,
      digest,
    );
  }

  progress({
    phase: 'done',
    scenario: null,
    completed: requested.length,
    total: requested.length,
    message: 'Evaluation complete',
  });

  const allScenariosPassed =
    scenarios.length === requested.length && scenarios.every((scenario) => scenario.passed);
  const passed =
    qualification &&
    allScenariosPassed &&
    capacityReady(estimate.capacity) &&
    cost.provenance.measured &&
    cost.withinBudget;

  return imageEvaluationSchema.parse({
    status: 'complete',
    passed,
    meta: baseMeta(seed, requested, qualification, digest),
    issues: [...estimate.issues],
    diagnostics,
    checks,
    capacity: estimate.capacity,
    cost,
    assumptions: assumptions(),
    scenarios,
  } satisfies ImageEvaluation);
}

/** Discovery helpers shared with the CLI/API without recomputing a run. */
export function imageEvaluationStatuses(): readonly string[] {
  return IMAGE_EVALUATION_STATUSES;
}

