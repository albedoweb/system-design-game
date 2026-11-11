# Agent CLI — five levels

The CLI exposes the same parsers, validators, capacity models and evaluators as
the browser and the API. One shared registry dispatches **Cold Cache**, **Parcel
Pulse**, **Image Atlas**, **Live Scoreboard** and **Live Audience**. Imported
JSON is data only: it cannot execute code, select another level, override a
level workload, patch prices/SLOs or change the mandatory qualification set.

All product-facing strings are English. Prices are **conditional in-game
prices**, not vendor quotes.

## Browser save files

Saving in the browser is explicit and file-based. The UI Export button writes a
versioned state envelope (`kind: "sdg-level-state"`) that carries the graph
(including node settings and positions) and the seed. Nothing is saved
automatically, and reloading a tab starts from the starter graph with the
default seed and no previous run. Agent and API inputs use the envelope's
`graph` field plus its `seed`; the bare graph JSON schema is unchanged, and the
browser Import button still accepts older graph-only files.

## Commands

```bash
npm run --silent agent -- levels
npm run --silent agent -- describe --level cold-cache
npm run --silent agent -- describe --level parcel-pulse
npm run --silent agent -- describe --level image-atlas
npm run --silent agent -- describe --level live-scoreboard
npm run --silent agent -- describe --level live-audience
npm run --silent agent -- schema --level parcel-pulse --kind graph
npm run --silent agent -- schema --level cold-cache --kind result
npm run --silent agent -- schema --level live-scoreboard --kind catalog
npm run --silent agent -- schema --level live-audience --kind catalog
npm run --silent agent -- example --level image-atlas --family starter > graph.json
npm run --silent agent -- example --level live-scoreboard --family family-aggregate
npm run --silent agent -- example --level live-audience --family family-query-large
npm run --silent agent -- validate --level parcel-pulse --graph graph.json
npm run --silent agent -- validate --level live-scoreboard --graph graph.json
npm run --silent agent -- validate --level live-audience --graph graph.json
npm run --silent agent -- run --level cold-cache --graph graph.json --seed 101
npm run --silent agent -- run --level parcel-pulse --graph graph.json --seed 101 --horizon 5
npm run --silent agent -- run --level image-atlas --graph graph.json --seed 101 --scenario normal,peak
npm run --silent agent -- run --level live-scoreboard --graph graph.json --seed 101
npm run --silent agent -- run --level live-scoreboard --graph graph.json --seed 101 --compact-result
npm run --silent agent -- run --level live-audience --graph graph.json --seed 101
npm run --silent agent -- run --level live-audience --graph graph.json --seed 101 --compact-result
npm run --silent agent -- batch --level parcel-pulse --graphs a.json,b.json --seeds 101,211,307
```

Use `npm run --silent` for machine pipelines: without `--silent`, npm prints
its own banner on stdout and the output is not one JSON document. The agent
script itself writes only structured JSON to stdout; human-facing errors also go
to stderr. `--compact` removes whitespace; the default is pretty JSON.
`--graph -` reads the document from stdin.

- `levels` lists all five registered levels, their engine and whether evaluation
  is available in this build.
- `describe` returns the authoritative level, catalog, component limits, JSON
  schemas and rules for the selected level.
- `schema --kind graph|catalog|level|describe|result` returns one machine-readable
  payload (or all of them when `--kind` is omitted).
- `example` emits the confirmed starter graph or a real shipped fixture from the
  selected level. It never invents a passing witness.
- `validate` returns parse/semantic issues.
- `run` returns the full evaluation. `--compact-result` (additive) replaces it
  with a decision-useful summary: status, identity, failed required gates,
  whole/peak operation metrics, correctness, freshness, cost and window.
- `batch` evaluates a bounded graph × seed matrix and keeps every item
  structured.

`--level` defaults to `parcel-pulse`. Supported values are `cold-cache`,
`parcel-pulse`, `image-atlas`, `live-scoreboard` and `live-audience`; anything
else fails with `unsupported_level` before an evaluation starts.

`--horizon` is Parcel-only. `--scenario` is Image-only and requests an
exploratory subset of the seven mandatory cases; a subset can never report an
overall pass. Passing either flag to the wrong level is a usage error for
`validate`, `run` and `batch`; an explicitly empty list (`--scenario ,`) is
also a usage error instead of "option absent". The API never accepts horizons or
scenarios: it always runs the full mandatory set.

Limits: at most 32 graphs per batch, 16 seeds per batch, 1,000,000 bytes per
document, 16 nodes / 24 edges for Cold Cache, 32 nodes / 64 edges for Parcel
Pulse, 60 nodes / 160 edges for Image Atlas, 4 nodes / 8 edges for Live
Scoreboard and 6 nodes / 8 edges for Live Audience (per each graph schema).
File, stdin and batch inputs share one bounded byte reader: it stops at the
limit before an oversized document is allocated in full. A batch keeps that
error on the affected item.

Seeds are integers in the level's registered range. Cold Cache accepts
`0..4294967295`; Parcel Pulse, Image Atlas, Live Scoreboard and Live Audience
accept `0..2147483647`. The API body bound is `0..2147483647` for every level.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Command succeeded; for `run`/`batch`, the evaluation passed |
| 1 | Usage error, unreadable/invalid JSON, graph validation error, or invalid level |
| 2 | The evaluation ran but at least one required gate failed |
| 3 | Runtime incomplete (including an unavailable evaluator) or internal error |

`validate` uses 0 for a graph with no error-severity issues and 1 otherwise.
`batch` exits 3 for item errors/incomplete results, 1 for invalid items, 2 for
failed evaluations, otherwise 0.

## Result shapes

The CLI wraps each `run` result as `{ "command": "run", "level": "<id>", ... }`.

**Cold Cache** returns an explicit adapter envelope:

```json
{
  "status": "ok",
  "passed": true,
  "meta": {
    "schemaVersion": 1,
    "levelId": "cold-cache",
    "modelVersion": "1.0.0",
    "contentVersion": "1.0.0",
    "pricingVersion": "catalog-v1",
    "seed": 101,
    "graphDigest": "0011223344556677"
  },
  "issues": [],
  "result": { "seed": 101, "passed": true, "checks": [] }
}
```

`result` is the untouched `RunResult` from the frozen Cold Cache engine. The
adapter advances `createSimulation` to `durationMs + drainMs`; positions and
labels are ignored by the digest. An `ok` envelope must contain exactly the
nine frozen gate IDs with their expected targets/units, and each gate's
`passed` bit must agree with its numeric evidence and the returned cost and
snapshot summary. `status: "invalid"` has `result: null` and at least one error
issue. A bounded runtime limit returns `status: "incomplete"` with a safe
`error` and can never pass. A successful `ok` result always carries a non-null
semantic digest.

**Parcel Pulse** keeps its frozen result body: `status` (`ok`, `invalid`,
`error`), `passed`, `meta` (versions, seed, semantic digest, requested/required
horizons), `issues`, `diagnostics`, `assumptions`, per-horizon `operations`,
`nodes`, `capacity`, `cost` and `checks`. Both mandatory horizons are always
evaluated by `run`/`batch` unless `--horizon` explicitly requests an
investigation; an investigation cannot pass overall.

**Image Atlas** returns the frozen I101 result: `status` (`invalid`,
`incomplete`, `complete`), `passed`, bound `meta`, issues/diagnostics, capacity,
cost, top-level checks and one result per requested scenario with case gates,
postlude, freshness and data-integrity evidence. `passed: true` requires a
complete qualification run with all seven mandatory cases. In a build without
the I101 evaluator, discovery, describe, schema, example and validate work;
`run` fails with `evaluator_unavailable` (exit 3) instead of fabricating a
result.

**Live Scoreboard** returns the frozen `ScoreboardEvaluation` body:
`status` (`invalid`, `incomplete`, `complete`), `passed`, the exact
level/model/schema/content/pricing identity, seed, graph digest and
deterministic `runId`, issues, gates, whole/peak operation metrics, node/link
metrics, correctness, freshness, cost, one-second series and bounded traffic
frames. An invalid graph has `status: "invalid"`, `passed: false` and null
evidence. A cancelled or bounded run has `status: "incomplete"`,
`passed: false` and a non-empty `incompleteReasons`; it never passes. A
completed run with a failed required gate has `status: "complete"` and
`passed: false` (exit 2). `--compact-result` emphasizes gates, operations,
correctness, freshness and cost without hiding the status distinction.

## Graph documents

Parcel Pulse remains the default:

```json
{
  "schemaVersion": 1,
  "levelId": "parcel-pulse",
  "name": "My design",
  "nodes": [
    {
      "id": "client-1",
      "kind": "client",
      "label": "Client",
      "position": { "x": 0, "y": 160 },
      "config": { "size": "small" }
    }
  ],
  "edges": [
    {
      "id": "edge-traffic",
      "source": "client-1",
      "target": "app-1",
      "operation": "traffic"
    }
  ]
}
```

Cold Cache, Image Atlas and Live Scoreboard use their own versioned schemas.
`schema --kind graph` returns the exact JSON Schema generated from the same
parser used by the level. `levelId` is authoritative; a document for another
level is rejected.

## Parcel Pulse rules (unchanged)

- exactly one client and one app;
- client sends exactly one traffic edge to the app;
- the app has exactly one ingest, status, history and report route;
- ingest targets a durable SQL or KV primary;
- replication starts at the ingest primary, one hop, no cycles;
- status/history/report targets must be fed by ingest or replication;
- status targets are SQL or KV, not columnar;
- year 5 requires five years of raw history on the primary and history store;
- unused nodes are allowed but still charged.

`schema --kind graph` contains all numeric bounds and kind-specific fields. The
semantic digest ignores positions and labels; move/rename nodes freely, but
changing kind, config or routes makes a saved result stale. The graph document
is limited to 32 nodes and 64 edges.

## Parcel Pulse configuration and result checks (unchanged)

Common: `size` is `small | medium | large`. Storages have `storageTb` 1..256,
`retentionYears` 1..5, `partition` `none | month`, `compression` `none | lz4 |
zstd`. SQL has `index` `none | parcel | parcel-warehouse`. SQL/KV have
`latestStatus`. Stores have `rollups`. Columnar has `batchIntervalMs` 0..5000
and `columnProjection`.

All omitted optional fields are defaulted by the strict parser. Unknown fields,
prototype keys, duplicate ids and out-of-range numbers are rejected.

Check ids are stable. Required gates include
`availability:<operation>`, `p95:<operation>`, `freshness:status`,
`freshness:report`, `non_zero:<operation>`, `storage_capacity:<nodeId>`,
`retention`, `capacity`, `workload_complete`, `historical_cohort`,
`durable_ack`, `data_integrity`, `budget`, `horizons_complete`,
`horizon_pass:1` and `horizon_pass:5`.

Important semantics:

- **Availability** denominator is every offered request. Rejected, timed out,
  missing-data, stale and unfinished responses are failures.
- **Percentiles** use successful responses only.
- **Freshness** is measured against the contiguous replication watermark.
- **Deadlines** are separate from p95 targets; timed-out ingest still commits.
- **Memory** in the Parcel catalog is metadata only; RAM caching is not modeled.
- **TCO** uses 730 hours/month × 60 months plus provisioned storage.

## Image Atlas contract

Image graphs use the frozen `image-atlas` schema: fixed regional clients and
provider endpoints, player app/metadata/cache nodes, explicit traffic /
metadata / blob / replicate edges and a model version. The full rules and seven
mandatory cases are returned by `describe --level image-atlas` and in
`IMAGE_IMPLEMENTATION.md`. The CLI does not duplicate or weaken those rules.

## Live Scoreboard contract

The level studies one repeated answer: a top-20 leaderboard over 500,000
participants and 100 candidates. Two conceptual operations share the design:

- **View leaderboard** (`read`): offered at 10 rps for 0–20 s, 200 rps for
  20–60 s and 10 rps for 60–90 s. A successful answer is a consistent snapshot
  no more than 5,000 ms behind the committed votes.
- **Change vote** (`write`): 100 changes per second throughout the run. A
  change replaces the participant's current vote in one transaction; an
  acknowledged change must not be lost or counted twice.

The starter graph contains only the fixed **Users** node. The palette adds
**Application** (`instances` 1–4), **SQL Database** (`size`
`small|medium|large`, `readPlan` `scan|aggregate`) and optional **Cache**
(`ttlSeconds` 0.5/2/5/15). Allowed links are only Users → Application
(`traffic`), Application → SQL (`primary`, the shared write/direct-read path),
Application → Cache (`reads`) and Cache → SQL (`fill`). Missing, duplicate,
extra, self, ambiguous, disconnected or cyclic links are validation errors. The
cache is cold at traffic start; concurrent misses for the single key coalesce.

Passing requires, for both the whole 90 s and the peak 20–60 s offer cohorts:
per-operation availability ≥ 0.995 and successful-response p95 ≤ 250 ms, plus
correctness, freshness and bounded completion. Rejections, deadline timeouts
and errors stay in the availability denominator; percentiles use successful
responses only. A cheap design that fails any requirement is not a winner.
Among passing designs, lower `cost.scoreUsd` wins.

### Catalog and balance validation

`schema --level live-scoreboard --kind catalog` (or
`GET /v1/levels/live-scoreboard/components`) returns the compiled catalog:

- `components.sql.sizes.small|medium|large` — cores, RAM, disk, NIC and
  hourly USD: small $0.12/h, medium $0.40/h, large $1.28/h;
- `components.app.instances` with $0.06/h per instance;
- `components.cache` — exactly one 4 KiB entry, fixed-on coalescing, $0.06/h;
- `work` — per-row scan work, aggregate read/write work, application, cache
  and disk work coefficients;
- `network` — 20 ms client RTT, 1 ms internal propagation, lane width and
  response bytes;
- `billing` — only delivered client response bytes are billed.
- `rules`, `seeds` (calibration and holdout) and both measurement windows.

Prices, work coefficients, SLOs and gates come only from this compiled payload.
A graph cannot override them, and the API accepts no catalog, horizon,
scenario or threshold field. Use `parseScoreboardCatalog`,
`parseScoreboardLevel` and `parseScoreboardGraph` (browser/CLI) or the public
`/v1/levels` endpoints to validate documents before submitting.

### Three example families

Real shipped graphs (not mocks) are available through `example`:

```bash
npm run --silent agent -- example --level live-scoreboard --family family-fullscan
npm run --silent agent -- example --level live-scoreboard --family family-cache
npm run --silent agent -- example --level live-scoreboard --family family-aggregate
npm run --silent agent -- example --level live-scoreboard --family fail-small-scan
npm run --silent agent -- example --level live-scoreboard --family fail-stale-cache
```

- `family-fullscan` — Application + SQL small computing each leaderboard from
  raw votes; correct and passing, but expensive at peak.
- `family-cache` — Application + Cache (TTL 2 s) + SQL small; the shared answer
  is recomputed rarely and may be behind, within the freshness bound.
- `family-aggregate` — Application + SQL small with the transactional aggregate;
  reads visit 100 rows instead of 500,000, while each write does extra atomic
  work. It is expected to be the cheapest passing family.

`fail-small-scan` fails availability/latency because the small database queues
and times out; adding application instances does not remove that work.
`fail-stale-cache` fails freshness with TTL 15 s under continual writes. Invalid
graph fixtures are `invalid-missing-sql` and `invalid-ambiguous`.

The evaluator is deterministic for a given graph, seed and model identity.
Moving or renaming nodes does not change the digest; changing a kind, config or
link does. `runId` is derived from the versions, seed and digest and is suitable
for stale-result detection. Treat `identity`, `gates`, `operations`,
`correctness`, `freshness` and `cost` as the authoritative result; `series` and
`trafficFrames` are bounded presentation telemetry.

## Live Audience contract

The level studies one exact repeated answer: the **top 20 of 100 streams by
unique viewers active in the previous 15 minutes**. Users emit:

- **Record activity** (`ingest`): 2,000 events/s, each carrying a durable
  event id. Repeating the same id and payload returns the original commit with
  no second effect; a mismatched payload is a conflict with no effect.
- **View audience ranking** (`read`): 10 rps normally, 10 rps for 0–20 s,
  200 rps for 20–60 s and 10 rps for 60–90 s at peak. Ties rank by ascending
  stream id.

The starter graph contains only the fixed **Users** node. The palette adds
**Managed Load Balancer**, **Application** (`instances` 1–4), **SQL Database**
(`size` `small|medium|large`, `readPlan` `query|projection`), optional
**Cache** (`ttlSeconds` 0.5/2/5/15) and optional **Worker pool**
(`instances` 1–4). Allowed links are Users → Application or Users → Load
Balancer → Application, Application → SQL, Application → Cache → SQL and
Worker → SQL (one RPC dependency). Without the Load Balancer, a direct path
always targets physical Application slot 0; spare slots are never routed.

Qualification always includes `normal`, `peak` and one `peak + Application
instance failure` case for every provisioned slot (`0..instances-1`). The
failure crashes the process at measured 30 s for 15 s, then boots for 1 s and
becomes routable only after two successful probes. SQL, Cache, Worker, Load
Balancer, zone, broker and region failures are out of scope.

Passing requires, in the whole case and in the applicable critical offer cohort
(`[20,60)` s for peak, `[30,50)` s for fault cases), for both operations:

- availability `succeeded / offered` at least `0.995`, with rejections,
  deadline timeouts, errors and final unknown outcomes in the denominator;
- successful-response p95 at most `250 ms`, with at least 100 latency samples;
- every successful ranking checked for delivery age (≤5000 ms) and exact
  `(asOfMs − 15 min, asOfMs]` correctness against its named snapshot tuple;
- all acknowledged events preserved exactly once and a complete bounded drain.

Percentiles use successful responses only and every successful response is in
the latency cohort. The required gate set is frozen per case kind: 8 gates for
`normal` and 12 for `peak`/fault (whole and critical availability/p95 for both
operations, data preservation, ranking correctness, freshness, drain). A case
passes only when every required gate, correctness and freshness pass.

The selected Cache TTL is real retention. A cached response keeps its original
snapshot tuple; a TTL that serves a transport-successful answer older than
5000 ms fails freshness rather than being auto-refreshed or clamped. For a
projection, the last served response cursor may be smaller than the final
published prefix because workers can publish later jobs; it must be bounded by
the published prefix and the durable commit high-water mark.

The score is the actual `peak` case cost and is published only when every
required case passes. Fault-case costs are visible but never summed into the
score. A cheap design that fails any required case is not a winner.

### Catalog and fixtures

`schema --level live-audience --kind catalog` (or
`GET /v1/levels/live-audience/components`) returns the compiled catalog:

- `components.sql.sizes.small|medium|large` — cores, RAM, disk, NIC and hourly
  USD: small $0.12/h, medium $0.40/h, large $1.28/h;
- `components.app` — $0.06/h per instance, 1 core, 8 GB;
- `components.cache` — one 4096-byte entry, fixed-on coalescing, $0.06/h, TTL
  options 0.5/2/5/15 s;
- `components.worker` — $0.04/h per instance;
- `components.lb` — managed service, $0.04/h;
- `work` — scan, distinct, grouping/sort, projection, append, cache and client
  work coefficients;
- `storage` — raw event, index, pair, outbox and cache bytes;
- `network` and `billing` — 20 ms client RTT, 1 ms internal hop, 1 Gbit/s lane,
  response bytes and the $0.02/GB client-response charge;
- `policies` — fixed health, retry, queue, projection, cache, routing,
  idempotency, scheduler-tie and crash-connection rules;
- `seeds` — default, five calibration and two holdout seeds;
- `challenges` and `maxInstancesChallengeProfile` — required kinds/cases and
  the maximum-pool case shape.

Real shipped graphs are available through `example`:

```bash
npm run --silent agent -- example --level live-audience --family family-query-large
npm run --silent agent -- example --level live-audience --family family-cache-query
npm run --silent agent -- example --level live-audience --family family-projection
npm run --silent agent -- example --level live-audience --family fail-single-app
npm run --silent agent -- example --level live-audience --family fail-direct-no-lb
npm run --silent agent -- example --level live-audience --family fail-small-query
npm run --silent agent -- example --level live-audience --family fail-stale-ttl
```

Passing/failing labels are calibration candidates. Invalid fixtures cover a
projection without a Worker, cross-level config, unknown config, both routes,
cycles, duplicate pools, dangling links and ambiguous links. The CLI never
duplicates or weakens the core's rules.

`--compact-result` for Live Audience shows status, identity, provisioned
components, score, per-case target lifecycle, failed required gates, operation
success counts, correctness/freshness evidence and cost without hiding the
difference between an invalid graph, an incomplete run and an ordinary failed
case.

Live Audience evaluation is available through the same registry as the browser
and API.

## Configuration

There are no secrets, file imports other than the selected graph document, or
environment-dependent model switches. The CLI never reads a level definition or
catalog from user input.
