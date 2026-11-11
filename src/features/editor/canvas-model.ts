import { MarkerType, type Edge, type Node } from '@xyflow/react';

import {
  CACHE_ENTRY_KIB,
  NODE_KIND_LABELS,
  getCapacity,
  getSizeSpec,
  type Diagnostic,
  type EdgeSourcePort,
  type GraphDocument,
  type NodeConfig,
  type NodeKind,
  type NodeMetric,
} from '../../domain';
import type {
  TrafficEdgeView,
  TrafficNodeView,
} from '../traffic/traffic-ui';
import { formatBytes, formatInteger, formatMicroUsd } from '../../ui/format';
import {
  bandTitle,
  occupancyAccessibleText,
  occupancyBand,
  occupancyValue,
  type Occupancy,
} from '../metrics/load-bands';

export const PORT_LABELS: Readonly<Record<EdgeSourcePort, string>> = {
  out: 'traffic',
  read: 'read',
  write: 'write',
  miss: 'miss',
};

export const PORT_COLORS: Readonly<Record<EdgeSourcePort, string>> = {
  out: '#0e7490',
  read: '#1d6fd8',
  write: '#7c3aed',
  miss: '#b45309',
};

/**
 * `peak` is historical: a completed run now presents its time-weighted
 * averages as the primary occupancy and keeps the peak as separate evidence.
 * The name is retained to avoid an unnecessary API change.
 */
export type CanvasLoadMode = 'none' | 'live' | 'stopped' | 'peak';

export type CanvasDiagnosticSeverity = 'warning' | 'error';

export interface CanvasEvidence {
  mode: CanvasLoadMode;
  stale: boolean;
  diagnosticsByNode: ReadonlyMap<string, Diagnostic[]>;
}

export type CanvasNodeData = {
  label: string;
  kind: NodeKind;
  config: NodeConfig;
  metrics: NodeMetric | null;
  capacityLabel: string;
  occupancy: Occupancy[];
  loadMode: CanvasLoadMode;
  diagnostics: Diagnostic[];
  highlight: CanvasDiagnosticSeverity | null;
  tooltip: string;
  /** Optional live/replay telemetry from the shared traffic store. */
  traffic?: TrafficNodeView | null;
};

export type CanvasNode = Node<CanvasNodeData, 'domain'>;

export type CanvasEdgeData = {
  sourcePort: EdgeSourcePort;
  label: string;
  color: string;
  traffic?: TrafficEdgeView | null;
};

export type CanvasEdge = Edge<CanvasEdgeData, 'domain'>;

export function capacityText(kind: NodeKind, config: NodeConfig): string {
  const capacity = getCapacity(kind, config.size);
  if (capacity === null) {
    return 'no capacity limit';
  }
  if (kind === 'cache') {
    const kib = capacity * CACHE_ENTRY_KIB;
    return `${capacity} entries · ${formatBytes(kib)}`;
  }
  return `${capacity} slots`;
}

function unavailableNote(stale: boolean): string {
  return stale ? 'Previous run hidden' : 'No data';
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface CompletedOccupancyInput {
  key: 'slots' | 'pool';
  label: string;
  unit: Occupancy['unit'];
  capacity: number | null;
  average: number | null;
  peak: number | null;
  stale: boolean;
}

/**
 * A completed run is represented by its time-weighted average. The maximum
 * observed is retained only as separate evidence: it must never become the
 * colored value or a fallback when the average is missing.
 */
function completedOccupancy({
  key,
  label,
  unit,
  capacity,
  average,
  peak,
  stale,
}: CompletedOccupancyInput): Occupancy {
  return {
    key,
    label,
    unit,
    used: average,
    capacity,
    average,
    peak,
    note:
      average !== null
        ? undefined
        : stale
          ? 'Previous run hidden'
          : 'Run average unavailable',
  };
}

function slotsOccupancy(
  kind: NodeKind,
  config: NodeConfig,
  metrics: NodeMetric | null,
  mode: CanvasLoadMode,
  stale: boolean,
): Occupancy {
  const capacity = getCapacity(kind, config.size);
  const pressure = metrics?.pressure;
  if (mode === 'peak') {
    return completedOccupancy({
      key: 'slots',
      label: 'Slots',
      unit: 'slots',
      capacity,
      average: finiteOrNull(pressure?.busyAvg),
      peak: finiteOrNull(pressure?.busyPeak),
      stale,
    });
  }
  const sampled = mode === 'live' || mode === 'stopped';
  const used = sampled ? finiteOrNull(metrics?.busy) : null;
  return {
    key: 'slots',
    label: 'Slots',
    unit: 'slots',
    used,
    capacity,
    average: null,
    note: used === null ? unavailableNote(stale) : undefined,
  };
}

function poolOccupancy(
  config: NodeConfig,
  metrics: NodeMetric | null,
  mode: CanvasLoadMode,
  stale: boolean,
): Occupancy {
  const pressure = metrics?.pressure;
  if (mode === 'peak') {
    return completedOccupancy({
      key: 'pool',
      label: 'Pool',
      unit: 'connections',
      capacity: config.poolSize,
      average: finiteOrNull(pressure?.poolBusyAvg),
      peak: finiteOrNull(pressure?.poolBusyPeak),
      stale,
    });
  }
  const sampled = mode === 'live' || mode === 'stopped';
  const used = sampled ? finiteOrNull(metrics?.poolBusy) : null;
  return {
    key: 'pool',
    label: 'Pool',
    unit: 'connections',
    used,
    capacity: config.poolSize,
    average: null,
    note: used === null ? unavailableNote(stale) : undefined,
  };
}

/**
 * Occupancy blocks only describe real bounded resources. Clients and load
 * balancers are unlimited, and cache entries are capacity, not load, so the
 * cache exposes its backend connection pool instead.
 */
export function buildNodeOccupancy(
  kind: NodeKind,
  config: NodeConfig,
  metrics: NodeMetric | null,
  mode: CanvasLoadMode,
  stale: boolean,
): Occupancy[] {
  switch (kind) {
    case 'appServer':
      return [
        slotsOccupancy(kind, config, metrics, mode, stale),
        poolOccupancy(config, metrics, mode, stale),
      ];
    case 'database':
      return [slotsOccupancy(kind, config, metrics, mode, stale)];
    case 'cache':
      return [poolOccupancy(config, metrics, mode, stale)];
    case 'client':
    case 'loadBalancer':
      return [];
  }
}

function highestSeverity(
  diagnostics: readonly Diagnostic[],
): CanvasDiagnosticSeverity | null {
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return 'error';
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'warning')) {
    return 'warning';
  }
  return null;
}

function canvasTooltip(
  occupancy: readonly Occupancy[],
  metrics: NodeMetric | null,
  mode: CanvasLoadMode,
  stale: boolean,
  diagnostics: readonly Diagnostic[],
): string {
  const parts: string[] = [];
  if (mode === 'peak') {
    parts.push(
      'Completed run: meters show the run average; the maximum observed is listed separately and peak alone does not show how long load was high',
    );
  } else if (mode === 'live') {
    parts.push('Current occupancy');
  } else if (mode === 'stopped') {
    parts.push('Stopped snapshot (last sample)');
  } else if (stale) {
    parts.push('Previous run metrics hidden');
  }
  for (const item of occupancy) {
    const band = occupancyBand(item);
    parts.push(occupancyAccessibleText(item));
    if (band) {
      parts.push(bandTitle(band));
    }
  }
  if (metrics) {
    parts.push(`Queue peak ${formatInteger(metrics.maxQueued)}`);
    if (metrics.pressure) {
      parts.push(
        `Pool wait peak ${formatInteger(metrics.pressure.poolQueuedPeak)}`,
      );
      if (metrics.pressure.failures.length > 0) {
        parts.push(
          `Failure locations: ${metrics.pressure.failures
            .map((failure) => `${failure.code} at ${failure.stage} ×${failure.count}`)
            .join('; ')}`,
        );
      }
    }
  }
  for (const diagnostic of diagnostics) {
    parts.push(`${diagnostic.severity}: ${diagnostic.message}`);
  }
  return parts.join(' · ');
}

export function toCanvasNodes(
  graph: GraphDocument,
  metricsByNode: ReadonlyMap<string, NodeMetric>,
  evidence: CanvasEvidence,
): CanvasNode[] {
  return graph.nodes.map((node) => {
    const metrics = metricsByNode.get(node.id) ?? null;
    const diagnostics = evidence.diagnosticsByNode.get(node.id) ?? [];
    const occupancy = buildNodeOccupancy(
      node.kind,
      node.config,
      metrics,
      evidence.mode,
      evidence.stale,
    );
    return {
      id: node.id,
      type: 'domain',
      position: node.position,
      selected: false,
      data: {
        label: node.label,
        kind: node.kind,
        config: node.config,
        metrics,
        capacityLabel: capacityText(node.kind, node.config),
        occupancy,
        loadMode: evidence.mode,
        diagnostics,
        highlight: highestSeverity(diagnostics),
        tooltip: canvasTooltip(
          occupancy,
          metrics,
          evidence.mode,
          evidence.stale,
          diagnostics,
        ),
      },
      ariaLabel: `${node.label}, ${NODE_KIND_LABELS[node.kind]}`,
      draggable: true,
    };
  });
}

export function toCanvasEdges(graph: GraphDocument): CanvasEdge[] {
  return graph.edges.map((edge) => {
    const color = PORT_COLORS[edge.sourcePort];
    return {
      id: edge.id,
      type: 'domain',
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourcePort,
      selected: false,
      data: {
        sourcePort: edge.sourcePort,
        label: PORT_LABELS[edge.sourcePort],
        color,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color,
        width: 18,
        height: 18,
      },
      style: { stroke: color, strokeWidth: 1.8 },
    };
  });
}

export function nodePriceHint(kind: NodeKind, config: NodeConfig): string {
  const spec = getSizeSpec(kind, config.size);
  return spec.priceMicroUsdPerHour === 0
    ? 'free'
    : `${formatMicroUsd(spec.priceMicroUsdPerHour)}/h`;
}

export function occupancyTitle(occupancy: Occupancy): string {
  return occupancyAccessibleText(occupancy);
}

export function occupancyValueText(occupancy: Occupancy): string {
  return occupancyValue(occupancy);
}
