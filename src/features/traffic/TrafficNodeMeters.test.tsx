import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { TrafficNode } from '../../simulation/traffic-telemetry';
import { TrafficNodeMeters } from './TrafficNodeMeters';

const activeNode: TrafficNode = {
  nodeId: 'app-1',
  resources: [
    {
      key: 'cpu',
      label: 'CPU',
      used: 1,
      capacity: 4,
      unit: 'cores',
      aggregation: 'window-average',
    },
    {
      key: 'egress',
      label: 'Net',
      used: 3,
      capacity: null,
      unit: 'gbit/s',
      aggregation: 'window-average',
    },
  ],
  requestsPerSecond: 25,
  queue: 0,
  down: false,
};

describe('TrafficNodeMeters', () => {
  it('renders neutral dashed placeholders before data, never a fake zero', () => {
    const { container } = render(
      <TrafficNodeMeters
        levelId="parcel-pulse"
        kind="app"
        node={null}
        modeLabel="No live sample"
        sampleActive={false}
        animate={false}
        showPlaceholder
      />,
    );
    expect(screen.getByText('CPU')).toBeVisible();
    expect(screen.getByText('IO')).toBeVisible();
    expect(screen.getByText('Net')).toBeVisible();
    expect(screen.getAllByText('—')).toHaveLength(3);
    expect(screen.queryByText('0%')).toBeNull();
    expect(
      container.querySelector('[data-traffic-state="unknown"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-traffic-placeholder="true"]'),
    ).not.toBeNull();
  });

  it('shows live dispatch activity and aggregation-aware accessibility text', () => {
    const { container } = render(
      <TrafficNodeMeters
        levelId="parcel-pulse"
        kind="app"
        node={activeNode}
        modeLabel="Live · Year 1 · t=1.0 s"
        sampleActive
        animate
        showPlaceholder={false}
      />,
    );
    expect(screen.getByText('25 req/s')).toBeVisible();
    expect(screen.getByText('Live · Year 1 · t=1.0 s')).toBeVisible();
    expect(
      container.querySelector('[data-traffic-state="active"]'),
    ).not.toBeNull();
    const cpuMeter = screen.getByRole('meter', { name: /CPU utilization/i });
    expect(cpuMeter).toHaveAttribute('aria-valuenow', '1');
    expect(cpuMeter.getAttribute('aria-valuetext')).toContain(
      'Sampled as an interval average',
    );

    // A resource without finite capacity is not presented as a 0–100 meter.
    const net = screen.getByRole('img', { name: /Net utilization/i });
    expect(net).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByText('3.00 Gbit/s')).toBeVisible();
    expect(screen.queryByText('75%')).toBeNull();
  });

  it('marks a down node without rendering motion', () => {
    const { container } = render(
      <TrafficNodeMeters
        levelId="parcel-pulse"
        kind="app"
        node={{ ...activeNode, down: true, requestsPerSecond: 0 }}
        modeLabel="Live · Year 1 · t=1.0 s"
        sampleActive
        animate={false}
        showPlaceholder={false}
      />,
    );
    expect(screen.getByText('Down')).toBeVisible();
    expect(container.querySelector('.is-animated')).toBeNull();
  });
});
