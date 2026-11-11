import { CART_NODE_KINDS, CART_REGIONS, type CartGraph, type CartIssue, type CartNode } from '../index';

import { CART_KIND_UI, cartNodeDisplayName, cartRegionShort } from './cart-meta';

/** Region ids as the engine writes them into messages, e.g. "us-west". */
const REGION_ID_PATTERN = CART_REGIONS.join('|');
const BARE_REGION_PAIR = new RegExp(
  `\\b(${REGION_ID_PATTERN})\\b(?:\\s*\\/\\s*(${REGION_ID_PATTERN})\\b)?`,
  'g',
);

function componentName(node: CartNode): string {
  return `${cartNodeDisplayName(node)} (${cartRegionShort(node.region)})`;
}

/**
 * Player-facing text for a validation issue. The engine message may quote raw
 * node, path or region ids; this replaces them with the names the player sees.
 */
export function cartIssueText(graph: CartGraph, issue: CartIssue): string {
  const nodeById = (id: string | undefined) =>
    id ? graph.nodes.find((node) => node.id === id) : undefined;
  const edge = issue.edgeId
    ? graph.edges.find((item) => item.id === issue.edgeId)
    : undefined;

  if (issue.code === 'write_target_missing') {
    const application = nodeById(issue.nodeId);
    if (application && application.kind === 'application' && application.writeTarget === '') {
      return `${componentName(application)} has no write target yet. Choose a journal or cart store in its Properties.`;
    }
  }

  if (issue.code === 'self_edge' && edge) {
    const from = nodeById(edge.from);
    if (from) {
      return `A path cannot connect ${componentName(from)} to itself.`;
    }
  }

  const resolveQuoted = (id: string): string => {
    const node = nodeById(id);
    if (node) return componentName(node);
    const path = graph.edges.find((item) => item.id === id);
    if (path) {
      const from = nodeById(path.from);
      const to = nodeById(path.to);
      if (from && to) return `${componentName(from)} → ${componentName(to)}`;
      return 'a path';
    }
    const kind = CART_NODE_KINDS.find((item) => item === id);
    if (kind) return CART_KIND_UI[kind].label;
    return 'a missing component';
  };

  let text = issue.message
    .replace(/the missing node "[^"]*"/g, 'a component that is missing')
    .replace(/"([^"]*)"/g, (_match, id: string) => resolveQuoted(id))
    .replace(BARE_REGION_PAIR, (_match, first: string, second?: string) => {
      const firstLabel = cartRegionShort(first as (typeof CART_REGIONS)[number]);
      if (!second) return firstLabel;
      return `${firstLabel} ↔ ${cartRegionShort(second as (typeof CART_REGIONS)[number])}`;
    })
    .replace(/\bEdge\b/g, 'Path')
    .replace(/\bedge\b/g, 'path');

  text = text.replace(/\bnodes\b/g, 'components').replace(/\bnode\b/g, 'component');
  return text;
}
