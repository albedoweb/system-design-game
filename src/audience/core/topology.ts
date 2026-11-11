import type {
  AudienceEdge,
  AudienceGraph,
  AudienceLinkRole,
  AudienceNodeKind,
  AudienceSqlReadPlan,
  AudienceSqlSize,
} from '../contracts';
import { audienceLinkRole } from '../contracts';
import { audienceGraphDigest, parseAndValidateAudienceGraph } from '../graph';
import { audienceSqlSpec, type AudienceModel } from './model';

/**
 * Physical topology resolved from a validated graph.
 *
 * Only physical facts live here: which component exists, how many homogeneous
 * slots, the SQL size/plan, the cache TTL and whether traffic goes through the
 * managed Load Balancer. Routed/behavioural decisions stay in the case
 * simulation so that a failure is produced by the running system, never by a
 * validator.
 */
export interface AudienceTopologyNode {
  readonly id: string;
  readonly kind: AudienceNodeKind;
  readonly label: string;
}

export interface AudienceTopologyEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly role: AudienceLinkRole;
}

export interface AudienceTopology {
  readonly graph: AudienceGraph;
  readonly digest: string;
  readonly nodes: readonly AudienceTopologyNode[];
  readonly edges: readonly AudienceTopologyEdge[];
  readonly usersId: string;
  readonly appId: string;
  readonly appInstances: number;
  readonly sqlId: string;
  readonly sqlSize: AudienceSqlSize;
  readonly sqlCores: number;
  readonly sqlMemoryBytes: number;
  readonly sqlDiskBytes: number;
  readonly sqlNicLanes: number;
  readonly readPlan: AudienceSqlReadPlan;
  readonly lbId: string | null;
  /** True when Users connect directly to the Application pool. */
  readonly directPath: boolean;
  readonly cacheId: string | null;
  readonly cacheTtlMs: number | null;
  readonly workerId: string | null;
  readonly workerInstances: number;
  /** Stable physical slot count used by the challenge profile. */
  readonly physicalSlots: number;
}

export type AudienceTopologyResult =
  | { readonly ok: true; readonly value: AudienceTopology }
  | {
      readonly ok: false;
      readonly issues: ReturnType<typeof parseAndValidateAudienceGraph>['issues'];
    };

const GIB = 1_000_000_000;

export function resolveAudienceTopology(
  input: unknown,
  model: AudienceModel,
): AudienceTopologyResult {
  const parsed = parseAndValidateAudienceGraph(input);
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues };
  }
  const graph = parsed.value;
  const users = graph.nodes.find((node) => node.kind === 'users');
  const app = graph.nodes.find((node) => node.kind === 'app');
  const sql = graph.nodes.find((node) => node.kind === 'sql');
  const lb = graph.nodes.find((node) => node.kind === 'lb');
  const cache = graph.nodes.find((node) => node.kind === 'cache');
  const worker = graph.nodes.find((node) => node.kind === 'worker');
  if (users === undefined || app === undefined || sql === undefined) {
    return { ok: false, issues: parsed.issues };
  }
  const size = audienceSqlSpec(model, sql.config.size);
  const edges: AudienceTopologyEdge[] = [];
  for (const edge of graph.edges as readonly AudienceEdge[]) {
    const from = graph.nodes.find((node) => node.id === edge.from);
    const to = graph.nodes.find((node) => node.id === edge.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    const role = audienceLinkRole(from.kind, to.kind);
    if (role === null) {
      continue;
    }
    edges.push({ id: edge.id, from: edge.from, to: edge.to, role });
  }

  return {
    ok: true,
    value: {
      graph,
      digest: audienceGraphDigest(graph),
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        label: node.label,
      })),
      edges,
      usersId: users.id,
      appId: app.id,
      appInstances: app.config.instances,
      sqlId: sql.id,
      sqlSize: sql.config.size,
      sqlCores: size.cores,
      sqlMemoryBytes: size.memoryGb * GIB,
      sqlDiskBytes: size.diskGb * GIB,
      sqlNicLanes: size.nicGbitPerSec,
      readPlan: sql.config.readPlan,
      lbId: lb?.id ?? null,
      directPath: lb === undefined,
      cacheId: cache?.id ?? null,
      cacheTtlMs:
        cache === undefined ? null : Math.round(cache.config.ttlSeconds * 1_000),
      workerId: worker?.id ?? null,
      workerInstances: worker?.config.instances ?? 0,
      physicalSlots: app.config.instances,
    },
  };
}
