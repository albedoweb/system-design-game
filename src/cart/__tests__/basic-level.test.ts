import { describe, expect, it } from 'vitest';
import {
  CART_ADVANCED_REQUIRED_CASES,
  CART_REQUIRED_CASES,
  CART_VERSIONS,
  CART_WORKLOAD_PROFILE_IDS,
  describeCartLevel,
} from '../index';
import { createCartStarterGraph } from '../graph';
import { evaluateCart } from '../session';
import { buildCartProbes } from '../core/challenges';
import {
  CART_CASE_OFFERED_COUNTS,
  CART_DEFAULT_WORKLOAD_PROFILE,
  CART_WORKLOAD_PROFILE_BASIC,
  CART_WORKLOAD_PROFILE_DESYNC100,
  buildCartCaseWorkload,
  buildCartWorkload,
} from '../core/workload';

describe('GC-B01 basic Cart Foundations level', () => {
  it('defaults to exactly Normal and Rush with the basic profile everywhere', () => {
    expect(CART_REQUIRED_CASES).toEqual(['normal', 'peak']);
    expect(CART_DEFAULT_WORKLOAD_PROFILE).toBe(CART_WORKLOAD_PROFILE_BASIC);
    expect(CART_VERSIONS.profile).toBe(CART_WORKLOAD_PROFILE_IDS.basic);
    expect(CART_WORKLOAD_PROFILE_BASIC.faultFree).toBe(true);
    expect(CART_WORKLOAD_PROFILE_BASIC.sessionOffsetMs).toBe(100);
    expect(CART_WORKLOAD_PROFILE_BASIC.measuredUs).toBe(101_000_000);
    const discovery = describeCartLevel();
    expect(discovery.requiredCases).toEqual(['normal', 'peak']);
    expect(discovery.versions.profile).toBe(CART_WORKLOAD_PROFILE_IDS.basic);
  });

  it('keeps complete scheduled counts and identical offered traffic as the advanced profile', () => {
    const basic = buildCartWorkload(1729);
    expect(Object.keys(basic.cases)).toEqual(['normal', 'peak']);
    expect(basic.cases.normal.scheduled).toBe(CART_CASE_OFFERED_COUNTS.normal);
    expect(basic.cases.peak.scheduled).toBe(CART_CASE_OFFERED_COUNTS.peak);
    const advanced = buildCartCaseWorkload('peak', 1729, CART_WORKLOAD_PROFILE_DESYNC100);
    expect(basic.cases.peak.traceHash).toBe(advanced.traceHash);
    expect(() => buildCartCaseWorkload('partition', 1729)).toThrow(/not part of profile/);
  });

  it('withholds score for an unqualified graph and reports only the two basic cases', () => {
    const evaluation = evaluateCart(createCartStarterGraph(), { seed: 1729 });
    expect(evaluation.requiredCases).toEqual(['normal', 'peak']);
    expect(evaluation.cases.map((entry) => entry.id)).toEqual(['normal', 'peak']);
    // No advanced probes are scheduled in the basic scenarios.
    expect(evaluation.cases[0]?.scheduled).toBe(CART_CASE_OFFERED_COUNTS.normal);
    expect(evaluation.cases[1]?.scheduled).toBe(CART_CASE_OFFERED_COUNTS.peak);
    expect(evaluation.versions.profile).toBe(CART_WORKLOAD_PROFILE_IDS.basic);
    expect(evaluation.complete).toBe(false);
    expect(evaluation.qualified).toBe(false);
    expect(evaluation.scoreCreditsPerHour).toBeNull();
  });

  it('retains the original six-case advanced benchmark with incidents and probes', () => {
    expect(CART_ADVANCED_REQUIRED_CASES).toHaveLength(6);
    expect(CART_WORKLOAD_PROFILE_DESYNC100.cases).toEqual([...CART_ADVANCED_REQUIRED_CASES]);
    expect(CART_WORKLOAD_PROFILE_DESYNC100.faultFree).toBe(false);
    const advanced = buildCartCaseWorkload('partition', 1729, CART_WORKLOAD_PROFILE_DESYNC100);
    expect(advanced.scheduled).toBe(CART_CASE_OFFERED_COUNTS.partition);
    expect(buildCartProbes().probes.some((probe) => probe.caseId === 'partition')).toBe(true);
  });
});
