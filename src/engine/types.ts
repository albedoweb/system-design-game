import type { GraphDocument, GraphNode } from '../domain/graph';
import type { LevelDefinition } from '../domain/level';
import type { TrafficClass } from './workload';

/**
 * Internal mutable run state. These types never cross the worker boundary;
 * snapshots and results are plain domain data.
 */

export type RequestStage =
  | 'client'
  | 'lb'
  | 'appQueue'
  | 'appCpu'
  | 'poolQueue'
  | 'edgeToDependency'
  | 'cacheLookup'
  | 'backendQueue'
  | 'fillWait'
  | 'dbQueue'
  | 'dbExecuting'
  | 'edgeResponse'
  | 'done';

export interface Request {
  logicalId: string;
  trafficClass: TrafficClass;
  key: number;
  arrivalMs: number;
  deadlineAt: number;
  scored: boolean;
  critical: boolean;
  status: 'active' | 'succeeded' | 'failed';
  viaLb: boolean;
  stage: RequestStage;
  app?: AppRuntime;
  holdsAppSlot: boolean;
  holdsPool: boolean;
  fill?: Fill;
  dbOp?: DbOperation;
  poolContinuation?: () => void;
}

export interface QueuedRequest {
  req: Request;
  enqueuedAt: number;
}

export interface DbOperation {
  kind: 'read' | 'write';
  key: number;
  /** Present for a request-owned database call. */
  req?: Request;
  /** Present when the call is a cache fill; `req` then owns the waiting side. */
  fill?: Fill;
  started: boolean;
  onDone: (atMs: number) => void;
}

export interface Fill {
  key: number;
  /** Request that started the fill; other requests may coalesce onto it. */
  owner: Request;
  /** Key version captured when the database read starts. */
  version: number;
  waiters: Request[];
  backendHeld: boolean;
  cancelled: boolean;
  dbStarted: boolean;
  dbOp?: DbOperation;
}

export interface DatabaseRuntime {
  node: GraphNode;
  capacity: number;
  queueLimit: number;
  slots: number;
  queue: DbOperation[];
  maxQueued: number;
}

export interface CacheRuntime {
  node: GraphNode;
  capacityEntries: number;
  queueLimit: number;
  poolSize: number;
  ttlMs: number;
  coalescing: boolean;
  database: DatabaseRuntime;
  backendBusy: number;
  backendQueue: Fill[];
  maxQueued: number;
}

export type DependencyTarget =
  | { kind: 'cache'; cache: CacheRuntime }
  | { kind: 'database'; database: DatabaseRuntime };

export interface AppRuntime {
  node: GraphNode;
  capacity: number;
  queueLimit: number;
  poolSize: number;
  read: DependencyTarget;
  write: DatabaseRuntime;
  slots: number;
  queue: QueuedRequest[];
  poolBusy: number;
  poolWaiters: Request[];
  maxQueued: number;
}

export interface LoadBalancerRuntime {
  node: GraphNode;
  apps: AppRuntime[];
  cursor: number;
}

export type ClientTarget =
  | { kind: 'app'; app: AppRuntime }
  | { kind: 'lb'; lb: LoadBalancerRuntime };

export interface CompiledScenario {
  graph: GraphDocument;
  level: LevelDefinition;
  clientTarget: ClientTarget;
  apps: AppRuntime[];
  database: DatabaseRuntime;
  cache?: CacheRuntime;
  loadBalancer?: LoadBalancerRuntime;
}
