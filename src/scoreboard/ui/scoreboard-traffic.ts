import type { TrafficFrame } from '../../simulation/traffic-telemetry';
import type { TrafficLevelId } from '../../features/traffic/traffic-store';
import type { ScoreboardTrafficFrame } from '../index';
import { useTrafficCanvasView } from '../../features/traffic/use-traffic-view';

/**
 * Typed bridge to the shared observed-traffic view. The worker boundary
 * validates level, run id and bounds before frames enter the shared store.
 */
export const SCOREBOARD_TRAFFIC_LEVEL: TrafficLevelId = 'live-scoreboard';

export function asSharedTrafficFrame(
  frame: ScoreboardTrafficFrame,
): TrafficFrame {
  return frame;
}

export function useScoreboardTrafficView(runId: string | null) {
  return useTrafficCanvasView(SCOREBOARD_TRAFFIC_LEVEL, runId);
}
