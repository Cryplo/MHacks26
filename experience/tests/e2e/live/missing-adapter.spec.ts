/** C-01: a live build without Engine's adapter shows a startup error and never fixture data. */
import { expect, test } from '@playwright/test';

test('@missing-adapter live build without adapter errors explicitly, no fixture fallback', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Runtime unavailable' })).toBeVisible();
  await expect(page.getByText(/will not substitute fixture data/)).toBeVisible();
  await expect(page.getByText('missing_adapter')).toBeVisible();
  await expect(page.getByTestId('fixture-banner')).toHaveCount(0);
  await expect(page.getByTestId('mode-badges')).toHaveCount(0);
  await page.goto('/runs/any-run');
  await expect(page.getByRole('heading', { name: 'Runtime unavailable' })).toBeVisible();
});
