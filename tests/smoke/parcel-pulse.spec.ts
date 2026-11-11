import { mkdirSync } from 'node:fs';

import { expect, test } from '@playwright/test';

const PARCEL_URL = '/#parcel-pulse';

async function collectPageErrors(page: import('@playwright/test').Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function expectNoViewportOverflow(page: import('@playwright/test').Page) {
  const layout = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
  }));
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.innerHeight + 1);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
}

test('Parcel Pulse loads from its hash route after a same-page switch from Cold Cache', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const pageErrors = await collectPageErrors(page);

  await page.goto('/#cold-cache');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Cold Cache' }),
  ).toBeVisible();
  // Level tabs were removed; switch by hash on the same page instance.
  await page.evaluate(() => {
    window.location.hash = '#parcel-pulse';
  });

  await expect(
    page.getByRole('heading', { level: 1, name: 'Parcel Pulse' }),
  ).toBeVisible();
  await expect(
    page.getByRole('complementary', { name: 'Task and components' }),
  ).toBeVisible();
  await expect(
    page.getByRole('complementary', { name: 'Inspector' }),
  ).toBeVisible();
  await expect(page.getByTestId('rf__node-client-1')).toBeVisible();
  await expect(page.getByTestId('rf__node-app-1')).toBeVisible();
  await expect(page.getByTestId('rf__node-sql-1')).toBeVisible();
  await expect(page.getByText('44.8512 TB at year 5')).toBeVisible();
  await expect(page.getByText('Monthly cost')).toBeVisible();
  await expect(page.getByText(/1,250 budget/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run evaluation' })).toBeEnabled();
  await expectNoViewportOverflow(page);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(
    page.getByRole('complementary', { name: 'Task and components' }),
  ).toBeHidden();
  await expect(page.getByTestId('rf__node-sql-1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Task' })).toBeVisible();
  await page.getByRole('button', { name: 'Properties' }).click();
  await expect(
    page.getByRole('complementary', { name: 'Inspector' }),
  ).toBeVisible();
  await expectNoViewportOverflow(page);

  mkdirSync('test-results/screenshots', { recursive: true });
  await page.screenshot({
    path: 'test-results/screenshots/parcel-1280x800.png',
    fullPage: true,
  });

  expect(pageErrors).toEqual([]);
});

test('dialog focus suppresses graph Delete and undo shortcuts until the dialog closes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const pageErrors = await collectPageErrors(page);
  await page.goto(PARCEL_URL);

  await page.getByRole('tab', { name: 'Components' }).click();
  await page.getByRole('button', { name: 'Add: KV store' }).click();
  await expect(page.getByTestId('rf__node-kv-1')).toBeVisible();

  await page.getByTestId('rf__node-sql-1').click();
  await expect(
    page.getByRole('complementary', { name: 'Inspector' }),
  ).toContainText('SQL store');

  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect nodes' });
  await expect(dialog).toBeVisible();
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  await cancel.focus();

  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Control+z');

  await expect(page.getByTestId('rf__node-sql-1')).toBeVisible();
  await expect(page.getByTestId('rf__node-kv-1')).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(5);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.keyboard.press('Delete');
  await expect(page.getByTestId('rf__node-sql-1')).toHaveCount(0);

  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('rf__node-sql-1')).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('runs the real evaluation worker and shows measured and analytical results', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  const pageErrors = await collectPageErrors(page);
  await page.goto(PARCEL_URL);

  await page.getByRole('button', { name: 'Run evaluation' }).click();
  await expect(page.getByText(/Run result · seed 101/)).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('Operations · Year 5', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Analytical capacity · Year 5', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Cost and five-year TCO', { exact: true })).toBeVisible();
  await expect(page.getByText('Work performed · Year 5', { exact: true })).toBeVisible();
  await expect(page.getByText('Workload window', { exact: true })).toBeVisible();
  await expect(page.getByText(/Traffic is simulated for 60 seconds/)).toBeVisible();

  const operations = page
    .locator('table')
    .filter({ hasText: 'Measured request metrics' })
    .first();
  const statusRow = operations.locator('tbody tr', { hasText: 'Status' }).first();
  const offered = statusRow.locator('td').nth(0);
  await expect(offered).not.toHaveText('0');
  expect(Number((await offered.textContent())?.replaceAll(',', ''))).toBeGreaterThan(0);

  await page.getByRole('tab', { name: /Year 1/ }).click();
  await expect(page.getByText('Operations · Year 1', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Analytical capacity · Year 1', { exact: true }),
  ).toBeVisible();

  mkdirSync('test-results/screenshots', { recursive: true });
  await page.screenshot({
    path: 'test-results/screenshots/parcel-run-1400x900.png',
    fullPage: true,
  });

  expect(pageErrors).toEqual([]);
});

test('label and position changes keep a result fresh while semantic edits stale it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  const pageErrors = await collectPageErrors(page);
  await page.goto(PARCEL_URL);

  await page.getByRole('button', { name: 'Run evaluation' }).click();
  await expect(page.getByText(/Run result · seed 101/)).toBeVisible({
    timeout: 60_000,
  });
  const pill = page.locator('.parcel-header__meta .ui-pill');
  const verdict = await pill.textContent();
  await expect(page.locator('.parcel-canvas-note--stale')).toHaveCount(0);

  await page.getByTestId('rf__node-sql-1').click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const name = inspector.getByLabel('Name');
  await name.fill('Events archive');
  await name.press('Enter');
  await expect(page.getByTestId('rf__node-sql-1')).toContainText('Events archive');

  const moved = await page.getByTestId('rf__node-sql-1').boundingBox();
  expect(moved).not.toBeNull();
  await page.mouse.move(moved!.x + moved!.width / 2, moved!.y + 20);
  await page.mouse.down();
  await page.mouse.move(moved!.x + moved!.width / 2 + 40, moved!.y + 50, {
    steps: 8,
  });
  await page.mouse.up();

  await expect(page.locator('.parcel-canvas-note--stale')).toHaveCount(0);
  await expect(pill).toHaveText(verdict ?? '');

  const retention = inspector.getByLabel('Retention');
  await retention.selectOption('5');
  await expect(page.locator('.parcel-canvas-note--stale')).toBeVisible();
  await expect(pill).toHaveText('Previous result');

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(retention).toHaveValue('1');
  await expect(page.locator('.parcel-canvas-note--stale')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(retention).toHaveValue('5');
  await expect(page.locator('.parcel-canvas-note--stale')).toBeVisible();

  await page.waitForTimeout(850);
  await page.reload();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Parcel Pulse' }),
  ).toBeVisible();
  // No automatic draft restore: reload starts the starter graph, default seed
  // and no run, while the shared browser storage is left untouched.
  await expect(page.getByText(/Draft restored/)).toHaveCount(0);
  await expect(page.locator('.parcel-header-seed input')).toHaveValue('101');
  await expect(pill).toHaveText('Ready to run');
  await expect(page.locator('.parcel-canvas-note--stale')).toHaveCount(0);
  await expect(page.getByText(/Run result · seed/)).toHaveCount(0);
  await page.getByTestId('rf__node-sql-1').click();
  const restoredInspector = page.getByRole('complementary', {
    name: 'Inspector',
  });
  await expect(restoredInspector.getByLabel('Name')).toHaveValue('SQL store');
  await expect(restoredInspector.getByLabel('Retention')).toHaveValue('1');

  expect(pageErrors).toEqual([]);
});

test('connects a store, edits the route operation and deletes it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const pageErrors = await collectPageErrors(page);
  await page.goto(PARCEL_URL);

  await page.getByRole('tab', { name: 'Components' }).click();
  await page.getByRole('button', { name: 'Add: KV store' }).click();
  await expect(page.getByTestId('rf__node-kv-1')).toBeVisible();

  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect nodes' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Source', { exact: true }).selectOption('app-1');
  await dialog.getByLabel('Target', { exact: true }).selectOption('kv-1');
  await dialog
    .getByLabel('Operation on this route')
    .selectOption('history');
  await dialog.getByRole('button', { name: 'Create route' }).click();

  const routeLabels = page.getByRole('button', { name: 'Select history route' });
  await expect(routeLabels).toHaveCount(2);
  await routeLabels.last().click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(
    inspector.getByRole('heading', { level: 2, name: /Application → KV store/ }),
  ).toBeVisible();
  await expect(inspector.getByLabel('Operation', { exact: true })).toHaveValue(
    'history',
  );

  await inspector.getByLabel('Operation', { exact: true }).selectOption('status');
  await expect(
    page.getByRole('button', { name: 'Select status route' }),
  ).toHaveCount(2);
  await inspector.getByRole('button', { name: 'Delete route' }).click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(5);

  expect(pageErrors).toEqual([]);
});

test('leaving the level during a real run stops and unlocks the run on return', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  const pageErrors = await collectPageErrors(page);
  await page.goto(PARCEL_URL);

  await page.getByRole('button', { name: 'Run evaluation' }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  // Leave by hash on the same page instance (no reload) so the run is torn down.
  await page.evaluate(() => {
    window.location.hash = '#cold-cache';
  });
  await expect(
    page.getByRole('heading', { level: 1, name: 'Cold Cache' }),
  ).toBeVisible();
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.location.hash = '#parcel-pulse';
  });

  await expect(
    page.getByRole('heading', { level: 1, name: 'Parcel Pulse' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Run (evaluation|again)/ })).toBeEnabled();
  await expect(page.locator('.parcel-canvas-note--locked')).toHaveCount(0);
  await expect(
    page.locator('#parcel-results-body').getByText('Run cancelled', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('No partial result')).toBeVisible();
  await expect(page.getByText(/Run result · seed/)).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
