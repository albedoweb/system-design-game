import {
  BaseEdge,
  EdgeLabelRenderer,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';

import type { AudienceLinkRole } from '../index';
import { audienceLinkLabel } from './audience-meta';
import type { AudienceProblem } from './audience-diagnostics';
import type { TrafficEdgeView } from '../../features/traffic/traffic-ui';
import {
  TrafficEdgeFlow,
  TrafficEdgeRateBadge,
} from '../../features/traffic/TrafficEdgeFlow';
import { useAudienceStore } from './audience-store';

export interface AudienceCanvasEdgeData extends Record<string, unknown> {
  role: AudienceLinkRole | null;
  label: string;
  color: string;
  problem: AudienceProblem | null;
  traffic: TrafficEdgeView | null;
}

export type AudienceCanvasEdge = Edge<AudienceCanvasEdgeData, 'audience'>;

export function AudienceEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  data,
  selected,
  style,
}: EdgeProps<AudienceCanvasEdge>) {
  const select = useAudienceStore((state) => state.select);
  const color = data?.color ?? '#1d4ed8';
  const label = data?.label ?? 'read / write';
  const problem = data?.problem ?? null;
  const problemTone =
    problem === null ? null : problem.runtime ? problem.severity : 'validation';
  const problemWord =
    problem === null
      ? ''
      : problem.runtime
        ? `, ${problem.severity}`
        : ', validation check';
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.hypot(dx, dy) || 1;
  const offset = Math.min(34, length * 0.12);
  const midX = (sourceX + targetX) / 2;
  const midY = (sourceY + targetY) / 2;
  const controlX = midX + (-dy / length) * offset;
  const controlY = midY + (dx / length) * offset;
  const labelX = (sourceX + 2 * controlX + targetX) / 4;
  const labelY = (sourceY + 2 * controlY + targetY) / 4;
  const path = `M ${sourceX},${sourceY} Q ${controlX},${controlY} ${targetX},${targetY}`;
  const strokeWidth = selected ? 3.2 : problem ? 2.6 : 2;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={28}
        style={{ ...style, stroke: color, strokeWidth }}
      />
      <TrafficEdgeFlow path={path} color={color} view={data?.traffic ?? null} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={[
            'audience-edge-label',
            selected ? 'is-selected' : '',
            problemTone ? `audience-edge-label--${problemTone}` : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            borderColor: color,
            color,
          }}
          onClick={(event) => {
            event.stopPropagation();
            select({ type: 'edge', id });
          }}
          aria-label={`Select ${audienceLinkLabel(
            data?.role ?? null,
          )} connection${problemWord}`}
          title={
            problem
              ? problem.messages.join(' · ')
              : data?.traffic
                ? data.traffic.title
                : `${label} connection`
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
