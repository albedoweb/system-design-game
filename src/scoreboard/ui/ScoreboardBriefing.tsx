import { SCOREBOARD_CATALOG, SCOREBOARD_LEVEL } from '../index';
import { formatInteger } from '../../ui/format';
import {
  formatDataSize,
  formatMillisecondsPrecise,
  formatPercentExact,
} from './scoreboard-format';

/**
 * Concise player brief: problem, offered workload and targets. It never
 * announces a winning architecture; component capabilities and settings are
 * discovered in the palette and inspector.
 */
export function ScoreboardBriefing() {
  const level = SCOREBOARD_LEVEL;
  const workload = level.workload;
  const slo = level.slo;

  return (
    <div className="scoreboard-briefing">
      <header className="scoreboard-briefing__head">
        <p className="scoreboard-briefing__eyebrow">Task</p>
        <h2>{level.title}</h2>
        <p>{level.summary}</p>
      </header>

      <section>
        <h3>The problem</h3>
        <p>{level.task}</p>
        <p>
          Start with Users only. Add the services and storage you need from
          Components. The first screen exposes pool size, database size, how the
          ranking is obtained and the cache TTL; other limits are fixed and
          disclosed below.
        </p>
      </section>

      <section>
        <h3>Offered workload</h3>
        <dl className="scoreboard-facts">
          <div>
            <dt>Participants / candidates</dt>
            <dd>
              {formatInteger(level.dataset.participants)} /{' '}
              {formatInteger(level.dataset.candidates)}
            </dd>
          </div>
          <div>
            <dt>Current-vote data</dt>
            <dd>
              {formatInteger(level.dataset.currentVoteBytes)} B per row ·{' '}
              {formatDataSize(level.dataset.workingSetBytes)} working set
            </dd>
          </div>
          <div>
            <dt>Vote changes</dt>
            <dd>
              {formatInteger(workload.voteChangesPerSecond)}/s · replace the
              previous choice
            </dd>
          </div>
          <div>
            <dt>Leaderboard reads</dt>
            <dd>10/s → 200/s → 10/s</dd>
          </div>
          <div>
            <dt>Response</dt>
            <dd>
              top {workload.topN} · {formatDataSize(4_096)} · ties by ascending
              candidate id
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
        <div className="scoreboard-table-wrap">
          <table className="scoreboard-table">
            <caption>Leaderboard traffic timeline</caption>
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
        <p className="scoreboard-briefing__note">
          Arrivals and participant choices come from one seeded trace,
          independent of the graph. The cache starts cold.
        </p>
      </section>

      <section>
        <h3>Passing requirements</h3>
        <div className="scoreboard-table-wrap">
          <table className="scoreboard-table">
            <caption>Each operation, whole run and peak cohort</caption>
            <thead>
              <tr>
                <th scope="col">Requirement</th>
                <th scope="col">Whole run</th>
                <th scope="col">Peak 20–60 s</th>
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
                  ≤ {formatMillisecondsPrecise(slo.freshnessMs)} behind committed
                  votes
                </td>
              </tr>
              <tr>
                <th scope="row">Correctness</th>
                <td colSpan={2}>
                  no invented result, double effect or lost acknowledged vote
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="scoreboard-briefing__note">
          Deadline {formatMillisecondsPrecise(workload.requestDeadlineMs)} per
          request. Rejections and timeouts stay in the availability denominator.
          Among complete passing designs, lower actual run cost ranks first.
        </p>
      </section>

      <section>
        <h3>Component capabilities</h3>
        <ul className="scoreboard-briefing__list">
          <li>
            <strong>{SCOREBOARD_CATALOG.components.app.label}</strong> — a service
            pool; instances add CPU, RAM and network capacity and are charged each.
          </li>
          <li>
            <strong>{SCOREBOARD_CATALOG.components.sql.label}</strong> — one primary
            database. Size sets cores, RAM, disk and price. Its read plan chooses
            between computing from raw votes and maintaining a vote aggregate.
          </li>
          <li>
            <strong>{SCOREBOARD_CATALOG.components.cache.label}</strong> — optional
            shared-answer cache with a TTL. Concurrent misses coalesce; writes do
            not invalidate the entry.
          </li>
        </ul>
        <p className="scoreboard-briefing__note">
          {SCOREBOARD_CATALOG.priceNote}
        </p>
      </section>
    </div>
  );
}
