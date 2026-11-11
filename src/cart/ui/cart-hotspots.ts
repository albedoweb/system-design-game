import type { CartEvaluation, CartGraph } from '../index';
import { cartBottlenecks, cartWaitLabel, type CartBottleneck } from './cart-bottleneck';
import { cartCasePassed } from './cart-diagnostics';

/**
 * Components and circuits whose measured queue wait was long in a scenario
 * that did not pass. Values are short factual labels for the canvas, e.g.
 * "disk wait up to 556 ms". Keys: node id, and the canonical region pair
 * ("us-west|eu-central") for circuits.
 */
export interface CartHotspots {
  readonly nodes: Readonly<Record<string, string>>;
  readonly circuits: Readonly<Record<string, string>>;
}

export const CART_NO_HOTSPOTS: CartHotspots = { nodes: {}, circuits: {} };

/** Region pair of a WAN link id: "wan:us-west|eu-central:forward" gives "us-west|eu-central". */
function circuitPairKey(linkId: string): string {
  const body = linkId.startsWith('wan:') ? linkId.slice('wan:'.length) : linkId;
  const cut = body.lastIndexOf(':');
  return cut >= 0 ? body.slice(0, cut) : body;
}

interface NodeWait {
  readonly entry: CartBottleneck;
}

/**
 * Hotspot labels for every scenario that did not pass or is incomplete. The
 * scenario filter matches CartBottleneckNotice, so the canvas and the report
 * name the same components.
 */
export function cartHotspots(graph: CartGraph, evaluation: CartEvaluation | null): CartHotspots {
  if (evaluation === null) return CART_NO_HOTSPOTS;
  const nodeWaits = new Map<string, NodeWait>();
  const nodeRefusals = new Map<string, number>();
  const circuitWaits = new Map<string, CartBottleneck>();
  for (const item of evaluation.cases) {
    if (item.complete && cartCasePassed(evaluation, item.id)) continue;
    for (const entry of cartBottlenecks(graph, item.observation)) {
      if (entry.resource === 'circuit') {
        const key = circuitPairKey(entry.nodeId);
        const current = circuitWaits.get(key);
        if (current === undefined || entry.waitMaxMs > current.waitMaxMs) circuitWaits.set(key, entry);
        continue;
      }
      if (entry.resource === 'admission') {
        nodeRefusals.set(entry.nodeId, Math.max(nodeRefusals.get(entry.nodeId) ?? 0, entry.rejected));
        continue;
      }
      const current = nodeWaits.get(entry.nodeId);
      if (current === undefined || entry.waitMaxMs > current.entry.waitMaxMs) nodeWaits.set(entry.nodeId, { entry });
    }
  }

  const nodes: Record<string, string> = {};
  for (const [nodeId, { entry }] of nodeWaits) {
    const what = entry.resource === 'disk' ? 'disk wait' : 'CPU wait';
    nodes[nodeId] = `${what} up to ${cartWaitLabel(entry.waitMaxMs)}`;
  }
  for (const [nodeId, refused] of nodeRefusals) {
    if (nodes[nodeId] !== undefined) continue;
    nodes[nodeId] = `refused ${refused} ${refused === 1 ? 'operation' : 'operations'}`;
  }

  const circuits: Record<string, string> = {};
  for (const [pair, entry] of circuitWaits) {
    const speed = entry.mbps === undefined ? '' : ` at ${entry.mbps} Mbit/s`;
    circuits[pair] = `queue up to ${cartWaitLabel(entry.waitMaxMs)}${speed}`;
  }

  if (Object.keys(nodes).length === 0 && Object.keys(circuits).length === 0) return CART_NO_HOTSPOTS;
  return { nodes, circuits };
}
