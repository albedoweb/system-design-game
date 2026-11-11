/**
 * GC-011R2 boundary check: the public cart API must be the executed driver.
 *
 * These tests import only from `../index` — the frozen browser/worker/agent
 * boundary — so a missing or stubbed re-export fails here even if `./session`
 * itself works in isolation.
 */
import { describe, expect, it } from 'vitest';
import {
  CART_LEVEL_ID,
  CART_REQUIRED_CASES,
  CART_VERSIONS,
  createCartSession,
  createCartStarterGraph,
  evaluateCart,
} from '../index';

describe('public cart API boundary', () => {
  it('runs the real evaluateCart imported from index.ts', () => {
    const evaluation = evaluateCart(createCartStarterGraph(), {
      seed: 1729,
      measuredUs: 6_000_000,
      drainUs: 0,
    });
    expect(evaluation.levelId).toBe(CART_LEVEL_ID);
    expect(evaluation.versions).toEqual(CART_VERSIONS);
    expect(evaluation.requiredCases).toEqual([...CART_REQUIRED_CASES]);
    expect(evaluation.cases).toHaveLength(CART_REQUIRED_CASES.length);
    // The source-only starter can never qualify or score; a successful stub
    // returning a score here would be a silently unimplemented level.
    expect(evaluation.complete).toBe(false);
    expect(evaluation.qualified).toBe(false);
    expect(evaluation.scoreCreditsPerHour).toBeNull();
    expect(evaluation.traceHash).toMatch(/^[0-9a-f]{64}$/);
    // Real work actually ran: offers were issued and events consumed.
    const issued = evaluation.cases.reduce((total, entry) => total + entry.issued, 0);
    const events = evaluation.cases.reduce((total, entry) => total + (entry.resources?.events ?? 0), 0);
    expect(issued).toBeGreaterThan(0);
    expect(events).toBeGreaterThan(0);
  });

  it('runs the real createCartSession imported from index.ts to a result', () => {
    const session = createCartSession(createCartStarterGraph(), {
      seed: 1729,
      measuredUs: 4_000_000,
      drainUs: 0,
    });
    let guard = 0;
    for (;;) {
      const step = session.advance(5_000);
      guard += 1;
      if (step.done) break;
      if (guard > 1_000) throw new Error('session did not terminate');
    }
    const result = session.result();
    expect(result).not.toBeNull();
    expect(result?.cases).toHaveLength(CART_REQUIRED_CASES.length);
    expect(result?.complete).toBe(false);
    expect(result?.scoreCreditsPerHour).toBeNull();
  });
});
