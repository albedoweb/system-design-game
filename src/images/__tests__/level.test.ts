import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as images from '../index';
import {
  IMAGE_CATALOG,
  IMAGE_COMPONENT_LIMITS,
  IMAGE_LEVEL,
  IMAGE_LEVEL_ID,
  IMAGE_REQUIRED_SCENARIOS,
  IMAGE_SCENARIOS,
  createImageGraph,
  describeImageLevel,
  estimateImageCapacity,
  imageCatalogJsonSchema,
  imageEvaluationJsonSchema,
  imageGraphJsonSchema,
  imageLevelJsonSchema,
  parseImageGraph,
  parseImageLevel,
} from '../index';

describe('Image Atlas public level JSON', () => {
  it('matches the authoritative TypeScript level definition', () => {
    const path = resolve(process.cwd(), 'public', 'levels', 'image-atlas.json');
    const file = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    expect(file).toEqual(IMAGE_LEVEL);
  });

  it('matches the authoritative catalog and JSON schemas', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    expect(ajv.compile(imageLevelJsonSchema())(IMAGE_LEVEL)).toBe(true);
    expect(ajv.compile(imageCatalogJsonSchema())(IMAGE_CATALOG)).toBe(true);
    expect(parseImageLevel(IMAGE_LEVEL).ok).toBe(true);
  });

  it('rejects caller overrides of workload, prices and seed', () => {
    expect(parseImageLevel({ ...IMAGE_LEVEL, workload: { users: 1 } }).ok).toBe(
      false,
    );
    expect(parseImageLevel({ ...IMAGE_LEVEL, prices: { compute: 0 } }).ok).toBe(
      false,
    );
    expect(parseImageLevel({ ...IMAGE_LEVEL, seed: 1 }).ok).toBe(false);
    expect(parseImageLevel({ ...IMAGE_LEVEL, budget: 1 }).ok).toBe(false);
  });
});

describe('Image Atlas frozen workload arithmetic', () => {
  it('derives the declared mature dataset and average rates', () => {
    const dataset = IMAGE_LEVEL.dataset;
    expect(
      dataset.users * dataset.uploadsPerUserPerDay * dataset.retentionDays,
    ).toBe(1_500_000_000);
    expect(
      dataset.users * dataset.uploadsPerUserPerDay * dataset.retentionDays * dataset.originalBytes,
    ).toBe(6e15);
    expect(
      dataset.users * dataset.uploadsPerUserPerDay * dataset.retentionDays * dataset.metadataBytes,
    ).toBe(12e12);
    expect(IMAGE_LEVEL.workload.averageRatesPerSecond.upload).toBeCloseTo(
      50_000_000 / 86_400,
      9,
    );
    expect(IMAGE_LEVEL.workload.averageRatesPerSecond.search).toBeCloseTo(
      50_000_000 / 86_400,
      9,
    );
    expect(IMAGE_LEVEL.workload.averageRatesPerSecond.detail).toBeCloseTo(
      100_000_000 / 86_400,
      9,
    );
    expect(IMAGE_LEVEL.workload.traceSeedPolicy).toBe('graph-independent');
    expect(IMAGE_LEVEL.workload.replicaInitialState).toBe('caught-up');
    expect(IMAGE_LEVEL.workload.cacheInitialState).toBe('empty');
    expect(IMAGE_LEVEL.workload.hotKeyShare).toBe(0.8);
    expect(IMAGE_LEVEL.workload.hotKeys).toBe(10_000);
    expect(IMAGE_LEVEL.workload.longTailRepresentativeKeys).toBe(1_000_000);
  });

  it('defines three equal regions and the full-mesh links from the freeze', () => {
    expect(IMAGE_LEVEL.regions.map((region) => region.id)).toEqual([
      'na',
      'eu',
      'ap',
    ]);
    expect(
      IMAGE_LEVEL.regions.reduce((sum, region) => sum + region.demandShare, 0),
    ).toBeCloseTo(1, 12);
    expect(IMAGE_LEVEL.network.interRegionLinks).toEqual([
      expect.objectContaining({
        a: 'na',
        b: 'eu',
        bandwidthGbitPerSec: 100,
        oneWayLatencyMs: 40,
      }),
      expect.objectContaining({
        a: 'eu',
        b: 'ap',
        bandwidthGbitPerSec: 100,
        oneWayLatencyMs: 70,
      }),
      expect.objectContaining({
        a: 'na',
        b: 'ap',
        bandwidthGbitPerSec: 100,
        oneWayLatencyMs: 80,
      }),
    ]);
    expect(IMAGE_LEVEL.network.localPropagationMs).toBe(1);
    expect(IMAGE_LEVEL.network.oneExplicitPathPerTransfer).toBe(true);
    expect(IMAGE_LEVEL.network.clientLinksFullDuplex).toBe(true);
    expect(IMAGE_LEVEL.network.aggregateClientBandwidthGbitPerSec).toBe(100);
    expect(IMAGE_LEVEL.network.requestAccessBandwidthGbitPerSec).toBe(1);
    expect(IMAGE_LEVEL.network.clientTrafficChargedOnAggregate).toBe(true);
    expect(IMAGE_LEVEL.network.routingFailureDetectionMs).toBe(250);
    expect(IMAGE_LEVEL.network.selectsNearestHealthyConnectedApp).toBe(true);
    expect(IMAGE_LEVEL.network.missingEdgeRouting).toBe('forbidden');
    expect(
      IMAGE_LEVEL.regions.every(
        (region) =>
          region.aggregateBandwidthGbitPerSec === 100 &&
          region.requestAccessBandwidthGbitPerSec === 1,
      ),
    ).toBe(true);
    expect(IMAGE_CATALOG.client).toEqual({
      fullDuplex: true,
      aggregateBandwidthGbitPerSec: 100,
      requestAccessBandwidthGbitPerSec: 1,
      clientRttMs: 20,
      routingFailureDetectionMs: 250,
      note: expect.any(String),
    });
    expect(IMAGE_LEVEL.metadataProtocol).toEqual({
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
    });
    expect(IMAGE_LEVEL.qualification.postlude).toEqual({
      noNewOffers: true,
      maxAfterLastAckMs: 120_000,
      backgroundWorkCounted: true,
      includedInMeasuredLoad: false,
      coversLostAckCommits: true,
    });
  });

  it('defines every required scenario and its qualification window', () => {
    expect(IMAGE_LEVEL.qualification.requiredScenarios).toEqual([
      ...IMAGE_REQUIRED_SCENARIOS,
    ]);
    expect(IMAGE_LEVEL.qualification.scenarios.map((item) => item.name)).toEqual(
      [...IMAGE_SCENARIOS],
    );
    expect(IMAGE_LEVEL.qualification.warmupMs).toBe(20_000);
    expect(IMAGE_LEVEL.qualification.measuredMs).toBe(60_000);
    expect(IMAGE_LEVEL.qualification.drainMs).toBe(10_000);
    expect(IMAGE_LEVEL.qualification.minimumP999Samples).toBe(10_000);
    expect(IMAGE_LEVEL.qualification.calibrationSeeds).toEqual([
      101, 211, 307,
    ]);
    const regionFaults = IMAGE_LEVEL.qualification.scenarios.filter((item) => item.fault.kind === 'region');
    expect(regionFaults.map((item) => item.name)).toEqual(['region-na-failure', 'region-eu-failure', 'region-ap-failure']);
    expect(regionFaults.map((item) => item.fault.kind === 'region' ? item.fault.region : null)).toEqual(['na', 'eu', 'ap']);
    const linkFault = IMAGE_LEVEL.qualification.scenarios.find(
      (item) => item.name === 'link-failure',
    );
    expect(linkFault?.fault.kind).toBe('link');
    if (linkFault?.fault.kind === 'link') {
      expect(linkFault.fault.a).toBe('na');
      expect(linkFault.fault.b).toBe('eu');
      expect(linkFault.fault.directions).toBe('both');
    }
    const nodeFault = IMAGE_LEVEL.qualification.scenarios.find(
      (item) => item.name === 'node-failure',
    );
    expect(nodeFault?.fault.kind).toBe('node');
    if (nodeFault?.fault.kind === 'node') {
      expect(nodeFault.fault.target).toBe('one-instance-per-pool');
    }
  });

  it('freezes the normal/incident SLO and budget', () => {
    expect(IMAGE_LEVEL.slo.normal).toEqual({
      availability: 0.995,
      detailP999Ms: 300,
      searchP999Ms: 250,
      uploadP999Ms: 1_000,
    });
    expect(IMAGE_LEVEL.slo.incident).toEqual({
      availability: 0.98,
      detailP999Ms: 600,
      searchP999Ms: 800,
      uploadP999Ms: 2_000,
    });
    expect(IMAGE_LEVEL.slo.deadlinesMs).toEqual({
      upload: 5_000,
      search: 3_000,
      detail: 2_000,
    });
    expect(IMAGE_LEVEL.slo.freshnessMs).toBe(120_000);
    expect(IMAGE_LEVEL.budget.monthlyUsd).toBe(205_000);
  });

  it('keeps provider latency bands explicit and normalised', () => {
    const read = IMAGE_CATALOG.provider.readStartLatencyBands;
    const write = IMAGE_CATALOG.provider.writeStartLatencyBands;
    expect(read.map((band) => band.ms)).toEqual([35, 70, 100, 120]);
    expect(write.map((band) => band.ms)).toEqual([80, 140, 200]);
    expect(
      read.reduce((sum, band) => sum + band.probability, 0),
    ).toBeCloseTo(1, 12);
    expect(
      write.reduce((sum, band) => sum + band.probability, 0),
    ).toBeCloseTo(1, 12);
    expect(IMAGE_CATALOG.provider.materializedThumbnails).toBe(false);
    expect(IMAGE_CATALOG.provider.internalReplicationIncluded).toBe(true);
    expect(IMAGE_CATALOG.provider.remoteReadVisibilityMs).toBe(60_000);
  });
});

describe('Image Atlas discovery and public help', () => {
  it('exports the complete contract surface and no fake evaluator', () => {
    for (const name of [
      'IMAGE_LEVEL',
      'IMAGE_CATALOG',
      'IMAGE_LEVEL_ID',
      'parseImageGraph',
      'validateImageGraph',
      'imageGraphDigest',
      'createImageGraph',
      'estimateImageCapacity',
      'imageGraphJsonSchema',
      'imageEvaluationJsonSchema',
    ] as const) {
      expect(name in images).toBe(true);
    }
    expect(typeof images.evaluateImages).toBe('function');
    expect(typeof images.IMAGE_WORK_MODEL).toBe('object');
    expect(IMAGE_LEVEL_ID).toBe('image-atlas');
    expect(IMAGE_COMPONENT_LIMITS.maxNodes).toBe(60);
    expect(IMAGE_COMPONENT_LIMITS.maxEdges).toBe(160);
  });

  it('returns a bounded describe payload for CLI/API consumers', () => {
    const described = describeImageLevel();
    expect(described.level.id).toBe('image-atlas');
    expect(described.catalog.pricingVersion).toBe(
      IMAGE_CATALOG.pricingVersion,
    );
    expect(described.graphSchema).toEqual(imageGraphJsonSchema());
    expect(described.resultSchema).toEqual(imageEvaluationJsonSchema());
    expect(described.componentLimits.maxNodes).toBe(60);
    expect(described.scenarios).toEqual([...IMAGE_SCENARIOS]);
    expect(described.rules.length).toBeGreaterThan(5);
  });

  it('ships English public help that explains route, shard and cost choices', () => {
    const path = resolve(process.cwd(), 'public', 'help', 'image-atlas.md');
    const help = readFileSync(path, 'utf8');
    expect(help.length).toBeGreaterThan(2_000);
    for (const phrase of [
      'shardCount',
      'user-tag',
      'one instance per pool',
      '$205,000',
      'direct',
      'proxy',
      'client-na',
      'blob-na',
      'cross-region',
      '100 Gbit/s',
      '1 Gbit/s',
      'origin',
      'postlude',
      '120 s',
    ]) {
      expect(help).toContain(phrase);
    }
  });

  it('creates a valid starter graph that is explicitly undersized', () => {
    const starter = createImageGraph();
    const parsed = parseImageGraph(starter);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const estimate = estimateImageCapacity(parsed.graph);
    expect(estimate.capacity.capacityOk).toBe(false);
    expect(starter.name?.toLowerCase()).toContain('undersized');
    expect(starter.name?.toLowerCase()).toContain('uncalibrated');
  });
});
