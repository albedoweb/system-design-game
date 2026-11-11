import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import LegacyLevels from '../../app/LegacyLevels';
import { useSessionStore } from '../../state/session-store';

describe('workspace run lock', () => {
  afterEach(() => {
    act(() => {
      useSessionStore.getState().reset();
    });
  });

  it('keeps graph, config, import and reset locked while stopping awaits the worker', () => {
    render(<LegacyLevels route="cold-cache" />);

    act(() => {
      useSessionStore.setState({ phase: 'stopping', runId: 'run-stopping' });
    });

    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(screen.getByLabelText('Seed')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible();
    expect(screen.getByText('Stopping')).toBeVisible();
  });

  it('unlocks the graph once the stop is acknowledged', () => {
    render(<LegacyLevels route="cold-cache" />);

    act(() => {
      useSessionStore.setState({ phase: 'stopped', runId: null });
    });

    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeEnabled();
    expect(screen.getByLabelText('Seed')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Run again' })).toBeVisible();
  });
});
