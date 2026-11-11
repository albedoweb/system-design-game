import {
  BaseEdge,
  EdgeLabelRenderer,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';

import type { ImageOperation } from '../contracts';
import type { ImageProblem } from './image-diagnostics';
import type { TrafficEdgeView } from '../../features/traffic/traffic-ui';
import {
  TrafficEdgeFlow,
  TrafficEdgeRateBadge,
} from '../../features/traffic/TrafficEdgeFlow';
import {
  imageLogicalEdgeNote,
  type ImageEdgeLane,
} from './image-canvas-model';
import { IMAGE_OPERATION_META } from './image-meta';
import { useImageStore } from './image-store';

export interface ImageCanvasEdgeData extends Record<string, unknown> {
  operation: ImageOperation;
  label: string;
  color: string;
  dash: string | undefined;
  lane: ImageEdgeLane | null;
  problem: ImageProblem | null;
  traffic: TrafficEdgeView | null;
}

export type ImageCanvasEdge = Edge<ImageCanvasEdgeData, 'image'>;

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
  return {
    path: `M ${sourceX},${sourceY} Q ${controlX},${controlY} ${targetX},${targetY}`,
    labelX: (sourceX + 2 * controlX + targetX) / 4,
    labelY: (sourceY + 2 * controlY + targetY) / 4,
  };
}

export function ImageEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  data,
  selected,
  style,
}: EdgeProps<ImageCanvasEdge>) {
  const select = useImageStore((state) => state.select);
  const operation = data?.operation ?? 'traffic';
  const meta = IMAGE_OPERATION_META[operation];
  const color = data?.color ?? meta.color;
  const label = data?.label ?? meta.label;
  const problem = data?.problem ?? null;
  const { path, labelX, labelY } = curvePath(
    sourceX,
    sourceY,
    targetX,
    targetY,
    data?.lane?.offset ?? 0,
  );
  const strokeWidth = selected ? 3.2 : problem ? 2.6 : 2;
  // Route identity is structural: the operation colour and label stay normal
  // even when an old result becomes stale. Only the result panel marks the
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
          ...(meta.dash ? { strokeDasharray: meta.dash } : {}),
        }}
      />
      <TrafficEdgeFlow path={path} color={color} view={data?.traffic ?? null} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={[
            'image-edge-label',
            selected ? 'is-selected' : '',
            problem ? `image-edge-label--${problem.severity}` : '',
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
              ? `${problem.messages.join(' · ')} — ${imageLogicalEdgeNote(operation)}`
              : data?.traffic
                ? data.traffic.title
                : imageLogicalEdgeNote(operation)
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
