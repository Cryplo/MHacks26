/**
 * C-23: selected decision from a REAL Jev run. Runs only when explicitly authorized
 * (BEHAVIOR_REAL_JEV=1 plus credentials/budget configured in B's worker); otherwise NOT RUN.
 */
import { expect, test } from '@playwright/test';

test.skip(process.env.BEHAVIOR_REAL_JEV !== '1' || !process.env.BEHAVIOR_OPERATOR_TOKEN, 'NOT RUN: real-Jev smoke requires BEHAVIOR_REAL_JEV=1, BEHAVIOR_OPERATOR_TOKEN and an authorized Jev budget in the Intelligence worker');

test('@real-jev a live run shows a Jev-sourced distribution, never a mock presented as Jev', async ({ page }) => {
  await page.goto('/session');
  await page.getByLabel('Session credential').fill(process.env.BEHAVIOR_OPERATOR_TOKEN!);
  await page.getByRole('button', { name: 'Use credential' }).click();
  await page.goto('/setup');
  await page.getByTestId('choose-park-harbor-lights-s1-v1').click();
  await page.getByTestId('guest-count').fill('200');
  await page.getByRole('button', { name: 'Fit to crowd size' }).click();
  await page.getByTestId('request-preview').click();
  await expect(page.getByTestId('population-preview')).toBeVisible({ timeout: 300_000 });
  await page.getByTestId('mode-select').selectOption('live');
  await page.getByTestId('create-run').click();
  await page.getByTestId('start-run').click({ timeout: 300_000 });
  await expect(page.getByTestId('mode-badges').first()).toContainText('Live Jev');
  await page.getByTestId('tab-guests').click();
  await page.getByTestId('only-decided').check();
  await page.locator('[data-agent-id]').first().click({ timeout: 300_000 });
  await expect(page.getByTestId('evidence-source')).toContainText(/Jev distribution|Cached distribution, originally from Jev|fallback/, { timeout: 300_000 });
  await expect(page.getByTestId('evidence-source')).not.toContainText('Mock provider');
});
