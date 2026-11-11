import { CART_LIMITS, CART_VERSIONS, parseCartGraph, type CartGraph, type CartParseResult } from '../index';

/**
 * The cart graph is its versioned design file: seed and layout, never run state.
 *
 * Two different contracts share one document shape:
 *  - the editable draft (this module) may leave an Application's durable write
 *    authority or its configured read targets blank while the player builds;
 *  - the runnable engine graph (cart-protocol-v1) requires both, and the engine
 *    gates are never weakened for export or import.
 *
 * Only those two editable slots are relaxed. Versions, ids, limits, unknown
 * fields and every other rule stay strict, so a malformed, oversized or
 * unknown-version document is still rejected whole.
 */

const DRAFT_WRITE_SENTINEL = 'draft.unset.write';
const DRAFT_READ_SENTINEL = 'draft.unset.read';

function withDraftTargetPlaceholders(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.nodes)) return value;
  const nodes = record.nodes.map((node) => {
    if (typeof node !== 'object' || node === null) return node;
    const entry = node as Record<string, unknown>;
    if (entry.kind !== 'application') return entry;
    return {
      ...entry,
      writeTarget: entry.writeTarget === '' ? DRAFT_WRITE_SENTINEL : entry.writeTarget,
      readTargets:
        Array.isArray(entry.readTargets) && entry.readTargets.length === 0
          ? [DRAFT_READ_SENTINEL]
          : entry.readTargets,
    };
  });
  return { ...record, nodes };
}

function restoreDraftTargets(graph: CartGraph): CartGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.kind !== 'application'
        ? node
        : {
            ...node,
            writeTarget:
              node.writeTarget === DRAFT_WRITE_SENTINEL ? '' : node.writeTarget,
            readTargets:
              node.readTargets.length === 1 && node.readTargets[0] === DRAFT_READ_SENTINEL
                ? []
                : node.readTargets,
          },
    ),
  };
}

/** Validate an in-memory editable draft without touching any document. */
export function parseDraftCartGraph(graph: CartGraph): CartParseResult {
  const parsed = parseCartGraph(withDraftTargetPlaceholders(graph), CART_VERSIONS.content);
  if (!parsed.ok) return parsed;
  return { ok: true, graph: restoreDraftTargets(parsed.graph), ...(parsed.migratedFrom === undefined ? {} : { migratedFrom: parsed.migratedFrom }) };
}

/** The cart graph is its versioned design file: seed and layout, never run state. */
export function serializeCartState(graph: CartGraph): string {
  const parsed = parseDraftCartGraph(graph);
  if (!parsed.ok) throw new Error('The Global Cart design is not valid.');
  return JSON.stringify(graph, null, 2);
}

/** Validate the whole document before callers touch the current design. */
export function parseCartState(text: string): CartParseResult {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > CART_LIMITS.maxDocumentBytes) {
    return {
      ok: false,
      issues: [
        {
          code: 'input_too_large',
          message: `The document is ${bytes} bytes; the limit is ${CART_LIMITS.maxDocumentBytes} bytes.`,
        },
      ],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      issues: [{ code: 'invalid_json', message: 'The document is not valid JSON.' }],
    };
  }
  return parseDraftCartGraph(value as CartGraph);
}

export function downloadCartState(graph: CartGraph): void {
  const url = URL.createObjectURL(new Blob([serializeCartState(graph)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'global-cart.json';
  anchor.click();
  URL.revokeObjectURL(url);
}
