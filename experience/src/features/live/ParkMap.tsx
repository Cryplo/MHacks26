import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Id, ParkBundle, Vec2 } from '../../../contract/behavior-v1';
import { decorFor, HARBOR_LIGHTS_PARK_ID, LAYOUT } from '../../content/harborLights';
import type { LiveStore } from '../../data/liveStore';
import { useLiveSelector } from '../../data/hooks';
import type { ColorMode } from '../../renderer/colors';
import { paintParkCanvas } from '../../renderer/parkCanvas';
import { ParkScene } from '../../renderer/ParkScene';

const PX = 4;

type Props = {
  store: LiveStore; park: ParkBundle; codes: Uint8Array; selectedId: Id | null; groupIds: Id[];
  colorMode: ColorMode; onSelect: (id: Id | null) => void; showOperatorTruth: boolean;
};

declare global {
  // Fixture-build-only read-only test hook (screen position of a displayed agent).
  var __behaviorMap: { screenOf: (id: Id) => { x: number; y: number } | null; scale: () => number } | undefined;
}

export function ParkMap(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ParkScene | null>(null);
  const [status, setStatus] = useState<{ kind: 'loading' } | { kind: 'ready' } | { kind: 'failed'; message: string }>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [, setCamTick] = useState(0);
  const raf = useRef<number | null>(null);
  const { store, park, codes } = props;

  const bumpCamera = useCallback(() => {
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => { raf.current = null; setCamTick((t) => t + 1); });
  }, []);
  const onSelect = useRef(props.onSelect);
  onSelect.current = props.onSelect;

  const walkable = useMemo(() => {
    const w = park.grid.width;
    return (p: Vec2) => {
      const x = Math.floor(p.xM / park.grid.cellM); const y = Math.floor(p.yM / park.grid.cellM);
      if (x < 0 || y < 0 || x >= w || y >= park.grid.height) return false;
      const c = codes[y * w + x];
      return c === 1 || c === 2 || c === 4 || (c === 3 && park.grid.grassWalkable);
    };
  }, [park, codes]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    setStatus({ kind: 'loading' });
    const placeIds = new Set(park.places.map((p) => p.id));
    const decor = park.parkId === HARBOR_LIGHTS_PARK_ID ? decorFor(placeIds) : [];
    const mapCanvas = paintParkCanvas(codes, park.grid.width, park.grid.height, PX, decor);
    ParkScene.create({
      host: el, mapCanvas, pxPerCell: PX / park.grid.cellM, worldW: park.grid.width * park.grid.cellM, worldH: park.grid.height * park.grid.cellM,
      walkable, onPick: (id) => onSelect.current(id), onCameraChange: bumpCamera,
      onFailure: (message) => { setStatus({ kind: 'failed', message }); sceneRef.current?.destroy(); sceneRef.current = null; },
    }).then((scene) => {
      if (cancelled) { scene.destroy(); return; }
      sceneRef.current = scene;
      const push = () => {
        const s = store.getState();
        if (!s.run) return;
        scene.setAgents(s.agents, s.run.simMs, s.snapshotEpoch);
        scene.setRunClock(s.run.simMs, s.run.requestedSpeed, s.run.status === 'running' && !s.stale);
      };
      push();
      const unsub = store.subscribe(push);
      cleanupRef.current = unsub;
      if (import.meta.env.VITE_RUNTIME_PROFILE === 'fixture') {
        globalThis.__behaviorMap = {
          screenOf: (id) => {
            const p = scene.agentScreenPosition(id);
            const r = el.getBoundingClientRect();
            return p ? { x: p.x + r.left, y: p.y + r.top } : null;
          },
          scale: () => scene.camera.scale,
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
      if (globalThis.__behaviorMap) globalThis.__behaviorMap = undefined;
    };
  }, [park, codes, store, walkable, bumpCamera, attempt]);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => { sceneRef.current?.setColorMode(props.colorMode); }, [props.colorMode, status]);
  useEffect(() => { sceneRef.current?.setSelection(props.selectedId, props.groupIds); }, [props.selectedId, props.groupIds, status]);

  const scene = sceneRef.current;
  const places = useLiveSelector(store, (st) => st.places);
  const labels = scene && status.kind === 'ready' ? park.places.filter((p) => p.kind !== 'entrance').map((p) => {
    const lp = LAYOUT.places.find((x) => x.id === p.id);
    const anchor = lp?.footprint && park.parkId === HARBOR_LIGHTS_PARK_ID
      ? { xM: lp.footprint.x + lp.footprint.w / 2, yM: lp.footprint.y + lp.footprint.h / 2 } : p.entrance;
    const s = scene.camera.worldToScreen(anchor);
    const view = places.get(p.id);
    return { p, s, closed: view?.closed ?? false, wait: view?.predictedWaitMs ?? null };
  }) : [];

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
      data-testid="park-map" data-map-status={status.kind}>
      {labels.map(({ p, s, closed, wait }) => (
        <div key={p.id} aria-hidden="true" style={{ position: 'absolute', left: s.x, top: s.y, transform: 'translate(-50%, -50%)', pointerEvents: 'none',
          fontSize: 11, fontWeight: 700, color: '#fff', textShadow: '0 1px 2px #000, 0 0 3px #000', whiteSpace: 'nowrap', textAlign: 'center' }}>
          {p.name}
          {closed && <div style={{ background: '#9b2a1f', borderRadius: 3, padding: '0 4px', marginTop: 2 }}>{'✕'} CLOSED</div>}
          {props.showOperatorTruth && wait !== null && wait > 0 && p.kind === 'ride' && <div style={{ fontWeight: 400, opacity: 0.9 }}>operator est. {Math.round(wait / 60_000)} min</div>}
        </div>
      ))}
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
        <div className="map-overlay bottom-left" style={{ flexDirection: 'column' }}>
          <div className="seg" role="group" aria-label="Zoom">
            <button type="button" onClick={() => sceneRef.current?.zoomBy(1.25)} aria-label="Zoom in">+</button>
            <button type="button" onClick={() => sceneRef.current?.zoomBy(0.8)} aria-label="Zoom out">{'−'}</button>
            <button type="button" onClick={() => sceneRef.current?.fit()} aria-label="Reset zoom to fit the park">Fit</button>
          </div>
        </div>
      )}
    </div>
  );
}
