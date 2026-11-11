import { describe, expect, it } from 'vitest';

import referenceBasic from '../../../tests/fixtures/cart/basic/reference-basic.json';
import { cartEvaluationSchema, evaluateCart } from '../index';

describe('run observation load counters', () => {
  it('keeps a real evaluation inside the public result schema and reports node and circuit load', () => {
    const evaluation = evaluateCart(referenceBasic, { seed: 1729 });
    // The UI and the Worker reject any result that fails this schema, so an
    // oversized or misshapen observation would make every run unreadable.
    const parsed = cartEvaluationSchema.safeParse(evaluation);
    expect(parsed.success ? [] : parsed.error.issues.slice(0, 3)).toEqual([]);
    expect(evaluation.qualified).toBe(true);

    for (const caseResult of evaluation.cases) {
      const observation = caseResult.observation;
      expect(observation).toBeDefined();
      const links = observation?.links ?? [];
      expect(links.length).toBeGreaterThan(0);
      expect(links.length).toBeLessThanOrEqual(200);
      expect(new Set(links.map((link) => link.kind))).toEqual(new Set(['nic', 'wan']));
      // Three purchased circuits, one queue per direction.
      expect(links.filter((link) => link.kind === 'wan')).toHaveLength(6);
      for (const link of links) {
        expect(link.jobs).toBeGreaterThan(0);
        expect(link.waitMaxMs).toBeGreaterThanOrEqual(link.waitAvgMs);
      }
      for (const node of observation?.nodes ?? []) {
        expect(node.load).toBeDefined();
        expect(node.load?.cpuTasks).toBeGreaterThan(0);
        expect(node.load?.cpuWaitMaxMs).toBeGreaterThanOrEqual(node.load?.cpuWaitAvgMs ?? 0);
      }
    }
  }, 180_000);
});
