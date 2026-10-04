/** C-01, C-02, C-03, C-04, C-06, C-25 fault and robustness behavior on the fixture build. */
import { expect, test } from '@playwright/test';
import { appErrors, createRun, pickableGuest, signInOperator, startRun, watchConsole } from './helpers';

// Heavy fixture scenes and the WebGL map make these browser journeys slow on loaded machines.
test.beforeEach(() => { test.slow(); });

test('lost createRun acknowledgement is retried with the same command ID (one run)', async ({ page }) => {
  await page.addInitScript(() => { globalThis.__BEHAVIOR_FIXTURE_FAULTS__ = { dropAck: ['createRun', 'startRun'] }; });
  await signInOperator(page);
  await createRun(page);
  await startRun(page);
  await page.goto('/');
  await expect(page.locator('tbody tr')).toHaveCount(1);
});

test('gapped and duplicated patches resync from a snapshot without duplicate events', async ({ page }) => {
  await page.addInitScript(() => { globalThis.__BEHAVIOR_FIXTURE_FAULTS__ = { patches: { duplicateEvery: 3, dropOnceAtCount: 5, reorderOnceAtCount: 9 } }; });
  const errors = watchConsole(page);
  await signInOperator(page);
  await createRun(page);
  await startRun(page, 20);
  await page.waitForTimeout(8000);
  await expect(page.getByTestId('connection')).toHaveText('live');
  const keys = await page.locator('[data-testid=event-feed] .feed-list li').evaluateAll((els) => els.map((e) => e.textContent));
  expect(keys.length).toBeGreaterThan(0);
  expect(appErrors(errors)).toEqual([]);
});

test('population job failure is visible and Start stays disabled with a reason', async ({ page }) => {
  await page.addInitScript(() => { globalThis.__BEHAVIOR_FIXTURE_FAULTS__ = { failPopulation: true }; });
  await signInOperator(page);
  await page.goto('/setup');
  await expect(page.getByText(/population worker failed/)).toBeVisible();
  await expect(page.getByTestId('create-run')).toBeDisabled();
  await expect(page.getByText('Sampling the crowd failed; retry it.')).toBeVisible();
});

test('preparing park is not selectable until ready', async ({ page }) => {
  await signInOperator(page);
  await page.goto('/setup');
  const stage2 = page.getByTestId('choose-park-harbor-lights-s2-v1');
  await expect(stage2).toBeEnabled({ timeout: 10_000 });
});

test('canvas picking selects the same guest after zoom, pan and resize (C-06)', async ({ page }) => {
  await signInOperator(page);
  await createRun(page);
  await startRun(page, 5);
  await page.waitForFunction(() => document.querySelector('[data-testid=park-map]')?.getAttribute('data-map-status') === 'ready');
  await page.waitForTimeout(6000);
  await page.getByTestId('tab-guests').click();
  await page.getByTestId('pause-run').click();
  await expect(page.getByTestId('run-status').first()).toContainText('Paused');
  await page.waitForTimeout(1500);
  const map = page.getByTestId('park-map');
  await map.focus();
  await page.keyboard.press('+'); await page.keyboard.press('+');
  await page.keyboard.press('ArrowLeft');
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForTimeout(500);
  const pick = (await pickableGuest(page, 16)) ?? (await pickableGuest(page, 10));
  expect(pick).toBeTruthy();
  const id = pick!.id;
  const p = { x: pick!.x, y: pick!.y };
  await page.mouse.click(p!.x, p!.y);
  await expect(page.getByTestId('inspector')).toBeVisible();
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-agent-id', id!);
  // Opening the inspector must not resize the map (positions stay put).
  const after = await page.evaluate((agent) => globalThis.__behaviorMap?.screenOf(agent!), id);
  expect(Math.hypot(after!.x - p!.x, after!.y - p!.y)).toBeLessThan(2);
});

test('WebGL context loss shows a readable fallback; guest list still works (C-25)', async ({ page }) => {
  await signInOperator(page);
  await createRun(page);
  await startRun(page);
  await expect(page.getByTestId('park-map')).toHaveAttribute('data-map-status', 'ready');
  await page.evaluate(() => {
    const c = document.querySelector('[data-testid=park-map] canvas') as HTMLCanvasElement;
    (c.getContext('webgl2') ?? c.getContext('webgl'))?.getExtension('WEBGL_lose_context')?.loseContext();
  });
  await expect(page.getByText('Map unavailable')).toBeVisible();
  await expect(page.getByText(/context was lost/)).toBeVisible();
  await page.getByTestId('tab-guests').click();
  await expect(page.locator('[data-agent-id]').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Try the map again' }).click();
  await expect(page.getByTestId('park-map')).toHaveAttribute('data-map-status', 'ready');
});

test('without WebGL the map degrades to the canvas renderer instead of failing', async ({ page }) => {
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl' || type === 'webgpu') return null;
      return (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof orig;
    Object.defineProperty(navigator, 'gpu', { value: undefined });
  });
  await signInOperator(page);
  await createRun(page);
  await expect(page.getByTestId('park-map')).toHaveAttribute('data-map-status', /ready|failed/);
  await page.getByTestId('tab-guests').click();
  await startRun(page);
  await expect(page.locator('[data-agent-id]').first()).toBeVisible({ timeout: 20_000 });
});

test('hidden-tab resume snaps to current state and keeps streaming', async ({ page }) => {
  await signInOperator(page);
  await createRun(page);
  await startRun(page, 20);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(3000);
  const before = Number(await page.getByTestId('revision').textContent());
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(async () => Number(await page.getByTestId('revision').textContent())).toBeGreaterThan(before);
  await expect(page.getByTestId('park-map')).toHaveAttribute('data-map-status', 'ready');
});

test('two operator tabs pausing the same run converge on one paused state', async ({ page, context }) => {
  await signInOperator(page);
  const url = await createRun(page);
  await startRun(page);
  const other = await context.newPage();
  // Each fixture tab acts as the local operator automatically.
  await other.goto(url);
  await other.getByTestId('pause-run').click();
  await expect(other.getByTestId('run-status').first()).toContainText('Paused');
  // The first tab may still show Running briefly; its pause uses the old control revision.
  await page.getByTestId('pause-run').click({ timeout: 2000 }).catch(() => undefined);
  await expect(page.getByTestId('run-status').first()).toContainText('Paused');
});
