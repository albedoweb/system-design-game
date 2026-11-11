/**
 * GC-010 — strict, atomic Inventory checkout (`cart-protocol-v1` §5/B4).
 *
 * One authoritative Inventory owns stock, orders and the durable idempotency
 * ledger. Every public call below is a single transaction on that node's serial
 * FIFO stream: it runs to completion, its durable mutation is atomic, and only
 * then may a reply exist. There is no reservation, no partial decrement and no
 * second authority.
 *
 * The model enforces the promises the level makes to players:
 *
 * - **Ledger first.** `lookup` is the durable dedup read (0.10 CPU-ms + one IO).
 *   An existing identical binding returns its recorded terminal outcome with no
 *   cart read and no stock effect; a different binding for the same order key is
 *   `idempotency-conflict`. A lookup miss is a reply, never an authorization.
 * - **Selected view binding.** The key is bound to `(orderKey, cartId,
 *   selectedViewDigest, lines)`. A first purchase must present a complete-view
 *   read evidence packet whose covered ids reproduce the digest and whose
 *   displayed lines are exactly the bound basket; otherwise the result is
 *   `selection-changed` (or `validation-failed` for missing/forged provenance)
 *   with no ledger row and no stock effect.
 * - **All-or-nothing commit.** Inside the transaction the ledger is rechecked
 *   before stock. If every line fits, all lines decrement and the success order
 *   is recorded; otherwise no line changes and a terminal `out-of-stock` record
 *   is stored. Intermediate decrements are never published.
 * - **Durability before reply.** A terminal result reserves its full durable
 *   storage (256 B + 32 B per line) before mutation, commits atomically and
 *   flushes at `atUs + 2000 µs`. A full ledger returns `unavailable` with zero
 *   stock effect; already committed records are never revoked.
 * - **Lost replies replay safely.** Dropping a commit reply leaves the durable
 *   outcome in place. A retry starts with `lookup`, recovers that outcome with
 *   `duplicate: true` and performs no second decrement — it never re-reads the
 *   current cart, so later cart edits cannot substitute a different basket.
 * - **Unavailable authority is unknown.** When the node cannot be reached the
 *   result is `unavailable`/client-`unknown`, never success and never
 *   `out-of-stock`.
 *
 * Work and bytes follow DEVELOPER §7: lookup 0.10 CPU-ms + one IO; transaction
 * 0.50 CPU-ms + 0.10 per line + two IO; evidence 0.10 CPU-ms per covered id;
 * terminal record 256 B + 32 B/line; RAM index 64 B per order and 32 B per SKU.
 *
 * The module is deterministic: no wall clock, randomness, network or DOM.
 */
import {
  CART_REGIONS,
  canonicalJson,
  sha256Hex,
  type CartRegion,
  type CartServiceSize,
} from '../contracts';
import type { CartMaterializedView } from './cart-state';
import type { CartReadComplete } from './reads';
import { CART_COMPONENT_TABLE, CART_DURABLE_FLUSH_US } from './resources';
import {
  CART_FRESHNESS_BOUND_US,
  isAuthorityIssuedCertificate,
  isCertificateIssuedBy,
  type CartCertificate,
  type CartOriginCommitLedger,
} from './tokens';

// ---------------------------------------------------------------------------
// Protocol caps, bytes and charges (DEVELOPER §7, CONTRACT B4)
// ---------------------------------------------------------------------------

/** One durable terminal result: success or out-of-stock alike. */
export const CART_INVENTORY_TERMINAL_RESULT_BYTES = 256;
/** Each basket line retained inside a terminal result. */
export const CART_INVENTORY_BASKET_LINE_BYTES = 32;
/** RAM index per recorded order / ledger row. */
export const CART_INVENTORY_ORDER_INDEX_BYTES = 64;
/** RAM index per SKU whose stock the node tracks. */
export const CART_INVENTORY_SKU_INDEX_BYTES = 32;

/** Durable dedup read: same charge as any other durable dedup hit. */
export const CART_INVENTORY_LOOKUP_CPU_MS = 0.1;
export const CART_INVENTORY_LOOKUP_IO_UNITS = 1;
/** Atomic stock/order/result transaction. */
export const CART_INVENTORY_TRANSACTION_CPU_MS = 0.5;
export const CART_INVENTORY_TRANSACTION_PER_LINE_CPU_MS = 0.1;
export const CART_INVENTORY_TRANSACTION_IO_UNITS = 2;
/** Validating explicitly supplied read provenance. */
export const CART_INVENTORY_EVIDENCE_PER_ID_CPU_MS = 0.1;

/**
 * A checkout basket can contain at most one line per cart SKU, and a cart never
 * retains more than the 400-operation protocol cap, so a larger basket cannot
 * be a selected live view.
 */
export const CART_INVENTORY_MAX_BASKET_LINES = 400;

/**
 * Composed operation/unit ids embed the cart namespace and key, so the 64-char
 * identifier cap applies to their parts rather than the whole id.
 */
const IDENTIFIER_PATTERN = /^[\x20-\x7e]{1,64}$/;
const EVIDENCE_ID_PATTERN = /^[\x20-\x7e]{1,512}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Basket binding
// ---------------------------------------------------------------------------

export interface CartBasketLine {
  readonly sku: string;
  readonly quantity: number;
}

/** The client-selected complete view a purchase is bound to. */
export interface CartCheckoutSelection {
  readonly cartId: string;
  /** Operation ids the validating complete read actually covered. */
  readonly coveredIds: readonly string[];
  /** Every selected live line with its quantity; none omitted. */
  readonly lines: readonly CartBasketLine[];
}

/**
 * Immutable retry binding: `(orderKey, cartId, selectedViewDigest, lines)`.
 * Session tokens are deliberately absent; they may legitimately grow after a
 * purchase without changing the retry identity.
 */
export interface CartCheckoutBinding {
  readonly orderKey: string;
  readonly cartId: string;
  readonly selectedViewDigest: string;
  readonly lines: readonly CartBasketLine[];
}

/** Fresh copy sorted by SKU, with only the semantic fields retained. */
export function canonicalBasketLines(lines: readonly CartBasketLine[]): CartBasketLine[] {
  return [...lines]
    .map((line) => ({ sku: line.sku, quantity: line.quantity }))
    .sort((left, right) => (left.sku < right.sku ? -1 : left.sku > right.sku ? 1 : 0));
}

function sameLines(
  left: readonly CartBasketLine[],
  right: readonly CartBasketLine[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] as CartBasketLine;
    const b = right[index] as CartBasketLine;
    if (a.sku !== b.sku || a.quantity !== b.quantity) return false;
  }
  return true;
}

/**
 * SHA-256 of CONTRACT §2 canonical JSON
 * `{cartId, coveredIds (sorted), lines (sorted by SKU)}`.
 *
 * Canonical JSON sorts object keys recursively, so a line serializes as
 * `{"quantity":…,"sku":…}` and the root as `cartId`, `coveredIds`, `lines`,
 * regardless of the key order of the supplied objects. Arrays keep the order
 * given by the caller, so covered ids and lines are normalized first.
 */
export function cartSelectedViewDigest(
  cartId: string,
  coveredIds: readonly string[],
  lines: readonly CartBasketLine[],
): string {
  const canonical = canonicalJson({
    cartId,
    coveredIds: [...coveredIds].sort(),
    lines: canonicalBasketLines(lines),
  });
  return sha256Hex(canonical);
}

/** Build the immutable binding for a first purchase. */
export function createCartCheckoutBinding(
  orderKey: string,
  selection: CartCheckoutSelection,
): CartCheckoutBinding {
  const lines = canonicalBasketLines(selection.lines);
  return {
    orderKey,
    cartId: selection.cartId,
    selectedViewDigest: cartSelectedViewDigest(selection.cartId, selection.coveredIds, lines),
    lines,
  };
}

// ---------------------------------------------------------------------------
// Validation (always before any ledger row or stock mutation)
// ---------------------------------------------------------------------------

/** Deterministic pre-mutation basket issues; empty means valid. */
export function validateCartBasket(lines: readonly CartBasketLine[]): string[] {
  const issues: string[] = [];
  if (lines.length === 0) issues.push('empty-basket');
  if (lines.length > CART_INVENTORY_MAX_BASKET_LINES) issues.push('too-many-lines');

  const seen = new Set<string>();
  for (const line of lines) {
    if (typeof line.sku !== 'string' || !IDENTIFIER_PATTERN.test(line.sku)) {
      issues.push(`invalid-sku:${String(line.sku)}`);
    }
    if (seen.has(line.sku)) issues.push(`duplicate-sku:${line.sku}`);
    seen.add(line.sku);
    if (!Number.isInteger(line.quantity)) {
      issues.push(`non-integer-quantity:${line.sku}`);
    } else if (line.quantity <= 0) {
      issues.push(`non-positive-quantity:${line.sku}`);
    }
  }
  return issues;
}

/** Structural issues in a retry binding; empty means structurally valid. */
export function validateCartCheckoutBinding(binding: CartCheckoutBinding): string[] {
  const issues: string[] = [];
  if (typeof binding.orderKey !== 'string' || !IDENTIFIER_PATTERN.test(binding.orderKey)) {
    issues.push('invalid-order-key');
  }
  if (typeof binding.cartId !== 'string' || !IDENTIFIER_PATTERN.test(binding.cartId)) {
    issues.push('invalid-cart-id');
  }
  if (
    typeof binding.selectedViewDigest !== 'string' ||
    !DIGEST_PATTERN.test(binding.selectedViewDigest)
  ) {
    issues.push('invalid-selected-view-digest');
  }
  issues.push(...validateCartBasket(binding.lines));
  return issues;
}

// ---------------------------------------------------------------------------
// Read evidence (what the Application packages after a complete read)
// ---------------------------------------------------------------------------

/**
 * A complete read as Inventory receives it: the exact covered operation set,
 * the displayed live lines and the origin certificates that grounded the read.
 *
 * `certificates` must be the original authority-issued certificate objects (or
 * replica-carried originals), never caller-reconstructed copies: issuance
 * identity is object identity, and a plain object shaped like a certificate is
 * not provenance.
 */
export interface CartCheckoutRead {
  readonly cartId: string;
  readonly coveredIds: readonly string[];
  readonly lines: readonly CartBasketLine[];
  readonly certificates: readonly CartCertificate[];
  readonly deliveryUs: number;
  readonly requestId: string;
}

/** Evidence packet handed to `Commit(binding, evidence)` (CONTRACT B4). */
export interface CartCheckoutEvidence {
  readonly cartId: string;
  readonly coveredIds: readonly string[];
  readonly certificates: readonly CartCertificate[];
  readonly readDeliveryUs: number;
  readonly readRequestId: string;
  readonly displayedLines: readonly CartBasketLine[];
}

/** Live lines of a materialized complete view, ascending by SKU. */
export function cartCheckoutLinesFromView(view: CartMaterializedView): CartBasketLine[] {
  return Object.entries(view.skus)
    .filter(([, sku]) => sku.quantity > 0)
    .map(([sku, state]) => ({ sku, quantity: state.quantity }))
    .sort((left, right) => (left.sku < right.sku ? -1 : left.sku > right.sku ? 1 : 0));
}

/**
 * The Application packages its real complete read as evidence. `deliveryUs` and
 * `requestId` identify the actual read that passed the read gate; they are not
 * recomputed here.
 *
 * The certificate objects are carried through unchanged: their authority
 * issuance brand is the provenance proof Inventory validates. Rebuilding them
 * as plain field copies would silently discard that proof.
 */
export function cartCheckoutReadFromView(
  read: CartReadComplete,
  options: { readonly deliveryUs: number; readonly requestId: string },
): CartCheckoutRead {
  return {
    cartId: read.cartId,
    coveredIds: [...read.coveredIds],
    lines: cartCheckoutLinesFromView(read.view),
    certificates: [...read.evidence.certificates],
    deliveryUs: options.deliveryUs,
    requestId: options.requestId,
  };
}

/** Freeze a read into the exact packet Commit validates. */
export function createCartCheckoutEvidence(read: CartCheckoutRead): CartCheckoutEvidence {
  return {
    cartId: read.cartId,
    coveredIds: [...read.coveredIds],
    certificates: [...read.certificates],
    readDeliveryUs: read.deliveryUs,
    readRequestId: read.requestId,
    displayedLines: canonicalBasketLines(read.lines),
  };
}

// ---------------------------------------------------------------------------
// Results, charges and durable records
// ---------------------------------------------------------------------------

export type CartInventoryOutcome =
  | 'lookup-miss'
  | 'committed'
  | 'out-of-stock'
  | 'idempotency-conflict'
  | 'selection-changed'
  | 'validation-failed'
  | 'unavailable';

export type CartInventoryUnavailableReason =
  | 'authority-unreachable'
  | 'ledger-full'
  | 'read-unavailable';

/** What the caller observes; a lost reply leaves the transport outcome unknown. */
export type CartInventoryClientOutcome = CartInventoryOutcome | 'unknown';

export interface CartInventoryCharge {
  readonly cpuMilliseconds: number;
  readonly ioUnits: number;
  readonly requests: number;
}

export interface CartInventoryResult {
  readonly outcome: CartInventoryOutcome;
  /** True only when an existing identical ledger row answered this attempt. */
  readonly duplicate: boolean;
  /** False when the reply was lost after the durable outcome was recorded. */
  readonly replyDelivered: boolean;
  readonly clientOutcome: CartInventoryClientOutcome;
  readonly reason?: CartInventoryUnavailableReason;
  readonly issues: readonly string[];
  readonly charge: CartInventoryCharge;
  /** FIFO transaction sequence of the call that produced this result. */
  readonly transactionSequence: number;
  /** Durable flush time for a mutation; the recorded time for a replay. */
  readonly durableAtUs: number | null;
  /** Durable bytes currently reserved by the ledger. */
  readonly ledgerBytes: number;
  readonly stock: Readonly<Record<string, number>>;
}

export interface CartInventoryOrder {
  readonly orderKey: string;
  readonly cartId: string;
  readonly selectedViewDigest: string;
  readonly lines: readonly CartBasketLine[];
  readonly commitSequence: number;
  readonly committedAtUs: number;
}

export interface CartInventoryLedgerRow {
  readonly orderKey: string;
  readonly cartId: string;
  readonly selectedViewDigest: string;
  readonly lines: readonly CartBasketLine[];
  readonly outcome: 'committed' | 'out-of-stock';
  readonly recordedAtSequence: number;
  readonly recordedAtUs: number;
  readonly durableBytes: number;
}

/** Checkpoint emitted after the durable mutation and before any reply exists. */
export interface CartInventoryCommitRecord {
  readonly nodeId: string;
  readonly sequence: number;
  readonly commitSequence: number;
  readonly orderKey: string;
  readonly cartId: string;
  readonly selectedViewDigest: string;
  readonly lines: readonly CartBasketLine[];
  readonly outcome: 'committed' | 'out-of-stock';
  readonly stockBefore: Readonly<Record<string, number>>;
  readonly stockAfter: Readonly<Record<string, number>>;
  readonly durableAtUs: number;
  readonly durableBytes: number;
  readonly ledgerBytes: number;
}

export interface CartInventoryOptions {
  readonly nodeId: string;
  readonly size: CartServiceSize;
  /** Initial authoritative stock; non-negative integers keyed by SKU. */
  readonly initialStock: Readonly<Record<string, number>>;
  /**
   * The exact configured immutable-write-authority ledger object of each cart
   * origin (CONTRACT B2/B4). Inventory trusts a certificate only when the
   * ledger configured here for its origin actually minted that object.
   * `authorityNodeId` equality alone is not issuance: a caller-built ledger
   * with a colliding name cannot hand out checkout provenance.
   */
  readonly originAuthorities: Readonly<Partial<Record<CartRegion, CartOriginCommitLedger>>>;
  /** Overrides the table durable capacity for focused capacity tests. */
  readonly durableCapacityBytes?: number;
  /** Modeled reachability of this authoritative node; default true. */
  readonly reachable?: boolean;
  /** Observation point invoked after the durable commit, before the reply. */
  readonly onCommit?: (record: CartInventoryCommitRecord) => void;
}

export interface CartInventoryConservation {
  readonly conserved: boolean;
  readonly violations: readonly string[];
}

interface ResultInput {
  readonly duplicate?: boolean;
  readonly replyDelivered?: boolean;
  readonly reason?: CartInventoryUnavailableReason;
  readonly issues?: readonly string[];
  readonly charge: CartInventoryCharge;
  readonly transactionSequence: number;
  readonly durableAtUs?: number | null;
}

const ZERO_CHARGE: CartInventoryCharge = { cpuMilliseconds: 0, ioUnits: 0, requests: 0 };

function chargeOf(
  cpuMilliseconds: number,
  ioUnits: number,
  requests = 1,
): CartInventoryCharge {
  return { cpuMilliseconds, ioUnits, requests };
}

function addCharge(left: CartInventoryCharge, right: CartInventoryCharge): CartInventoryCharge {
  return {
    cpuMilliseconds: left.cpuMilliseconds + right.cpuMilliseconds,
    ioUnits: left.ioUnits + right.ioUnits,
    requests: left.requests + right.requests,
  };
}

// ---------------------------------------------------------------------------
// The authoritative Inventory
// ---------------------------------------------------------------------------

export class CartInventory {
  readonly nodeId: string;
  readonly size: CartServiceSize;

  private readonly capacityBytes: number;
  private readonly initialStock: Readonly<Record<string, number>>;
  private readonly originAuthorities: Readonly<
    Partial<Record<CartRegion, CartOriginCommitLedger>>
  >;
  private readonly onCommit: ((record: CartInventoryCommitRecord) => void) | undefined;
  private stockState: Record<string, number>;
  private ledgerRows: CartInventoryLedgerRow[] = [];
  private orderRows: CartInventoryOrder[] = [];
  private usedDurableBytes = 0;
  private transactionCounter = 0;
  private commitCounter = 0;
  private reachable: boolean;

  constructor(options: CartInventoryOptions) {
    if (typeof options.nodeId !== 'string' || !IDENTIFIER_PATTERN.test(options.nodeId)) {
      throw new TypeError(`invalid inventory node id: ${String(options.nodeId)}`);
    }
    const spec = CART_COMPONENT_TABLE.inventory[options.size];
    this.nodeId = options.nodeId;
    this.size = options.size;
    this.capacityBytes = options.durableCapacityBytes ?? spec.durableBytes;
    if (!Number.isInteger(this.capacityBytes) || this.capacityBytes < 0) {
      throw new RangeError('inventory durable capacity must be a non-negative integer');
    }
    this.reachable = options.reachable ?? true;
    this.onCommit = options.onCommit;
    const authorities: Partial<Record<CartRegion, CartOriginCommitLedger>> = {};
    for (const [origin, ledger] of Object.entries(options.originAuthorities)) {
      if (ledger === undefined) continue;
      authorities[origin as CartRegion] = ledger;
    }
    this.originAuthorities = Object.freeze(authorities);

    const stock: Record<string, number> = {};
    for (const [sku, quantity] of Object.entries(options.initialStock)) {
      if (!IDENTIFIER_PATTERN.test(sku)) {
        throw new TypeError(`invalid stock SKU: ${sku}`);
      }
      if (!Number.isInteger(quantity) || quantity < 0) {
        throw new RangeError(`stock for ${sku} must be a non-negative integer`);
      }
      stock[sku] = quantity;
    }
    this.initialStock = Object.freeze({ ...stock });
    this.stockState = { ...stock };
  }

  /** Modeled authority reachability; an unreachable node answers nothing. */
  setReachable(reachable: boolean): void {
    this.reachable = reachable;
  }

  isReachable(): boolean {
    return this.reachable;
  }

  get durableCapacityBytes(): number {
    return this.capacityBytes;
  }

  get durableBytesUsed(): number {
    return this.usedDurableBytes;
  }

  /** 64 B per order/ledger row plus 32 B per tracked SKU. */
  get ramIndexBytes(): number {
    return (
      this.ledgerRows.length * CART_INVENTORY_ORDER_INDEX_BYTES +
      Object.keys(this.stockState).length * CART_INVENTORY_SKU_INDEX_BYTES
    );
  }

  /** Number of durable terminal rows; cheap public accounting view. */
  get ledgerRowCount(): number {
    return this.ledgerRows.length;
  }

  stockSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({ ...this.stockState });
  }

  ledgerSnapshot(): readonly CartInventoryLedgerRow[] {
    return this.ledgerRows.map((row) => ({ ...row, lines: row.lines.map((line) => ({ ...line })) }));
  }

  ordersSnapshot(): readonly CartInventoryOrder[] {
    return this.orderRows.map((order) => ({
      ...order,
      lines: order.lines.map((line) => ({ ...line })),
    }));
  }

  /**
   * `Lookup(binding)`: the durable dedup read that starts every new or replay
   * attempt. Charged 0.10 CPU-ms + one IO; holds the FIFO slot for its duration.
   */
  lookup(binding: CartCheckoutBinding): CartInventoryResult {
    if (!this.reachable) {
      return this.result('unavailable', {
        replyDelivered: false,
        reason: 'authority-unreachable',
        charge: chargeOf(0, 0),
        transactionSequence: 0,
      });
    }

    const sequence = ++this.transactionCounter;
    const charge = chargeOf(
      CART_INVENTORY_LOOKUP_CPU_MS,
      CART_INVENTORY_LOOKUP_IO_UNITS,
    );
    if (typeof binding.orderKey !== 'string' || !IDENTIFIER_PATTERN.test(binding.orderKey)) {
      return this.result('validation-failed', {
        charge,
        transactionSequence: sequence,
        issues: ['invalid-order-key'],
      });
    }
    if (!Array.isArray(binding.lines)) {
      return this.result('validation-failed', {
        charge,
        transactionSequence: sequence,
        issues: ['invalid-basket-lines'],
      });
    }

    const existing = this.findRow(binding.orderKey);
    if (!existing) {
      return this.result('lookup-miss', { charge, transactionSequence: sequence });
    }
    const identical = this.rowMatches(existing, binding);
    return this.result(identical ? existing.outcome : 'idempotency-conflict', {
      duplicate: identical,
      charge,
      transactionSequence: sequence,
      durableAtUs: existing.recordedAtUs,
    });
  }

  /** Adapter preview at exclusive slot start; no ledger, stock or counters change.
   * The slot must remain held until these stages finish and commit is called.
   */
  commitService(binding: CartCheckoutBinding, evidence: CartCheckoutEvidence | null | undefined, atUs: number): {
    charge: CartInventoryCharge; flushUs: number;
  } {
    if (!this.reachable) return { charge: ZERO_CHARGE, flushUs: 0 };
    const lines = Array.isArray(binding.lines) ? canonicalBasketLines(binding.lines) : [];
    const base = chargeOf(CART_INVENTORY_TRANSACTION_CPU_MS +
      CART_INVENTORY_TRANSACTION_PER_LINE_CPU_MS * lines.length, CART_INVENTORY_TRANSACTION_IO_UNITS);
    if (!Array.isArray(binding.lines) || this.findRow(binding.orderKey) ||
        validateCartCheckoutBinding({ ...binding, lines }).length > 0) {
      return { charge: base, flushUs: 0 };
    }
    const charge = addCharge(base, evidence
      ? chargeOf(CART_INVENTORY_EVIDENCE_PER_ID_CPU_MS * this.evidenceIdCount(evidence), 0, 0)
      : ZERO_CHARGE);
    const terminal = this.validateEvidence(binding, evidence, atUs).length === 0 &&
      this.matchEvidence(binding, lines, evidence as CartCheckoutEvidence).length === 0 &&
      this.usedDurableBytes + CART_INVENTORY_TERMINAL_RESULT_BYTES +
        CART_INVENTORY_BASKET_LINE_BYTES * lines.length <= this.capacityBytes;
    return { charge, flushUs: terminal ? CART_DURABLE_FLUSH_US : 0 };
  }

  /**
   * `Commit(binding, evidence)`: one atomic transaction on the FIFO stream.
   * Ledger recheck, validation, evidence, storage reservation, all-line stock
   * check and durable result happen in that order and never publish a partial
   * decrement. `completedUs` is for scheduled adapters that have already paid
   * CPU, IO and flush; direct callers retain the default atUs + flush timestamp.
   */
  commit(
    binding: CartCheckoutBinding,
    evidence?: CartCheckoutEvidence | null,
    options: { readonly atUs?: number; readonly deliverReply?: boolean; readonly completedUs?: number } = {},
  ): CartInventoryResult {
    const atUs = options.atUs ?? 0;
    const deliverReply = options.deliverReply ?? true;
    if (!Number.isInteger(atUs) || atUs < 0) {
      throw new RangeError('commit time must be a non-negative integer');
    }

    if (!this.reachable) {
      return this.result('unavailable', {
        replyDelivered: false,
        reason: 'authority-unreachable',
        charge: chargeOf(0, 0),
        transactionSequence: 0,
      });
    }

    if (options.completedUs !== undefined &&
        (!Number.isSafeInteger(options.completedUs) || options.completedUs < atUs)) {
      throw new RangeError('completion must be an integer time at or after transaction start');
    }
    const sequence = ++this.transactionCounter;
    if (!Array.isArray(binding.lines)) {
      return this.result('validation-failed', {
        replyDelivered: deliverReply,
        issues: ['invalid-basket-lines'],
        charge: chargeOf(
          CART_INVENTORY_TRANSACTION_CPU_MS,
          CART_INVENTORY_TRANSACTION_IO_UNITS,
        ),
        transactionSequence: sequence,
      });
    }
    const canonicalLines = canonicalBasketLines(binding.lines);
    const lineCount = canonicalLines.length;
    const transactionCharge = chargeOf(
      CART_INVENTORY_TRANSACTION_CPU_MS +
        CART_INVENTORY_TRANSACTION_PER_LINE_CPU_MS * lineCount,
      CART_INVENTORY_TRANSACTION_IO_UNITS,
    );

    // Ledger recheck inside the transaction: a concurrent lookup miss (or an
    // earlier commit in this same stream) can never mutate the same key twice.
    const existing = this.findRow(binding.orderKey);
    if (existing) {
      const identical =
        existing.cartId === binding.cartId &&
        existing.selectedViewDigest === binding.selectedViewDigest &&
        sameLines(existing.lines, canonicalLines);
      return this.result(identical ? existing.outcome : 'idempotency-conflict', {
        duplicate: identical,
        replyDelivered: deliverReply,
        charge: transactionCharge,
        transactionSequence: sequence,
        durableAtUs: existing.recordedAtUs,
      });
    }

    const bindingIssues = validateCartCheckoutBinding({ ...binding, lines: canonicalLines });
    if (bindingIssues.length > 0) {
      return this.result('validation-failed', {
        replyDelivered: deliverReply,
        issues: bindingIssues,
        charge: transactionCharge,
        transactionSequence: sequence,
      });
    }

    const evidenceCharge = evidence
      ? chargeOf(
          CART_INVENTORY_EVIDENCE_PER_ID_CPU_MS * this.evidenceIdCount(evidence),
          0,
          0,
        )
      : ZERO_CHARGE;
    const charged = addCharge(transactionCharge, evidenceCharge);

    const evidenceIssues = this.validateEvidence(binding, evidence, atUs);
    if (evidenceIssues.length > 0) {
      return this.result('validation-failed', {
        replyDelivered: deliverReply,
        issues: evidenceIssues,
        charge: charged,
        transactionSequence: sequence,
      });
    }

    // A present packet that does not reproduce the bound digest/lines means the
    // client's view changed between read and commit; nothing is recorded.
    const mismatchIssues = this.matchEvidence(binding, canonicalLines, evidence as CartCheckoutEvidence);
    if (mismatchIssues.length > 0) {
      return this.result('selection-changed', {
        replyDelivered: deliverReply,
        issues: mismatchIssues,
        charge: charged,
        transactionSequence: sequence,
      });
    }

    const durableBytes =
      CART_INVENTORY_TERMINAL_RESULT_BYTES + CART_INVENTORY_BASKET_LINE_BYTES * lineCount;
    if (this.usedDurableBytes + durableBytes > this.capacityBytes) {
      return this.result('unavailable', {
        replyDelivered: deliverReply,
        reason: 'ledger-full',
        charge: charged,
        transactionSequence: sequence,
      });
    }

    const stockBefore = this.stockSnapshot();
    const available = canonicalLines.every(
      (line) => (this.stockState[line.sku] ?? 0) >= line.quantity,
    );
    // Scheduled adapters publish only after actual CPU/IO/flush completion.
    const durableAtUs = options.completedUs ?? atUs + CART_DURABLE_FLUSH_US;

    if (!available) {
      // Terminal rejection: the full result record is durable, stock is untouched.
      const row: CartInventoryLedgerRow = {
        orderKey: binding.orderKey,
        cartId: binding.cartId,
        selectedViewDigest: binding.selectedViewDigest,
        lines: canonicalLines,
        outcome: 'out-of-stock',
        recordedAtSequence: ++this.commitCounter,
        recordedAtUs: durableAtUs,
        durableBytes,
      };
      this.ledgerRows.push(row);
      this.usedDurableBytes += durableBytes;
      this.emitCommit(row, stockBefore, stockBefore, sequence);
      return this.result('out-of-stock', {
        replyDelivered: deliverReply,
        charge: charged,
        transactionSequence: sequence,
        durableAtUs,
      });
    }

    const nextStock: Record<string, number> = { ...this.stockState };
    for (const line of canonicalLines) {
      nextStock[line.sku] = (nextStock[line.sku] ?? 0) - line.quantity;
    }
    for (const [sku, remaining] of Object.entries(nextStock)) {
      if (!Number.isInteger(remaining) || remaining < 0) {
        // Defensive: validation makes this unreachable, but an atomic commit
        // must never publish a negative balance.
        throw new Error(`inventory conservation violation for ${sku}`);
      }
    }

    const commitSequence = ++this.commitCounter;
    const row: CartInventoryLedgerRow = {
      orderKey: binding.orderKey,
      cartId: binding.cartId,
      selectedViewDigest: binding.selectedViewDigest,
      lines: canonicalLines,
      outcome: 'committed',
      recordedAtSequence: commitSequence,
      recordedAtUs: durableAtUs,
      durableBytes,
    };

    // Atomic publication: stock, order and ledger row move together, after the
    // durable byte reservation succeeded and before any reply can exist.
    this.stockState = nextStock;
    this.usedDurableBytes += durableBytes;
    this.ledgerRows.push(row);
    this.orderRows.push({
      orderKey: binding.orderKey,
      cartId: binding.cartId,
      selectedViewDigest: binding.selectedViewDigest,
      lines: canonicalLines,
      commitSequence,
      committedAtUs: durableAtUs,
    });
    this.emitCommit(row, stockBefore, nextStock, sequence);

    return this.result('committed', {
      replyDelivered: deliverReply,
      charge: charged,
      transactionSequence: sequence,
      durableAtUs,
    });
  }

  /**
   * Full checkout flow: `Lookup` first; only a miss may consult the supplied
   * complete read. A ledger hit therefore returns the recorded outcome without
   * touching the cart read path, even after later cart edits.
   */
  checkout(
    request: {
      readonly binding: CartCheckoutBinding;
      readonly read?: () => CartCheckoutRead | undefined;
    },
    options: { readonly atUs?: number; readonly deliverReply?: boolean } = {},
  ): CartInventoryResult {
    const lookup = this.lookup(request.binding);
    if (lookup.outcome !== 'lookup-miss') return lookup;

    if (!request.read) {
      return this.result('validation-failed', {
        charge: lookup.charge,
        transactionSequence: lookup.transactionSequence,
        issues: ['missing-checkout-read'],
      });
    }
    const read = request.read();
    if (!read) {
      return this.result('unavailable', {
        charge: lookup.charge,
        transactionSequence: lookup.transactionSequence,
        reason: 'read-unavailable',
      });
    }

    const commit = this.commit(request.binding, createCartCheckoutEvidence(read), options);
    return { ...commit, charge: addCharge(lookup.charge, commit.charge) };
  }

  /**
   * For every SKU: `remainingStock >= 0` and
   * `remainingStock + committedOrderQuantities = initialStock`.
   */
  conservation(): CartInventoryConservation {
    const committed = new Map<string, number>();
    for (const order of this.orderRows) {
      for (const line of order.lines) {
        committed.set(line.sku, (committed.get(line.sku) ?? 0) + line.quantity);
      }
    }

    const violations: string[] = [];
    const skus = new Set([...Object.keys(this.initialStock), ...Object.keys(this.stockState)]);
    for (const sku of [...skus].sort()) {
      const initial = this.initialStock[sku] ?? 0;
      const remaining = this.stockState[sku] ?? 0;
      const ordered = committed.get(sku) ?? 0;
      if (!Number.isInteger(remaining) || remaining < 0) {
        violations.push(`${sku}:negative-stock`);
      }
      if (remaining + ordered !== initial) {
        violations.push(`${sku}:${remaining}+${ordered}!=${initial}`);
      }
    }
    return { conserved: violations.length === 0, violations };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private findRow(orderKey: string): CartInventoryLedgerRow | undefined {
    return this.ledgerRows.find((row) => row.orderKey === orderKey);
  }

  private rowMatches(row: CartInventoryLedgerRow, binding: CartCheckoutBinding): boolean {
    return (
      row.cartId === binding.cartId &&
      row.selectedViewDigest === binding.selectedViewDigest &&
      sameLines(row.lines, canonicalBasketLines(binding.lines))
    );
  }

  private evidenceIdCount(evidence: CartCheckoutEvidence): number {
    return Array.isArray(evidence.coveredIds) ? evidence.coveredIds.length : 0;
  }

  /**
   * Provenance checks: a first purchase can only be authorized by a genuine
   * complete-view packet. Missing or forged provenance is a validation failure,
   * never a durable purchase.
   */
  private validateEvidence(
    binding: CartCheckoutBinding,
    evidence: CartCheckoutEvidence | null | undefined,
    atUs: number,
  ): string[] {
    if (!evidence) return ['missing-read-evidence'];
    if (typeof evidence !== 'object') return ['invalid-read-evidence'];
    const issues: string[] = [];

    if (evidence.cartId !== binding.cartId) issues.push('evidence-cart-mismatch');
    if (
      typeof evidence.readRequestId !== 'string' ||
      !IDENTIFIER_PATTERN.test(evidence.readRequestId)
    ) {
      issues.push('invalid-read-request-id');
    }
    if (!Number.isInteger(evidence.readDeliveryUs) || evidence.readDeliveryUs < 0) {
      issues.push('invalid-read-delivery-time');
    } else if (evidence.readDeliveryUs > atUs) {
      issues.push('evidence-from-future');
    }

    const covered = Array.isArray(evidence.coveredIds) ? evidence.coveredIds : [];
    const coveredSet = new Set<string>();
    for (const id of covered) {
      if (typeof id !== 'string' || !EVIDENCE_ID_PATTERN.test(id)) {
        issues.push('invalid-covered-id');
        continue;
      }
      if (coveredSet.has(id)) issues.push(`duplicate-covered-id:${id}`);
      coveredSet.add(id);
    }

    const certificates: readonly CartCertificate[] = Array.isArray(evidence.certificates)
      ? evidence.certificates
      : [];
    const seenOrigins = new Set<CartRegion>();
    for (const certificate of certificates) {
      if (!certificate || typeof certificate !== 'object') {
        issues.push('invalid-certificate');
        continue;
      }
      if (certificate.cartId !== binding.cartId) issues.push('certificate-cart-mismatch');
      if (!CART_REGIONS.includes(certificate.origin)) {
        issues.push(`unknown-certificate-origin:${String(certificate.origin)}`);
      }
      if (seenOrigins.has(certificate.origin)) {
        issues.push(`duplicate-origin-certificate:${certificate.origin}`);
      }
      seenOrigins.add(certificate.origin);
      // Provenance is object identity, not caller-supplied fields: only the
      // exact configured immutable-write-authority ledger of this origin may
      // have minted the certificate. A plain object naming the right authority
      // — or a certificate from a caller-built ledger with a colliding name —
      // is not issuance and can never authorize stock.
      const authority = this.originAuthorities[certificate.origin];
      if (authority === undefined) {
        issues.push(`unconfigured-origin-authority:${certificate.origin}`);
      } else if (
        !isAuthorityIssuedCertificate(certificate) ||
        certificate.authorityNodeId !== authority.nodeId ||
        !isCertificateIssuedBy(certificate, authority)
      ) {
        issues.push(`untrusted-certificate-authority:${certificate.origin}`);
      }
      if (
        typeof certificate.authorityNodeId !== 'string' ||
        !IDENTIFIER_PATTERN.test(certificate.authorityNodeId)
      ) {
        issues.push('invalid-certificate-authority');
      }
      if (
        !Number.isInteger(certificate.cutUs) ||
        certificate.cutUs < 0 ||
        certificate.cutUs > evidence.readDeliveryUs
      ) {
        issues.push(`invalid-certificate-cut:${certificate.origin}`);
      } else if (
        Number.isInteger(evidence.readDeliveryUs) &&
        certificate.cutUs < evidence.readDeliveryUs - CART_FRESHNESS_BOUND_US
      ) {
        // The read gate is audited at delivery; stale cuts mean this packet
        // never represented a complete fresh view at that moment.
        issues.push(`stale-certificate-cut:${certificate.origin}`);
      }
      if (!Array.isArray(certificate.ids)) {
        issues.push(`invalid-certificate-ids:${certificate.origin}`);
        continue;
      }
      for (const id of certificate.ids) {
        if (!coveredSet.has(id)) issues.push(`certificate-id-not-covered:${id}`);
      }
    }
    for (const origin of CART_REGIONS) {
      if (!seenOrigins.has(origin)) issues.push(`missing-origin-certificate:${origin}`);
    }

    if (!Array.isArray(evidence.displayedLines)) {
      issues.push('invalid-displayed-lines');
    }
    return issues;
  }

  /**
   * Exact binding check: the covered ids must reproduce the bound digest and the
   * displayed lines must equal the bound basket. Any difference is
   * `selection-changed`, with no ledger and no stock effect.
   */
  private matchEvidence(
    binding: CartCheckoutBinding,
    lines: readonly CartBasketLine[],
    evidence: CartCheckoutEvidence,
  ): string[] {
    const issues: string[] = [];
    const digest = cartSelectedViewDigest(binding.cartId, evidence.coveredIds, lines);
    if (digest !== binding.selectedViewDigest) issues.push('selected-view-digest-mismatch');
    if (!sameLines(canonicalBasketLines(evidence.displayedLines), lines)) {
      issues.push('displayed-lines-mismatch');
    }
    return issues;
  }

  private emitCommit(
    row: CartInventoryLedgerRow,
    stockBefore: Readonly<Record<string, number>>,
    stockAfter: Readonly<Record<string, number>>,
    sequence: number,
  ): void {
    this.onCommit?.({
      nodeId: this.nodeId,
      sequence,
      commitSequence: row.recordedAtSequence,
      orderKey: row.orderKey,
      cartId: row.cartId,
      selectedViewDigest: row.selectedViewDigest,
      lines: row.lines.map((line) => ({ ...line })),
      outcome: row.outcome,
      stockBefore,
      stockAfter,
      durableAtUs: row.recordedAtUs,
      durableBytes: row.durableBytes,
      ledgerBytes: this.usedDurableBytes,
    });
  }

  private result(outcome: CartInventoryOutcome, input: ResultInput): CartInventoryResult {
    const replyDelivered = input.replyDelivered ?? true;
    return {
      outcome,
      duplicate: input.duplicate ?? false,
      replyDelivered,
      clientOutcome: replyDelivered ? outcome : 'unknown',
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      issues: input.issues ?? [],
      charge: input.charge,
      transactionSequence: input.transactionSequence,
      durableAtUs: input.durableAtUs ?? null,
      ledgerBytes: this.usedDurableBytes,
      stock: this.stockSnapshot(),
    };
  }
}
