import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { useMemo, type RefObject } from 'react';

import { PARCEL_LEVEL } from '../level';
import {
  PARCEL_BUSINESS_OPERATIONS,
  type ParcelCheck,
  type ParcelDiagnostic,
  type ParcelEvaluation,
  type ParcelHorizonResult,
  type ParcelIssue,
} from '../contracts';
import { formatInteger } from '../../ui/format';
import {
  ReportSection,
  ReportTable,
  RequirementTable,
  TelemetryPanel,
} from '../../features/game-ui';
import {
  formatCheckLimit,
  formatCheckValue,
  formatDataSize,
  formatFractionPercent,
  formatHorizon,
  formatMilliseconds,
  formatOperationName,
  formatSuccessfulMilliseconds,
  formatTerabytes,
  operationPassLabel,
} from './parcel-format';
import {
  parcelRouteTarget,
  parcelResultStale,
  uniqueParcelIssues,
} from './parcel-diagnostics';
import { useParcelStore } from './parcel-store';

function ProgressBar({
  completed,
  total,
  label,
}: {
  completed: number;
  total: number;
  label: string;
}) {
  const percent =
    total > 0 ? Math.max(0, Math.min(100, (completed / total) * 100)) : 0;
  return (
    <div className="parcel-progress">
      <div
        className="parcel-progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <p>
        {label} · {Math.round(percent)}%
      </p>
    </div>
  );
}

function FocusButton({
  label,
  onFocus,
}: {
  label: string;
  onFocus: () => void;
}) {
  return (
    <button type="button" className="game-focus" onClick={onFocus}>
      {label}
    </button>
  );
}

function CheckTable({
  checks,
  onFocusNode,
}: {
  checks: readonly ParcelCheck[];
  onFocusNode: (id: string) => void;
}) {
  const graph = useParcelStore((state) => state.graph);
  return (
    <RequirementTable
      nameLabel="Check"
      caption="Checks for this horizon"
      columns={['actual', 'limit', 'requirement', 'result', 'focus']}
      empty={<p className="parcel-results__note">No checks were reported.</p>}
      rows={checks.map((check) => {
        const routeTarget = check.operation
          ? parcelRouteTarget(graph, check.operation)
          : null;
        return {
          key: `${check.id}-${check.operation ?? ''}-${check.nodeId ?? ''}`,
          label: check.label,
          detail: check.message,
          actual: formatCheckValue(check),
          limit: formatCheckLimit(check),
          requirement: check.severity === 'required' ? 'Required' : 'Advisory',
          result: { passed: check.passed },
          focus: check.nodeId ? (
            <FocusButton label="Node" onFocus={() => onFocusNode(check.nodeId!)} />
          ) : routeTarget ? (
            <FocusButton label="Route" onFocus={() => onFocusNode(routeTarget)} />
          ) : null,
        };
      })}
    />
  );
}

function OperationTable({ horizon }: { horizon: ParcelHorizonResult }) {
  return (
    <ReportTable
      rowHeaderLabel="Operation"
      minWidthPx={950}
      caption={
        <>
          Measured request metrics · {formatHorizon(horizon.horizonYears)} · 60 s
          window plus drain
        </>
      }
      columns={[
        { key: 'offered', label: 'Offered' },
        { key: 'success', label: 'Success' },
        { key: 'availability', label: 'Availability' },
        {
          key: 'errors',
          label: 'Errors',
          title: 'Rejected, timed out, missing data, stale and unfinished requests',
        },
        { key: 'p50', label: 'p50' },
        { key: 'p95', label: 'p95' },
        { key: 'p99', label: 'p99' },
        { key: 'freshness', label: 'Freshness p95' },
        { key: 'target', label: 'Target' },
        { key: 'result', label: 'Result' },
      ]}
      rows={PARCEL_BUSINESS_OPERATIONS.map((operation) => {
        const metrics = horizon.operations[operation];
        const target = PARCEL_LEVEL.slo.p95Ms[operation];
        const pass = operationPassLabel(
          operation,
          metrics.availability,
          metrics.latencyP95Ms,
          metrics.freshnessP95Ms,
          PARCEL_LEVEL,
          metrics.counts.success,
        );
        return {
          key: operation,
          header: formatOperationName(operation),
          cells: [
            formatInteger(metrics.counts.offered),
            formatInteger(metrics.counts.success),
            formatFractionPercent(metrics.availability, 2),
            <span
              title={`Rejected ${metrics.counts.rejected}; timed out ${metrics.counts.timedOut}; missing data ${metrics.counts.missedData}; stale ${metrics.counts.stale}; unfinished ${metrics.counts.unfinished}`}
            >
              {formatInteger(metrics.counts.failed)}
            </span>,
            formatSuccessfulMilliseconds(metrics.latencyP50Ms, metrics.counts.success),
            formatSuccessfulMilliseconds(metrics.latencyP95Ms, metrics.counts.success),
            formatSuccessfulMilliseconds(metrics.latencyP99Ms, metrics.counts.success),
            operation === 'status' || operation === 'report'
              ? formatSuccessfulMilliseconds(
                  metrics.freshnessP95Ms,
                  metrics.counts.success,
                )
              : '—',
            <>
              {formatFractionPercent(PARCEL_LEVEL.slo.availability, 1)} ·{' '}
              {formatMilliseconds(target)}
            </>,
            <span className={pass.passed ? 'is-pass' : 'is-fail'} title={pass.reason}>
              {pass.passed ? 'Pass' : 'Fail'}
            </span>,
          ],
        };
      })}
    />
  );
}

function WorkTable({ horizon }: { horizon: ParcelHorizonResult }) {
  return (
    <ReportTable
      rowHeaderLabel="Operation"
      caption="Rows and bytes work · measured requests"
      columns={[
        { key: 'rows', label: 'Rows scanned' },
        { key: 'bytesRead', label: 'Bytes read' },
        { key: 'bytesWritten', label: 'Bytes written' },
        { key: 'goodput', label: 'Goodput/s' },
      ]}
      rows={PARCEL_BUSINESS_OPERATIONS.map((operation) => {
        const metrics = horizon.operations[operation];
        return {
          key: operation,
          header: formatOperationName(operation),
          cells: [
            formatInteger(metrics.rowsScanned),
            formatDataSize(metrics.bytesRead),
            formatDataSize(metrics.bytesWritten),
            formatInteger(metrics.estimatedThroughputPerSec),
          ],
        };
      })}
    />
  );
}

function CapacityTable({ horizon }: { horizon: ParcelHorizonResult }) {
  const { capacity } = horizon;
  return (
    <>
      <dl className="parcel-summary-grid">
        <div>
          <dt>Raw event bytes</dt>
          <dd>{formatDataSize(capacity.rawEventBytes)}</dd>
        </div>
        <div>
          <dt>Physical event bytes</dt>
          <dd>{formatDataSize(capacity.physicalBytes)}</dd>
        </div>
        <div>
          <dt>Index bytes</dt>
          <dd>{formatDataSize(capacity.indexBytes)}</dd>
        </div>
        <div>
          <dt>Latest status bytes</dt>
          <dd>{formatDataSize(capacity.latestStatusBytes)}</dd>
        </div>
        <div>
          <dt>Rollup bytes</dt>
          <dd>{formatDataSize(capacity.rollupBytes)}</dd>
        </div>
        <div>
          <dt>Used / provisioned</dt>
          <dd>
            {formatTerabytes(capacity.totalUsedTb)} /{' '}
            {formatTerabytes(capacity.totalProvisionedTb)}
          </dd>
        </div>
        <div>
          <dt>Replication factor</dt>
          <dd>{capacity.replicationFactor.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Retention</dt>
          <dd>
            {capacity.retentionYearsRequired} years required ·{' '}
            {capacity.retentionOk ? 'met' : 'not met'}
          </dd>
        </div>
      </dl>
      <ReportTable
        rowHeaderLabel="Store"
        minWidthPx={950}
        caption={`Analytical store capacity at ${formatHorizon(horizon.horizonYears)}`}
        columns={[
          { key: 'roles', label: 'Roles' },
          { key: 'used', label: 'Used' },
          { key: 'provisioned', label: 'Provisioned' },
          { key: 'utilization', label: 'Utilization' },
          { key: 'index', label: 'Index' },
          { key: 'latest', label: 'Latest' },
          { key: 'rollups', label: 'Rollups' },
          { key: 'overhead', label: 'Bucket overhead' },
          { key: 'retention', label: 'Retention' },
          { key: 'layout', label: 'Layout' },
        ]}
        rows={capacity.stores.map((store) => ({
          key: store.nodeId,
          header: store.nodeId,
          cells: [
            store.roles.join(', '),
            formatDataSize(store.totalUsedBytes),
            formatTerabytes(store.provisionedTb),
            <span className={store.capacityOk ? '' : 'is-fail'}>
              {formatFractionPercent(store.utilization, 1)}
            </span>,
            formatDataSize(store.indexBytes),
            formatDataSize(store.latestStatusBytes),
            formatDataSize(store.rollupBytes),
            formatDataSize(store.bucketOverheadBytes),
            `${store.retentionYears} y`,
            `${store.compression} · ${store.index} · ${store.partition}`,
          ],
        }))}
      />
      {capacity.notes.length > 0 ? (
        <ul className="parcel-results__notes">
          {capacity.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function CostBlock({ horizon }: { horizon: ParcelHorizonResult }) {
  const { cost } = horizon;
  return (
    <>
      <dl className="parcel-summary-grid">
        <div>
          <dt>Monthly total</dt>
          <dd>${cost.monthlyUsd.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Compute / storage</dt>
          <dd>
            ${cost.computeMonthlyUsd.toFixed(2)} / ${cost.storageMonthlyUsd.toFixed(2)}
          </dd>
        </div>
        <div>
          <dt>Five-year TCO</dt>
          <dd>${cost.fiveYearTcoUsd.toFixed(0)}</dd>
        </div>
        <div>
          <dt>Compute hours</dt>
          <dd>{formatInteger(cost.computeHours)}</dd>
        </div>
        <div>
          <dt>Provisioned storage</dt>
          <dd>{formatTerabytes(cost.provisionedStorageTb)}</dd>
        </div>
        <div>
          <dt>Budget</dt>
          <dd className={cost.withinBudget ? 'is-pass' : 'is-fail'}>
            ${cost.monthlyUsd.toFixed(2)} / ${cost.budgetMonthlyUsd.toFixed(2)}
          </dd>
        </div>
      </dl>
      <ReportTable
        rowHeaderLabel="Node"
        caption={`Priced assumptions · ${cost.pricingVersion}`}
        columns={[
          { key: 'size', label: 'Size' },
          { key: 'compute', label: 'Compute / mo' },
          { key: 'storage', label: 'Storage / mo' },
          { key: 'total', label: 'Total / mo' },
        ]}
        rows={cost.byNode.map((item) => ({
          key: item.nodeId,
          header: item.nodeId,
          cells: [
            item.size,
            `$${item.computeMonthlyUsd.toFixed(2)}`,
            `$${item.storageMonthlyUsd.toFixed(2)} (${item.provisionedStorageTb} TB)`,
            `$${item.totalMonthlyUsd.toFixed(2)}`,
          ],
        }))}
      />
      <p className="parcel-results__note">{cost.note}</p>
    </>
  );
}

function WorkloadBlock({ horizon }: { horizon: ParcelHorizonResult }) {
  const workload = horizon.workload;
  return (
    <dl className="parcel-summary-grid">
      <div>
        <dt>Simulated window</dt>
        <dd>
          {formatMilliseconds(workload.durationMs)} +{' '}
          {formatMilliseconds(workload.drainMs)} drain
        </dd>
      </div>
      <div>
        <dt>Evaluated requests</dt>
        <dd>{formatInteger(workload.sampledRequests)}</dd>
      </div>
      <div>
        <dt>Offered requests</dt>
        <dd>{formatInteger(workload.estimatedOfferedRequests)}</dd>
      </div>
      <div>
        <dt>Scheduled reports</dt>
        <dd>{formatInteger(workload.scheduledReports)}</dd>
      </div>
      <div>
        <dt>Old-history cohort</dt>
        <dd>{formatInteger(workload.oldHistoryRequests)}</dd>
      </div>
      <div>
        <dt>Event budget / processed</dt>
        <dd>
          {formatInteger(workload.eventBudget)} / {formatInteger(workload.processedEvents)}
          {workload.exhausted ? ' · exhausted' : ''}
        </dd>
      </div>
      <div>
        <dt>Keyspace</dt>
        <dd>{formatInteger(workload.keyspace)}</dd>
      </div>
      <div>
        <dt>Offered request coverage</dt>
        <dd>
          {workload.sampleFactor === 1
            ? 'Every request evaluated'
            : `1 in ${workload.sampleFactor}`}
        </dd>
      </div>
    </dl>
  );
}

function DiagnosticList({
  diagnostics,
  onFocusNode,
  onFocusEdge,
}: {
  diagnostics: readonly ParcelDiagnostic[];
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  const graph = useParcelStore((state) => state.graph);
  if (diagnostics.length === 0) {
    return <p className="parcel-results__note">No engine diagnostics for this horizon.</p>;
  }
  return (
    <ul className="parcel-diagnostics">
      {diagnostics.map((diagnostic) => {
        const targetNode =
          diagnostic.nodeId ??
          (diagnostic.operation
            ? parcelRouteTarget(graph, diagnostic.operation)
            : null);
        return (
          <li key={diagnostic.id} className={`parcel-diagnostics__item parcel-diagnostics__item--${diagnostic.severity}`}>
            <span className="parcel-diagnostics__icon" aria-hidden="true">
              {diagnostic.severity === 'error' ? (
                <XCircle size={16} />
              ) : diagnostic.severity === 'warning' ? (
                <AlertTriangle size={16} />
              ) : (
                <CheckCircle2 size={16} />
              )}
            </span>
            <div>
              <p>{diagnostic.message}</p>
              {targetNode ? (
                <FocusButton
                  label={`Focus ${targetNode}`}
                  onFocus={() => onFocusNode(targetNode)}
                />
              ) : diagnostic.edgeId ? (
                <FocusButton
                  label="Focus route"
                  onFocus={() => onFocusEdge(diagnostic.edgeId!)}
                />
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function IssueList({
  issues,
  onFocusNode,
  onFocusEdge,
}: {
  issues: readonly ParcelIssue[];
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  const unique = uniqueParcelIssues(issues);
  if (unique.length === 0) {
    return <p className="parcel-results__note">No blocking issues.</p>;
  }
  return (
    <ul className="parcel-diagnostics">
      {unique.map((issue, index) => (
        <li
          key={`${issue.code}-${index}`}
          className={`parcel-diagnostics__item parcel-diagnostics__item--${issue.severity}`}
        >
          <div>
            <p>{issue.message}</p>
            {issue.nodeId ? (
              <FocusButton
                label="Focus node"
                onFocus={() => onFocusNode(issue.nodeId!)}
              />
            ) : issue.edgeId ? (
              <FocusButton
                label="Focus route"
                onFocus={() => onFocusEdge(issue.edgeId!)}
              />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ResultBody({
  evaluation,
  horizon,
  stale,
  onFocusNode,
  onFocusEdge,
}: {
  evaluation: ParcelEvaluation;
  horizon: ParcelHorizonResult;
  stale: boolean;
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  return (
    <>
      {stale ? (
        <p className="parcel-results__stale" role="status">
          This result belongs to an earlier semantic graph or seed. Metrics are
          still shown for reference, but canvas highlights are hidden until you run
          again. Moving or renaming nodes alone does not make it stale.
        </p>
      ) : null}
      <ReportSection
        title={`Operations · ${formatHorizon(horizon.horizonYears)}`}
        note="Availability uses every offered request. Percentiles cover successful responses only. Rejected, timed-out, missing-data, stale and unfinished requests fail availability and cannot improve latency. “Errors” includes all of those failure counters; hover the cell for the split."
      >
        <OperationTable horizon={horizon} />
      </ReportSection>
      <ReportSection title={`Checks · ${formatHorizon(horizon.horizonYears)}`}>
        <CheckTable
          checks={horizon.checks}
          onFocusNode={onFocusNode}
        />
        {evaluation.checks.length > 0 ? (
          <details className="parcel-results__details">
            <summary>Overall checks across both horizons</summary>
            <CheckTable
              checks={evaluation.checks}
              onFocusNode={onFocusNode}
            />
          </details>
        ) : null}
      </ReportSection>
      <ReportSection
        title={`Work performed · ${formatHorizon(horizon.horizonYears)}`}
        note="These are measured work counters for the evaluation window, not the five-year dataset size."
      >
        <WorkTable horizon={horizon} />
      </ReportSection>
      <ReportSection
        title={`Analytical capacity · ${formatHorizon(horizon.horizonYears)}`}
        note="Capacity uses the full horizon dataset: raw events, indexes, latest status, rollups and physical replicas. It is analytical and independent of request latency."
      >
        <CapacityTable horizon={horizon} />
      </ReportSection>
      <ReportSection title="Cost and five-year TCO">
        <CostBlock horizon={horizon} />
      </ReportSection>
      <ReportSection
        title="Workload window"
        note="Traffic is simulated for 60 seconds; stored data is calculated at years 1 and 5. The two views stay separate."
      >
        <WorkloadBlock horizon={horizon} />
      </ReportSection>
      <ReportSection title="Diagnostics">
        <DiagnosticList
          diagnostics={horizon.diagnostics}
          onFocusNode={onFocusNode}
          onFocusEdge={onFocusEdge}
        />
      </ReportSection>
      <details className="parcel-results__details">
        <summary>Model details and assumptions</summary>
        <p className="parcel-results__note">
          Model {evaluation.meta.modelVersion} · content{' '}
          {evaluation.meta.contentVersion} · pricing{' '}
          {evaluation.meta.pricingVersion} · level {evaluation.meta.levelId}
        </p>
        <ul className="parcel-results__notes">
          {evaluation.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
      </details>
    </>
  );
}

export function ParcelResultsPanel({
  open,
  onOpenChange,
  height,
  panelRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  height: number | null;
  panelRef: RefObject<HTMLElement | null>;
}) {
  const graph = useParcelStore((state) => state.graph);
  const seed = useParcelStore((state) => state.seed);
  const runPhase = useParcelStore((state) => state.runPhase);
  const progress = useParcelStore((state) => state.progress);
  const result = useParcelStore((state) => state.result);
  const resultDigest = useParcelStore((state) => state.resultDigest);
  const resultSeed = useParcelStore((state) => state.resultSeed);
  const runIssues = useParcelStore((state) => state.runIssues);
  const runError = useParcelStore((state) => state.runError);
  const selectedHorizon = useParcelStore((state) => state.selectedHorizon);
  const setSelectedHorizon = useParcelStore((state) => state.setSelectedHorizon);
  const select = useParcelStore((state) => state.select);
  const stale = parcelResultStale(result, resultDigest, resultSeed, graph, seed);

  const focusNode = (id: string) => select({ type: 'node', id });
  const focusEdge = (id: string) => select({ type: 'edge', id });

  const horizon = useMemo<ParcelHorizonResult | null>(() => {
    if (!result || result.status !== 'ok') {
      return null;
    }
    return (
      result.horizons.find((item) => item.horizonYears === selectedHorizon) ??
      result.horizons[0] ??
      null
    );
  }, [result, selectedHorizon]);

  const summary = (() => {
    if (runPhase === 'running') {
      return progress ? progress.message : 'Evaluation running';
    }
    if (runPhase === 'blocked') {
      return `Run blocked by ${runIssues.length} validation issue${runIssues.length === 1 ? '' : 's'}`;
    }
    if (runPhase === 'error') {
      return 'Run failed';
    }
    if (runPhase === 'stopped') {
      return 'Run cancelled';
    }
    if (runPhase === 'completed' && result) {
      if (stale) {
        return 'Previous result';
      }
      return result.passed ? 'Passed' : 'Not passed';
    }
    return 'No run yet';
  })();

  return (
    <TelemetryPanel
      title="Results & telemetry"
      summary={summary}
      open={open}
      onOpenChange={onOpenChange}
      height={height}
      panelRef={panelRef}
      bodyId="parcel-results-body"
      ariaLabel="Results and telemetry"
      className="parcel-results"
    >
          {runPhase === 'running' ? (
            <div className="parcel-results__progress">
              <ProgressBar
                completed={progress?.completed ?? 0}
                total={progress?.total ?? 1}
                label={progress?.message ?? 'Preparing evaluation'}
              />
              <p className="parcel-results__note">
                This run uses the graph and seed captured when you pressed Run.
                Progress shows real validation, capacity and simulation phases.
                Stop ends the run.
              </p>
            </div>
          ) : null}

          {runPhase === 'blocked' ? (
            <ReportSection
              title="Run blocked before evaluation"
              description="The graph is still editable. Fix these blocking errors, then run again. Warnings do not block a run."
            >
              <IssueList
                issues={runIssues}
                onFocusNode={focusNode}
                onFocusEdge={focusEdge}
              />
            </ReportSection>
          ) : null}

          {runPhase === 'error' ? (
            <div className="parcel-results__banner is-fail" role="alert">
              <XCircle size={22} aria-hidden="true" />
              <div>
                <p className="parcel-results__eyebrow">Run failed</p>
                <h2>No result</h2>
                <p>{runError ?? 'The engine reported an unknown error.'}</p>
              </div>
            </div>
          ) : null}

          {runPhase === 'stopped' ? (
            <div className="parcel-results__banner is-neutral" role="status">
              <AlertTriangle size={22} aria-hidden="true" />
              <div>
                <p className="parcel-results__eyebrow">Run cancelled</p>
                <h2>No partial result</h2>
                <p>
                  The run was stopped. A cancelled run does not produce a pass/fail
                  verdict or partial metrics.
                </p>
              </div>
            </div>
          ) : null}

          {runPhase === 'idle' ? (
            <p className="parcel-results__empty">
              Run the evaluation to see measured operation metrics, analytical
              storage and five-year TCO. Validation issues are always visible in
              the graph and the Issues tab.
            </p>
          ) : null}

          {runPhase === 'completed' && result ? (
            <>
              <div
                className={`parcel-results__banner ${
                  result.passed ? 'is-pass' : 'is-fail'
                }`}
                role="status"
              >
                {result.passed ? (
                  <CheckCircle2 size={22} aria-hidden="true" />
                ) : (
                  <XCircle size={22} aria-hidden="true" />
                )}
                <div>
                  <p className="parcel-results__eyebrow">
                    Run result · seed {result.meta.seed}
                  </p>
                  <h2>
                    {result.status === 'invalid'
                      ? 'Invalid graph'
                      : result.status === 'error'
                        ? 'Engine error'
                        : result.passed
                          ? 'Passed'
                          : 'Not passed'}
                  </h2>
                  <p>
                    {result.status === 'ok'
                      ? `Required horizons: ${result.meta.requiredHorizons.join(' and ')} years.`
                      : result.status === 'invalid'
                        ? 'No metrics are produced for an invalid document.'
                        : 'No metrics are produced for a failed engine run.'}
                  </p>
                </div>
              </div>

              {result.status === 'invalid' ? (
                <ReportSection title="Validation issues">
                  <IssueList
                    issues={result.issues}
                    onFocusNode={focusNode}
                    onFocusEdge={focusEdge}
                  />
                </ReportSection>
              ) : null}

              {result.status === 'error' ? (
                <ReportSection title="Engine error" description={result.error.message}>
                  <IssueList
                    issues={result.issues}
                    onFocusNode={focusNode}
                    onFocusEdge={focusEdge}
                  />
                </ReportSection>
              ) : null}

              {result.status === 'ok' && horizon ? (
                <>
                  <div className="parcel-horizon-tabs" role="tablist" aria-label="Horizon">
                    {result.horizons.map((item) => (
                      <button
                        type="button"
                        role="tab"
                        key={item.horizonYears}
                        aria-selected={horizon.horizonYears === item.horizonYears}
                        className={
                          horizon.horizonYears === item.horizonYears
                            ? 'is-active'
                            : ''
                        }
                        onClick={() => setSelectedHorizon(item.horizonYears)}
                      >
                        {formatHorizon(item.horizonYears)} ·{' '}
                        {item.passed ? 'pass' : 'fail'}
                      </button>
                    ))}
                  </div>
                  <div className="parcel-result-versions">
                    <span>
                      Years 1 and 5 are both required. Each offered request is
                      evaluated in this release.
                    </span>
                    <span>
                      {horizon.passed ? 'This horizon passes.' : 'This horizon fails.'}
                    </span>
                  </div>
                  <ResultBody
                    evaluation={result}
                    horizon={horizon}
                    stale={stale}
                    onFocusNode={focusNode}
                    onFocusEdge={focusEdge}
                  />
                </>
              ) : null}
            </>
          ) : null}
    </TelemetryPanel>
  );
}
