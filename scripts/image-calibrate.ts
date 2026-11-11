/**
 * Image Atlas calibration CLI.
 *
 * Runs the real evaluator on reference graphs with the frozen workload and
 * prints per-case gates, measured cost and resource bottlenecks. It never
 * fabricates a result: the same `evaluateImages` used by the browser Worker and
 * the agent API is executed here.
 *
 * Usage:
 *   node --import tsx scripts/image-calibrate.ts
 *   node --import tsx scripts/image-calibrate.ts --family fixtures/images/family-direct.json --seed 101
 *   node --import tsx scripts/image-calibrate.ts --all --seed 101
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateImages } from '../src/images/evaluate';
import { compileImageRoutes, parseImageGraph } from '../src/images/graph';
import { simulateImageScenario } from '../src/images/simulate';
import { buildImageTrace } from '../src/images/workload';
import type { ImageScenarioName } from '../src/images/contracts';
import { IMAGE_REQUIRED_SCENARIOS } from '../src/images/contracts';

const ROOT = process.cwd();
const DEFAULT_FAMILIES = [
  'fixtures/images/family-direct.json',
  'fixtures/images/family-proxy-cache.json',
  'fixtures/images/family-direct-kv.json',
];

interface Args {
  readonly families: string[];
  readonly seeds: number[];
  readonly scenarios: ImageScenarioName[];
  readonly all: boolean;
  readonly snapshot: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const families: string[] = [];
  const seeds: number[] = [];
  const scenarios: ImageScenarioName[] = [];
  let all = false;
  let snapshot = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--family' && argv[index + 1]) {
      families.push(argv[index + 1] ?? '');
      index += 1;
    } else if (arg === '--seed' && argv[index + 1]) {
      for (const part of (argv[index + 1] ?? '').split(',')) {
        const value = Number(part);
        if (Number.isInteger(value)) {
          seeds.push(value);
        }
      }
      index += 1;
    } else if (arg === '--scenario' && argv[index + 1]) {
      for (const part of (argv[index + 1] ?? '').split(',')) {
        scenarios.push(part as ImageScenarioName);
      }
      index += 1;
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--snapshot') {
      snapshot = true;
    }
  }
  return {
    families: families.length > 0 ? families : DEFAULT_FAMILIES,
    seeds: seeds.length > 0 ? seeds : [101],
    scenarios: scenarios.length > 0 ? scenarios : [...IMAGE_REQUIRED_SCENARIOS],
    all,
    snapshot,
  };
}

function readGraph(file: string) {
  const parsed = parseImageGraph(JSON.parse(readFileSync(join(ROOT, file), 'utf8')));
  if (!parsed.ok) {
    throw new Error(`${file}: ${parsed.issues.map((issue) => issue.message).join('; ')}`);
  }
  return parsed.graph;
}

function ms(value: number): string {
  return `${value.toFixed(0)}ms`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const seeds = args.all ? [101, 211, 307, 607, 701] : args.seeds;
  let failures = 0;
  let runs = 0;
  for (const file of args.families) {
    let graph;
    try {
      graph = readGraph(file);
    } catch (error) {
      console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      failures += 1;
      continue;
    }
    for (const seed of seeds) {
      const started = Date.now();
      const result = evaluateImages(graph, { seed, scenarios: args.scenarios });
      runs += 1;
      console.log(
        `\n=== ${file} · seed ${seed} · ${result.status} · ${result.passed ? 'PASS' : 'FAIL'} · ${Date.now() - started} ms`,
      );
      console.log(
        `cost ${result.cost ? `$${result.cost.monthlyUsd.toFixed(0)} measured=${result.cost.provenance.measured} within=${result.cost.withinBudget}` : 'n/a'} | capacity ${result.capacity?.capacityOk ?? false}`,
      );
      for (const scenario of result.scenarios) {
        const failed = scenario.checks
          .filter((check) => check.severity === 'required' && !check.passed)
          .map((check) => check.id);
        console.log(
          [
            scenario.name.padEnd(20),
            scenario.passed ? 'PASS' : 'FAIL',
            `up ${scenario.operations.upload.counts.success}/${scenario.operations.upload.counts.offered} ${ms(scenario.operations.upload.latencyP999Ms)}`,
            `search ${scenario.operations.search.counts.success}/${scenario.operations.search.counts.offered} ${ms(scenario.operations.search.latencyP999Ms)}`,
            `detail ${scenario.operations.detail.counts.success}/${scenario.operations.detail.counts.offered} ${ms(scenario.operations.detail.latencyP999Ms)}`,
            `fresh ${scenario.freshness.success}/${scenario.freshness.probes}`,
            `unpublished ${scenario.postlude.unpublishedCommitted}`,
            failed.length > 0 ? `failed: ${failed.join(',')}` : '',
          ]
            .filter((part) => part.length > 0)
            .join(' | '),
        );
        if (!scenario.passed) {
          failures += 1;
        }
      }
      if (args.snapshot) {
        const routes = compileImageRoutes(graph);
        for (const name of args.scenarios) {
          const trace = buildImageTrace(seed, name);
          const simulation = simulateImageScenario(graph, routes, trace);
          const top = [...simulation.resources]
            .filter((row) => row.capacity > 0)
            .map((row) => ({ ...row, util: row.averageBusyUnits / row.capacity }))
            .sort((left, right) => right.util - left.util)
            .slice(0, 6);
          console.log(
            `  snapshot ${name}: ${top
              .map((row) => `${row.id}=${(row.util * 100).toFixed(0)}%`)
              .join(' ')}`,
          );
        }
      }
    }
  }
  console.log(`\n${runs} run(s), ${failures} failing case(s)`);
}

main();
