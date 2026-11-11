import { describe, expect, it } from 'vitest';
import {
  CART_CONTENT_VERSIONS,
  CART_VERSIONS,
  CART_WORKLOAD_PROFILE_IDS,
  cartVersionsSchema,
  cartContentVersionForProfile,
} from '../contracts';
import { cartGraphDigest, createCartStarterGraph, parseCartGraph, parseCartGraphJson } from '../graph';
import { evaluateCart } from '../session';
import { CART_WORKLOAD_PROFILE_DESYNC100 } from '../core/workload';
import { parseCartState, serializeCartState } from '../ui/cart-persistence';
import pv1Json from './fixtures/pv1-candidate-graph.json';

const pv1: unknown = pv1Json;

describe('GC-B01 basic content identity and historical import', () => {
  it('basic default has its own content version; advanced keeps cart-content-v1', () => {
    expect(CART_VERSIONS.content).toBe('cart-content-v2-basic');
    expect(CART_VERSIONS.profile).toBe(CART_WORKLOAD_PROFILE_IDS.basic);
    expect(cartContentVersionForProfile(CART_WORKLOAD_PROFILE_IDS.basic)).toBe(CART_CONTENT_VERSIONS.basic);
    expect(cartContentVersionForProfile(CART_WORKLOAD_PROFILE_IDS.desync100)).toBe('cart-content-v1');
    expect(cartContentVersionForProfile(CART_WORKLOAD_PROFILE_IDS.original)).toBe('cart-content-v1');
  });

  it('starter graph and saved envelope carry the basic content version', () => {
    expect(createCartStarterGraph().contentVersion).toBe('cart-content-v2-basic');
    const saved = JSON.parse(serializeCartState(createCartStarterGraph())) as { contentVersion: string };
    expect(saved.contentVersion).toBe('cart-content-v2-basic');
  });

  it('semantic digest binds content/profile identity', () => {
    const v2 = createCartStarterGraph();
    const v1 = { ...v2, contentVersion: CART_CONTENT_VERSIONS.advanced };
    expect(cartGraphDigest(v1)).not.toBe(cartGraphDigest(v2));
  });

  it('historical v1 import is an explicit atomic restamp reporting migratedFrom', () => {
    const parsed = parseCartState(JSON.stringify(pv1));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.graph.contentVersion).toBe('cart-content-v2-basic');
    expect(parsed.migratedFrom).toBe('cart-content-v1');
    // a current-content document is not reported as migrated
    const current = parseCartState(serializeCartState(createCartStarterGraph()));
    expect(current.ok && current.migratedFrom).toBeFalsy();
  });

  it('strict parse without a target keeps the stamped identity; unknown content is rejected atomically', () => {
    const strict = parseCartGraph(pv1);
    expect(strict.ok && strict.graph.contentVersion).toBe('cart-content-v1');
    const bad = { ...(pv1 as object), contentVersion: 'cart-content-v9' };
    expect(parseCartGraph(bad, CART_VERSIONS.content).ok).toBe(false);
    expect(parseCartGraphJson(JSON.stringify(bad), CART_VERSIONS.content).ok).toBe(false);
    // a structurally broken historical document is rejected whole, never partially restamped
    const broken = { ...(pv1 as object), seed: -1 };
    expect(parseCartGraph(broken, CART_VERSIONS.content).ok).toBe(false);
  });

  it('result versions pair content with the run profile', () => {
    const base = { ...CART_VERSIONS };
    expect(cartVersionsSchema.safeParse(base).success).toBe(true);
    expect(
      cartVersionsSchema.safeParse({
        ...base,
        content: 'cart-content-v1',
        profile: CART_WORKLOAD_PROFILE_IDS.desync100,
      }).success,
    ).toBe(true);
    expect(cartVersionsSchema.safeParse({ ...base, content: 'cart-content-v1' }).success).toBe(false);
    expect(
      cartVersionsSchema.safeParse({ ...base, profile: CART_WORKLOAD_PROFILE_IDS.desync100 }).success,
    ).toBe(false);
  });

  it('explicit advanced run reports advanced content identity; default reports basic', () => {
    const advanced = evaluateCart(pv1, { seed: 1729, workloadProfile: CART_WORKLOAD_PROFILE_DESYNC100 });
    expect(advanced.versions.content).toBe('cart-content-v1');
    expect(advanced.versions.profile).toBe(CART_WORKLOAD_PROFILE_IDS.desync100);
    expect(advanced.requiredCases).toHaveLength(6);
    const basic = evaluateCart(pv1, { seed: 1729 });
    expect(basic.versions.content).toBe('cart-content-v2-basic');
    expect(basic.versions.profile).toBe(CART_WORKLOAD_PROFILE_IDS.basic);
    expect(basic.requiredCases).toEqual(['normal', 'peak']);
  // About 113 s alone; allow headroom for a loaded CI runner.
  }, 300_000);
});
