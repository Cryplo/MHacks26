/**
 * Recorded frames for scrubbing. The ONLY runtime surface used to show a past moment is
 * `getFrames`: no subscription, no commands, no product work (inference/narration).
 * Frames are immutable once recorded, so they are cached by time and fetched in small
 * windows around the requested moment (dense frames for big crowds stay cheap).
 */
import type { Id, ReplayFrame, RuntimeClient } from '../../contract/behavior-v1';

export type ReplaySource = { getFrames: (fromMs: number, toMs: number, cursor: string | null) => Promise<{ items: ReplayFrame[]; nextCursor: string | null }> };
export function replaySource(client: RuntimeClient, runId: Id): ReplaySource {
  return { getFrames: (fromMs, toMs, cursor) => client.query('getFrames', { runId, fromMs, toMs, cursor }) };
}

const BACK_MS = 90_000;
const AHEAD_MS = 150_000;

export class FrameCache {
  private frames = new Map<number, ReplayFrame>();
  private times: number[] = [];
  private inflight = new Map<number, Promise<void>>();
  constructor(private readonly src: ReplaySource, private readonly max = 240) {}

  /** Typical spacing of recorded frames (ms), learned from what has been fetched. */
  spacing(fallback: number): number {
    let best = Infinity;
    for (let i = 1; i < this.times.length; i++) best = Math.min(best, this.times[i]! - this.times[i - 1]!);
    return Number.isFinite(best) && best > 0 ? best : fallback;
  }

  /** The latest cached frame at or before `t`, if it is close enough to stand for `t`. */
  cachedAt(t: number, toleranceMs: number): ReplayFrame | null {
    let lo = 0; let hi = this.times.length - 1; let found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (this.times[mid]! <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    if (found < 0) return null;
    const at = this.times[found]!;
    return t - at <= toleranceMs ? this.frames.get(at)! : null;
  }

  async at(t: number, frameEveryMs: number): Promise<ReplayFrame | null> {
    const tol = Math.max(this.spacing(frameEveryMs), frameEveryMs) * 1.5;
    const hit = this.cachedAt(t, tol);
    if (hit) return hit;
    const key = Math.floor(t / AHEAD_MS);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.fetch(Math.max(0, t - BACK_MS), t + AHEAD_MS).then(() => undefined).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    await p;
    return this.cachedAt(t, Infinity) ?? this.frames.get(this.times[0] ?? -1) ?? null;
  }

  // --- Latest-wins loading for scrubbing/playback -------------------------------------
  private target: number | null = null;
  private ahead = false;
  private every = 30_000;
  private loading = false;
  private ranges: { from: number; to: number }[] = [];
  private readonly listeners = new Set<() => void>();

  /** Called whenever newly fetched frames land in the cache. */
  onChange(cb: () => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }

  /**
   * Ask for the moment `t` (and, while playing, the stretch just after it). Only the latest
   * request matters: one loader runs at a time and always works towards the current target,
   * so results are never thrown away because the playhead moved while a fetch was in flight.
   */
  want(t: number, frameEveryMs: number, ahead: boolean) {
    this.target = t; this.every = frameEveryMs; this.ahead = ahead;
    void this.pump();
  }

  private covered(t: number): boolean {
    if (this.cachedAt(t, Math.max(this.spacing(this.every), this.every) * 1.5)) return true;
    return this.ranges.some((r) => t >= r.from && t <= r.to);
  }

  private async pump() {
    if (this.loading) return;
    this.loading = true;
    try {
      for (let guard = 0; guard < 24; guard++) {
        const t = this.target;
        if (t === null) break;
        const need = !this.covered(t) ? t : this.ahead && !this.covered(t + 60_000) ? t + 60_000 : null;
        if (need === null) break;
        const from = Math.max(0, need - 30_000); const to = need + AHEAD_MS;
        const got = await this.fetch(from, to);
        // Remember what was asked for, up to the last frame actually recorded (the live head
        // may still be growing), so an empty stretch is not refetched in a loop.
        this.ranges.push({ from, to: got.complete ? to : Math.max(from, got.last ?? from) });
        if (this.ranges.length > 64) this.ranges.shift();
        this.listeners.forEach((l) => l());
      }
    } catch {
      // Transient query failure: the next request retries.
    } finally {
      this.loading = false;
    }
  }

  private async fetch(from: number, to: number): Promise<{ last: number | null; complete: boolean }> {
    let last: number | null = null; let complete = false;
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page: { items: ReplayFrame[]; nextCursor: string | null } = await this.src.getFrames(from, to, cursor);
      for (const f of page.items) { this.insert(f); last = Math.max(last ?? f.atMs, f.atMs); }
      if (!page.nextCursor) { complete = last !== null && to - last <= this.every * 2; break; }
      cursor = page.nextCursor;
    }
    return { last, complete };
  }

  private insert(f: ReplayFrame) {
    if (!this.frames.has(f.atMs)) {
      let i = this.times.length;
      while (i > 0 && this.times[i - 1]! > f.atMs) i--;
      this.times.splice(i, 0, f.atMs);
    }
    this.frames.set(f.atMs, f);
    while (this.times.length > this.max) {
      // Evict the frame farthest from the most recent insertion (keeps the working window).
      const first = this.times[0]!; const last = this.times[this.times.length - 1]!;
      const drop = Math.abs(first - f.atMs) > Math.abs(last - f.atMs) ? this.times.shift()! : this.times.pop()!;
      this.frames.delete(drop);
      if (drop === first && drop === last) break;
    }
  }

  size = () => this.times.length;
}
