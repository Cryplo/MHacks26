/**
 * C-23: selected decision from a REAL Jev run. Runs only when explicitly authorized
 * (BEHAVIOR_REAL_JEV=1 plus credentials/budget configured in B's worker); otherwise NOT RUN.
 */
import { expect, test } from '@playwright/test';

test.skip(process.env.BEHAVIOR_REAL_JEV !== '1' || !process.env.BEHAVIOR_OPERATOR_TOKEN, 'NOT RUN: real-Jev smoke requires BEHAVIOR_REAL_JEV=1, BEHAVIOR_OPERATOR_TOKEN and an authorized Jev budget in the Intelligence worker');

test('@real-jev a live run shows a Jev-sourced distribution, never a mock presented as Jev', async ({ page }) => {
  await page.addInitScript((t) => { localStorage.setItem('behavior-engine.session-token.v1', t); localStorage.setItem('behavior-engine.session-explicit.v1', '1'); }, process.env.BEHAVIOR_OPERATOR_TOKEN!);
  await page.goto('/setup');
  await page.getByTestId('choose-park-harbor-lights-s1-v1').click();
  await page.getByTestId('guest-count').fill('40');
  await page.getByText('Advanced settings').click();
  await page.getByTestId('mode-select').selectOption('live');
  await expect(page.getByTestId('population-preview')).toBeVisible({ timeout: 300_000 });
  await page.getByTestId('create-run').click();
  await expect(page.getByTestId('run-status').first()).toContainText(/Running|Blocked/, { timeout: 300_000 });
  await expect(page.getByTestId('health-strip')).toContainText('Jev');
  await page.getByTestId('tab-guests').click();
  await page.getByTestId('only-decided').check();
  await page.locator('[data-agent-id]').first().click({ timeout: 300_000 });
  await expect(page.getByTestId('evidence-source')).toContainText(/Jev distribution|Cached distribution, originally from Jev|fallback/, { timeout: 300_000 });
  await expect(page.getByTestId('evidence-source')).not.toContainText('Mock provider');
});
