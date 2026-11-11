import { describe, expect, it } from 'vitest';

import { DEFAULT_LEVEL, createInitialGraph } from '../../domain';
import {
  clearDraft,
  draftStorageKey,
  readDraft,
  writeDraft,
} from './draft-storage';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe('draft storage', () => {
  it('сохраняет и читает граф с версией уровня', () => {
    const storage = new MemoryStorage();
    const graph = createInitialGraph();
    graph.nodes[1]!.config.size = 'medium';

    expect(writeDraft(storage, DEFAULT_LEVEL, graph).ok).toBe(true);
    const read = readDraft(storage, DEFAULT_LEVEL);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') {
      expect(read.graph).toEqual(graph);
    }
  });

  it('возвращает сырой повреждённый payload и не теряет его при чтении', () => {
    const storage = new MemoryStorage();
    const key = draftStorageKey(DEFAULT_LEVEL);
    storage.setItem(key, '{not-json');
    const read = readDraft(storage, DEFAULT_LEVEL);
    expect(read.kind).toBe('corrupt');
    if (read.kind === 'corrupt') {
      expect(read.raw).toBe('{not-json');
    }
    expect(storage.getItem(key)).toBe('{not-json');
  });

  it('отклоняет черновик другой версии уровня', () => {
    const storage = new MemoryStorage();
    writeDraft(storage, DEFAULT_LEVEL, createInitialGraph());
    const key = draftStorageKey(DEFAULT_LEVEL);
    const record = JSON.parse(storage.getItem(key) ?? '{}') as {
      contentVersion: string;
    };
    record.contentVersion = '9.9.9';
    storage.setItem(key, JSON.stringify(record));
    expect(readDraft(storage, DEFAULT_LEVEL).kind).toBe('corrupt');
  });

  it('сообщает о квоте без выброса исключения', () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    const result = writeDraft(storage, DEFAULT_LEVEL, createInitialGraph());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/full/i);
    }
  });

  it('удаляет только собственный ключ', () => {
    const storage = new MemoryStorage();
    storage.setItem('другой-ключ', 'keep');
    writeDraft(storage, DEFAULT_LEVEL, createInitialGraph());
    expect(clearDraft(storage, DEFAULT_LEVEL).ok).toBe(true);
    expect(storage.getItem('другой-ключ')).toBe('keep');
  });
});
