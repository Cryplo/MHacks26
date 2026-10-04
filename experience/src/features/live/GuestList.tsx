import { useMemo, useState } from 'react';
import type { Id } from '../../../contract/behavior-v1';
import { useLiveSelector } from '../../data/hooks';
import type { LiveStore } from '../../data/liveStore';
import { hex, STATE_STYLE, SHAPE_GLYPH } from '../../renderer/colors';
import { Icon } from '../../ui/components';
import { guestName } from '../../domain/guestNames';

const LIMIT = 80;

/** Keyboard/screen-reader alternative to canvas picking. */
export function GuestList(props: { store: LiveStore; selectedId: Id | null; onSelect: (id: Id) => void }) {
  const agents = useLiveSelector(props.store, (s) => s.agents);
  const [q, setQ] = useState('');
  const [decided, setDecided] = useState(false);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = [...agents.values()].filter((a) => a.state !== 'not_arrived' && (!decided || a.latestEvidenceId !== null))
      .map((a) => ({ a, name: guestName(a.agentId, a.groupId) })).sort((x, y) => x.name.localeCompare(y.name));
    return (needle ? all.filter(({ a, name }) => name.toLowerCase().includes(needle) || a.agentId.toLowerCase().includes(needle) || a.state.includes(needle) || STATE_STYLE[a.state].label.toLowerCase().includes(needle)) : all);
  }, [agents, q, decided]);
  return (
    <div className="stack" style={{ gap: 10 }} data-testid="guest-list">
      <label className="sr-only" htmlFor="guest-search">Find a guest</label>
      <div className="search">
        <Icon name="search" size={14} />
        <input id="guest-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or activity (e.g. queue)" aria-describedby="guest-count" />
      </div>
      <div className="spread">
        <span id="guest-count" className="tiny faint" aria-live="polite">{list.length} guest{list.length === 1 ? '' : 's'}{list.length > LIMIT ? ` · showing first ${LIMIT}` : ''}</span>
        <label className="check tiny"><input type="checkbox" checked={decided} onChange={(e) => setDecided(e.target.checked)} data-testid="only-decided" /> With a decision</label>
      </div>
      <ul className="guest-list">
        {list.slice(0, LIMIT).map(({ a, name }) => {
          const st = STATE_STYLE[a.state];
          return (
            <li key={a.agentId}>
              <button type="button" aria-pressed={props.selectedId === a.agentId} onClick={() => props.onSelect(a.agentId)} data-agent-id={a.agentId}>
                <span className="gname">{name}</span>
                <span className="state"><span className="glyph" aria-hidden="true" style={{ color: hex(st.color) }}>{SHAPE_GLYPH[st.shape]}</span>{st.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
