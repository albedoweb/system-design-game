import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IMAGE_CONTENT_VERSION, IMAGE_LEVEL_ID } from '../contracts';
import { createImageGraph } from '../graph';
import {
  downloadImageText,
  IMAGE_MAX_IMPORT_BYTES,
  parseImageGraphImport,
  parseImageState,
  serializeImageState,
} from './image-persistence';
import { LEVEL_STATE_KIND, LEVEL_STATE_VERSION } from '../../features/persistence/level-state';
import { useImageStore } from './image-store';

function fixture(name: string): string {
  return readFileSync(
    resolve(process.cwd(), 'fixtures', 'images', `${name}.json`),
    'utf8',
  );
}

describe('Image Atlas explicit save envelope', () => {
  it('writes a versioned envelope with the graph, positions and seed', () => {
    const graph = createImageGraph();
    const text = serializeImageState(graph, 4242);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.kind).toBe(LEVEL_STATE_KIND);
    expect(parsed.stateVersion).toBe(LEVEL_STATE_VERSION);
    expect(parsed.levelId).toBe(IMAGE_LEVEL_ID);
    expect(parsed.contentVersion).toBe(IMAGE_CONTENT_VERSION);
    expect(parsed.seed).toBe(4242);
    expect(parsed.graph).toEqual(graph);
    expect(JSON.stringify(parsed)).not.toMatch(/result|progress|worker/i);
  });

  it('round-trips the envelope without losing positions', () => {
    const graph = createImageGraph();
    const moved = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === 'app-na'
          ? { ...node, position: { x: 42, y: 84 }, label: 'Renamed pool' }
          : node,
      ),
    };
    const result = parseImageState(serializeImageState(moved, 211));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.format).toBe('state');
    expect(result.seed).toBe(211);
    expect(result.graph.nodes).toEqual(moved.nodes);
  });

  it('still accepts an older bare Image Atlas graph file', () => {
    const result = parseImageState(fixture('directory-direct'));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.format).toBe('graph');
    expect(result.seed).toBeNull();
    expect(
      result.graph.nodes.some((node) => node.id === 'metadata-eu'),
    ).toBe(true);
  });

  it('rejects another level envelope atomically', () => {
    const envelope = {
      kind: LEVEL_STATE_KIND,
      stateVersion: LEVEL_STATE_VERSION,
      levelId: 'parcel-pulse',
      contentVersion: '1.0.0',
      savedAt: new Date().toISOString(),
      seed: 101,
      graph: { nodes: [], edges: [] },
    };
    const result = parseImageState(JSON.stringify(envelope));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.message).toMatch(/another level or version|schema/i);
  });

  it('rejects a bare graph from another level', () => {
    const parcelled = JSON.stringify({
      schemaVersion: 1,
      levelId: 'parcel-pulse',
      modelVersion: '1.0.0',
      nodes: [],
      edges: [],
    });
    const result = parseImageState(parcelled);
    expect(result.ok).toBe(false);
  });

  it('rejects malformed JSON, unknown fields and oversized input', () => {
    expect(parseImageState('{ not json').ok).toBe(false);
    expect(parseImageState('{"graph": []}').ok).toBe(false);
    expect(
      parseImageState(serializeImageState(createImageGraph(), 101), IMAGE_MAX_IMPORT_BYTES + 1)
        .ok,
    ).toBe(false);

    const graph = createImageGraph() as unknown as {
      nodes: Array<Record<string, unknown>>;
    };
    graph.nodes[0] = { ...graph.nodes[0], malicious: true };
    expect(parseImageState(JSON.stringify(graph)).ok).toBe(false);
  });

  it('rejects an out-of-range saved seed', () => {
    const text = serializeImageState(createImageGraph(), 101).replace(
      '"seed": 101',
      '"seed": -1',
    );
    expect(parseImageState(text).ok).toBe(false);
  });

  it('keeps the bare graph import helper bounded', () => {
    const imported = parseImageGraphImport(fixture('starter'));
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    expect(imported.seed).toBeNull();

    const malformed = parseImageGraphImport('{ nope');
    expect(malformed.ok).toBe(false);
    if (malformed.ok) {
      return;
    }
    expect(malformed.message).toMatch(/not valid JSON/i);
  });

  it('downloads a Blob without leaving the anchor in the document', () => {
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:image-atlas');
    const revokeObjectURL = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    downloadImageText('{"a":1}', 'image-atlas.json');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:image-atlas');
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector('a[download="image-atlas.json"]')).toBeNull();
  });
});

describe('Image Atlas open state keeps the canvas on rejection', () => {
  beforeEach(() => {
    useImageStore.getState().resetGraph();
  });

  it('does not change the graph when the file belongs to another level', () => {
    const before = useImageStore.getState().graph;
    const result = parseImageState(
      JSON.stringify({
        kind: LEVEL_STATE_KIND,
        stateVersion: LEVEL_STATE_VERSION,
        levelId: 'cold-cache',
        contentVersion: '1.0.0',
        savedAt: 'now',
        seed: 1,
        graph: before,
      }),
    );
    expect(result.ok).toBe(false);
    expect(useImageStore.getState().graph).toBe(before);
    expect(useImageStore.getState().seed).toBe(101);
  });
});
