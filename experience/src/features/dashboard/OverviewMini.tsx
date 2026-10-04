import type { ParkBundle, RunManifest } from '../../../contract/behavior-v1';
import type { RunHistory } from '../../data/history';
import { useLiveSelector } from '../../data/hooks';
import type { LiveStore } from '../../data/liveStore';
import { EM_DASH, formatCents, formatCount, formatMetric, formatNumber, formatSimClock } from '../../ui/format';
import { Icon } from '../../ui/components';
import { ACCENT, SERIES, TimeChart } from './charts';
import { useSeries } from './Dashboard';
import { metricPoints, occupancyPoints, peak, perInterval } from './series';

/** Compact live view of the dashboard for the side panel, with a way into the full view. */
export function OverviewMini(props: { store: LiveStore; park: ParkBundle; manifest: RunManifest; history: RunHistory; viewMs: number; onExpand: () => void }) {
  const H = Math.min(props.manifest.config.horizonMs, Math.max(props.viewMs, 30 * 60_000));
  const clock = (t: number) => formatSimClock(t, props.park.openLocal);
  const series = useSeries(props.history, props.store, props.viewMs);
  const m = series[series.length - 1] ?? null;
  const queues = useLiveSelector(props.store, (s) => s.queues);
  const places = useLiveSelector(props.store, (s) => s.places);
  const occ = occupancyPoints(series);
  const occPeak = peak(occ);
  const sat = metricPoints(series, 'satisfaction_0_100');
  const rate = perInterval(series, 'net_revenue_cents', 15 * 60_000, props.viewMs);
  const lastRate = rate.length >= 2 ? rate[rate.length - 2]! : rate[rate.length - 1];
  const top = props.park.places
    .filter((p) => p.kind === 'ride' || p.kind === 'show' || p.kind === 'food')
    .map((p) => { const q = queues.get(p.id); return { p, n: q ? q.standardPersons + q.passPersons : 0, waitMs: places.get(p.id)?.predictedWaitMs ?? null, closed: places.get(p.id)?.closed ?? false }; })
    .sort((a, b) => b.n - a.n).slice(0, 5);
  const topMax = Math.max(1, ...top.map((t) => t.n));
  const satNow = m?.measures.satisfaction_0_100;
  return (
    <div className="stack" style={{ gap: 16 }} data-testid="stats-panel">
      <div className="mini-card">
        <div className="spread"><span className="k">Guests in park</span>{occPeak && <span className="tiny faint">peak {formatCount(occPeak.v)}</span>}</div>
        <div className="mini-value">{m ? formatCount(m.guestsInPark) : EM_DASH}<span className="tiny faint"> of {m ? formatCount(m.admittedGuests) : EM_DASH} admitted</span></div>
        <TimeChart compact area height={52} series={[{ id: 'o', label: 'Guests in park', color: SERIES[0], points: occ }]} xDomain={[0, H]} yFormat={(x) => formatCount(x)} xFormat={clock} ariaLabel="Guests in park over time" />
      </div>
      <div className="mini-row">
        <div className="mini-card">
          <span className="k">Revenue</span>
          <div className="mini-value">{m ? formatMetric(m.measures.net_revenue_cents) : EM_DASH}</div>
          <span className="tiny faint">{lastRate ? `${formatCents(lastRate.v * 4)}/hour lately` : 'no sales yet'}</span>
        </div>
        <div className="mini-card">
          <span className="k">Satisfaction</span>
          <div className="mini-value">{satNow?.value != null ? formatNumber(satNow.value, 1) : EM_DASH}</div>
          {sat.filter((p) => p.v !== null).length > 1
            ? <TimeChart compact height={28} series={[{ id: 's', label: 'Satisfaction', color: ACCENT, points: sat }]} xDomain={[0, H]} yMax={100} yFormat={(x) => formatNumber(x, 1)} xFormat={clock} ariaLabel="Satisfaction trend" />
            : <span className="tiny faint">not rated yet</span>}
        </div>
      </div>
      <section className="side-section" aria-label="Longest lines now">
        <h3>Longest lines now</h3>
        <ul className="barlist" data-testid="top-queues">
          {top.map((t) => (
            <li key={t.p.id} tabIndex={0} title={`${t.p.name}: ${t.n} in line${t.waitMs ? `, about ${Math.round(t.waitMs / 60_000)} min` : ''}`}>
              <span className="bl-label">{t.p.name}{t.closed ? ' · closed' : ''}</span>
              <span className="bl-track"><span className="bl-bar" style={{ width: `${Math.max(1.5, (t.n / topMax) * 100)}%`, background: SERIES[1] }} /></span>
              <span className="bl-val num">{t.n}{t.waitMs ? <span className="faint"> · {Math.round(t.waitMs / 60_000)}m</span> : null}</span>
            </li>
          ))}
        </ul>
      </section>
      <button type="button" className="btn block" onClick={props.onExpand} data-testid="expand-dashboard"><Icon name="chart" />Open full dashboard</button>
    </div>
  );
}
