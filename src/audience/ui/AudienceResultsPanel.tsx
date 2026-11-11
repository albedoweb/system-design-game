import { useMemo, useState } from 'react';

import {
  AUDIENCE_OPERATION_LABELS,
  AUDIENCE_LEVEL,
  AUDIENCE_TOP_N,
  type AudienceCaseResult,
  type AudienceEvaluation,
  type AudienceOperation,
} from '../index';
import { DASH, formatDecimal, formatInteger } from '../../ui/format';
import {
  CHART_METRIC_COLORS,
  MetricChart,
  ReportSection,
  ReportTable,
  RequirementTable,
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
} from '../../features/game-ui';
import {
  audienceResultStale,
  uniqueAudienceIssues,
} from './audience-diagnostics';
import {
  AUDIENCE_NODE_KIND_LABELS,
  audienceCaseLabel,
  audienceCaseShortLabel,
  audienceCriticalWindow,
  audienceLinkLabel,
  audienceQueueCapacity,
  audienceWindowText,
} from './audience-meta';
import {
  audienceSelectedCase,
  useAudienceStore,
} from './audience-store';
import './audience.css';

function ProgressBlock({
  phase,
  message,
  completed,
  total,
  caseLabel,
}: {
  phase: string;
  message: string;
  completed: number;
  total: number;
  caseLabel: string | null;
}) {
  const percent =
    total > 0 ? Math.max(0, Math.min(100, (completed / total) * 100)) : 0;
  return (
    <div className="audience-progress">
      <div
        className="audience-progress__track"
        role="progressbar"
        aria-label={`Evaluation ${phase}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <p>
        <strong>{phase}</strong>
        {caseLabel ? ` · ${caseLabel}` : ''} · {message}
      </p>
      <p className="audience-results__note">
        {formatInteger(completed)} of {formatInteger(total)} scheduled requests
        processed. Charts and the full report appear only when the run finishes;
        the canvas shows measured traffic frames as they arrive.
      </p>
    </div>
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

function ResultSummary({ evaluation }: { evaluation: AudienceEvaluation }) {
  const status =
    evaluation.status === 'invalid'
      ? 'Run blocked by validation'
      : evaluation.status === 'cancelled'
        ? 'Cancelled — not ranked'
        : evaluation.status === 'incomplete'
          ? 'Incomplete — not ranked'
          : evaluation.passed
            ? 'Qualified — every required case passed'
            : 'Not qualified — not ranked';
  const provisioned = evaluation.provisioned;
  return (
    <header className="audience-summary">
      <div className="audience-summary__verdict">
        <strong>{status}</strong>
        <span>
          {evaluation.score.eligible && evaluation.score.costUsd !== null
            ? `Peak-case actual ${formatUsdPrecise(evaluation.score.costUsd)}`
            : 'Cost score is shown only when every required case passes'}
        </span>
      </div>
      <dl className="audience-summary__facts">
        <div>
          <dt>Seed</dt>
          <dd>{formatInteger(evaluation.seed)}</dd>
        </div>
        <div>
          <dt>Graph digest</dt>
          <dd>{evaluation.graphDigest}</dd>
        </div>
        <div>
          <dt>Cases</dt>
          <dd>
            {evaluation.cases.filter((item) => item.passed).length}/
            {evaluation.cases.length} passed
          </dd>
        </div>
        <div>
          <dt>Model / content</dt>
          <dd>
            {evaluation.modelVersion} / {evaluation.contentVersion}
          </dd>
        </div>
        <div>
          <dt>Profile / pricing</dt>
          <dd>
            {evaluation.profileVersion} · {evaluation.pricingVersion}
          </dd>
        </div>
        {provisioned ? (
          <div>
            <dt>Provisioned</dt>
            <dd>
              App {provisioned.appInstances} · SQL {provisioned.sqlSize}/
              {provisioned.readPlan}
              {provisioned.cacheTtlSeconds === null
                ? ''
                : ` · Cache ${provisioned.cacheTtlSeconds} s`}
              {provisioned.workerInstances > 0
                ? ` · Worker ${provisioned.workerInstances}`
                : ''}
              {provisioned.loadBalancer ? ' · LB' : ' · direct'}
            </dd>
          </div>
        ) : null}
      </dl>
    </header>
  );
}

function CaseOverview({
  evaluation,
}: {
  evaluation: AudienceEvaluation;
}) {
  const selectedCaseId = useAudienceStore((state) => state.selectedCaseId);
  const selectCase = useAudienceStore((state) => state.selectCase);
  return (
    <ReportSection
      title="Cases"
      description="The qualification passes only when normal, peak and every Application failure case pass. The selector changes the charts and the detailed report; it is not a label alone."
      note="Cost is visible per case. The score uses only the peak case, and only for a complete passing run."
    >
      <div className="audience-case-tabs" role="tablist" aria-label="Qualification case">
        {evaluation.cases.map((item) => {
          const verdict =
            item.status === 'cancelled'
              ? 'cancelled'
              : item.passed
                ? 'pass'
                : 'fail';
          return (
            <button
              type="button"
              role="tab"
              key={item.id}
              aria-selected={item.id === selectedCaseId}
              aria-label={`${audienceCaseLabel(item.id)} · ${verdict}`}
              className={item.id === selectedCaseId ? 'is-active' : ''}
              onClick={() => selectCase(item.id)}
            >
              <span>{audienceCaseShortLabel(item.id)}</span>
              <small className={item.passed ? 'is-pass' : 'is-fail'}>
                {verdict}
              </small>
            </button>
          );
        })}
      </div>
      <ReportTable
        rowHeaderLabel="Case"
        caption="Required cases"
        minWidthPx={760}
        columns={[
          { key: 'kind', label: 'Kind' },
          { key: 'target', label: 'Target slot' },
          { key: 'status', label: 'Status' },
          { key: 'result', label: 'Result' },
          { key: 'cost', label: 'Actual cost' },
        ]}
        rows={evaluation.cases.map((item) => ({
          key: item.id,
          header: audienceCaseLabel(item.id),
          cells: [
            item.kind,
            item.targetInstance === null
              ? DASH
              : formatInteger(item.targetInstance),
            item.status,
            verdictCell(item.passed),
            item.cost === null ? DASH : formatUsdPrecise(item.cost.actualUsd),
          ],
        }))}
      />
    </ReportSection>
  );
}

function SelectedComponent({
  evaluation,
  caseResult,
  nodeId,
}: {
  evaluation: AudienceEvaluation;
  caseResult: AudienceCaseResult;
  nodeId: string | null;
}) {
  const node = nodeId
    ? caseResult.nodes.find((item) => item.nodeId === nodeId)
    : undefined;
  return (
    <div className="audience-selected" role="status" aria-live="polite">
      <strong>Selected component</strong>
      {node ? (
        <span>
          {node.label} · CPU avg{' '}
          {formatPercentExact(node.cpu.utilizationAverage)} / peak{' '}
          {formatPercentExact(node.cpu.utilizationPeak)} · queue avg{' '}
          {formatDecimal(node.queue.waitingAverage, 1)} / peak{' '}
          {formatInteger(node.queue.waitingPeak)}
          {audienceQueueCapacity(node.kind) !== null
            ? ` of ${formatInteger(audienceQueueCapacity(node.kind)!)}`
            : ''}{' '}
          · {node.health.healthyInstances}/{node.health.totalInstances} healthy
        </span>
      ) : (
        <span>
          Select a component on the canvas to filter Queue and Resources. Traffic
          and latency follow the selected operation. This is case{' '}
          {audienceCaseLabel(caseResult.id)} of seed {formatInteger(evaluation.seed)}.
        </span>
      )}
    </div>
  );
}

function ChartGrid({
  evaluation,
  caseResult,
  selectedOperation,
  onSelectOperation,
  selectedNodeId,
}: {
  evaluation: AudienceEvaluation;
  caseResult: AudienceCaseResult;
  selectedOperation: AudienceOperation;
  onSelectOperation: (operation: AudienceOperation) => void;
  selectedNodeId: string | null;
}) {
  const cursorMs = useAudienceStore((state) => state.viewTimeMs);
  const setViewTime = useAudienceStore((state) => state.setViewTime);
  const replayMode = useAudienceStore((state) => state.replayMode);

  const points = caseResult.series;
  const timesMs = points.map((point) => point.timeMs);
  const durationMs = Math.max(
    1,
    caseResult.window.measuredEndMs - caseResult.window.measuredStartMs,
  );
  const critical = audienceCriticalWindow(caseResult.id);

  const trafficOperations = useMemo(
    () =>
      (['ingest', 'read'] as const).map((operation) => ({
        id: operation,
        label: AUDIENCE_OPERATION_LABELS[operation],
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
            label: 'Failed',
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
      (['ingest', 'read'] as const).map((operation) => ({
        id: operation,
        label: AUDIENCE_OPERATION_LABELS[operation],
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
        label: 'Sampled waiting',
        color: CHART_METRIC_COLORS.queue,
        values: nodeSamples.map((node) => node?.queueWaiting ?? null),
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

  const handleCursor = (timeMs: number | null) => {
    setViewTime(timeMs);
  };

  return (
    <section className="audience-charts" aria-label="Case telemetry charts">
      <div className="audience-charts__head">
        <h3>Telemetry · {audienceCaseLabel(caseResult.id)}</h3>
        <p>
          Hover or use the keyboard on a chart to inspect one time in this case;
          hovering seeks the recorded canvas frames for the same case. The
          shaded band is the {critical ? audienceWindowText(critical) : 'whole case'} critical cohort.
          Recorded replay is {replayMode === 'playing' ? 'playing' : 'paused or summary'}.
        </p>
      </div>
      <SelectedComponent
        evaluation={evaluation}
        caseResult={caseResult}
        nodeId={selectedNodeId}
      />
      <div className="game-charts">
        <MetricChart
          kind="traffic"
          operations={trafficOperations}
          selectedOperationId={selectedOperation}
          onOperationChange={(id) =>
            onSelectOperation(id === 'ingest' ? 'ingest' : 'read')
          }
          timesMs={timesMs}
          durationMs={durationMs}
          criticalFromMs={critical?.fromMs}
          criticalToMs={critical?.toMs}
          criticalLabel={critical ? 'critical cohort' : undefined}
          unit="requests/s"
          valueDigits={1}
          valueFormatter={(value) => `${formatDecimal(value, 1)}/s`}
          cursorMs={cursorMs}
          onCursorChange={handleCursor}
          emptyLabel="No traffic series in this case."
        />
        <MetricChart
          kind="latency"
          operations={latencyOperations}
          selectedOperationId={selectedOperation}
          onOperationChange={(id) =>
            onSelectOperation(id === 'ingest' ? 'ingest' : 'read')
          }
          timesMs={timesMs}
          durationMs={durationMs}
          criticalFromMs={critical?.fromMs}
          criticalToMs={critical?.toMs}
          criticalLabel={critical ? 'critical cohort' : undefined}
          slo={{
            value: AUDIENCE_LEVEL.slo.successfulP95Ms,
            label: 'p95 SLO',
          }}
          unit="ms"
          valueFormatter={(value) => formatMillisecondsPrecise(value)}
          cursorMs={cursorMs}
          onCursorChange={handleCursor}
          emptyLabel="No successful-response percentiles in this case."
        />
        <MetricChart
          kind="queue"
          title="Queue · selected component (sampled)"
          series={selectedNodeId === null ? [] : queueSeries}
          timesMs={timesMs}
          durationMs={durationMs}
          criticalFromMs={critical?.fromMs}
          criticalToMs={critical?.toMs}
          criticalLabel={critical ? 'critical cohort' : undefined}
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
          criticalFromMs={critical?.fromMs}
          criticalToMs={critical?.toMs}
          criticalLabel={critical ? 'critical cohort' : undefined}
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
          criticalFromMs={critical?.fromMs}
          criticalToMs={critical?.toMs}
          criticalLabel={critical ? 'critical cohort' : undefined}
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
          criticalFromMs={critical?.fromMs}
          criticalToMs={critical?.toMs}
          criticalLabel={critical ? 'critical cohort' : undefined}
          unit="Gbit/s"
          valueDigits={2}
          valueFormatter={(value) => formatGbit(value)}
          cursorMs={cursorMs}
          onCursorChange={handleCursor}
          emptyLabel="Select a component to see network."
        />
      </div>
      <p className="audience-results__note">
        Engine series are one-second totals; rates divide by each interval’s
        actual window. Null samples stay unknown. Queue depth is an instant
        sample in this chart; the Components table reports the time-weighted
        case average and the observed peak separately. A 100% CPU peak is not
        an error by itself.
      </p>
    </section>
  );
}

function RequirementsReport({ caseResult }: { caseResult: AudienceCaseResult }) {
  return (
    <ReportSection
      title="Requirements"
      description="Gates for this case: the whole case and, where defined, the critical offer cohort."
      note="Checks without data do not pass. Sample counts cover successful responses. A failed gate is the thing to fix; the report does not pick a cause."
    >
      <RequirementTable
        nameLabel="Check"
        caption={`${audienceCaseLabel(caseResult.id)} requirements`}
        columnLabels={{ limit: 'Target' }}
        columns={['actual', 'limit', 'requirement', 'result']}
        rows={caseResult.gates.map((gate) => ({
          key: gate.id,
          label: gate.label,
          detail: `${gate.message} · ${
            gate.operation
              ? AUDIENCE_OPERATION_LABELS[gate.operation]
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
          <p className="audience-results__note">
            No requirement rows were reported for this case.
          </p>
        }
      />
    </ReportSection>
  );
}

function OperationsReport({ caseResult }: { caseResult: AudienceCaseResult }) {
  if (caseResult.operations === null) {
    return (
      <ReportSection title="Operations">
        <p className="audience-results__note">
          Operations were not measured for this case. Unknown is not a pass.
        </p>
      </ReportSection>
    );
  }
  const cohorts = caseResult.operations.critical
    ? (['whole', 'critical'] as const)
    : (['whole'] as const);
  const rows = cohorts.flatMap((cohort) =>
    (['ingest', 'read'] as const).map((operation) => {
      const metrics =
        cohort === 'whole'
          ? caseResult.operations![operation]
          : caseResult.operations!.critical![operation];
      return {
        key: `${cohort}-${operation}`,
        header: `${AUDIENCE_OPERATION_LABELS[operation]} · ${
          cohort === 'whole'
            ? 'whole case'
            : `critical ${audienceCriticalWindow(caseResult.id)
                ? audienceWindowText(audienceCriticalWindow(caseResult.id)!)
                : ''}`
        }`,
        cells: [
          formatInteger(metrics.offered),
          formatAvailability(metrics.availability),
          formatInteger(metrics.succeeded),
          formatInteger(metrics.failed),
          formatInteger(metrics.rejected),
          formatInteger(metrics.timedOut),
          formatInteger(metrics.errored),
          formatInteger(metrics.unknownOutcome),
          formatInteger(metrics.pending),
          formatInteger(metrics.attempts),
          formatInteger(metrics.retries),
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
      description="Offered logical requests, physical attempts and the successful-response percentiles for this case."
      note="Availability counts every offered request, including rejections, timeouts and unknown outcomes. Percentiles cover successful responses only."
    >
      <ReportTable
        rowHeaderLabel="Operation"
        caption="Measured requests"
        minWidthPx={1480}
        columns={[
          { key: 'offered', label: 'Offered' },
          { key: 'availability', label: 'Available' },
          { key: 'succeeded', label: 'Succeeded' },
          { key: 'failed', label: 'Failed' },
          { key: 'rejected', label: 'Rejected' },
          { key: 'timedout', label: 'Timed out' },
          { key: 'errored', label: 'Errored' },
          { key: 'unknown', label: 'Unknown outcome' },
          { key: 'pending', label: 'Pending' },
          { key: 'attempts', label: 'Attempts' },
          { key: 'retries', label: 'Retries' },
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

function ComponentsReport({ caseResult }: { caseResult: AudienceCaseResult }) {
  return (
    <ReportSection
      title="Components"
      description="Case averages and peaks are separate. Instance counts and health are the observed physical slots, not a guessed limit."
      note="RAM average is a sampled average of once-per-second instantaneous readings, not an exact residence integral. A high sample is evidence of local pressure; only an engine issue or a failed requirement makes it a cause."
    >
      <ReportTable
        rowHeaderLabel="Component"
        caption="Measured resource use"
        minWidthPx={1700}
        columns={[
          { key: 'instances', label: 'Instances / healthy' },
          { key: 'cpua', label: 'CPU avg' },
          { key: 'cpup', label: 'CPU peak' },
          { key: 'rama', label: 'RAM sampled avg' },
          { key: 'ramp', label: 'RAM peak / cap' },
          { key: 'qa', label: 'Queue avg' },
          { key: 'qp', label: 'Queue peak' },
          { key: 'wait', label: 'Wait avg / max' },
          { key: 'neta', label: 'Net avg' },
          { key: 'netp', label: 'Net peak / cap' },
          { key: 'tasks', label: 'Tasks' },
        ]}
        rows={caseResult.nodes.map((node) => {
          if (node.kind === 'users') {
            return {
              key: node.nodeId,
              header: `${node.label} · ${AUDIENCE_NODE_KIND_LABELS[node.kind]}`,
              cells: [
                'Fixed source',
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
          const cap = audienceQueueCapacity(node.kind);
          return {
            key: node.nodeId,
            header: `${node.label} · ${AUDIENCE_NODE_KIND_LABELS[node.kind]}`,
            cells: [
              `${formatInteger(node.health.healthyInstances)}/${formatInteger(
                node.health.totalInstances,
              )} · ${node.health.state}`,
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
          <p className="audience-results__note">
            No component metrics were reported for this case.
          </p>
        }
      />
      {caseResult.nodes.some((node) => node.instances.length > 1) ? (
        <ReportTable
          rowHeaderLabel="Physical slot"
          caption="Per-instance health at the end of this case"
          minWidthPx={520}
          columns={[
            { key: 'component', label: 'Component' },
            { key: 'health', label: 'State' },
          ]}
          rows={caseResult.nodes.flatMap((node) =>
            node.instances.map((instance) => ({
              key: `${node.nodeId}-${instance.instanceIndex}`,
              header: `${node.label} · slot ${instance.instanceIndex}`,
              cells: [
                instance.kind,
                instance.health,
              ],
            })),
          )}
        />
      ) : null}
    </ReportSection>
  );
}

function LinksReport({ caseResult }: { caseResult: AudienceCaseResult }) {
  const labelOf = (id: string) =>
    caseResult.nodes.find((node) => node.nodeId === id)?.label ?? id;
  return (
    <ReportSection
      title="Connections"
      description="Traffic and bytes attributed to each dependency, including the Worker → SQL jobs path."
    >
      <ReportTable
        rowHeaderLabel="Connection"
        caption="Measured link use"
        minWidthPx={1200}
        columns={[
          { key: 'role', label: 'Role' },
          { key: 'ingest', label: 'Ingest' },
          { key: 'read', label: 'Reads' },
          { key: 'projection', label: 'Jobs' },
          { key: 'total', label: 'Total' },
          { key: 'bo', label: 'Bytes offered' },
          { key: 'bd', label: 'Bytes delivered' },
          { key: 'peakreq', label: 'Peak req/s' },
          { key: 'peakbytes', label: 'Peak bytes' },
        ]}
        rows={caseResult.links.map((link) => ({
          key: link.edgeId,
          header: `${labelOf(link.from)} → ${labelOf(link.to)}`,
          cells: [
            audienceLinkLabel(link.role),
            formatInteger(link.requests.ingest),
            formatInteger(link.requests.read),
            formatInteger(link.requests.projection),
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
          <p className="audience-results__note">
            No connection metrics were reported for this case.
          </p>
        }
      />
    </ReportSection>
  );
}

function TargetReport({ caseResult }: { caseResult: AudienceCaseResult }) {
  if (caseResult.target === null) {
    return (
      <ReportSection
        title="Fault target"
        description="No Application failure is injected in this case."
      >
        <p className="audience-results__note">
          Normal and peak traffic use the whole Application pool without a
          scheduled crash.
        </p>
      </ReportSection>
    );
  }
  const target = caseResult.target;
  const observed = (value: number | null) =>
    value === null ? 'not observed' : formatMillisecondsPrecise(value);
  return (
    <ReportSection
      title="Fault target"
      description={`${audienceCaseLabel(caseResult.id)} targets ${target.nodeId}, physical Application slot ${target.instanceIndex}.`}
      note="Crash, detection, restart and readiness are separate observations. A direct path has no Load Balancer health state, so a missing detection is shown as not observed instead of being invented."
    >
      <dl className="audience-facts">
        <div>
          <dt>Crash</dt>
          <dd>{observed(target.crashAtMs)}</dd>
        </div>
        <div>
          <dt>Unavailable until</dt>
          <dd>{observed(target.downUntilMs)}</dd>
        </div>
        <div>
          <dt>Detected unhealthy</dt>
          <dd>{observed(target.detectedUnhealthyAtMs)}</dd>
        </div>
        <div>
          <dt>Ready</dt>
          <dd>{observed(target.readyAtMs)}</dd>
        </div>
        <div>
          <dt>Route restored</dt>
          <dd>{observed(target.routeRestoredAtMs)}</dd>
        </div>
        <div>
          <dt>Recovered</dt>
          <dd>{observed(target.recoveredAtMs)}</dd>
        </div>
        <div>
          <dt>Healthy at end</dt>
          <dd>{formatBoolean(target.healthyAtEnd)}</dd>
        </div>
        <div>
          <dt>Restarts</dt>
          <dd>{formatInteger(target.restartCount)}</dd>
        </div>
      </dl>
      <p className="audience-results__note">
        The canvas marks this slot and shows the actual measured frames at the
        selected time; no lifecycle timestamp is derived from a frame count.
      </p>
    </ReportSection>
  );
}

const INCIDENT_LABELS: Readonly<Record<string, string>> = {
  crash: 'Crash',
  'health-check-failed': 'Health probe failed',
  'marked-unhealthy': 'Marked unhealthy',
  restart: 'Process restart',
  booting: 'Booting',
  ready: 'Ready',
  'route-change': 'Route change',
  retry: 'Retry',
  deadline: 'Deadline',
  commit: 'Durable commit',
};

function IncidentReport({ caseResult }: { caseResult: AudienceCaseResult }) {
  return (
    <ReportSection
      title="Failure timeline"
      description="Ordered engine events for this case. Crash, detection, restart and ready stay separate markers."
      note="An empty timeline is shown as empty, never filled with a guessed milestone."
    >
      {caseResult.incidentTimeline.length === 0 ? (
        <p className="audience-results__note">
          No incident events were reported for this case.
        </p>
      ) : (
        <>
          <ul className="audience-markers" aria-label="Incident markers">
            {caseResult.incidentTimeline.map((event, index) => (
              <li
                key={`${event.atMs}-${event.kind}-${index}`}
                className={`audience-marker audience-marker--${event.kind}`}
                data-audience-marker={event.kind}
                title={event.message}
              >
                <strong>{INCIDENT_LABELS[event.kind] ?? event.kind}</strong>
                <span>
                  {formatMillisecondsPrecise(event.atMs)}
                  {event.instanceIndex === null
                    ? ''
                    : ` · slot ${event.instanceIndex}`}
                </span>
              </li>
            ))}
          </ul>
          <ReportTable
            rowHeaderLabel="Event"
            caption="Incident events"
            minWidthPx={760}
            columns={[
              { key: 'at', label: 'Time' },
              { key: 'node', label: 'Node' },
              { key: 'slot', label: 'Slot' },
              { key: 'message', label: 'Detail' },
            ]}
            rows={caseResult.incidentTimeline.map((event, index) => ({
              key: `${event.atMs}-${event.kind}-${index}`,
              header: INCIDENT_LABELS[event.kind] ?? event.kind,
              cells: [
                formatMillisecondsPrecise(event.atMs),
                event.nodeId,
                event.instanceIndex === null
                  ? DASH
                  : formatInteger(event.instanceIndex),
                event.message,
              ],
            }))}
          />
        </>
      )}
    </ReportSection>
  );
}

function DataReport({ caseResult }: { caseResult: AudienceCaseResult }) {
  const correctness = caseResult.correctness;
  const freshness = caseResult.freshness;
  const snapshot = caseResult.finalSnapshot;
  const lag = correctness?.projectionLag ?? null;
  return (
    <>
      <ReportSection
        title="Data · correctness"
        description="Ingest durability, exact distinct/expiry references and the published projection prefix for this case."
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
            row(
              'Correctness verdict',
              correctness ? (correctness.valid ? 'Valid' : 'Invalid') : DASH,
              correctness ? correctness.valid : null,
            ),
            row('Ingest offered', formatInteger(correctness?.ingestOffered), null),
            row('Ingest committed', formatInteger(correctness?.ingestCommitted), null),
            row(
              'Ingest acknowledged',
              formatInteger(correctness?.ingestAcknowledged),
              null,
            ),
            row('Ingest pending', formatInteger(correctness?.ingestPending), null),
            row(
              'Committed but unacknowledged',
              formatInteger(correctness?.committedUnacknowledged),
              null,
            ),
            row(
              'Duplicate logical events',
              formatInteger(correctness?.duplicateLogicalEvents),
              correctness ? correctness.duplicateLogicalEvents === 0 : null,
            ),
            row(
              'Lost acknowledged events',
              formatInteger(correctness?.lostAcknowledgedEvents),
              correctness ? correctness.lostAcknowledgedEvents === 0 : null,
            ),
            row(
              'Idempotent replays',
              formatInteger(correctness?.idempotentReplays),
              null,
            ),
            row(
              'Payload conflicts',
              formatInteger(correctness?.payloadConflicts),
              null,
            ),
            row(
              'Unknown commit outcomes (logical requests)',
              formatInteger(correctness?.unknownCommitOutcomes),
              null,
            ),
            row(
              'Resolved by same-id retry (logical)',
              formatInteger(correctness?.resolvedUnknownCommitOutcomes),
              null,
            ),
            row(
              'Committed during Application crash',
              formatInteger(correctness?.commitsSurvivedAppCrash),
              null,
            ),
            row(
              'Commit sequence high water',
              formatInteger(correctness?.commitSequenceHighWater),
              null,
            ),
            row(
              'Checked snapshots',
              formatInteger(correctness?.checkedSnapshots),
              null,
            ),
            row(
              'Snapshot mismatches',
              formatInteger(correctness?.snapshotMismatches),
              correctness ? correctness.snapshotMismatches === 0 : null,
            ),
            row('Checked expiry', formatInteger(correctness?.checkedExpiry), null),
            row(
              'Expected expiry work',
              formatInteger(correctness?.expectedExpiries),
              null,
            ),
            row(
              'Expiry mismatches',
              formatInteger(correctness?.expiryMismatches),
              correctness ? correctness.expiryMismatches === 0 : null,
            ),
            row(
              'Final ranking matches reference',
              formatBoolean(correctness?.finalRankingMatchesReference),
              correctness?.finalRankingMatchesReference ?? null,
            ),
            row(
              'Final active pairs',
              `${formatInteger(correctness?.finalActivePairs)} observed / ${formatInteger(
                correctness?.expectedActivePairs,
              )} expected`,
              null,
            ),
          ]}
        />
        {lag ? (
          <ReportTable
            rowHeaderLabel="Projection"
            caption="Published prefix and lag"
            columns={[
              { key: 'value', label: 'Value' },
            ]}
            rows={[
              {
                key: 'prefix',
                header: 'Published through sequence',
                cells: [formatInteger(lag.publishedThroughSequence)],
              },
              {
                key: 'highwater',
                header: 'Commit high water',
                cells: [formatInteger(correctness?.commitSequenceHighWater)],
              },
              {
                key: 'lagevents',
                header: 'Unpublished events',
                cells: [formatInteger(lag.lagEvents)],
              },
              {
                key: 'lagms',
                header: 'Lag',
                cells: [formatMillisecondsPrecise(lag.lagMs)],
              },
              {
                key: 'jobs',
                header: 'Unpublished jobs',
                cells: [formatInteger(lag.unpublishedJobs)],
              },
              {
                key: 'heartbeats',
                header: 'Heartbeat expiry passes',
                cells: [formatInteger(lag.heartbeatExpiries)],
              },
            ]}
          />
        ) : null}
      </ReportSection>
      <ReportSection
        title="Data · freshness"
        description="Every successful ranking is checked at delivery against its named snapshot and the exact open-left 15-minute window."
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
            row(
              'Freshness verdict',
              freshness ? (freshness.valid ? 'Valid' : 'Invalid') : DASH,
              freshness ? freshness.valid : null,
            ),
            row(
              'Limit',
              formatMillisecondsPrecise(freshness?.freshnessLimitMs),
              null,
            ),
            row(
              'Successful reads',
              formatInteger(freshness?.successfulReads),
              null,
            ),
            row('Checked reads', formatInteger(freshness?.checkedReads), null),
            row(
              'Stale reads',
              formatInteger(freshness?.staleReads),
              freshness ? freshness.staleReads === 0 : null,
            ),
            row(
              'Wrong-window reads',
              formatInteger(freshness?.wrongWindowReads),
              freshness ? freshness.wrongWindowReads === 0 : null,
            ),
            row('Maximum lag', formatMillisecondsPrecise(freshness?.maxLagMs), null),
            row('p95 lag', formatMillisecondsPrecise(freshness?.p95LagMs), null),
            row('Samples', formatInteger(freshness?.samples), null),
            row(
              'Final snapshot as-of',
              freshness?.latestSnapshot
                ? formatMillisecondsPrecise(freshness.latestSnapshot.asOfMs)
                : DASH,
              null,
            ),
            row(
              'Final snapshot cursor',
              freshness?.latestSnapshot
                ? formatInteger(freshness.latestSnapshot.throughCommitSequence)
                : DASH,
              null,
            ),
            row(
              'Final ranking snapshot',
              snapshot
                ? `${formatMillisecondsPrecise(
                    snapshot.asOfMs,
                  )} · cursor ${formatInteger(snapshot.throughCommitSequence)}`
                : DASH,
              null,
            ),
          ]}
        />
      </ReportSection>
    </>
  );
}

function CostReport({
  evaluation,
  caseResult,
}: {
  evaluation: AudienceEvaluation;
  caseResult: AudienceCaseResult;
}) {
  const cost = caseResult.cost;
  if (cost === null) {
    return (
      <ReportSection title="Cost">
        <p className="audience-results__note">
          Cost was not reported for this case. It is not treated as free.
        </p>
      </ReportSection>
    );
  }
  const score =
    evaluation.score.caseId === caseResult.id ? evaluation.score : null;
  return (
    <ReportSection
      title="Cost"
      description="Actual rental for preparation, the measured run and drain, plus delivered response bytes for this case."
      note={`Hourly rent is reported separately. Only the peak case is scored${
        score?.eligible
          ? `; this run is eligible and the peak actual cost is ${formatUsdPrecise(
              score.costUsd,
            )}`
          : '; this run is not eligible, so no score is shown'
      }. Fault-case costs are never summed into the score.`}
    >
      <ReportTable
        rowHeaderLabel="Charge"
        caption={`Actual cost · ${audienceCaseLabel(caseResult.id)}`}
        columns={[{ key: 'value', label: 'Value' }]}
        rows={[
          { key: 'hourly', header: 'Hourly rent', cells: [formatHourlyUsd(cost.hourlyUsd)] },
          { key: 'prep', header: 'Preparation', cells: [formatMillisecondsPrecise(cost.preparationMs)] },
          { key: 'measured', header: 'Measured run', cells: [formatMillisecondsPrecise(cost.measuredMs)] },
          { key: 'drain', header: 'Drain', cells: [formatMillisecondsPrecise(cost.drainMs)] },
          { key: 'billedms', header: 'Billed duration', cells: [formatMillisecondsPrecise(cost.billedMs)] },
          { key: 'rental', header: 'Rental charge', cells: [formatUsdPrecise(cost.rentalUsd)] },
          { key: 'bytes', header: 'Billed response bytes', cells: [formatDataSize(cost.billedBytes)] },
          { key: 'bytesusd', header: 'Billed bytes charge', cells: [formatUsdPrecise(cost.bytesUsd)] },
          { key: 'actual', header: 'Actual case cost', cells: [formatUsdPrecise(cost.actualUsd)] },
          {
            key: 'score',
            header: 'Peak-case score',
            cells: [
              score?.eligible
                ? formatUsdPrecise(score.costUsd)
                : caseResult.id === 'peak'
                  ? 'Not ranked'
                  : 'Peak case only',
            ],
          },
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
  caseResult,
  onFocusNode,
  onFocusEdge,
}: {
  evaluation: AudienceEvaluation;
  caseResult: AudienceCaseResult;
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  const issues = uniqueAudienceIssues(
    evaluation.issues.filter(
      (issue) => !issue.caseId || issue.caseId === caseResult.id,
    ),
  );
  return (
    <ReportSection
      title="Diagnostics"
      description="Engine issues, incomplete reasons and validation facts. The report does not invent a cause."
    >
      {issues.length === 0 ? (
        <p className="audience-results__note">
          No engine issues were reported for this case.
        </p>
      ) : (
        <ul className="audience-issues">
          {issues.map((issue, index) => (
            <li
              key={`${issue.code}-${index}`}
              className={`audience-issues__item audience-issues__item--${issue.severity}`}
            >
              <p>{issue.message}</p>
              <div className="audience-issues__actions">
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
          <h4 className="audience-results__subhead">Incomplete reasons</h4>
          <ul className="audience-results__list">
            {evaluation.incompleteReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </>
      ) : null}
    </ReportSection>
  );
}

function CaseResultContent({
  evaluation,
  caseResult,
  onFocusNode,
  onFocusEdge,
}: {
  evaluation: AudienceEvaluation;
  caseResult: AudienceCaseResult;
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  const selection = useAudienceStore((state) => state.selection);
  const [selectedOperation, setSelectedOperation] =
    useState<AudienceOperation>('read');
  const selectedNodeId = selection?.type === 'node' ? selection.id : null;

  return (
    <div className="audience-case-detail">
      <div className="audience-case-detail__head">
        <div>
          <p className="audience-results__eyebrow">Selected case</p>
          <h3>{audienceCaseLabel(caseResult.id)}</h3>
        </div>
        <span
          className={caseResult.passed ? 'is-pass' : 'is-fail'}
          data-audience-case-verdict={caseResult.passed ? 'pass' : 'fail'}
        >
          {caseResult.passed ? 'Passed' : 'Not passed'}
        </span>
      </div>
      {caseResult.status === 'cancelled' ? (
        <div className="audience-results__banner audience-results__banner--warning">
          This case was cancelled. Partial evidence is shown, but it is never a
          pass and never a ranked score.
        </div>
      ) : null}
      {caseResult.series.length > 0 ? (
        <ChartGrid
          evaluation={evaluation}
          caseResult={caseResult}
          selectedOperation={selectedOperation}
          onSelectOperation={setSelectedOperation}
          selectedNodeId={selectedNodeId}
        />
      ) : (
        <p className="audience-results__note">
          The engine did not return a telemetry series for this case, so no
          charts are fabricated.
        </p>
      )}
      <RequirementsReport caseResult={caseResult} />
      <OperationsReport caseResult={caseResult} />
      <ComponentsReport caseResult={caseResult} />
      <LinksReport caseResult={caseResult} />
      <TargetReport caseResult={caseResult} />
      <IncidentReport caseResult={caseResult} />
      <DataReport caseResult={caseResult} />
      <CostReport evaluation={evaluation} caseResult={caseResult} />
      <DiagnosticsReport
        evaluation={evaluation}
        caseResult={caseResult}
        onFocusNode={onFocusNode}
        onFocusEdge={onFocusEdge}
      />
    </div>
  );
}

function ResultContent({
  evaluation,
  onFocusNode,
  onFocusEdge,
}: {
  evaluation: AudienceEvaluation;
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  const selectedCaseId = useAudienceStore((state) => state.selectedCaseId);
  const selectedCase = audienceSelectedCase(evaluation, selectedCaseId);

  return (
    <div className="audience-results">
      <ResultSummary evaluation={evaluation} />
      {evaluation.status === 'invalid' ? (
        <div className="audience-results__banner audience-results__banner--danger">
          The graph failed preflight. Fix the named validation issues; this run
          is not scored.
        </div>
      ) : null}
      {evaluation.status === 'incomplete' ? (
        <div className="audience-results__banner audience-results__banner--warning">
          The run did not finish. Partial measurements are shown, but an
          incomplete run is never a pass or a ranked cost score.
        </div>
      ) : null}
      {evaluation.status === 'cancelled' ? (
        <div className="audience-results__banner audience-results__banner--warning">
          The run was cancelled. No partial case can pass or contribute a score.
        </div>
      ) : null}
      <CaseOverview evaluation={evaluation} />
      {selectedCase ? (
        <CaseResultContent
          evaluation={evaluation}
          caseResult={selectedCase}
          onFocusNode={onFocusNode}
          onFocusEdge={onFocusEdge}
        />
      ) : (
        <p className="audience-results__note">
          The result contains no case evidence. No charts, pass verdict or cost
          rank are invented.
        </p>
      )}
      <p className="audience-results__note">
        Only the fixed peak case actual cost can become the score, and only when
        normal, peak and every required Application failure case pass. This
        level does not include SQL, Cache, Worker, Load Balancer, zone or region
        failures, approximate distinct algorithms, multiple windows or an RTO
        gate.
      </p>
    </div>
  );
}

export function AudienceResultsPanel({
  onFocusNode,
  onFocusEdge,
}: {
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  const graph = useAudienceStore((state) => state.graph);
  const seed = useAudienceStore((state) => state.seed);
  const result = useAudienceStore((state) => state.result);
  const resultDigest = useAudienceStore((state) => state.resultDigest);
  const resultSeed = useAudienceStore((state) => state.resultSeed);
  const runPhase = useAudienceStore((state) => state.runPhase);
  const progress = useAudienceStore((state) => state.progress);
  const runError = useAudienceStore((state) => state.runError);

  const stale = audienceResultStale(
    result,
    resultDigest,
    resultSeed,
    graph,
    seed,
  );

  if (runError) {
    return (
      <div className="audience-results">
        <div className="audience-results__banner audience-results__banner--danger">
          <strong>Run failed</strong>
          <p>{runError}</p>
        </div>
      </div>
    );
  }

  if (runPhase === 'running' || runPhase === 'stopping') {
    return (
      <div className="audience-results">
        <ProgressBlock
          phase={progress?.phase ?? 'validate'}
          message={
            runPhase === 'stopping'
              ? 'Stopping — waiting for an incomplete/cancelled result or clearing the run.'
              : (progress?.message ?? 'Preparing the evaluation…')
          }
          completed={progress?.completedRequests ?? 0}
          total={progress?.totalRequests ?? 1}
          caseLabel={progress?.caseId ? audienceCaseLabel(progress.caseId) : null}
        />
        <p className="audience-results__note">
          One run evaluates normal, peak and every required Application failure
          case. The live canvas shows the measured frames of the case currently
          running; stopped or stale cases never animate as live.
        </p>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="audience-results">
        <p className="audience-results__note">
          No run yet. Add the components you need, connect them, then Run
          evaluation. The report and per-case charts appear here after the real
          worker finishes. Latest ranking target: top {AUDIENCE_TOP_N} of 100
          streams.
        </p>
      </div>
    );
  }

  if (stale) {
    return (
      <div className="audience-results">
        <div className="audience-results__banner audience-results__banner--warning">
          <strong>Previous result</strong>
          <p>
            The semantic graph or seed changed. Old telemetry, case evidence and
            recorded frames are hidden until you run again. Moving a node does
            not invalidate a result.
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
