import { RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { PARCEL_CATALOG } from '../catalog';
import {
  PARCEL_COMPRESSIONS,
  PARCEL_PARTITIONS,
  PARCEL_SQL_INDEXES,
  type ParcelCheck,
  type ParcelDiagnostic,
  type ParcelEvaluation,
  type ParcelGraph,
  type ParcelIssue,
  type ParcelNode,
  type ParcelNodeConfig,
  type ParcelNodeSize,
  type ParcelOperation,
} from '../contracts';
import { Button } from '../../ui/Button';
import { NumberField } from '../../ui/NumberField';
import { StatusPill } from '../../ui/StatusPill';
import { TextField } from '../../ui/TextField';
import { formatDecimal, formatInteger } from '../../ui/format';
import { validateParcelGraph } from '../graph';
import {
  parcelProblemsForNode,
  parcelResultStale,
  parcelRouteTarget,
  uniqueParcelIssues,
} from './parcel-diagnostics';
import {
  formatDataSize,
  formatFractionPercent,
  formatHorizon,
  formatMilliseconds,
  formatSuccessfulMilliseconds,
} from './parcel-format';
import { PARCEL_NODE_KIND_LABELS, PARCEL_OPERATION_META } from './parcel-meta';
import { useParcelStore, type ParcelSelection } from './parcel-store';

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function configuredMonthlyUsd(node: ParcelNode): number {
  const hardware = PARCEL_CATALOG.hardware[node.config.size];
  const storage =
    (node.config.storageTb ?? 0) * PARCEL_CATALOG.storage.priceUsdPerTbMonth;
  return (
    hardware.hourlyUsd * PARCEL_CATALOG.storage.billingHoursPerMonth + storage
  );
}

function SizeSelect({
  node,
  locked,
  onError,
}: {
  node: ParcelNode;
  locked: boolean;
  onError: (message: string | null) => void;
}) {
  const update = useParcelStore((state) => state.updateNodeConfig);
  const allowed = PARCEL_CATALOG.nodes[node.kind].allowedSizes;
  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={`parcel-size-${node.id}`}>
        Size
      </label>
      <select
        id={`parcel-size-${node.id}`}
        className="ui-input"
        value={node.config.size}
        disabled={locked}
        onChange={(event) => {
          const result = update(node.id, {
            size: event.target.value as ParcelNodeSize,
          });
          onError(result.ok ? null : (result.message ?? null));
        }}
      >
        {allowed.map((size) => {
          const hardware = PARCEL_CATALOG.hardware[size];
          return (
            <option value={size} key={size}>
              {capitalize(size)} · {hardware.cpuCores} CPU · $
              {formatDecimal(hardware.hourlyUsd, 3)}/h
            </option>
          );
        })}
      </select>
      <p className="ui-field__hint">
        CPU, IO lanes and network scale with size. A larger size costs more every
        month but reduces queueing when the same operations share the node.
      </p>
    </div>
  );
}

function BooleanField({
  id,
  label,
  checked,
  hint,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  hint: string;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="parcel-check" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {label}
        <small>{hint}</small>
      </span>
    </label>
  );
}

function NodeMetricsBlock({
  node,
  evaluation,
  horizonYears,
  stale,
}: {
  node: ParcelNode;
  evaluation: ParcelEvaluation | null;
  horizonYears: 1 | 5;
  stale: boolean;
}) {
  if (!evaluation || evaluation.status !== 'ok') {
    return null;
  }
  if (stale) {
    return (
      <section className="parcel-inspector__section">
        <h3>Run metrics</h3>
        <p className="parcel-inspector__note">
          Previous result hidden — the semantic graph or seed changed. Run again to
          see metrics for this node.
        </p>
      </section>
    );
  }
  const horizon = evaluation.horizons.find(
    (item) => item.horizonYears === horizonYears,
  );
  const metrics = horizon?.nodes.find((item) => item.nodeId === node.id);
  if (!horizon || !metrics) {
    return null;
  }
  const operations = Object.entries(metrics.operations) as Array<
    [ParcelOperation, NonNullable<(typeof metrics.operations)[ParcelOperation]>]
  >;
  return (
    <section className="parcel-inspector__section">
      <h3>
        {formatHorizon(horizonYears)} run metrics{' '}
        <span className="parcel-inspector__small">(measured 60 s window)</span>
      </h3>
      <dl className="parcel-inspector__metrics">
        <div>
          <dt>CPU average / peak</dt>
          <dd>
            {formatFractionPercent(metrics.averageCpuUtilization)} /{' '}
            {formatFractionPercent(metrics.peakCpuUtilization)}
          </dd>
        </div>
        <div>
          <dt>IO average / peak</dt>
          <dd>
            {formatFractionPercent(metrics.averageIoUtilization)} /{' '}
            {formatFractionPercent(metrics.peakIoUtilization)}
          </dd>
        </div>
        <div>
          <dt>Network average / peak</dt>
          <dd>
            {formatFractionPercent(metrics.averageNetworkUtilization)} /{' '}
            {formatFractionPercent(metrics.peakNetworkUtilization)}
          </dd>
        </div>
        <div>
          <dt>Queue average / peak</dt>
          <dd>
            {formatDecimal(metrics.averageQueueDepth, 1)} /{' '}
            {formatInteger(metrics.peakQueueDepth)}
          </dd>
        </div>
        <div>
          <dt>Queue wait p95</dt>
          <dd>{formatMilliseconds(metrics.queueWaitP95Ms)}</dd>
        </div>
        <div>
          <dt>Requests / errors / timeouts</dt>
          <dd>
            {formatInteger(metrics.requests)} / {formatInteger(metrics.errors)} /{' '}
            {formatInteger(metrics.timedOut)}
          </dd>
        </div>
        <div>
          <dt>Bytes read / written</dt>
          <dd>
            {formatDataSize(metrics.bytesRead)} /{' '}
            {formatDataSize(metrics.bytesWritten)}
          </dd>
        </div>
      </dl>
      {operations.length > 0 ? (
        <div className="parcel-inspector__table-wrap">
          <table className="parcel-inspector__table">
            <thead>
              <tr>
                <th scope="col">Operation</th>
                <th scope="col">Requests</th>
                <th scope="col">Completed</th>
                <th scope="col">p95</th>
              </tr>
            </thead>
            <tbody>
              {operations.map(([operation, item]) => (
                <tr key={operation}>
                  <th scope="row">{PARCEL_OPERATION_META[operation].label}</th>
                  <td>{formatInteger(item.requests)}</td>
                  <td>{formatInteger(item.completed)}</td>
                  <td>
                    {formatSuccessfulMilliseconds(item.p95Ms, item.completed)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="parcel-inspector__note">
        Colored blocks on the canvas use the time-weighted average. Peak is shown
        separately; peak alone does not say how long a node was under load.
      </p>
    </section>
  );
}

function NodeInspector({
  node,
  graph,
  locked,
  evaluation,
  horizonYears,
  stale,
}: {
  node: ParcelNode;
  graph: ParcelGraph;
  locked: boolean;
  evaluation: ParcelEvaluation | null;
  horizonYears: 1 | 5;
  stale: boolean;
}) {
  const update = useParcelStore((state) => state.updateNodeConfig);
  const updateLabel = useParcelStore((state) => state.updateNodeLabel);
  const reset = useParcelStore((state) => state.resetNodeConfig);
  const remove = useParcelStore((state) => state.removeNode);
  const [message, setMessage] = useState<string | null>(null);
  const store = node.kind === 'sql' || node.kind === 'kv' || node.kind === 'columnar';
  const latestStatus = node.kind === 'sql' || node.kind === 'kv';
  const deletable =
    store ||
    ((node.kind === 'client' || node.kind === 'app') &&
      graph.nodes.filter((item) => item.kind === node.kind).length > 1);
  const issues = validateParcelGraph(graph, { mode: 'edit' });
  const problems = parcelProblemsForNode(
    node.id,
    {
      issues,
      diagnostics: [],
      checks: [],
    },
    graph,
  );
  const patch = (change: Partial<ParcelNodeConfig>) => {
    const result = update(node.id, change);
    setMessage(result.ok ? null : (result.message ?? null));
  };

  return (
    <div className="parcel-inspector">
      <header className="parcel-inspector__head">
        <div>
          <p className="parcel-inspector__eyebrow">
            {PARCEL_NODE_KIND_LABELS[node.kind]}
          </p>
          <h2>{node.label}</h2>
        </div>
        <StatusPill tone="accent">
          ${formatDecimal(configuredMonthlyUsd(node), 2)}/mo configured
        </StatusPill>
      </header>

      <TextField
        label="Name"
        value={node.label}
        maxLength={80}
        disabled={locked}
        onCommit={(label) => {
          const result = updateLabel(node.id, label);
          setMessage(result.ok ? null : (result.message ?? null));
        }}
      />

      {node.kind !== 'client' ? (
        <SizeSelect node={node} locked={locked} onError={setMessage} />
      ) : (
        <p className="parcel-inspector__note">
          The client is a fixed traffic source. It sends exactly one traffic route
          to the application and has no capacity settings.
        </p>
      )}

      {store ? (
        <>
          <NumberField
            label="Provisioned storage"
            value={node.config.storageTb ?? 1}
            min={1}
            max={256}
            unit="TB"
            hint="Charged every month and fixed for the five-year TCO. Used bytes are estimated from the retained dataset, indexes, latest status and rollups."
            disabled={locked}
            onCommit={(value) => patch({ storageTb: value })}
          />
          <div className="ui-field">
            <label
              className="ui-field__label"
              htmlFor={`parcel-retention-${node.id}`}
            >
              Retention
            </label>
            <select
              id={`parcel-retention-${node.id}`}
              className="ui-input"
              value={node.config.retentionYears ?? 1}
              disabled={locked}
              onChange={(event) =>
                patch({ retentionYears: Number(event.target.value) })
              }
            >
              {[1, 2, 3, 4, 5].map((years) => (
                <option value={years} key={years}>
                  {years} {years === 1 ? 'year' : 'years'}
                </option>
              ))}
            </select>
            <p className="ui-field__hint">
              Raw event history kept by this store. The year-5 horizon requires a
              primary and history store with 5 years, otherwise old-parcel history
              cannot be served.
            </p>
          </div>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor={`parcel-partition-${node.id}`}>
              Partitions
            </label>
            <select
              id={`parcel-partition-${node.id}`}
              className="ui-input"
              value={node.config.partition ?? 'none'}
              disabled={locked}
              onChange={(event) =>
                patch({ partition: event.target.value as 'none' | 'month' })
              }
            >
              {PARCEL_PARTITIONS.map((partition) => (
                <option value={partition} key={partition}>
                  {partition === 'none' ? 'No partitions' : 'Monthly partitions'}
                </option>
              ))}
            </select>
            <p className="ui-field__hint">
              Monthly partitions let report reads skip irrelevant months. They add
              metadata, not a free speed-up of point history reads.
            </p>
          </div>
          {node.kind === 'sql' ? (
            <div className="ui-field">
              <label className="ui-field__label" htmlFor={`parcel-index-${node.id}`}>
                SQL index
              </label>
              <select
                id={`parcel-index-${node.id}`}
                className="ui-input"
                value={node.config.index ?? 'none'}
                disabled={locked}
                onChange={(event) =>
                  patch({
                    index: event.target.value as 'none' | 'parcel' | 'parcel-warehouse',
                  })
                }
              >
                {PARCEL_SQL_INDEXES.map((index) => (
                  <option value={index} key={index}>
                    {index === 'none'
                      ? 'No index — scans retained rows'
                      : index === 'parcel'
                        ? 'Parcel index — fast history lookups'
                        : 'Parcel-warehouse index — bounded reports'}
                  </option>
                ))}
              </select>
              <p className="ui-field__hint">
                The parcel index turns history into key lookups. The
                parcel-warehouse index keeps report scans bounded, but costs storage
                and extra write work.
              </p>
            </div>
          ) : null}
          {latestStatus ? (
            <BooleanField
              id={`parcel-latest-${node.id}`}
              label="Maintain latest status"
              checked={node.config.latestStatus === true}
              hint="Keeps a current-status row per parcel. Status lookups are fast, but every ingest pays extra write CPU and storage."
              disabled={locked}
              onChange={(checked) => patch({ latestStatus: checked })}
            />
          ) : null}
          <BooleanField
            id={`parcel-rollups-${node.id}`}
            label="Maintain warehouse rollups"
            checked={node.config.rollups === true}
            hint="Hourly per-warehouse aggregates make reports cheap. They add write amplification and stored rows."
            disabled={locked}
            onChange={(checked) => patch({ rollups: checked })}
          />
          <div className="ui-field">
            <label
              className="ui-field__label"
              htmlFor={`parcel-compression-${node.id}`}
            >
              Compression
            </label>
            <select
              id={`parcel-compression-${node.id}`}
              className="ui-input"
              value={node.config.compression ?? 'none'}
              disabled={locked}
              onChange={(event) =>
                patch({
                  compression: event.target.value as 'none' | 'lz4' | 'zstd',
                })
              }
            >
              {PARCEL_COMPRESSIONS.map((compression) => (
                <option value={compression} key={compression}>
                  {capitalize(compression)}
                </option>
              ))}
            </select>
            <p className="ui-field__hint">
              Compression saves storage and read/write bytes, but costs CPU on both
              writes and reads. It is not a free multiplier.
            </p>
          </div>
          {node.kind === 'columnar' ? (
            <>
              <NumberField
                label="Projection batch interval"
                value={node.config.batchIntervalMs ?? 0}
                min={0}
                max={5000}
                unit="ms"
                hint="How long the analytics projection waits before flushing. A larger interval saves CPU but increases report freshness lag."
                disabled={locked}
                onCommit={(value) => patch({ batchIntervalMs: value })}
              />
              <BooleanField
                id={`parcel-projection-${node.id}`}
                label="Narrow analytics projection"
                checked={node.config.columnProjection === true}
                hint="Store only the analytics columns instead of every event field. This saves bytes but cannot serve full parcel history."
                disabled={locked}
                onChange={(checked) => patch({ columnProjection: checked })}
              />
            </>
          ) : null}
        </>
      ) : null}

      {node.kind === 'app' ? (
        <p className="parcel-inspector__note">
          The application owns one route for each business operation. Scaling it
          changes CPU capacity for every route; it does not change demand.
        </p>
      ) : null}

      {problems.messages.length > 0 ? (
        <section className="parcel-inspector__section">
          <h3>Current issues for this node</h3>
          <ul className="parcel-inspector__issues">
            {problems.messages.map((item) => (
              <li
                key={item}
                className={`parcel-inspector__issue parcel-inspector__issue--${problems.severity}`}
              >
                {item}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <NodeMetricsBlock
        node={node}
        evaluation={evaluation}
        horizonYears={horizonYears}
        stale={stale}
      />

      <div className="parcel-inspector__actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<RotateCcw size={15} />}
          disabled={locked}
          onClick={() => {
            const result = reset(node.id);
            setMessage(result.ok ? 'Settings reset to catalog defaults.' : result.message ?? null);
          }}
        >
          Reset settings
        </Button>
        {deletable ? (
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 size={15} />}
            disabled={locked}
            onClick={() => {
              const result = remove(node.id);
              setMessage(result.ok ? null : (result.message ?? null));
            }}
          >
            Delete node
          </Button>
        ) : null}
      </div>
      {message ? (
        <p className="parcel-inspector__message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function EdgeInspector({
  edgeId,
  graph,
  locked,
}: {
  edgeId: string;
  graph: ParcelGraph;
  locked: boolean;
}) {
  const edge = graph.edges.find((item) => item.id === edgeId);
  const update = useParcelStore((state) => state.updateEdgeOperation);
  const remove = useParcelStore((state) => state.removeEdge);
  const [message, setMessage] = useState<string | null>(null);
  if (!edge) {
    return null;
  }
  const source = graph.nodes.find((node) => node.id === edge.source);
  const target = graph.nodes.find((node) => node.id === edge.target);
  const issues = validateParcelGraph(graph, { mode: 'edit' }).filter(
    (issue) => issue.edgeId === edge.id,
  );
  return (
    <div className="parcel-inspector">
      <header className="parcel-inspector__head">
        <div>
          <p className="parcel-inspector__eyebrow">Route</p>
          <h2>
            {source?.label ?? edge.source} → {target?.label ?? edge.target}
          </h2>
        </div>
        <StatusPill tone="neutral">{PARCEL_OPERATION_META[edge.operation].label}</StatusPill>
      </header>
      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`parcel-edge-operation-${edge.id}`}>
          Operation
        </label>
        <select
          id={`parcel-edge-operation-${edge.id}`}
          className="ui-input"
          value={edge.operation}
          disabled={locked}
          onChange={(event) => {
            const result = update(edge.id, event.target.value as ParcelOperation);
            setMessage(result.ok ? null : (result.message ?? null));
          }}
        >
          {(Object.keys(PARCEL_OPERATION_META) as ParcelOperation[]).map(
            (operation) => (
              <option value={operation} key={operation}>
                {PARCEL_OPERATION_META[operation].label}
              </option>
            ),
          )}
        </select>
        <p className="ui-field__hint">
          {PARCEL_OPERATION_META[edge.operation].description}
        </p>
      </div>
      <p className="parcel-inspector__note">
        Changing an operation changes semantics and marks an old result stale.
        Position-only changes and labels do not.
      </p>
      {issues.length > 0 ? (
        <ul className="parcel-inspector__issues">
          {issues.map((issue, index) => (
            <li
              className={`parcel-inspector__issue parcel-inspector__issue--${issue.severity}`}
              key={`${issue.code}-${index}`}
            >
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="parcel-inspector__actions">
        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 size={15} />}
          disabled={locked}
          onClick={() => {
            const result = remove(edge.id);
            setMessage(result.ok ? null : result.message ?? null);
          }}
        >
          Delete route
        </Button>
      </div>
      {message ? (
        <p className="parcel-inspector__message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function issueTargetId(
  graph: ParcelGraph,
  issue: ParcelIssue,
  evaluation: ParcelEvaluation | null,
): ParcelSelection {
  if (issue.nodeId) {
    return { type: 'node', id: issue.nodeId };
  }
  if (issue.edgeId) {
    return { type: 'edge', id: issue.edgeId };
  }
  if (issue.horizonYears && evaluation) {
    const target = graph.nodes.find((node) => node.kind === 'app');
    if (target) {
      return { type: 'node', id: target.id };
    }
  }
  return null;
}

function checkSelection(graph: ParcelGraph, check: ParcelCheck): ParcelSelection {
  if (check.nodeId) {
    return { type: 'node', id: check.nodeId };
  }
  if (check.operation) {
    const target = parcelRouteTarget(graph, check.operation);
    if (target) {
      return { type: 'node', id: target };
    }
  }
  return null;
}

function diagnosticSelection(
  graph: ParcelGraph,
  diagnostic: ParcelDiagnostic,
): ParcelSelection {
  if (diagnostic.nodeId) {
    return { type: 'node', id: diagnostic.nodeId };
  }
  if (diagnostic.edgeId) {
    return { type: 'edge', id: diagnostic.edgeId };
  }
  if (diagnostic.operation) {
    const target = parcelRouteTarget(graph, diagnostic.operation);
    if (target) {
      return { type: 'node', id: target };
    }
  }
  return null;
}

function IssuesList({
  graph,
  evaluation,
  stale,
}: {
  graph: ParcelGraph;
  evaluation: ParcelEvaluation | null;
  stale: boolean;
}) {
  const select = useParcelStore((state) => state.select);
  const currentIssues = uniqueParcelIssues(
    validateParcelGraph(graph, { mode: 'edit' }),
  );
  const failedChecks =
    evaluation && !stale
      ? evaluation.checks.filter((check) => !check.passed)
      : [];
  const diagnostics =
    evaluation && !stale ? evaluation.diagnostics : [];
  const total = currentIssues.length + failedChecks.length + diagnostics.length;
  return (
    <div className="parcel-inspector">
      <header className="parcel-inspector__head">
        <div>
          <p className="parcel-inspector__eyebrow">Diagnostics</p>
          <h2>Issues</h2>
        </div>
        <StatusPill tone={total > 0 ? 'warning' : 'success'}>
          {total} open
        </StatusPill>
      </header>
      <p className="parcel-inspector__note">
        Validation issues block a run only when they are errors. Failed checks and
        engine diagnostics come from the last completed run.
      </p>
      {currentIssues.length === 0 && failedChecks.length === 0 && diagnostics.length === 0 ? (
        <p className="parcel-inspector__empty">
          No current validation, check or diagnostic issues.
        </p>
      ) : null}
      {currentIssues.length > 0 ? (
        <section className="parcel-inspector__section">
          <h3>Validation</h3>
          <ul className="parcel-inspector__issues">
            {currentIssues.map((issue, index) => {
              const selection = issueTargetId(graph, issue, evaluation);
              return (
                <li
                  key={`${issue.code}-${index}`}
                  className={`parcel-inspector__issue parcel-inspector__issue--${issue.severity}`}
                >
                  <span>{issue.message}</span>
                  {selection ? (
                    <button type="button" onClick={() => select(selection)}>
                      Show
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {failedChecks.length > 0 ? (
        <section className="parcel-inspector__section">
          <h3>Failed checks</h3>
          <ul className="parcel-inspector__issues">
            {failedChecks.map((check) => {
              const selection = checkSelection(graph, check);
              return (
                <li
                  key={`${check.id}-${check.horizonYears ?? ''}-${check.operation ?? ''}`}
                  className={`parcel-inspector__issue parcel-inspector__issue--${
                    check.severity === 'required' ? 'error' : 'warning'
                  }`}
                >
                  <span>
                    {check.label}: {check.message}
                  </span>
                  {selection ? (
                    <button type="button" onClick={() => select(selection)}>
                      Focus
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {diagnostics.length > 0 ? (
        <section className="parcel-inspector__section">
          <h3>Engine diagnostics</h3>
          <ul className="parcel-inspector__issues">
            {diagnostics.map((diagnostic) => {
              const selection = diagnosticSelection(graph, diagnostic);
              return (
                <li
                  key={diagnostic.id}
                  className={`parcel-inspector__issue parcel-inspector__issue--${diagnostic.severity}`}
                >
                  <span>{diagnostic.message}</span>
                  {selection ? (
                    <button type="button" onClick={() => select(selection)}>
                      Focus
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {currentIssues.length === 0 && evaluation?.status === 'invalid' ? (
        <p className="parcel-inspector__note">
          The engine rejected the document before evaluation.
        </p>
      ) : null}
    </div>
  );
}

export function ParcelInspector({
  tab,
  setTab,
}: {
  tab: 'properties' | 'issues';
  setTab: (tab: 'properties' | 'issues') => void;
}) {
  const graph = useParcelStore((state) => state.graph);
  const selection = useParcelStore((state) => state.selection);
  const result = useParcelStore((state) => state.result);
  const resultDigest = useParcelStore((state) => state.resultDigest);
  const resultSeed = useParcelStore((state) => state.resultSeed);
  const seed = useParcelStore((state) => state.seed);
  const selectedHorizon = useParcelStore((state) => state.selectedHorizon);
  const runPhase = useParcelStore((state) => state.runPhase);
  const locked = runPhase === 'running' || runPhase === 'stopping';
  const stale = parcelResultStale(result, resultDigest, resultSeed, graph, seed);
  const selectedNode =
    selection?.type === 'node'
      ? graph.nodes.find((node) => node.id === selection.id) ?? null
      : null;

  return (
    <div className="parcel-inspector-shell">
      <div className="parcel-inspector-tabs" role="tablist" aria-label="Inspector">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'properties'}
          className={tab === 'properties' ? 'is-active' : ''}
          onClick={() => setTab('properties')}
        >
          Properties
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'issues'}
          className={tab === 'issues' ? 'is-active' : ''}
          onClick={() => setTab('issues')}
        >
          Issues
        </button>
      </div>
      <div className="parcel-inspector-scroll">
        {tab === 'issues' ? (
          <IssuesList
            graph={graph}
            evaluation={result}
            stale={stale}
          />
        ) : selectedNode ? (
          <NodeInspector
            node={selectedNode}
            graph={graph}
            locked={locked}
            evaluation={result}
            horizonYears={selectedHorizon}
            stale={stale}
          />
        ) : selection?.type === 'edge' ? (
          <EdgeInspector edgeId={selection.id} graph={graph} locked={locked} />
        ) : (
          <div className="parcel-inspector parcel-inspector--empty">
            <h2>Inspector</h2>
            <p>
              Select a node or route. Node settings explain their storage, CPU and
              freshness consequences; route settings show the operation and its
              rules.
            </p>
            <p>
              A route is an operation on an edge. Parallel routes are labelled and
              curved so ingest, status, history and reports on the same pair remain
              distinguishable.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
