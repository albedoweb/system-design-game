import { mkdirSync } from 'node:fs';

import { expect, test } from '@playwright/test';

async function collectPageErrors(page: import('@playwright/test').Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('opens the game workspace and shows the starter graph', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = await collectPageErrors(page);
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  const response = await page.goto('/#cold-cache');
  expect(response?.ok()).toBe(true);

  await expect(
    page.getByRole('heading', { level: 1, name: 'Cold Cache' }),
  ).toBeVisible();
  await expect(page.getByText('Ready to run')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run' })).toBeEnabled();
  await expect(page.getByText('Cost / budget')).toBeVisible();
  await expect(page.getByText('$2.60/h')).toBeVisible();
  await expect(
    page.getByTestId('rf__node-cache-1').getByText('Catalog cache'),
  ).toBeVisible();
  await expect(page.getByText('SLO and scoring')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run' })).toBeVisible();
  await expect(
    page.getByText(
      'Run the simulation to see latency, errors, and load on each component.',
    ),
  ).toBeVisible();

  const briefing = page.getByRole('complementary', {
    name: 'Task and components',
  });
  await expect(
    briefing.getByRole('heading', { level: 2, name: 'Cold Cache' }),
  ).toBeVisible();
  await expect(
    briefing.getByText(/the operator flushes the shared catalog cache/i),
  ).toBeVisible();

  // Subsecond model timings must be exact milliseconds, never "0 s".
  const fact = (label: string) =>
    briefing.locator('.brief-facts div', { hasText: label });
  await expect(fact('External RTT')).toContainText('10 ms');
  await expect(fact('Internal edge')).toContainText('2 ms');
  await expect(fact('Internal edge')).toContainText('1 ms each way');
  await expect(fact('App CPU')).toContainText('2 ms');
  await expect(fact('Cache lookup')).toContainText('1 ms');
  await expect(fact('DB read / write')).toContainText('16 ms / 32 ms');
  await expect(fact('Load balancer')).toContainText('1 ms');
  await expect(fact('Invalidation after write')).toContainText('2 ms');

  const timelineRow = (label: string) =>
    briefing.locator('tr', { hasText: label });
  await expect(timelineRow('Warmup before evaluation')).toContainText('5 s');
  await expect(timelineRow('Evaluation duration')).toContainText('60 s');
  await expect(timelineRow('Cache flush')).toContainText('30 s');
  await expect(timelineRow('Drain after generation')).toContainText('800 ms');
  await expect(timelineRow('Global deadline')).toContainText('800 ms');
  await expect(briefing.getByText(/^0 s$/)).toHaveCount(0);
  await expect(briefing.getByText(/^1 s$/)).toHaveCount(0);
  await expect(
    briefing.getByText(/load balancer costs \$0\.10\/h/),
  ).toBeVisible();

  mkdirSync('test-results/screenshots', { recursive: true });
  await page.screenshot({
    path: 'test-results/screenshots/v102-desktop-1440x900.png',
    fullPage: true,
  });

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('keeps edits in memory but reload starts the starter graph again', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = await collectPageErrors(page);
  await page.goto('/#cold-cache');

  await page.getByRole('tab', { name: 'Components' }).click();
  await page.getByRole('button', { name: 'Add: App Server' }).click();

  await expect(page.getByText('$2.80/h').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete component' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run' })).toBeDisabled();
  await expect(page.getByText(/Graph is not ready to run/)).toBeVisible();

  await page.waitForTimeout(850);
  await page.reload();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Cold Cache' }),
  ).toBeVisible();
  // No automatic draft restore: reload always starts the starter graph.
  await expect(page.getByText('$2.80/h')).toHaveCount(0);
  await expect(page.getByTestId('rf__node-app-2')).toHaveCount(0);
  await expect(page.getByText('Draft restored', { exact: false })).toHaveCount(0);
  await expect(page.getByText('$2.60/h').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run' })).toBeEnabled();

  await page.getByRole('button', { name: 'Reset' }).click();
  const resetDialog = page.getByRole('dialog', {
    name: 'Restore the starting graph?',
  });
  await expect(resetDialog).toBeVisible();
  await resetDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('$2.60/h').first()).toBeVisible();

  await page.getByRole('button', { name: 'Reset' }).click();
  await resetDialog.getByRole('button', { name: 'Reset graph' }).click();
  await expect(page.getByText('$2.60/h')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run' })).toBeEnabled();

  expect(pageErrors).toEqual([]);
});

test('rejects an illegal connection and a broken import without changing the graph', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = await collectPageErrors(page);
  await page.goto('/#cold-cache');

  await expect(page.locator('.react-flow__edge')).toHaveCount(4);
  await page.getByRole('button', { name: 'Connect' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Connect components' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Source', { exact: true }).selectOption('app-1');
  await dialog.getByLabel('Source port').selectOption('write');
  await dialog.getByLabel('Target').selectOption('cache-1');
  await dialog.getByRole('button', { name: 'Create connection' }).click();
  await expect(dialog.getByRole('alert')).toContainText('cannot connect');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(4);
  await expect(page.getByText('$2.60/h')).toBeVisible();

  await page
    .getByLabel('Open saved graph file')
    .setInputFiles({
      name: 'broken.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{ not json'),
    });
  await expect(page.getByText('Open rejected').first()).toBeVisible();
  await expect(page.getByText(/not changed/i)).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(4);
  await expect(page.getByText('$2.60/h')).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('inspector edits parameters and undoes the change', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = await collectPageErrors(page);
  await page.goto('/#cold-cache');

  await page.getByTestId('rf__node-cache-1').click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(
    inspector.getByRole('heading', { level: 2, name: 'Catalog cache' }),
  ).toBeVisible();

  const ttl = inspector.getByRole('spinbutton', { name: 'TTL' });
  await expect(ttl).toHaveValue('120');
  await ttl.fill('');
  await ttl.blur();
  await expect(ttl).toHaveValue('120');

  await ttl.fill('45');
  await ttl.press('Enter');
  await expect(ttl).toHaveValue('45');

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(ttl).toHaveValue('120');

  mkdirSync('test-results/screenshots', { recursive: true });
  await page.screenshot({
    path: 'test-results/screenshots/v102-inspector-1440x900.png',
    fullPage: true,
  });

  expect(pageErrors).toEqual([]);
});

test('connectors have a larger grab area and the zoom toolbar has two buttons', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = await collectPageErrors(page);
  await page.goto('/#cold-cache');

  const viewport = page.locator('.react-flow__viewport');
  const viewportTransform = () =>
    viewport.evaluate((element) => getComputedStyle(element).transform);
  const zoomScale = () =>
    viewport.evaluate(
      (element) => new DOMMatrix(getComputedStyle(element).transform).a,
    );
  // The initial fitView animates for 150ms; never capture handles mid-flight.
  let previousTransform = '';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await viewportTransform();
    if (current === previousTransform) break;
    previousTransform = current;
    await page.waitForTimeout(100);
  }

  const toolbar = page.getByRole('toolbar', { name: 'Canvas zoom' });
  await expect(toolbar.getByRole('button')).toHaveCount(2);
  await expect(toolbar.getByRole('button', { name: 'Zoom out' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Fit graph to view' }),
  ).toHaveCount(0);

  const readHandle = page.locator(
    '.react-flow__handle.source[data-nodeid="app-1"][data-handleid="read"]',
  );
  await expect(readHandle).toBeVisible();
  const sizes = await readHandle.evaluate((element) => {
    const own = getComputedStyle(element);
    const grabArea = getComputedStyle(element, '::after');
    return {
      width: own.width,
      height: own.height,
      grabWidth: grabArea.width,
      grabHeight: grabArea.height,
    };
  });
  // The visible dot stays 9px; the transparent pointer target is ~28px.
  expect(sizes).toEqual({
    width: '9px',
    height: '9px',
    grabWidth: '28px',
    grabHeight: '28px',
  });

  const source = await readHandle.boundingBox();
  expect(source).not.toBeNull();
  const startZoom = await zoomScale();
  // 10 flow pixels: outside the 4.5 flow-unit visible radius, inside the
  // 14 flow-unit pointer target. Perpendicular to the outgoing edge path.
  const startX = source!.x + source!.width / 2;
  const startY = source!.y + source!.height / 2 + 10 * startZoom;
  const startHit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return {
      tag: element?.tagName,
      handle: element?.getAttribute('data-handleid'),
    };
  }, { x: startX, y: startY });
  expect(startHit.handle).toBe('read');

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 3);
  await expect(page.locator('.react-flow__connection-path')).toBeVisible();

  const targetHandle = page.locator(
    '.react-flow__handle.target[data-nodeid="db-1"]',
  );
  await expect(targetHandle).toBeVisible();
  const target = await targetHandle.boundingBox();
  expect(target).not.toBeNull();
  // The graph stays inside the canvas, so this is not an auto-pan gesture.
  await page.mouse.move(
    target!.x + target!.width / 2 + 20 * startZoom,
    target!.y + target!.height / 2,
    { steps: 12 },
  );
  await expect(
    page.locator('.react-flow__handle.target.valid'),
  ).toBeVisible();
  await page.mouse.up();

  const newEdge = page.locator('.react-flow__edge[data-id="e-1"]');
  await expect(page.locator('.react-flow__edge')).toHaveCount(5);
  await expect(newEdge).toBeVisible();
  await expect(page.locator('.canvas-alert')).toHaveCount(0);

  // The new second read edge also makes the graph invalid, so the validation
  // notice appears and resizes the canvas. Let the viewport settle before
  // deriving a pointer target or measuring the node for dragging.
  let settledTransform = '';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await viewportTransform();
    if (current === settledTransform) break;
    settledTransform = current;
    await page.waitForTimeout(100);
  }

  // Verify the new edge's actual endpoints and source port through the
  // inspector. The bounding-box centre can sit underneath a node, so click a
  // real rendered point of this edge and prove the hit target belongs to it.
  const edgePoint = await newEdge.evaluate((element) => {
    const paths = Array.from(element.querySelectorAll('path')) as SVGPathElement[];
    for (const path of paths) {
      const length = path.getTotalLength();
      const matrix = path.getScreenCTM();
      if (!length || !matrix) {
        continue;
      }
      for (let step = 1; step < 20; step += 1) {
        const local = path.getPointAtLength((length * step) / 20);
        const screen = new DOMPoint(local.x, local.y).matrixTransform(matrix);
        const hit = document.elementFromPoint(screen.x, screen.y);
        if (hit?.closest('.react-flow__edge[data-id="e-1"]')) {
          return { x: screen.x, y: screen.y };
        }
      }
    }
    return null;
  });
  expect(edgePoint).not.toBeNull();
  await page.mouse.click(edgePoint!.x, edgePoint!.y);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByRole('heading', { level: 2 })).toHaveText(
    /App Server → Database/,
  );
  await expect(inspector.getByText('read', { exact: true })).toBeVisible();

  // The enlarged pointer target must not hijack ordinary node dragging.
  const cache = page.getByTestId('rf__node-cache-1');
  const beforeDrag = await cache.boundingBox();
  expect(beforeDrag).not.toBeNull();
  await page.mouse.move(
    beforeDrag!.x + beforeDrag!.width / 2,
    beforeDrag!.y + beforeDrag!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    beforeDrag!.x + beforeDrag!.width / 2 + 40,
    beforeDrag!.y + beforeDrag!.height / 2 + 20,
    { steps: 10 },
  );
  await page.mouse.up();
  const afterDrag = await cache.boundingBox();
  expect(afterDrag).not.toBeNull();
  expect(afterDrag!.x).toBeGreaterThan(beforeDrag!.x + 20);
  expect(afterDrag!.y).toBeGreaterThan(beforeDrag!.y + 10);

  const beforeZoom = await zoomScale();
  await toolbar.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(zoomScale).toBeGreaterThan(beforeZoom);
  const zoomed = await zoomScale();
  await toolbar.getByRole('button', { name: 'Zoom out' }).click();
  await expect.poll(zoomScale).toBeLessThan(zoomed);

  expect(pageErrors).toEqual([]);
});

test('runs the simulation at 16× and shows real engine results', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = await collectPageErrors(page);
  await page.goto('/#cold-cache');

  await page.getByRole('button', { name: '16×' }).click();
  await page.getByRole('button', { name: 'Run' }).click();

  // Resizing is independent of the worker: the run must continue and finish.
  const resizer = page.getByRole('separator', {
    name: 'Resize canvas and telemetry',
  });
  await resizer.focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();

  await expect(page.getByText('Level not passed', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.metrics__charts')).toBeVisible();
  await expect(page.getByText('Cumulative for the evaluation')).toBeVisible();
  await expect(
    page.getByText(
      /Coalesced counts cache misses that shared one in-flight database read/,
    ),
  ).toBeVisible();

  const canvas = await page.locator('.game-canvas-area').boundingBox();
  expect(canvas).not.toBeNull();
  for (const id of ['client-1', 'app-1', 'cache-1', 'db-1']) {
    const node = await page.getByTestId(`rf__node-${id}`).boundingBox();
    expect(node).not.toBeNull();
    expect(node!.x).toBeGreaterThanOrEqual(canvas!.x - 2);
    expect(node!.y).toBeGreaterThanOrEqual(canvas!.y - 2);
    expect(node!.x + node!.width).toBeLessThanOrEqual(canvas!.x + canvas!.width + 2);
    expect(node!.y + node!.height).toBeLessThanOrEqual(canvas!.y + canvas!.height + 2);
  }
  await page.getByRole('button', { name: 'View results', exact: true }).click();
  await expect(page.getByText('Run result')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Not passed' }),
  ).toBeVisible();
  await expect(page.getByText(/\$2\.60\/h · seed 101/)).toBeVisible();
  await expect(
    page.getByRole('rowheader', { name: 'Read availability', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('rowheader', { name: 'Cost', exact: true }),
  ).toBeVisible();

  const checkRows = page.locator('.game-table tbody tr');
  await expect(checkRows).toHaveCount(9);
  await expect(page.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();
  expect(await page.locator('.diagnostics li').count()).toBeGreaterThan(0);

  mkdirSync('test-results/screenshots', { recursive: true });
  await page.screenshot({
    path: 'test-results/screenshots/v104-run-16x-1440x900.png',
    fullPage: true,
  });

  await page.getByRole('spinbutton', { name: 'Seed', exact: true }).fill('211');
  await page.getByRole('spinbutton', { name: 'Seed', exact: true }).press('Tab');
  await expect(page.getByText('Previous run', { exact: true })).toBeVisible();
  await expect(page.getByText(/This is the result of a previous run/)).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('compact 1024x768 keeps the canvas and Run accessible', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const pageErrors = await collectPageErrors(page);
  await page.goto('/#cold-cache');

  await expect(
    page.getByRole('complementary', { name: 'Task and components' }),
  ).toBeHidden();
  await expect(
    page.getByRole('complementary', { name: 'Inspector' }),
  ).toBeHidden();
  await expect(page.getByRole('button', { name: 'Run' })).toBeVisible();
  await expect(
    page.getByTestId('rf__node-cache-1').getByText('Catalog cache'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Task' }).click();
  await expect(
    page.getByRole('complementary', { name: 'Task and components' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Incoming workload' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close left panel' }).click();

  mkdirSync('test-results/screenshots', { recursive: true });
  await page.screenshot({
    path: 'test-results/screenshots/v102-compact-1024x768.png',
    fullPage: true,
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(
    page.getByRole('complementary', { name: 'Task and components' }),
  ).toBeHidden();
  await expect(page.getByRole('button', { name: 'Run' })).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('resizes telemetry by pointer and keyboard without losing the graph', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = await collectPageErrors(page);
  await page.addInitScript(() => {
    const store: string[] = [];
    (window as unknown as { __v106WindowErrors: string[] }).__v106WindowErrors =
      store;
    window.addEventListener('error', (event) => {
      store.push(String((event as ErrorEvent).message));
    });
  });
  await page.goto('/#cold-cache');

  const separator = page.getByRole('separator', {
    name: 'Resize canvas and telemetry',
  });
  await expect(separator).toBeVisible();
  const metrics = page.locator('.metrics');
  const canvas = page.locator('.game-canvas-area');
  const initialMetrics = await metrics.boundingBox();
  const initialCanvas = await canvas.boundingBox();
  expect(initialMetrics).not.toBeNull();
  expect(initialCanvas).not.toBeNull();

  const takeWindowErrors = async (label: string) => {
    const errors = await page.evaluate(() => {
      const store = (
        window as unknown as { __v106WindowErrors: string[] }
      ).__v106WindowErrors;
      const copy = [...store];
      store.length = 0;
      return copy;
    });
    expect(errors, `no window errors after ${label}`).toEqual([]);
  };

  const dragBy = async (dy: number) => {
    const grip = await separator.boundingBox();
    expect(grip).not.toBeNull();
    const x = grip!.x + grip!.width / 2;
    const y = grip!.y + grip!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + dy, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(100);
  };

  await takeWindowErrors('initial layout');
  await dragBy(-70);
  await expect
    .poll(async () => (await metrics.boundingBox())?.height ?? 0)
    .toBeGreaterThan((initialMetrics?.height ?? 0) + 30);
  const draggedCanvas = await canvas.boundingBox();
  expect(draggedCanvas?.height ?? 0).toBeLessThan(
    (initialCanvas?.height ?? 0) - 30,
  );
  await expect(
    page.getByTestId('rf__node-cache-1').getByText('Catalog cache'),
  ).toBeVisible();
  await takeWindowErrors('mouse drag up');

  // Repeated opposite-direction drags, including the clamped extremes.
  const afterUp = (await metrics.boundingBox())?.height ?? 0;
  await dragBy(40);
  await expect
    .poll(async () => (await metrics.boundingBox())?.height ?? 0)
    .toBeLessThan(afterUp - 20);
  await dragBy(-600);
  await expect
    .poll(async () => (await metrics.boundingBox())?.height ?? 0)
    .toBeGreaterThan(afterUp);
  const maxHeight = (await metrics.boundingBox())?.height ?? 0;
  await dragBy(900);
  await expect
    .poll(async () => (await metrics.boundingBox())?.height ?? 0)
    .toBe(96);
  await takeWindowErrors('repeated drag and pointer clamps');

  await separator.focus();
  await page.keyboard.press('ArrowUp');
  await expect
    .poll(async () => (await metrics.boundingBox())?.height ?? 0)
    .toBeGreaterThan(110);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await expect
    .poll(async () => (await metrics.boundingBox())?.height ?? 0)
    .toBe(Math.round(maxHeight));
  await page.keyboard.press('Home');
  await expect
    .poll(async () => (await metrics.boundingBox())?.height ?? 0)
    .toBe(96);
  await page.keyboard.press('End');
  await page.waitForTimeout(80);
  const expandedHeight = (await metrics.boundingBox())?.height ?? 0;
  const selectedStyle = await metrics.evaluate(
    (element) => (element as HTMLElement).style.height,
  );
  expect(selectedStyle).toMatch(/px$/);
  const canvasAtEnd = await canvas.boundingBox();
  expect(canvasAtEnd?.height ?? 0).toBeGreaterThanOrEqual(178);
  await takeWindowErrors('keyboard min-max');

  await page.getByRole('button', { name: /Telemetry/ }).click();
  await expect(separator).toHaveCount(0);
  await page.getByRole('button', { name: /Telemetry/ }).click();
  await expect(separator).toBeVisible();
  await expect
    .poll(async () =>
      metrics.evaluate((element) => (element as HTMLElement).style.height),
    )
    .toBe(selectedStyle);
  await expect(
    page.getByTestId('rf__node-client-1').getByText('traffic source'),
  ).toBeVisible();
  await takeWindowErrors('collapse and reopen');

  // A notice changes the split height; evidence must clamp without a loop.
  await page.getByLabel('Open saved graph file').setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{ not json'),
  });
  await expect(page.getByText('Open rejected', { exact: true })).toBeVisible();
  await page.waitForTimeout(100);
  const noticeMetrics = (await metrics.boundingBox())?.height ?? 0;
  expect(noticeMetrics).toBeLessThanOrEqual(expandedHeight + 1);
  const noticeCanvas = await canvas.boundingBox();
  expect(noticeCanvas?.height ?? 0).toBeGreaterThanOrEqual(178);
  await takeWindowErrors('notice layout');
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(page.getByText('Open rejected')).toHaveCount(0);
  await takeWindowErrors('notice dismissed');

  // Viewport shrink and grow both re-clamp the selected height.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(200);
  let layout = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
  }));
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.innerHeight + 1);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
  await expect(separator).toBeVisible();
  const compactCanvas = await canvas.boundingBox();
  expect(compactCanvas?.height ?? 0).toBeGreaterThanOrEqual(178);
  await takeWindowErrors('viewport shrink');
  await dragBy(-50);
  await takeWindowErrors('compact drag');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
  layout = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
  }));
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.innerHeight + 1);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
  await expect(separator).toBeVisible();
  await takeWindowErrors('viewport grow');

  expect(pageErrors).toEqual([]);
});

test('stopping a real worker run labels the frozen snapshot and then stales it', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = await collectPageErrors(page);
  await page.addInitScript(() => {
    const store: string[] = [];
    (window as unknown as { __v106WindowErrors: string[] }).__v106WindowErrors =
      store;
    window.addEventListener('error', (event) => {
      store.push(String((event as ErrorEvent).message));
    });
  });
  await page.goto('/#cold-cache');

  const separator = page.getByRole('separator', {
    name: 'Resize canvas and telemetry',
  });
  const takeWindowErrors = async (label: string) => {
    const errors = await page.evaluate(() => {
      const store = (
        window as unknown as { __v106WindowErrors: string[] }
      ).__v106WindowErrors;
      const copy = [...store];
      store.length = 0;
      return copy;
    });
    expect(errors, `no window errors after ${label}`).toEqual([]);
  };
  const dragBy = async (dy: number) => {
    const grip = await separator.boundingBox();
    expect(grip).not.toBeNull();
    const x = grip!.x + grip!.width / 2;
    const y = grip!.y + grip!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + dy, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(100);
  };

  // Pause first, then stop: the last worker snapshot must not look live.
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(page.locator('.metrics__summary')).toContainText('running', {
    timeout: 10_000,
  });
  await dragBy(-40);
  await expect(page.locator('.metrics__summary')).toContainText('running');
  await takeWindowErrors('running drag');

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await expect(page.locator('.metrics__summary')).toContainText('paused');
  await dragBy(30);
  await expect(page.locator('.metrics__summary')).toContainText('paused');
  await takeWindowErrors('paused drag');

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('Stopped', { exact: true })).toBeVisible();
  await expect(page.locator('.metrics__summary')).toContainText('stopped');
  await expect(
    page.locator('.metrics__summary'),
  ).not.toContainText('running');
  await expect(
    page.getByTestId('rf__node-db-1').getByText('Stopped snapshot'),
  ).toBeVisible();
  await expect(
    page.getByText(/not a live reading or a completed evaluation/),
  ).toBeVisible();
  await expect(page.locator('.results__banner')).toHaveCount(0);

  await page.getByTestId('rf__node-db-1').click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByText('Stopped snapshot')).toBeVisible();
  await expect(
    inspector.getByText(/Last snapshot captured at .* before Stop/),
  ).toBeVisible();

  // A semantic edit must hide, not relabel, the stopped evidence.
  const seed = page.getByRole('spinbutton', { name: 'Seed', exact: true });
  await seed.fill('999');
  await seed.press('Tab');
  await expect(page.locator('.canvas-stale')).toBeVisible();
  await expect(page.locator('.metrics__stale')).toBeVisible();
  await expect(page.locator('.metrics__summary')).toContainText('previous run');
  await expect(page.locator('.domain-node__snapshot')).toHaveCount(0);

  // Stop directly from running as well; the same stopped labelling applies.
  await page.getByRole('button', { name: 'Run again' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(page.locator('.metrics__summary')).toContainText('running', {
    timeout: 10_000,
  });
  await dragBy(-40);
  await takeWindowErrors('second running drag');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('Stopped', { exact: true })).toBeVisible();
  await expect(page.locator('.metrics__summary')).toContainText('stopped');
  await expect(
    page.getByTestId('rf__node-db-1').getByText('Stopped snapshot'),
  ).toBeVisible();
  await expect(page.locator('.results__banner')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
