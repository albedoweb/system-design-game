import {
  scoreboardGraphDigest,
  type ScoreboardEvaluation,
  type ScoreboardGraph,
  type ScoreboardIssue,
  type ScoreboardNodeMetrics,
} from '../index';
import { formatInteger } from '../../ui/format';

export type ScoreboardProblemSeverity = 'error' | 'warning' | 'info';

export type ScoreboardMeterMetric = 'cpu' | 'ram' | 'queue' | 'network' | 'tasks';

export interface ScoreboardProblem {
  severity: ScoreboardProblemSeverity;
  messages: string[];
  byMetric: Partial<Record<ScoreboardMeterMetric, string[]>>;
}

export interface ScoreboardProblemMaps {
  byNode: ReadonlyMap<string, ScoreboardProblem>;
  byEdge: ReadonlyMap<string, ScoreboardProblem>;
}

const SEVERITY_RANK: Readonly<Record<ScoreboardProblemSeverity, number>> = {
  info: 0,
  warning: 1,
  error: 2,
};

function worse(
  left: ScoreboardProblemSeverity,
  right: ScoreboardProblemSeverity,
): ScoreboardProblemSeverity {
  return SEVERITY_RANK[left] >= SEVERITY_RANK[right] ? left : right;
}

export function uniqueScoreboardIssues(
  issues: readonly ScoreboardIssue[],
): ScoreboardIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.severity}|${issue.code}|${issue.message}|${
      issue.nodeId ?? ''
    }|${issue.edgeId ?? ''}`;
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
export function scoreboardResultStale(
  evaluation: ScoreboardEvaluation | null,
  resultDigest: string | null,
  resultSeed: number | null,
  graph: ScoreboardGraph,
  seed: number,
): boolean {
  if (!evaluation || resultDigest === null || resultSeed === null) {
    return false;
  }
  return (
    resultSeed !== seed || resultDigest !== scoreboardGraphDigest(graph)
  );
}

function emptyProblem(): ScoreboardProblem {
  return { severity: 'info', messages: [], byMetric: {} };
}

function addProblem(
  map: Map<string, ScoreboardProblem>,
  id: string,
  severity: ScoreboardProblemSeverity,
  message: string,
  metric?: ScoreboardMeterMetric,
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
  });
}

function metricForIssue(issue: ScoreboardIssue): ScoreboardMeterMetric | undefined {
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
 * that component actually rejects, times out or interrupts its own work.
 */
function addLocalTaskEvidence(
  map: Map<string, ScoreboardProblem>,
  metrics: ScoreboardNodeMetrics,
): void {
  const { nodeId } = metrics;

  if (metrics.tasks.rejected > 0) {
    addProblem(
      map,
      nodeId,
      'error',
      `${metrics.label} rejected ${formatInteger(
        metrics.tasks.rejected,
      )} task${metrics.tasks.rejected === 1 ? '' : 's'} locally in this run.`,
      'tasks',
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
    );
  }
  if (metrics.tasks.interrupted > 0) {
    addProblem(
      map,
      nodeId,
      'warning',
      `${metrics.label} interrupted ${formatInteger(
        metrics.tasks.interrupted,
      )} task${metrics.tasks.interrupted === 1 ? '' : 's'} during the run.`,
      'tasks',
    );
  }
}

/**
 * Validation and engine issues are always actionable. Local task evidence is
 * applied only to a current (non-stale) result. Occupancy alone never creates a
 * problem mark.
 */
export function scoreboardProblemMaps(
  issues: readonly ScoreboardIssue[],
  evaluation: ScoreboardEvaluation | null,
): ScoreboardProblemMaps {
  const byNode = new Map<string, ScoreboardProblem>();
  const byEdge = new Map<string, ScoreboardProblem>();

  for (const issue of uniqueScoreboardIssues(issues)) {
    if (issue.nodeId) {
      addProblem(
        byNode,
        issue.nodeId,
        issue.severity,
        issue.message,
        metricForIssue(issue),
      );
    }
    if (issue.edgeId) {
      addProblem(byEdge, issue.edgeId, issue.severity, issue.message);
    }
  }

  if (evaluation) {
    for (const metrics of evaluation.nodes) {
      addLocalTaskEvidence(byNode, metrics);
    }
  }

  return { byNode, byEdge };
}

export function scoreboardProblemForNode(
  nodeId: string,
  maps: ScoreboardProblemMaps,
): ScoreboardProblem | null {
  return maps.byNode.get(nodeId) ?? null;
}
