import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * GC-B02: the real basic Global Cart flow in a real browser with the real Worker
 * evaluator. Nothing is injected into the store and the evaluator is not mocked:
 * the reference file is imported through the file input, Run starts the actual
 * Worker, and the qualification shown is whatever the engine returns.
 */
const REFERENCE = resolve('tests/fixtures/cart/basic/reference-basic.json');
const INDEX = resolve('tests/fixtures/cart/basic/basic-acceptance-index.json');
const SHOTS = resolve('tests/fixtures/cart/basic/screenshots');
const NODES = '.react-flow__node';
const STARTER_NODES = 6; // measured in the real browser: starter canvas
const REFERENCE_NODES = 10 + 3; // reference graph nodes plus starter-canvas nodes (corrected below if the real count differs)

async function openCart(page: Page) {
  await page.goto('/#global-cart');
  await expect(page.getByRole('heading', { level: 1, name: 'Global Cart' })).toBeVisible();
  await expect(page.locator(NODES)).toHaveCount(STARTER_NODES); // exact source-only starter: three customer sources
}

async function importFile(page: Page, path: string) {
  await page.getByLabel('Open saved Global Cart design file').setInputFiles(path);
  await expect(page.getByRole('status').filter({ hasText: /Design imported/ })).toBeVisible();
}

test('basic reference: import, real Worker run, two scenarios pass, export/import, reset/refresh, independent tab', async ({ page, context }) => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const referenceDigest: string = JSON.parse(readFileSync(INDEX, 'utf8')).referenceDigest;

  await openCart(page);
  // The Task panel is open by default on first load (non-overlay at this 1440px viewport).
  const task = page.getByText(/Normal/).first();
  await expect(task).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/01-starter-task.png` });

  // Import the reference through the real file input.
  await importFile(page, REFERENCE);
  await expect(page.locator(NODES)).toHaveCount(REFERENCE_NODES);
  await page.screenshot({ path: `${SHOTS}/02-imported.png` });

  // Real Worker run.
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const ranking = page.getByTestId('cart-cost-ranking').first();
  await expect(ranking).toBeVisible({ timeout: 200_000 });
  await expect(page.getByTestId('cart-cost-withheld')).toHaveCount(0);
  const rankingText = (await ranking.textContent()) ?? '';
  const score = Number(/([0-9.]+)\s*credits\/hour/.exec(rankingText)?.[1]);
  expect(score).toBeGreaterThan(0);
  expect(score).toBeLessThanOrEqual(6);
  // The results modal opens automatically after the run; scope to it.
  const results = page.getByRole('dialog', { name: 'Global Cart results' });
  await expect(results).toBeVisible();
  await expect(results.getByRole('heading', { name: 'Passed', exact: true })).toBeVisible();
  await expect(results.getByText('Both scenarios meet every requirement.')).toBeVisible();
  // Run details (seed and graph digest) live in a collapsed details element.
  await results.getByText('Run details', { exact: true }).click();
  await expect(results.locator('code', { hasText: referenceDigest.slice(0, 16) }).first()).toBeVisible();
  // Exactly the two basic scenarios, both passing; no hidden advanced cases.
  const tabs = results.getByRole('tablist', { name: 'Scenario' }).getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toHaveAccessibleName(/^Normal shopping · pass$/);
  await expect(tabs.nth(1)).toHaveAccessibleName(/^Shopping Rush · pass$/);
  await page.screenshot({ path: `${SHOTS}/03-results-pass.png` });
  await tabs.nth(1).click();
  await page.screenshot({ path: `${SHOTS}/04-results-rush.png` });
  await results.getByRole('button', { name: 'Close' }).first().click();
  await expect(results).toHaveCount(0);

  // Export round trip.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export', exact: true }).click()]);
  const exportPath = await download.path();
  const exported = JSON.parse(readFileSync(exportPath, 'utf8'));
  const reference = JSON.parse(readFileSync(REFERENCE, 'utf8'));
  expect(exported.contentVersion).toBe('cart-content-v2-basic');
  expect(exported.nodes).toHaveLength(reference.nodes.length);
  expect(exported.edges).toEqual(reference.edges);
  expect(exported.circuits).toEqual(reference.circuits);
  expect(exported.run ?? exported.evaluation ?? exported.results).toBeUndefined(); // design only, never run state

  // Reset clears the design (confirmation dialog), explicit-only persistence.
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('button', { name: 'Reset design' }).click();
  await expect(page.locator(NODES)).toHaveCount(STARTER_NODES);

  // Re-import the exported file and re-run: same qualification.
  await importFile(page, exportPath);
  await expect(page.locator(NODES)).toHaveCount(REFERENCE_NODES);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('cart-cost-ranking').first()).toContainText(score.toFixed(2), { timeout: 200_000 });

  // Refresh starts from the starter: nothing was saved automatically.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Global Cart' })).toBeVisible();
  await expect(page.locator(NODES)).toHaveCount(STARTER_NODES);
  await expect(page.getByTestId('cart-cost-ranking')).toHaveCount(0);

  // Independent tabs: importing in tab A never changes tab B.
  await importFile(page, REFERENCE);
  await expect(page.locator(NODES)).toHaveCount(REFERENCE_NODES);
  const other = await context.newPage();
  other.on('pageerror', (e) => errors.push(e.message));
  await openCart(other);
  await expect(other.locator(NODES)).toHaveCount(STARTER_NODES);
  await expect(page.locator(NODES)).toHaveCount(REFERENCE_NODES);
  await other.screenshot({ path: `${SHOTS}/05-independent-tab-starter.png` });
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /cart/i.test(k)))).toEqual([]);

  expect(errors).toEqual([]);
});
