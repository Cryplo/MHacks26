import { expect, type ConsoleMessage, type Page } from '@playwright/test';

/** Collects console errors and page errors; tests assert this stays empty. */
export function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** The fixture build acts as the local operator automatically; there is no sign-in step. */
export async function signInOperator(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'New simulation' }).first()).toBeVisible();
}

/** For tests about unauthorized access: give this page a session the server does not know. */
export async function useAnonymousSession(page: Page) {
  await page.addInitScript(() => { try { sessionStorage.setItem('behavior-engine.session-token.v1', 'not-a-granted-token'); } catch { /* ignore */ } });
}

/** Opens a collapsed disclosure by its summary text (no-op when already open). */
export async function openDisclosure(page: Page, summary: string | RegExp) {
  const details = page.locator('details', { has: page.locator('summary', { hasText: summary }) }).first();
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) await details.locator('summary').first().click();
}

/** Setup is one screen: the park is preselected and the crowd is sampled automatically. */
export async function createRun(page: Page, opts: { guests?: number; preset?: string } = {}) {
  await page.goto('/setup');
  // The most complete park is preselected once validation settles.
  await expect(page.getByTestId('choose-park-harbor-lights-s2-v1')).toHaveAttribute('aria-pressed', 'true');
  // 300 guests keeps browser journeys quick; perf profiles pass their own sizes.
  await page.getByTestId('guest-count').fill(String(opts.guests ?? 300));
  if (opts.preset) await page.getByTestId(`preset-${opts.preset}`).check({ force: true });
  await expect(page.getByTestId('population-preview')).toBeVisible();
  await page.getByTestId('create-run').click();
  // Creating a run builds the population scene; with hundreds of guests this can take a while.
  await expect(page.getByTestId('live-page')).toBeVisible({ timeout: 90_000 });
  return page.url();
}

/** Runs created from setup start automatically; otherwise (or after a lost ack) press play. */
export async function startRun(page: Page, speed?: number) {
  const status = page.getByTestId('run-status').first();
  const start = page.getByTestId('start-run');
  await expect(async () => {
    const current = (await status.textContent({ timeout: 5000 }).catch(() => null)) ?? '';
    // isEnabled waits for the element; the button can vanish as the run starts, so bound it.
    if (!/Running|Blocked/.test(current) && await start.isVisible() && await start.isEnabled({ timeout: 1000 }).catch(() => false)) await start.click({ timeout: 1000 }).catch(() => undefined);
    await expect(status).toContainText(/Running|Blocked/, { timeout: 10_000 });
  }).toPass({ timeout: 150_000 });
  if (speed) await page.getByTestId(`speed-${speed}`).click();
}

/** What-if and Share live behind the run menu. */
export async function openRunPanel(page: Page, panel: 'whatif' | 'share') {
  await page.getByTestId('run-menu').click();
  await page.getByTestId(`menu-${panel}`).click();
}

export const appErrors = (errors: string[]) => errors.filter((e) => !/GL Driver|GPU stall|WebGL|fonts\.g(oogleapis|static)\.com/.test(e));

/**
 * A displayed guest that a pointer can hit unambiguously: on the map canvas (not under an
 * overlay) and at least `gap` px from every other guest. Big crowds clump in queues, where the
 * nearest-guest pick is legitimately a neighbour.
 */
export async function pickableGuest(page: Page, gap = 16): Promise<{ id: string; x: number; y: number } | null> {
  return page.evaluate((minGap) => {
    const ids = Array.from(new Set(Array.from(document.querySelectorAll('[data-agent-id]')).map((e) => e.getAttribute('data-agent-id')!)));
    const map = globalThis.__behaviorMap;
    const canvas = document.querySelector('[data-testid=park-map] canvas');
    if (!map || !canvas) return null;
    const pts = ids.map((id) => ({ id, p: map.screenOf(id) })).filter((x): x is { id: string; p: { x: number; y: number } } => x.p !== null);
    for (const a of pts) {
      if (document.elementFromPoint(a.p.x, a.p.y) !== canvas) continue;
      if (pts.every((b) => b === a || Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y) >= minGap)) return { id: a.id, x: a.p.x, y: a.p.y };
    }
    return null;
  }, gap);
}
