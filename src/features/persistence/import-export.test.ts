import { describe, expect, it } from 'vitest';

import { DEFAULT_LEVEL, createInitialGraph } from '../../domain';
import {
  parseImportedGraph,
  parseLevelStateFile,
  serializeGraph,
  serializeLevelStateFile,
} from './import-export';

describe('import/export graph JSON', () => {
  it('принимает строгий граф и сериализует его без потерь', () => {
    const graph = createInitialGraph();
    const text = serializeGraph(graph);
    const result = parseImportedGraph(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph).toEqual(graph);
    }
  });

  it('отклоняет битый JSON и не изменяет переданный граф', () => {
    const current = createInitialGraph();
    const before = JSON.stringify(current);
    const result = parseImportedGraph('{ this is not json');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(current)).toBe(before);
  });

  it('отклоняет граф с неизвестным полем', () => {
    const graph = createInitialGraph() as unknown as Record<string, unknown>;
    graph.injected = true;
    const result = parseImportedGraph(JSON.stringify(graph));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('отклоняет пустой объект и объясняет путь поля', () => {
    const result = parseImportedGraph('{}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/graph file is invalid/i);
    }
  });

  it('отклоняет структурно повреждённый граф', () => {
    const graph = createInitialGraph();
    graph.edges.push({ ...graph.edges[0]! });
    const result = parseImportedGraph(JSON.stringify(graph));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'duplicate-id')).toBe(
        true,
      );
    }
  });

  it('сохраняет граф, позиции и seed в версионированном конверте', () => {
    const graph = createInitialGraph();
    graph.nodes[0]!.position = { x: 123, y: 45 };
    const text = serializeLevelStateFile(graph, 777);
    const raw = JSON.parse(text) as Record<string, unknown>;
    expect(raw.kind).toBe('sdg-level-state');
    expect(raw.stateVersion).toBe(1);
    expect(raw.levelId).toBe(DEFAULT_LEVEL.id);
    expect(raw.seed).toBe(777);
    expect(raw).not.toHaveProperty('result');
    expect(raw).not.toHaveProperty('worker');
    expect(raw).not.toHaveProperty('runPhase');

    const opened = parseLevelStateFile(text);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.format).toBe('state');
      expect(opened.seed).toBe(777);
      expect(opened.graph).toEqual(graph);
    }
  });

  it('открывает старый файл с одним графом и берёт seed уровня по умолчанию', () => {
    const graph = createInitialGraph();
    const opened = parseLevelStateFile(serializeGraph(graph));
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.format).toBe('graph');
      expect(opened.seed).toBeNull();
      expect(opened.graph).toEqual(graph);
    }
  });

  it('отклоняет битый конверт, чужой уровень и неверный seed', () => {
    const graph = createInitialGraph();
    const valid = JSON.parse(serializeLevelStateFile(graph, 1)) as Record<
      string,
      unknown
    >;

    expect(parseLevelStateFile('{ broken').ok).toBe(false);
    expect(
      parseLevelStateFile(JSON.stringify({ ...valid, levelId: 'other' })).ok,
    ).toBe(false);
    expect(
      parseLevelStateFile(JSON.stringify({ ...valid, stateVersion: 9 })).ok,
    ).toBe(false);
    expect(
      parseLevelStateFile(JSON.stringify({ ...valid, seed: 1.5 })).ok,
    ).toBe(false);
    expect(
      parseLevelStateFile(JSON.stringify({ ...valid, seed: -1 })).ok,
    ).toBe(false);
    expect(
      parseLevelStateFile(JSON.stringify({ ...valid, seed: 2 ** 40 })).ok,
    ).toBe(false);
    // The current graph is unchanged by a rejected open.
    expect(JSON.stringify(graph)).toBe(JSON.stringify(createInitialGraph()));
  });
});
