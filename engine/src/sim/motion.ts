import type { CoreState, PersonState } from "../domain/state.js";
import type { Vec2 } from "../../contract/behavior-v1.js";
import { asciiCompare, clampMeter, random } from "../domain/primitives.js";
import { Navigation } from "../navigation/grid.js";
import { groups, members, trigger } from "./common.js";
import { observe } from "./observations.js";
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
export function moveSubstep(
  s: CoreState,
  nav: Navigation,
): { neighborChecks: number } {
  const dt = 0.25,
    ordered = Object.values(s.persons)
      .filter((p) => p.state !== "not_arrived" && p.state !== "left")
      .sort((a, b) => asciiCompare(a.agentId, b.agentId));
  const bins = new Map<string, PersonState[]>(),
    size = 2;
  for (const p of ordered) {
    const key = `${Math.floor(p.position.xM / size)},${Math.floor(p.position.yM / size)}`;
    const list = bins.get(key) ?? [];
    list.push(p);
    bins.set(key, list);
  }
  const proposed = new Map<string, Vec2>();
  const tieDirections = new Map(
    ordered.map((p) => {
      const angle =
        random(s.manifest.replicateSeed, "movement", p.agentId, "separation") *
        2 *
        Math.PI;
      return [p.agentId, { x: Math.cos(angle), y: Math.sin(angle) }] as const;
    }),
  );
  let neighborChecks = 0;
  const traits = new Map(s.population.personas.map((p) => [p.agentId, p]));
  for (const p of ordered) {
    const g = s.groups[p.groupId]!,
      trait = traits.get(p.agentId)!;
    if (
      !["walking", "browsing"].includes(p.state) ||
      g.requestId ||
      !g.target
    ) {
      proposed.set(p.agentId, { ...p.position });
      continue;
    }
    const own = members(s, g),
      slowest = Math.min(
        ...own.map((x) => traits.get(x.agentId)!.walkSpeedMps),
      );
    const field = nav.field(g.target),
      myDistance = field[nav.cell(p.position)]!,
      lag =
        Math.max(...own.map((x) => field[nav.cell(x.position)]!)) - myDistance;
    const target = nav.next(p.position, g.target);
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
    const neighbors: PersonState[] = [];
    for (let y = -1; y <= 1; y++)
      for (let x = -1; x <= 1; x++)
        neighbors.push(
          ...(bins.get(
            `${Math.floor(p.position.xM / size) + x},${Math.floor(p.position.yM / size) + y}`,
          ) ?? []),
        );
    neighbors.sort((a, b) => asciiCompare(a.agentId, b.agentId));
    let near = 0;
    for (const other of neighbors) {
      if (p.agentId === other.agentId) continue;
      neighborChecks++;
      dx = p.position.xM - other.position.xM;
      dy = p.position.yM - other.position.yM;
      d = Math.hypot(dx, dy);
      if (d < 1.5) near++;
      if (d < 0.55) {
        if (d < 1e-9) {
          const mine = tieDirections.get(p.agentId)!,
            theirs = tieDirections.get(other.agentId)!;
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
    }
    const center = {
      xM: own.reduce((a, x) => a + x.position.xM, 0) / own.length,
      yM: own.reduce((a, x) => a + x.position.yM, 0) / own.length,
    };
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
  const waitingCells = new Map<number, number>();
  for (const p of ordered) {
    const old = p.position,
      next = proposed.get(p.agentId)!,
      trait = traits.get(p.agentId)!,
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
      const q = s.queues.find((q) => q.agentIds.includes(p.agentId));
      if (q) q.waitMs += 250;
      const cell = nav.cell(p.position);
      waitingCells.set(cell, (waitingCells.get(cell) ?? 0) + 1);
    }
    if (!["walking", "browsing"].includes(p.state)) continue;
    for (const place of Object.values(s.places).sort((a, b) =>
      asciiCompare(a.definition.id, b.definition.id),
    )) {
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
  // Coalesce identical exposure rates within a logical step, preserving exact
  // interval clipping for historical heat queries without a row per person.
  for (const [cell, count] of waitingCells) {
    let prior: (typeof s.heat)[number] | undefined;
    for (let i = s.heat.length - 1; i >= 0; i--) {
      const h = s.heat[i]!;
      if (h.fromMs < s.view.simMs) break;
      if (h.layer === "waiting_person_minutes" && h.cell === cell) {
        prior = h;
        break;
      }
    }
    const value = (count * 250) / 60000;
    if (
      prior &&
      prior.toMs === from &&
      Math.abs(prior.value / (prior.toMs - prior.fromMs) - count / 60000) <
        1e-12
    ) {
      prior.toMs += 250;
      prior.value += value;
    } else
      s.heat.push({
        atMs: from,
        fromMs: from,
        toMs: from + 250,
        cell,
        layer: "waiting_person_minutes",
        value,
      });
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
  return { neighborChecks };
}
