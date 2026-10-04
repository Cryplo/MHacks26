/** Dashboard derivations and the recorded-frame cache used by the timeline scrubber. */
import { describe, expect, it } from 'vitest';
import type { AgentView, Heatmap, MetricSnapshot, ParkBundle, ReplayFrame } from '../../contract/behavior-v1';
import { FrameCache } from '../../src/data/frames';
import { sampleEveryMs } from '../../src/data/history';
import { niceTicks } from '../../src/features/dashboard/charts';
import { toParkCells } from '../../src/features/dashboard/ParkPreview';
import { byNearestPlace, downsample, hourTicks, peak, perInterval, ratingBins } from '../../src/features/dashboard/series';

const snap = (simMs: number, revenue: number, early = 0): MetricSnapshot => ({
  runId: 'r', simMs, revision: simMs, definitionVersion: 'm', admittedGuests: 10, guestsInPark: 5,
  measures: {
    net_revenue_cents: { value: revenue }, early_departures: { value: early },
  } as unknown as MetricSnapshot['measures'],
});

describe('dashboard series', () => {
  it('per-interval values are differences of the cumulative Engine value', () => {
    const ms = [snap(0, 0), snap(600_000, 500), snap(900_000, 800), snap(1_500_000, 1400)];
    expect(perInterval(ms, 'net_revenue_cents', 900_000, 1_500_000)).toEqual([{ t: 0, v: 800 }, { t: 900_000, v: 600 }]);
  });
  it('downsampling keeps the first and the newest snapshot', () => {
    const ms = Array.from({ length: 500 }, (_, i) => snap(i * 1000, i));
    const d = downsample(ms, 50);
    expect(d.length).toBeLessThanOrEqual(51);
    expect(d[0]!.simMs).toBe(0);
    expect(d[d.length - 1]!.simMs).toBe(499_000);
  });
  it('peak ignores missing values', () => {
    expect(peak([{ t: 0, v: null }, { t: 1, v: 4 }, { t: 2, v: 2 }])).toEqual({ t: 1, v: 4 });
    expect(peak([{ t: 0, v: null }])).toBeNull();
  });
  it('heat cells are grouped by the nearest place within the radius', () => {
    const park = { places: [{ id: 'a', name: 'A', kind: 'food', entrance: { xM: 2, yM: 2 } }, { id: 'b', name: 'B', kind: 'shop', entrance: { xM: 100, yM: 2 } }] } as unknown as ParkBundle;
    const h = { width: 3, height: 1, cellM: 4, values: [10, 0, 5] } as unknown as Heatmap;
    expect(byNearestPlace(h, park, null, 5)).toEqual([{ id: 'a', name: 'A', value: 10 }, { id: '_elsewhere', name: 'Elsewhere', value: 5 }]);
  });
  it('rating bins count only rated guests, 0-100 in five bands', () => {
    const a = (v: number | null) => ({ rating: v === null ? null : { value: v, atMs: 0, source: 'mock' } }) as AgentView;
    expect(ratingBins([a(0), a(19), a(50), a(100), a(null)]).map((b) => b.value)).toEqual([2, 0, 1, 0, 1]);
  });
  it('hour ticks land on park-local hours and clean y ticks cover the max', () => {
    expect(hourTicks(3 * 3600_000, '09:30', (t) => String(t)).map((x) => x.t)).toEqual([1_800_000, 5_400_000, 9_000_000]);
    expect(niceTicks(870)).toEqual([0, 250, 500, 750, 1000]);
    expect(sampleEveryMs(3 * 3600_000)).toBe(5 * 60_000);
    expect(sampleEveryMs(10 * 3600_000)).toBe(15 * 60_000);
  });
  it('coarse heat cells spread over the park cells they cover', () => {
    const park = { grid: { width: 4, height: 2, cellM: 1 } } as unknown as ParkBundle;
    const h = { width: 2, height: 1, cellM: 2, values: [3, 0] } as unknown as Heatmap;
    expect(toParkCells(h, park).cells.map((c) => c.cell).sort()).toEqual([0, 1, 4, 5]);
  });
});

describe('frame cache (scrubbing)', () => {
  const frame = (atMs: number) => ({ atMs, frameSchema: 'f', snapshot: {} }) as unknown as ReplayFrame;
  it('fetches a small window around the target once and serves nearby times from cache', async () => {
    const calls: [number, number][] = [];
    const cache = new FrameCache({ getFrames: async (from, to) => { calls.push([from, to]); const items = []; for (let t = Math.ceil(from / 30_000) * 30_000; t <= to; t += 30_000) items.push(frame(t)); return { items, nextCursor: null }; } });
    expect((await cache.at(600_000, 30_000))!.atMs).toBe(600_000);
    expect((await cache.at(615_000, 30_000))!.atMs).toBe(600_000);
    expect((await cache.at(660_000, 30_000))!.atMs).toBe(660_000);
    expect(calls.length).toBe(1);
    expect(calls[0]![1] - calls[0]![0]).toBeLessThanOrEqual(300_000);
  });
  it('is bounded', async () => {
    const cache = new FrameCache({ getFrames: async (from, to) => { const items = []; for (let t = Math.ceil(from / 30_000) * 30_000; t <= to; t += 30_000) items.push(frame(t)); return { items, nextCursor: null }; } }, 20);
    for (let t = 0; t < 3600_000; t += 600_000) await cache.at(t, 30_000);
    expect(cache.size()).toBeLessThanOrEqual(20);
  });
});
