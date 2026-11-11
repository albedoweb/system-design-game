import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MetricChart } from './MetricChart';
import { CHART_METRIC_COLORS, useChartCursor } from './chart-model';

const TIMES = [0, 500, 1_000, 1_500];

function trafficSeries() {
  return [
    {
      label: 'offered',
      color: CHART_METRIC_COLORS.offered,
      values: [10, 200, 200, 10],
    },
    {
      label: 'goodput',
      color: CHART_METRIC_COLORS.successful,
      values: [10, 198, 197, 10],
    },
    {
      label: 'errors',
      color: CHART_METRIC_COLORS.errors,
      values: [0, 2, 3, 0],
    },
  ];
}

function svgRect(): DOMRect {
  return {
    left: 0,
    top: 0,
    width: 340,
    height: 132,
    right: 340,
    bottom: 132,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('MetricChart', () => {
  it('renders engine-provided series with an operation selector', async () => {
    const user = userEvent.setup();
    const onOperationChange = vi.fn();
    render(
      <MetricChart
        kind="traffic"
        operations={[
          { id: 'view', label: 'View leaderboard', series: trafficSeries() },
          {
            id: 'change',
            label: 'Change vote',
            series: [
              {
                label: 'offered',
                color: CHART_METRIC_COLORS.offered,
                values: [1, 2, 3, 4],
              },
            ],
          },
        ]}
        selectedOperationId="view"
        onOperationChange={onOperationChange}
        timesMs={TIMES}
        durationMs={1_500}
        unit="requests/s"
      />,
    );

    expect(screen.getByRole('img', { name: /Traffic: offered, goodput, errors/ })).toBeVisible();
    expect(screen.getByText('goodput')).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Operation'), 'change');
    expect(onOperationChange).toHaveBeenCalledWith('change');
  });

  it('shows the configurable critical window and SLO reference line', () => {
    const { container } = render(
      <MetricChart
        kind="latency"
        title="p95 successful"
        timesMs={TIMES}
        durationMs={1_500}
        series={[
          {
            label: 'p95',
            color: CHART_METRIC_COLORS.latency,
            values: [120, 240, 260, 130],
          },
        ]}
        criticalFromMs={500}
        criticalToMs={1_000}
        criticalLabel="peak window"
        slo={{ value: 250, label: 'SLO' }}
        unit="ms"
        valueDigits={0}
      />,
    );

    expect(screen.getByText('peak window')).toBeVisible();
    expect(screen.getByText('SLO 250')).toBeVisible();
    expect(container.querySelector('.chart__critical')).toBeInTheDocument();
    expect(container.querySelector('.chart__slo-line')).toBeInTheDocument();
  });

  it('keeps unknown values unknown and survives a zero-duration timeline', () => {
    const { container, rerender } = render(
      <MetricChart
        kind="queue"
        timesMs={[0, 500]}
        durationMs={1_000}
        series={[
          {
            label: 'waiting',
            color: CHART_METRIC_COLORS.queue,
            values: [null, null],
          },
        ]}
        unit="requests"
      />,
    );

    expect(screen.getByText('no data')).toBeVisible();

    rerender(
      <MetricChart
        kind="queue"
        timesMs={[0]}
        durationMs={0}
        series={[
          {
            label: 'waiting',
            color: CHART_METRIC_COLORS.queue,
            values: [4],
          },
        ]}
        unit="requests"
      />,
    );
    const paths = Array.from(container.querySelectorAll('path')).map((path) =>
      path.getAttribute('d'),
    );
    expect(paths.join(' ')).not.toContain('NaN');
    expect(screen.getAllByText('0 s').length).toBeGreaterThan(0);
  });

  it('reports pointer time and keyboard steps through the controlled cursor', () => {
    const onCursorChange = vi.fn();
    render(
      <MetricChart
        kind="traffic"
        timesMs={TIMES}
        durationMs={1_500}
        series={trafficSeries()}
        unit="requests/s"
        cursorMs={0}
        onCursorChange={onCursorChange}
      />,
    );

    const svg = screen.getByRole('img', { name: /Traffic/ });
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(svgRect());
    // View box is 340 wide with 38 px left padding: 40% of the timeline.
    fireEvent.pointerMove(svg, { clientX: 154.8 });
    expect(onCursorChange).toHaveBeenCalledWith(500);

    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(onCursorChange).toHaveBeenCalledWith(500);
    fireEvent.keyDown(svg, { key: 'End' });
    expect(onCursorChange).toHaveBeenCalledWith(1_500);
    fireEvent.keyDown(svg, { key: 'Escape' });
    expect(onCursorChange).toHaveBeenCalledWith(null);
  });

  it('shares one hover time between traffic, latency, queue and resource charts', () => {
    function Harness() {
      const { cursorMs, setCursorMs } = useChartCursor();
      const common = {
        timesMs: TIMES,
        durationMs: 1_500,
        cursorMs,
        onCursorChange: setCursorMs,
      };
      return (
        <div>
          <MetricChart
            kind="traffic"
            timesMs={common.timesMs}
            durationMs={common.durationMs}
            series={trafficSeries()}
            unit="requests/s"
            cursorMs={common.cursorMs}
            onCursorChange={common.onCursorChange}
          />
          <MetricChart
            kind="latency"
            timesMs={common.timesMs}
            durationMs={common.durationMs}
            series={[
              {
                label: 'p95',
                color: CHART_METRIC_COLORS.latency,
                values: [10, 20, 30, 40],
              },
            ]}
            unit="ms"
            cursorMs={common.cursorMs}
            onCursorChange={common.onCursorChange}
          />
          <MetricChart
            kind="queue"
            timesMs={common.timesMs}
            durationMs={common.durationMs}
            series={[
              {
                label: 'waiting',
                color: CHART_METRIC_COLORS.queue,
                values: [1, 2, 3, 4],
              },
            ]}
            unit="requests"
            cursorMs={common.cursorMs}
            onCursorChange={common.onCursorChange}
          />
          <MetricChart
            kind="resources"
            timesMs={common.timesMs}
            durationMs={common.durationMs}
            series={[
              {
                label: 'CPU',
                color: CHART_METRIC_COLORS.resource,
                values: [20, 40, 60, 80],
              },
            ]}
            unit="%"
            cursorMs={common.cursorMs}
            onCursorChange={common.onCursorChange}
          />
        </div>
      );
    }

    const { container } = render(<Harness />);
    const traffic = screen.getByRole('img', { name: /Traffic/ });
    vi.spyOn(traffic, 'getBoundingClientRect').mockReturnValue(svgRect());
    fireEvent.pointerMove(traffic, { clientX: 154.8 });

    const readouts = screen.getAllByTestId('chart-readout');
    expect(readouts).toHaveLength(4);
    for (const readout of readouts) {
      expect(within(readout).getByText('0.5 s')).toBeVisible();
    }
    expect(within(readouts[0]!).getByText('offered: 200')).toBeVisible();
    expect(within(readouts[1]!).getByText('p95: 20')).toBeVisible();

    const latency = screen.getByRole('img', { name: /Latency/ });
    fireEvent.keyDown(latency, { key: 'ArrowRight' });
    expect(screen.getAllByTestId('chart-readout')).toHaveLength(4);
    expect(within(screen.getAllByTestId('chart-readout')[3]!).getByText('1 s')).toBeVisible();
    expect(container.querySelectorAll('.chart__cursor')).toHaveLength(4);
  });

  it('exposes keyboard instructions only when a cursor callback is provided', () => {
    const { rerender } = render(
      <MetricChart
        kind="resources"
        timesMs={TIMES}
        durationMs={1_500}
        series={[]}
        unit="%"
      />,
    );
    expect(screen.getByRole('img')).not.toHaveAttribute('tabindex');
    expect(screen.getByRole('img').getAttribute('aria-label')).not.toContain('arrow keys');

    rerender(
      <MetricChart
        kind="resources"
        timesMs={TIMES}
        durationMs={1_500}
        series={[]}
        unit="%"
        onCursorChange={() => undefined}
      />,
    );
    expect(screen.getByRole('img')).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('arrow keys');
  });
});
