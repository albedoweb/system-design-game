/**
 * GC-PF2 focused regressions: mobility ACK-relative reads are scheduled from
 * the ACTUAL source Add1 ACK delivery, never from the round start.
 *
 * Challenge metadata marks the mobility `ack-read` step `ack-relative` with a
 * frozen missing-ACK fallback of round+1000ms+delay. The model used to insert
 * the step at round+delay (before the ~22 ms ACK), so the prerequisite check
 * failed the read before its source edit was even acknowledged. Every
 * expectation is observed through an actual `CartCaseModel` run.
 */
import { describe, expect, it } from 'vitest';

import { CART_LEVEL_ID, CART_VERSIONS, type CartGraph } from '../index';
import { CartCaseModel, analyzeCartTopology } from '../core/model';
import { buildCartProbes, type CartProbe, type CartProbeStep } from '../core/challenges';

interface GraphOptions {
  /** Remove the us-west write path so the source edit can never be ACKed. */
  readonly noUsWritePath?: boolean;
}

function cartGraph(options: GraphOptions = {}): CartGraph {
  const customers = (region: string, x: number): Record<string, unknown> => ({
    id: `customers-${region}`,
    kind: 'customers',
    region,
    position: { x, y: 40 },
  });
  const app = (region: string, x: number, writeTarget: string): Record<string, unknown> => ({
    id: `app-${region}`,
    kind: 'application',
    region,
    position: { x, y: 200 },
    size: 'S',
    instances: 1,
    writeTarget,
    readPolicy: 'local-repair',
    readTargets: ['journal-us-west', 'journal-eu-central', 'journal-ap-northeast'],
  });
  const nodes: Record<string, unknown>[] = [
    customers('us-west', 40),
    customers('eu-central', 440),
    customers('ap-northeast', 840),
    app('us-west', 80, 'journal-us-west'),
    app('eu-central', 480, 'journal-eu-central'),
    app('ap-northeast', 880, 'journal-ap-northeast'),
    { id: 'journal-us-west', kind: 'journal', region: 'us-west', position: { x: 80, y: 340 }, size: 'S' },
    { id: 'journal-eu-central', kind: 'journal', region: 'eu-central', position: { x: 480, y: 340 }, size: 'M' },
    { id: 'journal-ap-northeast', kind: 'journal', region: 'ap-northeast', position: { x: 880, y: 340 }, size: 'S' },
    { id: 'inventory-us-west', kind: 'inventory', region: 'us-west', position: { x: 240, y: 480 }, size: 'M' },
  ];
  const edges: Record<string, unknown>[] = [
    { id: 'src-us', from: 'customers-us-west', to: 'app-us-west', kind: 'request' },
    { id: 'src-eu', from: 'customers-eu-central', to: 'app-eu-central', kind: 'request' },
    { id: 'src-ap', from: 'customers-ap-northeast', to: 'app-ap-northeast', kind: 'request' },
    { id: 'write-us', from: 'app-us-west', to: 'journal-us-west', kind: 'request' },
    { id: 'write-eu', from: 'app-eu-central', to: 'journal-eu-central', kind: 'request' },
    { id: 'write-ap', from: 'app-ap-northeast', to: 'journal-ap-northeast', kind: 'request' },
    { id: 'inv-us', from: 'app-us-west', to: 'inventory-us-west', kind: 'request' },
    { id: 'inv-eu', from: 'app-eu-central', to: 'inventory-us-west', kind: 'request' },
    { id: 'inv-ap', from: 'app-ap-northeast', to: 'inventory-us-west', kind: 'request' },
  ];
  const circuits: Record<string, unknown>[] = [
    { regions: ['us-west', 'eu-central'], mbps: 8 },
    { regions: ['us-west', 'ap-northeast'], mbps: 32 },
    { regions: ['eu-central', 'ap-northeast'], mbps: 8 },
  ];
  return {
    levelId: CART_LEVEL_ID,
    graphVersion: CART_VERSIONS.graph,
    contentVersion: CART_VERSIONS.content,
    seed: 1729,
    nodes,
    edges: options.noUsWritePath === true ? edges.filter((edge) => edge.id !== 'write-us') : edges,
    circuits,
  } as unknown as CartGraph;
}

const SOURCE = 'us-west';
const DESTINATION = 'eu-central';
const ROUND_US = 20_000_000;

function mobilityProbe(delayMs: number): CartProbe {
  const probe = buildCartProbes().probes.find(
    (entry) => entry.id === `probe:mobility:20000:${SOURCE}-${DESTINATION}:${delayMs}`,
  );
  if (probe === undefined) throw new Error('mobility probe missing');
  return probe;
}

function stepOf(probe: CartProbe, part: string): CartProbeStep {
  const found = probe.steps.find((entry) => entry.id.endsWith(`:${part}`));
  if (found === undefined) throw new Error(`step ${part} missing`);
  return found;
}

function run(probes: readonly CartProbe[], graph: CartGraph = cartGraph()): CartCaseModel {
  const model = new CartCaseModel('mobility', analyzeCartTopology(graph), [], probes, graph);
  model.run();
  return model;
}

function record(model: CartCaseModel, id: string) {
  return model.requestRecords.find((entry) => entry.id === id);
}

describe('mobility ACK-relative read scheduling', () => {
  it.each([10, 2_000])(
    'offers the delay=%i ms read at the actual source ACK + delay with a 500 ms deadline',
    (delayMs) => {
      const probe = mobilityProbe(delayMs);
      const model = run([probe]);
      const readStep = stepOf(probe, 'ack-read');
      const edit = record(model, stepOf(probe, 'source-add-1').id);
      const read = record(model, readStep.id);
      expect(edit?.acknowledged).toBe(true);
      const ackUs = edit?.deliveredUs ?? 0;
      // The ACK is a real delivery after the round start, before the edit deadline.
      expect(ackUs).toBeGreaterThan(ROUND_US);
      expect(ackUs).toBeLessThan(ROUND_US + 1_000_000);
      expect(read?.offeredUs).toBe(ackUs + delayMs * 1_000);
      expect(read?.deadlineUs).toBe(ackUs + delayMs * 1_000 + 500_000);
      // The prerequisite was met: the read really ran.
      expect(read?.dependencyFailed).toBe(false);
      expect(read?.outcome).not.toBe('dependency-failed');
      // Exactly one terminal record per scheduled step: no duplicate offers.
      expect(model.requestRecords.filter((entry) => entry.id === readStep.id)).toHaveLength(1);
      expect(model.requestRecords.filter((entry) => entry.id.startsWith(probe.id))).toHaveLength(
        probe.steps.length,
      );
    },
  );

  it('keeps fixed-time (scheduled) steps at their frozen offers', () => {
    const probe = mobilityProbe(10);
    const model = run([probe]);
    for (const part of ['source-add', 'stale-view', 'source-add-1']) {
      const step = stepOf(probe, part);
      expect(record(model, step.id)?.offeredUs).toBe(step.atUs);
    }
  });

  it('runs two probes sharing one round deterministically with one offer each', () => {
    const probes = [mobilityProbe(10), mobilityProbe(2_000)];
    const first = run(probes);
    const second = run(probes);
    expect(second.requestRecords).toEqual(first.requestRecords);
    const total = probes.reduce((sum, probe) => sum + probe.steps.length, 0);
    expect(first.requestRecords.filter((entry) => entry.operation === 'probe')).toHaveLength(total);
  });

  it('uses the frozen round+1000ms+delay fallback and records a dependent failure when the ACK never arrives', () => {
    const probes = [mobilityProbe(10), mobilityProbe(2_000)];
    const model = run(probes, cartGraph({ noUsWritePath: true }));
    for (const probe of probes) {
      const edit = record(model, stepOf(probe, 'source-add-1').id);
      expect(edit?.acknowledged).toBe(false);
      const readStep = stepOf(probe, 'ack-read');
      expect(readStep.fallbackAtUs).not.toBeNull();
      const read = record(model, readStep.id);
      expect(read?.offeredUs).toBe(readStep.fallbackAtUs);
      expect(read?.deadlineUs).toBe((readStep.fallbackAtUs ?? 0) + 500_000);
      expect(read?.dependencyFailed).toBe(true);
      expect(read?.outcome).toBe('dependency-failed');
      expect(model.requestRecords.filter((entry) => entry.id === readStep.id)).toHaveLength(1);
      expect(model.requestRecords.filter((entry) => entry.id.startsWith(probe.id))).toHaveLength(
        probe.steps.length,
      );
    }
  });
});
