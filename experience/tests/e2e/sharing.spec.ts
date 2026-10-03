/**
 * C-14/C-15/C-16 in the FIXTURE profile: tabs of one browser context share the scripted
 * fixture server while each tab is its own session. Integrated proof against Engine is
 * the live suite (test:e2e:live).
 */
import { expect, test } from '@playwright/test';
import { appErrors, createRun, signInOperator, startRun, watchConsole } from './helpers';

test('viewer link, unauthorized session, role-by-URL, shared revision, revocation', async ({ context, page }) => {
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  await signInOperator(page);
  const runUrl = await createRun(page);
  await startRun(page, 60);

  // No role in a fresh session: neither the run nor ?role=operator grants anything.
  const stranger = await context.newPage();
  await stranger.goto(`${runUrl}?role=operator`);
  await expect(stranger.getByText('No access to this run')).toBeVisible();
  await expect(stranger.getByTestId('start-run')).toHaveCount(0);

  // Operator issues a read-only link; only the hash goes to the server.
  await page.getByTestId('tab-share').click();
  await page.getByTestId('issue-share').click();
  const link = await page.getByTestId('share-link').inputValue();
  expect(link).toMatch(/\/share#t=[A-Za-z0-9_-]{43}$/);
  const token = link.split('#t=')[1]!;
  const stored = await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage));
  expect(stored).not.toContain(token);

  const viewer = await context.newPage();
  const viewerErrors = watchConsole(viewer);
  await viewer.goto(link);
  await expect(viewer.getByTestId('live-page')).toBeVisible();
  expect(viewer.url()).not.toContain('#t=');
  expect(await viewer.evaluate(() => window.location.hash)).toBe('');
  await expect(viewer.getByTestId('viewer-note')).toBeVisible();
  await expect(viewer.getByTestId('tab-whatif')).toHaveCount(0);
  await expect(viewer.getByTestId('pause-run')).toHaveCount(0);
  await expect(viewer.getByTestId('session-chip')).toContainText('viewer');

  // Operator schedules a closure; both sessions see it applied.
  await page.getByTestId('tab-whatif').click();
  await page.getByTestId('whatif-text').fill('close the carousel in 5 minutes');
  await page.getByTestId('whatif-parse').click();
  await page.getByTestId('whatif-confirm').click();
  await expect(page.locator('[data-applied=true]')).toBeVisible({ timeout: 90_000 });
  await expect(viewer.getByTestId('event-feed')).toContainText('Scenario applied', { timeout: 30_000 });

  // Pause: both sessions converge on the same authoritative revision.
  await page.getByTestId('pause-run').click();
  await expect(page.getByTestId('run-status').first()).toContainText('Paused');
  await expect(viewer.getByTestId('run-status').first()).toContainText('Paused');
  const rev = await page.getByTestId('revision').textContent();
  await expect(viewer.getByTestId('revision')).toHaveText(rev!);

  // Revoke: the viewer loses access with a scoped message.
  await page.getByTestId('tab-share').click();
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('revoked', { exact: true })).toBeVisible();
  await viewer.reload();
  await expect(viewer.getByText('No access to this run')).toBeVisible();
  await expect(viewer.getByText(/revoked or has expired/)).toBeVisible();
  expect(appErrors(errors)).toEqual([]);
  expect(appErrors(viewerErrors).filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});

test('operator links need an explicit warning acknowledgement', async ({ page }) => {
  await signInOperator(page);
  await createRun(page);
  await page.getByTestId('tab-share').click();
  await page.getByLabel(/Operator \(can control this run\)/).check();
  await expect(page.getByTestId('issue-share')).toBeDisabled();
  await expect(page.getByText('Operator links grant control')).toBeVisible();
  await page.getByLabel(/I understand/).check();
  await page.getByTestId('issue-share').click();
  await expect(page.getByTestId('share-link')).toBeVisible();
});
