import type * as C from "../../contract/behavior-v1.js";
import type { CoreState, GroupState, PersonState } from "../domain/state.js";
import { MOMENT_PRIORITY } from "../domain/state.js";
import { asciiCompare, clampMeter } from "../domain/primitives.js";
export const groups = (s: CoreState) =>
  Object.values(s.groups).sort((a, b) =>
    asciiCompare(a.manifest.groupId, b.manifest.groupId),
  );
export const members = (s: CoreState, g: GroupState): PersonState[] =>
  g.manifest.memberIds
    .map((id) => s.persons[id]!)
    .sort((a, b) => asciiCompare(a.agentId, b.agentId));
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
