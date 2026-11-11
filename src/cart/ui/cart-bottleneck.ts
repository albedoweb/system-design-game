/**
 * Overloaded-component view model for Global Cart results.
 *
 * Every number comes from the measured run observation (`load` counters per
 * component). Nothing is estimated: a component without `load` (older results)
 * yields no entry.
 */
import { CART_REGION_INFO, type CartCaseResult, type CartGraph, type CartRegion } from '../index';
import { cartNodeDisplayName, cartRegionShort } from './cart-meta';

export type CartRunObservation = NonNullable<CartCaseResult['observation']>;
type CartNodeLoad = NonNullable<CartRunObservation['nodes'][number]['load']>;
/** One physical link that carried traffic (`observation.links`). */
export type CartLinkLoad = NonNullable<CartRunObservation['links']>[number];

/** A queue wait at or above this many milliseconds marks a component as overloaded (the tightest latency target). */
export const CART_BOTTLENECK_WAIT_MS = 50;

export interface CartBottleneck {
  nodeId: string;
  label: string;
  /** `circuit` entries are WAN link directions; `nodeId` then holds the link id. */
  resource: 'disk' | 'cpu' | 'admission' | 'circuit';
  waitMaxMs: number;
  waitAvgMs: number;
  busyShare: number;
  rejected: number;
  /** Purchased circuit speed per direction; set for `circuit` entries only. */
  mbps?: number;
}

/** CPU busy share over the whole run: cpuBusyMs / (cpuLanes x elapsedMs); null when no time elapsed. */
export function cartCpuBusyShare(load: CartNodeLoad, elapsedMs: number): number | null {
  if (!(elapsedMs > 0)) return null;
  return load.cpuBusyMs / (load.cpuLanes * elapsedMs);
}

/** Disk busy share over the whole run: ioBusyMs / elapsedMs; null for components without disk or no elapsed time. */
export function cartDiskBusyShare(load: CartNodeLoad, elapsedMs: number): number | null {
  if (load.ioTasks === 0 || !(elapsedMs > 0)) return null;
  return load.ioBusyMs / elapsedMs;
}

/** Wait label: integer milliseconds from 10 ms up, one decimal below. */
export function cartWaitLabel(ms: number): string {
  return ms >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`;
}

/** Busy share as an integer percent. */
export function cartBusyLabel(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Display name and region of a component, e.g. "Cart store · EU Central"; the node id when it is not in the graph. */
export function cartComponentLabel(graph: CartGraph, nodeId: string): string {
  const node = graph.nodes.find((item) => item.id === nodeId);
  return node === undefined ? nodeId : `${cartNodeDisplayName(node)} · ${cartRegionShort(node.region)}`;
}

function isCartRegion(value: string): value is CartRegion {
  return Object.prototype.hasOwnProperty.call(CART_REGION_INFO, value);
}

/**
 * Sending and receiving region of a WAN link direction: `pair` is "a|b" and
 * "forward" goes from a to b, "reverse" from b to a. Null for any other link
 * or for values that do not name two known regions.
 */
export function cartCircuitEnds(link: CartLinkLoad): { from: CartRegion; to: CartRegion } | null {
  if (link.kind !== 'wan' || link.pair === null) return null;
  const parts = link.pair.split('|');
  if (parts.length !== 2 || !isCartRegion(parts[0]!) || !isCartRegion(parts[1]!)) return null;
  if (link.direction === 'forward') return { from: parts[0], to: parts[1] };
  if (link.direction === 'reverse') return { from: parts[1], to: parts[0] };
  return null;
}

/** Circuit label with the sending region first, e.g. "Circuit US West → EU Central"; null when the link cannot be labelled. */
export function cartCircuitLabel(link: CartLinkLoad): string | null {
  const ends = cartCircuitEnds(link);
  if (ends === null) return null;
  return `Circuit ${cartRegionShort(ends.from)} → ${cartRegionShort(ends.to)}`;
}

/** WAN link directions of a run, grouped by region pair, forward before reverse. */
export function cartWanLinks(observation: CartRunObservation | undefined): CartLinkLoad[] {
  const links = (observation?.links ?? []).filter((link) => link.kind === 'wan' && cartCircuitEnds(link) !== null);
  const rank = (direction: string) => (direction === 'forward' ? 0 : 1);
  return [...links].sort((a, b) => {
    if (a.pair !== b.pair) return (a.pair ?? '') < (b.pair ?? '') ? -1 : 1;
    return rank(a.direction) - rank(b.direction);
  });
}

/**
 * Overloaded components and circuit directions of one scenario, worst wait
 * first. Admission entries (refused operations) have no wait and come last,
 * most refusals first.
 */
export function cartBottlenecks(graph: CartGraph, observation: CartRunObservation | undefined): CartBottleneck[] {
  if (observation === undefined) return [];
  const out: CartBottleneck[] = [];
  for (const link of cartWanLinks(observation)) {
    const label = cartCircuitLabel(link);
    if (label === null || link.waitMaxMs < CART_BOTTLENECK_WAIT_MS) continue;
    out.push({
      nodeId: link.id,
      label,
      resource: 'circuit',
      mbps: link.mbps,
      waitMaxMs: link.waitMaxMs,
      waitAvgMs: link.waitAvgMs,
      busyShare: observation.elapsedMs > 0 ? link.busyMs / observation.elapsedMs : 0,
      rejected: 0,
    });
  }
  for (const node of observation.nodes) {
    const load = node.load;
    if (load === undefined) continue;
    const label = cartComponentLabel(graph, node.nodeId);
    const base = { nodeId: node.nodeId, label, rejected: load.cpuRejected };
    if (load.ioTasks > 0 && load.ioWaitMaxMs >= CART_BOTTLENECK_WAIT_MS) {
      out.push({
        ...base,
        resource: 'disk',
        waitMaxMs: load.ioWaitMaxMs,
        waitAvgMs: load.ioWaitAvgMs,
        busyShare: cartDiskBusyShare(load, observation.elapsedMs) ?? 0,
      });
    }
    if (load.cpuWaitMaxMs >= CART_BOTTLENECK_WAIT_MS) {
      out.push({
        ...base,
        resource: 'cpu',
        waitMaxMs: load.cpuWaitMaxMs,
        waitAvgMs: load.cpuWaitAvgMs,
        busyShare: cartCpuBusyShare(load, observation.elapsedMs) ?? 0,
      });
    }
    if (load.cpuRejected > 0) {
      // Admission entries carry no wait or busy value; the sentence does not read them.
      out.push({ ...base, resource: 'admission', waitMaxMs: 0, waitAvgMs: 0, busyShare: 0 });
    }
  }
  return out.sort((a, b) => b.waitMaxMs - a.waitMaxMs || b.rejected - a.rejected);
}

export function cartBottleneckSentence(b: CartBottleneck): string {
  if (b.resource === 'circuit') {
    return `${b.label} (${b.mbps} Mbit/s): messages waited up to ${cartWaitLabel(b.waitMaxMs)} to be sent (${cartWaitLabel(b.waitAvgMs)} on average). The circuit was busy ${cartBusyLabel(b.busyShare)} of the run. Try a faster circuit for this region pair.`;
  }
  if (b.resource === 'disk') {
    return `${b.label}: operations waited up to ${cartWaitLabel(b.waitMaxMs)} for its disk (${cartWaitLabel(b.waitAvgMs)} on average). Its disk was busy ${cartBusyLabel(b.busyShare)} of the run. Try a larger size.`;
  }
  if (b.resource === 'cpu') {
    return `${b.label}: operations waited up to ${cartWaitLabel(b.waitMaxMs)} for CPU (${cartWaitLabel(b.waitAvgMs)} on average). CPU was busy ${cartBusyLabel(b.busyShare)} of the run. Try a larger size or a second instance.`;
  }
  const noun = b.rejected === 1 ? 'operation' : 'operations';
  return `${b.label}: refused ${b.rejected} ${noun} because its queue or memory was full. Try a larger size.`;
}
