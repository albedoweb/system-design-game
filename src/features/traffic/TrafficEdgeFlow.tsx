import type { TrafficEdgeView } from './traffic-ui';
import './traffic.css';

export interface TrafficEdgeFlowProps {
  path: string;
  color: string;
  view: TrafficEdgeView | null;
}

function particleCount(view: TrafficEdgeView): number {
  const magnitude = Math.max(
    view.requestsPerSecond,
    view.bytesPerSecond ?? 0,
    1,
  );
  return Math.min(5, Math.max(1, Math.ceil(Math.log10(magnitude + 1))));
}

function particleDuration(view: TrafficEdgeView): number {
  const magnitude = Math.max(
    view.requestsPerSecond,
    view.bytesPerSecond ?? 0,
    1,
  );
  return Math.max(
    0.8,
    Math.min(3.2, 3.2 - Math.log10(magnitude + 1) * 0.7),
  );
}

/**
 * Cheap SVG/SMIL flow. The engine never reports individual packets; the number
 * and speed of dots encode a bounded visual magnitude only.
 */
export function TrafficEdgeFlow({ path, color, view }: TrafficEdgeFlowProps) {
  if (!view || !view.active || !view.animate) {
    return null;
  }
  const count = particleCount(view);
  const duration = particleDuration(view);
  return (
    <g
      className="traffic-edge-flow"
      aria-hidden="true"
      data-traffic-motion="animated"
      pointerEvents="none"
    >
      {Array.from({ length: count }, (_, index) => (
        <circle
          key={index}
          className="traffic-edge-flow__particle"
          r={index === 0 ? 3.4 : 2.7}
          fill={color}
        >
          <animateMotion
            dur={`${duration.toFixed(2)}s`}
            begin={`${(-(index * duration) / count).toFixed(2)}s`}
            repeatCount="indefinite"
            path={path}
            calcMode="linear"
          />
        </circle>
      ))}
    </g>
  );
}

export function TrafficEdgeRateBadge({ view }: { view: TrafficEdgeView | null }) {
  if (!view || !view.active) {
    return null;
  }
  const text =
    view.requestsPerSecond > 0
      ? `${Math.round(view.requestsPerSecond)}/s`
      : 'bytes/s';
  return (
    <span
      className="traffic-edge-rate"
      title={view.title}
      data-traffic-edge-rate={view.requestsPerSecond}
      data-traffic-static={view.animate ? 'false' : 'true'}
    >
      <span className="traffic-edge-rate__dot" aria-hidden="true" />
      {text}
    </span>
  );
}
