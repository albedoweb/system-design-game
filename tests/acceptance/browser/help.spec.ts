import { expect, test, type Page } from '@playwright/test';

interface HelpLevel {
  readonly id: string;
  readonly title: string;
  readonly route: string;
  readonly starterNode: string;
  readonly guideTagline: string;
}

const LEVELS: readonly HelpLevel[] = [
  {
    id: 'cold-cache',
    title: 'Cold Cache',
    route: '/#cold-cache',
    starterNode: 'rf__node-cache-1',
    guideTagline: 'Shared read and write traffic',
  },
  {
    id: 'parcel-pulse',
    title: 'Parcel Pulse',
    route: '/#parcel-pulse',
    starterNode: 'rf__node-sql-1',
    guideTagline: 'Status, history, ingest and warehouse reports',
  },
  {
    id: 'image-atlas',
    title: 'Image Atlas',
    route: '/#image-atlas',
    starterNode: 'rf__node-client-na',
    guideTagline: 'Uploads, search and detail across three regions',
  },
];

function helpButton(page: Page) {
  return page.getByRole('button', { name: 'Help', exact: true });
}

async function openHelp(page: Page) {
  await helpButton(page).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Help', exact: true })).toBeVisible();
  return dialog;
}

function hashOf(page: Page): string {
  return new URL(page.url()).hash;
}

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

test('Help is available on every level and its level guide never navigates', async ({
  page,
}) => {
  const expectNoErrors = trackErrors(page);
  const pageCount = page.context().pages().length;

  for (const level of LEVELS) {
    await page.goto(level.route);
    await expect(
      page.getByRole('heading', { level: 1, name: level.title }),
    ).toBeVisible();
    await expect(page.getByTestId(level.starterNode)).toBeVisible();

    const seed = page.getByLabel('Seed');
    await seed.fill('202');
    await seed.press('Enter');
    await expect(seed).toHaveValue('202');

    const urlBefore = page.url();
    const hashBefore = hashOf(page);

    const dialog = await openHelp(page);
    await expect(
      dialog.getByRole('tab', { name: 'Getting started' }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByText('A simple loop')).toBeVisible();

    await dialog.getByRole('tab', { name: 'Level guide' }).click();
    await expect(
      dialog.getByRole('tab', { name: 'Level guide' }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      dialog.locator('.help-level-head').getByRole('heading', {
        name: level.title,
      }),
    ).toBeVisible();
    await expect(
      dialog.locator('.help-level-head').getByText(level.guideTagline),
    ).toBeVisible();

    for (const other of LEVELS) {
      await dialog.getByRole('button', { name: new RegExp(other.title) }).click();
      await expect(
        dialog.locator('.help-level-head').getByRole('heading', {
          name: other.title,
        }),
      ).toBeVisible();
      await expect(
        dialog.locator('.help-level-head').getByText(other.guideTagline),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 1, name: level.title }),
      ).toBeVisible();
      expect(page.url()).toBe(urlBefore);
    }

    await dialog.getByRole('button', { name: 'Close help' }).click();
    await expect(dialog).toBeHidden();

    expect(page.url()).toBe(urlBefore);
    expect(hashOf(page)).toBe(hashBefore);
    await expect(page.getByTestId(level.starterNode)).toBeVisible();
    await expect(seed).toHaveValue('202');
    expect(page.context().pages().length).toBe(pageCount);
  }

  expectNoErrors();
});

test('Cold Cache Escape keeps the selection and side panel; editor keys do not leak', async ({
  page,
}) => {
  const expectNoErrors = trackErrors(page);
  // Task is a drawer control only at the compact breakpoint. Wide layouts
  // already show fixed panels and intentionally hide the toggle.
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/#cold-cache');
  const node = page.getByTestId('rf__node-cache-1');
  await expect(node).toBeVisible();

  await node.click();
  await expect(node).toHaveClass(/selected/);
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click();

  const taskToggle = page
    .getByRole('button', { name: 'Task', exact: true })
    .first();
  await taskToggle.click();
  await expect(taskToggle).toHaveAttribute('aria-expanded', 'true');
  const taskPanel = page.getByRole('complementary', { name: 'Task and components' });
  await expect(taskPanel).toBeVisible();

  const dialog = await openHelp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.activeElement !== null &&
          document.activeElement.closest('.help-dialog') !== null,
      ),
    )
    .toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(helpButton(page)).toBeFocused();
  await expect(node).toHaveClass(/selected/);
  await expect(taskToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(taskPanel).toBeVisible();

  const second = await openHelp(page);
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await second.getByRole('button', { name: 'Close help' }).click();
  await expect(node).toBeVisible();
  await expect(node).toHaveClass(/selected/);
  await expect(taskToggle).toHaveAttribute('aria-expanded', 'true');

  const third = await openHelp(page);
  for (let index = 0; index < 18; index += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(
      () =>
        document.activeElement !== null &&
        document.activeElement.closest('.help-dialog') !== null,
    );
    expect(inside).toBe(true);
  }
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press('Shift+Tab');
    const inside = await page.evaluate(
      () =>
        document.activeElement !== null &&
        document.activeElement.closest('.help-dialog') !== null,
    );
    expect(inside).toBe(true);
  }

  const box = await third.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(4, box!.y + 24);
  await expect(third).toBeHidden();
  expectNoErrors();
});

test('a route change while Help is open closes it and drops the old level context', async ({
  page,
}) => {
  const expectNoErrors = trackErrors(page);
  await page.goto('/#cold-cache');
  const dialog = await openHelp(page);

  await page.evaluate(() => {
    window.location.hash = '#parcel-pulse';
  });
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Parcel Pulse' }),
  ).toBeVisible();

  await openHelp(page);
  await expect(
    dialog.getByRole('tab', { name: 'Getting started' }),
  ).toHaveAttribute('aria-selected', 'true');
  await dialog.getByRole('tab', { name: 'Level guide' }).click();
  await expect(
    dialog.locator('.help-level-head').getByRole('heading', {
      name: 'Parcel Pulse',
    }),
  ).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = '#cold-cache';
  });
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Cold Cache' }),
  ).toBeVisible();
  expectNoErrors();
});

test('Help stays usable at 390px without horizontal page overflow', async ({
  page,
}) => {
  const expectNoErrors = trackErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#cold-cache');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Cold Cache' }),
  ).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Levels' })).toHaveCount(0);
  await expect(helpButton(page)).toBeVisible();

  const dialog = await openHelp(page);
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390.5);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844.5);

  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(pageOverflow).toBe(false);

  await dialog.getByRole('tab', { name: 'Level guide' }).click();
  await expect(
    dialog.getByRole('button', { name: /Parcel Pulse/ }),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close help' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Close help' }).click();
  await expect(dialog).toBeHidden();
  expect(hashOf(page)).toBe('#cold-cache');
  expectNoErrors();
});
