/** Screenshot matrix (presentation only, not business correctness). Fixture label always visible. */
import { expect, test } from '@playwright/test';
import { signInOperator, startRun } from './helpers';

const shot = (name: string) => `artifacts/screenshots/${name}.png`;

test('setup, live, inspector, confirmation, blocked, results, print', async ({ page }) => {
  test.setTimeout(240_000);
  await signInOperator(page);
  await page.goto('/setup');
  await page.getByTestId('choose-park-harbor-lights-s1-v1').click();
  await page.getByTestId('request-preview').click();
  await expect(page.getByTestId('frozen-plan')).toBeVisible();
  await expect(page.getByTestId('fixture-banner')).toBeVisible();
  await page.screenshot({ path: shot('01-setup'), fullPage: true });
  await page.getByTestId('create-run').click();
  await startRun(page, 60);
  await expect(page.getByTestId('barrier-notice')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: shot('05-blocked-barrier') });
  await expect(page.getByTestId('run-status').first()).toContainText('Running', { timeout: 20_000 });
  await page.waitForTimeout(15_000);
  await page.screenshot({ path: shot('02-live') });
  await page.getByTestId('tab-guests').click();
  await page.getByLabel('Find a guest').fill('queueing');
  await page.locator('[data-agent-id]').first().click();
  await expect(page.getByTestId('evidence')).toBeVisible();
  await page.screenshot({ path: shot('03-inspector') });
  await page.getByTestId('tab-whatif').click();
  await page.getByTestId('whatif-text').fill('close the coaster at 2pm; send an app message "20% off churros today"; raise the pass price to $25 at 1pm');
  await page.getByTestId('whatif-parse').click();
  await expect(page.getByTestId('draft-card')).toBeVisible();
  await page.screenshot({ path: shot('04-scenario-confirmation') });
  const runUrl = page.url().split('?')[0]!;
  await page.goto(`${runUrl}/results`);
  await expect(page.getByTestId('metrics-table')).toBeVisible();
  await page.screenshot({ path: shot('06a-results-run'), fullPage: true });
  await page.goto(`${runUrl}/print`);
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByTestId('print-caveats')).toBeVisible();
  await page.screenshot({ path: shot('08-print-preview'), fullPage: true });
  await page.emulateMedia({ media: 'screen' });
  await page.goto('/experiments/new');
  await page.getByTestId('create-experiment').click();
  await expect(page.locator('[data-pair-status=incomplete]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('evidence-labels')).toContainText('Exploratory');
  await page.screenshot({ path: shot('06b-results-incomplete-pair'), fullPage: true });
});
