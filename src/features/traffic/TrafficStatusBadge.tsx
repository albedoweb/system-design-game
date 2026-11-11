import type { TrafficCanvasView } from './use-traffic-view';
import './traffic.css';

export function TrafficStatusBadge({ view }: { view: TrafficCanvasView }) {
  if (!view.showStatus) {
    return null;
  }
  const title =
    view.mode === 'completed'
      ? 'The run has finished. Result meters show the run average; recorded samples are optional and do not animate here.'
      : view.frame
        ? `Rates describe the last ${(view.frame.windowMs / 1000).toFixed(2)} s interval and count logical dispatch attempts, including failures — not successful throughput.`
        : 'Waiting for the first measured telemetry frame.';
  return (
    <div
      className={`traffic-status traffic-status--${view.mode}`}
      role="status"
      data-traffic-status={view.mode}
      title={title}
    >
      <span
        className={[
          'traffic-status__dot',
          view.animate ? 'is-animated' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-hidden="true"
      />
      <span>{view.modeLabel}</span>
    </div>
  );
}
