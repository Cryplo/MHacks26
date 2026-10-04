/** Display motion smoothing: continuous between authoritative samples at any playback speed. */
import { describe, expect, it } from 'vitest';
import { AdaptiveClock, dampOffset, gridRoute, MotionHistory, smoothSegment } from '../../src/renderer/smoothing';

const corridor = (p: { xM: number; yM: number }) => p.yM >= 8 && p.yM <= 12;

function simulate(speed: number, sampleEveryMs: number, jitter: (i: number) => number, requested = speed) {
  const clock = new AdaptiveClock(); const h = new MotionHistory();
  const v = 1.3; // m/s
  let wall = 0; let nextArrival = 0; let sim = 0; let i = 0;
  const xs: number[] = [];
  for (let f = 0; f < 60 * 20; f++) {
    wall += 1000 / 60;
    while (wall >= nextArrival) {
      h.push({ simMs: sim, pos: { xM: 5 + (v * sim) / 1000, yM: 10 }, state: 'walking' }, corridor);
      clock.update(sim, requested, true, nextArrival);
      sim += sampleEveryMs; i++;
      nextArrival += (sampleEveryMs / speed) * (1 + jitter(i));
    }
    const t = clock.tick(wall);
    xs.push(h.at(t, clock.extrapolation, corridor).pos.xM);
  }
  const steps = xs.slice(240).map((x, k, a) => (k ? x - a[k - 1]! : 0)).slice(1);
  const sorted = [...steps].sort((a, b) => a - b);
  return { med: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]!, min: sorted[0]! };
}

describe('motion smoothing', () => {
  for (const [speed, every] of [[1, 1000], [20, 5000], [60, 5000]] as const) {
    it(`moves steadily at ${speed}x with jittery, bursty arrivals`, () => {
      const r = simulate(speed, every, (i) => (i % 7 === 0 ? 1.6 : i % 7 === 1 ? -0.8 : ((i * 37) % 10) / 25 - 0.2));
      const expected = (1.3 * speed) / 60; // metres per frame at nominal rate
      expect(r.med).toBeGreaterThan(expected * 0.6);
      expect(r.max).toBeLessThan(expected * 3.5); // no jumps
      expect(r.min).toBeGreaterThan(-1e-6); // never moves backwards
    });
  }
  it('follows the achieved rate when the engine is slower than requested (live bursts)', () => {
    // Requested 60x but the engine achieves 20x, publishing 8 steps of 5 s every 2 s of wall time.
    const r = simulate(20, 40_000, () => 0, 60);
    const expected = (1.3 * 20) / 60;
    expect(r.med).toBeGreaterThan(expected * 0.6);
    expect(r.max).toBeLessThan(expected * 3.5);
    expect(r.min).toBeGreaterThan(-1e-6);
  });
  it('routes sparse samples around corners along walkable cells', () => {
    // An L-shaped corridor: y in [8,12] for x <= 20, then x in [16,20] going down to y = 40.
    const L = (p: { xM: number; yM: number }) => (p.yM >= 8 && p.yM <= 12 && p.xM >= 0 && p.xM <= 20) || (p.xM >= 16 && p.xM <= 20 && p.yM >= 8 && p.yM <= 40);
    const route = gridRoute({ xM: 2, yM: 10 }, { xM: 18, yM: 35 }, L, 60)!;
    expect(route).not.toBeNull();
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1]!; const b = route[i]!;
      for (let t = 0; t <= 1; t += 0.05) expect(L({ xM: a.xM + (b.xM - a.xM) * t, yM: a.yM + (b.yM - a.yM) * t })).toBe(true);
    }
    expect(gridRoute({ xM: 2, yM: 10 }, { xM: 18, yM: 35 }, L, 20)).toBeNull(); // too long for the time
  });
  it('snaps (no tween) on impossible speeds and park entry/exit; glides into rides', () => {
    const a = { simMs: 0, pos: { xM: 1, yM: 10 }, state: 'walking' as const };
    expect(smoothSegment(a, { simMs: 1000, pos: { xM: 2, yM: 10 }, state: 'walking' }, corridor)).toBe(true);
    expect(smoothSegment(a, { simMs: 1000, pos: { xM: 2, yM: 20 }, state: 'walking' }, corridor)).toBe(false);
    expect(smoothSegment(a, { simMs: 1000, pos: { xM: 30, yM: 10 }, state: 'walking' }, corridor)).toBe(false);
    expect(smoothSegment(a, { simMs: 1000, pos: { xM: 1.5, yM: 10 }, state: 'riding' }, corridor)).toBe(true);
    expect(smoothSegment(a, { simMs: 1000, pos: { xM: 1.5, yM: 10 }, state: 'left' }, corridor)).toBe(false);
    expect(smoothSegment(a, { simMs: 1000, pos: { xM: 1.5, yM: 10 }, state: 'queueing' }, corridor)).toBe(true);
  });
  it('extrapolates only briefly and never onto blocked cells', () => {
    const h = new MotionHistory();
    h.push({ simMs: 0, pos: { xM: 1, yM: 11.5 }, state: 'walking' }, corridor);
    h.push({ simMs: 1000, pos: { xM: 1, yM: 11.9 }, state: 'walking' }, corridor);
    expect(h.at(3000, 2000, corridor).pos.yM).toBeCloseTo(11.9); // would leave the corridor
    h.push({ simMs: 2000, pos: { xM: 2, yM: 11.9 }, state: 'walking' }, corridor);
    expect(h.at(2500, 400, corridor).pos.xM).toBeCloseTo(2.4);
  });
  it('spring offset decays to zero without overshoot', () => {
    const o = { x: 1, y: -1, vx: 0, vy: 0 };
    let prev = 1;
    for (let i = 0; i < 120; i++) { dampOffset(o, 0.22, 1 / 60); expect(o.x).toBeLessThanOrEqual(prev + 1e-9); expect(o.x).toBeGreaterThanOrEqual(-1e-6); prev = o.x; }
    expect(Math.abs(o.x)).toBeLessThan(1e-3);
  });
});
