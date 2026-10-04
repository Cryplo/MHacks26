/** C-06 isometric camera + authoritative-grid terrain rules. */
import { describe, expect, it } from 'vitest';
import { IsoCamera } from '../../src/renderer/camera';
import { IsoProjection } from '../../src/renderer/iso';
import { cellMaterials, isWalkableCode, queueRails } from '../../src/renderer/terrain';

describe('IsoCamera (C-06)', () => {
  const make = () => { const c = new IsoCamera(new IsoProjection(200, 150)); c.setViewport(1000, 600); return c; };
  it('round-trips ground points through the iso projection at any zoom/pan', () => {
    const c = make();
    for (const [f, dx, dy] of [[1, 0, 0], [2.5, 40, -30], [0.6, -200, 15]] as const) {
      c.zoomAt({ x: 300, y: 200 }, f); c.pan(dx, dy);
      const w = { xM: 123.4, yM: 56.7 };
      const back = c.screenToWorld(c.worldToScreen(w));
      expect(back.xM).toBeCloseTo(w.xM, 9); expect(back.yM).toBeCloseTo(w.yM, 9);
    }
  });
  it('zoom keeps the ground point under the cursor fixed', () => {
    const c = make();
    const at = { x: 321, y: 123 };
    const before = c.screenToWorld(at);
    c.zoomAt(at, 3);
    const after = c.screenToWorld(at);
    expect(after.xM).toBeCloseTo(before.xM, 9); expect(after.yM).toBeCloseTo(before.yM, 9);
  });
  it('is a 2:1 dimetric projection: +x goes right-down, +y goes left-down, height goes up', () => {
    const c = make();
    const o = c.worldToScreen({ xM: 50, yM: 50 });
    const ex = c.worldToScreen({ xM: 51, yM: 50 }); const ey = c.worldToScreen({ xM: 50, yM: 51 }); const up = c.worldToScreen({ xM: 50, yM: 50 }, 1);
    expect((ex.y - o.y) / (ex.x - o.x)).toBeCloseTo(0.5, 9);
    expect((ey.y - o.y) / (o.x - ey.x)).toBeCloseTo(0.5, 9);
    expect(up.x).toBeCloseTo(o.x, 9); expect(up.y).toBeLessThan(o.y);
  });
  it('fits the whole park diamond in the viewport', () => {
    const c = make();
    for (const p of [{ xM: 0, yM: 0 }, { xM: 200, yM: 0 }, { xM: 0, yM: 150 }, { xM: 200, yM: 150 }]) {
      const s = c.worldToScreen(p);
      expect(s.x).toBeGreaterThanOrEqual(0); expect(s.x).toBeLessThanOrEqual(1000);
      expect(s.y).toBeGreaterThanOrEqual(0); expect(s.y).toBeLessThanOrEqual(600);
    }
  });
});

describe('terrain follows the authoritative grid (C-05)', () => {
  it('decor never turns a walkable cell into scenery, and blocked cells never become paving', () => {
    const W = 6; const H = 4;
    const codes = new Uint8Array([
      0, 0, 1, 1, 0, 0,
      0, 2, 2, 4, 0, 3,
      3, 3, 1, 4, 0, 3,
      0, 0, 0, 0, 0, 0,
    ]);
    const mats = cellMaterials(codes, W, H, [{ kind: 'water', x: 0, y: 0, w: 6, h: 4, placeId: null }]);
    for (let i = 0; i < W * H; i++) {
      const paved = mats[i] === 'path' || mats[i] === 'plaza' || mats[i] === 'queue';
      expect(paved).toBe(isWalkableCode(codes[i]!, false) && codes[i] !== 3);
      if (codes[i] === 0) expect(mats[i]).toBe('water');
    }
  });
  it('queue rails separate serpentine lanes but leave the lane turns open', () => {
    // 3x2 queue, cells in serpentine order: row 0 left->right, row 1 right->left.
    const W = 3;
    const order = [[0, 1, 2, 5, 4, 3]];
    const rails = queueRails(order, W);
    // Horizontal rail between rows under cells 0 and 1, but not under 2 (the turn 2->5).
    expect(rails).toContainEqual([0, 1, 1, 1]);
    expect(rails).toContainEqual([1, 1, 2, 1]);
    expect(rails).not.toContainEqual([2, 1, 3, 1]);
  });
});
