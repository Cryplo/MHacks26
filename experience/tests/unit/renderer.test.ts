/** C-06 camera/picking, C-07 interpolation bounds and discontinuities. */
import { describe, expect, it } from 'vitest';
import { Camera } from '../../src/renderer/camera';
import { pickAgent } from '../../src/renderer/picking';
import { displayPose, isContinuous, pushSample, RenderClock, segmentWalkable, type Sample } from '../../src/renderer/interpolation';

describe('Camera (C-06)', () => {
  it('round-trips world<->screen at any zoom/pan and fits the park', () => {
    const c = new Camera(200, 150);
    c.setViewport(1000, 600);
    expect(c.scale).toBeCloseTo((600 - 16) / 150);
    for (const [f, dx, dy] of [[1, 0, 0], [2.5, 40, -30], [0.6, -200, 15]] as const) {
      c.zoomAt({ x: 300, y: 200 }, f); c.pan(dx, dy);
      const w = { xM: 123.4, yM: 56.7 };
      const back = c.screenToWorld(c.worldToScreen(w));
      expect(back.xM).toBeCloseTo(w.xM, 9); expect(back.yM).toBeCloseTo(w.yM, 9);
    }
  });
  it('zoom keeps the point under the cursor fixed', () => {
    const c = new Camera(200, 150); c.setViewport(800, 600);
    const at = { x: 321, y: 123 };
    const before = c.screenToWorld(at);
    c.zoomAt(at, 3);
    const after = c.screenToWorld(at);
    expect(after.xM).toBeCloseTo(before.xM, 9); expect(after.yM).toBeCloseTo(before.yM, 9);
  });
  it('refits on resize until the user moves, then keeps the centre', () => {
    const c = new Camera(200, 150); c.setViewport(800, 600);
    c.setViewport(400, 300);
    expect(c.scale).toBeCloseTo((300 - 16) / 150);
    c.pan(10, 0);
    const centre = c.screenToWorld({ x: 200, y: 150 });
    c.setViewport(1200, 900);
    const after = c.screenToWorld({ x: 600, y: 450 });
    expect(after.xM).toBeCloseTo(centre.xM, 6);
  });
  it('high-DPI does not enter world maths: CSS pixel transforms are DPR independent', () => {
    const a = new Camera(200, 150); a.setViewport(800, 600);
    const b = new Camera(200, 150); b.setViewport(800, 600); // same CSS size at DPR 3
    expect(a.worldToScreen({ xM: 50, yM: 50 })).toEqual(b.worldToScreen({ xM: 50, yM: 50 }));
  });
});

describe('picking (C-06)', () => {
  it('selects the same agent after zoom and pan using displayed positions', () => {
    const display = new Map([['a1', { xM: 10, yM: 10 }], ['a2', { xM: 11, yM: 10 }], ['a3', { xM: 50, yM: 50 }]]);
    const c = new Camera(200, 150); c.setViewport(800, 600);
    for (const [f, dx] of [[1, 0], [4, 120], [0.7, -50]] as const) {
      c.zoomAt({ x: 100, y: 100 }, f); c.pan(dx, 0);
      const s = c.worldToScreen(display.get('a2')!);
      expect(pickAgent(display, c.screenToWorld(s), Math.max(0.4, c.pxToMetres(10)))).toBe('a2');
    }
    expect(pickAgent(display, { xM: 30, yM: 30 }, 1)).toBeNull();
  });
});

const walk = (p: { xM: number; yM: number }) => p.yM >= 8 && p.yM <= 12; // a horizontal corridor
const s = (simMs: number, x: number, y = 10, state: Sample['state'] = 'walking'): Sample => ({ simMs, pos: { xM: x, yM: y }, state });

describe('interpolation (C-07)', () => {
  it('interpolates between two authoritative samples and never extrapolates', () => {
    let t = pushSample(undefined, s(0, 0), walk);
    t = pushSample(t, s(5000, 5), walk);
    expect(displayPose(t, 2500).pos.xM).toBeCloseTo(2.5);
    expect(displayPose(t, 9000).pos.xM).toBe(5); // clamps at newest
    expect(displayPose(t, -100).pos.xM).toBe(0);
  });
  it('freezes at a barrier (no new sample) rather than continuing', () => {
    let t = pushSample(undefined, s(0, 0), walk);
    t = pushSample(t, s(5000, 5), walk);
    expect(displayPose(t, 60000).pos.xM).toBe(5);
  });
  it('does not walk through a wall: non-walkable segment holds then snaps', () => {
    let t = pushSample(undefined, s(0, 0, 10), walk);
    t = pushSample(t, s(5000, 4, 30), walk); // crosses y>12 (blocked)
    expect(t.continuous).toBe(false);
    expect(displayPose(t, 2500).pos).toEqual({ xM: 0, yM: 10 });
    expect(displayPose(t, 5000).pos).toEqual({ xM: 4, yM: 30 });
    expect(segmentWalkable({ xM: 0, yM: 10 }, { xM: 4, yM: 10 }, walk)).toBe(true);
  });
  it('treats service/queue transitions and impossible speed as discontinuities', () => {
    expect(isContinuous(s(0, 0), s(5000, 1, 10, 'riding'), walk)).toBe(false);
    expect(isContinuous(s(0, 0), s(5000, 1, 10, 'queueing'), walk)).toBe(false);
    expect(isContinuous(s(0, 0), s(5000, 40), walk)).toBe(false); // 8 m/s
    expect(isContinuous(s(0, 0), s(5000, 6), walk)).toBe(true);
  });
  it('out-of-order or seek samples restart without tweening', () => {
    let t = pushSample(undefined, s(10000, 0), walk);
    t = pushSample(t, s(5000, 3), walk);
    expect(t.prev).toBeNull();
    expect(displayPose(t, 7000).pos.xM).toBe(3);
  });
});

describe('RenderClock', () => {
  it('trails by the buffer, advances while running and stops at the target', () => {
    const c = new RenderClock(5000);
    c.update(10000, 10, true, 0);
    expect(c.tick(0)).toBe(5000);
    expect(c.tick(100)).toBe(6000); // 100 ms wall x 10
    expect(c.tick(10_000)).toBe(10000);
  });
  it('paused runs only catch up to the last authoritative time', () => {
    const c = new RenderClock(5000);
    c.update(20000, 10, false, 0);
    c.tick(0);
    expect(c.tick(60_000)).toBe(20000);
  });
  it('snapToTarget after hidden-tab resume avoids a long catch-up', () => {
    const c = new RenderClock(5000);
    c.update(5000, 1, true, 0); c.tick(0);
    c.update(500_000, 1, true, 1); c.snapToTarget(2);
    expect(c.tick(2)).toBe(500_000);
  });
});
