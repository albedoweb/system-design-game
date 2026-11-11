import {
  PARCEL_CONTENT_VERSION,
  PARCEL_LEVEL_ID,
  PARCEL_MAX_SEED,
  type ParcelGraph,
  type ParcelIssue,
} from '../contracts';
import {
  readLevelState,
  serializeLevelState,
  type LevelStateReadResult,
} from '../../features/persistence/level-state';
import { parseParcelGraph } from '../graph';

const STORE_VERSION = 1;
const MAX_IMPORT_BYTES = 1024 * 1024;

export const PARCEL_DRAFT_KEY = `sdg:parcel:draft:${PARCEL_LEVEL_ID}:${PARCEL_CONTENT_VERSION}:v1`;

export interface ParcelDraftRecord {
  storeVersion: 1;
  levelId: typeof PARCEL_LEVEL_ID;
  contentVersion: string;
  savedAt: string;
  graph: ParcelGraph;
}

export type ParcelDraftRead =
  | { kind: 'empty' }
  | { kind: 'ok'; graph: ParcelGraph; savedAt: string }
  | { kind: 'corrupt'; raw: string; message: string }
  | { kind: 'unavailable'; message: string };

export type ParcelStorageResult =
  | { ok: true }
  | { ok: false; message: string };

export type ParcelImportResult =
  | { ok: true; graph: ParcelGraph }
  | { ok: false; message: string; issues: readonly ParcelIssue[] };

export function getParcelStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readParcelDraft(storage: Storage | null): ParcelDraftRead {
  if (!storage) {
    return {
      kind: 'unavailable',
      message:
        'Browser local storage is unavailable — the Parcel Pulse draft is not being saved.',
    };
  }
  let raw: string | null;
  try {
    raw = storage.getItem(PARCEL_DRAFT_KEY);
  } catch {
    return {
      kind: 'unavailable',
      message: 'The browser blocked access to local storage.',
    };
  }
  if (raw === null || raw.trim() === '') {
    return { kind: 'empty' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('graph' in parsed)) {
      return {
        kind: 'corrupt',
        raw,
        message: 'The saved draft does not contain a Parcel graph.',
      };
    }
    const record = parsed as Partial<ParcelDraftRecord>;
    if (
      record.storeVersion !== STORE_VERSION ||
      record.levelId !== PARCEL_LEVEL_ID ||
      record.contentVersion !== PARCEL_CONTENT_VERSION
    ) {
      return {
        kind: 'corrupt',
        raw,
        message: 'The saved draft belongs to another version of Parcel Pulse.',
      };
    }
    const parsedGraph = parseParcelGraph(record.graph);
    if (!parsedGraph.ok) {
      return {
        kind: 'corrupt',
        raw,
        message: `The saved draft is corrupted: ${
          parsedGraph.issues[0]?.message ?? 'the graph does not match the schema'
        }`,
      };
    }
    return {
      kind: 'ok',
      graph: parsedGraph.graph,
      savedAt:
        typeof record.savedAt === 'string'
          ? record.savedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return {
      kind: 'corrupt',
      raw,
      message: 'The saved draft is corrupted and cannot be read.',
    };
  }
}

export function writeParcelDraft(
  storage: Storage | null,
  graph: ParcelGraph,
): ParcelStorageResult {
  if (!storage) {
    return {
      ok: false,
      message: 'Browser local storage is unavailable.',
    };
  }
  const record: ParcelDraftRecord = {
    storeVersion: STORE_VERSION,
    levelId: PARCEL_LEVEL_ID,
    contentVersion: PARCEL_CONTENT_VERSION,
    savedAt: new Date().toISOString(),
    graph,
  };
  const raw = JSON.stringify(record);
  if (new TextEncoder().encode(raw).length > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      message: 'The Parcel draft is larger than 1 MiB and was not saved.',
    };
  }
  try {
    storage.setItem(PARCEL_DRAFT_KEY, raw);
    return { ok: true };
  } catch (error) {
    const quota =
      error instanceof DOMException &&
      (error.name === 'QuotaExceededError' ||
        error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    return {
      ok: false,
      message: quota
        ? 'Local storage is full — the Parcel draft was not saved.'
        : 'The browser did not allow the Parcel draft to be saved.',
    };
  }
}

export function clearParcelDraft(storage: Storage | null): ParcelStorageResult {
  if (!storage) {
    return { ok: false, message: 'Local storage is unavailable.' };
  }
  try {
    storage.removeItem(PARCEL_DRAFT_KEY);
    return { ok: true };
  } catch {
    return { ok: false, message: 'Could not delete the saved Parcel draft.' };
  }
}

export function serializeParcelGraph(graph: ParcelGraph): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}

function parseParcelGraphValue(
  value: unknown,
): { ok: true; graph: ParcelGraph } | { ok: false; message: string } {
  const result = parseParcelGraph(value);
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.issues[0]?.message ?? 'The graph does not match the Parcel schema.',
    };
  }
  return { ok: true, graph: result.graph };
}

/** Save the Parcel graph, settings, positions and seed as one explicit file. */
export function serializeParcelState(
  graph: ParcelGraph,
  seed: number,
): string {
  return serializeLevelState({
    levelId: PARCEL_LEVEL_ID,
    contentVersion: PARCEL_CONTENT_VERSION,
    seed,
    graph,
  });
}

/** Open a saved Parcel state file, or an older bare Parcel graph file. */
export function parseParcelState(
  text: string,
  byteLength?: number,
): LevelStateReadResult<ParcelGraph> {
  return readLevelState(text, {
    levelId: PARCEL_LEVEL_ID,
    contentVersion: PARCEL_CONTENT_VERSION,
    maxSeed: PARCEL_MAX_SEED,
    byteLength,
    parseGraph: parseParcelGraphValue,
  });
}

export function parseParcelImport(
  text: string,
  byteLength = new TextEncoder().encode(text).length,
): ParcelImportResult {
  if (byteLength > MAX_IMPORT_BYTES) {
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
  const result = parseParcelGraph(parsed);
  if (!result.ok) {
    return {
      ok: false,
      message: 'The graph file does not match the Parcel schema.',
      issues: result.issues,
    };
  }
  return { ok: true, graph: result.graph };
}

export function downloadParcelText(
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

export { MAX_IMPORT_BYTES as PARCEL_MAX_IMPORT_BYTES };
