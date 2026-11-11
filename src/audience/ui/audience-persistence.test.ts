import { describe, expect, it } from 'vitest';

import {
  AUDIENCE_CONTENT_VERSION,
  AUDIENCE_LEVEL_ID,
  parseAudienceGraph,
  type AudienceGraph,
} from '../index';
import projectionFixture from '../../../fixtures/audience/family-projection.json';
import {
  parseAudienceState,
  serializeAudienceState,
} from './audience-persistence';

function graph(): AudienceGraph {
  const parsed = parseAudienceGraph(projectionFixture);
  if (!parsed.ok) {
    throw new Error(parsed.issues[0]?.message ?? 'fixture did not parse');
  }
  return parsed.value;
}

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: 'sdg-level-state',
    stateVersion: 1,
    levelId: AUDIENCE_LEVEL_ID,
    contentVersion: AUDIENCE_CONTENT_VERSION,
    savedAt: '2026-11-01T00:00:00.000Z',
    seed: 307,
    graph: graph(),
    ...overrides,
  });
}

describe('Live Audience explicit file state', () => {
  it('exports a versioned envelope with the graph, positions and seed', () => {
    const text = serializeAudienceState(graph(), 307);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.kind).toBe('sdg-level-state');
    expect(parsed.stateVersion).toBe(1);
    expect(parsed.levelId).toBe('live-audience');
    expect(parsed.contentVersion).toBe('1.0.0');
    expect(parsed.seed).toBe(307);
    expect(parsed.savedAt).toEqual(expect.any(String));
    expect(parsed.graph).toEqual(graph());
  });

  it('round-trips an envelope and accepts a bare graph with no seed', () => {
    const opened = parseAudienceState(envelope());
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.seed).toBe(307);
      expect(opened.format).toBe('state');
      expect(opened.graph).toEqual(graph());
    }

    const bare = parseAudienceState(JSON.stringify(graph()));
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.seed).toBeNull();
      expect(bare.format).toBe('graph');
    }
  });

  it('rejects a document from another level without returning a graph', () => {
    const opened = parseAudienceState(
      envelope({ levelId: 'live-scoreboard' }),
    );
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.message).toMatch(/another level or version/);
    }
    const badVersion = parseAudienceState(
      envelope({ contentVersion: '2.0.0' }),
    );
    expect(badVersion.ok).toBe(false);
  });

  it('rejects malformed, oversized and unsupported-version input', () => {
    expect(parseAudienceState('{').ok).toBe(false);
    expect(parseAudienceState(envelope(), 1024 * 1024 + 1).ok).toBe(false);
    expect(parseAudienceState(envelope({ stateVersion: 2 })).ok).toBe(false);
    expect(parseAudienceState(envelope({ seed: -1 })).ok).toBe(false);
    expect(
      parseAudienceState(
        envelope({
          graph: {
            schemaVersion: 1,
            levelId: 'live-scoreboard',
            nodes: [],
            edges: [],
          },
        }),
      ).ok,
    ).toBe(false);
  });
});
