import { useMemo, useState } from 'react';
import type { Id, MetricId, MetricSnapshot, ParkBundle, RunManifest } from '../../../contract/behavior-v1';
import type { RunHistory } from '../../data/history';
import { useLiveSelector } from '../../data/hooks';
import type { LiveStore } from '../../data/liveStore';
import { METRICS } from '../../domain/metrics';
import { EM_DASH, formatCents, formatCount, formatMetric, formatNumber, formatSimClock } from '../../ui/format';
import { shortClock } from '../live/Timeline';
import { ACCENT, BarList, ChartCard, Columns, compact, LegendKeys, SERIES, TimeChart, type Series } from './charts';
import { HEAT_LAYERS, HeatPark, useHeatmap, type HeatKind } from './HeatPark';
import { activityMix, breakdownQueuePoints, byNearestPlace, downsample, hasBreakdown, hourTicks, levelBins, metricPoints, occupancyPoints, peak, perInterval, placeQueuePoints, placeTotals, ratingBins } from './series';
import { STATE_STYLE, hex } from '../../renderer/colors';

export type DashboardProps = {
  runId: Id; park: ParkBundle; codes: Uint8Array; manifest: RunManifest; store: LiveStore;
  history: RunHistory; viewMs: number;
};

/** Engine's recorded snapshots up to `viewMs`, plus the store's current snapshot as the last point. */
export function useSeries(history: RunHistory, store: LiveStore, viewMs: number): MetricSnapshot[] {
  const current = useLiveSelector(store, (s) => s.metrics);
  return useMemo(() => {
    const past = history.metrics.filter((m) => m.simMs <= viewMs);
    if (current && current.simMs <= viewMs + 1 && (!past.length || current.simMs > past[past.length - 1]!.simMs)) past.push(current);
    return downsample(past, 140);
  }, [history.metrics, current, viewMs]);
}

const minutes = (v: number) => `${v === 0 ? 0 : formatNumber(v, v < 10 ? 1 : 0)} min`;
const money = (v: number) => (Math.abs(v) >= 100_000 ? `$${compact(v / 100)}` : formatCents(v).replace(/\.00$/, ''));

function Tile(props: { label: string; value: string; sub?: string; points: { t: number; v: number | null }[]; xDomain: [number, number]; format: (v: number) => string; clock: (t: number) => string; testId?: string }) {
  return (
    <div className="kpi-card" data-testid={props.testId}>
      <div className="k">{props.label}</div>
      <div className="value">{props.value}</div>
      {props.sub && <div className="sub">{props.sub}</div>}
      <div className="spark">
        {props.points.filter((p) => p.v !== null).length > 1
          ? <TimeChart compact area height={40} series={[{ id: 's', label: props.label, color: ACCENT, points: props.points }]} xDomain={props.xDomain} yFormat={props.format} xFormat={props.clock} ariaLabel={`${props.label} trend`} />
          : <div className="spark-empty" />}
      </div>
    </div>
  );
}

export function Dashboard(props: DashboardProps) {
  const { park, manifest } = props;
  const H = manifest.config.horizonMs;
  const xDomain: [number, number] = [0, H];
  // Sparklines span the elapsed part of the day so early trends are readable.
  const sparkDomain: [number, number] = [0, Math.min(H, Math.max(props.viewMs, 30 * 60_000))];
  const clock = (t: number) => formatSimClock(t, park.openLocal);
  const xTicks = hourTicks(H, park.openLocal, (t) => shortClock(t, park.openLocal));
  const series = useSeries(props.history, props.store, props.viewMs);
  const m = series[series.length - 1] ?? null;
  const agents = useLiveSelector(props.store, (s) => s.agents);
  const samples = props.history.samples.filter((s) => s.atMs <= props.viewMs);
  const attractions = park.places.filter((p) => p.kind === 'ride' || p.kind === 'show');
  const [layer, setLayer] = useState<HeatKind>('crowd');
  const spending = useHeatmap(props.runId, 'spending_cents', props.viewMs, true);
  const waiting = useHeatmap(props.runId, 'waiting_person_minutes', props.viewMs, true);

  const occ = occupancyPoints(series);
  const occPeak = peak(occ);
  const rev = metricPoints(series, 'net_revenue_cents');
  const wait = metricPoints(series, 'completed_ride_wait_minutes');
  const sat = metricPoints(series, 'satisfaction_0_100');
  const rides = metricPoints(series, 'rides_per_guest');
  const early = metricPoints(series, 'early_departures');
  const bucket = H > 4 * 3600_000 ? 30 * 60_000 : 15 * 60_000;
  const revBins = perInterval(series, 'net_revenue_cents', bucket, props.viewMs);
  const earlyBins = perInterval(series, 'early_departures', bucket, props.viewMs);
  const v = (id: MetricId) => (m ? formatMetric(m.measures[id]) : EM_DASH);
  const satNow = m?.measures.satisfaction_0_100;

  // Queue length per attraction: shared y-scale so the small multiples compare honestly.
  // Busiest first; with a big park show the top few and let the reader expand.
  const fromBreakdown = hasBreakdown(series);
  const queueSeries = attractions.map((p) => ({ place: p, points: fromBreakdown ? breakdownQueuePoints(series, p.id) : placeQueuePoints(samples, p.id) }))
    .map((q) => ({ ...q, peakV: peak(q.points)?.v ?? 0, color: SERIES[0] as string }))
    .sort((a, b) => b.peakV - a.peakV || a.place.name.localeCompare(b.place.name));
  const [allQueues, setAllQueues] = useState(false);
  const [allRevenue, setAllRevenue] = useState(false);
  const [allWaiting, setAllWaiting] = useState(false);
  const queueMax = Math.max(1, ...queueSeries.flatMap((q) => q.points.map((p) => p.v ?? 0)));
  const queuesNow = useLiveSelector(props.store, (s) => s.queues);
  const placesNow = useLiveSelector(props.store, (s) => s.places);
  const totals = placeTotals(m, park);
  const revByPlace = totals.length
    ? totals.filter((t) => t.revenue > 0).map((t) => ({ id: t.id, name: t.name, value: t.revenue })).sort((a, b) => b.value - a.value)
    : spending ? byNearestPlace(spending, park, ['food', 'shop', 'ride', 'show']) : [];
  const servedById = new Map(totals.map((t) => [t.id, t.served]));
  const mix = activityMix(m, agents.values());
  const mixTotal = mix.reduce((a, b) => a + b.value, 0);
  const waitByPlace = waiting ? byNearestPlace(waiting, park, ['ride', 'show']) : [];
  const bins = m?.breakdown ? levelBins(m.breakdown.satisfactionLevels) : ratingBins(agents.values());
  const rated = bins.reduce((a, b) => a + b.value, 0);
  const occSeries: Series[] = [{ id: 'occ', label: 'Guests in park', color: SERIES[0], points: occ }];

  return (
    <div className="dashboard" data-testid="dashboard">
      <div className="kpi-cards">
        <Tile label="Guests in park" value={m ? formatCount(m.guestsInPark) : EM_DASH} sub={occPeak ? `peak ${formatCount(occPeak.v)} at ${clock(occPeak.t)}` : undefined} points={occ} xDomain={sparkDomain} format={(x) => formatCount(x)} clock={clock} testId="kpi-occupancy" />
        <Tile label="Revenue" value={v('net_revenue_cents')} sub={m ? `${formatCount(m.admittedGuests)} admitted` : undefined} points={rev} xDomain={sparkDomain} format={money} clock={clock} testId="kpi-revenue" />
        <Tile label="Avg ride wait" value={v('completed_ride_wait_minutes')} sub="per completed ride" points={wait} xDomain={sparkDomain} format={minutes} clock={clock} />
        <Tile label="Satisfaction" value={satNow?.value != null ? formatNumber(satNow.value, 1) : EM_DASH} sub={satNow?.value != null ? 'out of 100' : 'not rated yet'} points={sat} xDomain={sparkDomain} format={(x) => formatNumber(x, 1)} clock={clock} />
        <Tile label="Rides per guest" value={v('rides_per_guest')} points={rides} xDomain={sparkDomain} format={(x) => formatNumber(x, 2)} clock={clock} />
        <Tile label="Early departures" value={v('early_departures')} sub="left before planned" points={early} xDomain={sparkDomain} format={(x) => formatCount(x)} clock={clock} />
      </div>

      <div className="dash-grid">
        <ChartCard className="span-8" title="Guests in the park" sub="Across the day" value={m ? formatCount(m.guestsInPark) : undefined} testId="chart-occupancy"
          table={{ head: ['Time', 'Guests'], rows: occ.filter((_, i) => i % 6 === 0).map((p) => [clock(p.t), formatCount(p.v ?? 0)]) }}>
          <TimeChart area series={occSeries} height={200} xDomain={xDomain} xTicks={xTicks} yFormat={(x) => compact(x)} xFormat={clock} ariaLabel="Guests in park over time" marker={props.viewMs} />
        </ChartCard>
        <ChartCard className="span-4" title="Satisfaction ratings" sub={rated ? `Latest rating of ${formatCount(rated)} guests` : 'No ratings yet'} testId="chart-ratings"
          table={{ head: ['Rating', 'Guests'], rows: bins.map((b) => [b.label, b.value]) }}>
          {rated ? <Columns bins={bins.map((b) => ({ ...b, display: `${formatCount(b.value)} guests` }))} height={200} color={SERIES[2]} ariaLabel="Distribution of latest satisfaction ratings" />
            : <div className="chart-empty">Guests are rated periodically and when they leave; the distribution appears with the first ratings.</div>}
        </ChartCard>

        <ChartCard className="span-12" title="Queue length by attraction" sub="People in line, sampled across the day (same scale)" testId="chart-queues"
          table={{ head: ['Attraction', 'Now', 'Peak', 'Peak time'], rows: queueSeries.map((q) => { const pk = peak(q.points); return [q.place.name, queuesNow.get(q.place.id) ? (queuesNow.get(q.place.id)!.standardPersons + queuesNow.get(q.place.id)!.passPersons) : 0, pk?.v ?? 0, pk ? clock(pk.t) : EM_DASH]; }) }}>
          <div className="multiples">
            {queueSeries.slice(0, allQueues ? undefined : 8).map((q) => {
              const pk = peak(q.points);
              const now = queuesNow.get(q.place.id);
              const waitNow = placesNow.get(q.place.id)?.predictedWaitMs ?? null;
              return (
                <div key={q.place.id} className="multiple">
                  <div className="mh"><b>{q.place.name}</b>{placesNow.get(q.place.id)?.closed && <span className="badge warn plain">Closed</span>}</div>
                  <div className="mv"><span className="num">{now ? now.standardPersons + now.passPersons : 0}</span> in line{waitNow ? <span className="faint"> · ~{Math.round(waitNow / 60_000)} min</span> : null}</div>
                  <TimeChart compact area height={56} series={[{ id: q.place.id, label: q.place.name, color: q.color, points: q.points }]} yMax={queueMax} xDomain={xDomain} yFormat={(x) => `${Math.round(x)} in line`} xFormat={clock} ariaLabel={`${q.place.name} queue length`} />
                  <div className="tiny faint">{pk && pk.v > 0 ? `Peak ${pk.v} at ${clock(pk.t)}` : 'No queue yet'}{servedById.get(q.place.id) ? ` · ${formatCount(servedById.get(q.place.id)!)} served` : ''}</div>
                </div>
              );
            })}
          </div>
          {queueSeries.length > 8 && <div><button type="button" className="link-btn small" onClick={() => setAllQueues((x) => !x)} data-testid="queues-show-all">{allQueues ? 'Show busiest 8' : `Show all ${queueSeries.length} attractions`}</button></div>}
        </ChartCard>

        <ChartCard className="span-7" title="Revenue over the day" sub={`Per ${bucket / 60_000} minutes`} value={v('net_revenue_cents')} testId="chart-revenue"
          table={{ head: ['From', 'Revenue'], rows: revBins.map((b) => [clock(b.t), formatCents(b.v)]) }}>
          <Columns bins={revBins.map((b) => ({ label: shortClock(b.t, park.openLocal), value: b.v, display: formatCents(b.v) }))} height={190} color={SERIES[0]} ariaLabel="Revenue per interval" labelEvery={Math.ceil(revBins.length / 8)} />
        </ChartCard>
        <ChartCard className="span-5" title="Revenue by place" sub="Sales at each point of sale so far" testId="chart-revenue-place"
          table={{ head: ['Place', 'Revenue'], rows: revByPlace.map((r) => [r.name, formatCents(r.value)]) }}>
          {revByPlace.length ? <BarList ariaLabel="Revenue by place" items={revByPlace.slice(0, allRevenue ? undefined : 8).map((r) => ({ id: r.id, label: r.name, value: r.value, display: money(r.value) }))} /> : <p className="small muted">No sales yet.</p>}
          {revByPlace.length > 8 && <div><button type="button" className="link-btn small" onClick={() => setAllRevenue((x) => !x)}>{allRevenue ? 'Show top 8' : `Show all ${revByPlace.length}`}</button></div>}
        </ChartCard>

        <ChartCard className="span-7" title="Where it happens" sub="Across the park, opening until now"
          actions={<div className="seg" role="group" aria-label="Heat map layer">{HEAT_LAYERS.filter((l) => l.id !== 'bump_episodes').map((l) => <button key={l.id} type="button" aria-pressed={layer === l.id} onClick={() => setLayer(l.id)} data-testid={`heat-${l.id}`}>{l.label}</button>)}</div>}>
          <HeatPark runId={props.runId} park={park} codes={props.codes} store={props.store} toMs={props.viewMs} layer={layer} bumpEnabled={manifest.config.features.bumpReactions} />
        </ChartCard>
        <div className="span-5 dash-col">
          <ChartCard title="Time spent waiting" sub="Person-minutes in line by attraction" testId="chart-waiting"
            table={{ head: ['Attraction', 'Person-minutes'], rows: waitByPlace.map((r) => [r.name, Math.round(r.value)]) }}>
            {waitByPlace.length ? <BarList ariaLabel="Waiting time by attraction" color={SERIES[1]} items={waitByPlace.slice(0, allWaiting ? undefined : 6).map((r) => ({ id: r.id, label: r.name, value: r.value, display: `${compact(r.value)} min` }))} /> : <p className="small muted">No queueing yet.</p>}
            {waitByPlace.length > 6 && <div><button type="button" className="link-btn small" onClick={() => setAllWaiting((x) => !x)}>{allWaiting ? 'Show top 6' : `Show all ${waitByPlace.length}`}</button></div>}
          </ChartCard>
          <ChartCard title="Early departures" sub={`Guests leaving before their plan, per ${bucket / 60_000} min`} value={v('early_departures')}
            table={{ head: ['From', 'Guests'], rows: earlyBins.map((b) => [clock(b.t), b.v]) }}>
            <Columns bins={earlyBins.map((b) => ({ label: shortClock(b.t, park.openLocal), value: b.v, display: `${formatCount(b.v)} guests` }))} height={120} color={SERIES[4]} ariaLabel="Early departures per interval" labelEvery={Math.ceil(earlyBins.length / 6)} />
          </ChartCard>
        </div>

        <ChartCard className="span-12" title="What guests are doing" sub={mixTotal ? `${formatCount(mixTotal)} guests in the park` : 'Nobody in the park'} testId="chart-activity"
          table={{ head: ['Activity', 'Guests'], rows: mix.map((x) => [x.label, x.value]) }}>
          <div className="mix-stack" role="img" aria-label={mix.map((x) => `${x.label} ${x.value}`).join(', ')}>
            {mix.map((x) => <span key={x.state} style={{ flex: x.value, background: hex(STATE_STYLE[x.state].color) }} title={`${x.label}: ${x.value}`} />)}
          </div>
          <div className="legend-keys">{mix.map((x) => <span key={x.state}><i className="sq" style={{ background: hex(STATE_STYLE[x.state].color) }} aria-hidden="true" />{x.label} <b className="num">{formatCount(x.value)}</b> <span className="faint">{mixTotal ? `${Math.round((100 * x.value) / mixTotal)}%` : ''}</span></span>)}</div>
        </ChartCard>

        <ChartCard className="span-6" title="Satisfaction over the day" sub="Mean of final ratings so far (0–100)">
          <TimeChart series={[{ id: 'sat', label: 'Satisfaction', color: SERIES[2], points: sat }]} height={170} xDomain={xDomain} xTicks={xTicks} yMax={100} yFormat={(x) => formatNumber(x, 0)} xFormat={clock} ariaLabel="Satisfaction over time" />
        </ChartCard>
        <ChartCard className="span-6" title="Waiting and riding" sub="Minutes per guest vs. average wait per ride">
          <LegendKeys items={[{ label: 'Queue minutes per guest', color: SERIES[1] }, { label: 'Wait per completed ride', color: SERIES[0] }]} />
          <TimeChart series={[{ id: 'q', label: 'Queue minutes per guest', color: SERIES[1], points: metricPoints(series, 'queue_minutes_per_guest') }, { id: 'w', label: 'Wait per completed ride', color: SERIES[0], points: wait }]}
            height={150} xDomain={xDomain} xTicks={xTicks} yFormat={minutes} xFormat={clock} ariaLabel="Queue minutes per guest and wait per completed ride over time" />
        </ChartCard>
      </div>
      <details className="disclosure">
        <summary>How these numbers are defined</summary>
        <div className="body">
          <dl className="kv">{(['net_revenue_cents', 'completed_ride_wait_minutes', 'queue_minutes_per_guest', 'satisfaction_0_100', 'rides_per_guest', 'early_departures'] as MetricId[]).map((id) => (
            <div key={id} style={{ display: 'contents' }}><dt>{METRICS[id].short}</dt><dd className="small muted">{METRICS[id].definition}</dd></div>
          ))}</dl>
          <p className="note">Queue lengths, revenue by place and activity come from Engine's metric snapshots; time spent waiting groups heat-map cells by the nearest place. Synthetic guests; not calibrated to real visitors.</p>
        </div>
      </details>
    </div>
  );
}
