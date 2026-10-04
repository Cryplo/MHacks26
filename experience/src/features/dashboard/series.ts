/**
 * Pure chart derivations from Engine data (unit tested). Nothing here redefines a KPI: series
 * are Engine's own metric values over time, per-interval differences of Engine's cumulative
 * counts, or sums of Engine heatmap cells grouped by the nearest place.
 */
import type { AgentView, Heatmap, Id, MetricId, MetricSnapshot, ParkBundle } from '../../../contract/behavior-v1';
import { STATE_STYLE } from '../../renderer/colors';
import type { PlaceSample } from '../../data/history';
import { cellCenter } from '../results/heat';
import type { Pt } from './charts';

/** At most `max` snapshots, evenly spaced in time (keeps the last one). */
export function downsample(ms: readonly MetricSnapshot[], max = 120): MetricSnapshot[] {
  if (ms.length <= max) return [...ms];
  const out: MetricSnapshot[] = [];
  const span = ms[ms.length - 1]!.simMs - ms[0]!.simMs;
  let next = ms[0]!.simMs;
  for (const m of ms) if (m.simMs >= next) { out.push(m); next = m.simMs + span / (max - 1); }
  if (out[out.length - 1] !== ms[ms.length - 1]) out.push(ms[ms.length - 1]!);
  return out;
}

export const metricPoints = (ms: readonly MetricSnapshot[], id: MetricId): Pt[] => ms.map((m) => ({ t: m.simMs, v: m.measures[id].value }));
export const occupancyPoints = (ms: readonly MetricSnapshot[]): Pt[] => ms.map((m) => ({ t: m.simMs, v: m.guestsInPark }));

/** Change of a cumulative Engine value per fixed interval (e.g. revenue per 15 sim-min). */
export function perInterval(ms: readonly MetricSnapshot[], id: MetricId, bucketMs: number, untilMs: number): { t: number; v: number }[] {
  if (!ms.length) return [];
  const out: { t: number; v: number }[] = [];
  let prev = 0;
  let i = 0;
  for (let t = bucketMs; t <= Math.max(bucketMs, untilMs + bucketMs - 1); t += bucketMs) {
    let last: MetricSnapshot | null = null;
    while (i < ms.length && ms[i]!.simMs <= t) last = ms[i++]!;
    const cur = last?.measures[id].value ?? prev;
    out.push({ t: t - bucketMs, v: Math.max(0, cur - prev) });
    prev = cur;
    if (t >= untilMs) break;
  }
  return out;
}

export function peak(points: Pt[]): { t: number; v: number } | null {
  let best: { t: number; v: number } | null = null;
  for (const p of points) if (p.v !== null && (!best || p.v > best.v)) best = { t: p.t, v: p.v };
  return best;
}

export const placeQueuePoints = (samples: readonly PlaceSample[], placeId: Id): Pt[] => samples.map((s) => ({ t: s.atMs, v: s.places[placeId]?.queue ?? 0 }));

/** Sums heatmap cells by the nearest place entrance (within `radiusM`); the rest is "elsewhere". */
export function byNearestPlace(h: Heatmap, park: ParkBundle, kinds: string[] | null, radiusM = 30): { id: Id; name: string; value: number }[] {
  const places = park.places.filter((p) => !kinds || kinds.includes(p.kind));
  const totals = new Map<Id, number>();
  let elsewhere = 0;
  h.values.forEach((v, i) => {
    if (v <= 0) return;
    const c = cellCenter(h, i);
    let best: { id: Id; d: number } | null = null;
    for (const p of places) {
      const d = Math.hypot(p.entrance.xM - c.xM, p.entrance.yM - c.yM);
      if (!best || d < best.d) best = { id: p.id, d };
    }
    if (best && best.d <= radiusM) totals.set(best.id, (totals.get(best.id) ?? 0) + v); else elsewhere += v;
  });
  const rows = [...totals.entries()].map(([id, value]) => ({ id, name: park.places.find((p) => p.id === id)?.name ?? id, value }));
  if (elsewhere > 0) rows.push({ id: '_elsewhere', name: 'Elsewhere', value: elsewhere });
  return rows.sort((a, b) => b.value - a.value);
}

/** Latest synthetic rating per guest, binned 0–100 in five bands. Unrated guests are excluded. */
export function ratingBins(agents: Iterable<AgentView>): { label: string; value: number }[] {
  const labels = ['0–20', '20–40', '40–60', '60–80', '80–100'];
  const counts = [0, 0, 0, 0, 0];
  for (const a of agents) if (a.rating) counts[Math.min(4, Math.floor(a.rating.value / 20))]!++;
  return labels.map((label, i) => ({ label, value: counts[i]! }));
}

/** Hour ticks across [0, horizon] as park-local labels. */
export function hourTicks(horizonMs: number, openLocal: string, label: (ms: number) => string, maxTicks = 8): { t: number; label: string }[] {
  const open = Number(openLocal.slice(0, 2)) * 60 + Number(openLocal.slice(3));
  const first = (Math.ceil(open / 60) * 60 - open) * 60_000;
  const hours = Math.floor((horizonMs - first) / 3600_000) + 1;
  const every = Math.max(1, Math.ceil(hours / maxTicks));
  const out: { t: number; label: string }[] = [];
  for (let k = 0; k < hours; k += every) out.push({ t: first + k * 3600_000, label: label(first + k * 3600_000) });
  return out;
}

/** True when Engine attaches the per-place/per-state breakdown to its metric snapshots. */
export const hasBreakdown = (ms: readonly MetricSnapshot[]) => ms.some((m) => m.breakdown);

/** People in line at a place over time, from Engine's metric breakdown. */
export const breakdownQueuePoints = (ms: readonly MetricSnapshot[], placeId: Id): Pt[] => ms.filter((m) => m.breakdown).map((m) => {
  const p = m.breakdown!.places.find((x) => x.placeId === placeId);
  return { t: m.simMs, v: p ? p.standardPersons + p.passPersons : 0 };
});

/** Latest cumulative revenue and guests served per place, from the breakdown. */
export function placeTotals(m: MetricSnapshot | null, park: ParkBundle): { id: Id; name: string; revenue: number; served: number }[] {
  if (!m?.breakdown) return [];
  return m.breakdown.places.map((p) => ({ id: p.placeId, name: park.places.find((x) => x.id === p.placeId)?.name ?? p.placeId, revenue: p.revenueCents, served: p.servedGuests }));
}

/** Satisfaction levels (0..K-1) from the breakdown as 0-100 labels. */
export function levelBins(levels: number[]): { label: string; value: number }[] {
  const k = levels.length;
  return levels.map((v, i) => ({ label: String(Math.round((100 * i) / Math.max(1, k - 1))), value: v }));
}

/** What guests are doing right now, largest first (from the breakdown or the agent list). */
export function activityMix(m: MetricSnapshot | null, agents: Iterable<AgentView>): { state: AgentView['state']; label: string; value: number }[] {
  const counts = new Map<AgentView['state'], number>();
  if (m?.breakdown) for (const [k, v] of Object.entries(m.breakdown.states)) counts.set(k as AgentView['state'], v ?? 0);
  else for (const a of agents) counts.set(a.state, (counts.get(a.state) ?? 0) + 1);
  counts.delete('not_arrived'); counts.delete('left');
  return [...counts.entries()].filter(([, v]) => v > 0).map(([state, value]) => ({ state, label: STATE_STYLE[state].label, value })).sort((a, b) => b.value - a.value);
}
