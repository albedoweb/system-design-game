import { CART_CATALOG, type CartCatalog } from './catalog';
import {
  CART_DEFAULT_SEED,
  CART_EDGE_KINDS,
  CART_LEVEL_ID,
  CART_LIMITS,
  CART_NODE_KIND_INFO,
  CART_READ_POLICIES,
  CART_REGIONS,
  CART_REGION_INFO,
  CART_REQUIRED_CASES,
  CART_VERSIONS,
  type CartCaseId,
  type CartNodeKind,
  type CartRegion,
  type CartVersions,
} from './contracts';
import { cartCustomersId } from './graph';

/**
 * Global Cart level discovery. This is the exact public description used by the
 * UI briefing, agent CLI/API and import screens; it must not restate the level
 * more favourably than the engine or schemas enforce.
 */

export interface CartDiscoveryRegion {
  readonly id: CartRegion;
  readonly label: string;
  readonly city: string;
  readonly ordinal: number;
}

export interface CartDiscoveryNodeKind {
  readonly kind: CartNodeKind;
  readonly label: string;
  readonly ordinal: number;
  readonly role: 'source' | 'service';
  readonly durable: boolean;
  readonly fields: readonly string[];
}

export interface CartDiscovery {
  readonly levelId: string;
  readonly title: string;
  readonly description: string;
  readonly versions: CartVersions;
  readonly requiredCases: readonly CartCaseId[];
  readonly defaultSeed: number;
  readonly regions: readonly CartDiscoveryRegion[];
  readonly nodeKinds: readonly CartDiscoveryNodeKind[];
  readonly fixedSourceIds: readonly string[];
  readonly edgeKinds: readonly string[];
  readonly readPolicies: readonly string[];
  readonly circuits: {
    readonly tiersMbps: readonly number[];
    readonly sharedPerDirection: true;
    readonly semanticEdgesShareCircuit: true;
    readonly graphCannotSelectPropagation: true;
    readonly note: string;
  };
  readonly limits: typeof CART_LIMITS;
  readonly authority: {
    readonly clientPath: string;
    readonly retryOriginAuthority: string;
    readonly inventoryAuthority: string;
    readonly fallbackTargets: string;
    readonly note: string;
  };
  readonly connectivity: {
    readonly hiddenLinks: false;
    readonly requiresExplicitEdge: true;
    readonly undrawnTransit: false;
    readonly note: string;
  };
  readonly persistence: {
    readonly explicitOnly: true;
    readonly saveIncludes: readonly string[];
    readonly saveExcludes: readonly string[];
    readonly refreshBehavior: string;
    readonly importBehavior: string;
  };
  readonly catalog: CartCatalog;
  readonly scoring: CartCatalog['scoring'];
  readonly calibration: CartCatalog['calibration'];
}

const TITLE = 'Global Cart';
const DESCRIPTION =
  'Build a shopping-cart service for customers in three regions. Keep everyday requests fast, handle the rush, and choose where to place cart storage and Inventory. Place regional Applications, caches, durable journals, cart stores and the single authoritative Inventory, then draw every request and replication path yourself. Meet exactly two requirements — Normal and Rush — with the lowest operating cost, inside a 6 credit/hour budget. Both runs are fault-free and measured over a 101 s window (100 ms session offset), and cost is computed over that same window.';

const level: CartDiscovery = {
  levelId: CART_LEVEL_ID,
  title: TITLE,
  description: DESCRIPTION,
  versions: { ...CART_VERSIONS },
  requiredCases: [...CART_REQUIRED_CASES],
  defaultSeed: CART_DEFAULT_SEED,
  regions: CART_REGIONS.map((region) => ({
    id: region,
    label: CART_REGION_INFO[region].label,
    city: CART_REGION_INFO[region].city,
    ordinal: CART_REGION_INFO[region].ordinal,
  })),
  nodeKinds: (Object.keys(CART_NODE_KIND_INFO) as CartNodeKind[]).map((kind) => ({
    kind,
    label: CART_NODE_KIND_INFO[kind].label,
    ordinal: CART_NODE_KIND_INFO[kind].ordinal,
    role: CART_NODE_KIND_INFO[kind].role,
    durable: CART_NODE_KIND_INFO[kind].durable,
    fields: [...CART_NODE_KIND_INFO[kind].fields],
  })),
  fixedSourceIds: CART_REGIONS.map((region) => cartCustomersId(region)),
  edgeKinds: [...CART_EDGE_KINDS],
  readPolicies: [...CART_READ_POLICIES],
  circuits: {
    tiersMbps: [...CART_CATALOG.network.wanTiersMbps],
    sharedPerDirection: true,
    semanticEdgesShareCircuit: true,
    graphCannotSelectPropagation: true,
    note: 'One circuit per unordered region pair, shared by every semantic edge in each direction. Adding arrows or Applications cannot buy more bandwidth, and propagation delay is fixed by the pair.',
  },
  limits: CART_LIMITS,
  authority: {
    clientPath:
      'A customer source may connect only to its own region’s Application; clients never reach a service directly.',
    retryOriginAuthority:
      'Each Application declares one writeTarget (journal or cart store). A retry of an origin key must follow that drawn path back to the original origin authority even when it enters from another region.',
    inventoryAuthority:
      'Exactly one Inventory node holds stock, orders and the idempotency ledger. No cache or replica can authorize a purchase, and an unreachable Inventory means unavailable rather than a guessed OutOfStock.',
    fallbackTargets:
      'Read repair may target configured journals, cart stores or Applications only, in deterministic order. A missing path fails; it never becomes automatic transit.',
    note: 'Paths are player-drawn request or replication edges. The simulator never invents connectivity.',
  },
  connectivity: {
    hiddenLinks: false,
    requiresExplicitEdge: true,
    undrawnTransit: false,
    note: 'No hidden all-to-all links, no free transit through an undrawn third region and no implicit replication.',
  },
  persistence: {
    explicitOnly: true,
    saveIncludes: ['nodes', 'edges', 'circuits', 'seed'],
    saveExcludes: ['simulation state', 'client tokens', 'inventory ledger'],
    refreshBehavior: 'Refresh and Reset start from the clean source-only starter.',
    importBehavior:
      'Import parses and validates the whole document before replacing the current design; an invalid file leaves the design untouched.',
  },
  catalog: CART_CATALOG,
  scoring: CART_CATALOG.scoring,
  calibration: CART_CATALOG.calibration,
};

/** Deep copy so callers cannot mutate the shared discovery record. */
export function describeCartLevel(): CartDiscovery {
  return JSON.parse(JSON.stringify(level)) as CartDiscovery;
}
