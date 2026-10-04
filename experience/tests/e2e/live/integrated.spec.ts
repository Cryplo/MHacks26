/**
 * C-14/C-16/C-22 against REAL backend state: A's SpacetimeDB module + registered Harbor
 * Lights park + B's deterministic mock worker. Requires BEHAVIOR_OPERATOR_TOKEN issued by
 * A's trusted local allowlist bootstrap (dev:seed). Not runnable without those lanes.
 */
import { expect, test, type Page } from '@playwright/test';

const token = process.env.BEHAVIOR_OPERATOR_TOKEN;
test.skip(!token, 'NOT RUN: BEHAVIOR_OPERATOR_TOKEN (from Engine dev:seed) is not set');

async function signIn(page: Page) {
  await page.goto('/session');
  await page.getByLabel('Session credential').fill(token!);
  await page.getByRole('button', { name: 'Use credential' }).click();
  await expect(page.getByTestId('session-chip')).toContainText('operator', { timeout: 60_000 });
}

test('@integrated registered park -> population -> run -> inspect -> approved intervention -> metrics -> A/B report', async ({ page, context }) => {
  await signIn(page);
  await expect(page.getByTestId('fixture-banner')).toHaveCount(0);
  await page.goto('/setup');
  const ready = page.getByTestId('choose-park-harbor-lights-s1-v1');
  await ready.click({ timeout: 120_000 });
  await page.getByTestId('guest-count').fill('200');
  await page.getByRole('button', { name: 'Fit to crowd size' }).click();
  await page.getByTestId('request-preview').click();
  await expect(page.getByTestId('population-preview')).toBeVisible({ timeout: 300_000 });
  await page.getByTestId('create-run').click();
  await expect(page.getByTestId('live-page')).toBeVisible();
  await expect(page.getByTestId('mode-badges').first()).toContainText('Mock');
  await page.getByTestId('start-run').click({ timeout: 300_000 });
  await expect(page.getByTestId('connection')).toHaveText('live');
  const runUrl = page.url().split('?')[0]!;

  // Inspect a guest with real evidence.
  await page.getByTestId('tab-guests').click();
  await page.getByTestId('only-decided').check();
  await page.locator('[data-agent-id]').first().click({ timeout: 300_000 });
  await expect(page.getByTestId('evidence-source')).toContainText(/Mock provider|Cached distribution/, { timeout: 300_000 });

  // Viewer link + unauthorized session against real grants (C-14/C-15).
  await page.getByTestId('tab-share').click();
  await page.getByTestId('issue-share').click();
  const link = await page.getByTestId('share-link').inputValue();
  const viewerCtx = await context.browser()!.newContext();
  const viewer = await viewerCtx.newPage();
  await viewer.goto(link);
  await expect(viewer.getByTestId('viewer-note')).toBeVisible({ timeout: 60_000 });
  const strangerCtx = await context.browser()!.newContext();
  const stranger = await strangerCtx.newPage();
  await stranger.goto(`${runUrl}?role=operator`);
  await expect(stranger.getByText('No access to this run')).toBeVisible({ timeout: 60_000 });

  // Approved intervention through parse -> confirm -> receipt -> applied.
  await page.getByTestId('tab-whatif').click();
  await page.getByTestId('whatif-text').fill('close the carousel in 2 minutes');
  await page.getByTestId('whatif-parse').click();
  await expect(page.getByTestId('draft-card')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('whatif-confirm').click();
  await expect(page.locator('[data-applied=true]')).toBeVisible({ timeout: 600_000 });
  await expect(viewer.getByTestId('event-feed')).toContainText('Scenario applied', { timeout: 120_000 });

  // Same authoritative revision in both sessions after pause (C-16).
  await page.getByTestId('pause-run').click();
  await expect(viewer.getByTestId('run-status').first()).toContainText('Paused', { timeout: 60_000 });
  await expect(viewer.getByTestId('revision')).toHaveText((await page.getByTestId('revision').textContent())!, { timeout: 60_000 });

  // Reconnect from snapshot without duplicate events.
  await viewer.reload();
  await expect(viewer.getByTestId('connection')).toHaveText('live', { timeout: 60_000 });

  await page.goto(`${runUrl}/results`);
  await expect(page.getByTestId('metrics-table')).toBeVisible();
  await page.goto('/experiments/new');
  await page.getByTestId('create-experiment').click();
  await expect(page.getByTestId('pairs-table')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('evidence-labels')).toContainText('Mock');
  await viewerCtx.close(); await strangerCtx.close();
});
