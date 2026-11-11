import type {
  AudienceCaseResult,
  AudienceSeriesPoint,
  AudienceTrafficFrame,
} from '../index';
import { formatDecimal } from '../../ui/format';
import type { TrafficFrame, TrafficNode } from '../../simulation/traffic-telemetry';
import type { TrafficNodeView } from '../../features/traffic/traffic-ui';

export interface AudienceCaseFrameMatch {
  frame: TrafficFrame;
  index: number;
}

/** Frames recorded for one case only; the engine keeps them time-ordered. */
export function audienceCaseFrames(
  caseResult: AudienceCaseResult | null,
): readonly AudienceTrafficFrame[] {
  if (!caseResult) {
    return [];
  }
  return [...caseResult.trafficFrames].sort(
    (left, right) => left.timeMs - right.timeMs,
  );
}

export function nearestAudienceFrame(
  frames: readonly TrafficFrame[],
  timeMs: number | null,
): AudienceCaseFrameMatch | null {
  if (frames.length === 0 || timeMs === null || !Number.isFinite(timeMs)) {
    return null;
  }
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  frames.forEach((frame, index) => {
    const distance = Math.abs(frame.timeMs - timeMs);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  const frame = frames[best];
  return frame === undefined ? null : { frame, index: best };
}

export function nearestAudienceSeriesPoint(
  points: readonly AudienceSeriesPoint[],
  timeMs: number | null,
): AudienceSeriesPoint | null {
  if (points.length === 0 || timeMs === null || !Number.isFinite(timeMs)) {
    return null;
  }
  let best = points[0] ?? null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const distance = Math.abs(point.timeMs - timeMs);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

export function audienceTrafficNodesById(
  frame: TrafficFrame | null,
): ReadonlyMap<string, TrafficNode> {
  return new Map((frame?.nodes ?? []).map((node) => [node.nodeId, node]));
}

export function audienceTrafficEdgesById(
  frame: TrafficFrame | null,
) {
  return new Map((frame?.edges ?? []).map((edge) => [edge.edgeId, edge]));
}

/**
 * A recorded case frame is never presented as live. `playing` only animates
 * the measured replay the player explicitly started.
 */
export function audienceFrameModeLabel(
  frame: TrafficFrame | null,
  playing: boolean,
  caseLabel: string | null,
): string {
  if (!frame) {
    return caseLabel ? `${caseLabel} · summary` : 'Awaiting run';
  }
  const time = `t=${formatDecimal(frame.timeMs / 1000, 1)} s`;
  return `${playing ? 'Recorded replay' : 'Recorded frame'} · ${
    caseLabel ?? frame.scopeLabel
  } · ${time}`;
}

export function audienceTrafficNodeView(input: {
  node: TrafficNode | null;
  modeLabel: string;
  sampleActive: boolean;
  animate: boolean;
  showPlaceholder: boolean;
}): TrafficNodeView {
  return {
    node: input.node,
    modeLabel: input.modeLabel,
    sampleActive: input.sampleActive,
    animate: input.animate,
    showPlaceholder: input.showPlaceholder,
  };
}
