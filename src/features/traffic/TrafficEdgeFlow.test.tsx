import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TrafficEdgeFlow, TrafficEdgeRateBadge } from './TrafficEdgeFlow';
import type { TrafficEdgeView } from './traffic-ui';

function view(overrides: Partial<TrafficEdgeView> = {}): TrafficEdgeView {
  return {
    requestsPerSecond: 42,
    bytesPerSecond: null,
    active: true,
    animate: true,
    reducedMotion: false,
    modeLabel: 'Live · Year 1 · t=1.0 s',
    title: 'Live logical dispatches',
    ...overrides,
  };
}

describe('traffic edge visuals', () => {
  it('renders direction-preserving motion only while playing', () => {
    const { container, rerender } = render(
      <svg>
        <TrafficEdgeFlow path="M 0,0 L 100,0" color="#0e7490" view={view()} />
      </svg>,
    );
    expect(
      container.querySelector('[data-traffic-motion="animated"]'),
    ).not.toBeNull();
    expect(container.querySelectorAll('circle').length).toBeGreaterThan(0);

    rerender(
      <svg>
        <TrafficEdgeFlow
          path="M 0,0 L 100,0"
          color="#0e7490"
          view={view({ animate: false, reducedMotion: true })}
        />
      </svg>,
    );
    expect(
      container.querySelector('[data-traffic-motion="animated"]'),
    ).toBeNull();
  });

  it('keeps a static rate indicator as the reduced-motion fallback', () => {
    render(
      <button type="button">
        traffic
        <TrafficEdgeRateBadge
          view={view({ animate: false, reducedMotion: true })}
        />
      </button>,
    );
    const badge = screen.getByText('42/s');
    expect(badge).toBeVisible();
    expect(badge.closest('[data-traffic-static="true"]')).not.toBeNull();
  });

  it('renders nothing for idle edges', () => {
    const { container } = render(
      <svg>
        <TrafficEdgeFlow
          path="M 0,0 L 100,0"
          color="#0e7490"
          view={view({ active: false })}
        />
      </svg>,
    );
    expect(container.querySelector('circle')).toBeNull();
    const badge = render(
      <TrafficEdgeRateBadge view={view({ active: false })} />,
    );
    expect(badge.container.firstChild).toBeNull();
  });
});
