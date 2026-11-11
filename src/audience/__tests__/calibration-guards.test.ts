import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAX_RSS_TARGET_MIB,
  NODE_MAX_OLD_SPACE_MB,
  NODE_SEMI_SPACE_MB,
  childExecutionError,
  childRunGuard,
  isOutsideRepositoryRoot,
  outputPathExists,
  validateChildRunIdentity,
  type ExpectedChildIdentity,
} from '../../../scripts/audience-calibrate';

/**
 * Narrow harness guard test. The raw object below is a synthetic guard fixture,
 * not an engine result and not model qualification evidence.
 */

const expected: ExpectedChildIdentity = {
  family: 'fail-single-app',
  fixtureRelative: 'fixtures/audience/fail-single-app.json',
  seed: 101,
  gitSha: 'abc123',
  runNonce: 'nonce-current',
};

function rawOutput(overrides: Record<string, unknown> = {}) {
  const { metadata: metadataOverrides, ...rest } = overrides;
  return {
    kind: 'audience-calibration-raw',
    metadata: {
      family: 'fail-single-app',
      fixture: 'fixtures/audience/fail-single-app.json',
      seed: 101,
      gitSha: 'abc123',
      runNonce: 'nonce-current',
      ...((metadataOverrides as Record<string, unknown> | undefined) ?? {}),
    },
    parse: { ok: true, issues: [] },
    error: null,
    summary: null,
    evaluation: null,
    ...rest,
  };
}

describe('calibration child resource budget', () => {
  it('keeps the strict calibration heap settings and separate RSS guard', () => {
    expect(NODE_MAX_OLD_SPACE_MB).toBe(192);
    expect(NODE_SEMI_SPACE_MB).toBe(8);
    expect(MAX_RSS_TARGET_MIB).toBe(512);
    expect(NODE_MAX_OLD_SPACE_MB).toBeLessThan(MAX_RSS_TARGET_MIB);
    expect(NODE_SEMI_SPACE_MB * 2).toBeLessThan(NODE_MAX_OLD_SPACE_MB);
  });
});

describe('calibration child guards', () => {
  it('requires a clean child exit regardless of raw availability', () => {
    expect(
      childExecutionError({
        status: 0,
        signal: null,
        spawnError: null,
        timedOut: false,
      }),
    ).toBeNull();
    expect(
      childExecutionError({
        status: 1,
        signal: null,
        spawnError: null,
        timedOut: false,
      }),
    ).toMatch(/status 1/);
    expect(
      childExecutionError({
        status: null,
        signal: 'SIGKILL',
        spawnError: null,
        timedOut: false,
      }),
    ).toMatch(/SIGKILL/);
    expect(
      childExecutionError({
        status: null,
        signal: null,
        spawnError: 'ENOENT: missing loader',
        timedOut: false,
      }),
    ).toMatch(/spawn\/execution/);
    expect(
      childExecutionError({
        status: null,
        signal: null,
        spawnError: null,
        timedOut: true,
      }),
    ).toMatch(/wall-clock/);
  });

  it('accepts only raw metadata belonging to the same invocation', () => {
    expect(validateChildRunIdentity(rawOutput(), expected)).toBeNull();
    for (const mismatch of [
      { metadata: { family: 'family-projection' } },
      { metadata: { fixture: 'fixtures/audience/family-projection.json' } },
      { metadata: { seed: 211 } },
      { metadata: { gitSha: 'deadbeef' } },
      { metadata: { runNonce: 'nonce-stale' } },
      { kind: 'some-other-file' },
    ]) {
      expect(
        validateChildRunIdentity(rawOutput(mismatch), expected),
        JSON.stringify(mismatch),
      ).not.toBeNull();
    }
  });

  it('never lets a failed child reuse a matching raw file', () => {
    const raw = rawOutput();
    expect(
      childRunGuard({
        execution: {
          status: 1,
          signal: null,
          spawnError: null,
          timedOut: false,
        },
        raw,
        expected,
      }),
    ).toMatch(/status 1/);
    expect(
      childRunGuard({
        execution: {
          status: 0,
          signal: 'SIGKILL',
          spawnError: null,
          timedOut: false,
        },
        raw,
        expected,
      }),
    ).toMatch(/SIGKILL/);
    expect(
      childRunGuard({
        execution: {
          status: 0,
          signal: null,
          spawnError: null,
          timedOut: false,
        },
        raw: null,
        expected,
      }),
    ).toMatch(/no readable raw/);
    expect(
      childRunGuard({
        execution: {
          status: 0,
          signal: null,
          spawnError: null,
          timedOut: false,
        },
        raw: rawOutput({ metadata: { runNonce: 'nonce-stale' } }),
        expected,
      }),
    ).toMatch(/runNonce/);
    expect(
      childRunGuard({
        execution: {
          status: 0,
          signal: null,
          spawnError: null,
          timedOut: false,
        },
        raw,
        expected,
      }),
    ).toBeNull();
  });
});

describe('fresh calibration output directory policy', () => {
  it('refuses existing directories, files and symlinks including dangling links', () => {
    const root = mkdtempSync(join(tmpdir(), 'a102-calibration-fresh-'));
    try {
      const dir = join(root, 'existing-dir');
      const file = join(root, 'existing-file');
      const link = join(root, 'existing-link');
      const dangling = join(root, 'dangling-link');
      mkdirSync(dir);
      writeFileSync(file, 'keep');
      symlinkSync(dir, link);
      symlinkSync(join(root, 'missing-target'), dangling);

      expect(outputPathExists(join(root, 'brand-new'))).toBe(false);
      expect(outputPathExists(dir)).toBe(true);
      expect(outputPathExists(file)).toBe(true);
      expect(outputPathExists(link)).toBe(true);
      expect(outputPathExists(dangling)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('calibration output directory guard', () => {
  it('uses exact real-path parent checks and rejects dot-prefixed names', () => {
    const root = mkdtempSync(join(tmpdir(), 'a102-calibration-guard-'));
    try {
      const repo = join(root, 'repo');
      const inside = join(repo, 'artifacts');
      const dotPrefix = join(repo, '..cache');
      const outside = join(root, 'outside');
      mkdirSync(inside, { recursive: true });
      mkdirSync(dotPrefix, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(root, 'link-out'));
      symlinkSync(inside, join(root, 'link-in'));
      symlinkSync(repo, join(root, 'link-repo'));

      expect(isOutsideRepositoryRoot(repo, inside)).toBe(false);
      expect(isOutsideRepositoryRoot(repo, dotPrefix)).toBe(false);
      expect(isOutsideRepositoryRoot(repo, repo)).toBe(false);
      expect(isOutsideRepositoryRoot(repo, outside)).toBe(true);
      expect(isOutsideRepositoryRoot(repo, join(root, 'link-out'))).toBe(true);
      expect(isOutsideRepositoryRoot(repo, join(root, 'link-in'))).toBe(false);
      expect(isOutsideRepositoryRoot(repo, join(root, 'link-repo'))).toBe(false);
      // Non-existing tails follow their nearest existing (symlinked) parent.
      expect(
        isOutsideRepositoryRoot(repo, join(root, 'link-out', 'new', 'nested')),
      ).toBe(true);
      expect(
        isOutsideRepositoryRoot(repo, join(root, 'link-in', 'new', 'nested')),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
