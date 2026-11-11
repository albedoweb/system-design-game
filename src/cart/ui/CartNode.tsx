import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

import {
  CART_KIND_UI,
  cartNodeDisplayName,
  cartNodeSummary,
  cartRegionShort,
  type CartFlowNodeData,
} from './cart-meta';

/** Canvas node data: the shared card data plus an optional measured-overload label. */
export type CartNodeFlowData = CartFlowNodeData & {
  /** Short factual overload label after a failed run, e.g. "disk wait up to 556 ms". */
  hot?: string;
};

export type CartNodeFlowNode = Node<CartNodeFlowData, 'cart-node'>;

/**
 * Semantic component card. Region is a field rather than a visual guess; the
 * lane behind the card is presentation only. Handles are deliberately generic:
 * the connection form chooses request vs replication, because the same pair of
 * nodes may carry both meanings.
 */
export function CartNode({ data, selected }: NodeProps<CartNodeFlowNode>) {
  const { node } = data;
  const ui = CART_KIND_UI[node.kind];
  const Icon = ui.icon;
  const summary = data.summary ?? cartNodeSummary(node);

  return (
    <article
      className={[
        'cart-node',
        `cart-node--${node.kind}`,
        selected ? 'is-selected' : '',
        data.issueCount > 0 ? 'is-problem' : '',
        data.hot ? 'is-hot' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      title={ui.description}
    >
      {node.kind !== 'customers' ? (
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          className="cart-node__handle cart-node__handle--in"
          title="Incoming path"
        />
      ) : null}

      <header className="cart-node__head">
        <span
          className="cart-node__icon"
          style={{ color: ui.color }}
          aria-hidden="true"
        >
          <Icon size={15} strokeWidth={2} />
        </span>
        <span className="cart-node__title">{cartNodeDisplayName(node)}</span>
        <span className="cart-node__region">{cartRegionShort(node.region)}</span>
      </header>

      {cartNodeDisplayName(node) !== ui.label ? (
        <p className="cart-node__kind">{ui.label}</p>
      ) : null}

      <ul className="cart-node__facts">
        {summary.map((fact) => (
          <li key={fact} title={fact}>{fact}</li>
        ))}
      </ul>

      {data.issueCount > 0 ? (
        <p className="cart-node__issue" role="status">
          {data.issueCount} configuration issue
          {data.issueCount === 1 ? '' : 's'}
        </p>
      ) : null}

      {data.hot ? (
        <p className="cart-node__hot" role="status">
          {data.hot}
        </p>
      ) : null}

      {node.kind !== 'inventory' ? (
        <Handle
          type="source"
          position={Position.Right}
          id="out"
          className="cart-node__handle cart-node__handle--out"
          title="Start a connection"
        />
      ) : null}
    </article>
  );
}
