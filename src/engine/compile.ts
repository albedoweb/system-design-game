import { getCapacity } from '../domain/catalog';
import type { GraphDocument, GraphNode } from '../domain/graph';
import type { LevelDefinition } from '../domain/level';
import { SimulationInputError } from './errors';
import type {
  AppRuntime,
  CacheRuntime,
  ClientTarget,
  CompiledScenario,
  DatabaseRuntime,
  DependencyTarget,
  LoadBalancerRuntime,
} from './types';

function capacityOf(node: GraphNode): number {
  const capacity = getCapacity(node.kind, node.config.size);
  if (capacity === null) {
    throw new SimulationInputError(`Node "${node.label}" has no capacity to run`);
  }
  return capacity;
}

function nodeById(graph: GraphDocument, id: string): GraphNode | undefined {
  return graph.nodes.find((node) => node.id === id);
}

function outgoing(graph: GraphDocument, nodeId: string) {
  return graph.edges.filter((edge) => edge.source === nodeId);
}

/**
 * Turn a validated graph into the runtime topology. `createSimulation` checks
 * schema and `validateGraph(..., {mode:'run'})` before this function is called;
 * the guards below only protect against impossible intermediate states.
 */
export function compileScenario(
  graph: GraphDocument,
  level: LevelDefinition,
): CompiledScenario {
  const databaseNode = graph.nodes.find((node) => node.kind === 'database');
  if (!databaseNode) {
    throw new SimulationInputError('The graph has no database');
  }
  const database: DatabaseRuntime = {
    node: databaseNode,
    capacity: capacityOf(databaseNode),
    queueLimit: databaseNode.config.queueLimit,
    slots: 0,
    queue: [],
    maxQueued: 0,
  };

  const cacheNode = graph.nodes.find((node) => node.kind === 'cache');
  let cache: CacheRuntime | undefined;
  if (cacheNode) {
    cache = {
      node: cacheNode,
      capacityEntries: capacityOf(cacheNode),
      queueLimit: cacheNode.config.queueLimit,
      poolSize: cacheNode.config.poolSize,
      ttlMs: cacheNode.config.ttlSeconds * 1000,
      coalescing: cacheNode.config.coalescing,
      database,
      backendBusy: 0,
      backendQueue: [],
      maxQueued: 0,
    };
  }

  const apps: AppRuntime[] = graph.nodes
    .filter((node) => node.kind === 'appServer')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => {
      const readEdge = outgoing(graph, node.id).find(
        (edge) => edge.sourcePort === 'read',
      );
      if (!readEdge) {
        throw new SimulationInputError(`App server "${node.label}" has no read edge`);
      }
      const readTarget = nodeById(graph, readEdge.target);
      let read: DependencyTarget;
      if (readTarget?.kind === 'cache') {
        if (!cache) {
          throw new SimulationInputError('The read edge points to a missing cache');
        }
        read = { kind: 'cache', cache };
      } else if (readTarget?.kind === 'database') {
        read = { kind: 'database', database };
      } else {
        throw new SimulationInputError(
          `The read edge of app server "${node.label}" leads to an unsupported node`,
        );
      }

      return {
        node,
        capacity: capacityOf(node),
        queueLimit: node.config.queueLimit,
        poolSize: node.config.poolSize,
        read,
        write: database,
        slots: 0,
        queue: [],
        poolBusy: 0,
        poolWaiters: [],
        maxQueued: 0,
      };
    });

  const appById = new Map(apps.map((app) => [app.node.id, app]));
  const balancerNode = graph.nodes.find((node) => node.kind === 'loadBalancer');
  let loadBalancer: LoadBalancerRuntime | undefined;
  if (balancerNode) {
    const targets = outgoing(graph, balancerNode.id)
      .map((edge) => appById.get(edge.target))
      .filter((app): app is AppRuntime => app !== undefined)
      .sort((a, b) => a.node.id.localeCompare(b.node.id));
    loadBalancer = {
      node: balancerNode,
      apps: targets,
      cursor: 0,
    };
  }

  const clientNode = graph.nodes.find((node) => node.kind === 'client');
  if (!clientNode) {
    throw new SimulationInputError('The graph has no client');
  }
  const clientEdge = outgoing(graph, clientNode.id)[0];
  if (!clientEdge) {
    throw new SimulationInputError('The client has no outgoing edge');
  }

  let clientTarget: ClientTarget;
  const firstTarget = nodeById(graph, clientEdge.target);
  if (firstTarget?.kind === 'appServer') {
    const app = appById.get(firstTarget.id);
    if (!app) {
      throw new SimulationInputError('The client points to an unknown app server');
    }
    clientTarget = { kind: 'app', app };
  } else if (firstTarget?.kind === 'loadBalancer' && loadBalancer) {
    clientTarget = { kind: 'lb', lb: loadBalancer };
  } else {
    throw new SimulationInputError('The client must connect to an app server or a load balancer');
  }

  return {
    graph,
    level,
    clientTarget,
    apps,
    database,
    cache,
    loadBalancer,
  };
}
