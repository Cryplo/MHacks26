import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Id, ParkBundle, RunManifest } from '../../../contract/behavior-v1';
import { ErrorBoundary } from '../../App';
import { useLiveRun, useLiveSelector, useRunManifestAndPark } from '../../data/hooks';
import { isAccessError } from '../../runtime/errors';
import { clearPrivateRunData, useRuntime } from '../../runtime/RuntimeProvider';
import type { ColorMode } from '../../renderer/colors';
import { Alert, Disclosure, ErrorBox, Icon, Spinner } from '../../ui/components';
import { InspectorPanel } from '../inspector/InspectorPanel';
import { WhatIfPanel } from '../scenarios/WhatIfPanel';
import { SharePanel } from '../sharing/SharePanel';
import { EventFeed } from './EventFeed';
import { GuestList } from './GuestList';
import { CommandError, RunBar, RunHealth, SPEEDS as SPEED_CHOICES, useRunControls, type PanelView, type RunControls, type Scrub } from './HealthStrip';
import { Legend } from './Legend';
import { NoticeObservers } from './NoticeObservers';
import { ParkMap } from './ParkMap';
import { Timeline } from './Timeline';
import { LiveStore } from '../../data/liveStore';
import { ViewStore } from '../../data/viewStore';
import { FrameCache, replaySource } from '../../data/frames';
import { useRunHistory, type RunHistory } from '../../data/history';
import { Dashboard } from '../dashboard/Dashboard';
import { OverviewMini } from '../dashboard/OverviewMini';
import { formatSimClock } from '../../ui/format';

type OverviewTab = 'summary' | 'guests' | 'activity';

const PLAYBACK_TICK_MS = 250;

export function LivePage() {
  const { runId = '' } = useParams();
  const rt = useRuntime();
  const location = useLocation();
  const navigate = useNavigate();
  const loaded = useRunManifestAndPark(runId);
  const conn = useLiveRun(runId);
  const store = conn.store;
  const storeError = useLiveSelector(store, (s) => s.error);
  const [search, setSearch] = useSearchParams();
  const selectedId = search.get('guest');
  const [view, setView] = useState<PanelView>('overview');
  const [colorMode, setColorMode] = useState<ColorMode>('state');
  const canOperate = useMemo(() => Boolean(rt.session?.roles.includes('operator')), [rt.session]);
  const isFixture = rt.settings.profile === 'fixture';
  const controls = useRunControls(store, runId);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const run = controls.run;
  const headMs = run?.simMs ?? 0;
  const terminal = controls.terminal;

  // ---- Time travel: a recorded frame shown through the same view store the map reads. ----
  const tParam = search.get('t');
  const [scrubMs, setScrubMs] = useState<number | null>(() => (tParam !== null && Number.isFinite(Number(tParam)) ? Math.max(0, Number(tParam)) : null));
  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(60);
  const frameStore = useMemo(() => new LiveStore(), []);
  const viewer = useMemo(() => new ViewStore(store), [store]);
  const frames = useMemo(() => new FrameCache(replaySource(rt.client, runId)), [rt.client, runId]);
  const frameEvery = loaded.data?.manifest.config.visualFrameEveryMs ?? 30_000;
  const viewMs = scrubMs ?? headMs;
  const [frameAt, setFrameAt] = useState<number | null>(null);
  const req = useRef(0);
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    if (scrubMs === null) { viewer.setSource(store); setFrameAt(null); shownAt.current = null; return; }
    const my = ++req.current;
    const t = Math.min(scrubMs, headMs || scrubMs);
    const show = (f: { atMs: number; snapshot: Parameters<LiveStore['applySnapshot']>[0] } | null) => {
      if (!f || my !== req.current || shownAt.current === f.atMs) return;
      // Recorded playback moving to the next frame continues smoothly; anything else is a seek
      // (discrete placement: reset so nothing tweens across the jump).
      const continuous = playing && shownAt.current !== null && f.atMs > shownAt.current && f.atMs - shownAt.current <= 120_000;
      shownAt.current = f.atMs;
      if (!continuous) frameStore.reset(runId);
      // A recorded frame carries the run's live status/speed; for the map clock it is paused
      // on that moment, or advancing at the playback speed while the recording plays.
      frameStore.applySnapshot({ ...f.snapshot, run: { ...f.snapshot.run, status: playing ? 'running' : 'paused', requestedSpeed: playSpeed } }, { continuous });
      viewer.setSource(frameStore);
      setFrameAt(f.atMs);
    };
    // Show the nearest cached frame immediately; fetch (debounced while dragging) only if needed.
    const near = frames.cachedAt(t, Infinity);
    if (near) show(near);
    const exact = frames.cachedAt(t, frameEvery * 1.5);
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (!exact) timer = setTimeout(() => { void frames.at(t, frameEvery).then(show, () => undefined); }, near ? 120 : 0);
    // Keep playback smooth: fetch the next window ahead of the playhead.
    if (playing) void frames.at(Math.min(headMs, t + 120_000), frameEvery).catch(() => undefined);
    return () => { if (timer) clearTimeout(timer); };
  }, [scrubMs, frames, frameStore, viewer, store, runId, frameEvery, headMs, playing, playSpeed]);
  const goLive = useCallback(() => {
    setPlaying(false); setScrubMs(null);
    setSearch((p) => { const n = new URLSearchParams(p); n.delete('t'); return n; }, { replace: true });
  }, [setSearch]);
  const commitScrub = useCallback((ms: number, released?: boolean) => {
    setSearch((p) => { const n = new URLSearchParams(p); n.set('t', String(Math.round(ms))); return n; }, { replace: true });
    // Releasing a drag/click carries on from that moment (recorded playback at the run's own
    // speed) instead of freezing there; keyboard steps stay put. Play pauses, "Back to live" rejoins.
    if (!released) return;
    const live = store.getState().run;
    // At least 20x, so a replay visibly moves even when the live run is crawling at 1x.
    setPlaySpeed(Math.max(20, live && SPEED_CHOICES.includes(live.requestedSpeed) ? live.requestedSpeed : 20));
    setPlaying(true);
  }, [setSearch, store]);
  // Recorded playback advances simulated time at the chosen speed; reaching the head goes live.
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setScrubMs((cur) => {
        const base = cur ?? 0;
        const next = base + PLAYBACK_TICK_MS * playSpeed;
        if (next >= headMs) { setPlaying(false); return terminal ? headMs : null; }
        return next;
      });
    }, PLAYBACK_TICK_MS);
    return () => clearInterval(t);
  }, [playing, playSpeed, headMs, terminal]);
  useEffect(() => { if (scrubMs === null && !terminal) setPlaying(false); }, [scrubMs, terminal]);
  const viewStore = viewer.asStore();
  const scrub: Scrub = {
    scrubbing: scrubMs !== null, viewMs, playing, speed: playSpeed, terminal,
    onPlay: () => { if (!playing && scrubMs === null) setScrubMs(terminal ? 0 : Math.max(0, headMs - 600_000)); if (!playing && terminal && scrubMs !== null && scrubMs >= headMs) setScrubMs(0); setPlaying((p) => !p); },
    onSpeed: setPlaySpeed,
  };

  const groupId = useLiveSelector(viewStore, (s) => (selectedId ? s.agents.get(selectedId)?.groupId ?? null : null));
  const agents = useLiveSelector(viewStore, (s) => s.agents);
  const groupIds = useMemo(() => (groupId ? [...agents.values()].filter((a) => a.groupId === groupId).map((a) => a.agentId) : []), [agents, groupId]);
  const metricsAt = useLiveSelector(viewStore, (s) => s.metrics?.simMs ?? null);
  const history = useRunHistory(runId, run ? headMs : null, { horizonMs: loaded.data?.manifest.config.horizonMs ?? 3 * 3600_000, frameEveryMs: frameEvery, enabled: Boolean(loaded.data), samples: view === 'dashboard' });

  const select = useCallback((id: Id | null) => {
    setSearch((p) => { const n = new URLSearchParams(p); if (id) n.set('guest', id); else n.delete('guest'); return n; }, { replace: true });
    if (id) setView('overview');
  }, [setSearch]);

  // One click from setup: start as soon as Engine reports the run ready.
  const autostart = Boolean((location.state as { autostart?: boolean } | null)?.autostart);
  const autoSent = useRef(false);
  const status = run?.status;
  useEffect(() => {
    if (!autostart || autoSent.current || !canOperate || status !== 'ready') return;
    autoSent.current = true;
    controls.start();
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
  }, [autostart, canOperate, status, controls, navigate, location.pathname, location.search]);

  // Escape closes the dashboard / guest detail / secondary view and returns to the overview.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest('[role=menu], textarea, input, select')) return;
      if (view !== 'overview') setView('overview');
      else if (selectedId) select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, selectedId, select]);

  // Revoked/expired access clears cached private run data and stops showing it.
  const accessLost = storeError && isAccessError(storeError.code);
  const refreshSession = rt.refreshSession;
  useEffect(() => { if (accessLost) { clearPrivateRunData(); conn.disconnect(); void refreshSession(); } }, [accessLost, conn, refreshSession]);

  if (accessLost || (loaded.error && isAccessError(loaded.error.code))) {
    const err = storeError ?? loaded.error!;
    return (
      <div style={{ padding: 24, maxWidth: 720 }}>
        <Alert tone="bad" title="No access to this run"><p>{err.message}</p><p className="small">Ask the person who shared it for a new link.</p></Alert>
      </div>
    );
  }
  if (loaded.error) return <div style={{ padding: 24 }}><ErrorBox error={loaded.error} transport={loaded.transport} onRetry={loaded.reload} /></div>;
  if (!loaded.data) return <div style={{ padding: 24 }}><Spinner label="Loading the park…" /></div>;
  const { manifest, park, codes } = loaded.data;
  const showGuest = view === 'overview' && selectedId;
  const timeline = (
    <Timeline openLocal={park.openLocal} horizonMs={manifest.config.horizonMs} headMs={headMs} viewMs={viewMs} scrubbing={scrubMs !== null} terminal={terminal}
      stepMs={frameEvery} onScrub={(ms) => { setPlaying(false); setScrubMs(ms); }} onCommit={commitScrub} onLive={() => (terminal ? setScrubMs(headMs) : goLive())} />
  );

  return (
    <div className={`live ${view === 'dashboard' ? 'with-dashboard' : ''}`} data-testid="live-page" data-view-ms={viewMs} data-frame-ms={frameAt ?? ''}>
      <div className="map-area">
        <ErrorBoundary label="Map error">
          <ParkMap store={viewStore} park={park} codes={codes} selectedId={selectedId} groupIds={groupIds} colorMode={colorMode} onSelect={select} showOperatorTruth={false} />
        </ErrorBoundary>
        <div className="map-overlay top-left" style={{ pointerEvents: 'none' }}>
          <div style={{ pointerEvents: 'auto' }}><Legend mode={colorMode} onMode={setColorMode} openLocal={park.openLocal} asOfSimMs={metricsAt} /></div>
        </div>
        <Toasts store={store} controls={controls} autostart={autostart} confirmCancel={confirmCancel} scrubbing={scrubMs !== null}
          onCancelConfirm={() => { setConfirmCancel(false); controls.cancel(); }} onCancelDismiss={() => setConfirmCancel(false)} />
      </div>
      <RunBar store={store} viewStore={viewStore} runId={runId} manifest={manifest} openLocal={park.openLocal} canOperate={canOperate} controls={controls}
        scrub={scrub} timeline={timeline} onOpen={(v) => setView(v)} onCancelRequest={() => setConfirmCancel(true)} />
      {view === 'dashboard' && (
        <section className="dash-overlay" aria-label="Dashboard" data-testid="dashboard-overlay">
          <div className="dash-overlay-head">
            <button type="button" className="btn" onClick={() => setView('overview')} data-testid="close-dashboard"><Icon name="back" />Back to map</button>
            <h2>Dashboard</h2>
            <span className="small muted">{scrubMs !== null ? `As of ${formatSimClock(viewMs, park.openLocal)}` : terminal ? 'Final' : 'Live'}</span>
          </div>
          <Dashboard runId={runId} park={park} codes={codes} manifest={manifest} store={viewStore} history={history} viewMs={viewMs} />
        </section>
      )}
      <aside className="side" aria-label="Run details" hidden={view === 'dashboard'}>
        {showGuest && (
          <>
            <div className="side-head">
              <button type="button" className="btn ghost small icon" onClick={() => select(null)} aria-label="Close guest and return to overview" data-testid="close-guest"><Icon name="back" /></button>
              <h2>Guest</h2>
              <span className="tiny faint" style={{ marginLeft: 'auto' }}>Esc to close</span>
            </div>
            <ErrorBoundary label="Guest detail error">
              <InspectorPanel key={selectedId} runId={runId} agentId={selectedId} store={viewStore} park={park} canOperate={canOperate} onSelectAgent={select} onClose={() => select(null)} isFixture={isFixture} asOfMs={scrubMs !== null ? viewMs : null} />
            </ErrorBoundary>
          </>
        )}
        <div hidden={Boolean(showGuest) || view !== 'overview'}>
          <Overview store={viewStore} park={park} runId={runId} manifest={manifest} isFixture={isFixture} selectedId={selectedId} onSelect={select}
            history={history} viewMs={viewMs} onExpand={() => setView('dashboard')} />
        </div>
        {/* Kept mounted so drafts, receipts and issued links survive switching views. */}
        {canOperate && (
          <div hidden={view !== 'whatif'}>
            <SecondaryHead title="What if…" onBack={() => setView('overview')} />
            <div className="side-body">
              <WhatIfPanel runId={runId} store={store} park={park} manifest={manifest} capabilities={rt.capabilities} />
              <NoticeObservers store={store} park={park} onAgent={select} />
            </div>
          </div>
        )}
        {canOperate && (
          <div hidden={view !== 'share'}>
            <SecondaryHead title="Share" onBack={() => setView('overview')} />
            <div className="side-body"><SharePanel runId={runId} /></div>
          </div>
        )}
      </aside>
    </div>
  );
}

function SecondaryHead(props: { title: string; onBack: () => void }) {
  return (
    <div className="side-head">
      <button type="button" className="btn ghost small icon" onClick={props.onBack} aria-label="Back to overview"><Icon name="back" /></button>
      <h2>{props.title}</h2>
    </div>
  );
}

function Overview(props: { store: LiveStore; park: ParkBundle; runId: Id; manifest: RunManifest; isFixture: boolean; selectedId: Id | null; onSelect: (id: Id) => void; history: RunHistory; viewMs: number; onExpand: () => void }) {
  const [tab, setTab] = useState<OverviewTab>('summary');
  const inPark = useLiveSelector(props.store, (s) => s.agents.size);
  const tabs: [OverviewTab, string][] = [['summary', 'Overview'], ['guests', `Guests${inPark ? ` ${inPark}` : ''}`], ['activity', 'Activity']];
  return (
    <>
      <div className="side-head">
        <div className="seg full" role="tablist" aria-label="Panel" style={{ flex: 1 }}>
          {tabs.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} aria-controls={`panel-${k}`} id={`tab-${k}`} onClick={() => setTab(k)} data-testid={`tab-${k}`}>{label}</button>
          ))}
        </div>
      </div>
      <div className="side-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        <div hidden={tab !== 'summary'} className="stack" style={{ gap: 4 }}>
          <OverviewMini store={props.store} park={props.park} manifest={props.manifest} history={props.history} viewMs={props.viewMs} onExpand={props.onExpand} />
          <div style={{ marginTop: 8 }}>
            <Disclosure summary="Technical details"><RunHealth store={props.store} manifest={props.manifest} /></Disclosure>
            {props.isFixture && (
              <Disclosure summary="About fixture data">
                <p className="note">Scripted data with no Engine, no Jev and no backend. Guests follow a pre-scripted choreography and do not react to what-if changes.</p>
              </Disclosure>
            )}
          </div>
          <p className="note" style={{ marginTop: 8 }}>Click a guest on the map to see what they are doing and why. Drag the timeline to look back.</p>
        </div>
        <div hidden={tab !== 'guests'}><GuestList store={props.store} selectedId={props.selectedId} onSelect={props.onSelect} /></div>
        <div hidden={tab !== 'activity'}><EventFeed store={props.store} park={props.park} runId={props.runId} onAgent={props.onSelect} /></div>
      </div>
    </>
  );
}

function Toasts(props: { store: LiveStore; controls: RunControls; autostart: boolean; confirmCancel: boolean; scrubbing: boolean; onCancelConfirm: () => void; onCancelDismiss: () => void }) {
  const run = props.controls.run;
  const stale = useLiveSelector(props.store, (s) => s.stale);
  // Short inference barriers are normal at high speed; only surface one that persists.
  const blocked = run?.status === 'blocked';
  const [showBarrier, setShowBarrier] = useState(false);
  useEffect(() => {
    if (!blocked) { setShowBarrier(false); return; }
    const t = setTimeout(() => setShowBarrier(true), 700);
    return () => clearTimeout(t);
  }, [blocked]);
  const items: ReactNode[] = [];
  if (blocked && showBarrier && !props.scrubbing) {
    items.push(
      <div key="b" className="floating toast" role="status" data-testid="barrier-notice">
        <span className="spinner" aria-hidden="true" />
        <span>Waiting for {run!.blockedWorkIds.length} guest decision{run!.blockedWorkIds.length === 1 ? '' : 's'}. The clock holds until they arrive; no simulated time passes.</span>
      </div>,
    );
  }
  if (run?.status === 'preparing' && props.autostart) {
    items.push(<div key="p" className="floating toast" role="status"><span className="spinner" aria-hidden="true" /><span>Preparing the park. The simulation starts automatically.</span></div>);
  }
  if (stale) items.push(<div key="s" className="floating toast" role="status"><span className="dot warn" aria-hidden="true" /><span>Reconnecting: the view is frozen until state is consistent again.</span></div>);
  if (props.confirmCancel) {
    items.push(
      <div key="c" className="floating toast" role="alertdialog" aria-label="Cancel run">
        <span>Cancel this run permanently?</span>
        <button type="button" className="btn small danger" onClick={props.onCancelConfirm} data-testid="confirm-cancel">Cancel run</button>
        <button type="button" className="btn small ghost" onClick={props.onCancelDismiss}>Keep running</button>
      </div>,
    );
  }
  if (props.controls.error) items.push(<div key="e" className="floating" style={{ padding: 4, maxWidth: 480 }}><CommandError controls={props.controls} /></div>);
  if (!items.length) return null;
  return <div className="map-overlay top-center" style={{ flexDirection: 'column', alignItems: 'center', zIndex: 25 }}>{items}</div>;
}
