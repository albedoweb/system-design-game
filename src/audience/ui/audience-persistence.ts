import {
  AUDIENCE_CONTENT_VERSION,
  AUDIENCE_LEVEL_ID,
  AUDIENCE_MAX_SEED,
  parseAudienceGraph,
  type AudienceGraph,
} from '../index';
import {
  LEVEL_STATE_MAX_BYTES,
  readLevelState,
  serializeLevelState,
  type LevelStateReadResult,
} from '../../features/persistence/level-state';

/**
 * Explicit file save/open only. Live Audience deliberately has no draft
 * storage: refresh and Reset both start from the Users-only starter graph.
 * A saved file from another level is rejected atomically before the graph is
 * touched, so a cross-level document can never partly replace the editor.
 */

export const AUDIENCE_MAX_IMPORT_BYTES = LEVEL_STATE_MAX_BYTES;

function parseGraphValue(
  value: unknown,
): { ok: true; graph: AudienceGraph } | { ok: false; message: string } {
  const parsed = parseAudienceGraph(value);
  if (!parsed.ok) {
    return {
      ok: false,
      message:
        parsed.issues[0]?.message ??
        'The graph does not match the Live Audience schema.',
    };
  }
  return { ok: true, graph: parsed.value };
}

export function serializeAudienceState(
  graph: AudienceGraph,
  seed: number,
): string {
  return serializeLevelState({
    levelId: AUDIENCE_LEVEL_ID,
    contentVersion: AUDIENCE_CONTENT_VERSION,
    seed,
    graph,
  });
}

/** Open a saved state envelope or an older bare graph file. */
export function parseAudienceState(
  text: string,
  byteLength?: number,
): LevelStateReadResult<AudienceGraph> {
  return readLevelState(text, {
    levelId: AUDIENCE_LEVEL_ID,
    contentVersion: AUDIENCE_CONTENT_VERSION,
    maxSeed: AUDIENCE_MAX_SEED,
    byteLength,
    parseGraph: parseGraphValue,
  });
}

export function downloadAudienceText(
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
