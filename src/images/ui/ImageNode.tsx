import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  Boxes,
  Cloud,
  Database,
  Monitor,
  Server,
} from 'lucide-react';

import { IMAGE_CATALOG } from '../catalog';
import type {
  ImageAppConfig,
  ImageCacheConfig,
  ImageMetadataConfig,
  ImageNodeConfig,
  ImageNodeKind,
  ImageNodeMetrics,
  ImageRegion,
} from '../contracts';
import { formatInteger } from '../../ui/format';
import type { TrafficNodeView } from '../../features/traffic/traffic-ui';
import { TrafficNodeMeters } from '../../features/traffic/TrafficNodeMeters';
import type { ImageProblem } from './image-diagnostics';
import type { ImageNodeCapacityLoad } from './image-estimate';
import {
  formatDataSize,
  formatFractionPercent,
  formatGbitPerSec,
  imageFilledBlocks,
  imageLoadBand,
} from './image-format';
import {
  IMAGE_NODE_KIND_LABELS,
  IMAGE_NODE_KIND_SHORT,
  IMAGE_REGION_LABELS,
  IMAGE_REGION_SHORT,
} from './image-meta';

export interface ImageCanvasNodeData extends Record<string, unknown> {
  label: string;
  kind: ImageNodeKind;
  region: ImageRegion;
  config: ImageNodeConfig;
  metrics: ImageNodeMetrics | null;
  capacity: ImageNodeCapacityLoad | null;
  stale: boolean;
  problem: ImageProblem | null;
  scenarioLabel: string;
  outsideLane: boolean;
  traffic: TrafficNodeView;
}

export type ImageCanvasNode = Node<ImageCanvasNodeData, 'image'>;

const KIND_ICONS = {
  client: Monitor,
  app: Server,
  metadata: Database,
  cache: Boxes,
  blob: Cloud,
} as const;

const INSTANCE_NIC_GBIT = IMAGE_CATALOG.instance.networkGbitPerSec;

function clampFraction(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(1, Math.max(0, value));
}

function imageConfigSummary(
  kind: ImageNodeKind,
  config: ImageNodeConfig,
): string {
  switch (kind) {
    case 'client':
      return 'Fixed · 100 Gbit/s population link · 1 Gbit/s per request';
    case 'blob':
      return 'Fixed · durable global originals · 100 Gbit/s endpoint';
    case 'app': {
      const app = config as ImageAppConfig;
      return `${app.instances}× instance · ${app.delivery} · ${app.buffering} · ${app.retries} retries`;
    }
    case 'metadata': {
      const metadata = config as ImageMetadataConfig;
      return `${metadata.backend} · index ${metadata.index} · ${metadata.instances}× ${metadata.diskTb} TB · ${metadata.replicas} local copies`;
    }
    case 'cache': {
      const cache = config as ImageCacheConfig;
      const tier =
        cache.medium === 'ssd' ? ` · ${cache.diskTb ?? 0} TB SSD tier` : '';
      return `${cache.medium} · ${cache.capacityGb} GB · ${cache.instances}× · ${cache.fill}${tier}`;
    }
    default:
      return '';
  }
}

function NodeMeter({
  label,
  fraction,
  valueText,
  peakText,
  reason,
  analytical,
}: {
  label: string;
  fraction: number | null;
  valueText: string;
  peakText?: string;
  reason?: string | undefined;
  analytical?: boolean;
}) {
  const band = imageLoadBand(fraction);
  const filled = imageFilledBlocks(fraction);
  const percentText = formatFractionPercent(fraction);
  const accessible = [
    `${label} ${analytical ? 'analytical load' : 'average load'} ${percentText}`,
    peakText ? `peak ${peakText}` : null,
    reason ? `reason: ${reason}` : null,
  ]
    .filter(Boolean)
    .join('; ');
  return (
    <div className="image-node__meter-row">
      <span className="image-node__meter-label">{label}</span>
      <span
        className={[
          'image-load-blocks',
          band ? `image-load-blocks--${band}` : 'image-load-blocks--unknown',
        ].join(' ')}
        role="meter"
        aria-label={`${label} ${analytical ? 'analytical' : 'average'} utilization`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction === null ? 0 : Math.round(fraction * 100)}
        aria-valuetext={accessible}
        title={accessible}
      >
        {Array.from({ length: 10 }, (_, index) => (
          <span
            key={index}
            className={index < filled ? 'is-filled' : ''}
            aria-hidden="true"
          />
        ))}
      </span>
      <span className="image-node__meter-value">{valueText}</span>
      <span className="image-node__meter-peak">
        {peakText ? `peak ${peakText}` : analytical ? 'day 30' : ''}
      </span>
    </div>
  );
}

function networkLoad(
  kind: ImageNodeKind,
  metrics: ImageNodeMetrics,
): { fraction: number | null; rate: string; peakRate: string } {
  const capacityGbit =
    kind === 'client' || kind === 'blob'
      ? IMAGE_CATALOG.provider.endpointBandwidthGbitPerSec
      : Math.max(1, metrics.instances) * INSTANCE_NIC_GBIT;
  // The average is the primary fraction; the peak stays separate evidence.
  const average = Math.max(
    metrics.networkIngressGbitAvg,
    metrics.networkEgressGbitAvg,
  );
  const peak = Math.max(
    metrics.networkIngressGbitPeak,
    metrics.networkEgressGbitPeak,
  );
  return {
    fraction: capacityGbit > 0 ? clampFraction(average / capacityGbit) : null,
    rate: formatGbitPerSec(average),
    peakRate: formatGbitPerSec(peak),
  };
}

export function ImageNode({
  data,
  selected,
  isConnectable,
}: NodeProps<ImageCanvasNode>) {
  const Icon = KIND_ICONS[data.kind];
  const spec = IMAGE_CATALOG.nodes[data.kind];
  const problem = data.problem;
  const fixed = spec.fixed;
  const metrics = data.metrics;
  const liveSample = data.traffic.sampleActive;
  const showTraffic = liveSample || data.traffic.showPlaceholder;
  const showMetrics = metrics !== null && !data.stale && !liveSample;
  const clientsHaveNoInput = data.kind === 'client';
  const providersHaveNoOutput = data.kind === 'blob';
  const reasons = problem?.messages ?? [];

  const cpu = showMetrics
    ? clampFraction(metrics.cpuUtilizationAvg)
    : null;
  const ram = showMetrics
    ? clampFraction(
        metrics.memoryLimitBytes > 0
          ? metrics.memoryBytesAvg / metrics.memoryLimitBytes
          : null,
      )
    : null;
  const io = showMetrics ? clampFraction(metrics.ioUtilizationAvg) : null;
  const net = showMetrics ? networkLoad(data.kind, metrics) : null;
  const capacity = data.stale ? null : data.capacity;

  return (
    <article
      className={[
        'image-node',
        `image-node--${data.kind}`,
        selected ? 'is-selected' : '',
        problem ? `image-node--problem-${problem.severity}` : '',
        fixed ? 'image-node--fixed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      title={
        reasons.length > 0
          ? reasons.join(' · ')
          : `${data.label}, ${IMAGE_NODE_KIND_LABELS[data.kind]} in ${IMAGE_REGION_LABELS[data.region]}`
      }
    >
      {!clientsHaveNoInput ? (
        <Handle
          type="target"
          position={Position.Left}
          className="image-node__handle image-node__handle--target"
          title="Input connector: finish a route here"
        />
      ) : null}

      <header className="image-node__head">
        <span className="image-node__icon" aria-hidden="true">
          <Icon size={17} strokeWidth={2} />
        </span>
        <span className="image-node__title">{data.label}</span>
        {problem ? (
          <span className={`image-node__badge image-node__badge--${problem.severity}`}>
            {problem.severity === 'error'
              ? 'Error'
              : problem.severity === 'warning'
                ? 'Warning'
                : 'Info'}
          </span>
        ) : fixed ? (
          <span className="image-node__badge image-node__badge--fixed">Fixed</span>
        ) : null}
      </header>

      <p className="image-node__kind">
        <span className={`image-node__region image-node__region--${data.region}`}>
          {IMAGE_REGION_SHORT[data.region]} · {IMAGE_REGION_LABELS[data.region]}
        </span>
        {' · '}
        {IMAGE_NODE_KIND_SHORT[data.kind]}
      </p>
      <p className="image-node__config">{imageConfigSummary(data.kind, data.config)}</p>

      {showTraffic ? (
        <TrafficNodeMeters
          levelId="image-atlas"
          kind={data.kind}
          node={data.traffic.node}
          modeLabel={data.traffic.modeLabel}
          sampleActive={data.traffic.sampleActive}
          animate={data.traffic.animate}
          showPlaceholder={data.traffic.showPlaceholder}
        />
      ) : null}

      {showMetrics ? (
        <div className="image-node__meters" aria-label={`${data.scenarioLabel} utilization`}>
          <NodeMeter
            label="CPU"
            fraction={cpu}
            valueText={formatFractionPercent(cpu)}
            peakText={formatFractionPercent(metrics.cpuUtilizationPeak)}
            reason={problem?.byMetric.cpu?.[0]}
          />
          <NodeMeter
            label="RAM"
            fraction={ram}
            valueText={formatFractionPercent(ram)}
            peakText={formatFractionPercent(
              metrics.memoryLimitBytes > 0
                ? metrics.memoryBytesPeak / metrics.memoryLimitBytes
                : null,
            )}
            reason={problem?.byMetric.ram?.[0]}
          />
          <NodeMeter
            label="IO"
            fraction={io}
            valueText={formatFractionPercent(io)}
            peakText={formatFractionPercent(metrics.ioUtilizationPeak)}
            reason={problem?.byMetric.io?.[0]}
          />
          <NodeMeter
            label="Net"
            fraction={net ? net.fraction : null}
            valueText={net ? net.rate : '—'}
            peakText={net ? net.peakRate : undefined}
            reason={problem?.byMetric.network?.[0]}
          />
          {capacity ? (
            <NodeMeter
              label={capacity.label}
              fraction={clampFraction(capacity.fraction)}
              valueText={formatFractionPercent(capacity.fraction)}
              reason={problem?.byMetric.capacity?.[0]}
              analytical
            />
          ) : null}
          <p
            className="image-node__stats"
            title="Foreground queue peak: distinct foreground stage tasks waiting. Business requests and background replication are not counted as queue entries."
          >
            {data.scenarioLabel} · requests {formatInteger(metrics.requests)} ·
            errors {formatInteger(metrics.errors)} · foreground queue peak{' '}
            {formatInteger(metrics.queueDepthPeak)}
            {metrics.healthyInstances < metrics.instances
              ? ` · ${metrics.healthyInstances}/${metrics.instances} healthy`
              : ''}
          </p>
          {metrics.cache ? (
            <p className="image-node__stats">
              cache hit {formatFractionPercent(metrics.cache.hitRatio)} · hits{' '}
              {formatInteger(metrics.cache.hits)} · evictions{' '}
              {formatInteger(metrics.cache.evictions)}
            </p>
          ) : null}
          {metrics.replication ? (
            <p className="image-node__stats">
              replicated {formatInteger(metrics.replication.replicatedWrites)} ·
              queued {formatDataSize(metrics.replication.queuedBytes)}
            </p>
          ) : null}
        </div>
      ) : data.stale ? (
        <p className="image-node__muted">
          Previous result hidden — the semantic graph or seed changed.
        </p>
      ) : (
        showTraffic ? null : (
          <p className="image-node__muted image-node__muted--spec">{spec.notes}</p>
        )
      )}

      {problem ? (
        <p className={`image-node__problem image-node__problem--${problem.severity}`}>
          {problem.messages[0]}
          {problem.messages.length > 1
            ? ` · +${problem.messages.length - 1} more`
            : ''}
        </p>
      ) : null}

      {data.outsideLane ? (
        <p className="image-node__lane-hint">
          Drawn outside the {IMAGE_REGION_SHORT[data.region]} lane — a shared origin
          may sit between regional rows. Group by region tidies positions only.
        </p>
      ) : null}

      {!providersHaveNoOutput ? (
        <Handle
          type="source"
          position={Position.Right}
          className="image-node__handle image-node__handle--source"
          isConnectable={isConnectable}
          title="Output connector: start a route, then choose its operation"
        />
      ) : null}
      <span className="image-node__port" aria-hidden="true">
        {problem?.severity === 'error'
          ? 'fix'
          : providersHaveNoOutput
            ? 'read'
            : 'route'}
      </span>
    </article>
  );
}
