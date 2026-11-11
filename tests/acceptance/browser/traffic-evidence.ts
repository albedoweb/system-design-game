import { expect, type Page } from '@playwright/test';

/** Observe rendered evidence from the real Worker; never inject telemetry. */
export async function observeLiveTraffic(page: Page): Promise<void> {
  await page.evaluate(() => {
    const evidence = { live: false, moving: false, measured: false };
    Object.assign(window, { acceptanceTrafficEvidence: evidence });
    const observer = new MutationObserver(() => {
      evidence.live ||= [...document.querySelectorAll('[data-traffic-node]')]
        .some((node) => node.getAttribute('aria-label')?.startsWith('Live traffic: Live'));
      evidence.moving ||= document.querySelector('[data-traffic-motion="animated"]') !== null;
      evidence.measured ||= document.querySelector('[data-traffic-node].is-sampled .traffic-meter__blocks .is-filled') !== null;
    });
    observer.observe(document.body, { childList: true, attributes: true, subtree: true });
    Object.assign(window, { acceptanceTrafficObserver: observer });
  });
}

export async function finishLiveTrafficObservation(page: Page, levelId: string): Promise<void> {
  const evidence = await page.evaluate(() => {
    const state = window as unknown as {
      acceptanceTrafficEvidence: { live: boolean; moving: boolean; measured: boolean };
      acceptanceTrafficObserver: MutationObserver;
    };
    state.acceptanceTrafficObserver.disconnect();
    return state.acceptanceTrafficEvidence;
  });
  // Parcel may finish before the browser paints a live sample. Its recorded
  // real frames are asserted below; paced Cold and full Image runs must be live.
  if (levelId !== 'parcel-pulse') {
    expect(evidence, `${levelId} must render measured live Worker traffic`).toEqual({
      live: true, moving: true, measured: true,
    });
  }
  await expect(page.locator('[data-traffic-motion="animated"]')).toHaveCount(0);
}

export async function checkRecordedTraffic(page: Page, screenshotPath: string): Promise<void> {
  const replay = page.getByTestId('traffic-replay');
  await expect(replay).toHaveAttribute('data-traffic-replay-mode', 'completed');
  await replay.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect(page.locator('[data-traffic-motion="animated"]').first()).toBeAttached();
  await expect(page.locator('[data-traffic-node].is-sampled .is-filled').first()).toBeAttached();
  await replay.getByRole('button', { name: 'Pause replay' }).click();
  await expect(page.locator('[data-traffic-motion="animated"]')).toHaveCount(0);
  const sample = replay.getByRole('slider', { name: 'Replay sample' });
  await sample.press('Home');
  for (let index = 0; index < 20; index += 1) {
    await sample.press('ArrowRight');
  }
  await expect(replay).toHaveAttribute('data-traffic-replay-mode', 'replay-paused');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await replay.getByRole('button', { name: 'Play replay' }).click();
  await expect(page.locator('[data-traffic-motion="animated"]').first()).toBeAttached();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('[data-traffic-motion="animated"]')).toHaveCount(0);
  await expect(page.locator('[data-traffic-static="true"]').first()).toBeAttached();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await replay.getByRole('button', { name: 'Summary', exact: true }).click();
  await expect(replay).toHaveAttribute('data-traffic-replay-mode', 'completed');
  await expect(page.locator('[data-traffic-motion="animated"]')).toHaveCount(0);
}
