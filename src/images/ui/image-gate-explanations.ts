/**
 * Optional "Guided analysis" copy for failed Image Atlas gate families that
 * have enough evidence to say something honest: availability, latency and the
 * sample qualification of a window p99.9.
 *
 * Everything is derived from the selected scenario result only. This module
 * never mixes a stored result with the current graph and never changes
 * simulation state. The advice is deliberately conditional: aggregate case
 * data can support a hypothesis, but it is not a per-operation causal trace.
 */
import type {
  ImageBusinessOperation,
  ImageCheck,
  ImageScenarioName,
  ImageScenarioResult,
  ImageScenarioWindow,
} from '../contracts';
import { IMAGE_LEVEL } from '../level';
import {
  formatCheckNumber,
  formatDataSize,
  formatFractionPercent,
  formatMilliseconds,
} from './image-format';
import { formatInteger } from '../../ui/format';
import { IMAGE_BUSINESS_OPERATION_LABELS } from './image-meta';

export interface ImageGateCandidate {
  /** Short, player-facing hypothesis. */
  readonly cause: string;
  /** Conditional explanation with the evidence that supports it. */
  readonly detail: string;
}

export interface ImageGateExplanation {
  readonly checkId: string;
  readonly label: string;
  /** At most the two strongest candidates supported by this case. */
  readonly possibleCauses: readonly ImageGateCandidate[];
  /** At most two short evidence lines. */
  readonly evidence: readonly string[];
  /** At most two next checks. */
  readonly checkNext: string[];
  readonly caveat: string;
}

interface ScoredCandidate extends ImageGateCandidate {
  readonly score: number;
}

type GateScope = 'case' | 'incident' | 'recovery';

const OPERATION_LABELS = IMAGE_BUSINESS_OPERATION_LABELS;

const CASE_CAVEAT =
  'Aggregate case data supports these hypotheses but cannot prove the exact stage. Confirm them in Operations and the node and link details before changing capacity.';

const WINDOW_CAVEAT =
  'This gate covers one window only. Error-code totals and node and link meters describe the full case, so they cannot prove what happened inside the window.';

const NO_TRACE_NOTE =
  'Node and link meters are full-case aggregates, not per-operation causal traces.';

function caseCaveat(scenario: ImageScenarioResult): string {
  return isIncidentScenario(scenario.name)
    ? `${CASE_CAVEAT} This is a full-case gate: it includes the incident window and cannot prove what happened inside it.`
    : CASE_CAVEAT;
}

function operationLabel(operation: ImageBusinessOperation | undefined): string {
  return operation ? OPERATION_LABELS[operation] : 'Request';
}

function deadlineMs(operation: ImageBusinessOperation): number {
  return IMAGE_LEVEL.slo.deadlinesMs[operation];
}

/** Incident and recovery windows share the incident p99.9 thresholds. */
function windowP999LimitMs(operation: ImageBusinessOperation): number {
  const slo = IMAGE_LEVEL.slo.incident;
  return operation === 'upload'
    ? slo.uploadP999Ms
    : operation === 'search'
      ? slo.searchP999Ms
      : slo.detailP999Ms;
}

function scopeOf(
  check: ImageCheck,
  scenario: ImageScenarioResult,
): { scope: GateScope; window: ImageScenarioWindow | null } {
  if (check.id.startsWith('incident:')) {
    return { scope: 'incident', window: scenario.incidentWindow };
  }
  if (check.id.startsWith('recovery:')) {
    return { scope: 'recovery', window: scenario.recoveryWindow };
  }
  return { scope: 'case', window: null };
}

function isIncidentScenario(name: ImageScenarioName): boolean {
  return name !== 'normal' && name !== 'peak';
}

function windowRange(window: ImageScenarioWindow): string {
  return `${formatMilliseconds(window.fromMs)}–${formatMilliseconds(window.toMs)}`;
}

function topCandidates(candidates: readonly ScoredCandidate[]): ImageGateCandidate[] {
  return [...candidates]
    .sort((left, right) => right.score - left.score)
    .slice(0, 2)
    .map(({ cause, detail }) => ({ cause, detail }));
}

/**
 * Engine failure codes name a class of outcome, not a unique cause. The copy
 * here stays on that boundary and avoids inferring internals the code cannot
 * show.
 */
function errorCodeCandidate(
  code: string,
  count: number,
  operation: ImageBusinessOperation,
): ImageGateCandidate {
  const label = operationLabel(operation).toLowerCase();
  const requests = `${formatInteger(count)} ${label} ${count === 1 ? 'request' : 'requests'}`;
  switch (code) {
    case 'no_healthy_route':
      return {
        cause: 'No healthy route',
        detail: `${requests} could not be routed to a healthy endpoint. This is a routing and availability failure class; it does not say which node, replica or region is at fault.`,
      };
    case 'endpoint_unavailable':
      return {
        cause: 'Endpoint unavailable',
        detail: `${requests} reached an endpoint that was unavailable. The count attributes the outcome to that endpoint class, not to a local root cause.`,
      };
    case 'metadata_quorum_unavailable':
      return {
        cause: 'Metadata quorum unavailable',
        detail: `${requests} could not reach a metadata write quorum. This may point at metadata replicas or routing, but the code does not identify which one.`,
      };
    case 'metadata_index_missing':
      return {
        cause: 'Metadata index incomplete',
        detail: `${requests} found no usable metadata index entry. The index mode and write path are plausible places to look, not proven causes.`,
      };
    case 'metadata_origin_unavailable':
      return {
        cause: 'Metadata origin unavailable',
        detail: `${requests} could not read the metadata origin. Reads could be stale or incomplete; the code does not prove the origin was the root cause.`,
      };
    case 'memory_rejected':
      return {
        cause: 'Memory admission rejection',
        detail: `${requests} were rejected under memory pressure. Compare node memory with its limit before assuming that more memory is the fix.`,
      };
    case 'task_interrupted':
      return {
        cause: 'Interrupted or rejected work',
        detail: `${requests} ended as task_interrupted. The engine may also use this code for work rejected under load, so the count does not prove that all of these requests were in flight.`,
      };
    case 'deadline_exceeded':
      return {
        cause: 'Request deadline exceeded',
        detail: `${requests} reached the ${formatMilliseconds(deadlineMs(operation))} request deadline. Queueing or a slow stage could consume that budget; the code does not name the stage.`,
      };
    case 'queue_full':
      return {
        cause: 'Queue full',
        detail: `${requests} were refused because a queue was full. Queue capacity or a slow downstream stage could be responsible.`,
      };
    default:
      return {
        cause: code.replaceAll('_', ' '),
        detail: `${requests} failed with engine code "${code}". The code identifies a failure class, not a unique cause.`,
      };
  }
}

function rankedCodeCandidates(
  scenario: ImageScenarioResult,
  operation: ImageBusinessOperation,
): ScoredCandidate[] {
  return Object.entries(scenario.operations[operation].errorsByCode)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([code, count]) => ({
      ...errorCodeCandidate(code, count, operation),
      score: count,
    }));
}

/** Largest attributed node count only; never summed across nodes. */
function nodeAttributionEvidence(scenario: ImageScenarioResult): string | null {
  const largest = scenario.nodes
    .filter((node) => node.errors > 0)
    .sort((left, right) => right.errors - left.errors)[0];
  return largest
    ? `The largest node-attributed error count is ${formatInteger(largest.errors)} at ${largest.label}; these are raw node outcomes by final route, not operation totals or local root causes.`
    : null;
}

function codeEvidence(
  scenario: ImageScenarioResult,
  operation: ImageBusinessOperation,
): string {
  const entries = Object.entries(scenario.operations[operation].errorsByCode)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1]);
  const codes =
    entries.length === 0
      ? 'no engine error code was recorded'
      : `engine error codes ${entries
          .slice(0, 6)
          .map(([code, count]) => `${code} ${formatInteger(count)}`)
          .join(', ')}`;
  return `${operationLabel(operation)} outcomes report ${codes}; a code names a failure class, not a unique cause.`;
}

function availabilityExplanation(
  scenario: ImageScenarioResult,
  check: ImageCheck,
  operation: ImageBusinessOperation,
  scope: GateScope,
  window: ImageScenarioWindow | null,
): ImageGateExplanation {
  const minimumSamples = IMAGE_LEVEL.qualification.minimumP999Samples;

  if (scope !== 'case' && window) {
    const item = window.operations[operation];
    const windowLabel = scope === 'incident' ? 'incident' : 'final recovery';
    const evidence = [
      `${operationLabel(operation)} availability in the ${windowLabel} window (${windowRange(window)}) is ${formatFractionPercent(item.availability, 2)} over ${formatInteger(item.offered)} offered requests; the window limit is ${formatCheckNumber(check.limit, check.unit)}.`,
    ];
    const candidates: ScoredCandidate[] = [];
    const checkNext = [
      'Compare the full-case gate with the incident and recovery window gates; full-case totals cannot explain a window.',
      'Inspect the affected region, node health and route coverage for this case.',
    ];

    if (!item.latencyOk) {
      if (item.sampleCount < minimumSamples) {
        evidence.push(
          `The window p99.9 is ${formatMilliseconds(
            item.latencyP999Ms,
          )} against the ${formatMilliseconds(
            windowP999LimitMs(operation),
          )} window SLO over ${formatInteger(
            item.sampleCount,
          )} successful samples, below the ${formatInteger(
            minimumSamples,
          )} needed to qualify p99.9. Treat that latency part as a sampling limitation, not proof of slowness.`,
        );
        candidates.push({
          cause: 'Window p99.9 is not sample-qualified',
          detail: `Only ${formatInteger(item.sampleCount)} successful window samples are available. This gate cannot distinguish a real latency miss from an unstable p99.9 estimate.`,
          score: 1.5,
        });
      } else {
        evidence.push(
          `Successful p99.9 in the same window is ${formatMilliseconds(
            item.latencyP999Ms,
          )} against the ${formatMilliseconds(
            windowP999LimitMs(operation),
          )} window SLO over ${formatInteger(item.sampleCount)} samples.`,
        );
        candidates.push({
          cause: 'Sustained latency inside the window',
          detail: `The window p99.9 is sample-qualified and above its ${formatMilliseconds(
            windowP999LimitMs(operation),
          )} target. Slow processing or queueing during the fault is plausible, but the window aggregate does not show which stage was slow.`,
          score: 0.8,
        });
      }
    } else {
      evidence.push(
        'The window latency sample stayed inside its SLO, so the failure is in window availability rather than window latency.',
      );
    }

    const fault = scenario.fault;
    if (fault.kind !== 'none') {
      const target = fault.target ?? fault.region ?? '';
      const described = target ? `${fault.kind} (${target})` : fault.kind;
      candidates.push({
        cause:
          scope === 'incident'
            ? 'Injected fault inside the window'
            : 'Resources still recovering',
        detail:
          scope === 'incident'
            ? `The case injects a ${described} fault during the measured window. That is consistent with the shortfall, but the window data still does not prove which internal stage failed.`
            : 'The final window starts before every cache, replica and queue is guaranteed to have recovered. Slow recovery is plausible; the window data cannot prove it.',
        score: 1,
      });
    } else {
      candidates.push({
        cause: 'Window failure without a named fault',
        detail:
          'This window failed with no injected fault. The aggregate window counts alone cannot identify whether routing, capacity or a downstream stage is responsible.',
        score: 0.5,
      });
    }

    return {
      checkId: check.id,
      label: check.label,
      possibleCauses: topCandidates(candidates),
      evidence,
      checkNext,
      caveat: WINDOW_CAVEAT,
    };
  }

  const metrics = scenario.operations[operation];
  const failed = Math.max(0, metrics.counts.offered - metrics.counts.success);
  const evidence = [
    `${operationLabel(operation)} availability is ${formatFractionPercent(metrics.availability, 2)} over ${formatInteger(metrics.counts.offered)} offered requests; ${formatInteger(metrics.counts.success)} succeeded and ${formatInteger(failed)} failed or were incomplete.`,
  ];
  const codes = codeEvidence(scenario, operation);
  const attribution = nodeAttributionEvidence(scenario);
  evidence.push(attribution ? `${codes} ${attribution}` : codes);

  const candidates = rankedCodeCandidates(scenario, operation);
  const checkNext: string[] = [];
  if (candidates.length === 0) {
    checkNext.push(
      'Aggregate case data cannot identify the exact failing stage. Inspect Operations and the node and link tables for this case before adding capacity.',
    );
  } else {
    checkNext.push(
      'Compare offered, success and error-code counts in Operations for this case.',
      'Inspect healthy instances and node and link rows for the region with attributed failures.',
    );
  }

  return {
    checkId: check.id,
    label: check.label,
    possibleCauses: topCandidates(candidates),
    evidence,
    checkNext,
    caveat: caseCaveat(scenario),
  };
}

function strongestLink(scenario: ImageScenarioResult): ImageScenarioResult['links'][number] | null {
  let best: ImageScenarioResult['links'][number] | null = null;
  for (const link of scenario.links) {
    if (!best || link.peakUtilization > best.peakUtilization) {
      best = link;
    }
  }
  return best;
}

function strongestIoNode(scenario: ImageScenarioResult): ImageScenarioResult['nodes'][number] | null {
  let best: ImageScenarioResult['nodes'][number] | null = null;
  for (const node of scenario.nodes) {
    if (!best || node.ioUtilizationPeak > best.ioUtilizationPeak) {
      best = node;
    }
  }
  return best;
}

function ioPressureNote(node: ImageScenarioResult['nodes'][number]): string {
  return `${node.label} reports I/O average ${formatFractionPercent(
    node.ioUtilizationAvg,
    1,
  )} and peak ${formatFractionPercent(
    node.ioUtilizationPeak,
    1,
  )}, CPU average ${formatFractionPercent(
    node.cpuUtilizationAvg,
    1,
  )} and memory peak ${formatDataSize(
    node.memoryBytesPeak,
  )} of ${formatDataSize(
    node.memoryLimitBytes,
  )}; an isolated I/O peak is a pressure signal, not proof that I/O caused these slow successes.`;
}

function latencyExplanation(
  scenario: ImageScenarioResult,
  check: ImageCheck,
  operation: ImageBusinessOperation,
): ImageGateExplanation {
  const metrics = scenario.operations[operation];
  const limit = check.limit ?? metrics.latencyP999Ms;
  const samples = metrics.p999SampleCount;
  const minimum = metrics.minimumP999Samples;
  const deadline = deadlineMs(operation);

  if (!metrics.p999Reliable || samples < minimum) {
    return {
      checkId: check.id,
      label: check.label,
      possibleCauses: [
        {
          cause: 'Insufficient p99.9 samples',
          detail: `This case has ${formatInteger(samples)} successful ${operationLabel(operation).toLowerCase()} samples; p99.9 needs at least ${formatInteger(minimum)}. That is a sampling limitation, not proof that latency is inside or outside the target.`,
        },
      ],
      evidence: [
        `${formatInteger(samples)} of ${formatInteger(minimum)} required successful samples were available for p99.9.`,
        'A p99.9 from a small sample is shown for reference but is not a qualified latency measurement.',
      ],
      checkNext: [
        'Collect more successful samples before drawing a latency conclusion; do not add capacity from this gate alone.',
        'Use p50, p95 and p99 with their sample counts as supporting evidence.',
      ],
      caveat:
        'The gate fails because the p99.9 sample is too small to qualify. Treat it as a sampling failure, not as proof of a latency problem.',
    };
  }

  const candidates: ScoredCandidate[] = [];
  const actual = check.actual ?? metrics.latencyP999Ms;
  const evidence: string[] = [
    `${operationLabel(operation)} successful p99.9 is ${formatMilliseconds(actual)} against the ${formatMilliseconds(limit)} SLO over ${formatInteger(samples)} samples.`,
  ];
  if (limit < deadline) {
    evidence[0] = `${evidence[0]} The ${formatMilliseconds(limit)} gate is a success SLO, not the ${formatMilliseconds(deadline)} request deadline, so a request can succeed and still miss the SLO.`;
  }
  const ioNode = strongestIoNode(scenario);
  const ioNote =
    ioNode && ioNode.ioUtilizationPeak >= 0.85 ? ` ${ioPressureNote(ioNode)}` : '';
  const link = strongestLink(scenario);
  // A shared-channel peak is context only. Without queue or path evidence it
  // must not be promoted to a possible cause.
  const linkNote =
    link && link.peakUtilization >= 0.85
      ? ` ${link.label} peaked at ${formatFractionPercent(
          link.peakUtilization,
          1,
        )} of capacity over the full case; a shared-channel peak is context, not proof that this request path was affected.`
      : '';
  // The operation queue-wait value is the first nonzero started-stage wait,
  // not cumulative queue time. Only the full-case node queue-wait p95 is used,
  // and it is named as shared evidence rather than attributed to this operation.
  const nodeQueue = [...scenario.nodes]
    .filter((node) => node.queueWaitP95Ms > 0)
    .sort((left, right) => right.queueWaitP95Ms - left.queueWaitP95Ms)[0];
  if (nodeQueue && nodeQueue.queueWaitP95Ms >= limit * 0.5) {
    candidates.push({
      cause: `Node queue wait at ${nodeQueue.label}`,
      detail: `This node reports a full-case foreground queue-wait p95 of ${formatMilliseconds(
        nodeQueue.queueWaitP95Ms,
      )} for attempts enqueued in the measured window. If that wait applies to this request path, it could consume most of the ${formatMilliseconds(
        limit,
      )} budget, but it is shared full-case evidence, not an ${operationLabel(
        operation,
      ).toLowerCase()}-specific trace.`,
      score: nodeQueue.queueWaitP95Ms / limit,
    });
    evidence.push(
      `${nodeQueue.label} foreground queue-wait p95 is ${formatMilliseconds(
        nodeQueue.queueWaitP95Ms,
      )} (full case; includes attempts cancelled before starting, excludes background replication). This wait is shared across operations and must not be subtracted from end-to-end p99.9 to isolate a stage.${ioNote}${linkNote}`,
    );
  } else {
    evidence.push(
      'No node queue-wait signal is strong enough to explain this SLO miss on its own. ' +
        `${NO_TRACE_NOTE}${ioNote}${linkNote}`,
    );
  }

  const checkNext: string[] = [];
  if (candidates.length === 0) {
    evidence[evidence.length - 1] =
      `${evidence[evidence.length - 1]} No queue or request-path signal is strong enough to name a stage.`;
    checkNext.push(
      'Aggregate case data cannot identify the exact slow stage. Inspect Operations and the node and link details instead of adding capacity blindly.',
      'Compare p50, p95, p99 and p99.9 with queue-wait p95 before choosing a change.',
    );
  } else {
    checkNext.push(
      'Compare p50, p95, p99 and p99.9 with queue-wait p95 in Operations for this case.',
      'Inspect the busiest node and shared link rows, then change one hypothesis at a time and re-run.',
    );
  }

  return {
    checkId: check.id,
    label: check.label,
    possibleCauses: topCandidates(candidates),
    evidence: evidence.slice(0, 2),
    checkNext,
    caveat: caseCaveat(scenario),
  };
}

/**
 * One explanation for a failed gate in the selected scenario. Gates outside
 * availability, latency and window sample qualification return null: they keep
 * their existing raw message instead of receiving speculative new theory.
 */
export function imageGateExplanation(
  scenario: ImageScenarioResult,
  check: ImageCheck,
): ImageGateExplanation | null {
  if (check.passed || !check.operation) {
    return null;
  }
  const { scope, window } = scopeOf(check, scenario);
  if (scope !== 'case') {
    return availabilityExplanation(scenario, check, check.operation, scope, window);
  }
  // Gate ids are stable in the engine, but the unit is the reliable shape:
  // a latency gate reports milliseconds and an availability gate reports a
  // ratio. Both paths stay inside the evidence-backed family.
  if (check.id.startsWith('p999:') || check.unit === 'ms') {
    return latencyExplanation(scenario, check, check.operation);
  }
  if (check.id.startsWith('availability:') || check.unit === 'ratio') {
    return availabilityExplanation(scenario, check, check.operation, scope, window);
  }
  return null;
}

export function imageGateExplanations(
  scenario: ImageScenarioResult,
): ImageGateExplanation[] {
  return scenario.checks
    .map((check) => imageGateExplanation(scenario, check))
    .filter((explanation): explanation is ImageGateExplanation => explanation !== null);
}

/** Keyed by check id; ids are unique inside one scenario result. */
export function imageGateExplanationMap(
  scenario: ImageScenarioResult,
): ReadonlyMap<string, ImageGateExplanation> {
  return new Map(
    imageGateExplanations(scenario).map((explanation) => [
      explanation.checkId,
      explanation,
    ]),
  );
}
