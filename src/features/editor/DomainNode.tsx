import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  Database,
  Layers,
  Monitor,
  Server,
  Share2,
} from 'lucide-react';

import { type EdgeSourcePort, type NodeKind } from '../../domain';
import { TrafficNodeMeters } from '../traffic/TrafficNodeMeters';
import { DASH, formatDecimal } from '../../ui/format';
import {
  LOAD_BLOCK_COUNT,
  filledBlocks,
  occupancyAccessibleText,
  occupancyBand,
  occupancyPeakValue,
  occupancyValue,
  type Occupancy,
} from '../metrics/load-bands';
import {
  PORT_COLORS,
  PORT_LABELS,
  type CanvasLoadMode,
  type CanvasNode,
  type CanvasNodeData,
} from './canvas-model';

const KIND_ICONS = {
  client: Monitor,
  loadBalancer: Share2,
  appServer: Server,
  cache: Layers,
  database: Database,
} as const;

const SOURCE_PORTS: Readonly<Record<NodeKind, readonly EdgeSourcePort[]>> = {
  client: ['out'],
  loadBalancer: ['out'],
  appServer: ['read', 'write'],
  cache: ['miss'],
  database: [],
};

const PORT_TOP: Readonly<Record<EdgeSourcePort, string>> = {
  out: '52%',
  read: '38%',
  write: '68%',
  miss: '52%',
};

function portLabel(kind: NodeKind, port: EdgeSourcePort): string {
  if (port === 'out' && kind === 'loadBalancer') {
    return 'next';
  }
  return PORT_LABELS[port];
}

function LoadBlocks({ occupancy }: { occupancy: Occupancy }) {
  const band = occupancyBand(occupancy);
  const filled = filledBlocks(
    occupancy.used ?? 0,
    occupancy.capacity ?? 0,
  );
  const accessible = occupancyAccessibleText(occupancy);
  const peak = occupancyPeakValue(occupancy);
  return (
    <div className="domain-node__load">
      <div className="domain-node__load-row">
        <span className="domain-node__load-label">{occupancy.label}</span>
        <span
          className={[
            'load-blocks',
            band ? `load-blocks--${band}` : 'load-blocks--unknown',
          ].join(' ')}
          role="meter"
          aria-label={`${occupancy.label} occupancy`}
          aria-valuemin={0}
          aria-valuemax={occupancy.capacity ?? undefined}
          aria-valuenow={occupancy.used ?? undefined}
          aria-valuetext={accessible}
          title={accessible}
        >
          {Array.from({ length: LOAD_BLOCK_COUNT }, (_, index) => (
            <span
              key={index}
              className={index < filled ? 'is-filled' : ''}
              aria-hidden="true"
            />
          ))}
        </span>
        <span className="domain-node__load-value">
          {occupancyValue(occupancy)}
        </span>
      </div>
      {occupancy.note ? (
        <span className="domain-node__load-note">{occupancy.note}</span>
      ) : null}
      {peak !== null ? (
        <span className="domain-node__load-note">
          peak {peak} / {occupancy.capacity ?? DASH}
        </span>
      ) : null}
    </div>
  );
}

function NodeStats({
  data,
  loadMode,
}: {
  data: CanvasNodeData;
  loadMode: CanvasLoadMode;
}) {
  const { kind, metrics } = data;
  const peak = loadMode === 'peak';
  const stopped = loadMode === 'stopped';
  if (kind === 'client') {
    return <p className="domain-node__stats">traffic source</p>;
  }
  if (kind === 'loadBalancer') {
    return <p className="domain-node__stats">round robin</p>;
  }
  if (kind === 'cache') {
    const lookups = (metrics?.hits ?? 0) + (metrics?.misses ?? 0);
    const hitRatio = lookups > 0 ? (metrics?.hits ?? 0) / lookups : null;
    const waits = peak
      ? (metrics?.pressure?.poolQueuedPeak ?? null)
      : (metrics?.poolQueued ?? null);
    return (
      <dl className="domain-node__stats">
        <div>
          <dt>{peak ? 'queue peak' : stopped ? 'queue at stop' : 'queue'}</dt>
          <dd>{metrics ? (peak ? metrics.maxQueued : metrics.queued) : DASH}</dd>
        </div>
        <div>
          <dt>{stopped ? 'pool wait at stop' : 'pool wait'}</dt>
          <dd>{waits === null ? DASH : waits}</dd>
        </div>
        <div>
          <dt>hits</dt>
          <dd>{hitRatio === null ? DASH : `${formatDecimal(hitRatio * 100, 0)}%`}</dd>
        </div>
        <div>
          <dt>coalesced</dt>
          <dd>{metrics ? metrics.coalesced : DASH}</dd>
        </div>
      </dl>
    );
  }
  const poolWaits = peak
    ? (metrics?.pressure?.poolQueuedPeak ?? null)
    : (metrics?.poolQueued ?? null);
  return (
    <dl className="domain-node__stats">
      <div>
        <dt>{peak ? 'queue peak' : stopped ? 'queue at stop' : 'queue'}</dt>
        <dd>{metrics ? (peak ? metrics.maxQueued : metrics.queued) : DASH}</dd>
      </div>
      {kind === 'appServer' ? (
        <div>
          <dt>{stopped ? 'pool wait at stop' : 'pool wait'}</dt>
          <dd>{poolWaits === null ? DASH : poolWaits}</dd>
        </div>
      ) : null}
    </dl>
  );
}

export function DomainNode({ data, selected, isConnectable }: NodeProps<CanvasNode>) {
  const Icon = KIND_ICONS[data.kind];
  const ports = SOURCE_PORTS[data.kind];
  return (
    <article
      className={[
        'domain-node',
        `domain-node--${data.kind}`,
        selected ? 'is-selected' : '',
        data.loadMode === 'peak' ? 'is-peak' : '',
        data.loadMode === 'stopped' ? 'is-stopped' : '',
        data.highlight ? `domain-node--diagnostic-${data.highlight}` : '',
      ]
        .filter(Boolean)
        .join(' ')}
      title={data.tooltip}
    >
      {data.kind !== 'client' ? (
        <Handle
          type="target"
          position={Position.Left}
          className="domain-node__handle domain-node__handle--target"
          title="Input"
        />
      ) : null}
      <header className="domain-node__head">
        <span className="domain-node__icon" aria-hidden="true">
          <Icon size={17} strokeWidth={2} />
        </span>
        <span className="domain-node__title">{data.label}</span>
        {data.highlight ? (
          <span
            className={`domain-node__badge domain-node__badge--${data.highlight}`}
          >
            {data.highlight === 'error' ? 'Error' : 'Warning'}
          </span>
        ) : null}
      </header>
      <p className="domain-node__capacity">{data.capacityLabel}</p>

      {data.occupancy.length > 0 ? (
        <div className="domain-node__loads">
          {data.loadMode === 'peak' ? (
            <p className="domain-node__peak">Run average</p>
          ) : data.loadMode === 'stopped' ? (
            <p className="domain-node__snapshot">Stopped snapshot</p>
          ) : null}
          {data.occupancy.map((occupancy) => (
            <LoadBlocks key={occupancy.key} occupancy={occupancy} />
          ))}
        </div>
      ) : null}

      <NodeStats data={data} loadMode={data.loadMode} />

      {data.traffic &&
      (data.traffic.sampleActive || data.traffic.showPlaceholder) ? (
        <TrafficNodeMeters
          levelId="cold-cache"
          kind={data.kind}
          node={data.traffic.node}
          modeLabel={data.traffic.modeLabel}
          sampleActive={data.traffic.sampleActive}
          animate={data.traffic.animate}
          showPlaceholder={data.traffic.showPlaceholder}
        />
      ) : null}

      {data.highlight ? (
        <p
          className={`domain-node__diagnostic domain-node__diagnostic--${data.highlight}`}
        >
          {data.diagnostics[0]?.message ?? 'Linked diagnostic'}
          {data.diagnostics.length > 1
            ? ` · +${data.diagnostics.length - 1} more`
            : ''}
        </p>
      ) : null}

      {ports.map((port) => (
        <Handle
          key={port}
          id={port}
          type="source"
          position={Position.Right}
          className="domain-node__handle"
          style={{ top: PORT_TOP[port], background: PORT_COLORS[port] }}
          isConnectable={isConnectable}
          title={portLabel(data.kind, port)}
        />
      ))}
      {ports.map((port) => (
        <span
          className="domain-node__port"
          key={`${port}-label`}
          style={{ top: PORT_TOP[port], color: PORT_COLORS[port] }}
        >
          {portLabel(data.kind, port)}
        </span>
      ))}
    </article>
  );
}
