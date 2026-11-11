import {
  Database,
  KeyRound,
  Link2,
  Monitor,
  Plus,
  Server,
  Table2,
} from 'lucide-react';
import { useState } from 'react';

import { PARCEL_CATALOG } from '../catalog';
import type { ParcelNodeKind } from '../contracts';
import { formatDecimal, formatInteger } from '../../ui/format';
import { PARCEL_NODE_KIND_LABELS } from './parcel-meta';
import { useParcelStore } from './parcel-store';

const KIND_ICONS = {
  client: Monitor,
  app: Server,
  sql: Database,
  kv: KeyRound,
  columnar: Table2,
} as const;

const KIND_ORDER: readonly ParcelNodeKind[] = [
  'client',
  'app',
  'sql',
  'kv',
  'columnar',
];

function addReason(
  kind: ParcelNodeKind,
  count: number,
  total: number,
  locked: boolean,
): string | null {
  if (locked) {
    return 'Read-only while the evaluation runs';
  }
  if (total >= 32) {
    return 'The graph has 32 nodes — that is the limit';
  }
  if (kind === 'client' && count >= 1) {
    return 'One client is required and already present';
  }
  if (kind === 'app' && count >= 1) {
    return 'One application is required and already present';
  }
  return null;
}

function specLine(kind: ParcelNodeKind): string {
  const spec = PARCEL_CATALOG.nodes[kind];
  const hardware = PARCEL_CATALOG.hardware[spec.defaultSize];
  return `${formatInteger(hardware.cpuCores)} CPU · ${formatInteger(
    hardware.memoryGb,
  )} GB · $${formatDecimal(hardware.hourlyUsd, 3)}/h · ${spec.notes}`;
}

export function ParcelPalette({
  locked,
  onOpenConnect,
}: {
  locked: boolean;
  onOpenConnect: () => void;
}) {
  const graph = useParcelStore((state) => state.graph);
  const addNode = useParcelStore((state) => state.addNode);
  const [message, setMessage] = useState<string | null>(null);
  const counts = new Map<ParcelNodeKind, number>();
  for (const node of graph.nodes) {
    counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  }

  return (
    <div className="parcel-palette">
      <p className="parcel-palette__intro">
        Add stores and connect them with one output and one input connector. The
        operation belongs to the route, not to a hidden port type.
      </p>
      <button
        type="button"
        className="parcel-palette__connect"
        disabled={locked}
        onClick={onOpenConnect}
      >
        <Link2 size={16} aria-hidden="true" />
        Connect nodes with a form
      </button>

      <div className="parcel-palette__list" role="list">
        {KIND_ORDER.map((kind) => {
          const count = counts.get(kind) ?? 0;
          const Icon = KIND_ICONS[kind];
          const reason = addReason(kind, count, graph.nodes.length, locked);
          return (
            <div className="parcel-palette__item" role="listitem" key={kind}>
              <span className="parcel-palette__icon" aria-hidden="true">
                <Icon size={18} strokeWidth={2} />
              </span>
              <div className="parcel-palette__body">
                <div className="parcel-palette__title-row">
                  <h3>{PARCEL_NODE_KIND_LABELS[kind]}</h3>
                  <span className="parcel-palette__count">
                    {count} present
                  </span>
                </div>
                <p className="parcel-palette__spec">{specLine(kind)}</p>
                <button
                  type="button"
                  className="parcel-palette__add"
                  disabled={reason !== null}
                  title={reason ?? undefined}
                  onClick={() => {
                    const result = addNode(kind);
                    setMessage(
                      result.ok
                        ? `Added ${PARCEL_NODE_KIND_LABELS[kind]}.`
                        : (result.message ?? 'Could not add the node.'),
                    );
                  }}
                  aria-label={`Add: ${PARCEL_NODE_KIND_LABELS[kind]}`}
                >
                  <Plus size={15} aria-hidden="true" />
                  {reason ?? `Add ${PARCEL_NODE_KIND_LABELS[kind]}`}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="parcel-palette__rules">
        <h3>Level rules</h3>
        <p>Exactly one client and one application are required.</p>
        <p>
          Ingest acknowledges a durable SQL or KV primary. Status and history read
          a store fed by ingest or replication.
        </p>
        <p>
          Reports need rollups, a warehouse index or a columnar projection. Both
          horizons must pass; unused stores still cost money.
        </p>
      </div>

      {message ? (
        <p className="parcel-palette__message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
