import type {
  ImageCheck,
  ImageDiagnostic,
  ImageEvaluation,
  ImageGraph,
  ImageIssue,
  ImageRegion,
  ImageScenarioName,
} from '../contracts';
import { imageGraphDigest } from '../graph';

export type ImageProblemSeverity = 'error' | 'warning' | 'info';

/** Resource groups that a node meter can link a reason to. */
export type ImageMeterMetric = 'cpu' | 'ram' | 'io' | 'network' | 'capacity';

export interface ImageProblem {
  severity: ImageProblemSeverity;
  messages: string[];
  byMetric: Partial<Record<ImageMeterMetric, string[]>>;
}

export interface ImageProblemMaps {
  byNode: ReadonlyMap<string, ImageProblem>;
  byEdge: ReadonlyMap<string, ImageProblem>;
  byRegion: ReadonlyMap<ImageRegion, ImageProblem>;
}

const SEVERITY_RANK: Readonly<Record<ImageProblemSeverity, number>> = {
  info: 0,
  warning: 1,
  error: 2,
};

function worse(
  left: ImageProblemSeverity,
  right: ImageProblemSeverity,
): ImageProblemSeverity {
  return SEVERITY_RANK[left] >= SEVERITY_RANK[right] ? left : right;
}

const METRIC_ALIASES: Readonly<Record<string, ImageMeterMetric>> = {
  cpu: 'cpu',
  cpuutilization: 'cpu',
  'cpu-utilization': 'cpu',
  ram: 'ram',
  memory: 'ram',
  'memory-bytes': 'ram',
  rss: 'ram',
  io: 'io',
  disk: 'io',
  iops: 'io',
  throughput: 'io',
  network: 'network',
  nic: 'network',
  bandwidth: 'network',
  link: 'network',
  capacity: 'capacity',
  storage: 'capacity',
  retention: 'capacity',
  diskcapacity: 'capacity',
  'disk-capacity': 'capacity',
};

/**
 * Maps an engine metric name onto a visible node meter. Unknown names stay
 * unmapped: the message is still shown, but no meter claims to explain it.
 */
export function imageMeterMetric(
  metric: string | undefined,
): ImageMeterMetric | null {
  if (!metric) {
    return null;
  }
  const normalized = metric.toLowerCase().replace(/\s+/g, '');
  return METRIC_ALIASES[normalized] ?? null;
}

function emptyProblem(): ImageProblem {
  return { severity: 'info', messages: [], byMetric: {} };
}

function addProblem(
  map: Map<string, ImageProblem>,
  id: string,
  severity: ImageProblemSeverity,
  message: string,
  metric?: string,
): void {
  const existing = map.get(id) ?? emptyProblem();
  const messages = existing.messages.includes(message)
    ? existing.messages
    : [...existing.messages, message];
  const byMetric = { ...existing.byMetric };
  const key = imageMeterMetric(metric);
  if (key) {
    const list = byMetric[key] ?? [];
    if (!list.includes(message)) {
      byMetric[key] = [...list, message];
    }
  }
  map.set(id, {
    severity: worse(existing.severity, severity),
    messages,
    byMetric,
  });
}

export function imageUniqueIssues(issues: readonly ImageIssue[]): ImageIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.severity}|${issue.code}|${issue.message}|${issue.nodeId ?? ''}|${issue.edgeId ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function checkSeverity(check: ImageCheck): ImageProblemSeverity {
  return check.severity === 'required' ? 'error' : 'warning';
}

export interface ImageProblemInput {
  graph: ImageGraph;
  issues: readonly ImageIssue[];
  evaluation: ImageEvaluation | null;
  /** Only this scenario's checks and diagnostics feed the canvas badges. */
  scenario: ImageScenarioName | null;
}

/**
 * Node/edge/region highlighting is derived from actionable validation issues,
 * failed checks and engine diagnostics. A high meter reading on its own is not
 * a failure: the engine has to explain why a resource matters.
 */
export function imageProblemMaps(input: ImageProblemInput): ImageProblemMaps {
  const byNode = new Map<string, ImageProblem>();
  const byEdge = new Map<string, ImageProblem>();
  const byRegion = new Map<ImageRegion, ImageProblem>();
  const regions = new Map(
    input.graph.nodes.map((node) => [node.id, node.region] as const),
  );

  const addNode = (
    nodeId: string,
    severity: ImageProblemSeverity,
    message: string,
    metric?: string,
  ): void => {
    addProblem(byNode, nodeId, severity, message, metric);
    const region = regions.get(nodeId);
    if (region) {
      addProblem(byRegion, region, severity, message);
    }
  };

  for (const issue of input.issues) {
    if (issue.nodeId) {
      addNode(
        issue.nodeId,
        issue.severity,
        issue.message,
        issue.metric ?? issue.code,
      );
    }
    if (issue.edgeId) {
      addProblem(
        byEdge,
        issue.edgeId,
        issue.severity,
        issue.message,
        issue.metric,
      );
    }
  }

  const evaluation = input.evaluation;
  if (evaluation) {
    for (const check of evaluation.checks) {
      if (check.passed || !check.nodeId) {
        continue;
      }
      addNode(check.nodeId, checkSeverity(check), check.message, check.metric);
    }
    for (const diagnostic of evaluation.diagnostics) {
      if (diagnostic.nodeId) {
        addNode(
          diagnostic.nodeId,
          diagnostic.severity,
          diagnostic.message,
          diagnostic.metric,
        );
      }
      if (diagnostic.edgeId) {
        addProblem(
          byEdge,
          diagnostic.edgeId,
          diagnostic.severity,
          diagnostic.message,
          diagnostic.metric,
        );
      }
    }
    const scenario = input.scenario
      ? evaluation.scenarios.find((item) => item.name === input.scenario)
      : null;
    if (scenario) {
      for (const check of scenario.checks) {
        if (check.passed || !check.nodeId) {
          continue;
        }
        addNode(check.nodeId, checkSeverity(check), check.message, check.metric);
      }
      for (const diagnostic of scenario.diagnostics) {
        if (diagnostic.nodeId) {
          addNode(
            diagnostic.nodeId,
            diagnostic.severity,
            diagnostic.message,
            diagnostic.metric,
          );
        }
        if (diagnostic.edgeId) {
          addProblem(
            byEdge,
            diagnostic.edgeId,
            diagnostic.severity,
            diagnostic.message,
            diagnostic.metric,
          );
        }
      }
    }
  }

  return { byNode, byEdge, byRegion };
}

/**
 * A completed result becomes a *previous* result when the semantic graph or the
 * seed changes. Moving or renaming nodes is not semantic and keeps it current.
 */
export function imageResultStale(
  evaluation: ImageEvaluation | null,
  resultDigest: string | null,
  resultSeed: number | null,
  graph: ImageGraph,
  seed: number,
): boolean {
  if (!evaluation || resultDigest === null || resultSeed === null) {
    return false;
  }
  return resultSeed !== seed || resultDigest !== imageGraphDigest(graph);
}

export function imageProblemForNode(
  nodeId: string,
  maps: ImageProblemMaps,
): ImageProblem {
  return maps.byNode.get(nodeId) ?? emptyProblem();
}

export function imageMetricReasons(
  problem: ImageProblem | null,
  metric: ImageMeterMetric,
): string[] {
  return problem?.byMetric[metric] ?? [];
}

export function imageDiagnosticTarget(
  graph: ImageGraph,
  diagnostic: ImageDiagnostic,
): { type: 'node' | 'edge'; id: string } | null {
  if (diagnostic.nodeId) {
    return { type: 'node', id: diagnostic.nodeId };
  }
  if (diagnostic.edgeId) {
    return { type: 'edge', id: diagnostic.edgeId };
  }
  const firstNode = graph.nodes[0];
  return firstNode ? { type: 'node', id: firstNode.id } : null;
}

export function imageCheckTarget(check: ImageCheck): { id: string } | null {
  return check.nodeId ? { id: check.nodeId } : null;
}
