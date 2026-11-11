import {
  BaseEdge,
  EdgeLabelRenderer,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';

import type { ParcelOperation } from '../contracts';
import type { ParcelProblem } from './parcel-diagnostics';
import type { TrafficEdgeView } from '../../features/traffic/traffic-ui';
import {
  TrafficEdgeFlow,
  TrafficEdgeRateBadge,
} from '../../features/traffic/TrafficEdgeFlow';
import { PARCEL_OPERATION_META } from './parcel-meta';
import { useParcelStore } from './parcel-store';

export interface ParcelCanvasEdgeData extends Record<string, unknown> {
  operation: ParcelOperation;
  label: string;
  color: string;
  laneOffset: number;
  problem: ParcelProblem | null;
  traffic: TrafficEdgeView | null;
}

export type ParcelCanvasEdge = Edge<ParcelCanvasEdgeData, 'parcel'>;

function curvePath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  offset: number,
): { path: string; labelX: number; labelY: number } {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.hypot(dx, dy) || 1;
  const midX = (sourceX + targetX) / 2;
  const midY = (sourceY + targetY) / 2;
  const controlX = midX + (-dy / length) * offset;
  const controlY = midY + (dx / length) * offset;
  const labelX = (sourceX + 2 * controlX + targetX) / 4;
  const labelY = (sourceY + 2 * controlY + targetY) / 4;
  return {
    path: `M ${sourceX},${sourceY} Q ${controlX},${controlY} ${targetX},${targetY}`,
    labelX,
    labelY,
  };
}

export function ParcelEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  data,
  selected,
  style,
}: EdgeProps<ParcelCanvasEdge>) {
  const select = useParcelStore((state) => state.select);
  const operation = data?.operation ?? 'traffic';
  const color = data?.color ?? PARCEL_OPERATION_META[operation].color;
  const label = data?.label ?? PARCEL_OPERATION_META[operation].label;
  const problem = data?.problem ?? null;
  const { path, labelX, labelY } = curvePath(
    sourceX,
    sourceY,
    targetX,
    targetY,
    data?.laneOffset ?? 0,
  );
  const strokeWidth = selected ? 3.2 : problem ? 2.6 : 2;
  // Route identity is stable: operation color and label stay normal even when
  // an old evaluation result becomes stale. Only the result panel marks the
  // measurement as previous; stale measured problems never reach this styling.
  const stroke = color;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={28}
        style={{
          ...style,
          stroke,
          strokeWidth,
        }}
      />
      <TrafficEdgeFlow path={path} color={color} view={data?.traffic ?? null} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={[
            'parcel-edge-label',
            selected ? 'is-selected' : '',
            problem ? `parcel-edge-label--${problem.severity}` : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            borderColor: stroke,
            color: stroke,
          }}
          onClick={(event) => {
            event.stopPropagation();
            select({ type: 'edge', id });
          }}
          aria-label={`Select ${label} route${problem ? `, ${problem.severity}` : ''}`}
          title={
            problem
              ? problem.messages.join(' · ')
              : data?.traffic
                ? data.traffic.title
                : `${label}: ${PARCEL_OPERATION_META[operation].description}`
          }
        >
          {label}
          {problem ? ' !' : ''}
          <TrafficEdgeRateBadge view={data?.traffic ?? null} />
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
