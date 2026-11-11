# Backend API

Node.js 24 + TypeScript + Fastify HTTP API for local agent evaluations of all
five levels: **Cold Cache**, **Parcel Pulse**, **Image Atlas**, **Live
Scoreboard** and **Live Audience**. The backend is its own project with its own
dependency lockfile. The HTTP/job contract lives in `src/contracts.ts`; the real
engine adapter and runnable entry point live in `src/engine/**` and
`src/main.ts`.

## Run

From the repository root:

```sh
npm ci
npm --prefix backend ci
npm --prefix backend run dev
```

Production:

```sh
npm --prefix backend run build
npm --prefix backend start
```

The server binds `127.0.0.1:8080` by default. `HOST` and `PORT` may be set
explicitly. `PORT=0` selects an ephemeral port and prints the actual address.
The API has no authentication, so non-loopback binding is an explicit operator
choice.

```sh
npm --prefix backend run typecheck
npm --prefix backend test
```

## Engine

`src/engine/worker-engine.ts` implements the frozen `Engine` interface and
dispatches through the shared registry in `src/simulation/registry.ts`:

- Discovery, describe, components, graph schemas and result schemas come
  directly from the frozen level cores. The backend has no duplicate tuning
  constants.
- Cold Cache finalises the real `createSimulation` engine into an explicit
  envelope; its `result` body is the untouched `RunResult`. The adapter always
  binds `DEFAULT_LEVEL`, so a caller cannot supply a workload or catalog.
- Parcel Pulse keeps its frozen evaluator and result body, including both
  mandatory horizons and the strict mandatory-gate/semantic-digest checks.
- Image Atlas imports the I101 evaluator through the registry. Until that
  evaluator is present, the level remains discoverable/validatable but an
  evaluation fails safely with `evaluator_unavailable`; no result is fabricated.
  The components route forwards `IMAGE_WORK_MODEL` when I101 exports it.
- Live Audience imports its real evaluator directly through the registry.
  Discovery, describe, schemas, example, validation and evaluation all come
  from the core. Components expose the full compiled catalog, work
  coefficients, storage/network/billing, fixed policies, challenge metadata and
  seeds.
- Live Audience results are deep-bound to the submitted graph: exact
  level/model/content/pricing/profile/seed/digest identity, the required
  `normal`/`peak`/per-slot failure case set, physical fault targets, the full
  frozen gate set, recomputed availability/percentiles, freshness/snapshot
  audits, expiry boundaries, logical unknown-commit counters, cost arithmetic
  and peak-only score eligibility. A worker result for another graph, seed or
  case set is rejected instead of completing the job.
- Every `evaluate` call runs in a dedicated Worker Thread, bounded by the job
  queue's concurrency. The four existing levels keep V8 limits of a 512 MiB old
  generation, 64 MiB young generation and 4 MiB stack. Live Audience uses a
  stricter 192 MiB old generation, 16 MiB young generation and 4 MiB stack;
  the cap cannot be raised by configuration, while smaller operator-provided
  values are preserved. These are Node Worker Thread limits and do not bound
  browser memory.
- Abort, timeout, crash, invalid worker messages and process shutdown terminate
  the worker and settle the promise exactly once with a safe error. A cancelled
  worker keeps its concurrency slot until the thread actually exits.
- Worker results are validated by registered level, never by caller claim: Cold
  envelope/check binding, all frozen Parcel gates and Image's full Zod contract
  plus exact seed/model/content/pricing/digest binding, required cases and a
  passing guard that compares actual availability/p99.9, sample counts,
  freshness, integrity, publication and incident/recovery windows against the
  frozen `IMAGE_LEVEL` values. Image freshness probes are consistency evidence,
  not a 100% business-request success requirement.
- Source runs use the TypeScript worker through `tsx`; production builds bundle
  `dist/main.js` and `dist/engine/worker.js` with esbuild.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Readiness probe |
| GET | `/v1/levels` | Discover all five levels |
| GET | `/v1/levels/{id}` | Level description, SLOs and rules |
| GET | `/v1/levels/{id}/components` | Catalog, defaults and limits |
| GET | `/v1/levels/{id}/schema` | Graph JSON Schema |
| POST | `/v1/evaluations` | Submit `{levelId, graph, seed?}`; returns 202 + `Location` |
| GET | `/v1/evaluations/{id}` | Job status, safe error, or completed result |
| DELETE | `/v1/evaluations/{id}` | Cancel an active job; terminal jobs are unchanged |

`seed` defaults to `101` and must be an integer in `0..2147483647`. Request
bodies are limited to 1 MiB. Unknown top-level fields, bad types, malformed or
trailing JSON, and unsupported content types are rejected. The caller cannot
choose horizons or scenarios, patch level/catalog/SLO rules, or replace the
Cold Cache level definition; Parcel and Image always run their full mandatory
sets.

Errors use a stable envelope:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Request validation failed.",
    "details": [{ "path": "/seed", "message": "must be integer" }]
  }
}
```

## Jobs

Statuses are `queued`, `running`, `completed`, `failed` and `cancelled`.
`completed` means the evaluator returned a result, including `passed: false`
and structured invalid/incomplete results. `failed` is reserved for
infrastructure, engine and timeout failures, and carries only a safe
`{code, message}`. Cancelling a queued or running job aborts its signal and
terminates its worker; a late result cannot overwrite `cancelled`.

Defaults: one concurrent worker (contract maximum two), 16 queued jobs, 256
retained jobs, one-hour terminal TTL, 60-second run timeout and a 5-second
graceful-close drain. Jobs are in memory and are lost on restart. Full agent
usage examples are in `docs/api.md`.
