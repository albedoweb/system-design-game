import { Link2, Plus, Share2 } from 'lucide-react';
import { useState } from 'react';

import type { CartCircuitMbps, CartRegion } from '../index';
import {
  CART_ADDABLE_KINDS,
  CART_CIRCUIT_PAIRS,
  CART_EDGE_UI,
  CART_FIXED_RULES,
  CART_KIND_UI,
  CART_REGION_ORDER,
  cartCircuitFor,
  cartCircuitLabel,
  cartCircuitTiers,
  cartKindAddLimit,
  cartPairLabel,
  cartRegionLabel,
} from './cart-meta';
import { useCartStore } from './cart-store';

/**
 * Build panel: place regional services, connect with the keyboard-friendly
 * form and provision one shared circuit per used region pair.
 */
export function CartPalette({ onOpenConnect }: { onOpenConnect: () => void }) {
  const graph = useCartStore((state) => state.graph);
  const addNode = useCartStore((state) => state.addNode);
  const setCircuit = useCartStore((state) => state.setCircuit);
  const [region, setRegion] = useState<CartRegion>('us-west');
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="cart-palette">
      <p className="cart-palette__intro">
        Start from the three customer sources. Add an Application in each region, then
        optional caches, journals or cart stores, and one Inventory. Draw every path
        yourself.
      </p>

      <button
        type="button"
        className="cart-palette__connect"
        onClick={onOpenConnect}
      >
        <Link2 size={16} aria-hidden="true" />
        Connect with a form (C)
      </button>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor="cart-palette-region">
          New component region
        </label>
        <select
          id="cart-palette-region"
          className="ui-input"
          value={region}
          onChange={(event) => setRegion(event.target.value as CartRegion)}
        >
          {CART_REGION_ORDER.map((item) => (
            <option value={item} key={item}>
              {cartRegionLabel(item)}
            </option>
          ))}
        </select>
        <p className="ui-field__hint">
          {graph.nodes.filter((node) => node.region === region).length}{' '}
          component
          {graph.nodes.filter((node) => node.region === region).length === 1
            ? ''
            : 's'}{' '}
          in this region. Dragging a component only moves it on screen; its region is
          set in Properties.
        </p>
      </div>

      <div className="cart-palette__list" role="list">
        {CART_ADDABLE_KINDS.map((kind) => {
          const ui = CART_KIND_UI[kind];
          const Icon = ui.icon;
          const limit = cartKindAddLimit(graph, kind, region);
          const present = graph.nodes.filter((node) => node.kind === kind).length;
          return (
            <div className="cart-palette__item" role="listitem" key={kind}>
              <span className="cart-palette__icon" aria-hidden="true">
                <Icon size={18} strokeWidth={2} />
              </span>
              <div className="cart-palette__body">
                <div className="cart-palette__title-row">
                  <h3>{ui.label}</h3>
                  <span className="cart-palette__count">
                    {present} present
                  </span>
                </div>
                <p className="cart-palette__spec">{ui.description}</p>
                <button
                  type="button"
                  className="cart-palette__add"
                  disabled={limit !== null}
                  title={limit ?? `Add ${ui.label} to ${cartRegionLabel(region)}`}
                  aria-label={`Add ${ui.label} in ${cartRegionLabel(region)}`}
                  onClick={() => {
                    const result = addNode(kind, region);
                    setMessage(result.message ?? null);
                  }}
                >
                  <Plus size={15} aria-hidden="true" />
                  Add {ui.short}
                </button>
                {limit ? (
                  <p className="cart-palette__limit">{limit}</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <section className="cart-palette__circuits" aria-labelledby="cart-circuits-title">
        <h3 id="cart-circuits-title">
          <Share2 size={15} aria-hidden="true" /> Regional circuits
        </h3>
        <p>
          Paths between two regions need a circuit for that pair. All paths between the
          pair share its bandwidth.
        </p>
        {CART_CIRCUIT_PAIRS.map(([a, b]) => {
          const circuit = cartCircuitFor(graph, a, b);
          const selectId = `cart-circuit-${a}-${b}`;
          return (
            <div className="ui-field" key={selectId}>
              <label className="ui-field__label" htmlFor={selectId}>
                {cartPairLabel(a, b)}
              </label>
              <select
                id={selectId}
                className="ui-input"
                value={circuit?.mbps ?? 'none'}
                onChange={(event) => {
                  const value = event.target.value;
                  const result = setCircuit(
                    a,
                    b,
                    value === 'none'
                      ? null
                      : (Number(value) as CartCircuitMbps),
                  );
                  setMessage(result.message ?? null);
                }}
              >
                <option value="none">Not purchased</option>
                {cartCircuitTiers().map((mbps) => (
                  <option value={mbps} key={mbps}>
                    {mbps} Mbit/s per direction
                  </option>
                ))}
              </select>
              <p className="ui-field__hint">{cartCircuitLabel(graph, a, b)}</p>
            </div>
          );
        })}
      </section>

      {message ? (
        <p className="cart-palette__message" role="status">
          {message}
        </p>
      ) : null}

      <div className="cart-palette__rules">
        <h3>Rules</h3>
        <ul>
          {CART_FIXED_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
        <p>
          Path meaning: {CART_EDGE_UI.request.label} or{' '}
          {CART_EDGE_UI.replication.label}. Both are directed and both must be drawn.
        </p>
      </div>
    </div>
  );
}
