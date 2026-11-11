import { Cpu, Database, Layers, Link2, Network, Plus, Server, Users } from 'lucide-react';
import { useState } from 'react';

import { AUDIENCE_CATALOG, type AudienceNodeKind } from '../index';
import { formatDecimal, formatInteger } from '../../ui/format';
import {
  AUDIENCE_NODE_KIND_LABELS,
  audienceConfigSummary,
} from './audience-meta';
import {
  useAudienceStore,
  type AddableAudienceKind,
} from './audience-store';

const KIND_ICONS = {
  users: Users,
  lb: Network,
  app: Server,
  sql: Database,
  cache: Layers,
  worker: Cpu,
} as const;

const ADDABLE: readonly AddableAudienceKind[] = [
  'lb',
  'app',
  'sql',
  'cache',
  'worker',
];

function addReason(
  kind: AddableAudienceKind,
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
  if (kind !== 'app' && kind !== 'sql' && count >= 1) {
    return `At most one ${AUDIENCE_NODE_KIND_LABELS[kind]} is allowed and it is already present`;
  }
  if (total >= 6) {
    return 'The level supports Users, Application, SQL, Load Balancer, Cache and Worker';
  }
  return null;
}

function specLine(kind: AddableAudienceKind): string {
  if (kind === 'lb') {
    const lb = AUDIENCE_CATALOG.components.lb;
    return `${formatInteger(lb.capacityRequestsPerSec)} req/s · ${formatInteger(
      lb.capacityGbitPerSec,
    )} Gbit/s · $${formatDecimal(lb.hourlyUsd, 2)}/h`;
  }
  if (kind === 'app') {
    const app = AUDIENCE_CATALOG.components.app;
    return `${formatDecimal(app.cpuCoresPerInstance, 0)} CPU · ${formatInteger(
      app.memoryGbPerInstance,
    )} GB · ${app.instances.min}–${app.instances.max} instances · $${formatDecimal(
      app.hourlyUsdPerInstance,
      3,
    )}/h each`;
  }
  if (kind === 'sql') {
    const sql = AUDIENCE_CATALOG.components.sql;
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
  if (kind === 'cache') {
    const cache = AUDIENCE_CATALOG.components.cache;
    return `${formatDecimal(cache.cpuCores, 0)} CPU · ${formatInteger(
      cache.memoryGb,
    )} GB · TTL ${cache.ttlOptionsSeconds.join(' / ')} s · $${formatDecimal(
      cache.hourlyUsd,
      2,
    )}/h`;
  }
  const worker = AUDIENCE_CATALOG.components.worker;
  return `${formatDecimal(worker.cpuCoresPerInstance, 0)} CPU · ${formatInteger(
    worker.memoryGbPerInstance,
  )} GB · ${worker.instances.min}–${worker.instances.max} instances · $${formatDecimal(
    worker.hourlyUsdPerInstance,
    3,
  )}/h each`;
}

export function AudiencePalette({
  locked,
  onOpenConnect,
}: {
  locked: boolean;
  onOpenConnect: () => void;
}) {
  const graph = useAudienceStore((state) => state.graph);
  const addNode = useAudienceStore((state) => state.addNode);
  const [message, setMessage] = useState<string | null>(null);

  const counts = new Map<AudienceNodeKind, number>();
  for (const node of graph.nodes) {
    counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  }

  return (
    <div className="audience-palette">
      <p className="audience-palette__intro">
        Add components, then connect a node’s output connector to an input
        connector. The dependency role is inferred from the component pair;
        there are no business ports to choose.
      </p>

      <button
        type="button"
        className="audience-palette__connect"
        disabled={locked}
        onClick={onOpenConnect}
      >
        <Link2 size={16} aria-hidden="true" />
        Connect components
      </button>

      <div className="audience-palette__fixed">
        <Users size={16} aria-hidden="true" />
        <span>
          <strong>Users</strong> is fixed and cannot be deleted. It emits Record
          activity events and View audience ranking reads.
        </span>
      </div>

      <div className="audience-palette__list" role="list">
        {ADDABLE.map((kind) => {
          const count = counts.get(kind) ?? 0;
          const Icon = KIND_ICONS[kind];
          const reason = addReason(kind, count, graph.nodes.length, locked);
          return (
            <div className="audience-palette__item" role="listitem" key={kind}>
              <span className="audience-palette__icon" aria-hidden="true">
                <Icon size={18} strokeWidth={2} />
              </span>
              <div className="audience-palette__body">
                <div className="audience-palette__title-row">
                  <h3>{AUDIENCE_NODE_KIND_LABELS[kind]}</h3>
                  <span className="audience-palette__count">
                    {count} present
                  </span>
                </div>
                <p className="audience-palette__spec">{specLine(kind)}</p>
                <p className="audience-palette__hint">
                  {audienceConfigSummary(kind, {
                    instances:
                      kind === 'app'
                        ? AUDIENCE_CATALOG.components.app.instances.default
                        : AUDIENCE_CATALOG.components.worker.instances.default,
                    size: 'small',
                    readPlan: 'query',
                    ttlSeconds: 2,
                  })}
                </p>
                <button
                  type="button"
                  className="audience-palette__add"
                  disabled={reason !== null}
                  title={reason ?? undefined}
                  onClick={() => {
                    const result = addNode(kind);
                    setMessage(
                      result.ok
                        ? `Added ${AUDIENCE_NODE_KIND_LABELS[kind]}.`
                        : (result.message ?? 'Could not add the component.'),
                    );
                  }}
                  aria-label={`Add: ${AUDIENCE_NODE_KIND_LABELS[kind]}`}
                >
                  <Plus size={15} aria-hidden="true" />
                  {reason ?? `Add ${AUDIENCE_NODE_KIND_LABELS[kind]}`}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="audience-palette__rules">
        <h3>Level rules</h3>
        <p>
          Exactly one Users, one Application pool and one primary SQL Database.
        </p>
        <p>
          At most one Managed Load Balancer, Cache and Worker pool. Every
          component must be reachable from Users.
        </p>
        <p>
          Users → Application or Users → Load Balancer → Application;
          Application → SQL Database; optional Application → Cache → SQL
          Database; Worker → SQL Database. Other pairs are rejected.
        </p>
        <p>
          A direct Users → Application path reaches only physical slot 0. Spare
          instances need the Load Balancer.
        </p>
      </div>

      {message ? (
        <p className="audience-palette__message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
