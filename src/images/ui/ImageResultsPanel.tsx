import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useState,
  type RefObject,
} from 'react';

import { IMAGE_LEVEL } from '../level';
import {
  type ImageCheck,
  type ImageCapacityBreakdown,
  type ImageCostSummary,
  type ImageDiagnostic,
  type ImageIssue,
  type ImageOperationMetrics,
  type ImageScenarioResult,
  type ImageScenarioWindow,
} from '../contracts';
import { formatInteger } from '../../ui/format';
import {
  ReportSection,
  ReportTable,
  RequirementTable,
  TelemetryPanel,
} from '../../features/game-ui';
import {
  imageUniqueIssues,
  imageResultStale,
} from './image-diagnostics';
import {
  imageGateExplanationMap,
  type ImageGateExplanation,
} from './image-gate-explanations';
import {
  formatCheckNumber,
  formatDataSize,
  formatFractionPercent,
  formatGbitPerSec,
  formatMilliseconds,
  formatSuccessfulMilliseconds,
  formatTerabytes,
  formatUsd,
} from './image-format';
import {
  IMAGE_BUSINESS_OPERATION_LABELS,
  IMAGE_BUSINESS_ORDER,
  IMAGE_PHASE_LABELS,
  IMAGE_SCENARIO_LABELS,
} from './image-meta';
import { useImageStore } from './image-store';

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
    <div className="image-progress">
      <div
        className="image-progress__track"
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
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="game-focus" onClick={onClick}>
      {label}
    </button>
  );
}

function IssueList({
  issues,
  onFocusNode,
  onFocusEdge,
}: {
  issues: readonly ImageIssue[];
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  const unique = imageUniqueIssues(issues);
  if (unique.length === 0) {
    return <p className="image-results__note">No blocking issues.</p>;
  }
  return (
    <ul className="image-diagnostics">
      {unique.map((issue, index) => (
        <li
          key={`${issue.code}-${index}`}
          className={`image-diagnostics__item image-diagnostics__item--${issue.severity}`}
        >
          <div>
            <p>{issue.message}</p>
            {issue.nodeId ? (
              <FocusButton
                label="Focus node"
                onClick={() => onFocusNode(issue.nodeId!)}
              />
            ) : issue.edgeId ? (
              <FocusButton
                label="Focus route"
                onClick={() => onFocusEdge(issue.edgeId!)}
              />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function DiagnosticList({
  diagnostics,
  onFocusNode,
  onFocusEdge,
}: {
  diagnostics: readonly ImageDiagnostic[];
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  if (diagnostics.length === 0) {
    return (
      <p className="image-results__note">
        No additional engine notices for this case. Request outcomes are counted in
        Operations, so review them there before treating this case as clean.
      </p>
    );
  }
  return (
    <ul className="image-diagnostics">
      {diagnostics.map((diagnostic, index) => (
        <li
          key={`${diagnostic.id}-${index}`}
          className={`image-diagnostics__item image-diagnostics__item--${diagnostic.severity}`}
        >
          <span className="image-diagnostics__icon" aria-hidden="true">
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
            {diagnostic.nodeId ? (
              <FocusButton
                label="Focus node"
                onClick={() => onFocusNode(diagnostic.nodeId!)}
              />
            ) : diagnostic.edgeId ? (
              <FocusButton
                label="Focus route"
                onClick={() => onFocusEdge(diagnostic.edgeId!)}
              />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function GateExplanation({ explanation }: { explanation: ImageGateExplanation }) {
  return (
    <div className="image-gate-explanation">
      <p className="image-gate-explanation__eyebrow">Guided analysis</p>
      <div className="image-gate-explanation__block">
        <p className="image-gate-explanation__label">
          {explanation.possibleCauses.length === 1
            ? 'Possible cause'
            : 'Possible causes'}
        </p>
        {explanation.possibleCauses.length === 0 ? (
          <p className="image-gate-explanation__text">
            No specific candidate is supported by the aggregate case data.
          </p>
        ) : (
          <ul className="image-gate-explanation__list">
            {explanation.possibleCauses.map((candidate) => (
              <li key={candidate.cause}>
                <strong>{candidate.cause}.</strong> {candidate.detail}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="image-gate-explanation__block">
        <p className="image-gate-explanation__label">Evidence</p>
        <ul className="image-gate-explanation__list">
          {explanation.evidence.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <div className="image-gate-explanation__block">
        <p className="image-gate-explanation__label">Check next</p>
        <ul className="image-gate-explanation__list">
          {explanation.checkNext.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <p className="image-gate-explanation__caveat">{explanation.caveat}</p>
    </div>
  );
}

function CheckTable({
  checks,
  explanations,
  guided,
  onFocusNode,
}: {
  checks: readonly ImageCheck[];
  explanations: ReadonlyMap<string, ImageGateExplanation>;
  guided: boolean;
  onFocusNode: (id: string) => void;
}) {
  return (
    <RequirementTable
      nameLabel="Gate"
      caption="Gates and advisories for this case"
      columns={['actual', 'limit', 'requirement', 'result', 'focus']}
      dense
      empty={<p className="image-results__note">No gates were reported.</p>}
      rows={checks.map((check, index) => {
        const explanation = guided ? explanations.get(check.id) ?? null : null;
        return {
          key: `${check.id}-${index}`,
          label: check.label,
          detail: check.message,
          actual: formatCheckNumber(check.actual, check.unit),
          limit: formatCheckNumber(check.limit, check.unit),
          requirement: check.severity === 'required' ? 'Required' : 'Advisory',
          result: { passed: check.passed },
          focus: check.nodeId ? (
            <FocusButton label="Node" onClick={() => onFocusNode(check.nodeId!)} />
          ) : null,
          extra: explanation ? <GateExplanation explanation={explanation} /> : null,
        };
      })}
    />
  );
}

function failureSplit(metrics: ImageOperationMetrics): string {
  const counts = metrics.counts;
  return [
    `${formatInteger(counts.failed)} failed`,
    `${formatInteger(counts.rejected)} other failed`,
    `${formatInteger(counts.timedOut)} timed out`,
    `${formatInteger(counts.incorrect)} incorrect`,
    `${formatInteger(counts.stale)} stale`,
    `${formatInteger(counts.missingData)} missing`,
    `${formatInteger(counts.duplicateEffects)} duplicate`,
    `${formatInteger(counts.unfinished)} unfinished`,
  ].join(' · ');
}

function failureCodes(metrics: ImageOperationMetrics): string {
  const entries = Object.entries(metrics.errorsByCode);
  if (entries.length === 0) {
    return 'no error codes reported';
  }
  return entries
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([code, count]) => `${code}: ${formatInteger(count)}`)
    .join(', ');
}

function OperationTable({ scenario }: { scenario: ImageScenarioResult }) {
  return (
    <div className="game-table-wrap">
      <table className="game-table game-table--dense image-wide-table">
        <caption>
          Measured operations · {scenario.workload.measuredMs / 1000} s window,
          successful percentiles only
        </caption>
        <thead>
          <tr>
            <th scope="col">Operation</th>
            <th scope="col">Offered</th>
            <th scope="col">Completed</th>
            <th scope="col">Success</th>
            <th scope="col">Availability</th>
            <th scope="col">Timely</th>
            <th scope="col">Correct</th>
            <th scope="col">p50</th>
            <th scope="col">p95</th>
            <th scope="col">p99</th>
            <th scope="col">p99.9</th>
            <th scope="col">Samples</th>
            <th
              scope="col"
              title="First nonzero started-stage wait per successful request. Not cumulative queue time across stages."
            >
              Queue p95
            </th>
          </tr>
        </thead>
        <tbody>
          {IMAGE_BUSINESS_ORDER.map((operation) => {
            const metrics = scenario.operations[operation];
            const reliable = metrics.p999Reliable;
            return (
              <tr key={operation}>
                <th scope="row">
                  {IMAGE_BUSINESS_OPERATION_LABELS[operation]}
                  <span className="game-table__sub">{failureSplit(metrics)}</span>
                  <span className="game-table__sub">{failureCodes(metrics)}</span>
                </th>
                <td>{formatInteger(metrics.counts.offered)}</td>
                <td>{formatInteger(metrics.counts.completed)}</td>
                <td>{formatInteger(metrics.counts.success)}</td>
                <td>{formatFractionPercent(metrics.availability, 2)}</td>
                <td>{formatFractionPercent(metrics.timelyRatio, 2)}</td>
                <td>{formatFractionPercent(metrics.correctnessRatio, 2)}</td>
                <td>
                  {formatSuccessfulMilliseconds(
                    metrics.latencyP50Ms,
                    metrics.sampleCount,
                  )}
                </td>
                <td>
                  {formatSuccessfulMilliseconds(
                    metrics.latencyP95Ms,
                    metrics.sampleCount,
                  )}
                </td>
                <td>
                  {formatSuccessfulMilliseconds(
                    metrics.latencyP99Ms,
                    metrics.sampleCount,
                  )}
                </td>
                <td
                  className={reliable ? '' : 'is-warn'}
                  title={
                    reliable
                      ? `${formatInteger(metrics.p999SampleCount)} p99.9 samples`
                      : `Only ${formatInteger(metrics.p999SampleCount)} of ${formatInteger(metrics.minimumP999Samples)} required samples`
                  }
                >
                  {formatSuccessfulMilliseconds(
                    metrics.latencyP999Ms,
                    metrics.sampleCount,
                  )}
                  {reliable ? '' : ' *'}
                </td>
                <td>
                  {formatInteger(metrics.sampleCount)}
                  <span className="game-table__sub">
                    p99.9 {formatInteger(metrics.p999SampleCount)}
                  </span>
                </td>
                <td>{formatMilliseconds(metrics.queueWaitP95Ms)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WindowTable({
  title,
  window,
}: {
  title: string;
  window: ImageScenarioWindow;
}) {
  return (
    <ReportTable
      rowHeaderLabel="Operation"
      dense
      caption={`${title} · ${(window.fromMs / 1000).toFixed(0)}–${(window.toMs / 1000).toFixed(0)} s`}
      columns={[
        { key: 'offered', label: 'Offered' },
        { key: 'success', label: 'Success' },
        { key: 'availability', label: 'Availability' },
        { key: 'p999', label: 'p99.9' },
        { key: 'result', label: 'Result' },
      ]}
      rows={IMAGE_BUSINESS_ORDER.map((operation) => {
        const item = window.operations[operation];
        return {
          key: operation,
          header: IMAGE_BUSINESS_OPERATION_LABELS[operation],
          cells: [
            formatInteger(item.offered),
            formatInteger(item.success),
            formatFractionPercent(item.availability, 2),
            formatSuccessfulMilliseconds(item.latencyP999Ms, item.sampleCount),
            <span className={item.passed ? 'is-pass' : 'is-fail'}>
              {item.passed ? 'Pass' : 'Fail'}
            </span>,
          ],
        };
      })}
    />
  );
}

function FreshnessBlock({ scenario }: { scenario: ImageScenarioResult }) {
  const freshness = scenario.freshness;
  const integrity = scenario.dataIntegrity;
  const postlude = scenario.postlude;
  return (
    <>
      <dl className="image-summary-grid">
        <div>
          <dt>Freshness probes</dt>
          <dd>
            {formatInteger(freshness.probes)} · {formatInteger(freshness.success)} on
            time
          </dd>
        </div>
        <div>
          <dt>Freshness max / p99 lag</dt>
          <dd>
            {formatMilliseconds(freshness.maxLagMs)} /{' '}
            {formatMilliseconds(freshness.p99LagMs)} of{' '}
            {formatMilliseconds(freshness.limitMs)}
          </dd>
        </div>
        <div>
          <dt>Freshness gate</dt>
          <dd className={freshness.passed ? 'is-pass' : 'is-fail'}>
            {freshness.passed ? 'Pass' : 'Fail'}
          </dd>
        </div>
        <div>
          <dt>Acknowledged / committed</dt>
          <dd>
            {formatInteger(integrity.acknowledgedUploads)} /{' '}
            {formatInteger(integrity.committedUploads)}
          </dd>
        </div>
        <div>
          <dt>Lost-ACK commits</dt>
          <dd>{formatInteger(integrity.lostAckCommitted)}</dd>
        </div>
        <div>
          <dt>Duplicate uploads / effects</dt>
          <dd>
            {formatInteger(integrity.duplicateUploads)} /{' '}
            {formatInteger(integrity.duplicateEffects)}
          </dd>
        </div>
        <div>
          <dt>Missing search results</dt>
          <dd>{formatInteger(integrity.missingSearchResults)}</dd>
        </div>
        <div>
          <dt>Read-your-writes violations</dt>
          <dd>{formatInteger(integrity.visibilityViolations)}</dd>
        </div>
        <div>
          <dt>Integrity gate</dt>
          <dd className={integrity.passed ? 'is-pass' : 'is-fail'}>
            {integrity.passed ? 'Pass' : 'Fail'}
          </dd>
        </div>
        <div>
          <dt>Publication</dt>
          <dd>
            {formatInteger(postlude.publishedUploads)} published ·{' '}
            {formatInteger(postlude.unpublishedCommitted)} unpublished
          </dd>
        </div>
        <div>
          <dt>Max publication lag</dt>
          <dd>
            {formatMilliseconds(postlude.maxPublicationLagMs)} of{' '}
            {formatMilliseconds(postlude.publicationDeadlineMs)}
          </dd>
        </div>
        <div>
          <dt>Consistency postlude</dt>
          <dd className={postlude.passed ? 'is-pass' : 'is-fail'}>
            {postlude.passed ? 'Pass' : 'Fail'} · ends at{' '}
            {formatMilliseconds(postlude.endedAtMs)}
          </dd>
        </div>
      </dl>
      <p className="image-results__note">
        The no-new-offers postlude starts after {formatMilliseconds(postlude.startedAtMs)}{' '}
        and runs through the last acknowledged upload +{' '}
        {formatMilliseconds(postlude.maxAfterLastAckMs)}. Background work is counted;
        it is excluded from the measured-window load averages.
      </p>
    </>
  );
}

function CapacityBlock({ capacity }: { capacity: ImageCapacityBreakdown }) {
  return (
    <>
      <dl className="image-summary-grid">
        <div>
          <dt>Day-30 images</dt>
          <dd>{formatInteger(capacity.dataset.images)}</dd>
        </div>
        <div>
          <dt>Originals</dt>
          <dd>{formatTerabytes(capacity.dataset.originalTb)}</dd>
        </div>
        <div>
          <dt>Metadata before indexes</dt>
          <dd>{formatTerabytes(capacity.dataset.metadataBaseTb)}</dd>
        </div>
        <div>
          <dt>Thumbnails if materialised</dt>
          <dd>{formatTerabytes(capacity.dataset.thumbnailIfMaterializedTb)} (not charged)</dd>
        </div>
        <div>
          <dt>Metadata logical / provisioned</dt>
          <dd>
            {formatTerabytes(capacity.metadataServiceTb)} /{' '}
            {formatTerabytes(capacity.metadataProvisionedTb)}
          </dd>
        </div>
        <div>
          <dt>Metadata copies / instances</dt>
          <dd>
            {formatInteger(capacity.metadataLocalCopies)} /{' '}
            {formatInteger(capacity.metadataInstances)}
          </dd>
        </div>
        <div>
          <dt>Cache capacity / instances</dt>
          <dd>
            {formatDecimalGb(capacity.cacheCapacityGb)} /{' '}
            {formatInteger(capacity.cacheInstances)}
          </dd>
        </div>
        <div>
          <dt>Capacity / retention / topology</dt>
          <dd
            className={
              capacity.capacityOk && capacity.retentionOk && capacity.topologyComplete
                ? 'is-pass'
                : 'is-fail'
            }
          >
            {capacity.capacityOk ? 'ok' : 'over'} ·{' '}
            {capacity.retentionOk ? '30 d ok' : 'retention'} ·{' '}
            {capacity.topologyComplete ? 'complete' : 'incomplete'}
          </dd>
        </div>
      </dl>
      <div className="game-table-wrap">
        <table className="game-table game-table--dense image-wide-table">
          <caption>Metadata stores at day 30</caption>
          <thead>
            <tr>
              <th scope="col">Store</th>
              <th scope="col">Region</th>
              <th scope="col">Roles</th>
              <th scope="col">Backend / index</th>
              <th scope="col">Instances / copies</th>
              <th scope="col">Logical</th>
              <th scope="col">Provisioned</th>
              <th scope="col">Used</th>
              <th scope="col">Capacity</th>
            </tr>
          </thead>
          <tbody>
            {capacity.metadataNodes.map((node) => (
              <tr key={node.nodeId}>
                <th scope="row">{node.nodeId}</th>
                <td>{node.region}</td>
                <td>{node.roles.join(', ') || 'unused'}</td>
                <td>
                  {node.backend} / {node.index}
                </td>
                <td>
                  {node.instances} / {node.replicas}
                </td>
                <td>{formatTerabytes(node.logicalCapacityTb)}</td>
                <td>{formatTerabytes(node.provisionedDiskTb)}</td>
                <td>{formatFractionPercent(node.utilizationProvisioned, 1)}</td>
                <td className={node.capacityOk ? 'is-pass' : 'is-fail'}>
                  {node.capacityOk ? 'ok' : 'over'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {capacity.caches.length > 0 ? (
        <div className="game-table-wrap">
          <table className="game-table game-table--dense">
            <caption>Caches</caption>
            <thead>
              <tr>
                <th scope="col">Cache</th>
                <th scope="col">Medium</th>
                <th scope="col">Instances</th>
                <th scope="col">Total</th>
                <th scope="col">Per instance</th>
                <th scope="col">Fits</th>
              </tr>
            </thead>
            <tbody>
              {capacity.caches.map((cache) => (
                <tr key={cache.nodeId}>
                  <th scope="row">{cache.nodeId}</th>
                  <td>
                    {cache.medium} · {cache.fill}
                  </td>
                  <td>{formatInteger(cache.instances)}</td>
                  <td>{formatDecimalGb(cache.capacityGb)}</td>
                  <td>{formatDecimalGb(cache.perInstanceCapacityGb)}</td>
                  <td className={cache.fits ? 'is-pass' : 'is-fail'}>
                    {cache.fits ? 'yes' : 'no'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {capacity.notes.length > 0 ? (
        <ul className="image-results__notes">
          {capacity.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function formatDecimalGb(value: number): string {
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1,
  }).format(value)} GB`;
}

/** Human-readable provenance for a stored cost line; the raw contract is unchanged. */
function costProvenanceLabel(provenance: string): string {
  return provenance === 'measured-run'
    ? 'Projected from measured normal traffic'
    : provenance;
}

function CostBlock({ cost }: { cost: ImageCostSummary }) {
  return (
    <>
      <dl className="image-summary-grid">
        <div>
          <dt>Monthly total</dt>
          <dd className={cost.withinBudget ? 'is-pass' : 'is-fail'}>
            {formatUsd(cost.monthlyUsd, 0)}
          </dd>
        </div>
        <div>
          <dt>Fixed provider base</dt>
          <dd>{formatUsd(cost.fixed.totalUsd, 0)}</dd>
        </div>
        <div>
          <dt>Controllable compute + disk</dt>
          <dd>{formatUsd(cost.controllable.totalUsd, 0)}</dd>
        </div>
        <div>
          <dt>Traffic</dt>
          <dd>{formatUsd(cost.traffic.totalUsd, 0)}</dd>
        </div>
        <div>
          <dt>API fees</dt>
          <dd>{formatUsd(cost.api.totalUsd, 0)}</dd>
        </div>
        <div>
          <dt>Budget</dt>
          <dd>
            {formatUsd(cost.monthlyUsd, 0)} / {formatUsd(cost.budgetMonthlyUsd, 0)}
          </dd>
        </div>
      </dl>
      <div className="game-table-wrap">
        <table className="game-table game-table--dense">
          <caption>
            Cost lines · {cost.pricingVersion} · basis{' '}
            {cost.provenance.workloadBasis.replace('-', ' ')} ×{' '}
            {cost.provenance.days} days
          </caption>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Line</th>
              <th scope="col">Monthly</th>
              <th scope="col">Provenance</th>
            </tr>
          </thead>
          <tbody>
            {cost.breakdown.map((line) => (
              <tr key={line.id}>
                <td>{line.category}</td>
                <th scope="row">{line.label}</th>
                <td>{formatUsd(line.monthlyUsd)}</td>
                <td>{costProvenanceLabel(line.provenance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cost.provenance.measured ? (
        <p className="image-results__note image-results__note--strong">
          Monthly estimate: normal replay traffic scaled to 30 days; not the cost of
          this run.
        </p>
      ) : null}
      <p className="image-results__note">
        Cache hit ratio {formatFractionPercent(cost.provenance.cacheHitRatioAssumed, 1)},
        retry ratio {formatFractionPercent(cost.provenance.retryRatioAssumed, 2)}.
        Measured ratios replace the analytical assumptions only when a real run reports
        them; incident replay cost is never extrapolated across the month.
      </p>
    </>
  );
}

function MemoryTable({ scenario }: { scenario: ImageScenarioResult }) {
  return (
    <>
      <div className="game-table-wrap">
        <table className="game-table game-table--dense">
          <caption>Measured memory and instance health per node</caption>
          <thead>
            <tr>
              <th scope="col">Node</th>
              <th scope="col">Kind</th>
              <th scope="col">Region</th>
              <th scope="col">RAM average</th>
              <th scope="col">RAM peak</th>
              <th scope="col">RAM limit</th>
              <th scope="col">Healthy instances</th>
            </tr>
          </thead>
          <tbody>
            {scenario.nodes.map((node) => (
              <tr key={node.nodeId}>
                <th scope="row">{node.label}</th>
                <td>{node.kind}</td>
                <td>{node.region}</td>
                <td>{formatDataSize(node.memoryBytesAvg)}</td>
                <td>{formatDataSize(node.memoryBytesPeak)}</td>
                <td>{formatDataSize(node.memoryLimitBytes)}</td>
                <td
                  className={
                    node.healthyInstances < node.instances ? 'is-fail' : ''
                  }
                >
                  {node.healthyInstances} / {node.instances}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="image-results__note">
        Node counters are raw per-node scopes, not operation totals. App and metadata
        requests include warm-up, client requests are measured offered, and blob requests
        include retries; errors and completed are final-route outcomes, so requests need
        not equal their sum.
      </p>
    </>
  );
}

function PhysicalLinkTable({ scenario }: { scenario: ImageScenarioResult }) {
  return (
    <>
      <p className="image-results__note">
        {IMAGE_LEVEL.network.fullMesh
          ? 'Every transfer shares these physical channels. A logical edge on the canvas is not its own 100 Gbit/s link, and parallel arrows never add bandwidth.'
          : ''}
      </p>
      <div className="game-table-wrap">
        <table className="game-table game-table--dense image-wide-table">
          <caption>
            Physical channels shared by every logical route (not one link per arrow)
          </caption>
          <thead>
            <tr>
              <th scope="col">Channel</th>
              <th scope="col">Kind</th>
              <th scope="col">Regions</th>
              <th scope="col">Capacity</th>
              <th scope="col">Average</th>
              <th scope="col">Peak</th>
              <th scope="col">Sent</th>
              <th scope="col">Received</th>
              <th scope="col">Transfers</th>
              <th scope="col" title="Transfer queue wait p95 on this shared physical channel.">
                Queue p95
              </th>
            </tr>
          </thead>
          <tbody>
            {scenario.links.map((link) => (
              <tr key={link.id}>
                <th scope="row">{link.label}</th>
                <td>{link.kind}</td>
                <td>
                  {link.regionA}
                  {link.regionB ? ` ↔ ${link.regionB}` : ''}
                </td>
                <td>{formatGbitPerSec(link.capacityGbitPerSec)}</td>
                <td>{formatFractionPercent(link.averageUtilization, 1)}</td>
                <td>{formatFractionPercent(link.peakUtilization, 1)}</td>
                <td>{formatDataSize(link.bytesSent)}</td>
                <td>{formatDataSize(link.bytesReceived)}</td>
                <td>{formatInteger(link.transfers)}</td>
                <td>{formatMilliseconds(link.queueWaitP95Ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ScenarioDetail({
  scenario,
  cost,
  capacity,
  onFocusNode,
  onFocusEdge,
}: {
  scenario: ImageScenarioResult;
  cost: ImageCostSummary | null;
  capacity: ImageCapacityBreakdown | null;
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  // Local presentation state only: never persisted, never part of the graph or
  // the stored result. Each browser tab and level keeps its own default.
  const [guided, setGuided] = useState(true);
  const explanations = useMemo(
    () => imageGateExplanationMap(scenario),
    [scenario],
  );
  return (
    <>
      <ReportSection title="Gates">
        <p className="image-results__note">
          {scenario.label} · {scenario.workload.demandMultiplier}× daily average ·
          fault: {scenario.fault.kind}
          {scenario.fault.target ? ` (${scenario.fault.target})` : ''}
          {scenario.fault.region ? ` (${scenario.fault.region})` : ''}
          {scenario.fault.linkA && scenario.fault.linkB
            ? ` (${scenario.fault.linkA} ↔ ${scenario.fault.linkB})`
            : ''}
          {scenario.workload.exhausted
            ? ' · event budget exhausted, so this case is incomplete'
            : ''}
        </p>
        <div className="image-guided">
          <label className="image-guided__toggle">
            <input
              type="checkbox"
              checked={guided}
              onChange={(event) => setGuided(event.target.checked)}
            />
            <span>Guided analysis</span>
          </label>
          <p className="image-results__note">
            Shows evidence-based possible causes, evidence and next checks for failed
            gates. Turn it off to read the raw gates and metrics yourself; the gates,
            metrics and errors stay visible either way.
          </p>
        </div>
        <CheckTable
          checks={scenario.checks}
          explanations={explanations}
          guided={guided}
          onFocusNode={onFocusNode}
        />
      </ReportSection>

      <ReportSection
        title="Operations"
        note={
          <>
            Availability, timely and correct ratios use every offered request. Other
            failed, timed-out, stale, incorrect, missing and unfinished responses are
            failures.
            Queue p95 is the first nonzero started-stage wait per successful request, not
            the total queue time across stages.
            <br />* p99.9 has fewer than{' '}
            {formatInteger(IMAGE_LEVEL.qualification.minimumP999Samples)} successful
            samples, so it is shown but not qualified.
          </>
        }
      >
        <OperationTable scenario={scenario} />
      </ReportSection>

      <ReportSection title="Correctness, freshness and publication">
        <FreshnessBlock scenario={scenario} />
      </ReportSection>

      {scenario.incidentWindow || scenario.recoveryWindow ? (
        <ReportSection title="Incident and recovery windows">
          {scenario.incidentWindow ? (
            <WindowTable title="Incident window" window={scenario.incidentWindow} />
          ) : null}
          {scenario.recoveryWindow ? (
            <WindowTable title="Recovery window" window={scenario.recoveryWindow} />
          ) : null}
        </ReportSection>
      ) : null}

      <ReportSection title="Capacity at day 30">
        {capacity ? (
          <CapacityBlock capacity={capacity} />
        ) : (
          <p className="image-results__note">No capacity estimate was produced.</p>
        )}
      </ReportSection>

      <ReportSection title="Cost">
        {cost ? (
          <CostBlock cost={cost} />
        ) : (
          <p className="image-results__note">No cost estimate was produced.</p>
        )}
      </ReportSection>

      <ReportSection title="Memory and physical links">
        <MemoryTable scenario={scenario} />
        <PhysicalLinkTable scenario={scenario} />
      </ReportSection>

      <ReportSection title="Diagnostics">
        <DiagnosticList
          diagnostics={scenario.diagnostics}
          onFocusNode={onFocusNode}
          onFocusEdge={onFocusEdge}
        />
      </ReportSection>
    </>
  );
}

export function ImageResultsPanel({
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
  const graph = useImageStore((state) => state.graph);
  const seed = useImageStore((state) => state.seed);
  const runPhase = useImageStore((state) => state.runPhase);
  const progress = useImageStore((state) => state.progress);
  const result = useImageStore((state) => state.result);
  const resultDigest = useImageStore((state) => state.resultDigest);
  const resultSeed = useImageStore((state) => state.resultSeed);
  const runIssues = useImageStore((state) => state.runIssues);
  const runError = useImageStore((state) => state.runError);
  const runStartedAt = useImageStore((state) => state.runStartedAt);
  const selectedScenario = useImageStore((state) => state.selectedScenario);
  const setSelectedScenario = useImageStore((state) => state.setSelectedScenario);
  const select = useImageStore((state) => state.select);
  const stale = imageResultStale(result, resultDigest, resultSeed, graph, seed);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (runPhase !== 'running' || runStartedAt === null) {
      return undefined;
    }
    // Bounded cadence: one elapsed-time tick per second, never a fake phase.
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [runPhase, runStartedAt]);

  const focusNode = (id: string) => select({ type: 'node', id });
  const focusEdge = (id: string) => select({ type: 'edge', id });

  const scenario = useMemo<ImageScenarioResult | null>(() => {
    if (!result || result.scenarios.length === 0) {
      return null;
    }
    return (
      result.scenarios.find((item) => item.name === selectedScenario) ??
      result.scenarios[0] ??
      null
    );
  }, [result, selectedScenario]);

  const summary = (() => {
    if (runPhase === 'running') {
      return progress
        ? `${IMAGE_PHASE_LABELS[progress.phase] ?? progress.phase}${
            progress.scenario
              ? ` · ${IMAGE_SCENARIO_LABELS[progress.scenario]}`
              : ''
          }`
        : 'Evaluation running';
    }
    if (runPhase === 'blocked') {
      return `Run blocked by ${runIssues.length} validation issue${
        runIssues.length === 1 ? '' : 's'
      }`;
    }
    if (runPhase === 'error') {
      return 'Run failed';
    }
    if (runPhase === 'stopped') {
      return 'Run stopped';
    }
    if (runPhase === 'completed' && result) {
      if (stale) {
        return 'Previous result';
      }
      return result.status === 'complete'
        ? result.passed
          ? 'All seven cases passed'
          : 'Qualification failed'
        : result.status === 'incomplete'
          ? 'Incomplete evaluation'
          : 'Invalid graph';
    }
    return 'No run yet';
  })();

  const elapsedMs =
    runPhase === 'running' && runStartedAt !== null
      ? Math.max(0, now - runStartedAt)
      : null;

  return (
    <TelemetryPanel
      title="Results & telemetry"
      summary={summary}
      open={open}
      onOpenChange={onOpenChange}
      height={height}
      panelRef={panelRef}
      bodyId="image-results-body"
      ariaLabel="Results and telemetry"
      className="image-results"
    >
          {runPhase === 'running' ? (
            <div className="image-results__progress">
              <ProgressBar
                completed={progress?.completed ?? 0}
                total={progress?.total ?? 1}
                label={progress?.message ?? 'Preparing evaluation'}
              />
              <p className="image-results__note">
                {progress?.scenario
                  ? `Case: ${IMAGE_SCENARIO_LABELS[progress.scenario]}`
                  : 'Preparing the frozen graph and seed'}
                {elapsedMs === null
                  ? ''
                  : ` · running for ${Math.round(elapsedMs / 1000)} s`}
              </p>
              <p className="image-results__note">
                This run uses the graph and seed captured when you pressed Run. Progress
                follows real validation, capacity, workload and simulation boundaries. A
                stopped run publishes no partial result.
              </p>
            </div>
          ) : null}

          {runPhase === 'blocked' ? (
            <ReportSection
              title="Run blocked before evaluation"
              description="The graph is still editable. Fix these validation errors, then run again. Warnings and capacity pressure do not block a run."
            >
              <IssueList
                issues={runIssues}
                onFocusNode={focusNode}
                onFocusEdge={focusEdge}
              />
            </ReportSection>
          ) : null}

          {runPhase === 'error' ? (
            <div className="image-results__banner is-fail" role="alert">
              <XCircle size={22} aria-hidden="true" />
              <div>
                <p className="image-results__eyebrow">Run failed</p>
                <h2>No result</h2>
                <p>{runError ?? 'The engine reported an unknown error.'}</p>
              </div>
            </div>
          ) : null}

          {runPhase === 'stopped' ? (
            <div className="image-results__banner is-neutral" role="status">
              <AlertTriangle size={22} aria-hidden="true" />
              <div>
                <p className="image-results__eyebrow">Run stopped</p>
                <h2>No partial result</h2>
                <p>
                  The worker was terminated and its run id invalidated, so a late message
                  from the old run cannot pass as this one.
                </p>
              </div>
            </div>
          ) : null}

          {runPhase === 'idle' ? (
            <p className="image-results__empty">
              Run the qualification to see all seven cases, every gate, operation counts
              and sample counts, capacity, cost, memory and the physical link table.
              Validation issues are always visible in the graph and the Issues tab.
            </p>
          ) : null}

          {runPhase === 'completed' && result ? (
            <>
              <div
                className={`image-results__banner ${
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
                  <p className="image-results__eyebrow">
                    Evaluation · seed {result.meta.seed}
                  </p>
                  <h2>
                    {result.status === 'invalid'
                      ? 'Invalid graph'
                      : result.status === 'incomplete'
                        ? 'Incomplete evaluation'
                        : result.passed
                          ? 'Qualified'
                          : 'Not qualified'}
                  </h2>
                  <p>
                    {result.status === 'complete'
                      ? `${result.scenarios.length} of ${result.meta.requiredScenarios.length} required cases evaluated · model ${result.meta.modelVersion} · content ${result.meta.contentVersion} · pricing ${result.meta.pricingVersion}`
                      : result.status === 'incomplete'
                        ? result.incompleteReason.message
                        : 'No metrics are produced for an invalid document.'}
                  </p>
                </div>
              </div>

              {stale ? (
                <p className="image-results__stale" role="status">
                  This result belongs to an earlier semantic graph or seed. It stays
                  visible for reference, but canvas metrics and failure highlights are
                  hidden until you run again. Moving or renaming nodes alone does not make
                  it stale.
                </p>
              ) : null}

              {result.status === 'invalid' ? (
                <ReportSection title="Validation issues">
                  <IssueList
                    issues={result.issues}
                    onFocusNode={focusNode}
                    onFocusEdge={focusEdge}
                  />
                </ReportSection>
              ) : null}

              {result.status === 'incomplete' ? (
                <ReportSection
                  title="Incomplete reason"
                  description={`${result.incompleteReason.code}: ${result.incompleteReason.message}`}
                >
                  <IssueList
                    issues={result.issues}
                    onFocusNode={focusNode}
                    onFocusEdge={focusEdge}
                  />
                </ReportSection>
              ) : null}

              {result.status === 'complete' ? (
                <>
                  <div
                    className="image-scenario-tabs"
                    role="tablist"
                    aria-label="Qualification case"
                  >
                    {result.scenarios.map((item) => (
                      <button
                        type="button"
                        role="tab"
                        key={item.name}
                        aria-selected={scenario?.name === item.name}
                        className={scenario?.name === item.name ? 'is-active' : ''}
                        onClick={() => setSelectedScenario(item.name)}
                      >
                        {IMAGE_SCENARIO_LABELS[item.name]} ·{' '}
                        {item.passed ? 'pass' : 'fail'}
                      </button>
                    ))}
                  </div>
                  <div className="image-result-versions">
                    <span>
                      All {result.meta.requiredScenarios.length} required cases,
                      including a separate outage of each region, must pass at this seed.
                    </span>
                    <span>
                      {result.meta.qualification
                        ? 'Full qualification run.'
                        : 'Exploratory subset — cannot qualify.'}
                    </span>
                  </div>
                  {scenario ? (
                    <ScenarioDetail
                      scenario={scenario}
                      cost={result.cost}
                      capacity={result.capacity}
                      onFocusNode={focusNode}
                      onFocusEdge={focusEdge}
                    />
                  ) : null}
                </>
              ) : null}

              <details className="image-results__details">
                <summary>Model details and assumptions</summary>
                <p className="image-results__note">
                  Schema {result.meta.schemaVersion} · model {result.meta.modelVersion} ·
                  content {result.meta.contentVersion} · pricing{' '}
                  {result.meta.pricingVersion} · level {result.meta.levelId} · graph{' '}
                  {result.meta.graphDigest ?? 'none'} · dataset day{' '}
                  {result.meta.datasetDay}
                </p>
                <ul className="image-results__notes">
                  {result.assumptions.map((assumption) => (
                    <li key={assumption}>{assumption}</li>
                  ))}
                </ul>
              </details>
            </>
          ) : null}
    </TelemetryPanel>
  );
}
