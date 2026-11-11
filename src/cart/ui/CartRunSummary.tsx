import type { CartCaseResult, CartGraph } from '../index';
import { ReportSection, ReportTable } from '../../features/game-ui';
import { DASH, formatDecimal, formatInteger } from '../../ui/format';
import {
  CART_BOTTLENECK_WAIT_MS,
  cartBusyLabel,
  cartCircuitLabel,
  cartComponentLabel,
  cartCpuBusyShare,
  cartDiskBusyShare,
  cartWanLinks,
  cartWaitLabel,
} from './cart-bottleneck';

/** Traffic window length in seconds; in-flight requests may finish after it. */
const TRAFFIC_SECONDS = 101;

const OPERATION_COLUMNS = [
  'Launched',
  'Success',
  'Business responses',
  'Errors',
  'Timeouts',
  'In flight',
  'p50',
  'p95',
  'p99',
  'Latency samples',
] as const;

/** Load columns, always shown. */
const LOAD_COLUMNS = [
  'CPU busy',
  'Longest CPU wait',
  'Disk busy',
  'Longest disk wait',
  'Refused',
] as const;

/** Stopped-run columns, shown only when the scenario did not finish. */
const STOPPED_COLUMNS = ['Tasks waiting at stop', 'Transactions waiting at stop'] as const;

const STORAGE_COLUMNS = ['Memory used / capacity', 'Stored / capacity'] as const;

/** Circuit-usage columns after the row header (Circuit). */
const CIRCUIT_COLUMNS = ['Speed', 'Busy', 'Longest wait', 'Average wait', 'Messages'] as const;

function hot(text: string, isHot: boolean) {
  return isHot ? <span className="cart-load--hot">{text}</span> : text;
}

export function CartRunSummary({ result, graph }: { result: CartCaseResult; graph: CartGraph }) {
  const snapshot = result.observation;
  if (!snapshot) return <p>No request or component measurements are available for this scenario yet.</p>;
  const sum = (key: 'launched' | 'completed' | 'errors' | 'pending') => snapshot.operations.reduce((n, row) => n + row[key], 0);
  const latency = (value: number | null) => value === null ? 'No samples' : `${formatDecimal(value, 1)} ms`;
  const mib = (value: number) => `${formatDecimal(value / 1048576, 2)} MiB`;
  const seconds = formatDecimal(snapshot.elapsedMs / 1000, 2);
  const description = result.complete
    ? `Completed scenario · ${seconds} s simulated (${TRAFFIC_SECONDS} s of traffic plus time for in-flight requests to finish).`
    : `Stopped at ${seconds} s of simulation.`;
  const circuits = cartWanLinks(snapshot);
  const columns = [
    ...LOAD_COLUMNS,
    ...(result.complete ? [] : STOPPED_COLUMNS),
    ...STORAGE_COLUMNS,
  ];
  return <>
    <ReportSection title="Run snapshot" description={description}>
      <div className="cart-run-summary">
        {(['launched', 'completed', 'errors', 'pending'] as const).map(key => <div key={key} className={key === 'errors' && sum(key) > 0 ? 'has-problems' : ''}><span>{key === 'pending' ? 'In flight at stop' : key === 'errors' ? 'Request problems' : key === 'completed' ? 'Finished requests' : 'Launched requests'}</span><strong>{formatInteger(sum(key))}</strong></div>)}
      </div>
      <ReportTable className="cart-table--numeric" caption="Requests by operation" rowHeaderLabel="Operation"
        columns={OPERATION_COLUMNS.map(label => ({ key: label, label }))}
        rows={snapshot.operations.map(row => ({ key: row.operation, header: row.operation,
          cells: [formatInteger(row.launched), formatInteger(row.successful), formatInteger(row.business), formatInteger(row.errors), formatInteger(row.timeouts), formatInteger(row.pending), latency(row.p50Ms), latency(row.p95Ms), latency(row.p99Ms), formatInteger(row.samples)] }))} />
      <p className="cart-report__note">Timeouts are included in errors. Business responses (such as out of stock) are separate. Latency uses successful replies only; in-flight requests are excluded.{result.complete ? '' : ' Partial percentiles are observations, not final results.'}</p>
    </ReportSection>
    <ReportSection title="Component resources" description="Snapshot at the same stopping boundary. Memory and storage are current values.">
      <ReportTable className="cart-table--numeric" caption="Resource usage by component" rowHeaderLabel="Component"
        columns={columns.map(label => ({ key: label, label }))}
        rows={snapshot.nodes.map(row => {
          const load = row.load;
          const busyCpu = load ? cartCpuBusyShare(load, snapshot.elapsedMs) : null;
          const busyDisk = load ? cartDiskBusyShare(load, snapshot.elapsedMs) : null;
          const loadCells = load === undefined
            ? [DASH, DASH, DASH, DASH, DASH]
            : [
                busyCpu === null ? DASH : cartBusyLabel(busyCpu),
                hot(cartWaitLabel(load.cpuWaitMaxMs), load.cpuWaitMaxMs >= CART_BOTTLENECK_WAIT_MS),
                load.ioTasks === 0 || busyDisk === null ? DASH : cartBusyLabel(busyDisk),
                load.ioTasks === 0 ? DASH : hot(cartWaitLabel(load.ioWaitMaxMs), load.ioWaitMaxMs >= CART_BOTTLENECK_WAIT_MS),
                hot(formatInteger(load.cpuRejected), load.cpuRejected > 0),
              ];
          const stoppedCells = result.complete
            ? []
            : [formatInteger(row.pendingTasks), formatInteger(row.transactionQueue)];
          const storageCells = [
            <span key="memory">{mib(row.ramBytes)} / {mib(row.ramCapacityBytes)}<progress aria-label={`Memory usage ${row.nodeId}`} value={row.ramBytes} max={row.ramCapacityBytes} /></span>,
            row.storageCapacityBytes ? `${mib(row.storedBytes)} / ${mib(row.storageCapacityBytes)}` : 'Not applicable',
          ];
          return { key: row.nodeId, header: cartComponentLabel(graph, row.nodeId),
            cells: [...loadCells, ...stoppedCells, ...storageCells] };
        })} />
      <p className="cart-report__note">Busy and wait values cover the whole run, so a 40-second rush can overload a component whose average looks moderate — the longest wait shows it.{result.complete ? '' : ' Tasks waiting at stop include queued and in-service work. Transactions waiting at stop count requests waiting for the Inventory lock.'}</p>
      {circuits.length > 0 ? <>
        <p className="cart-report__note">Each direction of a circuit has its own queue. Slower circuits also take longer to send every message.</p>
        <ReportTable className="cart-table--numeric" caption="Circuit usage" ariaLabel="Circuit usage" rowHeaderLabel="Circuit"
          columns={CIRCUIT_COLUMNS.map(label => ({ key: label, label }))}
          rows={circuits.map(link => {
            const waitMax = link.waitMaxMs;
            return { key: link.id, header: cartCircuitLabel(link) ?? link.id,
              cells: [
                `${link.mbps} Mbit/s`,
                snapshot.elapsedMs > 0 ? cartBusyLabel(link.busyMs / snapshot.elapsedMs) : DASH,
                hot(cartWaitLabel(waitMax), waitMax >= CART_BOTTLENECK_WAIT_MS),
                cartWaitLabel(link.waitAvgMs),
                formatInteger(link.jobs),
              ] };
          })} />
      </> : null}
    </ReportSection>
  </>;
}
