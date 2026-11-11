import {
  BaseEdge,
  EdgeLabelRenderer,
  getStraightPath,
  type EdgeProps,
} from '@xyflow/react';

import type { CanvasEdge } from './canvas-model';
import { TrafficEdgeFlow } from '../traffic/TrafficEdgeFlow';

export function DomainEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  data,
  selected,
  style,
}: EdgeProps<CanvasEdge>) {
  const [path, labelX, labelY] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });
  const color = data?.color ?? '#0e7490';
  const label = data?.label ?? 'connection';

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={18}
        style={{
          ...style,
          stroke: color,
          strokeWidth: selected ? 2.8 : 1.8,
        }}
      />
      <TrafficEdgeFlow
        path={path}
        color={color}
        view={data?.traffic ?? null}
      />
      {selected ? (
        <EdgeLabelRenderer>
          <div
            className="domain-edge-label is-selected"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              borderColor: color,
              color,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
