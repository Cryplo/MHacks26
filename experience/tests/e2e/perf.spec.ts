/**
 * C-25 measured interaction/frame profile at 200/300/400 guests (fixture scene). Records
 * what was measured on THIS machine; it is not a performance claim for other hardware.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { expect, test, type Page } from '@playwright/test';
import { createRun, signInOperator, startRun } from './helpers';

type Sample = { guests: number; condition: string; viewport: string; dpr: number; agentsRendered: number; fps: number; p95FrameMs: number; longTasksMs: number; panZoomMs: number; feedItems: number };
const results: Sample[] = [];

async function measure(page: Page, seconds: number) {
  return page.evaluate(async (s) => {
    const frames: number[] = [];
    let long = 0;
    const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) long += e.duration; });
    try { obs.observe({ entryTypes: ['longtask'] }); } catch { /* unsupported */ }
    await new Promise<void>((resolve) => {
      let last = performance.now(); const end = last + s * 1000;
      const tick = (t: number) => { frames.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); else resolve(); };
      requestAnimationFrame(tick);
    });
    obs.disconnect();
    const sorted = [...frames].sort((a, b) => a - b);
    return { fps: frames.length / s, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, long };
  }, seconds);
}

for (const guests of [200, 300, 400]) {
  test(`@perf profile ${guests} guests`, async ({ page }) => {
    test.setTimeout(300_000);
    await signInOperator(page);
    await createRun(page, { guests });
    await startRun(page, 60);
    await page.waitForTimeout(75_000); // ~75 simulated minutes: most groups have arrived
    const cdp = await page.context().newCDPSession(page);
    for (const cond of [{ name: 'desktop', w: 1440, h: 900, dpr: 1, mobile: false }, { name: 'desktop-hidpi', w: 1440, h: 900, dpr: 2, mobile: false }, { name: 'mobile', w: 375, h: 812, dpr: 3, mobile: true }]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: cond.w, height: cond.h, deviceScaleFactor: cond.dpr, mobile: cond.mobile });
      await page.waitForTimeout(1500);
      const m = await measure(page, 5);
      const t0 = Date.now();
      await page.getByTestId('park-map').focus();
      for (let i = 0; i < 5; i++) { await page.keyboard.press('+'); await page.keyboard.press('ArrowLeft'); }
      await page.keyboard.press('0');
      const panZoomMs = Date.now() - t0;
      const inPark = Number((await page.getByTestId('stat-inpark').locator('.value').textContent())?.replace(/\D/g, '') || 0);
      const feedItems = await page.locator('[data-testid=event-feed] .feed-list li').count();
      results.push({ guests, condition: cond.name, viewport: `${cond.w}x${cond.h}`, dpr: cond.dpr, agentsRendered: inPark, fps: Math.round(m.fps * 10) / 10, p95FrameMs: Math.round(m.p95 * 10) / 10, longTasksMs: Math.round(m.long), panZoomMs, feedItems });
      expect(feedItems).toBeLessThanOrEqual(120); // bounded feed
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    save();
  });
}

const FILE = 'artifacts/perf/profile.json';
function save() {
  const prev = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as { results: Sample[] }).results : [];
  const keep = prev.filter((r) => !results.some((n) => n.guests === r.guests && n.condition === r.condition));
  const report = {
    measuredAt: new Date().toISOString(), note: 'Headless Chromium (Playwright) on the machine below, fixture scene at 60x playback. Not a claim for other hardware.',
    machine: { platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpus: os.cpus()[0]?.model, cores: os.cpus().length, memoryGb: Math.round(os.totalmem() / 2 ** 30) },
    results: [...keep, ...results].sort((a, b) => a.guests - b.guests || a.condition.localeCompare(b.condition)),
  };
  writeFileSync(FILE, JSON.stringify(report, null, 2) + '\n');
}
