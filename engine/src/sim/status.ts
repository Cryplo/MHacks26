/** Plain-language current status of one guest for the inspector (derived, not stored). */
import type { CoreState } from "../domain/state.js";
import { predictedWait } from "./observations.js";

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60000));

export function statusText(s: CoreState, agentId: string): string {
  const p = s.persons[agentId]!,
    g = s.groups[p.groupId]!,
    now = s.view.simMs,
    place = (id: string | null) =>
      id ? (s.places[id]?.definition.name ?? id) : null,
    target = place(p.targetPlaceId);
  switch (p.state) {
    case "not_arrived": {
      const inMin = minutes(g.manifest.arrivalMs - now);
      return inMin > 0
        ? `Not in the park yet (arrives in ${inMin} min)`
        : "Arriving at the gate";
    }
    case "left":
      return p.departedAtMs !== null
        ? `Left the park after ${minutes(p.departedAtMs - (p.admittedAtMs ?? 0))} min`
        : "Left the park";
    case "walking":
      return g.leaving
        ? "Walking to the exit"
        : target
          ? `Walking to ${target}`
          : "Walking";
    case "browsing":
      return "Browsing nearby";
    case "queueing": {
      const q = s.queues.find((x) => x.agentIds.includes(agentId));
      if (!q) return target ? `Queueing for ${target}` : "Queueing";
      const wait = predictedWait(s, q.placeId);
      return `In the ${q.lane === "pass" ? "pass" : "standard"} line for ${place(q.placeId)} (${minutes(now - q.joinedAtMs)} min so far${wait !== null ? `, ~${minutes(wait)} min posted` : ""})`;
    }
    case "riding":
      return `Riding ${target ?? "a ride"}`;
    case "watching":
      return `Watching ${target ?? "a show"}`;
    case "eating":
      return target ? `Eating at ${target}` : "Eating";
    case "shopping":
      return target ? `Shopping at ${target}` : "Shopping";
    case "resting":
      return target ? `Resting at ${target}` : "Resting";
    case "deciding":
      return g.requestId
        ? "Thinking about what to do next"
        : target
          ? `At ${target}, deciding`
          : "Deciding what to do next";
  }
}
