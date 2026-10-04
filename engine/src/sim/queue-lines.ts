/**
 * Queue line geometry and kinematics (deterministic, O(queued guests) per substep).
 *
 * Each place's line is a polyline: the centers of its queue zone cells in the authored
 * serpentine order (`QueueZone.cellIndices`, head at index 0 next to the zone exit / loading
 * point, tail at the zone entry), continued past the entry by an overflow line along the
 * ordinary walkway. Queued guests stand single-file at fixed spacing by FIFO rank within their
 * lane (groups stay adjacent); the pass lane stands beside the standard lane in the same cells.
 * Each queued guest tracks an arc-length position `queueU` and walks along the line toward
 * their slot, so the whole line shuffles forward smoothly when the head boards. Guests being
 * served walk from the head to the place's station (inside the structure next to the zone
 * exit). When service ends or a guest leaves the line they step back out at the entrance.
 */
import type * as C from "../../contract/behavior-v1.js";
import type { CoreState, PersonState, QueueEntry } from "../domain/state.js";
import { Navigation, UNREACHABLE } from "../navigation/grid.js";

/** Distance between consecutive guests standing in line (m). */
export const QUEUE_SPACING_M = 0.7;
/** Lateral offsets from the line's centerline per lane (m, left-hand normal). */
export const LANE_OFFSET_M = { standard: -0.18, pass: 0.24 } as const;
const OVERFLOW_MAX_CELLS = 160;

export type QueueLine = {
  points: C.Vec2[];
  /** Cumulative arc length at each point. */
  at: number[];
  /** Arc length of the queue zone part (overflow continues beyond it). */
  zoneLength: number;
  /** Where the zone is entered from the walkway (arc length zoneLength). */
  entry: C.Vec2;
  /** Where guests being served stand (inside the structure beyond the head). */
  station: C.Vec2;
  entrance: C.Vec2;
};

const lines = new WeakMap<C.ParkBundle, Map<string, QueueLine>>();

function center(nav: Navigation, i: number): C.Vec2 {
  return nav.center(i);
}

function buildLine(
  park: C.ParkBundle,
  nav: Navigation,
  place: C.Place,
): QueueLine {
  const zone = park.queueZones.find((z) => z.id === place.queueZoneId) ?? null;
  const width = park.grid.width,
    points: C.Vec2[] = [];
  let station = place.entrance;
  if (zone && zone.cellIndices.length) {
    for (const i of zone.cellIndices) points.push(center(nav, i));
    // Station: one step past the head into the adjacent blocked structure cell, if any.
    const head = zone.cellIndices[0]!,
      hx = head % width,
      hy = Math.floor(head / width);
    for (const [dx, dy] of [
      [0, -1],
      [-1, 0],
      [1, 0],
      [0, 1],
    ] as const) {
      const x = hx + dx,
        y = hy + dy;
      if (x < 0 || y < 0 || x >= width || y >= park.grid.height) continue;
      if (nav.cells[y * width + x] === 0) {
        const c = center(nav, head);
        station = {
          xM: c.xM + dx * park.grid.cellM * 1.2,
          yM: c.yM + dy * park.grid.cellM * 1.2,
        };
        break;
      }
    }
  }
  const zonePoints = points.length;
  // Overflow: walk away from the entrance along walkway cells, preferring to keep direction.
  const start = nav.cell(place.entrance);
  if (nav.walkable(start)) {
    const field = nav.field(place.entrance),
      seen = new Set<number>([start]);
    let cur = start,
      dir = -1;
    const chain: number[] = [];
    for (let n = 0; n < OVERFLOW_MAX_CELLS; n++) {
      let best = -1,
        bestScore = Infinity;
      const cx = cur % width,
        cy = Math.floor(cur / width);
      [
        [0, -1],
        [-1, 0],
        [1, 0],
        [0, 1],
      ].forEach(([dx, dy], d) => {
        const x = cx + dx!,
          y = cy + dy!,
          j = y * width + x;
        if (x < 0 || y < 0 || x >= width || y >= park.grid.height) return;
        if (seen.has(j) || !nav.walkable(j) || field[j] === UNREACHABLE) return;
        if (field[j]! <= field[cur]!) return; // always move away from the entrance
        const score = (d === dir ? 0 : 1) * 10 + j * 1e-7;
        if (score < bestScore) {
          bestScore = score;
          best = j;
        }
      });
      if (best < 0) break;
      const bx = best % width,
        by = Math.floor(best / width);
      dir = [
        [0, -1],
        [-1, 0],
        [1, 0],
        [0, 1],
      ].findIndex(([dx, dy]) => cx + dx! === bx && cy + dy! === by);
      seen.add(best);
      chain.push(best);
      cur = best;
    }
    // The line continues out through the entrance cell and along the walkway.
    for (const i of [start, ...chain]) points.push(center(nav, i));
  }
  if (!points.length) points.push({ ...place.entrance });
  const at = [0];
  for (let i = 1; i < points.length; i++)
    at.push(
      at[i - 1]! +
        Math.hypot(
          points[i]!.xM - points[i - 1]!.xM,
          points[i]!.yM - points[i - 1]!.yM,
        ),
    );
  const zoneLength = zonePoints ? at[zonePoints - 1]! : 0;
  return {
    points,
    at,
    zoneLength,
    entry: zonePoints ? points[zonePoints - 1]! : place.entrance,
    station,
    entrance: place.entrance,
  };
}

export function queueLine(
  park: C.ParkBundle,
  nav: Navigation,
  placeId: string,
): QueueLine {
  let byPlace = lines.get(park);
  if (!byPlace) lines.set(park, (byPlace = new Map()));
  let line = byPlace.get(placeId);
  if (!line) {
    line = buildLine(
      park,
      nav,
      park.places.find((p) => p.id === placeId)!,
    );
    byPlace.set(placeId, line);
  }
  return line;
}

/** Point on the line at arc length u, shifted laterally by `offset` (m). */
export function pointOnLine(line: QueueLine, u: number, offset = 0): C.Vec2 {
  const { points, at } = line;
  const last = points.length - 1;
  if (last <= 0) return { xM: points[0]!.xM, yM: points[0]!.yM };
  const total = at[last]!;
  // Beyond the authored/overflow line, extend straight from the last segment.
  let i: number;
  if (u <= 0) i = 0;
  else if (u >= total) i = last - 1;
  else {
    let lo = 0,
      hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (at[mid]! <= u) lo = mid;
      else hi = mid;
    }
    i = lo;
  }
  const a = points[i]!,
    b = points[i + 1]!,
    len = at[i + 1]! - at[i]! || 1,
    t = (u - at[i]!) / len,
    dx = (b.xM - a.xM) / len,
    dy = (b.yM - a.yM) / len;
  return {
    xM: a.xM + (b.xM - a.xM) * t - dy * offset,
    yM: a.yM + (b.yM - a.yM) * t + dx * offset,
  };
}

/** Arc length of each queued guest's slot (FIFO per place and lane, groups adjacent). */
export function queueSlots(
  s: CoreState,
): Map<string, { entry: QueueEntry; u: number }> {
  const out = new Map<string, { entry: QueueEntry; u: number }>(),
    rank = new Map<string, number>();
  for (const q of [...s.queues].sort((a, b) => a.sequence - b.sequence)) {
    const k = `${q.placeId}\u0000${q.lane}`;
    let r = rank.get(k) ?? 0;
    for (const id of q.agentIds) {
      out.set(id, { entry: q, u: QUEUE_SPACING_M * (r + 0.5) });
      r++;
    }
    rank.set(k, r);
  }
  return out;
}

/**
 * Next position of a queued or boarding guest after dt seconds (and updates `queueU`).
 * Returns null when the guest is not line-bound (normal motion applies).
 */
export function lineStep(
  s: CoreState,
  nav: Navigation,
  p: PersonState,
  slots: Map<string, { entry: QueueEntry; u: number }>,
  speed: number,
  dt: number,
): C.Vec2 | null {
  const step = speed * dt;
  if (p.state === "queueing") {
    const slot = slots.get(p.agentId);
    if (!slot) return null;
    const line = queueLine(s.park, nav, slot.entry.placeId),
      offset = LANE_OFFSET_M[slot.entry.lane];
    if (p.queueU === undefined || p.queueU === null) {
      // Step from the entrance onto the line at the zone entry (group members fan out one
      // spacing apart behind it), then follow the line to the slot.
      const k = Math.max(0, slot.entry.agentIds.indexOf(p.agentId)),
        enterU = Math.min(slot.u, line.zoneLength + QUEUE_SPACING_M * k),
        target = pointOnLine(line, enterU, offset),
        d = Math.hypot(target.xM - p.position.xM, target.yM - p.position.yM);
      if (d > step) {
        return {
          xM: p.position.xM + ((target.xM - p.position.xM) / d) * step,
          yM: p.position.yM + ((target.yM - p.position.yM) / d) * step,
        };
      }
      p.queueU = enterU;
      return target;
    }
    const du = slot.u - p.queueU;
    p.queueU += Math.abs(du) <= step ? du : Math.sign(du) * step;
    return pointOnLine(line, p.queueU, offset);
  }
  if (p.state === "riding" || p.state === "watching") {
    const placeId = p.targetPlaceId;
    if (!placeId || !s.places[placeId]?.definition.queueZoneId) return null;
    const line = queueLine(s.park, nav, placeId);
    if (p.queueU !== undefined && p.queueU !== null && p.queueU > 0) {
      // Walk the rest of the line to the head first, then into the station.
      p.queueU = Math.max(0, p.queueU - step);
      return pointOnLine(line, p.queueU, 0);
    }
    const target = line.station,
      d = Math.hypot(target.xM - p.position.xM, target.yM - p.position.yM);
    if (d <= step) return { ...target };
    return {
      xM: p.position.xM + ((target.xM - p.position.xM) / d) * step,
      yM: p.position.yM + ((target.yM - p.position.yM) / d) * step,
    };
  }
  return null;
}

/** Puts guests leaving a line or a service back on the walkway at the place entrance. */
export function stepOut(s: CoreState, placeId: string, people: PersonState[]) {
  const e = s.places[placeId]!.definition.entrance,
    cell = s.park.grid.cellM;
  people.forEach((p, i) => {
    p.queueU = null;
    if (Math.hypot(p.position.xM - e.xM, p.position.yM - e.yM) < 1.25) return;
    // Spread within the entrance cell (stays walkable; separation does the rest).
    p.position = {
      xM: Math.floor(e.xM / cell) * cell + cell * (0.2 + 0.3 * (i % 3)),
      yM:
        Math.floor(e.yM / cell) * cell +
        cell * (0.25 + 0.5 * (Math.floor(i / 3) % 2)),
    };
    p.velocity = { xMps: 0, yMps: 0 };
  });
}
