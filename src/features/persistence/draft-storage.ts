import {
  DomainValidationError,
  MAX_INPUT_BYTES,
  parseGraph,
  type GraphDocument,
  type LevelDefinition,
} from '../../domain';

export interface DraftRecord {
  storeVersion: 1;
  levelId: string;
  contentVersion: string;
  savedAt: string;
  graph: GraphDocument;
}

export type DraftReadResult =
  | { kind: 'empty' }
  | { kind: 'ok'; graph: GraphDocument; savedAt: string }
  | { kind: 'corrupt'; raw: string; message: string }
  | { kind: 'unavailable'; message: string };

export type DraftWriteResult =
  | { ok: true }
  | { ok: false; message: string };

export function draftStorageKey(level: LevelDefinition): string {
  return `sdg:draft:${level.id}:${level.contentVersion}:v1`;
}

export function getBrowserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function describeValidation(error: unknown): string {
  if (error instanceof DomainValidationError) {
    return 'the stored graph does not match the schema';
  }
  if (error instanceof Error) {
    return 'the stored data is not readable';
  }
  return 'unknown error';
}

export function readDraft(
  storage: Storage | null,
  level: LevelDefinition,
): DraftReadResult {
  if (!storage) {
    return {
      kind: 'unavailable',
      message: 'Browser local storage is unavailable — the draft is not being saved.',
    };
  }

  let raw: string | null;
  try {
    raw = storage.getItem(draftStorageKey(level));
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
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('graph' in parsed)
    ) {
      return {
        kind: 'corrupt',
        raw,
        message: 'The saved draft does not contain a graph.',
      };
    }
    const record = parsed as Partial<DraftRecord>;
    if (
      record.storeVersion !== 1 ||
      record.levelId !== level.id ||
      record.contentVersion !== level.contentVersion
    ) {
      return {
        kind: 'corrupt',
        raw,
        message: 'The saved draft belongs to another version of this level.',
      };
    }
    const graph = parseGraph(record.graph);
    return {
      kind: 'ok',
      graph,
      savedAt:
        typeof record.savedAt === 'string'
          ? record.savedAt
          : new Date(0).toISOString(),
    };
  } catch (error) {
    return {
      kind: 'corrupt',
      raw,
      message: `The draft is corrupted: ${describeValidation(error)}`,
    };
  }
}

export function writeDraft(
  storage: Storage | null,
  level: LevelDefinition,
  graph: GraphDocument,
): DraftWriteResult {
  if (!storage) {
    return {
      ok: false,
      message: 'Browser local storage is unavailable.',
    };
  }
  const record: DraftRecord = {
    storeVersion: 1,
    levelId: level.id,
    contentVersion: level.contentVersion,
    savedAt: new Date().toISOString(),
    graph,
  };
  const raw = JSON.stringify(record);
  if (new TextEncoder().encode(raw).length > MAX_INPUT_BYTES) {
    return {
      ok: false,
      message: 'The draft is larger than 1 MiB and was not saved.',
    };
  }
  try {
    storage.setItem(draftStorageKey(level), raw);
    return { ok: true };
  } catch (error) {
    const quota =
      error instanceof DOMException &&
      (error.name === 'QuotaExceededError' ||
        error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    return {
      ok: false,
      message: quota
        ? 'Local storage is full — the draft was not saved.'
        : 'The browser did not allow the draft to be saved.',
    };
  }
}

export function clearDraft(
  storage: Storage | null,
  level: LevelDefinition,
): DraftWriteResult {
  if (!storage) {
    return { ok: false, message: 'Local storage is unavailable.' };
  }
  try {
    storage.removeItem(draftStorageKey(level));
    return { ok: true };
  } catch {
    return { ok: false, message: 'Could not delete the saved draft.' };
  }
}

export function downloadTextFile(
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
