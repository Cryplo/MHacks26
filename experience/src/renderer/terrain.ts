/**
 * Bakes the ground (top-down, `pxPerM` texels per metre) from the AUTHORITATIVE grid:
 * every walkable cell is paving of its own category (path / plaza / queue), every blocked
 * cell is grass, water, a planting bed or a structure pad. Materials are tiled procedural
 * textures masked per cell, so artwork can never paint a walkway onto a blocked cell or
 * vice versa. Cast shadows from structures and trees are baked on top. The scene maps this
 * image onto the iso ground plane with a single affine transform.
 */
import type { TreeKind } from './atlas';
import { MAT, css, hash2, vnoise, type RGB } from './palette';
import { SHADOW_DIR, type Pt2 } from './structures';

export type DecorCell = { kind: string; x: number; y: number; w: number; h: number; placeId: string | null };
export type TreeSpot = { x: number; y: number; kind: TreeKind; scale: number };

export type Mat = 'grass' | 'path' | 'plaza' | 'queue' | 'water' | 'pad' | 'bed';

export const isWalkableCode = (c: number, grassWalkable: boolean) => c === 1 || c === 2 || c === 4 || (c === 3 && grassWalkable);

export function cellMaterials(codes: Uint8Array, width: number, height: number, decor: DecorCell[]): Mat[] {
  const out: Mat[] = new Array(width * height);
  const special = new Array<Mat | null>(width * height).fill(null);
  for (const d of decor) {
    const m: Mat = d.kind === 'water' ? 'water' : d.placeId ? 'pad' : 'bed';
    for (let y = d.y; y < d.y + d.h; y++) for (let x = d.x; x < d.x + d.w; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      if (codes[y * width + x] === 0) special[y * width + x] = m; // blocked cells only
    }
  }
  for (let i = 0; i < width * height; i++) {
    const c = codes[i];
    out[i] = c === 1 ? 'path' : c === 2 ? 'plaza' : c === 4 ? 'queue' : c === 3 ? 'grass' : (special[i] ?? 'bed');
  }
  return out;
}

// ---------------------------------------------------------------- tile textures

function tile(P: number, paint: (img: ImageData, T: number) => void, doc: Document): HTMLCanvasElement {
  const T = P * 20;
  const c = doc.createElement('canvas'); c.width = T; c.height = T;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(T, T);
  paint(img, T);
  ctx.putImageData(img, 0, 0);
  return c;
}
const put = (img: ImageData, i: number, r: number, g: number, b: number) => { const d = img.data; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; };

function grassTile(P: number, doc: Document) {
  return tile(P, (img, T) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const n = 0.45 * vnoise(x / (P * 1.25), y / (P * 1.25), 11, Math.round(T / (P * 1.25)))
        + 0.35 * vnoise(x / (P * 0.25), y / (P * 0.25), 12, Math.round(T / (P * 0.25))) + 0.2 * hash2(x, y, 13);
      const t = Math.max(0, Math.min(1, (n - 0.2) / 0.65));
      const a = MAT.grassDark; const b = MAT.grassLight;
      let r = a[0] + (b[0] - a[0]) * t; let g = a[1] + (b[1] - a[1]) * t; let bl = a[2] + (b[2] - a[2]) * t;
      const blade = hash2(x, y, 14);
      if (blade > 0.93) { r *= 1.18; g *= 1.16; bl *= 1.05; } else if (blade < 0.06) { r *= 0.8; g *= 0.82; bl *= 0.85; }
      put(img, (y * T + x) * 4, r, g, bl);
    }
  }, doc);
}

/** Irregular cobbles / setts (jittered Voronoi), bevel-lit from the upper left. */
function stoneTile(P: number, doc: Document, base: RGB, seam: RGB, sizeM: number, jitter: number, seed: number, stretch = 1) {
  return tile(P, (img, T) => {
    const n = Math.max(2, Math.round(T / (sizeM * P))); const s = T / n;
    const pts: [number, number][] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pts.push([(i + 0.5 + (hash2(i, j, seed) - 0.5) * jitter) * s, (j + 0.5 + (hash2(i, j, seed + 1) - 0.5) * jitter) * s]);
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const ci = Math.floor(x / s); const cj = Math.floor(y / s);
      let d1 = 1e9; let d2 = 1e9; let best = 0; let bx = 0; let by = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = ci + di; const jj = cj + dj;
        const wi = ((ii % n) + n) % n; const wj = ((jj % n) + n) % n;
        const p = pts[wj * n + wi]!;
        const px = p[0] + (ii - wi) * s; const py = p[1] + (jj - wj) * s;
        const dx = (x - px) / stretch; const dy = y - py; const d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; best = wj * n + wi; bx = px; by = py; } else if (d < d2) d2 = d;
      }
      const edge = Math.sqrt(d2) - Math.sqrt(d1);
      const tone = 0.84 + hash2(best, 7, seed) * 0.28;
      const grain = 0.94 + hash2(x, y, seed + 5) * 0.12;
      const bevel = 1 + Math.max(-0.12, Math.min(0.12, ((bx - x) + (by - y)) / (s * 3)));
      const k = tone * grain * bevel;
      if (edge < P * 0.07) put(img, (y * T + x) * 4, seam[0] * grain, seam[1] * grain, seam[2] * grain);
      else if (edge < P * 0.11) put(img, (y * T + x) * 4, (base[0] * k + seam[0]) / 2, (base[1] * k + seam[1]) / 2, (base[2] * k + seam[2]) / 2);
      else put(img, (y * T + x) * 4, base[0] * k, base[1] * k, base[2] * k);
    }
  }, doc);
}

/** Rectangular units in running bond (flagstones, bricks, slabs). */
function bondTile(P: number, doc: Document, base: RGB, seam: RGB, wM: number, hM: number, seed: number, toneVar = 0.22) {
  return tile(P, (img, T) => {
    const bw = T / Math.round(T / (wM * P)); const bh = T / Math.round(T / (hM * P));
    for (let y = 0; y < T; y++) {
      const row = Math.floor(y / bh); const off = row % 2 ? bw / 2 : 0;
      for (let x = 0; x < T; x++) {
        const xx = (x + off) % T; const col = Math.floor(xx / bw);
        const fx = xx - col * bw; const fy = y - row * bh;
        const grain = 0.93 + hash2(x, y, seed + 3) * 0.14;
        const tone = 1 - toneVar / 2 + hash2(col, row, seed) * toneVar;
        const seamW = Math.max(1, P * 0.05);
        if (fx < seamW || fy < seamW) put(img, (y * T + x) * 4, seam[0] * grain, seam[1] * grain, seam[2] * grain);
        else {
          const lit = fx < seamW * 2.2 || fy < seamW * 2.2 ? 1.08 : fx > bw - seamW * 1.6 || fy > bh - seamW * 1.6 ? 0.9 : 1;
          const k = tone * grain * lit;
          put(img, (y * T + x) * 4, base[0] * k, base[1] * k, base[2] * k);
        }
      }
    }
  }, doc);
}

function waterTile(P: number, doc: Document) {
  return tile(P, (img, T) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      // Two noise lattices (each period divides the 20 m tile) stretched along x for ripples.
      const n = 0.6 * (vnoise(x / (P * 2.5), y / P, 21, 8, 20) * 0.5 + vnoise(x / (P * 2.5), y / P, 23, 8, 20) * 0.5)
        + 0.4 * vnoise(x / (P * 0.5), y / (P * 0.25), 22, 40, 80);
      const a = MAT.water; const hl = n > 0.72 ? (n - 0.72) * 2.2 : 0;
      put(img, (y * T + x) * 4, a[0] + 30 * hl + (n - 0.5) * 8, a[1] + 42 * hl + (n - 0.5) * 10, a[2] + 44 * hl + (n - 0.5) * 10);
    }
  }, doc);
}

function soilTile(P: number, doc: Document, base: RGB, seed: number, leafy: boolean) {
  return tile(P, (img, T) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const n = 0.6 * vnoise(x / (P * 0.5), y / (P * 0.5), seed, Math.round(T / (P * 0.5))) + 0.4 * hash2(x, y, seed);
      let r = base[0] * (0.8 + n * 0.4); let g = base[1] * (0.8 + n * 0.4); let b = base[2] * (0.8 + n * 0.4);
      if (leafy && hash2(x, y, seed + 9) > 0.9) { r = 56; g = 78; b = 44; }
      put(img, (y * T + x) * 4, r, g, b);
    }
  }, doc);
}

// ---------------------------------------------------------------- trees

export function placeTrees(codes: Uint8Array, width: number, height: number, grassWalkable: boolean, mats: Mat[]): TreeSpot[] {
  if (grassWalkable) return [];
  // Chebyshev distance (cells) from any cell that is not plain grass/bed.
  const INF = 99; const dist = new Uint8Array(width * height).fill(INF);
  const q: number[] = [];
  for (let i = 0; i < width * height; i++) {
    const m = mats[i];
    if (m !== 'grass' && m !== 'bed') { dist[i] = 0; q.push(i); }
  }
  for (let h = 0; h < q.length; h++) {
    const i = q[h]!; const x = i % width; const y = (i / width) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx; const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      if (dist[j]! > dist[i]! + 1) { dist[j] = dist[i]! + 1; q.push(j); }
    }
  }
  const out: TreeSpot[] = [];
  const taken = new Uint8Array(width * height);
  const free = (x: number, y: number, r: number) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx; const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < width && ny < height && taken[ny * width + nx]) return false;
    }
    return true;
  };
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x; const d = dist[i]!;
    if (codes[i] !== 3 && mats[i] !== 'bed') continue;
    const forest = vnoise(x / 13, y / 13, 41);
    const r = hash2(x, y, 42);
    const k = hash2(x, y, 43);
    if (d >= 3 && r < (forest > 0.55 ? 0.3 : forest > 0.4 ? 0.1 : 0.025) && free(x, y, 2)) {
      const kind: TreeKind = k < 0.32 ? 'oak' : k < 0.56 ? 'oakDark' : k < 0.7 ? 'elm' : k < 0.88 ? 'pine' : 'pineTall';
      out.push({ x: x + 0.2 + hash2(x, y, 44) * 0.6, y: y + 0.2 + hash2(x, y, 45) * 0.6, kind, scale: 0.8 + hash2(x, y, 46) * 0.4 });
      taken[i] = 1;
    } else if (d >= 2 && r > (forest > 0.5 ? 0.88 : 0.96) && free(x, y, 1)) {
      out.push({ x: x + 0.5, y: y + 0.5, kind: k < 0.5 ? 'shrub' : 'shrubLow', scale: 0.8 + hash2(x, y, 47) * 0.5 });
      taken[i] = 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------- painter

export type TerrainInput = {
  codes: Uint8Array; width: number; height: number; grassWalkable: boolean;
  decor: DecorCell[]; queueOrder: number[][]; shadows: Pt2[][]; trees: TreeSpot[]; pxPerM: number;
};

export function paintTerrain(inp: TerrainInput, doc: Document = document): { canvas: HTMLCanvasElement; mats: Mat[]; shadow: HTMLCanvasElement; shadowPxPerM: number } {
  const { codes, width: W, height: H, pxPerM: P } = inp;
  const mats = cellMaterials(codes, W, H, inp.decor);
  const canvas = doc.createElement('canvas'); canvas.width = W * P; canvas.height = H * P;
  const ctx = canvas.getContext('2d')!;
  const tiles: Record<Mat, HTMLCanvasElement> = {
    grass: grassTile(P, doc),
    path: stoneTile(P, doc, MAT.path, MAT.pathSeam, 0.5, 0.75, 3),
    plaza: bondTile(P, doc, MAT.plaza, MAT.plazaSeam, 1.2, 0.8, 5, 0.2),
    queue: bondTile(P, doc, MAT.queue, MAT.queueSeam, 0.5, 0.25, 7, 0.28),
    water: waterTile(P, doc),
    pad: bondTile(P, doc, MAT.pad, [70, 68, 62], 2, 2, 9, 0.1),
    bed: soilTile(P, doc, MAT.bed, 31, true),
  };
  const maskCanvas = doc.createElement('canvas'); maskCanvas.width = W; maskCanvas.height = H;
  const mctx = maskCanvas.getContext('2d')!;
  const tmp = doc.createElement('canvas'); tmp.width = W * P; tmp.height = H * P;
  const tctx = tmp.getContext('2d')!;
  const mask = (pred: (i: number) => boolean) => {
    const img = mctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) if (pred(i)) img.data[i * 4 + 3] = 255;
    mctx.putImageData(img, 0, 0);
    return maskCanvas;
  };
  const layer = (fill: (c: CanvasRenderingContext2D) => void, pred: (i: number) => boolean, alpha = 1, op: GlobalCompositeOperation = 'source-over') => {
    tctx.globalCompositeOperation = 'source-over';
    tctx.clearRect(0, 0, tmp.width, tmp.height);
    fill(tctx);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(mask(pred), 0, 0, W * P, H * P);
    ctx.globalAlpha = alpha; ctx.globalCompositeOperation = op;
    ctx.drawImage(tmp, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  };
  for (const m of Object.keys(tiles) as Mat[]) {
    layer((c) => { c.fillStyle = c.createPattern(tiles[m], 'repeat')!; c.fillRect(0, 0, tmp.width, tmp.height); }, (i) => mats[i] === m);
  }

  // Large-scale tonal variation on grass (sunlit patches, damp hollows).
  const low = doc.createElement('canvas'); low.width = Math.ceil(W / 2); low.height = Math.ceil(H / 2);
  const lctx = low.getContext('2d')!; const limg = lctx.createImageData(low.width, low.height);
  for (let y = 0; y < low.height; y++) for (let x = 0; x < low.width; x++) {
    const n = 0.65 * vnoise(x / 9, y / 9, 51) + 0.35 * vnoise(x / 3, y / 3, 52);
    const i = (y * low.width + x) * 4;
    const warm = n > 0.5;
    limg.data[i] = warm ? 150 : 20; limg.data[i + 1] = warm ? 140 : 34; limg.data[i + 2] = warm ? 70 : 26; limg.data[i + 3] = Math.abs(n - 0.5) * 2 * 120;
  }
  lctx.putImageData(limg, 0, 0);
  layer((c) => { c.imageSmoothingEnabled = true; c.drawImage(low, 0, 0, W * P, H * P); }, (i) => mats[i] === 'grass' || mats[i] === 'bed', 0.55);

  const walk = (i: number) => isWalkableCode(codes[i]!, inp.grassWalkable);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x);

  // Water: shallow light band along shores, then stone coping on the water side.
  ctx.save();
  ctx.beginPath(); // clip to water cells
  for (let i = 0; i < W * H; i++) if (mats[i] === 'water') ctx.rect((i % W) * P, ((i / W) | 0) * P, P, P);
  ctx.clip();
  try { ctx.filter = `blur(${P * 0.9}px)`; } catch { /* filter unsupported */ }
  ctx.strokeStyle = css(MAT.waterShallow, 0.55); ctx.lineWidth = P * 2.2;
  ctx.beginPath();
  const shoreEdges: [number, number, number, number][] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (mats[y * W + x] !== 'water') continue;
    const n = [[0, -1, x, y, x + 1, y], [0, 1, x, y + 1, x + 1, y + 1], [-1, 0, x, y, x, y + 1], [1, 0, x + 1, y, x + 1, y + 1]] as const;
    for (const [dx, dy, ax, ay, bx, by] of n) {
      const j = at(x + dx, y + dy);
      if (j >= 0 && mats[j] !== 'water') { ctx.moveTo(ax * P, ay * P); ctx.lineTo(bx * P, by * P); shoreEdges.push([ax, ay, bx, by]); }
    }
  }
  ctx.stroke();
  ctx.filter = 'none';
  ctx.strokeStyle = 'rgba(8,16,20,0.45)'; ctx.lineWidth = P * 0.9;
  ctx.beginPath(); for (const [ax, ay, bx, by] of shoreEdges) { ctx.moveTo(ax * P, ay * P); ctx.lineTo(bx * P, by * P); } ctx.stroke();
  ctx.strokeStyle = css(MAT.coping); ctx.lineWidth = P * 0.6;
  ctx.beginPath(); for (const [ax, ay, bx, by] of shoreEdges) { ctx.moveTo(ax * P, ay * P); ctx.lineTo(bx * P, by * P); } ctx.stroke();
  ctx.restore();

  // Curbs: a light kerb on the paved side and a dark lip on the blocked side of every
  // walkable/blocked boundary, so walkway edges read crisply at any zoom.
  const kerbIn: [number, number, number, number, number, number][] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!walk(i)) continue;
    const n = [[0, -1, x, y, x + 1, y], [0, 1, x, y + 1, x + 1, y + 1], [-1, 0, x, y, x, y + 1], [1, 0, x + 1, y, x + 1, y + 1]] as const;
    for (const [dx, dy, ax, ay, bx, by] of n) {
      const j = at(x + dx, y + dy);
      if (j >= 0 && !walk(j)) kerbIn.push([ax, ay, bx, by, dx, dy]);
    }
  }
  const strokeEdges = (off: number, width: number, style: string) => {
    ctx.strokeStyle = style; ctx.lineWidth = width; ctx.beginPath();
    for (const [ax, ay, bx, by, dx, dy] of kerbIn) { ctx.moveTo(ax * P + dx * off, ay * P + dy * off); ctx.lineTo(bx * P + dx * off, by * P + dy * off); }
    ctx.stroke();
  };
  ctx.lineCap = 'square';
  strokeEdges(P * 0.22, P * 0.32, 'rgba(10,14,8,0.35)'); // lip shadow on the blocked side
  strokeEdges(-P * 0.09, P * 0.18, css(MAT.curb, 0.9)); // kerb stone on the paved side
  strokeEdges(-P * 0.2, P * 0.06, 'rgba(0,0,0,0.18)');
  // Faint seam where path meets plaza / queue.
  ctx.strokeStyle = 'rgba(40,34,28,0.35)'; ctx.lineWidth = Math.max(1, P * 0.06); ctx.beginPath();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!walk(i)) continue;
    const r = at(x + 1, y); const d = at(x, y + 1);
    if (r >= 0 && walk(r) && codes[r] !== codes[i]) { ctx.moveTo((x + 1) * P, y * P); ctx.lineTo((x + 1) * P, (y + 1) * P); }
    if (d >= 0 && walk(d) && codes[d] !== codes[i]) { ctx.moveTo(x * P, (y + 1) * P); ctx.lineTo((x + 1) * P, (y + 1) * P); }
  }
  ctx.stroke();

  // Queue lanes: rail footprints between adjacent queue cells that are not consecutive in
  // the authoritative serpentine order (the upright stanchions are drawn by the scene).
  ctx.strokeStyle = 'rgba(20,16,12,0.35)'; ctx.lineWidth = P * 0.14; ctx.beginPath();
  for (const seg of queueRails(inp.queueOrder, W)) { ctx.moveTo(seg[0] * P, seg[1] * P); ctx.lineTo(seg[2] * P, seg[3] * P); }
  ctx.stroke();

  // Structure pads: ambient occlusion around footprints.
  ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = P * 0.5;
  for (const d of inp.decor) if (d.placeId && d.kind !== 'water') ctx.strokeRect(d.x * P + P * 0.5, d.y * P + P * 0.5, d.w * P - P, d.h * P - P);

  // Cast shadows (structures + trees) go on their own half-resolution layer so the scene can
  // fade them with the sun; overlaps are merged so they never double up.
  const SP = Math.max(2, Math.round(P / 2));
  const sh = doc.createElement('canvas'); sh.width = W * SP; sh.height = H * SP;
  const sctx = sh.getContext('2d')!;
  try { sctx.filter = `blur(${Math.max(1, SP * 0.35)}px)`; } catch { /* unsupported */ }
  sctx.fillStyle = '#000';
  for (const poly of inp.shadows) {
    if (poly.length < 3) continue;
    sctx.beginPath(); sctx.moveTo(poly[0]![0] * SP, poly[0]![1] * SP);
    for (let k = 1; k < poly.length; k++) sctx.lineTo(poly[k]![0] * SP, poly[k]![1] * SP);
    sctx.closePath(); sctx.fill();
  }
  for (const t of inp.trees) {
    const big = t.kind !== 'shrub' && t.kind !== 'shrubLow';
    const h = (big ? (t.kind.startsWith('pine') ? 5 : 4.5) : 0.8) * t.scale;
    const r = (big ? (t.kind.startsWith('pine') ? 1.2 : 2.1) : 0.7) * t.scale;
    sctx.beginPath();
    sctx.ellipse((t.x + SHADOW_DIR[0] * h) * SP, (t.y + SHADOW_DIR[1] * h) * SP, r * SP * 1.15, r * SP * 0.9, Math.atan2(SHADOW_DIR[1], SHADOW_DIR[0]), 0, Math.PI * 2);
    sctx.fill();
  }
  sctx.filter = 'none';

  // Contact darkening at tree bases.
  for (const t of inp.trees) {
    const g = ctx.createRadialGradient(t.x * P, t.y * P, 0, t.x * P, t.y * P, P * 1.4 * t.scale);
    g.addColorStop(0, 'rgba(10,14,8,0.35)'); g.addColorStop(1, 'rgba(10,14,8,0)');
    ctx.fillStyle = g; ctx.fillRect((t.x - 1.5) * P, (t.y - 1.5) * P, P * 3, P * 3);
  }
  // Free scratch canvases now (accelerated 2D canvases hold GPU memory until collected).
  for (const c of [tmp, low, maskCanvas, ...Object.values(tiles)]) { c.width = 0; c.height = 0; }
  return { canvas, mats, shadow: sh, shadowPxPerM: SP };
}

// ---------------------------------------------------------------- night lighting

export type Lamp = { x: number; y: number };

/**
 * Lamp posts on BLOCKED, non-water cells that border a walkway (never on the walkway itself),
 * spaced roughly every `spacing` metres along the paths.
 */
export function placeLamps(codes: Uint8Array, width: number, height: number, mats: Mat[], blockedByStructure: (i: number) => boolean, spacing = 9): Lamp[] {
  const out: Lamp[] = [];
  const near = (x: number, y: number) => out.some((l) => Math.abs(l.x - x) < spacing && Math.abs(l.y - y) < spacing && Math.hypot(l.x - x, l.y - y) < spacing);
  for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
    const i = y * width + x;
    if (codes[i] !== 0 && codes[i] !== 3) continue;
    if (mats[i] === 'water' || blockedByStructure(i)) continue;
    let side: [number, number] | null = null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const c = codes[(y + dy) * width + x + dx];
      if (c === 1 || c === 2) { side = [dx, dy]; break; }
    }
    if (!side || near(x + 0.5, y + 0.5)) continue;
    // Sit the post near the kerb on the blocked cell.
    out.push({ x: x + 0.5 + side[0] * 0.3, y: y + 0.5 + side[1] * 0.3 });
  }
  return out;
}

/** Baked warm light pools (additive): lamps plus light spilling from lit facades. */
export function paintLightPools(width: number, height: number, pxPerM: number, lamps: Lamp[], spills: { x: number; y: number; r: number; a: number }[], doc: Document = document): HTMLCanvasElement {
  const P = pxPerM;
  const c = doc.createElement('canvas'); c.width = width * P; c.height = height * P;
  const ctx = c.getContext('2d')!;
  ctx.globalCompositeOperation = 'lighter';
  const pool = (x: number, y: number, r: number, a: number) => {
    const g = ctx.createRadialGradient(x * P, y * P, 0, x * P, y * P, r * P);
    g.addColorStop(0, `rgba(255,196,120,${a})`); g.addColorStop(0.35, `rgba(240,160,90,${a * 0.45})`); g.addColorStop(1, 'rgba(200,120,60,0)');
    ctx.fillStyle = g; ctx.fillRect((x - r) * P, (y - r) * P, r * 2 * P, r * 2 * P);
  };
  for (const l of lamps) pool(l.x, l.y, 7, 0.85);
  for (const s of spills) pool(s.x, s.y, s.r, s.a);
  return c;
}

/** Rail segments (cell-edge coordinates) for serpentine queues. */
export function queueRails(order: number[][], width: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const cells of order) {
    const pos = new Map<number, number>();
    cells.forEach((c, k) => pos.set(c, k));
    for (const c of cells) {
      const x = c % width; const y = (c / width) | 0;
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        if (x + dx >= width) continue;
        const n = (y + dy) * width + (x + dx);
        const kn = pos.get(n);
        if (kn === undefined) continue;
        if (Math.abs(kn - pos.get(c)!) === 1) continue;
        if (dx === 1) out.push([x + 1, y, x + 1, y + 1]); else out.push([x, y + 1, x + 1, y + 1]);
      }
    }
  }
  return out;
}
