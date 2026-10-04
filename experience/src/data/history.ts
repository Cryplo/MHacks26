/**
 * Run history for charts: Engine's recorded metric snapshots (getMetrics) and per-place
 * queue samples read from recorded frames (getFrames). Both are immutable once recorded,
 * so they are fetched incrementally as the run advances and never refetched.
 */
import { useEffect, useRef, useState } from 'react';
import type { Id, MetricSnapshot, ReplayFrame, RuntimeClient } from '../../contract/behavior-v1';
import { useRuntime } from '../runtime/RuntimeProvider';

export type PlacePoint = { queue: number; waitMs: number | null; closed: boolean };
export type PlaceSample = { atMs: number; inPark: number; places: Record<Id, PlacePoint> };
export type RunHistory = { metrics: MetricSnapshot[]; samples: PlaceSample[]; ready: boolean };

export function sampleFromFrame(f: ReplayFrame): PlaceSample {
  const places: Record<Id, PlacePoint> = {};
  for (const p of f.snapshot.places) places[p.placeId] = { queue: 0, waitMs: p.predictedWaitMs, closed: p.closed };
  for (const q of f.snapshot.queues) {
    const cur = places[q.placeId] ?? { queue: 0, waitMs: null, closed: false };
    places[q.placeId] = { ...cur, queue: q.standardPersons + q.passPersons };
  }
  return { atMs: f.atMs, inPark: f.snapshot.metrics.guestsInPark, places };
}

/** Sample spacing for per-place series: ~36 points across the horizon, on 5-minute marks. */
export const sampleEveryMs = (horizonMs: number) => Math.max(5, Math.round(horizonMs / 36 / 300_000) * 5) * 60_000;

async function fetchMetrics(client: RuntimeClient, runId: Id, fromMs: number, toMs: number): Promise<MetricSnapshot[]> {
  const out: MetricSnapshot[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 40; i++) {
    const page: { items: MetricSnapshot[]; nextCursor: string | null } = await client.query('getMetrics', { runId, fromMs, toMs, cursor });
    out.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

async function fetchSample(client: RuntimeClient, runId: Id, t: number, every: number): Promise<PlaceSample | null> {
  for (const span of [0, every * 2 + 1000]) {
    const page = await client.query('getFrames', { runId, fromMs: t, toMs: t + span, cursor: null });
    const f = page.items[0];
    if (f) return sampleFromFrame(f);
  }
  return null;
}

/** Keep the latest revision per simulated time, sorted. */
function mergeMetrics(a: MetricSnapshot[], b: MetricSnapshot[]): MetricSnapshot[] {
  const by = new Map<number, MetricSnapshot>();
  for (const m of [...a, ...b]) { const o = by.get(m.simMs); if (!o || m.revision >= o.revision) by.set(m.simMs, m); }
  return [...by.values()].sort((x, y) => x.simMs - y.simMs);
}

export function useRunHistory(runId: Id, untilMs: number | null, opts: { horizonMs: number; frameEveryMs: number; enabled?: boolean; samples?: boolean }): RunHistory {
  const { client } = useRuntime();
  const [state, setState] = useState<RunHistory>({ metrics: [], samples: [], ready: false });
  const until = useRef(untilMs);
  until.current = untilMs;
  const enabled = opts.enabled ?? true;
  const every = sampleEveryMs(opts.horizonMs);
  const frameEvery = opts.frameEveryMs;
  // Per-place samples read whole frames; only fetch them while a view needs them.
  const wantSamples = useRef(opts.samples ?? true);
  wantSamples.current = opts.samples ?? true;

  // One polling loop per run: it catches up to the current head, then waits for it to move.
  // Head changes never cancel an in-flight page (at 60x the head moves every second).
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let metricsTo = -1;
    const samples = new Map<number, PlaceSample>();
    const misses = new Set<number>();
    let metricsHaveBreakdown = false;
    setState({ metrics: [], samples: [], ready: false });
    void (async () => {
      while (alive) {
        const target = until.current;
        if (target !== null) {
          try {
            if (target > metricsTo) {
              const fresh = await fetchMetrics(client, runId, metricsTo + 1, target);
              if (!alive) return;
              metricsTo = target;
              if (fresh.some((m) => m.breakdown)) metricsHaveBreakdown = true;
              setState((s) => ({ ...s, metrics: mergeMetrics(s.metrics, fresh), ready: true }));
            }
            let budget = 3; // a few frames per pass keeps the page responsive while catching up
            // Engine's metric breakdown already carries per-place queues; frames are only a fallback.
            const needFrames = wantSamples.current && !metricsHaveBreakdown;
            for (let t = 0; t <= target && alive && needFrames && budget > 0; t += every) {
              if (samples.has(t) || misses.has(t)) continue;
              budget--;
              const smp = await fetchSample(client, runId, t, frameEvery);
              if (!alive) return;
              if (smp) samples.set(t, smp); else if (t < target - 120_000) misses.add(t); else break;
              setState((st) => ({ ...st, samples: [...samples.values()].sort((a, b) => a.atMs - b.atMs), ready: true }));
            }
          } catch {
            // History is context for charts; a failed page is retried on the next pass.
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => { alive = false; };
  }, [client, runId, enabled, every, frameEvery]);
  return state;
}
