/**
 * Display interpolation between two AUTHORITATIVE timestamped poses. Rules:
 *  - never extrapolate past the newest authoritative sample;
 *  - do not interpolate across a discontinuity (state change into/out of a service,
 *    impossible speed, a segment crossing non-walkable cells, a new snapshot epoch / seek);
 *    instead hold the older pose until the newer sample's time, then place discretely.
 */
import type { AgentView, Vec2 } from '../../contract/behavior-v1';

export type Sample = { simMs: number; pos: Vec2; state: AgentView['state'] };
export type Track = { prev: Sample | null; latest: Sample; continuous: boolean };

export const MAX_WALK_MPS = 3; // generous upper bound for a walking guest
const GROUND_STATES = new Set<AgentView['state']>(['walking', 'browsing', 'queueing', 'deciding', 'eating', 'shopping', 'resting']);

export type Walkable = (p: Vec2) => boolean;

export function segmentWalkable(a: Vec2, b: Vec2, walkable: Walkable, stepM = 0.25): boolean {
  const len = Math.hypot(b.xM - a.xM, b.yM - a.yM);
  const n = Math.max(1, Math.ceil(len / stepM));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (!walkable({ xM: a.xM + (b.xM - a.xM) * t, yM: a.yM + (b.yM - a.yM) * t })) return false;
  }
  return true;
}

export function isContinuous(prev: Sample, next: Sample, walkable: Walkable): boolean {
  if (next.simMs <= prev.simMs) return false;
  if (!GROUND_STATES.has(prev.state) || !GROUND_STATES.has(next.state)) return false;
  // Entering/leaving a queue or service is a discrete placement, not a walk.
  if ((prev.state === 'queueing') !== (next.state === 'queueing')) return false;
  const dist = Math.hypot(next.pos.xM - prev.pos.xM, next.pos.yM - prev.pos.yM);
  if (dist > (MAX_WALK_MPS * (next.simMs - prev.simMs)) / 1000 + 0.5) return false;
  return segmentWalkable(prev.pos, next.pos, walkable);
}

export function pushSample(track: Track | undefined, s: Sample, walkable: Walkable): Track {
  if (!track) return { prev: null, latest: s, continuous: false };
  if (s.simMs === track.latest.simMs) return { ...track, latest: s, continuous: track.prev ? isContinuous(track.prev, s, walkable) : false };
  if (s.simMs < track.latest.simMs) return { prev: null, latest: s, continuous: false }; // out-of-order: restart honestly
  return { prev: track.latest, latest: s, continuous: isContinuous(track.latest, s, walkable) };
}

export function displayPose(track: Track, renderSimMs: number): { pos: Vec2; state: AgentView['state'] } {
  const { prev, latest } = track;
  if (!prev || renderSimMs >= latest.simMs) return { pos: latest.pos, state: latest.state };
  if (renderSimMs <= prev.simMs) return { pos: prev.pos, state: prev.state };
  if (!track.continuous) return { pos: prev.pos, state: prev.state }; // hold, then snap at latest time
  const t = (renderSimMs - prev.simMs) / (latest.simMs - prev.simMs);
  return { pos: { xM: prev.pos.xM + (latest.pos.xM - prev.pos.xM) * t, yM: prev.pos.yM + (latest.pos.yM - prev.pos.yM) * t }, state: prev.state };
}

/**
 * Render clock trailing the newest authoritative time by a small buffer. Advances only
 * while the run is running; never passes `target`. Paused/blocked runs freeze honestly.
 */
export class RenderClock {
  private display = 0;
  private target = 0;
  private lastWall = 0;
  private speed = 1;
  private running = false;
  constructor(readonly bufferMs = 5000) {}

  update(targetSimMs: number, speed: number, running: boolean, wallMs: number) {
    if (targetSimMs < this.target) this.reset(targetSimMs, wallMs); // seek/back-step
    this.target = targetSimMs;
    this.speed = speed;
    this.running = running;
    if (this.display === 0 && this.lastWall === 0) this.reset(targetSimMs, wallMs);
  }

  reset(targetSimMs: number, wallMs: number) {
    this.target = targetSimMs;
    this.display = Math.max(0, targetSimMs - this.bufferMs);
    this.lastWall = wallMs;
  }

  /** Jump straight to the newest state (after a hidden tab resumes, a seek, etc.). */
  snapToTarget(wallMs: number) {
    this.display = this.target;
    this.lastWall = wallMs;
  }

  tick(wallMs: number): number {
    const dt = Math.max(0, wallMs - this.lastWall);
    this.lastWall = wallMs;
    const lag = this.target - this.display;
    const catchUp = lag > this.bufferMs * 2 ? 2 : 1;
    const advance = this.running || lag > 0 ? dt * Math.max(this.speed, 1) * catchUp : 0;
    this.display = Math.min(this.target, this.display + advance);
    return this.display;
  }
}
