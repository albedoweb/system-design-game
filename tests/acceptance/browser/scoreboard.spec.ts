import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * Focused Live Scoreboard acceptance. It uses the real production Worker and
 * the actual engine result; nothing here is a mocked evaluator.
 *
 * The three solution families are represented by real graph documents imported
 * through the same explicit file path a player uses. Run this suite after the
 * S100 runtime commit is present in the tree.
 */

test.setTimeout(240_000);

interface GraphNode {
  id: string;
  kind: 'users' | 'app' | 'sql' | 'cache';
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
}

interface GraphDoc {
  schemaVersion: 1;
  levelId: 'live-scoreboard';
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function fixture(name: string): GraphDoc {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'fixtures', 'scoreboard', `${name}.json`),
      'utf8',
    ),
  ) as GraphDoc;
}

/** Canonical S100 fixtures; the engine calibration used these documents. */
const AGGREGATE_PASS = fixture('family-aggregate');
const CACHE_PASS = fixture('family-cache');
const FULL_SCAN_PASS = fixture('family-fullscan');
const SMALL_SCAN_FAIL = fixture('fail-small-scan');

function stateFile(graphDoc: GraphDoc, seed = 101): string {
  return JSON.stringify(
    {
      kind: 'sdg-level-state',
      stateVersion: 1,
      levelId: 'live-scoreboard',
      contentVersion: '1.0.0',
      savedAt: '2026-11-01T00:00:00.000Z',
      seed,
      graph: graphDoc,
    },
    null,
    2,
  );
}

async function openLevel(page: Page) {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto('/#live-scoreboard');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Live Scoreboard' }),
  ).toBeVisible();
}

async function importGraph(page: Page, graphDoc: GraphDoc, seed = 101) {
  await page.getByLabel('Open saved graph file').setInputFiles({
    name: `live-scoreboard-${seed}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(stateFile(graphDoc, seed)),
  });
  await expect(page.getByText('File opened')).toBeVisible();
}

async function runToReport(page: Page) {
  await page
    .getByRole('button', { name: /Run evaluation|Run again/ })
    .click();
  // Wait for the actual result summary, not the briefing heading "Passing
  // requirements", which is always present in the Task panel.
  await expect(page.locator('.scoreboard-summary__verdict strong')).toBeVisible({
    timeout: 180_000,
  });
  await expect(
    page.locator('.game-report-section').filter({ hasText: 'Requirements' }),
  ).toBeVisible();
}

function verdict(page: Page) {
  return page.locator('.scoreboard-summary__verdict strong');
}

test('compact header keeps the title, costs and run controls separate', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#live-scoreboard');
  await expect(page.getByRole('heading', { level: 1, name: 'Live Scoreboard' })).toBeVisible();

  const checkLayout = async () => {
    for (const selector of ['.scoreboard-header > *', '.scoreboard-header__meta > *']) {
      const boxes = await page.locator(selector).evaluateAll((elements) =>
        elements.map((element) => {
          const { left, right, top, bottom } = element.getBoundingClientRect();
          return { left, right, top, bottom };
        }),
      );
      for (const [index, box] of boxes.entries()) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(390);
        for (const other of boxes.slice(index + 1)) {
          const width = Math.min(box.right, other.right) - Math.max(box.left, other.left);
          const height = Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top);
          expect(width <= 0.5 || height <= 0.5, `${selector} areas overlap`).toBe(true);
        }
      }
    }
  };

  await checkLayout();
  await importGraph(page, AGGREGATE_PASS);
  await runToReport(page);
  await expect(verdict(page)).toContainText('Passed');
  await checkLayout();
  await page.screenshot({ path: testInfo.outputPath('compact-header.png'), fullPage: true });
});

test('starter, navigation, help, connect and settings use the real graph model', async ({
  page,
}) => {
  await openLevel(page);

  // Level tabs were removed: the level is reached only by its direct hash.
  await expect(page.getByRole('navigation', { name: 'Levels' })).toHaveCount(0);
  for (const title of ['Live Scoreboard', 'Cold Cache', 'Parcel Pulse', 'Image Atlas']) {
    await expect(page.getByRole('link', { name: new RegExp(title) })).toHaveCount(0);
  }

  // Starter: Users only, no automatic draft/result.
  await expect(page.getByTestId('rf__node-users')).toBeVisible();
  await expect(page.getByTestId('rf__node-app-1')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run evaluation' })).toBeEnabled();
  await expect(page.getByLabel('Seed')).toHaveValue('101');
  await expect(page.getByText('No result yet')).toBeVisible();

  // Help stays available and the Live Scoreboard guide exists.
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Level guide' }).click();
  await expect(
    dialog.locator('.help-level-head').getByRole('heading', {
      name: 'Live Scoreboard',
    }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close help' }).click();

  // Add the three general components from the palette.
  await page.getByRole('tab', { name: 'Components' }).click();
  for (const name of ['Application', 'SQL Database', 'Cache']) {
    await page.getByRole('button', { name: `Add: ${name}` }).click();
  }
  await expect(page.getByTestId('rf__node-app-1')).toBeVisible();
  await expect(page.getByTestId('rf__node-sql-1')).toBeVisible();
  await expect(page.getByTestId('rf__node-cache-1')).toBeVisible();

  // Connect through the dialog. Roles are inferred from the pair.
  const connect = async (source: string, target: string) => {
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Source').selectOption(source);
    await modal.getByLabel('Target').selectOption(target);
    await modal.getByRole('button', { name: 'Create connection' }).click();
  };
  await connect('users', 'app-1');
  await connect('app-1', 'sql-1');
  await connect('app-1', 'cache-1');
  await connect('cache-1', 'sql-1');
  await expect(page.getByText('read / write', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('traffic', { exact: true }).first()).toBeVisible();

  // Settings from the catalog: instance count, database plan and cache TTL.
  await page.getByTestId('rf__node-app-1').click();
  await page.getByLabel('Instances').selectOption('2');
  await expect(page.getByText('2 instances · 2 CPU · 16 GB')).toBeVisible();

  await page.getByTestId('rf__node-sql-1').click();
  await page.getByLabel('Size').selectOption('medium');
  await page
    .getByLabel('How the ranking is obtained')
    .selectOption('aggregate');
  await expect(page.getByTestId('rf__node-sql-1')).toContainText(
    'Maintain a vote aggregate',
  );

  await page.getByTestId('rf__node-cache-1').click();
  await page.getByLabel('TTL').selectOption('5');
  await expect(page.getByTestId('rf__node-cache-1')).toContainText('TTL 5 s');

  // Users is fixed and undeletable.
  await page.getByTestId('rf__node-users').click();
  await expect(
    page.getByRole('button', { name: 'Delete component' }),
  ).toHaveCount(0);
});

test('aggregate, cache and full-scan families pass with real results; small scan fails', async ({
  page,
}) => {
  await openLevel(page);

  for (const [name, graphDoc] of [
    ['aggregate', AGGREGATE_PASS],
    ['cache', CACHE_PASS],
    ['full scan', FULL_SCAN_PASS],
  ] as const) {
    await importGraph(page, graphDoc);
    await runToReport(page);
    await expect(verdict(page), `${name} should pass`).toContainText(
      'Passed',
      { timeout: 5_000 },
    );
    // Charts and report are real engine series, not placeholders.
    await expect(page.getByRole('heading', { name: 'Telemetry' })).toBeVisible();
    await expect(page.getByText('Traffic', { exact: true })).toBeVisible();
    await expect(page.getByText('Latency', { exact: true })).toBeVisible();
    await expect(page.getByText('Queue · selected component')).toBeVisible();
    await expect(page.getByText('CPU · selected component')).toBeVisible();
    // Availability never renders as a bare 0.99/1.00 ratio.
    await expect(page.locator('.game-table').first()).toContainText(/%/);
    // Small actual costs keep enough precision and hourly rent is separate.
    const costSection = page
      .locator('.game-report-section')
      .filter({ hasText: 'Actual run cost' });
    await expect(costSection.getByText(/\$\d+\.\d{4,6}/).first()).toBeVisible();
    await expect(page.getByText(/Hourly rent/).first()).toBeVisible();
  }

  await importGraph(page, SMALL_SCAN_FAIL);
  await runToReport(page);
  await expect(verdict(page)).toContainText('Not passed');
  await expect(page.getByText('Not ranked').first()).toBeVisible();
  await expect(page.getByText(/availability|Availability/i).first()).toBeVisible();
});

test('stale, drag, export/import, refresh and reset keep the graph explicit', async ({
  page,
}) => {
  await openLevel(page);
  await importGraph(page, AGGREGATE_PASS, 307);
  await expect(page.getByLabel('Seed')).toHaveValue('307');
  await runToReport(page);
  await expect(verdict(page)).toContainText('Passed');

  // Dragging a node is editor-only and does not stale the result.
  const node = page.getByTestId('rf__node-app');
  const box = await node.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 40, box!.y + 20);
  await page.mouse.down();
  await page.mouse.move(box!.x + 150, box!.y + 90, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByText('Previous result — the semantic graph')).toHaveCount(
    0,
  );
  await expect(verdict(page)).toContainText('Passed');

  // A semantic setting change stales the result but keeps semantic edge labels.
  await page.getByTestId('rf__node-sql').click();
  await page
    .getByLabel('How the ranking is obtained')
    .selectOption('scan');
  await expect(
    page.getByText('Previous result — the semantic graph or seed changed.'),
  ).toBeVisible();
  await expect(page.getByText('read / write', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Old telemetry and measured pressure are hidden')).toBeVisible();

  // Export, reset, then open the file again.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const download = await downloadPromise;
  const savedPath = await download.path();
  expect(savedPath).not.toBeNull();
  const saved = JSON.parse(await readFile(savedPath!, 'utf8')) as {
    seed: number;
    graph: GraphDoc;
  };
  expect(saved.seed).toBe(307);
  expect(saved.graph.nodes.some((item) => item.id === 'sql')).toBe(true);

  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  const resetDialog = page.getByRole('dialog');
  await resetDialog.getByRole('button', { name: 'Reset graph' }).click();
  await expect(page.getByTestId('rf__node-app')).toHaveCount(0);
  await expect(page.getByLabel('Seed')).toHaveValue('101');
  await expect(page.getByText('No result yet')).toBeVisible();

  await page.getByLabel('Open saved graph file').setInputFiles(savedPath!);
  await expect(page.getByText('File opened')).toBeVisible();
  await expect(page.getByTestId('rf__node-sql')).toBeVisible();
  await expect(page.getByLabel('Seed')).toHaveValue('307');

  // Refresh starts from Users, the default seed and no previous result.
  await page.reload();
  await expect(page.getByTestId('rf__node-users')).toBeVisible();
  await expect(page.getByTestId('rf__node-sql')).toHaveCount(0);
  await expect(page.getByLabel('Seed')).toHaveValue('101');
  await expect(page.getByText('No result yet')).toBeVisible();
});

test('two browser tabs keep independent editor state; Stop never reports a pass', async ({
  page,
  context,
}) => {
  await openLevel(page);
  await page.getByRole('tab', { name: 'Components' }).click();
  await page.getByRole('button', { name: 'Add: Application' }).click();
  await expect(page.getByTestId('rf__node-app-1')).toBeVisible();

  const second = await context.newPage();
  await second.setViewportSize({ width: 1500, height: 950 });
  await second.goto('/#live-scoreboard');
  await expect(second.getByTestId('rf__node-users')).toBeVisible();
  await expect(second.getByTestId('rf__node-app-1')).toHaveCount(0);
  await second.getByRole('tab', { name: 'Components' }).click();
  await second.getByRole('button', { name: 'Add: SQL Database' }).click();
  await expect(second.getByTestId('rf__node-sql-1')).toBeVisible();
  await expect(page.getByTestId('rf__node-sql-1')).toHaveCount(0);
  await second.close();

  // Start a real run and stop it; the outcome is incomplete/cancelled, never a
  // fabricated pass. The raw full scan keeps the Stop control available.
  await importGraph(page, FULL_SCAN_PASS);
  await page
    .getByRole('button', { name: /Run evaluation|Run again/ })
    .click();
  const stop = page.getByRole('button', { name: 'Stop' });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(
    page.getByRole('button', { name: /Run evaluation|Run again/ }),
  ).toBeEnabled({ timeout: 30_000 });
  if ((await verdict(page).count()) > 0) {
    await expect(verdict(page)).not.toContainText('Passed');
  }
  // The workspace remains usable after cancellation.
  await expect(page.getByTestId('rf__node-users')).toBeVisible();
});
