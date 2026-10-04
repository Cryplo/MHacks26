/**
 * Hand-rolled SVG charts for the dark design system. Specs (dataviz skill): 2px lines with
 * round joins, ~10% area wash, hairline recessive grid, one y-axis, >=8px end markers with a
 * surface ring, bars <=24px thick with 4px rounded data ends, a crosshair + tooltip on every
 * time chart and a per-mark tooltip on bars. Text always wears ink tokens, never series colour.
 * Categorical slots (validated on the #12161b surface): blue, orange, aqua, yellow, magenta.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'] as const;
export const ACCENT = '#f0b43c';
const GRID = '#20262e';
const AXIS = '#2c343e';
const MUTED = '#6e7886';

export type Pt = { t: number; v: number | null };
export type Series = { id: string; label: string; color: string; points: Pt[] };

export function useWidth<T extends HTMLElement>(fallback = 0) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const first = Math.floor(el.getBoundingClientRect().width);
    if (first > 0) setW(first);
    const ro = new ResizeObserver(([e]) => { const cw = Math.floor(e!.contentRect.width); if (cw > 0) setW(cw); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Clean tick values (1/2/5 x 10^k) from 0 to at least max. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Number(v.toFixed(6)));
  if (out[out.length - 1]! < max) out.push(out[out.length - 1]! + step);
  return out;
}

export const compact = (n: number) => Math.abs(n) >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : Math.abs(n) >= 10_000 ? `${Math.round(n / 1000)}K` : Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${Math.round(n * 10) / 10}`;

type TimeChartProps = {
  series: Series[]; height?: number; xDomain: [number, number]; xTicks?: { t: number; label: string }[];
  yFormat: (v: number) => string; xFormat: (t: number) => string; area?: boolean; compact?: boolean;
  yMax?: number; ariaLabel: string; marker?: number | null; step?: boolean;
};

/** Line/area chart over simulated time with a snapping crosshair and an all-series tooltip. */
export function TimeChart(props: TimeChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const h = props.height ?? 160;
  const pad = props.compact ? { l: 2, r: 6, t: 6, b: 4 } : { l: 40, r: 12, t: 10, b: 22 };
  const iw = Math.max(10, width - pad.l - pad.r); const ih = Math.max(10, h - pad.t - pad.b);
  const [x0, x1] = props.xDomain;
  const allV = props.series.flatMap((s) => s.points.map((p) => p.v ?? 0));
  const ticks = niceTicks(props.yMax ?? Math.max(...allV, 0), props.compact ? 2 : 4);
  const yTop = ticks[ticks.length - 1]!;
  const X = (t: number) => pad.l + ((t - x0) / Math.max(1, x1 - x0)) * iw;
  const Y = (v: number) => pad.t + ih - (v / (yTop || 1)) * ih;
  const times = useMemo(() => [...new Set(props.series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b), [props.series]);
  const path = (pts: Pt[]) => {
    let d = ''; let pen = false; let prevY = 0;
    for (const p of pts) {
      if (p.v === null) { pen = false; continue; }
      const x = X(p.t).toFixed(1); const y = Y(p.v).toFixed(1);
      if (!pen) d += `M${x},${y}`;
      else d += props.step ? `H${x}V${y}` : `L${x},${y}`;
      pen = true; prevY = Number(y);
    }
    void prevY;
    return d;
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!times.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = x0 + ((e.clientX - r.left - pad.l) / iw) * (x1 - x0);
    let best = times[0]!;
    for (const tt of times) if (Math.abs(tt - t) < Math.abs(best - t)) best = tt;
    setHover(best);
  };
  const hv = hover === null ? null : props.series.map((s) => ({ s, p: s.points.find((p) => p.t === hover) ?? null }));
  if (!width) return <div ref={ref} className="tchart" style={{ height: h }} />;
  return (
    <div ref={ref} className="tchart" style={{ height: h }}>
      <svg width={width} height={h} role="img" aria-label={props.ariaLabel} onPointerMove={onMove} onPointerLeave={() => setHover(null)}
        tabIndex={0} onFocus={() => times.length && setHover(times[times.length - 1]!)} onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (hover === null || !times.length) return;
          const i = times.indexOf(hover);
          if (e.key === 'ArrowLeft') { e.preventDefault(); setHover(times[Math.max(0, i - 1)]!); }
          if (e.key === 'ArrowRight') { e.preventDefault(); setHover(times[Math.min(times.length - 1, i + 1)]!); }
        }}>
        {!props.compact && ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={pad.l + iw} y1={Y(v)} y2={Y(v)} stroke={v === 0 ? AXIS : GRID} strokeWidth={1} />
            <text x={pad.l - 8} y={Y(v) + 3.5} fontSize={10.5} fill={MUTED} textAnchor="end" className="num">{props.yFormat(v)}</text>
          </g>
        ))}
        {!props.compact && (props.xTicks ?? []).map((x) => (
          <text key={x.t} x={X(x.t)} y={h - 6} fontSize={10.5} fill={MUTED} textAnchor="middle">{x.label}</text>
        ))}
        {props.compact && <line x1={pad.l} x2={pad.l + iw} y1={Y(0)} y2={Y(0)} stroke={AXIS} strokeWidth={1} />}
        {props.marker != null && props.marker > x0 && <line x1={X(props.marker)} x2={X(props.marker)} y1={pad.t} y2={pad.t + ih} stroke={ACCENT} strokeOpacity={0.5} strokeWidth={1} />}
        {props.series.map((s) => {
          const d = path(s.points);
          const valid = s.points.filter((p) => p.v !== null);
          const last = valid[valid.length - 1];
          return (
            <g key={s.id}>
              {props.area && d && valid.length > 1 && <path d={`${d}L${X(last!.t).toFixed(1)},${Y(0)}L${X(valid[0]!.t).toFixed(1)},${Y(0)}Z`} fill={s.color} fillOpacity={0.1} stroke="none" />}
              <path d={d} fill="none" stroke={s.color} strokeWidth={props.compact ? 1.6 : 2} strokeLinejoin="round" strokeLinecap="round" />
              {last && hover === null && <circle cx={X(last.t)} cy={Y(last.v!)} r={props.compact ? 3 : 4} fill={s.color} stroke="#12161b" strokeWidth={2} />}
            </g>
          );
        })}
        {hover !== null && (
          <g pointerEvents="none">
            <line x1={X(hover)} x2={X(hover)} y1={pad.t} y2={pad.t + ih} stroke="#a4adb9" strokeOpacity={0.5} strokeWidth={1} />
            {hv!.map(({ s, p }) => p && p.v !== null && <circle key={s.id} cx={X(hover)} cy={Y(p.v)} r={4} fill={s.color} stroke="#12161b" strokeWidth={2} />)}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="tip" style={{ left: Math.min(Math.max(X(hover) + 10, 0), Math.max(0, width - 150)), top: 0 }} role="status">
          <div className="tip-t">{props.xFormat(hover)}</div>
          {hv!.map(({ s, p }) => (
            <div key={s.id} className="tip-row">
              {props.series.length > 1 && <i style={{ background: s.color }} aria-hidden="true" />}
              <b>{p && p.v !== null ? props.yFormat(p.v) : '—'}</b>
              {props.series.length > 1 && <span>{s.label}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Horizontal bars, value at the tip; each bar is its own hover/focus target. */
export function BarList(props: { items: { id: string; label: string; value: number; display: string; sub?: string }[]; color?: string; ariaLabel: string; max?: number }) {
  const max = props.max ?? Math.max(1, ...props.items.map((i) => i.value));
  return (
    <ul className="barlist" aria-label={props.ariaLabel}>
      {props.items.map((i) => (
        <li key={i.id} tabIndex={0} title={`${i.label}: ${i.display}${i.sub ? ` (${i.sub})` : ''}`}>
          <span className="bl-label">{i.label}</span>
          <span className="bl-track"><span className="bl-bar" style={{ width: `${Math.max(1.5, (i.value / max) * 100)}%`, background: props.color ?? SERIES[0] }} /></span>
          <span className="bl-val num">{i.display}</span>
        </li>
      ))}
    </ul>
  );
}

/** Vertical columns with a 2px surface gap and rounded tops; hover shows the value. */
export function Columns(props: { bins: { label: string; value: number; display: string }[]; color?: string; height?: number; ariaLabel: string; labelEvery?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const h = props.height ?? 140; const padB = 20; const padT = 8;
  const n = Math.max(1, props.bins.length);
  const slot = width / n;
  const bw = Math.min(24, Math.max(2, slot - 2));
  const max = Math.max(1, ...props.bins.map((b) => b.value));
  const ih = h - padB - padT;
  const every = props.labelEvery ?? 1;
  if (!width) return <div ref={ref} className="tchart" style={{ height: h }} />;
  return (
    <div ref={ref} className="tchart" style={{ height: h }}>
      <svg width={width} height={h} role="img" aria-label={props.ariaLabel} onPointerLeave={() => setHover(null)}>
        <line x1={0} x2={width} y1={padT + ih} y2={padT + ih} stroke={AXIS} />
        {props.bins.map((b, i) => {
          const bh = (b.value / max) * ih;
          const x = i * slot + (slot - bw) / 2;
          const y = padT + ih - bh;
          const r = Math.min(4, bw / 2, bh);
          return (
            <g key={i} onPointerEnter={() => setHover(i)}>
              <rect x={i * slot} y={padT} width={slot} height={ih} fill="transparent" />
              {bh > 0 && <path d={`M${x},${padT + ih}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${padT + ih}Z`} fill={props.color ?? SERIES[0]} fillOpacity={hover === null || hover === i ? 1 : 0.55} />}
              {i % every === 0 && <text x={i * slot + slot / 2} y={h - 5} fontSize={10.5} fill={MUTED} textAnchor="middle">{b.label}</text>}
            </g>
          );
        })}
      </svg>
      {hover !== null && props.bins[hover] && (
        <div className="tip" style={{ left: Math.min(hover * slot + slot / 2 + 8, Math.max(0, width - 130)), top: 0 }} role="status">
          <div className="tip-t">{props.bins[hover].label}</div>
          <div className="tip-row"><b>{props.bins[hover].display}</b></div>
        </div>
      )}
    </div>
  );
}

export function LegendKeys(props: { items: { label: string; color: string }[] }) {
  return <div className="legend-keys">{props.items.map((i) => <span key={i.label}><i style={{ background: i.color }} aria-hidden="true" />{i.label}</span>)}</div>;
}

/** A chart card: title, optional headline value, chart, and a collapsible data table. */
export function ChartCard(props: { title: string; value?: ReactNode; sub?: ReactNode; children: ReactNode; table?: { head: string[]; rows: (string | number)[][] }; className?: string; actions?: ReactNode; testId?: string }) {
  const id = useId();
  return (
    <section className={`chart-card ${props.className ?? ''}`} aria-labelledby={id} data-testid={props.testId}>
      <header>
        <div>
          <h3 id={id}>{props.title}</h3>
          {props.sub && <div className="cc-sub">{props.sub}</div>}
        </div>
        {props.value !== undefined && <div className="cc-value">{props.value}</div>}
        {props.actions}
      </header>
      {props.children}
      {props.table && props.table.rows.length > 0 && (
        <details className="explain cc-table"><summary>Show data</summary>
          <div className="table-wrap"><table className="small"><thead><tr>{props.table.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{props.table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j ? 'num' : ''}>{c}</td>)}</tr>)}</tbody></table></div>
        </details>
      )}
    </section>
  );
}
