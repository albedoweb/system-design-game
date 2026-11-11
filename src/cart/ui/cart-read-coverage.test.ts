import { describe, expect, it } from 'vitest';

import { cartGraphSchema, type CartGraph, type CartNode } from '../index';
import referenceJson from '../../../tests/fixtures/cart/basic/reference-basic.json';
import {
  cartReadCoverageGaps,
  cartReadCoverageSentence,
  type CartReadCoverageGap,
} from './cart-read-coverage';

const reference: CartGraph = cartGraphSchema.parse(referenceJson);

function withApplications(
  map: (node: CartNode) => CartNode,
): CartGraph {
  return { ...reference, nodes: reference.nodes.map(map) };
}

describe('cartReadCoverageGaps', () => {
  it('reports no gaps when every Application reads all three regional journals', () => {
    expect(cartReadCoverageGaps(reference)).toEqual([]);
  });

  it('reports two missing journals per Application when each reads only its own', () => {
    const graph = withApplications((node) =>
      node.kind === 'application'
        ? { ...node, readTargets: [node.writeTarget] }
        : node,
    );
    const gaps = cartReadCoverageGaps(graph);
    expect(gaps.map((gap) => gap.applicationId)).toEqual([
      'app-us-west',
      'app-eu-central',
      'app-ap-northeast',
    ]);
    for (const gap of gaps) {
      expect(gap.missingIds).toHaveLength(2);
    }
    expect(gaps[0]!.missingIds).toEqual(['journal-eu-central', 'journal-ap-northeast']);
    expect(gaps[0]!.applicationLabel).toBe('Application (US West)');
  });

  it('reports no gaps when all Applications write to and read one shared journal', () => {
    const graph = withApplications((node) =>
      node.kind === 'application'
        ? { ...node, writeTarget: 'journal-us-west', readTargets: ['journal-us-west'] }
        : node,
    );
    expect(cartReadCoverageGaps(graph)).toEqual([]);
  });

  it('ignores an Application with an empty write target as a requirement', () => {
    const graph = withApplications((node) => {
      if (node.kind !== 'application') return node;
      if (node.id === 'app-ap-northeast') {
        return { ...node, writeTarget: '', readTargets: ['journal-us-west', 'journal-eu-central'] };
      }
      return { ...node, readTargets: ['journal-us-west', 'journal-eu-central'] };
    });
    expect(cartReadCoverageGaps(graph)).toEqual([]);
  });

  it('returns no gaps when no Application has a valid write target', () => {
    const graph = withApplications((node) =>
      node.kind === 'application'
        ? { ...node, writeTarget: '', readTargets: [] }
        : node,
    );
    expect(cartReadCoverageGaps(graph)).toEqual([]);
  });
});

describe('cartReadCoverageSentence', () => {
  it('joins two missing storages with and', () => {
    const gap: CartReadCoverageGap = {
      applicationId: 'app-us-west',
      applicationLabel: 'Application (US West)',
      missingIds: ['store-eu-central', 'store-ap-northeast'],
      missingLabels: ['Cart store · EU Central', 'Cart store · AP Northeast'],
    };
    expect(cartReadCoverageSentence(gap)).toBe(
      'Application (US West) does not read Cart store · EU Central and Cart store · AP Northeast.',
    );
  });

  it('joins three or more with commas and a final and', () => {
    const gap: CartReadCoverageGap = {
      applicationId: 'app-x',
      applicationLabel: 'Application (EU Central)',
      missingIds: ['a', 'b', 'c'],
      missingLabels: ['A · US West', 'B · EU Central', 'C · AP Northeast'],
    };
    expect(cartReadCoverageSentence(gap)).toBe(
      'Application (EU Central) does not read A · US West, B · EU Central and C · AP Northeast.',
    );
  });
});
