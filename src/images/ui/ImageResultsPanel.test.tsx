import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { imageEvaluationSchema, parseImageEvaluation } from '../contracts';
import { createImageGraph } from '../graph';
import { imageEvaluationFixture } from './image-evaluation.fixture';
import { ImageResultsPanel } from './ImageResultsPanel';
import { useImageStore } from './image-store';

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
}

async function renderResults() {
  const user = userEvent.setup();
  const panelRef = { current: null };
  render(
    <ImageResultsPanel
      open
      onOpenChange={() => undefined}
      height={null}
      panelRef={panelRef}
    />,
  );
  return user;
}

function openedEvaluation(): void {
  useImageStore.setState({
    runPhase: 'completed',
    runId: null,
    result: imageEvaluationFixture,
    resultDigest: 'fixture-digest',
    resultSeed: 101,
    runStartedAt: 1,
    runFinishedAt: 2,
  });
}

describe('Image Atlas results panel', () => {
  beforeEach(resetStore);

  it('renders a contract-valid evaluation with every required section', async () => {
    expect(imageEvaluationSchema.safeParse(imageEvaluationFixture).success).toBe(true);
    expect(parseImageEvaluation(imageEvaluationFixture).ok).toBe(true);

    openedEvaluation();
    await renderResults();

    expect(screen.getByLabelText('Results and telemetry')).toBeVisible();
    expect(screen.getByText('Evaluation · seed 101')).toBeVisible();
    expect(screen.getByText('Not qualified')).toBeVisible();
    expect(screen.queryByText(/^Run result/)).not.toBeInTheDocument();

    // All seven scenario gates are listed as selectable cases.
    const tabs = screen.getByRole('tablist', { name: 'Qualification case' });
    expect(within(tabs).getAllByRole('tab')).toHaveLength(7);
    expect(within(tabs).getByRole('tab', { name: /Normal daily average/ })).toBeVisible();
    expect(within(tabs).getByRole('tab', { name: /Peak daily average · fail/ })).toBeVisible();

    // Operation evidence includes counts, ratios and sample counts.
    expect(screen.getByText('Measured operations · 60 s window, successful percentiles only')).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Timely' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Correct' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Samples' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'p99.9' })).toBeVisible();
    expect(screen.getByText(/Other failed, timed-out, stale, incorrect/)).toBeVisible();

    // Correctness, freshness and publication evidence.
    expect(screen.getByText('Correctness, freshness and publication')).toBeVisible();
    expect(screen.getByText('Freshness probes')).toBeVisible();
    expect(screen.getByText('Consistency postlude')).toBeVisible();

    // Capacity, cost, memory and physical links stay separate views.
    expect(screen.getByText('Capacity at day 30')).toBeVisible();
    expect(screen.getByText('Metadata stores at day 30')).toBeVisible();
    expect(screen.getByText('Cost')).toBeVisible();
    expect(screen.getByText('Fixed provider base')).toBeVisible();
    expect(screen.getByText('Controllable compute + disk')).toBeVisible();
    expect(screen.getByText('Measured memory and instance health per node')).toBeVisible();
    expect(
      screen.getByText(
        'Physical channels shared by every logical route (not one link per arrow)',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/A logical edge on the canvas is not its own 100 Gbit\/s link/),
    ).toBeVisible();

    // Failure diagnostics are actionable and can focus a node.
    expect(screen.getByText('Diagnostics')).toBeVisible();
    expect(screen.getByText('Metadata-na headroom is thin at day 30.')).toBeVisible();
    const focusButtons = screen.getAllByRole('button', { name: 'Focus node' });
    expect(focusButtons.length).toBeGreaterThan(0);
  });

  it('shows incident and recovery windows only for incident cases', async () => {
    openedEvaluation();
    useImageStore.setState({ selectedScenario: 'region-eu-failure' });
    const user = await renderResults();
    await user.click(
      screen.getByRole('tab', { name: /Region outage: EU/ }),
    );
    expect(screen.getByText('Incident and recovery windows')).toBeVisible();
    expect(screen.getByText(/Incident window · 20–40 s/)).toBeVisible();
    expect(screen.getByText(/Recovery window · 50–60 s/)).toBeVisible();

    await user.click(screen.getByRole('tab', { name: /Normal daily average/ }));
    expect(screen.queryByText('Incident and recovery windows')).not.toBeInTheDocument();
  });

  it('shows guided gate advice by default and hides only the advice when toggled off', async () => {
    openedEvaluation();
    useImageStore.setState({ selectedScenario: 'peak' });
    const user = await renderResults();
    const before = useImageStore.getState();

    const toggle = screen.getByRole('checkbox', { name: 'Guided analysis' });
    expect(toggle).toBeChecked();
    expect(screen.getByText(/Possible cause/)).toBeVisible();
    expect(screen.getByText('Evidence')).toBeVisible();
    expect(screen.getByText('Check next')).toBeVisible();
    expect(screen.getByText('Detail p99.9')).toBeVisible();
    expect(screen.getAllByText('Fail').length).toBeGreaterThan(0);

    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.queryByText(/Possible cause/)).not.toBeInTheDocument();
    expect(screen.queryByText('Evidence')).not.toBeInTheDocument();
    expect(screen.queryByText('Check next')).not.toBeInTheDocument();
    // Raw gates, metrics and errors stay visible with advice off.
    expect(screen.getByText('Detail p99.9')).toBeVisible();
    expect(screen.getAllByText('Fail').length).toBeGreaterThan(0);
    expect(screen.getByText('Measured operations · 60 s window, successful percentiles only')).toBeVisible();

    const after = useImageStore.getState();
    expect(after.graph).toBe(before.graph);
    expect(after.seed).toBe(before.seed);
    expect(after.result).toBe(before.result);
    expect(after.resultDigest).toBe(before.resultDigest);
    expect(after.selectedScenario).toBe('peak');

    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(screen.getByText('Check next')).toBeVisible();
  });

  it('keeps the stale-result notice while guided advice still explains the stored case', async () => {
    openedEvaluation();
    useImageStore.setState({ selectedScenario: 'peak', seed: 211 });
    await renderResults();

    expect(
      screen.getByText(/This result belongs to an earlier semantic graph or seed/),
    ).toBeVisible();
    expect(screen.getByText('Previous result')).toBeVisible();
    expect(screen.getByText('Check next')).toBeVisible();
  });

  it('states that empty Diagnostics means no extra notices, not no failures', async () => {
    openedEvaluation();
    useImageStore.setState({
      result: {
        ...imageEvaluationFixture,
        scenarios: imageEvaluationFixture.scenarios.map((scenario) => ({
          ...scenario,
          diagnostics: [],
        })),
      },
    });
    await renderResults();

    expect(
      screen.getByText(/No additional engine notices for this case\./),
    ).toBeVisible();
    expect(
      screen.getByText(/Request outcomes are counted in Operations/),
    ).toBeVisible();
  });

  it('does not claim a replay was measured for an analytical cost baseline', async () => {
    openedEvaluation();
    const cost = imageEvaluationFixture.cost!;
    expect(cost.provenance.measured).toBe(false);
    await renderResults();

    expect(
      screen.queryByText(/Monthly estimate: normal replay traffic scaled/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Projected from measured normal traffic'),
    ).not.toBeInTheDocument();
  });

  it('renders measured-run cost provenance without claiming it is this run', async () => {
    openedEvaluation();
    const cost = imageEvaluationFixture.cost!;
    const breakdown = cost.breakdown.map((line, index) =>
      index === 0 ? { ...line, provenance: 'measured-run' as const } : line,
    );
    useImageStore.setState({
      result: {
        ...imageEvaluationFixture,
        cost: {
          ...cost,
          breakdown,
          provenance: { ...cost.provenance, measured: true },
        },
      },
    });
    await renderResults();

    expect(
      screen.getByText('Projected from measured normal traffic'),
    ).toBeVisible();
    expect(
      screen.getByText(
        'Monthly estimate: normal replay traffic scaled to 30 days; not the cost of this run.',
      ),
    ).toBeVisible();
  });

  it('marks a stale result as a previous result without hiding the evidence', async () => {
    openedEvaluation();
    useImageStore.setState({ seed: 211 });
    await renderResults();

    expect(
      screen.getByText(/This result belongs to an earlier semantic graph or seed/),
    ).toBeVisible();
    expect(screen.getByText('Previous result')).toBeVisible();
    expect(screen.getByText('Evaluation · seed 101')).toBeVisible();
    expect(screen.getByText('Measured operations · 60 s window, successful percentiles only')).toBeVisible();
  });

  it('renders invalid and incomplete results without inventing metrics', async () => {
    useImageStore.setState({
      runPhase: 'completed',
      result: {
        ...imageEvaluationFixture,
        status: 'invalid',
        passed: false,
        capacity: null,
        cost: null,
        scenarios: [],
        issues: [
          {
            severity: 'error',
            code: 'fixed_endpoint_missing',
            message: 'The fixed client "client-na" is missing.',
            nodeId: 'client-na',
          },
        ],
      } as never,
    });
    await renderResults();
    expect(screen.getAllByText('Invalid graph').length).toBeGreaterThan(0);
    expect(screen.getByText('Validation issues')).toBeVisible();
    expect(screen.queryByText('Measured operations · 60 s window, successful percentiles only')).not.toBeInTheDocument();

    useImageStore.setState({
      result: {
        ...imageEvaluationFixture,
        status: 'incomplete',
        passed: false,
        scenarios: [],
        incompleteReason: {
          code: 'event_budget_exhausted',
          message: 'The scenario event budget was exhausted.',
        },
      } as never,
    });
    await renderResults();
    expect(screen.getAllByText('Incomplete evaluation').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/event_budget_exhausted/).length).toBeGreaterThan(0);
  });

  it('summarizes a blocked run with its blocking issues', async () => {
    useImageStore.setState({
      runPhase: 'blocked',
      runIssues: [
        {
          severity: 'error',
          code: 'metadata_missing',
          message: 'At least one metadata store is required.',
        },
      ],
    });
    await renderResults();
    expect(screen.getByText('Run blocked before evaluation')).toBeVisible();
    expect(
      screen.getByText('At least one metadata store is required.'),
    ).toBeVisible();
  });

  it('reports a stopped run as having no partial result', async () => {
    useImageStore.setState({ runPhase: 'stopped' });
    await renderResults();
    expect(screen.getAllByText('Run stopped').length).toBeGreaterThan(0);
    expect(screen.getByText('No partial result')).toBeVisible();
  });
});
