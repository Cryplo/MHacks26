/**
 * Display-only motion smoothing for the live map.
 *
 *  - MotionHistory keeps the last few AUTHORITATIVE samples per guest, so the render clock
 *    (which trails the newest sample) always finds the segment it is in, instead of jumping
 *    when a new sample replaces the only "previous" one.
 *  - AdaptiveClock trails the newest committed time by a buffer sized from the observed
 *    sample cadence (sim spacing and real-time arrival jitter x speed), and steers its rate
 *    gently instead of freezing/jumping when patches arrive early, late or in bursts.
 *  - When the clock runs past the newest sample, a guest walking a continuous segment is
 *    extrapolated briefly along its last velocity (never onto blocked cells); when the real
 *    sample lands, the difference becomes an offset that a critically damped spring removes.
 *  - Hard snaps remain for teleports: epoch changes/seeks, impossible speeds, segments that
 *    cross blocked cells, and entering/leaving a ride or show footprint.
 */
import type { AgentView, Vec2 } from '../../contract/behavior-v1';
import { MAX_WALK_MPS, segmentWalkable, type Sample, type Walkable } from './interpolation';

const SERVICE = new Set<AgentView['state']>(['riding', 'watching']);
const GONE = new Set<AgentView['state']>(['not_arrived', 'left']);
const WALKERS = new Set<AgentView['state']>(['walking', 'browsing', 'deciding', 'queueing']);
// Enough history to cover the trailing buffer at high speed (60x trails ~70 s of sim; live
// samples can be ~3 s apart), otherwise the display falls off the oldest sample and hops.
const MAX_SAMPLES = 64;

/**
 * How the display may move from `a` to `b`: a polyline (start, optional elbow, end) that stays
 * on walkable cells, or null for a discrete placement. Sparse samples (fast playback) often
 * straddle a path corner; the straight chord would cut across blocked ground, so an L-shaped
 * route along the grid axes is tried before giving up.
 */
/** Per-batch work budget for grid routing (node expansions), so a burst can never stall a frame. */
export type RouteBudget = { nodes: number };

export function segmentPath(a: Sample, b: Sample, walkable: Walkable, budget?: RouteBudget): Vec2[] | null {
  if (b.simMs <= a.simMs) return null;
  // Appearing at the gate / leaving the park are real discontinuities.
  if (GONE.has(a.state) || GONE.has(b.state)) return GONE.has(a.state) && GONE.has(b.state) ? [a.pos, b.pos] : null;
  // Boarding / leaving a ride or show: glide between the station and the queue or exit,
  // instead of teleporting a whole group across the plaza.
  if (SERVICE.has(a.state) || SERVICE.has(b.state)) return [a.pos, b.pos];
  const dist = Math.hypot(b.pos.xM - a.pos.xM, b.pos.yM - a.pos.yM);
  if (dist > (MAX_WALK_MPS * (b.simMs - a.simMs)) / 1000 + 1) return null;
  if (dist < 0.75 || segmentWalkable(a.pos, b.pos, walkable)) return [a.pos, b.pos];
  const maxLen = (MAX_WALK_MPS * (b.simMs - a.simMs)) / 1000 + 2;
  for (const elbow of [{ xM: b.pos.xM, yM: a.pos.yM }, { xM: a.pos.xM, yM: b.pos.yM }]) {
    const len = Math.abs(b.pos.xM - a.pos.xM) + Math.abs(b.pos.yM - a.pos.yM);
    if (len > maxLen) break;
    if (segmentWalkable(a.pos, elbow, walkable) && segmentWalkable(elbow, b.pos, walkable)) return [a.pos, elbow, b.pos];
  }
  // Sparse samples (bursty live patches can be 10-40 s of sim apart): route along the grid,
  // within the batch budget. Over budget, short hops still glide; long ones are placed.
  // Out of routing budget: glide straight rather than freeze and teleport.
  if (budget && budget.nodes <= 0) return [a.pos, b.pos];
  const cap = Math.min(budget ? budget.nodes : 3000, Math.ceil(maxLen * maxLen * 0.6) + 200, 3000);
  const used = { n: 0 };
  const r = gridRoute(a.pos, b.pos, walkable, maxLen, cap, used);
  if (budget) budget.nodes -= used.n;
  // No short grid route found: a brief straight glide reads far better than a freeze + jump.
  return r ?? [a.pos, b.pos];
}

/** A* over 1 m cells (8-neighbour, no corner cutting), string-pulled; null if no short route. */
export function gridRoute(a: Vec2, b: Vec2, walkable: Walkable, maxLen: number, maxNodes = 3000, used?: { n: number }): Vec2[] | null {
  const ax = Math.floor(a.xM); const ay = Math.floor(a.yM); const bx = Math.floor(b.xM); const by = Math.floor(b.yM);
  const key = (x: number, y: number) => (y << 12) | x;
  const ok = (x: number, y: number) => walkable({ xM: x + 0.5, yM: y + 0.5 });
  if (!ok(bx, by)) return null;
  const h = (x: number, y: number) => { const dx = Math.abs(x - bx); const dy = Math.abs(y - by); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
  const g = new Map<number, number>(); const from = new Map<number, number>();
  const open: [number, number, number][] = [[h(ax, ay), ax, ay]];
  g.set(key(ax, ay), 0);
  let found = false; let expanded = 0;
  while (open.length && expanded < maxNodes) {
    // Small binary heap.
    const top = open[0]!; const last = open.pop()!;
    if (open.length) { open[0] = last; let i = 0; for (;;) { const l = 2 * i + 1; const r = l + 1; let m = i; if (l < open.length && open[l]![0] < open[m]![0]) m = l; if (r < open.length && open[r]![0] < open[m]![0]) m = r; if (m === i) break; [open[i], open[m]] = [open[m]!, open[i]!]; i = m; } }
    const [, x, y] = top; const k0 = key(x, y); const gc = g.get(k0)!;
    if (x === bx && y === by) { found = true; break; }
    if (gc > maxLen) continue;
    expanded++;
    for (const [dx, dy, c] of [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]] as const) {
      const nx = x + dx; const ny = y + dy;
      if (nx < 0 || ny < 0 || nx > 4095 || !ok(nx, ny)) continue;
      if (dx && dy && (!ok(x + dx, y) || !ok(x, y + dy))) continue;
      const nk = key(nx, ny); const ng = gc + c;
      if (ng >= (g.get(nk) ?? Infinity)) continue;
      g.set(nk, ng); from.set(nk, k0);
      const f = ng + h(nx, ny);
      open.push([f, nx, ny]);
      let i = open.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (open[p]![0] <= open[i]![0]) break; [open[p], open[i]] = [open[i]!, open[p]!]; i = p; }
    }
  }
  if (used) used.n = expanded;
  if (!found) return null;
  const cells: Vec2[] = [];
  for (let k: number | undefined = key(bx, by); k !== undefined && k !== key(ax, ay); k = from.get(k)) cells.push({ xM: (k & 4095) + 0.5, yM: (k >> 12) + 0.5 });
  cells.reverse();
  // String-pull: keep only the points needed for walkable straight legs.
  const pts = [a, ...cells.slice(0, -1), b];
  const out: Vec2[] = [a]; let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !segmentWalkable(pts[i]!, pts[j]!, walkable)) j--;
    out.push(pts[j]!); i = j;
  }
  let len = 0; for (let k = 1; k < out.length; k++) len += Math.hypot(out[k]!.xM - out[k - 1]!.xM, out[k]!.yM - out[k - 1]!.yM);
  return len <= maxLen ? out : null;
}

/** Whether the display may move continuously from `a` to `b`. */
export function smoothSegment(a: Sample, b: Sample, walkable: Walkable): boolean {
  return segmentPath(a, b, walkable) !== null;
}

function along(path: Vec2[], k: number): Vec2 {
  if (path.length === 2) { const [p, q] = path as [Vec2, Vec2]; return { xM: p.xM + (q.xM - p.xM) * k, yM: p.yM + (q.yM - p.yM) * k }; }
  let total = 0; for (let i = 1; i < path.length; i++) total += Math.hypot(path[i]!.xM - path[i - 1]!.xM, path[i]!.yM - path[i - 1]!.yM);
  let d = k * total;
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1]!; const q = path[i]!; const l = Math.hypot(q.xM - p.xM, q.yM - p.yM);
    if (d <= l || i === path.length - 1) { const t = l > 0 ? Math.min(1, d / l) : 1; return { xM: p.xM + (q.xM - p.xM) * t, yM: p.yM + (q.yM - p.yM) * t }; }
    d -= l;
  }
  return path[path.length - 1]!;
}

export class MotionHistory {
  readonly s: Sample[] = [];
  /** cont[i] is the display route for segment s[i-1] -> s[i] (null = discrete placement). */
  readonly cont: (Vec2[] | null)[] = [];
  push(x: Sample, walkable: Walkable, budget?: RouteBudget) {
    const last = this.s[this.s.length - 1];
    if (last && x.simMs < last.simMs) { this.s.length = 0; this.cont.length = 0; } // out of order: restart
    else if (last && x.simMs === last.simMs) { this.s.pop(); this.cont.pop(); }
    const prev = this.s[this.s.length - 1];
    this.s.push(x);
    this.cont.push(prev ? segmentPath(prev, x, walkable, budget) : null);
    while (this.s.length > MAX_SAMPLES) { this.s.shift(); this.cont.shift(); }
  }
  get latest(): Sample { return this.s[this.s.length - 1]!; }

  /** Displayed pose at sim time t; extrapolates at most `extrapMs` past the newest sample. */
  at(t: number, extrapMs: number, walkable: Walkable): { pos: Vec2; state: AgentView['state'] } {
    const s = this.s; const n = s.length;
    if (t <= s[0]!.simMs) return { pos: s[0]!.pos, state: s[0]!.state };
    for (let i = 1; i < n; i++) {
      const b = s[i]!;
      if (t < b.simMs) {
        const a = s[i - 1]!;
        const route = this.cont[i];
        if (!route) return { pos: a.pos, state: a.state }; // hold, then snap at b's time
        return { pos: along(route, (t - a.simMs) / (b.simMs - a.simMs)), state: a.state };
      }
    }
    const b = s[n - 1]!;
    const a = s[n - 2];
    const route = this.cont[n - 1];
    if (!a || !route || !WALKERS.has(b.state) || extrapMs <= 0) return { pos: b.pos, state: b.state };
    const dt = b.simMs - a.simMs;
    const e = Math.min(t - b.simMs, extrapMs, dt);
    // Continue along the last leg of the route (the direction actually walked last).
    const from = route[route.length - 2]!; const leg = Math.hypot(b.pos.xM - from.xM, b.pos.yM - from.yM);
    let total = 0; for (let i = 1; i < route.length; i++) total += Math.hypot(route[i]!.xM - route[i - 1]!.xM, route[i]!.yM - route[i - 1]!.yM);
    const speed = total / dt; const ux = leg > 0 ? (b.pos.xM - from.xM) / leg : 0; const uy = leg > 0 ? (b.pos.yM - from.yM) / leg : 0;
    const p = { xM: b.pos.xM + ux * speed * e, yM: b.pos.yM + uy * speed * e };
    return { pos: walkable(p) ? p : b.pos, state: b.state };
  }
}

/** Render clock with an adaptive trailing buffer and gentle rate steering. */
export class AdaptiveClock {
  display = 0;
  private target = 0;
  private lastWall = 0;
  private lastArrival = 0;
  private speed = 1;
  private running = false;
  /** EMA of sim spacing between committed samples and of real arrival gaps (in sim ms). */
  private simGap = 1000;
  /** Observed sim-ms per wall-ms from arrivals (the engine's achieved rate, not the request). */
  private rate = 1;
  private arrivals = 0;
  private realGapSim = 1000;
  buffer = 1500;
  private started = false;

  update(targetSimMs: number, speed: number, running: boolean, wallMs: number) {
    const sp = Math.max(speed, 0.0001);
    if (this.started && Math.abs(sp - this.speed) > this.speed * 0.05) {
      // Requested speed changed: forget the old arrival-rate estimate (it would make playback
      // run ahead or lag for many seconds) and size the buffer for the new cadence.
      this.rate = sp; this.arrivals = 0;
      this.buffer = Math.max(this.buffer * (sp / this.speed), sp * 1200);
    }
    this.speed = sp; this.running = running;
    if (!this.started) { this.started = true; this.target = targetSimMs; this.lastArrival = wallMs; this.reset(targetSimMs, wallMs); return; }
    if (targetSimMs < this.target) { this.target = targetSimMs; this.arrivals = 0; this.reset(targetSimMs, wallMs); return; }
    if (targetSimMs > this.target) {
      const gap = targetSimMs - this.target;
      const dw = Math.max(1, wallMs - this.lastArrival);
      // Time-weighted EMA (~8 s window) of the arrival rate, so bursty patches never make the
      // playback rate itself wobble.
      const w = 1 - Math.exp(-dw / 8000);
      this.rate = this.arrivals === 0 ? gap / dw : this.rate + (gap / dw - this.rate) * w;
      this.arrivals++;
      const real = dw * Math.max(0.05, this.nominal);
      this.simGap += (gap - this.simGap) * 0.25;
      // Track jitter with a fast attack and slow release so bursts widen the buffer quickly.
      this.realGapSim += (real - this.realGapSim) * (real > this.realGapSim ? 0.5 : 0.08);
      this.lastArrival = wallMs;
      this.target = targetSimMs;
    }
    const want = Math.max(250, Math.min(60_000, 1.35 * Math.max(this.simGap, this.realGapSim)));
    // Widen quickly when patches get burstier; shrink very slowly so the trailing goal (and
    // hence the playback speed) does not visibly change.
    this.buffer += (want - this.buffer) * (want > this.buffer ? 0.2 : 0.01);
  }

  reset(targetSimMs: number, wallMs: number) {
    // Start with ~1.2 s of real-time slack: live patches arrive in bursts, and starting too
    // close to the newest sample makes playback stall against it right away.
    this.buffer = Math.max(this.buffer, this.speed * 1200);
    this.target = targetSimMs;
    this.display = Math.max(0, targetSimMs - this.buffer);
    this.lastWall = wallMs;
  }

  snapToTarget(wallMs: number) { this.display = this.target; this.lastWall = wallMs; }

  /** Nominal playback rate: the observed arrival rate once known, capped near the request. */
  private get nominal() {
    if (this.arrivals < 4) return this.speed;
    // Engine keeping up (within 5% of the request): play at exactly the requested speed.
    return Math.abs(this.rate - this.speed) <= this.speed * 0.05 ? this.speed : Math.min(this.rate, this.speed * 1.5);
  }

  get isRunning() { return this.running; }

  get info() { return { rate: this.rate, display: this.display, target: this.target, buffer: this.buffer, simGap: this.simGap, realGapSim: this.realGapSim, running: this.running, speed: this.speed }; }

  /** How far past the newest sample the display may extrapolate (sim ms). */
  get extrapolation() { return Math.min(this.simGap * 0.6, 4000); }

  tick(wallMs: number): number {
    const dt = Math.min(250, Math.max(0, wallMs - this.lastWall));
    this.lastWall = wallMs;
    if (!this.running) {
      // Paused / blocked: settle onto the committed state, then freeze honestly.
      this.display += (this.target - this.display) * Math.min(1, dt / 150);
      if (Math.abs(this.target - this.display) < 1) this.display = this.target;
      return this.display;
    }
    const goal = this.target - this.buffer;
    const err = goal - this.display;
    if (Math.abs(err) > Math.max(this.buffer * 4, 20_000)) { this.display = goal; return this.display; } // far behind/ahead: resync
    // Constant nominal rate plus a gentle correction (closes the error over ~5 s, never more
    // than ±10% of the nominal rate), so motion keeps a steady pace instead of surging.
    const nominal = this.nominal * dt;
    const correction = Math.max(-0.1 * nominal, Math.min(0.1 * nominal, err * (dt / 5000)));
    const rate = Math.max(0, nominal + correction);
    this.display = Math.min(this.display + rate, this.target + this.extrapolation);
    return this.display;
  }
}

/** Critically damped spring step toward 0 for a 2D offset (Unity-style SmoothDamp). */
export function dampOffset(o: { x: number; y: number; vx: number; vy: number }, smoothTimeS: number, dtS: number) {
  const w = 2 / smoothTimeS; const x = w * dtS;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const tx = (o.vx + w * o.x) * dtS; const ty = (o.vy + w * o.y) * dtS;
  o.vx = (o.vx - w * tx) * e; o.vy = (o.vy - w * ty) * e;
  o.x = (o.x + tx) * e; o.y = (o.y + ty) * e;
  if (Math.abs(o.x) < 1e-4 && Math.abs(o.y) < 1e-4 && Math.abs(o.vx) < 1e-3 && Math.abs(o.vy) < 1e-3) { o.x = o.y = o.vx = o.vy = 0; }
}
