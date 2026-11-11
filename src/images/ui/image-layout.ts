import {
  IMAGE_COMPONENT_LIMITS,
  type ImageGraph,
  type ImageNode,
  type ImageNodeKind,
  type ImagePosition,
  type ImageRegion,
} from '../contracts';
import { IMAGE_REGION_ORDER } from './image-meta';

/**
 * Canvas geometry for the regional grouping.
 *
 * The lanes are pure presentation: they never enter the graph document and
 * never change semantics. Positions remain editable data, and "Group by
 * region" writes ordinary node positions so the layout is undoable and
 * exportable like any other edit.
 */
/** Band height and the reserved header strip above the node row. */
export const IMAGE_LANE_HEIGHT = 234;
export const IMAGE_LANE_TOP_PADDING = 44;
/** Minimum band extents; the band also grows to hug the nodes it contains. */
export const IMAGE_LANE_LEFT = -940;
export const IMAGE_LANE_WIDTH = 1900;
export const IMAGE_NODE_WIDTH = 240;

/** Anchor is the authored top-left y of a node row in the frozen starter. */
export const IMAGE_LANE_ANCHOR_Y: Readonly<Record<ImageRegion, number>> = {
  na: -240,
  eu: 0,
  ap: 240,
};

/** Left x of each kind column for a grouped layout. */
export const IMAGE_KIND_COLUMN_X: Readonly<Record<ImageNodeKind, number>> = {
  client: -900,
  app: -520,
  metadata: -140,
  cache: 260,
  blob: 700,
};

/** The schema range, exposed so React Flow and the store share one bound. */
export const IMAGE_MIN_COORDINATE = IMAGE_COMPONENT_LIMITS.position.min;
export const IMAGE_MAX_COORDINATE = IMAGE_COMPONENT_LIMITS.position.max;

/** React Flow cannot drag a node outside the frozen position limits. */
export const IMAGE_NODE_EXTENT: [[number, number], [number, number]] = [
  [IMAGE_MIN_COORDINATE, IMAGE_MIN_COORDINATE],
  [IMAGE_MAX_COORDINATE, IMAGE_MAX_COORDINATE],
];

/**
 * Clamps one authored position into the frozen range. Non-finite coordinates
 * are rejected with `null` so a broken drag/import can never be written.
 */
export function clampImagePosition(
  position: ImagePosition,
): ImagePosition | null {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    return null;
  }
  return {
    x: Math.min(IMAGE_MAX_COORDINATE, Math.max(IMAGE_MIN_COORDINATE, position.x)),
    y: Math.min(IMAGE_MAX_COORDINATE, Math.max(IMAGE_MIN_COORDINATE, position.y)),
  };
}

function boundedPosition(position: ImagePosition): ImagePosition {
  return clampImagePosition(position) ?? { x: 0, y: 0 };
}

export const IMAGE_KIND_ORDER: readonly ImageNodeKind[] = [
  'client',
  'app',
  'metadata',
  'cache',
  'blob',
];

export interface ImageRegionLane {
  region: ImageRegion;
  top: number;
  bottom: number;
  left: number;
  width: number;
}

/**
 * The band row is fixed per region; its horizontal extent hugs the nodes of
 * that region so a wide or compact arrangement never leaves a mostly empty
 * background that forces an unreadable fit-to-view zoom.
 */
export function imageRegionLane(
  region: ImageRegion,
  nodes: readonly ImageNode[] = [],
): ImageRegionLane {
  const top = IMAGE_LANE_ANCHOR_Y[region] - IMAGE_LANE_TOP_PADDING;
  const members = nodes.filter((node) => node.region === region);
  if (members.length === 0) {
    return {
      region,
      top,
      bottom: top + IMAGE_LANE_HEIGHT,
      left: IMAGE_LANE_LEFT,
      width: IMAGE_LANE_WIDTH,
    };
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const node of members) {
    minX = Math.min(minX, node.position.x);
    maxX = Math.max(maxX, node.position.x);
  }
  const left = Math.min(minX - 40, IMAGE_LANE_LEFT);
  const right = Math.max(
    maxX + IMAGE_NODE_WIDTH + 40,
    IMAGE_LANE_LEFT + IMAGE_LANE_WIDTH,
  );
  return {
    region,
    top,
    bottom: top + IMAGE_LANE_HEIGHT,
    left,
    width: right - left,
  };
}

export const IMAGE_REGION_LANES: readonly ImageRegionLane[] =
  IMAGE_REGION_ORDER.map((region) => imageRegionLane(region));

/**
 * A node is inside its lane when its authored row is inside the band. The check
 * is presentation-only and drives the "Arrange" hint; it never blocks a run.
 */
export function imageNodeOutsideRegionLane(node: ImageNode): boolean {
  const lane = imageRegionLane(node.region);
  const bottomLimit = lane.bottom - 60;
  return node.position.y < lane.top - 4 || node.position.y > bottomLimit;
}

function groupByRegion(nodes: readonly ImageNode[]): Map<ImageRegion, ImageNode[]> {
  const groups = new Map<ImageRegion, ImageNode[]>();
  for (const region of IMAGE_REGION_ORDER) {
    groups.set(region, []);
  }
  for (const node of nodes) {
    groups.get(node.region)?.push(node);
  }
  return groups;
}

/**
 * Deterministic grouped layout: one labelled lane per region and one column per
 * kind. Extra nodes of the same kind in one region are stacked symmetrically.
 * Only positions change, so the semantic digest is unaffected.
 */
export function imageArrangeByRegion(graph: ImageGraph): ImageGraph {
  const groups = groupByRegion(graph.nodes);
  const positions = new Map<string, { x: number; y: number }>();
  for (const [region, nodes] of groups) {
    const anchor = IMAGE_LANE_ANCHOR_Y[region];
    const byKind = new Map<ImageNodeKind, ImageNode[]>();
    for (const kind of IMAGE_KIND_ORDER) {
      byKind.set(kind, []);
    }
    for (const node of nodes) {
      byKind.get(node.kind)?.push(node);
    }
    for (const [kind, columnNodes] of byKind) {
      const sorted = [...columnNodes].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
      sorted.forEach((node, index) => {
        const offset = (index - (sorted.length - 1) / 2) * 196;
        positions.set(
          node.id,
          boundedPosition({
            x: IMAGE_KIND_COLUMN_X[kind],
            y: Math.round(anchor + offset),
          }),
        );
      });
    }
  }
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const position = positions.get(node.id);
      return position ? { ...node, position } : node;
    }),
  };
}

/** Free position near a lane anchor for a newly added node. */
export function imageNewNodePosition(
  graph: ImageGraph,
  kind: ImageNodeKind,
  region: ImageRegion,
): { x: number; y: number } {
  const anchor = IMAGE_LANE_ANCHOR_Y[region];
  const columnNodes = graph.nodes
    .filter((node) => node.region === region && node.kind === kind)
    .sort((left, right) => left.position.y - right.position.y);
  return boundedPosition({
    x: IMAGE_KIND_COLUMN_X[kind],
    y: anchor + columnNodes.length * 196,
  });
}
