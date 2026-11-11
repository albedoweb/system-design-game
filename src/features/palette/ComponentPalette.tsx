import { Database, Layers, Monitor, Plus, Server, Share2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  CACHE_ENTRY_KIB,
  CATALOG,
  DEFAULT_NODE_SIZE_BY_KIND,
  MAX_GRAPH_NODES,
  NODE_KIND_LABELS,
  getSizeSpec,
  type NodeKind,
} from '../../domain';
import { useEditorStore } from '../../state/editor-store';
import { formatBytes, formatMicroUsd } from '../../ui/format';
import './palette.css';

const ADDABLE: readonly NodeKind[] = ['appServer', 'cache', 'loadBalancer'];

const KIND_ICONS = {
  client: Monitor,
  loadBalancer: Share2,
  appServer: Server,
  cache: Layers,
  database: Database,
} as const;

function limitLabel(kind: NodeKind, count: number): string | null {
  if (kind === 'appServer' && count >= 4) {
    return 'Limit of 4 app servers reached';
  }
  if (kind === 'cache' && count >= 1) {
    return 'A cache is already added';
  }
  if (kind === 'loadBalancer' && count >= 1) {
    return 'A load balancer is already added';
  }
  return null;
}

function specLabel(kind: NodeKind): string {
  const spec = getSizeSpec(kind, DEFAULT_NODE_SIZE_BY_KIND[kind]);
  const capacity =
    kind === 'cache'
      ? `${spec.capacity} entries · ${formatBytes((spec.capacity ?? 0) * CACHE_ENTRY_KIB)}`
      : spec.capacity === null
        ? 'no capacity limit'
        : `${spec.capacity} slots`;
  return `${capacity} · ${formatMicroUsd(spec.priceMicroUsdPerHour)}/h`;
}

export function ComponentPalette({
  locked,
  onOpenConnect,
}: {
  locked: boolean;
  onOpenConnect: () => void;
}) {
  const graph = useEditorStore((state) => state.graph);
  const addNode = useEditorStore((state) => state.addNode);
  const [message, setMessage] = useState<string | null>(null);

  const totalFull = graph.nodes.length >= MAX_GRAPH_NODES;
  const counts = useMemo(() => {
    const map = new Map<NodeKind, number>();
    for (const node of graph.nodes) {
      map.set(node.kind, (map.get(node.kind) ?? 0) + 1);
    }
    return map;
  }, [graph.nodes]);

  return (
    <div className="palette">
      <p className="palette__intro">
        Add a component with the button — it appears on the canvas and opens in
        the inspector. You can connect through ports or the connection form.
      </p>
      <button
        type="button"
        className="palette__connect"
        disabled={locked}
        title={locked ? 'The graph is frozen until the run ends' : undefined}
        onClick={onOpenConnect}
      >
        <Share2 size={16} aria-hidden="true" />
        Connect components with a form
      </button>

      <div className="palette__list" role="list">
        {ADDABLE.map((kind) => {
          const count = counts.get(kind) ?? 0;
          const limit = limitLabel(kind, count);
          const reason = locked
            ? 'The graph is frozen until the run ends'
            : totalFull
              ? `The graph already has ${MAX_GRAPH_NODES} components`
              : limit;
          const Icon = KIND_ICONS[kind];
          return (
            <div className="palette__item" role="listitem" key={kind}>
              <span className="palette__icon" aria-hidden="true">
                <Icon size={18} strokeWidth={2} />
              </span>
              <div className="palette__body">
                <div className="palette__title-row">
                  <h3>{NODE_KIND_LABELS[kind]}</h3>
                  <span className="palette__count">
                    {count} of {kind === 'appServer' ? 4 : 1}
                  </span>
                </div>
                <p className="palette__spec">{specLabel(kind)}</p>
                <p className="palette__desc">{CATALOG[kind].description}</p>
                <button
                  type="button"
                  className="palette__add"
                  disabled={Boolean(reason)}
                  title={reason ?? undefined}
                  onClick={() => {
                    const result = addNode(kind);
                    setMessage(
                      result.ok ? null : (result.message ?? 'Could not add the component'),
                    );
                  }}
                  aria-label={`Add: ${NODE_KIND_LABELS[kind]}`}
                >
                  <Plus size={15} aria-hidden="true" />
                  {reason ?? 'Add'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="palette__fixed">
        <h3>Fixed in this level</h3>
        <p>
          <Monitor size={15} aria-hidden="true" /> Client — one traffic source,
          fixed.
        </p>
        <p>
          <Database size={15} aria-hidden="true" /> Database — one primary; it
          cannot be deleted, but its settings can be reset.
        </p>
      </div>

      {message ? (
        <p className="palette__message" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
