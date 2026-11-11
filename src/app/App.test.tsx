import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_LEVEL } from '../domain';
import { draftStorageKey } from '../features/persistence/draft-storage';
import { App } from './App';
import { CART_REQUIRED_CASES, CART_WORKER_PROTOCOL, createCartStarterGraph, evaluateCart } from '../cart';
import { useCartStore } from '../cart/ui/cart-store';
import { parseCartState } from '../cart/ui/cart-persistence';
import referenceBasic from '../../tests/fixtures/cart/basic/reference-basic.json';
import type { CartWorkerRequest } from '../cart/worker/cart-worker-protocol';
import { CartHeader } from '../cart/ui/CartHeader';

const LEGACY_TIMEOUT = 5000;

const workers: TestCartWorker[] = [];

/** Puts the complete reference design into the store, so Run has something to execute. */
function loadReferenceDesign() {
  const parsed = parseCartState(JSON.stringify(referenceBasic));
  if (!parsed.ok) throw new Error('reference fixture must parse');
  act(() => useCartStore.getState().replaceGraph(parsed.graph));
  return parsed.graph;
}
class TestCartWorker {
  sent: CartWorkerRequest[] = [];
  listeners = new Set<EventListener>();
  terminated = false;
  postMessage(message: CartWorkerRequest) { this.sent.push(message); }
  addEventListener(type: string, listener: EventListener) { if (type === 'message') this.listeners.add(listener); }
  removeEventListener(_type: string, listener: EventListener) { this.listeners.delete(listener); }
  terminate() { this.terminated = true; }
  emit(type: string, payload: unknown) {
    const start = this.sent[0]!;
    for (const listener of this.listeners) listener(new MessageEvent('message', { data: {
      protocol: CART_WORKER_PROTOCOL, runId: start.runId, generation: start.generation, type, payload,
    } }));
  }
}
vi.mock('../cart/worker/cart-worker-factory', () => ({ createCartWorker: () => {
  const worker = new TestCartWorker(); workers.push(worker); return worker;
} }));

function navigateTo(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

describe('App', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('открывает игровое рабочее место со стартовой схемой и Run', async () => {
    const user = userEvent.setup();
    window.location.hash = '#cold-cache';
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Cold Cache' }, { timeout: LEGACY_TIMEOUT }),
    ).toBeVisible();
    expect(screen.getByText('Ready to run')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
    expect(screen.getAllByText(/\$2\.60\/h/).length).toBeGreaterThan(0);
    expect(screen.getByText('SLO and scoring')).toBeVisible();
    expect(screen.queryByText('Passed')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Components' }));
    expect(
      screen.getByRole('heading', { level: 3, name: 'App Server' }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Add: App Server' }),
    ).toBeEnabled();

    const visibleText = document.body.textContent ?? '';
    expect(visibleText).not.toMatch(/[А-Яа-яЁё]/);
    const labels = [...document.querySelectorAll('[aria-label], [title]')].map(
      (element) =>
        `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`,
    );
    expect(labels.join(' ')).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('не читает и не перезаписывает старый сохранённый черновик', async () => {
    const user = userEvent.setup();
    const raw = '{"storeVersion":1,"graph":{"broken":true}}';
    const key = draftStorageKey(DEFAULT_LEVEL);
    window.localStorage.setItem(key, raw);

    window.location.hash = '#cold-cache';
    render(<App />);
    expect(
      screen.queryByText('Saved draft is corrupted'),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Cold Cache' }, { timeout: LEGACY_TIMEOUT }),
    ).toBeVisible();
    // The stale shared record is neither shown nor used as the starter graph.
    expect(screen.getAllByText(/\$2\.60\/h/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('tab', { name: 'Components' }));
    await user.click(
      screen.getByRole('button', { name: 'Add: App Server' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 750));

    expect(window.localStorage.getItem(key)).toBe(raw);
  });
});

describe('App · navigation', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('shows only the brand bar and the Global Cart level by default', () => {
    window.location.hash = '';
    render(<App />);

    expect(screen.getByRole('heading', { level: 1, name: 'Global Cart' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
    expect(screen.getByText('System Design Game')).toBeVisible();
    expect(document.title).toBe('Global Cart — System Design Game');
    expect(document.documentElement.lang).toBe('en');
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content'))
      .toBe('Global Cart — design a shopping cart service for three regions and test it under simulated load.');
  });

  it('has no Levels navigation and no level links', () => {
    render(<App />);

    expect(screen.queryByRole('navigation', { name: 'Levels' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Cold Cache' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Parcel Pulse|Image Atlas|Live/ })).not.toBeInTheDocument();
  });

  it('shows the Global Cart level for an unknown hash', () => {
    window.location.hash = '#nonsense';
    render(<App />);

    expect(screen.getByRole('heading', { level: 1, name: 'Global Cart' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
    expect(document.title).toBe('Global Cart — System Design Game');
  });

  it('lazily renders a legacy level opened by its direct hash', async () => {
    window.location.hash = '#cold-cache';
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Cold Cache' }, { timeout: LEGACY_TIMEOUT }),
    ).toBeVisible();
    expect(screen.queryByRole('heading', { level: 1, name: 'Global Cart' })).not.toBeInTheDocument();
    expect(document.title).toBe('Cold Cache — System Design Game');
  });

  it('opens the Image Atlas and Parcel Pulse levels by direct hash', async () => {
    window.location.hash = '#image-atlas';
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Image Atlas' }, { timeout: LEGACY_TIMEOUT }),
    ).toBeVisible();
    expect(screen.getByLabelText('Seed')).toHaveValue(101);
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
    expect(screen.getByLabelText('Open saved graph file')).toBeInTheDocument();

    // All product UI stays English, including tooltips and aria labels.
    const visibleText = document.body.textContent ?? '';
    expect(visibleText).not.toMatch(/[А-Яа-яЁё]/);
    const labels = [...document.querySelectorAll('[aria-label], [title]')].map(
      (element) =>
        `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`,
    );
    expect(labels.join(' ')).not.toMatch(/[А-Яа-яЁё]/);

    navigateTo('#parcel-pulse');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Parcel Pulse' }, { timeout: LEGACY_TIMEOUT }),
    ).toBeVisible();
  });
});

describe('Global Cart application integration', () => {
  beforeEach(() => {
    workers.length = 0;
    useCartStore.getState().resetGraph();
    window.location.hash = '#global-cart';
  });
  afterEach(() => { window.location.hash = ''; });

  it('exposes the Global Cart only, clean starter and independent run instances without storage access', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const view = render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'Global Cart' })).toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Levels' })).not.toBeInTheDocument();
    expect(document.title).toContain('Global Cart');
    expect(screen.getByRole('button', {name: 'Task'})).toBeVisible();
    expect(screen.getByRole('button', {name: 'Properties'})).toBeVisible();
    expect(screen.getByRole('region', {name: 'Global Cart telemetry'})).toBeVisible();
    expect(screen.getByRole('heading', {name: 'One cart, anywhere'})).toBeVisible();
    expect(screen.queryByText('Observed-unit quantity examples')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: 'How simulation works →'}));
    const guide = screen.getByRole('dialog', {name: 'How simulation works'});
    expect(guide).toBeVisible();
    expect(within(guide).getByRole('heading', {name: 'Scenarios'})).toBeVisible();
    expect(within(guide).getByText('Shopping Rush:')).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name: 'Close'}));

    fireEvent.click(screen.getByRole('button', {name: 'Build'}));
    expect(screen.getByLabelText('New component region')).toBeVisible();
    expect(screen.getByRole('button', {name: 'Build'})).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', {name: 'Task'}));
    expect(screen.getByRole('heading', {name: 'One cart, anywhere'})).toBeVisible();
    expect(useCartStore.getState().graph).toEqual(createCartStarterGraph());
    loadReferenceDesign();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(workers).toHaveLength(1);
    view.unmount();
    expect(workers[0]!.terminated).toBe(true);
    render(<App />);
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
    expect(screen.getByText('Ready to run')).toBeVisible();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('does not start a run on the empty starter design and says what to add', () => {
    render(<App />);
    expect(useCartStore.getState().graph).toEqual(createCartStarterGraph());
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(workers).toHaveLength(0);
    expect(
      screen.getByText('Nothing to run yet. Open Build and add an Application in each region.'),
    ).toBeVisible();
    expect(screen.queryByRole('progressbar', { name: 'Evaluation progress' })).not.toBeInTheDocument();
  });

  it('switches between Global Cart and legacy levels and disposes the old cart run', async () => {
    render(<App />);
    loadReferenceDesign();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(workers).toHaveLength(1);

    for (const hash of ['#cold-cache', '#global-cart', '#live-scoreboard', '#global-cart', '#parcel-pulse', '#image-atlas', '#cold-cache', '#global-cart', '#nonsense']) {
      navigateTo(hash);
      if (hash === '#global-cart' || hash === '#nonsense') {
        expect(screen.getByRole('heading', { level: 1, name: 'Global Cart' })).toBeVisible();
      } else {
        await waitFor(() => expect(document.title).not.toBe('Global Cart — System Design Game'), { timeout: LEGACY_TIMEOUT });
        expect(screen.queryByRole('heading', { level: 1, name: 'Global Cart' })).not.toBeInTheDocument();
      }
    }
    expect(workers[0]!.terminated).toBe(true);
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
  });

  it('pauses advancing, resumes, renders measured traffic/replay and real core results, then resets', async () => {
    render(<App />);
    loadReferenceDesign();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    const worker = workers[0]!;
    const caseId = CART_REQUIRED_CASES[0];
    // The first advance is sent only after the worker reports progress once.
    act(() => worker.emit('progress', {
      progress: { caseId, casesCompleted: 0, events: 0, elapsedUs: 0 },
    }));
    await waitFor(() => expect(worker.sent.some((request) => request.type === 'advance')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const count = worker.sent.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(worker.sent).toHaveLength(count);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    // Advancing waits for the next progress report; the worker reports one with measured frames.
    act(() => worker.emit('progress', {
      progress: { caseId, casesCompleted: 0, events: 10, elapsedUs: 100 },
      frames: [{ levelId: 'global-cart', caseId, index: 0, windowStartUs: 0, windowEndUs: 100000,
        windowUs: 100000, phase: 'measured', bytes: { request: 1, reply: 0, replication: 0, repair: 0, retry: 0 },
        serializedBytes: 1, wanBillableBytes: 0, nodes: [], links: [], circuits: [], sampled: false }],
    }));
    await waitFor(() => expect(worker.sent.length).toBeGreaterThan(count));
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    expect(screen.getByTestId('cart-case-replay')).toHaveAttribute('data-cart-replay-mode', 'playing');
    fireEvent.click(screen.getByRole('button', { name: 'Pause replay' }));
    expect(screen.getByTestId('cart-case-replay')).toHaveAttribute('data-cart-replay-mode', 'paused');
    const result = evaluateCart(useCartStore.getState().graph, { seed: useCartStore.getState().graph.seed });
    act(() => worker.emit('result', { evaluation: result }));
    expect(screen.getByRole('dialog', { name: 'Global Cart results' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'Open results' })).toBeVisible();
    act(() => useCartStore.getState().setSeed(77));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset design' }));
    expect(useCartStore.getState().graph).toEqual(createCartStarterGraph());
    expect(screen.getByRole('button', { name: 'Results' })).toBeDisabled();
    expect(screen.queryByTestId('cart-case-replay')).not.toBeInTheDocument();
  // Evaluates the full reference design with the real engine: about 28 s alone.
  }, 120_000);

  it('imports explicitly, rejects wrong versions atomically and ignores a file read after editing', async () => {
    render(<CartHeader />);
    const input = screen.getByLabelText('Open saved Global Cart design file');
    const imported = { ...referenceBasic, seed: 99 };
    fireEvent.change(input, { target: { files: [{ size: 10, text: async () => JSON.stringify(imported) }] } });
    await waitFor(() => expect(useCartStore.getState().graph.seed).toBe(99));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    const activeWorker = workers[0]!;
    act(() => useCartStore.getState().setSeed(100));
    expect(activeWorker.terminated).toBe(true);
    expect(screen.getByRole('button', { name: 'Results' })).toBeDisabled();
    const current = useCartStore.getState().graph;
    fireEvent.change(input, { target: { files: [{ size: 10, text: async () => JSON.stringify({ ...imported, graphVersion: 'wrong' }) }] } });
    await screen.findByText(/Invalid or unsupported/);
    expect(useCartStore.getState().graph).toBe(current);
    let resolve!: (text: string) => void;
    fireEvent.change(input, { target: { files: [{ size: 10, text: () => new Promise<string>((done) => { resolve = done; }) }] } });
    act(() => useCartStore.getState().setSeed(123));
    await act(async () => resolve(JSON.stringify(imported)));
    expect(useCartStore.getState().graph.seed).toBe(123);
  });

  it('blocks Run on an incomplete Application, names its region and opens its Properties', async () => {
    render(<App />);
    act(() => {
      const store = useCartStore.getState();
      store.resetGraph();
      store.addNode('application', 'eu-central');
    });
    const app = useCartStore.getState().graph.nodes.find((node) => node.kind === 'application')!;
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(workers).toHaveLength(0);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/EU Central/);
    expect(alert.textContent).toMatch(/has no write target yet/);
    expect(alert.textContent).toMatch(/Choose a journal or cart store in its Properties/);
    expect(alert.textContent).not.toMatch(/writeTarget|nodes\.\d|invalid_type/);
    fireEvent.click(screen.getByRole('button', { name: 'Open Properties' }));
    await waitFor(() =>
      expect(useCartStore.getState().selection).toEqual({ type: 'node', id: app.id }),
    );
    expect(useCartStore.getState().graph.nodes.find((node) => node.id === app.id))
      .toMatchObject({ writeTarget: '', readTargets: [] });
  });
});


describe('Global Cart explicit export', () => {
  it('downloads only the current graph and seed on demand', () => {
    const create = vi.fn<(blob: Blob) => string>(() => 'blob:cart-design');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<CartHeader />);
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:cart-design');
  });

  it('downloads an unfinished draft with blank targets and imports it back exactly', async () => {
    const blobs: Blob[] = [];
    const create = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:cart-draft';
    });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<CartHeader />);
    act(() => {
      const store = useCartStore.getState();
      store.resetGraph();
      store.addNode('application', 'ap-northeast');
      store.setSeed(4242);
    });
    const draft = useCartStore.getState().graph;
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(create).toHaveBeenCalledOnce();
    const blob = blobs[0]!;
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(JSON.parse(text).nodes.find((node: { kind: string }) => node.kind === 'application'))
      .toMatchObject({ writeTarget: '', readTargets: [] });

    act(() => useCartStore.getState().resetGraph());
    const input = screen.getByLabelText('Open saved Global Cart design file');
    fireEvent.change(input, { target: { files: [{ size: text.length, text: async () => text }] } });
    await waitFor(() => expect(useCartStore.getState().graph).toEqual(draft));
    click.mockRestore();
  });
});
