import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * Focused Live Audience acceptance. It uses the real production Worker and the
 * actual evaluator result; nothing here is a mocked engine.
 *
 * Run after the A101 runtime commit is present in the tree, with a real built
 * preview. `ACCEPTANCE_BASE_URL` (or `AUDIENCE_BASE_URL`) selects the owned
 * preview port, for example http://127.0.0.1:5183.
 */

test.setTimeout(360_000);

interface GraphNode {
  id: string;
  kind: 'users' | 'lb' | 'app' | 'sql' | 'cache' | 'worker';
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

interface GraphDoc {
  schemaVersion: 1;
  levelId: 'live-audience';
  nodes: GraphNode[];
  edges: Array<{ id: string; from: string; to: string }>;
}

function fixture(name: string): GraphDoc {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'fixtures', 'audience', `${name}.json`),
      'utf8',
    ),
  ) as GraphDoc;
}

/** Canonical A100 fixtures; pass labels remain hypotheses until A101 calibrates. */
const PROJECTION = fixture('family-projection');
const QUERY_LARGE = fixture('family-query-large');
const CACHE_QUERY = fixture('family-cache-query');
const SINGLE_APP_FAIL = fixture('fail-single-app');

function stateFile(graphDoc: GraphDoc, seed = 101): string {
  return JSON.stringify(
    {
      kind: 'sdg-level-state',
      stateVersion: 1,
      levelId: 'live-audience',
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
  await page.goto('/#live-audience');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Live Audience' }),
  ).toBeVisible();
  await expect(page.locator('.audience-canvas-shell')).toHaveAttribute(
    'data-audience-canvas-ready',
    'true',
  );
}

async function importGraph(page: Page, graphDoc: GraphDoc, seed = 101) {
  await page.getByLabel('Open saved graph file').setInputFiles({
    name: `live-audience-${seed}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(stateFile(graphDoc, seed)),
  });
  await expect(page.getByText('File opened')).toBeVisible();
}

async function runToReport(page: Page) {
  await page
    .getByRole('button', { name: /Run evaluation|Run again/ })
    .click();
  await expect(page.locator('.audience-summary__verdict strong')).toBeVisible({
    timeout: 300_000,
  });
}

async function caseTab(page: Page, pattern: RegExp) {
  return page.getByRole('tab', { name: pattern });
}

async function selectCase(page: Page, pattern: RegExp) {
  await (await caseTab(page, pattern)).click();
}

test('starter, navigation, help, connect and settings use the real graph model', async ({
  page,
}, testInfo) => {
  await openLevel(page);

  // Level tabs were removed: the level is reached only by its direct hash.
  await expect(page.getByRole('navigation', { name: 'Levels' })).toHaveCount(0);
  for (const title of [
    'Live Audience',
    'Live Scoreboard',
    'Cold Cache',
    'Parcel Pulse',
    'Image Atlas',
  ]) {
    await expect(page.getByRole('link', { name: new RegExp(title) })).toHaveCount(0);
  }

  // Starter: Users only, default seed, no automatic draft or result.
  await expect(page.getByTestId('rf__node-users')).toBeVisible();
  await expect(page.getByTestId('rf__node-app-1')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run evaluation' })).toBeEnabled();
  await expect(page.getByLabel('Seed')).toHaveValue('101');
  await expect(page.getByText('No result yet')).toBeVisible();
  // The expected-incomplete starter is neutral, not a simulation failure.
  await expect(page.getByText('Build your system').first()).toBeVisible();
  await expect(page.getByTestId('rf__node-users')).not.toContainText('Error');
  await expect(page.getByTestId('rf__node-users')).not.toContainText('Check');
  expect(
    await page.evaluate(() =>
      Object.keys(window.localStorage).filter((key) =>
        key.toLowerCase().includes('audience'),
      ),
    ),
  ).toEqual([]);

  // Help keeps every earlier guide and adds a Live Audience guide.
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Level guide' }).click();
  await expect(
    dialog.locator('.help-level-head').getByRole('heading', {
      name: 'Live Audience',
    }),
  ).toBeVisible();
  await expect(dialog.getByText(/actual retention you select/)).toBeVisible();
  await expect(
    dialog.locator('.help-levels').getByRole('button', { name: /Image Atlas/ }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close help' }).click();

  // Users is fixed and undeletable even before the graph is complete.
  await page.getByTestId('rf__node-users').click();
  await expect(
    page.getByRole('button', { name: 'Delete component' }),
  ).toHaveCount(0);

  // Build the same route a player would, from the palette and Connect dialog.
  await page.getByRole('tab', { name: 'Components' }).click();
  const zoomOf = () =>
    page.locator('.react-flow__viewport').evaluate((element) =>
      new DOMMatrixReadOnly(getComputedStyle(element).transform).a,
    );
  const zoomBeforeAdd = await zoomOf();
  const add = async (name: string) => {
    await page.getByRole('button', { name: `Add: ${name}` }).click();
  };
  await add('Managed Load Balancer');
  await add('Application');
  // A newly added node is selected and panned into view, so its inspector
  // settings are available without hunting for an off-screen card.
  await page.getByLabel('Instances').selectOption('3');
  await expect(page.getByTestId('rf__node-app-1')).toContainText('3 instances');
  await add('SQL Database');
  await page.getByLabel('Size', { exact: true }).selectOption('medium');
  await page.getByLabel('How the ranking is obtained').selectOption('projection');
  await expect(page.getByTestId('rf__node-sql-1')).toContainText(
    'Maintained projection',
  );
  await add('Cache');
  await page.getByLabel('TTL').selectOption('15');
  await expect(page.getByTestId('rf__node-cache-1')).toContainText(
    'TTL 15 s · actual retention',
  );
  await expect(
    page.getByText(/honoured exactly as selected; nothing silently clamps it/),
  ).toBeVisible();
  await add('Worker pool');
  await page.getByLabel('Instances').selectOption('2');
  await expect(page.getByTestId('rf__node-worker-1')).toContainText(
    '2 instances',
  );
  await expect(page.getByTestId('rf__node-lb-1')).toBeVisible();
  await expect(page.getByTestId('rf__node-app-1')).toBeVisible();
  await expect(page.getByTestId('rf__node-sql-1')).toBeVisible();
  await expect(page.getByTestId('rf__node-cache-1')).toBeVisible();
  await expect(page.getByTestId('rf__node-worker-1')).toBeVisible();
  await expect(page.locator('.audience-canvas-shell')).toHaveAttribute(
    'data-audience-canvas-ready',
    'true',
  );

  // Adding all five addable kinds keeps the player's zoom and places cards in
  // free 2D slots instead of shrinking everything into one row.
  const zoomAfterAdd = await zoomOf();
  expect(Math.abs(zoomAfterAdd - zoomBeforeAdd)).toBeLessThan(0.02);
  const boxes = await page.locator('.react-flow__node').evaluateAll((elements) =>
    elements.map((element) => {
      const { left, right, top, bottom } = element.getBoundingClientRect();
      return { left, right, top, bottom };
    }),
  );
  expect(boxes).toHaveLength(6);
  for (const [index, box] of boxes.entries()) {
    for (const other of boxes.slice(index + 1)) {
      const width = Math.min(box.right, other.right) - Math.max(box.left, other.left);
      const height = Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top);
      expect(width <= 0.5 || height <= 0.5, 'node cards overlap').toBe(true);
    }
  }
  const badgeTexts = await page
    .locator('.audience-node__badge')
    .allTextContents();
  expect(badgeTexts).not.toContain('Error');
  if (badgeTexts.length > 0) {
    expect(new Set(badgeTexts)).toEqual(new Set(['Check']));
  }
  await page.screenshot({
    path: testInfo.outputPath('audience-all-six-nodes.png'),
    fullPage: true,
  });

  const connect = async (source: string, target: string) => {
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Source').selectOption(source);
    await modal.getByLabel('Target').selectOption(target);
    await modal.getByRole('button', { name: 'Create connection' }).click();
  };
  await connect('users', 'lb-1');
  await connect('lb-1', 'app-1');
  await connect('app-1', 'sql-1');
  await connect('app-1', 'cache-1');
  await connect('cache-1', 'sql-1');
  await connect('worker-1', 'sql-1');
  await expect(page.getByText('ingress', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('balance', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('ingest / read', { exact: true }).first()).toBeVisible();
});

test('a real qualified architecture passes every required case', async ({
  page,
}) => {
  await openLevel(page);
  await importGraph(page, PROJECTION);
  await runToReport(page);
  await expect(page.locator('.audience-summary__verdict strong')).toContainText(
    'Qualified',
  );
  await expect(page.getByText('4/4 passed')).toBeVisible();
  const peakCost = page
    .locator('.audience-summary__facts')
    .filter({ hasText: 'Cases' });
  await expect(peakCost).toContainText('4/4');

  // Each case has real evidence, including both physical Application slots.
  const tabs = page.getByRole('tablist', { name: 'Qualification case' });
  await expect(tabs.getByRole('tab')).toHaveCount(4);
  for (const name of [/Normal traffic/, /Live peak/, /slot 0/, /slot 1/]) {
    const tab = tabs.getByRole('tab', { name });
    await expect(tab).toContainText('pass');
  }

  // Charts come from the selected case's real series.
  await selectCase(page, /Live peak/);
  await expect(page.getByRole('heading', { name: 'Telemetry · Live peak' })).toBeVisible();
  await expect(
    page.locator('.audience-case-detail .game-chart--traffic svg'),
  ).toBeVisible();
  await expect(page.getByText('Critical cohort', { exact: false }).first()).toBeVisible();
  await expect(
    page.locator('.game-table').filter({ hasText: 'Live peak requirements' }),
  ).toBeVisible();
  await expect(page.getByText('Peak-case actual').first()).toBeVisible();
});

test('single Application design passes normal traffic but fails its fault case', async ({
  page,
}) => {
  await openLevel(page);
  await importGraph(page, SINGLE_APP_FAIL);
  await runToReport(page);

  await expect(page.locator('.audience-summary__verdict strong')).toContainText(
    'Not qualified',
  );
  await selectCase(page, /Normal traffic/);
  await expect(page.locator('[data-audience-case-verdict]')).toHaveAttribute(
    'data-audience-case-verdict',
    'pass',
  );
  await selectCase(page, /slot 0/);
  await expect(page.locator('[data-audience-case-verdict]')).toHaveAttribute(
    'data-audience-case-verdict',
    'fail',
  );
  await expect(page.getByText('Fault target')).toBeVisible();
  await expect(page.locator('[data-audience-marker="crash"]')).toBeVisible();
});

test('the case selector switches charts, requirements and fault detail for the same case', async ({
  page,
}) => {
  await openLevel(page);
  await importGraph(page, CACHE_QUERY);
  await runToReport(page);

  await selectCase(page, /Normal traffic/);
  await expect(page.getByRole('heading', { name: 'Telemetry · Normal traffic' })).toBeVisible();
  await expect(page.getByText('No Application failure is injected in this case.')).toBeVisible();
  await expect(
    page.locator('.game-table').filter({ hasText: 'Normal traffic requirements' }),
  ).toBeVisible();
  await expect(page.locator('[data-audience-case-verdict]')).toBeVisible();

  await selectCase(page, /Live peak/);
  await expect(page.getByRole('heading', { name: 'Telemetry · Live peak' })).toBeVisible();
  await expect(
    page.locator('.game-table').filter({ hasText: 'Live peak requirements' }),
  ).toBeVisible();
  await expect(page.locator('[data-audience-case-verdict]')).toHaveAttribute(
    'data-audience-case-verdict',
    'pass',
  );
  await expect(page.locator('[data-audience-marker]')).toHaveCount(0);

  await selectCase(page, /slot 1/);
  await expect(
    page.getByRole('heading', { name: 'Telemetry · Application failure · slot 1' }),
  ).toBeVisible();
  await expect(page.getByText('Fault target')).toBeVisible();
  await expect(page.locator('[data-audience-marker="crash"]')).toBeVisible();
  // Recorded replay is per case and never a live animation in the report.
  const replay = page.getByTestId('audience-case-replay');
  await expect(replay).toContainText('Application failure · slot 1');
  await replay.getByRole('button', { name: 'Replay' }).click();
  await expect(page.locator('[data-traffic-motion="animated"]').first()).toBeAttached();
  await replay.getByRole('button', { name: 'Pause replay' }).click();
  await expect(page.locator('[data-traffic-motion="animated"]')).toHaveCount(0);
  await replay.getByRole('button', { name: 'Summary' }).click();
});

test('stale, drag, explicit export/import and refresh keep the graph explicit', async ({
  page,
}) => {
  await openLevel(page);
  await importGraph(page, QUERY_LARGE, 307);
  await expect(page.getByLabel('Seed')).toHaveValue('307');
  await runToReport(page);

  // Moving a node is editor-only and does not stale the result.
  const node = page.getByTestId('rf__node-app');
  const box = await node.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 40, box!.y + 20);
  await page.mouse.down();
  await page.mouse.move(box!.x + 150, box!.y + 90, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.audience-case-detail')).toBeVisible();

  // A semantic setting change hides the previous result.
  await page.getByTestId('rf__node-sql').click();
  await page.getByLabel('Size', { exact: true }).selectOption('medium');
  await expect(page.getByText('Previous result', { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText('Old telemetry, case evidence and recorded frames are hidden'),
  ).toBeVisible();
  await expect(page.locator('.audience-case-detail')).toHaveCount(0);

  // Export, reset, import the same file: positions, settings and seed survive.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const download = await downloadPromise;
  const savedPath = await download.path();
  expect(savedPath).not.toBeNull();
  const saved = JSON.parse(await readFile(savedPath!, 'utf8')) as {
    kind: string;
    levelId: string;
    seed: number;
    graph: GraphDoc;
  };
  expect(saved.kind).toBe('sdg-level-state');
  expect(saved.levelId).toBe('live-audience');
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

  // The exported graph is semantically preserved after a round trip.
  const secondDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const second = await secondDownload;
  const secondSaved = JSON.parse(
    await readFile((await second.path())!, 'utf8'),
  ) as { graph: GraphDoc; seed: number };
  expect(secondSaved.seed).toBe(307);
  expect(secondSaved.graph).toEqual(saved.graph);

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
  await second.goto('/#live-audience');
  await expect(second.getByTestId('rf__node-users')).toBeVisible();
  await expect(second.getByTestId('rf__node-app-1')).toHaveCount(0);
  await second.getByRole('tab', { name: 'Components' }).click();
  await second.getByRole('button', { name: 'Add: SQL Database' }).click();
  await expect(second.getByTestId('rf__node-sql-1')).toBeVisible();
  await expect(page.getByTestId('rf__node-sql-1')).toHaveCount(0);
  await second.close();

  // Start a real run and stop it; no case can pass and no score is shown.
  await importGraph(page, PROJECTION);
  await page
    .getByRole('button', { name: /Run evaluation|Run again/ })
    .click();
  const stop = page.getByRole('button', { name: 'Stop' });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(
    page.getByRole('button', { name: /Run evaluation|Run again/ }),
  ).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('.audience-case-detail')).toHaveCount(0);
  await expect(page.getByText('Qualified — every required case passed')).toHaveCount(0);
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('rf__node-users')).toBeVisible();
});

test('the header remains readable and non-overlapping at 390 px', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#live-audience');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Live Audience' }),
  ).toBeVisible();

  const checkLayout = async () => {
    for (const selector of [
      '.audience-header > *',
      '.audience-header__meta > *',
      '.audience-header__controls > *',
    ]) {
      const boxes = await page.locator(selector).evaluateAll((elements) =>
        elements
          .filter((element) => {
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden';
          })
          .map((element) => {
            const { left, right, top, bottom } = element.getBoundingClientRect();
            return { left, right, top, bottom };
          }),
      );
      for (const [index, box] of boxes.entries()) {
        expect(box.left).toBeGreaterThanOrEqual(-0.5);
        expect(box.right).toBeLessThanOrEqual(390.5);
        for (const other of boxes.slice(index + 1)) {
          const width =
            Math.min(box.right, other.right) - Math.max(box.left, other.left);
          const height =
            Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top);
          expect(
            width <= 0.5 || height <= 0.5,
            `${selector} areas overlap`,
          ).toBe(true);
        }
      }
    }
  };

  await checkLayout();
  await importGraph(page, PROJECTION);
  await checkLayout();
  await page.screenshot({
    path: testInfo.outputPath('audience-compact-header.png'),
    fullPage: true,
  });
});
