import {
  PARCEL_CONTENT_VERSION,
  PARCEL_LEVEL_ID,
  PARCEL_MODEL_VERSION,
  PARCEL_PRICING_VERSION,
  PARCEL_REQUIRED_HORIZONS,
  PARCEL_SCHEMA_VERSION,
  type ParcelLevel,
} from './contracts';

/**
 * Authoritative Parcel Pulse level. The public JSON copy in
 * `public/levels/parcel-pulse.json` is checked against this value by tests.
 * Imported graphs cannot override any field here.
 */
export const PARCEL_LEVEL: ParcelLevel = {
  schemaVersion: PARCEL_SCHEMA_VERSION,
  contentVersion: PARCEL_CONTENT_VERSION,
  modelVersion: PARCEL_MODEL_VERSION,
  pricingVersion: PARCEL_PRICING_VERSION,
  id: PARCEL_LEVEL_ID,
  title: 'Parcel Pulse',
  description:
    'Track 2 million parcels a day while status, history, ingest and warehouse reports share the same hardware. Build a durable design that survives year one and year five within budget.',
  durationMs: 60_000,
  drainMs: 60_000,
  horizons: PARCEL_REQUIRED_HORIZONS,
  workload: {
    dailyParcels: 2_000_000,
    eventsPerParcel: 12,
    eventBytes: 1024,
    daysPerYear: 365,
    phaseMultiplier: [
      {
        id: 'normal',
        fromMs: 0,
        toMs: 20_000,
        multiplier: 0.2,
        label: 'Normal',
      },
      {
        id: 'evening',
        fromMs: 20_000,
        toMs: 40_000,
        multiplier: 1,
        label: 'Evening burst',
      },
      {
        id: 'recovery',
        fromMs: 40_000,
        toMs: 60_000,
        multiplier: 0.3,
        label: 'Recovery',
      },
    ],
    peakRatesPerSecond: {
      status: 10_000,
      history: 500,
      ingest: 4_000,
      report: 0.1,
    },
    reportScheduleMs: [10_000, 20_000, 25_000, 30_000, 35_000, 50_000],
    reportWarehouseIds: [0, 1, 2, 3, 4, 5],
    warehouseCount: 1_000,
    reportWindowDays: 30,
    /**
     * This release simulates every offered request (factor 1). The field is
     * part of the frozen result shape so a future release can lower the
     * evaluation cost without changing consumers.
     */
    sampleFactor: 1,
    sampledParcelKeys: 50_000,
    oldHistoryEveryNth: 5,
    oldHistoryAgeDaysAtYear5: 4 * 365,
    recentHistoryAgeDays: [1, 30],
    oldHistoryAgeDaysAtYear1: 300,
  },
  slo: {
    availability: 0.995,
    p95Ms: {
      status: 150,
      history: 500,
      ingest: 300,
      report: 30_000,
    },
    deadlineMs: {
      status: 1_000,
      history: 2_000,
      ingest: 1_000,
      report: 60_000,
    },
    freshnessMs: {
      status: 2_000,
      report: 60_000,
    },
  },
  budget: {
    monthlyUsd: 1_250,
    currency: 'USD',
    note:
      'Provisional monthly budget derived from calibration; prices are conditional in-game prices.',
  },
  defaultSeed: 101,
  refs: {
    trainingSeeds: [101, 211, 307],
    holdoutSeeds: [607, 701],
  },
  assumptions: [
    'Teaching model, not a production database benchmark. All prices are conditional in-game prices.',
    'Every offered request is simulated in this release (sample factor 1). Demand and seeds never depend on the graph.',
    'Status and history use a bounded sampled parcel keyspace (50,000 ids) with causal timestamps, not billions of materialised rows.',
    'Historical ages are causal: year 5 keeps an explicit 20% four-year-old history cohort; year 1 uses the oldest retained age instead.',
    'Rows and bytes per operation are explicit approximations; CPU/IO service work derives from scanned rows, touched bytes, indexes and replication.',
    'Reports are scheduled at 10/20/25/30/35/50 seconds for warehouses 0..5, uniformly across 1000 warehouses. They are not Poisson arrivals.',
    'Provisioned capacity and price are fixed for the five-year TCO window (730 hours per month, 60 months). Used storage is shown per horizon.',
    'Replication is asynchronous queued work. Freshness is the measured accepted-write to projection-completion lag, not a configuration label.',
    'Deadlines do not cancel work for free: late work keeps using resources and counts as a timeout after it completes. Deadlines are wider than the p95 targets so a p95 target is not a 100% deadline.',
    'Node queues are explicitly bounded at 500 queued tasks per CPU core. When a node queue is full, new work is rejected and counted as a failure.',
    'Columnar projections are explicitly clustered by warehouse; cluster metadata is charged in storage and write CPU, and monthly partitions prune report scans to the two-month boundary.',
    'Replication completion is tracked with contiguous sequence watermarks. A missing or rejected batch never advances freshness past the gap.',
    'Average CPU/IO/network utilization and average queue depth cover the 60-second offered traffic window. Drain work still runs and is judged by deadlines, but empty drain time does not dilute averages. Peaks are also measured inside that window.',
    'Memory size is shown in the catalog but RAM caching is not modeled. No design receives a cache-hit bonus from memoryGb.',
  ],
};
