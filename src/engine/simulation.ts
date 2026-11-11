import { calculateCost } from '../domain/catalog';
import {
  type Diagnostic,
  type NodeMetric,
  type RunResult,
  type SimulationEvent,
  type SimulationPhase,
  type SimulationSnapshot,
} from '../domain/simulation';
import type { SimulationEngine } from '../domain/worker';
import type { GraphEdge } from '../domain/graph';
import type {
  TrafficFrame,
  TrafficNode,
  TrafficResource,
} from '../simulation/traffic-telemetry';
import { KeyedTtlLru } from './cache';
import { EVENT_PRIORITY, SimulationEventHeap } from './eventHeap';
import { SimulationInputError, SimulationLimitError } from './errors';
import { ClassMetrics, Telemetry } from './metrics';
import { PressureTracker } from './pressure';
import { buildChecks, buildDiagnostics, type PressureNodeSummary } from './result';
import {
  TrafficSampler,
  type TrafficScope,
} from './trafficSampling';
import type {
  AppRuntime,
  CacheRuntime,
  CompiledScenario,
  DbOperation,
  Fill,
  Request,
  RequestStage,
} from './types';
import type { OfferedTrace } from './workload';

/** Hard stop for pathological graphs; the shipped level stays far below it. */
export const MAX_EVENTS = 5_000_000;

export interface SimulationStats {
  eventsProcessed: number;
  offeredArrivals: number;
}

interface NodeCounters {
  hits: number;
  misses: number;
  coalesced: number;
  errors: number;
  completed: number;
}

function emptyCounters(): NodeCounters {
  return { hits: 0, misses: 0, coalesced: 0, errors: 0, completed: 0 };
}

function removeFromArray<T>(items: T[], item: T): boolean {
  const index = items.indexOf(item);
  if (index < 0) {
    return false;
  }
  items.splice(index, 1);
  return true;
}

/**
 * Deterministic discrete-event simulation of one run. All times are
 * evaluation-relative milliseconds; `advance` never consults wall-clock time.
 */
export class Simulation implements SimulationEngine {
  private readonly scenario: CompiledScenario;
  private readonly trace: OfferedTrace;
  private readonly heap = new SimulationEventHeap();
  private readonly reads = new ClassMetrics();
  private readonly writes = new ClassMetrics();
  private readonly telemetry: Telemetry;
  private readonly pressure: PressureTracker;
  private readonly counters = new Map<string, NodeCounters>();
  private readonly keyVersions = new Map<number, number>();
  private readonly fills = new Map<number, Fill>();
  private readonly active = new Set<Request>();
  private readonly eventLog: SimulationEvent[] = [];
  private readonly overflowLogged = new Set<string>();
  private readonly cacheStore?: KeyedTtlLru;
  private readonly startMs: number;
  private readonly endMs: number;
  private readonly clientNodeId: string;

  private clock: number;
  private lastAdvance: number;
  private eventsProcessed = 0;
  private finished = false;
  private finalResult?: RunResult;

  private readonly traffic: TrafficSampler;
  private readonly trafficScope: TrafficScope;
  private readonly trafficEdges = new Map<string, GraphEdge>();
  private readonly trafficGauges = new Map<
    string,
    {
      lastAt: number;
      busy: number;
      poolBusy: number;
      busyArea: number;
      poolArea: number;
      sampledBusyArea: number;
      sampledPoolArea: number;
    }
  >();

  constructor(scenario: CompiledScenario, trace: OfferedTrace) {
    this.scenario = scenario;
    this.trace = trace;
    this.telemetry = new Telemetry(scenario.level.durationMs, scenario.level.drainMs);
    this.pressure = new PressureTracker(
      scenario.graph.nodes.map((node) => node.id),
      scenario.level.durationMs,
    );
    this.startMs = -scenario.level.warmupMs;
    this.endMs = scenario.level.durationMs + scenario.level.drainMs;
    this.clock = this.startMs;
    this.lastAdvance = this.startMs;
    this.clientNodeId =
      scenario.graph.nodes.find((node) => node.kind === 'client')?.id ?? '';

    for (const node of scenario.graph.nodes) {
      this.counters.set(node.id, emptyCounters());
    }
    this.trafficScope = {
      levelId: 'cold-cache',
      scopeId: 'cold-cache',
      scopeLabel: scenario.level.title,
      startMs: this.startMs,
      measuredFromMs: 0,
      measuredEndMs: scenario.level.durationMs,
      drainEndMs: this.endMs,
      postludeEndMs: this.endMs,
    };
    for (const edge of scenario.graph.edges) {
      this.trafficEdges.set(
        `${edge.source}|${edge.target}|${edge.sourcePort}`,
        edge,
      );
    }
    this.traffic = new TrafficSampler(
      scenario.graph.edges.map((edge) => edge.id),
      scenario.graph.nodes.map((node) => node.id),
      this.trafficScope,
    );
    // The Cold Cache seam is always ready: the worker runtime and a direct
    // caller may read frames at any later time, so bounded counters and gauge
    // integrals must have been collected from the start. This is a small,
    // fixed per-dispatch/per-change overhead (no per-request retention), not
    // an observer that can be enabled retroactively.
    for (const node of scenario.graph.nodes) {
      this.trafficGauges.set(node.id, {
        lastAt: this.startMs,
        busy: 0,
        poolBusy: 0,
        busyArea: 0,
        poolArea: 0,
        sampledBusyArea: 0,
        sampledPoolArea: 0,
      });
    }
    if (scenario.cache) {
      this.cacheStore = new KeyedTtlLru(
        scenario.cache.capacityEntries,
        scenario.cache.ttlMs,
      );
    }

    this.heap.push(0, EVENT_PRIORITY.reset, () => this.resetEvaluationMetrics());
    if (scenario.level.flushAtMs !== null) {
      this.heap.push(scenario.level.flushAtMs, EVENT_PRIORITY.flush, () =>
        this.flushCache(),
      );
    }
    for (const request of trace.requests) {
      this.heap.push(request.arrivalMs, EVENT_PRIORITY.arrival, () =>
        this.acceptArrival(request),
      );
    }
  }

  get done(): boolean {
    return this.finished;
  }

  get stats(): SimulationStats {
    return {
      eventsProcessed: this.eventsProcessed,
      offeredArrivals: this.trace.requests.length,
    };
  }

  /**
   * Read-only inspection seam for tests and diagnostics. The offered trace is
   * fixed when the engine is created, so it is identical for every
   * architecture and every advance chunk size. Returns copies so callers
   * cannot mutate run state.
   */
  offeredTrace(): OfferedTrace {
    return {
      seed: this.trace.seed,
      requests: this.trace.requests.map((request) => ({ ...request })),
    };
  }

  advance(untilMs: number): SimulationSnapshot {
    if (!Number.isFinite(untilMs)) {
      throw new SimulationInputError(`Non-finite advance time: ${untilMs}`);
    }
    if (untilMs < this.lastAdvance) {
      throw new SimulationInputError(
        `Time cannot decrease: ${untilMs} < ${this.lastAdvance}`,
      );
    }
    if (untilMs > this.endMs) {
      throw new SimulationInputError(
        `Time ${untilMs} ms is beyond the horizon of ${this.endMs} ms`,
      );
    }

    for (;;) {
      const next = this.heap.peek();
      if (!next || next.timeMs > untilMs) {
        break;
      }
      const event = this.heap.pop();
      if (!event) {
        break;
      }
      this.clock = event.timeMs;
      event.run();
      this.eventsProcessed += 1;
      if (this.eventsProcessed > MAX_EVENTS) {
        throw new SimulationLimitError(
          'events',
          this.eventsProcessed,
          MAX_EVENTS,
        );
      }
    }

    this.clock = untilMs;
    this.lastAdvance = untilMs;
    this.telemetry.sync(this.clock, this.scenario.database.queue.length);
    if (untilMs === this.endMs) {
      this.finalize();
      this.finished = true;
    }
    return this.snapshot(untilMs);
  }

  result(): RunResult {
    if (!this.finished) {
      throw new SimulationInputError(
        'Result unavailable: finish the simulation first',
      );
    }
    if (this.finalResult) {
      return this.finalResult;
    }

    const cost = calculateCost(this.scenario.graph);
    const checks = buildChecks(
      this.scenario.level,
      this.reads,
      this.writes,
      cost,
    );

    this.finalResult = {
      seed: this.trace.seed,
      passed: checks.every((check) => check.passed),
      costMicroUsdPerHour: cost,
      checks,
      snapshot: this.snapshot(this.endMs),
      diagnostics: this.buildDiagnostics(cost),
    };
    return this.finalResult;
  }

  // ---------------------------------------------------------------------
  // Traffic intake
  // ---------------------------------------------------------------------

  private acceptArrival(entry: OfferedTrace['requests'][number]): void {
    const metrics = entry.trafficClass === 'read' ? this.reads : this.writes;
    const critical =
      entry.scored &&
      entry.arrivalMs >= this.scenario.level.slo.criticalFromMs &&
      entry.arrivalMs < this.scenario.level.slo.criticalToMs;

    const request: Request = {
      logicalId: entry.logicalId,
      trafficClass: entry.trafficClass,
      key: entry.key,
      arrivalMs: entry.arrivalMs,
      deadlineAt: entry.arrivalMs + this.scenario.level.deadlineMs,
      scored: entry.scored,
      critical,
      status: 'active',
      viaLb: false,
      stage: 'client',
      holdsAppSlot: false,
      holdsPool: false,
    };
    this.traceNode(this.clientNodeId);
    const firstTarget = this.scenario.clientTarget;
    this.traceEdge(
      this.clientNodeId,
      firstTarget.kind === 'app' ? firstTarget.app.node.id : firstTarget.lb.node.id,
      'out',
    );

    if (request.scored) {
      metrics.recordOffered(critical);
      this.telemetry.recordArrival(request.trafficClass, request.arrivalMs);
    }
    this.active.add(request);

    this.heap.push(request.deadlineAt, EVENT_PRIORITY.timeout, () =>
      this.handleTimeout(request),
    );
    // External RTT is separate from the graph edge: the client pays its own
    // 5 ms in, then every graph edge (starting with client→first node) pays
    // half of `edgeRttMs` in each direction.
    this.heap.push(
      this.clock + this.scenario.level.timing.clientRttMs / 2,
      EVENT_PRIORITY.completion,
      () => this.afterClientIn(request),
    );
  }

  /** External client-in RTT has elapsed; now cross client→first node. */
  private afterClientIn(request: Request): void {
    if (request.status !== 'active') {
      return;
    }
    this.heap.push(
      this.clock + this.scenario.level.timing.edgeRttMs / 2,
      EVENT_PRIORITY.completion,
      () => this.afterClientEdge(request),
    );
  }

  private afterClientEdge(request: Request): void {
    if (request.status !== 'active') {
      return;
    }
    const target = this.scenario.clientTarget;
    if (target.kind === 'app') {
      this.admitApp(request, target.app);
      return;
    }

    request.viaLb = true;
    request.stage = 'lb';
    const loadBalancer = target.lb;
    this.heap.push(
      this.clock + this.scenario.level.timing.lbMs,
      EVENT_PRIORITY.completion,
      () => {
        if (request.status !== 'active') {
          return;
        }
        if (loadBalancer.apps.length === 0) {
          this.failRequest(
            request,
            'no_route',
            this.clock,
            loadBalancer.node.id,
            'lb',
          );
          return;
        }
        const app =
          loadBalancer.apps[loadBalancer.cursor % loadBalancer.apps.length];
        loadBalancer.cursor += 1;
        if (!app) {
          this.failRequest(
            request,
            'no_route',
            this.clock,
            loadBalancer.node.id,
            'lb',
          );
          return;
        }
        this.traceNode(loadBalancer.node.id);
        this.traceEdge(loadBalancer.node.id, app.node.id, 'out');
        this.heap.push(
          this.clock + this.scenario.level.timing.edgeRttMs / 2,
          EVENT_PRIORITY.completion,
          () => this.admitApp(request, app),
        );
      },
    );
  }

  private admitApp(request: Request, app: AppRuntime): void {
    if (request.status !== 'active') {
      return;
    }
    this.traceNode(app.node.id);
    request.app = app;
    if (app.slots < app.capacity) {
      this.startAppSlot(app, request);
      return;
    }
    if (app.queue.length < app.queueLimit) {
      request.stage = 'appQueue';
      app.queue.push({ req: request, enqueuedAt: this.clock });
      app.maxQueued = Math.max(app.maxQueued, app.queue.length);
      return;
    }
    this.failRequest(
      request,
      'queue_overflow',
      this.clock,
      app.node.id,
      'appQueue',
    );
  }

  private startAppSlot(app: AppRuntime, request: Request): void {
    app.slots += 1;
    request.holdsAppSlot = true;
    request.stage = 'appCpu';
    this.updateAppPressure(app);
    this.heap.push(
      this.clock + this.scenario.level.timing.appCpuMs,
      EVENT_PRIORITY.completion,
      () => this.afterAppCpu(request),
    );
  }

  private afterAppCpu(request: Request): void {
    if (request.status !== 'active') {
      this.releasePoolAndSlot(request);
      return;
    }
    if (!request.app) {
      return;
    }
    this.acquireAppPool(request.app, request);
  }

  private acquireAppPool(app: AppRuntime, request: Request): void {
    if (app.poolBusy < app.poolSize) {
      app.poolBusy += 1;
      request.holdsPool = true;
      this.updateAppPressure(app);
      this.startDependencyCall(request);
      return;
    }
    request.stage = 'poolQueue';
    request.poolContinuation = () => {
      request.poolContinuation = undefined;
      this.startDependencyCall(request);
    };
    app.poolWaiters.push(request);
    this.updateAppPressure(app);
  }

  private startDependencyCall(request: Request): void {
    if (request.status !== 'active') {
      this.releasePoolAndSlot(request);
      return;
    }
    request.stage = 'edgeToDependency';
    this.heap.push(
      this.clock + this.scenario.level.timing.edgeRttMs / 2,
      EVENT_PRIORITY.completion,
      () => {
        if (request.status !== 'active') {
          this.releasePoolAndSlot(request);
          return;
        }
        if (request.trafficClass === 'read') {
          const route = request.app?.read;
          if (!route) {
            this.failRequest(request, 'no_route', this.clock, request.app?.node.id);
            this.releasePoolAndSlot(request);
            return;
          }
          const appId = request.app?.node.id;
          if (appId) {
            this.traceEdge(
              appId,
              route.kind === 'cache' ? route.cache.node.id : route.database.node.id,
              'read',
            );
          }
          if (route.kind === 'cache') {
            this.lookupCache(request, route.cache);
          } else {
            this.enqueueDbRequest(request, 'read');
          }
        } else {
          const database = request.app?.write;
          if (!database) {
            this.failRequest(request, 'no_route', this.clock, request.app?.node.id);
            this.releasePoolAndSlot(request);
            return;
          }
          const appId = request.app?.node.id;
          if (appId) {
            this.traceEdge(appId, database.node.id, 'write');
          }
          this.enqueueDbRequest(request, 'write');
        }
      },
    );
  }

  private releasePoolAndSlot(request: Request): void {
    const app = request.app;
    if (request.holdsPool && app) {
      request.holdsPool = false;
      this.releaseAppPool(app);
    }
    if (request.holdsAppSlot && app) {
      request.holdsAppSlot = false;
      app.slots = Math.max(0, app.slots - 1);
      this.admitQueuedApp(app);
      this.updateAppPressure(app);
    }
  }

  private releaseAppPool(app: AppRuntime): void {
    app.poolBusy = Math.max(0, app.poolBusy - 1);
    while (app.poolBusy < app.poolSize && app.poolWaiters.length > 0) {
      const waiter = app.poolWaiters.shift();
      if (!waiter) {
        break;
      }
      if (waiter.status !== 'active' || waiter.stage !== 'poolQueue') {
        continue;
      }
      app.poolBusy += 1;
      waiter.holdsPool = true;
      const continuation = waiter.poolContinuation;
      waiter.poolContinuation = undefined;
      continuation?.();
    }
    this.updateAppPressure(app);
  }

  private admitQueuedApp(app: AppRuntime): void {
    while (app.slots < app.capacity && app.queue.length > 0) {
      const queued = app.queue.shift();
      if (!queued) {
        break;
      }
      if (queued.req.status !== 'active') {
        continue;
      }
      this.startAppSlot(app, queued.req);
    }
  }

  // ---------------------------------------------------------------------
  // Cache
  // ---------------------------------------------------------------------

  private lookupCache(request: Request, cache: CacheRuntime): void {
    request.stage = 'cacheLookup';
    this.traceNode(cache.node.id);
    this.heap.push(
      this.clock + this.scenario.level.timing.cacheLookupMs,
      EVENT_PRIORITY.completion,
      () => {
        if (request.status !== 'active') {
          return;
        }
        const hit = this.cacheStore?.lookup(request.key, this.clock) ?? false;
        if (request.scored) {
          const counters = this.counter(cache.node.id);
          if (hit) {
            counters.hits += 1;
          } else {
            counters.misses += 1;
          }
          this.telemetry.recordLookup(this.clock, hit);
        }
        if (hit) {
          this.scheduleCacheResponse(request);
          return;
        }
        this.cacheMiss(request, cache);
      },
    );
  }

  private cacheMiss(request: Request, cache: CacheRuntime): void {
    if (cache.coalescing) {
      const existing = this.fills.get(request.key);
      if (existing) {
        existing.waiters.push(request);
        request.fill = existing;
        request.stage = 'fillWait';
        if (request.scored) {
          this.counter(cache.node.id).coalesced += 1;
        }
        return;
      }
    }

    const fill: Fill = {
      key: request.key,
      owner: request,
      version: this.versionOf(request.key),
      waiters: [request],
      backendHeld: false,
      cancelled: false,
      dbStarted: false,
    };
    request.fill = fill;
    request.stage = 'backendQueue';
    this.fills.set(request.key, fill);
    this.admitBackend(cache, fill);
  }

  private admitBackend(cache: CacheRuntime, fill: Fill): void {
    if (fill.cancelled) {
      return;
    }
    if (cache.backendBusy < cache.poolSize) {
      cache.backendBusy += 1;
      fill.backendHeld = true;
      this.updateCachePressure(cache);
      this.startBackendFetch(fill);
      return;
    }
    if (cache.backendQueue.length < cache.queueLimit) {
      cache.backendQueue.push(fill);
      cache.maxQueued = Math.max(cache.maxQueued, cache.backendQueue.length);
      this.updateCachePressure(cache);
      return;
    }
    this.failFill(fill, 'queue_overflow', {
      nodeId: cache.node.id,
      stage: 'backendQueue',
    });
  }

  private startBackendFetch(fill: Fill): void {
    const cache = this.scenario.cache;
    if (cache) {
      this.traceEdge(cache.node.id, this.scenario.database.node.id, 'miss');
    }
    this.heap.push(
      this.clock + this.scenario.level.timing.edgeRttMs / 2,
      EVENT_PRIORITY.completion,
      () => {
        if (fill.cancelled) {
          return;
        }
        const operation: DbOperation = {
          kind: 'read',
          key: fill.key,
          fill,
          started: false,
          onDone: () => this.finishFill(fill),
        };
        fill.dbOp = operation;
        this.enqueueDb(operation);
      },
    );
  }

  private finishFill(fill: Fill): void {
    const cache = this.scenario.cache;
    if (!cache) {
      return;
    }
    if (this.fills.get(fill.key) === fill) {
      this.fills.delete(fill.key);
    }
    fill.dbOp = undefined;
    fill.dbStarted = false;
    this.releaseBackend(cache);
    if (!fill.cancelled && fill.version === this.versionOf(fill.key)) {
      this.cacheStore?.store(fill.key, this.clock);
    }

    const waiters = fill.waiters;
    fill.waiters = [];
    for (const waiter of waiters) {
      if (waiter.status === 'active') {
        waiter.stage = 'edgeResponse';
        this.scheduleCacheResponse(waiter);
      } else {
        this.releasePoolAndSlot(waiter);
      }
    }
  }

  private scheduleCacheResponse(request: Request): void {
    this.heap.push(
      this.clock + this.scenario.level.timing.edgeRttMs / 2,
      EVENT_PRIORITY.completion,
      () => this.finishDependency(request),
    );
  }

  private releaseBackend(cache: CacheRuntime): void {
    cache.backendBusy = Math.max(0, cache.backendBusy - 1);
    while (
      cache.backendBusy < cache.poolSize &&
      cache.backendQueue.length > 0
    ) {
      const next = cache.backendQueue.shift();
      if (!next) {
        break;
      }
      if (next.cancelled) {
        continue;
      }
      cache.backendBusy += 1;
      next.backendHeld = true;
      this.startBackendFetch(next);
    }
    this.updateCachePressure(cache);
  }

  private failFill(
    fill: Fill,
    code: string,
    location?: { nodeId?: string; stage?: RequestStage },
  ): void {
    if (fill.cancelled) {
      return;
    }
    fill.cancelled = true;
    if (this.fills.get(fill.key) === fill) {
      this.fills.delete(fill.key);
    }
    const cache = this.scenario.cache;
    if (!cache) {
      return;
    }
    if (fill.backendHeld) {
      fill.backendHeld = false;
      this.releaseBackend(cache);
    } else {
      removeFromArray(cache.backendQueue, fill);
      this.updateCachePressure(cache);
    }

    const waiters = fill.waiters;
    fill.waiters = [];
    for (const waiter of waiters) {
      if (waiter.status === 'active') {
        this.failRequest(
          waiter,
          code,
          this.clock,
          cache.node.id,
          location?.stage,
          location?.nodeId,
        );
        this.releasePoolAndSlot(waiter);
      }
    }
  }

  private removeWaiter(fill: Fill, request: Request): void {
    removeFromArray(fill.waiters, request);
    this.cancelIdleFill(fill);
  }

  /** Cancel a fill that has not started database work and has no waiters. */
  private cancelIdleFill(fill: Fill): void {
    if (fill.cancelled || fill.waiters.length > 0 || fill.dbStarted) {
      return;
    }
    fill.cancelled = true;
    if (this.fills.get(fill.key) === fill) {
      this.fills.delete(fill.key);
    }
    const cache = this.scenario.cache;
    if (cache) {
      if (fill.backendHeld) {
        fill.backendHeld = false;
        this.releaseBackend(cache);
      } else {
        removeFromArray(cache.backendQueue, fill);
        this.updateCachePressure(cache);
      }
    }
    if (fill.dbOp && !fill.dbOp.started) {
      removeFromArray(this.scenario.database.queue, fill.dbOp);
      fill.dbOp = undefined;
      this.telemetry.recordDbQueue(
        this.clock,
        this.scenario.database.queue.length,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Database
  // ---------------------------------------------------------------------

  private enqueueDbRequest(request: Request, kind: 'read' | 'write'): void {
    const operation: DbOperation = {
      kind,
      key: request.key,
      req: request,
      started: false,
      onDone: () => this.finishDependency(request),
    };
    request.dbOp = operation;
    this.enqueueDb(operation);
  }

  private enqueueDb(operation: DbOperation): void {
    const database = this.scenario.database;
    this.traceNode(database.node.id);
    if (database.slots < database.capacity) {
      this.startDb(operation);
      return;
    }
    if (database.queue.length < database.queueLimit) {
      database.queue.push(operation);
      database.maxQueued = Math.max(database.maxQueued, database.queue.length);
      this.telemetry.recordDbQueue(this.clock, database.queue.length);
      if (operation.req) {
        operation.req.stage = 'dbQueue';
      }
      return;
    }
    this.failDbOperation(operation, 'queue_overflow');
  }

  private startDb(operation: DbOperation): void {
    const database = this.scenario.database;
    database.slots += 1;
    operation.started = true;
    if (operation.fill) {
      operation.fill.dbStarted = true;
      operation.fill.version = this.versionOf(operation.key);
      for (const waiter of operation.fill.waiters) {
        if (waiter.status === 'active') {
          waiter.stage = 'dbExecuting';
        }
      }
    }
    if (operation.req) {
      operation.req.stage = 'dbExecuting';
    }
    this.updateDbPressure();
    const serviceMs =
      operation.kind === 'write'
        ? this.scenario.level.timing.dbWriteMs
        : this.scenario.level.timing.dbReadMs;
    this.heap.push(this.clock + serviceMs, EVENT_PRIORITY.completion, () =>
      this.completeDb(operation),
    );
  }

  private completeDb(operation: DbOperation): void {
    const database = this.scenario.database;
    database.slots = Math.max(0, database.slots - 1);
    if (operation.kind === 'write') {
      this.commitWrite(operation.key);
    }
    this.admitNextDb();
    this.updateDbPressure();
    this.telemetry.recordDbQueue(this.clock, database.queue.length);

    const scored = operation.req
      ? operation.req.scored
      : (operation.fill?.owner.scored ?? false);
    if (scored) {
      this.counter(database.node.id).completed += 1;
    }

    this.heap.push(
      this.clock + this.scenario.level.timing.edgeRttMs / 2,
      EVENT_PRIORITY.completion,
      () => operation.onDone(this.clock),
    );
  }

  private admitNextDb(): void {
    const database = this.scenario.database;
    while (database.slots < database.capacity && database.queue.length > 0) {
      const next = database.queue.shift();
      if (!next) {
        break;
      }
      if (next.started || next.fill?.cancelled) {
        continue;
      }
      if (next.req && next.req.status !== 'active') {
        continue;
      }
      this.startDb(next);
    }
  }

  private failDbOperation(operation: DbOperation, code: string): void {
    const database = this.scenario.database;
    if (operation.fill) {
      this.failFill(operation.fill, code, {
        nodeId: database.node.id,
        stage: 'dbQueue',
      });
      return;
    }
    if (operation.req) {
      operation.req.dbOp = undefined;
      this.failRequest(
        operation.req,
        code,
        this.clock,
        database.node.id,
        'dbQueue',
      );
      this.releasePoolAndSlot(operation.req);
    }
  }

  private commitWrite(key: number): void {
    const invalidationMs = this.scenario.level.timing.invalidationMs;
    this.heap.push(
      this.clock + invalidationMs,
      EVENT_PRIORITY.invalidation,
      () => {
        this.keyVersions.set(key, this.versionOf(key) + 1);
        this.cacheStore?.remove(key);
      },
    );
  }

  private versionOf(key: number): number {
    return this.keyVersions.get(key) ?? 0;
  }

  // ---------------------------------------------------------------------
  // Completion, failure and lifecycle
  // ---------------------------------------------------------------------

  private finishDependency(request: Request): void {
    this.releasePoolAndSlot(request);
    if (request.status !== 'active') {
      return;
    }
    request.dbOp = undefined;
    request.fill = undefined;
    request.stage = 'edgeResponse';

    const clientOut = () => this.completeSuccess(request, this.clock);
    const clientHalf = this.scenario.level.timing.clientRttMs / 2;
    const edgeHalf = this.scenario.level.timing.edgeRttMs / 2;
    // Return trip mirrors the request path: every traversed edge pays half
    // RTT (app→client directly, or app→LB→client), then external RTT out.
    const clientEdgeOut = () => {
      this.heap.push(this.clock + clientHalf, EVENT_PRIORITY.completion, clientOut);
    };
    if (request.viaLb) {
      this.heap.push(
        this.clock + edgeHalf,
        EVENT_PRIORITY.completion,
        () => {
          this.heap.push(
            this.clock + edgeHalf,
            EVENT_PRIORITY.completion,
            clientEdgeOut,
          );
        },
      );
    } else {
      this.heap.push(
        this.clock + edgeHalf,
        EVENT_PRIORITY.completion,
        clientEdgeOut,
      );
    }
  }

  private completeSuccess(request: Request, atMs: number): void {
    if (request.status !== 'active') {
      return;
    }
    request.status = 'succeeded';
    request.stage = 'done';
    this.active.delete(request);
    const latency = atMs - request.arrivalMs;
    request.dbOp = undefined;
    request.fill = undefined;
    if (request.scored) {
      const metrics = request.trafficClass === 'read' ? this.reads : this.writes;
      metrics.recordSuccess(latency, request.critical);
      this.telemetry.recordCompletion(atMs, latency);
      if (request.app) {
        this.counter(request.app.node.id).completed += 1;
      }
    }
  }

  private failRequest(
    request: Request,
    code: string,
    atMs: number,
    nodeId?: string,
    stage?: RequestStage,
    pressureNodeId?: string,
  ): void {
    if (request.status !== 'active') {
      return;
    }
    request.status = 'failed';
    this.active.delete(request);
    if (request.scored) {
      const metrics = request.trafficClass === 'read' ? this.reads : this.writes;
      metrics.recordFailure(code, request.critical);
      this.telemetry.recordCompletion(atMs, null);
      const location = this.failureLocation(
        request,
        pressureNodeId ?? nodeId,
        stage,
      );
      if (location.nodeId) {
        this.pressure.recordFailure(location.nodeId, code, location.stage);
      }
    }
    // Warmup requests are generated but never scored: they must not leak into
    // evaluation node counters or consume the first evaluation overflow event.
    if (nodeId && request.scored) {
      this.counter(nodeId).errors += 1;
      if (code === 'queue_overflow' && !this.overflowLogged.has(nodeId)) {
        this.overflowLogged.add(nodeId);
        const node = this.scenario.graph.nodes.find(
          (candidate) => candidate.id === nodeId,
        );
        this.addEvent(
          atMs,
          `Queue overflow: "${node?.label ?? nodeId}" rejected a request`,
          nodeId,
        );
      }
    }
  }

  /**
   * Where the request was observed when it was rejected or its deadline
   * expired. This is evidence, not an inferred root cause: for example a
   * timeout while holding a DB slot is recorded on the database even though
   * the request's app slot is also occupied.
   */
  private failureLocation(
    request: Request,
    fallbackNodeId: string | undefined,
    stageOverride: RequestStage | undefined,
  ): { nodeId?: string; stage: RequestStage } {
    const stage = stageOverride ?? request.stage;
    switch (stage) {
      case 'appQueue':
      case 'appCpu':
      case 'poolQueue':
        return { nodeId: request.app?.node.id ?? fallbackNodeId, stage };
      case 'cacheLookup':
      case 'backendQueue':
      case 'fillWait':
        return { nodeId: this.scenario.cache?.node.id ?? fallbackNodeId, stage };
      case 'dbQueue':
      case 'dbExecuting':
        return { nodeId: this.scenario.database.node.id, stage };
      case 'lb':
        return {
          nodeId: this.scenario.loadBalancer?.node.id ?? fallbackNodeId,
          stage,
        };
      case 'client':
        return {
          nodeId:
            request.app?.node.id ??
            this.scenario.graph.nodes.find((node) => node.kind === 'client')?.id ??
            fallbackNodeId,
          stage,
        };
      case 'edgeToDependency':
      case 'edgeResponse':
        return { nodeId: request.app?.node.id ?? fallbackNodeId, stage };
      default:
        return { nodeId: fallbackNodeId, stage };
    }
  }

  private handleTimeout(request: Request): void {
    if (request.status !== 'active') {
      return;
    }
    const deadline = request.deadlineAt;
    this.failRequest(request, 'timeout', deadline, request.app?.node.id);

    switch (request.stage) {
      case 'appQueue':
        this.removeQueuedAppRequest(request);
        break;
      case 'poolQueue':
        this.removePoolWaiter(request);
        break;
      case 'backendQueue':
      case 'fillWait':
        if (request.fill) {
          this.removeWaiter(request.fill, request);
        }
        break;
      case 'dbQueue':
        if (request.dbOp) {
          this.removeQueuedDbOperation(request.dbOp);
        } else if (request.fill) {
          this.removeWaiter(request.fill, request);
        }
        break;
      case 'dbExecuting':
        // A started dependency call keeps its slots until the real callback;
        // this is the documented conservative choice.
        if (request.fill?.owner === request || request.dbOp?.started) {
          return;
        }
        if (request.fill) {
          this.removeWaiter(request.fill, request);
        }
        break;
      default:
        break;
    }
    this.releasePoolAndSlot(request);
  }

  private removeQueuedAppRequest(request: Request): void {
    for (const app of this.scenario.apps) {
      for (let index = 0; index < app.queue.length; index += 1) {
        if (app.queue[index]?.req === request) {
          app.queue.splice(index, 1);
          return;
        }
      }
    }
  }

  private removePoolWaiter(request: Request): void {
    const app = request.app;
    if (!app) {
      return;
    }
    removeFromArray(app.poolWaiters, request);
    request.poolContinuation = undefined;
    this.updateAppPressure(app);
  }

  private removeQueuedDbOperation(operation: DbOperation): void {
    removeFromArray(this.scenario.database.queue, operation);
    this.telemetry.recordDbQueue(
      this.clock,
      this.scenario.database.queue.length,
    );
    if (operation.req) {
      operation.req.dbOp = undefined;
    }
  }

  /**
   * Evaluation starts at logical time 0. Scored counters and overflow-event
   * suppression are reset here; runtime occupancy, queue contents and cache
   * contents are deliberately retained, because warmup traffic is real load
   * that leaves real state behind.
   */
  private resetEvaluationMetrics(): void {
    for (const nodeId of this.counters.keys()) {
      this.counters.set(nodeId, emptyCounters());
    }
    this.overflowLogged.clear();
    this.pressure.begin(0);
    for (const app of this.scenario.apps) {
      app.maxQueued = app.queue.length;
      this.updateAppPressure(app);
    }
    this.scenario.database.maxQueued = this.scenario.database.queue.length;
    this.updateDbPressure();
    if (this.scenario.cache) {
      this.scenario.cache.maxQueued = this.scenario.cache.backendQueue.length;
      this.updateCachePressure(this.scenario.cache);
    }
    this.telemetry.sync(0, this.scenario.database.queue.length);
  }

  private flushCache(): void {
    const cache = this.scenario.cache;
    if (!cache) {
      return;
    }
    this.cacheStore?.clear();
    this.addEvent(
      this.clock,
      'Cache flush: entries and LRU cleared, the node stays available',
      cache.node.id,
    );
  }

  /** Last-resort drain: every logical request must be terminal at the end. */
  private finalize(): void {
    for (const request of [...this.active]) {
      this.failRequest(request, 'timeout', this.endMs, request.app?.node.id);
      this.releasePoolAndSlot(request);
    }
    this.telemetry.sync(this.endMs, this.scenario.database.queue.length);
  }

  private addEvent(timeMs: number, message: string, nodeId?: string): void {
    if (this.eventLog.length >= 100) {
      return;
    }
    this.eventLog.push(nodeId ? { timeMs, message, nodeId } : { timeMs, message });
  }

  // ---------------------------------------------------------------------
  // Snapshots and checks
  // ---------------------------------------------------------------------

  private updateAppPressure(app: AppRuntime): void {
    this.pressure.update(
      app.node.id,
      this.clock,
      app.slots,
      app.poolBusy,
      app.poolWaiters.length,
    );
    this.updateTrafficGauge(app.node.id, app.slots, app.poolBusy);
  }

  private updateDbPressure(): void {
    const database = this.scenario.database;
    this.pressure.update(database.node.id, this.clock, database.slots, 0, 0);
    this.updateTrafficGauge(database.node.id, database.slots, 0);
  }

  private updateCachePressure(cache: CacheRuntime): void {
    this.pressure.update(
      cache.node.id,
      this.clock,
      0,
      cache.backendBusy,
      cache.backendQueue.length,
    );
    this.updateTrafficGauge(cache.node.id, 0, cache.backendBusy);
  }

  // ---------------------------------------------------------------------
  // Optional observational traffic telemetry
  // ---------------------------------------------------------------------

  private updateTrafficGauge(
    nodeId: string,
    busy: number,
    poolBusy: number,
  ): void {
    const gauge = this.trafficGauges.get(nodeId);
    if (!gauge) {
      return;
    }
    if (this.clock > gauge.lastAt) {
      const span = this.clock - gauge.lastAt;
      gauge.busyArea += gauge.busy * span;
      gauge.poolArea += gauge.poolBusy * span;
      gauge.lastAt = this.clock;
    }
    gauge.busy = Math.max(0, busy);
    gauge.poolBusy = Math.max(0, poolBusy);
  }

  private traceEdge(
    source: string,
    target: string,
    sourcePort: GraphEdge['sourcePort'],
  ): void {
    const edge = this.trafficEdges.get(`${source}|${target}|${sourcePort}`);
    if (edge) {
      this.traffic.countEdge(edge.id);
    }
  }

  private traceNode(nodeId: string): void {
    this.traffic.countNode(nodeId);
  }

  private trafficArea(
    gauge: {
      lastAt: number;
      busy: number;
      poolBusy: number;
      busyArea: number;
      poolArea: number;
    },
    untilMs: number,
  ): { busy: number; pool: number } {
    const span = Math.max(0, untilMs - gauge.lastAt);
    return {
      busy: gauge.busyArea + gauge.busy * span,
      pool: gauge.poolArea + gauge.poolBusy * span,
    };
  }

  private trafficNode(
    nodeId: string,
    untilMs: number,
    windowMs: number,
    rps: number,
  ): TrafficNode {
    const gauge = this.trafficGauges.get(nodeId);
    let busyAvg = 0;
    let poolAvg = 0;
    if (gauge) {
      const area = this.trafficArea(gauge, untilMs);
      busyAvg = windowMs > 0 ? Math.max(0, (area.busy - gauge.sampledBusyArea) / windowMs) : 0;
      poolAvg = windowMs > 0 ? Math.max(0, (area.pool - gauge.sampledPoolArea) / windowMs) : 0;
      gauge.sampledBusyArea = area.busy;
      gauge.sampledPoolArea = area.pool;
    }
    const node = this.scenario.graph.nodes.find((item) => item.id === nodeId);
    const resources: TrafficResource[] = [];
    let queue: number | null = null;
    if (node?.kind === 'appServer') {
      const app = this.scenario.apps.find(
        (candidate) => candidate.node.id === nodeId,
      );
      if (app) {
        resources.push(
          {
            key: 'cpu',
            label: 'CPU slots',
            used: busyAvg,
            capacity: app.capacity,
            unit: 'slots',
            aggregation: 'window-average',
          },
          {
            key: 'pool',
            label: 'Pool connections',
            used: poolAvg,
            capacity: app.poolSize,
            unit: 'connections',
            aggregation: 'window-average',
          },
        );
        queue = app.queue.length;
      }
    } else if (node?.kind === 'database') {
      const database = this.scenario.database;
      resources.push({
        key: 'connections',
        label: 'Database slots',
        used: busyAvg,
        capacity: database.capacity,
        unit: 'connections',
        aggregation: 'window-average',
      });
      queue = database.queue.length;
    } else if (node?.kind === 'cache') {
      const cache = this.scenario.cache;
      if (cache) {
        resources.push({
          key: 'pool',
          label: 'Cache fill connections',
          used: poolAvg,
          capacity: cache.poolSize,
          unit: 'connections',
          aggregation: 'window-average',
        });
        queue = cache.backendQueue.length;
      }
    }
    return {
      nodeId,
      resources,
      requestsPerSecond: rps,
      queue,
      down: false,
    };
  }

  /**
   * Read-only telemetry seam for the worker runtime. It reports dispatches that
   * already happened and gauge integrals kept outside the scoring accumulators;
   * it never advances the clock, schedules events or changes RNG state.
   */
  trafficFrame(untilMs: number): TrafficFrame | null {
    if (!Number.isFinite(untilMs) || untilMs < this.startMs) {
      return null;
    }
    return this.traffic.sample(untilMs, (context) => ({
      nodes: this.scenario.graph.nodes.map((node) =>
        this.trafficNode(
          node.id,
          untilMs,
          context.windowMs,
          context.nodeRps(node.id),
        ),
      ),
      edges: this.scenario.graph.edges.map((edge) => ({
        edgeId: edge.id,
        requestsPerSecond: context.edgeRps(edge.id),
        bytesPerSecond: null,
      })),
    }));
  }

  private phaseAt(timeMs: number): SimulationPhase {
    if (timeMs < 0) {
      return 'warmup';
    }
    if (timeMs < this.scenario.level.durationMs) {
      return 'running';
    }
    if (timeMs < this.endMs) {
      return 'draining';
    }
    return 'completed';
  }

  private snapshot(timeMs: number): SimulationSnapshot {
    return {
      timeMs,
      phase: this.phaseAt(timeMs),
      reads: this.reads.toMetric(),
      writes: this.writes.toMetric(),
      nodes: this.scenario.graph.nodes.map((node) =>
        this.nodeMetric(node.id, timeMs),
      ),
      series: this.telemetry.series(timeMs),
      events: this.eventLog.map((event) => ({ ...event })),
    };
  }

  private nodeMetric(nodeId: string, timeMs: number): NodeMetric {
    const counters = this.counter(nodeId);
    const node = this.scenario.graph.nodes.find(
      (candidate) => candidate.id === nodeId,
    );
    let metric: NodeMetric = {
      nodeId,
      busy: 0,
      queued: 0,
      poolBusy: 0,
      poolQueued: 0,
      hits: counters.hits,
      misses: counters.misses,
      coalesced: counters.coalesced,
      errors: counters.errors,
      maxQueued: 0,
      completed: counters.completed,
    };
    if (node?.kind === 'appServer') {
      const app = this.scenario.apps.find((candidate) => candidate.node.id === nodeId);
      if (app) {
        metric = {
          ...metric,
          busy: app.slots,
          queued: app.queue.length,
          poolBusy: app.poolBusy,
          poolQueued: app.poolWaiters.length,
          maxQueued: app.maxQueued,
        };
      }
    } else if (node?.kind === 'database') {
      metric = {
        ...metric,
        busy: this.scenario.database.slots,
        queued: this.scenario.database.queue.length,
        maxQueued: this.scenario.database.maxQueued,
      };
    } else if (node?.kind === 'cache') {
      const cache = this.scenario.cache;
      if (cache) {
        metric = {
          ...metric,
          poolBusy: cache.backendBusy,
          poolQueued: cache.backendQueue.length,
          maxQueued: cache.maxQueued,
        };
      }
    }

    const relevant =
      node?.kind === 'appServer' ||
      node?.kind === 'database' ||
      node?.kind === 'cache';
    const pressure = this.pressure.report(nodeId, timeMs, relevant);
    return pressure ? { ...metric, pressure } : metric;
  }

  private counter(nodeId: string): NodeCounters {
    let counters = this.counters.get(nodeId);
    if (!counters) {
      counters = emptyCounters();
      this.counters.set(nodeId, counters);
    }
    return counters;
  }

  private buildDiagnostics(cost: number): Diagnostic[] {
    const cache = this.scenario.cache;
    const cacheCounters = cache ? this.counter(cache.node.id) : undefined;
    const nodes: PressureNodeSummary[] = this.scenario.graph.nodes.map((node) => {
      const pressure = this.pressure.report(
        node.id,
        this.endMs,
        node.kind === 'appServer' ||
          node.kind === 'database' ||
          node.kind === 'cache',
      );
      const app =
        node.kind === 'appServer'
          ? this.scenario.apps.find((candidate) => candidate.node.id === node.id)
          : undefined;
      const database = node.kind === 'database' ? this.scenario.database : undefined;
      const nodeCache = node.kind === 'cache' ? this.scenario.cache : undefined;
      return {
        nodeId: node.id,
        label: node.label,
        kind: node.kind,
        capacity:
          app?.capacity ??
          database?.capacity ??
          nodeCache?.capacityEntries ??
          null,
        poolSize: app?.poolSize ?? nodeCache?.poolSize ?? null,
        queueLimit:
          app?.queueLimit ??
          database?.queueLimit ??
          nodeCache?.queueLimit ??
          node.config.queueLimit,
        maxQueued: app?.maxQueued ?? database?.maxQueued ?? nodeCache?.maxQueued ?? 0,
        busyPeak: pressure?.busyPeak ?? 0,
        busyAvg: pressure?.busyAvg ?? 0,
        poolBusyPeak: pressure?.poolBusyPeak ?? 0,
        poolBusyAvg: pressure?.poolBusyAvg ?? 0,
        poolQueuedPeak: pressure?.poolQueuedPeak ?? 0,
        failures: pressure?.failures ?? [],
        errors: this.counter(node.id).errors,
      };
    });

    return buildDiagnostics({
      costMicroUsdPerHour: cost,
      budgetMicroUsdPerHour: this.scenario.level.budgetMicroUsdPerHour,
      deadlineMs: this.scenario.level.deadlineMs,
      reads: this.reads,
      writes: this.writes,
      nodes,
      cache:
        cache && cacheCounters
          ? {
              nodeId: cache.node.id,
              label: cache.node.label,
              hits: cacheCounters.hits,
              misses: cacheCounters.misses,
              coalesced: cacheCounters.coalesced,
            }
          : undefined,
      noCacheDemand:
        !cache && this.reads.offered > 0
          ? {
              readPeakRps: Math.max(
                ...this.scenario.level.workloads.read.schedule.map(
                  (point) => point.rps,
                ),
              ),
              writePeakRps: Math.max(
                ...this.scenario.level.workloads.write.schedule.map(
                  (point) => point.rps,
                ),
              ),
              readMs: this.scenario.level.timing.dbReadMs,
              writeMs: this.scenario.level.timing.dbWriteMs,
              capacity: this.scenario.database.capacity,
            }
          : undefined,
    });
  }
}
