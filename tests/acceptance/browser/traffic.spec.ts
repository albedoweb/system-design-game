import { expect, test, type Page } from '@playwright/test';

interface LevelTraffic {
  readonly id: string;
  readonly title: string;
  readonly route: string;
  readonly starterNode: string;
}

const LEVELS: readonly LevelTraffic[] = [
  {
    id: 'cold-cache',
    title: 'Cold Cache',
    route: '/#cold-cache',
    starterNode: 'rf__node-cache-1',
  },
  {
    id: 'parcel-pulse',
    title: 'Parcel Pulse',
    route: '/#parcel-pulse',
    starterNode: 'rf__node-sql-1',
  },
  {
    id: 'image-atlas',
    title: 'Image Atlas',
    route: '/#image-atlas',
    starterNode: 'rf__node-client-na',
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

test('every level shows neutral live-traffic rows before any measurement', async ({
  page,
}) => {
  const expectNoErrors = trackErrors(page);

  for (const level of LEVELS) {
    await page.goto(level.route);
    await expect(
      page.getByRole('heading', { level: 1, name: level.title }),
    ).toBeVisible();

    const node = page.getByTestId(level.starterNode);
    await expect(node).toBeVisible();
    const traffic = node.locator('[data-traffic-node="true"]');
    await expect(traffic).toBeVisible();
    await expect(traffic).toHaveAttribute('data-traffic-state', 'unknown');
    await expect(traffic).toHaveAttribute('data-traffic-placeholder', 'true');
    // Unknown is shown as a dash, never as a measured zero.
    await expect(traffic).toContainText('No live sample');
    if ((await traffic.locator('.traffic-meter').count()) > 0) {
      await expect(traffic.getByText('—').first()).toBeVisible();
    }
    await expect(traffic.getByText('0%')).toHaveCount(0);

    // No idle canvas may animate historical or fabricated traffic.
    await expect(page.locator('[data-traffic-motion="animated"]')).toHaveCount(0);
    await expect(page.getByTestId('traffic-replay')).toHaveCount(0);
  }

  expectNoErrors();
});
