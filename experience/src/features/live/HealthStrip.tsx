import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import type { DomainError, Id, RunManifest } from '../../../contract/behavior-v1';
import { useLiveSelector } from '../../data/hooks';
import type { LiveStore } from '../../data/liveStore';
import { displayModes } from '../../runtime/mode';
import { useRuntime } from '../../runtime/RuntimeProvider';
import type { CommandName, CommandOutcome, CommandRunner } from '../../runtime/commands';
import { BrandMark, ErrorBox, FixtureChip, Icon, KV, Menu, ModeBadges } from '../../ui/components';
import { EM_DASH, formatAge, formatCount, formatMetric, formatPercent, formatSimClock, formatSimOffset } from '../../ui/format';
import { RunStatusBadge } from './RunStatusBadge';

export const SPEEDS = [1, 5, 20, 60];

export type RunControls = ReturnType<typeof useRunControls>;

/** All run commands in one place; outcomes surface as one error, retried with the same command ID. */
export function useRunControls(store: LiveStore, runId: Id) {
  const rt = useRuntime();
  const run = useLiveSelector(store, (s) => s.run);
  const pending = useRunnerPending(rt.runner);
  const [error, setError] = useState<{ error: DomainError; transport: boolean; retry?: () => void } | null>(null);
  const send = async (p: Promise<CommandOutcome<CommandName>>, retry: () => void) => {
    setError(null);
    const out = await p;
    if (out.kind === 'rejected') setError({ error: out.error, transport: false });
    if (out.kind === 'transport') setError({ error: out.error, transport: true, retry });
  };
  const cr = run?.controlRevision ?? 0;
  const start = () => void send(rt.runner.run('startRun', { runId }, `start:${runId}`, { durable: true }), start);
  const pause = () => void send(rt.runner.run('pauseRun', { runId, expectedControlRevision: cr }, `pause:${runId}:${cr}`), pause);
  const resume = () => void send(rt.runner.run('resumeRun', { runId, expectedControlRevision: cr }, `resume:${runId}:${cr}`), resume);
  const cancel = () => void send(rt.runner.run('cancelRun', { runId, expectedControlRevision: cr }, `cancel:${runId}:${cr}`), cancel);
  const speed = (v: number) => void send(rt.runner.run('setSpeed', { runId, requestedSpeed: v, expectedControlRevision: cr }, `speed:${runId}:${cr}:${v}`), () => speed(v));
  const startPending = pending.some((p) => p.intentKey === `start:${runId}` && p.state !== 'transport_failed');
  const ctlPending = pending.some((p) => p.intentKey.endsWith(`:${runId}:${cr}`) || p.intentKey.startsWith(`speed:${runId}:${cr}`));
  const terminal = run ? run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed' : false;
  return { run, start, pause, resume, cancel, speed, startPending, ctlPending, terminal, error, clearError: () => setError(null) };
}

export type PanelView = 'overview' | 'whatif' | 'share' | 'dashboard';

export type Scrub = {
  scrubbing: boolean; viewMs: number; playing: boolean; speed: number; terminal: boolean;
  onPlay: () => void; onSpeed: (s: number) => void;
};

export function RunBar(props: {
  store: LiveStore; viewStore: LiveStore; runId: Id; manifest: RunManifest; openLocal: string; canOperate: boolean; controls: RunControls;
  scrub: Scrub; timeline: React.ReactNode; onOpen: (v: PanelView) => void; onCancelRequest: () => void;
}) {
  const rt = useRuntime();
  const c = props.controls;
  const run = c.run;
  const metrics = useLiveSelector(props.viewStore, (s) => s.metrics);
  const conn = useLiveSelector(props.store, (s) => s.status);
  const stale = useLiveSelector(props.store, (s) => s.stale);
  const runPath = `/runs/${encodeURIComponent(props.runId)}`;
  const editable = !props.manifest.experiment;
  const connText = stale ? 'resyncing (frozen)' : conn;
  const sc = props.scrub;
  const recorded = sc.scrubbing || sc.terminal;
  // Data source shown only when it matters to a reader: real Jev, or degraded decisions.
  const modes = displayModes({ profile: rt.settings.profile, run, quality: run?.quality });
  return (
    <header className="runbar" data-testid="health-strip" aria-label="Run controls">
      <div className="runbar-row">
        <Link to="/" className="brand" aria-label="All simulations"><BrandMark /></Link>
        <div className="run-title"><b title={props.manifest.scenario.label}>{props.manifest.scenario.label}</b></div>
        {sc.scrubbing
          ? <span className={`badge ${sc.playing ? 'ok' : ''}`} data-testid="replay-badge" title="Showing a recorded moment; the live run keeps going. Use Back to live to rejoin.">{sc.playing ? 'Replaying' : 'Replay paused'}</span>
          : run && <RunStatusBadge status={run.status} />}
        <span className="sep" aria-hidden="true" />
        <div className="transport">
          {recorded
            ? <button type="button" className={`btn play ${sc.playing ? '' : 'primary'}`} onClick={sc.onPlay} aria-label={sc.playing ? 'Pause playback' : 'Play recording'} data-testid="play-pause"><Icon name={sc.playing ? 'pause' : 'play'} /></button>
            : props.canOperate && run && <PlayButton c={c} />}
          <span className="clock" data-testid="sim-clock" title={run ? `${formatSimOffset(sc.viewMs)} since opening` : undefined}>{run ? formatSimClock(sc.viewMs, props.openLocal, true) : EM_DASH}</span>
          {recorded ? (
            <div className="seg" role="group" aria-label="Playback speed">
              {SPEEDS.map((s) => <button key={s} type="button" aria-pressed={sc.speed === s} onClick={() => sc.onSpeed(s)} aria-label={`Playback ${s}x`} data-testid={`speed-${s}`}>{s}×</button>)}
            </div>
          ) : props.canOperate && run && !c.terminal && run.status !== 'preparing' && run.status !== 'ready' && (
            <div className="seg" role="group" aria-label="Simulation speed" title={`Achieved ${run.achievedSpeed}x`}>
              {SPEEDS.map((s) => (
                <button key={s} type="button" aria-pressed={run.requestedSpeed === s} disabled={c.ctlPending} onClick={() => c.speed(s)} aria-label={`Speed ${s}x`} data-testid={`speed-${s}`}>{s}×</button>
              ))}
            </div>
          )}
        </div>
        <div className="kpis" aria-label="Headline metrics">
          <Kpi label="In park" value={metrics ? formatCount(metrics.guestsInPark) : EM_DASH} testId="stat-inpark" />
          <Kpi label="Avg ride wait" value={metrics ? formatMetric(metrics.measures.completed_ride_wait_minutes) : EM_DASH} testId="stat-wait" />
          <Kpi label="Revenue" value={metrics ? formatMetric(metrics.measures.net_revenue_cents) : EM_DASH} testId="stat-revenue" />
          <Kpi label="Satisfaction" value={metrics?.measures.satisfaction_0_100.value != null ? formatMetric(metrics.measures.satisfaction_0_100).replace(' / 100', '') : EM_DASH} testId="stat-satisfaction" optional />
        </div>
        <div className="runbar-right">
          {modes.includes('Live Jev') && <span className="badge plain" title="Guest decisions come from the Jev behavior model">Jev</span>}
          {modes.includes('Degraded') && <span className="badge warn" title="Some decisions used the timeout fallback instead of Jev">Degraded</span>}
          <FixtureChip />
          {conn !== 'live' || stale ? <span className="conn" title="Connection to the live run"><span className={`dot ${stale ? 'warn' : conn === 'error' ? 'bad' : 'warn'}`} aria-hidden="true" />{connText}</span> : null}
          <span className="sr-only" data-testid="connection">{connText}</span>
          {!props.canOperate && <span className="badge plain" data-testid="viewer-note" title="View-only access: run controls are not available to this session.">View only</span>}
          <Menu label="Run menu" testId="run-menu" triggerClassName="btn icon" trigger={<Icon name="more" />}>
            {(close) => (
              <>
                {props.canOperate && editable && <button type="button" role="menuitem" data-testid="menu-whatif" onClick={() => { close(); props.onOpen('whatif'); }}><Icon name="flask" />What if…</button>}
                {props.canOperate && <button type="button" role="menuitem" data-testid="menu-share" onClick={() => { close(); props.onOpen('share'); }}><Icon name="share" />Share</button>}
                <button type="button" role="menuitem" data-testid="menu-dashboard" onClick={() => { close(); props.onOpen('dashboard'); }}><Icon name="chart" />Dashboard</button>
                <Link role="menuitem" to={`${runPath}/results`} data-testid="menu-results"><Icon name="list" />Results page</Link>
                {props.canOperate && !c.terminal && run && run.status !== 'preparing' && (
                  <>
                    <div className="menu-sep" role="separator" />
                    <button type="button" role="menuitem" className="danger" data-testid="menu-cancel" onClick={() => { close(); props.onCancelRequest(); }}><Icon name="stop" />Cancel run…</button>
                  </>
                )}
              </>
            )}
          </Menu>
        </div>
      </div>
      {props.timeline}
    </header>
  );
}

function PlayButton(props: { c: RunControls }) {
  const { c } = props;
  const run = c.run!;
  if (run.status === 'preparing' || run.status === 'ready') {
    const reason = run.status === 'preparing' ? 'Engine is still preparing this run. Start becomes available when it is ready.' : c.startPending ? 'Starting…' : null;
    return (
      <button key="start" type="button" className="btn primary play" onClick={c.start} disabled={Boolean(reason) || c.startPending} aria-busy={c.startPending || undefined}
        aria-label="Start run" title={reason ?? 'Start run'} data-testid="start-run">
        {c.startPending || run.status === 'preparing' ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" />}
      </button>
    );
  }
  if (run.status === 'running' || run.status === 'blocked') {
    return <PauseButton key="pause" c={c} />;
  }
  if (run.status === 'paused') {
    return <button key="resume" type="button" className="btn primary play" onClick={c.resume} disabled={c.ctlPending} aria-label="Resume" title="Resume" data-testid="resume-run"><Icon name="play" /></button>;
  }
  return null;
}

/** Pause appears where Start was; ignore clicks for a moment so a double-click on Start does not pause. */
function PauseButton(props: { c: RunControls }) {
  const armed = useRef(false);
  useEffect(() => { const t = setTimeout(() => { armed.current = true; }, 600); return () => clearTimeout(t); }, []);
  return (
    <button type="button" className="btn play" onClick={() => { if (armed.current) props.c.pause(); }} disabled={props.c.ctlPending}
      aria-label="Pause" title="Pause" data-testid="pause-run"><Icon name="pause" /></button>
  );
}

function Kpi(props: { label: string; value: string; testId: string; optional?: boolean }) {
  return <div className={`kpi ${props.optional ? 'optional' : ''}`} data-testid={props.testId}><span className="k">{props.label}</span><span className="value">{props.value}</span></div>;
}

/** Infra and provenance detail for the run: available on demand, never in the main flow. */
export function RunHealth(props: { store: LiveStore; manifest: RunManifest }) {
  const rt = useRuntime();
  const run = useLiveSelector(props.store, (s) => s.run);
  const health = useLiveSelector(props.store, (s) => s.health);
  if (!run) return null;
  const q = run.quality;
  const c = q.behaviorCounts;
  const total = c.jev + c.cache + c.mock + c.fallback;
  return (
    <div className="stack" style={{ gap: 10 }} data-testid="run-health">
      <KV items={[
        ['Run', <span className="mono" key="id">{run.runId}</span>],
        ['Data source', <ModeBadges key="m" modes={displayModes({ profile: rt.settings.profile, run, quality: run.quality })} />],
        ['Revision', <span className="mono" key="r" data-testid="revision">{run.revision}</span>],
        ['Speed', `${run.requestedSpeed}x requested · ${run.achievedSpeed}x achieved`],
        ['Waiting on', `${run.blockedWorkIds.length} decision(s)`],
        ['Queued / leased work', health ? `${health.queuedWork} / ${health.leasedWork}` : EM_DASH],
        ['Oldest request', health ? formatAge(health.oldestRequestAgeMs) : EM_DASH],
        ['HTTP p95', health?.httpP95Ms != null ? `${Math.round(health.httpP95Ms)} ms` : EM_DASH],
        ['Decision sources', `jev ${c.jev} · cache ${c.cache} · mock ${c.mock} · fallback ${c.fallback}`],
        ['Fallback share', total ? formatPercent(c.fallback / total) : EM_DASH],
        ['Ratings', `pending ${q.pendingRatings} · terminal ${q.terminalRatingsComplete}/${q.terminalRatingsExpected}`],
        ['Invalid / stale attempts', `${q.invalidAttempts} / ${q.staleAttempts}`],
        ['Comparison eligible', q.comparisonEligible ? 'yes' : `no${q.reasons.length ? ` — ${q.reasons.join(' ')}` : ''}`],
        ['Started from', props.manifest.initialCheckpoint ? `checkpoint ${props.manifest.initialCheckpoint.artifactId}` : 'park opening (no checkpoint)'],
        ['Seed', <span className="mono" key="s">{props.manifest.replicateSeed}</span>],
        ['Manifest hash', <span className="hash" key="h">{run.manifestHash}</span>],
      ]} />
      <p className="note">Jev = live model; cache = a cached distribution (not a copied action); mock = deterministic mock provider; fallback = declared live-timeout fallback, not Jev evidence. Faster playback runs more of the same 5-second steps; it never lengthens a step.</p>
    </div>
  );
}

export function CommandError(props: { controls: RunControls }) {
  const e = props.controls.error;
  if (!e) return null;
  return <ErrorBox error={e.error} transport={e.transport} onRetry={e.retry} retryLabel="Retry (same command ID)" />;
}

export function useRunnerPending(runner: CommandRunner) {
  return useSyncExternalStore((cb) => runner.subscribe(cb), runner.getPending, runner.getPending);
}
