import { Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  CART_LIMITS,
  type CartApplicationNode,
  type CartEdge,
  type CartGraph,
  type CartIssue,
  type CartNode,
  type CartNodeKind,
  type CartReadPolicy,
  type CartRegion,
  type CartServiceSize,
} from '../index';
import { Button } from '../../ui/Button';
import { StatusPill } from '../../ui/StatusPill';
import { TextField } from '../../ui/TextField';
import {
  CART_CIRCUIT_PAIRS,
  CART_EDGE_UI,
  CART_KIND_UI,
  CART_REGION_ORDER,
  cartCircuitFor,
  cartCircuitKey,
  cartNodeDisplayName,
  cartNodeSummary,
  cartPairLabel,
  cartRegionLabel,
  cartRegionShort,
} from './cart-meta';
import { cartIssueText } from './cart-issue-text';
import {
  cartReadCoverageGaps,
  cartReadCoverageSentence,
} from './cart-read-coverage';
import { useCartStore, type CartSelection } from './cart-store';

const READ_TARGET_KINDS = new Set<CartNodeKind>([
  'journal',
  'store',
  'application',
]);

function issueSelection(issue: CartIssue): CartSelection {
  if (issue.nodeId) return { type: 'node', id: issue.nodeId };
  if (issue.edgeId) return { type: 'edge', id: issue.edgeId };
  return null;
}

function IssueList({
  graph,
  issues,
  onSelect,
}: {
  graph: CartGraph;
  issues: CartIssue[];
  onSelect: (selection: CartSelection) => void;
}) {
  if (issues.length === 0) {
    return (
      <p className="cart-inspector__ok">
        No validation problems. This is not a pass: the Normal and Rush scenarios decide
        that.
      </p>
    );
  }
  const shown = issues.slice(0, 12);
  return (
    <>
      <ul className="cart-inspector__issues">
        {shown.map((issue) => {
          const selection = issueSelection(issue);
          return (
            <li key={`${issue.code}|${issue.message}|${issue.nodeId ?? ''}|${issue.edgeId ?? ''}`}>
              {selection ? (
                <button
                  type="button"
                  className="cart-inspector__issue-link"
                  onClick={() => onSelect(selection)}
                >
                  {cartIssueText(graph, issue)}
                </button>
              ) : (
                <span>{cartIssueText(graph, issue)}</span>
              )}
            </li>
          );
        })}
      </ul>
      {issues.length > shown.length ? (
        <p className="cart-inspector__small">
          {issues.length - shown.length} more issue
          {issues.length - shown.length === 1 ? '' : 's'} not shown.
        </p>
      ) : null}
    </>
  );
}

function FactList({ graph, node }: { graph: CartGraph; node: CartNode }) {
  const facts = cartNodeSummary(node, graph);
  return (
    <ul className="cart-inspector__facts">
      {facts.map((fact) => (
        <li key={fact}>{fact}</li>
      ))}
    </ul>
  );
}

function applicationTargets(
  graph: CartGraph,
  application: CartApplicationNode,
): CartNode[] {
  return graph.nodes.filter(
    (node) =>
      node.id !== application.id && READ_TARGET_KINDS.has(node.kind),
  );
}

function durableTargets(graph: CartGraph): CartNode[] {
  return graph.nodes.filter(
    (node) => node.kind === 'journal' || node.kind === 'store',
  );
}

function NodeDetails({ node }: { node: CartNode }) {
  const graph = useCartStore((state) => state.graph);
  const updateNodeLabel = useCartStore((state) => state.updateNodeLabel);
  const updateNodeRegion = useCartStore((state) => state.updateNodeRegion);
  const updateServiceSize = useCartStore((state) => state.updateServiceSize);
  const updateApplication = useCartStore((state) => state.updateApplication);
  const toggleReadTarget = useCartStore((state) => state.toggleReadTarget);
  const removeNode = useCartStore((state) => state.removeNode);
  const [message, setMessage] = useState<string | null>(null);
  const ui = CART_KIND_UI[node.kind];
  const Icon = ui.icon;
  const application = node.kind === 'application' ? node : null;

  return (
    <div className="cart-inspector__details">
      <header className="cart-inspector__node-head">
        <span className="cart-inspector__node-icon" style={{ color: ui.color }} aria-hidden="true">
          <Icon size={19} strokeWidth={2} />
        </span>
        <div>
          <h2>{cartNodeDisplayName(node)}</h2>
          <p>
            {ui.label} · {cartRegionLabel(node.region)}
          </p>
        </div>
      </header>

      <p className="cart-inspector__description">{ui.description}</p>
      <FactList graph={graph} node={node} />

      <section className="cart-inspector__section">
        <h3>Basics</h3>
        <TextField
          label="Display label"
          value={node.label ?? ui.label}
          maxLength={CART_LIMITS.labelMaxLength}
          onCommit={(value) => {
            const result = updateNodeLabel(node.id, value);
            setMessage(result.message ?? null);
          }}
          hint="Only a name; it changes nothing in the simulation."
        />
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="cart-node-region">
            Region
          </label>
          <select
            id="cart-node-region"
            className="ui-input"
            value={node.region}
            disabled={node.kind === 'customers'}
            onChange={(event) => {
              const result = updateNodeRegion(
                node.id,
                event.target.value as CartRegion,
              );
              setMessage(result.message ?? null);
            }}
          >
            {CART_REGION_ORDER.map((region) => (
              <option value={region} key={region}>
                {cartRegionLabel(region)}
              </option>
            ))}
          </select>
          <p className="ui-field__hint">
            {node.kind === 'customers'
              ? 'Customers stay in their region.'
              : 'The region decides network distance and which circuits a path uses.'}
          </p>
        </div>
        {node.kind !== 'customers' ? (
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="cart-node-size">
              Service size
            </label>
            <select
              id="cart-node-size"
              className="ui-input"
              value={node.size}
              onChange={(event) => {
                const result = updateServiceSize(
                  node.id,
                  event.target.value as CartServiceSize,
                );
                setMessage(result.message ?? null);
              }}
            >
              <option value="S">S</option>
              <option value="M">M</option>
            </select>
            <p className="ui-field__hint">
              A bigger size has more CPU and memory and costs more per hour.
            </p>
          </div>
        ) : null}
      </section>

      {application ? (
        <section className="cart-inspector__section">
          <h3>Application settings</h3>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="cart-app-instances">
              Instances
            </label>
            <select
              id="cart-app-instances"
              className="ui-input"
              value={application.instances}
              onChange={(event) => {
                const result = updateApplication(application.id, {
                  instances: Number(event.target.value) === 2 ? 2 : 1,
                });
                setMessage(result.message ?? null);
              }}
            >
              <option value={1}>1 instance</option>
              <option value={2}>2 instances</option>
            </select>
            <p className="ui-field__hint">
              More instances add CPU capacity for this region’s requests.
            </p>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="cart-app-write">
              Write target
            </label>
            <select
              id="cart-app-write"
              className="ui-input"
              value={application.writeTarget}
              onChange={(event) => {
                const result = updateApplication(application.id, {
                  writeTarget: event.target.value,
                });
                setMessage(result.message ?? null);
              }}
            >
              <option value="">Not set</option>
              {durableTargets(graph).map((target) => (
                <option value={target.id} key={target.id}>
                  {cartNodeDisplayName(target)} · {cartRegionShort(target.region)}
                </option>
              ))}
            </select>
            <p className="ui-field__hint">
              Cart changes are confirmed only after this journal or store has saved them.
            </p>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="cart-app-policy">
              Read policy
            </label>
            <select
              id="cart-app-policy"
              className="ui-input"
              value={application.readPolicy}
              onChange={(event) => {
                const result = updateApplication(application.id, {
                  readPolicy: event.target.value as CartReadPolicy,
                });
                setMessage(result.message ?? null);
              }}
            >
              <option value="local-repair">Local first</option>
              <option value="parallel">Parallel</option>
            </select>
            <p className="ui-field__hint">
              Local first reads nearby targets and asks the others only when needed;
              Parallel asks all targets at once.
            </p>
          </div>

          <fieldset className="cart-inspector__targets">
            <legend>Read targets</legend>
            {applicationTargets(graph, application).length === 0 ? (
              <p>Add a journal, cart store or another Application first.</p>
            ) : (
              <ul>
                {applicationTargets(graph, application).map((target) => {
                  const checked = application.readTargets.includes(target.id);
                  return (
                    <li key={target.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const result = toggleReadTarget(
                              application.id,
                              target.id,
                            );
                            setMessage(result.message ?? null);
                          }}
                        />
                        {cartNodeDisplayName(target)} · {cartRegionShort(target.region)}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="ui-field__hint">
              Pick at least one journal, store or Application; each needs a drawn request
              path.
            </p>
          </fieldset>
        </section>
      ) : null}

      <section className="cart-inspector__section">
        <h3>Fixed behaviour</h3>
        {node.kind === 'customers' ? (
          <p>
            Customers are a fixed traffic source. They can connect only to the
            Application in their own region and cannot be moved, copied or deleted.
          </p>
        ) : null}
        {node.kind === 'cache' ? (
          <p>
            Cached entries live for 1 s. A cache can speed up reads, but it never confirms
            a write or a purchase.
          </p>
        ) : null}
        {node.kind === 'journal' ? (
          <p>
            Keeps every cart change in an append-only log. Reads scan that log and cost
            CPU and I/O; there is no precomputed view.
          </p>
        ) : null}
        {node.kind === 'store' ? (
          <p>
            Keeps cart changes and a precomputed view. Keeping the view up to date costs
            work, so it is not free.
          </p>
        ) : null}
        {node.kind === 'inventory' ? (
          <p>
            Holds stock and orders, one transaction at a time. No cache or copy can
            authorize a purchase. If Inventory is unreachable, checkout is unavailable,
            not out of stock.
          </p>
        ) : null}
        {node.kind === 'application' ? (
          <p>
            One Application per region. Every path it uses must be drawn; its read and
            write settings only choose among targets you have connected. Retry timing and
            checkout order are fixed rules.
          </p>
        ) : null}
      </section>

      {message ? (
        <p className="cart-inspector__message" role="status">
          {message}
        </p>
      ) : null}

      <Button
        variant="danger"
        icon={<Trash2 size={15} />}
        disabled={node.kind === 'customers'}
        onClick={() => {
          const result = removeNode(node.id);
          if (!result.ok) setMessage(result.message ?? null);
        }}
      >
        Delete component
      </Button>
    </div>
  );
}

function EdgeDetails({ edge }: { edge: CartEdge }) {
  const graph = useCartStore((state) => state.graph);
  const removeEdge = useCartStore((state) => state.removeEdge);
  const from = graph.nodes.find((node) => node.id === edge.from);
  const to = graph.nodes.find((node) => node.id === edge.to);
  const crossRegion =
    from !== undefined && to !== undefined && from.region !== to.region;
  const circuit =
    from && to ? cartCircuitFor(graph, from.region, to.region) : undefined;
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="cart-inspector__details">
      <header className="cart-inspector__node-head">
        <div>
          <h2>{CART_EDGE_UI[edge.kind].label}</h2>
          <p>
            {from ? cartNodeDisplayName(from) : 'a missing component'} →{' '}
            {to ? cartNodeDisplayName(to) : 'a missing component'}
          </p>
        </div>
      </header>
      <p className="cart-inspector__description">
        {CART_EDGE_UI[edge.kind].description}
      </p>
      <section className="cart-inspector__section">
        <h3>Path facts</h3>
        <dl className="cart-inspector__kv">
          <div>
            <dt>Meaning</dt>
            <dd>{CART_EDGE_UI[edge.kind].label}</dd>
          </div>
          <div>
            <dt>Direction</dt>
            <dd>
              {from ? cartRegionShort(from.region) : 'unknown'} →{' '}
              {to ? cartRegionShort(to.region) : 'unknown'}
            </dd>
          </div>
          <div>
            <dt>Physical link</dt>
            <dd>{crossRegion ? 'Circuit between the two regions' : 'Same region (no circuit needed)'}</dd>
          </div>
          {crossRegion && from && to ? (
            <div>
              <dt>Shared bandwidth</dt>
              <dd>
                {circuit
                  ? `${circuit.mbps} Mbit/s per direction for ${cartPairLabel(from.region, to.region)}`
                  : 'No circuit purchased — this path cannot run yet'}
              </dd>
            </div>
          ) : null}
        </dl>
        {crossRegion ? (
          <p className="cart-inspector__note">
            All paths between this pair share one circuit, so extra paths add no bandwidth.
            Change the circuit in Build → Regional circuits.
          </p>
        ) : null}
      </section>
      {message ? (
        <p className="cart-inspector__message" role="status">
          {message}
        </p>
      ) : null}
      <Button
        variant="danger"
        icon={<Trash2 size={15} />}
        onClick={() => {
          const result = removeEdge(edge.id);
          if (!result.ok) setMessage(result.message ?? null);
        }}
      >
        Delete path
      </Button>
    </div>
  );
}

function RequirementRow({
  ok,
  label,
  detail,
}: {
  ok: boolean;
  label: string;
  detail: string;
}) {
  return (
    <li className="cart-inspector__requirement">
      <StatusPill tone={ok ? 'success' : 'warning'}>{ok ? 'Ready' : 'Missing'}</StatusPill>
      <div>
        <strong>{label}</strong>
        <p>{detail}</p>
      </div>
    </li>
  );
}

function GraphOverview({ graph }: { graph: CartGraph }) {
  const applications = graph.nodes.filter((node) => node.kind === 'application');
  const inventory = graph.nodes.filter((node) => node.kind === 'inventory');
  const configuredWrites = applications.filter(
    (node) => node.kind === 'application' && node.writeTarget !== '',
  );
  const configuredReads = applications.filter(
    (node) => node.kind === 'application' && node.readTargets.length > 0,
  );
  const crossRegionEdges = graph.edges.filter((edge) => {
    const from = graph.nodes.find((node) => node.id === edge.from);
    const to = graph.nodes.find((node) => node.id === edge.to);
    return from !== undefined && to !== undefined && from.region !== to.region;
  });
  const usedKeys = new Set(
    crossRegionEdges.flatMap((edge) => {
      const from = graph.nodes.find((node) => node.id === edge.from);
      const to = graph.nodes.find((node) => node.id === edge.to);
      if (!from || !to) return [];
      return [cartCircuitKey(from.region, to.region)];
    }),
  );
  const purchasedKeys = new Set(
    graph.circuits.map((circuit) =>
      cartCircuitKey(circuit.regions[0], circuit.regions[1]),
    ),
  );
  // Canonical pair order, the same order the Build panel lists circuits in.
  const missingCircuits = CART_CIRCUIT_PAIRS.filter(
    ([a, b]) =>
      usedKeys.has(cartCircuitKey(a, b)) && !purchasedKeys.has(cartCircuitKey(a, b)),
  ).map(([a, b]) => cartPairLabel(a, b));

  const readCoverageGaps = cartReadCoverageGaps(graph);
  const hasValidWriteTarget = applications.some(
    (node) =>
      node.kind === 'application' &&
      graph.nodes.some(
        (target) =>
          target.id === node.writeTarget &&
          (target.kind === 'journal' || target.kind === 'store'),
      ),
  );
  const readCoverageOk = hasValidWriteTarget && readCoverageGaps.length === 0;
  let readCoverageDetail: string;
  if (!hasValidWriteTarget) {
    readCoverageDetail = 'Set write targets first.';
  } else if (readCoverageGaps.length === 0) {
    readCoverageDetail = 'Each Application reads every storage that receives writes.';
  } else {
    readCoverageDetail = readCoverageGaps.map(cartReadCoverageSentence).join(' ');
  }

  return (
    <div className="cart-inspector__overview">
      <h2>Design checklist</h2>
      <p className="cart-inspector__description">
        Select a component to edit its settings, or a drawn path to inspect its meaning.
        This checklist is not a result; the Normal and Rush scenarios decide pass or fail.
      </p>
      <ul className="cart-inspector__requirements">
        <RequirementRow
          ok={applications.length === 3}
          label="One Application per region"
          detail={`${applications.length} of 3 Applications placed.`}
        />
        <RequirementRow
          ok={inventory.length === 1}
          label="Exactly one Inventory"
          detail={`${inventory.length} of 1 Inventory placed.`}
        />
        <RequirementRow
          ok={configuredWrites.length === applications.length && applications.length === 3}
          label="Every Application has a write target"
          detail={`${configuredWrites.length} of ${applications.length || 3} set. The target must be reachable by a drawn request path.`}
        />
        <RequirementRow
          ok={configuredReads.length === applications.length && applications.length === 3}
          label="Every Application has read targets"
          detail={`${configuredReads.length} of ${applications.length || 3} set. Only journals, stores and Applications are allowed.`}
        />
        <RequirementRow
          ok={readCoverageOk}
          label="Every Application reads all cart storage in use"
          detail={readCoverageDetail}
        />
        <RequirementRow
          ok={missingCircuits.length === 0}
          label="Every used region pair has a circuit"
          detail={
            missingCircuits.length === 0
              ? `${graph.circuits.length} circuit${graph.circuits.length === 1 ? '' : 's'} purchased.`
              : `Missing: ${missingCircuits.join(', ')}.`
          }
        />
        <RequirementRow
          ok={graph.nodes.length <= CART_LIMITS.maxNodes && graph.edges.length <= CART_LIMITS.maxEdges}
          label="Within design limits"
          detail={`${graph.nodes.length}/${CART_LIMITS.maxNodes} components · ${graph.edges.length}/${CART_LIMITS.maxEdges} paths.`}
        />
      </ul>
    </div>
  );
}

export function CartInspector({
  graph,
  selection,
  issues,
}: {
  graph: CartGraph;
  selection: CartSelection;
  issues: CartIssue[];
}) {
  const select = useCartStore((state) => state.select);
  const node =
    selection?.type === 'node'
      ? graph.nodes.find((item) => item.id === selection.id)
      : undefined;
  const edge =
    selection?.type === 'edge'
      ? graph.edges.find((item) => item.id === selection.id)
      : undefined;

  return (
    <div className="cart-inspector">
      {node ? <NodeDetails key={node.id} node={node} /> : null}
      {edge ? <EdgeDetails key={edge.id} edge={edge} /> : null}
      {!node && !edge ? <GraphOverview graph={graph} /> : null}

      <section className="cart-inspector__section cart-inspector__section--issues">
        <h3>Validation issues ({issues.length})</h3>
        <IssueList graph={graph} issues={issues} onSelect={select} />
      </section>
    </div>
  );
}
