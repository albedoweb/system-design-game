import { z } from 'zod';
import { cloneImageCatalog } from './catalog';
import {
  IMAGE_COMPONENT_LIMITS,
  IMAGE_CONTENT_VERSION,
  IMAGE_LEVEL_ID,
  IMAGE_MODEL_VERSION,
  IMAGE_MONTHLY_BUDGET_USD,
  IMAGE_PRICING_VERSION,
  IMAGE_REQUIRED_SCENARIOS,
  IMAGE_SCHEMA_VERSION,
  imageEvaluationJsonSchema,
  imageIssuesFromZod,
  imageLevelSchema,
  type ImageLevel,
  type ImageParseResult,
} from './contracts';
import { imageGraphJsonSchema } from './graph';
import { imageCatalogJsonSchema } from './catalog';

/**
 * Authoritative Image Atlas level. The public JSON copy in
 * `public/levels/image-atlas.json` is checked against this value by tests.
 * Imported graphs cannot override workload, prices, regions or SLOs.
 */
const level: ImageLevel = {
  schemaVersion: IMAGE_SCHEMA_VERSION,
  contentVersion: IMAGE_CONTENT_VERSION,
  modelVersion: IMAGE_MODEL_VERSION,
  pricingVersion: IMAGE_PRICING_VERSION,
  id: IMAGE_LEVEL_ID,
  title: 'Image Atlas',
  description:
    'Serve 1.5 billion images across three regions. Upload originals, search by user or one tag, and open details while a fixed global blob provider, your metadata indexes, replicas and caches share finite network, RAM and disk. Prove normal, peak and incident behaviour inside a $205,000 monthly budget.',
  dataset: {
    retentionDays: 30,
    users: 1_000_000,
    uploadsPerUserPerDay: 50,
    searchesPerUserPerDay: 50,
    detailClicksPerSearch: 2,
    searchResultsPerSearch: 10,
    originalBytes: 4_000_000,
    thumbnailBytes: 256_000,
    metadataBytes: 8_000,
    matureImages: 1_500_000_000,
    matureOriginalTb: 6_000,
    matureMetadataTb: 12,
    matureMaterializedThumbnailTb: 384,
  },
  regions: [
    {
      id: 'na',
      label: 'North America',
      demandShare: 1 / 3,
      clientRttMs: 20,
      aggregateBandwidthGbitPerSec: 100,
      requestAccessBandwidthGbitPerSec: 1,
    },
    {
      id: 'eu',
      label: 'Europe',
      demandShare: 1 / 3,
      clientRttMs: 20,
      aggregateBandwidthGbitPerSec: 100,
      requestAccessBandwidthGbitPerSec: 1,
    },
    {
      id: 'ap',
      label: 'Asia Pacific',
      demandShare: 1 / 3,
      clientRttMs: 20,
      aggregateBandwidthGbitPerSec: 100,
      requestAccessBandwidthGbitPerSec: 1,
    },
  ],
  network: {
    localPropagationMs: 1,
    fullMesh: true,
    interRegionLinks: [
      {
        a: 'na',
        b: 'eu',
        bandwidthGbitPerSec: 100,
        oneWayLatencyMs: 40,
        fullDuplex: true,
        sharedByAllTransfers: true,
      },
      {
        a: 'eu',
        b: 'ap',
        bandwidthGbitPerSec: 100,
        oneWayLatencyMs: 70,
        fullDuplex: true,
        sharedByAllTransfers: true,
      },
      {
        a: 'na',
        b: 'ap',
        bandwidthGbitPerSec: 100,
        oneWayLatencyMs: 80,
        fullDuplex: true,
        sharedByAllTransfers: true,
      },
    ],
    oneExplicitPathPerTransfer: true,
    clientRttMs: 20,
    clientLinksFullDuplex: true,
    aggregateClientBandwidthGbitPerSec: 100,
    requestAccessBandwidthGbitPerSec: 1,
    clientTrafficChargedOnAggregate: true,
    routingFailureDetectionMs: 250,
    selectsNearestHealthyConnectedApp: true,
    missingEdgeRouting: 'forbidden',
  },
  workload: {
    operationRatesPerDay: {
      upload: 50_000_000,
      search: 50_000_000,
      detail: 100_000_000,
    },
    averageRatesPerSecond: {
      upload: 50_000_000 / 86_400,
      search: 50_000_000 / 86_400,
      detail: 100_000_000 / 86_400,
    },
    sampleFactor: 1,
    traceSeedPolicy: 'graph-independent',
    hotKeyShare: 0.8,
    hotKeys: 10_000,
    longTailRepresentativeKeys: 1_000_000,
    longTailMapsToMatureDataset: true,
    recentReadProbeShare: 0.01,
    recentReadProbeAgeBoundMs: 120_000,
    searchBy: ['user', 'one-tag'],
    recentFirst: true,
    generalTextSearch: false,
    cacheInitialState: 'empty',
    warmupFillsCache: true,
    syntheticOldKeysFullyVisible: true,
    replicaInitialState: 'caught-up',
  },
  metadataProtocol: {
    recordModel: 'immutable-append-only',
    originModel: 'healthy-accepting-region',
    progressModel: 'per-origin',
    ackRequiresLocalDurableCopies: true,
    ackVsPublication: 'separate',
    sameIdSameContent: 'single-effect',
    sameIdDifferentContent: 'rejected',
    unavailableOwner: 'pending-no-new-origin',
    replicationBroadcast: 'direct-only',
    replicationCycles: 'allowed-deduped',
  },
  slo: {
    normal: {
      availability: 0.995,
      detailP999Ms: 300,
      searchP999Ms: 250,
      uploadP999Ms: 1_000,
    },
    incident: {
      availability: 0.98,
      detailP999Ms: 600,
      searchP999Ms: 800,
      uploadP999Ms: 2_000,
    },
    incidentWindowAvailability: 0.98,
    recoveryAvailability: 0.995,
    recoveryFinalWindowMs: 10_000,
    deadlinesMs: {
      upload: 5_000,
      search: 3_000,
      detail: 2_000,
    },
    freshnessMs: 120_000,
    globalIndexBoundMs: 120_000,
  },
  qualification: {
    warmupMs: 20_000,
    measuredMs: 60_000,
    drainMs: 10_000,
    postlude: {
      noNewOffers: true,
      maxAfterLastAckMs: 120_000,
      backgroundWorkCounted: true,
      includedInMeasuredLoad: false,
      coversLostAckCommits: true,
    },
    requiredScenarios: [...IMAGE_REQUIRED_SCENARIOS],
    minimumP999Samples: 10_000,
    calibrationSeeds: [101, 211, 307],
    holdoutSeeds: [607, 701],
    linkOutage: {
      a: 'na',
      b: 'eu',
      directions: 'both',
    },
    nodeFault: 'one-instance-per-pool',
    maxEventsPerScenario: 12_000_000,
    maxMemoryBytes: 536_870_912,
    samplePolicy: 'extend-deterministically',
    scenarios: [
      {
        name: 'normal',
        label: 'Normal daily average',
        demandMultiplier: 1,
        fault: { kind: 'none' },
      },
      {
        name: 'peak',
        label: 'Peak daily average',
        demandMultiplier: 2,
        fault: { kind: 'none' },
      },
      {
        name: 'node-failure',
        label: 'One instance per pool',
        demandMultiplier: 2,
        fault: {
          kind: 'node',
          target: 'one-instance-per-pool',
          atMeasuredMs: 20_000,
          durationMs: 20_000,
        },
      },
      {
        name: 'link-failure',
        label: 'Inter-region link outage na-eu',
        demandMultiplier: 2,
        fault: {
          kind: 'link',
          a: 'na',
          b: 'eu',
          directions: 'both',
          atMeasuredMs: 20_000,
          durationMs: 20_000,
        },
      },
      {
        name: 'region-na-failure',
        label: 'Region outage: NA',
        demandMultiplier: 2,
        fault: {
          kind: 'region',
          region: 'na',
          atMeasuredMs: 20_000,
          durationMs: 20_000,
        },
      },
      {
        name: 'region-eu-failure',
        label: 'Region outage: EU',
        demandMultiplier: 2,
        fault: {
          kind: 'region',
          region: 'eu',
          atMeasuredMs: 20_000,
          durationMs: 20_000,
        },
      },
      {
        name: 'region-ap-failure',
        label: 'Region outage: AP',
        demandMultiplier: 2,
        fault: {
          kind: 'region',
          region: 'ap',
          atMeasuredMs: 20_000,
          durationMs: 20_000,
        },
      },
    ],
  },
  budget: {
    monthlyUsd: IMAGE_MONTHLY_BUDGET_USD,
    currency: 'USD',
    note:
      'Provisional monthly budget. It must be validated by real evaluator witnesses and may be revised only with recorded calibration evidence.',
  },
  defaultSeed: 101,
  refs: {
    trainingSeeds: [101, 211, 307],
    holdoutSeeds: [607, 701],
  },
  assumptions: [
    'Teaching model, not a production benchmark. Every price and coefficient is a conditional in-game value.',
    'The mature dataset is checked at day 30: 1.5 billion originals (6 PB), 12 TB of metadata before indexes and 384 TB if every thumbnail were materialised. Thumbnails are provider variant reads, not preallocated player storage.',
    'Originals must use the fixed global blob provider. Its internal replication is included in the provider price and is not a player-owned replica.',
    'Rolling retention is 30 days for originals, metadata and thumbnails. The workload reaches a plateau rather than growing for years.',
    'Search is only by user or one tag, returns the ten most recent matches, and has no general text search. A missing index cannot silently serve tag search.',
    'Demand and fault traces are seeded independently of the graph. Node ids and insertion order never influence random draws; the same seed and versions reproduce the same trace.',
    'Each search result page starts with ten concurrent child fetches that share that business request’s 1 Gbit/s end-user access link, the fixed population Client node’s shared 100 Gbit/s aggregate link, and every other physical bottleneck. Search completes only when all required children complete.',
    'Normal uses daily-average demand; peak uses twice the average. Incident cases use twice the average. Normal, peak, node, link and region cases each have 20 s warm-up, 60 s measured traffic, up to 10 s request drain, then a separate no-new-offers consistency/publication postlude up to the last ACK + 120 s.',
    'Incident faults start at measured second 20 and last 20 s, followed by a 20 s recovery period. The final 10 s recovery window has its own availability gate.',
    'A region outage removes that region’s player nodes and provider endpoint until recovery. Client demand is still offered and counted in the denominator so an outage cannot hide failures. The routing service detects failed endpoints within 250 ms and selects the lowest-latency healthy connected app from the client’s explicit traffic edges; it never follows an edge that is absent from the graph.',
    'Clients may list several explicit traffic edges as failover choices. Direct clients may also list several explicit provider endpoints; the engine selects the nearest healthy connected endpoint. Offered demand is failed, not silently dropped, when no connected healthy path exists.',
    'The v1 node case removes one physical instance from every player app, metadata and cache pool simultaneously. It is explicitly named one instance per pool; a visual pool never multiplies surviving resources.',
    'Inter-region links form a full mesh: one 100 Gbit/s full-duplex channel per unordered region pair, shared by every transfer crossing that pair. Local instance NIC limits still apply. Parallel visual arrows never add bandwidth.',
    'One explicit logical path is used per transfer. Local propagation is 1 ms one-way and client regional RTT is 20 ms. The fixed Client node is a regional population aggregate with a shared 100 Gbit/s full-duplex link; each business request separately has a 1 Gbit/s end-user access link shared by all of its child transfers. The per-request cap is not the regional client capacity. User internet access faults are not modelled.',
    'Provider regional endpoints each have 100 Gbit/s, 10k read RPC/s and 2k write RPC/s. Read service-start bands are 35/70/100/120 ms; write bands are 80/140/200 ms. A read payload follows service start; a write ack follows the incoming payload and the durable service.',
    'Provider durable acknowledgement is globally durable under this suite. Remote read visibility is bounded by 60 s; origin reads see the writer’s upload immediately. A recent remote miss must fall back or be reported as a correctness failure.',
    'Metadata records are immutable append-only entries keyed by a globally unique upload/idempotency id. Every healthy regional metadata store attached to an app can append new uploads as an origin. Replicas receive direct per-origin logs and keep origin-specific progress and dedupe; there is no single global home or global watermark. Every scenario starts with replicas caught up to the mature synthetic dataset.',
    'Same id with the same content has one business effect; same id with different content is rejected. Before the first payload transmission the routing service binds an upload id to its chosen healthy origin. All retries reuse that origin and object key. While the owner is unreachable the id stays unknown/pending and must never append at another origin; only a distinct new id may choose a new origin.',
    'Replicate edges are direct origin-to-recipient logs. Cycles consisting only of replicate edges are allowed and deduped by origin/sequence; a recipient applies each origin record once and never recursively rebroadcasts applied records. A→B and B→C do not imply A→C in v1. Missing replicate edges are valid-but-incomplete distribution and can fail runtime freshness instead of being rejected at import.',
    'The metadata shard model is disclosed: shardCount = floor(instances / replicas); instances must be divisible by replicas; logical capacity is shardCount x diskTb. Every physical copy consumes provisioned and billed disk, while workload bytes are not multiplied by copy count twice.',
    'No general consensus, leader election or Byzantine protocol is simulated. Immutable local-origin append logs plus direct directed replication are the complete supported metadata protocol. ACK requires the object durable commit and configured local durable metadata copies; global search publication is a separate later event.',
    'Capacity must provision a complete regional metadata dataset and all physical copies for every player metadata store; it is not reduced to bytes a particular graph happened to deliver. Index bytes are explicit per object: none 0 B, user 64 B, user-tag 352 B (64 B user entry plus three 96 B tag postings). The global 6 PB original base is counted once, not once per regional provider endpoint.',
    'Metadata resident pages are bounded by the allocated per-instance cache. The rest of the metadata is read from disk; the whole dataset is never assumed to fit RAM.',
    'Caches are real byte-bounded LRU stores keyed by object key and variant. RAM capacity is bounded by each instance’s usable 22 GB; SSD capacity is bounded by the declared disk tier. Cache misses fill from the provider and coalescing is explicit.',
    'A cache hit saves provider retrieval and fill traffic, but the response still uses the client link. A cache provides no durability credit.',
    'Queues and active buffers occupy RAM. Streaming retains 64 KB per active hop; buffered proxy mode retains the payload. The hard memory cap rejects work instead of inventing unlimited waiting.',
    'Capacity and cost are analytical at day 30. Cost uses normal daily demand for 30 days and reports any measured retry or fill ratios separately; incident replay cost is not extrapolated across the month.',
    'Compute price includes 8 cores, 24 GB RAM and 2 TB disk. Extra disk is charged by the incremental tier. Cache and metadata RAM are part of instance compute and are never billed a second time.',
    'Fixed client and provider endpoints are identified by region and id. Players may edit only their label and position; kind, region and configuration are verified outside the UI and in the backend.',
    'A p99.9 gate requires at least 10,000 successful samples per operation and case. If a run is too short, the deterministic duration is extended. An exhausted event or memory limit is an incomplete evaluation, never a pass.',
    'A scenario subset is exploratory and cannot claim qualification. All seven required cases, including each region outage, must pass at the selected replay seed. Calibration seeds are separate balance checks, not an unrepresented multi-seed result.',
    'Availability uses every offered request; rejected, timed out, incorrect, stale and missing-data responses are failures. Percentiles use successful responses only and are shown with their sample counts.',
    'The 10 s request drain is separate from the no-new-offers consistency postlude. The postlude runs through the last committed ACK + 120 s and checks publication of every committed upload, including commits whose ACK was lost. Background work/cost are counted but excluded from measured-window load averages.',
    'The backend never trusts a client-computed result, graph digest, workload, catalog or price. It reparses and re-evaluates the submitted graph with this level and catalog.',
  ],
};

/** Authoritative level, validated at module load. */
export const IMAGE_LEVEL: ImageLevel = imageLevelSchema.parse(level);

export function cloneImageLevel(): ImageLevel {
  return JSON.parse(JSON.stringify(IMAGE_LEVEL)) as ImageLevel;
}

export function parseImageLevel(input: unknown): ImageParseResult<ImageLevel> {
  const parsed = imageLevelSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      value: null,
      issues: imageIssuesFromZod(parsed.error),
    };
  }
  return { ok: true, value: parsed.data, issues: [] };
}

export function imageLevelJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(imageLevelSchema, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;
  return {
    ...generated,
    $id: 'https://system-design-game.local/schemas/image-atlas-level.json',
    title: 'Image Atlas level',
  };
}

/** One payload for the agent CLI/API discovery and public help. */
export function describeImageLevel(): {
  level: ImageLevel;
  catalog: ReturnType<typeof cloneImageCatalog>;
  graphSchema: Record<string, unknown>;
  resultSchema: Record<string, unknown>;
  levelSchema: Record<string, unknown>;
  catalogSchema: Record<string, unknown>;
  componentLimits: typeof IMAGE_COMPONENT_LIMITS;
  operations: readonly string[];
  businessOperations: readonly string[];
  scenarios: readonly string[];
  rules: readonly string[];
} {
  return {
    level: cloneImageLevel(),
    catalog: cloneImageCatalog(),
    graphSchema: imageGraphJsonSchema(),
    resultSchema: imageEvaluationJsonSchema(),
    levelSchema: imageLevelJsonSchema(),
    catalogSchema: imageCatalogJsonSchema(),
    componentLimits: IMAGE_COMPONENT_LIMITS,
    operations: [...IMAGE_COMPONENT_LIMITS.operations],
    businessOperations: [...IMAGE_COMPONENT_LIMITS.businessOperations],
    scenarios: [...IMAGE_REQUIRED_SCENARIOS],
    rules: [
      'Exactly three fixed regional clients (client-na/eu/ap) and three fixed provider endpoints (blob-na/eu/ap) must exist. Their kind, region and config are locked; labels and positions are editable. The Client node has a 100 Gbit/s population aggregate link; each business request has a separate 1 Gbit/s access link shared by its child transfers.',
      'Each client has one or more explicit traffic edges to apps. The engine chooses the lowest-latency healthy connected app after 250 ms failure detection and never follows an implicit edge. Direct clients may list one or more explicit provider endpoints; the nearest healthy connected endpoint is selected. Proxy clients have no blob edges.',
      'A proxy app routes to one provider directly or to exactly one cache that routes to one provider. Direct apps have no blob edge.',
      'Each app has exactly one metadata edge. That store serves the app’s reads and accepts new immutable uploads as an origin. Every metadata store attached to an app is an origin and may also be a replica.',
      'Replicate edges are direct origin-to-recipient logs. Cycles consisting only of replicate edges are allowed and deduped per origin/sequence; records are not recursively rebroadcast. Missing edges are valid-but-incomplete distribution and can fail runtime freshness.',
      'Same upload id/same content has one business effect; same id/different content is rejected. An upload id is bound to its first healthy origin before payload transmission and all retries reuse it. An unavailable owner leaves the id pending; it is never appended at another origin.',
      'A metadata node needs instances divisible by replicas. shardCount = instances / replicas and logical capacity = shardCount x diskTb. Capacity provisions the complete regional dataset for every metadata store independent of delivered replication.',
      'A cache node has exactly one outgoing provider path. Its capacity must fit per-instance RAM (22 GB) or its declared SSD tier.',
      'Impossible links, self loops, duplicate ids or tuples, dangling endpoints, non-replicate cycles and extra fixed endpoints are errors.',
      'Missing indexes, undersized metadata and unsafe cache allocations are reported. A sparse or partial graph still gets a capacity estimate instead of a crash.',
      'The 10 s request drain is followed by a separate no-new-offers consistency/postlude window through last ACK + 120 s. Committed records, including lost-ACK commits, must become visible; this evidence is part of a pass.',
      'Only the evaluator can qualify a graph. Reference candidates are uncalibrated examples, not promised passing witnesses.',
    ],
  };
}
