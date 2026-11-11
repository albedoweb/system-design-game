import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { checkRecordedTraffic, finishLiveTrafficObservation, observeLiveTraffic } from './traffic-evidence';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const artifactDir = resolve(
  process.cwd(),
  process.env.ACCEPTANCE_ARTIFACT_DIR ?? 'test-results/acceptance',
);
const baseURL = process.env.ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:5190';
const fixture = (relative: string): string => join(repoRoot, relative);

interface Errors {
  consoleErrors: string[];
  pageErrors: string[];
}

interface LevelSpec {
  readonly id: string;
  readonly title: string;
  readonly route: string;
  readonly runGraph: string;
  readonly stateGraph: string;
  /** A different level's bare graph; import must be rejected atomically. */
  readonly wrongLevelGraph: string;
  readonly assertStarter: (page: Page) => Promise<void>;
  readonly assertImported: (page: Page) => Promise<void>;
}

const LEVELS: readonly LevelSpec[] = [
  {
    id: 'cold-cache',
    title: 'Cold Cache',
    route: '/#cold-cache',
    runGraph: 'tests/acceptance/fixtures/cold-cache-cheap-pass.json',
    stateGraph: 'tests/acceptance/fixtures/cold-cache-overbudget.json',
    wrongLevelGraph: 'fixtures/parcel/family-sql-indexed.json',
    assertStarter: async (page) => {
      await expect(page.getByTestId('rf__node-cache-1')).toBeVisible();
      await expect(page.getByTestId('rf__node-lb-1')).toHaveCount(0);
    },
    assertImported: async (page) => {
      await expect(page.getByTestId('rf__node-lb-1')).toBeVisible();
      await expect(page.getByTestId('rf__node-app-2')).toBeVisible();
    },
  },
  {
    id: 'parcel-pulse',
    title: 'Parcel Pulse',
    route: '/#parcel-pulse',
    runGraph: 'fixtures/parcel/family-sql-indexed.json',
    stateGraph: 'fixtures/parcel/family-sql-indexed.json',
    wrongLevelGraph: 'tests/acceptance/fixtures/cold-cache-cheap-pass.json',
    assertStarter: async (page) => {
      await expect(page.getByTestId('rf__node-sql-1')).toContainText('SQL store');
    },
    assertImported: async (page) => {
      await expect(page.getByTestId('rf__node-sql-1')).toContainText('SQL primary');
    },
  },
  {
    id: 'image-atlas',
    title: 'Image Atlas',
    route: '/#image-atlas',
    runGraph: 'fixtures/images/family-direct.json',
    stateGraph: 'fixtures/images/directory-direct.json',
    wrongLevelGraph: 'fixtures/parcel/family-sql-indexed.json',
    assertStarter: async (page) => {
      await expect(page.getByTestId('rf__node-client-na')).toBeVisible();
      await expect(page.getByTestId('rf__node-metadata-eu')).toHaveCount(0);
    },
    assertImported: async (page) => {
      await expect(page.getByTestId('rf__node-metadata-eu')).toBeVisible();
    },
  },
];

function trackErrors(page: Page): Errors {
  const errors: Errors = { consoleErrors: [], pageErrors: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    errors.pageErrors.push(error.message);
  });
  return errors;
}

function expectNoBrowserErrors(errors: Errors): void {
  expect(errors.pageErrors).toEqual([]);
  expect(errors.consoleErrors).toEqual([]);
}

async function openLevel(page: Page, level: LevelSpec): Promise<void> {
  await page.goto(level.route);
  await expect(
    page.getByRole('heading', { level: 1, name: level.title }),
  ).toBeVisible();
}

async function setSeed(page: Page, value: number): Promise<void> {
  const input = page.getByLabel('Seed');
  await input.fill(String(value));
  await input.press('Enter');
  await expect(input).toHaveValue(String(value));
}

async function importGraph(page: Page, file: string): Promise<void> {
  await page.getByLabel('Open saved graph file').setInputFiles(file);
  await expect(page.getByText('File opened')).toBeVisible();
}

async function resetGraph(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Reset graph' }).click();
  await expect(dialog).toBeHidden();
}

async function exportState(page: Page): Promise<{
  file: string;
  parsed: { kind?: string; seed?: number; graph?: unknown };
}> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  const file = await download.path();
  expect(file).toBeTruthy();
  const text = fs.readFileSync(file!, 'utf8');
  return { file: file!, parsed: JSON.parse(text) as { kind?: string; seed?: number; graph?: unknown } };
}

async function expectFreshStarter(page: Page, level: LevelSpec): Promise<void> {
  await level.assertStarter(page);
  await expect(page.getByLabel('Seed')).toHaveValue('101');
  await expect(page.getByText(/^Run result(?: · seed \d+)?$/)).toHaveCount(0);
  await expect(page.getByText('Level passed', { exact: true })).toHaveCount(0);
}

async function runPassingReference(page: Page, level: LevelSpec): Promise<void> {
  await importGraph(page, fixture(level.runGraph));
  const speed16 = page.getByRole('button', { name: '16×', exact: true });
  if ((await speed16.count()) > 0 && (await speed16.isVisible())) {
    await speed16.click();
  }
  await observeLiveTraffic(page);
  await page.getByRole('button', { name: /^Run( evaluation)?$/ }).click();
  if (level.id === 'cold-cache') {
    await expect(page.locator('[data-traffic-motion="animated"]').first()).toBeAttached();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.locator('[data-traffic-motion="animated"]')).toHaveCount(0);
    await expect(page.locator('.traffic-node__dot.is-animated')).toHaveCount(0);
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('[data-traffic-motion="animated"]').first()).toBeAttached();
  }
  await expect(page.getByText('Level passed', { exact: true })).toBeVisible({
    timeout: 300_000,
  });
}

test('the landing page opens Global Cart with no level tabs; legacy levels load by direct hash', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Global Cart' }),
  ).toBeVisible();
  await expect(page.getByText('System Design Game', { exact: true })).toBeVisible();
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

  for (const [hash, title] of [
    ['#live-audience', 'Live Audience'],
    ['#live-scoreboard', 'Live Scoreboard'],
    ['#cold-cache', 'Cold Cache'],
    ['#parcel-pulse', 'Parcel Pulse'],
    ['#image-atlas', 'Image Atlas'],
  ] as const) {
    await page.goto(`/${hash}`);
    await expect(
      page.getByRole('heading', { level: 1, name: title }),
    ).toBeVisible();
  }

  expectNoBrowserErrors(errors);
});

for (const level of LEVELS) {
  test(`${level.title} runs a real pass witness in the browser Worker`, async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await openLevel(page, level);
    await runPassingReference(page, level);
    await finishLiveTrafficObservation(page, level.id);
    if (level.id !== 'cold-cache') {
      const beforeReplay = await exportState(page);
      fs.mkdirSync(artifactDir, { recursive: true });
      await checkRecordedTraffic(page, join(artifactDir, `${level.id}-traffic-replay.png`));
      const afterReplay = await exportState(page);
      expect(afterReplay.parsed.graph).toEqual(beforeReplay.parsed.graph);
      expect(afterReplay.parsed.seed).toEqual(beforeReplay.parsed.seed);
      expect(afterReplay.parsed.kind).toEqual(beforeReplay.parsed.kind);
      expect(Object.keys(afterReplay.parsed).sort()).toEqual(Object.keys(beforeReplay.parsed).sort());
      await expect(page.getByText('Level passed', { exact: true })).toBeVisible();
    }

    if (level.id === 'image-atlas') {
      await expect(page.getByLabel('Measured monthly cost')).toBeVisible();
      fs.mkdirSync(artifactDir, { recursive: true });
      await page.screenshot({
        path: join(artifactDir, 'image-atlas-result.png'),
        fullPage: true,
      });
      await setSeed(page, 102);
      await expect(page.getByLabel('Estimated monthly cost')).toBeVisible();
    }

    expectNoBrowserErrors(errors);
  });
}

for (const level of LEVELS) {
  test(`${level.title} exports/imports graph+seed and refreshes to the starter`, async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await openLevel(page, level);

    await importGraph(page, fixture(level.stateGraph));
    await level.assertImported(page);
    await setSeed(page, 4242);

    const exported = await exportState(page);
    expect(typeof exported.parsed.kind).toBe('string');
    expect(exported.parsed.seed).toBe(4242);
    expect(exported.parsed.graph).toBeTruthy();
    if (level.id !== 'image-atlas') {
      // Cold Cache and Parcel Pulse keep the existing shared envelope kind.
      expect(exported.parsed.kind).toBe('sdg-level-state');
    }

    await resetGraph(page);
    await expectFreshStarter(page, level);

    await page.getByLabel('Open saved graph file').setInputFiles(exported.file);
    await expect(page.getByText('File opened')).toBeVisible();
    await expect(page.getByLabel('Seed')).toHaveValue('4242');
    await level.assertImported(page);

    await page.reload();
    await expect(
      page.getByRole('heading', { level: 1, name: level.title }),
    ).toBeVisible();
    await expectFreshStarter(page, level);

    expectNoBrowserErrors(errors);
  });
}

for (const level of LEVELS) {
  test(`${level.title} rejects cross-level and malformed imports without changing the graph`, async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await openLevel(page, level);

    await page
      .getByLabel('Open saved graph file')
      .setInputFiles(fixture(level.wrongLevelGraph));
    await expect(page.getByText('Open rejected', { exact: true })).toBeVisible();
    await level.assertStarter(page);

    await page.getByLabel('Open saved graph file').setInputFiles({
      name: 'broken.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{ not json'),
    });
    await expect(page.getByText('Open rejected', { exact: true })).toBeVisible();
    await level.assertStarter(page);

    expectNoBrowserErrors(errors);
  });
}

for (const level of LEVELS) {
  test(`${level.title} keeps two tabs independent and resets only one`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      baseURL,
    });
    context.setDefaultTimeout(10_000);
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const errorsA = trackErrors(pageA);
    const errorsB = trackErrors(pageB);

    try {
      await Promise.all([openLevel(pageA, level), openLevel(pageB, level)]);

      await importGraph(pageA, fixture(level.stateGraph));
      await level.assertImported(pageA);
      await level.assertStarter(pageB);
      await setSeed(pageA, 111);
      await setSeed(pageB, 222);

      await expect(pageA.getByLabel('Seed')).toHaveValue('111');
      await expect(pageB.getByLabel('Seed')).toHaveValue('222');

      await resetGraph(pageA);
      await expect(pageA.getByLabel('Seed')).toHaveValue('101');
      await level.assertStarter(pageA);
      await expect(pageB.getByLabel('Seed')).toHaveValue('222');
      await level.assertStarter(pageB);

      const draftKeys = await pageA.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.includes('draft')),
      );
      expect(draftKeys).toEqual([]);

      expectNoBrowserErrors(errorsA);
      expectNoBrowserErrors(errorsB);
    } finally {
      await context.close();
    }
  });
}

test('Cold Cache Stop then Reset cannot accept the old completion', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await openLevel(page, LEVELS[0]!);
  await page.getByRole('button', { name: /^Run( evaluation)?$/ }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('Stopped', { exact: true })).toBeVisible();

  await resetGraph(page);
  await expect(page.getByLabel('Seed')).toHaveValue('101');
  await expect(page.getByText(/^Run result(?: · seed \d+)?$/)).toHaveCount(0);

  // Bounded stale-completion guard: the stopped worker must not publish after
  // Reset even if its cancellation races with the UI reset.
  await page.waitForTimeout(2_500);
  await expect(page.getByText(/^Run result(?: · seed \d+)?$/)).toHaveCount(0);
  await expect(page.getByText('Level passed', { exact: true })).toHaveCount(0);

  expectNoBrowserErrors(errors);
});
