import { PARCEL_LEVEL } from '../level';
import { formatDecimal, formatInteger } from '../../ui/format';
import { formatDataSize } from './parcel-format';
import { PARCEL_BUSINESS_OPERATION_LABELS } from './parcel-meta';

function rawTb(years: number): string {
  const workload = PARCEL_LEVEL.workload;
  const events =
    workload.dailyParcels * workload.daysPerYear * workload.eventsPerParcel * years;
  return `${formatDecimal((events * workload.eventBytes) / 1e12, 4)} TB`;
}

export function ParcelBriefing() {
  const workload = PARCEL_LEVEL.workload;
  const slo = PARCEL_LEVEL.slo;
  const reports = workload.reportScheduleMs
    .map((ms) => `${formatDecimal(ms / 1000, 0)} s`)
    .join(', ');

  return (
    <div className="parcel-briefing">
      <header className="parcel-briefing__head">
        <p className="parcel-briefing__eyebrow">Task</p>
        <h2>{PARCEL_LEVEL.title}</h2>
        <p>{PARCEL_LEVEL.description}</p>
      </header>

      <section>
        <h3>Scenario</h3>
        <p>
          A parcel network tracks {formatInteger(workload.dailyParcels)} parcels a
          day. Every parcel produces {workload.eventsPerParcel} events of{' '}
          {formatInteger(workload.eventBytes)} bytes. Customers check current
          status and event history, including four-year-old parcels at year five,
          while warehouse staff request thirty-day reports. Ingest must be durable
          before it is acknowledged.
        </p>
        <p>
          Design the routes and store settings. The starter is structurally valid
          but a poor strategy: it has one small SQL store with one year of
          retention, no meaningful indexes or rollups, and no replica.
        </p>
      </section>

      <section>
        <h3>Data facts</h3>
        <dl className="parcel-facts">
          <div>
            <dt>Ingest</dt>
            <dd>{formatInteger(workload.dailyParcels)} parcels/day</dd>
          </div>
          <div>
            <dt>Events per parcel</dt>
            <dd>{workload.eventsPerParcel}</dd>
          </div>
          <div>
            <dt>Event size</dt>
            <dd>{formatInteger(workload.eventBytes)} bytes</dd>
          </div>
          <div>
            <dt>Raw event data</dt>
            <dd>
              {rawTb(1)} at year 1 · {rawTb(5)} at year 5
            </dd>
          </div>
          <div>
            <dt>Required retention</dt>
            <dd>5 years of raw history</dd>
          </div>
          <div>
            <dt>Warehouses</dt>
            <dd>{formatInteger(workload.warehouseCount)} · last {workload.reportWindowDays} days</dd>
          </div>
          <div>
            <dt>Raw size in decimal units</dt>
            <dd>{formatDataSize(44.8512e12)} at year 5</dd>
          </div>
        </dl>
      </section>

      <section>
        <h3>Evaluation window</h3>
        <p>
          Each horizon gets a fresh {formatDecimal(PARCEL_LEVEL.durationMs / 1000, 0)} s
          request window plus {formatDecimal(PARCEL_LEVEL.drainMs / 1000, 0)} s of drain.
          The workload is independent of the graph: status, history and ingest use
          seeded Poisson arrivals, and six warehouse reports are scheduled at{' '}
          {reports}.
        </p>
        <div className="parcel-table-wrap">
          <table className="parcel-table">
            <caption>Traffic phases at peak</caption>
            <thead>
              <tr>
                <th scope="col">Phase</th>
                <th scope="col">Window</th>
                <th scope="col">Multiplier</th>
              </tr>
            </thead>
            <tbody>
              {workload.phaseMultiplier.map((phase) => (
                <tr key={phase.id}>
                  <th scope="row">{phase.label}</th>
                  <td>
                    {phase.fromMs / 1000}–{phase.toMs / 1000} s
                  </td>
                  <td>{Math.round(phase.multiplier * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="parcel-briefing__note">
          Peak rates: status {formatInteger(workload.peakRatesPerSecond.status)}/s,
          history {formatInteger(workload.peakRatesPerSecond.history)}/s, ingest{' '}
          {formatInteger(workload.peakRatesPerSecond.ingest)}/s. Reports are
          scheduled, not Poisson arrivals.
        </p>
      </section>

      <section>
        <h3>Targets</h3>
        <div className="parcel-table-wrap">
          <table className="parcel-table">
            <caption>Service-level targets for every operation</caption>
            <thead>
              <tr>
                <th scope="col">Operation</th>
                <th scope="col">Availability</th>
                <th scope="col">Successful p95</th>
                <th scope="col">Freshness</th>
              </tr>
            </thead>
            <tbody>
              {(['status', 'history', 'ingest', 'report'] as const).map((operation) => (
                <tr key={operation}>
                  <th scope="row">{PARCEL_BUSINESS_OPERATION_LABELS[operation]}</th>
                  <td>{formatDecimal(slo.availability * 100, 1)}%</td>
                  <td>
                    {slo.p95Ms[operation] >= 1000
                      ? `${formatDecimal(slo.p95Ms[operation] / 1000, 0)} s`
                      : `${slo.p95Ms[operation]} ms`}
                  </td>
                  <td>
                    {operation === 'status'
                      ? `${slo.freshnessMs.status / 1000} s`
                      : operation === 'report'
                        ? `${slo.freshnessMs.report / 1000} s`
                        : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="parcel-briefing__note">
          Availability counts every offered request. Percentiles include successful
          responses only, so dropping, rejecting, timing out or serving stale data
          cannot improve latency. Both year 1 and year 5 must pass.
        </p>
      </section>

      <section>
        <h3>Cost and capacity</h3>
        <p>
          Monthly budget: ${formatInteger(PARCEL_LEVEL.budget.monthlyUsd)}. Compute is
          priced at the catalog hourly rate for 730 hours per month; provisioned
          storage is charged once per physical copy and fixed for the five-year TCO.
          Prices are conditional in-game prices, not vendor quotes.
        </p>
      </section>

      <section className="parcel-briefing__callout">
        <h3>Two different views</h3>
        <p>
          Request metrics come from the 60-second evaluation window. Storage, indexes,
          replication copies and five-year TCO are analytical estimates of the
          full five-year dataset. They are shown separately.
        </p>
      </section>
    </div>
  );
}
