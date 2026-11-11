import type { NodeMetric, SimulationSnapshot } from '../../domain';

export function snapshotNodeMetric(
  snapshot: SimulationSnapshot | null,
  nodeId: string,
): NodeMetric | null {
  return snapshot?.nodes.find((metric) => metric.nodeId === nodeId) ?? null;
}
