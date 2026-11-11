/**
 * Cart-local component resources, durable-byte accounting and price
 * candidates (cart-protocol-v1, DEVELOPER §7).
 *
 * Numbers are proposed teaching inputs, not measured balance. Every formula
 * here is deterministic integer arithmetic or an explicitly documented
 * floating-point cost; nothing depends on wall clock or randomness.
 *
 * Ownership: this module models capacity and reservation bookkeeping only. It
 * does not schedule CPU/IO service events; GC-011 drives those through the
 * shared frozen scheduler and the cart-local network model in `./network`.
 */

import {
  CART_REGION_INFO,
  type CartCircuitMbps,
  type CartGraph,
  type CartNode,
  type CartRegion,
  type CartServiceSize,
} from '../contracts';

export const CART_MIB_BYTES = 1_048_576;
export const CART_GIB_BYTES = 1_073_741_824;

/** One CPU lane supplies 1000 CPU-ms per simulated second. */
export const CART_CPU_MS_PER_SECOND_PER_LANE = 1_000;
/** A waiting task costs 1024 B of RAM plus its retained payload. */
export const CART_QUEUE_TASK_RAM_BYTES = 1_024;
/** Durable operation envelope adds dedup/result metadata. */
export const CART_DURABLE_METADATA_BYTES = 96;
/** Each outgoing pending delivery obligation. */
export const CART_PENDING_DELIVERY_BYTES = 64;
/** Encoded materialized unit / tombstone sizes. */
export const CART_UNIT_BYTES = 32;
export const CART_TOMBSTONE_BYTES = 24;
/** Durable commit additionally waits this fixed flush latency. */
export const CART_DURABLE_FLUSH_US = 2_000;

export const CART_PENDING_LIMIT = {
  applicationPerInstance: 256,
  otherNode: 128,
} as const;

export type CartServiceKind = 'application' | 'cache' | 'journal' | 'store' | 'inventory';

export interface CartComponentSpec {
  readonly cpuLanes: number;
  readonly ioPerSecond: number | null;
  /** Total model RAM advertised for the size. */
  readonly ramBytes: number;
  /** Usable cache payload (caches only). */
  readonly usablePayloadBytes: number | null;
  readonly durableBytes: number;
  /** RAM reserved by the process itself, unavailable for queues. */
  readonly fixedRamBytes: number;
  readonly pendingLimit: number;
  readonly rentalPerHour: number;
}

const MIB = CART_MIB_BYTES;

/**
 * Proposed resource table. Application rows are per instance; the caller
 * multiplies by `instances`.
 */
export const CART_COMPONENT_TABLE: Readonly<
  Record<CartServiceKind, Readonly<Record<CartServiceSize, CartComponentSpec>>>
> = {
  application: {
    S: {
      cpuLanes: 1,
      ioPerSecond: null,
      ramBytes: 64 * MIB,
      usablePayloadBytes: null,
      durableBytes: 0,
      fixedRamBytes: 16 * MIB,
      pendingLimit: CART_PENDING_LIMIT.applicationPerInstance,
      rentalPerHour: 0.2,
    },
    M: {
      cpuLanes: 2,
      ioPerSecond: null,
      ramBytes: 128 * MIB,
      usablePayloadBytes: null,
      durableBytes: 0,
      fixedRamBytes: 16 * MIB,
      pendingLimit: CART_PENDING_LIMIT.applicationPerInstance,
      rentalPerHour: 0.36,
    },
  },
  cache: {
    S: {
      cpuLanes: 1,
      ioPerSecond: null,
      ramBytes: 4 * MIB,
      usablePayloadBytes: 4 * MIB,
      durableBytes: 0,
      fixedRamBytes: 0,
      pendingLimit: CART_PENDING_LIMIT.otherNode,
      rentalPerHour: 0.08,
    },
    M: {
      cpuLanes: 2,
      ioPerSecond: null,
      ramBytes: 16 * MIB,
      usablePayloadBytes: 16 * MIB,
      durableBytes: 0,
      fixedRamBytes: 0,
      pendingLimit: CART_PENDING_LIMIT.otherNode,
      rentalPerHour: 0.14,
    },
  },
  journal: {
    S: {
      cpuLanes: 1,
      ioPerSecond: 1_000,
      ramBytes: 32 * MIB,
      usablePayloadBytes: null,
      durableBytes: 16 * MIB,
      fixedRamBytes: 16 * MIB,
      pendingLimit: CART_PENDING_LIMIT.otherNode,
      rentalPerHour: 0.16,
    },
    M: {
      cpuLanes: 2,
      ioPerSecond: 2_000,
      ramBytes: 64 * MIB,
      usablePayloadBytes: null,
      durableBytes: 64 * MIB,
      fixedRamBytes: 16 * MIB,
      pendingLimit: CART_PENDING_LIMIT.otherNode,
      rentalPerHour: 0.28,
    },
  },
  store: {
    S: {
      cpuLanes: 1,
      ioPerSecond: 1_000,
      ramBytes: 64 * MIB,
      usablePayloadBytes: null,
      durableBytes: 16 * MIB,
      fixedRamBytes: 32 * MIB,
      pendingLimit: CART_PENDING_LIMIT.otherNode,
      rentalPerHour: 0.3,
    },
    M: {
      cpuLanes: 2,
      ioPerSecond: 2_000,
      ramBytes: 128 * MIB,
      usablePayloadBytes: null,
      durableBytes: 64 * MIB,
      fixedRamBytes: 32 * MIB,
      pendingLimit: CART_PENDING_LIMIT.otherNode,
      rentalPerHour: 0.54,
    },
  },
  inventory: {
    S: {
      cpuLanes: 1,
      ioPerSecond: 1_000,
      ramBytes: 64 * MIB,
      usablePayloadBytes: null,
      durableBytes: 16 * MIB,
      fixedRamBytes: 32 * MIB,
      pendingLimit: CART_PENDING_LIMIT.otherNode,
      rentalPerHour: 0.24,
    },
    M: {
      cpuLanes: 2,
      ioPerSecond: 2_000,
      ramBytes: 128 * MIB,
      usablePayloadBytes: null,
      durableBytes: 64 * MIB,
      fixedRamBytes: 32 * MIB,
      pendingLimit: CART_PENDING_LIMIT.otherNode,
      rentalPerHour: 0.42,
    },
  },
};

/** WAN pair rental per hour, covering both directions. */
export const CART_WAN_RENTAL_PER_HOUR: Readonly<Record<CartCircuitMbps, number>> = {
  2: 0.01,
  8: 0.04,
  32: 0.16,
};

export function cartComponentSpec(kind: CartServiceKind, size: CartServiceSize): CartComponentSpec {
  return CART_COMPONENT_TABLE[kind][size];
}

export interface CartNodeCapacity extends CartComponentSpec {
  readonly nodeId: string;
  readonly kind: CartServiceKind;
  readonly size: CartServiceSize;
  readonly region: CartRegion;
  readonly instances: number;
  readonly cpuLanesTotal: number;
  readonly ramBytesTotal: number;
  readonly durableBytesTotal: number;
  readonly rentalPerHourTotal: number;
}

/** Applies the per-instance vs per-node multiplicity rules. */
export function createCartNodeCapacity(node: CartNode): CartNodeCapacity | null {
  if (node.kind === 'customers') {
    return null;
  }
  const spec = cartComponentSpec(node.kind, node.size);
  const instances = node.kind === 'application' ? node.instances : 1;
  return {
    ...spec,
    nodeId: node.id,
    kind: node.kind,
    size: node.size,
    region: node.region,
    instances,
    cpuLanesTotal: spec.cpuLanes * instances,
    ramBytesTotal: spec.ramBytes * instances,
    durableBytesTotal: spec.durableBytes * instances,
    rentalPerHourTotal: spec.rentalPerHour * instances,
  };
}

export interface CartResourcePlan {
  readonly nodes: ReadonlyMap<string, CartNodeCapacity>;
  readonly circuits: ReadonlyMap<string, { readonly pair: string; readonly mbps: CartCircuitMbps; readonly rentalPerHour: number }>;
  readonly componentRentalPerHour: number;
  readonly circuitRentalPerHour: number;
  readonly totalRentalPerHour: number;
}

export function cartRegionPair(a: CartRegion, b: CartRegion): string {
  return CART_REGION_INFO[a].ordinal < CART_REGION_INFO[b].ordinal ? `${a}|${b}` : `${b}|${a}`;
}

/** Builds capacity and rental totals for a submitted graph. */
export function createCartResourcePlan(graph: CartGraph): CartResourcePlan {
  const nodes = new Map<string, CartNodeCapacity>();
  let componentRentalPerHour = 0;
  for (const node of graph.nodes) {
    const capacity = createCartNodeCapacity(node);
    if (capacity !== null) {
      nodes.set(node.id, capacity);
      componentRentalPerHour += capacity.rentalPerHourTotal;
    }
  }
  const circuits = new Map<string, { pair: string; mbps: CartCircuitMbps; rentalPerHour: number }>();
  let circuitRentalPerHour = 0;
  for (const circuit of graph.circuits) {
    const [first, second] = circuit.regions;
    const pair = cartRegionPair(first, second);
    const mbps = circuit.mbps as CartCircuitMbps;
    const rental = CART_WAN_RENTAL_PER_HOUR[mbps];
    circuits.set(pair, { pair, mbps, rentalPerHour: rental });
    circuitRentalPerHour += rental;
  }
  return {
    nodes,
    circuits,
    componentRentalPerHour,
    circuitRentalPerHour,
    totalRentalPerHour: componentRentalPerHour + circuitRentalPerHour,
  };
}

// ---------------------------------------------------------------------------
// Exact byte formulas
// ---------------------------------------------------------------------------

/** Queue RAM charged by waiting tasks plus their retained payload. */
export function cartQueueRamBytes(waitingTasks: number, payloadBytes: number): number {
  if (!Number.isInteger(waitingTasks) || waitingTasks < 0) {
    throw new RangeError('waiting task count must be a non-negative integer');
  }
  if (!Number.isFinite(payloadBytes) || payloadBytes < 0) {
    throw new RangeError('payload bytes must be finite and non-negative');
  }
  return waitingTasks * CART_QUEUE_TASK_RAM_BYTES + payloadBytes;
}

export interface CartDurableByteInput {
  readonly envelopeBytes: number;
  readonly pendingDeliveries?: number;
  readonly units?: number;
  readonly tombstones?: number;
}

/**
 * Full durable footprint of one committed operation: the complete encoded
 * envelope, dedup/result metadata, outgoing delivery obligations and every
 * materialized unit/tombstone (including tombstones).
 */
export function cartDurableBytes(input: CartDurableByteInput): number {
  const { envelopeBytes } = input;
  if (!Number.isFinite(envelopeBytes) || envelopeBytes < 0) {
    throw new RangeError('envelope bytes must be finite and non-negative');
  }
  const pending = input.pendingDeliveries ?? 0;
  const units = input.units ?? 0;
  const tombstones = input.tombstones ?? 0;
  for (const [value, label] of [
    [pending, 'pendingDeliveries'],
    [units, 'units'],
    [tombstones, 'tombstones'],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${label} must be a non-negative integer`);
    }
  }
  return (
    envelopeBytes +
    CART_DURABLE_METADATA_BYTES +
    pending * CART_PENDING_DELIVERY_BYTES +
    units * CART_UNIT_BYTES +
    tombstones * CART_TOMBSTONE_BYTES
  );
}

/** IO service time: 1000/IOPS milliseconds per modeled unit. */
export function cartIoServiceUs(ioPerSecond: number, units = 1): number {
  if (!Number.isFinite(ioPerSecond) || ioPerSecond <= 0) {
    throw new RangeError('ioPerSecond must be finite and positive');
  }
  if (!Number.isInteger(units) || units < 1) {
    throw new RangeError('IO units must be a positive integer');
  }
  return Math.ceil((units * 1_000_000) / ioPerSecond);
}

/** CPU-ms available in a window for the given lane count. */
export function cartCpuCapacityMs(lanes: number, windowMs: number): number {
  if (!Number.isFinite(lanes) || lanes <= 0) {
    throw new RangeError('lanes must be finite and positive');
  }
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new RangeError('windowMs must be finite and non-negative');
  }
  return (lanes * CART_CPU_MS_PER_SECOND_PER_LANE * windowMs) / 1_000;
}

/**
 * Peak-case score (credits/hour) from B5. Rental accrues for the measured
 * window extended by preparation and drain; WAN bytes cost 1 credit/GiB.
 */
export function cartPeakScoreCreditsPerHour(input: {
  readonly rentalPerHour: number;
  readonly wanBillableBytes: number;
  readonly measuredSeconds?: number;
  readonly preparationSeconds?: number;
  readonly drainSeconds?: number;
}): number {
  const measured = input.measuredSeconds ?? 90;
  const preparation = input.preparationSeconds ?? 0;
  const drain = input.drainSeconds ?? 0;
  if (!Number.isFinite(input.rentalPerHour) || input.rentalPerHour < 0) {
    throw new RangeError('rentalPerHour must be finite and non-negative');
  }
  if (!Number.isFinite(input.wanBillableBytes) || input.wanBillableBytes < 0) {
    throw new RangeError('wanBillableBytes must be finite and non-negative');
  }
  if (![measured, preparation, drain].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new RangeError('durations must be finite and non-negative');
  }
  const windowSeconds = measured + preparation + drain;
  const rentalTerm = input.rentalPerHour * (windowSeconds / 3_600);
  const bytesTerm = input.wanBillableBytes / CART_GIB_BYTES;
  return (3_600 / measured) * (rentalTerm + bytesTerm);
}

// ---------------------------------------------------------------------------
// Reservation ledger
// ---------------------------------------------------------------------------

export type CartResourceRejection =
  | 'unknown_node'
  | 'pending_limit'
  | 'queue_ram'
  | 'durable_capacity'
  | 'invalid_reservation';

export type CartReserveResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: CartResourceRejection;
      readonly requested: number;
      readonly available: number;
    };

interface NodeAccount {
  readonly capacity: CartNodeCapacity;
  /** Waiting tasks per application instance key (1 for non-app nodes). */
  readonly pendingByInstance: Map<number, number>;
  queueRamBytes: number;
  /** Standing working memory of modeled indexes (e.g. Inventory order/SKU). */
  indexRamBytes: number;
  durableReservedBytes: number;
  durableCommittedBytes: number;
  cpuBusyMs: number;
  ioUnits: number;
}

/**
 * Deterministic reservation ledger. Rejected reservations never mutate state;
 * committed durable bytes can never be revoked or released.
 */
export class CartResourceLedger {
  private readonly accounts = new Map<string, NodeAccount>();

  constructor(plan: CartResourcePlan) {
    for (const [nodeId, capacity] of plan.nodes) {
      this.accounts.set(nodeId, {
        capacity,
        pendingByInstance: new Map(),
        queueRamBytes: 0,
        indexRamBytes: 0,
        durableReservedBytes: 0,
        durableCommittedBytes: 0,
        cpuBusyMs: 0,
        ioUnits: 0,
      });
    }
  }

  private account(nodeId: string): NodeAccount | undefined {
    return this.accounts.get(nodeId);
  }

  get workingRamBytes(): ReadonlyMap<string, number> {
    const result = new Map<string, number>();
    for (const [nodeId, account] of this.accounts) {
      result.set(nodeId, account.capacity.ramBytesTotal - account.capacity.fixedRamBytes * account.capacity.instances);
    }
    return result;
  }

  /** Enqueues one pending task and charges queue RAM (1024 B + payload). */
  enqueueTask(nodeId: string, payloadBytes: number, instance = 1, atUs = 0): CartReserveResult {
    if (!Number.isFinite(payloadBytes) || payloadBytes < 0) {
      throw new RangeError('payload bytes must be finite and non-negative');
    }
    const account = this.account(nodeId);
    if (account === undefined) {
      return { ok: false, reason: 'unknown_node', requested: payloadBytes, available: 0 };
    }
    if (!Number.isInteger(instance) || instance < 1 || instance > account.capacity.instances) {
      return { ok: false, reason: 'invalid_reservation', requested: payloadBytes, available: 0 };
    }
    void atUs;
    const pending = account.pendingByInstance.get(instance) ?? 0;
    if (pending + 1 > account.capacity.pendingLimit) {
      return {
        ok: false,
        reason: 'pending_limit',
        requested: pending + 1,
        available: account.capacity.pendingLimit,
      };
    }
    const addedRam = CART_QUEUE_TASK_RAM_BYTES + payloadBytes;
    const workingRam =
      account.capacity.ramBytesTotal - account.capacity.fixedRamBytes * account.capacity.instances;
    // Standing index memory (Inventory's own accounting) is unavailable to
    // queues, so a node cannot over-commit its working memory twice.
    if (account.queueRamBytes + account.indexRamBytes + addedRam > workingRam) {
      return {
        ok: false,
        reason: 'queue_ram',
        requested: account.queueRamBytes + account.indexRamBytes + addedRam,
        available: workingRam,
      };
    }
    account.pendingByInstance.set(instance, pending + 1);
    account.queueRamBytes += addedRam;
    return { ok: true };
  }

  /** Releases one pending task and its queue RAM. */
  completeTask(nodeId: string, payloadBytes: number, instance = 1): boolean {
    const account = this.account(nodeId);
    if (account === undefined) {
      return false;
    }
    const pending = account.pendingByInstance.get(instance) ?? 0;
    if (pending <= 0) {
      return false;
    }
    account.pendingByInstance.set(instance, pending - 1);
    account.queueRamBytes -= CART_QUEUE_TASK_RAM_BYTES + payloadBytes;
    return true;
  }

  /**
   * Reserves standing working memory for a modeled index (Inventory's own
   * order/SKU accounting). Rejected before the index grows, never revoked.
   */
  reserveWorkingRam(nodeId: string, bytes: number): CartReserveResult {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError('working RAM bytes must be finite and non-negative');
    }
    const account = this.account(nodeId);
    if (account === undefined) {
      return { ok: false, reason: 'unknown_node', requested: bytes, available: 0 };
    }
    const workingRam =
      account.capacity.ramBytesTotal - account.capacity.fixedRamBytes * account.capacity.instances;
    const used = account.queueRamBytes + account.indexRamBytes;
    if (used + bytes > workingRam) {
      return { ok: false, reason: 'queue_ram', requested: used + bytes, available: workingRam };
    }
    account.indexRamBytes += bytes;
    return { ok: true };
  }

  /** Releases previously reserved standing working memory (bounded indexes only). */
  releaseWorkingRam(nodeId: string, bytes: number): boolean {
    const account = this.account(nodeId);
    if (account === undefined || bytes < 0 || account.indexRamBytes < bytes) return false;
    account.indexRamBytes -= bytes;
    return true;
  }

  /** Reserves durable bytes before commit; capacity is per node total. */
  reserveDurable(nodeId: string, bytes: number): CartReserveResult {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError('durable bytes must be finite and non-negative');
    }
    const account = this.account(nodeId);
    if (account === undefined) {
      return { ok: false, reason: 'unknown_node', requested: bytes, available: 0 };
    }
    const used = account.durableReservedBytes + account.durableCommittedBytes;
    if (used + bytes > account.capacity.durableBytesTotal) {
      return {
        ok: false,
        reason: 'durable_capacity',
        requested: used + bytes,
        available: account.capacity.durableBytesTotal,
      };
    }
    account.durableReservedBytes += bytes;
    return { ok: true };
  }

  /** Turns a reservation into committed state; it can never be revoked. */
  commitDurable(nodeId: string, bytes: number): boolean {
    const account = this.account(nodeId);
    if (account === undefined || bytes < 0 || account.durableReservedBytes < bytes) {
      return false;
    }
    account.durableReservedBytes -= bytes;
    account.durableCommittedBytes += bytes;
    return true;
  }

  /** Releases an uncommitted reservation only. */
  releaseDurable(nodeId: string, bytes: number): boolean {
    const account = this.account(nodeId);
    if (account === undefined || bytes < 0 || account.durableReservedBytes < bytes) {
      return false;
    }
    account.durableReservedBytes -= bytes;
    return true;
  }

  chargeCpu(nodeId: string, cpuMs: number): boolean {
    const account = this.account(nodeId);
    if (account === undefined || !Number.isFinite(cpuMs) || cpuMs < 0) {
      return false;
    }
    account.cpuBusyMs += cpuMs;
    return true;
  }

  chargeIo(nodeId: string, units = 1): boolean {
    const account = this.account(nodeId);
    if (account === undefined || !Number.isInteger(units) || units < 0) {
      return false;
    }
    account.ioUnits += units;
    return true;
  }

  snapshot(nodeId: string): {
    readonly pendingTasks: number;
    readonly queueRamBytes: number;
    readonly indexRamBytes: number;
    readonly workingRamBytes: number;
    readonly durableReservedBytes: number;
    readonly durableCommittedBytes: number;
    readonly durableFreeBytes: number;
    readonly cpuBusyMs: number;
    readonly ioUnits: number;
  } | null {
    const account = this.account(nodeId);
    if (account === undefined) {
      return null;
    }
    let pendingTasks = 0;
    for (const count of account.pendingByInstance.values()) {
      pendingTasks += count;
    }
    const workingRam =
      account.capacity.ramBytesTotal - account.capacity.fixedRamBytes * account.capacity.instances;
    return {
      pendingTasks,
      queueRamBytes: account.queueRamBytes,
      indexRamBytes: account.indexRamBytes,
      workingRamBytes: workingRam,
      durableReservedBytes: account.durableReservedBytes,
      durableCommittedBytes: account.durableCommittedBytes,
      durableFreeBytes:
        account.capacity.durableBytesTotal -
        account.durableReservedBytes -
        account.durableCommittedBytes,
      cpuBusyMs: account.cpuBusyMs,
      ioUnits: account.ioUnits,
    };
  }

  /** Sums every node reservation; used by conservation tests. */
  totals(): {
    readonly queueRamBytes: number;
    readonly durableReservedBytes: number;
    readonly durableCommittedBytes: number;
    readonly durableCapacityBytes: number;
  } {
    let queueRamBytes = 0;
    let durableReservedBytes = 0;
    let durableCommittedBytes = 0;
    let durableCapacityBytes = 0;
    for (const account of this.accounts.values()) {
      queueRamBytes += account.queueRamBytes;
      durableReservedBytes += account.durableReservedBytes;
      durableCommittedBytes += account.durableCommittedBytes;
      durableCapacityBytes += account.capacity.durableBytesTotal;
    }
    return { queueRamBytes, durableReservedBytes, durableCommittedBytes, durableCapacityBytes };
  }
}
