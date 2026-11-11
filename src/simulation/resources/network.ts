/**
 * Conservative network-flow adapter for the resource kernel.
 *
 * This is a deliberate teaching approximation, not TCP modelling and not
 * ideal fair sharing. One logical flow reserves one shared quantum of
 * 1 Gbit/s on every physical resource along its explicit path. The service
 * duration is `bytes * 8 / 1e6` milliseconds. A 10 Gbit/s NIC therefore has 10
 * lanes, a 100 Gbit/s regional link has 100 lanes, and a 1 Gbit/s end-user
 * access link has 1 lane. Ten child transfers of one business request all
 * reserve the same access resource, so they share that one lane instead of
 * inventing ten independent access links.
 *
 * Only serialization holds lanes. Propagation happens after serialization and
 * is returned separately so the caller can add it without consuming bandwidth.
 *
 * The helper contains no Image Atlas catalogue constants. Callers pass
 * explicit physical ids and capacities; the evaluator registers those ids in
 * the kernel. Full-duplex directions must use distinct ids when both
 * directions can be active at once.
 */

import type { ResourceRequirement } from './kernel';

/** One lane carries 1 Gbit/s, i.e. 1e6 bits per millisecond. */
export const NETWORK_LANE_BITS_PER_MS = 1_000_000;
export const NETWORK_LANE_BITS_PER_SECOND = 1_000_000_000;

export interface NetworkTransferInput {
  /** Payload bytes serialized on the path. Must be finite and non-negative. */
  readonly bytes: number;
  readonly sourceNicId: string;
  readonly destinationNicId: string;
  /** Ordered transit links. Repeated physical ids are normalized. */
  readonly linkIds?: readonly string[];
  /** End-user access or other explicit access resources on the path. */
  readonly accessIds?: readonly string[];
  /** One-way propagation after serialization. Defaults to zero. */
  readonly propagationMs?: number;
}

export interface NetworkTransferDemand {
  /** One lane on each unique physical resource on the path. */
  readonly resources: readonly ResourceRequirement[];
  /** Time that holds all path lanes, in milliseconds. */
  readonly serviceDurationMs: number;
  /** Delay after serialization; does not hold lanes. */
  readonly propagationMs: number;
  /** Service plus propagation, for callers that only need a total delay. */
  readonly totalDurationMs: number;
  readonly bytes: number;
  readonly lanesPerFlow: number;
}

export interface TransferByteAccounting {
  readonly offeredBytes: number;
  readonly deliveredBytes: number;
  readonly undeliveredBytes: number;
  readonly workFraction: number;
}

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

/** Converts a link/NIC bandwidth into 1 Gbit/s kernel lanes. */
export function networkLanesForBandwidth(bitsPerSecond: number): number {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) {
    throw new RangeError('bandwidth must be finite and positive');
  }
  return bitsPerSecond / NETWORK_LANE_BITS_PER_SECOND;
}

/**
 * Builds an atomic lane demand for one flow.
 *
 * The same physical id appearing more than once on the path (for example a
 * source NIC also listed as a transit link by a caller mistake) is counted
 * once. This prevents a duplicate arrow from multiplying physical capacity.
 */
export function buildNetworkTransferDemand(
  input: NetworkTransferInput,
): NetworkTransferDemand {
  if (!Number.isFinite(input.bytes) || input.bytes < 0) {
    throw new RangeError('transfer bytes must be finite and non-negative');
  }
  const propagationMs = input.propagationMs ?? 0;
  if (!Number.isFinite(propagationMs) || propagationMs < 0) {
    throw new RangeError('propagation delay must be finite and non-negative');
  }

  const orderedIds: string[] = [
    requireId(input.sourceNicId, 'sourceNicId'),
    ...(input.linkIds ?? []).map((id, index) =>
      requireId(id, `linkIds[${index}]`),
    ),
    requireId(input.destinationNicId, 'destinationNicId'),
    ...(input.accessIds ?? []).map((id, index) =>
      requireId(id, `accessIds[${index}]`),
    ),
  ];

  const seen = new Set<string>();
  const resources: ResourceRequirement[] = [];
  for (const id of orderedIds) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    resources.push({ id, units: 1 });
  }

  const serviceDurationMs = (input.bytes * 8) / NETWORK_LANE_BITS_PER_MS;
  return {
    resources,
    serviceDurationMs,
    propagationMs,
    totalDurationMs: serviceDurationMs + propagationMs,
    bytes: input.bytes,
    lanesPerFlow: 1,
  };
}

/**
 * Converts a kernel `workFraction` into delivered/undelivered bytes. The
 * evaluator decides whether undelivered bytes are in-flight or dropped; this
 * helper never invents delivery.
 */
export function accountTransferBytes(
  offeredBytes: number,
  workFraction: number,
): TransferByteAccounting {
  if (!Number.isFinite(offeredBytes) || offeredBytes < 0) {
    throw new RangeError('offered bytes must be finite and non-negative');
  }
  if (!Number.isFinite(workFraction)) {
    throw new RangeError('work fraction must be finite');
  }
  const fraction = workFraction <= 0 ? 0 : workFraction >= 1 ? 1 : workFraction;
  const deliveredBytes = offeredBytes * fraction;
  return {
    offeredBytes,
    deliveredBytes,
    undeliveredBytes: offeredBytes - deliveredBytes,
    workFraction: fraction,
  };
}
