import {
  audienceGraphDigest,
  type AudienceCaseResult,
  type AudienceEvaluation,
  type AudienceGraph,
  type AudienceIssue,
  type AudienceNodeMetrics,
} from '../index';
import { formatInteger } from '../../ui/format';

export type AudienceProblemSeverity = 'error' | 'warning' | 'info';

export type AudienceMeterMetric =
  | 'cpu'
  | 'ram'
  | 'queue'
  | 'network'
  | 'tasks'
  | 'health';

export interface AudienceProblem {
  severity: AudienceProblemSeverity;
  messages: string[];
  byMetric: Partial<Record<AudienceMeterMetric, string[]>>;
  /** A graph validation/config check, not measured runtime failure. */
  validation: boolean;
  /** Actual measured engine/local runtime evidence. */
  runtime: boolean;
}

export interface AudienceProblemMaps {
  byNode: ReadonlyMap<string, AudienceProblem>;
  byEdge: ReadonlyMap<string, AudienceProblem>;
}

const SEVERITY_RANK: Readonly<Record<AudienceProblemSeverity, number>> = {
  info: 0,
  warning: 1,
  error: 2,
};

function worse(
  left: AudienceProblemSeverity,
  right: AudienceProblemSeverity,
): AudienceProblemSeverity {
  return SEVERITY_RANK[left] >= SEVERITY_RANK[right] ? left : right;
}

export function uniqueAudienceIssues(
  issues: readonly AudienceIssue[],
): AudienceIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.severity}|${issue.code}|${issue.message}|${
      issue.nodeId ?? ''
    }|${issue.edgeId ?? ''}|${issue.caseId ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * A completed result becomes a *previous* result when the semantic graph or
 * seed changes. Positions and labels are not part of the digest.
 */
export function audienceResultStale(
  evaluation: AudienceEvaluation | null,
  resultDigest: string | null,
  resultSeed: number | null,
  graph: AudienceGraph,
  seed: number,
): boolean {
  if (!evaluation || resultDigest === null || resultSeed === null) {
    return false;
  }
  return resultSeed !== seed || resultDigest !== audienceGraphDigest(graph);
}

function emptyProblem(): AudienceProblem {
  return {
    severity: 'info',
    messages: [],
    byMetric: {},
    validation: false,
    runtime: false,
  };
}

function addProblem(
  map: Map<string, AudienceProblem>,
  id: string,
  severity: AudienceProblemSeverity,
  message: string,
  metric: AudienceMeterMetric | undefined,
  origin: 'validation' | 'runtime',
): void {
  const existing = map.get(id) ?? emptyProblem();
  const messages = existing.messages.includes(message)
    ? existing.messages
    : [...existing.messages, message];
  const byMetric = { ...existing.byMetric };
  if (metric) {
    const list = byMetric[metric] ?? [];
    if (!list.includes(message)) {
      byMetric[metric] = [...list, message];
    }
  }
  map.set(id, {
    severity: worse(existing.severity, severity),
    messages,
    byMetric,
    validation: existing.validation || origin === 'validation',
    runtime: existing.runtime || origin === 'runtime',
  });
}

function metricForIssue(issue: AudienceIssue): AudienceMeterMetric | undefined {
  const name = (issue.metric ?? issue.code).toLowerCase();
  if (name.includes('cpu')) {
    return 'cpu';
  }
  if (name.includes('ram') || name.includes('memory')) {
    return 'ram';
  }
  if (name.includes('queue') || name.includes('wait')) {
    return 'queue';
  }
  if (
    name.includes('net') ||
    name.includes('nic') ||
    name.includes('bandwidth')
  ) {
    return 'network';
  }
  if (
    name.includes('health') ||
    name.includes('crash') ||
    name.includes('instance')
  ) {
    return 'health';
  }
  if (
    name.includes('reject') ||
    name.includes('timeout') ||
    name.includes('task') ||
    name.includes('work')
  ) {
    return 'tasks';
  }
  return undefined;
}

/**
 * Local failure evidence only. A brief instantaneous CPU/RAM/NIC/queue peak is
 * ordinary resource detail and is shown in meters/reports, never promoted to a
 * node error. A node is highlighted only when the engine attaches an issue or
 * that component actually rejects, times out, interrupts or loses health.
 */
function addLocalTaskEvidence(
  map: Map<string, AudienceProblem>,
  metrics: AudienceNodeMetrics,
): void {
  const { nodeId } = metrics;

  if (metrics.health.state === 'degraded' || metrics.health.crashEvents > 0) {
    addProblem(
      map,
      nodeId,
      'warning',
      `${metrics.label} recorded ${formatInteger(
        metrics.health.crashEvents,
      )} crash event${metrics.health.crashEvents === 1 ? '' : 's'} and ${
        metrics.health.healthyInstances
      }/${metrics.health.totalInstances} healthy at the end of this case.`,
      'health',
      'runtime',
    );
  }
  if (metrics.tasks.rejected > 0) {
    addProblem(
      map,
      nodeId,
      'error',
      `${metrics.label} rejected ${formatInteger(
        metrics.tasks.rejected,
      )} task${metrics.tasks.rejected === 1 ? '' : 's'} locally in this case.`,
      'tasks',
      'runtime',
    );
  }
  if (metrics.tasks.timedOut > 0) {
    addProblem(
      map,
      nodeId,
      'warning',
      `${metrics.label} timed out ${formatInteger(
        metrics.tasks.timedOut,
      )} local task${metrics.tasks.timedOut === 1 ? '' : 's'}.`,
      'tasks',
      'runtime',
    );
  }
  if (metrics.tasks.interrupted > 0) {
    addProblem(
      map,
      nodeId,
      'warning',
      `${metrics.label} interrupted ${formatInteger(
        metrics.tasks.interrupted,
      )} task${metrics.tasks.interrupted === 1 ? '' : 's'} during the case.`,
      'tasks',
      'runtime',
    );
  }
}

/**
 * Validation and engine issues are always actionable. Local task/health
 * evidence is applied only to a current (non-stale) case. Occupancy alone never
 * creates a problem mark.
 */
export function audienceProblemMaps(
  issues: readonly AudienceIssue[],
  caseResult: AudienceCaseResult | null,
  issueOrigin: 'validation' | 'runtime' = 'runtime',
): AudienceProblemMaps {
  const byNode = new Map<string, AudienceProblem>();
  const byEdge = new Map<string, AudienceProblem>();

  for (const issue of uniqueAudienceIssues(issues)) {
    if (issue.nodeId) {
      addProblem(
        byNode,
        issue.nodeId,
        issue.severity,
        issue.message,
        metricForIssue(issue),
        issueOrigin,
      );
    }
    if (issue.edgeId) {
      addProblem(
        byEdge,
        issue.edgeId,
        issue.severity,
        issue.message,
        undefined,
        issueOrigin,
      );
    }
  }

  if (caseResult) {
    for (const metrics of caseResult.nodes) {
      addLocalTaskEvidence(byNode, metrics);
    }
  }

  return { byNode, byEdge };
}

/**
 * Combine graph-validation checks with measured runtime evidence for one
 * canvas. The two origins stay distinguishable so a starter/incomplete graph
 * never looks like a failed simulation.
 */
export function mergeAudienceProblemMaps(
  ...maps: readonly AudienceProblemMaps[]
): AudienceProblemMaps {
  const byNode = new Map<string, AudienceProblem>();
  const byEdge = new Map<string, AudienceProblem>();
  const mergeInto = (
    target: Map<string, AudienceProblem>,
    source: ReadonlyMap<string, AudienceProblem>,
  ) => {
    for (const [id, problem] of source) {
      const existing = target.get(id);
      if (!existing) {
        target.set(id, { ...problem });
        continue;
      }
      target.set(id, {
        severity: worse(existing.severity, problem.severity),
        messages: [
          ...existing.messages,
          ...problem.messages.filter(
            (message) => !existing.messages.includes(message),
          ),
        ],
        byMetric: { ...existing.byMetric, ...problem.byMetric },
        validation: existing.validation || problem.validation,
        runtime: existing.runtime || problem.runtime,
      });
    }
  };
  for (const map of maps) {
    mergeInto(byNode, map.byNode);
    mergeInto(byEdge, map.byEdge);
  }
  return { byNode, byEdge };
}
