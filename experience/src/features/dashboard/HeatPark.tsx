import { useEffect, useMemo, useState } from 'react';
import type { Heatmap, HeatLayer, Id, ParkBundle } from '../../../contract/behavior-v1';
import { useLiveSelector } from '../../data/hooks';
import type { LiveStore } from '../../data/liveStore';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { formatCents, formatNumber } from '../../ui/format';
import { topCells } from '../results/heat';
import { ParkPreview, toParkCells } from './ParkPreview';

export type HeatKind = 'crowd' | HeatLayer;
export const HEAT_LAYERS: { id: HeatKind; label: string; unit: string }[] = [
  { id: 'crowd', label: 'Crowd now', unit: 'guests' },
  { id: 'waiting_person_minutes', label: 'Queue time', unit: 'person-min' },
  { id: 'spending_cents', label: 'Spending', unit: 'cents' },
  { id: 'early_departures', label: 'Early exits', unit: 'guests' },
  { id: 'negative_experience', label: 'Bad moments', unit: 'points' },
];

/** Crowd density (guests per 4 m cell) from agent positions in the store. */
function crowdGrid(park: ParkBundle, positions: { xM: number; yM: number }[], cellM = 4): Heatmap {
  const w = Math.ceil((park.grid.width * park.grid.cellM) / cellM); const h = Math.ceil((park.grid.height * park.grid.cellM) / cellM);
  const values = new Array<number>(w * h).fill(0);
  for (const p of positions) {
    const x = Math.floor(p.xM / cellM); const y = Math.floor(p.yM / cellM);
    if (x >= 0 && y >= 0 && x < w && y < h) values[y * w + x]! += 1;
  }
  return { runId: '', layer: 'waiting_person_minutes', fromMs: 0, toMs: 0, cellM, width: w, height: h, values, total: positions.length, unit: 'guests', denominator: '', complete: true };
}

export function useHeatmap(runId: Id, layer: HeatLayer, toMs: number, enabled: boolean) {
  const rt = useRuntime();
  const [h, setH] = useState<Heatmap | null>(null);
  const bucket = Math.floor(toMs / 120_000); // refresh every ~2 simulated minutes
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    rt.client.query('getHeatmap', { runId, layer, fromMs: 0, toMs }).then((x) => { if (live) setH(x); }, () => undefined);
    return () => { live = false; };
  }, [rt.client, runId, layer, bucket, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return h && h.layer === layer ? h : null;
}

export function HeatPark(props: { runId: Id; park: ParkBundle; codes: Uint8Array; store: LiveStore; toMs: number; layer: HeatKind; bumpEnabled: boolean }) {
  const agents = useLiveSelector(props.store, (s) => s.agents);
  const server = useHeatmap(props.runId, props.layer === 'crowd' ? 'waiting_person_minutes' : props.layer, props.toMs, props.layer !== 'crowd');
  const heat = useMemo(() => props.layer === 'crowd'
    ? crowdGrid(props.park, [...agents.values()].filter((a) => a.state !== 'not_arrived' && a.state !== 'left').map((a) => a.position))
    : server, [props.layer, props.park, agents, server]);
  const max = heat ? Math.max(0, ...heat.values) : 0;
  const cells = useMemo(() => (heat ? toParkCells(heat, props.park) : null), [heat, props.park]);
  const info = HEAT_LAYERS.find((l) => l.id === props.layer)!;
  const fmt = (v: number) => (info.unit === 'cents' ? formatCents(v) : `${formatNumber(v, v < 10 ? 1 : 0)} ${info.unit}`);
  const tops = heat && props.layer !== 'crowd' ? topCells(heat, props.park, 3) : [];
  const disabled = props.layer === 'bump_episodes' && !props.bumpEnabled;
  return (
    <div className="heatpark" data-testid="heat-view">
      <ParkPreview park={props.park} codes={props.codes} heat={cells ?? { cells: [] }} className="heat-iso" height={380} label={`${info.label} across the park${heat ? `, total ${fmt(heat.total)}` : ''}`} />
      <div className="heat-legend" data-testid="heat-legend">
        <span className="faint tiny">Less</span>
        <span className="ramp" aria-hidden="true" />
        <span className="faint tiny">More</span>
        <span className="tiny muted" style={{ marginLeft: 'auto' }}>{disabled ? 'Not enabled in this run' : heat ? `Peak cell ${fmt(max)} · total ${fmt(heat.total)}` : 'Loading…'}</span>
      </div>
      {tops.length > 0 && (
        <ol className="hot-list">
          {tops.map((t) => <li key={t.index}><span>{t.nearestPlace ?? 'Open walkway'}</span><b className="num">{fmt(t.value)}</b></li>)}
        </ol>
      )}
    </div>
  );
}
