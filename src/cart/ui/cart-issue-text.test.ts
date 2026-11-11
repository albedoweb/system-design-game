import { describe, expect, it } from 'vitest';

import type { CartGraph, CartIssue } from '../index';

import { cartIssueText } from './cart-issue-text';

const graph = {
  nodes: [
    { id: 'app-us-west', kind: 'application', region: 'us-west', writeTarget: '' },
    {
      id: 'journal-eu-central',
      kind: 'journal',
      region: 'eu-central',
      label: undefined,
    },
    { id: 'app-eu-central', kind: 'application', region: 'eu-central', writeTarget: 'journal-eu-central' },
  ],
  edges: [
    {
      id: 'fanout-us-west-eu-central',
      kind: 'replication',
      from: 'app-us-west',
      to: 'journal-eu-central',
    },
  ],
  circuits: [],
} as unknown as CartGraph;

describe('cartIssueText', () => {
  it('replaces quoted path and region ids with player names', () => {
    const issue: CartIssue = {
      code: 'missing_circuit',
      message:
        'Cross-region edge "fanout-us-west-eu-central" needs a purchased us-west / eu-central circuit.',
      edgeId: 'fanout-us-west-eu-central',
    };
    expect(cartIssueText(graph, issue)).toBe(
      'Cross-region path Application (US West) → Durable journal (EU Central) needs a purchased US West ↔ EU Central circuit.',
    );
  });

  it('explains a missing write target in plain words', () => {
    const issue: CartIssue = {
      code: 'write_target_missing',
      message: 'Application "app-us-west" names the missing write target "".',
      nodeId: 'app-us-west',
    };
    expect(cartIssueText(graph, issue)).toBe(
      'Application (US West) has no write target yet. Choose a journal or cart store in its Properties.',
    );
  });

  it('leaves a message without ids unchanged', () => {
    const issue: CartIssue = {
      code: 'request_edge_endpoints',
      message: 'Inventory answers transactions; it cannot be a request source.',
    };
    expect(cartIssueText(graph, issue)).toBe(issue.message);
  });
});
