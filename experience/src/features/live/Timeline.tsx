import { useRef, useState } from 'react';
import { formatSimClock } from '../../ui/format';

/** "9 AM", "10:30 AM": short park-local labels for ticks. */
export function shortClock(ms: number, openLocal: string) {
  return formatSimClock(ms, openLocal).replace(':00 ', ' ');
}

/**
 * The run's day as a scrubber: opening on the left, the horizon on the right, the recorded
 * part filled up to the live head. Dragging into the past shows that moment from recorded
 * frames; "Live" returns to the stream. Keyboard: arrows +/-1 min, PageUp/Down 10 min, Home/End.
 */
export function Timeline(props: {
  openLocal: string; horizonMs: number; headMs: number; viewMs: number; scrubbing: boolean; terminal: boolean;
  onScrub: (ms: number) => void; onCommit?: (ms: number, released?: boolean) => void; onLive: () => void; stepMs: number;
  /** Operators on a running run: releasing beyond the live head fast-forwards the simulation there. */
  onFastForward?: (ms: number) => void; ffTargetMs?: number | null; onCancelFastForward?: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const H = Math.max(1, props.horizonMs);
  const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / H) * 100))}%`;
  const snap = (ms: number) => Math.min(props.headMs, Math.max(0, Math.round(ms / props.stepMs) * props.stepMs));
  const canSkip = Boolean(props.onFastForward) && !props.terminal;
  const msAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return ((clientX - r.left) / Math.max(1, r.width)) * H;
  };
  const hours: number[] = [];
  const open = Number(props.openLocal.slice(0, 2)) * 60 + Number(props.openLocal.slice(3));
  for (let m = Math.ceil(open / 60) * 60 - open; m * 60_000 <= H; m += 60) hours.push(m * 60_000);
  const atLive = !props.scrubbing;
  const key = (e: React.KeyboardEvent) => {
    const d: Record<string, number> = { ArrowLeft: -60_000, ArrowRight: 60_000, ArrowDown: -60_000, ArrowUp: 60_000, PageDown: -600_000, PageUp: 600_000 };
    let next: number | null = null;
    if (e.key in d) next = props.viewMs + d[e.key]!;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') { e.preventDefault(); props.onLive(); return; }
    if (next === null) return;
    e.preventDefault();
    const v = snap(next);
    if (v >= props.headMs && !props.terminal) props.onLive(); else { props.onScrub(v); props.onCommit?.(v); }
  };
  return (
    <div className="timeline-bar" data-testid="timeline">
      <div className="tl-track-wrap"
        onPointerMove={(e) => { const ms = msAt(e.clientX); setHoverMs(Math.max(0, Math.min(H, ms))); if (dragging) props.onScrub(snap(ms)); }}
        onPointerLeave={() => setHoverMs(null)}
        onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setDragging(true); props.onScrub(snap(msAt(e.clientX))); }}
        onPointerUp={(e) => {
          setDragging(false);
          const raw = Math.max(0, Math.min(H, msAt(e.clientX)));
          if (canSkip && raw > props.headMs + props.stepMs) { props.onFastForward!(Math.round(raw / 60_000) * 60_000); return; }
          const v = snap(raw);
          if (v >= props.headMs - props.stepMs && !props.terminal) props.onLive(); else props.onCommit?.(v, true);
        }}>
        <div className="tl-track" ref={track}>
          {/* Faint: everything recorded so far. Solid: up to the moment on screen (like a video bar). */}
          <div className="tl-recorded" style={{ width: pct(props.headMs) }} />
          <div className="tl-played" style={{ width: pct(Math.min(props.viewMs, props.headMs)) }} />
          {props.ffTargetMs != null && <span className="tl-target" style={{ left: pct(props.ffTargetMs) }} title="Fast-forward target" />}
          {hours.map((h) => <span key={h} className="tl-tick" style={{ left: pct(h) }} />)}
          {!props.terminal && <span className="tl-head" style={{ left: pct(props.headMs) }} title="Live" />}
          <span className={`tl-knob ${atLive ? 'live' : ''}`} style={{ left: pct(props.viewMs) }}
            role="slider" tabIndex={0} aria-label="Simulation time" aria-valuemin={0} aria-valuemax={props.headMs} aria-valuenow={props.viewMs}
            aria-valuetext={`${formatSimClock(props.viewMs, props.openLocal)}${atLive && !props.terminal ? ', live' : ''}`} onKeyDown={key} data-testid="timeline-knob" />
          {hoverMs !== null && (
            <span className="tl-hover" style={{ left: pct(hoverMs) }}>
              {hoverMs > props.headMs + props.stepMs
                ? (canSkip ? `Skip ahead to ${formatSimClock(Math.round(hoverMs / 60_000) * 60_000, props.openLocal)}` : 'Not simulated yet')
                : formatSimClock(Math.min(hoverMs, props.headMs), props.openLocal)}
            </span>
          )}
        </div>
        <div className="tl-labels" aria-hidden="true">
          {hours.map((h, i) => (i % Math.ceil(hours.length / 10) === 0 ? <span key={h} style={{ left: pct(h) }}>{shortClock(h, props.openLocal)}</span> : null))}
        </div>
      </div>
      {props.ffTargetMs != null
        ? <span className="tl-live ff" data-testid="ff-indicator" title={`Fast-forwarding to ${formatSimClock(props.ffTargetMs, props.openLocal)}`}>Skipping to {shortClock(Math.round(props.ffTargetMs / 60_000) * 60_000, props.openLocal)}<button type="button" className="tl-ff-cancel" onClick={props.onCancelFastForward} aria-label="Stop fast-forward">×</button></span>
        : props.terminal
        ? <span className="tl-live recorded" title="This run has finished; the timeline is a full recording">Recording</span>
        : atLive
          ? <span className="tl-live on" data-testid="live-indicator"><span className="dot" aria-hidden="true" />Live</span>
          : <button type="button" className="tl-live off" onClick={props.onLive} data-testid="back-to-live">Back to live</button>}
    </div>
  );
}
