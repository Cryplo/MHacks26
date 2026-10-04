/**
 * FIXTURE copy of Engine's deterministic decision rationale (engine/src/sim/rationale.ts) and
 * guest status line (engine/src/sim/status.ts), so fixture mode exposes the same additive
 * AgentDetail fields (`evidence.rationale`, `decisions`, `statusText`) the live Engine does.
 * Built only from the frozen observation, the offered options and the applied distribution.
 */
import type { Action, ActionOption, AgentView, DecisionRationale, DecisionRequest, Distribution, Moment, ObservationFact } from '../../contract/behavior-v1';

const MOMENT_TEXT: Record<Moment, string> = {
  what_next: 'Deciding what to do next', join_line: 'Arrived at the entrance', stay_line: 'Reconsidering the line',
  hungry_tired: 'Needs are getting urgent', closing_soon: 'Time to wrap up the visit', noticed: 'Noticed something nearby',
  forced_replan: 'Plan fell through', route_choice: 'Choosing a route', message_seen: 'Read an app message',
  bumped: 'Bumped into someone', separated: 'Group got separated',
};
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
function duration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
const placeOf = (a: Action): string | null => ('placeId' in a ? a.placeId : null);

function shortLabel(o: ActionOption, names: Map<string, string>): string {
  const place = placeOf(o.action);
  const name = place ? names.get(place) : undefined;
  switch (o.action.kind) {
    case 'travel': return name ? `walk to ${name}` : o.label;
    case 'join_queue': return `${o.action.lane === 'pass' ? 'pass' : 'standard'} line${name ? ` at ${name}` : ''}`;
    case 'buy_pass_and_join': return `buy pass (${dollars(o.action.quote.totalCents)})${name ? ` for ${name}` : ''}`;
    case 'order': {
      const total = o.action.cart.reduce((n, q) => n + q.totalCents, 0);
      return `${o.label.replace(/^Order /, 'order ')}${total ? ` (${dollars(total)})` : ''}`;
    }
    case 'leave_park': return 'head for the exit';
    default: return o.label.charAt(0).toLowerCase() + o.label.slice(1);
  }
}
function latestWait(facts: ObservationFact[], placeId: string): ObservationFact | null {
  let best: ObservationFact | null = null;
  for (const f of facts) if (f.placeId === placeId && f.waitUpperMs !== null && (!best || f.observedAtMs >= best.observedAtMs)) best = f;
  return best;
}
function waitText(f: ObservationFact): string {
  const lo = f.waitLowerMs === null ? null : Math.round(f.waitLowerMs / 60000), hi = Math.round(f.waitUpperMs! / 60000);
  return lo !== null && lo !== hi ? `${lo}-${hi} min` : `${hi} min`;
}

export function fixtureRationale(r: DecisionRequest, probabilities: Distribution, chosenOptionId: string,
  outcome: 'committed' | 'failed_precondition', failureReason: string | null): DecisionRationale {
  const o = r.observation;
  const names = new Map(o.knownDestinations.map((d) => [d.placeId, d.name]));
  const p = new Map(probabilities.map((x) => [x.optionId, x.probability]));
  const options = new Map(r.options.map((x) => [x.id, x]));
  const n = o.members.length || 1;
  const avg = (k: 'hunger' | 'fatigue' | 'patience' | 'fun') => Math.round(o.members.reduce((s, m) => s + m.needs[k], 0) / n);
  const hunger = avg('hunger'), fatigue = avg('fatigue'), patience = avg('patience'), fun = avg('fun');
  const drivers: string[] = [MOMENT_TEXT[r.moment]];
  const target = r.options.map((x) => placeOf(x.action)).find((x) => x !== null && ['join_line', 'noticed', 'stay_line'].includes(r.moment));
  if (target && names.has(target)) drivers[0] += ` (${names.get(target)})`;
  const feelings: string[] = [];
  if (hunger >= 60) feelings.push(`hungry (${hunger}/100)`);
  if (fatigue >= 60) feelings.push(`tired (${fatigue}/100)`);
  if (patience <= 35) feelings.push(`losing patience (${patience}/100)`);
  if (fun <= 30) feelings.push(`bored (fun ${fun}/100)`);
  if (!feelings.length) feelings.push(`feeling fine (hunger ${hunger}, fatigue ${fatigue}, fun ${fun})`);
  drivers.push(feelings.join(', ').replace(/^./, (c) => c.toUpperCase()));
  drivers.push(`${dollars(o.wallet.balanceCents)} left in the wallet`);
  const left = o.plannedDepartureMs - o.atMs;
  drivers.push(left > 0 ? `${duration(left)} until planned departure` : 'past planned departure time');
  const ranked = [...r.options].map((x) => ({ option: x, probability: p.get(x.id) ?? 0 }))
    .sort((a, b) => b.probability - a.probability || (a.option.id < b.option.id ? -1 : 1));
  const chosen = options.get(chosenOptionId)!;
  const seen = new Set<string>();
  for (const x of [chosen, ...ranked.slice(0, 3).map((y) => y.option)]) {
    const place = placeOf(x.action);
    if (!place || seen.has(place)) continue;
    seen.add(place);
    const f = latestWait(o.facts, place);
    if (f) drivers.push(`${names.get(place) ?? place} board showed ${waitText(f)}`);
  }
  const alternatives = ranked.filter((x) => x.option.id !== chosenOptionId).slice(0, 3)
    .map((x) => ({ optionId: x.option.id, label: x.option.label, probability: Math.round(x.probability * 1000) / 1000 }));
  const pc = p.get(chosenOptionId) ?? 0;
  const top = alternatives[0];
  let summary = `${drivers[0]}. ${[drivers[1], drivers[2], ...drivers.slice(4, 5)].join('; ')} -> chose ${shortLabel(chosen, names)} (p=${pc.toFixed(2)})`;
  if (top) {
    const topLabel = shortLabel(options.get(top.optionId)!, names);
    summary += top.probability > pc ? `, a less likely draw than ${topLabel} (p=${top.probability.toFixed(2)})` : ` over ${topLabel} (p=${top.probability.toFixed(2)})`;
  }
  if (outcome === 'failed_precondition') summary += `; it could not be carried out (${failureReason ?? 'precondition failed'})`;
  return {
    summary, drivers,
    chosen: { optionId: chosenOptionId, label: chosen.label, probability: Math.round(pc * 1000) / 1000 },
    alternatives, modelReasoning: null,
  };
}

/** Plain-language status for a fixture guest pose (mirrors Engine's statusText wording). */
export function fixtureStatusText(agent: AgentView | null, placeName: (id: string | null) => string | null,
  info: { arrivesInMs: number | null; queueMinutes: number | null; postedWaitMinutes: number | null }): string {
  if (!agent || agent.state === 'not_arrived') {
    const inMin = info.arrivesInMs === null ? 0 : Math.max(0, Math.round(info.arrivesInMs / 60000));
    return inMin > 0 ? `Not in the park yet (arrives in ${inMin} min)` : 'Arriving at the gate';
  }
  const target = placeName(agent.targetPlaceId);
  switch (agent.state) {
    case 'left': return 'Left the park';
    case 'walking': return target ? `Walking to ${target}` : 'Walking';
    case 'browsing': return 'Browsing nearby';
    case 'queueing': return `In the line for ${target ?? 'an attraction'}${info.queueMinutes !== null ? ` (${info.queueMinutes} min so far${info.postedWaitMinutes !== null ? `, ~${info.postedWaitMinutes} min posted` : ''})` : ''}`;
    case 'riding': return `Riding ${target ?? 'a ride'}`;
    case 'watching': return `Watching ${target ?? 'a show'}`;
    case 'eating': return target ? `Eating at ${target}` : 'Eating';
    case 'shopping': return target ? `Shopping at ${target}` : 'Shopping';
    case 'resting': return target ? `Resting at ${target}` : 'Resting';
    case 'deciding': return target ? `At ${target}, deciding` : 'Deciding what to do next';
  }
}
