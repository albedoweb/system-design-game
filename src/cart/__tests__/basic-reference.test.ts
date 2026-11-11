import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CART_VERSIONS, cartGraphDigest, evaluateCart, parseCartGraph, type CartEvaluation } from '../index';
import { CART_CASE_OFFERED_COUNTS } from '../core/workload';

/**
 * GC-B02: the single basic reference, required-path-removal controls, an isolated
 * capacity change and reproducibility of the retained raw evidence. Everything goes
 * through the real public `evaluateCart`; thresholds and gates are untouched.
 */
const dir = resolve(__dirname, '../../../tests/fixtures/cart/basic');
const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(dir, path), 'utf8'));
interface Raw { sourceSha: string; label: string; seed: number; inputGraphDigest: string; evaluation: CartEvaluation }
const raw = (label: string, seed: number): Raw => readJson(`raw/${label}-seed${seed}.json`) as Raw;

function reference() {
  const parsed = parseCartGraph(readJson('reference-basic.json'));
  if (!parsed.ok) throw new Error('reference must parse strictly (already basic identity)');
  return parsed.graph;
}

describe('GC-B02 retained raw evidence (public evaluator output, exact source)', () => {
  it('reference passes both basic cases at seeds 1729 and 4242 with finite score <= 6', () => {
    const digest = cartGraphDigest(reference());
    for (const seed of [1729, 4242]) {
      const { evaluation: e, sourceSha } = raw('reference', seed);
      expect(sourceSha).toMatch(/^[0-9a-f]{40}$/);
      expect(e.versions.content).toBe(CART_VERSIONS.content);
      expect(e.versions.profile).toBe('global-cart-v1-basic-desync100');
      expect(e.graphDigest).toBe(digest);
      expect(e.seed).toBe(seed);
      expect(e.requiredCases).toEqual(['normal', 'peak']);
      expect(e.cases.map((c) => c.id)).toEqual(['normal', 'peak']);
      expect(e.complete).toBe(true);
      expect(e.qualified).toBe(true);
      expect(e.issues).toEqual([]);
      expect(Number.isFinite(e.scoreCreditsPerHour)).toBe(true);
      expect(e.scoreCreditsPerHour!).toBeGreaterThan(0);
      expect(e.scoreCreditsPerHour!).toBeLessThanOrEqual(6);
      for (const c of e.cases) {
        expect(c.complete).toBe(true);
        expect(c.scheduled).toBe(CART_CASE_OFFERED_COUNTS[c.id as 'normal' | 'peak']);
        expect(c.issued).toBe(c.scheduled);
        expect(c.gates.length).toBeGreaterThan(0);
        expect(c.gates.filter((g) => !g.pass)).toEqual([]);
        expect(c.cost.windowSeconds).toBe(101);
      }
    }
  });

  it('required-path-removal controls fail on the same version/seed and score null', () => {
    for (const [label, seed, issue] of [
      ['control-no-read-path', 1729, 'read_target_unreachable'],
      ['control-no-read-path', 4242, 'read_target_unreachable'],
      ['control-no-write-path', 1729, 'write_target_unreachable'],
    ] as const) {
      const { evaluation: e } = raw(label, seed);
      const ref = raw('reference', seed).evaluation;
      expect(e.versions).toEqual(ref.versions);
      expect(e.seed).toBe(seed);
      expect(e.graphDigest).not.toBe(ref.graphDigest);
      expect(e.qualified).toBe(false);
      expect(e.scoreCreditsPerHour).toBeNull();
      expect(e.issues.map((i) => i.code)).toContain(issue);
      expect(e.cases.some((c) => c.gates.some((g) => !g.pass))).toBe(true);
    }
  });

  it('isolated capacity change (journals + inventory M->S) shows physical timeouts, not rental only', () => {
    const base = raw('reference', 1729).evaluation.cases.find((c) => c.id === 'peak')!;
    const { evaluation: e } = raw('capacity-S-journals-inventory', 1729);
    const peak = e.cases.find((c) => c.id === 'peak')!;
    const normal = e.cases.find((c) => c.id === 'normal')!;
    expect(e.qualified).toBe(false);
    expect(e.scoreCreditsPerHour).toBeNull();
    expect(normal.gates.every((g) => g.pass)).toBe(true); // Normal still fits; Rush is where capacity bites
    expect(peak.gates.some((g) => !g.pass)).toBe(true);
    expect(base.outcomes.timeout ?? 0).toBe(0);
    expect(peak.outcomes.timeout ?? 0).toBeGreaterThan(0);
    expect(peak.outcomes['dependency-failed'] ?? 0).toBeGreaterThan(0);
    expect(peak.outcomes.committed ?? 0).toBeLessThan(base.outcomes.committed ?? 0);
    expect(peak.cost.rentalPerHour as number).toBeLessThan(base.cost.rentalPerHour as number); // cheaper, yet fails
  });

  it('Inventory-path-removal control (exact diff: edge inventory-us-west) fails on the same version/seed and scores null', () => {
    for (const seed of [1729, 4242]) {
      const { evaluation: e, inputGraphDigest } = raw('control-no-inventory-path', seed);
      const ref = raw('reference', seed).evaluation;
      expect(e.versions).toEqual(ref.versions);
      expect(e.seed).toBe(seed);
      expect(inputGraphDigest).not.toBe(ref.graphDigest);
      expect(e.issues.map((i) => i.code)).toEqual(['inventory_unreachable']);
      expect(e.qualified).toBe(false);
      expect(e.scoreCreditsPerHour).toBeNull();
    }
  });

  it('historical evidence of the pre-fix B01 defect is retained: at 304ba3a the same control qualified with a score', () => {
    const evidence = readJson('ineffective-control-no-inventory-path-evidence.json') as { negativeControlNoInventoryPath: { qualified: boolean; score: number | null; issues: { code: string }[] }[] };
    for (const run of evidence.negativeControlNoInventoryPath) {
      expect(run.issues.map((i) => i.code)).toEqual(['inventory_unreachable']);
      expect(run.qualified).toBe(true); // historical defect, repaired in session.ts by GC-B02
      expect(run.score).not.toBeNull();
    }
  });
});

describe('GC-B02 live reproducibility (real evaluator re-run)', () => {
  it('re-running the reference and the read-path control reproduces the retained trace hashes', () => {
    const ref = reference();
    const e = evaluateCart(ref, { seed: 1729 });
    expect(e.traceHash).toBe(raw('reference', 1729).evaluation.traceHash);
    expect(e.qualified).toBe(true);
    const control = evaluateCart({ ...ref, edges: ref.edges.filter((edge) => edge.id !== 'fanout-us-west-ap-northeast') }, { seed: 1729 });
    expect(control.traceHash).toBe(raw('control-no-read-path', 1729).evaluation.traceHash);
    expect(control.qualified).toBe(false);
    expect(control.scoreCreditsPerHour).toBeNull();
    // Public regression at the exact graph diff: only the Inventory request edge removed.
    const noInventory = evaluateCart({ ...ref, edges: ref.edges.filter((edge) => edge.id !== 'inventory-us-west') }, { seed: 1729 });
    expect(noInventory.issues.map((i) => i.code)).toEqual(['inventory_unreachable']);
    expect(noInventory.qualified).toBe(false);
    expect(noInventory.scoreCreditsPerHour).toBeNull();
    expect(noInventory.traceHash).toBe(raw('control-no-inventory-path', 1729).evaluation.traceHash);
  }, 300_000);
});
