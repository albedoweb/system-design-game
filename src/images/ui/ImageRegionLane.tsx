import type { Node, NodeProps } from '@xyflow/react';

import type { ImageRegion } from '../contracts';
import { IMAGE_LANE_HEIGHT } from './image-layout';
import { IMAGE_REGION_LABELS, IMAGE_REGION_SHORT } from './image-meta';

export interface ImageRegionLaneData extends Record<string, unknown> {
  region: ImageRegion;
  nodeCount: number;
  problem: string | null;
  note: string;
  width: number;
}

export type ImageRegionLaneNode = Node<ImageRegionLaneData, 'image-region'>;

/**
 * Presentation-only background band. It is not part of the graph document and
 * carries no handles, so it cannot be selected, connected or exported. The
 * region semantics live on the nodes themselves.
 */
export function ImageRegionLaneNodeView({
  data,
}: NodeProps<ImageRegionLaneNode>) {
  return (
    <div
      className={[
        'image-lane',
        `image-lane--${data.region}`,
        data.problem ? 'image-lane--problem' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ width: data.width, height: IMAGE_LANE_HEIGHT }}
      aria-hidden="true"
    >
      <div className="image-lane__head">
        <span className={`image-lane__chip image-lane__chip--${data.region}`}>
          {IMAGE_REGION_SHORT[data.region]}
        </span>
        <span className="image-lane__title">{IMAGE_REGION_LABELS[data.region]}</span>
        <span className="image-lane__meta">
          {data.nodeCount} node{data.nodeCount === 1 ? '' : 's'}
        </span>
      </div>
      <p className="image-lane__note">{data.note}</p>
      {data.problem ? <p className="image-lane__problem">{data.problem}</p> : null}
    </div>
  );
}
