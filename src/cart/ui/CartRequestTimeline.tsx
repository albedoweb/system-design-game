import { Button } from '../../ui/Button';
/**
 * Concise causal request timeline for the Global Cart results view (GC-014).
 *
 * Two layers, both derived from measured data:
 * - executed logical requests (when capture evidence is attached), including
 *   outcome class, delivery time, retry attempts and physical FIFO waiting,
 *   with a focus action for every graph location that carried the request;
 * - representative physical trace events from the bounded telemetry payload,
 *   labelled with the semantic graph path behind each physical link.
 *
 * Nothing is synthesized: missing evidence produces an explicit English note,
 * never a guessed row.
 */
import {
  type CartCaseId,
  type CartCaseTelemetry,
  type CartGraph,
  type CartTrafficClass,
} from '../index';
import type { ReactNode } from 'react';

import {
  ReportSection,
  ReportTable,
} from '../../features/game-ui';
import { DASH, formatInteger } from '../../ui/format';
import {
  buildCartOutcomeRows,
  cartCaseLabel,
  cartLocationLabel,
  type CartEvidenceView,
  type CartOutcomeRow,
} from './cart-diagnostics';
import {
  CART_TRAFFIC_CLASS_LABELS,
  cartLinkPath,
  cartRegionName,
} from './cart-frames';

const TRACE_EVENT_LIMIT = 60;

export interface CartRequestTimelineProps {
  readonly caseId: CartCaseId;
  readonly graph: CartGraph;
  readonly telemetry?: CartCaseTelemetry;
  readonly evidence?: CartEvidenceView;
  readonly onFocusNode?: (nodeId: string) => void;
  readonly onFocusEdge?: (edgeId: string) => void;
}

function milliseconds(value: number): string {
  return `${value.toFixed(value >= 100 ? 0 : 1)} ms`;
}

function locationCell(
  row: CartOutcomeRow,
  props: CartRequestTimelineProps,
): ReactNode {
  if (row.nodeIds.length === 0) return DASH;
  return (
    <span className="cart-report__chips">
      {row.nodeIds.map((nodeId) => (
        <Button
          key={nodeId}
          type="button"
          onClick={() => props.onFocusNode?.(nodeId)}
          disabled={props.onFocusNode === undefined}
          aria-label={`Focus ${cartLocationLabel(props.graph, nodeId)} for ${row.recordId}`}
        >
          {cartLocationLabel(props.graph, nodeId)}
        </Button>
      ))}
      {row.edgeIds.map((edgeId) => (
        <Button key={edgeId} type="button" disabled={props.onFocusEdge === undefined}
          onClick={() => props.onFocusEdge?.(edgeId)} aria-label={`Focus edge ${edgeId} for ${row.recordId}`}>
          {edgeId}
        </Button>
      ))}
    </span>
  );
}

function outcomeClassCell(row: CartOutcomeRow): ReactNode {
  const business = row.outcomeClass === 'out-of-stock';
  const degraded =
    row.outcomeClass === 'unavailable' ||
    row.outcomeClass === 'partial-cart' ||
    row.outcomeClass === 'lost-reply-after-commit' ||
    row.outcomeClass === 'timeout';
  return (
    <span
      className={business ? 'is-fail' : degraded ? 'is-warn' : 'is-pass'}
      title={row.explanation}
      data-cart-outcome={row.outcomeClass}
    >
      {row.label}
    </span>
  );
}

function RequestTable(props: CartRequestTimelineProps) {
  const rows = buildCartOutcomeRows(props.graph, props.evidence!);
  return (
    <ReportTable
      rowHeaderLabel="Request"
      caption={`Executed requests · ${cartCaseLabel(props.caseId)}`}
      ariaLabel="Executed cart requests"
      minWidthPx={1080}
      columns={[
        { key: 'offered', label: 'Offered' },
        { key: 'scope', label: 'Operation / region' },
        { key: 'outcome', label: 'Business outcome' },
        { key: 'delivered', label: 'Delivered' },
        { key: 'duration', label: 'Duration' },
        { key: 'retry', label: 'Retries · queue wait' },
        { key: 'path', label: 'Graph path' },
        { key: 'evidence', label: 'Step details' },
      ]}
      rows={rows.map((row) => ({
        key: row.key,
        header: row.recordId,
        cells: [
          milliseconds(row.offeredMs),
          `${row.operation} · ${cartRegionName(row.region)}`,
          outcomeClassCell(row),
          row.deliveredMs === null ? 'no terminal reply' : milliseconds(row.deliveredMs),
          row.durationMs === null ? DASH : milliseconds(row.durationMs),
          `${formatInteger(row.retryAttempts)} · ${milliseconds(row.waitingMs)}`,
          locationCell(row, props),
          <details>
            <summary>{row.explanation}</summary>
            <ul>
              {props.evidence!.transfers.filter((transfer) => transfer.logicalId.startsWith(`${row.recordId}:`)).map((transfer) => (
                <li key={transfer.id}>
                  {transfer.logicalId}: {transfer.status}; enqueued {milliseconds(transfer.enqueuedAtUs / 1_000)};
                  {' '}{transfer.deliveredAtUs === null ? 'not delivered' : `delivered ${milliseconds(transfer.deliveredAtUs / 1_000)}`};
                  {' '}{formatInteger(transfer.serializedBytes)} serialized bytes.
                  <ul>{transfer.stages.map((stage, index) => (
                    <li key={index}>{stage.link.id}: {stage.state}; start {stage.startedUs === null ? DASH : milliseconds(stage.startedUs / 1_000)};
                      {' '}end {stage.completedUs === null ? DASH : milliseconds(stage.completedUs / 1_000)}.</li>
                  ))}</ul>
                </li>
              ))}
            </ul>
          </details>,
        ],
      }))}
      note="A durable commit without an acknowledgement is shown as a lost reply after commit, never as unavailable or OutOfStock. A partial cart never counts as a complete read."
    />
  );
}

function tracePathLabel(linkId: string, graph: CartGraph): string {
  return cartLinkPath(linkId, graph).label;
}

function TraceTable(props: CartRequestTimelineProps) {
  const trace = props.telemetry?.trace;
  if (trace === undefined) return null;
  const events = [...trace.events]
    .slice(0, TRACE_EVENT_LIMIT)
    .map((event, index) => ({ event, index }));
  return (
    <>
      <ReportTable
        rowHeaderLabel="Exchange"
        caption={`Representative physical trace · ${cartCaseLabel(props.caseId)}`}
        ariaLabel="Representative physical trace"
        minWidthPx={960}
        columns={[
          { key: 'at', label: 'Time' },
          { key: 'class', label: 'Class' },
          { key: 'status', label: 'Status' },
          { key: 'path', label: 'Physical link → graph path' },
          { key: 'bytes', label: 'Bytes' },
          { key: 'focus', label: 'Focus' },
        ]}
        rows={events.map(({ event, index }) => {
          const path = cartLinkPath(event.linkId, props.graph);
          return {
            key: `${event.logicalId}-${event.atUs}-${index}`,
            header: event.logicalId,
            cells: [
              milliseconds(event.atUs / 1_000),
              CART_TRAFFIC_CLASS_LABELS[event.trafficClass as CartTrafficClass] ??
                event.trafficClass,
              event.status,
              tracePathLabel(event.linkId, props.graph),
              formatInteger(event.bytes),
              path.nodeIds[0] === undefined ? (
                DASH
              ) : (
                <Button
                  type="button"
                  onClick={() => props.onFocusNode?.(path.nodeIds[0]!)}
                  disabled={props.onFocusNode === undefined}
                  aria-label={`Focus ${cartLocationLabel(props.graph, path.nodeIds[0]!)} on the trace`}
                >
                  {cartLocationLabel(props.graph, path.nodeIds[0]!)}
                </Button>
              ),
            ],
          };
        })}
        note={
          trace.truncated || trace.events.length > TRACE_EVENT_LIMIT
            ? `Showing ${events.length} of ${trace.totalEvents} physical events; failed and retried exchanges are kept first. Digest ${trace.digest.slice(0, 12)}…`
            : `${trace.totalEvents} physical events retained; digest ${trace.digest.slice(0, 12)}…`
        }
      />
    </>
  );
}

export function CartRequestTimeline(props: CartRequestTimelineProps) {
  const hasEvidence = props.evidence !== undefined;
  const hasTrace = (props.telemetry?.trace.events.length ?? 0) > 0;
  return (
    <ReportSection
      title={`Request timeline · ${cartCaseLabel(props.caseId)}`}
      description="Offered requests and physical exchanges in offer order. Slow edits show their delivered time and queue waiting; every row can point back to the graph path that carried it."
      note="Times are simulated time shown in milliseconds. An empty timeline stays empty; the view never invents a milestone."
    >
      {hasEvidence ? (
        <RequestTable {...props} />
      ) : (
        <p className="game-report-section__note">
          No executed request records are attached for this scenario, so no
          per-request path is claimed. Checks still carry measured and required
          values.
        </p>
      )}
      {hasTrace ? (
        <TraceTable {...props} />
      ) : (
        <p className="game-report-section__note">
          No bounded physical trace was captured for this scenario.
        </p>
      )}
    </ReportSection>
  );
}
