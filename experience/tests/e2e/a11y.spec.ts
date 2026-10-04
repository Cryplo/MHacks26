/** C-24 keyboard focus order, labels, non-colour states. */
import { expect, test, type Page } from '@playwright/test';
import { createRun, openRunPanel, signInOperator, startRun } from './helpers';

// Heavy fixture scenes and the WebGL map make these browser journeys slow on loaded machines.
test.beforeEach(() => { test.slow(); });

async function unlabeled(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('button, a[href], input, select, textarea'))) {
      if ((el as HTMLElement).closest('[hidden]')) continue;
      const e = el as HTMLInputElement;
      const name = e.getAttribute('aria-label') || e.textContent?.trim() || (e.labels && e.labels.length ? 'label' : '') || e.getAttribute('aria-labelledby') || e.getAttribute('title');
      if (!name && e.type !== 'hidden') out.push(e.outerHTML.slice(0, 120));
    }
    return out;
  });
}

test('skip link first, every control has an accessible name (setup + live)', async ({ page }) => {
  await signInOperator(page);
  await page.goto('/setup');
  await expect(page.getByTestId('setup-page')).toBeVisible();
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.focus(); });
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Skip to content');
  await page.getByTestId('guest-count').fill('300');
  await expect(page.getByTestId('population-preview')).toContainText('300');
  expect(await unlabeled(page)).toEqual([]);
  await page.getByTestId('create-run').click();
  await startRun(page);
  for (const tab of ['summary', 'guests', 'activity']) {
    await page.getByTestId(`tab-${tab}`).click();
    expect(await unlabeled(page), tab).toEqual([]);
  }
  for (const panel of ['whatif', 'share'] as const) {
    await openRunPanel(page, panel);
    expect(await unlabeled(page), panel).toEqual([]);
    await page.keyboard.press('Escape');
  }
  await page.getByTestId('run-menu').click();
  expect(await unlabeled(page), 'run menu').toEqual([]);
});

test('keyboard-only guest selection and map zoom; states carry text not just colour', async ({ page }) => {
  await signInOperator(page);
  await createRun(page);
  await startRun(page, 20);
  await page.getByTestId('tab-guests').focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Find a guest').focus();
  await page.keyboard.type('a0');
  await expect(page.locator('[data-agent-id]').first()).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Tab'); // "With a decision" filter
  await page.keyboard.press('Tab'); // first matching guest
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('inspector')).toBeVisible();
  await page.getByTestId('park-map').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('inspector')).toHaveCount(0);
  await expect(page.getByTestId('run-status').first()).toHaveText(/Running|Blocked/);
  await expect(page.getByTestId('legend')).toContainText('In a queue');
  await page.getByTestId('park-map').focus();
  const before = await page.evaluate(() => globalThis.__behaviorMap?.scale());
  await page.keyboard.press('+');
  expect(await page.evaluate(() => globalThis.__behaviorMap?.scale())).toBeGreaterThan(before!);
  await page.keyboard.press('0');
  expect(await page.evaluate(() => globalThis.__behaviorMap?.scale())).toBeCloseTo(before!, 3);
});
