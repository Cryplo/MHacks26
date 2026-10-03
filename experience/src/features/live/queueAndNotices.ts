/**
 * Display summaries computed ONLY from authoritative Engine records: QueueView membership
 * and committed `observed` events. No counts are invented and no line is reordered.
 */
import type { EventRecord, Id, QueueView } from '../../../contract/behavior-v1';

export function queueLabel(q: QueueView | undefined): string | null {
  if (!q || (q.standardPersons === 0 && q.passPersons === 0)) return null;
  return q.passPersons > 0 ? `queue ${q.standardPersons} + pass ${q.passPersons}` : `queue ${q.standardPersons}`;
}

export type NoticeObservation = { placeId: Id; version: string; observers: Id[]; events: number; firstAtMs: number; lastAtMs: number };

/** Groups observed-notice events by place and content version (version from event details when reported). */
export function noticeObservations(events: readonly EventRecord[]): NoticeObservation[] {
  const out = new Map<string, NoticeObservation>();
  for (const e of events) {
    if (e.kind !== 'observed' || !e.placeId) continue;
    const d = e.details;
    const version = d && typeof d === 'object' && !Array.isArray(d) && typeof d.contentVersion === 'string' ? d.contentVersion : 'version not reported';
    const key = `${e.placeId}|${version}`;
    const cur = out.get(key) ?? { placeId: e.placeId, version, observers: [], events: 0, firstAtMs: e.atMs, lastAtMs: e.atMs };
    cur.events++;
    for (const a of e.agentIds) if (!cur.observers.includes(a)) cur.observers.push(a);
    cur.firstAtMs = Math.min(cur.firstAtMs, e.atMs);
    cur.lastAtMs = Math.max(cur.lastAtMs, e.atMs);
    out.set(key, cur);
  }
  return [...out.values()].sort((a, b) => a.placeId.localeCompare(b.placeId) || a.version.localeCompare(b.version));
}
