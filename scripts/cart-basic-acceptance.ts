/**
 * GC-B02 basic-level acceptance evidence generator.
 *
 * Builds the single importable basic reference from the existing PV1 regional
 * graph (explicit atomic restamp to the basic content identity, no added
 * replication), evaluates it with the real public `evaluateCart` for several
 * seeds, runs required-path-removal negative controls and an isolated capacity
 * change. Each run's FULL raw `evaluateCart` output is written sequentially as
 * its own artifact (raw/<label>-seed<seed>.json) before the next run starts, and
 * a compact summary index is written at the end.
 *
 * Usage: node --import tsx scripts/cart-basic-acceptance.ts [--out=<dir>] [--seeds=1729,4242]
 * Gates, thresholds and cases are never modified here.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CART_VERSIONS, cartGraphDigest, evaluateCart, parseCartGraph, type CartGraph } from '../src/cart';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REFERENCE_PATH = resolve(root, 'tests/fixtures/cart/basic/reference-basic.json');
const PV1_PATH = resolve(root, 'src/cart/__tests__/fixtures/pv1-candidate-graph.json');

export function buildReference(): CartGraph {
  const parsed = parseCartGraph(JSON.parse(readFileSync(PV1_PATH, 'utf8')), CART_VERSIONS.content);
  if (!parsed.ok) throw new Error('PV1 graph must parse');
  return parsed.graph;
}

/** Negative control A: remove one required cross-region journal read path (us-west -> ap-northeast). */
export function withoutRequiredReadPath(graph: CartGraph): CartGraph {
  return { ...graph, edges: graph.edges.filter((edge) => edge.id !== 'fanout-us-west-ap-northeast') };
}

/** Negative control B: remove the us-west Application -> its durable journal write path. */
export function withoutWritePath(graph: CartGraph): CartGraph {
  return { ...graph, edges: graph.edges.filter((edge) => edge.id !== 'ack-us-west') };
}

/** Negative control C: remove the us-west Application -> Inventory request edge (reproduced B01 defect; fixed by validation-qualified session). */
export function withoutInventoryPath(graph: CartGraph): CartGraph {
  return { ...graph, edges: graph.edges.filter((edge) => edge.id !== 'inventory-us-west') };
}

/** Isolated capacity change: only the shared journal/inventory tier shrinks M -> S. */
export function withSmallJournalsAndInventory(graph: CartGraph): CartGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.kind === 'journal' || n.kind === 'inventory' ? { ...n, size: 'S' as const } : n)),
  };
}

function main(): void {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const outDir = resolve(arg('out') ?? resolve(root, 'tests/fixtures/cart/basic'));
  const seeds = (arg('seeds') ?? '1729,4242').split(',').map(Number);
  const reference = buildReference();
  mkdirSync(resolve(outDir, 'raw'), { recursive: true });
  writeFileSync(REFERENCE_PATH, `${JSON.stringify(reference, null, 2)}\n`);
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const only = arg('only');
  const indexPath = resolve(outDir, 'basic-acceptance-index.json');
  // --only=<label[,label]> regenerates just those runs and merges into the existing index.
  const index: Record<string, unknown>[] = only ? (JSON.parse(readFileSync(indexPath, 'utf8')).runs as Record<string, unknown>[]) : [];
  const allRuns: { label: string; graph: CartGraph; seed: number }[] = [
    ...seeds.map((seed: number) => ({ label: 'reference', graph: reference, seed })),
    ...seeds.map((seed: number) => ({ label: 'control-no-read-path', graph: withoutRequiredReadPath(reference), seed })),
    { label: 'control-no-write-path', graph: withoutWritePath(reference), seed: seeds[0]! },
    ...seeds.map((seed: number) => ({ label: 'control-no-inventory-path', graph: withoutInventoryPath(reference), seed })),
    { label: 'capacity-S-journals-inventory', graph: withSmallJournalsAndInventory(reference), seed: seeds[0]! },
  ];
  const labels = only?.split(',');
  const runs = labels ? allRuns.filter((r) => labels.includes(r.label)) : allRuns;
  for (const run of runs) {
    const started = Date.now();
    const evaluation = evaluateCart(run.graph, { seed: run.seed });
    const file = `raw/${run.label}-seed${run.seed}.json`;
    writeFileSync(resolve(outDir, file), `${JSON.stringify({ sourceSha, label: run.label, seed: run.seed, inputGraphDigest: cartGraphDigest(run.graph), ms: Date.now() - started, evaluation })}\n`);
    const entry = {
      label: run.label, seed: run.seed, file, profile: evaluation.versions.profile, content: evaluation.versions.content,
      graphDigest: evaluation.graphDigest, complete: evaluation.complete, qualified: evaluation.qualified,
      score: evaluation.scoreCreditsPerHour, issues: evaluation.issues.map((i) => i.code),
      cases: evaluation.cases.map((c) => ({
        id: c.id, scheduled: c.scheduled, issued: c.issued, complete: c.complete, gates: c.gates.length,
        failedGates: c.gates.filter((g) => !g.pass).length, outcomes: c.outcomes, cost: c.cost,
      })),
    };
    const at = index.findIndex((e) => e.label === entry.label && e.seed === entry.seed);
    if (at >= 0) index[at] = entry; else index.push(entry);
    writeFileSync(indexPath, `${JSON.stringify({ sourceSha, referenceDigest: cartGraphDigest(reference), runs: index }, null, 1)}\n`);
    console.log(run.label, run.seed, 'complete', entry.complete, 'qualified', entry.qualified, 'score', entry.score,
      'issues', entry.issues.join(','), entry.cases.map((c) => `${c.id}:${c.issued}/${c.scheduled} failed=${c.failedGates}`).join(' '));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
