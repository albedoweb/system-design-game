import { DASH } from '../../ui/format';
import type { TrafficNode } from '../../simulation/traffic-telemetry';
import {
  buildTrafficActivity,
  buildTrafficMeterRows,
  type TrafficLoadBand,
} from './traffic-ui';
import type { TrafficLevelId } from './traffic-store';
import './traffic.css';

export interface TrafficNodeMetersProps {
  levelId: TrafficLevelId;
  kind: string;
  node: TrafficNode | null;
  modeLabel: string;
  /** A frame for this node is currently displayed. */
  sampleActive: boolean;
  animate: boolean;
  /** Before any result, keep neutral dashed rows instead of hiding the metric. */
  showPlaceholder: boolean;
}

function BlockMeter({
  label,
  filled,
  band,
  accessible,
  values,
}: {
  label: string;
  filled: number;
  band: TrafficLoadBand | null;
  accessible: string;
  values: { used: number | null; capacity: number | null } | null;
}) {
  const measurable =
    values !== null &&
    values.capacity !== null &&
    Number.isFinite(values.capacity) &&
    values.capacity > 0;
  return (
    <span
      className={[
        'traffic-meter__blocks',
        band ? `traffic-meter__blocks--${band}` : 'traffic-meter__blocks--unknown',
      ].join(' ')}
      role={measurable ? 'meter' : 'img'}
      aria-label={`${label} utilization`}
      {...(measurable
        ? {
            'aria-valuemin': 0,
            'aria-valuemax': values?.capacity ?? undefined,
            'aria-valuenow': values?.used ?? undefined,
          }
        : {})}
      aria-valuetext={accessible}
      title={accessible}
    >
      {Array.from({ length: 10 }, (_, index) => (
        <span
          key={index}
          className={index < filled ? 'is-filled' : ''}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

export function TrafficNodeMeters({
  levelId,
  kind,
  node,
  modeLabel,
  sampleActive,
  animate,
  showPlaceholder,
}: TrafficNodeMetersProps) {
  if (!showPlaceholder && !sampleActive) {
    return null;
  }
  const activity = buildTrafficActivity(node);
  const rows = buildTrafficMeterRows(levelId, kind, node);
  const placeholder = node === null;

  return (
    <div
      className={[
        'traffic-node',
        sampleActive ? 'is-sampled' : 'is-awaiting',
        placeholder && showPlaceholder ? 'has-placeholder' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-traffic-node="true"
      data-traffic-state={activity.state}
      data-traffic-placeholder={placeholder && showPlaceholder ? 'true' : 'false'}
      aria-label={`Live traffic: ${modeLabel}`}
    >
      <div className="traffic-node__head">
        <span
          className={[
            'traffic-node__dot',
            `traffic-node__dot--${activity.state}`,
            animate && activity.state === 'active' ? 'is-animated' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-hidden="true"
        />
        <span className="traffic-node__activity" title={activity.title}>
          {activity.text}
        </span>
        {activity.queueText ? (
          <span className="traffic-node__queue">{activity.queueText}</span>
        ) : null}
        <span className="traffic-node__mode" title={modeLabel}>
          {modeLabel}
        </span>
      </div>
      {rows.length > 0 ? (
        <div className="traffic-node__meters">
          {rows.map((row) => (
            <div className="traffic-meter" key={row.key}>
              <span className="traffic-meter__label">{row.label}</span>
              <BlockMeter
                label={row.label}
                filled={row.filled}
                band={row.band}
                accessible={row.accessible}
                values={
                  row.placeholder
                    ? null
                    : { used: row.used, capacity: row.capacity }
                }
              />
              <span className="traffic-meter__value" title={row.title}>
                {row.placeholder ? DASH : row.valueText}
              </span>
              <span className="traffic-meter__secondary" title={row.title}>
                {row.secondaryText}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
