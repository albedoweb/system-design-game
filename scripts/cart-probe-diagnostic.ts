/** Bounded, read-only single-case production probe tracing. No qualification claim.
 * node --import tsx scripts/cart-probe-diagnostic.ts <candidate.json> <case> [probe-id]
 * Keeps the full frozen background, probe set, timing windows and seed 1729.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { canonicalJson, parseCartGraph, sha256Hex } from '../src/cart';
import type { CartCaseId } from '../src/cart/contracts';
import { createCartCaseRun } from '../src/cart/core/case';
import { buildCartProbes } from '../src/cart/core/challenges';
import { auditCartProbes } from '../src/cart/core/probe-oracle';
import { buildCartCaseWorkload } from '../src/cart/core/workload';

const [path, caseArg, probeId] = process.argv.slice(2);
assert(path && ['mobility', 'concurrent', 'partition', 'checkout'].includes(caseArg ?? ''),
  'Usage: <candidate.json> <mobility|concurrent|partition|checkout> [probe-id]');
const caseId = caseArg as CartCaseId;
const inputText = readFileSync(path, 'utf8');
const document = JSON.parse(inputText);
const parsed = parseCartGraph(document.graph ?? document);
assert(parsed.ok, 'Invalid graph');
const graph = parsed.graph;
const probes = buildCartProbes().probes.filter(p => p.caseId === caseId);
if (probeId) assert(probes.some(p => p.id === probeId), 'Unknown probe id');
const start = performance.now();
const run = createCartCaseRun({ graph, caseId, seed: 1729 });
run.model.run();
const { model, result } = run.complete();
const records = model.requestRecords;
const reads = model.readResults;
const oracle = auditCartProbes(probes, {
  records, reads, stock: model.inventoryStock, orders: model.inventoryOrders,
  cartQuantity: id => model.cartLiveQuantity(id),
});
assert(!model.exceededResourceLimit, 'Incomplete execution');
assert.equal(oracle.audited, probes.length);
assert.equal(new Set(records.map(r => r.id)).size, records.length, 'Duplicate record ids');
const selected = probes.find(p => probeId ? p.id === probeId : oracle.results.some(r => r.probeId === p.id && !r.pass));
assert(selected, 'No selected failing probe');
const ids = new Set(selected.steps.map(s => s.id));
const steps = selected.steps.map(step => {
  const record = records.find(r => r.id === step.id);
  assert(record, `Missing record: ${step.id}`);
  const read = reads.get(step.id);
  return { step, record, lateDelivery: record.deliveryUs !== null && record.deliveryUs > record.deadlineUs,
    read: read ?? null,
    prerequisites: step.dependsOn.map(id => records.find(r => r.id === id) ?? { id, missing: true }) };
});
console.log(JSON.stringify({
  sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  graphSha256: sha256Hex(canonicalJson(graph)), seed: 1729, caseId,
  inputFileSha256: sha256Hex(inputText), probeSetHash: buildCartProbes().hash,
  units: 'All *Us fields are microseconds; elapsedMs is wall-clock milliseconds.',
  workloadHash: buildCartCaseWorkload(caseId, 1729).traceHash,
  elapsedMs: performance.now() - start, complete: result.complete,
  oracle: { scheduled: oracle.scheduled, passed: oracle.passed, failed: oracle.failed,
    results: oracle.results },
  selected: { probe: selected, steps,
    orders: model.inventoryOrders.filter(o => steps.some(s => s.record.cartId === o.cartId)),
    ledger: model.inventoryLedgerRows.filter(o => steps.some(s => s.record.cartId === o.cartId)),
    stock: model.inventoryStock,
    transfers: model.transferSnapshots.filter(t => [...ids].some(id => t.logicalId.startsWith(id))) },
  failedGates: result.gates.filter(g => !g.pass),
}, null, 2));
