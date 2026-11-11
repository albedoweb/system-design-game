import {
  DEFAULT_LEVEL,
  DomainValidationError,
  MAX_SEED,
  parseGraph,
  parseGraphJson,
  validateGraph,
  type GraphDocument,
  type ValidationIssue,
} from '../../domain';
import {
  readLevelState,
  serializeLevelState,
  type LevelStateReadResult,
} from './level-state';

export type ImportResult =
  | { ok: true; graph: GraphDocument }
  | { ok: false; message: string; issues: ValidationIssue[] };

/**
 * Strict import boundary: 1 MiB text bound, JSON shape validation, and a
 * graph-level schema parse. Topology is intentionally not required to be
 * runnable so an unfinished draft can still be imported and edited.
 */
export function parseImportedGraph(text: string): ImportResult {
  try {
    const graph = parseGraphJson(text);
    const structural = validateGraph(graph, { mode: 'draft' });
    if (structural.length > 0) {
      return {
        ok: false,
        message: 'The graph has structural errors',
        issues: structural,
      };
    }
    return { ok: true, graph };
  } catch (error) {
    if (error instanceof DomainValidationError) {
      return {
        ok: false,
        message: 'The graph file is invalid',
        issues: error.issues,
      };
    }
    return {
      ok: false,
      message: 'Could not read the graph JSON',
      issues: [],
    };
  }
}

export function serializeGraph(graph: GraphDocument): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}

function parseDraftGraphValue(
  value: unknown,
): { ok: true; graph: GraphDocument } | { ok: false; message: string } {
  try {
    const graph = parseGraph(value);
    const structural = validateGraph(graph, { mode: 'draft' });
    if (structural.length > 0) {
      return {
        ok: false,
        message:
          structural[0]?.message ?? 'The graph has structural errors.',
      };
    }
    return { ok: true, graph };
  } catch (error) {
    if (error instanceof DomainValidationError) {
      return {
        ok: false,
        message: error.issues[0]?.message ?? 'The graph file is invalid.',
      };
    }
    return { ok: false, message: 'Could not read the graph JSON.' };
  }
}

/** Save the graph, node settings, positions and seed as one explicit file. */
export function serializeLevelStateFile(
  graph: GraphDocument,
  seed: number,
): string {
  return serializeLevelState({
    levelId: DEFAULT_LEVEL.id,
    contentVersion: DEFAULT_LEVEL.contentVersion,
    seed,
    graph,
  });
}

/** Open a saved-state file, or an older bare graph file. */
export function parseLevelStateFile(
  text: string,
  byteLength?: number,
): LevelStateReadResult<GraphDocument> {
  return readLevelState(text, {
    levelId: DEFAULT_LEVEL.id,
    contentVersion: DEFAULT_LEVEL.contentVersion,
    maxSeed: MAX_SEED,
    byteLength,
    parseGraph: parseDraftGraphValue,
  });
}

