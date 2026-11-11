import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LEVEL,
  createInitialGraph,
  type Metric,
  type RunResult,
} from '../../domain';
import { ResultsPanel } from './ResultsPanel';

const metric: Metric = {
  offered: 100,
  succeeded: 98,
  failed: 2,
  pending: 0,
  p50Ms: 10,
  p95Ms: 20,
  p99Ms: 30,
  errors: {},
};

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    seed: 101,
    passed: false,
    costMicroUsdPerHour: 2_600_000,
    checks: [
      {
        id: 'read-availability',
        label: 'Read availability',
        actual: 98,
        target: 99.5,
        unit: '%',
        passed: false,
      },
      {
        id: 'read-p95',
        label: 'Read p95',
        actual: null,
        target: 150,
        unit: 'ms',
        passed: false,
      },
      {
        id: 'cost',
        label: 'Budget cost',
        actual: 2.6,
        target: 5.5,
        unit: '$/h',
        passed: true,
      },
    ],
    snapshot: {
      timeMs: 60_800,
      phase: 'completed',
      reads: metric,
      writes: metric,
      nodes: [],
      series: [],
      events: [],
    },
    diagnostics: [
      {
        severity: 'warning',
        message: '3 of 10 reads failed (queue_overflow: 3)',
        nodeId: 'db-1',
      },
    ],
    ...overrides,
  };
}

function renderResults(
  result: RunResult,
  props: Partial<ComponentProps<typeof ResultsPanel>> = {},
) {
  return render(
    <ResultsPanel
      result={result}
      graph={createInitialGraph()}
      level={DEFAULT_LEVEL}
      revision={2}
      resultRevision={1}
      currentSeed={101}
      best={null}
      bestError={null}
      isNewBest={false}
      onSelectNode={vi.fn()}
      {...props}
    />,
  );
}

describe('ResultsPanel', () => {
  it('показывает проверки, прочерк и точную диагностику', async () => {
    const user = userEvent.setup();
    const onSelectNode = vi.fn();
    renderResults(makeResult(), { onSelectNode });

    expect(screen.getByRole('heading', { name: 'Not passed' })).toBeVisible();
    expect(screen.getByText('Read availability')).toBeVisible();
    expect(screen.getByText('Read p95')).toBeVisible();
    // check.label is rendered verbatim, not remapped from check.id.
    expect(screen.getByText('Budget cost')).toBeVisible();
    expect(screen.getByText('—')).toBeVisible();
    expect(screen.getAllByText('Fail').length).toBeGreaterThan(0);
    expect(screen.getByText(/previous run/i)).toBeVisible();
    expect(
      screen.getByText('3 of 10 reads failed (queue_overflow: 3)'),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Show “Database”/ }));
    expect(onSelectNode).toHaveBeenCalledWith('db-1');
    expect(document.body.textContent).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('показывает Passed и новый локальный лучший результат', () => {
    renderResults(
      makeResult({
        passed: true,
        checks: [
          {
            id: 'read-availability',
            label: 'Read availability',
            actual: 99.8,
            target: 99.5,
            unit: '%',
            passed: true,
          },
        ],
        diagnostics: [],
      }),
      {
        revision: 1,
        best: {
          costMicroUsdPerHour: 2_600_000,
          readP95Ms: 120,
          achievedAt: new Date(0).toISOString(),
        },
        isNewBest: true,
      },
    );

    expect(screen.getByRole('heading', { name: 'Passed' })).toBeVisible();
    expect(screen.getByText('New local best result')).toBeVisible();
    expect(screen.getByText(/content 1.0.0/)).toBeVisible();
  });
});
