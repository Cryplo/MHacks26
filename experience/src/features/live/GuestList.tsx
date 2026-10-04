import { useMemo, useState } from 'react';
import type { Id } from '../../../contract/behavior-v1';
import { useLiveSelector } from '../../data/hooks';
import type { LiveStore } from '../../data/liveStore';
import { STATE_STYLE, SHAPE_GLYPH } from '../../renderer/colors';

const LIMIT = 80;

/** Keyboard/screen-reader alternative to canvas picking. */
export function GuestList(props: { store: LiveStore; selectedId: Id | null; onSelect: (id: Id) => void }) {
  const agents = useLiveSelector(props.store, (s) => s.agents);
  const [q, setQ] = useState('');
  const [decided, setDecided] = useState(false);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = [...agents.values()].filter((a) => !decided || a.latestEvidenceId !== null).sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
    return needle ? all.filter((a) => a.agentId.toLowerCase().includes(needle) || a.groupId.toLowerCase().includes(needle) || a.state.includes(needle)) : all;
  }, [agents, q, decided]);
  return (
    <div className="stack" data-testid="guest-list">
      <label className="row small"><input type="checkbox" checked={decided} onChange={(e) => setDecided(e.target.checked)} data-testid="only-decided" /> Only guests with a recorded decision</label>
      <label className="field">
        <span className="label">Find a guest</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Guest ID, group ID or activity (e.g. queueing)" aria-describedby="guest-count" />
      </label>
      <p id="guest-count" className="small muted" aria-live="polite">{list.length} guest(s) in park match{list.length > LIMIT ? `; showing the first ${LIMIT}` : ''}.</p>
      <ul className="guest-list">
        {list.slice(0, LIMIT).map((a) => {
          const st = STATE_STYLE[a.state];
          return (
            <li key={a.agentId}>
              <button type="button" aria-pressed={props.selectedId === a.agentId} onClick={() => props.onSelect(a.agentId)} data-agent-id={a.agentId}>
                <span><span className="mono">{a.agentId}</span> <span className="muted small">group {a.groupId}</span></span>
                <span className="small"><span aria-hidden="true">{SHAPE_GLYPH[st.shape]}</span> {st.label}{a.latestEvidenceId ? ' · decision' : ''}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
