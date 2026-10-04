import { useState } from 'react';
import type { EventRecord, Id, ParkBundle } from '../../../contract/behavior-v1';
import { useLiveSelector } from '../../data/hooks';
import type { LiveStore } from '../../data/liveStore';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { classifyError } from '../../runtime/errors';
import { formatCents, formatSimClock } from '../../ui/format';
import { guestName } from '../../domain/guestNames';

const KNOWN: Record<string, string> = {
  arrived: 'Arrived', observed: 'Observed', queue_joined: 'Joined queue', queue_left: 'Left queue', closure_release: 'Released by closure',
  service_started: 'Service started', service_completed: 'Service completed', purchase: 'Purchase', refund: 'Refund', experience: 'Experience',
  departed: 'Departed', action_failed: 'Action failed', scenario_applied: 'Scenario applied', bump: 'Bump', regrouped: 'Regrouped',
};

/** Text for one event. Unknown kinds are shown generically and never interpreted. */
export function describeEvent(e: EventRecord, park: ParkBundle): { label: string; detail: string } {
  const place = e.placeId ? park.places.find((p) => p.id === e.placeId)?.name ?? e.placeId : null;
  const label = KNOWN[e.kind] ?? `Event "${String(e.kind)}" (unrecognized kind, shown as data)`;
  const bits = [place, e.amountCents !== null ? formatCents(e.amountCents) : null,
    e.experienceDelta !== null ? `experience ${e.experienceDelta > 0 ? '+' : ''}${e.experienceDelta}` : null, e.reason].filter(Boolean);
  return { label, detail: bits.join(' · ') };
}

export function EventLine(props: { e: EventRecord; park: ParkBundle; onAgent?: (id: Id) => void }) {
  const { e } = props;
  const d = describeEvent(e, props.park);
  return (
    <>
      <span className="t">{formatSimClock(e.atMs, props.park.openLocal, true)}</span>
      <span className="grow">
        <strong>{d.label}</strong>{d.detail ? <span className="muted"> · {d.detail}</span> : null}
        {e.agentIds.length > 0 && props.onAgent && (
          <span> {e.agentIds.slice(0, 3).map((id) => <button key={id} type="button" className="chip-btn" onClick={() => props.onAgent!(id)} aria-label={`Inspect ${guestName(id, e.groupId)}`}>{guestName(id, e.groupId).split(' ')[0]}</button>)}{e.agentIds.length > 3 ? <span className="faint tiny"> +{e.agentIds.length - 3}</span> : ''}</span>
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
    <section aria-label="Activity" data-testid="event-feed" className="stack" style={{ gap: 8 }}>
      {recent.length === 0 && <p className="small muted">No activity yet.</p>}
      <ul className="feed-list" aria-live="off">
        {recent.map((e) => <li key={e.sequence}><EventLine e={e} park={props.park} onAgent={props.onAgent} /></li>)}
      </ul>
      {!older && <div><button type="button" className="link-btn small" onClick={() => void loadPage(0)}>Load full history from opening</button></div>}
      {older && (
        <div className="stack" style={{ gap: 6 }}>
          <h4 style={{ margin: '8px 0 0' }}>Full history (oldest first)</h4>
          {older.error && <p className="small" role="alert">{older.error}</p>}
          <ul className="feed-list history">{older.items.map((e) => <li key={`h${e.sequence}`}><EventLine e={e} park={props.park} onAgent={props.onAgent} /></li>)}</ul>
          {older.next !== null && <div><button type="button" className="btn small" disabled={older.loading} onClick={() => void loadPage(older.next!)}>Load next 100</button></div>}
          {older.next === null && !older.loading && <p className="note">End of committed history.</p>}
        </div>
      )}
    </section>
  );
}
