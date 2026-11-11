import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useScoreboardStore } from './scoreboard-store';
import { ScoreboardWorkspace } from './ScoreboardWorkspace';

function reset() {
  useScoreboardStore.getState().resetGraph();
  window.localStorage.clear();
  window.sessionStorage.clear();
}

async function renderWorkspace() {
  const user = userEvent.setup();
  render(<ScoreboardWorkspace />);
  await screen.findByRole('heading', { level: 1, name: 'Live Scoreboard' });
  return user;
}

describe('Live Scoreboard workspace', () => {
  beforeEach(reset);

  it('exposes the shared controls over a Users-only starter', async () => {
    await renderWorkspace();

    expect(screen.getByTestId('rf__node-users')).toBeInTheDocument();
    expect(screen.queryByTestId('rf__node-app-1')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Run evaluation' }),
    ).toBeEnabled();
    expect(screen.getByLabelText('Seed')).toHaveValue(101);
    expect(screen.getByRole('button', { name: 'Reset' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
    expect(screen.getByLabelText('Open saved graph file')).toBeInTheDocument();
    expect(screen.queryByText('Passed')).not.toBeInTheDocument();
    // The intentional Users-only starter is onboarding, not a red failure.
    expect(screen.getAllByText('Build your system').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Run will be blocked/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/The graph must contain exactly one Application/),
    ).not.toBeInTheDocument();
  });

  it('adds, connects and removes general components with undo', async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole('tab', { name: 'Components' }));

    await user.click(
      screen.getByRole('button', { name: 'Add: Application' }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Add: SQL Database' }),
    );
    expect(screen.getByTestId('rf__node-app-1')).toBeInTheDocument();
    expect(screen.getByTestId('rf__node-sql-1')).toBeInTheDocument();
    // Once the player starts editing, real validation becomes visible.
    expect(screen.getByText(/Run will be blocked by \d+ error/)).toBeVisible();
    expect(screen.getByText('Graph incomplete')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(screen.getByLabelText('Source'), 'users');
    await user.selectOptions(screen.getByLabelText('Target'), 'app-1');
    await user.click(screen.getByRole('button', { name: 'Create connection' }));
    expect(
      screen.getAllByText('traffic', { exact: true }).length,
    ).toBeGreaterThan(0);
    expect(useScoreboardStore.getState().graph.edges).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(useScoreboardStore.getState().graph.edges).toHaveLength(0);
    expect(dialog).not.toBeInTheDocument();
  });

  it('blocks the run on the starter and opens the Issues tab', async () => {
    const user = await renderWorkspace();
    await user.click(
      screen.getByRole('button', { name: 'Run evaluation' }),
    );
    expect(await screen.findByRole('heading', { name: 'Issues' })).toBeVisible();
    expect(
      screen.getAllByText(/Application service pool/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('No result yet')).toBeVisible();
  });

  it('keeps Users fixed and undeletable in the inspector', async () => {
    await renderWorkspace();
    act(() =>
      useScoreboardStore.getState().select({ type: 'node', id: 'users' }),
    );
    expect(
      screen.queryByRole('button', { name: 'Delete component' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be deleted or resized/)).toBeVisible();
  });
});
