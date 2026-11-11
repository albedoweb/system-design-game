import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  SCOREBOARD_LEVEL,
  SCOREBOARD_OPERATION_LABELS,
  type ScoreboardEvaluation,
  type ScoreboardOperation,
} from '../index';
import { DASH, formatDecimal, formatInteger } from '../../ui/format';
import {
  CHART_METRIC_COLORS,
  MetricChart,
  ReportSection,
  ReportTable,
  RequirementTable,
  useChartCursor,
} from '../../features/game-ui';
import {
  observedTrafficFrames,
  observedTrafficScopes,
  useTrafficStore,
} from '../../features/traffic/traffic-store';
import {
  scoreboardResultStale,
  uniqueScoreboardIssues,
} from './scoreboard-diagnostics';
import {
  formatAvailability,
  formatBoolean,
  formatDataSize,
  formatGbit,
  formatHourlyUsd,
  formatMillisecondsPrecise,
  formatPercentExact,
  formatSeriesRate,
  formatSuccessfulMilliseconds,
  formatUnitValue,
  formatUsdPrecise,
} from './scoreboard-format';
import {
  SCOREBOARD_NODE_KIND_LABELS,
  scoreboardLinkLabel,
  scoreboardQueueCapacity,
} from './scoreboard-meta';
import { useScoreboardStore } from './scoreboard-store';
import { SCOREBOARD_TRAFFIC_LEVEL } from './scoreboard-traffic';
import './scoreboard.css';

function ProgressBlock({
  phase,
  message,
  completed,
  total,
}: {
  phase: string;
  message: string;
  completed: number;
  total: number;
}) {
  const percent =
    total > 0 ? Math.max(0, Math.min(100, (completed / total) * 100)) : 0;
  return (
    <div className="scoreboard-progress">
      <div
        className="scoreboard-progress__track"
        role="progressbar"
        aria-label={`Evaluation ${phase}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <p>
        <strong>{phase}</strong> · {message}
      </p>
      <p className="scoreboard-results__note">
        {formatInteger(completed)} of {formatInteger(total)} scheduled requests
        processed. Charts and the full report appear only when the run finishes;
        the canvas shows measured traffic frames as they arrive.
      </p>
    </div>
  );
}

function SelectedComponent({
  evaluation,
  nodeId,
}: {
  evaluation: ScoreboardEvaluation;
  nodeId: string | null;
}) {
  const node = nodeId
    ? evaluation.nodes.find((item) => item.nodeId === nodeId)
    : undefined;
  return (
    <div className="scoreboard-selected" role="status" aria-live="polite">
      <strong>Selected component</strong>
      {node ? (
        <span>
          {node.label} · CPU avg {formatPercentExact(node.cpu.utilizationAverage)} /
          peak {formatPercentExact(node.cpu.utilizationPeak)} · queue avg{' '}
          {formatDecimal(node.queue.waitingAverage, 1)} / peak{' '}
          {formatInteger(node.queue.waitingPeak)}
          {scoreboardQueueCapacity(node.kind) !== null
            ? ` of ${formatInteger(scoreboardQueueCapacity(node.kind)!)}`
            : ''}
        </span>
      ) : (
        <span>
          Select a component on the canvas to filter Queue and Resources. Traffic
          and latency follow the selected operation.
        </span>
      )}
    </div>
  );
}

function ChartGrid({
  evaluation,
  selectedOperation,
  onSelectOperation,
  selectedNodeId,
}: {
  evaluation: ScoreboardEvaluation;
  selectedOperation: ScoreboardOperation;
  onSelectOperation: (operation: ScoreboardOperation) => void;
  selectedNodeId: string | null;
}) {
  const { cursorMs, setCursorMs } = useChartCursor();
  const replayFrame = useTrafficStore((state) => state.replayFrame);
  const runId = useScoreboardStore((state) => state.runId);

  const points = evaluation.series;
  const timesMs = points.map((point) => point.timeMs);
  const durationMs =
    evaluation.window !== null
      ? Math.max(
          1,
          evaluation.window.measuredEndMs - evaluation.window.measuredStartMs,
        )
      : SCOREBOARD_LEVEL.workload.measuredMs;

  useEffect(() => {
    setCursorMs(null);
  }, [runId, setCursorMs]);

  useEffect(() => {
    if (replayFrame && cursorMs !== replayFrame.timeMs) {
      setCursorMs(replayFrame.timeMs);
    }
  }, [cursorMs, replayFrame, setCursorMs]);

  const seekRecordedFrame = useCallback(
    (timeMs: number) => {
      if (!runId) {
        return;
      }
      const scopes = observedTrafficScopes(SCOREBOARD_TRAFFIC_LEVEL, runId);
      const scopeId =
        useTrafficStore.getState().replayScopeId ?? scopes[0]?.scopeId;
      if (!scopeId) {
        return;
      }
      const frames = observedTrafficFrames(
        SCOREBOARD_TRAFFIC_LEVEL,
        runId,
        scopeId,
      );
      if (frames.length === 0) {
        return;
      }
      if (!useTrafficStore.getState().replayScopeId) {
        useTrafficStore.getState().startReplay(scopeId);
      }
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      frames.forEach((frame, index) => {
        const distance = Math.abs(frame.timeMs - timeMs);
        if (distance < bestDistance) {
          best = index;
          bestDistance = distance;
        }
      });
      useTrafficStore.getState().seekReplay(best);
    },
    [runId],
  );

  const handleCursor = useCallback(
    (timeMs: number | null) => {
      setCursorMs(timeMs);
      if (timeMs !== null) {
        seekRecordedFrame(timeMs);
      }
    },
    [seekRecordedFrame, setCursorMs],
  );

  const trafficOperations = useMemo(
    () =>
      (['read', 'write'] as const).map((operation) => ({
        id: operation,
        label: SCOREBOARD_OPERATION_LABELS[operation],
        series: [
          {
            label: 'Offered',
            color: CHART_METRIC_COLORS.offered,
            values: points.map((point) =>
              formatSeriesRate(
                point.traffic[operation].offered,
                point.windowMs,
              ),
            ),
          },
          {
            label: 'Succeeded',
            color: CHART_METRIC_COLORS.successful,
            values: points.map((point) =>
              formatSeriesRate(
                point.traffic[operation].succeeded,
                point.windowMs,
              ),
            ),
          },
          {
            label: 'Errors',
            color: CHART_METRIC_COLORS.errors,
            values: points.map((point) =>
              formatSeriesRate(
                point.traffic[operation].failed,
                point.windowMs,
              ),
            ),
          },
        ],
      })),
    [points],
  );

  const latencyOperations = useMemo(
    () =>
      (['read', 'write'] as const).map((operation) => ({
        id: operation,
        label: SCOREBOARD_OPERATION_LABELS[operation],
        series: [
          {
            label: 'p50',
            color: '#0f766e',
            values: points.map(
              (point) => point.latency[operation]?.p50Ms ?? null,
            ),
          },
          {
            label: 'p95',
            color: CHART_METRIC_COLORS.latency,
            values: points.map(
              (point) => point.latency[operation]?.p95Ms ?? null,
            ),
          },
          {
            label: 'p99',
            color: '#b45309',
            values: points.map(
              (point) => point.latency[operation]?.p99Ms ?? null,
            ),
          },
        ],
      })),
    [points],
  );

  const nodeSamples = useMemo(
    () =>
      selectedNodeId === null
        ? []
        : points.map(
            (point) =>
              point.nodes.find((node) => node.nodeId === selectedNodeId) ??
              null,
          ),
    [points, selectedNodeId],
  );

  const queueSeries = useMemo(
    () => [
      {
        label: 'Waiting now',
        color: CHART_METRIC_COLORS.queue,
        values: nodeSamples.map((node) => node?.queueWaiting ?? null),
      },
      {
        label: 'Interval average',
        color: '#0f766e',
        values: nodeSamples.map((node) => node?.queueWaitingAverage ?? null),
        dashed: true,
      },
    ],
    [nodeSamples],
  );

  const cpuSeries = useMemo(
    () => [
      {
        label: 'CPU',
        color: CHART_METRIC_COLORS.resource,
        values: nodeSamples.map((node) =>
          node && node.cpuUtilization !== null
            ? node.cpuUtilization * 100
            : null,
        ),
      },
    ],
    [nodeSamples],
  );

  const ramSeries = useMemo(
    () => [
      {
        label: 'RAM',
        color: CHART_METRIC_COLORS.resource,
        values: nodeSamples.map((node) =>
          node && node.ramUsedBytes !== null
            ? node.ramUsedBytes / (1024 * 1024)
            : null,
        ),
      },
    ],
    [nodeSamples],
  );

  const networkSeries = useMemo(
    () => [
      {
        label: 'Network',
        color: CHART_METRIC_COLORS.resource,
        values: nodeSamples.map((node) => node?.networkGbitPerSec ?? null),
      },
    ],
    [nodeSamples],
  );

  return (
    <section className="scoreboard-charts" aria-label="Run telemetry charts">
      <div className="scoreboard-charts__head">
        <h3>Telemetry</h3>
        <p>
          Hover or use the keyboard on a chart to inspect one time; hovering also
          seeks the recorded canvas frames. The shaded band is the 20–60 s peak.
        </p>
      </div>
      <SelectedComponent evaluation={evaluation} nodeId={selectedNodeId} />
      <div className="game-charts">
        <MetricChart
          kind="traffic"
          operations={trafficOperations}
          selectedOperationId={selectedOperation}
          onOperationChange={(id) =>
            onSelectOperation(id === 'write' ? 'write' : 'read')
          }
          timesMs={timesMs}
          durationMs={durationMs}
          criticalFromMs={SCOREBOARD_LEVEL.workload.peakWindow.fromMs}
          criticalToMs={SCOREBOARD_LEVEL.workload.peakWindow.toMs}
          criticalLabel="peak window"
          unit="requests/s"
          valueDigits={1}
          valueFormatter={(value) => `${formatDecimal(value, 1)}/s`}
          cursorMs={cursorMs}
          onCursorChange={handleCursor}
          emptyLabel="No traffic series in this result."
        />
        <MetricChart
          kind="latency"
          operations={latencyOperations}
          selectedOperationId={selectedOperation}
          onOperationChange={(id) =>
            onSelectOperation(id === 'write' ? 'write' : 'read')
          }
          timesMs={timesMs}
          durationMs={durationMs}
          criticalFromMs={SCOREBOARD_LEVEL.workload.peakWindow.fromMs}
          criticalToMs={SCOREBOARD_LEVEL.workload.peakWindow.toMs}
          criticalLabel="peak window"
          slo={{
            value: SCOREBOARD_LEVEL.slo.successfulP95Ms,
            label: 'p95 SLO',
          }}
          unit="ms"
          valueFormatter={(value) => formatMillisecondsPrecise(value)}
          cursorMs={cursorMs}
          onCursorChange={handleCursor}
          emptyLabel="No successful-response percentiles in this result."
        />
        <MetricChart
          kind="queue"
          title="Queue · selected component"
          series={selectedNodeId === null ? [] : queueSeries}
          timesMs={timesMs}
          durationMs={durationMs}
          criticalFromMs={SCOREBOARD_LEVEL.workload.peakWindow.fromMs}
          criticalToMs={SCOREBOARD_LEVEL.workload.peakWindow.toMs}
          criticalLabel="peak window"
          unit="waiting tasks"
          valueDigits={1}
          cursorMs={cursorMs}
          onCursorChange={handleCursor}
          emptyLabel="Select a component to see its queue."
        />
        <MetricChart
          kind="resources"
          title="CPU · selected component"
          series={selectedNodeId === null ? [] : cpuSeries}
          timesMs={timesMs}
          durationMs={durationMs}
          criticalFromMs={SCOREBOARD_LEVEL.workload.peakWindow.fromMs}
          criticalToMs={SCOREBOARD_LEVEL.workload.peakWindow.toMs}
          criticalLabel="peak window"
          unit="%"
          valueDigits={1}
          valueFormatter={(value) => `${formatDecimal(value, 1)}%`}
          cursorMs={cursorMs}
          onCursorChange={handleCursor}
          emptyLabel="Select a component to see CPU."
        />
        <MetricChart
          kind="resources"
          title="RAM · selected component"
          series={selectedNodeId === null ? [] : ramSeries}
          timesMs={timesMs}
          durationMs={durationMs}
          criticalFromMs={SCOREBOARD_LEVEL.workload.peakWindow.fromMs}
          criticalToMs={SCOREBOARD_LEVEL.workload.peakWindow.toMs}
          criticalLabel="peak window"
          unit="MiB"
          valueDigits={1}
          valueFormatter={(value) => `${formatDecimal(value, 1)} MiB`}
          cursorMs={cursorMs}
          onCursorChange={handleCursor}
          emptyLabel="Select a component to see RAM."
        />
        <MetricChart
          kind="resources"
          title="Network · selected component"
          series={selectedNodeId === null ? [] : networkSeries}
          timesMs={timesMs}
          durationMs={durationMs}
          criticalFromMs={SCOREBOARD_LEVEL.workload.peakWindow.fromMs}
          criticalToMs={SCOREBOARD_LEVEL.workload.peakWindow.toMs}
          criticalLabel="peak window"
          unit="Gbit/s"
          valueDigits={2}
          valueFormatter={(value) => formatGbit(value)}
          cursorMs={cursorMs}
          onCursorChange={handleCursor}
          emptyLabel="Select a component to see network."
        />
      </div>
      <p className="scoreboard-results__note">
        Engine series are one-second totals; rates divide by each interval’s
        actual window. Null samples stay unknown. RAM frames are instantaneous
        once-per-second samples. Queue depth is observed pressure, not a proven
        root cause.
      </p>
    </section>
  );
}

function RequirementsReport({
  evaluation,
}: {
  evaluation: ScoreboardEvaluation;
}) {
  return (
    <ReportSection
      title="Requirements"
      description="Measured for the whole run and separately for the 20–60 s peak offer cohort."
      note="Checks without data do not pass. Sample counts cover successful responses."
    >
      <RequirementTable
        nameLabel="Check"
        caption="Live Scoreboard requirements"
        columnLabels={{ limit: 'Target' }}
        columns={['actual', 'limit', 'requirement', 'result']}
        rows={evaluation.gates.map((gate) => ({
          key: gate.id,
          label: gate.label,
          detail: `${gate.message} · ${
            gate.operation
              ? SCOREBOARD_OPERATION_LABELS[gate.operation]
              : 'all operations'
          } · ${gate.window ?? 'whole'} · ${formatInteger(
            gate.sampleCount,
          )} samples`,
          actual: formatUnitValue(gate.actual, gate.unit),
          limit: formatUnitValue(gate.limit, gate.unit),
          requirement: gate.severity === 'required' ? 'Required' : 'Advisory',
          result: { passed: gate.passed },
        }))}
        empty={
          <p className="scoreboard-results__note">
            No requirement rows were reported for this run.
          </p>
        }
      />
    </ReportSection>
  );
}

function OperationsReport({
  evaluation,
}: {
  evaluation: ScoreboardEvaluation;
}) {
  if (evaluation.operations === null) {
    return (
      <ReportSection title="Operations">
        <p className="scoreboard-results__note">
          Operations were not measured for this run. Unknown is not a pass.
        </p>
      </ReportSection>
    );
  }
  const rows = (['whole', 'peak'] as const).flatMap((window) =>
    (['read', 'write'] as const).map((operation) => {
      const metrics =
        window === 'whole'
          ? evaluation.operations![operation]
          : evaluation.operations!.peak[operation];
      return {
        key: `${window}-${operation}`,
        header: `${SCOREBOARD_OPERATION_LABELS[operation]} · ${
          window === 'whole' ? 'whole 90 s' : 'peak 20–60 s'
        }`,
        cells: [
          formatInteger(metrics.offered),
          formatAvailability(metrics.availability),
          formatInteger(metrics.succeeded),
          formatInteger(metrics.failed),
          formatInteger(metrics.rejected),
          formatInteger(metrics.timedOut),
          formatInteger(metrics.errored),
          formatSuccessfulMilliseconds(metrics.latency.p50Ms, metrics.succeeded),
          formatSuccessfulMilliseconds(metrics.latency.p95Ms, metrics.succeeded),
          formatSuccessfulMilliseconds(metrics.latency.p99Ms, metrics.succeeded),
          formatSuccessfulMilliseconds(metrics.latency.maxMs, metrics.succeeded),
          formatInteger(metrics.latency.samples),
          formatDataSize(metrics.bytesOffered),
          formatDataSize(metrics.bytesDelivered),
        ],
      };
    }),
  );

  return (
    <ReportSection
      title="Operations"
      description="Whole-run and peak offer cohorts. Outcomes are attributed even when a peak request finishes during drain."
      note="Availability counts every offered request. Percentiles cover successful responses only."
    >
      <ReportTable
        rowHeaderLabel="Operation"
        caption="Measured requests"
        minWidthPx={1280}
        columns={[
          { key: 'offered', label: 'Offered' },
          { key: 'availability', label: 'Available' },
          { key: 'succeeded', label: 'Succeeded' },
          { key: 'failed', label: 'Failed' },
          { key: 'rejected', label: 'Rejected' },
          { key: 'timedout', label: 'Timed out' },
          { key: 'errored', label: 'Errored' },
          { key: 'p50', label: 'p50' },
          { key: 'p95', label: 'p95' },
          { key: 'p99', label: 'p99' },
          { key: 'max', label: 'Max' },
          { key: 'samples', label: 'Samples' },
          { key: 'bytesoffered', label: 'Bytes offered' },
          { key: 'bytesdelivered', label: 'Bytes delivered' },
        ]}
        rows={rows}
      />
    </ReportSection>
  );
}

function ComponentsReport({
  evaluation,
}: {
  evaluation: ScoreboardEvaluation;
}) {
  return (
    <ReportSection
      title="Components"
      description="Run averages and peaks are separate. Queue caps come from the level, not from a guessed node limit."
      note="RAM average is a sampled average of once-per-second instantaneous readings, not an exact residence integral. A high sample is evidence of local pressure; only an engine issue or a failed requirement makes it a cause."
    >
      <ReportTable
        rowHeaderLabel="Component"
        caption="Measured resource use"
        minWidthPx={1450}
        columns={[
          { key: 'cpua', label: 'CPU avg' },
          { key: 'cpup', label: 'CPU peak' },
          {
            key: 'rama',
            label: 'RAM sampled avg',
            title:
              'Arithmetic average of once-per-second RAM samples. It is not an exact residence-time integral.',
          },
          { key: 'ramp', label: 'RAM peak / cap' },
          { key: 'qa', label: 'Queue avg' },
          { key: 'qp', label: 'Queue peak' },
          { key: 'wait', label: 'Wait avg / max' },
          { key: 'neta', label: 'Net avg' },
          { key: 'netp', label: 'Net peak / cap' },
          { key: 'tasks', label: 'Tasks' },
        ]}
        rows={evaluation.nodes.map((node) => {
          if (node.kind === 'users') {
            // Users is an offered stream, not a modeled server. Zero-capacity
            // hardware cells must not look like measured 0% utilization.
            return {
              key: node.nodeId,
              header: `${node.label} · ${SCOREBOARD_NODE_KIND_LABELS[node.kind]}`,
              cells: [
                DASH,
                DASH,
                DASH,
                DASH,
                DASH,
                DASH,
                DASH,
                DASH,
                DASH,
                'Traffic source',
              ],
            };
          }
          const cap = scoreboardQueueCapacity(node.kind);
          return {
            key: node.nodeId,
            header: `${node.label} · ${SCOREBOARD_NODE_KIND_LABELS[node.kind]}`,
            cells: [
              node.cpu.capacityCores > 0
                ? formatPercentExact(node.cpu.utilizationAverage)
                : DASH,
              node.cpu.capacityCores > 0
                ? formatPercentExact(node.cpu.utilizationPeak)
                : DASH,
              node.memory.capacityBytes > 0
                ? formatDataSize(node.memory.residentBytesAverage)
                : DASH,
              node.memory.capacityBytes > 0
                ? `${formatDataSize(node.memory.peakUsedBytes)} / ${formatDataSize(
                    node.memory.capacityBytes,
                  )}`
                : DASH,
              cap === null ? DASH : formatDecimal(node.queue.waitingAverage, 1),
              cap === null
                ? DASH
                : `${formatInteger(node.queue.waitingPeak)} / ${formatInteger(
                    cap,
                  )}`,
              cap === null
                ? DASH
                : `${formatMillisecondsPrecise(
                    node.queue.waitMsAverage,
                  )} / ${formatMillisecondsPrecise(node.queue.waitMsMax)}`,
              node.network.capacityGbitPerSec > 0
                ? formatGbit(node.network.averageGbitPerSec)
                : DASH,
              node.network.capacityGbitPerSec > 0
                ? `${formatGbit(node.network.peakGbitPerSec)} / ${formatGbit(
                    node.network.capacityGbitPerSec,
                  )}`
                : DASH,
              `${formatInteger(node.tasks.completed)} / ${formatInteger(
                node.tasks.submitted,
              )} done · ${formatInteger(node.tasks.rejected)} rejected · ${formatInteger(
                node.tasks.timedOut,
              )} timed out · ${formatInteger(node.tasks.interrupted)} interrupted`,
            ],
          };
        })}
        empty={
          <p className="scoreboard-results__note">
            No component metrics were reported for this run.
          </p>
        }
      />
    </ReportSection>
  );
}

function LinksReport({ evaluation }: { evaluation: ScoreboardEvaluation }) {
  const labelOf = (id: string) =>
    evaluation.nodes.find((node) => node.nodeId === id)?.label ?? id;
  return (
    <ReportSection
      title="Connections"
      description="Traffic and bytes attributed to each dependency. The Application → SQL Database path carries vote writes and any direct reads."
    >
      <ReportTable
        rowHeaderLabel="Connection"
        caption="Measured link use"
        minWidthPx={1100}
        columns={[
          { key: 'role', label: 'Role' },
          { key: 'read', label: 'Reads' },
          { key: 'write', label: 'Writes' },
          { key: 'fill', label: 'Fills' },
          { key: 'total', label: 'Total' },
          { key: 'bo', label: 'Bytes offered' },
          { key: 'bd', label: 'Bytes delivered' },
          { key: 'peakreq', label: 'Peak req/s' },
          { key: 'peakbytes', label: 'Peak bytes' },
        ]}
        rows={evaluation.links.map((link) => ({
          key: link.edgeId,
          header: `${labelOf(link.from)} → ${labelOf(link.to)}`,
          cells: [
            scoreboardLinkLabel(link.role),
            formatInteger(link.requests.read),
            formatInteger(link.requests.write),
            formatInteger(link.requests.fill),
            formatInteger(link.requestsTotal),
            formatDataSize(link.bytesOffered),
            formatDataSize(link.bytesDelivered),
            formatDecimal(link.peakRequestsPerSecond, 1),
            link.peakBytesPerSecond === 0
              ? DASH
              : `${formatDataSize(link.peakBytesPerSecond)}/s`,
          ],
        }))}
        empty={
          <p className="scoreboard-results__note">
            No connection metrics were reported for this run.
          </p>
        }
      />
    </ReportSection>
  );
}

function verdictCell(value: boolean | null | undefined) {
  if (value === null || value === undefined) {
    return DASH;
  }
  return (
    <span className={value ? 'is-pass' : 'is-fail'}>
      {value ? 'Pass' : 'Fail'}
    </span>
  );
}

function DataReport({ evaluation }: { evaluation: ScoreboardEvaluation }) {
  const correctness = evaluation.correctness;
  const freshness = evaluation.freshness;
  return (
    <>
      <ReportSection
        title="Data · correctness"
        description="Every vote change replaces the participant’s current choice. A committed effect is never lost or counted twice."
        note="Unknown values are shown as — and never become zero or a pass."
      >
        <ReportTable
          rowHeaderLabel="Measurement"
          caption="Correctness counters"
          columns={[
            { key: 'value', label: 'Value' },
            { key: 'verdict', label: 'Verdict' },
          ]}
          rows={[
            row('Correctness verdict', correctness ? (correctness.valid ? 'Valid' : 'Invalid') : DASH, correctness ? correctness.valid : null),
            row('Writes offered', formatInteger(correctness?.writesOffered), null),
            row('Writes committed', formatInteger(correctness?.writesCommitted), null),
            row('Writes acknowledged', formatInteger(correctness?.writesAcknowledged), null),
            row('Committed but unacknowledged', formatInteger(correctness?.committedUnacknowledged), null),
            row('No-op writes', formatInteger(correctness?.noOpWrites), null),
            row('Invalid votes', formatInteger(correctness?.invalidVotes), null),
            row('Double effects', formatInteger(correctness?.doubleEffects), correctness ? correctness.doubleEffects === 0 : null),
            row('Lost acknowledged votes', formatInteger(correctness?.lostAcknowledgedVotes), correctness ? correctness.lostAcknowledgedVotes === 0 : null),
            row('Aggregate mismatches', formatInteger(correctness?.aggregateMismatches), correctness ? correctness.aggregateMismatches === 0 : null),
            row('Snapshot mismatches', formatInteger(correctness?.snapshotMismatches), correctness ? correctness.snapshotMismatches === 0 : null),
            row('Checked snapshots', formatInteger(correctness?.checkedSnapshots), null),
            row('Final state matches reference', formatBoolean(correctness?.finalStateMatchesReference), correctness?.finalStateMatchesReference ?? null),
            row('Final raw matches aggregate', formatBoolean(correctness?.finalRawMatchesAggregate), correctness?.finalRawMatchesAggregate ?? null),
            row('Final vote count', formatInteger(correctness?.finalVoteCount), null),
            row('Final candidate votes', formatInteger(correctness?.finalCandidateVotes), null),
          ]}
        />
      </ReportSection>
      <ReportSection
        title="Data · freshness"
        description="A successful snapshot must include every vote committed at or before response time minus the freshness limit."
        note="Cache age alone is not freshness. A quiet system is not given invented staleness."
      >
        <ReportTable
          rowHeaderLabel="Measurement"
          caption="Freshness counters"
          columns={[
            { key: 'value', label: 'Value' },
            { key: 'verdict', label: 'Verdict' },
          ]}
          rows={[
            row('Freshness verdict', freshness ? (freshness.valid ? 'Valid' : 'Invalid') : DASH, freshness ? freshness.valid : null),
            row('Limit', formatMillisecondsPrecise(freshness?.freshnessLimitMs), null),
            row('Successful reads', formatInteger(freshness?.successfulReads), null),
            row('Checked reads', formatInteger(freshness?.checkedReads), null),
            row('Stale reads', formatInteger(freshness?.staleReads), freshness ? freshness.staleReads === 0 : null),
            row('Maximum lag', formatMillisecondsPrecise(freshness?.maxLagMs), null),
            row('p95 lag', formatMillisecondsPrecise(freshness?.p95LagMs), null),
            row('Samples', formatInteger(freshness?.samples), null),
          ]}
        />
      </ReportSection>
    </>
  );
}

function row(
  label: string,
  value: string,
  verdict: boolean | null,
): {
  key: string;
  header: string;
  cells: [string, ReturnType<typeof verdictCell>];
} {
  return {
    key: label,
    header: label,
    cells: [value, verdictCell(verdict)],
  };
}

function CostReport({ evaluation }: { evaluation: ScoreboardEvaluation }) {
  const cost = evaluation.cost;
  if (cost === null) {
    return (
      <ReportSection title="Cost">
        <p className="scoreboard-results__note">
          Cost was not reported for this run. It is not treated as free.
        </p>
      </ReportSection>
    );
  }
  const ranked = evaluation.status === 'complete' && evaluation.passed;
  return (
    <ReportSection
      title="Cost"
      description="Actual rental for preparation, the measured run and drain, plus delivered response bytes."
      note="Hourly rent is reported separately. Preparation is paid time; there is no monthly extrapolation."
    >
      <ReportTable
        rowHeaderLabel="Charge"
        caption="Actual run cost"
        columns={[
          { key: 'value', label: 'Value' },
        ]}
        rows={[
          { key: 'hourly', header: 'Hourly rent', cells: [formatHourlyUsd(cost.hourlyUsd)] },
          { key: 'prep', header: 'Preparation', cells: [formatMillisecondsPrecise(cost.preparationMs)] },
          { key: 'measured', header: 'Measured run', cells: [formatMillisecondsPrecise(cost.measuredMs)] },
          { key: 'drain', header: 'Drain', cells: [formatMillisecondsPrecise(cost.drainMs)] },
          { key: 'billedms', header: 'Billed duration', cells: [formatMillisecondsPrecise(cost.billedMs)] },
          { key: 'rental', header: 'Rental charge', cells: [formatUsdPrecise(cost.rentalUsd)] },
          { key: 'bytes', header: 'Billed response bytes', cells: [formatDataSize(cost.billedBytes)] },
          { key: 'bytesusd', header: 'Billed bytes charge', cells: [formatUsdPrecise(cost.bytesUsd)] },
          { key: 'actual', header: 'Actual run cost', cells: [formatUsdPrecise(cost.actualUsd)] },
          { key: 'score', header: 'Cost score', cells: [ranked ? formatUsdPrecise(cost.scoreUsd) : 'Not ranked'] },
        ]}
      />
      <ReportTable
        rowHeaderLabel="Component"
        caption="Rental lines"
        minWidthPx={620}
        columns={[
          { key: 'hourly', label: 'Hourly' },
          { key: 'hours', label: 'Hours' },
          { key: 'usd', label: 'Charge' },
        ]}
        rows={cost.lines.map((line) => ({
          key: line.nodeId,
          header: `${line.nodeId} · ${line.kind}`,
          cells: [
            formatHourlyUsd(line.hourlyUsd),
            formatDecimal(line.hours, 6),
            formatUsdPrecise(line.usd),
          ],
        }))}
      />
    </ReportSection>
  );
}

function DiagnosticsReport({
  evaluation,
  onFocusNode,
  onFocusEdge,
}: {
  evaluation: ScoreboardEvaluation;
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  const issues = uniqueScoreboardIssues(evaluation.issues);
  return (
    <ReportSection
      title="Diagnostics"
      description="Engine issues and incomplete reasons only. The report does not invent a cause."
    >
      {issues.length === 0 ? (
        <p className="scoreboard-results__note">
          No engine issues were reported for this run.
        </p>
      ) : (
        <ul className="scoreboard-issues">
          {issues.map((issue, index) => (
            <li
              key={`${issue.code}-${index}`}
              className={`scoreboard-issues__item scoreboard-issues__item--${issue.severity}`}
            >
              <p>{issue.message}</p>
              <div className="scoreboard-issues__actions">
                {issue.nodeId ? (
                  <button
                    type="button"
                    onClick={() => onFocusNode(issue.nodeId!)}
                  >
                    Focus component
                  </button>
                ) : null}
                {issue.edgeId ? (
                  <button
                    type="button"
                    onClick={() => onFocusEdge(issue.edgeId!)}
                  >
                    Focus connection
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {evaluation.incompleteReasons.length > 0 ? (
        <>
          <h4 className="scoreboard-results__subhead">Incomplete reasons</h4>
          <ul className="scoreboard-results__list">
            {evaluation.incompleteReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </>
      ) : null}
    </ReportSection>
  );
}

function ResultSummary({ evaluation }: { evaluation: ScoreboardEvaluation }) {
  const ranked = evaluation.status === 'complete' && evaluation.passed;
  const status =
    evaluation.status === 'invalid'
      ? 'Run blocked by validation'
      : evaluation.status === 'incomplete'
        ? 'Incomplete — not ranked'
        : evaluation.passed
          ? 'Passed — ranked by actual cost'
          : 'Not passed — not ranked';
  return (
    <header className="scoreboard-summary">
      <div className="scoreboard-summary__verdict">
        <strong>{status}</strong>
        <span>
          {ranked && evaluation.cost
            ? `Actual ${formatUsdPrecise(evaluation.cost.actualUsd)}`
            : 'Cost score is shown only for a complete passing run'}
        </span>
      </div>
      <dl className="scoreboard-summary__facts">
        <div>
          <dt>Seed</dt>
          <dd>{formatInteger(evaluation.seed)}</dd>
        </div>
        <div>
          <dt>Graph digest</dt>
          <dd>{evaluation.graphDigest}</dd>
        </div>
        <div>
          <dt>Model / content</dt>
          <dd>
            {evaluation.modelVersion} / {evaluation.contentVersion}
          </dd>
        </div>
        <div>
          <dt>Pricing</dt>
          <dd>{evaluation.pricingVersion}</dd>
        </div>
        {evaluation.window ? (
          <div>
            <dt>Measured / drain</dt>
            <dd>
              {formatMillisecondsPrecise(
                evaluation.window.measuredEndMs -
                  evaluation.window.measuredStartMs,
              )}{' '}
              / {formatMillisecondsPrecise(evaluation.window.drainMs)}
            </dd>
          </div>
        ) : null}
      </dl>
    </header>
  );
}

function ResultContent({
  evaluation,
  onFocusNode,
  onFocusEdge,
}: {
  evaluation: ScoreboardEvaluation;
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  const selection = useScoreboardStore((state) => state.selection);
  const [selectedOperation, setSelectedOperation] =
    useState<ScoreboardOperation>('read');
  const selectedNodeId =
    selection?.type === 'node' ? selection.id : null;

  return (
    <div className="scoreboard-results">
      <ResultSummary evaluation={evaluation} />
      {evaluation.status === 'invalid' ? (
        <div className="scoreboard-results__banner scoreboard-results__banner--danger">
          The graph failed preflight. Fix the named validation issues; this run
          is not scored.
        </div>
      ) : null}
      {evaluation.status === 'incomplete' ? (
        <div className="scoreboard-results__banner scoreboard-results__banner--warning">
          The run did not finish. Partial measurements are shown, but an
          incomplete run is never a pass or a ranked cost score.
        </div>
      ) : null}
      {evaluation.series.length > 0 ? (
        <ChartGrid
          evaluation={evaluation}
          selectedOperation={selectedOperation}
          onSelectOperation={setSelectedOperation}
          selectedNodeId={selectedNodeId}
        />
      ) : (
        <p className="scoreboard-results__note">
          The engine did not return a telemetry series for this result, so no
          charts are fabricated.
        </p>
      )}
      <RequirementsReport evaluation={evaluation} />
      <OperationsReport evaluation={evaluation} />
      <ComponentsReport evaluation={evaluation} />
      <LinksReport evaluation={evaluation} />
      <DataReport evaluation={evaluation} />
      <CostReport evaluation={evaluation} />
      <DiagnosticsReport
        evaluation={evaluation}
        onFocusNode={onFocusNode}
        onFocusEdge={onFocusEdge}
      />
    </div>
  );
}

export function ScoreboardResultsPanel({
  onFocusNode,
  onFocusEdge,
}: {
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  const graph = useScoreboardStore((state) => state.graph);
  const seed = useScoreboardStore((state) => state.seed);
  const result = useScoreboardStore((state) => state.result);
  const resultDigest = useScoreboardStore((state) => state.resultDigest);
  const resultSeed = useScoreboardStore((state) => state.resultSeed);
  const runPhase = useScoreboardStore((state) => state.runPhase);
  const progress = useScoreboardStore((state) => state.progress);
  const runError = useScoreboardStore((state) => state.runError);

  const stale = scoreboardResultStale(
    result,
    resultDigest,
    resultSeed,
    graph,
    seed,
  );

  if (runError) {
    return (
      <div className="scoreboard-results">
        <div className="scoreboard-results__banner scoreboard-results__banner--danger">
          <strong>Run failed</strong>
          <p>{runError}</p>
        </div>
      </div>
    );
  }

  if (runPhase === 'running' || runPhase === 'stopping') {
    return (
      <div className="scoreboard-results">
        <ProgressBlock
          phase={progress?.phase ?? 'validate'}
          message={
            runPhase === 'stopping'
              ? 'Stopping — waiting for an incomplete result or clearing the run.'
              : (progress?.message ?? 'Preparing the evaluation…')
          }
          completed={progress?.completedRequests ?? 0}
          total={progress?.totalRequests ?? 1}
        />
      </div>
    );
  }

  if (!result) {
    return (
      <div className="scoreboard-results">
        <p className="scoreboard-results__note">
          No run yet. Add the components you need, connect them, then Run
          evaluation. The report appears here after the real worker finishes.
        </p>
      </div>
    );
  }

  if (stale) {
    return (
      <div className="scoreboard-results">
        <div className="scoreboard-results__banner scoreboard-results__banner--warning">
          <strong>Previous result</strong>
          <p>
            The semantic graph or seed changed. Old telemetry and measured
            pressure are hidden until you run again. Moving a node does not
            invalidate a result.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ResultContent
      evaluation={result}
      onFocusNode={onFocusNode}
      onFocusEdge={onFocusEdge}
    />
  );
}
