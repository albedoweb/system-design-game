# Agent API — Cold Cache, Parcel Pulse, Image Atlas, Live Scoreboard and Live Audience (local practice)

The backend is a local Node.js 24 + TypeScript + Fastify service for running
graphs through the same deterministic evaluators used by the browser game and
the CLI. It is a **practice API**: results are computed by the server and
returned immediately. There are no accounts, tournament identities, seed
escrow, attempt budgets or leaderboard yet.

## Versions and levels

Discovery lists all five registered levels. Every level exposes its own exact
model/content/pricing identity; results are never compared across models.

| Level | model | content | pricing | graph |
| --- | --- | --- | --- | --- |
| `cold-cache` | `1.0.0` | `1.0.0` | `catalog-v1` | schema `1` |
| `parcel-pulse` | `1.0.0` | `1.0.0` | `parcel-catalog-v1` | schema `1` |
| `image-atlas` | `1.0.0` | `1.0.0` | `image-atlas-catalog-v1` | schema `1` |
| `live-scoreboard` | `1.0.0` | `1.0.0` | `scoreboard-catalog-v1` | schema `1` |
| `live-audience` | `1.0.0` | `1.0.0` | `audience-catalog-v1` | schema `1` |

`live-audience` also binds challenge profile `app-resilience-v1`.

`GET /v1/levels` returns the stable summary fields `id`, `title`,
`description`, `defaultSeed` and `horizons` (Parcel `[1,5]`, otherwise `[]`).
The full level payload from `GET /v1/levels/{id}` carries the model identity,
rules, mandatory Image scenarios and catalog. `GET /v1/levels/image-atlas/components` also forwards the public
`IMAGE_WORK_MODEL` object when the integrated evaluator exports it, so agents
can explain per-operation work without guessing coefficients.
`GET /v1/levels/live-scoreboard/components` returns the compiled Scoreboard
catalog (`catalog`), operation labels/windows, node kinds, seeds and rules; the
nested catalog contains all prices and work coefficients. A graph or request
cannot override them. `GET /v1/levels/live-audience/components` returns the
compiled Audience catalog (prices, work coefficients, storage, network,
billing and every fixed health/retry/queue/projection/cache/routing/idempotency
policy), challenge metadata, calibration/holdout seeds and the maximum-pool
challenge profile. While the I101 Image evaluator is absent, the level is
contract-only: it can be discovered, described and validated, but an evaluation
fails safely instead of returning a fabricated result. Live Scoreboard and Live
Audience are playable and evaluate through the same registry and Worker Thread
as the browser/CLI.

The same seed, graph and core version produce the same result JSON. Moving or
renaming a node does not change the graph digest; changing a kind, config or
route does. The seed is part of the explicit save envelope and is checked
separately from the digest.

The browser's Export file is not an API request body. It is a versioned
`sdg-level-state` envelope; take its `graph` field and `seed` when submitting to
`POST /v1/evaluations`. The graph schema itself is unchanged.

## Setup and run

From the repository root:

```sh
npm ci
npm --prefix backend ci
```

Development server (TypeScript sources, Worker Thread per evaluation):

```sh
npm --prefix backend run dev
```

Production build and start:

```sh
npm --prefix backend run build
npm --prefix backend start
```

Type-check and tests:

```sh
npm --prefix backend run typecheck
npm --prefix backend test
```

The server binds `127.0.0.1:8080` by default. Set `HOST` and `PORT` explicitly
to change it; the API has no authentication, so non-loopback binding is a
deliberate operator choice. `PORT=0` asks the operating system for an ephemeral
port and prints the actual address on startup. `LOG_LEVEL` accepts
`fatal|error|warn|info|debug|trace|silent`.

Each evaluation runs in a dedicated Worker Thread and dispatches through the
shared five-level registry. The default process budget is one concurrent
evaluation (the HTTP contract allows up to two), a 16-job queue, a 256-job
in-memory registry, a 60-second run timeout and a 1 MiB request body. New work
is rejected with `429` when a bound is reached; active jobs are never silently
evicted. A cancelled worker keeps its concurrency slot until the thread has
actually exited.

**Jobs are in memory and are lost on restart.** Terminal jobs are retained for
one hour by default. The service is intended for local practice and does not
publish, host publicly or rank agents.

## HTTP routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | `200 {status:"ok",ready:true}` or `503` |
| GET | `/v1/levels` | Level summaries (all five) |
| GET | `/v1/levels/{id}` | Level, SLOs, assumptions, rules |
| GET | `/v1/levels/{id}/components` | Catalog, defaults, limits, operations |
| GET | `/v1/levels/{id}/schema` | JSON Schema for graph documents |
| POST | `/v1/evaluations` | Submit `{levelId, graph, seed?}`; `202` + `Location` |
| GET | `/v1/evaluations/{id}` | Job snapshot, error or completed result |
| DELETE | `/v1/evaluations/{id}` | Cancel queued/running work |

## Typical agent loop

```sh
BASE=http://127.0.0.1:8080

curl -s "$BASE/healthz"
curl -s "$BASE/v1/levels"
for level in cold-cache parcel-pulse image-atlas live-scoreboard; do
  curl -s "$BASE/v1/levels/$level"
  curl -s "$BASE/v1/levels/$level/components"
  curl -s "$BASE/v1/levels/$level/schema"
done
```

Submit a graph. The graph must be a JSON object accepted by the level schema;
top-level fields other than `levelId`, `graph` and `seed` are rejected. The
caller cannot choose horizons or scenarios, patch catalog prices, change SLOs,
select evaluation rules or replace the Cold Cache level definition. Parcel
always evaluates both mandatory horizons; Image always requests all seven
mandatory cases; Live Scoreboard accepts neither `horizonYears` nor `scenarios`
and always runs its whole-and-peak gate set.

```sh
GRAPH=$(cat fixtures/parcel/starter.json)
curl -s -X POST "$BASE/v1/evaluations" \
  -H 'content-type: application/json' \
  --data "{\"levelId\":\"parcel-pulse\",\"graph\":$GRAPH,\"seed\":101}"
```

The response is `202` with a job snapshot and `Location` header:

```json
{
  "id": "0b3f8d8a-...",
  "levelId": "parcel-pulse",
  "seed": 101,
  "status": "queued",
  "createdAt": "2026-10-31T03:20:04.724Z",
  "startedAt": null,
  "finishedAt": null,
  "error": null,
  "result": null,
  "links": { "self": "/v1/evaluations/0b3f8d8a-..." }
}
```

Poll the job until it leaves `queued`/`running`:

```sh
JOB=0b3f8d8a-...
curl -s "$BASE/v1/evaluations/$JOB"
```

A simulation failure is still a **completed** job. Inspect `result.status`,
`result.passed`, the failing checks, diagnostics, per-operation SLO metrics and
capacity/cost.

## Result shapes

### Parcel Pulse (unchanged)

```js
const job = await (await fetch(`${BASE}/v1/evaluations/${id}`)).json();
if (job.status === 'completed') {
  const result = job.result;
  console.log(result.status, result.passed);
  console.log(result.meta.requestedHorizons); // [1, 5]
  for (const horizon of result.horizons) {
    for (const check of horizon.checks.filter((c) => !c.passed)) {
      console.log(horizon.horizonYears, check.id, check.actual, check.limit);
    }
  }
  console.log(result.cost.monthlyUsd, result.cost.fiveYearTcoUsd);
}
```

`result.status` is `ok`, `invalid` or `error`. A completed `ok` body keeps the
frozen mandatory gates and semantic-digest binding; `passed: true` requires the
full check set for both horizons.

### Cold Cache envelope

The API returns an explicit envelope whose `result` field is the untouched
`RunResult` from the frozen engine:

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

`status: "invalid"` means parsing or semantic validation blocked the run;
`status: "incomplete"` means a bounded runtime limit and can never pass. A
successful `ok` result must carry a non-null semantic digest and exactly the
nine frozen gates with their expected targets/units; each gate's pass bit must
agree with its evidence and with the returned cost/snapshot summary. A forged
`{passed:true}` with missing, duplicated, unknown or self-contradictory checks
is rejected.

### Image Atlas

The API returns the frozen `ImageEvaluation` body. `meta` binds the level,
model/content/pricing versions, seed and semantic digest. Qualification is
always the full seven-case set (`requestedScenarios` must cover every required
case).

For `passed: true` the backend revalidates the actual evidence against the
frozen `IMAGE_LEVEL` SLO/workload values rather than trusting the result flags:
each required case must meet its normal or incident availability and p99.9
bounds, provide at least the minimum p99.9 sample count and `sampleFactor: 1`,
carry passing `availability:<operation>` and `p999:<operation>` required checks,
have non-vacuous freshness evidence within the frozen limit, zero data-integrity
violations and publication of every committed upload within the frozen bound.
Incident and recovery windows must be internally consistent with their actual
availability/latency values. Non-passing completed results keep the cheaper
contract/binding checks only. A scenario subset is exploratory and can never
pass.

Freshness evidence is consistency evidence, not a 100% business-request success
requirement: a timed-out recent read during an outage counts against business
availability and is not by itself a freshness violation when no successful
stale/incorrect response was returned and every committed record publishes
within 120 s.

Until the I101 evaluator is wired into the shared registry, the level is
`contract-only` and evaluation jobs fail with a safe `evaluator_unavailable`
error.

### Live Scoreboard

The API returns the frozen `ScoreboardEvaluation`. Top-level `levelId`,
`modelVersion`, `schemaVersion`, `contentVersion`, `pricingVersion`, `seed`,
`graphDigest` and `runId` must equal the nested `identity`; a completed result
also binds all of them to the submission. `status` is `invalid`, `incomplete`
or `complete`; only `complete` may pass.

```js
const job = await (await fetch(`${BASE}/v1/evaluations/${id}`)).json();
if (job.status === 'completed') {
  const result = job.result;
  console.log(result.status, result.passed, result.cost?.scoreUsd);
  for (const gate of result.gates.filter((g) => !g.passed)) {
    console.log(gate.id, gate.actual, gate.limit, gate.unit);
  }
  console.log(result.operations?.read.availability, result.operations?.peak.read.latency.p95Ms);
  console.log(result.correctness, result.freshness);
}
```

The worker boundary is strict. The server validates the result with the public
`parseScoreboardEvaluation` plus semantic checks, and rejects a malformed or
forged worker message instead of completing the job. Checked invariants include
exact identity binding (level, model/content/pricing/schema versions, seed and
semantic graph digest), `passed` agreement with all required gates and
correctness/freshness, request conservation
(`offered = succeeded + failed`, `failed = rejected + timedOut + errored`,
complete runs have no pending requests), availability equal to
`succeeded / offered`, p95 gate flags derived from sample sufficiency and the
reported latency, whole/peak cohort containment, freshness flags versus stale
reads, cross-candidate vote totals, node average-versus-peak resources,
link request/byte conservation and cost arithmetic (line rental, billed
preparation/measured/drain time, bytes and `scoreUsd`). Values such as `NaN`,
negative counts, an average above its peak or an inconsistent cost are rejected.
The validator does not re-run the simulation and cannot change the result.
Invalid graphs produce `status: "invalid"`; cancelled runs produce
`status: "incomplete"` with a reason; neither can pass. The API never creates an
evaluation in the browser/UI from a submitted result.

### Live Audience

The API returns the frozen `AudienceEvaluation`. Top-level `levelId`,
`modelVersion`, `schemaVersion`, `contentVersion`, `pricingVersion`,
`profileVersion`, `seed`, `graphDigest` and `runId` must equal the nested
`identity`. A completed result also binds all of them to the submitted graph
and seed. `status` is `invalid`, `cancelled`, `incomplete` or `complete`; only
`complete` may pass.

Qualification is fixed by the graph's provisioned Application instances. Every
run always evaluates `normal`, `peak` and one `peak + Application instance
failure` case for each physical slot `0..instances-1` (maximum six cases).
There is no API field to omit a case, choose a scenario or retarget a fault.
The caller cannot change the workload, prices, SLOs, cache retention policy or
fault schedule.

A minimal valid graph uses the managed Load Balancer, one Application pool and
one primary SQL Database:

```json
{
  "schemaVersion": 1,
  "levelId": "live-audience",
  "nodes": [
    { "id": "users", "kind": "users", "label": "Users", "position": { "x": 80, "y": 180 }, "config": {} },
    { "id": "lb", "kind": "lb", "label": "Managed Load Balancer", "position": { "x": 460, "y": 180 }, "config": {} },
    { "id": "app", "kind": "app", "label": "Application", "position": { "x": 840, "y": 180 }, "config": { "instances": 2 } },
    { "id": "sql", "kind": "sql", "label": "SQL Database", "position": { "x": 1220, "y": 180 }, "config": { "size": "large", "readPlan": "query" } }
  ],
  "edges": [
    { "id": "e-users-lb", "from": "users", "to": "lb" },
    { "id": "e-lb-app", "from": "lb", "to": "app" },
    { "id": "e-app-sql", "from": "app", "to": "sql" }
  ]
}
```

Optional components are one Cache (`ttlSeconds` 0.5, 2, 5 or 15) and one
Worker pool (`instances` 1–4). `readPlan` is `query` or `projection`; a
projection requires a Worker connected to SQL. A direct `Users → Application`
path is legal but always targets physical slot 0, so spare instances are not
routed without the Load Balancer.

```js
const job = await (await fetch(`${BASE}/v1/evaluations/${id}`)).json();
if (job.status === 'completed') {
  const result = job.result;
  console.log(result.status, result.passed, result.score.costUsd);
  for (const item of result.cases) {
    for (const gate of item.gates.filter((g) => g.severity === 'required' && !g.passed)) {
      console.log(item.id, gate.id, gate.actual, gate.limit, gate.unit);
    }
  }
}
```

For each case, the required gate set is fixed by the case kind (8 gates for
`normal`, 12 for `peak` and fault cases). It covers availability and
successful-response p95 for both operations in the whole case and, for peak and
fault cases, the critical offer cohort, plus data preservation, ranking
correctness, freshness and bounded completion. Availability is
`succeeded / offered`; rejected, timed-out, errored and unknown-outcome
requests remain failures. Percentiles use successful responses only and need at
least 100 samples. A case passes only when every required gate, correctness and
freshness pass together.

The score is the actual `peak` case cost and exists only when every required
case passes. Costs of fault cases are shown per case but are never summed into
the score. `score.costUsd` is `null` when the run is ineligible.

Fault scope is exactly one Application process crash at measured 30 s for 15 s,
then a 1 s boot and readiness only after two successful health probes. SQL,
Cache, Worker, Load Balancer, zone, broker and region failures are out of
scope. Durable SQL commits and projection/outbox rows survive; volatile
Application memory, queued work and active work do not. A direct path may
report no LB detection or route restoration; a complete failed result can still
be ordinary evidence.

Freshness is audited at delivery against the response's original snapshot
tuple `{ asOfMs, throughCommitSequence }`. Every successful ranking is checked
for exactness. The selected Cache TTL is real retention, not silently clamped:
a long TTL can serve a transport-successful answer older than 5000 ms, and that
case fails freshness. For a projection, the last successful response cursor may
be smaller than the end-of-case published prefix because workers can publish
more jobs later; it must never exceed the published prefix or the durable commit
high-water mark.

Limits: 6 nodes, 8 edges, at most 4 Application instances and 4 Worker
instances, one Users node, one Application pool, one primary SQL Database, at
most one Load Balancer, one Cache and one Worker pool. The prepared graph is
bounded to 1 MiB by the HTTP body limit.

Live Audience evaluates through the same registry and Worker Thread as the
browser and CLI. Qualification is deterministic for a given graph, seed and
core version.

## Determinism and comparisons

Run the same graph and seed twice; the completed result JSON is identical:

```sh
for seed in 101 101 202; do
  curl -s -X POST "$BASE/v1/evaluations" \
    -H 'content-type: application/json' \
    --data "{\"levelId\":\"parcel-pulse\",\"graph\":$GRAPH,\"seed\":$seed}"
done
```

Compare candidates using required checks first, then the level's own cost
metric for graphs that pass. Per-operation metrics separate average and peak
load; latency percentiles include successful responses only. Availability
includes rejected, timed-out, stale and missing responses as failures.

## Errors

All errors use one envelope:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Request validation failed.",
    "details": [{ "path": "/seed", "message": "must be integer" }]
  }
}
```

Common codes: `invalid_request` (400), `invalid_json` (400), `level_not_found`
(404), `job_not_found` (404), `payload_too_large` (413),
`unsupported_media_type` (415), `graph_invalid` (422), `job_queue_full` (429),
`job_registry_full` (429), `evaluation_timeout` (failed job),
`engine_failure` (failed job), `evaluator_unavailable` (failed job while Image
is contract-only) and `service_unavailable` (503).

## Not implemented

Official competitions will pin server-side seeds, rules, model/pricing
versions and attempt budgets, and may add durable storage and identities. This
release does not include authentication, public hosting, tournament
leaderboards or cross-restart job recovery.
