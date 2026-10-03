/**
 * Display-only derivations from Engine metrics. These never redefine a KPI: the revenue
 * rate is the change in Engine's net ancillary revenue divided by the ACTUAL simulated
 * duration between the two snapshots used (not wall-clock animation time).
 */
import type { MetricSnapshot } from '../../contract/behavior-v1';

export type RatePoint = { fromMs: number; toMs: number; centsPerHour: number | null };

export function revenueRateSeries(history: readonly MetricSnapshot[], bucketMs: number, maxPoints = 24): RatePoint[] {
  if (history.length < 2) return [];
  // The latest snapshot at or before each bucket boundary, plus the newest snapshot.
  const picked: MetricSnapshot[] = [];
  let nextBoundary = Math.floor(history[0]!.simMs / bucketMs) * bucketMs;
  for (let i = 0; i < history.length; i++) {
    const h = history[i]!;
    const next = history[i + 1];
    if (h.simMs >= nextBoundary && (!next || next.simMs > h.simMs)) {
      if (!picked.length || picked[picked.length - 1]!.simMs !== h.simMs) picked.push(h);
      nextBoundary = (Math.floor(h.simMs / bucketMs) + 1) * bucketMs;
    }
  }
  const last = history[history.length - 1]!;
  if (picked[picked.length - 1]!.simMs !== last.simMs) picked.push(last);
  const out: RatePoint[] = [];
  for (let i = 1; i < picked.length; i++) {
    const a = picked[i - 1]!; const b = picked[i]!;
    const durH = (b.simMs - a.simMs) / 3600_000;
    const ra = a.measures.net_revenue_cents.value; const rb = b.measures.net_revenue_cents.value;
    out.push({ fromMs: a.simMs, toMs: b.simMs, centsPerHour: durH > 0 && ra !== null && rb !== null ? (rb - ra) / durH : null });
  }
  return out.slice(-maxPoints);
}
