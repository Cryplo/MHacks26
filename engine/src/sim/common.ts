import type * as C from "../../contract/behavior-v1.js";
import type { CoreState, GroupState, PersonState } from "../domain/state.js";
import { MOMENT_PRIORITY } from "../domain/state.js";
import { asciiCompare, clampMeter } from "../domain/primitives.js";
import { stepOut } from "./queue-lines.js";
// The group and member sets never change after createCore, so their deterministic orders
// are computed once per loaded state object instead of re-sorted on every call.
const groupOrder = new WeakMap<object, GroupState[]>();
export const groups = (s: CoreState): GroupState[] => {
  let list = groupOrder.get(s.groups);
  if (!list) {
    list = Object.values(s.groups).sort((a, b) =>
      asciiCompare(a.manifest.groupId, b.manifest.groupId),
    );
    groupOrder.set(s.groups, list);
  }
  return list;
};
const personOrder = new WeakMap<object, PersonState[]>();
/** Every person in agent-id order (the person set never changes after createCore). */
export const personsInOrder = (s: CoreState): PersonState[] => {
  let list = personOrder.get(s.persons);
  if (!list) {
    list = Object.values(s.persons).sort((a, b) =>
      asciiCompare(a.agentId, b.agentId),
    );
    personOrder.set(s.persons, list);
  }
  return list;
};
const memberOrder = new WeakMap<object, string[]>();
export const members = (s: CoreState, g: GroupState): PersonState[] => {
  let ids = memberOrder.get(g.manifest);
  if (!ids) {
    ids = [...g.manifest.memberIds].sort(asciiCompare);
    memberOrder.set(g.manifest, ids);
  }
  return ids.map((id) => s.persons[id]!);
};
const personaIndex = new WeakMap<object, Map<string, C.Persona>>();
/** Persona traits by agent id (population is immutable). */
export function persona(s: CoreState, agentId: string): C.Persona {
  let index = personaIndex.get(s.population);
  if (!index) {
    index = new Map(s.population.personas.map((p) => [p.agentId, p]));
    personaIndex.set(s.population, index);
  }
  return index.get(agentId)!;
}
type EventIndex = { scanned: number; byGroup: Map<string, number[]> };
const eventIndex = new WeakMap<object, EventIndex>();
/** The last `limit` non-"observed" events of a group, oldest first (append-only index). */
export function recentGroupEvents(
  s: CoreState,
  groupId: string,
  limit: number,
): C.EventRecord[] {
  let index = eventIndex.get(s.events);
  if (!index || index.scanned > s.events.length) {
    index = { scanned: 0, byGroup: new Map() };
    eventIndex.set(s.events, index);
  }
  for (; index.scanned < s.events.length; index.scanned++) {
    const e = s.events[index.scanned]!;
    if (e.groupId === null || e.kind === "observed") continue;
    let list = index.byGroup.get(e.groupId);
    if (!list) index.byGroup.set(e.groupId, (list = []));
    list.push(index.scanned);
  }
  return (index.byGroup.get(groupId) ?? [])
    .slice(-limit)
    .map((i) => s.events[i]!);
}
export function setActivity(
  s: CoreState,
  g: GroupState,
  state: C.AgentView["state"],
) {
  for (const p of members(s, g)) {
    p.state = state;
    p.velocity = { xMps: 0, yMps: 0 };
  }
}
export function trigger(g: GroupState, moment: C.Moment) {
  if (
    !g.pendingMoment ||
    MOMENT_PRIORITY[moment] < MOMENT_PRIORITY[g.pendingMoment]
  )
    g.pendingMoment = moment;
}
export const RECENT_EVENTS_PER_GROUP = 40;
export function event(
  s: CoreState,
  kind: C.EventKind,
  g: GroupState | null,
  placeId: string | null,
  details: C.Json = null,
  extra: Partial<C.EventRecord> = {},
): C.EventRecord {
  const sequence = s.events.length + 1;
  const e: C.EventRecord = {
    eventId: `evt:${sequence}`,
    runId: s.runId,
    sequence,
    atMs: s.view.simMs,
    kind,
    groupId: g?.manifest.groupId ?? null,
    agentIds: g ? [...g.manifest.memberIds] : [],
    placeId,
    position: placeId
      ? { ...s.places[placeId]!.definition.entrance }
      : g
        ? { ...s.persons[g.manifest.leaderId]!.position }
        : null,
    causationId: null,
    amountCents: null,
    experienceDelta: null,
    reason: null,
    details,
    ...extra,
  };
  s.events.push(e);
  // Per-group index of recent events (lets the inspector read a guest's events by key).
  if (g) {
    const idx = (g.recentEventIdx ??= []);
    idx.push(sequence - 1);
    if (idx.length > RECENT_EVENTS_PER_GROUP)
      idx.splice(0, idx.length - RECENT_EVENTS_PER_GROUP);
  }
  return e;
}
export function experience(
  s: CoreState,
  g: GroupState,
  delta: number,
  reason: string,
  placeId: string | null,
) {
  const applied = members(s, g).map((p) => {
    const before = p.experienceValue;
    p.experienceValue = clampMeter(before + delta);
    return { id: p.agentId, delta: p.experienceValue - before };
  });
  event(
    s,
    "experience",
    g,
    placeId,
    { contributions: applied },
    { experienceDelta: applied.reduce((a, b) => a + b.delta, 0), reason },
  );
  for (const item of applied) {
    if (item.delta < 0) {
      const p = s.persons[item.id]!,
        grid = s.park.grid;
      s.heat.push({
        atMs: s.view.simMs,
        fromMs: s.view.simMs,
        toMs: s.view.simMs,
        cell:
          Math.floor(p.position.yM / grid.cellM) * grid.width +
          Math.floor(p.position.xM / grid.cellM),
        layer: "negative_experience",
        value: item.delta,
      });
    }
  }
}
export function releaseQueue(
  s: CoreState,
  entryId: string,
  cause: "abandonment" | "closure" | "upgrade",
) {
  const q = s.queues.find((q) => q.id === entryId);
  if (!q) return;
  s.queues = s.queues.filter((x) => x.id !== entryId);
  const g = s.groups[q.groupId]!;
  if (cause === "abandonment") s.totals.abandonedEpisodes += q.agentIds.length;
  if (cause !== "upgrade") {
    stepOut(s, q.placeId, members(s, g));
    setActivity(s, g, "deciding");
    trigger(g, cause === "closure" ? "forced_replan" : "what_next");
  }
  event(
    s,
    cause === "closure" ? "closure_release" : "queue_left",
    g,
    q.placeId,
    { entryId: q.id, waitPersonMs: q.waitMs, cause },
    { reason: cause },
  );
}

/**
 * Ids of decisions whose status is pending or ready, in creation order. Maintained as a
 * small open list so per-step work does not scan every decision the run ever made.
 */
export function openDecisions(s: CoreState): string[] {
  const open = (s.openDecisionIds ??= Object.keys(s.decisions));
  const live = open.filter((id) => {
    const d = s.decisions[id];
    return d && (d.status === "pending" || d.status === "ready");
  });
  if (live.length !== open.length) s.openDecisionIds = live;
  return live;
}
/** Ids of ratings still awaiting a result (open list, pruned lazily). */
export function openRatings(s: CoreState): string[] {
  const open = (s.openRatingIds ??= Object.keys(s.ratings));
  const live = open.filter((id) => s.ratings[id] && !s.ratings[id]!.result);
  if (live.length !== open.length) s.openRatingIds = live;
  return live;
}
/** Records a newly created decision slot in the open list (initializing legacy states). */
export function trackOpenDecision(s: CoreState, id: string) {
  (s.openDecisionIds ??= Object.keys(s.decisions).filter((k) => k !== id)).push(
    id,
  );
}
/** Records a newly created rating request in the open list (initializing legacy states). */
export function trackOpenRating(s: CoreState, id: string) {
  (s.openRatingIds ??= Object.keys(s.ratings).filter((k) => k !== id)).push(id);
}
