import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { createParcelGraph } from '../graph';
import { ParcelWorkspace } from './ParcelWorkspace';
import { useParcelStore } from './parcel-store';

function resetStore(): void {
  useParcelStore.setState({
    graph: createParcelGraph(),
    selection: null,
    past: [],
    future: [],
    revision: 0,
    pendingMove: null,
    seed: 101,
    selectedHorizon: 5,
    runPhase: 'idle',
    runId: null,
    progress: null,
    result: null,
    resultDigest: null,
    resultSeed: null,
    runIssues: [],
    runError: null,
    runStartedAt: null,
    runFinishedAt: null,
    hydrated: false,
  });
  window.localStorage.clear();
}

async function renderWorkspace() {
  const user = userEvent.setup();
  render(<ParcelWorkspace />);
  await screen.findByRole('heading', { level: 1, name: 'Parcel Pulse' });
  return user;
}

function seedSelectedGraph(): void {
  useParcelStore.getState().addNode('kv');
  useParcelStore.getState().select({ type: 'node', id: 'sql-1' });
}

describe('Parcel workspace modal shortcuts', () => {
  beforeEach(resetStore);

  it('does not delete or undo behind the Connect dialog, then restores shortcuts after close', async () => {
    seedSelectedGraph();
    const user = await renderWorkspace();
    const before = useParcelStore.getState();
    const beforeNodes = before.graph.nodes.length;
    const beforeEdges = before.graph.edges.length;
    const beforePast = before.past.length;

    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect nodes' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    cancel.focus();

    await user.keyboard('{Delete}');
    await user.keyboard('{Backspace}');
    await user.keyboard('{Control>}z{/Control}');

    const during = useParcelStore.getState();
    expect(during.graph.nodes).toHaveLength(beforeNodes);
    expect(during.graph.edges).toHaveLength(beforeEdges);
    expect(during.graph.nodes.some((node) => node.id === 'sql-1')).toBe(true);
    expect(during.graph.nodes.some((node) => node.id === 'kv-1')).toBe(true);
    expect(during.past).toHaveLength(beforePast);
    expect(during.selection).toEqual({ type: 'node', id: 'sql-1' });

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Connect nodes' })).not.toBeInTheDocument();
    });

    await user.keyboard('{Delete}');
    expect(
      useParcelStore.getState().graph.nodes.some((node) => node.id === 'sql-1'),
    ).toBe(false);

    await user.keyboard('{Control>}z{/Control}');
    expect(
      useParcelStore.getState().graph.nodes.some((node) => node.id === 'sql-1'),
    ).toBe(true);

    expect(
      screen.queryByRole('dialog', { name: 'Connect nodes' }),
    ).not.toBeInTheDocument();
  });

  it('does not delete or undo behind the Reset confirmation', async () => {
    seedSelectedGraph();
    const user = await renderWorkspace();
    const before = useParcelStore.getState();
    const beforeNodes = before.graph.nodes.length;
    const beforePast = before.past.length;

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Restore the Parcel starter?',
    });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    cancel.focus();

    await user.keyboard('{Delete}');
    await user.keyboard('{Control>}z{/Control}');

    const during = useParcelStore.getState();
    expect(during.graph.nodes).toHaveLength(beforeNodes);
    expect(during.graph.nodes.some((node) => node.id === 'sql-1')).toBe(true);
    expect(during.past).toHaveLength(beforePast);

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Restore the Parcel starter?' }),
      ).not.toBeInTheDocument();
    });

    await user.keyboard('{Delete}');
    expect(
      useParcelStore.getState().graph.nodes.some((node) => node.id === 'sql-1'),
    ).toBe(false);
  });
});
