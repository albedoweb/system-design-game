import { z } from 'zod';
import { CART_CIRCUIT_MBPS, CART_VERSIONS, cartNodeKindSchema, cartServiceSizeSchema } from './contracts';

/**
 * Global Cart catalog: proposed physical capacities, work charges and prices.
 *
 * Every number here is a teaching input from the candidate contract. None is
 * measured, and no formula consumes a solution-family label: `scoring` records
 * that explicitly so a topology name can never earn a correctness bonus.
 */

const sizeSpecSchema = z.strictObject({
  cpuLanes: z.number().int().min(1),
  ramMiB: z.number().int().min(0),
  durableMiB: z.number().int().min(0),
  iops: z.number().int().min(0),
  hourlyCredits: z.number().finite().nonnegative(),
});

const sizedNodeSchema = z.strictObject({
  kind: cartNodeKindSchema,
  label: z.string().min(1).max(80),
  perInstance: z.boolean(),
  sizes: z.strictObject({
    S: sizeSpecSchema,
    M: sizeSpecSchema,
  }),
  notes: z.string().min(1).max(600),
});

/**
 * Calibrated-status metadata is part of the public catalog. It must stay
 * honest: `measured` is false until GC-019 records real calibration runs, and
 * `topologyLabelBonus` is permanently false for this profile.
 */
const calibrationSchema = z.strictObject({
  status: z.enum(['proposed', 'calibrated']),
  measured: z.boolean(),
  calibratedAt: z.string().min(1).max(40).nullable(),
  calibrationTask: z.literal('GC-019'),
  seeds: z.array(z.number().int().min(0)).max(32),
  source: z.string().min(1).max(400),
  note: z.string().min(1).max(600),
});

const scoringSchema = z.strictObject({
  usesTopologyLabels: z.literal(false),
  topologyLabelBonus: z.literal(false),
  familyLabelRequired: z.literal(false),
  note: z.string().min(1).max(400),
});

const nodeCatalogSchema = z.strictObject({
  application: sizedNodeSchema,
  cache: sizedNodeSchema,
  journal: sizedNodeSchema,
  store: sizedNodeSchema,
  inventory: sizedNodeSchema,
});

const wanPropagationSchema = z.strictObject({
  'us-west|eu-central': z.number().finite().positive(),
  'us-west|ap-northeast': z.number().finite().positive(),
  'eu-central|ap-northeast': z.number().finite().positive(),
});

const networkSchema = z.strictObject({
  localComponentPropagationMs: z.number().finite().nonnegative(),
  clientAccessPropagationMs: z.number().finite().nonnegative(),
  clientAccessMbps: z.number().finite().positive(),
  nicMbpsPerInstance: z.number().finite().positive(),
  intraRegionFabricMbps: z.number().finite().positive(),
  wanPropagationMs: wanPropagationSchema,
  wanTiersMbps: z.array(z.number().int().positive()).min(1).max(8),
  wanHourlyCredits: z.record(
    z.string().min(1).max(8),
    z.number().finite().nonnegative(),
  ),
  wanCreditsPerGiB: z.number().finite().nonnegative(),
  wanSharedPerDirection: z.literal(true),
  wanSemanticEdgesShareCircuit: z.literal(true),
  graphCannotSelectPropagation: z.literal(true),
  wanDirectionWaitingByteLimit: z.number().int().positive(),
  nicWaitingByteLimit: z.number().int().positive(),
  note: z.string().min(1).max(600),
});

const workSchema = z.strictObject({
  cpuMsPerLanePerSecond: z.number().finite().positive(),
  ioMsPerUnitFormula: z.string().min(1).max(120),
  durableFlushMs: z.number().finite().nonnegative(),
  applicationFrontDoorCpuMs: z.number().finite().nonnegative(),
  applicationMergeCpuMsPerUnit: z.number().finite().nonnegative(),
  cacheLookupCpuMs: z.number().finite().nonnegative(),
  journalAppendCpuMs: z.number().finite().nonnegative(),
  journalReadCpuMs: z.number().finite().nonnegative(),
  journalReadCpuMsPerRetainedOp: z.number().finite().nonnegative(),
  storeIngestCpuMs: z.number().finite().nonnegative(),
  storeIngestCpuMsPerUnit: z.number().finite().nonnegative(),
  storeReadCpuMs: z.number().finite().nonnegative(),
  storeReadCpuMsPerUnit: z.number().finite().nonnegative(),
  inventoryTransactionCpuMs: z.number().finite().nonnegative(),
  inventoryCpuMsPerLine: z.number().finite().nonnegative(),
  dedupHitCpuMs: z.number().finite().nonnegative(),
});

const budgetSchema = z.strictObject({
  creditsPerHour: z.number().finite().positive(),
  exactEqualityPasses: z.literal(true),
  caseMeasuredMs: z.number().int().positive(),
  drainMs: z.number().int().nonnegative(),
  note: z.string().min(1).max(400),
});

export const cartCatalogSchema = z.strictObject({
  pricingVersion: z.literal(CART_VERSIONS.pricing),
  profileVersion: z.literal(CART_VERSIONS.profile),
  currency: z.literal('credits'),
  calibration: calibrationSchema,
  scoring: scoringSchema,
  nodes: nodeCatalogSchema,
  network: networkSchema,
  work: workSchema,
  budget: budgetSchema,
});

export type CartCatalog = z.infer<typeof cartCatalogSchema>;

const catalog: CartCatalog = {
  pricingVersion: CART_VERSIONS.pricing,
  profileVersion: CART_VERSIONS.profile,
  currency: 'credits',
  calibration: {
    status: 'proposed',
    measured: false,
    calibratedAt: null,
    calibrationTask: 'GC-019',
    seeds: [],
    source:
      'GLOBAL_CART_DEVELOPER_REQUIREMENTS.md §7 and CONTRACT.md B1-B5 (candidate, 2026-11-08).',
    note: 'Proposed teaching values. They are not vendor quotes and not measured results; no passing architecture is established until calibration records separate evidence.',
  },
  scoring: {
    usesTopologyLabels: false,
    topologyLabelBonus: false,
    familyLabelRequired: false,
    note: 'Correctness, gates, cost and digest depend on drawn topology only. Solution-family names are explanation text and can never add score.',
  },
  nodes: {
    application: {
      kind: 'application',
      label: 'Application',
      perInstance: true,
      sizes: {
        S: { cpuLanes: 1, ramMiB: 64, durableMiB: 0, iops: 0, hourlyCredits: 0.2 },
        M: { cpuLanes: 2, ramMiB: 128, durableMiB: 0, iops: 0, hourlyCredits: 0.36 },
      },
      notes:
        'One logical node per region; instances share no free mutable cart state. Each instance carries its own NIC and CPU lane.',
    },
    cache: {
      kind: 'cache',
      label: 'Cache',
      perInstance: false,
      sizes: {
        S: { cpuLanes: 1, ramMiB: 4, durableMiB: 0, iops: 0, hourlyCredits: 0.08 },
        M: { cpuLanes: 2, ramMiB: 16, durableMiB: 0, iops: 0, hourlyCredits: 0.14 },
      },
      notes:
        'Optional volatile view cache with fixed 1 s TTL. It retains original freshness evidence and can never authorize a purchase.',
    },
    journal: {
      kind: 'journal',
      label: 'Durable journal',
      perInstance: false,
      sizes: {
        S: { cpuLanes: 1, ramMiB: 32, durableMiB: 16, iops: 1000, hourlyCredits: 0.16 },
        M: { cpuLanes: 2, ramMiB: 64, durableMiB: 64, iops: 2000, hourlyCredits: 0.28 },
      },
      notes:
        'Append-only durable operations, dedup records and outbox obligations. Reading a cart scans retained operations and pays real work.',
    },
    store: {
      kind: 'store',
      label: 'Cart store',
      perInstance: false,
      sizes: {
        S: { cpuLanes: 1, ramMiB: 64, durableMiB: 16, iops: 1000, hourlyCredits: 0.3 },
        M: { cpuLanes: 2, ramMiB: 128, durableMiB: 64, iops: 2000, hourlyCredits: 0.54 },
      },
      notes:
        'Durable operation set, tombstones, dedup records, outbox and a materialized view maintained by charged work.',
    },
    inventory: {
      kind: 'inventory',
      label: 'Inventory',
      perInstance: false,
      sizes: {
        S: { cpuLanes: 1, ramMiB: 64, durableMiB: 16, iops: 1000, hourlyCredits: 0.24 },
        M: { cpuLanes: 2, ramMiB: 128, durableMiB: 64, iops: 2000, hourlyCredits: 0.42 },
      },
      notes:
        'Exactly one authoritative transactional node: stock, orders and the idempotency ledger share one serial durable FIFO. No cache can authorize a purchase.',
    },
  },
  network: {
    localComponentPropagationMs: 1,
    clientAccessPropagationMs: 8,
    clientAccessMbps: 20,
    nicMbpsPerInstance: 100,
    intraRegionFabricMbps: 1000,
    wanPropagationMs: {
      'us-west|eu-central': 80,
      'us-west|ap-northeast': 55,
      'eu-central|ap-northeast': 120,
    },
    wanTiersMbps: [...CART_CIRCUIT_MBPS],
    wanHourlyCredits: {
      '2': 0.01,
      '8': 0.04,
      '32': 0.16,
    },
    wanCreditsPerGiB: 1,
    wanSharedPerDirection: true,
    wanSemanticEdgesShareCircuit: true,
    graphCannotSelectPropagation: true,
    wanDirectionWaitingByteLimit: 65_536,
    nicWaitingByteLimit: 262_144,
    note: 'Every semantic edge between two regions shares the single purchased circuit for that unordered pair, per direction. Arrows, instances or Application count cannot multiply capacity, and no graph can select propagation delay.',
  },
  work: {
    cpuMsPerLanePerSecond: 1000,
    ioMsPerUnitFormula: '1000 / declaredIOPS per modeled IO unit',
    durableFlushMs: 2,
    applicationFrontDoorCpuMs: 0.3,
    applicationMergeCpuMsPerUnit: 0.01,
    cacheLookupCpuMs: 0.05,
    journalAppendCpuMs: 0.2,
    journalReadCpuMs: 0.15,
    journalReadCpuMsPerRetainedOp: 0.05,
    storeIngestCpuMs: 0.5,
    storeIngestCpuMsPerUnit: 0.01,
    storeReadCpuMs: 0.15,
    storeReadCpuMsPerUnit: 0.01,
    inventoryTransactionCpuMs: 0.5,
    inventoryCpuMsPerLine: 0.1,
    dedupHitCpuMs: 0.1,
  },
  budget: {
    creditsPerHour: 6,
    exactEqualityPasses: true,
    caseMeasuredMs: 90_000,
    drainMs: 10_000,
    note: 'Budget equality passes exactly. Missing hard gates, safety failures or incomplete runs never score.',
  },
};

/** Authoritative catalog, validated at module load. */
export const CART_CATALOG: CartCatalog = cartCatalogSchema.parse(catalog);

export function cloneCartCatalog(): CartCatalog {
  return JSON.parse(JSON.stringify(CART_CATALOG)) as CartCatalog;
}

export function cartCatalogJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(cartCatalogSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id: 'https://system-design-game.local/schemas/global-cart-catalog.json',
    title: 'Global Cart catalog (cart-pricing-v1-candidate)',
  };
}

/** Convenience for discovery: the proposed price/extent of one node size. */
export function cartNodeSizeSpec(
  kind: keyof CartCatalog['nodes'],
  size: z.infer<typeof cartServiceSizeSchema>,
): CartCatalog['nodes'][typeof kind]['sizes'][typeof size] {
  return CART_CATALOG.nodes[kind].sizes[size];
}
