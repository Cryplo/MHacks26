/**
 * Procedural 3D-ish structures (rides, shows, shops, stalls, the gate) drawn as flat-shaded
 * volumes in iso plane space with Pixi Graphics: lit roofs, shaded walls, windows, and a
 * cast-shadow polygon per volume that the ground painter bakes into the terrain.
 * Structures only stand on footprints that are blocked in the authoritative grid.
 */
import { Container, Graphics } from 'pixi.js';
import type { IsoProjection } from './iso';
import { BUILD, hashStr, shade } from './palette';

export type Rect = { x: number; y: number; w: number; h: number };
export type Pt2 = [number, number];
type P3 = [number, number, number];

/** Sun direction for cast shadows: offset on the ground per metre of height. */
export const SHADOW_DIR: Pt2 = [0.62, 0.42];

export type Structure = {
  id: string; placeId: string | null;
  /** Container holding `body` (lit by the day/night tint) and `glow` (additive night lights). */
  g: Container; body: Graphics; glow: Graphics;
  /** Ground light pools (metres) baked into the night light layer. */
  spills: Spill[];
  /** Lighthouse lantern position (metres) for the sweeping beam, if any. */
  beacon?: [number, number, number];
  /** Painter's sort key (x + y of the footprint centre). */
  depth: number;
  foot: { x0: number; y0: number; x1: number; y1: number };
  topM: number;
  shadows: Pt2[][];
};

export type Spill = { x: number; y: number; r: number; a: number };
export const LAMP_WARM = 0xffc27a;

export function hull(points: Pt2[]): Pt2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt2, a: Pt2, b: Pt2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt2[] = []; const upper: Pt2[] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]!; while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

const SOUTH = 0.76; const EAST = 0.58;
const faceShade = (nx: number, ny: number) => 0.67 + 0.09 * ny - 0.09 * nx;

export class Iso3D {
  shadows: Pt2[][] = [];
  spills: Spill[] = [];
  beacon?: [number, number, number];
  readonly glow = new Graphics();
  constructor(readonly g: Graphics, readonly proj: IsoProjection) {}
  /** Additive night-light quad. */
  glowPoly(pts: P3[], color = LAMP_WARM, alpha = 0.9) { this.glow.poly(this.flat(pts)).fill({ color, alpha }); return this; }
  /** A light bulb / lamp head: bright core plus a soft halo (plane units). */
  bulb(p: P3, r = 0.18, color = LAMP_WARM, halo = 3) {
    const x = this.proj.px(p[0], p[1]); const y = this.proj.py(p[0], p[1], p[2]);
    this.glow.circle(x, y, r * halo).fill({ color, alpha: 0.12 });
    this.glow.circle(x, y, r * halo * 0.45).fill({ color, alpha: 0.22 });
    this.glow.circle(x, y, r).fill({ color: 0xfff0d8, alpha: 0.95 });
    return this;
  }
  spill(x: number, y: number, r: number, a = 0.35) { this.spills.push({ x, y, r, a }); }
  private flat(pts: P3[]) { const out: number[] = []; for (const [x, y, z] of pts) out.push(this.proj.px(x, y), this.proj.py(x, y, z)); return out; }
  poly(pts: P3[], color: number, alpha = 1) { this.g.poly(this.flat(pts)).fill({ color, alpha }); return this; }
  line(pts: P3[], color: number, width: number, alpha = 1) {
    const f = this.flat(pts);
    this.g.moveTo(f[0]!, f[1]!);
    for (let i = 2; i < f.length; i += 2) this.g.lineTo(f[i]!, f[i + 1]!);
    this.g.stroke({ color, width, alpha, cap: 'round', join: 'round' });
    return this;
  }
  shadowOf(foot: Pt2[], h: number) {
    if (h <= 0.05) return;
    const pts: Pt2[] = [...foot];
    for (const [x, y] of foot) pts.push([x + SHADOW_DIR[0] * h, y + SHADOW_DIR[1] * h]);
    this.shadows.push(hull(pts));
  }
  shadowLine(a: P3, b: P3, w: number) {
    const ax = a[0] + SHADOW_DIR[0] * a[2]; const ay = a[1] + SHADOW_DIR[1] * a[2];
    const bx = b[0] + SHADOW_DIR[0] * b[2]; const by = b[1] + SHADOW_DIR[1] * b[2];
    const dx = bx - ax; const dy = by - ay; const l = Math.hypot(dx, dy) || 1;
    const nx = (-dy / l) * w / 2; const ny = (dx / l) * w / 2;
    this.shadows.push([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]);
  }
  /** Axis-aligned box; draws the two visible walls (south, east) and the top. */
  box(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, wall: number, top?: number, opts: { edge?: boolean; shadow?: boolean } = {}) {
    this.poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], shade(wall, SOUTH));
    this.poly([[x1, y1, z0], [x1, y0, z0], [x1, y0, z1], [x1, y1, z1]], shade(wall, EAST));
    this.poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], top ?? shade(wall, 1.04));
    // Ambient occlusion at the foot of the walls.
    if (z0 === 0 && z1 > 1) {
      const a = Math.min(0.6, z1 * 0.08);
      this.poly([[x0, y1, 0], [x1, y1, 0], [x1, y1, a], [x0, y1, a]], 0x000000, 0.22);
      this.poly([[x1, y1, 0], [x1, y0, 0], [x1, y0, a], [x1, y1, a]], 0x000000, 0.22);
    }
    if (opts.edge !== false) this.line([[x0, y1, z1], [x1, y1, z1], [x1, y0, z1]], shade(top ?? wall, 1.25), 0.06, 0.5);
    if (opts.shadow !== false) this.shadowOf([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z1);
    return this;
  }
  /** Windows on the visible faces of a box: rows of insets, some warmly lit. */
  windows(x0: number, y0: number, x1: number, y1: number, zs: number[], seed: string, opts: { h?: number; w?: number; spacing?: number; lit?: number } = {}) {
    const wh = opts.h ?? 1.1; const ww = opts.w ?? 0.9; const sp = opts.spacing ?? 2.4; const litP = opts.lit ?? 0.35;
    let k = 0;
    for (const z of zs) {
      for (let x = x0 + sp * 0.6; x + ww < x1 - 0.3; x += sp) {
        const lit = hashStr(`${seed}s${k++}`) < litP;
        const q: P3[] = [[x, y1, z], [x + ww, y1, z], [x + ww, y1, z + wh], [x, y1, z + wh]];
        this.poly(q, lit ? BUILD.glassDay : BUILD.glassDark, 0.88);
        if (lit) { this.glowPoly(q, 0xffb766, 0.92); if (z < 3) this.spill(x + ww / 2, y1 + 1.2, 2.6, 0.22); }
      }
      for (let y = y0 + sp * 0.6; y + ww < y1 - 0.3; y += sp) {
        const lit = hashStr(`${seed}e${k++}`) < litP * 0.8;
        const q: P3[] = [[x1, y + ww, z], [x1, y, z], [x1, y, z + wh], [x1, y + ww, z + wh]];
        this.poly(q, lit ? shade(BUILD.glassDay, 0.85) : shade(BUILD.glassDark, 0.8), 0.85);
        if (lit) { this.glowPoly(q, 0xf0a85c, 0.85); if (z < 3) this.spill(x1 + 1.2, y + ww / 2, 2.6, 0.2); }
      }
    }
  }
  /** Gabled roof; ridge along the longer axis unless `axis` is given. */
  gable(x0: number, y0: number, x1: number, y1: number, z: number, rise: number, roof: number, wall: number, axis?: 'x' | 'y', overhang = 0.35) {
    const ax = axis ?? (x1 - x0 >= y1 - y0 ? 'x' : 'y');
    const o = overhang;
    if (ax === 'x') {
      const ym = (y0 + y1) / 2;
      this.poly([[x0 - o, y0 - o, z], [x1 + o, y0 - o, z], [x1 + o, ym, z + rise], [x0 - o, ym, z + rise]], shade(roof, 1.08));
      this.poly([[x1, y0, z], [x1, y1, z], [x1, ym, z + rise]], shade(wall, EAST));
      this.poly([[x0 - o, y1 + o, z], [x1 + o, y1 + o, z], [x1 + o, ym, z + rise], [x0 - o, ym, z + rise]], shade(roof, 0.8));
      this.line([[x0 - o, ym, z + rise], [x1 + o, ym, z + rise]], shade(roof, 1.3), 0.1, 0.8);
      this.line([[x0 - o, y1 + o, z], [x1 + o, y1 + o, z]], shade(roof, 0.5), 0.08, 0.8);
    } else {
      const xm = (x0 + x1) / 2;
      this.poly([[x0 - o, y0 - o, z], [x0 - o, y1 + o, z], [xm, y1 + o, z + rise], [xm, y0 - o, z + rise]], shade(roof, 1.08));
      this.poly([[x0, y1, z], [x1, y1, z], [xm, y1, z + rise]], shade(wall, SOUTH));
      this.poly([[x1 + o, y0 - o, z], [x1 + o, y1 + o, z], [xm, y1 + o, z + rise], [xm, y0 - o, z + rise]], shade(roof, 0.7));
      this.line([[xm, y0 - o, z + rise], [xm, y1 + o, z + rise]], shade(roof, 1.3), 0.1, 0.8);
      this.line([[x1 + o, y0 - o, z], [x1 + o, y1 + o, z]], shade(roof, 0.45), 0.08, 0.8);
    }
    this.shadowOf([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z + rise * 0.6);
  }
  /** Hipped roof rising to a ridge (or apex for square plans). */
  hip(x0: number, y0: number, x1: number, y1: number, z: number, rise: number, roof: number, overhang = 0.35) {
    const o = overhang; const w = x1 - x0; const h = y1 - y0; const inset = Math.min(w, h) / 2;
    const rx0 = x0 + inset; const rx1 = x1 - inset; const ry0 = y0 + inset; const ry1 = y1 - inset;
    const A: P3 = [x0 - o, y0 - o, z]; const B: P3 = [x1 + o, y0 - o, z]; const C: P3 = [x1 + o, y1 + o, z]; const D: P3 = [x0 - o, y1 + o, z];
    const R0: P3 = [rx0, ry0, z + rise]; const R1: P3 = [rx1, ry1, z + rise];
    const R0b: P3 = w >= h ? [rx0, (y0 + y1) / 2, z + rise] : [(x0 + x1) / 2, ry0, z + rise];
    const R1b: P3 = w >= h ? [rx1, (y0 + y1) / 2, z + rise] : [(x0 + x1) / 2, ry1, z + rise];
    void R0; void R1;
    this.poly([A, B, R1b, R0b], shade(roof, 1.1)); // north
    this.poly([A, R0b, D], shade(roof, 1.0)); // west
    this.poly([B, C, R1b], shade(roof, 0.72)); // east
    this.poly([D, C, R1b, R0b], shade(roof, 0.84)); // south
    this.line([R0b, R1b], shade(roof, 1.3), 0.08, 0.7);
    this.line([D, C, B], shade(roof, 0.45), 0.08, 0.8);
    this.shadowOf([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z + rise * 0.5);
  }
  ring(cx: number, cy: number, r: number, n: number, z: number): P3[] {
    const out: P3[] = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, z]); }
    return out;
  }
  /** n-gon prism (cylinder). */
  prism(cx: number, cy: number, r: number, z0: number, z1: number, wall: number, top?: number, n = 20, shadow = true) {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2; const a1 = ((i + 1) / n) * Math.PI * 2; const am = (a0 + a1) / 2;
      const nx = Math.cos(am); const ny = Math.sin(am);
      if (nx + ny <= -0.05) continue;
      const p0: P3 = [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, z0]; const p1: P3 = [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, z0];
      this.poly([p0, p1, [p1[0], p1[1], z1], [p0[0], p0[1], z1]], shade(wall, faceShade(nx, ny)));
    }
    if (top !== undefined) this.poly(this.ring(cx, cy, r, n, z1), top);
    if (shadow) this.shadowOf(this.ring(cx, cy, r, 12, 0).map(([x, y]) => [x, y] as Pt2), z1);
  }
  /** Cone roof; `color(i)` lets segments alternate (striped tents). */
  cone(cx: number, cy: number, r: number, z: number, h: number, color: (i: number) => number, n = 16) {
    const segs = [];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2; const a1 = ((i + 1) / n) * Math.PI * 2; const am = (a0 + a1) / 2;
      segs.push({ i, a0, a1, nx: Math.cos(am), ny: Math.sin(am) });
    }
    segs.sort((s, t) => (s.nx + s.ny) - (t.nx + t.ny));
    for (const s of segs) {
      const f = 0.92 - 0.14 * s.nx - 0.04 * s.ny;
      this.poly([[cx + Math.cos(s.a0) * r, cy + Math.sin(s.a0) * r, z], [cx + Math.cos(s.a1) * r, cy + Math.sin(s.a1) * r, z], [cx, cy, z + h]], shade(color(s.i), f));
    }
    this.line(this.ring(cx, cy, r, n, z).filter(([x, y]) => (x - cx) + (y - cy) > -r * 0.2), shade(color(0), 0.5), 0.08, 0.6);
    this.shadowOf(this.ring(cx, cy, r, 12, 0).map(([x, y]) => [x, y] as Pt2), z + h * 0.5);
  }
}

// ---------------------------------------------------------------------------------------
// Builders. Each receives the place footprint (metres; [x, x+w) x [y, y+h)).

type Ctx = { d: Iso3D; r: Rect; id: string };
const inset = (r: Rect, m: number) => ({ x0: r.x + m, y0: r.y + m, x1: r.x + r.w - m, y1: r.y + r.h - m });

function house({ d, r, id }: Ctx, opts: { wall: number; roof: number; floors: number; roofKind?: 'gable' | 'hip' | 'flat' }) {
  const b = inset(r, 0.7);
  const h = opts.floors * 3.3;
  d.box(b.x0, b.y0, b.x1, b.y1, 0, h, opts.wall);
  // Plinth and cornice bands.
  d.poly([[b.x0, b.y1, 0], [b.x1, b.y1, 0], [b.x1, b.y1, 0.5], [b.x0, b.y1, 0.5]], shade(BUILD.stoneDark, SOUTH));
  d.poly([[b.x1, b.y1, 0], [b.x1, b.y0, 0], [b.x1, b.y0, 0.5], [b.x1, b.y1, 0.5]], shade(BUILD.stoneDark, EAST));
  d.windows(b.x0, b.y0, b.x1, b.y1, Array.from({ length: opts.floors }, (_, i) => 1.1 + i * 3.3), id);
  // Door on the south face.
  const dx = (b.x0 + b.x1) / 2;
  d.poly([[dx - 0.7, b.y1, 0], [dx + 0.7, b.y1, 0], [dx + 0.7, b.y1, 2.3], [dx - 0.7, b.y1, 2.3]], 0x2a2420);
  d.bulb([dx + 1.1, b.y1 + 0.1, 2.6], 0.14); d.spill(dx, b.y1 + 1.5, 4, 0.4);
  if (opts.roofKind === 'flat') {
    d.box(b.x0 - 0.2, b.y0 - 0.2, b.x1 + 0.2, b.y1 + 0.2, h, h + 0.4, shade(opts.roof, 1.1), shade(opts.roof, 0.95), { shadow: false });
  } else if (opts.roofKind === 'hip') d.hip(b.x0, b.y0, b.x1, b.y1, h, Math.min(5, (Math.min(b.x1 - b.x0, b.y1 - b.y0)) * 0.42), opts.roof);
  else d.gable(b.x0, b.y0, b.x1, b.y1, h, Math.min(5.5, Math.min(b.x1 - b.x0, b.y1 - b.y0) * 0.45), opts.roof, opts.wall);
  return h + 5;
}

function kiosk({ d, r, id }: Ctx) {
  const b = inset(r, 0.5);
  const h = 2.9;
  const accent = [BUILD.oxblood, BUILD.navy, BUILD.teal, BUILD.mustard][Math.floor(hashStr(id) * 4)]!;
  d.box(b.x0, b.y0, b.x1, b.y1, 0, h, BUILD.timber, shade(BUILD.slate, 1.1));
  // Serving hatch glow on the south face.
  const hatch: P3[] = [[b.x0 + 0.6, b.y1, 1.0], [b.x1 - 0.6, b.y1, 1.0], [b.x1 - 0.6, b.y1, 2.1], [b.x0 + 0.6, b.y1, 2.1]];
  d.poly(hatch, BUILD.glassWarm, 0.8);
  d.glowPoly(hatch, 0xffc070, 0.95);
  d.spill((b.x0 + b.x1) / 2, b.y1 + 2, Math.max(3.5, (b.x1 - b.x0) * 0.6), 0.55);
  // Striped awning sloping out over the south and east faces.
  const stripes = Math.max(3, Math.round((b.x1 - b.x0) / 0.8));
  for (let i = 0; i < stripes; i++) {
    const xa = b.x0 + ((b.x1 - b.x0) * i) / stripes; const xb = b.x0 + ((b.x1 - b.x0) * (i + 1)) / stripes;
    const c = i % 2 === 0 ? accent : BUILD.cream;
    d.poly([[xa, b.y1, h - 0.1], [xb, b.y1, h - 0.1], [xb, b.y1 + 1.1, h - 0.8], [xa, b.y1 + 1.1, h - 0.8]], shade(c, 0.95));
  }
  d.line([[b.x0, b.y1 + 1.1, h - 0.8], [b.x1, b.y1 + 1.1, h - 0.8]], shade(accent, 0.6), 0.08);
  for (let x = b.x0 + 0.4; x <= b.x1 - 0.3; x += 1.1) d.bulb([x, b.y1 + 1.12, h - 0.9], 0.09, 0xffd59a, 2.5);
  d.box(b.x0 - 0.15, b.y0 - 0.15, b.x1 + 0.15, b.y1 + 0.15, h, h + 0.35, BUILD.slate, shade(BUILD.slate, 1.15), { shadow: false });
  d.shadowOf([[b.x0, b.y1], [b.x1, b.y1], [b.x1, b.y1 + 1.1], [b.x0, b.y1 + 1.1]], h - 0.8);
  return h + 2;
}

function theatre({ d, r, id }: Ctx) {
  const b = inset(r, 0.8);
  const hallH = 10; const flyH = 16;
  const midY = b.y0 + (b.y1 - b.y0) * 0.42;
  // Fly tower at the back, hall in front.
  d.box(b.x0 + 2, b.y0, b.x1 - 2, midY, 0, flyH, BUILD.brick);
  d.windows(b.x0 + 2, b.y0, b.x1 - 2, midY, [12.5], `${id}f`, { lit: 0.2 });
  d.box(b.x0 + 1.8, b.y0 - 0.2, b.x1 - 1.8, midY + 0.2, flyH, flyH + 0.6, BUILD.stoneDark, undefined, { shadow: false });
  d.box(b.x0, midY, b.x1, b.y1, 0, hallH, BUILD.brick);
  d.windows(b.x0, midY, b.x1, b.y1, [2, 5.8], id, { h: 2.2, w: 1.1, spacing: 3, lit: 0.55 });
  d.hip(b.x0, midY, b.x1, b.y1, hallH, 3.2, BUILD.copper);
  // Marquee canopy with a warm light strip.
  const cx0 = b.x0 + (b.x1 - b.x0) * 0.25; const cx1 = b.x1 - (b.x1 - b.x0) * 0.25;
  d.box(cx0, b.y1, cx1, b.y1 + 2.2, 3.6, 4.2, BUILD.stoneDark, shade(BUILD.slate, 1.1));
  d.poly([[cx0, b.y1 + 2.2, 3.6], [cx1, b.y1 + 2.2, 3.6], [cx1, b.y1 + 2.2, 3.85], [cx0, b.y1 + 2.2, 3.85]], 0xf0c27a, 0.95);
  d.glowPoly([[cx0, b.y1 + 2.2, 3.5], [cx1, b.y1 + 2.2, 3.5], [cx1, b.y1 + 2.2, 3.95], [cx0, b.y1 + 2.2, 3.95]], 0xffd27e, 1);
  for (let x = cx0 + 0.4; x <= cx1; x += 0.9) d.bulb([x, b.y1 + 2.25, 4.2], 0.08, 0xffe2a8, 2.2);
  d.spill((cx0 + cx1) / 2, b.y1 + 4, (cx1 - cx0) * 0.75, 0.7);
  return flyH + 2;
}

function amphitheatre({ d, r }: Ctx) {
  const b = inset(r, 0.6);
  const stageY1 = b.y0 + (b.y1 - b.y0) * 0.3;
  // Stage house (shell) to the north.
  d.box(b.x0 + 3, b.y0, b.x1 - 3, stageY1, 0, 7.5, BUILD.whitewash);
  d.gable(b.x0 + 3, b.y0, b.x1 - 3, stageY1, 7.5, 2.4, BUILD.slate, BUILD.whitewash, 'x');
  d.box(b.x0 + 4, stageY1, b.x1 - 4, stageY1 + 3, 0, 1.2, BUILD.timber, shade(BUILD.timber, 1.25));
  d.poly([[b.x0 + 4.5, stageY1, 1.3], [b.x1 - 4.5, stageY1, 1.3], [b.x1 - 4.5, stageY1, 6.4], [b.x0 + 4.5, stageY1, 6.4]], 0x1e1a18);
  d.glowPoly([[b.x0 + 4.5, stageY1, 1.3], [b.x1 - 4.5, stageY1, 1.3], [b.x1 - 4.5, stageY1, 6.4], [b.x0 + 4.5, stageY1, 6.4]], 0x6a4a8a, 0.45);
  for (let x = b.x0 + 5; x <= b.x1 - 5; x += 2.2) d.bulb([x, stageY1 + 0.2, 6.8], 0.14, 0xfff0c8, 3);
  d.spill((b.x0 + b.x1) / 2, stageY1 + 3, (b.x1 - b.x0) * 0.4, 0.6);
  // Stepped seating rising to the south.
  const rows = 6; const rowD = (b.y1 - stageY1 - 4) / rows;
  for (let i = 0; i < rows; i++) {
    const y0 = stageY1 + 4 + i * rowD;
    d.box(b.x0 + 1, y0, b.x1 - 1, y0 + rowD, 0, 0.45 * (i + 1), BUILD.stone, shade(BUILD.stone, i % 2 ? 1.05 : 0.95), { edge: true, shadow: i === rows - 1 });
  }
  return 10;
}

function carousel({ d, r }: Ctx) {
  const cx = r.x + r.w / 2; const cy = r.y + r.h / 2; const R = Math.min(r.w, r.h) / 2 - 1.2;
  d.prism(cx, cy, R + 0.6, 0, 0.6, BUILD.stone, shade(BUILD.stone, 1.05), 28);
  d.prism(cx, cy, R * 0.85, 0.6, 0.75, BUILD.timber, shade(BUILD.timber, 1.3), 24, false);
  // Horses / columns ring.
  const n = 14;
  const cols = d.ring(cx, cy, R * 0.78, n, 0.75).sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  d.prism(cx, cy, 1.2, 0.75, 4.2, BUILD.cream, undefined, 12, false);
  for (const [x, y] of cols) {
    d.line([[x, y, 0.75], [x, y, 4.2]], 0xb59a5e, 0.12);
    d.poly([[x - 0.35, y, 1.4], [x + 0.35, y, 1.4], [x + 0.35, y, 2.0], [x - 0.35, y, 2.0]], 0xd8cfbe, 0.95);
  }
  d.prism(cx, cy, R + 0.25, 4.2, 4.8, BUILD.oxblood, undefined, 28, false);
  d.cone(cx, cy, R + 0.35, 4.8, 3.6, (i) => (i % 2 ? BUILD.cream : BUILD.oxblood), 20);
  for (const [x, y, z] of d.ring(cx, cy, R + 0.3, 36, 4.5)) if ((x - cx) + (y - cy) > -R * 0.35) d.bulb([x, y, z], 0.1, 0xffd79a, 2.4);
  for (const [x, y] of d.ring(cx, cy, R * 0.55, 10, 0)) if ((x - cx) + (y - cy) > 0) d.bulb([cx + (x - cx), cy + (y - cy), 4.8 + 3.6 * 0.45], 0.08, 0xffe0b0, 2);
  d.bulb([cx, cy, 9.7], 0.16, 0xffe6b0, 3);
  d.spill(cx, cy, R + 5, 0.55);
  d.line([[cx, cy, 8.4], [cx, cy, 9.6]], 0xb59a5e, 0.15);
  return 10;
}

function teacups({ d, r }: Ctx) {
  const cx = r.x + r.w / 2; const cy = r.y + r.h / 2; const R = Math.min(r.w, r.h) / 2 - 1;
  d.prism(cx, cy, R, 0, 0.5, BUILD.stone, shade(BUILD.teal, 0.85), 28);
  const cups = d.ring(cx, cy, R * 0.6, 5, 0.5).sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  const colors = [BUILD.oxblood, BUILD.cream, BUILD.mustard, BUILD.navy, BUILD.teal];
  d.prism(cx, cy, 1.4, 0.5, 2.8, BUILD.cream, undefined, 14, false);
  d.cone(cx, cy, 1.6, 2.8, 1.4, () => BUILD.copper, 12);
  cups.forEach(([x, y], i) => { d.prism(x, y, 1.3, 0.5, 1.5, colors[i % colors.length]!, 0x2a2420, 14, false); });
  return 6;
}

function scrambler({ d, r }: Ctx) {
  const cx = r.x + r.w / 2; const cy = r.y + r.h / 2; const R = Math.min(r.w, r.h) / 2 - 1;
  d.prism(cx, cy, R, 0, 0.45, BUILD.stoneDark, shade(BUILD.stone, 0.9), 28);
  const arms = d.ring(cx, cy, R * 0.72, 3, 1.2).sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  const back = arms.filter(([x, y]) => x + y < cx + cy); const front = arms.filter(([x, y]) => x + y >= cx + cy);
  const arm = ([x, y]: P3) => {
    d.line([[cx, cy, 4], [x, y, 2.4]], BUILD.steel, 0.3);
    for (const [sx, sy] of d.ring(x, y, 1.6, 4, 1.2)) d.prism(sx, sy, 0.5, 0.6, 1.4, BUILD.rust, 0x2a2420, 8, false);
  };
  back.forEach(arm);
  d.prism(cx, cy, 0.8, 0.45, 4.3, BUILD.steelDark, BUILD.steel, 10);
  front.forEach(arm);
  return 6;
}

function lighthouse({ d, r, id }: Ctx) {
  const b = inset(r, 0.8);
  // Keeper's house in the south-west, tower to the north-east.
  const hx1 = b.x0 + (b.x1 - b.x0) * 0.62;
  const tx = b.x0 + (b.x1 - b.x0) * 0.78; const ty = b.y0 + (b.y1 - b.y0) * 0.3;
  const tower = () => {
    const segs = 6; const H = 22;
    for (let i = 0; i < segs; i++) {
      const r0 = 2.6 - (i / segs) * 0.9;
      d.prism(tx, ty, r0, (H * i) / segs, (H * (i + 1)) / segs, i % 2 ? BUILD.oxblood : BUILD.whitewash, undefined, 18, i === segs - 1);
    }
    d.prism(tx, ty, 2.3, H, H + 0.4, BUILD.steelDark, BUILD.steelDark, 18, false);
    d.prism(tx, ty, 1.3, H + 0.4, H + 2.4, BUILD.glassWarm, undefined, 12, false);
    d.bulb([tx, ty, H + 1.4], 0.9, 0xfff1c8, 3.5);
    d.beacon = [tx, ty, H + 1.4];
    d.cone(tx, ty, 1.6, H + 2.4, 1.6, () => BUILD.steelDark, 12);
  };
  tower();
  d.box(b.x0, b.y0 + (b.y1 - b.y0) * 0.35, hx1, b.y1, 0, 6.6, BUILD.clapboard);
  d.windows(b.x0, b.y0 + (b.y1 - b.y0) * 0.35, hx1, b.y1, [1.2, 4.3], id, { lit: 0.25 });
  d.gable(b.x0, b.y0 + (b.y1 - b.y0) * 0.35, hx1, b.y1, 6.6, 4, BUILD.slate, BUILD.clapboard);
  return 26;
}

type TrackPt = P3;
function trackLoop(r: Rect, n: number, hMax: number, wiggle: number, seed: number): TrackPt[] {
  const b = inset(r, 2.2);
  const cx = (b.x0 + b.x1) / 2; const cy = (b.y0 + b.y1) / 2; const ax = (b.x1 - b.x0) / 2; const ay = (b.y1 - b.y0) / 2;
  const pts: TrackPt[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / n; const a = t * Math.PI * 2;
    // Squircle loop with an inward wiggle for switchbacks.
    const c = Math.cos(a); const s = Math.sin(a);
    const k = 1 - wiggle * (0.5 + 0.5 * Math.cos(a * 3 + seed));
    const x = cx + Math.sign(c) * Math.pow(Math.abs(c), 0.6) * ax * k;
    const y = cy + Math.sign(s) * Math.pow(Math.abs(s), 0.6) * ay * k;
    let z: number;
    if (t < 0.22) z = 2 + (hMax - 2) * (t / 0.22); // lift hill
    else if (t < 0.3) z = hMax - (hMax - 3) * ((t - 0.22) / 0.08); // first drop
    else z = 3 + (hMax * 0.45) * (0.5 + 0.5 * Math.sin((t - 0.3) * Math.PI * 6 + seed)) * (1 - (t - 0.3) * 0.8);
    pts.push([x, y, Math.max(1.2, z)]);
  }
  return pts;
}

function coaster({ d, r, id }: Ctx, opts: { color: number; hMax: number; wiggle: number }) {
  const pts = trackLoop(r, 140, opts.hMax, opts.wiggle, hashStr(id) * 6);
  // Station platform on the west side.
  const b = inset(r, 0.8);
  d.box(b.x0, b.y0 + (b.y1 - b.y0) * 0.55, b.x0 + 4.5, b.y0 + (b.y1 - b.y0) * 0.55 + 7, 0, 3.4, BUILD.clapboard);
  d.gable(b.x0, b.y0 + (b.y1 - b.y0) * 0.55, b.x0 + 4.5, b.y0 + (b.y1 - b.y0) * 0.55 + 7, 3.4, 1.8, BUILD.slate, BUILD.clapboard, 'y');
  type Item = { key: number; draw: () => void };
  const items: Item[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!; const c = pts[(i + 1) % n]!;
    const mx = (a[0] + c[0]) / 2; const my = (a[1] + c[1]) / 2;
    const dx = c[0] - a[0]; const dy = c[1] - a[1]; const l = Math.hypot(dx, dy) || 1;
    const nx = (-dy / l) * 0.55; const ny = (dx / l) * 0.55;
    items.push({ key: mx + my + 0.01, draw: () => {
      d.poly([[a[0] + nx, a[1] + ny, a[2]], [c[0] + nx, c[1] + ny, c[2]], [c[0] - nx, c[1] - ny, c[2]], [a[0] - nx, a[1] - ny, a[2]]], shade(opts.color, 0.8));
      d.line([[a[0] + nx, a[1] + ny, a[2] + 0.08], [c[0] + nx, c[1] + ny, c[2] + 0.08]], shade(opts.color, 1.25), 0.12);
      d.line([[a[0] - nx, a[1] - ny, a[2] + 0.08], [c[0] - nx, c[1] - ny, c[2] + 0.08]], shade(opts.color, 1.05), 0.12);
      d.poly([[a[0] - nx, a[1] - ny, a[2]], [c[0] - nx, c[1] - ny, c[2]], [c[0] - nx, c[1] - ny, c[2] - 0.35], [a[0] - nx, a[1] - ny, a[2] - 0.35]], shade(opts.color, 0.5));
    } });
    d.shadowLine(a, c, 1.1);
    if (i % 4 === 0 && a[2] > 1.5) {
      items.push({ key: a[0] + a[1], draw: () => {
        d.line([[a[0], a[1], 0], [a[0], a[1], a[2] - 0.3]], BUILD.steelDark, 0.22, 0.95);
        if (a[2] > 8) d.line([[a[0] - 0.8, a[1], 0], [a[0], a[1], a[2] * 0.6], [a[0] + 0.8, a[1], 0]], BUILD.steelDark, 0.12, 0.8);
      } });
      d.shadowLine([a[0], a[1], 0], [a[0], a[1], a[2]], 0.25);
    }
  }
  // A train on the lift hill.
  const ti = 18;
  items.push({ key: pts[ti]![0] + pts[ti]![1] + 0.02, draw: () => {
    for (let k = 0; k < 4; k++) {
      const p = pts[ti + k * 2]!;
      d.box(p[0] - 0.6, p[1] - 0.6, p[0] + 0.6, p[1] + 0.6, p[2] + 0.1, p[2] + 0.9, BUILD.cream, undefined, { shadow: false });
    }
  } });
  items.sort((p, q) => p.key - q.key).forEach((it) => it.draw());
  for (let i = 0; i < n; i += 4) { const a = pts[i]!; d.bulb([a[0], a[1], a[2] + 0.25], 0.09, i % 8 ? 0xfff0d0 : 0xff9a6a, 2.2); }
  d.bulb([b.x0 + 2.25, b.y0 + (b.y1 - b.y0) * 0.55 + 7.1, 2.8], 0.15);
  d.spill(b.x0 + 2.25, b.y0 + (b.y1 - b.y0) * 0.55 + 8.5, 4, 0.5);
  return opts.hMax + 2;
}

function wheel({ d, r }: Ctx) {
  const cx = r.x + r.w / 2; const cy = r.y + r.h / 2;
  const R = Math.min(r.w - 2, 16) / 2; const hub = R + 1.6;
  d.box(cx - R * 0.7, cy - 2.4, cx + R * 0.7, cy + 2.4, 0, 0.7, BUILD.stoneDark, shade(BUILD.stone, 0.95));
  const leg = (y: number) => {
    d.line([[cx - R * 0.55, y, 0.7], [cx, y, hub], [cx + R * 0.55, y, 0.7]], BUILD.steelDark, 0.4);
  };
  leg(cy - 1.6);
  const rim: P3[] = []; const N = 48;
  for (let i = 0; i <= N; i++) { const a = (i / N) * Math.PI * 2; rim.push([cx + Math.cos(a) * R, cy, hub + Math.sin(a) * R]); }
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; d.line([[cx, cy, hub], [cx + Math.cos(a) * R, cy, hub + Math.sin(a) * R]], BUILD.steel, 0.07, 0.8); }
  d.line(rim, BUILD.steel, 0.32);
  d.line(rim.map(([x, y, z]) => [cx + (x - cx) * 0.93, y, hub + (z - hub) * 0.93] as P3), BUILD.steel, 0.12, 0.8);
  d.shadowOf([[cx - R, cy - 0.4], [cx + R, cy - 0.4], [cx + R, cy + 0.4], [cx - R, cy + 0.4]], hub);
  const colors = [BUILD.cream, BUILD.teal, BUILD.oxblood, BUILD.mustard];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.13; const x = cx + Math.cos(a) * R; const z = hub + Math.sin(a) * R;
    d.line([[x, cy, z], [x, cy, z - 0.6]], BUILD.steelDark, 0.06);
    d.box(x - 0.6, cy - 0.7, x + 0.6, cy + 0.7, z - 1.8, z - 0.6, colors[i % 4]!, undefined, { shadow: false });
  }
  d.prism(cx, cy, 0.7, hub - 0.5, hub + 0.5, BUILD.steelDark, BUILD.steel, 10, false);
  for (let i = 0; i < N; i += 2) { const [x, y, z] = rim[i]!; d.bulb([x, y + 0.2, z], 0.11, i % 6 === 0 ? 0xff9fb0 : i % 6 === 2 ? 0x9fd8ff : 0xfff0c8, 2.4); }
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; d.bulb([cx + Math.cos(a) * R * 0.5, cy + 0.2, hub + Math.sin(a) * R * 0.5], 0.07, 0xfff0c8, 2); }
  d.bulb([cx, cy + 0.3, hub], 0.3, 0xffe0a8, 3);
  d.spill(cx, cy + 1, R, 0.5);
  leg(cy + 1.6);
  return hub + R + 2;
}

function dropTower({ d, r }: Ctx) {
  const cx = r.x + r.w / 2; const cy = r.y + r.h / 2; const H = 40;
  d.prism(cx, cy, 4, 0, 0.6, BUILD.stoneDark, shade(BUILD.stone, 0.9), 20);
  d.box(cx - 1.2, cy - 1.2, cx + 1.2, cy + 1.2, 0.6, H, BUILD.steelDark, BUILD.steel);
  for (let z = 2; z < H - 1; z += 2.5) {
    d.line([[cx - 1.2, cy + 1.2, z], [cx + 1.2, cy + 1.2, z + 2.5]], BUILD.steel, 0.06, 0.6);
    d.line([[cx + 1.2, cy + 1.2, z], [cx + 1.2, cy - 1.2, z + 2.5]], BUILD.steel, 0.06, 0.5);
  }
  d.prism(cx, cy, 2.6, 26, 27.4, BUILD.oxblood, shade(BUILD.oxblood, 1.2), 18, false);
  d.box(cx - 1.6, cy - 1.6, cx + 1.6, cy + 1.6, H, H + 1.4, BUILD.whitewash, BUILD.slate);
  d.line([[cx, cy, H + 1.4], [cx, cy, H + 3.4]], BUILD.steel, 0.1);
  for (let z = 3; z < H; z += 3) { d.bulb([cx + 1.25, cy + 1.25, z], 0.1, 0xfff0d0, 2.2); }
  for (const [x, y] of d.ring(cx, cy, 2.65, 14, 0)) if ((x - cx) + (y - cy) > -0.5) d.bulb([x, y, 26.7], 0.1, 0xffd090, 2.4);
  d.bulb([cx, cy, H + 3.5], 0.2, 0xff4a3a, 4);
  d.spill(cx, cy, 6, 0.45);
  return H + 4;
}

function swingShip({ d, r }: Ctx) {
  const b = inset(r, 1.2); const cy = (b.y0 + b.y1) / 2; const pz = 10;
  d.box(b.x0, cy - 3, b.x1, cy + 3, 0, 0.5, BUILD.stoneDark, shade(BUILD.stone, 0.9));
  const frame = (x: number) => d.line([[x, cy - 3, 0.5], [x, cy, pz], [x, cy + 3, 0.5]], BUILD.steelDark, 0.35);
  frame(b.x0 + 1.5);
  // Hull hanging at a swing angle.
  const tilt = 0.35; const L = (b.x1 - b.x0) * 0.42; const mx = (b.x0 + b.x1) / 2;
  const hz = pz - 6.5; const keel: P3[] = []; const deck: P3[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10 - 0.5; const x = mx + t * 2 * L * Math.cos(tilt); const lift = t * 2 * L * Math.sin(tilt);
    keel.push([x, cy + 1.3, hz + lift - 1.2 * (1 - 4 * t * t) + 0.2]);
    deck.push([x, cy + 1.3, hz + lift + 0.9 + Math.abs(t) * 1.6]);
  }
  d.line([[mx, cy, pz], [mx - 1.5, cy, hz + 0.8]], BUILD.steel, 0.2);
  d.line([[mx, cy, pz], [mx + 1.5, cy, hz + 0.8]], BUILD.steel, 0.2);
  d.poly([...deck.map(([x, , z]) => [x, cy - 1.3, z] as P3).reverse(), ...deck], shade(BUILD.timber, 1.3));
  d.poly([...keel, ...[...deck].reverse()], shade(BUILD.oxblood, 0.85));
  d.line(deck, BUILD.mustard, 0.12);
  d.shadowOf([[mx - L, cy - 1.3], [mx + L, cy - 1.3], [mx + L, cy + 1.3], [mx - L, cy + 1.3]], hz);
  d.line([[b.x0 + 1.5, cy, pz], [b.x1 - 1.5, cy, pz]], BUILD.steelDark, 0.4);
  frame(b.x1 - 1.5);
  return pz + 2;
}

function railway({ d, r }: Ctx) {
  const b = inset(r, 1.8);
  const pts: P3[] = [];
  const cx = (b.x0 + b.x1) / 2; const cy = (b.y0 + b.y1) / 2; const ax = (b.x1 - b.x0) / 2; const ay = (b.y1 - b.y0) / 2;
  for (let i = 0; i <= 80; i++) { const a = (i / 80) * Math.PI * 2; const c = Math.cos(a); const s = Math.sin(a); pts.push([cx + Math.sign(c) * Math.pow(Math.abs(c), 0.4) * ax, cy + Math.sign(s) * Math.pow(Math.abs(s), 0.4) * ay, 0.08]); }
  d.line(pts, 0x3b322b, 1.2, 0.9);
  d.line(pts, BUILD.steel, 0.12, 0.9);
  // Station hut on the east side and a short train.
  d.box(b.x1 - 3.4, cy - 3, b.x1 - 0.6, cy + 3, 0, 3.2, BUILD.clapboard);
  d.gable(b.x1 - 3.4, cy - 3, b.x1 - 0.6, cy + 3, 3.2, 1.6, BUILD.copper, BUILD.clapboard, 'y');
  const tx = b.x0 + 0.1;
  d.box(tx - 0.7, cy + 4, tx + 0.7, cy + 6.6, 0.1, 2.0, BUILD.navy, BUILD.steelDark);
  d.box(tx - 0.7, cy + 1.2, tx + 0.7, cy + 3.6, 0.1, 1.5, BUILD.oxblood, BUILD.cream);
  d.box(tx - 0.7, cy - 1.6, tx + 0.7, cy + 0.8, 0.1, 1.5, BUILD.oxblood, BUILD.cream);
  return 5;
}

function flume({ d, r }: Ctx) {
  const b = inset(r, 1);
  // Rock massif at the north end with a chute descending into the pool.
  const rocks: [number, number, number, number][] = [];
  for (let i = 0; i < 9; i++) {
    const t = i / 9;
    rocks.push([b.x0 + 3 + (b.x1 - b.x0 - 6) * hashStr(`fx${i}`), b.y0 + 2 + (b.y1 - b.y0) * 0.3 * hashStr(`fy${i}`), 2.2 + 2 * hashStr(`fr${i}`), 4 + 9 * (1 - t) * hashStr(`fz${i}`)]);
  }
  rocks.sort((p, q) => p[0] + p[1] - q[0] - q[1]);
  for (const [x, y, rr, h] of rocks) {
    d.prism(x, y, rr, 0, h, BUILD.rock, shade(BUILD.rock, 1.12), 7);
    d.cone(x, y, rr, h, rr * 0.6, () => shade(0x4f5e3c, 1.0), 7);
  }
  const x = (b.x0 + b.x1) / 2 + 2;
  const chute: P3[] = [[x, b.y0 + 4, 13], [x, b.y0 + (b.y1 - b.y0) * 0.55, 6], [x, b.y1 - 4, 0.6]];
  for (let i = 0; i < 2; i++) {
    const a = chute[i]!; const c = chute[i + 1]!;
    d.poly([[a[0] - 1.2, a[1], a[2]], [a[0] + 1.2, a[1], a[2]], [c[0] + 1.2, c[1], c[2]], [c[0] - 1.2, c[1], c[2]]], 0x5e8c92);
    d.poly([[a[0] + 1.2, a[1], a[2]], [c[0] + 1.2, c[1], c[2]], [c[0] + 1.2, c[1], c[2] - 0.6], [a[0] + 1.2, a[1], a[2] - 0.6]], shade(BUILD.timber, EAST));
    d.line([[c[0] + 1.2, c[1], 0], [c[0] + 1.2, c[1], c[2]]], BUILD.timber, 0.25);
    d.shadowLine(a, c, 2.4);
  }
  // Boarding station by the queue (east side).
  d.box(b.x1 - 5, b.y0 + (b.y1 - b.y0) * 0.45, b.x1, b.y0 + (b.y1 - b.y0) * 0.45 + 6, 0, 3.4, BUILD.timber);
  d.gable(b.x1 - 5, b.y0 + (b.y1 - b.y0) * 0.45, b.x1, b.y0 + (b.y1 - b.y0) * 0.45 + 6, 3.4, 1.8, BUILD.shingle, BUILD.timber, 'y');
  return 16;
}

function rapids({ d, r }: Ctx) {
  const b = inset(r, 1);
  for (let i = 0; i < 7; i++) {
    const x = b.x0 + 2 + (b.x1 - b.x0 - 4) * hashStr(`rx${i}`); const y = b.y0 + 2 + (b.y1 - b.y0 - 4) * (i / 7);
    d.prism(x, y, 1.4 + hashStr(`rr${i}`) * 1.4, 0, 1.2 + hashStr(`rz${i}`) * 2.2, BUILD.rock, shade(0x52603e, 1.0), 7);
  }
  for (let i = 0; i < 4; i++) {
    const x = b.x0 + 4 + (b.x1 - b.x0 - 8) * hashStr(`bx${i}`); const y = b.y0 + 5 + (b.y1 - b.y0 - 10) * hashStr(`by${i}`);
    d.prism(x, y, 1.4, 0, 0.7, 0x26282a, BUILD.mustard, 14);
  }
  d.box(b.x1 - 4.5, b.y0 + (b.y1 - b.y0) * 0.35, b.x1, b.y0 + (b.y1 - b.y0) * 0.35 + 6, 0, 3.2, BUILD.timber);
  d.gable(b.x1 - 4.5, b.y0 + (b.y1 - b.y0) * 0.35, b.x1, b.y0 + (b.y1 - b.y0) * 0.35 + 6, 3.2, 1.8, BUILD.shingle, BUILD.timber, 'y');
  return 7;
}

function boats({ d, r }: Ctx) {
  const b = inset(r, 1.2);
  const colors = [BUILD.oxblood, BUILD.mustard, BUILD.navy, BUILD.cream, BUILD.teal];
  for (let i = 0; i < 9; i++) {
    const x = b.x0 + 2 + (b.x1 - b.x0 - 4) * hashStr(`ox${i}`); const y = b.y0 + 2 + (b.y1 - b.y0 - 4) * hashStr(`oy${i}`);
    d.prism(x, y, 1.0, 0, 0.6, 0x26282a, colors[i % colors.length], 12);
  }
  d.box(b.x1 - 3.5, b.y1 - 4, b.x1, b.y1, 0, 2.8, BUILD.clapboard);
  d.gable(b.x1 - 3.5, b.y1 - 4, b.x1, b.y1, 2.8, 1.4, BUILD.slate, BUILD.clapboard);
  return 5;
}

function pack(body: Graphics, d: Iso3D) {
  const g = new Container();
  d.glow.blendMode = 'add';
  g.addChild(body, d.glow);
  return { g, body, glow: d.glow, shadows: d.shadows, spills: d.spills, beacon: d.beacon };
}

function awningRow({ d }: Ctx, x0: number, x1: number, y: number, z: number, depth: number, a: number, b: number) {
  const n = Math.max(3, Math.round((x1 - x0) / 0.7));
  for (let i = 0; i < n; i++) {
    const xa = x0 + ((x1 - x0) * i) / n; const xb = x0 + ((x1 - x0) * (i + 1)) / n;
    d.poly([[xa, y, z], [xb, y, z], [xb, y + depth, z - 0.55], [xa, y + depth, z - 0.55]], shade(i % 2 ? b : a, 0.95));
  }
  d.line([[x0, y + depth, z - 0.55], [x1, y + depth, z - 0.55]], shade(a, 0.55), 0.06);
  d.shadowOf([[x0, y], [x1, y], [x1, y + depth], [x0, y + depth]], z - 0.5);
}

/** Wheeled churro cart under a striped market umbrella, with a couple of stools. */
function churroCart({ d, r }: Ctx) {
  const cx = r.x + r.w / 2; const cy = r.y + r.h / 2;
  d.box(cx - 1.6, cy - 0.7, cx + 1.6, cy + 0.7, 0.55, 1.5, BUILD.oxblood, shade(BUILD.cream, 1.05));
  d.glowPoly([[cx - 1.3, cy + 0.7, 0.8], [cx + 1.3, cy + 0.7, 0.8], [cx + 1.3, cy + 0.7, 1.35], [cx - 1.3, cy + 0.7, 1.35]], 0xffc070, 0.9);
  for (const wx of [cx - 1.0, cx + 1.0]) d.prism(wx, cy + 0.75, 0.5, 0, 0.06, 0x1e1c1a, 0x1e1c1a, 10, false);
  d.line([[cx + 1.6, cy, 1.2], [cx + 2.4, cy, 0.9]], BUILD.steelDark, 0.08);
  d.line([[cx, cy, 1.5], [cx, cy, 3.1]], BUILD.steelDark, 0.08);
  d.cone(cx, cy, 2.3, 2.7, 0.7, (i) => (i % 2 ? BUILD.cream : BUILD.oxblood), 12);
  for (const [x, y, z] of d.ring(cx, cy, 2.25, 12, 2.68)) if ((x - cx) + (y - cy) > -1) d.bulb([x, y, z], 0.07, 0xffd59a, 2.2);
  for (const sx of [cx - 2.2, cx + 2.4]) d.prism(sx, cy + 1.3, 0.3, 0, 0.7, BUILD.timber, shade(BUILD.timber, 1.3), 8);
  d.spill(cx, cy + 1.5, 4, 0.6);
  return 4;
}

/** Pastel ice-cream kiosk with a scalloped awning and a giant cone sign on the roof. */
function iceCreamFloat({ d, r }: Ctx) {
  const b = inset(r, 0.5); const h = 2.8;
  const mint = 0x8fb3a4; const pink = 0xc99aa0;
  d.box(b.x0, b.y0, b.x1, b.y1, 0, h, mint, shade(BUILD.cream, 1.05));
  const hatch: P3[] = [[b.x0 + 0.5, b.y1, 1.0], [b.x1 - 0.5, b.y1, 1.0], [b.x1 - 0.5, b.y1, 2.0], [b.x0 + 0.5, b.y1, 2.0]];
  d.poly(hatch, BUILD.glassWarm, 0.8); d.glowPoly(hatch, 0xffd7a0, 0.95);
  awningRow({ d, r, id: '' }, b.x0, b.x1, b.y1, h - 0.05, 0.9, pink, BUILD.cream);
  // Giant cone + scoop sign.
  const cx = (b.x0 + b.x1) / 2; const cy = (b.y0 + b.y1) / 2;
  d.line([[cx, cy, h], [cx, cy, h + 0.8]], BUILD.steelDark, 0.08);
  d.prism(cx, cy, 0.7, h + 0.8, h + 1.0, BUILD.mustard, shade(BUILD.mustard, 1.2), 12, false);
  d.cone(cx, cy, 0.7, h + 1.0, -1.6, () => BUILD.mustard, 12);
  d.prism(cx, cy, 0.75, h + 1.0, h + 1.5, pink, shade(pink, 1.15), 12, false);
  d.cone(cx, cy, 0.75, h + 1.5, 0.6, () => shade(pink, 1.1), 12);
  d.bulb([cx, cy, h + 1.3], 0.35, 0xffb0c0, 3);
  d.spill(cx, b.y1 + 2, 4, 0.55);
  return h + 3;
}

/** Long snack bar: kiosk with a menu board on the roof and patio tables with parasols. */
function snackBar({ d, r, id }: Ctx) {
  const b = inset(r, 0.5);
  const split = b.x0 + (b.x1 - b.x0) * 0.58;
  const top = kiosk({ d, r: { x: b.x0 - 0.5, y: b.y0 - 0.5, w: split - b.x0 + 1, h: b.y1 - b.y0 + 1 }, id });
  const mx = (b.x0 + split) / 2;
  d.box(mx - 1.8, b.y0 + 1, mx + 1.8, b.y0 + 1.25, 3.3, 4.6, BUILD.navy, shade(BUILD.navy, 1.2), { shadow: true });
  d.glowPoly([[mx - 1.6, b.y0 + 1.25, 3.5], [mx + 1.6, b.y0 + 1.25, 3.5], [mx + 1.6, b.y0 + 1.25, 4.4], [mx - 1.6, b.y0 + 1.25, 4.4]], 0xffe2b0, 0.6);
  const ty = (b.y0 + b.y1) / 2;
  for (const tx of [split + 1.2, split + 3.2]) {
    if (tx > b.x1) continue;
    d.prism(tx, ty, 0.5, 0.65, 0.75, BUILD.cream, shade(BUILD.cream, 1.1), 10);
    d.line([[tx, ty, 0.75], [tx, ty, 2.3]], BUILD.steelDark, 0.05);
    d.cone(tx, ty, 1.0, 2.2, 0.35, (i) => (i % 2 ? BUILD.cream : BUILD.teal), 10);
    d.bulb([tx, ty, 2.1], 0.08, 0xffd59a, 2.4);
  }
  return top + 2;
}

/** Gift shop: brick two-storey with lit display windows and a little lighthouse sign tower. */
function giftShop(ctx: Ctx) {
  const { d, r } = ctx; const b = inset(r, 0.7);
  const top = house(ctx, { wall: BUILD.brick, roof: BUILD.slate, floors: 2 });
  awningRow(ctx, b.x0 + 0.5, b.x1 - 0.5, b.y1, 3.1, 0.9, BUILD.navy, BUILD.cream);
  const tx = b.x1 - 0.2; const ty = b.y1 - 0.2;
  for (let i = 0; i < 4; i++) d.prism(tx, ty, 0.75 - i * 0.08, 7 + i * 1.1, 8.1 + i * 1.1, i % 2 ? BUILD.oxblood : BUILD.whitewash, undefined, 12, i === 3);
  d.prism(tx, ty, 0.45, 11.4, 12.2, BUILD.glassWarm, undefined, 10, false);
  d.cone(tx, ty, 0.55, 12.2, 0.6, () => BUILD.steelDark, 10);
  d.bulb([tx, ty, 11.8], 0.4, 0xfff0c8, 3);
  return Math.max(top, 13);
}

/** Outfitters: clapboard store with a hip roof, dormer and striped awnings on both faces. */
function outfitters(ctx: Ctx) {
  const { d, r } = ctx; const b = inset(r, 0.7);
  const top = house(ctx, { wall: BUILD.clapboard, roof: BUILD.copper, floors: 2, roofKind: 'hip' });
  awningRow(ctx, b.x0 + 0.5, b.x1 - 0.5, b.y1, 3.0, 1.0, BUILD.mustard, BUILD.cream);
  // East-face awning (runs along y).
  const n = Math.max(3, Math.round((b.y1 - b.y0 - 1) / 0.7));
  for (let i = 0; i < n; i++) {
    const ya = b.y0 + 0.5 + ((b.y1 - b.y0 - 1) * i) / n; const yb = b.y0 + 0.5 + ((b.y1 - b.y0 - 1) * (i + 1)) / n;
    d.poly([[b.x1, ya, 3.0], [b.x1, yb, 3.0], [b.x1 + 1, yb, 2.45], [b.x1 + 1, ya, 2.45]], shade(i % 2 ? BUILD.cream : BUILD.mustard, 0.8));
  }
  // Ship's-wheel sign.
  const sx = (b.x0 + b.x1) / 2;
  const ring: P3[] = []; for (let i = 0; i <= 16; i++) { const a = (i / 16) * Math.PI * 2; ring.push([sx + Math.cos(a) * 0.9, b.y1 + 0.15, 7.6 + Math.sin(a) * 0.9]); }
  d.line(ring, BUILD.timber, 0.16);
  for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI; d.line([[sx - Math.cos(a) * 1.2, b.y1 + 0.15, 7.6 - Math.sin(a) * 1.2], [sx + Math.cos(a) * 1.2, b.y1 + 0.15, 7.6 + Math.sin(a) * 1.2]], BUILD.timber, 0.08); }
  return top;
}

/** Restroom pavilion; the east one is a stone block with a green flat roof. */
function restroom(ctx: Ctx, variant: number) {
  if (variant === 0) return house(ctx, { wall: BUILD.whitewash, roof: BUILD.slate, floors: 1, roofKind: 'hip' });
  const { d, r } = ctx; const b = inset(r, 0.7);
  const h = 3.4;
  d.box(b.x0, b.y0, b.x1, b.y1, 0, h, BUILD.stone);
  d.windows(b.x0, b.y0, b.x1, b.y1, [2.2], ctx.id, { h: 0.6, w: 1.6, spacing: 3, lit: 0.6 });
  d.box(b.x0 - 0.3, b.y0 - 0.3, b.x1 + 0.3, b.y1 + 0.3, h, h + 0.45, BUILD.copper, shade(BUILD.copper, 1.15), { shadow: false });
  for (const [x, y] of [[b.x0 + 1.5, b.y1], [b.x1 - 1.5, b.y1]] as const) d.poly([[x - 0.6, y, 0], [x + 0.6, y, 0], [x + 0.6, y, 2.2], [x - 0.6, y, 2.2]], 0x2a2420);
  d.bulb([(b.x0 + b.x1) / 2, b.y1 + 0.1, 2.8], 0.15); d.spill((b.x0 + b.x1) / 2, b.y1 + 1.5, 4, 0.45);
  return h + 2;
}

export type StructurePlace = { id: string; kind: string; footprint: Rect; decor: string };

export function buildStructure(proj: IsoProjection, p: StructurePlace): Structure {
  const g = new Graphics();
  const d = new Iso3D(g, proj);
  const ctx: Ctx = { d, r: p.footprint, id: p.id };
  let top: number;
  switch (p.id) {
    case 'coaster_tempest': top = coaster(ctx, { color: BUILD.oxblood, hMax: 24, wiggle: 0.25 }); break;
    case 'wild_mouse': top = coaster(ctx, { color: BUILD.teal, hMax: 13, wiggle: 0.45 }); break;
    case 'harbor_eye': top = wheel(ctx); break;
    case 'mariner_drop': top = dropTower(ctx); break;
    case 'pirate_swing': top = swingShip(ctx); break;
    case 'lighthouse_railway': top = railway(ctx); break;
    case 'splash_falls': top = flume(ctx); break;
    case 'river_rapids': top = rapids(ctx); break;
    case 'bumper_boats': top = boats(ctx); break;
    case 'harbor_carousel': top = carousel(ctx); break;
    case 'tidepool_teacups': top = teacups(ctx); break;
    case 'seafarer_scrambler': top = scrambler(ctx); break;
    case 'ghost_lighthouse': top = lighthouse(ctx); break;
    case 'lantern_theatre': top = theatre(ctx); break;
    case 'pier_stage': top = amphitheatre(ctx); break;
    case 'churro_cart': top = churroCart(ctx); break;
    case 'ice_cream_float': top = iceCreamFloat(ctx); break;
    case 'harbor_snacks': top = snackBar(ctx); break;
    case 'lighthouse_gifts': top = giftShop(ctx); break;
    case 'harbor_outfitters': top = outfitters(ctx); break;
    case 'restrooms_gate': top = restroom(ctx, 0); break;
    case 'restrooms_east': top = restroom(ctx, 1); break;
    case 'fish_shack': top = house(ctx, { wall: BUILD.clapboard, roof: BUILD.shingle, floors: 1 }); kiosk({ d, r: { x: p.footprint.x + 1, y: p.footprint.y + p.footprint.h - 4, w: p.footprint.w - 2, h: 3.4 }, id: p.id }); break;
    default:
      if (p.decor === 'stall') top = kiosk(ctx);
      else if (p.decor === 'track') top = coaster(ctx, { color: BUILD.rust, hMax: 12, wiggle: 0.3 });
      else if (p.decor === 'water') top = boats(ctx);
      else if (p.kind === 'restroom') top = house(ctx, { wall: BUILD.whitewash, roof: BUILD.slate, floors: 1, roofKind: 'hip' });
      else if (p.kind === 'shop') top = house(ctx, { wall: hashStr(p.id) < 0.5 ? BUILD.brick : BUILD.clapboard, roof: BUILD.slate, floors: 2 });
      else if (p.kind === 'show') top = theatre(ctx);
      else top = house(ctx, { wall: BUILD.whitewash, roof: BUILD.terracotta, floors: 2, roofKind: 'hip' });
  }
  const f = p.footprint;
  return { id: p.id, placeId: p.id, ...pack(g, d), depth: f.x + f.w / 2 + f.y + f.h / 2, foot: { x0: f.x, y0: f.y, x1: f.x + f.w, y1: f.y + f.h }, topM: top };
}

/** The main gate: stone piers and a lit lintel straddling the gate plaza's outer edge. */
export function buildGate(proj: IsoProjection, x0: number, x1: number, y: number): Structure {
  const g = new Graphics(); const d = new Iso3D(g, proj);
  const pier = (x: number) => {
    d.box(x - 0.9, y - 0.9, x + 0.9, y + 0.9, 0, 6.5, BUILD.stone, shade(BUILD.stone, 1.1));
    d.box(x - 1.15, y - 1.15, x + 1.15, y + 1.15, 6.5, 7.1, BUILD.stoneDark, shade(BUILD.slate, 1.1), { shadow: false });
    d.prism(x, y, 0.35, 7.1, 7.9, BUILD.glassWarm, 0xf3d79a, 8, false);
    d.bulb([x, y, 7.5], 0.45, 0xffd690, 3.5);
    d.spill(x, y + 2, 6, 0.6);
  };
  pier(x0);
  d.box(x0, y - 0.4, x1, y + 0.4, 5.2, 6.4, BUILD.navy, shade(BUILD.navy, 1.2), { shadow: true });
  d.poly([[x0 + 2, y + 0.4, 5.45], [x1 - 2, y + 0.4, 5.45], [x1 - 2, y + 0.4, 6.15], [x0 + 2, y + 0.4, 6.15]], 0xcdb37a, 0.9);
  d.glowPoly([[x0 + 2, y + 0.4, 5.45], [x1 - 2, y + 0.4, 5.45], [x1 - 2, y + 0.4, 6.15], [x0 + 2, y + 0.4, 6.15]], 0xffd890, 0.8);
  for (let x = x0 + 1.5; x <= x1 - 1.5; x += 1.2) d.bulb([x, y + 0.45, 5.15], 0.09, 0xfff0d0, 2.2);
  d.spill((x0 + x1) / 2, y - 3, (x1 - x0) * 0.5, 0.5);
  pier(x1);
  return { id: 'gate', placeId: null, ...pack(g, d), depth: (x0 + x1) / 2 + y + 0.5, foot: { x0: x0 - 1, y0: y - 1, x1: x1 + 1, y1: y + 1 }, topM: 8 };
}
