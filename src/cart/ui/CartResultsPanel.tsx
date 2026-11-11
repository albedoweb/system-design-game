/**
 * Global Cart results view (GC-014).
 *
 * The panel is a pure view over a finished evaluation plus the bounded
 * telemetry/evidence payloads that a run controller can attach. It presents:
 * - a verdict first, then the failed checks, then one scenario at a time;
 * - per-scenario checks with measured value, required value and the result;
 * - resources, cost, traffic on physical links mapped back to the graph path,
 *   distinct business outcomes and a concise request timeline, each collapsed
 *   so the default report stays short.
 *
 * It never re-runs the model, never relaxes a check and never invents a value.
 */
import { CartReadCoverageNotice } from './CartReadCoverageNotice';
import { CartBottleneckNotice } from './CartBottleneckNotice';
import { useState, type ReactNode } from 'react';

import {
  CART_CATALOG,
  CART_REQUIRED_CASES,
  type CartCaseId,
  type CartCaseResult,
  type CartCaseTelemetry,
  type CartEvaluation,
  type CartGraph,
} from '../index';
import {
  CHART_METRIC_COLORS,
  MetricChart,
  ReportSection,
  ReportTable,
  RequirementTable,
} from '../../features/game-ui';
import { Button } from '../../ui/Button';
import {
  DASH,
  formatDecimal,
  formatInteger,
  formatPercent,
} from '../../ui/format';
import { CartRunSummary } from './CartRunSummary';
import { CartNumberTicker } from './CartNumberTicker';
import { CartRequestTimeline } from './CartRequestTimeline';
import {
  buildCartGateViews,
  buildCartOutcomeRows,
  cartCaseLabel,
  cartCasePassed,
  cartRankingEligible,
  orderFailedCartViews,
  summarizeCartGates,
  type CartEvidenceView,
  type CartGateView,
  type CartOutcomeClass,
} from './cart-diagnostics';
import {
  CART_TRAFFIC_CLASS_LABELS,
  CART_TRAFFIC_CLASS_ORDER,
  buildCartLinkRows,
  buildCartRegionRows,
  buildCartTrafficSeries,
  cartRegionName,
} from './cart-frames';
import './cart-report.css';

export interface CartResultsPanelProps {
  readonly graph: CartGraph;
  readonly evaluation: CartEvaluation;
  /** Bounded per-case telemetry payload from the run controller. */
  readonly telemetry?: Partial<Record<CartCaseId, CartCaseTelemetry>>;
  /** Executed request evidence; required to name a per-request graph path. */
  readonly evidence?: Partial<Record<CartCaseId, CartEvidenceView>>;
  readonly onFocusNode?: (nodeId: string) => void;
  readonly onFocusEdge?: (edgeId: string) => void;
  /** Overrides the initially selected scenario; defaults to the first scenario that did not pass. */
  readonly initialCaseId?: CartCaseId;
}

/** Failed checks listed per scenario in "What failed" before the "more below" pointer. */
const WHAT_FAILED_LIMIT = 8;

const CHECK_COLUMN_LABELS = {
  actual: 'Measured',
  limit: 'Required',
  requirement: 'Requirement',
  result: 'Result',
  focus: 'Focus',
} as const;

const RESOURCE_LABELS: Readonly<Record<string, string>> = {
  events: 'Events',
  requests: 'Requests',
  chargedBusyMs: 'Charged busy time',
  wanBillableBytes: 'Billable bytes between regions',
};

const COST_LABELS: Readonly<Record<string, string>> = {
  rentalPerHour: 'Rental',
  wanCredits: 'Billable data between regions',
  preparationSeconds: 'Preparation',
  drainSeconds: 'Drain',
  windowSeconds: 'Measured window',
  peakScoreCreditsPerHour: 'Peak score',
};

const LINK_KIND_LABELS: Readonly<Record<string, string>> = {
  wan: 'WAN',
  fabric: 'Regional fabric',
  'client-access': 'Client access',
  nic: 'Network interface',
};

/** Label for a raw field name: a known label, else the key split into words. */
function fieldLabel(key: string, labels: Readonly<Record<string, string>>): string {
  return labels[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (char) => char.toUpperCase());
}

function verdictBadge(passed: boolean): ReactNode {
  return (
    <span className={passed ? 'is-pass' : 'is-fail'}>{passed ? 'Pass' : 'Fail'}</span>
  );
}

function joinScenarioNames(caseIds: readonly CartCaseId[]): string {
  return caseIds.map((caseId) => cartCaseLabel(caseId)).join(' and ');
}

function VerdictBanner({ evaluation }: { evaluation: CartEvaluation }) {
  if (!evaluation.complete) {
    return (
      <section className="cart-verdict cart-verdict--partial" aria-labelledby="cart-verdict-title">
        <span className="cart-verdict__badge" aria-hidden="true" />
        <div className="cart-verdict__body">
          <h2 id="cart-verdict-title">Partial report</h2>
          <p className="cart-verdict__sentence">Run stopped early — partial measurements only, no final score.</p>
        </div>
      </section>
    );
  }
  if (cartRankingEligible(evaluation)) {
    return (
      <section className="cart-verdict cart-verdict--pass" aria-labelledby="cart-verdict-title">
        <span className="cart-verdict__badge" aria-hidden="true" />
        <div className="cart-verdict__body">
          <h2 id="cart-verdict-title">Passed</h2>
          <p className="cart-verdict__sentence">Both scenarios meet every requirement.</p>
          <p className="cart-verdict__cost" data-testid="cart-cost-ranking">
            <CartNumberTicker value={evaluation.scoreCreditsPerHour!} />
            <span className="cart-verdict__unit"> credits/hour</span>
          </p>
          <p className="cart-verdict__caption">
            {`${cartCaseLabel('peak')} cost · budget ${CART_CATALOG.budget.creditsPerHour} credits/hour · lower is better`}
          </p>
        </div>
      </section>
    );
  }
  const summary = summarizeCartGates(evaluation);
  const failedCases = evaluation.cases.filter((item) => !cartCasePassed(evaluation, item.id)).map((item) => item.id);
  const sentence = summary.failed > 0
    ? `${formatInteger(summary.failed)} of ${formatInteger(summary.total)} checks failed in ${joinScenarioNames(summary.failedCases)}.`
    : failedCases.length > 0
      ? `Results are incomplete in ${joinScenarioNames(failedCases)}.`
      : 'The run did not qualify.';
  return (
    <section className="cart-verdict cart-verdict--fail" aria-labelledby="cart-verdict-title">
      <span className="cart-verdict__badge" aria-hidden="true" />
      <div className="cart-verdict__body">
        <h2 id="cart-verdict-title">Not passed</h2>
        <p className="cart-verdict__sentence">{sentence}</p>
        <p className="cart-verdict__sentence" data-testid="cart-cost-withheld">No score: only a design that passes both scenarios is ranked by cost.</p>
      </div>
    </section>
  );
}

function WhatFailed({ evaluation, views }: { evaluation: CartEvaluation; views: readonly CartGateView[] }) {
  const groups = evaluation.cases
    .map((caseResult) => ({
      caseId: caseResult.id,
      failed: orderFailedCartViews(views.filter((view) => view.caseId === caseResult.id && !view.pass)),
    }))
    .filter((group) => group.failed.length > 0);
  if (groups.length === 0) return null;
  return (
    <ReportSection
      title="What failed"
      description={`Failed checks from every scenario, grouped by scenario. Up to ${WHAT_FAILED_LIMIT} are listed per scenario; the full list is under Checks.`}
    >
      {groups.map((group) => {
        const shown = group.failed.slice(0, WHAT_FAILED_LIMIT);
        const hidden = group.failed.length - shown.length;
        return (
          <ReportTable
            key={group.caseId}
            className="cart-table--numeric"
            rowHeaderLabel="Check"
            caption={`${cartCaseLabel(group.caseId)} · failed checks`}
            columns={[
              { key: 'measured', label: 'Measured' },
              { key: 'required', label: 'Required' },
            ]}
            rows={shown.map((view) => ({
              key: view.key,
              header: <span title={view.code}>{view.title}</span>,
              cells: [view.measuredLabel, view.limitLabel],
            }))}
            note={hidden > 0 ? `+ ${formatInteger(hidden)} more below` : undefined}
          />
        );
      })}
    </ReportSection>
  );
}

/** A collapsed report section; the default report stays short and each block opens on demand. */
function MoreSection({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="cart-report__more">
      <summary>{summary}</summary>
      <div className="cart-report__body">{children}</div>
    </details>
  );
}

function OutcomeReport({
  graph,
  evidence,
  caseId,
}: {
  graph: CartGraph;
  evidence: CartEvidenceView | undefined;
  caseId: CartCaseId;
}) {
  if (evidence === undefined) {
    return (
      <ReportSection
        title="Business outcomes"
        description="OutOfStock, TemporarilyUnavailable, PartialCart and a reply lost after a durable commit are different facts and are never merged into one failure count."
      >
        <p className="game-report-section__note">
          No executed records are attached for {cartCaseLabel(caseId)}. The
          panel does not infer individual outcomes from check totals.
        </p>
      </ReportSection>
    );
  }
  const rows = buildCartOutcomeRows(graph, evidence);
  const byClass = new Map<CartOutcomeClass, number>();
  for (const row of rows) {
    byClass.set(row.outcomeClass, (byClass.get(row.outcomeClass) ?? 0) + 1);
  }
  const classes = [...byClass.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return (
    <ReportSection
      title="Business outcomes"
      description="Every executed request keeps one class. A durable commit without an acknowledgement is a lost reply, not unavailable and not OutOfStock."
      note="A PartialCart is diagnostic only and never qualifies a checkout. An unavailable answer is not a stock rejection."
    >
      <ReportTable
        rowHeaderLabel="Outcome class"
        caption={`Outcome classes · ${cartCaseLabel(caseId)}`}
        ariaLabel="Cart outcome classes"
        columns={[
          { key: 'count', label: 'Requests' },
          { key: 'meaning', label: 'Meaning' },
        ]}
        rows={classes.map(([outcomeClass, count]) => {
          const sample = rows.find((row) => row.outcomeClass === outcomeClass);
          return {
            key: outcomeClass,
            header: sample?.label ?? outcomeClass,
            cells: [formatInteger(count), sample?.explanation ?? DASH],
          };
        })}
      />
    </ReportSection>
  );
}

function checkRows(views: readonly CartGateView[], onFocusNode?: (id: string) => void, onFocusEdge?: (id: string) => void) {
  return views.map((view) => {
    const diagnostic = view.diagnostics[0];
    const focusNode = diagnostic?.locations.nodeIds[0];
    const focusEdge = diagnostic?.locations.edgeIds[0];
    return {
      key: view.key,
      label: <span title={view.code}>{view.title}</span>,
      detail: view.explanation,
      actual: view.measuredLabel,
      limit: view.limitLabel,
      requirement: view.requirement || DASH,
      result: { passed: view.pass },
      focus:
        focusNode === undefined && focusEdge === undefined ? (
          DASH
        ) : (
          <span className="cart-report__chips">
            {focusNode === undefined ? null : (
              <Button
                type="button"
                onClick={() => onFocusNode?.(focusNode)}
                disabled={onFocusNode === undefined}
              >
                Focus node
              </Button>
            )}
            {focusEdge === undefined ? null : (
              <Button
                type="button"
                onClick={() => onFocusEdge?.(focusEdge)}
                disabled={onFocusEdge === undefined}
              >
                Focus edge
              </Button>
            )}
          </span>
        ),
    };
  });
}

function GateReport({
  graph,
  evaluation,
  caseId,
  evidence,
  onFocusNode,
  onFocusEdge,
}: {
  graph: CartGraph;
  evaluation: CartEvaluation;
  caseId: CartCaseId;
  evidence: CartEvidenceView | undefined;
  onFocusNode?: (id: string) => void;
  onFocusEdge?: (id: string) => void;
}) {
  const views = buildCartGateViews(evaluation, {
    graph,
    caseFilter: caseId,
    evidence:
      evidence === undefined ? undefined : new Map<CartCaseId, CartEvidenceView>([[caseId, evidence]]),
  });
  const failing = orderFailedCartViews(views.filter((view) => !view.pass));
  const passing = views.filter((view) => view.pass);
  const label = cartCaseLabel(caseId);
  const columns = ['actual', 'limit', 'requirement', 'result', 'focus'] as const;
  return (
    <ReportSection
      title="Checks"
      description={`Every check for ${label}. Each row shows the measured value, the required value and the result. Failed checks come first; passed checks are collapsed below.`}
      note={
        views.length === 0 ? 'No checks are available for this scenario.' : failing.length === 0
          ? 'Every check in this scenario passed.'
          : `${formatInteger(failing.length)} check${failing.length === 1 ? '' : 's'} failed. A failed check is never hidden by an average.`
      }
    >
      <RequirementTable
        nameLabel="Check"
        caption={`${label} checks`}
        columnLabels={CHECK_COLUMN_LABELS}
        columns={[...columns]}
        rows={checkRows(failing, onFocusNode, onFocusEdge)}
        empty={
          <p className="game-report-section__note">
            {views.length === 0
              ? 'This scenario reported no checks. An empty check list is not a pass.'
              : `No failed checks in ${label}.`}
          </p>
        }
      />
      {passing.length > 0 ? (
        <details className="cart-report__more">
          <summary>{`Show ${formatInteger(passing.length)} passed checks`}</summary>
          <div className="cart-report__body">
            <RequirementTable
              nameLabel="Check"
              caption={`${label} passed checks`}
              columnLabels={CHECK_COLUMN_LABELS}
              columns={[...columns]}
              rows={checkRows(passing, onFocusNode, onFocusEdge)}
            />
          </div>
        </details>
      ) : null}
    </ReportSection>
  );
}

function CostReport({
  caseResult,
  caseId,
}: {
  caseResult: CartCaseResult | undefined;
  caseId: CartCaseId;
}) {
  if (caseResult === undefined) return null;
  const costRows = Object.entries(caseResult.cost)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, value]) => ({
      key,
      header: fieldLabel(key, COST_LABELS),
      cells: [
        key === 'rentalPerHour'
          ? `${formatDecimal(value, 4)} credits/hour`
          : key === 'wanCredits'
            ? `${formatDecimal(value, 6)} GiB`
            : key === 'peakScoreCreditsPerHour'
              ? value < 0
                ? 'no score'
                : `${formatDecimal(value, 4)} credits/hour`
              : `${formatDecimal(value, 3)} s`,
      ],
    }));
  return (
    <ReportSection
      title="Resources and cost"
      description="Measured event, request, busy-time and WAN counters plus the cost fields for this scenario. Only the Shopping Rush cost can become the score."
      note="Preparation and drain time count toward the Shopping Rush cost when they occurred. Other scenario costs are shown for reference and never added to the score."
    >
      <ReportTable
        className="cart-table--numeric"
        rowHeaderLabel="Resource"
        caption={`Measured resources · ${cartCaseLabel(caseId)}`}
        columns={[{ key: 'value', label: 'Value' }]}
        rows={Object.entries(caseResult.resources)
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([key, value]) => ({
            key,
            header: fieldLabel(key, RESOURCE_LABELS),
            cells: [
              key === 'wanBillableBytes'
                ? `${formatInteger(value)} bytes`
                : key === 'chargedBusyMs'
                  ? `${formatDecimal(value, 3)} ms`
                  : formatInteger(value),
            ],
          }))}
      />
      {caseResult.complete ? (
        <ReportTable
          className="cart-table--numeric"
          rowHeaderLabel="Cost item"
          caption={`Cost · ${cartCaseLabel(caseId)}`}
          columns={[{ key: 'value', label: 'Value' }]}
          rows={costRows}
        />
      ) : (
        <p className="game-report-section__note">Cost estimate unavailable — this scenario did not finish.</p>
      )}
    </ReportSection>
  );
}

function TrafficReport({
  graph,
  telemetry,
  caseId,
  onFocusNode,
  onFocusEdge,
}: {
  graph: CartGraph;
  telemetry: CartCaseTelemetry | undefined;
  caseId: CartCaseId;
  onFocusNode?: (id: string) => void;
  onFocusEdge?: (id: string) => void;
}) {
  if (telemetry === undefined) {
    return (
      <ReportSection
        title="Traffic and links"
        description="How much data moved, by type and between regions for this scenario."
      >
        <p className="game-report-section__note">
          No traffic measurements are attached for {cartCaseLabel(caseId)}.
          No link saturation is inferred without measured bytes.
        </p>
      </ReportSection>
    );
  }
  const series = buildCartTrafficSeries(telemetry);
  const regions = buildCartRegionRows(telemetry, graph);
  const links = buildCartLinkRows(telemetry, graph);
  const saturated = links.filter((link) => (link.saturation ?? 0) >= 0.8);
  return (
    <ReportSection
      title="Traffic and links"
      description="How much data moved, by type and between regions. All paths between two regions share that pair's circuit."
      note={`${saturated.length} circuit${saturated.length === 1 ? '' : 's'} at or above 80% of capacity in the sampled moments. The charts show ${telemetry.frames.length} of ${telemetry.windowCount} samples, so they may miss short peaks.`}
    >
      <div className="cart-report__charts">
        <MetricChart
          kind="traffic"
          className="cart-report__chart"
          title="Traffic by type"
          series={series.byClass.map((item, index) => ({
            label: item.label,
            values: [...item.values],
            color: [
              CHART_METRIC_COLORS.offered,
              CHART_METRIC_COLORS.successful,
              '#7c3aed',
              '#b45309',
              CHART_METRIC_COLORS.errors,
            ][index] ?? CHART_METRIC_COLORS.offered,
          }))}
          timesMs={series.points.map((point) => point.atMs)}
          durationMs={series.durationMs}
          unit="(bytes/s)"
          valueDigits={0}
          valueFormatter={(value) => `${formatDecimal(value, 0)} bytes/s`}
          emptyLabel="No traffic frames were captured for this scenario."
        />
        <MetricChart
          kind="traffic"
          className="cart-report__chart"
          title="Traffic between regions"
          series={series.wan.map((item) => ({
            label: item.label,
            values: [...item.values],
            color: CHART_METRIC_COLORS.latency,
          }))}
          timesMs={series.points.map((point) => point.atMs)}
          durationMs={series.durationMs}
          unit="(bytes/s)"
          valueDigits={0}
          valueFormatter={(value) => `${formatDecimal(value, 0)} bytes/s`}
          emptyLabel="No WAN bytes were captured for this scenario."
        />
      </div>
      <ReportTable
        rowHeaderLabel="Link"
        caption={`Network links · ${cartCaseLabel(caseId)}`}
        ariaLabel="Physical link utilization"
        minWidthPx={980}
        columns={[
          { key: 'kind', label: 'Kind' },
          { key: 'bytes', label: 'Bytes' },
          { key: 'peak', label: 'Peak' },
          { key: 'capacity', label: 'Capacity' },
          { key: 'saturation', label: 'Saturation' },
          { key: 'path', label: 'Graph path' },
        ]}
        rows={links.map((link) => ({
          key: link.linkId,
          header: link.label,
          cells: [
            fieldLabel(link.kind, LINK_KIND_LABELS),
            formatInteger(link.bytes),
            `${formatDecimal(link.peakBytesPerSecond, 0)} bytes/s`,
            link.capacityBitsPerSecond === null
              ? DASH
              : `${formatDecimal(link.capacityBitsPerSecond / 1_000_000, 0)} Mbit/s`,
            link.saturation === null
              ? DASH
              : formatPercent(link.saturation),
            link.nodeIds[0] === undefined ? (
              DASH
            ) : (
              <span className="cart-report__chips">
                <Button
                  type="button"
                  onClick={() => onFocusNode?.(link.nodeIds[0]!)}
                  disabled={onFocusNode === undefined}
                  aria-label={`Focus ${link.label} node`}
                >
                  Focus node
                </Button>
                {link.edgeIds[0] === undefined ? null : (
                  <Button
                    type="button"
                    onClick={() => onFocusEdge?.(link.edgeIds[0]!)}
                    disabled={onFocusEdge === undefined}
                    aria-label={`Focus ${link.label} edge`}
                  >
                    Focus edge
                  </Button>
                )}
              </span>
            ),
          ],
        }))}
        empty={
          <p className="game-report-section__note">
            No link carried bytes in this scenario.
          </p>
        }
      />
      <ReportTable
        rowHeaderLabel="Region"
        caption={`Traffic by region · ${cartCaseLabel(caseId)}`}
        columns={[
          { key: 'total', label: 'Bytes' },
          ...CART_TRAFFIC_CLASS_ORDER.map((trafficClass) => ({
            key: trafficClass,
            label: CART_TRAFFIC_CLASS_LABELS[trafficClass],
          })),
        ]}
        rows={regions.map((region) => ({
          key: region.region,
          header: cartRegionName(region.region),
          cells: [
            formatInteger(region.bytes),
            ...CART_TRAFFIC_CLASS_ORDER.map((trafficClass) =>
              formatInteger(region.byClass[trafficClass]),
            ),
          ],
        }))}
        empty={
          <p className="game-report-section__note">
            No region carried bytes in this scenario.
          </p>
        }
      />
    </ReportSection>
  );
}

export function CartResultsPanel(props: CartResultsPanelProps) {
  const { graph, evaluation } = props;
  const [selectedCaseId, setSelectedCaseId] = useState<CartCaseId>(
    () =>
      props.initialCaseId ??
      evaluation.cases.find((item) => !cartCasePassed(evaluation, item.id))?.id ??
      CART_REQUIRED_CASES[0],
  );
  const telemetry = props.telemetry?.[selectedCaseId];
  const evidence = props.evidence?.[selectedCaseId];
  const selectedResult = evaluation.cases.find((item) => item.id === selectedCaseId);
  const allViews = buildCartGateViews(evaluation, { graph });

  return (
    <div className="cart-results">
      <VerdictBanner evaluation={evaluation} />
      {evaluation.qualified ? null : <CartReadCoverageNotice graph={graph} />}
      {evaluation.qualified && evaluation.complete ? null : <CartBottleneckNotice graph={graph} evaluation={evaluation} />}
      <WhatFailed evaluation={evaluation} views={allViews} />

      <ReportSection
        title="Scenarios"
        description="Select a scenario to inspect its checks, traffic, outcomes and request timeline."
      >
        <div role="tablist" aria-label="Scenario" className="cart-segmented">
          {evaluation.cases.map((caseResult) => {
            const passed = cartCasePassed(evaluation, caseResult.id);
            const tone = !caseResult.complete ? 'incomplete' : passed ? 'pass' : 'fail';
            return (
              <Button
                key={caseResult.id}
                type="button"
                role="tab"
                className={`cart-tab cart-tab--${tone}`}
                aria-selected={caseResult.id === selectedCaseId}
                aria-label={`${cartCaseLabel(caseResult.id)} · ${!caseResult.complete ? 'incomplete' : passed ? 'pass' : 'fail'}`}
                onClick={() => setSelectedCaseId(caseResult.id)}
              >
                {cartCaseLabel(caseResult.id)}
                <small> {!caseResult.complete ? 'Incomplete' : passed ? 'Pass' : 'Fail'}</small>
              </Button>
            );
          })}
        </div>
        <ReportTable
          rowHeaderLabel="Scenario"
          caption="Scenarios"
          columns={[
            { key: 'status', label: 'Complete' },
            { key: 'gates', label: 'Checks passed' },
            { key: 'verdict', label: 'Verdict' },
          ]}
          rows={evaluation.cases.map((caseResult) => {
            const passedGates = caseResult.gates.filter((gate) => gate.pass).length;
            return {
              key: caseResult.id,
              header: cartCaseLabel(caseResult.id),
              cells: [
                caseResult.complete ? 'Yes' : 'No',
                `${formatInteger(passedGates)} / ${formatInteger(caseResult.gates.length)}`,
                caseResult.complete ? verdictBadge(cartCasePassed(evaluation, caseResult.id)) : 'Incomplete',
              ],
            };
          })}
        />
      </ReportSection>

      {selectedResult ? <CartRunSummary result={selectedResult} graph={graph} /> : null}
      <GateReport
        graph={graph}
        evaluation={evaluation}
        caseId={selectedCaseId}
        evidence={evidence}
        onFocusNode={props.onFocusNode}
        onFocusEdge={props.onFocusEdge}
      />

      <MoreSection summary="Traffic and links">
        <TrafficReport
          graph={graph}
          telemetry={telemetry}
          caseId={selectedCaseId}
          onFocusNode={props.onFocusNode}
          onFocusEdge={props.onFocusEdge}
        />
      </MoreSection>
      <MoreSection summary="Resources and cost">
        <CostReport caseResult={selectedResult} caseId={selectedCaseId} />
      </MoreSection>
      <MoreSection summary="Business outcomes">
        <OutcomeReport graph={graph} evidence={evidence} caseId={selectedCaseId} />
      </MoreSection>
      <MoreSection summary="Request timeline">
        <CartRequestTimeline
          caseId={selectedCaseId}
          graph={graph}
          telemetry={telemetry}
          evidence={evidence}
          onFocusNode={props.onFocusNode}
          onFocusEdge={props.onFocusEdge}
        />
      </MoreSection>

      <details className="cart-report__more cart-report__details">
        <summary>Run details</summary>
        <div className="cart-report__body">
          <dl className="cart-report__facts">
            <dt>Seed</dt>
            <dd>{formatInteger(evaluation.seed)}</dd>
            <dt>Graph digest</dt>
            <dd><code>{evaluation.graphDigest}</code></dd>
          </dl>
        </div>
      </details>
    </div>
  );
}
