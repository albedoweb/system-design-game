import { expect, test } from '@playwright/test';
import path from 'node:path';

test('Cart editor exposes properties, semantic paths and real run activity', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/#global-cart');
  const seed = page.getByLabel('Seed', { exact: true });
  await expect(seed).toBeVisible();
  const input = (await seed.boundingBox())!;
  const label = (await page.locator('.cart-toolbar__seed label').boundingBox())!;
  expect(Math.abs(input.y + input.height / 2 - label.y - label.height / 2)).toBeLessThan(4);
  await page.getByLabel('Open saved Global Cart design file').setInputFiles(path.resolve('tests/fixtures/cart/basic/reference-basic.json'));
  await page.getByRole('status').filter({ hasText: /Design imported/ }).waitFor();
  // The Task panel is open by default; at this compact width it is an overlay, so close it (Escape) before using the canvas.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Task', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.locator('.react-flow__node[data-id="app-us-west"]').click();
  await expect(page.locator('#cart-app-write')).toHaveValue('journal-us-west');
  await page.locator('.react-flow__node[data-id="app-eu-central"]').click();
  await expect(page.locator('#cart-app-write')).toHaveValue('journal-eu-central');
  await expect(page.locator('.cart-edge-label').filter({ hasText: 'Read + Write' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close panels', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: 'Evaluation progress' })).toBeVisible();
  await expect(page.getByText(/0 \/ 2 scenarios completed/)).toBeVisible();
  await expect(page.getByText(/\/ 54,000 requests started in this scenario/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Close panels', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('.cart-run-progress')).toHaveClass(/is-paused/);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByText('Both scenarios meet every requirement.').first().waitFor({ timeout: 200_000 });
});

test('live problems can be stopped and inspected without a final score', async ({ page }) => {
  test.setTimeout(120_000);
  const { readFile } = await import('node:fs/promises');
  const graph = JSON.parse(await readFile(path.resolve('tests/fixtures/cart/basic/reference-basic.json'), 'utf8'));
  graph.nodes = graph.nodes.filter((node: { id: string }) => node.id !== 'app-us-west');
  graph.edges = graph.edges.filter((edge: { from: string; to: string }) => edge.from !== 'app-us-west' && edge.to !== 'app-us-west');
  await page.goto('/#global-cart');
  await page.getByLabel('Open saved Global Cart design file').setInputFiles({ name: 'missing-inventory-path.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph)) });
  await page.getByRole('status').filter({ hasText: /Design imported/ }).waitFor();
  // Close the open-by-default Task overlay at this compact viewport before running.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Task', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.cart-run-warning')).toContainText('request problems observed', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Stop & inspect', exact: true }).click();
  const report = page.getByRole('dialog', { name: 'Global Cart results' });
  await expect(report).toBeVisible({ timeout: 15_000 });
  await expect(report).toContainText('Partial report');
  await expect(report).toContainText('no final score');
  await expect(report.getByRole('heading', { name: 'Run snapshot', exact: true })).toBeVisible();
  await expect(report.getByRole('table', { name: 'Requests by operation' })).toContainText('checkout');
  await expect(report.getByRole('table', { name: 'Resource usage by component' })).toContainText('Memory used / capacity');
  await report.getByRole('heading', { name: 'Run snapshot', exact: true }).scrollIntoViewIfNeeded();
  // Kept with the test's own artifacts; an absolute macOS path would fail on a Linux runner.
  await page.screenshot({ path: test.info().outputPath('cart-partial-report.png') });
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
});
