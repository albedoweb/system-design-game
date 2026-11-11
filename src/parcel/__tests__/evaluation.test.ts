import { describe, expect, it } from 'vitest';
import {
  PARCEL_CATALOG,
  PARCEL_LEVEL,
  evaluateParcel,
  generateParcelTrace,
  parseParcelGraph,
  type ParcelEvaluation,
} from '../index';
import {
  FAMILY_FIXTURES,
  HOLDOUT_SEEDS,
  TRAINING_SEEDS,
  fixture,
} from './helpers';

const ALL_SEEDS = [...TRAINING_SEEDS, ...HOLDOUT_SEEDS];

function evaluateFixture(name: string, seed = 101, horizons?: (1 | 5)[]) {
  return evaluateParcel(fixture(name), {
    seed,
    ...(horizons === undefined ? {} : { horizons }),
  });
}

function expectOk(result: ParcelEvaluation) {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') {
    throw new Error(`evaluation was ${result.status}`);
  }
  return result;
}

describe('Parcel evaluator', () => {
  it(
    'passes all three distinct families on training and holdout seeds',
    () => {
      for (const name of FAMILY_FIXTURES) {
        for (const seed of ALL_SEEDS) {
          const result = expectOk(evaluateFixture(name, seed));
          const failed = result.horizons
            .flatMap((horizon) =>
              horizon.checks
                .filter((check) => check.severity === 'required' && !check.passed)
                .map((check) => `${horizon.horizonYears}:${check.id}`),
            )
            .concat(
              result.checks
                .filter((check) => check.severity === 'required' && !check.passed)
                .map((check) => check.id),
            );
          expect(failed, `${name} seed ${seed}`).toEqual([]);
          expect(result.passed, `${name} seed ${seed}`).toBe(true);
        }
      }
    },
    120_000,
  );

  it(
    'offers exactly the frozen trace counts and never drops an arrival',
    () => {
      const trace = generateParcelTrace(101);
      const result = expectOk(evaluateFixture('family-kv-rollups', 101));
      for (const horizon of result.horizons) {
        expect(horizon.operations.status.counts.offered).toBe(
          trace.counts.status,
        );
        expect(horizon.operations.history.counts.offered).toBe(
          trace.counts.history,
        );
        expect(horizon.operations.ingest.counts.offered).toBe(
          trace.counts.ingest,
        );
        expect(horizon.operations.report.counts.offered).toBe(
          trace.counts.report,
        );
        expect(horizon.workload.sampleFactor).toBe(1);
        expect(horizon.workload.processedEvents).toBeGreaterThan(
          horizon.workload.sampledRequests,
        );
      }
    },
    60_000,
  );

  it(
    'is deterministic for the same graph and seed',
    () => {
      const first = expectOk(evaluateFixture('family-hybrid-analytics', 307));
      const second = expectOk(evaluateFixture('family-hybrid-analytics', 307));
      expect(second.meta.graphDigest).toBe(first.meta.graphDigest);
      expect(JSON.stringify(second.horizons)).toBe(
        JSON.stringify(first.horizons),
      );
    },
    60_000,
  );

  it(
    'separates the p95 target from the request deadline and exposes the cost frontier',
    () => {
      expect(PARCEL_LEVEL.slo.deadlineMs.status).toBeGreaterThan(
        PARCEL_LEVEL.slo.p95Ms.status,
      );
      const result = expectOk(evaluateFixture('fail-small-hardware'));
      expect(result.passed).toBe(false);
      const year5 = result.horizons.find((horizon) => horizon.horizonYears === 5);
      expect(year5).toBeDefined();
      expect(year5!.operations.status.successP95Ms).toBeGreaterThan(
        PARCEL_LEVEL.slo.p95Ms.status,
      );
      expect(
        year5!.checks.find((check) => check.id === 'p95:status')?.passed,
      ).toBe(false);
      expect(result.cost.monthlyUsd).toBeLessThan(
        PARCEL_LEVEL.budget.monthlyUsd,
      );
    },
    60_000,
  );

  it(
    'fails an overloaded replica without hiding the loss of projection data',
    () => {
      const result = expectOk(evaluateFixture('fail-freshness'));
      expect(result.passed).toBe(false);
      const year5 = result.horizons.find((horizon) => horizon.horizonYears === 5)!;
      const status = year5.operations.status;
      expect(status.counts.offered).toBeGreaterThan(0);
      expect(status.availability).toBeLessThan(PARCEL_LEVEL.slo.availability);
      const failedIds = year5.checks
        .filter((check) => !check.passed)
        .map((check) => check.id);
      expect(failedIds).toEqual(
        expect.arrayContaining(['availability:status', 'data_integrity']),
      );
      expect(year5.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'replication_queue_overflow',
      );
      const app = year5.nodes.find((node) => node.nodeId === 'app-1');
      const replica = year5.nodes.find((node) => node.nodeId === 'sql-2');
      expect(app?.rejected).toBe(0);
      expect(replica?.rejected).toBeGreaterThan(0);
      expect(replica?.operations.status?.errors).toBeGreaterThan(0);
      expect(replica?.operations.status?.timedOut).toBeGreaterThanOrEqual(0);
    },
    60_000,
  );

  it(
    'fails missing routes, capacity, index and budget cases with stable checks',
    () => {
      const missingRoute = evaluateFixture('fail-missing-route');
      expect(missingRoute.status).toBe('invalid');
      expect(missingRoute.issues.map((issue) => issue.code)).toContain(
        'missing_route',
      );

      const capacity = expectOk(evaluateFixture('fail-capacity'));
      expect(capacity.passed).toBe(false);
      expect(
        capacity.horizons.some((horizon) =>
          horizon.checks.some(
            (check) =>
              check.id === 'storage_capacity:sql-1' && !check.passed,
          ),
        ),
      ).toBe(true);

      const index = expectOk(evaluateFixture('fail-missing-index'));
      expect(index.passed).toBe(false);
      expect(
        index.horizons.some((horizon) =>
          horizon.checks.some(
            (check) =>
              (check.id === 'p95:report' ||
                check.id === 'availability:report' ||
                check.id === 'workload_complete') &&
              !check.passed,
          ),
        ),
      ).toBe(true);
      const reportP95 = index.horizons[0]!.checks.find(
        (check) => check.id === 'p95:report',
      );
      expect(reportP95?.passed).toBe(false);
      expect(reportP95?.message).toContain('no successful responses');
      expect(reportP95?.actual).toBeUndefined();

      const budget = expectOk(evaluateFixture('fail-overbudget'));
      expect(budget.passed).toBe(false);
      expect(budget.cost.withinBudget).toBe(false);
      expect(
        budget.horizons.every((horizon) =>
          horizon.checks.some((check) => check.id === 'budget' && !check.passed),
        ),
      ).toBe(true);
    },
    120_000,
  );

  it(
    'requires both mandatory horizons for an overall pass',
    () => {
      const investigation = expectOk(
        evaluateFixture('family-sql-indexed', 101, [1]),
      );
      expect(investigation.horizons).toHaveLength(1);
      expect(investigation.passed).toBe(false);
      expect(
        investigation.checks.find((check) => check.id === 'horizons_complete')
          ?.passed,
      ).toBe(false);
    },
    30_000,
  );

  it('returns structured errors for invalid input and seeds', () => {
    const invalid = evaluateParcel({ schemaVersion: 1, nodes: 'nope' }, { seed: 101 });
    expect(invalid.status).toBe('invalid');
    expect(invalid.meta.graphDigest).toBeNull();

    const badSeed = evaluateParcel(fixture('family-sql-indexed'), {
      seed: -1,
    });
    expect(badSeed.status).toBe('error');
    if (badSeed.status === 'error') {
      expect(badSeed.error.code).toBe('invalid_seed');
    }
  });

  it(
    'bounds every node queue and reports queue rejections instead of unbounded growth',
    () => {
      const parsed = parseParcelGraph(fixture('starter'));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }
      const sizes = new Map(
        parsed.graph.nodes.map((node) => [node.id, node.config.size]),
      );
      const result = expectOk(evaluateFixture('starter'));
      expect(result.passed).toBe(false);
      for (const horizon of result.horizons) {
        for (const node of horizon.nodes) {
          const size = sizes.get(node.nodeId);
          expect(size).toBeDefined();
          const hardware = PARCEL_CATALOG.hardware[size!];
          const limit = hardware.cpuCores * 500;
          expect(node.peakQueueDepth).toBeLessThanOrEqual(limit);
        }
        const rejected =
          horizon.operations.status.counts.rejected +
          horizon.operations.history.counts.rejected +
          horizon.operations.ingest.counts.rejected +
          horizon.operations.report.counts.rejected;
        expect(rejected).toBeGreaterThan(0);
      }
    },
    60_000,
  );

  it(
    'keeps the semantic digest stable across layout changes',
    () => {
      const graph = parseParcelGraph(fixture('family-sql-indexed'));
      expect(graph.ok).toBe(true);
      if (!graph.ok) {
        return;
      }
      const moved = JSON.parse(JSON.stringify(graph.graph)) as {
        nodes: { position: { x: number; y: number } }[];
        [key: string]: unknown;
      };
      moved.nodes[0]!.position = { x: 123, y: 456 };
      const first = expectOk(evaluateParcel(graph.graph, { seed: 101 }));
      const second = expectOk(
        evaluateParcel(moved as unknown, { seed: 101 }),
      );
      expect(first.meta.graphDigest).toBe(second.meta.graphDigest);
    },
    30_000,
  );
});
