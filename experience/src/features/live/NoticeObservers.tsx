import type { Id, ParkBundle } from '../../../contract/behavior-v1';
import { useLiveSelector } from '../../data/hooks';
import type { LiveStore } from '../../data/liveStore';
import { formatSimClock } from '../../ui/format';
import { guestName } from '../../domain/guestNames';
import { noticeObservations } from './queueAndNotices';

/** Which guests observed which notice VERSION (from committed events in the bounded feed). */
export function NoticeObservers(props: { store: LiveStore; park: ParkBundle; onAgent: (id: Id) => void }) {
  const events = useLiveSelector(props.store, (s) => s.events);
  const rows = noticeObservations(events);
  const name = (id: Id) => props.park.places.find((p) => p.id === id)?.name ?? id;
  return (
    <details className="disclosure" aria-label="Notice observations" data-testid="notice-observers">
      <summary>Who saw which notice<span className="count">{rows.length} version{rows.length === 1 ? '' : 's'}</span></summary>
      <div className="body">
      <p className="note">From observation events in the live feed (latest window). After a notice rewrite, new observers appear under the new version; earlier observers keep the text they saw.</p>
      {rows.length === 0 ? <p className="small muted">No notice observations in the current window.</p> : (
        <table className="small">
          <thead><tr><th>Place</th><th>Version</th><th className="num">Guests</th><th>Window</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.placeId}|${r.version}`}>
                <td>{name(r.placeId)}</td>
                <td>{r.version.replace(/^.*?(v\d+)$/, '$1')}</td>
                <td className="num">
                  <details><summary>{r.observers.length}</summary>
                    {r.observers.slice(0, 30).map((a) => <button key={a} type="button" className="chip-btn" onClick={() => props.onAgent(a)}>{guestName(a)}</button>)}
                  </details>
                </td>
                <td>{formatSimClock(r.firstAtMs, props.park.openLocal)}–{formatSimClock(r.lastAtMs, props.park.openLocal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      </div>
    </details>
  );
}
