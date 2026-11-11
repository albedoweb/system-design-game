import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SeriesChart, type ChartSeries } from './SeriesChart';

const series: ChartSeries[] = [
  { label: 'offered', color: '#0e7490', values: [10, null, 30] },
  { label: 'goodput', color: '#15803d', values: [9, null, 28] },
];

function renderLegacyChart() {
  return render(
    <SeriesChart
      title="Requests"
      series={series}
      timesMs={[0, 500, 1_000]}
      durationMs={1_000}
      criticalFromMs={200}
      criticalToMs={800}
      flushAtMs={600}
      unit="requests/s"
    />,
  );
}

describe('SeriesChart compatibility', () => {
  it('keeps the original first-level chart markup and labels', () => {
    const { container } = renderLegacyChart();

    expect(screen.getByRole('img', { name: 'Requests: offered, goodput' })).toBeVisible();
    expect(screen.getByText('flush')).toBeVisible();
    expect(screen.getByText('critical window')).toBeVisible();
    expect(container.querySelector('.chart__critical')).toBeInTheDocument();
    expect(container.querySelector('.chart__cursor')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chart-readout')).not.toBeInTheDocument();
    // A null sample breaks the line instead of being drawn as zero.
    const paths = Array.from(container.querySelectorAll('path')).map((path) =>
      path.getAttribute('d'),
    );
    expect(paths.join(' ').match(/M/g)).toHaveLength(4);
  });

  it('adds an SLO line and a configurable critical label only when requested', () => {
    render(
      <SeriesChart
        title="p95 successful"
        series={[{ label: 'p95', color: '#1d4ed8', values: [120, 260, 130] }]}
        timesMs={[0, 500, 1_000]}
        durationMs={1_000}
        criticalFromMs={500}
        criticalToMs={1_000}
        criticalLabel="peak"
        sloValue={250}
        sloLabel="SLO"
        unit="ms"
      />,
    );

    expect(screen.getByText('peak')).toBeVisible();
    expect(screen.getByText('SLO 250')).toBeVisible();
  });

  it('exposes keyboard and pointer cursor operations without changing old charts', () => {
    const onCursorChange = vi.fn();
    render(
      <SeriesChart
        title="Resources"
        series={[{ label: 'CPU', color: '#7c3aed', values: [10, 20, 30] }]}
        timesMs={[0, 500, 1_000]}
        durationMs={1_000}
        unit="%"
        cursorMs={500}
        onCursorChange={onCursorChange}
      />,
    );

    expect(screen.getByTestId('chart-readout')).toHaveTextContent('0.5 s');
    expect(screen.getByTestId('chart-readout')).toHaveTextContent('CPU: 20');
    const svg = screen.getByRole('img', { name: /Resources/ });
    expect(svg).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    expect(onCursorChange).toHaveBeenCalledWith(0);
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(onCursorChange).toHaveBeenCalledWith(1_000);
  });

  it('labels a shared cursor with the local snapped sample of each chart', () => {
    render(
      <>
        <SeriesChart
          title="Traffic"
          series={[{ label: 'offered', color: '#0e7490', values: [10, 20, 30] }]}
          timesMs={[0, 500, 1_000]}
          durationMs={1_000}
          unit="requests/s"
          cursorMs={500}
        />
        <SeriesChart
          title="Latency"
          series={[{ label: 'p95', color: '#1d4ed8', values: [1, 2, 3] }]}
          timesMs={[0, 700, 1_500]}
          durationMs={1_500}
          unit="ms"
          cursorMs={500}
        />
      </>,
    );

    const readouts = screen.getAllByTestId('chart-readout');
    expect(readouts[0]).toHaveTextContent('0.5 s');
    expect(readouts[0]).toHaveTextContent('offered: 20');
    // 500 ms is not a sample of the second chart; it snaps to 700 ms.
    expect(readouts[1]).toHaveTextContent('0.7 s');
    expect(readouts[1]).toHaveTextContent('p95: 2');
  });

  it('keeps the cursor null when the chart has no measured samples', () => {
    const onCursorChange = vi.fn();
    render(
      <SeriesChart
        title="Resources"
        series={[]}
        timesMs={[]}
        durationMs={1_000}
        unit="%"
        onCursorChange={onCursorChange}
      />,
    );
    const svg = screen.getByRole('img', { name: /Resources/ });
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 340,
      height: 132,
      right: 340,
      bottom: 132,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.pointerMove(svg, { clientX: 180 });
    expect(onCursorChange).toHaveBeenCalledWith(null);
    expect(screen.queryByTestId('chart-readout')).not.toBeInTheDocument();
  });

  it('renders a zero-duration timeline without invalid coordinates', () => {
    const { container } = render(
      <SeriesChart
        title="Queue"
        series={[{ label: 'waiting', color: '#b45309', values: [3] }]}
        timesMs={[0]}
        durationMs={0}
        unit="requests"
      />,
    );
    const paths = Array.from(container.querySelectorAll('path')).map((path) =>
      path.getAttribute('d'),
    );
    expect(paths.join(' ')).not.toContain('NaN');
  });
});
