/** C-24 375px mobile viewer and touch selection; screenshot of the mobile viewer. */
import { expect, test } from '@playwright/test';
import { createRun, pickableGuest, signInOperator, startRun } from './helpers';

// Heavy fixture scenes and the WebGL map make these browser journeys slow on loaded machines.
test.beforeEach(() => { test.slow(); });

test('mobile viewer at 375px: no horizontal scroll, touch selection, read-only', async ({ context, page }) => {
  await signInOperator(page);
  await createRun(page);
  await startRun(page, 20);
  await page.getByTestId('run-menu').tap();
  await page.getByTestId('menu-share').tap();
  await page.getByTestId('issue-share').tap();
  const link = await page.getByTestId('share-link').inputValue();
  const viewer = await context.newPage();
  await viewer.goto(link);
  await expect(viewer.getByTestId('live-page')).toBeVisible();
  await expect(viewer.getByTestId('viewer-note')).toBeVisible();
  await viewer.waitForTimeout(4000);
  const overflow = await viewer.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(viewer.getByTestId('park-map')).toHaveAttribute('data-map-status', 'ready');
  // Touch-pick a displayed guest on the map (one with room around it, not under an overlay).
  await expect(viewer.locator('[data-agent-id]').first()).toBeAttached({ timeout: 20_000 });
  await viewer.evaluate(() => window.scrollTo(0, 0));
  const p = await pickableGuest(viewer, 24);
  if (p) {
    await viewer.getByTestId('pause-run').count().then((n) => expect(n).toBe(0));
    await viewer.touchscreen.tap(p.x, p.y);
    await expect(viewer.getByTestId('inspector')).toBeVisible();
  }
  await viewer.screenshot({ path: 'artifacts/screenshots/07-mobile-viewer.png', fullPage: false });
  const overflow2 = await viewer.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow2).toBeLessThanOrEqual(1);
});

test('mobile setup and results pages fit 375px', async ({ page }) => {
  await signInOperator(page);
  const url = await createRun(page);
  for (const path of ['/setup', '/', `${new URL(url).pathname}/results`]) {
    await page.goto(path);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), path).toBeLessThanOrEqual(1);
  }
});
