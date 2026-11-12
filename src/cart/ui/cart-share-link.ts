import { CART_LIMITS, type CartGraph } from '../index';
import { parseCartState } from './cart-persistence';

/**
 * A design link carries the exact Export text (serializeCartState) in the URL
 * fragment, so it is never sent to a server. Format: `#design=<data>`, where
 * data is the export text compressed with deflate-raw and encoded as base64url
 * without padding. Validation stays in parseCartState, as for Import.
 */

/** Longest link the Copy link action produces, counted over the whole URL. */
export const CART_SHARE_LINK_MAX_LENGTH = 8_000;

const FRAGMENT_KEY = 'design=';

export type CartShareLinkResult = { ok: true; url: string } | { ok: false; message: string };
export type CartShareDecodeResult = { ok: true; text: string } | { ok: false; message: string };

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(data: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(data) || data.length % 4 === 1) {
    throw new Error('Not base64url.');
  }
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(data.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function singleChunk(bytes: Uint8Array<ArrayBuffer>): ReadableStream<BufferSource> {
  return new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = singleChunk(bytes).pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflates with the same size limit Import applies, so a small link cannot expand past it. */
async function inflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const reader = singleChunk(bytes).pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CART_LIMITS.maxDocumentBytes) {
      await reader.cancel();
      throw new Error('Too large.');
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

/** Encodes export text into the data part of `#design=<data>`. */
export async function encodeCartDesign(text: string): Promise<string> {
  return toBase64Url(await deflateRaw(new TextEncoder().encode(text)));
}

/** Decodes the data part of a design link. Never throws; a damaged link returns ok: false. */
export async function decodeCartDesign(data: string): Promise<CartShareDecodeResult> {
  try {
    const text = await inflateRaw(fromBase64Url(data));
    return { ok: true, text };
  } catch {
    return { ok: false, message: 'This design link is damaged or cannot be read.' };
  }
}

function parseDesignText(text: string): ReturnType<typeof parseCartState> | null {
  try {
    return parseCartState(text);
  } catch {
    return null;
  }
}

export type CartShareLoadOutcome =
  | { kind: 'loaded'; graph: CartGraph }
  | { kind: 'failed'; message: string }
  | { kind: 'superseded' };

/**
 * Decodes and validates a design link without touching the editor. `isCurrent`
 * is checked after the asynchronous work: if the player changed the design in
 * the meantime, the result is 'superseded' and the caller must not apply it.
 */
export async function loadCartShareData(data: string, isCurrent: () => boolean): Promise<CartShareLoadOutcome> {
  const decoded = await decodeCartDesign(data);
  let outcome: CartShareLoadOutcome;
  if (!decoded.ok) {
    outcome = { kind: 'failed', message: `${decoded.message} The starter design is shown.` };
  } else {
    const parsed = parseDesignText(decoded.text);
    outcome = parsed?.ok
      ? { kind: 'loaded', graph: parsed.graph }
      : { kind: 'failed', message: 'This design link is not a valid or supported Global Cart design. The starter design is shown.' };
  }
  return isCurrent() ? outcome : { kind: 'superseded' };
}

/** Builds the full link for `pageUrl` (the address without a fragment) and refuses links over the limit. */
export async function buildCartShareUrl(pageUrl: string, designText: string): Promise<CartShareLinkResult> {
  try {
    const url = `${pageUrl}#${FRAGMENT_KEY}${await encodeCartDesign(designText)}`;
    if (url.length > CART_SHARE_LINK_MAX_LENGTH) {
      return { ok: false, message: 'This design is too large for a link. Use Export to save it as a file.' };
    }
    return { ok: true, url };
  } catch {
    return { ok: false, message: 'Could not build a link for this design.' };
  }
}

/** Returns the data part when the hash is a design link, otherwise null. */
export function readCartShareData(hash: string): string | null {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  return body.startsWith(FRAGMENT_KEY) ? body.slice(FRAGMENT_KEY.length) : null;
}
