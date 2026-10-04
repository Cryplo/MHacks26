import { useState, useSyncExternalStore } from 'react';
import type { DomainError, Id, RunManifest } from '../../../contract/behavior-v1';
import { useLiveSelector } from '../../data/hooks';
import type { LiveStore } from '../../data/liveStore';
import { displayModes } from '../../runtime/mode';
import { useRuntime } from '../../runtime/RuntimeProvider';
import type { CommandName, CommandOutcome, CommandRunner } from '../../runtime/commands';
import { ActionButton, ErrorBox, Explain, ModeBadges } from '../../ui/components';
import { formatAge, formatPercent, formatSimClock, formatSimOffset } from '../../ui/format';
import { RunStatusBadge } from './RunStatusBadge';

const SPEEDS = [1, 5, 10, 30, 60];

export function HealthStrip(props: { store: LiveStore; runId: Id; manifest: RunManifest; openLocal: string; canOperate: boolean }) {
  const rt = useRuntime();
  const run = useLiveSelector(props.store, (s) => s.run);
  const health = useLiveSelector(props.store, (s) => s.health);
  const conn = useLiveSelector(props.store, (s) => s.status);
  const stale = useLiveSelector(props.store, (s) => s.stale);
  const pending = useRunnerPending(rt.runner);
  const [error, setError] = useState<{ error: DomainError; transport: boolean; retry?: () => void } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  if (!run) return <div className="health-strip" role="status">Waiting for the first coherent snapshot…</div>;

  const counts = run.quality.behaviorCounts;
  const total = counts.jev + counts.cache + counts.mock + counts.fallback;
  const send = async (p: Promise<CommandOutcome<CommandName>>, retry: () => void) => {
    setError(null);
    const out = await p;
    if (out.kind === 'rejected') setError({ error: out.error, transport: false });
    if (out.kind === 'transport') setError({ error: out.error, transport: true, retry });
  };
  const cr = run.controlRevision;
  const start = () => void send(rt.runner.run('startRun', { runId: props.runId }, `start:${props.runId}`, { durable: true }), start);
  const pause = () => void send(rt.runner.run('pauseRun', { runId: props.runId, expectedControlRevision: cr }, `pause:${props.runId}:${cr}`), pause);
  const resume = () => void send(rt.runner.run('resumeRun', { runId: props.runId, expectedControlRevision: cr }, `resume:${props.runId}:${cr}`), resume);
  const cancel = () => void send(rt.runner.run('cancelRun', { runId: props.runId, expectedControlRevision: cr }, `cancel:${props.runId}:${cr}`), cancel);
  const speed = (v: number) => void send(rt.runner.run('setSpeed', { runId: props.runId, requestedSpeed: v, expectedControlRevision: cr }, `speed:${props.runId}:${cr}:${v}`), () => speed(v));
  const startPending = pending.some((p) => p.intentKey === `start:${props.runId}` && p.state !== 'transport_failed');
  const ctlPending = pending.some((p) => p.intentKey.endsWith(`:${props.runId}:${cr}`) || p.intentKey.startsWith(`speed:${props.runId}:${cr}`));
  const terminal = run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed';

  return (
    <div className="health" data-testid="health-strip">
      <div className="health-strip" aria-label="Run health">
        <ModeBadges modes={displayModes({ profile: rt.settings.profile, run, quality: run.quality })} />
        <RunStatusBadge status={run.status} />
        <span className="metric"><span className="muted">Sim clock</span><b data-testid="sim-clock">{formatSimClock(run.simMs, props.openLocal, true)}</b><span className="muted small mono">{formatSimOffset(run.simMs)}</span></span>
        <span className="metric"><span className="muted">Speed</span><b>{run.requestedSpeed}x requested</b><span className="muted">/</span><b>{run.achievedSpeed}x achieved</b></span>
        <span className="metric" title="Revision of the coherent state you are seeing"><span className="muted">Rev</span><b className="mono" data-testid="revision">{run.revision}</b></span>
        <span className="metric"><span className="muted">Waiting on</span><b>{run.blockedWorkIds.length}</b><span className="muted">decision(s)</span></span>
        <span className="metric"><span className="muted">Queued/leased work</span><b>{health ? `${health.queuedWork}/${health.leasedWork}` : '—'}</b></span>
        <span className="metric"><span className="muted">Oldest request</span><b>{health ? formatAge(health.oldestRequestAgeMs) : '—'}</b></span>
        <span className="metric"><span className="muted">HTTP p95</span><b>{health?.httpP95Ms != null ? `${Math.round(health.httpP95Ms)} ms` : '—'}</b></span>
        <span className="metric"><span className="muted">Fallback share</span><b>{total ? formatPercent(counts.fallback / total) : '—'}</b></span>
        <span className="metric">
          <span className="muted">Comparison eligible</span><b>{run.quality.comparisonEligible ? 'yes' : 'no'}</b>
          {!run.quality.comparisonEligible && <Explain label="comparison eligibility">{run.quality.reasons.join(' ') || 'Not eligible.'}</Explain>}
        </span>
        <span className="metric"><span className="muted">Connection</span><b data-testid="connection">{stale ? 'resyncing (frozen)' : conn}</b></span>
        <span className="small muted">{props.manifest.initialCheckpoint ? `Started from saved checkpoint ${props.manifest.initialCheckpoint.artifactId}` : 'Started at park opening (no checkpoint)'}</span>
      </div>
      {run.status === 'blocked' && (
        <div className="alert warn" role="status" style={{ margin: '8px 16px' }} data-testid="barrier-notice">
          <span className="icon" aria-hidden="true">!</span>
          <div>The simulation clock is paused at a boundary waiting for {run.blockedWorkIds.length} required decision distribution(s). This is an inference delay, not guests taking longer: no simulated time passes until all are ready.</div>
        </div>
      )}
      {props.canOperate ? (
        <div className="health-strip" aria-label="Run controls">
          {run.status === 'preparing' || run.status === 'ready' ? (
            <ActionButton tone="primary" onClick={start} busy={startPending} testId="start-run"
              disabledReason={run.status === 'preparing' ? 'Engine is still preparing this run (navigation and state). Start becomes available when it reports ready.' : startPending ? 'Start command pending until a receipt arrives.' : null}>Start run</ActionButton>
          ) : null}
          {run.status === 'running' || run.status === 'blocked' ? <ActionButton onClick={pause} busy={ctlPending} testId="pause-run">Pause</ActionButton> : null}
          {run.status === 'paused' ? <ActionButton onClick={resume} busy={ctlPending} testId="resume-run">Resume</ActionButton> : null}
          {!terminal && run.status !== 'preparing' && run.status !== 'ready' && (
            <label className="row small" style={{ gap: 6 }}>Speed
              <select value={run.requestedSpeed} onChange={(e) => speed(Number(e.target.value))} disabled={ctlPending} aria-label="Requested simulation speed">
                {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
              </select>
            </label>
          )}
          {!terminal && run.status !== 'preparing' && (confirmCancel
            ? <span className="row"><span className="small">Cancel this run permanently?</span><ActionButton tone="danger" small onClick={() => { setConfirmCancel(false); cancel(); }}>Yes, cancel run</ActionButton><button type="button" className="btn small" onClick={() => setConfirmCancel(false)}>Keep running</button></span>
            : <button type="button" className="btn small danger" onClick={() => setConfirmCancel(true)}>Cancel run…</button>)}
          <span className="small muted">Faster playback runs more of the same 5-second steps; it never lengthens a step.</span>
        </div>
      ) : (
        <div className="health-strip small muted" data-testid="viewer-note">View-only access: run controls are not available to this session.</div>
      )}
      {error && <div style={{ margin: '0 16px 8px' }}><ErrorBox error={error.error} transport={error.transport} onRetry={error.retry} retryLabel="Retry (same command ID)" /></div>}
    </div>
  );
}

export function useRunnerPending(runner: CommandRunner) {
  return useSyncExternalStore((cb) => runner.subscribe(cb), runner.getPending, runner.getPending);
}
