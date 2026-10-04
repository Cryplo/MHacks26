import type { MetricId, MetricSnapshot, RunView } from '../../../contract/behavior-v1';
import { revenueRateSeries } from '../../data/derived';
import { useLiveSelector } from '../../data/hooks';
import type { LiveStore } from '../../data/liveStore';
import { METRICS } from '../../domain/metrics';
import { Explain } from '../../ui/components';
import { EM_DASH, formatCents, formatCount, formatMetric, formatPercent, formatSimClock } from '../../ui/format';

function Tile(props: { id?: MetricId; label: string; value: string; sub?: string; explain?: string; testId?: string }) {
  return (
    <div className="stat" data-testid={props.testId}>
      <div className="label">{props.label}{props.explain && <Explain label={props.label}>{props.explain}</Explain>}</div>
      <div className="value">{props.value}</div>
      {props.sub && <div className="sub">{props.sub}</div>}
    </div>
  );
}

export function StatsPanel(props: { store: LiveStore; openLocal: string; isFixture: boolean }) {
  const m = useLiveSelector(props.store, (s) => s.metrics);
  const run = useLiveSelector(props.store, (s) => s.run);
  const history = useLiveSelector(props.store, (s) => s.metricHistory);
  if (!m || !run) return <p className="muted">No metrics yet.</p>;
  const def = (id: MetricId) => `${METRICS[id].definition} Denominator: ${METRICS[id].denominator}`;
  const v = (id: MetricId) => formatMetric(m.measures[id]);
  const sat = m.measures.satisfaction_0_100;
  return (
    <div className="stack" data-testid="stats-panel">
      <p className="small muted">Engine metrics as of {formatSimClock(m.simMs, props.openLocal)} (definition {m.definitionVersion}){props.isFixture ? ' — fixture values from a scripted scene' : ''}.</p>
      <div className="stat-grid">
        <Tile label="Admitted guests" value={formatCount(m.admittedGuests)} sub="entered the park so far" testId="stat-admitted" />
        <Tile label="In park now" value={formatCount(m.guestsInPark)} sub="current occupancy (not the revenue denominator)" testId="stat-inpark" />
        <Tile label="Net ancillary revenue" value={v('net_revenue_cents')} explain={def('net_revenue_cents')} sub="excludes admission; not profit" testId="stat-revenue" />
        <Tile label="Revenue / admitted guest" value={v('revenue_per_guest_cents')} explain={def('revenue_per_guest_cents')} />
        <Tile label="Queue minutes / guest" value={v('queue_minutes_per_guest')} explain={def('queue_minutes_per_guest')} sub="all queued time incl. abandoned" />
        <Tile label="Wait per completed ride" value={v('completed_ride_wait_minutes')} explain={def('completed_ride_wait_minutes')} />
        <Tile label="Rides / guest" value={v('rides_per_guest')} explain={def('rides_per_guest')} />
        <Tile label="Early departures" value={v('early_departures')} explain={def('early_departures')} />
        <Tile label="Abandonment" value={v('abandonment_rate')} explain={def('abandonment_rate')} />
        <Tile label="Satisfaction" value={v('satisfaction_0_100')} explain={def('satisfaction_0_100')}
          sub={sat.value === null ? (sat.missingReason ?? 'not yet available') : `coverage ${formatPercent(sat.coverage, 0)} (n=${sat.n}); ${sat.complete ? 'final' : 'partial, run in progress'}`} testId="stat-satisfaction" />
      </div>
      <InferenceHealth run={run} />
      <RevenueChart history={history} openLocal={props.openLocal} />
    </div>
  );
}

function InferenceHealth(props: { run: RunView }) {
  const q = props.run.quality;
  const c = q.behaviorCounts;
  return (
    <div className="stat">
      <div className="label">Decision sources (count of applied distributions)<Explain label="decision sources">Jev = live model; cache = a cached distribution (not a copied action); mock = deterministic mock provider; fallback = declared live-timeout fallback (not Jev evidence).</Explain></div>
      <div className="small mono">jev {c.jev} · cache {c.cache} · mock {c.mock} · fallback {c.fallback}</div>
      <div className="small muted">invalid attempts {q.invalidAttempts} · stale {q.staleAttempts} · pending ratings {q.pendingRatings} · terminal ratings {q.terminalRatingsComplete}/{q.terminalRatingsExpected}</div>
    </div>
  );
}

export function RevenueChart(props: { history: readonly MetricSnapshot[]; openLocal: string }) {
  const series = revenueRateSeries(props.history, 10 * 60_000);
  if (series.length === 0) return <div className="stat"><div className="label">Revenue per simulated hour</div><p className="small muted">Needs at least two metric snapshots.</p></div>;
  const max = Math.max(1, ...series.map((p) => Math.abs(p.centsPerHour ?? 0)));
  const W = 300; const H = 90; const bw = W / series.length;
  return (
    <figure className="stat" style={{ margin: 0 }}>
      <figcaption className="label">Net revenue per simulated hour, by interval<Explain label="revenue rate">Change in Engine's net ancillary revenue between snapshots divided by the actual simulated duration of each interval (~10 min). Not affected by playback speed. Bars are not smoothed.</Explain></figcaption>
      <svg viewBox={`0 0 ${W} ${H + 14}`} width="100%" role="img" aria-label={`Revenue rate, latest ${formatCents(series[series.length - 1]!.centsPerHour)} per hour`}>
        <line x1={0} x2={W} y1={H} y2={H} stroke="#999" />
        {series.map((p, i) => {
          const h = p.centsPerHour === null ? 0 : (Math.abs(p.centsPerHour) / max) * (H - 4);
          return <rect key={p.toMs} x={i * bw + 1} width={Math.max(1, bw - 2)} y={p.centsPerHour !== null && p.centsPerHour < 0 ? H : H - h} height={h} fill={p.centsPerHour !== null && p.centsPerHour < 0 ? '#9b2a1f' : '#13202e'} />;
        })}
        <text x={0} y={H + 12} fontSize="9" fill="#555">{formatSimClock(series[0]!.fromMs, props.openLocal)}</text>
        <text x={W} y={H + 12} fontSize="9" fill="#555" textAnchor="end">{formatSimClock(series[series.length - 1]!.toMs, props.openLocal)}</text>
      </svg>
      <details className="explain"><summary>Data table</summary>
        <table className="small"><thead><tr><th>Interval</th><th className="num">$/sim-hour</th></tr></thead>
          <tbody>{series.map((p) => <tr key={p.toMs}><td>{formatSimClock(p.fromMs, props.openLocal)}–{formatSimClock(p.toMs, props.openLocal)}</td><td className="num">{p.centsPerHour === null ? EM_DASH : formatCents(p.centsPerHour)}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}
