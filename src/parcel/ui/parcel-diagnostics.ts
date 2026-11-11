import type {
  ParcelCheck,
  ParcelDiagnostic,
  ParcelEvaluation,
  ParcelGraph,
  ParcelHorizonYears,
  ParcelIssue,
  ParcelOperation,
} from '../contracts';
import { parcelSemanticDigest } from '../graph';

export type ParcelProblemSeverity = 'error' | 'warning' | 'info';

export interface ParcelProblem {
  severity: ParcelProblemSeverity;
  messages: string[];
}

export interface ParcelProblemMaps {
  byNode: ReadonlyMap<string, ParcelProblem>;
  byEdge: ReadonlyMap<string, ParcelProblem>;
}

const SEVERITY_RANK: Readonly<Record<ParcelProblemSeverity, number>> = {
  info: 0,
  warning: 1,
  error: 2,
};

function worse(
  a: ParcelProblemSeverity,
  b: ParcelProblemSeverity,
): ParcelProblemSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function addProblem(
  map: Map<string, ParcelProblem>,
  id: string,
  severity: ParcelProblemSeverity,
  message: string,
): void {
  const existing = map.get(id);
  if (!existing) {
    map.set(id, { severity, messages: [message] });
    return;
  }
  map.set(id, {
    severity: worse(existing.severity, severity),
    messages: existing.messages.includes(message)
      ? existing.messages
      : [...existing.messages, message],
  });
}

export function parcelRouteTarget(
  graph: ParcelGraph,
  operation: ParcelOperation,
): string | null {
  if (
    operation !== 'status' &&
    operation !== 'history' &&
    operation !== 'ingest' &&
    operation !== 'report'
  ) {
    return null;
  }
  const app = graph.nodes.find((node) => node.kind === 'app');
  if (!app) {
    return null;
  }
  return (
    graph.edges.find(
      (edge) => edge.source === app.id && edge.operation === operation,
    )?.target ?? null
  );
}

/** Validation can report the same capability warning once per read route. */
export function uniqueParcelIssues(
  issues: readonly ParcelIssue[],
): ParcelIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.severity}|${issue.code}|${issue.message}|${issue.nodeId ?? ''}|${issue.edgeId ?? ''}|${issue.horizonYears ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function checkNodeId(graph: ParcelGraph, check: ParcelCheck): string | null {
  if (check.nodeId) {
    return check.nodeId;
  }
  if (check.operation) {
    return parcelRouteTarget(graph, check.operation);
  }
  return null;
}

/**
 * Node/edge highlighting is derived from actionable issues, failed checks and
 * engine diagnostics. Saturation alone is not treated as a failure here; the
 * engine has to explain why a resource matters.
 */
export function parcelProblemMaps(
  graph: ParcelGraph,
  issues: readonly ParcelIssue[],
  evaluation: ParcelEvaluation | null,
  horizonYears: ParcelHorizonYears,
): ParcelProblemMaps {
  const nodeProblems = new Map<string, ParcelProblem>();
  const edgeProblems = new Map<string, ParcelProblem>();

  for (const issue of issues) {
    if (issue.nodeId) {
      addProblem(nodeProblems, issue.nodeId, issue.severity, issue.message);
    }
    if (issue.edgeId) {
      addProblem(edgeProblems, issue.edgeId, issue.severity, issue.message);
    }
  }

  if (evaluation) {
    for (const check of evaluation.checks) {
      if (check.passed) {
        continue;
      }
      const nodeId = checkNodeId(graph, check);
      if (nodeId) {
        addProblem(
          nodeProblems,
          nodeId,
          check.severity === 'required' ? 'error' : 'warning',
          check.message,
        );
      }
    }
    if (evaluation.status === 'ok') {
      const horizon = evaluation.horizons.find(
        (item) => item.horizonYears === horizonYears,
      );
      if (horizon) {
        for (const diagnostic of horizon.diagnostics) {
          const nodeId =
            diagnostic.nodeId ??
            (diagnostic.operation
              ? parcelRouteTarget(graph, diagnostic.operation)
              : null);
          if (nodeId) {
            addProblem(nodeProblems, nodeId, diagnostic.severity, diagnostic.message);
          }
          if (diagnostic.edgeId) {
            addProblem(
              edgeProblems,
              diagnostic.edgeId,
              diagnostic.severity,
              diagnostic.message,
            );
          }
        }
        for (const check of horizon.checks) {
          if (check.passed) {
            continue;
          }
          const nodeId = checkNodeId(graph, check);
          if (nodeId) {
            addProblem(
              nodeProblems,
              nodeId,
              check.severity === 'required' ? 'error' : 'warning',
              check.message,
            );
          }
        }
      }
    }
  }

  return { byNode: nodeProblems, byEdge: edgeProblems };
}

export function parcelResultStale(
  evaluation: ParcelEvaluation | null,
  resultDigest: string | null,
  resultSeed: number | null,
  graph: ParcelGraph,
  seed: number,
): boolean {
  if (!evaluation || resultDigest === null || resultSeed === null) {
    return false;
  }
  return resultSeed !== seed || resultDigest !== parcelSemanticDigest(graph);
}

export interface ParcelProblemInput {
  issues: readonly ParcelIssue[];
  diagnostics: readonly ParcelDiagnostic[];
  checks: readonly ParcelCheck[];
}

export function parcelProblemsForNode(
  nodeId: string,
  input: ParcelProblemInput,
  graph: ParcelGraph,
): ParcelProblem {
  const nodeProblems = new Map<string, ParcelProblem>();
  for (const issue of input.issues) {
    if (issue.nodeId === nodeId) {
      addProblem(nodeProblems, nodeId, issue.severity, issue.message);
    }
  }
  for (const diagnostic of input.diagnostics) {
    const targetId =
      diagnostic.nodeId ??
      (diagnostic.operation
        ? parcelRouteTarget(graph, diagnostic.operation)
        : null);
    if (targetId === nodeId) {
      addProblem(nodeProblems, nodeId, diagnostic.severity, diagnostic.message);
    }
  }
  for (const check of input.checks) {
    if (!check.passed && checkNodeId(graph, check) === nodeId) {
      addProblem(
        nodeProblems,
        nodeId,
        check.severity === 'required' ? 'error' : 'warning',
        check.message,
      );
    }
  }
  return nodeProblems.get(nodeId) ?? { severity: 'info', messages: [] };
}
