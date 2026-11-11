import type { CartApplicationNode, CartGraph, CartNode } from '../index';
import { cartNodeDisplayName, cartRegionShort } from './cart-meta';

export interface CartReadCoverageGap {
  applicationId: string;
  applicationLabel: string;
  missingIds: string[];
  missingLabels: string[];
}

function isStorage(node: CartNode): boolean {
  return node.kind === 'journal' || node.kind === 'store';
}

function applicationLabel(node: CartNode): string {
  return `${cartNodeDisplayName(node)} (${cartRegionShort(node.region)})`;
}

function storageLabel(node: CartNode): string {
  return `${cartNodeDisplayName(node)} · ${cartRegionShort(node.region)}`;
}

/**
 * A cart read succeeds only if the Application directly reads every storage
 * node that any Application uses as its write target. Replication paths and
 * reads through another Application do not count.
 */
export function cartReadCoverageGaps(graph: CartGraph): CartReadCoverageGap[] {
  const applications = graph.nodes.filter(
    (node): node is CartApplicationNode => node.kind === 'application',
  );
  const storageIds = new Set(graph.nodes.filter(isStorage).map((node) => node.id));
  const writeTargetIds = new Set(
    applications
      .map((node) => node.writeTarget)
      .filter((id) => id !== '' && storageIds.has(id)),
  );
  if (writeTargetIds.size === 0) {
    return [];
  }
  const required = graph.nodes.filter(
    (node) => isStorage(node) && writeTargetIds.has(node.id),
  );

  const gaps: CartReadCoverageGap[] = [];
  for (const application of applications) {
    const missing = required.filter(
      (node) => !application.readTargets.includes(node.id),
    );
    if (missing.length > 0) {
      gaps.push({
        applicationId: application.id,
        applicationLabel: applicationLabel(application),
        missingIds: missing.map((node) => node.id),
        missingLabels: missing.map(storageLabel),
      });
    }
  }
  return gaps;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  const last = items[items.length - 1];
  return `${items.slice(0, -1).join(', ')} and ${last}`;
}

export function cartReadCoverageSentence(gap: CartReadCoverageGap): string {
  return `${gap.applicationLabel} does not read ${joinList(gap.missingLabels)}.`;
}
