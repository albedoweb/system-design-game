import { ChevronDown, Radio } from 'lucide-react';
import { useMemo, useState, type RefObject } from 'react';

import type {
  LevelDefinition,
  Metric,
  NodeMetric,
  SeriesPoint,
} from '../../domain';
import { useEditorStore } from '../../state/editor-store';
import {
  useRunEvidence,
  type RunEvidenceMode,
} from '../simulation/run-evidence';
import { DASH, formatDecimal, formatDuration, formatInteger, formatTime } from '../../ui/format';
import { LOAD_BANDS, bandTitle } from './load-bands';
import { SeriesChart, type ChartSeries } from './SeriesChart';
import './metrics.css';

function metricValue(value: number | null, digits = 1): string {
  return value === null ? DASH : formatDecimal(value, digits);
}

function MetricRow({ label, metric }: { label: string; metric: Metric }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{formatInteger(metric.offered)}</td>
      <td>{formatInteger(metric.succeeded)}</td>
      <td>{formatInteger(metric.failed)}</td>
      <td>{formatInteger(metric.pending)}</td>
      <td>{metricValue(metric.p50Ms)}</td>
      <td>{metricValue(metric.p95Ms)}</td>
      <td>{metricValue(metric.p99Ms)}</td>
    </tr>
  );
}

function nodeMetricValue(value: number, suffix = ''): string {
  return `${formatInteger(value)}${suffix}`;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'warmup':
      return 'warmup';
    case 'running':
      return 'running';
    case 'draining':
      return 'draining';
    case 'completed':
      return 'completed';
    default:
      return phase;
  }
}

const ERROR_LABELS: Readonly<Record<string, string>> = {
  timeout: 'timeouts',
  queue_overflow: 'queue overflow',
  deadline: 'deadline',
  dependency: 'dependency failure',
  cache: 'cache error',
};

function NodeTable({
  nodes,
  metrics,
  mode,
}: {
  nodes: { id: string; label: string; kind: string }[];
  metrics: NodeMetric[];
  mode: RunEvidenceMode;
}) {
  const byId = new Map(metrics.map((metric) => [metric.nodeId, metric]));
  return (
    <div className="metrics__table-wrap">
      <table className="metrics__table">
        <caption>
          {mode === 'stopped'
            ? 'Components in the stopped snapshot'
            : 'Components in the latest snapshot'}
        </caption>
        <thead>
          <tr>
            <th scope="col">Component</th>
            <th scope="col">Busy</th>
            <th scope="col">Queue</th>
            <th scope="col">Pool busy</th>
            <th scope="col">Pool wait</th>
            <th scope="col">Hits / misses</th>
            <th scope="col">Coalesced</th>
            <th scope="col">Errors</th>
            <th scope="col">Completed</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => {
            const metric = byId.get(node.id);
            const boundedPool = node.kind === 'appServer' || node.kind === 'cache';
            const hitMiss = !metric
              ? DASH
              : node.kind === 'cache'
                ? `${nodeMetricValue(metric.hits)} / ${nodeMetricValue(metric.misses)}`
                : DASH;
            return (
              <tr key={node.id}>
                <th scope="row">{node.label}</th>
                <td>{metric ? nodeMetricValue(metric.busy) : DASH}</td>
                <td>{metric ? nodeMetricValue(metric.queued) : DASH}</td>
                <td>{metric && boundedPool ? nodeMetricValue(metric.poolBusy) : DASH}</td>
                <td>{metric && boundedPool ? nodeMetricValue(metric.poolQueued) : DASH}</td>
                <td>{hitMiss}</td>
                <td>{metric && node.kind === 'cache' ? nodeMetricValue(metric.coalesced) : DASH}</td>
                <td>{metric ? nodeMetricValue(metric.errors) : DASH}</td>
                <td>{metric ? nodeMetricValue(metric.completed) : DASH}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function peakCell(value: number | null, average: number | null): string {
  if (value === null) {
    return DASH;
  }
  return average === null
    ? formatInteger(value)
    : `${formatInteger(value)} (avg ${formatDecimal(average, 1)})`;
}

function failureText(
  failures: ReadonlyArray<{ code: string; stage: string; count: number }>,
): string {
  if (failures.length === 0) {
    return DASH;
  }
  return failures
    .map((failure) => `${failure.code} @ ${failure.stage} ×${failure.count}`)
    .join('; ');
}

function PressureTable({
  nodes,
  metrics,
  mode,
}: {
  nodes: { id: string; label: string; kind: string }[];
  metrics: NodeMetric[];
  mode: RunEvidenceMode;
}) {
  const byId = new Map(metrics.map((metric) => [metric.nodeId, metric]));
  const rows = nodes.flatMap((node) => {
    const metric = byId.get(node.id);
    if (!metric?.pressure) {
      return [];
    }
    return [{ node, metric, pressure: metric.pressure }];
  });
  if (rows.length === 0) {
    return null;
  }
  return (
    <div className="metrics__table-wrap">
      <table className="metrics__table">
        <caption>
          {mode === 'stopped'
            ? 'Pressure observed so far (stopped)'
            : 'Peak during run and failure locations'}
        </caption>
        <thead>
          <tr>
            <th scope="col">Component</th>
            <th scope="col">Observed</th>
            <th scope="col">Slots peak (avg)</th>
            <th scope="col">Pool peak (avg)</th>
            <th scope="col">Queue peak</th>
            <th scope="col">Pool wait peak</th>
            <th scope="col">Failure locations</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ node, metric, pressure }) => (
            <tr key={node.id}>
              <th scope="row">{node.label}</th>
              <td>{formatDuration(pressure.observedMs)}</td>
              <td>
                {node.kind === 'appServer' || node.kind === 'database'
                  ? peakCell(pressure.busyPeak, pressure.busyAvg)
                  : DASH}
              </td>
              <td>
                {node.kind === 'appServer' || node.kind === 'cache'
                  ? peakCell(pressure.poolBusyPeak, pressure.poolBusyAvg)
                  : DASH}
              </td>
              <td>{formatInteger(metric.maxQueued)}</td>
              <td>
                {node.kind === 'appServer' || node.kind === 'cache'
                  ? formatInteger(pressure.poolQueuedPeak)
                  : DASH}
              </td>
              <td>{failureText(pressure.failures)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LoadLegend() {
  return (
    <div className="load-legend" aria-label="Occupancy band thresholds">
      <span className="load-legend__title">Occupancy bands</span>
      <ul>
        {LOAD_BANDS.map((item) => (
          <li key={item.band} title={bandTitle(item.band)}>
            <span className={`load-legend__swatch load-legend__swatch--${item.band}`} />
            {item.range}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MetricsPanel({
  level,
  open: openProp,
  onOpenChange,
  height = null,
  panelRef,
}: {
  level: LevelDefinition;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  height?: number | null;
  panelRef?: RefObject<HTMLElement | null>;
}) {
  const [internalOpen, setInternalOpen] = useState(true);
  const open = openProp ?? internalOpen;
  const evidence = useRunEvidence();
  const snapshot = evidence.snapshot;
  const graph = useEditorStore((state) => state.graph);

  const setOpen = (next: boolean) => {
    if (onOpenChange) {
      onOpenChange(next);
    } else {
      setInternalOpen(next);
    }
  };

  const points = useMemo<SeriesPoint[]>(
    () =>
      (snapshot?.series ?? []).filter(
        (point) => point.timeMs >= 0 && point.timeMs <= level.durationMs,
      ),
    [level.durationMs, snapshot],
  );
  const times = points.map((point) => point.timeMs);
  const trafficSeries: ChartSeries[] = [
    {
      label: 'offered',
      color: '#0e7490',
      values: points.map((point) => point.readRps + point.writeRps),
    },
    {
      label: 'goodput',
      color: '#15803d',
      values: points.map((point) => point.successRps),
    },
    {
      label: 'errors',
      color: '#b42318',
      values: points.map((point) => point.errorRps),
    },
  ];
  const latencySeries: ChartSeries[] = [
    {
      label: 'p95',
      color: '#1d4ed8',
      values: points.map((point) => point.p95Ms),
    },
  ];
  const dbSeries: ChartSeries[] = [
    {
      label: 'DB queue',
      color: '#b45309',
      values: points.map((point) => point.dbQueue),
    },
  ];
  const errorEntries = snapshot
    ? [
        ...Object.entries(snapshot.reads.errors).map(([code, count]) => ({
          label: `reads · ${ERROR_LABELS[code] ?? code}`,
          count,
        })),
        ...Object.entries(snapshot.writes.errors).map(([code, count]) => ({
          label: `writes · ${ERROR_LABELS[code] ?? code}`,
          count,
        })),
      ]
    : [];
  const hasPressure = (snapshot?.nodes ?? []).some((metric) => metric.pressure);
  const nodes = graph.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
  }));
  const summary = evidence.stale
    ? 'previous run'
    : snapshot
      ? `${formatTime(snapshot.timeMs)} · ${
          evidence.phase === 'paused'
            ? 'paused'
            : evidence.phase === 'stopped'
              ? 'stopped'
              : phaseLabel(snapshot.phase)
        }`
      : evidence.phase === 'stopped'
        ? 'stopped · no snapshot'
        : 'no data yet';

  return (
    <section
      ref={panelRef}
      className={[
        'metrics',
        open ? 'is-open' : '',
        height !== null ? 'has-custom-height' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={open && height !== null ? { height: `${height}px` } : undefined}
      aria-label="Telemetry"
    >
      <button
        type="button"
        className="metrics__toggle"
        aria-expanded={open}
        aria-controls="metrics-body"
        onClick={() => setOpen(!open)}
      >
        <span className="metrics__toggle-title">
          <Radio size={16} aria-hidden="true" />
          Telemetry
        </span>
        <span className="metrics__summary">{summary}</span>
        <ChevronDown
          size={17}
          aria-hidden="true"
          className={open ? 'is-rotated' : ''}
        />
      </button>

      {open ? (
        <div className="metrics__body" id="metrics-body">
          {evidence.stale ? (
            <p className="metrics__stale" role="status">
              Previous run — the graph, settings, or seed changed. Metrics and
              failure highlights are hidden until you run again.
            </p>
          ) : !snapshot ? (
            evidence.phase === 'stopped' ? (
              <p className="metrics__stopped" role="status">
                Stopped before the first snapshot. No metrics were captured and
                no pass/fail verdict is produced.
              </p>
            ) : (
              <p className="metrics__empty">
                Run the simulation to see latency, errors, and load on each
                component.
              </p>
            )
          ) : (
            <>
              {evidence.mode === 'stopped' ? (
                <p className="metrics__stopped" role="status">
                  Stopped — this is the last snapshot at{' '}
                  {formatTime(snapshot.timeMs)}, not a live reading or a
                  completed evaluation. No pass/fail verdict is produced.
                  Pressure is observed only up to the stop.
                </p>
              ) : null}
              <div className="metrics__charts">
                <SeriesChart
                  title="Requests"
                  series={trafficSeries}
                  timesMs={times}
                  durationMs={level.durationMs}
                  criticalFromMs={level.slo.criticalFromMs}
                  criticalToMs={level.slo.criticalToMs}
                  flushAtMs={level.flushAtMs}
                  unit="requests/s"
                />
                <SeriesChart
                  title="p95 successful"
                  series={latencySeries}
                  timesMs={times}
                  durationMs={level.durationMs}
                  criticalFromMs={level.slo.criticalFromMs}
                  criticalToMs={level.slo.criticalToMs}
                  flushAtMs={level.flushAtMs}
                  unit="ms"
                  valueDigits={0}
                />
                <SeriesChart
                  title="Database queue"
                  series={dbSeries}
                  timesMs={times}
                  durationMs={level.durationMs}
                  criticalFromMs={level.slo.criticalFromMs}
                  criticalToMs={level.slo.criticalToMs}
                  flushAtMs={level.flushAtMs}
                  unit="requests"
                />
              </div>

              <div className="metrics__table-wrap">
                <table className="metrics__table">
                  <caption>Cumulative for the evaluation</caption>
                  <thead>
                    <tr>
                      <th scope="col">Class</th>
                      <th scope="col">Offered</th>
                      <th scope="col">Succeeded</th>
                      <th scope="col">Errors</th>
                      <th scope="col">Pending</th>
                      <th scope="col">p50</th>
                      <th scope="col">p95</th>
                      <th scope="col">p99</th>
                    </tr>
                  </thead>
                  <tbody>
                    <MetricRow label="Reads" metric={snapshot.reads} />
                    <MetricRow label="Writes" metric={snapshot.writes} />
                  </tbody>
                </table>
              </div>

              <NodeTable
                nodes={nodes}
                metrics={snapshot.nodes}
                mode={evidence.mode}
              />

              <PressureTable
                nodes={nodes}
                metrics={snapshot.nodes}
                mode={evidence.mode}
              />

              {evidence.mode === 'peak' && !hasPressure ? (
                <p className="metrics__note metrics__note--warning" role="status">
                  This run does not include peak occupancy or failure locations.
                  The engine build reports current counters and queue peaks
                  only; peak evidence appears when the engine supplies it.
                </p>
              ) : null}

              <LoadLegend />

              {errorEntries.length > 0 ? (
                <p className="metrics__errors">
                  Errors:{' '}
                  {errorEntries
                    .map((entry) => `${entry.label}: ${formatInteger(entry.count)}`)
                    .join(' · ')}
                </p>
              ) : null}
              <p className="metrics__note">
                Coalesced counts cache misses that shared one in-flight database
                read instead of each starting its own. p50/p95/p99 cover
                successful requests only; “—” means no data. The amber band
                marks the critical SLO window; the flush line marks the cache
                flush.
              </p>
              <p className="metrics__note">
                Queue is admission waiting; pool wait is waiting for a
                downstream connection. Cache entries show capacity, not load —
                hits and misses describe efficiency. Failure locations are the
                stages where requests were rejected or reached their deadline,
                not proof of root cause.
              </p>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
