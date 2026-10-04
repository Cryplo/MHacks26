/** C-21 full fixture journey without keys/server; C-04 command IDs and reload; C-12 what-if. */
import { expect, test } from '@playwright/test';
import { appErrors, openDisclosure, openRunPanel, signInOperator, startRun, watchConsole } from './helpers';

// Heavy fixture scenes and the WebGL map make these browser journeys slow on loaded machines.
test.beforeEach(() => { test.slow(); });

test('full fixture journey: setup -> live -> inspect -> what-if -> results -> exports -> replay', async ({ page }) => {
  const errors = watchConsole(page);
  await signInOperator(page);
  await expect(page.getByTestId('fixture-banner')).toBeVisible();

  // Setup: the park is preselected and the crowd is sampled automatically.
  await page.goto('/setup');
  await expect(page.getByTestId('choose-park-harbor-lights-s2-v1')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('guest-count').fill('300');
  await expect(page.getByTestId('population-preview')).toBeVisible();
  // Invalid shares block Start with a stated reason (and no sampling happens).
  await openDisclosure(page, 'Customize the mix');
  await page.getByTestId('mix-teens').fill('400');
  await expect(page.getByText(/Archetype sliders assign/)).toBeVisible();
  await expect(page.getByTestId('create-run')).toBeDisabled();
  await page.getByRole('button', { name: 'Fit to crowd size' }).click();
  await expect(page.getByTestId('population-preview')).toBeVisible();
  // Editing the crowd re-samples instead of silently reusing the old population.
  await page.getByTestId('guest-count').fill('299');
  await expect(page.getByTestId('population-preview')).toContainText('299');
  await openDisclosure(page, 'Run plan details');
  await expect(page.getByTestId('frozen-plan')).toContainText('Plan hash');
  await expect(page.getByTestId('population-preview')).toBeVisible();
  await expect(page.getByTestId('mode-select').locator('option[value=live]')).toHaveAttribute('disabled', '');

  // Double click create -> exactly one run.
  await page.getByTestId('create-run').dblclick();
  await expect(page.getByTestId('live-page')).toBeVisible({ timeout: 90_000 });
  const runUrl = page.url();
  await page.goto('/');
  await expect(page.locator('tbody tr')).toHaveCount(1);

  // Reload on the run route reconnects to the same run.
  await page.goto(runUrl);
  await page.reload();
  await expect(page).toHaveURL(runUrl);
  await startRun(page, 60);
  await expect(page.getByTestId('connection')).toHaveText('live');

  // Keyboard alternative to canvas picking; Escape returns to the overview.
  await page.getByTestId('tab-guests').click();
  const first = page.locator('[data-agent-id]').first();
  await first.focus();
  // Read the focused row itself: new arrivals can reorder the list between two queries.
  const agentId = await page.evaluate(() => document.activeElement?.getAttribute('data-agent-id') ?? null);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-agent-id', agentId!);
  await expect(page.getByTestId('evidence-source')).toContainText('not Jev');
  await expect(page.locator('[data-sampled=true]')).toHaveCount(1);
  await expect(page.getByTestId('guest-status')).toBeVisible();
  await expect(page.getByTestId('rationale')).not.toBeEmpty();
  await page.getByTestId('narrate').click();
  await expect(page.getByTestId('narrative')).toContainText('narrated from state');
  await expect(page.getByTestId('guest-name')).toHaveText(/^\S+ \S+$/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('inspector')).toHaveCount(0);
  // The overview's compact stats expand into the full dashboard over the live run.
  await page.getByTestId('tab-summary').click();
  await page.getByTestId('expand-dashboard').click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('chart-queues')).toBeVisible();
  await page.getByTestId('close-dashboard').click();
  await expect(page.getByTestId('dashboard-overlay')).toHaveCount(0);
  await expect(page).not.toHaveURL(/guest=/);

  // What-if: parse -> review -> confirm -> accepted -> applied; unsupported fragments shown.
  await openRunPanel(page, 'whatif');
  await page.getByTestId('whatif-text').fill('close the coaster at 9:50; make it a hot day');
  await page.getByTestId('whatif-parse').click();
  await expect(page.getByTestId('draft-card')).toContainText('9:50 AM park time');
  await expect(page.getByTestId('unsupported')).toContainText('hot day');
  await page.getByTestId('whatif-confirm').click();
  await expect(page.getByTestId('scheduled')).toContainText('scheduled');
  await expect(page.locator('[data-applied=true]')).toBeVisible({ timeout: 180_000 });

  // Results + report + exports.
  await page.goto(`${runUrl}/results`);
  await expect(page.getByTestId('result-quality')).toContainText('In progress');
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('limitations')).toContainText('Fixture data');
  const csvDl = page.waitForEvent('download');
  await page.getByTestId('export-menu').click();
  await page.getByTestId('export-csv').click();
  const csv = await (await (await csvDl).createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
  expect(csv).toContain('modes=Fixture');
  expect(csv).toContain('net_revenue_cents');
  const jsonDl = page.waitForEvent('download');
  await page.getByTestId('export-menu').click();
  await page.getByTestId('export-json').click();
  const json = JSON.parse(await (await (await jsonDl).createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8')));
  expect(json.source.modes).toContain('Fixture');
  expect(json.units.money).toBe('integer USD cents');
  await page.goto(`${runUrl}/print`);
  await expect(page.getByTestId('print-caveats')).toContainText('FIXTURE');

  // Replay lives on the live view's timeline and reads recorded frames only: no commands, no product work.
  await page.goto(`${runUrl}/replay`);
  await expect(page).toHaveURL(/[?&]t=0/);
  await expect(page.getByTestId('sim-clock')).toHaveText(/9:00:00 AM/);
  await expect(page.getByTestId('back-to-live')).toBeVisible();
  await page.evaluate(() => { globalThis.__fixtureCallLog = []; });
  const knob = page.getByTestId('timeline-knob');
  await knob.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('sim-clock')).toHaveText(/9:01:00 AM/);
  await page.keyboard.press('PageUp');
  await expect(page.getByTestId('sim-clock')).toHaveText(/9:11:00 AM/);
  await expect.poll(() => page.evaluate(() => Number(document.querySelector('[data-testid=live-page]')?.getAttribute('data-frame-ms') || -1))).toBeGreaterThan(600_000);
  const calls: string[] = await page.evaluate(() => globalThis.__fixtureCallLog ?? []);
  expect(calls).toContain('query:getFrames');
  expect(calls.filter((c) => c.startsWith('command:'))).toEqual([]);
  // Back to live returns to the stream.
  await page.getByTestId('back-to-live').click();
  await expect(page.getByTestId('live-indicator')).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]t=/);
  expect(appErrors(errors)).toEqual([]);
});
