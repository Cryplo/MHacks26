import type { CoreState, GroupState, PersonState } from "../domain/state.js";
import type { Vec2 } from "../../contract/behavior-v1.js";
import { asciiCompare, clampMeter, random } from "../domain/primitives.js";
import { Navigation, type DistanceField } from "../navigation/grid.js";
import { groups, members, persona, personsInOrder, trigger } from "./common.js";
import { observe } from "./observations.js";
import { lineStep, queueSlots } from "./queue-lines.js";
const distance = (a: Vec2, b: Vec2) => Math.hypot(a.xM - b.xM, a.yM - b.yM);
export function segmentDistance(a: Vec2, b: Vec2, p: Vec2): number {
  const dx = b.xM - a.xM,
    dy = b.yM - a.yM,
    len = dx * dx + dy * dy,
    t = len
      ? Math.max(
          0,
          Math.min(1, ((p.xM - a.xM) * dx + (p.yM - a.yM) * dy) / len),
        )
      : 0;
  return Math.hypot(a.xM + t * dx - p.xM, a.yM + t * dy - p.yM);
}
const BIN = 2;
/** Waiting-heat accumulation window (sim ms). */
export const HEAT_WINDOW_MS = 300000;
const heatIndex = new WeakMap<
  object,
  { windowStart: number; cells: Map<number, number> }
>();
/** Index of this window's waiting-heat rows by cell (rebuilt after a reload). */
function openHeat(s: CoreState, windowStart: number): Map<number, number> {
  let idx = heatIndex.get(s.heat);
  if (!idx || idx.windowStart !== windowStart) {
    const cells = new Map<number, number>();
    for (let i = s.heat.length - 1; i >= 0; i--) {
      const h = s.heat[i]!;
      if (h.fromMs < windowStart) break;
      if (h.layer === "waiting_person_minutes" && !cells.has(h.cell))
        cells.set(h.cell, i);
    }
    idx = { windowStart, cells };
    heatIndex.set(s.heat, idx);
  }
  return idx.cells;
}
const binKey = (x: number, y: number) => x * 65536 + y;
function tieDirection(
  s: CoreState,
  cache: Map<string, { x: number; y: number }>,
  agentId: string,
) {
  let tie = cache.get(agentId);
  if (!tie) {
    const angle =
      random(s.manifest.replicateSeed, "movement", agentId, "separation") *
      2 *
      Math.PI;
    tie = { x: Math.cos(angle), y: Math.sin(angle) };
    cache.set(agentId, tie);
  }
  return tie;
}
export function moveSubstep(
  s: CoreState,
  nav: Navigation,
  maxAgents = Number.POSITIVE_INFINITY,
): { neighborChecks: number; complete: boolean } {
  const dt = 0.25,
    ordered = personsInOrder(s).filter(
      (p) => p.state !== "not_arrived" && p.state !== "left",
    );
  const bins = new Map<number, PersonState[]>(),
    size = BIN;
  for (const p of ordered) {
    const key = binKey(
      Math.floor(p.position.xM / size),
      Math.floor(p.position.yM / size),
    );
    const list = bins.get(key);
    if (list) list.push(p);
    else bins.set(key, [p]);
  }
  // Tie-break directions are a pure keyed function of (seed, agent); they are computed only
  // for the rare coincident pairs that need them (older persisted states may carry a table).
  if (!s.motionPending) s.motionPending = { cursor: 0, proposed: {}, ties: {} };
  const pending = s.motionPending,
    proposed = new Map(Object.entries(pending.proposed)),
    tieDirections = new Map(Object.entries(pending.ties));
  let neighborChecks = 0;
  const groupCache = new Map<
    string,
    {
      own: PersonState[];
      slowest: number;
      field: DistanceField;
      local: boolean;
      maxDistance: number;
      center: Vec2;
    }
  >();
  const groupInfo = (g: GroupState) => {
    let info = groupCache.get(g.manifest.groupId);
    if (!info) {
      // Browsing wanders to an adjacent cell, so it uses the bounded local field (exact
      // within LOCAL_FIELD_RADIUS) instead of a full-park Dijkstra per wander target.
      const own = members(s, g),
        local = own[0]!.state === "browsing",
        field = nav.distances(g.target!, local);
      info = {
        own,
        slowest: Math.min(
          ...own.map((x) => persona(s, x.agentId).walkSpeedMps),
        ),
        field,
        local,
        maxDistance: Math.max(
          ...own.map((x) => field.at(nav.cell(x.position))),
        ),
        center: {
          xM: own.reduce((a, x) => a + x.position.xM, 0) / own.length,
          yM: own.reduce((a, x) => a + x.position.yM, 0) / own.length,
        },
      };
      groupCache.set(g.manifest.groupId, info);
    }
    return info;
  };
  const neighbors: PersonState[] = [],
    close: PersonState[] = [];
  for (const p of ordered.slice(pending.cursor, pending.cursor + maxAgents)) {
    const g = s.groups[p.groupId]!,
      trait = persona(s, p.agentId);
    if (
      (p.state !== "walking" && p.state !== "browsing") ||
      g.requestId ||
      !g.target
    ) {
      proposed.set(p.agentId, { ...p.position });
      continue;
    }
    const { slowest, field, local, maxDistance, center } = groupInfo(g),
      myDistance = field.at(nav.cell(p.position)),
      lag = maxDistance - myDistance;
    const target = nav.next(p.position, g.target, local);
    if (!target) {
      proposed.set(p.agentId, { ...p.position });
      continue;
    }
    let dx = target.xM - p.position.xM,
      dy = target.yM - p.position.yM,
      d = Math.hypot(dx, dy);
    const speed =
      Math.min(trait.walkSpeedMps, slowest * 1.1) * (lag > 3 ? 0 : 1);
    let vx = d ? (dx / d) * speed : 0,
      vy = d ? (dy / d) * speed : 0;
    neighbors.length = 0;
    const bx = Math.floor(p.position.xM / size),
      by = Math.floor(p.position.yM / size);
    for (let y = -1; y <= 1; y++)
      for (let x = -1; x <= 1; x++) {
        const bin = bins.get(binKey(bx + x, by + y));
        if (bin) for (const other of bin) neighbors.push(other);
      }
    // Only neighbors closer than 0.55 m exert a separation force; they are applied in
    // agent-id order (the float summation order); `near` is an order-free count.
    let near = 0;
    close.length = 0;
    for (const other of neighbors) {
      if (p.agentId === other.agentId) continue;
      neighborChecks++;
      const ox = p.position.xM - other.position.xM,
        oy = p.position.yM - other.position.yM,
        od2 = ox * ox + oy * oy;
      if (od2 < 2.25) near++;
      if (od2 < 0.3025) close.push(other);
    }
    if (close.length > 1)
      close.sort((a, b) => asciiCompare(a.agentId, b.agentId));
    for (const other of close) {
      dx = p.position.xM - other.position.xM;
      dy = p.position.yM - other.position.yM;
      d = Math.hypot(dx, dy);
      if (d < 1e-9) {
        const mine = tieDirection(s, tieDirections, p.agentId),
          theirs = tieDirection(s, tieDirections, other.agentId);
        dx = mine.x - theirs.x;
        dy = mine.y - theirs.y;
        const norm = Math.hypot(dx, dy);
        if (norm < 1e-9) {
          dx = asciiCompare(p.agentId, other.agentId) < 0 ? 1 : -1;
          dy = 0;
        } else {
          dx /= norm;
          dy /= norm;
        }
        d = 1;
      }
      const force = Math.min(0.35, (0.55 - Math.min(0.55, d)) * 0.6 + 0.01);
      vx += (dx / d) * force;
      vy += (dy / d) * force;
    }
    if (distance(center, p.position) > 2) {
      vx += (center.xM - p.position.xM) * 0.08;
      vy += (center.yM - p.position.yM) * 0.08;
    }
    const length = Math.hypot(vx, vy),
      cap = trait.walkSpeedMps / (1 + Math.max(0, near - 5) * 0.015),
      factor = length ? Math.min(1, cap / length) : 1;
    let next = {
      xM: p.position.xM + vx * factor * dt,
      yM: p.position.yM + vy * factor * dt,
    };
    if (distance(p.position, g.target) < 0.35) next = { ...p.position };
    // A rejected preferred segment slides along a safe axis; never crosses a wall.
    if (!nav.clearSegment(p.position, next)) {
      const x = { xM: next.xM, yM: p.position.yM },
        y = { xM: p.position.xM, yM: next.yM };
      next = nav.clearSegment(p.position, x)
        ? x
        : nav.clearSegment(p.position, y)
          ? y
          : { ...p.position };
    }
    proposed.set(p.agentId, next);
  }
  pending.cursor = Math.min(ordered.length, pending.cursor + maxAgents);
  if (pending.cursor < ordered.length) {
    pending.proposed = Object.fromEntries(proposed);
    return { neighborChecks, complete: false };
  }
  delete s.motionPending;
  const waitingCells = new Map<number, number>();
  const queueOf = new Map<string, (typeof s.queues)[number]>();
  for (const q of s.queues)
    for (const id of q.agentIds) if (!queueOf.has(id)) queueOf.set(id, q);
  const noticePlaces = Object.values(s.places)
    .filter((place) => place.definition.notice)
    .sort((a, b) => asciiCompare(a.definition.id, b.definition.id));
  const slots = s.queues.length ? queueSlots(s) : new Map();
  for (const p of ordered) {
    const trait = persona(s, p.agentId),
      old = p.position,
      // Queued and boarding guests follow their line (kinematic, no crowd forces).
      next =
        lineStep(s, nav, p, slots, trait.walkSpeedMps, dt) ??
        proposed.get(p.agentId)!,
      g = s.groups[p.groupId]!;
    const moved = distance(old, next);
    p.distanceM += moved;
    p.position = next;
    p.velocity = {
      xMps: (next.xM - old.xM) / dt,
      yMps: (next.yM - old.yM) / dt,
    };
    p.needs.hunger = clampMeter(
      p.needs.hunger + (trait.hungerPerHour * dt) / 3600,
    );
    p.needs.fatigue = clampMeter(
      p.needs.fatigue + (trait.fatiguePerKm * moved) / 1000,
    );
    if (p.state === "resting")
      p.needs.fatigue = clampMeter(p.needs.fatigue - dt * 0.2);
    p.parkMs += 250;
    s.totals.parkPersonMs += 250;
    if (p.state === "queueing") {
      p.queueMs += 250;
      p.needs.patience = clampMeter(
        p.needs.patience - (trait.patiencePerMinute * dt) / 60,
      );
      s.totals.queuePersonMs += 250;
      const q = queueOf.get(p.agentId);
      if (q) q.waitMs += 250;
      const cell = nav.cell(p.position);
      waitingCells.set(cell, (waitingCells.get(cell) ?? 0) + 1);
    }
    if (p.state !== "walking" && p.state !== "browsing") continue;
    for (const place of noticePlaces) {
      const notice = place.definition.notice;
      if (
        !notice ||
        segmentDistance(old, next, place.definition.entrance) > notice.radiusM
      )
        continue;
      if (
        notice.channel === "visual" &&
        !nav.clearSegment(next, place.definition.entrance)
      )
        continue;
      const fresh = observe(s, p, {
        kind: "notice",
        placeId: place.definition.id,
        source: notice.channel === "aroma" ? "aroma" : "sight",
        observedAtMs: s.view.simMs + (s.movementSubstep + 1) * 250,
        contentVersion: place.noticeVersion,
        text: notice.text,
        waitLowerMs: null,
        waitUpperMs: null,
        priceCents: null,
      });
      if (fresh) {
        if (g.requestId || (g.pendingMoment && g.pendingMoment !== "noticed"))
          g.deferredNoticeId = place.definition.id;
        else {
          g.noticePlaceId = place.definition.id;
          trigger(g, "noticed");
        }
      }
    }
  }
  const from = s.view.simMs + s.movementSubstep * 250;
  // Waiting exposure is accumulated per cell over HEAT_WINDOW_MS windows (one ledger row per
  // occupied cell per window): queued guests now shuffle along their lines, so per-substep
  // rate runs would produce a row per cell per few seconds. Interval-clipped heat queries
  // treat exposure as uniform within a row's [fromMs, toMs].
  const windowStart = Math.floor(from / HEAT_WINDOW_MS) * HEAT_WINDOW_MS,
    open = openHeat(s, windowStart);
  for (const [cell, count] of waitingCells) {
    const value = (count * 250) / 60000,
      i = open.get(cell);
    if (i !== undefined) {
      const h = s.heat[i]!;
      h.toMs = from + 250;
      h.value += value;
    } else {
      open.set(cell, s.heat.length);
      s.heat.push({
        atMs: from,
        fromMs: from,
        toMs: from + 250,
        cell,
        layer: "waiting_person_minutes",
        value,
      });
    }
  }
  for (const g of groups(s)) {
    const people = members(s, g);
    if (
      !g.target ||
      !people.every((p) => ["walking", "browsing"].includes(p.state))
    )
      continue;
    if (people.every((p) => distance(p.position, g.target!) < 1)) {
      if (g.route.length) g.target = g.route.shift()!;
      else if (people[0]!.state === "browsing") {
        const leader = people.find((p) => p.agentId === g.manifest.leaderId)!,
          neighbors = nav.neighbors(nav.cell(leader.position));
        const key = s.view.stepIndex * 20 + s.movementSubstep,
          i = Math.floor(
            random(
              s.manifest.replicateSeed,
              "movement",
              g.manifest.groupId,
              key,
            ) * neighbors.length,
          );
        g.target = nav.center(neighbors[i]?.index ?? nav.cell(leader.position));
      } else {
        g.target = null;
        for (const p of people) {
          p.state = "deciding";
          p.velocity = { xMps: 0, yMps: 0 };
        }
        trigger(g, g.leaving ? "closing_soon" : "join_line");
      }
    }
  }
  for (const place of Object.values(s.places)) {
    const service = place.definition.service;
    if (service.kind === "counter") {
      const busy = s.sessions.filter(
        (x) => x.placeId === place.definition.id,
      ).length;
      // Closed counters finish occupied slots; those slots remain available
      // capacity until their in-flight service completes.
      s.totals.availableServerMs +=
        (!place.closed && !s.closing ? service.servers : busy) * 250;
      s.totals.busyServerMs += busy * 250;
    }
  }
  return { neighborChecks, complete: true };
}
