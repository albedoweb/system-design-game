import { beforeEach, describe, expect, it } from 'vitest';

import {
  ID_PATTERN,
  MAX_GRAPH_EDGES,
  MAX_ID_LENGTH,
  createInitialGraph,
  makeNode,
  parseGraph,
  type GraphDocument,
  type GraphEdge,
} from '../domain';
import { parseImportedGraph } from '../features/persistence/import-export';
import { useEditorStore } from './editor-store';

function resetStore() {
  useEditorStore.getState().loadGraph(createInitialGraph());
}

function longId(prefix: string): string {
  return `${prefix}${'x'.repeat(MAX_ID_LENGTH - prefix.length)}`;
}

/** Imported graph whose four nodes all use the maximum allowed id length. */
function maxLengthIdGraph(): GraphDocument {
  return {
    schemaVersion: 1,
    levelId: 'cold-cache',
    nodes: [
      makeNode('client', longId('client-'), { x: 0, y: 140 }),
      makeNode('appServer', longId('app-'), { x: 240, y: 140 }),
      makeNode('cache', longId('cache-'), { x: 480, y: 40 }),
      makeNode('database', longId('db-'), { x: 720, y: 140 }),
    ],
    edges: [],
  };
}

/** Schema-valid graph that already holds the maximum number of edges. */
function graphAtEdgeLimit(): GraphDocument {
  const apps = [1, 2, 3, 4, 5].map((index) => `app-${index}`);
  const edges: GraphEdge[] = [
    { id: 'e-1', source: 'client-1', sourcePort: 'out', target: 'lb-1' },
    ...apps.map((app) => ({
      id: `e-lb-${app}`,
      source: 'lb-1',
      sourcePort: 'out' as const,
      target: app,
    })),
    ...apps.flatMap((app) => [
      {
        id: `e-read-cache-${app}`,
        source: app,
        sourcePort: 'read' as const,
        target: 'cache-1',
      },
      {
        id: `e-read-db-${app}`,
        source: app,
        sourcePort: 'read' as const,
        target: 'db-1',
      },
      {
        id: `e-write-db-${app}`,
        source: app,
        sourcePort: 'write' as const,
        target: 'db-1',
      },
    ]),
    { id: 'e-miss', source: 'cache-1', sourcePort: 'miss', target: 'db-1' },
    { id: 'e-extra-1', source: 'app-1', sourcePort: 'read', target: 'db-1' },
    { id: 'e-extra-2', source: 'app-1', sourcePort: 'read', target: 'db-1' },
  ];
  return {
    schemaVersion: 1,
    levelId: 'cold-cache',
    nodes: [
      makeNode('client', 'client-1', { x: 0, y: 140 }),
      makeNode('loadBalancer', 'lb-1', { x: 200, y: 140 }),
      ...apps.map((app, index) =>
        makeNode('appServer', app, { x: 400, y: 40 + index * 120 }),
      ),
      makeNode('cache', 'cache-1', { x: 640, y: 40 }),
      makeNode('database', 'db-1', { x: 880, y: 140 }),
    ],
    edges,
  };
}

describe('editor store', () => {
  beforeEach(resetStore);

  it('добавляет допустимый узел и выбирает его', () => {
    const result = useEditorStore.getState().addNode('appServer');
    expect(result.ok).toBe(true);
    const state = useEditorStore.getState();
    expect(state.graph.nodes).toHaveLength(5);
    expect(state.selection).toEqual({ type: 'node', id: result.id });
    expect(state.past).toHaveLength(1);
    expect(
      state.graph.nodes.find((node) => node.id === result.id)?.label,
    ).toBe('App Server 2');
  });

  it('не добавляет второй кеш или балансировщик', () => {
    expect(useEditorStore.getState().addNode('cache').ok).toBe(false);
    expect(useEditorStore.getState().addNode('loadBalancer').ok).toBe(true);
    expect(useEditorStore.getState().addNode('loadBalancer').ok).toBe(false);
  });

  it('не удаляет фиксированные клиент и базу', () => {
    const client = useEditorStore.getState().removeNode('client-1');
    const database = useEditorStore.getState().removeNode('db-1');
    expect(client.ok).toBe(false);
    expect(database.ok).toBe(false);
    expect(useEditorStore.getState().graph.nodes).toHaveLength(4);
  });

  it('удаляет узел вместе с его связями', () => {
    const result = useEditorStore.getState().removeNode('cache-1');
    expect(result.ok).toBe(true);
    const state = useEditorStore.getState();
    expect(state.graph.edges.some((edge) => edge.source === 'cache-1')).toBe(false);
    expect(state.graph.edges.some((edge) => edge.target === 'cache-1')).toBe(false);
  });

  it('отклоняет недопустимую связь и не меняет граф', () => {
    const before = structuredClone(useEditorStore.getState().graph);
    const result = useEditorStore.getState().addEdge('app-1', 'write', 'cache-1');
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Connection rejected');
    expect(result.issues?.[0]?.code).toBe('illegal-port');
    expect(useEditorStore.getState().graph).toEqual(before);
  });

  it('отклоняет дубликат связи', () => {
    const result = useEditorStore.getState().addEdge('app-1', 'read', 'cache-1');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/already exists/i);
  });

  it('отменяет и повторяет изменение параметра', () => {
    useEditorStore.getState().updateNodeConfig('db-1', { size: 'large' });
    expect(
      useEditorStore.getState().graph.nodes.find((node) => node.id === 'db-1')
        ?.config.size,
    ).toBe('large');

    useEditorStore.getState().undo();
    expect(
      useEditorStore.getState().graph.nodes.find((node) => node.id === 'db-1')
        ?.config.size,
    ).toBe('small');

    useEditorStore.getState().redo();
    expect(
      useEditorStore.getState().graph.nodes.find((node) => node.id === 'db-1')
        ?.config.size,
    ).toBe('large');
  });

  it('не коммитит пустую подпись', () => {
    const result = useEditorStore.getState().updateNodeLabel('app-1', '   ');
    expect(result.ok).toBe(true);
    expect(
      useEditorStore.getState().graph.nodes.find((node) => node.id === 'app-1')
        ?.label,
    ).toBe('App Server');
  });

  it('сохраняет пользовательские подписи без перевода', () => {
    const graph = createInitialGraph();
    graph.nodes = graph.nodes.map((node) =>
      node.id === 'client-1'
        ? { ...node, label: 'Клиент' }
        : node.id === 'app-1'
          ? { ...node, label: 'Сервер приложений' }
          : node,
    );

    useEditorStore.getState().loadGraph(graph);
    const loaded = useEditorStore.getState().graph.nodes;
    expect(loaded.find((node) => node.id === 'client-1')?.label).toBe('Клиент');
    expect(loaded.find((node) => node.id === 'app-1')?.label).toBe(
      'Сервер приложений',
    );

    useEditorStore.getState().replaceGraph(graph);
    const replaced = useEditorStore.getState().graph.nodes;
    expect(replaced.find((node) => node.id === 'client-1')?.label).toBe('Клиент');
    expect(replaced.find((node) => node.id === 'app-1')?.label).toBe(
      'Сервер приложений',
    );

    useEditorStore.getState().resetGraph();
    expect(
      useEditorStore.getState().graph.nodes.find((node) => node.id === 'client-1')
        ?.label,
    ).toBe('Client');
  });

  it('Reset clears edit history so Undo cannot restore the replaced draft', () => {
    useEditorStore.getState().updateNodeConfig('app-1', { size: 'large' });
    expect(useEditorStore.getState().past.length).toBeGreaterThan(0);

    useEditorStore.getState().resetGraph();
    const reset = useEditorStore.getState();
    expect(reset.past).toEqual([]);
    expect(reset.future).toEqual([]);
    expect(reset.selection).toBeNull();

    reset.undo();
    expect(useEditorStore.getState().past).toEqual([]);
    expect(
      useEditorStore.getState().graph.nodes.find((node) => node.id === 'app-1')
        ?.config.size,
    ).toBe('small');
  });

  it('сбрасывает параметры базы к значениям уровня', () => {    useEditorStore.getState().updateNodeConfig('db-1', {
      size: 'large',
      queueLimit: 7,
    });
    useEditorStore.getState().resetNode('db-1');
    const node = useEditorStore
      .getState()
      .graph.nodes.find((item) => item.id === 'db-1');
    expect(node?.config.size).toBe('small');
    expect(node?.config.queueLimit).toBe(128);
  });

  it('перемещение меняет layout, но не конфигурацию для оценки результата', () => {
    const before = useEditorStore.getState();
    const { configRevision, revision } = before;
    before.beginMove();
    before.moveNode('app-1', { x: 300, y: 200 });
    useEditorStore.getState().endMove();
    const after = useEditorStore.getState();
    expect(after.revision).toBeGreaterThan(revision);
    expect(after.configRevision).toBe(configRevision);
    expect(after.past).toHaveLength(before.past.length + 1);
  });

  it('создаёт короткие допустимые id связей для импортированных узлов с id максимальной длины', () => {
    const imported = parseImportedGraph(JSON.stringify(maxLengthIdGraph()));
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    useEditorStore.getState().loadGraph(imported.graph);

    const client = longId('client-');
    const app = longId('app-');
    const cache = longId('cache-');
    const database = longId('db-');

    const results = [
      useEditorStore.getState().addEdge(client, 'out', app),
      useEditorStore.getState().addEdge(app, 'read', cache),
      useEditorStore.getState().addEdge(app, 'write', database),
      useEditorStore.getState().addEdge(cache, 'miss', database),
    ];
    expect(results.map((result) => result.ok)).toEqual([
      true,
      true,
      true,
      true,
    ]);

    const graph = useEditorStore.getState().graph;
    expect(graph.nodes.map((node) => node.id.length)).toEqual([
      MAX_ID_LENGTH,
      MAX_ID_LENGTH,
      MAX_ID_LENGTH,
      MAX_ID_LENGTH,
    ]);
    expect(graph.edges).toHaveLength(4);
    const ids = graph.edges.map((edge) => edge.id);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(MAX_ID_LENGTH);
      expect(id).toMatch(ID_PATTERN);
    }
    expect(results.map((result) => result.id)).toEqual(ids);
    expect(() => parseGraph(graph)).not.toThrow();
  });

  it('отклоняет связь, если граф после неё не проходит строгую схему', () => {
    const graph = graphAtEdgeLimit();
    expect(parseGraph(graph).edges).toHaveLength(MAX_GRAPH_EDGES);
    useEditorStore.getState().loadGraph(graph);

    const result = useEditorStore.getState().addEdge('client-1', 'out', 'app-1');
    expect(result.ok).toBe(false);
    expect(result.issues?.map((issue) => issue.code)).toContain('schema');
    expect(useEditorStore.getState().graph.edges).toHaveLength(MAX_GRAPH_EDGES);
  });
});
