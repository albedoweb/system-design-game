import { Link2, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  CART_EDGE_KINDS,
  CART_LIMITS,
  type CartEdgeKind,
  type CartGraph,
  type CartNode,
} from '../index';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Modal';
import {
  canSource,
  canTarget,
  CART_EDGE_UI,
  CART_KIND_UI,
  cartNodeDisplayName,
  cartRegionShort,
  type CartConnectRequest,
} from './cart-meta';
import { useCartStore } from './cart-store';

function nodeOptionLabel(node: CartNode): string {
  return `${cartNodeDisplayName(node)} · ${CART_KIND_UI[node.kind].short} · ${cartRegionShort(node.region)}`;
}

export function CartConnectDialog({
  graph,
  initial,
  onClose,
}: {
  graph: CartGraph;
  initial?: CartConnectRequest;
  onClose: () => void;
}) {
  const addEdge = useCartStore((state) => state.addEdge);
  const removeEdge = useCartStore((state) => state.removeEdge);
  const kind: CartEdgeKind = initial?.kind ?? 'request';
  const [edgeKind, setEdgeKind] = useState<CartEdgeKind>(kind);
  const [source, setSource] = useState(initial?.from ?? '');
  const [target, setTarget] = useState(initial?.to ?? '');
  const [message, setMessage] = useState<string | null>(null);

  const sourceNode = graph.nodes.find((node) => node.id === source);
  const sourceOptions = graph.nodes.filter((node) => canSource(node, edgeKind));
  const targetOptions = graph.nodes.filter((node) =>
    canTarget(sourceNode, node, edgeKind),
  );
  const effectiveSource =
    sourceNode && canSource(sourceNode, edgeKind)
      ? source
      : (sourceOptions[0]?.id ?? '');
  const effectiveSourceNode = graph.nodes.find(
    (node) => node.id === effectiveSource,
  );
  const effectiveTarget = targetOptions.some((node) => node.id === target)
    ? target
    : (targetOptions[0]?.id ?? '');
  const currentTarget = graph.nodes.find((node) => node.id === effectiveTarget);

  const changeKind = (next: CartEdgeKind) => {
    setEdgeKind(next);
    setMessage(null);
    const nextSource = graph.nodes.find((node) => node.id === source);
    if (nextSource && !canSource(nextSource, next)) {
      setSource(graph.nodes.find((node) => canSource(node, next))?.id ?? '');
    }
    setTarget('');
  };

  const submit = () => {
    const result = addEdge(effectiveSource, effectiveTarget, edgeKind);
    if (!result.ok) {
      setMessage(result.message ?? 'Connection rejected.');
      return;
    }
    onClose();
  };

  return (
    <Modal title="Connect components" onClose={onClose}>
      <form
        className="cart-connect"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className="cart-connect__intro">
          Choose the two components and what the path means.
        </p>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="cart-edge-kind">
            Path meaning
          </label>
          <select
            id="cart-edge-kind"
            className="ui-input"
            value={edgeKind}
            onChange={(event) => changeKind(event.target.value as CartEdgeKind)}
          >
            {CART_EDGE_KINDS.map((item) => (
              <option value={item} key={item}>
                {CART_EDGE_UI[item].label}
              </option>
            ))}
          </select>
          <p className="ui-field__hint">{CART_EDGE_UI[edgeKind].description}</p>
        </div>

        <div className="cart-connect__grid">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="cart-edge-source">
              From
            </label>
            <select
              id="cart-edge-source"
              className="ui-input"
              value={effectiveSource}
              onChange={(event) => {
                setSource(event.target.value);
                setTarget('');
                setMessage(null);
              }}
            >
              <option value="">Choose a source</option>
              {sourceOptions.map((node) => (
                <option value={node.id} key={node.id}>
                  {nodeOptionLabel(node)}
                </option>
              ))}
            </select>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="cart-edge-target">
              To
            </label>
            <select
              id="cart-edge-target"
              className="ui-input"
              value={effectiveTarget}
              onChange={(event) => {
                setTarget(event.target.value);
                setMessage(null);
              }}
            >
              <option value="">Choose a target</option>
              {targetOptions.map((node) => (
                <option value={node.id} key={node.id}>
                  {nodeOptionLabel(node)}
                </option>
              ))}
            </select>
            <p className="ui-field__hint">
              {edgeKind === 'request'
                ? 'A request cannot target a customer source. A customer may only reach its own region’s Application.'
                : 'Replication can only land on a durable journal or cart store.'}
            </p>
          </div>
        </div>

        {effectiveSourceNode && currentTarget ? (
          <p className="cart-connect__preview">
            {cartNodeDisplayName(effectiveSourceNode)} →{' '}
            {cartNodeDisplayName(currentTarget)} · {CART_EDGE_UI[edgeKind].label}
            {effectiveSourceNode.region !== currentTarget.region
              ? ' · cross-region, shares the pair’s purchased circuit'
              : ''}
          </p>
        ) : null}

        {message ? (
          <p className="cart-connect__message" role="alert">
            {message}
          </p>
        ) : null}

        <div className="cart-connect__actions">
          <Button
            variant="primary"
            type="submit"
            icon={<Link2 size={16} />}
            disabled={!effectiveSource || !effectiveTarget || graph.edges.length >= CART_LIMITS.maxEdges}
          >
            Create path
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </form>

      <section className="cart-connect__list">
        <h3>Drawn paths</h3>
        {graph.edges.length === 0 ? (
          <p>No paths yet. The simulator never invents connectivity.</p>
        ) : (
          <ul>
            {graph.edges.map((edge) => {
              const from = graph.nodes.find((node) => node.id === edge.from);
              const to = graph.nodes.find((node) => node.id === edge.to);
              return (
                <li key={edge.id}>
                  <span>
                    {from ? cartNodeDisplayName(from) : edge.from} →{' '}
                    {to ? cartNodeDisplayName(to) : edge.to} ·{' '}
                    {CART_EDGE_UI[edge.kind].label}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={14} />}
                    onClick={() => {
                      const result = removeEdge(edge.id);
                      setMessage(result.ok ? 'Path removed.' : (result.message ?? null));
                    }}
                    aria-label={`Delete path ${edge.from} to ${edge.to}`}
                  >
                    Delete
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Modal>
  );
}
