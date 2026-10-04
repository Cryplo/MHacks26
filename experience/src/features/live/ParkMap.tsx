import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Id, ParkBundle } from '../../../contract/behavior-v1';
import type { LiveStore } from '../../data/liveStore';
import { useLiveSelector } from '../../data/hooks';
import { queueLabel } from './queueAndNotices';
import { guestName } from '../../domain/guestNames';
import { STATE_STYLE, type ColorMode } from '../../renderer/colors';
import { ParkScene } from '../../renderer/ParkScene';
import { sceneContentFor, walkableFor } from '../../renderer/sceneContent';

type Props = {
  store: LiveStore; park: ParkBundle; codes: Uint8Array; selectedId: Id | null; groupIds: Id[];
  colorMode: ColorMode; onSelect: (id: Id | null) => void; showOperatorTruth: boolean;
};

declare global {
  // Fixture-build-only read-only test hook (screen position of a displayed agent).
  var __behaviorMap: { screenOf: (id: Id) => { x: number; y: number } | null; scale: () => number; timeOfDay?: () => { hour: number; phase: string }; setHour?: (h: number | null) => void; clock?: () => Record<string, number | boolean> } | undefined;
}

const LABEL_FONT = '"Inter", "SF Pro Text", system-ui, -apple-system, "Segoe UI", sans-serif';
const pill: React.CSSProperties = {
  background: 'rgba(14,17,19,0.74)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 6,
  padding: '2px 7px 3px', boxShadow: '0 2px 8px rgba(0,0,0,0.35)', backdropFilter: 'blur(3px)',
};
const ctlBtn: React.CSSProperties = {
  width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 0,
  background: 'transparent', color: '#e9e4d8', cursor: 'pointer', fontSize: 16, fontFamily: LABEL_FONT, lineHeight: 1,
};

export function ParkMap(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ParkScene | null>(null);
  const [status, setStatus] = useState<{ kind: 'loading' } | { kind: 'ready' } | { kind: 'failed'; message: string }>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [, setCamTick] = useState(0);
  const [hoverId, setHoverId] = useState<Id | null>(null);
  const [following, setFollowing] = useState(false);
  const raf = useRef<number | null>(null);
  const { store, park, codes } = props;

  const bumpCamera = useCallback(() => {
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => { raf.current = null; setCamTick((t) => t + 1); });
  }, []);
  const onSelect = useRef(props.onSelect);
  onSelect.current = props.onSelect;

  const walkable = useMemo(() => walkableFor(park, codes), [park, codes]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    setStatus({ kind: 'loading' });
    ParkScene.create({
      host: el, ...sceneContentFor(park, codes, walkable), onPick: (id) => onSelect.current(id), onCameraChange: bumpCamera, onHover: setHoverId, onFollowChange: setFollowing,
      onFailure: (message) => { setStatus({ kind: 'failed', message }); sceneRef.current?.destroy(); sceneRef.current = null; },
    }).then((scene) => {
      if (cancelled) { scene.destroy(); return; }
      sceneRef.current = scene;
      const push = () => {
        const s = store.getState();
        if (!s.run) return;
        // Clock first, so setAgents sees the current running state.
        scene.setRunClock(s.run.simMs, s.run.requestedSpeed, s.run.status === 'running' && !s.stale);
        scene.setAgents(s.agents, s.run.simMs, s.snapshotEpoch);
      };
      push();
      const unsub = store.subscribe(push);
      cleanupRef.current = unsub;
      // Read-only display hook: always in fixture builds; in live builds only with ?mapdebug=1.
      if (import.meta.env.VITE_RUNTIME_PROFILE === 'fixture' || new URLSearchParams(location.search).has('mapdebug')) {
        globalThis.__behaviorMap = {
          screenOf: (id) => {
            const p = scene.agentScreenPosition(id);
            const r = el.getBoundingClientRect();
            return p ? { x: p.x + r.left, y: p.y + r.top } : null;
          },
          scale: () => scene.camera.scale,
          timeOfDay: () => scene.timeOfDay,
          setHour: (h) => scene.setHourOverride(h),
          clock: () => scene.clockInfo,
        };
      }
      setStatus({ kind: 'ready' });
      bumpCamera();
    }, (e: unknown) => {
      if (!cancelled) setStatus({ kind: 'failed', message: `The map could not start (${e instanceof Error ? e.message : String(e)}). WebGL may be unavailable.` });
    });
    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
      sceneRef.current?.destroy();
      sceneRef.current = null;
      setHoverId(null); setFollowing(false);
      if (globalThis.__behaviorMap) globalThis.__behaviorMap = undefined;
    };
  }, [park, codes, store, walkable, bumpCamera, attempt]);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => { sceneRef.current?.setColorMode(props.colorMode); }, [props.colorMode, status]);
  useEffect(() => { sceneRef.current?.setSelection(props.selectedId, props.groupIds); }, [props.selectedId, props.groupIds, status]);

  // Keep the hover tag and the selected guest's name tag glued to their (moving) guests.
  const tracking = hoverId !== null || props.selectedId !== null;
  useEffect(() => {
    if (!tracking) return;
    let id = 0;
    const loop = () => { setCamTick((t) => t + 1); id = requestAnimationFrame(loop); };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [tracking]);

  const scene = sceneRef.current;
  const places = useLiveSelector(store, (st) => st.places);
  const queues = useLiveSelector(store, (st) => st.queues);
  const agents = useLiveSelector(store, (st) => st.agents);
  const zoom = scene?.camera.scale ?? 1;
  const labels = scene && status.kind === 'ready' ? park.places.filter((p) => p.kind !== 'entrance' && p.kind !== 'exit').map((p) => {
    const s = scene.placeAnchorScreen(p.id, p.entrance);
    const view = places.get(p.id);
    const major = p.kind === 'ride' || p.kind === 'show';
    return { p, s, major, closed: view?.closed ?? false, wait: view?.predictedWaitMs ?? null, queue: queueLabel(queues.get(p.id)) };
  }).filter((l) => l.major || l.closed || zoom > 4.2) : [];
  const detail = zoom > 3.4;
  // Declutter: keep the most important label where two would overlap on screen.
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const shown = new Set<string>();
  for (const l of [...labels].sort((a, b) => Number(b.closed) - Number(a.closed) || Number(b.major) - Number(a.major) || a.s.y - b.s.y)) {
    const w = Math.max(l.p.name.length * (l.major ? 7.4 : 6.6) + 18, detail && l.queue ? 150 : 0); const h = detail && l.queue ? 44 : 22;
    const r = { x0: l.s.x - w / 2, x1: l.s.x + w / 2, y0: l.s.y - h - 6, y1: l.s.y - 6 };
    if (placed.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)) continue;
    placed.push(r); shown.add(l.p.id);
  }

  const hover = scene && hoverId && hoverId !== props.selectedId ? (() => {
    const a = agents.get(hoverId); const s = scene.agentScreenPosition(hoverId);
    if (!a || !s) return null;
    const target = a.targetPlaceId ? park.places.find((p) => p.id === a.targetPlaceId)?.name : null;
    return { s, name: guestName(a.agentId, a.groupId), text: STATE_STYLE[a.state].label, target };
  })() : null;
  const nameTag = scene && props.selectedId && status.kind === 'ready' ? (() => {
    const a = agents.get(props.selectedId!); const s = scene.agentHeadScreenPosition(props.selectedId!);
    if (!a || !s) return null;
    return { s, name: guestName(a.agentId, a.groupId) };
  })() : null;

  const onKey = (e: React.KeyboardEvent) => {
    const sc = sceneRef.current;
    if (!sc) return;
    const map: Record<string, () => void> = {
      '+': () => sc.zoomBy(1.25), '=': () => sc.zoomBy(1.25), '-': () => sc.zoomBy(0.8), '0': () => sc.fit(),
      ArrowLeft: () => sc.panBy(40, 0), ArrowRight: () => sc.panBy(-40, 0), ArrowUp: () => sc.panBy(0, 40), ArrowDown: () => sc.panBy(0, -40),
      Escape: () => props.onSelect(null),
    };
    const fn = map[e.key];
    if (fn) { e.preventDefault(); fn(); }
  };

  return (
    <div className="map-canvas" ref={host} role="application" aria-roledescription="park map" tabIndex={0} onKeyDown={onKey}
      aria-label="Park map. Use plus and minus to zoom, 0 to fit, arrow keys to pan, Escape to clear selection. Select guests from the Guests tab with the keyboard."
      data-testid="park-map" data-map-status={status.kind} style={{ background: '#b8dcf0' }}>
      {labels.filter((l) => shown.has(l.p.id)).map(({ p, s, major, closed, wait, queue }) => (
        <div key={p.id} aria-hidden="true" style={{ position: 'absolute', left: s.x, top: s.y, transform: 'translate(-50%, -100%)', pointerEvents: 'none',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, fontFamily: LABEL_FONT, whiteSpace: 'nowrap', opacity: major ? 1 : 0.9 }}>
          <div style={{ ...pill, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: major ? 10.5 : 9.5, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#efe9dc' }}>{p.name}</span>
            {closed && <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', color: '#f3d1c8', background: 'rgba(150,48,36,0.85)', borderRadius: 3, padding: '0 4px' }}>CLOSED</span>}
          </div>
          {detail && (queue || (props.showOperatorTruth && wait !== null && wait > 0 && p.kind === 'ride')) && (
            <div style={{ ...pill, padding: '1px 6px 2px', fontSize: 10, color: 'rgba(233,228,216,0.82)', fontVariantNumeric: 'tabular-nums', display: 'flex', gap: 6 }}>
              {queue && <span>{queue}</span>}
              {props.showOperatorTruth && wait !== null && wait > 0 && p.kind === 'ride' && <span style={{ color: 'rgba(233,228,216,0.6)' }}>operator est. {Math.round(wait / 60_000)} min</span>}
            </div>
          )}
          <div style={{ width: 1, height: 6, background: 'rgba(239,233,220,0.35)' }} />
        </div>
      ))}
      {hover && !(nameTag && Math.abs(nameTag.s.x - hover.s.x) < 140 && Math.abs(nameTag.s.y - (hover.s.y - 18)) < 36) && (
        <div aria-hidden="true" style={{ position: 'absolute', left: hover.s.x, top: hover.s.y - 18, transform: 'translate(-50%, -100%)', pointerEvents: 'none',
          ...pill, fontFamily: LABEL_FONT, fontSize: 11, color: '#efe9dc', whiteSpace: 'nowrap' }}>
          <span style={{ fontWeight: 600 }}>{hover.name}</span>
          <span style={{ color: 'rgba(239,233,220,0.75)' }}>{' · '}{hover.text}</span>
          {hover.target && <span style={{ color: 'rgba(239,233,220,0.65)' }}>{' · '}{hover.target}</span>}
        </div>
      )}
      {nameTag && (
        <div aria-hidden="true" data-testid="map-name-tag" style={{ position: 'absolute', left: nameTag.s.x, top: nameTag.s.y, transform: 'translate(-50%, -100%)', pointerEvents: 'none',
          ...pill, padding: '2px 8px 3px', background: 'rgba(14,17,19,0.82)', border: '1px solid rgba(243,215,154,0.45)', fontFamily: LABEL_FONT, fontSize: 11.5,
          fontWeight: 600, letterSpacing: '0.01em', color: '#f6efe0', whiteSpace: 'nowrap' }}>
          {nameTag.name}
        </div>
      )}
      {status.kind === 'loading' && <div className="fallback-map" role="status"><span className="spinner" aria-hidden="true" />&nbsp;<span style={{ color: '#fff' }}>Starting map…</span></div>}
      {status.kind === 'failed' && (
        <div className="fallback-map" role="alert">
          <div className="panel stack" style={{ maxWidth: 420 }}>
            <strong>Map unavailable</strong>
            <p>{status.message}</p>
            <p className="small muted">The guest list, inspector, statistics and controls keep working without the map.</p>
            <button type="button" className="btn" onClick={() => setAttempt((a) => a + 1)}>Try the map again</button>
          </div>
        </div>
      )}
      {status.kind === 'ready' && (
        <div style={{ position: 'absolute', right: 10, bottom: 10, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
          {props.selectedId && (
            <button type="button" aria-pressed={following} onClick={() => sceneRef.current?.setFollow(!following)}
              style={{ ...pill, ...ctlBtn, width: 'auto', height: 26, padding: '0 10px', fontSize: 11, letterSpacing: '0.05em', borderRadius: 6,
                color: following ? '#14110c' : '#e9e4d8', background: following ? '#f3d79a' : pill.background }}>
              {following ? 'Following guest' : 'Follow guest'}
            </button>
          )}
          <div role="group" aria-label="Zoom" style={{ ...pill, padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRadius: 8 }}>
            <button type="button" style={ctlBtn} onClick={() => sceneRef.current?.zoomBy(1.25)} aria-label="Zoom in">+</button>
            <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />
            <button type="button" style={ctlBtn} onClick={() => sceneRef.current?.zoomBy(0.8)} aria-label="Zoom out">{'−'}</button>
            <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />
            <button type="button" style={{ ...ctlBtn, fontSize: 13 }} onClick={() => sceneRef.current?.fit()} aria-label="Reset zoom to fit the park" title="Fit park">{'⤢'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
