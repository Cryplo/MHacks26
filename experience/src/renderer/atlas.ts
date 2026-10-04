/**
 * One procedurally painted sprite atlas (Canvas 2D) for everything that is instanced:
 * guest figures (untinted person + tinted clothing layer, 4 poses), ground decals that
 * carry the state SHAPE encoding, and trees/shrubs. A single texture source keeps every
 * guest and tree in one batch.
 */
import { CanvasSource, Rectangle, Texture } from 'pixi.js';
import type { Shape } from './colors';
import { Z_SCALE } from './iso';
import { css, type RGB } from './palette';

/** Atlas pixels per plane unit. */
export const ATLAS_RES = 32;
const M = Z_SCALE * ATLAS_RES; // atlas px per vertical metre

export type Pose = 'stand' | 'walkA' | 'walkB' | 'sit';
export const POSES: Pose[] = ['stand', 'walkA', 'walkB', 'sit'];
export const PERSON_VARIANTS = 8;
export const TREE_KINDS = ['oak', 'oakDark', 'elm', 'pine', 'pineTall', 'shrub', 'shrubLow'] as const;
export type TreeKind = (typeof TREE_KINDS)[number];

export type Frame = { tex: Texture; ax: number; ay: number };
export type Atlas = {
  person: Frame[][]; // [variant][pose]
  cloth: Frame[]; // [pose], white, tinted per guest
  decal: Record<Shape, Frame>;
  tree: Record<TreeKind, Frame>;
  /** Cast-iron lamp post (feet anchor) and a soft white radial glow (centre anchor). */
  lamp: Frame; glow: Frame;
  /** Lamp head height above the feet in plane units. */
  lampHeadH: number;
  /** Figure height in plane units (feet to crown). */
  figureH: number;
  source: CanvasSource;
};

type Cell = { x: number; y: number; w: number; h: number; ax: number; ay: number };

const SKIN: RGB[] = [[224, 186, 156], [198, 152, 118], [160, 112, 80], [116, 78, 56], [232, 198, 170], [178, 128, 96], [140, 96, 70], [210, 170, 136]];
const HAIR: RGB[] = [[42, 32, 26], [92, 64, 40], [24, 22, 22], [150, 120, 80], [70, 50, 36], [180, 172, 160], [30, 26, 24], [120, 82, 50]];
const LEGS: RGB[] = [[46, 52, 64], [70, 64, 56], [38, 40, 44], [92, 86, 74], [52, 60, 72], [84, 74, 64], [60, 56, 52], [40, 46, 58]];

function figureGeometry(pose: Pose) {
  // Feet at (0,0), x to the right (facing), y up negative. Units: atlas px.
  const hip = pose === 'sit' ? 0.48 * M : 0.84 * M;
  const shoulder = hip + 0.56 * M;
  return { hip, shoulder, headC: shoulder + 0.19 * M, headR: 0.13 * M, w: 0.5 * M };
}
const swingOf = (pose: Pose) => (pose === 'walkA' ? 0.13 * M : pose === 'walkB' ? -0.13 * M : 0);

/** Torso + sleeves outline, shared by the dark rim (person layer) and the cloth layer. */
function torsoPath(ctx: CanvasRenderingContext2D, fx: number, fy: number, pose: Pose, e: number) {
  const g = figureGeometry(pose); const w = g.w;
  const top = fy - g.shoulder - e; const bottom = fy - g.hip + 0.07 * M + e;
  ctx.beginPath();
  ctx.moveTo(fx - w * 0.5 - e, top + 0.1 * M);
  ctx.quadraticCurveTo(fx - w * 0.5 - e, top, fx - w * 0.22, top);
  ctx.lineTo(fx + w * 0.22, top);
  ctx.quadraticCurveTo(fx + w * 0.5 + e, top, fx + w * 0.5 + e, top + 0.1 * M);
  ctx.lineTo(fx + w * 0.36 + e, bottom);
  ctx.lineTo(fx - w * 0.38 - e, bottom);
  ctx.closePath();
}
function armLines(ctx: CanvasRenderingContext2D, fx: number, fy: number, pose: Pose) {
  const g = figureGeometry(pose); const sw = swingOf(pose);
  return [
    [fx - g.w * 0.42, fy - g.shoulder + 0.08 * M, fx - g.w * 0.46 - sw * 0.6, fy - g.hip + 0.04 * M],
    [fx + g.w * 0.42, fy - g.shoulder + 0.08 * M, fx + g.w * 0.44 + sw * 0.6, fy - g.hip + 0.06 * M],
  ] as const;
}

function drawPerson(ctx: CanvasRenderingContext2D, fx: number, fy: number, pose: Pose, v: number) {
  const g = figureGeometry(pose);
  const skin = SKIN[v % SKIN.length]!; const hair = HAIR[(v * 3) % HAIR.length]!; const legs = LEGS[(v * 5) % LEGS.length]!;
  const legW = 0.15 * M;
  const rim = 'rgba(12,12,14,0.85)';
  ctx.lineCap = 'round';
  // Dark rim behind the clothing so figures separate from any ground.
  ctx.fillStyle = rim; torsoPath(ctx, fx, fy, pose, 1.3); ctx.fill();
  ctx.strokeStyle = rim; ctx.lineWidth = 0.13 * M + 2.6;
  for (const [ax, ay, bx, by] of armLines(ctx, fx, fy, pose)) { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); }
  const leg = (hx: number, footX: number, footY: number, col: RGB) => {
    ctx.strokeStyle = rim; ctx.lineWidth = legW + 2.4;
    ctx.beginPath(); ctx.moveTo(fx + hx, fy - g.hip); ctx.lineTo(fx + footX, fy - footY); ctx.stroke();
    ctx.strokeStyle = css(col); ctx.lineWidth = legW;
    ctx.beginPath(); ctx.moveTo(fx + hx, fy - g.hip); ctx.lineTo(fx + footX, fy - footY); ctx.stroke();
    ctx.fillStyle = css([26, 24, 24]);
    ctx.beginPath(); ctx.ellipse(fx + footX + legW * 0.3, fy - footY, legW * 0.72, legW * 0.42, 0, 0, Math.PI * 2); ctx.fill();
  };
  const dark: RGB = [legs[0] * 0.7, legs[1] * 0.7, legs[2] * 0.74];
  const sp = 0.07 * M;
  if (pose === 'stand') { leg(-sp, -sp * 1.1, 2, dark); leg(sp, sp, 2, legs); }
  if (pose === 'walkA') { leg(-sp * 0.5, -0.2 * M, 2.5, dark); leg(sp * 0.5, 0.2 * M, 2, legs); }
  if (pose === 'walkB') { leg(-sp * 0.5, 0.17 * M, 2, dark); leg(sp * 0.5, -0.19 * M, 3, legs); }
  if (pose === 'sit') {
    for (const [col, w] of [[rim, legW + 2.4], [css(legs), legW]] as const) {
      ctx.strokeStyle = col; ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(fx - 1, fy - g.hip); ctx.lineTo(fx + 0.3 * M, fy - g.hip + 1); ctx.lineTo(fx + 0.32 * M, fy - 2); ctx.stroke();
    }
  }
  // Hands (skin) at arm ends; arms themselves are on the clothing layer.
  ctx.fillStyle = css([skin[0] * 0.9, skin[1] * 0.88, skin[2] * 0.86]);
  for (const [, , bx, by] of armLines(ctx, fx, fy, pose)) { ctx.beginPath(); ctx.arc(bx, by + 0.03 * M, 0.055 * M, 0, Math.PI * 2); ctx.fill(); }
  // Neck + head with soft light from the upper left, dark rim.
  ctx.fillStyle = css([skin[0] * 0.78, skin[1] * 0.75, skin[2] * 0.72]);
  ctx.fillRect(fx - 0.045 * M, fy - g.headC + g.headR * 0.5, 0.09 * M, 0.09 * M);
  ctx.fillStyle = rim; ctx.beginPath(); ctx.arc(fx, fy - g.headC, g.headR + 1.2, 0, Math.PI * 2); ctx.fill();
  const hg = ctx.createRadialGradient(fx - g.headR * 0.35, fy - g.headC - g.headR * 0.3, g.headR * 0.2, fx, fy - g.headC, g.headR * 1.1);
  hg.addColorStop(0, css([Math.min(255, skin[0] * 1.08), Math.min(255, skin[1] * 1.06), Math.min(255, skin[2] * 1.04)]));
  hg.addColorStop(1, css([skin[0] * 0.7, skin[1] * 0.66, skin[2] * 0.64]));
  ctx.fillStyle = hg;
  ctx.beginPath(); ctx.arc(fx, fy - g.headC, g.headR, 0, Math.PI * 2); ctx.fill();
  // Hair: cap over the top and back of the head (figure faces right).
  ctx.fillStyle = css(hair);
  ctx.beginPath();
  ctx.ellipse(fx - g.headR * 0.2, fy - g.headC - g.headR * 0.3, g.headR * 1.02, g.headR * 0.8, 0, Math.PI * 0.85, Math.PI * 2.1);
  ctx.fill();
  if (v % 3 === 1) { ctx.beginPath(); ctx.ellipse(fx - g.headR * 0.7, fy - g.headC + g.headR * 0.3, g.headR * 0.5, g.headR * 0.95, 0, 0, Math.PI * 2); ctx.fill(); }
}

function drawCloth(ctx: CanvasRenderingContext2D, fx: number, fy: number, pose: Pose) {
  const g = figureGeometry(pose);
  const grad = ctx.createLinearGradient(fx - g.w / 2, fy - g.shoulder, fx + g.w / 2, fy - g.hip);
  grad.addColorStop(0, 'rgb(255,255,255)'); grad.addColorStop(0.5, 'rgb(222,222,222)'); grad.addColorStop(1, 'rgb(140,140,148)');
  ctx.fillStyle = grad;
  torsoPath(ctx, fx, fy, pose, 0); ctx.fill();
  // Hem / belt shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(fx - g.w * 0.38, fy - g.hip + 0.01 * M, g.w * 0.74, 0.06 * M);
  // Sleeves, swinging opposite to the legs when walking (far arm darker).
  ctx.lineCap = 'round'; ctx.lineWidth = 0.13 * M;
  const [far, near] = armLines(ctx, fx, fy, pose);
  ctx.strokeStyle = 'rgb(150,150,158)'; ctx.beginPath(); ctx.moveTo(far[0], far[1]); ctx.lineTo(far[2], far[3]); ctx.stroke();
  ctx.strokeStyle = 'rgb(205,205,210)'; ctx.beginPath(); ctx.moveTo(near[0], near[1]); ctx.lineTo(near[2], near[3]); ctx.stroke();
}

function drawDecal(ctx: CanvasRenderingContext2D, cx: number, cy: number, shape: Shape) {
  // Soft contact shadow (stays dark under tint), offset away from the light.
  const rx = 0.62 * ATLAS_RES;
  const sg = ctx.createRadialGradient(cx + 2, cy + 1, 1, cx + 2, cy + 1, rx);
  sg.addColorStop(0, 'rgba(0,0,0,0.55)'); sg.addColorStop(0.6, 'rgba(0,0,0,0.25)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sg;
  ctx.save(); ctx.translate(cx + 2, cy + 1); ctx.scale(1, 0.5); ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.restore(); ctx.fill();
  // Shape ring on the ground (squashed vertically, never rotated, so shapes stay legible).
  const r = 0.6 * ATLAS_RES;
  ctx.save(); ctx.translate(cx, cy); ctx.scale(1, 0.5);
  ctx.beginPath();
  if (shape === 'circle' || shape === 'ring' || shape === 'hollow') ctx.arc(0, 0, r, 0, Math.PI * 2);
  if (shape === 'square') ctx.rect(-r * 0.86, -r * 0.86, r * 1.72, r * 1.72);
  if (shape === 'triangle') { ctx.moveTo(0, -r * 1.05); ctx.lineTo(r, r * 0.8); ctx.lineTo(-r, r * 0.8); ctx.closePath(); }
  if (shape === 'diamond') { ctx.moveTo(0, -r * 1.1); ctx.lineTo(r * 1.1, 0); ctx.lineTo(0, r * 1.1); ctx.lineTo(-r * 1.1, 0); ctx.closePath(); }
  ctx.restore();
  ctx.lineWidth = shape === 'ring' ? 2.8 : 1.9;
  if (shape === 'hollow') ctx.setLineDash([3, 3]);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.stroke();
  ctx.setLineDash([]);
}

function blob(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, base: RGB, rnd: () => number) {
  const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.45, r * 0.1, x, y, r * 1.05);
  g.addColorStop(0, css([base[0] * 1.55, base[1] * 1.45, base[2] * 1.3]));
  g.addColorStop(0.55, css(base));
  g.addColorStop(1, css([base[0] * 0.5, base[1] * 0.55, base[2] * 0.62]));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  // Leaf speckle.
  for (let i = 0; i < r * 1.6; i++) {
    const a = rnd() * Math.PI * 2; const d = Math.sqrt(rnd()) * r * 0.9;
    const px = x + Math.cos(a) * d; const py = y + Math.sin(a) * d;
    const lit = (px - x) + (py - y) < 0;
    ctx.fillStyle = lit ? 'rgba(190,200,140,0.16)' : 'rgba(10,20,10,0.2)';
    ctx.beginPath(); ctx.arc(px, py, 1 + rnd() * 1.6, 0, Math.PI * 2); ctx.fill();
  }
}

function drawTree(ctx: CanvasRenderingContext2D, bx: number, by: number, kind: TreeKind, seed: number) {
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const U = ATLAS_RES;
  if (kind === 'pine' || kind === 'pineTall') {
    const h = (kind === 'pineTall' ? 9.5 : 7) * M;
    const w = (kind === 'pineTall' ? 1.9 : 2.0) * U;
    ctx.fillStyle = css([58, 42, 32]); ctx.fillRect(bx - 0.12 * U, by - 1.2 * M, 0.24 * U, 1.2 * M);
    const tiers = 5;
    for (let i = 0; i < tiers; i++) {
      const t0 = 0.12 + (i / tiers) * 0.8; const yb = by - h * t0; const yt = by - h * Math.min(1, t0 + 0.34);
      const ww = w * (1 - i / (tiers + 0.6));
      const g = ctx.createLinearGradient(bx - ww, 0, bx + ww, 0);
      g.addColorStop(0, css([66, 92, 64])); g.addColorStop(0.45, css([38, 60, 44])); g.addColorStop(1, css([20, 34, 28]));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(bx - ww, yb); ctx.quadraticCurveTo(bx, yb + 0.25 * U, bx + ww, yb); ctx.lineTo(bx, yt); ctx.closePath(); ctx.fill();
    }
    return;
  }
  if (kind === 'shrub' || kind === 'shrubLow') {
    const r = (kind === 'shrub' ? 0.75 : 0.55) * U;
    const base: RGB = kind === 'shrub' ? [56, 76, 44] : [70, 84, 48];
    const pts = [[-0.7, 0.55], [0.6, 0.6], [0, 0.9], [-0.2, 0.3]];
    for (const [dx, dz] of pts) blob(ctx, bx + dx! * r, by - dz! * r * 1.3, r * (0.75 + rnd() * 0.3), base, rnd);
    return;
  }
  const base: RGB = kind === 'oak' ? [60, 80, 44] : kind === 'oakDark' ? [44, 62, 38] : [72, 86, 46];
  const trunkH = 2.2 * M;
  ctx.strokeStyle = css([60, 46, 36]); ctx.lineCap = 'round'; ctx.lineWidth = 0.32 * U;
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + 0.05 * U, by - trunkH); ctx.stroke();
  ctx.lineWidth = 0.14 * U;
  ctx.beginPath(); ctx.moveTo(bx, by - trunkH * 0.7); ctx.lineTo(bx - 0.6 * U, by - trunkH * 1.15); ctx.moveTo(bx, by - trunkH * 0.8); ctx.lineTo(bx + 0.7 * U, by - trunkH * 1.2); ctx.stroke();
  const R = (kind === 'elm' ? 2.1 : 2.4) * U;
  const cy = by - trunkH - R * 0.75;
  const clumps: [number, number, number][] = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd() * 0.5;
    const d = (0.35 + rnd() * 0.4) * R;
    clumps.push([bx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.7, R * (0.42 + rnd() * 0.2)]);
  }
  clumps.sort((p, q) => p[1] - q[1]); // back (higher on screen) first
  clumps.push([bx - R * 0.05, cy - R * 0.3, R * 0.55]); // crown
  for (const [x, y, r] of clumps) blob(ctx, x, y, r, base, rnd);
}

export function buildAtlas(doc: Document = document): Atlas {
  const canvas = doc.createElement('canvas');
  canvas.width = 2048; canvas.height = 720;
  const ctx = canvas.getContext('2d')!;
  const cells: Record<string, Cell> = {};
  let cx = 4; let cy = 4; let rowH = 0;
  const alloc = (key: string, w: number, h: number, ax: number, ay: number) => {
    if (cx + w + 4 > canvas.width) { cx = 4; cy += rowH + 6; rowH = 0; }
    cells[key] = { x: cx, y: cy, w, h, ax, ay };
    cx += w + 6; rowH = Math.max(rowH, h);
    return cells[key];
  };
  // Trees.
  TREE_KINDS.forEach((k, i) => {
    const w = 6 * ATLAS_RES; const h = 12.2 * M;
    const c = alloc(`tree:${k}`, w, h, w / 2, h - 0.6 * ATLAS_RES);
    drawTree(ctx, c.x + c.ax, c.y + c.ay, k, i + 3);
  });
  cx = 4; cy += rowH + 6; rowH = 0;
  const fw = Math.ceil(1.0 * ATLAS_RES); const fh = Math.ceil(1.95 * M);
  for (let v = 0; v < PERSON_VARIANTS; v++) for (const p of POSES) {
    const c = alloc(`person:${v}:${p}`, fw, fh, fw / 2, fh - 3);
    drawPerson(ctx, c.x + c.ax, c.y + c.ay, p, v);
  }
  for (const p of POSES) {
    const c = alloc(`cloth:${p}`, fw, fh, fw / 2, fh - 3);
    drawCloth(ctx, c.x + c.ax, c.y + c.ay, p);
  }
  for (const s of ['circle', 'square', 'triangle', 'diamond', 'ring', 'hollow'] as Shape[]) {
    const w = Math.ceil(1.9 * ATLAS_RES); const h = Math.ceil(1.1 * ATLAS_RES);
    const c = alloc(`decal:${s}`, w, h, w / 2, h / 2);
    drawDecal(ctx, c.x + c.ax, c.y + c.ay, s);
  }
  {
    const w = Math.ceil(0.9 * ATLAS_RES); const h = Math.ceil(4.2 * M);
    const c = alloc('lamp', w, h, w / 2, h - 3);
    const fx = c.x + c.ax; const fy = c.y + c.ay;
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(fx + 2, fy, 0.25 * ATLAS_RES, 0.12 * ATLAS_RES, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#23262a'; ctx.fillRect(fx - 0.11 * ATLAS_RES, fy - 0.35 * M, 0.22 * ATLAS_RES, 0.35 * M);
    ctx.fillStyle = '#2d3135'; ctx.fillRect(fx - 0.05 * ATLAS_RES, fy - 3.5 * M, 0.1 * ATLAS_RES, 3.2 * M);
    ctx.fillStyle = '#4a5056'; ctx.fillRect(fx - 0.05 * ATLAS_RES, fy - 3.5 * M, 0.035 * ATLAS_RES, 3.2 * M);
    // Lantern head: dark cap, warm-glass body (lit at night by the glow layer).
    ctx.fillStyle = '#1f2226'; ctx.beginPath(); ctx.moveTo(fx - 0.22 * ATLAS_RES, fy - 3.95 * M); ctx.lineTo(fx + 0.22 * ATLAS_RES, fy - 3.95 * M); ctx.lineTo(fx, fy - 4.15 * M); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#8f8064'; ctx.fillRect(fx - 0.15 * ATLAS_RES, fy - 3.95 * M, 0.3 * ATLAS_RES, 0.42 * M);
    ctx.fillStyle = '#1f2226'; ctx.fillRect(fx - 0.18 * ATLAS_RES, fy - 3.56 * M, 0.36 * ATLAS_RES, 0.07 * M);
  }
  {
    const w = 64; const c = alloc('glow', w, w, w / 2, w / 2);
    const g = ctx.createRadialGradient(c.x + w / 2, c.y + w / 2, 0, c.x + w / 2, c.y + w / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.18, 'rgba(255,255,255,0.65)'); g.addColorStop(0.5, 'rgba(255,255,255,0.16)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(c.x, c.y, w, w);
  }
  const source = new CanvasSource({ resource: canvas, autoGenerateMipmaps: true, scaleMode: 'linear' });
  const frame = (key: string): Frame => {
    const c = cells[key]!;
    return { tex: new Texture({ source, frame: new Rectangle(c.x, c.y, c.w, c.h) }), ax: c.ax / c.w, ay: c.ay / c.h };
  };
  const person: Frame[][] = [];
  for (let v = 0; v < PERSON_VARIANTS; v++) person.push(POSES.map((p) => frame(`person:${v}:${p}`)));
  return {
    person,
    cloth: POSES.map((p) => frame(`cloth:${p}`)),
    decal: Object.fromEntries((['circle', 'square', 'triangle', 'diamond', 'ring', 'hollow'] as Shape[]).map((s) => [s, frame(`decal:${s}`)])) as Record<Shape, Frame>,
    tree: Object.fromEntries(TREE_KINDS.map((k) => [k, frame(`tree:${k}`)])) as Record<TreeKind, Frame>,
    lamp: frame('lamp'), glow: frame('glow'), lampHeadH: 3.75 * Z_SCALE,
    figureH: 1.74 * Z_SCALE,
    source,
  };
}
