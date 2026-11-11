import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Cpu, Database, Layers, Network, Server, Users } from 'lucide-react';

import {
  AUDIENCE_CATALOG,
  type AudienceNodeConfig,
  type AudienceNodeKind,
  type AudienceNodeMetrics,
} from '../index';
import { DASH, formatDecimal, formatInteger } from '../../ui/format';
import {
  formatDataSize,
  formatGbit,
  formatPercentExact,
} from '../../features/game-ui';
import type { TrafficNodeView } from '../../features/traffic/traffic-ui';
import {
  trafficFilledBlocks,
  trafficLoadBand,
} from '../../features/traffic/traffic-ui';
import { TrafficNodeMeters } from '../../features/traffic/TrafficNodeMeters';
import type { AudienceProblem } from './audience-diagnostics';
import {
  audienceNodeHourlyUsd,
  audienceQueueCapacity,
} from './audience-meta';

export interface AudienceInstanceHealthView {
  index: number;
  health: 'healthy' | 'unhealthy' | 'crashed' | 'booting' | null;
  healthy: boolean | null;
  target: boolean;
}

export interface AudienceCanvasNodeData extends Record<string, unknown> {
  label: string;
  kind: AudienceNodeKind;
  config: AudienceNodeConfig;
  metrics: AudienceNodeMetrics | null;
  offeredIngest: number | null;
  offeredRead: number | null;
  stale: boolean;
  problem: AudienceProblem | null;
  traffic: TrafficNodeView;
  instanceTotal: number;
  instanceHealthy: number | null;
  instances: AudienceInstanceHealthView[];
  targetInstance: number | null;
  caseLabel: string | null;
}

export type AudienceCanvasNode = Node<AudienceCanvasNodeData, 'audience'>;

const KIND_ICONS = {
  users: Users,
  lb: Network,
  app: Server,
  sql: Database,
  cache: Layers,
  worker: Cpu,
} as const;

function configLines(
  kind: AudienceNodeKind,
  config: AudienceNodeConfig,
): string[] {
  if (kind === 'users') {
    return [
      '1,000,000 users · 100 streams',
      'Record activity + View audience ranking',
    ];
  }
  if (kind === 'lb') {
    return [
      `${formatInteger(
        AUDIENCE_CATALOG.components.lb.capacityRequestsPerSec,
      )} req/s · ${formatInteger(
        AUDIENCE_CATALOG.components.lb.capacityGbitPerSec,
      )} Gbit/s`,
      'probes every 250 ms · managed',
    ];
  }
  if (kind === 'app' && 'instances' in config) {
    const spec = AUDIENCE_CATALOG.components.app;
    return [
      `${config.instances} instance${config.instances === 1 ? '' : 's'} · ${formatInteger(
        spec.cpuCoresPerInstance * config.instances,
      )} CPU · ${formatInteger(spec.memoryGbPerInstance * config.instances)} GB`,
      `slots 0–${config.instances - 1} · queue ${formatInteger(
        spec.waitingTasksPerInstance,
      )}/instance`,
    ];
  }
  if (kind === 'sql' && 'size' in config) {
    const spec = AUDIENCE_CATALOG.components.sql.sizes[config.size];
    return [
      `${config.size} · ${formatInteger(spec.cores)} CPU · ${formatInteger(
        spec.memoryGb,
      )} GB RAM · ${formatInteger(spec.diskGb)} GB disk`,
      config.readPlan === 'projection'
        ? 'Maintained projection · Worker jobs'
        : 'Indexed exact query',
    ];
  }
  if (kind === 'cache' && 'ttlSeconds' in config) {
    return [
      `TTL ${config.ttlSeconds} s · actual retention`,
      `${formatDataSize(AUDIENCE_CATALOG.components.cache.entryBytes)} shared answer`,
    ];
  }
  if (kind === 'worker' && 'instances' in config) {
    const spec = AUDIENCE_CATALOG.components.worker;
    return [
      `${config.instances} instance${config.instances === 1 ? '' : 's'} · ${formatInteger(
        spec.cpuCoresPerInstance * config.instances,
      )} CPU · ${formatInteger(spec.memoryGbPerInstance * config.instances)} GB`,
      `SQL jobs · batch ${formatInteger(
        AUDIENCE_CATALOG.policies.projection.maxBatchEvents,
      )}`,
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
    <div className="audience-node__meter-row">
      <span className="audience-node__meter-label">{label}</span>
      <span
        className={[
          'audience-load-blocks',
          band
            ? `audience-load-blocks--${band}`
            : 'audience-load-blocks--unknown',
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
      <span className="audience-node__meter-value">{valueText}</span>
      {peakText ? (
        <span className="audience-node__meter-peak">{peakText}</span>
      ) : null}
    </div>
  );
}

function ResultMeters({
  metrics,
  offeredIngest,
  offeredRead,
}: {
  metrics: AudienceNodeMetrics;
  offeredIngest: number | null;
  offeredRead: number | null;
}) {
  if (metrics.kind === 'users') {
    return (
      <p className="audience-node__source-summary">
        Fixed source · offered{' '}
        {offeredIngest === null ? DASH : formatInteger(offeredIngest)} activity
        events · {offeredRead === null ? DASH : formatInteger(offeredRead)}{' '}
        ranking reads
      </p>
    );
  }
  const queueCapacity = audienceQueueCapacity(metrics.kind);
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
    <div className="audience-node__meters" aria-label="Measured case resources">
      <LoadBlocks
        label="CPU"
        fraction={metrics.cpu.capacityCores > 0 ? metrics.cpu.utilizationAverage : null}
        valueText={metrics.cpu.capacityCores > 0 ? cpuText : DASH}
        peakText={`avg · peak ${cpuPeak}`}
        accessible={`CPU case average ${cpuText}, peak ${cpuPeak}. Filled blocks show the time-weighted average, not the peak.`}
      />
      <LoadBlocks
        label="Queue"
        fraction={queueFraction}
        valueText={queueText}
        peakText={`avg · peak ${formatInteger(metrics.queue.waitingPeak)}${
          queueCapacity === null ? '' : ` / ${formatInteger(queueCapacity)}`
        }`}
        accessible={`Queue waiting tasks: case average ${formatDecimal(
          metrics.queue.waitingAverage,
          1,
        )}, peak ${formatInteger(metrics.queue.waitingPeak)}${
          queueCapacity === null
            ? ''
            : ` of a ${formatInteger(queueCapacity)} task cap`
        }. This is observed queue depth, not a proven root cause.`}
      />
      <p className="audience-node__stats">
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

function InstanceRail({
  kind,
  total,
  healthy,
  instances,
}: {
  kind: AudienceNodeKind;
  total: number;
  healthy: number | null;
  instances: readonly AudienceInstanceHealthView[];
}) {
  if (total <= 0) {
    return null;
  }
  return (
    <div className="audience-node__instances">
      <span className="audience-node__instances-summary">
        {formatInteger(total)} instance{total === 1 ? '' : 's'} ·{' '}
        {healthy === null ? 'health —' : `${formatInteger(healthy)}/${total} healthy`}
      </span>
      {instances.length > 0 ? (
        <span className="audience-node__instance-chips">
          {instances.map((instance) => (
            <span
              key={instance.index}
              className={[
                'audience-instance-chip',
                instance.health
                  ? `audience-instance-chip--${instance.health}`
                  : 'audience-instance-chip--unknown',
                instance.target ? 'is-target' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              title={
                instance.target
                  ? `Fault target: ${kind} physical slot ${instance.index}`
                  : `${kind} physical slot ${instance.index}`
              }
            >
              s{instance.index}
              {instance.target ? ' · target' : ''}
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}

export function AudienceNode({
  data,
  selected,
  isConnectable,
}: NodeProps<AudienceCanvasNode>) {
  const Icon = KIND_ICONS[data.kind];
  const problem = data.problem;
  const liveSample = data.traffic.sampleActive;
  const showTraffic = liveSample || data.traffic.showPlaceholder;
  const showMetrics = data.metrics !== null && !data.stale && !liveSample;
  const hourly =
    data.kind === 'users'
      ? 0
      : audienceNodeHourlyUsd(data.kind, {
          instances:
            'instances' in data.config ? data.config.instances : undefined,
          size: 'size' in data.config ? data.config.size : undefined,
        });
  const hasTarget = data.kind !== 'users';
  const hasSource = data.kind !== 'sql';
  // Validation/config checks are distinct from measured runtime failure. The
  // untouched starter is suppressed upstream, so a badge here is actionable.
  const problemTone =
    problem === null
      ? null
      : problem.runtime
        ? problem.severity
        : 'validation';
  const problemLabel =
    problem === null
      ? null
      : problem.runtime
        ? problem.severity === 'error'
          ? 'Error'
          : problem.severity === 'warning'
            ? 'Pressure'
            : 'Info'
        : 'Check';

  return (
    <article
      className={[
        'audience-node',
        `audience-node--${data.kind}`,
        selected ? 'is-selected' : '',
        problemTone ? `audience-node--problem-${problemTone}` : '',
        data.targetInstance !== null ? 'is-fault-target' : '',
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
          className="audience-node__handle audience-node__handle--target"
          title="Input connector: finish a dependency here"
        />
      ) : null}

      <header className="audience-node__head">
        <span className="audience-node__icon" aria-hidden="true">
          <Icon size={17} strokeWidth={2} />
        </span>
        <span className="audience-node__title">{data.label}</span>
        {data.targetInstance !== null ? (
          <span className="audience-node__badge audience-node__badge--target">
            Fault · slot {data.targetInstance}
          </span>
        ) : null}
        {problemTone && problemLabel ? (
          <span
            className={`audience-node__badge audience-node__badge--${problemTone}`}
          >
            {problemLabel}
          </span>
        ) : null}
      </header>

      <p className="audience-node__kind">
        {data.kind === 'users'
          ? 'Fixed traffic source'
          : `$${formatDecimal(hourly, 3)}/h`}
      </p>
      {configLines(data.kind, data.config).map((line) => (
        <p className="audience-node__config" key={line}>
          {line}
        </p>
      ))}

      {data.kind === 'app' ||
      data.kind === 'worker' ||
      data.targetInstance !== null ||
      (data.metrics !== null && data.metrics.instances.length > 1) ? (
        <InstanceRail
          kind={data.kind}
          total={data.instanceTotal}
          healthy={data.instanceHealthy}
          instances={data.instances}
        />
      ) : null}

      {data.caseLabel && data.targetInstance !== null ? (
        <p className="audience-node__fault-note">
          {data.caseLabel} · actual frames drive this marker
        </p>
      ) : null}

      {showTraffic ? (
        <TrafficNodeMeters
          levelId="live-audience"
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
          offeredIngest={data.offeredIngest}
          offeredRead={data.offeredRead}
        />
      ) : null}

      {data.stale ? (
        <p className="audience-node__muted">
          Previous result hidden — graph or seed changed.
        </p>
      ) : null}

      {problem ? (
        <p
          className={`audience-node__problem audience-node__problem--${problemTone ?? 'info'}`}
        >
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
          className="audience-node__handle audience-node__handle--source"
          isConnectable={isConnectable}
          title="Output connector: start a dependency"
        />
      ) : null}
    </article>
  );
}
