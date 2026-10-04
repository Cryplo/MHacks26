import type { Heatmap, HeatLayer, ParkBundle, Vec2 } from '../../../contract/behavior-v1';

export const LAYER_INFO: Record<HeatLayer, { label: string; measure: 'duration' | 'count' | 'money' | 'points'; note: string }> = {
  waiting_person_minutes: { label: 'Waiting (person-minutes)', measure: 'duration', note: 'Duration: minutes people spent queueing in each cell, summed over people.' },
  negative_experience: { label: 'Negative modeled-experience contributions', measure: 'points', note: 'Model ledger points assigned to events at each location. Contributions assigned by the model, not proven real-world causes.' },
  spending_cents: { label: 'Spending', measure: 'money', note: 'Sum of purchase amounts at the point of sale.' },
  early_departures: { label: 'Early departures', measure: 'count', note: 'Count of guests leaving earlier than planned, at their exit point.' },
  bump_episodes: { label: 'Bump episodes', measure: 'count', note: 'Count of bump episodes (only when bump reactions are enabled).' },
};

export type HotCell = { index: number; col: number; row: number; center: Vec2; value: number; nearestPlace: string | null };

/** Heatmap cell -> world metres (row-major, top-left origin, y down). No flips, no pixels. */
export function cellCenter(h: Pick<Heatmap, 'width' | 'cellM'>, index: number): Vec2 {
  return { xM: ((index % h.width) + 0.5) * h.cellM, yM: (Math.floor(index / h.width) + 0.5) * h.cellM };
}

export function topCells(h: Heatmap, park: ParkBundle, n = 5): HotCell[] {
  const idx = h.values.map((v, i) => [v, i] as const).filter(([v]) => v > 0).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, n);
  return idx.map(([value, index]) => {
    const center = cellCenter(h, index);
    let best: { name: string; d: number } | null = null;
    for (const p of park.places) {
      const d = Math.hypot(p.entrance.xM - center.xM, p.entrance.yM - center.yM);
      if (!best || d < best.d) best = { name: p.name, d };
    }
    return { index, col: index % h.width, row: Math.floor(index / h.width), center, value, nearestPlace: best && best.d < 25 ? best.name : null };
  });
}

/** Sequential colour (yellow -> deep purple, sqrt scale); zero cells are transparent. */
export function heatColor(v: number, max: number): [number, number, number, number] {
  if (v <= 0 || max <= 0) return [0, 0, 0, 0];
  const t = Math.min(1, Math.sqrt(v / max));
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * t);
  return [lerp(253, 68), lerp(231, 1), lerp(37, 84), 255];
}
