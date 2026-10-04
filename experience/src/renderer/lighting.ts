/**
 * Continuous day/night lighting keyed by local hour (0-24). Every channel is interpolated
 * between keyframes with a smoothstep, so there are no hard switches. Values are cheap to
 * apply: multiplicative tints on baked layers, alphas on baked light/shadow layers.
 */
export type Phase = 'night' | 'dawn' | 'morning' | 'day' | 'golden hour' | 'dusk';

export type Lighting = {
  hour: number;
  phase: Phase;
  /** Multiplier for terrain, structures and props (r, g, b in 0..1). */
  world: [number, number, number];
  /** Milder multiplier for guests so they stay legible at night. */
  guest: [number, number, number];
  /** Background / sky colour behind the park. */
  sky: [number, number, number];
  /** Screen-space haze from the upper left (colour + alpha). */
  haze: [number, number, number]; hazeAlpha: number;
  /** Cast-shadow layer opacity. */
  shadow: number;
  /** 0 = lights off, 1 = full night lighting. */
  lights: number;
};

type Key = { h: number; world: [number, number, number]; sky: [number, number, number]; haze: [number, number, number]; hazeA: number; shadow: number; lights: number };

const KEYS: Key[] = [
  { h: 0, world: [0.3, 0.36, 0.58], sky: [7, 10, 20], haze: [40, 60, 120], hazeA: 0.05, shadow: 0.05, lights: 1 },
  { h: 4.6, world: [0.31, 0.36, 0.58], sky: [8, 11, 22], haze: [40, 60, 120], hazeA: 0.05, shadow: 0.05, lights: 1 },
  { h: 5.8, world: [0.7, 0.6, 0.72], sky: [151, 151, 184], haze: [240, 150, 170], hazeA: 0.16, shadow: 0.16, lights: 0.55 },
  { h: 7, world: [0.93, 0.85, 0.8], sky: [193, 221, 236], haze: [255, 190, 150], hazeA: 0.12, shadow: 0.34, lights: 0 },
  { h: 9.5, world: [0.99, 0.96, 0.91], sky: [184, 220, 240], haze: [255, 236, 200], hazeA: 0.06, shadow: 0.42, lights: 0 },
  { h: 12.5, world: [1, 1, 0.98], sky: [184, 220, 240], haze: [255, 250, 235], hazeA: 0.05, shadow: 0.46, lights: 0 },
  { h: 15, world: [1, 0.96, 0.88], sky: [190, 219, 235], haze: [255, 220, 170], hazeA: 0.07, shadow: 0.47, lights: 0 },
  { h: 16.6, world: [1, 0.9, 0.74], sky: [214, 205, 191], haze: [255, 170, 90], hazeA: 0.2, shadow: 0.52, lights: 0.08 },
  { h: 17.6, world: [0.9, 0.72, 0.64], sky: [178, 147, 164], haze: [250, 130, 80], hazeA: 0.22, shadow: 0.4, lights: 0.4 },
  { h: 18.4, world: [0.56, 0.48, 0.66], sky: [24, 18, 38], haze: [150, 100, 190], hazeA: 0.14, shadow: 0.2, lights: 0.8 },
  { h: 19.3, world: [0.36, 0.38, 0.62], sky: [10, 13, 28], haze: [70, 80, 160], hazeA: 0.08, shadow: 0.08, lights: 1 },
  { h: 24, world: [0.3, 0.36, 0.58], sky: [7, 10, 20], haze: [40, 60, 120], hazeA: 0.05, shadow: 0.05, lights: 1 },
];

const sm = (t: number) => t * t * (3 - 2 * t);
const lerp3 = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function phaseOf(h: number): Phase {
  if (h < 5 || h >= 19.3) return 'night';
  if (h < 6.6) return 'dawn';
  if (h < 10) return 'morning';
  if (h < 16) return 'day';
  if (h < 17.9) return 'golden hour';
  return 'dusk';
}

export function lightingAt(hour: number): Lighting {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1]!.h <= h) i++;
  const a = KEYS[i]!; const b = KEYS[i + 1]!;
  const t = sm(Math.min(1, Math.max(0, (h - a.h) / (b.h - a.h))));
  const world = lerp3(a.world, b.world, t);
  const lights = a.lights + (b.lights - a.lights) * t;
  // Guests: halfway between full brightness and the world tint, plus a little extra lift at night.
  const guest = world.map((c) => Math.min(1, c + (1 - c) * 0.62 + lights * 0.04)) as [number, number, number];
  return {
    hour: h, phase: phaseOf(h), world, guest, lights,
    sky: lerp3(a.sky, b.sky, t), haze: lerp3(a.haze, b.haze, t), hazeAlpha: a.hazeA + (b.hazeA - a.hazeA) * t,
    shadow: a.shadow + (b.shadow - a.shadow) * t,
  };
}

/** "HH:MM" -> hours. Falls back to 9:00 for anything unparseable. */
export function parseOpenLocal(s: string | undefined): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  if (!m) return 9;
  return Number(m[1]) + Number(m[2]) / 60;
}

export const tintNum = (m: [number, number, number], base = 0xffffff) => {
  const r = ((base >> 16) & 255) * m[0]; const g = ((base >> 8) & 255) * m[1]; const b = (base & 255) * m[2];
  return (Math.round(Math.min(255, r)) << 16) | (Math.round(Math.min(255, g)) << 8) | Math.round(Math.min(255, b));
};
