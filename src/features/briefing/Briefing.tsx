import {
  CACHE_ENTRY_KIB,
  DEFAULT_POOL_SIZE,
  DEFAULT_QUEUE_LIMIT,
  DEFAULT_TTL_SECONDS,
  NODE_KIND_LABELS,
  NODE_SIZE_LABELS,
  getCapacity,
  getSizeSpec,
  type LevelDefinition,
} from '../../domain';
import {
  formatDecimal,
  formatDuration,
  formatInteger,
  formatMicroUsd,
  formatPercent,
  formatTime,
} from '../../ui/format';
import {
  DB_SIZE_ROWS,
  dbSlotBounds,
  expectedArrivalTotals,
  peakLabel,
  scheduleWindows,
  sizeRows,
} from './level-facts';
import './briefing.css';

function SloTable({ level }: { level: LevelDefinition }) {
  const slo = level.slo;
  return (
    <div className="brief-table-wrap">
      <table className="brief-table">
        <caption>SLO targets</caption>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Target</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Read and write availability</th>
            <td>≥ {formatPercent(slo.availability)}</td>
          </tr>
          <tr>
            <th scope="row">Read p95</th>
            <td>≤ {formatDecimal(slo.readP95Ms, 0)} ms</td>
          </tr>
          <tr>
            <th scope="row">Write p95</th>
            <td>≤ {formatDecimal(slo.writeP95Ms, 0)} ms</td>
          </tr>
          <tr className="brief-table__group">
            <th scope="row">
              Critical window {formatTime(slo.criticalFromMs)}–
              {formatTime(slo.criticalToMs)}
            </th>
            <td>separate gate</td>
          </tr>
          <tr>
            <th scope="row">Availability in the window</th>
            <td>≥ {formatPercent(slo.criticalAvailability)}</td>
          </tr>
          <tr>
            <th scope="row">Read p95 in the window</th>
            <td>≤ {formatDecimal(slo.criticalReadP95Ms, 0)} ms</td>
          </tr>
          <tr>
            <th scope="row">Write p95 in the window</th>
            <td>≤ {formatDecimal(slo.criticalWriteP95Ms, 0)} ms</td>
          </tr>
          <tr>
            <th scope="row">Configuration cost</th>
            <td>≤ {formatMicroUsd(level.budgetMicroUsdPerHour)}/h</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function Briefing({ level }: { level: LevelDefinition }) {
  const windows = scheduleWindows(level);
  const arrivals = expectedArrivalTotals(level);
  const bounds = dbSlotBounds(level);
  const readWorkload = level.workloads.read;
  const loadBalancerPrice =
    getSizeSpec('loadBalancer', 'small').priceMicroUsdPerHour;

  return (
    <div className="briefing">
      <section>
        <p className="briefing__eyebrow">Briefing</p>
        <h2>{level.title}</h2>
        <p className="briefing__lead">{level.description}</p>
        <p className="briefing__callout">
          This is a general catalog teaching model. It is not a reproduction of
          the original Google ImageServer task or a real benchmark.
        </p>
      </section>

      <section>
        <h3>Incoming workload</h3>
        <p className="briefing__note">
          Peak: {peakLabel(level)}. Independent Poisson streams; these are
          expected values, not a hard quota.
        </p>
        <div className="brief-table-wrap">
          <table className="brief-table">
            <caption>Estimated intervals</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Reads/s</th>
                <th scope="col">Writes/s</th>
                <th scope="col">Total/s</th>
              </tr>
            </thead>
            <tbody>
              {windows.map((window) => (
                <tr key={`${window.fromMs}-${window.toMs}`}>
                  <th scope="row">
                    {formatDecimal(window.fromMs / 1000, 0)}–
                    {formatTime(window.toMs)}
                  </th>
                  <td>{formatInteger(window.readRps)}</td>
                  <td>{formatInteger(window.writeRps)}</td>
                  <td>{formatInteger(window.totalRps)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="brief-facts">
          <div>
            <dt>Expected arrivals</dt>
            <dd>
              {formatInteger(arrivals.reads)} reads +{' '}
              {formatInteger(arrivals.writes)} writes
            </dd>
          </div>
          <div>
            <dt>Warmup</dt>
            <dd>
              {formatDuration(level.warmupMs)} ·{' '}
              {formatInteger(arrivals.warmup)} arrivals excluded from scoring
            </dd>
          </div>
          <div>
            <dt>Keys</dt>
            <dd>
              {formatInteger(readWorkload.keySpace)} in the namespace,{' '}
              {formatInteger(readWorkload.hotCount)} hot ·{' '}
              {formatPercent(readWorkload.hotProbability, 1)} of reads
            </dd>
          </div>
          <div>
            <dt>Record size</dt>
            <dd>
              Cache entry {CACHE_ENTRY_KIB} KiB; per-entry overhead is not
              modelled.
            </dd>
          </div>
        </dl>
      </section>

      <section>
        <h3>Timeline</h3>
        <div className="brief-table-wrap">
          <table className="brief-table">
            <caption>One run</caption>
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Warmup before evaluation</th>
                <td>{formatDuration(level.warmupMs)}</td>
              </tr>
              <tr>
                <th scope="row">Evaluation duration</th>
                <td>{formatDuration(level.durationMs)}</td>
              </tr>
              <tr>
                <th scope="row">Cache flush</th>
                <td>
                  {level.flushAtMs === null
                    ? 'none'
                    : `${formatDuration(level.flushAtMs)} — entries are cleared, the component stays available`}
                </td>
              </tr>
              <tr>
                <th scope="row">Drain after generation</th>
                <td>{formatDuration(level.drainMs)}</td>
              </tr>
              <tr>
                <th scope="row">Global deadline</th>
                <td>{formatDuration(level.deadlineMs)} from logical arrival</td>
              </tr>
              <tr>
                <th scope="row">Retries</th>
                <td>off in this iteration</td>
              </tr>
              <tr>
                <th scope="row">Budget</th>
                <td>{formatMicroUsd(level.budgetMicroUsdPerHour)}/h</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3>Latency and network</h3>
        <dl className="brief-facts">
          <div>
            <dt>External RTT</dt>
            <dd>{formatDuration(level.timing.clientRttMs)} total</dd>
          </div>
          <div>
            <dt>Internal edge</dt>
            <dd>
              {formatDuration(level.timing.edgeRttMs)} (
              {formatDuration(level.timing.edgeRttMs / 2)} each way)
            </dd>
          </div>
          <div>
            <dt>App CPU</dt>
            <dd>{formatDuration(level.timing.appCpuMs)}</dd>
          </div>
          <div>
            <dt>Cache lookup</dt>
            <dd>{formatDuration(level.timing.cacheLookupMs)}</dd>
          </div>
          <div>
            <dt>DB read / write</dt>
            <dd>
              {formatDuration(level.timing.dbReadMs)} /{' '}
              {formatDuration(level.timing.dbWriteMs)}
            </dd>
          </div>
          <div>
            <dt>Load balancer</dt>
            <dd>{formatDuration(level.timing.lbMs)}</dd>
          </div>
          <div>
            <dt>Invalidation after write</dt>
            <dd>{formatDuration(level.timing.invalidationMs)}</dd>
          </div>
        </dl>
        <p className="briefing__note">
          Network models latency only. Shared bandwidth and packet
          serialization are not simulated in this version.
        </p>
      </section>

      <section>
        <h3>SLO and scoring</h3>
        <SloTable level={level} />
        <p className="briefing__note">
          Pending is not success. If there is no data, the check stays unknown
          and does not pass. The critical cohort is selected by logical arrival
          time.
        </p>
      </section>

      <section>
        <h3>Database load</h3>
        <p className="briefing__note">
          Occupancy = read misses × DB read + writes × DB write. These are upper
          bounds for two regimes, not hit-ratio or queue forecasts.
        </p>
        <div className="brief-table-wrap">
          <table className="brief-table">
            <caption>DB slots at peak</caption>
            <thead>
              <tr>
                <th scope="col">Regime</th>
                <th scope="col">Slots needed</th>
                <th scope="col">→ size</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Cache fully cold</th>
                <td>{formatDecimal(bounds.cold, 2)}</td>
                <td>
                  {NODE_SIZE_LABELS.large} ({getCapacity('database', 'large')})
                </td>
              </tr>
              <tr>
                <th scope="row">Illustrative 90% hit rate</th>
                <td>{formatDecimal(bounds.illustrative, 2)}</td>
                <td>
                  {NODE_SIZE_LABELS.small} ({getCapacity('database', 'small')})
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3>Catalog and cost</h3>
        <p className="briefing__note">
          Prices are conditional game prices, not cloud quotes. The client is
          free; the load balancer costs {formatMicroUsd(loadBalancerPrice)}/h.
        </p>
        <div className="brief-table-wrap">
          <table className="brief-table brief-table--catalog">
            <caption>Component sizes</caption>
            <thead>
              <tr>
                <th scope="col">Component</th>
                {(['small', 'medium', 'large'] as const).map((size) => (
                  <th scope="col" key={size}>
                    {NODE_SIZE_LABELS[size]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DB_SIZE_ROWS.map((kind) => (
                <tr key={kind}>
                  <th scope="row">{NODE_KIND_LABELS[kind]}</th>
                  {sizeRows(kind).map((cell, index) => (
                    <td key={`${kind}-${index}`}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="briefing__note">
          API/DB/cache defaults: queue {formatInteger(DEFAULT_QUEUE_LIMIT)},
          pool {formatInteger(DEFAULT_POOL_SIZE)}, TTL{' '}
          {formatInteger(DEFAULT_TTL_SECONDS)} s. You can change them in the
          inspector within the allowed bounds.
        </p>
      </section>

      <section className="briefing__links">
        <a
          href="https://sre.google/workbook/non-abstract-design/"
          target="_blank"
          rel="noopener noreferrer"
        >
          NALSD: non-abstract design
        </a>
        <a
          href="https://github.com/donnemartin/system-design-primer"
          target="_blank"
          rel="noopener noreferrer"
        >
          System Design Primer
        </a>
      </section>
    </div>
  );
}
