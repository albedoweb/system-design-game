/**
 * Calibration harness for the single playable level. It runs the frozen
 * starter graph plus cheap-pass and over-budget candidates on the acceptance
 * and holdout seeds, then records results in an ignored JSON report and
 * tracked graph fixtures.
 *
 * Run with: npx tsx scripts/calibrate.ts
 * No level threshold or price is modified here.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { calculateCost, microUsdToUsd } from '../src/domain/catalog';
import {
  createInitialGraph,
  makeNode,
  type GraphDocument,
} from '../src/domain/graph';
import { DEFAULT_LEVEL, type LevelDefinition } from '../src/domain/level';
import { createSimulation } from '../src/engine';

interface GraphFixture {
  id: string;
  title: string;
  levelId: string;
  contentVersion: string;
  graph: GraphDocument;
}

interface Candidate {
  id: string;
  title: string;
  description: string;
  graph: GraphDocument;
}

const outputDir = join(process.cwd(), 'test-results');
const fixtureDir = join(process.cwd(), 'tests', 'calibration');
const reportPath = join(outputDir, 'calibration.json');

function cable(
  graph: GraphDocument,
  id: string,
  source: string,
  target: string,
  sourcePort: GraphDocument['edges'][number]['sourcePort'],
): void {
  graph.edges.push({ id, source, target, sourcePort });
}

function cheapPassGraph(): GraphDocument {
  return {
    schemaVersion: 1,
    levelId: 'cold-cache',
    nodes: [
      makeNode('client', 'client-1', { x: 0, y: 0 }),
      makeNode('appServer', 'app-1', { x: 150, y: 0 }, { config: { size: 'medium' } }),
      makeNode('cache', 'cache-1', { x: 300, y: -60 }, {
        config: { size: 'medium', coalescing: true },
      }),
      makeNode('database', 'db-1', { x: 450, y: 0 }, { config: { size: 'medium' } }),
    ],
    edges: [
      { id: 'e-client-app', source: 'client-1', target: 'app-1', sourcePort: 'out' },
      { id: 'e-app-cache', source: 'app-1', target: 'cache-1', sourcePort: 'read' },
      { id: 'e-cache-db', source: 'cache-1', target: 'db-1', sourcePort: 'miss' },
      { id: 'e-app-db', source: 'app-1', target: 'db-1', sourcePort: 'write' },
    ],
  };
}

function overBudgetGraph(): GraphDocument {
  const graph: GraphDocument = {
    schemaVersion: 1,
    levelId: 'cold-cache',
    nodes: [
      makeNode('client', 'client-1', { x: -150, y: 80 }),
      makeNode('loadBalancer', 'lb-1', { x: 0, y: 80 }),
      makeNode('appServer', 'app-1', { x: 150, y: 0 }, { config: { size: 'large' } }),
      makeNode('appServer', 'app-2', { x: 150, y: 160 }, { config: { size: 'large' } }),
      makeNode('cache', 'cache-1', { x: 300, y: -60 }, {
        config: { size: 'large', coalescing: true },
      }),
      makeNode('database', 'db-1', { x: 450, y: 80 }, { config: { size: 'large' } }),
    ],
    edges: [],
  };
  cable(graph, 'e-client-lb', 'client-1', 'lb-1', 'out');
  cable(graph, 'e-lb-app-1', 'lb-1', 'app-1', 'out');
  cable(graph, 'e-lb-app-2', 'lb-1', 'app-2', 'out');
  for (const app of ['app-1', 'app-2']) {
    cable(graph, `e-${app}-cache`, app, 'cache-1', 'read');
    cable(graph, `e-${app}-db`, app, 'db-1', 'write');
  }
  cable(graph, 'e-cache-db', 'cache-1', 'db-1', 'miss');
  return graph;
}

const candidates: Candidate[] = [
  {
    id: 'starter',
    title: 'Starter setup',
    description: 'One small app, a medium cache without coalescing, a small DB',
    graph: createInitialGraph(),
  },
  {
    id: 'cheap-pass',
    title: 'Cheap candidate',
    description: 'A medium app, a medium cache with coalescing, a medium DB',
    graph: cheapPassGraph(),
  },
  {
    id: 'overbudget',
    title: 'Over budget',
    description: 'Two large apps behind an LB, a large cache and a large DB',
    graph: overBudgetGraph(),
  },
];

function runGraph(
  graph: GraphDocument,
  level: LevelDefinition,
  seed: number,
  chunkMs: number,
) {
  const started = performance.now();
  const engine = createSimulation(graph, level, seed);
  const end = level.durationMs + level.drainMs;
  let time = 0;
  while (time < end) {
    time = Math.min(end, time + chunkMs);
    engine.advance(time);
  }
  const result = engine.result();
  return {
    result,
    stats: engine.stats,
    wallTimeMs: performance.now() - started,
  };
}

async function main(): Promise<void> {
  const calibrationSeeds = [...DEFAULT_LEVEL.refs.calibrationSeeds];
  const holdoutSeeds = [...DEFAULT_LEVEL.refs.holdoutSeeds];
  const seeds = [...calibrationSeeds, ...holdoutSeeds];
  const holdout = new Set(holdoutSeeds);
  const chunkMs = 1000;

  await mkdir(outputDir, { recursive: true });
  await mkdir(fixtureDir, { recursive: true });

  const report = {
    generatedAt: new Date().toISOString(),
    chunkMs,
    level: {
      id: DEFAULT_LEVEL.id,
      contentVersion: DEFAULT_LEVEL.contentVersion,
      modelVersion: DEFAULT_LEVEL.modelVersion,
      pricingVersion: DEFAULT_LEVEL.pricingVersion,
      durationMs: DEFAULT_LEVEL.durationMs,
      warmupMs: DEFAULT_LEVEL.warmupMs,
      drainMs: DEFAULT_LEVEL.drainMs,
      budgetUsdPerHour: microUsdToUsd(DEFAULT_LEVEL.budgetMicroUsdPerHour),
      calibrationSeeds,
      holdoutSeeds,
    },
    candidates: [] as unknown[],
  };

  for (const candidate of candidates) {
    const fixture: GraphFixture = {
      id: candidate.id,
      title: candidate.title,
      levelId: DEFAULT_LEVEL.id,
      contentVersion: DEFAULT_LEVEL.contentVersion,
      graph: candidate.graph,
    };
    await writeFile(
      join(fixtureDir, `${candidate.id}.json`),
      `${JSON.stringify(fixture, null, 2)}\n`,
      'utf8',
    );

    const runs = [];
    for (const seed of seeds) {
      const { result, stats, wallTimeMs } = runGraph(
        candidate.graph,
        DEFAULT_LEVEL,
        seed,
        chunkMs,
      );
      runs.push({
        seed,
        holdout: holdout.has(seed),
        passed: result.passed,
        costUsdPerHour: microUsdToUsd(result.costMicroUsdPerHour),
        checks: result.checks,
        reads: result.snapshot.reads,
        writes: result.snapshot.writes,
        diagnostics: result.diagnostics,
        wallTimeMs: Math.round(wallTimeMs),
        eventsProcessed: stats.eventsProcessed,
        offeredArrivals: stats.offeredArrivals,
      });
    }

    const entry = {
      id: candidate.id,
      title: candidate.title,
      description: candidate.description,
      costMicroUsdPerHour: calculateCost(candidate.graph),
      costUsdPerHour: microUsdToUsd(calculateCost(candidate.graph)),
      fixtureFile: `tests/calibration/${candidate.id}.json`,
      runs,
      passedRuns: runs.filter((run) => run.passed).length,
      totalRuns: runs.length,
    };
    report.candidates.push(entry);
    console.log(
      `${candidate.id}: ${entry.passedRuns}/${entry.totalRuns} pass, ` +
        `$${entry.costUsdPerHour.toFixed(2)}/h, ` +
        `events=${runs.reduce((sum, run) => sum + run.eventsProcessed, 0)}, ` +
        `wall=${runs.reduce((sum, run) => sum + run.wallTimeMs, 0)} ms`,
    );
  }

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`report: ${reportPath}`);
  console.log(`fixtures: ${fixtureDir}`);
}

await main();
