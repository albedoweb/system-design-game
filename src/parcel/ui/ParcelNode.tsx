import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  Database,
  KeyRound,
  Monitor,
  Server,
  Table2,
} from 'lucide-react';

import { PARCEL_CATALOG } from '../catalog';
import type {
  ParcelNodeConfig,
  ParcelNodeKind,
  ParcelNodeMetrics,
} from '../contracts';
import { formatDecimal, formatInteger } from '../../ui/format';
import type { TrafficNodeView } from '../../features/traffic/traffic-ui';
import { TrafficNodeMeters } from '../../features/traffic/TrafficNodeMeters';
import type { ParcelProblem } from './parcel-diagnostics';
import {
  formatFractionPercent,
  parcelFilledBlocks,
  parcelLoadBand,
} from './parcel-format';
import { PARCEL_NODE_KIND_LABELS } from './parcel-meta';

export interface ParcelCanvasNodeData extends Record<string, unknown> {
  label: string;
  kind: ParcelNodeKind;
  config: ParcelNodeConfig;
  metrics: ParcelNodeMetrics | null;
  offeredTotal: number | null;
  stale: boolean;
  problem: ParcelProblem | null;
  horizonLabel: string;
  traffic: TrafficNodeView;
}

export type ParcelCanvasNode = Node<ParcelCanvasNodeData, 'parcel'>;

const KIND_ICONS = {
  client: Monitor,
  app: Server,
  sql: Database,
  kv: KeyRound,
  columnar: Table2,
} as const;

function configSummary(kind: ParcelNodeKind, config: ParcelNodeConfig): string {
  const size = config.size;
  if (kind === 'client') {
    return 'Fixed traffic source';
  }
  if (kind === 'app') {
    return `${size} · owns the four operation routes`;
  }
  const parts: string[] = [size];
  if (config.storageTb !== undefined) {
    parts.push(`${config.storageTb} TB`);
  }
  if (config.retentionYears !== undefined) {
    parts.push(`retain ${config.retentionYears}y`);
  }
  if (config.index && config.index !== 'none') {
    parts.push(config.index === 'parcel' ? 'parcel index' : 'warehouse index');
  }
  if (config.partition === 'month') {
    parts.push('monthly partitions');
  }
  if (config.rollups) {
    parts.push('rollups');
  }
  if (config.latestStatus) {
    parts.push('latest status');
  }
  if (config.compression && config.compression !== 'none') {
    parts.push(config.compression);
  }
  return parts.join(' · ');
}

function UtilizationMeter({
  label,
  average,
  peak,
}: {
  label: string;
  average: number;
  peak: number;
}) {
  const band = parcelLoadBand(average);
  const filled = parcelFilledBlocks(average);
  const accessible = `${label} average ${formatFractionPercent(
    average,
  )}; peak ${formatFractionPercent(
    peak,
  )}. The colored blocks show the run average, not the peak.`;
  return (
    <div className="parcel-node__meter-row">
      <span className="parcel-node__meter-label">{label}</span>
      <span
        className={[
          'parcel-load-blocks',
          band ? `parcel-load-blocks--${band}` : 'parcel-load-blocks--unknown',
        ].join(' ')}
        role="meter"
        aria-label={`${label} average utilization`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(average * 100)}
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
      <span className="parcel-node__meter-value">
        {formatFractionPercent(average)}
      </span>
      <span className="parcel-node__meter-peak">
        peak {formatFractionPercent(peak)}
      </span>
    </div>
  );
}

export function ParcelNode({ data, selected, isConnectable }: NodeProps<ParcelCanvasNode>) {
  const Icon = KIND_ICONS[data.kind];
  const spec = PARCEL_CATALOG.nodes[data.kind];
  const hardware = PARCEL_CATALOG.hardware[data.config.size];
  const problem = data.problem;
  const hasError = problem?.severity === 'error';
  const liveSample = data.traffic.sampleActive;
  const showTraffic = liveSample || data.traffic.showPlaceholder;
  const showMetrics =
    data.metrics !== null &&
    !data.stale &&
    data.kind !== 'client' &&
    !liveSample;
  const showIoMeter = data.kind !== 'app' && data.kind !== 'client';

  return (
    <article
      className={[
        'parcel-node',
        `parcel-node--${data.kind}`,
        selected ? 'is-selected' : '',
        problem ? `parcel-node--problem-${problem.severity}` : '',
      ]
        .filter(Boolean)
        .join(' ')}
      title={
        problem
          ? problem.messages.join(' · ')
          : `${data.label}, ${PARCEL_NODE_KIND_LABELS[data.kind]}`
      }
    >
      {data.kind !== 'client' ? (
        <Handle
          type="target"
          position={Position.Left}
          className="parcel-node__handle parcel-node__handle--target"
          title="Input connector: finish a route here"
        />
      ) : null}

      <header className="parcel-node__head">
        <span className="parcel-node__icon" aria-hidden="true">
          <Icon size={17} strokeWidth={2} />
        </span>
        <span className="parcel-node__title">{data.label}</span>
        {problem ? (
          <span
            className={`parcel-node__badge parcel-node__badge--${problem.severity}`}
          >
            {problem.severity === 'error'
              ? 'Error'
              : problem.severity === 'warning'
                ? 'Warning'
                : 'Info'}
          </span>
        ) : null}
      </header>

      <p className="parcel-node__kind">
        {PARCEL_NODE_KIND_LABELS[data.kind]} · ${formatDecimal(hardware.hourlyUsd, 3)}/h
      </p>
      <p className="parcel-node__config">{configSummary(data.kind, data.config)}</p>

      {showTraffic ? (
        <TrafficNodeMeters
          levelId="parcel-pulse"
          kind={data.kind}
          node={data.traffic.node}
          modeLabel={data.traffic.modeLabel}
          sampleActive={data.traffic.sampleActive}
          animate={data.traffic.animate}
          showPlaceholder={data.traffic.showPlaceholder}
        />
      ) : null}

      {showMetrics ? (
        <div className="parcel-node__meters" aria-label={`${data.horizonLabel} utilization`}>
          <UtilizationMeter
            label="CPU"
            average={data.metrics!.averageCpuUtilization}
            peak={data.metrics!.peakCpuUtilization}
          />
          {showIoMeter ? (
            <UtilizationMeter
              label="IO"
              average={data.metrics!.averageIoUtilization}
              peak={data.metrics!.peakIoUtilization}
            />
          ) : null}
          <UtilizationMeter
            label="Net"
            average={data.metrics!.averageNetworkUtilization}
            peak={data.metrics!.peakNetworkUtilization}
          />
          <p className="parcel-node__stats">
            {data.horizonLabel} average · requests{' '}
            {formatInteger(data.metrics!.requests)} · errors{' '}
            {formatInteger(data.metrics!.errors)} · queue peak{' '}
            {formatInteger(data.metrics!.peakQueueDepth)}
          </p>
        </div>
      ) : data.kind === 'client' ? (
        <p className="parcel-node__muted">
          Traffic source
          {data.offeredTotal !== null && !data.stale
            ? ` · ${formatInteger(data.offeredTotal)} requests offered`
            : ''}
        </p>
      ) : data.stale ? (
        <p className="parcel-node__muted">Previous result hidden — graph or seed changed.</p>
      ) : (
        showTraffic ? null : <p className="parcel-node__muted">{spec.notes}</p>
      )}

      {problem ? (
        <p className={`parcel-node__problem parcel-node__problem--${problem.severity}`}>
          {problem.messages[0]}
          {problem.messages.length > 1 ? ` · +${problem.messages.length - 1} more` : ''}
        </p>
      ) : null}

      <Handle
        type="source"
        position={Position.Right}
        className="parcel-node__handle parcel-node__handle--source"
        isConnectable={isConnectable}
        title="Output connector: start a route, then choose its operation"
      />
      <span className="parcel-node__port" aria-hidden="true">
        {hasError ? 'fix' : 'route'}
      </span>
    </article>
  );
}
