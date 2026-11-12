import { expect, test } from '@playwright/test';

const ORIGIN = 'http://127.0.0.1:5178';

test('Copy link opens the same design in a new page and removes the fragment', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    baseURL: ORIGIN,
  });
  const page = await context.newPage();
  await page.goto('/#global-cart');
  await expect(page.getByLabel('Seed', { exact: true })).toBeVisible();
  const nodes = page.locator('.react-flow__node');
  const starterCount = await nodes.count();

  await page.getByRole('button', { name: 'Build', exact: true }).click();
  await page.locator('.cart-palette__add:enabled').first().click();
  await expect(nodes).toHaveCount(starterCount + 1);
  const originalIds = await nodes.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-id')));

  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Design link copied to the clipboard.' })).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link.startsWith(`${ORIGIN}/#design=`)).toBe(true);

  const opened = await context.newPage();
  await opened.goto(link);
  await expect(opened.getByRole('status').filter({ hasText: 'Design loaded from link' })).toBeVisible();
  await expect(opened.locator('.react-flow__node')).toHaveCount(starterCount + 1);
  const openedIds = await opened.locator('.react-flow__node').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-id')));
  expect(openedIds.sort()).toEqual(originalIds.sort());
  expect(new URL(opened.url()).hash).toBe('');
});

test('#cold-cache still opens the legacy level and #design=garbage opens Cart with an error', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: ORIGIN });

  const legacy = await context.newPage();
  await legacy.goto('/#cold-cache');
  await expect(legacy.getByRole('heading', { level: 1, name: 'Cold Cache' })).toBeVisible();

  const cart = await context.newPage();
  await cart.goto('/#design=garbage');
  await expect(cart.getByRole('heading', { level: 1, name: 'Global Cart' })).toBeVisible();
  await expect(cart.getByRole('status').filter({ hasText: 'This design link is damaged or cannot be read. The starter design is shown.' })).toBeVisible();
  await expect(cart.getByRole('heading', { level: 1, name: 'Cold Cache' })).toHaveCount(0);
  expect(new URL(cart.url()).hash).toBe('');
});
