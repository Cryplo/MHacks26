/**
 * Static isometric park preview (no guests, no animation). Renders the same terrain,
 * structures and lighting as the live map once per (park, size, hour) into a cached image,
 * through ONE short-lived WebGL context at a time, then draws it (plus an optional heat
 * overlay of iso ground tiles) into a plain 2D canvas. Falls back to the top-down painted
 * grid if WebGL is unavailable.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ParkBundle } from '../../contract/behavior-v1';
import { decorFor, HARBOR_LIGHTS_PARK_ID } from '../content/harborLights';
import { IsoProjection } from './iso';
import { paintParkCanvas } from './parkCanvas';
import { ParkScene } from './ParkScene';
import { sceneContentFor } from './sceneContent';

export type HeatOverlay = {
  /** Grid cell index (y * width + x) and a non-negative value. */
  cells: { cell: number; value: number }[];
  /** Value mapped to full intensity (default: max of `cells`). */
  max?: number;
  /** CSS colour for a normalised value t in (0, 1]. Default: amber -> vermilion ramp. */
  color?: (t: number) => string;
};

export type IsoParkPreviewProps = {
  park: ParkBundle;
  codes: Uint8Array;
  /** CSS height in px (width fills the container). Default 260. */
  height?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Local hour 0-24 for lighting (default: park opening time). */
  hour?: number;
  heat?: HeatOverlay | null;
  /** Darken and desaturate the park under a heat overlay so heat colours read clearly (default: on when `heat` is set). */
  dimBase?: boolean;
  /** Called with the grid cell index under the pointer (null when off the park). */
  onCellHover?: (cell: number | null) => void;
  /** Accessible label for the image. */
  label?: string;
};

type Still = { canvas: HTMLCanvasElement; scale: number; offsetX: number; offsetY: number; iso: boolean };

const cache = new Map<string, Promise<Still>>();
let queue: Promise<unknown> = Promise.resolve();

function renderStill(park: ParkBundle, codes: Uint8Array, w: number, h: number, hour: number | undefined): Promise<Still> {
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const key = `${park.parkId}|${park.revision}|${w}x${h}@${dpr}|${hour ?? 'open'}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const job = queue.then(async (): Promise<Still> => {
    const host = document.createElement('div');
    host.style.cssText = `position:fixed;left:-20000px;top:0;width:${w}px;height:${h}px;pointer-events:none;`;
    host.setAttribute('aria-hidden', 'true');
    document.body.appendChild(host);
    let scene: ParkScene | null = null;
    try {
      scene = await ParkScene.create({
        host, ...sceneContentFor(park, codes), staticView: true,
        onPick: () => undefined, onCameraChange: () => undefined, onFailure: () => undefined,
      });
      const r = scene.renderStill(hour);
      return { ...r, iso: true };
    } catch {
      // No WebGL: top-down painted grid, fitted.
      const px = Math.max(1, Math.floor(Math.min((w * dpr) / park.grid.width, (h * dpr) / park.grid.height)));
      const decor = park.parkId === HARBOR_LIGHTS_PARK_ID ? decorFor(new Set(park.places.map((p) => p.id))) : [];
      const src = paintParkCanvas(codes, park.grid.width, park.grid.height, px, decor);
      const out = document.createElement('canvas'); out.width = Math.round(w * dpr); out.height = Math.round(h * dpr);
      const scale = Math.min(w / park.grid.width, h / park.grid.height);
      const ox = (w - park.grid.width * scale) / 2; const oy = (h - park.grid.height * scale) / 2;
      out.getContext('2d')?.drawImage(src, ox * dpr, oy * dpr, park.grid.width * scale * dpr, park.grid.height * scale * dpr);
      return { canvas: out, scale, offsetX: ox, offsetY: oy, iso: false };
    } finally {
      scene?.destroy();
      host.remove();
    }
  });
  queue = job.catch(() => undefined);
  cache.set(key, job);
  if (cache.size > 12) cache.delete(cache.keys().next().value!);
  return job;
}

const defaultHeat = (t: number) => {
  // Colour-vision-safe sequential ramp: pale amber -> orange -> vermilion.
  const a = [240, 228, 66]; const b = [230, 159, 0]; const c = [213, 94, 0];
  const [p, q, u] = t < 0.5 ? [a, b, t * 2] : [b, c, (t - 0.5) * 2];
  const m = (i: number) => Math.round(p[i]! + (q[i]! - p[i]!) * u);
  return `rgba(${m(0)},${m(1)},${m(2)},${0.35 + 0.5 * t})`;
};

export function IsoParkPreview(props: IsoParkPreviewProps) {
  const { park, codes, hour, heat, onCellHover } = props;
  const dim = props.dimBase ?? !!(heat && heat.cells.length);
  const height = props.height ?? 260;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [still, setStill] = useState<Still | null>(null);
  const proj = useMemo(() => new IsoProjection(park.grid.width * park.grid.cellM, park.grid.height * park.grid.cellM), [park]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(0, Math.round(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (width < 8) return;
    let live = true;
    // Debounce resizes a little so dragging a panel doesn't render every pixel width.
    const t = setTimeout(() => { void renderStill(park, codes, width, height, hour).then((s) => { if (live) setStill(s); }); }, 60);
    return () => { live = false; clearTimeout(t); };
  }, [park, codes, width, height, hour]);

  const toScreen = useMemo(() => {
    if (!still) return null;
    const cm = park.grid.cellM;
    if (still.iso) return (x: number, y: number) => ({ x: proj.px(x * cm, y * cm) * still.scale + still.offsetX, y: proj.py(x * cm, y * cm) * still.scale + still.offsetY });
    return (x: number, y: number) => ({ x: x * still.scale + still.offsetX, y: y * still.scale + still.offsetY });
  }, [still, proj, park]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !still || !toScreen) return;
    const dpr = still.canvas.width / Math.max(1, width);
    c.width = still.canvas.width; c.height = still.canvas.height;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (dim) {
      const filtered = typeof ctx.filter === 'string';
      if (filtered) ctx.filter = 'saturate(0.35) brightness(0.55)';
      ctx.drawImage(still.canvas, 0, 0);
      if (filtered) ctx.filter = 'none';
      else { ctx.fillStyle = 'rgba(8,10,12,0.45)'; ctx.fillRect(0, 0, c.width, c.height); }
    } else ctx.drawImage(still.canvas, 0, 0);
    if (!heat || heat.cells.length === 0) return;
    const max = heat.max ?? Math.max(...heat.cells.map((h) => h.value), 0);
    if (!(max > 0)) return;
    const color = heat.color ?? defaultHeat;
    const W = park.grid.width;
    ctx.save(); ctx.scale(dpr, dpr);
    for (const { cell, value } of heat.cells) {
      if (!(value > 0)) continue;
      const x = cell % W; const y = Math.floor(cell / W);
      const a = toScreen(x, y); const b = toScreen(x + 1, y); const d = toScreen(x + 1, y + 1); const e = toScreen(x, y + 1);
      ctx.fillStyle = color(Math.min(1, value / max));
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(d.x, d.y); ctx.lineTo(e.x, e.y); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }, [still, heat, toScreen, width, park, dim]);

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onCellHover || !still) return;
    const r = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - r.left; const sy = e.clientY - r.top;
    const cm = park.grid.cellM;
    let gx: number; let gy: number;
    if (still.iso) {
      const g = proj.toGround({ x: (sx - still.offsetX) / still.scale, y: (sy - still.offsetY) / still.scale });
      gx = Math.floor(g.xM / cm); gy = Math.floor(g.yM / cm);
    } else { gx = Math.floor((sx - still.offsetX) / still.scale); gy = Math.floor((sy - still.offsetY) / still.scale); }
    onCellHover(gx < 0 || gy < 0 || gx >= park.grid.width || gy >= park.grid.height ? null : gy * park.grid.width + gx);
  };

  return (
    <div ref={wrap} className={props.className} data-testid="iso-park-preview" data-preview-status={still ? (still.iso ? 'iso' : 'flat') : 'loading'}
      style={{ position: 'relative', width: '100%', height, background: '#101416', borderRadius: 8, overflow: 'hidden', ...props.style }}>
      <canvas ref={canvas} role="img" aria-label={props.label ?? `${park.label} park preview`}
        onPointerMove={onCellHover ? onMove : undefined} onPointerLeave={onCellHover ? () => onCellHover(null) : undefined}
        style={{ display: 'block', width: '100%', height: '100%' }} />
      {!still && <div aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(233,228,216,0.6)', fontSize: 12 }}>Rendering park…</div>}
    </div>
  );
}
