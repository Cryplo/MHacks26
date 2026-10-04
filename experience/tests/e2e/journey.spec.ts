/** C-21 full fixture journey without keys/server; C-04 command IDs and reload; C-12 what-if. */
import { expect, test } from '@playwright/test';
import { appErrors, signInOperator, startRun, watchConsole } from './helpers';

test('full fixture journey: setup -> live -> inspect -> what-if -> results -> exports -> replay', async ({ page }) => {
  const errors = watchConsole(page);
  await signInOperator(page);
  await expect(page.getByTestId('fixture-banner')).toBeVisible();

  // Setup: invalid shares block the preview with a stated reason.
  await page.goto('/setup');
  await page.getByTestId('choose-park-harbor-lights-s1-v1').click();
  await page.getByTestId('mix-teens').fill('400');
  await expect(page.getByText(/Archetype sliders assign/)).toBeVisible();
  await expect(page.getByTestId('request-preview')).toBeDisabled();
  await page.getByRole('button', { name: 'Fit to crowd size' }).click();
  await page.getByTestId('request-preview').click();
  await expect(page.getByTestId('population-preview')).toContainText('Requested guests');
  // Editing the crowd invalidates the preview instead of silently reusing it.
  await page.getByTestId('guest-count').fill('299');
  await expect(page.getByText('Preview invalidated')).toBeVisible();
  await page.getByRole('button', { name: 'Fit to crowd size' }).click();
  await page.getByTestId('request-preview').click();
  await expect(page.getByTestId('population-preview')).toBeVisible();
  await expect(page.getByTestId('frozen-plan')).toContainText('Plan hash');
  await expect(page.getByTestId('mode-select').locator('option[value=live]')).toHaveAttribute('disabled', '');

  // Double click create -> exactly one run.
  await page.getByTestId('create-run').dblclick();
  await expect(page.getByTestId('live-page')).toBeVisible();
  const runUrl = page.url();
  await page.goto('/');
  await expect(page.locator('tbody tr')).toHaveCount(1);

  // Reload on the run route reconnects to the same run.
  await page.goto(runUrl);
  await page.reload();
  await expect(page).toHaveURL(runUrl);
  await startRun(page, 60);
  await expect(page.getByTestId('connection')).toHaveText('live');

  // Keyboard alternative to canvas picking.
  await page.getByTestId('tab-guests').click();
  const first = page.locator('[data-agent-id]').first();
  const agentId = await first.getAttribute('data-agent-id');
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-agent-id', agentId!);
  await expect(page.getByTestId('evidence-source')).toContainText('not Jev');
  await expect(page.locator('[data-sampled=true]')).toHaveCount(1);
  await page.getByTestId('narrate').click();
  await expect(page.getByTestId('narrative')).toContainText('narrated from state');

  // What-if: parse -> review -> confirm -> accepted -> applied; unsupported fragments shown.
  await page.getByTestId('tab-whatif').click();
  await page.getByTestId('whatif-text').fill('close the coaster at 9:50; make it a hot day');
  await page.getByTestId('whatif-parse').click();
  await expect(page.getByTestId('draft-card')).toContainText('9:50 AM park time');
  await expect(page.getByTestId('unsupported')).toContainText('hot day');
  await page.getByTestId('whatif-confirm').click();
  await expect(page.getByTestId('scheduled')).toContainText('scheduled');
  await expect(page.locator('[data-applied=true]')).toBeVisible({ timeout: 90_000 });

  // Results + report + exports.
  await page.goto(`${runUrl}/results`);
  await expect(page.getByTestId('result-quality')).toContainText('Incomplete');
  await expect(page.getByTestId('limitations')).toContainText('Fixture data');
  const csvDl = page.waitForEvent('download');
  await page.getByTestId('export-csv').click();
  const csv = await (await (await csvDl).createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
  expect(csv).toContain('modes=Fixture');
  expect(csv).toContain('net_revenue_cents');
  const jsonDl = page.waitForEvent('download');
  await page.getByTestId('export-json').click();
  const json = JSON.parse(await (await (await jsonDl).createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8')));
  expect(json.source.modes).toContain('Fixture');
  expect(json.units.money).toBe('integer USD cents');
  await page.goto(`${runUrl}/print`);
  await expect(page.getByTestId('print-caveats')).toContainText('FIXTURE');

  // Replay requests frames only: no subscription, no commands, no product work.
  await page.goto(`${runUrl}/replay`);
  await expect(page.getByTestId('replay-time')).toHaveText(/9:00:00 AM/);
  await page.evaluate(() => { globalThis.__fixtureCallLog = []; });
  await page.getByTestId('step-forward').click();
  await expect(page.getByTestId('replay-time')).toHaveText(/9:00:30 AM/);
  await page.getByLabel('Go to (park time HH:MM)').fill('9:40');
  await page.getByRole('button', { name: 'Seek' }).click();
  await expect(page.getByTestId('replay-time')).toHaveText(/9:40:00 AM/);
  await expect(page.getByTestId('replay-resolution')).toContainText('30s');
  await page.waitForTimeout(500);
  const calls: string[] = await page.evaluate(() => globalThis.__fixtureCallLog ?? []);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((c) => c === 'query:getFrames')).toBe(true);
  expect(appErrors(errors)).toEqual([]);
});
