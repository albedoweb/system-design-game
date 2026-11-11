import { RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  CATALOG,
  MAX_LABEL_LENGTH,
  MAX_POOL_SIZE,
  MAX_QUEUE_LIMIT,
  MAX_TTL_SECONDS,
  MIN_POOL_SIZE,
  MIN_QUEUE_LIMIT,
  MIN_TTL_SECONDS,
  NODE_KIND_LABELS,
  NODE_SIZE_LABELS,
  NODE_SIZES,
  getCacheCapacityKiB,
  getCapacity,
  getSizeSpec,
  type Diagnostic,
  type GraphEdge,
  type GraphNode,
  type NodeMetric,
  type NodeSize,
} from '../../domain';
import { useEditorStore } from '../../state/editor-store';
import { Button } from '../../ui/Button';
import { NumberField } from '../../ui/NumberField';
import { StatusPill } from '../../ui/StatusPill';
import { TextField } from '../../ui/TextField';
import {
  DASH,
  formatBytes,
  formatDecimal,
  formatDuration,
  formatInteger,
  formatMicroUsd,
  formatMoney,
  formatTime,
} from '../../ui/format';
import type { RunEvidenceMode } from '../simulation/run-evidence';
import { PORT_LABELS } from '../editor/canvas-model';
import './inspector.css';

function FailureTable({
  failures,
}: {
  failures: ReadonlyArray<{ code: string; stage: string; count: number }>;
}) {
  return (
    <div className="inspector__table-wrap">
      <table className="inspector__table">
        <thead>
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">Code</th>
            <th scope="col">Requests</th>
          </tr>
        </thead>
        <tbody>
          {failures.map((failure) => (
            <tr key={`${failure.stage}-${failure.code}`}>
              <td>{failure.stage}</td>
              <td>{failure.code}</td>
              <td>{formatInteger(failure.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetricsBlock({
  kind,
  node,
  metrics,
  mode,
  stale,
  snapshotTimeMs,
  diagnostics,
}: {
  kind: GraphNode['kind'];
  node: GraphNode;
  metrics: NodeMetric | null;
  mode: RunEvidenceMode;
  stale: boolean;
  snapshotTimeMs?: number | null;
  diagnostics: readonly Diagnostic[];
}) {
  const capacity = getCapacity(kind, node.config.size);
  const poolSize = node.config.poolSize;
  const boundedSlots = kind === 'appServer' || kind === 'database';
  const boundedPool = kind === 'appServer' || kind === 'cache';
  const pressure = metrics?.pressure;
  const peak = mode === 'peak';
  const stopped = mode === 'stopped';
  const showEvidence = !stale && diagnostics.length > 0;

  return (
    <>
      <section className="inspector__section">
        <h3>
          {peak
            ? 'Peak during run'
            : stopped
              ? 'Stopped snapshot'
              : 'Current metrics'}
        </h3>
        {stale ? (
          <p className="inspector__note">
            Previous run — the graph, settings, or seed changed. Current
            metrics and failure highlights are hidden until you run again.
          </p>
        ) : metrics === null ? (
          <p className="inspector__note">
            No data: run the simulation to see utilization, queue, and pool
            state.
          </p>
        ) : (
          <>
            <dl className="inspector__metrics">
              {boundedSlots ? (
                <div>
                  <dt>
                    {peak ? 'Slots peak' : stopped ? 'Slots at stop' : 'Busy'}
                  </dt>
                  <dd>
                    {peak
                      ? pressure
                        ? `${formatInteger(pressure.busyPeak)} / ${capacity ?? DASH}`
                        : `${DASH} / ${capacity ?? DASH}`
                      : `${formatInteger(metrics.busy)} / ${capacity ?? DASH}`}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>
                  {peak ? 'Queue peak' : stopped ? 'Queue at stop' : 'Queue'}
                </dt>
                <dd>
                  {peak
                    ? formatInteger(metrics.maxQueued)
                    : `${formatInteger(metrics.queued)} · max ${formatInteger(metrics.maxQueued)}`}
                </dd>
              </div>
              {boundedPool ? (
                <div>
                  <dt>
                    {peak ? 'Pool peak' : stopped ? 'Pool at stop' : 'Pool busy'}
                  </dt>
                  <dd>
                    {peak
                      ? pressure
                        ? `${formatInteger(pressure.poolBusyPeak)} / ${formatInteger(poolSize)}`
                        : `${DASH} / ${formatInteger(poolSize)}`
                      : `${formatInteger(metrics.poolBusy)} / ${formatInteger(poolSize)}`}
                  </dd>
                </div>
              ) : null}
              {boundedPool ? (
                <div>
                  <dt>
                    {peak
                      ? 'Pool wait peak'
                      : stopped
                        ? 'Pool wait at stop'
                        : 'Pool wait'}
                  </dt>
                  <dd>
                    {peak
                      ? pressure
                        ? formatInteger(pressure.poolQueuedPeak)
                        : DASH
                      : formatInteger(metrics.poolQueued)}
                  </dd>
                </div>
              ) : null}
              {kind === 'cache' ? (
                <div>
                  <dt>Hits / misses</dt>
                  <dd>
                    {formatInteger(metrics.hits)} / {formatInteger(metrics.misses)} ·
                    coalesced {formatInteger(metrics.coalesced)}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>Errors</dt>
                <dd>{formatInteger(metrics.errors)}</dd>
              </div>
              <div>
                <dt>Completed</dt>
                <dd>{formatInteger(metrics.completed)}</dd>
              </div>
            </dl>
            {stopped ? (
              <p className="inspector__note">
                Last snapshot captured at{' '}
                {formatTime(snapshotTimeMs ?? null)} before Stop. This is not a
                live reading or a completed evaluation, so no pass/fail verdict
                is produced.
              </p>
            ) : null}
            {peak && pressure ? (
              <p className="inspector__note">
                Observed {formatDuration(pressure.observedMs)}. Time-weighted
                averages:{' '}
                {boundedSlots
                  ? `slots ${formatDecimal(pressure.busyAvg, 1)} / ${capacity ?? DASH}`
                  : null}
                {boundedSlots && boundedPool ? ' · ' : null}
                {boundedPool
                  ? `pool ${formatDecimal(pressure.poolBusyAvg, 1)} / ${poolSize}`
                  : null}
                . Peaks are retained evidence from the completed run, not the
                drained instant.
              </p>
            ) : null}
            {peak && !pressure ? (
              <p className="inspector__note">
                This engine build does not report peak occupancy. Queue peak and
                cumulative counters remain available; peak and failure-location
                evidence appears when the engine supplies it.
              </p>
            ) : null}
          </>
        )}
      </section>

      {stopped && pressure ? (
        <section className="inspector__section">
          <h3>Pressure observed so far</h3>
          <dl className="inspector__metrics">
            <div>
              <dt>Observed</dt>
              <dd>{formatDuration(pressure.observedMs)}</dd>
            </div>
            {boundedSlots ? (
              <div>
                <dt>Slots peak (avg)</dt>
                <dd>
                  {formatInteger(pressure.busyPeak)} (avg{' '}
                  {formatDecimal(pressure.busyAvg, 1)})
                </dd>
              </div>
            ) : null}
            {boundedPool ? (
              <div>
                <dt>Pool peak (avg)</dt>
                <dd>
                  {formatInteger(pressure.poolBusyPeak)} (avg{' '}
                  {formatDecimal(pressure.poolBusyAvg, 1)})
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Queue peak</dt>
              <dd>{formatInteger(metrics?.maxQueued ?? null)}</dd>
            </div>
            {boundedPool ? (
              <div>
                <dt>Pool wait peak</dt>
                <dd>{formatInteger(pressure.poolQueuedPeak)}</dd>
              </div>
            ) : null}
          </dl>
          <p className="inspector__note">
            Captured until Stop — partial evidence only, not a completed run or
            proof of root cause.
          </p>
        </section>
      ) : null}

      {(peak || stopped) &&
      pressure &&
      pressure.failures.length > 0 &&
      !stale ? (
        <section className="inspector__section">
          <h3>
            {stopped
              ? 'Failure locations observed so far'
              : 'Failure locations'}
          </h3>
          <FailureTable failures={pressure.failures} />
          <p className="inspector__note">
            Each row is where a request was rejected or reached its deadline.
            This location is evidence, not proof of root cause
            {stopped ? '; it covers only the stopped portion of the run' : ''}.
          </p>
        </section>
      ) : null}

      {showEvidence ? (
        <section className="inspector__section">
          <h3>Node diagnostics</h3>
          <ul className="inspector__diagnostics">
            {diagnostics.map((diagnostic, index) => (
              <li
                key={`${diagnostic.severity}-${index}`}
                className={`inspector__diagnostic inspector__diagnostic--${diagnostic.severity}`}
              >
                <strong>
                  {diagnostic.severity === 'error' ? 'Error' : 'Warning'}
                </strong>
                {diagnostic.message}
              </li>
            ))}
          </ul>
          <p className="inspector__note">
            Observed pressure alone is not treated as an error; these messages
            come from the engine result.
          </p>
        </section>
      ) : null}
    </>
  );
}

function resourceMeaning(node: GraphNode): string | null {
  switch (node.kind) {
    case 'appServer':
      return 'Slots are concurrent requests. Pool waiters are requests waiting for a read or write connection; the admission queue is waiting for a slot. The database queue is counted separately on the database node.';
    case 'database':
      return 'Slots are operations executing now; the database queue holds operations waiting for a slot. Requests waiting on an app-side dependency connection are counted as pool waiters on the app node, not here.';
    case 'cache':
      return 'The backend pool bounds simultaneous cache misses filling from the database; pool waiters are waiting for a fill. Cache entries show capacity, not load, and hits/misses describe efficiency.';
    case 'loadBalancer':
    case 'client':
      return null;
  }
}

function applicability(kind: GraphNode['kind']) {
  return {
    size: kind === 'appServer' || kind === 'database' || kind === 'cache',
    queue: kind === 'appServer' || kind === 'database' || kind === 'cache',
    pool: kind === 'appServer' || kind === 'cache',
    cache: kind === 'cache',
  };
}

function capacityMeaning(node: GraphNode): string {
  const capacity = getCapacity(node.kind, node.config.size);
  switch (node.kind) {
    case 'appServer':
      return `${capacity} concurrent requests. The queue is counted separately; CPU has no separate queue in this model.`;
    case 'database':
      return `${capacity} operations running at the same time. This is also the concurrency limit; there is no hidden maxConnections.`;
    case 'cache':
      return `${capacity} entries · ${formatBytes(getCacheCapacityKiB(node.config.size))}. TTL and LRU control lifetime and eviction.`;
    case 'loadBalancer':
      return `${CATALOG.loadBalancer.description} Capacity is not bounded.`;
    case 'client':
      return `${CATALOG.client.description} Capacity and pool are not configurable.`;
  }
}

export function NodeInspector({
  node,
  metrics,
  mode,
  stale,
  snapshotTimeMs,
  diagnostics,
  locked,
  totalCostUsd,
}: {
  node: GraphNode;
  metrics: NodeMetric | null;
  mode: RunEvidenceMode;
  stale: boolean;
  snapshotTimeMs?: number | null;
  diagnostics: readonly Diagnostic[];
  locked: boolean;
  totalCostUsd: number;
}) {
  const updateNodeConfig = useEditorStore((state) => state.updateNodeConfig);
  const updateNodeLabel = useEditorStore((state) => state.updateNodeLabel);
  const removeNode = useEditorStore((state) => state.removeNode);
  const resetNode = useEditorStore((state) => state.resetNode);
  const [message, setMessage] = useState<string | null>(null);
  const applies = applicability(node.kind);
  const spec = getSizeSpec(node.kind, node.config.size);
  const deletable =
    node.kind === 'appServer' || node.kind === 'cache' || node.kind === 'loadBalancer';

  return (
    <div className="inspector">
      <header className="inspector__head">
        <div>
          <p className="inspector__eyebrow">{NODE_KIND_LABELS[node.kind]}</p>
          <h2>{node.label}</h2>
        </div>
        <StatusPill tone="accent">
          {spec.priceMicroUsdPerHour === 0
            ? 'free'
            : `${formatMicroUsd(spec.priceMicroUsdPerHour)}/h`}
        </StatusPill>
      </header>

      <TextField
        label="Name"
        value={node.label}
        maxLength={MAX_LABEL_LENGTH}
        disabled={locked}
        onCommit={(label) => updateNodeLabel(node.id, label)}
      />

      {applies.size ? (
        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`size-${node.id}`}>
            Size
          </label>
          <select
            id={`size-${node.id}`}
            className="ui-input"
            value={node.config.size}
            disabled={locked}
            onChange={(event) =>
              updateNodeConfig(node.id, { size: event.target.value as NodeSize })
            }
          >
            {NODE_SIZES.map((size) => (
              <option value={size} key={size}>
                {NODE_SIZE_LABELS[size]} ·{' '}
                {formatMicroUsd(getSizeSpec(node.kind, size).priceMicroUsdPerHour)}
                /h
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <p className="inspector__capacity">{capacityMeaning(node)}</p>
      {resourceMeaning(node) ? (
        <p className="inspector__note">{resourceMeaning(node)}</p>
      ) : null}

      {applies.queue ? (
        <NumberField
          label="Queue"
          value={node.config.queueLimit}
          min={MIN_QUEUE_LIMIT}
          max={MAX_QUEUE_LIMIT}
          unit="requests"
          hint={`${MIN_QUEUE_LIMIT}–${MAX_QUEUE_LIMIT}. Separate from active slots; overflow is an explicit error.`}
          disabled={locked}
          onCommit={(value) => updateNodeConfig(node.id, { queueLimit: value })}
        />
      ) : null}

      {applies.pool ? (
        <NumberField
          label={node.kind === 'cache' ? 'Database pool' : 'Downstream pool'}
          value={node.config.poolSize}
          min={MIN_POOL_SIZE}
          max={MAX_POOL_SIZE}
          unit="connections"
          hint={`${MIN_POOL_SIZE}–${MAX_POOL_SIZE}. Held for the duration of a dependency call.`}
          disabled={locked}
          onCommit={(value) => updateNodeConfig(node.id, { poolSize: value })}
        />
      ) : null}

      {applies.cache ? (
        <>
          <NumberField
            label="TTL"
            value={node.config.ttlSeconds}
            min={MIN_TTL_SECONDS}
            max={MAX_TTL_SECONDS}
            unit="s"
            hint={`${MIN_TTL_SECONDS}–${MAX_TTL_SECONDS} s. An entry expires when now ≥ expiresAt.`}
            disabled={locked}
            onCommit={(value) => updateNodeConfig(node.id, { ttlSeconds: value })}
          />
          <label className="inspector__check">
            <input
              type="checkbox"
              checked={node.config.coalescing}
              disabled={locked}
              onChange={(event) =>
                updateNodeConfig(node.id, { coalescing: event.target.checked })
              }
            />
            <span>
              Coalescing
              <small>
                One fill per key; waiters do not open extra database connections.
              </small>
            </span>
          </label>
        </>
      ) : null}

      <div className="inspector__price">
        <span>Component cost</span>
        <strong>
          {spec.priceMicroUsdPerHour === 0
            ? 'free'
            : `${formatMicroUsd(spec.priceMicroUsdPerHour)}/h`}
        </strong>
        <span>Whole graph</span>
        <strong>{formatMoney(totalCostUsd)}/h</strong>
      </div>

      <MetricsBlock
        kind={node.kind}
        node={node}
        metrics={metrics}
        mode={mode}
        stale={stale}
        snapshotTimeMs={snapshotTimeMs}
        diagnostics={diagnostics}
      />

      <div className="inspector__actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<RotateCcw size={15} />}
          disabled={locked}
          onClick={() => {
            const result = resetNode(node.id);
            setMessage(result.ok ? 'Settings reset to the level defaults.' : result.message ?? null);
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
              const result = removeNode(node.id);
              setMessage(result.ok ? null : (result.message ?? null));
            }}
          >
            Delete component
          </Button>
        ) : null}
      </div>
      {message ? (
        <p className="inspector__message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

export function EdgeInspector({
  edge,
  graph,
  locked,
}: {
  edge: GraphEdge;
  graph: { nodes: GraphNode[] };
  locked: boolean;
}) {
  const removeEdge = useEditorStore((state) => state.removeEdge);
  const source = graph.nodes.find((node) => node.id === edge.source);
  const target = graph.nodes.find((node) => node.id === edge.target);
  return (
    <div className="inspector">
      <header className="inspector__head">
        <div>
          <p className="inspector__eyebrow">Connection</p>
          <h2>
            {source ? source.label : edge.source} →{' '}
            {target ? target.label : edge.target}
          </h2>
        </div>
        <StatusPill tone="neutral">{PORT_LABELS[edge.sourcePort]}</StatusPill>
      </header>
      <p className="inspector__capacity">
        The “{PORT_LABELS[edge.sourcePort]}” port is marked by both text and
        color, so the connection type does not rely on color alone.
      </p>
      <div className="inspector__actions">
        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 size={15} />}
          disabled={locked}
          onClick={() => removeEdge(edge.id)}
        >
          Delete connection
        </Button>
      </div>
    </div>
  );
}

export function EmptyInspector({ hasResult }: { hasResult: boolean }) {
  return (
    <div className="inspector inspector--empty">
      <h2>Inspector</h2>
      <p>
        Select a component or connection on the canvas. Its settings, cost, and
        current metrics will appear here.
      </p>
      {hasResult ? (
        <p>The latest run result is available on the Results tab.</p>
      ) : (
        <p>After a run, the SLO result will also appear here.</p>
      )}
    </div>
  );
}

