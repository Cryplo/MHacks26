import { useState } from 'react';
import { EXPERIENCE_BINS, hex, SATISFACTION_BINS, SHAPE_GLYPH, STATE_STYLE, UNRATED_COLOR, type ColorMode } from '../../renderer/colors';
import { formatSimClock } from '../../ui/format';

export function Legend(props: { mode: ColorMode; onMode: (m: ColorMode) => void; openLocal: string; asOfSimMs: number | null }) {
  const [open, setOpen] = useState(true);
  const states = (['walking', 'browsing', 'deciding', 'queueing', 'riding', 'eating', 'resting'] as const).map((k) => STATE_STYLE[k]);
  const sw = (color: number, glyph: string) => <span className="swatch" aria-hidden="true" style={{ color: hex(color) }}>{glyph}</span>;
  return (
    <div className="floating legend" aria-label="Map legend" data-testid="legend" role="group">
      <div className="legend-toggle">
        <div className="seg" role="group" aria-label="Colour guests by">
          <button type="button" aria-pressed={props.mode === 'state'} onClick={() => props.onMode('state')}>Activity</button>
          <button type="button" aria-pressed={props.mode === 'experience'} onClick={() => props.onMode('experience')}>Experience</button>
          <button type="button" aria-pressed={props.mode === 'satisfaction'} onClick={() => props.onMode('satisfaction')}>Rating</button>
        </div>
        <button type="button" className="btn ghost small icon" aria-expanded={open} aria-label={open ? 'Collapse legend' : 'Expand legend'} onClick={() => setOpen((o) => !o)}>
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d={open ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'} /></svg>
        </button>
      </div>
      <div hidden={!open} className="stack" style={{ gap: 6 }}>
        {props.mode === 'state' && <div className="legend-items">{states.map((s) => <div key={s.label}>{sw(s.color, SHAPE_GLYPH[s.shape])}{s.label}</div>)}</div>}
        {props.mode === 'experience' && (
          <>
            <div className="legend-items single">{EXPERIENCE_BINS.map((b) => <div key={b.label}>{sw(b.color, '●')}{b.label}</div>)}</div>
            <span className="legend-note">Modeled experience points (a deterministic ledger, not a survey). Shape still shows activity.</span>
          </>
        )}
        {props.mode === 'satisfaction' && (
          <>
            <div className="legend-items single">
              {SATISFACTION_BINS.map((b) => <div key={b.label}>{sw(b.color, '●')}{b.label}</div>)}
              <div>{sw(UNRATED_COLOR, SHAPE_GLYPH.hollow)}Not yet rated</div>
              <div><span className="swatch" aria-hidden="true" style={{ opacity: 0.45 }}>●</span>Faded: rating older than 30 min</div>
            </div>
            <span className="legend-note">Synthetic 0–100 rating from periodic jobs, not a human survey{props.asOfSimMs !== null ? `; latest as of ${formatSimClock(props.asOfSimMs, props.openLocal)}` : ''}.</span>
          </>
        )}
      </div>
    </div>
  );
}
