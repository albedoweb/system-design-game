/**
 * Explicit, file-based save state for a level.
 *
 * Nothing is persisted automatically. The exported file is a small versioned
 * envelope that carries the graph (including node settings and positions) and
 * the deterministic seed. It never contains execution results, progress or
 * worker handles. Reading accepts the envelope and, for backwards
 * compatibility, an old bare graph JSON file.
 */

export const LEVEL_STATE_KIND = 'sdg-level-state';
export const LEVEL_STATE_VERSION = 1;
export const LEVEL_STATE_MAX_BYTES = 1024 * 1024;

export interface LevelStateEnvelope<Graph> {
  kind: typeof LEVEL_STATE_KIND;
  stateVersion: typeof LEVEL_STATE_VERSION;
  levelId: string;
  contentVersion: string;
  savedAt: string;
  seed: number;
  graph: Graph;
}

export interface LevelStateSaveInput<Graph> {
  levelId: string;
  contentVersion: string;
  seed: number;
  graph: Graph;
}

export type LevelStateReadResult<Graph> =
  | {
      ok: true;
      graph: Graph;
      /** `null` for a bare graph file, which has no saved seed. */
      seed: number | null;
      format: 'state' | 'graph';
    }
  | { ok: false; message: string };

export interface LevelStateReadOptions<Graph> {
  levelId: string;
  contentVersion: string;
  maxSeed: number;
  byteLength?: number;
  parseGraph: (value: unknown) => { ok: true; graph: Graph } | { ok: false; message: string };
}

export function serializeLevelState<Graph>(
  input: LevelStateSaveInput<Graph>,
): string {
  const envelope: LevelStateEnvelope<Graph> = {
    kind: LEVEL_STATE_KIND,
    stateVersion: LEVEL_STATE_VERSION,
    levelId: input.levelId,
    contentVersion: input.contentVersion,
    savedAt: new Date().toISOString(),
    seed: input.seed,
    graph: input.graph,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function isEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === LEVEL_STATE_KIND
  );
}

export function readLevelState<Graph>(
  text: string,
  options: LevelStateReadOptions<Graph>,
): LevelStateReadResult<Graph> {
  const bytes =
    options.byteLength ?? new TextEncoder().encode(text).length;
  if (bytes > LEVEL_STATE_MAX_BYTES) {
    return {
      ok: false,
      message: 'The file is larger than 1 MiB and was not opened.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      message: 'The file is not valid JSON.',
    };
  }

  if (!isEnvelope(parsed)) {
    // Backwards compatibility: an old bare graph file still opens, using the
    // level default seed instead of an unrecorded one.
    const graph = options.parseGraph(parsed);
    return graph.ok
      ? { ok: true, graph: graph.graph, seed: null, format: 'graph' }
      : { ok: false, message: graph.message };
  }

  if (parsed.stateVersion !== LEVEL_STATE_VERSION) {
    return {
      ok: false,
      message: 'The saved-state file uses an unsupported version.',
    };
  }
  if (
    parsed.levelId !== options.levelId ||
    parsed.contentVersion !== options.contentVersion
  ) {
    return {
      ok: false,
      message: 'The saved-state file belongs to another level or version.',
    };
  }
  const seed = parsed.seed;
  if (
    typeof seed !== 'number' ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > options.maxSeed
  ) {
    return {
      ok: false,
      message: 'The saved seed is not valid for this level.',
    };
  }
  const graph = options.parseGraph(parsed.graph);
  if (!graph.ok) {
    return { ok: false, message: graph.message };
  }
  return { ok: true, graph: graph.graph, seed, format: 'state' };
}
