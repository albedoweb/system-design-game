# Acceptance test

`npm run acceptance` is the minimal executable acceptance for the five-level
game. It builds the production frontend and backend, starts isolated local
servers, runs deterministic public-interface checks, submits real API jobs, and
runs the production browser suite in headless Chromium.

The command exits with `0` only when every section passes. Missing levels,
fixtures or services are reported as failures; nothing is skipped to make the
run green.

Before building anything it runs the focused runner tests in
`tests/acceptance/runner.test.mjs` with Node's built-in test runner. Those tests
cover graph-schema envelope validation, rejection-vs-ordinary-failure
classification, artifact-path containment and process-group cleanup. A runner
self-test failure aborts acceptance.

## Prerequisites

From the repository root:

```sh
npm ci
npm --prefix backend ci
npx playwright install chromium
```

Node 24 from `.node-version` is required. The test owns ports `5190` (frontend
preview) and `8091` (API). Override with `ACCEPTANCE_FE_PORT` /
`ACCEPTANCE_API_PORT` if needed; the user-facing preview ports and API `8080`
are not used.

## Run

```sh
npm run acceptance
```

The command first runs the focused runner self-tests. Then it:

1. removes the previous frontend build, builds the frontend and backend;
2. starts the production API and frontend preview on test ports;
3. runs public CLI checks with fixed seed `101`:
   - `levels` lists `cold-cache`, `parcel-pulse`, `image-atlas`,
     `live-scoreboard` and `live-audience`;
   - `schema --level <id>` returns a graph schema for each level, and the
     Live Scoreboard and Live Audience catalogs expose their compiled
     pricing/work/billing/profile/policy values;
   - one pass and one deliberate-fail witness for Cold Cache, Parcel Pulse,
     Live Scoreboard and Live Audience;
   - Image Atlas capacity-failure witness (its full pass witness runs through
     the production browser Worker, so the heavy qualification is not repeated);
   - invalid level and invalid graph are rejected;
4. checks the API: health, five-level discovery, each graph schema, the
   Live Scoreboard and Live Audience catalogs, one real Parcel evaluation job
   with expected pass metadata, real Live Scoreboard pass and deliberate-fail
   jobs, real Live Audience passing-family and `fail-single-app` ordinary-fail
   jobs with full qualification evidence, exact equality between the CLI and
   API engine result for `live-scoreboard` and `live-audience` seed `101`, a
   cross-level submission rejected by HTTP 422 or an explicit level-mismatch
   invalid result (a generic `passed:false` is not accepted), unknown-level and
   unknown-route rejection;
5. runs the production browser suite: level navigation, one real pass run per
   level (including a full Image Atlas qualification and the Scoreboard UI
   scenarios owned by the UI task), Export → Reset → Import, refresh to the
   starter/default seed, two-tab isolation, cross-level and malformed import
   rejection, and Stop → Reset stale-completion guarding.

## Artifacts

Machine-readable results are written below `test-results/acceptance/`:

- `report.json` — command, SHA, timings, every check and the final verdict;
- `playwright-report.json` — Playwright results;
- `playwright/` — traces and failure screenshots on failure;
- `logs/frontend.log`, `logs/api.log` — server output;
- `image-atlas-result.png` — successful Image Atlas browser result for visual review.

`test-results/` is ignored by Git. `ACCEPTANCE_ARTIFACT_DIR` may select a
subdirectory below `test-results/acceptance/`, but absolute paths, `..`
traversal and sibling names that would escape that root are rejected before any
file is created or removed. The default location is always
`test-results/acceptance/`.

The command cleans up its frontend and API processes on success, failure and
interruption. Builds, CLI calls and Playwright run asynchronously as owned
process groups with bounded timeouts; SIGINT/SIGTERM or a timeout terminates
the group, waits briefly, force-kills anything still alive, and then stops the
servers.

## Selector and interface contract

The browser suite consumes public accessible names only:

- level title as a level-1 heading;
- level links whose accessible name contains the level title;
- `Seed` label for the seed input;
- `Run` or `Run evaluation` for starting, `Stop` for stopping;
- `Reset`, then `Reset graph` in the confirmation dialog;
- `Export` and the `Open saved graph file` file input;
- `Level passed` and `Run result` status text;
- React Flow node test ids of the form `rf__node-<graph-node-id>`.

It does not inject private stores or depend on React internals.

## CI

CI runs the same `npm run acceptance` command after installing Chromium. On
failure it uploads `test-results/acceptance/`, which includes the Playwright
report, trace and screenshots. The suite has no retries and does not mask flaky
product behaviour.
