import { describe, expect, it } from 'vitest';

import type {
  ImageCheck,
  ImageDiagnostic,
  ImageEvaluation,
  ImageGraph,
} from '../contracts';
import { createImageGraph, imageGraphDigest } from '../graph';
import {
  imageMeterMetric,
  imageProblemMaps,
  imageResultStale,
  imageUniqueIssues,
} from './image-diagnostics';

const graph = createImageGraph();

function check(overrides: Partial<ImageCheck>): ImageCheck {
  return {
    id: 'gate',
    label: 'Gate',
    passed: false,
    severity: 'required',
    message: 'The gate failed.',
    ...overrides,
  };
}

function diagnostic(overrides: Partial<ImageDiagnostic>): ImageDiagnostic {
  return {
    id: 'diag',
    severity: 'warning',
    code: 'pressure',
    message: 'Something happened.',
    ...overrides,
  };
}

function evaluation(overrides: Partial<ImageEvaluation>): ImageEvaluation {
  return {
    status: 'complete',
    passed: false,
    meta: {
      schemaVersion: 1,
      modelVersion: '1.0.0',
      contentVersion: '1.0.0',
      pricingVersion: 'image-atlas-catalog-v1',
      levelId: 'image-atlas',
      seed: 101,
      graphDigest: 'digest',
      requestedScenarios: ['normal'],
      requiredScenarios: [
        'normal',
        'peak',
        'node-failure',
        'link-failure',
        'region-na-failure',
        'region-eu-failure',
        'region-ap-failure',
      ],
      qualification: false,
      evaluationKind: 'exploratory',
      datasetDay: 30,
    },
    issues: [],
    diagnostics: [],
    checks: [],
    capacity: null,
    cost: null,
    assumptions: [],
    scenarios: [],
    ...overrides,
  } as unknown as ImageEvaluation;
}

describe('Image Atlas meter reasons', () => {
  it('links known engine metric names to a visible node meter', () => {
    expect(imageMeterMetric('cpu')).toBe('cpu');
    expect(imageMeterMetric('CPU utilization')).toBe('cpu');
    expect(imageMeterMetric('memory-bytes')).toBe('ram');
    expect(imageMeterMetric('iops')).toBe('io');
    expect(imageMeterMetric('nic')).toBe('network');
    expect(imageMeterMetric('disk-capacity')).toBe('capacity');
    expect(imageMeterMetric('latency-p999')).toBeNull();
    expect(imageMeterMetric(undefined)).toBeNull();
  });

  it('attaches a failed check and its metric reason to a node and its region', () => {
    const maps = imageProblemMaps({
      graph,
      issues: [],
      evaluation: evaluation({
        checks: [
          check({
            nodeId: 'app-na',
            metric: 'cpu',
            message: 'app-na is CPU bound.',
          }),
        ],
      }),
      scenario: 'normal',
    });
    const problem = maps.byNode.get('app-na');
    expect(problem?.severity).toBe('error');
    expect(problem?.messages).toEqual(['app-na is CPU bound.']);
    expect(problem?.byMetric.cpu).toEqual(['app-na is CPU bound.']);
    expect(maps.byRegion.get('na')?.severity).toBe('error');
  });

  it('treats an advisory failure as a warning and keeps unknown metrics explicit', () => {
    const maps = imageProblemMaps({
      graph,
      issues: [],
      evaluation: evaluation({
        diagnostics: [
          diagnostic({
            nodeId: 'metadata-na',
            metric: 'kafka-lag',
            severity: 'info',
            message: 'Unexplained metric.',
          }),
        ],
      }),
      scenario: 'normal',
    });
    expect(maps.byNode.get('metadata-na')?.severity).toBe('info');
    expect(maps.byNode.get('metadata-na')?.byMetric).toEqual({});
  });

  it('only highlights the selected scenario of a completed run', () => {
    const peakCheck = check({
      nodeId: 'app-eu',
      metric: 'network',
      message: 'Peak link saturation.',
    });
    const maps = imageProblemMaps({
      graph,
      issues: [],
      evaluation: evaluation({
        scenarios: [
          {
            name: 'peak',
            checks: [peakCheck],
            diagnostics: [],
          },
        ] as never,
      }),
      scenario: 'normal',
    });
    expect(maps.byNode.get('app-eu')).toBeUndefined();

    const peakMaps = imageProblemMaps({
      graph,
      issues: [],
      evaluation: evaluation({
        scenarios: [
          {
            name: 'peak',
            checks: [peakCheck],
            diagnostics: [],
          },
        ] as never,
      }),
      scenario: 'peak',
    });
    expect(peakMaps.byNode.get('app-eu')?.byMetric.network).toEqual([
      'Peak link saturation.',
    ]);
  });

  it('routes validation issues to nodes, edges and regions', () => {
    const maps = imageProblemMaps({
      graph,
      issues: [
        {
          severity: 'error',
          code: 'cache_provider_count',
          message: 'Cache needs one provider.',
          nodeId: 'client-ap',
        },
        {
          severity: 'warning',
          code: 'duplicate_edge',
          message: 'Duplicate route.',
          edgeId: graph.edges[0]!.id,
        },
      ],
      evaluation: null,
      scenario: null,
    });
    expect(maps.byNode.get('client-ap')?.severity).toBe('error');
    expect(maps.byEdge.get(graph.edges[0]!.id)?.severity).toBe('warning');
    expect(maps.byRegion.get('ap')?.severity).toBe('error');
  });

  it('de-duplicates repeated issues without dropping distinct ones', () => {
    const issue = {
      severity: 'warning' as const,
      code: 'metadata_unused',
      message: 'Unused store.',
      nodeId: 'metadata-na',
    };
    expect(imageUniqueIssues([issue, { ...issue }])).toHaveLength(1);
    expect(
      imageUniqueIssues([issue, { ...issue, message: 'Another message.' }]),
    ).toHaveLength(2);
  });
});

describe('Image Atlas result staleness', () => {
  const result = evaluation({});
  const digest = imageGraphDigest(graph);

  it('is not stale without a result or without a recorded digest', () => {
    expect(imageResultStale(null, null, null, graph, 101)).toBe(false);
    expect(imageResultStale(result, null, null, graph, 101)).toBe(false);
  });

  it('is current for the same seed and semantic graph', () => {
    expect(imageResultStale(result, digest, 101, graph, 101)).toBe(false);
  });

  it('becomes stale when the seed or a semantic setting changes', () => {
    expect(imageResultStale(result, digest, 101, graph, 211)).toBe(true);
    expect(imageResultStale(result, 'other-digest', 101, graph, 101)).toBe(true);
    const rebalanced: ImageGraph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === 'app-na'
          ? { ...node, config: { ...node.config, instances: 3 } }
          : node,
      ),
    } as ImageGraph;
    expect(imageResultStale(result, digest, 101, rebalanced, 101)).toBe(true);
  });

  it('ignores position-only edits because they are not semantic', () => {
    const moved: ImageGraph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === 'app-na'
          ? { ...node, position: { x: node.position.x + 40, y: node.position.y + 20 } }
          : node,
      ),
    };
    expect(imageResultStale(result, digest, 101, moved, 101)).toBe(false);
  });
});
