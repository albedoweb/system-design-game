import { describe, expect, it } from 'vitest';
import { createCartStarterGraph } from '../index';
import { parseCartState, serializeCartState } from './cart-persistence';
import {
  CART_SHARE_LINK_MAX_LENGTH,
  buildCartShareUrl,
  decodeCartDesign,
  encodeCartDesign,
  loadCartShareData,
  readCartShareData,
} from './cart-share-link';

describe('loading a design link', () => {
  it('returns the graph when the design is still current', async () => {
    const graph = createCartStarterGraph();
    const data = await encodeCartDesign(serializeCartState(graph));
    expect(await loadCartShareData(data, () => true)).toEqual({ kind: 'loaded', graph });
  });

  it('reports a damaged link as failed, not silently', async () => {
    const outcome = await loadCartShareData('garbage', () => true);
    expect(outcome.kind).toBe('failed');
  });

  it('reports superseded when the player edits while the link is still decoding', async () => {
    const data = await encodeCartDesign(serializeCartState(createCartStarterGraph()));
    let current = true;
    const pending = loadCartShareData(data, () => current);
    current = false; // the player edits before decompression finishes
    expect(await pending).toEqual({ kind: 'superseded' });
  });
});

describe('design links', () => {
  it('carries the export text through encode and decode unchanged, then validates it like Import', async () => {
    const graph = createCartStarterGraph();
    const exported = serializeCartState(graph);
    const data = await encodeCartDesign(exported);
    expect(data).not.toMatch(/[+/=]/);

    const decoded = await decodeCartDesign(data);
    expect(decoded).toEqual({ ok: true, text: exported });
    if (!decoded.ok) return;
    expect(parseCartState(decoded.text)).toEqual({ ok: true, graph });
  });

  it('builds a fragment link that the reader can extract', async () => {
    const exported = serializeCartState(createCartStarterGraph());
    const built = await buildCartShareUrl('http://127.0.0.1:5178/', exported);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.url.startsWith('http://127.0.0.1:5178/#design=')).toBe(true);
    const data = readCartShareData(new URL(built.url).hash);
    expect(data).not.toBeNull();
    expect(await decodeCartDesign(data!)).toEqual({ ok: true, text: exported });
  });

  it('rejects a damaged string with an error and never throws', async () => {
    const data = await encodeCartDesign(serializeCartState(createCartStarterGraph()));
    const damaged = [
      'garbage',
      data.slice(0, -12),
      `${data.slice(0, 20)}!${data.slice(21)}`,
      '',
      'a',
    ];
    for (const value of damaged) {
      const result = await decodeCartDesign(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/damaged or cannot be read/);
    }
  });

  it('refuses a design whose link is longer than the limit', async () => {
    const random = new Uint8Array(12_000);
    crypto.getRandomValues(random);
    const text = Array.from(random, (byte) => String.fromCharCode(byte)).join('');
    const built = await buildCartShareUrl('http://127.0.0.1:5178/', text);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.message).toMatch(/too large for a link/);
    expect(CART_SHARE_LINK_MAX_LENGTH).toBe(8_000);
  });

  it('recognises only the design fragment', () => {
    expect(readCartShareData('#design=abc')).toBe('abc');
    expect(readCartShareData('design=abc')).toBe('abc');
    expect(readCartShareData('#cold-cache')).toBeNull();
    expect(readCartShareData('')).toBeNull();
  });
});
