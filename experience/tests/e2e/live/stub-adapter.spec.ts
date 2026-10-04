/** C-01/C-05: the live profile loads Engine's adapter by same-origin URL; invalid parks are shown. */
import { expect, test } from '@playwright/test';

test('@stub-adapter live build loads the configured adapter module and shows park validation issues', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'New simulation' }).first()).toBeVisible();
  await expect(page.getByTestId('fixture-banner')).toHaveCount(0);
  await page.goto('/setup');
  await expect(page.getByTestId('choose-park-stub-invalid')).toContainText('Invalid');
  await expect(page.getByText(/unreachable from the main gate/)).toBeVisible();
  await expect(page.getByTestId('choose-park-stub-invalid')).toBeDisabled();
  await expect(page.getByText('This park failed validation.')).toBeVisible();
});
