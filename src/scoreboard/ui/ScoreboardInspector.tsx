import { Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import {
  SCOREBOARD_CATALOG,
  SCOREBOARD_LEVEL,
  scoreboardLinkRole,
  validateScoreboardGraph,
  type ScoreboardCacheTtlSeconds,
  type ScoreboardNode,
  type ScoreboardSqlReadPlan,
  type ScoreboardSqlSize,
} from '../index';
import { Button } from '../../ui/Button';
import { formatInteger } from '../../ui/format';
import { formatHourlyUsd } from './scoreboard-format';
import {
  scoreboardResultStale,
  uniqueScoreboardIssues,
} from './scoreboard-diagnostics';
import {
  SCOREBOARD_NODE_KIND_LABELS,
  scoreboardLinkLabel,
  scoreboardLinkLongLabel,
  scoreboardReadPlanDescription,
  scoreboardReadPlanLabel,
  scoreboardSqlSizeLabel,
  scoreboardSqlSizeSpec,
} from './scoreboard-meta';
import { useScoreboardStore } from './scoreboard-store';

export type ScoreboardInspectorTab = 'properties' | 'issues';

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

function NodeLabelField({ node }: { node: ScoreboardNode }) {
  const updateNodeLabel = useScoreboardStore((state) => state.updateNodeLabel);
  const runPhase = useScoreboardStore((state) => state.runPhase);
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
    <Field label="Label" htmlFor="scoreboard-node-label" hint="Labels are editor-only and never change the run digest.">
      <input
        id="scoreboard-node-label"
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

function AppConfig({ node }: { node: Extract<ScoreboardNode, { kind: 'app' }> }) {
  const setAppInstances = useScoreboardStore((state) => state.setAppInstances);
  const runPhase = useScoreboardStore((state) => state.runPhase);
  const locked = runPhase === 'running' || runPhase === 'stopping';
  const spec = SCOREBOARD_CATALOG.components.app;
  return (
    <>
      <Field
        label="Instances"
        htmlFor="scoreboard-app-instances"
        hint={`Each instance adds ${formatInteger(
          spec.cpuCoresPerInstance,
        )} CPU, ${formatInteger(spec.memoryGbPerInstance)} GB RAM and one network lane, and is charged separately.`}
      >
        <select
          id="scoreboard-app-instances"
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
      <dl className="scoreboard-inspector__facts">
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
      </dl>
      <p className="scoreboard-inspector__note">{spec.notes}</p>
    </>
  );
}

function SqlConfig({ node }: { node: Extract<ScoreboardNode, { kind: 'sql' }> }) {
  const setSqlSize = useScoreboardStore((state) => state.setSqlSize);
  const setSqlReadPlan = useScoreboardStore((state) => state.setSqlReadPlan);
  const runPhase = useScoreboardStore((state) => state.runPhase);
  const locked = runPhase === 'running' || runPhase === 'stopping';
  const spec = scoreboardSqlSizeSpec(node.config.size);
  const sql = SCOREBOARD_CATALOG.components.sql;
  return (
    <>
      <Field
        label="Size"
        htmlFor="scoreboard-sql-size"
        hint="Size sets CPU, RAM, disk and hourly price. More cores run more queries in parallel; they never split one scan."
      >
        <select
          id="scoreboard-sql-size"
          className="ui-input"
          value={node.config.size}
          disabled={locked}
          onChange={(event) =>
            setSqlSize(node.id, event.target.value as ScoreboardSqlSize)
          }
        >
          {(['small', 'medium', 'large'] as const).map((size) => {
            const item = sql.sizes[size];
            return (
              <option value={size} key={size}>
                {scoreboardSqlSizeLabel(size)} · {formatInteger(item.cores)} CPU ·{' '}
                {formatHourlyUsd(item.hourlyUsd)}
              </option>
            );
          })}
        </select>
      </Field>
      <dl className="scoreboard-inspector__facts">
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
          <dd>{formatInteger(SCOREBOARD_LEVEL.limits.maxSqlWaitingTasks)} waiting</dd>
        </div>
      </dl>
      <Field
        label="How the ranking is obtained"
        htmlFor="scoreboard-sql-read-plan"
      >
        <select
          id="scoreboard-sql-read-plan"
          className="ui-input"
          value={node.config.readPlan}
          disabled={locked}
          onChange={(event) =>
            setSqlReadPlan(
              node.id,
              event.target.value as ScoreboardSqlReadPlan,
            )
          }
        >
          {(['scan', 'aggregate'] as const).map((plan) => (
            <option value={plan} key={plan}>
              {scoreboardReadPlanLabel(plan)}
            </option>
          ))}
        </select>
      </Field>
      <p className="scoreboard-inspector__note">
        {scoreboardReadPlanDescription(node.config.readPlan)}
      </p>
      <p className="scoreboard-inspector__note">
        A maintained aggregate keeps the same exact ranking; it changes where
        the work happens and adds write-transaction work. It is not a different
        business answer.
      </p>
    </>
  );
}

function CacheConfig({
  node,
}: {
  node: Extract<ScoreboardNode, { kind: 'cache' }>;
}) {
  const setCacheTtl = useScoreboardStore((state) => state.setCacheTtl);
  const runPhase = useScoreboardStore((state) => state.runPhase);
  const locked = runPhase === 'running' || runPhase === 'stopping';
  const cache = SCOREBOARD_CATALOG.components.cache;
  return (
    <>
      <Field
        label="TTL"
        htmlFor="scoreboard-cache-ttl"
        hint="A snapshot can be up to 5 seconds behind committed votes. Writes do not invalidate the cache; TTL is the disclosed staleness policy."
      >
        <select
          id="scoreboard-cache-ttl"
          className="ui-input"
          value={node.config.ttlSeconds}
          disabled={locked}
          onChange={(event) =>
            setCacheTtl(
              node.id,
              Number(event.target.value) as ScoreboardCacheTtlSeconds,
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
      <dl className="scoreboard-inspector__facts">
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
          <dd>
            {formatInteger(SCOREBOARD_LEVEL.limits.maxCacheWaitingTasks)} waiting
          </dd>
        </div>
      </dl>
      <p className="scoreboard-inspector__note">{cache.notes}</p>
    </>
  );
}

function NodeEditor({
  node,
  onFocusNode,
}: {
  node: ScoreboardNode;
  onFocusNode: (id: string) => void;
}) {
  const removeNode = useScoreboardStore((state) => state.removeNode);
  const runPhase = useScoreboardStore((state) => state.runPhase);
  const locked = runPhase === 'running' || runPhase === 'stopping';
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="scoreboard-inspector">
      <header className="scoreboard-inspector__head">
        <p className="scoreboard-inspector__eyebrow">
          {SCOREBOARD_NODE_KIND_LABELS[node.kind]}
        </p>
        <h2>{node.label}</h2>
      </header>

      <NodeLabelField node={node} />

      {node.kind === 'users' ? (
        <p className="scoreboard-inspector__note">
          Users is fixed: 500,000 participants and 100 candidates. It cannot be
          deleted or resized. Its two streams are View leaderboard and Change
          vote.
        </p>
      ) : node.kind === 'app' ? (
        <AppConfig node={node} />
      ) : node.kind === 'sql' ? (
        <SqlConfig node={node} />
      ) : (
        <CacheConfig node={node} />
      )}

      <div className="scoreboard-inspector__actions">
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
        <p className="scoreboard-inspector__error" role="alert">
          {message}
        </p>
      ) : null}
      {locked ? (
        <p className="scoreboard-inspector__note">
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
  const graph = useScoreboardStore((state) => state.graph);
  const removeEdge = useScoreboardStore((state) => state.removeEdge);
  const runPhase = useScoreboardStore((state) => state.runPhase);
  const locked = runPhase === 'running' || runPhase === 'stopping';
  const edge = graph.edges.find((item) => item.id === edgeId);
  const [message, setMessage] = useState<string | null>(null);
  if (!edge) {
    return <p className="scoreboard-inspector__note">Connection not found.</p>;
  }
  const from = graph.nodes.find((node) => node.id === edge.from);
  const to = graph.nodes.find((node) => node.id === edge.to);
  const role = from && to ? scoreboardLinkRole(from.kind, to.kind) : null;

  return (
    <div className="scoreboard-inspector">
      <header className="scoreboard-inspector__head">
        <p className="scoreboard-inspector__eyebrow">Connection</p>
        <h2>{scoreboardLinkLabel(role)}</h2>
      </header>
      <p className="scoreboard-inspector__note">
        {scoreboardLinkLongLabel(role)}
      </p>
      <dl className="scoreboard-inspector__facts">
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
          <dd>{scoreboardLinkLabel(role)}</dd>
        </div>
      </dl>
      <p className="scoreboard-inspector__note">
        Roles are inferred from the component pair. There is no business port
        that turns this connection into writes-only traffic.
      </p>
      <div className="scoreboard-inspector__actions">
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
        <p className="scoreboard-inspector__error" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function EmptySelection() {
  const graph = useScoreboardStore((state) => state.graph);
  const seed = useScoreboardStore((state) => state.seed);
  return (
    <div className="scoreboard-inspector">
      <header className="scoreboard-inspector__head">
        <p className="scoreboard-inspector__eyebrow">Inspector</p>
        <h2>No selection</h2>
      </header>
      <p className="scoreboard-inspector__note">
        Select a component or connection on the canvas to edit its settings.
        Add Application, SQL Database or an optional Cache from the Components
        tab, then connect them.
      </p>
      <dl className="scoreboard-inspector__facts">
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
  issues: ReturnType<typeof uniqueScoreboardIssues>;
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  if (issues.length === 0) {
    return (
      <p className="scoreboard-inspector__note">
        No validation or engine issues to show.
      </p>
    );
  }
  return (
    <ul className="scoreboard-issues">
      {issues.map((issue, index) => (
        <li
          key={`${issue.code}-${index}`}
          className={`scoreboard-issues__item scoreboard-issues__item--${issue.severity}`}
        >
          <p>{issue.message}</p>
          <div className="scoreboard-issues__actions">
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

export function ScoreboardInspector({
  tab,
  onFocusNode,
  onFocusEdge,
}: {
  tab: ScoreboardInspectorTab;
  onFocusNode: (id: string) => void;
  onFocusEdge: (id: string) => void;
}) {
  const graph = useScoreboardStore((state) => state.graph);
  const selection = useScoreboardStore((state) => state.selection);
  const seed = useScoreboardStore((state) => state.seed);
  const result = useScoreboardStore((state) => state.result);
  const resultDigest = useScoreboardStore((state) => state.resultDigest);
  const resultSeed = useScoreboardStore((state) => state.resultSeed);
  const runIssues = useScoreboardStore((state) => state.runIssues);

  const stale = scoreboardResultStale(
    result,
    resultDigest,
    resultSeed,
    graph,
    seed,
  );

  if (tab === 'issues') {
    const issues = uniqueScoreboardIssues([
      ...validateScoreboardGraph(graph),
      ...runIssues,
      ...(result && !stale ? result.issues : []),
    ]);
    return (
      <div className="scoreboard-inspector">
        <header className="scoreboard-inspector__head">
          <p className="scoreboard-inspector__eyebrow">Checks</p>
          <h2>Issues</h2>
        </header>
        <p className="scoreboard-inspector__note">
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
      <NodeEditor node={node} onFocusNode={onFocusNode} />
    ) : (
      <EmptySelection />
    );
  }
  if (selection?.type === 'edge') {
    return <EdgeEditor edgeId={selection.id} onFocusEdge={onFocusEdge} />;
  }
  return <EmptySelection />;
}
