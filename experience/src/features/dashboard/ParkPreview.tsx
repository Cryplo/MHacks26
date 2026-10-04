/**
 * The one place pages draw a static picture of the park (setup card, dashboard heat maps).
 * Heat overlays arrive as park-grid cells, the same shape the renderer's iso preview takes,
 * matching the renderer's iso preview overlay.
 */
import { useMemo } from 'react';
import type { Heatmap, ParkBundle } from '../../../contract/behavior-v1';
import { IsoParkPreview } from '../../renderer/IsoParkPreview';

export type HeatCells = { cells: { cell: number; value: number }[] };

/** Heatmap (any cell size) -> values on the park grid (each heat cell spread over the park cells it covers). */
export function toParkCells(h: Heatmap, park: ParkBundle): HeatCells {
  const k = h.cellM / park.grid.cellM;
  const out: { cell: number; value: number }[] = [];
  h.values.forEach((v, i) => {
    if (v <= 0) return;
    const hx = i % h.width; const hy = Math.floor(i / h.width);
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
      const x = Math.floor(hx * k + dx); const y = Math.floor(hy * k + dy);
      if (x < park.grid.width && y < park.grid.height) out.push({ cell: y * park.grid.width + x, value: v });
    }
  });
  return { cells: out };
}

/** Amber one-hue ramp for the dark surface: dim = little, bright = a lot. */
export function rampColor(t: number): [number, number, number] {
  const stops: [number, number, number][] = [[74, 48, 8], [168, 110, 22], [240, 180, 60], [255, 226, 160]];
  const x = Math.min(0.999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(x); const f = x - i;
  const a = stops[i]!; const b = stops[i + 1]!;
  return [0, 1, 2].map((n) => Math.round(a[n]! + (b[n]! - a[n]!) * f)) as [number, number, number];
}

/** Iso park picture (renderer's IsoParkPreview) with our amber heat ramp. */
export function ParkPreview(props: { park: ParkBundle; codes: Uint8Array; heat?: HeatCells | null; className?: string; label: string; height?: number }) {
  const heat = useMemo(() => (props.heat ? { cells: props.heat.cells, color: (t: number) => { const [r, g, b] = rampColor(Math.sqrt(t)); return `rgba(${r},${g},${b},${0.6 + 0.4 * Math.sqrt(t)})`; } } : null), [props.heat]);
  return <IsoParkPreview park={props.park} codes={props.codes} heat={heat} className={props.className} label={props.label} height={props.height ?? 300} />;
}
