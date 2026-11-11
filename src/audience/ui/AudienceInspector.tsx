import { Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import {
  AUDIENCE_CATALOG,
  AUDIENCE_HEALTH_POLICY,
  AUDIENCE_LEVEL,
  AUDIENCE_QUEUE_LIMITS,
  AUDIENCE_RETRY_POLICY,
  AUDIENCE_ROUTING_POLICY,
  audienceLinkRole,
  validateAudienceGraph,
  type AudienceCacheTtlSeconds,
  type AudienceCaseResult,
  type AudienceNode,
  type AudienceSqlReadPlan,
  type AudienceSqlSize,
} from '../index';
import { Button } from '../../ui/Button';
import { DASH, formatDecimal, formatInteger } from '../../ui/format';
import {
  formatDataSize,
  formatHourlyUsd,
  formatMillisecondsPrecise,
} from '../../features/game-ui';
import {
  audienceResultStale,
  uniqueAudienceIssues,
} from './audience-diagnostics';
import {
  audienceCaseLabel,
  audienceLinkLabel,
  audienceLinkLongLabel,
  audienceNodeHourlyUsd,
  audienceQueueCapacity,
  audienceReadPlanDescription,
  audienceReadPlanLabel,
  audienceSqlSizeLabel,
  audienceSqlSizeSpec,
  AUDIENCE_NODE_KIND_LABELS,
} from './audience-meta';
import {
  audienceSelectedCase,
  useAudienceStore,
} from './audience-store';

export type AudienceInspectorTab = 'properties' | 'issues';

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="ui-field__hint">{hint}</p> : null}
    </div>
  );
}

function NodeLabelField({ node }: { node: AudienceNode }) {
  const updateNodeLabel = useAudienceStore((state) => state.updateNodeLabel);
  const runPhase = useAudienceStore((state) => state.runPhase);
  const locked = runPhase === 'running' || runPhase === 'stopping';
  const [draft, setDraft] = useState(node.label);
  const [last, setLast] = useState(`${node.id}|${node.label}`);
  const key = `${node.id}|${node.label}`;
  if (last !== key) {
    setLast(key);
    setDraft(node.label);
  }

  const commit = () => {
    const result = updateNodeLabel(node.id, draft);
    if (!result.ok) {
      setDraft(node.label);
    }
  };

  return (
    <Field
      label="Label"
      htmlFor="audience-node-label"
      hint="Labels are editor-only and never change the run digest."
    >
      <input
        id="audience-node-label"
        className="ui-input"
        type="text"
        maxLength={120}
        value={draft}
        disabled={locked}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            setDraft(node.label);
            event.currentTarget.blur();
          }
        }}
      />
    </Field>
  );
}

function AppConfig({ node }: { node: Extract<AudienceNode, { kind: 'app' }> }) {
  const setAppInstances = useAudienceStore((state) => state.setAppInstances);
  const runPhase = useAudienceStore((state) => state.runPhase);
  const locked = runPhase === 'running' || runPhase === 'stopping';
  const spec = AUDIENCE_CATALOG.components.app;
  return (
    <>
      <Field
        label="Instances"
        htmlFor="audience-app-instances"
        hint={`Each instance adds ${formatInteger(
          spec.cpuCoresPerInstance,
        )} CPU, ${formatInteger(
          spec.memoryGbPerInstance,
        )} GB RAM and one 1 Gbit/s lane, and is charged separately. Every physical slot gets its own failure case.`}
      >
        <select
          id="audience-app-instances"
          className="ui-input"
          value={node.config.instances}
          disabled={locked}
          onChange={(event) =>
            setAppInstances(node.id, Number(event.target.value))
          }
        >
          {[1, 2, 3, 4].map((instances) => (
            <option value={instances} key={instances}>
              {instances} instance{instances === 1 ? '' : 's'}
            </option>
          ))}
        </select>
      </Field>
      <dl className="audience-inspector__facts">
        <div>
          <dt>Pool rent</dt>
          <dd>
            {formatHourlyUsd(node.config.instances * spec.hourlyUsdPerInstance)}
          </dd>
        </div>
        <div>
          <dt>Pool capacity</dt>
          <dd>
            {formatInteger(spec.cpuCoresPerInstance * node.config.instances)} CPU ·{' '}
            {formatInteger(spec.memoryGbPerInstance * node.config.instances)} GB
          </dd>
        </div>
        <div>
          <dt>Queue cap</dt>
          <dd>{formatInteger(spec.waitingTasksPerInstance)} / instance</dd>
        </div>
      </dl>
      <p className="audience-inspector__note">{spec.notes}</p>
      <details className="audience-inspector__details">
        <summary>Routing and failure policy</summary>
        <p className="audience-inspector__note">
          A direct Users → Application path always targets physical slot{' '}
          {AUDIENCE_ROUTING_POLICY.directPathTarget}; spare slots are not routed
          without the Load Balancer. A crash is injected at 30 s for 15 s, then
          the process boots for 1 s before two successful probes make it
          routable again.
        </p>
      </details>
    </>
  );
}

function SqlConfig({ node }: { node: Extract<AudienceNode, { kind: 'sql' }> }) {
  const setSqlSize = useAudienceStore((state) => state.setSqlSize);
  const setSqlReadPlan = useAudienceStore((state) => state.setSqlReadPlan);
  const runPhase = useAudienceStore((state) => state.runPhase);
  const locked = runPhase === 'running' || runPhase === 'stopping';
  const spec = audienceSqlSizeSpec(node.config.size);
  const sql = AUDIENCE_CATALOG.components.sql;
  return (
    <>
      <Field
        label="Size"
        htmlFor="audience-sql-size"
        hint="Size sets CPU, RAM, disk, network and hourly price. More cores run more queries in parallel; one exact scan is never split across cores."
      >
        <select
          id="audience-sql-size"
          className="ui-input"
          value={node.config.size}
          disabled={locked}
          onChange={(event) =>
            setSqlSize(node.id, event.target.value as AudienceSqlSize)
          }
        >
          {(['small', 'medium', 'large'] as const).map((size) => {
            const item = sql.sizes[size];
            return (
              <option value={size} key={size}>
                {audienceSqlSizeLabel(size)} · {formatInteger(item.cores)} CPU ·{' '}
                {formatHourlyUsd(item.hourlyUsd)}
              </option>
            );
          })}
        </select>
      </Field>
      <dl className="audience-inspector__facts">
        <div>
          <dt>CPU / RAM</dt>
          <dd>
            {formatInteger(spec.cores)} cores · {formatInteger(spec.memoryGb)} GB
          </dd>
        </div>
        <div>
          <dt>Disk / NIC</dt>
          <dd>
            {formatInteger(spec.diskGb)} GB · {formatInteger(spec.nicGbitPerSec)}{' '}
            Gbit/s
          </dd>
        </div>
        <div>
          <dt>Queue cap</dt>
          <dd>{formatInteger(AUDIENCE_QUEUE_LIMITS.sqlWaiting)} waiting</dd>
        </div>
      </dl>
      <Field
        label="How the ranking is obtained"
        htmlFor="audience-sql-read-plan"
      >
        <select
          id="audience-sql-read-plan"
          className="ui-input"
          value={node.config.readPlan}
          disabled={locked}
          onChange={(event) =>
            setSqlReadPlan(
              node.id,
              event.target.value as AudienceSqlReadPlan,
            )
          }
        >
          {(['query', 'projection'] as const).map((plan) => (
            <option value={plan} key={plan}>
              {audienceReadPlanLabel(plan)}
            </option>
          ))}
        </select>
      </Field>
      <p className="audience-inspector__note">
        {audienceReadPlanDescription(node.config.readPlan)}
      </p>
      {node.config.readPlan === 'projection' ? (
        <p className="audience-inspector__note">
          Ingest and its outbox job commit together in the SQL jobs table. That
          table is the queue; no separate broker is required. The projection
          cannot complete without a Worker pool.
        </p>
      ) : null}
      <details className="audience-inspector__details">
        <summary>Preparation, storage and freshness</summary>
        <p className="audience-inspector__note">
          Raw prehistory is charged as storage. A query index or projection is
          built by real preparation work behind a setup barrier; it is never
          preseeded for free. A failed preparation budget makes the run
          incomplete rather than silently ready.
        </p>
        <p className="audience-inspector__note">
          A ranking response carries an exact snapshot tuple (as-of time and
          durable commit cursor). A projection publishes an ordered prefix only
          after every outbox event through that cursor and all due expiry work
          are durable.
        </p>
      </details>
    </>
  );
}

function CacheConfig({
  node,
}: {
  node: Extract<AudienceNode, { kind: 'cache' }>;
}) {
  const setCacheTtl = useAudienceStore((state) => state.setCacheTtl);
  const runPhase = useAudienceStore((state) => state.runPhase);
  const locked = runPhase === 'running' || runPhase === 'stopping';
  const cache = AUDIENCE_CATALOG.components.cache;
  return (
    <>
      <Field
        label="TTL"
        htmlFor="audience-cache-ttl"
        hint={`This is the actual retention. The freshness limit is ${formatMillisecondsPrecise(
          AUDIENCE_LEVEL.slo.freshnessMs,
        )}: a payload still cached after that limit is stale and fails freshness.`}
      >
        <select
          id="audience-cache-ttl"
          className="ui-input"
          value={node.config.ttlSeconds}
          disabled={locked}
          onChange={(event) =>
            setCacheTtl(
              node.id,
              Number(event.target.value) as AudienceCacheTtlSeconds,
            )
          }
        >
          {cache.ttlOptionsSeconds.map((ttl) => (
            <option value={ttl} key={ttl}>
              {ttl} s
            </option>
          ))}
        </select>
      </Field>
      <p className="audience-inspector__note">
        The TTL is honoured exactly as selected; nothing silently clamps it to
        the 5 s freshness limit. A longer retention can still serve a stale
        ranking, and that answer fails the freshness gate.
      </p>
      <dl className="audience-inspector__facts">
        <div>
          <dt>Rent</dt>
          <dd>{formatHourlyUsd(cache.hourlyUsd)}</dd>
        </div>
        <div>
          <dt>Capacity</dt>
          <dd>
            {formatInteger(cache.capacityBytes)} B entry ·{' '}
            {formatInteger(cache.memoryGb)} GB RAM
          </dd>
        </div>
        <div>
          <dt>Coalescing</dt>
          <dd>Fixed on</dd>
        </div>
        <div>
          <dt>Queue cap</dt>
          <dd>{formatInteger(cache.waitingTasks)} waiting</dd>
        </div>
      </dl>
      <p className="audience-inspector__note">{cache.notes}</p>
    </>
  );
}

function WorkerConfig({
  node,
}: {
  node: Extract<AudienceNode, { kind: 'worker' }>;
}) {
  const setWorkerInstances = useAudienceStore(
    (state) => state.setWorkerInstances,
  );
  const runPhase = useAudienceStore((state) => state.runPhase);
  const locked = runPhase === 'running' || runPhase === 'stopping';
  const spec = AUDIENCE_CATALOG.components.worker;
  return (
    <>
      <Field
        label="Instances"
        htmlFor="audience-worker-instances"
        hint="Each instance adds CPU, RAM and one network lane, and is charged separately. Workers poll the SQL jobs table."
      >
        <select
          id="audience-worker-instances"
          className="ui-input"
          value={node.config.instances}
          disabled={locked}
          onChange={(event) =>
            setWorkerInstances(node.id, Number(event.target.value))
          }
        >
          {[1, 2, 3, 4].map((instances) => (
            <option value={instances} key={instances}>
              {instances} instance{instances === 1 ? '' : 's'}
            </option>
          ))}
        </select>
      </Field>
      <dl className="audience-inspector__facts">
        <div>
          <dt>Pool rent</dt>
          <dd>
            {formatHourlyUsd(
              node.config.instances * spec.hourlyUsdPerInstance,
            )}
          </dd>
        </div>
        <div>
          <dt>Pool capacity</dt>
          <dd>
            {formatInteger(spec.cpuCoresPerInstance * node.config.instances)} CPU ·{' '}
            {formatInteger(spec.memoryGbPerInstance * node.config.instances)} GB
          </dd>
        </div>
        <div>
          <dt>Batch / flush</dt>
          <dd>
            {formatInteger(AUDIENCE_CATALOG.policies.projection.maxBatchEvents)}{' '}
            events ·{' '}
            {formatInteger(AUDIENCE_CATALOG.policies.projection.flushMs)} ms
          </dd>
        </div>
      </dl>
      <p className="audience-inspector__note">{spec.notes}</p>
      <p className="audience-inspector__note">
        With the query read plan a Worker does no useful work but is still
        billed.
      </p>
    </>
  );
}

function LbConfig({ node }: { node: Extract<AudienceNode, { kind: 'lb' }> }) {
  const spec = AUDIENCE_CATALOG.components.lb;
  return (
    <>
      <p className="audience-inspector__note">
        One priced managed node with internal redundancy inside this profile. It
        has no player-editable settings.
      </p>
      <dl className="audience-inspector__facts">
        <div>
          <dt>Rent</dt>
          <dd>{formatHourlyUsd(spec.hourlyUsd)}</dd>
        </div>
        <div>
          <dt>Capacity</dt>
          <dd>
            {formatInteger(spec.capacityRequestsPerSec)} req/s ·{' '}
            {formatInteger(spec.capacityGbitPerSec)} Gbit/s
          </dd>
        </div>
        <div>
          <dt>Label</dt>
          <dd>{node.label}</dd>
        </div>
      </dl>
      <p className="audience-inspector__note">{spec.notes}</p>
      <details className="audience-inspector__details">
        <summary>Fixed health policy</summary>
        <p className="audience-inspector__note">
          Probes start at measured 0 and repeat every{' '}
          {formatInteger(AUDIENCE_HEALTH_POLICY.intervalMs)} ms. A failure is
          counted only when its {formatInteger(AUDIENCE_HEALTH_POLICY.timeoutMs)}{' '}
          ms probe times out; a success is counted when the response completes.{' '}
          {AUDIENCE_HEALTH_POLICY.failuresToUnhealthy} consecutive failures
          exclude a backend and {AUDIENCE_HEALTH_POLICY.successesToReady}{' '}
          successes make it routable again. A client retry uses the same id, a
          fixed {formatInteger(AUDIENCE_RETRY_POLICY.backoffMs)} ms backoff and
          the remaining deadline.
        </p>
      </details>
    </>
  );
}

function UsersConfig() {
  return (
    <>
      <p className="audience-inspector__note">
        Users is fixed: 1,000,000 users and 100 streams. It cannot be deleted or
        resized. Its two offered operations are Record activity and View audience
        ranking.
      </p>
      <dl className="audience-inspector__facts">
        <div>
          <dt>Population</dt>
          <dd>{formatInteger(AUDIENCE_LEVEL.dataset.users)}</dd>
        </div>
        <div>
          <dt>Streams</dt>
          <dd>{formatInteger(AUDIENCE_LEVEL.dataset.streams)}</dd>
        </div>
        <div>
          <dt>Window</dt>
          <dd>previous 15 min</dd>
        </div>
      </dl>
    </>
  );
}

function NodeResultFacts({
  node,
  selectedCase,
}: {
  node: AudienceNode;
  selectedCase: AudienceCaseResult;
}) {
  const metrics = selectedCase.nodes.find((item) => item.nodeId === node.id);
  if (!metrics) {
    return null;
  }
  const isTarget =
    node.kind === 'app' &&
    selectedCase.target !== null &&
    selectedCase.target.instanceIndex === selectedCase.targetInstance;
  return (
    <section className="audience-inspector__result">
      <h3>This case</h3>
      <p className="audience-inspector__note">
        {audienceCaseLabel(selectedCase.id)} · final observed state
      </p>
      <dl className="audience-inspector__facts">
        <div>
          <dt>Instances healthy</dt>
          <dd>
            {formatInteger(metrics.health.healthyInstances)}/
            {formatInteger(metrics.health.totalInstances)} ·{' '}
            {metrics.health.state}
          </dd>
        </div>
        <div>
          <dt>Crashes / recovery</dt>
          <dd>
            {formatInteger(metrics.health.crashEvents)} ·{' '}
            {metrics.health.recoveryMs === null
              ? DASH
              : formatMillisecondsPrecise(metrics.health.recoveryMs)}
          </dd>
        </div>
        <div>
          <dt>CPU avg / peak</dt>
          <dd>
            {formatDecimal(metrics.cpu.utilizationAverage * 100, 1)}% /{' '}
            {formatDecimal(metrics.cpu.utilizationPeak * 100, 1)}%
          </dd>
        </div>
        <div>
          <dt>Queue avg / peak</dt>
          <dd>
            {formatDecimal(metrics.queue.waitingAverage, 1)} /{' '}
            {formatInteger(metrics.queue.waitingPeak)}
          </dd>
        </div>
        <div>
          <dt>RAM peak</dt>
          <dd>{formatDataSize(metrics.memory.peakUsedBytes)}</dd>
        </div>
        <div>
          <dt>Tasks rejected</dt>
          <dd>{formatInteger(metrics.tasks.rejected)}</dd>
        </div>
      </dl>
      {metrics.instances.length > 1 ? (
        <ul className="audience-inspector__instance-list">
          {metrics.instances.map((instance) => (
            <li key={instance.instanceIndex}>
              Slot {instance.instanceIndex}: {instance.health}
              {isTarget &&
              selectedCase.target?.instanceIndex === instance.instanceIndex
                ? ' · fault target'
                : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {isTarget && selectedCase.target ? (
        <dl className="audience-inspector__facts">
          <div>
            <dt>Crash</dt>
            <dd>
              {selectedCase.target.crashAtMs === null
                ? DASH
                : formatMillisecondsPrecise(selectedCase.target.crashAtMs)}
            </dd>
          </div>
          <div>
            <dt>Detected</dt>
            <dd>
              {selectedCase.target.detectedUnhealthyAtMs === null
                ? 'not observed'
                : formatMillisecondsPrecise(
                    selectedCase.target.detectedUnhealthyAtMs,
                  )}
            </dd>
          </div>
          <div>
            <dt>Restart</dt>
            <dd>
              {selectedCase.target.downUntilMs === null
                ? DASH
                : formatMillisecondsPrecise(selectedCase.target.downUntilMs)}
            </dd>
          </div>
          <div>
            <dt>Ready</dt>
            <dd>
              {selectedCase.target.readyAtMs === null
                ? DASH
                : formatMillisecondsPrecise(selectedCase.target.readyAtMs)}
            </dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}

function NodeEditor({
  node,
  onFocusNode,
  selectedCase,
}: {
  node: AudienceNode;
  onFocusNode: (id: string) => void;
  selectedCase: AudienceCaseResult | null;
}) {
  const removeNode = useAudienceStore((state) => state.removeNode);
  const runPhase = useAudienceStore((state) => state.runPhase);
  const locked = runPhase === 'running' || runPhase === 'stopping';
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="audience-inspector">
      <header className="audience-inspector__head">
        <p className="audience-inspector__eyebrow">
          {AUDIENCE_NODE_KIND_LABELS[node.kind]}
        </p>
        <h2>{node.label}</h2>
      </header>

      <NodeLabelField node={node} />

      {node.kind === 'users' ? (
        <UsersConfig />
      ) : node.kind === 'app' ? (
        <AppConfig node={node} />
      ) : node.kind === 'sql' ? (
        <SqlConfig node={node} />
      ) : node.kind === 'cache' ? (
        <CacheConfig node={node} />
      ) : node.kind === 'worker' ? (
        <WorkerConfig node={node} />
      ) : (
        <LbConfig node={node} />
      )}

      <dl className="audience-inspector__facts">
        <div>
          <dt>Configured rent</dt>
          <dd>
            {formatHourlyUsd(
              audienceNodeHourlyUsd(node.kind, {
                instances:
                  'instances' in node.config
                    ? node.config.instances
                    : undefined,
                size: 'size' in node.config ? node.config.size : undefined,
              }),
            )}
          </dd>
        </div>
        <div>
          <dt>Queue cap</dt>
          <dd>
            {audienceQueueCapacity(node.kind) === null
              ? DASH
              : formatInteger(audienceQueueCapacity(node.kind))}
          </dd>
        </div>
      </dl>

      {selectedCase ? (
        <NodeResultFacts node={node} selectedCase={selectedCase} />
      ) : null}

      <div className="audience-inspector__actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onFocusNode(node.id)}
        >
          Focus on canvas
        </Button>
        {node.kind !== 'users' ? (
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 size={14} />}
            disabled={locked}
            onClick={() => {
              const result = removeNode(node.id);
              setMessage(result.message ?? null);
            }}
          >
            Delete component
          </Button>
        ) : null}
      </div>
      {message ? (
        <p className="audience-inspector__error" role="alert">
          {message}
        </p>
      ) : null}
      {locked ? (
        <p className="audience-inspector__note">
          Settings are read-only while the evaluation runs. You can still move
          and inspect components.
        </p>
      ) : null}
    </div>
  );
}

function EdgeEditor({
  edgeId,
  onFocusEdge,
}: {
  edgeId: string;
  onFocusEdge: (id: string) => void;
}) {
  const graph = useAudienceStore((state) => state.graph);
  const removeEdge = useAudienceStore((state) => state.removeEdge);
  const runPhase = useAudienceStore((state) => state.runPhase);
  const locked = runPhase === 'running' || runPhase === 'stopping';
  const edge = graph.edges.find((item) => item.id === edgeId);
  const [message, setMessage] = useState<string | null>(null);
  if (!edge) {
    return <p className="audience-inspector__note">Connection not found.</p>;
  }
  const from = graph.nodes.find((node) => node.id === edge.from);
  const to = graph.nodes.find((node) => node.id === edge.to);
  const role = from && to ? audienceLinkRole(from.kind, to.kind) : null;

  return (
    <div className="audience-inspector">
      <header className="audience-inspector__head">
        <p className="audience-inspector__eyebrow">Connection</p>
        <h2>{audienceLinkLabel(role)}</h2>
      </header>
      <p className="audience-inspector__note">
        {audienceLinkLongLabel(role)}
      </p>
      <dl className="audience-inspector__facts">
        <div>
          <dt>From</dt>
          <dd>{from?.label ?? edge.from}</dd>
        </div>
        <div>
          <dt>To</dt>
          <dd>{to?.label ?? edge.to}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{audienceLinkLabel(role)}</dd>
        </div>
      </dl>
      <p className="audience-inspector__note">
        Roles are inferred from the component pair. A Worker → SQL connection
        represents polling and publication; the SQL jobs table is the queue.
      </p>
      <div className="audience-inspector__actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onFocusEdge(edge.id)}
        >
          Focus on canvas
        </Button>
        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 size={14} />}
          disabled={locked}
          onClick={() => {
            const result = removeEdge(edge.id);
            setMessage(result.message ?? null);
          }}
        >
          Delete connection
        </Button>
      </div>
      {message ? (
        <p className="audience-inspector__error" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function EmptySelection() {
  const graph = useAudienceStore((state) => state.graph);
  const seed = useAudienceStore((state) => state.seed);
  return (
    <div className="audience-inspector">
      <header className="audience-inspector__head">
        <p className="audience-inspector__eyebrow">Inspector</p>
        <h2>No selection</h2>
      </header>
      <p className="audience-inspector__note">
        Select a component or connection on the canvas to edit its settings. Add
        an Application, SQL Database, or optional Load Balancer, Cache and Worker
        from the Components tab, then connect them.
      </p>
      <dl className="audience-inspector__facts">
        <div>
          <dt>Components</dt>
          <dd>{formatInteger(graph.nodes.length)}</dd>
        </div>
        <div>
          <dt>Connections</dt>
          <dd>{formatInteger(graph.edges.length)}</dd>
        </div>
        <div>
          <dt>Seed</dt>
          <dd>{formatInteger(seed)}</dd>
        </div>
      </dl>
    </div>
  );
}

function IssueList({
  issues,
  onFocusNode,
  onFocusEdge,
}: {
  issues: ReturnType<typeof uniqueAudienceIssues>;
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  if (issues.length === 0) {
    return (
      <p className="audience-inspector__note">
        No validation or engine issues to show.
      </p>
    );
  }
  return (
    <ul className="audience-issues">
      {issues.map((issue, index) => (
        <li
          key={`${issue.code}-${index}`}
          className={`audience-issues__item audience-issues__item--${issue.severity}`}
        >
          <p>{issue.message}</p>
          <div className="audience-issues__actions">
            {issue.nodeId ? (
              <button type="button" onClick={() => onFocusNode(issue.nodeId!)}>
                Focus component
              </button>
            ) : null}
            {issue.edgeId ? (
              <button type="button" onClick={() => onFocusEdge(issue.edgeId!)}>
                Focus connection
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function AudienceInspector({
  tab,
  onFocusNode,
  onFocusEdge,
}: {
  tab: AudienceInspectorTab;
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  const graph = useAudienceStore((state) => state.graph);
  const selection = useAudienceStore((state) => state.selection);
  const seed = useAudienceStore((state) => state.seed);
  const result = useAudienceStore((state) => state.result);
  const resultDigest = useAudienceStore((state) => state.resultDigest);
  const resultSeed = useAudienceStore((state) => state.resultSeed);
  const runIssues = useAudienceStore((state) => state.runIssues);
  const selectedCaseId = useAudienceStore((state) => state.selectedCaseId);

  const stale = audienceResultStale(
    result,
    resultDigest,
    resultSeed,
    graph,
    seed,
  );
  const selectedCase =
    result && !stale ? audienceSelectedCase(result, selectedCaseId) : null;

  if (tab === 'issues') {
    const issues = uniqueAudienceIssues([
      ...validateAudienceGraph(graph),
      ...runIssues,
      ...(result && !stale ? result.issues : []),
    ]);
    return (
      <div className="audience-inspector">
        <header className="audience-inspector__head">
          <p className="audience-inspector__eyebrow">Checks</p>
          <h2>Issues</h2>
        </header>
        <p className="audience-inspector__note">
          Validation issues are actionable graph facts. Engine notices are the
          evidence reported for this run; they do not invent a root cause.
        </p>
        <IssueList
          issues={issues}
          onFocusNode={onFocusNode}
          onFocusEdge={onFocusEdge}
        />
      </div>
    );
  }

  if (selection?.type === 'node') {
    const node = graph.nodes.find((item) => item.id === selection.id);
    return node ? (
      <NodeEditor
        node={node}
        onFocusNode={onFocusNode}
        selectedCase={selectedCase}
      />
    ) : (
      <EmptySelection />
    );
  }
  if (selection?.type === 'edge') {
    return <EdgeEditor edgeId={selection.id} onFocusEdge={onFocusEdge} />;
  }
  return <EmptySelection />;
}
