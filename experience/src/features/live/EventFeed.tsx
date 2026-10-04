import { useState } from 'react';
import type { EventRecord, Id, ParkBundle } from '../../../contract/behavior-v1';
import { useLiveSelector } from '../../data/hooks';
import type { LiveStore } from '../../data/liveStore';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { classifyError } from '../../runtime/errors';
import { formatCents, formatSimClock } from '../../ui/format';

const KNOWN: Record<string, string> = {
  arrived: 'Arrived', observed: 'Observed', queue_joined: 'Joined queue', queue_left: 'Left queue', closure_release: 'Released by closure',
  service_started: 'Service started', service_completed: 'Service completed', purchase: 'Purchase', refund: 'Refund', experience: 'Experience',
  departed: 'Departed', action_failed: 'Action failed', scenario_applied: 'Scenario applied', bump: 'Bump', regrouped: 'Regrouped',
};

/** Renders one event as text. Unknown kinds are shown generically and never interpreted. */
export function EventLine(props: { e: EventRecord; park: ParkBundle; onAgent?: (id: Id) => void }) {
  const { e } = props;
  const place = e.placeId ? props.park.places.find((p) => p.id === e.placeId)?.name ?? e.placeId : null;
  const label = KNOWN[e.kind] ?? `Event "${String(e.kind)}" (unrecognized kind, shown as data)`;
  return (
    <>
      <span className="t">{formatSimClock(e.atMs, props.park.openLocal, true)}</span>
      <span className="grow">
        <strong>{label}</strong>{place ? ` · ${place}` : ''}{e.amountCents !== null ? ` · ${formatCents(e.amountCents)}` : ''}
        {e.experienceDelta !== null ? ` · modeled experience ${e.experienceDelta > 0 ? '+' : ''}${e.experienceDelta}` : ''}
        {e.reason ? <span className="muted"> · {e.reason}</span> : null}
        {e.agentIds.length > 0 && props.onAgent && (
          <span> · {e.agentIds.slice(0, 4).map((id) => <button key={id} type="button" className="btn ghost small mono" onClick={() => props.onAgent!(id)}>{id}</button>)}{e.agentIds.length > 4 ? ` +${e.agentIds.length - 4}` : ''}</span>
        )}
      </span>
    </>
  );
}

export function EventFeed(props: { store: LiveStore; park: ParkBundle; runId: Id; onAgent: (id: Id) => void }) {
  const events = useLiveSelector(props.store, (s) => s.events);
  const rt = useRuntime();
  const [older, setOlder] = useState<{ items: EventRecord[]; next: number | null; error: string | null; loading: boolean } | null>(null);
  const loadPage = async (after: number) => {
    setOlder((o) => ({ items: o?.items ?? [], next: o?.next ?? null, error: null, loading: true }));
    try {
      const page = await rt.client.query('getEvents', { runId: props.runId, afterSequence: after, limit: 100 });
      setOlder((o) => ({ items: [...(o?.items ?? []), ...page.items].slice(-1000), next: page.nextAfterSequence, error: null, loading: false }));
    } catch (e) {
      setOlder((o) => ({ items: o?.items ?? [], next: o?.next ?? null, error: classifyError(e).error.message, loading: false }));
    }
  };
  const recent = [...events].reverse().slice(0, 120);
  return (
    <section aria-label="Event feed" data-testid="event-feed">
      <div className="spread" style={{ padding: '6px 16px' }}>
        <h3 style={{ margin: 0 }}>Events <span className="small muted">(latest {recent.length}; bounded)</span></h3>
        <button type="button" className="btn small" onClick={() => void loadPage(0)}>Full history from opening</button>
      </div>
      <ul className="feed-list" aria-live="off">
        {recent.map((e) => <li key={e.sequence}><EventLine e={e} park={props.park} onAgent={props.onAgent} /></li>)}
      </ul>
      {older && (
        <div style={{ padding: '6px 16px' }}>
          <h4>History (pages of 100, oldest first)</h4>
          {older.error && <p className="small" role="alert">{older.error}</p>}
          <ul className="feed-list">{older.items.map((e) => <li key={`h${e.sequence}`}><EventLine e={e} park={props.park} onAgent={props.onAgent} /></li>)}</ul>
          {older.next !== null && <button type="button" className="btn small" disabled={older.loading} onClick={() => void loadPage(older.next!)}>Load next page</button>}
          {older.next === null && !older.loading && <p className="small muted">End of committed history.</p>}
        </div>
      )}
    </section>
  );
}
