import {
  IMAGE_CONTENT_VERSION,
  IMAGE_LEVEL_ID,
  IMAGE_MAX_SEED,
  type ImageGraph,
  type ImageIssue,
} from '../contracts';
import { parseImageGraph } from '../graph';
import {
  readLevelState,
  serializeLevelState,
  type LevelStateReadResult,
} from '../../features/persistence/level-state';

export const IMAGE_MAX_IMPORT_BYTES = 1024 * 1024;

/**
 * Explicit save envelope. It reuses the shared versioned level-state envelope
 * (`kind: sdg-level-state`, `stateVersion: 1`) and binds it to `image-atlas`
 * plus the frozen content version. The envelope carries the graph — including
 * node settings and positions — and the deterministic seed. It never contains
 * results, progress, worker handles or a draft key.
 */
export function serializeImageState(graph: ImageGraph, seed: number): string {
  return serializeLevelState({
    levelId: IMAGE_LEVEL_ID,
    contentVersion: IMAGE_CONTENT_VERSION,
    seed,
    graph,
  });
}

/**
 * Open a saved Image Atlas state file, or an older bare Image Atlas graph file.
 * Rejection is atomic: the caller keeps the current canvas.
 */
export function parseImageState(
  text: string,
  byteLength?: number,
): LevelStateReadResult<ImageGraph> {
  return readLevelState(text, {
    levelId: IMAGE_LEVEL_ID,
    contentVersion: IMAGE_CONTENT_VERSION,
    maxSeed: IMAGE_MAX_SEED,
    byteLength,
    parseGraph: (value) => {
      const parsed = parseImageGraph(value);
      if (!parsed.ok) {
        return {
          ok: false,
          message:
            parsed.issues[0]?.message ??
            'The graph does not match the Image Atlas schema.',
        };
      }
      return { ok: true, graph: parsed.graph };
    },
  });
}

export type ImageImportResult =
  | { ok: true; graph: ImageGraph; seed: number | null; format: 'state' | 'graph' }
  | { ok: false; message: string; issues: readonly ImageIssue[] };

/** Bare graph import used by tests and by the file input error path. */
export function parseImageGraphImport(
  text: string,
  byteLength = new TextEncoder().encode(text).length,
): ImageImportResult {
  if (byteLength > IMAGE_MAX_IMPORT_BYTES) {
    return {
      ok: false,
      message: 'The file is larger than 1 MiB and was not imported.',
      issues: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      message: 'The file is not valid JSON. The graph was not changed.',
      issues: [],
    };
  }
  const result = parseImageGraph(parsed);
  if (!result.ok) {
    return {
      ok: false,
      message: 'The graph file does not match the Image Atlas schema.',
      issues: result.issues,
    };
  }
  return { ok: true, graph: result.graph, seed: null, format: 'graph' };
}

export function downloadImageText(
  text: string,
  filename: string,
  type = 'application/json',
): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
