import { describe, expect, it } from 'vitest';

import { createParcelGraph } from '../graph';
import {
  PARCEL_DRAFT_KEY,
  PARCEL_MAX_IMPORT_BYTES,
  clearParcelDraft,
  parseParcelImport,
  parseParcelState,
  readParcelDraft,
  serializeParcelGraph,
  serializeParcelState,
  writeParcelDraft,
} from './parcel-persistence';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe('Parcel draft persistence and import', () => {
  it('round-trips a strict graph and reports a corrupt draft without overwriting it', () => {
    const storage = new MemoryStorage();
    const graph = createParcelGraph();
    expect(writeParcelDraft(storage, graph).ok).toBe(true);

    const restored = readParcelDraft(storage);
    expect(restored.kind).toBe('ok');
    if (restored.kind === 'ok') {
      expect(restored.graph.nodes.map((node) => node.id)).toEqual(
        graph.nodes.map((node) => node.id),
      );
    }

    const raw = '{"storeVersion":1,"graph":{"broken":true}}';
    storage.setItem(PARCEL_DRAFT_KEY, raw);
    const corrupt = readParcelDraft(storage);
    expect(corrupt.kind).toBe('corrupt');
    if (corrupt.kind === 'corrupt') {
      expect(corrupt.raw).toBe(raw);
    }
    expect(storage.getItem(PARCEL_DRAFT_KEY)).toBe(raw);
  });

  it('rejects a draft from another content version', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      PARCEL_DRAFT_KEY,
      JSON.stringify({
        storeVersion: 1,
        levelId: 'parcel-pulse',
        contentVersion: 'old',
        savedAt: new Date(0).toISOString(),
        graph: createParcelGraph(),
      }),
    );
    expect(readParcelDraft(storage).kind).toBe('corrupt');
  });

  it('accepts a shape-valid but incomplete graph so it can be fixed', () => {
    const incomplete = {
      schemaVersion: 1,
      levelId: 'parcel-pulse',
      nodes: [
        {
          id: 'client-1',
          kind: 'client',
          label: 'Client',
          position: { x: 0, y: 0 },
          config: { size: 'small' },
        },
      ],
      edges: [],
    };
    const result = parseParcelImport(JSON.stringify(incomplete));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.nodes).toHaveLength(1);
      expect(serializeParcelGraph(result.graph)).toContain('"schemaVersion": 1');
    }
  });

  it('rejects malformed, oversized and level-overriding documents', () => {
    expect(parseParcelImport('{ not json').ok).toBe(false);

    const oversized = parseParcelImport(
      '{}',
      PARCEL_MAX_IMPORT_BYTES + 1,
    );
    expect(oversized.ok).toBe(false);

    const wrongLevel = JSON.parse(
      JSON.stringify({ ...createParcelGraph(), levelId: 'cold-cache' }),
    ) as unknown;
    const result = parseParcelImport(JSON.stringify(wrongLevel));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe('level_override_rejected');
    }
  });

  it('handles blocked storage and clears the draft', () => {
    const storage = new MemoryStorage();
    expect(writeParcelDraft(storage, createParcelGraph()).ok).toBe(true);
    expect(clearParcelDraft(storage).ok).toBe(true);
    expect(readParcelDraft(storage).kind).toBe('empty');
    expect(writeParcelDraft(null, createParcelGraph()).ok).toBe(false);
    expect(clearParcelDraft(null).ok).toBe(false);
  });

  it('saves and opens the Parcel graph with its seed, and accepts a bare graph', () => {
    const base = createParcelGraph();
    const graph = {
      ...base,
      nodes: base.nodes.map((node, index) =>
        index === 0 ? { ...node, position: { x: 10, y: 20 } } : node,
      ),
    };
    const text = serializeParcelState(graph, 4242);
    const raw = JSON.parse(text) as Record<string, unknown>;
    expect(raw.levelId).toBe('parcel-pulse');
    expect(raw.seed).toBe(4242);
    expect(raw).not.toHaveProperty('result');

    const opened = parseParcelState(text);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.format).toBe('state');
      expect(opened.seed).toBe(4242);
      expect(opened.graph).toEqual(graph);
    }

    const bare = parseParcelState(serializeParcelGraph(graph));
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.format).toBe('graph');
      expect(bare.seed).toBeNull();
      expect(bare.graph).toEqual(graph);
    }
  });

  it('rejects an out-of-range seed and a wrong level without touching the graph', () => {
    const graph = createParcelGraph();
    const valid = JSON.parse(serializeParcelState(graph, 7)) as Record<
      string,
      unknown
    >;
    expect(parseParcelState(JSON.stringify({ ...valid, seed: 1.5 })).ok).toBe(
      false,
    );
    expect(
      parseParcelState(JSON.stringify({ ...valid, seed: 2 ** 31 })).ok,
    ).toBe(false);
    expect(
      parseParcelState(JSON.stringify({ ...valid, levelId: 'cold-cache' })).ok,
    ).toBe(false);
    expect(parseParcelState('{oops').ok).toBe(false);
    expect(graph).toEqual(createParcelGraph());
  });
});
