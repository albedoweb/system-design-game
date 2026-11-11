import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  CART_ADVANCED_REQUIRED_CASES,
  type CartCaseId,
  type CartCaseResult,
  type CartEvaluation,
  type CartGate,
  type CartGraph,
  type CartTelemetryCapture,
} from '../index';
import { CartResultsPanel } from './CartResultsPanel';
import {
  buildCartGateViews,
  buildCartOutcomeRows,
  cartCaseLabel,
  cartGateLimitLabel,
  cartGateMeasuredLabel,
  cartGateTitle,
  cartLatencyLabel,
  cartRankingEligible,
} from './cart-diagnostics';

const APP_US = 'app-us';
const STORE_EU = 'store-eu';
const STORE_US = 'store-us';

function graph(): CartGraph {
  return {
    levelId: 'global-cart',
    graphVersion: 'cart-graph-v1',
    contentVersion: 'cart-content-v1',
    seed: 1729,
    nodes: [
      { id: 'src-us', kind: 'customers', region: 'us-west', position: { x: 0, y: 0 } },
      { id: 'src-eu', kind: 'customers', region: 'eu-central', position: { x: 0, y: 1 } },
      { id: 'src-ap', kind: 'customers', region: 'ap-northeast', position: { x: 0, y: 2 } },
      {
        id: APP_US,
        kind: 'application',
        region: 'us-west',
        position: { x: 1, y: 0 },
        label: 'Cart API (US)',
        size: 'S',
        instances: 1,
        writeTarget: STORE_US,
        readPolicy: 'local-repair',
        readTargets: [STORE_US],
      },
      {
        id: STORE_US,
        kind: 'store',
        region: 'us-west',
        position: { x: 2, y: 0 },
        label: 'Cart Store (US)',
        size: 'S',
      },
      {
        id: STORE_EU,
        kind: 'store',
        region: 'eu-central',
        position: { x: 2, y: 1 },
        label: 'Cart Store (EU)',
        size: 'S',
      },
    ],
    edges: [
      { id: 'edge-src-app', from: 'src-us', to: APP_US, kind: 'request' },
      { id: 'edge-app-store-eu', from: APP_US, to: STORE_EU, kind: 'replication' },
    ],
    circuits: [{ regions: ['us-west', 'eu-central'], mbps: 1 }],
  } as unknown as CartGraph;
}

function gate(overrides: Partial<CartGate> & Pick<CartGate, 'code' | 'caseId'>): CartGate {
  return {
    region: 'us-west',
    operation: 'edit',
    cohort: 'local-context-edit:us-west:edit',
    observed: 0.95,
    limit: 0.99,
    pass: false,
    evidenceIds: ['req-slow'],
    ...overrides,
  };
}

function caseResult(
  caseId: CartCaseId,
  gates: CartGate[],
  complete = true,
): CartCaseResult {
  return {
    id: caseId,
    scheduled: 100,
    issued: 100,
    dependencyFailed: 0,
    outcomes: { committed: 100 },
    gates,
    resources: {
      events: 10,
      requests: 100,
      chargedBusyMs: 12.5,
      wanBillableBytes: 2_048,
    },
    cost: {
      rentalPerHour: 1.5,
      wanCredits: 0.000002,
      preparationSeconds: 0,
      drainSeconds: 4,
      windowSeconds: 90,
      peakScoreCreditsPerHour: 1.61,
    },
    complete,
  };
}

function evaluation(options: {
  readonly failing: boolean;
  readonly complete?: boolean;
  readonly qualified?: boolean;
}): CartEvaluation {
  const cases = CART_ADVANCED_REQUIRED_CASES.map((caseId) =>
    caseResult(
      caseId,
      options.failing
        ? [
            gate({
              code: 'healthy-slo-edit-us-west',
              caseId,
              evidenceIds: ['req-slow'],
            }),
            gate({
              code: 'healthy-slo-read-ap-northeast',
              caseId,
              region: 'ap-northeast',
              operation: 'read',
              cohort: 'healthy:ap-northeast:read',
              observed: 0.5,
              evidenceIds: ['req-stale'],
            }),
            gate({
              code: 'safety-audit',
              caseId,
              operation: 'audit',
              cohort: 'all-requests',
              observed: 100,
              limit: 100,
              pass: true,
              evidenceIds: [],
            }),
          ]
        : [
            gate({
              code: 'healthy-slo-edit-us-west',
              caseId,
              observed: 1,
              limit: 1,
              pass: true,
            }),
            gate({
              code: 'safety-audit',
              caseId,
              operation: 'audit',
              cohort: 'all-requests',
              observed: 100,
              limit: 100,
              pass: true,
              evidenceIds: [],
            }),
          ],
      options.complete ?? true,
    ),
  );
  const complete = options.complete ?? true;
  const qualified = options.qualified ?? !options.failing;
  return {
    levelId: 'global-cart',
    versions: {
      graph: 'cart-graph-v1',
      model: 'cart-model-v1',
      content: 'cart-content-v1',
      pricing: 'cart-pricing-v1',
      profile: 'cart-profile-v1',
      result: 'cart-result-v1',
      protocol: 'cart-protocol-v1',
    },
    graphDigest: 'a'.repeat(64),
    seed: 1729,
    requiredCases: [...CART_ADVANCED_REQUIRED_CASES],
    cases,
    complete,
    qualified,
    scoreCreditsPerHour: qualified && complete ? 1.61 : null,
    issues: [],
    traceHash: 'b'.repeat(64),
  } as unknown as CartEvaluation;
}

type TestNode = NonNullable<NonNullable<CartCaseResult['observation']>['nodes']>[number];

/** Attaches a measured run observation to every scenario of an evaluation. */
function withObservation(
  result: CartEvaluation,
  nodes: readonly TestNode[],
  elapsedMs = 40_000,
): CartEvaluation {
  return {
    ...result,
    cases: result.cases.map((item) => ({
      ...item,
      observation: { elapsedMs, operations: [], nodes: [...nodes] },
    })),
  };
}

const IDLE_LOAD = {
  cpuLanes: 4, cpuTasks: 0, cpuBusyMs: 0, cpuWaitAvgMs: 0, cpuWaitMaxMs: 0, cpuRejected: 0,
  ioTasks: 0, ioBusyMs: 0, ioWaitAvgMs: 0, ioWaitMaxMs: 0,
};

const EU_STORE_NODE: TestNode = {
  nodeId: STORE_EU, cpuMs: 0, ramBytes: 1_048_576, ramCapacityBytes: 8_388_608, pendingTasks: 0, transactionQueue: 0,
  ioUnits: 0, storedBytes: 0, storageCapacityBytes: 1_048_576,
  load: { ...IDLE_LOAD, ioTasks: 40, ioBusyMs: 25_200, ioWaitAvgMs: 197.5, ioWaitMaxMs: 543.1 },
};

function transfer(
  id: number,
  logicalId: string,
  options: {
    readonly waitingMs?: number;
    readonly from?: CartTelemetryCapture['transfers'][number]['from'];
    readonly to?: CartTelemetryCapture['transfers'][number]['to'];
  } = {},
): CartTelemetryCapture['transfers'][number] {
  const waitingUs = (options.waitingMs ?? 0) * 1_000;
  return {
    id,
    logicalId,
    purpose: 'request',
    from: options.from ?? { kind: 'client', region: 'us-west', clientId: 'client-us' },
    to: options.to ?? { kind: 'node', nodeId: APP_US },
    bytes: 512,
    stages: [
      {
        link: {
          id: `nic:${APP_US}:0:ingress`,
          kind: 'nic',
          bitsPerSecond: 100_000_000,
          waitingByteLimit: 256 * 1024,
          direction: 'ingress',
        },
        state: 'done',
        startedUs: 1_000 + waitingUs,
        completedUs: 2_000 + waitingUs,
        serializedUs: 1_000,
      },
    ],
    propagationUs: 0,
    pathKind: 'client',
    wanPair: null,
    enqueuedAtUs: 1_000,
    deadlineUs: 1_000_000,
    status: 'delivered',
    cancelReason: null,
    cancelledAtUs: null,
    deliveredAtUs: 2_000 + waitingUs,
    billedWanBytes: 0,
    serializedBytes: 512,
  } as unknown as CartTelemetryCapture['transfers'][number];
}

function record(
  id: string,
  overrides: Partial<CartTelemetryCapture['records'][number]> & {
    readonly operation: 'edit' | 'read' | 'checkout';
    readonly outcome: 'committed' | 'out-of-stock' | 'unavailable' | 'timeout';
  },
): CartTelemetryCapture['records'][number] {
  return {
    caseId: 'checkout',
    cartId: 'cart-1',
    region: 'us-west',
    cohort: 'healthy',
    offeredUs: 10_000,
    deadlineUs: 1_010_000,
    deliveredUs: 12_000,
    committed: true,
    acknowledged: true,
    unresolved: false,
    rejected: false,
    dependencyFailed: false,
    exempt: false,
    deliveryUs: 12_000,
    evidenceIds: [],
    ...overrides,
    id,
  } as unknown as CartTelemetryCapture['records'][number];
}

function evidence(): CartTelemetryCapture {
  const records: CartTelemetryCapture['records'] = [
    record('req-slow', {
      operation: 'edit',
      outcome: 'committed',
      offeredUs: 10_000,
      deliveredUs: 910_000,
      deliveryUs: 910_000,
    }),
    record('req-unavailable', {
      operation: 'read',
      outcome: 'unavailable',
      deliveredUs: 320_000,
      committed: false,
    }),
    record('req-stock', {
      operation: 'checkout',
      outcome: 'out-of-stock',
      offeredUs: 30_000,
    }),
    record('req-unavailable-terminal', {
      operation: 'checkout',
      outcome: 'unavailable',
      offeredUs: 35_000,
    }),
    record('req-lost', {
      operation: 'checkout',
      outcome: 'committed',
      offeredUs: 40_000,
      committed: true,
      acknowledged: false,
      unresolved: true,
      deliveryUs: null,
      deliveredUs: null,
      evidenceIds: ['op-commit-1'],
    }),
  ];
  const transfers: CartTelemetryCapture['transfers'] = [
    transfer(1, 'req-slow:in:0', { waitingMs: 400 }),
    transfer(2, 'req-stock:in:0'),
    transfer(3, 'req-lost:commit:0', {
      from: { kind: 'node', nodeId: APP_US },
      to: { kind: 'node', nodeId: STORE_EU },
    }),
  ];
  const readResults = new Map<string, CartTelemetryCapture['readResults'] extends ReadonlyMap<string, infer T> ? T : never>();
  readResults.set('req-unavailable', {
    kind: 'partial',
    cartId: 'cart-1',
    reason: 'missing-origin-evidence',
    view: {},
    incomingToken: {},
    outgoingToken: {},
    coveredIds: [],
    missingTokenIds: ['op-slow'],
    evidence: {},
    attempts: [],
    charge: {},
    dataSources: [],
  } as never);
  return {
    caseId: 'checkout',
    result: caseResult('checkout', [], true),
    records,
    transfers,
    readResults,
    facts: {
      qualified: true,
      authorityByRegion: { 'us-west': APP_US, 'eu-central': null, 'ap-northeast': null },
      durableByRegion: { 'us-west': STORE_US, 'eu-central': null, 'ap-northeast': null },
      inventoryNodeId: null,
      inventoryRegion: null,
      regionLinks: [],
      issues: [],
    },
    frames: [],
    totals: {
      serializedBytes: 0,
      wanBillableBytes: 0,
      localSerializedBytes: 0,
      byClass: { request: 0, reply: 0, replication: 0, repair: 0, retry: 0 },
      byCircuit: [],
      byteEvents: 0,
      transfers: 0,
    },
    trace: {
      caseId: 'checkout',
      events: [],
      totalEvents: 0,
      retainedEvents: 0,
      truncated: false,
      digest: 'c'.repeat(64),
    },
    windowCount: 0,
    issues: [],
  };
}

function telemetry(): CartTelemetryCapture {
  return {
    ...evidence(),
    levelId: 'global-cart',
    complete: true,
    measuredEndUs: 1_000_000,
    frames: [
      {
        levelId: 'global-cart',
        caseId: 'checkout',
        index: 0,
        windowStartUs: 0,
        windowEndUs: 1_000_000,
        windowUs: 1_000_000,
        phase: 'measured',
        bytes: { request: 500_000, reply: 500_000, replication: 1_000_000, repair: 0, retry: 0 },
        serializedBytes: 2_000_000,
        wanBillableBytes: 2_000_000,
        nodes: [
          {
            id: APP_US,
            role: 'node',
            region: null,
            bytes: 1_000_000,
            byClass: { request: 500_000, reply: 500_000, replication: 0, repair: 0, retry: 0 },
          },
          {
            id: STORE_EU,
            role: 'node',
            region: null,
            bytes: 1_000_000,
            byClass: { request: 0, reply: 0, replication: 1_000_000, repair: 0, retry: 0 },
          },
        ],
        links: [
          { linkId: 'wan:us-west|eu-central:forward', kind: 'wan', bytes: 2_000_000 },
        ],
        circuits: [{ pair: 'us-west|eu-central', direction: 'forward', bytes: 2_000_000 }],
        sampled: false,
      },
    ],
    totals: {
      serializedBytes: 2_000_000,
      wanBillableBytes: 2_000_000,
      localSerializedBytes: 0,
      byClass: { request: 500_000, reply: 500_000, replication: 1_000_000, repair: 0, retry: 0 },
      byCircuit: [{ pair: 'us-west|eu-central', direction: 'forward', bytes: 2_000_000 }],
      byteEvents: 10,
      transfers: 3,
    },
    trace: {
      caseId: 'checkout',
      events: [
        {
          atUs: 2_500_000,
          phase: 'measured',
          trafficClass: 'replication',
          logicalId: 'req-lost:commit:0',
          linkId: 'wan:us-west|eu-central:forward',
          linkKind: 'wan',
          bytes: 2_000_000,
          status: 'delivered',
        },
      ],
      totalEvents: 1,
      retainedEvents: 1,
      truncated: false,
      digest: 'c'.repeat(64),
    },
    windowCount: 1,
  } as unknown as CartTelemetryCapture;
}

describe('CartResultsPanel', () => {
  it('shows the exact final cost text when matchMedia is unavailable (no count-up)', () => {
    const original = window.matchMedia;
    Reflect.deleteProperty(window, 'matchMedia');
    try {
      render(<CartResultsPanel graph={graph()} evaluation={evaluation({ failing: false })} />);
      expect(screen.getByTestId('cart-cost-ranking').textContent).toBe('1.61 credits/hour');
    } finally {
      window.matchMedia = original;
    }
  });

  it('withholds the cost ranking until every required gate passes', () => {
    const { rerender } = render(
      <CartResultsPanel graph={graph()} evaluation={evaluation({ failing: true })} />,
    );
    expect(screen.getByTestId('cart-cost-withheld')).toBeInTheDocument();
    expect(screen.queryByTestId('cart-cost-ranking')).toBeNull();
    expect(screen.getByText(/No score: only a design that passes both scenarios/)).toBeInTheDocument();

    rerender(<CartResultsPanel graph={graph()} evaluation={evaluation({ failing: false })} />);
    expect(screen.getByRole('heading', { name: 'Passed' })).toBeInTheDocument();
    expect(screen.getByTestId('cart-cost-ranking')).toHaveTextContent('1.61 credits/hour');
    expect(screen.queryByTestId('cart-cost-withheld')).toBeNull();
  });

  it.each([
    'failing gate',
    'missing case',
    'empty case gates',
    'no gate evidence',
    'incomplete case',
  ])('does not claim every case passed with qualified=true and %s', (scenario) => {
    const passing = evaluation({ failing: false, qualified: true });
    const result: CartEvaluation = scenario === 'failing gate'
      ? evaluation({ failing: true, qualified: true })
      : {
          ...passing,
          cases: scenario === 'missing case'
            ? passing.cases.slice(1)
            : passing.cases.map((item, index) => {
                if (scenario === 'no gate evidence') return { ...item, gates: [] };
                if (index !== 0) return item;
                return scenario === 'incomplete case'
                  ? { ...item, complete: false }
                  : { ...item, gates: [] };
              }),
        };

    render(<CartResultsPanel graph={graph()} evaluation={result} />);

    expect(screen.getByRole('heading', { name: 'Not passed' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Passed' })).toBeNull();
    expect(screen.getByTestId('cart-cost-withheld')).toBeInTheDocument();
    expect(screen.queryByTestId('cart-cost-ranking')).toBeNull();
  });

  it('rejects inconsistent ranking flags, missing cases, empty gates and incomplete cases', () => {
    expect(cartRankingEligible(evaluation({ failing: true, qualified: true }))).toBe(false);
    const passing = evaluation({ failing: false });
    expect(cartRankingEligible({ ...passing, cases: passing.cases.slice(1) })).toBe(false);
    expect(cartRankingEligible({ ...passing, cases: passing.cases.map((item, index) => index === 0 ? { ...item, gates: [] } : item) })).toBe(false);
    expect(cartRankingEligible({ ...passing, cases: passing.cases.map((item, index) => index === 0 ? { ...item, complete: false } : item) })).toBe(false);
    expect(cartRankingEligible({ ...passing, scoreCreditsPerHour: Number.NaN })).toBe(false);
  });

  it('links only observed request endpoints and edges, not unused neighboring stores', () => {
    const rows = buildCartOutcomeRows(graph(), evidence());
    const slow = rows.find((row) => row.recordId === 'req-slow')!;
    expect(slow.nodeIds).toEqual([APP_US, 'src-us']);
    expect(slow.edgeIds).toEqual(['edge-src-app']);
    const lost = rows.find((row) => row.recordId === 'req-lost')!;
    expect(lost.nodeIds).toEqual([APP_US, STORE_EU]);
    expect(lost.edgeIds).toEqual(['edge-app-store-eu']);
    expect(rows.find((row) => row.recordId === 'req-unavailable-terminal')!.nodeIds).toEqual([]);
  });

  it('shows stale-token evidence with its executed path and physical wait stages', async () => {
    const capture = evidence();
    const stale = { ...capture, transfers: [...capture.transfers, transfer(8, 'req-unavailable:lookup:0', {
      from: { kind: 'node', nodeId: APP_US }, to: { kind: 'node', nodeId: STORE_EU },
    })] };
    const onFocusEdge = vi.fn();
    render(<CartResultsPanel graph={graph()} evaluation={evaluation({ failing: true })}
      evidence={{ checkout: stale }} initialCaseId="checkout" onFocusEdge={onFocusEdge} />);
    expect(screen.getAllByText(/Missing token operations: op-slow/).length).toBeGreaterThan(0);
    const row = screen.getByText('req-unavailable').closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Focus edge edge-app-store-eu for req-unavailable' }));
    expect(onFocusEdge).toHaveBeenCalledWith('edge-app-store-eu');
    expect(screen.getAllByText(/start 401 ms/).length).toBeGreaterThan(0);
  });

  it('renders recovery gates as counts rather than percentages', () => {
    const result = evaluation({ failing: false });
    const recovery = gate({ code: 'recovery-barrier', caseId: 'partition', observed: 2, limit: 3, pass: false });
    const views = buildCartGateViews({ ...result, cases: [caseResult('partition', [recovery])] }, { graph: graph() });
    expect(views[0]!.measuredLabel).toBe('2');
    expect(views[0]!.limitLabel).toBe('3');
  });

  it('keeps same-code diagnostics scoped to their case and measured cohort', () => {
    const result = evaluation({ failing: true });
    const views = buildCartGateViews(result, { graph: graph(), caseFilter: 'checkout', evidence: new Map([['checkout', evidence()]]) });
    const edit = views.find((view) => view.code === 'healthy-slo-edit-us-west')!;
    expect(edit.diagnostics).toHaveLength(1);
    expect(edit.diagnostics[0]!.caseId).toBe('checkout');
    expect(edit.explanation).toContain('Based on 1 sampled request.');
    expect(edit.explanation).not.toMatch(/case |cohort|evidence request/);
    expect(edit.diagnostics[0]!.locations.edgeIds).toEqual(['edge-src-app']);
  });

  it('shows measured value, limit, case, cohort and English evidence for every gate', () => {
    render(
      <CartResultsPanel
        graph={graph()}
        evaluation={evaluation({ failing: true })}
        initialCaseId="peak"
      />,
    );
    expect(screen.getAllByText('Edit success rate — US West · San Francisco').length).toBeGreaterThan(0);
    expect(screen.getAllByText('95.00%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('99.00%').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/p95 < 50 ms/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Based on 1 sampled request\./).length).toBeGreaterThan(0);
    expect(screen.queryByText(/case peak|cohort|evidence request/)).toBeNull();
  });

  it('keeps OutOfStock, unavailable, partial cart and lost reply after commit distinct', async () => {
    const user = userEvent.setup();
    render(
      <CartResultsPanel
        graph={graph()}
        evaluation={evaluation({ failing: true })}
        evidence={{ checkout: evidence() }}
        initialCaseId="checkout"
      />,
    );
    expect(screen.getAllByText('OutOfStock').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Temporarily unavailable').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Lost reply after commit').length).toBeGreaterThan(0);
    // A partial read is classified from the read outcome, not from the record.
    expect(screen.getAllByText('Partial cart').length).toBeGreaterThan(0);
    const rows = screen.getByLabelText('Cart outcome classes');
    expect(within(rows).getByText('OutOfStock')).toBeInTheDocument();
    expect(within(rows).getByText('Lost reply after commit')).toBeInTheDocument();
    expect(within(rows).queryByText('Temporarily unavailable')).not.toBeNull();
    await user.click(screen.getByRole('tab', { name: /Normal shopping/ }));
    expect(screen.getByText(/No executed records are attached/)).toBeInTheDocument();
  });

  it('traces a slow edit and a stock rejection back to the graph path', async () => {
    const onFocusNode = vi.fn();
    const user = userEvent.setup();
    render(
      <CartResultsPanel
        graph={graph()}
        evaluation={evaluation({ failing: true })}
        evidence={{ checkout: evidence() }}
        initialCaseId="checkout"
        onFocusNode={onFocusNode}
      />,
    );
    expect(screen.getByText('req-slow')).toBeInTheDocument();
    expect(screen.getAllByText('910 ms').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/0 · 400 ms/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('req-stock').length).toBeGreaterThan(0);
    const focus = screen.getByRole('button', {
      name: `Focus Cart API (US) for req-stock`,
    });
    await user.click(focus);
    expect(onFocusNode).toHaveBeenCalledWith(APP_US);
  });

  it('shows a saturated link with capacity and the semantic network/semantic edges', () => {
    render(
      <CartResultsPanel
        graph={graph()}
        evaluation={evaluation({ failing: true })}
        telemetry={{ checkout: telemetry() as unknown as import('../index').CartCaseTelemetry }}
        initialCaseId="checkout"
      />,
    );
    expect(screen.getByLabelText('Physical link utilization')).toBeInTheDocument();
    expect(screen.getAllByText(/1 Mbit\/s/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('1,600.00%').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1 circuit at or above 80%/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Cart API \(US\) ↔ Cart Store \(EU\) WAN/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Focus .* WAN · forward edge/ })).toBeInTheDocument();
    expect(screen.getByText(/so they may miss short peaks/)).toBeInTheDocument();
  });

  it('renders the representative trace with its digest and no invented rows', () => {
    render(
      <CartResultsPanel
        graph={graph()}
        evaluation={evaluation({ failing: true })}
        telemetry={{ checkout: telemetry() as unknown as import('../index').CartCaseTelemetry }}
        initialCaseId="checkout"
      />,
    );
    expect(screen.getByLabelText('Representative physical trace')).toBeInTheDocument();
    expect(screen.getByText(/digest cccccccccccc/)).toBeInTheDocument();
    expect(screen.getByText('req-lost:commit:0')).toBeInTheDocument();
  });

  it('shows a passing verdict banner with the Shopping Rush cost and budget', () => {
    const { container } = render(<CartResultsPanel graph={graph()} evaluation={evaluation({ failing: false })} />);
    const banner = container.querySelector('section.cart-verdict--pass')!;
    expect(banner).not.toBeNull();
    expect(within(banner as HTMLElement).getByRole('heading', { name: 'Passed' })).toBeInTheDocument();
    expect(within(banner as HTMLElement).getByText('Both scenarios meet every requirement.')).toBeInTheDocument();
    expect(within(banner as HTMLElement).getByTestId('cart-cost-ranking').textContent).toBe('1.61 credits/hour');
    expect(within(banner as HTMLElement).getByText(/Shopping Rush cost · budget 6 credits\/hour · lower is better/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'What failed' })).toBeNull();
  });

  it('lists failed checks under What failed and names the failing scenarios in the verdict', () => {
    render(<CartResultsPanel graph={graph()} evaluation={evaluation({ failing: true })} />);
    expect(screen.getByRole('heading', { name: 'Not passed' })).toBeInTheDocument();
    expect(screen.getByText(/checks failed in Normal shopping and Shopping Rush/)).toBeInTheDocument();
    expect(screen.getByText('No score: only a design that passes both scenarios is ranked by cost.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What failed' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Shopping Rush · failed checks' })).toBeInTheDocument();
    expect(screen.getByText(/Show \d+ passed checks/)).toBeInTheDocument();
    expect(screen.getByText('Run details')).toBeInTheDocument();
  });

  it('shows a partial report banner with no final score when the run stopped', () => {
    render(<CartResultsPanel graph={graph()} evaluation={evaluation({ failing: true, complete: false })} />);
    expect(screen.getByRole('heading', { name: 'Partial report' })).toBeInTheDocument();
    expect(screen.getByText(/Run stopped early — partial measurements only, no final score\./)).toBeInTheDocument();
  });

  it('opens the first scenario that did not pass', () => {
    const passing = evaluation({ failing: false });
    const mixed: CartEvaluation = {
      ...passing,
      qualified: false,
      scoreCreditsPerHour: null,
      cases: passing.cases.map((item) => item.id === 'peak'
        ? {
            ...item,
            gates: [gate({ code: 'healthy-slo-edit-us-west', caseId: 'peak', observed: 0.5, limit: 0.99, pass: false, evidenceIds: ['req-slow'] })],
          }
        : item),
    };
    render(<CartResultsPanel graph={graph()} evaluation={mixed} />);
    expect(screen.getByRole('tab', { name: /Shopping Rush · fail/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Normal shopping · pass/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('names the overloaded component in a notice for a failing run', () => {
    const result = withObservation(evaluation({ failing: true }), [EU_STORE_NODE]);
    render(<CartResultsPanel graph={graph()} evaluation={result} />);
    const notice = screen.getByRole('region', { name: 'Overloaded components' });
    expect(within(notice).getAllByText(/Cart Store \(EU\) · EU Central: operations waited up to 543 ms for its disk \(198 ms on average\)\. Its disk was busy 63% of the run\./).length).toBeGreaterThan(0);
    expect(within(notice).getByText('Normal shopping')).toBeInTheDocument();
  });

  it('shows no overloaded-components notice when the observation has no load counters', () => {
    const legacy = withObservation(evaluation({ failing: true }), [{ ...EU_STORE_NODE, load: undefined }]);
    render(<CartResultsPanel graph={graph()} evaluation={legacy} />);
    expect(screen.queryByRole('heading', { name: 'Overloaded components' })).toBeNull();
    const table = screen.getByRole('table', { name: 'Resource usage by component' });
    expect(within(table).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows disk busy share and highlights the hot wait cell in the resources table', () => {
    const result = withObservation(evaluation({ failing: true }), [EU_STORE_NODE]);
    render(<CartResultsPanel graph={graph()} evaluation={result} />);
    const table = screen.getByRole('table', { name: 'Resource usage by component' });
    expect(within(table).getByRole('columnheader', { name: 'Memory used / capacity' })).toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: 'CPU work' })).toBeNull();
    expect(within(table).getByText('63%')).toBeInTheDocument();
    expect(within(table).getByText('543 ms')).toHaveClass('cart-load--hot');
    expect(within(table).queryByRole('columnheader', { name: 'Tasks waiting at stop' })).toBeNull();
  });

  it('lists failed latency checks before success-rate checks', () => {
    const base = evaluation({ failing: true });
    const latency = gate({
      code: 'ordinary-p95-healthy-edit-us-west',
      caseId: 'normal',
      operation: 'edit',
      cohort: 'ordinary-latency:local-context-edit:us-west:edit',
      observed: 900_000,
      limit: 50_000,
      pass: false,
      evidenceIds: [],
    });
    const result: CartEvaluation = {
      ...base,
      cases: base.cases.map((item) => item.id === 'normal'
        ? { ...item, gates: [...item.gates, latency] }
        : item),
    };
    render(<CartResultsPanel graph={graph()} evaluation={result} initialCaseId="normal" />);
    const failedTable = screen.getByRole('table', { name: 'Normal shopping · failed checks' });
    const titles = within(failedTable).getAllByRole('rowheader').map((cell) => cell.textContent ?? '');
    expect(titles.indexOf('Edit latency p95 — US West · San Francisco'))
      .toBeLessThan(titles.indexOf('Edit success rate — US West · San Francisco'));
  });

  it('titles the backlog edit cohort separately from the normal edit success rate', () => {
    const backlog = gate({ code: 'healthy-slo-edit-us-west', caseId: 'peak', cohort: 'healthy:us-west:edit' });
    const normal = gate({ code: 'healthy-slo-edit-us-west', caseId: 'peak' });
    expect(cartGateTitle(backlog)).toBe('Edits that arrived before the previous change was saved — US West · San Francisco');
    expect(cartGateTitle(normal)).toBe('Edit success rate — US West · San Francisco');
    const [view] = buildCartGateViews(
      { ...evaluation({ failing: true }), cases: [caseResult('peak', [backlog])] },
      { graph: graph() },
    );
    expect(view!.explanation).toContain('A small group that appears only when storage is backlogged; see Overloaded components.');
  });

  it('formats latency gates in milliseconds and titles them readably', () => {
    expect(cartLatencyLabel(956_210)).toBe('956.2 ms');
    expect(cartLatencyLabel(500_000)).toBe('500.0 ms');
    const latency = gate({
      code: 'ordinary-p95-healthy-read-ap-northeast',
      caseId: 'peak',
      region: 'ap-northeast',
      operation: 'read',
      cohort: 'ordinary-latency:healthy:ap-northeast:read',
      observed: 956_210,
      limit: 500_000,
      pass: false,
      evidenceIds: [],
    });
    expect(cartGateMeasuredLabel(latency)).toBe('956.2 ms');
    expect(cartGateLimitLabel(latency)).toBe('500.0 ms');
    expect(cartGateTitle(latency)).toBe('Read latency p95 — AP Northeast · Tokyo');
    expect(cartGateTitle({ code: 'latency-samples-healthy-edit-us-west', region: 'us-west', operation: 'edit' }))
      .toBe('Enough latency samples (edit) — US West · San Francisco');
    expect(cartCaseLabel('normal')).toBe('Normal shopping');
    expect(cartCaseLabel('peak')).toBe('Shopping Rush');
  });
});

describe('CartResultsPanel circuits', () => {
  const WAN_LINK = {
    id: 'wan:us-west|eu-central:forward', kind: 'wan' as const, pair: 'us-west|eu-central', direction: 'forward',
    mbps: 2, jobs: 1234, busyMs: 18_960, waitAvgMs: 8.74, waitMaxMs: 95.1,
  };

  function withLinks(result: CartEvaluation, links: NonNullable<NonNullable<CartCaseResult['observation']>['links']>): CartEvaluation {
    return {
      ...result,
      cases: result.cases.map((item) => item.observation
        ? { ...item, observation: { ...item.observation, links: [...links] } }
        : item),
    };
  }

  it('shows the circuit in the notice and in the Circuit usage table', () => {
    const result = withLinks(withObservation(evaluation({ failing: true }), [EU_STORE_NODE]), [WAN_LINK]);
    render(<CartResultsPanel graph={graph()} evaluation={result} />);
    const notice = screen.getByRole('region', { name: 'Overloaded components' });
    expect(within(notice).getAllByText(/Circuit US West → EU Central \(2 Mbit\/s\): messages waited up to 95 ms to be sent/).length).toBeGreaterThan(0);

    const table = screen.getByRole('table', { name: 'Circuit usage' });
    const row = within(table).getByRole('rowheader', { name: 'Circuit US West → EU Central' }).closest('tr')!;
    expect(within(row).getByText('2 Mbit/s')).toBeInTheDocument();
    expect(within(row).getByText('47%')).toBeInTheDocument();
    expect(within(row).getByText('95 ms')).toHaveClass('cart-load--hot');
    expect(within(row).getByText('8.7 ms')).toBeInTheDocument();
    expect(within(row).getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('Each direction of a circuit has its own queue. Slower circuits also take longer to send every message.')).toBeInTheDocument();
  });

  it('shows neither the circuit notice nor the table without links', () => {
    const result = withObservation(evaluation({ failing: true }), [EU_STORE_NODE]);
    render(<CartResultsPanel graph={graph()} evaluation={result} />);
    expect(screen.queryByRole('table', { name: 'Circuit usage' })).toBeNull();
    expect(screen.queryByText(/Circuit US West/)).toBeNull();
  });
});
