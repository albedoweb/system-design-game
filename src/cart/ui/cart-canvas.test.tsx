import { render, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CartGraph } from '../index';
import { CartCanvas } from './CartCanvas';
import { cartCircuitKey } from './cart-meta';
import type { CartHotspots } from './cart-hotspots';

const APP_US = 'app-us';
const STORE_US = 'store-us';
const STORE_EU = 'store-eu';
const STORE_AP = 'store-ap';

function graph(): CartGraph {
  return {
    levelId: 'global-cart',
    graphVersion: 'cart-graph-v1',
    contentVersion: 'cart-content-v1',
    seed: 1729,
    nodes: [
      { id: 'src-us', kind: 'customers', region: 'us-west', position: { x: 0, y: 0 } },
      { id: APP_US, kind: 'application', region: 'us-west', position: { x: 300, y: 0 }, label: 'Cart API (US)', size: 'S', instances: 1, writeTarget: STORE_US, readPolicy: 'local-repair', readTargets: [STORE_US] },
      { id: STORE_US, kind: 'store', region: 'us-west', position: { x: 600, y: 0 }, label: 'Cart Store (US)', size: 'S' },
      { id: STORE_EU, kind: 'store', region: 'eu-central', position: { x: 600, y: 300 }, label: 'Cart Store (EU)', size: 'S' },
      { id: STORE_AP, kind: 'store', region: 'ap-northeast', position: { x: 600, y: 600 }, label: 'Cart Store (AP)', size: 'S' },
    ],
    edges: [
      { id: 'edge-local', kind: 'request', from: APP_US, to: STORE_US },
      { id: 'edge-eu', kind: 'replication', from: STORE_US, to: STORE_EU },
      { id: 'edge-ap', kind: 'replication', from: STORE_US, to: STORE_AP },
    ],
    circuits: [],
  } as unknown as CartGraph;
}

const NO_HOTSPOTS: CartHotspots = { nodes: {}, circuits: {} };

// jsdom has no layout. React Flow draws edges only between measured nodes, so the
// test reports a fixed size through offset* and fires the resize observer once.
const originalResizeObserver = globalThis.ResizeObserver;
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

class MeasuringResizeObserver {
  constructor(private readonly callback: (entries: Array<{ target: Element }>) => void) {}
  observe(target: Element): void {
    // Only node wrappers need a size; other observers keep their own contract.
    if (!target.classList.contains('react-flow__node')) return;
    queueMicrotask(() => this.callback([{ target }]));
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 226 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 120 });
  globalThis.ResizeObserver = MeasuringResizeObserver as unknown as typeof ResizeObserver;
});

afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
  if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
});

function renderCanvas(props: Partial<Parameters<typeof CartCanvas>[0]> = {}) {
  return render(
    <CartCanvas
      graph={graph()}
      selection={null}
      issues={[]}
      onConnectRequest={() => {}}
      hotspots={NO_HOTSPOTS}
      {...props}
    />,
  );
}

describe('CartCanvas live run and hotspots', () => {
  it('marks the canvas root while a run is advancing', () => {
    const { container, unmount } = renderCanvas({ runActive: true });
    expect(container.querySelector('.cart-canvas')).toHaveClass('is-running');
    unmount();

    const idle = renderCanvas({ runActive: false });
    expect(idle.container.querySelector('.cart-canvas')).not.toHaveClass('is-running');
  });

  it('shows a node overload label with role status and the is-hot class', () => {
    const { container } = renderCanvas({
      hotspots: { nodes: { [APP_US]: 'disk wait up to 556 ms' }, circuits: {} },
    });
    const node = container.querySelector(`.react-flow__node[data-id="${APP_US}"] .cart-node`);
    expect(node).toHaveClass('is-hot');
    const status = node?.querySelector('.cart-node__hot');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent('disk wait up to 556 ms');

    const calm = renderCanvas();
    expect(calm.container.querySelector('.cart-node.is-hot')).toBeNull();
    expect(calm.container.querySelector('.cart-node__hot')).toBeNull();
  });

  it('marks only cross-region paths of the hot circuit pair', async () => {
    const { container } = renderCanvas({
      runActive: true,
      hotspots: {
        nodes: {},
        circuits: { [cartCircuitKey('us-west', 'eu-central')]: 'WAN queue up to 900 ms' },
      },
    });
    await waitFor(() => expect(container.querySelectorAll('.react-flow__edge').length).toBeGreaterThan(0));
    const edges = container.querySelectorAll('.react-flow__edge');
    expect(container.querySelectorAll('.react-flow__edge.is-flowing').length).toBe(edges.length);
    // Only the us-west to eu-central path rides the hot pair; same-region and other-pair paths stay calm.
    const hot = Array.from(container.querySelectorAll('.react-flow__edge.is-hot')).map((edge) =>
      edge.getAttribute('data-id'),
    );
    expect(hot).toEqual(['edge-eu']);
    // The measured wait is written once per region in the lane header, not on every path label.
    expect(container.querySelector('.cart-edge-label.is-hot')).not.toHaveTextContent('WAN queue up to 900 ms');
    const notes = Array.from(container.querySelectorAll('.cart-lane__hot')).map((note) => note.textContent);
    expect(notes).toEqual(['Circuit to EU Central: WAN queue up to 900 ms', 'Circuit to US West: WAN queue up to 900 ms']);
  });
});
