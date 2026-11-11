import {
  SCOREBOARD_CONTENT_VERSION,
  SCOREBOARD_LEVEL_ID,
  SCOREBOARD_MAX_SEED,
  parseScoreboardGraph,
  type ScoreboardGraph,
} from '../index';
import {
  LEVEL_STATE_MAX_BYTES,
  readLevelState,
  serializeLevelState,
  type LevelStateReadResult,
} from '../../features/persistence/level-state';

/**
 * Explicit file save/open only. Live Scoreboard deliberately has no draft
 * storage: refresh and Reset both start from the Users-only starter graph.
 */

export const SCOREBOARD_MAX_IMPORT_BYTES = LEVEL_STATE_MAX_BYTES;

function parseGraphValue(
  value: unknown,
): { ok: true; graph: ScoreboardGraph } | { ok: false; message: string } {
  const parsed = parseScoreboardGraph(value);
  if (!parsed.ok) {
    return {
      ok: false,
      message:
        parsed.issues[0]?.message ??
        'The graph does not match the Live Scoreboard schema.',
    };
  }
  return { ok: true, graph: parsed.value };
}

export function serializeScoreboardState(
  graph: ScoreboardGraph,
  seed: number,
): string {
  return serializeLevelState({
    levelId: SCOREBOARD_LEVEL_ID,
    contentVersion: SCOREBOARD_CONTENT_VERSION,
    seed,
    graph,
  });
}

/** Open a saved state envelope or an older bare graph file. */
export function parseScoreboardState(
  text: string,
  byteLength?: number,
): LevelStateReadResult<ScoreboardGraph> {
  return readLevelState(text, {
    levelId: SCOREBOARD_LEVEL_ID,
    contentVersion: SCOREBOARD_CONTENT_VERSION,
    maxSeed: SCOREBOARD_MAX_SEED,
    byteLength,
    parseGraph: parseGraphValue,
  });
}

export function downloadScoreboardText(
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
