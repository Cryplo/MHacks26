import { expect, type ConsoleMessage, type Page } from '@playwright/test';

/** Collects console errors and page errors; tests assert this stays empty. */
export function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

export async function signInOperator(page: Page) {
  await page.goto('/session');
  await page.getByTestId('fixture-operator-signin').click();
  await expect(page.getByTestId('session-chip')).toContainText('operator');
}

export async function createRun(page: Page, opts: { guests?: number; preset?: string } = {}) {
  await page.goto('/setup');
  await page.getByTestId('choose-park-harbor-lights-s1-v1').click();
  if (opts.guests) {
    await page.getByTestId('guest-count').fill(String(opts.guests));
    const fit = page.getByRole('button', { name: 'Fit to crowd size' });
    if (await fit.isEnabled()) await fit.click();
  }
  await page.getByTestId('request-preview').click();
  await expect(page.getByTestId('population-preview')).toBeVisible();
  if (opts.preset) await page.getByTestId(`preset-${opts.preset}`).check();
  await page.getByTestId('create-run').click();
  await expect(page.getByTestId('live-page')).toBeVisible();
  return page.url();
}

export async function startRun(page: Page, speed?: number) {
  await page.getByTestId('start-run').click({ timeout: 15_000 });
  await expect(page.getByTestId('run-status').first()).toContainText(/Running|Blocked/);
  if (speed) await page.selectOption('select[aria-label="Requested simulation speed"]', String(speed));
}

export const appErrors = (errors: string[]) => errors.filter((e) => !/GL Driver|GPU stall|WebGL/.test(e));
