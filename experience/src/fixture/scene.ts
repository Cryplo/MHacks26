/**
 * FIXTURE scene choreography: a finite, deterministic SCRIPT that produces contract-shaped
 * poses, queue membership, events, scripted mock evidence and fixture metrics for UI
 * development. It is not Engine's simulation and must never be presented as one:
 *  - itineraries are pre-planned at run creation; guests do NOT react to live what-if events;
 *  - "decisions" use a scripted mock policy (source: mock) — never Jev;
 *  - every value derived here is labeled Fixture in the UI.
 * Routing follows the authored path graph in layout.json (the same source painted into the
 * grid), so scripted poses stay on painted walkways without a second navigation compiler.
 */
import type {
  Action, ActionOption, AgentView, AppliedDecision, DecisionRequest, EventKind, EventRecord, GroupManifest,
  Id, Json, KnownDestination, MetricId, MetricSnapshot, MetricValue, Moment, Needs, ObservationFact, ParkBundle,
  Persona, Place, PopulationManifest, QueueView, Quote, Vec2,
} from '../../contract/behavior-v1';
import { CONTRACT_VERSION } from '../../contract/behavior-v1';
import layoutJson from '../../content/harbor-lights/layout.json';
import type { Layout } from '../../content/harbor-lights/tools/layout-lib';
import { canonicalJson } from '../domain/canonical';
import { inverseCdfChoice } from '../domain/random';
import { fixtureUniform } from './population';
import { sha256Sync } from './sha256';

const layout = layoutJson as unknown as Layout;
export const STEP_MS = 5000;
type AgentState = AgentView['state'];

// ---------------------------------------------------------------- geometry & routing
type Route = { pts: Vec2[]; cum: number[]; len: number; allow: number[] };

function makeRoute(pts: Vec2[], allow: number[]): Route {
  const clean: Vec2[] = [];
  const cleanAllow: number[] = [];
  pts.forEach((p, i) => {
    const prev = clean[clean.length - 1];
    if (prev && Math.hypot(prev.xM - p.xM, prev.yM - p.yM) < 1e-6) return;
    if (clean.length > 0) cleanAllow.push(allow[i - 1] ?? 0);
    clean.push(p);
  });
  const cum = [0];
  for (let i = 1; i < clean.length; i++) cum.push(cum[i - 1]! + Math.hypot(clean[i]!.xM - clean[i - 1]!.xM, clean[i]!.yM - clean[i - 1]!.yM));
  return { pts: clean, cum, len: cum[cum.length - 1]!, allow: cleanAllow };
}

function pointAt(r: Route, s: number, offset: number): Vec2 {
  if (r.pts.length === 1) return r.pts[0]!;
  const d = Math.max(0, Math.min(r.len, s));
  let i = 1;
  while (i < r.cum.length - 1 && r.cum[i]! < d) i++;
  const a = r.pts[i - 1]!;
  const b = r.pts[i]!;
  const segLen = r.cum[i]! - r.cum[i - 1]!;
  const t = segLen === 0 ? 0 : (d - r.cum[i - 1]!) / segLen;
  const dx = (b.xM - a.xM) / (segLen || 1);
  const dy = (b.yM - a.yM) / (segLen || 1);
  const allow = r.allow[i - 1] ?? 0;
  const off = Math.max(-allow, Math.min(allow, offset));
  return { xM: a.xM + (b.xM - a.xM) * t - dy * off, yM: a.yM + (b.yM - a.yM) * t + dx * off };
}

export class ParkGeometry {
  readonly places: Map<Id, Place>;
  readonly nodes: Map<string, Vec2>;
  private readonly edges: { id: string; a: string; b: string; width: number }[];
  private readonly dist: Map<string, Map<string, number>> = new Map();
  private readonly next: Map<string, Map<string, string | null>> = new Map();
  private readonly attach = new Map<Id, { edge: number; p: Vec2 }>();
  private readonly routeCache = new Map<string, Route>();
  readonly codes: Uint8Array;
  readonly width: number;

  constructor(readonly park: ParkBundle) {
    const stage = park.places.some((p) => p.id === 'river_rapids') ? 2 : 1;
    this.places = new Map(park.places.map((p) => [p.id, p]));
    this.nodes = new Map(layout.nodes.filter((n) => n.stage <= stage).map((n) => [n.id, { xM: n.x + 0.5, yM: n.y + 0.5 }]));
    this.edges = layout.edges.filter((e) => e.stage <= stage).map((e) => ({ id: e.id, a: e.from, b: e.to, width: e.width }));
    const bin = atob(park.grid.cellsBase64);
    this.codes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    this.width = park.grid.width;
    const ids = [...this.nodes.keys()];
    for (const a of ids) {
      this.dist.set(a, new Map(ids.map((b) => [b, a === b ? 0 : Infinity])));
      this.next.set(a, new Map(ids.map((b) => [b, a === b ? b : null])));
    }
    for (const e of this.edges) {
      const l = this.len(this.nodes.get(e.a)!, this.nodes.get(e.b)!);
      this.dist.get(e.a)!.set(e.b, l); this.dist.get(e.b)!.set(e.a, l);
      this.next.get(e.a)!.set(e.b, e.b); this.next.get(e.b)!.set(e.a, e.a);
    }
    for (const k of ids) for (const i of ids) for (const j of ids) {
      const via = this.dist.get(i)!.get(k)! + this.dist.get(k)!.get(j)!;
      if (via < this.dist.get(i)!.get(j)!) { this.dist.get(i)!.set(j, via); this.next.get(i)!.set(j, this.next.get(i)!.get(k)!); }
    }
    for (const p of park.places) {
      let best = { edge: 0, p: p.entrance, d: Infinity };
      this.edges.forEach((e, idx) => {
        const proj = project(p.entrance, this.nodes.get(e.a)!, this.nodes.get(e.b)!);
        const d = this.len(proj, p.entrance);
        if (d < best.d) best = { edge: idx, p: proj, d };
      });
      this.attach.set(p.id, { edge: best.edge, p: best.p });
    }
  }

  private len = (a: Vec2, b: Vec2) => Math.hypot(a.xM - b.xM, a.yM - b.yM);
  private nodePath(a: string, b: string): string[] {
    const out = [a];
    let cur = a;
    while (cur !== b) { const n = this.next.get(cur)!.get(b); if (!n) return out; cur = n; out.push(cur); }
    return out;
  }

  walkable(p: Vec2): boolean {
    const c = this.codes[Math.floor(p.yM) * this.width + Math.floor(p.xM)];
    return c === 1 || c === 2;
  }

  route(from: Id, to: Id): Route {
    const key = `${from}>${to}`;
    const cached = this.routeCache.get(key);
    if (cached) return cached;
    const A = this.places.get(from)!; const B = this.places.get(to)!;
    const fa = this.attach.get(from)!; const fb = this.attach.get(to)!;
    let pts: Vec2[]; let allow: number[];
    const ea = this.edges[fa.edge]!; const eb = this.edges[fb.edge]!;
    const lane = (w: number) => Math.max(0, w / 2 - 0.9);
    if (fa.edge === fb.edge) {
      pts = [A.entrance, fa.p, fb.p, B.entrance]; allow = [0, lane(ea.width), 0];
    } else {
      let best: { d: number; s: string; g: string } = { d: Infinity, s: ea.a, g: eb.a };
      for (const s of [ea.a, ea.b]) for (const g of [eb.a, eb.b]) {
        const d = this.len(fa.p, this.nodes.get(s)!) + this.dist.get(s)!.get(g)! + this.len(this.nodes.get(g)!, fb.p);
        if (d < best.d) best = { d, s, g };
      }
      const path = this.nodePath(best.s, best.g);
      pts = [A.entrance, fa.p, ...path.map((n) => this.nodes.get(n)!), fb.p, B.entrance];
      allow = [0, lane(ea.width)];
      for (let i = 1; i < path.length; i++) {
        const e = this.edges.find((x) => (x.a === path[i - 1] && x.b === path[i]) || (x.b === path[i - 1] && x.a === path[i]));
        allow.push(lane(e?.width ?? 4));
      }
      allow.push(lane(eb.width), 0);
    }
    const r = makeRoute(pts, allow);
    this.routeCache.set(key, r);
    return r;
  }

  /** Short neutral wander: to the nearest graph node along the attached edge and back. */
  browseRoute(at: Id): Route {
    const P = this.places.get(at)!;
    const fa = this.attach.get(at)!;
    const e = this.edges[fa.edge]!;
    const na = this.nodes.get(e.a)!; const nb = this.nodes.get(e.b)!;
    const n = this.len(fa.p, na) < this.len(fa.p, nb) ? na : nb;
    const w = Math.max(0, e.width / 2 - 0.9);
    return makeRoute([P.entrance, fa.p, n, fa.p, P.entrance], [0, w, w, 0]);
  }

  /** Walkable spot near `center` for the k-th member (deterministic spiral). */
  spot(center: Vec2, k: number, requireWalkable = true): Vec2 {
    let found = 0;
    for (let r = 0; r <= 4; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const p = { xM: center.xM + dx * 0.8, yM: center.yM + dy * 0.8 };
        if (requireWalkable && !this.walkable(p)) continue;
        if (found++ === k) return p;
      }
    }
    return center;
  }

  footprintCenter(placeId: Id): Vec2 {
    const lp = layout.places.find((p) => p.id === placeId);
    if (!lp?.footprint) return this.places.get(placeId)!.entrance;
    return { xM: lp.footprint.x + lp.footprint.w / 2, yM: lp.footprint.y + lp.footprint.h / 2 };
  }
}

function project(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.xM - a.xM; const dy = b.yM - a.yM;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.xM - a.xM) * dx + (p.yM - a.yM) * dy) / l2));
  return { xM: a.xM + t * dx, yM: a.yM + t * dy };
}

// ---------------------------------------------------------------- scene records
type GroupSeg =
  | { kind: 'walk'; t0: number; t1: number; route: Route; speed: number; state: 'walking' | 'browsing'; target: Id | null; s0: number }
  | { kind: 'hold'; t0: number; t1: number; at: Vec2; state: AgentState; target: Id | null; walkable: boolean }
  | { kind: 'queue'; t0: number; t1: number; placeId: Id; partyId: string; target: Id }
  | { kind: 'gone'; t0: number; t1: number };

type Party = { partyId: string; groupId: Id; agentIds: Id[]; lane: 'standard' | 'pass'; joinT: number; leaveT: number; boarded: boolean; abandoned: boolean };
type DecisionCore = {
  evidenceId: Id; groupId: Id; agentIds: Id[]; moment: Moment; decisionSeq: number; momentSeq: number; atMs: number;
  options: ActionOption[]; raw: { optionId: Id; probability: number }[]; draw: number; chosen: Id;
  outcome: 'committed' | 'failed_precondition'; failureReason: string | null; causedEventIds: Id[];
  factIds: Id[]; balanceCents: number; activity: string; excluded: { id: Id; reason: string }[];
};
type RatingRec = { agentId: Id; atMs: number; availableAtMs: number; index: number | null; endpoint: 'periodic' | 'departure' | 'horizon' };

export type Scene = {
  seed: string; horizonMs: number; park: ParkBundle; population: PopulationManifest; geo: ParkGeometry;
  personas: Map<Id, Persona>; groups: Map<Id, GroupManifest>; memberIndex: Map<Id, number>;
  segs: Map<Id, GroupSeg[]>;
  parties: Map<Id, Party[]>; // by place
  partyById: Map<string, Party>;
  events: EventRecord[];
  decisions: Map<Id, DecisionCore>;
  decisionsByGroup: Map<Id, DecisionCore[]>;
  facts: Map<Id, ObservationFact[]>; // by group, chronological
  ratings: Map<Id, RatingRec[]>; // by agent
  experience: Map<Id, { atMs: number; delta: number }[]>; // by agent
  arrivals: { t: number; groupId: Id; n: number }[];
  departures: { t: number; groupId: Id; n: number; early: boolean }[];
  rideDispatches: Map<Id, number[]>; // dispatch times per ride
  boardings: { t: number; placeId: Id; riders: number; waitMs: number }[];
  serverBusy: Map<Id, { start: number; end: number }[]>;
  passPriceSchedule: { atMs: number; cents: number }[];
  eventsByGroup: Map<Id, EventRecord[]>;
  partiesByGroup: Map<Id, Party[]>;
};

export type SceneInput = {
  park: ParkBundle; population: PopulationManifest; seed: string; horizonMs: number;
  passPriceSchedule: { atMs: number; cents: number }[]; ratingEveryMs: number | null; earlyDepartureThresholdMs: number;
  runId: Id;
};

const ceilStep = (t: number) => Math.ceil(t / STEP_MS) * STEP_MS;
const round7 = (v: number) => Math.round(v * 1e7) / 1e7;

// ---------------------------------------------------------------- generation
export function generateScene(input: SceneInput): Scene {
  const { park, population, seed, horizonMs } = input;
  const geo = new ParkGeometry(park);
  const personas = new Map(population.personas.map((p) => [p.agentId, p]));
  const groups = new Map(population.groups.map((g) => [g.groupId, g]));
  const memberIndex = new Map<Id, number>();
  for (const g of population.groups) g.memberIds.forEach((id, i) => memberIndex.set(id, i));
  const scene: Scene = {
    seed, horizonMs, park, population, geo, personas, groups, memberIndex,
    segs: new Map(), parties: new Map(), partyById: new Map(), events: [], decisions: new Map(), decisionsByGroup: new Map(),
    facts: new Map(), ratings: new Map(), experience: new Map(), arrivals: [], departures: [], rideDispatches: new Map(),
    boardings: [], serverBusy: new Map(), passPriceSchedule: [...input.passPriceSchedule].sort((a, b) => a.atMs - b.atMs),
    eventsByGroup: new Map(), partiesByGroup: new Map(),
  };
  const passPriceAt = (t: number) => {
    let c = park.pass.unitPriceCents;
    for (const s of scene.passPriceSchedule) if (s.atMs <= t) c = s.cents;
    return c;
  };
  const u = (...k: (string | number)[]) => fixtureUniform(seed, 'fixture-scene', ...k);
  const rawEvents: Omit<EventRecord, 'sequence' | 'eventId' | 'runId'>[] = [];
  let evCounter = 0;
  const pushEvent = (e: Omit<EventRecord, 'sequence' | 'eventId' | 'runId'>): Id => {
    rawEvents.push(e);
    return `__ev${evCounter++}`;
  };

  // Resource state.
  const rideState = new Map<Id, { dispatchSeats: Map<number, { std: number; pass: number }>; lastStd: number; lastPass: number }>();
  const counterFree = new Map<Id, number[]>();
  const showSeats = new Map<string, number>();
  for (const p of park.places) {
    if (p.service.kind === 'ride') {
      rideState.set(p.id, { dispatchSeats: new Map(), lastStd: 0, lastPass: 0 });
      const times: number[] = [];
      for (let t = p.service.dispatchMs; t <= horizonMs; t += p.service.dispatchMs) times.push(t);
      scene.rideDispatches.set(p.id, times);
    }
    if (p.service.kind === 'counter') { counterFree.set(p.id, new Array(p.service.servers).fill(0)); scene.serverBusy.set(p.id, []); }
    scene.parties.set(p.id, []);
  }

  type GS = {
    g: GroupManifest; at: Id; decisionSeq: number; momentSeq: Record<string, number>; visited: Map<Id, number>;
    balance: number; hasPass: boolean; meals: number[]; rests: number[]; rideTimes: number[]; queueMs: number;
    lastNoticeSeen: Map<string, number>; done: boolean; lastActivity: string;
  };
  const states = new Map<Id, GS>();
  const pq: { t: number; groupId: Id; kind: 'arrive_park' | 'decide' | 'arrive_place'; place?: Id; order: number }[] = [];
  let order = 0;
  const schedule = (t: number, groupId: Id, kind: 'arrive_park' | 'decide' | 'arrive_place', place?: Id) => {
    pq.push({ t, groupId, kind, place, order: order++ });
  };
  for (const g of population.groups) {
    states.set(g.groupId, { g, at: 'main_gate', decisionSeq: 0, momentSeq: {}, visited: new Map(), balance: g.startingBalanceCents,
      hasPass: false, meals: [], rests: [], rideTimes: [], queueMs: 0, lastNoticeSeen: new Map(), done: false, lastActivity: 'arriving' });
    scene.segs.set(g.groupId, [{ kind: 'gone', t0: 0, t1: ceilStep(g.arrivalMs) }]);
    scene.facts.set(g.groupId, []);
    scene.decisionsByGroup.set(g.groupId, []);
    for (const id of g.memberIds) { scene.experience.set(id, []); scene.ratings.set(id, []); }
    if (ceilStep(g.arrivalMs) < horizonMs) schedule(ceilStep(g.arrivalMs), g.groupId, 'arrive_park');
  }

  const addSeg = (groupId: Id, seg: GroupSeg) => scene.segs.get(groupId)!.push(seg);
  const addExp = (agentIds: Id[], atMs: number, delta: number) => agentIds.forEach((id) => scene.experience.get(id)!.push({ atMs, delta }));
  const groupPace = (g: GroupManifest) => Math.min(...g.memberIds.map((id) => personas.get(id)!.walkSpeedMps)) * 0.95;
  const addFact = (s: GS, f: Omit<ObservationFact, 'id'>): ObservationFact => {
    const list = scene.facts.get(s.g.groupId)!;
    const fact = { ...f, id: `obs:${s.g.groupId}:${list.length + 1}` };
    list.push(fact);
    return fact;
  };
  const needsAt = (s: GS, agentId: Id, t: number): Needs => needsFor(personas.get(agentId)!, s.g, t, s.meals, s.rests, s.rideTimes, s.queueMs);

  /** Scripted mock policy -> a contract-shaped decision with a real semantic draw. */
  const decide = (s: GS, t: number, moment: Moment, options: { opt: ActionOption; w: number }[], excluded: { id: Id; reason: string }[]): DecisionCore => {
    s.decisionSeq++;
    s.momentSeq[moment] = (s.momentSeq[moment] ?? 0) + 1;
    const weights = options.map((o) => Math.max(1e-3, o.w));
    const sum = weights.reduce((a, b) => a + b, 0);
    const raw = options.map((o, i) => ({ optionId: o.opt.id, probability: round7(weights[i]! / sum) }));
    const applied = normalize(raw);
    const draw = fixtureUniform(seed, 'behavior', s.g.groupId, moment, s.momentSeq[moment]!);
    const chosen = inverseCdfChoice(applied, draw);
    const facts = scene.facts.get(s.g.groupId)!;
    const d: DecisionCore = {
      evidenceId: `ev:${s.g.groupId}:${s.decisionSeq}`, groupId: s.g.groupId, agentIds: [...s.g.memberIds], moment,
      decisionSeq: s.decisionSeq, momentSeq: s.momentSeq[moment]!, atMs: t, options: options.map((o) => o.opt), raw, draw, chosen,
      outcome: 'committed', failureReason: null, causedEventIds: [], factIds: facts.slice(-6).map((f) => f.id),
      balanceCents: s.balance, activity: s.lastActivity, excluded,
    };
    scene.decisions.set(d.evidenceId, d);
    scene.decisionsByGroup.get(s.g.groupId)!.push(d);
    return d;
  };

  const walkTo = (s: GS, t: number, dest: Id, state: 'walking' | 'browsing' = 'walking'): number => {
    const route = state === 'browsing' ? geo.browseRoute(s.at) : geo.route(s.at, dest);
    const speed = groupPace(s.g) * (state === 'browsing' ? 0.55 : 1);
    const lagMax = (s.g.memberIds.length - 1) * 0.9;
    const t1 = ceilStep(t + ((route.len + lagMax) / speed) * 1000);
    addSeg(s.g.groupId, { kind: 'walk', t0: t, t1, route, speed, state, target: state === 'browsing' ? null : dest, s0: 0 });
    // Notices along the way (visual: within radius; aroma: proximity). Scripted check per step.
    for (let tt = t; tt <= t1; tt += STEP_MS) {
      const p = pointAt(route, ((tt - t) / 1000) * speed, 0);
      for (const place of park.places) {
        if (!place.notice) continue;
        const dist = Math.hypot(place.entrance.xM - p.xM, place.entrance.yM - p.yM);
        if (dist > place.notice.radiusM) continue;
        const version = `notice:${place.id}:v1`;
        const last = s.lastNoticeSeen.get(version);
        if (last !== undefined && tt - last < place.notice.cooldownMs) continue;
        s.lastNoticeSeen.set(version, tt);
        const fact = addFact(s, { kind: 'notice', placeId: place.id, source: place.notice.channel === 'aroma' ? 'aroma' : 'sight',
          observedAtMs: tt, contentVersion: version, text: place.notice.text, waitLowerMs: null, waitUpperMs: null, priceCents: null });
        pushEvent({ atMs: tt, kind: 'observed', groupId: s.g.groupId, agentIds: [...s.g.memberIds], placeId: place.id, position: p,
          causationId: null, amountCents: null, experienceDelta: null, reason: `${place.notice.channel} notice`,
          details: { factId: fact.id, contentVersion: version, channel: place.notice.channel, text: place.notice.text } });
      }
    }
    s.at = state === 'browsing' ? s.at : dest;
    return t1;
  };

  const holdSpot = (s: GS, t0: number, t1: number, at: Vec2, state: AgentState, target: Id | null, walkable = true) =>
    addSeg(s.g.groupId, { kind: 'hold', t0, t1, at, state, target, walkable });

  const quote = (productId: Id, unit: number, qty: number, beneficiaries: Id[], t: number, rev: string): Quote => ({
    quoteId: `q:${productId}:${t}:${beneficiaries[0]}`, revision: rev, productId, unitPriceCents: unit, quantity: qty,
    totalCents: unit * qty, beneficiaryIds: beneficiaries, validUntilMs: t + 60_000, discountMessageId: null,
  });

  const candidatesFor = (s: GS, t: number) => {
    const excluded: { id: Id; reason: string }[] = [];
    const scored: { place: Place; w: number }[] = [];
    const members = s.g.memberIds.map((id) => personas.get(id)!);
    const pref = members.reduce((a, m) => a + m.thrillPreference, 0) / members.length;
    const hunger = Math.max(...s.g.memberIds.map((id) => needsAt(s, id, t).hunger));
    const fatigue = Math.max(...s.g.memberIds.map((id) => needsAt(s, id, t).fatigue));
    for (const p of park.places) {
      if (p.kind === 'entrance' || p.kind === 'exit' || p.id === s.at) continue;
      if (p.minHeightCm !== null) {
        const short = members.find((m) => m.heightCm < p.minHeightCm!);
        if (short) { excluded.push({ id: p.id, reason: `minimum height ${p.minHeightCm} cm; ${short.agentId} is ${short.heightCm} cm` }); continue; }
      }
      const visits = s.visited.get(p.id) ?? 0;
      const distance = geo.route(s.at, p.id).len;
      let w = 0;
      if (p.kind === 'ride') w = 1.2 + 2.2 * (1 - Math.abs(p.thrill - pref)) - visits * 0.9;
      if (p.kind === 'show') w = 0.9 - visits * 0.8;
      if (p.kind === 'food') w = hunger > 55 ? 1.2 + (hunger - 55) / 15 : 0.1;
      if (p.kind === 'shop') w = 0.35 - visits * 0.3;
      if (p.kind === 'restroom') w = 0.15;
      if (p.kind === 'scenery') w = fatigue > 50 ? 0.9 + (fatigue - 50) / 25 : 0.25;
      if (members.some((m) => m.mustDoPlaceIds.includes(p.id)) && visits === 0) w += 1.5;
      w -= distance / 160;
      scored.push({ place: p, w: Math.max(0.05, w) });
    }
    scored.sort((a, b) => b.w - a.w || (a.place.id < b.place.id ? -1 : 1));
    return { top: scored.slice(0, 3), excluded };
  };

  const finishDecision = (d: DecisionCore, eventIds: Id[]) => d.causedEventIds.push(...eventIds);

  // Main discrete-event loop (scripted; resources assigned in time order).
  while (pq.length) {
    pq.sort((a, b) => a.t - b.t || a.order - b.order);
    const item = pq.shift()!;
    const s = states.get(item.groupId)!;
    if (s.done) continue;
    const t = item.t;
    const gid = s.g.groupId;
    if (t >= horizonMs) {
      holdSpot(s, t, horizonMs + STEP_MS, geo.places.get(s.at)!.entrance, 'walking', null);
      continue;
    }
    if (item.kind === 'arrive_park') {
      scene.arrivals.push({ t, groupId: gid, n: s.g.memberIds.length });
      pushEvent({ atMs: t, kind: 'arrived', groupId: gid, agentIds: [...s.g.memberIds], placeId: 'main_gate', position: geo.places.get('main_gate')!.entrance,
        causationId: null, amountCents: null, experienceDelta: null, reason: null, details: { groupSize: s.g.memberIds.length } });
      holdSpot(s, t, t + STEP_MS, geo.spot(geo.places.get('main_gate')!.entrance, 0), 'deciding', null);
      schedule(t + STEP_MS, gid, 'decide');
      continue;
    }
    if (item.kind === 'decide') {
      const late = t >= s.g.plannedDepartureMs;
      const { top, excluded } = candidatesFor(s, t);
      const opts: { opt: ActionOption; w: number }[] = top.map(({ place, w }) => {
        const walk = Math.round(geo.route(s.at, place.id).len / groupPace(s.g));
        const lastBoard = [...scene.facts.get(gid)!].reverse().find((f) => f.placeId === place.id && f.kind === 'board');
        const known = lastBoard ? ` Last observed board: "${lastBoard.text}".` : '';
        return { opt: { id: `travel_${place.id}`, label: `Walk to ${place.name}`, description: `About ${Math.max(1, Math.round(walk / 60))} min walk.${known} This does not join any queue.`, action: { kind: 'travel', placeId: place.id, routeProfileId: null } satisfies Action }, w: late ? w * 0.2 : w };
      });
      opts.push({ opt: { id: 'browse', label: 'Browse nearby', description: 'Wander nearby without choosing an attraction.', action: { kind: 'browse', durationMs: 120_000 } }, w: 0.35 });
      const stayFrac = (t - s.g.arrivalMs) / Math.max(1, s.g.plannedDepartureMs - s.g.arrivalMs);
      opts.push({ opt: { id: 'leave', label: 'Head to the exit', description: late ? 'Planned departure time has passed.' : 'Leave earlier than planned.', action: { kind: 'leave_park' } }, w: late ? 6 : stayFrac > 0.7 ? 0.3 : 0.04 });
      const hunger = Math.max(...s.g.memberIds.map((id) => needsAt(s, id, t).hunger));
      const fatigue = Math.max(...s.g.memberIds.map((id) => needsAt(s, id, t).fatigue));
      const moment: Moment = late ? 'closing_soon' : hunger > 75 || fatigue > 75 ? 'hungry_tired' : 'what_next';
      const d = decide(s, t, moment, opts, excluded);
      const chosen = d.options.find((o) => o.id === d.chosen)!;
      s.lastActivity = chosen.label.toLowerCase();
      if (chosen.action.kind === 'leave_park') {
        const t1 = walkTo(s, t, 'main_exit');
        if (t1 < horizonMs) {
          const early = s.g.plannedDepartureMs - t1 > input.earlyDepartureThresholdMs;
          scene.departures.push({ t: t1, groupId: gid, n: s.g.memberIds.length, early });
          const ev = pushEvent({ atMs: t1, kind: 'departed', groupId: gid, agentIds: [...s.g.memberIds], placeId: 'main_exit', position: geo.places.get('main_exit')!.entrance,
            causationId: d.evidenceId, amountCents: null, experienceDelta: null, reason: early ? 'left before planned departure' : 'planned departure', details: { early } });
          finishDecision(d, [ev]);
          addSeg(gid, { kind: 'gone', t0: t1, t1: horizonMs + STEP_MS });
          for (const id of s.g.memberIds) addRating(scene, id, t1, 'departure', u);
        }
        s.done = true;
        continue;
      }
      if (chosen.action.kind === 'browse') {
        const t1 = walkTo(s, t, s.at, 'browsing');
        schedule(t1, gid, 'decide');
        continue;
      }
      if (chosen.action.kind === 'travel') {
        const t1 = walkTo(s, t, chosen.action.placeId);
        schedule(t1, gid, 'arrive_place', chosen.action.placeId);
        continue;
      }
      continue;
    }
    // arrive_place
    const place = geo.places.get(item.place!)!;
    s.visited.set(place.id, (s.visited.get(place.id) ?? 0) + 1);
    const members = [...s.g.memberIds];
    const zoneCells = park.queueZones.find((z) => z.placeId === place.id)?.cellIndices.length ?? 0;
    if (place.service.kind === 'ride') {
      const svc = place.service;
      const rs = rideState.get(place.id)!;
      const passSeats = svc.passEnabled ? Math.max(1, Math.floor((svc.seats * svc.passShareBps) / 10000)) : 0;
      const stdSeats = svc.seats - passSeats;
      if (members.length > svc.seats) {
        const ev = pushEvent({ atMs: t, kind: 'action_failed', groupId: gid, agentIds: members, placeId: place.id, position: place.entrance, causationId: null,
          amountCents: null, experienceDelta: -2, reason: 'party larger than any vehicle', details: {} });
        void ev; addExp(members, t, -2); schedule(t + STEP_MS, gid, 'decide'); continue;
      }
      const assign = (lane: 'standard' | 'pass', commit: boolean): number | null => {
        const times = scene.rideDispatches.get(place.id)!;
        const last = lane === 'pass' ? rs.lastPass : rs.lastStd;
        for (const dt of times) {
          if (dt < t + STEP_MS || dt < last) continue;
          const seats = rs.dispatchSeats.get(dt) ?? { std: stdSeats, pass: passSeats };
          const free = lane === 'pass' ? seats.pass + seats.std : seats.std;
          if (free >= members.length) {
            if (commit) {
              if (lane === 'pass') { const fromPass = Math.min(seats.pass, members.length); seats.pass -= fromPass; seats.std -= members.length - fromPass; rs.lastPass = dt; }
              else { seats.std -= members.length; rs.lastStd = dt; }
              rs.dispatchSeats.set(dt, seats);
            }
            return dt;
          }
        }
        return null;
      };
      const stdBoard = assign('standard', false);
      const estWait = stdBoard === null ? null : stdBoard - t;
      const roundMin = (ms: number) => Math.max(5, Math.round(ms / 60_000 / 5) * 5);
      const boardText = estWait === null ? `${place.name} - wait unavailable` : `${place.name} - about ${roundMin(estWait)} min`;
      const boardFact = addFact(s, { kind: 'board', placeId: place.id, source: 'sight', observedAtMs: t, contentVersion: `board:${place.id}:runtime`,
        text: boardText, waitLowerMs: estWait === null ? null : roundMin(estWait) * 60_000, waitUpperMs: estWait === null ? null : roundMin(estWait) * 60_000, priceCents: null });
      const opts: { opt: ActionOption; w: number }[] = [];
      const patienceMin = Math.min(...members.map((id) => needsAt(s, id, t).patience));
      opts.push({ opt: { id: 'join_standard', label: `Join the standard line`, description: `Posted wait: "${boardText}".`, action: { kind: 'join_queue', placeId: place.id, lane: 'standard', riderIds: members } },
        w: estWait === null ? 0.01 : 2.2 - (estWait / 60_000) / Math.max(15, patienceMin * 0.6) });
      const price = passPriceAt(t);
      if (svc.passEnabled && !s.hasPass) {
        const q = quote('harbor_pass', price, members.length, members, t, `pass:${price}`);
        const passFact = addFact(s, { kind: 'price', placeId: place.id, source: 'sight', observedAtMs: t, contentVersion: `price:harbor_pass:${price}`,
          text: `Harbor Pass ${fmt(price)} per guest - priority lane for the rest of the day`, waitLowerMs: null, waitUpperMs: null, priceCents: price });
        void passFact;
        const affordable = q.totalCents <= s.balance;
        opts.push({ opt: { id: 'buy_pass', label: `Buy ${members.length} Harbor Pass${members.length > 1 ? 'es' : ''} (${fmt(q.totalCents)}) and use the pass lane`,
          description: `${members.length} x ${fmt(price)} = ${fmt(q.totalCents)} from the shared wallet (${fmt(s.balance)} available).`, action: { kind: 'buy_pass_and_join', placeId: place.id, riderIds: members, quote: q } },
          w: affordable ? ((estWait ?? 0) / 60_000 > 15 ? 0.9 : 0.15) * (1500 / price) ** 2 : 0.02 });
      }
      opts.push({ opt: { id: 'walk_away', label: 'Skip this line for now', description: 'Decide on something else instead.', action: { kind: 'continue' } }, w: 0.4 + (estWait ?? 3600_000) / 3600_000 });
      const d = decide(s, t, 'join_line', opts, []);
      d.factIds = [...new Set([...d.factIds, boardFact.id])];
      const chosen = d.options.find((o) => o.id === d.chosen)!;
      if (chosen.action.kind === 'continue') { schedule(t + STEP_MS, gid, 'decide'); continue; }
      let lane: 'standard' | 'pass' = 'standard';
      const caused: Id[] = [];
      if (chosen.action.kind === 'buy_pass_and_join') {
        const total = chosen.action.quote.totalCents;
        if (total > s.balance) {
          d.outcome = 'failed_precondition'; d.failureReason = `wallet has ${fmt(s.balance)}, pass total ${fmt(total)}`;
          finishDecision(d, [pushEvent({ atMs: t, kind: 'action_failed', groupId: gid, agentIds: members, placeId: place.id, position: place.entrance, causationId: d.evidenceId, amountCents: null, experienceDelta: -2, reason: d.failureReason, details: {} })]);
          addExp(members, t, -2); schedule(t + STEP_MS, gid, 'decide'); continue;
        }
        s.balance -= total; s.hasPass = true; lane = 'pass';
        caused.push(pushEvent({ atMs: t, kind: 'purchase', groupId: gid, agentIds: members, placeId: place.id, position: place.entrance, causationId: d.evidenceId,
          amountCents: total, experienceDelta: null, reason: 'pass purchase + queue admission (atomic)', details: { productId: 'harbor_pass', quantity: members.length, unitPriceCents: price, quoteRevision: chosen.action.quote.revision, walletId: s.g.walletId } }));
      } else if (s.hasPass && svc.passEnabled) lane = 'pass';
      const board = assign(lane, true);
      if (board === null) { schedule(t + STEP_MS, gid, 'decide'); continue; }
      const waitMs = board - t;
      const limitMs = ceilStep((20 + patienceMin * 0.5) * 60_000);
      const partyId = `party:${place.id}:${gid}:${t}`;
      const abandon = waitMs > limitMs && lane === 'standard';
      const leaveT = abandon ? t + limitMs : board;
      const party: Party = { partyId, groupId: gid, agentIds: members, lane, joinT: t, leaveT, boarded: !abandon, abandoned: abandon };
      scene.parties.get(place.id)!.push(party); scene.partyById.set(partyId, party);
      caused.push(pushEvent({ atMs: t, kind: 'queue_joined', groupId: gid, agentIds: members, placeId: place.id, position: place.entrance, causationId: d.evidenceId,
        amountCents: null, experienceDelta: null, reason: null, details: { lane, partyId, promisedWait: boardText, zoneCells } }));
      finishDecision(d, caused);
      addSeg(gid, { kind: 'queue', t0: t, t1: leaveT, placeId: place.id, partyId, target: place.id });
      s.queueMs += (leaveT - t) * members.length;
      if (abandon) {
        pushEvent({ atMs: leaveT, kind: 'queue_left', groupId: gid, agentIds: members, placeId: place.id, position: place.entrance, causationId: null,
          amountCents: null, experienceDelta: -4, reason: 'voluntary: waited longer than the posted estimate', details: { partyId, waitedMs: limitMs, promisedWait: boardText } });
        addExp(members, leaveT, -4);
        holdSpot(s, leaveT, leaveT + STEP_MS, geo.spot(place.entrance, 0), 'deciding', null);
        schedule(leaveT + STEP_MS, gid, 'decide');
        continue;
      }
      const end = board + svc.durationMs;
      scene.boardings.push({ t: board, placeId: place.id, riders: members.length, waitMs: board - t });
      pushEvent({ atMs: board, kind: 'service_started', groupId: gid, agentIds: members, placeId: place.id, position: geo.footprintCenter(place.id), causationId: null,
        amountCents: null, experienceDelta: null, reason: null, details: { lane, waitedMs: board - t } });
      holdSpot(s, board, end, geo.footprintCenter(place.id), 'riding', place.id, false);
      for (const id of members) {
        const pr = personas.get(id)!;
        const delta = Math.round((6 + 14 * (1 - Math.abs(place.thrill - pr.thrillPreference)) - Math.max(0, (board - t) / 60_000 - 10) * 0.2) * 10) / 10;
        scene.experience.get(id)!.push({ atMs: end, delta });
      }
      s.rideTimes.push(end);
      pushEvent({ atMs: end, kind: 'service_completed', groupId: gid, agentIds: members, placeId: place.id, position: place.entrance, causationId: null,
        amountCents: null, experienceDelta: null, reason: null, details: { ride: place.name } });
      holdSpot(s, end, end + STEP_MS, geo.spot(place.entrance, 0), 'deciding', null);
      schedule(end + STEP_MS, gid, 'decide');
      continue;
    }
    if (place.service.kind === 'counter') {
      const svc = place.service;
      const isFood = place.kind === 'food';
      const opts: { opt: ActionOption; w: number }[] = [];
      const products = svc.products;
      const main = products[0]!;
      const cheap = [...products].sort((a, b) => a.unitPriceCents - b.unitPriceCents)[0]!;
      const cartAll = [quote(main.id, main.unitPriceCents, members.length, members, t, `${place.id}:1`)];
      const cartOne = [quote(cheap.id, cheap.unitPriceCents, 1, [members[0]!], t, `${place.id}:1`)];
      const hunger = Math.max(...members.map((id) => needsAt(s, id, t).hunger));
      opts.push({ opt: { id: 'order_all', label: `Order ${members.length} x ${main.label}`, description: `${fmt(cartAll[0]!.totalCents)} total from the shared wallet (${fmt(s.balance)} available).`, action: { kind: 'order', placeId: place.id, cart: cartAll } }, w: isFood ? 0.6 + hunger / 60 : 0.5 });
      opts.push({ opt: { id: 'order_one', label: `Order 1 x ${cheap.label}`, description: `${fmt(cheap.unitPriceCents)}.`, action: { kind: 'order', placeId: place.id, cart: cartOne } }, w: 0.6 });
      opts.push({ opt: { id: 'walk_away', label: 'Leave without buying', description: 'Decide on something else instead.', action: { kind: 'continue' } }, w: 0.5 });
      const d = decide(s, t, 'join_line', opts, []);
      const chosen = d.options.find((o) => o.id === d.chosen)!;
      if (chosen.action.kind !== 'order') { schedule(t + STEP_MS, gid, 'decide'); continue; }
      const cart = chosen.action.cart;
      const total = cart.reduce((a, q) => a + q.totalCents, 0);
      const free = counterFree.get(place.id)!;
      let si = 0;
      free.forEach((v, i) => { if (v < free[si]!) si = i; });
      const start = ceilStep(Math.max(t + STEP_MS, free[si]!));
      free[si] = start + svc.serviceMs;
      scene.serverBusy.get(place.id)!.push({ start, end: start + svc.serviceMs });
      const partyId = `party:${place.id}:${gid}:${t}`;
      const party: Party = { partyId, groupId: gid, agentIds: members, lane: 'standard', joinT: t, leaveT: start, boarded: true, abandoned: false };
      scene.parties.get(place.id)!.push(party); scene.partyById.set(partyId, party);
      const caused = [pushEvent({ atMs: t, kind: 'queue_joined', groupId: gid, agentIds: members, placeId: place.id, position: place.entrance, causationId: d.evidenceId, amountCents: null, experienceDelta: null, reason: null, details: { lane: 'standard', partyId, cart: cart.map((q) => ({ productId: q.productId, quantity: q.quantity })) as unknown as Json } })];
      addSeg(gid, { kind: 'queue', t0: t, t1: start, placeId: place.id, partyId, target: place.id });
      s.queueMs += (start - t) * members.length;
      if (total > s.balance) {
        d.outcome = 'failed_precondition'; d.failureReason = `wallet has ${fmt(s.balance)} at service start; cart total ${fmt(total)}`;
        caused.push(pushEvent({ atMs: start, kind: 'action_failed', groupId: gid, agentIds: members, placeId: place.id, position: place.entrance, causationId: d.evidenceId, amountCents: null, experienceDelta: -2, reason: d.failureReason, details: {} }));
        finishDecision(d, caused); addExp(members, start, -2);
        holdSpot(s, start, start + STEP_MS, geo.spot(place.entrance, 0), 'deciding', null);
        schedule(start + STEP_MS, gid, 'decide');
        continue;
      }
      s.balance -= total;
      caused.push(pushEvent({ atMs: start, kind: 'purchase', groupId: gid, agentIds: members, placeId: place.id, position: place.entrance, causationId: d.evidenceId,
        amountCents: total, experienceDelta: null, reason: 'debited at service start', details: { cart: cart.map((q) => ({ productId: q.productId, quantity: q.quantity, unitPriceCents: q.unitPriceCents })) as unknown as Json, walletId: s.g.walletId } }));
      pushEvent({ atMs: start, kind: 'service_started', groupId: gid, agentIds: members, placeId: place.id, position: place.entrance, causationId: null, amountCents: null, experienceDelta: null, reason: null, details: {} });
      finishDecision(d, caused);
      const end = start + svc.serviceMs + svc.activityMs;
      const spotCenter = place.entrance;
      addSeg(gid, { kind: 'hold', t0: start, t1: end, at: spotCenter, state: isFood ? 'eating' : 'shopping', target: place.id, walkable: true });
      if (isFood) s.meals.push(end);
      addExp(members, end, isFood ? 3 : 1.5);
      pushEvent({ atMs: end, kind: 'service_completed', groupId: gid, agentIds: members, placeId: place.id, position: place.entrance, causationId: null, amountCents: null, experienceDelta: null, reason: null, details: {} });
      schedule(end, gid, 'decide');
      continue;
    }
    if (place.service.kind === 'show') {
      const svc = place.service;
      let start: number | null = null;
      for (const st of svc.startsAtMs) {
        if (st < t + STEP_MS) continue;
        const left = showSeats.get(`${place.id}:${st}`) ?? svc.seats;
        if (left >= members.length) { showSeats.set(`${place.id}:${st}`, left - members.length); start = st; break; }
      }
      if (start === null || start - t > 50 * 60_000) { schedule(t + STEP_MS, gid, 'decide'); continue; }
      const partyId = `party:${place.id}:${gid}:${t}`;
      const party: Party = { partyId, groupId: gid, agentIds: members, lane: 'standard', joinT: t, leaveT: start, boarded: true, abandoned: false };
      scene.parties.get(place.id)!.push(party); scene.partyById.set(partyId, party);
      pushEvent({ atMs: t, kind: 'queue_joined', groupId: gid, agentIds: members, placeId: place.id, position: place.entrance, causationId: null, amountCents: null, experienceDelta: null, reason: null, details: { lane: 'standard', partyId, showStartsAtMs: start } });
      addSeg(gid, { kind: 'queue', t0: t, t1: start, placeId: place.id, partyId, target: place.id });
      s.queueMs += (start - t) * members.length;
      const end = start + svc.durationMs;
      pushEvent({ atMs: start, kind: 'service_started', groupId: gid, agentIds: members, placeId: place.id, position: geo.footprintCenter(place.id), causationId: null, amountCents: null, experienceDelta: null, reason: null, details: {} });
      holdSpot(s, start, end, geo.footprintCenter(place.id), 'watching', place.id, false);
      addExp(members, end, 6);
      pushEvent({ atMs: end, kind: 'service_completed', groupId: gid, agentIds: members, placeId: place.id, position: place.entrance, causationId: null, amountCents: null, experienceDelta: null, reason: null, details: {} });
      holdSpot(s, end, end + STEP_MS, geo.spot(place.entrance, 0), 'deciding', null);
      schedule(end + STEP_MS, gid, 'decide');
      continue;
    }
    if (place.service.kind === 'rest') {
      const end = t + place.service.durationMs;
      holdSpot(s, t, end, place.entrance, 'resting', place.id);
      s.rests.push(end);
      addExp(members, end, 2);
      schedule(end, gid, 'decide');
      continue;
    }
    schedule(t + STEP_MS, gid, 'decide');
  }

  // Periodic ratings (fixture: scripted from the experience ledger; source mock).
  if (input.ratingEveryMs) {
    for (let at = input.ratingEveryMs; at <= horizonMs; at += input.ratingEveryMs) {
      for (const g of population.groups) {
        if (ceilStep(g.arrivalMs) > at) continue;
        const dep = scene.departures.find((d) => d.groupId === g.groupId);
        if (dep && dep.t <= at) continue;
        for (const id of g.memberIds) addRating(scene, id, at, 'periodic', u);
      }
    }
  }

  // Finalize events: deterministic order and sequence numbers.
  const order2 = rawEvents.map((e, i) => ({ e, i })).sort((a, b) => a.e.atMs - b.e.atMs || a.i - b.i);
  const idMap = new Map<string, string>();
  // Sequences are spaced by 10 so the fixture server can interleave scenario_applied events
  // deterministically (identical in every tab) without renumbering the script.
  order2.forEach(({ i }, seq) => idMap.set(`__ev${i}`, `evt:${input.runId}:${(seq + 1) * 10}`));
  scene.events = order2.map(({ e }, seq) => ({ ...e, eventId: `evt:${input.runId}:${(seq + 1) * 10}`, runId: input.runId, sequence: (seq + 1) * 10 }));
  for (const d of scene.decisions.values()) d.causedEventIds = d.causedEventIds.map((id) => idMap.get(id) ?? id);
  for (const g of population.groups) { scene.eventsByGroup.set(g.groupId, []); scene.partiesByGroup.set(g.groupId, []); }
  for (const e of scene.events) if (e.groupId) scene.eventsByGroup.get(e.groupId)?.push(e);
  for (const p of scene.partyById.values()) scene.partiesByGroup.get(p.groupId)?.push(p);
  return scene;
}

function addRating(scene: Scene, agentId: Id, atMs: number, endpoint: RatingRec['endpoint'], u: (...k: (string | number)[]) => number) {
  const exp = experienceAt(scene, agentId, atMs);
  const missing = u(agentId, 'rating-missing', atMs) < 0.06;
  const index = missing ? null : Math.max(0, Math.min(4, Math.round(2 + exp / 20)));
  scene.ratings.get(agentId)!.push({ agentId, atMs, availableAtMs: atMs + 30_000, index, endpoint });
}

function normalize(raw: { optionId: Id; probability: number }[]) {
  const sum = raw.reduce((a, r) => a + r.probability, 0);
  return raw.map((r) => ({ optionId: r.optionId, probability: r.probability / sum }));
}
const fmt = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

function needsFor(p: Persona, g: GroupManifest, t: number, meals: number[], rests: number[], rides: number[], queueMs: number): Needs {
  const hours = Math.max(0, (t - g.arrivalMs) / 3600_000);
  const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
  const before = (xs: number[]) => xs.filter((x) => x <= t).length;
  return {
    hunger: clamp(p.initialNeeds.hunger + p.hungerPerHour * hours - 40 * before(meals)),
    fatigue: clamp(p.initialNeeds.fatigue + 9 * hours - 20 * before(rests)),
    patience: clamp(p.initialNeeds.patience - (queueMs / 60_000 / Math.max(1, g.memberIds.length)) * p.patiencePerMinute * 0.3 + 5 * before(rests)),
    fun: clamp(p.initialNeeds.fun + 8 * before(rides) - 3 * hours),
  };
}

// ---------------------------------------------------------------- queries at time t
export function experienceAt(scene: Scene, agentId: Id, t: number): number {
  let v = 0;
  for (const e of scene.experience.get(agentId) ?? []) if (e.atMs <= t) v += e.delta;
  return Math.round(v * 10) / 10;
}

function segAt(scene: Scene, groupId: Id, t: number): GroupSeg | null {
  const segs = scene.segs.get(groupId)!;
  let found: GroupSeg | null = null;
  for (const s of segs) if (s.t0 <= t && t < s.t1) found = s; // later segments win at boundaries
  return found;
}

export function personsAhead(scene: Scene, party: Party, placeId: Id, t: number): number {
  let n = 0;
  for (const p of scene.parties.get(placeId)!) {
    if (p === party || p.lane !== party.lane) continue;
    if (p.joinT < party.joinT && p.leaveT > t && p.joinT <= t) n += p.agentIds.length;
  }
  return n;
}

export function queueSlotPosition(scene: Scene, placeId: Id, lane: 'standard' | 'pass', slot: number): Vec2 {
  const zone = scene.park.queueZones.find((z) => z.placeId === placeId);
  const place = scene.geo.places.get(placeId)!;
  if (!zone || slot >= zone.cellIndices.length) return scene.geo.spot(place.entrance, Math.min(12, zone ? slot - zone.cellIndices.length : slot));
  const idx = zone.cellIndices[slot]!;
  const w = scene.park.grid.width;
  const shift = lane === 'pass' ? 0.25 : -0.15;
  return { xM: (idx % w) + 0.5 + shift, yM: Math.floor(idx / w) + 0.5 + shift };
}

export type Pose = { position: Vec2; state: AgentState; target: Id | null; present: boolean };

export function poseAt(scene: Scene, agentId: Id, t: number): Pose {
  const persona = scene.personas.get(agentId)!;
  const k = scene.memberIndex.get(agentId)!;
  const seg = segAt(scene, persona.groupId, t);
  const gate = scene.geo.places.get('main_gate')!.entrance;
  if (!seg || seg.kind === 'gone') return { position: gate, state: 'left', target: null, present: false };
  if (seg.kind === 'walk') {
    const lag = k * 0.9;
    const offset = ((k % 3) - 1) * 1.1 + (k > 2 ? 0.4 : 0);
    const s = seg.s0 + ((t - seg.t0) / 1000) * seg.speed - lag;
    return { position: pointAt(seg.route, s, offset), state: seg.state, target: seg.target, present: true };
  }
  if (seg.kind === 'hold') {
    const position = seg.walkable ? scene.geo.spot(seg.at, k) : { xM: seg.at.xM + ((k % 3) - 1) * 0.8, yM: seg.at.yM + (Math.floor(k / 3) - 0.5) * 0.8 };
    return { position, state: seg.state, target: seg.target, present: true };
  }
  const party = scene.partyById.get(seg.partyId)!;
  const ahead = personsAhead(scene, party, seg.placeId, t);
  return { position: queueSlotPosition(scene, seg.placeId, party.lane, ahead + k), state: 'queueing', target: seg.target, present: true };
}

export function agentViewAt(scene: Scene, agentId: Id, t: number): AgentView | null {
  const pose = poseAt(scene, agentId, t);
  if (!pose.present) return null;
  const prev = t >= 1000 ? poseAt(scene, agentId, t - 1000) : pose;
  const continuous = prev.present && prev.state === pose.state;
  const persona = scene.personas.get(agentId)!;
  const g = scene.groups.get(persona.groupId)!;
  const ratings = (scene.ratings.get(agentId) ?? []).filter((r) => r.availableAtMs <= t && r.index !== null);
  const last = ratings[ratings.length - 1];
  const decisions = scene.decisionsByGroup.get(persona.groupId)!.filter((d) => d.atMs <= t);
  return {
    agentId, groupId: persona.groupId, position: round2(pose.position),
    velocity: continuous ? { xMps: round2v(pose.position.xM - prev.position.xM), yMps: round2v(pose.position.yM - prev.position.yM) } : { xMps: 0, yMps: 0 },
    state: pose.state, targetPlaceId: pose.target,
    needs: needsAtScene(scene, persona, g, t),
    experienceValue: experienceAt(scene, agentId, t),
    rating: last ? { value: (100 * last.index!) / 4, atMs: last.atMs, source: 'mock' } : null,
    latestEvidenceId: decisions.length ? decisions[decisions.length - 1]!.evidenceId : null,
  };
}

const round2 = (p: Vec2): Vec2 => ({ xM: Math.round(p.xM * 100) / 100, yM: Math.round(p.yM * 100) / 100 });
const round2v = (v: number) => Math.round(v * 100) / 100;

function needsAtScene(scene: Scene, p: Persona, g: GroupManifest, t: number): Needs {
  const evs = (scene.eventsByGroup.get(g.groupId) ?? []).filter((e) => e.atMs <= t);
  const meals = evs.filter((e) => e.kind === 'service_completed' && scene.geo.places.get(e.placeId ?? '')?.kind === 'food').map((e) => e.atMs);
  const rides = evs.filter((e) => e.kind === 'service_completed' && scene.geo.places.get(e.placeId ?? '')?.kind === 'ride').map((e) => e.atMs);
  const rests: number[] = [];
  let queueMs = 0;
  for (const pa of scene.partiesByGroup.get(g.groupId) ?? []) {
    if (pa.joinT <= t) queueMs += (Math.min(t, pa.leaveT) - pa.joinT) * pa.agentIds.length;
  }
  return needsFor(p, g, t, meals, rests, rides, queueMs);
}

export function queueViewsAt(scene: Scene, t: number): QueueView[] {
  const out: QueueView[] = [];
  for (const place of scene.park.places) {
    if (!place.queueZoneId) continue;
    const parties = scene.parties.get(place.id)!.filter((p) => p.joinT <= t && p.leaveT > t).sort((a, b) => a.joinT - b.joinT);
    let seq = 0;
    const entries = parties.map((p) => {
      const ahead = personsAhead(scene, p, place.id, t);
      return {
        entryId: p.partyId, agentIds: [...p.agentIds], lane: p.lane, sequence: ++seq, joinedAtMs: p.joinT,
        positions: p.agentIds.map((agentId, i) => ({ agentId, position: round2(queueSlotPosition(scene, place.id, p.lane, ahead + i)) })),
      };
    });
    out.push({
      placeId: place.id,
      standardPersons: parties.filter((p) => p.lane === 'standard').reduce((a, p) => a + p.agentIds.length, 0),
      passPersons: parties.filter((p) => p.lane === 'pass').reduce((a, p) => a + p.agentIds.length, 0),
      entries,
    });
  }
  return out;
}

/** Fixture estimate shown as operator truth: time until the tail party would board. */
export function predictedWaitAt(scene: Scene, placeId: Id, t: number): number | null {
  const place = scene.geo.places.get(placeId);
  if (!place || place.service.kind !== 'ride') return null;
  const active = scene.parties.get(placeId)!.filter((p) => p.joinT <= t && p.leaveT > t && p.boarded);
  if (!active.length) return 0;
  return Math.max(...active.map((p) => p.leaveT)) - t;
}

const metric = (id: MetricId, unit: MetricValue['unit'], numerator: number, denominator: number | null, n: number,
  coverage: number, complete: boolean, valueOverride?: number | null, missingReason: string | null = null): MetricValue => {
  const value = valueOverride !== undefined ? valueOverride : denominator === null ? numerator : denominator === 0 ? null : numerator / denominator;
  return { id, value, unit, numerator, denominator, n, coverage, complete, missingReason: value === null ? (missingReason ?? 'denominator is zero') : missingReason };
};

export function metricsAt(scene: Scene, runId: Id, t: number, revision: number): MetricSnapshot {
  const admitted = scene.arrivals.filter((a) => a.t <= t).reduce((s, a) => s + a.n, 0);
  const departed = scene.departures.filter((d) => d.t <= t);
  const departedN = departed.reduce((s, d) => s + d.n, 0);
  const revenue = scene.events.filter((e) => e.atMs <= t && e.kind === 'purchase').reduce((s, e) => s + (e.amountCents ?? 0), 0)
    - scene.events.filter((e) => e.atMs <= t && e.kind === 'refund').reduce((s, e) => s + (e.amountCents ?? 0), 0);
  let queuedPersonMs = 0; let joined = 0; let abandoned = 0;
  for (const parties of scene.parties.values()) for (const p of parties) {
    if (p.joinT > t) continue;
    queuedPersonMs += (Math.min(t, p.leaveT) - p.joinT) * p.agentIds.length;
    joined += p.agentIds.length;
    if (p.abandoned && p.leaveT <= t) abandoned += p.agentIds.length;
  }
  const boarded = scene.boardings.filter((b) => b.t <= t);
  const riders = boarded.reduce((s, b) => s + b.riders, 0);
  const completedRides = scene.events.filter((e) => e.atMs <= t && e.kind === 'service_completed' && scene.geo.places.get(e.placeId ?? '')?.kind === 'ride')
    .reduce((s, e) => s + e.agentIds.length, 0);
  const waitPersonMin = boarded.reduce((s, b) => s + (b.waitMs / 60_000) * b.riders, 0);
  let inParkPersonMs = 0;
  for (const a of scene.arrivals) {
    if (a.t > t) continue;
    const d = scene.departures.find((x) => x.groupId === a.groupId);
    inParkPersonMs += (Math.min(t, d && d.t <= t ? d.t : t) - a.t) * a.n;
  }
  const early = departed.filter((d) => d.early).reduce((s, d) => s + d.n, 0);
  let seatsDispatched = 0;
  for (const [placeId, times] of scene.rideDispatches) {
    const svc = scene.geo.places.get(placeId)!.service;
    if (svc.kind === 'ride') seatsDispatched += times.filter((x) => x <= t).length * svc.seats;
  }
  let busy = 0; let available = 0;
  for (const [placeId, ints] of scene.serverBusy) {
    const svc = scene.geo.places.get(placeId)!.service;
    if (svc.kind === 'counter') available += svc.servers * t;
    for (const i of ints) if (i.start < t) busy += Math.min(t, i.end) - i.start;
  }
  let ratingSum = 0; let rated = 0;
  for (const d of departed) {
    for (const id of scene.groups.get(d.groupId)!.memberIds) {
      const r = scene.ratings.get(id)!.find((x) => x.endpoint === 'departure' && x.availableAtMs <= t);
      if (r && r.index !== null) { ratingSum += (100 * r.index) / 4; rated++; }
    }
  }
  const complete = t >= scene.horizonMs;
  const sat = metric('satisfaction_0_100', 'score', ratingSum, rated, rated, admitted ? rated / admitted : 0, complete,
    rated ? ratingSum / rated : null, rated ? null : 'no terminal (departure/horizon) ratings yet');
  return {
    runId, simMs: t, revision, definitionVersion: 'metrics-v1',
    admittedGuests: admitted, guestsInPark: admitted - departedN,
    measures: {
      net_revenue_cents: metric('net_revenue_cents', 'cents', revenue, null, admitted, 1, complete),
      revenue_per_guest_cents: metric('revenue_per_guest_cents', 'cents', revenue, admitted, admitted, 1, complete),
      satisfaction_0_100: sat,
      queue_minutes_per_guest: metric('queue_minutes_per_guest', 'minutes', queuedPersonMs / 60_000, admitted, admitted, 1, complete),
      completed_ride_wait_minutes: metric('completed_ride_wait_minutes', 'minutes', waitPersonMin, riders, riders, 1, complete),
      rides_per_guest: metric('rides_per_guest', 'ratio', completedRides, admitted, admitted, 1, complete),
      abandonment_rate: metric('abandonment_rate', 'ratio', abandoned, joined, joined, 1, complete),
      queue_time_share: metric('queue_time_share', 'ratio', queuedPersonMs / 60_000, inParkPersonMs / 60_000, admitted, 1, complete),
      early_departures: metric('early_departures', 'guests', early, null, departedN, 1, complete),
      ride_seat_utilization: metric('ride_seat_utilization', 'ratio', riders, seatsDispatched, seatsDispatched, 1, complete),
      server_utilization: metric('server_utilization', 'ratio', busy / 60_000, available / 60_000, scene.serverBusy.size, 1, complete),
    },
  };
}

// ---------------------------------------------------------------- evidence
export function buildDecisionRequest(scene: Scene, d: DecisionCore, runId: Id): DecisionRequest {
  const g = scene.groups.get(d.groupId)!;
  const facts = scene.facts.get(d.groupId)!.filter((f) => d.factIds.includes(f.id));
  const known: KnownDestination[] = d.options.flatMap((o) => {
    const placeId = 'placeId' in o.action ? (o.action as { placeId: Id }).placeId : null;
    if (!placeId) return [];
    const place = scene.geo.places.get(placeId)!;
    return [{ placeId, name: place.name, walkEstimateMs: Math.round(scene.geo.route('main_gate', placeId).len / 1.1) * 1000,
      lastObservedFactIds: facts.filter((f) => f.placeId === placeId).map((f) => f.id),
      knownRestrictions: place.minHeightCm ? [`Minimum height ${place.minHeightCm} cm`] : [] }];
  });
  const recent = (scene.eventsByGroup.get(d.groupId) ?? []).filter((e) => e.atMs < d.atMs).slice(-3)
    .map((e) => ({ eventId: e.eventId, atMs: e.atMs, text: summarizeEvent(scene, e) }));
  const observation = {
    schema: 'observation.v1' as const, groupId: d.groupId, leaderId: g.leaderId, atMs: d.atMs,
    members: g.memberIds.map((id) => ({ persona: scene.personas.get(id)!, needs: needsAtScene(scene, scene.personas.get(id)!, g, d.atMs) })),
    wallet: { walletId: g.walletId, balanceCents: d.balanceCents }, facts, knownDestinations: known,
    recentEventSummaries: recent, currentActivity: d.activity, plannedDepartureMs: g.plannedDepartureMs,
  };
  const order = [...d.options.map((o) => o.id)];
  const rot = d.decisionSeq % order.length;
  const promptOptionOrder = [...order.slice(rot), ...order.slice(0, rot)];
  return {
    contractVersion: CONTRACT_VERSION, requestId: `decision:${d.groupId}:${d.decisionSeq}:r0`, runId, groupId: d.groupId,
    agentIds: d.agentIds, moment: d.moment, decisionSeq: d.decisionSeq, momentSeq: d.momentSeq, requestRevision: 0,
    createdAtMs: d.atMs, applyAtMs: d.atMs, planRevision: d.decisionSeq, dependencyRevisions: { [`plan:${d.groupId}`]: String(d.decisionSeq) },
    observationHash: sha256Sync(canonicalJson(observation)),
    optionsHash: sha256Sync(canonicalJson({ options: d.options, promptOptionOrder })),
    policyVersion: 'fixture-mock-policy-v1', observation, options: d.options, promptOptionOrder,
    candidateAudit: { considered: known.map((k) => k.placeId), excluded: d.excluded },
  };
}

export function buildAppliedDecision(scene: Scene, evidenceId: Id, runId: Id): AppliedDecision | null {
  const d = scene.decisions.get(evidenceId);
  if (!d) return null;
  const request = buildDecisionRequest(scene, d, runId);
  const rawBody = canonicalJson({ fixture: true, note: 'Scripted fixture mock policy output, NOT a Jev response.', probabilities: d.raw });
  return {
    evidenceId, request,
    response: {
      requestId: request.requestId, observationHash: request.observationHash, optionsHash: request.optionsHash,
      modelRequested: 'fixture-mock-policy-v1', modelReturned: 'fixture-mock-policy-v1', source: 'mock', probabilities: d.raw,
      confidence: null,
      responseArtifact: { artifactId: `fixture-response:${evidenceId}`, kind: 'model_response', sha256: sha256Sync(rawBody), byteLength: new TextEncoder().encode(rawBody).length, mediaType: 'application/json', contractVersion: CONTRACT_VERSION },
      usage: { callId: null, inputTokens: null, outputTokens: null, estimatedCostUsd: null, priceVersion: null, queueMs: 0, httpMs: 0, attemptCount: 0 },
      cacheKey: null, originalSource: 'mock',
    },
    appliedProbabilities: normalize(d.raw), draw: d.draw, chosenOptionId: d.chosen, outcome: d.outcome,
    failureReason: d.failureReason, committedAtMs: d.atMs, causedEventIds: d.causedEventIds,
  };
}

export function summarizeEvent(scene: Scene, e: EventRecord): string {
  const place = e.placeId ? scene.geo.places.get(e.placeId)?.name ?? e.placeId : '';
  const map: Partial<Record<EventKind, string>> = {
    arrived: 'Arrived at the main gate.', observed: `Noticed ${place}.`, queue_joined: `Joined the line at ${place}.`,
    queue_left: `Left the line at ${place}.`, service_started: `Started at ${place}.`, service_completed: `Finished at ${place}.`,
    purchase: `Bought something at ${place}.`, departed: 'Left the park.', action_failed: `Could not complete an action at ${place}.`,
  };
  return map[e.kind] ?? `${e.kind} ${place}`.trim();
}
