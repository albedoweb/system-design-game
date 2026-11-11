import { expect, test, type Page } from '@playwright/test';

interface SharedLevel {
  readonly id: string;
  readonly title: string;
  readonly route: string;
  /** Title of the collapsible telemetry/report panel. */
  readonly telemetryTitle: string;
}

const LEVELS: readonly SharedLevel[] = [
  {
    id: 'live-scoreboard',
    title: 'Live Scoreboard',
    route: '/#live-scoreboard',
    telemetryTitle: 'Results & telemetry',
  },
  {
    id: 'cold-cache',
    title: 'Cold Cache',
    route: '/#cold-cache',
    telemetryTitle: 'Telemetry',
  },
  {
    id: 'parcel-pulse',
    title: 'Parcel Pulse',
    route: '/#parcel-pulse',
    telemetryTitle: 'Results & telemetry',
  },
  {
    id: 'image-atlas',
    title: 'Image Atlas',
    route: '/#image-atlas',
    telemetryTitle: 'Results & telemetry',
  },
];

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

async function openLevel(page: Page, level: SharedLevel) {
  await page.goto(level.route);
  await expect(
    page.getByRole('heading', { level: 1, name: level.title }),
  ).toBeVisible();
}

test.describe('shared workspace shell', () => {
  test('every level exposes the same graph actions and task/component tabs', async ({
    page,
  }) => {
    const expectNoErrors = trackErrors(page);
    await page.setViewportSize({ width: 1600, height: 900 });
    for (const level of LEVELS) {
      await openLevel(page, level);

      await expect(page.getByRole('toolbar', { name: 'Graph actions' })).toBeVisible();
      const panelToggles = page.getByRole('toolbar', { name: 'Graph actions' })
        .locator('.game-toolbar__panel-toggle');
      for (const toggle of await panelToggles.all()) {
        if (level.id === 'image-atlas') {
          await expect(toggle).toBeVisible();
        } else {
          await expect(toggle).toBeHidden();
        }
      }
      for (const name of ['Undo', 'Redo', 'Connect', 'Export', 'Import', 'Reset']) {
        await expect(page.getByRole('button', { name })).toBeVisible();
      }

      // Wide screens keep the fixed panels; collapsible layouts open on demand.
      const tabs = page.getByRole('tablist', { name: 'Left panel' });
      if (!(await tabs.isVisible())) {
        await page.getByRole('button', { name: 'Task' }).click();
      }
      await expect(tabs).toBeVisible();
      await expect(tabs.getByRole('tab', { name: 'Task' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(tabs.getByRole('tab', { name: 'Components' })).toBeVisible();
      await expect(
        page.getByRole('complementary', { name: 'Task and components' }),
      ).toBeVisible();
    }
    expectNoErrors();
  });

  test('an open drawer stays interactive above the compact backdrop', async ({ page }) => {
    const expectNoErrors = trackErrors(page);
    await page.setViewportSize({ width: 1280, height: 820 });

    for (const level of LEVELS) {
      await openLevel(page, level);

      await page.getByRole('button', { name: 'Task' }).click();
      const leftPanel = page.getByRole('complementary', {
        name: 'Task and components',
      });
      const tabs = leftPanel.getByRole('tablist', { name: 'Left panel' });
      await expect(tabs).toBeVisible();

      // A click on the tab must reach the drawer, not the backdrop.
      await tabs.getByRole('tab', { name: 'Components' }).click();
      await expect(
        tabs.getByRole('tab', { name: 'Components' }),
      ).toHaveAttribute('aria-selected', 'true');
      await expect(leftPanel.getByRole('button', { name: /^Add: / }).first()).toBeVisible();

      // Keyboard tab navigation stays inside the drawer.
      await tabs.getByRole('tab', { name: 'Components' }).press('ArrowLeft');
      await expect(tabs.getByRole('tab', { name: 'Task' })).toHaveAttribute(
        'aria-selected',
        'true',
      );

      // The close action is outside the tablist and closes the drawer only.
      await leftPanel.getByRole('button', { name: 'Close left panel' }).click();
      await expect(leftPanel).toBeHidden();
      await expect(
        page.getByRole('button', { name: 'Close panels' }),
      ).toBeHidden();
    }
    expectNoErrors();
  });

  test('the shared telemetry panel is controlled on every level', async ({ page }) => {
    const expectNoErrors = trackErrors(page);
    for (const level of LEVELS) {
      await openLevel(page, level);
      const toggle = page.getByRole('button', { name: level.telemetryTitle });
      if ((await toggle.getAttribute('aria-expanded')) === 'false') {
        await toggle.click();
      }
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const bodyId = await toggle.getAttribute('aria-controls');
      expect(bodyId).toBeTruthy();
      await expect(page.locator(`#${bodyId}`)).toBeVisible();

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator(`#${bodyId}`)).toHaveCount(0);
    }
    expectNoErrors();
  });
});
