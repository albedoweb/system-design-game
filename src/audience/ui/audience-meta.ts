import {
  AUDIENCE_CATALOG,
  AUDIENCE_FAULT_CRITICAL_WINDOW,
  AUDIENCE_LEVEL,
  AUDIENCE_PEAK_WINDOW,
  createAudienceStarterGraph,
  audienceLinkRole,
  type AudienceCaseId,
  type AudienceGraph,
  type AudienceLinkRole,
  type AudienceNodeKind,
  type AudienceSqlReadPlan,
  type AudienceSqlSize,
  type AudienceWindowRange,
} from '../index';
import { formatInteger } from '../../ui/format';

/** General-component vocabulary shared by the canvas, palette and inspector. */

export const AUDIENCE_NODE_KIND_LABELS: Readonly<
  Record<AudienceNodeKind, string>
> = {
  users: 'Users',
  lb: 'Managed Load Balancer',
  app: 'Application',
  sql: 'SQL Database',
  cache: 'Cache',
  worker: 'Worker pool',
};

export const AUDIENCE_NODE_COLORS: Readonly<Record<AudienceNodeKind, string>> = {
  users: '#0e7490',
  lb: '#0369a1',
  app: '#1d6fd8',
  sql: '#7c3aed',
  cache: '#b45309',
  worker: '#15803d',
};

export function audienceLinkLabel(role: AudienceLinkRole | null): string {
  switch (role) {
    case 'traffic':
      return 'traffic';
    case 'ingress':
      return 'ingress';
    case 'balance':
      return 'balance';
    case 'primary':
      return 'ingest / read';
    case 'reads':
      return 'reads';
    case 'fill':
      return 'fill';
    case 'projection':
      return 'jobs';
    default:
      return 'invalid';
  }
}

export function audienceLinkLongLabel(
  role: AudienceLinkRole | null,
): string {
  switch (role) {
    case 'traffic':
      return 'Traffic: Users to the Application pool (always physical slot 0)';
    case 'ingress':
      return 'Ingress: Users to the managed Load Balancer';
    case 'balance':
      return 'Balanced traffic: Load Balancer to the Application pool';
    case 'primary':
      return 'Primary data path: Record activity and direct ranking reads';
    case 'reads':
      return 'Ranking reads: Application to the Cache';
    case 'fill':
      return 'Cache fill: Cache to the primary SQL Database';
    case 'projection':
      return 'SQL jobs: Worker polls and publishes the projection';
    default:
      return 'This pair has no supported route in Live Audience';
  }
}

export function audienceLinkColor(role: AudienceLinkRole | null): string {
  switch (role) {
    case 'traffic':
      return '#0e7490';
    case 'ingress':
      return '#0369a1';
    case 'balance':
      return '#1d6fd8';
    case 'reads':
      return '#b45309';
    case 'fill':
      return '#0f766e';
    case 'projection':
      return '#15803d';
    default:
      return '#64748b';
  }
}

export function audienceRoleOfKinds(
  from: AudienceNodeKind,
  to: AudienceNodeKind,
): AudienceLinkRole | null {
  return audienceLinkRole(from, to);
}

/** True only for the untouched, intentional Users-only onboarding document. */
export function isUntouchedAudienceStarter(graph: AudienceGraph): boolean {
  return (
    JSON.stringify(graph) === JSON.stringify(createAudienceStarterGraph())
  );
}

export function audienceKindLabel(kind: AudienceNodeKind): string {
  return AUDIENCE_NODE_KIND_LABELS[kind];
}

export function audienceSqlSizeLabel(size: AudienceSqlSize): string {
  return size === 'small' ? 'Small' : size === 'medium' ? 'Medium' : 'Large';
}

export function audienceSqlSizeSpec(size: AudienceSqlSize) {
  return AUDIENCE_CATALOG.components.sql.sizes[size];
}

export function audienceReadPlanLabel(plan: AudienceSqlReadPlan): string {
  return AUDIENCE_CATALOG.components.sql.readPlans[plan].label;
}

export function audienceReadPlanDescription(
  plan: AudienceSqlReadPlan,
): string {
  return AUDIENCE_CATALOG.components.sql.readPlans[plan].description;
}

/** Queue cap disclosed by the level for one component kind. */
export function audienceQueueCapacity(
  kind: AudienceNodeKind,
): number | null {
  if (kind === 'app') {
    return AUDIENCE_LEVEL.limits.maxAppWaitingTasks;
  }
  if (kind === 'sql') {
    return AUDIENCE_LEVEL.limits.maxSqlWaitingTasks;
  }
  if (kind === 'cache') {
    return AUDIENCE_LEVEL.limits.maxCacheWaitingTasks;
  }
  if (kind === 'worker') {
    return AUDIENCE_CATALOG.components.worker.waitingTasks;
  }
  return null;
}

/** Configured hourly rent of one node, always separate from actual run cost. */
export function audienceNodeHourlyUsd(
  kind: AudienceNodeKind,
  config: {
    instances?: number;
    size?: AudienceSqlSize;
  },
): number {
  const components = AUDIENCE_CATALOG.components;
  switch (kind) {
    case 'lb':
      return components.lb.hourlyUsd;
    case 'app':
      return (config.instances ?? 1) * components.app.hourlyUsdPerInstance;
    case 'sql':
      return components.sql.sizes[config.size ?? 'small'].hourlyUsd;
    case 'cache':
      return components.cache.hourlyUsd;
    case 'worker':
      return (config.instances ?? 1) * components.worker.hourlyUsdPerInstance;
    default:
      return 0;
  }
}

export function audienceGraphHourlyUsd(graph: AudienceGraph): number {
  return graph.nodes.reduce((sum, node) => {
    if (node.kind === 'users') {
      return sum;
    }
    if (node.kind === 'app' || node.kind === 'worker') {
      return sum + audienceNodeHourlyUsd(node.kind, node.config);
    }
    if (node.kind === 'sql') {
      return sum + audienceNodeHourlyUsd('sql', { size: node.config.size });
    }
    return sum + audienceNodeHourlyUsd(node.kind, {});
  }, 0);
}

export function audienceConfigSummary(
  kind: AudienceNodeKind,
  config: {
    instances?: number;
    size?: AudienceSqlSize;
    readPlan?: AudienceSqlReadPlan;
    ttlSeconds?: number;
  },
): string {
  switch (kind) {
    case 'users':
      return 'Fixed population · traffic source';
    case 'lb':
      return 'Managed · health-checked internal redundancy';
    case 'app':
      return `${config.instances ?? 1} instance${(config.instances ?? 1) === 1 ? '' : 's'} · request pool`;
    case 'sql':
      return `${audienceSqlSizeLabel(config.size ?? 'small')} · ${
        config.readPlan === 'projection' ? 'maintained projection' : 'indexed query'
      }`;
    case 'cache':
      return `TTL ${config.ttlSeconds ?? 2} s · one shared answer`;
    case 'worker':
      return `${config.instances ?? 1} instance${(config.instances ?? 1) === 1 ? '' : 's'} · SQL jobs`;
  }
}

export function audienceCaseLabel(id: AudienceCaseId): string {
  if (id === 'normal') {
    return 'Normal traffic';
  }
  if (id === 'peak') {
    return 'Live peak';
  }
  return `Application failure · slot ${id.slice('app-failure-'.length)}`;
}

export function audienceCaseShortLabel(id: AudienceCaseId): string {
  if (id === 'normal') {
    return 'Normal';
  }
  if (id === 'peak') {
    return 'Peak';
  }
  return `Failure · slot ${id.slice('app-failure-'.length)}`;
}

/**
 * The critical offer cohort is fixed by the case kind, not chosen by a graph.
 * Normal has no separate cohort and uses the whole case.
 */
export function audienceCriticalWindow(
  id: AudienceCaseId,
): AudienceWindowRange | null {
  if (id === 'peak') {
    return { ...AUDIENCE_PEAK_WINDOW };
  }
  if (id === 'normal') {
    return null;
  }
  return { ...AUDIENCE_FAULT_CRITICAL_WINDOW };
}

export function audienceWindowText(window: AudienceWindowRange): string {
  return `${formatInteger(window.fromMs / 1000)}–${formatInteger(
    window.toMs / 1000,
  )} s`;
}
