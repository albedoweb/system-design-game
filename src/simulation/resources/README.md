# Reusable resource kernel

Pure TypeScript discrete-event resources for simulation evaluators. This
directory is independent of the Image Atlas evaluator and of the existing
Cold Cache / Parcel Pulse engines. It owns no catalogue values, UI state or
backend traffic.

## Public API

Everything below is exported from `src/simulation/resources/index.ts`.

### EventScheduler

```ts
const scheduler = new EventScheduler();
scheduler.nowMs;            // logical clock, starts at 0
scheduler.processedEvents;  // callbacks invoked
scheduler.exhausted;        // last run stopped on its event budget
scheduler.pendingEvents;

scheduler.schedule(atMs, callback, priority?); // returns ScheduledHandle
scheduler.runUntil(untilMs, maxEvents?);        // returns SchedulerRunResult
```

- Same-time order is lower priority first, then insertion order. The kernel
  uses priority 0 for completion and priority 1 for deadlines.
- An event earlier than `nowMs`, or a non-finite time, throws. Scheduling at
  the current time is allowed and runs after already-queued same-time events.
- `ScheduledHandle.cancel()` removes the event eagerly and returns false when
  it already ran or was already cancelled. Stale callbacks are never invoked.
- `runUntil` advances the clock to `untilMs` after the due queue drains. When
  `maxEvents` is hit, the clock stays at the last processed timestamp, the
  remaining due events stay queued, and `exhausted` is true. Work is never
  silently dropped.
- There is no wall clock, DOM, timer, random source or callback serialization.

### ResourceKernel

```ts
const kernel = new ResourceKernel(scheduler, {
  windowStartMs: 0,
  windowEndMs: 60_000,
  maxQueuedTasks: 10_000, // default
});

kernel.registerResource({ id: 'vCPU', capacity: 8, kind: 'cpu' });
kernel.setAvailable('vCPU', false);
kernel.setAvailable('vCPU', true);

const handle = kernel.submit({
  id: 'request-1',
  resources: [{ id: 'vCPU', units: 1 }],
  durationMs: 250,
  deadlineMs: 1000, // relative to enqueue, not absolute
  onFinish(result) {
    // status: completed | timeout | interrupted | rejected
    // result.enqueuedAtMs / startedAtMs / endedAtMs
    // result.workFraction: 0..1
  },
});

handle.cancel();       // queued or active
kernel.cancelTask(id); // same by id
kernel.stats();
```

A submission may also pass an optional `onStart(startedAtMs)` observer; it is
called once on the real queued→active transition and never for rejected or
queued-terminal tasks (see the lifecycle bullet below).

Capacity units are caller-chosen positive finite numbers: cores, IO lanes,
1 Gbit/s network lanes, bytes, etc. Fractional capacities and units are
supported and conserved with a small numeric tolerance. A task whose units
exceed the resource's nominal capacity is rejected, never queued forever.

Semantics:

- A task acquires **all** its resources in one synchronous step or waits. It
  never holds a subset, so the kernel cannot deadlock on partial acquisition.
- Each physical resource has one FIFO waiter list. A task starts only when it
  is the head waiter on every resource it needs and all units fit. This makes
  the order deterministic and starvation-free. The documented cost is
  head-of-line blocking (a large head request can leave later smaller requests
  waiting) and possible capacity fragmentation. Tasks on unrelated resources
  overlap because their waiter lists are independent.
- Duplicate live task ids, duplicate resource ids inside one request, unknown
  resources, invalid units, over-capacity demand and a full bounded queue are
  rejected through the callback exactly once with status `rejected`. Rejected
  submissions never enter the queue. Structural misuse (empty id, invalid
  duration or deadline, missing callback) throws.
- A live task reports exactly one terminal result. Queued or active
  cancellation reports `interrupted` / `cancelled`; an outage reports
  `interrupted` / `resource-unavailable`; an expired deadline reports
  `timeout` / `deadline-exceeded`.
- A queued timeout has `startedAtMs: null` and zero work. An active timeout,
  cancellation or fault reports the fraction already served.
- If completion and deadline land on exactly the same timestamp, completion
  wins because of event priority.
- `setAvailable(id, false)` sets usable capacity to zero and interrupts only
  the active tasks that hold that resource; each interrupted task releases all
  of its allocations. Queued tasks remain queued until a deadline or until the
  resource returns. `setAvailable(id, true)` restores nominal capacity and
  resumes queued work. Interrupted work is not silently restarted.
- Stale completion events are cancelled eagerly and a finalisation guard makes
  double release impossible.
- Finished tasks are removed from the kernel maps and waiter lists. Task ids
  may be reused after a task has finished; callers should still use unique ids
  for traceability.
- Resource statistics expose nominal and available capacity, current/peak
  busy units, the busy-unit integral over the observation window and its
  average. Post-window drain is excluded from the average. Aggregate counters
  expose completed, timed out, interrupted, cancelled, outage-interrupted,
  rejected, queue-wait and queue-depth values.
- `submit({ ..., onStart })` is an optional observational lifecycle hook. It
  fires exactly once when the task really transitions queued→active, after its
  allocations, waiter removal and completion event are consistent; it never
  fires for a rejected submission or for a task that is cancelled/times out
  while queued. Public mutators (`submit`, `cancelTask`, `setAvailable`,
  `registerResource`) throw before applying any effect while an observer is
  running, and observer exceptions are swallowed, so observation cannot change
  events, ordering, RNG or budgets. Callers that need a per-node queue-depth
  integral should count distinct tasks (one task can hold CPU, IO and several
  network lanes) rather than summing resource wait counts.

Deadline `deadlineMs` is measured from the submit/enqueue time. Resource
stages are caller-owned: a CPU stage, IO stage and network stage should be
submitted as separate tasks linked by the caller's causal logic; the kernel
does not assign them one shared duration.

### MemoryLedger

```ts
const ledger = new MemoryLedger(limitBytes);
ledger.reserve(id, bytes); // false for duplicate id or overflow
ledger.release(id);        // true once, false when missing
ledger.usedBytes;
ledger.peakBytes;
```

Reservation is all-or-nothing and never exceeds the limit. Duplicate ids and
missing releases change nothing. The evaluator should use a separate ledger per
physical instance for queued plus active buffer ownership.

### ByteLruCache

```ts
const cache = new ByteLruCache<Metadata>(capacityBytes);
cache.get(key);              // touches LRU, counts hit/miss
cache.peek(key);             // no touch, no counters
cache.put(key, sizeBytes, value); // adjusts replacement bytes
cache.delete(key);
cache.clear();
cache.usedBytes;
cache.hits; cache.misses; cache.evictions;
```

An entry larger than the cache never fits and leaves any existing key
unchanged. Replacement adjusts `usedBytes` without counting an eviction.
Least-recently-used entries are evicted until the new entry fits. Zero-byte
entries are accepted. Keys are caller-owned; the Image Atlas evaluator uses
object key plus variant. No hit rate is invented.

### Network adapter

```ts
const demand = buildNetworkTransferDemand({
  bytes: 4_000_000,
  sourceNicId: 'app-1-nic',
  destinationNicId: 'blob-1-nic',
  linkIds: ['na-eu-100g'],
  accessIds: ['request-1-access'], // one shared 1 Gbit/s lane for fan-out
  propagationMs: 40,               // after serialization, holds no lanes
});

kernel.submit({
  id: 'transfer-1',
  resources: demand.resources,
  durationMs: demand.serviceDurationMs,
  onFinish: (result) => {
    const bytes = accountTransferBytes(demand.bytes, result.workFraction);
  },
});
```

`networkLanesForBandwidth()` maps explicit bandwidth to lanes: 1 Gbit/s = 1,
10 Gbit/s = 10, 100 Gbit/s = 100. Each flow reserves one lane on every unique
physical resource on its explicit path. A 10 Gbit/s NIC therefore serves 10
concurrent lanes, a regional 100 Gbit/s link serves 100, and one end-user
access link serves one transfer at a time even when ten children fan out.
Propagation is returned separately and never consumes bandwidth.

This is conservative fixed-quantum flow reservation, not TCP congestion
control and not ideal fair sharing. It deliberately does not embed Image Atlas
catalogues; callers register the physical resources and choose ids. A repeated
physical id on one path is normalized to one lane, so duplicate logical edges
cannot multiply capacity. Full-duplex directions should use distinct ids when
both can be active simultaneously.
