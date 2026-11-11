import { IMAGE_LEVEL } from '../level';
import { formatDecimal, formatInteger } from '../../ui/format';
import { formatDataSize, formatMilliseconds, formatTerabytes, formatUsd } from './image-format';
import { IMAGE_BUSINESS_ORDER, IMAGE_BUSINESS_OPERATION_LABELS } from './image-meta';

/**
 * Player-facing briefing. It states the frozen scenario, the teaching-model
 * boundary and the public sources. Internal task/report references are
 * deliberately absent: primary gameplay never exposes the implementation.
 */
export function ImageBriefing() {
  const level = IMAGE_LEVEL;
  const dataset = level.dataset;
  const workload = level.workload;
  const slo = level.slo;

  return (
    <div className="image-briefing">
      <header className="image-briefing__head">
        <p className="image-briefing__eyebrow">Task</p>
        <h2>{level.title}</h2>
        <p>{level.description}</p>
      </header>

      <section>
        <h3>Scenario</h3>
        <p>
          {formatInteger(dataset.users)} users upload{' '}
          {formatInteger(dataset.uploadsPerUserPerDay)} originals and run{' '}
          {formatInteger(dataset.searchesPerUserPerDay)} searches a day from North
          America, Europe and Asia Pacific in equal parts. Each search returns the ten
          most recent matches and every result opens up to two detail views.
        </p>
        <p>
          The starter is a valid but poor strategy: one small shared metadata store
          with no index for every region, and no replication. Missing index, undersized
          disk and full-cache pressure are reported by validation; they do not crash
          the editor.
        </p>
      </section>

      <section>
        <h3>Data facts</h3>
        <dl className="image-facts">
          <div>
            <dt>Retention</dt>
            <dd>{dataset.retentionDays} days, then a plateau</dd>
          </div>
          <div>
            <dt>Mature images</dt>
            <dd>{formatInteger(dataset.matureImages)} at day 30</dd>
          </div>
          <div>
            <dt>Original size</dt>
            <dd>{formatDataSize(dataset.originalBytes)} exactly, disclosed</dd>
          </div>
          <div>
            <dt>Thumbnail size</dt>
            <dd>
              {formatDataSize(dataset.thumbnailBytes)} as a provider variant read
            </dd>
          </div>
          <div>
            <dt>Metadata record</dt>
            <dd>{formatDataSize(dataset.metadataBytes)} before indexes</dd>
          </div>
          <div>
            <dt>Originals stored</dt>
            <dd>{formatTerabytes(dataset.matureOriginalTb)} · fixed provider</dd>
          </div>
          <div>
            <dt>Metadata before indexes</dt>
            <dd>{formatTerabytes(dataset.matureMetadataTb)}</dd>
          </div>
          <div>
            <dt>If thumbnails were preallocated</dt>
            <dd>
              {formatTerabytes(dataset.matureMaterializedThumbnailTb)} — not charged in
              v1
            </dd>
          </div>
          <div>
            <dt>Search popularity</dt>
            <dd>
              {Math.round(workload.hotKeyShare * 100)}% over{' '}
              {formatInteger(workload.hotKeys)} hot keys, the rest over a{' '}
              {formatInteger(workload.longTailRepresentativeKeys)}-key long tail
            </dd>
          </div>
        </dl>
      </section>

      <section>
        <h3>Evaluation window</h3>
        <p>
          Every case starts with a fresh {formatMilliseconds(level.qualification.warmupMs)}{' '}
          warm-up, then {formatMilliseconds(level.qualification.measuredMs)} of
          measured traffic, up to {formatMilliseconds(level.qualification.drainMs)} of
          request drain, then a separate no-new-offers consistency postlude through the
          last acknowledged upload +{' '}
          {formatMilliseconds(level.qualification.postlude.maxAfterLastAckMs)}. A fault
          starts at measured second 20 and lasts 20 s, followed by 20 s of recovery.
        </p>
        <p>
          Normal uses the daily average, peak and every incident case use twice the
          average. Incident cases rotate one region outage per case, plus a node case
          named <em>one instance per pool</em> and a both-directions{' '}
          <em>na-eu</em> link outage.
        </p>
      </section>

      <section>
        <h3>Targets</h3>
        <div className="image-table-wrap">
          <table className="image-table">
            <caption>p99.9 of successful responses, per operation</caption>
            <thead>
              <tr>
                <th scope="col">Operation</th>
                <th scope="col">Normal / peak</th>
                <th scope="col">Incident</th>
                <th scope="col">Availability</th>
              </tr>
            </thead>
            <tbody>
              {IMAGE_BUSINESS_ORDER.map((operation) => (
                <tr key={operation}>
                  <th scope="row">{IMAGE_BUSINESS_OPERATION_LABELS[operation]}</th>
                  <td>
                    {formatMilliseconds(
                      operation === 'detail'
                        ? slo.normal.detailP999Ms
                        : operation === 'search'
                          ? slo.normal.searchP999Ms
                          : slo.normal.uploadP999Ms,
                    )}
                  </td>
                  <td>
                    {formatMilliseconds(
                      operation === 'detail'
                        ? slo.incident.detailP999Ms
                        : operation === 'search'
                          ? slo.incident.searchP999Ms
                          : slo.incident.uploadP999Ms,
                    )}
                  </td>
                  <td>
                    {formatDecimal(slo.normal.availability * 100, 1)}% ·{' '}
                    {formatDecimal(slo.incident.availability * 100, 1)}% incident
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="image-briefing__note">
          Availability uses every offered request. Percentiles use successful responses
          only and always show their sample counts, so dropping or rejecting traffic
          cannot improve a percentile. p99.9 needs at least{' '}
          {formatInteger(level.qualification.minimumP999Samples)} successful samples per
          operation and case. Freshness must stay within{' '}
          {formatMilliseconds(slo.freshnessMs)} and no acknowledged upload may be lost or
          applied twice.
        </p>
      </section>

      <section>
        <h3>Cost and capacity</h3>
        <p>
          Budget {formatUsd(level.budget.monthlyUsd, 0)} per month. The fixed{' '}
          {formatTerabytes(dataset.matureOriginalTb)} provider base is billed separately
          from everything you provision. Compute is an instance-hour price that already
          includes 8 cores, 24 GB RAM and 2 TB disk; extra disk tiers, metadata copies,
          caches, traffic and API fees are explicit. Incident replay cost is reported
          separately and never extrapolated across 30 days.
        </p>
        <p className="image-briefing__note">
          Prices and coefficients are conditional in-game teaching values, not vendor
          quotes. The budget is provisional until real evaluator witnesses prove the
          reference designs.
        </p>
      </section>

      <section className="image-briefing__callout">
        <h3>Two different views</h3>
        <p>
          Request metrics come from the measured scenario windows. Capacity and cost are
          analytical day-30 estimates of the graph currently on the canvas. They stay
          separate, and a previous result is labelled as such as soon as the semantic
          graph or the seed changes.
        </p>
      </section>

      <section>
        <h3>Sources and adaptation</h3>
        <p>
          The exercise adapts the Google SRE Classroom “ImageServer” design exercise
          (CC BY 4.0): the user counts, image sizes and p99.9 targets are the published
          classroom conditions. Everything else — retention, prices, popularity tails,
          latency bands, fault schedule and qualification gates — is this game’s own
          disclosure. It is not a Google benchmark and not production advice.
        </p>
        <ul className="image-briefing__refs">
          <li>
            <a
              href="https://sre.google/classroom/imageserver/"
              target="_blank"
              rel="noreferrer noopener"
            >
              Google SRE Classroom: ImageServer
            </a>
          </li>
          <li>
            <a
              href="https://static.googleusercontent.com/media/sre.google/en//static/pdf/sre_classroom_imageserver_handout_a4.pdf"
              target="_blank"
              rel="noreferrer noopener"
            >
              ImageServer participant handout
            </a>
          </li>
          <li>
            <a
              href="https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/"
              target="_blank"
              rel="noreferrer noopener"
            >
              Timeouts, retries and backoff with jitter
            </a>
          </li>
          <li>
            <a
              href="https://docs.stripe.com/api/idempotent_requests"
              target="_blank"
              rel="noreferrer noopener"
            >
              Idempotent requests and stable keys
            </a>
          </li>
        </ul>
      </section>
    </div>
  );
}
