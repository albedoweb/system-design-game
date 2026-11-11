import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CART_REQUIRED_CASES,
  CART_VERSIONS,
  type CartCaseId,
  type CartCircuitMbps,
  type CartGraph,
  type CartRegion,
  type CartServiceSize,
} from '..';
import {
  CHECKPOINT_MAX_BYTES,
  checkpointDirectory,
  createCheckpoint,
  executeCalibration,
  planFingerprint,
  readCheckpoint,
  summarizeMatrix,
  taskGraphSha256,
  writeCheckpoint,
  type CalibrationPlan,
  type ControlEvidence,
  type RunEvidence,
  type WorkerTask,
} from '../../../scripts/cart-calibrate';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SOURCE_A = { sha: SHA_A, dirty: false };
const SOURCE_B = { sha: SHA_B, dirty: false };

const roots: string[] = [];

function scratch(): string {
  const cache = resolve('node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(resolve(cache, 'gc019h1-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makePlan(overrides: Partial<CalibrationPlan> = {}): CalibrationPlan {
  return {
    schemaVersion: 1,
    seeds: [1729],
    families: ['central-journal'],
    sizes: ['S'],
    placements: ['us-west'],
    tiers: [8],
    controls: [],
    jobs: 1,
    ...overrides,
  };
}

/** Synthetic graph: checkpoint code hashes it but never evaluates it in these tests. */
function makeGraph(label: string): CartGraph {
  return { label, nodes: [], edges: [], circuits: [] } as unknown as CartGraph;
}

interface TaskOptions {
  readonly id?: string;
  readonly seed?: number;
  readonly size?: CartServiceSize;
  readonly placement?: CartRegion;
  readonly tierMbps?: CartCircuitMbps;
  readonly graphLabel?: string;
}

function makeTask(options: TaskOptions = {}): WorkerTask {
  const id = options.id ?? 'family-a-central-journal--size=S--placement=us-west--tier=8--seed=1729';
  return {
    id,
    kind: 'candidate',
    family: 'central-journal',
    size: options.size ?? 'S',
    placement: options.placement ?? 'us-west',
    tierMbps: options.tierMbps ?? 8,
    seed: options.seed ?? 1729,
    graph: makeGraph(options.graphLabel ?? id),
  };
}

function makeEvidence(task: WorkerTask, source: { sha: string; dirty: boolean }): RunEvidence {
  return {
    id: task.id,
    kind: task.kind,
    family: task.family,
    size: task.size,
    placement: task.placement,
    tierMbps: task.tierMbps,
    seed: task.seed,
    sourceSha: source.sha,
    sourceDirty: source.dirty,
    nodeVersion: process.version,
    versions: { ...CART_VERSIONS },
    graphDigest: taskGraphSha256(task),
    graphSha256: taskGraphSha256(task),
    structuralIssues: [],
    issueCodes: [],
    complete: true,
    qualified: false,
    scoreCreditsPerHour: 0,
    peakCreditsPerHour: 1,
    budgetCreditsPerHour: 6,
    executionMs: 1,
    failedGateCount: 0,
    cases: CART_REQUIRED_CASES.map((id: CartCaseId) => ({
      id,
      issued: 1,
      scheduled: 1,
      complete: true,
      outcomes: {},
      resources: {},
      cost: {},
      failedGates: [],
      gates: [],
    })),
    graph: task.graph,
  };
}

function controlsFor(plan: CalibrationPlan): ControlEvidence[] {
  return plan.controls.map((id) => ({
    id,
    title: id,
    expectation: 'synthetic',
    expectationMet: true,
    detail: 'synthetic control',
  }));
}

describe('calibration checkpoint durability', () => {
  it('writes one atomic, fully tagged checkpoint per completed evaluation', async () => {
    const root = scratch();
    const outPath = resolve(root, 'out/calibration.json');
    const directory = checkpointDirectory(outPath);
    const plan = makePlan();
    const tasks = [makeTask({ id: 'task-a' }), makeTask({ id: 'task-b', seed: 7 })];

    const execution = await executeCalibration(tasks, {
      plan,
      source: SOURCE_A,
      outPath,
      jobs: 2,
      execute: async (task, source) => makeEvidence(task, source),
      now: () => '2026-11-09T00:00:00.000Z',
    });

    expect(execution.failures).toEqual([]);
    expect(execution.missing).toEqual([]);
    expect(execution.runs.map((run) => run.id)).toEqual(['task-a', 'task-b']);
    expect(execution.checkpoints.written).toBe(2);
    expect(execution.checkpoints.reused).toBe(0);
    expect(execution.checkpoints.directory).toBe(directory);

    const written = readdirSync(directory).sort();
    expect(written).toEqual(['task-a.json', 'task-b.json']);

    const stored = JSON.parse(readFileSync(resolve(directory, 'task-b.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(stored.kind).toBe('cart-calibration-checkpoint');
    expect(stored.planDigest).toBe(planFingerprint(plan));
    expect(stored.sourceSha).toBe(SHA_A);
    expect(stored.sourceDirty).toBe(false);
    expect(stored.writtenAt).toBe('2026-11-09T00:00:00.000Z');
    expect(stored.versions).toEqual(CART_VERSIONS);
    expect(stored.task).toEqual({
      id: 'task-b',
      kind: 'candidate',
      family: 'central-journal',
      size: 'S',
      placement: 'us-west',
      tierMbps: 8,
      seed: 7,
      graphSha256: taskGraphSha256(tasks[1]!),
    });
    expect(readCheckpoint(directory, 'task-b').checkpoint?.run.seed).toBe(7);
  });

  it('preserves completed evidence when a worker fails and records the failure explicitly', async () => {
    const root = scratch();
    const outPath = resolve(root, 'out/run.json');
    const directory = checkpointDirectory(outPath);
    const plan = makePlan();
    const tasks = [makeTask({ id: 'task-ok-1' }), makeTask({ id: 'task-boom' }), makeTask({ id: 'task-ok-2' })];

    const execution = await executeCalibration(tasks, {
      plan,
      source: SOURCE_A,
      outPath,
      jobs: 1,
      execute: async (task, source) => {
        if (task.id === 'task-boom') throw new Error('simulated worker out of memory');
        return makeEvidence(task, source);
      },
    });

    expect(execution.runs.map((run) => run.id)).toEqual(['task-ok-1', 'task-ok-2']);
    expect(execution.failures).toEqual([
      { id: 'task-boom', error: 'simulated worker out of memory' },
    ]);
    expect(execution.missing).toEqual([]);
    expect(execution.checkpoints.written).toBe(2);
    expect(readCheckpoint(directory, 'task-ok-1').checkpoint?.task.id).toBe('task-ok-1');
    expect(readCheckpoint(directory, 'task-ok-2').checkpoint?.task.id).toBe('task-ok-2');
    expect(readCheckpoint(directory, 'task-boom')).toMatchObject({ existed: false });

    const summary = summarizeMatrix({
      plan,
      runs: execution.runs,
      controls: controlsFor(plan),
      failures: execution.failures,
      missing: execution.missing,
      plannedTaskIds: tasks.map((task) => task.id),
    });
    expect(summary.matrixComplete).toBe(false);
    expect(summary.calibrationPass).toBe(false);
  });

  it('resumes validated checkpoints in a reduced-concurrency rerun without re-evaluating', async () => {
    const root = scratch();
    const outPath = resolve(root, 'out/run.json');
    const plan = makePlan({ jobs: 3 });
    const tasks = [makeTask({ id: 'task-a' }), makeTask({ id: 'task-b' })];

    await executeCalibration(tasks, {
      plan,
      source: SOURCE_A,
      outPath,
      jobs: 3,
      execute: async (task, source) => makeEvidence(task, source),
    });

    let executed = 0;
    const resumed = await executeCalibration(tasks, {
      plan: { ...plan, jobs: 1 },
      source: SOURCE_A,
      outPath,
      resume: true,
      jobs: 1,
      execute: async () => {
        executed += 1;
        throw new Error('resume must not evaluate again');
      },
    });

    expect(executed).toBe(0);
    expect(resumed.checkpoints.reused).toBe(2);
    expect(resumed.checkpoints.written).toBe(0);
    expect(resumed.checkpoints.rejected).toEqual([]);
    expect(resumed.runs.map((run) => run.id)).toEqual(['task-a', 'task-b']);
    expect(resumed.failures).toEqual([]);
  });

  it('rejects a checkpoint from a different source revision and re-runs the task', async () => {
    const root = scratch();
    const outPath = resolve(root, 'out/run.json');
    const plan = makePlan();
    const task = makeTask({ id: 'task-a' });

    await executeCalibration([task], {
      plan,
      source: SOURCE_A,
      outPath,
      jobs: 1,
      execute: async (t, source) => makeEvidence(t, source),
    });

    const resumed = await executeCalibration([task], {
      plan,
      source: SOURCE_B,
      outPath,
      resume: true,
      jobs: 1,
      execute: async (t, source) => makeEvidence(t, source),
    });

    expect(resumed.checkpoints.reused).toBe(0);
    expect(resumed.checkpoints.rejected).toHaveLength(1);
    expect(resumed.checkpoints.rejected[0]?.taskId).toBe('task-a');
    expect(resumed.checkpoints.rejected[0]?.reason).toContain(SHA_A);
    expect(resumed.checkpoints.written).toBe(1);
    expect(resumed.runs[0]?.sourceSha).toBe(SHA_B);
    expect(readCheckpoint(checkpointDirectory(outPath), 'task-a').checkpoint?.sourceSha).toBe(SHA_B);
  });

  it('rejects a checkpoint written under a different plan fingerprint', async () => {
    const root = scratch();
    const outPath = resolve(root, 'out/run.json');
    const task = makeTask({ id: 'task-a' });

    await executeCalibration([task], {
      plan: makePlan({ seeds: [1729] }),
      source: SOURCE_A,
      outPath,
      jobs: 1,
      execute: async (t, source) => makeEvidence(t, source),
    });

    let executed = 0;
    const resumed = await executeCalibration([task], {
      plan: makePlan({ seeds: [7] }),
      source: SOURCE_A,
      outPath,
      resume: true,
      jobs: 1,
      execute: async (t, source) => {
        executed += 1;
        return makeEvidence(t, source);
      },
    });

    expect(executed).toBe(1);
    expect(resumed.checkpoints.reused).toBe(0);
    expect(resumed.checkpoints.rejected[0]?.reason).toContain('plan fingerprint');
  });

  it('rejects a checkpoint whose task seed or graph digest was tampered with', async () => {
    const root = scratch();
    const outPath = resolve(root, 'out/run.json');
    const directory = checkpointDirectory(outPath);
    const plan = makePlan();
    const task = makeTask({ id: 'task-a' });

    await executeCalibration([task], {
      plan,
      source: SOURCE_A,
      outPath,
      jobs: 1,
      execute: async (t, source) => makeEvidence(t, source),
    });

    const path = resolve(directory, 'task-a.json');
    const stored = JSON.parse(readFileSync(path, 'utf8')) as {
      task: { seed: number };
    };
    stored.task.seed = 999;
    writeFileSync(path, JSON.stringify(stored));

    let executed = 0;
    const resumed = await executeCalibration([task], {
      plan,
      source: SOURCE_A,
      outPath,
      resume: true,
      jobs: 1,
      execute: async (t, source) => {
        executed += 1;
        return makeEvidence(t, source);
      },
    });

    expect(executed).toBe(1);
    expect(resumed.checkpoints.rejected[0]?.reason).toContain('task identity');
  });

  it('never resumes from a dirty working tree, because provenance cannot be validated', async () => {
    const root = scratch();
    const outPath = resolve(root, 'out/run.json');
    const plan = makePlan();
    const task = makeTask({ id: 'task-a' });

    await executeCalibration([task], {
      plan,
      source: SOURCE_A,
      outPath,
      jobs: 1,
      execute: async (t, source) => makeEvidence(t, source),
    });

    let executed = 0;
    const resumed = await executeCalibration([task], {
      plan,
      source: { sha: SHA_A, dirty: true },
      outPath,
      resume: true,
      jobs: 1,
      execute: async (t, source) => {
        executed += 1;
        return makeEvidence(t, source);
      },
    });

    expect(executed).toBe(1);
    expect(resumed.checkpoints.reused).toBe(0);
    expect(resumed.checkpoints.rejected[0]?.reason).toContain('dirty');
  });

  it('rejects unreadable checkpoint JSON and rewrites valid evidence', async () => {
    const root = scratch();
    const outPath = resolve(root, 'out/run.json');
    const directory = checkpointDirectory(outPath);
    const plan = makePlan();
    const task = makeTask({ id: 'task-a' });

    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, 'task-a.json'), '{ this is not json');

    const resumed = await executeCalibration([task], {
      plan,
      source: SOURCE_A,
      outPath,
      resume: true,
      jobs: 1,
      execute: async (t, source) => makeEvidence(t, source),
    });

    expect(resumed.checkpoints.rejected[0]?.reason).toContain('unreadable');
    expect(resumed.runs).toHaveLength(1);
    expect(readCheckpoint(directory, 'task-a').checkpoint?.task.id).toBe('task-a');
  });

  it('rejects malformed-but-parseable checkpoint case evidence instead of aborting resume', async () => {
    const root = scratch();
    const outPath = resolve(root, 'out/run.json');
    const directory = checkpointDirectory(outPath);
    const plan = makePlan();
    const task = makeTask({ id: 'task-a' });

    await executeCalibration([task], {
      plan,
      source: SOURCE_A,
      outPath,
      jobs: 1,
      execute: async (t, source) => makeEvidence(t, source),
    });

    const path = resolve(directory, 'task-a.json');
    const mutations: ((stored: Record<string, unknown>) => void)[] = [
      (stored) => {
        (stored.run as Record<string, unknown>).cases = [null];
      },
      (stored) => {
        const run = stored.run as { cases: Record<string, unknown>[] };
        delete run.cases[0]!.gates;
      },
    ];

    for (const mutate of mutations) {
      const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      mutate(stored);
      writeFileSync(path, JSON.stringify(stored));

      let executed = 0;
      const resumed = await executeCalibration([task], {
        plan,
        source: SOURCE_A,
        outPath,
        resume: true,
        jobs: 1,
        execute: async (t, source) => {
          executed += 1;
          return makeEvidence(t, source);
        },
      });

      expect(executed).toBe(1);
      expect(resumed.checkpoints.reused).toBe(0);
      expect(resumed.checkpoints.rejected).toHaveLength(1);
      expect(resumed.checkpoints.rejected[0]?.reason).toContain('schema');
      expect(resumed.runs).toHaveLength(1);
      expect(readCheckpoint(directory, 'task-a').checkpoint?.task.id).toBe('task-a');
    }
  });

  it('rejects checkpoint evidence written under a different Node runtime', async () => {
    const root = scratch();
    const outPath = resolve(root, 'out/run.json');
    const directory = checkpointDirectory(outPath);
    const plan = makePlan();
    const task = makeTask({ id: 'task-a' });

    await executeCalibration([task], {
      plan,
      source: SOURCE_A,
      outPath,
      jobs: 1,
      execute: async (t, source) => makeEvidence(t, source),
    });

    const path = resolve(directory, 'task-a.json');
    const stored = JSON.parse(readFileSync(path, 'utf8')) as {
      nodeVersion: string;
      run: { nodeVersion: string };
    };
    stored.nodeVersion = 'v0.0.0-other-runtime';
    stored.run.nodeVersion = 'v0.0.0-other-runtime';
    writeFileSync(path, JSON.stringify(stored));

    let executed = 0;
    const resumed = await executeCalibration([task], {
      plan,
      source: SOURCE_A,
      outPath,
      resume: true,
      jobs: 1,
      execute: async (t, source) => {
        executed += 1;
        return makeEvidence(t, source);
      },
    });

    expect(executed).toBe(1);
    expect(resumed.checkpoints.reused).toBe(0);
    expect(resumed.checkpoints.rejected[0]?.reason).toContain('runtime');
    expect(resumed.runs).toHaveLength(1);
    expect(readCheckpoint(directory, 'task-a').checkpoint?.nodeVersion).toBe(process.version);
  });

  it('fails loudly on oversized evidence and leaves any previous complete checkpoint intact', () => {
    const root = scratch();
    const directory = resolve(root, 'checkpoints');
    const task = makeTask({ id: 'task-a' });
    const good = createCheckpoint(
      task,
      makeEvidence(task, SOURCE_A),
      { planDigest: planFingerprint(makePlan()), source: SOURCE_A },
      '2026-11-09T00:00:00.000Z',
    );

    writeCheckpoint(directory, good);
    expect(readdirSync(directory)).toEqual(['task-a.json']);

    const oversized = { ...good, writtenAt: 'x'.repeat(CHECKPOINT_MAX_BYTES + 1024) };
    expect(() => writeCheckpoint(directory, oversized)).toThrow(/above the .* evidence bound/);

    expect(readdirSync(directory)).toEqual(['task-a.json']);
    expect(readCheckpoint(directory, 'task-a').checkpoint?.writtenAt).toBe(
      '2026-11-09T00:00:00.000Z',
    );
  });
});

describe('calibration matrix completion verdict', () => {
  const plan = makePlan();
  const tasks = [makeTask({ id: 'task-a' }), makeTask({ id: 'task-b' })];
  const plannedTaskIds = tasks.map((task) => task.id);

  it('only allows a calibration PASS when every planned task holds evidence', () => {
    const runs = tasks.map((task) => makeEvidence(task, SOURCE_A));
    const complete = summarizeMatrix({
      plan,
      runs,
      controls: controlsFor(plan),
      failures: [],
      missing: [],
      plannedTaskIds,
    });
    expect(complete.matrixComplete).toBe(true);
    expect(complete.calibrationPass).toBe(true);

    const failed = summarizeMatrix({
      plan,
      runs: [runs[0]!],
      controls: controlsFor(plan),
      failures: [{ id: 'task-b', error: 'worker crashed' }],
      missing: [],
      plannedTaskIds,
    });
    expect(failed.matrixComplete).toBe(false);
    expect(failed.calibrationPass).toBe(false);

    const missing = summarizeMatrix({
      plan,
      runs: [runs[0]!],
      controls: controlsFor(plan),
      failures: [],
      missing: ['task-b'],
      plannedTaskIds,
    });
    expect(missing.missingTaskIds).toEqual(['task-b']);
    expect(missing.calibrationPass).toBe(false);

    const short = summarizeMatrix({
      plan,
      runs: [runs[0]!],
      controls: controlsFor(plan),
      failures: [],
      missing: [],
      plannedTaskIds,
    });
    expect(short.matrixComplete).toBe(false);
    expect(short.calibrationPass).toBe(false);
  });

  it('still refuses PASS when coverage is complete but a harness check fails', () => {
    const runs = tasks.map((task) => makeEvidence(task, SOURCE_A));
    const failingControl: ControlEvidence[] = [
      {
        id: 'stale-cache',
        title: 'Stale cache',
        expectation: 'must not qualify',
        expectationMet: false,
        detail: 'synthetic negative control unexpectedly met',
      },
    ];
    const summary = summarizeMatrix({
      plan: makePlan({ controls: ['stale-cache'] }),
      runs,
      controls: failingControl,
      failures: [],
      missing: [],
      plannedTaskIds,
    });
    expect(summary.matrixComplete).toBe(true);
    expect(summary.controlsFailAsDesigned).toBe(false);
    expect(summary.calibrationPass).toBe(false);
  });
});
