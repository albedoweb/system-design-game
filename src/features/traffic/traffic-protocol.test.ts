import { describe, expect, it } from 'vitest';

import type { TrafficFrame, TrafficMessage } from '../../simulation/traffic-telemetry';
import {
  isTrafficMessageFor,
  parseTrafficMessage,
} from './traffic-protocol';

function validFrame(overrides: Partial<TrafficFrame> = {}): TrafficFrame {
  return {
    levelId: 'image-atlas',
    scopeId: 'normal',
    scopeLabel: 'Normal',
    timeMs: 1_000,
    windowMs: 1_000,
    phase: 'measured',
    nodes: [
      {
        nodeId: 'app-na',
        resources: [
          {
            key: 'ram',
            label: 'RAM',
            used: 22_000_000_000,
            capacity: 22_000_000_000,
            unit: 'bytes',
            aggregation: 'instant',
          },
          {
            key: 'cpu',
            label: 'CPU',
            used: 0.4,
            capacity: 1,
            unit: 'cores',
            aggregation: 'window-average',
          },
        ],
        requestsPerSecond: 120,
        queue: 0,
        down: false,
      },
    ],
    edges: [
      {
        edgeId: 'route-1',
        requestsPerSecond: 120,
        bytesPerSecond: 12_500_000_000,
      },
    ],
    ...overrides,
  };
}

function validMessage(overrides: Partial<TrafficMessage> = {}): TrafficMessage {
  return {
    type: 'traffic',
    runId: 'run-1',
    frame: validFrame(),
    ...overrides,
  };
}

describe('traffic message boundary', () => {
  it('accepts large legitimate RAM and byte rates', () => {
    const message = parseTrafficMessage(
      validMessage(),
      'image-atlas',
      'run-1',
    );
    expect(message).not.toBeNull();
    expect(message?.frame.nodes[0]?.resources[0]?.used).toBe(22_000_000_000);
    expect(message?.frame.edges[0]?.bytesPerSecond).toBe(12_500_000_000);
  });

  it('checks level, run id and core frame shape', () => {
    expect(
      isTrafficMessageFor(validMessage(), 'parcel-pulse', 'run-1'),
    ).toBe(false);
    expect(
      isTrafficMessageFor(validMessage(), 'image-atlas', 'run-2'),
    ).toBe(false);
    expect(
      isTrafficMessageFor(
        validMessage({
          frame: { ...validFrame(), nodes: undefined } as unknown as TrafficFrame,
        }),
        'image-atlas',
        'run-1',
      ),
    ).toBe(false);
    expect(
      isTrafficMessageFor(
        validMessage({
          frame: { ...validFrame(), timeMs: Number.NaN },
        }),
        'image-atlas',
        'run-1',
      ),
    ).toBe(false);
  });

  it('accepts Live Scoreboard frames for their own run only', () => {
    const liveFrame = {
      ...validFrame(),
      levelId: 'live-scoreboard',
      scopeId: 'live-measured',
      scopeLabel: 'Live measured',
      nodes: [
        {
          nodeId: 'sql-1',
          resources: [
            {
              key: 'queue',
              label: 'Queue',
              used: 128,
              capacity: 128,
              unit: 'slots',
              aggregation: 'instant',
            },
          ],
          requestsPerSecond: 200,
          queue: 128,
          down: false,
        },
      ],
      edges: [
        {
          edgeId: 'link-1',
          requestsPerSecond: 200,
          bytesPerSecond: 819_200,
        },
      ],
    } as unknown as TrafficFrame;
    expect(
      isTrafficMessageFor(
        { type: 'traffic', runId: 'scoreboard-run-1', frame: liveFrame },
        'live-scoreboard',
        'scoreboard-run-1',
      ),
    ).toBe(true);
    expect(
      isTrafficMessageFor(
        { type: 'traffic', runId: 'scoreboard-run-2', frame: liveFrame },
        'live-scoreboard',
        'scoreboard-run-1',
      ),
    ).toBe(false);
    expect(
      isTrafficMessageFor(
        { type: 'traffic', runId: 'scoreboard-run-1', frame: liveFrame },
        'parcel-pulse',
        'scoreboard-run-1',
      ),
    ).toBe(false);
  });

  it('rejects negative rates and malformed resources without throwing', () => {
    expect(
      isTrafficMessageFor(
        validMessage({
          frame: {
            ...validFrame(),
            edges: [
              {
                edgeId: 'route-1',
                requestsPerSecond: -1,
                bytesPerSecond: null,
              },
            ],
          },
        }),
        'image-atlas',
        'run-1',
      ),
    ).toBe(false);
    expect(
      isTrafficMessageFor(
        validMessage({
          frame: {
            ...validFrame(),
            nodes: [
              {
                ...validFrame().nodes[0]!,
                resources: [{ key: 'cpu' }] as never,
              },
            ],
          },
        }),
        'image-atlas',
        'run-1',
      ),
    ).toBe(false);
    expect(
      isTrafficMessageFor({ type: 'traffic', runId: 'run-1' }, 'image-atlas', 'run-1'),
    ).toBe(false);
  });
});
