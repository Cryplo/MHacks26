/** C-24 375px mobile viewer and touch selection; screenshot of the mobile viewer. */
import { expect, test } from '@playwright/test';
import { createRun, signInOperator, startRun } from './helpers';

test('mobile viewer at 375px: no horizontal scroll, touch selection, read-only', async ({ context, page }) => {
  await signInOperator(page);
  await createRun(page);
  await startRun(page, 30);
  await page.getByTestId('tab-share').tap();
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
  const id = await viewer.evaluate(() => {
    const ids = Array.from(document.querySelectorAll('[data-agent-id]')).map((e) => e.getAttribute('data-agent-id'));
    return ids[0] ?? null;
  });
  // Touch-pick a displayed guest on the map.
  await viewer.getByTestId('tab-guests').tap();
  const target = await viewer.locator('[data-agent-id]').first().getAttribute('data-agent-id');
  await viewer.getByTestId('tab-stats').tap();
  const p = await viewer.evaluate((a) => globalThis.__behaviorMap?.screenOf(a!), target ?? id);
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
