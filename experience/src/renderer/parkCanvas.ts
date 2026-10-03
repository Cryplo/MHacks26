/**
 * Paints the display map from the AUTHORITATIVE grid (the same bytes the Engine navigates)
 * plus decorative fills. Decor only ever paints cells whose code is blocked, so artwork can
 * never cover or imply a walkway, entrance or queue.
 */
import type { ParkBundle } from '../../contract/behavior-v1';

export type DecorRect = { kind: string; x: number; y: number; w: number; h: number };

export const DISPLAY_COLORS = {
  0: '#3b4652', 1: '#d8c7a5', 2: '#efe3c9', 3: '#5f8f55', 4: '#e9b07a',
} as const;
const DECOR_COLORS: Record<string, string> = { water: '#3d78a8', track: '#6b5a7e', roof: '#8a4b3c', stall: '#b5651d', blocked: '#3b4652' };

export function decodeGrid(park: Pick<ParkBundle, 'grid'>): Uint8Array {
  const bin = atob(park.grid.cellsBase64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function paintParkCanvas(codes: Uint8Array, width: number, height: number, px: number, decor: DecorRect[],
  doc: Document = document): HTMLCanvasElement {
  const canvas = doc.createElement('canvas');
  canvas.width = width * px;
  canvas.height = height * px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = codes[y * width + x] as 0 | 1 | 2 | 3 | 4;
      ctx.fillStyle = DISPLAY_COLORS[c];
      if (c === 3 && ((x * 7 + y * 13) % 11 === 0)) ctx.fillStyle = '#5a8850';
      ctx.fillRect(x * px, y * px, px, px);
      if (c === 4 && px >= 3 && (x + y) % 2 === 0) {
        ctx.fillStyle = 'rgba(160, 80, 20, 0.25)';
        ctx.fillRect(x * px, y * px, px, px);
      }
    }
  }
  for (const d of decor) {
    const color = DECOR_COLORS[d.kind] ?? DECOR_COLORS.blocked!;
    for (let y = d.y; y < d.y + d.h; y++) {
      for (let x = d.x; x < d.x + d.w; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height || codes[y * width + x] !== 0) continue; // blocked cells only
        ctx.fillStyle = color;
        ctx.fillRect(x * px, y * px, px, px);
        if (d.kind === 'track' && (x + y) % 6 === 0) { ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(x * px, y * px, px, px); }
        if (d.kind === 'water' && (x * 3 + y * 5) % 17 === 0) { ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(x * px, y * px, px, px); }
      }
    }
  }
  return canvas;
}
