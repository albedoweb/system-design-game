import { makeNode, type GraphDocument, type NodeConfig } from '../../domain/graph';
import { DEFAULT_LEVEL, type LevelDefinition } from '../../domain/level';
import type { ValidationIssue } from '../../domain/errors';
import type {
  LevelSlo,
  LevelTiming,
  LevelWorkloads,
  SchedulePoint,
} from '../../domain/level';
import { createSimulationFromTrace, type SimulationHandle } from '../index';
import type { OfferedRequest, OfferedTrace, TrafficClass } from '../workload';

export interface TestLevelOptions {
  durationMs?: number;
  warmupMs?: number;
  drainMs?: number;
  deadlineMs?: number;
  flushAtMs?: number | null;
  readSchedule?: SchedulePoint[];
  writeSchedule?: SchedulePoint[];
  read?: Partial<LevelWorkloads['read']>;
  write?: Partial<LevelWorkloads['write']>;
  timing?: Partial<LevelTiming>;
  slo?: Partial<LevelSlo>;
}

function cloneBase(): LevelDefinition {
  return JSON.parse(JSON.stringify(DEFAULT_LEVEL)) as LevelDefinition;
}

/**
 * Small, validated level for deterministic tests. Defaults: 1 read/s,
 * no writes, 1 s evaluation, no warmup, no flush.
 */
export function testLevel(options: TestLevelOptions = {}): LevelDefinition {
  const level = cloneBase();
  const durationMs = options.durationMs ?? 1000;
  level.durationMs = durationMs;
  level.warmupMs = options.warmupMs ?? 0;
  level.drainMs = options.drainMs ?? 800;
  level.deadlineMs = options.deadlineMs ?? Math.min(800, durationMs);
  level.flushAtMs = options.flushAtMs ?? null;
  level.workloads = {
    read: {
      ...level.workloads.read,
      ...options.read,
      schedule: options.readSchedule ?? [{ atMs: 0, rps: 1 }],
    },
    write: {
      ...level.workloads.write,
      ...options.write,
      schedule: options.writeSchedule ?? [{ atMs: 0, rps: 0 }],
    },
  };
  level.timing = { ...level.timing, ...options.timing };
  level.slo = {
    ...level.slo,
    criticalFromMs: 0,
    criticalToMs: Math.min(level.slo.criticalToMs, durationMs),
    ...options.slo,
  };
  level.refs = { ...level.refs, calibrationSeeds: [101], holdoutSeeds: [] };
  return level;
}

export interface GraphOptions {
  app?: Partial<NodeConfig>;
  cache?: Partial<NodeConfig> | null;
  database?: Partial<NodeConfig>;
  clientToLoadBalancer?: boolean;
  apps?: number;
}

function connect(
  edges: GraphDocument['edges'],
  id: string,
  source: string,
  target: string,
  sourcePort: GraphDocument['edges'][number]['sourcePort'],
): void {
  edges.push({ id, source, target, sourcePort });
}

/** Single-app graph: client → app; reads → cache (or DB); writes → DB. */
export function testGraph(options: GraphOptions = {}): GraphDocument {
  const nodes: GraphDocument['nodes'] = [
    makeNode('client', 'client-1', { x: 0, y: 0 }),
    makeNode('appServer', 'app-1', { x: 100, y: 0 }, { config: options.app }),
  ];
  const edges: GraphDocument['edges'] = [];

  if (options.clientToLoadBalancer) {
    nodes.push(makeNode('loadBalancer', 'lb-1', { x: 50, y: 0 }));
  }

  const appCount = options.apps ?? 1;
  for (let index = 1; index < appCount; index += 1) {
    nodes.push(
      makeNode('appServer', `app-${index + 1}`, { x: 100, y: index * 60 }, {
        config: options.app,
      }),
    );
  }

  const cacheConfig = options.cache;
  const withCache = cacheConfig !== null;
  if (withCache) {
    nodes.push(
      makeNode('cache', 'cache-1', { x: 200, y: -40 }, { config: cacheConfig ?? undefined }),
    );
  }
  nodes.push(makeNode('database', 'db-1', { x: 300, y: 0 }, { config: options.database }));

  if (options.clientToLoadBalancer) {
    connect(edges, 'e-client-lb', 'client-1', 'lb-1', 'out');
  }

  for (let index = 0; index < appCount; index += 1) {
    const appId = `app-${index + 1}`;
    if (options.clientToLoadBalancer) {
      connect(edges, `e-lb-${appId}`, 'lb-1', appId, 'out');
    } else {
      connect(edges, `e-client-${appId}`, 'client-1', appId, 'out');
    }
    connect(
      edges,
      `e-${appId}-read`,
      appId,
      withCache ? 'cache-1' : 'db-1',
      'read',
    );
    connect(edges, `e-${appId}-write`, appId, 'db-1', 'write');
  }
  if (withCache) {
    connect(edges, 'e-cache-db', 'cache-1', 'db-1', 'miss');
  }

  return {
    schemaVersion: 1,
    levelId: 'cold-cache',
    nodes,
    edges,
  };
}

export function offered(
  trafficClass: TrafficClass,
  index: number,
  arrivalMs: number,
  key: number,
  scored = arrivalMs >= 0,
): OfferedRequest {
  return {
    logicalId: `${trafficClass}-${index}`,
    trafficClass,
    index,
    key,
    arrivalMs,
    scored,
  };
}

export function makeTrace(
  requests: OfferedRequest[],
  seed = 101,
): OfferedTrace {
  return { seed, requests };
}

export function runTrace(
  graph: GraphDocument,
  level: LevelDefinition,
  requests: OfferedRequest[],
  seed = 101,
  chunkMs = 0,
): SimulationHandle {
  const engine = createSimulationFromTrace(graph, level, makeTrace(requests, seed));
  const end = level.durationMs + level.drainMs;
  if (chunkMs <= 0) {
    engine.advance(end);
    return engine;
  }
  let time = -level.warmupMs;
  while (time < end) {
    time = Math.min(end, time + chunkMs);
    engine.advance(time);
  }
  return engine;
}

export function expectNoIssues(issues: ValidationIssue[]): void {
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => issue.message).join('; '));
  }
}

