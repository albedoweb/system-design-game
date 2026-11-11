import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

const ORIGIN = 'http://127.0.0.1:5178';
const PARCEL_URL = '/#parcel-pulse';
const COLD_DRAFT_KEY = 'sdg:draft:cold-cache:1.0.0:v1';
const PARCEL_DRAFT_KEY = 'sdg:parcel:draft:parcel-pulse:1.0.0:v1';

const OPERATION_STROKES = new Set([
  'rgb(14, 116, 144)', // traffic
  'rgb(124, 58, 237)', // ingest
  'rgb(29, 111, 216)', // status
  'rgb(180, 83, 9)', // history
  'rgb(15, 118, 110)', // report
  'rgb(190, 18, 60)', // replicate
]);
const STALE_GREY = 'rgb(154, 169, 184)';
const ACTION_TIMEOUT_MS = 5_000;

function trackPageErrors(page: Page, sink: string[]): void {
  page.on('pageerror', (error) => sink.push(error.message));
}

async function exportStateFile(page: Page): Promise<{
  path: string;
  text: string;
  parsed: { graph: unknown; seed: number; kind?: string };
}> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  const path = await download.path();
  expect(path).not.toBeNull();
  const text = readFileSync(path!, 'utf8');
  return { path: path!, text, parsed: JSON.parse(text) };
}

async function openStateFile(page: Page, path: string) {
  await page.getByLabel('Open saved graph file').setInputFiles(path);
}

async function openComponents(page: Page) {
  const tab = page.getByRole('tab', { name: 'Components' });
  const task = page.getByRole('button', { name: 'Task', exact: true });
  // Levels are lazy-loaded after navigation: wait for either control to render
  // before choosing a branch, otherwise isVisible() races the level's first paint.
  await expect(tab.or(task).first()).toBeVisible();
  if (!(await tab.isVisible())) {
    await task.click();
  }
  await tab.click();
}

async function setSeed(page: Page, value: number) {
  const input = page.getByLabel('Seed');
  await input.fill(String(value));
  await input.press('Enter');
  await expect(input).toHaveValue(String(value));
}

async function edgeStrokes(page: Page): Promise<string[]> {
  return page.locator('.react-flow__edge-path').evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).stroke),
  );
}

test('reload starts fresh and never reads or changes preseeded legacy drafts', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];

  // Build valid legacy-shaped records from real exported graphs so a wrong
  // implementation would visibly restore them.
  const setupContext = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  setupContext.setDefaultTimeout(ACTION_TIMEOUT_MS);
  const setup = await setupContext.newPage();
  trackPageErrors(setup, pageErrors);

  await setup.goto(`${ORIGIN}/#cold-cache`);
  await openComponents(setup);
  await setup.getByRole('button', { name: 'Add: App Server' }).click();
  await expect(setup.getByTestId('rf__node-app-2')).toBeVisible();
  const coldState = await exportStateFile(setup);

  await setup.goto(`${ORIGIN}${PARCEL_URL}`);
  await setup.getByTestId('rf__node-sql-1').click();
  const setupInspector = setup.getByRole('complementary', { name: 'Inspector' });
  await setupInspector.getByLabel('Name').fill('Old Parcel');
  await setupInspector.getByLabel('Name').press('Enter');
  await expect(setup.getByTestId('rf__node-sql-1')).toContainText('Old Parcel');
  const parcelState = await exportStateFile(setup);
  await setupContext.close();

  const coldRaw = JSON.stringify({
    storeVersion: 1,
    levelId: 'cold-cache',
    contentVersion: '1.0.0',
    savedAt: new Date().toISOString(),
    graph: coldState.parsed.graph,
  });
  const parcelRaw = JSON.stringify({
    storeVersion: 1,
    levelId: 'parcel-pulse',
    contentVersion: '1.0.0',
    savedAt: new Date().toISOString(),
    graph: parcelState.parsed.graph,
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  await context.addInitScript(
    ({ cold, parcel }) => {
      try {
        if (sessionStorage.getItem('__p207_seed_once')) {
          return;
        }
        sessionStorage.setItem('__p207_seed_once', '1');
        localStorage.setItem('sdg:draft:cold-cache:1.0.0:v1', cold);
        sessionStorage.setItem('sdg:draft:cold-cache:1.0.0:v1', cold);
        localStorage.setItem('sdg:parcel:draft:parcel-pulse:1.0.0:v1', parcel);
        sessionStorage.setItem('sdg:parcel:draft:parcel-pulse:1.0.0:v1', parcel);
      } catch {
        // Storage access must not break the page under test.
      }
    },
    { cold: coldRaw, parcel: parcelRaw },
  );
  const page = await context.newPage();
  trackPageErrors(page, pageErrors);

  await page.goto(`${ORIGIN}/#cold-cache`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Cold Cache' }),
  ).toBeVisible();
  // The preseeded draft would add an App Server; a fresh start must not.
  await expect(page.getByTestId('rf__node-app-2')).toHaveCount(0);
  await expect(page.locator('.header-seed input')).toHaveValue('101');
  await expect(page.getByText(/Draft restored/)).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('rf__node-app-2')).toHaveCount(0);
  await expect(page.locator('.header-seed input')).toHaveValue('101');

  const coldAfterReload = await page.evaluate(
    ({ coldKey }) => ({
      local: localStorage.getItem(coldKey),
      session: sessionStorage.getItem(coldKey),
    }),
    { coldKey: COLD_DRAFT_KEY },
  );
  expect(coldAfterReload.local).toBe(coldRaw);
  expect(coldAfterReload.session).toBe(coldRaw);

  await page.goto(`${ORIGIN}${PARCEL_URL}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Parcel Pulse' }),
  ).toBeVisible();
  await expect(page.getByTestId('rf__node-sql-1')).toContainText('SQL store');
  await expect(page.locator('.parcel-header-seed input')).toHaveValue('101');
  await expect(page.getByText(/Draft restored/)).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('rf__node-sql-1')).toContainText('SQL store');
  await expect(page.locator('.parcel-header-seed input')).toHaveValue('101');

  const parcelAfterReload = await page.evaluate(
    ({ parcelKey }) => ({
      local: localStorage.getItem(parcelKey),
      session: sessionStorage.getItem(parcelKey),
    }),
    { parcelKey: PARCEL_DRAFT_KEY },
  );
  expect(parcelAfterReload.local).toBe(parcelRaw);
  expect(parcelAfterReload.session).toBe(parcelRaw);

  await context.close();
  expect(pageErrors).toEqual([]);
});

test('explicit Export/Import round-trips graph, positions and seed for both levels', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  trackPageErrors(page, pageErrors);
  await page.setViewportSize({ width: 1400, height: 900 });
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);

  // Cold Cache: graph plus seed.
  await page.goto('/#cold-cache');
  await openComponents(page);
  await page.getByRole('button', { name: 'Add: App Server' }).click();
  await expect(page.getByTestId('rf__node-app-2')).toBeVisible();
  await setSeed(page, 4242);
  const cold = await exportStateFile(page);
  expect(cold.parsed.kind).toBe('sdg-level-state');
  expect(cold.parsed.seed).toBe(4242);

  await page.reload();
  await expect(page.getByTestId('rf__node-app-2')).toHaveCount(0);
  await expect(page.locator('.header-seed input')).toHaveValue('101');

  await openStateFile(page, cold.path);
  await expect(page.getByText('File opened')).toBeVisible();
  await expect(page.getByTestId('rf__node-app-2')).toBeVisible();
  await expect(page.locator('.header-seed input')).toHaveValue('4242');

  // Parcel Pulse: graph, position and seed, with no stale run result.
  await page.goto(PARCEL_URL);
  await page.getByTestId('rf__node-sql-1').click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByLabel('Name').fill('Saved Parcel');
  await inspector.getByLabel('Name').press('Enter');
  await openComponents(page);
  await page.getByRole('button', { name: 'Add: KV store' }).click();
  await expect(page.getByTestId('rf__node-kv-1')).toBeVisible();
  await setSeed(page, 777);
  const parcel = await exportStateFile(page);

  await page.reload();
  await expect(page.getByTestId('rf__node-sql-1')).toContainText('SQL store');
  await expect(page.getByTestId('rf__node-kv-1')).toHaveCount(0);
  await expect(page.locator('.parcel-header-seed input')).toHaveValue('101');

  await openStateFile(page, parcel.path);
  await expect(page.getByText('File opened')).toBeVisible();
  await expect(page.getByTestId('rf__node-sql-1')).toContainText('Saved Parcel');
  await expect(page.getByTestId('rf__node-kv-1')).toBeVisible();
  await expect(page.locator('.parcel-header-seed input')).toHaveValue('777');
  await expect(page.locator('.parcel-header__meta .ui-pill')).toHaveText(
    'Ready to run',
  );
  await expect(page.locator('.parcel-canvas-note--stale')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test('two same-origin Parcel tabs edit, run and reset independently', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  const pageErrors: string[] = [];
  trackPageErrors(pageA, pageErrors);
  trackPageErrors(pageB, pageErrors);

  await Promise.all([
    pageA.goto(`${ORIGIN}${PARCEL_URL}`),
    pageB.goto(`${ORIGIN}${PARCEL_URL}`),
  ]);

  const inspectorA = pageA.getByRole('complementary', { name: 'Inspector' });
  await pageA.getByTestId('rf__node-sql-1').click();
  await inspectorA.getByLabel('Name').fill('A store');
  await inspectorA.getByLabel('Name').press('Enter');
  await openComponents(pageA);
  await pageA.getByRole('button', { name: 'Add: KV store' }).click();
  await expect(pageA.getByTestId('rf__node-kv-1')).toBeVisible();
  await setSeed(pageA, 111);

  const inspectorB = pageB.getByRole('complementary', { name: 'Inspector' });
  await pageB.getByTestId('rf__node-sql-1').click();
  await inspectorB.getByLabel('Name').fill('B store');
  await inspectorB.getByLabel('Name').press('Enter');
  await setSeed(pageB, 222);

  await expect(pageA.getByTestId('rf__node-sql-1')).toContainText('A store');
  await expect(pageA.getByTestId('rf__node-kv-1')).toBeVisible();
  await expect(pageA.locator('.parcel-header-seed input')).toHaveValue('111');
  await expect(pageB.getByTestId('rf__node-sql-1')).toContainText('B store');
  await expect(pageB.getByTestId('rf__node-kv-1')).toHaveCount(0);
  await expect(pageB.locator('.parcel-header-seed input')).toHaveValue('222');

  // Cancel A's run immediately. Stop must be present and clicked; the test
  // fails if the run ever completes before cancellation is exercised.
  await pageA.getByRole('button', { name: 'Run evaluation' }).click();
  const stopA = pageA.getByRole('button', { name: 'Stop' });
  await expect(stopA).toBeVisible();
  await stopA.click();
  await expect(pageA.locator('.parcel-header__meta .ui-pill')).toHaveText(
    'Cancelled',
  );
  await expect(
    pageA.getByRole('button', { name: /Run (evaluation|again)/ }),
  ).toBeEnabled();

  // B never started a run and is unaffected by A's cancellation.
  await expect(pageB.locator('.parcel-header__meta .ui-pill')).toHaveText(
    'Ready to run',
  );
  await expect(pageB.getByRole('button', { name: 'Run evaluation' })).toBeEnabled();
  await inspectorB.getByLabel('Name').fill('B after A cancelled');
  await inspectorB.getByLabel('Name').press('Enter');
  await expect(pageB.getByTestId('rf__node-sql-1')).toContainText(
    'B after A cancelled',
  );

  // Resetting A returns A to the starter without touching B.
  await pageA.getByRole('button', { name: 'Reset', exact: true }).click();
  const dialog = pageA.getByRole('dialog', {
    name: 'Restore the Parcel starter?',
  });
  await dialog.getByRole('button', { name: 'Reset graph' }).click();
  await expect(pageA.getByTestId('rf__node-sql-1')).toContainText('SQL store');
  await expect(pageA.getByTestId('rf__node-kv-1')).toHaveCount(0);
  await expect(pageA.locator('.parcel-header-seed input')).toHaveValue('101');
  await expect(pageA.locator('.parcel-header__meta .ui-pill')).toHaveText(
    'Ready to run',
  );
  await expect(pageA.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await expect(pageB.getByTestId('rf__node-sql-1')).toContainText(
    'B after A cancelled',
  );
  await expect(pageB.locator('.parcel-header-seed input')).toHaveValue('222');

  const draftKeys = await pageA.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.includes('draft')),
  );
  expect(draftKeys).toEqual([]);

  await context.close();
  expect(pageErrors).toEqual([]);
});

test('two same-origin Cold Cache tabs edit, run and reset independently', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  const pageErrors: string[] = [];
  trackPageErrors(pageA, pageErrors);
  trackPageErrors(pageB, pageErrors);

  await Promise.all([
    pageA.goto(`${ORIGIN}/#cold-cache`),
    pageB.goto(`${ORIGIN}/#cold-cache`),
  ]);

  // Run independence is checked before adding nodes: the starter graph is
  // runnable, while an added component intentionally blocks Run. Speed 1× keeps
  // the run alive long enough to require and exercise Stop deterministically.
  await setSeed(pageA, 111);
  await setSeed(pageB, 222);
  await pageA.getByRole('button', { name: '1×', exact: true }).click();
  await pageA.getByRole('button', { name: 'Run', exact: true }).click();
  const stopA = pageA.getByRole('button', { name: 'Stop' });
  await expect(stopA).toBeVisible();
  await stopA.click();
  await expect(pageA.locator('.app-header__meta .ui-pill')).toHaveText('Stopped');
  await expect(
    pageA.getByRole('button', { name: /^Run( again)?$/ }),
  ).toBeEnabled();
  await expect(pageB.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
  await expect(pageB.locator('.app-header__meta .ui-pill')).toHaveText('Ready to run');

  // Edit independence.
  await openComponents(pageA);
  await pageA.getByRole('button', { name: 'Add: App Server' }).click();
  await expect(pageA.getByTestId('rf__node-app-2')).toBeVisible();

  await openComponents(pageB);
  await pageB.getByRole('button', { name: 'Add: Load Balancer' }).click();
  await expect(pageB.getByTestId('rf__node-lb-1')).toBeVisible();

  await expect(pageA.getByTestId('rf__node-lb-1')).toHaveCount(0);
  await expect(pageB.getByTestId('rf__node-app-2')).toHaveCount(0);
  await expect(pageA.locator('.header-seed input')).toHaveValue('111');
  await expect(pageB.locator('.header-seed input')).toHaveValue('222');

  // Reset A only.
  await pageA.getByRole('button', { name: 'Reset', exact: true }).click();
  const dialog = pageA.getByRole('dialog', {
    name: 'Restore the starting graph?',
  });
  await dialog.getByRole('button', { name: 'Reset graph' }).click();
  await expect(pageA.getByTestId('rf__node-app-2')).toHaveCount(0);
  await expect(pageA.locator('.header-seed input')).toHaveValue('101');
  await expect(pageA.locator('.app-header__meta .ui-pill')).toHaveText('Ready to run');
  await expect(pageA.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await expect(pageB.getByTestId('rf__node-lb-1')).toBeVisible();
  await expect(pageB.locator('.header-seed input')).toHaveValue('222');

  const draftKeys = await pageA.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.includes('draft')),
  );
  expect(draftKeys).toEqual([]);

  await context.close();
  expect(pageErrors).toEqual([]);
});

test('Parcel route colors and labels stay stable after a run becomes previous', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  trackPageErrors(page, pageErrors);
  await page.setViewportSize({ width: 1400, height: 900 });
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  await page.goto(PARCEL_URL);

  await page.getByRole('button', { name: 'Run evaluation' }).click();
  await expect(page.getByText(/Run result · seed 101/)).toBeVisible({
    timeout: 60_000,
  });

  const assertRoutesNormal = async () => {
    await expect(page.locator('.react-flow__edge-path')).toHaveCount(5);
    const strokes = await edgeStrokes(page);
    expect(strokes).toHaveLength(5);
    for (const stroke of strokes) {
      expect(stroke).not.toBe(STALE_GREY);
      expect(OPERATION_STROKES.has(stroke)).toBe(true);
    }
    const labels = page.locator('.parcel-edge-label');
    await expect(labels).toHaveCount(5);
    const texts = await labels.allTextContents();
    for (const text of texts) {
      expect(text.toLowerCase()).not.toContain('previous');
    }
    expect(new Set(texts.map((text) => text.replace(/\s*!$/, '')))).toEqual(
      new Set(['traffic', 'ingest', 'status', 'history', 'report']),
    );
    const markerFills = await page.locator('marker path').evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).fill),
    );
    for (const fill of markerFills) {
      expect(fill).not.toBe(STALE_GREY);
    }
  };

  await assertRoutesNormal();

  // Semantic edit: a new node makes the old result previous.
  await openComponents(page);
  await page.getByRole('button', { name: 'Add: KV store' }).click();
  await expect(page.getByTestId('rf__node-kv-1')).toBeVisible();
  await expect(page.locator('.parcel-header__meta .ui-pill')).toHaveText(
    'Previous result',
  );
  await expect(page.locator('.parcel-canvas-note--stale')).toBeVisible();
  await assertRoutesNormal();

  // A seed change also makes the old result previous without greying routes.
  await setSeed(page, 202);
  await expect(page.locator('.parcel-header__meta .ui-pill')).toHaveText(
    'Previous result',
  );
  await assertRoutesNormal();

  // Reset clears the run and starts ready, not stale.
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Restore the Parcel starter?',
  });
  await dialog.getByRole('button', { name: 'Reset graph' }).click();
  await expect(page.locator('.parcel-header__meta .ui-pill')).toHaveText(
    'Ready to run',
  );
  await expect(page.locator('.parcel-canvas-note--stale')).toHaveCount(0);
  await expect(page.getByText(/Run result · seed/)).toHaveCount(0);
  await assertRoutesNormal();

  expect(pageErrors).toEqual([]);
});
