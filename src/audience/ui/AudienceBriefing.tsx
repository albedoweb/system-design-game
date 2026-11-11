import {
  AUDIENCE_ACTIVITY_WINDOW_MS,
  AUDIENCE_CATALOG,
  AUDIENCE_FAULT_CRITICAL_WINDOW,
  AUDIENCE_FAULT_SCHEDULE,
  AUDIENCE_HEALTH_POLICY,
  AUDIENCE_LEVEL,
  AUDIENCE_PEAK_WINDOW,
  AUDIENCE_PROJECTION_POLICY,
  AUDIENCE_QUEUE_LIMITS,
  AUDIENCE_RETRY_POLICY,
  AUDIENCE_ROUTING_POLICY,
  AUDIENCE_OPERATION_LABELS,
} from '../index';
import { formatInteger } from '../../ui/format';
import {
  formatDataSize,
  formatMillisecondsPrecise,
  formatPercentExact,
} from '../../features/game-ui';
import { audienceWindowText } from './audience-meta';

/**
 * Concise player brief: condition, workload, targets, required cases and the
 * out-of-scope list. It never announces a winning architecture; fixed internal
 * policies are collapsed read-only details, not extra knobs.
 */
export function AudienceBriefing() {
  const level = AUDIENCE_LEVEL;
  const workload = level.workload;
  const slo = level.slo;

  return (
    <div className="audience-briefing">
      <header className="audience-briefing__head">
        <p className="audience-briefing__eyebrow">Task</p>
        <h2>{level.title}</h2>
        <p>{level.summary}</p>
      </header>

      <section>
        <h3>The problem</h3>
        <p>{level.task}</p>
        <p>
          Start with Users only. Add the services and storage you need from
          Components. The first screen exposes Application instances, SQL size
          and read strategy, the optional Cache TTL and Worker instances; other
          policies are fixed and disclosed below.
        </p>
        <h4>Operations</h4>
        <ul>
          <li>
            <strong>{AUDIENCE_OPERATION_LABELS.ingest}</strong> — one durable
            event per logical id. An acknowledgement means the event is
            committed; repeating the same id and payload has one effect.
          </li>
          <li>
            <strong>{AUDIENCE_OPERATION_LABELS.read}</strong> — exactly the top
            20 of 100 streams by unique viewers active in the previous 15
            minutes. The answer names its as-of snapshot; ties resolve by
            ascending stream id.
          </li>
        </ul>
        <p className="audience-briefing__note">
          Repeating activity by the same user on the same stream does not add a
          viewer. One user may watch several streams. Activity leaves the
          15-minute window during the run, so expiry is real work, not a label.
        </p>
      </section>

      <section>
        <h3>Offered workload</h3>
        <dl className="audience-facts">
          <div>
            <dt>Population / streams</dt>
            <dd>
              {formatInteger(level.dataset.users)} users /{' '}
              {formatInteger(level.dataset.streams)} streams
            </dd>
          </div>
          <div>
            <dt>Seeded prehistory</dt>
            <dd>
              {formatInteger(level.dataset.prehistoryEvents)} events ·{' '}
              {formatDataSize(level.dataset.prehistoryRawBytes)} raw
            </dd>
          </div>
          <div>
            <dt>Activity window</dt>
            <dd>
              previous {formatInteger(AUDIENCE_ACTIVITY_WINDOW_MS / 60_000)} min ·
              open left edge
            </dd>
          </div>
          <div>
            <dt>Record activity</dt>
            <dd>
              {formatInteger(workload.ingestEventsPerSecond)} events/s
              throughout
            </dd>
          </div>
          <div>
            <dt>Ranking response</dt>
            <dd>
              top {formatInteger(workload.topN)} ·{' '}
              {formatDataSize(AUDIENCE_CATALOG.components.cache.entryBytes)}
            </dd>
          </div>
          <div>
            <dt>Run</dt>
            <dd>
              {formatInteger(workload.measuredMs / 1000)} s measured · up to{' '}
              {formatInteger(workload.drainMs / 1000)} s drain
            </dd>
          </div>
        </dl>
        <div className="audience-table-wrap">
          <table className="audience-table">
            <caption>Ranking read timeline</caption>
            <thead>
              <tr>
                <th scope="col">Phase</th>
                <th scope="col">Reads</th>
              </tr>
            </thead>
            <tbody>
              {workload.readPhases.map((phase) => (
                <tr key={`${phase.fromMs}-${phase.toMs}`}>
                  <th scope="row">
                    {formatInteger(phase.fromMs / 1000)}–
                    {formatInteger(phase.toMs / 1000)} s
                    {phase.fromMs === workload.peakWindow.fromMs
                      ? ' · peak'
                      : ''}
                  </th>
                  <td>{formatInteger(phase.readsPerSecond)} req/s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="audience-briefing__note">
          Arrivals, user/stream choices and incidents use one seeded trace,
          independent of the graph. Every case resets to the same prehistory and
          the same measured input. The cache starts cold.
        </p>
      </section>

      <section>
        <h3>Passing requirements</h3>
        <div className="audience-table-wrap">
          <table className="audience-table">
            <caption>Each operation · whole case and critical cohort</caption>
            <thead>
              <tr>
                <th scope="col">Requirement</th>
                <th scope="col">Whole case</th>
                <th scope="col">Critical cohort</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Availability</th>
                <td>≥ {formatPercentExact(slo.availability, 1)}</td>
                <td>≥ {formatPercentExact(slo.availability, 1)}</td>
              </tr>
              <tr>
                <th scope="row">Successful p95</th>
                <td>≤ {formatMillisecondsPrecise(slo.successfulP95Ms)}</td>
                <td>≤ {formatMillisecondsPrecise(slo.successfulP95Ms)}</td>
              </tr>
              <tr>
                <th scope="row">Freshness</th>
                <td colSpan={2}>
                  every successful ranking ≤{' '}
                  {formatMillisecondsPrecise(slo.freshnessMs)} behind its named
                  snapshot at delivery
                </td>
              </tr>
              <tr>
                <th scope="row">Correctness</th>
                <td colSpan={2}>
                  exact distinct and expiry, durable acknowledged events, no
                  duplicate effect or lost event
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="audience-briefing__note">
          At least {formatInteger(slo.minimumLatencySamples)} successful samples
          are needed for latency; no calls cannot pass. Request deadline{' '}
          {formatMillisecondsPrecise(workload.requestDeadlineMs)}. Rejections,
          timeouts and unknown outcomes stay in the availability denominator. A
          complete bounded drain is required. Among designs where every required
          case passes, lower actual peak-case cost ranks first.
        </p>
      </section>

      <section>
        <h3>Required cases</h3>
        <ul>
          <li>
            <strong>Normal traffic</strong> — the whole case is gated.
          </li>
          <li>
            <strong>Live peak</strong> — critical cohort{' '}
            {audienceWindowText(AUDIENCE_PEAK_WINDOW)}.
          </li>
          <li>
            <strong>One Application failure per physical instance</strong> — up
            to four slots, critical cohort{' '}
            {audienceWindowText(AUDIENCE_FAULT_CRITICAL_WINDOW)}. The target is
            the slot index, independent of node names or order.
          </li>
        </ul>
        <p>
          The failure schedule is fixed: crash at{' '}
          {formatInteger(AUDIENCE_FAULT_SCHEDULE.crashAtMs / 1000)} s, unavailable
          for {formatInteger(AUDIENCE_FAULT_SCHEDULE.downMs / 1000)} s, boot for{' '}
          {formatInteger(AUDIENCE_FAULT_SCHEDULE.bootMs / 1000)} s, then ready
          after two successful health probes. Durable SQL commits and outbox
          rows survive; volatile Application work does not.
        </p>
        <p className="audience-briefing__note">
          Qualification requires normal, peak and every failure case. The score
          uses only the peak case cost, and only when all required cases pass.
          Failure-case costs are visible but never summed into the score.
        </p>
      </section>

      <section>
        <h3>Why the 15-minute window needs real work</h3>
        <p>
          The seeded prehistory is already in the database, but viewers keep
          leaving the window while the measured traffic runs. A query must scan
          the exact committed range or a projection must apply expiry and
          publish a cursor that includes it. There is no SQL shell, no arbitrary
          query editor and no precomputed “current” answer to rely on.
        </p>
        <p>
          A cached answer also carries the snapshot it represents. The freshness
          check is measured at delivery, so keeping a payload longer than 5
          seconds can return a stale answer that fails even though the transport
          succeeded.
        </p>
      </section>

      <section>
        <h3>Component capabilities</h3>
        <ul className="audience-briefing__list">
          <li>
            <strong>{AUDIENCE_CATALOG.components.users.label}</strong> — fixed
            population and streams; only label and position are editable.
          </li>
          <li>
            <strong>{AUDIENCE_CATALOG.components.lb.label}</strong> — one priced
            managed node with internal redundancy inside this profile. It routes
            only to backends it currently knows as ready.
          </li>
          <li>
            <strong>{AUDIENCE_CATALOG.components.app.label}</strong> — a
            homogeneous pool; instances add CPU, RAM and one network lane and are
            charged each. It holds no durable audience state.
          </li>
          <li>
            <strong>{AUDIENCE_CATALOG.components.sql.label}</strong> — one
            primary database. Size sets CPU, RAM, disk and price. The read plan
            chooses an indexed query or a durable projection fed by outbox jobs
            in the SQL jobs table.
          </li>
          <li>
            <strong>{AUDIENCE_CATALOG.components.cache.label}</strong> — optional
            shared ranking answer. TTL is the actual retention you select;
            concurrent misses coalesce.
          </li>
          <li>
            <strong>{AUDIENCE_CATALOG.components.worker.label}</strong> — optional
            pool that polls SQL jobs, maintains exact last-seen/expiry state and
            publishes one ordered prefix. It does no useful work with the query
            plan.
          </li>
        </ul>
        <p className="audience-briefing__note">
          {AUDIENCE_CATALOG.priceNote}
        </p>
      </section>

      <details className="audience-briefing__details">
        <summary>Fixed policies (read-only)</summary>
        <dl className="audience-facts">
          <div>
            <dt>Health probes</dt>
            <dd>
              every {formatInteger(AUDIENCE_HEALTH_POLICY.intervalMs)} ms ·{' '}
              {formatInteger(AUDIENCE_HEALTH_POLICY.timeoutMs)} ms timeout ·{' '}
              {AUDIENCE_HEALTH_POLICY.failuresToUnhealthy} failures exclude ·{' '}
              {AUDIENCE_HEALTH_POLICY.successesToReady} successes ready
            </dd>
          </div>
          <div>
            <dt>Retry</dt>
            <dd>
              {AUDIENCE_RETRY_POLICY.maxRetries} retry ·{' '}
              {formatInteger(AUDIENCE_RETRY_POLICY.backoffMs)} ms backoff · same
              id · remaining deadline
            </dd>
          </div>
          <div>
            <dt>Queues</dt>
            <dd>
              App {formatInteger(AUDIENCE_QUEUE_LIMITS.appWaitingPerInstance)} per
              instance · SQL {formatInteger(AUDIENCE_QUEUE_LIMITS.sqlWaiting)} ·
              Cache {formatInteger(AUDIENCE_QUEUE_LIMITS.cacheWaiting)}
            </dd>
          </div>
          <div>
            <dt>Projection</dt>
            <dd>
              batch {formatInteger(AUDIENCE_PROJECTION_POLICY.maxBatchEvents)} ·{' '}
              {formatInteger(AUDIENCE_PROJECTION_POLICY.heartbeatMs)} ms
              heartbeat · ordered prefix publication
            </dd>
          </div>
          <div>
            <dt>Direct path</dt>
            <dd>
              Users → App always targets slot{' '}
              {AUDIENCE_ROUTING_POLICY.directPathTarget}; spare slots are not
              routed without the Load Balancer
            </dd>
          </div>
        </dl>
        <p className="audience-briefing__note">
          Health checks are an LB-managed service within this profile. On a
          direct path there is no LB health state; the result reports only what
          was actually observed instead of inventing a detection time.
        </p>
      </details>

      <section>
        <h3>Out of scope</h3>
        <p>
          This profile does not include SQL, Cache, Worker, Load Balancer, zone,
          broker or region failures; replication or multi-region claims; RTO
          gates; approximate distinct algorithms; country filters; multiple
          windows; or authorization and audit history. A pass means the declared
          cases passed, not full production resilience.
        </p>
      </section>
    </div>
  );
}
