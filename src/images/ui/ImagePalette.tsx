import {
  Boxes,
  Cloud,
  Database,
  Link2,
  Monitor,
  Plus,
  Server,
} from 'lucide-react';
import { useState } from 'react';

import { IMAGE_CATALOG } from '../catalog';
import type { ImageNodeKind, ImageRegion } from '../contracts';
import { IMAGE_COMPONENT_LIMITS } from '../contracts';
import { formatInteger } from '../../ui/format';
import {
  IMAGE_ADDABLE_KINDS,
  IMAGE_NODE_KIND_LABELS,
  IMAGE_REGION_LABELS,
  IMAGE_REGION_ORDER,
} from './image-meta';
import { useImageStore } from './image-store';

const KIND_ICONS = {
  client: Monitor,
  app: Server,
  metadata: Database,
  cache: Boxes,
  blob: Cloud,
} as const;

function specLine(kind: ImageNodeKind): string {
  const spec = IMAGE_CATALOG.nodes[kind];
  return spec.notes;
}

export function ImagePalette({
  locked,
  onOpenConnect,
}: {
  locked: boolean;
  onOpenConnect: () => void;
}) {
  const graph = useImageStore((state) => state.graph);
  const addNode = useImageStore((state) => state.addNode);
  const [region, setRegion] = useState<ImageRegion>('na');
  const [message, setMessage] = useState<string | null>(null);
  const counts = new Map<ImageNodeKind, number>();
  for (const node of graph.nodes) {
    counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  }
  const regionCount = graph.nodes.filter((node) => node.region === region).length;
  const atNodeLimit = graph.nodes.length >= IMAGE_COMPONENT_LIMITS.maxNodes;

  return (
    <div className="image-palette">
      <p className="image-palette__intro">
        Add player pools, stores and caches. Client populations and provider endpoints
        are fixed per region: you can rename and move them, but not recreate them.
      </p>

      <button
        type="button"
        className="image-palette__connect"
        disabled={locked}
        onClick={onOpenConnect}
      >
        <Link2 size={16} aria-hidden="true" />
        Connect nodes with a form
      </button>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor="image-palette-region">
          New node region
        </label>
        <select
          id="image-palette-region"
          className="ui-input"
          value={region}
          onChange={(event) => setRegion(event.target.value as ImageRegion)}
        >
          {IMAGE_REGION_ORDER.map((item) => (
            <option value={item} key={item}>
              {IMAGE_REGION_LABELS[item]} ({item})
            </option>
          ))}
        </select>
        <p className="ui-field__hint">
          {regionCount} node{regionCount === 1 ? '' : 's'} in{' '}
          {IMAGE_REGION_LABELS[region]}. New pools are added to this region; region is
          semantics, so moving a node changes its demand and fault domain.
        </p>
      </div>

      <div className="image-palette__list" role="list">
        {IMAGE_ADDABLE_KINDS.map((kind) => {
          const count = counts.get(kind) ?? 0;
          const Icon = KIND_ICONS[kind];
          const disabled = locked || atNodeLimit;
          return (
            <div className="image-palette__item" role="listitem" key={kind}>
              <span className="image-palette__icon" aria-hidden="true">
                <Icon size={18} strokeWidth={2} />
              </span>
              <div className="image-palette__body">
                <div className="image-palette__title-row">
                  <h3>{IMAGE_NODE_KIND_LABELS[kind]}</h3>
                  <span className="image-palette__count">{count} present</span>
                </div>
                <p className="image-palette__spec">{specLine(kind)}</p>
                <button
                  type="button"
                  className="image-palette__add"
                  disabled={disabled}
                  title={
                    locked
                      ? 'Read-only while the evaluation runs'
                      : atNodeLimit
                        ? `The graph has ${IMAGE_COMPONENT_LIMITS.maxNodes} nodes — that is the limit`
                        : undefined
                  }
                  onClick={() => {
                    const result = addNode(kind, region);
                    setMessage(
                      result.ok
                        ? `Added ${IMAGE_NODE_KIND_LABELS[kind]} in ${IMAGE_REGION_LABELS[region]}.`
                        : (result.message ?? 'Could not add the node.'),
                    );
                  }}
                  aria-label={`Add: ${IMAGE_NODE_KIND_LABELS[kind]}`}
                >
                  <Plus size={15} aria-hidden="true" />
                  Add {IMAGE_NODE_KIND_LABELS[kind]}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="image-palette__rules">
        <h3>Level rules</h3>
        <p>
          Exactly three fixed clients and three fixed provider endpoints must exist. Each
          app selects one metadata store; every metadata store attached to an app is an
          origin and may also receive replication.
        </p>
        <p>
          Metadata needs instances divisible by replicas. A cache must fit per-instance
          RAM (22 GB usable) or its declared SSD tier, and a cache response still uses the
          client link.
        </p>
        <p>
          Current graph: {formatInteger(graph.nodes.length)} nodes,{' '}
          {formatInteger(graph.edges.length)} routes.
        </p>
      </div>

      {message ? (
        <p className="image-palette__message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
