/**
 * Deterministic, factual explanation of one applied decision ("thought process" for the
 * inspector). Built only from the frozen observation the behavior model saw, the offered
 * options and the applied distribution, so it never claims a motive the model did not see.
 */
import type * as C from "../../contract/behavior-v1.js";

const MOMENT_TEXT: Record<C.Moment, string> = {
  what_next: "Deciding what to do next",
  join_line: "Arrived at the entrance",
  stay_line: "Reconsidering the line",
  hungry_tired: "Needs are getting urgent",
  closing_soon: "Time to wrap up the visit",
  noticed: "Noticed something nearby",
  forced_replan: "Plan fell through",
  route_choice: "Choosing a route",
  message_seen: "Read an app message",
  bumped: "Bumped into someone",
  separated: "Group got separated",
};
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
function duration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60),
    m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function placeOf(action: C.Action): string | null {
  return "placeId" in action ? action.placeId : null;
}
/** Short label, e.g. "Walk to Harbor Grill" -> "Harbor Grill" when the place name is known. */
function shortLabel(o: C.ActionOption, names: Map<string, string>): string {
  const place = placeOf(o.action);
  const name = place ? names.get(place) : undefined;
  switch (o.action.kind) {
    case "travel":
      return name ? `walk to ${name}` : o.label;
    case "join_queue":
      return `${o.action.lane === "pass" ? "pass" : "standard"} line${name ? ` at ${name}` : ""}`;
    case "buy_pass_and_join":
      return `buy pass (${dollars(o.action.quote.totalCents)})${name ? ` for ${name}` : ""}`;
    case "order": {
      const total = o.action.cart.reduce((n, q) => n + q.totalCents, 0);
      return `${o.label.replace(/^Order /, "order ")}${total ? ` (${dollars(total)})` : ""}`;
    }
    case "leave_park":
      return "head for the exit";
    case "continue":
      return o.label.toLowerCase();
    default:
      return o.label.charAt(0).toLowerCase() + o.label.slice(1);
  }
}
function latestWait(
  o: C.GuestObservation,
  placeId: string,
): C.ObservationFact | null {
  let best: C.ObservationFact | null = null;
  for (const f of o.facts)
    if (
      f.placeId === placeId &&
      f.waitUpperMs !== null &&
      (!best || f.observedAtMs >= best.observedAtMs)
    )
      best = f;
  return best;
}
function waitText(f: C.ObservationFact): string {
  const lo = f.waitLowerMs === null ? null : Math.round(f.waitLowerMs / 60000),
    hi = Math.round(f.waitUpperMs! / 60000);
  return lo !== null && lo !== hi ? `${lo}-${hi} min` : `${hi} min`;
}
export function decisionRationale(
  r: C.DecisionRequest,
  probabilities: C.Distribution,
  chosenOptionId: string,
  response: C.DecisionResult,
  outcome: C.AppliedDecision["outcome"],
  failureReason: string | null,
): C.DecisionRationale {
  const o = r.observation,
    names = new Map(o.knownDestinations.map((d) => [d.placeId, d.name])),
    p = new Map(probabilities.map((x) => [x.optionId, x.probability])),
    options = new Map(r.options.map((x) => [x.id, x]));
  const n = o.members.length || 1,
    avg = (k: keyof C.Needs) =>
      Math.round(o.members.reduce((s, m) => s + m.needs[k], 0) / n);
  const hunger = avg("hunger"),
    fatigue = avg("fatigue"),
    patience = avg("patience"),
    fun = avg("fun");
  const drivers: string[] = [MOMENT_TEXT[r.moment]];
  const target = r.options
    .map((x) => placeOf(x.action))
    .find(
      (x) =>
        x !== null &&
        (r.moment === "join_line" ||
          r.moment === "noticed" ||
          r.moment === "stay_line"),
    );
  if (target && names.has(target) && r.moment !== "what_next")
    drivers[0] += ` (${names.get(target)})`;
  const feelings: string[] = [];
  if (hunger >= 60) feelings.push(`hungry (${hunger}/100)`);
  if (fatigue >= 60) feelings.push(`tired (${fatigue}/100)`);
  if (patience <= 35) feelings.push(`losing patience (${patience}/100)`);
  if (fun <= 30) feelings.push(`bored (fun ${fun}/100)`);
  if (!feelings.length)
    feelings.push(
      `feeling fine (hunger ${hunger}, fatigue ${fatigue}, fun ${fun})`,
    );
  drivers.push(feelings.join(", ").replace(/^./, (c) => c.toUpperCase()));
  drivers.push(`${dollars(o.wallet.balanceCents)} left in the wallet`);
  const left = o.plannedDepartureMs - o.atMs;
  drivers.push(
    left > 0
      ? `${duration(left)} until planned departure`
      : "past planned departure time",
  );
  const ranked = [...r.options]
    .map((x) => ({ option: x, probability: p.get(x.id) ?? 0 }))
    .sort(
      (a, b) =>
        b.probability - a.probability || (a.option.id < b.option.id ? -1 : 1),
    );
  const chosen = options.get(chosenOptionId)!;
  // Wait facts the group had seen for the chosen place and the strongest alternatives.
  const seen = new Set<string>();
  for (const x of [chosen, ...ranked.slice(0, 3).map((y) => y.option)]) {
    const place = placeOf(x.action);
    if (!place || seen.has(place)) continue;
    seen.add(place);
    const f = latestWait(o, place);
    if (f)
      drivers.push(`${names.get(place) ?? place} board showed ${waitText(f)}`);
  }
  const alternatives = ranked
    .filter((x) => x.option.id !== chosenOptionId)
    .slice(0, 3)
    .map((x) => ({
      optionId: x.option.id,
      label: x.option.label,
      probability: Math.round(x.probability * 1000) / 1000,
    }));
  const pc = p.get(chosenOptionId) ?? 0,
    top = alternatives[0],
    waits = drivers.slice(4);
  let summary = `${drivers[0]}. ${[drivers[1], drivers[2], ...waits.slice(0, 1)].join("; ")} -> chose ${shortLabel(chosen, names)} (p=${pc.toFixed(2)})`;
  if (top) {
    const topLabel = shortLabel(options.get(top.optionId)!, names);
    summary +=
      top.probability > pc
        ? `, a less likely draw than ${topLabel} (p=${top.probability.toFixed(2)})`
        : ` over ${topLabel} (p=${top.probability.toFixed(2)})`;
  }
  if (outcome === "failed_precondition")
    summary += `; it could not be carried out (${failureReason ?? "precondition failed"})`;
  const reasoning =
    typeof response.reasoning === "string" && response.reasoning.trim()
      ? response.reasoning.trim().slice(0, 600)
      : null;
  return {
    summary,
    drivers,
    chosen: {
      optionId: chosenOptionId,
      label: chosen.label,
      probability: Math.round((p.get(chosenOptionId) ?? 0) * 1000) / 1000,
    },
    alternatives,
    modelReasoning: reasoning,
  };
}
