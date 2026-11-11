#!/usr/bin/env node
/**
 * Calibration evidence generator. Runs the real evaluator over the committed
 * witnesses and writes fixtures/parcel/calibration-summary.json. It does not
 * change traffic, SLOs or prices to rescue a witness.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PARCEL_LEVEL,
  PARCEL_MODEL_VERSION,
  PARCEL_PRICING_VERSION,
  evaluateParcel,
  parseParcelGraph,
  type ParcelEvaluation,
  type ParcelGraph,
} from '../src/parcel/index';

const FIXTURES = [
  'starter',
  'family-sql-indexed',
  'family-sql-rollups',
  'family-kv-rollups',
  'family-hybrid-analytics',
  'fail-missing-route',
  'fail-missing-index',
  'fail-capacity',
  'fail-freshness',
  'fail-small-hardware',
  'fail-overbudget',
] as const;

const TRAINING_SEEDS = [101, 211, 307] as const;
const HOLDOUT_SEEDS = [607, 701] as const;
const SEEDS = [...TRAINING_SEEDS, ...HOLDOUT_SEEDS];

function load(name: string): unknown {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'fixtures', 'parcel', `${name}.json`),
      'utf8',
    ),
  ) as unknown;
}

function reportPath(node: ParcelGraph, operation: string): {
  nodeId: string;
  kind: string;
  rollups: boolean | null;
  index: string | null;
  partition: string | null;
} | null {
  const app = node.nodes.find((item) => item.kind === 'app');
  const edge = node.edges.find(
    (item) => item.source === app?.id && item.operation === operation,
  );
  const target = edge
    ? node.nodes.find((item) => item.id === edge.target)
    : undefined;
  if (!target) {
    return null;
  }
  return {
    nodeId: target.id,
    kind: target.kind,
    rollups: target.config.rollups ?? null,
    index: target.config.index ?? null,
    partition: target.config.partition ?? null,
  };
}

function summarise(evaluation: ParcelEvaluation): Record<string, unknown> {
  if (evaluation.status !== 'ok') {
    return {
      status: evaluation.status,
      passed: false,
      graphDigest: evaluation.meta.graphDigest,
      errors:
        evaluation.status === 'error'
          ? [evaluation.error.code]
          : evaluation.issues
              .filter((issue) => issue.severity === 'error')
              .map((issue) => issue.code),
    };
  }
  return {
    status: 'ok',
    passed: evaluation.passed,
    graphDigest: evaluation.meta.graphDigest,
    monthlyUsd: evaluation.cost.monthlyUsd,
    fiveYearTcoUsd: evaluation.cost.fiveYearTcoUsd,
    budgetMonthlyUsd: evaluation.cost.budgetMonthlyUsd,
    withinBudget: evaluation.cost.withinBudget,
    horizons: evaluation.horizons.map((horizon) => ({
      horizonYears: horizon.horizonYears,
      passed: horizon.passed,
      failedChecks: horizon.checks
        .filter((check) => check.severity === 'required' && !check.passed)
        .map((check) => check.id),
      diagnosisCodes: [...new Set(horizon.diagnostics.map((item) => item.code))],
      capacity: {
        usedTb: horizon.capacity.totalUsedTb,
        provisionedTb: horizon.capacity.totalProvisionedTb,
        replicationFactor: horizon.capacity.replicationFactor,
        retentionOk: horizon.capacity.retentionOk,
      },
      operations: Object.fromEntries(
        Object.entries(horizon.operations).map(([operation, metrics]) => [
          operation,
          {
            offered: metrics.counts.offered,
            success: metrics.counts.success,
            availability: metrics.availability,
            p95Ms: metrics.successP95Ms,
            timeoutCount: metrics.timeoutCount,
            rejectCount: metrics.rejectCount,
            missedData: metrics.counts.missedData,
            stale: metrics.counts.stale,
            freshnessMaxMs: metrics.freshnessMaxMs,
          },
        ]),
      ),
    })),
  };
}

function main(): void {
  const fixtures: Record<string, unknown> = {};
  const familyRows: {
    name: string;
    passedAllSeeds: boolean;
    fiveYearTcoUsd: number;
    monthlyUsd: number;
    report: ReturnType<typeof reportPath>;
    hasReplicate: boolean;
  }[] = [];

  for (const name of FIXTURES) {
    const document = load(name);
    const parsed = parseParcelGraph(document);
    const rows: Record<string, unknown> = {};
    let allPassed = true;
    let firstCost: { monthly: number; fiveYear: number } | null = null;
    for (const seed of SEEDS) {
      const evaluation = evaluateParcel(document, { seed });
      const summary = summarise(evaluation);
      rows[String(seed)] = summary;
      if (evaluation.status !== 'ok' || !evaluation.passed) {
        allPassed = false;
      }
      if (evaluation.status === 'ok' && firstCost === null) {
        firstCost = {
          monthly: evaluation.cost.monthlyUsd,
          fiveYear: evaluation.cost.fiveYearTcoUsd,
        };
      }
    }
    fixtures[name] = {
      parsed: parsed.ok,
      issues: parsed.ok
        ? parsed.issues.map((issue) => ({
            severity: issue.severity,
            code: issue.code,
          }))
        : parsed.issues.map((issue) => ({
            severity: issue.severity,
            code: issue.code,
          })),
      seeds: rows,
    };
    if (name.startsWith('family-') && parsed.ok && firstCost) {
      familyRows.push({
        name,
        passedAllSeeds: allPassed,
        monthlyUsd: firstCost.monthly,
        fiveYearTcoUsd: firstCost.fiveYear,
        report: reportPath(parsed.graph, 'report'),
        hasReplicate: parsed.graph.edges.some(
          (edge) => edge.operation === 'replicate',
        ),
      });
    }
  }

  familyRows.sort((a, b) => a.fiveYearTcoUsd - b.fiveYearTcoUsd);
  const summary = {
    schemaVersion: 1,
    level: PARCEL_LEVEL.id,
    modelVersion: PARCEL_MODEL_VERSION,
    pricingVersion: PARCEL_PRICING_VERSION,
    generatedFrom: 'real evaluator; no preset pass names',
    trainingSeeds: TRAINING_SEEDS,
    holdoutSeeds: HOLDOUT_SEEDS,
    budgetMonthlyUsd: PARCEL_LEVEL.budget.monthlyUsd,
    sampleFactor: PARCEL_LEVEL.workload.sampleFactor,
    observationWindowMs: PARCEL_LEVEL.durationMs,
    familyWitnesses: familyRows,
    rankingByFiveYearTco: familyRows.map((row) => ({
      name: row.name,
      fiveYearTcoUsd: row.fiveYearTcoUsd,
      passedAllSeeds: row.passedAllSeeds,
    })),
    dominance: {
      cheapestPassing: familyRows[0]?.name ?? null,
      mostExpensivePassing: familyRows[familyRows.length - 1]?.name ?? null,
      note:
        'The three single-store witnesses tie on five-year TCO in the current catalog; the hybrid pays for a second physical copy and is more expensive. Indexed SQL and rollup SQL have the same price but different read work. Do not call the families equally competitive.',
    },
    fixtures,
    notes: [
      'SQL indexed report witness uses rollups:false and a parcel-warehouse index; the rollup variant is kept as a fourth approach.',
      'KV report witness uses parcel buckets for history and maintained hourly rollups for reports.',
      'Hybrid witness keeps operational reads on SQL and serves reports from an asynchronously replicated columnar projection; replication is charged and replicationFactor is 2.',
      'fail-small-hardware is the genuine cost frontier: cheaper medium SQL fails status p95 because its declared IO lanes saturate.',
      'fail-freshness fails status availability and data_integrity after replica queue overflow; a diagnostic alone cannot allow a pass.',
      'All prices are conditional in-game prices, not vendor claims.',
    ],
  };

  writeFileSync(
    resolve(process.cwd(), 'fixtures', 'parcel', 'calibration-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        summary: 'fixtures/parcel/calibration-summary.json',
        rankingByFiveYearTco: summary.rankingByFiveYearTco,
      },
      null,
      2,
    )}\n`,
  );
}

main();
