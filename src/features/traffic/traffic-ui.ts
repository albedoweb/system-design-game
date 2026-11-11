import { DASH, formatDecimal, formatInteger } from '../../ui/format';
import type {
  TrafficEdge,
  TrafficFrame,
  TrafficNode,
  TrafficResource,
} from '../../simulation/traffic-telemetry';
import type { TrafficLevelId, TrafficMode } from './traffic-store';

export type TrafficLoadBand =
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'dark-red';

export const TRAFFIC_LOAD_BAND_TITLES: Readonly<
  Record<TrafficLoadBand, string>
> = {
  green: 'green: under 50% of capacity',
  yellow: 'yellow: 50% up to but not including 70%',
  orange: 'orange: 70% up to but not including 85%',
  red: 'red: 85% up to but not including 100%',
  'dark-red': 'dark red: at or above capacity',
};

/** Five disclosed bands shared by all three levels. Null means unknown. */
export function trafficLoadBand(
  fraction: number | null | undefined,
): TrafficLoadBand | null {
  if (
    fraction === null ||
    fraction === undefined ||
    !Number.isFinite(fraction) ||
    fraction < 0
  ) {
    return null;
  }
  if (fraction >= 1) {
    return 'dark-red';
  }
  if (fraction >= 0.85) {
    return 'red';
  }
  if (fraction >= 0.7) {
    return 'orange';
  }
  if (fraction >= 0.5) {
    return 'yellow';
  }
  return 'green';
}

export function trafficFilledBlocks(
  fraction: number | null | undefined,
): number {
  const band = trafficLoadBand(fraction);
  if (
    band === null ||
    fraction === null ||
    fraction === undefined ||
    fraction <= 0
  ) {
    return 0;
  }
  if (band === 'dark-red') {
    return 10;
  }
  return Math.min(9, Math.max(1, Math.round(Math.min(1, fraction) * 10)));
}

export function formatTrafficPercent(
  fraction: number | null | undefined,
  digits = 0,
): string {
  if (
    fraction === null ||
    fraction === undefined ||
    !Number.isFinite(fraction)
  ) {
    return DASH;
  }
  return `${formatDecimal(fraction * 100, digits)}%`;
}

export function formatTrafficRate(
  requestsPerSecond: number | null | undefined,
): string {
  if (
    requestsPerSecond === null ||
    requestsPerSecond === undefined ||
    !Number.isFinite(requestsPerSecond)
  ) {
    return DASH;
  }
  return `${formatInteger(requestsPerSecond)} req/s`;
}

export function formatTrafficBytesRate(
  bytesPerSecond: number | null | undefined,
): string {
  if (
    bytesPerSecond === null ||
    bytesPerSecond === undefined ||
    !Number.isFinite(bytesPerSecond)
  ) {
    return DASH;
  }
  return `${formatDataRate(bytesPerSecond)}/s`;
}

function formatDataRate(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = value < 10 && unit > 0 ? 2 : value < 100 && unit > 0 ? 1 : 0;
  return `${formatDecimal(value, digits)} ${units[unit]}`;
}

function formatResourceNumber(
  value: number | null | undefined,
  unit: TrafficResource['unit'],
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return DASH;
  }
  switch (unit) {
    case 'gbit/s':
      return `${formatDecimal(value, value < 10 ? 2 : 1)} Gbit/s`;
    case 'bytes':
      return formatDataRate(value);
    case 'slots':
    case 'connections':
    case 'cores':
    case 'lanes':
      return formatInteger(value);
    default:
      return formatDecimal(value, 2);
  }
}

function unitShort(unit: TrafficResource['unit']): string {
  switch (unit) {
    case 'slots':
      return 'slots';
    case 'connections':
      return 'connections';
    case 'cores':
      return 'cores';
    case 'lanes':
      return 'lanes';
    case 'bytes':
      return 'bytes';
    case 'gbit/s':
      return 'Gbit/s';
    default:
      return unit;
  }
}

export function trafficAggregationText(
  resource: Pick<TrafficResource, 'aggregation'>,
): string {
  if (resource.aggregation === 'window-average') {
    return 'Sampled as an interval average.';
  }
  if (resource.aggregation === 'instant') {
    return 'Sampled as an instant value.';
  }
  return 'Sampling mode not specified by the engine.';
}

export type TrafficMetricCategory = 'cpu' | 'io' | 'ram' | 'net' | 'other';

export function trafficResourceCategory(
  resource: Pick<TrafficResource, 'key' | 'label'>,
): TrafficMetricCategory {
  const text = `${resource.key} ${resource.label}`.toLowerCase();
  if (/(^|\W)cpu(\W|$)/.test(text) || text.includes('core')) {
    return 'cpu';
  }
  if (/(^|\W)io(\W|$)/.test(text) || text.includes('disk')) {
    return 'io';
  }
  if (text.includes('ram') || text.includes('memory')) {
    return 'ram';
  }
  if (
    text.includes('net') ||
    text.includes('bandwidth') ||
    text.includes('ingress') ||
    text.includes('egress') ||
    /(^|\W)(rx|tx)(\W|$)/.test(text)
  ) {
    return 'net';
  }
  return 'other';
}

interface ExpectedMetric {
  key: string;
  label: string;
  category: Exclude<TrafficMetricCategory, 'other'>;
}

/**
 * The rows a level is expected to explain even before telemetry arrives. The
 * engine may omit a resource; the UI still keeps a neutral, dashed row rather
 * than hiding it or inventing a zero.
 */
export function expectedTrafficMetrics(
  levelId: TrafficLevelId,
  kind: string,
): readonly ExpectedMetric[] {
  if (levelId === 'parcel-pulse') {
    if (kind === 'client') {
      return [];
    }
    return [
      { key: 'cpu', label: 'CPU', category: 'cpu' },
      { key: 'io', label: 'IO', category: 'io' },
      { key: 'net', label: 'Net', category: 'net' },
    ];
  }
  if (levelId === 'image-atlas') {
    if (kind === 'client' || kind === 'blob') {
      return [{ key: 'net', label: 'Net', category: 'net' }];
    }
    return [
      { key: 'cpu', label: 'CPU', category: 'cpu' },
      { key: 'ram', label: 'RAM', category: 'ram' },
      { key: 'io', label: 'IO', category: 'io' },
      { key: 'net', label: 'Net', category: 'net' },
    ];
  }
  return [];
}

export interface TrafficMeterRow {
  key: string;
  label: string;
  unit: TrafficResource['unit'];
  used: number | null;
  capacity: number | null;
  fraction: number | null;
  band: TrafficLoadBand | null;
  filled: number;
  valueText: string;
  secondaryText: string;
  accessible: string;
  title: string;
  placeholder: boolean;
  aggregation: TrafficResource['aggregation'];
}

function placeholderRow(metric: ExpectedMetric): TrafficMeterRow {
  const accessible = `${metric.label}: no live sample for this node yet. This is unknown, not a measured zero.`;
  return {
    key: `placeholder-${metric.key}`,
    label: metric.label,
    unit: 'cores',
    used: null,
    capacity: null,
    fraction: null,
    band: null,
    filled: 0,
    valueText: DASH,
    secondaryText: 'no sample',
    accessible,
    title: accessible,
    placeholder: true,
    aggregation: undefined,
  };
}

function resourceRow(
  resource: TrafficResource,
  label = resource.label,
): TrafficMeterRow {
  const used =
    resource.used !== null && Number.isFinite(resource.used)
      ? resource.used
      : null;
  const capacity =
    resource.capacity !== null &&
    Number.isFinite(resource.capacity) &&
    resource.capacity > 0
      ? resource.capacity
      : null;
  const fraction =
    used !== null && capacity !== null ? used / capacity : null;
  const band = trafficLoadBand(fraction);
  const aggregation = trafficAggregationText(resource);
  const usedText = formatResourceNumber(used, resource.unit);
  const capacityText = formatResourceNumber(capacity, resource.unit);
  const unitText = unitShort(resource.unit);
  const valueText =
    fraction !== null ? formatTrafficPercent(fraction) : usedText;
  const secondaryText =
    capacity !== null
      ? `${usedText} / ${capacityText} ${unitText}`
      : used === null
        ? 'no sample'
        : 'no finite capacity';
  const percentText =
    fraction !== null
      ? `${formatTrafficPercent(fraction)} used`
      : 'utilization not defined';
  const bandText = band ? ` ${TRAFFIC_LOAD_BAND_TITLES[band]}.` : '';
  const accessible =
    used === null
      ? `${label}: no measured value. ${aggregation}`
      : capacity !== null
        ? `${label}: ${percentText}, ${usedText} of ${capacityText} ${unitText}. ${aggregation}${bandText}`
        : `${label}: ${usedText}. The model defines no capacity for this resource, so no utilization percentage is shown. ${aggregation}`;
  return {
    key: resource.key,
    label,
    unit: resource.unit,
    used,
    capacity,
    fraction,
    band,
    filled: trafficFilledBlocks(fraction),
    valueText,
    secondaryText,
    accessible,
    title: `${label} · ${accessible}`,
    placeholder: false,
    aggregation: resource.aggregation,
  };
}

function netRowLabel(resource: TrafficResource, netCount: number): string {
  const base = resource.label || 'Net';
  if (netCount <= 1) {
    return base;
  }
  const text = `${resource.key} ${resource.label}`.toLowerCase();
  if (text.includes('ingress') || /(^|\W)rx(\W|$)/.test(text)) {
    return `${base} Rx`;
  }
  if (text.includes('egress') || /(^|\W)tx(\W|$)/.test(text)) {
    return `${base} Tx`;
  }
  return base;
}

/**
 * Rows shown on a node card. Expected metrics come first in level order; any
 * additional measured resource is appended so telemetry cannot silently hide.
 */
export function buildTrafficMeterRows(
  levelId: TrafficLevelId,
  kind: string,
  node: TrafficNode | null,
): readonly TrafficMeterRow[] {
  const expected = expectedTrafficMetrics(levelId, kind);
  const resources = node?.resources ?? [];
  const consumed = new Set<TrafficResource>();
  const rows: TrafficMeterRow[] = [];
  const netResources = resources.filter(
    (resource) => trafficResourceCategory(resource) === 'net',
  );

  for (const metric of expected) {
    if (metric.category === 'net' && netResources.length > 0) {
      for (const resource of netResources) {
        consumed.add(resource);
        rows.push(resourceRow(resource, netRowLabel(resource, netResources.length)));
      }
      continue;
    }
    const match = resources.find(
      (resource) =>
        !consumed.has(resource) &&
        trafficResourceCategory(resource) === metric.category,
    );
    if (match) {
      consumed.add(match);
      rows.push(resourceRow(match, metric.label));
    } else {
      rows.push(placeholderRow(metric));
    }
  }

  for (const resource of resources) {
    if (consumed.has(resource)) {
      continue;
    }
    rows.push(resourceRow(resource));
  }
  return rows;
}

export type TrafficActivityState = 'unknown' | 'active' | 'idle' | 'down';

export interface TrafficActivity {
  state: TrafficActivityState;
  text: string;
  queueText: string | null;
  title: string;
}

export function buildTrafficActivity(node: TrafficNode | null): TrafficActivity {
  const basis =
    'Counts logical dispatch attempts in the interval, including attempts that may fail; not successful throughput.';
  if (!node) {
    return {
      state: 'unknown',
      text: 'No live sample',
      queueText: null,
      title: `No measured frame for this node yet. ${basis}`,
    };
  }
  if (node.down) {
    return {
      state: 'down',
      text: 'Down',
      queueText:
        node.queue === null || !Number.isFinite(node.queue)
          ? null
          : `queue ${formatInteger(node.queue)}`,
      title: `The node is reported down in this frame. ${basis}`,
    };
  }
  if (node.requestsPerSecond === null) {
    return {
      state: 'unknown',
      text: 'Requests —',
      queueText:
        node.queue === null || !Number.isFinite(node.queue)
          ? null
          : `queue ${formatInteger(node.queue)}`,
      title: `Request rate is unknown in this frame. ${basis}`,
    };
  }
  const active = node.requestsPerSecond > 0;
  return {
    state: active ? 'active' : 'idle',
    text: active
      ? formatTrafficRate(node.requestsPerSecond)
      : '0 req/s',
    queueText:
      node.queue === null || !Number.isFinite(node.queue)
        ? null
        : `queue ${formatInteger(node.queue)}`,
    title: active
      ? `Live dispatch activity: ${formatTrafficRate(node.requestsPerSecond)}. ${basis}`
      : `Measured idle: no logical dispatch attempts in this interval. ${basis}`,
  };
}

export function formatTrafficTime(frame: TrafficFrame): string {
  return `t=${formatDecimal(frame.timeMs / 1000, 1)} s`;
}

export function formatTrafficWindow(frame: TrafficFrame): string {
  return `${formatDecimal(frame.windowMs / 1000, 2)} s interval`;
}

export interface TrafficNodeView {
  node: TrafficNode | null;
  modeLabel: string;
  sampleActive: boolean;
  animate: boolean;
  showPlaceholder: boolean;
}

export interface TrafficEdgeView {  requestsPerSecond: number;
  bytesPerSecond: number | null;
  active: boolean;
  animate: boolean;
  reducedMotion: boolean;
  modeLabel: string;
  title: string;
}

export function buildTrafficEdgeView(input: {
  edge: TrafficEdge | null;
  frame: TrafficFrame | null;
  modeLabel: string;
  animate: boolean;
  reducedMotion: boolean;
}): TrafficEdgeView | null {
  const { edge, frame, modeLabel, animate, reducedMotion } = input;
  if (!edge) {
    return null;
  }
  const active =
    edge.requestsPerSecond > 0 ||
    (edge.bytesPerSecond !== null && edge.bytesPerSecond > 0);
  const windowText = frame ? formatTrafficWindow(frame) : 'measured interval';
  const rateText =
    edge.requestsPerSecond > 0
      ? `${formatTrafficRate(edge.requestsPerSecond)} logical dispatches`
      : 'no measured logical dispatches';
  const byteText =
    edge.bytesPerSecond !== null
      ? `, ${formatTrafficBytesRate(edge.bytesPerSecond)} attributed`
      : '';
  return {
    requestsPerSecond: edge.requestsPerSecond,
    bytesPerSecond: edge.bytesPerSecond,
    active,
    animate: active && animate && !reducedMotion,
    reducedMotion,
    modeLabel,
    title: `${modeLabel}: ${rateText}${byteText} over the ${windowText}. Attempts include failures; this is not successful throughput.`,
  };
}

export function trafficModeLabel(
  mode: TrafficMode,
  frame: TrafficFrame | null,
  paused = false,
): string {
  if (mode === 'live') {
    if (paused) {
      return frame
        ? `Paused · ${frame.scopeLabel} · ${formatTrafficTime(frame)}`
        : 'Paused · awaiting first measured sample';
    }
    return frame
      ? `Live snapshot · ${frame.scopeLabel} · ${formatTrafficTime(frame)}`
      : 'Live snapshot · awaiting first measured sample';
  }
  if (mode === 'replay-playing' || mode === 'replay-paused') {
    if (!frame) {
      return 'Replay · no recorded sample';
    }
    return `${mode === 'replay-playing' ? 'Replay' : 'Replay paused'} · ${frame.scopeLabel} · ${formatTrafficTime(frame)}`;
  }
  if (mode === 'completed') {
    return 'Run average';
  }
  return 'No live sample';
}
