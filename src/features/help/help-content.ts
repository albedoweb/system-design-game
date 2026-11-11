import type { LevelRoute } from '../../parcel/ui/level-route';

export const HELP_CATEGORY_IDS = [
  'getting-started',
  'components',
  'reading-results',
  'troubleshooting',
  'level-guide',
] as const;

export type HelpCategoryId = (typeof HELP_CATEGORY_IDS)[number];

export interface HelpSection {
  heading: string;
  paragraphs?: readonly string[];
  steps?: readonly string[];
  bullets?: readonly string[];
  note?: string;
}

export interface HelpCategory {
  id: HelpCategoryId;
  label: string;
  sections: readonly HelpSection[];
}

const GETTING_STARTED: HelpCategory = {
  id: 'getting-started',
  label: 'Getting started',
  sections: [
    {
      heading: 'A simple loop',
      steps: [
        'Read the Task panel for the exact workload, targets, budget and special events.',
        'Build or adjust the graph with the components and links in the palette.',
        'Run the real evaluation.',
        'Read the first failed check, then the diagnostics or node metrics behind it.',
        'Change one thing, keep the same seed, and run again to compare like with like.',
      ],
    },
    {
      heading: 'Saving, reset and tabs',
      paragraphs: [
        'Export writes the graph, settings and seed to a file. Nothing is saved automatically, so refresh or Reset returns to the starter graph. Tabs and windows keep independent editor and run state.',
        'Opening Help does not pause, clone or reset a running simulation.',
      ],
    },
  ],
};

const COMPONENTS: HelpCategory = {
  id: 'components',
  label: 'Components',
  sections: [
    {
      heading: 'Shared vocabulary',
      paragraphs: [
        'Each level exposes different components and finite resources. Size usually sets both capacity and price; bigger is not automatically better.',
      ],
      bullets: [
        'Client — the source of demand. In most levels it is fixed.',
        'Cache — serves saved copies for repeated reads when the level offers one. It helps reads, not fresh writes; a write still reaches the durable store.',
        'Store or database — durable data with finite capacity plus level-specific indexes, retention or replicas.',
        'Link — carries one operation. Latency is always modelled; shared bandwidth appears where the level defines it.',
        'Finite resources differ by level: Cold Cache app servers have request slots, a queue and a bounded dependency pool, while other levels use pools, shards or store capacity with their own limits.',
      ],
    },
    {
      heading: 'What each level offers',
      bullets: [
        'Live Audience: fixed Users, one Application pool, one primary SQL Database with a query or projection read plan, and optional Managed Load Balancer, Cache and Worker pool.',
        'Live Scoreboard: fixed Users, an Application pool, one primary SQL Database with a scan or maintained-aggregate read plan, and an optional Cache.',
        'Cold Cache: client, load balancer, app servers, cache and database.',
        'Parcel Pulse: client, application, SQL, KV and columnar stores, joined by replication edges.',
        'Image Atlas: regional clients, application pools, metadata stores, caches and fixed regional blob endpoints.',
      ],
      note: 'The palette is the source for what a level actually provides.',
    },
  ],
};

const READING_RESULTS: HelpCategory = {
  id: 'reading-results',
  label: 'Reading results',
  sections: [
    {
      heading: 'Checks before totals',
      paragraphs: [
        'Start with the result banner and the SLO checks. A failed check is the thing to fix; diagnostics are clues, not always a full cause.',
      ],
    },
    {
      heading: 'Averages, peaks and percentiles',
      bullets: [
        'An SLO is a target for speed and reliability. Availability counts every offered request, including errors, rejects, timeouts, stale and missing answers.',
        'p95 = 200 ms means 95% of successful requests finish within 200 ms; p99.9 looks at a much rarer tail. Latency percentiles cover successful responses only, so they can look better while failures rise; availability must pass too.',
        'A 20% average with a 100% peak is a burst, not automatically a failure; inspect queues and errors. Peak utilization, queue peaks and pool waits show pressure that an average misses.',
        'Cold Cache, Parcel Pulse and Live Scoreboard gate on p95. Image Atlas gates on p99.9. These answer different questions, so do not compare their numbers across levels.',
        'Live Scoreboard checks availability and successful p95 for each operation over the whole measured run and again over the peak offer cohort. A good quiet period cannot hide a failed peak.',
        'Live Audience checks the same operation gates over the whole case and the critical cohort, and additionally checks every successful ranking for an exact 15-minute snapshot and for freshness at delivery. A cached answer that is still returned after the 5 s freshness limit fails even if the cache TTL is longer.',
        'Queue p95 is the 95th-percentile queue wait for an operation, node or link. It is not a sum of stage latencies or an exact cause; there is no per-request waterfall.',
      ],
    },
    {
      heading: 'Cost and freshness',
      bullets: [
        'A previous result is stale as soon as the graph or seed changes.',
        'Live cost estimates the graph on the canvas. Some levels show configuration cost or analytical TCO rather than a measured bill; trust the label shown in the level.',
        'Parcel Pulse separates request metrics from storage and TCO. Image Atlas separates normal, peak and incident cases from capacity cost. Cold Cache shows an hourly configuration cost.',
        'Checks without data do not pass.',
      ],
    },
  ],
};

const TROUBLESHOOTING: HelpCategory = {
  id: 'troubleshooting',
  label: 'Troubleshooting',
  sections: [
    {
      heading: 'Blocked, failed or not passed',
      bullets: [
        'Run blocked means the graph cannot be evaluated at all, such as a missing required endpoint or invalid fixed node. Fix the named issue; rerunning alone will not help.',
        'Run failed means the simulation stopped with an error. The message is the evidence to inspect.',
        'Not passed with a valid graph means the design ran but missed a target. Open the failing check and its operation or time window.',
      ],
    },
    {
      heading: 'Common signals',
      bullets: [
        'Availability low, latency fine? Look for queue overflow, rejected traffic, node failure, missing routes or a query that needs an index.',
        'Latency high, availability fine? Look for too few slots or instances, queue growth, hot keys, a small cache, or saturated links and replication.',
        'Budget exceeded? Remove capacity you do not use; include fixed provider, egress and replica copies.',
        'A later horizon fails while the first passes? Storage, retained history and replication lag grow with the dataset. Replicas add copies and read capacity, not free storage.',
        'An Image Atlas search reports missing data? The store’s index does not cover that query; this version has no full-scan fallback.',
      ],
    },
  ],
};

const LEVEL_GUIDE_CATEGORY: HelpCategory = {
  id: 'level-guide',
  label: 'Level guide',
  sections: [],
};

export const HELP_CATEGORIES: readonly HelpCategory[] = [
  GETTING_STARTED,
  COMPONENTS,
  READING_RESULTS,
  TROUBLESHOOTING,
  LEVEL_GUIDE_CATEGORY,
];

export interface HelpLevelGuide {
  title: string;
  tagline: string;
  sections: readonly HelpSection[];
}

const LEVEL_GUIDES: Record<LevelRoute, HelpLevelGuide> = {
  'live-audience': {
    title: 'Live Audience',
    tagline:
      'Exact top-20 audience rankings over a 15-minute window, under a live peak and one Application failure.',
    sections: [
      {
        heading: 'The interaction',
        paragraphs: [
          'Add an Application and a SQL Database from the Components tab, then connect them with the Connect form or by dragging from a node’s output connector to an input connector. A Managed Load Balancer, a Cache and a Worker pool are optional additions. Select a component or link to edit it in Properties.',
          'The starter contains only the fixed Users node. Export saves the graph, positions and seed to a file; nothing is saved automatically. Refresh and Reset both start again from Users and the default seed. Tabs and windows keep independent editor and run state.',
        ],
      },
      {
        heading: 'What the run measures',
        bullets: [
          'Users create Record activity events and ask for View audience ranking. A ranking is exactly the top 20 of 100 streams by unique viewers active in the previous 15 minutes. Repeating an event does not add a viewer, and one user may watch several streams.',
          'A ranking answer names the exact snapshot it represents. Every successful answer is checked for the exact window and for freshness at delivery, not just for transport success.',
          'Expiry is real work: activity leaves the 15-minute window during the measured run, so the query or projection must apply that boundary even though the prehistory is seeded.',
          'Availability and successful p95 are checked for both operations over the whole case and separately over the critical offer cohort: 20–60 s for peak and 30–50 s for each Application failure case.',
          'Every design runs normal, peak and one peak-plus-failure case for each physical Application instance. Only a run where every required case passes is qualified; the score is then the actual peak-case cost, not a sum of all cases.',
        ],
      },
      {
        heading: 'Knobs and fixed policies',
        paragraphs: [
          'Meaningful settings are Application instances, SQL size and read strategy, the optional Cache TTL and Worker instances. Health probes, retry rules, queue caps, projection batches and routing are fixed and shown read-only in the Task panel and this guide; they are not hidden controls.',
          'A Cache TTL is the actual retention you select. The freshness limit is 5 seconds: a payload that is still cached but older than that fails freshness even with a longer TTL. Nothing clamps the TTL behind your back.',
          'A direct Users → Application path always reaches physical slot 0; spare instances are not used without the Managed Load Balancer. A failure case targets each physical slot by index, independent of node order or names.',
        ],
      },
      {
        heading: 'Reading results',
        bullets: [
          'The case selector chooses the real series and report for that case; it is not only a label. Charts use the selected case, and hovering seeks that same case’s recorded frames.',
          'A recorded replay is a view of measured frames. It never reruns the engine, and a stopped or stale run never animates as live.',
          'A high CPU peak alone is not an error. Failure and pressure markers come from measured local rejects, timeouts, crashes or the reported target lifecycle.',
          'Hourly rent is reported separately from the actual run cost. Figures marked as samples or averages are not spikes, and unavailable values stay —',
        ],
      },
    ],
  },
  'live-scoreboard': {
    title: 'Live Scoreboard',
    tagline: 'One shared ranking, live vote changes and a short measured peak.',
    sections: [
      {
        heading: 'The interaction',
        paragraphs: [
          'Add Application, SQL Database or an optional Cache from the Components tab, then connect components with the Connect form or by dragging from a node’s output connector to an input connector. Select a node or link to edit it in Properties.',
          'The starter contains only the fixed Users node. Export saves the graph, positions and seed to a file; nothing is saved automatically. Refresh and Reset both start again from Users and the default seed.',
        ],
      },
      {
        heading: 'What the run measures',
        bullets: [
          'Every vote change replaces the participant’s previous choice; it must not append a second vote or be counted twice. Acknowledged votes must survive.',
          'Leaderboard snapshots may be up to 5 seconds behind. Freshness is measured against committed changes, not the age of an arbitrary timestamp.',
          'Availability and successful p95 are checked for each operation over the whole 90 s run and separately over the 20–60 s peak offer cohort.',
          'The cache starts cold. Concurrent misses for the shared answer are coalesced, and waiting clients keep their own deadline.',
          'Cost is the actual rental for preparation, the measured run and drain, plus delivered response bytes. Hourly rent is reported separately. Among complete passing designs, lower actual cost ranks first.',
        ],
      },
      {
        heading: 'Reading pressure',
        bullets: [
          'Node highlights come from measured local queue, reject, timeout or resource evidence on that component, not from a global failed SLO.',
          'Charts show the engine’s measured series after a completed run; the canvas can animate the recorded frames without rerunning the engine.',
          'A previous result is hidden when the semantic graph or seed changes. Moving a node is not a semantic change.',
        ],
      },
    ],
  },
  'cold-cache': {
    title: 'Cold Cache',
    tagline: 'Shared read and write traffic, with a cache flush during the peak.',
    sections: [
      {
        heading: 'The situation',
        paragraphs: [
          'The cache is flushed during the run and stays available. The Task panel states when the flush happens and which window is scored separately.',
        ],
      },
      {
        heading: 'What matters',
        bullets: [
          'Cache helps repeated reads; writes still reach the database, so the flush mainly creates read misses.',
          'Read misses and writes share the database’s finite slots and queue past capacity. App servers add their own slots and dependency pool.',
          'Use the same seed to compare a design before and after the flush.',
        ],
      },
    ],
  },
  'parcel-pulse': {
    title: 'Parcel Pulse',
    tagline: 'Status, history, ingest and warehouse reports sharing one durable design.',
    sections: [
      {
        heading: 'The situation',
        paragraphs: [
          'Status, history, ingest and warehouse reports share one design, and both long horizons must pass.',
        ],
      },
      {
        heading: 'Stores and queries',
        bullets: [
          'Ingest must be durable before acknowledgement. Status reads the latest state; history reads older events.',
          'SQL indexes support history and reports. KV buckets make history key lookups and rollups make reports cheaper. Columnar partitions and column projection keep report scans small.',
          'Set retention to cover the required history. Asynchronous replication can lag, and freshness counts that lag; replicas cost storage as well as adding read capacity.',
        ],
      },
      {
        heading: 'Two views',
        paragraphs: [
          'Request metrics come from the measured window. Storage and TCO are analytical estimates.',
        ],
      },
    ],
  },
  'image-atlas': {
    title: 'Image Atlas',
    tagline: 'Uploads, search and detail across three regions with one fixed provider.',
    sections: [
      {
        heading: 'The situation',
        paragraphs: [
          'Uploads, searches and detail must meet availability and p99.9 targets across normal, peak and incident cases.',
        ],
      },
      {
        heading: 'Routes and indexes',
        bullets: [
          'Each app selects exactly one metadata store. A search needs the matching index; with none it fails as missing data, because this version has no full-scan fallback.',
          'Direct delivery fetches bytes from a provider endpoint and forbids app blob edges. Proxy delivery passes bytes through the app, optionally one cache, and forbids client blob edges.',
        ],
      },
      {
        heading: 'Regions and replicas',
        bullets: [
          'Metadata instances split into shards; replicas add durable copies and shape the read quorum.',
          'Caches are byte-bounded and are not durable storage.',
          'Client, app and inter-region links are shared physical capacity, not one link per arrow.',
        ],
      },
    ],
  },
};

export function levelGuide(route: LevelRoute): HelpLevelGuide {
  return LEVEL_GUIDES[route];
}

export const LEVEL_GUIDE_ORDER: readonly LevelRoute[] = [
  'live-audience',
  'live-scoreboard',
  'cold-cache',
  'parcel-pulse',
  'image-atlas',
];
