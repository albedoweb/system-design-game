import { Database, Layers, Link2, Plus, Server, Users } from 'lucide-react';
import { useState } from 'react';

import {
  SCOREBOARD_CATALOG,
  type ScoreboardNodeKind,
} from '../index';
import { formatDecimal, formatInteger } from '../../ui/format';
import {
  SCOREBOARD_NODE_KIND_LABELS,
  scoreboardConfigSummary,
} from './scoreboard-meta';
import {
  useScoreboardStore,
  type AddableScoreboardKind,
} from './scoreboard-store';

const KIND_ICONS = {
  users: Users,
  app: Server,
  sql: Database,
  cache: Layers,
} as const;

const ADDABLE: readonly AddableScoreboardKind[] = ['app', 'sql', 'cache'];

function addReason(
  kind: AddableScoreboardKind,
  count: number,
  total: number,
  locked: boolean,
): string | null {
  if (locked) {
    return 'Locked while the evaluation runs';
  }
  if (kind === 'app' && count >= 1) {
    return 'One Application pool is required and already present';
  }
  if (kind === 'sql' && count >= 1) {
    return 'One primary SQL Database is required and already present';
  }
  if (kind === 'cache' && count >= 1) {
    return 'At most one Cache is allowed and it is already present';
  }
  if (total >= 4) {
    return 'This level supports Users, Application, SQL and one optional Cache';
  }
  return null;
}

function specLine(kind: AddableScoreboardKind): string {
  if (kind === 'app') {
    const app = SCOREBOARD_CATALOG.components.app;
    return `${formatDecimal(app.cpuCoresPerInstance, 0)} CPU · ${formatInteger(
      app.memoryGbPerInstance,
    )} GB · ${app.instances.min}–${app.instances.max} instances · $${formatDecimal(
      app.hourlyUsdPerInstance,
      3,
    )}/h each`;
  }
  if (kind === 'sql') {
    const sql = SCOREBOARD_CATALOG.components.sql;
    const small = sql.sizes.small;
    const large = sql.sizes.large;
    return `${formatInteger(small.cores)}–${formatInteger(
      large.cores,
    )} cores · ${formatInteger(small.memoryGb)}–${formatInteger(
      large.memoryGb,
    )} GB · $${formatDecimal(small.hourlyUsd, 2)}–$${formatDecimal(
      large.hourlyUsd,
      2,
    )}/h`;
  }
  const cache = SCOREBOARD_CATALOG.components.cache;
  return `${formatDecimal(cache.cpuCores, 0)} CPU · ${formatInteger(
    cache.memoryGb,
  )} GB · TTL ${cache.ttlOptionsSeconds.join(' / ')} s · $${formatDecimal(
    cache.hourlyUsd,
    2,
  )}/h`;
}

export function ScoreboardPalette({
  locked,
  onOpenConnect,
}: {
  locked: boolean;
  onOpenConnect: () => void;
}) {
  const graph = useScoreboardStore((state) => state.graph);
  const addNode = useScoreboardStore((state) => state.addNode);
  const [message, setMessage] = useState<string | null>(null);

  const counts = new Map<ScoreboardNodeKind, number>();
  for (const node of graph.nodes) {
    counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  }

  return (
    <div className="scoreboard-palette">
      <p className="scoreboard-palette__intro">
        Add general components, then connect a node’s output connector to an
        input connector. The dependency role is inferred from the component
        pair; there are no business ports to choose.
      </p>

      <button
        type="button"
        className="scoreboard-palette__connect"
        disabled={locked}
        onClick={onOpenConnect}
      >
        <Link2 size={16} aria-hidden="true" />
        Connect components
      </button>

      <div className="scoreboard-palette__fixed">
        <Users size={16} aria-hidden="true" />
        <span>
          <strong>Users</strong> is fixed and cannot be deleted. It emits the two
          offered streams.
        </span>
      </div>

      <div className="scoreboard-palette__list" role="list">
        {ADDABLE.map((kind) => {
          const count = counts.get(kind) ?? 0;
          const Icon = KIND_ICONS[kind];
          const reason = addReason(kind, count, graph.nodes.length, locked);
          return (
            <div className="scoreboard-palette__item" role="listitem" key={kind}>
              <span className="scoreboard-palette__icon" aria-hidden="true">
                <Icon size={18} strokeWidth={2} />
              </span>
              <div className="scoreboard-palette__body">
                <div className="scoreboard-palette__title-row">
                  <h3>{SCOREBOARD_NODE_KIND_LABELS[kind]}</h3>
                  <span className="scoreboard-palette__count">
                    {count} present
                  </span>
                </div>
                <p className="scoreboard-palette__spec">{specLine(kind)}</p>
                <p className="scoreboard-palette__hint">
                  {scoreboardConfigSummary(kind, {
                    instances: 1,
                    size: 'small',
                    readPlan: 'scan',
                    ttlSeconds: 2,
                  })}
                </p>
                <button
                  type="button"
                  className="scoreboard-palette__add"
                  disabled={reason !== null}
                  title={reason ?? undefined}
                  onClick={() => {
                    const result = addNode(kind);
                    setMessage(
                      result.ok
                        ? `Added ${SCOREBOARD_NODE_KIND_LABELS[kind]}.`
                        : (result.message ?? 'Could not add the component.'),
                    );
                  }}
                  aria-label={`Add: ${SCOREBOARD_NODE_KIND_LABELS[kind]}`}
                >
                  <Plus size={15} aria-hidden="true" />
                  {reason ?? `Add ${SCOREBOARD_NODE_KIND_LABELS[kind]}`}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="scoreboard-palette__rules">
        <h3>Level rules</h3>
        <p>Exactly one Users, one Application pool and one primary SQL Database.</p>
        <p>At most one Cache. Every component must be reachable from Users.</p>
        <p>
          Users → Application, Application → SQL Database, optional Application →
          Cache and Cache → SQL Database. Other pairs are rejected by validation.
        </p>
      </div>

      {message ? (
        <p className="scoreboard-palette__message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
