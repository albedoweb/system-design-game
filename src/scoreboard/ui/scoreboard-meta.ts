import {
  SCOREBOARD_CATALOG,
  SCOREBOARD_LEVEL,
  createScoreboardStarterGraph,
  scoreboardLinkRole,
  type ScoreboardGraph,
  type ScoreboardLinkRole,
  type ScoreboardNodeKind,
  type ScoreboardSqlReadPlan,
  type ScoreboardSqlSize,
} from '../index';

/** General-component vocabulary shared by the canvas, palette and inspector. */

export const SCOREBOARD_NODE_KIND_LABELS: Readonly<
  Record<ScoreboardNodeKind, string>
> = {
  users: 'Users',
  app: 'Application',
  sql: 'SQL Database',
  cache: 'Cache',
};

export const SCOREBOARD_NODE_COLORS: Readonly<
  Record<ScoreboardNodeKind, string>
> = {
  users: '#0e7490',
  app: '#1d6fd8',
  sql: '#7c3aed',
  cache: '#b45309',
};

/**
 * The App -> SQL dependency is a *primary* data path: vote writes and any
 * direct leaderboard reads use it. Never label it writes-only.
 */
export function scoreboardLinkLabel(role: ScoreboardLinkRole | null): string {
  if (role === 'traffic') {
    return 'traffic';
  }
  if (role === 'reads') {
    return 'reads';
  }
  if (role === 'fill') {
    return 'fill';
  }
  return 'read / write';
}

export function scoreboardLinkLongLabel(role: ScoreboardLinkRole | null): string {
  if (role === 'traffic') {
    return 'Traffic: users to the application pool';
  }
  if (role === 'reads') {
    return 'Leaderboard reads: application to cache';
  }
  if (role === 'fill') {
    return 'Cache fill: cache to the primary database';
  }
  return 'Primary data path: vote writes and direct leaderboard reads';
}

export function scoreboardLinkColor(role: ScoreboardLinkRole | null): string {
  if (role === 'traffic') {
    return '#0e7490';
  }
  if (role === 'reads') {
    return '#b45309';
  }
  if (role === 'fill') {
    return '#0f766e';
  }
  return '#1d4ed8';
}

export function scoreboardRoleOfKinds(
  from: ScoreboardNodeKind,
  to: ScoreboardNodeKind,
): ScoreboardLinkRole | null {
  return scoreboardLinkRole(from, to);
}

/** True only for the untouched, intentional Users-only onboarding document. */
export function isUntouchedScoreboardStarter(graph: ScoreboardGraph): boolean {
  return (
    JSON.stringify(graph) === JSON.stringify(createScoreboardStarterGraph())
  );
}

export function scoreboardKindLabel(kind: ScoreboardNodeKind): string {
  return SCOREBOARD_NODE_KIND_LABELS[kind];
}

export function scoreboardSqlSizeLabel(size: ScoreboardSqlSize): string {
  return size === 'small' ? 'Small' : size === 'medium' ? 'Medium' : 'Large';
}

export function scoreboardSqlSizeSpec(size: ScoreboardSqlSize) {
  return SCOREBOARD_CATALOG.components.sql.sizes[size];
}

export function scoreboardReadPlanLabel(plan: ScoreboardSqlReadPlan): string {
  return SCOREBOARD_CATALOG.components.sql.readPlans[plan].label;
}

export function scoreboardReadPlanDescription(plan: ScoreboardSqlReadPlan): string {
  return SCOREBOARD_CATALOG.components.sql.readPlans[plan].description;
}

/** Queue cap disclosed by the level for one component kind. */
export function scoreboardQueueCapacity(kind: ScoreboardNodeKind): number | null {
  if (kind === 'sql') {
    return SCOREBOARD_LEVEL.limits.maxSqlWaitingTasks;
  }
  if (kind === 'app') {
    return SCOREBOARD_LEVEL.limits.maxAppWaitingTasks;
  }
  if (kind === 'cache') {
    return SCOREBOARD_LEVEL.limits.maxCacheWaitingTasks;
  }
  return null;
}

export function scoreboardConfigSummary(
  kind: ScoreboardNodeKind,
  config: {
    instances?: number;
    size?: ScoreboardSqlSize;
    readPlan?: ScoreboardSqlReadPlan;
    ttlSeconds?: number;
  },
): string {
  if (kind === 'users') {
    return 'Fixed population · traffic source';
  }
  if (kind === 'app') {
    return `${config.instances ?? 1} instance${(config.instances ?? 1) === 1 ? '' : 's'} · request pool`;
  }
  if (kind === 'sql') {
    return `${scoreboardSqlSizeLabel(config.size ?? 'small')} · ${
      config.readPlan === 'aggregate' ? 'maintained aggregate' : 'compute from raw votes'
    }`;
  }
  return `TTL ${config.ttlSeconds ?? 2} s · coalescing fixed on`;
}
