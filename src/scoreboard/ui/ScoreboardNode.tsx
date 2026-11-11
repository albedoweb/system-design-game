import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Database, Layers, Server, Users } from 'lucide-react';

import {
  SCOREBOARD_CATALOG,
  type ScoreboardNodeConfig,
  type ScoreboardNodeKind,
  type ScoreboardNodeMetrics,
} from '../index';
import { formatDecimal, formatInteger } from '../../ui/format';
import type { TrafficNodeView } from '../../features/traffic/traffic-ui';
import {
  trafficFilledBlocks,
  trafficLoadBand,
} from '../../features/traffic/traffic-ui';
import { TrafficNodeMeters } from '../../features/traffic/TrafficNodeMeters';
import type { ScoreboardProblem } from './scoreboard-diagnostics';
import { scoreboardQueueCapacity } from './scoreboard-meta';
import {
  formatDataSize,
  formatGbit,
  formatPercentExact,
} from './scoreboard-format';
import { SCOREBOARD_TRAFFIC_LEVEL } from './scoreboard-traffic';

export interface ScoreboardCanvasNodeData extends Record<string, unknown> {
  label: string;
  kind: ScoreboardNodeKind;
  config: ScoreboardNodeConfig;
  metrics: ScoreboardNodeMetrics | null;
  offeredRead: number | null;
  offeredWrite: number | null;
  stale: boolean;
  problem: ScoreboardProblem | null;
  traffic: TrafficNodeView;
}

export type ScoreboardCanvasNode = Node<ScoreboardCanvasNodeData, 'scoreboard'>;

const KIND_ICONS = {
  users: Users,
  app: Server,
  sql: Database,
  cache: Layers,
} as const;

function hourlyUsd(
  kind: ScoreboardNodeKind,
  config: ScoreboardNodeConfig,
): number | null {
  if (kind === 'app' && 'instances' in config) {
    return (
      config.instances *
      SCOREBOARD_CATALOG.components.app.hourlyUsdPerInstance
    );
  }
  if (kind === 'sql' && 'size' in config) {
    return SCOREBOARD_CATALOG.components.sql.sizes[config.size].hourlyUsd;
  }
  if (kind === 'cache') {
    return SCOREBOARD_CATALOG.components.cache.hourlyUsd;
  }
  return null;
}

function configLines(
  kind: ScoreboardNodeKind,
  config: ScoreboardNodeConfig,
): string[] {
  if (kind === 'users') {
    return ['Fixed population', 'View leaderboard + Change vote'];
  }
  if (kind === 'app' && 'instances' in config) {
    const spec = SCOREBOARD_CATALOG.components.app;
    return [
      `${config.instances} instance${config.instances === 1 ? '' : 's'} · ${formatInteger(
        spec.cpuCoresPerInstance * config.instances,
      )} CPU · ${formatInteger(spec.memoryGbPerInstance * config.instances)} GB`,
      'Request distribution inside the pool',
    ];
  }
  if (kind === 'sql' && 'size' in config) {
    const spec = SCOREBOARD_CATALOG.components.sql.sizes[config.size];
    return [
      `${config.size} · ${formatInteger(spec.cores)} CPU · ${formatInteger(
        spec.memoryGb,
      )} GB`,
      SCOREBOARD_CATALOG.components.sql.readPlans[config.readPlan].label,
    ];
  }
  if (kind === 'cache' && 'ttlSeconds' in config) {
    return [
      `TTL ${config.ttlSeconds} s · coalescing on`,
      `${formatDataSize(SCOREBOARD_CATALOG.components.cache.capacityBytes)} entry`,
    ];
  }
  return [];
}

function LoadBlocks({
  label,
  fraction,
  accessible,
  valueText,
  peakText,
}: {
  label: string;
  fraction: number | null;
  accessible: string;
  valueText: string;
  peakText?: string;
}) {
  const band = trafficLoadBand(fraction);
  const filled = trafficFilledBlocks(fraction);
  return (
    <div className="scoreboard-node__meter-row">
      <span className="scoreboard-node__meter-label">{label}</span>
      <span
        className={[
          'scoreboard-load-blocks',
          band
            ? `scoreboard-load-blocks--${band}`
            : 'scoreboard-load-blocks--unknown',
        ].join(' ')}
        role="meter"
        aria-label={`${label} average utilization`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={
          fraction === null ? undefined : Math.round(fraction * 100)
        }
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
      <span className="scoreboard-node__meter-value">{valueText}</span>
      {peakText ? (
        <span className="scoreboard-node__meter-peak">{peakText}</span>
      ) : null}
    </div>
  );
}

function ResultMeters({
  metrics,
  offeredRead,
  offeredWrite,
}: {
  metrics: ScoreboardNodeMetrics;
  offeredRead: number | null;
  offeredWrite: number | null;
}) {
  if (metrics.kind === 'users') {
    return (
      <p className="scoreboard-node__source-summary">
        Fixed traffic source · offered{' '}
        {offeredRead === null ? '—' : formatInteger(offeredRead)} leaderboard
        reads · {offeredWrite === null ? '—' : formatInteger(offeredWrite)} vote
        changes
      </p>
    );
  }
  const queueCapacity = scoreboardQueueCapacity(metrics.kind);
  const queueFraction =
    queueCapacity === null || queueCapacity <= 0
      ? null
      : Math.min(1, metrics.queue.waitingAverage / queueCapacity);
  const cpuText = formatPercentExact(metrics.cpu.utilizationAverage);
  const cpuPeak = formatPercentExact(metrics.cpu.utilizationPeak);
  const queueText =
    queueCapacity === null
      ? formatDecimal(metrics.queue.waitingAverage, 1)
      : `${formatDecimal(metrics.queue.waitingAverage, 1)} / ${formatInteger(
          queueCapacity,
        )}`;
  return (
    <div className="scoreboard-node__meters" aria-label="Measured run resources">
      <LoadBlocks
        label="CPU"
        fraction={metrics.cpu.utilizationAverage}
        valueText={cpuText}
        peakText={`peak ${cpuPeak}`}
        accessible={`CPU run average ${cpuText}, peak ${cpuPeak}. Filled blocks show the run average, not the peak.`}
      />
      <LoadBlocks
        label="Queue"
        fraction={queueFraction}
        valueText={queueText}
        peakText={`peak ${formatInteger(metrics.queue.waitingPeak)}${
          queueCapacity === null ? '' : ` / ${formatInteger(queueCapacity)}`
        }`}
        accessible={`Queue waiting tasks: run average ${formatDecimal(
          metrics.queue.waitingAverage,
          1,
        )}, peak ${formatInteger(metrics.queue.waitingPeak)}${
          queueCapacity === null
            ? ''
            : ` of a ${formatInteger(queueCapacity)} task cap`
        }. This is observed queue depth, not a proven root cause.`}
      />
      <p className="scoreboard-node__stats">
        RAM peak {formatDataSize(metrics.memory.peakUsedBytes)} · Net peak{' '}
        {formatGbit(metrics.network.peakGbitPerSec)} · tasks{' '}
        {formatInteger(metrics.tasks.completed)} completed
        {metrics.tasks.rejected > 0
          ? ` · ${formatInteger(metrics.tasks.rejected)} rejected`
          : ''}
      </p>
    </div>
  );
}

export function ScoreboardNode({
  data,
  selected,
  isConnectable,
}: NodeProps<ScoreboardCanvasNode>) {
  const Icon = KIND_ICONS[data.kind];
  const problem = data.problem;
  const liveSample = data.traffic.sampleActive;
  const showTraffic = liveSample || data.traffic.showPlaceholder;
  const showMetrics = data.metrics !== null && !data.stale && !liveSample;
  const hourly = hourlyUsd(data.kind, data.config);
  const hasTarget = data.kind !== 'users';
  const hasSource = data.kind !== 'sql';

  return (
    <article
      className={[
        'scoreboard-node',
        `scoreboard-node--${data.kind}`,
        selected ? 'is-selected' : '',
        problem ? `scoreboard-node--problem-${problem.severity}` : '',
      ]
        .filter(Boolean)
        .join(' ')}
      title={
        problem
          ? problem.messages.join(' · ')
          : `${data.label}, ${data.kind}`
      }
    >
      {hasTarget ? (
        <Handle
          type="target"
          position={Position.Left}
          className="scoreboard-node__handle scoreboard-node__handle--target"
          title="Input connector: finish a dependency here"
        />
      ) : null}

      <header className="scoreboard-node__head">
        <span className="scoreboard-node__icon" aria-hidden="true">
          <Icon size={17} strokeWidth={2} />
        </span>
        <span className="scoreboard-node__title">{data.label}</span>
        {problem ? (
          <span
            className={`scoreboard-node__badge scoreboard-node__badge--${problem.severity}`}
          >
            {problem.severity === 'error'
              ? 'Error'
              : problem.severity === 'warning'
                ? 'Pressure'
                : 'Info'}
          </span>
        ) : null}
      </header>

      <p className="scoreboard-node__kind">
        {data.kind === 'users' ? 'Fixed traffic source' : hourly === null ? 'Component' : `$${formatDecimal(hourly, 3)}/h`}
      </p>
      {configLines(data.kind, data.config).map((line) => (
        <p className="scoreboard-node__config" key={line}>
          {line}
        </p>
      ))}

      {showTraffic ? (
        <TrafficNodeMeters
          levelId={SCOREBOARD_TRAFFIC_LEVEL}
          kind={data.kind}
          node={data.traffic.node}
          modeLabel={data.traffic.modeLabel}
          sampleActive={data.traffic.sampleActive}
          animate={data.traffic.animate}
          showPlaceholder={data.traffic.showPlaceholder}
        />
      ) : null}

      {showMetrics ? (
        <ResultMeters
          metrics={data.metrics!}
          offeredRead={data.offeredRead}
          offeredWrite={data.offeredWrite}
        />
      ) : null}

      {data.stale ? (
        <p className="scoreboard-node__muted">
          Previous result hidden — graph or seed changed.
        </p>
      ) : null}

      {problem ? (
        <p className={`scoreboard-node__problem scoreboard-node__problem--${problem.severity}`}>
          {problem.messages[0]}
          {problem.messages.length > 1
            ? ` · +${problem.messages.length - 1} more`
            : ''}
        </p>
      ) : null}

      {hasSource ? (
        <Handle
          type="source"
          position={Position.Right}
          className="scoreboard-node__handle scoreboard-node__handle--source"
          isConnectable={isConnectable}
          title="Output connector: start a dependency"
        />
      ) : null}
    </article>
  );
}
