import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { createImageGraph, parseImageGraph } from '../graph';
import { useImageStore } from './image-store';
import { ImageWorkspace } from './ImageWorkspace';

function fixture(name: string, level = 'images'): string {
  return readFileSync(
    resolve(process.cwd(), 'fixtures', level, `${name}.json`),
    'utf8',
  );
}

function resetStore(): void {
  useImageStore.setState({
    graph: createImageGraph(),
    selection: null,
    past: [],
    future: [],
    revision: 0,
    pendingMove: null,
    seed: 101,
    selectedScenario: 'normal',
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
    hydrated: true,
  });
  window.localStorage.clear();
  window.sessionStorage.clear();
}

async function renderWorkspace() {
  const user = userEvent.setup();
  render(<ImageWorkspace />);
  await screen.findByRole('heading', { level: 1, name: 'Image Atlas' });
  return user;
}

describe('Image Atlas workspace', () => {
  beforeEach(resetStore);

  it('exposes the standard accessible controls for the level', async () => {
    await renderWorkspace();

    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Seed')).toHaveValue(101);
    expect(screen.getByRole('button', { name: 'Reset' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
    expect(screen.getByLabelText('Open saved graph file')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
    expect(screen.queryByText('Level passed')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Run result/)).not.toBeInTheDocument();
    // The starter is structurally valid, so no blocking notice is shown.
    expect(screen.queryByText(/Run will be blocked/)).not.toBeInTheDocument();
  });

  it('surfaces live validation as soon as an edit makes the graph invalid', async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole('tab', { name: 'Components' }));
    await user.click(
      screen.getByRole('button', { name: 'Add: Byte-bounded cache' }),
    );
    expect(
      await screen.findByText(/Run will be blocked by 1 error/),
    ).toBeVisible();
  });

  it('adds a player node from the palette and undoes it', async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole('tab', { name: 'Components' }));

    const before = useImageStore.getState().graph.nodes.length;
    await user.click(
      screen.getByRole('button', { name: 'Add: Byte-bounded cache' }),
    );
    expect(useImageStore.getState().graph.nodes).toHaveLength(before + 1);
    expect(
      useImageStore.getState().graph.nodes.some((node) => node.kind === 'cache'),
    ).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(useImageStore.getState().graph.nodes).toHaveLength(before);
    await user.click(screen.getByRole('button', { name: 'Redo' }));
    expect(useImageStore.getState().graph.nodes).toHaveLength(before + 1);
  });

  it('shows per-kind catalog properties and locks a fixed endpoint', async () => {
    await renderWorkspace();
    act(() => {
      useImageStore.getState().select({ type: 'node', id: 'metadata-na' });
    });

    expect(
      await screen.findByRole('heading', { level: 2, name: /metadata origin/i }),
    ).toBeVisible();
    expect(screen.getByLabelText('Index mode')).toBeInTheDocument();
    expect(screen.getByLabelText('Local durable copies')).toBeInTheDocument();
    expect(screen.getByLabelText('Disk per instance')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete node' })).toBeEnabled();

    const select = screen.getByLabelText('Index mode');
    await userEvent.setup().selectOptions(select, 'user-tag');
    expect(
      useImageStore.getState().graph.nodes.find((node) => node.id === 'metadata-na')
        ?.config,
    ).toMatchObject({ index: 'user-tag' });

    act(() => {
      useImageStore.getState().select({ type: 'node', id: 'client-na' });
    });
    expect(await screen.findByText('Fixed contract')).toBeVisible();
    expect(screen.getByLabelText('Region')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Delete node' })).not.toBeInTheDocument();

    act(() => {
      useImageStore.getState().select({ type: 'node', id: 'app-na' });
    });
    expect(await screen.findByLabelText('Delivery')).toBeInTheDocument();
    expect(screen.getByLabelText('Instances')).toBeInTheDocument();
    expect(screen.getByLabelText('Retry backoff')).toBeInTheDocument();
  });

  it('deletes a selected player node with the keyboard but never a fixed endpoint', async () => {
    const user = await renderWorkspace();
    act(() => {
      useImageStore.getState().select({ type: 'node', id: 'client-na' });
    });
    await user.keyboard('{Delete}');
    expect(
      useImageStore.getState().graph.nodes.some((node) => node.id === 'client-na'),
    ).toBe(true);
    expect(await screen.findByText(/fixed endpoint of the level/i)).toBeVisible();

    act(() => {
      useImageStore.getState().select({ type: 'node', id: 'app-ap' });
    });
    await user.keyboard('{Delete}');
    expect(
      useImageStore.getState().graph.nodes.some((node) => node.id === 'app-ap'),
    ).toBe(false);
  });

  it('rejects a cross-level file without touching the canvas', async () => {
    const user = await renderWorkspace();
    const before = useImageStore.getState().graph;

    await user.upload(
      screen.getByLabelText('Open saved graph file'),
      new File([fixture('family-sql-indexed', 'parcel')], 'parcel.json', {
        type: 'application/json',
      }),
    );

    expect(await screen.findByText('Open rejected')).toBeVisible();
    expect(useImageStore.getState().graph).toBe(before);
    expect(useImageStore.getState().seed).toBe(101);
  });

  it('opens a saved Image Atlas graph and reports it explicitly', async () => {
    const user = await renderWorkspace();
    await user.upload(
      screen.getByLabelText('Open saved graph file'),
      new File([fixture('directory-direct')], 'directory-direct.json', {
        type: 'application/json',
      }),
    );

    expect(await screen.findByText('File opened')).toBeVisible();
    expect(
      useImageStore.getState().graph.nodes.some((node) => node.id === 'metadata-eu'),
    ).toBe(true);
    expect(useImageStore.getState().result).toBeNull();
  });

  it('restores the starter and the default seed from the Reset dialog only', async () => {
    const user = await renderWorkspace();
    const parsed = parseImageGraph(
      JSON.parse(fixture('directory-direct')) as unknown,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    act(() => {
      useImageStore.getState().openState(parsed.graph, 4242);
    });
    expect(await screen.findByLabelText('Seed')).toHaveValue(4242);

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Restore the Image Atlas starter?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(useImageStore.getState().seed).toBe(4242);

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    const confirm = await screen.findByRole('dialog', {
      name: 'Restore the Image Atlas starter?',
    });
    await user.click(within(confirm).getByRole('button', { name: 'Reset graph' }));
    expect(useImageStore.getState().seed).toBe(101);
    expect(useImageStore.getState().graph.nodes).toHaveLength(10);
    expect(useImageStore.getState().past).toHaveLength(0);
    await waitFor(() => {
      expect(screen.getByLabelText('Seed')).toHaveValue(101);
    });
  });

  it('blocks an invalid graph before any worker or result appears', async () => {
    const user = await renderWorkspace();
    const base = createImageGraph();
    act(() => {
      useImageStore.setState({
        graph: {
          ...base,
          nodes: base.nodes.filter((node) => node.kind !== 'metadata'),
          edges: base.edges.filter((edge) => edge.operation !== 'metadata'),
        },
      });
    });

    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('Run blocked before evaluation')).toBeVisible();
    expect(useImageStore.getState().runPhase).toBe('blocked');
    expect(useImageStore.getState().result).toBeNull();
  });

  it('reports an unavailable engine instead of inventing a result', async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => {
      expect(useImageStore.getState().runPhase).toBe('error');
    });
    expect(screen.getByText('No result')).toBeVisible();
    expect(useImageStore.getState().result).toBeNull();
    expect(useImageStore.getState().runError).toMatch(/engine/i);
  });
});
