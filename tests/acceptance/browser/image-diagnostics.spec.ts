import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

/**
 * Real production-Worker check for the optional Guided analysis layer.
 *
 * The failing graph is imported into the real Image Atlas UI, the qualification
 * runs in the browser Worker, and the assertions read only the telemetry that
 * the Worker produced. Nothing is injected or fabricated.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const artifactDir = resolve(
  process.cwd(),
  process.env.ACCEPTANCE_ARTIFACT_DIR ?? 'test-results/acceptance',
);
const failingGraph = join(repoRoot, 'fixtures/images/fail-routing.json');

function trackErrors(page: Page): () => void {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  return () => {
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  };
}

test('Image Atlas explains a failed case gate and Guided analysis toggles off', async ({
  page,
}) => {
  const expectNoErrors = trackErrors(page);
  await page.goto('/#image-atlas');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Image Atlas' }),
  ).toBeVisible();

  await page
    .getByLabel('Open saved graph file')
    .setInputFiles(failingGraph);
  await expect(page.getByText('File opened')).toBeVisible();

  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('Not qualified', { exact: true })).toBeVisible({
    timeout: 300_000,
  });

  const tabs = page.getByRole('tablist', { name: 'Qualification case' });
  await expect(tabs).toBeVisible();
  const failingTab = tabs.getByRole('tab', { name: /Region outage: NA/ });
  await expect(failingTab).toContainText('fail');
  await failingTab.click();

  const guided = page.getByRole('checkbox', { name: 'Guided analysis' });
  await expect(guided).toBeChecked();
  const explanation = page.locator('.image-gate-explanation').first();
  await expect(explanation).toBeVisible();
  await expect(explanation).toContainText('Possible cause');
  await expect(explanation).toContainText('Evidence');
  await expect(explanation).toContainText('Check next');
  // Real Worker error codes, not injected telemetry.
  await expect(explanation).toContainText(/no_healthy_route [\d,]+/);
  await expect(explanation).toContainText('raw node outcomes by final route');
  await expect(explanation).toContainText(
    'not operation totals or local root causes',
  );
  // The full-case gate keeps the incident scope explicit.
  await expect(explanation).toContainText('This is a full-case gate');
  await expect(explanation).toContainText(
    'cannot prove what happened inside it',
  );
  // The user-facing ratio gate is a percentage, never a bare ratio.
  await expect(page.locator('.game-table .is-fail').first()).toBeVisible();
  await expect(page.getByText('88.87%').first()).toBeVisible();

  const seed = page.getByLabel('Seed');
  await expect(seed).toHaveValue('101');
  await expect(page.getByText('Evaluation · seed 101')).toBeVisible();

  await guided.uncheck();
  await expect(guided).not.toBeChecked();
  await expect(page.locator('.image-gate-explanation')).toHaveCount(0);
  // Raw gates, metrics and errors remain.
  await expect(page.getByText('Gates and advisories for this case')).toBeVisible();
  await expect(
    page.getByText('Measured operations · 60 s window, successful percentiles only'),
  ).toBeVisible();
  await expect(page.locator('.game-table .is-fail').first()).toBeVisible();
  await expect(seed).toHaveValue('101');
  await expect(page.getByText('Evaluation · seed 101')).toBeVisible();

  await guided.check();
  const readableExplanation = page.locator('.image-gate-explanation').first();
  await expect(readableExplanation).toBeVisible();
  await readableExplanation.scrollIntoViewIfNeeded();
  await readableExplanation.screenshot({
    path: join(artifactDir, 'image-atlas-guided-analysis.png'),
  });

  expectNoErrors();
});
