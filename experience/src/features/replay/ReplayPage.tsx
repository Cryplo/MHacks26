import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Id, ReplayFrame, RuntimeClient } from '../../../contract/behavior-v1';
import { useRunManifestAndPark } from '../../data/hooks';
import { LiveStore } from '../../data/liveStore';
import { classifyError } from '../../runtime/errors';
import { displayModes } from '../../runtime/mode';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { ErrorBox, ModeBadges, Spinner } from '../../ui/components';
import { formatDuration, formatSimClock } from '../../ui/format';
import { ParkMap } from '../live/ParkMap';
import { StatsPanel } from '../live/StatsPanel';
import type { ColorMode } from '../../renderer/colors';
import { Legend } from '../live/Legend';

/**
 * The ONLY runtime surface replay may use: recorded frames. No live subscription, no
 * product work (narration/inference), no commands. Enforced by construction and tests.
 */
export type ReplaySource = { getFrames: (fromMs: number, toMs: number, cursor: string | null) => Promise<{ items: ReplayFrame[]; nextCursor: string | null }> };
export function replaySource(client: RuntimeClient, runId: Id): ReplaySource {
  return { getFrames: (fromMs, toMs, cursor) => client.query('getFrames', { runId, fromMs, toMs, cursor }) };
}

export const WINDOW_MS = 10 * 60_000;

/** Bounded frame cache: fetches whole windows on demand and keeps at most `maxWindows`. */
export class FrameWindows {
  private windows = new Map<number, ReplayFrame[]>();
  private order: number[] = [];
  constructor(private readonly src: ReplaySource, private readonly maxWindows = 3) {}
  async windowFor(atMs: number): Promise<ReplayFrame[]> {
    const start = Math.floor(atMs / WINDOW_MS) * WINDOW_MS;
    const hit = this.windows.get(start);
    if (hit) return hit;
    const frames: ReplayFrame[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const page: { items: ReplayFrame[]; nextCursor: string | null } = await this.src.getFrames(start, start + WINDOW_MS - 1, cursor);
      frames.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    this.windows.set(start, frames);
    this.order.push(start);
    while (this.order.length > this.maxWindows) this.windows.delete(this.order.shift()!);
    return frames;
  }
  cachedWindowCount = () => this.windows.size;
}

export function ReplayPage() {
  const { runId = '' } = useParams();
  const rt = useRuntime();
  const base = useRunManifestAndPark(runId);
  const store = useMemo(() => new LiveStore(), []);
  const windows = useMemo(() => new FrameWindows(replaySource(rt.client, runId)), [rt.client, runId]);
  const [frame, setFrame] = useState<ReplayFrame | null>(null);
  const [atMs, setAtMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<ReturnType<typeof classifyError> | null>(null);
  const [lastAvailable, setLastAvailable] = useState<number | null>(null);
  const [goto, setGoto] = useState('');
  const [colorMode, setColorMode] = useState<ColorMode>('state');
  const req = useRef(0);
  const every = base.data?.manifest.config.visualFrameEveryMs ?? 30_000;

  const show = useCallback(async (target: number) => {
    const my = ++req.current;
    try {
      const frames = await windows.windowFor(target);
      if (my !== req.current) return;
      const f = [...frames].reverse().find((x) => x.atMs <= target) ?? frames[0] ?? null;
      if (!f) { setLastAvailable((l) => l ?? target - every); setPlaying(false); return; }
      if (frames.length && frames[frames.length - 1]!.atMs < target) setLastAvailable(frames[frames.length - 1]!.atMs);
      // Seek/step = discrete placement: reset the store so nothing tweens across the jump.
      store.reset(runId);
      store.applySnapshot(f.snapshot);
      setFrame(f);
      setAtMs(f.atMs);
      setError(null);
    } catch (e) {
      if (my === req.current) { setError(classifyError(e)); setPlaying(false); }
    }
  }, [windows, store, runId, every]);

  useEffect(() => { if (base.data) void show(0); }, [base.data, show]);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      if (lastAvailable !== null && atMs >= lastAvailable) { setPlaying(false); return; }
      void show(atMs + every);
    }, 500);
    return () => clearInterval(t);
  }, [playing, atMs, every, show, lastAvailable]);

  if (base.error) return <div style={{ padding: 16 }}><ErrorBox error={base.error} transport={base.transport} /></div>;
  if (!base.data) return <div style={{ padding: 16 }}><Spinner label="Loading recorded run…" /></div>;
  const { park, codes, manifest } = base.data;
  const parse = () => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(goto.trim());
    if (!m) return;
    const open = Number(park.openLocal.slice(0, 2)) * 60 + Number(park.openLocal.slice(3));
    const ms = ((Number(m[1]) * 60 + Number(m[2])) - open) * 60_000;
    if (ms >= 0) { setPlaying(false); void show(ms); }
  };
  return (
    <div className="live-shell" data-testid="replay-page">
      <div className="health">
        <div className="health-strip">
          <ModeBadges modes={displayModes({ profile: rt.settings.profile, recorded: true })} />
          <span className="metric"><span className="muted">Frame</span><b data-testid="replay-time">{frame ? formatSimClock(frame.atMs, park.openLocal, true) : '—'}</b></span>
          <span className="metric"><span className="muted">Resolution</span><b data-testid="replay-resolution">one saved frame every {formatDuration(every)}</b></span>
          <span className="small muted">Saved frames only: positions between frames are not invented, and no inference runs during replay. This is not a fresh rerun or a checkpoint clone.</span>
        </div>
        <div className="health-strip" aria-label="Replay controls">
          <button type="button" className="btn" onClick={() => { setPlaying(false); void show(0); }}>{'⏮'} Start</button>
          <button type="button" className="btn" onClick={() => { setPlaying(false); void show(Math.max(0, atMs - every)); }} data-testid="step-back">{'◀'} Step back</button>
          <button type="button" className="btn primary" onClick={() => setPlaying((p) => !p)} data-testid="play-pause">{playing ? '‖ Pause' : '▶ Play'}</button>
          <button type="button" className="btn" onClick={() => { setPlaying(false); void show(atMs + every); }} data-testid="step-forward">Step forward {'▶'}</button>
          <form className="row" onSubmit={(e) => { e.preventDefault(); parse(); }}>
            <label className="small">Go to (park time HH:MM) <input type="text" value={goto} onChange={(e) => setGoto(e.target.value)} style={{ width: 80 }} /></label>
            <button type="submit" className="btn small">Seek</button>
          </form>
          {lastAvailable !== null && <span className="small muted">Last saved frame: {formatSimClock(lastAvailable, park.openLocal, true)}</span>}
          <Link className="btn small" to={`/runs/${encodeURIComponent(runId)}/results`}>Results</Link>
        </div>
        {error && <div style={{ margin: '0 16px 8px' }}><ErrorBox error={error.error} transport={error.transport} /></div>}
      </div>
      <div className="map-area">
        <ParkMap store={store} park={park} codes={codes} selectedId={null} groupIds={[]} colorMode={colorMode} onSelect={() => undefined} showOperatorTruth={false} />
        <div className="map-overlay top-left"><Legend mode={colorMode} onMode={setColorMode} openLocal={park.openLocal} asOfSimMs={frame?.atMs ?? null} /></div>
      </div>
      <aside className="side" aria-label="Recorded frame details">
        <div className="side-body">
          <p className="small">Recorded frame from run <span className="mono">{runId}</span> (scenario {manifest.scenario.label}).</p>
          {frame ? <StatsPanel store={store} openLocal={park.openLocal} isFixture={rt.settings.profile === 'fixture'} /> : <Spinner label="Loading frames…" />}
        </div>
      </aside>
      <div className="feed" />
    </div>
  );
}
