/** Colour helpers and the scene's material palette (muted, late-afternoon, grounded). */

export type RGB = [number, number, number];

export const rgbNum = ([r, g, b]: RGB) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
export const numRgb = (c: number): RGB => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const clamp = (v: number) => Math.max(0, Math.min(255, v));
/** Multiply a colour (number) by f, with a slight warm/cool bias: shadows go cooler. */
export function shade(c: number, f: number): number {
  const [r, g, b] = numRgb(c);
  const cool = f < 1 ? (1 - f) * 0.18 : 0;
  return rgbNum([clamp(r * f * (1 - cool)), clamp(g * f * (1 - cool * 0.5)), clamp(b * f * (1 + cool * 0.4))]);
}
export function mix(a: number, b: number, t: number): number {
  const x = numRgb(a); const y = numRgb(b);
  return rgbNum([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}
export const css = (c: RGB, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

/** Deterministic hash in [0, 1). */
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export const hashStr = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; };

const smooth = (t: number) => t * t * (3 - 2 * t);
/** Value noise with an optional lattice period (for tileable textures). */
export function vnoise(x: number, y: number, seed: number, period = 0, periodY = period): number {
  const xi = Math.floor(x); const yi = Math.floor(y);
  const fx = smooth(x - xi); const fy = smooth(y - yi);
  const w = (v: number) => (period ? ((v % period) + period) % period : v);
  const h = (v: number) => (periodY ? ((v % periodY) + periodY) % periodY : v);
  const a = hash2(w(xi), h(yi), seed); const b = hash2(w(xi + 1), h(yi), seed);
  const c = hash2(w(xi), h(yi + 1), seed); const d = hash2(w(xi + 1), h(yi + 1), seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Ground materials (top-down texture base colours). */
export const MAT = {
  grass: [74, 93, 53] as RGB,
  grassLight: [106, 116, 64] as RGB,
  grassDark: [54, 71, 42] as RGB,
  path: [132, 124, 110] as RGB,
  pathSeam: [78, 72, 64] as RGB,
  plaza: [150, 142, 126] as RGB,
  plazaSeam: [96, 90, 80] as RGB,
  queue: [118, 86, 68] as RGB,
  queueSeam: [74, 54, 44] as RGB,
  water: [30, 56, 66] as RGB,
  waterShallow: [58, 96, 102] as RGB,
  pad: [96, 92, 84] as RGB,
  bed: [58, 50, 42] as RGB,
  coping: [148, 140, 126] as RGB,
  curb: [168, 160, 144] as RGB,
} as const;

/** Structure colours (numbers for Pixi). */
export const BUILD = {
  stone: 0x8f8574, stoneDark: 0x6c6457, whitewash: 0xb4ab9a, timber: 0x5e4a3c, clapboard: 0x5f6c70,
  brick: 0x7d5444, slate: 0x40454c, copper: 0x4f6a61, terracotta: 0x84503d, shingle: 0x56443a,
  steel: 0x8c9092, steelDark: 0x4a4e52, glassWarm: 0xd9a75a, glassDark: 0x2c3438, glassDay: 0x4a5258, cream: 0xbcb197,
  oxblood: 0x6e2e29, navy: 0x2f3e4f, mustard: 0x9a7a3a, teal: 0x2f6563, rust: 0x8a4630, rock: 0x6f675c,
} as const;
