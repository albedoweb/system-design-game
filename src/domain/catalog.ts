import type { GraphDocument } from './graph';

/**
 * Frozen catalog of node kinds, sizes, capacities and prices.
 *
 * Prices are conditional game prices (integer micro-USD per hour), not cloud
 * quotes. The catalog is the single source for `calculateCost`; there is no
 * hidden per-server surcharge. Sizes define both capacity and price for every
 * kind, so the UI can show derived upper bounds without duplicating numbers.
 */

export const NODE_KINDS = [
  'client',
  'loadBalancer',
  'appServer',
  'cache',
  'database',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_SIZES = ['small', 'medium', 'large'] as const;

export type NodeSize = (typeof NODE_SIZES)[number];

export const NODE_KIND_LABELS: Readonly<Record<NodeKind, string>> = Object.freeze({
  client: 'Client',
  loadBalancer: 'Load Balancer',
  appServer: 'App Server',
  cache: 'Cache',
  database: 'Database',
});

export const NODE_SIZE_LABELS: Readonly<Record<NodeSize, string>> = Object.freeze({
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
});

/** Player-facing units. `null` capacity (client/LB) is shown as `—`. */
export const UNIT_LABELS = Object.freeze({
  milliseconds: 'ms',
  seconds: 's',
  slots: 'slots',
  entries: 'entries',
  kibibytes: 'KiB',
  requestsPerSecond: 'req/s',
  usdPerHour: '$/h',
  bytes: 'bytes',
  none: '—',
});

/** The only pricing catalog this build can calculate with. */
export const SUPPORTED_PRICING_VERSION = 'catalog-v1';

/** One cache entry is 8 KiB of logical data (overhead is not modelled). */
export const CACHE_ENTRY_KIB = 8;

export interface SizeSpec {
  readonly size: NodeSize;
  readonly label: string;
  /**
   * Concurrent request slots (app/database), cache entries, or `null` when the
   * kind has no bounded capacity in this model (client, load balancer).
   */
  readonly capacity: number | null;
  /** Unit key for `UNIT_LABELS` that describes `capacity`. */
  readonly capacityUnit: 'slots' | 'entries' | 'none';
  readonly priceMicroUsdPerHour: number;
}

export interface KindSpec {
  readonly kind: NodeKind;
  readonly label: string;
  /** Short player-facing description of the kind's role. */
  readonly description: string;
  readonly sizes: Readonly<Record<NodeSize, SizeSpec>>;
}

function sizeSpec(
  size: NodeSize,
  capacity: number | null,
  capacityUnit: SizeSpec['capacityUnit'],
  priceMicroUsdPerHour: number,
): SizeSpec {
  return Object.freeze({
    size,
    label: NODE_SIZE_LABELS[size],
    capacity,
    capacityUnit,
    priceMicroUsdPerHour,
  });
}

const APP_SIZES = Object.freeze({
  small: sizeSpec('small', 16, 'slots', 200_000),
  medium: sizeSpec('medium', 32, 'slots', 400_000),
  large: sizeSpec('large', 64, 'slots', 800_000),
});

const DATABASE_SIZES = Object.freeze({
  small: sizeSpec('small', 4, 'slots', 2_000_000),
  medium: sizeSpec('medium', 8, 'slots', 4_000_000),
  large: sizeSpec('large', 16, 'slots', 8_000_000),
});

const CACHE_SIZES = Object.freeze({
  small: sizeSpec('small', 128, 'entries', 200_000),
  medium: sizeSpec('medium', 512, 'entries', 400_000),
  large: sizeSpec('large', 2048, 'entries', 800_000),
});

const CLIENT_SIZES = Object.freeze({
  small: sizeSpec('small', null, 'none', 0),
  medium: sizeSpec('medium', null, 'none', 0),
  large: sizeSpec('large', null, 'none', 0),
});

const LOAD_BALANCER_SIZES = Object.freeze({
  small: sizeSpec('small', null, 'none', 100_000),
  medium: sizeSpec('medium', null, 'none', 100_000),
  large: sizeSpec('large', null, 'none', 100_000),
});

export const CATALOG: Readonly<Record<NodeKind, KindSpec>> = Object.freeze({
  client: Object.freeze({
    kind: 'client',
    label: NODE_KIND_LABELS.client,
    description: 'Load source. One fixed client with an external RTT.',
    sizes: CLIENT_SIZES,
  }),
  loadBalancer: Object.freeze({
    kind: 'loadBalancer',
    label: NODE_KIND_LABELS.loadBalancer,
    description: 'Round-robin across app servers, 1 ms per request.',
    sizes: LOAD_BALANCER_SIZES,
  }),
  appServer: Object.freeze({
    kind: 'appServer',
    label: NODE_KIND_LABELS.appServer,
    description:
      'Request slots, queue and a shared dependency call pool. One read and one write.',
    sizes: APP_SIZES,
  }),
  cache: Object.freeze({
    kind: 'cache',
    label: NODE_KIND_LABELS.cache,
    description: 'LRU + TTL cache with optional coalescing and a miss to the database.',
    sizes: CACHE_SIZES,
  }),
  database: Object.freeze({
    kind: 'database',
    label: NODE_KIND_LABELS.database,
    description: 'One primary: slots bound how many operations run at once.',
    sizes: DATABASE_SIZES,
  }),
});

export const DEFAULT_QUEUE_LIMIT = 128;
export const DEFAULT_POOL_SIZE = 8;
export const DEFAULT_TTL_SECONDS = 120;
export const DEFAULT_COALESCING = false;

/** Size picked for a freshly created node of each kind. */
export const DEFAULT_NODE_SIZE_BY_KIND: Readonly<Record<NodeKind, NodeSize>> =
  Object.freeze({
    client: 'small',
    loadBalancer: 'small',
    appServer: 'small',
    cache: 'medium',
    database: 'small',
  });

export function getSizeSpec(kind: NodeKind, size: NodeSize): SizeSpec {
  return CATALOG[kind].sizes[size];
}

export function getCapacity(kind: NodeKind, size: NodeSize): number | null {
  return getSizeSpec(kind, size).capacity;
}

/** Derived cache capacity in KiB for UI explanations (entries * 8 KiB). */
export function getCacheCapacityKiB(size: NodeSize): number {
  const entries = getCapacity('cache', size);
  return (entries ?? 0) * CACHE_ENTRY_KIB;
}

/**
 * Total price of the graph in integer micro-USD per hour.
 * Client is free, LB costs $0.10/h, every other kind is priced by its size.
 */
export function calculateCost(graph: Pick<GraphDocument, 'nodes'>): number {
  let total = 0;
  for (const node of graph.nodes) {
    total += getSizeSpec(node.kind, node.config.size).priceMicroUsdPerHour;
  }
  return total;
}

/** Convert integer micro-USD to USD for SloCheck `actual` values. */
export function microUsdToUsd(microUsd: number): number {
  return microUsd / 1_000_000;
}

export function calculateCostUsd(graph: Pick<GraphDocument, 'nodes'>): number {
  return microUsdToUsd(calculateCost(graph));
}
