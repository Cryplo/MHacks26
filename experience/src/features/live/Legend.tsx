import { EXPERIENCE_BINS, hex, SATISFACTION_BINS, SHAPE_GLYPH, STATE_STYLE, UNRATED_COLOR, type ColorMode } from '../../renderer/colors';
import { formatSimClock } from '../../ui/format';

export function Legend(props: { mode: ColorMode; onMode: (m: ColorMode) => void; openLocal: string; asOfSimMs: number | null }) {
  const states = (['walking', 'browsing', 'deciding', 'queueing', 'riding', 'eating', 'resting'] as const).map((k) => STATE_STYLE[k]);
  return (
    <div className="panel tight legend" aria-label="Map legend" data-testid="legend">
      <div className="seg" role="group" aria-label="Colour guests by">
        <button type="button" aria-pressed={props.mode === 'state'} onClick={() => props.onMode('state')}>Activity</button>
        <button type="button" aria-pressed={props.mode === 'experience'} onClick={() => props.onMode('experience')}>Modeled experience</button>
        <button type="button" aria-pressed={props.mode === 'satisfaction'} onClick={() => props.onMode('satisfaction')}>Satisfaction</button>
      </div>
      {props.mode === 'state' && states.map((s) => (
        <div key={s.label}><span className="swatch" style={{ color: hex(s.color), textShadow: '0 0 1px #000' }}>{SHAPE_GLYPH[s.shape]}</span> {s.label}</div>
      ))}
      {props.mode === 'experience' && (
        <>
          <strong>Modeled experience</strong>
          <span className="muted">Deterministic model ledger (points), not a measurement or survey. Shape still shows activity.</span>
          {EXPERIENCE_BINS.map((b) => <div key={b.label}><span className="swatch" style={{ color: hex(b.color), textShadow: '0 0 1px #000' }}>{'●'}</span> {b.label}</div>)}
        </>
      )}
      {props.mode === 'satisfaction' && (
        <>
          <strong>Synthetic satisfaction rating (0-100)</strong>
          <span className="muted">Periodic frozen rating jobs, not continuous measurement or a human survey. Showing each guest's latest available rating{props.asOfSimMs !== null ? ` as of ${formatSimClock(props.asOfSimMs, props.openLocal)}` : ''}.</span>
          {SATISFACTION_BINS.map((b) => <div key={b.label}><span className="swatch" style={{ color: hex(b.color), textShadow: '0 0 1px #000' }}>{'●'}</span> {b.label}</div>)}
          <div><span className="swatch" style={{ color: hex(UNRATED_COLOR) }}>{SHAPE_GLYPH.hollow}</span> Unrated / not yet available</div>
          <div><span className="swatch" style={{ opacity: 0.45 }}>{'●'}</span> Faded: rating older than 30 simulated minutes</div>
        </>
      )}
    </div>
  );
}
