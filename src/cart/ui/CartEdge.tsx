import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';

import { CART_EDGE_UI, type CartFlowEdgeData } from './cart-meta';

/** Canvas edge data: the shared path data plus live-run flags set by CartCanvas. */
export type CartEdgeFlowData = CartFlowEdgeData & {
  /** True while a run is advancing: traffic animates along the path. */
  flowing?: boolean;
  /** Circuit overload label when this cross-region path rides a hot circuit. */
  hot?: string;
};

export type CartEdgeFlowEdge = Edge<CartEdgeFlowData, 'cart-edge'>;

/**
 * One drawn semantic path. Cross-region labels always name the shared circuit:
 * a second arrow never becomes a second cable, so the visual weight never
 * grows with the number of arrows.
 */
export function CartEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  data,
  selected,
  style,
}: EdgeProps<CartEdgeFlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    borderRadius: 14,
  });

  if (!data) {
    return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />;
  }

  const ui = CART_EDGE_UI[data.edge.kind];
  const flowing = data.flowing === true;
  const hot = data.hot;
  const showLabel = selected || data.crossRegion || Boolean(data.roles) || Boolean(hot);
  const baseLabel = data.crossRegion
    ? `${data.roles || ui.label} · ${data.circuit}`
    : data.roles || ui.label;
  // The measured wait is written once in the lane header; here the path only turns amber.
  const label = baseLabel;
  // Request paths get a moving overlay above the solid line; replication paths are
  // already dashed, so their own dash pattern is what moves.
  const movingOverlay = flowing && !ui.dash;
  const movingDashes = flowing && Boolean(ui.dash);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={18}
        className={movingDashes ? 'cart-edge__base cart-edge__base--replication' : undefined}
        style={{
          ...style,
          stroke: hot ? 'var(--warning)' : ui.color,
          strokeWidth: selected ? 2.4 : 1.6,
          strokeDasharray: ui.dash,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }}
      />
      {movingOverlay ? (
        <path
          d={path}
          className="cart-edge__flow"
          fill="none"
          stroke={ui.color}
          strokeWidth={2.4}
          strokeLinecap="round"
          pointerEvents="none"
          aria-hidden="true"
        />
      ) : null}
      {showLabel ? (
        <EdgeLabelRenderer>
          <div
            className={[
              'cart-edge-label',
              `cart-edge-label--${data.edge.kind}`,
              selected ? 'is-selected' : '',
              hot ? 'is-hot' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              color: hot ? 'var(--warning)' : ui.color,
            }}
            title={
              data.crossRegion
                ? `All paths between these regions share one ${data.circuit} circuit per direction. More arrows add no capacity.`
                : `${data.fromLabel} → ${data.toLabel}`
            }
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
