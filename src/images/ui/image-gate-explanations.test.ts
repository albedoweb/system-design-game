import { describe, expect, it } from 'vitest';

import type {
  ImageCheck,
  ImageScenarioName,
  ImageScenarioResult,
} from '../contracts';
import { imageEvaluationFixture } from './image-evaluation.fixture';
import { formatCheckNumber } from './image-format';
import {
  imageGateExplanation,
  imageGateExplanationMap,
} from './image-gate-explanations';

function scenarioNamed(name: ImageScenarioName): ImageScenarioResult {
  const found = imageEvaluationFixture.scenarios.find(
    (scenario) => scenario.name === name,
  );
  if (!found) {
    throw new Error(`missing fixture scenario ${name}`);
  }
  return structuredClone(found);
}

function gate(overrides: Partial<ImageCheck>): ImageCheck {
  return {
    id: 'p999:upload',
    label: 'upload p99.9',
    passed: false,
    severity: 'required',
    message: 'The gate failed.',
    operation: 'upload',
    unit: 'ms',
    ...overrides,
  };
}

function withChecks(
  scenario: ImageScenarioResult,
  checks: ImageCheck[],
): ImageScenarioResult {
  return { ...scenario, checks };
}

describe('Image Atlas guided gate explanations', () => {
  it('offers queue wait as one possible cause for a slow success, without proving IO', () => {
    const base = scenarioNamed('normal');
    const metadata = base.nodes.find((node) => node.kind === 'metadata');
    expect(metadata).toBeDefined();
    const upload = {
      ...base.operations.upload,
      counts: {
        ...base.operations.upload.counts,
        offered: 12_000,
        completed: 12_000,
        onTime: 0,
        success: 12_000,
        failed: 0,
        rejected: 0,
      },
      availability: 1,
      latencyP999Ms: 3_223,
      latencyP99Ms: 2_900,
      latencyP95Ms: 2_400,
      sampleCount: 12_000,
      p999SampleCount: 12_000,
      p999Reliable: true,
      // The engine stores the first nonzero started-stage wait here, not total
      // queue time; the reported case had no operation wait but a node wait.
      queueWaitP95Ms: 0,
      errorsByCode: {},
    };
    const scenario = withChecks(
      {
        ...base,
        operations: { ...base.operations, upload },
        nodes: base.nodes.map((node) =>
          node.nodeId === metadata!.nodeId
            ? {
                ...node,
                ioUtilizationAvg: 0.36,
                ioUtilizationPeak: 1,
                cpuUtilizationAvg: 0.18,
                cpuUtilizationPeak: 0.2,
                memoryBytesAvg: 32e9,
                memoryBytesPeak: 32e9,
                memoryLimitBytes: 88e9,
                queueWaitP95Ms: 1_000,
              }
            : node,
        ),
        links: base.links.map((link) => ({
          ...link,
          peakUtilization: 0.4,
          queueWaitP95Ms: 0,
        })),
      },
      [gate({ actual: 3_223, limit: 1_000, sampleCount: 12_000 })],
    );

    const explanation = imageGateExplanation(scenario, scenario.checks[0]!);
    expect(explanation).not.toBeNull();
    expect(explanation!.possibleCauses).toHaveLength(1);
    expect(explanation!.possibleCauses[0]!.cause).toMatch(/queue wait/i);
    expect(explanation!.possibleCauses[0]!.cause).toContain(metadata!.label);
    expect(explanation!.possibleCauses[0]!.detail).toContain('could');
    expect(explanation!.possibleCauses[0]!.detail).not.toMatch(
      /proves|definitely caused/,
    );

    expect(explanation!.evidence).toHaveLength(2);
    const evidence = explanation!.evidence.join(' ');
    expect(evidence).toContain('3.2 s');
    expect(evidence).toContain('1 s SLO');
    expect(evidence).toContain('5 s request deadline');
    expect(evidence).toContain('must not be subtracted');
    expect(evidence).toContain('shared across operations');
    expect(evidence).toContain('excludes background replication');
    expect(evidence).not.toContain('cumulative');
    expect(evidence).toContain('I/O average 36% and peak 100%');
    expect(evidence).toContain('CPU average 18%');
    expect(evidence).toContain('32 GB of 88 GB');
    expect(evidence).toContain('not proof');
    expect(explanation!.checkNext).toHaveLength(2);
  });

  it('ranks the two strongest availability codes and never sums node errors', () => {
    const base = scenarioNamed('region-na-failure');
    const upload = {
      ...base.operations.upload,
      availability: 0.8887116246981718,
      counts: {
        ...base.operations.upload.counts,
        offered: 69_576,
        success: 61_833,
        failed: 7_743,
      },
      errorsByCode: {
        metadata_quorum_unavailable: 28,
        no_healthy_route: 7_707,
        task_interrupted: 8,
      },
      queueWaitP95Ms: 0,
    };
    const errorNodes = base.nodes.map((node, index) => ({
      ...node,
      errors: index === 0 ? 31_140 : index === 1 ? 128 : 0,
    }));
    const scenario = withChecks(
      {
        ...base,
        operations: { ...base.operations, upload },
        nodes: errorNodes,
      },
      [
        gate({
          id: 'availability:upload',
          label: 'upload availability',
          unit: 'ratio',
          actual: upload.availability,
          limit: 0.98,
          sampleCount: 69_576,
        }),
      ],
    );

    const explanation = imageGateExplanation(scenario, scenario.checks[0]!)!;
    expect(explanation.possibleCauses).toHaveLength(2);
    expect(explanation.possibleCauses.map((item) => item.cause)).toEqual([
      'No healthy route',
      'Metadata quorum unavailable',
    ]);
    const evidence = explanation.evidence.join(' ');
    expect(evidence).toContain('no_healthy_route 7,707');
    expect(evidence).toContain('metadata_quorum_unavailable 28');
    expect(evidence).toContain('largest node-attributed error count is 31,140');
    expect(evidence).toContain('raw node outcomes by final route');
    expect(evidence).toContain('not operation totals or local root causes');
    // The two node rows are not added into a misleading 31,268 total.
    expect(evidence).not.toContain('31,268');
    expect(explanation.evidence).toHaveLength(2);
    expect(explanation.checkNext).toHaveLength(2);
  });

  it('treats an under-sampled p99.9 as a sampling failure, not a latency verdict', () => {
    const base = scenarioNamed('normal');
    const upload = {
      ...base.operations.upload,
      counts: { ...base.operations.upload.counts, success: 500, failed: 0 },
      availability: 1,
      latencyP999Ms: 4_000,
      sampleCount: 500,
      p999SampleCount: 500,
      p999Reliable: false,
      queueWaitP95Ms: 3_000,
      errorsByCode: {},
    };
    const scenario = withChecks(
      { ...base, operations: { ...base.operations, upload } },
      [gate({ actual: 4_000, limit: 1_000, sampleCount: 500 })],
    );

    const explanation = imageGateExplanation(scenario, scenario.checks[0]!)!;
    expect(explanation.possibleCauses).toHaveLength(1);
    expect(explanation.possibleCauses[0]!.cause).toBe(
      'Insufficient p99.9 samples',
    );
    expect(explanation.possibleCauses[0]!.detail).toContain(
      'sampling limitation',
    );
    const evidence = explanation.evidence.join(' ');
    expect(evidence).toContain('500 of 10,000 required successful samples');
    expect(evidence).not.toContain('must not be subtracted');
    expect(explanation.checkNext[0]).toContain('do not add capacity');
  });

  it('does not turn an isolated IO peak into a cause', () => {
    const base = scenarioNamed('normal');
    const metadata = base.nodes.find((node) => node.kind === 'metadata')!;
    const upload = {
      ...base.operations.upload,
      counts: { ...base.operations.upload.counts, success: 12_000, failed: 0 },
      availability: 1,
      latencyP999Ms: 2_200,
      sampleCount: 12_000,
      p999SampleCount: 12_000,
      p999Reliable: true,
      queueWaitP95Ms: 0,
      errorsByCode: {},
    };
    const scenario = withChecks(
      {
        ...base,
        operations: { ...base.operations, upload },
        nodes: base.nodes.map((node) =>
          node.nodeId === metadata.nodeId
            ? { ...node, ioUtilizationAvg: 0.36, ioUtilizationPeak: 1, cpuUtilizationAvg: 0.18 }
            : node,
        ),
        links: base.links.map((link) => ({
          ...link,
          peakUtilization: 0.4,
          queueWaitP95Ms: 0,
        })),
      },
      [gate({ actual: 2_200, limit: 1_000, sampleCount: 12_000 })],
    );

    const explanation = imageGateExplanation(scenario, scenario.checks[0]!)!;
    expect(explanation.possibleCauses).toEqual([]);
    const evidence = explanation.evidence.join(' ');
    expect(evidence).toContain('I/O average 36% and peak 100%');
    expect(evidence).toContain('not proof');
    expect(evidence).toContain('name a stage');
    expect(explanation.checkNext[0]).toContain('cannot identify');
    expect(explanation.checkNext[0]).toContain('instead of adding capacity');
    expect(explanation.caveat).toContain('cannot prove the exact stage');
  });

  it('keeps an isolated link peak as context, not as a possible cause', () => {
    const base = scenarioNamed('normal');
    const upload = {
      ...base.operations.upload,
      counts: { ...base.operations.upload.counts, success: 12_000, failed: 0 },
      availability: 1,
      latencyP999Ms: 2_200,
      sampleCount: 12_000,
      p999SampleCount: 12_000,
      p999Reliable: true,
      queueWaitP95Ms: 0,
      errorsByCode: {},
    };
    const scenario = withChecks(
      {
        ...base,
        operations: { ...base.operations, upload },
        nodes: base.nodes.map((node) => ({
          ...node,
          queueWaitP95Ms: 0,
          ioUtilizationPeak: 0.5,
        })),
        links: [
          {
            ...base.links[0]!,
            label: 'Saturated shared channel',
            peakUtilization: 1,
            averageUtilization: 0.4,
            queueWaitP95Ms: 0,
          },
        ],
      },
      [gate({ actual: 2_200, limit: 1_000, sampleCount: 12_000 })],
    );

    const explanation = imageGateExplanation(scenario, scenario.checks[0]!)!;
    expect(explanation.possibleCauses).toEqual([]);
    expect(explanation.possibleCauses.map((item) => item.cause)).not.toContain(
      'Shared channel saturation at Saturated shared channel',
    );
    const evidence = explanation.evidence.join(' ');
    expect(evidence).toContain('Saturated shared channel peaked at 100%');
    expect(evidence).toContain('context, not proof');
    expect(evidence).toContain('request-path signal');
    expect(explanation.checkNext[0]).toContain('cannot identify');
  });

  it('marks a small window p99.9 sample as unqualified and keeps the window scope explicit', () => {
    const base = scenarioNamed('region-na-failure');
    const upload = base.operations.upload;
    const scenario = withChecks(
      {
        ...base,
        operations: {
          ...base.operations,
          upload: { ...upload, errorsByCode: { no_healthy_route: 99_999 } },
        },
        incidentWindow: {
          ...base.incidentWindow!,
          operations: {
            ...base.incidentWindow!.operations,
            upload: {
              offered: 1_000,
              success: 600,
              availability: 0.6,
              latencyP999Ms: 900,
              sampleCount: 600,
              availabilityOk: false,
              latencyOk: false,
              passed: false,
            },
          },
        },
      },
      [
        gate({
          id: 'incident:upload',
          label: 'upload during the incident window',
          unit: 'ratio',
          actual: 0.6,
          limit: 0.98,
          sampleCount: 1_000,
        }),
      ],
    );

    const explanation = imageGateExplanation(scenario, scenario.checks[0]!)!;
    expect(explanation.possibleCauses.map((item) => item.cause)).toContain(
      'Window p99.9 is not sample-qualified',
    );
    const evidence = explanation.evidence.join(' ');
    expect(evidence).toContain('below the 10,000 needed to qualify p99.9');
    expect(evidence).toContain('sampling limitation, not proof of slowness');
    // The p99.9 line uses the incident window threshold, not the availability
    // check.limit shown in the same gate row.
    expect(explanation.evidence[1]).toContain('against the 2 s window SLO');
    expect(explanation.evidence[1]).not.toContain('98');
    expect(evidence).not.toContain('99,999');
    expect(explanation.caveat).toContain('window only');
    expect(explanation.caveat).toContain('cannot prove what happened inside');
    expect(explanation.checkNext[0]).toContain('full-case totals cannot explain a window');
  });

  it('leaves other gate families to their existing raw message', () => {
    const base = scenarioNamed('normal');
    for (const id of ['freshness', 'data_integrity', 'postlude']) {
      const check = gate({ id, label: id, operation: undefined, unit: undefined });
      expect(imageGateExplanation({ ...base, checks: [check] }, check)).toBeNull();
    }
  });

  it('maps explanations by check id for the panel', () => {
    const base = scenarioNamed('normal');
    const scenario = withChecks(base, [
      gate({ actual: 2_000, limit: 1_000, sampleCount: 12_000 }),
    ]);
    const map = imageGateExplanationMap(scenario);
    expect([...map.keys()]).toEqual(['p999:upload']);
  });

  it('formats ratio gates as two-decimal percentages', () => {
    expect(formatCheckNumber(0.9933, 'ratio')).toBe('99.33%');
    expect(formatCheckNumber(0.995, 'ratio')).toBe('99.50%');
    expect(formatCheckNumber(1, 'ratio')).toBe('100.00%');
  });
});
