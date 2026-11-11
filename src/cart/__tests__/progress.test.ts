import { expect, it } from 'vitest';
import { createCartSession, cartProgressSchema } from '../index';
import reference from '../../../tests/fixtures/cart/basic/reference-basic.json';

it('reports exact current-scenario workload progress without counting transport work', () => {
  const session = createCartSession(reference);
  const first = session.advance(10).progress;
  expect(first).toMatchObject({ casesCompleted: 0, caseEvents: 10, caseEventsTotal: 54_000 });
  expect(cartProgressSchema.safeParse(first).success).toBe(true);
  const second = session.advance(5).progress;
  expect(second).toMatchObject({ caseId: first.caseId, caseEvents: 15, caseEventsTotal: 54_000 });
  session.cancel();
  const partial = session.result()!;
  expect(partial).toMatchObject({ complete: false, qualified: false, scoreCreditsPerHour: null });
  expect(partial.cases[0]!.resources.events).toBe(15);
  expect(partial.cases[0]!.gates).toEqual([]);
  const snapshot = partial.cases[0]!.observation!;
  expect(snapshot.operations.reduce((sum, row) => sum + row.launched, 0)).toBe(15);
  for (const row of snapshot.operations) expect(row.completed + row.pending).toBe(row.launched);
  expect(snapshot.nodes.length).toBeGreaterThan(0);
  expect(snapshot.elapsedMs).toBeGreaterThan(0);
  expect(partial.cases[0]!.outcomes['not-executed']).toBe(54_000 - 15);
});

it('reports real request problems before completion without declaring qualification', () => {
  const graph = structuredClone(reference);
  graph.edges = graph.edges.filter(edge => !edge.id.startsWith('x'));
  // Remove every storage request path: rejected/dependency failures are observable immediately.
  graph.edges = graph.edges.filter(edge => !edge.to.startsWith('journal'));
  const session = createCartSession(graph);
  const progress = session.advance(500).progress;
  expect(progress.requestProblems).toBeGreaterThan(0);
  expect(session.result()).toBeNull();
  session.cancel();
  expect(session.result()?.scoreCreditsPerHour).toBeNull();
  expect(session.result()!.cases[0]!.observation!.operations.reduce((sum, row) => sum + row.errors, 0)).toBe(progress.requestProblems);
});
